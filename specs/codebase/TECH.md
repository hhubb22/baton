# 代码库结构整理技术设计

Status: implemented
Basis: 中心、节点、Worker、Runtime 与协议的现行实现；[Baton TECH](../baton/TECH.md)、[发布设计](../release/TECH.md)。范围不含 Web 实现与上游 provider 内部实现。

## Context

Worker 的 `handle/failed/records` 隐藏命令幂等、intent、Turn、停止、恢复与 outbox；中心 `runtimeRequest` 在事务中组织租约校验、工具调用、结果事件和输入消费；`httpApplication` 组织路由、安全、静态文件与错误映射。进程所有权与 SQLite 提交核查各有独立入口。

目录职责与开发验证入口集中在 [AGENTS.md](../../AGENTS.md)，术语及代码名字集中在 [GLOSSARY.md](../../GLOSSARY.md)。本设计说明模块边界、依赖方向与验证要求。

## 实现

### 1. 工具与进程入口

构建、开发、发布、测量和平台检查分别位于 `tools/{build,dev,release,measure,verify}`；安装布局、依赖复制及隔离运行辅助逻辑位于 `tools/lib/`。根工具入口为 `build.mjs`、`package-batond.mjs`、`package-release.mjs` 与 `check-package.mjs`，参数见 [工具说明](../../tools/README.md)。

Worker 测量要求完整安装包。`measure/worker-driver.mjs` 是独立源码，由 esbuild 生成测量驱动；SQLite store、ripgrep 与 sandbox helper 的加载检查由正式安装包检查负责。构建检查与测量分别验证安装布局和实际 Worker，不依赖精简的实验 SEA。

私有文件宿主命令为 `private-file`，通过 `BATON_PRIVATE_FILE_HOST_COMMAND` 指定；Runtime 通道为 `BATON_PROJECT_RUNTIME_TRANSPORT`，stdio 错误使用 `runtime_stdio_*`。Runtime 的 stdio 实现位于 `runtimes/project-agent/src/stdio.ts`，宿主拥有自己的帧读写实现。

HTTP 选项、Agent 事件身份与 daemon Worker host 等共享类型放在被使用方单向引用的位置。公共进程测试辅助位于 `apps/batond/src/testing/platform/`，临时目录由测试 Scope 清理。

### 2. 节点模块边界

#### 2.1 Worker 账本

`apps/batond/src/worker/ledger.ts` 拥有持久格式、解码、保存基线与只读检查：

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

调用方持有 Worker 独占锁再打开账本。已有文件先识别结构，部分业务表缺失、没有 Meta 却存在业务行等确定损坏直接失败。`initial` 是打开时的快照；重新读取持久状态需要关闭 Scope 后重新打开。

账本内部保存上次确认提交的编码基线，不引用调用方的可变对象。保存先写新 reply 的完整输出，再更新和限幅待发布 report，最后在同一 FULL 事务写入业务表和 `worker_commit` token。只有确认提交成功才推进基线；保存失败后 handle 作废。`CommitUnknown` 原样交给 Worker 冻结执行。

只读检查接收路径和完整 `WorkerOpenConfig`，不依赖 daemon 的发现对象。它验证私有文件后，以 `readOnly`、`allowExtension: false`、`timeout: 0` 打开 SQLite，执行 quick check、结构识别和共同解码；不建目录、数据库或业务表，不执行 checkpoint、chmod 或 `immutable` 读取。SQLite 读取 WAL 时可能保留或创建 `-wal`、`-shm`，检查不另外删除这些辅助文件。

错误码 1/11/26、JSON/Schema 失败及配置身份不符归为 `corrupt`；BUSY、LOCKED、READONLY、IOERR、CANTOPEN、权限或关闭失败及不明原因归为 `retry`。配置比较对对象键排序，保留数组顺序与全部字段。解码保留未知字段及原始 `replyEvidence` 字符串，允许恢复流程将证据不足的 intent 判为 unknown。

`daemon/recovery.ts` 只负责恢复裁决：按认证 status、锁、文件检查与节点账本事实判断是否重连或重启，持久区分 `awaiting_open` 与 `open_attempted`，历史丢失只报告一次。daemon 不解释 Worker 表的 JSON。

