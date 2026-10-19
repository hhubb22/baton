# Agent 适配器录制回放测试技术设计

Status: draft
Owner: Asa
Date: 2026-10-19
Baseline: `hhubb22/baton@79f2f7d09940656a6eccecee9ebd95e3dfac63f8`；t3code `1451e7cb23034d29774338608368a15d8845df36`（`docs/internals/adding-a-provider.md`、`docs/orchestration-v2/testing-strategy.md`、`packages/provider-testing`、`apps/server/scripts/acp-replay-agent.ts`）
Basis: 2026-10-19 用户确认的测试方案；[Baton TECH](../baton/TECH.md) 中 Pi（PS-118 / T14）、Codex（PS-119 / T15）、子结果交付（PS-116 / T12）的适配器语义

## Context

Baton 的适配器测试分三层。纯逻辑单测覆盖分帧和 Schema 形状。CI 中，测试进程以子进程模式冒充 Agent，适配器通过真实的 stdin/stdout 与它通信。门控的真实测试只在本机运行，使用真实 Agent 和模型。这一分层与 t3code 相同，差别在回放数据的来源。

迁移前，Pi 的 `internal/agent/pi/testdata/1.3.0-*.jsonl` 照 Pi 文档转录，它的 README 写明 “not a recording of a model run”。Codex 的 `internal/agent/codex/testdata/replay.json` 是人工构造的样本，只按官方 Schema 检查形状。两个假 Agent 都是手写的协议实现。`pi_test.go` 的 `replayChild` 根据 prompt 里是否含 `hold`、`exit` 决定行为，故障靠 `BATON_PI_REPLAY_ABORT_UNSETTLED` 等环境变量注入。`codex_test.go` 的 `replayServer` 用十多种 `FIXTURE_MODE` 改写响应。每接一个新 Agent，就要再写一个这样的进程，而且它演出的帧序列是开发者推测的。

真实测试的发现没有进入 CI。`TestRealPi` 发现 Pi 1.3.0 的中止要等当前工具结束才生效，这个时序后来靠手写的 `BATON_PI_REPLAY_ABORT_UNSETTLED` 近似出来。真实测试结束后只在日志里留下「支持 / 不支持 / 未验证」，没有可以重放的产物。`TestRealPi`（`internal/gateway/real_pi_test.go`）走完整的 Coordinator（已内置节点连接）和 batond 链路，在一个长流程里依次检查九项能力。`TestRealCodex`（`internal/gateway/codex_real_test.go`）大部分直接驱动 `codex.Adapter`，委托部分走完整链路。

t3code 的做法是对真实 Agent 跑固定场景，把收发帧录下来，规范化后提交到仓库，CI 用这些转录驱动真实适配器。它的文档把手写帧驱动适配器称为对协议的猜测，单元测试只留给纯逻辑，以及真实 Agent 无法按需制造的故障。Baton 接下来要接 Kiro（Go 实现 ACP）和 Cursor（`@cursor/sdk` 的 Node sidecar），现在换掉数据来源，新 Agent 从第一天就用录制数据开发。

本设计不改变适配器接口 `internal/agent.Adapter`、Worker 生命周期和任何对外行为，只改变测试数据的来源和测试工具。

## Proposed changes

### 1. 三个 Agent 协议都按 LF 分帧

Pi RPC 是 LF 分隔的 JSONL（`internal/agent/pi/framing.go`）。Codex app-server 是 LF 分隔的 JSON-RPC（`internal/agent/codex/transport.go` 的 `lineCodec`）。ACP 是 NDJSON 上的 JSON-RPC。因此一套按 LF 切帧的录制和回放工具就能覆盖现有和计划中的 Agent，不需要按协议分别实现。帧内 U+2028、U+2029 不作为分隔符，与现有 `TestPiLFFraming` 的要求一致。

Cursor sidecar 内部的 SDK 调用不经过 stdio，不在本设计范围内。sidecar 与 Go 之间的协议由 Baton 自己定义，定义成 LF 分帧后可以使用同一套工具。

### 2. 转录格式（R-01）

一个转录文件对应一个场景，格式为 NDJSON。第一行是 `transcript_start`：

