# Agent 适配与扩展技术设计

Status: draft
Owner: 待指定
Basis: [行为规格](PRODUCT.md)；[TypeScript 迁移 TECH](../ts-migration/TECH.md)；Baton `4d56ae2`；t3code `9828cad49f3e1ef4f9e037b3baaca19f4e4928fc`（Baton fork 的基线）。本文为实施设计，代码核查与验证计划分开记录。

## 现有实现与设计边界

当前实现包含 Worker 的认证 IPC、持久命令回执、intent 账本、停止裁决与 outbox，batond 的注册、WSS 和 Worker 管理，中心与网页的远程 Thread、Project 和设备管理。Cursor、Pi、Codex、Kiro 经 `agent-host` 子进程使用 fork 的完整 provider adapter，不再保留本地抽取的 SDK runner。Kiro 在程序已安装且认证 valid/unknown 时报告可用，版本和系统不限，开放网页新建与恢复。适配器行为以完整上游实现和当前 PRODUCT 为依据，离线验证复用 fork 的测试与转录；Kiro 夹具说明见 [fork README](../../upstream/t3code/packages/provider-acp-registry/src/testing/fixtures/kiro/README.md)。

Agent 接入整包依赖 Baton 维护的 t3code fork，使用其完整 provider 包和 `ProviderAdapterV2` 接口，接受上游的协议处理、重试、重连、steer、取消和事件归一化行为。Baton 不为产品差异修改上游 adapter；上游缺少的能力（如 Kiro）在 fork 中按上游写法补齐。包体积和依赖范围在第一版接受现状，之后再按需要逐步转写为自实现。

Baton 保留自己的 Worker 可靠层、中心和网页：持久接收、intent 先于原生提交、未知不由 Worker 重发、控制代次、停止证据与进程树回收继续由 Worker 负责。上游的 Run、checkpoint、rollback、fork、审批和 MCP 工具集不作为 Baton 产品能力暴露。产品条目下文简称 R-01 至 R-12，均指配套行为规格。

## 架构与职责

```text
Coordinator：Thread 命令、报告与历史记录
  └─ batond：设备能力与探测、Worker 发现与启动
      └─ worker 子命令：thread.db、命令回执、intent、Turn、回复与 outbox
          └─ agent-host 子命令：每 Thread 一个进程组
              └─ Baton 宿主层 + t3code ProviderAdapterV2
                  ├─ provider-pi
                  ├─ provider-codex（fork 中从 apps/server 移出）
                  ├─ provider-acp + provider-acp-registry（fork 中新增 Kiro）
                  └─ provider-cursor → @cursor/sdk
```

| 位置 | 职责 | 对应需求 |
|---|---|---|
| `upstream/t3code` | Baton fork 的 git submodule，固定提交；pnpm workspace 收录其中用到的 `@t3tools/*` 包 | R-04～R-11 |
| `upstream/t3code/packages/effect-acp`、`upstream/t3code/packages/effect-codex-app-server` | fork 中的 ACP 与 Codex app-server 客户端，由 workspace 直接收录 | R-04、R-08、R-11 |
| `packages/providers`、`packages/provider-testing` | 已删除；Cursor、Pi、Codex、Kiro 直接使用 fork 的 provider 包，回放使用各包的 `./testing` 导出 | R-04～R-12 |
| `packages/protocol` | Worker IPC、ThreadReport 和 RuntimeAgent 的 Effect Schema；原生历史条目与历史页字段已删除 | R-01、R-10 |
| `apps/batond/src/worker` | 沿用 T1～T3 的接收、执行、停止裁决与 outbox；`ThreadAgent` 契约按下文简化 | R-01、R-04、R-05、R-08 |
| `apps/batond/src/agent-host` | Agent host 子命令：宿主层、事件映射，经 stdio `effect/rpc` 与 Worker 通信 | R-04～R-11 |
| `apps/batond/src/agents/registry.ts` | Agent 类型到 t3code driver、设置、探测和静态能力上限的唯一注册描述 | R-01～R-03、R-07 |
| `apps/batond/src/platform/process` | 进程组、POSIX watchdog、Windows 进程账本；登记上游新建的进程组 | R-08 |
| `apps/server`、Web 数据层 | 正式 reason 字段、status/create 准入；历史使用中心记录，删除前端原生解析 | R-01、R-10 |

Worker 的 registry 会加载 `@t3tools/contracts` 的 `DEFAULT_MODEL` 等协议常量，SDK 安装检查通过 `sdk-inspection.ts` 读取元数据与资产路径，不执行 SDK。Worker 不加载 SDK、provider adapter 或 host driver，保持 3 秒就绪预算；执行 agent-host 按 Agent 类型加载对应模块，Cursor SDK 只在 Cursor host 内执行。安装包的 `agent-host --probe` 会加载四个 Agent 模块以检查完整性。每个执行 Thread 一个 agent-host，它是 POSIX 进程组组长或 Windows 账本登记的根进程，Worker 回收整棵进程树即可结束 adapter 及其后代。探测在 batond 拉起的只读 agent-host 中执行，用同一套 `src/platform/process` 回收。

