# Baton 技术设计

Status: approved
Owner: 待指定
Basis: [行为规格](PRODUCT.md) R-01～R-25；代码调查基线 `323a8a9`。Project Agent 见 [Project Agent TECH](../project-agent/TECH.md)，事项见 [Agent Inbox TECH](../agent-inbox/TECH.md)。

## 全景

```text
浏览器 ── HTTPS / WebSocket ── Coordinator ── PostgreSQL
                                  │  （API、业务处理器、进程内 Gateway）
                              出站 WSS
                                  │
                               batond ──── baton-project-runtime（Project Agent）
                                  │
                            Session Worker（每个 Thread 一个）
                                  │
                         Codex / Kiro / Pi / shell
```

一个 Thread 在设备上对应一个 Session Worker 和一个原生 Agent 会话。Worker 拥有这个 Thread 的消息队列、Turn 边界和回复账本；Coordinator 拥有 Thread 记录、消息意图和中心保存的回复。中心不能主动连接设备，所有下行命令通过设备建立的 WSS 连接送达。

| 进程 | 拥有的状态与职责 | 不负责 |
|---|---|---|
| Coordinator | 员工、设备、Thread、消息意图、回复与附件引用、Project、对话、事项；派发与期限扫描；浏览器 API | 原生会话历史、模型推理、设备上的文件 |
| Gateway（Coordinator 内） | 节点认证、连接代次、心跳、限流、有界队列 | 业务持久化、Thread 语义 |
| batond | 设备身份、中心连接、能力汇总、Worker 发现与启动、Project Runtime 启停与续租 | 不在内存中保存唯一的执行事实 |
| Session Worker | 一个 Thread 的原生 Agent 进程、消息队列、Turn 边界、回复账本、本地历史访问 | 签发身份、改派 Thread |
| Project Runtime | 一次 Project Agent 运行，见 Project Agent TECH | 执行命令、访问文件 |

Worker 由 batond 用同一可执行文件的内部子命令启动，与 batond 分开存活；batond 重启后重新连接原 Worker。POSIX 下 Worker 使用独立进程组，Windows 下持有 Agent 进程的 Job Object。Worker 与 batond 之间使用带认证的 Unix domain socket 或 named pipe。

中心按单个活动 Coordinator 设计，所有业务变更通过数据库事务和版本检查。

### 技术选择

| 位置 | 技术 |
|---|---|
| Coordinator、batond、Worker | Go 1.27 |
| Project Runtime | Node.js，`@earendil-works/pi-agent-core` 与 `pi-ai` |
| 中心存储 | PostgreSQL 16+，pgx，版本化 SQL 迁移 |
| 设备账本 | SQLite（WAL、FULL 同步，纯 Go 驱动） |
| Web | React、TypeScript、Vite，构建产物嵌入 Coordinator |
| 设备与中心通信 | TLS WebSocket，版本化 JSON 信封 |

不解析终端画面判断 Turn 结束，也不嵌入 Agent SDK；适配器使用各 Agent 的结构化双向接口。

## Thread 与 Turn

### 状态

中心 `threads.status` 取值与 R-10 一一对应：

| 值 | 界面 | 进入条件 |
|---|---|---|
| `waiting_device` | 等待设备 | 新建后尚未收到设备的 `thread.open` 确认 |
| `running` | 执行中 | 设备报告 `turn.started` |
| `idle` | 空闲 | 设备报告 `turn.ended`，且队列里没有待发消息 |
| `stopped` | 已停止 | 设备报告 Agent 进程退出或无法启动，附原因 |
| `unknown` | 状态未知 | 设备报告无法确认消息是否收到或 Agent 是否仍在运行 |
| `archived` | 已归档 | 员工归档；不再接收消息 |

除 `archived` 外，状态只由设备报告驱动。中心不根据自身重启、超时或连接断开改写状态，界面另外显示设备连接状态和最后报告时间（R-10）。`stopped` 和 `unknown` 的 Thread 仍可以接收新消息：Worker 先尝试恢复原会话（R-12），无法恢复时以原因拒绝。

### 消息的生命周期

每条消息有客户端生成的 `client_message_id`、发送方（员工或 Project Agent）和方式（`queue` / `steer`）。

```text
中心 accepted ──投递──▶ Worker queued ──▶ sent ──▶ 属于某个 Turn
                              │
                              └─ withdrawn（撤回或停止时尚未发出）
```

1. 中心在一个事务里保存 `thread_messages`（状态 `accepted`）和下行投递意图，返回 202。相同 `client_message_id` 与相同正文返回原记录，不同正文返回 409（R-08）。
2. 派发循环把消息送到设备。Worker 在自己的账本里插入消息（`client_message_id` 唯一），提交后回执；中心收到回执把消息标为 `queued`。重复投递命中唯一键，只回执不重复插入。
3. Worker 按方式处理：
   - `queue`：Agent 空闲时立即作为新 Turn 的第一条消息发出；Agent 执行中时留在 Worker 队列，Turn 结束后按 `seq` 顺序逐条发出，每条开启一个新 Turn。
   - `steer`：Agent 执行中时调用适配器的 `Steer`；Agent 已空闲时按 `queue` 处理。
4. 发送前 Worker 同步提交 `send_intent`，再调用适配器；适配器确认后记为 `sent`，并把消息归入当前 Turn。意图已提交但确认丢失时，用 `client_message_id` 查询原生历史；查不到也无法排除已发送时，消息和 Thread 都进入 `unknown`，不重发（R-13）。
5. 撤回只对 Worker 队列里尚未提交 `send_intent` 的消息生效；中心记录撤回请求，设备回执后标为 `withdrawn`。停止一轮时，Worker 在同一事务里撤回全部未发出的消息（R-11）。

接收消息时同时检查 64 KiB 正文上限和 JSON 编码后的 256 KiB 传输上限，并为存储代次、来源和外层帧预留容量。正文因控制字符转义而超过传输上限时返回 413，不写入消息或 outbox。

Worker 的队列对所有 Agent 统一实现，不使用 Agent 自带的 follow-up 队列。这样排队消息在 Worker 重启后仍按顺序各发一次，撤回语义也一致。Pi 的原生 follow-up 不使用。

### Turn 边界

Turn 由 Worker 定义：从一条消息被 Agent 接受开始，到适配器报告 `TurnEnded` 为止。适配器按原生信号判断：

| Agent | Turn 开始 | Turn 结束 | 回复 |
|---|---|---|---|
| Pi | `prompt` 被接受 | `agent_settled` | 每条 assistant `message_end` 的文本 |
| Codex | `turn/started` | `turn/completed`（completed / interrupted / failed） | `item/completed` 中 phase 不是 commentary 的 `agentMessage` |
| Kiro | `session/prompt` 发出 | `session/prompt` 返回 `stopReason` | 两次工具调用之间累积的 `agent_message_chunk` |
| shell | 命令启动 | 进程退出 | 一条回复，正文为合并输出，附退出码 |

结束原因写入 `turn.ended`：`completed`（Agent 停下等待输入）、`stopped`（员工或 Project Agent 停止）、`timeout`（到达执行时限）、`agent_exited`（进程退出）、`failed`（Agent 报告错误，例如 Codex 的 failed、Pi 的 error）。原因只用于展示和给 Project Agent 阅读，Baton 不据此判断任务成败（R-09）。

