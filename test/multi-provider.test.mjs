/**
 * 多 provider / per-model 分桶测试（2026-10-02 泛化新增）。
 *
 * 背景：duanyan 的 RPM=50 是**按模型**的口径（实测：三模型并行 burst 各 49 ok + 1×429，
 * 互不污染），而 stepfun 的并发 5 是 provider 级口径。所以限流器必须支持两种分桶粒度。
 *
 * 运行：node --test test/multi-provider.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

function tempLog() {
  return join(mkdtempSync(join(tmpdir(), 'llm-limiter-multi-')), 'limiter.log')
}

function mount(config) {
  const listeners = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(name, handler) {
      listeners.push({ name, handler })
      return () => {}
    },
    get() {
      return undefined // 无设置服务：直接用 cordis 配置
    },
  }
  apply(ctx, config)
  return listeners.find((l) => l.name === 'llm/stream').handler
}

/**
 * 下游：插件是 `next()` 无参调用的，所以按 (provider, model) 预先绑定一把，
 * 每个组合独立记录 active/peak，用来分别观察各自的并发峰值。
 */
function makeTaggedDownstream() {
  const stats = new Map()
  const entry = (key) => {
    let s = stats.get(key)
    if (s === undefined) {
      s = { active: 0, peak: 0, calls: 0 }
      stats.set(key, s)
    }
    return s
  }
  const bound = (provider, model) => {
    const s = entry(`${provider}/${model}`)
    return () =>
      (async function* downstream() {
        s.calls += 1
        s.active += 1
        s.peak = Math.max(s.peak, s.active)
        try {
          for (let i = 0; i < 2; i++) {
            await new Promise((r) => setTimeout(r, 8))
            yield { type: 'text', text: `chunk-${i}` }
          }
        } finally {
          s.active -= 1
        }
      })()
  }
  /** 不关心统计的通用下游（RPM 类测试只用日志判据）。 */
  const plain = () =>
    (async function* downstream() {
      yield { type: 'text', text: 'x' }
    })()
  return { bound, plain, stats }
}

async function drain(stream) {
  let n = 0
  for await (const _c of stream) n += 1
  return n
}

const req = (provider, model) => ({ provider, model, messages: [{ role: 'user', content: 'hi' }], sessionId: 'session-multi' })

function records(logFile) {
  return readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
}

test('perModel: true —— 每个模型一把独立并发闸门', async () => {
  const handler = mount({
    logFile: tempLog(),
    perProvider: { duanyan: { perModel: true, rateLimit: { concurrency: 1, rpm: 0, tpm: 0 } } },
  })
  const { bound, stats } = makeTaggedDownstream()
  // 同一 provider 两个不同模型各发 1 个：perModel 下必须能同时跑（各自的槽位）
  await Promise.all([drain(handler(req('duanyan', 'intern-s2'), bound('duanyan', 'intern-s2'))), drain(handler(req('duanyan', 'Agents-A1'), bound('duanyan', 'Agents-A1')))])
  assert.equal(stats.get('duanyan/intern-s2').peak, 1)
  assert.equal(stats.get('duanyan/Agents-A1').peak, 1)
  // 合计并发 2 证明是两把锁；若共用一把（limit 1）这里必然有一个排队到 8ms 之后
})

test('perModel 缺省（false）—— 同 provider 所有模型共用一把并发闸门', async () => {
  const handler = mount({
    logFile: tempLog(),
    perProvider: { duanyan: { rateLimit: { concurrency: 1, rpm: 0, tpm: 0 } } },
  })
  const { bound, stats } = makeTaggedDownstream()
  const startedAt = Date.now()
  await Promise.all([drain(handler(req('duanyan', 'intern-s2'), bound('duanyan', 'intern-s2'))), drain(handler(req('duanyan', 'Agents-A1'), bound('duanyan', 'Agents-A1')))])
  const elapsed = Date.now() - startedAt
  assert.equal(stats.get('duanyan/intern-s2').calls + stats.get('duanyan/Agents-A1').calls, 2)
  assert.ok(elapsed >= 14, `共用一把锁时第二个必须等第一个跑完（实测 ${elapsed}ms）`)
})

test('perModel RPM 分桶：一个模型把桶用空，不影响另一个模型', async () => {
  const logFile = tempLog()
  const handler = mount({
    logFile,
    log: 'all', // 每个请求都记 gate，waitMs.rpmMs 就是"是否被 RPM 挡住"的确定性证据
    perProvider: { duanyan: { perModel: true, rateLimit: { concurrency: 0, rpm: 60, tpm: 0, safetyMargin: 0 } } },
  })
  const { plain } = makeTaggedDownstream()
  // 每个模型 60/min 的桶容量：intern-s2 连打 60 个把桶用空
  for (let i = 0; i < 60; i++) await drain(handler(req('duanyan', 'intern-s2'), plain))
  // Agents-A1 第一个请求必须立刻放行（独立桶，等待 0）
  await drain(handler(req('duanyan', 'Agents-A1'), plain))
  const gates = records(logFile).filter((r) => r.event === 'gate')
  assert.equal(gates.length, 61)
  const other = gates.filter((g) => g.model === 'Agents-A1')
  assert.equal(other.length, 1)
  assert.equal(other[0].waitMs.rpmMs, 0, '另一个模型不该被 intern-s2 的桶挡住')
  assert.equal(other[0].waitMs.totalMs, 0)
})