### 宿主层

agent-host 为上游 adapter 提供它要求的 Effect service：

| service | Baton 提供的实现 |
|---|---|
| `ChildProcessSpawner`、`FileSystem` | `@effect/platform-node`；spawner 包装后把上游新建的进程组或 PID 登记给 watchdog 与 Windows 进程账本 |
| `AgentScope` | agent-host 的执行 Scope，Scope 结束时关闭 adapter 并禁止新建进程 |
| `ProviderHost` | `paths` 指向 Thread 工作目录与设备私有状态目录；`settings` 是静态快照；`credentials` 是只读空实现，认证使用设备显式配置的 `CURSOR_API_KEY`；`shouldRunBackgroundWork` 返回 false |
| `McpProviderSessions` | 使用 provider-core 的内存实现；第一版不写入任何会话配置，Agent 不挂载 MCP 工具 |

adapter 选项中的 `environment` 只含系统必要变量和该 Agent 的配置项，不继承其他提供商密钥或 Project Runtime 凭据。`continuationRequests` 不提供，上游的自动续跑不转换成 Baton 输入。

### 事件映射与 ThreadAgent

agent-host 把 `ProviderAdapterV2` 映射到 Worker 现有的 `ThreadAgent`：

| ThreadAgent | 上游调用或事件 |
|---|---|
| `open` | `openSession` 与 `ensureThread`；返回前把 `OrchestrationV2ProviderThread` 原子写入原生映射文件 |
| `resume` | 读取映射，调用 `resumeThread` |
| `send` | 队列消息调用 `startTurn`，Pi、Codex 插入调用 `steerTurn` 并保留上游执行归属；Cursor、Kiro 拒绝插入；调用成功即视为原生接收 |
| `sent` | 新建只读 agent-host 调用 `readThreadSnapshot`；user 消息数超过 Worker 已确认发送数且下一条正文相同时确认，否则返回未确认 |
| `abort` | `interruptTurn` |
| `events` | assistant 消息完成映射为 `reply`，turn 完成或中断映射为 `end`，会话错误或进程退出映射为 `uncertain` / `exited` |
| `output` | assistant 文本增量 |

`agent-host/driver.ts` 的通用驱动负责上述映射、持久原生映射、迟到事件过滤和 sent 判定。映射还保存 Agent 类型与非敏感的本机 profile 目录，恢复时核对它们；目录变化直接拒绝。Pi、Codex、Kiro 使用原生 CLI 的认证，Cursor 使用显式 `CURSOR_API_KEY`。Kiro 的 profile 只记录 `homedir()`，没有专有环境变量目录映射。

`prepareInput` 与 `restoreInput` 不读取原生历史，InputPreparation 只保存原生会话、准备标识和 Worker 已确认的发送数。运行时权限请求中的 `command`、`file-read`、`file-change`、`permission` 选择当次允许。`user_input` 和 `mcp-elicitation` 通过 `turn_item.updated` 的问题内容和 `runtime_request.updated` 的请求身份关联，保存到 Worker 账本并报告中心，网页提供选项、文本回答和取消。Codex 的 MCP elicitation 按上游提供的确认语义回答；ACP 表单由上游转换为结构化问题。其他请求返回取消。停止后的请求取消，执行结束或 Worker 恢复时关闭旧问题；提问期间继续计入本轮执行时限。回答命令与原请求及执行身份绑定，在调用上游前持久保存 intent；结果不确定时保留诊断并禁止自动重发。上游的 `rollbackThread`、`forkThread`、`compactThread` 与 `uploadFeedback` 不接入。

## 运行时与进程模型（R-08、R-12）

### 运行时与本地存储

Worker 运行在 batond SEA 携带的 Node 26 上，依赖 `effect` 4 与 `@effect/platform-node`，版本在 pnpm catalog 中统一锁定。账本复用已有 `packages/sqlite`，在现有表的数据职责基础上设计 TS schema，保存下文命令、输入基准和进程字段，不读旧账本。提交结果不确定时使用 SqlClient 的提交核查；仍无法确认则停止执行并从持久事实恢复。

账本保持 `journal_mode=WAL`、`synchronous=FULL`。t3code 使用 NORMAL，因为 `node:sqlite` 在主线程同步提交，FULL 会让每次提交的 fsync 停住事件循环。Baton 的 intent 必须在调用原生提交前落盘，NORMAL 在断电时可能丢掉已提交的 intent，所以不采用。每个 Thread 一个 Worker 进程，提交卡顿只影响该 Thread；实施前测量三个系统上单次 FULL 提交的 p99，超过 50 ms 时把账本移到 `worker_threads` 再评审。

账本里保存的单调时间改用 `process.hrtime.bigint()`。它在同一次开机内跨进程可比，但不计系统睡眠，所以设备睡眠期间停止计时会暂停，唤醒后才到期；这只会推迟强制回收，不影响 unknown 判定。batond 的 Project Runtime 租约需要计入睡眠，做法见迁移 TECH 的平台相关实现。

### 进程组与停止回收

