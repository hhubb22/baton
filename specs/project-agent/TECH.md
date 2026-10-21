# Project Agent 技术设计

Status: approved
Owner: Asa
Basis: [PRODUCT.md](PRODUCT.md) PA-01～PA-23；[Agent Inbox 行为规格](../agent-inbox/PRODUCT.md)；[Baton TECH](../baton/TECH.md)。外部依赖版本：Pi `earendil-works/pi@482c138`（各包 1.3.0）、DSH `deepseek-ai/deepseek-harness@687f282`。

## Context

Baton 的执行单位是 Thread：设备上的一个原生 Agent 会话，由 Session Worker 维护消息队列、Turn 边界和回复账本，中心保存 Thread 记录和每条回复（[Baton TECH](../baton/TECH.md)「Thread 与 Turn」）。节点只主动连接 Gateway，单条控制消息上限 256 KiB。

Project Agent 是比 Thread 存在更久的协调者。它的运行位置每次都可能不同，它开的 Thread 结束一轮时它可能不在运行。所以它的对话、记忆和待处理输入都放在 Coordinator，运行时只是一个按需启动的 Runtime 进程。它对 Thread 的操作走和员工相同的 Store 入口，只是操作者记为 Project Agent。

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

`baton-project-runtime` 是一个独立的 Node.js 程序，采用固定版本 Node bundle，随 batond 的安装包分发。设备需要安装 Node.js 22.19.0 或更高版本，才能承载 Project Agent；只运行执行 Agent 的设备不需要 Node.js。batond 负责发现它、上报能力、启动和停止进程、代为续租。Runtime 不直接连 Coordinator，所有请求经本地 IPC 交给 batond，再沿 Gateway 通道送到 Coordinator，复用节点认证。这样不需要为节点新开一条访问 Coordinator 的数据通道。

Gateway 消息类型 `ProjectRuntimeRequest` / `ProjectRuntimeResult`：batond 附上运行身份 `(run_id, lease_epoch)`，Coordinator 校验节点与运行记录一致、租约有效。每个请求和响应不超过 192 KiB，留出信封余量；每条对话事件写入时不超过 160 KiB（第 3 节），所以分页读取每页至少能取到一条。Runtime 经这条通道发出的请求只有下面几种：

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

当前控制消息正文的 `type` 为 `project_runtime.request` / `project_runtime.result`。请求含 `run_id`、`lease_epoch`、`operation`；分页使用 `after_seq` / `max_bytes`，写入使用 `last_seq`，assistant 另带 `client_event_id` 和 `payload`。响应为 `{type, ok, code?, data?}`。`bootstrap` 返回 `{project, prompt_version, memory_index?, compaction?, compaction_seq?, goal_utf8_base64?, after_seq, last_seq}`；配置与最新 compaction 合计超过单帧时，bootstrap 返回 compaction_seq，完整 compaction 随后由 read_events 取回。目标含大量控制字符导致 JSON 转义超过单帧时，bootstrap 的 project.goal 留空，完整目标通过 goal_utf8_base64 以 UTF-8 base64 返回，Runtime 解码后构造配置；Project API 中的原目标保持完整。`read_events` 返回 `{events, last_seq, next_after_seq, has_more}`，默认每页 128 KiB，单条大事件可单独返回，响应仍不超过 192 KiB。`claim_inputs` 返回 `{event?, payload_bytes, input_count}`，要求 `last_seq` 等于当前最后序号；事件 payload 为 `{format:"pi-ai/1", message, input_ids}`，消息的文本块保存输入条目 JSON。调用方收到序号冲突或丢失领取响应时，重新读取中心事件后继续。

batond 启动命令为 `baton-project-runtime run`，工作目录是私有空目录。环境中的 `BATON_PROJECT_RUNTIME_ENDPOINT`、`BATON_PROJECT_RUNTIME_TOKEN`、`BATON_PROJECT_RUN_ID`、`BATON_PROJECT_LEASE_EPOCH` 只用于本次运行。本地 IPC 每个连接发送一条 `{token, request}` JSON，响应为 `ProjectRuntimeResult`；batond 校验 token 后覆盖请求的运行身份，Runtime 不能自行发送续租或启动回执。`poll_wake` 最长等待 25 秒，返回 `{wake:true|false}`；Runtime 闲置时可重复调用。

节点管理请求为 `started`、`renew`、`start_failed`、`exited`、`stopped`、`wake_received`，Runtime IPC 不能调用这些操作。`started` / `renew` 成功返回 `{lease_seconds:60,control_receipts:1}`；能力字段缺失时，batond 沿用旧中心通知方式。`stopped` 只确认已结束运行的进程清理，重复回执幂等；它不能恢复租约或修改对话。进程树回收、本地 IPC 和目录收尾结束后，batond 在 SQLite 保存清理事实，再主动补送 `exited` / `stopped`，失败保留到期重试。暂时写入失败时保留有界本机清理事实继续补写；重启或旧账本缺少清理证据时保持未确认。

启动前先检查 provider，再向中心确认租约；启动意图先写入 SQLite，同一 run 在 batond 重启后不会重启进程。Unix 使用随 batond 管道关闭而停止进程组的守护，Windows 使用关闭时终止整个组的 Job Object。连接重建保留当前 Runtime，续租仍受 58 秒期限限制。期限使用包含系统休眠的单调时钟，最多每秒检查一次；机器唤醒后先核对旧期限，再发送或接受续租。读取时钟失败时停止进程。

控制帧 JSON 采用 UTF-8 编码，容量不包含 HTML 页面转义。每批同时检查数据库规范文本、消息拼接后的传输字节及事件上限，因此含引号、反斜线等字符时可能提前结束一批。Thread 回复文本按 UTF-8 边界保留首尾，并注明原字节数；元数据与 JSON 编码后的条目限制为 40 KiB。长 Project 目标的通知在 4 KiB 内保留首尾并标明截断，完整目标由 Project API 返回。


