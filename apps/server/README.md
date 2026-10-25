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

Cursor 设备运行进程需显式配置 `CURSOR_API_KEY`，能力探测成功并上报 `available` 后才允许创建 Thread。Pi、Codex 使用设备上原生 CLI 的认证配置，分别通过 `PI_CODING_AGENT_DIR`、`PI_CODING_AGENT_SESSION_DIR` 和 `CODEX_HOME` 指定目录。当前启用 macOS arm64 / SDK 1.0.35；其他组合保持 `unverified` 或报告具体不可用原因。凭据保留在设备端。设备接入、连接恢复及本地命令见 [batond 文档](../batond/README.md)。

网页支持 Cursor、Pi、Codex、Kiro 新建、排队消息、撤回、停止、恢复、归档和时间线，按节点能力报告准入；Kiro 开放 macOS arm64 / CLI 2.32.0，认证状态未知时由首次原生执行检查。Pi 与 Codex 还支持活动回合插入。命令的持久接收与实际完成分别报告；daemon 或中心重启后，存活 Worker 继续执行，重连时按原命令和报告身份恢复。模型在新建时选择，Thread 内固定。

Thread 历史是中心保存的输入和回复，所有 Agent 格式相同。上游明确回合失败时，中心保存 `end_reason: failed`，安全原因随 `turn.ended` 报告的 `content` 保存在时间线事件中。输入保持 sent；没有排队消息时 Thread 回到 idle，有排队消息时继续 running 并执行下一条，沿用 `queue_empty` 规则。网页在对应回合显示 `<Agent> could not finish this reply` 和原因，原生会话与进程保留。运行时请求无法应答、事件流断开、发送结果无法确认、host 崩溃或连接丢失仍按 unknown 处理。

网页时间线按事件游标分页读取这些记录，设备离线时仍可查看。在 Baton 之外继续同一原生会话产生的消息不会出现。Project 工具 `threads.read` 读取同一份输入和回复。`history.read` 与 `history.search` 读取 Project 主对话已经保存在中心的事件，不访问设备。

实时输出由 Worker 保留当前 Turn 最近 256 KiB，每次读取最多 16 KiB，游标为 `epoch:字节偏移`。Turn 结束和切换时清空；淘汰、旧 epoch 或上游丢失输出时返回 `gap:true`。HTTP 输出查询和浏览器 WebSocket 复用设备临时 RPC，中心不持久化实时输出。

## Project 与设备管理

网页可创建、配置、暂停和归档 Project，发送主对话消息、处理事项、查看和编辑记忆及其历史版本。输入、对话事件、工具结果和记忆都保存在 PostgreSQL；Runtime 使用设备本地订阅，按需启动。默认设备符合在线、同步、订阅和名额条件时优先使用，否则选择同一员工的其他合格设备。没有可用设备时保留输入并显示等待原因。

中心按独立额度处理 Thread 命令和 Project 的 start、stop、wake，发送前持久保存重试时间。Project 租约为 60 秒，节点每 20 秒续租，58 秒未成功续租即停止 Runtime。暂停或停止 Project 作废租约；已创建的 Thread 按各自生命周期继续运行。事项处理携带版本与请求标识，记忆写入携带 `expected_revision`，冲突响应返回当前记录。

在线且已同步的设备支持目录增删、命令执行授权和订阅设备码登录；HTTP 在设备确认操作标识及保存值后才返回成功。目录、仓库、shell 与订阅状态通过能力报告刷新。文件预览仅返回授权根内的受限文本，符号链接越界、二进制内容和无效游标均被拒绝。

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
| Pi、Codex | 节点完成只读认证、版本与模型探测后上报；支持新建、排队、插入、停止、恢复。macOS arm64 的 Pi 1.0.0、Codex 0.156.1 通过上游转录回放，其余版本或系统组合为 `unverified`，新建返回 HTTP 422，`code:"agent_unavailable"` |
| Kiro | 节点在上游空会话发现之外运行 `kiro-cli --version`。macOS arm64 / CLI 精确版本 2.32.0 在程序已安装且认证未明确缺失时报告 `available`、`create: true`、`resume: true`，网页开放新建与恢复；认证 `unknown` 的 reason 提示首次执行由原生程序检查，明确 `missing` 拒绝。其他系统或版本（含预发布、构建后缀）、版本超时或不可解析为 `unverified`，缺程序为 `unavailable`；不满足准入条件的新建返回 HTTP 422、`code:"agent_unavailable"`。实际回合认证失败以失败结束并向时间线返回固定安全文案，输入保持 sent，Thread 可继续使用；不自动登录、不透传原始错误、不重发；离线验证不证明真实账号授权有效 |
| Cursor、Kiro steer                                     | HTTP 422，`code:"steer_unsupported"`；同时传模型时为 `model_with_steer`                              |
| Cursor、Pi、Codex、Kiro 轮间模型切换                              | HTTP 422，`code:"model_switch_unsupported"`                                                          |
| Thread 历史                                      | 时间线返回中心保存的输入和回复，设备离线时仍可分页读取。`/threads/{id}/history` 在权限检查后返回 HTTP 200 的 `SessionResult`，`ok:false`、`code:"history_unavailable"`，不向设备发送 `native_history` |
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