每个执行 Thread 独占一个 agent-host 进程及其后代，本期不做跨 Thread 的 app-server 或 SDK host 共享。Cursor 将 SDK 的 detached 后代并入 host 进程组。Pi、Codex、Kiro 的 `foldDetached: false` 保留原生进程组供上游发送组信号，包装 spawner 用 process registrar 登记独立进程组；release 在注销前回收整树，仅在回收成功或确认 PID 身份不符时注销。超时和检查失败返回错误并记录警告，保留登记供 watchdog 在 host 退出后继续回收；watchdog 确认注销后才删除本地登记。该路径无需修改上游共享进程模块。

| 系统 | 启动 | 停止超时（一分钟）后 | Worker 意外退出 |
|---|---|---|---|
| macOS、Linux | `detached: true`，Agent 成为独立进程组组长 | `process.kill(-pgid, "SIGKILL")` | `watchdog` 子命令持有私有管道读端，读到 EOF 即对已登记的进程组发 SIGKILL |
| Windows | 普通子进程，PID 与进程创建时间写入账本 `thread_processes` | `taskkill /PID <pid> /T /F` | 下次 Worker 启动时读取 `thread_processes`，PID 与创建时间都匹配的进程用 `taskkill /T /F` 结束，再清除记录 |

POSIX 的 watchdog 是 batond 可执行文件的 `watchdog` 子命令：Worker 被强杀时内核关闭管道写端，watchdog 不依赖 Worker 配合。Worker 把每个新建的进程组 ID 通过该管道登记给 watchdog。

Windows 第一版接受两个已知缺口。`taskkill /T` 按父 PID 向下查找，中间进程先退出时，其后代会漏掉；Worker 被强杀后，到下次 Worker 启动之间 Agent 进程会继续运行。Windows 进程创建时间在恢复时通过 PowerShell `Get-CimInstance Win32_Process` 读取，用于排除 PID 复用。kill-on-close Job Object 推到第一版之后，届时以一个原生模块接入 `src/platform/process`，其余代码不变。全局停止与恢复规则见 `specs/baton/TECH.md`，两处采用相同的 Windows 边界。

停止确认仍以 Turn 终止事件或进程树回收结果为证据。回收测试用本地替身创建 detached 后代，核对整棵进程树退出，不能只看 agent-host PID 已消失。batond 重启仍通过已有认证 IPC 连接存活的 Worker，不因重连重开 Agent。

### Worker IPC

Worker IPC 使用令牌认证与固定端点：POSIX 为私有目录下的 UDS，Windows 为命名管道。Node 的 `net` 模块可直接监听两者，但不能给命名管道设置只允许当前用户的安全描述符，第一版依靠令牌认证，令牌保存在私有数据目录中（见迁移 TECH）。消息结构以 `packages/protocol` 为准，`ThreadReport` 与 `RuntimeAgent` 增加 `command_id`、`command_outcome`、`reason` 字段。Worker 以 detached 方式启动，batond 重启后通过同一端点重新连接。

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

`thread_meta` 增加 `resume_requested` 和 `control_epoch`，`thread_messages` 以 `intent_preparation` 保存准备标识，并以 `target_turn_seq` 固定异步 steer 的目标回合；Windows 另有 `thread_processes(pid, created_at, role)`。采用当前实验室 schema，不增加旧账本读取分支。

状态变更和 SQLite 事务由一个串行的 Effect 队列处理；原生 Start、历史读取、模型配置、Send、Abort 和进程等待作为独立 fiber 在队列外执行。每个异步结果携带控制代次、操作标识和原生会话引用，过期结果不能改变新状态。stop 有独立登记与中断路径，不能排在发送 fiber 或启动任务之后。

停止先于 intent 提交时，撤回尚未提交的 queued 输入；intent 已提交则保留可能已经发出的事实，取消并查历史，不能当成未发送撤回。即使尚无活动 Turn，只要有启动或准备任务，就必须保留 stop 标记并中断/回收，不能按空闲路径清除它。准备或提交中收到 stop 后不启动下一条消息，待 SDK handle/原生 turn 建立时立即应用已登记的取消。异步 steer 写 intent 前核对 target_turn_seq 与原生执行引用；目标已结束时撤回仍 queued 的消息并说明原因。写 intent 后的过期目标按 unknown 核查，不流入下一轮。启动失败、完成报告丢失和命令 ACK 丢失分别按本地持久事实恢复。

首次 open 的成功与 stop 在 Worker 的串行状态事务中裁决。成功映射和 thread.opened 尚未提交时，先持久接收的 stop 取消 open，禁止补发 thread.opened；回收已登记进程与迟到创建的 SDK 实例，发送 thread.open_failed（reason 为启动被停止）及 open 的 cancelled 完成结果，再按停止证据结束 stop。该 Thread 保持从未成功打开，不能用残留映射自动恢复或重新创建。

若 open 的成功事务已提交，则其 thread.opened 必须按 WorkerSeq 先于停止报告发出；stop 走已打开会话的正常取消路径。过期启动结果除禁止更新状态外，还必须关闭/回收其资源；停止确认前要排除仍可能派生子进程的启动任务，取消后的控制代次禁止新建资源。最终裁决、命令终态和报告顺序都持久保存，重启不得改变结果。

