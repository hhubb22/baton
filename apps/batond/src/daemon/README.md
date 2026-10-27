# 远程节点

`up` 首次注册并保持出站 WSS，已有身份时复用；`register` 拒绝覆盖已有身份，`run` 读取已有身份。连接地址从持久化的 HTTPS 中心地址推导，支持显式 relay 与附加 CA，TLS 验证始终开启；CLI 只打印公开身份摘要。首次注册可从 SEA 安装目录读取 `deployment.json`，已有身份不读取部署配置。注册和重新认证成功后在身份锁下先保存 `coordinator-ca.pem` 再保存身份，后续连接默认读取该 CA。部署和配置用法见根 README。

私有目录中的 `identity.json` 保存中心签发的 JWT；授权目录由 [`devices/roots.ts`](../devices/roots.ts) 统一读写和检查，配置格式、数量上限与加锁规则见 [设备管理与文件访问](../devices/README.md)。仅配置文件不存在时登记用户主目录，已有空列表保留。`up --workspace` 按真实路径幂等添加目录。open、message 和 resume 下发前复核工作目录的真实路径与授权根；stop、withdraw 使用已登记的 Thread 身份与代次，撤销授权或删除工作目录后仍可停止和撤回。目录和文件预览由 `devices/` 提供，使用同一授权根；目录符号链接解析后须仍在该根内，文件预览保留字节上限与分页信息。

每个数据目录由进程锁保证只有一个 daemon。Worker 使用独立进程锁和账本，daemon 退出保留 Worker。启动和周期采集都会核查已登记 Worker，先通过认证 IPC 连接存活进程；进程不可达且没有活动进程锁时，才调用 `worker/ledger.ts` 的 `inspectWorkerLedger(账本路径, 原配置)` 检查原 SQLite 账本。账本模块负责格式、身份及只读校验，返回 valid、missing、empty、corrupt 或 retry；daemon 据此裁决恢复，锁占用、权限和临时 I/O 故障保留为 retry。`node.db` 分别保存启动尝试和 `startup_phase`：新配置为 `awaiting_open`；daemon 或本地 IPC 在交付 open 前先提交 `open_attempted`，收到绑定身份的状态、回执或报告也保留该事实。仍为 `awaiting_open`、账本缺失或经检查为空且没有命令、消息、进程及报告记录时，可重试启动 Worker，并继续使用原 command ID、配置及代次。已经可能交付 open 后，账本缺失或为空，以及任意阶段的账本损坏，都会保存并上报 `thread.unknown` 和 `history_unavailable:true`，阻止启动空 Worker。历史缺失不作为 Agent 已停止的证据，网页保持未知结果。已接收的命令由原 Worker 继续执行，未收到持久接收回执的命令使用原 command ID 查询或重试。

`node.db` 通过 `@baton/sqlite` 使用 WAL、`synchronous=FULL` 和提交结果核查。命令以中心 envelope 的 `message_id` 作为 Worker `command_id`，持久保存内容 hash、请求、open 配置、存储代次和接收回执。接收回执表示 Worker 已持久接收；实际完成由 `command.completed` 报告。能力或目录等接入条件明确不满足、Worker 明确拒绝命令时，才返回失败回执。IPC 超时、断线、通用 `worker_unavailable` 和无法核对的成功回包保留为待确认命令，断开中心连接后重连；中心重发原 command ID 时先查询 Worker 回执，确认命令不存在才以原配置和代次重发。查询与重发共享剩余 IPC 预算。

Worker 报告先写入 node.db outbox，再确认 Worker。单连接最多保留 8 条未确认报告，每秒最多尝试发送 32 条，中心 ACK 释放发送窗口；超时按原事件身份补送，为心跳和命令回执保留处理余量。中心确认按 Thread、event ID 和 Worker 序号核对；已确认报告保留，收到 `expected_worker_seq` 时重新发送该序号起的报告。连接断开后按 1～30 秒指数退避并加入 jitter，同一次 daemon 运行沿用 incarnation。明确的凭据拒绝立即停止；认证临时不可用或没有明确拒绝码时继续重连。后续启动继续使用原身份，不自动注册新节点。

