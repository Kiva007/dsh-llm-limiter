/**
 * 插件外壳测试：用假 ctx 跑真实的 apply()，验证挂载、过滤、闸门、释放与日志。
 * 运行：node --test test/plugin.test.mjs
 *
 * 配置形态（2026-10-02 泛化后）：
 *   llm-limiter:
 *     perProvider:
 *       <provider 路由 id>: { enabled?, perModel?, rateLimit: {...} }
 *   - perProvider 的键就是要限流的 provider；没列出的完全直连
 *   - perModel: true 时每个模型一把独立闸门（provider 的限额是 per-model 口径时用）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config, NS, apply, resolveEffectiveConfig } from '../lib/index.js'

function tempLog() {
  return join(mkdtempSync(join(tmpdir(), 'llm-limiter-')), 'limiter.log')
}

/** 假设置服务：只实现插件真正用到的那一部分契约（register → get/watch）。 */
function fakeSettings(initial) {
  const state = { value: initial }
  return {
    service: {
      register(ns, schema, options) {
        assert.equal(ns, NS, `注册的 namespace 必须是 ${NS}`)
        assert.ok(schema !== undefined && schema !== null, '必须传 schema')
        assert.ok(options === undefined || typeof options === 'object')
        return {
          get: () => state.value,
          watch: () => () => {},
          update: async () => {},
        }
      },
    },
    set(value) {
      state.value = value
    },
  }
}

function mount(config, settingsService) {
  const listeners = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(name, handler) {
      listeners.push({ name, handler })
      return () => {}
    },
    get(name) {
      return name === 'settings' ? settingsService : undefined
    },
  }
  apply(ctx, config)
  const entry = listeners.find((l) => l.name === 'llm/stream')
  assert.ok(entry !== undefined, '插件必须注册 llm/stream 监听器')
  return entry.handler
}

/** 假下游适配器：记录并发峰值/关闭情况，可控制分片数与每片耗时。 */
function makeDownstream({ chunks = 3, holdMs = 5 } = {}) {
  const state = { active: 0, peak: 0, started: 0, closed: 0, calls: 0 }
  const next = () => {
    state.calls += 1
    return (async function* downstream() {
      state.started += 1
      state.active += 1
      state.peak = Math.max(state.peak, state.active)
      try {
        for (let i = 0; i < chunks; i++) {
          await new Promise((r) => setTimeout(r, holdMs))
          yield { type: 'text', text: `chunk-${i}` }
        }
      } finally {
        state.active -= 1
        state.closed += 1
      }
    })()
  }
  return { next, state }
}

