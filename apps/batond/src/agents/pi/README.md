# Pi 接入

`makePiAgentFactory` 为每个 Thread 创建独立的 `agent-host pi`。host 用 fork 的 `makePiAdapterV2` 构造完整 adapter，由 `agent-host/driver.ts` 统一处理 open、resume、原生映射、事件和发送确认。Worker 保留持久命令、输入 intent、排队、停止裁决和 unknown 状态。

原生程序从 PATH 查找 `pi`。配置目录使用设备上的 `PI_CODING_AGENT_DIR`，会话目录使用 `PI_CODING_AGENT_SESSION_DIR`；host 只继承这些 Pi 配置项和系统必要变量。认证使用原生 CLI 配置。Thread 的模型取 `model ?? adapter_config.model ?? 'default'`；具体模型标识沿用上游的 `provider/model`，`default` 由 Pi 解析为原生配置默认模型。Thread 内固定创建时的选择。

只读探测在临时空工作目录的 host 中调用上游 `checkPiProviderStatus`，检查安装、版本、认证与模型，不发送 prompt、不打开登录。注册表启用 macOS arm64 / Pi 1.0.0 的离线验证组合，其他版本与系统报告 unverified。认证缺失不可创建，认证有效而目录不可读时可用 Pi 默认模型。

Pi 支持活动回合插入：Worker 保存接收时的目标回合，在写 intent 前核对目标仍活动；host 调用上游 `steerTurn`，不创建另一执行。插入归属和提交边界以上游为准；上游发送 prompt 后即可返回，原生 ack 异步到达。host 回执丢失且无法确认目标时进入 unknown；提交成功后收到原生失败事件时，Thread 进入 unknown。权限类请求当次允许，提问（包括 elicitation）取消，停止后的请求全部取消。

Pi 的 RPC 子进程保留 detached 进程组，供上游中断与关闭时按组发送信号。host 的 spawner 将独立组登记给 watchdog 和 Worker，注销前回收整树。恢复核对 Thread、Agent 类型、原生会话、工作目录和 profile 配置位置，不创建空会话替代恢复。

`host.integration.test.ts` 用 `@t3tools/provider-pi/testing` 与上游离线转录驱动实际 host 子进程，覆盖两轮、Worker 插入与排队、插入回执丢失后的 unknown 与重试回执、工具执行中停止、原生恢复及 sent 的确认和未确认。`testing/pi/transcripts.ts` 只在测试侧拆分或派生已有转录。跨 app 的最小链路在 e2e 中验证发送、回复、停止与恢复。
