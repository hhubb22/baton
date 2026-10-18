# Baton

员工使用部署管理员分配的本地账号登录 Coordinator，退出，查询本人身份，领取一次性节点注册凭据，设置默认 PC，吊销本人节点的连接凭据，并提交任务。初始口令只能使用到员工完成更换为止。`batond register` 用这张凭据注册节点，把身份保存在本机。`batond run` 用这份身份主动连接 Relay，断线后重连，并在同步完成前不会显示为可执行。吊销生效后，同一连接凭据不能再接入。任务被接受后，Coordinator 把准备命令送到节点；节点先把执行映射写入本地账本，再绑定一个独立的 Session Worker。

本目录目前包含这条路径的构建、迁移、HTTP 接口、Coordinator、Relay、batond、Session Worker、Agent 本地 CLI、受限文件浏览、员工 Web UI 和测试。准备阶段不启动 Agent。启动许可通过后，测试执行器先进入启动，再只接收一次任务输入；结构化结果在中心保存之后才算交付。真实 Agent 适配和管理员网页不在这里。

中心事务同时锁定任务与执行记录时，统一先锁 `tasks`，再锁 `executions`。准备成功或失败落库、启动许可、执行报告、取消和到期处理均按此顺序串行，避免准备落库与启动许可相互等待而死锁。

节点与 Session 的 SQLite 账本支持 Windows 盘符路径，以及含空格、中文、`%`、`#` 的数据目录；相对路径按进程工作目录解析。账本格式、WAL 与 FULL 同步设置不变。历史损坏按 SQLite 错误码识别，权限、锁、IO 和路径/URI 错误归为暂时读不了（`ErrHistoryUnread`），保留底层原因，不把打开失败当成损坏或新建空历史。

## 运行要求

- Go 1.27
- PostgreSQL 17

## 配置

| 变量 | 作用 |
|---|---|
| `BATON_DATABASE_URL` | Coordinator 的 PostgreSQL 连接串 |
| `BATON_DB_SCHEMA` | 数据所在 schema，默认 `public` |
| `BATON_HTTP_ADDR` | 监听地址，默认 `127.0.0.1:8080` |
| `BATON_ALLOWED_ORIGINS` | 逗号分隔的 https Origin。`serve` 必填，浏览器写操作必须匹配其中一项 |
| `BATON_SESSION_TTL` | 会话有效期，默认 `12h`，允许 `5m` 到 `168h` |
| `BATON_ENROLLMENT_TTL` | 一次性注册凭据有效期，默认 `10m`，允许 `1m` 到 `24h` |
| `BATON_NODE_CREDENTIAL_TTL` | 节点连接凭据有效期，默认 `720h`，允许 `1h` 到 `2160h` |
| `BATON_TLS_CERT_FILE` | 与 `BATON_TLS_KEY_FILE` 同时设置时，进程直接提供 TLS |
| `BATON_TLS_KEY_FILE` | TLS 私钥文件 |
| `BATON_CONTROL_ADDR` | Coordinator 控制连接监听地址，默认 `127.0.0.1:9443`，不能与 API 地址相同 |
| `BATON_CONTROL_TOKEN` | Coordinator 与 Relay 共用的控制凭据，20 到 200 个字符。不要写入日志 |
| `BATON_NODE_SIGNING_KEY` | Coordinator 的 Ed25519 PKCS#8 私钥文件，权限必须是仅当前用户可读 |
| `BATON_HEARTBEAT_INTERVAL` | 心跳间隔，默认 `10s`，允许 `100ms` 到 `2m` |
| `BATON_OFFLINE_AFTER` | 未联系超过该时间判离线，默认 `30s`，允许 `200ms` 到 `10m`，并且必须晚于心跳 |
| `BATON_LISTEN_ADDR` | Relay 接受节点连接的地址 |
| `BATON_COORDINATOR_URL` | Relay 连接的 Coordinator 控制入口，必须是不带路径和凭据的 `https` 地址 |
| `BATON_ENROLLMENT_TOKEN` | `batond register` 读取的一次性注册凭据。不要写入命令行 |
| `BATON_TLS_CA_FILE` | `batond` 和 Relay 额外信任的 CA 证书文件。地址仍必须是 https 或 wss |

会话 Cookie 名为 `baton_session`，固定带 `Secure`、`HttpOnly` 和 `SameSite=Strict`。进程监听 HTTP 时也保持这些属性。浏览器只在 HTTPS 请求里送回该 Cookie；入口代理终止 TLS 时，浏览器看到的来源仍是 HTTPS。

注册凭据和节点连接凭据不进入 URL、命令行参数或日志。注册凭据和浏览器会话在数据库里只保存 SHA-256。节点连接凭据是 Ed25519 签名的 JWT，数据库只保存可吊销的 `credential_id`，不保存 JWT。签名私钥只在 Coordinator。

## 命令

