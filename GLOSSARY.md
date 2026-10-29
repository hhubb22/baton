# Baton 术语表

本文统一产品与代码中的领域叫法，并列出定义、代码名和容易混淆的含义。

## 身份与对话

| 领域术语 | 一句话定义 | 代码中的名字与入口 | 易混点 |
| --- | --- | --- | --- |
| 员工 | 登录 Baton 并拥有设备、Thread 和 Project 的使用者。 | `Employee`、`employee_id`，见 [auth.ts](packages/protocol/src/auth.ts)。 | 产品中的「用户」通常指员工；节点操作系统用户是另一种身份。 |
| 设备 / 节点 | 员工注册的、运行 batond 并具有稳定身份的一份运行环境。 | `NodeIdentity`、`node_id`，见 [device.ts](packages/protocol/src/device.ts)。 | 网页称设备，协议和存储多称 node；宿主机与虚拟机可以分别注册。 |
| 默认设备 | 员工选定的、新建 Thread 时默认使用且优先承载 Project Agent 的设备。 | `DefaultDevice`、`default_device_node_id`、`default_pc_node_id`，见 [device.ts](packages/protocol/src/device.ts)。 | 两个默认设备响应字段指向同一设备；默认设备身份与设备是否在线分别表示。 |
| 连接身份 | 中心认证的一次节点连接所绑定的员工、设备、凭据、进程实例与连接标识。 | `NodeSource`，见 [errors.ts](apps/server/src/errors.ts)；认证覆盖见 [gateway.ts](apps/server/src/gateway.ts)。 | 报文中的可选 `Source` 由发送方提供，中心以认证得到的身份覆盖它。 |
| Agent 类型 | 设备可用于执行 Thread 的 Agent 实现类别。 | `agent_type`、`agentCatalog`、`HostedAgentType`，见 [catalog.ts](apps/batond/src/agents/catalog.ts)。 | Cursor、Pi、Codex、Kiro 通过 provider host 运行；shell 也实现 ThreadAgent，Project Agent 则有独立的协调身份。 |
| Thread | 绑定员工、设备、工作目录和 Agent，并具有稳定 ID 的执行对话。 | `Thread`、`thread_id`、`native_session_id`，见 [thread.ts](packages/protocol/src/thread.ts)。 | 输出协议 `SessionRequest.session_id` 实际传 Thread ID，见 [full-output.ts](apps/server/src/full-output.ts)；它与原生会话 ID、浏览器登录 session 分属不同身份。 |
| Turn / 回合 | Thread 中从一条 queue 输入被原生接受到对应终态的一轮执行。 | `ThreadTurn`、`worker_turn_seq`、`turn.started`、`turn.ended`，见 [thread.ts](packages/protocol/src/thread.ts)。 | steer 输入加入当前回合；`worker_seq` 是报告序号，`worker_turn_seq` 是回合序号，`executionId` 是原生执行关联标识。 |
| 回复 | Agent 在一个回合内给出的一条消息，可带附件。 | `AgentEvent` 的 `reply`、`ThreadReport.content`、`thread_replies`，见 [agent.ts](apps/batond/src/worker/agent.ts) 和 [reports.ts](apps/server/src/threads/reports.ts)。 | 一个回合可以有多条回复；实时文本增量与持久回复分别处理，中心正文可以被截断。 |
| 附件 | 回复引用的文件或代码提交等资源。 | `ThreadReport.attachments`、`parseThreadAttachments`，见 [attachments.ts](apps/batond/src/devices/attachments.ts)。 | 文件引用携带 `node_id`、`root_id`、`path` 和访问状态；提交引用携带仓库地址与完整 SHA，引用本身不保存文件内容。 |
| Project | 员工交给 Project Agent 持续推进的一件事及其相关对话、Thread 和记忆。 | `Project`、`project_id`，见 [project.ts](packages/protocol/src/project.ts)。 | Project 可为 `active`、`paused` 或 `archived`；其中的执行 Thread 各有自己的状态和生命周期。 |
| Project Agent | 一个 Project 的长期协调身份及其模型配置。 | `ProjectAgent`、`project_agents`，见 [project.ts](packages/protocol/src/project.ts) 和 [projects.ts](apps/server/src/project/projects.ts)。 | 它通过工具协调执行 Thread；一次 Runtime run 只承载它的一次运行。 |
| 主对话 / Conversation | Project Agent 在中心保存的连续对话事件序列。 | `ProjectConversation`、`ProjectEvent`、`conversations`，见 [project.ts](packages/protocol/src/project.ts)。 | 主对话的 `seq` 与 Thread 的报告、回合和时间线序号各自计数；主对话也称 primary conversation。 |
| Project Runtime run | Project Agent 在指定设备上持有租约的一次进程执行。 | `Run`、`run_id`、`agent_runs`，见 [manager.ts](apps/batond/src/project/manager.ts) 和 [scheduling.ts](apps/server/src/project/scheduling.ts)。 | 以 `(run_id, lease_epoch)` 识别授权运行；一个 Project 可以经历多次 run，Thread Turn 则是执行对话中的回合。 |
| Project 输入 | 等待并入主对话的用户消息、记忆变化、Project 更新或执行反馈。 | `project_agent_input_queue`、`source_type`、`wake_required`、`delivered_seq`，见 [inputs.ts](apps/server/src/project/inputs.ts)、[events.ts](apps/server/src/project/events.ts) 和 [runtime.ts](apps/server/src/project/runtime.ts)。 | `wake_required=false` 可只表示唤醒通知已确认；`delivered_seq` 才记录输入已并入的主对话事件。 |
| Agent 问题 | 原生执行 Agent 在当前 Turn 内发出的、等待员工回答的请求。 | `ThreadQuestion`、`pending_questions`、`question.pending`，见 [thread-question.ts](packages/protocol/src/thread-question.ts) 和 [thread.ts](packages/protocol/src/thread.ts)。 | `request_id` 标识原生问题；答案通过 Thread 持久命令投递。 |
| 上下文压缩 / Compaction | 保存缩减后的模型历史视图并保留中心原始事件的操作。 | `CompactionPayload`、`commit_compaction`，见 [compaction.ts](runtimes/project-agent/src/compaction.ts) 和 [runtime.ts](runtimes/project-agent/src/runtime.ts)。 | 摘要和清除工具结果视图都可形成 compaction；`through_seq` 与 `cleared_tool_result_seqs` 描述视图范围，中心原文继续保留。 |

