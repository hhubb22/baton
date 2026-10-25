# TypeScript 开发中心

`@baton/server` 提供员工登录、设备管理、Cursor / Pi / Codex / Kiro 远程 Thread、Project 调度、主对话、事项和记忆，以及持久命令、回复时间线和实时输出。它与 [`apps/batond`](../batond/README.md) 的出站 WSS 节点连接配合，网页静态目录由中心构建脚本生成并由中心提供。

Go 的 `cmd/baton-server`、`cmd/batond`、根构建脚本和 Docker 镜像仍是发布入口；TypeScript 开发入口独立构建，发布切换在迁移 T5 进行。TS 的当前能力范围见下表，完整迁移边界见 [迁移设计](../../specs/ts-migration/TECH.md)。

## 构建与网页

在仓库根目录使用 Node 26、pnpm 12：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @baton/server build
pnpm --filter @baton/batond build
```

中心构建先调用 Vite，将网页生成到 `apps/server/dist/web/`，再打包 `apps/server/dist/server.cjs`，并将数据库迁移复制到相邻的 `migrations/`。`build` 和 `dev` 都包含网页构建，默认即可提供网页。自定义 bundle 输出路径时，网页生成到该 bundle 旁的 `web/`。Web 的普通构建命令仍输出到 Go 使用的 `internal/webui/dist/`；若只需重建 TS 中心网页，可单独运行：

```sh
pnpm --dir web build --outDir ../apps/server/dist/web
```

`pnpm --filter @baton/server dev <命令>` 先构建再运行，也可以直接调用 `node apps/server/dist/server.cjs <命令>`。脚本入口和自定义输出路径见 [迁移工具](../../tools/ts-migration/README.md#本地开发)。

## 配置

| 环境变量                                    | 含义与默认值                                                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `BATON_DATABASE_URL`                        | 必填，指向本机 PostgreSQL 数据库                                                                                  |
| `BATON_DB_SCHEMA`                           | 默认 `public`；自定义 schema 需事先创建，名称只允许小写字母、数字和下划线，以字母开头，最长 63 字符               |
| `BATON_HTTP_ADDR`                           | 默认 `127.0.0.1:8080`，支持配置 HTTPS 服务的监听地址                                                              |
| `BATON_ALLOWED_ORIGINS`                     | `serve` 必填，以逗号分隔的完整 HTTPS Origin，含非默认端口，不带路径或末尾斜杠                                     |
| `BATON_NODE_SIGNING_KEY`                    | Ed25519 私钥文件，默认当前工作目录的 `node-signing.key`；不存在时创建，已有文件须通过类型、权限、所有者和密钥校验 |
| `BATON_TLS_CERT_FILE`、`BATON_TLS_KEY_FILE` | 同时配置时直接提供 HTTPS，最低 TLS 1.2；省略时监听 HTTP，由外层 HTTPS 反向代理接入                                |
| `BATON_WEB_DIR`                             | 网页静态目录，默认 bundle 旁的 `web/`                                                                             |
| `BATON_HEARTBEAT_INTERVAL`                  | 默认 `10s`，范围 100 ms 至 2 分钟，中心连接检查间隔                                                               |
| `BATON_OFFLINE_AFTER`                       | 默认 `30s`，范围 200 ms 至 10 分钟，设备离线期限，必须大于心跳间隔                                                |
| `BATON_SESSION_TTL`                         | 默认 `12h`，员工会话有效期，范围 5 分钟至 7 天                                                                    |
| `BATON_ENROLLMENT_TTL`                      | 默认 `10m`，一次性设备注册凭据有效期，范围 1 分钟至 24 小时                                                       |
| `BATON_NODE_CREDENTIAL_TTL`                 | 默认 `720h`（30 天），设备连接凭据有效期，范围 1 小时至 90 天                                                     |

时间配置接受整数加 `ms`、`s`、`m`、`h`，各项范围见上表；TTL 推荐使用整秒、分钟或小时。TS 开发建议使用独立的本地数据库或 schema，避免与 Go 运行实例共用开发状态。

控制操作共用 4 个数据库执行名额。等待名额与开始执行分别计时，排队不会消耗执行预算。每项操作可通过 `BATON_CONTROL_<操作>_QUEUE_TIMEOUT` 和 `BATON_CONTROL_<操作>_EXECUTION_TIMEOUT` 单独配置，例如 `BATON_CONTROL_REPORT_EXECUTION_TIMEOUT=30s`。排队默认均为 `2s`，可设为 100 ms 至 60 秒；执行可设为 100 ms 至 120 秒，默认如下：

| 操作 | 用途 | 默认执行预算 |
| ---- | ---- | ------------ |
| `AUTHENTICATE` | 设备凭据认证、连接登记（各自计时） | `5s` |
| `VALIDATE` | 临时 RPC 回复的连接身份复查 | `3s` |
| `HEARTBEAT` | 设备心跳保存 | `3s` |
| `DISCONNECT` | 设备断线保存 | `5s` |
| `SYNC` | 节点同步 | `10s` |
| `RUNTIME_REPORT` | 设备能力报告 | `10s` |
| `PROJECT_REQUEST` | Project Runtime 请求 | `15s` |
| `RECEIPT` | Thread 命令接收确认 | `10s` |
| `REPORT` | Thread 持久报告 | `15s` |
| `BROWSER` | 浏览器会话复查 | `3s` |
| `READ` | 实时输出与订阅的 Thread 归属读取 | `5s` |
| `DISPATCH` | Thread 与 Project 持久命令领取 | `10s` |
| `SCHEDULE` | Project 调度候选读取、单个 Project 放置（各自计时） | `10s` |
| `MAINTENANCE` | 凭据吊销补偿的数据库操作 | `5s` |

同步、能力报告、Thread 接收确认和报告遇到暂时不可用时，中心保留连接并等待节点按原身份重试；成功提交后才确认，报告继续按事件身份去重。持久命令仍按已保存的命令身份与重试时间派发。设备认证握手期限随认证的两次排队与执行预算计算，额外留 1 秒，默认 15 秒，配置上限为 361 秒。节点的 `--control-timeout-seconds` 默认 370 秒，认证从连接建立起计时，同步从认证成功起重新计时；中心的握手期限先到时由中心裁决。已认证连接收到格式、路由和消息种类合法的帧时立即更新传输活性，排队不计为失联；数据库 source 身份仍在处理业务与心跳时复查。

临时 RPC 按设备分为读取与管理两类，分别使用独立名额与 FIFO 队列。文件浏览、实时输出和完整输出补读使用读取名额；目录设置、执行授权和订阅登录使用管理名额。读取满额时，管理名额仍然可用。两类在途上限各为 1 至 23，总和不得超过 24；配置超限时中心拒绝启动，为节点的 32 个在途请求名额留下至少 8 个控制操作名额。

| 环境变量 | 含义与默认值 |
| -------- | ------------ |
| `BATON_RPC_READ_CONCURRENCY` | 每台设备读取在途上限，默认 `4`，范围 1 至 23 |
| `BATON_RPC_MANAGEMENT_CONCURRENCY` | 每台设备独立管理在途上限，默认 `2`，范围 1 至 23 |
| `BATON_RPC_MAX_QUEUED` | 每台设备、每类请求的等待上限，默认 `8`，范围 1 至 128 |
| `BATON_RPC_QUEUE_TIMEOUT` | 等待名额的期限，默认 `2s`，范围 100 ms 至 10 秒 |
| `BATON_RPC_READ_TIMEOUT` | 文件浏览与输出请求发送后的等待期限，默认 `12s` |
| `BATON_RPC_MANAGEMENT_TIMEOUT` | 目录设置与执行授权发送后的等待期限，默认 `5s` |
| `BATON_RPC_LOGIN_TIMEOUT` | 订阅登录请求发送后的等待期限，默认 `12s` |

RPC 发送后的期限可设为 100 ms 至 120 秒。队列满或排队超时返回 `node_busy`，过期请求不会发送；已发送请求超时返回 `node_timeout`，中心不自动重发管理操作。断线、连接替换和中心关闭会清除等待队列，旧回复仍须匹配连接、请求和操作身份才能被接受。

## 本地账号、迁移与启动

先在本机 PostgreSQL 中建立开发数据库。以下命令均在仓库根目录执行，连接串按本机配置填写：

```sh
export BATON_DATABASE_URL='postgres://postgres:baton@127.0.0.1:5432/baton_ts_dev?sslmode=disable'
pnpm --filter @baton/server dev migrate
pnpm --filter @baton/server dev admin employee create --username alice --display-name Alice
```

`create` 生成并向操作者输出一次性口令。首次登录后必须修改密码，再重新登录，才能注册设备或使用 Thread。已有账号可用以下命令重置为新的一次性口令：

```sh
pnpm --filter @baton/server dev admin employee reset-password --username alice
```

`migrate`、账号管理和 `serve` 都先执行并核对数据库迁移；`migrate` 完成后退出。服务端按文件版本记录迁移，并在事务锁内串行执行。

使用本机受信任证书直接启动 HTTPS：

```sh
export BATON_HTTP_ADDR='127.0.0.1:8443'
export BATON_ALLOWED_ORIGINS='https://localhost:8443'
export BATON_TLS_CERT_FILE='/绝对路径/localhost.crt'
export BATON_TLS_KEY_FILE='/绝对路径/localhost.key'
export BATON_NODE_SIGNING_KEY="$PWD/.baton-ts-dev/node-signing.key"
pnpm --filter @baton/server dev serve
```

浏览器访问 `https://localhost:8443`。证书需匹配访问主机名，浏览器需信任其签发 CA。使用反向代理时，将 `BATON_ALLOWED_ORIGINS` 设为浏览器实际访问的 HTTPS Origin，并代理普通 HTTP 请求、`/v1/node` 和 `/api/v1/events` 的 WebSocket 升级。

