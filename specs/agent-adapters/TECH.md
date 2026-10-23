# Agent 适配与扩展技术设计

Status: draft
Owner: 待指定
Basis: [行为规格](PRODUCT.md)；Baton `c064efa`；t3code `807319c276c6831b2c219640e9da5b38019a8f1d`。本文为实施设计，代码核查与验证计划分开记录。

## 现有实现与设计边界

现有 `internal/agent.Adapter` 定义 `Start`、`Send`、`Steer`、`Abort`、`Drain`、`Sent`、`ReadHistory`、`Capabilities`、`Close`。Pi、Codex、Kiro 为 Go 实现；`internal/session/adapter.go` 注册工厂，`internal/node/runtime_agents.go` 负责版本、模型和能力报告。网页历史由 `internal/session/browser_history.go` 独立读取，但 `HistoryPager` 返回的仍是原生记录摘要；Pi/Codex 的消息解析和分支选择在 `web/src/data/http/threads.ts::nativeMessages`，Kiro 条目尚不能显示。Kiro 每页重新建立 ACP 连接加载历史，并将分块逐条交给 pager。

`internal/session/thread.go` 的 Worker 独占 Thread SQLite。输入先提交 `intent`，再调用适配器；恢复时调用 `Sent`，找不到确定证据就进入 `unknown`，不重发。现有 `IntentRestorer.UserMessageCount()` 不接受 context，Pi/Kiro 的 Send 还会再次读取历史。Worker 在原生 Start 完成后才监听 IPC；Host 等待监听为 3 秒，节点命令期限为 5 秒，客户端把该期限设置到连接上，而原生启动和发送各有 30 秒预算。Enqueue 同步准备和发送，慢调用还持有 Worker 状态锁。

`runtimes/README.md` 定义随设备分发的 bundle、Node 下限、192 KiB JSONL 帧、8 个在途请求和进程树清理。现有 `sidecar.Serve` 与 `StdioClient` 是 Node 请求、Go 响应；Cursor 需要 Go 请求、Node 响应及事件推送，因此只复用发现、进程树和分帧设施，新增相反方向的调用端。

现有节点私有 `agentRuntimeReport.Reason` 没有进入 `protocol.RuntimeAgent`，中心解码后重新序列化时会丢弃它；Web 还只把 unavailable 映射为不可用，未保留 create 能力。本设计将历史归一化、正式诊断字段与消费端准入、Worker 异步执行作为公共改动。

Coordinator 与 Worker 继续分别拥有中心命令及设备执行事实。新增 Agent 不引入 T3 的 Run、执行节点、checkpoint、MCP 工具或账号实例模型。中心现有 JSONB 报告增加 reason，thread_outbox 增加异步命令完成字段；Worker 本地账本保存命令生命周期和输入准备。产品条目下文简称 R-01 至 R-12，均指配套行为规格。

## 架构与职责

```text
Coordinator：现有 Thread 命令与报告
  └─ batond：设备能力、Worker 发现、独立历史读取
      └─ Session Worker：thread.db、输入意图、Turn、回复与 outbox
          └─ agent.Adapter
              ├─ Pi：Go → Pi RPC
              ├─ Codex：Go → Codex app-server
              ├─ Kiro / Grok / Antigravity：Go → 共享 ACP 传输 + 各自协议实现
              └─ Cursor：Go → JSONL → Node sidecar → @cursor/sdk → 本机 Agent
```

| 位置 | 拟议职责 | 对应需求 |
|---|---|---|
| `internal/agent/pi`、`codex` | 对照上游真实边界核查，按回放证据修改，保留 Baton 历史与输入确认契约 | R-04～R-10 |
| `internal/agent/acp` | 新增共享 JSON-RPC 连接、分帧、请求生命周期、客户端回调和进程所有权 | R-04、R-08、R-11 |
| `internal/agent/kiro`、`grok`、`antigravity` | 各自会话与历史格式、认证选择、模型、取消及扩展通知；后两者新增 | R-01～R-11 |
| `internal/agent/cursor` | 新增 Go 适配器、原生映射与输入确认、SDK 事件转换、独立历史读取 | R-04～R-10 |
| `runtimes/cursor-agent` | 新增独立 npm 项目，封装官方 SDK，不包含 Worker 账本和中心业务 | R-02～R-12 |
| `internal/sidecar`、`runtimes/shared/stdio.ts` | 增加双向调用所需的客户端或服务端实现，保留现有 Project Runtime 的通道 | R-08、R-12 |
| `internal/session`、`internal/node` | 认证 IPC 提前监听、短事务接收命令、异步执行、统一探测与历史分派；未知结果不被普通退出覆盖 | R-01、R-02、R-04、R-05、R-08、R-10 |
| `internal/protocol`、`control`、`store` | 正式 reason 字段及验证、JSONB 保存与查询；统一历史消息契约 | R-01、R-10 |
| 构建工具与 Web 数据层 | 分发 Cursor bundle；保留 status/create/reason，消费统一历史，移除前端原生解析 | R-01、R-10、R-12 |

以现有 `Adapter` 为执行契约，不增加 fork、rollback、审批或计划接口。新增适配器实现 `SessionIDProvider`、`BrowserHistoryAdapter` 和需要时的 `LiveAdapter`。输入准备扩展改为带 context、绑定消息 ID 的一次性准备，替代无 context 的 `IntentRestorer`；执行接口的 Send/Steer 参数保持不变。协议层只负责读写与关联，不能因为断线自行重启会话或重放 prompt。

## Worker 接收与异步执行（R-04、R-05、R-08）

### 启动与命令回执

`runThreadWorker` 取得 Session 文件锁、打开并验证本地账本后，先建立认证 IPC，再接收或恢复持久启动意图。首次启动须先接收 thread_open 并保存回执，才调度原生初始化；重启则只恢复已有持久意图。Host 的 3 秒等待只检查 Worker 的认证就绪状态，不等待 Agent；已存在的启动中 Worker 不得被再次拉起。`status` 区分 `worker_ready` 与 `agent_ready`，节点账本中的 ready 只表示本地 Worker 已接管，不能触发中心的 thread.opened。

Worker 以短事务接收命令。新增本地 `thread_commands(command_id, action, content_digest, client_message_id, control_epoch, state, receipt, outcome)`，state 为 accepted/running 或终态 succeeded/failed/cancelled/unknown；通过 IPC 传递中心原始命令 ID。接收回执与该命令的状态或队列变更在同一事务提交。相同 ID、相同内容返回原回执和已知结果，内容不同时拒绝，不因已 ACK 再次执行。消息仍按 client_message_id 唯一，不同传输命令 ID 绑定到同一消息及同一执行结果。

所有命令终态、对应业务状态和最终报告在同一个 Worker 事务写入。新增 `command.completed` 报告，携带 `command_id`、`command_outcome`、reason 和 storage_generation；同事务先写相关 thread.opened/resumed、message.sent/withdrawn/unknown 或停止报告，再写完成报告。open/resume 在实际打开或恢复后完成，message 在原生输入确认或明确撤回/未知后完成，stop 在停止证据或未知结果确定后完成。重启扫描 accepted/running 和持久意图，不能仅依赖内存任务队列；终态命令只补送 outbox，不再次调度。

