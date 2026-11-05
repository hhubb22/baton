# 打包与发布技术设计

Status: implemented
Owner: Asa
Basis: [发布与升级行为规格](PRODUCT.md) RL-01～RL-09；[Baton TECH](../baton/TECH.md)；[Agent 适配 TECH](../agent-adapters/TECH.md)；[构建与发布工具](../../tools/README.md)。

## 1. 打包与发布（RL-01～RL-03）

中心使用 Node 26 运行 esbuild bundle；设备端使用携带官方 Node 26 的单文件可执行安装包（SEA）及旁置原生依赖。发布目标为 macOS arm64、Linux x64、Linux arm64 和 Windows x64。

| 产物 | 内容与运行方式 |
|---|---|
| 中心 bundle | `apps/server/dist/server.cjs` 及相邻 `web/`、`migrations/`；构建自动编译前端并复制根目录 SQL 迁移 |
| 中心镜像 | 基于 `node:26-bookworm-slim`，包含中心 bundle、网页与迁移，以非 root `baton` 用户运行 |
| 节点开发 bundle | `apps/batond/dist/batond.cjs`；通过本机 Node 与 workspace 依赖运行，`agent-host`、`project-runtime` 与 `watchdog` 作为同一入口的子命令启动 |
| 节点 SEA 安装包 | `batond`（Windows 为 `batond.exe`）、旁置 `node_modules/`、`licenses/`、`package.json`、`package-manifest.json`、`release.json` 与 `INSTALL.md`；目标机器无需预装 Node |
| CLI 发布归档 | `baton-<版本>-<平台>.tar.gz`（Windows 为 `.zip`），附 `.sha256` 与安装包自检报告 JSON |
| 桌面客户端安装包 | `baton-desktop-<版本>-darwin-arm64.dmg` 与 `baton-desktop-<版本>-win32-x64.exe`，附 `.sha256`；应用 `resources/batond/` 内嵌同版本完整 SEA 安装包 |

构建与依赖装配：
- **统一构建（`tools/build.mjs`、`tools/package-batond.mjs`）**：使用支持 `--build-sea` 且保留 LICENSE 的官方 Node 26（缓存管理见 `tools/release/cache-node.mjs`），关闭 code cache 与 snapshot，`execArgvExtension` 设为 `none`。后台守护进程（`serve` / `run`）、`agent-host`、`project-runtime` 与 `watchdog` 均通过同一可执行文件的子命令启动，不再拆分独立的 `worker` 或 `execution` 子进程入口。
- **旁置依赖与许可（`tools/package-dependencies.mjs`）**：将 `@cursor/sdk` 及其平台原生工具、`@napi-rs/keyring`、`pi-ai` / `pi-agent-core`（含模型元数据与 OAuth 动态模块）按目标系统、架构与 glibc 复制到可执行文件旁的 `node_modules/`，由 SEA 通过 `createRequire` 或磁盘 ESM 路径加载，不依赖源码目录或 pnpm 符号链接。`licenses/` 收录 Node、t3code、第三方包许可与 Cursor 来源说明。
- **桌面打包（`tools/package-desktop.mjs`）**：核对输入 `batond` SEA 实际输出版本与 `release.json` 一致后打入 `resources/batond/`；macOS 执行整体 ad-hoc 签名并保留内置 `batond` 签名，Windows 生成按用户安装、无需管理员提权的 NSIS 安装包。常规 `pnpm install` 与单元测试不下载或启动 Electron。
- **发布流水线（`.github/workflows/release-packages.yml`）**：在 `macos-15`、`ubuntu-24.04`、`ubuntu-24.04-arm`、`windows-2025` 原生 runner 上构建并执行隔离安装包检查、SQLite `FULL` 提交测量与平台验证，全部通过后推送 GHCR 中心镜像并创建 GitHub Release。发布任务用 Ed25519 对版本、提交、中心镜像摘要和各安装包 SHA-256 组成的 `release-manifest.json` 签名；部署任务用预先配置的公钥验签后才使用资产。设备不读取该清单。

## 2. 安装包隔离检查（RL-02）

`tools/check-package.mjs` 将构建好的安装包复制到临时搬迁目录，在空 `PATH`、临时 `HOME` 和包外工作目录下逐项核验，任一失败阻止发布：

