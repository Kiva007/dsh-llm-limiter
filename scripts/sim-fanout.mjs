/**
 * 并发扇出模拟：回答"放开 RPM/TPM 到底有没有用"
 *
 * 用虚拟时钟跑真实的 StepfunRateLimiter（sleep 只推进时钟，不真的等），
 * 这样同一套限流逻辑可以在毫秒内模拟出几分钟的排队行为。
 *
 * 用法：node scripts/sim-fanout.mjs
 */
import { StepfunRateLimiter } from '../lib/rate-limiter.js'

function virtualClock() {
  let now = 0
  return {
    now: () => now,
    sleep: async (ms) => {
      now += ms
    },
  }
}

/**
 * @param label - 场景名
 * @param rateLimit - 限流配置
 * @param requests - 同时发起的请求数（模拟 workflow 扇出 N 个子代理）
 * @param cost - 每个请求的预估 token 成本
 * @param callMs - 单次调用耗时（占着并发槽位的时长）
 */
async function simulate({ label, rateLimit, requests, cost, callMs }) {
  const clock = virtualClock()
  const limiter = new StepfunRateLimiter(rateLimit, clock)
  const started = []
  await Promise.all(
    Array.from({ length: requests }, async () => {
      const release = await limiter.acquire({ estimatedTokens: cost })
      started.push(clock.now())
      await clock.sleep(callMs)
      release()
    }),
  )
  started.sort((a, b) => a - b)
  const wallMs = clock.now()
  return {
    场景: label,
    总墙钟: `${(wallMs / 1000).toFixed(1)}s`,
    首个请求等: `${started[0]}ms`,
    中位请求等: `${started[Math.floor(started.length / 2)]}ms`,
    最后一个请求等: `${(started[started.length - 1] / 1000).toFixed(1)}s`,
  }
}

const CONCURRENCY_ONLY = { concurrency: 5, rpm: 0, tpm: 0, safetyMargin: 0, assumedMaxTokens: 32768 }
const CURRENT = { concurrency: 5, rpm: 10, tpm: 5000000, safetyMargin: 0.1, assumedMaxTokens: 32768 }

const scenarios = [
  { label: '扇出 8 个子代理（小上下文 35K），每次调用 5s', requests: 8, cost: 35000, callMs: 5000 },
  { label: '扇出 20 个子代理（小上下文 35K），每次调用 5s', requests: 20, cost: 35000, callMs: 5000 },
  { label: '扇出 20 个大上下文请求（209K，主会话量级），每次 10s', requests: 20, cost: 209158, callMs: 10000 },
]

console.log('限流配置对比：当前（rpm 10 / tpm 5M / 余量 0.1） vs 只留并发 5\n')
for (const scenario of scenarios) {
  const rows = []
  for (const [label, config] of [
    ['当前设置', CURRENT],
    ['只留并发', CONCURRENCY_ONLY],
  ]) {
    rows.push(await simulate({ label: `${label}`, rateLimit: config, ...scenario }))
  }
  console.log(`### ${scenario.label}`)
  console.table(rows)
  console.log('')
}
