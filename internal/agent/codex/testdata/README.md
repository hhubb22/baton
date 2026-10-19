# Codex 0.162.1 协议契约

`schema-0.162.1.json` 是未修改的 CLI 官方导出：

```sh
codex --version  # codex-cli 0.162.1
codex app-server generate-json-schema --experimental --out /isolated/schema
```

源文件：`codex_app_server_protocol.schemas.json`。
SHA-256：`e4e7f0c7d3fd77c48cd8619cad2bf2b315d860ab006ad5a7ebe44f6e32e666c1`。

`replay/*.ndjson` 来自 PS-175 的本机真实录制。Agent 版本、模型、录制平台和 Baton 基线以各文件的 `transcript_start` 为准。路径、标识和 Baton 构造文本按 [回放设计](../../../../specs/agent-replay/TECH.md) §3、§6 规范化；只替换头部声明的绑定名，其余尖括号文本保留原样。

`TestRecordedCodexScenarios` 用统一回放 Agent 驱动真实 `codex.Adapter`；`TestRecordedCodexWorkerScenarios` 通过 `RunWorker`、真实适配器和 SQLite 账本验证相同场景。`TestRecordedCodexFaults` 使用 CutAfter、Drop、Replace 派生断线、崩溃、缺少 settled、配额错误、自由文本和无效标识。分页、历史匹配、审批拒绝、分帧与超限保留局部单元测试。官方 Schema 校验使用录制响应，规范化时删除隐私字段的 initialize 不作为完整 Schema 响应校验。

场景、Worker 派生条件及旧测试对应表见 [转录说明](replay/README.md)。回放不运行真实模型；真实版本能力仍以显式启用的 `TestRealCodex` 为准。
