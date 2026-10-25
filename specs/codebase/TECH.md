# 代码库结构整理技术设计

Status: approved
Basis: 代码调查基线 `fbd6e64`；Knip、madge 与按目录统计的 import 图；`apps/server` + `packages/protocol`、batond 核心、Agent 接入 + tools 三个区域的只读审查。不含 `web/` 与 `upstream/`。

## Context

Go → TypeScript 迁移完成后，核心 module 的 interface 已有 depth：`makeWorker` 的 `handle/failed/records` 隐藏了命令幂等、intent、Turn、停止、恢复与 outbox（`apps/batond/src/worker/index.ts:33`），`runtimeRequest` 在一个事务里完成租约 fencing、工具调用、结果事件与输入消费（`apps/server/src/project-runtime.ts:39`），`httpApplication` 统一了路由、安全、静态文件与错误映射（`apps/server/src/http.ts:157`），`spawnOwnedProcess` 与 `@baton/sqlite` 的提交核查也各自封装了正确性敏感的顺序。这些保留不动。

需要整理的是以下三类问题。

- interface 泄漏：调用方要知道本该藏在 module 内部的事实。例如 `daemon/recovery.ts` 直接读 Worker 账本的六张表和 JSON 形状；Project 工具自己处理 `readThread` 的锁参数和 Thread 表结构；授权目录的格式、锁和数量上限同时写在 `daemon/roots.ts` 和 `devices/config.ts`。
- 迁移遗留：`tools/ts-migration/` 实际是现行的构建与开发入口；P0 测量脚本仍在仓库里；`specs/ts-migration/` 被当作现行架构文档引用。
- 文档重复与漂移：模块职责表有 4 份，构建命令有 3 份，测试数据库默认值写在 5 处；另有约 25 处文档与代码不符，没有术语表。

## Proposed changes

### 1. 小清理与工具目录

不涉及 interface 设计，行为不变。

| 项目 | 处理 |
|---|---|
| 无引用文件 | 删除 `apps/batond/src/{agents,daemon,platform}/index.ts`、`agents/cursor/mapping.ts`、`platform/files.ts` 的 `PrivateFiles` 包装、`daemon/roots.ts` 的 `browseDirectories`、`project-scheduling.ts` 的 `projectMaintenance` |
| 多余 export | 约 30 个只在定义文件内使用的符号改为不导出；`agentEnvironment` 与 `hostEnvironment` 统一为一个名字；`dtoSchemas` 在确认 web 不使用后删除 |
| 循环依赖 | 6 处都只涉及类型：`HTTPOptions` 移到 `http/options.ts`；`AgentOutput` 与 `AgentEventIdentity` 定义在同一处；`reports.pendingResult` 的参数收窄为 `{ report, acked }[]`；`DaemonWorkerHost` 移到 `daemon/host.ts` |
| 命名 | 私有文件入口为 `private-file`，宿主命令使用 `BATON_PRIVATE_FILE_HOST_COMMAND`；Runtime 通道使用 `BATON_PROJECT_RUNTIME_TRANSPORT`；stdio 错误码使用 `runtime_stdio_*`。不保留旧名分支（AGENTS.md 守则 5） |
| 依赖声明 | 删除 `apps/server` 的 `esbuild`、`packages/protocol` 的 `vitest` 与 `@effect/vitest`；`tsx` 由 Runtime 包解析，batond 不另外声明 |
| Runtime stdio | `runtimes/project-agent/src/stdio.ts` 由 Runtime 自有，Runtime workspace 只收录 `runtimes/project-agent` |
| 测试辅助 | `testing/cursor/{process-records,watchdog-entry}.ts` 移到 `testing/platform/`；两处回收测试的临时目录在 Scope 结束时删除 |

`tools/ts-migration/` 按用途拆分。根目录的 `build.mjs`、`package-batond.mjs`、`package-release.mjs`、`check-package.mjs` 保留为入口。

