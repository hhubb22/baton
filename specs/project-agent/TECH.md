# Project Agent 技术设计

Status: approved
Owner: Asa
Date: 2026-10-18
Baseline: `hhubb22/baton@6da5ebef0d4d129fad4776de3dafd8b2e681f958`；Pi `earendil-works/pi@482c138`（2026-10-18，各包 1.3.0）；DSH `deepseek-ai/deepseek-harness@687f282`（2026-10-17）
Approval: 2026-10-18 用户确认，合并进 main
Basis: [PRODUCT.md](PRODUCT.md) PA-01～PA-22；[Agent Inbox 行为规格](../agent-inbox/PRODUCT.md) IB-01～IB-27 中与 Project Agent 相关的部分；[Baton TECH](../baton/TECH.md)

## Context

现有 Baton 的协调单位是 Task。用户或执行 Agent 提交一个 Task，Coordinator 在一个事务里保存 Task、Execution、事件和 `dispatch_outbox`（`internal/store/task.go` 的 `acceptOnce`），节点上的 Session Worker 执行并回报结果。执行 Agent 通过 `baton delegate` 派生子任务：CLI 经本地 IPC 交给 batond，batond 经 Gateway 把 `AgentRequest` 送到 Coordinator 的 `onAgentRequest`（`internal/control/agent.go`），来源身份由 Gateway 认证和节点账本绑定。节点只主动连接 Gateway，不直接访问 Coordinator，单条控制消息上限 256 KiB。

Project Agent 引入的是一个比 Task 存在更久的协调者。它没有对应的 Task，运行位置每次都可能不同，派出的任务返回结果时它可能不在运行。现有模型里有三处装不下它：`sessions` 表把会话固定在一个 `node_id` 上；子结果交付（`0011_child_deliveries.sql`）以「来源 Worker 仍在」为前提；完整会话历史只存在节点上。

本设计在 Coordinator 里新增 Project Agent 服务，并在节点上新增一个由 batond 启动的 Runtime 进程。现有的 Task、Execution、启动许可、执行账本和父子委托都保持不变，Project Agent 派出的任务走同一条接受路径。

## Proposed changes

### 1. 选型：pi-agent-core，消息由 Baton 保存

Runtime 使用 Pi 的 `@earendil-works/pi-agent-core`，模型访问和订阅登录使用 `@earendil-works/pi-ai`。不使用 `pi-coding-agent`、`pi-durable` 或 DSH。理由如下。

pi-agent-core 只包含 Agent Loop、工具执行和事件流（`packages/agent/src` 约 2500 行）。它的会话状态就是一个 `messages` 数组，由宿主传入和保存（`initialState.messages`），这正好对应「状态全部在 Coordinator」。它提供的钩子满足本设计需要：`subscribe` 的监听器会被 await，assistant 的 `message_end` 处理完之前不会执行工具，可以当作写入屏障；`prepareRequest` 在每次请求前执行，可以检查上下文用量；`continue()` 可以从结尾为 user 或 toolResult 的消息列表继续，用于崩溃恢复；`sessionId` 用于 prompt cache。pi-ai 提供 `openai-codex`、`openai-chatgpt`、`xai` 等订阅 OAuth 登录，token 刷新带跨进程锁（`packages/ai/src/auth/oauth/`）。

`pi-coding-agent` 的 `SessionManager` 直接写本地 JSONL 文件，没有可替换的存储，还自带 bash、文件工具和按 cwd 的资源发现，都不适合协调角色。`pi-durable` 的 `Storage` 接口有 17 个方法，语义细，而且标为 Experimental，Unreleased 版本刚把 SQLite schema 升到 v2，不能回滚。DSH 的会话持久化接口和压缩设计比 Pi 默认实现更接近本设计（见第 6 节），但只能在完整 DSH 运行时里使用（仓库有 351 个 `package.json`，通过 `dsh --profile sdk` 的 JSON-RPC 子进程嵌入），仍处于开发者预览，而且 `llm-pi-ai` 不支持 Sign in with ChatGPT。

代价：pi-agent-core 不负责持久化、崩溃恢复和压缩，这三件事由 Baton 实现，设计见第 4～6 节。DSH 的 `SessionPersistence` 和 `compaction-basic` 作为设计参考。

### 2. 进程与通信

```text
浏览器 ── Coordinator ── PostgreSQL
              │
            Gateway
              │
           batond ── 本地 IPC ── baton-project-runtime（Node.js，pi-agent-core + pi-ai）
              │
        Session Worker（执行 Agent，现有）
```

`baton-project-runtime` 是一个独立的 Node.js 程序，采用固定版本 Node bundle，随 batond 的安装包分发。设备需要安装 Node.js 22.19.0 或更高版本，才能承载 Project Agent；只运行执行 Agent 的设备不需要 Node.js。batond 负责发现它、上报能力、启动和停止进程、代为续租。Runtime 不直接连 Coordinator，所有请求经本地 IPC 交给 batond，再沿现有 Gateway 通道送到 Coordinator，复用 Gateway 的节点认证。这样不需要为节点新开一条访问 Coordinator 的数据通道。

新增 Gateway 消息类型 `ProjectRuntimeRequest` / `ProjectRuntimeResult`，处理方式和现有 `AgentRequest` 一致：batond 附上运行身份 `(run_id, lease_epoch)`，Coordinator 校验节点与运行记录一致、租约有效。每个请求和响应不超过 192 KiB，留出信封余量；每条对话事件写入时不超过 160 KiB（第 3 节），所以分页读取每页至少能取到一条。Runtime 经这条通道发出的请求只有下面几种：

| 请求 | 作用 | 说明 |
|---|---|---|
| `bootstrap` | 取回 Agent 配置、最新 `compaction` 事件和读取起点 | 第 4、6.1 节 |
| `read_events` | 从 `after_seq` 之后按序读取对话事件，每页不超过 `max_bytes` | 第 4 节 |
| `claim_inputs` | 领取一批待处理输入，写成一条 `input` 事件 | 第 4 节 |
| `append_event` | 保存一条 assistant 消息 | 带 `client_event_id` 和最后看到的 `seq` |
| `call_tool` / `wait_tool` | 执行工具；等待 `nodes.exec` 的结果 | 第 7、10 节 |
| `commit_compaction` | 写入一条 `compaction` 事件 | 第 6.3 节 |
| `report_failure` | 报告模型请求持续失败 | 第 5 节 |
| `finish` | 正常结束本次运行，释放租约 | 第 4 节 |

续租、启动和停止由 batond 处理，不经 Runtime。

当前控制消息正文的 `type` 为 `project_runtime.request` / `project_runtime.result`。请求含 `run_id`、`lease_epoch`、`operation`；分页使用 `after_seq` / `max_bytes`，写入使用 `last_seq`，assistant 另带 `client_event_id` 和 `payload`。响应为 `{type, ok, code?, data?}`。`bootstrap` 返回 `{project, prompt_version, compaction?, compaction_seq?, goal_utf8_base64?, after_seq, last_seq}`；配置与最新 compaction 合计超过单帧时，bootstrap 返回 compaction_seq，完整 compaction 随后由 read_events 取回。目标含大量控制字符导致 JSON 转义超过单帧时，bootstrap 的 project.goal 留空，完整目标通过 goal_utf8_base64 以 UTF-8 base64 返回，Runtime 解码后构造配置；Project API 中的原目标保持完整。`read_events` 返回 `{events, last_seq, next_after_seq, has_more}`，默认每页 128 KiB，单条大事件可单独返回，响应仍不超过 192 KiB。`claim_inputs` 返回 `{event?, payload_bytes, input_count}`，要求 `last_seq` 等于当前最后序号；事件 payload 为 `{format:"pi-ai/1", message, input_ids}`，消息的文本块保存输入条目 JSON。调用方收到序号冲突或丢失领取响应时，重新读取中心事件后继续。