中心保留 thread_outbox.acked_at 表示设备已持久接收，新增 completed_at、completion(JSONB) 保存执行结果。正 ACK 不设置 completed_at，执行前的明确拒绝同时结束命令；command.completed 按命令 ID、Thread、节点与存储代次验证后写完成状态。完成报告先于接收 ACK 到达也有效，迟到 ACK 不能覆盖完成结果。ThreadView.resume_pending 和 ResumeThread 去重改为查询 action=resume 且 completed_at 为空，持续到成功、失败、停止取消或未知终态；期间重复恢复请求复用同一待完成命令。

本地账本丢失或旧存储代次失效时，中心的历史缺失处理同时将受影响的待完成命令结束为 unknown，不能让已无法恢复的 resume 永久保持 pending。

| 命令 | IPC 返回前完成 | 异步完成与报告 |
|---|---|---|
| open | 保存配置、启动意图与命令回执 | 原生建立及映射持久化后发 thread.opened，失败发 thread.open_failed |
| message | 校验归属和能力，保存 queued 消息与回执；steer 同时固定当前 target_turn_seq，无活动回合则拒绝 | 必要时恢复原生会话；准备、intent、提交后发 message.sent/unknown/withdrawn |
| resume | 校验允许恢复，保存 resume_requested 与回执 | 恢复后发 thread.resumed，失败保持 stopped 或 unknown |
| stop | 同事务保存停止标记、撤回 queued、递增控制代次与回执 | 独立取消正在启动、准备或提交的任务；用终止事件或回收证据确认 |

open 的成功 `ThreadCommandResult` 增加当前 `storage_generation`，中心校验当前连接后将它写入 Thread 已有字段，但不设置 opened_at、native_session_id 或 idle。这样 Agent 仍在初始化时，stop 已能携带正确代次到达节点；不能等 thread.opened 才取得命令所需的代次。opened 报告可能先于 ACK 到达，二者须核对同一代次；迟到旧连接或不同代次不能覆盖现有归属。网页根据在线状态、接收确认和 opened_at 展示“设备已接收，Agent 正在启动”，不把 Worker ready 显示为 Agent 空闲。

`thread_meta` 增加 `resume_requested` 和 `control_epoch`，`thread_messages` 以 `intent_preparation` 保存输入基准，替代单一 intent_user_count，并以 `target_turn_seq` 固定异步 steer 的目标回合。采用当前实验室 schema，不增加旧账本读取分支。命令回执在成功回复前落盘；进程重启从命令状态、队列及 intent 恢复，不仅依赖内存工作队列。

状态变更和 SQLite 事务由 Worker 串行处理，原生 Start、历史读取、模型配置、Send、Abort 和进程等待在锁外执行。每个异步结果携带控制代次、操作标识和原生会话引用，过期结果不能改变新状态。stop 有独立登记与取消路径，不能等待发送锁或启动任务完成。

停止先于 intent 提交时，撤回尚未提交的 queued 输入；intent 已提交则保留可能已经发出的事实，取消并查历史，不能当成未发送撤回。即使尚无活动 Turn，只要有启动或准备任务，就必须保留 stop 标记并取消/回收，不能按空闲路径清除它。准备或提交中收到 stop 后不启动下一条消息，待 SDK handle/原生 turn 建立时立即应用已登记的取消。异步 steer 写 intent 前核对 target_turn_seq 与原生执行引用；目标已结束时撤回仍 queued 的消息并说明原因。写 intent 后的过期目标按 unknown 核查，不流入下一轮。启动失败、完成报告丢失和命令 ACK 丢失分别按本地持久事实恢复。

首次 open 的成功与 stop 在 Worker 的串行状态事务中裁决。成功映射和 thread.opened 尚未提交时，先持久接收的 stop 取消 open，禁止补发 thread.opened；回收已登记进程与迟到创建的 SDK 实例，发送 thread.open_failed（reason 为启动被停止）及 open 的 cancelled 完成结果，再按停止证据结束 stop。该 Thread 保持从未成功打开，不能用残留映射自动恢复或重新创建。

若 open 的成功事务已提交，则其 thread.opened 必须按 WorkerSeq 先于停止报告发出；stop 走已打开会话的正常取消路径。过期启动结果除禁止更新状态外，还必须关闭/回收其资源；停止确认前要排除仍可能派生子进程的启动任务，取消后的控制代次禁止新建资源。最终裁决、命令终态和报告顺序都持久保存，重启不得改变结果。

### 期限与单次准备

| 路径 | 预算与关系 |
|---|---|
| Worker 进程就绪 | Host 最多 3 秒，仅含账本与认证 IPC；原生初始化在其后异步开始 |
| 命令接收 | Worker 认证与短事务目标期限 1 秒；Host 最多 3 秒加 IPC 1 秒，小于节点 5 秒期限，复用外层剩余期限而不逐段重置；失败用相同命令 ID 查询或重试接收 |
| 原生 open/send | SDK/原生调用预算 30 秒，sidecar 通信 32 秒，Worker 阶段预算 35 秒；逐层保留返回与清理余量 |
| 输入准备 | 整个准备阶段最多 10 秒，历史子调用服从剩余期限；与提交合计最多 45 秒，不占命令接收期限 |
| Stop | 从持久接收 stop 起独立计时，最长一分钟；不能等输入的 45 秒预算耗尽后才开始计时 |
| 后台探测、历史快照构建 | 各自最多 30 秒的非执行任务，服从独立并发和进程回收约束，不阻塞接收命令 |

所有慢接口都接受或继承 context；Worker 在登记任务时创建任务上下文，不能复用即将结束的 5 秒命令上下文。RestoreInput 只恢复本地基准，不发起历史查询。无 context 参数的 Sent/Abort 从适配器的 Worker 生命周期派生有界查询或取消任务，读取循环与状态锁不因此阻塞。断开命令 IPC 不取消已经持久接收的执行，持久 stop、阶段超时和 Worker 退出负责取消任务。

定义可选 `InputPreparer` 扩展：`PrepareInput(ctx, id, text) (InputPreparation, error)` 与 `RestoreInput(id, text, preparation) error`。数量匹配的 Pi、Kiro、Cursor、Grok、Antigravity 使用它；Codex 继续使用原生客户端消息 ID。InputPreparation 至少包含原生会话、user_count、完整历史前缀摘要及准备标识，不含凭据，编码后最多 4 KiB。

每个输入只采集一次发送前基准。PrepareInput 在其 10 秒 context 内读取并缓存，Worker 将该基准与 intent 原子提交，Send 使用同一份基准，不为重新计数而再启动历史进程。提交后为确认接收或故障恢复而查询新鲜历史仍可进行，但不能替换已保存的准备基准。进程重启通过 RestoreInput 恢复基准。新输入、控制代次变化或原生身份变化使内存准备失效；实际提交时核对输入、代次和可用的原生版本/叶子标识。需重新读取完整历史才能保证安全时，该 intent 不自动重准备或提交，按未知处理。

