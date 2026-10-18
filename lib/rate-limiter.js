/**
 * 限流器核心（无依赖，可单测）—— provider 无关，stepfun/duanyan 共用。
 *
 * 四层闸门，按顺序施加（都不满足就等待，不抛错）：
 *   1. min-interval —— 两个请求之间的最小间隔（并发安全：用 nextSlotAt 排队，
 *      不像千帆旧实现那样并发下退化成"批处理"）
 *   2. TPM 令牌桶 —— 每分钟 token 数（成本 = 预估输入 + 输出上限）
 *   3. RPM 令牌桶 —— 每分钟请求数
 *   4. 并发信号量 —— 在飞请求数上限
 *
 * 设计取舍（对照 dsh-llm-qianfan 的 rate-limiter.ts）：
 *   - 去掉"响应头背压"层：实测这两个端点都不下发 x-ratelimit-*，也不下发
 *     Retry-After，那一层是空转（qianfan 那份实测同样是空转）。
 *   - 并发信号量：stepfun 超并发是**立即 429**
 *     （{"error":{"message":"concurrency reached, current: 6, limit: 5","type":"rate_limited"}}），
 *     而 DSH 把 RATE_LIMIT 当可重试错误，会退避重试 —— 必须客户端自己卡住。
 *     duanyan 则实测无独立并发限制（146 在途零拒绝），那边设 30 纯粹是给
 *     600s 网关时长上限留余量，防长输出把队列拖爆。
 *   - 桶初始满桶（允许一次突发），与千帆一致；实例重建即回满，见 README 注意。
 *
 * 安全性余量（safetyMargin）只作用于 TPM/RPM，不作用于并发：
 * 并发槽位在"响应流读完"之后才释放，服务端的槽位释放只会更早，因此没有竞态，
 * 按 provider 上限用满即可（对并发打折等于白扔 20% 吞吐）。
 */

/**
 * 字段默认值：schema 与构造器共用同一份，避免两处漂移。
 * 注意这是**中性**默认（0 = 不限）：本插件 2026-10-02 起泛化到多 provider，
 * 再拿 stepfun 的口径（并发 5 / RPM 10 / TPM 5M）当默认会静默限制别的 provider。
 * 各 provider 的现役值一律在 settings.yaml 的 perProvider 里显式写全。
 */
export const DEFAULT_RATE_LIMIT = Object.freeze({
  enabled: true,
  concurrency: 0,
  rpm: 0,
  tpm: 0,
  safetyMargin: 0.1,
  minIntervalMs: 0,
  assumedMaxTokens: 32768,
})

const MAX_TIMER_DELAY_MS = 2147483647

/** 数值兜底：非有限数、越界一律退回 fallback。 */
function num(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  if (value < min) return min
  if (value > max) return max
  return value
}

/**
 * 归一化配置（纯函数，便于单测）。
 * @param raw - 任意用户输入（settings.yaml 段落或 undefined）
 * @returns 冻结的限流器配置
 */
export function resolveRateLimitConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const d = DEFAULT_RATE_LIMIT
  return Object.freeze({
    // 只有显式布尔 false 才关闭；其余（缺省/脏值）走默认开启
    enabled: typeof source.enabled === 'boolean' ? source.enabled : d.enabled,
    // <=0 表示该维度不限（与千帆 tpm/rpm 的语义一致）
    concurrency: Math.floor(num(source.concurrency, d.concurrency, 0)),
    rpm: num(source.rpm, d.rpm, 0),
    tpm: num(source.tpm, d.tpm, 0),
    safetyMargin: num(source.safetyMargin, d.safetyMargin, 0, 1),
    minIntervalMs: num(source.minIntervalMs, d.minIntervalMs, 0, MAX_TIMER_DELAY_MS),
    assumedMaxTokens: Math.floor(num(source.assumedMaxTokens, d.assumedMaxTokens, 0)),
  })
}

/** 结构比较（用于"配置没变就不重建限流器，保住桶状态"）。 */
export function sameRateLimitConfig(a, b) {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  return (
    a.enabled === b.enabled &&
    a.concurrency === b.concurrency &&
    a.rpm === b.rpm &&
    a.tpm === b.tpm &&
    a.safetyMargin === b.safetyMargin &&
    a.minIntervalMs === b.minIntervalMs &&
    a.assumedMaxTokens === b.assumedMaxTokens
  )
}

/**
 * 估算输入字符数：递归遍历消息内容里的文本，跳过二进制字段。
 * 不 JSON.stringify（大上下文下会分配十几 MB 字符串，白费内存与时间）。
 * @param messages - GenerateOptions.messages
 * @returns 字符数估计
 */
export function estimateInputChars(messages) {
  const skip = new Set(['data', 'base64', 'blob', 'bytes', 'image_url'])
  const walk = (value, key) => {
    if (typeof value === 'string') return value.length
    if (typeof value === 'number' || typeof value === 'boolean') return 0
    if (Array.isArray(value)) {
      let n = 0
      for (const item of value) n += walk(item, key)
      return n
    }
    if (value !== null && typeof value === 'object') {
      let n = 0
      for (const k of Object.keys(value)) {
        if (skip.has(k)) continue
        n += walk(value[k], k)
      }
      return n
    }
    return 0
  }
  return walk(messages, 'messages')
}