batond 启动命令为 `baton-project-runtime run`，工作目录是私有空目录。环境中的 `BATON_PROJECT_RUNTIME_ENDPOINT`、`BATON_PROJECT_RUNTIME_TOKEN`、`BATON_PROJECT_RUN_ID`、`BATON_PROJECT_LEASE_EPOCH` 只用于本次运行。本地 IPC 每个连接发送一条 `{token, request}` JSON，响应为 `ProjectRuntimeResult`；batond 校验 token 后覆盖请求的运行身份，Runtime 不能自行发送续租或启动回执。`poll_wake` 最长等待 25 秒，返回 `{wake:true|false}`；Runtime 闲置时可重复调用。

节点管理请求为 `started`、`renew`、`start_failed`、`exited`、`stopped`。`started` / `renew` 成功返回 `{lease_seconds:60}`。`stopped` 只确认已结束运行的进程清理，重复回执幂等；它不能恢复租约或修改对话。启动前先检查 provider，再向中心确认租约；启动意图先写入 SQLite，同一 run 在 batond 重启后不会重启进程。Unix 使用随 batond 管道关闭而停止进程组的守护，Windows 使用关闭时终止整个组的 Job Object。连接重建保留当前 Runtime，续租仍受 58 秒期限限制。期限使用包含系统休眠的单调时钟，最多每秒检查一次；机器唤醒后先核对旧期限，再发送或接受续租。读取时钟失败时停止进程。

控制帧 JSON 采用 UTF-8 编码，容量不包含 HTML 页面转义。每批同时检查数据库规范文本、消息拼接后的传输字节及事件上限，因此含引号、反斜线等字符时可能提前结束一批。任务结果文本按 UTF-8 边界保留首尾，并注明原字节数；元数据与 JSON 编码后的条目仍限制为 40 KiB。长 Project 目标的通知在 4 KiB 内保留首尾并标明截断，完整目标由 Project API 返回。


#### 2.1 Node sidecar 分发与 stdio

PS-158 的发布方式是带生产依赖与锁文件的 Node bundle，位置为 batond 同目录的 `sidecars/project-agent/`。通用打包工具、manifest 校验、stdio 容量、进程树回收和崩溃后重新启动的职责见 [Node sidecar 约定](../../runtimes/README.md)。`node tools/package-batond.mjs` 构建可分发目录；登录命令见 [Runtime 安装说明](../../runtimes/project-agent/README.md)。

batond 优先使用 bundle，通过 Node 直接运行 manifest 中的入口，要求 Runtime 版本 `0.1.0`、stdio 协议版本 1。没有 bundle 时仍可通过 PATH 发现 `baton-project-runtime`。启动前 `probe` 的版本须匹配。bundle 存在但版本不兼容时拒绝启动。

batond 设置 `BATON_SIDECAR_TRANSPORT=stdio` 后，Runtime 在 stdout 发送 `{id, request}`，在 stdin 接收 `{id, result}`，每个对象占一行 UTF-8 JSON，单帧最多 192 KiB，最多 8 个请求在途。运行身份由专用管道绑定，batond 继续覆盖请求身份。带 token 的本地 IPC 继续兼容。`poll_wake` 可在 payload 中指定 `wait_ms`（1～25000），使 180 秒闲置和 15 分钟上限在最后一次等待时准确结束。

`call_tool` 的请求字段为 `tool_call_id`、`tool_name`、`arguments` 和 `last_seq`，成功返回保存的 `tool_result` Event。Runtime 的固定工具定义与 PS-157 的字段一致；`nodes.exec` 和 `inbox.*` 在后续工单启用。工具状态不存于本地控制目录。

Runtime 的登录由用户在设备上执行 `baton-project-runtime login <provider>` 完成，走 pi-ai 的 OAuth 流程。凭据存在 Runtime 自己的数据目录，文件权限沿用 batond 的私有文件约定。`baton-project-runtime probe` 只读取凭据状态并返回各 provider 是否已登录，不发送推理请求；batond 用它生成能力报告。

Runtime 进程的工作目录是一个空的控制目录。pi-agent-core 本身不加载 AGENTS.md、skills、扩展或 MCP，Runtime 也不启用这些功能，工具只有第 7 节列出的那些。

### 3. 数据模型

PS-155 通过 0016 交付 Project、Agent、主对话、事件、记忆和输入队列的中心存储，以及 Project、用户消息、事件读取、记忆 API。输入领取、被动通知、放置和租约由 PS-156 实现。PS-156 同时提供运行身份校验和带序号、事件标识的 assistant 写入。工具执行由 PS-157 实施。

新增表都带 `employee_id`，跨表引用使用包含 `employee_id` 的复合外键，沿用现有归属检查方式。

| 表 | 主要字段 | 说明 |
|---|---|---|
| `projects` | id, employee_id, title, goal, status, version, created_at, updated_at | `status` 为 active / paused / archived；没有设备、仓库、目录字段 |
| `project_agents` | id, employee_id, project_id, provider, model, prompt_version, lease_run_id, lease_epoch, lease_until | 每个 Project 一行；`provider` 和 `model` 由用户选择，修改从下一次运行起生效；租约直接放在这一行，`lease_epoch` 只增不减 |
| `conversations` | id, employee_id, agent_id, kind, next_seq, compaction_seq, state, attention_reason, failure_count, next_attempt_at | 本期每个 Agent 一个 `primary` 对话；`state` 为 active / needs_attention |
| `conversation_events` | conversation_id, seq, employee_id, kind, client_event_id, tool_call_id, run_id, lease_epoch, payload, created_at | 主键 `(conversation_id, seq)`；`(conversation_id, client_event_id)` 唯一；`kind=tool_result` 时 `(conversation_id, tool_call_id)` 唯一；只允许 INSERT |
| `project_agent_input_queue` | id, employee_id, agent_id, source_type, source_key, payload, payload_hash, delivered_seq, created_at | 输入队列；`(agent_id, source_key)` 唯一；`delivered_seq` 为空表示待处理；领取后保留 |
| `agent_runs` | id, employee_id, agent_id, node_id, lease_epoch, state, placement_reason, started_at, ended_at, end_reason | 每次运行一行；运行位置只记在这里 |
| `project_memory_entries` | id, employee_id, project_id, title, current_revision, updated_at | 记忆条目 |
| `project_memory_revisions` | entry_id, employee_id, revision, content, author, source_seq, created_at | 只追加；`author` 为 agent 或 user |
| `node_runtime_reports` | node_id, employee_id, report_version, reported_at, report | 节点能力的结构化报告（第 8 节）；现有 `nodes.capabilities` 是最多 32 项的字符串数组，装不下目录和仓库信息 |

