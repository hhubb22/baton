# TypeScript 迁移技术设计

Status: draft
Owner: 待指定
Basis: [Baton TECH](../baton/TECH.md)；[Agent 适配 TECH](../agent-adapters/TECH.md)；Baton `32d5fff`；t3code `9828cad49f3e1ef4f9e037b3baaca19f4e4928fc`。

## 目标与切换方式

Coordinator、batond 和 Session Worker 全部改用 TypeScript + Effect 4，与 Agent 适配规格同时实施，一次切换。切换前发布和部署的始终是 Go 版；切换提交同时启用 TS 版的构建与发布、删除 Go 代码。任何时候都不存在 Go 进程与 TS 进程互相通信的发布形态，因此协议不需要为两种实现之间的兼容让步。

| 规则 | 内容 |
|---|---|
| 开发位置 | TS 代码在 main 上的新目录开发（见下文仓库结构），频繁合入；`tools/build.mjs` 在切换前不构建它们 |
| Go 冻结 | 本规格批准后，Go 代码只接受阻塞当前使用的修复。Agent 适配规格的全部改动只在 TS 版实现 |
| 行为基准 | 冻结时的 Go 版行为加上 Agent 适配规格的改动。浏览器 HTTP API、节点 WSS 协议、Worker IPC、PostgreSQL schema 的结构保持不变，只加入适配规格新增的字段 |
| 本地数据 | 按实验室阶段约定不迁移：切换后设备重新注册、Worker 账本与 node.db 重建；中心数据库可保留，因为 schema 只增加字段 |
| 切换条件 | 下文验证表全部通过 |

## 技术选型

| 位置 | 技术 | 说明 |
|---|---|---|
| 运行时 | Node 26（2026 年 10 月下旬进入 LTS） | 设备端由 SEA 携带，不依赖设备上安装的 Node |
| 语言 | TypeScript 6.0，与 `web/` 相同 | Effect 4 要求 5.9+。TS 7 原生编译器已 GA，但 typescript-eslint 的类型检查依赖 TS 的 JS API，是否支持 TS 7 未核实，第一版之后再评估 |
| 框架 | `effect` 4.0.6，`@effect/platform-node`、`@effect/sql-pg`、`@effect/vitest` 同版本 | pnpm catalog 统一锁定。HTTP 用 `effect/http`，子进程用 `effect/process`，Worker 与 cursor-host 之间用 `effect/rpc` |
| WebSocket | `ws` | 中心的节点与浏览器两个端点，以及 batond 的出站连接；需要自定义握手头和 TLS 参数 |
| 中心存储 | PostgreSQL 16+，`@effect/sql-pg`，手写 SQL | 沿用 `migrations/0001_initial.sql`，不引入 ORM |
| 设备存储 | `node:sqlite`，WAL + `synchronous=FULL` | 参考 t3code `nodeSqliteClient.ts` 包装成 Effect `SqlClient` |
| 测试 | Vitest + `@effect/vitest` | PostgreSQL 集成测试沿用 `BATON_TEST_DATABASE_URL` 和自动拉起本机实例的逻辑 |
| 静态检查 | ESLint + typescript-eslint，Prettier | 与 `web/` 共用配置 |
| 打包 | esbuild 产出单文件 JS；batond 再打成 Node SEA | 服务端在 Docker 中直接用 Node 运行 bundle |
| Agent 协议 | `effect-acp`、`effect-codex-app-server`（从 t3code 引入），`@cursor/sdk` | 见 Agent 适配 TECH |

Web 保持 React + Vite，不引入 Effect。Project Agent Runtime 保持现有实现，只改为 batond 的子命令（见下文打包）。

## 仓库结构

```text
pnpm-workspace.yaml          catalog 锁定 effect、typescript、vitest 等版本
apps/server/                 Coordinator（baton-server）
apps/batond/                 batond 及其子命令：worker、watchdog、cursor-host、project-runtime
packages/protocol/           Effect Schema：HTTP DTO、节点信封、Worker IPC、ThreadReport、HistoryEntry
packages/effect-acp/         从 t3code 引入
packages/effect-codex-app-server/  从 t3code 引入
runtimes/project-agent/      现有 Project Agent Runtime，作为 workspace 包被 apps/batond 引用
web/                         现有前端，构建产物输出到 apps/server/dist/web
migrations/                  SQL 迁移（保留）
third_party/t3code/          MIT 许可与来源记录
```

切换提交删除 `cmd/`、`internal/`、`go.mod`、`go.sum`、`migrations/embed.go`、`runtimes/shared/`，并更新 `AGENTS.md`、`README.md`、`runtimes/README.md` 和 `specs/baton/TECH.md` 的技术选择、模块职责、部署与验证章节。

## 模块对照

### Coordinator（`apps/server`）

