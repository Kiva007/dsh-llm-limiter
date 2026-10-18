# dsh-llm-limiter

为 DeepSeek Harness (DSH) 的 pi-ai provider 提供客户端限流。插件挂在 `llm/stream` 瀑布上，在取得配额与并发槽位后才调用下游；不修改内置 `dsh-llm-pi-ai`。

支持按 provider 或按模型分桶、并发上限、RPM、TPM、最小请求间隔、等待取消，以及配置热更新。

## 安装

需要 Node.js（建议 22 或更新版本）、npm，以及支持 `llm/stream` 和 bundle patch 的 DSH。不同 DSH 版本的插件管理命令及设置存储位置可能不同，请以对应版本文档为准。

```sh
git clone https://github.com/Kiva007/dsh-llm-limiter.git
cd dsh-llm-limiter
npm install
npm test
```

### 选择实际运行的 profile

**新版桌面端使用 `desktop`，不是 `web`。** 两个 profile 的依赖、bundles 和配置互相独立；装进 `web` 不会让桌面端加载插件。把示例路径替换成实际的 clone 目录，并选择与你运行方式匹配的命令：

```sh
# 桌面端：使用该桌面版配套的 DSH CLI（如安装目录下的 runtime/cli/bin/dsh.cmd）
dsh plugin --profile desktop add "link:/absolute/path/to/dsh-llm-limiter"

# 独立 Web 服务：仅在你实际运行 dsh web 时使用
dsh plugin --profile web add "link:/absolute/path/to/dsh-llm-limiter"
```

不要默认使用 PATH 中另一版本的 CLI 管理桌面 profile。桌面 profile 由 Electron 宿主管理，普通运行命令不一定允许 `--profile desktop`；这里的 `plugin ... add` 是插件管理命令，不是用 CLI 启动 desktop 宿主。

确认**所选 profile** 的 `dsh.profile.bundles` 包含 `dsh-llm-limiter`，由 bundle patch 挂载插件。初次装载或更新源码后重启对应宿主（桌面端重启桌面应用，Web 端重启对应 Web 服务）；不要再手工插入同 ID 的 Cordis 行。

### 已验证 DSH 版本

| DSH 版本 | 运行环境 | 验证范围 |
|---|---|---|
| **0.2.0-rc.2** | Windows 桌面端，`desktop` profile | 插件装载、`llm/stream` 限流链路、profile patch 配置读取，以及真实请求的 per-model 分桶日志 |

这是已确认的运行环境，不代表所有 `0.2.x`、后续正式版或其它平台都已验证。公开快照另通过 35 项离线核心/插件集成测试；离线测试不等于宿主版本兼容性测试。

`@deepseek-ai/schemastery` 是 peer dependency。`npm install` 可安装该依赖；若宿主要求共享同一 schema 实例，请按对应 DSH 版本的依赖管理方式处理。

## 配置

**DSH 0.2.0-rc.2 桌面端**：在 `desktop` profile 的插件设置页配置，或在该 profile 的 `cordis.patch.yml` 中更新既有 entry（不要重复插入）：

```yaml
- id: dsh-llm-limiter
  config:
    enabled: true
    log: throttle
    perProvider:
      example-provider:
        rateLimit:
          concurrency: 5
          rpm: 50
```

`0.2.0-rc.2` 已没有旧的 `settings.register` API，本插件会使用 entry 的 `config`；不能把旧版 `llm-limiter` 命名空间的热更新机制视为已在新版验证。手工改 patch 后请重启对应宿主并核对装载日志。

**旧版设置服务**：使用 `settings.yaml` 的 `llm-limiter` 命名空间。下面展示完整字段；用于新版 profile patch 时，将 `llm-limiter:` 下的字段放到上述 `config:` 内，而不是继续编辑全局 `settings.yaml`。

