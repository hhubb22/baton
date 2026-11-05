# Baton 技术设计

Status: draft
Basis: [行为规格](PRODUCT.md) R-01～R-25。Project Agent 见 [Project Agent TECH](../project-agent/TECH.md)，设备接入与本地控制通道见 [设备接入 TECH](../device-setup/TECH.md)，打包、格式基线与备份恢复见 [发布 TECH](../release/TECH.md)。

## 全景

```text
浏览器 / 桌面窗口 ── HTTPS / WebSocket ── Coordinator ── PostgreSQL
                                             │  （API、业务处理器、进程内 Gateway）
                                         出站 WSS（系统信任 TLS）
                                             │
CLI / 桌面主进程 ── 本地控制 IPC ──►       batond（单一守护进程，独占 node.db）
                                             ├─ Thread 状态机（进程内按 Thread 串行 Fiber）
                                             │    └─ agent-host 子进程（按需启动，空闲 10 分钟休眠）
                                             │         └─ Cursor / Pi / Codex / Kiro / Antigravity / Droid
                                             ├─ Execution 执行器（进程内状态机 + 受管命令子进程）
                                             └─ baton-project-runtime（Project Agent，stdio）
```

每台设备在同一数据目录下只运行一个后台 `batond` 守护进程，对外暴露受令牌认证的本地控制通道（CLI 与桌面客户端均为其客户端并支持按需后台拉起）。一个 Thread 在设备上对应 `batond` 进程内的一个串行 Thread 状态机 fiber、按需启动的 `agent-host` 宿主子进程以及一个原生 Agent 会话；`batond` 通过单一 `node.db` 拥有本机所有 Thread 的消息队列、Turn 边界与上行报告 outbox，Coordinator 拥有 Thread 记录、消息意图和中心保存的回复。中心不主动连接设备，所有下行命令经设备主动建立的 WSS 连接送达。

Project Agent 的 `nodes.exec` 创建独立 Execution，绑定员工、Project、设备及来源工具调用。中心持久保存命令、目录、时限、状态、输出摘要、退出码和完整输出引用；`batond` 在进程内使用 Execution 状态机与 `node.db` 执行受管命令子进程，不创建 Thread、Turn 或 Agent 会话，也不额外派生中间 Worker 进程。详情、停止与完整输出通过 Execution 接口读取。

Execution 以来源对话和工具调用身份去重，参数变化时拒绝重用。中心在同一事务保存记录和 start 下行意图，节点持久化命令与启动 `intent` 后运行受管命令子进程，逐序保存报告并等待中心确认。状态为 `pending`、`running`、`completed`、`failed`、`cancelled`、`timed_out` 或 `unknown`。停止请求先持久化，终态由节点回收进程树后报告；`batond` 重启恢复时回收残留进程并核对完成证据，结果无法确认时报告 `unknown`，不重执行命令。输出摘要、原始输出字节数、编码与完整输出引用随终态保存。