#### 2.1 Node sidecar 分发与 stdio

Runtime 以带生产依赖与锁文件的 Node bundle 发布，位置为 batond 同目录的 `sidecars/project-agent/`。通用打包工具、manifest 校验、stdio 容量、进程树回收和崩溃后重新启动的职责见 [Node sidecar 约定](../../runtimes/README.md)。`node tools/package-batond.mjs` 构建可分发目录；登录命令见 [Runtime 安装说明](../../runtimes/project-agent/README.md)。

batond 优先使用 bundle，通过 Node 直接运行 manifest 中的入口，要求 Runtime 版本 `0.1.0`、stdio 协议版本 1。没有 bundle 时仍可通过 PATH 发现 `baton-project-runtime`。启动前 `probe` 的版本须匹配。bundle 存在但版本不兼容时拒绝启动。

batond 设置 `BATON_SIDECAR_TRANSPORT=stdio` 后，Runtime 在 stdout 发送 `{id, request}`，在 stdin 接收 `{id, result}`，每个对象占一行 UTF-8 JSON，单帧最多 192 KiB，最多 8 个请求在途。运行身份由专用管道绑定，batond 继续覆盖请求身份。带 token 的本地 IPC 继续兼容。`poll_wake` 可在 payload 中指定 `wait_ms`（1～25000），使 180 秒闲置和 15 分钟上限在最后一次等待时准确结束。

bootstrap 顶层的 `local_wait_protocol:1` 表示 batond 支持按 Thread 版本等待。等待的 payload 为 `{thread_id,after_version,wait_ms}`，仅允许该 run 已从中心响应绑定的 Thread；返回 `{reason:"thread_changed"|"timeout",version}`。版本提示通过 `project_run_wake.thread_updates` 传送，相同版本、旧 epoch 和无关输入不唤醒等待者。版本缓存与广播通道由同一互斥区保护，每个 run 最多保留 64 个绑定，工具结果返回后释放。普通闲置 `poll_wake` 继续使用原有通用通知。

`call_tool` 的请求字段为 `tool_call_id`、`tool_name`、`arguments` 和 `last_seq`，成功返回保存的 `tool_result` Event。工具定义见第 7 节，工具状态不存于本地控制目录。

Runtime 的登录由用户在设备上执行 `baton-project-runtime login <provider>` 完成，走 pi-ai 的 OAuth 流程。凭据存在 Runtime 自己的数据目录，文件权限沿用 batond 的私有文件约定。`baton-project-runtime probe` 只读取凭据状态并返回各 provider 是否已登录，不发送推理请求；batond 用它生成能力报告。

Runtime 进程的工作目录是一个空的控制目录。pi-agent-core 本身不加载 AGENTS.md、skills、扩展或 MCP，Runtime 也不启用这些功能，工具只有第 7 节列出的那些。

### 3. 数据模型

表都带 `employee_id`，跨表引用使用包含 `employee_id` 的复合外键，沿用现有归属检查方式。

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

`threads` 带可空列 `project_id`、`origin_conversation_id`、`origin_tool_call_id`，后两列唯一。只有 Project Agent 新建的 Thread 填写这三列；员工新建的 Thread 三列都为空。`thread_turns.initiator` 记录这一轮由员工还是 Project Agent 开启，Project Agent 开启时另记 `origin_tool_call_id`。

输入队列是 Coordinator 内部的数据，用户界面上的待办事项不用这张表。事项表由 Agent Inbox 的技术设计定义。Thread 路径的 `source_type` 有六种，分成两类。与旧任务路径并存期间，队列还保留主动的 `task_result` 和被动的 `user_task_result`；现有任务工具继续使用它们。

| source_type | 类别 | 来源 | payload 上限 |
|---|---|---|---|
| `user_message` | 主动 | 用户在主对话发送的消息，API 拒绝超过 64 KiB 的消息 | 64 KiB 正文加元数据 |
| `thread_reply` | 被动 | Project Agent 开启的一轮里，Agent 的一条回复（第 9 节） | 40 KiB |
| `turn_ended` | 主动 | Project Agent 开启的一轮结束；shell Thread 的这一条带命令输出（第 9、10 节） | 4 KiB；带命令输出时 72 KiB |
| `attention_answer` | 主动 | 用户回答或关闭一个事项（Agent Inbox IB-12），内容是事项 ID、标题、选中的选项和最多 4 KiB 的文字；上限包含 JSON 转义 | 32 KiB |
| `memory_updated` | 被动 | 用户在界面上新建或修改记忆（第 6.4 节） | 1 KiB |
| `project_updated` | 被动 | 用户修改 Project 标题或目标（第 6.1 节） | 4 KiB |

主动输入会触发放置和唤醒；被动输入只记录变化，等下一批主动输入一起交给模型（第 4 节）。`thread_reply` 条目包含 Thread ID、Turn 序号、回复序号、正文和附件，正文超过 32 KiB 时保留开头和结尾，并注明原长度和「完整内容用 `threads.read` 读取」。这些上限在写入时检查，所以每一条都能放进一次领取。

`conversation_events.kind` 有四种：

| kind | payload | 写入方 |
|---|---|---|
| `input` | 一条 pi-ai user 消息，内容由本轮领取的输入队列条目拼成；附带这些条目的 ID | Coordinator，在领取输入的事务里 |
| `assistant` | 一条 pi-ai assistant 消息，原样保存，包括 thinking 签名、usage、stopReason | Runtime |
| `tool_result` | 一条 pi-ai toolResult 消息 | Coordinator，在执行工具的事务里 |
| `compaction` | `through_seq`、摘要文本、被清除的工具结果序号、记忆索引 | Runtime 生成，Coordinator 校验后写入 |

