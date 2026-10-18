/**
 * 预检：确认这台机器上插件能真正加载（依赖解析 → 模块导入 → schema 解析）。
 * 用法：node scripts/check-env.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const problems = []
const lines = []
const ok = (msg) => lines.push(`  ok   ${msg}`)
const bad = (msg, hint) => {
  lines.push(`  FAIL ${msg}`)
  if (hint !== undefined) lines.push(`       → ${hint}`)
  problems.push(msg)
}

lines.push(`插件目录: ${root}`)

// 1) 依赖：schemastery 必须可解析（settings 注册要用它的 schema）
const schemaLink = join(root, 'node_modules', '@deepseek-ai', 'schemastery')
if (!existsSync(schemaLink)) {
  bad(
    'node_modules/@deepseek-ai/schemastery 不存在',
    '建目录联接：New-Item -ItemType Junction -Path "<插件>/node_modules/@deepseek-ai/schemastery" -Target "<DSH 安装目录>/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/schemastery"',
  )
} else {
  try {
    const pkg = JSON.parse(readFileSync(join(schemaLink, 'package.json'), 'utf8'))
    ok(`schemastery 可解析（${pkg.version}）`)
  } catch (error) {
    bad(`schemastery 联接坏了：${String(error.message)}`, '删除后重建目录联接')
  }
}

// 2) 模块本身能导入
let mod = null
try {
  mod = await import('../lib/index.js')
  ok(`lib/index.js 导入成功（name=${mod.name}）`)
} catch (error) {
  bad(`lib/index.js 导入失败：${String(error.message)}`)
}

// 3) schema 能解析出默认值（泛化后是中性默认：不限任何 provider）
if (mod !== null) {
  try {
    const resolved = mod.Config({})
    const providers = resolved.perProvider ?? {}
    if (Object.keys(providers).length !== 0) {
      bad(`默认 perProvider 应为空，实际 ${JSON.stringify(providers)}`, '检查 lib/index.js 的 Config schema')
    } else {
      ok(`Config 默认值解析正常（perProvider 空 = 不限流；各 provider 限值在 settings.yaml 显式配置）`)
    }
  } catch (error) {
    bad(`Config schema 解析失败：${String(error.message)}`)
  }
}

// 4) profile 里有没有挂上（只为提示，不作为失败）
const profilePkg = join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'web', 'package.json')
if (existsSync(profilePkg)) {
  const text = readFileSync(profilePkg, 'utf8')
  const inDeps = text.includes('"dsh-llm-limiter"')
  const inBundles = /"dsh-llm-limiter"(?!\s*:)/.test(text)
  lines.push(`  info web profile：dependencies ${inDeps ? '已含' : '未含'}，bundles ${inBundles ? '已含' : '未含'}`)
  const legacy = text.includes('"dsh-llm-stepfun-limiter"')
  if (legacy) lines.push('  warn web profile 仍引用旧包名 dsh-llm-stepfun-limiter（2026-10-02 已改名 dsh-llm-limiter，需迁移）')
}

console.log(lines.join('\n'))
if (problems.length > 0) {
  console.log(`\n预检失败（${problems.length} 项）。修好后重跑本脚本。`)
  process.exit(1)
}
console.log('\n预检通过：插件可以加载。')
