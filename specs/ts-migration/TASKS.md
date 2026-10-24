# TypeScript 迁移实施切片

Status: draft
依据：[迁移 TECH](TECH.md)、[Agent 适配 PRODUCT](../agent-adapters/PRODUCT.md)、[Agent 适配 TECH](../agent-adapters/TECH.md)。

首次切换包含 Pi、Codex、Kiro、Cursor 与既有 shell；Grok、Antigravity 按适配设计在切换后分别接入。本清单安排切换前的五个任务。现有 workspace、协议与 SQLite 包作为输入，缺项随使用它们的切片补齐。

```text
T1 ──┬─ T2 ── T3 ──┐
     └─ T4 ─────────┼─ T5
```

T4 的设备侧可以与 T2 并行，网页验收依赖 T2。任务是能力验收单位，可以由多个小提交和 PR 完成；每个任务同时交付实现、调用方与测试。T1 按复用检查点、本地可靠执行推进；T3 按设备操作、Project 协同推进；T4 按 Agent 接入、统一历史消费推进。检查点在同一任务内逐项合入，复用检查点完成后再估算剩余工作。

## T1 交付 Cursor 本地可靠会话

Status: complete
实现与验证入口：[本地 Thread](../../apps/batond/README.md)。Cursor 启用 macOS arm64 / SDK 1.0.35；其他系统组合的验证留给 T5。

