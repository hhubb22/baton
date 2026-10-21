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

执行时限由 Worker 用包含休眠的单调时钟计时，从 Turn 开始算起。到期时 Worker 按下面的停止流程结束这一轮，原因为 `timeout`。

### 停止

员工停止、Project Agent 停止和执行时限到期走同一流程：

1. Worker 在一个事务里撤回队列中未发出的消息，记录停止请求和开始时间。
2. 调用适配器的 `Abort`。Agent 在 60 秒内停下（适配器报告 `TurnEnded`），这一轮以 `stopped` 或 `timeout` 结束，Thread 回到 `idle`。
3. 60 秒内没有停下，或 `Abort` 返回错误，Worker 结束 Agent 的整个进程树：POSIX 上向 Agent 的进程组发 SIGKILL，Windows 上终止 Agent 的 Job Object。进程树回收后，这一轮以原因结束，Thread 进入 `stopped`，原因为「Agent 没有在 1 分钟内停下，已结束进程」。下一条消息按 R-12 恢复原会话。
4. 进程树无法确认回收时，Thread 进入 `unknown`，这一轮仍以原因结束。

每个 Agent 在启动时放进自己的进程组或 Job Object，与 Worker 分开，所以结束 Agent 不影响 Worker 和账本。Agent 用 `setsid`、服务管理器等方式脱离进程组启动的后台进程不在这个范围内，强制结束不能证明这类外部动作已停止，停止也不回滚已经发生的副作用（R-11）。

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
| `employees`、`login_sessions` | 员工与登录会话（0001） |
| `nodes`、`node_credentials`、`node_enrollments`、`employee_settings`、`node_presence`、`node_revocations`、`node_runtime_reports` | 设备身份、凭据、默认设备、在线状态、吊销、能力报告（0002～0004、0015） |
| `threads` | 一个 Thread：员工、可选 Project、设备、Agent 类型、当前模型、工作目录、执行时限、状态与原因、创建者（员工或 Project Agent 及工具调用）、`client_thread_id`、`opened_at`、`archived_at`、版本 |
| `thread_messages` | 消息：Thread、`client_message_id`、发送方、方式、可选模型、正文（≤ 64 KiB）、状态（accepted / queued / sent / withdrawn / unknown）、所属 Turn |
| `thread_turns` | Turn：Thread、`worker_turn_seq`、发起方（员工或 Project Agent）、使用的模型、开始与结束时间、结束原因 |
| `thread_replies` | 回复：Thread、Turn、`worker_seq`、正文、截断标记与原字节数、附件 JSON、元数据（shell 的退出码） |
| `thread_events` | 只追加的审计事件：新建、消息接受、停止请求、归档、状态变化，附操作者与时间（R-23） |
| `thread_outbox` | 下行命令意图：`thread.open`、`thread.message`、`thread.withdraw`、`thread.stop`；下一次尝试时间、尝试次数、确认时间 |
| Project 相关表 | 见 Project Agent TECH 与 Agent Inbox TECH |

`threads` 以 `(employee_id, id)` 为复合唯一键，所有引用使用包含 `employee_id` 的复合外键。`client_thread_id` 在员工内唯一；Project Agent 创建的 Thread 另以 `(origin_conversation_id, origin_tool_call_id)` 唯一。

### 迁移

中心 Thread 模型使用增量迁移，与现有任务路径并存。`0001`～`0024` 保持原样；`0025_threads.sql` 新建 `threads`、`thread_messages`、`thread_turns`、`thread_replies`、`thread_events`、`thread_outbox` 和 `thread_reports`，并扩充 Project 输入类型。任务、Session 和 Execution 的表及接口在切换 Project Agent 之前继续使用；删除和收敛旧迁移在实施步骤 5 进行。

`thread_reports` 保存 `(thread_id, event_id)`、连续 Worker 序号、报告内容摘要及原 ACK，不保存完整报告正文。`thread_events` 只追加审计与时间线事件，回复事件保存限长正文。`threads.request_hash` 用于比较规范化的新建请求，读取接口不返回它。Turn 的 ID 与 Worker Turn 序号使用同一个含员工身份的复合外键，避免消息或回复关联到两个不同的 Turn。