```text
go build -o bin/coordinator ./cmd/coordinator
go build -o bin/relay ./cmd/relay
go build -o bin/batond ./cmd/batond
go build -o bin/baton ./cmd/baton
```

```text
BATON_DATABASE_URL=postgres://127.0.0.1:5432/baton ./bin/coordinator migrate
```

```text
BATON_DATABASE_URL=postgres://127.0.0.1:5432/baton ./bin/coordinator admin employee create --username alice --display-name "Alice"
```

```text
BATON_DATABASE_URL=postgres://127.0.0.1:5432/baton ./bin/coordinator admin employee reset-password --username alice
```

```text
BATON_DATABASE_URL=postgres://127.0.0.1:5432/baton BATON_ALLOWED_ORIGINS=https://baton.example BATON_CONTROL_TOKEN=change-this-control-token BATON_NODE_SIGNING_KEY=./node-signing.pem ./bin/coordinator serve
```

```text
BATON_LISTEN_ADDR=127.0.0.1:9444 BATON_COORDINATOR_URL=https://127.0.0.1:9443 BATON_CONTROL_TOKEN=change-this-control-token BATON_TLS_CERT_FILE=./tls.pem BATON_TLS_KEY_FILE=./tls.key ./bin/relay
```

创建和重置把一次性口令写到标准输出，只显示这一次。数据库保存 Argon2id 摘要。标准错误和 HTTP 日志不记录口令、会话令牌、CSRF 令牌、注册凭据或节点连接凭据。不要把标准输出并进普通运行日志。

`serve` 在迁移完成前拒绝启动。

```text
batond register --coordinator https://baton.example --display-name "Desk" --system linux --role pc --capability start
```

注册凭据放在 `BATON_ENROLLMENT_TOKEN`，或放在仅当前用户可读的文件里并用 `--enrollment-file` 指向它。两种方式只能选一种。未指定 `--data-dir` 时，Linux 使用 `$XDG_DATA_HOME/baton/node`（未设置时为 `~/.local/share/baton/node`），macOS 使用 `~/Library/Application Support/baton/node`，Windows 使用 `%LOCALAPPDATA%\baton\node`。

系统取 `windows`、`macos` 或 `linux`。角色取 `pc`（PC 执行节点）或 `ubuntu`（Ubuntu 开发节点）。`--capability` 可重复，名称使用小写字母、数字、点、下划线和连字符。

连接凭据只写入数据目录中的 `identity.json`，权限为仅当前用户可读写。标准输出只打印节点 ID 等非秘密字段。命令会说明当前使用文件保存，而不是系统凭据存储。数据目录里已经有身份时，命令不会再次注册。

```text
batond run --relay wss://baton.example/v1/node
```

`run` 读取同一份身份，主动建立 TLS WebSocket。断线后按 1 到 30 秒、带抖动的指数退避重连。认证失效时进程退出并说明需要重新认证，不会重新注册。每次启动生成一个 incarnation；已有另一个 incarnation 在线时，后启动的进程不能接管该节点。

## Agent 本地 CLI

batond 在准备执行时创建 `sessions/<session_id>/agent-<execution_id>.json`（相对于节点数据目录，文件权限 `0600`）。执行环境用 `BATON_CONTEXT_FILE` 指向**该次执行**的文件；不要把文件内容、令牌或节点连接凭据放进命令行、任务说明或日志。当前测试执行器不启动真实 Agent，真实适配器仍需负责传入这个环境变量。

```text
baton delegate --request-file request.json --json
baton task get TASK_ID --json
baton task wait TASK_ID --timeout 30s --json
baton task result TASK_ID --json
baton task relations TASK_ID --json
baton task cancel TASK_ID --json
```

委托文件最小内容为 `{"request_id":"stable-request-id","description":"读取目标现场信息"}`。调用方自行保存稳定的 `request_id`；重试必须沿用原 ID 和原内容。CLI 不生成 ID，也不因等待到期或响应丢失重新委托。相同内容返回原任务，不同内容返回 `conflict`，即使默认 PC 后来改变也不改派原任务。未指定目标时使用中心保存的本人默认 PC；目标离线仍保留这个目标。

所有命令走当前用户限定的 Unix socket / Windows named pipe，再经已有认证 Relay 通道访问中心。文件只含 IPC 地址和随机凭据，来源三元组由 batond 的 SQLite 绑定解析；员工、节点由 Relay 认证决定。中心重新核对来源任务、Session、Execution 和节点。新委托只允许从尚在执行、未取消且未到期的当前绑定发起；已接受任务在来源结束后仍可查询。请求不能指定其他员工或替换来源；授权文本完全继承来源，显式指定时必须逐字相同，不推断自由文本权限包含关系。查询和取消仅限来源任务及其直接委托，不开放同员工的其他任务。