- 依据：[上游复用边界](../agent-adapters/TECH.md#上游复用边界)、[Worker 接收与异步执行](../agent-adapters/TECH.md#worker-接收与异步执行r-04r-05r-08)、[Cursor](../agent-adapters/TECH.md#cursorr-01r-12)。
- 依赖：现有基础包；首先交付可运行的 provider、最小宿主及上游测试检查点，记录依赖、保留模块与修改范围。
- 交付：本地调用方通过认证 IPC 新建 Cursor Thread，持久排队、多轮执行、停止、恢复并读取基本历史；含 cursor-host、进程管理与探测。
- 边界：只接 Cursor；不实现中心、网页、Project、其他 Agent 或多 Agent 历史缓存。复用或 SDK 路线不成立时先调整设计。
- 验证：选用模块的上游离线测试与 SDK 转录回放可运行；用本地替身和确定性回放验证独立历史、跨进程恢复、取消和输入重试，全程不需要真实凭据或模型调用。
- 验证：真实 Worker 与 SQLite 的故障回放证明 intent 前后退出不重发、慢执行不阻塞 stop、取消的 open 不补报成功、提交未知不继续执行。
- 验证：检查完整 Worker 就绪预算、FULL 提交延迟、私有状态与所属进程回收；各目标系统结果分别记录，未测项留给 T5 复验前补齐。

## T2 交付网页远程 Thread

Status: complete
实现与验证入口：[TS 中心与网页](../../apps/server/README.md)、[远程节点](../../apps/batond/src/daemon/README.md)。使用真实 PostgreSQL、WSS、认证 IPC、独立 Worker 与离线回放验证远程链路；当前 Cursor 支持组合沿用 T1，完整安装包与系统矩阵复验归 T5。

- 依据：[Coordinator 与 batond 职责](TECH.md#服务职责)、[启动与命令回执](../agent-adapters/TECH.md#启动与命令回执)、Baton PRODUCT R-01～R-14、R-16、R-19、R-23。
- 依赖：T1 的 Worker、接入契约与本地持久事实。
- 交付：员工登录并注册设备，从网页创建 Cursor Thread、排队、停止、恢复、归档、查看回复与实时输出；含对应 HTTP、PostgreSQL、WSS、node.db 与重连。
- 边界：实现 Thread 所需的账号、设备身份、凭据吊销、默认设备和能力准入；工作目录按本地登记根授权，目录增删、附件预览、Project 和订阅登录归 T3。
- 验证：真实 TS 中心、batond、Worker 与回放 Agent 贯穿网页 API；两名员工的查询、命令和节点凭据相互隔离。
- 验证：ACK 丢失、完成先于 ACK、中心 / batond 重启与数据库短停时，不重复执行、不重复保存回复，恢复中的命令不提前结束。
- 验证：网页保留 status/create/reason、启动中与停止确认状态；节点同步前不可用，输出洪泛不阻塞其他节点控制消息。

## T3 交付 Project 与设备管理

- 依据：[Project Agent TECH](../project-agent/TECH.md)、[控制面调度 TECH](../control-dispatch-reliability/TECH.md)、[Agent Inbox TECH](../agent-inbox/TECH.md)、Baton PRODUCT R-06、R-17～R-23。
- 依赖：T2 的员工、设备与 Thread 链路；使用其公开契约，不依赖 T4 的其他 Agent。
- 交付：现有 TS Project Runtime 在 TS batond 上启动、续租并使用 Thread、事项和记忆工具；网页可管理 Project、设备目录、设置、附件及模型订阅。
- 边界：恢复已有产品能力，包含受限 shell Thread、Project 执行授权和原有管理 CLI；保留 Runtime 业务实现，第一版按源码开发入口验收，SEA 总装归 T5。
- 验证：用本地模型替身与 Agent 转录，从 Project 消息到 Runtime、Thread 回复、记忆和事项处理贯穿本地 TS 中心与节点；工具读取同一份设备能力及 reason。
- 验证：租约失效、睡眠唤醒、旧代次回执与中心短停时，不重复运行 Project 或越权执行；复用包内调度与存储不变量测试。
- 验证：目录、符号链接和附件越界被拒绝；设备设置和订阅登录通过本地认证替身验证按设备确认及结果显示，认证材料留在设备。

## T4 交付既有 Agent 与统一历史

- 依据：[Pi、Codex](../agent-adapters/TECH.md#picodexr-04r-10)、[共享 ACP 与 Kiro](../agent-adapters/TECH.md#共享-acp-与-kiror-04r-08r-11)、[历史与分页](../agent-adapters/TECH.md#设备端历史归一化与分页r-10)。
- 依赖：T1 的接入层、Worker 与进程管理；设备侧可与 T2 并行，网页消费验收依赖 T2。
- 交付：Pi、Codex、Kiro 接入相同 Thread 执行链路；这三种及 Cursor 的历史经设备归一化和有界分页，网页与 Project 工具消费同一契约。
- 边界：复用 T1 的生命周期与证据服务；本任务只做三种协议接入、探测和公共历史，不增加 Grok、Antigravity 或上游 fork / rollback / 审批产品能力。
- 验证：相关上游测试和既有 Baton 录制通过；最低版本、会话恢复、输入不重发、Pi / Codex 原生 steer 归属及 Kiro V3 扩展符合规格。
- 验证：缺时间、分块长回复、同角色多消息、大历史、并发翻页、快照失效和匹配歧义正确处理；网页删除原生协议解析。
- 验证：各 provider 的隔离探测、取消与进程回收单独验证；继承 T2 的命令和报告链路，不另建一套队列或恢复逻辑。

## T5 交付安装包并切换 TS 发布

- 依据：[打包与发布](TECH.md#打包与发布)、[验证](TECH.md#验证)、[Agent 适配验收](../agent-adapters/PRODUCT.md#验收)。
- 依赖：T2、T3、T4；各切片的业务测试与所属平台实现完成。
- 交付：server Docker 镜像、四个系统 / 架构目标的 batond SEA、Cursor 完整附带依赖及 Runtime 子命令；切换构建发布入口并删除 Go。
- 边界：完成打包集成、安装包缺陷修复与交付复验；不新增 Agent、补造业务模块或改变支持策略。既有交付组合的回归失败阻塞切换。
- 验证：脱离源码、无系统 Node、无运行时依赖下载时启动安装包；缺少 SDK 附带目录会明确失败，来源、许可与静态夹具保留。
- 验证：三类系统上运行本地故障恢复、替身进程回收、冷启动、FULL 与 Agent 离线转录回放；Cursor 只启用已通过离线行为及本地安装包检查的组合，Go 删除后的 CI 不再调用 Go 导出器。
- 验证：工作区静态检查、测试、Web 构建和安装包检查通过，长期文档同步；Baton 验证表中的负载测试按明确阈值执行，阈值缺项须在切换前确定。