## 设备接入与远程 Thread

登录网页、完成首次改密后，在 Devices 中取得一次性注册凭据。在 Cursor 设备上把凭据保存到私有文件，POSIX 文件权限为 0600，然后运行：

```sh
pnpm --filter @baton/batond dev up \
  --coordinator https://localhost:8443 \
  --enrollment-file /绝对路径/enrollment-token \
  --workspace /绝对路径/工作目录 \
  --ca-file /绝对路径/local-ca.crt
```

注册也可从 `BATON_ENROLLMENT_TOKEN` 读取凭据；已有身份时 `up` 直接复用。`--workspace` 将真实绝对目录幂等登记到本机授权根，首次无配置时同时登记用户主目录。设备默认数据目录为 `~/.baton-ts`；重启和本地命令使用相同的 `--data-dir`。自建 CA 通过 `--ca-file` 供 HTTPS 注册和 WSS 连接使用，证书校验保持开启；使用系统已信任证书时可省略该选项。CA 文件路径不会写入身份，后续 `run` 仍需传入。

Cursor 设备运行进程需显式配置 `CURSOR_API_KEY`，能力探测成功并上报 `available` 后才允许创建 Thread。Pi、Codex 使用设备上原生 CLI 的认证配置，分别通过 `PI_CODING_AGENT_DIR`、`PI_CODING_AGENT_SESSION_DIR` 和 `CODEX_HOME` 指定目录。四个 Agent 在程序或 SDK 已安装且认证为 valid 或 unknown 时报告 `available`；系统和版本不设白名单。缺程序、明确缺少认证或已确认的运行依赖缺失时报告 `unavailable`，整次探测未能确认安装时报告 `unverified`。版本、系统和认证未知保留在 reason 中。凭据保留在设备端。设备接入、连接恢复及本地命令见 [batond 文档](../batond/README.md)。

