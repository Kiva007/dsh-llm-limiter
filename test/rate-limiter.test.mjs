/**
 * 限流器核心单测（node:test，无依赖）
 * 运行：node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_RATE_LIMIT,
  StepfunRateLimiter,
  estimateInputChars,
  estimateTokens,
  resolveRateLimitConfig,
  sameRateLimitConfig,
} from '../lib/rate-limiter.js'

const tick = () => new Promise((r) => setTimeout(r, 0))

/** 虚拟时钟：sleep 只推进 now，不真的等；用于确定性验证节流数值。 */
function virtualClock() {
  const clock = { now: 0 }
  return {
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms
    },
    advance: (ms) => {
      clock.now += ms
    },
    value: () => clock.now,
  }
}

test('resolveRateLimitConfig：默认值、覆盖、钳制', () => {
  // 泛化后的中性默认：0 = 该维度不限（各 provider 的现役值在 settings.yaml 显式写全）
  const d = resolveRateLimitConfig(undefined)
  assert.equal(d.concurrency, DEFAULT_RATE_LIMIT.concurrency)
  assert.equal(d.rpm, 0)
  assert.equal(d.tpm, 0)
  assert.equal(d.assumedMaxTokens, 32768)
  assert.equal(d.enabled, true)

  const custom = resolveRateLimitConfig({ concurrency: 3, rpm: 8, tpm: 100, safetyMargin: 0, minIntervalMs: 500, assumedMaxTokens: 1024 })
  assert.equal(custom.concurrency, 3)
  assert.equal(custom.rpm, 8)
  assert.equal(custom.safetyMargin, 0)
  assert.equal(custom.minIntervalMs, 500)
  assert.equal(custom.assumedMaxTokens, 1024)

  // 越界与脏值
  const dirty = resolveRateLimitConfig({ concurrency: -4, rpm: Number.NaN, tpm: 'x', safetyMargin: 5, minIntervalMs: -1, enabled: 'no' })
  assert.equal(dirty.concurrency, 0)
  assert.equal(dirty.rpm, 0) // NaN → 默认（默认即 0 = 不限）
  assert.equal(dirty.tpm, 0)
  assert.equal(dirty.safetyMargin, 1)
  assert.equal(dirty.minIntervalMs, 0)
  assert.equal(dirty.enabled, true, '脏值不应被当成 false')
  assert.equal(resolveRateLimitConfig({ enabled: false }).enabled, false)
})

test('sameRateLimitConfig：结构比较（配置没变就不重建，保住桶状态）', () => {
  const a = resolveRateLimitConfig({ concurrency: 5, rpm: 10 })
  const b = resolveRateLimitConfig({ concurrency: 5, rpm: 10 })
  const c = resolveRateLimitConfig({ concurrency: 5, rpm: 11 })
  assert.equal(sameRateLimitConfig(a, b), true)
  assert.equal(sameRateLimitConfig(a, c), false)
  assert.equal(sameRateLimitConfig(a, undefined), false)
})

test('estimateInputChars/estimateTokens：跳过二进制字段，输出上限取 maxTokens', () => {
  const messages = [
    { role: 'user', content: 'abcd' }, // 4
    { role: 'user', content: [{ type: 'tool_result', content: 'efgh' }] }, // 4
    { role: 'user', content: [{ type: 'image', image_url: 'data:image/png;base64,' + 'A'.repeat(100000) }] }, // 跳过
  ]
  const chars = estimateInputChars(messages)
  assert.ok(chars < 100, `应跳过 image_url，实际 ${chars}`)
  assert.equal(estimateTokens(messages, 1000, 32768), Math.ceil(chars / 4) + 1000)
  assert.equal(estimateTokens(messages, undefined, 32768), Math.ceil(chars / 4) + 32768)
})

test('并发信号量：12 个请求同时来，最多 5 个在飞；释放后按 FIFO 放行', async () => {
  const limiter = new StepfunRateLimiter({ concurrency: 5, rpm: 0, tpm: 0, safetyMargin: 0 })
  const granted = []
  for (let i = 0; i < 12; i++) {
    void limiter.acquire({ meta: i }).then((release) => granted.push({ i, release }))
  }
  await tick()
  assert.equal(granted.length, 5, '只应有 5 个拿到槽位')
  assert.equal(limiter.inFlight, 5)
  assert.deepEqual(granted.map((g) => g.i), [0, 1, 2, 3, 4], '应按到达顺序放行')

  granted[0].release()
  await tick()
  assert.equal(granted.length, 6)
  assert.equal(granted[5].i, 5, '释放的槽位应移交给队首等待者')
  assert.equal(limiter.inFlight, 5, '移交后仍在飞数不变')

  // 放完全部
  for (const g of [...granted]) g.release()
  await tick()
  for (let i = 0; i < 20 && granted.length < 12; i++) {
    for (const g of [...granted]) g.release()
    await tick()
  }
  assert.equal(granted.length, 12, '最终 12 个都应拿到槽位')
})

test('释放幂等：重复 release 不会多放行', async () => {
  const limiter = new StepfunRateLimiter({ concurrency: 1, rpm: 0, tpm: 0, safetyMargin: 0 })
  const first = await limiter.acquire()
  let secondGranted = false
  void limiter.acquire().then(() => {
    secondGranted = true
  })
  await tick()
  assert.equal(secondGranted, false)
  first()
  first() // 重复释放：不应让第二个之外的东西通过
  await tick()
  assert.equal(secondGranted, true)
  assert.equal(limiter.inFlight, 1)
})