执行时限从 Turn 开始算起，默认 7200 秒，`ExecutionTimeoutSeconds` 接受 1～2,147,483,647 秒的整数。Worker 取单调时钟与墙上时钟的已用时最大值，包含休眠且避免时钟回退延长预算；定时器每次最多等待 1 秒，再核对剩余预算。`thread_settings` 命令以固定身份和内容持久化，将配置与完成回执写入同一事务，重复投递返回原回执。修改后从原 Turn 开始时间计算新的总预算，后续 Turn 也采用新配置。已进入停止流程的一轮继续停止。到期时 Worker 按下面的停止流程结束这一轮，原因为 `timeout`。

### 停止

员工停止、Project Agent 停止和执行时限到期走同一流程：

1. Worker 在一个事务里撤回队列中未发出的消息，记录停止请求和开始时间。
2. 调用适配器的 `Abort`。Agent 在 60 秒内停下（适配器报告 `TurnEnded`），这一轮以 `stopped` 或 `timeout` 结束，Thread 回到 `idle`。
3. 60 秒内没有停下，或 `Abort` 返回错误，Worker 结束 Agent 的整个进程树：POSIX 上向 Agent 的进程组发 SIGKILL，Windows 上终止 Agent 的 Job Object。进程树回收后，这一轮以原因结束，Thread 进入 `stopped`，原因为「Agent 没有在 1 分钟内停下，已结束进程」。下一条消息按 R-12 恢复原会话。
4. 进程树无法确认回收时，Thread 进入 `unknown`，这一轮仍以原因结束。

每个 Agent 在启动时放进自己的进程组或 Job Object，与 Worker 分开，所以结束 Agent 不影响 Worker 和账本。POSIX 下，独立守护进程读取由 Worker 持有写端的私有管道；Worker 崩溃或被强制结束时，管道关闭，守护进程结束整个 Agent 进程组。守护进程不持有协议的 stdin、stdout、stderr，Agent 的实际退出码和信号保持不变。Windows 下由 Worker 持有的 Job Object 在关闭时终止 Agent 及其后代。适配器正常关闭、协议失败或 Agent 自然退出时也执行幂等的进程树清理。Agent 用 `setsid`、服务管理器等方式脱离进程组启动的后台进程不在这个范围内，强制结束不能证明这类外部动作已停止，停止也不回滚已经发生的副作用（R-11）。

60 秒等待期间，Thread 保持 `running`，界面显示停止请求已发送。等待上限是 Worker 配置项，默认 60 秒。

因此每个已开始的 Turn 都会产生一次 `turn.ended`，Project Agent 不会一直等待（Project Agent PA-19）。

### 回复与附件

适配器每产生一条回复，Worker 在一个账本事务里保存回复正文、附件引用和 outbox 事件，再上报。中心按 `(thread_id, worker_seq)` 去重保存到 `thread_replies`。正文超过 32 KiB 时，Worker 保留开头和结尾各 16 KiB，记录原字节数和本地历史引用（R-09）。

附件引用来自两处：

- Agent 在回复中写出的登记目录内路径和 `commit <SHA>`。Worker 用 `fileaccess` 解析：路径必须位于某个登记根内，解析为 `{node_id, root_id, path, access_status}`；commit 解析为 `{repo, sha}`，`repo` 取工作目录所在仓库的 origin。无法解析的文本保持为正文，不生成附件。
- shell 回复的输出本身不作为附件；退出码作为回复元数据保存。

附件不复制文件内容，中心只存引用（R-18）。

## 中心数据

### 表

| 表 | 内容 |
|---|---|
| `employees`、`login_sessions` | 员工与登录会话 |
| `nodes`、`node_credentials`、`node_enrollments`、`employee_settings`、`node_presence`、`node_revocations`、`node_runtime_reports` | 设备身份、凭据、默认设备、在线状态、吊销、能力报告 |
| `threads` | 一个 Thread：员工、可选 Project、设备、Agent 类型、当前模型与后续消息默认模型 `next_model`、工作目录、执行时限、状态与原因、创建者（员工或 Project Agent 及工具调用）、`client_thread_id`、`opened_at`、`archived_at`、版本 |
| `thread_messages` | 消息：Thread、`client_message_id`、发送方、方式、可选模型、正文（≤ 64 KiB）、状态（accepted / queued / sent / withdrawn / unknown）、状态原因 `status_reason`（≤ 4 KiB）、所属 Turn |
| `thread_turns` | Turn：Thread、`worker_turn_seq`、发起方（员工或 Project Agent）、使用的模型、开始与结束时间、结束原因 |
| `thread_replies` | 回复：Thread、Turn、`worker_seq`、正文、截断标记与原字节数、附件 JSON、元数据（shell 的退出码） |
| `thread_events` | 只追加的审计事件：新建、消息接受、停止请求、归档、状态变化，附操作者与时间（R-23） |
| `thread_outbox` | 下行命令意图：`thread.open`、`thread.message`、`thread.withdraw`、`thread.stop`、`thread.resume`；下一次尝试时间、尝试次数、确认时间 |
| Project 相关表 | 见 Project Agent TECH 与 Agent Inbox TECH |

`threads` 以 `(employee_id, id)` 为复合唯一键，所有引用使用包含 `employee_id` 的复合外键。`client_thread_id` 在员工内唯一；Project Agent 创建的 Thread 另以 `(origin_conversation_id, origin_tool_call_id)` 唯一。

### 迁移

中心迁移从 `migrations/0001_initial.sql` 的当前 schema 基线创建员工、设备、Thread、Project、主对话、记忆和事项表。实验室阶段允许重建数据库，不提供旧开发版本的升级路径；正式发布后使用版本化增量迁移。

Thread、消息和 Turn 直接包含模型字段，消息保存 `status_reason`，Project 输入类型为当前七种输入。

`thread_reports` 保存 `(thread_id, event_id)`、连续 Worker 序号、报告内容摘要及原 ACK，不保存完整报告正文。摘要包含模型和恢复标记等当前报告字段，用于检测相同事件身份下的内容冲突。`thread_events` 只追加审计与时间线事件，回复事件保存限长正文。`threads.request_hash` 用于比较规范化的新建请求，读取接口不返回它。Turn 的 ID 与 Worker Turn 序号使用同一个含员工身份的复合外键，避免消息或回复关联到两个不同的 Turn。

`project_agent_input_queue` 的 Thread 输入为 `thread_reply`、`turn_ended`、`thread_message_failed`。`thread_reply` 为被动输入，`turn_ended` 与 `thread_message_failed` 为主动输入，参与放置、领取和重启后的通知重置。其他输入类型见 Project Agent TECH。

迁移文件编号之间允许空缺，`internal/migrate` 按文件名排序执行。

### 下行投递

`thread_outbox` 沿用[控制面调度设计](../control-dispatch-reliability/TECH.md)的规则：短事务领取并保存下一次尝试时间，提交后入队，不等待回包；每节点额度在全局 LIMIT 前应用；回包按 `message_id` 独立幂等保存。设备离线时意图一直保留，没有排队期限（R-14）。