网页支持 Cursor、Pi、Codex、Kiro 新建、排队消息、撤回、停止、恢复、归档和时间线，按节点能力报告准入；四个 Agent 的认证状态未知时均由首次原生执行检查，版本和系统不限。Pi 与 Codex 还支持活动回合插入。命令的持久接收与实际完成分别报告；daemon 或中心重启后，存活 Worker 继续执行，重连时按原命令和报告身份恢复。模型在新建时选择，Thread 内固定。

Thread 历史是中心保存的输入和回复，所有 Agent 格式相同。上游明确回合失败时，中心保存 `end_reason: failed`，安全原因随 `turn.ended` 报告的 `content` 保存在时间线事件中。输入保持 sent；没有排队消息时 Thread 回到 idle，有排队消息时继续 running 并执行下一条，沿用 `queue_empty` 规则。网页在对应回合显示 `<Agent> could not finish this reply` 和原因，原生会话与进程保留。运行时请求无法应答、事件流断开、发送结果无法确认、host 崩溃或连接丢失仍按 unknown 处理。

网页时间线按事件游标分页读取这些记录，设备离线时仍可查看。在 Baton 之外继续同一原生会话产生的消息不会出现。Project 工具 `threads.read` 读取同一份输入和回复。`history.read` 与 `history.search` 读取 Project 主对话已经保存在中心的事件，不访问设备。

实时输出由 Worker 保留当前 Turn 最近 256 KiB，每次读取最多 16 KiB，游标为 `epoch:字节偏移`。Turn 结束和切换时清空；淘汰、旧 epoch 或上游丢失输出时返回 `gap:true`。HTTP 输出查询和浏览器 WebSocket 复用设备临时 RPC，中心不持久化实时输出。

## Project 与设备管理

