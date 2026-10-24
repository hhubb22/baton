# Agent host

`agent-host` 是 batond 可执行文件的子命令，在一个独立进程里运行 t3code 的 `ProviderAdapterV2`。Worker 通过 stdio NDJSON RPC 驱动它，不加载 t3code 包或 SDK。

## 进程模型

每个 Thread 的执行生命周期对应一个 host 进程。Worker 用 `spawnOwnedProcessEffect` 创建进程：POSIX 上 `detached: true`，host 成为新进程组的组长；Windows 上 host 是普通子进程，PID 与创建时间登记到 Worker 账本。上游 adapter 拉起的子进程继承 host 进程组，包装后的 `ChildProcessSpawner` 遇到上游自建进程组时，用返回的 PID 作为 pgid 登记给 watchdog 管道。

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

host 进程的环境变量只包含系统必需项（`PATH`、`HOME`、临时目录、语言区域）和当前 Agent 的配置项；Cursor 只加 `CURSOR_API_KEY`。其他提供商的密钥和 Project Runtime 凭据留在 Worker。`continuationRequests` 不提供。

## RPC

协议在 `protocol.ts` 中定义，通过 `effect/rpc` 的 NDJSON stdio 传输，Socket 重试为零：

| 请求 | 行为 |
|---|---|
| `probe` | 只读探测，不 open/resume，不发送 prompt |
| `open` | 建立原生会话并持久化映射；成功后才允许后续请求 |
| `resume` | 读取映射后恢复原生会话 |
| `send` | 提交一条队列消息；成功表示原生接受 |
| `sent` | 只读核对，由独立 host 进程执行 |
| `events` | 订阅 reply、end、uncertain 和合并后的文本增量 |
| `abort`、`close` | 停止当前回合或关闭 host |

普通请求共用七个额度，`abort` 和 `close` 单独一个额度。RPC 调用有 32 秒预算，adapter 内的原生调用预算是 30 秒。

事件流带 host 本地 `generation` 和递增 `sequence`。Worker 在 generation 变化或序号不连续时报 `uncertain`，不会把重连前后的帧拼在一起。文本增量进入 Worker 侧的有界环形缓冲，控制事件进入有界队列，反压时不丢控制事件。

## 只读核对

`sent` 不依赖活动执行通道。Worker 为每次核对新建 host，host 用映射恢复 `OrchestrationV2ProviderThread` 后调用 `readThreadSnapshot`，把 user/assistant 消息投影成 `{ id, role, text }` 返回。Worker 用账本中已确认的发送数定位下一条 user 消息，只有正文相同才确认；否则返回未确认。

## 验证

包内测试覆盖环境白名单、宿主路径与只读凭据，以及用本地替身拉起 detached 子进程和后代后的整树回收。Cursor 的 stdio/RPC 集成测试见 [Cursor 文档](../agents/cursor/README.md)。