同一 Thread 的命令按 outbox `id` 顺序投递，前一条未确认时不发下一条，保证 `thread.open` 先于第一条消息、消息之间顺序不变。message 和 withdraw 还要等 `thread.opened` 保存存储代次，后续命令携带该代次。归档后只领取仍需发送的 stop、withdraw，过时的 open、message 保留原记录，不再阻塞清理命令。首次启动失败时，尚未尝试投递的消息撤回，对应未投递命令结束为 cancelled，Thread 保留停止原因并允许归档。没有存储代次、Worker 报告或 Turn，全部 open 均以无存储代次的 `agent_unavailable`、`invalid_working_directory` 或 `working_directory_forbidden` 拒绝，且所有消息均撤回、投递次数为 0、没有接收回执时，允许原 Thread 显式重试打开。重试使用新的 open 命令 ID，保留旧输入和失败记录，不重发原消息。已接收 open 或原生创建结果不明时禁止重建。

### 上行报告

Worker 的报告类型：

| 类型 | 中心处理 |
|---|---|
| `thread.opened` | `waiting_device` → `idle`，保存原生会话标识 |
| `thread.open_failed` | → `stopped`，保存原因（目录不存在、Agent 不可用等） |
| `thread.resumed` | 确认原会话恢复且没有活动 Turn，Thread → `idle` |
| `message.queued` / `message.sent` / `message.withdrawn` / `message.unknown` | 更新消息状态、状态原因与所属 Turn；模型选择失败的撤回不关联 Turn，Thread → `idle` |
| `turn.started` | 插入 `thread_turns`，Thread → `running` |
| `reply` | 插入 `thread_replies` |
| `turn.ended` | 写结束时间与原因；Worker 队列为空时 Thread → `idle` |
| `thread.stopped` / `thread.unknown` | → `stopped` / `unknown`，附原因 |

每个报告带 `event_id` 和 Worker 序号。中心在一个事务里保存报告、更新状态，并按消息或 Turn 的归属写入 Project Agent 输入队列（Project Agent TECH 第 9 节），提交后返回 ACK；Worker 收到 ACK 才确认本地 outbox。重复报告按 `event_id` 返回原 ACK。中心按 Worker 序号处理，序号跳跃时拒绝并要求补报，保证 `turn.ended` 不会早于这一轮的回复入库。

原 Worker 账本缺失、损坏或结构不匹配时，batond 先补送节点账本中尚未确认的 Worker 报告，再发送带 `history_unavailable:true` 的 `thread.unknown` 恢复报告。暂时无法读取时继续有界重试，保留原 Worker 的报告序列。中心在同一报告事务内，将已有活动 Turn 以 `agent_exited` 结束。仍为 accepted、尚未关联 Turn，且对应的全部 message 命令 `attempts=0`、没有接收回执的输入撤回并保留原文；其他 accepted/queued 输入改为 unknown。未完成命令按派发事实结束：`attempts=0` 且无接收回执为 cancelled，其余为 unknown。事务同时保存审计、对应 Project 输入及 Thread 状态。历史缺失本身不证明 Agent 已退出，不能设置停止确认或完成等待停止的归档；停止确认仍须有 Turn 终止或进程树回收证据。设备确认停止、没有活动 Turn 和 accepted/queued 输入后，允许保留历史 unknown 输入并归档，不重发历史命令。领取新的 open、resume 或 message 命令时，在递增派发次数的同一事务内废弃旧停止确认；新的恢复或回合开始报告也废弃旧确认，避免用上一次停止的证据归档当前执行。重复恢复报告沿用原 ACK；普通状态报告仍须在 Turn 结束后提交。

## 设备与 Worker 数据

### batond 账本（`node.db`）

| 表 | 内容 |
|---|---|
| `meta` | 存储代次 |
| `threads` | 中心 Thread ID 到本地 Session 目录的映射、Agent 类型、工作目录；`thread.open` 的接收记录 |
| `workers` | Worker 进程索引 |
| `node_open_attempts`（TS） | 本地 IPC 和 daemon 的 open 交付事实，即使尚未登记 Worker 也先记录，后续登记不能覆盖 |
| `thread_command_receipts` | 命令 ID、请求摘要及原回执 |
| `thread_worker_reports` | 节点已读到、中心尚未确认的 Worker 报告；保留原事件身份、序号和正文 |
| `thread_node_reports`、`thread_report_progress` | 本地恢复报告及已发送序号，支持 Worker 账本不可读时补报 |
| `project_runtime_runs` | Project Runtime 的启动去重与清理确认，见 Project Agent TECH |

`thread.open` 先写 `threads` 再回执，重复命令返回同一映射。`thread.opened` 带上存储代次，中心保存在 `threads` 上，之后的命令都携带它。设备重装或 `node.db` 丢失后代次改变，batond 拒绝旧代次的命令，Thread 进入 `stopped`，原因为本地历史缺失，不会用同一个 Thread ID 新开一个空会话。设备账本按当前 schema 创建，只保存 Thread 与 Project Runtime 所需状态。TS 节点账本将 Worker 启动尝试与 open 交付阶段分开保存：登记配置时为 `startup_phase: awaiting_open`，daemon 和 Worker 的本地 IPC 入口在交付 open 前提交 `open_attempted`，收到绑定身份的状态、回执或报告也保留该事实。未交付 open、原账本缺失或确认为空且无执行记录时，允许用原命令 ID 和配置重试启动；可能交付后缺失或为空，以及账本损坏时，继续上报历史不可用。

### Worker 账本

每个 Thread 一份 SQLite，由对应 Worker 独占写入：

| 表 | 内容 |
|---|---|
| `meta` | Thread ID、Agent 类型、当前模型、适配器配置、原生会话标识、当前 Turn 序号与状态 |
| `messages` | `client_message_id`（唯一）、seq、方式、可选模型、正文、状态（queued / intent / sent / withdrawn / unknown）、状态原因 `status_reason`、所属 Turn |
| `turns` | Turn 序号、使用的模型、开始与结束时间、结束原因 |
| `replies` | 回复序号、Turn、正文、附件、元数据 |
| `outbox` | 待中心确认的报告 |

不变量：

1. 一条消息在 `intent` 之后不再自动发出第二次。
2. 同一时刻最多一个 Turn 处于开始而未结束的状态。
3. `turn.ended` 的 outbox 事件在这一轮所有 `reply` 事件之后写入。
4. 回复与对应 outbox 事件在同一事务提交；提交状态不明时从独立连接读回确认（沿用 `output_transaction.go`）。

`Send` 明确返回模型选择失败时，消息确定未发出，Worker 将它记为 `withdrawn`，清除预留的 Turn 序号，把原因保存到该消息的 `status_reason` 并通过 `message.withdrawn` 报告，不开启 Turn。原因摘要最多 4 KiB，替换无效 UTF-8 和 NUL，截断时保留完整字符并加省略号。Thread 保持 `idle`，保留 Agent 进程和当前模型，继续发送下一条排队消息。中心在同一事务保存消息原因；浏览器 Thread 详情和 Project Agent 的 `threads.get` 通过 `failed_messages` 读取这些失败消息。Project Agent 发起的失败消息另形成一条主动 `thread_message_failed` 输入，员工消息不写输入队列。无法确认消息是否发出的错误仍按发送意图恢复规则处理。Worker 在开始和结束报告中携带该 Turn 使用的模型，中心在 `turn.started` 时更新 Thread 当前模型。

