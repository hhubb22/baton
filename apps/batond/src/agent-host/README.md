# Agent host

`agent-host` 是 batond 可执行文件的子命令，在一个独立进程里运行 t3code 的 `ProviderAdapterV2`。执行 host 的实际 cwd 为 Thread 工作目录，只读探测 host 的实际 cwd 为临时空目录。Worker 通过 stdio NDJSON RPC 驱动它，不加载 t3code 包或 SDK。

## 进程模型

每个 Thread 的执行生命周期对应一个 host 进程。Worker 用 `spawnOwnedProcessEffect` 创建进程：POSIX 上 `detached: true`，host 成为新进程组的组长；Windows 上 host 是普通子进程，PID 与创建时间登记到 Worker 账本。Cursor SDK 的 detached 子进程并入 host 进程组；Pi、Codex、Kiro 保留上游自建的进程组，供上游的 `kill(-pid)` 使用。包装后的 `ChildProcessSpawner` 将这些独立进程组登记给 watchdog 与 Worker 进程账本，释放登记前回收整棵子树。

host 在加载 SDK 前设置 POSIX `umask 077`，把 `console` 定向到 stderr，stdout 只承载 RPC。Scope 结束时关闭 adapter、终止组内子进程并等待静默；进程组回收由 Worker 的整树停止路径完成，host 自己报告的退出不能代替回收证据。

## 宿主层

`host-layer.ts` 给 adapter 提供它要求的 Effect service：

| service | 实现 |
|---|---|
| `ChildProcessSpawner`、`FileSystem`、`Path`、`Crypto` | `@effect/platform-node`；spawner 包装后登记 detached 进程组与 Windows 进程记录 |
| `AgentScope` | host 执行 Scope；`wrap` 只透传命令参数，`stop`、`clear` 为空 |
| `ProviderHost` | `cwd` 为 Thread 工作目录，`stateDir`、缓存和附件目录在 Thread 私有目录下；settings 是 `DEFAULT_SERVER_SETTINGS` 的静态快照；`shouldRunBackgroundWork` 返回 false；凭据读取返回空，写入和删除直接失败 |
| `McpProviderSessions` | provider-core 的内存实现，不写配置文件 |
| `IdAllocator` | provider-core 的实现，adapter 和事件映射共用同一组派生 ID |
| Kiro 专用层 | `AcpRegistryCatalog` 使用 fork 的 host layer，补充 Fetch HTTP client 与空事件 logger；settings 固定为 local，不访问 registry 或下载程序 |

host 进程的环境变量只包含系统必需项（`PATH`、`HOME`、`USER`、`LOGNAME`、`SHELL`、临时目录、语言区域）和当前 Agent 的配置项：Cursor 的 `CURSOR_API_KEY`，Pi 的 `PI_CODING_AGENT_DIR`、`PI_CODING_AGENT_SESSION_DIR`，Codex 的 `CODEX_HOME`。Kiro 不增加专有环境变量，只使用系统项；其原生 profile 按 `homedir()` 记录。其他提供商的密钥和 Project Runtime 凭据留在 Worker。`continuationRequests` 不提供。

## RPC

协议在 `protocol.ts` 中定义，通过 `effect/rpc` 的 NDJSON stdio 传输，Socket 重试为零：

| 请求 | 行为 |
|---|---|
| `probe` | 只读探测，不执行 Thread 的 open/resume，不发送 prompt；Kiro 的上游发现会建立空会话 |
| `open` | 建立原生会话并持久化映射；成功后才允许后续请求 |
| `resume` | 读取映射后恢复原生会话 |
| `send` | 排队消息调用 `startTurn`；Pi、Codex 的插入调用 `steerTurn`，成功表示原生接受；Cursor、Kiro 不支持插入 |
| `sent` | 只读核对，由独立 host 进程执行 |
| `events` | 订阅 reply、end、uncertain 和合并后的文本增量 |
| `abort`、`close` | 停止当前回合或关闭 host |

普通请求共用七个额度，`abort` 和 `close` 单独一个额度。RPC 调用有 32 秒预算，adapter 内的原生调用预算是 30 秒。RPC 失败和 uncertain 事件只记录错误并通知 Worker；连接 Scope 由拥有者在清理时关闭，避免客户端 fiber 同步关闭其自身所在的 Scope。

事件流带 host 本地 `generation` 和递增 `sequence`。Worker 在 generation 变化或序号不连续时报 `uncertain`，不会把重连前后的帧拼在一起。文本增量进入 Worker 侧的有界环形缓冲，控制事件进入有界队列，反压时不丢控制事件。

`driver.ts` 的 `makeProviderHostDriver` 统一处理会话映射、事件归属、迟到事件过滤和发送确认；各 Agent 只构造 adapter、配置策略和只读探测。`runtime_request.updated` 中的 `command`、`file-read`、`file-change`、`permission` 当次 `accept`，提问（包括 `mcp-elicitation`）与其他请求 `cancel`；user input 取消时同时传空 `answers`。停止或关闭后的 pending 请求一律取消，不写永久授权。

## 只读核对

`sent` 不依赖活动执行通道。Worker 为每次核对新建 host，host 用映射恢复 `OrchestrationV2ProviderThread` 后调用 `readThreadSnapshot`，把快照投影成 `{ id, role, text }`。Pi 先绑定既有原生线程，再读 active-branch 快照；Codex 在自己的 host driver 中从原生 turns/items 提取 user 文本；Kiro 的通用 driver 选项 `resumeOnOpen` 为 `true`，resume 与 sent 的 `openSession` 都传入 `initialNativeThreadId`，避免先创建空会话；随后经 `session/list` 核对 ID 与 cwd，再用 `session/load` 恢复或取得快照，失败不新建替代会话。通用驱动用账本中已确认的发送数定位下一条 user 消息，只有正文相同才确认；否则返回未确认。

Worker 将插入固定到接收时的活动回合，目标结束后仍未写入 intent 的输入撤回；成功插入保持上游返回的执行归属。插入失败时，普通快照的正文存在不足以确认目标回合，Worker 将结果记为 unknown，不再次发送。

## 验证

包内测试覆盖环境白名单、宿主路径与只读凭据，以及用本地替身拉起 detached 子进程和后代后的整树回收。各 Agent 的 stdio/RPC 回放说明见 [Cursor](../agents/cursor/README.md)、[Pi](../agents/pi/README.md)、[Codex](../agents/codex/README.md)、[Kiro](../agents/kiro/README.md) 文档，均使用 fork 的 testkit 和离线转录。Kiro 2.32.0 夹具是授权保留的旧录制转换；其上游探测尚不能确认认证与本地版本，生产报告保持 `unverified`、`create: false`、`resume: false`，离线行为验证不改变准入结果。