`tasks` 新增可空列 `project_id`、`origin_conversation_id`、`origin_tool_call_id`，并对后两列建唯一索引。用户手工创建和执行 Agent 派生的任务这三列为空，现有行为不变。

输入队列是 Coordinator 内部的数据，用户界面上的待办事项不用这张表。事项表和浏览器通知的订阅表由 Agent Inbox 的技术设计定义。`source_type` 有五种，分成两类：

| source_type | 类别 | 来源 | payload 上限 |
|---|---|---|---|
| `user_message` | 主动 | 用户在主对话发送的消息，API 拒绝超过 64 KiB 的消息 | 64 KiB 正文加元数据 |
| `task_result` | 主动 | Project Agent 派发的任务进入终态（第 9 节） | 40 KiB |
| `attention_answer` | 主动 | 用户回答或关闭一个事项（Agent Inbox IB-12），内容是事项 ID、标题、选中的选项和最多 4 KiB 的文字；上限包含 JSON 转义 | 32 KiB |
| `memory_updated` | 被动 | 用户在界面上新建或修改记忆（第 6.4 节） | 1 KiB |
| `project_updated` | 被动 | 用户修改 Project 标题或目标（第 6.1 节） | 4 KiB |

主动输入会触发放置和唤醒；被动输入只记录变化，等下一批主动输入一起交给模型（第 4 节）。`task_result` 条目包含任务 ID、状态、退出码和结果的文本字段（`summary`、`evidence`、`error`、命令输出），文本合计超过 32 KiB 时保留开头和结尾，并注明原长度和「完整内容用 `tasks.get` 读取」。这些上限在写入时检查，所以每一条都能放进一次领取。

`conversation_events.kind` 有四种：

| kind | payload | 写入方 |
|---|---|---|
| `input` | 一条 pi-ai user 消息，内容由本轮领取的输入队列条目拼成；附带这些条目的 ID | Coordinator，在领取输入的事务里 |
| `assistant` | 一条 pi-ai assistant 消息，原样保存，包括 thinking 签名、usage、stopReason | Runtime |
| `tool_result` | 一条 pi-ai toolResult 消息 | Coordinator，在执行工具的事务里 |
| `compaction` | `through_seq`、摘要文本、被清除的工具结果序号、记忆索引 | Runtime 生成，Coordinator 校验后写入 |

每条事件的 payload 不超过 160 KiB。`input` 由领取规则保证；`tool_result` 受单个工具输出 32 KiB 的限制；`assistant` 和 `compaction` 由 Runtime 把每次请求的 `maxTokens` 设为 32000 来控制，仍然超出时按模型请求失败处理（第 5 节），这条输出不保存，也没有执行其中的工具调用。

用户消息队列的 payload 为 `{"content":"正文"}`，来源键为 `user:{client_message_id}`，摘要为正文 UTF-8 字节的 SHA-256。同一来源键与相同正文返回原始队列 ID 和创建时间，不同正文返回冲突。正文上限为 64 KiB，另检查数据库中 jsonb 规范文本的 72 KiB 上限，超限返回 413。接收消息不检查设备在线状态，也不生成 `input` 事件；PS-156 的领取事务负责生成事件。

记忆修改先锁条目，再读取当前修订。`expected_revision=0` 用于创建；已有条目的版本不匹配时返回 409、`current_revision` 和当前记忆全文。新修订与条目当前版本在同一事务内提交，修订不可更新或删除。员工 API 固定写 `author=user`；Agent 工具必须先校验运行身份，再以 `author=agent` 调用同一存储入口，`source_seq` 必须属于本 Project 主对话。

对话事件 payload 采用 pi-ai 的消息 JSON，并标注 `format: "pi-ai/1"`。这是为了让 assistant 消息原样往返：Anthropic 的 thinking 签名、OpenAI Responses 的 reasoning 内容都要原样发回，Baton 自己的中立格式很难保证不丢字段。代价是 Web 端渲染和 `history.search` 需要理解 pi-ai 的消息结构（text、thinking、toolCall 几种内容块）。将来更换 Runtime 时，需要一个从 `pi-ai/1` 转换的适配器，本期不做。

### 4. 运行流程

**放置。** Coordinator 每秒扫描一次：Project 为 active、对话为 active 且已过 `next_attempt_at`、有待处理的主动输入、租约为空或已过期的 Agent。只有被动输入时不放置。上次运行已领取输入但对话结尾仍为 input、tool_result 或带工具调用的 assistant 时，同样视为尚未完成的主动轮次，租约过期或失败退避结束后可从中心历史恢复。对每个这样的 Agent 选一台节点：属于同一用户、在线且已同步、报告里有 Runtime、Agent 配置的 provider 处于已登录状态、该节点正在运行的 Runtime 少于上限（默认 4）。默认设备满足条件时选默认设备，否则按注册顺序选第一台。

**取得租约。** 一个事务里锁定 `project_agents` 行，确认租约为空或已过期，`lease_epoch` 加一，写 `lease_run_id` 和 `lease_until = now() + 60s`，插入 `agent_runs`（`state = starting`）。`dispatch_outbox` 的每一行都绑定 `task_id` 和 `execution_id`，不能直接复用；`agent_runs` 自己记录投递状态，发送循环对处于 `starting` 的运行按 `run_id` 作为稳定消息 ID 重发 `project_run_start`，直到 batond 回执。batond 在本地 SQLite 里按 `run_id` 去重，同一 run 不会启动两个进程。启动前 batond 先执行一次 `probe`：所需 provider 已经不是登录状态时，拒绝启动并更新能力报告，Coordinator 以 `login_required` 结束这次运行，不计入失败次数，扫描会在下一轮选择其他节点。

**续租。** Runtime 进程存活期间，batond 每 20 秒发送一次续租。Coordinator 只在 `(run_id, lease_epoch)` 仍是当前值且未过期时，把 `lease_until` 延长到 `now() + 60s`。batond 按单调时钟计时：从最后一次续租成功起超过 58 秒仍未续上，就停止 Runtime 进程。租约过期后，旧实例的任何请求都返回 `lease_lost`，Runtime 收到后立即退出。

**停止。** Project 被暂停或归档、运行所在节点被吊销、员工在界面上停止运行时，Coordinator 作废租约（`lease_epoch` 不变，清空 `lease_run_id`），并向节点发送 `project_run_stop`。batond 收到后停止 Runtime。即使停止消息没有送达，旧实例的下一次请求也会因租约失效被拒绝。

**唤醒。** 新的主动输入写入后，如果该 Agent 有有效运行，Coordinator 向其节点发送 `project_run_wake`，batond 转给 Runtime。通知可能丢失；Runtime 在每轮结束时都会主动领取一次，所以丢失通知最多延迟到下一轮或闲置期结束。

**Runtime 主循环。**