目录职责与实现入口见根目录 [AGENTS.md](../../AGENTS.md#核心架构与目录)。

`agent-host`、`project-runtime` 与 `watchdog` 均由 `batond` 使用同一可执行文件的内部子命令按需启动。POSIX 下 `agent-host` 与受管命令使用独立进程组并登记到 `watchdog`，当 `batond` 异常崩溃使管道关闭时自动连带回收；Windows 下在 `node.db` 持久保存 PID 与创建时间，使用 `taskkill /T /F` 回收。

中心按单个活动 Coordinator 设计，所有业务变更通过数据库事务和版本检查。

### 技术选择

| 位置 | 技术与约束 |
|---|---|
| Coordinator、batond | TypeScript 6.0、Node 26、Effect 4.0.6；版本由 pnpm catalog 锁定 |
| 服务与生命周期 | Effect Context.Service、Layer、Scope；后台任务与按 Thread 隔离的状态机以 fiber 管理 |
| HTTP、RPC 与本地控制 | `effect/http-api` 共享 HTTP 契约，`effect/http` 提供底层服务；`batond` 与 `agent-host` 使用 stdio `effect/rpc`；本地控制通道使用带令牌认证的 UDS / Named Pipe JSON 行协议 |
| 子进程 | 节点宿主通过 Node `child_process` 启动，提供 Effect 生命周期与进程树回收包装；provider 使用宿主提供的 Node Effect spawner |
| Project Runtime | Node.js、`@earendil-works/pi-agent-core` 与 `pi-ai`；stdio 连接节点宿主 |
| 中心存储 | PostgreSQL 16+、`@effect/sql-pg`、参数化 SQL、版本化 SQL 迁移 |
| 设备账本 | `node:sqlite`、WAL、FULL 同步；`@baton/sqlite` 提供串行事务与独立提交核查 |
| 诊断与运行记录 | 进程结构化 JSON 日志、数据库实时诊断 API，以及设备私有目录实时追加的无损 Agent 运行记录（`transcript.jsonl`，覆盖 6 种执行 Agent 与 Project Agent 前后台运行），详见 [诊断与运行记录 TECH](../observability/TECH.md) |
| Web | React、TypeScript、StyleX、Vite，从中心 bundle 旁的 `web/` 提供静态文件 |
| 设备与中心通信 | `ws`、系统根证书信任的 TLS WebSocket、版本化 JSON 信封 |
| 构建与检查 | esbuild 生成 Node bundle，`batond` 使用 SEA；Vite+ 提供 Vitest、Oxlint、Oxfmt 与 TypeScript Go 检查，各包保留编译器检查 |

Agent 的结构化接口由 t3code fork 的完整 provider adapter 实现，在 `agent-host` 子进程中隔离运行。Cursor provider 使用原生 SDK，其余执行 Agent 使用 CLI 的结构化接口。fork 以 submodule 固定提交，来源见 [t3code 说明](../../third_party/t3code/README.md)；安装包布局与平台测量见 [发布设计](../release/TECH.md)。

### 实现原则

每个活动 Thread 状态机使用串行队列提交 `node.db` 短事务，慢 I/O 与 `agent-host` RPC 在独立 fiber 中执行，结果携带控制代次（`epoch`）返回状态队列。取消响应、回合终态和进程树回收分别核实；`intent` 必须先于原生提交持久化。领域状态和确定性解析使用普通 TypeScript 数据结构与函数，Web 使用 React。

中心与节点保留员工隔离、事务原子性、命令幂等、租约 fencing 和恢复证据。源码开发入口、bundle 与安装包共用业务实现。内部开发阶段统一当前 schema 基线，结构调整后可重建本地实验数据；正式发布后的升级使用版本化迁移。自动化验证使用离线转录与本地替身，入口见 [AGENTS.md](../../AGENTS.md#常用构建与验证命令)。

### 数据库访问

中心统一通过 Effect SqlClient 与 PgClient 执行 SQL，共享事务、连接、取消和追踪上下文。状态机、持久命令和锁查询使用显式 SQL；迁移以根目录 SQL 文件为唯一来源。`sql<T>` 只声明静态结果类型，关键返回值需用 Effect Schema 或 `effect/sql/SqlSchema` 校验。

SQLite 在外层提交前写随机 token。COMMIT 报错且事务已结束时，从独立只读连接核对持久 token；匹配则返回原结果，核验失败返回不可重试的 `CommitUnknown` 并阻止后续查询，状态机冻结后关闭重开账本核对持久事实。

### 平台相关实现

| 能力 | POSIX | Windows 第一版 |
|---|---|---|
| 进程回收 | 独立进程组与 `watchdog`；`agent-host` 独立组登记见 [适配设计](../agent-adapters/TECH.md#进程组与停止回收) | 持久 PID、创建时间与 `taskkill /T /F`；中间父进程先退出、`batond` 强杀后延迟回收及身份核验到终止之间的竞争仍有限制 |
| 私有文件 | 目录 `0700`、文件 `0600`，权限不符时改回；检查属主、类型及打开前后的身份 | 沿用数据目录继承的 ACL（默认位于用户目录下），只检查类型、链接与打开前后的身份；未提供逐句柄 DACL 与 reparse point 校验 |
| 本地控制 IPC | 私有目录下的 UDS 与 `control.token` 认证 | Node 默认安全描述符的命名管道与 `control.token` 认证，令牌保存在私有数据目录 |

平台能力集中在 `apps/batond/src/platform`。Project 租约与 Turn 执行时限取 `max(hrtime 经过值, Date.now 经过值)`，计入睡眠并防止时钟回拨延长预算；停止等待预算使用 `hrtime`。Windows Job Object、逐句柄 DACL 与管道权限收紧列入 [第一版之后](../release/TECH.md#53-windows-平台边界与第一版之后事项)。

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

除 `archived` 外，状态只由设备报告驱动。中心不根据自身重启、超时或连接断开改写状态，界面另外显示设备连接状态和最后报告时间（R-10）。`stopped` 和 `unknown` 的 Thread 仍可以接收新消息：Thread 状态机先尝试恢复原会话（R-12），无法恢复时以原因拒绝。HTTP 的 `stop_code` 区分 `user_stopped`、`forced_stop`、`interrupted`、`history_lost`、`folder_missing` 和 `start_failed`，网页按代码选择停止与恢复提示；`status_reason` 只用于展示说明，恢复或重新打开后清除代码。

### 消息的生命周期

每条消息有客户端生成的 `client_message_id`、发送方（员工或 Project Agent）和方式（`queue` / `steer`）。

```text
中心 accepted ──投递──▶ 节点 queued ──▶ intent ──▶ sent ──▶ 属于某个 Turn
                               │
                               └─ withdrawn（撤回或停止时尚未进入 intent）
```

1. 中心在一个事务里保存 `thread_messages`（状态 `accepted`）和下行投递意图，返回 202。相同 `client_message_id` 与相同正文返回原记录，不同正文返回 409（R-08）。
2. 派发循环把消息送到设备。`batond` 在 `node.db` 的同一事务里持久化命令接收回执与 `thread_messages`（`client_message_id` 唯一）并生成 `message.queued` 报告；中心收到回执把消息标为 `queued`。重复投递命中唯一键，直接返回已保存回执。
3. Thread 状态机按方式处理：
   - `queue`：Thread 空闲时立即作为新 Turn 的第一条消息发出（若 `agent-host` 已空闲休眠则先透明恢复原会话）；Thread 执行中时留在队列，Turn 结束后按 `seq` 顺序逐条发出，每条开启一个新 Turn。
   - `steer`：Agent 执行中时调用适配器的 `Steer`；Agent 已空闲时按 `queue` 处理。
4. 发送前状态机先在 `node.db` 提交 `intent` 与输入准备证据，再经 `agent-host` 调用适配器；适配器确认后记为 `sent`，并把消息归入当前 Turn。`intent` 已提交但确认丢失时，用持久输入准备证据只读核对原生快照中已确认发送数之后的下一条 user 正文及会话身份；证据不足时，消息和 Thread 都进入 `unknown`，不重发（R-13）。
5. 撤回只对队列里尚未提交 `intent` 的消息生效；中心记录撤回请求，设备回执后标为 `withdrawn`。停止一轮时，状态机在同一事务里撤回全部尚未进入 `intent` 的排队消息（R-11）。

接收消息时同时检查 64 KiB 正文上限和 JSON 编码后的 256 KiB 传输上限，并为存储代次、来源和外层帧预留容量。正文因控制字符转义而超过传输上限时返回 413，不写入消息或 outbox。

消息队列由 `batond` 对所有 Agent 统一实现，不使用原生 Agent 自带的 follow-up 队列，保证排队、撤回与崩溃恢复语义一致。

### Turn 边界与空闲休眠（R-09、R-12）

Turn 从一条 `queue` 消息被 Agent 接受开始，到 `agent-host` 驱动报告 `end`（对应上游 `ProviderAdapterV2` 的回合终态信号）为止；各 Agent 的原生信号与回复提取映射见 [Agent 适配设计](../agent-adapters/TECH.md)。结束原因写入 `turn.ended`：`completed`（Agent 停下等待输入）、`stopped`（员工或 Project Agent 停止）、`timeout`（到达执行时限）、`agent_exited`（进程退出或重启回收）、`failed`（Agent 报告回合错误）。原因只用于展示和给 Project Agent 阅读，Baton 不据此判断任务成败（R-09）。

执行时限从 Turn 开始算起，默认 7200 秒，`ExecutionTimeoutSeconds` 接受 1～2,147,483,647 秒的整数。状态机取单调时钟与墙上时钟的已用时最大值；`thread_settings` 命令将新配置与完成回执写入同一事务，修改后从原 Turn 开始时间重算剩余预算，到期按停止流程结束并记原因为 `timeout`。

**`agent-host` 空闲休眠与按需唤醒（R-12）**：
- 默认空闲休眠时限 `IDLE_HOST_TIMEOUT_MS = 10 * 60 * 1000`（10 分钟）。
- 当 Turn 结束使 Thread 进入 `idle`、无待发 `queued` 消息且无挂起问题时，状态机启动绑定当前控制 `epoch` 的 10 分钟空闲计时 fiber。
- 计时期间若收到新消息、显式 `resume`、`stop` 或 `archive`，立即取消计时器并直接复用当前存活的 `agent-host`（热路径零冷启动开销）。
- 满 10 分钟仍无活动时，状态机在 Thread 串行队列里登记一个 `cleanup` 操作，调用 `agent.close()` + `agent.reap()` 回收该 `agent-host` 子进程树、清理 `node_processes` 登记并释放内存中的 `ThreadAgent` 实例，**不发出 `thread.stopped` 报告**，本地与中心的 Thread 状态继续保持 `idle`。回收期间到达的消息保持 `queued`，回收完成后走下面的透明恢复。`reap` 失败或无法确认进程树已停止时，Thread 进入 `unknown`，按不确定状态流程再次回收并上报 `thread.unknown`。
- 当处于 `idle` 且当前无存活 `agent-host` 的 Thread 收到下一条消息时，状态机先按持久保存的 `NativeMapping` 与最近确认模型透明启动 `agent-host` 执行 `resume`，成功后再执行 `prepareInput` 与 `send`；恢复失败时将消息撤回并报告 `thread.stopped`：宿主会话已打开、provider 的 `resumeThread` 失败时，`AgentHostError.historyUnavailable` 为真，`stop_code` 为 `history_lost`；进程启动、认证、`openSession` 或超时等其余失败为 `start_failed`。上游 `ProviderAdapterResumeThreadError` 不区分失败原因，`history_lost` 因此也包括 `resumeThread` 期间的连接中断或进程退出。设置 `resumeOnOpen` 的 Droid、Kiro 和 Antigravity 在 `openSession` 时载入历史，历史缺失同样报 `start_failed`。

### 停止（R-11）

员工停止、Project Agent 停止和执行时限到期走同一流程：

1. Thread 状态机在一个 `node.db` 事务里撤回尚未提交 `intent` 的排队消息，保存停止请求、推进控制 `epoch`、记录开始时间并关闭待回答问题。
2. 在独立停止 fiber 中调用适配器的 `abort`，中断原有启动、准备或发送任务，在默认 60 秒总预算内等待回合终止或回收证据。
3. 无论是否收到回合结束事件，都继续 `reap` 当前 `agent-host` 实例并核实 `node_processes` 登记记录均已回收。已提交但尚未确认的 `intent` 使用新的只读 `agent-host` 实例核对原生证据，旧实例不再复用。
4. 回收和输入结果均可确认时，结束活动 Turn（原因为 `stopped` 或 `timeout`），写入 `thread.stopped` 和 `stop` 命令成功结果，Thread 进入 `stopped`。下一条新消息或显式恢复请求可恢复原会话。
5. 进程回收未确认、`intent` 无法核实或已有未知结果时，Thread 保持 `unknown`，`stop` 命令结果也为 `unknown`。停止不回滚已有外部副作用。

60 秒等待期间 Thread 保持 `running`，界面显示停止请求已发送。中心的 Thread 记录用 `stop_requested_at`、`stop_confirmed_at` 与 `stop_failure` 表示停止请求、设备确认及失败原因，确保每个已开始的 Turn 最终都会产生一次 `turn.ended`（Project Agent PA-19）。

### 回复与附件

适配器每产生一条回复，Thread 状态机在一个 `node.db` 事务里保存回复元数据、附件引用和 `thread_outbox` 事件，随后经 WSS 上报。中心按 `(thread_id, worker_seq)` 去重保存到 `thread_replies`。正文超过 32 KiB 时，节点保留开头和结尾各 16 KiB，将全文写入 `full-output/` 并记录原字节数（R-09）。

附件引用由 `fileaccess` 解析回复中位于登记目录内的路径（`{node_id, root_id, path, access_status}`）以及 `commit <SHA>`（`{repo, sha}`，`repo` 取工作目录所在仓库 origin）；无法解析的文本保持为普通正文，中心只存引用不复制文件内容（R-18）。

### 过程记录

过程记录（R-09）来自 t3code 的 `OrchestrationV2TurnItem`。`agent-host` 的 driver 订阅 `turn_item.updated`，只处理当前 run 的项：

| 环节 | 规则 |
|---|---|
| host 上报 | 某项第一次进入终态（completed、failed、cancelled、interrupted）时发出 `item` 事件，后续重复更新忽略。driver 保留本轮未终态项的最新版本，回合终止或停止时在 `end` 之前按 `ordinal` 补发。`assistant_message`、`user_message` 已由回复和消息保存，不作为过程项；提问与审批进入终态时同时作为过程项上报。`item` 属于控制事件，不丢弃 |
| 节点截断 | 整个 `JSON.stringify(item)` 最多 192 KiB，`original_bytes` 记录裁剪前 `data` 的字节数。超限时先保存原始 `data` JSON 到 `full-output/`，再按最长字符串首尾裁剪（最多 256 次，仍超限则 `data` 置 `null` 并标 `metadata.item_structure_omitted:true`），记录 `truncated` 与完整输出引用 |
| 节点账本 | 截断结果与 `thread_outbox` 的 `turn.item` 事件在同一 `node.db` 事务提交，且严格排在同一轮 `turn.ended` 之前。退役 `agent-host` 前先等待控制事件流末尾排空确认，避免已产生过程项随进程回收丢失 |
| token 用量 | driver 记录本轮最后一次 `provider_turn.updated` 的 `tokenUsage`，随 `end` 事件交给状态机，再由 `turn.ended` 的 `token_usage` 原样上报中心 |

`turn.item` 报告携带 `worker_turn_seq` 和 `item:{id, type, status, ordinal, parent_id?, title?, started_at?, completed_at?, data}`。中心以 `(employee_id, thread_id, worker_turn_seq, item_id)` 为主键写入 `thread_turn_items`（`data` 与 `token_usage` 使用 PostgreSQL `json` 原样存储）。

浏览器 trace 接口和 Project Agent 的 `threads.trace` 读取同一份数据：按 `(ordinal, worker_seq)` 排序，每页最多 50 项、1 MiB。首次请求以 Thread 当前已提交的 `last_worker_seq` 固定快照上限，`page_cursor` 绑定员工、Thread、Turn、该上限和本页起点，`next_cursor` 用于续读下一页；被截断步骤的全文经 `full_output` 路径从设备读取。

## 中心数据

### 表

| 表 | 内容 |
|---|---|
| `employees`、`login_sessions` | 员工与登录会话 |
| `nodes`、`node_credentials`、`device_login_sessions`、`employee_settings`、`node_presence`、`node_revocations`、`node_runtime_reports` | 设备身份、长效凭据、设备码登录会话、默认设备、在线状态、吊销、能力报告 |
| `threads` | 一个 Thread：员工、可选 Project、设备、Agent 类型、当前模型与后续消息默认模型 `next_model`、`runtime_mode`、工作目录、执行时限、状态、说明与停止代码 `stop_code`、创建者（员工或 Project Agent 及工具调用）、`client_thread_id`、`opened_at`、`archived_at`、版本 |
| `thread_messages` | 消息：Thread、`client_message_id`、发送方、方式、可选模型与思考强度、正文（≤ 64 KiB）、状态（accepted / queued / sent / withdrawn / unknown）、状态原因 `status_reason`（≤ 4 KiB）、所属 Turn |
| `thread_turns` | Turn：Thread、`worker_turn_seq`、发起方（员工或 Project Agent）、使用的模型、开始与结束时间、结束原因、上游原样的 `token_usage` JSON |
| `thread_replies` | 回复：Thread、Turn、`worker_seq`、正文、截断标记与原字节数、附件 JSON 和元数据 |
| `thread_turn_items` | 过程项：Thread、Turn、`item_id`、`worker_seq`、`ordinal`、父项、类型、状态、标题、开始与结束时间、`data` JSON（编码后 ≤ 192 KiB）、截断标记与原字节数、完整输出引用 |
| `thread_events` | 只追加的审计事件：新建、消息接受、停止请求、归档、状态变化，附操作者与时间（R-23） |
| `thread_outbox` | open、message、withdraw、stop、resume、settings、answer 的下行命令意图；下一次尝试时间、尝试次数、接收确认与完成结果 |
| Project 相关表 | 见 Project Agent TECH |

`threads` 以 `(employee_id, id)` 为复合唯一键，所有引用使用包含 `employee_id` 的复合外键。`client_thread_id` 在员工内唯一；Project Agent 创建的 Thread 另以 `(origin_conversation_id, origin_tool_call_id)` 唯一。

### 迁移

中心迁移从 `migrations/0001_initial.sql` 的当前 schema 基线创建员工、设备、Thread、Project、主对话和记忆表。内部开发阶段允许按当前基线重建实验数据；正式发布后冻结已发布迁移，通过新增版本迁移演进。迁移校验、SQLite 格式版本与失败恢复按 [发布升级设计](../release/TECH.md#32-存储格式与事务核验)实施。

`thread_reports` 保存 `(thread_id, event_id)`、连续序号 `worker_seq`、报告内容摘要及原 ACK，用于检测相同事件身份下的内容冲突。`thread_events` 只追加审计与时间线事件，回复事件保存限长正文。`threads.request_hash` 用于比较规范化的新建请求，读取接口不返回它。Turn 的 ID 与 `worker_turn_seq` 使用同一个含员工身份的复合外键。

`project_agent_input_queue` 的 Thread 输入为 `thread_reply`（被动输入）、`turn_ended` 与 `thread_message_failed`（主动输入，参与放置、领取和重启后的通知重置）；其他输入类型见 Project Agent TECH。

迁移文件编号之间允许空缺，`apps/server/src/database.ts` 在事务 advisory lock 内按文件名排序执行，记录并核对 `schema_migrations`。

### 下行投递

`thread_outbox` 沿用[控制面调度设计](../control-dispatch-reliability/TECH.md)的规则：短事务领取并保存下一次尝试时间，提交后入队，不等待回包；每节点额度在全局 LIMIT 前应用；回包按 `message_id` 独立幂等保存。设备离线时意图一直保留，没有排队期限（R-14）。

同一 Thread 的命令按 outbox `id` 顺序投递，前一条未确认时不发下一条，保证 `thread.open` 先于第一条消息、消息之间顺序不变。message 和 withdraw 还要等 `thread.opened` 保存存储代次，后续命令携带该代次。归档后只领取仍需发送的 stop、withdraw，过时的 open、message 保留原记录，不再阻塞清理命令。首次启动失败时，尚未尝试投递的消息撤回，对应未投递命令结束为 cancelled，Thread 保留停止原因并允许归档。没有存储代次、节点报告或 Turn，全部 open 均以无存储代次的 `agent_unavailable`、`invalid_working_directory` 或 `working_directory_forbidden` 拒绝，且所有消息均撤回、投递次数为 0、没有接收回执时，允许原 Thread 显式重试打开；已接收 open 或原生创建结果不明时禁止重建。

### 上行报告

节点上行报告类型：

| 类型 | 中心处理 |
|---|---|
| `thread.opened` | `waiting_device` → `idle`，保存原生会话标识与存储代次 |
| `thread.open_failed` | → `stopped`，保存原因（目录不存在、Agent 不可用等） |
| `thread.resumed` | 确认原会话恢复且没有活动 Turn，Thread → `idle` |
| `message.queued` / `message.sent` / `message.withdrawn` / `message.unknown` | 更新消息状态、状态原因与所属 Turn；模型选择失败的撤回不关联 Turn，Thread → `idle` |
| `turn.started` | 插入 `thread_turns`，Thread → `running` |
| `reply` | 插入 `thread_replies` |
| `turn.item` | 插入 `thread_turn_items`，主键冲突时保留原记录 |
| `turn.ended` | 写结束时间、原因与 `token_usage`；待发队列为空时 Thread → `idle` |
| `thread.stopped` / `thread.unknown` | → `stopped` / `unknown`，附原因 |
| `command.completed` | 按命令身份与存储代次保存执行结果，与接收 ACK 分开 |
| `question.pending` / `question.resolved` | 保存问题或关闭对应请求，关联本轮输入与执行身份 |

每个报告带 `event_id` 和连续序号 `worker_seq`。中心在一个事务里保存报告、更新状态并写入 Project Agent 输入队列，提交后返回 ACK；`batond` 收到 ACK 后更新 `node.db` 中 `thread_outbox.acked = 1`。重复报告按 `event_id` 返回原 ACK；序号跳跃时返回 `worker_sequence_gap` 要求按序补报，保证 `turn.ended` 不会早于同轮回复和过程项入库。

若节点本地记录缺失或损坏导致已进入 `open_attempted` 的 Thread 丢失会话状态，`batond` 先补送 `node.db` 中尚未确认的既有报告，再发送带 `history_unavailable:true` 的 `thread.unknown` 恢复报告；中心在同一事务内结束活动 Turn（`agent_exited`）、收敛未完成输入与命令，不自动新建空会话。

## 设备数据（`node.db`）

### 单一节点账本结构

`batond` 独占写入单一 SQLite 数据库 `<data-dir>/node.db`（WAL、`synchronous=FULL`），集中承载节点命令、所有 Thread 状态机、Execution 状态与所属进程登记，不再按 Thread / Execution 拆分独立 `.db` 文件或跨进程双写 outbox：

| 表 | 内容 |
|---|---|
| `node_commit` | `@baton/sqlite` 外层事务的随机提交核验 token |
| `threads` | `thread_id`、`storage_generation`、`startup_phase`（`awaiting_open` \| `open_attempted`）、`config_json`（工作目录、Agent、模型、`runtime_mode`、时限）与 `meta_json`（阶段、原生会话标识、控制 `epoch`、Turn 序号、活动输入、停止与恢复状态） |
| `thread_commands` | `command_id`、`thread_id`、`hash`、持久接收回执 `receipt_json` 与终态执行结果 `status_json` |
| `thread_messages` | `(thread_id, message_id)`、`seq`、方式、模型与思考选项、正文、`InputPreparation` 证据、状态（`queued` \| `intent` \| `sent` \| `withdrawn` \| `unknown`）、`status_reason`、所属 Turn 与执行身份 |
| `thread_outbox` | `(thread_id, seq)`、唯一 `event_id`、内容摘要、报告 JSON、中心确认 `acked`、本地消费确认 `worker_acked` 及 `replyEvidence`；状态变迁与上行报告在同一事务原子写入，WSS 直接读取未确认行投递 |
| `executions` | `execution_id`、命令配置、启动 `intent`、停止标记与待确认 `ExecutionReport` 列表 |
| `node_processes` | `(owner_kind, owner_id, pid, creation_time, role)`，持久登记 `agent-host`、`execution` 与 `probe` 所属子进程身份，确认回收后按完整身份删除 |

Project Runtime 继续使用独立的 `project-runtime.db`（`project_runtime_runs`、`project_processes`、`project_commit`），由 `ProjectRuntimeManager` 维护。

核心账本不变量：
1. 一条消息进入 `intent` 后绝不自动发出第二次。
2. 同一 Thread 同一时刻最多一个 Turn 处于已开始而未结束的状态。
3. 同一轮的所有 `reply` 与 `turn.item` 事件序号严格排在该轮 `turn.ended` 之前。
4. 状态变迁、回复元数据与对应 `thread_outbox` 事件在同一 `node.db` 事务内原子提交。

`Send` 在提交前明确返回模型不可用时，消息确定未发出，状态机将其标为 `withdrawn` 并保存最多 4 KiB 的 `status_reason` 上报 `message.withdrawn`，保留当前 `agent-host` 与模型继续处理后续排队消息；Project Agent 发起的此类失败消息另生成 `thread_message_failed` 输入。对超长或含无效字符的回复 ID，状态机稳定映射为 `baton:reply:sha256:…` 并在 `replyEvidence` 中保留原始证据，正文中的 NUL 与孤立代理项替换为 `U+FFFD`。

### 按需加载与崩溃恢复（R-12、R-13、R-20）

`batond` 启动时不拉起历史 `idle`、`stopped`、`unknown` 或 `archived` Thread 的 `agent-host` 子进程：
- 仅存在未确认 `thread_outbox` / `executions` 报告的记录，在中心连接同步后直接经 WSS 补送，无需启动 `agent-host`。
- 仅对存在残留 `node_processes`、未结束活动 Turn、未决 `intent`、待发 `queued` 消息或未完成 `open` 的 Thread（以及未结束的 Execution），才在启动时实例化状态机执行恢复协调。

| 故障或重启位置 | 持久已知事实 | 恢复裁决 |
|---|---|---|
| `open` 尚未进入原生创建前中断 | `startup_phase = awaiting_open`，无原生映射与输入意图 | 允许用原 `open` 命令 ID、配置与 `storage_generation` 重试打开 |
| `open` 已尝试创建但未完成持久映射时中断 | `startup_phase = open_attempted` 且 `open` 命令仍为 `running` | 报告 `thread.open_failed` 并标 `unknown`，禁止自动新建替代会话 |
| 消息处于 `queued`，尚未提交 `intent` | 确定从未向原生 Agent 发送 | 保留在队列中，待会话恢复后按 `seq` 顺序逐条发送 |
| `intent` 已提交，原生接受证据缺失 | 可能已被原生 Agent 接收 | 启动只读 `agent-host` 调用 `sent` 核对原生快照；匹配则记 `sent`，无法确认则消息与 Thread 均标为 `unknown`，绝不自动重发 |
| Turn 执行中 `agent-host` 崩溃或 `batond` 重启 | `node_processes` 有登记且活动输入为 `sent` 未结束 | 先回收残留子进程树：确认回收且无未决 `intent` 时，为活动 Turn 补 `turn.ended(agent_exited)` 并将 Thread 标为 `stopped(interrupted)`；若有待发 `queued` 消息或员工显式恢复/发新消息，按 R-12 重新启动 `agent-host` 恢复原会话继续处理；无法确认进程树回收时保持 `unknown` |
| 上行报告已写入 `thread_outbox`，中心 ACK 丢失 | 报告具有固定 `event_id` 与 `seq` | 重连后按序重发，中心按 `event_id` 幂等去重 |

## Agent 适配

### 接口

进程内 Thread 状态机通过 `apps/batond/src/worker/agent.ts` 的 `ThreadAgent` 接口驱动每次按需创建的 `agent-host` 实例：

| 方法 / 流 | 职责 |
|---|---|
| `open`、`resume` | 新建或恢复原生会话，返回前持久保存 `NativeMapping` |
| `prepareInput`、`restoreInput` | 保存或恢复输入基线（原生会话标识、准备标识和已确认发送数） |
| `send` | 提交 `queue` 或 `steer` 输入，返回原生接受证据 |
| `sent` | 只读核对原生快照，不发送输入或开启新执行 |
| `answer` | 将问题或权限审批回答绑定到活动请求 |
| `events`、`output` | 持久回复、过程项、回合终态（含 token 用量）、问题/审批与不确定事件；独立的有界实时输出 |
| `abort`、`close`、`reap` | 取消、关闭和进程树回收，取消响应本身不替代回收确认 |

输入的 `id` 为 `client_message_id`。`batond` 与 `agent-host` 通过 fork 的 `ProviderAdapterV2` 适配六个 Agent，完整协议细节见 [Agent 适配设计](../agent-adapters/TECH.md)。支持会话内换模型的 Agent 在 `intent` 中保存本轮模型选择，恢复时从账本取最近确认提交的 `queue` 模型；`steer` 沿用当前活动回合的模型与思考强度。

### 各 Agent 能力概览

| Agent | Steer | 恢复 | 会话内换模型 | 接入方式 |
|---|---|---|---|---|
| Pi | 原生 `steer` RPC | 恢复原 JSONL 会话 | 支持（每轮 `set_model`） | fork `provider-pi` |
| Codex | `turn/steer`（带 `expectedTurnId`） | `thread/resume` | 支持（每次 `turn/start` 传参） | fork `provider-codex` |
| Cursor | 不支持 | 恢复已保存会话与 SDK store | 支持（恢复与 send 时传参） | fork `provider-cursor` + `@cursor/sdk` |
| Kiro | 不支持 | `session/list` 核对 ID 与 cwd 后 `session/load` | 不支持（固定创建时模型） | fork ACP `kiro-cli acp --agent-engine=v3` |
| Antigravity | 不支持 | 支持恢复原会话 | 支持 | fork `provider-antigravity`（复用本机 `agy` 登录） |
| Droid | 不支持 | 传入原会话 ID 执行 `session/load` | 支持（含 `reasoning_effort`） | fork ACP `droid`（本机登录或 `FACTORY_API_KEY`） |

### Thread 上游执行模式

Baton 采用上游 `RuntimeMode` 与 `DEFAULT_RUNTIME_MODE`（当前默认 `full-access`）。`POST /threads`、本地 `open` 与 Project `threads.create` 接受可选 `runtime_mode`，创建后保存在中心 `threads`、下行 outbox、`node.db` Thread 配置和 `NativeMapping` 中，后续回合、空闲唤醒与崩溃恢复沿用同一模式。待审批请求复用 Thread 问题/回答链路交给员工，详见 [Agent 适配设计](../agent-adapters/TECH.md#thread-执行权限r-11)。

### 能力上报

`batond` 在 `node_runtime_reports.report.agents` 上报每种 Agent 的 `{agent_type, version, status, reason?, models, default_model, runtime_modes, default_runtime_mode, capabilities}`。程序或 SDK 已安装且认证为 `valid` / `unknown` 时报告 `available`，系统与版本不设静态白名单；缺程序或明确缺少认证报告 `unavailable`，整次探测失败且安装未确认报告 `unverified`。独立探测循环默认每轮间隔 30 秒、单次 host 探测限时 30 秒，与连接、心跳及活动 Thread 状态机互不阻塞。

## 接口

### 浏览器与设备认证 API

URL 相对 `/api/v1`。员工读取接口检查会话与资源归属，写入另检查同源 Origin 和 CSRF；会话恢复与 CSRF 派生见「账号与保留」。

| 接口 | 行为 |
|---|---|
| `GET /me` | 返回 `{employee, csrf_token, expires_at}`，供页面刷新后恢复会话；员工信息包含 `must_change_password` |
| `POST /device-auth/sessions`、`POST /device-auth/token` | 设备端发起短期设备码会话并轮询换取长效连接凭据；契约见 [设备接入 TECH](../device-setup/TECH.md#2-设备码登录协议ds-04ds-07) |
| `GET /device-auth/sessions/by-code/{userCode}`、`POST /device-auth/sessions/{id}/{approve,deny}` | 已登录员工核对短码、设备显示名与系统类型并确认或拒绝绑定 |
| `GET /nodes`、`GET /nodes/{id}` | 返回本人设备状态。Node DTO 包含 `registered_at`、`credential_state`（`active` \| `revoked`）、可空 `runtime_report`、`runtime_report_version`、可空 `runtime_reported_at`，以及报告中的 `batond_version`、`user`；在线状态和最后联系时间独立返回 |
| `GET /nodes/{id}/roots` | 通过 `node.browse_roots_get` 从本人在线且已同步设备分页读取完整授权目录，返回 `{roots,next_cursor?}`，续页传 `cursor`。单页 JSON 最多 48 KiB，独立于能力报告的 64 KiB 摘要；清单变化返回 409 `roots_changed`，从第一页重读。每次请求在设备响应后复查授权 |
| `POST /nodes/{id}/roots`、`DELETE /nodes/{id}/roots` | `{path}`；通过 Gateway 等待本人在线且已同步设备保存目录设置，返回含最新 `roots`、`repos` 摘要的 Node DTO，超限标记 `truncated`；网页另行读取完整目录清单。添加支持真实路径幂等登记，移除支持路径或目录标识；无效路径返回 400，节点离线返回 503 `node_offline` |
| `POST /nodes/{id}/subscriptions/login` | `{provider}`；通过 Gateway 启动设备端 OAuth 设备码登录，返回授权网址和验证码。ChatGPT 和 xAI 支持设备码，Anthropic 使用终端 OAuth；未取得设备码返回 503 |
| `POST /nodes/{id}/subscriptions/logout` | `{provider}`；取消本机登录进程并删除订阅凭据 |
| `POST /nodes/{id}/model-connections` | 保存、读取或删除目标设备上的连接元数据，员工身份和节点连接均须核验；密钥通过本机桌面桥接或 CLI 写入，不经过中心 |
| `PUT /nodes/{id}/project-exec` | `{enabled}`；通过 Gateway 等待在线且已同步设备原子保存并回读本机开关，确认后返回 Node DTO，报告中的 `exec` 使用设备确认值；未确认返回 503，客户端重新读取状态。协议与 `exec.user` 见 Project Agent TECH「节点能力报告」 |
| `POST /threads` | `client_thread_id`、可选 `node_id`（缺省为默认设备）、`agent_type`、可选 `model`（缺省为该 Agent 的 `default_model`）、可选 `runtime_mode`（缺省为上游 `DEFAULT_RUNTIME_MODE`）、`working_directory`、可选 `execution_timeout_seconds`（1～2,147,483,647 的整数，默认 7200）、第一条消息 `message:{client_message_id, content, thinking?}`。浏览器新建的 Thread 不属于 Project。预算参与创建幂等内容，并固定存入 open 命令的 outbox payload；以后修改 Thread 设置不会改变原 open 命令的重试内容。新建返回 201，幂等重发返回 200，内容冲突返回 409 |
| `GET /threads` | 可按 `project_id`、`node_id`、`status` 筛选，按 `(last_activity_at, id)` 倒序分页；`limit` 默认 50、最多 100，续页使用 `next_cursor`。每条记录包含 Thread 基础字段、`title`、可空 `current_turn` 和 `stop_canceled`，供列表直接展示 |
| `GET /threads/{id}` | Thread、状态、当前 Turn、待发消息、失败消息、`resume_pending` 和 `retry_open_allowed`；后者由持久拒绝及投递记录计算，表示可在原 Thread 重试打开；`model` 为实际模型，`next_model` 为后续排队消息的默认模型，`next_thinking` 为最近一条排队消息与当前模型相同时的思考选择 |
| `GET /threads/{id}/timeline` | 按审计事件 ID 顺序返回消息、Turn 边界、回复和操作；`limit` 默认 20、最多 100，续页使用 `next_cursor` |
| `POST /threads/{id}/messages` | `{client_message_id, content, mode, model?, thinking?}`，返回 202；`mode` 缺省为 `queue`，`steer` 在 Agent 不支持时返回 422；Agent 不支持换模型，或 `steer` 带模型或思考选择时返回 422。模型目录不限制显式 ID；思考选择须属于设备报告的目标模型选项 |
| `POST /threads/{id}/messages/{mid}/withdraw` | 撤回排队消息；已发出返回 409 和当前状态 |
| `POST /threads/{id}/stop` | 返回 202，保存停止及撤回排队消息的意图，状态等待设备报告确认 |
| `PATCH /threads/{id}/settings` | `{execution_timeout_seconds}`；范围与新建相同，更新本人未归档 Thread 并返回 200 和 ThreadView。中心将预算和固定内容的 `settings` 命令一起持久化；相同设置重试不重复入队，命令按顺序送往设备。200 表示已保存，设备收到后更新本地 Thread 配置和当前 Turn 的总预算；离线期间等待投递，已开始停止的 Turn 不会恢复运行。无效参数返回 422，已归档或请求归档返回 409 |
| `POST /threads/{id}/model` | `{model}`；校验切换能力，显式 ID 交给原生 Agent 判定，保存 `next_model` 并返回 200 和 ThreadView。后续接受的 `queue` 消息未指定模型时采用该值；已有消息和当前 Turn 沿用原配置，实际模型由 `turn.started` 确认 |
| `POST /threads/{id}/resume` | `{}`；Thread 已打开、处于 `stopped` / `idle` / `unknown`、无待确认停止或归档且 Agent 报告恢复能力时，保存恢复命令并返回 202 和 ThreadView。尚未打开且 `retry_open_allowed` 为 true 时，改为保存新身份的 open 命令；原消息保持撤回。`resume_pending` 表示未完成的恢复或重试打开命令，同一待完成请求不重复入队。不支持返回 422，状态冲突返回 409 |
| `POST /threads/{id}/archive` | 返回 202；有进行中的 Turn、待发消息或尚未确认停止的不确定状态时先发停止，设备确认后归档。停止已确认且无活动 Turn 或待发消息时，历史 unknown 输入保留并允许归档；空闲或已停止、无不确定输入与待发消息时直接归档 |
| `GET /threads/{id}/history` | 从设备分页读取原生历史，见「历史读取与实时输出」 |
| `GET /threads/{id}/output` | 默认经设备临时 RPC 读取实时输出；`action=full_output&output_id=...&storage_generation=...` 按可选字节游标读取设备保存的完整回复，每页最多 12 KiB 原始字节，以 Base64 返回，详见「历史读取与实时输出」 |
| `GET /executions?project_id=...`、`GET /executions/{id}` | 分页列出 Project 的 Execution 或读取详情，校验员工和 Project 归属 |
| `POST /executions/{id}/stop` | 保存停止请求并返回 Execution；最终状态等待设备报告 |
| `GET /executions/{id}/output` | 按 `output_id`、`storage_generation` 和字节 `offset` 从设备分页读取完整输出 |
| `GET /threads/{id}/trace` | 必填 `worker_turn_seq`，可选 `cursor`，返回 `{ok, code?, steps, page_cursor, next_cursor?}`，数据取自 `thread_turn_items`，不访问设备。每个步骤含 `item_id`、`type`、`status`、`ordinal`、`parent_id`、`title`、起止时间、`truncated`、`original_bytes`、可选 `full_output` 引用和上游 `data`；分页规则见「过程记录」。该 Turn 没有过程项时返回 `ok:false, code:"trace_missing"`，指定 Turn 不存在返回 404 |
| `/events` | 浏览器 WebSocket，订阅 Thread 的实时输出与状态变化 |

登录、默认设备和文件浏览沿用各自接口；Project 创建、对话与记忆修订契约见 Project Agent TECH。

Thread 列表摘要在一次 SQL 查询中读取。`title` 取首条已接受消息的首行，最多 120 个 Unicode 字符；为空时依次使用工作目录和 Thread ID。`current_turn` 为未结束的 Turn，`stop_canceled` 为最近一次停止或归档请求之后的单条消息撤回事件数，无请求时为 0。浏览器刷新列表只请求列表分页，打开会话后才读取对应的详情和 timeline。

浏览器 WebSocket 接受 `{thread_id, cursor?}` 订阅，发送带 `thread_id` 的 `thread.changed`、带 `project_id` 的 `project.changed`、带 `execution_id` 的 `execution.changed` 和 `thread.output`。对象变更事件刷新对应详情和列表；网页按对象 ID 更新，缺少 ID 或无法识别变更类型时全量刷新。节点同步和断线发送带 `node_id` 的 `nodes.changed`，设备能力报告发送带 `node_id` 和 `report_version` 的 `devices.changed`。Gateway 按事件类型与对象 ID 合并通知，避免不同对象的更新互相覆盖。每个连接订阅一个 Thread 的输出，新订阅替换旧订阅，`{thread_id:""}` 取消输出订阅并保留连接。Thread 的历史与输出复用 `session.request`，其中 `session_id` 为 Thread ID；正文不持久化，历史响应为 `Cache-Control: no-store`。

错误对象为 `{code, message, request_id, details?}`；`details` 不回传凭据和完整工具输出。

### 节点消息

| 方向 | 类型 | 用途 |
|---|---|---|
| 下行 | `thread.command` | 携带 outbox 的一条命令：open / message / withdraw / stop / resume / settings / answer |
| 上行 | `thread.command_result` | 命令已被 `batond` 写入 `node.db` 的回执 |
| 上行 | `thread.report` | 节点上行报告（上表），中心持久化后回 `thread.report_result` |
| 双向 | `session.request` / `session.result` | 临时 RPC：实时输出、原生历史；正文不进中心持久化 |

Thread 命令以信封 `message_id` 作为稳定身份，`thread.command_result` 用信封 `correlation_id` 引用它，正文含 `{type, thread_id, ok, code?}`。报告正文含 `{type:"thread.report", thread_id, event_id, worker_seq, kind, ...}`，其中 `kind` 为「上行报告」表中的类型，`worker_turn_seq` 标识 Turn，`client_message_id` 标识消息。`turn.ended` 的 `queue_empty` 表示队列是否已空。回执含 `{type:"thread.report_result", thread_id, event_id, worker_seq, ok, code?, expected_worker_seq?}`；序号不连续时返回 `worker_sequence_gap` 和下一条期望序号，不保存该报告。

Thread 回包事务按 `Node → Credential → Presence` 顺序锁定认证记录，再锁目标 Outbox 或 Thread，核验当前凭据版本、未吊销状态与当前连接身份；凭据已吊销或连接被替换均拒绝写入执行事实。

### 协议扩展

消息携带协议版本，接收方忽略未知字段，继续验证必填字段、身份、关联标识和容量；可选能力缺省关闭。浏览器 API、模型工具参数和本地配置保持严格检查。内部开发阶段统一当前结构，不兼容协议版本在握手阶段直接拒绝（R-25）。

## 通信与认证

### Gateway

节点协议版本 1，信封为 version、message_id、route、priority、correlation_id、body。Gateway 根据认证结果构造 `employee_id`、`node_id`、`credential_id`、`incarnation`、`conn_id`；客户端自报来源、节点到节点路由、未知版本和未允许的消息类型均拒绝。优先级由消息类型决定，节点不能把输出声明为控制消息。

| 接口 | 职责 |
|---|---|
| Authenticator | 验签、受众、凭据版本与吊销状态核查 |
| NodeHandler.Connected / Disconnected | 以 `conn_id` 条件更新上下线，旧连接的断开不覆盖新连接 |
| NodeHandler.Handle | 类型白名单，身份不从 body 读取，分派前复核连接和吊销 |
| NodeSender.Send | 进入有界发送队列；离线或满队列返回错误 |

保护上限：握手并发 32、业务并发 16、活动连接 128；每节点控制入站每秒 64 条、输出每秒 128 条。`Send` 成功只表示入队；持久化命令由接收方保存后返回业务 ACK。

### 长效凭据与吊销（R-02、R-04）

中心的控制操作分别计算排队和执行预算：默认排队 2 秒，执行按操作为 3～15 秒（Thread 报告 15 秒、命令接收回执 10 秒），可通过 `BATON_CONTROL_<操作名>_QUEUE_TIMEOUT` 和 `BATON_CONTROL_<操作名>_EXECUTION_TIMEOUT` 调整。持久报告或命令回执暂时超时后保留连接，明确的身份或协议错误立即关闭连接。

中心在设备码确认绑定时签发 Ed25519 签名 JWT（受众 `baton-node`，包含 `issuer`、`node_id`、`employee_id`、`credential_id`、`credential_version` 与 `iat`，不设过期时间 `exp`）。该凭据长期有效，不设业务闲置过期或探活续期机制；每次握手、命令派发、Project 续租/工具写入与业务回包均在数据库内校验 `nodes.credential_version` 与 `node_revocations`，不提供仅靠离线验签授权的路径。

吊销顺序（R-04）：PostgreSQL 提交吊销记录 → 本地认证与分派立即拒绝该凭据 → 关闭该设备的活动 WSS 连接并撤销在途 Project 租约 → 保存已生效事实；只有全部完成后 API 才返回 `effective`。`batond` 收到 `credential_revoked` 拒绝后立即进入 `rejected` 状态停止自动重连，直至员工在本机执行 `batond logout` 清除旧身份并重新发起设备码登录。

节点每次启动生成唯一 `incarnation`；已有不同 `incarnation` 活动连接时拒绝第二个环境接管（R-02）。新连接完成 `node.sync` 后才标为可用（R-03）。

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

输出超限时丢弃实时缓冲中的旧片段并标出缺口，控制消息不丢（R-16）。`batond` 持续读取子进程的 stdout 和 stderr 避免管道反压；回复全文与 Execution 原始输出另存设备私有文件，传输摘要预算不影响已保存的全文。

## 历史读取与实时输出

Thread 状态机只在回复或过程项需要裁剪时将 UTF-8 全文写入 `full-output/`，Execution 执行器将 stdout/stderr 原始数据块写入完整输出。中心保存 `{id, storage_generation, total_bytes, expires_at}` 引用。Thread 和 Execution 的输出接口检查员工及对象归属后转发到原设备；`batond` 核对输出 ID 和存储代次，验证私有目录与普通文件（拒绝符号链接），读取无需唤醒 `agent-host`。

完整输出按字节偏移分页，每页最多 12 KiB 原始数据，以 Base64 返回 `full_output:{output_id,storage_generation,offset,next_offset,total_bytes,expires_at,encoding,data,done}`。默认保留 30 天，可在设备 `--data-dir/output-retention.json` 设置 `retention_days`（1～3650）；`batond` 启动时及每小时清理过期内容，读取过期内容时立即删除并返回 `output_expired`。

`GET /threads/{id}/history` 接受可选 `cursor` 和 `limit`（默认及上限均为 16），校验归属后经 `session.request` 读取设备上的原生历史，响应为 `Cache-Control: no-store`，正文不进入 PostgreSQL 或日志。每页最多 16 条、14 KiB，单条 JSON 编码后最多 4 KiB。Pi 读取原生 JSONL，Codex 读取 thread 文件并核对身份，Kiro 通过独立只读 ACP 连接加载已保存会话；历史读取不依赖执行中的 `agent-host` 存活。

实时输出由内存中的活动 Thread 状态机保留当前 Turn 最近 256 KiB 纯文本，`GET /threads/{id}/output?cursor=...` 每次最多读取 16 KiB。游标为 `epoch:字节偏移`，Turn 切换或 `batond` 重启更换 `epoch`；旧 `epoch` 或超出保留范围时返回 `gap:true` 并从当前保留起点续读（R-16）。

进行中的步骤走同一条临时读取路径：driver 把未终态项的最新版本经输出流交给状态机内存保留（不写 `node.db` 或中心），`output` 查询附带 `running_steps` 快照（整份最多 32 项、64 KiB，超限裁剪并标 `running_steps_truncated`）。项进入终态时从快照移除并经 `turn.item` 持久化一次，网页按 `item_id` 合并快照与 trace，同一项以 trace 为准。

浏览器为当前打开且执行中的 Thread 订阅输出，按 `thread.output` 增量更新本地缓存；连接断开时通过 HTTP 续读，重连后恢复订阅。对象变更按短时间窗口合并后定向刷新；WebSocket 已就绪时每 30 秒校准中心状态，未就绪时每 2 秒校准并重试连接。

## 文件浏览

设备本地定义可浏览的 `root_id` 和真实路径，浏览器只提交 `root_id` 和相对路径。节点校验授权根、`realpath`、祖先目录和已打开句柄的设备与 inode 身份，覆盖符号链接和路径替换。仅祖先 ctime 变化时丢弃本次结果重读（最多 3 次），持续变化返回 `path_changed`，身份或边界逃逸返回 `path_escaped`。附件预览复用同一授权边界（R-18）。

`GET /nodes/{id}/files` 浏览目录和文本文件：目录每页最多返回 200 项、处理 4096 个新条目，`next_cursor` 绑定扫描位置和目录版本；文本文件每片最多 64 KiB，续读同时核对字节偏移与绑定了真实路径、设备、inode、大小、mtime 和 ctime 的文件版本，文件变化返回 `file_changed`，二进制和特殊文件拒绝。

## 账号与保留

本地员工账号由管理员创建，Argon2id 口令摘要，服务端登录会话；改密和重置注销既有会话。会话 Cookie 固定使用 `Secure`、`HttpOnly`、`SameSite=Strict`。`GET /me` 从当前会话令牌经固定域前缀隔离的 SHA-256 摘要派生稳定 CSRF token 返回，写请求用 `X-CSRF-Token` 校验。设备码登录会话默认 10 分钟单次消费，签发的设备连接凭据长期有效直至显式吊销（D2）。

登录入口在共享 HTTP 并发门限之前限制全局 120 次/分钟、IP 20 次/分钟、单账号 10 次/5 分钟，最多两次 Argon2id 口令验证并发执行（超限返回 503，限流返回 429 与 `Retry-After`）。日志与诊断不记录口令或凭据。

中心记录默认长期保留；设备上 Baton 保存的完整输出与运行记录（`transcript.jsonl`）默认保留 30 天，原生 Agent 历史由员工自行管理。设备账本、待补报数据与本地输出/运行记录合计设 1 GiB 预算，达到预警水位后拒绝新 Thread 和新消息，不删除未确认的报告（D4）。

## 敏感数据、诊断与运行记录

设备密码、模型订阅凭据、连接凭据只存在设备上（POSIX `0600`，Windows 沿用用户目录下数据目录继承的 ACL，本地控制命名管道通过私有 `control.token` 认证）。连接凭据与设备码 `device_code` 不进日志、URL、诊断摘要、运行记录或命令行参数。中心不持久化实时输出、原生历史和原始运行记录全文（R-22）；过程项按原文存入 PostgreSQL，按员工和 Project 归属隔离读取。系统不内置 OTLP 遥测导出或网页操作回放。

R-23 的诊断与运行记录按 [诊断与运行记录 TECH](../observability/TECH.md) 实现：中心、`batond`、`agent-host` 和 `project-runtime` 在结构化日志与运行记录行信封中携带各自的发布版本与提交；设备端为每个 Thread（`<data-dir>/threads/<thread-id>/<storage-generation>/transcript.jsonl`）与每次 Project Agent 运行（`<data-dir>/project-runs/<project-id>/<run-id>.jsonl`，覆盖前台协调、上下文压缩与后台记忆整理）实时追加无损 JSONL 轨迹，所属员工可通过网页分页拉取/下载或本机 `batond transcript` 查看。

## 部署

中心位于 `apps/server`，构建产物为 `apps/server/dist/server.cjs` 及相邻的 `web/`、`migrations/`，运行 `node apps/server/dist/server.cjs serve` 提供静态页面、API、浏览器 WebSocket 和节点 WSS。`BATON_NODE_SIGNING_KEY` 默认使用中心工作目录下的 `node-signing.key`（首次不存在时原子创建 `0600` Ed25519 私钥）。中心默认监听 `127.0.0.1:8080`，通过标准信任证书的 HTTPS 反向代理或直接 TLS 配置对外提供服务。

节点开发 bundle 为 `apps/batond/dist/batond.cjs`，发布形态为 SEA 安装包与内嵌 SEA 的桌面客户端（见 [发布 TECH](../release/TECH.md#1-打包与发布rl-01rl-03)）。员工通过 `batond login --coordinator <HTTPS 源>`（或桌面端一键连接）完成设备码绑定，通过 `batond status` 查看状态，`batond logout` 解除本机绑定，POSIX 系统可通过 `batond service install` 配置用户级自启服务（见 [设备接入 TECH](../device-setup/TECH.md)）。默认数据目录为 `~/.baton/data`。

## 验证

| 需求 | 设置与观察 | 失败条件 | 位置 |
|---|---|---|---|
| R-01 | 两名员工，交叉请求 Thread、消息、历史、文件与设备码确认 | 返回内容、绑定错账号或向对方设备发送命令 | HTTP 集成 |
| R-02～R-04 | 设备码绑定、过期/拒绝、响应丢失幂等重试、克隆身份（`incarnation` 冲突）、并发吊销与中心重启 | 过期会话仍签发凭据；已吊销凭据继续操作或无限重连；旧连接断开把新连接标为离线 | HTTP + Gateway 集成 |
| R-07、R-08 | 同一 `client_thread_id` / `client_message_id` 重复提交 100 次，正文相同与不同各一组 | 多于一个 Thread 或消息；不同正文未返回 409 | PostgreSQL 集成 |
| R-08 | 执行中排队 3 条、插入 1 条、撤回 1 条；不支持插入的 Agent 请求插入 | 排队顺序错误；撤回的消息被发出；不支持插入时未拒绝 | Thread 状态机回放 |
| R-08、R-13、R-20 | 排队 2 条后在 Turn 结束前、`intent` 后、适配器确认后分别杀 `agent-host` 或重启 `batond` | 任一消息发出两次或丢失；残留子进程未回收；无法确认时没有进入 `unknown` | 状态机故障注入 + 进程测试 |
| R-09、R-15 | 多条回复与超过 32 KiB 回复、超过 192 KiB 过程项、中心中途重启与序号跳跃、设备离线读取 | 回复或过程项重复、缺失、乱序；`turn.ended` 早于回复或过程项入库；超长未截断或缺少全文引用 | Store 集成 + 离线转录 `e2e` |
| R-11、R-14 | 执行时限到期、`sleep` 子进程树运行中发起停止（Turn 前、中、后各含排队消息） | 排队消息仍被发出；超过预算后所属进程组仍有残留；状态未按回收证据收敛 | 状态机回放 + 三平台进程测试 |
| R-12 | Turn 结束空闲满 10 分钟触发 `agent-host` 自动休眠，随后再发新消息；另测存在 50 个历史空闲 Thread 时重启 `batond`；删除原生历史后发消息 | 休眠使网页状态变为 `stopped`；发消息未能透明唤醒恢复原会话；重启 `batond` 拉起了历史空闲 `agent-host`；历史缺失时新建了空会话 | 状态机单元测试 + `e2e` |
| R-16 | 设备 A 持续输出，设备 B 同时收消息和停止；运行中步骤快照与终态 `turn.item` 交错到达 | 缓冲无界增长；进行中的项写入账本；同一项显示两次 | Gateway 流控 + 状态机/网页单测 |
| R-18 | 回复里写登记目录内路径、目录外路径、`commit <SHA>`；越界符号链接浏览 | 目录外路径生成附件或可读；commit 缺少仓库 | 单元测试 |
| R-19 | 执行中重启 Coordinator、短停 PostgreSQL | 在途 Turn 中断；消息重发；回复重复；同步前设备显示可用 | 集成测试 |
| R-22、R-23 | Thread 与 Project 前后台运行记录（含中途强杀）、跨员工越权拉取与敏感凭据扫描 | 步骤缺失或被截断；强杀前已发生步骤丢失；越权可读或出现连接/订阅凭据 | [诊断与运行记录 TECH 验证](../observability/TECH.md#testing-and-validation) |
| R-25 | 消息携带未知可选字段；使用不兼容协议版本握手连接 | 未知字段导致拒绝；协议不兼容未被拒绝或未停止重连 | 协议扩展测试 + [发布验收](../release/PRODUCT.md#验收) |

自动化验收使用离线转录与本地替身；进程回收、私有文件、SQLite 和安装包检查在对应系统本地运行。真实订阅和在线模型仅用于显式手动冒烟。

## 待定

| 编号 | 事项 | 阻塞范围 |
|---|---|---|
| Q3 | 各 Agent 在三类系统上的实际能力矩阵（D1） | 诊断验证记录 |
| Q5 | 第一版之后确定 R-16、R-24 的容量压测合格阈值（D6） | 容量达标声明；不作为第一版验收条件 |
