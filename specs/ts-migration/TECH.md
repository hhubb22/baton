# TypeScript 迁移技术设计

Status: draft
Owner: 待指定
Basis: [Baton PRODUCT](../baton/PRODUCT.md)；[Baton TECH](../baton/TECH.md)；[Agent 适配 TECH](../agent-adapters/TECH.md)；Baton `0841a59`；t3code `9828cad49f3e1ef4f9e037b3baaca19f4e4928fc`（Baton fork 的基线）。

## 目标与切换方式

Coordinator、batond 和 Session Worker 按 Baton 与 Agent 适配 PRODUCT 重新实现为 TypeScript + Effect 4，Agent 接入整包依赖 t3code fork 的 provider 并接受上游行为。Go 实现在切换时删除，不作为行为基准；TS 的服务边界、并发模型和内部接口按目标运行时设计。

切换前发布和部署的始终是 Go 版；切换提交同时启用 TS 版的构建与发布、删除 Go 代码。开发与测试可以分别启动完整的 TS 链路；发布形态中没有 Go 与 TS 后端进程混用。

| 规则 | 内容 |
|---|---|
| 开发位置 | TS 代码在 main 上的新目录开发（见下文仓库结构），频繁合入；切换前使用独立开发与验证入口，`tools/build.mjs` 仍构建 Go 版 |
| Go 冻结 | 本规格批准后，Go 代码只接受阻塞当前使用的修复。Agent 适配规格的全部改动只在 TS 版实现 |
| 行为基准 | Baton PRODUCT 与 Agent 适配 PRODUCT。规格未覆盖的现有行为先核查用途；已知实现缺陷不作为兼容要求 |
| 契约范围 | 保留浏览器 HTTP API、节点 WSS 信封和中心 PostgreSQL schema 的已有结构，加入适配规格新增字段。Worker IPC、设备账本和进程内服务允许按 TS 重设，相关调用方与 `packages/protocol` 同步修改 |
| 本地数据 | 按实验室阶段约定不迁移：切换后设备重新注册、Worker 账本与 node.db 重建；中心数据库可保留，因为 schema 只增加字段 |
| 首次交付 | TS 切换覆盖现有 Pi、Codex、Kiro、shell 和新增 Cursor；Grok、Antigravity 在切换后按各自支持矩阵交付 |
| 切换条件 | 下文验证表通过；Pi、Codex、Kiro、Cursor 使用上游安装与认证检查决定可用性，离线回放与本地安装包检查如实记录验证范围，缺少验证证据的系统或版本组合照常开放 |

## 实现原则

服务通过 Effect `Context.Service` 与 `Layer` 组合；进程、连接和后台任务由 `Scope` 管理。Worker 用串行队列提交短事务，慢 I/O 在独立 fiber 中执行，结果带控制代次回到状态队列；取消、停止确认与资源回收分别处理。领域状态和确定性解析使用普通 TS 数据结构与函数，Web 保持现有 React 写法。

目录表描述职责与查阅入口。可以按领域合并原 Go 包、拆分大模块；保留员工隔离、事务原子性、命令幂等、租约和恢复证据等约束。账本复用已有 `packages/sqlite` 的串行事务与提交核查，不能因为重设内部接口而丢失 intent 的持久性。

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

切换提交删除 `cmd/`、`internal/`、`go.mod`、`go.sum`、`migrations/embed.go`、`runtimes/shared/`，并更新 `AGENTS.md`、`README.md`、`runtimes/README.md` 和 `specs/baton/TECH.md` 的技术选择、模块职责、部署与验证章节。

## 服务职责

### Coordinator（`apps/server`）

| 职责 | 建议位置 | 实现约束与现有查阅入口 |
|---|---|---|
| Thread、Project 与员工数据 | `src/store` | 手写 SQL，保留事务、版本检查、锁顺序与员工隔离；查阅 `internal/store`，测试按不变量选择 |
| 数据库迁移 | `src/migrate` | 版本化 SQL、`serve` 先 Up 后 Check；查阅 `internal/migrate` 与 `migrations` |
| 节点与浏览器连接 | `src/gateway` | 认证、连接代次、心跳、限流、有界队列；查阅 `internal/gateway` |
| 命令与报告 | `src/control` | 持久领取、重试期限、接收与完成分离、报告回执；查阅 `internal/control`、`delivery` 与控制面调度规格 |
| HTTP、认证与静态文件 | `src/http` | `effect/http` 路由，公开 DTO 来自 `packages/protocol`，静态文件从 bundle 旁的 `dist/web` 提供 |
| Project 与事项 | `src/project`、`src/inbox` | Runtime 放置、租约、命令、记忆与事项；查阅 `internal/projectagent`、`projectruntime`、`inbox` |