### 期限与单次准备

| 路径 | 预算与关系 |
|---|---|
| Worker 进程就绪 | Host 最多 3 秒，仅含 Node 启动、账本与认证 IPC；原生初始化在其后异步开始 |
| 命令接收 | Worker 认证与短事务目标期限 1 秒；Host 最多 3 秒加 IPC 1 秒，小于节点 5 秒期限，复用外层剩余期限而不逐段重置；失败用相同命令 ID 查询或重试接收 |
| 原生 open/send | SDK/原生调用预算 30 秒，agent-host 通信 32 秒，Worker 阶段预算 35 秒；逐层保留返回与清理余量 |
| 输入准备 | 整个准备阶段最多 10 秒，历史子调用服从剩余期限；与提交合计最多 45 秒，不占命令接收期限 |
| Stop | 从持久接收 stop 起独立计时，最长一分钟；不能等输入的 45 秒预算耗尽后才开始计时 |
| 后台探测 | 最多 30 秒的非执行任务，服从独立并发和进程回收约束，不阻塞接收命令 |

所有慢操作都是可中断的 Effect，并以 `Effect.timeout` 套上本表预算。Worker 在登记任务时为其建立独立 Scope，不能复用即将结束的 5 秒命令上下文。RestoreInput 只恢复本地基准，不发起历史查询。断开命令 IPC 不中断已经持久接收的执行，持久 stop、阶段超时和 Worker 退出负责中断任务。SEA 冷启动耗时计入 3 秒就绪预算，在三个系统上测量；超出时先缩小 Worker 入口的同步加载，不放宽 Host 期限。

输入准备只在本地完成：prepareInput 生成准备标识并与 intent 原子提交，restoreInput 在进程重启后恢复它，二者都不读取原生历史。新输入、控制代次变化或原生身份变化使准备失效。接收确认与恢复核查见上文 `sent` 的映射。

## Worker 保证与上游行为（R-04～R-09）

以下由 Worker 保证，与具体 adapter 无关：命令先持久接收再执行；intent 提交后才调用 `send`；`send` 结果未知时先调用 `sent`，仍无法确认则进入 unknown，Worker 不再次提交同一输入；stop 有独立登记路径，一分钟内没有终止事件就回收进程树；所有异步结果写状态前核对控制代次。

通用 driver 将上游 `turn.terminal` 的 `failed` 转为带原生会话、输入与执行身份的 `end`（`outcome: failed`），并附安全原因。Worker 按正常结束路径保存 `turn.ended`，现有 `reason` 为 `failed`，`content` 为安全原因；中心将 `end_reason: failed` 写入 `thread_turns`，并把含原因的完整报告保存为时间线事件，无需扩展共享协议。输入保持 sent，Worker 保留 Agent 实例、host 进程与原生会话，继续调度队列。`queue_empty` 在结束事务中计算，中心据此选择 idle 或 running。网页在对应回合显示 `<Agent> could not finish this reply` 与原因，不为此显示 unknown 提示。运行时请求无法应答、事件流断开、发送结果无法确认、host 崩溃或连接丢失仍进入 unknown。

以下按上游实现接受：adapter 内部的请求重试、断线重连和会话恢复（如 Cursor resume 冲突时取消旧 run 再发送，`enableAgentRetries`）；Pi、Codex 的 steer 归属；子任务与后台任务何时算回合结束；中断后的终态时序。T1 在本地抽取 runner 上做的输入不重放修改随 `packages/providers` 一并删除。上游行为导致的问题先在 fork 中修复并提交上游，不在 Baton 接入层另做一套等价逻辑。

## 各 Agent 实现

| Agent | 上游模块 | Baton 要做的 |
|---|---|---|
| Pi | `provider-pi`（`server`、`server/status`、`testing` 导出） | 已接入注册、配置、只读探测与 host 回放；活动插入使用上游 steer |
| Codex | `provider-codex`，依赖 `effect-codex-app-server` | 已接入注册、配置、只读探测与 host 回放；运行策略为 `approvalPolicy: never`、`sandboxPolicy: workspaceWrite`，网络关闭；活动插入使用上游 steer |
| Kiro | `provider-acp` 与 `provider-acp-registry` | 已接入注册、配置、探测与 host；fork 的 `kiroAcp.ts` 启动 `kiro-cli acp --agent-engine=v3`，模型经 `session/new` 的 `_meta.kiro.modelId` 传递，`default` 省略；按 initialize 响应协商 v1。恢复先 `session/list` 核对 cwd/ID 再 `session/load`，失败不新建替代；不支持 steer 与换模型。程序已安装且认证 valid/unknown 时开放 create/resume，版本和系统不限 |
| Cursor | `provider-cursor`（完整 driver 与 adapter） | 已用 `makeCursorAdapterV2` 取代 T1 的抽取 runner；`cursor-host` 泛化为 agent-host；SDK 附带目录与平台包分发方式不变 |
| Grok、Antigravity | `provider-grok`、`provider-acp` | 切换后接入，复用同一宿主层 |

