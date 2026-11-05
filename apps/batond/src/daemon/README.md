# 远程节点

`login` 经本地控制通道发起设备码登录并在浏览器确认后保存身份；`run` 读取已有身份并保持出站 WSS，`serve` 用于按需后台拉起。连接地址来自身份中的 HTTPS 中心源，TLS 使用系统根证书库，支持显式 relay；CLI 只打印公开身份摘要。登录成功后原子保存身份，不再保存部署配置或自定义 CA。部署和配置用法见根 README。

私有目录中的 `identity.json` 保存中心签发的 JWT；授权目录由 [`devices/roots.ts`](../devices/roots.ts) 统一读写和检查，配置格式、数量上限与加锁规则见 [设备管理与文件访问](../devices/README.md)。仅配置文件不存在时登记用户主目录，已有空列表保留。`serve` / `run` 的 `--workspace` 按真实路径幂等添加目录。open、message 和 resume 下发前复核工作目录的真实路径与授权根；stop、withdraw 使用已登记的 Thread 身份与代次，撤销授权或删除工作目录后仍可停止和撤回。目录和文件预览由 `devices/` 提供，使用同一授权根；目录符号链接解析后须仍在该根内，文件预览保留字节上限与分页信息。

每个数据目录由进程锁保证只有一个 daemon。Thread 状态机和 Execution 状态机在 daemon 进程内运行，agent-host 与 Project Runtime 是受监管的子进程；daemon 退出时关闭状态机并回收已登记进程，不再有独立 Worker 锁或 worker IPC 端点。所有 Thread 共用 `node.db`，通过 `@baton/sqlite` 使用 WAL、`synchronous=FULL` 和提交结果核查。命令以中心 envelope 的 `message_id` 作为 command ID，持久保存内容 hash、请求、open 配置、存储代次和接收回执；同一事务保存 Thread 元数据、消息、命令和报告 outbox。接收回执表示状态机已持久接收，实际完成由 `command.completed` 报告。能力或目录等接入条件明确不满足、状态机明确拒绝命令时，才返回失败回执。

`node.db` 的 `threads.control_json` 保存 `ready`、`launch_attempted` 和 `history_unavailable`。新配置的 `startup_phase` 为 `awaiting_open`；daemon 或本地 IPC 在交付 open 前先提交 `open_attempted`。仍是 `awaiting_open` 且没有命令、消息、进程及报告记录时，可重试启动并沿用原 command ID、配置及代次；已经可能交付 open 后，账本缺失、为空或损坏时上报 `thread.unknown` 和 `history_unavailable:true`，阻止创建空会话。历史缺失不作为 Agent 已停止的证据，网页保持未知结果。

Thread 报告先写入 `thread_outbox`，再由 daemon 上报中心。`thread_outbox.acked` 表示中心已确认，`worker_acked` 表示状态机已消费；两者分开记录，避免本地消费确认误删尚未上报中心的报告。报告响应同时提供 Thread 身份、代次、Runtime 模式及空闲标记，正常采集不额外发送 status。活跃 Thread 默认每轮等待 250ms；确认空闲且没有待报事件后逐步退避至五秒，新命令立即唤醒采集。单连接最多保留 8 条未确认报告，每秒最多尝试发送 32 条，中心 ACK 释放发送窗口；超时按原事件身份补送。中心确认按 Thread、event ID 和 Worker 序号核对；收到 `expected_worker_seq` 时重新发送该序号起的报告。

`node_processes` 登记 `thread` 与 `execution` 两类 owner 的 pid、创建时间和角色。agent-host 在 Thread 空闲且没有活动回合、排队输入或待回答问题十分钟后关闭并回收进程树；下一条输入透明 resume 原生会话。启动恢复先核对 `node_processes` 和 pending open 命令，再决定只读核对 intent 或直接恢复；未确认回收的进程保持 unknown，不重新启动。Execution 复用同一登记表，提交、停止和报告都先持久化，重启后按 completion 证据补报而不重跑命令。