## 输入、事件与恢复不变量

### 输入确认（R-04、R-05、R-07）

| 阶段 | 保存内容与动作 | 故障处理 |
|---|---|---|
| 原生会话建立 | 适配器先原子保存 Thread ID、原生会话 ID、工作目录、配置位置及格式版本，再完成 `Start` | 首次建会话途中退出可能留下未发送消息的原生空会话；恢复只接受完整映射，不发送第一条消息或自动再建会话 |
| 准备输入 | 无原生客户端 ID 时，PrepareInput 一次读取 user_count、前缀摘要和原生身份，绑定输入 ID 与控制代次 | 读取可取消；停止或身份变化后废弃准备，尚未提交的 queued 可撤回 |
| Worker 提交意图 | 在同一事务保存 intent_preparation、client_message_id 和 intent；Send 使用这份基准 | Worker 重启通过 RestoreInput 恢复；提交后不重新计数 |
| 原生提交 | 有原生客户端 ID 时直接传入；否则绑定本次 ID、原生会话、历史基准和正文 | 不做传输层重试或 SDK 输入重放；请求超时不等于未接收 |
| 接收确认 | `Send` 成功必须有原生接受或原生历史证据；SDK handle、管道写入成功与进程存活均不足以确认 | 在 Worker 发送时限内拿不到证据则返回不确定错误，由 Worker 查历史 |
| 恢复查询 | `Sent(id)` 只读原生记录，核对原生会话、历史前缀和输入位置 | 能证明存在才返回 true；无匹配或查询失败按既有 Worker 逻辑转为 unknown，永不重发 |

数量匹配须验证发送前历史前缀未变，不得只在全部历史中搜索相同正文。重复正文、历史被截断、另一原生会话、不同工作目录都应有独立测试。准备基准由 Worker 的 intent_preparation 保存；原生映射由 `internal/privatefile` 原子写入 `Config.StatePath`。这些恢复证据不从网页历史快照推断，也不保存凭据。

若具体 SDK 无法提供恢复核查所需的原生历史证据，该 Agent 保持 `unverified`，不能用本机“曾调用过 SDK”的记录代替 `Sent`。SDK 内部重试需要区分模型请求重试与用户输入重新提交，必须核查不会把同一输入再次写入会话；不满足时关闭相关选项或阻止交付。

`ModelSwitchError` 只用于明确发生在原生提交之前的模型失败。模型请求或输入响应丢失等情况沿用不确定恢复，不能伪装成可安全撤回。

### 事件归属与回合结束（R-06、R-08、R-09）

每个适配器运行时维护本次进程代次、原生会话、当前输入标识和原生执行引用。接收循环只做解析、关联与有界缓冲；不能持有状态锁等待原生 RPC、SDK 或进程退出。输入和模型切换串行，停止请求有独立登记路径，不排在慢调用之后；事件读取始终可以继续。原生 run handle 尚未建立时先保存取消标记，建立后在允许继续执行前处理它。

| 原生信息 | Baton 映射 |
|---|---|
| 输入已接受或已开始 | `TurnStarted`，关联当前 `client_message_id` 和原生会话；Worker 仍负责唯一 Turn 账本 |
| assistant 消息结束 | `Reply`；纯文本增量进入 `LiveBuffer`，工具详情保留在原生历史 |
| 工具或子任务结束 | 更新本机执行状态；不能单独产生根回合 `TurnEnded` |
| 根回合终止且相关本机执行已停止或等待输入 | 先输出本轮已收到的 Reply，再产生一次 `TurnEnded` |
| 未确认的退出、断线、事件溢出或身份不匹配 | `Uncertain`，进程退出另报 `Exited` |
| 历史加载重放 | 只供历史与恢复核查，不投递为本轮新 Reply |

Worker 的 `drainLocked` 需要明确终态优先级：同一故障已产生 `Uncertain` 后，后续 `Exited` 只补充进程退出事实，不能把 Thread 的 unknown 改成 stopped，也不能恢复发送队列；已提交的未知输入结果保持未知。适配器仍可分别报告执行不确定和进程退出，Worker 对此做包内回归测试。

后台任务有独立归属。原生后台任务能在根 prompt 返回后继续执行时，要等待可核查的结束状态；本期不把原生自动唤醒转换成新的 Baton 输入。不能关闭自动续跑、判断后台归属或停止其进程的组合保持未验证。已结束回合的迟到事件不得绑定到当前输入。

保留 Pi、Codex 的原生 steer。T3 的 Pi `prompt + streamingBehavior: steer` 在空闲时会开启新执行，不能直接套入 Baton 的“只加入当前 Turn”语义。对已支持的 Pi 版本，优先保留明确的 steer RPC；只有实测能核对当前回合且不会遗留到下一轮，才替换实现。竞态中拿不到归属证据就报 `Uncertain`，不补发 prompt。其余四种 Agent 的 `Steer` 返回 `ErrUnsupported`，不用中断重启来模拟。

### 停止与进程所有权（R-08）

`Abort` 幂等设置本轮停止状态，再调用原生取消。现有 Worker 异步调用 `Abort` 时只消费 error，停止状态由 `Drain` 的事件和进程树回收结果推进；本期保持这一分工。接口中的 `outcomeKnown` 描述执行结果是否已知，不能当作 Turn 终止或进程树退出的替代证据。原生尚未登记 prompt 时，等待提交边界并再次确认取消，或直接回收当前 Thread 的进程树；不能把一个过早且无效的 cancel 响应当作完成。

停止后拒绝新的权限请求和后台续跑，清理未消费的原生输入队列。取消响应、Turn 终止和进程退出分别记录；`Abort().outcomeKnown`、`StopStatus`、`ThreadProcessKiller` 沿用现有含义。超过 Worker 的一分钟停止时限调用进程树回收，回收未确认仍是 unknown。

每个执行 Thread 独占 Agent 进程或 Cursor sidecar 及其本机子进程。本期不做跨 Thread 的 app-server 或 SDK host 共享。Unix、Windows 均复用现有进程组或 Job Object；SDK 创建的 detached 后代必须纳入真实回收验证，不能仅验证 sidecar PID 已消失。batond 重启仍通过已有认证 IPC 连接存活的 Worker，不因重连重开 Agent。

## 各 Agent 实现

### Pi、Codex（R-04～R-10）

Pi 保持 RPC、原生 JSONL 与会话归属，输入准备改用一次性 PrepareInput 基准。核查发送确认、工具运行中的 abort、输入队列清除、部分写入、compaction 与回合结束的时序。会话树只读取当前分支；若增加 `get_entries` 支持，用真实版本转录验证，不能把 t3code 的 SDK/CLI 假设套到 Baton 的 Pi 最低版本。

Codex 保持 app-server 与 `clientUserMessageId`。重点核查 `turn/start` 响应和通知先后、原生 turn 存在之前的中止、`expectedTurnId`、断线后的原生历史查询、恢复中的分页以及子任务的迟到通知。保留 `approvalPolicy: never`、`sandbox: workspace-write`，不移植 T3 的审批与原生回退接口。