```json
{"type":"transcript_start","agent":"pi","protocol":"pi-rpc-jsonl","agent_version":"1.3.0","platform":"darwin/arm64","model":"google-vertex/gemini-3.1-flash-lite","scenario":"interrupt_mid_tool","baton_commit":"<commit>","recorded_at":"2026-10-20","normalization":"v1","dropped_frames":0}
```

后续条目按录制时观察到的顺序排列，每个条目属于一个 Agent 进程。一个场景可能有多个进程，例如 Pi 先执行 `--version`，再启动 RPC 进程，恢复时再启动一个新的 RPC 进程。

| 条目 | 字段 | 含义 |
|---|---|---|
| `process_start` | `process`、`args` | 适配器启动了第 N 个进程，`args` 是规范化后的命令行参数 |
| `expect_outbound` | `process`、`label`、`frame` | 适配器应当写给 Agent 的一帧 |
| `emit_inbound` | `process`、`label`、`frame` | Agent 发给适配器的一帧 |
| `emit_stderr` | `process`、`text` | Agent 的一行 stderr |
| `native_history` | `process`、`path`、`append` | Agent 在原生历史文件末尾追加的内容 |
| `runtime_exit` | `process`、`code`、`signal` | 进程结束 |

`frame` 能解析成 JSON 时保存 JSON 值，否则保存为 `{"text": "..."}`，例如 `--version` 的输出。`label` 由规范化工具生成，格式为方向加方法名，例如 `request:turn/start`、`event:agent_settled`，同名的依次加序号。录制时的时间戳只保留在原始录制里，规范化后不再保存，回放也不按时间等待。

`native_history` 用于 Pi 这类自己写历史文件的 Agent。Pi 的会话 JSONL 只会追加，所以条目记录追加的行。Codex 和 ACP 的历史通过协议查询，已经包含在 `emit_inbound` 里，不需要这个条目。

### 3. 回放 Agent（R-02、R-03、R-04）

新增 `tools/agent-replay`，一个可执行文件，提供 `serve`、`record`、`normalize` 三个子命令，逻辑放在 `internal/agent/replay` 包里。测试用 `go build` 编译它，方式和 `internal/session/codex_test.go` 现在用 `go test -c` 编译 Codex 假 Agent 一样。它不进入发布产物。

适配器启动 Agent 时会追加自己的参数（`--version`、`app-server --stdio`、`--mode rpc ...`），环境变量也被裁剪：Codex 只传基本进程环境，Pi 使用配置的 `Env`。因此回放 Agent 不从参数或环境变量读取配置。它读取可执行文件旁边的 `<可执行文件名>.replay.json`，里面有转录路径、状态目录和占位符绑定。测试把编译好的回放 Agent 复制到临时目录，写好配置文件，再把 `BATON_PI_BIN` 或 `BATON_CODEX_BINARY` 指向它。这个办法在 Windows 上也能用，不依赖 shell 包装脚本。

回放 Agent 每次被启动时，从状态目录里的计数器得知自己是第几个进程，然后按该进程的条目依次执行：

- `process_start`：比较实际参数和期望参数，不一致就失败。
- `expect_outbound`：从 stdin 读一帧，结构化比较。
- `emit_inbound`、`emit_stderr`：立即写出。
- `native_history`：替换占位符后，把内容追加到对应文件。这一步排在下一条 `emit_inbound` 之前执行，适配器看到事件时，历史已经落盘，和真实 Agent 一致。
- `runtime_exit`：按记录的退出码退出。

比较规则如下。对象的键集合必须完全一致，数组按顺序比较。期望值为 `"<any>"` 时匹配任何值。失配时，回放 Agent 把条目序号、label、期望帧和实际帧写进状态目录的 `failure.json`，然后以非零码退出，测试读到这个文件就报告失败。适配器多发了帧，或者转录已经结束而 stdin 还有输入，也算失配。这样适配器的出站请求一旦变化，回放测试就会失败，需要重新录制。这是有意的：响应是对旧请求的回答，请求变了，旧响应就不再是证据。

占位符分两种，都只在 JSON 字符串值内部替换，也就是先解码再替换，所以 Windows 路径的反斜杠转义不受影响。