`project_agent_input_queue` 同时接受原有的 `task_result`、`user_task_result` 和新的 `thread_reply`、`turn_ended`。`thread_reply` 为被动输入，`turn_ended` 为主动输入，参与放置、领取和重启后的通知重置。

迁移文件编号之间允许空缺，`internal/migrate` 按文件名排序执行。

### 下行投递

`thread_outbox` 沿用[控制面调度设计](../control-dispatch-reliability/TECH.md)的规则：短事务领取并保存下一次尝试时间，提交后入队，不等待回包；每节点额度在全局 LIMIT 前应用；回包按 `message_id` 独立幂等保存。设备离线时意图一直保留，没有排队期限（R-14）。

同一 Thread 的命令按 outbox `id` 顺序投递，前一条未确认时不发下一条，保证 `thread.open` 先于第一条消息、消息之间顺序不变。message 和 withdraw 还要等 `thread.opened` 保存存储代次，后续命令携带该代次。归档后只领取仍需发送的 stop、withdraw，过时的 open、message 保留原记录，不再阻塞清理命令。首次启动失败时，尚未尝试投递的消息撤回，Thread 保留停止原因并允许归档；员工另开 Thread 重试。

### 上行报告

Worker 的报告类型：

| 类型 | 中心处理 |
|---|---|
| `thread.opened` | `waiting_device` → `idle`，保存原生会话标识 |
| `thread.open_failed` | → `stopped`，保存原因（目录不存在、Agent 不可用等） |
| `message.queued` / `message.sent` / `message.withdrawn` / `message.unknown` | 更新消息状态与所属 Turn |
| `turn.started` | 插入 `thread_turns`，Thread → `running` |
| `reply` | 插入 `thread_replies` |
| `turn.ended` | 写结束时间与原因；Worker 队列为空时 Thread → `idle` |
| `thread.stopped` / `thread.unknown` | → `stopped` / `unknown`，附原因 |

每个报告带 `event_id` 和 Worker 序号。中心在一个事务里保存报告、更新状态，并在 Turn 属于 Project Agent 时写入它的输入队列（Project Agent TECH 第 9 节），提交后返回 ACK；Worker 收到 ACK 才确认本地 outbox。重复报告按 `event_id` 返回原 ACK。中心按 Worker 序号处理，序号跳跃时拒绝并要求补报，保证 `turn.ended` 不会早于这一轮的回复入库。

## 设备与 Worker 数据

### batond 账本（`node.db`）

| 表 | 内容 |
|---|---|
| `meta` | 存储代次 |
| `threads` | 中心 Thread ID 到本地 Session 目录的映射、Agent 类型、工作目录；`thread.open` 的接收记录 |
| `workers` | Worker 进程索引 |
| `project_runtime_runs` | Project Runtime 的启动去重与清理确认，见 Project Agent TECH |

`thread.open` 先写 `threads` 再回执，重复命令返回同一映射。`thread.opened` 带上存储代次，中心保存在 `threads` 上，之后的命令都携带它。设备重装或 `node.db` 丢失后代次改变，batond 拒绝旧代次的命令，Thread 进入 `stopped`，原因为本地历史缺失，不会用同一个 Thread ID 新开一个空会话。旧的 `receipts`、`sessions`、`agent_contexts` 删除。

### Worker 账本

每个 Thread 一份 SQLite，由对应 Worker 独占写入：

| 表 | 内容 |
|---|---|
| `meta` | Thread ID、Agent 类型、当前模型、适配器配置、原生会话标识、当前 Turn 序号与状态 |
| `messages` | `client_message_id`（唯一）、seq、方式、可选模型、正文、状态（queued / intent / sent / withdrawn / unknown）、所属 Turn |
| `turns` | Turn 序号、开始与结束时间、结束原因 |
| `replies` | 回复序号、Turn、正文、附件、元数据 |
| `outbox` | 待中心确认的报告 |

不变量：

1. 一条消息在 `intent` 之后不再自动发出第二次。
2. 同一时刻最多一个 Turn 处于开始而未结束的状态。
3. `turn.ended` 的 outbox 事件在这一轮所有 `reply` 事件之后写入。
4. 回复与对应 outbox 事件在同一事务提交；提交状态不明时从独立连接读回确认（沿用 `output_transaction.go`）。

