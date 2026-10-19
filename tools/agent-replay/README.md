# Agent 转录回放

`agent-replay` 是测试用 Agent 进程，按 [设计](../../specs/agent-replay/TECH.md) 回放 LF 分帧的转录。提供 `serve`、`record` 和 `normalize`。

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

绑定的键包含尖括号，例如 `<workspace>`。转录在 `transcript_start.bindings` 声明需要的绑定时，回放只替换这些名字，配置缺少声明的绑定会在启动时失败；其他形如 `<name>` 的文本（例如 Pi 系统提示里的 `<tools>`）按原文处理。没有声明的旧转录沿用配置里的全部绑定。替换在解码后的 JSON 字符串值中执行，不替换对象键，也不递归替换绑定内容。完整捕获 `<$request_id>` 保留实际 JSON 类型，因而数字请求 id 在应答中仍是数字；字符串内的捕获可以保留前后文。`process_start.args` 也支持捕获，供 Pi 的 `--session-id` 使用。JSON-RPC 转录的 `protocol` 包含 `jsonrpc` 或 `json-rpc`：适配器请求及 Agent 应答的 id 必须为完整捕获；Agent 请求和适配器应答保留固定 id。

进程计数器和捕获值保存在 `state.json`，用现有跨平台文件锁与原子替换保护。失配写入 `failure.json`，包含从 1 开始的转录行号、进程、label、期望、实际与原因，并以非零码退出。测试应读取该文件，避免只看到适配器的握手失败。配置尚无法读取或状态目录无法创建时，错误只能写到 stderr。

`native_history` 先关闭追加文件，再执行下一条事件。追加内容的每个有效 JSON 行也会先解码再替换，以保留 Windows 路径的正确转义；普通文本行按字符串替换。

测试通过 `Config.Gates` 声明门控，使用 `WaitReached` 等待条目执行前停住，再调用 `Release` 放行。文件名由 `GatePath` 生成：label 经 URL 查询组件转义后加 `.reached` 或 `.release`，例如 `event%3Aturn%2Fcompleted.reached`。这使方法名里的冒号和斜杠可以跨平台使用。门控文件不复用到其他场景。

`Transcript.CutAfter(label)` 保留指定条目，删除该进程的后续条目并追加强制退出；Unix 使用进程 Kill 对应 SIGKILL，Windows 使用本机强制终止。其他进程保留。`Drop(label)` 和 `Replace(label, frame)` 只操作入站帧，均返回副本；Replace 的测试必须说明无法从真实 Agent 按需取得该值的原因。

`runtime_exit` 按记录的 code 退出，signal 字段保留信号来源；`SIGKILL` 使用强制终止。正常的 `runtime_exit`（code 0、无信号）以及没有显式退出条目的转录末尾，会等待 stdin EOF，并将此时收到的额外帧判为失配。客户端需要关闭 stdin 才能确认正常结束；这样无需定时猜测是否还有输入。非零退出与 CutAfter 立即结束。回放中的等待只来自协议输入和显式门控，不按录制时间等待。

## 录制

将工具放在系统临时目录的独立子目录中，在旁边写 `<可执行文件名>.record.json`：

```json
{
  "agent_binary": "real-agent",
  "raw_dir": "raw",
  "raw_temp_dir": "/recording/system-temp",
  "scenario_file": "scenario.json",
  "bindings": {
    "<workspace>": "/recording/workspace",
    "<home>": "/recording/home",
    "<session_dir>": "/recording/sessions",
    "<context_file>": "/recording/workspace/context.json"
  },
  "history_dirs": []
}
```

`agent_binary` 指向真实 Agent 或其沙箱包装程序。相对路径以录制器的目录为基准，绑定值由调用测试写入实际路径。原始录制目录必须在系统临时目录的子目录内，且位于 Git 仓库外；临时根目录默认取录制器进程的 `os.TempDir()`；调用方重设 Agent 的 `TMPDIR` 时，在可选的 `raw_temp_dir` 中传入调用测试的系统临时根目录绝对路径。此字段只用于原始目录检查，不修改真实 Agent 的环境。目录名和场景名应由调用测试隔离，已有场景文件会继续追加进程。

`scenario_file` 是包含转录元数据的单个 JSON 对象，例如：

```json
{"agent":"codex","protocol":"codex-app-server-jsonrpc","agent_version":"0.162.1","platform":"darwin/arm64","model":"fixture-model","scenario":"simple","baton_commit":"commit-under-test","recorded_at":"2026-10-19","source":"local recording"}
```

将适配器的 Binary 指向录制器即可；存在 `.record.json` 时，直接启动会进入录制模式。显式 `agent-replay record ...` 也使用这份配置，后面的参数原样传给真实 Agent。`serve` 可显式选择回放配置。

