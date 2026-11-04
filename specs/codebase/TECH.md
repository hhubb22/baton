# 代码库结构整理技术设计

Status: draft
Basis: 中心、节点、Thread 状态机、Runtime 与协议架构设计；[Baton TECH](../baton/TECH.md)、[发布设计](../release/TECH.md)。范围不含 Web 实现与上游 provider 内部实现。

## Context

`batond` 进程内的 Thread 状态机（`apps/batond/src/worker/`）隐藏命令幂等、intent、Turn、停止、恢复与上行报告 outbox，统一由节点 `node.db` 持久化；本地控制通道（`apps/batond/src/daemon/control.ts`）统一承载 CLI 与桌面客户端对唯一 `batond` 守护进程的认证请求；中心 `runtimeRequest` 在事务中组织租约校验、工具调用、结果事件和输入消费；`httpApplication` 组织路由、安全、静态文件与错误映射。进程所有权与 SQLite 提交核查各有独立入口。

目录职责与开发验证入口集中在 [AGENTS.md](../../AGENTS.md)，术语及代码名字集中在 [GLOSSARY.md](../../GLOSSARY.md)。本设计说明模块边界、依赖方向与验证要求。

## 实现

### 1. 工具与进程入口

构建、开发、发布和平台检查位于 `tools/{build,dev,release,verify}`；安装布局、依赖复制及隔离运行辅助逻辑位于 `tools/lib/`。根工具入口为 `build.mjs`、`package-batond.mjs`、`package-desktop.mjs`、`package-release.mjs` 与 `check-package.mjs`，参数见 [工具说明](../../tools/README.md)。

安装包完整性检查（`tools/check-package.mjs`）在搬迁后的隔离目录、空 `PATH` 与临时 `HOME` 下验证 `batond` 本地控制通道、统一 `node.db` 初始化、全部六个 `agent-host --probe` 模块加载（含 SQLite store、ripgrep 与 sandbox helper）及 `project-runtime` 子命令，不依赖精简的实验 SEA。

Runtime 通道为 `BATON_PROJECT_RUNTIME_TRANSPORT`，stdio 错误使用 `runtime_stdio_*`。Runtime 的 stdio 实现位于 `runtimes/project-agent/src/stdio.ts`，宿主拥有自己的帧读写实现。

HTTP 选项、Agent 事件身份与节点状态机接口等共享类型放在被使用方单向引用的位置。公共进程测试辅助位于 `apps/batond/src/testing/platform/`，临时目录由测试 Scope 清理。

### 2. 节点模块边界

#### 2.1 统一节点账本与进程内状态机

`apps/batond/src/daemon/ledger.ts` 拥有 `node.db` 的统一连接、结构校验、提交 token（`node_commit`）与按 Thread / Execution 隔离的事务读写接口；`apps/batond/src/worker/` 保留纯状态机与完整输出逻辑，通过账本接口读写该 Thread 在 `node.db` 中的状态，不创建每 Thread 独立数据库或独立子进程入口：

```ts
interface ThreadLedgerStore {
  readonly loadThread: (threadId: string) => Effect.Effect<ThreadLedgerSnapshot | undefined, LedgerFailure | SqlError>
  readonly saveThread: (threadId: string, next: State) => Effect.Effect<void, LedgerFailure | SqlError>
}
```

`batond` 持有数据目录唯一 `daemon.lock` 后打开 `node.db`。启动时先核验结构完整性，业务表缺失或关键元数据不一致时直接失败并拒绝半初始化运行。

保存新回复时先按 `(thread_id, storage_generation)` 写入完整输出文件，再更新和限幅待发布报告，最后在同一 `FULL` 事务写入 `threads`、`thread_commands`、`thread_messages`、`thread_outbox`、`node_processes` 与 `node_commit` token。只有确认提交成功才推进状态机内存基线；`CommitUnknown` 原样上抛以冻结该状态机 fiber 并触发重读核查。

`batond` 启动采用懒加载：仅对 `node.db` 中处于未决/活动态（`running`、在途 `intent`、`stop_requested` 或未完成命令）的 Thread 恢复状态机 fiber 并执行崩溃恢复（区分 `awaiting_open` 与 `open_attempted`，核查原生快照并清理残留进程）；历史 `idle`、`stopped`、`archived` Thread 不在启动时拉起 `agent-host`。活动 `agent-host` 进入 `idle` 且无排队输入或待答问题满 10 分钟后自动休眠回收，下次输入到达时按需透明 `resume`。

