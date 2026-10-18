# Baton 技术设计

Status: approved
Owner: 待指定
Date: 2026-10-17
Approved: 2026-10-17，用户在当前需求会话批准
Basis: 已批准的 [行为规格](PRODUCT.md)，R-01 至 R-39。

当前已实现授权前取消的迟到中止证据确认：同一执行尚未授权、任务已经 `cancelled` 时，身份匹配且取消原因、`not_started=true`、已停止、结果已知的 `stop_report` 作为补充证据持久化后 ACK，不覆盖终态、摘要或错误，也不补授权；同一事件幂等确认，其他未授权报告仍拒绝。Worker 因而能清空 outbox 待交付项，退出后不再因未交付回执被恢复。进程测试覆盖授权前取消、多次心跳与两次 batond 重启，检查执行器启动和输入均为 0、outbox 无待交付项；无新增迁移。

本设计已获批准，作为实施依据；外部系统事实与目标环境验证缺口保留。当前已实现并验证本地账号分配、登录、退出、本人查询、改密、一次性节点注册、初始默认 PC、batond 本地身份、Ed25519 签名的节点连接凭据、batond 经 TLS WebSocket 连接 Relay、断线重连、incarnation、节点元数据同步、心跳与本人节点在线状态查询、Coordinator 与 Relay 之间的认证控制连接、本人节点连接凭据吊销、任务接受、Session Worker 准备、员工 Web UI 的登录与节点页面，以及受限文件浏览。吊销决定先写入 PostgreSQL，并从保存起拒绝该节点的新业务操作；Relay 应用吊销、断开对应连接并回执后，API 和节点查询才显示已生效，未回执时显示处理中。Relay 不可达或重启后，吊销通过新的安全快照或补发继续拒绝同一凭据。默认 PC 指向被吊销节点时保留失效引用。任务接受在一个事务里保存任务、解析后的目标与 Agent、期限、execution 身份、初始事件、任务关系和 dispatch_outbox，并按员工与 request_id 幂等返回。Coordinator 按租约消费 prepare，经 Relay 以稳定消息 ID 重发；节点把 task_id 与 execution_id 的映射写入本地 SQLite 后才回 ACK，重复 prepare 返回同一执行和 Session。batond 为该执行绑定独立的 Session Worker，batond 重启后 Worker 继续存活并可以被重新连接。中心保存 sessions 与 task_relations，接受时校验 source_session_id 和 target_session_id 的归属。准备阶段不启动 Agent。中心事务同时锁定 tasks 与 executions 时统一先锁 tasks、再锁 executions；准备成功或失败落库、启动许可、执行报告、取消及到期处理均遵守此约定，不依赖 JOIN 执行计划决定行锁顺序，并由真实 PostgreSQL 锁等待与多轮并发测试覆盖。已准备的 Worker 向中心申请短时启动许可；中心在事务提交 start_authorized 之后才签名。节点核对受众、执行身份、存储代次和排队期限，并用包含休眠的单调时钟计算剩余预算，通过后才让测试执行器进入启动。Worker 先同步提交 start_intent，再只向测试执行器提交一次任务输入；重复命令不会产生第二次执行。执行器接受输入后，中心把任务标成执行中。结构化结果由 Worker 校验，任务、节点和 Session 关联由平台填写。摘要、证据引用和错误在中心事务提交之后才确认已交付，完整执行历史留在节点账本，不写入 task_events。进程退出或自由文本不会记成成功。按执行器输入的序列化大小超过 256 KiB 的任务在接受时拒绝；Worker 若仍收到超限输入，把该执行记为失败并回报。许可已经发出但没有未启动回执时，取消不会把任务标成未执行。节点默认 Agent 目前只有可空列，没有设置接口。员工 Web UI 由 Coordinator 嵌入并提供构建后的静态文件：员工可以登录、退出、在必须更换口令时完成改密，查看本人节点的能力、在线状态、最后报告时间、离线标记和是否已同步，领取只显示一次的注册凭据并看到 batond register 的用法，按响应中实际保存的值修改默认 PC，并在吊销后区分处理中与已生效。默认 PC 失效时页面要求重新选择。页面使用服务端会话 Cookie 和 CSRF 请求头，不保存长期 bearer 或节点凭据。员工可以在 Web UI 列出本人节点用 batond files 登记的授权目录，并查看单次最多 64 KiB 的文本预览；超限时带截断标志和剩余内容引用，不能按偏移继续读取，也不能远程编辑或借浏览接口取回完整大文件。浏览是临时节点 RPC，不进入 dispatch_outbox。节点使用 os.Root 在打开目标时确认实际路径仍在授权目录内。命名管道、设备文件和套接字在打开已得到的文件后再按类型拒绝，不读取内容。路径越界、符号链接逃逸、未授权 root_id、节点离线或已吊销都会拒绝。Linux 上验证了符号链接逃逸，以及打开期间把目录换成符号链接不会读到目录外内容。Windows 目录联接和 reparse point 尚未在本机验证。Agent 适配，以及其余目录、进程、表、接口和配置仍为实施约定。崩溃窗口核实已在本地进程上覆盖一部分：启动意图、输入意图与已确认输入之间的崩溃进入待核实且不重发输入；batond 重启会连回存活的 Worker；结果保存或中心确认丢失后按同一事件补报；数据库短时停机后不重复记账或执行。Relay 与 Coordinator 进程重启已在本地进程测试中覆盖，不会新开执行。容器编排还没有按验证矩阵跑过，因此 R-24～R-26 仍是部分完成。单任务取消与排队、执行超时已在计数执行器及真实 Worker 进程路径实现：中心持久保存请求，Worker 分别回报停止和操作结果；仅确认未发送输入，或确认停止且结果可说明时，才取消或按超时失败，否则保持待核实并保留执行绑定。Worker 在同一 Session 互斥区串行授权、输入和中止，按包含休眠的本地单调时钟执行期限，离线仍自行中止。中心首次收到启动事实时用总预算减去 Worker 已消耗单调时长估算执行期限；网络传输可能使中心扫描略晚，不影响本地期限。心跳补发前领取持久控制请求，输入读取端和 Worker 再拦截取消与到期，账本记录原定发送、实际发送及单调延迟。API 区分请求、Worker 回执、停止确认与结果已知；事件保留发生时间、接收时间及 Worker 序号，后到结论只补证据、不覆盖终态。已执行任务不再受排队期限约束，停止不承诺回滚外部副作用。父子委托级联取消和真实 Agent 中止适配仍未实现。实现与规格纳入 Git，验证记录保存在仓库外的过程区；初始化前的验收基线保留文件摘要与差异。

当前已实现账本持续读取失败的有界处理：`os.Stat` 权限错误与 SQLite 打开、IO、锁忙错误统一归为非损坏读取失败；每个 Session 连续 3 次心跳补报检查失败后，以稳定事件标识上报 `uncertain_history`，停止离线账本读取与 Worker 自动重建，未获中心确认时继续补报。计数使用节点账本已有的 `meta`，跨重启、重连保留；阈值前读成或成功连回原 Worker 后清零，原执行的有效证据仍可补回。已覆盖文件和目录权限故障、连续失败与恢复、ACK 失败补报及不新开执行的测试，无新增迁移。

