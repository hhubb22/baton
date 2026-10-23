# Cursor 接入

本模块实现 Worker 的 `AgentFactory` / `ThreadAgent`，并提供同一个 batond 可执行文件的 `cursor-host` 子命令入口。Worker 不加载 SDK；SDK、原生 store 和执行回调都在 host 进程中运行。

## 入口与生命周期

`index.ts` 导出：

- `makeCursorAgentFactory(options): AgentFactory`：构造只分配内存状态，调用 open/resume 后才启动进程和读取文件。
- `probeCursor(options)`：有 Scope 的只读探测，不 create/resume Agent，不发送 prompt。
- `CursorDelta`：已核对进程代次、序号、原生会话、消息和执行身份的实时文本增量。

CLI 动态加载 `host.ts`，在 Scope 中运行 `runCursorHost()`。`options.command` 是追加 `cursor-host` 之前的 batond 命令；开发 bundle 通常为 `{ file: process.execPath, args: [bundle] }`，SEA 为 `{ file: process.execPath, args: [] }`。POSIX 必须传 Worker 持有的 watchdog；Windows 必须传持久进程记录回调。进程创建与回收复用 `platform/process.ts`。

`apiKey` 只进入 host 的显式 `CURSOR_API_KEY` 环境。`onDelta` 是立即返回的本地文本接收器；`onDiagnostic` 只接收错误类、tag、code，不包含原始 SDK payload。Worker 获得的错误摘要只包含 SDK 阶段、方法名及 name/code/status。

一个实例对应一次执行生命周期。abort/close/reap 后，Worker 为 resume 或恢复查证建立新实例；已停止实例在 reap 前仍能启动独立只读 host 核查 sent。reap 等待未完成的进程启动，并逐个取得整树回收结果。关闭通道、SDK close 和 root PID 退出均不代替整树停止证据。

## 原生状态与输入证据

`adapter_config.state_path` 必须是绝对路径，其父目录使用私有目录权限。open/resume 完成前原子写入原生映射，记录 Thread、原生 Agent ID、canonical 工作目录、映射位置和 store 位置。SDK 使用同目录下的 `cursor-store/`，通过公开 `SqliteLocalAgentStore` 持久化。

prepare 在十秒内一次读取完整规范化历史，保存 userCount、完整前缀 digest、前缀长度和输入绑定。绑定包含 Thread、原生身份、工作目录、配置位置、输入正文、输入 ID、控制代次、operation ID 和模型。重复准备同一输入复用基准；restore 只恢复内存，不访问文件或 SDK。

send 使用已保存的基准，只调用一次 SDK send。run handle 返回后仍需读取原生历史，核对完整前缀和下一条 user 正文；checkpoint 尚未可见时，在同一三十秒预算内轮询只读证据。超时不重新准备或提交输入。

sent 使用新建的只读 host，不依赖活动执行通道，也不 create/resume Agent。host 打开 SDK store 后先通过公开 `agents.get` 确认原生会话存在且 cwd 匹配；映射仍在而 store 丢失时返回 history unavailable，不能把新空 store 的空列表当成原历史。该元数据校验也供显式 resume 使用。

sent 只接受原生会话、历史前缀、输入位置和正文均匹配的记录。重复正文出现在其他位置、前缀改写或证据缺失均不能确认发送。

Worker 确认旧进程树回收后才能显式 resume。host 在 resume 时通过公开 `store.agents.get`、`store.runs.get` 读取原生 active run；只有 queued/running 遗留 run 才设置 `forceNextInput`。该标记由随后新 Baton 输入的单次 SDK send 消费，对该调用传 `options.local.force: true`；SDK 据此结束崩溃遗留的 active run 并创建新 run。finished/cancelled 等终态不传 force，history、prepare 和 sent 不设置或消费该标记。发送失败直接返回错误，不先失败再重发旧输入。

## SDK 历史

`history.ts` 的 `nativeMessagesFromSdk` 是 prepare、send 确认、sent 和 readHistory 共用的转换。