程序、认证、协议与模型发现使用上游 driver 的检查结果，Baton 不另设系统或版本白名单。程序或 SDK 已安装、认证 valid/unknown 时报告 available，未知版本、其他系统、版本探测失败或超时均不阻止创建；缺程序或明确认证 missing 时报告 unavailable。离线回放覆盖的版本和系统范围保留在夹具与验证文档中，缺少验证证据的组合照常开放。

Kiro 的离线行为验证使用 fork 的 ACP replay testkit 与夹具，验证 adapter 行为；真实账号授权由原生程序在实际执行时检查。转录说明见 [fork README](../../upstream/t3code/packages/provider-acp-registry/src/testing/fixtures/kiro/README.md)。

## 历史（R-10）

Thread 历史使用中心已保存的记录：`thread_messages` 保存员工和 Project Agent 发出的输入，`thread_replies` 保存 Worker 上报的回复。网页时间线与 Project 工具 `threads.read` 读取同一份数据，中心按 worker_seq 分页。`history.read`、`history.search` 读取保存在中心的 Project 主对话事件。这与 t3code 用自身事件投影提供历史的方式一致。

设备不保存原生历史，`session.request` 仅用于实时输出读取。网页时间线按中心记录分页。在 Baton 之外继续同一原生会话产生的消息不显示。

## MCP 注入

上游 adapter 已按各 Agent 协议注入 `McpProviderSessionConfig`（endpoint、authorizationHeader、capabilities）。第一版宿主只接上 `McpProviderSessions`，不写入配置。以后向 Thread 中的 Agent 提供 Baton 工具（Thread、事项、记忆、`nodes.exec`）时，由 batond 开本地 MCP endpoint，按 Thread 发放凭据并经 WSS 转发到中心复用 Project 工具的权限检查；这项能力单独写规格，放在第一版之后。

## 注册、配置与设备能力（R-01～R-03、R-07、R-12）

执行与探测共用 `src/agents/registry.ts` 中的无状态注册描述。描述包含类型、对应的 t3code driver 与设置、探测和静态能力上限；不保存 live adapter 或凭据。未知类型一律拒绝，不退回 shell。

| Agent | Binary / 配置入口 | 能力 |
|---|---|---|
| Pi | PATH 中的 `pi`；`PI_CODING_AGENT_DIR`、`PI_CODING_AGENT_SESSION_DIR`；Thread `model` | 新建、排队、插入、停止、恢复；Thread 内逐轮换模型 |
| Codex | PATH 中的 `codex`；`CODEX_HOME`；Thread `model` | 新建、排队、插入、停止、恢复；Thread 内逐轮换模型 |
| Kiro | local settings：`agentId: kiro`、`commandPath: kiro-cli`，从 PATH 查找；profile 为 `homedir()`；模型取 `model ?? adapter_config.model ?? 'default'` | adapter 支持新建、排队、停止、恢复；不支持插入或换模型；程序已安装且认证 valid/unknown 时开放 create/resume，版本和系统不限 |
| Cursor | 随 batond 分发的 SDK、平台辅助包与本机 shell | 按上游 driver 报告的能力 |
| Grok、Antigravity | 切换后接入时确定 | 切换后接入时确定 |

`agents/capabilities.ts` 按固定上游 adapter 的能力与 Baton 已实现的执行路径报告：Pi、Codex 支持 steer，Cursor、Kiro 上游不支持；四个 Agent 均支持新建、排队、停止与恢复。Pi、Codex、Cursor 开放 `switch_model`。Worker 在准备输入时解析逐消息模型，省略时取账本中最近 `sent` 的 queue 输入模型或创建配置，并在 intent 中持久保存；失败或撤回的输入不改变继承模型。通用 driver 把该选择同时传入 `startTurn.modelSelection` 和 `appThread.modelSelection`。Pi adapter 在 prompt 前调用 `set_model`，Codex 在每次 `turn/start` 传模型，Cursor 在恢复会话和 SDK send 时传模型；steer 不接受模型。Kiro 的 fork adapter 在 `kiroAcp.ts` 的 `kiroCapabilityOverrides` 中明确关闭 `supportsActiveSteering`、`supportsSteeringByInterruptRestart` 和 `supportsModelSwitchInSession`；Baton 按该固定实现报告能力。该覆盖不证明 Kiro CLI 的所有版本都缺少对应协议方法。`capabilityLimitations` 将这些原因写入报告。仅存在明确的数据丢失、越权或重复副作用风险时进一步限制已实现能力。

Kiro settings 固定为 `source: local`，不拉取 registry 包；上游 Kiro driver 不读取专有环境变量，host 只继承系统项，不提供 `BATON_KIRO_*` 或 `KIRO_HOME` 配置入口。Pi、Codex 的配置目录分别按各自原生变量传递，不改写系统 HOME。Antigravity 需要额外启动路径时增加结构化、非敏感本机配置，先通过验证再固定其字段。