启动前恢复筛选已实现：中心最终拒绝许可后，由对应执行的 Worker 保存 `start_refused`；未申请过许可或已有拒绝、取消事实且没有 `start_intent` 的 Session 在 Worker 退出且没有待交付回执时不再自动拉起。已记录许可申请且尚未被拒绝的 Session、待交付结果及中止回执和已启动事实仍优先按原流程恢复，不新开执行。身份不匹配的启动拒绝不污染当前 Session；拒绝事实写入失败时仍返回拒绝，由节点向中心报告未启动。Linux 进程测试覆盖中心拒绝在 Worker 退出前后到达、恢复筛选和写库失败后的拒绝回执；Windows、macOS 仅交叉编译，未验证目标系统进程行为。

当前已实现补充（PS-115 / T11）：新增 `baton delegate`、`task get/wait/result/relations/cancel`；`result submit` 尚未实现。batond 在 prepare ACK 前生成每次执行独立的受限上下文文件；CLI 经本地 IPC 使用不透明凭据，员工与节点取自 Relay 认证，来源任务、Session、Execution 由节点账本绑定并在中心复核。新委托继承来源授权，不能通过请求正文扩大授权或替换来源；查询和取消限当前来源任务及其直接委托。沿用稳定 request_id 的中心幂等和默认目标解析；离线目标不自动改派。有限等待只读取中心事实，默认 30 秒、上限 5 分钟，超时不取消、不重建；结果和关系查询不会重跑执行，结构化结果及身份关联仅读取中心已保存事实。已用两节点、两个 Worker 与真实 CLI 验证等待超时、重试、越权拒绝、关系、证据和 batond 重启；Linux 构建、全量测试及相关包 race 检查通过，Windows/macOS 仅交叉编译。无新增中心迁移或依赖。真实 Agent 的环境注入、自动子结果通知/再次输入与父子级联取消仍未实现；`delivery_status=delivered` 仅表示现有执行结果交付事实已存中心，不代表已注入来源 Agent。使用方法与返回边界见 README 的「Agent 本地 CLI」。

CI 已配置为在 pull request 与推送 `main` 时运行 Linux、macOS、Windows 原生构建、vet 和完整测试；Linux 另做 Windows/macOS 交叉编译及 session、node、store、relay、control 包的 race 测试，Web 在 Linux 上运行 lint、typecheck、单元测试、Chromium E2E 与嵌入产物一致性检查。测试使用 CI 内的 PostgreSQL 17，不依赖仓库 Secret。平台通过情况以对应 CI 运行结果为准，不把工作流覆盖范围视为兼容性已验证；命令和覆盖限制见 README「CI 与本地等价命令」。

当前已实现补充（PS-117 / T13）：员工 `POST /tasks/{id}/resolve` 接受 `expected_version`、终态 `status`、`summary`、`reason` 与 `evidence`（为空时提供 `evidence_empty_reason`），在同一事务核实本人待核实或已结束任务，保存人工结论、原记录快照、操作者与时间，不新建 execution 或投递。`POST /tasks/{id}/rerun` 接受新的 `request_id`、`expected_version`、`reason` 与 `confirm_side_effects`；待核实任务必须明确确认副作用风险。新任务复制原任务的目标、Agent、描述、授权与期限长度，使用独立任务、执行、Session 和 outbox 身份，不复用原委托来源，以 `task_relations.rerun_of_task_id` 关联原任务；原任务仅增加版本与重做审计。相同重做请求幂等，人工并发冲突返回最新版本与状态。迁移仅新增 `0012`，扩展事件约束时保留先行迁移的事件种类；审计通过任务事件 API 返回。迟到结果和中止报告沿用已有终态保护及补充事实路径，未修改 `ApplyExecutionReport` 或 Worker。无新增依赖，未包含 Web 核实界面与真实 Agent 适配；API 字段及边界见 README 的「人工核实与显式重做」。

本次在 Linux / PostgreSQL 17 验证 API 认证、归属、版本冲突、核实与重做事务回滚、并发核实及重做幂等、迟到报告不覆盖人工结论；真实 Coordinator、Relay、batond 与计数执行器的进程测试连续 10 次通过：查询和核实保留 1 次输入，显式重做后共 2 次输入，重试不增加执行。Linux 构建、vet、全量测试及相关包 race 检查通过；Windows/macOS 仅交叉编译，未验证目标系统进程与真实 Agent 行为。

当前已实现补充（PS-116 / T12）：新增中心迁移 `0011_child_deliveries.sql`，以稳定 `delivery_id` 保存子结果到来源执行的交付状态；batond 心跳领取通知，来源 Worker 先写本地 SQLite 交付账本。忙碌来源只保留供当前工具查询的结果，明确等待子结果的存活来源才串行提交一次带交付标识的新输入，不重发原始任务。来源已停止或恢复后无法证明原 Agent 存活时不自动启动 Agent；结果仍可查询。交付意图与来源输入代次先同步提交，历史确认后记录 delivered；意图后崩溃保留 uncertain，不自动重注入。CLI 的子任务状态和结果查询区分交付状态与执行结果；来源自身的 delivery_status 仍表示结果已存中心。候选结果在本地绑定 input_generation，存活时提交候选不完成；新输入使旧候选失效，中心拒绝旧代次，并拒绝存在未结束或未处理交付子委托的父任务完成。父取消递归保存独立的子任务取消/中止请求，父停止回执不代替子停止回执。新增两节点、两 Worker 的重复通知、来源停止、意图前后/发送后/确认后崩溃与重连进程测试，以及代次、权限和独立取消回归。原生历史确认目前仅由测试执行器建模，真实 Agent 适配、环境注入、result submit 和人工核实接口不在本次范围；无新增依赖。

## 现状与设计约束

任务需要从 Ubuntu Agent 发到员工 PC，经过北京中转，但北京不能主动访问节点。任务被接受后，中心需要留下可查询记录；完整 Session 历史仍在节点。PC 断线或操作回执丢失时，系统必须核实原执行，不能靠重启 Agent 来恢复任务。

本机已完成 Pi/Codex 的无模型协议探测，以及 Cursor/Kiro 的受控真实接口调查。结论限定到具体版本、系统和观测路径，不代表 Baton 已完成相应适配。