`task get` 返回中心状态、Execution 和 `delivery_status`；这里的 `delivered` 指现有执行结果交付记录已在中心保存，不表示结果已经自动注入来源 Agent。`task result` 返回可信 `task_id`、`target_node_id`、`session_id`、`execution_id`、状态、摘要、证据、产物和错误；未保存候选结果时 `ready` 为 false。`task relations` 返回该任务的来源与执行边，以及从当前来源 Session 发出的直接子委托，单次上限 100 条，超出明确报错，不静默截断。

`task wait` 默认 30 秒，允许大于 0、最多 5 分钟；只轮询中心已保存事实，在任务结束、进入待核实或版本变化时返回。到期返回 `waiting:true`、`timed_out:true` 和最后读到的任务（尚未读到时为 null），退出码为 0；Ctrl-C 或传输错误返回非零，不取消任务。其他成功命令输出 JSON、退出码为 0，业务拒绝输出结构化错误、退出码非零。

`result submit` 尚未实现。真实 Agent、自动子结果通知/再次输入和父子级联取消尚未接入。本次复用已有中心表，无新增 PostgreSQL 迁移或依赖。

## 会话

接口都在 `/api/v1` 下。浏览器写操作要求 `Origin` 属于 `BATON_ALLOWED_ORIGINS`。已登录的写操作还要求请求头 `X-CSRF-Token` 与登录响应里的 `csrf_token` 一致。服务端只保存会话令牌和 CSRF 令牌的 SHA-256。

`POST /login` 接收 JSON：

```json
{"username":"alice","password":"..."}
```

成功时设置会话 Cookie，并返回本人身份、`csrf_token` 和 `expires_at`。正文不包含会话令牌。账号或口令不正确时返回 `invalid_credentials`，不说明是哪一项错了。

`GET /me` 凭 Cookie 返回本人身份和会话到期时间。

`POST /logout` 使当前会话在数据库中失效，并清除 Cookie。

`POST /me/password` 接收：

```json
{"current_password":"...","new_password":"..."}
```

成功后旧口令失效，该员工的全部会话失效，需要用新口令重新登录。新口令至少 12 个字符，最长 128 个字符，不能包含控制字符或首尾空格，也不能与用户名或当前口令相同。

`GET /employees/{id}` 只返回当前会话对应的员工。其他员工标识返回 403，响应里没有对方的资料。

管理员创建或重置的账号，`must_change_password` 为 `true`。员工登录后调用更换口令接口，完成后该标志变为 `false`。

错误响应包含 `code`、`message` 和 `request_id`。

本地账号的用户名以小写字母开头，后续可以是小写字母、数字、点、下划线和连字符。认证模块保留 `Directory.FindExternal`，用于以后按已核实的外部主体查找员工。当前没有外部登录入口，这个查找本身不创建会话。

## 节点注册与默认 PC

`POST /node-enrollments` 需要登录会话、Origin 和 CSRF。正文是 `{}`。成功时返回 `enrollment_id`、`enrollment_token` 和 `expires_at`。凭据默认 10 分钟，只能成功注册一次。过期返回 `enrollment_expired`，再次使用返回 `enrollment_used`。

`POST /nodes/register` 不使用浏览器会话。员工身份只来自注册凭据；正文若包含 `employee_id` 会被拒绝，也不会核销凭据。请求不能在 URL 中放参数。正文至少包含：

```json
{"enrollment_token":"...","display_name":"Desk","system":"linux","role":"pc","capabilities":["start"]}
```

成功时中心保存归属、显示名、系统、角色、能力列表和注册序号，并返回只出示一次的连接凭据。连接凭据是绑定节点、员工、`credential_id`、签发方、受众和有效期的 JWT，默认 30 天。

员工还没有默认 PC 时，注册会按注册序号选择最早的、尚未吊销的 PC 执行节点并保存。之后新注册的节点不改变它。Ubuntu 开发节点不会被选为默认 PC。

`PUT /me/default-pc` 需要登录会话、Origin 和 CSRF：

```json
{"node_id":"..."}
```

只能改成自己的其他有效 PC 执行节点。其他员工的节点返回 403，不说明该节点是否存在。成功响应里的 `default_pc_node_id`、显示名、系统和注册序号是数据库里实际保存的值。

`GET /nodes` 和 `GET /nodes/{id}` 凭登录会话返回本人节点。响应包含在线状态、最后联系时间、状态更新时间、是否已同步、`executable` 和 `revocation_status`。尚未同步或已有吊销决定的节点 `executable` 为 false。`revocation_status` 为 `none`、`pending` 或 `effective`。只有 Relay 确认应用后才是 `effective`；决定已保存但还没有回执时是 `pending`。查询其他员工的节点或不存在的节点都返回 403，响应相同。非法节点标识返回 400。这两个读取接口不要求 CSRF。

