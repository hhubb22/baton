# Agent 适配与扩展技术设计

Status: draft
Owner: 待指定
Basis: [行为规格](PRODUCT.md)；[TypeScript 迁移 TECH](../ts-migration/TECH.md)；Baton `0841a59`；t3code `9828cad49f3e1ef4f9e037b3baaca19f4e4928fc`。本文为实施设计，代码核查与验证计划分开记录。

## 现有实现与设计边界

现有 Session Worker 和适配器是 Go 实现：`internal/agent.Adapter` 定义 `Start`、`Send`、`Steer`、`Abort`、`Drain`、`Sent`、`ReadHistory`、`Capabilities`、`Close`，Pi、Codex、Kiro 分别在 `internal/agent/{pi,codex,kiro}`；`internal/session/adapter.go` 注册工厂，`internal/node/runtime_agents.go` 负责版本、模型和能力报告。网页历史由 `internal/session/browser_history.go` 独立读取，但 `HistoryPager` 返回的仍是原生记录摘要；Pi/Codex 的消息解析和分支选择在 `web/src/data/http/threads.ts::nativeMessages`，Kiro 条目尚不能显示。Kiro 每页重新建立 ACP 连接加载历史。

`internal/session/thread.go` 的 Worker 独占 Thread SQLite。输入先提交 `intent`，再调用适配器；恢复时调用 `Sent`，找不到确定证据就进入 `unknown`，不重发。现有 `IntentRestorer.UserMessageCount()` 不接受 context，Pi/Kiro 的 Send 还会再次读取历史。Worker 在原生 Start 完成后才监听 IPC；Host 等待监听为 3 秒，节点命令期限为 5 秒，而原生启动和发送各有 30 秒预算。Enqueue 同步准备和发送，慢调用还持有 Worker 状态锁。

本设计与 [TypeScript 迁移](../ts-migration/TECH.md) 同时实施，一次切换。Coordinator、batond、Session Worker 按 PRODUCT 的行为重新实现为 TypeScript + Effect，Agent 接入优先复用 t3code provider、运行时封装和测试。切换后删除 Go 代码，发布形态中没有 Go 与 TS 后端进程混用。本文路径指 `apps/batond`、`apps/server` 与 `packages/*`；Go 路径作为行为查阅入口。

现有节点私有 `agentRuntimeReport.Reason` 没有进入 `protocol.RuntimeAgent`，中心解码后重新序列化时会丢弃它；Web 还只把 unavailable 映射为不可用，未保留 create 能力。本设计将历史归一化、正式诊断字段与消费端准入、Worker 异步执行作为公共改动。

Coordinator 与 Worker 继续分别拥有中心命令及设备执行事实。复用的 provider 可以保留内部所需的 T3 类型与辅助模块；Baton 的公开协议、数据库和产品能力仍使用 Thread、Turn、消息及回复。Run、执行节点、checkpoint、审批和账号实例等上游概念不扩展为 Baton 产品能力。中心 JSONB 报告增加 reason，thread_outbox 增加异步命令完成字段；Worker 本地账本保存命令生命周期和输入准备。产品条目下文简称 R-01 至 R-12，均指配套行为规格。

## 架构与职责

```text
Coordinator：现有 Thread 命令与报告
  └─ batond：设备能力与探测、Worker 发现与启动、历史快照
      └─ batond worker 子命令：thread.db、输入意图、Turn、回复与 outbox
          └─ Baton provider 接入层：宿主、事件映射、输入证据
              ├─ Pi：复用 provider-pi / RPC
              ├─ Codex：复用 Codex provider / effect-codex-app-server
              ├─ Kiro / Grok / Antigravity：复用 ACP runtime + 各自策略
              └─ Cursor：cursor-host → 复用 Cursor provider / SDK 封装 → @cursor/sdk
```

| 位置 | 拟议职责 | 对应需求 |
|---|---|---|
| `packages/protocol` | 用 Effect Schema 定义 Worker IPC、ThreadReport、统一历史消息和 RuntimeAgent；batond、Coordinator 与 Web 共用 | R-01、R-10 |
| `packages/effect-acp`、`packages/effect-codex-app-server` | 从 t3code 原样引入的协议客户端，只依赖 `effect`；本地修改单独提交并记录 | R-04、R-08、R-11 |
| `packages/providers` | 复用的 provider、RPC / SDK / ACP runtime 及必要的上游类型和辅助模块；具体直接引入或局部抽取由 T1 验证 | R-04～R-11 |
| `packages/provider-testing` | 上游回放、设门工具、选定模块测试与原始转录，保留来源和版本 | R-04～R-12 |
| `apps/batond/src/worker` | 认证 IPC 提前监听、短事务接收命令、异步执行、停止裁决、outbox | R-01、R-04、R-05、R-08、R-10 |
| `apps/batond/src/worker/ledger` | 复用 `packages/sqlite`，WAL + `synchronous=FULL`、串行事务与提交核查 | R-04、R-05 |
| `apps/batond/src/agents/{pi,codex,kiro,grok,antigravity,cursor}` | Baton 宿主接入、配置、探测、事件及历史证据映射；产品差异在此处理 | R-01～R-11 |
| `apps/batond/src/agents/acp` | 对接复用的 ACP runtime，提供 Kiro 等协议策略、权限边界与 Baton 取消规则 | R-04、R-08、R-10、R-11 |
| `apps/batond/src/agents/registry.ts` | 唯一的 Agent 注册描述：工厂、版本策略、探测、历史构造、静态能力上限 | R-01～R-03、R-07 |
| `apps/batond/src/platform/process` | 进程组、停止回收、POSIX watchdog、Windows 进程账本 | R-08 |
| `apps/batond/src/history` | 统一消息分页、只读快照缓存 | R-10 |
| `apps/batond/src/daemon` | 启动与发现 Worker、调用注册表探测、构建历史快照、上报 RuntimeAgent | R-01、R-02、R-10、R-12 |
| `apps/server`（`src/control`、`src/store`） | 正式 reason 字段及验证、JSONB 保存与查询；outbox 完成字段 | R-01、R-04 |
| 构建工具与 Web 数据层 | SEA 打包与 `@cursor/sdk` 附带目录；保留 status/create/reason，消费统一历史，移除前端原生解析 | R-01、R-10、R-12 |

Worker、watchdog 和 cursor-host 都是 batond 可执行文件的子命令。batond 与 Worker 之间只通过认证 IPC 通信，Worker 账本只由 Worker 进程打开。探测和历史读取在 batond 进程内调用注册表，它们拉起的原生读取进程（ACP load、只读 cursor-host 等）作为 batond 的子进程运行，用同一套 `src/platform/process` 回收。

Baton 接入层按会话生命周期、执行与取消、输入证据、历史与能力分组提供 Effect 服务；原生事件用有界 `Stream` 消费。直接接入上游 provider 时，允许保留其接口，在边界映射 Baton 的身份、事件与错误；无需维持 Go Adapter 的九方法结构。文中的 open、send、abort、sent、prepareInput 等名称描述动作与不变量，具体函数形状由接入实现确定。协议层断线不能自行重放 prompt 或重建执行会话。

### 上游复用边界

| 上游模块 | 接入方式 | Baton 必须补齐的行为 |
|---|---|---|
| `effect-acp`、`effect-codex-app-server` | 使用已有引入包及上游测试 | 最低协议版本和扩展校验 |
| `provider-pi` 的 RPC、会话与事件处理 | 优先复用模块及测试，适配进程和配置宿主 | 原生 steer 归属、输入证据、当前分支历史 |
| Codex provider 与事件归一化 | 尝试保留实现及相关测试，必要时抽取 | client message ID、恢复查询与后台任务边界 |
| `provider-acp` 的 `AcpSessionRuntime`、配置与分块处理 | 复用共享 runtime，以策略接入各 Agent | Kiro V3 扩展、一次权限、目录与进程授权 |
| `provider-cursor`、`CursorAgentSdk` | 先验证完整 provider 加最小宿主；依赖不适合时抽取 SDK / runtime 模块 | 输入确认、独立历史、cursor-host 隔离与停止证据 |
| `provider-testing`、录制脚本与原始转录 | 连同对应实现引入，替换运行器和 Baton 断言 | Worker 账本、中心补报与跨设备故障场景 |

上游模块放在 `packages/providers`，Baton 配置和事件映射放在 `apps/batond/src/agents`；回放支撑放在 `packages/provider-testing`。T1 记录实际依赖、保留模块、宿主接口和局部修改；允许引入必要的 `contracts`、`provider-core`、`shared` 源码子集及其内部类型。宿主提供私有状态路径、显式配置、选定凭据、进程创建与回收、受限文件操作；边界使用实际类型，不用空实现或类型断言伪造运行条件。涉及审批、MCP 或后台任务的回调按 PRODUCT 的能力边界显式处理。

