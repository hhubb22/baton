# t3code 来源与许可

Baton 通过 git submodule `upstream/t3code` 使用 fork [hhubb22/t3code](https://github.com/hhubb22/t3code) 的 `baton` 分支，固定提交 `f9011c0473aded7eaa9bb703fd04dd296d02fdf3`。该提交基于上游 [pingdotgg/t3code](https://github.com/pingdotgg/t3code) 的 `9828cad49f3e1ef4f9e037b3baaca19f4e4928fc`。上游 MIT 许可和 `Copyright (c) 2026 T3 Tools Inc.` 保留在 [LICENSE](LICENSE)。

workspace 收录这些包：`provider-core`、`provider-pi`、`provider-acp`、`provider-acp-registry`、`provider-antigravity`、`provider-cursor`、`provider-codex`、`provider-testing`、`contracts`、`shared`、`effect-acp`、`effect-codex-app-server`。`effect-acp` 与 `effect-codex-app-server` 使用 fork 里的同名包。Cursor 适配器直接使用 `provider-cursor` 的 `makeCursorAdapterV2`。

## 补丁

固定提交包含下表中的适配器拆包、导出、Kiro / Antigravity / Droid ACP 接入补丁。Pi、Codex、Cursor 的协议行为沿用上游实现。`effect-codex-app-server` 里的生成 schema 仍是上游客户端；官方 Codex 协议的 Apache 2.0 许可和署名在 [CODEX-LICENSE](CODEX-LICENSE)、[CODEX-NOTICE](CODEX-NOTICE)。

| 改动 | 说明 |
|---|---|
| `packages/provider-codex` | `CodexAdapterV2` 及其测试、会话参数、启动参数、用量、主目录布局、开发者说明、MCP elicitation、线程回滚和文本合并从 `apps/server` 移入该包 |
| 共享辅助 | 适配器使用的附件路径留在 `provider-codex`，图片扩展名和事件日志裁剪留在 `provider-core`；`apps/server` 原路径再导出这些符号 |
| 附件目录 | 创建适配器时从 `ProviderHost.paths.attachmentsDir` 读取。线上 host 仍由同一份 `ServerConfig` 构建 |
| 服务标识 | `CodexAppServerClientFactory` 的标识改为包路径，以通过确定性 key 检查 |
| Effect 类型 | `nodeSqliteClient` 以 spread 传入 `driver: "node:sqlite"`，同时通过 Effect 4.0.5 与 4.0.6 检查；worker 的 `error` 回调按 `unknown` 读取 `message`。`provider-pi` 的类型检查不跟随测试里的 `client-runtime` 相对导入 |
| `provider-testing` 测试脚本 | 包内没有测试文件。补上与其他包相同的 `vp test` 脚本，没有匹配文件时退出码为 0 |
| `packages/provider-cursor/src/testing` | Cursor 回放转录 Schema、确定性回放 runner、录制函数与六份离线转录从 `apps/server/src/orchestration-v2/Adapters/CursorAdapterV2.testkit.ts` 移入该包，新增 `./testing` 与 `./testing/replay` 导出；`apps/server` 原路径改为再导出，注册表相关的 layer 与 harness 留在应用内 |
| `packages/provider-cursor/src/server.ts` | 导出 `makeCursorAdapterV2` 与 `CursorAdapterV2Options`，供 Baton 的 agent-host 直接构造 adapter |
| `packages/provider-pi/src/testing`、`packages/provider-codex/src/testing` | Pi RPC 回放 spawner、录制函数与 Codex 回放客户端工厂从 `apps/server` 的 testkit 移入各包，新增 `./testing` 导出；`apps/server` 原路径再导出，注册表 layer 与 harness 留在应用内 |
| `packages/provider-pi` 导出 | `./server` 导出 `makePiAdapterV2` 与 `PiAdapterV2Options`，新增 `./server/status` 导出 `checkPiProviderStatus`，供 agent-host 构造 adapter 和做只读探测 |
| `packages/provider-codex/src/server/status.ts` | `CodexProvider.ts` 与原有模型、状态检查测试从 `apps/server` 移入该包，新增 `./server/status` 导出；原路径再导出，Baton 的 Codex 探测直接调用 `checkCodexProviderStatus` |
| Kiro ACP | `provider-acp-registry` 新增 `kiroAcp.ts`、Kiro CLI 2.32.0 离线夹具与转换脚本。具体模型由 `session/new` 的 `_meta.kiro.modelId` 选择；恢复先按会话 ID 和工作目录检查 `session/list`，再 `session/load`，缺失直接失败。禁用插入、会话内换模型和 fork |
| Antigravity ACP | 提取 `packages/provider-antigravity` 为独立包，供 Baton 直接连接本机 `agy acp` |
| Droid ACP | `provider-acp-registry` 扩展 `droidAcp.ts`，识别 `factory-droid` 与 `droid` CLI，映射运行模式（`spec`、`normal`、`auto-high`），解析 `AskUser` 表单并启用 `failClosedOnSessionLoad` |
| 共享 ACP 扩展 | 增加可选的 `newSessionMeta`、`beforeLoadSession`、`followAdvertisedModelSwitch`、`followAdvertisedFork`、`failClosedOnSessionLoad`、`extractElicitationForm` 与 `sessionModeForPolicy` |
| ACP 包导出与回放 | `provider-acp-registry` 的 `./server` 导出 adapter 构造器，`./server/status` 导出只读检查，`./testing/replay` 提供 ACP 回放 spawner 与 runtime；回放执行程序和 Kiro 测试移入包内，应用原路径复用包实现 |
| fork 类型检查 | 补齐 `CursorAdapterV2.testkit` 再导出，并使 `nodeSqliteClient` 的 driver 参数同时通过 fork 的 Effect 4.0.5 与 Baton 的 4.0.6 类型检查 |

## 版本

这些包用 `catalog:` 引用依赖，因此解析到 Baton 根 catalog。上游 catalog 里的 `effect` 与 `@effect/*` 是 `4.0.5`，`vite-plus` 是 `1.3.0`，`@types/node` 是 `24.12.4`，`typescript` 是 `@tsc-rs/typescript@0.8.0`。Baton catalog 把它们统一为 `effect` / `@effect/*` `4.0.6`、`vite-plus` `1.4.0`、`@types/node` `26.6.5`、`typescript` `6.0.3`。

`@t3tools/shared` 和 provider 包还引用 Baton 原来没有的 catalog 项。这些项按上游 catalog 补进根 catalog：`@noble/curves@1.9.1`、`@noble/hashes@1.8.0`、`jose@6.2.2`、`yaml@^2.9.0`，以及 `unified`、`remark-*`、`rehype-*`、`micromark-*`、`mdast-util-directive`。`@cursor/sdk` 在两边都是 `1.0.35`。数学 Markdown 沿用上游的 `micromark-extension-llm-math@3.1.0` 替换和 `upstream/t3code/patches` 里的 `mdast-util-math`、`micromark-extension-llm-math`、`micromark-extension-gfm-table` 补丁，否则 `shared` 的离线解析测试对不上。

这些包的 `test` 脚本由 `pnpm test` 执行，只用离线夹具和本地替身。`@t3tools/provider-testing` 没有测试文件，脚本在没有匹配文件时通过。Baton 的格式和 lint 不改写 `upstream/t3code`。