#### 2.2 授权目录

`devices/roots.ts` 提供 `initializeBrowseRoots`、`loadBrowseRoots`、`updateBrowseRoots` 和 `authorizeDirectory`。所有写入口共用锁及加锁顺序。配置不存在时初始化主目录；已保存的空列表继续拒绝访问。授权按真实路径检查，配置更新保留数量上限。默认数据目录由 CLI 传入，devices 不依赖 daemon。

#### 2.3 Agent 装配与探测

`agents/catalog.ts` 是类型、名称、能力与限制文案的唯一来源，只含字面量与 type-only import；`HostedAgentType` 从 hosted 项派生。

Worker 使用 `agents/thread-agents.ts` 的 `makeThreadAgentFactory`，hosted 类型进入通用 host factory，shell 使用受限 shell factory。工厂与 ThreadAgent 的构造不做 I/O；未知类型同步抛 `AgentError`。通用选项为 `HostedAgentOptions`，显式接收 `capabilities`；路径验证及 store 目录推导在工厂内完成。

daemon 和 CLI 使用 `agents/probe.ts` 的 `probeAgents`。默认按 Cursor、Pi、Codex、Kiro 顺序并发探测，指定列表按请求顺序去重；未知类型或 shell 在启动探测前拒绝。每个探测执行安装预检、登记和加锁、旧记录恢复、私有临时目录、30 秒 host probe、断开与回收，再删目录和释放锁。只有确认进程回收或身份失效后才删除登记；取消等待清理完成。

`cli/agent-host.ts` 持有穷尽的字面量动态 loader 表，正常运行只加载所选 module；安装检查加载全部 module，并在 SEA 中核查 keyring、Cursor 资产和 tree-sitter。进程内运行选项为 `HostRunOptions`，路径类型位于 `agent-host/paths.ts`。

构建从 `daemon/worker-runner.ts` 和 `worker/index.ts` 遍历运行时可达图，检查静态导入、再导出、字面量动态导入、require 和 external 包，排除 type import。Worker 不得到达 CLI、probe、host module/driver、SDK loader 或 provider 运行包；本地可达源码中的动态加载必须能静态解析。检查不生成第二份 Worker bundle。

新增 hosted Agent 需要 catalog 项、loader 项及自身 host module/driver；有特殊安装预检时才调整公共 probe。原生协议与行为差异留在各 Agent adapter。

#### 2.4 Runtime 凭据与 RPC

`FileCredentials` 统一提供 OAuth 事务与跨进程锁。直接文件访问和 private-file host 是内部两种 adapter，运行同一套属主、类型、权限、64 KiB 上限、链接、缺失文件与原子替换契约测试。helper 启动命令与 Runtime 定位共同位于 `project/runner.ts`。

`checkedRPC` 按 operation 关联结果类型，在调用边界集中做结构校验；pi-ai payload 的扩展字段原样保留。

### 3. 中心与协议模块边界

#### 3.1 Project Runtime

`apps/server/src/project/` 内文件按职责命名为 `runtime.ts`、`tools.ts`、`inputs.ts`、`events.ts`、`compaction.ts`、`store.ts`、`memory.ts`、`scheduling.ts`、`view.ts` 和 `preview.ts`，员工操作入口为 `projects.ts`。测试文件使用同样的名称。

`runtimeRequest` 是 Runtime 工具请求的唯一业务入口，内部完成工具执行、结果事件与 shell 输入消费。副作用和结果同事务提交；租约失效回滚。重复请求重放已保存结果；pending 查询使用不等待 Agent 写锁的只读路径。工具测试经保存 assistant 调用和真实租约进入该入口，纯 JSON 分页与 base64 截断保留进程内测试。

#### 3.2 Thread 读取

`threads/` 拥有命令、状态、报告与历史投影。`view` 和 `readTurns` 接受 `{ employeeId, projectId? }`；指定 Project 时在入口校验员工与 Project 归属。Project 工具不解释 Thread 物理行，也不向内部读取传锁参数。

事务辅助位于 `database.ts`，JSON 规范化与摘要位于 `json.ts`，目录规则位于 `directories.ts`。工具和报告沿用同一 SQL 事务及锁顺序；Thread 通知写入不取得 Agent 锁。