Baton 的持久接收、输入 intent、Thread / Turn 账本、报告 outbox 和设备重连由 Worker 与中心实现。上游事件经接入层核对原生身份、控制代次和停止证据后才能写入 Baton 账本。选用的 provider 有对应测试支撑；局部改动保留差异测试和来源记录。

## 运行时与进程模型（R-08、R-12）

### 运行时与本地存储

Worker 运行在 batond SEA 携带的 Node 26 上，依赖 `effect` 4 与 `@effect/platform-node`，版本在 pnpm catalog 中统一锁定。账本复用已有 `packages/sqlite`，在现有表的数据职责基础上设计 TS schema，保存下文命令、输入基准和进程字段，不读旧账本。提交结果不确定时使用 SqlClient 的提交核查；仍无法确认则停止执行并从持久事实恢复。

账本保持 `journal_mode=WAL`、`synchronous=FULL`。t3code 使用 NORMAL，因为 `node:sqlite` 在主线程同步提交，FULL 会让每次提交的 fsync 停住事件循环。Baton 的 intent 必须在调用原生提交前落盘，NORMAL 在断电时可能丢掉已提交的 intent，所以不采用。每个 Thread 一个 Worker 进程，提交卡顿只影响该 Thread；实施前测量三个系统上单次 FULL 提交的 p99，超过 50 ms 时把账本移到 `worker_threads` 再评审。

账本里保存的单调时间改用 `process.hrtime.bigint()`。它在同一次开机内跨进程可比，但不计系统睡眠，所以设备睡眠期间停止计时会暂停，唤醒后才到期；这只会推迟强制回收，不影响 unknown 判定。batond 的 Project Runtime 租约需要计入睡眠，做法见迁移 TECH 的平台相关实现。

### 进程组与停止回收

每个执行 Thread 独占 Agent 进程（Cursor 为 cursor-host 子进程）及其后代。本期不做跨 Thread 的 app-server 或 SDK host 共享。

| 系统 | 启动 | 停止超时（一分钟）后 | Worker 意外退出 |
|---|---|---|---|
| macOS、Linux | `detached: true`，Agent 成为独立进程组组长 | `process.kill(-pgid, "SIGKILL")` | `watchdog` 子命令持有私有管道读端，读到 EOF 即对已登记的进程组发 SIGKILL |
| Windows | 普通子进程，PID 与进程创建时间写入账本 `thread_processes` | `taskkill /PID <pid> /T /F` | 下次 Worker 启动时读取 `thread_processes`，PID 与创建时间都匹配的进程用 `taskkill /T /F` 结束，再清除记录 |

POSIX 的 watchdog 是 batond 可执行文件的 `watchdog` 子命令，与 Go 版 Worker 的保证相同：Worker 被强杀时内核关闭管道写端，watchdog 不依赖 Worker 配合。Worker 把每个新建的进程组 ID 通过该管道登记给 watchdog。

Windows 第一版接受两个已知缺口。`taskkill /T` 按父 PID 向下查找，中间进程先退出时，其后代会漏掉；Worker 被强杀后，到下次 Worker 启动之间 Agent 进程会继续运行。Windows 进程创建时间在恢复时通过 PowerShell `Get-CimInstance Win32_Process` 读取，用于排除 PID 复用。kill-on-close Job Object 推到第一版之后，届时以一个原生模块接入 `src/platform/process`，其余代码不变。`specs/baton/TECH.md` 的停止一节在切换提交中改写为 Windows 的当前保证。

停止确认仍以 Turn 终止事件或进程树回收结果为证据。SDK 创建的 detached 后代必须纳入真实回收验证，不能只看 cursor-host PID 已消失。batond 重启仍通过已有认证 IPC 连接存活的 Worker，不因重连重开 Agent。

### Worker IPC

Worker IPC 沿用现有令牌认证（Go 版 `internal/session/thread_ipc.go` 的 `auth` 消息）与端点：POSIX 为私有目录下的 UDS，Windows 为命名管道。Node 的 `net` 模块可直接监听两者，但不能给命名管道设置只允许当前用户的安全描述符，第一版依靠令牌认证，令牌保存在私有数据目录中（见迁移 TECH）。消息结构以 `packages/protocol` 为准，`ThreadReport` 与 `RuntimeAgent` 增加 `command_id`、`command_outcome`、`reason` 字段。Worker 以 detached 方式启动，batond 重启后通过同一端点重新连接。

## Worker 接收与异步执行（R-04、R-05、R-08）

### 启动与命令回执

Worker 取得 Session 文件锁、打开并验证本地账本后，先建立认证 IPC，再接收或恢复持久启动意图。首次启动须先接收 thread_open 并保存回执，才调度原生初始化；重启则只恢复已有持久意图。Host 的 3 秒等待只检查 Worker 的认证就绪状态，不等待 Agent；已存在的启动中 Worker 不得被再次拉起。`status` 区分 `worker_ready` 与 `agent_ready`，节点账本中的 ready 只表示本地 Worker 已接管，不能触发中心的 thread.opened。

Worker 以短事务接收命令。新增本地 `thread_commands(command_id, action, content_digest, client_message_id, control_epoch, state, receipt, outcome)`，state 为 accepted/running 或终态 succeeded/failed/cancelled/unknown；通过 IPC 传递中心原始命令 ID。接收回执与该命令的状态或队列变更在同一事务提交。相同 ID、相同内容返回原回执和已知结果，内容不同时拒绝，不因已 ACK 再次执行。消息仍按 client_message_id 唯一，不同传输命令 ID 绑定到同一消息及同一执行结果。

所有命令终态、对应业务状态和最终报告在同一个 Worker 事务写入。新增 `command.completed` 报告，携带 `command_id`、`command_outcome`、reason 和 storage_generation；同事务先写相关 thread.opened/resumed、message.sent/withdrawn/unknown 或停止报告，再写完成报告。open/resume 在实际打开或恢复后完成，message 在原生输入确认或明确撤回/未知后完成，stop 在停止证据或未知结果确定后完成。重启扫描 accepted/running 和持久意图，不能仅依赖内存任务队列；终态命令只补送 outbox，不再次调度。

中心保留 thread_outbox.acked_at 表示设备已持久接收，新增 completed_at、completion(JSONB) 保存执行结果。正 ACK 不设置 completed_at，执行前的明确拒绝同时结束命令；command.completed 按命令 ID、Thread、节点与存储代次验证后写完成状态。完成报告先于接收 ACK 到达也有效，迟到 ACK 不能覆盖完成结果。ThreadView.resume_pending 和 ResumeThread 去重改为查询 action=resume 且 completed_at 为空，持续到成功、失败、停止取消或未知终态；期间重复恢复请求复用同一待完成命令。

本地账本丢失或旧存储代次失效时，中心的历史缺失处理同时将受影响的待完成命令结束为 unknown，不能让已无法恢复的 resume 永久保持 pending。

| 命令 | IPC 返回前完成 | 异步完成与报告 |
|---|---|---|
| open | 保存配置、启动意图与命令回执 | 原生建立及映射持久化后发 thread.opened，失败发 thread.open_failed |
| message | 校验归属和能力，保存 queued 消息与回执；steer 同时固定当前 target_turn_seq，无活动回合则拒绝 | 必要时恢复原生会话；准备、intent、提交后发 message.sent/unknown/withdrawn |
| resume | 校验允许恢复，保存 resume_requested 与回执 | 恢复后发 thread.resumed，失败保持 stopped 或 unknown |
| stop | 同事务保存停止标记、撤回 queued、递增控制代次与回执 | 中断正在启动、准备或提交的任务；用终止事件或回收证据确认 |

open 的成功 `ThreadCommandResult` 增加当前 `storage_generation`，中心校验当前连接后将它写入 Thread 已有字段，但不设置 opened_at、native_session_id 或 idle。这样 Agent 仍在初始化时，stop 已能携带正确代次到达节点。opened 报告可能先于 ACK 到达，二者须核对同一代次；迟到旧连接或不同代次不能覆盖现有归属。网页根据在线状态、接收确认和 opened_at 展示“设备已接收，Agent 正在启动”，不把 Worker ready 显示为 Agent 空闲。

`thread_meta` 增加 `resume_requested` 和 `control_epoch`，`thread_messages` 以 `intent_preparation` 保存输入基准，替代单一 intent_user_count，并以 `target_turn_seq` 固定异步 steer 的目标回合；Windows 另有 `thread_processes(pid, created_at, role)`。采用当前实验室 schema，不增加旧账本读取分支。