网页可创建、配置、暂停和归档 Project，发送主对话消息、处理事项、查看和编辑记忆及其历史版本。设置关闭后保留未保存草稿，暂停和恢复独立于描述字段的保存。输入、对话事件、工具结果和记忆都保存在 PostgreSQL；Runtime 使用设备本地订阅，按需启动。默认设备符合在线、同步、provider 和配置名额条件时优先使用，否则选择同一员工的其他合格设备。已声明 provider 的认证状态为 unknown 时允许启动检查；明确未登录或凭据权限错误时显示对应原因。没有可用设备时保留输入并显示等待原因。

中心按独立额度处理 Thread 命令和 Project 的 start、stop、wake，发送前持久保存重试时间。Project 租约为 60 秒，节点每 20 秒续租，58 秒未成功续租即停止 Runtime。暂停或停止 Project 作废租约；已创建的 Thread 按各自生命周期继续运行。模型请求持续失败后依次退避 1、5、15 分钟，连续三次失败显示系统提示，此后仍按 15 分钟间隔尝试。新用户消息或显式重试可提前继续，同一消息的重发不改变退避；保存模型回复后解决系统提示。事项处理携带版本与请求标识，记忆写入携带 `expected_revision`，冲突响应返回当前记录。

在线且已同步的设备支持目录增删、命令执行授权和订阅设备码登录；HTTP 在设备确认操作标识及保存值后才返回成功。目录、仓库、shell 与订阅状态通过能力报告刷新。文件预览按偏移和版本每次读取最多 64 KiB，网页可继续读取，文件变化时要求重新打开。目录游标可以继续扫描全部条目；POSIX 文件名保留冒号和反斜杠，Windows 保留驱动器与 ADS 防护。符号链接越界、二进制内容和无效游标均被拒绝；祖先目录仅 ctime 变化时丢弃读取并完整重新授权，最多尝试 3 次。

