# Project Agent：长期协调角色与中心化状态

Status: proposed
Date: 2026-10-18
Related: [Project Agent 行为规格](../project-agent/PRODUCT.md)、[技术设计](../project-agent/TECH.md)、[Baton 行为规格](../baton/PRODUCT.md)

## 背景

2026-10-17 批准的 Baton 以 Task 为协调单位：Ubuntu 上的 Agent 把工作委托给员工 PC，完整 Session 历史留在节点。员工希望再有一个长期存在的协调者：每个 Project 一个，记得项目里的决定，把工作派给任意一台设备，结果回来时它可能已经不在运行，下次可以换一台设备接着处理。原设计有三处装不下它：`sessions` 把会话固定在一个节点上；子结果交付要求来源 Worker 仍在；完整历史只在节点。

## 决定

1. **节点平等。** 去掉 `pc` / `ubuntu` 角色，默认 PC 改为默认设备。默认设备用于未指定目标的委托，也是 Project Agent 优先运行的位置。
2. **Project 不绑定仓库或设备。** Project 是员工的一件长期的事；工作目录在每次派发任务时由 Project Agent 决定。
3. **Project Agent 只做协调和环境管理。** 它派任务给执行 Agent，自己不写代码。员工在某台设备上开启后，它可以在该设备上执行命令，例如创建 worktree。
4. **推理在员工设备上，使用设备上已登录的订阅。** 北京不做推理，不保存订阅凭据。
5. **Project Agent 的状态全部在北京。** 主对话、记忆和 Inbox 由 Coordinator 保存。Runtime 按事件启动，处理完就退出；换设备就是下一次在另一台设备上启动，不迁移运行中的进程。
6. **执行 Session 的历史仍留在节点。** 只有 Project Agent 的主对话保存在北京，原 R-28、R-29 对执行 Session 的约定不变。
7. **Runtime 使用 pi-agent-core，在独立的 Node.js 进程里运行。** 模型消息按 pi-ai 的格式逐条保存为对话事件，发给模型的上下文每次都从这些事件推导出来，不另存会话文件或检查点。Go 进程仍不嵌入 Agent SDK。
8. **每个工具调用最多执行一次。** assistant 消息在工具执行前保存；工具的副作用和工具结果在同一个数据库事务里提交。命令执行的副作用在另一台设备上，因此每条命令实现为一个 Task，靠现有的任务唯一性和待核实机制保证。
9. **Runtime 只经 batond 和 Relay 与北京通信。** 不新开节点直接访问 Coordinator 的通道。
10. **Baton 不实现目录准备。** 任务的工作目录必须已经存在；需要新目录时，由 Project Agent 用命令创建。

## 考虑过的其他方案

- **DSH 作为 Runtime。** 它的会话持久化接口和压缩设计比 Pi 默认实现更接近需要，本设计参考了这两部分。没有采用，因为它只能在完整的 DSH 运行时里使用，目前仍是开发者预览，并且不支持 Sign in with ChatGPT。
- **`pi-coding-agent` 或 `pi-durable`。** 前者的会话只能写本地 JSONL 文件，还自带编程工具；后者的存储接口复杂，并标为 Experimental。
- **保存 Runtime 的原生会话文件包。** 上一版草案设计了白名单文件包、分块归档和前缀校验。改用 pi-agent-core 之后，消息本身就是状态，这一层不再需要。
- **Project Agent 在北京运行。** 可以省掉租约和放置，但需要北京持有模型凭据并承担推理负载，员工大多只有订阅、没有 API key。
- **执行 Session 历史也集中保存。** 会扩大到所有执行 Agent 的适配和界面工单，Project Agent 本身用不上。

## 影响

- 需要三个新迁移（0015～0017），以及 Coordinator、batond、Session Worker 和 Web 的改动，另加一个 TypeScript 程序 `baton-project-runtime`。承载 Project Agent 的设备要安装 Node.js。
- Pi 和 Codex 执行 Agent 的接入（PS-118、PS-119）不受影响。
- 命令执行没有沙箱。任务结果或仓库内容里注入的指令，可能让 Project Agent 在开启了命令执行的设备上执行任意命令。开关默认关闭，按设备开启，命令和输出完整记录在对话里。
- 消息格式和 pi-ai 绑定。将来更换 Runtime 时，需要从 `pi-ai/1` 格式转换。