完整原生历史由 Agent 保存在自己的文件里。TS Worker 对超出 512 字节、包含无效展示字符或占用保留前缀的回复 ID，稳定映射为 `baton:reply:sha256:…`；去重仍按原始 ID。正文中的 NUL 和孤立 UTF-16 代理项在中心报告、完整输出和实时输出中替换为 `�`。原始 ID、正文和执行身份以 JSON 保存在 `thread_outbox.payload.replyEvidence`，与安全展示报告同一事务提交，ACK 后继续保留；报告元数据标注 `reply_id_mapped`、`reply_text_sanitized` 和证据位置。显示字段异常不改变执行状态，Worker 继续核对回合终态；会话、输入或执行身份不匹配仍按 unknown 处理。

### 崩溃与恢复

| 位置 | 已知事实 | 恢复 |
|---|---|---|
| Worker 启动失败，open 尚未交付 | node.db 为 `awaiting_open`，Worker 无命令、输入、进程及报告记录 | 可重试启动，原 open 命令 ID、配置及存储代次不变 |
| open 可能已交付，Worker 账本缺失或为空 | node.db 为 `open_attempted`，可能已创建原生会话 | 上报历史不可用，禁止自动重建 |
| 消息已入 Worker 队列，未提交 `intent` | 尚未发出 | 按队列顺序继续发送 |
| `intent` 已提交，适配器确认未记录 | 可能已发出 | 查原生历史中的 `client_message_id`；找到则记 `sent`，否则 `unknown`，不重发 |
| Turn 进行中，Worker 崩溃 | Agent 可能仍在运行 | 新 Worker 连接原生会话；能确认这一轮已结束则补报 `turn.ended`，否则 Thread `unknown` 并以 `agent_exited` 结束这一轮 |
| 回复已保存，ACK 丢失 | 可重复上报 | 按 `event_id` 去重 |
| batond 重启 | Worker 可能仍在 | 重新连接 Worker；连接不上时启动新 Worker 走上一行 |

Worker 崩溃后 Agent 进程随进程组或 Job Object 一起退出，所以「Turn 进行中崩溃」通常落到 `agent_exited`。下一条消息触发恢复原会话（R-12）。

## Agent 适配

### 接口

```go
type Adapter interface {
    Start(ctx context.Context) error                         // 新建或恢复原生会话，使用配置里的模型
    Send(ctx context.Context, id, text, model string) error  // 开启新 Turn；model 为空时沿用当前模型；Agent 忙时返回 ErrBusy
    Steer(ctx context.Context, id, text string) error        // 加入当前 Turn，沿用当前模型；不支持时返回 ErrUnsupported
    Abort() (stopped, outcomeKnown bool, err error)          // 停止当前 Turn
    Drain() []Event                                          // 非阻塞取回 TurnStarted、Reply、TurnEnded、Exited、Uncertain
    Sent(id string) (bool, error)                            // 在原生历史里查找这条消息
    ReadHistory(ctx context.Context, cursor string) (HistoryPage, error)
    Capabilities() Capabilities                              // steer、resume、switch_model
    Close() error
}
```

`id` 是 `client_message_id`。TS Worker 与 agent-host 通过 fork 的 `ProviderAdapterV2` 执行 Agent，具体映射见 [Agent 适配设计](../agent-adapters/TECH.md)。Pi、Codex、Cursor 开放 Thread 内逐轮换模型，Worker 在 intent 中保存每轮选择，host 同时传入 `startTurn.modelSelection` 和 `appThread.modelSelection`；省略模型时沿用最近确认提交的回合模型，首次使用创建配置。恢复从输入账本取得最近确认提交的模型，保留原生会话身份。Steer 沿用活动回合模型，不接受显式模型。Kiro 的 fork adapter 通过能力覆盖明确关闭会话内换模型，Thread 固定创建时的选择。Pi 的 `set_model` 明确拒绝和 Cursor SDK 明确拒绝模型时，输入持久撤回并继续队列；不能确认是否提交的错误按 unknown 恢复，不重发旧输入。

`Sent` 用只读原生快照核对输入是否已被接收，按发送前持久记录的已确认 user 消息数量检查下一条正文，缺少证据时保持未确认；不重发可能已执行的输入。

### 各 Agent

| Agent | Steer | 恢复 | 模型 | 备注 |
|---|---|---|---|---|
| Pi | 原生 `steer` RPC | 恢复原 JSONL 会话 | 每轮 prompt 前按输入选择执行 `set_model` | 使用 fork 的 `provider-pi`，停止与事件归一化沿用上游 |
| Codex | `turn/steer`，带 `expectedTurnId` | `thread/resume` | 每次 `turn/start` 传入该轮模型 | 使用 fork 的 `provider-codex` |
| Cursor | 不支持 | 恢复已保存会话与 SDK store | 每轮在恢复会话和 SDK send 时传入模型 | 使用 fork 的 `provider-cursor` |
| Kiro | fork adapter 明确关闭插入能力 | `session/list` 核对 ID 与 cwd 后 `session/load` | 新建用 `_meta.kiro.modelId`；`default` 省略；fork 的 `kiroCapabilityOverrides.sessions.supportsModelSwitchInSession` 为 false | 使用 `kiro-cli acp --agent-engine=v3`；能力覆盖按当前 adapter 实现报告 |
| shell | 不支持 | 不支持 | 不适用 | 只供 Project Agent 的命令执行使用，一个 Thread 只有一个 Turn，见 Project Agent TECH 第 10 节 |

Kiro 只提供排队。需要打断时，员工先停止这一轮再发消息。

各 Agent 的系统提示只说明运行环境（Baton Thread、工作目录、附件写法），回复按普通文本保存。

### 能力上报

batond 在 `node_runtime_reports.report.agents` 上报每种 Agent 的 `{agent_type, version, status, reason?, models:[{id, name}], default_model, capabilities:{create, queue, steer, stop, resume, switch_model}}`。模型目录由 fork 的 driver 探测：Codex 使用 `model/list`，Pi 使用 `get_available_models`，Kiro 经 ACP 发现会话取得模型，Cursor 使用 SDK 模型查询。目录用于发现与补全，显式模型 ID 交给原生 Agent 判定；目录为空时仍可使用默认模型或手填 ID，换模型操作继续校验 `switch_model` 能力。

`status` 为 `available`、`unverified` 或 `unavailable`。程序或 SDK 已安装且认证 valid/unknown 时报告 available，开放 create/resume；缺程序或明确认证 missing 时报告 unavailable。系统与版本不设白名单，未知版本、版本探测超时、模型目录问题和能力限制记录在 reason 中；整次探测失败且安装状态未确认时报告 unverified。Cursor 的资产、辅助程序或 sandbox 明确失败时报告 unavailable。shell 须单独开启本机命令权限。中心按目标系统路径规则检查工作目录属于上报的 roots，设备在执行前核实目录存在与真实路径边界。

