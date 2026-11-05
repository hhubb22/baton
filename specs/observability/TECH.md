# 诊断、结构化日志与 Agent 运行记录技术设计

Status: draft
Owner: Asa
Basis: [Baton R-22、R-23](../baton/PRODUCT.md)；[发布 RL-09](../release/PRODUCT.md)；[记忆可见性与实施边界](../project-memory/TECH.md#可见性与实施边界)；[Baton TECH](../baton/TECH.md)。

## 1. 全景与设计原则

Baton 不连接外部遥测采集后端，也不录制网页操作回放，将系统诊断与 Agent 运行审查建立在三层直接、无损、零外部服务依赖的机制之上：

1. **进程结构化 JSON 日志**：中心、`batond`、`agent-host` 与 `project-runtime` 输出轻量结构化事件日志（含发布版本、提交、实体标识与固定错误码），用于进程级排障。
2. **数据库实时诊断接口**：中心直接查询 PostgreSQL 实时表状态提供管理员诊断与员工状态视图，无需后台轮询合成。
3. **设备端无损 Agent 运行记录（Append-Only `transcript.jsonl`）**：在设备私有数据目录内，为每个执行 Thread（Pi、Codex、Kiro、Cursor、Grok、Antigravity、Droid）和每次 Project Agent 运行（前台主对话、上下文压缩、后台记忆整理）**实时追加**完整运行轨迹；网页与本机 CLI 按需分页读取，中心 PostgreSQL 不存储大体积运行原文。

```text
Thread 执行（agent-host）
  └─ 实时顺序追加 ──► <data-dir>/threads/<thread-id>/<storage-generation>/transcript.jsonl

Project 运行（project-runtime：foreground / compaction / memory）
  └─ 实时顺序追加 ──► <data-dir>/project-runs/<project-id>/<run-id>.jsonl

查看路径：
  ├─ 本机 CLI：batond transcript --thread-id <UUID> 或 --project-id <UUID> --run-id <UUID> [--follow]
  └─ 网页 UI：GET /api/v1/threads/:id/transcript 或 /api/v1/projects/:id/runs/:runId/transcript
                └─ 中心校验员工归属 ──► WSS 分页字节读取 ──► 设备私有 JSONL 文件
```

## 2. 设备端 Agent 完整运行记录（`transcript.jsonl`）

### 2.1 文件布局、权限与崩溃安全性

所有运行记录采用 UTF-8 编码的 JSON Lines（`.jsonl`，每行一个自包含 JSON 对象加 `\n`），目录与文件权限在 POSIX 下固定为 `0700` / `0600`（复用 `apps/batond/src/platform/private.ts`），Windows 沿用用户数据目录继承 ACL：

| 运行类别 | 私有路径 | 生命周期与保留 |
|---|---|---|
| Thread 执行 Agent | `<data-dir>/threads/<thread-id>/<storage-generation>/transcript.jsonl` | 与该代次 `full-output/` 同目录；读取端默认按 30 天过期（`output-retention.json` 可配置） |
| Project Agent 运行 | `<data-dir>/project-runs/<project-id>/<run-id>.jsonl` | 与中心 `agent_runs.id` 一一对应；读取端默认按 30 天过期，本地文件尚未接入后台清理任务 |

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

#### （1）Thread 执行 Agent 记录事件（`agent-host`）

在 `apps/batond/src/agent-host/driver.ts` 与状态机边界实时记录，不做 `shortenLongest` 或 32 KiB 截断：

| `kind` | 记录时机与完整 `data` 内容 |
|---|---|
| `session.opened` / `session.resumed` | `thread_id`、`storage_generation`、`agent_type`、`native_session_id`、`working_directory`、`runtime_mode`、初始 `model` 与思考档位配置；原生适配器不暴露 provider 的系统指令原文，因此 `system_instructions` 固定为 `null` 并附 `system_instructions_note` 说明 |
| `turn.started` | Thread 与运行标识、`worker_turn_seq`、`client_message_id`、`mode`（`queue` \| `steer`）、完整用户输入文本与输入对象、实际生效 `model_selection` 与 `runtime_policy` |
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
   - 节点协议：`SessionRequest` 新增 `action: 'transcript'`（携带 `session_id`、可选 `storage_generation` 与字节偏移 `cursor`），返回 `{ ok: true, transcript: { offset, next_offset, total_bytes, expires_at, encoding: 'base64', data, done, incomplete_tail } }`；文件缺失或已过期返回明确错误码 `transcript_missing` / `transcript_expired`。设备未收到代次时读取该 Thread 最近写入的 `transcript.jsonl`。
   - 中心 HTTP：`GET /api/v1/threads/:id/transcript?offset=<bytes>`，每次返回一页 `TranscriptPage`。
     - 严格校验当前登录员工拥有该 Thread（Project Agent 工具不开放读取原始 `transcript.jsonl`，防止超长原始轨迹撑爆协调上下文）。
     - 设备离线时返回 HTTP 409 `device_offline`，提示运行记录暂不可取回。

2. **Project Run 运行记录**：
   - 中心列表接口：`GET /api/v1/projects/:id/runs?limit=50`
     - 从中心已有 `agent_runs` 表按时间倒序返回该 Project 的前台运行与后台记忆整理运行摘要（`run_id`、`node_id`、`kind`、`memory_job_id`、`memory_kind`、`state`、`provider`、`model`、`started_at`、`ended_at`、`error_code`）。
   - 节点协议与中心拉取：`GET /api/v1/projects/:id/runs/:runId/transcript?offset=<bytes>`
     - 中心校验员工拥有该 Project，查出 `agent_runs.node_id`，通过 WSS 向该节点发送 `ProjectRunTranscriptRequest { project_id, run_id, offset }` 分页读取 `<data-dir>/project-runs/<project-id>/<run-id>.jsonl`；设备离线同样返回 HTTP 409 `device_offline`。
     - 下载由网页按页拼接 `TranscriptPage.data` 后生成 `.jsonl` Blob，不增加中心流式下载分支。

### 3.2 本机 CLI 与网页查看入口

- **本机 CLI**：
  - `batond transcript --thread-id <UUID> [--follow]`
  - `batond transcript --project-id <UUID> --run-id <UUID> [--follow]`
  - 直接在本地校验私有目录权限后按页输出原始 JSONL 到 stdout（无需经过中心或网络，方便开发者结合 `jq` 或离线排查卡死现场）；`--follow` 持续轮询追加内容，直到用户按 Ctrl-C。
- **网页界面**：
  - Thread 详情菜单提供「查看运行记录」与「下载 `.jsonl`」，按需分页加载并结构化折叠展示思考块、工具入参/出参与耗时；原生 provider 不暴露的 Thread 系统指令不伪造。
  - Project 概览的「运行记录」标签列出最近的前台与后台记忆运行记录，点击即可在线查看对应 `run_id` 的完整提示词、记忆注入快照与模型响应。

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
| R-22、R-23 | 检查设备本地 `transcript.jsonl`、网页客户端分页请求与中心归属校验 | 缺少步骤或被截断；非所属员工可读；出现连接私钥、`control.token` 或订阅 token | `apps/batond/src/transcript/transcript.test.ts`、`apps/batond/src/agent-host/driver.test.ts`、`apps/server/src/full-output.integration.test.ts`、`web/src/data/http/transcript.test.ts` | partial：已覆盖追加写入、末尾半行、脱敏、Thread 归属与客户端分页；完整审批回合和浏览器 E2E 未覆盖 |
| R-23（崩溃现场保留） | `agent-host` 回合尚未结束时读取本地文件；Project Runtime 写入后未关闭即读取 | 已发生的 `turn.started` / `item.started` / `run.started` 丢失或读取器崩溃 | `apps/batond/src/agent-host/driver.test.ts`、`runtimes/project-agent/test/transcript.test.ts` | partial：验证同步落盘；尚未用真实子进程 `SIGKILL` 复现第二次模型调用中断 |
| R-23（Project 前后台运行记录） | 启动一次 Project 前台运行后调 `/api/v1/projects/:id/runs` 与 `.../transcript` | 列表缺少运行；中心未向节点转发；非所属员工可读 | `apps/server/src/project/projects.integration.test.ts`、`runtimes/project-agent/test/transcript.test.ts` | partial：已覆盖运行摘要、归属与 WSS 转发；完整前台工具/压缩与后台记忆运行的真实流水未覆盖 |
| RL-09 | 检查 `transcript.jsonl` 行信封、结构化日志与诊断输出 | 缺少 `version` / `commit` 或相关实体 ID；残留任何外部遥测网络请求 | `packages/logging/src/index.test.ts`、`apps/server/src/diagnostics.integration.test.ts`、`web/src/diagnostics/diagnostics.test.tsx`、`tools/telemetry-scan.test.mjs` | covered：日志校验字段、版本、提交与敏感键过滤；诊断校验实时聚合且不含正文；网页校验复制摘要只含规定字段；打包扫描校验产物无外部遥测标记 |

## Open questions

无。