| 现路径 | 新路径 |
|---|---|
| `build-{server,batond}.mjs` | `tools/build/{server,batond}.mjs` |
| `run-{server,batond}.mjs` | `tools/dev/{server,batond}.mjs`，两者共用一个 runBundle 函数 |
| `cache-node.mjs` | `tools/release/cache-node.mjs` |
| `worker-startup.mjs` | `tools/measure/worker-startup.mjs`；子进程驱动从 `String.raw` 字符串改为普通源码 `tools/measure/worker-driver.mjs`，由 esbuild 构建 |
| `windows-processes.mjs` | `tools/verify/windows-processes.mjs` |
| `common.mjs` | 隔离环境、临时安装与布局检查移到 `tools/lib/installation.mjs`，`check-package` 与 `package-release` 共用这一份；统计函数随测量脚本 |
| `sqlite-full.mjs`、`sea-startup.mjs` | 删除，`worker-startup --ledger` 与 `check-package` 测的是真实 Worker |
| `cursor-sea.mjs` | 其中 3 项检查（打开 SDK SQLite store、运行 ripgrep、sandbox helper `--help`）并入 `check-package` 后删除 |
| `README.md` | 改写为 `tools/README.md`，只写现行命令 |

`worker-startup` 去掉不带 `--package` 时只打 SEA、不复制旁置依赖的分支，统一要求传入实际安装包。两个 app 的 `dev`、`build` 脚本以及发布工作流里的路径同步修改；脚本搬到不同深度后，按新位置重新推导仓库根目录。

### 2. batond 侧加深

#### 2.1 Worker 账本拥有持久格式（B1）

`worker/ledger.ts` 对外只有三个操作：

```ts
type WorkerLedgerInspection = 'valid' | 'missing' | 'empty' | 'corrupt' | 'retry'

interface OpenWorkerLedger {
  readonly initial: State
  readonly save: (next: State) => Effect.Effect<void, WorkerFailure | SqlError>
}

openWorkerLedger(options: { dbPath: string; dataDirectory?: string }):
  Effect.Effect<OpenWorkerLedger, WorkerFailure | SqlError, Scope.Scope>

inspectWorkerLedger(dbPath: string, expected: WorkerOpenConfig): Promise<WorkerLedgerInspection>
```

`openWorkerLedger` 由持有 Worker 独占锁的进程调用，完成打开、允许的空账本初始化和解码，`initial` 是打开时的快照。已有文件先识别结构再决定是否初始化；部分业务表缺失、无 Meta 却有业务行等确定损坏直接失败，不能被 `CREATE TABLE IF NOT EXISTS` 抹掉。重新读取持久状态要关闭 Scope 后重新打开。

`save(next)` 取代 `save(next, previous)`。账本内部保存上次确认提交的编码基线（序列化记录、已保存事件 ID、进程身份），不引用调用方的可变对象，只在提交确认成功后替换。一次保存的顺序保持现状：新 reply 的完整输出先写入 `FullOutputStore`，原地修改 `next.outbox` 中待发布 report 并限幅，再在一个 FULL 事务里写六张表和 `worker_commit` token。`CommitUnknown` 原样穿过，Worker 继续用 `instanceof` 识别并冻结。任何保存失败后该 handle 作废。

`inspectWorkerLedger` 接受路径和完整 `WorkerOpenConfig`，不接受 `DiscoveredWorker`；路径由 daemon 用 `workerPaths` 计算，账本不依赖 daemon 的类型和 `contentHash`。检查用 `openPrivateFile` 验证权限，再以 `readOnly`、`allowExtension: false`、`timeout: 0` 打开，执行 quick check、结构识别和解码，不建目录或数据库，不执行 DDL、checkpoint、chmod，不用 `immutable` 绕开 WAL。五种结果的划分沿用现行规则：错误码 1/11/26、JSON 与 Schema 失败、配置或身份不符为 `corrupt`；BUSY、LOCKED、READONLY、IOERR、CANTOPEN、权限失败、关闭失败和原因不明为 `retry`。配置比较保持 `contentHash` 的语义（对象键排序、保留数组顺序和全部字段），规范化函数归账本私有。