TS daemon 在独立探测循环调用 `probeLocalAgents`，每轮结束后默认间隔 30 秒，单次 host 探测最多 30 秒。探测失败保留诊断，后续循环继续重试，不按可执行文件路径或版本永久缓存空目录。探测不发送 prompt、不发起登录；Kiro 的模型发现会建立空的 ACP 会话。能力探测与目录采集、连接、心跳和 Worker 消息分别运行。

## 接口

### 浏览器 API

URL 相对 `/api/v1`。读取检查员工会话与资源归属，写入另检查同源 Origin 和 CSRF；会话恢复与 CSRF 派生见「账号与保留」。

| 接口 | 行为 |
|---|---|
| `GET /me` | 返回 `{employee, csrf_token, expires_at}`，供页面刷新后恢复会话；员工信息包含 `must_change_password` |
| `POST /node-enrollments` | 创建一次性注册凭据，返回 `enrollment_id`、`enrollment_token`、`expires_at` 和非负的 `expires_in_ms`；凭据仅在创建时返回 |
| `GET /node-enrollments/{id}` | 仅查询本人记录，其他员工的记录返回 404；返回 `enrollment_id`、`state`、可空 `device_id`、`expires_at`、`expires_in_ms`。未使用时按期限显示 `pending` / `expired`；已使用且关联设备未吊销、在线并已同步时为 `connected`，其余已使用记录为 `used` |
| `GET /nodes`、`GET /nodes/{id}` | 返回本人设备状态。Node DTO 包含 `registered_at`、可空 `runtime_report`、`runtime_report_version`、可空 `runtime_reported_at`，以及报告中的 `batond_version`、`user`；在线状态和最后联系时间独立返回 |
| `GET /nodes/{id}/roots` | 通过 `node.browse_roots_get` 从本人在线且已同步设备分页读取完整授权目录，返回 `{roots,next_cursor?}`，续页传 `cursor`。单页 JSON 最多 48 KiB，独立于能力报告的 64 KiB 摘要；清单变化返回 409 `roots_changed`，从第一页重读。每次请求在设备响应后复查授权 |
| `POST /nodes/{id}/roots`、`DELETE /nodes/{id}/roots` | `{path}`；通过 Gateway 等待本人在线且已同步设备保存目录设置，返回含最新 `roots`、`repos` 摘要的 Node DTO，超限标记 `truncated`；网页另行读取完整目录清单。添加支持真实路径幂等登记，移除支持路径或目录标识；无效路径返回 400，节点离线返回 503 `node_offline` |
| `POST /nodes/{id}/subscriptions/login` | `{provider}`；通过 Gateway 启动设备端 OAuth 设备码登录，返回 `{provider, verification_uri, user_code, expires_in_seconds}`，凭据留在设备。转换 ChatGPT、xAI、Claude 别名并将 provider ID 交给设备的 Runtime 实现；当前 ChatGPT 和 xAI 支持设备码，Anthropic 使用终端 OAuth 或本地 API key 配置。网页依据设备报告的 `login_methods` 显示入口，API key 不经过此接口；未取得设备码返回 503 |
| `PUT /nodes/{id}/project-exec` | `{enabled}`；通过 Gateway 等待在线且已同步设备原子保存并回读本机开关，确认后返回 Node DTO，报告中的 `exec` 使用设备确认值；未确认返回 503，客户端重新读取状态。协议与 `exec.user` 见 Project Agent TECH「节点能力报告」 |
| `POST /threads` | `client_thread_id`、可选 `node_id`（缺省为默认设备）、`agent_type`、可选 `model`（缺省为该 Agent 的 `default_model`）、`working_directory`、可选 `execution_timeout_seconds`（1～2,147,483,647 的整数，默认 7200）、第一条消息 `message:{client_message_id, content}`。浏览器新建的 Thread 不属于 Project。预算参与创建幂等内容，并固定存入 open 命令的 outbox payload；以后修改 Thread 设置不会改变原 open 命令的重试内容。新建返回 201，幂等重发返回 200，内容冲突返回 409 |
| `GET /threads` | 可按 `project_id`、`node_id`、`status` 筛选，按 `(last_activity_at, id)` 倒序分页；`limit` 默认 50、最多 100，续页使用 `next_cursor`。每条记录包含 Thread 基础字段、`title`、可空 `current_turn` 和 `stop_canceled`，供列表直接展示 |
| `GET /threads/{id}` | Thread、状态、当前 Turn、待发消息、失败消息、`resume_pending` 和 `retry_open_allowed`；后者由持久拒绝及投递记录计算，表示可在原 Thread 重试打开；`model` 为实际模型，`next_model` 为后续排队消息的默认模型 |
| `GET /threads/{id}/timeline` | 按审计事件 ID 顺序返回消息、Turn 边界、回复和操作；`limit` 默认 20、最多 100，续页使用 `next_cursor` |
| `POST /threads/{id}/messages` | `{client_message_id, content, mode, model?}`，返回 202；`mode` 缺省为 `queue`，`steer` 在 Agent 不支持时返回 422；Agent 不支持换模型或 `model` 与 `steer` 同时出现时返回 422。模型目录不限制显式 ID |
| `POST /threads/{id}/messages/{mid}/withdraw` | 撤回排队消息；已发出返回 409 和当前状态 |
| `POST /threads/{id}/stop` | 返回 202，保存停止及撤回排队消息的意图，状态等待设备报告确认 |
| `PATCH /threads/{id}/settings` | `{execution_timeout_seconds}`；范围与新建相同，更新本人未归档 Thread 并返回 200 和 ThreadView。中心将预算和固定内容的 `settings` 命令一起持久化；相同设置重试不重复入队，命令按顺序送往设备。200 表示已保存，设备收到后更新 Worker 配置和当前 Turn 的总预算；离线期间等待投递，已开始停止的 Turn 不会恢复运行。无效参数返回 422，已归档或请求归档返回 409 |
| `POST /threads/{id}/model` | `{model}`；校验切换能力，显式 ID 交给原生 Agent 判定，保存 `next_model` 并返回 200 和 ThreadView。后续接受的 `queue` 消息未指定模型时采用该值；已有消息和当前 Turn 沿用原配置，实际模型由 `turn.started` 确认 |
| `POST /threads/{id}/resume` | `{}`；Thread 已打开、处于 `stopped` / `idle` / `unknown`、无待确认停止或归档且 Agent 报告恢复能力时，保存恢复命令并返回 202 和 ThreadView。尚未打开且 `retry_open_allowed` 为 true 时，改为保存新身份的 open 命令；原消息保持撤回。`resume_pending` 表示未完成的恢复或重试打开命令，同一待完成请求不重复入队。不支持返回 422，状态冲突返回 409 |
| `POST /threads/{id}/archive` | 返回 202；有进行中的 Turn、待发消息或尚未确认停止的不确定状态时先发停止，设备确认后归档。停止已确认且无活动 Turn 或待发消息时，历史 unknown 输入保留并允许归档；空闲或已停止、无不确定输入与待发消息时直接归档 |
| `GET /threads/{id}/history` | 从设备分页读取原生历史，见「历史读取与实时输出」 |
| `GET /threads/{id}/output` | 默认经设备临时 RPC 读取实时输出；`action=full_output&output_id=...&storage_generation=...` 按可选字节游标读取设备保存的完整回复或 shell 输出，每页最多 12 KiB 原始字节，以 Base64 返回，详见「历史读取与实时输出」 |
| `GET /threads/{id}/trace` | 必填 `worker_turn_seq`，返回 `{ok, code?, steps}`。shell 的步骤取自中心已保存的命令和文本输出，含 `kind:"command"`、`command`、`output`、可选 `truncated`；网页保留已有步骤和输出，在 `truncated:true` 的步骤旁显示截断提示，继续使用现有传输大小边界；无可用过程时返回 `ok:false, code:"trace_missing"`，指定 Turn 不存在返回 404 |
| `/events` | 浏览器 WebSocket，订阅 Thread 的实时输出与状态变化 |

