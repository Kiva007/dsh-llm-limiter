/**
 * dsh-llm-limiter —— 客户端限流器（多 provider / 可选 per-model 分桶）
 *
 * 挂载点：`llm/stream` 瀑布（`ctx.on('llm/stream', (options, next) => AsyncIterable)`）。
 * 该缝在每次模型调用前分发，`next()` 才会走到真正的适配器 —— 因此把 `next()` 放在
 * 拿到槽位之后再调用，就能让 HTTP 请求真的被推迟（而不是先发出再限流）。
 *
 * 为什么是"外部插件"而不是改 pi-ai：
 *   - 内置 `dsh-llm-pi-ai` 完全没有限流，只会把 429 归类成可重试的 RATE_LIMIT；
 *   - 它装在 DSH 安装目录里，硬改会被升级覆盖；
 *   - `ctx.llm.registerAdapter` 对同 id 会抛 DUPLICATE_ADAPTER，包一层适配器不可行，
 *     而 llm/stream 是官方给插件留的拦截缝（dsh-cost-meter 等已在用）。
 *
 * 配置形态：
 *   llm-limiter:
 *     perProvider:
 *       stepfun:                       # pi-ai 路由 id
 *         rateLimit: { concurrency: 5, rpm: 0, tpm: 0, safetyMargin: 0.1, minIntervalMs: 0, assumedMaxTokens: 32768 }
 *       duanyan:
 *         perModel: true               # 每个模型一把独立闸门
 *         rateLimit: { concurrency: 30, rpm: 50, tpm: 0, ... }
 *
 *   - perProvider 的键 = 要限流的 provider；没列出的完全直连（等价于旧版 providers 白名单）。
 *   - perModel: true → 桶键为 `<provider>/<model>`。当提供方的限额本身是 per-model 口径时
 *     必须开（duanyan 的 RPM=50/分/模型即实测的 per-model 口径），否则一个模型就把
 *     provider 级桶用空，会无辜连坐其它模型。
 *   - rateLimit 缺字段回退中性默认（0 = 该维度不限），不会被别的 provider 口径污染。
 *
 * 演进：2026-10-02 由 dsh-llm-stepfun-limiter 泛化而来（原来只有 stepfun 一个 provider、
 * 扁平 rateLimit 配置）。stepfun 的现役值原样迁到 perProvider.stepfun，行为不变。
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_RATE_LIMIT,
  RateLimiter,
  effectiveLimits,
  estimateTokens,
  resolveRateLimitConfig,
  sameRateLimitConfig,
} from './rate-limiter.js'

export const name = 'dsh-llm-limiter'
/** settings.yaml 里的配置段落名。 */
export const NS = 'llm-limiter'
/** 日志文件超过这个大小就轮转一次（保留一份 .1）。 */
const MAX_LOG_BYTES = 5 * 1024 * 1024

const rateLimitSchema = z.object({
  enabled: z.boolean().default(DEFAULT_RATE_LIMIT.enabled),
  concurrency: z.number().min(0).default(DEFAULT_RATE_LIMIT.concurrency),
  rpm: z.number().min(0).default(DEFAULT_RATE_LIMIT.rpm),
  tpm: z.number().min(0).default(DEFAULT_RATE_LIMIT.tpm),
  safetyMargin: z.number().min(0).max(1).default(DEFAULT_RATE_LIMIT.safetyMargin),
  minIntervalMs: z.number().min(0).default(DEFAULT_RATE_LIMIT.minIntervalMs),
  assumedMaxTokens: z.number().min(0).default(DEFAULT_RATE_LIMIT.assumedMaxTokens),
})

/** 单个 provider 的限流配置；perModel 决定桶的粒度。 */
const providerSchema = z.object({
  enabled: z.boolean().default(true),
  perModel: z.boolean().default(false),
  rateLimit: rateLimitSchema,
})

export const Config = z.object({
  /** 总开关；false 时完全透传，不碰任何 provider。 */
  enabled: z.boolean().default(true),
  /** off=不写文件；throttle=只记被节流的请求；all=每个请求都记。 */
  log: z.union([z.const('off'), z.const('throttle'), z.const('all')]).default('throttle'),
  /** 日志文件路径；留空 = ~/.dsh/logs/llm-limiter.log。 */
  logFile: z.string().default(''),
  /** 要限流的 provider 及其限额；键 = pi-ai 路由 id。 */
  perProvider: z.dict(providerSchema).default({}),
})

function defaultLogFile() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'logs', 'llm-limiter.log')
}

/** 日志追加：任何失败都必须咽掉 —— 诊断不能反过来影响限流。 */
function appendLog(path, record) {
  if (typeof path !== 'string' || path.length === 0) return
  try {
    mkdirSync(dirname(path), { recursive: true })
    try {
      if (existsSync(path) && statSync(path).size > MAX_LOG_BYTES) renameSync(path, `${path}.1`)
    } catch {
      // 轮转失败不影响写入
    }
    appendFileSync(path, `${JSON.stringify({ t: new Date().toISOString(), ...record })}\n`, 'utf8')
  } catch {
    // 磁盘满/无权限等：静默降级为"没有日志"
  }
}

