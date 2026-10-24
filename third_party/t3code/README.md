# t3code 来源与许可

来源仓库为 [pingdotgg/t3code](https://github.com/pingdotgg/t3code)，固定提交为 `9828cad49f3e1ef4f9e037b3baaca19f4e4928fc`。上游 MIT 许可和 `Copyright (c) 2026 T3 Tools Inc.` 保留在 [LICENSE](LICENSE)，引入包也携带该许可。

| 上游路径 | 本仓库路径 | 使用方式 |
|---|---|---|
| `packages/effect-acp/` | `packages/effect-acp/` | 保留目录与源码，调整包脚本和开发依赖以使用本仓库的 TypeScript、Vitest 和 ESLint |
| `packages/effect-codex-app-server/` | `packages/effect-codex-app-server/` | 保留目录与客户端源码，调整工具配置，固定 Codex 生成来源并重新生成 schema |
| `packages/shared/src/nodeSqliteClient.ts` | `packages/sqlite/src/index.ts` | 参考连接、SqlClient、串行事务和 SQLite 错误适配实现；使用 FULL 同步、逐次 prepare 和单连接，不引入上游 reader/checkpoint worker |
| `packages/provider-cursor/src/server/{CursorAgentSdk,CursorSdk,sdk}.ts` 与相关测试 | `packages/providers/src/cursor/server/` | 抽取 SDK runner、异常处理与磁盘 SDK loader，保留选定模块测试并应用 Baton 差异 |
| `packages/contracts/src/{baseSchemas,providerInstance}.ts`、`packages/provider-core/src/server/ProviderEventLoggers.ts` | `packages/providers/src/upstream/` | 保留 runner 必需的 branded ID 与日志 service |
| `packages/provider-cursor/src/server/adapter.ts` | `packages/providers/src/cursor/index.ts` | 抽取 `textFromAgentMessage`；Baton 策略 wrapper 在相同入口导出 |
| `apps/server/src/orchestration-v2/Adapters/CursorAdapterV2.testkit.ts` 与选定 SDK 转录 | `packages/provider-testing/` | 抽取 SDK 回放 runner，保留六份原始转录，测试驱动真实 SDK 封装 |

逐文件来源与引入时的 SHA-256 记录在 [sources.json](sources.json)。`kind=copy` 条目给出上游文件与本地文件的对应路径，`kind=derived` 标记 SQLite 实现的参考来源。Baton 新增的测试和许可文件不冒充上游文件。

两个上游包的运行时依赖只有 `effect`。catalog 将 `effect`、`@effect/platform-node`、`@effect/sql-pg`、`@effect/vitest`、生成器所用 `@effect/openapi-generator` 固定为 `4.0.6`。上游源码和测试使用自己的格式；本仓库的格式检查跳过这两个引入目录，生成器显式调用包内 Prettier ignore 文件。

## Codex schema 基线

上游生成脚本原先固定 `openai/codex` 提交 `687a119f0fcaace47e1f1abcc77cec6c813fd6da`。Baton 的生成脚本固定到官方 tag `rust-v0.162.1` 的提交 `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`，从该提交的 `codex-rs/app-server-protocol/schema/{json,typescript}` 重新生成 `src/_generated/{schema,meta,namespaces}.gen.ts`。官方 Codex 的 Apache 2.0 许可和署名保留在 [CODEX-LICENSE](CODEX-LICENSE)、[CODEX-NOTICE](CODEX-NOTICE)；t3code 的 MIT 许可适用于引入的客户端与生成器代码。

兼容核查使用 Baton 现有 `internal/agent/codex/testdata/replay/*.ndjson` 中标记为 `agent_version=0.162.1` 的 9 个录制场景，提取 642 个成功响应及通知，保存为包内的 `test/fixtures/baton-codex-0.162.1.json`，避免依赖未来将删除的 Go 测试目录。夹具中每个条目保留原场景文件名与 label。`src/baton-compat.test.ts` 按生成方法表解码全部帧，覆盖 initialize、thread/start/read/resume、turn/start/steer/interrupt 及录制中的各类通知。

Go 的 `internal/agent/replay/normalize.go` 会删除 initialize 响应的 `platformFamily`、`platformOs`。这两个字段在官方 0.162.1 JSON Schema 中为必填，测试仅为这 10 个脱敏响应补上 `unix`、`macos`，其余 632 个帧按录制原文解码。原引入 schema 在这一处理后可解码上述全部帧；重新生成后的 schema 同样通过。该结论覆盖现有录制使用的协议，不代表所有 Codex API 或真实 Agent 场景已经验证。原有上游 26 项 Codex 测试继续运行。

生成器保留上游的 JSON Schema 规范化、引用转换与方法表生成逻辑，新增 `--source` 以直接读取本机固定提交的 `app-server-protocol` 目录，避免每个 schema 都请求 GitHub API。未传入时仍读取固定提交的 GitHub 文件。格式化命令使用 Prettier。

```sh
pnpm --filter effect-codex-app-server generate --source /absolute/path/to/codex/codex-rs/app-server-protocol
pnpm --filter effect-codex-app-server typecheck
pnpm --filter effect-codex-app-server test
```

`--source` 目录应来自上面固定的提交。重新生成并不调用模型，也不要求登录 Codex。

## Cursor SDK 复用

`@baton/providers` 的运行依赖为 `effect` 和 `@cursor/sdk@1.0.35`，`@baton/provider-testing` 依赖实际 workspace 包名 `@baton/providers`。测试使用仓库统一的 TypeScript、Vitest、`@effect/vitest` 与 `@effect/platform-node`。包接口与宿主示例见 [providers README](../../packages/providers/README.md)，回放接口见 [provider-testing README](../../packages/provider-testing/README.md)。SDK 自身的许可及平台依赖见 [Cursor SDK 来源](../cursor-sdk/README.md)。

完整 provider 的实际尝试使用固定的本机上游检出，运行命令为 `cd packages/providers && ../../node_modules/.bin/vitest run --config reuse-attempt/vitest.config.mjs`。临时配置将 `@t3tools/*` exports 映射到固定上游源码、Effect 映射到本仓库安装，`vite-plus/test` 映射到 Vitest；入口包括原始 `driver.test.ts`、`adapter.test.ts`，以及使用临时私有目录、实际文件系统、固定 settings 和磁盘 credentials 的完整 CursorDriver 宿主测试。加载到真实 provider 后，adapter 测试报 `Cannot find package 'yaml'`，driver 与宿主入口报 SDK loader 的 `Cannot find module '@cursor/sdk'`（上游检出没有安装依赖）。三个 suite 均未进入测试执行，不能记作完整 provider 通过。按任务边界，尝试源码已移除。

完整 driver 的声明依赖是 `@cursor/sdk`、`@napi-rs/keyring`、`yaml`、`@t3tools/{contracts,provider-core,shared}` 和 `effect`，测试另需 `@t3tools/provider-testing`。源码核查确认：driver 创建 credential store、浏览器认证 controller、账号用量和 managed provider snapshot；adapter 引入 MCP session、T3 orchestration instructions、runtime instructions、ID allocator、执行节点、子任务 projection、附件、技能发现和配置变更。保留完整 driver 需要带入这些超出 Baton 宿主边界的运行逻辑。本包采用规格允许的 SDK/runtime 抽取路线，没有复制登录、keyring 或 T3 orchestrator。

保留的上游模块为 `CursorAgentSdk`、`CursorSdk`、SDK loader、日志 service、所需 ID schema、消息正文提取函数，以及 SDK 回放 runner。原 `CursorSdk.test.ts` 的两个异常处理测试保持断言；`CursorAgentSdk.test.ts` 原有的 resume 冲突测试改为断言单次 send、无 listRuns/cancelRun，与 Baton 的输入不重放约束一致。新增测试只覆盖所需策略、独立 store/历史、取消与缓存边界。

局部差异如下：

- 移除 resume 后 active-run conflict 的自动 listRuns、cancelRun 和再次 send；冲突直接返回错误。
- Baton runner 要求显式 API key 与本地 runtime，固定 `autoReview: true`、sandbox 开启和 `enableAgentRetries: false`。原始 runner 保留上游选项形状，供原始转录验证。
- session 历史补传 open 时的 store；新增 detached `listMessages(nativeId, {cwd, store?})`，直接调用静态 SDK messages.list，不 open/resume/send。
- Baton wrapper 缓存 close、cancel 和 wait；取消响应不生成运行终态，没有上游 adapter 的十秒 finalizeTurn 路径。
- 句柄建立前的 pendingUpdates 和之后的待处理 callback 均限制为 256；溢出或 callback 失败以 `run.onDelta` 失败传播，不能合成停止。
- SDK service 与 loader 分开，类型/runner 入口不加载 SDK。loader 在 SEA 中从可执行文件旁使用 createRequire，源码中从 import.meta.url 加载完整磁盘 SDK。
- `inspectCursorSdk` 从解析后的 entry 向上查找 SDK 根元数据，读取实际版本、Node 要求、平台版本与资产路径；跳过只有 type 的内部 package.json。它不启动 SDK/helper，执行检查由宿主负责。

六份原始转录覆盖 simple、multi_turn、provider_thread_resume、turn_interrupt_mid_tool、tool_call_read_only、subagent，文件内容未改。回放驱动提取自上游 `CursorAdapterV2.testkit.ts`，在原生 SDK 边界替换调用后执行真实 `makeCursorAgentSdkRunner`，比较全部 SDK 出站调用和回调顺序。中断等待录制的 tool-call-started 事件；native agent/run ID 和运行结果保持原文。转录声明的是协议版本 1，未携带精确的录制 SDK 版本，不能用上游当前 package.json 的 1.0.35 补造该字段。转录中的 retries/full-access 参数只用于复验原始模块，Baton 配置策略另外测试。

适配器行为验证仅使用选定的上游离线模块测试、六份原始 SDK 静态转录、确定性回放和本地替身，覆盖 runner、异常处理、显式凭据传递、禁用重试与取消后等待终态。store、非空独立历史、多轮执行、输入去重、跨进程恢复和 Worker 回收使用本地 SDK / RPC 替身与账本断言；凭据传递使用虚构值，测试与验证脚本禁止依赖真实 API Key、在线模型推理或外部真实服务。静态 inspection 提供 SDK/平台版本、Node 要求及缺失资产，不启动 SDK/helper。执行策略与本地平台检查范围见 [Agent 适配设计](../../specs/agent-adapters/TECH.md) 和 [本地 Thread 文档](../../apps/batond/README.md)。