登录、默认设备、文件浏览和 Inbox 沿用各自接口；Project 创建、对话与记忆修订契约见 Project Agent TECH。Thread 使用独立的 Store 和协议；`/tasks*`、`/sessions*`、`/acceptances` 业务接口已移除。

Thread 列表摘要在一次 SQL 查询中读取。`title` 取首条已接受消息的首行，最多 120 个 Unicode 字符；为空时依次使用工作目录和 Thread ID。`current_turn` 为未结束的 Turn，`stop_canceled` 为最近一次停止或归档请求之后的单条消息撤回事件数，无请求时为 0。浏览器刷新列表只请求列表分页，打开会话后才读取对应的详情和 timeline。

浏览器 WebSocket 接受 `{thread_id, cursor?}` 订阅，发送 `thread.changed` 和 `thread.output`；每个连接订阅一个 Thread，新订阅替换旧订阅，`{thread_id:""}` 取消输出订阅并保留连接。Thread 的历史与输出复用 `session.request`，其中 `session_id` 为 Thread ID；正文不持久化，历史响应为 `Cache-Control: no-store`。

错误对象为 `{code, message, request_id, details?}`；`details` 不回传凭据和完整工具输出。

### 节点消息

| 方向 | 类型 | 用途 |
|---|---|---|
| 下行 | `thread.command` | 携带 outbox 的一条命令：open / message / withdraw / stop / resume |
| 上行 | `thread.command_result` | 命令已被 batond 或 Worker 持久化的回执 |
| 上行 | `thread.report` | Worker 报告（上表），中心持久化后回 `thread.report_result` |
| 双向 | `session.request` / `session.result` | 临时 RPC：实时输出、原生历史；正文不进中心持久化 |

Thread 命令以信封 `message_id` 作为稳定身份，`thread.command_result` 用信封 `correlation_id` 引用它，正文含 `{type, thread_id, ok, code?}`。报告正文含 `{type:"thread.report", thread_id, event_id, worker_seq, kind, ...}`，其中 `kind` 为「上行报告」表中的类型，`worker_turn_seq` 标识 Turn，`client_message_id` 标识消息。`turn.ended` 的 `queue_empty` 表示 Worker 是否还有排队消息。回执含 `{type:"thread.report_result", thread_id, event_id, worker_seq, ok, code?, expected_worker_seq?}`；序号不连续时返回 `worker_sequence_gap` 和下一条期望序号，不保存该报告。

Thread 回包事务按 Node → Credential → Presence 锁定认证记录，再锁目标 Outbox 或 Thread；全部锁取得后用数据库当前时刻复核凭据期限。凭据吊销、连接替换和锁等待跨越有效期都不能写入执行事实。

Thread 没有排队期限，消息由员工明确发出，设备收到即可执行。启动与回复通过 Thread 命令和报告确认。

### 协议扩展

消息携带协议版本，接收方忽略未知字段，继续验证必填字段、身份、关联标识和容量；可选能力缺省关闭。浏览器 API、模型工具参数和本地配置保持严格检查。实验室阶段统一当前结构，正式发布版本的兼容范围按 R-25 约定。

## 通信与认证

### Gateway

节点协议版本 1，信封为 version、message_id、route、priority、correlation_id、body。Gateway 根据认证结果构造 `employee_id`、`node_id`、`credential_id`、`incarnation`、`conn_id`；客户端自报来源、节点到节点路由、未知版本和未允许的消息类型均拒绝。优先级由消息类型决定，节点不能把输出声明为控制消息。

| 接口 | 职责 |
|---|---|
| Authenticator | 验签、受众、有效期、吊销 |
| NodeHandler.Connected / Disconnected | 以 `conn_id` 条件更新上下线，旧连接的断开不覆盖新连接 |
| NodeHandler.Handle | 类型白名单，身份不从 body 读取，分派前复核连接和吊销 |
| NodeSender.Send | 进入有界发送队列；离线或满队列返回错误 |

保护上限：握手并发 32、业务并发 16、活动连接 128；每节点控制入站每秒 64 条、输出每秒 128 条。`Send` 成功只表示入队；持久化命令由接收方保存后返回业务 ACK。

### 凭据与吊销

TS 中心的控制操作分别计算排队和执行预算。默认排队 2 秒，执行按操作为 3～15 秒；Thread 报告为 15 秒，命令接收回执为 10 秒。通过 `BATON_CONTROL_<操作名>_QUEUE_TIMEOUT` 和 `BATON_CONTROL_<操作名>_EXECUTION_TIMEOUT` 调整。持久报告或命令回执暂时超时后保留连接，节点用原身份继续恢复；明确的身份或协议错误仍关闭连接。全部操作名和 RPC 并发、排队配置见 [中心配置说明](../../apps/server/README.md)。

节点凭据为 Ed25519 签名 JWT，受众 `baton-node`，绑定节点、员工、credential_id 与有效期。吊销顺序：PostgreSQL 提交 → 本地认证与分派拒绝该凭据 → 关闭活动连接 → 保存已生效事实；只有完成后 API 才返回 effective（R-04）。

节点上线附带每次 batond 启动生成的 incarnation；已有不同 incarnation 活动时拒绝接管（R-02）。新连接完成 `node.sync` 后才标为可用（R-03）。

### 容量上限

| 配置 | 初始值 |
|---|---|
| 单条传输消息 | 256 KiB |
| 输出片段与历史页 | 16 KiB |
| 文本文件预览单片 | 64 KiB |
| 单连接控制队列 | 32 条且 1 MiB |
| 单节点输出待发送量、单订阅待发送量 | 各 256 KiB |
| 中心输出缓存总量 | 32 MiB |
| 心跳 / 离线判定 | 10 秒 / 30 秒 |
| 重连退避 | 1～30 秒带抖动 |

输出超限时丢弃实时缓冲中的旧片段并标出缺口，控制消息不丢（R-16）。Worker 持续读取 Agent 的 stdout 和 stderr，避免管道反压；回复全文与 shell 原始输出另存设备私有文件，传输摘要预算不影响已保存的全文。

## 历史读取与实时输出

TS Worker 在裁剪普通回复报告前保存 UTF-8 全文；shell 从 stdout/stderr 原始数据块开始写入完整内容。文件位于 Thread 私有目录的 `full-output/`，回复 metadata 保存 `{id, storage_generation, total_bytes, expires_at}` 引用，中心的有界回复和时间线保留该引用。`GET /threads/{id}/output?action=full_output` 经员工与 Thread 归属检查转发到原设备，节点核对 Thread、输出 ID 和存储代次，验证私有目录与普通文件，不接受符号链接。读取无需启动 Worker。