#### 2.2 授权目录与本地控制通道

`devices/roots.ts` 提供 `initializeBrowseRoots`、`loadBrowseRoots`、`updateBrowseRoots` 和 `authorizeDirectory`。所有写入口共用锁及加锁顺序。配置不存在时初始化主目录；已保存的空列表继续拒绝访问。授权按真实路径检查，配置更新保留数量上限。

`daemon/control.ts` 复用 `daemon/ipc.ts` 的令牌帧协议暴露本机控制通道（`control.token`），统一服务 CLI 与桌面客户端的状态查询、设备码登录、显式登出、目录解析与非系统服务模式下的优雅停机。客户端连接失败时通过 `ensureDaemon` 在 `autostart.lock` 下后台拉起 `batond serve`。

#### 2.3 Agent 装配与探测

`agents/catalog.ts` 是类型、名称、能力与限制文案的唯一来源，只含字面量与 type-only import；`HostedAgentType` 从 hosted 项派生。

节点使用 `agents/thread-agents.ts` 的 `makeThreadAgentFactory` 构造 `ThreadAgent`，hosted 类型进入通用 host factory（通过 stdio RPC 驱动 `agent-host` 子进程），shell 使用受限 shell factory。工厂与 `ThreadAgent` 的构造不做 I/O；未知类型同步抛 `AgentError`。通用选项为 `HostedAgentOptions`，显式接收 `capabilities`；路径验证及 store 目录推导在工厂内完成。

daemon 和 CLI 使用 `agents/probe.ts` 的 `probeAgents`。默认按六个 Agent 并发探测，指定列表按请求顺序去重；未知类型或 shell 在启动探测前拒绝。每个探测执行安装预检、登记和加锁、旧记录恢复、私有临时目录、30 秒 host probe、断开与回收，再删目录和释放锁。只有确认进程回收或身份失效后才删除登记；取消等待清理完成。

`cli/agent-host.ts` 持有穷尽的字面量动态 loader 表，正常运行只加载所选 module；安装检查加载全部 module，并在 SEA 中核查 keyring、Cursor 资产和 tree-sitter。进程内运行选项为 `HostRunOptions`，路径类型位于 `agent-host/paths.ts`。

构建遍历 `daemon` 与 `worker` 的运行时可达图，检查静态导入、再导出、字面量动态导入、require 和 external 包，排除 type import。`batond` 守护进程主图不直接静态加载重型 provider 运行包或 `@cursor/sdk`，这些依赖仅在独立的 `agent-host` 子进程按需动态加载。

新增 hosted Agent 需要 catalog 项、loader 项及自身 host module/driver；有特殊安装预检时才调整公共 probe。原生协议与行为差异留在各 Agent adapter。

#### 2.4 Runtime 凭据与 RPC

`FileCredentials` 统一提供 OAuth 事务与跨进程锁，在 Runtime 进程内直接读写凭据文件，契约测试覆盖属主、类型、权限修复、64 KiB 上限、符号链接、缺失文件与原子替换。Runtime 定位位于 `project/runner.ts`。

`checkedRPC` 按 operation 关联结果类型，在调用边界集中做结构校验；pi-ai payload 的扩展字段原样保留。

### 3. 中心与协议模块边界

#### 3.1 Project Runtime

`apps/server/src/project/` 内文件按职责命名为 `runtime.ts`、`tools.ts`、`inputs.ts`、`events.ts`、`compaction.ts`、`store.ts`、`memory.ts`、`scheduling.ts`、`view.ts` 和 `preview.ts`，员工操作入口为 `projects.ts`。测试文件使用同样的名称。

`runtimeRequest` 是 Runtime 工具请求的唯一业务入口，内部完成工具执行、结果事件与 shell 输入消费。副作用和结果同事务提交；租约失效回滚。重复请求重放已保存结果；pending 查询使用不等待 Agent 写锁的只读路径。工具测试经保存 assistant 调用和真实租约进入该入口，纯 JSON 分页与 base64 截断保留进程内测试。