完整原生历史由 Agent 保存在自己的文件里，Worker 账本不复制。

### 崩溃与恢复

| 位置 | 已知事实 | 恢复 |
|---|---|---|
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

`id` 是 `client_message_id`。`Send` 收到与当前不同的 `model` 时，先切换模型再开启这一轮，切换失败时不发出消息，返回原因；Worker 只在 Turn 开始前切换，Steer 不改变模型。`Sent` 判断消息是否已被 Agent 接收：Codex 把 `id` 作为 `clientUserMessageId` 写进原生历史并按它查找；Pi 和 Kiro 没有这个字段，Worker 在 `intent` 里记下发送前原生历史中 user 消息的数量，`Sent` 检查这个位置之后是否有正文相同的 user 消息。现有 `SubmitInput`、`DeliverResult`、`HistoryContains`、`Supplement` 合并进这组方法，`WaitingForChildren` 删除。

### 各 Agent

| Agent | Steer | 恢复 | 模型 | 备注 |
|---|---|---|---|---|
| Pi | 原生 `steer` RPC | `--session` 指向原 JSONL | 启动参数 `--model`；中途用 `set_model` RPC 切换 | `Abort` 先 `clear_queue` 再 `abort`；abort 要等当前工具结束才生效，工具超过 60 秒时由 Worker 结束进程树 |
| Codex | `turn/steer`，带 `expectedTurnId` | `thread/resume` | `thread/start` 和每次 `turn/start` 的 `model` | `approvalPolicy: never`，`sandbox: workspace-write` |
| Kiro | 不支持。执行中再发 prompt 会打断当前这一轮 | `session/load`，先核对 ID 存在 | 新建时用 `_meta.kiro.modelId`；中途切换未验证，上报为不支持 | 能力上报为不支持 steer；界面在执行中只提供排队 |
| shell | 不支持 | 不支持 | 不适用 | 只供 Project Agent 的命令执行使用，一个 Thread 只有一个 Turn，见 Project Agent TECH 第 10 节 |

Kiro 只提供排队。需要打断时，员工先停止这一轮再发消息。

各 Agent 的系统提示只说明运行环境（Baton Thread、工作目录、附件写法），不要求固定结果格式。现有 `instructions`、`codex.Instructions` 和 `ResultSchema` 中关于任务信封、JSON 结果、委托 CLI 的内容删除。

### 能力上报

batond 在 `node_runtime_reports.report.agents` 上报每种 Agent 的 `{agent_type, version, status, models:[{id, name}], default_model, capabilities:{create, queue, steer, stop, resume, switch_model}}`。模型列表来自 Agent 自己的接口：Codex 用 `model/list`，Pi 用 `get_available_models`，Kiro 取 `session/new` 返回的 `models`；取不到时 `models` 为空，只能使用默认模型。`status` 为 `available`、`unverified` 或 `unavailable`；只有 `available` 且支持 `create` 的 Agent 可新建 Thread。`queue` 和 `stop` 对已接入的 Agent 恒为真；`steer`、`resume`、`switch_model` 来自 `Capabilities()`。未验证的版本标为 `unverified`，界面不显示为已支持（D1）。旧设备未上报 `agents` 时，中心沿用 `nodes.capabilities` 验证 Agent 类型，插入能力缺省关闭。中心检查指定的模型在上报的 `models` 内，按目标系统的路径规则检查工作目录位于上报的 `roots` 内，设备在执行前核实目录存在及解析后的边界。

## 接口

### 浏览器 API

URL 相对 `/api/v1`。员工会话、CSRF、Origin 检查沿用现状。