正常打开和检查共用一组私有解码函数，用 Effect Schema 表达现有字段规则，保留未知字段和 `replyEvidence` 原始字符串，不新增“intent 必须有完整证据”之类的约束，以免把本可进入 unknown 的状态判成损坏。`initialState` 改为私有，`commandAction`、`isPending` 收回 `worker/index.ts`，`reports.ts` 的 `pendingResult` 参数缩为 `{ report; acked }[]`，消除对账本类型的反向依赖。

daemon 只做恢复裁决：`makeWorkerRecovery` 默认的 `inspect` 就是上面的路径转换，测试注入口保留。认证 status、锁检查、文件检查、回读节点账本、按 `awaiting_open/open_attempted` 裁决、持久记录启动事实、历史丢失只报一次，这些顺序和归属不变。

`recovery.test.ts` 里的格式矩阵（SQLite/JSON/代次损坏、残留活动、物理空态、锁占用、权限）迁到新建的 `worker/ledger.test.ts`；daemon 侧用注入的检查结果验证裁决，并保留一例真实账本进入恢复和重启。`full-output.test.ts` 中的保存顺序案例迁入账本测试。账本测试补：保存后重开得到相同状态，修改旧对象不影响基线；同一损坏 payload 在打开和检查得到一致结论；检查前后文件和表清单不变，缺失路径未被创建；真实排他锁得到 `retry`；完整输出写入失败时数据库未推进。

#### 2.2 授权目录合并为一个 module

`daemon/roots.ts` 与 `devices/config.ts` 合并为 `devices/roots.ts`：

```ts
initializeBrowseRoots(dataDir: string, workspace?: string): Promise<readonly BrowseRoot[]>
loadBrowseRoots(dataDir: string): Promise<readonly BrowseRoot[]>
updateBrowseRoots(dataDir: string, change: RootChange): Promise<readonly BrowseRoot[]>
authorizeDirectory(dataDir: string, path: string): Promise<string>
```

所有写入口使用同一把锁、按同一顺序加锁。必须分别保留两种语义：配置不存在时开放主目录；已保存的空列表继续拒绝访问。`isMissing` 改用 `platform/errors.ts` 的 `hasCode`，默认数据目录由 `cli.ts` 传入。改完后 devices 不再依赖 daemon，`project/probe-cache.ts` 对 daemon 的回指也一并去掉。

#### 2.3 Agent 注册、host 装配与探测（B3）

按进程职责提供三个入口，分别放在三个文件里，取消 `agents/registry.ts`、`agents/index.ts` 和 `agent-host/index.ts` 这类聚合导出：

```ts
// agents/thread-agents.ts，Worker 进程使用
makeThreadAgentFactory(options: {
  dataDirectory: string
  command: ProcessCommand
  records: ProcessRecordCallbacks
  watchdog?: ProcessWatchdog
}): AgentFactory

// agents/probe.ts，daemon 与普通 CLI 使用
probeAgents(options: {
  dataDirectory: string
  agentTypes?: readonly HostedAgentType[]
  signal?: AbortSignal
}): Promise<readonly RuntimeAgent[]>

// cli/agent-host.ts，只从 CLI 的 agent-host 分支动态导入
runAgentHostCommand(agentType: string, paths: AgentHostPaths): Effect.Effect<void, unknown, Scope.Scope>
inspectAgentHostModules(): Promise<HostInstallation>
```

`agents/catalog.ts` 是唯一的能力来源，只含字面量和 type-only import：类型、名称、能力、限制文案，以及从 `kind: 'hosted'` 派生的 `HostedAgentType`。不保存 factory、probe 函数或 loader。`agents/capabilities.ts` 删除，Worker 的 steer 接收检查改读 catalog。