#### 3.2 Thread 读取

`threads/` 拥有命令、状态、报告与历史投影。`view` 和 `readTurns` 接受 `{ employeeId, projectId? }`；指定 Project 时在入口校验员工与 Project 归属。Project 工具不解释 Thread 物理行，也不向内部读取传锁参数。

事务辅助位于 `database.ts`，JSON 规范化与摘要位于 `json.ts`，目录规则位于 `directories.ts`。工具和报告沿用同一 SQL 事务及锁顺序；Thread 通知写入不取得 Agent 锁。

#### 3.3 领域协议

`packages/protocol/src/{thread,project,device,auth}.ts` 定义领域 Schema；`node.ts`、`worker.ts` 与 `http-api.ts` 组合传输契约。领域 Schema 不反向依赖传输层。

`ThreadSummary` 与 `ThreadView` 从 `Thread` 派生，保留整体检查。`SessionResponse` 与设备码登录会话 Schema（`DeviceLoginSessionResponse` 等）分别在 `auth`、`device` 中唯一定义，HTTP 层引用并添加元数据。未知字段、动态 JSON、字段省略与 HTTP 严格解码按各传输入口的既有契约处理。

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
| [device-setup TECH](../device-setup/TECH.md) | 安装包托管、设备码登录协议、本地控制通道与按需拉起实现 |
| [desktop TECH](../desktop/TECH.md) | Electron 边界、网页桥接、同源校验与控制通道集成 |
| [release PRODUCT](../release/PRODUCT.md) | 发布物、协议兼容、数据边界、离线升级与恢复验收约定 |
| [release TECH](../release/TECH.md) | 打包发布、安装包检查、存储边界、备份恢复与平台验证 |
| [tools README](../../tools/README.md) | 脚本参数和调用方法 |
| 各 app 与子目录 README | 本目录实现要点与测试入口链接 |

PRODUCT 使用根术语表。停止以执行实例和所属进程回收确认为完成条件，随后保存 `thread.stopped`。普通 Agent 崩溃恢复先回收旧进程，为 sent 的活动输入补结束报告，再按 queued 输入或显式请求恢复；shell 使用独立完成证据。具体流程见 [Baton TECH](../baton/TECH.md#崩溃与恢复)。

## Testing and validation

验证命令集中在 [AGENTS.md](../../AGENTS.md#常用构建与验证命令)。平台运行证据及未测组合以 [发布设计](../release/TECH.md) 为准，发布工作流需在目标 runner 执行。

| 范围 | 设置与观察 | 失败条件 | 位置 | Status |
|---|---|---|---|---|
| 全部 | 工作区静态检查、编译、测试与工具测试 | 任一失败 | 本地 + CI | planned |
| 工具目录与命名 | 统一构建、安装包检查与发布入口核对 | 布局检查失败或工作流引用无效路径 | 本地 + release 工作流 | planned |
| 节点账本与恢复（2.1） | 损坏、`CommitUnknown`、代次不符、懒加载与 10 分钟休眠唤醒 | 半初始化运行；可能交付 open 后重建空会话；空闲历史 Thread 启动时拉起 `agent-host` | 账本与 daemon 测试 | planned |
| 授权目录与控制通道（2.2） | 未配置、空列表、并发、symlink 越界、数量上限、并发按需拉起 | 空列表开放、越界授权、重复拉起多个守护进程或跨用户未授权控制 | 包内单测 | planned |
| Agent 注册（2.3） | 六 host 回放、依赖图及安装检查 | `batond` 主图静态加载 SDK/driver，或能力/模型变化 | 包内测试 + host 回放 + 打包检查 | planned |
| 凭据文件（2.4） | 两 adapter 共用契约测试 | 结果不一致或 host 失败未报错 | Runtime 测试 | planned |
| 中心（3.1～3.4） | PostgreSQL 集成测试（含设备码登录与吊销） | 工具副作用和结果未同事务，或现有断言失败 | 集成测试 | planned |
| protocol（3.3） | Thread 派生往返及设备码协议测试 | 字段约束变化或整体检查丢失 | 协议单测 | planned |
| e2e Cursor | 真实 Cursor host replay 的网页发送、停止与恢复 | 链路失败 | e2e | planned |

## Open questions

无。