既有 Pi 1.3.0、Codex 0.162.1 及更新的稳定版本检查策略继续适用；新增协议要求必须先证明这些最低版本满足，或另行修改并审查最低版本约定。

### 共享 ACP 与 Kiro（R-04、R-08～R-11）

从 `internal/agent/kiro` 提取确实共享的 NDJSON 分帧、`jsonrpc2.Conn` 生命周期、双向请求 ID、进程回收及取消注册屏障。沿用当前 `github.com/sourcegraph/jsonrpc2 v0.2.3`，不为复用引入 Node/Effect ACP 实现。

各协议实现提供结构化启动配置和以下策略：initialize 参数及能力校验、认证方式、new/load/resume、模型配置、session/update 与扩展事件解析、原生输入历史获取、取消与结束证据、客户端文件或终端回调。使用 Go 接口或函数注入，不在共享传输中按 Agent 名称判断。

Kiro 保持 `kiro-cli acp --agent-engine=v3`、ACP `protocolVersion: 1` 及 `_kiro/session/history` 等扩展校验。不能因 T3 的通用 ACP 请求版本为 2 就统一改为 2。保留 Kiro 的新建模型 `_meta.kiro.modelId`、load 前身份核查、Sent 的 user 分块合并和不支持 steer/中途换模型的声明。网页历史新增完整的 user/assistant 分块归一化；PrepareInput 与 Send 共用一次历史读取。先用既有 Kiro 转录证明提取未改变请求与恢复语义，再接其他 Agent。

共享层不默认提供 `fs`、terminal 或未知扩展能力。只有确实实现的客户端能力才出现在 initialize 中。权限请求逐次匹配原生 session ID、活动回合和原始 optionId；使用既有 Kiro 的当前回合 `allow_once` 策略，不能选择 `allow_always`。停止、读取历史或未知会话的请求返回取消。

### Grok（R-01～R-11）

新增 `internal/agent/grok`，启动原生 `grok agent stdio`，由其协议实现选择 initialize/认证参数和 xAI 扩展。首期沿用 CLI 原生权限检查，显式采用 `--permission-mode default`；权限回调只允许当前回合的一次请求，不写项目级授权，不使用 `--always-approve`。

认证使用本机 Grok 已配置的账号或员工明确配置的原生 API key。环境白名单只允许必要的系统、网络和该 Agent 的配置项，不继承其他提供商密钥或 Project Runtime OAuth。具体原生 profile 环境变量须通过启动与恢复录制确认，不能简单替换整个系统 HOME。

xAI 的 prompt 完成通知、标准 prompt RPC、后台任务通知分别处理，按本轮身份去重，只结束一次。取消参考原生 Ctrl+C 语义与 `session/cancel` 扩展，用户 Stop 必须覆盖子任务；原生取消不足时依靠 Worker 回收整个进程树。

原生历史读取、resume 和后台执行结束证据是可用声明的前置条件。只有 `session/load` 能恢复并不代表它会回放 user 输入；需实际证明历史查询足以实现 `Sent` 和网页分页。无法证明时保持未验证。

### Antigravity（R-01～R-11）

新增 `internal/agent/antigravity`，接入用户已准备好的 `agy_acp_server` 或等价原生 ACP 启动器。启动器及可能需要的 harness 路径分别解析成结构化参数，不能拼接任意 shell 命令。Baton 本期不下载二进制、不复制 T3 托管认证代码、不分发未核实许可的第三方安装资产。

执行使用显式配置的原生 profile；认证只采用已完成的本机上下文。后台探测和 Worker 不发起交互登录，原生要求重新认证时退出并给出本机操作原因。移除未选择的 ambient Google 凭据，避免落到其他账号或计费项目；不复用 Project Agent 的订阅登录。

恢复优先采用实测无工具重执行的原生 resume；load 是否用于独立历史读取需另证。模型只在原生 config options 已公布后设置。启动选择原生 `default` 权限模式，只处理当前回合的 `allow_once`，不自动改为 `yolo`。

如果原生执行需要客户端文件回调，仅对本 Thread 已验证的工作目录提供 `internal/fileaccess` 限制下的读写；拒绝目录外、解析后越界与未知会话请求。独立历史连接不提供写权限。未实现的客户端 terminal 不做能力声明。

每个运行时使用独立临时目录，进程树退出后才清理；不能删除另一 Thread 使用的 harness 或解包目录。原生程序的可独立安装、认证、历史与后台任务证据未齐全前，不标记 available。

### Cursor（R-01～R-12）

新增 `runtimes/cursor-agent`，直接依赖官方 `@cursor/sdk`，不依赖 `@t3tools/*` 或 Effect。`1.0.35` 是已读上游的参考版本，不是 Baton 已验证基线；实际版本固定在该 runtime 的锁文件，并记录 SDK、CLI、本机辅助进程及 Node 的要求。

每个 Thread 一个 Node sidecar、一个本地 SDK Agent。使用 `Agent.create/resume`、`send`、`onDelta`、`run.wait/cancel` 和 `listMessages` 等已核查入口；具体签名与持久化能力以安装的 SDK 类型和实际录制为准。禁止 SDK 运行模式转到远程执行环境。

Go 适配器保存 Baton Thread 与 SDK 原生 agent ID、工作目录、配置位置的映射。跨进程恢复能力是固定 SDK/系统组合的交付验证条件；每次 Start 只建立本次原生会话并持久化映射，不启动第二个执行 host 验证 resume。SDK 若需要定制本地 store，必须采用 SDK 公开接口并保存到设备私有数据目录；不能依据 t3code 未显式配置 store 就推断历史已经持久化。

认证先支持员工为该原生 Agent 明确配置的 `CURSOR_API_KEY`，仅经私有进程环境注入 SDK；SDK 自身公开的 credential store 可在验证后接入。不能假定 `agent login` 的私有 CLI 凭据可直接被 SDK 复用。需要读取私有格式或增加 Baton 登录流程时，先补充并审查本节及产品 R-03，不复制 T3 的登录服务。凭据不持久化到 `agent.Config`、中心或诊断中。

首期选择 SDK 本地 `autoReview: true`，启用其实际支持的原生 sandbox；不因某系统不支持而自动设为 false。上游指出 Windows 的文件 sandbox 存在限制，因此 Windows 作为独立验证组合，满足不了选定执行策略时保持未验证。`enableAgentRetries` 必须按输入确认约束核查，不能照搬上游的 true。

首期 `Steer=false`；不复制 T3 的 interrupt-and-restart steering。模型可在下一轮原生支持时切换。后台 SDK 活动、取消后的 delta、运行结果和进程退出由同一会话代次关联，关闭与取消均幂等。

## Cursor sidecar 协议

### 封装与并发（R-05、R-08、R-12）