状态变更和 SQLite 事务由一个串行的 Effect 队列处理；原生 Start、历史读取、模型配置、Send、Abort 和进程等待作为独立 fiber 在队列外执行。每个异步结果携带控制代次、操作标识和原生会话引用，过期结果不能改变新状态。stop 有独立登记与中断路径，不能排在发送 fiber 或启动任务之后。

停止先于 intent 提交时，撤回尚未提交的 queued 输入；intent 已提交则保留可能已经发出的事实，取消并查历史，不能当成未发送撤回。即使尚无活动 Turn，只要有启动或准备任务，就必须保留 stop 标记并中断/回收，不能按空闲路径清除它。准备或提交中收到 stop 后不启动下一条消息，待 SDK handle/原生 turn 建立时立即应用已登记的取消。异步 steer 写 intent 前核对 target_turn_seq 与原生执行引用；目标已结束时撤回仍 queued 的消息并说明原因。写 intent 后的过期目标按 unknown 核查，不流入下一轮。启动失败、完成报告丢失和命令 ACK 丢失分别按本地持久事实恢复。

首次 open 的成功与 stop 在 Worker 的串行状态事务中裁决。成功映射和 thread.opened 尚未提交时，先持久接收的 stop 取消 open，禁止补发 thread.opened；回收已登记进程与迟到创建的 SDK 实例，发送 thread.open_failed（reason 为启动被停止）及 open 的 cancelled 完成结果，再按停止证据结束 stop。该 Thread 保持从未成功打开，不能用残留映射自动恢复或重新创建。

若 open 的成功事务已提交，则其 thread.opened 必须按 WorkerSeq 先于停止报告发出；stop 走已打开会话的正常取消路径。过期启动结果除禁止更新状态外，还必须关闭/回收其资源；停止确认前要排除仍可能派生子进程的启动任务，取消后的控制代次禁止新建资源。最终裁决、命令终态和报告顺序都持久保存，重启不得改变结果。

### 期限与单次准备

| 路径 | 预算与关系 |
|---|---|
| Worker 进程就绪 | Host 最多 3 秒，仅含 Node 启动、账本与认证 IPC；原生初始化在其后异步开始 |
| 命令接收 | Worker 认证与短事务目标期限 1 秒；Host 最多 3 秒加 IPC 1 秒，小于节点 5 秒期限，复用外层剩余期限而不逐段重置；失败用相同命令 ID 查询或重试接收 |
| 原生 open/send | SDK/原生调用预算 30 秒，cursor-host 通信 32 秒，Worker 阶段预算 35 秒；逐层保留返回与清理余量 |
| 输入准备 | 整个准备阶段最多 10 秒，历史子调用服从剩余期限；与提交合计最多 45 秒，不占命令接收期限 |
| Stop | 从持久接收 stop 起独立计时，最长一分钟；不能等输入的 45 秒预算耗尽后才开始计时 |
| 后台探测、历史快照构建 | 各自最多 30 秒的非执行任务，服从独立并发和进程回收约束，不阻塞接收命令 |

所有慢操作都是可中断的 Effect，并以 `Effect.timeout` 套上本表预算。Worker 在登记任务时为其建立独立 Scope，不能复用即将结束的 5 秒命令上下文。RestoreInput 只恢复本地基准，不发起历史查询。断开命令 IPC 不中断已经持久接收的执行，持久 stop、阶段超时和 Worker 退出负责中断任务。SEA 冷启动耗时计入 3 秒就绪预算，在三个系统上测量；超出时先缩小 Worker 入口的同步加载，不放宽 Host 期限。

输入证据服务提供一次准备与恢复本地基准的操作，可采用 `prepareInput(id, text) → Effect<InputPreparation>` 和 `restoreInput(id, text, preparation)`。数量匹配的 Pi、Kiro、Cursor、Grok、Antigravity 使用该证据；Codex 继续使用原生客户端消息 ID。InputPreparation 至少包含原生会话、user_count、完整历史前缀摘要及准备标识，不含凭据，编码后最多 4 KiB。

每个输入只采集一次发送前基准。prepareInput 在其 10 秒期限内读取并缓存，Worker 将该基准与 intent 原子提交，Send 使用同一份基准，不为重新计数而再启动历史进程。提交后为确认接收或故障恢复而查询新鲜历史仍可进行，但不能替换已保存的准备基准。进程重启通过 restoreInput 恢复基准。新输入、控制代次变化或原生身份变化使内存准备失效；实际提交时核对输入、代次和可用的原生版本/叶子标识。需重新读取完整历史才能保证安全时，该 intent 不自动重准备或提交，按未知处理。

## 输入、事件与恢复不变量

### 输入确认（R-04、R-05、R-07）

| 阶段 | 保存内容与动作 | 故障处理 |
|---|---|---|
| 原生会话建立 | 适配器先原子保存 Thread ID、原生会话 ID、工作目录、配置位置及格式版本，再完成 `start` | 首次建会话途中退出可能留下未发送消息的原生空会话；恢复只接受完整映射，不发送第一条消息或自动再建会话 |
| 准备输入 | 无原生客户端 ID 时，prepareInput 一次读取 user_count、前缀摘要和原生身份，绑定输入 ID 与控制代次 | 读取可中断；停止或身份变化后废弃准备，尚未提交的 queued 可撤回 |
| Worker 提交意图 | 在同一事务保存 intent_preparation、client_message_id 和 intent；Send 使用这份基准 | Worker 重启通过 restoreInput 恢复；提交后不重新计数 |
| 原生提交 | 有原生客户端 ID 时直接传入；否则绑定本次 ID、原生会话、历史基准和正文 | 不做传输层重试或 SDK 输入重放；请求超时不等于未接收 |
| 接收确认 | `send` 成功必须有原生接受或原生历史证据；SDK handle、管道写入成功与进程存活均不足以确认 | 在 Worker 发送时限内拿不到证据则返回不确定错误，由 Worker 查历史 |
| 恢复查询 | `sent(id)` 只读原生记录，核对原生会话、历史前缀和输入位置 | 能证明存在才返回 true；无匹配或查询失败进入 unknown，不重发 |

数量匹配须验证发送前历史前缀未变，不得只在全部历史中搜索相同正文。重复正文、历史被截断、另一原生会话、不同工作目录都应有独立测试。准备基准由 Worker 的 intent_preparation 保存；原生映射以同目录临时文件加 `rename` 原子写入 `Config.statePath`，文件权限 0600。这些恢复证据不从网页历史快照推断，也不保存凭据。

若具体 SDK 无法提供恢复核查所需的原生历史证据，该 Agent 保持 `unverified`，不能用本机“曾调用过 SDK”的记录代替 `sent`。SDK 内部重试需要区分模型请求重试与用户输入重新提交，必须核查不会把同一输入再次写入会话；不满足时关闭相关选项或阻止交付。

`ModelSwitchError` 只用于明确发生在原生提交之前的模型失败。模型请求或输入响应丢失等情况沿用不确定恢复，不能伪装成可安全撤回。

### 事件归属与回合结束（R-06、R-08、R-09）

每个适配器运行时维护本次进程代次、原生会话、当前输入标识和原生执行引用。接收 fiber 只做解析、关联与有界缓冲，不等待原生 RPC、SDK 或进程退出。输入和模型切换串行，停止请求有独立登记路径，不排在慢调用之后；事件读取始终可以继续。原生 run handle 尚未建立时先保存取消标记，建立后在允许继续执行前处理它。

| 原生信息 | Baton 映射 |
|---|---|
| 输入已接受或已开始 | `TurnStarted`，关联当前 `client_message_id` 和原生会话；Worker 仍负责唯一 Turn 账本 |
| assistant 消息结束 | `Reply`；纯文本增量进入 `LiveBuffer`，工具详情保留在原生历史 |
| 工具或子任务结束 | 更新本机执行状态；不能单独产生根回合 `TurnEnded` |
| 根回合终止且相关本机执行已停止或等待输入 | 先输出本轮已收到的 Reply，再产生一次 `TurnEnded` |
| 未确认的退出、断线、事件溢出或身份不匹配 | `Uncertain`，进程退出另报 `Exited` |
| 历史加载重放 | 只供历史与恢复核查，不投递为本轮新 Reply |

Worker 消费 drain 流时有明确的终态优先级：同一故障已产生 `Uncertain` 后，后续 `Exited` 只补充进程退出事实，不能把 Thread 的 unknown 改成 stopped，也不能恢复发送队列；已提交的未知输入结果保持未知。适配器仍可分别报告执行不确定和进程退出，Worker 对此做包内回归测试。