`makeThreadAgentFactory` 按 `agent_type` 分派：hosted 类型统一走 `makeAgentHostFactory`，shell 走 `makeShellAgentFactory`，四份 Agent 的一行包装删除。通用 host factory 的选项改名 `HostedAgentOptions`，以必填的 `capabilities: Pick<Capabilities, 'steer' | 'switch_model'>` 取代 `steer` 字段，ThreadAgent 不再反查全局能力。路径推导（`working_directory` 与 `dirname(adapter_config.state_path)`，要求绝对路径）收进 factory。构造 factory 和 ThreadAgent 都不做 I/O；未知类型同步抛 `AgentError`。测试替换连接用现有 internal seam，公开 interface 不加 transport 参数。

`probeAgents` 合并四份 `agents/*/probe.ts`。缺省按 Cursor、Pi、Codex、Kiro 顺序并发探测；指定类型时按请求顺序去重，shell 和未知类型在启动任何探测前拒绝。单个 Agent 的流程保持现状：安装预检（Cursor 用 `sdk-inspection.ts` 和显式 API key 检查）、POSIX watchdog 或 Windows `agent-probes/<agentType>` 登记加锁并恢复旧记录、私有临时目录、`connectAgentHost` 只调用 `probe`（30 秒预算）、abort → disconnect → reap → 删目录 → 释放锁。登记只在确认回收或身份失效后删除；并发锁、损坏状态、身份冲突的处理不变。`hostedAgentReport` 成为私有函数，报告规则（可用性、unverified、Cursor fallback、模型去重与默认模型）不变。取消时等清理完成后拒绝 Promise。

`cli/agent-host.ts` 持有 loader 表，逐项字面量 `import()`，以 `satisfies Record<HostedAgentType, () => Promise<AgentHostModule>>` 保证与 catalog 一致。正常运行只加载选中的 module，再进入现有 `runAgentHost`；未知类型在加载前失败。`inspectAgentHostModules` 承担 `agent-host --probe`：实际加载全部 module，并保留 SEA 下 keyring、Cursor 资产与 tree-sitter 的检查，输出形状不变。`runAgentHost` 的进程内选项改名 `HostRunOptions`，与 `HostedAgentOptions` 区分。`AgentHostPaths` 移到纯类型文件 `agent-host/paths.ts`。

Worker 不加载 SDK 和 host driver 由构建检查保证。`buildBatond` 从 `daemon/worker-runner.ts` 与 `worker/index.ts` 遍历运行时可达图（静态 import/re-export、字面量动态 import、require、external 名称，排除 type import），禁止到达 `cli.ts`、`cli/**`、`agents/probe.ts`、任一 `host-module.ts`/`host-driver.ts`、`agent-host/{host,host-layer,driver}.ts`、`sdk-loader.ts`、`@cursor/sdk` 和 provider 运行包；Worker 可达的本地源码禁止无法静态解析的动态加载。检查只分析，不另出 Worker bundle，发布布局不变。

新增 Grok 或 Antigravity 时，B3 范围内改 catalog 一项、loader 表一项，再加该 Agent 自己的 host module 与 driver。Worker、daemon、通用 ThreadAgent 和公共 probe 不改；有特殊安装预检时才在 probe 里加对应分支。四个 host driver 的行为差异留在各自 adapter。

测试迁移：`registry.test.ts` 的报告场景改为经 `probeAgents` 验证，不再 mock 整个 sdk-loader；`probe.test.ts` 四份同形生命周期用例合为一组（成功、失败、超时、取消），回收失败保留登记、并发锁、身份冲突、损坏状态的用例迁到公共入口；四个 `host.integration.test.ts` 改用统一 factory，Pi 回执丢失、终态抢先、steer/queue 用例保留；`cursor/evidence.test.ts` 迁为 `agent-host/evidence.test.ts`。新增：导入图检查及一个经 barrel 或动态 import 绕入的反例；实际 bundle 中 SDK 一经加载即失败时 Worker 仍认证就绪（复用 A1 的回归）；host 装配契约（loader 穷尽、未知类型加载前失败、inspect 加载全部 module）。