| 对象 | 实际证据 | 可以据此设计的部分 | 尚不能承诺的部分 |
|---|---|---|---|
| Pi 1.3.0 | 已安装包的 RPC、事件、Session、配置与安全文档；get_state、clear_queue、abort、关闭自动重试及 U+2028 请求 ID 往返通过 | JSONL 双向控制；区分 prompt 接受与 agent_settled；使用本地历史 | 真实任务、执行中取消、恢复与三系统支持仍需验证 |
| Codex CLI 0.162.1 | 本机帮助、官方命令导出的协议 Schema；app-server initialize 通过 | thread/turn 映射、结构化输出与分页查询的候选接口 | app-server 标为 experimental；该协议路径的任务执行、审批、中止和恢复仍需验证 |
| Cursor Agent 2026.10.16-e3cb207，macOS arm64 | 真实 print、stream-json、显式 resume、SIGINT 与 ACP 样本；2026.10.01-e373342 仍只有帮助证据 | 单轮 result 完成事件、原生会话标识、带新模型回合的续跑；本次只读续跑没有重跑夹具 | print 活动输入未被接受；SIGINT 后独立 shell 可存活；ACP 的 xhigh fast 选择未跑通，high 变体不能替代；未覆盖其他系统 |
| Kiro CLI 2.32.0，macOS 27.2 arm64 | ACP V3 创建、输出、空闲输入、前台取消与存在会话加载的真实事件和夹具计数 | 显式选择 V3；等待 prompt 响应；原生标识、回放与本轮无重放证据 | 活动 prompt 会打断前回合；缺失 ID 的 load 会新建会话；前台取消样本不覆盖已结束回合的后台进程；无跨系统支持证明 |

Pi/Codex 的上述协议探测未发送 Pi prompt 或 Codex turn/start。Codex 原生 CLI 已用于账号实现的独立审查和验证，这不代替 app-server 接口测试。Cursor/Kiro 的真实探测也仅证明表内所列行为，不代表完整 Agent 适配已经通过。

Pi 的一手资料来自已安装包 `@earendil-works/pi-coding-agent` 的 `docs/rpc.md`、`rpc-commands.md`、`json.md`、`session-format.md`、`security.md` 及相关引用。Codex 使用 `codex app-server generate-json-schema` 导出的 ClientRequest、ServerNotification 和 thread/turn 参数定义。安装版本升级后需重新做兼容性验证。

### 技术选择

| 位置 | 选用技术 | 理由与代价 |
|---|---|---|
| Relay、Coordinator、batond、Session Worker、CLI | Go；初始工具链基线为 Go 1.27 | 可发布原生可执行文件，节点不需要额外 Node.js 来运行 Baton；代价是需要实现和维护各 Agent 的进程协议适配 |
| 中心记录 | PostgreSQL 17，pgx，版本化 SQL migration | 延用原始需求的 PostgreSQL；任务、事件和 outbox 可在一次事务提交，不先引入消息队列 |
| 节点执行账本 | SQLite，WAL 与 FULL 同步，拟用纯 Go 驱动 | 支持断电后的去重和待补报记录，便于跨系统发布；需要验证驱动、锁与磁盘故障行为 |
| Web UI | TypeScript、React、Vite | 静态页面由 Coordinator 提供；无独立 Node.js Web 服务，开发时仍需要前端构建工具 |
| 节点与中转通信 | TLS WebSocket，版本化 JSON 信封 | 适应节点主动连接；控制、查询和受限输出分开排队，业务正文对 Relay 保持不透明 |
| 浏览器实时通知 | 同源 WebSocket；普通操作用 HTTP JSON API | 统一账号会话与权限检查；需要处理输出限流、断流和浏览器重连 |

不嵌入 Agent SDK，也不解析终端 ANSI 画面来判断任务完成。Pi 和 Codex 优先使用结构化双向接口；只有存在证据且经过验证的能力才进入支持矩阵。这样减少对 Agent 内部代码的绑定，但不能消除外部协议升级风险。

## 进程与职责

### 控制与执行路径

```text
浏览器 ── HTTPS / WebSocket ── Coordinator ── PostgreSQL
                                    │
                          内网认证控制连接
                                    │
                                  Relay
                            ╱               ╲
                     出站 WSS             出站 WSS
                         ╱                   ╲
                 Ubuntu batond           PC batond
                       │                     │
                 Session Worker        Session Worker
                       │                     │
                  本地 Agent             本地 Agent
                                             │
                                      工具、设备、公网
```

这是部署关系示意，完整任务的业务请求仍由 Coordinator 验证和记录。节点不能让 Relay 直接把任意正文发给另一员工节点。

| 进程 | 拥有的状态与职责 | 不负责的内容 | 对应行为 |
|---|---|---|---|
| Relay | 活动连接、认证与吊销快照、路由、心跳、受限转发队列 | 任务队列、Session 解析、业务持久化、执行重试 | R-03、R-04、R-24 |
| Coordinator | 员工、节点归属、默认节点、任务状态、委托关系、执行记录、调度、API、Plane 集成 | 原始 Session 历史、模型调用、设备 SSH | R-01、R-05～R-06、R-12～R-25、R-27、R-33～R-38 |
| batond | 节点身份、本机注册、中心连接、能力汇总、本地 RPC、Worker 发现与启动 | 不依靠自身内存保存唯一执行事实 | R-02～R-03、R-07～R-11、R-26 |
| Session Worker | 一个 Session 的 Agent 进程、输入顺序、启动和交付账本、结果、事件及本地历史访问 | 无权签发中心身份、改派任务或创建第二次同任务执行 | R-09～R-11、R-14、R-21～R-23、R-26、R-28～R-29 |
| baton CLI | 员工操作入口、Agent 提交委托与查询结果、提交结构化任务结果 | 不持有中心管理员或签名密钥 | R-12～R-15、R-19 |

Session Worker 由 batond 使用同一可执行文件的内部子命令启动，不是另一个对外部署产品。Worker 与 batond 分开存活，batond 重启时可重新连接原 Worker。系统关机、Worker 崩溃或 Agent 自身退出仍可能中断执行，按 R-22 核实，不保证进程永远存活。

Worker 使用带认证的 Unix domain socket 或 Windows named pipe 与 batond 通信，不向局域网开放无认证控制端口。节点级文件锁防止两个 batond 同时使用同一数据目录；Session 级锁防止两个 Worker 同时接管一个 Session。

POSIX 下 Worker 使用独立进程组；Windows 下由 Worker 持有 Agent 进程的 Job Object，避免 batond 退出连带结束 Worker。进程组、Job Object 和真实工具子进程的退出行为都需要目标系统验证，不能仅靠 detached 标志认定已经独立。

第一版中心按单个活动 Coordinator 设计，不引入多活调度。进程内可有多个任务处理器，但所有业务变更通过数据库事务和版本检查。扩展多实例之前需要补充 leader fencing，不能仅增加副本数。

### 拟建仓库结构

```text
cmd/relay/                  Relay 入口
cmd/coordinator/            Coordinator 与管理命令
cmd/batond/                 节点守护进程与内部 Worker 子命令
cmd/baton/                  员工与 Agent CLI
internal/relay/             连接和路由
internal/control/           身份、任务状态、调度和 HTTP API
internal/node/              注册、能力、节点 RPC 和同步
internal/session/           Worker、输入账本和历史索引
internal/adapters/          各 Agent 协议适配
internal/protocol/          信封、事件、错误和版本
internal/plane/             Plane 触发、映射和回写
migrations/                 PostgreSQL migration
web/                        Web UI
```

内部代码可以按实施规模调整，进程职责与持久化所有权的变化需要修订本设计。

## 状态与持久化所有权

### 中心数据

PostgreSQL 不保存完整 Session 消息。应用层对可持久化事件采用字段白名单，不能直接把节点上报正文存为通用 JSON 日志。