async function drain(stream) {
  const out = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

const request = (provider = 'stepfun', model = 'step-5-preview') => ({
  provider,
  model,
  messages: [{ role: 'user', content: 'hi' }],
  sessionId: 'session-test',
})

/** 只配一个 provider 的便捷写法（存量测试都只关心 stepfun）。 */
const only = (provider, rateLimit, extra = {}) => ({ perProvider: { [provider]: { rateLimit, ...extra } } })

test('Config schema：默认中性（不限流），perProvider 空', () => {
  const resolved = Config({})
  assert.equal(resolved.enabled, true)
  assert.equal(resolved.log, 'throttle')
  assert.deepEqual(resolved.perProvider, {}, '默认不该限任何 provider')
})

test('resolveEffectiveConfig：脏值兜底 + perProvider 归一化', () => {
  const eff = resolveEffectiveConfig({
    perProvider: { '': { rateLimit: {} }, bad: null, stepfun: { perModel: 'yes' }, duanyan: { enabled: false } },
    log: 'bogus',
    logFile: '',
  })
  assert.equal(eff.log, 'throttle')
  assert.ok(!eff.perProvider.has(''), '空 provider 键必须被丢弃')
  assert.ok(!eff.perProvider.has('bad'), '非对象条目必须被丢弃')
  assert.equal(eff.perProvider.get('stepfun').perModel, false, 'perModel 非 true 一律按 false')
  assert.equal(eff.perProvider.get('duanyan').enabled, false)
  assert.equal(eff.perProvider.get('stepfun').enabled, true)
  // rateLimit 缺字段时回退中性默认（concurrency 0 = 不限），不会被别的 provider 口径污染
  assert.equal(eff.perProvider.get('stepfun').rateLimit.concurrency, 0)
  assert.ok(existsSync(join(eff.logFile, '..')), '默认日志目录应可推导')
  assert.equal(resolveEffectiveConfig(undefined).enabled, true)
  assert.equal(resolveEffectiveConfig({ enabled: false }).enabled, false)
})

test('非目标 provider 直接透传：不调限流、next() 结果原样返回', () => {
  const handler = mount({ logFile: tempLog(), log: 'all', ...only('stepfun', { concurrency: 1 }) })
  const { next, state } = makeDownstream()
  const passthrough = next()
  const result = handler(request('deepseek-official'), () => passthrough)
  assert.equal(result, passthrough, '未列入 perProvider 的 provider 必须返回同一个流对象')
  assert.equal(state.calls, 1)
})

test('enabled: false 时完全透传', () => {
  const handler = mount({ enabled: false, logFile: tempLog(), ...only('stepfun', { concurrency: 1 }) })
  const { next } = makeDownstream()
  const passthrough = next()
  assert.equal(handler(request(), () => passthrough), passthrough)
})

test('perProvider 里 enabled: false 的 provider 透传（不影响其它 provider）', () => {
  const handler = mount({
    logFile: tempLog(),
    perProvider: { stepfun: { enabled: false, rateLimit: { concurrency: 1 } }, duanyan: { rateLimit: { concurrency: 1 } } },
  })
  const { next } = makeDownstream()
  const passthrough = next()
  assert.equal(handler(request('stepfun'), () => passthrough), passthrough, 'stepfun 被单独关掉 → 透传')
  assert.notEqual(handler(request('duanyan'), next), passthrough, 'duanyan 仍要过闸门')
})

test('next() 惰性：消费方拉取之前不发起下游请求', async () => {
  const handler = mount({ logFile: tempLog(), ...only('stepfun', { concurrency: 5 }) })
  const { next, state } = makeDownstream()
  const stream = handler(request(), next)
  assert.equal(state.calls, 0, 'next() 不应在瀑布分发时就被调用')
  await drain(stream)
  assert.equal(state.calls, 1)
})

test('并发闸门：8 个并发流，下游同时在跑的不超过 5 个', async () => {
  const handler = mount({ logFile: tempLog(), ...only('stepfun', { concurrency: 5, rpm: 0, tpm: 0 }) })
  const { next, state } = makeDownstream({ chunks: 3, holdMs: 5 })
  const streams = Array.from({ length: 8 }, () => handler(request(), next))
  const results = await Promise.all(streams.map(drain))
  assert.equal(results.length, 8)
  assert.ok(results.every((chunks) => chunks.length === 3), '每个流都应完整收到 3 个分片')
  assert.equal(state.peak, 5, `应真的用满 5 个槽位，实际峰值 ${state.peak}`)
  assert.equal(state.active, 0, '全部结束后不应有残留')
  assert.equal(state.closed, 8, '每个下游流都应被正常关闭')
})

test('消费方提前中断：向下游传播关闭 + 立即归还槽位', async () => {
  const handler = mount({ logFile: tempLog(), ...only('stepfun', { concurrency: 1, rpm: 0, tpm: 0 }) })
  const { next, state } = makeDownstream({ chunks: 5, holdMs: 2 })
  const stream = handler(request(), next)
  const iterator = stream[Symbol.asyncIterator]()
  const first = await iterator.next()
  assert.equal(first.done, false)
  await iterator.return()
  assert.equal(state.closed, 1, '下游 async generator 的 finally 必须执行（关闭已传播）')
  assert.equal(state.active, 0, '槽位必须归还')
  // 归还后应能立刻再取一个（若泄漏，这里会一直挂着直到测试超时）
  const again = await drain(handler(request(), next))
  assert.equal(again.length, 5)
})

test('热改配置：settings 里把并发改成 2，立即生效（无需重启）', async () => {
  const logFile = tempLog()
  const settings = fakeSettings({ logFile, ...only('stepfun', { concurrency: 5, rpm: 0, tpm: 0 }) })
  const handler = mount({ logFile }, settings.service)
  const downstream = makeDownstream({ chunks: 2, holdMs: 5 })

  const first = await Promise.all(Array.from({ length: 6 }, () => handler(request(), downstream.next)).map(drain))
  assert.equal(first.length, 6)
  assert.equal(downstream.state.peak, 5)

  // 热改到 2（模拟用户编辑 settings.yaml → 设置服务重新解析）
  settings.set({ logFile, ...only('stepfun', { concurrency: 2, rpm: 0, tpm: 0 }) })
  const second = makeDownstream({ chunks: 2, holdMs: 5 })
  await Promise.all(Array.from({ length: 6 }, () => handler(request(), second.next)).map(drain))
  assert.equal(second.state.peak, 2, '新配置必须立刻生效')
})

test('热改配置：限流器在值未变时不被重建（桶状态保留）', async () => {
  const logFile = tempLog()
  const settings = fakeSettings({ logFile, ...only('stepfun', { concurrency: 5, rpm: 10, tpm: 0, safetyMargin: 0 }) })
  const handler = mount({ logFile }, settings.service)
  const downstream = makeDownstream({ chunks: 1, holdMs: 0 })
  await drain(handler(request(), downstream.next))
  await drain(handler(request(), downstream.next)) // 触发几次 sync（值没变）
  settings.set({ logFile, ...only('stepfun', { concurrency: 5, rpm: 10, tpm: 0, safetyMargin: 0 }) })
  await drain(handler(request(), downstream.next))
  const records = readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(records.filter((r) => r.event === 'config-change').length, 0, '值没变就不该有 config-change')
  assert.equal(records.filter((r) => r.event === 'plugin-load').length, 1)
})

test('settings 里的限值真的落到限流器上（含安全余量计算，按 provider 分列）', () => {
  const logFile = tempLog()
  const settings = fakeSettings({ logFile, ...only('stepfun', { concurrency: 5, rpm: 10, tpm: 5000000, safetyMargin: 0.1 }) })
  mount({ logFile }, settings.service)
  const records = readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(records[0].event, 'plugin-load')
  assert.deepEqual(records[0].providers.stepfun.limits, { concurrency: 5, rpmLimit: 9, tpmLimit: 4500000 })
})

test('热改某个 provider：只重建它，另一个 provider 的桶状态保留', async () => {
  const logFile = tempLog()
  const cfg = (duanyanRpm) => ({
    logFile,
    perProvider: {
      stepfun: { rateLimit: { concurrency: 5, rpm: 0, tpm: 0 } },
      duanyan: { perModel: true, rateLimit: { concurrency: 0, rpm: duanyanRpm, tpm: 0, safetyMargin: 0 } },
    },
  })
  const settings = fakeSettings(cfg(60))
  const handler = mount({ logFile }, settings.service)
  const { next } = makeDownstream({ chunks: 1, holdMs: 0 })
  await drain(handler(request('stepfun'), next))
  await drain(handler(request('duanyan', 'intern-s2'), next))

  settings.set(cfg(120)) // 只改 duanyan
  await drain(handler(request('duanyan', 'intern-s2'), next))

  const records = readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const changes = records.filter((r) => r.event === 'config-change')
  assert.equal(changes.length, 1, '只该有一条 config-change')
  assert.equal(changes[0].provider, 'duanyan', '必须只记被改的那个 provider')
  assert.equal(changes[0].rateLimit.rpm, 120)
})

test('节流节奏从 settings 生效：minIntervalMs 让第二个请求排队', async () => {
  const logFile = tempLog()
  const handler = mount({ logFile, log: 'all', ...only('stepfun', { concurrency: 0, rpm: 60, tpm: 0, safetyMargin: 0, minIntervalMs: 250 }) })
  const { next } = makeDownstream({ chunks: 1, holdMs: 0 })
  await drain(handler(request(), next))
  const startedAt = Date.now()
  await drain(handler(request(), next))
  const elapsed = Date.now() - startedAt
  assert.ok(elapsed >= 200, `第二个请求应被最小间隔推迟（实测 ${elapsed}ms）`)
  const records = readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const gates = records.filter((r) => r.event === 'gate')
  assert.equal(gates.length, 2, 'log=all 时两个请求都该有 gate 记录')
  const waited = gates[gates.length - 1]
  assert.ok(waited.waitMs.minIntervalMs >= 200, `最后一条应是等到号的那个，实际 ${JSON.stringify(waited.waitMs)}`)
  assert.equal(waited.model, 'step-5-preview')
})

test('诊断日志：log=throttle 只记被推迟的请求', async () => {
  const logFile = tempLog()
  const handler = mount({ logFile, log: 'throttle', ...only('stepfun', { concurrency: 1, rpm: 0, tpm: 0 }) })
  const { next } = makeDownstream({ chunks: 2, holdMs: 10 })
  await Promise.all(Array.from({ length: 4 }, () => handler(request(), next)).map(drain))
  const records = readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const gates = records.filter((r) => r.event === 'gate')
  assert.ok(gates.length >= 1, '排在后面的请求应被记录（等了槽位）')
  assert.ok(gates.every((g) => g.waitMs.totalMs > 0))
  assert.equal(records[0].event, 'plugin-load', '首行应是加载记录（可用来确认插件何时被装载）')
})

test('设置服务晚就绪：先用 cordis 配置，服务出现后自动切到 settings', async () => {
  const logFile = tempLog()
  const listeners = []
  let injectCallback = null
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(name, handler) {
      listeners.push({ name, handler })
      return () => {}
    },
    inject(deps, callback) {
      assert.deepEqual(deps, ['settings'], '应只注入 settings')
      injectCallback = callback
      return () => {}
    },
    get() {
      return undefined // 此刻设置服务还没出现
    },
  }
  apply(ctx, { logFile, ...only('stepfun', { concurrency: 3, rpm: 0, tpm: 0 }) })
  const handler = listeners.find((l) => l.name === 'llm/stream').handler

  const before = makeDownstream({ chunks: 2, holdMs: 5 })
  await Promise.all(Array.from({ length: 6 }, () => handler(request(), before.next)).map(drain))
  assert.equal(before.state.peak, 3, '服务未就绪时应使用 cordis 配置')

  const settings = fakeSettings({ logFile, ...only('stepfun', { concurrency: 1, rpm: 0, tpm: 0 }) })
  injectCallback({ settings: settings.service })

  const after = makeDownstream({ chunks: 2, holdMs: 5 })
  await Promise.all(Array.from({ length: 4 }, () => handler(request(), after.next)).map(drain))
  assert.equal(after.state.peak, 1, '服务就绪后应立即以 settings 为准')
})