`GET /nodes` 同时返回当前 `default_pc`。节点被吊销后，这里仍返回原来的 `node_id`，并把 `invalid` 和 `needs_reselection` 设为 true，提示需要重新选择。系统不会自动改选其他节点。

列表和吊销响应都包含 `local_process_notice`：吊销连接凭据不会停止离线节点上的本地进程。重新接入需要新的连接凭据。

## 凭据吊销

`POST /nodes/{id}/revoke` 需要登录会话、Origin 和 CSRF。正文是 `{}`。请求不能在 URL 中放参数。只能吊销自己的节点；其他员工的节点和不存在的节点都返回 403，响应相同，不说明该节点是否存在。

成功时中心先把吊销决定写入数据库，记录操作者、时间和关联的节点与 `credential_id`。从这时起，该节点不能再同步，也不能被选为新的默认 PC。历史节点和凭据记录保留，不删除。

响应里的 `status` 表示处理状态。Relay 已把吊销应用到内存、断开对应连接并回执时为 `effective`，同时给出 `applied_at`。Relay 当时不可达，或回执还没到，则为 `pending`，`applied_at` 为 null。不能把 `pending` 理解成凭据已经不能连接，也不能理解成离线节点上的本地进程已经停止。

Relay 重新连上 Coordinator 时会取得包含该吊销的安全快照；已经连着时，Coordinator 会补发吊销。两种路径都会拒绝同一 `credential_id`，避免 Relay 用过期的内存状态放行。`batond` 收到认证失败后退出并说明需要重新认证，不会用失效凭据重新注册。

## 任务接受

`POST /tasks` 需要登录会话、Origin 和 CSRF。员工身份来自会话。正文里如果出现 `employee_id`，请求会因未知字段被拒绝，不会创建任务。

调用方自己生成 `request_id`，同一次提交的重试保持不变。`description` 必填，最多 32768 个字符，可以包含换行、回车和制表符；其他控制字符会被拒绝。`authorization_scope` 和 `expected_outputs` 同样。`request_id` 和 `working_directory` 仍是单行。`target_node_id` 可以省略，省略时使用当前默认 PC；没有可用的默认 PC 时拒绝，不会改派到别的节点。显式指定时可以使用本人尚未吊销的 PC 或 Ubuntu 节点。节点离线也可以接受，状态是 `queued`。

`agent_type` 可以省略。指定了目标 Session 时沿用该 Session 的 Agent；否则使用目标节点上的 `default_agent_type`。这个值只是节点表里的可空列，当前没有修改它的接口；列为空且没有目标 Session 时拒绝。节点最后上报的能力里没有这个 Agent 时拒绝，不会创建任务。

`queue_timeout_seconds` 省略时是 600 秒，从接受时起算，响应里给出 `queue_expires_at`。`execution_timeout_seconds` 省略时是 7200 秒，响应里给出这个秒数。省略和写成同一个数字不是同一份内容。`device_names` 省略和空列表也不是同一份内容；列表非空时必须给出 `authorization_scope`。

`source_session_id` 和 `target_session_id` 可以省略。填写时必须是当前员工已经拥有的 Session；其他员工的 Session 返回 `forbidden`，不存在的 Session 返回 `invalid_target`。目标 Session 还必须位于本次解析出的节点上，并且处于可以接收的状态。`running`、`waiting_input`，或已经绑定了执行的 Session，返回 409，`code` 是 `session_busy`。显式 `agent_type` 与 Session 已有 Agent 不一致时返回 `unsupported`。省略 `agent_type` 时沿用该 Session 的 Agent，不再使用节点默认 Agent。两个 Session 字段都省略时可以接受，目标 Session 由节点在准备时创建。

中心先按员工和 `request_id` 查找已经提交的请求。内容相同就返回原来的任务，不再解析默认 PC 或默认 Agent。内容不同返回 409，`code` 是 `conflict`，并带上已有的 `task_id`。新请求在同一个数据库事务里保存任务、解析结果、execution、初始事件、任务关系、`dispatch_outbox` 和去重墓碑。指定了已有目标 Session 时，同一个事务会占用它。事务提交成功后才返回 200。提交失败时响应不是接受记录，库里也没有这次投递意图。

成功记录包含 `task_id`、`request_id`、`target_node_id`、`agent_type`、`status`、`queue_expires_at`、`execution_timeout_seconds` 和 `version`。新接受和幂等重试都返回 200。错误响应里的 `request_id` 是这一次 HTTP 调用的编号，与正文里的 `request_id` 不是同一个值。

字段不合法返回 `invalid_request`，`details.fields` 指出字段。其他员工的节点或任务返回 `forbidden`。找不到或已失效的目标返回 `invalid_target`。已知能力不匹配返回 `unsupported`。

`GET /tasks` 返回本人最近 100 条任务。`GET /tasks/{id}` 和 `GET /tasks/{id}/events` 只返回本人的记录和变更，不返回 Session 原文。其他员工的任务和不存在的任务都返回 403，响应相同。非法任务标识返回 400。这三个读取接口不要求 CSRF。