新增协议版本 1，使用专用 stdin/stdout。Go 分配正整数请求 ID，在单个进程内递增；请求最多 8 个在途，其中至少一个额度保留给 `abort/status/close`，普通请求最多 7 个，响应可乱序，事件有单独递增序号。控制请求独立处理，不能等待普通 SDK 调用或其串行锁；abort 在收到时即登记取消标记。沿用 192 KiB UTF-8 JSONL 帧、完整 JSON 校验和写背压；诊断写 stderr。现有 Project Runtime 协议不改方向、不增加 Cursor 字段。

```json
{"id":1,"request":{"op":"open","protocol":1,"epoch":"本次进程代次","thread_id":"Thread ID","restore":false,"cwd":"已验证目录"}}
{"id":1,"result":{"ok":true,"native_session_id":"原生 ID","capabilities":{"steer":false,"resume":true,"switch_model":false}}}
{"event":{"epoch":"本次进程代次","seq":1,"kind":"turn.started","client_message_id":"输入 ID","native_session_id":"原生 ID"}}
{"id":2,"result":{"ok":false,"code":"uncertain","reason":"未取得原生接收证据"}}
```

示例省略了非敏感配置、模型与原生映射字段。Worker 在启动时绑定身份、目录和 epoch；后续调用不能改变它们。sidecar 不接收中心凭据，不访问其他 Thread 账本。执行模式在 open 前只允许协商，close 后拒绝所有执行操作；独立只读子命令由父进程绑定既有映射，只允许历史和输入核查，不使用执行模式的 open。

| 操作 | 结果与期限 |
|---|---|
| `open` | 原生 SDK 在 30 秒内完成，通信 32 秒、Worker 启动阶段 35 秒；不占 IPC 接收期限、不发送用户消息 |
| `prepare` | 在 10 秒准备阶段内返回原生 user_count、前缀摘要与身份，绑定输入 ID；只读取一次，支持 context 取消 |
| `send` | 使用已落盘的同一准备基准；原生提交 30 秒、通信 32 秒、Worker 提交阶段 35 秒内返回证据，不等待整轮执行 |
| `abort` | 立即登记取消并返回请求已登记；终止证据通过后续事件/状态确认，不能占用发送锁等待整轮结束 |
| `status` | 由 Go adapter 的停止监视逻辑查询，不要求 Worker 直接调用；取得终止证据后由 Node 走统一结束事件路径，先 flush Reply 再产生恰好一次 `turn.ended`，交 Worker 的 Drain 消费；取消请求已响应不能作为 stopped |
| `sent` | 查询原生历史证据，返回已发现或未知/读取失败，不重放输入 |
| `history` | 由 Go BrowserHistoryAdapter 消费 SDK 记录并归一化，按下文统一消息协议分页；Node 分片是传输分片，不是网页消息边界 |
| `close` | 幂等关闭 SDK Agent、停止本机活动并退出；超时由父进程回收 |

请求通信使用 32 秒外层超时，原生子调用为 30 秒，Worker 的 open/提交阶段为 35 秒；prepare 则整体受其 10 秒期限限制。`send`、`open` 超时即中断当前通道，不自动重试；关闭通道不表示 Agent 进程树已停止。Go 适配器保留已落盘的原生身份和输入基准，后续 `Sent` 必须通过独立只读历史进程核查，不依赖已关闭通道，也不自动 create/resume 执行会话。读取失败就返回错误，由 Worker 进入 unknown。Node 不能为同一请求 ID 再次调用 SDK；重复或未知 ID、畸形帧和超限帧关闭通道。

事件 `kind` 使用既有 `agent.Event` 的五类名称，另有只进入 `LiveBuffer` 的 `live`。Reply 与终止事件保持顺序；单条回复沿用 32 KiB 摘要规则，完整内容留在原生历史。缓冲有界，溢出不能静默丢掉终止或假装完整，须向 Go 报 Uncertain 后关闭执行通道。

Go 校验 epoch、seq、native session 和输入 ID；旧代次丢弃，当前代次的序号缺口或归属错误进入未知。`Drain` 仍由 Worker 消费，本协议不增加另一份持久消息队列。sidecar 退出后未持久化的接收结果从原生历史核查，不能声称其内存事件缓冲具有崩溃恢复能力。

### 独立历史与探测（R-02、R-10）

`probe` 子命令先提供不建会话的版本、依赖和静态元数据查询。必须建会话才能获得的信息走注册表声明、经过验证的隔离探测会话；不在员工工作目录创建或恢复 SDK Agent。认证与模型目录分别返回结果，不能凭模型缓存标记 authenticated。隔离条件和准入见下文。

`history` 模式从既有映射读取原生历史，不创建新会话，不发送消息。优先验证已在上游使用的 `Agent.messages.list(nativeId, {runtime: "local", cwd})`；SDK 静态历史接口与执行 host 分开使用。若仅 resume 能读取，必须证明它在独立进程中无项目动作且不干扰活动 Agent，否则此路线不满足 R-10。原生历史变化沿用 `ErrHistoryChanged` 等错误，最终映射到既有 `history_changed`、`history_missing`、`history_unavailable`。

SDK 若一次返回完整列表，sidecar 在输出前分片并限制累计容量，Go BrowserHistoryAdapter 归一化后生成只读快照；超限返回缺口或不可用。单节点最多 2 个独立历史构建，后续翻页不再恢复 SDK Agent。

## 设备端历史归一化与分页（R-10）

### 统一消息契约

六种 BrowserHistoryAdapter 先解析原生格式、选择当前有效分支并合并消息，再交给 HistoryPager。调整 `protocol.HistoryEntry` 为统一消息结构；`text` 是普通正文，不再装原生 JSON。此结构及 ValidHistoryPage 同步用于设备、中心临时转发、Web 和 Project Agent 历史查询，不维护原始 JSONL 响应兼容分支。

| 字段 | 约定 |
|---|---|
| id、ordinal | 稳定消息标识与会话内顺序；优先原生 ID，缺失时从原生会话、稳定边界与序号派生，禁止每次读取随机生成 |
| role、text | role 仅 user/assistant；正文与其 UTF-8 截断边界由设备解析，不把工具、系统提示或原始协议帧混入 |
| timestamp | 可空的原生时间；缺失时 null，前端显示未知；不使用探测时间或当前时间补造 |
| client_message_id | 原生明确提供时携带，用于与中心已保存输入关联；不能把推测的匹配写成确定 ID |
| reference、bytes、truncated | 节点本地来源范围、完整正文 UTF-8 字节数和截断标记；引用不携带凭据或任意可读取路径 |

HistoryPager 的输入改为已解析消息、完整逻辑消息摘要和来源范围。它只限制单条 4 KiB、每页最多 16 条且编码后不超过 14 KiB，计算前缀摘要并校验游标，不再尝试 JSON 解析、提取 type/parentId 或推断角色。超大消息边解析边计算完整摘要，保留有限正文；超限不使 JSON 解析失败而丢掉整条消息。

摘要覆盖规范化的完整正文、role、稳定消息身份和顺序，不包含传输 token 分块或读取时间；同一历史用不同 chunk 大小重放仍得到同一消息和摘要。Pi 的有效分支选择、Codex 原生记录解析、Cursor SDK 消息转换及 ACP 分块合并都属于各 BrowserHistoryAdapter。