## 执行边界与输入投递

| 领域术语 | 一句话定义 | 代码中的名字与入口 | 易混点 |
| --- | --- | --- | --- |
| daemon / 守护进程 | 在设备数据目录内持锁、连接中心并管理设备能力与独立 Worker 的进程。 | `runDaemon`，见 [daemon.ts](apps/batond/src/daemon/daemon.ts)。 | batond 是可执行程序名，还承载 worker、agent-host、watchdog 等子命令。 |
| Thread Worker / Session Worker | 独占一个 Thread 账本、接收持久命令并驱动 ThreadAgent 的独立进程。 | `runWorker`、`makeWorker`，见 [worker-runner.ts](apps/batond/src/daemon/worker-runner.ts) 和 [worker/index.ts](apps/batond/src/worker/index.ts)。 | 两种叫法指同一种 Worker；它与 Project Runtime、Agent host 各有独立生命周期。 |
| ThreadAgent / Baton 执行适配器 | Worker 驱动一个 Thread 执行实例的接口。 | `ThreadAgent`、`AgentFactory`，见 [agent.ts](apps/batond/src/worker/agent.ts)；实现见 [thread-agent.ts](apps/batond/src/agent-host/thread-agent.ts) 和 [shell/index.ts](apps/batond/src/agents/shell/index.ts)。 | 这里的「适配器」负责准备、发送、接受核对、事件与回收；t3code provider adapter 负责另一层原生协议。 |
| Agent host | 运行 provider adapter 并通过 stdio RPC 与 Worker 交互的独立宿主进程。 | `runAgentHost`、`AgentHostRpc`，见 [host.ts](apps/batond/src/agent-host/host.ts) 和 [protocol.ts](apps/batond/src/agent-host/protocol.ts)。 | host 承载原生执行资源；Worker 负责 Thread 持久状态，probe 也可临时启动 host。 |
| HostedAgentOptions | Worker 侧构造 hosted ThreadAgent 的工厂参数。 | `HostedAgentOptions`、`makeAgentHostFactory`，见 [thread-agent.ts](apps/batond/src/agent-host/thread-agent.ts)。 | 包含启动命令、Agent 类型、能力与进程管理选项；路径从 `WorkerOpenConfig` 推导，`capabilities` 明确传入 steer 和换模型能力。 |
| HostRunOptions | Agent host 进程内部运行已选模块所需的参数。 | `HostRunOptions`、`runAgentHost(module, options)`，见 [host.ts](apps/batond/src/agent-host/host.ts)。 | 只包含 `agentType` 和 `paths`；与 Worker 侧的 `HostedAgentOptions` 分处不同调用边界。 |
| Host driver | 将 provider adapter 的行为与事件转换为 host RPC 契约的模块。 | `AgentHostDriverShape`、`makeProviderHostDriver`，见 [protocol.ts](apps/batond/src/agent-host/protocol.ts) 和 [driver.ts](apps/batond/src/agent-host/driver.ts)。 | 各 Agent 的 driver 负责装配差异，如 [cursor/host-driver.ts](apps/batond/src/agents/cursor/host-driver.ts)；共享的 [agent-host/driver.ts](apps/batond/src/agent-host/driver.ts) 实现通用运行逻辑。 |
| Provider adapter / t3code 适配器 | t3code fork 提供的原生会话、协议、取消和快照实现。 | `ProviderAdapterV2`、`ProviderHostDriverOptions.adapter`，见 [driver.ts](apps/batond/src/agent-host/driver.ts)。 | 使用「适配器」时需说明所在层：provider adapter 面向原生 Agent，Baton ThreadAgent adapter 面向 Worker。 |
| 原生映射 | 将 Baton Thread 与原生会话、目录、profile 和 provider thread 绑定的私有持久记录。 | `NativeMapping`、`nativeSessionId`、`providerThread`，见 [mapping.ts](apps/batond/src/agent-host/mapping.ts)。 | shell 使用 `ShellMapping`，额外绑定节点、存储代次和 Project 来源，见 [evidence.ts](apps/batond/src/agents/shell/evidence.ts)。 |
| 执行身份 | 将一次输入与其原生接受证据及后续事件关联的标识。 | `executionId`、provider `runId`、`providerTurnId`，见 [driver.ts](apps/batond/src/agent-host/driver.ts)。 | provider host 用 `runId` 作为 `executionId`；上游 `providerTurnId` 用于插入和取消，与 Project Runtime 的 `run_id` 分属不同体系。 |
| 输入准备 / Preparation | 发送前生成并随 intent 保存的原生会话、准备 ID 和已确认发送计数基线。 | Worker 的 `InputPreparation` 与 RPC 的 `Preparation`，见 [agent.ts](apps/batond/src/worker/agent.ts) 和 [protocol.ts](apps/batond/src/agent-host/protocol.ts)。 | `prepareInput` 建立本地基线，`restoreInput` 恢复本地准备；原生接受另有证据。 |
| 输入意图 / Intent | 原生发送前已持久保存的输入准备与执行意图。 | `Message.state === 'intent'`、`Message.preparation`，见 [ledger.ts](apps/batond/src/worker/ledger.ts)。 | intent 可能已触发原生发送；恢复时须核对接受证据，不能按 queued 输入自动重发。 |
| 原生接受 / Native acceptance | 原生 Agent 已接收输入的会话与执行身份证据。 | Worker 的 `InputAcceptance` 与 RPC 的 `Acceptance`，见 [agent.ts](apps/batond/src/worker/agent.ts) 和 [protocol.ts](apps/batond/src/agent-host/protocol.ts)。 | `send` 返回接受证据；Worker 接收命令、传输写入和回合完成分别是其他事实。 |
| sent 状态 | 消息已确认被原生 Agent 接受的持久状态。 | `Message.state === 'sent'`、`message.sent`、`ThreadMessage.status`，见 [ledger.ts](apps/batond/src/worker/ledger.ts) 和 [thread.ts](packages/protocol/src/thread.ts)。 | sent 可持续到回合结束后；同名 `sent()` 方法用于只读核对接受证据。 |
| sent 核对 | 发送结果不确定时只读检查既有原生快照或 shell 完成证据的操作。 | `ThreadAgent.sent`、host RPC `sent`，见 [agent.ts](apps/batond/src/worker/agent.ts)、[driver.ts](apps/batond/src/agent-host/driver.ts) 和 [shell/index.ts](apps/batond/src/agents/shell/index.ts)。 | 方法返回接受证据或 `undefined`，不发送输入；未取得证据也不足以证明输入从未执行。 |
| 命令接收回执 / Receipt | 节点或 Worker 对命令持久接收身份的确认或拒绝。 | `WorkerCommandReceipt`、`ThreadCommandResult`、`acked_at`，见 [worker.ts](packages/protocol/src/worker.ts) 和 [outbox.ts](apps/server/src/threads/outbox.ts)。 | `ThreadCommandResult.ok=true` 表示接收成功；打开、恢复或命令执行结果通过后续报告表达。 |
| 命令完成 / Completion | 某条命令的持久终态结果。 | `command.completed`、`command_outcome`、`WorkerCommandStatus`，见 [thread.ts](packages/protocol/src/thread.ts)、[worker.ts](packages/protocol/src/worker.ts) 和 [worker/index.ts](apps/batond/src/worker/index.ts)。 | 结果为 succeeded、failed、cancelled 或 unknown；message 命令 succeeded 表示原生已接受输入，回合完成由 `turn.ended` 表达。 |
| 启动阶段 / Startup phase | 记录是否可能已向 Worker 交付 open 的持久事实。 | `startup_phase: awaiting_open / open_attempted`，见 [daemon/ledger.ts](apps/batond/src/daemon/ledger.ts)。 | `launch_attempted` 只记录进程启动尝试；open 交付证据决定是否还允许按未打开状态恢复。 |
| Thread outbox / 中心下行箱 | 中心保存 Thread 下行命令意图、派发尝试、接收和完成事实的记录。 | `thread_outbox`、`attempts`、`acked_at`、`completed_at`，见 [outbox.ts](apps/server/src/threads/outbox.ts)。 | Project Runtime 命令还使用 `agent_runs` 和输入队列；「outbox」需说明是下行命令还是上行报告。 |
| Worker / 节点报告 outbox | 按稳定事件身份与顺序保存待确认或待补送报告的持久集合。 | `OutboxEntry`、`thread_outbox`，见 [worker/ledger.ts](apps/batond/src/worker/ledger.ts)；`node_outbox`，见 [daemon/ledger.ts](apps/batond/src/daemon/ledger.ts)。 | Worker 账本的 `thread_outbox` 保存上行报告，中心同名表保存下行命令；Worker ACK 表示节点已落盘，中心 ACK 是下一阶段。 |
| 状态未知 / Unknown | 现有证据无法确定输入是否被接受或执行结果如何的持久状态。 | `Message.state`、`phase`、`markUnknown`，见 [ledger.ts](apps/batond/src/worker/ledger.ts) 和 [worker/index.ts](apps/batond/src/worker/index.ts)。 | 与 `processTreeStopped` 分别记录；确认进程已回收仍不能证明过去没有执行过输入。 |