各 Agent 的非敏感程序、模型与状态位置按注册表配置及原生映射保存。逐轮模型保存在 Worker 输入账本，恢复使用最近确认提交的 queue 输入模型，保留创建配置用于 open 幂等校验；Kiro 的模型在 Thread 内固定，`default` 不作为模型 ID 发往原生协议。

Pi 上游 `ProviderAdapterTurnStartError.cause` 为 `PiRpcError(operation: set_model)`，或 Cursor 报 `CursorModelUnavailableError` 时，错误证明 prompt 尚未提交。host 通过本地 RPC 的 `AgentHostError.modelRejected` 传递该事实，Worker 将 intent 持久撤回，清除活动输入并继续队列，不增加已确认发送数。选择超时、传输错误、Codex 的通用提交错误和其他缺少确定证据的失败保留 unknown；恢复只调用只读 `sent` 核对原生历史，不自动重发。若撤回事实尚未持久化就中断，intent 仍按不确定输入恢复。恢复核查 Thread、原生 ID、工作目录和 profile 位置；不保存 API key、token 或凭据内容的摘要。检测到账号无法访问原会话就失败，不换用 ambient 凭据。

Kiro 的 `beforeLoadSession` 先用 `session/list` 检查 ID 与 cwd，再 `session/load`；通用 driver 的可选 `resumeOnOpen` 仅 Kiro 设为 `true`，resume 与 sent 均在 `openSession` 中传入 `initialNativeThreadId`，避免 ACP 先新建空会话。fork 启用 `failClosedOnSessionLoad`，会话缺失或 load 失败不退回 `session/new`。`readThreadSnapshot` 同样走核对与 load，通用 `sent` 仅匹配已确认发送数之后的下一条 user 正文，缺少证据时保持未确认。

节点报告正式采用 `{agent_type, version, status, reason, models, default_model, capabilities}`。`RuntimeAgent.reason` 为可选 UTF-8 摘要，最多 1024 字节，禁止 NUL、控制字符和凭据；协议校验同时计入现有 64 KiB 报告预算。超长或未脱敏的 SDK 原始输出不能直接写入 reason。删除节点私有包装对同名字段的补写，生产与测试统一走正式结构。

```text
注册表探测（batond 进程内）→ RuntimeReport → Coordinator 解码及验证
        → node_runtime_reports.report(JSONB)
        → GET /api/v1/nodes、devices.list → status/create/reason
```

中心按正式字段重新编码后保存，reason 不作为未知字段丢弃；只改变 reason 也应递增 report_version 并推送设备变更。查询 DTO 和 Project Agent 工具响应保留同一摘要，不从异常字符串重新推测状态。JSONB 增加字段无需数据库表或列迁移；现存报告由当前节点重新上报替换。

Web 的 NodeDTO、DeviceAgent 和 mapDevice 保留 status、create 和 reason，未知 status 默认不可创建；只允许 `status === available && capabilities.create === true`。unverified 与 unavailable 都不可创建且展示原始脱敏原因。同步扩展已注册的类型、Thread 映射和 Project Agent 的设备选择。中心现有同条件准入继续保留，客户端可选状态不能放宽服务端检查。

### 探测

探测在只读 agent-host 中调用上游 driver 的安装、认证与模型检查，版本按各 Agent 的探测路径取得，返回分开的安装/版本、认证和模型目录结果。探测不发送 prompt、不调用 authenticate/login 或打开登录浏览器，使用临时空工作目录和空 MCP 配置；Kiro 的完整探测仍调用 `checkAcpRegistryProviderStatus` 与 `probeAcpRegistryConfiguration`，由上游建立空的发现会话以读取能力与模型。其余隔离行为以上游实现为准。每个任务最多 30 秒；TS daemon 每轮探测结束后默认间隔 30 秒重新执行，失败结果不会因路径或版本未变而永久缓存，结束或失败后回收进程树。模型目录用于发现与补全，显式 ID 交给原生 Agent 判定，换模型继续受已实现能力限制。

四个 Agent 在程序或 SDK 已安装、认证 valid/unknown 时报告 available，开放 create/resume；缺程序或明确 missing 时 unavailable。reason 记录版本、系统、认证未知、模型目录问题和未开放能力的原因；版本探测失败或超时不阻止创建。模型目录失败时可按默认模型创建。整次 host 探测失败且安装状态未确认时保持 unverified，避免将探测故障误报成程序缺失。Cursor 在主进程先检查 SDK 资产与平台包版本一致性，host 再检查辅助程序和 sandbox，明确失败时 unavailable；已确认 SDK 安装完整后，整次 host 探测失败或超时保留诊断并允许创建。

Kiro 在上游 status 之外运行 `kiro-cli --version`。`src/agents/kiro/version.ts` 使用 host 提供的 Node Effect `ChildProcessSpawner`，经包装 spawner 交给 process registrar 管理，Scope 结束或超时后回收进程。版本命令限时 4 秒，stdout/stderr 各最多收集 4096 字节，只返回解析出的版本号；原始输出与诊断留在 host 内，不进入能力报告。命令超时、失败、输出超限或不可解析时，版本为 `unknown` 并记录原因；已安装时仍为 available。缺少程序时为 `unavailable`。