每条事件的 payload 不超过 160 KiB。`input` 由领取规则保证；`tool_result` 受单个工具输出 32 KiB 的限制；`assistant` 和 `compaction` 由 Runtime 把每次请求的 `maxTokens` 设为 32000 来控制，仍然超出时按模型请求失败处理（第 5 节），这条输出不保存，也没有执行其中的工具调用。

用户消息队列的 payload 为 `{"content":"正文"}`，来源键为 `user:{client_message_id}`，摘要为正文 UTF-8 字节的 SHA-256。同一来源键与相同正文返回原始队列 ID 和创建时间，不同正文返回冲突。正文上限为 64 KiB，另检查数据库中 jsonb 规范文本的 72 KiB 上限，超限返回 413。接收消息不检查设备在线状态，也不生成 `input` 事件；领取事务负责生成事件。

记忆修改先锁条目，再读取当前修订。`expected_revision=0` 用于创建；已有条目的版本不匹配时返回 409、`current_revision` 和当前记忆全文。新修订与条目当前版本在同一事务内提交，修订不可更新或删除。员工 API 固定写 `author=user`；Agent 工具必须先校验运行身份，再以 `author=agent` 调用同一存储入口，`source_seq` 必须属于本 Project 主对话。

对话事件 payload 采用 pi-ai 的消息 JSON，并标注 `format: "pi-ai/1"`。这是为了让 assistant 消息原样往返：Anthropic 的 thinking 签名、OpenAI Responses 的 reasoning 内容都要原样发回，Baton 自己的中立格式很难保证不丢字段。代价是 Web 端渲染和 `history.search` 需要理解 pi-ai 的消息结构（text、thinking、toolCall 几种内容块）。将来更换 Runtime 时，需要一个从 `pi-ai/1` 转换的适配器，本期不做。

### 4. 运行流程

**放置。** Coordinator 每秒分页选择需要回收或放置的 Agent，每次最多 32 个；健康且租约有效的运行不占候选额度。待放置 Project 为 active、对话为 active 且已过 `next_attempt_at`、有待处理的主动输入、租约为空或已过期。只有被动输入时不放置。上次运行已领取输入但对话结尾仍为 input、tool_result 或带工具调用的 assistant 时，同样视为尚未完成的主动轮次，租约过期或失败退避结束后可从中心历史恢复。对每个这样的 Agent 选一台节点：属于同一用户、在线且已同步、报告里有 Runtime、Agent 配置的 provider 处于已登录状态、该节点正在运行的 Runtime 少于上限（默认 4）。默认设备满足条件时选默认设备，否则按注册顺序选第一台。

**取得租约。** 一个事务里锁定 `project_agents` 行，确认租约为空或已过期，`lease_epoch` 加一，写 `lease_run_id` 和 `lease_until = now() + 60s`，插入 `agent_runs`（`state = starting`）。`agent_runs` 自己记录启动和停止命令的投递进度。start、stop、wake 分别领取，每类每秒最多 32 条、每节点最多两条，节点额度在全局 LIMIT 前应用。领取先保存下一次尝试时间，再向 Gateway 入队，按最多 30 秒的抖动退避重试；发送循环不等待回包。处于 `starting` 的运行以 `run_id` 为稳定消息 ID 重发 `project_run_start`，直到 batond 回执。batond 在本地 SQLite 里按 `run_id` 去重，同一 run 不会启动两个进程。启动前 batond 先执行一次 `probe`：所需 provider 已经不是登录状态时，拒绝启动并更新能力报告，Coordinator 以 `login_required` 结束这次运行，不计入失败次数，扫描会在下一轮选择其他节点。

**续租。** Runtime 进程存活期间，batond 每 20 秒发送一次续租。Coordinator 只在 `(run_id, lease_epoch)` 仍是当前值且未过期时，把 `lease_until` 延长到 `now() + 60s`。batond 按单调时钟计时：从最后一次续租成功起超过 58 秒仍未续上，就停止 Runtime 进程。租约过期后，旧实例的任何请求都返回 `lease_lost`，Runtime 收到后立即退出。

**停止。** Project 被暂停或归档、运行所在节点被吊销、员工在界面上停止运行时，Coordinator 在同一事务作废租约（`lease_epoch` 不变，清空 `lease_run_id`）并保存停止意图，独立发送 `project_run_stop`。batond 收到后停止 Runtime，已结束的运行补送原清理确认。自然 `finish` / `report_failure` 给节点 2 秒主动清理确认宽限；其他停止立即到期。只有 `stopped` 回执确认清理，业务终态和新运行租约保持不变。停止重试只查询待确认索引，不与 start / wake 共用批次。即使停止消息没有送达，旧实例的下一次请求也会因租约失效被拒绝。

**唤醒。** 主动输入与业务变化同事务保存 `wake_required` 和到期时间，来源去重不重新打开通知。有效 running run 的每条 `project_run_wake` 最多包含 32 个 `input_ids`，并从这些输入构造 `thread_updates`。batond 合并通用唤醒和 Thread 版本后，通过容量 64 的异步回执队列发送 `wake_received`；队列满或回执丢失时由中心退避重发。接收确认只按本条消息的输入 ID 清除通知需求，不设置 `delivered_seq`，不追加对话事件，也不续租。同一轮执行期间，新消息可以保持未认领且已停止重复通知。

新 run 在 Agent 锁下重新提示全部未认领主动输入，旧 run 的迟到回执不能清除新 run 的通知。通知确认不使用 sequence 最大值作为提交水位。只有被动输入时不发送 wake。Runtime 每轮结束主动领取，`nodes.exec` 的等待仍有最多 25 秒本地等待后的持久状态补读；通知不代替业务结果。完整字段和故障恢复规则见[控制面调度设计](../control-dispatch-reliability/TECH.md)。

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
| `compaction` | 轮内或收尾压缩后退出 | 查看最后一条非压缩事件，仍为未完成轮次时继续恢复，否则领取输入 |

