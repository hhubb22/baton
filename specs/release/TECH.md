# 打包与发布技术设计

Status: partially implemented
Basis: [发布行为规格](PRODUCT.md) RL-01～17；[Baton TECH](../baton/TECH.md)；[Agent 适配 TECH](../agent-adapters/TECH.md)；[构建与发布工具](../../tools/README.md)。

本设计描述发布身份、签名更新、固定入口、持久数据迁移及失败恢复。桌面安装交接见 [桌面设计](../desktop/TECH.md)，凭据闲置过期与重新认证见 Baton TECH。验证范围按本文记录。

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

macOS 27.2 arm64 上已使用官方 Node 26.11.1 的统一构建产物和 Electron 44.5.1 生成开发版 DMG 与 SHA-256，核对应用及内置 batond 的 `codesign --verify`，从 DMG 复制到用户应用目录后启动显示本地接入说明页。说明页不暴露 `batonDesktop` 或 Node `require`。打包后的 `resources/batond` 与输入安装目录逐项比较一致，安装副本的 Agent host 离线模块探测通过。Windows NSIS、真实中心接入、登录启动和客户端崩溃后的 Windows 进程回收未做手动验证。

### 官方 Node 输入

[Node 缓存工具](../../tools/release/cache-node.mjs) 仅在显式指定 `--download` 时通过 HTTPS 获取 nodejs.org 的官方归档与 `SHASUMS256.txt`，校验 SHA-256 后解包，并保留 LICENSE。缓存根目录可通过 `BATON_NODE_CACHE` 覆盖；离线输入缺失时给出下载命令。工具未核验发布者的离线签名。

