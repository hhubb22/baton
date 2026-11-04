# 诊断、结构化日志与 Agent 运行记录技术设计

Status: draft
Owner: Asa
Basis: [Baton R-22、R-23](../baton/PRODUCT.md)；[发布 RL-09](../release/PRODUCT.md)；[记忆可见性与实施边界](../project-memory/TECH.md#可见性与实施边界)；[Baton TECH](../baton/TECH.md)。

## 1. 全景与设计原则

Baton 不连接外部遥测采集后端，也不录制网页操作回放，将系统诊断与 Agent 运行审查建立在三层直接、无损、零外部服务依赖的机制之上：

1. **进程结构化 JSON 日志**：中心、`batond`、`agent-host` 与 `project-runtime` 输出轻量结构化事件日志（含发布版本、提交、实体标识与固定错误码），用于进程级排障。
2. **数据库实时诊断接口**：中心直接查询 PostgreSQL 实时表状态提供管理员诊断与员工状态视图，无需后台轮询合成。
3. **设备端无损 Agent 运行记录（Append-Only `transcript.jsonl`）**：在设备私有数据目录内，为每个执行 Thread（6 种 hosted Agent 与内部 `shell`）和每次 Project Agent 运行（前台主对话、上下文压缩、后台记忆整理）**实时追加**完整运行轨迹；网页与本机 CLI 按需流式分页拉取查看，中心 PostgreSQL 不存储大体积运行原文。

```text
Thread 执行（agent-host / shell）
  └─ 实时顺序追加 ──► <data-dir>/threads/<thread-id>/<storage-generation>/transcript.jsonl

Project 运行（project-runtime：foreground / compaction / memory）
  └─ 实时顺序追加 ──► <data-dir>/project-runs/<project-id>/<run-id>.jsonl

查看路径：
  ├─ 本机 CLI：batond transcript --thread-id <UUID> | --run-id <UUID> [--follow]
  └─ 网页 UI：GET /api/v1/threads/:id/transcript 或 /api/v1/projects/:id/runs/:runId/transcript
                └─ 中心校验员工归属 ──► WSS 分页字节读取 ──► 设备私有 JSONL 文件
```

## 2. 设备端 Agent 完整运行记录（`transcript.jsonl`）

### 2.1 文件布局、权限与崩溃安全性

所有运行记录采用 UTF-8 编码的 JSON Lines（`.jsonl`，每行一个自包含 JSON 对象加 `\n`），目录与文件权限在 POSIX 下固定为 `0700` / `0600`（复用 `apps/batond/src/platform/private.ts`），Windows 沿用用户数据目录继承 ACL：

| 运行类别 | 私有路径 | 生命周期与保留 |
|---|---|---|
| Thread 执行 Agent | `<data-dir>/threads/<thread-id>/<storage-generation>/transcript.jsonl` | 与该代次 `full-output/` 绑定，默认保留 30 天（`output-retention.json` 可配置），计入节点 1 GiB 存储预算 |
| Project Agent 运行 | `<data-dir>/project-runs/<project-id>/<run-id>.jsonl` | 与中心 `agent_runs.id` 一一对应，默认保留 30 天并随过期清理任务回收，计入节点 1 GiB 存储预算 |

**实时追加与防崩溃丢失**：
- `TranscriptWriter` 在事件发生时立即按序写入单行 JSON（不在内存中攒批等待 Turn 或 Run 结束）。即使 `agent-host` 或 `project-runtime` 在工具执行中途卡死、OOM 或被 `SIGKILL` 强杀，此前已发出的提示词、思考片段、进行中的工具命令与部分输出均已落盘可读。
- 写入失败（如磁盘满）记录本地结构化告警日志并停写后续轨迹行，不阻塞或回滚已确认的业务状态事务。
- 读取端若遇到断电导致的末尾半行（未以 `\n` 结尾且非空），保留已完整解析的前序行并返回 `incomplete_tail: true` 标记。

### 2.2 统一行信封与记录内容

每行记录共享基础信封字段：

```ts
interface TranscriptLine {
  readonly seq: number          // 文件内从 1 递增的序号
  readonly ts: string           // ISO 8601 UTC 时间戳
  readonly version: string      // 当前进程 BUILD.version
  readonly commit: string       // 当前进程 BUILD.commit
  readonly kind: string         // 事件类别
  readonly data: unknown        // 未截断的结构化载荷
}
```

#### （1）Thread 执行 Agent 记录事件（`agent-host` 与内部 `shell`）

在 `apps/batond/src/agent-host/driver.ts` 与状态机边界实时记录，不做 `shortenLongest` 或 32 KiB 截断：

| `kind` | 记录时机与完整 `data` 内容 |
|---|---|
| `session.opened` / `session.resumed` | `thread_id`、`storage_generation`、`agent_type`、`native_session_id`、`working_directory`、`runtime_mode`、初始 `model` 与思考档位配置 |
| `turn.started` | `worker_turn_seq`、`client_message_id`、`execution_id`、`mode`（`queue` \| `steer`）、完整用户输入文本、实际生效 `modelSelection` 与 `runtimePolicy` |
| `reasoning` | 原生 provider 产出的思考/推理内容块（含流式合并后的完整推理文本与关联 `item_id`） |
| `item.started` / `item.updated` / `item.completed` | **含运行中状态与终态**的完整 `OrchestrationV2TurnItem`：命令执行输入与完整 stdout/stderr/退出码、文件修改完整 diff、MCP/动态工具完整参数与返回、文件/网页搜索结果、子任务进度 |
| `question.asked` / `question.answered` | 原生权限审批、`user_input` 或 `mcp-elicitation` 的完整问题选项，以及员工提交的决策与回答 |
| `reply` | 完整未截断的 assistant 回复正文、消息 ID 与解析出的附件元数据 |
| `turn.ended` | `worker_turn_seq`、终态 `outcome`（`completed` \| `failed` \| `cancelled`）、完整 `token_usage`、首字耗时 `ttft_ms`、总耗时 `duration_ms` 及脱敏后的失败原因 |
| `session.error` / `session.hibernated` | 事件流异常、原生进程退出状态或空闲满 10 分钟休眠回收标记（附结构化错误 `_tag` 链） |

#### （2）Project Agent 记录事件（`runtimes/project-agent`）

覆盖前台协调运行（`kind = 'foreground'`，含普通回合与上下文压缩 `compaction`）以及后台长期记忆整理任务（`kind = 'memory'`）：

| `kind` | 记录时机与完整 `data` 内容 |
|---|---|
| `run.started` | `project_id`、`run_id`、`lease_epoch`、`run_kind`（`foreground` \| `memory`）、`memory_job_id`（若有）、`provider`、`model` |
| `llm.request` | 调用序号、用途（`chat` \| `compaction` \| `memory_extract`）、provider、model、`max_tokens`、**完整 `system` 指令文本、注入的记忆快照与发送给模型的完整 `messages` 数组** |
| `llm.response` | 调用序号、实际 `response_model`、`stop_reason`、`ttft_ms`、`duration_ms`、完整输出块（含全部 `thinking`、`text`、`toolCall`）及精确 Token 用量（`input`、`output`、`cached`、`cache_creation`、`reasoning`） |
| `tool.call` / `tool.result` | 协调工具名（`threads.*`、`nodes.exec`、`memory.*`、`history.*`）、`tool_call_id`、完整调用参数与完整工具返回结果、`duration_ms` |
| `compaction.committed` | `through_seq`、`cleared_tool_result_seqs` 与生成的压缩摘要正文 |
| `embedding.call` | 模型名、用途（记忆条目向量生成或 `memory.recall` 查询）、输入文本字节数与内容、`input_tokens`、`duration_ms` |
| `run.ended` / `run.failed` | 结束状态、累计调用次数、累计 Token 用量或失败错误码与原因 |

## 3. 按需流式拉取与查看契约

### 3.1 节点与中心传输契约

复用 `FullOutputStore` 验证成熟的分页字节切片模式（每页最大 `64 KiB` 原始字节，base64 编码传输，严格控制在网关 256 KiB 控制帧预算以内）：

1. **Thread 运行记录**：
   - 节点协议：`SessionRequest` 新增 `action: 'transcript'`（携带 `session_id`、`storage_generation`、字节偏移 `cursor`），返回 `{ ok: true, transcript: { storage_generation, offset, next_offset, total_bytes, expires_at, encoding: 'base64', data, done } }`；文件缺失或已过期返回明确错误码 `transcript_missing` / `transcript_expired`。
   - 中心 HTTP：`GET /api/v1/threads/:id/transcript?offset=<bytes>&download=1`
     - 严格校验当前登录员工拥有该 Thread（Project Agent 工具不开放读取原始 `transcript.jsonl`，防止超长原始轨迹撑爆协调上下文）。
     - 设备离线时返回 HTTP 409 `device_offline`。
     - `download=1` 时中心按页流式拉取并以 `application/x-ndjson`（`Content-Disposition: attachment; filename="thread-<id>.jsonl"`）流式响应给浏览器。

2. **Project Run 运行记录**：
   - 中心列表接口：`GET /api/v1/projects/:id/runs?limit=50`
     - 从中心已有 `agent_runs` 表按时间倒序返回该 Project 的前台运行与后台记忆整理运行摘要（`run_id`、`node_id`、`kind`、`memory_job_id`、`state`、`started_at`、`ended_at`、`error_code`）。
   - 节点协议与中心拉取：`GET /api/v1/projects/:id/runs/:runId/transcript?offset=<bytes>&download=1`
     - 中心校验员工拥有该 Project，查出 `agent_runs.node_id`，通过 WSS 向该节点发送 `ProjectRunTranscriptRequest { project_id, run_id, offset }` 分页读取 `<data-dir>/project-runs/<project-id>/<run-id>.jsonl`。

### 3.2 本机 CLI 与网页查看入口

- **本机 CLI**：
  - `batond transcript --thread-id <UUID> [--follow]`
  - `batond transcript --project-id <UUID> --run-id <UUID> [--follow]`
  - 直接在本地校验私有目录权限后流式输出原始 JSONL 到 stdout（无需经过中心或网络，方便开发者结合 `jq` 或离线排查卡死现场）。
- **网页界面**：
  - Thread 详情抽屉/菜单提供「查看运行记录」与「下载 `.jsonl`」，按需分页加载并结构化折叠展示系统指令、思考块、工具入参/出参与耗时。
  - Project 设置/诊断区列出最近的前台与后台记忆运行记录，点击即可在线查看对应 `run_id` 的完整提示词、记忆注入快照与模型响应。

## 4. 结构化日志、实时诊断与安全边界

### 4.1 进程结构化日志与请求关联

- 中心 HTTP 为每个请求生成或回显轻量 `X-Request-Id`（UUID），出错响应返回该 `request_id` 与固定协议 `code`。
- 中心、`batond`、`agent-host` 与 `project-runtime` 使用标准结构化日志输出关键生命周期事件（启动、连接/断连、迁移、恢复裁决、未预期异常），每条日志自动附带 `{ service, version, commit, pid }`。

### 4.2 数据库实时诊断接口

中心管理员诊断与员工状态查询直接读取 PostgreSQL 实时表（`node_presence`、`thread_outbox`、`threads`、`agent_runs`、`project_memory_jobs`），即时返回在线设备数、下行命令积压与最老未确认时长、Thread 状态分布和后台记忆队列状态；不运行后台定时指标轮询器。

网页与桌面客户端出错提示提供「复制诊断信息」，内容仅含时间戳、客户端与服务端版本号、相关设备 / Thread / Project ID、`request_id` 与错误码，不含任何会话正文。

### 4.3 敏感数据红线（R-22）

以下秘密严禁写入结构化日志、诊断摘要或 `transcript.jsonl`：
- 节点 Ed25519 私钥、中心 `node-signing.key`、本地控制令牌 `control.token`、设备码明文 `device_code`、员工口令与会话 Cookie / CSRF 令牌；
- Project Runtime 模型订阅 OAuth 凭据文件（`auth.json`）中的 access/refresh token；
- 宿主环境变量中的 API 密钥（如 `CURSOR_API_KEY`、`FACTORY_API_KEY`、Embedding API key）。

`transcript.jsonl` 包含完整提示词与命令执行原文（可能含有被测仓库或命令打印的业务敏感输出），因此严格保存在设备私有目录（`0600`），仅限所属员工本人读取。

## Testing and validation

| Requirement | Setup and observation | Failure condition | Where | Status |
|---|---|---|---|---|
| R-22、R-23 | 执行一轮含思考、命令执行、文件修改与审批的 Thread 回合，检查设备本地 `transcript.jsonl` 并从网页 API 与 CLI 读取 | 缺少步骤或被截断；非所属员工可读；出现连接私钥、`control.token` 或订阅 token | `apps/batond` 集成 + `e2e` | planned |
| R-23（崩溃现场保留） | 在 `agent-host` 工具运行中途与 `project-runtime` 第二次模型调用中途强制终止子进程 | 已发生的 `turn.started` / `item.started` / 首次 `llm.request` 与 `llm.response` 丢失或导致读取器崩溃 | `apps/batond` + `runtimes/project-agent` 单测 | planned |
| R-23（Project 前后台运行记录） | 跑一次前台协调（含工具调用与压缩）和一次后台记忆整理，调 `/api/v1/projects/:id/runs` 与 `.../transcript` | 列表缺少后台记忆 Run；`transcript.jsonl` 缺少完整 `system` 指令、注入记忆或模型原始输出 | `runtimes/project-agent` + `e2e` | planned |
| RL-09 | 检查中心日志、诊断输出、网页/桌面端复制诊断文本及 `transcript.jsonl` 行信封 | 缺少 `version` / `commit` 或相关实体 ID；残留任何外部遥测网络请求 | 单测 + 打包检查 | planned |

## Open questions

无。