```yaml
llm-limiter:
  enabled: true
  log: throttle           # off | throttle | all
  logFile: ""             # 默认 DSH_HOME/logs/llm-limiter.log
  perProvider:
    example-provider:     # 替换成实际 pi-ai provider 路由 ID
      enabled: true
      perModel: false     # true：每个模型独立限流
      rateLimit:
        concurrency: 5
        rpm: 50
        tpm: 0
        safetyMargin: 0.1
        minIntervalMs: 0
        assumedMaxTokens: 32768
```

**以上数值仅是示例，不是任何供应商当前配额的保证。** 请根据自己的端点、套餐和官方限额配置。没列出的 provider 完全透传；默认 `perProvider` 为空，不会自动限制任何 provider。所有维度 `0` 表示不限制。

- `perModel: false`：同 provider 所有模型共用配额，适合 provider 级限额。
- `perModel: true`：每个 `<provider>/<model>` 独立计数，适合按模型计费或限流的端点；这时并发也是每模型上限，而不是 provider 总上限。
- `safetyMargin` 只作用于 RPM/TPM，有效值为 `floor(限值 × (1 − margin))`，不折减并发。
- 未变更配置的 provider 保留桶状态；限流配置真正变化时才重建对应 provider 的桶。

## 工作方式

四层闸门依次执行：

1. 最小间隔：先预订发车时刻再等待。
2. TPM：线性补充令牌桶，估算成本为 `ceil(输入字符数 / 4) + 输出上限`。
3. RPM：线性补充令牌桶，每次请求消耗一个令牌。
4. 并发：FIFO 信号量，从取得槽位一直持有到响应流结束。

下游 `next()` 在取得槽位后才调用。消费方提前退出时，插件向下游传播关闭并释放槽位。等待支持 `AbortSignal`。

## 诊断与隐私

默认日志路径：`$DSH_HOME/logs/llm-limiter.log`；未设置 `DSH_HOME` 时为 `~/.dsh/logs/llm-limiter.log`。日志超过 5 MB 后轮转一次，保留 `.1`。

事件包括 `plugin-load`、`config-change`、`gate`、`stream-done`、`stream-error`、`acquire-aborted`。装载、配置变更和部分错误也会写 stdout。

**运行日志可能含 provider/model ID、session ID、进程 ID、限额、等待时间和下游原始错误文本；下游错误可能含敏感信息。** 插件不主动记录消息正文或 API key，但分享日志前仍须人工脱敏，不要把日志提交到 Git。`log: off` 不等于完全禁用所有诊断：启动和部分控制事件仍可能写文件或 stdout。

本仓库不包含本机配置、凭据、会话、日志或内部探测产物。API key 由 DSH provider 配置管理，不应放在限流配置中。

## 测试

```sh
npm test                  # 离线核心与插件集成测试，不请求真实 API
npm run check             # 本机依赖/schema 预检，可显示本机路径
node scripts/sim-fanout.mjs
npm run test:e2e           # 真机测试：仅显式设置 STEPFUN_API_KEY 时才请求 API
```

真机测试默认跳过，不读取任何本地凭据文件。主动设置 `STEPFUN_API_KEY` 后，会向测试中指定的 Step Plan 端点发送 8 个小请求，可能消耗套餐配额；运行前应核对端点和模型是否仍可用。不要在 shell 历史、截图或日志中暴露 key。

## 边界

- 只在进程内共享计数，多个 DSH 进程不会共享配额。
- RPM/TPM 是允许初始突发的令牌桶，不是严格滑动窗口；上游仍可能返回 429。
- 新建或重建桶时回满；热更新期间旧请求仍可能持有旧桶槽位。
- 单请求估算成本超过容量时按整桶扣除；TPM 估算不能代替上游 tokenizer。
- 预扣不退：失败请求与重试仍消耗桶额度。
- 未拦截的适配器、直连脚本及其它程序不受本插件限制。

## 许可

MIT，见 [LICENSE](LICENSE)。本包保留 `private: true`，防止误发 npm；不影响 GitHub 安装和使用。
