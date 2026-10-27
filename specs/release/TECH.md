# 打包与发布技术设计

Status: draft
Basis: [发布行为规格](PRODUCT.md) RL-01～17；[Baton TECH](../baton/TECH.md)；[Agent 适配 TECH](../agent-adapters/TECH.md)；[构建与发布工具](../../tools/README.md)。

打包、发布元数据、公开版本查询、检查、测量、平台边界和持久格式基线记录现行实现；连接时的版本核对、增量格式升级和升级准备流程尚待实施。凭据闲置过期与重新认证由 Baton TECH 负责，本设计引用其结果。

## 打包与发布

中心使用 Node 26 运行 esbuild bundle；设备端使用携带 Node 的 SEA 安装包。发布目标为 macOS arm64、Linux x64、Linux arm64 和 Windows x64。开发与验证命令见 [AGENTS.md](../../AGENTS.md)，各脚本参数见 [tools/README.md](../../tools/README.md#构建打包与发布)。

| 产物 | 内容与运行方式 |
|---|---|
| 中心 bundle | `apps/server/dist/server.cjs`，相邻的 `web/` 与 `migrations/`；构建自动生成网页并复制根目录的 SQL 迁移 |
| 中心镜像 | `node:26-bookworm-slim`，包含中心 bundle、网页与迁移；由非 root 的 `baton` 用户在专用数据目录运行，配置见根 README 与 `compose.yaml` |
| 节点开发 bundle | `apps/batond/dist/batond.cjs`；通过已安装的 Node 与 workspace 依赖运行，Project Runtime 与 watchdog 通过同一 bundle 的子命令启动 |
| 节点安装包 | `batond`（Windows 为 `batond.exe`）、旁置 `node_modules/`、`licenses/`、`package.json`、`package-manifest.json` 与 `INSTALL.md`；设备无需另装 Node |
| 发布归档 | `baton-<带 v 前缀的版本>-<平台>.tar.gz`（Windows 为 `.zip`），附 SHA-256 文件和安装包检查 JSON；归档内另有 `release.json` |

[统一构建入口](../../tools/build.mjs) 从根 workspace 安装锁定依赖，检查网页类型，构建中心与节点 bundle，再生成 `bin/` 安装包。[节点打包器](../../tools/package-batond.mjs) 使用支持 `--build-sea` 且保留 LICENSE 的官方 Node 26，默认使用执行脚本的 Node；也可通过 `--node` 指定目标平台的官方 Node。跨系统构建由宿主 Node 将 bundle 注入目标可执行文件，目标平台依赖必须已安装。macOS 安装包必须在 macOS 上完成 ad-hoc 签名；最终检查与归档在目标平台运行。

SEA 不启用 code cache 或 snapshot，`execArgvExtension` 设为 `none`。Worker、watchdog、agent-host 和 Project Runtime 都通过自身可执行文件的子命令启动，Runtime 业务代码包含在同一 bundle 中。Runtime stdio 使用 `BATON_PROJECT_RUNTIME_TRANSPORT=stdio`，Runtime 在自身进程内读写凭据。

### 依赖与许可

完整 `@cursor/sdk` JavaScript、生产依赖与当前系统及架构的平台包放在可执行文件旁的 `node_modules/`，由 SEA 通过 `createRequire` 加载。`@napi-rs/keyring` 及其平台原生模块同样外置。Pi 的 `pi-ai`、`pi-agent-core` 保留磁盘上的 ESM 文件、模型数据与 OAuth 动态模块，构建时解析入口，SEA 运行时从附带目录加载。

[依赖复制器](../../tools/package-dependencies.mjs) 沿已安装的生产、peer 与可选依赖图复制物理文件，按目标系统、架构及 glibc 筛选平台包；相同依赖提升复用，冲突版本保留在调用方自己的 `node_modules/`。必需依赖缺失时直接失败。节点打包器不下载 Node 或依赖，产物不依赖源码目录或 pnpm store 链接。

`package-manifest.json` 记录 SEA 格式、目标平台、架构、Node 版本、附带依赖的名称、版本与相对路径，以及已打入 bundle 的包。`licenses/` 包含 Node LICENSE、t3code LICENSE、依赖包提供的许可声明和 Cursor 来源说明。Cursor 的包来源、integrity 与分发条款见 [Cursor SDK](../../third_party/cursor-sdk/README.md)。

### 官方 Node 输入

[Node 缓存工具](../../tools/release/cache-node.mjs) 仅在显式指定 `--download` 时通过 HTTPS 获取 nodejs.org 的官方归档与 `SHASUMS256.txt`，校验 SHA-256 后解包，并保留 LICENSE。缓存根目录可通过 `BATON_NODE_CACHE` 覆盖；离线输入缺失时给出下载命令。工具未核验发布者的离线签名。

已有 Node 26.11.1 归档校验记录如下，缓存操作用法见 [官方 Node 缓存](../../tools/README.md#官方-node-缓存)。这些记录不表示其他环境中已存在相应缓存。

| 官方归档 | SHA-256 |
|---|---|
| `node-v26.11.1-darwin-arm64.tar.gz` | `d916511b55965e91be7a88e17f88d895b6793ceaba3e6c9b194aefe51c2c65ac` |
| `node-v26.11.1-linux-arm64.tar.gz` | `170454fb022f5e9b5f6cc76c25fa32ef5100895be44eb04e92f9780591491bbf` |

### 发布流水线与归档

[发布工作流](../../.github/workflows/release-packages.yml) 由 `workflow_dispatch` 接收带 `v` 前缀的版本号，在 `macos-15`、`ubuntu-24.04`、`ubuntu-24.04-arm` 与 `windows-2025` 上原生构建，固定 Node 26.11.1 和 pnpm 12.11.2。Linux 执行包含本地 PostgreSQL 的工作区测试与中心构建；macOS、Windows 执行节点与 Project Runtime 测试。自动化验证使用离线转录、本地替身与本机资源。

每个平台依次执行安装包构建、搬迁检查、100 个 Worker 冷启动样本与 2000 次 FULL 账本操作，Windows 另执行进程机制检查，然后归档并验证解压产物。构建、检查、测量 JSON 与测试日志作为工作流产物上传。Windows 节点与 Runtime 测试步骤允许失败后继续打包；安装包检查失败仍会阻止后续测量与归档。工作流上传产物，不自动创建 GitHub Release。

[归档器](../../tools/package-release.mjs) 只复制可执行文件、附带依赖、许可及规定的元数据，校验帮助、SEA 平台与版本、安装包清单。`release.json` 由安装包构建生成，记录版本、明确输入的源码提交、目标平台、协议版本、中心迁移版本、三类账本格式版本、声明支持的 daemon 版本、构建 Node 与 SEA Node。归档器保留这些元数据，并要求归档版本与程序实际版本相同；归档时不从当前 Git 工作区重新填写身份。Unix 生成 tar.gz，Windows 使用系统 bsdtar 生成 zip，并校验文件头。最终归档重新解压后，再检查布局、清单、发布元数据并运行完整安装包检查，通过后才写出归档、SHA-256 与检查报告。

## 安装包检查

[安装包检查入口](../../tools/check-package.mjs) 与归档器共用 [安装布局规则](../../tools/lib/installation.mjs)：可执行文件必须是非空普通文件，POSIX 上有执行权限，依赖与许可目录非空，包内链接必须解析到包内。检查将安装包复制到临时目录，以空 PATH、临时 HOME 和包外工作目录运行，不继承 provider 凭据与个人配置路径；Windows 保留系统命令所需的环境变量。

| 检查 | 观察与失败条件 |
|---|---|
| 帮助与版本 | 帮助包含 Baton 命令；版本报告 `sea=true`、当前系统与架构、有效 Node 版本；`release.json`、安装包清单与 daemon、Worker、agent-host、watchdog、Runtime 的版本输出和诊断元数据一致 |
| Worker | 真实 `LocalWorkerHost` 启动一个 SEA Worker，认证 status 达到 `worker_ready=true` 且 `agent_ready=false`；错误 IPC 令牌被拒绝，独占锁与创建时间匹配，业务表、格式表、迁移记录与 WAL 已持久化，账本格式与 Worker 实际诊断一致；从 spawn 到认证 status 必须小于 Host 就绪预算（Windows 10 秒，其余系统 3 秒） |
| 清理 | POSIX 发送 SIGTERM 后确认 Worker 与 watchdog 退出、锁释放；Windows 核对 CIM 身份后执行 `taskkill /T /F`，确认退出与锁已失效，报告 `graceful=false` |
| Agent host | SEA 的 `agent-host --probe` 实际加载 Cursor、Pi、Codex、Kiro 四个模块，加载 keyring，并用 tree-sitter 与 Bash grammar 解析 `echo baton` |
| Cursor SQLite store | 隔离的 Node 子进程从搬迁安装包 `createRequire` 加载 `@cursor/sdk/sqlite`，打开并关闭临时 store；该检查由运行工具的 Node 执行 |
| Cursor 程序 | 直接运行包内 ripgrep `--version` 与 sandbox helper `--help`；核对退出码和输出 |
| Project Runtime | 通过 stdio 回应 `bootstrap`、空 `read_events`，在 `claim_inputs` 返回本地结束响应后核对 Runtime 退出码为 1；不交付输入，模型调用次数为 0 |
| Memory Runtime | 通过 stdio 完成 `memory_bootstrap`、空 `pending_embeddings` 与 `finish`，核对退出码为 0，无需聊天登录；另向本地 Embedding HTTP 替身发出一个请求，关闭 stdio 后请求取消、进程退出，不发送提交或失败报告 |
| Embedding 凭据 | SEA 的 `embedding-key` 从标准输入保存本地样例，memory 模式实际加载它访问本地替身；POSIX 校验目录与文件仅当前用户可访问，Windows 沿用继承权限、不校验 ACL |
| 订阅凭据 | 在临时 HOME 写入本地凭据样例；订阅报告识别登录状态且不泄漏凭据值 |
| 缺失依赖 | 临时移走 `node_modules/` 后，Agent host 检查必须非零退出、无成功输出，并明确指出安装包依赖缺失 |

各项检查输出独立结果，任一失败使总结果 `passed=false` 并非零退出。调用方式及预构建驱动参数见 [安装包检查](../../tools/README.md#安装包检查)。工具与测量驱动需要 Node 26，被测 SEA 自带 Node；预构建驱动应与安装包使用同一源码版本。

Cursor store 子进程禁用 fetch 和 HTTP(S) 请求。上述加载检查不调用 `Agent.create`、`resume`、`send`，sandbox helper 的帮助输出仅证明程序能加载。认证、会话行为与停止语义由 [Agent 适配验证](../agent-adapters/TECH.md#验证策略) 覆盖，安装包模块检查与生产能力探测分别记录结果。Agent 可用性按上游安装与认证检查开放，缺少系统或版本的验证证据不增加白名单限制。

## 版本与兼容

发布元数据与只读查询已实现；连接时的版本核对与后续升级准备流程仍为 RL-05、06、10～16 的待实施设计；存储基线与摘要校验见「持久格式与迁移」。首版允许人工停止和切换程序，升级入口负责状态、迁移与检查；安装包由管理员或设备用户取得，不在进程运行时覆盖旧目录。

### 模块职责

| 位置 | 现有机制与拟扩展职责 |
|---|---|
| `tools/package-release.mjs`、`tools/lib/installation.mjs` | 归档、SHA-256、搬迁复验与发布身份一致性校验；升级预检尚待实施 |
| 中心与节点构建入口、`packages/protocol` | 将同一份发布版本和提交注入各进程；声明协议、数据格式与升级能力 |
| `apps/server/src/database.ts`、`migrations/` | 在现有事务 advisory lock 内核对已应用 SQL 的 SHA-256 和文件顺序，再执行剩余迁移 |
| `apps/batond/src/{daemon,worker,project}/ledger.ts`、`src/storage-format.ts` | 各自声明基线 SQL；在业务解码与写连接打开前核对格式类型、版本和迁移摘要，仅为空库初始化基线 |
| `apps/batond/src/daemon` 与 `src/project` | 持久升级准备状态，协调节点命令、所有 Worker 与前后台 Runtime，不以 daemon 退出代替回收确认 |
| `packages/sqlite` | 保留 WAL/FULL、提交 token 核验、独占迁移与备份所需能力；不解释各账本业务 JSON |
| `packages/telemetry` | 按 Baton R-23 记录实际版本、固定原因和结果；保持导出过滤与时限 |

### 发布元数据与连接

中心与节点构建入口、统一构建和 SEA 打包都接受 `--version <带 v 前缀的发布版本> --commit <完整小写 Git 哈希>`，两个参数一起指定；未指定时版本和提交均为 `development`。构建通过 esbuild 编译常量注入身份，不从运行环境变量读取版本。`packages/protocol/src/release.mjs` 是共享来源，中心、daemon、Worker、agent-host、watchdog 和 Runtime 的 `--version` 及诊断使用同一份元数据。中心版本查询无需数据库配置；节点及子进程另报告 SEA 和 Node 运行信息。开发 bundle 的 Runtime 与 watchdog 从同一 bundle 启动，直接源码入口仍通过 tsx 运行。

`release.json` 和安装包清单保存 `version`、`commit`、`platform`、`arch`、`protocol_version`、`schema_version`、`ledger_versions` 和 `supported_daemon_versions`。当前协议版本为 1，中心迁移版本为 `0007_thread_turn_items.sql`，账本 `node`、`project`、`thread` 均为格式 1。构建核对中心迁移目录的最新文件与声明一致，账本检查直接使用共享格式常量。首版仅声明支持当前 daemon 发布版本，连接时尚未执行该声明的准入检查；增量迁移来源及应用回切范围尚待相应升级实现声明。包内元数据与程序输出不一致时，安装包检查和归档失败；归档器不能给旧二进制重新贴标。

草案采用中心 N 支持 daemon N 与上一个发布版 N−1；仅包括已建立发布基线的版本。版本范围来自发布清单，不由 SemVer 大小或固定协议号推断。协议版本表达 wire 语义，可选字段表达新增能力；Agent 的 CLI 版本、模型和系统组合仍按既有准入规则处理。

中心提供无需登录的只读 `GET /api/v1/release`，返回上述发布元数据，不返回设备、员工或部署秘密，不读取认证状态或写入设备凭据。已登录诊断的 `release` 字段与其一致。该入口不延长设备闲置期限。

以下连接检查与升级预检仍为待实施设计：中心在节点身份校验后、同步与派发前核对 daemon 版本及协议，返回中心版本、支持范围和升级原因。`upgrade check` 读取本地格式并查询该版本契约，不迁移或启动 Worker。节点闲置过期时，实际恢复连接前先重新认证。首次准备时中心不可达则保持原版本；已取得该目标的预检结果后断网，可以继续本地准备与迁移，恢复业务前仍须重新检查并同步。明确不兼容返回 `node_version_incompatible`；未知可选能力缺省关闭，兼容性拒绝不能清除 outbox。

中心优先升级，兼容的旧 daemon 正常运行，随后设备逐台升级。通信窗口与格式迁移路径分别声明；超过通信窗口的设备可以由目标包直接执行完整迁移链，或使用指定的中间包仅做离线迁移。中间包不用连接不兼容的中心，也不恢复业务；最终目标必须通过中心兼容预检。首版无需支持任何发布基线之前的开发程序。

## 持久格式与迁移

### 发布基线

首版发布前完成长期记忆和凭据结构调整，按最终结构生成基线。正式归档所含的迁移文件和解码规则固定后不再改写；后续新增迁移文件。现有实验数据是否保留由部署者在首版安装前决定，不新增旧实验格式兼容层。

PostgreSQL 的 `schema_migrations(version, checksum, applied_at)` 保存迁移文件名、SQL SHA-256 与应用时间。已应用记录必须按文件名排序构成随程序附带迁移的完整前缀；未知版本或中间记录缺失返回 `storage_version_unsupported`，摘要不符返回 `migration_checksum_mismatch`。现有实验库缺少摘要列时拒绝启动，不补填摘要。

三类 SQLite 账本各自只有格式版本 `1` 和迁移 `0001_baseline`，尚无增量迁移链。各库使用 `storage_format(id, kind, version)` 单行表及 `storage_migrations(id, checksum, applied_at)` 迁移记录表，`kind` 分别为 `node`、`project`、`thread`。SHA-256 覆盖类型、格式与 payload 基线版本及该账本声明的 SQL。

| 存储 | 迁移边界 |
|---|---|
| PostgreSQL | `schema_migrations` 保存版本、SQL SHA-256 与应用时间；启动前核对已应用文件及程序支持范围，校验通过后才执行新迁移 |
| `node.db` | 独立记录节点命令、Worker 发现与报告账本的格式版本；保留 generation、命令身份、ACK 与已尝试派发事实 |
| `project-runtime.db` | 独立记录 Runtime 运行、进程身份与清理格式；有后台记忆模式时包含其 claim/attempt，不丢弃旧清理义务 |
| 每个 `thread.db` | 独立记录 Worker schema 和 JSON payload 版本；保留 seq、intent、输入准备证据、原生会话、控制代次和去重记录 |
| 私有身份与配置文件 | 沿用现有原子写入与字段保留规则，本次基线不增加结构版本 |

SQLite 在只读连接中核对格式元数据和迁移记录，通过后才打开写连接、读取业务 JSON。缺少或不支持的类型、版本、迁移记录返回 `storage_version_unsupported`；摘要不符返回 `migration_checksum_mismatch`。仅缺失文件或零字节新文件可初始化；已有非空文件缺少元数据时拒绝采用，不自动识别旧实验格式。

基线建表、提交核验行、格式元数据和迁移记录在现有 SQLite 事务内一起提交。重复打开核对持久记录，不重跑基线 SQL。提交继续复用 `packages/sqlite` 的 token 核验；`CommitUnknown` 时停止，关闭连接后核对持久事实，不盲目重跑。后续增量迁移需要在新增格式时定义旧数据解码和前向转换。

中心复用现有迁移事务和 advisory lock，格式核对失败或迁移失败时不启动业务 listener，管理员命令也不能跳过校验写入。每次迁移保持短事务，不含模型、网络请求或不可回滚的外部动作。新程序遇到范围之外的格式、摘要变化、缺失迁移或损坏，分别返回可诊断错误并保留文件。

待实施的设备升级流程取得整个数据目录的独占升级锁，并确认所有数据库写入者退出；daemon 启动、Worker 独立启动与本地 CLI 都必须检查该锁和持久升级状态。逐库提交允许中途崩溃，升级记录只作为进度提示，实际完成情况以各库元数据为准。全部所需数据库与配置迁移成功之前，不恢复任何新业务；已升级库重试时跳过已提交迁移。迁移器和正常账本操作共享提交核验实现。

旧程序只可在清单声明的数据范围内应用回切；已发布程序都必须先检查格式再打开业务写入口。默认不提供 down migration。需要不兼容变更时提供前向修复或一致备份恢复说明。

## 升级执行与恢复

### 中心

管理员停止旧中心及使用同一数据库的管理写入，取得 PostgreSQL 一致备份，保存相应签名密钥、数据库迁移版本、发布版本与部署配置。备份成功后，使用新版本已有的 `migrate` 入口执行并核验迁移，再运行 `serve`；`serve` 自带的迁移检查仍然保留。现有单活动中心约束继续适用。

迁移期间不监听业务端口，节点按既有策略退避。Thread 在设备上继续执行、持久保存结果；Project 前后台 Runtime 按租约和保存屏障结束，不将本地未保存输出当作已完成事实。服务启动后先验证数据库、静态资源和发布元数据，节点重新连接同步，原 ID 的 outbox 继续派发与去重。重连后的闲置状态按 Baton R-02 判断，中心停机超过期限时仍需重新认证。

数据库事务失败时回滚本次未完成迁移，中心继续停服。已提交迁移与程序支持范围相容时可切回旧程序；否则继续修复迁移，或停服恢复配套备份。恢复前说明将丢失的备份后数据，不能将程序文件回切视为数据库回滚。

### 设备准备与切换

拟增加的本地管理入口如下，尚不可作为现有命令运行。它们复用节点锁与认证 IPC 的模式，由 daemon 统一协调；不依赖中心远程安装程序。

| 入口 | 作用 |
|---|---|
| `batond upgrade check --package <目录>` | 只读验证安装包、实际版本、格式范围、当前中心兼容性及剩余空间，返回可执行与失败原因 |
| `batond upgrade prepare --package <目录>` | 重新预检并以持久 operation_id 登记源/目标与升级准备，立即返回状态；相同目标的重试复用当前准备 |
| `batond upgrade migrate` | 在 ready 且 daemon 已退出时，由目标或迁移链中间版本持独占锁执行本地迁移后退出；保持业务暂停 |
| `batond upgrade status` | 返回阶段、源/目标版本、阻挡的 Thread/Runtime、补报与进程清理信息 |
| `batond upgrade cancel` | 仅在迁移前取消准备；恢复队列调度，不恢复被用户显式停止撤回的输入 |

用户先解包新版本到独立目录并执行预检，旧安装目录继续可用。准备状态保存在数据目录的私有原子文件中，包含操作 ID、源/目标版本、目标安装路径、备份位置和阶段；退出、重启或休眠不能抹掉它。并发准备相同内容复用状态，不同目标返回 `upgrade_conflict`。CLI 操作的身份与内容都由本地宿主核验。

| 阶段 | 行为与恢复依据 |
|---|---|
| `draining` | 禁止开始新执行；等待当前工作结束、后台停止、结果落盘及进程退出 |
| `ready` | 所有执行与登记进程清理已确认，数据库已关闭；daemon 保持管理入口，用户可正常退出它 |
| `migrating` | daemon 已退出，目标版本持独占升级锁并检查备份后逐库迁移，业务启动保持关闭 |
| `syncing` | 本地格式检查通过，目标版本以原设备身份连接中心；只补报、同步与处理必要清理，不开始新执行 |
| `completed` | 中心确认同步且清理义务完成，解除升级暂停并恢复原队列；持久保留最后一次升级结果 |
| `cancelled` | 迁移前取消准备并确认原程序仍可读取数据，清除门禁后恢复调度；保留操作结果 |
| `failed` | 保存原阶段、错误码和当前格式；保持暂停，按数据库事实判断继续或恢复路径 |

阶段协议在 `packages/protocol` 统一声明：节点能力增加 `upgrade_protocol=1`；`node.upgrade_state` 带 operation_id、源/目标版本与阶段，中心持久保存后以原 operation_id 回执。中心只接受当前节点来源，重复同内容返回原结果，同 ID 不同目标返回 `upgrade_conflict`；普通报告不能把阶段回退。节点视图返回升级阶段与固定原因，不暴露本地路径。首次没有该能力的组合按下文人工停机流程处理。

daemon 在本地先持久进入 draining，再上报升级能力与阶段；中心确认后停止领取该节点的 open、message、resume、Project 前台和后台启动，保留持久 outbox。stop、withdraw、结果回执和必要清理继续处理。已在途的启动或消息可以落盘接收，但本地执行门禁阻止新回合；接收 ACK 只表示持久保存。节点本地 CLI 与 Worker 自己的 queued 调度也检查同一升级状态，不能绕过 daemon 开始下一轮。升级期间新的业务意图仍可由中心保存，界面说明等待设备升级。

当前 Thread Turn 自然结束后，Worker 暂停在下一轮提交 intent 之前，落盘报告并关闭原生会话连接、agent-host 与自身。关闭会话连接不删除原生会话。普通升级不调用会撤回 queued 的 Thread stop；用户显式停止时继续按 R-11 撤回未发输入。Project 前台在下一持久化安全点退出：取消尚未保存的模型输出，保留已保存 assistant、工具调用、结果及已领取输入；已提交工具继续按原业务身份查询，未提交调用留待升级后恢复，不为升级制造模型失败或重新创建调用身份。中心暂停向该运行唤醒或交付下一批。后台整理取消模型请求，保留已提交分片，未提交内容按原 claim 恢复。所有停止、续租与进程清理沿用既有 fencing。

daemon 汇总所有已发现的 Worker、watchdog、agent-host、Runtime 与持久登记后代，逐一核实进程身份和退出，停止账本写循环并关闭数据库后才报告 ready；节点数据根目录的启动锁覆盖最后核查与禁止新进程之间的竞争。ready 仅开放查询、取消和退出管理入口，新来的业务命令返回可重试的 `node_upgrading`，不写入已关闭账本、不生成持久成功 ACK，中心保留原 outbox。本地未 ACK 报告已经完整持久化时允许离线准备，不能为了拿到中心 ACK 丢弃数据。Windows 依旧受现行回收边界限制，无法确认的进程保留为阻挡项，由用户处理或取消准备。

ready 后退出旧 daemon，取得独占升级锁并做设备一致备份。目标版本从新目录启动，使用原 `--data-dir`、Runtime 凭据目录和启动配置，校验目标预检记录、备份与所有登记进程，再进入 migrating。启动入口由用户或现有服务管理器切换为新目录的明确可执行路径；不在旧目录就地覆盖，不要求 Windows 使用符号链接。保留旧安装目录至确认升级成功，清理由用户显式发起。

migrating 中断后以库内版本继续，syncing 失败时保持本地暂停。节点完成兼容检查、重新认证（如有需要）、原结果补报及同步后，先持久 completed 意图，本地执行仍保持暂停；中心确认同步与完成状态后返回回执，节点持久解除门禁再开放执行。丢失完成回执时重复查询原状态；中心仍保留该节点未完成升级记录，不能因重连或旧报告覆盖而提前派发。Worker 的升级恢复路径按持久状态继续队列，不能借用会撤回旧 queued 的显式 resume 流程。

错误使用固定码：`upgrade_conflict`、`upgrade_busy`、`upgrade_backup_required`、`upgrade_migration_failed`、`storage_version_unsupported`、`migration_checksum_mismatch`、`node_upgrading`、`node_version_incompatible`。状态读取失败明确返回错误，不报告 ready 或 completed。

prepare 之前升级未支持该能力的 daemon 时，由发布说明要求停服并确认全部进程退出，再由目标版本执行检查与迁移；不把旧版未知能力当成已经停止。首个发布版即应包含准备与格式检查机制，使下一次升级可沿本流程执行。

### 备份与恢复

备份描述文件记录源发布版本、数据格式、备份时间、包含范围与校验值，不写凭据正文。中心使用 PostgreSQL 一致备份；设备在全部写入者退出并持有升级锁后复制私有数据目录，连同存在的 WAL、相关配置和完整输出保存。原生会话与 provider 配置可能在数据目录之外，按各 Agent 的真实存储位置列入清单；有其他 CLI 写入共享存储时先停止写入或明确该范围未备份。模型凭据单独按原目录权限保管，不混入发布归档。

备份是用户明确执行升级时生成的恢复材料，记录位置与保留方式；用户要求清理时直接删除指定备份。恢复前保留足以判断备份后派发与外部执行事实的记录，不把旧进程 PID 直接当成现存实例。

普通升级期间产生的备份默认仅用于恢复新执行开放之前的状态。开放业务之后恢复旧快照，必须按数据恢复操作处理：先停止相关中心或节点执行，说明数据回退范围，再核对对端持久命令、接收证据、原生会话和进程身份。可能已经派发的输入不因备份里仍为 queued 而再次发送；证据不足标 unknown，等待员工处理。恢复后不从旧快照自动启动 Project 或继续待发命令。

中心从旧备份恢复时，注销旧员工会话并使所有恢复出的设备凭据失效，由员工重新登录、核对设备并授权；节点单独恢复时继续接受现存中心的吊销与凭据版本判定。签名密钥与数据库配套保管；密钥缺失时明确报告需要重新授权，不能悄悄生成新密钥后伪装正常恢复。隔离的恢复演练先不接真实设备，以本地替身验证历史、记忆和证据，再验证显式授权后的连接与同步。

### 验证

发布元数据已有实际开发/发布 bundle 回归、匿名 HTTP 读取与凭据不变检查，以及拒绝重新贴标和元数据篡改的工具测试；macOS arm64 已验证 SEA 搬迁、实际子进程诊断与最终归档解包复验，其他发布平台未验证本次元数据实现。持久格式基线的重复打开、SQL/摘要篡改、未知与更新版本拒绝已有包内测试；PostgreSQL 还验证迁移顺序与事务失败回滚。增量迁移链、中途中断和升级准备的跨库恢复仍为 planned。自动化只使用本机数据库、进程替身和离线录制；已有发布测量不替代新增验收。

| 需求 | 设置与观察 | 失败条件 | 位置 |
|---|---|---|---|
| RL-02、03 | 对比归档、程序与子进程元数据，模拟不同平台检查结果 | 版本被重新贴标、未测写成通过、已接受限制被抹去 | 构建与归档工具单测 |
| RL-05、06 | 本版与上一发布版协议录制、超窗口和能力缺省 | 支持组合失效、不兼容时仍写入、未知能力开启 | 协议回放与 Gateway 集成 |
| RL-04、07、08 | 各类发布格式夹具，迁移前后中断、摘要变化、JSON 版本变化与提交不确定 | 身份/intent/ACK 丢失、半提交、重复迁移或业务重放 | PostgreSQL 与各账本包内集成 |
| RL-10～14 | 模型与进程替身控制当前 Turn、queue、Project 保存屏障、后台取消及清理回执 | 新执行越过准备状态、队列被清空、只停 daemon 即报告 ready、重启绕过暂停 | batond 与 Worker 确定性集成 |
| RL-08、09、13 | 一条本地跨 app 升级链路，保留活动 Thread、队列与未 ACK 报告，重启新程序 | 原输入重发、结果重复、数据缺失、同步前执行 | e2e，RL-A02 |
| RL-12、14、16 | 搬迁安装包、Windows 被占用文件与进程、部分库迁移、旧程序回切 | 就地覆盖、未核实回收即就绪、旧程序写入未知格式 | 目标系统安装包检查与包内进程替身 |
| RL-15、16 | 配套备份恢复、备份后存在执行或凭据变化 | 恢复旧权限、自动重发可能已执行输入、未知状态被当成未执行 | 本地恢复演练，RL-A08 |
| RL-17 | 实际版本与诊断关联，敏感属性及导出失败 | 正文泄漏、缺失成本虚报为零、导出阻塞业务 | telemetry 包内测试，RL-A09 |

## 测量结果

macOS 与 Linux 数值来自发布工作流 run `40186351668`（源码提交 `3eba953`），使用官方 Node 26.11.1 与 GitHub 托管 runner，原始构建产物未重新复核。Windows 数值来自 Windows Server 2022 本机的当前源码与 Node 26.11.1，不替代 Windows Server 2025 runner 验证；复现方法见 [Worker 启动与 FULL 账本测量](../../tools/README.md#worker-启动与-full-账本测量)。

### FULL 同步账本

测量驱动在独立 Node 进程中运行由源码构建的真实 `makeWorker` 串行队列，预热 200 次后交替执行 2000 次 `records.add/remove`，每次事务后让出事件循环。测量包含实际账本、提交 token 核查与状态队列，COMMIT、完整队列操作和事件循环延迟分别统计。该项与 SEA Worker 冷启动分别执行，驱动源码应与安装包提交一致。

| 系统与 runner | COMMIT p99（ms） | COMMIT 最大（ms） | 队列操作 p99（ms） | 事件循环 p99（ms） |
|---|---:|---:|---:|---:|
| macOS arm64，`macos-15` | 0.528 | 3.984 | 1.445 | 3.019 |
| Linux x64，`ubuntu-24.04` | 0.579 | 5.694 | 1.297 | 2.480 |
| Linux arm64，`ubuntu-24.04-arm` | 0.467 | 3.985 | 0.855 | 1.544 |
| Windows x64，Windows Server 2022 本机，受限 Administrator 令牌 | 5.647 | 86.447 | 6.031 | 6.038 |

四个已测平台在此负载下 COMMIT p99 低于 50 ms，Windows 最大值仍超过 50 ms。测量使用 WAL、`synchronous=FULL`、`fullfsync=0`，未做断电验证；负载不含 Agent、IPC、prompt、输入 intent 或大队列，无法据此推断全部命令接收延迟。当前测量工具在 COMMIT p99 超过 50 ms 时非零退出；若测量或实际命令接收延迟超标，需提前评估将账本移入 `worker_threads`。

### SEA Worker 冷启动

完整安装包搬到临时目录，每平台启动 100 个新 Worker，每次使用新 Thread 与 SQLite 文件，空 PATH、临时 HOME。计时从真实 Host 的 spawn 前开始，到外部调用方收到最终认证 status 为止，包含就绪轮询、启动锁释放和 status 往返；Host 总耗时另包含数据目录与令牌准备。

| 系统 | spawn 到认证 status p99（ms） | spawn 到认证 status 最大（ms） | Host 总耗时最大（ms） |
|---|---:|---:|---:|
| macOS arm64 | 1201.209 | 1323.326 | 1357.314 |
| Linux x64 | 895.012 | 945.773 | 950.690 |
| Linux arm64 | 754.205 | 996.420 | 1000.820 |
| Windows x64 | 未测 | 未测 | 未测 |

macOS 与 Linux 的全部样本低于 3 秒，每次确认 SIGTERM 后 Worker、watchdog 退出与锁释放。Windows 尚无当前实现的冷启动样本。记录覆盖独占锁、实际 SQLite 建表、空账本恢复调度、该提交的 Agent 接入模块加载与 watchdog；当前构建检查强制 Worker 运行时依赖图隔离 SDK 和 host 实现，表中数值仅适用于所标明的测量提交。

系统页缓存未清空，macOS runner 为虚拟化 Apple M1。就绪状态为 `agent_ready=false`，测量没有打开 Agent 会话，也未覆盖已有大量命令或 intent 的恢复耗时。

### Cursor 加载证据

固定公开包为 `@cursor/sdk@1.0.35`，要求 Node `>=22.13`，安装禁用生命周期脚本。可行布局为完整 SDK、生产依赖与平台包旁置，由 SEA `createRequire` 加载。macOS arm64 的 SDK、SQLite store、tree-sitter/Bash 原生扩展、ripgrep 与 sandbox helper 帮助检查已有通过记录；移走附带依赖时能明确失败。

Linux arm64 的 SDK、store、tree-sitter 与 ripgrep 已有通过记录；Debian 12 / glibc 2.36 无法加载要求 `GLIBC_2.39` 的 sandbox helper，该组合的完整安装包检查失败。Linux arm64 的 Cursor helper 要求 glibc 2.39+。Ubuntu runner 的测量结果与 Debian 12 的 helper 失败分别属于各自环境，不能互相替代。Fedora 43 的本地加载证据待补。

Windows Server 2022 本机通过四个 Agent 与原生模块加载，以及 Cursor store、ripgrep、sandbox helper 的独立检查，完整安装包检查待在当前实现上复验。Linux x64 的安装包检查已有通过记录；其 Cursor store、ripgrep 与 sandbox helper 的独立检查尚缺可核实的运行结果，不能由模块导入成功推断它们全部通过。Cursor 来源与加载方案的限制见 [SDK 说明](../../third_party/cursor-sdk/README.md)。

## Windows 待修与待验证

Windows 私有目录不设置或校验 ACL，沿用数据目录继承的权限。默认数据目录 `%USERPROFILE%\.baton-ts` 和临时目录都在用户目录下，Windows 默认只授权当前用户、SYSTEM 与 Administrators；把数据目录放到其他用户可读的位置时，由设备用户自行负责权限。Worker 准备因此不再启动 PowerShell 或 `icacls`，Project Runtime 读写凭据也不再启动子进程。

Windows 本机上节点、中心与 Runtime 测试全部通过，统一构建（含 SEA）成功。测试配置在 Windows 上把超时放大 4 倍、同时运行的测试文件限为 2 个；4 个靠重命名仍被打开的目录来构造祖先替换的测试在 Windows 上跳过，因为系统拒绝这种重命名。全量运行时 Worker 的一个 TestClock 竞争测试偶发失败，单独运行通过。完整安装包检查、冷启动与 FULL 测量和 Windows 进程检查（`Grandchild missing before taskkill`）待验证；Windows Server 2025、普通本地用户的完整 workspace 测试与实际 PID 复用也待验证。

[Windows 进程脚本](../../tools/verify/windows-processes.mjs) 使用自有的 CIM 校验与 `taskkill` 包装，观察完整父子孙树、故意过期的创建时间，以及中间父进程退出后的孙进程。它检查系统机制，未调用生产 reaper，不强迫系统实际复用 PID，也不验证 Worker 崩溃到下一次启动之间的回收延迟；非 Windows 输出 `not-measured`。

第一版的 Windows 平台边界为：`taskkill /T` 可能漏掉中间父进程先退出后的后代；Worker 崩溃后 Agent 可能运行到下一次 Worker 启动；CIM 身份核对与终止之间存在竞争窗口。私有目录沿用数据目录继承的 ACL，不做 DACL 与 reparse point 检查；命名管道使用 Node 默认安全描述符，依靠私有令牌认证。实现与恢复约束见 [平台实现](../../apps/batond/src/platform/README.md) 与 [进程回收设计](../agent-adapters/TECH.md#进程组与停止回收)。

## 第一版之后

| 项目 | 条件与范围 |
|---|---|
| Windows Job Object 与逐句柄 DACL 检查 | 通过专用原生模块接入平台层，补足回收与文件访问边界 |
| Windows 命名管道限定当前用户 | 通过原生安全描述符设置收紧访问范围 |
| 包内编译升级到 TypeScript 7 | 当前包内编译器为 TypeScript 6.0.3；Vite+ 已使用 TypeScript Go 检查 |
| Worker 账本移入 `worker_threads` | 按实际测量决定；若 FULL 提交 p99 或命令接收延迟超标，提前处理 |
| 跨设备输出与控制延迟、容量压测阈值 | Baton 验证表 R-16、R-24 与 Q5 的负载阈值留待第一版之后；500 台设备、100 个执行中 Thread、24 小时是待测场景，当前无容量达标结论 |