签名密钥沿用当前规则：`lstat` 确认不存在才生成 Ed25519 私钥并以 `0600` 原子写入，已有文件校验权限、类型和内容。`node:crypto` 提供 Ed25519。

Project 核心位于 `projects.ts` 与 `project-*.ts`，事项和记忆位于 `inbox.ts`、`project-memory.ts`，设备确认位于 `device-management.ts`。共享 `HttpApi` 同时声明这些功能与 Thread 接口。放置循环逐候选取得数据库名额和期限，start、stop、wake 各自领取持久工作；工具业务变更、结果事件和 shell 等待输入消费在同一事务提交。

### batond（`apps/batond`）

| 职责 | 建议位置 | 实现约束与现有查阅入口 |
|---|---|---|
| 设备连接与本地状态 | `src/daemon` | 注册、`up`、WSS 重连、node.db、能力报告与 Worker 发现；查阅 `cmd/batond`、`internal/node` |
| 本地 Thread 执行 | `src/worker` | 账本、命令接收、停止和恢复，由 Baton 独占；provider 接入见 Agent 适配 TECH |
| Agent 接入 | `src/agents` | 注册描述、宿主实现、provider 事件与证据映射；复用代码位于 `packages/providers` |
| 文件与附件 | `src/files` | 登记根内浏览、目录设置与附件解析；保留 `internal/fileaccess` 的路径授权和符号链接边界 |
| 私有文件、时钟与进程 | `src/platform` | 平台差异集中管理，见下文平台实现 |
| Project 执行与订阅 | `src/project` | Runtime 启停、续租、受限 shell 与订阅登录；复用现有 TS Runtime |

Project Runtime 与 agent-host 在发布形态中作为可执行文件的子命令分发。TS 开发入口的 `src/project` 在 WSS 连接循环外拥有 Runtime，`project-runtime.db` 保存启动意图、所属进程和清理证据，断线只替换 RPC transport。`src/devices` 提供目录、文本预览、仓库扫描、执行授权和订阅管理，`src/agents/shell` 使用相同 Worker 保存命令 intent 和完成证据。开发 bundle 仍依赖源码 Runtime 入口与已安装依赖；T5 的 SEA 集成替换该定位方式，设备使用时无需安装系统 Node。

## 平台相关实现

Node 没有 Win32 安全描述符与 Job Object 的 API。第一版不引入原生模块，接受下表 Windows 一列的缺口；第一版之后用一个原生模块同时补上 Job Object 与 DACL 检查，调用点集中在 `src/platform`，其余代码不变。

| 能力 | POSIX | Windows 第一版 |
|---|---|---|
| Agent 进程树回收 | 独立进程组 + watchdog，保证与现在相同 | `taskkill /T /F` + Worker 账本中的 PID 与创建时间，见 Agent 适配 TECH |
| 私有文件 | 创建时 `0600`/`0700`，打开时 `lstat` 检查所有者、权限和类型 | 数据目录创建时用 `icacls` 去掉继承并只授权当前用户，启动时用 `icacls` 输出检查目录 ACL；不再逐个句柄检查 DACL |
| Worker IPC | 私有目录下的 UDS | 命名管道使用 Node 默认安全描述符，不能限定为当前用户；依靠现有 IPC 令牌认证，令牌存于私有数据目录 |
| 含睡眠的单调时间 | 见下段 | 见下段 |

Project Runtime 的租约要计入系统睡眠：设备睡眠期间中心可能已经让租约过期，设备醒来后不能继续认为自己持有租约。Node 只有不含睡眠的 `process.hrtime`，所以租约经过时间取 `max(hrtime 经过值, Date.now 经过值)`。睡眠由墙上时钟计入；墙上时钟回拨时取 hrtime 经过值；墙上时钟前跳只会让租约提前过期，这是安全的方向。Worker 的停止计时只用 hrtime。

## 打包与发布