| 拟建表 | 关键字段或约束 | 用途 |
|---|---|---|
| employees、login_sessions | 员工 ID、认证来源、登录状态；浏览器会话只存 token 摘要 | 员工登录与隔离 |
| nodes、node_credentials | 员工、角色、注册序号、系统、能力、凭据版本和吊销状态；连接凭据是 JWT，库中只存 credential_id | 节点身份和稳定初选 |
| node_presence | 节点、员工、在线、已同步、incarnation、conn_id、最后联系时间、状态更新时间 | 在线状态与同步门槛 |
| employee_settings | 员工唯一行、默认 PC 节点 ID | 默认值保持稳定，吊销后仍可显示失效引用 |
| sessions | Session ID、节点、Agent 类型、本地父 Session、原生会话标识、最后状态和时间 | Session 树的元数据索引 |
| tasks | 员工、request_id、任务说明与 R-12 请求字段、request_hash、解析后的目标与 Agent、状态、版本、期限、结果摘要 | 任务权威记录 |
| task_relations | 来源任务、来源 Session、目标 Session、重新执行关系 | 委托链与追溯 |
| task_events | 任务 ID、版本、事件 ID、操作者、允许保存的变更字段 | 状态历史与人工核实记录 |
| executions | task_id 唯一、execution_id 唯一、节点存储代次、准备与启动授权状态 | 一次任务最多一份执行身份 |
| dispatch_outbox | 稳定消息 ID、任务 ID、目标、动作、发送期限、租约 | 可重发投递意图，不在 Relay 排队 |
| delivery_records | 委托结果 ID、来源 Session、交付状态 | 区分执行结束与结果交付 |
| request_tombstones | 员工与 request_id 唯一、请求摘要、原 task_id | 明细清理后仍不能把重复提交当新执行 |
| plane_links、plane_events、plane_outbox | 工单映射、事件标识、执行轮次、回写记录 | Webhook 去重和可恢复回写 |

request_id 去重使用调用方提交的原始字段计算摘要，缺省字段保留“未指定”的语义。重试时先找旧请求，再解析默认节点和 Agent，避免修改默认值后把同一提交误判为不同请求。

任务接受、目标与默认 Agent 解析、execution 身份分配、初始事件和 outbox 写入必须同事务提交。`UNIQUE(employee_id, request_id)` 解决并发提交。任务状态更新同时检查当前版本和执行身份，失败后读取已有记录，不重新创建任务。

所有跨对象查询都附加 employee_id 条件并检查引用归属。数据库可追加行级策略作为防误用措施，但不代替应用授权。浏览器、节点和 Plane 的调用身份在入口派生，不信任正文传来的 employee_id。

### 节点与 Worker 数据

节点数据保存在员工自己的应用数据目录，不放进代码仓库。Linux 使用 XDG 对应目录，macOS 使用 Application Support，Windows 使用当前用户 LocalAppData。身份秘密优先进入系统凭据存储；文件回退必须限制到当前用户，并明确报告使用了回退。

| 数据 | 唯一写入者 | 处理方式 |
|---|---|---|
| 节点配置、身份、存储代次、Worker 索引 | batond | 节点 SQLite 与本地配置；新建存储代次不能自动继承旧任务启动资格 |
| task_id 到 execution_id 的接收记录 | batond | 先持久化再通知 Worker，重复 prepare 返回同一映射 |
| Session 输入、启动、取消及结果交付账本 | 对应 Worker | 独立 SQLite；关键状态提交需完成同步后才操作 Agent |
| 原生 Agent Session 历史 | Agent | 保留原生标识和路径，不搬到北京 |
| 规范化输出与历史索引 | Worker | 节点本地分段文件及索引，供分页、断流补取和缺口标记 |
| 未确认送达的事件与结果 | 事件拥有者 | 本地 outbox；中心持久化 ACK 后才能清理 |

Worker 直接向自己的账本提交执行事实，batond 只转发并代收中心 ACK。这样 batond 崩溃不会丢掉唯一的“是否已向 Agent 发送输入”记录。磁盘写失败时不能报告持久化成功，也不能在缺少启动账本时继续提交新任务。

共享一个大 SQLite 由所有 Agent 进程写入会使锁和清理相互影响。本设计按节点和 Session 分库，增加了文件数量与迁移工作，但让每个关键账本只有一个写入者。

## 任务从接受到执行

### 协议身份与去重

每个任务只有一个 task_id 和 execution_id。运输重试可以产生多次发送，但不能产生第二份执行身份。一次人工重新执行按 R-20 新建 task_id，并关联原任务。

中心命令包含 message_id、task_id、execution_id、目标节点及其存储代次、任务版本和有效期限。节点持久化接收映射后，重复 prepare 只报告现有状态。

### 启动流程

1. Coordinator 在事务中接受任务并保存 outbox，返回已接受。
2. 调度器经 Relay 发送 prepare。prepare 只能绑定目标 Worker、被动检查能力与工作目录，不能把任务输入交给模型，也不能启动可能执行扩展或启动钩子的 Agent。已有空闲 Agent 可以保持原进程。
3. 节点保存 prepared，返回对应 execution_id、Session 和存储代次；Coordinator 保存准备事实。
4. Worker 准备实际提交输入时，请求短时启动许可。Coordinator 在事务中重新检查任务状态、取消标记、目标身份、排队期限和执行身份。
5. 事务保存 start_authorized 后，Coordinator 签发绑定 execution_id、请求摘要与有效期的许可。数据库提交失败则不签发。
6. Worker 校验许可，在 Session 互斥区内检查期限和取消，再同步提交 start_intent。需要新 Agent 进程时，此时才启动；随后只向 Agent 发送一次任务输入。
7. 适配器观察到有效启动事实后记录 started，并持续补报；Coordinator 将任务表示为执行中。

prepare 和启动许可都是内部执行阶段，不增加 PRODUCT 中的对外任务状态。中心若只知道授权已经发出，就必须承认“可能已经启动”，不能把缺少 started 回执解释为从未执行。

启动许可约束第一次可能执行代码的动作：新会话为启动 Agent 进程，既有会话为提交任务输入。执行计时从该边界开始，不能等到模型首次输出才计时。显式指定的 Session 忙碌时返回忙碌，不把该 Session 改成隐式任务队列。

启动许可初始有效期拟为 5 秒，且不能晚于排队到期时间。Worker 从许可请求的往返耗时计算保守的本地单调时钟预算，并扣除安全余量；无法建立正预算就拒绝启动。不能直接信任用户可修改的本机墙上时钟。精确算法、暂停唤醒和异常时钟必须经过故障测试。

过期许可不通过新 Session 或新 execution_id 自动续跑。只有能证明尚未发送输入、且任务仍在等待期限内，才能对同一执行重新准备；已经存在不确定 start_intent 时进入核实。

### 崩溃位置与恢复