### ACP 合并与只读快照

ACP 的 user_message_chunk/agent_message_chunk 按原生消息 ID、replay ID 和消息边界归并；缺少 ID 时只能使用已验证的消息起止、角色切换或工具边界。不能把所有相邻同角色记录无条件合并。无法确定边界时保留已知内容并标 gap。原始消息有时间则保留；没有时间不丢弃。网页历史与 Sent 共用原生分块解析规则，但 Sent 使用新鲜原生证据，不依赖展示快照。

对必须全量 load/replay 或 SDK 一次返回列表的 Agent，一次读取建立一个私有、只读的规范化快照。缓存键绑定员工设备上的 Thread、原生会话、规范化 schema、配置位置和源版本；同键并发首读只建立一个任务。后续页复用快照，不重新拉起 ACP 进程。快照是可删除的派生缓存，原生历史仍是唯一恢复依据，不进入 Worker 账本或 PostgreSQL。

节点最多同时构建 2 个历史快照，单快照最多 16 MiB、总量最多 64 MiB，空闲 5 分钟失效；私有目录和文件使用既有权限设施，超限返回明确缺口或不可用。原生支持稳定分页时可直接使用其受限读取，无需复制快照。缓存重启后可丢弃，不能作为发送成功证据。

游标在现有 100 字节内紧凑编码快照标识、下一消息序号、前缀摘要与格式版本。后续页直接校验游标所指快照及其前缀，不为校验再次重放原生历史。快照过期、已知原生身份/分支切换或已读前缀改写时返回 history_changed，客户端从首读重建；不把新快照的条目接到旧游标后。

快照提供捕获时的一致视图，后续追加不改变正在翻页的结果，显式刷新才读取新内容。新首读用可靠的原生变更标识判断复用；没有这种标识时重新读取并比较逻辑前缀，不能仅凭缓存年龄或文件时间复用旧数据。没有变更通知的 Agent 不声明翻页时实时检测原生改写，只保证不可变快照与有限有效期。

首个请求只等待受限构建进度，未完成时返回 `ok:false, code:history_loading`；同 Thread 重试复用该任务。构建归 batond 的独立上下文所有，最多 30 秒且无 prompt；单次响应不超过 10 秒，保持小于现有节点 12 秒和中心 15 秒历史查询期限。客户端在总计 35 秒内限频等待，超时显示暂不可读，不能不断新建进程。新原生历史构建、取消、超时和缓存清理均须回收读取进程。

### 消费端与中心记录关联

删除 Web nativeMessages 中按 Agent 解析和 Pi 分支遍历，设备已经输出有效消息。Message 的时间字段允许 null，展示、排序和日期分组使用稳定顺序并处理未知时间。前端逐页消费统一条目，保留后续游标；128 页/2 MiB 只限制单次自动读取，达到预算时显示缺口及继续读取入口，不能丢弃全部已读消息。

中心输入优先以 client_message_id 关联；没有确定 ID 的记录按 role + 完整正文序列匹配，唯一且未截断时才能确定重叠范围。原生时间戳只用于展示，不作为匹配条件。原生与中心消息分段不同、匹配有歧义或正文截断时保留可见内容并标 gap，不静默删除，也不把中心回复冒充原生历史。六种 Agent 使用同一展示与匹配逻辑，不再为 Kiro 直接跳过条目。

## 注册、配置与设备能力（R-01～R-03、R-07、R-12）

执行与探测共用拟新增的 `internal/agent/registry` 包中的无状态注册描述，替代工厂、节点探测和历史分派各自维护的 Agent 列表。该包导入 `agent` 接口和各实现，`agent` 根包及具体适配器不反向导入 registry，避免 Go 导入环。描述包含类型、工厂、版本策略、模型探测、历史构造与静态能力上限；不保存 live adapter 或凭据。消除 `runtimeAgentCapabilities` 对未知类型退回 shell 的行为，未知类型一律拒绝。

| Agent | Binary / 配置入口 | 初期能力策略 |
|---|---|---|
| Pi | 现有 `BATON_PI_BIN`、`BATON_PI_HOME`、`BATON_PI_MODEL` | 原生 steer、resume、switch_model 保留 |
| Codex | 现有 `BATON_CODEX_BINARY`、`BATON_CODEX_HOME`、`BATON_CODEX_MODEL` | 原生 steer、resume、switch_model 保留 |
| Kiro | 现有 `BATON_KIRO_BINARY`、`BATON_KIRO_HOME`、`BATON_KIRO_MODEL` | resume；steer 与 switch_model 关闭 |
| Cursor | 随包 `cursor-agent` runtime；本机 Cursor SDK/CLI 环境 | steer 关闭；resume、history 及模型切换须实证 |
| Grok | `BATON_GROK_BINARY`，默认 `grok`；新增 `_HOME`、`_MODEL` 配置入口 | steer 关闭；其余按原生协议验证 |
| Antigravity | 显式 `BATON_ANTIGRAVITY_BINARY`、`_HOME`、`_MODEL`，必要的 harness 路径单独配置 | steer 关闭；其余按原生协议验证 |

新配置里的 `_HOME` 指已选择的原生 profile 位置，不能把同名变量自动映射到系统 HOME；映射到原生变量的方式由对应适配器确定。Antigravity 需要额外启动路径时增加结构化、非敏感本机配置，先通过验证再固定其字段。Cursor runtime 的 bundle 路径由 `sidecar.Command` 解析，不把它误当成原生 `agent --version`。

现有 `agent.Config` 保存的 `Home`、`Binary`、`Model` 和本机状态足以承载大部分配置；额外字段只保存必要的非敏感路径或标识。恢复核查 Thread、原生 ID、工作目录和 profile 位置；不在数据库保存 API key、token 或凭据内容的摘要。检测到账号无法访问原会话就失败，不换用 ambient 凭据。

节点报告正式采用 `{agent_type, version, status, reason, models, default_model, capabilities}`。`protocol.RuntimeAgent.Reason` 为可选 UTF-8 摘要，最多 1024 字节，禁止 NUL、控制字符和凭据；协议校验同时计入现有 64 KiB 报告预算。超长或未脱敏的 SDK 原始输出不能直接写入 reason。删除节点私有包装对同名字段的补写，生产与测试统一走正式结构。