`dispatch_outbox` 保存 `prepare` 投递意图。Coordinator 在节点在线且已同步时按租约领取，经 Relay 投递，并用同一条消息 ID 重发。从未交给 Relay 的过期消息记为 `queue_timeout`。已经交给 Relay 但还没有确定结果的消息，过期后仍按租约重发，直到节点返回已准备的原映射或 `queue_timeout`。接受响应里的 `target_session_id` 在准备完成前可能是 null。准备成功后任务仍是 `queued`，`GET /tasks/{id}` 能看到节点返回的 Session。

## 准备与 Session

节点收到 prepare 后，先把 `task_id` 到 `execution_id` 的映射写入数据目录里的 SQLite 账本，再绑定 Session Worker，然后才回 ACK。重复的 prepare 返回已经保存的执行和 Session，不创建第二份。账本使用 WAL，并按 FULL 同步。本地写入失败或 Worker 没有绑定成功时，节点不回 ACK，中心稍后重发同一条消息。

`batond run` 会锁定数据目录。另一个 `batond run` 不能共用这个目录。Worker 由 batond 用同一可执行文件的内部子命令启动，使用独立进程组和认证过的本地连接。Windows 上是命名管道。Unix 上是套接字文件；会话目录下的路径经常超过系统对套接字路径的长度限制，因此套接字放在 `/tmp/baton-<uid>/` 下仅当前用户可进入的目录中，认证令牌仍在数据目录里。batond 退出后 Worker 继续运行；下次 `batond run` 会连回原来的 Worker，而不是新开一份执行。`worker` 不是给操作者使用的命令。

准备只做绑定和被动检查，不把任务说明交给模型，不启动 Agent，也不运行启动钩子。准备成功后，Worker 才向中心申请启动许可。

同一 Session 的本地写入互相等待。明确拒绝会带上原因：Session 正在执行其他任务、Agent 或节点不匹配、工作目录不可用、存储代次不匹配，或排队期限已过。

`GET /sessions` 返回本人最近 100 条 Session 的元数据、是否被占用，以及关联的任务标识。`GET /sessions/{id}` 返回其中一条。其他员工的 Session 和不存在的 Session 都返回 403，响应相同。这两个读取接口不要求 CSRF，也不返回 Session 原文。

## 启动许可

已准备的 Worker 用同一条节点连接向中心申请短时启动许可。许可是 Ed25519 签名的 JWT，受众是 `baton-start`，和节点连接凭据的受众 `baton-node` 不能互换。许可绑定执行身份、任务、节点、存储代次、请求摘要和有效期。中心在事务里重新检查任务仍在排队、没有取消、节点没有吊销、执行身份和存储代次一致，并且排队期限还够用。事务写入 `start_authorized_at` 并提交成功之后才签名。提交失败不会签发许可。

许可寿命最长 5 秒，并且不会晚于排队到期时间。如果剩余时间扣掉 1 秒安全余量后已经不是正数，中心不会授权，任务按尚未启动失败。Worker 用许可请求的往返耗时计算本地预算，时钟是包含系统暂停的单调时钟，不使用可被改动的墙上时钟。预算不是正数、许可过期、受众不对、执行身份不对或存储代次不对时，Worker 不写入 `start_intent`，也不调用执行器。

校验通过后，Worker 先把 `start_intent` 写入自己的 SQLite，然后才调用测试执行器的 `Start`。这一步还不运行启动钩子。测试执行器把 `start` 记到日志里，方便确认没有在准备阶段启动。

中心最终拒绝许可时，节点把拒绝交给对应执行的 Worker 记录为 `start_refused`。Worker 退出后，未申请过许可、已拒绝或已取消且没有 `start_intent` 的 Session 在没有待交付回执时不会因 batond 重连而重新拉起；已经记录许可申请、尚未被拒绝的 Session 仍会恢复。待交付结果、中止回执和已经落盘的启动意图优先沿用原恢复流程，不新开执行。执行身份不匹配的拒绝不会写入本 Session；匹配身份的拒绝即使写账本失败，节点仍向中心发送未启动的拒绝回执。

## 任务输入与结果

`start_intent` 落盘之后，节点向中心领取这一次任务的说明、授权范围、期望产物、工作目录和设备名，再交给 Worker。Worker 在自己的账本里同步记下“已经提交输入”，然后只调用一次测试执行器的 `SubmitInput`。重复的启动命令或输入命令不会让执行器再收到一次，也不会新建 execution。接受任务时按这份 JSON 计算大小，超过 256 KiB 返回 `invalid_request` 并指出字段，不创建任务。Worker 如果仍然收到超限输入，不调用执行器，直接把执行记为失败并回报。