重新发出的 `call_tool` 不会重复产生副作用：如果该 `tool_call_id` 已有 `tool_result`，Coordinator 直接返回已保存的结果；如果没有，说明原来的事务没有提交，副作用也没有发生，这次正常执行。这依赖第 7 节的规则：所有工具的中心状态变化和 `tool_result` 在同一个事务里提交，`nodes.exec` 的等待结果除外。`threads.create`、`threads.send` 和 `nodes.exec` 的副作用发生在设备上，事务里只保存 Thread 和消息意图，靠 `client_message_id` 的唯一性保证只发出一次（第 9、10 节）。

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
| 运行收尾 | 上下文用量超过窗口的 50% | 利用本次运行的历史生成摘要；相同请求前缀有机会复用尚有效的缓存 |
| 每次请求前（`prepareRequest`） | 上下文用量超过窗口的 80% | 单轮里工具调用很多时的保护 |

上下文用量取最近一次有效 assistant 的 `totalTokens`，缺少时累加 `input`、`output`、`cacheRead`、`cacheWrite`，再加之后新增内容的估算值（按 4 个字符约 1 个 token，并计入消息开销和工具定义）。模型不一致、没有有效 usage 或最近一次 usage 早于最新压缩时，按当前完整视图重新估算。请求前和收尾阈值还受「窗口减去回答预算」限制，回答预算为模型输出上限与 32000 的较小值。阈值和保留预算由 Runtime 的 `CompactionSettings` 定义，可通过构造参数覆盖；CLI 使用默认值。

#### 6.3 压缩过程

1. **清除旧工具结果。** 默认只选择最近 3 批输入以前、已有后续 assistant 分析、内容估算超过 8192 字符的 `tool_result`，替换成占位文字：`[工具结果已清除，原文为第 123 条。需要时用 history.read 读取，或重新调用工具获取最新状态]`。最近尚未分析的结果保留。这一步不调用模型，清除集合立即通过 `commit_compaction` 保存；没有摘要时 `through_seq=0`、`summary=""`，视图不添加空摘要消息。后续清除沿用旧摘要和提示词快照。按 PA-16，清除后的信息都能重新拿到。清除后用量降到窗口的 40% 以下（且满足回答预算），就到此为止。
2. **生成摘要。** 把最早的一段对话换成摘要。优先保留最近 2 批输入对应的对话，并保留至少占窗口 15% 的最近内容；单轮或最近几轮过长、没有可用切点时，允许在已完成的工具批次之间切分。切点不会把一条 assistant 消息和它的工具结果分开，也不会吞掉最后一个保留单元。摘要请求沿用原模型、系统提示词、工具定义、消息格式、provider 签名与 `sessionId`，重放待压缩的消息前缀及旧摘要，在最后追加一条 user 压缩指令，并设置 `toolChoice: "none"`。这参考 DSH 的前缀复用方式；Pi 的默认摘要器把旧对话序列化成文本，使用独立系统提示词，无法沿用原对话的整段缓存前缀。实际命中取决于 provider、路由和缓存有效期，工具结果清除也会影响前缀。恢复的历史已超过窗口时，先选择一次摘要请求能容纳的较短前缀，并为输出留出容量；一次检查最多执行 3 次有效缩减。
3. **验证并写入。** Runtime 拒绝空白、被截断、含工具调用或非文本输出的摘要，检查完整模型视图的估算用量确实下降，并检查事件 JSON 容量。`commit_compaction` 带 `last_seq` 和稳定的 `client_event_id`；Coordinator 在运行租约与对话锁保护下检查序号未变化、范围单调前进、工具配对、清除集合没有丢失和被替换内容确实缩短，再在同一事务里追加事件并更新 `compaction_seq`。清除集合为有序、无重复的保留区工具结果序号。事件保存 `through_seq`、`summary`、`cleared_tool_result_seqs`、`memory_index`、`prompt`、`tokens_before`、`tokens_after`、`provider`、`model` 和可选 `usage`；前后用量为同一字符估算单位，记忆索引来自 bootstrap 的标题快照，最多 2 KiB，不含记忆正文。只清除工具结果时使用旧索引，生成新摘要时记录当前索引和最新标题、目标快照。相同标识和相同内容的重发返回原事件；不同内容复用标识返回冲突。序号或配置冲突时丢弃摘要，重新读取中心状态，最多重试 2 次；提交失败不应用本地替换。

压缩指令针对协调角色编写，要求摘要保留：用户的目标和偏好、纠正与明确指令、做过的决定及理由、开过的 Thread（准确 Thread ID、设备、目录、当前状态和最后的结论）、尚未完成的事项及下一步。上一次的摘要也在被压缩的范围里，指令要求合并有效事实并更新状态，不编造标识符或执行结果。摘要请求失败按 5、15、45 秒重试，耗尽后走模型请求失败流程；已提交的工具清除仍然有效。普通请求出现明确上下文超限时，仅在压缩确实推进后重试一次，失败回复不进入历史。轮内压缩后的崩溃恢复和调度都查看最后一条非压缩事件，压缩记录不会遮蔽待执行工具或待分析的结果。

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

这条通知不触发运行：用户改一条记忆，不值得为此启动 Runtime、花一次模型调用。它随下一批主动输入交给模型，所以 Project Agent 在处理用户下一条消息或下一轮 Thread 结束时，一定已经知道记忆变了。Project Agent 正在运行时，通知同样等到下一轮。本期没有删除记忆的功能；以后增加时，删除也走这条通知。

### 7. 工具