#### 3.3 领域协议

`packages/protocol/src/{thread,project,device,auth,inbox}.ts` 定义领域 Schema；`node.ts`、`worker.ts` 与 `http-api.ts` 组合传输契约。领域 Schema 不反向依赖传输层。

`ThreadSummary` 与 `ThreadView` 从 `Thread` 派生，保留整体检查。`SessionResponse` 和 `EnrollmentResponse` 分别在 auth、device 中唯一定义，HTTP 层引用并添加元数据。未知字段、动态 JSON、字段省略与 HTTP 严格解码按各传输入口的既有契约处理。

#### 3.4 HTTP

`http/` 提供应用入口、handlers、安全校验和选项。`HTTPOptions.gateway` 只要求 `request`、`notify`、`disconnect`、`disconnectBrowsers` 与 `diagnostics`。Thread settings handler 与其他 Thread handler 共处同一模块。校验保持 Origin、会话/CSRF/改密、资源归属、正文解码的顺序。

### 4. 文档

每类事实有一个维护入口，其他文档通过链接引用。

| 文档 | 内容 |
|---|---|
| [README.md](../../README.md) | 简介、环境要求、构建、中心部署、设备接入、配置参考与索引 |
| [AGENTS.md](../../AGENTS.md) | 唯一目录职责表、开发验证命令、Effect 规则、开发守则与测试取舍 |
| [.agents/PROJECT.md](../../.agents/PROJECT.md) | 工单与提交约定 |
| [GLOSSARY.md](../../GLOSSARY.md) | 领域术语、定义、代码名字与易混点 |
| [Baton TECH](../baton/TECH.md) | 全景、技术选择、平台实现、数据、协议与行为验证 |
| [release TECH](../release/TECH.md) | 打包发布、安装包检查、测量、Windows 待修与第一版之后事项 |
| [tools README](../../tools/README.md) | 脚本参数和调用方法 |
| 各 app 与子目录 README | 本目录实现要点与测试入口链接 |

PRODUCT 使用根术语表。停止以执行实例和所属进程回收确认为完成条件，随后保存 `thread.stopped`。普通 Agent 崩溃恢复先回收旧进程，为 sent 的活动输入补结束报告，再按 queued 输入或显式请求恢复；shell 使用独立完成证据。具体流程见 [Baton TECH](../baton/TECH.md#崩溃与恢复)。

## Testing and validation

验证命令集中在 [AGENTS.md](../../AGENTS.md#常用构建与验证命令)。下表 done 表示相应实现与测试已具备；平台运行证据及未测组合以 [发布设计](../release/TECH.md) 为准，发布工作流需在目标 runner 执行。

| 范围 | 设置与观察 | 失败条件 | 位置 | Status |
|---|---|---|---|---|
| 全部 | 工作区静态检查、编译、测试与工具测试 | 任一失败 | 本地 + CI | done |
| 工具目录与命名 | 统一构建、安装包检查与发布入口核对 | 布局检查失败或工作流引用无效路径 | 本地 + release 工作流 | done |
| 账本检查（2.1） | 损坏、锁占用、代次不符、缺失账本 | 检查改写业务文件；retry 判损坏；可能交付 open 后重建空会话 | 账本与 daemon 测试 | done |
| 授权目录（2.2） | 未配置、空列表、并发、symlink 越界、数量上限 | 空列表开放、更新丢失、越界授权 | 包内单测 | done |
| Agent 注册（2.3） | Worker 就绪、四 host 回放、依赖图及安装检查 | Worker 加载 SDK/driver，或能力/模型变化 | 包内测试 + host 回放 + 打包检查 | done |
| 凭据文件（2.4） | 两 adapter 共用契约测试 | 结果不一致或 host 失败未报错 | Runtime 测试 | done |
| 中心（3.1～3.4） | PostgreSQL 集成测试 | 工具副作用和结果未同事务，或现有断言失败 | 集成测试 | done |
| protocol（3.3） | Thread 派生往返及现有协议测试 | 字段约束变化或整体检查丢失 | 协议单测 | done |
| e2e Cursor | 真实 Cursor host replay 的网页发送、停止与恢复 | 链路失败 | e2e | done |

## Open questions

无。
