# TypeScript 迁移技术设计

Status: draft
Owner: 待指定
Basis: [Baton PRODUCT](../baton/PRODUCT.md)；[Baton TECH](../baton/TECH.md)；[Agent 适配 TECH](../agent-adapters/TECH.md)；Baton `0841a59`；t3code `9828cad49f3e1ef4f9e037b3baaca19f4e4928fc`（Baton fork 的基线）。

## 目标与切换方式

Coordinator、batond 和 Session Worker 使用 TypeScript + Effect 4，Agent 接入整包依赖 t3code fork 的 provider 并接受上游行为。行为依据为 Baton 与 Agent 适配 PRODUCT，服务边界、并发模型和内部接口按 Node 运行时设计。

根构建入口从 workspace 执行 `pnpm install --frozen-lockfile --ignore-scripts`，构建 `@baton/server` 和 `@baton/batond`，bundle 分别位于 `apps/server/dist` 与 `apps/batond/dist`，随后调用 `tools/package-batond.mjs --out bin` 生成当前平台的 SEA 安装包。中心自动包含网页和 SQL 迁移；安装包的入口与依赖布局见「打包与发布」。

| 规则 | 内容 |
|---|---|
| 实现位置 | `apps/server`、`apps/batond` 与共享 workspace 包；源码开发、bundle 与安装包复用业务实现 |
| 行为基准 | Baton PRODUCT 与 Agent 适配 PRODUCT，测试按产品验收、存储和并发不变量组织 |
| 契约范围 | 浏览器 HTTP API、节点 WSS 信封和 PostgreSQL schema 由当前协议及迁移维护；Worker IPC、设备账本和进程内服务由 TS 实现与调用方共同验证 |
| 本地数据 | 按实验室阶段约定重建设备身份、Worker 账本与 node.db；中心从当前 SQL 基线创建，迁移按版本记录执行 |
| Agent 范围 | Pi、Codex、Kiro、shell 和 Cursor；Grok、Antigravity 按各自支持矩阵交付 |
| 发布验收约束 | 下文验证表通过；T5 的切换条件与各 runner 要求按 [TASKS.md](TASKS.md#t5-交付安装包并切换-ts-发布) 执行 |
| 验证范围 | Pi、Codex、Kiro、Cursor 使用上游安装与认证检查决定可用性，离线回放与本地安装包检查如实记录范围，缺少验证证据的系统或版本组合照常开放 |

## 实现原则

服务通过 Effect `Context.Service` 与 `Layer` 组合；进程、连接和后台任务由 `Scope` 管理。Worker 用串行队列提交短事务，慢 I/O 在独立 fiber 中执行，结果带控制代次回到状态队列；取消、停止确认与资源回收分别处理。领域状态和确定性解析使用普通 TS 数据结构与函数，Web 保持现有 React 写法。

目录表描述当前职责与查阅入口；保留员工隔离、事务原子性、命令幂等、租约和恢复证据等约束。账本复用已有 `packages/sqlite` 的串行事务与提交核查，不能因为重设内部接口而丢失 intent 的持久性。

provider 以 git submodule 依赖 Baton 的 t3code fork，Baton 只写宿主层与事件映射，不修改上游 adapter 的行为；上游缺少的能力在 fork 中补齐。包体积与依赖范围在第一版接受现状。具体边界见 [Agent 适配 TECH](../agent-adapters/TECH.md#架构与职责)。

## 技术选型

| 位置 | 技术 | 说明 |
|---|---|---|
| 运行时 | Node 26（2026 年 10 月下旬进入 LTS） | 设备端由 SEA 携带，不依赖设备上安装的 Node |
| 语言 | TypeScript 6.0，与 `web/` 相同 | 包内构建使用现有 TypeScript 编译器；Vite+ 的类型检查使用 TypeScript Go 工具链 |
| 框架 | `effect` 4.0.6，`@effect/platform-node`、`@effect/sql-pg`、`@effect/vitest` 同版本 | pnpm catalog 统一锁定。HTTP 用 `effect/http-api` 共享端点契约，底层使用 `effect/http`；子进程用 `effect/process`，Worker 与 agent-host 之间用 `effect/rpc` |
| 追踪 | `effect/observability` 原生 OTLP/HTTP | HTTP、outbox、WSS、daemon、IPC 与 Worker 关联持久 trace context；保留 SQL 耗时与连接等待，过滤查询文本、参数和错误详情；默认不导出 |
| WebSocket | `ws` | 中心的节点与浏览器两个端点，以及 batond 的出站连接；需要自定义握手头和 TLS 参数 |
| 中心存储 | PostgreSQL 16+，`@effect/sql-pg`，参数化 SQL | 沿用根目录 SQL 迁移与 Effect 事务。Drizzle、Prisma 与原生 SQL 的适用性和本地验证见 [数据库访问方案](DATABASE.md) |
| 设备存储 | `node:sqlite`，WAL + `synchronous=FULL` | 复用已有 `packages/sqlite` Effect `SqlClient`，包含提交结果核查 |
| 测试 | Vite+ 内置 Vitest + `@effect/vitest` | 工作区串行执行，不缓存数据库与进程测试；沿用本地 PostgreSQL 和自动启动逻辑 |
| 静态检查 | Vite+：Oxlint、Oxfmt、TypeScript Go | 根目录配置推荐规则，Web 与 Node 包共用；各包编译器检查继续保留 |
| 打包 | esbuild 产出单文件 JS；batond 再打成 Node SEA | 服务端在 Docker 中直接用 Node 运行 bundle |
| Agent 接入 | t3code fork 的完整 provider 包（含 `effect-acp`、`effect-codex-app-server`）、`@cursor/sdk` | 接受上游行为，Baton 提供宿主层、Worker 可靠层和事件映射 |

Web 保持 React + Vite，不引入 Effect。Project Agent Runtime 保持现有模型、工具、压缩和恢复实现。TS 开发节点通过源码 CLI 启动它，并在宿主中接入 stdio、租约、订阅登录和私有凭据文件操作；发布时改为 batond 子命令（见下文打包）。

## 仓库结构

```text
pnpm-workspace.yaml          catalog 锁定 effect、typescript、vitest 等版本
apps/server/                 Coordinator（baton-server）
apps/batond/                 batond 及其子命令：worker、watchdog、agent-host、project-runtime
packages/protocol/           Effect Schema：HTTP DTO、节点信封、Worker IPC、ThreadReport
packages/sqlite/             已有 SQLite SqlClient、串行事务与提交核查
upstream/t3code/             Baton 的 t3code fork（git submodule），workspace 收录所需 @t3tools/* 包
runtimes/project-agent/      现有 Project Agent Runtime，作为 workspace 包被 apps/batond 引用
web/                         现有前端，构建产物输出到 apps/server/dist/web
migrations/                  SQL 迁移（保留）
third_party/t3code/          MIT 许可、fork 地址、固定提交与补丁清单
```

共享协议由 `packages/protocol` 维护，中心 SQL 迁移保留在根 `migrations/`；服务、节点和 Worker 的实现与验证入口均在上述 TS workspace 中。

## 服务职责

### Coordinator（`apps/server`）

| 职责 | 实现位置（相对 `apps/server`） | 约束 |
|---|---|---|
| Thread 与员工数据 | `src/threads*.ts`、`auth.ts`、`nodes.ts` | 手写 SQL、版本检查、锁顺序、员工隔离与报告去重 |
| 数据库迁移 | `src/database.ts`、根 `migrations/` | 事务 advisory lock、按文件名排序执行、记录并核对版本 |
| 节点与浏览器连接 | `src/gateway.ts`、`server.ts` | 认证、连接代次、心跳、限流和有界队列 |
| 命令与报告 | `src/threads-outbox.ts`、`threads-reports.ts`、`control-budget.ts` | 持久领取、重试期限、接收与完成分离、报告回执 |
| HTTP、认证与静态文件 | `src/http*.ts`、`server-config.ts` | 共享 HttpApi 契约；从 bundle 旁的 `web/` 提供静态文件 |
| Project 与事项 | `src/project-*.ts`、`projects.ts`、`inbox.ts` | 放置、租约、工具、记忆、事项和设备保存确认 |

签名密钥沿用当前规则：`lstat` 确认不存在才生成 Ed25519 私钥并以 `0600` 原子写入，已有文件校验权限、类型和内容。`node:crypto` 提供 Ed25519。

Project 核心位于 `projects.ts` 与 `project-*.ts`，事项和记忆位于 `inbox.ts`、`project-memory.ts`，设备确认位于 `device-management.ts`。共享 `HttpApi` 同时声明这些功能与 Thread 接口。放置循环逐候选取得数据库名额和期限，start、stop、wake 各自领取持久工作；工具业务变更、结果事件和 shell 等待输入消费在同一事务提交。

### batond（`apps/batond`）

| 职责 | 实现位置（相对 `apps/batond`） | 约束 |
|---|---|---|
| 设备连接与本地状态 | `src/daemon` | 注册、up、WSS 重连、node.db、能力报告与 Worker 发现 |
| 本地 Thread 执行 | `src/worker` | 命令回执、intent、Turn、停止、恢复与 outbox |
| Agent 接入 | `src/agents`、`src/agent-host` | 唯一注册描述、完整 fork provider、宿主和事件映射 |
| 文件与附件 | `src/devices` | 登记根内浏览、目录设置、路径授权和符号链接边界 |
| 私有文件、时钟与进程 | `src/platform` | POSIX 进程组/watchdog、Windows PID 与创建时间、私有文件检查 |
| Project 执行与订阅 | `src/project`、`src/agents/shell` | Runtime 启停、续租、受限 shell、订阅登录与清理证据 |

Project Runtime 与 agent-host 在发布形态中作为可执行文件的子命令分发。TS 开发入口的 `src/project` 在 WSS 连接循环外拥有 Runtime，`project-runtime.db` 保存启动意图、所属进程和清理证据，断线只替换 RPC transport。`src/devices` 提供目录、文本预览、仓库扫描、执行授权和订阅管理，`src/agents/shell` 使用相同 Worker 保存命令 intent 和完成证据。开发 bundle 仍依赖源码 Runtime 入口与已安装依赖；T5 的 SEA 集成替换该定位方式，设备使用时无需安装系统 Node。

## 平台相关实现

Node 没有 Win32 安全描述符与 Job Object 的 API。第一版不引入原生模块，接受下表 Windows 一列的缺口；第一版之后用一个原生模块同时补上 Job Object 与 DACL 检查，调用点集中在 `src/platform`，其余代码不变。

| 能力 | POSIX | Windows 第一版 |
|---|---|---|
| Agent 进程树回收 | 独立进程组 + watchdog，保证与现在相同 | `taskkill /T /F` + Worker 账本中的 PID 与创建时间，见 Agent 适配 TECH |
| 私有文件 | 创建时 `0600`/`0700`，打开时 `lstat` 检查所有者、权限和类型 | 数据目录创建和显式保护时，通过 PowerShell 一次设置受保护的 DACL，仅授权 `whoami /user` 报告的当前用户 SID；启动时用 `icacls /save` 导出的数值 SID 检查目录 ACL，不按显示名或用户目录路径比较；不逐个句柄检查 DACL |
| Worker IPC | 私有目录下的 UDS | 命名管道使用 Node 默认安全描述符，不能限定为当前用户；依靠现有 IPC 令牌认证，令牌存于私有数据目录 |
| 含睡眠的单调时间 | 见下段 | 见下段 |

Project Runtime 的租约要计入系统睡眠：设备睡眠期间中心可能已经让租约过期，设备醒来后不能继续认为自己持有租约。Node 只有不含睡眠的 `process.hrtime`，所以租约经过时间取 `max(hrtime 经过值, Date.now 经过值)`。睡眠由墙上时钟计入；墙上时钟回拨时取 hrtime 经过值；墙上时钟前跳只会让租约提前过期，这是安全的方向。Worker 的停止计时只用 hrtime。

## 打包与发布

| 产物 | 内容 |
|---|---|
| `baton-server` 镜像 | Node 26 slim 基础镜像，`apps/server` 的 esbuild bundle 与 `dist/web`；`compose.yaml` 和环境变量不变 |
| `batond` | 每个目标系统一个 Node SEA 可执行文件，入口按 argv 分派到 `up`、`register`、`run`、`worker`、`watchdog`、`agent-host`、`project-runtime` |
| `batond` 附带目录 | 在可执行文件旁的 `node_modules` 中外置完整 `@cursor/sdk`（含 JavaScript）、全部生产依赖、当前系统/架构的平台包，以及 t3code 依赖中的原生模块（如 `@napi-rs/keyring`）；SEA 经 `createRequire` 从该目录加载。此方案已通过 macOS arm64 加载检查；Linux arm64 的 Cursor sandbox helper 要求 glibc 2.39+ |

目标系统为 macOS arm64、Linux x64 与 arm64、Windows x64。`node tools/package-batond.mjs --out bin/package` 使用执行脚本的官方 Node 26 原生构建 SEA；`--node <路径>` 可指定 `cache-node.mjs` 已校验并解包的官方 Node，跨系统构建由宿主 Node 的 `--build-sea` 注入目标可执行文件。构建不下载依赖或 Node；缺少目标平台依赖时直接报告缺失模块。macOS 产物使用 ad-hoc 签名，Windows 产物名为 `batond.exe`。

Project Runtime 的业务代码与 batond 打在同一个 SEA 中，通过 `project-runtime` 子命令启动。Worker、watchdog、agent-host 与私有凭据文件 helper 同样使用自身可执行文件和子命令；开发入口保留源码和已安装 Node 的启动方式。Pi 库的模型数据与 OAuth 动态模块保留在附带目录中，构建时解析其 ESM 入口，运行时从可执行文件旁加载。附带依赖按已安装的生产依赖图复制，冲突版本保留在调用方自己的 `node_modules`，不保留指向源码或 pnpm store 的链接。安装包包含 `package-manifest.json`、Cursor 来源说明、Node 与依赖许可。

`check-package.mjs <目录>` 将安装包搬到临时目录，在空 PATH、临时 HOME 下检查帮助、SEA 平台信息、完整 Worker 到认证 IPC 就绪的 3 秒预算、四个 Agent 模块加载、Project Runtime stdio 握手，以及移走依赖目录后的明确错误。`node tools/measure/worker-startup.mjs 100 --package <目录> --ledger 2000` 复用该安装包测量冷启动和真实 Worker WAL/FULL 账本；Windows 另运行 `node tools/verify/windows-processes.mjs`。这些命令输出 JSON，发布工作流上传检查、测量和构建结果。

发布工作流在 `macos-15`、`ubuntu-24.04`、`ubuntu-24.04-arm`、`windows-2025` 上原生构建。Linux 运行包含 PostgreSQL 的工作区测试，其他平台运行节点和 Project Runtime 测试。`package-release.mjs` 校验 SEA 与附带目录，将解压后的最终归档再次执行安装检查，并生成 SHA-256 文件。中心镜像使用 Node 26 slim，包含 server bundle、网页及 SQL 迁移，以非 root 用户在 `/var/lib/baton` 运行；Compose 的配置与环境变量保持一致。

## 实施切片

实施与验证按五个能力切片组织，状态由 [TASKS.md](TASKS.md) 维护。workspace、协议 Schema、SQLite SqlClient 与上游协议包随使用它们的能力共同验证。

```text
T1 Cursor 本地可靠会话 ──┬─ T2 网页远程 Thread ── T3 Project 与设备管理 ──┐
                        └─ T4 t3code 接入与历史 ────────────────────────┼─ T5 发布切换
```

当前实现包含协议、持久化、调用方、平台实现、探测替身测试与 Agent 离线转录回放，提供本地可靠 Thread、网页远程 Thread、Project、事项、目录、附件、设备设置、订阅与受限 shell；Cursor、Pi、Codex、Kiro 通过 t3code fork 的完整 adapter 和 agent-host 接入，Thread 历史使用中心记录。

完整安装包与系统矩阵复验按 T5 验收，未验证项见文末。Grok、Antigravity 复用同一宿主层分别接入。

## 测试依据

fork 中用到的包连同其上游离线测试、回放工具和原始静态转录一起运行。自动化测试与 CI 中的适配器行为验证使用本地静态录制、确定性回放和本地替身，不要求真实 API Key、在线模型推理或外部真实服务联调。确认真实环境可用手动显式运行的冒烟脚本，它不进 CI，也不作为合入前提。TS 测试按产品验收、存储与并发不变量、已知缺陷回归组织。Kiro 转录说明见 [fork README](../../upstream/t3code/packages/provider-acp-registry/src/testing/fixtures/kiro/README.md)。

HTTP、WSS 与 Worker IPC 以当前 TS Schema 和调用方测试验证契约，包内只补少量 TS 自写样例，覆盖有效消息、无效输入及关键边界。字段、容量、状态和身份关联检查由协议测试覆盖；路由、持久接收与异步完成由中心、节点和 Worker 的调用方测试验证。适配器转录从 fork 读取。

`command.completed`、异步接收时序与内部表结构由 TS 自身验证。

## 验证

| 场景 | 失败条件 | 层次 |
|---|---|---|
| HTTP / WSS / Worker IPC 的 TS Schema、调用方与少量 TS 自写样例（T1、T2） | 有效消息无法解码、编码改变契约字段、无效输入被接受，或契约调整后调用方不一致 | 协议单元测试与调用方测试 |
| t3code fork 的 provider 包与宿主层（T4） | 所用包的上游测试未运行、修改转录响应来掩盖请求不匹配，或事件映射缺少回放测试 | 模块测试与确定性回放 |
| `node:sqlite` FULL 同步连续提交，三个系统各测 p99 与事件循环延迟（T1、T5） | p99 超过 50 ms 且没有改到 `worker_threads`，或实际账本阻塞命令接收期限 | 基准测试 |
| batond SEA 与 Worker 子命令冷启动到 IPC 就绪，三个系统（T1、T5） | 超过 Host 的 3 秒就绪预算 | 基准测试 |
| Windows `taskkill` 回收与 PID 账本，含孙进程和 PID 复用（T1、T5） | 误杀无关进程；结果与 Agent 适配 TECH 所述缺口不符 | 进程测试 |
| `@cursor/sdk`、t3code 依赖与附带目录的 SEA 加载（T1、T5） | 运行时找不到模块，或需要设备上另装依赖 | 打包检查 |
| Baton TECH 验证表 R-01～R-25 中适用各行（T2～T5） | 任一现有承诺未覆盖；已定义负载阈值未满足 | 原测试层次 |
| Agent 适配 TECH 中 Pi、Codex、Kiro、Cursor 的验证行（T1、T4、T5） | 同该表 | 同该表 |
| Pi、Codex、Kiro、Cursor 的可用性（T4、T5） | 已安装且认证 valid/unknown 却因版本或系统缺少验证被拒绝，或缺程序、明确未认证仍标为 available；诊断未说明版本、系统与未开放能力 | 静态转录回放、本地替身与安装包检查，分别记录验证范围 |
| 中心重启、batond 重启、Worker 被杀、PostgreSQL 短停（T1～T3、T5） | 消息重发、回复重复、同步前设备显示可用 | 进程测试 |

切换提交前执行 `pnpm check`、`pnpm typecheck`、`pnpm test`、`pnpm --dir web build` 和 SEA 打包检查。

## 第一版之后

| 项目 | 原因 |
|---|---|
| Windows Job Object 与逐句柄 DACL 检查 | 需要原生模块；第一版用 taskkill 和目录 ACL |
| Windows 命名管道限定当前用户 | 同上 |
| 包内编译升级到 TS 7 | Vite+ 已使用 TypeScript Go 检查；包内输出和生成器继续使用其现有编译器 |
| Worker 账本移到 `worker_threads` | 测量或实际账本的命令接收延迟超标时提前 |

## 待验证与批准事项

| 项目 | 当前依据与缺口 | 处理 |
|---|---|---|
| Windows 第一版的安全缺口 | taskkill 的后代与延迟回收缺口、目录 ACL 检查及命名管道默认安全描述符 | 已接受，按上文平台相关实现执行 |
| FULL 同步提交耗时 | 发布工作流 run `40186351668`（提交 `3eba953`）在 GitHub 托管 runner 上对安装包执行：官方 Node 26.11.1，真实 `makeWorker` 串行队列预热 200 次后执行 2000 次 `records.add/remove`，每次提交后让出事件循环。macOS arm64（`macos-15`）：COMMIT p99 **0.528 ms**、最大 **3.984 ms**，队列操作 p99 **1.445 ms**，事件循环 p99 **3.019 ms**。Linux x64（`ubuntu-24.04`）：COMMIT p99 **0.579 ms**、最大 **5.694 ms**，队列操作 p99 **1.297 ms**，事件循环 p99 **2.480 ms**。Linux arm64（`ubuntu-24.04-arm`）：COMMIT p99 **0.467 ms**、最大 **3.985 ms**，队列操作 p99 **0.855 ms**，事件循环 p99 **1.544 ms** | 三个平台此负载的提交 p99 低于 50 ms；Worker 保持逐事务让出。测量覆盖实际账本、提交核查和状态队列，不含 Agent、IPC、输入 intent 或大队列负载，不能推断全部命令接收延迟。Windows x64 的 Worker 在安装包检查阶段未能启动，尚无数据。WAL/FULL、`fullfsync=0`，未做断电验证。复现：`node tools/measure/worker-startup.mjs 100 --package <安装目录> --ledger 2000` |
| SEA 冷启动 | 同一 run 的完整安装包，每平台 100 个新 Worker 进程，包含独占锁、实际 SQLite 迁移、空账本恢复调度、Agent 接入模块加载和 watchdog。spawn 到认证 status：macOS arm64 p99 **1201.209 ms**、最大 **1323.326 ms**；Linux x64 p99 **895.012 ms**、最大 **945.773 ms**；Linux arm64 p99 **754.205 ms**、最大 **996.420 ms**。含 Host 目录与令牌准备的总耗时最大分别为 **1357.314 ms**、**950.690 ms**、**1000.820 ms**。每次确认 SIGTERM 后 Worker、watchdog 退出和锁释放 | 三个平台全部样本低于 3 秒。安装目录搬到临时位置，空 PATH、临时 HOME、每次新建数据库；未清空系统页缓存。macOS runner 为虚拟化 Apple M1。Windows x64 尚无数据。已有大量命令与 intent 的恢复耗时仍需单独验证。复现：`node tools/measure/worker-startup.mjs 100 --package <安装目录>` |
| Windows x64 安装包 | run `40186351668` 中 SEA 构建、帮助、版本、四个 Agent 与原生模块加载、Project Runtime 握手、缺少附带目录时的明确失败均通过。Worker 启动在设置私有目录 DACL 的 PowerShell 命令处失败，私有凭据 helper 调用超时；节点测试 26 个文件失败，Runtime 测试 7 项失败。`windows-processes.mjs` 与冷启动、FULL 测量因 Worker 无法启动未执行，`taskkill`、CIM 创建时间及 PID 复用仍**未测** | 待在 Windows 本机修复私有目录 ACL 后重跑发布工作流。工作流对 Windows 测试失败继续执行打包与检查，日志随构建产物保存。CIM 校验与 taskkill 之间有竞争窗口，第一版已接受的两个进程回收缺口仍保留 |
| `@cursor/sdk` 的原生依赖 | 实测公开包 **1.0.35**，`engines.node >=22.13`，Node 26.11.1 满足；安装禁用脚本。默认入口直接 esbuild 报动态路径解析错误，公开 `/bundled` 入口在 Node SEA 报 `bun:sqlite` 不存在。SEA 用 `createRequire` 加载旁置的完整 SDK、生产依赖和对应平台包，可导入 SDK、打开临时 SQLite store、加载 tree-sitter/Bash `.node` 并运行 ripgrep；移走附带目录时正确失败。macOS arm64 的 sandbox helper `--help` 通过；Linux arm64 helper 要求 **GLIBC_2.39**，当前 Debian 12 / glibc 2.36 无法加载 | macOS arm64 的本地加载检查通过；会话行为统一使用离线 SDK 转录、确定性回放和本地替身验证。Cursor Linux arm64 要求 glibc 2.39+，当前 Debian 12 / glibc 2.36 不满足；其他系统组合按本机依赖与认证检查结果开放，Fedora 43 的本地加载验证待补，缺少该证据不阻止创建。需携带 SDK JS、全部生产依赖及入口可达的平台包；只有原生文件不足。SDK 许可及来源见 `third_party/cursor-sdk/`；加载检查复现 `node tools/check-package.mjs <安装目录>`（SEA 检查 SDK 加载；隔离 Node 子进程检查 SQLite store；直接执行包内 ripgrep 与 sandbox helper），离线测试入口见 `apps/batond/README.md` |
| 发布用 Node 二进制缓存 | 缓存确定为 `~/.cache/baton/node/v<版本>/`，支持 `BATON_NODE_CACHE` 覆盖；保留官方归档与经 HTTPS 获取的 `SHASUMS256.txt`，解包前校验 SHA256。已获取 v26.11.1：darwin-arm64 tar.gz 为 `d916511b55965e91be7a88e17f88d895b6793ceaba3e6c9b194aefe51c2c65ac`；linux-arm64 tar.gz 为 `170454fb022f5e9b5f6cc76c25fa32ef5100895be44eb04e92f9780591491bbf` | `tools/release/cache-node.mjs` 仅显式 `--download` 联网，离线缺失时输出下载命令；未校验离线发布签名。Windows x64 / Linux x64 缓存尚未获取；T5 的发布打包继续采用缓存输入 |