## 代次与序号

| 领域术语 | 一句话定义 | 代码中的名字与入口 | 易混点 |
| --- | --- | --- | --- |
| 控制代次 / Control epoch | Worker 用来拒绝旧异步操作结果的控制计数。 | `Meta.epoch`、`Operation.epoch`，见 [ledger.ts](apps/batond/src/worker/ledger.ts) 和 [worker/index.ts](apps/batond/src/worker/index.ts)。 | 停止或进入 unknown 时推进；它与 Project 租约、存储身份及 host 事件代次独立，输出缓冲还使用自己的随机 `epoch`，见 [output.ts](apps/batond/src/worker/output.ts)。 |
| 租约代次 / Lease epoch | 中心用于限制 Project Runtime 当前运行写入权限的租约计数。 | `lease_epoch`、`ProjectRunCommand`、`ProjectRuntimeRequest`，见 [project.ts](packages/protocol/src/project.ts) 和 [runtime.ts](apps/server/src/project/runtime.ts)。 | 中心同时核对 `run_id`、节点身份和租约有效期；该计数与 Worker 控制代次、Thread 存储代次独立。 |
| 存储代次 / Storage generation | 将一个 Thread 的 Worker 账本、命令、报告和完整输出绑定到同一本地存储身份的标识。 | `storage_generation`、`WorkerOpenConfig`，见 [worker.ts](packages/protocol/src/worker.ts) 和 [threads.ts](apps/batond/src/daemon/threads.ts)。 | 通常在首次接收 open 时分配 UUID；恢复沿用既有值，Thread ID、控制计数和 Runtime 租约不能代替它。 |
| Host 事件代次与序号 | 标识一次 host 打开或恢复后的事件流并检查事件连续性的组合。 | `HostEvent.generation`、`HostEvent.sequence`，见 [protocol.ts](apps/batond/src/agent-host/protocol.ts) 和 [thread-agent.ts](apps/batond/src/agent-host/thread-agent.ts)。 | `generation` 在 open/resume 时生成，`sequence` 在该事件流内递增；它们与持久报告 `worker_seq`、控制 `epoch`、租约 `lease_epoch` 和 `storage_generation` 各有独立用途。 |

