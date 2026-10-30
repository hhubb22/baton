# Agent 适配与扩展技术设计

Status: draft
Basis: [行为规格](PRODUCT.md)；[Baton TECH](../baton/TECH.md)；[发布设计](../release/TECH.md)；fork 固定提交与补丁见 [t3code 来源](../../third_party/t3code/README.md)。

Thread 创建 DTO、持久记录、Worker 配置和原生映射携带执行模式，准入按设备报告的模式能力检查。Full access 的原生参数由上游 adapter 映射，Baton 不复制该映射。

## 实现边界

当前实现包含 Worker 的认证 IPC、持久命令回执、intent 账本、停止裁决与 outbox，batond 的注册、WSS 和 Worker 管理，中心与网页的远程 Thread、Project 和设备管理。Cursor、Pi、Codex、Kiro 经 `agent-host` 子进程使用 fork 的完整 provider adapter。Kiro 在程序已安装且认证 valid/unknown 时报告可用，版本和系统不限，开放网页新建与恢复。适配器行为以完整上游实现和当前 PRODUCT 为依据，离线验证复用 fork 的测试与转录；Kiro 夹具说明见 [fork README](../../upstream/t3code/packages/provider-acp-registry/src/testing/fixtures/kiro/README.md)。

Agent 接入整包依赖 Baton 维护的 t3code fork，使用其完整 provider 包和 `ProviderAdapterV2` 接口，接受上游的协议处理、重试、重连、steer、取消和事件归一化行为。Baton 不为产品差异修改上游 adapter；上游缺少的能力（如 Kiro）在 fork 中按上游写法补齐。包体积和依赖范围在第一版接受现状，之后再按需要逐步转写为自实现。

Baton 保留自己的 Worker 可靠层、中心和网页：持久接收、intent 先于原生提交、未知不由 Worker 重发、控制代次、停止证据与进程树回收继续由 Worker 负责。上游的 Run、checkpoint、rollback、fork 和 MCP 工具集不作为 Baton 产品能力暴露；原生待审批请求按 R-11 通过 Thread 交给员工处理。产品条目下文简称 R-01 至 R-12，均指配套行为规格。

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