`nodes.exec` 仅由已保存的 Project 工具调用创建单轮 shell Thread，本机开关默认关闭。执行前重新读取本机授权和开关；等待工具结果结束不会停止命令。命令退出后先保存完成证据，再报告输出；缺少可信证据时标记 unknown，保持原命令未重发。设备配置与登录命令见 [节点文档](../batond/README.md#设备目录与模型订阅)。

## HTTP 契约与追踪

`packages/protocol/src/http-api.ts` 使用 Effect `HttpApi` 定义登录、账号、设备、Thread、Project、事项、记忆和诊断接口的路径、入参、响应与错误。服务端通过同一声明构建路由并验证请求和返回值。已登录且完成改密的员工可读取 `GET /api/v1/openapi.json`；文档由契约生成，写请求继续要求允许的 Origin 和会话 CSRF token。

中心、节点和 Worker 使用 Effect 原生 tracing，默认服务名分别为 `baton-server`、`batond`、`baton-worker`。设置 `OTEL_EXPORTER_OTLP_ENDPOINT` 后，通过 OTLP/HTTP JSON 导出到其 `/v1/traces`；也可用 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` 指定完整地址。未配置地址时不发起导出请求。`OTEL_TRACES_EXPORTER=none` 可显式关闭，`OTEL_RESOURCE_ATTRIBUTES` 可附加部署属性。

HTTP 接受标准 `traceparent` 和可选 `tracestate`。命令的追踪上下文独立保存在中心 outbox、节点账本及 Worker 命令和消息记录中，经 WSS 和认证 IPC 传递；重连、重复派发和 Worker 恢复继续关联持久来源。追踪元数据不参与业务内容摘要或幂等判断。数据库查询耗时、事务事件和连接等待随 Effect span 导出，查询文本、绑定参数、消息正文、凭据及原始错误详情不导出。

本地可用 Jaeger 查看追踪：

```sh
docker run --rm --name baton-tracing \
  -p 127.0.0.1:16686:16686 -p 127.0.0.1:4318:4318 \
  cr.jaegertracing.io/jaegertracing/jaeger:2.22.0
```

在中心和节点各自的终端设置 `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318` 后启动进程，浏览器访问 `http://127.0.0.1:16686`。独立 Worker 继承导出配置。每个进程最多同时执行两个导出请求，等待响应头与读取响应体都受超时约束，最长三秒。导出超时或达到并发上限时丢弃当前批次，由 exporter 暂停导出六十秒后恢复；业务执行结果保持原样，关闭等待同样有界。

## 当前能力范围

下列响应针对已登录、已完成改密且有权访问目标对象的请求；入参错误或越权会先被拒绝。

| 功能                                             | TS 当前响应                                                                                          |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Project、Inbox、记忆及历史版本 | 提供 Project 创建与配置、主对话、运行状态、事项处理和版本冲突响应 |
| 在线设备授权目录增删、Project 执行授权、订阅登录 | 等待设备保存确认，订阅凭据留在设备 |
| 文件和附件预览 | 授权根内目录分页和受限文本预览；越界与二进制内容拒绝 |
| 受限 shell Thread | 仅供 Project `nodes.exec` 使用，要求目标设备本机已开启执行授权 |
| Pi、Codex | 节点完成只读认证、版本与模型探测后上报；支持新建、排队、插入、停止、恢复。程序已安装且认证为 valid 或 unknown 时为 `available`，版本未知或其他系统也开放；缺程序或明确未认证时为 `unavailable`，新建返回 HTTP 422，`code:"agent_unavailable"` |
| Kiro | 节点在上游空会话发现之外运行 `kiro-cli --version`。程序已安装且认证为 valid 或 unknown 时报告 `available`、`create: true`、`resume: true`，网页开放新建与恢复；认证 unknown 提示首次执行由原生程序检查，明确 missing 拒绝。系统、版本、版本超时或不可解析只记入 reason，缺程序为 `unavailable`；不满足准入条件的新建返回 HTTP 422、`code:"agent_unavailable"`。实际回合认证失败以失败结束并向时间线返回固定安全文案，输入保持 sent，Thread 可继续使用；不自动登录、不透传原始错误、不重发；离线验证不证明真实账号授权有效 |
| Cursor、Kiro steer                                     | HTTP 422，`code:"steer_unsupported"`；同时传模型时为 `model_with_steer`                              |
| Cursor、Pi、Codex、Kiro 轮间模型切换 | HTTP 422，`code:"model_switch_unsupported"`。Pi、Codex、Cursor 上游支持，但 Worker 固定模型且 host 尚未传递逐消息模型；Kiro 上游不支持。缺少的实现写入节点 reason |
| Thread 历史                                      | 时间线返回中心保存的输入、回复和事件，设备离线时仍可分页读取；网页与 Project 工具 `threads.read` 使用同一份记录 |
| 过程 `/threads/{id}/trace`                       | 合法查询返回 HTTP 200，`{ok:false,code:"trace_missing",steps:[]}`                                    |
| 实时输出时设备离线或尚未同步                     | HTTP 200 的 `SessionResult`，`ok:false`，分别为 `node_offline` 或 `node_syncing`                     |

Kiro 的配置、原生恢复和生产探测限制见 [节点接入说明](../batond/src/agents/kiro/README.md)，后续 Agent 的范围见适配规格；完整安装包和发布切换属于 T5。Project Runtime 从当前源码仓库与已安装的依赖启动，开发 bundle 需要保留该仓库布局。Go 发布入口保留其已有功能。

## 验证

```sh
pnpm --filter @baton/server typecheck
pnpm --filter @baton/server lint
pnpm --filter @baton/server test
pnpm --filter @baton/server test:unit
pnpm --filter @baton/server test:integration
pnpm test:e2e
pnpm --filter @baton/server build
```

`test:unit` 运行无需 PostgreSQL 的包内测试；`test:integration` 运行 `*.integration.test.ts` 数据库测试；`test` 包含两组。跨 app 测试位于 [`e2e/`](../../e2e/README.md)，使用 `pnpm test:e2e` 运行。测试辅助模块位于 `src/testing/`，数据库创建、清理、连接重启和节点数据准备分别由 `withTestDatabase`、`openTestDatabase` 与 `seedNode` 提供。

工作区测试会重新构建 Project Runtime，与统一构建分开执行可避免争用同一产物目录；串行工作区验证使用 `pnpm test`。

`GET /api/v1/diagnostics` 返回当前员工的设备与浏览器连接数、收发字节数、控制队列占用、待完成 RPC 和 Thread 状态分布，不包含消息正文或凭据。断线状态写入失败后按原连接身份重试；未完成的凭据吊销由独立维护循环继续关闭连接并确认生效。

数据库测试使用本机 PostgreSQL，为每个夹具创建和清理独立 schema；默认连接 `postgres://postgres:baton@127.0.0.1:5432/baton_test?sslmode=disable`。未启动时尝试用 `pg_ctl` 拉起 `~/.baton-postgres`，也可用 `BATON_TEST_DATABASE_URL` 覆盖。`@baton/e2e` 的远程集成测试使用本机 HTTP/WebSocket、独立 Worker 进程和确定性 replay Agent，覆盖账号、注册、远程消息、输出、停止、中心与 daemon 重启、输入不重发及设备吊销，不调用在线模型或外部 API。