SDK 1.0.35 的 `Agent.messages.list` 可以把整个 ConversationTurn 放在一条外层 user 记录的 message 中。转换识别 protobuf `turn: { case, value }` 及其 `toJSON()` / `agentConversationTurn` 投影，按顺序拆出 userMessage 和 assistantMessage steps，跳过 thinking 与工具详情。稳定 ID 由原生记录 UUID 和 step 索引组成，不能按外层 type 把整个 turn 当成一条消息。

SDK 返回直接正文记录时复用 provider 的文本转换。readHistory 当前返回完整规范化列表，不接受分页游标；网页快照与分页由上层历史服务负责。

## RPC 与执行事件

host 与 Worker 通过 `effect/rpc` 的 NDJSON stdio 协议通信，Socket retry 为零。SDK console 输出定向到 stderr，stdout 仅传 RPC。正常 stdin EOF 结束独立的 RPC fiber，由父 fiber 消费正常 interruption。

host 在加载 SDK 前设置 POSIX umask 077，并安装平台的 spawn/fork 同组策略，使 SDK 子进程继承 host 的进程组。外层 Worker 对 cursor-host 的独立进程组启动不受影响。生产代理保持到 host 进程退出；Scope 清理会终止剩余子进程并等待静默，终止后的迟到 SDK spawn/fork 被拒绝。

host 的普通请求和事件订阅共用七个额度，abort/close 使用另一个额度。SDK open/send 为三十秒预算，RPC 为三十二秒；失败关闭通道，保留原生结果可能不确定的事实。事件缓冲和句柄建立前的回调缓冲均有界；溢出、序号缺口或归属不符产生 uncertain。

文本增量进入 `onDelta`；assistant 边界产生 reply。原生 run.wait 返回 finished/cancelled 后先发送已收到的 reply，再等待平台 `waitQuiescent` 确认组内没有活动子进程，补发等待期间累计的 reply 后才发送 end。静默等待上限取 execution_timeout_seconds，Worker 仍负责实际执行期限和独立停止计时；SDK root 返回后仍有合法后台子进程时不能转为空闲。工具或 step 完成、取消响应和通道关闭不会生成 end。SDK error 仍产生 uncertain。

abort 先登记取消，再并行请求 SDK cancel 与平台 terminateChildren，不因 SDK cancel 等待而推迟本机子进程终止。句柄稍后返回时再次应用取消和整组终止。强制终止使用短预算，Worker 独立负责整个停止期限与整树回收。

## 执行策略与探测

本地选项保持 `autoReview: true`、`sandboxOptions.enabled: true`、`settingSources: []`、空 MCP 配置和 `enableAgentRetries: false`。未指定模型时显式选择原生目录中的 `default`。Thread 模型固定为 config.model、adapter_config.model 或该原生 default；prepareInput 在采集基准和提交 intent 前拒绝不同的 message.model，同模型或未指定模型继续执行。steer 和中途换模型均不支持。

执行 host 在 create/resume 前通过公开 `createAgentPlatform().prewarmLocalWorkspace` 初始化相同配置，并持有 lease 到 host 结束。SDK 的 helper 必须能按 argv[1]/execPath 的父路径布局找到平台包；仅从 SDK 内部依赖解析到 helper 不足以证明该布局有效。

probe 检查实际 SDK 版本、完整平台资产、helper 可执行性和 `Cursor.me` 认证，再以临时空目录、独立私有 store 和关闭 ambient settings 的公开 prewarm 检查 sandbox。`sandboxHelper: true` 表示该 SDK prewarm 成功，单独运行 helper --help 不会使其为 true。显式禁用的员工 sandbox 配置不会由 probe 改写或覆盖。模型目录查询独立失败时保留已确认的认证结果。设备是否 available 仍由注册表的实际平台验证范围决定。

## 验证

模块测试覆盖完整前缀与重复正文、一次准备与只读恢复、事件归属、普通 RPC 额度占满时取消，以及真实 ConversationTurn 形状。一条实际子进程 stdio/RPC 测试串接 provider SDK 回放 runner，覆盖 open、独立 history、延迟确认、send、增量、abort 和真实 end；上游原始转录保持不变。

在 `apps/batond` 下运行 `pnpm exec vitest run --config ../../vitest.config.ts src/agents/cursor`，并执行应用 typecheck。真实模型和进程故障门控由 `tools/ts-migration/verify-cursor.mjs` 执行；离线回放不代替该门控。