- 绑定占位符，例如 `<workspace>`、`<home>`、`<session_dir>`、`<context_file>`，取值来自 `.replay.json`，由测试在运行时提供。录制时的工作目录是 macOS 路径，在 Windows CI 上回放时会换成 Windows 临时目录。规范化工具把用到的绑定名写进 `transcript_start.bindings`，回放只替换这些名字，配置缺少其中任何一个就在启动时失败。录制内容里本来就有的尖括号文本，例如 Pi 系统提示里的 `<tools>`、`<rules>`，不在声明里，按原文比较和输出。
- 捕获占位符，形如 `<$session_id>`、`<$delivery_id>`、`<$request_id>`，表示 Baton 运行时生成的值。它第一次出现在 `expect_outbound` 中时，记下实际值；之后在 `emit_inbound` 和 `native_history` 中出现时，替换成记下的值。Pi 的 `--session-id`、交付输入里的 `delivery_id` 都属于这一类。捕获结果写入状态目录，同一场景的后续进程也能使用。

Agent 自己生成的标识，例如 Codex 的 thread ID 和 turn ID，规范化为固定值（`thread-1`、`turn-1`），按普通值严格比较。JSON-RPC 的 `id` 由发起方决定：适配器发起的请求，`id` 当作捕获占位符处理；Agent 发起的请求（审批、交互工具）保留录制值，适配器的应答必须带回同一个值。

### 4. 门控与派生变体（R-05）

有些场景要求测试在特定时刻动作，例如工具运行到一半时调用 `Abort`。t3code 用 `ProviderReplayGate`（`packages/provider-testing/src/replayGate.ts`）解决这个问题，这里照搬它的语义。测试可以给任意 label 设门。回放 Agent 执行到带门的条目之前，先在状态目录写 `<label>.reached`，然后等待测试写 `<label>.release`。测试等到 reached 再调用 `Abort`，然后放行。门只控制回放 Agent 的进度，不修改帧。

真实 Agent 无法按需制造的故障，用录制转录派生，不再手写帧序列。`internal/agent/replay` 提供三种操作，测试在代码里声明，不另存文件：

- `CutAfter(label)`：执行到该条目后，以 SIGKILL 等价的方式退出，模拟进程中途崩溃。
- `Drop(label)`：删掉一条入站帧，例如删掉中止后的 `agent_settled`，模拟 settled 永远不到。
- `Replace(label, frame)`：替换一条入站帧，只用于协议允许、但真实环境难以触发的取值，例如配额错误。使用时必须在测试里写明原因。

现有故障开关逐个改写成这三种操作。改写后仍然无法表达的少数情形，例如帧跨读取边界、超过 8 MiB 的帧，保留为单元测试。

### 5. 录制器（R-06）

`agent-replay record` 是一个透传进程。它读取可执行文件旁边的 `<可执行文件名>.record.json`，里面有真实 Agent 路径、原始录制目录和场景文件路径。启动后，它把收到的参数原样交给真实 Agent，在 stdin、stdout、stderr 上逐字节转发，同时按 LF 切帧，带单调时钟时间戳写进原始录制。三个方向共用一把锁，保证记录顺序就是录制器观察到的顺序。真实 Agent 退出时，录制器记下退出码或信号，然后以相同退出码退出。

原生历史的录制方法：每转发一帧 stdout，录制器检查配置中声明的历史目录。发现有文件变长，就把新增的行记为 `native_history`，排在这一帧之前。Pi 的历史目录是 `--session-dir` 参数指定的目录，录制器从参数里读出来。

录制器多出一层进程，有一个已知差异。适配器的 `Close` 会对子进程调用 `Kill`（例如 `internal/agent/codex/transport.go` 的 `processIO.Close`），录制时被杀的是录制器。录制器在 Unix 上把收到的 SIGTERM、SIGINT 转发给真实 Agent。SIGKILL 无法转发，这时真实 Agent 的 stdin 被关闭。Pi 1.3.0 和 Codex 0.162.1 在 stdin 关闭后是否退出，目前没有验证，列入 Open questions。这个差异只影响 `Close` 之后的清理，不影响录到的帧序列。