| 崩溃或断线位置 | 已知事实 | 恢复动作 |
|---|---|---|
| 接受事务提交前 | 中心没有接受记录 | 相同 request_id 重试；无投递 |
| 接受事务提交后、响应丢失 | 任务已存在 | 返回原任务，不重新解析默认值 |
| prepare 前或重复 prepare | 尚无启动资格 | 重发同一准备命令 |
| prepared 后、启动许可前 | 该 Worker 尚未发送任务输入 | 重新核对中心状态和期限，不凭 prepared 启动 |
| 许可发出、节点未确认接收 | 中心只能判断可能已启动 | 查询原执行，不另发第二份执行身份 |
| start_intent 已同步、尚未写入 Agent 或写入结果丢失 | 无法安全区分输入未发送和已经被接收 | 检查原进程、原生会话及输入标识；证据不足则待核实，不重发 |
| Agent 已运行、batond 重启 | Worker 可能仍在 | 重连 Worker，继续原执行 |
| Worker 退出但 Agent 状态不明 | Agent 可能仍有动作 | 待核实；不能仅用 PID 存在当作同一任务仍运行的证明 |
| 结果本地保存、中心 ACK 丢失 | 同一结果可以重复上报 | 按 event_id 与 execution_id 去重，补 ACK |

这套方案接受“可能一次也未执行但需要人工核实”的代价，以保证不为了追求自动恢复而重复执行设备操作。它不声称跨数据库、进程和交换机实现无条件的 exactly-once。

### 状态处理与人工核实

Coordinator 负责对外任务状态；Worker 负责上报实际执行证据。Coordinator 不能覆盖节点事实，也不能根据中心自身的重启推断任务需要重跑。

节点事件携带稳定 event_id 和 execution_id。事务保存事件、更新状态及创建后续通知后才返回持久化 ACK。乱序结果通过执行身份、事件序号和已有事实归并；终态冲突保存为补充证据，不静默改写结论。

待核实任务仍可查询同一执行。人工核实提交 expected_version、结论、理由与证据，冲突时先返回最新版本。人工结论保留原事实与操作者，不删除失败、取消或不确定的经过。

### 取消与超时

取消请求先在中心事务中保存，再创建取消命令。若尚未发出启动许可且没有可能启动的投递，中心可以直接取消；许可已经发出或状态不确定时，等 Worker 的证据，不能立即宣称取消完成。

Worker 对启动、输入和取消使用同一 Session 串行队列。启动前收到取消，则保存未发送事实并拒绝启动；发送后收到取消，则调用适配器的中止接口。中止 ACK 仅说明接口处理结果，是否还有子进程或外部动作需结合适配器证据。

Pi 中止先 clear_queue，再 abort，并观察是否真的 settled。Codex 使用 threadId、turnId 绑定的 turn/interrupt；不能把其方法返回直接等同于所有 shell 子进程都已停止。Cursor 的 SIGINT 样本中 CLI 已退出但独立 shell 仍运行。Kiro ACP V3 的活动前台 Python 在 session/cancel 后退出；该样本不覆盖回合已结束、通过 shell 后台启动的进程。适配器按具体执行身份和外部动作证据判断，不扩大取消保证。

执行期限由 Worker 的本地单调计时器与中心期限扫描共同监测。Worker 离线时仍能执行已知中止要求。中心无法确认停止，就保存中止标记并按 R-17、R-22 转待核实。到期不发第二次任务输入。

取消父任务时在同一业务操作中找出未结束子委托，分别创建取消请求。界面展示子任务的独立确认情况，不把父任务已停止表示为整个委托链已停止。

## Agent 适配与委托入口

### 适配接口

内部适配器至少定义 Probe、CreateSession、Attach、StartTask、SendInput、Interrupt、ReadHistory、Events、Close。每个实现分别声明能力，不能用空实现假装支持。

会话级互斥由 Worker 控制。启动命令使用参数数组与明确的工作目录，不拼接含员工输入的 shell 命令。模型认证由原 Agent 管理，节点连接凭据与中心签名密钥不传给 Agent。

| Agent | 拟采用路径 | 完成判据与风险 |
|---|---|---|
| Pi | pi --mode rpc；显式 Session 目录和原生会话标识 | 先匹配 prompt 响应，持续消费至 agent_settled；不能只看 agent_end 或进程退出。关闭 Agent 自动重试；正常的工具循环不是重放 |
| Codex | app-server stdio；Session 对应 thread，执行输入对应 turn | 用 turn/completed 及结构化输出核对结果；clientUserMessageId 只作关联，未验证前不作为幂等保障。固定并检查协议版本 |
| Cursor Agent | 基于 print + stream-json + 显式 resume 的已观测单轮路径评估适配 | 以 result 事件结束单轮；resume 是新模型回合，不能自动重发不确定输入。活动输入、停止独立 shell 和指定模型 ACP 仍有缺口，不按完整双向适配宣传 |
| Kiro | 基于 kiro-cli acp --agent-engine=v3 的已观测接口评估适配 | 未完成 prompt 由 Worker 串行；恢复前核对 ID 已存在；取消结合 prompt 响应与本次前台进程证据，保留后台进程未知，不降低首版目标 |

Pi 与 Codex 的 Baton 无设备全流程验证仍待实施。Cursor 和 Kiro 已有本机接口调查作为适配输入；调查顺序不改变四类 Agent 和三类 PC 的首版范围。

恢复时先核对本地历史存在、原生标识与 Session 映射一致，再调用适配器。Pi 的 --session-id 和本次 Kiro 的 session/load 都可能在 ID 不存在时新建会话，调用成功不能单独证明恢复成功。历史或已知会话缺失时必须返回缺失，不能自动创建空会话。

各系统最低版本、CPU 架构和实际 Agent 组合仍属 PRODUCT D1。Go 交叉编译成功只能证明二进制可构建；Windows named pipe、进程树中止、用户登录环境和真实 Agent 必须在目标系统验证。

### Agent 发起委托

首版提供本地 CLI 契约，不要求所有 Agent 使用相同的 MCP 实现。不同 Agent 的 Skill 或说明调用同一 CLI；后续可以增加薄 MCP 包装，不能形成另一套任务语义。

拟提供以下命令，JSON 字段沿用 PRODUCT R-12 和 R-19。

| 命令 | 行为 |
|---|---|
| baton delegate --request-file FILE --json | 提交或查询同一 request_id 的委托，返回接受记录 |
| baton task get TASK_ID --json | 查询状态与交付状态 |
| baton task wait TASK_ID --timeout 30s --json | 有限等待状态变化；到期返回仍在等待，不创建新任务 |
| baton task result TASK_ID --json | 读取已保存结果；查询不重跑执行 |
| baton task cancel TASK_ID --json | 提交取消并返回确认情况 |
| baton result submit --file FILE --json | 为当前绑定任务提交候选结构化结果 |

所有命令通过当前用户的本地 IPC 联系 batond。Agent 使用的临时上下文只允许以绑定的来源任务和 Session 发起操作，不允许自己在正文里指定另一个员工身份。上下文由环境变量指向受限本地文件，不把 bearer token 放到命令行或任务说明中。

delegate 成功返回 task_id。Skill 指导调用者用有限 wait 查询，避免工具默认超时被误认为委托失败。CLI 本身的等待中断不取消已接受委托，也不生成新 request_id。