| Go 包 | TS 位置 | 要点 |
|---|---|---|
| `internal/store` | `src/store` | 事务与版本检查原样转写为 SQL；每个函数的 Go 测试作为用例清单 |
| `internal/migrate`、`migrations` | `src/migrate` | 版本化 SQL、`serve` 先 Up 后 Check 的流程不变 |
| `internal/gateway` | `src/gateway` | 节点认证、连接代次、心跳、限流、有界队列；队列用 Effect `Queue` 的有界策略 |
| `internal/control`、`delivery`、`inbox` | `src/control`、`src/inbox` | 命令派发、报告回执、期限扫描；新增 outbox 完成字段 |
| `internal/httpapi`、`auth`、`admin` | `src/http` | `effect/http` 路由，DTO 来自 `packages/protocol` |
| `internal/projectagent`、`projectruntime` 的中心部分 | `src/project` | Project 放置与 Runtime 命令 |
| `internal/webui` | `src/http/static` | 从 bundle 旁的 `dist/web` 目录提供静态文件 |
| `internal/redact`、`config`、`db`、`identity` | `src/shared` | 按需转写 |

签名密钥沿用当前规则：`lstat` 确认不存在才生成 Ed25519 私钥并以 `0600` 原子写入，已有文件校验权限、类型和内容。`node:crypto` 提供 Ed25519。

### batond（`apps/batond`）

| Go 包 | TS 位置 | 要点 |
|---|---|---|
| `cmd/batond`、`internal/node` | `src/daemon` | 注册、`up`、出站 WSS、node.db、能力报告、Worker 发现与启动、Project Runtime 启停与续租、订阅登录 |
| `internal/session`、`internal/agent/*` | `src/worker`、`src/agents` | 见 Agent 适配 TECH |
| `internal/fileaccess` | `src/files` | 登记根内浏览与附件解析：`realpath` 后判断前缀，POSIX 以 `O_NOFOLLOW` 打开 |
| `internal/privatefile` | `src/platform/private-file` | 见下文平台实现 |
| `internal/sidecar` | 删除 | Project Runtime 与 cursor-host 都是同一可执行文件的子命令 |
| `internal/monotime` | `src/platform/clock` | 见下文平台实现 |
| `cmd/batond/project_exec.go`、`internal/projectexec` | `src/project` | Project Agent 的受限命令执行 |

## 平台相关实现

Node 没有 Win32 安全描述符与 Job Object 的 API。第一版不引入原生模块，接受下表 Windows 一列的缺口；第一版之后用一个原生模块同时补上 Job Object 与 DACL 检查，调用点集中在 `src/platform`，其余代码不变。

| 能力 | POSIX | Windows 第一版 |
|---|---|---|
| Agent 进程树回收 | 独立进程组 + watchdog，保证与现在相同 | `taskkill /T /F` + Worker 账本中的 PID 与创建时间，见 Agent 适配 TECH |
| 私有文件 | 创建时 `0600`/`0700`，打开时 `lstat` 检查所有者、权限和类型 | 数据目录创建时用 `icacls` 去掉继承并只授权当前用户，启动时用 `icacls` 输出检查目录 ACL；不再逐个句柄检查 DACL |
| Worker IPC | 私有目录下的 UDS | 命名管道使用 Node 默认安全描述符，不能限定为当前用户；依靠现有 IPC 令牌认证，令牌存于私有数据目录 |
| 含睡眠的单调时间 | 见下段 | 见下段 |

Project Runtime 的租约要计入系统睡眠：设备睡眠期间中心可能已经让租约过期，设备醒来后不能继续认为自己持有租约。Node 只有不含睡眠的 `process.hrtime`，所以租约经过时间取 `max(hrtime 经过值, Date.now 经过值)`。睡眠由墙上时钟计入；墙上时钟回拨时由 hrtime 兜底；墙上时钟前跳只会让租约提前过期，这是安全的方向。Worker 的停止计时只用 hrtime。

## 打包与发布

| 产物 | 内容 |
|---|---|
| `baton-server` 镜像 | Node 26 slim 基础镜像，`apps/server` 的 esbuild bundle 与 `dist/web`；`compose.yaml` 和环境变量不变 |
| `batond` | 每个目标系统一个 Node SEA 可执行文件，入口按 argv 分派到 `up`、`register`、`run`、`worker`、`watchdog`、`cursor-host`、`project-runtime` |
| `batond` 附带目录 | 只放无法打进 SEA 的原生依赖的 `node_modules`（如 `@cursor/sdk` 有原生部分）；t3code 的 `build-exe` 采用同样做法 |

目标系统为 macOS arm64、Linux x64 与 arm64、Windows x64。SEA 交叉构建用 Node 25.7+ 的 `--build-sea`，需要各目标的官方 Node 二进制；发布脚本从本地缓存目录读取，缓存缺失时报错并给出下载命令，不在构建中隐式联网。Project Agent 不再要求设备自装 Node 22.19+，`runtimes/README.md` 的 sidecar 约定改写为子命令约定。

## 工作分解