`hostedAgentReport` 对 Cursor、Pi、Codex、Kiro 共用安装与认证规则：已安装且认证为 valid 或 unknown 时报告 `available`、`create: true`、`resume: true`。版本与系统写入 reason，认证 unknown 提示首次执行由原生程序检查；明确 missing 则为 `unavailable` 并拒绝。网页按节点报告开放新建与恢复，不符合准入条件的新建请求返回 HTTP 422、`agent_unavailable`。本地 CLI 的 `open --agent cursor|pi|codex|kiro` 默认 Cursor，支持显式模型与每轮执行时限；`message --mode queue|steer` 默认排队，Worker 按实际能力校验。

Kiro 的 `turnFailure` 回调处理真实回合的 provider failure：明确认证失败映射为“Sign in to Kiro CLI and try again.”，其他 provider 错误映射为“Check Kiro CLI on this device and try again.”。其他 Agent 的失败原因固定为 `Send your message again or check <Agent> on this device.`。通用 driver 将安全原因随失败结束事件交给 Worker，保存到 `turn.ended.content`；不透传原始错误，不自动登录，不重发输入。

节点处理 open 时读取已完成的探测快照，不在 5 秒命令上下文内同步探测；尚在探测时返回明确的不可用原因，探测完成后重新上报。

## 安装包与代码复用

Baton fork 托管 Baton 的改动分支，`upstream/t3code` 固定到其中一个提交，升级上游时在 fork 中合并后再移动 submodule。fork 地址、固定提交和 Baton 补丁清单记录在 `third_party/t3code/README.md`，保留上游 MIT 许可与版权。

batond bundle 直接打包用到的 `@t3tools/*` 包及其纯 JS 依赖。原生模块和需要磁盘布局的依赖（`@cursor/sdk` 与平台包、`@napi-rs/keyring`）放在 SEA 旁的附带 `node_modules`，打包检查见迁移 TECH。宿主层提供凭据文件后，若 keyring 不再被调用，可在 fork 中去掉该依赖。

## 验证策略

所有适配器行为验证仅依赖上游离线测试、上游转录与 `provider-testing` 回放、Baton 本地替身。测试与验证脚本禁止要求真实 API Key、启动真实 `kiro-cli`、调用在线模型推理或与外部真实服务联调。

Kiro host 回放使用上述授权转换的夹具，验证范围包括真实 adapter 的新建、两轮、停止（含工具运行中）、恢复、`restore_missing` 失败和 `sent` 的确认与未确认；工具中断夹具中的权限请求经真实 adapter 返回 `allow_once`。进程回收用真实 Kiro adapter 与本地 ACP 协议替身，确认 ACP 独立进程组及同组 grandchild 在正常关闭和 host SIGKILL 后均退出，强杀路径由 registrar watchdog 回收。`e2e/src/provider-agents.integration.test.ts` 通过注入已验证 capability 驱动真实 Kiro adapter，覆盖网页 API 发送、回复、中心 idle、停止与恢复；此注入验证自动化行为，不能证明真实账号授权有效；生产报告按节点探测到的安装与认证状态决定，版本和系统保留为诊断信息。

版本探测测试使用本地可执行替身，验证 stdout/stderr 版本解析、预发布后缀保留、诊断不外传、非零退出、缺程序和超时后进程退出，不启动真实 CLI。注册表测试核对四个 Agent 的未知版本、其他系统、认证 unknown 和版本超时均放行，缺程序与明确 missing 拒绝；Cursor 的只读 host 探测失败保留诊断，明确依赖或 sandbox 失败时拒绝。认证失败场景由 `provider_error` 派生夹具驱动真实 adapter、agent-host 与 Worker；该夹具和原始 provider 错误场景分别接上 `simple` 的成功回合，来源记录在 metadata。测试核对失败原因持久化、原始错误不外传、输入保持 sent、排队消息继续执行、最终 idle，以及原生会话和进程保留。跨 app e2e 核对中心读取失败原因和 idle 后，再发消息能收到回复。

| 范围 | 验证 | 层次 |
|---|---|---|
| fork 中用到的包 | 运行各包上游测试；Codex 拆包与 `kiroAcp` 的新增测试 | 上游模块测试 |
| 宿主层 | 各 service 的路径、凭据、环境白名单；spawner 登记进程组 | 包内单测 |
| 事件映射 | 用上游 testkit 替身驱动真实 adapter，核对 reply、end、uncertain 与 `sent` 判定 | 确定性回放 |
| Worker 保证 | 沿用 T1～T3 的接收、intent、unknown、停止裁决与回收测试，换成 agent-host 替身 | Worker 集成 |
| 主链路 | 每种 Agent 一条网页发送到回复、停止、恢复的回放链路 | e2e |
| 历史 | 网页与 `threads.read` 读取同一份中心 Thread 记录，分页与权限正确 | 中心集成与 Web 契约 |
| 探测与 reason | 四个 Agent 已安装且认证 valid/unknown 时 available；未知版本、其他系统、版本失败或超时只记入诊断。缺程序、明确认证缺失或 Cursor 明确依赖/sandbox 失败时 unavailable；整次探测未确认安装时 unverified；未开放能力写明原因 | 包内与本地可执行替身 |
| Kiro 回合失败 | `provider_error` 与派生认证失败经真实 host/Worker 保存失败原因，输入保持 sent，后续排队消息执行并收到回复、原生会话与进程保留；中心时间线可读原因、空队列时 idle，网页在对应回合显示失败 | 确定性回放、Worker 集成、跨 app e2e 与网页数据层 |
| 安装包 | 脱离源码运行 SEA，加载 t3code 依赖与附带目录 | 打包检查（T5） |

