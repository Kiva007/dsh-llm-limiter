/**
 * 真机端到端验收：用 step-5-preview 真的打 stepfun API，走插件的真实代码路径
 * （apply → llm/stream 监听器 → 限流器 → next() 里发 HTTP）。
 *
 * 验收点：
 *   1. 8 个并发请求全部成功（对照探针：不加限流时 6 并发就会 1 个 429）
 *   2. 下游同时在飞的请求数**从不超过 5**
 *   3. 日志里能看到排队（concurrencyMs > 0），证明限流真的起了作用而不是运气好
 *
 * 运行：node --test test/e2e-stepfun.test.mjs（或 npm run test:e2e）
 * 消耗：8 个小请求（max_tokens=1）；无 STEPFUN_API_KEY 时自动跳过。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

const BASE = 'https://api.stepfun.com/step_plan/v1'
const MODEL = 'step-5-preview'

// Explicit opt-in only: never read a user's local credential files.
const KEY = process.env.STEPFUN_API_KEY?.trim() || null

function mountPlugin(config) {
  const listeners = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(name, handler) {
      listeners.push({ name, handler })
      return () => {}
    },
    get() {
      return undefined // 无设置服务：直接用 cordis 配置（等价于 settings.yaml 段落的解析结果）
    },
  }
  apply(ctx, config)
  return listeners.find((l) => l.name === 'llm/stream').handler
}

/** 真实下游：SSE 流式请求 stepfun，产出 DSH 形状的文本分片。 */
function makeRealDownstream(state, log) {
  return () => {
    state.calls += 1
    return (async function* realStepfunStream() {
      state.active += 1
      state.started += 1
      state.peak = Math.max(state.peak, state.active)
      const startedAt = Date.now()
      try {
        const res = await fetch(`${BASE}/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: true }),
        })
        if (!res.ok) {
          const body = await res.text()
          state.failures.push({ status: res.status, body: body.slice(0, 200) })
          throw new Error(`stepfun HTTP ${res.status}: ${body.slice(0, 200)}`)
        }
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let events = 0
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data:')) continue
            const payload = trimmed.slice(5).trim()
            if (payload === '[DONE]') continue
            events += 1
            yield { type: 'text', text: 'x' }
          }
        }
        state.events += events
        state.ms += Date.now() - startedAt
        log.push({ ms: Date.now() - startedAt, events })
      } finally {
        state.active -= 1
        state.closed += 1
      }
    })()
  }
}

async function drain(stream) {
  let count = 0
  for await (const _chunk of stream) count += 1
  return count
}

test('端到端：8 并发打 step-5-preview，限流下全部成功且并发≤5', { timeout: 300000 }, async (t) => {
  if (KEY === null) {
    t.skip('未显式设置 STEPFUN_API_KEY 环境变量，跳过真机验收')
    return
  }
  const logFile = join(mkdtempSync(join(tmpdir(), 'stepfun-e2e-')), 'limiter.log')
  // 新配置形态：perProvider（键 = pi-ai 路由 id）
  const handler = mountPlugin({
    logFile,
    log: 'all',
    perProvider: { stepfun: { rateLimit: { concurrency: 5, rpm: 10, tpm: 5000000, safetyMargin: 0.1 } } },
  })

  const state = { active: 0, peak: 0, started: 0, closed: 0, calls: 0, events: 0, ms: 0, failures: [] }
  const perCall = []
  const next = makeRealDownstream(state, perCall)
  const request = {
    provider: 'stepfun',
    model: MODEL,
    messages: [{ role: 'user', content: 'ping' }],
    sessionId: 'session-e2e',
  }

  const startedAt = Date.now()
  const counts = await Promise.all(Array.from({ length: 8 }, () => handler(request, next)).map(drain))
  const wallMs = Date.now() - startedAt

  const records = readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const gates = records.filter((r) => r.event === 'gate')
  const waited = gates.filter((g) => g.waitMs.concurrencyMs > 0)

  console.log(
    `\n[e2e] 8 并发 → 成功 ${counts.filter((c) => c > 0).length}/8，下游并发峰值 ${state.peak}，` +
      `429 失败 ${state.failures.length}，总墙钟 ${wallMs}ms，单请求耗时 ${perCall.map((p) => p.ms).join('/')}ms`,
  )
  console.log(`[e2e] 日志：${records.length} 条，其中排队等槽位 ${waited.length} 条，` +
    `最长等待 ${Math.max(0, ...waited.map((w) => w.waitMs.concurrencyMs))}ms`)

  assert.deepEqual(state.failures, [], '不应出现任何 429/失败')
  assert.equal(counts.filter((c) => c > 0).length, 8, '8 个流都应拿到数据')
  assert.equal(state.started, 8)
  assert.equal(state.closed, 8, '每个下游流都应正常关闭')
  assert.equal(state.active, 0)
  assert.ok(state.peak <= 5, `下游并发峰值必须 ≤5，实际 ${state.peak}`)
  assert.equal(state.peak, 5, `应真的用满 5 个并发槽位，实际 ${state.peak}`)
  assert.ok(waited.length >= 3, `应有请求排队等槽位（3 个排在后面），实际 ${waited.length} 条`)
  assert.equal(records[0].event, 'plugin-load')
})