| 检查项 | 核验内容与失败条件 |
|---|---|
| 帮助与构建身份 | 帮助包含预期命令；版本输出 `sea=true`、目标平台与架构一致；`release.json`、`package-manifest.json` 与 `batond`、`agent-host`、`watchdog`、`project-runtime` 报告的版本、提交及协议号完全一致 |
| 守护进程与本地控制通道 | 在临时数据目录启动 SEA `batond`，校验 `daemon.lock`、`control.token` 与本地控制通道 `status` 在就绪预算内响应（POSIX 5 秒、Windows 10 秒），错误令牌被拒绝；核验 `node.db` 的 WAL、`synchronous=FULL`、格式表与提交核查就绪；发送 `shutdown` 后进程正常退出、锁释放 |
| Agent host 模块 | `batond agent-host --probe` 成功加载全部 6 个受管 Agent 模块（Cursor、Pi、Codex、Kiro、Antigravity、Droid）、keyring 以及 tree-sitter / Bash 语法解析器 |
| Cursor 原生组件 | 隔离禁用网络的子进程从搬迁包加载 `@cursor/sdk/sqlite` 打开并关闭临时 store；直接执行包内 `ripgrep --version` 与 `sandbox helper --help` 校验退出码 |
| Project 与 Memory Runtime | 通过 stdio 验证 Project Runtime `bootstrap` → 空 `read_events` → 结束退出，以及 Memory Runtime `memory_bootstrap` → 本地 Embedding 替身取消回收，模型调用次数为 0 |
| 私有凭据权限 | 校验 Embedding 密钥与订阅凭据读写识别且不泄漏明文；POSIX 校验私有目录 `0700` 与文件 `0600` 权限，Windows 沿用用户目录继承权限 |
| 缺失依赖负向检查 | 临时移走旁置 `node_modules/` 后，`agent-host --probe` 必须非零退出并明确报告安装包依赖缺失 |

## 3. 协议准入、持久格式与停机替换升级（RL-04～RL-07）

### 3.1 协议版本准入

中心与节点在 `/v1/node` 握手阶段核对协议版本（与展示用产品版本号解耦），未知可选字段按忽略规则容忍，新增能力通过显式字段声明。当节点协议版本不被中心接受时，中心返回 `node_version_incompatible` 并拒绝连接；`batond` 进入 `rejected` 状态停止自动重连，经本地控制通道向 CLI `status`、桌面托盘与详情页暴露原因并引导下载新版安装包（RL-04、RL-05）。系统不内置在线热更新清单拉取、双版本启动器指针切换或管理 HTTP 更新通道。

### 3.2 存储格式与事务核验

内部开发阶段只有一个中心迁移 `migrations/0001_initial.sql`，它是当前 schema 基线；结构变化直接修改基线并重建实验数据库，不维护历史实验格式的兼容读取分支。正式发布后冻结已发布迁移，通过有序增量迁移演进（RL-07、Baton R-25）。

| 存储 | 格式与迁移核验边界 |
|---|---|
| 中心 PostgreSQL | `schema_migrations(version, checksum, applied_at)` 保存迁移文件名与 SQL SHA-256；启动时在事务 advisory lock 内校验已应用记录构成完整前缀且摘要一致，不符返回 `storage_version_unsupported` 或 `migration_checksum_mismatch` 并拒绝启动业务监听 |
| 节点 `node.db` | 单一 SQLite 账本（`kind = 'node'`），集中保存节点命令、Thread 状态机与消息 `intent`、上行报告 `thread_outbox`、Execution 状态及所属进程登记；通过 `storage_format` + `storage_migrations` 校验基线摘要 |
| `project-runtime.db` | 独立 SQLite 账本（`kind = 'project'`），保存 Project Runtime 运行、后台记忆 claim 与进程清理记录 |
| 私有身份与配置文件 | `identity.json`、`browse-roots.json`、`project-exec.json` 等使用 `0600` 原子替换写入 |

SQLite 先以只读连接校验格式与迁移摘要，通过后才打开写连接（仅不存在或零字节新文件允许初始化基线）。外层事务继续使用 `@baton/sqlite` 的随机提交 token 核查；遇到 `CommitUnknown` 时立即冻结对应状态机并关闭重开校验持久事实，不盲目重跑事务。

### 3.3 中心与设备替换升级