后台任务有独立归属。原生后台任务能在根 prompt 返回后继续执行时，要等待可核查的结束状态；本期不把原生自动唤醒转换成新的 Baton 输入。不能关闭自动续跑、判断后台归属或停止其进程的组合保持未验证。已结束回合的迟到事件不得绑定到当前输入。

保留 Pi、Codex 的原生 steer。T3 的 Pi `prompt + streamingBehavior: steer` 在空闲时会开启新执行，不能直接套入 Baton 的“只加入当前 Turn”语义。对已支持的 Pi 版本，优先保留明确的 steer RPC；只有实测能核对当前回合且不会遗留到下一轮，才替换实现。竞态中拿不到归属证据就报 `Uncertain`，不补发 prompt。其余四种 Agent 的 `steer` 返回 `Unsupported`，不用中断重启来模拟。

### 停止（R-08）

`abort` 幂等设置本轮停止状态，再调用原生取消。Worker 异步调用 `abort` 时只消费失败，停止状态由 drain 的事件和进程树回收结果推进。返回值中的 `outcomeKnown` 描述执行结果是否已知，不能当作 Turn 终止或进程树退出的替代证据。原生尚未登记 prompt 时，等待提交边界并再次确认取消，或直接回收当前 Thread 的进程树；不能把一个过早且无效的 cancel 响应当作完成。

停止后拒绝新的权限请求和后台续跑，清理未消费的原生输入队列。取消响应、Turn 终止和进程退出分别记录；`outcomeKnown`、`StopStatus` 和进程回收接口沿用 Go 版含义。超过 Worker 的一分钟停止时限按上文进程模型回收，回收未确认仍是 unknown。

## 各 Agent 实现

### Pi、Codex（R-04～R-10）

Pi 保持 RPC、原生 JSONL 与会话归属，优先引入 t3code `packages/provider-pi` 的 RPC、会话与事件模块及相应测试，通过 Baton 宿主接入；输入准备使用一次性基准。核查发送确认、工具运行中的 abort、输入队列清除、部分写入、compaction 与回合结束时序。会话树只读取当前分支；若增加 `get_entries` 支持，用相应版本的真实转录验证最低版本。