| 工具 | 类型 | 作用 | 输出可以从哪里重新拿到 |
|---|---|---|---|
| `memory.search` | 只读 | 按关键字搜索记忆标题和正文，最多 20 条 | 自身 |
| `memory.read` | 只读 | 读取一条记忆的当前版本 | 自身 |
| `memory.write` | 写入 | 新建或修改一条记忆，带 `expected_revision`，冲突时返回当前版本 | `memory.read` |
| `history.search` | 只读 | 在主对话原文里按关键字搜索，返回序号和片段 | 自身 |
| `history.read` | 只读 | 按序号范围读取原文 | 自身 |
| `devices.list` | 只读 | 列出本人设备、在线状态和能力报告 | 自身 |
| `threads.create` | 写入 | 新建一个 Thread 并发出第一条消息，参数见第 9 节 | `threads.list`、`threads.get` |
| `threads.send` | 写入 | 向本 Project 的一个 Thread 发消息，选择排队或插入 | `threads.get` |
| `threads.stop` | 写入 | 停止一个 Thread 当前的一轮 | `threads.get` |
| `threads.archive` | 写入 | 归档一个 Thread | `threads.get` |
| `threads.list` | 只读 | 列出本 Project 的 Thread，可按状态筛选 | 自身 |
| `threads.get` | 只读 | 读取一个 Thread 的状态、当前 Turn 和待发消息 | 自身 |
| `threads.read` | 只读 | 按 Turn 读取消息和回复正文 | 自身 |
| `nodes.exec` | 写入 | 在开启了命令执行的节点上执行一条命令，参数见第 10 节 | `threads.read` |
| `inbox.ask` | 写入 | 创建一个请用户处理的事项（Agent Inbox IB-01） | `inbox.list`、`inbox.get` |
| `inbox.list` | 只读 | 列出本 Project 的事项及其状态 | 自身 |
| `inbox.get` | 只读 | 读取一个事项的完整内容和处理结果 | 自身 |
| `inbox.withdraw` | 写入 | 撤回一个待处理事项，必须写明原因 | `inbox.get` |

单个工具输出不超过 32 KiB，超出时返回截断标记和继续读取的方式。

每个 `call_tool` 请求包含 `tool_call_id`、工具名和参数。Coordinator 在一个事务里依次：校验租约；确认这个 `tool_call_id` 出现在对话最后一条 assistant 消息里，且还没有对应的 `tool_result`；执行工具，包括写入类工具的业务变更；把结果写成 `tool_result` 事件。参数不合法或业务拒绝时，也写一条 `is_error` 的结果，同一个调用不会被反复尝试。`nodes.exec` 是唯一的例外：事务里只新建 shell Thread，`tool_result` 在等待结束后写入（第 10 节）。

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
| `threads.create` | `node_id`、`agent_type`、`working_directory`、`message`；可选 `model`、`execution_timeout_seconds` |
| `threads.send` | `thread_id`、`message`；可选 `mode`（`queue` / `steer`，默认 `queue`）、`model` |
| `threads.stop`、`threads.archive`、`threads.get` | `thread_id` |
| `threads.list` | 可选 `status`、`after_id` |
| `threads.read` | `thread_id`；可选 `after_turn`、`through_turn` |
| `nodes.exec` | 第 10 节 |
| `inbox.*` | 见 Agent Inbox TECH 第 3 节 |

只读工具还接受 `offset`、`max_bytes`。结果采用 `{encoding:"json", text, offset, total_bytes, truncated, next_offset?}`：先把完整业务结果编码为 JSON，再按 UTF-8 字节取片段。调用方在 `truncated=true` 时以同样的业务参数和 `next_offset` 继续读取，拼接 `text` 后解析 JSON。`max_bytes` 默认 16 KiB、最大 32 KiB；中心按实际 JSON 编码后的容量进一步缩短片段，整个工具结果 payload 不超过 32 KiB。记忆续读可固定 `revision`，`threads.read` 续读固定 `through_turn`。

搜索和列表每页最多 20 条，业务 JSON 中用 `next_after_id` 或 `next_after_seq` 继续取得下一组；空列表表示结束。`history` 返回 `through_seq`，默认固定为本次工具调用的 assistant 序号，后续读取应保持该值，避免把续读过程新产生的事件加入范围。`history.read` 保留原事件 JSON，包括已压缩的原文。`memory.search` 返回标题、版本和正文片段，全文由 `memory.read` 取得；`threads.list` 返回 Thread 标识、设备、目录、Agent、状态和最后活动时间，内容由 `threads.read` 取得。

写工具返回资源 ID、版本或状态及 `read_tool`。记忆冲突返回当前版本和内容，超限时返回截断标记及 `memory.read` 入口。


`inbox.ask` 的展示内容是最多 32 KiB 的 Markdown，链接只允许 `https`；Coordinator 在工具事务内检查长度、链接、选项声明、关联 Thread 归属及 10 个待处理提案上限，不合规时保存 `is_error` 结果。工具参数和事项事务见 [Agent Inbox TECH](../agent-inbox/TECH.md) 第 3、4 节。

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

`exec.enabled` 来自 batond 本地配置里的「允许 Project Agent 执行命令」开关，默认关闭；`exec.shell` 是该节点执行命令使用的 shell。`roots` 来自用户在节点上授权的目录，沿用现有 `batond files` 的登记。`roots` 上报真实路径，因为 Thread 的 `working_directory` 本来就是目标节点上的路径；Web 文件浏览仍只用 `root_id` 和相对路径。`repos` 是在授权目录内有限深度扫描得到的 Git 仓库，上报路径和去掉凭据的 origin，不上传文件内容。`provider.status` 为 available / login_required / unknown，凭据不离开设备。

`devices.list` 把这些报告交给 Project Agent，它据此选择工作目录。