/** 把原始配置（可能来自 settings.yaml、可能缺失）折叠成生效配置。 */
export function resolveEffectiveConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const perProvider = new Map()
  const dict = source.perProvider
  if (dict !== null && typeof dict === 'object') {
    for (const [provider, entry] of Object.entries(dict)) {
      if (typeof provider !== 'string' || provider.length === 0) continue
      if (entry === null || typeof entry !== 'object') continue
      const rateLimit = resolveRateLimitConfig(entry.rateLimit)
      perProvider.set(provider, {
        enabled: entry.enabled !== false && rateLimit.enabled,
        perModel: entry.perModel === true,
        rateLimit,
      })
    }
  }
  return {
    enabled: source.enabled !== false,
    log: source.log === 'off' || source.log === 'all' ? source.log : 'throttle',
    logFile: typeof source.logFile === 'string' && source.logFile.length > 0 ? source.logFile : defaultLogFile(),
    perProvider,
  }
}

function sameEffectiveConfig(a, b) {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  if (a.enabled !== b.enabled || a.log !== b.log || a.logFile !== b.logFile) return false
  if (a.perProvider.size !== b.perProvider.size) return false
  for (const [provider, entry] of a.perProvider) {
    const other = b.perProvider.get(provider)
    if (other === undefined) return false
    if (entry.enabled !== other.enabled || entry.perModel !== other.perModel) return false
    if (!sameRateLimitConfig(entry.rateLimit, other.rateLimit)) return false
  }
  return true
}

