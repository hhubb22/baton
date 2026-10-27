# 打包与发布技术设计

Status: partially implemented
Basis: [发布行为规格](PRODUCT.md) RL-01～17；[Baton TECH](../baton/TECH.md)；[Agent 适配 TECH](../agent-adapters/TECH.md)；[构建与发布工具](../../tools/README.md)。

打包、发布元数据、公开版本查询、连接版本核对、检查、测量、平台边界、持久格式基线、中心恢复后处理、本地升级预检、准备、离线迁移与完成同步记录现行实现；增量格式迁移和自动安装入口切换尚未实现，安装入口由用户或服务管理器显式切换。凭据闲置过期与重新认证由 Baton TECH 负责，本设计引用其结果。

## 打包与发布

中心使用 Node 26 运行 esbuild bundle；设备端使用携带 Node 的 SEA 安装包。发布目标为 macOS arm64、Linux x64、Linux arm64 和 Windows x64。开发与验证命令见 [AGENTS.md](../../AGENTS.md)，各脚本参数见 [tools/README.md](../../tools/README.md#构建打包与发布)。

| 产物 | 内容与运行方式 |
|---|---|
| 中心 bundle | `apps/server/dist/server.cjs`，相邻的 `web/` 与 `migrations/`；构建自动生成网页并复制根目录的 SQL 迁移 |
| 中心镜像 | `node:26-bookworm-slim`，包含中心 bundle、网页与迁移；由非 root 的 `baton` 用户在专用数据目录运行，配置见根 README 与 `compose.yaml` |
| 节点开发 bundle | `apps/batond/dist/batond.cjs`；通过已安装的 Node 与 workspace 依赖运行，Project Runtime 与 watchdog 通过同一 bundle 的子命令启动 |
| 节点安装包 | `batond`（Windows 为 `batond.exe`）、旁置 `node_modules/`、`licenses/`、`package.json`、`package-manifest.json` 与 `INSTALL.md`；设备无需另装 Node |
| 发布归档 | `baton-<带 v 前缀的版本>-<平台>.tar.gz`（Windows 为 `.zip`），附 SHA-256 文件和安装包检查 JSON；归档内另有 `release.json` |
| 桌面客户端 | `baton-desktop-<版本>-darwin-arm64.dmg` 与 `baton-desktop-<版本>-win32-x64.exe`，附 SHA-256；Electron 应用的 `resources/batond` 内含完整 SEA 安装包 |

[统一构建入口](../../tools/build.mjs) 从根 workspace 安装锁定依赖，检查网页类型，构建中心与节点 bundle，再生成 `bin/` 安装包。[节点打包器](../../tools/package-batond.mjs) 使用支持 `--build-sea` 且保留 LICENSE 的官方 Node 26，默认使用执行脚本的 Node；也可通过 `--node` 指定目标平台的官方 Node。跨系统构建由宿主 Node 将 bundle 注入目标可执行文件，目标平台依赖必须已安装。macOS 安装包必须在 macOS 上完成 ad-hoc 签名；最终检查与归档在目标平台运行。

SEA 不启用 code cache 或 snapshot，`execArgvExtension` 设为 `none`。Worker、watchdog、agent-host 和 Project Runtime 都通过自身可执行文件的子命令启动，Runtime 业务代码包含在同一 bundle 中。Runtime stdio 使用 `BATON_PROJECT_RUNTIME_TRANSPORT=stdio`，Runtime 在自身进程内读写凭据。

### 依赖与许可

完整 `@cursor/sdk` JavaScript、生产依赖与当前系统及架构的平台包放在可执行文件旁的 `node_modules/`，由 SEA 通过 `createRequire` 加载。`@napi-rs/keyring` 及其平台原生模块同样外置。Pi 的 `pi-ai`、`pi-agent-core` 保留磁盘上的 ESM 文件、模型数据与 OAuth 动态模块，构建时解析入口，SEA 运行时从附带目录加载。

[依赖复制器](../../tools/package-dependencies.mjs) 沿已安装的生产、peer 与可选依赖图复制物理文件，按目标系统、架构及 glibc 筛选平台包；相同依赖提升复用，冲突版本保留在调用方自己的 `node_modules/`。必需依赖缺失时直接失败。节点打包器不下载 Node 或依赖，产物不依赖源码目录或 pnpm store 链接。

`package-manifest.json` 记录 SEA 格式、目标平台、架构、Node 版本、附带依赖的名称、版本与相对路径，以及已打入 bundle 的包。`licenses/` 包含 Node LICENSE、t3code LICENSE、依赖包提供的许可声明和 Cursor 来源说明。Cursor 的包来源、integrity 与分发条款见 [Cursor SDK](../../third_party/cursor-sdk/README.md)。

### 桌面安装包

`tools/package-desktop.mjs` 核对 batond 的实际 SEA 版本与 `release.json`，将同一版本的完整安装目录复制为 Electron 资源。main 与 sandbox preload 由 esbuild 生成 CJS；禁用 Electron 原生依赖重建，内置 batond 的原生模块继续由独立 Node SEA 加载。macOS 应用使用临时签名并跳过内置 batond，Windows 使用按用户安装、无需提权的 NSIS。依赖安装与 Node 自动化测试不下载或启动 Electron；显式打包可通过 `ELECTRON_MIRROR` 获取运行时。

macOS 27.2 arm64 上已使用官方 Node 26.11.1 的统一构建产物和 Electron 44.5.1 生成开发版 DMG 与 SHA-256，核对应用及内置 batond 的 `codesign --verify`，从 DMG 复制到用户应用目录后启动显示本地接入说明页。说明页不暴露 `batonDesktop` 或 Node `require`。打包后的 `resources/batond` 与输入安装目录逐项比较一致，安装副本的 Agent host 离线模块探测通过。Windows NSIS、真实中心接入、登录启动和客户端崩溃后的 Windows 进程回收未做手动验证；网页桌面接入尚未实现。

### 官方 Node 输入

[Node 缓存工具](../../tools/release/cache-node.mjs) 仅在显式指定 `--download` 时通过 HTTPS 获取 nodejs.org 的官方归档与 `SHASUMS256.txt`，校验 SHA-256 后解包，并保留 LICENSE。缓存根目录可通过 `BATON_NODE_CACHE` 覆盖；离线输入缺失时给出下载命令。工具未核验发布者的离线签名。

已有 Node 26.11.1 归档校验记录如下，缓存操作用法见 [官方 Node 缓存](../../tools/README.md#官方-node-缓存)。这些记录不表示其他环境中已存在相应缓存。

| 官方归档 | SHA-256 |
|---|---|
| `node-v26.11.1-darwin-arm64.tar.gz` | `d916511b55965e91be7a88e17f88d895b6793ceaba3e6c9b194aefe51c2c65ac` |
| `node-v26.11.1-linux-arm64.tar.gz` | `170454fb022f5e9b5f6cc76c25fa32ef5100895be44eb04e92f9780591491bbf` |

### 发布流水线与归档

[发布工作流](../../.github/workflows/release-packages.yml) 由 `workflow_dispatch` 接收带 `v` 前缀的版本号，在 `macos-15`、`ubuntu-24.04`、`ubuntu-24.04-arm` 与 `windows-2025` 上原生构建，固定 Node 26.11.1 和 pnpm 12.11.2。Linux 执行包含本地 PostgreSQL 的工作区测试与中心构建；macOS、Windows 执行节点、Project Runtime 与桌面客户端的 Node 离线测试。自动化验证使用离线转录、本地替身与本机资源。

每个平台依次执行安装包构建、搬迁检查、100 个 Worker 冷启动样本与 2000 次 FULL 账本操作，Windows 另执行进程机制检查，然后归档并验证解压产物。macOS 与 Windows 随后生成桌面安装包和 SHA-256。安装包、构建与检查 JSON、测量结果和测试日志作为工作流产物上传，不上传 Electron 解包目录。Windows 节点与 Runtime 测试步骤允许失败后继续打包；安装包检查失败仍会阻止后续测量与归档。工作流上传产物，不自动创建 GitHub Release。

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

发布元数据、只读查询、连接版本核对、中心恢复后处理、本地升级预检、准备、离线迁移与中心完成同步已实现；增量格式升级和自动安装入口切换仍待实施。存储基线与摘要校验见「持久格式与迁移」，中心恢复后处理见「备份与恢复」，本地升级入口见「设备准备与切换」。首版允许人工停止和切换程序，升级入口负责状态、迁移与检查；安装包由管理员或设备用户取得，不在进程运行时覆盖旧目录。

### 模块职责

| 位置 | 当前职责与未实现部分 |
|---|---|
| `tools/package-release.mjs`、`tools/lib/installation.mjs` | 归档、SHA-256、搬迁复验与发布身份一致性校验 |
| `apps/batond/src/daemon/upgrade-check.ts`、`upgrade-migrate.ts`、`upgrade-backup.ts` | 只读预检目标包、中心兼容性、本地格式与备份空间；离线持锁备份、校验并逐库核验或初始化；首版无增量格式迁移 |
| 中心与节点构建入口、`packages/protocol` | 将同一份发布版本和提交注入各进程；声明协议、数据格式与升级能力 |
| `apps/server/src/database.ts`、`migrations/` | 在现有事务 advisory lock 内核对已应用 SQL 的 SHA-256 和文件顺序，再执行剩余迁移 |
| `apps/batond/src/{daemon,worker,project}/ledger.ts`、`src/storage-format.ts` | 各自声明基线 SQL；在业务解码与写连接打开前核对格式类型、版本和迁移摘要，仅为空库初始化基线 |
| `apps/batond/src/daemon` 与 `src/project` | 持久升级准备状态，协调节点命令、所有 Worker 与前后台 Runtime，不以 daemon 退出代替回收确认 |
| `packages/sqlite` | 保留 WAL/FULL、提交 token 核验、独占迁移与备份所需能力；不解释各账本业务 JSON |
| `packages/telemetry` | 已有 Effect OTLP/HTTP 导出、过滤与时限；Baton R-23 的版本、原因、结果与成本关联尚未实现 |

### 发布元数据与连接

中心与节点构建入口、统一构建和 SEA 打包都接受 `--version <带 v 前缀的发布版本> --commit <完整小写 Git 哈希>`，两个参数一起指定；未指定时版本和提交均为 `development`。构建通过 esbuild 编译常量注入身份，不从运行环境变量读取版本。`packages/protocol/src/release.mjs` 是共享来源，中心、daemon、Worker、agent-host、watchdog 和 Runtime 的 `--version` 及诊断使用同一份元数据。中心版本查询无需数据库配置；节点及子进程另报告 SEA 和 Node 运行信息。开发 bundle 的 Runtime 与 watchdog 从同一 bundle 启动，直接源码入口仍通过 tsx 运行。

`release.json` 和安装包清单保存 `version`、`commit`、`platform`、`arch`、`protocol_version`、`schema_version`、`ledger_versions` 和 `supported_daemon_versions`。当前协议版本为 1，中心迁移版本为 `0009_thread_activity_probes.sql`，账本 `node`、`project`、`thread` 均为格式 1。构建核对中心迁移目录的最新文件与声明一致，账本检查直接使用共享格式常量。首版仅支持当前 daemon 发布版本，连接时执行该声明的准入检查；增量迁移来源及应用回切范围尚待相应升级实现声明。包内元数据与程序输出不一致时，安装包检查和归档失败；归档器不能给旧二进制重新贴标。

发布组合按 `supported_daemon_versions` 精确匹配，首版列表为 `[当前版本]`，不计算 N−1 窗口、不解析版本范围或 SemVer。节点和中心的协议版本必须一致。双方均为 `development` 时正常连接；一方为 `development` 时也放行版本号差异，便于本地源码与发布包联调，协议版本仍须一致。Agent 的 CLI 版本、模型和系统组合继续按既有准入规则处理。

中心提供无需登录的只读 `GET /api/v1/release`，返回上述发布元数据，不返回设备、员工或部署秘密，不读取认证状态或写入设备凭据。已登录诊断的 `release` 字段与其一致。该入口不延长设备闲置期限。

节点在认证帧中上报必填的 `daemon_version` 与 `protocol_version`。中心先只读核验凭据身份和闲置期限，再调用一次版本比对；通过后才登记连接、允许 `node.sync` 及派发。拒绝返回 `auth_result`，`ok=false`、`code=node_version_incompatible`，附 `message` 和 `version_incompatibility`：双方版本与协议、`supported_daemon_versions`、固定原因 `daemon_version_unsupported` 或 `protocol_version_unsupported`、先升级中心再升级节点的指引。发送完成后通过既有 1008 关闭路径断开；不登记连接、不写业务数据、不清除 outbox，也不延长凭据闲置期限。凭据无效或过期时优先返回认证错误。

daemon 收到版本拒绝后终止本次运行，等待用户升级后重新启动，不自动重连。CLI 的结构化错误诊断保留 `node_version_incompatible`、双方版本、协议、原因和指引；本地命令、账本与待补报结果保留，独立 Worker 沿用既有生命周期。`upgrade check` 只读查询中心与本地格式，不迁移或启动 Worker；版本规则与连接握手一致，development 仅放宽版本号比较，协议仍须相同。查询使用原身份中的中心地址，GET 不携带设备凭据，不续期凭据。节点闲置过期时，实际恢复连接前先重新认证。首次准备时中心不可达则保持原版本；prepare 已持久保存该目标预检后，断网可继续本地准备与迁移，恢复业务前仍须重新核对并同步。

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

设备离线迁移已复用数据目录的 `daemon.lock` 和配置写锁，并核对登记进程与账本中的清理义务。daemon 和独立 Worker 按持久升级状态暂停业务；本地 CLI 通过认证 IPC 管理准备，离线 migrate 持锁执行。逐库核验或初始化复用正常账本的事务与提交核验，重跑依据库内元数据，不重复已提交的基线；失败后核验并保留原备份。所有库核验成功后进入 syncing，取得中心完成回执前不开放新执行。首版无增量格式迁移，强制结束进程后的跨库恢复尚未验收。

旧程序只可在清单声明的数据范围内应用回切；已发布程序都必须先检查格式再打开业务写入口。默认不提供 down migration。需要不兼容变更时提供前向修复或一致备份恢复说明。

## 升级执行与恢复

### 中心

管理员停止旧中心及使用同一数据库的管理写入，取得 PostgreSQL 一致备份，保存相应签名密钥、数据库迁移版本、发布版本与部署配置。备份成功后，使用新版本已有的 `migrate` 入口执行并核验迁移，再运行 `serve`；`serve` 自带的迁移检查仍然保留。现有单活动中心约束继续适用。

迁移期间不监听业务端口，节点按既有策略退避。Thread 在设备上继续执行、持久保存结果；Project 前后台 Runtime 按租约和保存屏障结束，不将本地未保存输出当作已完成事实。服务启动后先验证数据库、静态资源和发布元数据，节点重新连接同步，原 ID 的 outbox 继续派发与去重。重连后的闲置状态按 Baton R-02 判断，中心停机超过期限时仍需重新认证。

数据库事务失败时回滚本次未完成迁移，中心继续停服。应用回切前，先在数据库副本上用拟回切程序和它配套的 `migrations/` 运行 `migrate`，确认当前库的版本与迁移摘要受该程序支持；该命令也会执行程序支持的未应用前向迁移。正式回切仍保留启动校验。遇到 `storage_version_unsupported` 或 `migration_checksum_mismatch` 时停止回切，不修改元数据绕过校验，也不运行旧程序写业务数据；只能前向修复，或由管理员显式选择停机恢复配套备份。恢复前说明将丢失的备份后数据并取得执行者确认，不能将程序文件回切视为数据库回滚。

### 设备准备与切换

本地升级入口均支持 `--data-dir`。`prepare`、运行中的 `status` 和迁移前 `cancel` 通过现有认证 IPC 交由 daemon 处理；daemon 已退出或处于离线迁移阶段时，`status` 直接读取私有状态和账本事实。`check` 是只读 CLI，`migrate` 是目标程序的离线 CLI，复用节点锁、配置写锁与进程登记。首次 prepare 需要中心在线，已记录的同一目标准备和本地迁移可离线继续。

| 入口 | 作用 |
|---|---|
| `batond upgrade check --package <目录>` | 只读验证安装包、实际版本、格式范围、当前中心兼容性及剩余空间，返回可执行与失败原因 |
| `batond upgrade prepare --package <目录>` | 复用 check 完整预检，以持久 operation_id 登记源/目标与预检结果；同一路径、版本和构建身份复用当前准备，不同目标返回 `upgrade_conflict` |
| `batond upgrade prepare --version <中心版本>` | 读取保存中心的公开发布信息，要求精确匹配当前中心版本与其支持范围，记录中心协议并检查备份空间；目标包尚未安装时只登记版本与 draining，不写 checked_release |
| `batond upgrade prepare --package <本应用resources/batond> --self` | 无 daemon 时持原锁先保存暂停，再核对当前程序、目标包、已记录的中心协议、本地格式与备份空间，绑定同一操作的安装目录；不启动业务或结束现存进程 |
| `batond upgrade migrate` | 首次仅在 ready 且 daemon 已退出时，由预检目标程序持独占锁备份并逐库核验、初始化；成功写 syncing 后退出，重跑依据库内事实继续 |
| `batond upgrade status` | 返回持久状态、阻挡的 Thread/Runtime、进程 PID 与创建时间，以及账本内待确认报告数；无 daemon 时持原锁重查并推进 draining 到 ready，检查失败显示阻挡原因 |
| `batond upgrade cancel` | 迁移前持久写入 `cancelled` 并解除门禁，恢复保留的队列；无 daemon 时持原锁保存取消，由正常启动继续队列，不自行启动进程或调用 resume。迁移开始或迁移失败后拒绝取消 |

check 读取目标 `release.json`，实际执行该目录的 `batond --version` 并核对完整发布身份；以 SQLite 只读连接核对三类账本格式及基线摘要，要求目标 `ledger_versions` 与实际支持格式一致。查询当前中心 `GET /api/v1/release` 核对版本与协议，再按备份目标文件系统的可用块估算完整目录副本空间，包含目录分配开销及 1 MiB 状态、清单余量。TLS 可复用现有 `--ca-file`；prepare 使用 daemon 已配置的 CA。check 不建立基线、不写升级状态、不启动或停止业务；SQLite 读取时可能建立 SHM 和空 WAL 辅助文件，主库、已有 WAL 内容及业务事实保持不变。

状态位于数据目录的私有原子文件 `upgrade.json`，包含 `operation_id`、`source_version`、`target_version`、`phase`。完整预检后附目标 `target_path` 与 `checked_release`；按中心版本准备时先记录 `target_protocol_version`，不记录尚未安装的路径或伪造目标包预检。self 只可绑定相同目标版本、协议和构建，允许同一构建迁入新应用目录；原 operation ID、阶段及备份保持不变。迁移取得一致备份后附 `backup_path`、`backup_checksum`；失败附 `error_code` 和 `reason`。传统准备的源版本取运行程序的 `BUILD.version`；直接 self 准备优先沿用既有完成记录的目标版本或原准备的源版本，缺少证据时记录 `unknown`。未注入发布身份的开发程序显示 `development`。持久阶段为 `draining`、`ready`、`migrating`、`syncing`、`completed`、`cancelled`、`failed`。状态读取失败返回 `upgrade_state_invalid`，执行保持暂停。

prepare、status、cancel 成功返回 `{ state, blockers, pending_reports }`，migrate 返回 `{ state }`。已有 daemon 时普通准备、查询与取消通过原认证 IPC 串行执行；版本准备沿用 `upgrade_prepare`，其字符串 payload 携带版本对象，原路径 payload 保持有效。无 daemon 时 CLI 在原 `daemon.lock` 内执行管理，不依赖 WSS 认证，因此旧 daemon 被中心拒绝后仍可按中心版本准备。旧程序自身协议与新中心不同不阻止版本准备；self 将实际目标协议与已保存的中心协议核对。直接 self 没有中心协议记录时，后续 syncing 认证校验协议后才开放业务。self 不连接中心，也不启动普通 daemon、Worker、Runtime 或进程回收。原锁被外部服务或迁移占用时 self 返回 `upgrade_busy`，不接管或终止占锁者。版本准备与 self 检查空间，已有备份的 self 重试不重复要求新副本空间。

无 daemon 时 status 在原锁内重查持久事实，并取得身份、目录和执行配置写锁后再次核查才写 ready；持久报告已完整落盘时无需中心 ACK。启动时已经 draining 的 daemon 仅保留升级管理并轮询就绪，不打开业务数据库或恢复、回收原进程。运行中发起准备的 daemon 仍先完成原业务 Scope 的退出；准备期间中心版本拒绝不把本地 draining 改为失败。self 的新准备先保存暂停，再读取旧账本；未知格式、损坏或核验失败保留暂停与原数据。失败以 stderr JSON 返回固定码和详细原因，可再次准备或查询。

Thread 的新 open、message、resume、answer 通过原有节点账本与 Worker 回执持久接收。draining 允许启动只负责接收和保存队列的 Worker，以继续处理 stop、withdraw；其原生会话创建、恢复和回合执行都受门禁限制。Worker 自己在执行调度和下一轮 intent 前读取同一门禁，当前回合自然结束；空闲 Worker 在串行队列中停止新调度，再由 Scope 关闭会话、agent-host、watchdog 和 SQLite。排队输入及原生命令身份保留，取消后继续调度。Project 前后台启动和唤醒保存在 `project-runtime.db` 的 `project_commands` 中；后台整理沿用既有取消与清理，前台完成当前响应后在下一次 `claim_inputs` 前退出，已保存历史和未领取输入保留。stop、withdraw、结果补报和清理在 draining 期间继续。

daemon 只读检查 Worker/启动锁、Thread 活动事实、Runtime 运行和进程记录；存活、未知或未确认清理都阻止就绪。全部检查通过后关闭业务 Scope，等待已有控制请求、Runtime、watchdog、设备操作及数据库关闭，再次检查持久事实才写入 `ready`。本地未确认报告保留，不要求中心 ACK 才能就绪。ready 仅保留认证升级管理和受限中心连接，不开启业务数据库；本地新业务返回 `node_upgrading`，中心 Thread 来令使用连接级同码错误，保留中心 outbox，不发送会被当前中心解释为最终失败的否定接收回执。取消 ready 会重新打开业务 Scope，继续原队列。

migrate 校验当前运行程序、目标包与已保存预检的发布身份一致，持有 `daemon.lock` 及身份、浏览目录和执行配置的原有写锁，再核对所有登记进程。将私有数据目录复制到旁边的 `<目录名>.upgrade-backups/<operation_id>-<随机 ID>/data/`；保留身份、业务、SDK 状态、完整输出与 WAL，仅排除 IPC 和已知进程锁。备份目录使用现有私有目录权限，小型 `backup.json` 记录操作、源目录和目录内容 SHA-256，完成复制后比较源与副本摘要。符号链接、特殊文件或无法确认的进程会阻止迁移。数据目录以外的原生会话与模型凭据仍按「备份与恢复」单独保护。

备份位置和摘要随 `migrating` 一起原子写入状态，再逐库调用现有存储初始化与事务核验；首版只有格式 1 / `0001_baseline`，无增量步骤。成功进入 `syncing`；失败保存 `upgrade_migration_failed` 并保持暂停。重跑核验原备份并依据各库实际格式继续，保留同一备份，不用外部进度跳过库，不自动恢复备份。migrating 或 syncing 缺少完整备份记录时拒绝继续。安装入口仍由用户或服务管理器显式切换，目标 daemon 启动后继续中心同步与完成确认。

| 阶段 | 行为与恢复依据 |
|---|---|
| `draining` | 禁止开始新执行；等待当前工作结束、后台停止、结果落盘及进程退出 |
| `ready` | 所有执行与登记进程清理已确认，数据库已关闭；daemon 保持管理入口，用户可正常退出它 |
| `migrating` | daemon 已退出，目标版本持独占升级锁并检查备份后逐库迁移，业务启动保持关闭 |
| `syncing` | 本地格式检查通过，业务执行保持暂停；受限连接完成认证、初始同步与结果补报，再请求中心确认 completed |
| `completed` | 中心先记录并回执，节点再原子保存 completed；当前 daemon 重新打开业务 Scope，按持久队列恢复执行，保留最后一次升级结果 |
| `cancelled` | 迁移前取消准备并确认原程序仍可读取数据，清除门禁后恢复调度；保留操作结果 |
| `failed` | 保留错误码、原因、备份与各库实际格式；保持暂停。迁移失败可重跑 migrate，迁移前失败仍可取消 |

阶段上报协议在 `packages/protocol` 声明，支持 `draining`、`ready`、`migrating`、`syncing`、`completed`、`cancelled`、`failed`。普通能力报告包含 `upgrade_protocol=1`；`node.upgrade_state` 只上传 `operation_id`、源/目标版本和阶段，不上传安装路径或原始失败诊断。daemon 读取已经原子保存的 `upgrade.json`，按现有心跳间隔重报未确认状态；初次连接和重连均重报当前状态。回执 `node.upgrade_state_result` 必须匹配原 operation ID、阶段、消息关联 ID 且 `ok=true`，否则继续重试。ready、migrating、failed 的受限连接也上报，不打开业务数据库；syncing 只重开节点结果账本用于补报。离线期间可以跨过中间阶段，中心接受首次直接上报 ready、syncing 或 completed。

中心在现有 Node、Credential、Presence 来源校验与事务中保存 `node_upgrades`，每个操作记录绑定设备、源/目标版本、当前阶段和已确认阶段；最近创建的操作是该设备当前操作。同一操作、同一阶段重投返回原回执，迟到回执不改变当前阶段；同 ID 改变设备、源/目标版本或提交未确认过的回退阶段返回 `upgrade_conflict`。migrating 及之后的已确认阶段禁止取消；迁移失败后允许同操作继续 migrating、syncing 或 completed，completed 不回退。普通能力报告和状态同步不修改升级记录。当前认证连接上报新 operation 时以新操作为准，允许离线取消旧操作后立即准备新目标；已记录旧操作的迟到报告只能重取原阶段回执，不能覆盖新操作。节点视图提供当前操作、版本和阶段，设备页显示 `Waiting for upgrade`、`Upgrading` 或 `Upgrade paused`，不暴露本地路径。没有声明该能力的组合仍按人工停机流程处理。

中心保存 draining、ready、migrating、syncing 或 failed 后，停止领取该节点的 open、message、resume、Project 前台/后台启动和新输入唤醒，不向该节点放置新的 Project 运行。持久 outbox 和输入保留，等待中的新执行不阻挡后面的 stop、withdraw；结果回执、有效运行续租和必要清理继续处理。中心确认 completed 或 cancelled 后恢复领取。已在途的启动或消息仍可落盘接收，本地门禁阻止新回合；接收 ACK 只表示持久保存。节点本地 CLI 与 Worker 自己的 queued 调度检查相同本地状态，中心离线时仍暂停新执行。

当前 Thread Turn 自然结束后，Worker 暂停在下一轮提交 intent 之前，落盘报告并关闭原生会话连接、agent-host 与自身。关闭会话连接不删除原生会话。普通升级不调用会撤回 queued 的 Thread stop；用户显式停止时继续按 R-11 撤回未发输入。Project 前台在下一持久化安全点退出：取消尚未保存的模型输出，保留已保存 assistant、工具调用、结果及已领取输入；已提交工具继续按原业务身份查询，未提交调用留待升级后恢复，不为升级制造模型失败或重新创建调用身份。中心暂停向该运行唤醒或交付下一批。后台整理取消模型请求，保留已提交分片，未提交内容按原 claim 恢复。所有停止、续租与进程清理沿用既有 fencing。

daemon 汇总所有已发现的 Worker、watchdog、agent-host、Runtime 与持久登记后代，逐一核实进程身份和退出，停止账本写循环并关闭数据库后才报告 ready；节点数据根目录的启动锁覆盖最后核查与禁止新进程之间的竞争。ready 仅开放查询、取消和退出管理入口，新来的业务命令返回可重试的 `node_upgrading`，不写入已关闭账本、不生成持久成功 ACK，中心保留原 outbox。本地未 ACK 报告已经完整持久化时允许离线准备，不能为了拿到中心 ACK 丢弃数据。Windows 依旧受现行回收边界限制，无法确认的进程保留为阻挡项，由用户处理或取消准备。

ready 后正常退出旧 daemon，从目标目录显式运行 `batond upgrade migrate --data-dir <原数据目录>`。迁移完成后以原 `--data-dir`、Runtime 凭据目录和启动配置启动目标 daemon；migrating、syncing 或 failed 时均保持业务 Scope 和独立 Worker 关闭，不能通过重新启动恢复执行。启动入口由用户或现有服务管理器切换为新目录的明确可执行路径；不在旧目录就地覆盖，不要求 Windows 使用符号链接。保留旧安装目录至确认升级成功，清理由用户显式发起。

migrating 中断后以库内版本继续，syncing 失败时保持本地暂停。目标 daemon 在受限 Scope 内打开 `node.db`，将已退出 Worker 账本中的未确认报告按原 event ID、序号和存储代次导入节点 outbox，不启动 Worker 或 Project Runtime。认证与初始同步成功、运行能力报告获得中心确认、节点 outbox 中的原报告全部获确认后，daemon 上报 completed，本地文件仍保持 syncing。中心持久保存 completed 并回执；daemon 验证匹配回执后才原子保存本地 completed，不增加完成意图字段。丢失回执时按心跳重发 completed，重连后重新同步、补报并请求相同操作的完成回执，中心幂等返回原结果。中心先完成，节点后解除门禁；此间在途业务请求仍收到可重试的 `node_upgrading`。本地保存完成后，当前进程关闭受限连接与结果账本，再由现有外层循环打开业务 Scope，无需退出或服务管理器重启。Worker 与 Project Runtime 按持久队列恢复，Worker 报告副本沿用原补报确认流程清除，不调用会撤回 queued 输入的显式 resume。

错误使用固定码：`upgrade_conflict`、`upgrade_busy`、`upgrade_backup_required`、`upgrade_migration_failed`、`upgrade_package_invalid`、`upgrade_coordinator_unavailable`、`upgrade_insufficient_space`、`storage_version_unsupported`、`migration_checksum_mismatch`、`node_upgrading`、`node_version_incompatible`。状态读取失败明确返回错误，不报告 ready 或 completed。

prepare 之前升级未支持该能力的 daemon 时，由发布说明要求停服并确认全部进程退出，再由目标版本执行检查与迁移；不把旧版未知能力当成已经停止。首个发布版即应包含准备与格式检查机制，使下一次升级可沿本流程执行。

### 备份与恢复

中心备份使用 PostgreSQL 的一致逻辑备份（如 `pg_dump`）或一致物理快照；管理员停止中心及其他管理写入后，连同原签名密钥和部署配置保存。人工记录源发布版本、数据库格式与迁移摘要、备份时间、实际包含的目录、校验值及保留位置。不提供自动备份命令或备份描述文件格式工具，秘密不写进普通清单或发布归档。

| 材料 | 位置与恢复范围 |
|---|---|
| 中心数据库 | `BATON_DATABASE_URL` 指向的 PostgreSQL 数据库，Baton schema 由 `BATON_DB_SCHEMA` 指定、默认 `public`。包含账号、设备与默认选择、Project、记忆与修订、事项、Thread 历史、命令与报告证据，以及 `schema_migrations`。备份须包含恢复所需的 pgvector 扩展及 schema 依赖 |
| 中心签名密钥 | `BATON_NODE_SIGNING_KEY` 指定的原文件，默认中心工作目录的 `node-signing.key`。与数据库配套保存，恢复原权限和所有者；缺失或无效时停止恢复后处理 |
| 中心部署配置 | 实际服务管理器、容器或启动脚本中的环境变量与配置文件，包括数据库与 schema、密钥路径、公开 Origin、监听地址、TLS 证书和私钥、反向代理配置及使用的程序版本。恢复数据库不恢复这些文件 |
| 设备私有数据 | `--data-dir`，默认 `~/.baton-ts`，Windows 为 `%USERPROFILE%\.baton-ts`。整体保留 `identity.json`、`reauth-pending.json`（存在时）、目录和执行授权配置、`node.db`、`project-runtime.db`、`threads/<Thread ID>/thread.db`、原生映射和 SDK 状态、`full-output/`，以及存在的 SQLite WAL。不能只复制主数据库文件或只保存身份文件 |
| Project 模型凭据 | `BATON_PROJECT_RUNTIME_DATA_DIR`，默认 `~/.baton/project-runtime`；保存 provider 的 OAuth/API key 文件及 `embeddings/` 中的 Embedding 凭据。它不在默认设备数据目录内，须单独保护和恢复 |
| Pi 原生会话与认证 | 默认 `~/.pi/agent`，配置了 `PI_CODING_AGENT_DIR` 时使用该目录；会话默认在其 `sessions/`，`PI_CODING_AGENT_SESSION_DIR` 可单独指定会话目录。目录与外部会话目录一并保留 |
| Codex 原生会话与认证 | `CODEX_HOME`，默认 `~/.codex`；包括 `sessions/`、`archived_sessions/`、SQLite 状态、`auth.json` 等。只恢复 Baton 的原生会话 ID 不能恢复这些内容 |
| Cursor、Kiro 及其他外部配置 | 保存启动用户的 `HOME`（Windows 为 `%USERPROFILE%`）及原生 CLI/SDK 配置明确指定的外部存储。Baton 未固定 Cursor SDK、Kiro CLI 的全部内部目录，须在实际备份清单中列出；不能确定子目录时保留完整用户配置目录和系统凭据库。Cursor 的 `CURSOR_API_KEY` 来自设备启动配置，须按秘密单独保管；跨系统不能直接复制的认证材料需要重新登录 |
| 工作目录与外部副作用 | 仓库、工作文件和外部系统由各自备份恢复，中心数据库不保存它们。恢复中心历史不会回滚已经执行的命令、文件变更或外部请求 |

设备 `upgrade migrate` 已在独占锁下自动生成并校验数据目录备份，范围与位置见「设备准备与切换」；当前没有独立的 batond 备份或自动恢复命令。人工保存或恢复设备数据前，须停止 daemon、所有 Worker、agent-host、watchdog、前后台 Runtime 及其他共享原生存储的写入者，确认它们退出，再整体复制数据与存在的 WAL。停止 daemon 不代表其他进程已退出；不满足这些条件的设备副本不能宣称为一致备份。私有目录和凭据保持原权限，Windows 的 ACL 边界见平台说明。

普通升级备份默认只恢复到新执行开放之前。业务开放后恢复旧快照前，管理员先保存当前数据与设备执行证据，列明备份之后会丢失的账号/口令和权限变化、Thread 输入与输出、Project 事件、记忆修订及事项处理范围，说明原生会话与工作目录是否同步回退，并取得执行者确认。副作用可能已在设备或外部系统发生，旧快照里的 `queued` 或零次派发不能证明没有执行。不得把旧 PID 直接当成现存进程证据。

中心恢复步骤：

1. 保持中心、相关设备执行及自动服务重启停止，保留当前数据库和执行证据。确认数据回退范围后，用 PostgreSQL 工具将配套备份恢复到隔离数据库，放回原签名密钥及部署配置，并核对目录权限。
2. 使用与备份兼容的中心程序、网页和迁移目录。配置目标 `BATON_DATABASE_URL`、`BATON_DB_SCHEMA` 与原 `BATON_NODE_SIGNING_KEY`，显式运行恢复后处理：

   ```sh
   node apps/server/dist/server.cjs admin restore-finalize
   ```

   命令沿用 `migrate` / `serve` 的迁移版本与摘要检查，不启动业务 listener。校验失败保持停服。恢复入口只读取已有签名密钥，缺失或无效返回现有 `invalid_signing_key`，不会创建新密钥；普通 `serve` 的首次安装建钥行为不用于代替恢复后处理。
3. 后处理在一个事务中注销全部员工会话，消耗旧的一次性注册/重新认证凭据，使未吊销设备凭据闲置过期并清除在线状态。设备吊销事实、原签发时间、设备 ID、注册顺序与 Thread 归属保留。签发时间晚于中心时钟时以 `conflict` 拒绝并回滚，先核对时钟再重试。
4. 缺少完成证据的旧输入标为 `unknown`，保留正文和历史。未完成 outbox 的 `next_attempt_at` 设为 `infinity`，暂停旧命令派发而不伪造完成结果；旧报告和迟到完成证据仍可沿原 ID、序号接收。冻结行不占用后续新命令的派发顺序，也不算正在恢复会话；员工显式停止或归档时可以发送新的 stop，旧输入和未知 open 保持冻结。恢复出的活动 Project 置为 `paused`，运行置为 `lost`，撤销租约；前台显示需要核对，后台 claim 释放回待处理且保留游标。重复执行后处理不会新增身份、重复派发或重复修改已处理的状态。
5. 在隔离环境核对历史、记忆和不确定执行后再运行 `serve`。员工重新登录，为本人原设备领取新的重新认证凭据，在相同设备数据目录执行 `batond reauth`，再连接同步。核对 Worker 账本、原生会话和外部执行证据，允许原结果补报；不能确认的输入继续保持未知，禁止直接重发。Project 由员工核对后显式恢复，存在不确定运行的对话还须显式重试；不要批量自动解除暂停。

只恢复设备数据时，现存中心仍按当前凭据版本与吊销记录授权，旧身份不能恢复已失效权限。中心与设备备份应配套；设备本地 token 比中心备份中的凭据更新时，先保留现场并恢复配套身份材料后核对原设备，不能删除身份自动注册或放宽旧版本证明。缺少原签名密钥时先找回配套密钥，不进入本恢复流程。

### 验证

发布元数据已有实际开发/发布 bundle 回归、匿名 HTTP 读取与凭据不变检查，以及拒绝重新贴标和元数据篡改的工具测试；macOS arm64 已验证 SEA 搬迁、实际子进程诊断与最终归档解包复验，其他发布平台未验证本次元数据实现。持久格式基线的重复打开、SQL/摘要篡改、未知与更新版本拒绝已有包内测试；PostgreSQL 还验证迁移顺序与事务失败回滚。本地升级准备已有包内测试覆盖当前回合结束、新执行暂停与输入保留、取消恢复、进程阻挡和 ready 拒绝新业务。`upgrade-migrate.test.ts` 验证只读预检、持锁备份、逐库失败重跑与启动门禁；`upgrade-report.test.ts` 和中心 `upgrade.integration.test.ts` 验证补报、完成回执重发及确认后恢复派发。`e2e/src/upgrade.integration.test.ts` 使用候选包和当前基线，经实际中心、WSS、daemon 与独立 Worker 验证 prepare → ready → 停 daemon → migrate → 重启 → completed，保留 Project、记忆、Thread、存储代次与原生会话 ID，已发送输入不重发、排队输入仅发送一次。增量格式迁移与自动安装入口切换尚未实现；进程强制中断、真实上一发布包升级及非 macOS 平台的本轮升级验收仍未测。自动化只使用本机数据库、进程替身和离线录制；已有发布测量不替代新增验收。

用户服务的 launchd 启停已在 macOS 27.2 arm64、Node 26.5.0 上用开发 bundle 验证：临时数据目录放置离线身份，中心地址仅指向本机不可用端口；`service install` 成功，`status` 显示运行、Node 的真实路径与数据目录下的日志路径，daemon 持续存活；`service uninstall` 后服务定义与 daemon 均消失，身份和日志保留。验收后已移除临时数据目录。该验证不覆盖中心注册与连接、登录自启、异常重启、SEA 安装包或 Linux systemd 真机行为。

| 需求 | 设置与观察 | 失败条件 | 位置 |
|---|---|---|---|
| RL-02、03 | 对比归档、程序与子进程元数据，模拟不同平台检查结果 | 版本被重新贴标、未测写成通过、已接受限制被抹去 | 构建与归档工具单测 |
| RL-05、06 | 本版与不同发布版、协议不符、development 混用；认证优先；拒绝后保留中心 outbox、凭据与本地命令/结果，daemon 停止重连并输出诊断 | 不兼容时仍同步或写入、拒绝后结果丢失、闲置续期或反复重连 | 中心 Gateway/PostgreSQL 集成与 daemon 本地 WSS 测试 |
| RL-04、07、08 | 当前格式基线重复打开、摘要变化、未知与更新版本拒绝，PostgreSQL 迁移失败回滚 | 身份/intent/ACK 丢失、半提交、重复迁移或业务重放 | `identity.integration.test.ts`、`storage-format.test.ts`；增量格式迁移与进程强制中断未测 |
| RL-10～14 | 模型与进程替身控制当前 Turn、queue、Project 保存屏障、后台取消及清理回执 | 新执行越过准备状态、队列被清空、只停 daemon 即报告 ready、重启绕过暂停 | batond 与 Worker 确定性集成 |
| RL-04、09、13 | 候选包基线升级保留活动 Thread、队列、Project 与记忆；补报后确认完成 | 原输入重发、结果重复、数据缺失、同步前执行 | `e2e/src/upgrade.integration.test.ts`，RL-A02；未 ACK 报告跨升级补报见 batond `upgrade-report.test.ts` |
| RL-12、14、16 | 基线逐库失败后复用原备份重跑，迁移与 syncing 期间启动 daemon、独立 Worker | 未核实回收即就绪、暂停期间执行、重跑覆盖备份或丢失队列 | batond `upgrade-migrate.test.ts`；Windows 安装切换、强制中断与实际增量格式回切未测 |
| RL-15、16 | PostgreSQL 回退旧授权与派发进度，运行恢复后处理、重新授权并补报原结果；重复运行与缺失密钥 | 恢复旧权限、自动重发可能已执行输入、历史或记忆丢失、伪造完成结果或新签名密钥 | `apps/server/src/restore.integration.test.ts`，RL-A08；设备单独恢复的凭据拒绝沿用 R-02/R-04 验证 |
| RL-17 | 实际版本与诊断关联，敏感属性及导出失败 | 正文泄漏、缺失成本虚报为零、导出阻塞业务 | 已有 telemetry 包内测试；R-23 关联尚未实现，RL-A09 未测 |

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