batond 通过 Gateway 的控制队列传送 `node.runtime_report`，正文为 `{ "type": "node.runtime_report", "report": { ... } }`。Coordinator 返回 `node.runtime_report_result`，含 `ok`、成功时的 `report_version` 或失败时的 `code`，信封 `correlation_id` 对应请求的 `message_id`。节点在 `node.sync` 成功后发送报告；未收到成功回执时，在同一进程的连接重试中保留原消息标识和报告内容；采集到的新内容在待确认报告成功后发送。重连后重新发送报告，已确认的报告使用新消息标识。回执只作用于发送该报告的当前连接，旧连接迟到的回执不能确认新连接上的报告。中心只接受当前已同步、未吊销连接的报告，并在事务内再次检查员工、节点、凭据和连接。`report_version` 从 1 开始，报告内容变化时加一；相同内容的重发只刷新 `reported_at`。这些写入不修改 `nodes.capabilities`。

节点每轮采集完成后等待 5 秒再采集，连接建立时也请求刷新。采集在独立循环中串行运行，连接、心跳和 Worker 消息不等待扫描。每轮预算 2 秒；文件系统调用返回后检查期限，无法被操作系统取消的文件系统等待最多占用一个采集协程，重连不另起扫描。扫描只保存登记目录、仓库路径及 origin；目录文件内容不进入报告。

扫描最多向下 4 层（登记根为第 0 层）、读取 4096 个目录条目、记录 128 个仓库。每批读取至多 64 个条目，不跟随遍历中的符号链接，不进入 `.git`。Git 配置最多读取 16 KiB，通过 `git config --no-includes --file - --get remote.origin.url` 解析，每次最多 200 ms，不读取 include 或全局配置。worktree 的 `.git` 和 `commondir` 只允许指向同一登记根内的元数据；指向根外时仍登记仓库路径，省略 origin。origin 仅保留主机和仓库路径，去掉用户信息、端口、查询和片段，忽略本地路径及不支持的传输格式。扫描、读取或容量受限时报告带 `truncated: true`；超出报告容量时先移除末尾仓库，再移除末尾目录。发送前采用带缩进的 JSON 计量，给 PostgreSQL `jsonb::text` 的空格留出余量，报告和数据库文本均不超过 64 KiB。

`batond project-exec --enabled=true|false [--shell 路径] [--data-dir 目录]` 原子保存本机 `project-exec.json`。必须显式给出开关，初始值为关闭；默认 shell 在 Windows 为 `pwsh`，其他系统采用 `SHELL`，未设置时为 `/bin/sh`。配置损坏或权限检查失败时上报关闭。该命令维护配置；Session Worker 在启动命令前重新读取开关。CLI 和节点页面在开启前说明当前用户权限、任意命令、没有沙箱和注入风险。

`baton-project-runtime probe` 的 stdout 契约是一个 JSON 对象：`{ "version": "0.1.0", "providers": [{ "provider": "openai-codex", "status": "available" }] }`。状态只接受 `available`、`login_required`、`unknown`，最多 32 个 provider，名称和版本不超过 128 个 ASCII 字符（字母、数字、点、下划线、加号、连字符）。batond 每轮调用一次 `probe`，时限 1 秒，stdout 缓冲最多 16 KiB，丢弃 stderr；拒绝未知字段、尾随数据和超限输出。Runtime 未安装、probe 失败或输出无效时省略 `project_runtime`，不复用旧登录状态。

### 9. Thread 操作与回复回收

**新建。** `threads.create` 在 `call_tool` 的事务里调用与员工 API 相同的 Store 入口：`client_thread_id` 为 `pa:{conversation_id}:{tool_call_id}`，第一条消息的 `client_message_id` 为 `pa:{conversation_id}:{tool_call_id}:0`，并写入 `project_id`、`origin_conversation_id`、`origin_tool_call_id`。目标节点、目录、Agent 和模型的校验与员工新建相同（Baton R-07）；`agent_type` 不能是 `shell`，命令只能通过 `nodes.exec` 执行。事务只保存 Thread、消息意图和 outbox，设备收到后才开始执行；工具结果返回 Thread ID 和状态，不等待回复。

**发消息、停止、归档。** `threads.send` 的 `client_message_id` 为 `pa:{conversation_id}:{tool_call_id}`。目标 Thread 必须属于本 Project。`mode=steer` 在 Agent 不支持时返回 `is_error`。`threads.stop`、`threads.archive` 与员工操作走同一入口，操作者记为 Project Agent。

锁顺序为 `project_agents` → `conversations` → `threads` → `thread_outbox`。员工 API 只锁 `threads` → `thread_outbox`，不形成环。

**Turn 的归属。** Worker 开启一轮时，在 `turn.started` 里带上第一条消息的 `client_message_id`。中心按这条消息的发送方写 `thread_turns.initiator`：Project Agent 发出的，这一轮归它；员工发出的，归员工。员工在 Project Agent 的一轮里插入消息或停止这一轮，不改变归属。

**回复进入输入队列。** Thread 报告的事务里（Baton TECH「上行报告」），如果当前 Turn 归 Project Agent：

| 报告 | 输入 | `source_key` |
|---|---|---|
| `reply` | 被动 `thread_reply` | `thread:{thread_id}:reply:{worker_seq}` |
| `turn.ended` | 主动 `turn_ended`，内容为 Thread ID、Turn 序号、结束原因、这一轮的回复条数 | `thread:{thread_id}:turn:{worker_turn_seq}` |

来源键冲突时忽略，重复报告不会形成第二条输入。这一步只写 `project_agent_input_queue`，不锁 `project_agents`。被动的回复按 `id` 顺序排在主动的 `turn_ended` 之前，同一批领取时 Project Agent 先读到回复再读到结束（PA-A14）。回复条数超过一批上限时，剩下的在后续轮次领取，`turn_ended` 仍在它们之后。

