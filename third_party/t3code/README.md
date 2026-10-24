# t3code 来源与许可

Baton 通过 git submodule `upstream/t3code` 使用 fork [hhubb22/t3code](https://github.com/hhubb22/t3code) 的 `baton` 分支，固定提交 `310cd313322ac093142da52dbdb53cd1bfcd4afd`。该提交基于上游 [pingdotgg/t3code](https://github.com/pingdotgg/t3code) 的 `9828cad49f3e1ef4f9e037b3baaca19f4e4928fc`。上游 MIT 许可和 `Copyright (c) 2026 T3 Tools Inc.` 保留在 [LICENSE](LICENSE)。

workspace 收录这些包：`provider-core`、`provider-pi`、`provider-acp`、`provider-acp-registry`、`provider-cursor`、`provider-codex`、`provider-testing`、`contracts`、`shared`、`effect-acp`、`effect-codex-app-server`。`effect-acp` 与 `effect-codex-app-server` 使用 fork 里的同名包。`packages/providers` 与 `packages/provider-testing` 仍是 Baton 本地的 Cursor SDK 抽取。

## 补丁

固定提交相对上游基线只包含 Codex 适配器拆包，协议行为保持原样。`effect-codex-app-server` 里的生成 schema 仍是上游客户端；官方 Codex 协议的 Apache 2.0 许可和署名在 [CODEX-LICENSE](CODEX-LICENSE)、[CODEX-NOTICE](CODEX-NOTICE)。

| 改动 | 说明 |
|---|---|
| `packages/provider-codex` | `CodexAdapterV2` 及其测试、会话参数、启动参数、用量、主目录布局、开发者说明、MCP elicitation、线程回滚和文本合并从 `apps/server` 移入该包 |
| 共享辅助 | 适配器使用的附件路径留在 `provider-codex`，图片扩展名和事件日志裁剪留在 `provider-core`；`apps/server` 原路径再导出这些符号 |
| 附件目录 | 创建适配器时从 `ProviderHost.paths.attachmentsDir` 读取。线上 host 仍由同一份 `ServerConfig` 构建 |
| 服务标识 | `CodexAppServerClientFactory` 的标识改为包路径，以通过确定性 key 检查 |
| Effect 4.0.6 类型 | `nodeSqliteClient` 给 `SqlClient.make` 补上 `driver: "node:sqlite"`，worker 的 `error` 回调按 `unknown` 读取 `message`。`provider-pi` 的类型检查不跟随测试里的 `client-runtime` 相对导入 |
| `provider-testing` 测试脚本 | 包内没有测试文件。补上与其他包相同的 `vp test` 脚本，没有匹配文件时退出码为 0 |
| `packages/provider-cursor/src/testing` | Cursor 回放转录 Schema、确定性回放 runner、录制函数与六份离线转录从 `apps/server/src/orchestration-v2/Adapters/CursorAdapterV2.testkit.ts` 移入该包，新增 `./testing` 与 `./testing/replay` 导出；`apps/server` 原路径改为再导出，注册表相关的 layer 与 harness 留在应用内 |

## 版本

这些包用 `catalog:` 引用依赖，因此解析到 Baton 根 catalog。上游 catalog 里的 `effect` 与 `@effect/*` 是 `4.0.5`，`vite-plus` 是 `1.3.0`，`@types/node` 是 `24.12.4`，`typescript` 是 `@tsc-rs/typescript@0.8.0`。Baton catalog 把它们统一为 `effect` / `@effect/*` `4.0.6`、`vite-plus` `1.4.0`、`@types/node` `26.6.5`、`typescript` `6.0.3`。

`@t3tools/shared` 和 provider 包还引用 Baton 原来没有的 catalog 项。这些项按上游 catalog 补进根 catalog：`@noble/curves@1.9.1`、`@noble/hashes@1.8.0`、`jose@6.2.2`、`yaml@^2.9.0`，以及 `unified`、`remark-*`、`rehype-*`、`micromark-*`、`mdast-util-directive`。`@cursor/sdk` 在两边都是 `1.0.35`。数学 Markdown 沿用上游的 `micromark-extension-llm-math@3.1.0` 替换和 `upstream/t3code/patches` 里的 `mdast-util-math`、`micromark-extension-llm-math`、`micromark-extension-gfm-table` 补丁，否则 `shared` 的离线解析测试对不上。

这些包的 `test` 脚本由 `pnpm test` 执行，只用离线夹具和本地替身。`@t3tools/provider-testing` 没有测试文件，脚本在没有匹配文件时通过。Baton 的格式和 lint 不改写 `upstream/t3code`。

## 仍在本仓库的抽取

| 上游路径 | 本仓库路径 | 使用方式 |
|---|---|---|
| `packages/shared/src/nodeSqliteClient.ts` | `packages/sqlite/src/index.ts` | 参考连接、SqlClient、串行事务和 SQLite 错误适配实现；使用 FULL 同步、逐次 prepare 和单连接，不引入上游 reader/checkpoint worker |
| `packages/provider-cursor/src/server/{CursorAgentSdk,CursorSdk,sdk}.ts` 与相关测试 | `packages/providers/src/cursor/server/` | 抽取 SDK runner、异常处理与磁盘 SDK loader，保留选定模块测试并应用 Baton 差异 |
| `packages/contracts/src/{baseSchemas,providerInstance}.ts`、`packages/provider-core/src/server/ProviderEventLoggers.ts` | `packages/providers/src/upstream/` | 保留 runner 必需的 branded ID 与日志 service |
| `packages/provider-cursor/src/server/adapter.ts` | `packages/providers/src/cursor/index.ts` | 抽取 `textFromAgentMessage`；Baton 策略 wrapper 在相同入口导出 |
| `apps/server/src/orchestration-v2/Adapters/CursorAdapterV2.testkit.ts` 与选定 SDK 转录 | `packages/provider-testing/` | 抽取 SDK 回放 runner，保留六份原始转录，测试驱动真实 SDK 封装 |

逐文件来源与引入时的 SHA-256 记录在 [sources.json](sources.json)。`kind=copy` 条目给出上游文件与本地文件的对应路径，`kind=derived` 标记 SQLite 实现的参考来源。Baton 新增的测试和许可文件不冒充上游文件。

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