1. `bootstrap`：取回 Agent 配置、最新 `compaction` 事件和读取起点；再用 `read_events` 从起点开始逐页读取，每页最多 128 KiB，直到读到 `next_seq`。读完后构造发给模型的消息列表（第 6.1 节）。两次压缩之间的对话可以超过 1 MiB，一次响应放不下，所以分页。
2. 检查结尾，必要时恢复（第 5 节）。
3. `claim_inputs`：Coordinator 在一个事务里锁定 Agent 行并校验租约，按 `id` 顺序领取一批待处理条目，拼成一条 `input` 事件写入，并在同一事务里给这些条目写上 `delivered_seq`。规则如下：
   - 没有待处理的主动输入时返回空，Runtime 进入闲置等待；被动输入留在队列里。
   - 有主动输入时，按 `id` 顺序依次加入条目；再加一条就会超过 20 条或累计 payload 128 KiB 时停止，第一条总是加入。剩下的留给下一轮。
   - 同一条记忆有多条待处理的 `memory_updated` 时，只把版本号最大的一条写进 `input`，其余一起标为已投递。

   每条输入在写入时已经限长，所以一批不会超过事件上限。这个上限只针对传输：128 KiB 约合 3～4 万个 token，低于常见窗口的压缩阈值；上下文用量由第 6.2 节单独检查。
4. 把 `input` 消息交给 Agent。模型回复的 assistant 消息在 `message_end` 监听器里通过 `append_event` 保存；保存返回之前，pi-agent-core 不会执行工具。
5. 每个工具调用通过 `call_tool` 交给 Coordinator 执行（第 7 节），Coordinator 在同一事务里写入 `tool_result` 事件。工具设为顺序执行（`toolExecution: "sequential"`），结果事件的顺序和调用顺序一致。
6. 模型给出不含工具调用的回复后，这一轮结束，回到第 3 步。
7. 闲置 180 秒内没有新输入，或单次运行满 15 分钟，就进入收尾：需要时压缩（第 6.3 节），然后调用 `finish`，Coordinator 清空租约并记录结束原因，batond 停止进程。

输入队列没有单独的「已处理」确认。一条输入写进 `input` 事件，就已经成为对话的一部分；之后这一轮有没有做完，从对话结尾就能判断。这样省掉了「已领取但未确认」的中间状态。

每次 `append_event`、`call_tool`、`compaction` 写入都带上 Runtime 看到的最后一个 `seq`。和 `conversations.next_seq` 对不上时，Coordinator 拒绝写入，防止两个实例的写入交错导致对话分叉。

### 5. 崩溃恢复与失败

`bootstrap` 之后，Runtime 按对话结尾决定下一步：

| 结尾 | 含义 | 处理 |
|---|---|---|
| `assistant`，没有工具调用 | 上一轮已完成 | 正常领取输入 |
| `assistant`，有工具调用但缺少部分 `tool_result` | 在执行工具时崩溃 | 对缺少结果的每个调用重新发 `call_tool`，使用原 `tool_call_id`；再调用 `continue()` |
| `input` 或 `tool_result` | 模型回复还没保存就崩溃 | 调用 `continue()`，重新请求模型 |
| `compaction` | 压缩后退出 | 正常领取输入 |

重新发出的 `call_tool` 不会重复产生副作用：如果该 `tool_call_id` 已有 `tool_result`，Coordinator 直接返回已保存的结果；如果没有，说明原来的事务没有提交，副作用也没有发生，这次正常执行。这依赖第 7 节的规则：除 `nodes.exec` 外，所有工具的副作用和 `tool_result` 在同一个事务里提交。`nodes.exec` 的副作用发生在另一台设备上，它靠任务的唯一性保证只执行一次（第 10 节）。

模型请求失败时，Runtime 在本次运行内重试 3 次，间隔 5、15、45 秒。仍然失败就调用 `report_failure`，Coordinator 把 `failure_count` 加一，设置 `next_attempt_at`（依次推迟 1、5、15 分钟），本次运行结束。`failure_count` 达到 3 时，对话进入 `needs_attention`，扫描不再放置它，界面显示最后的错误。用户通过 `POST /api/v1/projects/{id}/retry` 确认重试后清零，对话回到 active。`POST /api/v1/projects/{id}/stop` 作废当前租约并结束这次运行；未领取的主动输入仍可在后续扫描时触发新的运行。这两个接口沿用员工会话、同源和 CSRF 校验，正文为 JSON `{}`，拒绝未知字段和查询参数，成功返回 `200 {"ok":true}`，其他员工的 Project 返回 404。任何一次 assistant 消息保存成功都会把 `failure_count` 清零。失败的模型输出不写入对话，避免把错误内容带进后续上下文。

订阅需要重新登录、设备全部离线这类情况不算失败，不增加 `failure_count`。它们体现为放置时找不到合格节点，界面显示等待原因。

### 6. 上下文与压缩

#### 6.1 发给模型的内容

Runtime 按以下顺序构造请求：

1. 系统提示词，由 `prompt_version` 决定。内容包括角色说明、Project 标题和目标、工具使用规则。不包含时间、设备名或其他每次会变的信息。Runtime 将 `{version,title,goal}` 快照保存在 assistant payload 的 `prompt` 字段，恢复时复用最早保留的快照；压缩生成器将新快照保存到 compaction payload 的 `prompt` 字段。该元数据不进入 pi-ai 消息正文。
2. 工具定义，顺序固定。
3. 最新 `compaction` 事件生成的开头消息（如果有）。
4. `compaction.through_seq` 之后的全部事件，按 `seq` 排列；被清除的工具结果替换为占位文字。

同样的事件总是生成同样的消息列表，换设备、换进程都一样。系统提示词或工具定义的版本变化会使缓存失效，属于预期行为。Agent 的 `sessionId` 使用对话 ID，跨设备不变。

Project 标题或目标被修改后，新的系统提示词从下一次压缩起才生效。在此之前，Coordinator 在修改的事务里写一条 `project_updated` 被动输入，内容是新的标题和目标，随下一批主动输入告诉模型。这样标题改动不会让整段上下文的缓存失效，也不会为了这个改动单独启动一次运行。

#### 6.2 压缩什么时候发生

| 时机 | 条件 | 说明 |
|---|---|---|
| 运行收尾 | 上下文用量超过窗口的 50% | 最常见的情况。此时缓存刚用过，压缩请求能命中缓存 |
| 每次请求前（`prepareRequest`） | 上下文用量超过窗口的 80% | 单轮里工具调用很多时的保护 |

上下文用量取最近一次 assistant 消息 usage 里的输入 token 总数，加上之后新增内容的估算值（按 4 个字符约 1 个 token）。阈值是初始值，可以配置。

#### 6.3 压缩过程

1. **清除旧工具结果。** 最近 3 轮以前的 `tool_result` 内容替换成占位文字：`[工具结果已清除，原文为第 123 条。需要时用 history.read 读取，或重新调用工具获取最新状态]`。这一步不调用模型。按 PA-18，清除后的信息都能重新拿到。清除后用量降到窗口的 40% 以下，就到此为止。
2. **生成摘要。** 把最早的一段对话换成摘要。范围从上一次压缩的 `through_seq` 之后开始，到保留部分之前结束；保留部分是最近 2 轮，并且至少占窗口的 15%。切点不会把一条 assistant 消息和它的工具结果分开。摘要请求和上一次正常请求使用同样的模型、系统提示词、工具定义和消息前缀，只在最后追加一条 user 消息作为压缩指令，并设置 `toolChoice: "none"`。这样前缀能命中缓存，只有指令和摘要输出需要全价计算。这是 DSH `compaction-basic` 的做法；Pi 默认的 `generateSummary()` 使用单独的系统提示词，命中不了缓存，所以不采用。
3. **写入。** 把 `through_seq`、摘要、被清除的工具结果序号和当时的记忆索引（记忆条目标题列表，最多 2 KiB）一起写成一条 `compaction` 事件。