| 接口 | 行为 |
|---|---|
| `POST /threads` | `client_thread_id`、可选 `node_id`（缺省为默认设备）、`agent_type`、可选 `model`（缺省为该 Agent 的 `default_model`）、`working_directory`、第一条消息 `message:{client_message_id, content}`。浏览器新建的 Thread 不属于 Project，执行时限取默认 2 小时。新建返回 201，幂等重发返回 200，内容冲突返回 409 |
| `GET /threads` | 可按 `project_id`、`node_id`、`status` 筛选，按 `(last_activity_at, id)` 倒序分页；`limit` 默认 50、最多 100，续页使用 `next_cursor` |
| `GET /threads/{id}` | Thread、状态、当前 Turn、待发消息 |
| `GET /threads/{id}/timeline` | 按审计事件 ID 顺序返回消息、Turn 边界、回复和操作；`limit` 默认 20、最多 100，续页使用 `next_cursor` |
| `POST /threads/{id}/messages` | `{client_message_id, content, mode, model?}`，返回 202；`mode` 缺省为 `queue`，`steer` 在 Agent 不支持时返回 422；`model` 不在上报列表内、Agent 不支持换模型或与 `steer` 同时出现时返回 422 |
| `POST /threads/{id}/messages/{mid}/withdraw` | 撤回排队消息；已发出返回 409 和当前状态 |
| `POST /threads/{id}/stop` | 返回 202，保存停止及撤回排队消息的意图，状态等待设备报告确认 |
| `POST /threads/{id}/archive` | 返回 202；有进行中的 Turn、待发消息或不确定状态时先发停止，设备确认后归档；空闲或已停止且无待发消息时直接归档 |
| `GET /threads/{id}/history` | 从设备分页读取原生历史，见「历史读取」 |
| `/events` | 浏览器 WebSocket，订阅 Thread 的实时输出与状态变化 |

节点、登录、默认设备、文件浏览、Project、Inbox 接口保持现状。旧 `/tasks*`、`/sessions*`、`/acceptances` 接口保留到任务模型删除；Thread 路径使用独立 Store 和协议。

浏览器 WebSocket 接受 `{thread_id, cursor?}` 订阅，发送 `thread.changed` 和 `thread.output`，保留原 Session 订阅格式。Thread 的历史与输出复用 `session.request`，其中 `session_id` 为 Thread ID；正文不持久化，历史响应为 `Cache-Control: no-store`。

错误对象为 `{code, message, request_id, details?}`；`details` 不回传凭据和完整工具输出。

### 节点消息

| 方向 | 类型 | 用途 |
|---|---|---|
| 下行 | `thread.command` | 携带 outbox 的一条命令：open / message / withdraw / stop |
| 上行 | `thread.command_result` | 命令已被 batond 或 Worker 持久化的回执 |
| 上行 | `thread.report` | Worker 报告（上表），中心持久化后回 `thread.report_result` |
| 双向 | `session.request` / `session.result` | 临时 RPC：实时输出、原生历史；正文不进中心持久化 |

Thread 命令以信封 `message_id` 作为稳定身份，`thread.command_result` 用信封 `correlation_id` 引用它，正文含 `{type, thread_id, ok, code?}`。报告正文含 `{type:"thread.report", thread_id, event_id, worker_seq, kind, ...}`，其中 `kind` 为「上行报告」表中的类型，`worker_turn_seq` 标识 Turn，`client_message_id` 标识消息。`turn.ended` 的 `queue_empty` 表示 Worker 是否还有排队消息。回执含 `{type:"thread.report_result", thread_id, event_id, worker_seq, ok, code?, expected_worker_seq?}`；序号不连续时返回 `worker_sequence_gap` 和下一条期望序号，不保存该报告。

Thread 回包事务按 Node → Credential → Presence 锁定认证记录，再锁目标 Outbox 或 Thread；全部锁取得后用数据库当前时刻复核凭据期限。凭据吊销、连接替换和锁等待跨越有效期都不能写入执行事实。

旧 `execution.*`、`agent.request`、`execution.children*` 和启动许可在任务路径继续使用，随实施步骤 5 删除。Thread 没有排队期限，消息由员工明确发出，设备收到即可执行。

### 跨版本字段

Coordinator、batond 和 Project Runtime 之间的消息只做增量变化：可以新增可选字段和消息类型，已有字段不删除、不改类型、不改含义（R-25）。接收方忽略未知字段，继续验证必填字段、身份、关联标识和容量。浏览器 API、模型工具参数和本地配置保持严格检查。

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

节点凭据为 Ed25519 签名 JWT，受众 `baton-node`，绑定节点、员工、credential_id 与有效期。吊销顺序：PostgreSQL 提交 → 本地认证与分派拒绝该凭据 → 关闭活动连接 → 保存已生效事实；只有完成后 API 才返回 effective（R-04）。

节点上线附带每次 batond 启动生成的 incarnation；已有不同 incarnation 活动时拒绝接管（R-02）。新连接完成 `node.sync` 后才标为可用（R-03）。