Codex 优先接入现成 provider 与事件归一化，使用已有 `effect-codex-app-server` 包，保留 `clientUserMessageId`。当前包已按官方 0.162.1 重生 schema，并有 Baton 录制帧解码检查，依据见 [来源说明](../../third_party/t3code/README.md#codex-schema-基线)；接入后的请求与生命周期仍需回放验证。重点核查 `turn/start` 响应和通知先后、原生 turn 存在之前的中止、`expectedTurnId`、断线后的原生历史查询、恢复中的分页及子任务迟到通知。保留 `approvalPolicy: never`、`sandbox: workspace-write`，不暴露上游审批与回退产品接口。

既有 Pi 1.3.0、Codex 0.162.1 及更新的稳定版本检查策略继续适用；新增协议要求必须先证明这些最低版本满足，或另行修改并审查最低版本约定。

### 共享 ACP 与 Kiro（R-04、R-08～R-11）

`effect-acp` 提供 NDJSON 分帧、双向 JSON-RPC、请求生命周期和扩展入口。优先复用 t3code `provider-acp` 的 `AcpSessionRuntime`、配置和分块处理及相关测试；`src/agents/acp` 提供 Baton 宿主、权限边界、取消证据与协议策略，避免另写一套 ACP 生命周期。

各协议策略提供结构化启动配置和以下内容：initialize 参数及能力校验、认证方式、new/load/resume、模型配置、session/update 与扩展事件解析、原生输入历史获取、取消与结束证据、客户端文件或终端回调。策略以函数或 Effect 服务注入，共享层不按 Agent 名称分支。

Kiro 保持 `kiro-cli acp --agent-engine=v3`、ACP `protocolVersion: 1` 及 `_kiro/session/history` 等扩展校验。effect-acp 的测试同时出现版本 1 和 2，引入后用 Kiro 转录确认它不改写协商版本；不能因 T3 的通用 ACP 请求版本为 2 就统一改为 2。保留 Kiro 的新建模型 `_meta.kiro.modelId`、load 前身份核查、sent 的 user 分块合并和不支持 steer/中途换模型的声明。网页历史新增完整的 user/assistant 分块归一化；prepareInput 与 send 共用一次历史读取。Kiro 是第一个接入共享层的 Agent，先用既有 Kiro 转录证明请求与恢复语义不变，再接其他 Agent。

共享层不默认提供 `fs`、terminal 或未知扩展能力。只有确实实现的客户端能力才出现在 initialize 中。权限请求逐次匹配原生 session ID、活动回合和原始 optionId；使用既有 Kiro 的当前回合 `allow_once` 策略，不能选择 `allow_always`。停止、读取历史或未知会话的请求返回取消。

### Grok（R-01～R-11）

新增 `src/agents/grok`，优先复用 t3code `packages/provider-grok` 和共享 ACP runtime 的实现及测试，启动原生 `grok agent stdio`；接入层选择 initialize、认证参数和 xAI 扩展。首期沿用 CLI 原生权限检查，显式采用 `--permission-mode default`；权限回调只允许当前回合的一次请求，不写项目级授权，不使用 `--always-approve`。

认证使用本机 Grok 已配置的账号或员工明确配置的原生 API key。环境白名单只允许必要的系统、网络和该 Agent 的配置项，不继承其他提供商密钥或 Project Runtime OAuth。具体原生 profile 环境变量须通过启动与恢复录制确认，不能简单替换整个系统 HOME。

xAI 的 prompt 完成通知、标准 prompt RPC、后台任务通知分别处理，按本轮身份去重，只结束一次。取消参考原生 Ctrl+C 语义与 `session/cancel` 扩展，用户 Stop 必须覆盖子任务；原生取消不足时依靠 Worker 回收整个进程树。

原生历史读取、resume 和后台执行结束证据是可用声明的前置条件。只有 `session/load` 能恢复并不代表它会回放 user 输入；需实际证明历史查询足以实现 `sent` 和网页分页。无法证明时保持未验证。

### Antigravity（R-01～R-11）

新增 `src/agents/antigravity`，优先复用上游 ACP provider 与 Antigravity 策略及测试，接入用户已准备好的 `agy_acp_server` 或等价原生 ACP 启动器。启动器及可能需要的 harness 路径分别解析成结构化参数，不能拼接任意 shell 命令。Baton 本期不下载二进制、不接入 T3 托管认证流程、不分发未核实许可的第三方安装资产。

执行使用显式配置的原生 profile；认证只采用已完成的本机上下文。后台探测和 Worker 不发起交互登录，原生要求重新认证时退出并给出本机操作原因。移除未选择的 ambient Google 凭据，避免落到其他账号或计费项目；不复用 Project Agent 的订阅登录。

恢复优先采用实测无工具重执行的原生 resume；load 是否用于独立历史读取需另证。模型只在原生 config options 已公布后设置。启动选择原生 `default` 权限模式，只处理当前回合的 `allow_once`，不自动改为 `yolo`。

如果原生执行需要客户端文件回调，仅对本 Thread 已验证的工作目录提供读写，规则与 `internal/fileaccess` 一致：先 `realpath` 再判断前缀，POSIX 以 `O_NOFOLLOW` 打开，拒绝目录外、解析后越界与未知会话请求。Windows 上 Node 没有 `O_NOFOLLOW`，打开后再次比对句柄路径，做不到时该系统不提供写回调。独立历史连接不提供写权限。未实现的客户端 terminal 不做能力声明。

每个运行时使用独立临时目录，进程树退出后才清理；不能删除另一 Thread 使用的 harness 或解包目录。原生程序的可独立安装、认证、历史与后台任务证据未齐全前，不标记 available。

### Cursor（R-01～R-12）

Cursor 优先复用 t3code `provider-cursor` 与 `CursorAgentSdk` 的实现、模块测试和 SDK 转录，底层使用官方 `@cursor/sdk`。T1 先尝试完整 provider 配最小宿主，检查其实际依赖；若需带入无关编排运行逻辑，则抽取 SDK / runtime 模块并保留其测试。实际 SDK 版本锁定在 pnpm 锁文件，记录 CLI、本机辅助进程及 Node 要求；上游的 `1.0.35` 与现有加载测量不代表 Baton 的执行与恢复已验证。

SDK 运行在 Worker 启动的 `cursor-host` 子进程里，Worker 进程本身不加载 SDK。这样 SDK 派生的本机进程都落在 cursor-host 的进程组内，停止回收可以整组结束而不杀掉 Worker。Worker 与 cursor-host 之间用 `effect/rpc` 经 stdio 通信，请求与事件的 schema 定义在 `apps/batond` 内部，双方是同一可执行文件，不单独维护协议版本。

每个 Thread 一个 cursor-host、一个本地 SDK Agent。使用 `Agent.create/resume`、`send`、`onDelta`、`run.wait/cancel` 和 `listMessages` 等已核查入口；具体签名与持久化能力以安装的 SDK 类型和实际录制为准。禁止 SDK 运行模式转到远程执行环境。

| 操作 | 结果与期限 |
|---|---|
| `open` | 原生 SDK 30 秒内完成，RPC 32 秒、Worker 启动阶段 35 秒；不发送用户消息 |
| `prepare` | 10 秒准备阶段内返回原生 user_count、前缀摘要与身份，绑定输入 ID；只读取一次，可中断 |
| `send` | 使用已落盘的同一准备基准；在发送预算内返回原生接收证据，不等待整轮执行 |
| `abort` | 立即登记取消并返回；终止证据通过后续事件确认，不能排在 send 之后 |
| `sent`、`history` | 只读原生历史；不重放输入 |
| `close` | 幂等关闭 SDK Agent 并退出；超时由 Worker 回收进程组 |

cursor-host 的 RPC 并发上限为 8，其中 1 个额度保留给 `abort` 与 `close`。`send`、`open` 超时即关闭该子进程的通道，不自动重试；关闭通道不表示进程树已停止。之后的 `sent` 由 Worker 另起一个只读 cursor-host 核查历史，不依赖已关闭通道，也不自动 create/resume 执行会话；读取失败就返回错误，由 Worker 进入 unknown。cursor-host 不能为同一请求再次调用 SDK。事件缓冲有界，溢出时报 Uncertain 并关闭执行通道；Worker 校验进程代次、序号、原生会话和输入 ID，序号缺口或归属错误进入未知。

Worker 保存 Baton Thread 与 SDK 原生 agent ID、工作目录、配置位置的映射。跨进程恢复能力是固定 SDK/系统组合的交付验证条件；每次 start 只建立本次原生会话并持久化映射，不启动第二个执行 host 验证 resume。SDK 若需要定制本地 store，必须采用 SDK 公开接口并保存到设备私有数据目录；不能依据 t3code 未显式配置 store 就推断历史已经持久化。

认证先支持员工为该原生 Agent 明确配置的 `CURSOR_API_KEY`，仅经私有进程环境注入 cursor-host；SDK 自身公开的 credential store 可在验证后接入。不能假定 `agent login` 的私有 CLI 凭据可直接被 SDK 复用。需要读取私有格式或增加 Baton 登录流程时，先补充并审查本节及产品 R-03，不复制 T3 的登录服务。凭据不持久化到 Agent 配置、中心或诊断中。

首期选择 SDK 本地 `autoReview: true`，启用其实际支持的原生 sandbox；不因某系统不支持而自动设为 false。上游指出 Windows 的文件 sandbox 存在限制，因此 Windows 作为独立验证组合，满足不了选定执行策略时保持未验证。`enableAgentRetries` 必须按输入确认约束核查，不能照搬上游的 true。

首期 `steer=false`，模型在下一轮原生支持时切换。后台 SDK 活动、取消后的 delta、运行结果和进程退出由同一会话代次关联，关闭与取消均幂等。

上游 Cursor provider 的 `interruptTurn` 在等待完成 10 秒超时后会调用 `finalizeTurn(interrupted)`；这条终态路径必须修改，使 Baton 继续等待真实终止或按一分钟预算回收进程树，不能直接把该合成终态写成已停止。上游 `enableAgentRetries: true` 也须按输入不重放要求核查。修改点与所选模块的上游测试一并保留，并补取消未完成和重试输入次数的差异测试。

只读 cursor-host 从既有映射读取原生历史，不创建新会话，不发送消息。优先验证 t3code 已在使用的 `Agent.messages.list(nativeId, {runtime: "local", cwd})`；若仅 resume 能读取，必须证明它在独立进程中无项目动作且不干扰活动 Agent，否则此路线不满足 R-10。SDK 一次返回完整列表时，按下文建立有界只读快照。

## 设备端历史归一化与分页（R-10）

### 统一消息契约

六种 BrowserHistory 实现先解析原生格式、选择当前有效分支并合并消息，再交给 HistoryPager。`packages/protocol` 中的 `HistoryEntry` 改为统一消息结构；`text` 是普通正文，不再装原生 JSON。此结构及 ValidHistoryPage 同步用于设备、中心临时转发、Web 和 Project Agent 历史查询，不维护原始 JSONL 响应兼容分支。

| 字段 | 约定 |
|---|---|
| id、ordinal | 稳定消息标识与会话内顺序；优先原生 ID，缺失时从原生会话、稳定边界与序号派生，禁止每次读取随机生成 |
| role、text | role 仅 user/assistant；正文与其 UTF-8 截断边界由设备解析，不把工具、系统提示或原始协议帧混入 |
| timestamp | 可空的原生时间；缺失时 null，前端显示未知；不使用探测时间或当前时间补造 |
| client_message_id | 原生明确提供时携带，用于与中心已保存输入关联；不能把推测的匹配写成确定 ID |
| reference、bytes、truncated | 节点本地来源范围、完整正文 UTF-8 字节数和截断标记；引用不携带凭据或任意可读取路径 |

HistoryPager 的输入是已解析消息、完整逻辑消息摘要和来源范围。它只限制单条 4 KiB、每页最多 16 条且编码后不超过 14 KiB，计算前缀摘要并校验游标，不解析 JSON、不提取 type/parentId、不推断角色。超大消息边解析边计算完整摘要，保留有限正文；超限不使解析失败而丢掉整条消息。

摘要覆盖规范化的完整正文、role、稳定消息身份和顺序，不包含传输 token 分块或读取时间；同一历史用不同 chunk 大小重放仍得到同一消息和摘要。Pi 的有效分支选择、Codex 原生记录解析、Cursor SDK 消息转换及 ACP 分块合并都属于各自的 BrowserHistory 实现。

### ACP 合并与只读快照

ACP 的 user_message_chunk/agent_message_chunk 按原生消息 ID、replay ID 和消息边界归并；缺少 ID 时只能使用已验证的消息起止、角色切换或工具边界。不能把所有相邻同角色记录无条件合并。无法确定边界时保留已知内容并标 gap。原始消息有时间则保留；没有时间不丢弃。网页历史与 sent 共用原生分块解析规则，但 sent 使用新鲜原生证据，不依赖展示快照。

对必须全量 load/replay 或 SDK 一次返回列表的 Agent，一次读取建立一个私有、只读的规范化快照。缓存键绑定员工设备上的 Thread、原生会话、规范化 schema、配置位置和源版本；同键并发首读只建立一个任务。后续页复用快照，不重新拉起 ACP 进程。快照是可删除的派生缓存，原生历史仍是唯一恢复依据，不进入 Worker 账本或 PostgreSQL。

快照由 batond 拥有：batond 进程内调用注册表的历史构造写入快照文件，并直接按游标读取后续页；原生读取进程在构建结束时回收。节点最多同时构建 2 个历史快照，单快照最多 16 MiB、总量最多 64 MiB，空闲 5 分钟失效；私有目录和文件使用既有权限设施，超限返回明确缺口或不可用。原生支持稳定分页时可直接使用其受限读取，无需复制快照。缓存重启后可丢弃，不能作为发送成功证据。

游标在现有 100 字节内紧凑编码快照标识、下一消息序号、前缀摘要与格式版本。后续页直接校验游标所指快照及其前缀，不为校验再次重放原生历史。快照过期、已知原生身份/分支切换或已读前缀改写时返回 history_changed，客户端从首读重建；不把新快照的条目接到旧游标后。

快照提供捕获时的一致视图，后续追加不改变正在翻页的结果，显式刷新才读取新内容。新首读用可靠的原生变更标识判断复用；没有这种标识时重新读取并比较逻辑前缀，不能仅凭缓存年龄或文件时间复用旧数据。没有变更通知的 Agent 不声明翻页时实时检测原生改写，只保证不可变快照与有限有效期。

首个请求只等待受限构建进度，未完成时返回 `ok:false, code:history_loading`；同 Thread 重试复用该任务。构建最多 30 秒且无 prompt；单次响应不超过 10 秒，保持小于现有节点 12 秒和中心 15 秒历史查询期限。客户端在总计 35 秒内限频等待，超时显示暂不可读，不能不断新建进程。构建、取消、超时和缓存清理均须回收读取进程。

### 消费端与中心记录关联

删除 Web nativeMessages 中按 Agent 解析和 Pi 分支遍历，设备已经输出有效消息。Message 的时间字段允许 null，展示、排序和日期分组使用稳定顺序并处理未知时间。前端逐页消费统一条目，保留后续游标；128 页/2 MiB 只限制单次自动读取，达到预算时显示缺口及继续读取入口，不能丢弃全部已读消息。

中心输入优先以 client_message_id 关联；没有确定 ID 的记录按 role + 完整正文序列匹配，唯一且未截断时才能确定重叠范围。原生时间戳只用于展示，不作为匹配条件。原生与中心消息分段不同、匹配有歧义或正文截断时保留可见内容并标 gap，不静默删除，也不把中心回复冒充原生历史。六种 Agent 使用同一展示与匹配逻辑，不再为 Kiro 直接跳过条目。

## 注册、配置与设备能力（R-01～R-03、R-07、R-12）

执行、探测和历史读取共用 `src/agents/registry.ts` 中的无状态注册描述，替代 Go 版工厂、节点探测和历史分派各自维护的 Agent 列表。描述包含类型、工厂、版本策略、模型探测、历史构造与静态能力上限；不保存 live adapter 或凭据。未知类型一律拒绝，不退回 shell。

| Agent | Binary / 配置入口 | 初期能力策略 |
|---|---|---|
| Pi | 现有 `BATON_PI_BIN`、`BATON_PI_HOME`、`BATON_PI_MODEL` | 原生 steer、resume、switch_model 保留 |
| Codex | 现有 `BATON_CODEX_BINARY`、`BATON_CODEX_HOME`、`BATON_CODEX_MODEL` | 原生 steer、resume、switch_model 保留 |
| Kiro | 现有 `BATON_KIRO_BINARY`、`BATON_KIRO_HOME`、`BATON_KIRO_MODEL` | resume；steer 与 switch_model 关闭 |
| Cursor | 随 batond 分发的 SDK；本机 Cursor CLI 环境 | steer 关闭；resume、history 及模型切换须实证 |
| Grok | `BATON_GROK_BINARY`，默认 `grok`；新增 `_HOME`、`_MODEL` 配置入口 | steer 关闭；其余按原生协议验证 |
| Antigravity | 显式 `BATON_ANTIGRAVITY_BINARY`、`_HOME`、`_MODEL`，必要的 harness 路径单独配置 | steer 关闭；其余按原生协议验证 |

新配置里的 `_HOME` 指已选择的原生 profile 位置，不能把同名变量自动映射到系统 HOME；映射到原生变量的方式由对应适配器确定。Antigravity 需要额外启动路径时增加结构化、非敏感本机配置，先通过验证再固定其字段。

Agent 配置保存 `home`、`binary`、`model` 和本机状态位置；额外字段只保存必要的非敏感路径或标识。恢复核查 Thread、原生 ID、工作目录和 profile 位置；不保存 API key、token 或凭据内容的摘要。检测到账号无法访问原会话就失败，不换用 ambient 凭据。

节点报告正式采用 `{agent_type, version, status, reason, models, default_model, capabilities}`。`RuntimeAgent.reason` 为可选 UTF-8 摘要，最多 1024 字节，禁止 NUL、控制字符和凭据；协议校验同时计入现有 64 KiB 报告预算。超长或未脱敏的 SDK 原始输出不能直接写入 reason。删除节点私有包装对同名字段的补写，生产与测试统一走正式结构。

```text
注册表探测（batond 进程内）→ RuntimeReport → Coordinator 解码及验证
        → node_runtime_reports.report(JSONB)
        → GET /api/v1/nodes、devices.list → status/create/reason
```

中心按正式字段重新编码后保存，reason 不作为未知字段丢弃；只改变 reason 也应递增 report_version 并推送设备变更。查询 DTO 和 Project Agent 工具响应保留同一摘要，不从异常字符串重新推测状态。JSONB 增加字段无需数据库表或列迁移；现存报告由当前节点重新上报替换。

Web 的 NodeDTO、DeviceAgent 和 mapDevice 保留 status、create 和 reason，未知 status 默认不可创建；只允许 `status === available && capabilities.create === true`。unverified 与 unavailable 都不可创建且展示原始脱敏原因。同步扩展六种类型、Thread 映射和 Project Agent 的设备选择。中心现有同条件准入继续保留，客户端可选状态不能放宽服务端检查。

### 静态与隔离探测

注册表声明每种 Agent 的独立探测策略，不把任意 session/new 当成通用安全操作。探测返回分开的安装/版本、认证和模型目录结果。认证证据可来自明确的原生认证接口或协议成功完成认证，模型缓存、公开模型列表或可创建空对象不等于认证成功。

| 路径 | 允许动作 | 限制 |
|---|---|---|
| 静态查询 | 版本、SDK 依赖、公开只读认证状态和模型查询 | 不建执行会话、不请求推理、不刷新到另一个账号、不打开浏览器 |
| 隔离会话 | initialize/authenticate 既有凭据，必要的 session/new 或 SDK 临时 Agent；读取模型与配置 | 注册策略已证明无全局或项目 hooks/扩展/MCP，无 prompt；不接入员工已有会话 |
| 不满足隔离条件 | 仅返回已知元数据与 unknown 认证 | 报 unverified 并拒绝创建，给出缺项；正常 start 不作为绕过入口 |

隔离探测使用 canonical 临时空工作目录、独立临时会话存储和进程树，只挂载选定认证上下文。显式传空 mcpServers，并使用对应版本已验证的禁用 hooks、extensions、MCP、技能和项目配置参数；SDK 同样关闭对应 settingSources/服务配置。空目录和空 mcpServers 本身不证明隔离，必须用带用户级、项目级哨兵配置的真实验证确认。禁用参数不存在或认证会弹窗时，不能走这条路径。

探测不自动回复权限请求、不向模型发送消息；原生要求登录时立即报告缺项。每个任务最多 30 秒，版本和配置一致时复用结果，结束或失败后关闭进程并清理临时会话数据，不删真实认证目录。SDK/原生程序无法安全清理临时会话或禁止启动动作时保持未验证。

认证 unknown/missing、安装不完整或版本/系统组合未交付验证时不可创建；认证明确有效但模型目录失败时可按默认模型创建，reason 说明目录缺失。运行时协商只能收窄静态能力，不能扩大；只有创建时选模型的 Agent 关闭 switch_model。后台任务独立运行，探测及失败结果按版本、路径和配置上下文缓存，batond 重启重新采集。

节点处理 open 时的 agentAvailable 读取已完成的探测快照并快速复核路径和配置，不在 5 秒命令上下文内同步进行 30 秒隔离探测。尚在探测或结果未知时返回明确的不可用原因，后台探测完成后重新上报，员工可再次创建。

## 安装包与代码复用

Worker 与适配器随 batond 的 SEA 分发，打包方式见迁移 TECH。SEA 内的 Node 为 26，`@cursor/sdk@1.0.35` 声明 Node `>=22.13`。经实测，SDK 默认入口与公开 `/bundled` 入口均不能按当前 esbuild 配置直接在 Node SEA 中运行；可执行文件旁的 `node_modules` 必须外置完整 SDK（含 JavaScript）、全部生产依赖及当前系统/架构的平台包，由 SEA 通过 `createRequire` 加载，版本由 pnpm 锁文件固定。此方案已通过 macOS arm64 加载检查；Cursor Linux arm64 的 sandbox helper 要求 glibc 2.39+，Fedora 43 的本机验证待补。缺少证据时阻塞该组合的 available 声明，不阻塞模块离线复用。构建禁止依赖安装脚本，若 SDK 必须通过安装脚本下载辅助程序，应改为显式受控打包步骤并先审查。

安装包检查在脱离源码目录、无系统 Node 的环境中运行 SEA：检查附带目录的模块解析、探测、私有状态和模拟 SDK 协议；不能把该检查标成真实 Agent 验证。Windows、macOS、Linux 分别打包原生依赖，不能复制另一系统的 node_modules。Grok、Antigravity 原生程序单独安装，不进入 Baton 安装包。

引入的协议包、provider / runtime、辅助模块和测试固定到同一 t3code 提交，保留可对照上游的文件结构。允许保留所需的上游内部接口、类型和少量依赖；Baton 边界与局部差异集中在宿主及接入层。若必须修改上游实现，保留原测试并增加差异测试，不同时维护第二套等价实现。复制或实质性转写的代码与测试保留 MIT 版权和许可，在 `third_party/t3code/` 记录来源路径、提交及本机文件。SDK 和转录各自记录来源，官方 SDK 的许可按各自包保留。

## 验证策略

优先复用选定实现的上游模块测试、`provider-testing` 回放工具和原始协议 / SDK 转录，同时保留 Baton 已有 Pi、Codex、Kiro 录制作为补充。来源、固定提交、Agent / SDK 版本、场景与已知补丁随转录记录，原始收发顺序、ID 关联、取消竞态和历史身份保持可追溯。已有 Go 录制格式与故障派生机制见 [Agent 录制回放设计](../agent-replay/TECH.md)；TS 侧的复用与验收按本节执行。

| 测试来源 | 使用方式 | 额外验证 |
|---|---|---|
| 原样保留的上游模块测试 | 连同实现运行，调整本地运行器和宿主依赖 | 模块有改动时增加差异测试 |
| 上游原始协议 / SDK 转录 | 作为 CI 回归输入，驱动接入后的真实代码 | 末端断言改为 Baton 身份、事件和持久结果 |
| 上游编排集成测试 | 选择与 PRODUCT 相关的场景，复用原始转录和驱动 | 用真实 Worker / 中心替代 T3 orchestrator，断言 Thread、Turn、intent 与 outbox |
| Baton 已有录制和已知缺陷 | 保留适用场景，迁移驱动及必要断言 | 覆盖最低版本、输入不重发、停止与恢复 |
| Baton 新增机制 | 包内单测、确定性回放及少量主链路集成 | 覆盖 ACK / 完成乱序、持久接收、控制代次、中心补报与 Worker 回收 |

出站参数和原生版本与已有转录适用范围一致时，可以直接使用上游录制，无需仅为变更仓库归属重新录制。请求语义、认证、权限、版本或恢复路径改变，以及现有转录缺少对应证据时，补录或增加明确标注来源的派生故障场景。不得修改录制的成功响应来适配不相符的请求。真实 Agent 的系统交付验证仍在 Baton 本机环境执行，回放通过不作为 available 的依据。

Go 实现只用来核查既有场景及不变量。对照原生提交次数、会话归属、回复顺序、unknown 判定与持久终态，不要求完整 ThreadReport 序列或物理账本结构相同；新增异步命令、停止裁决与报告顺序由 TS 测试独立验收。

Cursor 的上游 SDK 调用 / 回调转录驱动复用后的真实 SDK 封装与 cursor-host；另用 RPC 回放驱动真实 Baton 接入层、Worker 与 SQLite。只回放 RPC 不能证明 SDK 映射正确。ACP 回放替换原生进程，协议客户端、复用 runtime、协议策略、Worker 与 outbox 均运行真实代码。

| 需求 | 设置与观察 | 失败条件 | 层次 | 状态 |
|---|---|---|---|---|
| R-04～R-09 | 上游与 Baton 既有转录驱动真实 provider、接入层及 Worker | 原生输入重复、会话或回合归属改变、回复乱序、错误恢复或持久终态违反 PRODUCT | 确定性回放与账本断言 | planned |
| R-04～R-12 | 运行选用模块的上游测试，核对保留模块、来源及 Baton 差异测试 | 相关模块测试遗漏、宿主伪造运行条件、取消合成终态或 SDK 重试未经核查 | 模块测试与 SDK / 协议回放 | planned |
| R-05、R-08 | FULL 同步下连续提交，测量三个系统的提交耗时和事件循环延迟 | p99 超过 50 ms 且未改到 worker_threads，或实际账本阻塞命令接收期限 | 基准测试 | planned |
| R-08 | POSIX 强杀 Worker；Windows 强杀 Worker 后重启，另构造 PID 复用 | 进程组残留、误杀复用 PID 的无关进程 | 各系统进程树测试 | planned |
| R-01、R-02、R-12 | 缺程序、SEA 附带目录缺失、认证未知、旧版本及不兼容握手；检查节点与 UI | 假报 available、执行模型请求或自动登录、创建未在执行前拒绝 | 包内测试与探测替身 | planned |
| R-03、R-04 | 保存映射后退出；删除映射、换 profile、工作目录符号链接；独立进程恢复 | 静默新建、跨会话读取、历史工具重执行 | 真实转录 + Worker | planned |
| R-05 | 在原生记录输入前后、响应前后分别断线和终止；重复相同正文 | 同一客户端 ID 再提交、只凭 SDK handle 或本地标记确认 sent | 派生回放 + SQLite 恢复 | planned |
| R-05 | SDK 失败重试与主动重连场景，核对原生用户输入次数 | 用户输入被隐藏重放、自动恢复另开会话 | SDK 转录与门控真实测试 | planned |
| R-06 | Pi/Codex steer 贴近终止；其余四种直接调用 steer | 另开 Turn、下轮消费旧队列、模拟中断重启 | 确定性回放 | planned |
| R-07 | 未公布模型配置、默认值、模型拒绝与响应丢失 | 虚构模型 ID、先发后切换、未知提交被错误撤回 | 包内与回放 | planned |
| R-08 | 发送后立即取消、工具中取消、SDK cancel 提前返回；一分钟超时 | 提前宣告停止、未回收后代、误杀另一 Thread | 设门回放 + 各系统进程树测试 | planned |
| R-05 | cursor-host send 超时关闭通道，Worker 立即调用 sent；再依次投递 Uncertain、Exited | 核查依赖已关闭通道、启动执行 host，或 unknown 被普通退出覆盖 | 只读历史集成 + Worker 包内测试 | planned |
| R-08 | cursor-host 普通请求满载且 SDK send 未返回时调用 abort | 取消未及时登记、终止事件缺失或回复顺序错误 | cursor-host 并发测试 + Worker 回放 | planned |
| R-09 | 根回合结束但子任务未结束、旧事件迟到、重复完成通知 | 父回合提前结束、重复结束、回复串轮 | SDK/ACP 回放 + Worker | planned |
| R-09 | 事件先于 send 响应、恢复重放、事件缓冲溢出 | 回复被丢弃且无缺口、历史当新回复、终止先于本轮回复 | 回放 + 报告事务测试 | planned |
| R-10 | Worker 不存活时读取大历史，修改历史前缀，读执行中会话 | 查询触发 prompt/hooks/MCP、无限增长、错误游标仍可用 | 独立历史集成 | planned |
| R-10 | 六种格式归一化；ACP 上万 token 分块、同角色不同消息、缺失时间戳，前端直接消费消息 | 页数按 chunk 增长、错误合并、缺时丢消息、浏览器仍解析原生 JSON | 解析单测 + 真实转录 + Web 契约测试 | planned |
| R-10 | 同快照翻页与并发首读，统计原生 load 次数；过期、分支变化、规范化 schema 变化 | 每页新建进程、缓存无界、旧游标混读新版本、相同正文不同 chunk 导致游标变化 | 有界快照与历史集成 | planned |
| R-01 | reason 经探测、batond、Coordinator、PostgreSQL JSONB、nodes API、devices.list 到 Web；只改变原因 | 字段丢失、原因变更不增加版本、摘要越界或未脱敏 | 协议单测 + 本地数据库集成 | planned |
| R-01 | available/create=false、unverified/create=true、未知 status；两类消费端及中心创建检查 | 任一消费端可选择不可创建 Agent，或中心放行 | Web 契约 + Project Agent 工具与 Store 测试 | planned |
| R-04、R-05、R-08 | 原生冷启动/发送慢于 3/5 秒，open 的 opened 报告前后发送 stop，丢失 ACK 后重发命令；测量 SEA Worker 冷启动 | IPC 等原生初始化、早期 stop 缺存储代次、重复执行、慢调用阻塞状态队列、停止期限延后、冷启动超 3 秒 | batond→Host→Worker 集成与进程替身 | planned |
| R-04、R-08 | open 成功提交与 stop 接收两侧设屏障，start 返回迟到实例；完成报告早于命令 ACK；重启后补报 | 已取消 open 补发 opened、遗留进程、报告乱序、终态命令再执行 | Worker 事务与 batond/Store 回放 | planned |
| R-04 | resume 已 ACK 但未完成时再次请求，随后成功、失败或被 stop 取消 | pending 过早清除、新命令重复恢复、完成被迟到 ACK 覆盖 | Store/控制面 + Worker 集成 | planned |
| R-05 | prepareInput 设置屏障后停止/退出；确认准备调用一次、intent 基准跨重启相同 | 重复读取并换基准、不可中断、停止后提交、把仍 queued 的消息写成 sent | 适配器 + Worker 确定性回放 | planned |
| R-02 | 静态与隔离会话探测，设置用户/项目 hooks、扩展、MCP、登录弹窗哨兵；到期清理 | 触发任一动作、发送 prompt、残留进程，或仅因 session/new 就永远 unknown | 探测替身 + 每原生版本门控验证 | planned |
| R-02、R-07 | 可见模型但认证未知；认证有效而目录失败；创建快路径检查正在探测 | 前者可创建、后者不能使用默认模型，或命令循环同步执行重型探测 | 准入、探测与消费端集成 | planned |
| R-11 | 非当前 session 的权限、停止后的 allow_once、客户端文件越界 | 永久授权、权限请求悬挂、历史读取写文件、越界通过 | 包内与原生回放 | planned |
| R-12 | 脱离源码路径启动 SEA；移走附带目录、禁用网络、平台原生依赖 | 联网补依赖、路径回退掩盖坏包、不同系统产物混用 | 安装包检查 | planned |
| R-01～R-12 | 每个新增 Agent 在声明支持的系统上运行核心场景 | 无法满足行为规格却声明已支持 | 门控本机真实验证 | planned |

实施验证使用迁移 TECH 列出的 `pnpm -r typecheck`、`lint`、`test`（`@effect/vitest`）与 SEA 打包检查。只有为核查既有行为而运行 Go 对照时才需执行对应 Go 测试；删除 Go 后保留相关静态转录与来源。上表为接入后的验收计划，不能用基础包测试或已有测量替代。

## 实施顺序

按 [迁移任务清单](../ts-migration/TASKS.md) 执行，切换前共五个切片，共享基础包作为现有输入，不单独拆卡。

| 切片 | 本设计中的交付 | 依赖 |
|---|---|---|
| T1：Cursor 本地可靠会话 | 先接入上游 provider / SDK 封装、测试和转录，验证宿主与必要差异；再交付 cursor-host、认证 IPC、Worker 持久队列、停止与恢复及基本历史读取 | 现有 workspace、协议包、SQLite 与测量工具 |
| T2：网页远程 Thread | 节点报告、reason/status/create、中心接收与完成、远程 Thread 操作和实时回复，补断线与 ACK 乱序验收 | T1 |
| T3：Project 与设备管理 | 将同一设备能力、Thread 与历史契约交给 Project Agent；完成 Runtime、事项、设备目录、附件、订阅与 shell 业务 | T2 |
| T4：既有 Agent 与统一历史 | 接回 Pi、Codex、Kiro，复用 ACP；四种 Agent 的快照、分页与网页统一消费，保留原生 steer 和最低版本 | T1；网页验收依赖 T2 |
| T5：发布切换 | 各目标系统完整安装包、真实 Agent 支持矩阵、故障复验、构建切换与删除 Go | T2、T3、T4 |

T1 的复用检查点先于通用 Worker 扩展完成：记录实际保留模块、依赖、宿主和差异，核查 Cursor 历史、跨进程恢复及取消语义。缺少凭据或系统环境的真实验证保持未验证；Cursor 路线不成立时先调整设计，不把回放或 SDK 加载冒充可交付会话。T1 与 T4 各自包含所属 provider 的探测、进程回收和测试，T5 不集中补做这些实现。

Grok、Antigravity 在切换后分别接入和验收，复用已经交付的 ACP、历史和报告链路。它们的原生环境缺口只阻塞各自交付，不扩大 T4 或 T5 的范围。所有异步结果写状态前仍须核对控制代次。

## 上游参考

所有上游链接固定到本设计核查的提交。引入或抽取时记录实际来源文件、测试与转录，不跟随 main 自动变更。

| 参考 | 用途 |
|---|---|
| [ProviderAdapter](https://github.com/pingdotgg/t3code/blob/9828cad/packages/provider-core/src/server/ProviderAdapter.ts)、[接入约定](https://github.com/pingdotgg/t3code/blob/9828cad/docs/internals/adding-a-provider.md) | 能力边界、运行时与事件职责 |
| [effect-acp](https://github.com/pingdotgg/t3code/tree/9828cad/packages/effect-acp)、[effect-codex-app-server](https://github.com/pingdotgg/t3code/tree/9828cad/packages/effect-codex-app-server) | 直接引入的协议客户端 |
| [进程组](https://github.com/pingdotgg/t3code/blob/9828cad/packages/provider-core/src/server/processGroup.ts)、[Pi RPC 与 Windows 回收](https://github.com/pingdotgg/t3code/blob/9828cad/packages/provider-pi/src/server/rpc.ts) | 进程组信号与 `taskkill /T /F` |
| [node:sqlite 客户端](https://github.com/pingdotgg/t3code/blob/9828cad/packages/shared/src/nodeSqliteClient.ts) | Effect SqlClient 包装 |
| [Pi](https://github.com/pingdotgg/t3code/blob/9828cad/packages/provider-pi/src/server/adapter.ts)、[Codex](https://github.com/pingdotgg/t3code/blob/9828cad/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts) | 原生输入、取消与恢复竞态 |
| [共享 ACP](https://github.com/pingdotgg/t3code/blob/9828cad/packages/provider-acp/src/server/adapter.ts)、[Grok](https://github.com/pingdotgg/t3code/blob/9828cad/packages/provider-grok/src/server/adapter.ts)、[Antigravity](https://github.com/pingdotgg/t3code/blob/9828cad/apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.ts) | 协议复用和各 Agent 扩展 |
| [Cursor SDK 封装](https://github.com/pingdotgg/t3code/blob/9828cad/packages/provider-cursor/src/server/CursorAgentSdk.ts)、[适配器](https://github.com/pingdotgg/t3code/blob/9828cad/packages/provider-cursor/src/server/adapter.ts)、[测试策略](https://github.com/pingdotgg/t3code/blob/9828cad/docs/orchestration-v2/testing-strategy.md)、[provider-testing](https://github.com/pingdotgg/t3code/tree/9828cad/packages/provider-testing) | SDK 操作、本地历史和回放边界 |

## 待验证与批准事项

| 项目 | 当前依据与缺口 | 处理与阻塞范围 |
|---|---|---|
| FULL 同步提交耗时 | macOS arm64 和本机 Linux arm64 虚拟机已有测量，Linux 批量同步事务会显著阻塞事件循环；Windows、Linux x64 未测 | 复现与数据见迁移 TECH；T1 接入实际账本复测，提交 p99 超过 50 ms 或接收期限超标时改用 worker_threads |
| Windows 进程回收 | 第一版用 `taskkill /T /F` 加进程账本，有父进程先退出和 Worker 崩溃后延迟回收两个缺口 | 已接受为第一版范围；`specs/baton/TECH.md` 停止一节在切换提交中修改；Job Object 推到第一版之后 |
| SEA 冷启动 | 最小入口在 macOS / Linux arm64 的测量低于 3 秒，完整 Worker 和其他目标未测 | T1/T5 复测完整入口；超出时先缩减加载 |
| Codex schema 版本 | 已按官方 0.162.1 重生，并用 9 个既有录制场景的 642 个帧解码检查，见来源说明 | T4 验证接入后的请求、事件、输入恢复及最低版本，字段解码不替代生命周期测试 |
| Cursor 认证入口 | 已核查上游向 SDK 注入 API key，也有 SDK 登录与 credential store；未验证本机 `agent login` 的订阅凭据可直接复用 | 需审查本期是否接受显式 `CURSOR_API_KEY`；若要求直接复用 CLI 订阅登录，先验证公开接口并补齐设计，不能自动转成另一个计费账号 |
| Cursor SDK 基线 | 1.0.35 已在 SEA 旁置完整 SDK 的加载检查中使用；跨进程 store、只读历史、真实执行和完整回收未验证 | T1 检查点核查所复用实现及 SDK 行为；Linux arm64 的 glibc 要求和其他系统结果见迁移 TECH |
| 各 Agent 的探测隔离 | Pi/Kiro 已有空目录建会话取模型路径，但未对六种 Agent 证明禁用用户级 hooks、扩展、MCP、交互登录和临时会话清理 | 每种 Agent 的隔离策略在启用前实测；无法保证时保留 unknown，不伪装为已安全探测 |
| Grok 原生历史 | 已核查 ACP 接入与 xAI 扩展，未证明独立历史足以恢复输入身份 | 在 Grok 标为 available 前录制；不能验证时保持未验证并说明原因 |
| Antigravity 安装与登录 | 上游依赖其托管程序、harness 和 profile；本设计选择用户准备环境，尚缺可复现的独立准备步骤 | 在该 Agent 实施前确定合法来源和本机认证入口；需要托管下载或登录时单独扩展并审查范围 |
| 新增系统与最低版本 | 只有上游代码证据，没有 Baton 在三个系统上的运行结果 | 实施时维护每系统版本、协议与能力记录，通过后才更新可用声明 |

审批本设计不等于上述组合已通过验证。实施记录应保存在对应转录说明和测试证据中，长期规格原地更新其最终行为。