`start_intent` 已经记下、但还不能证明输入已经送出时，Worker 进程再启动不会重发输入，任务变为 `needs_verification`，原因码是 `uncertain_input`。输入已经确认、原 Worker 却已退出时原因码是 `uncertain_worker`，账本里的进程号不能当成同一次执行仍在运行。本地历史缺失或损坏时原因码是 `uncertain_history`，不会新建一份空账本假装恢复成功。展示句子由中心根据原因码生成。同一 `event_id` 的重复上报只确认原记录，不改写任务状态。本地结果已经保存而中心确认丢失时，恢复后用同一个 `event_id` 补报一次。数据库短时不可用时不确认交付；恢复后补报，不重复记账，也不再执行一次。batond 重启会连回仍在运行的 Worker；已经交付或已经上报待核实的历史 Session 不再拉起常驻进程。

Worker 无法应答时，账本的权限、IO、打开失败和锁忙统一作为读取失败，不直接判为损坏。每个 Session 连续 3 次心跳补报检查读取失败后，上报 `needs_verification` / `uncertain_history`，停止离线账本的自动读取与 Worker 重建；中心未确认时只补报同一事件。计数保存在节点账本已有的 `meta` 中，重连或重启不清零；阈值前成功读取会清零，因此短暂锁忙只记录 `history_read_failed` 并留待下次心跳。原 Worker 仍可补回同一次执行的有效证据，成功连回时也会清零；不新建执行或重发不确定输入。

执行器接受输入后，Worker 持续把过程记在本地 `execution_log`。它向中心上报 `started`，任务变为 `running`。最终输出要能通过结构校验，并且执行器明确给出 `completed` 或 `failed`。平台用自己保存的任务、节点和 Session 覆盖执行器正文里的身份字段。证据或产物为空时必须有原因。引用要带资源标识、访问状态，以及节点或存储位置。

进程退出、自由文本（包括单独一句“完成”）不会变成成功。测试执行器没有外部副作用，这种情况记为 `failed`，原因是 `result_format`。结果先留在 Worker 的本地 outbox。中心在同一个事务里保存状态、摘要、引用和 `delivery_records` 并提交之后，才回复确认；Worker 收到确认后才把这条结果标成已交付。同一 `event_id` 的重复上报只确认原来的记录。完整过程和原始输出不写入 `task_events`。

`GET /tasks/{id}` 返回摘要、证据引用和产物引用，以及 `cancel_requested_at`、`execution_expires_at`、`stop_requested_at`、`stop_acknowledged_at`、`stop_confirmed_at`、`stop_reason`、`stop_outcome_known`。请求、Worker 回执、确认停止与结果已知分别展示，不能由请求直接推断停止。`GET /tasks/{id}/events` 保留状态、发生时间 `occurred_at`、接收时间 `created_at`、执行身份及 Worker 本地 `worker_sequence`，不包含会话原文。完成与取消竞态按本地序号和事实核查，后到的结论只增加证据，不覆盖终态；未结束的子委托还在时，不能把父任务标成完成。

`POST /tasks/{id}/cancel` 需要登录会话、Origin 和 CSRF，正文是 `{}`。尚未发出启动许可、或者节点已经明确拒绝启动时，任务变为 `cancelled`。许可已经发出但还没有这张未启动回执时，任务变为 `needs_verification`，响应里的 `possible_start` 为 true。缺少启动回执不会被当成“没有执行”。重复取消不发起新的执行。取消父任务时还不会级联子委托。

授权前已取消的同一次执行，Worker 在后续心跳领取中止要求后仍可补报 `stop_report`。中心只对身份匹配、取消原因且 `not_started=true`（同时已停止、结果已知）的未授权执行接收这类补充证据，持久化后 ACK；保留 `cancelled` 终态、原摘要和错误，不补授权。同一事件重复上报只确认一次。Worker 收到 ACK 后清空待交付项，退出后不再因该回执被 batond 重启或重连拉起；其他未授权的启动、结果及中止报告仍拒绝。

中心把单任务中止请求持久保存在 `execution_stops`。节点在心跳和补发输入前通过 `execution.control` 领取，离线请求不会被丢弃。Worker 在 Session 互斥区先落盘中止标记再调用测试执行器的中止接口；接口返回不等于确认停止。只有未发送输入、或确认停止且操作结果可说明时才变成 `cancelled`；停止或副作用仍未知就保留 `needs_verification` 和执行绑定。停止不会回滚已发生的外部副作用。真实 Agent 适配仍不在本实现内。

排队到期时，包含未准备任务在内，能确认未启动的任务失败，原因是 `queue_timeout`，此后不能再授权。已授权而没有未启动证据的任务先待核实，Worker 的未启动回执再收敛为超时失败；期限前已发送输入的事实优先于延迟的排队超时请求，不会中断已执行任务。节点被吊销时仍按原规则处理：还没授权就失败，原因是 `revoked`；已经授权就进入待核实。