子结果通知先进入来源 Worker 的本地交付账本。来源仍在执行工具时，由当前工具查询取得；Agent 已空闲但原任务明确等待该委托时，可串行提交一次结果输入，继续同一任务，不重发原始任务说明。来源 Session 已停止时只保留可查询结果。

自动结果输入使用 delivery_id：发送前同步提交 delivery_intent，确认进入原生历史后记录 delivered。Worker 在意图与实际发送之间崩溃时，显示交付待核实，不自动再次注入。任务执行结果状态不因此改变。

### 结构化结果

优先使用已验证的原生 output schema 能力。没有该能力时，Agent 可以调用 baton result submit，或按约定在最终回复中交付 JSON。Worker 校验结构，并由自身填入可信 task_id、execution_id、node_id 和 Session 关联。

提交候选结果不直接完成任务。每次任务输入与结果交付都有 input_generation，候选结果绑定对应代次；后续输入使旧候选失效。只有最新代次的 Agent 已停止自动工作、当前候选有效且没有未处理子委托，才能提交完成。

校验失败不会自动提示模型重做整项任务：有副作用不确定性则待核实，否则记录结果格式错误。

结果摘要、证据和引用可以保存北京，完整原生消息与工具输出不进入中心 task_events。任何“上传全部事件再在中心筛选”的实现都不符合这个边界。

## 通信、认证与输出隔离

### Relay 信封

拟定协议版本为 1，信封包含 version、message_id、route、priority、correlation_id 和 body。body 是不被 Relay 解释的业务内容。

节点连接的来源身份由 Relay 根据认证结果附加，Coordinator 不信任客户端自报的来源。节点上行默认只允许发到控制服务；只有经过认证的 Coordinator 控制连接可以选择目标节点。Relay 无须理解 task_id 或授权范围，也能阻止节点绕过 Coordinator 任意投递。

持久化命令只有在中心或节点保存后才得到业务 ACK。Relay 的“已转发”仅表示运输结果，不能作为任务已接受、输入已发送或结果已保存的证明。

### 节点凭据与吊销

拟采用成熟库实现的 Ed25519 签名 JWT，绑定节点、员工、credential_id、签发方、受众与有效期。签名私钥仅在 Coordinator；Relay 持有验证公钥与吊销快照。业务正文不在 JWT 中。节点连接凭据与启动许可使用不同受众和用途，不能互相代用。

Relay 启动后先取得有效的安全快照，才能开放节点认证；无法取得快照时不允许凭过期内存状态放行。Coordinator 短时重启不清除 Relay 现有连接与已知吊销信息。

吊销在 PostgreSQL 保存，并发送给 Relay。Relay 应用后断开对应连接并 ACK，API 才表示吊销已生效。未确认时返回处理中；不能先显示已吊销再继续允许同一凭据连入。Coordinator 从保存吊销起即拒绝该节点的新业务操作。

节点上线附带每次 batond 启动生成的 incarnation。已有不同 incarnation 活动时拒绝身份接管；相同进程的重连可替换其旧连接。节点重装或本地账本丢失必须经过重新注册或显式身份恢复，不能只恢复旧 token 就继续接收旧执行。

### 有界队列与消息限制

首组配置如下，作为待验证预算。控制消息和输出各有队列，控制消息优先，历史与预览按小段发送。

| 配置 | 初始值 | 超限处理 |
|---|---|---|
| 单条传输消息 | 256 KiB | 拒绝并返回超限原因；禁止借分片上传整份大文件 |
| 输出片段与历史页的目标大小 | 16 KiB | 分段并携带游标；超大单条内容给出截断和本地引用 |
| 单次文本文件预览 | 64 KiB | 返回截断标志与剩余内容引用 |
| 单连接控制队列 | 最多 32 条且最多 1 MiB | 转发失败，由业务 outbox 稍后重试；不丢失已持久化意图 |
| 单输出订阅待发送量 | 256 KiB | 断开该订阅或丢弃输出并发送 gap，不阻塞 Agent |
| 每个中心进程的输出缓存总量 | 32 MiB | 拒绝新订阅或让慢订阅重连，不影响任务控制 |
| 心跳间隔与离线判断 | 10 秒；30 秒未联系判离线 | 只更新连接状态，不直接宣布任务失败或取消 |
| 连接恢复等待 | 带抖动的指数退避，1 至 30 秒 | 认证失效不无限重试注册，显示需重新认证 |
| Worker 账本连续读取失败上限 | 每个 Session 连续 3 次心跳补报检查；计数保存在节点账本，跨重连和重启保留 | `os.Stat` 权限错误与 SQLite 打开、IO、锁忙失败统一计数，阈值前读成或连回原 Worker 后清零；达到上限即上报 `uncertain_history`，停止离线账本读取与 Worker 自动重建，未获中心确认时按同一事件补报；仍接收原 Worker 的有效证据，不新开执行 |

这些限制不能证明 4 核 8 GB 足够。容量测试需加入真实订阅数与输出速率；200 条控制消息/秒不能代替输出流负载。

Worker 持续读取 Agent stdout 与 stderr，避免 pipe 反压阻塞 Agent。完整内容只落本地，中央发送缓存不足时可以丢输出并报告 gap，不能丢状态持久化 ACK 的语义。

Agent 协议帧与传输消息使用不同上限。Pi 可能一次返回大量 get_entries 数据，需在本地拆页或用本地历史索引，不能把全量 RPC 响应直接透传。JSONL 按字节流中的 LF 分帧，正确处理 UTF-8、CRLF、U+2028/U+2029 和跨读取边界。

## API、浏览器与文件

### 中心 API

接口统一使用 /api/v1。浏览器使用 Secure、HttpOnly、SameSite Cookie，写操作检查 CSRF 与 Origin，WebSocket 升级也检查同源和登录状态。初始账号方案见账号方案章节。

| 接口 | 用途及关键限制 |
|---|---|
| POST /login、POST /logout、GET /me | 员工会话；服务端存 token 摘要，不在 localStorage 保存长期 bearer |
| POST /me/password | 校验当前口令、Origin 和当前会话 CSRF 后更换口令，注销本人全部旧会话 |
| GET /employees/{id} | 当前实现仅返回本人资料，非本人 ID 返回拒绝，不查询和泄露对方资料 |
| POST /node-enrollments | 本人签发一次性注册凭据 |
| POST /nodes/register | 以注册凭据换取节点身份；不接受正文任意绑定员工 |
| GET /nodes、POST /nodes/{id}/revoke | 查询本人节点；吊销返回处理状态 |
| PUT /me/default-pc | 修改本人默认 PC，返回实际保存值 |
| POST /tasks | R-12 提交；request_id 唯一；事务提交后返回接受记录 |
| GET /tasks、GET /tasks/{id}、GET /tasks/{id}/events | 本人执行记录、版本与变更，不包含全量 Session 历史 |
| POST /tasks/{id}/cancel、POST /tasks/{id}/resolve | 取消或人工核实，记录操作者及版本 |
| POST /tasks/{id}/rerun | 明确创建新执行，关联原任务，不复用原 task_id |
| GET /sessions、POST /sessions/{id}/input、POST /sessions/{id}/resume | 本人 Session 操作，受 Agent 能力及原任务状态约束 |
| GET /sessions/{id}/history | 按游标查询节点本地历史，节点离线与历史缺失分别返回 |
| GET /nodes/{id}/files | 受限列目录或文本预览，不能传入任意绝对路径 |
| /events | 浏览器同源 WebSocket，订阅本人任务与 Session 的通知或受限输出 |