压缩指令针对协调角色编写，要求摘要保留：用户的目标和偏好、做过的决定及理由、派出的任务（任务 ID、目标设备、当前状态）、尚未完成的事项。上一次的摘要也在被压缩的范围里，指令要求把它和新内容合并成一份，不逐字照抄。

压缩后，第 6.1 节第 3 项的开头消息内容如下，第一行由程序生成：

```text
[程序说明] 以下摘要替换了第 1～{through_seq} 条对话。原文可用 history.read 按序号读取，history.search 按关键字搜索。
<项目记忆索引>…</项目记忆索引>
<对话摘要>…</对话摘要>
```

范围说明由程序根据 `through_seq` 生成，不依赖摘要模型去保留。压缩总是从最早的历史开始，所以每次的范围都包含上一次的范围。清除占位里的序号即使在摘要里丢失，也仍落在这个范围内，可以按关键字找回。

视图构造负责让消息角色顺序符合各 provider 的要求，例如开头消息和保留部分的第一条 `input` 相邻时合并成一条 user 消息。

#### 6.4 项目记忆不放进前缀

项目记忆可能在一轮中被修改。如果把它放进系统提示词，每次修改都会让缓存失效。所以系统提示词只告诉模型有哪些记忆工具；记忆索引在每次压缩时写进开头消息，平时通过 `memory.search` 和 `memory.read` 获取。

两次压缩之间的记忆修改有两种来源。Project Agent 自己用 `memory.write` 修改时，结果已经以工具结果的形式出现在对话里，不再发通知。用户在界面上新建或修改记忆时，Coordinator 在保存新版本的同一个事务里写一条 `memory_updated` 被动输入，`source_key = memory:{entry_id}:rev:{revision}`，内容是记忆 ID、标题、版本号和「由用户修改」。正文不放进通知，Project Agent 需要时用 `memory.read` 读取。

这条通知不触发运行：用户改一条记忆，不值得为此启动 Runtime、花一次模型调用。它随下一批主动输入交给模型，所以 Project Agent 在处理用户下一条消息或下一个任务结果时，一定已经知道记忆变了。Project Agent 正在运行时，通知同样等到下一轮。本期没有删除记忆的功能；以后增加时，删除也走这条通知。

### 7. 工具

| 工具 | 类型 | 作用 | 输出可以从哪里重新拿到 |
|---|---|---|---|
| `memory.search` | 只读 | 按关键字搜索记忆标题和正文，最多 20 条 | 自身 |
| `memory.read` | 只读 | 读取一条记忆的当前版本 | 自身 |
| `memory.write` | 写入 | 新建或修改一条记忆，带 `expected_revision`，冲突时返回当前版本 | `memory.read` |
| `history.search` | 只读 | 在主对话原文里按关键字搜索，返回序号和片段 | 自身 |
| `history.read` | 只读 | 按序号范围读取原文 | 自身 |
| `devices.list` | 只读 | 列出本人设备、在线状态和能力报告 | 自身 |
| `tasks.dispatch` | 写入 | 派发一个任务，参数见第 9 节 | `tasks.list`、`tasks.get` |
| `tasks.list` | 只读 | 列出本 Project 的任务，可按状态筛选 | 自身 |
| `tasks.get` | 只读 | 读取一个任务的状态、结果和证据 | 自身 |
| `tasks.cancel` | 写入 | 请求取消本 Project 的一个任务 | `tasks.get` |
| `nodes.exec` | 写入 | 在开启了命令执行的节点上执行一条命令，参数见第 10 节 | `tasks.get` |
| `inbox.ask` | 写入 | 创建一个请用户处理的事项（Agent Inbox IB-01） | `inbox.list`、`inbox.get` |
| `inbox.list` | 只读 | 列出本 Project 的事项及其状态 | 自身 |
| `inbox.get` | 只读 | 读取一个事项的完整内容和处理结果 | 自身 |
| `inbox.withdraw` | 写入 | 撤回一个待处理事项，必须写明原因 | `inbox.get` |

单个工具输出不超过 32 KiB，超出时返回截断标记和继续读取的方式。

每个 `call_tool` 请求包含 `tool_call_id`、工具名和参数。Coordinator 在一个事务里依次：校验租约；确认这个 `tool_call_id` 出现在对话最后一条 assistant 消息里，且还没有对应的 `tool_result`；执行工具，包括写入类工具的业务变更；把结果写成 `tool_result` 事件。参数不合法或业务拒绝时，也写一条 `is_error` 的结果，同一个调用不会被反复尝试。`nodes.exec` 是唯一的例外：事务里只接受任务，`tool_result` 在等待结束后写入（第 10 节）。

「`tool_call_id` 必须出现在已保存的 assistant 消息里」这条检查，保证每个工具调用在执行前都已经落盘。崩溃恢复时，Runtime 看到的工具调用和 Coordinator 执行过的工具调用总是一致的。

工具执行时，用户、Project 和运行身份都取自运行记录，参数里的同名字段不参与授权。

#### 工具调用协议

`call_tool` 使用 `tool_call_id`、`tool_name`、`arguments`、`last_seq`，成功返回已保存的 `Event`，其中 `kind=tool_result`，`payload.message` 是 pi-ai `toolResult`（`toolCallId`、`toolName`、`content`、`isError`、`timestamp`）。名称和参数必须与已保存的 assistant `toolCall` 一致。同一消息内按调用顺序执行；工具 ID 在整个对话内唯一。已有结果优先返回，调用方可以在响应丢失后使用原 ID 重试。参数和业务拒绝以 `isError=true` 保存，数据库等内部异常回滚整个事务。

本期工具参数如下，未列出的字段会被拒绝。员工、Project、运行身份与 `source_seq` 由中心填写。

| 工具 | 参数 |
|---|---|
| `memory.search` | 可选 `query`、`after_id` |
| `memory.read` | `entry_id`；可选 `revision`，省略时读取当前版本 |
| `memory.write` | `title`、`content`、`expected_revision`；可选 `entry_id`，新建时可由中心生成 |
| `history.search` | 可选 `query`、`after_seq`、`through_seq` |
| `history.read` | 可选 `after_seq`、`through_seq`，读取 `(after_seq, through_seq]` |
| `devices.list` | 可选 `after_id` |
| `tasks.dispatch` | 第 9 节的五个必需字段；可选 `queue_timeout_seconds`、`execution_timeout_seconds`、`retry_of_task_id` |
| `tasks.list` | 可选 `status`、`after_id` |
| `tasks.get` | `task_id`；可选 `version`，变化时拒绝旧版本续读 |
| `tasks.cancel` | `task_id` |

只读工具还接受 `offset`、`max_bytes`。结果采用 `{encoding:"json", text, offset, total_bytes, truncated, next_offset?}`：先把完整业务结果编码为 JSON，再按 UTF-8 字节取片段。调用方在 `truncated=true` 时以同样的业务参数和 `next_offset` 继续读取，拼接 `text` 后解析 JSON。`max_bytes` 默认 16 KiB、最大 32 KiB；中心按实际 JSON 编码后的容量进一步缩短片段，整个工具结果 payload 不超过 32 KiB。记忆续读可固定 `revision`，任务续读可固定 `version`。