| 产物 | 内容 |
|---|---|
| `baton-server` 镜像 | Node 26 slim 基础镜像，`apps/server` 的 esbuild bundle 与 `dist/web`；`compose.yaml` 和环境变量不变 |
| `batond` | 每个目标系统一个 Node SEA 可执行文件，入口按 argv 分派到 `up`、`register`、`run`、`worker`、`watchdog`、`agent-host`、`project-runtime` |
| `batond` 附带目录 | 在可执行文件旁的 `node_modules` 中外置完整 `@cursor/sdk`（含 JavaScript）、全部生产依赖、当前系统/架构的平台包，以及 t3code 依赖中的原生模块（如 `@napi-rs/keyring`）；SEA 经 `createRequire` 从该目录加载。此方案已通过 macOS arm64 加载检查；Linux arm64 的 Cursor sandbox helper 要求 glibc 2.39+ |

目标系统为 macOS arm64、Linux x64 与 arm64、Windows x64。SEA 交叉构建用 Node 25.7+ 的 `--build-sea`，需要各目标的官方 Node 二进制；发布脚本从本地缓存目录读取，缓存缺失时报错并给出下载命令，不在构建中隐式联网。Project Agent 不再要求设备自装 Node 22.19+，`runtimes/README.md` 的 sidecar 约定改写为子命令约定。

## 实施切片

切换前分为五个可独立验收的能力切片，详细任务见 [TASKS.md](TASKS.md)。workspace、协议 Schema、SQLite SqlClient、两个协议包及部分测量已有实现，作为输入复核和按需补齐，不再单列基础建设任务。

```text
T1 Cursor 本地可靠会话 ──┬─ T2 网页远程 Thread ── T3 Project 与设备管理 ──┐
                        └─ T4 t3code 接入与历史 ────────────────────────┼─ T5 发布切换
```

T1～T4 已完成，包含各切片所需的协议、持久化、调用方、平台实现、探测替身测试与 Agent 离线转录回放。当前实现提供本地可靠 Thread、网页远程 Thread、Project、事项、目录、附件、设备设置、订阅与受限 shell；Cursor、Pi、Codex、Kiro 通过 t3code fork 的完整 adapter 和 agent-host 接入，Thread 历史使用中心记录。

T5 负责完整安装包、发布切换与系统矩阵复验。Grok、Antigravity 在切换后分别接入，复用 T4 的宿主层。

## 测试依据

fork 中用到的包连同其上游离线测试、回放工具和原始静态转录一起运行。所有适配器行为验证仅依赖本地静态录制、确定性回放和本地替身；测试与验证脚本禁止要求真实 API Key、在线模型推理或外部真实服务联调，也不以在线补录或实机核查证据作为验收前提。TS 测试按产品验收、存储与并发不变量、已知缺陷回归组织。Go 适配器测试不再迁移；上游没有的 Kiro 转录在删除 Go 前转换为 fork 中的测试夹具。

对仍承诺保留的 HTTP 与 WSS 契约保留 Go 导出样例往返测试。调整 Worker IPC 或新增契约时，由 TS Schema 和独立样例验证，不修改冻结的 Go 类型来模拟已实现的新行为。删除 Go 前将仍需使用的转录、协议样例和来源说明移入 TS 包；CI 改为检查 TS 契约及已保留的静态基线，不再依赖 Go 导出器。

`command.completed`、异步接收时序与内部表结构由 TS 自身验证，不做 Go 与 TS 的对照。

## 验证