URL 均相对于 /api/v1。错误对象包含 code、message、request_id、可选 task_id 和 details，details 不回传凭据或任意完整工具输出。错误 code 区分 PRODUCT R-13 的类别；查询状态的客户端失败不能隐式调用 rerun。

历史、实时输出和当前任务补充输入使用临时节点 RPC，不进入中心持久化业务 outbox。需要中心留下审计时只保存操作 ID、对象、时间和交付情况；初始任务说明与授权变化按 R-27 保存。临时 RPC 失败后，通过相同 operation_id 向 Worker 查询，不能盲目重发输入。

### Web UI

页面至少包括节点列表与默认 PC 设置、Session 树、Session 内容与输入、任务及委托详情、受限文件浏览。

节点在线、Session 状态、任务状态和结果交付状态分别显示。显示“最后报告于”与离线标记，避免把中心旧快照展示为当前事实。取消按钮提交后显示请求中，收到事实后才显示取消。

浏览器输出按结构化数据或经过清理的 Markdown 渲染，禁止执行原始 HTML、终端控制序列或任意脚本。链接只允许安全协议，证据链接的访问仍需通过当前员工权限检查。

### 目录与产物

节点本地定义可浏览 root_id 与真实路径，浏览器只提交 root_id 和相对路径。实现需在实际打开目标时验证边界，防止检查之后路径被替换；符号链接、Windows junction 和 reparse point 都纳入测试。

大文件引用只描述位置和访问状态。Coordinator 不代取任意用户 URL，避免形成公网或内网任意代理。实际传输通道由项目配置，下载与刷机前在目标节点核对权限、存在性及可用性。

本设计不提供制品服务。完整 Session 文件导出、固件、抓包和原始日志下载不能通过把它们包装成输出片段绕过 R-32。

## Plane、账号与保留策略

### Plane 接入

Plane 适配器隔离其部署版本、认证方式和 API 差异。Webhook 先验证来源，按已配置的员工映射确定操作身份，再获取当前工单状态，核对触发条件与审批事实。

每个执行触发使用可追踪的 trigger_id，绑定工单与执行轮次。重复事件命中同一触发记录；乱序事件根据当前工单事实拒绝过期触发。回写附 Baton 来源标记，不能形成新的同轮次触发。

任务变化与 plane_outbox 同事务提交。Plane 写入失败只保留待回写，不重跑 Agent。评论或状态写入成功但响应丢失时，先按事件标记查询已有回写，再决定补写，不能假定外部服务提供恰好一次语义。

Baton 链接仍受本人权限限制。Plane 工单本身的可见性由其项目控制，回写只包含已授权摘要，不附完整 Session 或敏感工具输出。

首版使用 Plane 社区版 1.4.2，Webhook 验证、事件标识、当前事实读取、回写和按标记查询以 [PLANE.md](PLANE.md) 的实测为准。升级或更换部署后，重新验证签名、失败重试和回写标记。未在该版本确认的端点不进入适配器。

以下配置于 2026-10-18 批准：

- 设计已批准用项目标签 `design-approved` 表示，执行触发用状态组 `started`。两者都在执行前重新读取工单确认，不按单条 Webhook 快照放行。Done 等其他状态只表达 Plane 工作流。
- 员工映射是显式的 Plane 用户 ID 到 Baton 员工的配置表，并用 `activity.actor.email` 核对。未映射的操作者拒绝执行；集成 token 产生的回写不代表任何员工发起新执行。
- 回写使用评论，不改写工单描述。评论的 `access` 为 `INTERNAL`，`external_source` 固定为 `baton`，`external_id` 为 Baton 回写记录 ID；正文只含固定前缀、Baton 任务链接、状态、短结果和证据引用，不含 Session 原文、命令输出或凭据。

文件通道与固件规模仍未调查。

### 账号方案

当前已实现部署管理员分配的本地员工账号与一次性初始口令，采用 Argon2id 和服务端登录会话。管理员通过 Coordinator 命令创建或重置账号，不开放公网自主注册，账号初始化不发送外部通知。员工通过改密 API 更换口令。口令替换与会话签发按员工行锁串行，替换提交后旧摘要不能再签发有效会话；改密和重置同时注销既有会话。

认证模块保留外部身份映射接口。如果公司已有统一认证且要求首版使用，改为接入相应协议；该选择需要负责人确认，当前不假定某个身份系统已经存在。

注册凭据拟默认 10 分钟、单次使用；节点连接凭据拟默认 30 天，可在有效连接中轮换，吊销仍按 credential_id 生效。轮换不得产生新节点身份，秘密不能进入 URL、命令行或浏览器日志。

### 保存与空间不足

中心已结束任务明细拟默认保留 180 天。未结束、待核实、仍有活跃引用或待回写的记录不自动清理。去重墓碑独立于明细保留，不能因为清理明细而允许相同 request_id 创建新任务。

Session 原生历史不由 Baton 默认自动删除，员工在节点本地管理。未确认送达的执行结果不按时间静默丢弃。本地节点账本与待补报区拟设 1 GiB 可配置预算，达到预警水位后停止接受新任务并提示清理或扩容；清理不能删除仍需去重或核实的记录。

中心墓碑和本地账本均需要容量监控。没有安全的标识回收设计前，不自动移除去重事实；空间不足时拒绝新执行，不能靠删除去重记录维持运行。原始历史与规范化输出的配额应单独监控，磁盘错误记录为保存失败。

180 天、凭据期限与空间预算是 PRODUCT D2、D4、D6 采用的初始值，允许配置；实际交付需展示生效值，不代表当前已在部署中配置。

## 部署、兼容与变更

北京拟以独立服务运行 Relay、Coordinator 和 PostgreSQL。静态 Web UI 由 Coordinator 提供，入口代理终止外部 TLS；Relay 路径启用 WebSocket。内部控制连接使用独立凭据或 mTLS，不暴露给员工节点。

Windows 节点拟使用当前员工身份的登录启动任务，macOS 使用 LaunchAgent，Linux 使用 systemd --user 或显式前台运行。默认不以 LocalSystem 或 root 运行。员工退出、系统睡眠及虚拟机暂停按离线处理，不将其当作无人值守执行承诺。

协议含主版本和能力协商。未知主版本拒绝连接；兼容新增字段可忽略，但未知执行动作不能当成功。数据库 migration 先检查版本，破坏性迁移需要单独计划；升级时已有 Worker 继续持有自己的执行身份，不通过升级重跑任务。

Agent 版本按验证过的范围登记，发现未知版本时标为未验证并限制有风险能力。不能自动升级 Agent 后仍沿用旧版本支持结论。发布包包含 Baton、前端资源和协议版本，模型凭据与设备配置不打进包中。