test('非 perModel RPM：所有模型共用一个桶，用完一起排队', async () => {
  const logFile = tempLog()
  const handler = mount({
    logFile,
    log: 'all',
    perProvider: { duanyan: { rateLimit: { concurrency: 0, rpm: 60, tpm: 0, safetyMargin: 0 } } },
  })
  const { plain } = makeTaggedDownstream()
  for (let i = 0; i < 60; i++) await drain(handler(req('duanyan', i % 2 === 0 ? 'intern-s2' : 'Agents-A1'), plain))
  await drain(handler(req('duanyan', 'Atria-Dawn-Preview'), plain)) // 第 61 个：等 ~1000ms（60/min 补充）
  const gates = records(logFile).filter((r) => r.event === 'gate')
  assert.equal(gates.length, 61)
  const last = gates[gates.length - 1]
  assert.ok(last.waitMs.rpmMs > 0, `共用桶时第 61 个必须等 RPM 补充，实际 ${JSON.stringify(last.waitMs)}`)
  assert.equal(last.model, 'Atria-Dawn-Preview', '跨模型也挡：证明桶是 provider 级共享的')
})

test('provider 隔离：stepfun 被打满不影响 duanyan 放行', async () => {
  const handler = mount({
    logFile: tempLog(),
    perProvider: {
      stepfun: { rateLimit: { concurrency: 1, rpm: 0, tpm: 0 } },
      duanyan: { perModel: true, rateLimit: { concurrency: 5, rpm: 0, tpm: 0 } },
    },
  })
  const { bound, stats } = makeTaggedDownstream()
  // stepfun 先占住唯一槽位不放（用一个长期流拖住）
  const holder = handler(req('stepfun', 'step-5-preview'), bound('stepfun', 'step-5-preview'))
  const iter = holder[Symbol.asyncIterator]()
  await iter.next() // 拿到第一个分片 → stepfun 槽位被占
  const startedAt = Date.now()
  await Promise.all([
    ...Array.from({ length: 5 }, () => drain(handler(req('duanyan', 'intern-s2'), bound('duanyan', 'intern-s2')))), // duanyan 上限 5
    drain(handler(req('duanyan', 'Agents-A1'), bound('duanyan', 'Agents-A1'))), // perModel 下另一个模型还能再来 1 个
  ])
  const elapsed = Date.now() - startedAt
  assert.equal(stats.get('duanyan/intern-s2').peak, 5, 'duanyan 该模型可用满 5 个槽')
  assert.equal(stats.get('duanyan/Agents-A1').peak, 1, 'perModel 下另一个模型独立放行')
  // stepfun 的槽位是被一直占住不放的：duanyan 若被它阻塞，这里根本回不来。
  // 上界取宽松值（1.5s）——墙钟小上界在机器繁忙时会 flake，且没有额外判别力。
  assert.ok(elapsed < 1500, `duanyan 不该被 stepfun 阻塞（实测 ${elapsed}ms）`)
  await iter.return()
})

test('plugin-load 按 provider 分列生效限值（含 perModel 标记）', () => {
  const logFile = tempLog()
  mount({
    logFile,
    perProvider: {
      stepfun: { rateLimit: { concurrency: 5, rpm: 0, tpm: 0 } },
      duanyan: { perModel: true, rateLimit: { concurrency: 30, rpm: 50, tpm: 0, safetyMargin: 0.1 } },
    },
  })
  const first = records(logFile)[0]
  assert.equal(first.event, 'plugin-load')
  assert.equal(first.providers.stepfun.perModel, false)
  assert.deepEqual(first.providers.stepfun.limits, { concurrency: 5, rpmLimit: 0, tpmLimit: 0 })
  assert.equal(first.providers.duanyan.perModel, true)
  assert.deepEqual(first.providers.duanyan.limits, { concurrency: 30, rpmLimit: 45, tpmLimit: 0 }, 'rpm 50 × (1−0.1) = 45')
})

test('gate 日志带 provider/model，per-model 时分桶可追溯', async () => {
  const logFile = tempLog()
  const handler = mount({
    logFile,
    log: 'all',
    perProvider: { duanyan: { perModel: true, rateLimit: { concurrency: 1, rpm: 0, tpm: 0 } } },
  })
  const { plain } = makeTaggedDownstream()
  await Promise.all([
    drain(handler(req('duanyan', 'intern-s2'), plain)),
    drain(handler(req('duanyan', 'intern-s2'), plain)), // 第二个要等槽位 → 有 gate 记录
  ])
  const gates = records(logFile).filter((r) => r.event === 'gate')
  assert.ok(gates.length >= 1)
  assert.ok(gates.every((g) => g.provider === 'duanyan' && g.model === 'intern-s2'))
  assert.ok(gates.some((g) => g.waitMs.concurrencyMs > 0), '排队等槽位的请求必须留痕')
})