- **中心升级（RL-06）**：停止旧中心实例 → 备份 PostgreSQL 数据库与 `BATON_NODE_SIGNING_KEY` → 执行新版本 `migrate` 核验通过 → 启动 `serve`。中心停服期间，`batond` 进程内正在运行的 Turn 与 Execution 继续按本地时限执行并将报告写入 `node.db`；中心恢复后 `batond` 自动重连同步，按原 `event_id` 与连续序号补报结果。数据库迁移不可逆，禁止将旧版程序直接连向已执行新版迁移的数据库；回退须恢复配套数据库备份。
- **设备替换升级（RL-07）**：
  - POSIX CLI：`batond install`（仅限从 SEA 安装包运行）在无运行冲突或先经本地控制通道 `shutdown` 停止旧守护进程后，将当前 SEA 目录整体安装至 `~/.baton/program`（自定义数据目录时为 `<目录>/installation`），并在 `~/.local/bin/batond` 写入直达入口脚本；若已安装系统用户服务，重新执行 `batond service install` 重载并重启服务。`batond uninstall` 先停止守护进程与匹配的用户服务，再移除程序目录与入口脚本；加 `--purge` 时一并清理数据目录。`batond doctor` 提供只读安装与环境检查。
  - 桌面客户端：直接用新版 DMG 或 NSIS 安装包覆盖旧应用，启动后客户端沿用原有 `userData/coordinator.json` 与 `~/.baton/data`。

## 4. 备份恢复与后处理（RL-08）

| 材料 | 路径与备份要求 |
|---|---|
| 中心数据库 | `BATON_DATABASE_URL`（含 `BATON_DB_SCHEMA` 与 `pgvector` 扩展）；须在停止中心写入后获取一致快照或 `pg_dump` |
| 中心节点签名密钥 | `BATON_NODE_SIGNING_KEY`（默认 `node-signing.key`）；必须与数据库快照配套保存，丢失将导致所有既有设备凭据无法验签 |
| 中心部署配置 | 环境变量、公开 HTTPS 源、TLS 证书与反向代理配置 |
| 设备私有数据目录 | 默认 `~/.baton/data`（Windows `%USERPROFILE%\.baton\data`），含 `identity.json`、目录与执行配置、`node.db`、`project-runtime.db`（连同存在的 `-wal`）、原生映射、`full-output/` 及 `credentials/`；备份前须先经控制通道停止 `batond` 及所有子进程 |
| 原生 Agent 会话目录 | `~/.pi/agent`、`~/.codex`（或 `CODEX_HOME`）及 Cursor / Kiro / Antigravity / Droid 的本机用户状态目录，由设备侧独立保管 |

中心从历史快照恢复后的开服流程：
1. 保持中心停服，恢复配套 PostgreSQL 快照、`BATON_NODE_SIGNING_KEY` 与部署配置。
2. 显式执行单事务恢复后处理（不启动业务监听，且缺少既有签名密钥时直接报错退出、绝不自动生成新密钥）：
   ```sh
   node apps/server/dist/server.cjs admin restore-finalize
   ```
3. `restore-finalize` 在同一事务内完成：
   - 清空全部浏览器 `login_sessions`，使待处理的 `device_login_sessions` 过期；
   - 清空 `node_presence` 在线状态（保留未吊销设备的长效凭据与已吊销记录，要求设备重连并重新完成 `node.sync` 后才恢复可用）；
   - 将缺少完成证据的在途消息标为 `unknown`，将未完成 `thread_outbox` 的 `next_attempt_at` 置为 `infinity` 冻结自动重发（允许迟到报告按原 ID 幂等补报，也允许员工后续显式发送新的 `stop` / `archive`）；
   - 将活动 Project 置为 `paused`、在途 `agent_runs` 置为 `lost` 并撤销租约，待员工核对后显式恢复。
4. 核对无误后启动 `serve`。重复执行 `restore-finalize` 保持幂等。

## 5. 测量证据、诊断记录与平台边界（RL-03、RL-09）

### 5.1 FULL 同步账本与 Cursor 加载记录

SQLite 采用 WAL、`synchronous=FULL`、`fullfsync=0` 及提交 token 核查。原生 runner 基准（Node 26.11.1，2000 次串行事务测量）：macOS arm64 `COMMIT` p99 为 `0.528 ms`、Linux x64 为 `0.579 ms`、Linux arm64 为 `0.467 ms`、Windows Server 2022 本机为 `5.647 ms`。单一 `node.db` 承载全部 Thread 与 Execution 持久状态并共享同一串行写连接；若后续实测高并发 `COMMIT` p99 超过 50 ms，再评估将 SQLite 写入移入独立 `worker_threads`。

