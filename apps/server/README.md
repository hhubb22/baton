# TypeScript 开发中心

`@baton/server` 提供员工登录、设备管理、Cursor / Pi / Codex / Kiro 远程 Thread、Project 调度、主对话和记忆，以及持久命令、回复时间线和实时输出。它与 [`apps/batond`](../batond/README.md) 的出站 WSS 节点连接配合，网页静态目录由中心构建脚本生成并由中心提供。

中心的 Project 实现位于 `src/project/`。`runtimeRequest` 接收节点 Runtime 请求，在一个事务内检查租约、执行工具、保存结果事件并消费对应输入；工具执行与输入消费由该入口内部处理。工具重试返回已保存的结果，失效租约会回滚本次副作用，等待 shell 工具的 pending 查询使用独立只读事务。

## 构建与配置

中心构建生成 bundle、相邻的网页和 SQL 迁移，输出布局见 [工具说明](../../tools/README.md#本地开发)。环境要求、账号、HTTPS、设备接入和通用配置见 [根文档](../../README.md)。

`node server.cjs --version` 无需数据库配置即可输出构建版本、提交、平台、协议与格式版本；默认身份为 `development`。公开只读的 `GET /api/v1/release` 返回相同发布元数据，无需登录，不访问或续期设备凭据；已登录诊断的 `release` 字段与其一致。构建参数见工具说明，节点身份验证后、登记连接和同步前按支持清单及协议版本核对；不兼容返回 `node_version_incompatible` 并关闭连接，不改写业务、outbox 或设备凭据。development 联调允许版本号不同，协议仍须一致。

数据库迁移按文件版本记录，在事务 advisory lock 内串行执行；`serve`、`migrate` 和账号管理都会先执行并核对迁移。时间配置接受整数加 `ms`、`s`、`m`、`h`。

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

## 设备接入与远程 Thread

账号、证书与注册步骤见 [根文档](../../README.md#中心服务与员工账号)。

Cursor 设备运行进程需显式配置 `CURSOR_API_KEY`，能力探测成功并上报 `available` 后才允许创建 Thread。Pi、Codex 使用设备上原生 CLI 的认证配置，分别通过 `PI_CODING_AGENT_DIR`、`PI_CODING_AGENT_SESSION_DIR` 和 `CODEX_HOME` 指定目录。四个 Agent 在程序或 SDK 已安装且认证为 valid 或 unknown 时报告 `available`；系统和版本不设白名单。缺程序、明确缺少认证或已确认的运行依赖缺失时报告 `unavailable`，整次探测未能确认安装时报告 `unverified`。版本、系统和认证未知保留在 reason 中。凭据保留在设备端。设备接入、连接恢复及本地命令见 [batond 文档](../batond/README.md)。

网页支持 Cursor、Pi、Codex、Kiro 新建、排队消息、撤回、停止、恢复、归档和时间线，按节点能力报告准入；四个 Agent 的认证状态未知时均由首次原生执行检查，版本和系统不限。Pi 与 Codex 还支持活动回合插入。命令的持久接收与实际完成分别报告；daemon 或中心重启后，存活 Worker 继续执行，重连时按原命令和报告身份恢复。模型在新建时选择；Pi、Codex、Cursor 支持在同一 Thread 为后续回合换模型，省略时沿用最近确认提交的选择；Kiro 保持创建时模型。设备历史缺失时，从未派发的输入撤回并保留原文，可能执行过的输入保留 unknown；设备确认停止后可带着历史 unknown 记录归档。在 Worker 创建前因 Agent 不可用或目录授权被明确拒绝、没有任何输入派发的 Thread，可通过网页或 `POST /api/v1/threads/{threadId}/resume` 重试打开；新命令保留原 Thread ID，原消息由用户再次发送。Worker 已接收 open 或原生创建结果不明时继续禁止重建。

Agent 的普通提问和 MCP 确认显示在 Thread 输入区上方，支持单选、多选、文本回答和关闭问题。`POST /api/v1/threads/{threadId}/answer` 接收 `request_id`、`decision: accept | cancel` 和可选 JSON 答案记录；请求与回答分别限制为 64 KiB。中心将问题及回答保存在 `thread_events`，通过持久 outbox 投递回答；设备离线时保留排队。`ThreadView.pending_questions` 返回当前回合的未回答问题，`question_answers` 返回最近十条回答的投递结果。员工归属、请求身份和活动回合均须匹配；停止、归档或回合结束后关闭问题。相同请求的相同回答幂等，不同回答冲突。网页显示等待发送、已送达、取消、失败或结果未知；无法确认回答结果时，原输入和答案均不自动重发。

Thread 的 HTTP 响应使用结构化 `stop_code` 区分用户停止、强制停止、执行中断、历史丢失、目录缺失和启动失败，`status_reason` 保留说明文字；恢复后清除停止代码。已发布 Thread 的代码通过新增迁移回填，无法识别的停止归为执行中断。Thread 历史是中心保存的输入和回复，所有 Agent 格式相同。上游明确回合失败时，中心保存 `end_reason: failed`，安全原因随 `turn.ended` 报告的 `content` 保存在时间线事件中。输入保持 sent；没有排队消息时 Thread 回到 idle，有排队消息时继续 running 并执行下一条，沿用 `queue_empty` 规则。网页在对应回合显示 `<Agent> could not finish this reply` 和原因，原生会话与进程保留。运行时请求无法应答、事件流断开、发送结果无法确认、host 崩溃或连接丢失仍按 unknown 处理。

网页时间线按事件游标分页读取这些记录，设备离线时仍可查看。在 Baton 之外继续同一原生会话产生的消息不会出现。`src/threads/` 拥有 Thread 的状态、回合和持久消息读取；`view`、`readTurns` 与 `trace` 接受 `{ employeeId, projectId? }`，指定 Project 时同时校验员工与 Project 归属。Project 工具 `threads.read` 读取同一份输入和回复，每个 Turn 的 `item_count` 为过程项数量，`token_usage` 保留上游用量 JSON。`history.read` 按序号读取 Project 主对话已经保存在中心的事件；`history.search` 复用记忆来源词项索引，返回原序号、片段、来源字节范围及当前停用/纠正标识。两者均保留员工、Project 和已读序号边界，不访问设备。

`turn.item` 按连续 Worker 报告序号写入 `thread_turn_items`；同一员工、Thread、Turn 和 `item_id` 的冲突保留首个版本，重复报告返回原 ACK。过程项不进入 Project 输入队列或 `thread_events`，时间线的 `turn.ended.payload.item_count` 保存该轮数量。`data` 和 Turn 的 `token_usage` 使用 PostgreSQL `json`，读取不经过 `jsonb` 转换，保留原文中的 NUL、孤立代理项转义和嵌套 null；用量正文只保存在 Turn 中，不重复写入时间线。中心不对过程正文脱敏，也不将正文导出到追踪。

`GET /api/v1/threads/{threadId}/trace` 必填 `worker_turn_seq`，可选 `cursor`，从中心数据库读取过程项，设备离线时仍可访问。按 `(ordinal, worker_seq)` 排序，每页最多 50 项且整个业务 JSON 不超过 1 MiB。首次请求以 Thread 已提交的 `last_worker_seq` 固定 highwater，后续页仅包含不超过该序号的过程项；游标同时绑定员工、Thread、Turn、highwater 和页起点。每页返回 `page_cursor` 供原样重读，用 `next_cursor` 续页。后到的过程项在不带 cursor 的新快照中读取，包括 ordinal 小于已读位置的项。存在的 Turn 没有过程项时返回 `{ok:false,code:"trace_missing",steps:[],page_cursor}`，该空快照也可稳定重读；Turn 不存在返回 404。步骤包含上游 `data`、截断信息及可选 `full_output` 引用；引用的 `storage_generation` 必须与 Thread 绑定代次一致，全文通过现有设备完整输出接口读取。

Project 工具 `threads.trace` 使用相同查询，参数为 `thread_id`、`worker_turn_seq`、可选 `cursor`，并接受通用只读参数 `offset`、`max_bytes`。每个业务页先按 trace 上限生成，再包装为不超过 32 KiB 的 JSON 字节片段，外包装也返回 `page_cursor` 并计入容量预算。读取后续片段时，以外包装的 `page_cursor` 作为请求 `cursor`，配合 `next_offset` 拼完当前页；`offset > 0` 且没有 cursor 时拒绝为 422 `snapshot_cursor_required`。拼完后用页内 `next_cursor` 读取下一页，将 `offset` 归零。

浏览器通过 `/api/v1/events` 接收按员工隔离的刷新通知。`thread.changed` 携带 `thread_id`，`project.changed` 携带 `project_id`，两者的 `change: "detail"` 包含列表摘要和对应详情、消息、事件等变化。HTTP 写入、Project Runtime 工具和 Thread 回执、报告在成功保存后通知相关对象；Project 所属 Thread 的变化同时通知 Project。节点同步及断线使用携带 `node_id` 的 `nodes.changed`，设备能力报告继续使用带 `report_version` 的 `devices.changed`。Gateway 按事件类型和对象 ID 合并待发通知，保留不同对象的提示。浏览器收到旧格式或范围无法判断的通知时退回全量刷新。

桌面通知复用 `BrowserEvent` 的 `notification` 事件，携带稳定的 `event_id`、员工内单调递增的十进制字符串 `cursor`、`kind`、对象 ID、标题和正文。问题、确认请求、回复结束、失败或异常停止，以及设备凭据吊销，在对应事实的同一事务中保存通知 intent；业务事务不获取通知游标锁，独立投递事务在提交后按员工分配游标，且不获取 Node 或 Project 锁；Project 后台记忆任务和员工主动停止不发通知。Gateway 在提交后发送，并按事件 ID 保留同一对象的不同通知。版本不兼容等本机连接拒绝由桌面客户端读取 batond 的持久状态处理。

已登录员工通过 `GET /api/v1/events/replay?after=<cursor>&limit=100` 按序补读通知，响应为 `{events,cursor,has_more}`，每页最多 100 条。省略 `after` 时先为当前已提交的 intent 分配游标，再返回空事件列表和当前游标，供首次启动建立起点，后台随后投递这些历史通知也不会使客户端重复消费；传入游标后返回严格晚于该游标的已提交事件。游标按员工和中心隔离，不能超过当前员工已保存的最大值。客户端在 WebSocket ready、重连和通知到达后串行补读，持久保存处理进度；已通知、被聚焦规则抑制和关闭通知时消费的事件都应推进游标，重新加载时不会重新弹出。

`GET /api/v1/activity` 读取员工全部设备的 Thread 与 Project 状态。`running_count` 是 running Thread 数；`waiting_count` 是存在当前未回答问题的非归档 Thread 数与有未读回复的非归档 Project 数之和，同一 Thread 只计一次。暂停的 Project 仍计入未读回复；故障状态不单独计数。`waiting_threads` 按最近活动排序，最多返回五个不同 Thread 的 ID、标题和可选 Project ID。

实时输出由 Worker 保留当前 Turn 最近 256 KiB，每次读取最多 16 KiB，游标为 `epoch:字节偏移`。Turn 结束和切换时清空；淘汰、旧 epoch 或上游丢失输出时返回 `gap:true`。HTTP 输出查询和浏览器 WebSocket 复用设备临时 RPC，中心不持久化实时输出。

## Project 与设备管理

网页可创建、配置、暂停和归档 Project，发送主对话消息、编辑、停用和显式恢复记忆，并按需查看来源与历史版本。设置关闭后保留未保存草稿，暂停和恢复独立于描述字段的保存。输入、对话事件、工具结果和记忆都保存在 PostgreSQL；主对话消息使用独立的 `reference` 字段保存引用，正文不拼接引用标签。旧队列与历史输入事件的有效引用后缀由中心读取时拆分，原始事件保持不变。Runtime 使用设备本地订阅，按需启动。默认设备符合在线、同步、provider 和配置名额条件时优先使用，否则选择同一员工的其他合格设备。已声明 provider 的认证状态为 unknown 时允许启动检查；明确未登录或凭据权限错误时显示对应原因。没有可用设备时保留输入并显示等待原因。

中心按独立额度处理 Thread 命令和 Project 的 start、stop、wake，发送前持久保存重试时间。Project 租约为 60 秒，节点每 20 秒续租，58 秒未成功续租即停止 Runtime。暂停或停止 Project 作废租约；已创建的 Thread 按各自生命周期继续运行。模型请求持续失败后依次退避 1、5、15 分钟，连续三次失败显示故障状态及原因，此后仍按 15 分钟间隔尝试。新用户消息或显式重试可提前继续，同一消息的重发不改变退避；保存模型回复后清除失败计数和故障状态。记忆写入携带 `expected_revision` 与 `operation_id`，冲突响应返回当前记录且网页保留草稿。员工 API、前台记忆工具和后台整理共享 `project/memory/` 的 `planChange` 与 `executeChange`：前者锁定状态并完成全部校验，后者同事务保存修订、证据、操作结果、抑制记录和检索投影，修订作者按调用方记为 user、agent 或 background。`memory.recall` 与 POST memory/recall 使用 PG 有界候选、Orama 3.1.18 排序、片段与来源引用，并按状态和事实时间过滤。`prepare_context` 保存核心要求、相关片段、`core_epoch`、期限，以及 Runtime 传入的记忆工具读取版本中仍为当前修订的部分；保存新 assistant 和首次提交工具时，只在核心代次、快照读到的条目版本或期限变化时拒绝，已登记 nodes.exec 继续原等待。摘要提交不再核对记忆快照。Project 可保存默认关闭的公开 memory_embedding 配置；中心登记 pending/ready 向量，核对配置/修订/文本哈希，在 pgvector `vector` 列上按余弦距离精确排序取前 20，再与词法候选做 RRF 融合。数据库须安装 pgvector 0.5 及以上版本，连接的 search_path 为 Baton schema 加 public。设备 SDK、密钥 CLI、查询向量、后台生成和设置 UI 已接通。来源正文使用授权字节分页；角色从原始队列/事件确定，员工编辑来源由程序记录。最终回复和 project_memory_jobs 在同一事务保存，整理按不可变来源和字节游标分页，read_sources 附带同批次其他来源与批次前最近一条回复作为只读上下文，lookup_items 附带未解除的停用和纠正断言；后台 attempt 复用 agent_runs 与 start/stop 投递，但使用独立 claim。空闲设备每次只运行一个后台任务，前台有工作时撤销后台，停止回执前保留占用。commit_chunk 按提案逐条校验并返回 outcomes，被拒提案记录错误码，其余提案和游标照常提交；未带 final 时修订冲突回滚整片，带 final 时冲突提案记为被拒。进度、回执和提交尝试的 attempt_id 同事务保存。finish 时本次尝试没有提交分片则按 1、5、15 分钟退避，同一分片连续三次内容失败后跳过并记录原因；永久停放的批次不阻塞后续批次。暂停保留工作，归档拒绝提交。等待、错误、退避与成本只记入后台诊断，失败不改变前台 failure_count。见 [长期记忆设计](../../specs/project-memory/TECH.md)。

在线且已同步的设备支持目录增删、命令执行授权和订阅设备码登录；HTTP 在设备确认操作标识及保存值后才返回成功。目录、仓库、shell 与订阅状态通过能力报告刷新。文件预览按偏移和版本每次读取最多 64 KiB，网页可继续读取，文件变化时要求重新打开。目录游标可以继续扫描全部条目；POSIX 文件名保留冒号和反斜杠，Windows 保留驱动器与 ADS 防护。符号链接越界、二进制内容和无效游标均被拒绝；祖先目录仅 ctime 变化时丢弃读取并完整重新授权，最多尝试 3 次。

`nodes.exec` 仅由已保存的 Project 工具调用创建单轮 shell Thread，本机开关默认关闭。执行前重新读取本机授权和开关；等待工具结果结束不会停止命令。命令退出后先保存完成证据，再报告输出；缺少可信证据时标记 unknown，保持原命令未重发。设备配置与登录命令见 [节点文档](../batond/README.md#设备目录与模型订阅)。

## HTTP 契约与追踪

`src/http/` 提供路由 handler、安全校验与静态文件服务，依赖 Gateway 的请求、通知、断线及诊断操作。`packages/protocol/src/http-api.ts` 使用 Effect `HttpApi` 定义登录、账号、设备、Thread、Project、记忆和诊断接口的路径、入参、响应与错误。服务端通过同一声明构建路由并验证请求和返回值。已登录且完成改密的员工可读取 `GET /api/v1/openapi.json`；文档由契约生成，写请求继续要求允许的 Origin 和会话 CSRF token。

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
| Project、记忆及历史版本 | 提供 Project 创建与配置、主对话、运行状态和版本冲突响应 |
| 在线设备授权目录增删、Project 执行授权、订阅登录 | 等待设备保存确认，订阅凭据留在设备 |
| 文件和附件预览 | 授权根内目录分页和受限文本预览；越界与二进制内容拒绝 |
| 受限 shell Thread | 仅供 Project `nodes.exec` 使用，要求目标设备本机已开启执行授权 |
| Pi、Codex | 节点完成只读认证、版本与模型探测后上报；支持新建、排队、插入、停止、恢复。程序已安装且认证为 valid 或 unknown 时为 `available`，版本未知或其他系统也开放；缺程序或明确未认证时为 `unavailable`，新建返回 HTTP 422，`code:"agent_unavailable"` |
| Kiro | 节点在上游空会话发现之外运行 `kiro-cli --version`。程序已安装且认证为 valid 或 unknown 时报告 `available`、`create: true`、`resume: true`，网页开放新建与恢复；认证 unknown 提示首次执行由原生程序检查，明确 missing 拒绝。系统、版本、版本超时或不可解析只记入 reason，缺程序为 `unavailable`；不满足准入条件的新建返回 HTTP 422、`code:"agent_unavailable"`。实际回合认证失败以失败结束并向时间线返回固定安全文案，输入保持 sent，Thread 可继续使用；不自动登录、不透传原始错误、不重发；离线验证不证明真实账号授权有效 |
| Cursor、Kiro steer                                     | HTTP 422，`code:"steer_unsupported"`；同时传模型时为 `model_with_steer`                              |
| 轮间模型切换 | Pi、Codex、Cursor 支持为后续回合选择模型，省略时沿用最近确认提交的选择；Kiro 固定创建时模型，返回 HTTP 422、`code:"model_switch_unsupported"`。Steer 同时指定模型返回 `model_with_steer` |
| Thread 历史                                      | 时间线返回中心保存的输入、回复和事件，设备离线时仍可分页读取；网页与 Project 工具 `threads.read` 使用同一份记录 |
| 过程 `/threads/{id}/trace`                       | 按 Turn 从中心分页读取过程项，最多 50 项／1 MiB；无记录返回 `trace_missing`，Turn 不存在返回 404，设备离线仍可读取 |
| 实时输出时设备离线或尚未同步                     | HTTP 200 的 `SessionResult`，`ok:false`，分别为 `node_offline` 或 `node_syncing`                     |

Kiro 的配置、原生恢复和生产探测限制见 [节点接入说明](../batond/src/agents/kiro/README.md)，后续 Agent 的范围见适配规格。开发 bundle 与 SEA 安装包的 Runtime 入口及附带依赖见 [发布设计](../../specs/release/TECH.md#打包与发布)。

## 验证

命令与测试数据库配置见 [AGENTS.md](../../AGENTS.md#常用构建与验证命令)。单元组不需要 PostgreSQL，集成组运行数据库测试。测试辅助模块位于 `src/testing/`，数据库创建、清理、连接重启和节点数据准备分别由 `withTestDatabase`、`openTestDatabase` 与 `seedNode` 提供。

`GET /api/v1/diagnostics` 返回当前员工的设备与浏览器连接数、收发字节数、控制队列占用、待完成 RPC 和 Thread 状态分布，不包含消息正文或凭据。断线状态写入失败后按原连接身份重试；未完成的凭据吊销由独立维护循环继续关闭连接并确认生效。

`@baton/e2e` 的远程集成测试使用本机 HTTP/WebSocket、独立 Worker 进程和确定性 replay Agent，覆盖账号、注册、远程消息、输出、停止、中心与 daemon 重启、输入不重发及设备吊销，不调用在线模型或外部 API。
