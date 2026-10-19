# Baton

员工使用部署管理员分配的本地账号登录 Coordinator，退出，查询本人身份，领取一次性节点注册凭据，设置默认设备，吊销本人节点的连接凭据，并提交任务。初始口令只能使用到员工完成更换为止。`batond register` 用这张凭据注册节点，把身份保存在本机。`batond run` 用这份身份主动连接 Coordinator，断线后重连，并在同步完成前不会显示为可执行。吊销生效后，同一连接凭据不能再接入。任务被接受后，Coordinator 把准备命令送到节点；节点先把执行映射写入本地账本，再绑定一个独立的 Session Worker。

本目录目前包含这条路径的构建、迁移、HTTP 接口、Coordinator、batond、Session Worker、Agent 本地 CLI、受限文件浏览、员工 Web UI 和测试。准备阶段不启动 Agent。启动许可通过后，Worker 按 agent_type 选择 Pi 1.3.0 RPC、Codex CLI 0.163.0 thread/turn 或 Kiro CLI 2.32.0 ACP V3 适配器，任务输入只提交一次；结构化结果在中心保存之后才算交付。三者共用 internal/agent.Adapter 与 Worker 生命周期，测试执行器仍供故障注入使用。其他真实 Agent 适配和管理员网页不在这里；支持范围以明确版本和本机实测报告为准，不能用回放通过代替。

中心事务同时锁定任务与执行记录时，统一先锁 `tasks`，再锁 `executions`。准备成功或失败落库、启动许可、执行报告、取消和到期处理均按此顺序串行，避免准备落库与启动许可相互等待而死锁。

节点与 Session 的 SQLite 账本支持 Windows 盘符路径，以及含空格、中文、`%`、`#` 的数据目录；相对路径按进程工作目录解析。账本格式、WAL 与 FULL 同步设置不变。历史损坏按 SQLite 错误码识别，权限、锁、IO 和路径/URI 错误归为暂时读不了（`ErrHistoryUnread`），保留底层原因，不把打开失败当成损坏或新建空历史。

Gateway 进程测试的存活探测按平台实现：Unix 使用 `os.FindProcess` 与零信号，Windows 使用 `x/sys/windows` 打开进程句柄并查询等待状态，不把已退出但句柄尚存的进程判为存活。Worker 故障清理统一使用 `os.Process.Kill`；测试服务在 Unix 先发送 SIGTERM，在不支持该信号的 Windows 直接终止。诱饵进程由 Go 测试二进制启动，不依赖 `sleep`；Windows 子进程构建使用 `.exe`。独立停库测试按平台查找 PostgreSQL 可执行文件，Windows 使用 TCP 与固定测试角色，不依赖 Unix socket 或域用户名。产品恢复仍通过认证本地 IPC 确认原 Worker，不把 PID 存在当成同一执行的证据。

## Project Agent 输入与运行

中心保存 Project、主对话和记忆。用户消息先入队，所有设备离线时仍接受；用户修改记忆、标题或目标时，在同一事务里写被动通知。有主动输入或尚未完成的主动轮次时，Coordinator 选择已同步且对应 provider 已登录的 Runtime 节点，优先使用默认设备。每节点最多运行 4 个 Project Runtime，选用其他设备的原因记在运行记录里。