### 容量上限

| 配置 | 初始值 |
|---|---|
| 单条传输消息 | 256 KiB |
| 输出片段与历史页 | 16 KiB |
| 文本文件预览 | 64 KiB |
| 单连接控制队列 | 32 条且 1 MiB |
| 单节点输出待发送量、单订阅待发送量 | 各 256 KiB |
| 中心输出缓存总量 | 32 MiB |
| 心跳 / 离线判定 | 10 秒 / 30 秒 |
| 重连退避 | 1～30 秒带抖动 |

输出超限时丢弃并标出缺口，控制消息不丢（R-16）。Worker 持续读取 Agent 的 stdout 和 stderr，避免管道反压。

## 历史读取与实时输出

`GET /threads/{id}/history?cursor=&limit=16` 校验归属后经 `session.request` 读取设备上的原生历史，响应 `Cache-Control: no-store`，正文不进入 PostgreSQL 或日志。每页最多 16 条、14 KiB，单条最多 4 KiB，超出时保留截断标记和 `<agent>:<id>:<偏移>` 形式的本地引用。

Pi 读取原生 JSONL，Codex 读取 thread 文件并核对 thread ID、cwd 和 CLI 版本，Kiro 读取 ACP 会话记录；都用 `os.OpenRoot` 限制边界，只接受普通文件。游标绑定原生会话与前缀摘要，前缀被改写时返回 `history_changed`。离线返回 `node_offline`，文件缺失返回 `history_missing`，读取错误返回不可用，不推断为删除。单节点最多同时 2 次历史查询。历史读取不依赖 Worker 存活。

实时输出由 Worker 保留最近 256 KiB 纯文本，浏览器按游标补取；游标落在保留范围之外时返回缺口（R-16）。

## 文件浏览

设备本地定义可浏览的 `root_id` 和真实路径，浏览器只提交 `root_id` 和相对路径。实际打开时用 `os.Root` 验证边界，覆盖符号链接、junction 和 reparse point。附件预览复用这条路径（R-18）。Coordinator 不代取任意 URL，不提供文件存储。

## 账号与保留

本地员工账号由管理员创建，Argon2id 口令摘要，服务端登录会话；改密和重置注销既有会话。注册凭据 10 分钟单次使用，节点凭据 30 天（D2）。

中心记录默认长期保留，没有自动清理；回复正文已限长。设备本地历史由员工自己管理。设备账本与待补报数据设 1 GiB 预算，达到预警水位后拒绝新 Thread 和新消息，不删除未确认的报告（D4）。

## 敏感数据

设备密码、模型订阅凭据、节点私钥只存在设备上，文件权限为当前用户 `0600`（Windows 为受保护 DACL，只授权当前用户 SID）。节点凭据和注册凭据不进日志、URL 或命令行。中心不持久化实时输出和原生历史（R-22）。

## 部署

Coordinator 与 PostgreSQL 部署在一处，Coordinator 提供静态页面、API、浏览器 WebSocket 和节点 WSS。升级顺序为停止旧实例、迁移、启动新实例；batond 退避重连并同步。设备上 Windows 用当前员工的登录启动项，macOS 用 LaunchAgent，Linux 用 `systemd --user`，不以 root 或 LocalSystem 运行。

承载 Project Agent 的设备另外安装 Node.js 和 `baton-project-runtime`，见 Project Agent TECH 第 2.1 节。

## 代码改动

### 模块清单

