# Agent host

`agent-host` 是 batond 可执行文件的子命令，在一个独立进程里运行 t3code 的 `ProviderAdapterV2`。执行 host 的实际 cwd 为 Thread 工作目录，只读探测 host 的实际 cwd 为临时空目录。Worker 通过 stdio NDJSON RPC 驱动它。`agents/thread-agents.ts` 只装配执行工厂，能力来自纯数据的 `agents/catalog.ts`；daemon 与普通 CLI 通过 `agents/probe.ts` 探测。`cli/agent-host.ts` 持有逐项动态加载表，执行时只加载选中的 host module，`agent-host --probe` 实际加载全部模块并检查安装包原生依赖。Worker 不加载 SDK、provider adapter 或 host driver；构建从两个 Worker 入口检查运行时依赖图，拒绝绕入 CLI、探测、host 实现或 SDK 的依赖。

## 进程模型

每个 Thread 的执行生命周期对应一个 host 进程。Worker 用 `spawnOwnedProcessEffect` 创建进程：POSIX 上 `detached: true`，host 成为新进程组的组长；Windows 上 host 是普通子进程，PID 与创建时间登记到 Worker 账本。Cursor SDK 的 detached 子进程并入 host 进程组；Pi、Codex、Kiro 保留上游自建的进程组，供上游的 `kill(-pid)` 使用。包装后的 `ChildProcessSpawner` 将 POSIX 独立组登记给 host 内部的 registrar/watchdog，Worker 的持久进程账本登记 host 根进程；Windows registrar 返回 false，不另记上游子进程。释放独立组登记前回收整棵子树。registrar 仅在回收成功或确认 PID 身份不符后注销；超时和检查失败会返回错误、记录警告并保留登记，供 watchdog 在 host 退出后继续回收。

host 运行入口设置 POSIX `umask 077`，把 `console` 定向到 stderr，stdout 只承载 RPC。Scope 结束时关闭 driver，adapter/spawner 释放各自资源，registrar 关闭 watchdog；`runAgentHost` 没有统一调用进程组 policy 的终止与静默 finalizer。Worker 负责外层整树回收，host 退出本身不能代替回收证据。

## 宿主层

`host-layer.ts` 给 adapter 提供它要求的 Effect service：

| service | 实现 |
|---|---|
| `ChildProcessSpawner`、`FileSystem`、`Path`、`Crypto` | `@effect/platform-node`；spawner 在 POSIX 登记独立组到 host registrar/watchdog；Windows 不另行登记 |
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
| `probe` | 只读探测，不执行 Thread 的 open/resume，不发送 prompt 或调用 auth/login；Kiro 的上游发现会建立空会话，并在上游 status 之外运行 `kiro-cli --version` |
| `open` | 建立原生会话并持久化映射；成功后才允许后续请求 |
| `resume` | 读取映射后恢复原生会话 |
| `send` | 排队消息调用 `startTurn`；Pi、Codex 的插入调用 `steerTurn`，成功表示原生接受；Cursor、Kiro 不支持插入 |
| `sent` | 只读核对，由独立 host 进程执行 |
| `answer` | 将显式答案或取消返回原提问请求 |
| `events` | 订阅 item、reply、end、question、question.resolved、uncertain、barrier 和合并后的文本增量 |
| `flushEvents` | 补发当前 run 的未终态项，并在控制队列写入 barrier；Worker 持久处理此前事件后确认 barrier |
| `abort`、`close` | 停止当前回合或关闭 host |

普通请求共用七个额度，`abort` 和 `close` 单独一个额度。RPC 调用有 32 秒预算，adapter 内的原生调用预算是 30 秒。RPC 失败和 uncertain 事件只记录错误并通知 Worker；连接 Scope 由拥有者在清理时关闭，避免客户端 fiber 同步关闭其自身所在的 Scope。

