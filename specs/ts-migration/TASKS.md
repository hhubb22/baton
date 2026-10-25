# TypeScript 迁移实施切片

Status: draft
依据：[迁移 TECH](TECH.md)、[Agent 适配 PRODUCT](../agent-adapters/PRODUCT.md)、[Agent 适配 TECH](../agent-adapters/TECH.md)。

首次切换包含 Pi、Codex、Kiro、Cursor 与既有 shell，Agent 接入整包依赖 Baton 的 t3code fork；Grok、Antigravity 按适配设计在切换后分别接入。本清单安排切换前的五个任务。现有 workspace、协议与 SQLite 包作为输入，缺项随使用它们的切片补齐。

```text
T1 ──┬─ T2 ── T3 ──┐
     └─ T4 ─────────┼─ T5
```

T1～T4 已完成。任务按能力验收，每项包含实现、调用方与测试；完整安装包、发布切换与系统矩阵复验由 T5 交付。

## T1 交付 Cursor 本地可靠会话

Status: complete
实现与验证入口：[本地 Thread](../../apps/batond/README.md)。Cursor 启用 macOS arm64 / SDK 1.0.35；其他系统组合的验证留给 T5。

- 依据：[架构与职责](../agent-adapters/TECH.md#架构与职责)、[Worker 接收与异步执行](../agent-adapters/TECH.md#worker-接收与异步执行r-04r-05r-08)、[各 Agent 实现](../agent-adapters/TECH.md#各-agent-实现)。
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

Status: complete
实现与验证入口：[Project 中心](../../apps/server/README.md#project-与设备管理)、[Runtime 宿主](../../apps/batond/src/project/README.md)、[shell Thread](../../apps/batond/src/agents/shell/README.md)、[设备管理](../../apps/batond/README.md#设备目录与模型订阅)。真实 PostgreSQL、HTTPS/WSS、独立 Runtime 和 Worker 与本地模型替身贯穿 Project 工具、Thread、事项、记忆和设备确认。Runtime 保留源码开发入口；Windows 凭据操作通过 TS helper 接入，原生系统矩阵与 SEA 总装仍归 T5。

- 依据：[Project Agent TECH](../project-agent/TECH.md)、[控制面调度 TECH](../control-dispatch-reliability/TECH.md)、[Agent Inbox TECH](../agent-inbox/TECH.md)、Baton PRODUCT R-06、R-17～R-23。
- 依赖：T2 的员工、设备与 Thread 链路；使用其公开契约，不依赖 T4 的其他 Agent。
- 交付：现有 TS Project Runtime 在 TS batond 上启动、续租并使用 Thread、事项和记忆工具；网页可管理 Project、设备目录、设置、附件及模型订阅。
- 边界：恢复已有产品能力，包含受限 shell Thread、Project 执行授权和原有管理 CLI；保留 Runtime 业务实现，第一版按源码开发入口验收，SEA 总装归 T5。
- 验证：用本地模型替身与 Agent 转录，从 Project 消息到 Runtime、Thread 回复、记忆和事项处理贯穿本地 TS 中心与节点；工具读取同一份设备能力及 reason。
- 验证：租约失效、睡眠唤醒、旧代次回执与中心短停时，不重复运行 Project 或越权执行；复用包内调度与存储不变量测试。
- 验证：目录、符号链接和附件越界被拒绝；设备设置和订阅登录通过本地认证替身验证按设备确认及结果显示，认证材料留在设备。

## T4 用 t3code fork 接入 Agent 并统一历史

Status: complete
实现与验证入口：[t3code fork](../../third_party/t3code/README.md)、[agent-host](../../apps/batond/src/agent-host/README.md)、[TS 中心与网页](../../apps/server/README.md)。Cursor、Pi、Codex、Kiro 共用 fork 的完整 adapter 与宿主层，Thread 历史由中心记录提供；完整安装包与系统矩阵复验归 T5。

- 依据：[架构与职责](../agent-adapters/TECH.md#架构与职责)、[Worker 保证与上游行为](../agent-adapters/TECH.md#worker-保证与上游行为r-04r-09)、[各 Agent 实现](../agent-adapters/TECH.md#各-agent-实现)、[历史](../agent-adapters/TECH.md#历史r-10)。
- 依赖：T1 的 Worker 与进程管理，T2 的远程 Thread 链路。
- 交付：建立 t3code fork 与 `upstream/t3code` submodule，workspace 收录所需包并删除本地 `effect-acp`、`effect-codex-app-server`、`packages/providers`、`packages/provider-testing`；`cursor-host` 泛化为 agent-host，提供宿主层与事件映射；Cursor 改用完整 `provider-cursor`；接入 Pi、Codex（fork 中拆成 `provider-codex`）和 Kiro（fork 中新增 `kiroAcp`）；Thread 历史改用中心记录，删除设备原生历史与网页原生解析。
- 边界：接受上游行为，不在接入层修改 adapter 语义；MCP 只接注入接口，不配置 endpoint；不增加 Grok、Antigravity 或上游 fork / rollback / 审批产品能力。
- 验证：所用包的上游测试在 Baton CI 中运行；宿主层单测；用上游 testkit 替身驱动真实 adapter 验证事件映射与 `sent` 判定。
- 验证：T2 的 Cursor 远程链路换到 agent-host 后回归通过；Pi、Codex、Kiro 各有一条网页发送、回复、停止、恢复的回放链路；Kiro 使用由 Go 录制转换的夹具。
- 验证：Worker 的接收、intent、unknown、停止裁决与进程树回收测试换成 agent-host 替身后通过；网页与 `threads.read` 读取同一份中心记录。

## T5 交付安装包并切换 TS 发布

- 依据：[打包与发布](TECH.md#打包与发布)、[验证](TECH.md#验证)、[Agent 适配验收](../agent-adapters/PRODUCT.md#验收)。
- 依赖：T2、T3、T4；各切片的业务测试与所属平台实现完成。
- 交付：server Docker 镜像、四个系统 / 架构目标的 batond SEA、Cursor 与 t3code 原生依赖的附带目录及 Runtime、agent-host 子命令；切换构建发布入口并删除 Go。
- 边界：完成打包集成、安装包缺陷修复与交付复验；不新增 Agent、补造业务模块或改变支持策略。既有交付组合的回归失败阻塞切换。
- 验证：脱离源码、无系统 Node、无运行时依赖下载时启动安装包；缺少 SDK 附带目录会明确失败，来源、许可与静态夹具保留。
- 验证：三类系统上运行本地故障恢复、替身进程回收、冷启动、FULL 与 Agent 离线转录回放；各 Agent 只启用已通过离线行为及本地安装包检查的组合，Go 删除后的 CI 不再调用 Go 导出器。
- 验证：工作区静态检查、测试、Web 构建和安装包检查通过，长期文档同步；Baton 验证表中的负载测试按明确阈值执行，阈值缺项须在切换前确定。