| 模块 | 处理 |
|---|---|
| `internal/gateway`、`internal/auth`、`internal/admin`、`internal/identity`、`internal/redact`、`internal/privatefile`、`internal/sidecar`、`internal/delivery`、`internal/migrate`、`internal/db` | 保留 |
| `internal/node` 的身份、注册、连接、能力报告、文件浏览、Project Runtime | 保留 |
| `internal/node` 的 `prepare.go`、`start.go`、`execution.go`、`stop.go`、`agent.go`、`child_delivery.go`、`ledger.go` 的 receipts | 改为 `thread.command` 接收与报告转发 |
| `internal/session` 的 Worker 进程、IPC、历史读取、输出事务、进程守护 | 保留 |
| `internal/session` 的 `ledger.go`、`browser.go`、`reuse.go`、`stop.go` | 改为消息队列、Turn 与回复账本；`child_delivery.go`、`executor.go` 的任务脚本删除 |
| `internal/agent/{pi,codex,kiro,shell}` | 接口改为上节的 `Adapter`；删除任务信封、结果格式、子结果交付 |
| `internal/agent/replay` | 保留；转录随适配器更新重新录制 |
| `internal/store` 的节点、连接、吊销、Project、对话、记忆、放置、投递、压缩 | 保留 |
| `internal/store` 的 `task*.go`、`dispatch.go`、`start.go`、`result.go`、`stop.go`、`resolve.go`、`acceptance.go`、`artifact.go`、`child_delivery.go`、`agent.go`、`session.go` | 删除，新建 `thread.go`、`thread_report.go`、`thread_outbox.go` |
| `internal/store` 的 `project_tools.go`、`project_exec*.go`、`project_inputs.go`、`inbox.go` | 改为 Thread 工具与 Turn 输入，见 Project Agent TECH |
| `internal/control` 的 `prepare.go`、`start.go`、`result.go`、`agent.go`、`child_delivery.go`、`dispatch.go`、`session.go` | 合并为 `thread.go`：命令派发与报告处理 |
| `internal/task`、`internal/startpermit`、`internal/agentcli`、`internal/plane`、`cmd/baton` | 删除 |
| `internal/fileaccess` | 保留浏览；`CheckArtifacts` 改为附件解析 |
| `internal/httpapi` 的 `tasks.go`、`sessions.go`、`resolve.go`、`acceptance.go` | 删除，新建 `threads.go` |
| `internal/protocol` 的 `prepare.go`、`result.go`、`agent.go`、`delivery.go` | 删除，新建 `thread.go` |
| `web/src` 的任务页、Session 页、`TaskComposer`、`TaskActions`、`TaskReferences`、`AttentionCard` 的任务快照 | 删除或改为 Thread 页面，按 `design/` 实现 |

### 实施步骤

每一步结束时 `go vet ./...`、`go test ./...` 和前端测试通过。

1. **删除不再需要的入口。** 删除 `internal/plane`、`internal/agentcli`、`cmd/baton`、迁移 0013 与 0019 及对应测试和配置。行为不变的部分照常运行。
2. **中心 Thread 模型。** 新增迁移，新建 `threads`、`thread_messages`、`thread_turns`、`thread_replies`、`thread_events`、`thread_outbox` 和报告去重账本及 Store；浏览器 Thread API；`thread.command` 派发与 `thread.report` 处理。用 Go 测试里的假节点验证新建、消息去重、离线等待、报告去重和序号检查。旧任务路径与新路径并存到第 4 步。
3. **Worker 与适配器。** Worker 账本改为消息队列、Turn 与回复；适配器改为新接口，Pi、Codex、Kiro、shell 逐个迁移，回放测试覆盖排队、插入、停止、执行时限、崩溃恢复和 `Sent` 查询。batond 接收 `thread.command`。
4. **切换 Project Agent。** `tasks.*` 工具换成 `threads.*`，Turn 结束与回复进入输入队列，`nodes.exec` 改为 shell Thread；Inbox 关联 Thread。见 Project Agent TECH 第 9、10 节。
5. **删除任务模型。** 删除 `tasks` 相关表、Store、协议、`internal/task`、`internal/startpermit`、启动许可和子任务交付代码，收敛旧迁移。
6. **Web。** Thread 列表与 Thread 页、Project 页的 Thread 区域按 `design/` 实现；删除任务页与 Session 页。
7. **端到端。** 真实 Codex、Kiro、Pi 各跑一遍 PRODUCT 验收表的多轮、排队可靠性和恢复场景。

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
| R-25 | 上一版 batond 连接新中心，中心消息带未知字段 | Thread 新建、消息、停止、回复失败 | 兼容测试 |

真实 Agent 的验收只能在对应系统上进行；交叉编译不代替 Windows、Linux 原生验证。

## 待定

| 编号 | 事项 | 阻塞范围 |
|---|---|---|
| Q3 | 各 Agent 在三类系统上的实际能力（D1） | 支持矩阵 |
| Q5 | 压测阈值（D6） | 容量达标声明 |