事件流带 host 本地 `generation` 和递增 `sequence`。Worker 在 generation 变化或序号不连续时报 `uncertain`，不会把重连前后的帧拼在一起。文本增量进入 Worker 侧的有界环形缓冲，控制事件进入有界队列，反压时不丢控制事件。停止和 unknown 清理任务在 jobs 队列外等待 `flushEvents` 的 barrier，Worker 按序处理此前事件后确认，之后才回收执行实例并写结束报告；屏障确认失败会冻结 Worker。进入 unknown 时，已接受的活动 Turn 保持未结束，只继续处理原生会话、消息和执行身份匹配的 item、reply，并暂存 end 的 tokenUsage。清理完成后依次保存 `turn.ended` 和 `thread.unknown`，清理期间到达的原生 end 不提前标记 Turn 结束，也不恢复 idle。待报告的 unknown 原因和 tokenUsage 保存在账本；Worker 重开并确认旧进程树已回收后，仍保持 unknown，补保存带 tokenUsage 的 `turn.ended` 和 `thread.unknown`，清除待报告原因。尚未取得接受证据的事件保留在输入缓冲，核对接受身份后，在结束报告之前持久处理。

## 过程记录

通用 driver 只接收当前 run 的 `turn_item.updated`。每项首次进入 completed、failed、cancelled 或 interrupted 时发出一次 `item`；后续更新忽略。尚未终态的项只保留最新版本，回合结束、停止或关闭时按 ordinal 补发，保留最后状态并排在 `end` 之前。assistant_message 和 user_message 不生成过程项。用户问题和 MCP elicitation 保留原问题流程，同时作为过程项保存。driver 记录本轮最后一次提供的 `provider_turn.updated.tokenUsage`，由 `end.tokenUsage` 传给 Worker，作为 `turn.ended.token_usage` 原样持久化。

Worker 按 Turn 和原始项 ID 去重。原始 ID 独立保存在 outbox，ACK 和账本重开后继续保留。顶层 id、parent_id 超过 512 字节、含无效展示字符或占用映射前缀时稳定映射为 `baton:item:sha256:…`；其他顶层展示文字替换 NUL 和孤立代理，metadata 标记 `item_text_sanitized`。嵌套 data 的字符串和对象键保留原文，JSON 序列化负责转义。

整项 `JSON.stringify(item)` 最多 192 KiB，包含重复的索引字段与 data。超限时保留原 data JSON 到设备的 `full-output/`，反复将最长字符串缩成首尾两段，按 JSON 编码字节计量并保留完整字符。字符串裁剪最多 256 次；结构本身仍超限或已没有可裁剪字符串时，将摘要 data 置为 null，并标记 `metadata.item_structure_omitted:true`。顶层 title 同样计入预算，完整报告另有 224 KiB 上限。`truncated` 表示容量裁剪，`original_bytes` 是原 data JSON 的 UTF-8 字节数，字符展示映射本身不改变截断标记。全文写入成功后，摘要与 `turn.item` outbox 在同一账本事务保存。

shell 独立保留最多 192 KiB 的首尾输出作为 command_execution 项，回复沿用首尾合计 32 KiB 的摘要。完成记录同时保存两份有界输出和命令，先发 item 再发 reply；Worker 将项 ID 固定为 `shell:<worker_turn_seq>`。停止和完成记录恢复沿用同一顺序及去重身份。Worker 继续按整项 192 KiB 预算裁剪过程项，全文引用沿用 shell 已保存的 stdout/stderr 原始字节；文本以 UTF-8 保存，二进制输出用 base64 表示。shell 在读取输出时累计完整 JSON 编码字节数，`original_bytes` 包含未裁剪输出在 data 中的编码大小，`metadata.shell_output_bytes` 另记原始输出的真实字节数。

`driver.ts` 的 `makeProviderHostDriver` 统一处理会话映射、执行权限、事件归属、迟到事件过滤和发送确认；各 Agent 构造 adapter 和只读探测。上游待审批请求和问题按请求 ID 关联，通过 host 事件、Worker 账本和中心送到网页等待回答。网页回答经持久 `answer` 命令和 host RPC 返回原请求；审批决策限于上游提供的选项，Codex MCP 请求保留上游的确认语义，普通问题传入用户答案。停止或关闭后的 pending 请求取消。