## 验证计划

### 已执行调查

| 项目 | 设置与观察 | 结果 | 证据范围 |
|---|---|---|---|
| Pi 控制命令 | 临时 Agent 目录、offline、关闭扩展及 MCP、无持久 Session | passed | get_state、clear_queue、abort、关闭自动重试，未执行模型任务 |
| Pi JSONL 分帧 | 请求 ID 含实际 U+2028，按 LF 读取响应并核对 ID | passed | 证明本次控制往返，不覆盖任意大型事件 |
| Codex 协议结构 | 官方命令导出 Schema，核对 thread/turn 方法与参数 | inspected | 接口定义可用，不代表方法已运行 |
| Codex 初始化 | 临时且已创建的 CODEX_HOME，stdio initialize/initialized | passed | 仅初始化，不覆盖执行和恢复 |
| Cursor 单轮与恢复 | 2026.10.16-e3cb207、指定 xhigh fast；print、stream-json、显式 resume、SIGINT | observed | result、会话关联和只读续跑有证据；活动输入未被接受；SIGINT 后 shell 可存活 |
| Cursor ACP 与配置 | ACP high 变体、xhigh 选择失败及历史样本只读复核 | observed | 不计为 xhigh 支持；旧探测曾写回全局配置，当前模型字段可核对，原始字节完整恢复未证实，旧脚本不能直接复用 |
| Kiro ACP V3 | 2.32.0、macOS arm64；写入计数、加载、活动输入和前台取消 | observed | 原会话加载后计数仍为 1；缺失 ID 会新建；活动第二 prompt 打断旧工具；前台取消不代表后台动作停止 |
| 本地账号 API | PostgreSQL 17.6、完整测试、race、真实 Coordinator TLS 路径与日志检查 | passed | T01 范围通过；并发改密残留会话与配置错误口令泄漏均有失败到通过回归，不含节点与 Web UI 验收 |

### 实施时必须验证

| 要求 | 设置与观察 | 失败条件 | 环境 | 状态 |
|---|---|---|---|---|
| R-01～R-04、R-37 | 两员工、注册过期、吊销、伪造来源、克隆身份；检查活连接与日志 | 越权投递、吊销已生效后仍能通信、秘密泄露 | 集成与安全测试 | planned |
| R-05～R-06 | 并发注册和修改默认值、默认节点离线或吊销、重试原 request_id | 目标随重试变化、已有任务迁移、自动改派 | PostgreSQL 集成 | planned |
| R-07～R-11 | 各目标系统运行真实 Agent；输入、并发忙碌、中止与本地历史恢复 | 宣称未支持能力、混合任务上下文、恢复触发重放 | Windows、macOS、Linux | planned |
| R-12～R-15、R-19 | Ubuntu 到 PC 的真实委托，结构化结果、授权与来源校验 | 无中心记录即执行、结果不可关联、授权被扩大 | 两节点端到端 | planned |
| R-13、R-16、R-23 | 接受与 prepare 各边界断网，重投 100 次，排队过期后延迟送达 | 同一任务多次提交 Agent、过期启动、重复产生任务 | 状态机与集成故障注入 | planned |
| R-17～R-18、R-20～R-22 | start_intent 同步前后、写 pipe 前后、取消与完成竞态；记录实际外部调用次数 | 无法确认时重发输入、把中止请求当停止、丢核实事实 | Worker 子进程故障注入 | planned |
| R-14、R-23 | 子结果重复、来源停止、交付意图保存后崩溃 | 重复注入来源、自动复活已停止 Session | 两 Worker 集成 | planned |
| R-24～R-26 | 分别重启 Relay、Coordinator、batond、Worker，短时停止 PostgreSQL | 重复执行、唯一执行事实丢失、未落库却 ACK | 容器与本地进程 | partial |
| R-27～R-30 | 从 Web UI 查看委托树并干预任务，执行后断开节点；搜索数据库、日志及输出缓存；慢浏览器与历史补取 | UI 状态或操作反馈不实、中心有完整历史归档、缺口被隐藏、内存无界增长 | Web UI 集成与隐私检查 | planned |
| R-31～R-32 | 路径替换、符号链接、junction、越界路径、缺失固件、超大日志 | 越界读取、绕过文件通道、产物不可用仍刷机 | 三系统与文件通道 | planned |
| R-33～R-36 | 实际 Plane 项目，重复乱序 Webhook、审批未通过、回写 ACK 丢失、人工验收 | 多次执行、绕过门槛、回写循环、Agent 自动验收 | Plane 测试项目 | planned |
| R-38～R-39 | 约定负载下运行 24 小时并故障注入，观测队列、延迟与恢复 | 超过评审确认的预算或发生重复执行与隐私违规 | 压测环境 | planned |

故障注入需要一个记录调用次数的无副作用执行器，逐个覆盖意图提交和实际输入之间的崩溃窗口。模型执行、设备操作和真实网络路径再分层验证；模拟通过不能代替真实 Agent、交换机或跨系统结果。

当前本机只能直接覆盖 macOS arm64。Windows、Linux、实际北京网络和 Plane 测试项目需要对应环境，缺少环境时明确保留未验证状态，不使用交叉编译结果代替。

## 评审决定与验证缺口

| 编号 | 事项 | 本设计给出的方案或缺口 | 负责确认 | 阻塞范围 |
|---|---|---|---|---|
| Q1 | 技术方案 | 已批准采用 Go、PostgreSQL、节点与 Session SQLite、独立 Worker、启动许可、JSON 协议及 React UI | 用户已确认 | 不再阻塞任务拆分与相应实施 |
| Q2 | 账号与部署参数 | 随本设计批准采用本地分配账号、注册 10 分钟、节点凭据 30 天、明细 180 天及所列初始预算 | 用户已确认 | 按方案实施并验证；将来接入公司身份体系另行确认 |
| Q3 | Agent 和系统实证 | Cursor/Kiro 本机接口调查已完成；Pi/Codex 的 Baton 全流程、Cursor 输入与停止缺口、Kiro 忙碌和恢复边界，以及跨系统组合仍需适配验证 | 实施者与目标环境提供者 | 对应适配器与发布支持矩阵，不能因此缩小批准范围 |
| Q4 | 外部系统事实 | Plane 社区版 1.4.2 的 Webhook 验证、投递标识、可读字段和回写标记已实测，见 [PLANE.md](PLANE.md)。版本、审批字段、员工映射和回写摘要已于 2026-10-18 批准，见「Plane 接入」。已有文件通道与固件规模仍未调查 | 项目及环境负责人 | Plane 集成与真实文件、刷机验收 |
| Q5 | 性能验收阈值 | 本设计给出初始传输预算；API 延迟、恢复时限和可接受积压需在代表性负载后定值 | 实施者与项目负责人 | 容量达标声明，不阻塞基本协议与状态机实现 |

实施任务按节点与身份、执行账本、跨节点委托、Agent 适配、Web UI、Plane、可靠性与跨系统验收组织，任务清单和进度由 Linear 工单管理。这个顺序用于分配实施和验证依赖，首版行为仍以 PRODUCT 为准。
