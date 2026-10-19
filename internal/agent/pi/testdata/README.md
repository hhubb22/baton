# Pi 1.3.0 RPC contract fixtures

`1.3.0-*.jsonl` are deterministic, model-free contract samples transcribed
from the installed `@earendil-works/pi-coding-agent@1.3.0` documentation:
`docs/rpc.md`, `rpc-commands.md`, `json.md`, and `session-format.md`.
It is **not a recording of a model run**. The assistant result is test data.
The embedded U+2028/U+2029 are literal Unicode characters, not record separators.
The Go subprocess fixture supplies correlated command responses and persists v3
native history; it can deliberately omit settlement or history confirmation.
Lifecycle, waiting-for-children and provider-error settlement are separate samples.

`BATON_PI_PROBE=1 go test -v ./internal/agent/pi -run '^TestPiNoModelProbe$'`
checks the actual installed CLI version and initialization with an isolated home,
no model input, no extensions/MCP and startup networking disabled. This is input
evidence only. Real-task verification lives in `internal/gateway`, is explicitly
opt-in and is never substituted by these fixtures.

录制与规范化工具见 [使用说明](../../../../tools/agent-replay/README.md) 和 [回放设计](../../../../specs/agent-replay/TECH.md)。当前上述夹具仍来自文档转录；PS-173 的工具测试使用合成原始录制，真实 Pi 测试接入录制由 PS-174 实施。