test('RPM 桶：容量 = floor(rpm×(1−margin))，桶空后按线性补充等待', async () => {
  const clock = virtualClock()
  const limiter = new StepfunRateLimiter({ concurrency: 0, rpm: 10, tpm: 0, safetyMargin: 0 }, clock)
  assert.equal(limiter.limits.rpmLimit, 10)
  for (let i = 0; i < 10; i++) {
    const release = await limiter.acquire()
    release()
  }
  const release11 = await limiter.acquire() // 第 11 个：等 6000ms（10 个/min 的补充速率）
  release11()
  assert.equal(limiter.stats.waits.rpmMs, 6000)
  assert.equal(clock.value(), 6000)
})

test('TPM 桶：按预估 token 扣减，超限等待；单请求超过整桶容量时按整桶算', async () => {
  const clock = virtualClock()
  const limiter = new StepfunRateLimiter({ concurrency: 0, rpm: 0, tpm: 60000, safetyMargin: 0 }, clock)
  assert.equal(limiter.limits.tpmLimit, 60000)
  for (let i = 0; i < 3; i++) {
    const release = await limiter.acquire({ estimatedTokens: 20000 })
    release()
  }
  const fourth = await limiter.acquire({ estimatedTokens: 20000 })
  fourth()
  assert.equal(limiter.stats.waits.tpmMs, 20000, '第 4 个应等 20000ms')

  // 单请求成本 > 桶容量：不应永久饥饿（按整桶算，等到满桶即可）
  const small = new StepfunRateLimiter({ concurrency: 0, rpm: 0, tpm: 1000, safetyMargin: 0 }, virtualClock())
  const release = await small.acquire({ estimatedTokens: 999999 })
  release()
  assert.equal(small.stats.waits.tpmMs, 0, '空桶首请求立即放行（桶初始满）')
})

test('安全余量只作用于 TPM/RPM，不作用于并发', () => {
  const limiter = new StepfunRateLimiter({ concurrency: 5, rpm: 10, tpm: 5000000, safetyMargin: 0.1 })
  assert.deepEqual(limiter.limits, {
    concurrency: 5, // 满额：provider 硬上限就是 5，打折等于白扔吞吐
    rpmLimit: 9,
    tpmLimit: 4500000,
    refillTokensPerMs: 75,
  })
})

test('最小间隔：并发下也保证逐请求间隔（千帆旧实现会退化成批处理）', async () => {
  const limiter = new StepfunRateLimiter({ concurrency: 0, rpm: 0, tpm: 0, safetyMargin: 0, minIntervalMs: 60 })
  const starts = []
  const t0 = Date.now()
  await Promise.all(
    Array.from({ length: 6 }, () =>
      limiter.acquire().then((release) => {
        starts.push(Date.now() - t0)
        release()
      }),
    ),
  )
  starts.sort((a, b) => a - b)
  assert.equal(starts.length, 6)
  for (let i = 1; i < starts.length; i++) {
    const gap = starts[i] - starts[i - 1]
    assert.ok(gap >= 40, `第 ${i} 个间隔应 ≥40ms，实际 ${gap}ms（starts=${starts.join(',')}）`)
  }
})

test('中止：排队等槽位时 abort 立即 reject，且不泄漏槽位', async () => {
  const limiter = new StepfunRateLimiter({ concurrency: 1, rpm: 0, tpm: 0, safetyMargin: 0 })
  const holder = await limiter.acquire()
  const ac = new AbortController()
  const queued = limiter.acquire({ signal: ac.signal })
  await tick()
  assert.equal(limiter.snapshot().queued, 1)
  ac.abort()
  await assert.rejects(queued, (error) => error.name === 'AbortError')
  assert.equal(limiter.snapshot().queued, 0, '中止的等待者必须从队列移除')
  holder()
  const next = await limiter.acquire()
  next()
  assert.equal(limiter.inFlight, 0)
})

test('中止：等令牌桶时 abort 立即 reject', async () => {
  const limiter = new StepfunRateLimiter({ concurrency: 0, rpm: 1, tpm: 0, safetyMargin: 0 })
  ;(await limiter.acquire())() // 用掉唯一的请求令牌
  const ac = new AbortController()
  const pending = limiter.acquire({ signal: ac.signal })
  await tick()
  ac.abort()
  await assert.rejects(pending, (error) => error.name === 'AbortError')
})

test('诊断回调：onWait 收到等待明细，且回调抛错不影响限流', async () => {
  const clock = virtualClock()
  const seen = []
  const limiter = new StepfunRateLimiter(
    { concurrency: 0, rpm: 1, tpm: 0, safetyMargin: 0 },
    {
      ...clock,
      onWait: (info) => {
        seen.push(info)
        throw new Error('诊断回调故意抛错')
      },
    },
  )
  ;(await limiter.acquire())()
  ;(await limiter.acquire({ meta: { model: 'step-5-preview' } }))()
  assert.equal(seen.length, 1)
  assert.equal(seen[0].meta.model, 'step-5-preview')
  assert.ok(seen[0].totalMs > 0)
})

test('snapshot：暴露限值与在飞/排队（诊断用）', async () => {
  const limiter = new StepfunRateLimiter({ concurrency: 2, rpm: 10, tpm: 1000, safetyMargin: 0 })
  const a = await limiter.acquire({ estimatedTokens: 10 })
  const snap = limiter.snapshot()
  assert.equal(snap.inFlight, 1)
  assert.equal(snap.limits.concurrency, 2)
  assert.equal(snap.tokens, 990)
  a()
  assert.equal(limiter.snapshot().inFlight, 0)
})