```text
节点探测 → protocol.RuntimeReport → Control 解码及验证
        → Store.SaveRuntimeReport → node_runtime_reports.report(JSONB)
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
| 不满足隔离条件 | 仅返回已知元数据与 unknown 认证 | 报 unverified 并拒绝创建，给出缺项；正常 Start 不作为绕过入口 |

隔离探测使用 canonical 临时空工作目录、独立临时会话存储和进程树，只挂载选定认证上下文。显式传空 mcpServers，并使用对应版本已验证的禁用 hooks、extensions、MCP、技能和项目配置参数；SDK 同样关闭对应 settingSources/服务配置。空目录和空 mcpServers 本身不证明隔离，必须用带用户级、项目级哨兵配置的真实验证确认。禁用参数不存在或认证会弹窗时，不能走这条路径。

探测不自动回复权限请求、不向模型发送消息；原生要求登录时立即报告缺项。每个任务最多 30 秒，版本和配置一致时复用结果，结束或失败后关闭进程并清理临时会话数据，不删真实认证目录。SDK/原生程序无法安全清理临时会话或禁止启动动作时保持未验证。

认证 unknown/missing、安装不完整或版本/系统组合未交付验证时不可创建；认证明确有效但模型目录失败时可按默认模型创建，reason 说明目录缺失。运行时协商只能收窄静态能力，不能扩大；只有创建时选模型的 Agent 关闭 switch_model。后台任务独立运行，探测及失败结果按版本、路径和配置上下文缓存，batond 重启重新采集。

节点处理 open 时的 agentAvailable 读取已完成的探测快照并快速复核路径和配置，不在 5 秒命令上下文内同步进行 30 秒隔离探测。尚在探测或结果未知时返回明确的不可用原因，后台探测完成后重新上报，员工可再次创建。

## 安装包与代码复用

Cursor 复用 `tools/package-sidecar.mjs`，随 `node tools/build.mjs` 和 `tools/package-batond.mjs` 生成 `bin/sidecars/cursor-agent/`。runtime 固定自身版本、协议、SDK 锁文件及 Node 下限；Node 下限取统一 sidecar 约定与 SDK 实际要求中的较高者。构建禁止依赖安装脚本，若 SDK 必须通过安装脚本下载辅助程序，应改为显式受控打包步骤并先审查，不能静默放开脚本。

`tools/check-sidecar-package.mjs` 增加 Cursor 的脱离源码目录检查：只提供 Node，检查模块解析、probe、私有状态和模拟 SDK 协议；不能把该检查标成真实 Agent 验证。Windows、macOS、Linux 分别打包原生依赖，不能复制另一系统的 node_modules。Grok、Antigravity 原生程序单独安装，不进入 Baton bundle。

T3 仅作为固定提交的源代码与协议证据参考。Cursor 使用官方 SDK，ACP 使用 Go；按需要转写明确的生命周期处理，不引入 `@t3tools/contracts`、Effect、T3 的认证服务或整个 adapter runtime。复制或实质性转写的代码保留 MIT 版权和许可，在 `third_party/t3code/` 记录 LICENSE、来源路径、提交及对应本机文件。新引入官方 SDK 的许可按各自包记录，不能用 T3 MIT 代替。

## 验证策略

复用 [Agent 录制回放设计](../agent-replay/TECH.md)。已有 Pi、Codex、Kiro 转录先作为回归基线；新 Agent 从真实原生版本采集，规范化时保留 ID 关联、收发顺序、取消竞态和历史身份。T3 转录可作协议线索，但不能代替 Baton 的实际录制或证明另一个 CLI 版本兼容。

Cursor 需要两处验证边界：SDK 调用/回调转录驱动真实 TypeScript 封装，以及 JSONL 子进程转录驱动真实 Go 适配器与 Worker。只回放 Go/Node 的自定义协议不能证明 SDK 映射正确。ACP 回放替换原生进程，共享层、各自协议实现、Worker、SQLite 和 outbox 均运行真实代码。

| 需求 | 设置与观察 | 失败条件 | 层次 | 状态 |
|---|---|---|---|---|
| R-01、R-02、R-12 | 缺程序、缺 Node/bundle、认证未知、旧版本及不兼容握手；检查节点与 UI | 假报 available、执行模型请求或自动登录、创建未在执行前拒绝 | 包内测试与探测替身 | planned |
| R-03、R-04 | 保存映射后退出；删除映射、换 profile、工作目录符号链接；独立进程恢复 | 静默新建、跨会话读取、历史工具重执行 | 真实转录 + Worker | planned |
| R-05 | 在原生记录输入前后、响应前后分别断线和终止；重复相同正文 | 同一客户端 ID 再提交、只凭 SDK handle 或本地标记确认 Sent | 派生回放 + SQLite 恢复 | planned |
| R-05 | SDK 失败重试与主动重连场景，核对原生用户输入次数 | 用户输入被隐藏重放、自动恢复另开会话 | SDK 转录与门控真实测试 | planned |
| R-06 | Pi/Codex steer 贴近终止；其余四种直接调用 Steer | 另开 Turn、下轮消费旧队列、模拟中断重启 | 确定性回放 | planned |
| R-07 | 未公布模型配置、默认值、模型拒绝与响应丢失 | 虚构模型 ID、先发后切换、未知提交被错误撤回 | 包内与回放 | planned |
| R-08 | 发送后立即取消、工具中取消、SDK cancel 提前返回；一分钟超时 | 提前宣告停止、未回收后代、误杀另一 Thread | 设门回放 + 各系统进程树测试 | planned |
| R-05 | 发送超时关闭执行通道，Worker 立即调用同一适配器的 Sent；再向 Worker 依次投递 Uncertain、Exited | 核查依赖已关闭通道、启动执行 host，或 unknown 被普通退出覆盖 | 只读历史集成 + Worker 包内测试 | planned |
| R-08 | 普通请求满载且 SDK send 未返回时调用 abort；终止只在 status 查询中可见 | 取消未及时登记、Worker 收不到归一化终止事件或回复顺序错误 | sidecar 并发测试 + Worker 回放 | planned |
| R-09 | 根回合结束但子任务未结束、旧事件迟到、重复完成通知 | 父回合提前结束、重复结束、回复串轮 | SDK/ACP 回放 + Worker | planned |
| R-09 | 事件先于 send 响应、恢复重放、事件缓冲溢出 | 回复被丢弃且无缺口、历史当新回复、终止先于本轮回复 | 回放 + 报告事务测试 | planned |
| R-10 | Worker 不存活时读取大历史，修改历史前缀，读执行中会话 | 查询触发 prompt/hooks/MCP、无限增长、错误游标仍可用 | 独立历史集成 | planned |
| R-10 | 六种格式归一化；ACP 上万 token 分块、同角色不同消息、缺失时间戳，前端直接消费消息 | 页数按 chunk 增长、错误合并、缺时丢消息、浏览器仍解析原生 JSON | 解析单测 + 真实转录 + Web 契约测试 | planned |
| R-10 | 同快照翻页与并发首读，统计原生 load 次数；过期、分支变化、规范化 schema 变化 | 每页新建进程、缓存无界、旧游标混读新版本、相同正文不同 chunk 导致游标变化 | 有界快照与历史集成 | planned |
| R-01 | reason 经节点、Control、PostgreSQL JSONB、nodes API、devices.list 到 Web；只改变原因 | 字段丢失、原因变更不增加版本、摘要越界或未脱敏 | 协议单测 + 本地数据库集成 | planned |
| R-01 | available/create=false、unverified/create=true、未知 status；两类消费端及中心创建检查 | 任一消费端可选择不可创建 Agent，或中心放行 | Web 契约 + Project Agent 工具与 Store 测试 | planned |
| R-04、R-05、R-08 | 原生冷启动/发送慢于 3/5 秒，open 的 opened 报告前后发送 stop，丢失 ACK 后重发命令 | IPC 等原生初始化、早期 stop 缺存储代次、重复执行、慢调用占锁、停止期限延后 | Node→Host→Worker 集成与进程替身 | planned |
| R-04、R-08 | open 成功提交与 stop 接收两侧设屏障，Start 返回迟到实例；完成报告早于命令 ACK；重启后补报 | 已取消 open 补发 opened、遗留进程、报告乱序、终态命令再执行 | Worker 事务与 Node/Store 回放 | planned |
| R-04 | resume 已 ACK 但未完成时再次请求，随后成功、失败或被 stop 取消 | pending 过早清除、新命令重复恢复、完成被迟到 ACK 覆盖 | Store/控制面 + Worker 集成 | planned |
| R-05 | PrepareInput 设置屏障后停止/退出；确认准备调用一次、intent 基准跨重启相同 | 重复读取并换基准、不可取消、停止后提交、把仍 queued 的消息写成 sent | 适配器 + Worker 确定性回放 | planned |
| R-02 | 静态与隔离会话探测，设置用户/项目 hooks、扩展、MCP、登录弹窗哨兵；到期清理 | 触发任一动作、发送 prompt、残留进程，或仅因 session/new 就永远 unknown | 探测替身 + 每原生版本门控验证 | planned |
| R-02、R-07 | 可见模型但认证未知；认证有效而目录失败；创建快路径检查正在探测 | 前者可创建、后者不能使用默认模型，或命令循环同步执行重型探测 | 准入、探测与消费端集成 | planned |
| R-11 | 非当前 session 的权限、停止后的 allow_once、客户端文件越界 | 永久授权、权限请求悬挂、历史读取写文件、越界通过 | 包内与原生回放 | planned |
| R-12 | 脱离源码路径启动安装包；移走 bundle、禁用网络、平台原生依赖 | 联网补依赖、路径回退掩盖坏包、不同系统产物混用 | 安装包检查 | planned |
| R-01～R-12 | 每个新增 Agent 在声明支持的系统上运行核心场景 | 无法满足行为规格却声明已支持 | 门控本机真实验证 | planned |

实施验证使用相关包的 `go test` 与 race，Cursor runtime 的锁文件安装、typecheck 和测试，以及 `node --test tools/build.test.mjs`、`node tools/build.mjs`、`node tools/check-sidecar-package.mjs`。修改 Web 时执行其既有检查；合入前按项目约定完成 `go vet ./...`、`go test ./...`。本轮仅编写规格，上表均未执行。

## 实施顺序

建议后续拆分保持五个可独立验收的范围，正式任务在规格批准后建立：

1. 交付 Worker 短事务接收和异步启动/准备/发送、一次性输入基准，以及 reason/status/create 的完整诊断与准入链路；在现有 Agent 上验收。
2. 交付设备端统一历史、ACP 分块合并与有界只读快照；完成 Web 契约迁移、ACP 基础层提取和 Pi/Codex/Kiro 回归。
3. 交付 Cursor SDK sidecar、Go 适配器、独立历史及完整安装包验证。
4. 交付 Grok，包括原生历史核查、停止与后台任务归属验证。
5. 在确认原生运行环境后交付 Antigravity，并同步六种 Agent 的系统支持矩阵。

共享 ACP、Pi/Codex 与 SDK 封装继续作为独立协议实现，不因 Worker 异步执行而把长时操作交给 IPC handler；所有运行中的结果必须先核对控制代次。

## 上游参考

所有链接固定到本设计核查的提交。转写时按实际引用更新来源清单，不跟随 main 自动变更。

| 参考 | 用途 |
|---|---|
| [ProviderAdapter](https://github.com/pingdotgg/t3code/blob/807319c/packages/provider-core/src/server/ProviderAdapter.ts)、[接入约定](https://github.com/pingdotgg/t3code/blob/807319c/docs/internals/adding-a-provider.md) | 能力边界、运行时与事件职责 |
| [Pi](https://github.com/pingdotgg/t3code/blob/807319c/packages/provider-pi/src/server/adapter.ts)、[Codex](https://github.com/pingdotgg/t3code/blob/807319c/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts) | 原生输入、取消与恢复竞态 |
| [共享 ACP](https://github.com/pingdotgg/t3code/blob/807319c/packages/provider-acp/src/server/adapter.ts)、[Grok](https://github.com/pingdotgg/t3code/blob/807319c/packages/provider-grok/src/server/adapter.ts)、[Antigravity](https://github.com/pingdotgg/t3code/blob/807319c/apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.ts) | 协议复用和各 Agent 扩展 |
| [Cursor SDK 封装](https://github.com/pingdotgg/t3code/blob/807319c/packages/provider-cursor/src/server/CursorAgentSdk.ts)、[适配器](https://github.com/pingdotgg/t3code/blob/807319c/packages/provider-cursor/src/server/adapter.ts)、[测试策略](https://github.com/pingdotgg/t3code/blob/807319c/docs/orchestration-v2/testing-strategy.md) | SDK 操作、本地历史和两层回放边界 |

## 待验证与批准事项

| 项目 | 当前依据与缺口 | 处理与阻塞范围 |
|---|---|---|
| Cursor 认证入口 | 已核查上游向 SDK 注入 API key，也有 SDK 登录与 credential store；未验证本机 `agent login` 的订阅凭据可直接复用 | 需审查本期是否接受显式 `CURSOR_API_KEY`；若要求直接复用 CLI 订阅登录，先验证公开接口并补齐设计，不能自动转成另一个计费账号 |
| Cursor SDK 基线 | 上游依赖 1.0.35；未在 Baton 安装或执行，也未核实跨进程 store、只读历史及 Node 要求 | 在 Cursor 实施前验证；不满足公开接口时返回设计评审，不能用私有格式猜测实现 |
| 各 Agent 的探测隔离 | Pi/Kiro 已有空目录建会话取模型路径，但未对六种 Agent 证明禁用用户级 hooks、扩展、MCP、交互登录和临时会话清理 | 每种 Agent 的隔离策略在启用前实测；无法保证时保留 unknown，不伪装为已安全探测 |
| Grok 原生历史 | 已核查 ACP 接入与 xAI 扩展，未证明独立历史足以恢复输入身份 | 在 Grok 标为 available 前录制；不能验证时保持未验证并说明原因 |
| Antigravity 安装与登录 | 上游依赖其托管程序、harness 和 profile；本设计选择用户准备环境，尚缺可复现的独立准备步骤 | 在该 Agent 实施前确定合法来源和本机认证入口；需要托管下载或登录时单独扩展并审查范围 |
| 新增系统与最低版本 | 只有上游代码证据，没有 Baton 在三个系统上的运行结果 | 实施时维护每系统版本、协议与能力记录，通过后才更新可用声明 |

审批本设计不等于上述组合已通过验证。实施记录应保存在对应转录说明和测试证据中，长期规格原地更新其最终行为。