员工开启的一轮不写输入队列（PA-19）。

**执行时限与停止。** Worker 保证每个开始的 Turn 都有一次 `turn.ended`（Baton TECH「Turn 边界」），所以 Project Agent 不需要自己设置等待期限。Thread 进入 `unknown` 时，这一轮以 `agent_exited` 结束，同样形成 `turn_ended` 输入。

### 10. 在节点上执行命令

`nodes.exec` 用于管理环境，例如创建 worktree、检查仓库状态、安装依赖。Baton 不实现 worktree、clone 等目录准备逻辑，Thread 的工作目录只有「已有目录」一种。开发工作优先交给 Thread 里的执行 Agent，这条分工写在系统提示词和工具说明里，由模型遵守（PA-03）。

**参数。** `node_id`；`command`，交给节点上报的 shell 执行；`working_directory`，必须已经存在并位于该节点登记的目录内；`wait_seconds`，0～600，默认 30；`timeout_seconds`，默认 7200。

**实现为一个 shell Thread。** `call_tool` 的事务里新建一个 `agent_type = shell` 的 Thread，第一条消息就是命令，`client_thread_id` 为 `pa:{conversation_id}:{tool_call_id}`，同一个工具调用最多新建一个 Thread、执行一次命令。目标节点的 `exec.enabled` 为假时直接写 `is_error` 结果。shell Thread 只有一个 Turn，命令退出后 Worker 报告一条回复（合并输出，开头和结尾各保留 16 KiB，附退出码和总字节数）和 `turn.ended`，然后 Thread 进入 `stopped`。它不接受第二条消息，界面上和普通 Thread 一样显示。

**等待。** `call_tool` 返回 `{pending:true, thread_id, version, wait_remaining_ms, wait_protocol:1}`，等待截止时间保存在 `threads.exec_wait_until`，Runtime 重启不会延长它。Runtime 通过 batond 本机的 `poll_wake` 等待 Thread 版本变化或最多 25 秒，再调用短 `wait_tool` 查询。`wait_tool` 的 pending 路径用只读快照校验来源、租约、对话、工具调用和 Thread；需要写结果时按锁顺序重新校验：

- 这一轮已结束：工具结果包含退出码和输出。对应的 `turn_ended` 输入在同一事务标为已投递，`delivered_seq` 指向这条 `tool_result`，避免同一结果出现两次。
- 仍在执行：工具结果为「仍在执行，Thread ID 为 …，结束后输出会作为新输入送回」。命令继续执行，结束时按第 9 节进入输入队列。

单次运行的时长上限到达时，Runtime 以 `finish_wait=true` 立即结束等待并写入当前状态。

**恢复。** Runtime 在等待期间崩溃时，对话结尾是一个没有结果的 `nodes.exec` 调用。恢复时再次 `call_tool`，Coordinator 按 `(origin_conversation_id, origin_tool_call_id)` 找到已有的 Thread，返回 `pending`。命令不会再执行一次。

**节点上的执行。** shell 适配器实现 Baton TECH 的 `Adapter`：`Send` 在提交 `intent` 之后启动命令（例如 `zsh -lc <command>`、`pwsh -NoProfile -Command <command>`），POSIX 上使用独立进程组，Windows 上使用 Job Object；`Abort` 终止整个进程组，返回已停止且副作用未知。Worker 收到 shell Thread 时再读一次本地开关，关闭就以 `thread.open_failed` 拒绝，所以 Coordinator 的能力报告过期也不会执行。

命令退出后，适配器先把完成记录写入私有 `output.json`（Thread、Turn、退出码、输出，原子替换，读取上限 192 KiB），再交出回复。Worker 崩溃后恢复时，有身份匹配的完成记录就补报回复和 `turn.ended`；没有则 Thread 进入 `unknown`，这一轮以 `agent_exited` 结束。命令退出与完成记录保存之间崩溃仍会落到 `unknown`。完成记录保留到 Session 目录回收。

输出含无效 UTF-8 或不可展示控制字节时，整段保留的首尾字节用 base64 保存，回复元数据标 `encoding: base64`。

**安全。** 命令以设备上的用户身份运行，Baton 不提供沙箱，限定工作目录也挡不住命令访问目录之外的内容。Thread 回复和仓库内容都可能包含注入的指令，一旦 Project Agent 被诱导，开启了命令执行的设备上可能被执行任意命令。措施只能限制范围：开关默认关闭、按设备单独开启；每条命令和输出都记录在对话里；命令只能在登记目录下启动。开启开关时，界面说明这些风险。

### 11. Web

`/projects/{id}` 展示主对话、Project 的 Thread 列表、记忆和运行状态。主对话里，`threads.create`、`threads.send`、`nodes.exec` 的工具调用各显示为一行，例如「给 Windows 台式机派发了一个任务」「执行了 1 条命令」，点开进入 Thread。页面按 `design/` 实现，每 2 秒查询中心记录。

界面使用的只读接口：

- `GET /api/v1/projects/{id}/status`：`state`、`waiting_reason`、`pending_inputs`、`last_error`、`next_attempt_at`、`last_seq`，以及最近一次运行的设备、放置原因、是否仍有效和停止回执。
- `GET /api/v1/projects/{id}/messages`：尚未领取的用户消息，按 `after_id` 分页；指定 `client_message_id` 时返回该消息，用于恢复发送响应。
- `GET /api/v1/threads?project_id={id}`：本 Project 的 Thread，都由 Project Agent 新建。

Runtime 的 `preview` 操作发送 `{last_seq, payload:{text, truncated}}` 文本快照，最多 32 KiB、每秒一次。Coordinator 在内存里为每个运行保留最新快照，30 秒过期，不保存到对话历史；`status` 只在 `after_seq` 等于当前历史尾部时附带它。