#### 2.4 Runtime 凭据文件与 RPC

- `FileCredentials` 对外 interface 不变，继续负责 OAuth 事务与跨进程锁。直接文件操作与 private-file host 是两个内部 adapter，跑同一套契约测试，包括属主、类型、权限、64 KiB 上限、symlink/hardlink、缺失文件和原子替换。权限规则统一为 platform 现有的严格版本。helper 启动命令从 `platform/private-file-host.ts` 移到 `project/runner.ts`，放在 `defaultRuntimeCommand` 旁边。
- `checkedRPC` 按 operation 关联结果类型，在 seam 上集中做结构校验。pi-ai payload 的扩展字段原样保留，operation 在线上的含义不变。

### 3. 中心与 protocol 侧加深

#### 3.1 Project Runtime 以 runtimeRequest 为唯一入口

`projects.ts`、`project-*.ts` 移入 `apps/server/src/project/`。`executeProjectTool`、`waitProjectTool`、`consumeProjectExecInputs` 改为 module 内部函数。测试改走 `runtimeRequest`：先把 `project-tools.integration.test.ts` 里手工 `INSERT tool_result` 的片段独有的断言迁到完整场景，再删除这些片段。纯 JSON 分页与 base64 截断仍按内部 in-process 测试保留。事务行为不变，包括 pending 查询不等待 Agent 写锁、租约失效回滚和结果重放。

#### 3.2 Thread 读取接受访问范围

`threads*.ts` 移入 `apps/server/src/threads/`，读取接口增加访问范围：

```ts
type ThreadScope = { employeeId: string; projectId?: string }
view(scope: ThreadScope, threadId: string): DB<ThreadView>
readTurns(scope: ThreadScope, threadId: string,
  query: { afterTurn?: number; throughTurn?: number }): DB<ThreadHistoryPage>
```

Project 工具不再自己调用 `ownedThread(..., true)`，也不再直接解释 Thread 表结构。`readThread`、`audit`、`enqueue` 等留在内部。另外三个函数换到语义对应的位置：通用 `transaction` 并入 `database.ts`，`canonical/digest` 移入内部 JSON 工具，`directoryAllowed` 移入共享的目录规则。锁顺序不变，通知输入仍不取 Agent 锁。

#### 3.3 protocol 按领域组织

`dto.ts` 拆为 `thread.ts`、`project.ts`、`device.ts`、`auth.ts`、`inbox.ts`。`node.ts`、`worker.ts`、`http-api.ts` 只负责传输层的组合，领域 Schema 不反向依赖它们。

- `ThreadSummary`、`ThreadView` 从 `Thread` 的字段派生，派生时保留整体检查。
- `SessionResponse`、`EnrollmentResponse` 只在 `auth.ts`、`device.ts` 定义一次，`http-api.ts` 引用后只添加 HTTP 元数据。合并时保留当前实际生效的约束：`csrf_token` 与 `expires_at` 以 `http-api.ts` 中的定义为准。

#### 3.4 HTTP 依赖收窄

`apps/server/src/http*.ts` 移入 `http/`。`HTTPOptions.gateway` 收窄为 `Pick<Gateway, 'request' | 'notify' | 'disconnect' | 'disconnectBrowsers' | 'diagnostics'>`，测试中的 `unknown as Gateway` 随之删除。`http-thread-settings.ts` 并回它唯一的 handler。

### 4. 文档

每类事实只放一处，其他文档链接过去。