`session.request` 的输出读取原样转发为 Thread 状态机的 `session_request`；实时输出不写入节点报告账本。网页时间线与 Project 工具从中心读取已保存的 Thread 输入、回复和事件，设备上的原生历史仍由各 Agent 管理，Baton 不提供原生历史查询接口。

连接断开后按 1～30 秒指数退避并加入 jitter，同一次 daemon 运行沿用 incarnation。明确的凭据拒绝立即停止；认证临时不可用或没有明确拒绝码时继续重连。认证成功后发送 `node.sync` 与心跳；匹配的同步回执成功后发送 Thread 和能力报告。`--control-timeout-seconds` 设置认证与同步各自的等待预算，默认 370 秒，范围 1～3600 秒的整数。公共 `agents/probe.ts` 按 catalog 顺序并发探测，成功结果缓存五分钟，不可用或未确认结果按三十秒至五分钟退避；环境、原生凭据或 CLI 元数据指纹变化后重新探测。

Project manager 在 WSS 连接循环外构造，连接同步后绑定当前 RPC transport，断线时取消旧请求并保留运行中的 Runtime。每条连接最多 64 个 Project 请求在途，响应只匹配本连接的 correlation ID。start、stop、wake 在独立任务中处理，Runtime 的节点管理操作与业务 stdio 请求分开授权。租约、持久清理事实和 Thread 版本等待见 [Project Runtime 宿主](../project/README.md)。

设备目录、仓库、执行授权和订阅报告在独立采集循环中更新，通常每五秒检查一次分项缓存；连接建立或配置变化触发刷新。仓库扫描缓存五分钟，Runtime 成功探测缓存一分钟，各项配置变化只刷新对应结果。目录扫描使用两秒预算，Runtime probe 使用独立配置预算（默认五秒）；Agent 探测继续独立运行。最终报告按带缩进 JSON 计量并裁剪至 64 KiB，先裁仓库和模型，再裁目录；裁剪按二分搜索保留列表前缀，Agent 默认模型不被删除。

## 嵌入接口

`identity.ts`、`daemon.ts`、`in-process-host.ts` 和 `control.ts` 分别导出：

- `loadIdentity(dataDirectory)` / `saveDeviceIdentity(dataDirectory, identity, coordinatorURL)` / `clearIdentity(dataDirectory)`：读取、原子保存和删除设备身份；身份中保存中心 URL 和中心签发的凭据。
- `runDaemon(options): Effect.Effect<void, Error, Scope.Scope>`，选项为 `dataDirectory`，可选的 `identity`、`relayURL`、`controlTimeoutSeconds`、`heartbeatMs`、`pollIntervalMs`、`transport`、`host`、`project` 和 `watchdogCommand`。默认 host 使用 `InProcessWorkerHost`，在 daemon 进程内构造 Thread 状态机和 agent-host 工厂。
- `runControlDaemon(options, bound)` 提供认证 UDS / Named Pipe 控制通道，转发 `thread_request` 到进程内 Thread 状态机。
- `runDaemonCLI(action, args, dependencies?)` 支持 `run`、`serve`、`identity`、`agent-host`、`watchdog` 和 `project-runtime`。

运行方使用 `Effect.runPromise(Effect.scoped(runDaemon(options)), { signal })` 管理退出。`DaemonServices` 通过 Effect Context 提供 Host、传输与探测实现；连接、后台任务、SQLite、agent-host 和进程锁由 Scope 管理。

离线测试注入本地 WebSocket 传输、能力探测和 Host 替身。测试覆盖持久接收、报告先落盘再确认、回执丢失重连、启动恢复裁决、agent-host 空闲休眠与透明恢复、报告去重与缺口重放、目录授权拒绝和独占锁，不调用在线模型或外部 API。

部署与设备接入见 [根 README](../../../../README.md)，验证命令见 [AGENTS.md](../../../../AGENTS.md#常用构建与验证命令)。