暂停 Project 通过 Project 状态作废运行租约，不停止 Thread（PA-23）。

## Testing and validation

| Requirement | Setup and observation | Failure condition | Where |
|---|---|---|---|
| PA-01、PA-02 | 通过 API 创建 Project，检查表结构和响应 | `projects` 或 `project_agents` 出现设备、目录字段 | 单元测试 |
| PA-05 | 重复提交同一 `client_message_id`；同一回复、同一 `turn.ended` 重复报告 | 产生第二条输入 | PostgreSQL 集成 |
| PA-05 | 65 KiB 的用户消息；300 KiB 的 Thread 回复 | 消息被接受；输入条目超过 40 KiB；`threads.read` 读不到全文 | PostgreSQL 集成 |
| PA-06、PA-07 | 默认设备离线、provider 未登录、全部设备离线 | 放置到不合格节点；默认设备被改写；输入过期 | 集成，模型替身 |
| PA-08 | 两个调度并发取得租约；暂停 batond 续租使租约过期后恢复 | 出现两个有效运行；旧 epoch 的写入被接受 | 进程测试 |
| PA-10、PA-A13 | 20 个 Thread 的一轮同时结束，每条回复 32 KiB | 一次领取超过 128 KiB；出现超过 160 KiB 的事件；有回复没有在后续轮次领取 | 进程测试，模型替身 |
| PA-11、PA-12、PA-A05 | 在 assistant 保存前后、`threads.create` / `threads.send` 事务前后、`tool_result` 返回前后杀掉 Runtime | Thread 数大于 1；消息发出两次；同一 `tool_call_id` 有两条结果 | 进程测试，故障注入 |
| PA-12 | 对话在上次压缩后累计 1 MiB 事件，然后重启 Runtime | `bootstrap` 或某页响应超过 192 KiB；分页构造出的消息列表与一次性读取的不一致 | 进程测试 |
| PA-09 | 模型替身快速回复后不再写入输入；另一组持续写入超过 15 分钟 | 闲置 180 秒后没有退出；超过上限仍在领取；退出时停止了 Thread | 进程测试 |
| PA-13 | 模型替身持续返回错误 | 重试次数或推迟时间不符；未进入 `needs_attention`；重试后不从原位置继续 | 进程测试 |
| PA-14、PA-A06 | 同一对话在 macOS 和 Windows 上各运行一次，记录实际请求 | 系统提示词、工具定义或历史消息不一致 | 真实 Runtime 和订阅 |
| PA-15、PA-16 | 大工具输出、长单轮及多轮对话越过阈值 | 没有压缩；工具配对或恢复位置改变；原文丢失 | Runtime 确定性测试、Store 事务测试 |
| PA-17 | 模型替身和员工同时修改同一条记忆；员工连续修改 3 次后发消息 | 后写入覆盖前者而没有冲突；只有通知时启动了运行；同一条记忆出现多条通知 | 集成，模型替身 |
| PA-03、PA-A08 | 模型替身调用不存在的工具；对未开启命令执行的设备调用 `nodes.exec`；回复里注入指令 | 调用被执行；出现工具列表之外的工具 | 单元测试 |
| PA-18、PA-A09 | 在不存在的目录新建 Thread，再换目录重试 | 第一次没有返回原因；第二次产生多于一个 Thread | 进程测试 |
| PA-19、PA-A14 | Project Agent 开启的一轮里执行 Agent 回复 3 条后结束 | 前 2 条触发了运行；结束时没有按顺序收到 3 条 | Store + 假节点 |
| PA-19、PA-A15 | Project Agent 开启的一轮中员工插入消息并停止；员工随后开启新一轮 | 前一轮的回复或结束没有进入输入队列；员工的新一轮进入了输入队列 | Store + 假节点 |
| PA-19、PA-A16 | 员工开启的一轮结束后，Project Agent 在同一个 Thread 发消息 | 员工那一轮的回复进入了输入队列，或 Project Agent 那一轮的回复没有进入 | Store + 假节点 |
| PA-19 | Project Agent 对 Kiro Thread 使用 `mode=steer` | 没有返回 `is_error` | 单元测试 |
| PA-21、PA-A11 | 等待时间短于命令耗时；完成与等待截止竞争；丢弃全部版本通知 | 命令因等待结束被中断；结果丢失或重复 | Store 并发测试、真实进程 |
| PA-21、PA-A12 | 等待期间杀掉 Runtime；命令执行中杀掉 Worker；完成记录保存后、报告前杀掉 Worker | 命令执行两次；有完成记录时没有补回输出；没有记录时不是 unknown | 真实进程故障测试 |
| PA-21 | Windows 上执行 PowerShell 命令并在执行中停止 | 子进程在停止后仍然存活 | Windows 原生测试 |
| PA-23、PA-A17 | 暂停期间员工在 Thread 里发消息，再在主对话发消息，然后恢复 | 暂停期间出现运行实例；恢复后主对话消息重复或丢失 | 集成 |
| PA-A01 | 三台设备、真实 Runtime、真实订阅跑完整场景 | 见 PRODUCT 验收表 | 实机 |

## Open questions

- **压缩阈值。** 50% / 80% / 40% 以及保留最近 2 轮、清除 3 轮以前的工具结果，都是初始值，需要用真实对话调整。
- **大小上限。** 用户消息 64 KiB、回复条目 40 KiB（正文 32 KiB）、每批 20 条或 128 KiB、事件 160 KiB、`maxTokens` 32000 都是初始值，压测后调整。调整时保持「单条输入上限 ≤ 每批上限 < 事件上限 < 请求上限」。
- **闲置时间。** 180 秒是初始值。闲置期间不调用模型，但进程占内存并占用节点的 Runtime 名额；有了启动耗时、连续输入间隔和内存占用的实测数据后再调整。