### 6. 规范化（R-07）

`agent-replay normalize` 读取原始录制，生成转录。规则版本写进 `transcript_start.normalization`：

1. 把测试的临时目录、HOME、会话目录、上下文文件路径换成对应的绑定占位符。录制测试把这些路径写在原始录制的头部，规范化工具不需要猜测。
2. 把 Baton 生成的会话 ID、Execution ID、`delivery_id`、请求 ID 换成捕获占位符；Agent 生成的 ID 按首次出现的顺序编号。
3. Baton 写给 Agent 的任务输入、系统提示和初始化参数换成 `<any>`。这些文本由 Baton 构造，测试只关心它们被发出，内容的正确性由适配器自身的单元测试检查。`delivery_id` 所在的交付输入保留结构，只把 ID 换成捕获占位符，因为历史确认依赖它。
4. 去掉账号、机器标识、认证状态这类帧和字段，删掉的帧数写进 `dropped_frames`。具体去掉哪些方法，每个协议在规范化代码里列出。
5. 模型输出和工具输出原样保留，结构化结果的 JSON 也保留。

规范化完成后，工具扫描整个转录。发现以下任何一种残留，就拒绝写出并列出位置：常见密钥格式（`sk-`、`AKIA`、`ghp_`、`Bearer `、PEM 私钥头）、用户目录路径（`/Users/`、`/home/`、`C:\Users\`）、录制机器的主机名和用户名。仓库文档和数据都不写开发机路径，这一步顺带保证了这条约定。

原始录制里含有任务内容和本机路径，处理方式和现有的 `BATON_REAL_PI_KEEP` 保留目录相同：只放在仓库外的临时目录，只在本机检查，规范化后删除，不归档，不上传。

### 7. 真实测试按场景拆分并带录制（R-08）

`TestRealPi` 和 `TestRealCodex` 现在都是一个长流程，前一项能力的会话会影响后一项。录出来的帧无法切成可以独立回放的场景，因为后面的场景缺少初始化和建会话的帧。所以真实测试改为每个场景一个子测试，每个子测试使用独立的会话，例如 `TestRealPi/simple`、`TestRealPi/interrupt_mid_tool`。能力矩阵的输出保留，每个子测试负责填写自己对应的项。

设置 `BATON_RECORD_DIR` 时，子测试把 Agent 可执行文件路径换成录制器，并把场景名写进场景文件。Pi 现有的 `pi-isolated` 沙箱包装放在录制器内层，也就是录制器启动的「真实 Agent」是沙箱包装脚本，Pi 仍在沙箱里运行。不设置 `BATON_RECORD_DIR` 时，真实测试的行为和现在一样。

一个场景录到多个原生会话时（委托场景里，子任务会启动另一个 Agent 进程），规范化工具按原生会话 ID 分组：Pi 从 `--session-id`、`--session` 参数取，Codex 从 `thread/start` 结果或 `thread/resume` 参数取，ACP 从 `session/new` 结果或 `session/load` 参数取。第一个创建的会话留在该场景里，其他会话的帧丢弃，丢弃数量计入 `dropped_frames`。子任务结果交付到父会话的过程，在回放时由 Worker 测试的子结果通知触发，不依赖子 Agent 的转录。

拆分的代价是模型调用变多，因为每个场景都要重新建会话。按现有约定，录制和真实测试一律用最便宜的模型。

### 8. 场景清单（R-09）

每个适配器都要提交下表全部场景的转录。不适用的场景，在该适配器 `testdata/replay/README.md` 里写明原因。

| 场景 | 录制方式 | 回放时验证 |
|---|---|---|
| `simple` | 输入一次，Agent 返回结构化结果 | 只提交一次输入；结构化结果在 settled 之后才作为最终结果输出 |
| `result_free_text` | 要求模型只回答自由文本 | 输出不算成功 |
| `interrupt_idle` | 回合结束后调用 `Abort` | 中止结果与 Agent 实际状态一致 |
| `interrupt_mid_tool` | 工具运行中调用 `Abort`，录制时用门控时机 | `Abort` 的 ACK 不作为停止证据；晚到的 settled 经 `StopObserver` 报告；用过工具时 `outcomeKnown=false` |
| `interrupt_before_turn_started` | `SubmitInput` 返回后立即调用 `Abort` | 中止不被吞掉，不留下 Agent 没有保存的会话 |
| `deliver_active` | 父回合运行中交付子结果（Codex 用 `turn/steer`） | 只凭原生历史中精确的 `delivery_id` 确认交付 |
| `deliver_idle` | 父回合空闲时，用新输入交付子结果 | 同上；不重发原任务输入 |
| `restore_load_only` | 结束进程后用同一会话恢复 | 恢复只加载历史，不发送任何输入 |
| `restore_missing` | 恢复时会话 ID 指向不存在的历史 | 拒绝恢复，不新建会话 |
| `provider_error` | 使用不存在的模型名 | 按失败结束，不判为成功 |
| `symlinked_workspace` | 在 macOS `/tmp` 下的工作目录录制 | 回放时把 `<workspace>` 绑定到符号链接目录，路径比较不出错 |

`exit_mid_turn`（中途崩溃）和配额错误无法按需录制，用第 4 节的 `CutAfter` 和 `Replace` 从 `simple` 派生。

前两列来自 t3code 的共享场景，以及它记录的多个适配器都踩过的问题（回合开始前就发中止、符号链接工作目录）。回放验证一列对应 Baton 自己的语义，t3code 没有这些语义。

### 9. 两个层级的回放（R-10）

适配器层：`internal/agent/<agent>` 的测试用回放 Agent 驱动真实适配器，覆盖第 8 节的每个场景。现有 `pi_test.go`、`codex_test.go` 里的回放测试逐个改写为读取转录，手写的 `replayChild`、`replayServer` 和 `testdata` 下手写的样本，在对应场景的转录提交后删除。

Worker 层：t3code 回放时 orchestrator 也是真实的，对应到 Baton 就是 `internal/session` 的 `RunWorker`。每个场景都通过真实 Worker、本地账本和真实适配器回放一次，验证不重发输入、输入意图、outbox 补报和交付确认在真实帧序列下成立。现有的 `TestCodexWorkerInputHistoryAndRecovery` 是这种测试的雏形。`nativeStub` 和 `delayedStopStub` 继续留给只检查 Worker 自身逻辑的用例。

Coordinator 和 batond 的进程测试继续使用计数执行器，本设计不改动。

### 10. 版本升级（R-11）

Agent 版本升级的流程：用新版本把全部场景重录一遍，规范化后提交，在审查中逐个查看转录的 diff。转录的变化就是协议行为的变化，例如多出一个事件、settled 的时机改变。CI 只回放已提交的转录，不访问模型和网络。支持矩阵写到转录记录的 `agent_version` 为止，不外推到其他版本。

### 11. 未采用的方案

保持手写假 Agent：每个新 Agent 都要再写一个协议实现，帧序列来自推测。中止要等工具结束这类行为，只有在真实测试发现之后才能补上，而且补的仍然是推测。

在 `agent.Output` 这一层录制：转录里会少掉适配器自己的解析和判断，而协议偏差正是在这一层出问题。

直接使用 t3code 的 `acp-replay-agent.ts`：只支持 ACP，而且 Go 测试需要依赖 Node。转录格式借用它的，代码不借用。

在仓库外维护转录：版本升级时就无法在审查中看到行为变化，而这正是录制带来的主要好处。

### 12. 对现有文档的影响

实施后需要修改 `internal/agent/pi/testdata/README.md`、`internal/agent/codex/testdata/README.md`，以及 README 中关于固定版本 testdata 的描述，改成录制来源和规范化规则。[Baton TECH](../baton/TECH.md) 中「回放」的说法，例如 T14 的「testdata 是文档转录的协议契约样本，不是模型录制」，改为指向本设计。CI 工作流不变，回放测试照常属于 `go test ./...`。

## Testing and validation

| Requirement | Setup and observation | Failure condition | Where | Status |
|---|---|---|---|---|
| R-01 | 用手写的最小转录做格式往返：读入、写出、再读入 | 两次读入的结果不一致；缺少 `transcript_start` 时没有报错 | 单元测试 | planned |
| R-02 | 回放 Agent 配合一个故意多发帧、少发帧、改字段的测试客户端 | 任何一种情况没有写出 `failure.json`，或以零退出码退出 | 单元测试 | planned |
| R-03 | 在 macOS 录制的转录分别在 Linux、macOS、Windows CI 回放，工作目录绑定到本机临时目录 | 任一平台路径比较或 JSON 转义出错 | CI 三平台 | passed：PS-177 / PR #45，代码 607a823，[CI 39238860155](https://github.com/hhubb22/baton/actions/runs/39238860155)，Linux、macOS、Windows 原生测试通过 |
| R-03 | 捕获占位符跨两个进程使用（Pi 启动后恢复） | 第二个进程中的值与第一次捕获的值不同 | 适配器层回放 | planned |
| R-04 | Pi `simple` 场景回放，在每条 `emit_inbound` 之前检查历史文件内容 | 适配器看到事件时，历史文件尚未包含对应的行 | 适配器层回放 | planned |
| R-05 | `interrupt_mid_tool` 在工具开始的 label 设门，测试在 reached 后调用 `Abort` | 回放没有在门前停住；放行后帧顺序与转录不同 | 适配器层回放 | planned |
| R-05 | 对 `simple` 做 `CutAfter`、`Drop(settled)` | 适配器把崩溃判为成功；settled 缺失时报告停止 | 适配器层和 Worker 层回放 | passed：PS-177，`TestRecordedCodexFaults`、`TestRecordedCodexWorkerScenarios`；本机两层各 10 次及 CI 39238860155 通过 |
| R-06 | 用 `cat` 类回显程序和一个按退出码退出的程序做录制器透传测试 | 转发的字节与输入不同；退出码不一致；三个方向的记录顺序错乱 | 单元测试 | planned |
| R-06 | 对 Pi 1.3.0 和 Codex 0.162.1 分别带录制器和不带录制器跑 `simple` | 带录制器时能力矩阵结果不同 | 本机真实测试 | planned |
| R-07 | 在原始录制里放入测试密钥、`/Users/<name>` 路径、主机名，运行规范化 | 规范化没有拒绝写出，或输出里还有这些内容 | 单元测试 | planned |
| R-08 | 设置 `BATON_RECORD_DIR` 跑 `TestRealPi`、`TestRealCodex` 全部子测试 | 某个场景没有产出原始录制；不设置该变量时行为与现在不同 | 本机真实测试 | planned |
| R-09 | 每个适配器的 `testdata/replay/` 与第 8 节清单逐项对照 | 缺少场景，且 README 里没有写原因 | 审查 | passed：PS-176、PS-177；两份 README 记录适用场景、派生条件与缺口；PS-178 的 Codex 早到中止录制已纳入 |
| R-10 | 第 8 节每个场景通过 `RunWorker` 回放；`deliver_*` 由 Worker 子结果通知触发 | 出现第二次任务输入；未在历史中看到 `delivery_id` 就记为 delivered；崩溃变体没有进入待核实 | Worker 层回放 | passed：PS-176、PS-177 的适用录制场景；`TestRecordedCodexWorkerScenarios` 本机 10 次、race 及 CI 39238860155 通过；PS-178 早到中止另由两层录制与派生回放覆盖 |
| R-11 | 首批转录提交后，用同一版本再录一次 `simple` 并规范化 | 两次转录除模型文本外存在差异，说明规范化不稳定 | 本机真实测试 | planned |

PS-177 的 Codex 执行记录（2026-10-19；Pi 项由对应工单维护）：

| Requirement | Setup and observation | Failure condition | Where | Status |
|---|---|---|---|---|
| R-03 | 11 份 macOS 录制绑定本机临时目录；symlinked_workspace 绑定符号链接 | 路径或 JSON 转义失配 | `TestRecordedCodexScenarios`、`TestRecordedCodexWorkerScenarios` | passed：本机 macOS 两层 `-count=10`；此前 10 份在代码 607a823 的 CI 39238860155 三平台全部通过；PS-178 的第 11 份本机执行记录见对应两层测试 |
| R-05 | interrupt_mid_tool 在录制的 turn/moderationMetadata 与 turn/completed 前设门，分别检查 ACK 与迟到停止 | ACK 成为停止事实；放行后没有 StopObserver 证据 | `TestRecordedCodexScenarios/interrupt_mid_tool` | passed：本机 `-count=10`；转录缺少工具开始事件，未验证该事件的门控 |
| R-05 | simple.CutAfter(request:turn/start / response:turn/start)、Drop(turn/completed) | 崩溃成为成功；没有 settled 却报告停止 | `TestRecordedCodexFaults`、`TestRecordedCodexWorkerScenarios` 的 disconnect / exit_mid_turn / drop_settled | passed：本机两层 `-count=10`，Worker 崩溃进入待核实 |
| R-09 | 对照 §8 检查 11 份转录及不适用/缺失说明 | 缺项未说明 | Codex `testdata/replay/README.md`；PS-175、PS-178 | passed：11 份已逐项回放；result_free_text 由派生与单测覆盖；PS-178 早到中止已覆盖 |
| R-10 | 11 份场景通过 RunWorker；重复任务/子结果通知，交付历史响应前设门，派生相似 delivery_id | 重发任务；历史确认前 delivered；错误 ID 被确认；恢复替换原身份或 outbox 结果 | `TestRecordedCodexWorkerScenarios` | passed：本机 `-count=10`；交付信封、等待状态和只读查询选择见 Codex 场景 README |
| R-05 | 立即 CutAfter(response) 的旧派生窗口，在调用方消费响应前终止进程 | 回放进程退出导致测试进程 panic | [CI 39239464332](https://github.com/hhubb22/baton/actions/runs/39239464332) 的 Linux race / macOS 测试 | failed：aba1197；jsonrpc2 v0.2.1 在缓冲响应与连接关闭并发时 send on closed channel。PS-177 当时设门等待响应被消费；PS-180 已升级 jsonrpc2 v0.2.3 并恢复立即退出变体，修复验证见 PS-180 行 |
| R-03 | Windows deliver_idle 第二轮的长转录等待结算 | 结算事实超过测试等待上限 | [CI 39240721769](https://github.com/hhubb22/baton/actions/runs/39240721769) Windows 测试 | failed：e91457d；第二轮在原 10 秒等待上限超时，无转录失配报告。当前改为 30 秒并对第二轮结算另设门；原生 CI 结果另行记录 |
| R-05 / R-10 | PS-180：完整响应读出后、RPC 分发前关闭；并发重复关闭；两层响应后立即退出与消费后退出 | panic、待决调用或 IO 不释放；重发输入；退出成为成功或停止证据 | `TestCodexCloseBeforeBufferedResponseDispatch`、`TestCodexConcurrentCloseReleasesPendingCalls`；两层 `exit_after_response` / `exit_mid_turn` | passed：旧版 v0.2.1 的确定性测试触发 conn.go:235 panic；升级 v0.2.3 后两个关闭单测 race 100 次通过，两层退出与断线场景 race 50 次通过；未运行真实模型 |

真实测试和录制只在本机运行，使用最便宜的模型。回放测试通过只说明适配器能正确处理录到的帧序列，不能代替对应版本的真实测试结论。

## Open questions

- **stdin 关闭后 Agent 是否退出。** 录制器被 SIGKILL 时，真实 Agent 只能看到 stdin 关闭。Pi 1.3.0 和 Codex 0.162.1 在这种情况下是否退出，需要在首次录制时验证。不退出的话，录制器需要在 Linux 上设置父进程死亡信号，在 macOS 上另找办法。只影响录制环境的清理。
- **适配器出站请求变化后由谁重录。** 严格比较意味着修改适配器请求的人必须能在本机跑真实模型。Cursor 云端 Agent 这类没有模型凭据的环境做不了。是否允许手工修改 `expect_outbound`，并在 `transcript_start` 里标记 `edited`，留到第一次遇到时由 Owner 决定。
- **转录大小。** 模型输出和工具输出原样保留。如果某个场景的转录超过几百 KiB，需要决定是否截断工具输出，以及截断是否影响适配器的判断。首批录制后看实际大小再定。
