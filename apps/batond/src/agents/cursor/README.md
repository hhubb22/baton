# Cursor 接入

本模块把 t3code 的 Cursor adapter 接入 batond。`host-module.ts` 由 `cli/agent-host.ts` 按类型动态加载，Cursor adapter、SDK 和原生 store 在 Cursor host 内运行。Worker 使用公共 `agents/thread-agents.ts` 工厂与纯数据 catalog；daemon 和普通 CLI 使用公共 `agents/probe.ts`。构建检查保证 Worker 不加载探测、SDK、provider adapter 或 host driver。

## 入口

- `makeThreadAgentFactory(options)`：按 `agent_type` 创建 ThreadAgent，推导绝对工作目录和私有状态目录，open/resume 后才启动 host。
- `probeAgents({ dataDirectory, agentTypes })`：在临时空工作目录的只读 host 中探测，Cursor 预检 SDK 资产和显式 API key。
- `cursorAgentHostModule`：`agent-host` 子命令按 `cursor` 类型加载的 driver 层。

`host-driver.ts` 用 fork 导出的 `makeCursorAdapterV2` 构造 adapter，会话与事件映射交给 `agent-host/driver.ts` 的通用驱动，环境取 host 进程已白名单过滤的 `process.env`。模型来自 `config.model ?? adapter_config.model ?? 'default'`；`runtimeMode` 为 `approval-required`、`approvalPolicy` 为 `never`、`interactionMode` 为 `default`，原生 sandbox 保持开启。上游 Cursor adapter 不支持 steer，`send` 只接受队列模式。`switch_model` 为 true，排队消息的逐轮模型同时传入上游 `startTurn.modelSelection` 和 `appThread.modelSelection`；adapter 在恢复会话和 SDK send 时使用该选择。SDK 明确报告模型不可用时，输入尚未提交，该条消息持久撤回并继续队列；超时、断连和其他不能证明未提交的失败保持 unknown，恢复只查证据，不重发输入。

## 认证与探测

认证只用设备上显式设置的 `CURSOR_API_KEY`。它经 host 环境传给 adapter 的 `environment`，不写入配置、映射、报告或日志；`ProviderHost.credentials` 是只读空实现，不接 keyring 或浏览器登录。

`agents/probe.ts` 在独立 host 中调用 driver 的探测：`sdk-inspection.ts` 读取磁盘 SDK 的实际版本、平台包版本、Node 要求和资产路径；宿主再执行 sandbox helper 与 `rg`，调用 `Cursor.me`，用临时空目录和关闭 ambient settings 的 SDK prewarm 检查 sandbox，最后查询模型目录。认证查询失败时仍检查 sandbox。`details` 记录 `installed`、`version`、`platform`、`integrity` 和 `sandboxHelper`。SDK 安装完整且认证为 valid 或 unknown 时，公共探测报告 available 并开放新建与恢复；缺 SDK、平台资产不完整、辅助程序不可执行、sandbox 检查明确失败或缺少显式 API key 时报告 unavailable。系统和版本不设白名单，未知认证、版本与模型目录问题保留在 reason 中。已确认 SDK 安装完整后，只读 host 探测失败或超时仍允许新建，并报告探测问题。

## 会话与映射

`agent-host/mapping.ts` 在 Thread 私有目录写一个版本 2 的映射文件，内容是 `thread_id`、原生会话 ID、canonical 工作目录、映射路径和完整的 `OrchestrationV2ProviderThread`，用 JSON 编码和原子写保存。open/resume 在返回前完成映射写入；映射的 Thread、路径或工作目录不匹配时拒绝恢复。

- open：`openSession` 后 `ensureThread`，并把 provider thread 写入映射。
- resume：读取映射，用保存的 provider thread 调 `resumeThread`。
- send：每次调用 `startTurn`，原生接受后返回 `runId` 作为执行 ID。
- abort：调用 `interruptTurn` 结束当前回合；close 先中断再关闭 host。

## 事件映射

host 消费 `ProviderAdapterV2` 的事件并映射为 `agent-host` 协议：

| 上游事件 | 映射 |
|---|---|
| `message.updated`（streaming） | `delta`，按消息记录已发送前缀，只发新增文本 |
| `message.updated`（完成） | `reply`，每条 assistant 消息只发一次 |
| `turn.terminal` completed | `end`，outcome `completed` |
| `turn.terminal` interrupted/cancelled | `end`，outcome `cancelled` |
| `turn.terminal` failed | `end`，outcome `failed`，附固定安全原因 |
| `runtime_request.updated` | 通用驱动按权限当次允许、提问转发网页的策略应答；停止后的请求取消 |
| `provider_turn.updated` | 记录 `providerTurnId`，供 abort 使用 |

事件按 `runAttemptId`、`runId` 和序号归属到当前执行，旧 Turn 的迟到消息不能进入下一轮。文本增量立即交给输出流，控制事件进入有界队列；会话事件流失败且不是停止或关闭时发 `uncertain`。

## 发送确认

`sent` 在独立只读 host 里用映射恢复 provider thread，调用 `readThreadSnapshot`，把消息投影成 `{ id, role, text }`。`agent-host/evidence.ts` 用 Worker 账本里的已确认发送数定位下一条 user 消息，只有正文相同才返回确认；准备文档不合法或数量对不上时返回未确认或错误。设备不保存原生历史，Thread 历史从中心记录读取。

## 验证

`host.integration.test.ts` 用 `@t3tools/provider-cursor/testing` 的离线转录和确定性 runner 驱动真实 adapter，经实际 host 子进程的 stdio/RPC 覆盖 open、send、增量、reply、abort、end、resume、sent 的确认与未确认。`agent-host/evidence.test.ts` 覆盖确认位置和准备校验；`agent-host/environment.test.ts` 与 `host-layer.test.ts` 覆盖环境白名单、宿主路径和只读凭据。

回放转录在测试侧按当前 harness 追加运行时说明，并统一原生 sandbox 开关；不改转录原文，也不调用真实 API。运行方式：

```sh
pnpm --filter @baton/batond typecheck
pnpm --filter @baton/batond test
```