| 文档 | 只放 |
|---|---|
| `README.md` | 简介、环境要求、构建、中心部署、设备接入、配置参考、文档索引 |
| `AGENTS.md` | 目录职责表（唯一一份）、开发与验证命令（唯一一份）、Effect 规则、守则、测试取舍 |
| `.agents/PROJECT.md` | 工单与提交约定；验证命令改为链接到 AGENTS.md |
| `GLOSSARY.md`（新增） | 领域术语、一句话定义、代码中的名字、易混点；合并两份 PRODUCT 的术语表，PRODUCT 改为链接 |
| `specs/baton/TECH.md` | 全景、技术选择（吸收迁移 TECH 的技术选型与实现原则、DATABASE.md 的结论）、平台相关实现、数据、协议、验证；删除「模块职责」表 |
| `specs/release/TECH.md`（新增） | 打包与发布、安装包检查、测量结果、Windows 待修项、第一版之后 |
| `tools/README.md` | 构建、打包、检查、测量脚本的用法 |
| 各 app 与子目录 README | 本目录的实现要点与测试入口，不重复部署命令 |

删除 `specs/ts-migration/` 整个目录。`specs/agent-adapters/TECH.md` 删除「实施状态」节，状态改为 approved。各 spec 头部的调查基线提交号和「Owner: 待指定」一并删除。R-16、R-24 的负载阈值标为第一版之后。

文档与代码不一致处以代码为准，原地修订。涉及可观察行为的两处如下：

- `specs/baton/TECH.md:107`（停止）：改为「回收执行实例和所属进程、确认后写 `thread.stopped`」。
- `specs/baton/TECH.md:233`（崩溃恢复）：改为实际流程。普通 Agent 先回收旧进程，为已发送的活动输入补结束报告，再按持久的 queued 消息或显式请求决定是否恢复会话；shell 走独立的完成证据路径。

其余条目见审查报告第 4 节，例如各 Agent README 的提问处理、Kiro 的版本准入、账本物理表、Project 租约注入接口、e2e 替身范围、`runtimes/README` 的 stdio 归属。

## Testing and validation

整理以不改变行为为前提，主要靠现有测试兜底；新增测试只覆盖拆分后的新 interface 和发现的缺口。

| 范围 | 设置与观察 | 失败条件 | 位置 | Status |
|---|---|---|---|---|
| 全部 | `pnpm check`、`pnpm typecheck`、`pnpm test`、`node --test tools/*.test.mjs` | 任一失败 | 本地 + CI | planned |
| 工具目录与命名 | `node tools/build.mjs` 后运行 `node tools/check-package.mjs bin`；手动触发一次发布工作流 | 安装包检查失败，或发布工作流引用了不存在的路径 | 本地 + release 工作流 | planned |
| 账本检查（2.1） | 损坏、锁占用、代次不符、缺失的账本文件 | 检查写入或创建了文件；retry 被判成损坏；可能交付过 open 后新建了空会话 | 包内单测 + daemon 恢复测试 | planned |
| 授权目录（2.2） | 不存在配置、空列表、并发更新、symlink 越界、数量上限 | 空列表被当成未配置；并发更新丢失；越界路径被授权 | 包内单测 | planned |
| Agent 注册（2.3） | Worker 就绪路径；四个 host 回放；安装包检查 | Worker 进程加载了 SDK 或 host driver；能力或默认模型报告变化 | 包内单测 + host 回放 + 打包检查 | planned |
| 凭据文件（2.4） | 两个 adapter 跑同一套契约测试 | 两个 adapter 结果不一致；指定 host 失败时没有返回错误 | Runtime 测试 | planned |
| 中心（3.1～3.4） | 现有 PostgreSQL 集成测试 | 现有断言失败；工具副作用与结果事件不在同一事务 | 集成测试 | planned |
| protocol（3.3） | 一个 Thread 派生对象的往返样例，以及现有协议测试 | 字段约束变化；派生对象丢失整体检查 | 协议单测 | planned |
| e2e Cursor | 补一条经真实 Cursor host replay 的网页发送、停止、恢复链路 | 链路不通 | e2e | planned |

## Open questions

无。