## 实施状态

[迁移任务清单](../ts-migration/TASKS.md) 中的 T1～T4 已完成。`upstream/t3code` 固定到 Baton fork，workspace 收录所需包及其上游离线测试；agent-host 提供共用宿主层与事件映射，Cursor、Pi、Codex、Kiro 均通过完整 adapter 接入。网页时间线与 Project 工具 `threads.read` 从中心记录读取 Thread 历史。

T5 负责完整安装包、发布切换与系统矩阵复验。Grok、Antigravity 在切换后接入，复用同一宿主层。

## 上游参考

所有链接固定到 fork 基线提交。

| 参考 | 用途 |
|---|---|
| [ProviderAdapter](https://github.com/pingdotgg/t3code/blob/9828cad/packages/provider-core/src/server/ProviderAdapter.ts)、[ProviderHost](https://github.com/pingdotgg/t3code/blob/9828cad/packages/provider-core/src/server/ProviderHost.ts)、[接入约定](https://github.com/pingdotgg/t3code/blob/9828cad/docs/internals/adding-a-provider.md) | adapter 接口与宿主 service |
| [McpProviderSessions](https://github.com/pingdotgg/t3code/blob/9828cad/packages/provider-core/src/server/McpProviderSessions.ts)、[mcpSession](https://github.com/pingdotgg/t3code/blob/9828cad/packages/provider-core/src/server/mcpSession.ts) | MCP 注入配置 |
| [Pi](https://github.com/pingdotgg/t3code/blob/9828cad/packages/provider-pi/src/server/adapter.ts)、[Codex](https://github.com/pingdotgg/t3code/blob/9828cad/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts)、[共享 ACP](https://github.com/pingdotgg/t3code/blob/9828cad/packages/provider-acp/src/server/adapter.ts)、[ACP registry](https://github.com/pingdotgg/t3code/tree/9828cad/packages/provider-acp-registry/src/server)、[Cursor](https://github.com/pingdotgg/t3code/blob/9828cad/packages/provider-cursor/src/server/adapter.ts) | 各 Agent 实现 |
| [历史分页](https://github.com/pingdotgg/t3code/blob/9828cad/apps/server/src/orchestration-v2/threadHistoryPaging.ts)、[provider-testing](https://github.com/pingdotgg/t3code/tree/9828cad/packages/provider-testing) | 历史投影与回放测试 |

## 待验证与批准事项

| 项目 | 缺口 | 处理与阻塞范围 |
|---|---|---|
| FULL 同步提交耗时 | 输入 intent、大队列、Windows 和 Linux x64 未测 | 复现与负载范围见迁移 TECH；p99 超过 50 ms 时改用 worker_threads |
| Windows 进程回收 | taskkill 有父进程先退出和 Worker 崩溃后延迟回收两个缺口 | 已接受为第一版范围；Job Object 放第一版之后 |
| 上游进程组 | 上游 adapter 自建 detached 进程组时的登记 | `agent-host/reclaim.integration.test.ts` 验证并组与独立 pgid 回收；Kiro `reclaim.integration.test.ts` 以真实 adapter 和本地 ACP 替身验证独立组与 grandchild，正常关闭、仅强杀 host 均回收。Pi、Kiro host 回放覆盖工具中断 |
| Cursor 认证 | 上游 driver 使用 credential store 与 keyring | 已定：只用设备显式配置的 `CURSOR_API_KEY`，经 adapter 的 `environment` 注入；`ProviderHost.credentials` 保持只读空实现 |
| Kiro ACP | 离线验证不证明真实账号授权有效 | 程序已安装且认证 valid/unknown 时开放 create/resume，版本和系统不限；reason 提示首次原生执行检查，明确 missing 拒绝；上游不支持 steer 和换模型 |
| agent-host 冷启动 | 加载 t3code 依赖后的启动耗时未测 | 不计入 Worker 3 秒预算；open 仍受 30 秒原生预算约束，T5 复验 |
| t3code 依赖打包 | `@t3tools/shared` 的 markdown 依赖与 keyring 原生模块进 SEA 未验证 | T5 打包检查；不需要的依赖在 fork 中去掉 |
| Grok、Antigravity | 切换后接入，安装、认证与恢复证据未核查 | 只阻塞各自交付 |

审批本设计不等于上述组合已通过验证。实施记录保存在测试与 fork 的补丁说明中，长期规格原地更新其最终行为。