完整输出按字节偏移分页，每页最多 12 KiB 原始数据，以 Base64 返回 `full_output:{output_id,storage_generation,offset,next_offset,total_bytes,expires_at,encoding,data,done}`，下一游标为 `next_offset` 的十进制字符串。网页逐段解码，保留跨页 UTF-8 字符，只显示当前页，并支持继续读取、从头读取和下载当前片段。默认保留 30 天，可在设备 `--data-dir/output-retention.json` 设置 `retention_days`（1～3650）；daemon 启动时及每小时清理过期内容，读取过期内容时立即删除并返回 `output_expired`。无元数据的未完成文件在 Worker 不运行且 24 小时未写入后清理。原生 Agent 历史的保留由员工管理。

`GET /threads/{id}/history` 接受可选 `cursor` 和 `limit`（默认及上限均为 16），校验归属后经 `session.request` 读取设备上的原生历史。响应为 `SessionResult`，成功时包含 `history:{entries,cursor,has_more,gap,code?}`；条目携带 `id`、`parent_id`、`kind`、`text`、本地 `reference`、原字节数 `bytes` 和 `truncated`。调用方按返回游标续读到 `has_more:false`。响应为 `Cache-Control: no-store`，正文不进入 PostgreSQL 或日志。每页最多 16 条、14 KiB，单条 JSON 编码后最多 4 KiB，超出时保留截断标记和 `<agent>:<id>:<偏移>` 形式的本地引用，并设置缺口。

Pi 读取原生 JSONL，Codex 读取 thread 文件并核对 thread ID、cwd 和 CLI 版本；文件读取用 `os.OpenRoot` 限制边界，只接受普通文件。Kiro 通过独立 ACP 连接加载已保存会话，收集原生记录，不发送 prompt，也不触碰执行连接。游标绑定原生会话与已读前缀摘要，前缀被删除、重排或改写时返回 `history_changed`。离线返回 `node_offline`，历史缺失返回 `history_missing`，其他读取错误返回 `history_unavailable`。TS 中心按设备为临时读取保留默认 4 个在途名额，为管理操作另留 2 个名额；每类最多排队 8 个请求，默认排队 2 秒，参数可由中心环境配置调整。排队超时的请求不会发送，已发送的管理请求超时后不自动重发。历史读取不依赖 Worker 存活。

实时输出由 Worker 保留当前 Turn 最近 256 KiB 纯文本，`GET /threads/{id}/output?cursor=...` 每次最多读取 16 KiB。游标为 `epoch:字节偏移`，Turn 切换或 Worker 重启更换 epoch；旧 epoch、超出保留范围或上游输出已丢失时返回 `gap:true` 并从当前保留起点续读。格式错误或偏移落在 UTF-8 字符中间时返回 `invalid_cursor`。查询结果包含当前设备报告的状态与下一游标，成功与设备不可用结果均通过 `ok`、`code` 区分（R-16）。

浏览器为当前打开且执行中的 Thread 订阅输出，按 `thread.output` 增量更新该 Thread 的本地输出缓存；连接可用时，定期刷新输出查询只读取缓存。连接尚未就绪或已断开时，通过 HTTP 按游标续读，重连后用最近一次成功读取的游标恢复订阅。输出 epoch 变化时清空上一轮内容，读取缺口和浏览器 256 KiB 缓存淘汰均显示缺口标记；执行结束后清空输出，离开会话时取消订阅并释放缓存。设备、Project 等其他主题仍由现有定时刷新维护。

## 文件浏览

设备本地定义可浏览的 `root_id` 和真实路径，浏览器只提交 `root_id` 和相对路径。Go 节点用 `os.Root` 验证边界；TypeScript 节点校验授权根、realpath、祖先目录和已打开句柄的设备与 inode 身份，覆盖符号链接和路径替换。仅祖先 ctime 变化时丢弃本次结果，完整重新授权并读取，最多尝试 3 次；持续变化返回 `path_changed`，身份或边界变化返回 `path_escaped`。附件预览复用同一授权边界（R-18）。中心不代取任意 URL，不提供文件存储。

TypeScript 的 `GET /nodes/{id}/files` 通过 `root_id`、`path` 浏览目录和文件。POSIX 路径保留冒号和反斜杠的字面含义；Windows 相对路径拒绝冒号、反斜杠、驱动器与 ADS，所有系统拒绝绝对路径、控制字符和 `..` 路径段。目录每页最多返回 200 项、处理 4096 个新条目，`next_cursor` 携带扫描位置和目录版本；续页重新打开目录并跳过已读位置，可继续读取整个目录；目录变化返回 `directory_changed`，网页保留已取得的条目并提示重新读取。未指定根时复用授权根管理接口的分页，每页 JSON 不超过 48 KiB，游标绑定清单版本和下一项位置。

文本文件每片最多 64 KiB，响应包含 `offset`、`version`，以及有后文时的 `next_offset`。续读必须同时提交返回的字节偏移和版本；版本绑定真实路径、设备、inode、大小、mtime 和 ctime，读取前后核对，文件变化返回 `file_changed`。分片止于完整 UTF-8 字符，网页通过继续读取追加内容，变化时提示重新打开文件。二进制和特殊文件继续拒绝。

## 账号与保留

本地员工账号由管理员创建，Argon2id 口令摘要，服务端登录会话；改密和重置注销既有会话。会话 Cookie 固定使用 Secure、HttpOnly、SameSite=Strict。`GET /me` 从当前会话令牌经固定域前缀隔离的 SHA-256 摘要派生稳定 CSRF token，并以 URL-safe Base64 返回；同一 Cookie 在页面刷新及 Coordinator 重启后得到相同 token，读取不续期或轮换会话。数据库仅保存会话令牌摘要与派生 token 的摘要，写请求用 `X-CSRF-Token` 校验。JSON 响应和日志不得暴露 Cookie 原值，也不以会话令牌或其存储摘要直接充当 CSRF token。注册凭据 10 分钟单次使用，节点凭据 30 天（D2）。

中心记录默认长期保留，没有自动清理；回复正文已限长。设备上 Baton 保存的完整回复与 shell 输出默认保留 30 天，原生 Agent 历史由员工自己管理。设备账本与待补报数据设 1 GiB 预算，达到预警水位后拒绝新 Thread 和新消息，不删除未确认的报告（D4）。

## 敏感数据

设备密码、模型订阅凭据、节点私钥只存在设备上，文件权限为当前用户 `0600`（Windows 为受保护 DACL，只授权当前用户 SID）。节点凭据和注册凭据不进日志、URL 或命令行。中心不持久化实时输出和原生历史（R-22）。

## 部署

中心服务二进制为 `baton-server`，入口在 `cmd/baton-server`，与 PostgreSQL 部署在一处，提供静态页面、API、浏览器 WebSocket 和节点 WSS。`serve` 先执行 `migrate.Up`，再执行 `migrate.Check`；`migrate` 子命令可单独运行。签名密钥路径由 `BATON_NODE_SIGNING_KEY` 指定，默认工作目录下的 `node-signing.key`；仅在 `Lstat` 确认文件不存在时生成 Ed25519 私钥并原子写入 `0600` 文件，已有文件继续校验权限、类型和内容。升级时先停止旧实例，再启动新实例完成迁移；batond 退避重连并同步。