| 场景 | 失败条件 | 层次 |
|---|---|---|
| 保留的 HTTP / WSS 样例往返及新增 TS 契约（T1、T2） | 字段丢失、取值改变，或内部契约调整后调用方与样例不一致 | 单元测试 |
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
| Windows 第一版的安全缺口 | 进程回收、私有文件、命名管道三项弱于 Go 版 | 已接受，按上文平台相关实现执行 |
| FULL 同步提交耗时 | 官方 Node 26.11.1、Effect 4.0.6，真实 `makeWorker` 串行队列预热 200 次后执行 2000 次 `records.add/remove`，每次提交后让出事件循环。macOS arm64 / Apple M4 / Darwin 27.2.0 / APFS：COMMIT p99 **0.080 ms**、最大 **0.268 ms**，队列操作 p99 **0.181 ms**，事件循环 p99 **1.656 ms**。OrbStack Linux arm64 / 内核 7.2.9 / Docker named volume（Btrfs）：COMMIT p99 **21.680 ms**、最大 **41.063 ms**，队列操作 p99 **23.595 ms**，事件循环 p99 **23.282 ms** | 两个平台此负载的提交 p99 低于 50 ms；Worker 保持逐事务让出。测量覆盖实际账本、提交核查和状态队列，不含 Agent、IPC、输入 intent 或大队列负载，不能推断全部命令接收延迟；Windows、Linux x64 未测。WAL/FULL、`fullfsync=0`，未做断电验证；Linux 为本机虚拟机结果。复现：`tools/ts-migration/worker-startup.mjs 100 --ledger 2000`；单独 SQLite 压力工具为 `sqlite-full.mjs` |
| SEA 冷启动 | 官方 Node 26.11.1 + Effect 4.0.6 + esbuild 0.28.2，完整 Worker 每平台 100 个新进程，包含独占锁、实际 SQLite 迁移、空账本恢复调度、Agent 接入模块加载和 watchdog。macOS arm64：spawn 到认证 status p99 **225.874 ms**、最大 **2058.295 ms**，含 Host 目录与令牌准备的总耗时 p99 **236.225 ms**、最大 **2071.289 ms**。OrbStack Linux arm64：认证 status p99 **624.646 ms**、最大 **638.046 ms**，Host 总耗时 p99 **753.595 ms**、最大 **797.125 ms**。每次确认 SIGTERM 后 Worker、watchdog 退出和锁释放 | 全部样本低于 3 秒；Windows、Linux x64 未测。安装目录仅含 SEA，空 PATH、临时 HOME、每次新建数据库，不加载 Cursor SDK；未清空系统页缓存。Linux 数据位于 VM 的 Btrfs named volume，容器禁止联网。已有大量命令与 intent 的恢复耗时仍需单独验证，T5 复验完整安装包。复现：`tools/ts-migration/worker-startup.mjs`，离线 Linux 命令见工具 README |
| Windows 进程回收实测 | 本机无 Windows / PowerShell 执行环境，`taskkill`、CIM 创建时间及真实 PID 复用均**未测**。提供 `tools/ts-migration/windows-processes.mjs`：完整父子孙进程树回收、故意过期的创建时间与无关存活进程核对、中间父进程先退出后的后代存活检查；创建时间取 `Get-CimInstance Win32_Process` 的 UTC ticks 字符串 | 在 Windows 执行脚本后补实测。过期记录检查不等于操作系统真实复用 PID；脚本不验证 Worker 崩溃至重启之间的延迟。CIM 校验与 taskkill 之间有竞争窗口，无法给出原子排除 PID 复用的保证；第一版已接受的两个进程回收缺口仍保留 |
| `@cursor/sdk` 的原生依赖 | 实测公开包 **1.0.35**，`engines.node >=22.13`，Node 26.11.1 满足；安装禁用脚本。默认入口直接 esbuild 报动态路径解析错误，公开 `/bundled` 入口在 Node SEA 报 `bun:sqlite` 不存在。SEA 用 `createRequire` 加载旁置的完整 SDK、生产依赖和对应平台包，可导入 SDK、打开临时 SQLite store、加载 tree-sitter/Bash `.node` 并运行 ripgrep；移走附带目录时正确失败。macOS arm64 的 sandbox helper `--help` 通过；Linux arm64 helper 要求 **GLIBC_2.39**，当前 Debian 12 / glibc 2.36 无法加载 | macOS arm64 的本地加载检查通过；会话行为统一使用离线 SDK 转录、确定性回放和本地替身验证。Cursor Linux arm64 要求 glibc 2.39+，当前 Debian 12 / glibc 2.36 不满足；其他系统组合按本机依赖与认证检查结果开放，Fedora 43 的本地加载验证待补，缺少该证据不阻止创建。需携带 SDK JS、全部生产依赖及入口可达的平台包；只有原生文件不足。SDK 许可及来源见 `third_party/cursor-sdk/`；加载检查复现 `tools/ts-migration/cursor-sea.mjs`，离线测试入口见 `apps/batond/README.md` |
| 发布用 Node 二进制缓存 | 缓存确定为 `~/.cache/baton/node/v<版本>/`，支持 `BATON_NODE_CACHE` 覆盖；保留官方归档与经 HTTPS 获取的 `SHASUMS256.txt`，解包前校验 SHA256。已获取 v26.11.1：darwin-arm64 tar.gz 为 `d916511b55965e91be7a88e17f88d895b6793ceaba3e6c9b194aefe51c2c65ac`；linux-arm64 tar.gz 为 `170454fb022f5e9b5f6cc76c25fa32ef5100895be44eb04e92f9780591491bbf` | `tools/ts-migration/cache-node.mjs` 仅显式 `--download` 联网，离线缺失时输出下载命令；未校验离线发布签名。Windows x64 / Linux x64 缓存尚未获取；T5 的发布打包继续采用缓存输入 |