Cursor 固定旁置 `@cursor/sdk@1.0.35`：macOS arm64、Linux x64 与 Windows Server 2022 已验证模块、SQLite store、`ripgrep` 与 `sandbox helper` 加载；Linux arm64 在 Ubuntu 24.04 通过，但在 Debian 12（glibc 2.36）下因 Cursor `sandbox helper` 依赖 `GLIBC_2.39` 无法加载该辅助程序，按实际探测结果单独限制依赖该沙箱的执行模式（RL-03）。

### 5.2 版本化诊断与运行记录（RL-09）

中心、守护进程、`agent-host` 与 `project-runtime` 在结构化日志、客户端诊断摘要及设备本地 `transcript.jsonl` 行信封中携带各自的发布版本号与源码提交；不内置外部 OTLP 导出管线，凭据隔离与按需拉取规则遵循 [诊断与运行记录 TECH](../observability/TECH.md)。

### 5.3 Windows 平台边界与第一版之后事项

Windows 当前沿用用户目录下数据目录继承的 ACL，命名管道使用默认安全描述符配合 256-bit 随机 `control.token` 常量时间认证；进程树回收按 `node.db` 持久记录的 `(pid, creationTime)` 调用 `taskkill /T /F`，中间父进程提前退出时可能遗漏孙进程，且 `batond` 被强杀后子进程可能存活至下次 `batond` 启动回收。

| 后续演进项 | 触发条件与范围 |
|---|---|
| Windows Job Object 与命名管道/文件 DACL 收紧 | 通过专用轻量原生模块接入 `apps/batond/src/platform`，补齐强杀即时连带回收与管道当前用户安全描述符 |
| `node.db` 写入移入 `worker_threads` | 当多 Thread 并发下 `FULL` 事务提交延迟实测影响事件循环响应时启用 |
| 容量压测合格阈值 | 第一版后在 500 在线设备 / 100 并发 Thread / 24 小时故障注入场景下实测标定 |

## Testing and validation

| Requirement | Setup and observation | Failure condition | Where | Status |
|---|---|---|---|---|
| RL-01、RL-02 | 构建 SEA 与桌面包，搬迁至空 `PATH` 与临时 `HOME` 运行 `tools/check-package.mjs`，并做移走 `node_modules/` 负向测试 | 版本身份不一致；本地控制通道或 `node.db` 初始化失败；任一 Agent 模块加载失败；缺依赖未明确报错 | 本地构建 + 4 平台 CI | verified |
| RL-03 | Linux 低版本 glibc 环境与 Windows 进程树检查脚本运行探测与模式检查 | 未按实际能力准入，或静态白名单误封可用环境 | 平台验证 + 探测单测 | platform pending |
| RL-04、RL-05 | 真实中心拒绝不兼容协议；同协议异版本号节点正常同步；`batond` 进入 `rejected` 并停止重连，`status` 保留原因 | 同协议被拒；不兼容协议未被拒或 `batond` 继续重连 | `apps/server` 集成 + `apps/batond` 单测 + `e2e` | verified |
| RL-06、RL-07 | 在途 Turn 执行期间重启并迁移中心；运行中的守护进程执行 `batond install` 停机替换；已装服务重载；`uninstall` 保留或按 `--purge` 删除数据 | 在途 Turn 中断或补报重复；覆盖安装丢失身份；服务未重载或数据被误删 | `e2e` + `apps/batond` 单测 | verified |
| RL-08 | 恢复历史 PostgreSQL 快照与配套签名密钥，运行 `admin restore-finalize`（含重复运行与缺失密钥负向用例） | 缺密钥时自动新建密钥；旧浏览器会话仍有效；冻结命令被自动重发；活动 Project 未暂停 | `apps/server` 集成 | verified |
| RL-09 | 跑通一次完整 Turn、一次异常停止与一次 Project 运行，检查结构化日志、诊断摘要与设备端 `transcript.jsonl` | 缺失组件版本或提交；运行轨迹被截断或泄漏敏感凭据；残留外部遥测请求 | 集成测试 + 打包检查 | verified |
