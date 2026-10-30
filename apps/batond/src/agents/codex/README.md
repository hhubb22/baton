# Codex 接入

公共 `agents/thread-agents.ts` 的 `makeThreadAgentFactory` 按 catalog 能力为每个 Thread 创建独立的 `agent-host codex`。host 用 fork 的 `makeCodexAdapterV2` 构造完整 app-server adapter，由 `agent-host/driver.ts` 统一处理会话映射、事件和 sent 判定。Codex host driver 将原生快照的 turns/items 投影成 user 文本，通用判定仍核对下一条 user 输入的位置和正文。Worker 保留持久命令、输入 intent、排队、停止裁决和 unknown 状态。

原生程序从 PATH 查找 `codex`，认证和配置使用设备的 `CODEX_HOME`，未设置时沿用原生默认位置。host 仅继承该配置项与系统必要变量。模型取 Thread 的 `model` 或 `adapter_config.model`，未指定时使用上游 contracts 的 `DEFAULT_MODEL`；只读探测把上游标记的默认模型放在目录首位。排队消息可逐轮指定模型，host 把该选择同时写入上游 `startTurn.modelSelection` 和 `appThread.modelSelection`，由 adapter 传给原生 `turn/start`；插入消息沿用活动回合模型。

探测保留上游每个模型的 `reasoningEffort` 选项及默认值；排队消息的思考强度随模型选择传入上游，省略时使用 Codex 默认值。

运行策略由保存的 Thread 执行权限交给上游 adapter 映射。待审批请求与提问（含 MCP elicitation）转发网页等待回答，停止后到达的请求一律取消。

公共 `agents/probe.ts` 的只读探测在临时空工作目录的 host 中执行上游 Codex 安装、版本、认证和模型检查，不发送 prompt、不打开登录。程序已安装且认证为 valid 或 unknown 时报告 available，开放新建与恢复；缺程序或明确 missing 时报告 unavailable。版本、系统、认证未知和模型目录缺失写入 reason，不另设版本或系统白名单；版本未知不阻止新建，目录不可读时使用上游默认模型。整次 host 探测失败且安装状态未确认时报告 unverified。上游支持会话内换模型，`switch_model` 为 true。提交失败且不能证明原生尚未接收输入时保留 unknown，只查证据，不自动重发；显式恢复使用最近确认提交的回合模型。

Codex 支持 `steerTurn`。Worker 保存接收时的活动目标回合，写 intent 前核对目标；host 保留上游的原生插入归属。提交成功时保持同一执行，结果无法确认时进入 unknown，不重发该输入。独立 app-server 子进程保留上游进程组，POSIX spawner 登记到 host 内部 registrar/watchdog，注销前回收后代。Worker 持久账本登记 host 根；Windows registrar 不另记上游子进程。恢复核对原生映射与 profile 配置位置。

`host.integration.test.ts` 使用 `@t3tools/provider-codex/testing` 和上游 app-server 转录，驱动实际 host 的 stdio/RPC。测试侧通过上游 workspace materializer 替换 `<workspace>`，不改变生产 adapter 或回放 matcher。上游测试覆盖协议细节，Baton 回放覆盖宿主差异；跨 app 的最小链路在 e2e 中验证发送、回复、停止与恢复。

部署与设备接入见 [根 README](../../../../../README.md)，验证命令见 [AGENTS.md](../../../../../AGENTS.md#常用构建与验证命令)。
