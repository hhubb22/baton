# 协议静态基线来源

本目录的三个 JSON 是协议测试直接读取的静态资产，保留原始排版、`go-` 文件名和来源元数据。更新协议时以 TS Schema、调用方和独立样例验证当前契约；保留的基线用于核对字段与传输值。

## 来源版本

原始导出器和夹具收录于 Baton 提交 `c42c6e04d7caa230bbd560c57cf73335b57bd616`。`go-http-node.json`、`go-worker.json` 的当前内容来自提交 `5b3d2d77e68937dc67d2663640e3b945192f49de`，其中移除了设备原生历史结构和返回字段。`go-migration.json` 保持原始收录内容。

以下路径、函数名和 Go 类型名用于查询上述版本的 Git 历史。夹具内的 `source`、`go_name`、`go_type` 也保留这一用途。

| 文件 | 历史导出入口 | 内容 |
| --- | --- | --- |
| `go-http-node.json` | `internal/httpapi/protocol_fixtures_test.go` · `TestExportProtocolFixtures` | 115 个结构的字段清单、290 个正向样例；覆盖 HTTP、节点 WSS、Project Runtime 和浏览器事件 |
| `go-worker.json` | `internal/session/protocol_fixtures_test.go` · `TestExportWorkerProtocolFixtures` | 18 个 IPC 字段、24 个正向样例；顶层 `source` 指向历史 `internal/session/wire.go:ipcMessage` |
| `go-migration.json` | `internal/session/protocol_migration_fixtures_test.go` · `TestExportMigrationProtocolFixtures` | 81 个正向、13 个负向样例；顶层 `source` 为 `specs/agent-adapters/TECH.md · test-only contracts` |

HTTP / 节点导出器通过反射读取命名生产类型；匿名 DTO 的测试内声明由 Go AST 与 handler 声明比对。字段清单记录类型、可选性和可空性，导出时还检查了协议声明是否遗漏。样例中也包含测试内构造的查询参数、异步命令和能力扩展。

Worker 导出器通过生产 Client 的 JSON encoder 记录请求，并以历史 `ipcMessage` 编码结果。带 `.command_id` 的请求、ready 区分和存储代次样例由测试内扩展结构构造。

迁移样例使用测试内结构表达适配器规格中的异步接收、状态、完成、open 配置及设备事件。这些样例提供传输契约证据；Go 的冻结生产实现不执行其中新增的异步命令。

## 测试使用范围

`test/protocol.test.ts` 读取三个文件，核对静态字段清单及显式允许的 TS 扩展，严格解码正向样例并重新编码比较，同时拒绝负向样例。原生历史的 `ThreadHistoryQuery` 和 Worker `native_history` 样例仅保留为历史证据，测试显式跳过。Thread 详情样例补入当前必需的 `pending_questions`、`question_answers` 空数组后参与往返校验。

来源路径只用于追溯，协议测试不读取 `internal/`，也不运行导出器。新增 TS 契约的验证与样例放在协议测试中。

## Kiro 转录来源

Kiro 的 12 份转录位于 [t3code fork 夹具目录](../../../upstream/t3code/packages/provider-acp-registry/src/testing/fixtures/kiro/README.md)，由 fork 的 `packages/provider-acp-registry/scripts/convert-kiro-replay.mjs` 转换。fork 固定版本为 `3aab3a35bcd1bd9683692230387efaea6e274d95`。原始转录及说明可在 Baton 提交 `5904eefa8daffbff253d85c361e97c725bc9dc1f` 的 `internal/agent/kiro/testdata/replay/` 查询，其中 `README.md` 记录了场景、规范化和录制来源。

原始头部共同记录：`agent: kiro`、`protocol: acp-jsonrpc`、`agent_version: 2.32.0`、`platform: darwin/arm64`、`recorded_at: 2026-10-19`、`baton_commit: b40e64a02b707dd82aecc9d62cee99a794117f3d`、`normalization: v1`、`source: local recording`。原说明将录制环境记为真实 Kiro CLI 2.32.0、ACP V3、macOS arm64，录制基线包含该 Baton 提交及当时的适配器工作区。

普通场景使用 `qwen3-coder-next`；`provider_error` 使用 `baton-nonexistent-model` 验证配置错误；`supplement_active` 经授权使用 `gpt-5.6-sol`，用于录制活动工具期间接受补充输入的行为。原说明记录的账号模型倍率分别为 0.05 Credit 与 4.4 Credit。

规范化保留模型和工具输出，替换目录及运行标识，按原生 Session 筛选父会话。握手里的认证方法、日志位置，以及账号、MCP、steering、工具与命令目录通知按 Kiro 策略过滤；权限请求保留原始 ID，客户端响应严格匹配。原说明记录了对主机名、用户名、邮箱、密钥和临时目录的扫描，以及逐场景检查模型文本、工具命令和路径占位符；原始录制在成功规范化后删除。

转换后的头部保留 `source`、`sourceScenario`、`agentVersion`、`model`、`normalization`。原始头部中的过滤帧数和路径绑定在此补充：

| 场景 | `dropped_frames` | `bindings` |
| --- | ---: | --- |
| `deliver_idle` | 30 | `<home>`、`<workspace>` |
| `interrupt_before_turn_started` | 10 | `<home>`、`<workspace>` |
| `interrupt_idle` | 9 | `<home>`、`<workspace>` |
| `interrupt_mid_tool` | 11 | `<home>`、`<workspace>` |
| `provider_error` | 9 | `<home>`、`<workspace>` |
| `restore_load_only` | 20 | `<home>`、`<workspace>` |
| `restore_missing` | 6 | `<home>`、`<workspace>` |
| `restore_recall` | 24 | `<home>`、`<workspace>` |
| `result_free_text` | 9 | `<home>`、`<workspace>` |
| `simple` | 9 | `<home>`、`<workspace>` |
| `supplement_active` | 13 | `<home>`、`<workspace>` |
| `symlinked_workspace` | 9 | `<home>`、`<workspace>`、`<workspace_alias>` |

fork 的转换器保留响应、通知和权限结果，移除版本探测与 stderr，将 initialize 和 prompt 请求改为 fork ACP 栈的形状，多进程录制按 `runtime_exit` 分段。fork 的回放测试和 Baton 的 `apps/batond/src/testing/kiro/transcripts.ts` 直接读取这些静态文件。其中 `deliver_idle`、`result_free_text`、`supplement_active` 保留为来源资产，当前 TS 测试未直接引用这三个场景。回放验证范围是协议及宿主行为；录制来源对应上述版本和平台。

## 文件摘要

以下 SHA-256 对应保留的 JSON 字节内容，可用于核对资产搬迁或格式变动：

| 文件 | SHA-256 |
| --- | --- |
| `go-http-node.json` | `15ded1584149c681e1e1864dea2fb9fd6080db6fb0e35f96560c1afbf642616d` |
| `go-worker.json` | `a9cd23898f0d082bdf8be007c6bd89fc6e8ef667fc95d417dc3287d1aa8a5fe8` |
| `go-migration.json` | `d29dffa04cdd5b863e04b6d9b6f469ea1645c9c3b3cbf9ad058d1720897cb4ff` |
