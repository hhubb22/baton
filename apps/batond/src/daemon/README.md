# 远程节点

`up` 首次通过 HTTPS 注册节点，保存中心签发的连接凭据，随后保持出站 WSS 连接。已有 `identity.json` 时复用身份。`register` 只注册，已有身份时拒绝覆盖；`run` 读取已有身份并连接。开发入口为 `pnpm --filter @baton/batond dev <命令>`。

```sh
BATON_ENROLLMENT_TOKEN='…' pnpm --filter @baton/batond dev up --coordinator https://baton.example --workspace /绝对目录
pnpm --filter @baton/batond dev run
```

所有命令支持 `--data-dir`，默认 `~/.baton-ts`。注册凭据来自 `BATON_ENROLLMENT_TOKEN` 或 `--enrollment-file` 指定的私有文件。`--ca-file` 设置额外的 TLS 信任根；TLS 验证始终启用。连接地址默认从身份文件中的 HTTPS 中心地址推导，也可由 `run --relay wss://主机/v1/node` 指定。CLI 只打印公开身份摘要。

私有目录中的 `identity.json` 保存中心签发的 JWT；`browse-roots.json` 使用 `{ "roots": [{ "id": "home", "path": "/真实路径" }] }`。仅配置文件不存在时登记用户主目录，已有空列表保留。`up --workspace` 按真实路径幂等添加目录。open、message 和 resume 下发前复核工作目录的真实路径与授权根；stop、withdraw 使用已登记的 Thread 身份与代次，撤销授权或删除工作目录后仍可停止和撤回。目录浏览仅返回根与子目录名称。

每个数据目录由进程锁保证只有一个 daemon。Worker 使用独立进程锁和账本，daemon 退出保留 Worker。启动和周期采集都会核查已登记 Worker，先通过认证 IPC 连接存活进程；进程不可达且没有活动进程锁时，才检查原 SQLite 账本并恢复 Worker。首次启动前在 node.db 持久标记启动尝试；已有尝试后账本缺失、为空或损坏时，永久保存并上报 `thread.unknown` 和 `history_unavailable:true`，阻止再次启动空 Worker。历史缺失不作为 Agent 已停止的证据，网页保持未知结果。已接收的命令由原 Worker 继续执行，未收到持久接收回执的命令使用原 command ID 查询或重试。

`node.db` 通过 `@baton/sqlite` 使用 WAL、`synchronous=FULL` 和提交结果核查。命令以中心 envelope 的 `message_id` 作为 Worker `command_id`，持久保存内容 hash、请求、open 配置、存储代次和接收回执。接收回执表示 Worker 已持久接收；实际完成由 `command.completed` 报告。能力或目录等接入条件明确不满足、Worker 明确拒绝命令时，才返回失败回执。IPC 超时、断线、通用 `worker_unavailable` 和无法核对的成功回包保留为待确认命令，断开中心连接后重连；中心重发原 command ID 时先查询 Worker 回执，确认命令不存在才以原配置和代次重发。查询与重发共享剩余 IPC 预算。

Worker 报告先写入 node.db outbox，再确认 Worker。单连接最多保留 8 条未确认报告，每秒最多尝试发送 32 条，中心 ACK 释放发送窗口；超时按原事件身份补送，为心跳和命令回执保留处理余量。中心确认按 Thread、event ID 和 Worker 序号核对；已确认报告保留，收到 `expected_worker_seq` 时重新发送该序号起的报告。连接断开后按 1～30 秒指数退避并加入 jitter，同一次 daemon 运行沿用 incarnation。明确的凭据拒绝立即停止；认证临时不可用或没有明确拒绝码时继续重连。后续启动继续使用原身份，不自动注册新节点。

认证成功后发送 `node.sync` 与心跳；匹配的同步回执成功后发送 Thread 和能力报告。Cursor 探测独立运行，命令读取最近完成的能力快照。探测未完成时上报 `unverified`、`create:false` 和原因。命令接收复用外层 4.5 秒预算，Worker 启动至多 3 秒，随后 IPC 至多 1 秒，并服从剩余预算。

`session.request` 的输出读取原样转发为 Worker 的 `session_request`；实时输出不写入节点报告账本。网页原生历史由统一历史实现提供，当前中心对该接口返回明确的不可用结果，本地 `native_history` 入口保持可用。

## 嵌入接口

`index.ts` 导出：

- `registerNode(options): Promise<NodeIdentity>`，选项为 `dataDirectory`、`coordinatorURL`、可选的 `enrollmentFile`、`displayName`、`caFile`、`signal`、`transport`。
- `runDaemon(options): Effect.Effect<void, Error, Scope.Scope>`，选项为 `dataDirectory`，可选的 `identity`、`relayURL`、`caFile`、`heartbeatMs`、`pollIntervalMs`、`probeIntervalMs`、`transport`、`probe`、`host`、`random`。

运行方使用 `Effect.runPromise(Effect.scoped(runDaemon(options)), { signal })` 管理退出。`DaemonServices` 通过 Effect Context 提供 Host、传输与探测实现；连接、后台任务、SQLite 和进程锁由 Scope 管理。

离线测试注入本地 WebSocket 传输、能力探测和 Worker Host 替身。测试覆盖持久接收、报告先落盘再确认、回执丢失重连、存活 Worker 重发现、报告去重与缺口重放、空授权列表、符号链接越界和独占锁，不调用在线模型或外部 API。