`Dockerfile` 分别用 Node.js 24 构建 Web UI、Go 1.27 静态编译服务端，再放入 Debian bookworm slim 镜像，以非 root 用户运行。`compose.yaml` 等待 PostgreSQL 16 健康后启动中心服务，数据库和 `/var/lib/baton` 分别挂载数据卷，签名密钥保存在后者。容器监听 `0.0.0.0:8080`，宿主机默认绑定 `127.0.0.1:8080`，通过 HTTPS 反向代理公开 HTTP/WebSocket 服务。

`batond register` 默认将 `runtime.GOOS` 映射为系统名，将主机名去除首尾空白和控制字符并限制到 80 个字符，空名称回退为 `Workstation`。注册成功后，`identity.json` 的可选 `coordinator_url` 保存规范化的 HTTPS 中心地址；非空时读写身份均校验地址。`batond run` 优先使用显式 `--relay`，否则从中心地址推导 `wss://主机/v1/node`。`batond up` 复用相同的注册和运行逻辑，在本地没有身份时要求中心地址和注册凭据；workspace 通过本机目录登记逻辑在连接前幂等保存。设备上 Windows 用当前员工的登录启动项，macOS 用 LaunchAgent，Linux 用 `systemd --user`，不以 root 或 LocalSystem 运行。

承载 Project Agent 的设备另外安装 Node.js 和 `baton-project-runtime`，见 Project Agent TECH 第 2.1 节。

## 模块职责与后续实施

| 模块 | 职责 |
|---|---|
| `internal/gateway`、`internal/protocol` | 节点认证、版本化信封、有界队列、Thread 命令与报告、临时查询 |
| `internal/node` | 设备身份、注册与连接、能力报告、文件浏览、Thread Worker 与 Project Runtime 管理、本地节点账本 |
| `internal/session` | Thread 消息队列、发送意图、Turn、回复与 outbox、Worker 进程、本地认证 IPC、原生历史和实时输出 |
| `internal/agent/{pi,codex,kiro,shell}` | 原生 Agent 的 Thread 接口、模型选择、停止、恢复和历史查询 |
| `internal/agent/replay` | 录制、规范化、协议回放与故障派生 |
| `internal/store` | 设备与连接、Thread、消息与报告、Project、对话、记忆、放置、租约、投递、输入和 Inbox 事务 |
| `internal/control` | Thread 命令派发、报告回执、节点同步、Project 放置与 Runtime 命令、临时文件和历史查询 |
| `internal/monotime` | 包含系统休眠的单调时钟，供 Turn 执行时限与 Project Runtime 租约使用 |
| `internal/fileaccess` | 登记根内的受限浏览与 Thread 附件解析 |
| `internal/httpapi` | 员工、设备、Thread、Project、Inbox 与浏览器事件 API |
| `migrations` | 当前数据库 schema 基线与迁移执行器 |
| `web/src` | 按 `design/` 实现的页面，经 `BatonClient` 默认使用同源 HTTP API；开发模拟场景由显式参数启用 |

后续实施：

7. **Web。** 按 `specs/web-ui/PLAN.md` 验证页面流程、真实 HTTP 契约、错误反馈与状态同步。
8. **端到端。** 真实 Codex、Kiro、Pi 各跑一遍 PRODUCT 验收表的多轮、排队可靠性和恢复场景。

每一步结束时 `go vet ./...`、`go test ./...` 和前端测试通过。

## 验证

| 需求 | 设置与观察 | 失败条件 | 位置 |
|---|---|---|---|
| R-01 | 两名员工，交叉请求 Thread、消息、历史、文件 | 返回内容或向对方设备发送命令 | HTTP 集成 |
| R-02～R-04 | 注册过期、克隆身份、吊销与重连并发、中心重启 | 已吊销凭据继续操作；旧连接断开把新连接标为离线 | Gateway 集成 |
| R-07、R-08 | 同一 `client_thread_id` / `client_message_id` 重复提交 100 次，正文相同与不同各一组 | 多于一个 Thread 或消息；不同正文未返回 409 | PostgreSQL 集成 |
| R-08 | 执行中排队 3 条、插入 1 条、撤回 1 条；Kiro 请求插入 | 排队顺序错误；撤回的消息被发出；Kiro 接受插入 | Worker 回放 |
| R-08、R-13 | 排队 2 条后在 Turn 结束前、`intent` 后、适配器确认后分别杀 Worker | 任一消息发出两次或丢失；无法确认时没有进入 unknown | Worker 故障注入 |
| R-09 | 一轮 3 条回复，中心在第 2 条后重启；超过 32 KiB 的回复 | 中心回复重复、缺失或乱序；`turn.ended` 早于回复入库；超长正文未截断 | Store + 假节点 |
| R-09、R-14 | 执行时限 2 秒，Agent 不停；`Abort` 无法确认 | 没有 `turn.ended`；原因不是 timeout；无法确认时状态不是 unknown | Worker 回放 |
| R-11、R-14 | Pi 执行 `sleep 600` 时停止，等待上限设为 2 秒；子进程再 fork 一个子进程 | 超过上限后 Agent 进程组仍有存活进程；Thread 不是 stopped；Worker 被一起结束 | Worker 进程测试，三类系统 |
| R-10 | 设备离线后查看执行中的 Thread | 界面显示执行中但没有最后报告时间和离线标记 | Web 测试 |
| R-11 | 在 Turn 开始前、执行中、刚结束时停止，各有 2 条排队消息 | 排队消息被发出；未确认就显示已停止 | Worker 回放 |
| R-12 | Agent 进程退出后发消息；删除原生历史后发消息 | 恢复时 Thread ID 改变；历史缺失时新建了空会话 | Worker 回放 |
| R-15、R-22 | 一轮结束后让设备离线，检索中心数据库与日志中的随机标记 | 回复不可见；原生历史或实时输出出现在中心 | 集成 |
| R-16 | 设备 A 持续输出，设备 B 同时收消息和停止 | B 的命令延迟超过约定值；缓冲无界增长 | Gateway 负载测试 |
| R-18 | 回复里写登记目录内路径、目录外路径、`commit <SHA>` | 目录外路径生成附件；commit 缺少仓库 | 单元测试 |
| R-19、R-20 | 执行中重启 Coordinator、batond、Worker，短停 PostgreSQL | 消息重发；回复重复；同步前设备显示可用 | 进程测试 |
| R-24 | 500 台设备、100 个执行中 Thread，24 小时 | 未达到约定阈值（D6） | 压测环境 |
| R-25 | 当前消息带未知字段、未声明可选能力 | 未知字段导致拒绝或已知字段改变；未声明能力被启用 | 协议扩展测试 |

真实 Agent 的验收只能在对应系统上进行；交叉编译不代替 Windows、Linux 原生验证。

## 待定

| 编号 | 事项 | 阻塞范围 |
|---|---|---|
| Q3 | 各 Agent 在三类系统上的实际能力（D1） | 支持矩阵 |
| Q5 | 压测阈值（D6） | 容量达标声明 |
