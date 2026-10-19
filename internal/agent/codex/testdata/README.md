# Codex 0.162.1 协议契约

`schema-0.162.1.json` 是未修改的 CLI 官方导出：

```sh
codex --version  # codex-cli 0.162.1
codex app-server generate-json-schema --experimental --out /isolated/schema
```

源文件：`codex_app_server_protocol.schemas.json`。
SHA-256：`e4e7f0c7d3fd77c48cd8619cad2bf2b315d860ab006ad5a7ebe44f6e32e666c1`。

`replay.json` 是人工构造、无凭据的固定协议样本，不是模型实测录制。测试通过独立进程的 stdin/stdout 回放响应和通知，按该 Schema 校验请求、初始化、thread/turn、完成、中止、恢复和历史响应的形状；缺失历史、不兼容和断线窗口使用显式故障变体。历史响应中的目录替换为测试临时目录。真实模型、工具执行、副作用、中止与恢复的实际行为必须另跑显式开启的 `TestRealCodex`，初始化和回放通过都不能替代它。

[replay/synthetic_simple.ndjson](replay/synthetic_simple.ndjson) 将此样本的完成流程转写为统一转录，来源在头部标为手写样本转写。新增测试通过 `tools/agent-replay` 驱动真实适配器；现有样本、手写假 Agent 与测试保留。`replay/` 下其他转录是真实模型录制，见 [转录说明](replay/README.md)。

`TestNormalizeTranscriptReplaySimple` 用合成的原始录制验证规范化输出，再通过回放工具驱动真实适配器完成 simple。录制器和规范化规则见 [使用说明](../../../../tools/agent-replay/README.md)；真实测试接入录制由 PS-174 实施。