```text
P0 基础 ──┬─ C 中心 ──────────┐
          ├─ D 设备守护进程 ───┼─ X 切换
          └─ W Worker 与适配器 ┘
```

| 编号 | 内容 | 依赖 | 完成标志 |
|---|---|---|---|
| P0 | workspace、catalog、ESLint/Prettier/Vitest 配置；引入两个 t3code 协议包；`packages/protocol` 覆盖全部 HTTP DTO、节点信封和 IPC 消息；从 Go 测试导出协议样例到 `packages/protocol/fixtures`；`node:sqlite` 的 SqlClient 包装；四项测量（见验证） | 无 | TS 解码并重新编码全部样例后与原文等价；测量结果写入本文待验证表 |
| C | Coordinator 全部模块；Agent 适配规格的中心部分（reason、outbox 完成字段、统一历史转发） | P0 | Store、Gateway、HTTP 的用例清单全部通过；用协议样例驱动的假节点跑通 Thread 主链路 |
| D | batond 守护进程、node.db、文件浏览、订阅登录、Project Runtime 管理、SEA 打包 | P0 | 对假中心完成注册、重连、能力上报、文件浏览、Project Runtime 续租；三个系统上 SEA 启动 |
| W | Agent 适配规格的实施顺序第 1～3 项（Worker、Pi/Codex/Kiro、统一历史、Cursor） | P0 | 现有转录在 TS Worker 上的 ThreadReport 序列与账本终态和 Go 版相同；适配规格验证表中对应各行通过 |
| X | 三者连起来跑端到端；切换构建、发布与 Docker；删除 Go；更新长期文档 | C、D、W | 下文验证表全部通过 |

C、D、W 只通过 `packages/protocol` 互相依赖，可交给三个 thread 并行。任一方需要改协议时先改 `packages/protocol` 和样例，单独合入，再各自实现。Agent 适配规格的第 4、5 项（Grok、Antigravity）在切换之后进行。

Go 测试约 3.8 万行，不逐行翻译。每个模块以对应 Go 测试的用例名和断言作为清单，在 TS 中用 Vitest 重写；回放转录和协议样例直接复用。

## 验证

| 场景 | 失败条件 | 层次 |
|---|---|---|
| 协议样例往返（P0） | 任一样例解码失败，或重新编码后字段丢失、取值改变 | 单元测试 |
| `node:sqlite` FULL 同步连续提交，三个系统各测 p99 与事件循环延迟（P0） | p99 超过 50 ms 且没有改到 `worker_threads` | 基准测试 |
| batond SEA 与 Worker 子命令冷启动到 IPC 就绪，三个系统（P0） | 超过 Host 的 3 秒就绪预算 | 基准测试 |
| Windows `taskkill` 回收与 PID 账本，含孙进程和 PID 复用（P0） | 误杀无关进程；结果与 Agent 适配 TECH 所述缺口不符 | 进程测试 |
| `@cursor/sdk` 能否打进 SEA，原生部分是否只需附带目录（P0） | 运行时找不到模块，或需要设备上另装依赖 | 打包检查 |
| Baton TECH 验证表 R-01～R-25 各行（X） | 任一行在 TS 版上失败 | 原测试层次 |
| Agent 适配 TECH 验证表中实施顺序第 1～3 项对应各行（W、X） | 同该表 | 同该表 |
| 真实 Codex、Kiro、Pi、Cursor 在 macOS、Linux、Windows 上跑 PRODUCT 验收的多轮、排队、停止和恢复（X） | 任一组合失败且未标为不支持 | 门控真实验证 |
| 中心重启、batond 重启、Worker 被杀、PostgreSQL 短停（X） | 消息重发、回复重复、同步前设备显示可用 | 进程测试 |

切换提交前执行 `pnpm -r typecheck`、`pnpm -r lint`、`pnpm -r test`、`pnpm --dir web build` 和 SEA 打包检查。

## 第一版之后

| 项目 | 原因 |
|---|---|
| Windows Job Object 与逐句柄 DACL 检查 | 需要原生模块；第一版用 taskkill 和目录 ACL |
| Windows 命名管道限定当前用户 | 同上 |
| TS 7 原生编译器 | 先确认 typescript-eslint 支持 |
| Worker 账本移到 `worker_threads` | 只在 P0 测量超标时提前 |

## 待验证与批准事项

| 项目 | 当前依据与缺口 | 处理 |
|---|---|---|
| Windows 第一版的安全缺口 | 进程回收、私有文件、命名管道三项弱于 Go 版 | 已接受，按上文平台相关实现执行 |
| FULL 同步提交耗时 | 未测量 | P0 |
| SEA 冷启动 | 未测量 | P0 |
| `@cursor/sdk` 的原生依赖 | 未安装核查 | P0 |
| 发布用 Node 二进制缓存 | SEA 交叉构建需要各目标的官方 Node，现有 Go 交叉编译没有这项依赖 | 已接受；P0 确定缓存位置与校验和记录方式 |