export function apply(ctx, config) {
  // 设置服务是可选的：没有它（headless 等）就退回 cordis 配置，行为一致。
  // 用 inject 而不是一次性 ctx.get：设置服务可能比本插件晚就绪，inject 会在它
  // 出现时回调（pi-ai 自己也是这么接的）。scope 一旦挂上，下一次请求就会读到。
  let scope = null
  const attachSettings = (settings) => {
    if (scope !== null) return
    if (settings === null || settings === undefined || typeof settings.register !== 'function') return
    try {
      scope = settings.register(NS, Config, { base: config, applies: 'live' })
    } catch (error) {
      ctx.logger?.warn?.(`[llm-limiter] settings namespace "${NS}" 注册失败，回退到 cordis 配置：${String(error)}`)
    }
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (settingsCtx) => {
      attachSettings(settingsCtx.settings ?? settingsCtx.get?.('settings'))
    })
  } else {
    attachSettings(typeof ctx.get === 'function' ? ctx.get('settings') : undefined)
  }
  const readRaw = () => {
    if (scope === null) return config
    try {
      return scope.get()
    } catch {
      return config
    }
  }

  /**
   * 每个 provider 一个 holder：{ enabled, perModel, rateLimit, limiters: Map<桶键, 限流器> }。
   * 桶键 = perModel ? `${provider}/${model}` : provider — 惰性创建（模型集合运行时才知道）。
   * 配置对齐时"没动的 provider 整个 holder 原样保留"，因此它的桶状态（含已消耗的令牌）不丢。
   */
  const state = { effective: undefined, holders: new Map(), logPath: undefined }

  /** 每次请求前对齐配置：值没变的 provider 保留同一批限流器实例。 */
  const sync = () => {
    const next = resolveEffectiveConfig(readRaw())
    if (sameEffectiveConfig(state.effective, next)) return state.effective
    const previous = state.effective
    state.effective = next
    state.logPath = next.logFile
    const merged = new Map()
    for (const [provider, entry] of next.perProvider) {
      const old = state.holders.get(provider)
      if (
        old !== undefined &&
        old.enabled === entry.enabled &&
        old.perModel === entry.perModel &&
        sameRateLimitConfig(old.rateLimit, entry.rateLimit)
      ) {
        merged.set(provider, old) // 配置没动：连桶实例一起保留
        continue
      }
      merged.set(provider, { ...entry, limiters: new Map() })
      if (old !== undefined) {
        // 只有"原本就存在、现在被改了"的 provider 才记 config-change（首次装载由 plugin-load 记录）
        appendLog(state.logPath, {
          event: 'config-change',
          provider,
          enabled: entry.enabled,
          perModel: entry.perModel,
          rateLimit: entry.rateLimit,
        })
      }
    }
    state.holders = merged
    if (previous !== undefined) {
      const summary = [...merged]
        .map(([p, h]) => `${p}{${h.perModel ? 'perModel,' : ''}conc ${h.rateLimit.concurrency}, rpm ${h.rateLimit.rpm}, tpm ${h.rateLimit.tpm}}`)
        .join(' ')
      console.log(`[llm-limiter] config changed: ${summary || '(no provider)'} enabled=${next.enabled}`)
    }
    return next
  }

  const limiterFor = (holder, bucketKey) => {
    let limiter = holder.limiters.get(bucketKey)
    if (limiter === undefined) {
      limiter = new RateLimiter(holder.rateLimit, {
        onWait: (info) => {
          const effective = state.effective
          if (effective === undefined) return
          const waited = info.totalMs > 0
          if (effective.log === 'off') return
          if (effective.log === 'throttle' && !waited) return
          appendLog(state.logPath, {
            event: 'gate',
            provider: info.meta?.provider,
            model: info.meta?.model,
            perModel: info.meta?.perModel,
            session: typeof info.meta?.sessionId === 'string' ? info.meta.sessionId : undefined,
            cost: info.cost,
            inFlight: info.inFlight,
            waitMs: { ...info.wait, totalMs: info.totalMs },
          })
        },
      })
      holder.limiters.set(bucketKey, limiter)
    }
    return limiter
  }

  const initial = sync()
  const providersAtLoad = Object.fromEntries(
    [...state.holders].map(([provider, holder]) => [
      provider,
      { enabled: holder.enabled, perModel: holder.perModel, rateLimit: holder.rateLimit, limits: effectiveLimits(holder.rateLimit) },
    ]),
  )
  appendLog(initial.logFile, {
    event: 'plugin-load',
    pid: process.pid,
    enabled: initial.enabled,
    log: initial.log,
    providers: providersAtLoad,
  })
  const announce =
    `[llm-limiter] mounted: ${Object.entries(providersAtLoad).map(([p, v]) => `${p}{${v.perModel ? 'perModel,' : ''}conc ${v.limits.concurrency}, rpm ${v.limits.rpmLimit}, tpm ${v.limits.tpmLimit}}`).join(' ') || '(no provider)'} ` +
    `log=${initial.log} file=${initial.logFile}`
  ctx.logger?.info?.(announce)
  // 实测（2026-09-20，stepfun-limiter 时代）：ctx.logger.info 不会落进 ~/.dsh/logs/dsh-web-*.log，
  // 而 stdout 会被启动器收进去。挂载/配置变更/流错误都往 stdout 也打一份，保证"看得见"；
  // 逐请求流水（gate）只进 JSON 文件，避免刷屏。
  console.log(announce)

  ctx.on('llm/stream', (options, next) => {
    const effective = sync()
    if (!effective.enabled) return next()
    const provider = options?.provider
    if (typeof provider !== 'string' || provider.length === 0) return next()
    const holder = state.holders.get(provider)
    if (holder === undefined || !holder.enabled) return next()

    const model = typeof options?.model === 'string' ? options.model : ''
    const bucketKey = holder.perModel ? `${provider}/${model}` : provider
    const limiter = limiterFor(holder, bucketKey)

    const cost = estimateTokens(options?.messages, options?.maxTokens, holder.rateLimit.assumedMaxTokens)
    const meta = { provider, model, perModel: holder.perModel, sessionId: options.sessionId }
    const logMode = effective.log

    return (async function* gatedStream() {
      const startedAt = Date.now()
      let release
      try {
        release = await limiter.acquire({ estimatedTokens: cost, signal: options.signal, meta, notifyAlways: logMode === 'all' })
      } catch (error) {
        appendLog(state.logPath, {
          event: 'acquire-aborted',
          provider: meta.provider,
          model: meta.model,
          error: String(error?.message ?? error),
        })
        throw error
      }
      let completed = false
      let failure = null
      try {
        // next() 在这里才调用：HTTP 请求只会在拿到槽位之后发出
        const iterator = next()[Symbol.asyncIterator]()
        try {
          for (;;) {
            const result = await iterator.next()
            if (result.done === true) {
              completed = true
              break
            }
            yield result.value
          }
        } finally {
          // 消费方提前中断（break/return/throw）时必须把关闭传播给下游，
          // 否则上游 HTTP 流会继续跑完，白烧 token（dsh-cost-meter 踩过同一个坑）
          if (!completed) {
            try {
              await iterator.return?.()
            } catch {
              // 关闭失败不影响限流槽位释放
            }
          }
        }
      } catch (error) {
        failure = error
        throw error
      } finally {
        release()
        if (logMode === 'all' || (failure !== null && logMode !== 'off')) {
          appendLog(state.logPath, {
            event: failure === null ? 'stream-done' : 'stream-error',
            provider: meta.provider,
            model: meta.model,
            ms: Date.now() - startedAt,
            completed,
            inFlight: limiter.inFlight,
            error: failure === null ? undefined : String(failure?.message ?? failure),
          })
          if (failure !== null) console.warn(`[llm-limiter] stream error on ${meta.model}: ${String(failure?.message ?? failure)}`)
        }
      }
    })()
  })
}