执行期限通过签名许可传给 Worker，从本地 `start_intent` 起用包含休眠的单调时钟计时，墙钟跳变不会增加预算，节点离线也会中止。中心首次收到启动事实时以剩余执行预算估算 `execution_expires_at` 并扫描；传输延迟可能使中心扫描略晚，本地计时不依赖中心。超时先中止、待核实，只有停止且结果已知才按 `execution_timeout` 失败。中心输入读取与 Worker 提交均检查取消/期限，不会补发已取消或已超期输入。实际输入发送的原定时间、发送时间和单调 `delay_ms` 存在本地 `execution_log` 的 `input_dispatch` 条目及同名日志中，不只记录重试尝试。

## 文件浏览

员工在节点本机登记可以浏览的目录。浏览器只提交 `root_id` 和相对路径，不能提交绝对路径、`..` 或读取偏移。

```text
batond files add --id notes --path /绝对路径/到/目录 [--data-dir 目录]
batond files list [--data-dir 目录]
batond files remove --id notes [--data-dir 目录]
```

`--path` 必须是已经存在的真实目录。符号链接不能登记为浏览根。配置写在数据目录的 `browse-roots.json`，权限为仅当前用户可读写。`batond run` 正在使用该数据目录时也可以登记，下一次浏览会读到新配置。

`GET /nodes/{id}/files` 需要登录会话，不要求 CSRF。不带 `root_id` 时返回已登记目录的标识，不返回本机绝对路径。带 `root_id` 和可选的 `path` 时，目录返回条目，文本文件返回最多 64 KiB 的预览。一次最多返回 200 条目录项；扫描超过 1024 条就停止，并标记这次没有列完。`truncated` 为 true 时，响应里的 `remainder` 只说明剩余内容仍在节点本地，不能用 `offset` 或其他参数把剩余部分继续取回来。二进制文件返回 `not_text`，不附带内容。命名管道、设备文件和套接字会在目录里标出类型；打开后如果不是目录或普通文件，返回 `unsupported_type`，不读取内容。

节点离线返回 `node_offline`，已吊销返回 `revoked`。其他员工的节点和不存在的节点都返回 `forbidden`，响应相同。路径越界和符号链接逃逸返回 `path_escaped`。未登记的 `root_id` 返回 `root_forbidden`。

这次请求经 Relay 发给节点并等待同一次响应。它不写入 `dispatch_outbox`，失败后也不会自动重发。节点在实际打开目标时确认它仍在授权目录内；只检查路径字符串不算通过。

首版没有远程编辑，也没有完整文件下载。`POST`、`PUT` 和 `DELETE` 都不会修改节点上的文件。

## Web UI

员工页面在 `web/`。Coordinator 用 `go:embed` 提供 `internal/webui/dist` 里的构建结果，不另起 Node.js 服务，页面也不从第三方 CDN 加载脚本或样式。仓库保留这次构建结果，所以没有 pnpm 时 `go build ./...` 和 `go test ./...` 仍能编译。页面改动后需要重新构建，再编译 Coordinator，二进制里才是新页面。

浏览器只使用 `Secure`、`HttpOnly` 的会话 Cookie。登录响应里的 CSRF 令牌放在内存和当前标签页的 sessionStorage，用来设置 `X-CSRF-Token`。它不是会话凭据。注册凭据和节点连接凭据不写入 localStorage、sessionStorage、URL 或日志。

```text
cd web
pnpm install
pnpm dev
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm check:dist
```

`pnpm check:dist` 重新构建页面，`internal/webui/dist` 与仓库里的版本不一致时失败。构建结果是确定的，改了 `web/` 却没有提交新的构建结果，就会在这里发现。

`pnpm dev` 在 `https://localhost:5173` 启动，并把 `/api` 代理到 `BATON_DEV_API`（默认 `https://127.0.0.1:8080`）。Coordinator 的 `BATON_ALLOWED_ORIGINS` 需要包含 `https://localhost:5173`。

`pnpm test:e2e` 会先构建页面，再用 Playwright 驱动本机 Chromium，对真实的 Coordinator、PostgreSQL、Relay 和 batond 覆盖登录、注册节点、修改默认 PC、吊销从处理中到已生效，以及跨员工和无效会话被拒绝。运行前设置 `BATON_TEST_DATABASE_URL`。

## 测试

集成测试读取 `BATON_TEST_DATABASE_URL`，只连接这个 PostgreSQL，并在其中创建临时 schema。未设置该变量或连接失败时，测试失败，不会改用模拟数据库。

### CI 与本地等价命令