/**
 * 单次请求的成本估计（token）。
 * ~4 字符/token（CJK 与中英混排经验值，与千帆实现同一口径）。
 * @param messages - 请求消息
 * @param maxTokens - 请求显式指定的输出上限，缺省用 assumedMaxTokens
 * @param assumedMaxTokens - 目录默认输出上限（stepfun 现网为 32768）
 */
export function estimateTokens(messages, maxTokens, assumedMaxTokens) {
  const input = Math.ceil(estimateInputChars(messages) / 4)
  const output = typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : assumedMaxTokens
  return input + output
}

/** 线性补充令牌桶（容量 = 限值，按 限值/60000 每毫秒补）。 */
export class TokenBucket {
  constructor(capacity, now) {
    this.capacity = capacity
    this.tokens = capacity
    this.lastRefill = now
  }

  refill(now) {
    if (this.capacity <= 0) return
    const elapsed = now - this.lastRefill
    if (elapsed <= 0) return
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed * this.capacity) / 60000)
    this.lastRefill = now
  }

  /**
   * 尝试预扣 cost。
   * @returns 0 = 已扣减成功；>0 = 需要等待的毫秒数（未扣减）
   */
  take(cost, now) {
    const need = Math.min(cost, this.capacity) // 单请求超过整桶容量时按整桶算，否则永远等不到
    this.refill(now)
    if (this.tokens >= need) {
      this.tokens -= need
      return 0
    }
    return Math.ceil((need - this.tokens) / (this.capacity / 60000))
  }
}

/** 公平信号量（FIFO），支持中止排队。limit <= 0 表示不限。 */
export class Semaphore {
  constructor(limit) {
    this.limit = limit
    this.active = 0
    this.queue = []
    this.peak = 0
  }

  acquire(signal) {
    if (this.limit <= 0 || this.active < this.limit) {
      if (signal?.aborted) return Promise.reject(abortReason(signal))
      this.active += 1
      if (this.active > this.peak) this.peak = this.active
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal, onAbort: null }
      if (signal !== undefined && signal !== null) {
        entry.onAbort = () => {
          const at = this.queue.indexOf(entry)
          if (at >= 0) this.queue.splice(at, 1)
          reject(abortReason(signal))
        }
        signal.addEventListener('abort', entry.onAbort, { once: true })
      }
      this.queue.push(entry)
      if (entry.onAbort !== null && signal.aborted) entry.onAbort()
    })
  }

  /** 释放一个槽位；有等待者时直接移交（active 不变）。幂等由调用方保证。 */
  release() {
    const next = this.queue.shift()
    if (next === undefined) {
      if (this.active > 0) this.active -= 1
      return
    }
    if (next.signal !== undefined && next.signal !== null && next.onAbort !== null) {
      next.signal.removeEventListener('abort', next.onAbort)
    }
    next.resolve()
  }
}

function abortReason(signal) {
  return signal?.reason ?? new DOMException('This operation was aborted', 'AbortError')
}

function defaultSleep(ms, signal) {
  if (ms <= 0) return Promise.resolve()
  if (signal?.aborted) return Promise.reject(abortReason(signal))
  return new Promise((resolve, reject) => {
    const onAbort =
      signal === undefined || signal === null
        ? null
        : () => {
            clearTimeout(timer)
            reject(abortReason(signal))
          }
    const timer = setTimeout(() => {
      if (onAbort !== null) signal.removeEventListener('abort', onAbort)
      resolve()
    }, Math.min(ms, MAX_TIMER_DELAY_MS))
    if (onAbort !== null) {
      signal.addEventListener('abort', onAbort, { once: true })
      // 检查与注册之间可能已经 abort：补一次，避免永久悬挂
      if (signal.aborted) onAbort()
    }
  })
}

/**
 * 由归一化配置算出实际生效的限值（纯函数，便于日志/测试复用）。
 * 注意：只含三维硬限，refillTokensPerMs 之类的派生量不在这里。
 */
export function effectiveLimits(resolved) {
  return {
    concurrency: resolved.concurrency,
    rpmLimit: resolved.rpm > 0 ? Math.floor(resolved.rpm * (1 - resolved.safetyMargin)) : 0,
    tpmLimit: resolved.tpm > 0 ? Math.floor(resolved.tpm * (1 - resolved.safetyMargin)) : 0,
  }
}

/**
 * 限流器。
 *
 * 用法：
 *   const limiter = new RateLimiter(config)
 *   const release = await limiter.acquire({ estimatedTokens, signal })
 *   try { ...发起请求... } finally { release() }
 */