搜索和列表每页最多 20 条，业务 JSON 中用 `next_after_id` 或 `next_after_seq` 继续取得下一组；空列表表示结束。`history` 返回 `through_seq`，默认固定为本次工具调用的 assistant 序号，后续读取应保持该值，避免把续读过程新产生的事件加入范围。`history.read` 保留原事件 JSON，包括已压缩的原文。`memory.search` 返回标题、版本和正文片段，全文由 `memory.read` 取得；`tasks.list` 返回任务标识、状态、版本与描述片段，完整记录由 `tasks.get` 取得。

写工具返回资源 ID、版本或状态及 `read_tool`。记忆冲突返回当前版本和内容，超限时返回截断标记及 `memory.read` 入口。`tasks.dispatch` 的重派关联保存在现有的 `task_relations.rerun_of_task_id` 中。


`inbox.ask` 的展示内容是最多 32 KiB 的 Markdown，链接只允许 `https`；Coordinator 在工具事务内检查长度、链接、选项声明、关联任务归属及 10 个待处理提案上限，不合规时保存 `is_error` 结果。工具参数和事项事务见 [Agent Inbox TECH](../agent-inbox/TECH.md) 第 3、4 节。OpenUI Lang、组件库和 Runtime 解析推迟到第一个版本之后。

### 8. 节点能力报告

batond 在连接时和能力变化时上报 `node_runtime_reports.report`，结构如下：

```json
{
  "project_runtime": {
    "version": "0.1.0",
    "providers": [{ "provider": "openai-codex", "status": "available" }]
  },
  "exec": { "enabled": true, "shell": "zsh" },
  "roots": [{ "root_id": "dev", "path": "/Users/asa/src" }],
  "repos": [{ "path": "/Users/asa/src/baton", "origin": "github.com/hhubb22/baton" }]
}
```

`exec.enabled` 来自 batond 本地配置里的「允许 Project Agent 执行命令」开关，默认关闭；`exec.shell` 是该节点执行命令使用的 shell。`roots` 来自用户在节点上授权的目录，沿用现有 `batond files` 的登记。`roots` 上报真实路径，因为任务的 `working_directory` 本来就是目标节点上的路径；Web 文件浏览仍只用 `root_id` 和相对路径。`repos` 是在授权目录内有限深度扫描得到的 Git 仓库，上报路径和去掉凭据的 origin，不上传文件内容。`provider.status` 为 available / login_required / unknown，凭据不离开设备。

`devices.list` 把这些报告交给 Project Agent，它据此选择工作目录。

PA-W02 通过现有 Gateway 的控制队列传送 `node.runtime_report`，正文为 `{ "type": "node.runtime_report", "report": { ... } }`。Coordinator 返回 `node.runtime_report_result`，含 `ok`、成功时的 `report_version` 或失败时的 `code`，信封 `correlation_id` 对应请求的 `message_id`。节点在 `node.sync` 成功后发送报告；未收到成功回执时，在同一进程的连接重试中保留原消息标识和报告内容；采集到的新内容在待确认报告成功后发送。重连后重新发送报告，已确认的报告使用新消息标识。回执只作用于发送该报告的当前连接，旧连接迟到的回执不能确认新连接上的报告。中心只接受当前已同步、未吊销连接的报告，并在事务内再次检查员工、节点、凭据和连接。`report_version` 从 1 开始，报告内容变化时加一；相同内容的重发只刷新 `reported_at`。这些写入不修改 `nodes.capabilities`。

节点每轮采集完成后等待 5 秒再采集，连接建立时也请求刷新。采集在独立循环中串行运行，连接、心跳和 Worker 消息不等待扫描。每轮预算 2 秒；文件系统调用返回后检查期限，无法被操作系统取消的文件系统等待最多占用一个采集协程，重连不另起扫描。扫描只保存登记目录、仓库路径及 origin；目录文件内容不进入报告。

扫描最多向下 4 层（登记根为第 0 层）、读取 4096 个目录条目、记录 128 个仓库。每批读取至多 64 个条目，不跟随遍历中的符号链接，不进入 `.git`。Git 配置最多读取 16 KiB，通过 `git config --no-includes --file - --get remote.origin.url` 解析，每次最多 200 ms，不读取 include 或全局配置。worktree 的 `.git` 和 `commondir` 只允许指向同一登记根内的元数据；指向根外时仍登记仓库路径，省略 origin。origin 仅保留主机和仓库路径，去掉用户信息、端口、查询和片段，忽略本地路径及不支持的传输格式。扫描、读取或容量受限时报告带 `truncated: true`；超出报告容量时先移除末尾仓库，再移除末尾目录。发送前采用带缩进的 JSON 计量，给 PostgreSQL `jsonb::text` 的空格留出余量，报告和数据库文本均不超过 64 KiB。

`batond project-exec --enabled=true|false [--shell 路径] [--data-dir 目录]` 原子保存本机 `project-exec.json`。必须显式给出开关，初始值为关闭；默认 shell 在 Windows 为 `pwsh`，其他系统采用 `SHELL`，未设置时为 `/bin/sh`。配置损坏或权限检查失败时上报关闭。该命令只维护配置，执行命令的 Worker 由后续工单实现。

`baton-project-runtime probe` 的 stdout 契约是一个 JSON 对象：`{ "version": "0.1.0", "providers": [{ "provider": "openai-codex", "status": "available" }] }`。状态只接受 `available`、`login_required`、`unknown`，最多 32 个 provider，名称和版本不超过 128 个 ASCII 字符（字母、数字、点、下划线、加号、连字符）。batond 每轮调用一次 `probe`，时限 1 秒，stdout 缓冲最多 16 KiB，丢弃 stderr；拒绝未知字段、尾随数据和超限输出。Runtime 未安装、probe 失败或输出无效时省略 `project_runtime`，不复用旧登录状态。PS-154 使用契约测试程序验证调用边界，Runtime、登录及真实 provider 验证由 PS-158 完成。

### 9. 派发任务与结果回收

`tasks.dispatch` 的参数：`target_node_id`、`agent_type`、`working_directory`（目标节点上的路径，沿用现有任务字段，目录必须已经存在）、`description`、`expected_outputs`、可选的期限，以及可选的 `retry_of_task_id`。`agent_type` 不能是 `shell`，命令只能通过 `nodes.exec` 执行。

Coordinator 在 `call_tool` 的同一个事务里调用任务接受逻辑，`request_id` 固定为 `pa:{conversation_id}:{tool_call_id}`，并写入 `project_id`、`origin_conversation_id`、`origin_tool_call_id`。现有 `acceptOnce` 自己开启事务，需要拆出一个接受外部事务的版本，原有调用方式保持不变。锁顺序为：`project_agents` 行 → `conversations` 行 → `tasks` → `executions`。现有路径不锁前两者，所以不会与现有的「先 tasks 后 executions」形成环。

带 `retry_of_task_id` 时，原任务必须属于同一 Project，并且状态是已确认失败或已取消；处于待核实状态的任务不能这样重派，仍需用户按 Baton R-20 确认。新旧任务的关系写进 `task_relations`。