认证成功后发送 `node.sync` 与心跳；匹配的同步回执成功后发送 Thread 和能力报告。`up`、`run` 的 `--control-timeout-seconds` 设置认证与同步各自的等待预算，默认 370 秒，范围 1～3600 秒的整数；嵌入调用对应 `controlTimeoutSeconds`。认证从连接建立起计时，同步从认证成功起重新计时，任一阶段超时均断开并退避重连。中心默认握手期限为 15 秒，可配置上限为 361 秒，默认节点预算覆盖中心期限。中心以合法入站帧维护传输活性，慢业务处理期间收到的心跳仍保持连接，数据库身份校验在心跳与业务处理时执行。公共 `agents/probe.ts` 按 catalog 中的 Cursor、Pi、Codex、Kiro 顺序并发探测，命令读取最近完成的能力快照。每次探测有 30 秒预算，取消会等待 host 断开、进程回收和临时目录清理；Windows 的登记锁覆盖恢复至清理，回收未确认时保留登记。探测未完成时上报 `unverified`、`create:false` 和原因。命令接收复用外层 4.5 秒预算，Worker 启动至多 3 秒，随后 IPC 至多 1 秒，并服从剩余预算。

`session.request` 的输出读取原样转发为 Worker 的 `session_request`；实时输出不写入节点报告账本。网页时间线与 Project 工具从中心读取已保存的 Thread 输入、回复和事件，设备上的原生历史仍由各 Agent 管理，Baton 不提供原生历史查询接口。

Project manager 在 WSS 连接循环外构造，连接同步后绑定当前 RPC transport，断线时取消旧请求并保留运行中的 Runtime。每条连接最多 64 个 Project 请求在途，响应只匹配本连接的 correlation ID。start、stop、wake 在独立任务中处理，Runtime 的节点管理操作与业务 stdio 请求分开授权。租约、持久清理事实和 Thread 版本等待见 [Project Runtime 宿主](../project/README.md)。

设备目录、仓库、执行授权和订阅报告在独立采集循环中更新，每轮完成后等待五秒；连接建立或配置变化触发刷新。目录扫描使用两秒预算，Runtime probe 使用独立配置预算（默认五秒），并发启动后等待两者；Agent 探测继续独立运行。最终报告按带缩进 JSON 计量并裁剪至 64 KiB，先裁仓库和模型，再裁目录；控制连接和 Worker 报告不等待文件扫描。

## 嵌入接口

`identity.ts` 和 `daemon.ts` 分别导出：

- `registerNode(options): Promise<NodeIdentity>`，选项为 `dataDirectory`、`coordinatorURL`、可选的 `enrollmentFile`、`displayName`、`caFile`、`caPem`、`signal`、`transport`；`caFile` 优先于 `caPem`。
- `runDaemon(options): Effect.Effect<void, Error, Scope.Scope>`，选项为 `dataDirectory`，可选的 `identity`、`relayURL`、`caFile`、`controlTimeoutSeconds`、`heartbeatMs`、`pollIntervalMs`、`probeIntervalMs`、`transport`、`probe`、`host`、`random`、`project`。`project` 可注入源码 Runtime 命令、时钟和租约时序，默认使用现有 Runtime 实现。

`loadCoordinatorCA(dataDirectory, explicitFile?)` 优先读取显式 CA 文件，其次读取私有数据目录中保存的 CA，都没有时返回 undefined。`loadDeployment(installationDirectory?)` 默认只在 SEA 中读取安装目录，嵌入调用可注入目录。`runDaemonCLI(action, args, dependencies?)` 支持注入安装目录与 stdin，用于本地集成验证。

运行方使用 `Effect.runPromise(Effect.scoped(runDaemon(options)), { signal })` 管理退出。`DaemonServices` 通过 Effect Context 提供 Host、传输与探测实现；连接、后台任务、SQLite 和进程锁由 Scope 管理。

离线测试注入本地 WebSocket 传输、能力探测和 Worker Host 替身。测试覆盖持久接收、报告先落盘再确认、回执丢失重连、存活 Worker 重发现、报告去重与缺口重放、目录授权拒绝和独占锁，不调用在线模型或外部 API。

部署与设备接入见 [根 README](../../../../README.md)，验证命令见 [AGENTS.md](../../../../AGENTS.md#常用构建与验证命令)。