目录职责与实现入口统一见 [AGENTS.md](../../AGENTS.md#核心架构与目录)。

Worker 通过 `agents/thread-agents.ts` 和纯数据 catalog 装配执行工厂，不加载探测、SDK、provider adapter 或 host driver，保持就绪预算（Windows 10 秒，其余系统 3 秒）。`buildBatond` 检查 Worker 运行时依赖图，覆盖静态导入、再导出和字面量动态加载，禁止绕入 host 实现或不可解析的动态加载。daemon 与普通 CLI 通过 `agents/probe.ts` 探测，Cursor 安装预检只通过 `sdk-inspection.ts` 读取元数据与资产路径。执行 agent-host 由 `cli/agent-host.ts` 按类型动态加载对应模块，Cursor SDK 只在 Cursor host 内执行。安装包的 `agent-host --probe` 会加载四个 Agent 模块以检查完整性。每个执行 Thread 一个 agent-host，它是 POSIX 进程组组长或 Windows Worker 账本登记的根进程。POSIX 的上游独立组由 host 内部 registrar/watchdog 另行管理；Windows registrar 不另行登记上游子进程，回收受下文平台边界约束。探测在 batond 拉起的只读 agent-host 中执行，用同一套平台接口回收。

### 宿主层

agent-host 为上游 adapter 提供它要求的 Effect service：

| service | Baton 提供的实现 |
|---|---|
| `ChildProcessSpawner`、`FileSystem` | `@effect/platform-node`；POSIX spawner 将上游独立组登记给 host 自己的 registrar/watchdog；Worker 账本登记 host 根进程，Windows registrar 返回 false |
| `AgentScope` | `wrap` 透传命令，`stop`、`clear` 为空；adapter/spawner Scope 释放各自资源，Worker 执行外层整树回收 |
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

`prepareInput` 与 `restoreInput` 不读取原生历史，InputPreparation 只保存原生会话、准备标识和 Worker 已确认的发送数。运行时权限请求、`user_input` 和 `mcp-elicitation` 通过 `turn_item.updated` 的问题内容和 `runtime_request.updated` 的请求身份关联，保存到 Worker 账本并报告中心，网页提供原生批准选项、文本回答和取消。Codex 的 MCP elicitation 按上游提供的确认语义回答；ACP 表单由上游转换为结构化问题。其他请求返回取消。停止后的请求取消，执行结束或 Worker 恢复时关闭旧问题；提问期间继续计入本轮执行时限。回答命令与原请求及执行身份绑定，在调用上游前持久保存 intent；结果不确定时保留诊断并禁止自动重发。上游的 `rollbackThread`、`forkThread`、`compactThread` 与 `uploadFeedback` 不接入。

## 运行时与进程模型（R-08、R-12）

### 运行时与本地存储

Worker 运行在 batond SEA 携带的 Node 26 上，依赖 `effect` 4 与 `@effect/platform-node`，版本在 pnpm catalog 中统一锁定。账本复用已有 `packages/sqlite`，在现有表的数据职责基础上设计 TS schema，保存下文命令、输入基准和进程字段，不读旧账本。提交结果不确定时使用 SqlClient 的提交核查；仍无法确认则停止执行并从持久事实恢复。

账本保持 `journal_mode=WAL`、`synchronous=FULL`。t3code 使用 NORMAL，因为 `node:sqlite` 在主线程同步提交，FULL 会让每次提交的 fsync 停住事件循环。Baton 的 intent 必须在调用原生提交前落盘，NORMAL 在断电时可能丢掉已提交的 intent，所以不采用。每个 Thread 一个 Worker 进程，提交卡顿只影响该 Thread；已记录 macOS arm64、Linux x64 与 arm64 的实际账本测量，此负载提交 p99 均低于 50 ms；Windows 尚无数据。负载范围与数值集中在 [发布验证](../release/TECH.md)，若后续测量或实际命令接收延迟超标，再评估 `worker_threads`。

账本里保存的单调时间使用 `process.hrtime.bigint()`。它在同一次开机内跨进程可比，但不计系统睡眠，所以设备睡眠期间停止计时会暂停，唤醒后才到期；这只会推迟强制回收，不影响 unknown 判定。batond 的 Project Runtime 租约与 Worker 的 Turn 执行时限均计入睡眠，做法见 [Baton 平台实现](../baton/TECH.md#平台相关实现)。

### 进程组与停止回收

每个执行 Thread 独占一个 agent-host 进程及其后代，本期不做跨 Thread 的 app-server 或 SDK host 共享。Cursor 将 SDK 的 detached 后代并入 host 进程组。Pi、Codex、Kiro 的 `foldDetached: false` 保留原生进程组供上游发送组信号，包装 spawner 用 process registrar 登记独立进程组；release 在注销前回收整树，仅在回收成功或确认 PID 身份不符时注销。超时和检查失败返回错误并记录警告，保留登记供 watchdog 在 host 退出后继续回收；watchdog 确认注销后才删除本地登记。该路径无需修改上游共享进程模块。

| 系统 | 启动 | 停止超时（一分钟）后 | Worker 意外退出 |
|---|---|---|---|
| macOS、Linux | `detached: true`，Agent 成为独立进程组组长 | `process.kill(-pgid, "SIGKILL")` | `watchdog` 子命令持有私有管道读端，读到 EOF 即对已登记的进程组发 SIGKILL |
| Windows | 普通子进程，PID 与进程创建时间写入账本 `thread_processes` | `taskkill /PID <pid> /T /F` | 下次 Worker 启动时读取 `thread_processes`，PID 与创建时间都匹配的进程用 `taskkill /T /F` 结束，再清除记录 |

POSIX 的 watchdog 是 batond 可执行文件的 `watchdog` 子命令：Worker 被强杀时内核关闭管道写端，watchdog 不依赖 Worker 配合。Worker 把每个新建的进程组 ID 通过该管道登记给 watchdog。

Windows 第一版接受两个已知缺口。`taskkill /T` 按父 PID 向下查找，中间进程先退出时，其后代会漏掉；Worker 被强杀后，到下次 Worker 启动之间 Agent 进程会继续运行。Windows 进程创建时间在恢复时通过 PowerShell `Get-CimInstance Win32_Process` 读取，用于排除 PID 复用。kill-on-close Job Object 放在第一版之后，需以原生模块接入平台回收接口。全局停止与恢复规则见 `specs/baton/TECH.md`，两处采用相同的 Windows 边界。

停止先等待 Turn 终止或回收证据，再回收执行实例与持久进程记录；全部确认后写 `thread.stopped`，未确认则 unknown。回收测试用本地替身创建 detached 后代，核对整棵进程树退出，不能只看 agent-host PID 已消失。batond 重启仍通过已有认证 IPC 连接存活的 Worker，不因重连重开 Agent。

### Worker IPC

Worker IPC 使用令牌认证与固定端点：POSIX 为私有目录下的 UDS，Windows 为命名管道。Node 的 `net` 模块可直接监听两者，但不能给命名管道设置只允许当前用户的安全描述符，第一版依靠令牌认证，令牌保存在私有数据目录中（见 [Baton 平台实现](../baton/TECH.md#平台相关实现)）。消息结构以 `packages/protocol` 为准，`ThreadReport` 的 `command_id`、`command_outcome` 表达命令终态，`RuntimeAgent.reason` 保存能力诊断。Worker 以 detached 方式启动，batond 重启后通过同一端点重新连接。

## Worker 接收与异步执行（R-04、R-05、R-08）

### 启动与命令回执

Worker 取得 Session 文件锁、打开并验证本地账本后，先建立认证 IPC，再接收或恢复持久启动意图。首次启动须先接收 thread_open 并保存回执，才调度原生初始化；重启则只恢复已有持久意图。Host 的就绪等待只检查 Worker 的认证就绪状态，不等待 Agent；已存在的启动中 Worker 不得被再次拉起。`status` 区分 `worker_ready` 与 `agent_ready`，节点账本中的 ready 只表示本地 Worker 已接管，不能触发中心的 thread.opened。

Worker 以短事务接收命令。`thread_commands(id, payload)` 的 JSON 保存内容摘要、接收回执和执行结果，状态为 accepted/running 或终态 succeeded/failed/cancelled/unknown；通过 IPC 传递中心原始命令 ID。接收回执与该命令的状态或队列变更在同一事务提交。相同 ID、相同内容返回原回执和已知结果，内容不同时拒绝，不因已 ACK 再次执行。消息仍按 client_message_id 唯一，不同传输命令 ID 绑定到同一消息及同一执行结果。

所有命令终态、对应业务状态和最终报告在同一个 Worker 事务写入。`command.completed` 报告携带 `command_id`、`command_outcome`、reason 和 storage_generation；同事务先写相关 thread.opened/resumed、message.sent/withdrawn/unknown 或停止报告，再写完成报告。open/resume 在实际打开或恢复后完成，message 在原生输入确认或明确撤回/未知后完成，stop 在停止证据或未知结果确定后完成。重启扫描 accepted/running 和持久意图，不能仅依赖内存任务队列；终态命令只补送 outbox，不再次调度。

中心以 thread_outbox.acked_at 表示设备已持久接收，以 completed_at、completion(JSONB) 保存执行结果。正 ACK 不设置 completed_at，执行前的明确拒绝同时结束命令；command.completed 按命令 ID、Thread、节点与存储代次验证后写完成状态。完成报告先于接收 ACK 到达也有效，迟到 ACK 不能覆盖完成结果。ThreadView.resume_pending 和恢复请求去重查询 action=resume 且 completed_at 为空，持续到成功、失败、停止取消或未知终态；期间重复恢复请求复用同一待完成命令。

本地账本丢失或旧存储代次失效时，中心的历史缺失处理同时将受影响的待完成命令结束为 unknown，不能让已无法恢复的 resume 永久保持 pending。

| 命令 | IPC 返回前完成 | 异步完成与报告 |
|---|---|---|
| open | 保存配置、启动意图与命令回执 | 原生建立及映射持久化后发 thread.opened，失败发 thread.open_failed |
| message | 校验归属和能力，保存 queued 消息与回执；steer 同时固定当前 target_turn_seq，无活动回合则拒绝 | 必要时恢复原生会话；准备、intent、提交后发 message.sent/unknown/withdrawn |
| resume | 校验允许恢复，保存 resumeRequested 与回执 | 恢复后发 thread.resumed，失败保持 stopped 或 unknown |
| stop | 同事务保存停止标记、撤回 queued、递增控制代次与回执 | 中断正在启动、准备或提交的任务；等待终止证据并核实实例和持久进程回收，报告 stopped 或 unknown |

open 的成功 `ThreadCommandResult` 携带当前 `storage_generation`，中心校验当前连接后将它写入 Thread 已有字段，但不设置 opened_at、native_session_id 或 idle。这样 Agent 仍在初始化时，stop 已能携带正确代次到达节点。opened 报告可能先于 ACK 到达，二者须核对同一代次；迟到旧连接或不同代次不能覆盖现有归属。网页根据在线状态、接收确认和 opened_at 展示“设备已接收，Agent 正在启动”，不把 Worker ready 显示为 Agent 空闲。

`thread_meta.payload` 保存 `resumeRequested` 和 `epoch`；`thread_messages.payload` 以 `preparation` 保存准备证据，以 `targetTurn` 固定异步 steer 目标，并保存执行身份与结束标记。`thread_processes(pid, created_at, role)` 保存所属进程；完整物理结构见 [Worker 账本](../baton/TECH.md#worker-账本)。

状态变更和 SQLite 事务由一个串行的 Effect 队列处理；原生 Start、历史读取、模型配置、Send、Abort 和进程等待作为独立 fiber 在队列外执行。每个异步结果携带控制代次、操作标识和原生会话引用，过期结果不能改变新状态。stop 有独立登记与中断路径，不能排在发送 fiber 或启动任务之后。

停止先于 intent 提交时，撤回尚未提交的 queued 输入；intent 已提交则保留可能已经发出的事实，取消并查历史，不能当成未发送撤回。即使尚无活动 Turn，只要有启动或准备任务，就必须保留 stop 标记并中断/回收，不能按空闲路径清除它。准备或提交中收到 stop 后不启动下一条消息，待 SDK handle/原生 turn 建立时立即应用已登记的取消。异步 steer 写 intent 前核对 target_turn_seq 与原生执行引用；目标已结束时撤回仍 queued 的消息并说明原因。写 intent 后的过期目标按 unknown 核查，不流入下一轮。启动失败、完成报告丢失和命令 ACK 丢失分别按本地持久事实恢复。

首次 open 的成功与 stop 在 Worker 的串行状态事务中裁决。成功映射和 thread.opened 尚未提交时，先持久接收的 stop 取消 open，禁止补发 thread.opened；回收已登记进程与迟到创建的 SDK 实例，发送 thread.open_failed（reason 为启动被停止）及 open 的 cancelled 完成结果，再按停止证据结束 stop。该 Thread 保持从未成功打开，不能用残留映射自动恢复或重新创建。

若 open 的成功事务已提交，则其 thread.opened 必须按 WorkerSeq 先于停止报告发出；stop 走已打开会话的正常取消路径。过期启动结果除禁止更新状态外，还必须关闭/回收其资源；停止确认前要排除仍可能派生子进程的启动任务，取消后的控制代次禁止新建资源。最终裁决、命令终态和报告顺序都持久保存，重启不得改变结果。

### 期限与单次准备

| 路径 | 预算与关系 |
|---|---|
| Worker 进程就绪 | Host 最多 3 秒，Windows 最多 10 秒，仅含 Node 启动、账本与认证 IPC；原生初始化在其后异步开始 |
| 命令接收 | Worker 认证与短事务目标期限 1 秒；Host 就绪等待加 IPC 1 秒，复用外层剩余期限而不逐段重置；Windows 上就绪等待可能超过节点 5 秒期限，此时命令失败，以相同命令 ID 查询或重试接收，启动中的 Worker 不会被再次拉起 |
| 原生 open/send | SDK/原生调用预算 30 秒，agent-host 通信 32 秒，Worker 阶段预算 35 秒；逐层保留返回与清理余量 |
| 输入准备 | 整个准备阶段最多 10 秒，历史子调用服从剩余期限；与提交合计最多 45 秒，不占命令接收期限 |
| Stop | 从持久接收 stop 起独立计时，最长一分钟；不能等输入的 45 秒预算耗尽后才开始计时 |
| 后台探测 | 最多 30 秒的非执行任务，服从独立并发和进程回收约束，不阻塞接收命令 |

所有慢操作都是可中断的 Effect，并以 `Effect.timeout` 套上本表预算。Worker 在登记任务时为其建立独立 Scope，不能复用即将结束的 5 秒命令上下文。RestoreInput 只恢复本地基准，不发起历史查询。断开命令 IPC 不中断已经持久接收的执行，持久 stop、阶段超时和 Worker 退出负责中断任务。SEA 冷启动耗时计入就绪预算，在三个系统上测量。Windows 上新 Worker 首次读取自身创建时间要启动 PowerShell（约 2～3 秒），预算为 10 秒；其余系统为 3 秒，超出时先缩小 Worker 入口的同步加载。

输入准备只在本地完成：prepareInput 生成准备标识并与 intent 原子提交，restoreInput 在进程重启后恢复它，二者都不读取原生历史。新输入、控制代次变化或原生身份变化使准备失效。接收确认与恢复核查见上文 `sent` 的映射。

## Worker 保证与上游行为（R-04～R-09）

以下由 Worker 保证，与具体 adapter 无关：命令先持久接收再执行；intent 提交后才调用 `send`；`send` 结果未知时先调用 `sent`，仍无法确认则进入 unknown，Worker 不再次提交同一输入；stop 有独立登记路径，一分钟内没有终止事件就回收进程树；所有异步结果写状态前核对控制代次。

通用 driver 将上游 `turn.terminal` 的 `failed` 转为带原生会话、输入与执行身份的 `end`（`outcome: failed`），并附安全原因。Worker 按正常结束路径保存 `turn.ended`，现有 `reason` 为 `failed`，`content` 为安全原因；中心将 `end_reason: failed` 写入 `thread_turns`，并把含原因的完整报告保存为时间线事件，无需扩展共享协议。输入保持 sent，Worker 保留 Agent 实例、host 进程与原生会话，继续调度队列。`queue_empty` 在结束事务中计算，中心据此选择 idle 或 running。网页在对应回合显示 `<Agent> could not finish this reply` 与原因，不为此显示 unknown 提示。运行时请求无法应答、事件流断开、发送结果无法确认、host 崩溃或连接丢失仍进入 unknown。

以下按上游实现接受：adapter 内部的请求重试、断线重连和会话恢复（如 Cursor resume 冲突时取消旧 run 再发送，`enableAgentRetries`）；Pi、Codex 的 steer 归属；子任务与后台任务何时算回合结束；中断后的终态时序。上游行为导致的问题先在 fork 中修复并提交上游，不在 Baton 接入层另做一套等价逻辑。

## 各 Agent 实现

| Agent | 上游模块 | Baton 要做的 |
|---|---|---|
| Pi | `provider-pi`（`server`、`server/status`、`testing` 导出） | 已接入注册、配置、只读探测与 host 回放；活动插入使用上游 steer |
| Codex | `provider-codex`，依赖 `effect-codex-app-server` | 已接入注册、配置、只读探测与 host 回放；运行策略为 `approvalPolicy: never`、`sandboxPolicy: workspaceWrite`，网络关闭；活动插入使用上游 steer |
| Kiro | `provider-acp` 与 `provider-acp-registry` | 已接入注册、配置、探测与 host；fork 的 `kiroAcp.ts` 启动 `kiro-cli acp --agent-engine=v3`，模型经 `session/new` 的 `_meta.kiro.modelId` 传递，`default` 省略；按 initialize 响应协商 v1。恢复先 `session/list` 核对 cwd/ID 再 `session/load`，失败不新建替代；不支持 steer 与换模型。程序已安装且认证 valid/unknown 时开放 create/resume，版本和系统不限 |
| Cursor | `provider-cursor`（完整 driver 与 adapter） | `makeCursorAdapterV2` 在独立 agent-host 内运行；SDK、生产依赖与平台包通过附带目录分发 |
| Grok、Antigravity | `provider-grok`、`provider-acp` | 待接入，复用同一宿主层 |

程序、认证、协议与模型发现使用上游 driver 的检查结果，Baton 不另设系统或版本白名单。程序或 SDK 已安装、认证 valid/unknown 时报告 available，未知版本、其他系统、版本探测失败或超时均不阻止创建；缺程序或明确认证 missing 时报告 unavailable。离线回放覆盖的版本和系统范围保留在夹具与验证文档中，缺少验证证据的组合照常开放。

Kiro 的离线行为验证使用 fork 的 ACP replay testkit 与夹具，验证 adapter 行为；真实账号授权由原生程序在实际执行时检查。转录说明见 [fork README](../../upstream/t3code/packages/provider-acp-registry/src/testing/fixtures/kiro/README.md)。

## 历史（R-10）

Thread 历史使用中心已保存的记录：`thread_messages` 保存员工和 Project Agent 发出的输入，`thread_replies` 保存 Worker 上报的回复。网页时间线与 Project 工具 `threads.read` 读取同一份数据，中心按 worker_seq 分页。`history.read`、`history.search` 读取保存在中心的 Project 主对话事件。这与 t3code 用自身事件投影提供历史的方式一致。

设备不保存原生历史，`session.request` 仅用于实时输出读取。网页时间线按中心记录分页。在 Baton 之外继续同一原生会话产生的消息不显示。

## MCP 注入

上游 adapter 已按各 Agent 协议注入 `McpProviderSessionConfig`（endpoint、authorizationHeader、capabilities）。第一版宿主只接上 `McpProviderSessions`，不写入配置。以后向 Thread 中的 Agent 提供 Baton 工具（Thread、记忆、`nodes.exec`）时，由 batond 开本地 MCP endpoint，按 Thread 发放凭据并经 WSS 转发到中心复用 Project 工具的权限检查；这项能力单独写规格，放在第一版之后。

## 注册、配置与设备能力（R-01～R-03、R-07、R-12）

`src/agents/catalog.ts` 是能力和限制文案的唯一来源，只保存字面量与类型。Worker 的 `makeThreadAgentFactory` 将 hosted 类型交给通用 host factory，shell 交给受限 shell factory；工厂内部推导并验证工作目录和私有状态绝对路径。daemon/CLI 的 `probeAgents` 在启动前验证类型，按请求顺序去重，并行探测并保持结果顺序。CLI 的 `agent-host` 分支动态导入 `cli/agent-host.ts`，其穷尽 loader 表只加载选中模块。未知类型在加载或启动前拒绝。

| Agent | Binary / 配置入口 | 能力 |
|---|---|---|
| Pi | PATH 中的 `pi`；`PI_CODING_AGENT_DIR`、`PI_CODING_AGENT_SESSION_DIR`；Thread `model` | 新建、排队、插入、停止、恢复；Thread 内逐轮换模型 |
| Codex | PATH 中的 `codex`；`CODEX_HOME`；Thread `model` | 新建、排队、插入、停止、恢复；Thread 内逐轮换模型 |
| Kiro | local settings：`agentId: kiro`、`commandPath: kiro-cli`，从 PATH 查找；profile 为 `homedir()`；模型取 `model ?? adapter_config.model ?? 'default'` | adapter 支持新建、排队、停止、恢复；不支持插入或换模型；程序已安装且认证 valid/unknown 时开放 create/resume，版本和系统不限 |
| Cursor | 随 batond 分发的 SDK、平台辅助包与本机 shell | 按上游 driver 报告的能力 |
| Grok、Antigravity | 接入时确定 | 接入时确定 |

`agents/catalog.ts` 按固定上游 adapter 的能力与 Baton 已实现的执行路径报告：Pi、Codex 支持 steer，Cursor、Kiro 上游不支持；四个 Agent 均支持新建、排队、停止与恢复。Pi、Codex、Cursor 开放 `switch_model`。Worker 在准备输入时解析逐消息模型，省略时取账本中最近 `sent` 的 queue 输入模型或创建配置，并在 intent 中持久保存；失败或撤回的输入不改变继承模型。通用 driver 把该选择同时传入 `startTurn.modelSelection` 和 `appThread.modelSelection`。Pi adapter 在 prompt 前调用 `set_model`，Codex 在每次 `turn/start` 传模型，Cursor 在恢复会话和 SDK send 时传模型；steer 不接受模型。Kiro 的 fork adapter 在 `kiroAcp.ts` 的 `kiroCapabilityOverrides` 中明确关闭 `supportsActiveSteering`、`supportsSteeringByInterruptRestart` 和 `supportsModelSwitchInSession`；Baton 按该固定实现报告能力。该覆盖不证明 Kiro CLI 的所有版本都缺少对应协议方法。catalog 的 `limitation` 将这些原因写入报告。仅存在明确的数据丢失、越权或重复副作用风险时进一步限制已实现能力。

Kiro settings 固定为 `source: local`，不拉取 registry 包；上游 Kiro driver 不读取专有环境变量，host 只继承系统项，不提供 `BATON_KIRO_*` 或 `KIRO_HOME` 配置入口。Pi、Codex 的配置目录分别按各自原生变量传递，不改写系统 HOME。Antigravity 需要额外启动路径时增加结构化、非敏感本机配置，先通过验证再固定其字段。

各 Agent 的非敏感程序、模型与状态位置按注册表配置及原生映射保存。逐轮模型保存在 Worker 输入账本，恢复使用最近确认提交的 queue 输入模型，保留创建配置用于 open 幂等校验；Kiro 的模型在 Thread 内固定，`default` 不作为模型 ID 发往原生协议。

Pi 上游 `ProviderAdapterTurnStartError.cause` 为 `PiRpcError(operation: set_model)`，或 Cursor 报 `CursorModelUnavailableError` 时，错误证明 prompt 尚未提交。host 通过本地 RPC 的 `AgentHostError.modelRejected` 传递该事实，Worker 将 intent 持久撤回，清除活动输入并继续队列，不增加已确认发送数。选择超时、传输错误、Codex 的通用提交错误和其他缺少确定证据的失败保留 unknown；恢复只调用只读 `sent` 核对原生历史，不自动重发。若撤回事实尚未持久化就中断，intent 仍按不确定输入恢复。恢复核查 Thread、原生 ID、工作目录和 profile 位置；不保存 API key、token 或凭据内容的摘要。检测到账号无法访问原会话就失败，不换用 ambient 凭据。

Kiro 的 `beforeLoadSession` 先用 `session/list` 检查 ID 与 cwd，再 `session/load`；通用 driver 的可选 `resumeOnOpen` 仅 Kiro 设为 `true`，resume 与 sent 均在 `openSession` 中传入 `initialNativeThreadId`，避免 ACP 先新建空会话。fork 启用 `failClosedOnSessionLoad`，会话缺失或 load 失败不退回 `session/new`。`readThreadSnapshot` 同样走核对与 load，通用 `sent` 仅匹配已确认发送数之后的下一条 user 正文，缺少证据时保持未确认。

节点报告正式采用 `{agent_type, version, status, reason, models, default_model, capabilities}`。`RuntimeAgent.reason` 为可选 UTF-8 摘要，最多 1024 字节，禁止 NUL、控制字符和凭据；协议校验同时计入现有 64 KiB 报告预算。超长或未脱敏的 SDK 原始输出不能直接写入 reason。删除节点私有包装对同名字段的补写，生产与测试统一走正式结构。

```text
公共 probe（batond 调度、独立 host 执行）→ RuntimeReport → Coordinator 解码及验证
        → node_runtime_reports.report(JSONB)
        → GET /api/v1/nodes、devices.list → status/create/reason
```

中心按正式字段重新编码后保存，reason 不作为未知字段丢弃；只改变 reason 也应递增 report_version 并推送设备变更。查询 DTO 和 Project Agent 工具响应保留同一摘要，不从异常字符串重新推测状态。JSONB 增加字段无需数据库表或列迁移；现存报告由当前节点重新上报替换。

Web 的 NodeDTO、DeviceAgent 和 mapDevice 保留 status、create 和 reason，未知 status 默认不可创建；只允许 `status === available && capabilities.create === true`。unverified 与 unavailable 都不可创建且展示原始脱敏原因。同步扩展已注册的类型、Thread 映射和 Project Agent 的设备选择。中心现有同条件准入继续保留，客户端可选状态不能放宽服务端检查。

### 探测

探测在只读 agent-host 中调用上游 driver 的安装、认证与模型检查，版本按各 Agent 的探测路径取得，返回分开的安装/版本、认证和模型目录结果。探测不发送 prompt、不调用 authenticate/login 或打开登录浏览器，使用临时空工作目录和空 MCP 配置；Kiro 的完整探测仍调用 `checkAcpRegistryProviderStatus` 与 `probeAcpRegistryConfiguration`，由上游建立空的发现会话以读取能力与模型。其余隔离行为以上游实现为准。每个任务最多 30 秒；TS daemon 每轮探测结束后默认间隔 30 秒重新执行，失败结果不会因路径或版本未变而永久缓存，结束或失败后回收进程树。模型目录用于发现与补全，显式 ID 交给原生 Agent 判定，换模型继续受已实现能力限制。

四个 Agent 在程序或 SDK 已安装、认证 valid/unknown 时报告 available，开放 create/resume；缺程序或明确 missing 时 unavailable。reason 记录版本、系统、认证未知、模型目录问题和未开放能力的原因；版本探测失败或超时不阻止创建。模型目录失败时可按默认模型创建。整次 host 探测失败且安装状态未确认时保持 unverified，避免将探测故障误报成程序缺失。Cursor 在主进程先检查 SDK 资产与平台包版本一致性，host 再检查公共辅助程序与 sandbox。公共依赖失败禁用整个 Agent；sandbox 失败按上游策略只禁用依赖该沙箱的模式，Full access 仍可运行。已确认 SDK 安装完整后，只读 host 探测失败或超时保留诊断并允许创建。

Kiro 在上游 status 之外运行 `kiro-cli --version`。`src/agents/kiro/version.ts` 使用 host 提供的 Node Effect `ChildProcessSpawner`，经包装 spawner 交给 process registrar 管理，Scope 结束或超时后回收进程。版本命令限时 4 秒，stdout/stderr 各最多收集 4096 字节，只返回解析出的版本号；原始输出与诊断留在 host 内，不进入能力报告。命令超时、失败、输出超限或不可解析时，版本为 `unknown` 并记录原因；已安装时仍为 available。缺少程序时为 `unavailable`。

`hostedAgentReport` 对 Cursor、Pi、Codex、Kiro 共用安装与认证规则：已安装且认证为 valid 或 unknown 时报告 `available`、`create: true`、`resume: true`。版本与系统写入 reason，认证 unknown 提示首次执行由原生程序检查；明确 missing 则为 `unavailable` 并拒绝。网页按节点报告开放新建与恢复，不符合准入条件的新建请求返回 HTTP 422、`agent_unavailable`。本地 CLI 的 `open --agent cursor|pi|codex|kiro` 默认 Cursor，支持显式模型与每轮执行时限；`message --mode queue|steer` 默认排队，Worker 按实际能力校验。

Kiro 的 `turnFailure` 回调处理真实回合的 provider failure：明确认证失败映射为“Sign in to Kiro CLI and try again.”，其他 provider 错误映射为“Check Kiro CLI on this device and try again.”。其他 Agent 的失败原因固定为 `Send your message again or check <Agent> on this device.`。通用 driver 将安全原因随失败结束事件交给 Worker，保存到 `turn.ended.content`；不透传原始错误，不自动登录，不重发输入。

节点处理 open 时读取已完成的探测快照，不在 5 秒命令上下文内同步探测；尚在探测时返回明确的不可用原因，探测完成后重新上报。

## Thread 执行权限（R-11）

模式与默认值直接使用固定 fork 的 `@t3tools/contracts` 导出的 `RuntimeMode`、`DEFAULT_RUNTIME_MODE`；当前默认 `full-access`。Baton 负责持久化与传输，审批、沙箱和自动审查语义由完整上游 adapter 执行。

### 契约与能力

| 入口或记录 | 字段与行为 |
|---|---|
| `packages/protocol` | 声明对 `@t3tools/contracts` 的 workspace 依赖，复用并导出原 `RuntimeMode` Schema、类型和默认常量；字段名使用 `runtime_mode`，不维护另一套枚举或默认常量 |
| 创建与读取 DTO | `CreateThreadInput` / `CreateBrowserThreadInput` 增加可选 `runtime_mode`；`Thread`、详情、列表和 Project 工具返回实际持久模式 |
| `RuntimeAgent`、`devices.list` | `runtime_modes:[{id,available,reason?}]`、`default_runtime_mode`；id 引用上游 Schema，默认值引用上游常量，原因遵循现有脱敏和容量约束 |
| HTTP `POST /api/v1/threads` | 首次创建省略模式时使用 `DEFAULT_RUNTIME_MODE`；显式模式按上游支持范围及本机明确失败检查，不可用时返回原因 |
| `batond open` | 新增可选 `--runtime-mode <上游模式>`；省略时采用同一上游默认值，帮助列出实际报告支持的选项 |
| `threads.create` | Runtime 工具声明与中心 `project/runtime.ts` Schema 同步增加可选 `runtime_mode`，沿用中心创建入口，省略时使用同一默认值 |
| 中心与设备持久记录 | `threads.runtime_mode` 非空；open、首次打开重试与 resume 的命令快照、节点配置、`WorkerOpenConfig`、账本和命令摘要包含实际模式 |
| `agent-host/mapping.ts` | 原生映射保存 `runtimeMode`；成功建立映射后、发送第一条消息前持久化；resume 与 sent 校验模式一致 |

模式列表优先沿用上游 driver/presentation 的 `supportedRuntimeModes`，没有专属缩窄列表时采用上游公共 `RuntimeMode`。例如 Pi 当前 presentation 明确列出 Supervised、Auto-accept edits、Full access；Baton 不另推定它只支持 Full access，也不擅自为其添加上游没有报告的 Auto。没有新增系统、CLI 版本白名单。内部 shell 只用于 `nodes.exec`，不把上游 mode 当作 shell 沙箱开关。

公共安装与认证决定整个 Agent 的可用性；模式特有明确失败只收窄对应模式。公共条件通过且至少一个模式可用时报告 `available`，默认模式失败也不自动选择别的模式。缺少 `runtime_modes` 表示尚未报告该选择能力，按已发布协议的能力与兼容规则处理；本次首版前直接调整基线，不新增旧实验节点或记录的模式兼容分支。

### 上游策略与默认值

所有已接入 hosted Agent 统一传入上游 `ProviderAdapterV2RuntimePolicy`：`runtimeMode` 为已保存值，`cwd` 为已授权真实目录，`interactionMode` 沿用原交互配置。省略 `approvalPolicy` 与 `sandboxPolicy`，由 adapter 的原有映射生成原生配置。

复用入口分别为 Codex 的 `codexRuntimeModeTurnDefaults` / `buildCodexTurnStartParams`、Cursor 的 `cursorRuntimeAgentPolicy` / SDK options、Pi 的 `buildPiRpcLaunch` 与权限扩展、ACP 的 `clientPolicy`。Baton 不复制这些映射，也不自己计算每种 mode 的原生审批、sandbox、网络或 auto-review 参数。上游 Auto 在某些 provider 上的降级和等待审批行为原样接受，不能把它重新解释成 Baton 的统一自动执行模式。

通用 driver 从 `WorkerOpenConfig` 得到统一 runtime policy，并同步填入 `appThread.runtimeMode`、`openSession`、`ensureThread`、`resumeThread`、每次 `startTurn`、steer 与只读 sent 核查。不能只改 open 的模式而在后续调用继续传旧固定值。模式属于 Thread 创建配置，本期不接入上游的运行中 mode 切换。

### 原生待审批请求

`agent-host/runtime-request.ts` 将 pending 权限请求交给员工；上游已自动决定的动作不增加 Baton 审批。Full access 下的 `ask_rule`、`provider_check` 确认继续遵循上游。

`agent-host/driver.ts` 沿用现有按 request ID 关联 runtime request 与 TurnItem 的方式，将 `approval_request` 的原因、`requestKind`、`options` 和 `fullAccessOverride` 传入持久问题流程。现有 `ThreadQuestion` 增加 `kind: approval` 及相应上游字段；决策 Schema 复用 `ProviderApprovalDecision`，选项复用 `ProviderApprovalOption`，不把有作用范围的决定压缩为普通 accept/cancel。提供商未给出扩展选项时只提供其公共当次批准、拒绝或取消，不自行开放长期授权。

回答仍经过现有 HTTP、中心持久命令、Worker intent 与 `respondToRuntimeRequest`，绑定 Thread、请求、Turn 和执行身份；仅接受原生提供的决策。批准范围由上游 option/decision 决定，不写成 Baton 的账号或 Project 授权。用户问题与 MCP elicitation 沿用原表单流程。关闭、过期、不可恢复和停止后的请求不再批准；结果不确定保留现有保护，不自动重发。等待审批计入原执行期限，不改写为模型失败，也不创建 Project 主对话自动批准流程。

### 创建、恢复与错误

中心先按原客户端标识查询创建幂等记录；请求摘要保存显式 `runtime_mode` 或固定的「使用上游默认」标记，首次创建再解析默认并保存实际值。相同请求重试返回原 Thread，不因后续上游常量或设备报告变化重新选择；请求字段改变返回既有创建冲突。open、重试打开与 resume 的 payload 均从持久配置取实际模式。

中心在接收时核对上游支持范围和本机能力快照，节点在执行前再次检查。设备离线时可保存明确的创建选择，重新上线后发现该模式不可用则报告启动失败，不改用其他模式。恢复前核对中心、节点、Worker 与原生映射；冲突时保留会话和 intent，不用当前默认值补齐。存活 Worker 的认证 status 报告已保存 mode，daemon 重连不会改变它。

| 结果 | 契约 |
|---|---|
| 未知 `runtime_mode` | HTTP 422 `invalid`，不写 Thread、命令或 intent |
| 上游明确不支持或节点未声明所选模式 | HTTP 422 `runtime_mode_unsupported`，返回所选值和报告支持范围 |
| 该模式明确运行失败 | 创建前 HTTP 422 `runtime_mode_unavailable`；已保存 Thread 以原命令结果或 `thread.open_failed` 报告原因，不发送输入 |
| 同一创建标识改变模式 | HTTP 409，沿用既有请求冲突，不创建第二个 Thread |
| 持久配置与原生映射不一致 | `runtime_mode_conflict`，不恢复或发送，原有不确定输入保持 unknown |
| message、settings 或 resume 请求携带改模式字段 | 按严格 DTO 校验返回 422，不修改 Thread |

模式不绕过 `threads/core.ts` 的员工、节点和初始工作目录检查，不改变文件浏览 API 边界。`nodes.exec` 仍校验本机开关。前端、模型工具与 `adapter_config` 不接受任意 native policy JSON，不通过环境或返回文本覆盖持久 mode。

沿用上游原测试和转录，只为传递、持久恢复与审批转交补回归。首版前的数据库与设备记录使用当前结构基线，旧实验记录需要重建；发布后的模式迁移按 [发布设计](../release/TECH.md#持久格式与迁移)保存原会话真实策略，无法确认时不自动恢复。

### Cursor 模式探测

`cursorProbe` 与 `hostedAgentReport` 按上游 policy 的实际依赖区分公共模块/store/认证失败和模式特有故障；原生 sandbox 明确不可用只影响上游在该环境实际要求 sandbox 的模式。Full access 的准入不依赖无关的 sandbox prewarm 成功，也不额外启用 sandbox。

复用上游的 prime/prewarm 与 Windows 平台处理，不为上游允许的审批模式重新加上强制文件隔离条件。界面按实际能力说明审批和文件隔离的区别。缺少系统验证或只读探测暂时超时继续记录诊断，不扩大成无依据的模式限制；公共依赖明确缺失仍影响全部模式。安装包的公共加载检查与模式特有检查分别记录，不改写已有测量结论。

### 验证

上游 mode/default、Codex/Cursor 映射、Pi/ACP 审批 policy 沿用原测试，Baton 不复制原生参数矩阵。中心与节点测试覆盖创建幂等、默认值传递、恢复一致性、pending 审批转交与回答去重；跨 app 本地替身链路验证省略参数时 Full access 从 API 到达真实 adapter，host 回放覆盖非默认审批模式。自动化不调用在线模型；本地替身与离线回放不证明真实系统的沙箱隔离效果。

## 安装包与代码复用

Baton fork 托管 Baton 的改动分支，`upstream/t3code` 固定到其中一个提交，升级上游时在 fork 中合并后再移动 submodule。fork 地址、固定提交和 Baton 补丁清单记录在 `third_party/t3code/README.md`，保留上游 MIT 许可与版权。

batond bundle 直接打包用到的 `@t3tools/*` 包及其纯 JS 依赖。原生模块和需要磁盘布局的依赖（`@cursor/sdk` 与平台包、`@napi-rs/keyring`）放在 SEA 旁的附带 `node_modules`，打包检查见 [发布设计](../release/TECH.md)。宿主层提供凭据文件后，若 keyring 不再被调用，可在 fork 中去掉该依赖。

## 验证策略

所有适配器行为验证仅依赖上游离线测试、上游转录与 `provider-testing` 回放、Baton 本地替身。测试与验证脚本禁止要求真实 API Key、启动真实 `kiro-cli`、调用在线模型推理或与外部真实服务联调。

Kiro host 回放使用上述授权转换的夹具，验证范围包括真实 adapter 的新建、两轮、停止（含工具运行中）、恢复、`restore_missing` 失败和 `sent` 的确认与未确认；工具中断夹具中的权限请求经真实 adapter 返回 `allow_once`。进程回收用真实 Kiro adapter 与本地 ACP 协议替身，确认 ACP 独立进程组及同组 grandchild 在正常关闭和 host SIGKILL 后均退出，强杀路径由 registrar watchdog 回收。`e2e/src/provider-agents.integration.test.ts` 通过注入已验证 capability 驱动真实 Kiro adapter，覆盖网页 API 发送、回复、中心 idle、停止与恢复；此注入验证自动化行为，不能证明真实账号授权有效；生产报告按节点探测到的安装与认证状态决定，版本和系统保留为诊断信息。

版本探测测试使用本地可执行替身，验证 stdout/stderr 版本解析、预发布后缀保留、诊断不外传、非零退出、缺程序和超时后进程退出，不启动真实 CLI。现有四个 Agent 的注册表测试核对未知版本、其他系统、认证 unknown 和版本超时均放行，缺程序与明确 missing 拒绝；Cursor 探测的模式区分按 R-11 验证。认证失败场景由 `provider_error` 派生夹具驱动真实 adapter、agent-host 与 Worker；该夹具和原始 provider 错误场景分别接上 `simple` 的成功回合，来源记录在 metadata。测试核对失败原因持久化、原始错误不外传、输入保持 sent、排队消息继续执行、最终 idle，以及原生会话和进程保留。跨 app e2e 核对中心读取失败原因和 idle 后，再发消息能收到回复。

| 范围 | 验证 | 层次 |
|---|---|---|
| fork 中用到的包 | 运行各包上游测试；Codex 拆包与 `kiroAcp` 的新增测试 | 上游模块测试 |
| 宿主层 | 各 service 的路径、凭据、环境白名单；spawner 登记进程组 | 包内单测 |
| 事件映射 | 用上游 testkit 替身驱动真实 adapter，核对 reply、end、uncertain 与 `sent` 判定 | 确定性回放 |
| Worker 保证 | 接收、intent、unknown、停止裁决与回收测试，使用可控 ThreadAgent 替身并补真实 host 回放 | Worker 集成 |
| 主链路 | Cursor、Pi、Codex、Kiro 经真实 provider host 回放验证网页 API 发送、回复、停止与恢复；remote/Project 复杂场景使用本地 ThreadAgent 替身 | e2e |
| 历史 | 网页与 `threads.read` 读取同一份中心 Thread 记录，分页与权限正确 | 中心集成与 Web 契约 |
| 探测与 reason | 四个 Agent 已安装且认证 valid/unknown 时 available；未知版本、其他系统、版本失败或超时只记入诊断。缺程序、明确认证缺失或 Cursor 公共依赖失败时 unavailable，sandbox 故障按 R-11 区分模式；整次探测未确认安装时 unverified；未开放能力写明原因 | 包内与本地可执行替身 |
| Kiro 回合失败 | `provider_error` 与派生认证失败经真实 host/Worker 保存失败原因，输入保持 sent，后续排队消息执行并收到回复、原生会话与进程保留；中心时间线可读原因、空队列时 idle，网页在对应回合显示失败 | 确定性回放、Worker 集成、跨 app e2e 与网页数据层 |
| Thread 执行权限 | API、CLI、Project 创建与默认值、模式幂等、持久恢复、按模式准入；Full access 通过真实 adapter 本地替身链路 | 中心与 Worker 包内集成、host 离线回放及跨 app 本地替身；真实系统沙箱隔离未验证 |
| 安装包 | 脱离源码运行 SEA，加载 t3code 依赖与附带目录 | 打包检查 |

## 上游参考

所有链接固定到 fork 基线提交。

| 参考 | 用途 |
|---|---|
| [RuntimeMode 与默认值](../../upstream/t3code/packages/contracts/src/providerPolicy.ts)、[模式名称](../../upstream/t3code/apps/web/src/components/chat/runtimeModeConfig.ts)、[Pi 支持范围](../../upstream/t3code/packages/provider-pi/src/server/status.ts) | 执行模式、默认 Full access、显示名称和 provider 模式支持范围的维护来源 |
| [ProviderAdapter](https://github.com/pingdotgg/t3code/blob/9828cad/packages/provider-core/src/server/ProviderAdapter.ts)、[ProviderHost](https://github.com/pingdotgg/t3code/blob/9828cad/packages/provider-core/src/server/ProviderHost.ts)、[接入约定](https://github.com/pingdotgg/t3code/blob/9828cad/docs/internals/adding-a-provider.md) | adapter 接口与宿主 service |
| [McpProviderSessions](https://github.com/pingdotgg/t3code/blob/9828cad/packages/provider-core/src/server/McpProviderSessions.ts)、[mcpSession](https://github.com/pingdotgg/t3code/blob/9828cad/packages/provider-core/src/server/mcpSession.ts) | MCP 注入配置 |
| [Pi](https://github.com/pingdotgg/t3code/blob/9828cad/packages/provider-pi/src/server/adapter.ts)、[Codex](https://github.com/pingdotgg/t3code/blob/9828cad/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts)、[共享 ACP](https://github.com/pingdotgg/t3code/blob/9828cad/packages/provider-acp/src/server/adapter.ts)、[ACP registry](https://github.com/pingdotgg/t3code/tree/9828cad/packages/provider-acp-registry/src/server)、[Cursor](https://github.com/pingdotgg/t3code/blob/9828cad/packages/provider-cursor/src/server/adapter.ts) | 各 Agent 实现 |
| [历史分页](https://github.com/pingdotgg/t3code/blob/9828cad/apps/server/src/orchestration-v2/threadHistoryPaging.ts)、[provider-testing](https://github.com/pingdotgg/t3code/tree/9828cad/packages/provider-testing) | 历史投影与回放测试 |

## 验证范围与待验证事项

| 项目 | 缺口 | 处理与阻塞范围 |
|---|---|---|
| FULL 同步提交耗时 | macOS arm64、Linux x64 与 arm64 的 records.add/remove 负载已有测量；输入 intent、大队列与 Windows 未测 | 测量值与限制见 [发布验证](../release/TECH.md)；后续测量超标时评估 worker_threads |
| Windows 进程回收 | taskkill 有父进程先退出和 Worker 崩溃后延迟回收两个缺口 | 已接受为第一版范围；Job Object 放第一版之后 |
| 上游进程组 | 上游 adapter 自建 detached 进程组时的登记 | `agent-host/reclaim.integration.test.ts` 验证并组与独立 pgid 回收；Kiro `reclaim.integration.test.ts` 以真实 adapter 和本地 ACP 替身验证独立组与 grandchild，正常关闭、仅强杀 host 均回收。Pi、Kiro host 回放覆盖工具中断 |
| Cursor 认证 | 上游 driver 使用 credential store 与 keyring | 已定：只用设备显式配置的 `CURSOR_API_KEY`，经 adapter 的 `environment` 注入；`ProviderHost.credentials` 保持只读空实现 |
| Kiro ACP | 离线验证不证明真实账号授权有效 | 程序已安装且认证 valid/unknown 时开放 create/resume，版本和系统不限；reason 提示首次原生执行检查，明确 missing 拒绝；上游不支持 steer 和换模型 |
| agent-host 冷启动 | 加载 t3code 依赖后的启动耗时未测 | 不计入 Worker 3 秒预算；open 仍受 30 秒原生预算约束，按目标系统单独测量 |
| t3code 依赖打包 | 已有四模块与 keyring 加载检查，原生依赖放在 SEA 旁；Windows 的 Worker/私有文件仍有验证缺口 | 安装包布局、检查入口和各系统结果见 [发布设计](../release/TECH.md) |
| Grok、Antigravity | 待接入，安装、认证与恢复证据未核查 | 只阻塞各自交付 |

各组合的验证范围由测试、转录和发布检查记录，未知系统或版本仍按安装与认证结果开放。