export class RateLimiter {
  /**
   * @param config - 已归一化（resolveRateLimitConfig）或原始配置
   * @param deps - 注入点：now/sleep（单测用），onWait（诊断用）
   */
  constructor(config, deps = {}) {
    // 归一化是幂等的：已归一化的配置再走一遍结果不变
    const resolved = resolveRateLimitConfig(config)
    this.config = resolved
    this.now = deps.now ?? Date.now
    this.sleep = deps.sleep ?? defaultSleep
    this.onWait = deps.onWait
    // 有效限值：TPM/RPM 打余量，并发满额（见文件头说明）
    this.tpmLimit = resolved.tpm > 0 ? Math.floor(resolved.tpm * (1 - resolved.safetyMargin)) : 0
    this.rpmLimit = resolved.rpm > 0 ? Math.floor(resolved.rpm * (1 - resolved.safetyMargin)) : 0
    this.tokenBucket = this.tpmLimit > 0 ? new TokenBucket(this.tpmLimit, this.now()) : null
    this.requestBucket = this.rpmLimit > 0 ? new TokenBucket(this.rpmLimit, this.now()) : null
    this.slots = new Semaphore(resolved.concurrency)
    this.nextSlotAt = 0
    this.lastRequestAt = 0
    this.stats = {
      requests: 0,
      waits: { minIntervalMs: 0, tpmMs: 0, rpmMs: 0, concurrencyMs: 0, totalMs: 0 },
      maxInFlight: 0,
      tokensCharged: 0,
    }
  }

  get limits() {
    return {
      ...effectiveLimits(this.config),
      refillTokensPerMs: this.tpmLimit > 0 ? this.tpmLimit / 60000 : 0,
    }
  }

  /** 当前在飞请求数（诊断/测试用）。 */
  get inFlight() {
    return this.slots.active
  }

  /**
   * 取一个执行槽位（含全部节流等待）。
   * @param options.estimatedTokens - 成本（token）；缺省只算 1 个请求（不计 TPM）
   * @param options.signal - 中止信号；等待中被中止会 reject（已扣的桶不退，与千帆一致）
   * @returns release 函数（幂等）
   */
  async acquire(options = {}) {
    const signal = options.signal
    const cost = typeof options.estimatedTokens === 'number' && Number.isFinite(options.estimatedTokens) ? Math.max(0, options.estimatedTokens) : 0
    const startedAt = this.now()
    const wait = { minIntervalMs: 0, tpmMs: 0, rpmMs: 0, concurrencyMs: 0 }

    // 1) 最小间隔：先占号再睡（ticket 模式）——并发调用者各自拿到互不相同的
    //    发车时刻；若像千帆旧实现那样"睡醒后再起算"，并发下会一起醒来撞成批处理。
    if (this.config.minIntervalMs > 0) {
      const now = this.now()
      const target = Math.max(now, this.nextSlotAt)
      this.nextSlotAt = target + this.config.minIntervalMs
      const delta = target - now
      if (delta > 0) {
        await this.sleep(delta, signal)
        wait.minIntervalMs = delta
      }
    }

    // 2) TPM 桶
    while (this.tokenBucket !== null) {
      const delta = this.tokenBucket.take(cost, this.now())
      if (delta <= 0) break
      wait.tpmMs += delta
      await this.sleep(delta, signal)
    }

    // 3) RPM 桶
    while (this.requestBucket !== null) {
      const delta = this.requestBucket.take(1, this.now())
      if (delta <= 0) break
      wait.rpmMs += delta
      await this.sleep(delta, signal)
    }

    // 4) 并发槽位
    const slotWaitStartedAt = this.now()
    await this.slots.acquire(signal)
    wait.concurrencyMs = this.now() - slotWaitStartedAt

    this.lastRequestAt = this.now()
    this.stats.requests += 1
    this.stats.tokensCharged += cost
    this.stats.waits.minIntervalMs += wait.minIntervalMs
    this.stats.waits.tpmMs += wait.tpmMs
    this.stats.waits.rpmMs += wait.rpmMs
    this.stats.waits.concurrencyMs += wait.concurrencyMs
    const totalMs = this.now() - startedAt
    this.stats.waits.totalMs += totalMs
    if (this.slots.peak > this.stats.maxInFlight) this.stats.maxInFlight = this.slots.peak

    if (this.onWait !== null && this.onWait !== undefined && (totalMs > 0 || options.notifyAlways === true)) {
      try {
        this.onWait({ cost, wait, totalMs, inFlight: this.slots.active, meta: options.meta })
      } catch {
        // 诊断回调绝不能影响限流本身
      }
    }

    let released = false
    return () => {
      if (released) return
      released = true
      this.slots.release()
    }
  }

  /** 快照（诊断用）。 */
  snapshot() {
    return {
      limits: this.limits,
      inFlight: this.slots.active,
      queued: this.slots.queue.length,
      peakInFlight: this.slots.peak,
      tokens: this.tokenBucket === null ? null : Math.floor(this.tokenBucket.tokens),
      requests: this.requestBucket === null ? null : Math.floor(this.requestBucket.tokens),
      stats: { ...this.stats, waits: { ...this.stats.waits } },
    }
  }
}

/** 兼容旧名（2026-10-02 泛化前叫 StepfunRateLimiter，存量测试/调用方仍在用）。 */
export { RateLimiter as StepfunRateLimiter }
