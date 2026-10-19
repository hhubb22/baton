# Agent 转录回放

`agent-replay` 是测试用 Agent 进程，按 [设计](../../specs/agent-replay/TECH.md) 回放 LF 分帧的转录。本工单实现 `serve`；录制与规范化由 PS-173 实施。

```sh
go build -o agent-replay ./tools/agent-replay
```

Windows 构建时使用 `agent-replay.exe`。测试将可执行文件复制到独立临时目录，在旁边创建 `<可执行文件名>.replay.json`，再把适配器的 Binary 指向它。配置不依赖环境变量，也不占用适配器的参数：

```json
{
  "transcript": "simple.ndjson",
  "state_dir": "state",
  "bindings": {
    "<workspace>": "C:\\test\\workspace",
    "<home>": "C:\\test\\home"
  },
  "gates": ["event:turn/completed"]
}
```

相对转录路径和状态目录以可执行文件的目录为基准。直接启动和显式 `agent-replay serve ...` 使用同一份配置；`serve` 之后的参数作为实际 Agent 参数比较。每个独立场景使用全新的状态目录；继续同一场景时保留它。

`internal/agent/replay.Read` / `Write` 读取和写出 NDJSON。进程从 1 连续编号；每个进程以 `process_start` 开始，按该进程在转录中的顺序执行。帧可以是 JSON 值；单字段 `{"text":"..."}` 表示一行原始文本。对象键集合严格一致，数组有序，整个期望值 `"<any>"` 匹配任意值。

绑定的键包含尖括号，例如 `<workspace>`。替换在解码后的 JSON 字符串值中执行，不替换对象键，也不递归替换绑定内容。完整捕获 `<$request_id>` 保留实际 JSON 类型，因而数字请求 id 在应答中仍是数字；字符串内的捕获可以保留前后文。`process_start.args` 也支持捕获，供 Pi 的 `--session-id` 使用。JSON-RPC 转录的 `protocol` 包含 `jsonrpc` 或 `json-rpc`：适配器请求及 Agent 应答的 id 必须为完整捕获；Agent 请求和适配器应答保留固定 id。

进程计数器和捕获值保存在 `state.json`，用现有跨平台文件锁与原子替换保护。失配写入 `failure.json`，包含从 1 开始的转录行号、进程、label、期望、实际与原因，并以非零码退出。测试应读取该文件，避免只看到适配器的握手失败。配置尚无法读取或状态目录无法创建时，错误只能写到 stderr。

`native_history` 先关闭追加文件，再执行下一条事件。追加内容的每个有效 JSON 行也会先解码再替换，以保留 Windows 路径的正确转义；普通文本行按字符串替换。

测试通过 `Config.Gates` 声明门控，使用 `WaitReached` 等待条目执行前停住，再调用 `Release` 放行。文件名由 `GatePath` 生成：label 经 URL 查询组件转义后加 `.reached` 或 `.release`，例如 `event%3Aturn%2Fcompleted.reached`。这使方法名里的冒号和斜杠可以跨平台使用。门控文件不复用到其他场景。

`Transcript.CutAfter(label)` 保留指定条目，删除该进程的后续条目并追加强制退出；Unix 使用进程 Kill 对应 SIGKILL，Windows 使用本机强制终止。其他进程保留。`Drop(label)` 和 `Replace(label, frame)` 只操作入站帧，均返回副本；Replace 的测试必须说明无法从真实 Agent 按需取得该值的原因。

`runtime_exit` 按记录的 code 退出，signal 字段保留信号来源；`SIGKILL` 使用强制终止。正常的 `runtime_exit`（code 0、无信号）以及没有显式退出条目的转录末尾，会等待 stdin EOF，并将此时收到的额外帧判为失配。客户端需要关闭 stdin 才能确认正常结束；这样无需定时猜测是否还有输入。非零退出与 CutAfter 立即结束。回放中的等待只来自协议输入和显式门控，不按录制时间等待。