## 进程、存储与验证

| 领域术语 | 一句话定义 | 代码中的名字与入口 | 易混点 |
| --- | --- | --- | --- |
| 所属进程 / Owned process | 由宿主登记身份并负责回收的进程树资源。 | `OwnedProcess`、`spawnOwnedProcess`，见 [process-types.ts](apps/batond/src/platform/process-types.ts) 和 [process.ts](apps/batond/src/platform/process.ts)。 | `exited` 只表示根进程退出；`reap()` 才提供树回收结果，独立 Thread Worker 由自身生命周期管理。 |
| Watchdog | 宿主私有控制管道关闭后回收所登记 POSIX 进程组的辅助进程。 | `ProcessWatchdog`、`runWatchdogCommand`，见 [process-types.ts](apps/batond/src/platform/process-types.ts) 和 [watchdog.ts](apps/batond/src/platform/watchdog.ts)。 | Thread Worker、Project Runtime 管理器和 Agent host 可各自拥有 watchdog；Windows 使用持久进程身份与进程树回收。 |
| 进程登记 / Process registration | 保存所属进程或进程组身份以支持取消及崩溃清理的操作。 | `ProcessRegistrar`，见 [process-registrar.ts](apps/batond/src/agent-host/process-registrar.ts)；`ProcessRecordCallbacks`，见 [process-types.ts](apps/batond/src/platform/process-types.ts)。 | host registrar 向 watchdog 登记独立进程组；Worker records 持久保存进程身份，回收超时或失败时须保留登记。 |
| 回收证据 / Reaping evidence | 系统已确认所属执行进程树停止的事实。 | `ReapResult.reaped`、`processTreeStopped`，见 [process-types.ts](apps/batond/src/platform/process-types.ts) 和 [agent.ts](apps/batond/src/worker/agent.ts)。 | abort/close 响应与根 PID 退出都不足以单独建立整棵树已停止的事实。 |
| 授权目录 / Browse root | 用户授权访问的真实目录及其稳定 ID。 | `BrowseRoot`、`initializeBrowseRoots`、`authorizeDirectory`，见 [roots.ts](apps/batond/src/devices/roots.ts)。 | 配置用 `id`，设备报告用 `root_id`；数据目录另有用途，配置缺失与已保存空列表也有不同含义。 |
| 提交结果未知 / CommitUnknown | SQLite COMMIT 失败且独立读取仍无法裁决提交结果时产生的错误。 | `CommitUnknown`，见 [sqlite/index.ts](packages/sqlite/src/index.ts)。 | 它继承 `SqlError`，须按类识别；调用方须停止执行并核对持久状态，再打开新连接。 |
| 实时输出 / 完整输出 | 通过设备请求读取的临时文本流片段或设备持久保存的完整回复正文与 shell 原始输出。 | `SessionRequest.action: output / full_output`、`SessionResult.full_output`，见 [thread.ts](packages/protocol/src/thread.ts)；`OutputBuffer` 和 `FullOutputStore`，见 [output.ts](apps/batond/src/worker/output.ts) 和 [full-output.ts](apps/batond/src/worker/full-output.ts)。 | 实时缓冲有界且可报告缺口；完整输出按存储代次定位并有保留期限，中心 Thread 回复历史另存有界正文和附件引用。 |
| Schema / DTO | 跨模块共享的数据传输形状及其局部约束。 | `Schema.Struct`、领域 Schema 与派生类型，见 [protocol/src](packages/protocol/src/) 和 [thread.ts](packages/protocol/src/thread.ts)。 | 解码只验证结构和声明的关系；员工归属、连接身份与租约仍须由业务事务验证。 |
| 探测 / Probe | 在临时空工作目录中限时检查 Agent 安装、认证与模型信息的任务。 | `probeAgents`、`ProbeResult`，见 [probe.ts](apps/batond/src/agents/probe.ts) 和 [protocol.ts](apps/batond/src/agent-host/protocol.ts)。 | `agent-host --probe` 调用 `inspectAgentHostModules` 检查模块及安装包依赖，见 [cli/agent-host.ts](apps/batond/src/cli/agent-host.ts)；两类检查范围不同。 |
| 回放 / Replay | 在外部依赖边界提供确定性本地记录以复现执行行为的验证方式。 | `replayAgentHostModule`，见 [cursor/replay-host.ts](apps/batond/src/testing/cursor/replay-host.ts)；E2E 入口见 [provider-replay-worker.ts](e2e/src/testing/provider-replay-worker.ts)。 | provider host 回放经过真实 driver 和 RPC；[replay-worker.ts](e2e/src/testing/replay-worker.ts) 中的 `replay` 直接替代 ThreadAgent，两者验证范围不同。 |
| Shell 提交标记 | shell 启动前保存、用于阻止再次启动同一命令的持久记录。 | `submissionPath`、`shell-submission.json`，见 [evidence.ts](apps/batond/src/agents/shell/evidence.ts)。 | 完成证据另存于 `output.json`；提交标记只证明尝试派发，不能证明完成。 |
| SEA 安装包 | 携带 Node 的 batond 可执行文件、旁置依赖、清单与许可组成的整体产物。 | `packageBatond`、`package-manifest.json`，见 [package-batond.mjs](tools/package-batond.mjs)。 | 开发 bundle 是 CJS 文件；SEA 可执行文件依赖相邻 `node_modules/`，安装包需整体搬迁。 |
| Worker 启动测量 | 从真实 LocalWorkerHost 启动进程到取得认证 status 的耗时测量。 | `measureWorkerStartup`，见 [worker-startup.mjs](tools/measure/worker-startup.mjs)；采样见 [worker-driver.mjs](tools/measure/worker-driver.mjs)。 | `worker_ready` 与 `agent_ready` 分别记录；该测量验证 Worker 就绪，不打开 Agent 会话。 |