任务进入终态的那个事务（执行报告、到期处理、人工核实）里，如果任务的 `origin_conversation_id` 不为空，就向输入队列插入一条 `task_result`：`source_key = task:{task_id}:result:{task_version}`，冲突时忽略，内容按第 3 节限长。人工修正结果会提高任务版本，因此形成一条新的输入。这一步只写 `project_agent_input_queue`，不锁 `project_agents`，不改变现有终态处理的锁顺序。

执行 Agent 派生的子任务没有 `origin_conversation_id`，仍按现有父子交付把结果交给父任务（Baton R-14）。

### 10. 在节点上执行命令

`nodes.exec` 用于管理环境，例如创建 worktree、检查仓库状态、安装依赖。Baton 因此不需要实现 worktree、clone 等目录准备逻辑，任务的工作目录只有「已有目录」一种。

开发工作优先交给执行 Agent，这条分工写在系统提示词和 `nodes.exec` 的工具说明里，由模型遵守（PA-03）。Coordinator 和 Worker 不检查命令内容，也不拦截写文件；必要时 Project Agent 可以自己改配置、跑脚本。

**参数。** `node_id`；`command`，一个字符串，交给节点上报的 shell 执行；`working_directory`，命令的工作目录，必须已经存在并位于该节点登记的目录内；`wait_seconds`，Project Agent 最多等待多久，0～600，默认 30；`timeout_seconds`，命令的执行时限，默认 7200。

**实现为一个 Task。** 命令在另一台设备上执行，副作用不可能和 `tool_result` 放进同一个事务。所以 `nodes.exec` 复用现有的任务机制：Coordinator 在 `call_tool` 的事务里接受一个 `agent_type = shell` 的任务，`request_id` 为 `pa:{conversation_id}:{tool_call_id}`，填写 `origin_*` 列；任务和 Execution 的唯一性保证同一个工具调用最多执行一次命令。这一步不写 `tool_result`。目标节点的 `exec.enabled` 为假时，直接写一条 `is_error` 的结果。

**等待。** `call_tool` 返回 `pending` 和任务 ID 后，Runtime 反复调用 `wait_tool(tool_call_id)`，每次最长等 30 秒，直到任务结束或达到 `wait_seconds`。然后 Coordinator 在一个事务里写入 `tool_result`：

- 任务已结束：结果包含退出码、状态和输出。任务进入终态的事务已经按第 9 节插入了输入队列条目，这里把它标记为已投递，`delivered_seq` 指向这条 `tool_result`，避免同一结果出现两次。
- 任务未结束：结果为「仍在执行，任务 ID 为 …，结束后结果会作为新输入送回」。命令继续执行，结束时按第 9 节进入输入队列。

等待结束不终止命令。单次运行的时长上限到达时，Runtime 立即结束等待，按「未结束」写入结果，然后正常收尾。锁顺序为 `project_agents` → `conversations` → `tasks` → `project_agent_input_queue`；终态处理是 `tasks` → `executions` → `project_agent_input_queue`。两者都最后锁输入队列，不会形成环。

**恢复。** Runtime 在等待期间崩溃时，对话结尾是一个没有结果的 `nodes.exec` 调用。恢复时再次 `call_tool`，Coordinator 按 `(origin_conversation_id, origin_tool_call_id)` 找到已有的任务，返回 `pending`，Runtime 继续等待。命令不会再执行一次。

**节点上的执行。** Session Worker 新增一个内置的 `shell` 执行器，不启动 Agent 进程。它沿用启动许可和 `start_intent`：写入 `start_intent` 之后，用上报的 shell 执行命令（例如 `zsh -lc <command>`、`pwsh -NoProfile -Command <command>`），在 POSIX 上使用独立进程组，在 Windows 上使用 Job Object。stdout 和 stderr 合并后保留开头 16 KiB 和结尾 16 KiB，并记录总字节数和退出码。退出码为 0 时任务完成，否则失败，输出都放进结果。取消和超时时终止整个进程组。Worker 在命令执行中崩溃、无法确认进程状态时，任务进入待核实，沿用 Baton R-22。

`shell` 执行器实现 `internal/agent.Adapter`，在 `registeredAdapters` 里注册为 `shell`。`SubmitInput` 执行命令并在结束后返回结果；`DeliverResult` 返回错误，因为命令不会委托子任务；`HistoryContains` 恒为 false，`ReadHistory` 只返回本地保存的输出记录；`Abort` 终止进程组，返回已停止且副作用未知。Worker 恢复时（`Config.Restore`）适配器返回 `agent.ErrHistoryMissing`，命令不会重跑，任务按上一段进入待核实。

Worker 收到 `shell` 任务时，会再检查一次本地的开关，开关关闭就拒绝执行。所以即使 Coordinator 的能力报告过期，未开启的节点也不会执行命令。

**安全。** 命令以设备上的用户身份运行，Baton 不提供沙箱，限定工作目录也挡不住命令访问目录之外的内容。任务结果和仓库内容都可能包含注入的指令，一旦 Project Agent 被诱导，开启了命令执行的设备上可能被执行任意命令。目前的措施只能限制范围：开关默认关闭、按设备单独开启；每条命令和输出都完整记录在对话里；命令只能在已登记的目录下启动。开启开关时，界面要明确说明这些风险。

### 11. 对 Baton 现有规格的影响

- 节点去掉 `pc` / `ubuntu` 角色，默认 PC 改为默认设备。默认设备仍是未指定目标的委托的目标，同时是 Project Agent 优先运行的节点（Baton R-02、R-05、R-06）。
- Project Agent 的对话保存在 Coordinator；执行 Session 的历史仍在节点（Baton R-28、R-29 的修订）。
- 任务沿用现有的 `working_directory`，目录必须已经存在；新目录由 `nodes.exec` 创建（Baton R-15、R-31 的修订）。
- Go 进程仍不嵌入 Agent SDK；`baton-project-runtime` 是独立进程（Baton TECH「技术选择」）。
- 不需要节点直接访问 Coordinator 的数据通道，也不需要会话文件归档：Project Agent 的消息就是普通的对话事件，经现有 Gateway 通道传输。

### 10. 桌面 Web 主对话（PS-159）

`/projects` 提供 Project 列表和创建入口，`/projects/{id}` 展示主对话、记忆、运行状态与任务，支持直接打开、刷新和浏览器前进后退。页面复用现有 React 组件与 `/tasks/{id}` 任务详情，每 2 秒查询中心记录。用户消息在设备离线时仍可提交；尚未领取的消息显示「已入队」。消息响应丢失时，标签页仅保存客户端消息标识，用户可以查询原消息，或补全相同正文后用原标识重发。

界面使用的只读接口：

- `GET /api/v1/projects/{id}/status`：返回 `state`、`waiting_reason`、`pending_inputs`、`last_error`、`next_attempt_at`、`last_seq` 和最近运行的设备、放置原因、有效资格与停止回执。运行、队列和设备事实来自同一只读快照；设备离线或租约失效时不显示有效运行。已失去资格与进程确认退出分别展示。
- `GET /api/v1/projects/{id}/messages`：返回尚未领取的用户消息，按数字 `after_id` 和 `limit` 分页。指定 `client_message_id` 时返回该消息，无论是否已领取，用于恢复发送响应。响应为 `{messages,next_after_id?}`。
- `GET /api/v1/tasks?project_id={id}`：先按员工和 Project 筛选，再分页。任务列表和详情增加 `project_id`、`origin_conversation_id`，供页面标明 Project Agent 来源。任务操作沿用原有接口。