PS-156 提供输入领取、历史分页和 60 秒租约。batond 每 20 秒续租，58 秒未续租成功就停止 Runtime；旧运行的请求返回 `lease_lost`。Runtime 接口与本地 IPC 契约见 [Project Agent 技术设计](specs/project-agent/TECH.md#2-进程与通信)。生产 Runtime 安装、登录和 Agent 循环由 PS-158 提供；任务工具和终态结果入队由 PS-157 提供。本工单使用测试 Runtime 验证真实进程链路。

`POST /api/v1/projects/{id}/retry` 和 `/stop` 使用员工会话、CSRF 令牌与 JSON `{}`，分别重置模型失败状态和停止当前运行。待领取输入仍会触发后续运行，持续暂停使用 Project 的 `status=paused`。

## 运行要求

- Go 1.27
- PostgreSQL 17

## 统一 Agent 接入（PS-118 / PS-119）

执行边界只有 `internal/agent.Adapter`：`Start`、`SubmitInput`、`DeliverResult`、`HistoryContains`、`ReadHistory`、`Drain`、`Abort`、`Close`。`Drain` 非阻塞返回统一 `Output`，区分等待子任务、进度、最终结果、已 settled 与不确定；`Raw` 只写节点本地日志，不进入中心执行报告。`Abort` 的控制响应不是停止证据，`agent.StopObserver` 保留晚到的停止事实，Pi 的 agent_settled 和 Codex 的匹配 turn/completed 都经同一 Worker 路径补报，副作用不明仍待核实。

唯一选择点是 `internal/session/adapter.go:configureAdapter`，从同文件 `registeredAdapters` 按 `agent_type` 选择 `internal/agent/pi`、`internal/agent/codex` 或 `internal/agent/kiro`。新增执行类型只需实现统一接口并增加注册项，不再新增 Worker 分支。共同配置在原生启动前绑定到本地账本，恢复仍使用原 cwd、model、home、Session/Execution；Env 不入账本。恢复只加载原生历史，不重新发送任务输入或子结果，缺失映射不会创建替代会话。`Client.NativeHistory(cursor)` 经同一认证本地 IPC 返回分页历史；Pi 读取并校验本地 JSONL，Codex 查询 thread/items/list，不提供中心原文历史 API。

### Kiro ACP V3

任务指定 `agent_type: "kiro"`。节点安装 Kiro CLI 2.32.0，并在节点登录；Baton 使用 `kiro-cli acp --agent-engine=v3` 和已有 Go JSON-RPC 库，不安装 Node sidecar。可用 `BATON_KIRO_BINARY`、`BATON_KIRO_MODEL`、`BATON_KIRO_HOME` 指定程序、模型和原生登录环境。Agent 环境按白名单构造，只额外注入当前执行的 `BATON_CONTEXT_FILE`；Env 不进入账本。

任务输入先保存原生映射和操作意图，再写一次 `session/prompt`。最终 JSON 只在该 prompt 响应后交给 Worker 校验。活动补充输入保留 Kiro 的打断行为：发送 `session/cancel`，等待原 prompt 响应，再提交一次补充输入；旧回合的结果不进入新的输入代次。控制写入最多等待 5 秒，超时关闭管道并保留输入不确定性。

`session/cancel` 本身不确认停止，原 prompt 返回后由 StopObserver 补报停止；使用过工具时保留副作用未知。空闲子结果只在来源明确等待时注入一次。忙碌来源通过已有 `baton task result` 查询取得结果；交付确认需要原生 user 输入中的精确 `delivery_id`，或同一 execute 工具、退出码 0 的 shell 输出。活动查询先让 CLI 返回，随后异步检查持久历史；最终结算等待该检查，无法确认时保持待核实。

恢复先校验受限映射，再按 `session/list` 核对原生 ID 和 cwd，最后调用 `session/load`，不发送 prompt。缺少映射或会话直接返回历史缺失。历史通过独立 ACP 连接读取，查询不使用执行连接；浏览器沿用有摘要的分页游标和 14 KiB 页限制。加载快照最多保留 8 MiB，超过上限返回不可读，原文仍在节点。

真实入口默认跳过。模型可通过 `BATON_REAL_KIRO_MODEL` 选择；首批普通场景使用 qwen3-coder-next，用户授权后的委托和活动补充输入使用 gpt-5.6-sol。委托需要隔离 PostgreSQL 17，版本、模型、场景和派生回放说明见 [Kiro 转录](internal/agent/kiro/testdata/replay/README.md)。

```sh
BATON_REAL_KIRO=1 BATON_REAL_KIRO_MODEL=gpt-5.6-sol \
  go test -v -count=1 ./internal/gateway -run '^TestRealKiro$' -timeout 30m
```

设置 `BATON_RECORD_DIR` 时，目录须位于系统临时目录内且在仓库外；规范化、残留扫描和原始录制删除流程沿用 [Agent 回放工具](tools/agent-replay/README.md)。真实 Kiro 验证范围为 macOS arm64；其他系统只登记 CI 实际覆盖的构建和回放结果。

### Codex thread/turn

任务指定 `agent_type: "codex"`，推荐显式指定节点上已存在的绝对 `working_directory`；省略时使用该 Session 的隔离 workspace。节点安装 **Codex CLI 0.163.0**，认证由节点管理员在 Agent 环境内配置，Baton 不替用户登录。运行 batond 前可设置：

| 变量 | 作用 |
| --- | --- |
| `BATON_CODEX_BINARY` | 可执行文件，默认 codex；参数数组启动，不经过 shell |
| `BATON_CODEX_MODEL` | 模型名称，支持选择低价模型；恢复沿用账本绑定 |
| `BATON_CODEX_HOME` | 可选独立 CODEX_HOME，恢复不切换到新 home/thread |

Session 映射 thread，执行输入映射 turn；活动子结果输入用 turn/steer，中止用 turn/interrupt。clientUserMessageId 仅关联本地输入标识，不作为幂等保证。发送前持久化意图，发送窗口不明或恢复身份不符时不重放；只有原生 userMessage 或成功查询工具输出中的精确 delivery_id 才确认子结果 delivered。完成必须核对匹配 thread/turn 的 turn/completed 和结构化 JSON，不能由初始化、普通文本或进程退出推断成功。

只传递基本进程环境、指定 CODEX_HOME 和受限 BATON_CONTEXT_FILE 路径，不继承中心 token、数据库 URL、签名密钥或 1Password 凭据。Agent 通过 PATH 中的 baton CLI 委托和查询子任务。使用 approvalPolicy=never、workspace-write sandbox，允许 sandbox 网络访问本地委托入口；不能把提示中的授权范围当作 OS 隔离。服务端审批、登录刷新、交互工具请求均明确拒绝。中止 ACK 不证明外部 shell 或副作用已结束。

### Codex 验证边界与真实任务入口

当前适配基线为 Codex 0.163.0，官方 Schema 已更新；0.162.1 的已有录制与历史映射继续按原版本校验。PS-181 用本机客户端补录工具执行中的中止，真实驱动先核对工具开始帧，再发中止；两层回放分别门控工具开始、ACK 与停止事实。

Codex 通信使用 jsonrpc2 v0.2.3 的连接关闭修复；回归固定缓冲响应与关闭并发的顺序，并检查并发关闭释放待决调用。录制派生同时覆盖响应后立即退出和响应消费后退出，Worker 保持待核实、原任务不重发（PS-180）。

CI 默认运行固定 Schema、录制转录回放、Pi/Codex 共用 Worker 回归和 race。[Agent 转录回放工具](tools/agent-replay/README.md) 提供 NDJSON 读写、严格出站比较、跨进程捕获、历史写入、门控和派生变体。Pi 的适配器层回放 PS-175 的全部 12 份真实转录，Worker 层覆盖适用场景与故障变体；Codex 两层回放已提交的 11 份真实转录。旧假 Agent 与人工样本已删除。来源、适用范围和旧覆盖点对应表见 [Pi 场景说明](internal/agent/pi/testdata/replay/README.md) 与 [Codex 场景说明](internal/agent/codex/testdata/replay/README.md)；协议分帧和边界条件保留单元测试。录制器支持字节透传、历史追加采集和退出/信号记录，规范化工具支持路径与 ID 替换、会话筛选和残留拒绝；真实测试按场景拆分，设置 `BATON_RECORD_DIR` 可录制各场景。固定版本无模型握手可显式运行：

```sh
BATON_CODEX_PROBE=1 go test -v ./internal/agent/codex -run TestCodexInitializeWithoutModel
```

用户已在 macOS、Codex 0.162.1 / gpt-6-luna 上报告：启动、输入、结构化结果、turn 完成、中止、恢复、历史支持；委托链路成功，但子任务违反“不要再委托”而使原断言失败，不能将委托整项标为通过。真实测试保留这些能力断言，并将场景分成独立会话；首批录制见 PS-175；PS-181 在 macOS arm64、Codex 0.163.0 / gpt-6.1-sol 上重跑全部 11 个适用真实场景通过，包含父子委托，自由文本按约束跳过。

真实入口默认跳过，只使用临时工作目录和独立、显式认证的临时 CODEX_HOME，不复制常用 ~/.codex 认证，不打印凭据。委托使用 BATON_TEST_DATABASE_URL 的临时 schema（PostgreSQL 17，禁止生产库），输出版本、平台、模型及逐项“支持/不支持/未验证”。Codex 和 Pi 的真实测试与录制默认使用 `gpt-6.1-sol`（Pi 为 `openai/gpt-6.1-sol`），Cursor、Kiro 仍使用账号当前可用的最便宜模型。这些命令在本机执行：

```sh
npm install -g @openai/codex@0.163.0
bash .cursor/start.sh
# 按本机测试库配置导出 BATON_TEST_DATABASE_URL。
export BATON_REAL_CODEX_HOME="$(mktemp -d "${TMPDIR:-/tmp}/baton-codex-real.XXXXXX")"
CODEX_HOME="$BATON_REAL_CODEX_HOME" codex login
BATON_REAL_CODEX=1 BATON_CODEX_MODEL='gpt-6.1-sol' \
  go test -v -count=1 ./internal/gateway -run '^TestRealCodex$' -timeout 60m
# 检查输出后删除临时 CODEX_HOME（含本次认证）。
rm -rf -- "$BATON_REAL_CODEX_HOME"
```

无新增中心迁移；依赖 sourcegraph/jsonrpc2 v0.2.1，固定 Schema 测试使用 santhosh-tekuri/jsonschema/v5 v5.3.1。

## 中心部署与升级

中心运行一个 Coordinator 与 PostgreSQL。将 `/v1/node` 和 `/api/v1/events` 的 WebSocket 升级转发给同一 Coordinator 端口，入口提供 TLS；直接监听 HTTPS 时设置现有证书和密钥变量。普通 API 保留 20 秒读取、60 秒写入期限，节点和浏览器长连接单独清除请求期限。保留单活动 Coordinator，不支持多个进程共同调度同一数据库。

原版 batond 继续使用原身份、签名密钥、凭据和节点/Worker 账本，只把 `batond run --relay` 的地址改为 `wss://baton.example/v1/node`。`--relay` 保留为客户端兼容参数。Coordinator 重启会断开节点；节点重新认证、完成 `node.sync` 后才可执行，旧 Worker 按原许可和期限继续，结果按原事件标识补报，中心不重新发送原任务输入。

每节点上/下行各有 32 条、1 MiB 的控制队列和 16 条、256 KiB 的输出队列；另有 2 条同步队列。队列计入在途处理/写入，断开释放剩余消息。中心最多同时认证 32 个节点、处理 16 个业务调用和保留 128 个连接槽位。控制/输出入站速率分别为每秒 64/128 条，突发额度相同；超限返回 `queue_full`，只限制来源节点。节点轮转调度，每处理最多 8 条控制消息为输出留一次机会。Gateway、待返回的 Session 输出及浏览器写入共用 32 MiB 输出预算，输入与原操作查询不占输出额度。这些值是当前固定保护上限，容量验证另见相应工单。

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
| `BATON_NODE_SIGNING_KEY` | Coordinator 的 Ed25519 PKCS#8 私钥文件，权限必须是仅当前用户可读 |
| `BATON_HEARTBEAT_INTERVAL` | 心跳间隔，默认 `10s`，允许 `100ms` 到 `2m` |
| `BATON_OFFLINE_AFTER` | 未联系超过该时间判离线，默认 `30s`，允许 `200ms` 到 `10m`，并且必须晚于心跳 |
| `BATON_ENROLLMENT_TOKEN` | `batond register` 读取的一次性注册凭据。不要写入命令行 |
| `BATON_TLS_CA_FILE` | `batond` 额外信任的 CA 证书文件。地址仍必须是 https 或 wss |

会话 Cookie 名为 `baton_session`，固定带 `Secure`、`HttpOnly` 和 `SameSite=Strict`。进程监听 HTTP 时也保持这些属性。浏览器只在 HTTPS 请求里送回该 Cookie；入口代理终止 TLS 时，浏览器看到的来源仍是 HTTPS。

注册凭据和节点连接凭据不进入 URL、命令行参数或日志。注册凭据和浏览器会话在数据库里只保存 SHA-256。节点连接凭据是 Ed25519 签名的 JWT，数据库只保存可吊销的 `credential_id`，不保存 JWT。签名私钥只在 Coordinator。

身份文件、签名私钥、Agent CLI 上下文和文件形式的注册凭据均只允许当前用户访问。Linux/macOS 写入权限为 `0600`（节点数据目录为 `0700`）；Windows 写入时设置当前用户为所有者，并使用只授予该用户访问的受保护 DACL，去掉继承，不额外授权 SYSTEM/Administrators。读取时检查真实文件句柄的权限；其他用户或组可访问、继承或未保护的 DACL 均拒绝。外部提供的 Windows 签名私钥和注册凭据文件也必须满足此 ACL，默认继承 ACL 不会被自动接受。秘密文件不能是符号链接，Windows 还拒绝路径中的 junction 等 reparse point。

## 命令

```text
go build -o bin/coordinator ./cmd/coordinator
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
BATON_DATABASE_URL=postgres://127.0.0.1:5432/baton BATON_ALLOWED_ORIGINS=https://baton.example BATON_NODE_SIGNING_KEY=./node-signing.pem ./bin/coordinator serve
```



创建和重置把一次性口令写到标准输出，只显示这一次。数据库保存 Argon2id 摘要。标准错误和 HTTP 日志不记录口令、会话令牌、CSRF 令牌、注册凭据或节点连接凭据。不要把标准输出并进普通运行日志。

`serve` 在迁移完成前拒绝启动。

## Plane 触发（社区版 1.4.2）

可选的独立入口 `POST /hooks/plane` 使用迁移 `0013`；不设置 Plane 环境变量时不启用。部署时在**非秘密**的 `BATON_PLANE_CONFIG` JSON 中配置 `workspace_id`、`workspace_slug`、`project_id`、`webhook_id`、`approval_label_id`（项目标签名称须为 `design-approved`）和 `actors`。每个 actor 明确填写 `plane_user_id`、`email`、`employee_id`，以及 `task` 内的 `target_node_id`、`agent_type`、`working_directory`、`authorization_scope`、`expected_outputs`；不能借用默认设备或推测授权。目标节点必须归该员工所有且可用于任务接受。描述来自 Plane 工单名称和非空 HTML 正文，不接受配置覆盖 `request_id`、`description` 或来源 Session。

Plane Origin、API token、Webhook 密钥分别只通过 `BATON_PLANE_URL`、`BATON_PLANE_API_KEY`、`BATON_PLANE_WEBHOOK_SECRET` 注入环境变量；JSON 不能含凭据，URL 使用 HTTPS（仅本机 loopback 测试可用 HTTP）。接收端须能访问 Plane 的 v1 工单、状态、标签、活动列表和实例版本接口，并有项目可见性。公网部署由可信反向代理提供 TLS，不把密钥放在 URL、日志或配置文件。Webhook 需携带 `X-Plane-Event`、`X-Plane-Delivery` 和对**原始正文**计算的 `X-Plane-Signature`；本入口最多读取 1 MiB。

创建事件只关联工单；工单当前属于 `started` 状态组、含已配置的 `design-approved` 标签、状态活动证明该轮操作者且员工映射及显式任务字段齐全时，才经现有 `AcceptTask` 接受任务。签名/范围错误返回 4xx；验签与范围检查后，先在一个事务里保存关联、去重摘要和判断所需的精简事件字段，不保存完整 Webhook 正文。不可读取 Plane 或暂时无法接受时返回 503，但不依赖 Plane 重投：Coordinator 每秒扫描到期 pending，使用已存事件和重新 GET 的当前事实补做，最多尝试 8 次（含首次），以 5 秒起指数退避、上限 5 分钟；进程重启后继续。耗尽后收件记录标为 `blocked/retry_exhausted`，保留输入与 `last_error_code` 供以后人工处理，不自动重新放行。接受成功但确认丢失时仍先恢复已有任务，不因耗尽误报阻塞。200 的 `outcome` 为 `linked`、`ignored`、`blocked` 或 `accepted`；`blocked` 附有 `code`/`fields` 并保存在 `plane_deliveries`，状态轮次存在时也保存在 `plane_triggers`。同一轮次重复投递只返回已有任务，不启动第二个执行。若首个收件事务都无法提交，则无法补做；返回 503 并记录带 `delivery_id` 的 `plane_inbox_write_failed` 错误，须从来源人工核查/补发。

结果回写使用迁移 `0019`。在 `BATON_PLANE_CONFIG` 加入 `baton_url`（Baton 的 HTTPS Origin）后启用后台回写；未配置时保留队列并记录 `plane_writeback_config_missing`，补齐配置并重启即可继续。任务变化及其结果快照在同一事务提交；关联任务时补入当前版本。评论带 `external_source=baton`、稳定的回写记录 UUID 和 `access=INTERNAL`，正文含任务链接、版本、状态、最多 500 字摘要及证据入口。证据通过受本人权限保护的任务 API 查询，评论不复制资源名、存储路径、Session 历史或工具输出。摘要和验收意见经过现有敏感内容过滤及 HTML 转义，发布前仍须将结构化摘要限定为允许项目成员阅读的内容。

后台每秒扫描，每批最多处理 16 条；领取租约为 45 秒加退避，同一任务按版本依次发送。失败从 5 秒起指数退避，上限 5 分钟，持续保留待回写，不重跑任务。每次尝试先逐页列出评论并核对标记；读取失败时不创建。无匹配评论才用同一标记 POST，201 或 409 后 GET 核对评论 ID、工单、项目、工作区、可见性和来源。进程重启及确认落库失败继续使用原回写 ID。已确认的评论不因后续删除而自动重建。

执行成功回写“执行成功，待员工验收”。员工通过 `POST /api/v1/tasks/{id}/acceptance` 提交 `expected_version`、`decision`（`passed` 或 `rejected`）和 1～400 字 `comment`；接口使用本人登录会话、CSRF 与 Origin 检查。任务须已有完成、失败或取消的确定结论；待核实任务先走 `/resolve`。验收保留执行状态、摘要和证据，增加任务版本，单独记录员工、时间及意见并生成回写；不会启动 Agent，也不自动修改 Plane 的 Done 状态。`GET /api/v1/tasks/{id}/acceptance` 返回本人任务的验收历史。旧版本请求返回 409；响应丢失时先查询验收历史和最新任务版本，不能直接重发。人工 `/resolve` 修正结论后需要重新验收；迟到证据和原任务重做审计保留已有验收，既有验收历史始终保留。

隔离实测使用 `BATON_PLANE_LIVE=1 go test -run '^TestPlaneLiveReplay$' -count=1 -v ./internal/plane`：仅在拥有 `Baton Test` 保险库只读权限、测试数据库和已授权的测试项目时启用。测试用 `baton-t25-` 前缀新建工单与必要的审批标签，最终清理并核对原有计数；不触碰生产工单或打印凭据。T27 真实评论契约测试使用 `BATON_PLANE_LIVE=1 go test -run '^TestPlaneLiveWriteback$' -count=1 -v ./internal/plane`，只在同一测试项目创建并清理 `baton-t27-` 工单，覆盖外部成功后响应丢失、短时 503、稳定标记恢复和单独验收；不运行真实模型。

```text
batond register --coordinator https://baton.example --display-name "Desk" --system linux --capability start
```

注册凭据放在 `BATON_ENROLLMENT_TOKEN`，或放在仅当前用户可读的文件里并用 `--enrollment-file` 指向它。两种方式只能选一种。未指定 `--data-dir` 时，Linux 使用 `$XDG_DATA_HOME/baton/node`（未设置时为 `~/.local/share/baton/node`），macOS 使用 `~/Library/Application Support/baton/node`，Windows 使用 `%LOCALAPPDATA%\baton\node`。

系统取 `windows`、`macos` 或 `linux`。`--role` 兼容旧命令且可省略，不影响节点选择。`--capability` 可重复，名称使用小写字母、数字、点、下划线和连字符。

连接凭据只写入数据目录中的 `identity.json`，权限为仅当前用户可读写。标准输出只打印节点 ID 等非秘密字段。命令会说明当前使用文件保存，而不是系统凭据存储。数据目录里已经有身份时，命令不会再次注册。

```text
batond run --relay wss://baton.example/v1/node
```

`run` 读取同一份身份，主动建立 TLS WebSocket。断线后按 1 到 30 秒、带抖动的指数退避重连。认证失效时进程退出并说明需要重新认证，不会重新注册。每次启动生成一个 incarnation；已有另一个 incarnation 在线时，后启动的进程不能接管该节点。

## Pi 1.3.0 原生适配与真实验证

Project Agent Runtime 随 batond 的 Node bundle 分发。运行 `node tools/package-batond.mjs` 构建安装目录，目标设备需要 Node.js 22.19.0 或更高版本。安装、OAuth 登录和 probe 见 [Runtime 说明](runtimes/project-agent/README.md)，共用的 sidecar 分发与进程约定见 [Node sidecar 约定](runtimes/README.md)。

节点安装固定版本 `npm install -g @earendil-works/pi-coding-agent@1.3.0`，并将 `pi`、`node`、`baton` 放入 batond 的 `PATH`。`agent_type=pi` 走独立适配器；设置 `BATON_PI_BIN` 可指定可执行文件，`BATON_PI_MODEL` 可指定 `provider/model-id`（也支持 `agent.Config` 的 Binary/Model/Env 配置）。不匹配 1.3.0 会拒绝启动，不自动升级。`BATON_TEST_EXECUTOR_LOG` 仅用于现有测试执行器，显式 `BATON_AGENT_DRIVER=native` 可在测试中覆盖选择。

Pi 使用 `--mode rpc`，禁用自动任务重试、启动联网、扩展/MCP/skills/外部上下文自动加载。工作目录取任务 `working_directory`，未指定时为 Session 独立的 `workspace`。原生 v3 历史与映射保存在 `sessions/<session_id>/native`，只按 LF 消费 RPC 帧，CRLF 兼容、U+2028/U+2029 保留为内容。`prompt` 接受与 `agent_end` 都不算完成，只有 `agent_settled` 后才提交结构化候选结果；异常退出报告待核实，不伪造停止事实。

明确等待子结果用 `{"baton_waiting_for_children":true}`；自动继续只注入一次带 `delivery_id` 的结果。忙碌回合可用 `baton task result` 查询：Worker 等原生历史的 user 输入或成功 bash toolResult 中出现**精确** delivery_id 后，才记录 delivered。确认前不发送 delivered 回执；settled 时仍无法确认、或 Worker 崩溃，保留 uncertain，不重注入。batond 重启只重连原 Worker；Worker 丢失后保持待核实，不自动重启 Pi 或重发输入。适配器显式 Restore 校验映射、原生文件、v3 header、ID 与工作目录，再用 `--session <file>` 加载；文件缺失、截断或越界不会创建空会话。恢复本身不发送 prompt。

用户在 fa125f9、Darwin 27.2 arm64、Pi 1.3.0 / `google-vertex/gemini-3.1-flash-lite` 的隔离目录实测反馈如下，不扩展到其他模型或系统：

| 能力 | 实测结论 | 边界 |
|---|---|---|
| 启动、输入、结构化结果、委托、原生历史确认、恢复、缺失历史拒绝、目录隔离 | 支持 | 来自用户真实模型实测，不是云端回放结论 |
| 中止 | 等当前工具结束后生效，不能中断运行中的工具 | 中止后仍观察到工具写入；停止不等于操作结果已知。本轮 Worker 延迟停止补报闭环仍待用户复跑 |

Worker 在首次中止报告后继续只读观察适配器的停止证据；即使 `Abort` 等待超时，后来观察到 `agent_settled` 仍会持久化并补报确认停止。两份报告使用不同且稳定的事件 ID，重复轮询、ACK 丢失或账本重开不重复创建确认事件；中心沿用已有事件去重记录 `stop_confirmed_at`。Pi 使用过工具时仍上报 `OutcomeKnown=false`，任务保持待核实与执行绑定，不把稍后的 assistant error 当普通失败结果覆盖。是否在超时后强制结束 Pi 进程树尚未决定，本轮不实现，见 TECH 的 Q6。

真实入口的中止轮询通过 `store.GetTask` 读取状态与从 `execution_stops` 派生的停止字段，不直接把它们当作 `tasks` 的列；读取失败保留脱敏后的实际错误。无模型回归 `go test -v -count=1 ./internal/gateway -run '^TestRealPiStopStatusRead$'` 使用测试 PostgreSQL、真实 Baton 进程及计数执行器，覆盖无停止记录和已有停止确认但结果未知的读取，不启动 Pi 或调用模型。

无模型检查（不登录、不执行任务）：

```sh
BATON_PI_PROBE=1 go test -v -count=1 ./internal/agent/pi -run '^TestPiNoModelProbe$'
```

真实入口默认跳过、CI 不启用。**在 macOS 开发机**准备 Go、PostgreSQL 17 测试库、上述 Pi/Node 版本，设置 `BATON_TEST_DATABASE_URL`、`BATON_PI_MODEL`（默认 `openai/gpt-6.1-sol`）与所选 provider 的 API key 环境变量（例如 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 或 Vertex 的 `GOOGLE_CLOUD_API_KEY`）。`GOOGLE_CLOUD_API_KEY` 会保留在隔离进程环境中，Vertex 可选择 `BATON_PI_MODEL=google-vertex/gemini-3.1-flash-lite`。不要把 key 值写进命令、文件或输出；入口不会读取已登录用户的 auth.json、HOME 或真实工作区，因此只有 OAuth 登录、没有独立环境凭据时需先准备所选入口的环境凭据。已有测试库需允许创建临时 schema，禁止指向业务库。运行：

```sh
BATON_REAL_PI=1 go test -v -count=1 -timeout=60m ./internal/gateway -run '^TestRealPi$'
```

两个真实入口支持 `-run '^TestRealPi$/^simple$'` 或 `-run '^TestRealCodex$/^deliver_active$'` 单独运行场景。每个子测试使用独立的工作目录和会话，能力矩阵在全部子测试清理后输出。Pi 的 `deliver_active`、Codex 的 `result_free_text` 会明确跳过，原因见各自的 [Pi 场景说明](internal/agent/pi/testdata/replay/README.md) 和 [Codex 场景说明](internal/agent/codex/testdata/replay/README.md)。Pi 还保留 `startup`、`restore_recall`，Codex 保留 `delegation`，用于覆盖原有探针、上下文回忆及完整 CLI 委托断言。

### 本机录制与规范化

PS-175 的首轮录制使用 Codex 0.162.1，PS-181 升级适配器并使用本机 0.163.0 补录。在仓库根目录打开 Bash，准备 Pi 1.3.0、Codex 0.163.0、Node.js 和测试数据库。Codex 和 Pi 默认使用 `gpt-6.1-sol`（Pi 为 `openai/gpt-6.1-sol`），Cursor、Kiro 仍使用账号当前可用的最便宜模型。`provider_error` 故意使用不存在的模型名，不会升级到其他模型。

```sh
bash
source ~/.baton-env.sh
bash .cursor/start.sh
: "${BATON_TEST_DATABASE_URL:?需要允许创建临时 schema 的测试库}"
npm install -g @earendil-works/pi-coding-agent@1.3.0 @openai/codex@0.163.0

# 从凭据管理器取得所选 provider 的 key，用静默输入避免写进命令历史。
read -r -s -p 'OpenAI API key: ' OPENAI_API_KEY
printf '\n'
export OPENAI_API_KEY
export BATON_PI_MODEL='openai/gpt-6.1-sol'
# 默认模型需提供 OPENAI_API_KEY；选择其他 provider 时使用对应模型和环境变量。
# Pi 不读取常用 HOME 的登录文件。

# Codex 在一次性的 HOME 中独立认证，保留常用登录目录。
export BATON_REAL_CODEX_HOME="$(mktemp -d "${TMPDIR:-/tmp}/baton-codex-real.XXXXXX")"
CODEX_HOME="$BATON_REAL_CODEX_HOME" codex login
export BATON_CODEX_MODEL='gpt-6.1-sol'

# 系统临时目录中的新目录，位于仓库外；每次运行使用新目录。
export BATON_RECORD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/baton-agent-record.XXXXXX")"
go build -o "$BATON_RECORD_DIR/agent-replay" ./tools/agent-replay
BATON_REAL_PI=1 go test -v -count=1 -timeout=60m ./internal/gateway -run '^TestRealPi$'
BATON_REAL_CODEX=1 go test -v -count=1 -timeout=60m ./internal/gateway -run '^TestRealCodex$'
```

录制器使用旁置的 `.record.json` 和场景 JSON 文件；原始文件分别写入 `$BATON_RECORD_DIR/pi/<scenario>.raw.ndjson` 和 `$BATON_RECORD_DIR/codex/<scenario>.raw.ndjson`。恢复进程继续追加同一场景文件。Pi 的进程层次为 Worker → 录制器 → `pi-isolated` → `sandbox-exec` → Pi，沙箱策略、真实 Agent 的参数和环境保持原有配置。录制配置保存调用测试的系统临时根目录，因此 Pi 隔离 HOME 的 `TMPDIR` 不会改变原始目录检查范围。未设置 `BATON_RECORD_DIR` 时直接使用原 Agent 路径。

历史顺序回归测试 `TestRecordHistoryBeforeStdout` 使用完整 stdin 帧，分别检查 stdout 透传时的历史条目顺序和最终追加内容；失败时输出每次 observe 的状态和实际原始条目。Linux race 压测命令为 `go test -race -count=200 -run '^TestRecordHistoryBeforeStdout$' ./internal/agent/replay`。

先检查每个子测试结果及能力矩阵；失败场景的录制只留在本机排查。确认需要保存的场景通过后，在同一个 Bash 中规范化：

```sh
# CLI 成功规范化后会自动删除对应 .raw.ndjson；失败时保留输入供本机检查。
for agent in pi codex; do
  mkdir -p "internal/agent/$agent/testdata/replay"
  for raw in "$BATON_RECORD_DIR/$agent/"*.raw.ndjson; do
    [ -f "$raw" ] || continue
    scenario="$(basename "$raw" .raw.ndjson)"
    "$BATON_RECORD_DIR/agent-replay" normalize \
      --input "$raw" \
      --output "internal/agent/$agent/testdata/replay/$scenario.ndjson" || break
  done
done

git diff -- internal/agent/pi/testdata/replay internal/agent/codex/testdata/replay
git status --short internal/agent/pi/testdata/replay internal/agent/codex/testdata/replay
# 用本地编辑器逐个检查新增和修改的 NDJSON：模型/工具输出、路径占位符、
# delivery_id、恢复帧和 dropped_frames，确认无凭据、机器名或个人信息。
# 同版本再录一次 simple，比较规范化结果；第二轮使用新的 BATON_RECORD_DIR。

# 检查完毕后删除全部原始录制、锁文件、录制工具和本次认证。
# 删除前先确认这些变量仍指向刚创建的临时目录。
rm -rf -- "$BATON_RECORD_DIR" "$BATON_REAL_CODEX_HOME"
unset BATON_RECORD_DIR BATON_REAL_CODEX_HOME OPENAI_API_KEY
```

规范化残留扫描失败时先修正路径绑定或检查敏感输出，再重录或重试；只提交人工检查通过的 NDJSON。规范化会保留首个原生会话，委托子会话被删除并计入 `dropped_frames`。`restore_missing` 的 Pi 拒绝发生在本地历史预检，转录包含本场景的建会话过程，回放测试需同时构造缺失历史目录；Codex 使用指向不存在 thread 的映射，录下 `thread/read` 失败，不新建 thread。`interrupt_before_turn_started` 在提交返回后立即中止，具体原生事件先后顺序以录制为准。首次录制还需确认关闭 Worker/录制器后 Pi、Codex 与工具子进程均已退出；录制器被 SIGKILL 后的子进程清理仍是设计中的待验证项。

若需要在本机检查失败时的原生历史，可在同一命令前增加 `BATON_REAL_PI_KEEP=1`。入口会提前打印独立隔离目录的绝对路径，结束后不自动删除其中的 `isolated`（HOME、工作区、探针）与 `stack/node/sessions`（Worker 原生历史）；两者为兄弟目录，沙箱仍只允许 Pi 读取指定的会话目录，而非 `stack` 中的节点密钥。默认不设置时两处目录照常由 `go test` 清理。保留目录还包含测试用密钥、节点身份、上下文令牌和会话原文：**仅在自己的开发机检查，不上传/粘贴原始文件或目录清单；排查完成后自行删除整个隔离目录。** 临时测试数据库 schema 仍按原有清理流程处理，不在保留目录内。

此入口在临时目录构建 Baton 二进制，创建独立 HOME/Pi 配置/工作区、测试 schema 与真实 Coordinator/batond/Worker，透传允许的 provider 环境变量，不复制或打印凭据。macOS `sandbox-exec` 在 `deny default` 后导入系统 `bsd.sb` 提供进程启动权限，再收紧文件读写，只额外允许系统/运行时只读路径与测试 IPC。先验证目录内可写可读，再检查目录外测试哨兵不可读写、符号链接不能越界；沙箱启动崩溃不能冒充隔离成功。失败输出退出码、错误（含信号）和 stderr，不退回无沙箱模式；Go 的退出码 `-1` 表示没有普通退出码，例如进程被信号终止。使用模型验证一次输入/结构化结果、CLI 委托与子结果原生历史确认、执行中中止、batond 重连，以及原生 Session 加载后新回合的上下文回忆与夹具未重放；另检查缺失历史拒绝。输出工具版本、平台、请求/实际模型及各能力“支持/不支持/未验证”；任务失败/待核实时先脱敏，再只输出中心记录的 `status`、`error_code`、`error_message`、`summary` 和 `evidence_empty_reason`，不打印原生历史。若中心为 `result_format`，本次模型的结构化结果标为“不支持”（检查所选廉价模型的输出），不能推断其他模型均不支持。任务提示给出完整有效 JSON 示例，但真实模型是否遵循仍待实测。默认退出清理临时目录与测试进程；模型不遵循协议或环境问题会使其他对应能力保留未验证，不能据此宣称跨平台支持。

Pi 初始化探针及历史恢复失败时，入口输出 `Start` 错误与阶段（`version` / `rpc`、具体握手步骤）、子进程退出码和错误/信号、stderr 最后 20 行（至多保留 8 KiB 原始尾部，截断时丢弃首段不完整行）。诊断仅通过 `pi.WithDiagnostics()` 显式启用，保存在内存、不写原始日志文件；输出前屏蔽实际敏感环境值、常见凭据字段/Bearer/JWT 和疑似 key 的长串，不输出 stdout、RPC 状态或原生历史。`sandbox-exec` 或 Pi 写到 stderr 的拒绝原因也保留；`exit_code=unavailable` 表示没有取得进程退出状态，`-1` 需结合信号错误判断，`cleanup_kill_requested=true` 表示 Baton 曾请求强制清理。生产默认继续丢弃 stderr。

适配器启动的版本检查与 RPC 子进程（含恢复）均显式使用配置 `Directory` 的规范路径作为 cwd，不依赖 batond/Worker/调用方当前目录，不放宽沙箱。原生历史直接由 Go 文件 API 在已校验的目录内读取，不另启动 Pi。macOS 沙箱回归使用 Node.js 无模型夹具：先确认继承调用方目录会触发 cwd 的 EPERM，再验证从同一调用方完成版本检查、新建握手和历史恢复；这不代表真实 Pi 模型验收。该回归需要 Node.js，macOS CI 检查其存在并重复运行 10 轮。

沙箱自检和初始化拒绝诊断可不带模型或数据库单独运行；macOS CI 重复执行 10 次并记录 Darwin 版本，不能据此推断其他 macOS 版本兼容性：

```sh
go test -v -count=10 ./internal/gateway -run '^TestPiSandbox'
```

生产适配器**不是 OS 沙箱**：工作目录与系统提示不能限制工具访问。需按部署环境提供外部沙箱和最小权限；`BATON_PI_HOME` 可选择隔离 HOME/配置与有限环境变量，但它本身不限制文件或网络权限。真实入口的沙箱也只证明本地文件隔离，不是网络隔离或抵御恶意模型泄露凭据的安全证明。Linux/Windows 真实模型入口尚未验证；不能把 Go 交叉编译、原生 CI 的 fake RPC 子进程回放或无模型握手当成真实模型通过。

## Agent 本地 CLI

batond 在准备执行时创建 `sessions/<session_id>/agent-<execution_id>.json`（相对于节点数据目录；Unix 文件权限 `0600`，Windows 使用上述受保护 DACL）。执行环境用 `BATON_CONTEXT_FILE` 指向**该次执行**的文件；不要把文件内容、令牌或节点连接凭据放进命令行、任务说明或日志。Pi 适配器已在进程启动时注入此变量；测试执行器不启动真实 Agent。

```text
baton delegate --request-file request.json --json
baton task get TASK_ID --json
baton task wait TASK_ID --timeout 30s --json
baton task result TASK_ID --json
baton task relations TASK_ID --json
baton task cancel TASK_ID --json
```

委托文件最小内容为 `{"request_id":"stable-request-id","description":"读取目标现场信息"}`。调用方自行保存稳定的 `request_id`；重试必须沿用原 ID 和原内容。CLI 不生成 ID，也不因等待到期或响应丢失重新委托。相同内容返回原任务，不同内容返回 `conflict`，即使默认设备后来改变也不改派原任务。未指定目标时使用中心保存的本人默认设备；目标离线仍保留这个目标。

所有命令走当前用户限定的 Unix socket / Windows named pipe，再经已有认证 Gateway 通道访问中心。文件只含 IPC 地址和随机凭据，来源三元组由 batond 的 SQLite 绑定解析；员工、节点由 Gateway 认证决定。中心重新核对来源任务、Session、Execution 和节点。新委托只允许从尚在执行、未取消且未到期的当前绑定发起；已接受任务在来源结束后仍可查询。请求不能指定其他员工或替换来源；授权文本完全继承来源，显式指定时必须逐字相同，不推断自由文本权限包含关系。查询和取消仅限来源任务及其直接委托，不开放同员工的其他任务。

`task get` 返回中心状态、Execution 和 `input_generation`。查询子委托时，`delivery_status` 表示子结果交给来源 Worker 的状态，`delivery_id` 是稳定交付标识；查询来源任务自身时，`delivery_status` 仍表示该执行结果是否已存中心。`task result` 同时返回可信 `task_id`、`target_node_id`、`session_id`、`execution_id`、状态、摘要、证据、产物和错误；未保存候选结果时 `ready` 为 false。`task relations` 返回该任务的来源与执行边，以及从当前来源 Session 发出的直接子委托，单次上限 100 条，超出明确报错，不静默截断。

`task wait` 默认 30 秒，允许大于 0、最多 5 分钟；只轮询中心已保存事实，在任务结束、进入待核实或版本变化时返回。到期返回 `waiting:true`、`timed_out:true` 和最后读到的任务（尚未读到时为 null），退出码为 0；Ctrl-C 或传输错误返回非零，不取消任务。其他成功命令输出 JSON、退出码为 0，业务拒绝输出结构化错误、退出码非零。

`result submit` 和其他真实 Agent 适配尚未实现。子结果交付使用迁移 `0011`，无新增依赖；Pi 已接入下面的账本和继续输入边界，并通过本地原生历史确认交付，真实模型行为仍需运行显式开启的验证入口。

### 子结果交付与父子取消

batond 在心跳补报周期领取中心已保存的子结果，先写入来源 Worker 的 SQLite 交付账本。`pending` 表示尚未写入来源账本，`available` 表示已保存、等待当前工具查询或明确等待子结果的 Agent；来源停止时为 `source_stopped`，结果仍可查询。通知不会重发原始任务说明或启动新的 Agent。当前工具调用 `task result` 可消费结果，不额外注入一次自动输入；只有存活且明确等待子结果时才串行继续原任务。

自动输入前同步提交 `delivery_intent` 并推进来源的 `input_generation`，历史确认后才记为 `delivered`。意图后崩溃时显示 `uncertain`（交付待核实），不自动再次注入。交付状态与子任务的 `status`、摘要和证据独立；子任务已完成不会因交付不确定变为执行失败。当前代次的完成候选必须有效、Agent 已停止自动工作，且所有子委托已结束并处理交付，父任务才能完成；后续子结果使旧候选失效。

取消父任务会递归保存各子任务的取消请求和各自的中止命令，包括已结束中间任务下仍未结束的后代。未启动者可直接取消；已运行者等待自己的停止回执，不能用父任务已停止来证明子任务也已停止。`task cancel` 返回的 `children` 保留各自决定；离线或停止未确认的子任务仍为待核实。

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

## 节点注册与默认设备

`POST /node-enrollments` 需要登录会话、Origin 和 CSRF。正文是 `{}`。成功时返回 `enrollment_id`、`enrollment_token` 和 `expires_at`。凭据默认 10 分钟，只能成功注册一次。过期返回 `enrollment_expired`，再次使用返回 `enrollment_used`。

`POST /nodes/register` 不使用浏览器会话。员工身份只来自注册凭据；正文若包含 `employee_id` 会被拒绝，也不会核销凭据。请求不能在 URL 中放参数。正文至少包含：

```json
{"enrollment_token":"...","display_name":"Desk","system":"linux","capabilities":["start"]}
```

成功时中心保存归属、显示名、系统、角色、能力列表和注册序号，并返回只出示一次的连接凭据。连接凭据是绑定节点、员工、`credential_id`、签发方、受众和有效期的 JWT，默认 30 天。

注册和节点同步继续接受旧版 batond 的 `role` 字段，中心忽略该字段。注册响应的 `role` 固定返回 `pc`，供旧版 batond 校验身份；此兼容值不表示节点角色。新的 `batond register` 可以省略 `--role`，旧命令仍可使用。

员工还没有默认设备时，注册会按注册序号选择最早的、尚未吊销的节点并保存。之后新注册的节点不改变它。所有节点都可以成为默认设备。迁移 `0015_equal_nodes.sql` 为没有默认值的员工补选最早的有效节点，已有默认引用保持原值，包括指向已吊销节点的引用。

`PUT /me/default-device` 需要登录会话、Origin 和 CSRF；`PUT /me/default-pc` 保留为兼容别名：

```json
{"node_id":"..."}
```

可以改成本人的任一有效节点，包括离线节点。其他员工的节点返回 403，不说明该节点是否存在。成功响应里的 `default_device_node_id`、显示名、系统和注册序号是数据库里实际保存的值；`default_pc_node_id` 保留并返回相同 ID。

`GET /nodes` 和 `GET /nodes/{id}` 凭登录会话返回本人节点。响应包含在线状态、最后联系时间、状态更新时间、是否已同步、`executable` 和 `revocation_status`。尚未同步或已有吊销决定的节点 `executable` 为 false。`revocation_status` 为 `none`、`pending` 或 `effective`。只有本地禁止接入、关闭连接并保存应用事实后才是 `effective`；决定已保存但尚未完成这些步骤时是 `pending`。查询其他员工的节点或不存在的节点都返回 403，响应相同。非法节点标识返回 400。这两个读取接口不要求 CSRF。

`GET /nodes` 和吊销响应同时返回当前 `default_device` 及内容相同的 `default_pc`。Web 使用 `default_device` 和新设置接口。节点列表和详情不包含 `role`。节点被吊销后，这里仍返回原来的 `node_id`，并把 `invalid` 和 `needs_reselection` 设为 true，提示需要重新选择。系统不会自动改选其他节点。

列表和吊销响应都包含 `local_process_notice`：吊销连接凭据不会停止离线节点上的本地进程。重新接入需要新的连接凭据。

## 凭据吊销

`POST /nodes/{id}/revoke` 需要登录会话、Origin 和 CSRF。正文是 `{}`。请求不能在 URL 中放参数。只能吊销自己的节点；其他员工的节点和不存在的节点都返回 403，响应相同，不说明该节点是否存在。

成功时中心先把吊销决定写入数据库，记录操作者、时间和关联的节点与 `credential_id`。从这时起，该节点不能再同步，也不能被选为新的默认设备。历史节点和凭据记录保留，不删除。

响应里的 `status` 表示处理状态。Coordinator 已禁止该凭据接入和业务分派、断开对应连接并保存已应用事实后为 `effective`，同时给出 `applied_at`。保存失败时为 `pending`，后台每 200ms 重试未完成的吊销，启动时也恢复这项处理。`pending` 表示尚未确认全部本地步骤，数据库中的吊销决定始终参与认证与业务授权。

Gateway 复核认证到登记之间的吊销，并在排队消息进入业务处理前再次检查凭据和连接代次。旧连接的断开或迟到结果不更新新连接；已吊销节点的未授权任务继续受排队期限约束。`batond` 收到确定的凭据失效后退出并说明需要重新认证；数据库短暂故障、容量耗尽和中心关闭通过断线触发原客户端的退避重连。

## 任务接受

`POST /tasks` 需要登录会话、Origin 和 CSRF。员工身份来自会话。正文里如果出现 `employee_id`，请求会因未知字段被拒绝，不会创建任务。

调用方自己生成 `request_id`，同一次提交的重试保持不变。`description` 必填，最多 32768 个字符，可以包含换行、回车和制表符；其他控制字符会被拒绝。`authorization_scope` 和 `expected_outputs` 同样。`request_id` 和 `working_directory` 仍是单行。`target_node_id` 可以省略，省略时使用当前默认设备；没有可用的默认设备时拒绝，不会改派到别的节点。显式指定时可以使用本人尚未吊销的节点。节点离线也可以接受，状态是 `queued`。

`agent_type` 可以省略。指定了目标 Session 时沿用该 Session 的 Agent；否则使用目标节点上的 `default_agent_type`。这个值只是节点表里的可空列，当前没有修改它的接口；列为空且没有目标 Session 时拒绝。节点最后上报的能力里没有这个 Agent 时拒绝，不会创建任务。

`queue_timeout_seconds` 省略时是 600 秒，从接受时起算，响应里给出 `queue_expires_at`。`execution_timeout_seconds` 省略时是 7200 秒，响应里给出这个秒数。省略和写成同一个数字不是同一份内容。`device_names` 省略和空列表也不是同一份内容；列表非空时必须给出 `authorization_scope`。

`source_session_id` 和 `target_session_id` 可以省略。填写时必须是当前员工已经拥有的 Session；其他员工的 Session 返回 `forbidden`，不存在的 Session 返回 `invalid_target`。目标 Session 还必须位于本次解析出的节点上，并且处于可以接收的状态。`running`、`waiting_input`，或已经绑定了执行的 Session，返回 409，`code` 是 `session_busy`。显式 `agent_type` 与 Session 已有 Agent 不一致时返回 `unsupported`。省略 `agent_type` 时沿用该 Session 的 Agent，不再使用节点默认 Agent。两个 Session 字段都省略时可以接受，目标 Session 由节点在准备时创建。

中心先按员工和 `request_id` 查找已经提交的请求。内容相同就返回原来的任务，不再解析默认设备或默认 Agent。内容不同返回 409，`code` 是 `conflict`，并带上已有的 `task_id`。新请求在同一个数据库事务里保存任务、解析结果、execution、初始事件、任务关系、`dispatch_outbox` 和去重墓碑。指定了已有目标 Session 时，同一个事务会占用它。事务提交成功后才返回 200。提交失败时响应不是接受记录，库里也没有这次投递意图。

成功记录包含 `task_id`、`request_id`、`target_node_id`、`agent_type`、`status`、`queue_expires_at`、`execution_timeout_seconds` 和 `version`。新接受和幂等重试都返回 200。错误响应里的 `request_id` 是这一次 HTTP 调用的编号，与正文里的 `request_id` 不是同一个值。

字段不合法返回 `invalid_request`，`details.fields` 指出字段。其他员工的节点或任务返回 `forbidden`。找不到或已失效的目标返回 `invalid_target`。已知能力不匹配返回 `unsupported`。

`GET /tasks` 返回本人最近 100 条任务。`GET /tasks/{id}` 和 `GET /tasks/{id}/events` 只返回本人的记录和变更，不返回 Session 原文。其他员工的任务和不存在的任务都返回 403，响应相同。非法任务标识返回 400。这三个读取接口不要求 CSRF。

`dispatch_outbox` 保存 `prepare` 投递意图。Coordinator 在节点在线且已同步时按租约领取，经 Gateway 投递，并用同一条消息 ID 重发。从未交给 Gateway 的过期消息记为 `queue_timeout`。已经交给 Gateway 但还没有确定结果的消息，过期后仍按租约重发，直到节点返回已准备的原映射或 `queue_timeout`。接受响应里的 `target_session_id` 在准备完成前可能是 null。准备成功后任务仍是 `queued`，`GET /tasks/{id}` 能看到节点返回的 Session。

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

中心把单任务中止请求持久保存在 `execution_stops`。节点在心跳和补发输入前通过 `execution.control` 领取，离线请求不会被丢弃。Worker 在 Session 互斥区先落盘中止标记再调用适配器的中止接口；接口返回不等于确认停止。Pi 先 `clear_queue` 再 `abort`，活动回合必须等到 `agent_settled`，等待超时后仍继续观察并在真实 settled 时幂等补报。Pi 1.3.0 的中止等当前工具结束后生效，不能中断运行中的工具。只有未发送输入、或确认停止且操作结果可说明时才变成 `cancelled`；停止或副作用仍未知就保留 `needs_verification` 和执行绑定。Pi 一旦执行过工具，中止不声称外部副作用已知；停止不会回滚外部副作用，也不保证任意后台子进程退出。

排队到期时，包含未准备任务在内，能确认未启动的任务失败，原因是 `queue_timeout`，此后不能再授权。已授权而没有未启动证据的任务先待核实，Worker 的未启动回执再收敛为超时失败；期限前已发送输入的事实优先于延迟的排队超时请求，不会中断已执行任务。节点被吊销时仍按原规则处理：还没授权就失败，原因是 `revoked`；已经授权就进入待核实。

执行期限通过签名许可传给 Worker，从本地 `start_intent` 起用包含休眠的单调时钟计时，墙钟跳变不会增加预算，节点离线也会中止。中心首次收到启动事实时以剩余执行预算估算 `execution_expires_at` 并扫描；传输延迟可能使中心扫描略晚，本地计时不依赖中心。超时先中止、待核实，只有停止且结果已知才按 `execution_timeout` 失败。中心输入读取与 Worker 提交均检查取消/期限，不会补发已取消或已超期输入。实际输入发送的原定时间、发送时间和单调 `delay_ms` 存在本地 `execution_log` 的 `input_dispatch` 条目及同名日志中，不只记录重试尝试。

## 人工核实与显式重做

员工可通过 `POST /api/v1/tasks/{id}/resolve` 核实本人待核实或已结束的任务；排队、运行中的任务先查询或请求取消。接口沿用登录、Origin 与 CSRF 校验，不启动 Agent、不重发输入，也不宣称节点进程已经停止。

```json
{
  "expected_version": 5,
  "status": "completed",
  "summary": "现场核对后确认已完成",
  "reason": "已检查设备状态及执行记录",
  "evidence": [{"storage_ref": "inspection", "resource_id": "check-42", "access_status": "available"}]
}
```

结论只接受 `completed`、`failed`、`cancelled`。证据为空时提供 `evidence_empty_reason`。任务版本、结论、摘要与人工证据在同一事务保存；原状态、摘要、错误、证据、取消事实保存在 `resolved` 事件的 `resolution.previous`，同时记录理由、操作者与时间。原产物引用和节点停止事实不变。迟到报告仍按同一执行补充事实，不覆盖人工终态。通过任务查询及 `/events` 读取当前记录和审计。

`POST /api/v1/tasks/{id}/rerun` 才会创建新的任务和执行：

```json
{"request_id":"redo-42","expected_version":6,"reason":"明确要求重新执行","confirm_side_effects":true}
```

原任务仍为 `needs_verification` 时必须明确确认重复副作用风险；未确认返回 `409 conflict`。重做沿用原任务的目标节点、Agent、描述、授权和期限长度（排队期限重新起算），不自动改派，不复用原 Session、execution 或委托来源；新任务的 `rerun_of_task_id` 关联原任务。原任务只增加版本及 `rerun_requested` 审计。相同员工、相同 `request_id` 与请求内容返回同一新任务，内容变化返回冲突。并发核实或重做使用 `expected_version`，版本不符时返回 `409 conflict`、`current_version` 与 `current_status`，须先查询最新事实。核实的网络重试也遵守版本检查，不会重新执行。此处仅提供 API，Web 核实界面不在本次实现内。

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

这次请求经 Gateway 发给节点并等待同一次响应。它不写入 `dispatch_outbox`，失败后也不会自动重发。节点在实际打开目标时确认它仍在授权目录内；只检查路径字符串不算通过。

首版没有远程编辑，也没有完整文件下载。`POST`、`PUT` 和 `DELETE` 都不会修改节点上的文件。

## 必需产物引用

创建任务或 `baton delegate` 的请求可以填写 `required_artifacts`，最多 32 项；字段缺省时沿用不依赖文件的任务流程。例如：

```json
{
  "request_id": "flash-build-42",
  "description": "使用已交付的固件执行测试",
  "target_node_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "required_artifacts": [
    {"node_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "root_id": "build", "path": "firmware.bin"}
  ]
}
```

`node_id` 表示文件实际所属的节点，不是传输目标；`root_id` 必须先通过目标节点本机的 `batond files add` 登记，`path` 是根内资源路径（最多 200 字符）。引用纳入请求幂等摘要和 256 KiB 输入大小限制。节点在首次 prepare 绑定 Worker 前、Worker 提交执行器输入前各核对一次，复用文件浏览的授权目录、`os.Root` 和实际打开边界；只接受可读的普通文件，不读取正文。检查不等同于传输、锁定文件或保证执行器之后读取时内容不变。

不存在、无权限、未授权目录、越界/符号链接或只属于另一节点的引用都会使任务以 `artifact_unavailable` 失败，不向执行器提交依赖输入。错误消息包含首个引用索引及 `not_found`、`unavailable`、`root_forbidden`、`path_escaped`、`unsupported_type` 或 `other_node` 原因。prepare 后文件变化导致的失败还会上报每个引用的 `access_status` 和原因；prepare 重发仍返回原执行映射，不创建新执行。

引用只携带定位信息。另一节点有同名文件也不能把原节点的本地路径当作已交付；必须先使用已有通道交付，再引用目标节点的授权目录。大文件不经 Gateway，不新增下载接口、任意 URL 代理或制品服务；真实跨机器通道与传输规模留给 T33 验证。

## Web UI

员工页面在 `web/`。Coordinator 用 `go:embed` 提供 `internal/webui/dist` 里的构建结果，不另起 Node.js 服务，页面也不从第三方 CDN 加载脚本或样式。仓库保留这次构建结果，所以没有 pnpm 时 `go build ./...` 和 `go test ./...` 仍能编译。页面改动后需要重新构建，再编译 Coordinator，二进制里才是新页面。

浏览器只使用 `Secure`、`HttpOnly` 的会话 Cookie。登录响应里的 CSRF 令牌放在内存和当前标签页的 sessionStorage，用来设置 `X-CSRF-Token`。它不是会话凭据。注册凭据和节点连接凭据不写入 localStorage、sessionStorage、URL 或日志。

Session 页面按节点显示最近 100 个 Session，本机父 Session 和跨节点委托分别列出。节点离线时显示状态未知，并保留最后报告时间。可以在页面选择节点、Agent 和工作目录提交任务，任务接受后显示稳定任务 ID；节点实际准备成功后才出现 Session。

`GET /api/v1/events` 是同源 WebSocket，不接受 URL 凭据或查询参数。登录 Cookie 在升级时和连接期间校验，连接上限为每个中心进程 128 个。客户端发送 `{"session_id":"<UUID>","cursor":"<可选游标>"}` 选择一个本人 Session；空 ID 取消输出订阅。服务端发送 `ready`、`session.changed`、`task.changed` 和 `session.output`。变化通知只提醒刷新本人列表；输出事件包含 `session_id`、`ok`、`code`、`state`、`input_supported`、`text`、`cursor` 和 `gap`。每页最多 16 KiB，节点最近缓存 256 KiB，页面最近缓存 128 KiB；旧游标、Worker 重启、缓存超限与连接中断都能显示缺口。页面把输出作为文本渲染，不执行 HTML、链接或终端控制序列。

`POST /api/v1/sessions/{id}/input` 的正文为 `{"operation_id":"<UUID>","text":"补充当前任务"}`，需要 Origin 和 CSRF，正文最多 16 KiB。成功回执表示节点确认接收；失败时读取 `code`，不把超时当成未提交。`GET /api/v1/sessions/{id}/input?operation_id=<UUID>` 只查询原操作；`delivered` 表示确认接收，`uncertain` 表示需要核实，`not_received` 表示尚无该操作记录，均不自动重发输入。原操作标识按员工保留在标签页存储中，切页或刷新后仍可查询。

`POST /api/v1/sessions/{id}/resume` 接受 `{"operation_id":"<UUID>"}`，只连接或恢复已存在的原生历史。原结果尚未确认时返回 `result_pending`；结果已交付后将 Session 标记为空闲。此时通过启动表单选取该 Session，或用 `POST /api/v1/tasks` 的 `target_session_id` 提交新目标，会创建新任务和新执行，继续原生上下文，并重新申请执行许可。复用保持原工作目录，指定其他目录时拒绝。当前 Pi 提供执行中补充输入和结算后的显式恢复；它没有独立的等待员工输入事件。

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

`pnpm test:e2e` 会先构建页面，再用 Playwright 驱动本机 Chromium，对真实的 Coordinator、PostgreSQL 和 batond 覆盖登录、注册节点、修改默认设备、吊销从处理中到已生效，以及跨员工和无效会话被拒绝。运行前设置 `BATON_TEST_DATABASE_URL`。Session 用例另外覆盖真实 Worker 输出、恶意文本、断流和缓存边界；设置 `BATON_REAL_PI_BROWSER=1` 可使用本机已授权的 Pi 登录验证模型、补充输入、Worker 退出后的恢复和同一 Session 的第二个任务，可用 `BATON_PI_MODEL` 显式选择模型。

## 测试

集成测试读取 `BATON_TEST_DATABASE_URL`，只连接这个 PostgreSQL，并在其中创建临时 schema。未设置该变量或连接失败时，测试失败，不会改用模拟数据库。

### CI 与本地等价命令

[GitHub Actions CI](https://github.com/hhubb22/baton/actions/workflows/ci.yml) 在每个 pull request 和推送 `main` 时判断改动范围。PR 验证合并结果，main push 验证实际提交；两者均保留全部平台与 race 覆盖。同一 PR 的新提交取消旧运行，手动诊断与 PR 分开管理。平台或分组失败不会取消其他分组。测试使用 `-json -count=1`，保存逐用例结果，禁用测试结果缓存。

纯说明改动限于 `README.md`、根目录 `AGENTS.md`、`.agents/PROJECT.md`，以及 `specs/`、`.agents/` 下的 Markdown。工作流始终创建 Linux、macOS、Windows、Web 汇总检查；说明改动只有在范围判断成功、重检查按规则跳过时通过汇总。空差异、未知路径、代码、依赖、工作流和混合改动执行全部检查。`web/`、`internal/webui/dist/` 和迁移目录中的 Markdown 也执行全部检查。

| 检查 | 覆盖范围 |
|---|---|
| Linux（`ubuntu-latest`） | 原生构建、Windows/macOS 交叉编译、vet、完整测试；独立 runner 并行运行 agent、session、node、store、gateway、control 的 race |
| macOS（`macos-latest`） | 原生构建、vet、完整测试、10 轮 Pi 无模型沙箱回归 |
| Windows（`windows-latest`） | 原生构建、vet、完整测试，支持按包和用例重复诊断 |
| Web（`ubuntu-latest`） | 锁定依赖安装、lint、typecheck、单元测试、Chromium E2E、嵌入产物一致性 |

Go 测试入口 `.github/ci/run_tests.py` 将 gateway 测试按三组并行执行，同时执行其余包；race 使用相同分组方式。每轮从 Go 的原生测试清单分组，检查并集完整且无重复，保存 `coverage.json`，再核对每组实际完成的顶层用例。初始权重来自 main 运行 `39147750715` 的 Windows 用例耗时，新用例使用默认权重。子进程共用本轮预先构建的只读程序，各测试使用独立临时目录和临时 schema；各 gateway 分组使用互不重叠的监听候选端口区间，先核对其低于系统动态出站端口起点，再探测并选择空闲端口，同一测试进程内不重复分配。停库测试也使用该分组区间。普通本地测试未指定 `BATON_TEST_BIN_DIR` 时，在独立临时目录构建并在测试进程结束后删除程序。

Linux、race 和 Web 各有独立 PostgreSQL 17 service container。Linux 与 race 安装主机 PostgreSQL 17 工具供独立停库测试使用；macOS 使用 `ikalnytskyi/action-setup-postgres@v8`。Windows 缓存 EDB PostgreSQL **17.6-1** 的 `bin/lib/share`，下载时校验固定 SHA256，命中时仍校验程序和实际服务器版本；每轮在缓存目录外新建数据目录并在结束时停库。缓存内不含测试数据库。`BATON_TEST_DATABASE_URL` 指向 runner 本机 `55432` 的一次性 `baton_test`，不读取仓库 Secret；Windows 仅允许回环 TCP 的临时信任认证。停库恢复测试另建临时集群，不停止共用测试库。Go 模块和构建缓存由 `setup-go` 管理；Linux 普通测试与 race 使用不同缓存键，每轮在摘要中记录命中状态。

Actions 手动运行 CI 时，可填 `diagnostic=./internal/gateway`、`test=^TestDatabaseStopReplaysLocalResultOnce$`、`count=20`。Windows 运行所选用例，其他平台保持完整验证。重复运行保留每次结果，任何一次失败或意外跳过都使诊断失败。门闩超时的历史根因仍待原生重复运行确认，通过次数不能证明根因已经修复。

每个 Go 测试任务上传七天有效的诊断材料：JSON 测试事件、失败摘要、完整分组清单、Coordinator/Gateway 日志、Worker 日志、进程状态及 TCP 连接状态。进程日志持续脱敏写入，Worker 日志定期采样，测试超时仍保留已有材料；清理前后的进程列表不含命令行和环境变量。不上传身份文件、令牌文件、数据库或原生历史。材料入口见任务摘要中的运行链接。受控失败使用 `test=^TestCIDiagnosticFailure$`、`count=1` 并勾选 `controlled_failure`，在实际 Worker 到达门闩后失败；该运行应保持失败，用于验证下载材料及脱敏。

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
go test -race -v -count=1 ./internal/agent/... ./internal/session ./internal/node ./internal/store ./internal/gateway ./internal/control
```

这里的 `-race` 覆盖测试包；进程测试内部通过普通 `go build` 启动的子进程不自动带 race instrumentation。需要同时检查子进程时可另跑 `GOFLAGS=-race go test -race -count=1 ./internal/gateway`。

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

登录、退出、身份查询、CSRF 和 Origin 的通过路径使用本地 TLS 服务，并把测试证书放进客户端信任池。明文 HTTP 测试确认响应仍带 `Secure` Cookie：按正式 Cookie 规则、不把环回地址当作安全来源的客户端不会在明文请求里带回它。CSRF 和 Origin 检查在两条路径上都生效。节点注册的通过路径同样使用该 TLS 服务；`batond register` 通过 `BATON_TLS_CA_FILE` 信任测试证书。节点连接测试使用真实的 Coordinator、Gateway 和 batond 进程，以及 TLS WebSocket，并注入断线、Coordinator 重启和 Gateway 重启。准备测试另外启动真实的 Session Worker 和本地 SQLite，覆盖重复投递、batond 重启后连回原 Worker、同一 Session 的并发写入，以及本地持久化失败。启动许可测试覆盖中心事务和节点校验，并注入延迟、取消、吊销、墙上时钟跳变和暂停后唤醒。测试进程可以设置 `BATON_TEST_DROP_PREPARE_ACKS`、`BATON_TEST_FAIL_PERSIST`、`BATON_TEST_EXECUTOR_LOG`、`BATON_TEST_EXECUTOR_SCRIPT`、`BATON_TEST_SLOW_WRITE`、`BATON_TEST_ABORT_SCRIPT`（`unconfirmed`/`unknown`/默认确认）、`BATON_TEST_INPUT_GATE`、`BATON_TEST_HOLD_START`、`BATON_TEST_START_DELAY`、`BATON_TEST_START_GATE`、`BATON_TEST_RESULT_GATE`、`BATON_TEST_DUPLICATE_REPORT`、`BATON_TEST_WALL_OFFSET`、`BATON_TEST_SUSPEND_AFTER_ARM` 和 `BATON_TEST_PERMIT_FILE`。未设置时这些变量没有作用，它们不是操作者配置。


### 历史分页验证

Session 页面提供节点原生历史分页和断流补取。历史页只经临时 Gateway 通道返回，中心不保存原文。`GET /api/v1/sessions/{id}/history` 支持 `cursor` 和 `limit`（1～16），具体字段与失败语义见 `specs/baton/TECH.md` 的 PS-127 段落。

`web/e2e/history.spec.ts` 使用独立数据库 schema、Coordinator、节点和 Worker 验证分页、断流、文件删除、离线及中心隐私。设置 `BATON_REAL_PI_BROWSER=1` 后使用真实 Pi；未设置时使用实际子进程协议执行器，不能据此声称模型任务通过。

当前 Codex 0.163.0 的原生文件探针使用临时 HOME，不读账号凭据、不发模型输入；创建原生历史后追加大历史样本，验证退出后读取、分页与删除：

```sh
BATON_CODEX_HISTORY_PROBE=1 BATON_CODEX_BINARY=/path/to/codex-0.163.0 go test -v -count=1 ./internal/agent/codex -run '^TestCodexHistoryNoModelProbe$'
```