[GitHub Actions CI](https://github.com/hhubb22/baton/actions/workflows/ci.yml) 在每个 pull request 和推送 `main` 时运行四类检查。同一 PR／分支的新推送会取消旧运行，macOS 和 Windows 不会因另一平台失败而取消；失败不会被忽略。Go 版本从 `go.mod` 读取，并缓存模块与构建结果。测试加 `-v` 以记录每个测试的通过、失败和已有的条件跳过，加 `-count=1` 避免测试结果缓存。

| 检查 | 覆盖范围 |
|---|---|
| Linux（`ubuntu-latest`） | 原生构建、Windows/macOS 交叉编译、vet、完整测试、五个并发相关包的 race 测试 |
| macOS（`macos-latest`） | 原生构建、vet、完整测试 |
| Windows（`windows-latest`） | 原生构建、vet、完整测试，不以交叉编译代替运行 |
| Web（`ubuntu-latest`） | 锁定依赖安装、lint、typecheck、单元测试、Chromium E2E、嵌入产物一致性 |

CI 的 Linux 和 Web 各使用独立的 PostgreSQL 17 service container；macOS 和 Windows 使用 `ikalnytskyi/action-setup-postgres@v8` 安装 PostgreSQL 17。`BATON_TEST_DATABASE_URL` 连接 runner 本机端口 `55432` 的 `baton_test`，口令仅用于一次性 CI 测试库，不读取仓库 Secret。停库恢复测试会另建临时 PostgreSQL 集群，不停止共用测试库；Linux CI 另装主机 PostgreSQL 17 工具并设置 `BATON_TEST_POSTGRES_BINDIR`，避免误用 runner 预装的旧版。其他环境默认用 `pg_config --bindir` 定位工具，也可用该变量显式指定 PostgreSQL 17 的 `bin` 目录。第三方 action 固定到发布标签（PostgreSQL action 仅提供 `v8` 这样的版本标签）。

本地先准备可创建临时 schema 的 PostgreSQL 17 测试库并设置 `BATON_TEST_DATABASE_URL`（POSIX shell 示例，端口按本机实例调整）：

```sh
export BATON_TEST_DATABASE_URL='postgres://postgres:baton@127.0.0.1:5432/baton_test?sslmode=disable'
go build ./...
go vet ./...
go test -v -count=1 ./...
```

Windows PowerShell 用 `$env:BATON_TEST_DATABASE_URL = 'postgres://postgres:baton@127.0.0.1:5432/baton_test?sslmode=disable'` 设置变量，再运行同样的三个 Go 命令。Linux 另跑：

```sh
GOOS=windows go build ./...
GOOS=darwin go build ./...
go test -race -v -count=1 ./internal/session ./internal/node ./internal/store ./internal/relay ./internal/control
```

这里的 `-race` 覆盖测试包；进程测试内部通过普通 `go build` 启动的子进程不自动带 race instrumentation。需要同时检查子进程时可另跑 `GOFLAGS=-race go test -race -count=1 ./internal/relay`。

Web 使用 Node.js 24、pnpm 12.11.2（与 `.cursor/Dockerfile` 一致），保留上面的数据库变量，从仓库根目录运行：

```sh
cd web
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm check:dist
```

登录、退出、身份查询、CSRF 和 Origin 的通过路径使用本地 TLS 服务，并把测试证书放进客户端信任池。明文 HTTP 测试确认响应仍带 `Secure` Cookie：按正式 Cookie 规则、不把环回地址当作安全来源的客户端不会在明文请求里带回它。CSRF 和 Origin 检查在两条路径上都生效。节点注册的通过路径同样使用该 TLS 服务；`batond register` 通过 `BATON_TLS_CA_FILE` 信任测试证书。节点连接测试使用真实的 Coordinator、Relay 和 batond 进程，以及 TLS WebSocket，并注入断线、Coordinator 重启和 Relay 重启。准备测试另外启动真实的 Session Worker 和本地 SQLite，覆盖重复投递、batond 重启后连回原 Worker、同一 Session 的并发写入，以及本地持久化失败。启动许可测试覆盖中心事务和节点校验，并注入延迟、取消、吊销、墙上时钟跳变和暂停后唤醒。测试进程可以设置 `BATON_TEST_DROP_PREPARE_ACKS`、`BATON_TEST_FAIL_PERSIST`、`BATON_TEST_EXECUTOR_LOG`、`BATON_TEST_EXECUTOR_SCRIPT`、`BATON_TEST_SLOW_WRITE`、`BATON_TEST_ABORT_SCRIPT`（`unconfirmed`/`unknown`/默认确认）、`BATON_TEST_INPUT_GATE`、`BATON_TEST_HOLD_START`、`BATON_TEST_START_DELAY`、`BATON_TEST_START_GATE`、`BATON_TEST_RESULT_GATE`、`BATON_TEST_DUPLICATE_REPORT`、`BATON_TEST_WALL_OFFSET`、`BATON_TEST_SUSPEND_AFTER_ARM` 和 `BATON_TEST_PERMIT_FILE`。未设置时这些变量没有作用，它们不是操作者配置。