已有 Node 26.11.1 归档校验记录如下，缓存操作用法见 [官方 Node 缓存](../../tools/README.md#官方-node-缓存)。这些记录不表示其他环境中已存在相应缓存。

| 官方归档 | SHA-256 |
|---|---|
| `node-v26.11.1-darwin-arm64.tar.gz` | `d916511b55965e91be7a88e17f88d895b6793ceaba3e6c9b194aefe51c2c65ac` |
| `node-v26.11.1-linux-arm64.tar.gz` | `170454fb022f5e9b5f6cc76c25fa32ef5100895be44eb04e92f9780591491bbf` |

### 发布流水线与归档

[发布工作流](../../.github/workflows/release-packages.yml) 由 `v*` 标签或手动版本触发，在 `macos-15`、`ubuntu-24.04`、`ubuntu-24.04-arm` 与 `windows-2025` 上原生构建，固定 Node 26.11.1 和 pnpm 12.11.2。Linux 执行包含本地 PostgreSQL 的工作区测试与中心构建；macOS、Windows 执行节点、Project Runtime 与桌面客户端的 Node 离线测试。自动化验证使用离线转录、本地替身与本机资源。

每个平台执行安装包构建、搬迁检查、Worker 冷启动与 FULL 账本测量；Windows 另执行进程机制检查。全部通过后构建并推送 GHCR 中心镜像，以 Ed25519 签名清单绑定其摘要及设备工件，再创建 GitHub Release。测试或验证失败阻止发布。macOS 无 Developer ID 时仍可发布手动 DMG，自动安装保持不可用；Windows 无证书时由签名清单校验更新，系统发布者身份未经认证。

[归档器](../../tools/package-release.mjs) 只复制可执行文件、附带依赖、许可及规定的元数据，校验帮助、SEA 平台与版本、安装包清单。`release.json` 由安装包构建生成，记录版本、明确输入的源码提交、目标平台、协议版本、中心迁移版本、三类账本格式版本、声明支持的 daemon 版本、构建 Node 与 SEA Node。归档器保留这些元数据，并要求归档版本与程序实际版本相同；归档时不从当前 Git 工作区重新填写身份。Unix 生成 tar.gz，Windows 使用系统 bsdtar 生成 zip，并校验文件头。最终归档重新解压后，再检查布局、清单、发布元数据并运行完整安装包检查，通过后才写出归档、SHA-256 与检查报告；指定 `--allow-check-failure` 时检查失败也写出这三项。

## 安装包检查

[安装包检查入口](../../tools/check-package.mjs) 与归档器共用 [安装布局规则](../../tools/lib/installation.mjs)：可执行文件必须是非空普通文件，POSIX 上有执行权限，依赖与许可目录非空，包内链接必须解析到包内。检查将安装包复制到临时目录，以空 PATH、临时 HOME 和包外工作目录运行，不继承 provider 凭据与个人配置路径；Windows 保留系统命令所需的环境变量。

| 检查 | 观察与失败条件 |
|---|---|
| 帮助与版本 | 帮助包含 Baton 命令；版本报告 `sea=true`、当前系统与架构、有效 Node 版本；`release.json`、安装包清单与 daemon、Worker、agent-host、watchdog、Runtime 的版本输出和诊断元数据一致 |
| Worker | 真实 `LocalWorkerHost` 启动一个 SEA Worker，认证 status 达到 `worker_ready=true` 且 `agent_ready=false`；错误 IPC 令牌被拒绝，独占锁与创建时间匹配，业务表、格式表、迁移记录与 WAL 已持久化，账本格式与 Worker 实际诊断一致；从 spawn 到认证 status 必须小于 Host 就绪预算（Windows 10 秒，其余系统 3 秒） |
| 清理 | POSIX 发送 SIGTERM 后确认 Worker 与 watchdog 退出、锁释放；Windows 核对进程创建时间后执行 `taskkill /T /F`，确认退出与锁已失效，报告 `graceful=false` |
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

中心与设备的业务连接按协议版本判断，不按产品版本白名单准入；能力通过独立声明报告。旧元数据中的 `supported_daemon_versions` 保留作发布信息和初次安装包筛选，不作为业务通信的兼容依据。协议不兼容时业务连接被拒绝，认证的设备仍可通过独立管理 HTTP 通道读取更新请求和上报进度，中心保留业务队列及报告。

发布构建将版本、提交、平台、协议和数据格式写入程序及安装包。`--update-keys` 将受信 Ed25519 公钥列表编入节点程序；自托管设备也可由操作者在本机私有数据目录显式配置公钥。更新响应不能建立信任根。发布工具签署包含版本、提交、协议、平台、文件名、大小和 SHA-256 的清单；daemon 和 desktop 工件分别声明。中心提供清单和原始归档，设备只从保存的中心同源下载并验证签名、大小、摘要、平台及目标程序身份。私钥只在签名时从本地读取。

网页发起的请求持久保存 operation_id，设备离线时保留。管理请求按已认证设备所有权检查；失败后的显式重试复用 operation_id 并递增 attempt，旧轮次报告不能改变新状态。管理通道的最后联系时间与业务在线状态分开。旧版不支持该通道时，设备需先在本机引导更新入口。

## 持久格式与迁移

### 发布基线

首版发布前完成长期记忆和凭据结构调整，按最终结构生成基线。正式归档所含的迁移文件和解码规则固定后不再改写；后续新增迁移文件。现有实验数据是否保留由部署者在首版安装前决定，不新增旧实验格式兼容层。

PostgreSQL 的 `schema_migrations(version, checksum, applied_at)` 保存迁移文件名、SQL SHA-256 与应用时间。已应用记录必须按文件名排序构成随程序附带迁移的完整前缀；未知版本或中间记录缺失返回 `storage_version_unsupported`，摘要不符返回 `migration_checksum_mismatch`。现有实验库缺少摘要列时拒绝启动，不补填摘要。

四类 SQLite 账本的当前基线使用迁移记录 `0001_baseline`；节点账本为格式 2，Thread、Project 和 Execution 账本为格式 1。各库使用 `storage_format(id, kind, version)` 单行表及 `storage_migrations(id, checksum, applied_at)` 迁移记录表，`kind` 分别为 `node`、`project`、`thread`、`execution`。SHA-256 覆盖类型、格式与 payload 基线版本及该账本声明的 SQL。

| 存储 | 迁移边界 |
|---|---|
| PostgreSQL | `schema_migrations` 保存版本、SQL SHA-256 与应用时间；启动前核对已应用文件及程序支持范围，校验通过后才执行新迁移 |
| `node.db` | 独立记录节点命令、Worker 发现与报告账本的格式版本；保留 generation、命令身份、ACK 与已尝试派发事实 |
| `project-runtime.db` | 独立记录 Runtime 运行、进程身份与清理格式；有后台记忆模式时包含其 claim/attempt，不丢弃旧清理义务 |
| 每个 `thread.db` | 独立记录 Worker schema 和 JSON payload 版本；保留 seq、intent、输入准备证据、原生会话、控制代次和去重记录 |
| 私有身份与配置文件 | 沿用现有原子写入与字段保留规则，本次基线不增加结构版本 |

SQLite 在只读连接中核对格式元数据和迁移记录，通过后才打开写连接、读取业务 JSON。缺少或不支持的类型、版本、迁移记录返回 `storage_version_unsupported`；摘要不符返回 `migration_checksum_mismatch`。仅缺失文件或零字节新文件可初始化；已有非空文件缺少元数据时拒绝采用，不自动识别旧实验格式。

基线建表、提交核验行、格式元数据和迁移记录在 SQLite 事务内一起提交。重复打开核对持久记录，不重跑基线 SQL。提交继续复用 `packages/sqlite` 的 token 核验；`CommitUnknown` 时停止，关闭连接后核对持久事实，不盲目重跑。增量迁移按既定顺序核验历史摘要并追加新记录，不改写已执行迁移。

中心复用现有迁移事务和 advisory lock，格式核对失败或迁移失败时不启动业务 listener，管理员命令也不能跳过校验写入。每次迁移保持短事务，不含模型、网络请求或不可回滚的外部动作。新程序遇到范围之外的格式、摘要变化、缺失迁移或损坏，分别返回可诊断错误并保留文件。

设备迁移复用数据目录的 `daemon.lock` 和配置写锁，并核对登记进程与账本中的清理义务。逐库核验与迁移依据库内持久事实继续，不覆盖原备份。所有库核验成功后进入 syncing，取得中心完成回执前不开放新执行。正式发布前的实验数据可重建；发布基线之后的迁移按有序列表验证摘要并逐项提交。强制结束进程后的跨库恢复尚未验收。

旧程序只可在清单声明的数据范围内应用回切；已发布程序都必须先检查格式再打开业务写入口。默认不提供 down migration。需要不兼容变更时提供前向修复或一致备份恢复说明。

## 升级执行与恢复

### 中心

管理员停止旧中心及使用同一数据库的管理写入，取得 PostgreSQL 一致备份，保存相应签名密钥、数据库迁移版本、发布版本与部署配置。备份成功后，使用新版本已有的 `migrate` 入口执行并核验迁移，再运行 `serve`；`serve` 自带的迁移检查仍然保留。现有单活动中心约束继续适用。

迁移期间不监听业务端口，节点按既有策略退避。Thread 在设备上继续执行、持久保存结果；Project 前后台 Runtime 按租约和保存屏障结束，不将本地未保存输出当作已完成事实。服务启动后先验证数据库、静态资源和发布元数据，节点重新连接同步，原 ID 的 outbox 继续派发与去重。重连后的闲置状态按 Baton R-02 判断，中心停机超过期限时仍需重新认证。

数据库事务失败时回滚本次未完成迁移，中心继续停服。应用回切前，先在数据库副本上用拟回切程序和它配套的 `migrations/` 运行 `migrate`，确认当前库的版本与迁移摘要受该程序支持；该命令也会执行程序支持的未应用前向迁移。正式回切仍保留启动校验。遇到 `storage_version_unsupported` 或 `migration_checksum_mismatch` 时停止回切，不修改元数据绕过校验，也不运行旧程序写业务数据；只能前向修复，或由管理员显式选择停机恢复配套备份。恢复前说明将丢失的备份后数据并取得执行者确认，不能将程序文件回切视为数据库回滚。

### 设备准备与切换

`batond update` 请求已配置中心的目标，`update status` 查询持久状态，`update cancel` 在迁移前取消，`update policy manual|idle` 设置本机策略。网页可为有管理能力的设备创建离线请求；桌面使用「更新并重启」入口。后台按周期验证清单并预下载；idle 策略在观察到空闲后发起准备，竞争中已经开始的工作继续自然结束。

固定 shim 从私有的原子指针选择版本化 launcher；daemon 和独立更新进程使用完整版本目录，业务数据及凭据保留在原目录。目标版本先经安全解包、签名、摘要和身份检查，再进入准备。prepare 暂停新工作，等待 Thread、Execution、Project 和进程清理义务；ready 后正常停止 daemon。更新进程持锁备份并迁移各账本，更新版本指针后启动目标程序。同步期间继续补报已保存的 Thread 和 Execution 报告，中心确认 completed 后才恢复队列。网络不可达时保持同步等待。

更新失败且业务尚未恢复时，回滚日志阻止业务启动，逐项核验和恢复一致备份并回切旧版本；中断后独立恢复进程继续处理日志。completed 后禁止自动恢复旧数据。具体平台支持范围和真实中断演练以验证记录为准。

### 备份与恢复

中心备份使用 PostgreSQL 的一致逻辑备份（如 `pg_dump`）或一致物理快照；管理员停止中心及其他管理写入后，连同原签名密钥和部署配置保存。人工记录源发布版本、数据库格式与迁移摘要、备份时间、实际包含的目录、校验值及保留位置。不提供自动备份命令或备份描述文件格式工具，秘密不写进普通清单或发布归档。

| 材料 | 位置与恢复范围 |
|---|---|
| 中心数据库 | `BATON_DATABASE_URL` 指向的 PostgreSQL 数据库，Baton schema 由 `BATON_DB_SCHEMA` 指定、默认 `public`。包含账号、设备与默认选择、Project、记忆与修订、Thread 历史、命令与报告证据，以及 `schema_migrations`。备份须包含恢复所需的 pgvector 扩展及 schema 依赖 |
| 中心签名密钥 | `BATON_NODE_SIGNING_KEY` 指定的原文件，默认中心工作目录的 `node-signing.key`。与数据库配套保存，恢复原权限和所有者；缺失或无效时停止恢复后处理 |
| 中心部署配置 | 实际服务管理器、容器或启动脚本中的环境变量与配置文件，包括数据库与 schema、密钥路径、公开 Origin、监听地址、TLS 证书和私钥、反向代理配置及使用的程序版本。恢复数据库不恢复这些文件 |
| 设备私有数据 | `--data-dir`，默认 `~/.baton-ts`，Windows 为 `%USERPROFILE%\.baton-ts`。整体保留 `identity.json`、`reauth-pending.json`（存在时）、目录和执行授权配置、`node.db`、`project-runtime.db`、`threads/<Thread ID>/thread.db`、`executions/<Execution ID>/execution.db`、执行完成证据、原生映射和 SDK 状态、`full-output/`，以及存在的 SQLite WAL。不能只复制主数据库文件或只保存身份文件 |
| Project 模型凭据 | `BATON_PROJECT_RUNTIME_DATA_DIR`，默认 `~/.baton/project-runtime`；保存订阅 OAuth、按连接 ID 隔离的 API 配置和密钥及 `embeddings/` 中的 Embedding 凭据。它不在默认设备数据目录内，须单独保护和恢复 |
| Pi 原生会话与认证 | 默认 `~/.pi/agent`，配置了 `PI_CODING_AGENT_DIR` 时使用该目录；会话默认在其 `sessions/`，`PI_CODING_AGENT_SESSION_DIR` 可单独指定会话目录。目录与外部会话目录一并保留 |
| Codex 原生会话与认证 | `CODEX_HOME`，默认 `~/.codex`；包括 `sessions/`、`archived_sessions/`、SQLite 状态、`auth.json` 等。只恢复 Baton 的原生会话 ID 不能恢复这些内容 |
| Cursor、Kiro 及其他外部配置 | 保存启动用户的 `HOME`（Windows 为 `%USERPROFILE%`）及原生 CLI/SDK 配置明确指定的外部存储。Baton 未固定 Cursor SDK、Kiro CLI 的全部内部目录，须在实际备份清单中列出；不能确定子目录时保留完整用户配置目录和系统凭据库。Cursor 的 `CURSOR_API_KEY` 来自设备启动配置，须按秘密单独保管；跨系统不能直接复制的认证材料需要重新登录 |
| 工作目录与外部副作用 | 仓库、工作文件和外部系统由各自备份恢复，中心数据库不保存它们。恢复中心历史不会回滚已经执行的命令、文件变更或外部请求 |

设备更新进程在独占锁下生成并校验数据目录备份，范围与位置见「设备准备与切换」。人工保存或恢复设备数据前，须停止 daemon、所有 Worker、agent-host、watchdog、前后台 Runtime 及其他共享原生存储的写入者，确认它们退出，再整体复制数据与存在的 WAL。停止 daemon 不代表其他进程已退出；不满足这些条件的设备副本不能宣称为一致备份。私有目录和凭据保持原权限，Windows 的 ACL 边界见平台说明。

普通升级备份默认只恢复到新执行开放之前。业务开放后恢复旧快照前，管理员先保存当前数据与设备执行证据，列明备份之后会丢失的账号/口令和权限变化、Thread 输入与输出、Project 事件及记忆修订范围，说明原生会话与工作目录是否同步回退，并取得执行者确认。副作用可能已在设备或外部系统发生，旧快照里的 `queued` 或零次派发不能证明没有执行。不得把旧 PID 直接当成现存进程证据。

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

签名工具与清单验证的离线测试覆盖可信公钥、签名篡改、工件摘要及构建时拒绝私钥。回滚包内测试覆盖一致备份恢复、恢复日志重复执行、备份篡改拒绝和 completed 后禁止自动回滚。新发布基线的双版本签名更新及中断恢复须以实际演练结果记录。Windows、Linux 的本次安装与恢复尚未验证，macOS 桌面安装交接也不由包内替身测试证明。

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

COMMIT 延迟受 runner 磁盘和调度影响，Windows 发布测量通过 `TMP`、`TEMP` 使用 `RUNNER_TEMP` 所在盘。测量使用 WAL、`synchronous=FULL`、`fullfsync=0`，未做断电验证；负载不含 Agent、IPC、prompt、输入 intent 或大队列，无法据此推断全部命令接收延迟。当前测量工具在 COMMIT p99 超过 50 ms 时非零退出；若测量或实际命令接收延迟超标，需提前评估将账本移入 `worker_threads`。

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

[Windows 进程脚本](../../tools/verify/windows-processes.mjs) 使用 .NET 进程创建时间的 UTC ticks 校验与 `taskkill` 包装，观察完整父子孙树、故意过期的创建时间，以及中间父进程退出后的孙进程。它检查系统机制，未调用生产 reaper，不强迫系统实际复用 PID，也不验证 Worker 崩溃到下一次启动之间的回收延迟；非 Windows 输出 `not-measured`。

第一版的 Windows 平台边界为：`taskkill /T` 可能漏掉中间父进程先退出后的后代；Worker 崩溃后 Agent 可能运行到下一次 Worker 启动；进程身份核对与终止之间存在竞争窗口。私有目录沿用数据目录继承的 ACL，不做 DACL 与 reparse point 检查；命名管道使用 Node 默认安全描述符，依靠私有令牌认证。实现与恢复约束见 [平台实现](../../apps/batond/src/platform/README.md) 与 [进程回收设计](../agent-adapters/TECH.md#进程组与停止回收)。

## 第一版之后

| 项目 | 条件与范围 |
|---|---|
| Windows Job Object 与逐句柄 DACL 检查 | 通过专用原生模块接入平台层，补足回收与文件访问边界 |
| Windows 命名管道限定当前用户 | 通过原生安全描述符设置收紧访问范围 |
| 包内编译升级到 TypeScript 7 | 当前包内编译器为 TypeScript 6.0.3；Vite+ 已使用 TypeScript Go 检查 |
| Worker 账本移入 `worker_threads` | 按实际测量决定；若 FULL 提交 p99 或命令接收延迟超标，提前处理 |
| 跨设备输出与控制延迟、容量压测阈值 | Baton 验证表 R-16、R-24 与 Q5 的负载阈值留待第一版之后；500 台设备、100 个执行中 Thread、24 小时是待测场景，当前无容量达标结论 |