stdin、stdout、stderr 的读取块立即透传，包括没有 LF 的部分；三个方向在同一把锁下按 LF 记录帧，EOF 尾部也保存。原始数据不会用字符串承载，因而 CR、NUL、非 UTF-8 字节以及 U+2028/U+2029 均能保留。退出码沿用子进程；Unix 收到 SIGTERM、SIGINT 时转发给子进程，信号终止记录名称及 `128 + 信号编号`。Windows 保留退出码，不转发 Unix 信号。SIGKILL 后真实 Agent 是否自行退出仍待首次真实录制验证。

Pi 从实际参数 `--session-dir` 取得历史目录，也支持 `--session-dir=...`。其他目录通过 `history_dirs` 声明。每个完整 stdout 帧转发前，读取普通历史文件新增的完整 LF 行；尚未写完的一行留待下一次检查。`native_history` 先于对应 stdout 条目写入。跨进程文件锁保护同场景的追加顺序和历史偏移，恢复时不会重复录入已有历史。不跟随历史目录内的符号链接。

原始格式为 `raw-v1`，详见 `internal/agent/replay/record.go`：每个场景生成 `<scenario>.raw.ndjson`，首行 `raw_start` 保存转录元数据、路径绑定、录制主机名和用户名，后面是 `process_start`、`stdin`、`stdout`、`stderr`、`native_history`、`runtime_exit`。每条带进程号和该进程启动以来的单调时钟纳秒数 `elapsed_ns`；字节保存在 base64 编码的 `data` 中，含原始 LF。文件里的条目顺序用于规范化，时间戳不进入转录。

原始录制只供本机临时检查。它含任务内容、本机路径和机器信息，不归档、不上传。

## 规范化

录制进程结束后执行：

```sh
agent-replay normalize --input raw/simple.raw.ndjson --output simple.ndjson
```

工具完成扫描后原子写出，失败时保留已有输出。CLI 成功写出后删除输入原始文件；`.lock` 文件和临时目录由调用测试清理。库函数 `NormalizeFile` 保留输入，方便测试检查，由调用方负责删除。转录头部使用 `normalization: v1`。

规范化沿用绑定占位符，较长的路径优先替换。适配器请求 ID 按进程关联应答并换成捕获，Agent 请求和适配器应答的 ID 保持固定值。Pi 的 `--session-id`、会话和执行 ID、交付 ID 使用捕获；Codex 的线程、回合和条目标识按首次出现编号。恢复进程共用同一套替换结果。

Baton 文本的处理位置来自现有适配器：Codex 的 `initialize.params`、`thread/start` / `thread/resume` 的 `developerInstructions`、`baseInstructions`、`config`，`turn/start` 的 `outputSchema`，以及 `turn/start` / `turn/steer` 的任务输入文本使用 `<any>`；Pi 的系统提示参数和 `prompt` / `steer` / `follow_up` 的任务文本使用 `<any>`。原生用户历史采用相同规则。含 `delivery_id` 的交付信封保留完整结构，只替换 ID 和已声明路径。嵌套 JSON 字符串按结构比较和展开，Windows 路径仍是有效 JSON。

Codex 的账号和认证方法过滤表、Pi 的可用模型等过滤表及两者的隐私字段表在 `normalize.go` 中分别声明。过滤方法的请求和应答都丢弃。Codex `initialize` 的机器平台字段删除，握手需要的 `userAgent` 固定为 Agent 版本说明，`codexHome` 绑定为路径占位符；Pi `get_state` 保留握手需要的会话、文件和模型信息。模型输出、工具输出和结构化结果保留，只有已知路径与标识引用会被替换。ACP 接入时需要增加独立策略，当前明确返回未支持。

Pi 依据 `--session-id`，或 `--session` 对应的历史头部/已知会话文件名识别原生会话。Codex 依据 `thread/start` 结果、`thread/resume` 参数及各帧的线程引用识别。只保留最先观察到的原生会话及其恢复进程，版本检查也保留；同一 Codex 进程创建多个线程时按帧筛选。`dropped_frames` 统计删除的 stdio 帧和历史追加条目，进程启动、退出不计数，保留进程重新连续编号。

最终扫描整个转录的键和字符串值，包括嵌套 JSON 文本，检查常见密钥格式、用户目录路径、录制机器的主机名和用户名。发现残留时只列出行号、JSON 字段位置和残留类别，拒绝写出。扫描通过也需要人工检查转录中模型或工具输出的内容。

当前端到端测试使用合成的原始录制，经规范化生成 NDJSON，再通过 `serve` 驱动真实 `codex.Adapter` 完成 `simple`。Pi/Codex 真实测试已接入场景录制，凭据准备、运行、规范化与删除命令见 [主 README](../../README.md#本机录制与规范化)。首批真实转录由 PS-175 在用户本机生成。