这些接口使用员工会话，只能读取本人员工的 Project；跨员工对象返回 404。消息、记忆和历史按现有分页接口读取。记忆编辑保留打开时的 `expected_revision`，冲突后保留草稿并要求查看最新版本再编辑。

Runtime 的 `preview` 操作通过现有 RPC 发送 `{last_seq,payload:{text,truncated}}` 文本快照，Coordinator 校验运行身份、有效租约和当前序号。文本最多 32 KiB，每秒至多发送一次。Coordinator 内存中每个运行保留最新快照，最多 128 份，30 秒后过期；不保存到对话历史。`status` 只附带当前有效运行、且 `after_seq` 等于当前历史尾部的预览。正式事件保存、运行失效或进程切换后，旧预览不再显示。浏览器将预览、回复与工具内容作为文本渲染，标明预览尚未保存；工具执行仍在完整 assistant 事件保存成功之后进行。

验收测试、截图和命令结果见 [PS-159 验证记录](evidence/ps-159/README.md)。


## Testing and validation

| Requirement | Setup and observation | Failure condition | Where | Status |
|---|---|---|---|---|
| PA-01、PA-02 | 通过 API 创建 Project，检查表结构和响应 | `projects` 或 `project_agents` 出现设备、目录字段 | 单元测试 | planned |
| PA-05 | 重复提交同一 `client_message_id`；同一任务版本重复触发终态处理 | 产生第二条输入 | PostgreSQL 集成测试 | planned |
| PA-05 | 提交 65 KiB 的用户消息；让一个任务的 `summary` 为 300 KiB | 消息被接受；输入队列条目超过 40 KiB；`tasks.get` 读不到全文 | PostgreSQL 集成测试 | planned |
| PA-10 | 20 条任务结果同时待处理，每条 32 KiB | 一次领取超过 128 KiB；出现超过 160 KiB 的事件；有条目没有在后续几轮里领取 | 进程测试，模型替身 | planned |
| PA-12 | 对话在上次压缩后累计 1 MiB 事件，然后重启 Runtime | `bootstrap` 或某页响应超过 192 KiB；分页构造出的消息列表与一次性读取的不一致 | 进程测试 | planned |
| PA-06、PA-07 | 默认设备离线、provider 未登录、全部设备离线三种夹具 | 放置到不合格节点；默认设备被改写；输入过期 | 集成测试，模型替身 | planned |
| PA-08 | 两个调度并发取得租约；暂停 batond 续租使租约过期后恢复 | 出现两个有效运行；旧 epoch 的写入被接受 | 进程测试 | planned |
| PA-10 | 一轮进行中连续写入 5 条输入 | 这 5 条没有在下一轮里一起出现 | 进程测试，模型替身 | planned |
| PA-11、PA-12 | 在 assistant 保存前后、`call_tool` 事务前后、`tool_result` 返回前后杀掉 Runtime | Task 数大于 1；同一 `tool_call_id` 有两条结果；恢复后对话分叉 | 进程测试，故障注入 | planned |
| PA-09 | 模型替身快速回复后不再写入输入；另一组持续写入输入超过 15 分钟 | 闲置 180 秒后没有退出；超过时长上限仍在领取新输入；退出时取消了已派出的任务 | 进程测试 | planned |
| PA-13 | 模型替身持续返回错误 | 重试次数或推迟时间不符；未进入 `needs_attention`；用户重试后不从原位置继续 | 进程测试 | planned |
| PA-14 | 同一对话在 macOS 和 Windows 上各运行一次，记录实际发出的请求 | 两次请求的系统提示词、工具定义或历史消息部分不一致 | 真实 Runtime 和订阅 | planned |
| PA-15、PA-16 | 用超长工具输出和多轮对话越过 50% 阈值 | 收尾时没有压缩；摘要请求的前缀与上次请求不一致；`history.read` 读不到被压缩的原文 | 进程测试；缓存命中用真实订阅观察 usage | planned |
| PA-17 | 模型替身和员工同时修改同一条记忆 | 后写入的一方覆盖了前者而没有收到冲突；修订记录缺失 | 集成测试 | planned |
| PA-17 | Agent 没有运行时用户连续修改同一条记忆 3 次，再修改 Project 标题，然后发一条消息；另一组由模型替身调用 `memory.write` | 只有通知时启动了运行；收到消息的那一轮里缺少通知，或同一条记忆出现多条通知；`memory.write` 产生了通知 | 集成测试，模型替身 | planned |
| PA-21 | 所有节点离线时在浏览器发送消息并查看对话 | 消息未保存；界面显示 Project Agent 正在运行 | Web E2E | planned |
| PA-03、PA-18 | 让模型替身调用不存在的工具，或在任务结果里注入指令 | 调用被执行；工具列表之外出现可用工具 | 单元测试 | planned |
| PA-19 | 派发到不存在的目录，再带 `retry_of_task_id` 派到另一台设备 | 原任务没有明确失败；新任务没有关联原任务；待核实任务被重派 | 进程测试 | planned |
| PA-20 | 执行 Agent 派生子任务；人工修正 Project Agent 任务的结果 | 子任务结果进入 Project Agent 的输入队列；修正后没有新输入 | 集成测试 | planned |
| PA-22 | 对未开启的节点调用 `nodes.exec`；Coordinator 报告显示已开启但节点本地已关闭 | 命令被执行 | 进程测试 | planned |
| PA-22 | 用 `sleep` 命令让执行时间长于 `wait_seconds`；让命令恰好在等待截止时结束 | 命令被中断；结果既没有以 `tool_result` 返回也没有进入输入队列；同一结果出现两次 | 进程测试 | planned |
| PA-22 | 在等待期间杀掉 Runtime；在命令执行中杀掉 Worker | 命令执行了两次；Worker 被杀后任务没有进入待核实 | 进程测试，故障注入 | planned |
| PA-22 | Windows 上执行 PowerShell 命令并在执行中取消 | 子进程在取消后仍然存活 | Windows 原生测试 | planned |
| PA-03 | 模型替身调用 `inbox.ask`，展示内容使用未知组件；Runtime 崩溃后重发同一个调用 | 创建了事项；没有 `is_error` 结果；重发后出现第二个事项 | 进程测试，模型替身 | planned |
| PA-A01 | 三台设备、真实 Runtime、真实订阅跑完整场景 | 见 PRODUCT 验收表 | 实机 | planned |

## Open questions

- Runtime 使用固定版本 Node bundle 随 batond 分发，见第 2.1 节。
- **压缩阈值。** 50% / 80% / 40% 以及保留最近 2 轮、清除 3 轮以前的工具结果，都是初始值，需要用真实对话调整。
- **大小上限。** 用户消息 64 KiB、任务结果条目 40 KiB（文本 32 KiB）、每批 20 条或 128 KiB、事件 160 KiB、`maxTokens` 32000 都是初始值，压测后调整。调整时保持「单条输入上限 ≤ 每批上限 < 事件上限 < 请求上限」。
- **闲置时间。** 180 秒是初始值。闲置期间不调用模型，但进程占内存并占用节点的 Runtime 名额；有了启动耗时、连续输入间隔和内存占用的实测数据后再调整。
