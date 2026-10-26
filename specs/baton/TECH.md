# Baton 技术设计

Status: draft
Basis: [行为规格](PRODUCT.md) R-01～R-25。Project Agent 见 [Project Agent TECH](../project-agent/TECH.md)，事项见 [Agent Inbox TECH](../agent-inbox/TECH.md)。

凭据闲置过期、重新认证、Thread 上游执行模式与首版遥测为待实施设计；其他章节记录现行架构。当前节点凭据仍使用固定 JWT `exp`，尚无原设备重新认证流程。后端与设备的发布基线、升级和恢复设计见 [release TECH](../release/TECH.md)。

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
                         Cursor / Codex / Kiro / Pi / shell
```

一个 Thread 在设备上对应一个 Session Worker 和一个原生 Agent 会话。Worker 拥有这个 Thread 的消息队列、Turn 边界和回复账本；Coordinator 拥有 Thread 记录、消息意图和中心保存的回复。中心不能主动连接设备，所有下行命令通过设备建立的 WSS 连接送达。

目录职责与实现入口见根目录 [AGENTS.md](../../AGENTS.md#核心架构与目录)。

Worker 由 batond 用同一可执行文件的内部子命令启动，与 batond 分开存活；batond 重启后重新连接原 Worker。POSIX 下 Agent host 使用独立进程组并由 watchdog 回收；Windows 下保存 PID 与创建时间，使用 `taskkill /T /F` 回收。Worker 与 batond 之间使用带认证的 Unix domain socket 或 named pipe。

中心按单个活动 Coordinator 设计，所有业务变更通过数据库事务和版本检查。

### 技术选择

| 位置 | 技术与约束 |
|---|---|
| Coordinator、batond、Worker | TypeScript 6.0、Node 26、Effect 4.0.6；版本由 pnpm catalog 锁定 |
| 服务与生命周期 | Effect Context.Service、Layer、Scope；后台任务以 fiber 管理 |
| HTTP 与 RPC | `effect/http-api` 共享 HTTP 契约，`effect/http` 提供底层服务；Worker 与 agent-host 使用 `effect/rpc` |
| 子进程 | 节点宿主通过 Node `child_process` 启动，再提供 Effect 生命周期包装；provider 使用宿主提供的 Node Effect spawner |
| Project Runtime | Node.js、`@earendil-works/pi-agent-core` 与 `pi-ai`；stdio 连接节点宿主 |
| 中心存储 | PostgreSQL 16+、`@effect/sql-pg`、参数化 SQL、版本化 SQL 迁移 |
| 设备账本 | `node:sqlite`、WAL、FULL 同步；`@baton/sqlite` 提供串行事务与独立提交核查 |
| 追踪 | Effect 原生 OTLP/HTTP，持久 trace context 关联 HTTP、outbox、WSS、IPC 与 Worker；默认不导出，过滤 SQL 文本、参数和错误详情 |
| Web | React、TypeScript、StyleX、Vite，从中心 bundle 旁的 `web/` 提供静态文件 |
| 设备与中心通信 | `ws`、TLS WebSocket、版本化 JSON 信封 |
| 构建与检查 | esbuild 生成 Node bundle，batond 使用 SEA；Vite+ 提供 Vitest、Oxlint、Oxfmt 与 TypeScript Go 检查，各包保留编译器检查 |

Agent 的结构化接口由 t3code fork 的完整 provider adapter 实现，在 agent-host 中运行。Cursor provider 使用原生 SDK，其他执行 Agent 使用 CLI 的结构化接口。fork 以 submodule 固定提交，来源见 [t3code 说明](../../third_party/t3code/README.md)；安装包布局与平台测量见 [发布设计](../release/TECH.md)。

### 实现原则

Worker 用串行队列提交短事务，慢 I/O 在独立 fiber 中执行，结果携带控制代次返回状态队列。取消响应、回合终态和进程回收分别核实；intent 必须先于原生提交持久化。领域状态和确定性解析使用普通 TypeScript 数据结构与函数，Web 使用 React。

中心与节点保留员工隔离、事务原子性、命令幂等、租约 fencing 和恢复证据。源码开发入口、bundle 与安装包共用业务实现。实验室阶段使用当前 schema，可重建旧开发数据；正式发布后的升级使用版本化迁移。自动化验证使用离线转录与本地替身，入口见 [AGENTS.md](../../AGENTS.md#常用构建与验证命令)。

### 数据库访问

中心统一通过 Effect SqlClient 与 PgClient 执行 SQL，共享事务、连接、取消和追踪上下文。状态机、持久命令和锁查询使用显式 SQL；迁移以根目录 SQL 文件为唯一来源。Drizzle 的查询构造与类型推导可在有实际需求时评估，当前维护另一套表定义与版本的收益有限；Prisma 还需整合执行器、生成过程及事务上下文，因此当前保持 Effect SQL。

`sql<T>` 只声明静态结果类型，关键返回值需用 Effect Schema 或 `effect/sql/SqlSchema` 校验。引入查询构造器时仍需核实实际编码、运行时解码和共享事务上下文，保留现有取消与提交语义。

SQLite 在外层提交前写随机 token。COMMIT 报错且事务已结束时，从独立只读连接核对持久 token；匹配则返回原结果，核验失败返回不可重试的 `CommitUnknown` 并阻止后续查询，Worker 冻结并重新打开账本。任何查询库替换都须保留此路径、嵌套 savepoint、取消保护与 `afterCommit` 语义。

### 平台相关实现

| 能力 | POSIX | Windows 第一版 |
|---|---|---|
| 进程回收 | 独立进程组与 watchdog；host 独立组登记见 [适配设计](../agent-adapters/TECH.md#进程组与停止回收) | 持久 PID、创建时间与 `taskkill /T /F`；中间父进程先退出、Worker 崩溃后延迟回收及身份核验到终止之间的竞争仍有限制 |
| 私有文件 | 目录 `0700`、文件 `0600`，权限不符时改回；检查属主、类型及打开前后的身份 | 沿用数据目录继承的 ACL（默认位于用户目录下），只检查类型、链接与打开前后的身份；未提供逐句柄 DACL 与 reparse point 校验 |
| Worker IPC | 私有目录下的 UDS 与令牌认证 | Node 默认安全描述符的命名管道与令牌认证，令牌保存在私有目录 |

平台能力集中在 `apps/batond/src/platform`，时钟与恢复裁决分别由 Project 宿主和 Worker 拥有。Project 租约与 Turn 执行时限取 `max(hrtime 经过值, Date.now 经过值)`，计入睡眠并防止时钟回拨延长预算；Worker 停止等待使用 hrtime，睡眠期间会暂停。Windows Job Object、逐句柄 DACL 与管道权限收紧列入 [第一版之后](../release/TECH.md#第一版之后)。

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
4. 发送前 Worker 同步提交 `send_intent`，再调用适配器；适配器确认后记为 `sent`，并把消息归入当前 Turn。意图已提交但确认丢失时，用持久输入准备证据核对原生快照中已确认发送数之后的下一条 user 正文及会话身份；证据不足时，消息和 Thread 都进入 `unknown`，不重发（R-13）。
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

1. Worker 在一个事务里撤回尚未提交 intent 的排队消息，保存停止请求、控制代次和开始时间，关闭待回答问题。
2. 在独立停止任务中调用适配器的 `abort`，中断原有启动、准备或发送任务，在默认 60 秒总预算内等待回合终止或回收证据，并为最终清理预留时间。取消调用错误保留在停止路径内处理，等待超时后尝试回收。
3. 无论是否收到回合结束事件，都继续 `reap` 当前执行实例并核实持久进程记录的回收。已提交但尚未确认的 intent 使用新的只读实例核对原生证据，旧执行实例不再用于恢复。
4. 回收和输入结果均可确认时，结束活动 Turn，原因记为 `stopped` 或 `timeout`，保存 `thread.stopped` 和 stop 命令成功结果，Thread 进入 `stopped`。下一条新消息或显式恢复请求可恢复原会话。
5. 进程回收未确认、intent 无法核实或已有未知结果时，Thread 保持 `unknown`，stop 命令结果也为 unknown；shell 还必须取得匹配的完成证据。停止仍为活动 Turn 补结束报告，停止不回滚已有副作用。

每个 Thread 的 agent-host 与 Worker 分开存活。POSIX 下 host 是独立进程组组长，上游 adapter 新建的独立进程组登记给 watchdog；Worker 崩溃或被强制结束时，私有管道关闭，watchdog 回收已登记进程组。正常关闭、协议失败或自然退出也执行幂等回收。

Windows 第一版按账本保存的 PID 与创建时间核对身份，再用 `taskkill /T /F` 回收。中间父进程先退出时可能漏掉其后代；Worker 被强杀后，到下次 Worker 启动前 Agent 可能继续运行。Job Object 留待原生模块接入，当前边界和未测项见 [Agent 适配 TECH](../agent-adapters/TECH.md#进程组与停止回收)。Agent 通过服务管理器等方式脱离所属进程树的后台动作不在回收保证内，停止不回滚已有副作用（R-11）。

60 秒等待期间，Thread 保持 `running`，界面显示停止请求已发送。等待上限是 Worker 配置项，默认 60 秒。

因此每个已开始的 Turn 都会产生一次 `turn.ended`，Project Agent 不会一直等待（Project Agent PA-19）。

### 回复与附件

适配器每产生一条回复，Worker 在一个账本事务里保存回复正文、附件引用和 outbox 事件，再上报。中心按 `(thread_id, worker_seq)` 去重保存到 `thread_replies`。正文超过 32 KiB 时，Worker 保留开头和结尾各 16 KiB，记录原字节数和本地历史引用（R-09）。

附件引用来自两处：

- Agent 在回复中写出的登记目录内路径和 `commit <SHA>`。Worker 用 `fileaccess` 解析：路径必须位于某个登记根内，解析为 `{node_id, root_id, path, access_status}`；commit 解析为 `{repo, sha}`，`repo` 取工作目录所在仓库的 origin。无法解析的文本保持为正文，不生成附件。
- shell 回复的输出本身不作为附件；退出码作为回复元数据保存。

附件不复制文件内容，中心只存引用（R-18）。

### 过程记录

过程记录（R-09）来自 t3code 的 `OrchestrationV2TurnItem`。agent-host 的 driver 订阅 `turn_item.updated`，只处理当前 run 的项。adapter 事件携带完整输出；`outputOmitted` 只出现在 t3code 服务端的 wire 投影中，Baton 不经过那一层。

| 环节 | 规则 |
|---|---|
| host 上报 | 某项第一次进入终态（completed、failed、cancelled、interrupted）时，发出 host `item` 事件，之后同一项的更新忽略。driver 保留本轮尚未终态的项的最新版本，`turn.terminal` 或停止时，在 `end` 之前按 `ordinal` 补发，状态保留最后一次看到的值。`assistant_message`、`user_message` 已由回复和消息保存，不作为过程项；用户提问和 MCP elicitation 仍形成问题事件，进入终态时也作为过程项上报；其余类型原样上报。`item` 属于控制事件，进入有界控制队列，不丢弃 |
| Worker 截断 | 整个 `JSON.stringify(item)`（索引字段和 `data`）最多 192 KiB，`original_bytes` 记录裁剪前 `data` 的 JSON 编码字节数。超限时先保存原始 `data` JSON 到 `full-output/`（与回复全文共用存储和保留期），再按当前最长字符串保留首尾裁剪，最多 256 次。结构本身仍超限、无法继续缩小或达到次数上限时，摘要 `data` 置为 `null` 并标记 `metadata.item_structure_omitted:true`，全文引用保留。发生裁剪时记录 `truncated` 和完整输出引用；字符串和对象键保留原文，仅顶层索引与展示字段按既有安全展示规则处理，并标记 `metadata.item_text_sanitized`，展示映射本身不设置 `truncated` |
| Worker 账本 | 截断结果与 outbox `turn.item` 事件在同一事务提交。同一 Turn 的 `turn.item` 都在 `turn.ended` 之前（Worker 账本不变量 3）。停止或状态不确定后的清理在退役前，由 host 在控制事件流末尾发确认标记，Worker 持久化此前事件后才确认；清理任务在串行账本队列外等待该确认，再退役消费端，避免已入队的过程项随强制回收丢失。确认失败冻结 Worker，不报告停止成功；已确认接受的活动 Turn 在排空事件前不写结束记录，核对输入接受身份后，先处理缓冲事件，再写结束报告 |
| shell | 命令结束时，在写回复之前生成一个 `command_execution` 项：Worker 固定 `id` 为 `shell:<worker_turn_seq>`，`input` 为命令，`output` 为合并输出，附 `exitCode`。过程输出独立保留最多 192 KiB，回复摘要仍为 32 KiB，再按项的 JSON 预算裁剪；`original_bytes` 包含完整输出在 `data` 中的 JSON 编码大小，`metadata.shell_output_bytes` 另记原始输出字节数。全文引用沿用 shell 已保存的原始输出，完成记录恢复时同样先写项、再写回复 |
| token 用量 | driver 记下本轮最后一次 `provider_turn.updated` 的 `tokenUsage`，随 `end` 事件交给 Worker，再由 `turn.ended` 报告的 `token_usage` 字段原样送到中心 |

`turn.item` 报告携带 `worker_turn_seq` 和 `item:{id, type, status, ordinal, parent_id?, title?, started_at?, completed_at?, data}`。`data` 是上游 TurnItem 的 JSON，shell 只填同名字段的子集；另附 `truncated`、`original_bytes`，`metadata.full_output` 保存完整输出引用。中心不深度解码 `data`，它的结构跟随 submodule 固定的上游版本，实验室阶段不做跨版本兼容（R-25）。`data` 和 `token_usage` 使用 PostgreSQL `json`，读取时保留原 JSON，不转换为 `jsonb`，以支持字符串中的 NUL、孤立 UTF-16 代理项转义和嵌套 `null`。这些内容按原文保存，不做脱敏。

中心把每一项写入 `thread_turn_items`，以 `(employee_id, thread_id, worker_turn_seq, item_id)` 为主键，冲突时保留首次写入的版本，报告照常 ACK。`turn.item` 不写 Project Agent 输入队列，也不进入 `thread_events` 时间线；时间线的 Turn 结束事件附带该轮的过程项数量，网页据此显示过程记录这一行。

浏览器 trace 接口和 Project Agent 的 `threads.trace` 读取同一份数据：按 `(ordinal, worker_seq)` 排序，每页最多 50 项、1 MiB。首次请求以 Thread 当前已提交的 `last_worker_seq` 固定快照上限；`page_cursor` 绑定员工、Thread、Turn、该上限和本页起点，用它可重读当前页，`next_cursor` 用于续读下一页。当前快照只读取 `worker_seq` 不超过该上限的项，后到的小 ordinal 项在省略 `cursor` 从头刷新时读取。Project Agent 的 32 KiB 分片包装直接返回 `page_cursor`，分片续读必须携带它，避免执行中的新项改变正在拼接的 JSON。被截断步骤的全文经现有 `full_output` 路径从设备读取。

## 中心数据

### 表

| 表 | 内容 |
|---|---|
| `employees`、`login_sessions` | 员工与登录会话 |
| `nodes`、`node_credentials`、`node_enrollments`、`employee_settings`、`node_presence`、`node_revocations`、`node_runtime_reports` | 设备身份、凭据、默认设备、在线状态、吊销、能力报告 |
| `threads` | 一个 Thread：员工、可选 Project、设备、Agent 类型、当前模型与后续消息默认模型 `next_model`、工作目录、执行时限、状态与原因、创建者（员工或 Project Agent 及工具调用）、`client_thread_id`、`opened_at`、`archived_at`、版本；`runtime_mode` 按下述执行模式设计增加 |
| `thread_messages` | 消息：Thread、`client_message_id`、发送方、方式、可选模型、正文（≤ 64 KiB）、状态（accepted / queued / sent / withdrawn / unknown）、状态原因 `status_reason`（≤ 4 KiB）、所属 Turn |
| `thread_turns` | Turn：Thread、`worker_turn_seq`、发起方（员工或 Project Agent）、使用的模型、开始与结束时间、结束原因、上游原样的 `token_usage` JSON |
| `thread_replies` | 回复：Thread、Turn、`worker_seq`、正文、截断标记与原字节数、附件 JSON、元数据（shell 的退出码） |
| `thread_turn_items` | 过程项：Thread、Turn、`item_id`、`worker_seq`、`ordinal`、父项、类型、状态、标题、开始与结束时间、`data` JSON（编码后 ≤ 192 KiB）、截断标记与原字节数、完整输出引用 |
| `thread_events` | 只追加的审计事件：新建、消息接受、停止请求、归档、状态变化，附操作者与时间（R-23） |
| `thread_outbox` | open、message、withdraw、stop、resume、settings、answer 的下行命令意图；下一次尝试时间、尝试次数、接收确认与完成结果 |
| Project 相关表 | 见 Project Agent TECH 与 Agent Inbox TECH |

`threads` 以 `(employee_id, id)` 为复合唯一键，所有引用使用包含 `employee_id` 的复合外键。`client_thread_id` 在员工内唯一；Project Agent 创建的 Thread 另以 `(origin_conversation_id, origin_tool_call_id)` 唯一。

### 迁移

中心迁移从 `migrations/0001_initial.sql` 的当前 schema 基线创建员工、设备、Thread、Project、主对话、记忆和事项表。首个内部发布前允许重建实验数据；首版起冻结已发布迁移，通过新增版本迁移保留数据。迁移校验、SQLite 格式版本与失败恢复按 [发布升级设计](../release/TECH.md#持久格式与迁移)实施。

Thread、消息和 Turn 直接包含模型字段，消息保存 `status_reason`，Project 输入类型为当前七种输入。

`thread_reports` 保存 `(thread_id, event_id)`、连续 Worker 序号、报告内容摘要及原 ACK，不保存完整报告正文。摘要包含模型和恢复标记等当前报告字段，用于检测相同事件身份下的内容冲突。`thread_events` 只追加审计与时间线事件，回复事件保存限长正文。`threads.request_hash` 用于比较规范化的新建请求，读取接口不返回它。Turn 的 ID 与 Worker Turn 序号使用同一个含员工身份的复合外键，避免消息或回复关联到两个不同的 Turn。

`project_agent_input_queue` 的 Thread 输入为 `thread_reply`、`turn_ended`、`thread_message_failed`。`thread_reply` 为被动输入，`turn_ended` 与 `thread_message_failed` 为主动输入，参与放置、领取和重启后的通知重置。其他输入类型见 Project Agent TECH。

迁移文件编号之间允许空缺，`apps/server/src/database.ts` 在事务 advisory lock 内按文件名排序执行，记录并核对 `schema_migrations`。

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
| `turn.item` | 插入 `thread_turn_items`，主键冲突时保留原记录 |
| `turn.ended` | 写结束时间、原因与 `token_usage`；Worker 队列为空时 Thread → `idle` |
| `thread.stopped` / `thread.unknown` | → `stopped` / `unknown`，附原因 |
| `command.completed` | 按命令身份与存储代次保存执行结果，与接收 ACK 分开 |
| `question.pending` / `question.resolved` | 保存问题或关闭对应请求，关联本轮输入与执行身份 |

每个报告带 `event_id` 和 Worker 序号。中心在一个事务里保存报告、更新状态，并按消息或 Turn 的归属写入 Project Agent 输入队列（Project Agent TECH 第 9 节），提交后返回 ACK；Worker 收到 ACK 才确认本地 outbox。重复报告按 `event_id` 返回原 ACK。中心按 Worker 序号处理，序号跳跃时拒绝并要求补报，保证 `turn.ended` 不会早于这一轮的回复和过程项入库。

原 Worker 账本缺失、损坏或结构不匹配时，batond 先补送节点账本中尚未确认的 Worker 报告，再发送带 `history_unavailable:true` 的 `thread.unknown` 恢复报告。暂时无法读取时继续有界重试，保留原 Worker 的报告序列。中心在同一报告事务内，将已有活动 Turn 以 `agent_exited` 结束，并为每轮补一条带 `worker_turn_seq` 和 `item_count` 的结束时间线记录，保留已保存过程项的查看入口。仍为 accepted、尚未关联 Turn，且对应的全部 message 命令 `attempts=0`、没有接收回执的输入撤回并保留原文；其他 accepted/queued 输入改为 unknown。未完成命令按派发事实结束：`attempts=0` 且无接收回执为 cancelled，其余为 unknown。事务同时保存审计、对应 Project 输入及 Thread 状态。历史缺失本身不证明 Agent 已退出，不能设置停止确认或完成等待停止的归档；停止确认仍须有 Turn 终止或进程树回收证据。设备确认停止、没有活动 Turn 和 accepted/queued 输入后，允许保留历史 unknown 输入并归档，不重发历史命令。领取新的 open、resume 或 message 命令时，在递增派发次数的同一事务内废弃旧停止确认；新的恢复或回合开始报告也废弃旧确认，避免用上一次停止的证据归档当前执行。重复恢复报告沿用原 ACK；普通状态报告仍须在 Turn 结束后提交。

## 设备与 Worker 数据

### batond 账本（`node.db`）

| 表 | 内容 |
|---|---|
| `node_commit` | FULL 事务的提交核验 token |
| `node_commands` | 命令 ID、内容摘要、请求与原接收回执的 JSON payload |
| `node_workers` | Thread、存储代次、原配置、Worker 启动阶段与报告进度的 JSON payload |
| `node_open_attempts` | open 可能已交付的持久事实，Worker 登记不能覆盖它 |
| `node_outbox` | Worker 与节点恢复报告，保存 Thread、连续序号、事件 ID、摘要、正文和 ACK 状态 |

存储代次保存在 `node_workers.generation` 与绑定的 Worker 配置中。`thread.open` 先保存命令和 Worker 配置，再回执；重复命令返回原接收事实。成功接收和 `thread.opened` 均绑定同一代次，后续命令必须匹配。已有 Thread 不能因设备账本丢失而新建空会话。

登记配置时启动阶段为 `awaiting_open`；daemon 和 Worker 本地 IPC 入口在交付 open 前提交 `open_attempted`，绑定身份的状态、回执和报告也保留该事实。未交付 open、原账本缺失或确认为空且无执行记录时，允许用原命令 ID 和配置重试启动；可能交付后缺失或为空，以及账本损坏时，上报历史不可用。Worker 原始报告先进入节点 outbox，再向 Worker 确认，中心 ACK 独立持久保存。

Project Runtime 使用独立的 `project-runtime.db`。`project_runtime_runs` 保存运行与清理事实的 JSON payload，`project_processes` 保存按 role 索引的进程身份，`project_commit` 提供提交核验；它们不属于 `node.db`。

### Worker 账本

每个 Thread 一份 SQLite，由对应 Worker 独占写入：

| 表 | 内容 |
|---|---|
| `thread_meta` | 单行 JSON：Thread 配置、原生身份、控制代次、Turn 序号、活动输入、停止和恢复状态 |
| `thread_commands` | 命令 ID 与 JSON：内容摘要、固定接收回执、执行状态和结果 |
| `thread_messages` | 消息 ID 与 JSON：seq、方式、模型、正文、准备证据、状态、Turn 与执行身份、结束标记 |
| `thread_processes` | PID、创建时间和 role，按完整身份删除 |
| `thread_outbox` | 连续序号与 JSON：报告、ACK 标记及原始回复证据 |
| `worker_commit` | FULL 事务的提交核验 token |

Turn 边界与回复保存在上述消息状态和报告中，没有独立的 turns 或 replies 物理表。账本模块拥有格式解码、保存基线及只读检查；daemon 根据检查结果裁决恢复。

不变量：

1. 一条消息在 `intent` 之后不再自动发出第二次。
2. 同一时刻最多一个 Turn 处于开始而未结束的状态。
3. `turn.ended` 的 outbox 事件在这一轮所有 `reply` 和 `turn.item` 事件之后写入。
4. 回复与对应 outbox 事件在同一事务提交；提交状态不明时由 `packages/sqlite` 从独立连接读回确认。

`Send` 明确返回模型选择失败时，消息确定未发出，Worker 将它记为 `withdrawn`，清除预留的 Turn 序号，把原因保存到该消息的 `status_reason` 并通过 `message.withdrawn` 报告，不开启 Turn。原因摘要最多 4 KiB，替换无效 UTF-8 和 NUL，截断时保留完整字符并加省略号。Thread 保持 `idle`，保留 Agent 进程和当前模型，继续发送下一条排队消息。中心在同一事务保存消息原因；浏览器 Thread 详情和 Project Agent 的 `threads.get` 通过 `failed_messages` 读取这些失败消息。Project Agent 发起的失败消息另形成一条主动 `thread_message_failed` 输入，员工消息不写输入队列。无法确认消息是否发出的错误仍按发送意图恢复规则处理。Worker 在开始和结束报告中携带该 Turn 使用的模型，中心在 `turn.started` 时更新 Thread 当前模型。

完整原生历史由 Agent 保存在自己的文件里。TS Worker 对超出 512 字节、包含无效展示字符或占用保留前缀的回复 ID，稳定映射为 `baton:reply:sha256:…`；去重仍按原始 ID。正文中的 NUL 和孤立 UTF-16 代理项在中心报告、完整输出和实时输出中替换为 `�`。原始 ID、正文和执行身份以 JSON 保存在 `thread_outbox.payload.replyEvidence`，与安全展示报告同一事务提交，ACK 后继续保留；报告元数据标注 `reply_id_mapped`、`reply_text_sanitized` 和证据位置。显示字段异常不改变执行状态，Worker 继续核对回合终态；会话、输入或执行身份不匹配仍按 unknown 处理。

### 崩溃与恢复

| 位置 | 已知事实 | 恢复 |
|---|---|---|
| Worker 启动失败，open 尚未交付 | node.db 为 `awaiting_open`，Worker 无命令、输入、进程及报告记录 | 可重试启动，原 open 命令 ID、配置及存储代次不变 |
| open 可能已交付，Worker 账本缺失或为空 | node.db 为 `open_attempted`，可能已创建原生会话 | 上报历史不可用，禁止自动重建 |
| 消息已入 Worker 队列，未提交 `intent` | 尚未发出 | 按队列顺序继续发送 |
| `intent` 已提交，适配器确认未记录 | 可能已发出 | 用持久准备证据只读核对原生快照的位置、正文和会话身份；确认则记 `sent`，否则 `unknown`，不重发；steer 无法仅凭正文确认目标回合 |
| 普通 Agent 的 Turn 进行中，Worker 崩溃 | 旧进程与 sent 输入仍在账本中 | 先回收持久进程记录及旧执行实例，确认后为未结束的 sent 输入补 `turn.ended`；按 queued 消息或显式请求决定是否恢复原会话，回收不明则 unknown |
| shell 的 intent / sent 尚未结束 | 可能已有本机副作用 | 先回收旧进程，再读取身份匹配的完成记录；有证据则补回复与结束报告，无证据或身份不符则 unknown，不重新执行命令 |
| 回复已保存，ACK 丢失 | 可重复上报 | 按 `event_id` 去重 |
| batond 重启 | Worker 可能仍在 | 重新连接 Worker；不可达且无活动锁时检查原账本，再按上述恢复规则处理 |

Worker 崩溃后，POSIX watchdog 回收所属进程组；Windows 在下次启动时按持久进程记录核实回收。未确认回收时保持 unknown，确认后显式恢复或新消息可以继续原会话，旧 intent 不重发（R-12、R-13）。

## Agent 适配

### 接口

Worker 的 Effect 接口为 `apps/batond/src/worker/agent.ts` 中的 `ThreadAgent`，由 `AgentFactory` 为每个执行生命周期创建新实例：

| 方法 / 流 | 职责 |
|---|---|
| `open`、`resume` | 新建或恢复原生会话，返回前持久保存原生映射 |
| `prepareInput`、`restoreInput` | 保存或恢复输入基线，包含原生会话、准备标识和已确认发送数 |
| `send` | 提交 queue 或 steer 输入，返回原生接受证据 |
| `sent` | 只读核对原生快照，不发送输入或启动执行会话 |
| `answer` | 可选方法，将问题回答绑定到活动请求 |
| `events`、`output` | 持久回复、过程项、回合终态（含 token 用量）、问题和不确定事件；独立的有界实时输出 |
| `abort`、`close`、`reap` | 取消、关闭和进程树回收，取消响应本身不证明停止 |

输入的 `id` 是 `client_message_id`。Worker 与 agent-host 通过 fork 的 `ProviderAdapterV2` 执行 Agent，具体映射见 [Agent 适配设计](../agent-adapters/TECH.md)。Pi、Codex、Cursor 开放 Thread 内逐轮换模型，Worker 在 intent 中保存每轮选择，host 同时传入 `startTurn.modelSelection` 和 `appThread.modelSelection`；省略模型时沿用最近确认提交的回合模型，首次使用创建配置。恢复从输入账本取得最近确认提交的模型，保留原生会话身份。Steer 沿用活动回合模型，不接受显式模型。Kiro 的 fork adapter 通过能力覆盖明确关闭会话内换模型，Thread 固定创建时的选择。Pi 的 `set_model` 明确拒绝和 Cursor SDK 明确拒绝模型时，输入持久撤回并继续队列；不能确认是否提交的错误按 unknown 恢复，不重发旧输入。

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

### Thread 上游执行模式

Baton R-07、R-21 的待实施契约采用上游 `RuntimeMode` 与 `DEFAULT_RUNTIME_MODE`，当前默认 `full-access`。`POST /threads`、本地 `open` 与 Project `threads.create` 增加可选 `runtime_mode`；创建后在 Thread、outbox、节点/Worker 配置和原生映射保存实际值，后续回合与恢复继续使用。模式列表、按模式准入、上游 native policy、待审批请求转交和错误契约统一见 [Agent 适配设计](../agent-adapters/TECH.md#thread-执行权限r-11)，不在中心重复维护映射。

当前创建与恢复尚未携带该字段，Codex 与 Cursor 仍使用固定策略。实施时整体淘汰固定 `approval-required`、`approvalPolicy: never`、Codex 沙箱/网络覆盖和按种类自动接受待审批请求的分支，不为当前默认值保留兼容层。上游已作出的自动决策继续沿用，实际 pending 请求复用 Thread 问题/回答链路交给员工。

### 能力上报

batond 在 `node_runtime_reports.report.agents` 上报每种 Agent 的 `{agent_type, version, status, reason?, models:[{id, name}], default_model, capabilities:{create, queue, steer, stop, resume, switch_model}}`。模型目录由 fork 的 driver 探测：Codex 使用 `model/list`，Pi 使用 `get_available_models`，Kiro 经 ACP 发现会话取得模型，Cursor 使用 SDK 模型查询。目录用于发现与补全，显式模型 ID 交给原生 Agent 判定；目录为空时仍可使用默认模型或手填 ID，换模型操作继续校验 `switch_model` 能力。

`status` 为 `available`、`unverified` 或 `unavailable`。程序或 SDK 已安装且认证 valid/unknown 时报告 available，开放 create/resume；缺程序或明确认证 missing 时报告 unavailable。系统与版本不设白名单，未知版本、版本探测超时、模型目录问题和能力限制记录在 reason 中；整次探测失败且安装状态未确认时报告 unverified。Cursor 当前资产、辅助程序或 sandbox 明确失败时报告 unavailable；执行模式接入后区分公共失败和上游 mode 的实际依赖，见「Thread 上游执行模式」。shell 须单独开启本机命令权限。中心按目标系统路径规则检查工作目录属于上报的 roots，设备在执行前核实目录存在与真实路径边界。

daemon 在独立探测循环调用 `probeAgents`，每轮结束后默认间隔 30 秒，单次 host 探测最多 30 秒。探测失败保留诊断，后续循环继续重试，不按可执行文件路径或版本永久缓存空目录。探测不发送 prompt、不发起登录；Kiro 的模型发现会建立空的 ACP 会话。能力探测与目录采集、连接、心跳和 Worker 消息分别运行。

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
| `POST /threads` | `client_thread_id`、可选 `node_id`（缺省为默认设备）、`agent_type`、可选 `model`（缺省为该 Agent 的 `default_model`）、可选 `runtime_mode`（待实施，缺省为上游 `DEFAULT_RUNTIME_MODE`）、`working_directory`、可选 `execution_timeout_seconds`（1～2,147,483,647 的整数，默认 7200）、第一条消息 `message:{client_message_id, content}`。浏览器新建的 Thread 不属于 Project。预算参与创建幂等内容，并固定存入 open 命令的 outbox payload；以后修改 Thread 设置不会改变原 open 命令的重试内容。新建返回 201，幂等重发返回 200，内容冲突返回 409 |
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
| `GET /threads/{id}/trace` | 必填 `worker_turn_seq`，可选 `cursor`，返回 `{ok, code?, steps, page_cursor, next_cursor?}`，数据取自 `thread_turn_items`，不访问设备。每个步骤含 `item_id`、`type`、`status`、`ordinal`、`parent_id`、`title`、起止时间、`truncated`、`original_bytes`、可选 `full_output` 引用和上游 `data`；分页规则见「过程记录」。该 Turn 没有过程项时返回 `ok:false, code:"trace_missing"`，指定 Turn 不存在返回 404 |
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

Thread 回包事务按 Node → Credential → Presence 锁定认证记录，再锁目标 Outbox 或 Thread；全部锁取得后用数据库当前时刻复核凭据闲置期限。凭据吊销、连接替换和锁等待跨越有效期都不能写入执行事实。闲置检查与业务活动延长的原子顺序见「设备凭据生命周期」。

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

节点凭据为 Ed25519 签名 JWT，受众 `baton-node`，绑定节点、员工、credential_id 与凭据版本。闲置有效性由中心持久状态判定，见下节。吊销顺序：PostgreSQL 提交 → 本地认证与分派拒绝该凭据 → 关闭活动连接 → 保存已生效事实；只有完成后 API 才返回 effective（R-04）。

节点上线附带每次 batond 启动生成的 incarnation；已有不同 incarnation 活动时拒绝接管（R-02）。新连接完成 `node.sync` 后才标为可用（R-03）。

### 设备凭据生命周期

本节为 R-02 的待实施设计。中心签发的设备 JWT 保留签名、issuer、audience、节点、员工、凭据 ID、版本与签发时间，移除固定 `exp`。其授权必须经过数据库当前凭据版本、吊销与闲置期限检查；不提供只验签即可授权的路径。注册和重新认证凭据仍为默认 10 分钟、单次使用的独立秘密。首版前直接调整开发协议和 DTO，不保留固定期限 JWT 的兼容分支。

| 记录与入口 | 设计 |
|---|---|
| `nodes` | 新增 `last_business_at`；记录已验证业务活动的中心接收时间，与 `node_presence.last_contact_at` 分开 |
| `node_credentials` | 将固定 `expires_at` 替换为 `idle_expires_at`；注册或重新认证初始化为中心当前时间加闲置期限 |
| `node_enrollments` | 增加 `purpose=register\|reauth`、可空 `target_node_id`；重新认证凭据绑定员工和原设备 |
| 重新认证回执 | 持久记录 `operation_id`、规范请求摘要、新 credential_id/version 与签发时间；与凭据替换同事务提交，不保存明文秘密 |
| `NodeCredential` / 设备视图 | 本地凭据保留 ID、版本和 token；`idle_expires_at` 只作为中心响应的状态快照，节点不依据旧本地副本判定闲置期限 |

新增配置 `BATON_NODE_IDLE_TTL`，默认 `720h`，范围 1 小时至 90 天；它替代固定期限配置 `BATON_NODE_CREDENTIAL_TTL`。改变配置只影响后续注册、重新认证和有效业务计算的新期限，不自行复活已过期凭据。所有比较使用 PostgreSQL `clock_timestamp()`，期限相等即过期。

#### 活动认定与在途检查

R-02 的活动在业务入口按固定种类认定，调用方不能通过布尔字段自行声明活跃。一次新命令的持久接收、新的 Worker 报告、Project 前台 `claim_inputs` / 工具请求，以及用户主动设备请求的成功响应可以延长期限。设备报告、轮询与文件分页须携带可关联的操作身份；自动刷新不生成可续期的用户操作。相同命令、事件、请求或分片重试只返回原结果，失败和重复投递不延长。

中心仍活跃的业务采用有界存活证据：前台 Project 的有效宿主续租可算活动；Thread 由 daemon 定期查询 Worker 的认证 status，携带 Thread、存储代次、Turn 序号、实际执行身份和每次新核查的序号上报。中心验证对应未结束 Turn 和当前连接；daemon 按现有 Worker 状态查询预算有界核查。仅中心存有 `running`、节点仅发心跳、陈旧 status 或后台 memory claim 均不足以续期。设备离线期间中心不依据过去的执行中状态延长期限。

允许活动的事务遵循入口既有锁顺序：Node → Credential → Presence 的相对顺序不变，Project 请求先取得既有 Agent 锁。需要延长期限的入口首次取得 Node 与 Credential 时即使用写锁，避免持有共享锁后同时升级锁造成竞争。取得全部相关锁后再次校验原闲置期限和来源，再保存首次业务事实与新的 `last_business_at`、`idle_expires_at`。锁等待跨过期限则拒绝，不能先延长再授权。多个新业务串行按当前行更新，以 `GREATEST` 保证期限不被较早结果缩短。复用已有报告去重和命令回执判定，不把重复 ACK 当作新活动。有效存活核查也必须在旧期限内提交。

握手、派发、Runtime 续租、工具写入与业务回包共用闲置校验。维护循环关闭已过期连接并撤销其 Project 租约，维护延迟不能放宽事务校验。过期返回 `node_idle_expired`，daemon 停止认证重试并显示重新认证指引。Worker 按原生命周期保存结果，中心不接收过期身份的补报；重新认证并同步后沿原事件身份补报。吊销返回既有吊销错误，重新认证不能解除吊销。

#### 原设备重新认证

新增入口均为待实施契约，HTTP DTO 在 `packages/protocol` 的共享声明中维护。

| 入口 | 输入、输出与边界 |
|---|---|
| `POST /api/v1/nodes/:id/reauth-enrollments` | 已登录员工、Origin 与 CSRF 校验，校验本人未吊销设备；创建绑定该设备的默认 10 分钟凭据，沿用 enrollment 响应，不需要设备在线 |
| `batond reauth` | 使用已有 `--data-dir`、已保存中心地址与 `--ca-file`；新凭据来自 `BATON_ENROLLMENT_TOKEN` 或 `--enrollment-file`，原设备 token 由私有身份文件读取 |
| `POST /api/v1/nodes/:id/reauth` | `operation_id, enrollment_token, previous_token`；仅用于重新认证，不授予普通节点业务权限；成功返回同一节点的新身份凭据 |
| 节点视图 | 增加 `credential_state=active\|idle_expired\|revoked` 与 `idle_expires_at`，不包含 token |

`previous_token` 验证签名、员工与节点绑定，允许闲置过期；首次执行仍要求它对应最近签发的凭据版本。中心按 Node → Credential → Presence → enrollment/回执加锁，核对归属、未吊销、目标凭据与请求摘要，在一个事务里消费 enrollment、递增凭据版本、签发新凭据并保存回执。旧连接身份立即失效；新身份成功同步后才可派发。

CLI 在 `identity.lock` 下保存待提交的 operation_id 和请求摘要，再发请求；取得响应后原子替换 `identity.json`，随后清除待提交记录。旧身份与 enrollment 秘密在本地私有存储保留至替换完成，不打印到日志。响应丢失或本地保存前退出后，以相同请求重试，中心通过回执按原签发字段重建同一结果，不能再次递增版本。

已提交操作的回执重取仍检查节点未吊销、新凭据仍是当前版本、原请求秘密及摘要一致；只对同一已提交操作允许旧版本证明。enrollment 的期限限制首次消费，已消费秘密只能配合原证明取回原操作结果，不能发起新替换或延长闲置期限。取回的凭据若也已闲置过期，须再以它和员工新领取的 enrollment 发起重新认证。相同 operation_id、不同请求返回 `reauth_conflict`。其他员工、错误目标、已吊销节点、缺失身份或 incarnation 冲突均拒绝；没有原操作连续证据时返回 `identity_recovery_required`，保留数据并由员工核对，不能删除身份自动重新注册。

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

设备本地定义可浏览的 `root_id` 和真实路径，浏览器只提交 `root_id` 和相对路径。节点校验授权根、realpath、祖先目录和已打开句柄的设备与 inode 身份，覆盖符号链接和路径替换。仅祖先 ctime 变化时丢弃本次结果，完整重新授权并读取，最多尝试 3 次；持续变化返回 `path_changed`，身份或边界变化返回 `path_escaped`。附件预览复用同一授权边界（R-18）。中心不代取任意 URL，不提供文件存储。

TypeScript 的 `GET /nodes/{id}/files` 通过 `root_id`、`path` 浏览目录和文件。POSIX 路径保留冒号和反斜杠的字面含义；Windows 相对路径拒绝冒号、反斜杠、驱动器与 ADS，所有系统拒绝绝对路径、控制字符和 `..` 路径段。目录每页最多返回 200 项、处理 4096 个新条目，`next_cursor` 携带扫描位置和目录版本；续页重新打开目录并跳过已读位置，可继续读取整个目录；目录变化返回 `directory_changed`，网页保留已取得的条目并提示重新读取。未指定根时复用授权根管理接口的分页，每页 JSON 不超过 48 KiB，游标绑定清单版本和下一项位置。

文本文件每片最多 64 KiB，响应包含 `offset`、`version`，以及有后文时的 `next_offset`。续读必须同时提交返回的字节偏移和版本；版本绑定真实路径、设备、inode、大小、mtime 和 ctime，读取前后核对，文件变化返回 `file_changed`。分片止于完整 UTF-8 字符，网页通过继续读取追加内容，变化时提示重新打开文件。二进制和特殊文件继续拒绝。

## 账号与保留

本地员工账号由管理员创建，Argon2id 口令摘要，服务端登录会话；改密和重置注销既有会话。会话 Cookie 固定使用 Secure、HttpOnly、SameSite=Strict。`GET /me` 从当前会话令牌经固定域前缀隔离的 SHA-256 摘要派生稳定 CSRF token，并以 URL-safe Base64 返回；同一 Cookie 在页面刷新及 Coordinator 重启后得到相同 token，读取不续期或轮换会话。数据库仅保存会话令牌摘要与派生 token 的摘要，写请求用 `X-CSRF-Token` 校验。JSON 响应和日志不得暴露 Cookie 原值，也不以会话令牌或其存储摘要直接充当 CSRF token。注册凭据默认 10 分钟单次使用，节点凭据连续无实际业务 30 天后闲置过期（D2），判定、重新认证和 DTO 见「设备凭据生命周期」。

中心记录默认长期保留，没有自动清理；回复正文和过程项已限长，过程项随 Thread 保留。设备上 Baton 保存的完整回复与 shell 输出默认保留 30 天，原生 Agent 历史由员工自己管理。设备账本与待补报数据设 1 GiB 预算，达到预警水位后拒绝新 Thread 和新消息，不删除未确认的报告（D4）。

## 敏感数据

设备密码、模型订阅凭据、节点私钥只存在设备上，POSIX 文件权限为当前用户 `0600`；Windows 第一版沿用用户目录下数据目录继承的 ACL，不另行设置或校验，命名管道使用 Node 默认安全描述符与私有令牌认证，逐句柄 DACL 检查留待原生模块接入。节点凭据和注册凭据不进日志、URL 或命令行。中心不持久化实时输出和原生历史（R-22）。过程项按原文存入 PostgreSQL，命令输出里可能带有密钥；读取时按员工和 Project 归属检查，Project Agent 读取时不脱敏。追踪导出只带 span 元数据，不导出过程项正文；向观测或分析平台导出过程数据的导出器必须先脱敏。

### 首版遥测

R-23 的待实施部分复用 `packages/telemetry/src/index.ts` 的 Effect OTLP/HTTP 导出、并发与超时限制。发布版本与提交写入构建元数据，由中心、daemon、Worker、agent-host 和 Runtime 各自报告；恢复或升级时读取实际运行程序元数据，不能把新 daemon 版本套在仍存活的旧 Worker 上。

资源属性包含 `service.version`、源码提交、OS 与架构；业务 span 使用有界的节点、Project、运行、命令和 Thread 标识，以及 Agent/provider/model、固定错误码、等待原因、重试次数、停止/恢复结果、耗时与可选 token 用量。沿既有 trace context 关联，不以原始错误文本充当错误码。模型未报告 token 时字段缺省并标注未知，不写成零。

现有导出白名单尚未覆盖这些业务属性，实施时在 `packages/telemetry` 统一增加明确字段，并限制资源属性、事件和错误详情的内容。查询、路径、消息、记忆、证据和工具正文不进导出。记忆的工作积压、召回降级与成本字段按 [memory TECH](../project-memory/TECH.md#可见性与实施边界)维护。未配置 OTLP 时保持现有本地诊断，不连接采集端；内部部署可显式启用，导出阻塞与失败继续有界丢弃，不阻塞业务。发布与升级的版本关联验收见 RL-A09。

## 部署

中心位于 `apps/server`，构建产物为 `apps/server/dist/server.cjs` 及相邻的 `web/`、`migrations/`。与 PostgreSQL 部署后，运行 `node apps/server/dist/server.cjs serve` 提供静态页面、API、浏览器 WebSocket 和节点 WSS。`serve`、账号管理和 `migrate` 都先执行并核对迁移；`migrate` 完成后退出。

签名密钥路径由 `BATON_NODE_SIGNING_KEY` 指定，默认工作目录下的 `node-signing.key`；仅在 `lstat` 确认不存在时生成 Ed25519 私钥并原子写入 `0600` 文件，已有文件校验权限、类型、所有者和内容；Windows 不校验权限位和所有者，依赖目录继承的 ACL，也不对目录句柄执行 fsync。升级的迁移、备份和进程处理按 [release TECH](../release/TECH.md#升级执行与恢复)实施；普通中心重启继续按 R-19 恢复。中心默认监听 `127.0.0.1:8080`，通过 HTTPS 反向代理公开；也可直接配置证书提供 HTTPS/WSS。容器与设备 SEA 的发布布局见 [发布设计](../release/TECH.md#打包与发布)。

节点 bundle 为 `apps/batond/dist/batond.cjs`，命令使用 `node apps/batond/dist/batond.cjs <命令>`。`register` 使用 Node 的平台标识推导系统名，显示名由主机名清理而来。注册在 `identity.json` 保存规范化 HTTPS 中心地址，`run` 优先使用显式 `--relay`，否则推导 WSS 地址。`up` 复用注册和运行逻辑，在没有身份时要求中心地址和凭据；workspace 在连接前幂等登记。默认设备数据目录为 `~/.baton-ts`。

设备进程使用员工账号运行。开发 bundle 的 Project Runtime 从 `runtimes/project-agent/src/cli.ts` 与已安装依赖启动，宿主负责 stdio、订阅登录和租约；SEA 使用 [发布设计](../release/TECH.md#打包与发布) 中的子命令形态。

目录职责见 [AGENTS.md](../../AGENTS.md#核心架构与目录)，开发与验证入口见 [AGENTS.md](../../AGENTS.md#常用构建与验证命令)。适配器离线验证见 [回放设计](../agent-replay/TECH.md)。

## 验证

| 需求 | 设置与观察 | 失败条件 | 位置 |
|---|---|---|---|
| R-01 | 两名员工，交叉请求 Thread、消息、历史、文件 | 返回内容或向对方设备发送命令 | HTTP 集成 |
| R-02～R-04 | 注册过期、克隆身份、吊销与重连并发、中心重启 | 已吊销凭据继续操作；旧连接断开把新连接标为离线 | Gateway 集成 |
| R-07、R-08 | 同一 `client_thread_id` / `client_message_id` 重复提交 100 次，正文相同与不同各一组 | 多于一个 Thread 或消息；不同正文未返回 409 | PostgreSQL 集成 |
| R-08 | 执行中排队 3 条、插入 1 条、撤回 1 条；Kiro 请求插入 | 排队顺序错误；撤回的消息被发出；Kiro 接受插入 | Worker 回放 |
| R-08、R-13 | 排队 2 条后在 Turn 结束前、`intent` 后、适配器确认后分别杀 Worker | 任一消息发出两次或丢失；无法确认时没有进入 unknown | Worker 故障注入 |
| R-09 | 一轮 3 条回复，中心在第 2 条后重启；超过 32 KiB 的回复 | 中心回复重复、缺失或乱序；`turn.ended` 早于回复入库；超长正文未截断 | Store + 假节点 |
| R-09 | driver 回放：项先 running 后 completed、同一项重复终态、本轮结束时仍有 running 项；Worker 截断：一项超过 192 KiB，多个大字段 | 未终态项提前上报；同一项上报两次；补发项排在 `end` 之后；截断后编码超过 192 KiB 或缺少全文引用 | driver 与 Worker 单元测试 |
| R-09、R-15 | 中心在第 2 个 `turn.item` 后重启并收到重复报告；序号跳跃；两名员工交叉请求 trace；一轮 120 项分页 | 过程项重复、缺失或乱序；`turn.ended` 早于过程项入库；跨员工或跨 Project 返回内容；分页漏项 | PostgreSQL 集成 |
| R-09 | Codex、Cursor、Pi、Kiro 现有离线转录各跑一轮，shell 执行一条命令；之后让设备离线 | 中心缺少转录中的命令、文件修改或工具调用；`token_usage` 缺失（转录未提供的除外）；离线后 trace 不可读 | e2e |
| R-09、R-14 | 执行时限 2 秒，Agent 不停；`Abort` 无法确认 | 没有 `turn.ended`；原因不是 timeout；无法确认时状态不是 unknown | Worker 回放 |
| R-11、R-14 | Pi 执行 `sleep 600` 时停止，等待上限设为 2 秒；子进程再 fork 一个子进程 | 超过上限后 Agent 进程组仍有存活进程；Thread 不是 stopped；Worker 被一起结束 | Worker 进程测试，三类系统 |
| R-10 | 设备离线后查看执行中的 Thread | 界面显示执行中但没有最后报告时间和离线标记 | Web 测试 |
| R-11 | 在 Turn 开始前、执行中、刚结束时停止，各有 2 条排队消息 | 排队消息被发出；未确认就显示已停止 | Worker 回放 |
| R-12 | Agent 进程退出后发消息；删除原生历史后发消息 | 恢复时 Thread ID 改变；历史缺失时新建了空会话 | Worker 回放 |
| R-15、R-22 | 一轮结束后让设备离线，检索中心数据库与日志中的随机标记 | 回复或过程项不可见；原生历史或实时输出出现在中心；过程项正文出现在日志或追踪导出中 | 集成 |
| R-16 | 设备 A 持续输出，设备 B 同时收消息和停止 | 缓冲无界增长；跨设备命令延迟阈值在第一版之后确定与验证 | Gateway 本地流控测试；负载阈值为第一版之后 |
| R-18 | 回复里写登记目录内路径、目录外路径、`commit <SHA>` | 目录外路径生成附件；commit 缺少仓库 | 单元测试 |
| R-19、R-20 | 执行中重启 Coordinator、batond、Worker，短停 PostgreSQL | 消息重发；回复重复；同步前设备显示可用 | 进程测试 |
| R-24 | 第一版之后验证 500 台设备、100 个执行中 Thread，24 小时 | 第一版之后按 D6 确定容量阈值并判定 | 第一版之后的压测环境 |
| R-25 | 当前消息带未知字段、未声明可选能力 | 未知字段导致拒绝或已知字段改变；未声明能力被启用 | 协议扩展测试 |

### 凭据与发布验收

下表为待实施行为的验证计划。

| 需求 | 设置与观察 | 失败条件 | 位置 |
|---|---|---|---|
| R-02 | 将数据库闲置期限设置在当前时刻前后；心跳、重复报告、后台整理与新业务交错，持锁跨越期限 | 无业务仍续期、过期后先续期再授权、旧执行状态永久保活 | PostgreSQL 集成，planned |
| R-02、R-04 | 真实 Worker 替身有长回合，再让 status 陈旧或设备离线；前台与后台续租分别检查 | 无有效执行证据仍续期；后台续租延长；有效前台或 Thread 核查未保持活跃 | 包内协议替身与中心集成，planned |
| R-01、R-02、R-13 | 重新认证响应丢失、本地身份保存前退出、重复提交、enrollment 在提交前后到期、并发吊销 | 新设备产生、凭据多次替换、越权重取、吊销复活、旧输入重发 | 节点本地替身与 HTTP 集成，planned |
| R-22、R-23 | 不同实际版本产生诊断；向 span、resource、事件和错误注入敏感标记；导出超时 | 实际版本不符，正文泄漏，token 缺失被记作零，业务受导出阻塞 | telemetry 单测与发布验证，planned |
| R-25 | 已发布格式增量升级与失败恢复 | 迁移、兼容与恢复结果不符合 RL-A02～08 | release 验证，planned |

自动化验收使用离线转录与本地替身；进程回收、私有文件、SQLite 和安装包检查在对应系统本地运行。交叉构建不代替原生验证，未测项如实记录。真实订阅和模型调用仅用于显式手动冒烟。

## 待定

| 编号 | 事项 | 阻塞范围 |
|---|---|---|
| Q3 | 各 Agent 在三类系统上的实际能力（D1） | 支持矩阵 |
| Q5 | 第一版之后确定 R-16、R-24 的负载阈值（D6） | 容量达标声明；不作为第一版验收条件 |