Kiro 的版本命令使用 host 的 Node Effect spawner 和 process registrar，4 秒超时，stdout/stderr 各最多收集 4096 字节，由 Scope 与进程回收路径清理。探测只返回版本号，诊断不外传。公共探测对程序已安装且认证为 valid 或 unknown 的组合报告 `available` 并开放 create/resume，版本与系统不设白名单。认证 `unknown` 保留首次执行由原生程序检查的 reason，明确 `missing` 或缺程序时报告 `unavailable`；整次 host 探测失败且安装状态未确认时报告 `unverified`。

上游 `turn.terminal` 的 `failed` 映射为带原生会话、输入和执行身份的 `end` 事件，`outcome: failed`，并附安全原因。Worker 以现有 `turn.ended` 报告的 `reason: failed` 与 `content` 保存结果，输入保持 sent，队列继续执行；没有排队消息时 Thread 回到 idle，host 和原生会话保留。回答投递无法确认时保留命令的 unknown 结果；事件流断开、输入发送结果无法确认，以及 host 崩溃或连接丢失仍走 Thread uncertain 路径。

Kiro 通过通用 driver 的 `turnFailure` 回调将明确的回合认证失败映射为“Sign in to Kiro CLI and try again.”，其他 provider 错误使用“Check Kiro CLI on this device and try again.”；其他 Agent 使用固定的 `Send your message again or check <Agent> on this device.`。这些原因不透传原始错误，不自动登录或重发输入。

## 只读核对

`sent` 不依赖活动执行通道。Worker 为每次核对新建 host，host 用映射恢复 `OrchestrationV2ProviderThread` 后调用 `readThreadSnapshot`，把快照投影成 `{ id, role, text }`。Pi 先绑定既有原生线程，再读 active-branch 快照；Codex 在自己的 host driver 中从原生 turns/items 提取 user 文本；Kiro 的通用 driver 选项 `resumeOnOpen` 为 `true`，resume 与 sent 的 `openSession` 都传入 `initialNativeThreadId`，避免先创建空会话；随后经 `session/list` 核对 ID 与 cwd，再用 `session/load` 恢复或取得快照，失败不新建替代会话。通用驱动用账本中已确认的发送数定位下一条 user 消息，只有正文相同才确认；否则返回未确认。

Worker 将插入固定到接收时的活动回合，目标结束后仍未写入 intent 的输入撤回；成功插入保持上游返回的执行归属。插入失败时，普通快照的正文存在不足以确认目标回合，Worker 将结果记为 unknown，不再次发送。

## 验证

包内测试覆盖环境白名单、宿主路径与只读凭据，以及用本地替身拉起 detached 子进程和后代后的整树回收。各 Agent 的 stdio/RPC 回放说明见 [Cursor](../agents/cursor/README.md)、[Pi](../agents/pi/README.md)、[Codex](../agents/codex/README.md)、[Kiro](../agents/kiro/README.md) 文档，均使用 fork 的 testkit 和离线转录。Kiro 2.32.0 夹具是授权保留的旧录制转换，README 与 metadata 明确原生版本；`provider_error` 及派生认证失败夹具与 `simple` 的成功回合组成同会话转录，驱动真实 adapter、host 与 Worker，核对失败结束、安全原因持久化、输入保持 sent、排队消息执行和进程保留。版本探测使用本地可执行替身验证解析、失败、缺程序与超时回收，不启动真实 CLI。离线验证不能证明真实账号授权有效，节点按安装与认证结果报告可用性，版本和系统保留为诊断信息。

部署与设备接入见 [根 README](../../../../README.md)，验证命令见 [AGENTS.md](../../../../AGENTS.md#常用构建与验证命令)。
