# 可观测性

Status: implemented
Owner: Baton
Basis: [Baton R-22、R-23](../baton/PRODUCT.md)；[发布 RL-A09](../release/PRODUCT.md)；[记忆可见性与实施边界](../project-memory/TECH.md#可见性与实施边界)；[Baton TECH](../baton/TECH.md)「敏感数据」。

## 1. 方案

中心、batond、Worker、agent-host 和 Project Runtime 通过 OTLP/HTTP 导出 traces、logs 和 metrics。网页通过 HyperDX 的底层 RUM 和录制器导出追踪与可选回放，封装在 `web/src/telemetry/` 里。参考后端是自托管的 HyperDX（ClickStack）。

遥测后端的地址和 key 只在中心配置。设备和网页把数据发给自己已经连着的中心，由中心过滤后转发。安装包和网页构建产物只写入版本和提交，不包含遥测地址或 key。部署者不配置，就没有任何数据离开这套部署。

一条员工消息对应一条完整的 trace：从网页发送开始，经过中心 HTTP、outbox、WSS、batond、认证 IPC、Worker、agent-host 和 provider，到回复报告回中心结束。Project Run 同样从中心放置开始，经过 batond，进入 Runtime 的模型调用、工具调用和向量化调用。每个 Turn 和每次 Run 有一个根 span，默认按 OpenTelemetry GenAI（`>= 1.37`）语义约定完整记录 Agent 活动（系统指令、输入与输出消息、思考与计划过程、工具调用名称及输入输出、模型与 token 用量、首字耗时与结束原因），供 ClickStack `/llm` 直接展示完整会话抽屉、工具链路与成本分析，并支持按版本、provider、系统和错误码查询。

默认不向后端导出。中心没有配置导出地址时，中心不发起连接，设备不向中心发送遥测，网页不加载导出器；设备进程可能向本机接收端发送后被丢弃。导出或转发失败、超时、达到并发上限时丢弃当前批次，不阻塞业务。

```mermaid
flowchart LR
    W[网页] -->|traceparent| S[中心]
    S -->|outbox / WSS| D[batond]
    D -->|认证 IPC| K[Worker]
    K -->|effect/rpc| H[agent-host]
    H --> P[provider]
    D -->|stdio JSON-RPC| R[Project Runtime]
    K -.OTLP 本机.-> D
    H -.OTLP 本机.-> D
    R -.OTLP 本机.-> D
    D -.telemetry.export / WSS.-> S
    W -.同源 /api/v1/telemetry.-> S
    S -.OTLP + key.-> X[(HyperDX)]
```

## 2. 传播

HTTP、中心 outbox、WSS、节点账本、认证 IPC 和 Worker 命令记录持久保存 trace context，重连、重复派发和 Worker 恢复后继续关联原始来源。

| 段 | 做法 |
|---|---|
| Worker → agent-host | `apps/batond/src/agent-host/host.ts` 的 `RpcServer.make` 去掉 `disableTracing: true`，客户端也开启追踪，让 `effect/rpc` 在请求里携带 span。agent-host 进程使用 `telemetryLayer('baton-agent-host')`，继承 Worker 的导出配置 |
| batond → Project Runtime | stdio JSON-RPC 的请求和 bootstrap 增加可选字段 `trace`，值为 `{ traceparent, tracestate? }`，与 `packages/telemetry` 的 `TraceContext` 一致。Runtime 使用 `telemetryLayer('baton-project-runtime')`，把收到的上下文作为父 span。字段缺省时 Runtime 开新的 trace |
| 网页 → 中心 | 浏览器对同源 `/api/` 的 fetch 携带 `traceparent`；WebSocket 通知连接单独追踪，不通过握手传递上下文 |

中心 API 响应带 W3C `traceresponse` 头，网页据此记录失败请求的 trace id（见第 7 节）。

追踪元数据继续独立于业务内容摘要和幂等判断。

## 3. 字段

traces、普通 logs 和 metrics 共用 `packages/telemetry` 的字段白名单，白名单之外的键在序列化时删除。字段名优先用 OpenTelemetry 语义约定，Baton 自己的字段用 `baton.` 前缀。标识符是系统生成的 ID，枚举值来自代码里的固定集合，计数和耗时是数字。回放使用下文约定的受限结构和关联字段。

### 资源属性

每个进程的资源身份取自己实际运行的程序，不继承父进程。daemon 重启后仍存活的旧 Worker 保留旧构建身份，但其本机转发受第 6 节和第 9 节的端口生命周期限制。

| 键 | 内容 |
|---|---|
| `service.name` | `baton-server`、`batond`、`baton-worker`、`baton-agent-host`、`baton-project-runtime`、`baton-web` |
| `service.version` | 构建元数据里的发布版本，开发构建为 `development` |
| `vcs.ref.head.revision` | 构建元数据里的完整提交 |
| `service.instance.id`、`process.pid` | 现有值 |
| `os.type`、`host.arch` | Node 的 `process.platform`、`process.arch` |
| `baton.node.id` | 设备侧进程所属的节点 ID；中心和网页不带 |
| `deployment.environment.name` | 来自 `OTEL_RESOURCE_ATTRIBUTES`，可选 |
| `rum.sessionId` | 开启网页回放时由 SDK 生成或恢复，限定为 32 位十六进制，用于关联追踪和回放 |

### span 与日志属性

| 键 | 内容 |
|---|---|
| `baton.employee.id`、`user.id` | 员工 ID，不带姓名、账号或邮箱；中心转发时同步写入 `user.id` 供 ClickStack `/llm` 按用户归因 |
| `baton.node.id`、`baton.thread.id`、`baton.turn.seq`、`baton.command.id`、`baton.command.action` | 现有标识 |
| `baton.project.id`、`baton.project.run.id`、`baton.conversation.id` | Project 与 Run 标识 |
| `baton.memory.job.id`、`baton.memory.attempt`、`baton.memory.batch` | 记忆任务标识；当前记录 job ID，attempt 与 batch 已列入白名单但尚未采集，其余记忆字段见记忆 TECH |
| `baton.agent` | `codex`、`cursor`、`pi`、`kiro`、`antigravity`、`shell`、`project` |
| `gen_ai.operation.name` | `chat`、`invoke_agent`、`execute_tool`、`embeddings` |
| `gen_ai.agent.name`、`gen_ai.conversation.id` | Agent 标识（`codex`、`cursor`、`pi`、`kiro`、`antigravity`、`project`、`memory`）与会话归组标识（Thread ID、Conversation ID 或 Memory Job ID） |
| `gen_ai.provider.name`、`gen_ai.request.model`、`gen_ai.response.model` | provider 与请求/响应模型 ID 原样记录，包括自定义或错误的 ID；未报告 provider 时省略 |
| `gen_ai.response.finish_reasons`、`stop_reason`、`ttft_ms` | 结束原因数组与单值（如 `completed`、`cancelled`、`failed`、`stop`、`toolUse`）及首字耗时毫秒数 |
| `gen_ai.usage.input_tokens`、`gen_ai.usage.output_tokens`、`baton.usage.cached_input_tokens`、`gen_ai.usage.cache_read.input_tokens`、`gen_ai.usage.cache_creation_input_tokens`、`gen_ai.usage.reasoning.output_tokens` | 模型或 Embedding 报告的用量；未报告时不写对应键，不写 0 |
| `baton.usage.reported` | `true` 或 `false`，用来区分用量缺失和用量为 0；为 `false` 时剥离全部 token 用量键 |
| `gen_ai.tool.name`、`gen_ai.tool.call.id` | 工具或步骤名称（如 `command_execution`、`file_change`、具体 `dynamic_tool` 名称、`approval_request`、Project Agent 工具名）与调用 ID |
| `gen_ai.system_instructions` | 模型调用的系统提示词文本，单字段上限 128 KiB |
| `gen_ai.input.messages`、`gen_ai.output.messages` | OTel GenAI 1.37 消息数组 JSON 字符串，部件支持 `text`、`reasoning`、`tool_call`、`tool_call_response`；默认直接上报，输入上限 128 KiB，输出上限 1 MiB，以覆盖 OpenAI、Claude 的 128K token 输出及 JSON 包装 |
| `gen_ai.tool.call.arguments`、`gen_ai.tool.call.result` | 工具调用参数与执行结果（命令与退出码/输出、文件改动 diff、MCP/动态工具输入输出、搜索结果、子任务与审批结果），默认直接上报，单字段上限 128 KiB |
| `baton.error.code` | 协议和领域里已有的固定错误码，不用原始错误文本 |
| `error.type` | 现有值 |
| `baton.web.source.asset`、`code.line.number`、`code.column.number` | 异常对应当前构建主静态资源时，仅保留文件名与有界行列号；无法确认时省略 |
| `baton.wait.reason` | 固定等待原因，例如 `device_offline`、`approval`、`credential_missing`、`queue`、`lease`、`backoff` |
| `baton.retry.count` | Thread 持久命令派发前已尝试的次数，首次为 0 |
| `baton.recovery` | 现有值 |
| `baton.stop.result` | Worker 停止命令的 `stopped` 或 `unknown`；当前未采集 `already_finished` |
| `baton.turn.result` | `completed`、`failed`、`stopped`、`lost`、`unknown` |
| `baton.turn.first_output_ms` | 从 Worker 接收消息到 agent 首个输出的毫秒数 |
| `baton.tool.kind` | `command`、`file_change`、`file_search`、`mcp`、`web`、`subagent`、`other` |
| `baton.project.tool` | Project Runtime 工具名，取自 `runtimes/project-agent/src/tools.ts` 的定义集合 |
| `baton.output.truncated`、`baton.output.bytes` | Agent 报告输出元数据时的截断标记和原始大小；缺少上游报告时省略 |

Agent 的系统提示词、输入消息、思考与计划步骤、工具参数与结果默认通过 `gen_ai.*` 属性上报，每个大文本属性限制在 128 KiB UTF-8 字节以内，输出消息限制在 1 MiB；超出时在完整字符边界截断并保持合法 JSON 结构，输出截断优先删除较早的部件以保留最终回复。密码、令牌、密钥等凭据、员工姓名/邮箱/IP、网页未捕获异常的原始错误信息和堆栈，都不进 span、事件、日志正文或指标标签。普通日志正文只用固定的事件名，例如 `baton.wait.start`，变化的内容写进白名单属性。

## 4. span

已有的 HTTP、数据库和 `Effect.fn` span 保留。每类工作增加一个根 span，下面挂子 span：

| span | 进程 | 说明 |
|---|---|---|
| `baton.turn` | Worker | 从接收消息到回合终态。带 `gen_ai.operation.name = chat`、`gen_ai.agent.name`、`gen_ai.conversation.id`、`gen_ai.input.messages`、`gen_ai.output.messages`（含思考、工具摘要与回复）、`baton.turn.result`、`baton.turn.first_output_ms`、`ttft_ms`、`stop_reason`、用量和错误码 |
| `baton.agent.session` | agent-host | provider 会话的启动或恢复，带 `baton.recovery`、`gen_ai.agent.name`、`gen_ai.conversation.id` |
| `baton.agent.turn` | agent-host | provider 的一轮执行，带 `gen_ai.operation.name = invoke_agent`、`gen_ai.agent.name`、`gen_ai.conversation.id`（不重复写 `gen_ai.request.model` 与 token 用量，避免被统计为两次模型调用） |
| `baton.agent.tool` | agent-host | 一次工具或子任务调用（覆盖 `command_execution`、`file_change`、`dynamic_tool`、`file_search`、`web_search`、`subagent`），带 `gen_ai.operation.name = execute_tool`、`baton.tool.kind`、`gen_ai.tool.name`、`gen_ai.tool.call.id`、`gen_ai.tool.call.arguments`、`gen_ai.tool.call.result` |
| `baton.agent.approval` | agent-host | 等待审批或用户回答的时长（覆盖 `approval_request` 与 `user_input_request`），带 `gen_ai.operation.name = execute_tool`、`gen_ai.tool.name`、`gen_ai.tool.call.id`、`gen_ai.tool.call.arguments`、`gen_ai.tool.call.result` |
| `baton.project.run` | Project Runtime | 一次前台 Run 或后台记忆整理从 bootstrap 到结束，带 `gen_ai.operation.name = invoke_agent`、`gen_ai.agent.name`（`project` / `memory`）、`gen_ai.conversation.id` |
| `gen_ai.chat` | Project Runtime | 一次模型调用（含主对话、上下文压缩与后台记忆整理）。span 名按语义约定写成 `chat {model}`，带 `gen_ai.operation.name = chat`、provider、请求/响应模型、系统指令、输入与输出消息（含 `thinking` 与 `toolCall`）、`ttft_ms`、`stop_reason` 和用量 |
| `baton.project.tool` | Project Runtime | 一次工具调用，带 `gen_ai.operation.name = execute_tool`、`baton.project.tool`、`gen_ai.tool.name`、`gen_ai.tool.call.id`、`gen_ai.tool.call.arguments`、`gen_ai.tool.call.result` |
| `baton.project.compaction` | Project Runtime | 一次上下文压缩 |
| `gen_ai.embeddings` | Project Runtime | 一次向量化调用（记忆条目向量生成与 `memory.recall` 查询向量生成）。span 名写成 `embeddings {model}`，带 `gen_ai.operation.name = embeddings`、`gen_ai.provider.name = openai`、`gen_ai.request.model`、`gen_ai.input.messages` 与 `gen_ai.usage.input_tokens` |
| `baton.report` | batond | 一批报告从提交到收到中心回执 |

Session Agent 与 Project Runtime 的 `gen_ai.*` span 直接对齐 ClickStack `/llm`（OTel GenAI `>= 1.37`）与兼容 GenAI 语义约定的观测平台。

## 5. 等待与积压

没结束的 span 不会被导出，所以光靠 trace 看不到卡住的 Turn、Run 或报告。这类问题用下面两种数据来发现：

**等待事件**：进入和离开等待状态时各写一条 OTLP 日志，事件名为 `baton.wait.start` 和 `baton.wait.end`，带 `baton.wait.reason`、相关实体的标识，以及当前 trace context。`baton.wait.end` 还带等待的毫秒数。这类日志用来追查单个问题。

**周期指标**：中心和 batond 每 30 秒上报一次 gauge，用来做仪表盘和告警：

| 指标 | 进程 | 标签 |
|---|---|---|
| `baton.nodes.online` | 中心 | — |
| `baton.outbox.pending`、`baton.outbox.oldest_age_s` | 中心 | `baton.command.action` |
| `baton.threads` | 中心 | `baton.turn.result` 或当前状态 |
| `baton.project.runs.active` | 中心 | — |
| `baton.memory.jobs` | 中心 | 任务状态、`baton.wait.reason` |
| `baton.wait.oldest_age_s` | 中心、batond | `baton.wait.reason` |
| `baton.ledger.bytes`、`baton.ledger.budget_ratio` | batond | — |
| `baton.reports.unacked`、`baton.reports.oldest_age_s` | batond | — |
| `baton.workers.active` | batond | `baton.agent` |

指标标签只能用枚举字段，不能用 Thread、Project 这类标识。中心和节点 outbox 保存入队时间，用于计算最老积压；旧开发数据库中的现有行以迁移时间开始观察。账本大小包含节点、Project 和 Thread 的数据库及 WAL，预算比率以 1 GiB 为参考，仅观察占用，不拒绝新 Thread。采集超时或出错时跳过这一次，不影响业务。Project 等待事件记录调度实际观察到的状态变化，进程重启后重新计时，两次观察之间的瞬时变化可能遗漏。开发阶段的旧设备账本可以重建，程序不自动删除本地数据。

## 6. 导出与配置

`packages/telemetry` 提供一个 Layer，同时注册 OTLP tracer、logger 和 metrics。三者共用现有的导出客户端：每个进程最多两个并发请求，响应头和响应体都受超时约束，最长三秒；超时或超过并发上限时丢弃当前批次，然后暂停六十秒再恢复。traces、logs 和 metrics 的序列化都要经过第 3 节的白名单。

配置沿用标准环境变量：`OTEL_EXPORTER_OTLP_ENDPOINT`，以及分信号的 `OTEL_EXPORTER_OTLP_{TRACES,LOGS,METRICS}_ENDPOINT`、`OTEL_EXPORTER_OTLP_HEADERS`、`OTEL_RESOURCE_ATTRIBUTES`，还有 `OTEL_{TRACES,LOGS,METRICS}_EXPORTER=none`。HyperDX 的 ingestion key 放在 `OTEL_EXPORTER_OTLP_HEADERS` 里。相同 endpoint 对不同信号设置不同超时时，共享客户端采用其中较短的上限；指标默认每 30 秒导出，可由 `OTEL_METRIC_EXPORT_INTERVAL` 覆盖。

### 中心

中心用自己的 `OTEL_*` 配置导出自身数据，同一份地址和 headers 也用于转发设备和网页的数据。中心配置了导出地址时默认开启转发；设置 `BATON_TELEMETRY_FORWARD=off` 后只导出中心自身的数据。转发开启时：

- 中心在 `node.sync_result` 里带上可选字段 `telemetry: { forward: true }`，不带地址或 headers。
- `GET /me` 返回 `telemetry` 字段，只含可选的 `session_replay: "masked"`，不含地址或 key。是否开启回放由 `BATON_WEB_SESSION_REPLAY=masked` 决定。

转发前，中心解码 OTLP JSON；网页回放还接受 gzip 压缩的 OTLP protobuf，压缩请求和解压结果各限 1 MiB。中心再做三件事：

1. 按第 3 节的白名单过滤。回放记录按第 7 节的受限结构校验，不符合的整条丢弃。
2. 设备数据的 `baton.node.id`、`baton.employee.id` 和 `user.id` 改成该连接认证出的身份，网页数据的 `baton.employee.id` 和 `user.id` 改成会话身份，网页数据不带 `baton.node.id`。`service.name` 不在第 3 节列出的集合里时，整批丢弃。
3. 重新编码后发给后端。

转发使用独立的导出客户端，和中心自身导出的名额分开，避免设备流量挤掉中心数据。转发最多 4 个并发请求，单次最长三秒；超时、失败或名额用满时丢弃当前批次，失败后暂停六十秒。转发不落库、不重试，也不给发送方回执。

### 设备

batond 在本机启动一个 OTLP/HTTP 接收端，只监听 `127.0.0.1` 的随机端口，并要求带上每次启动随机生成的令牌。batond 通过现有的环境变量继承路径，把这个地址和令牌交给 Worker、agent-host 和 Runtime。令牌不写进账本、日志或命令行。

batond 自己的数据和本机接收到的数据，在中心下发 `forward: true` 期间，打包成节点消息 `telemetry.export` 经 WSS 发给中心。消息体为 `{ type, signal, payload }`，`signal` 取 `traces`、`logs`、`metrics`，单条不超过 `MaxMessageBytes`（2 MiB）。子进程向本机接收端导出时默认将 `OTEL_BSP_MAX_EXPORT_BATCH_SIZE` 设为 `8`；序列化结果超过约 1.5 MiB 时按 span 边界拆成多个请求，保持资源与 scope 属性，不拆分 span，日常小批次不重新编码。超过 `MaxMessageBytes` 的单个 span 和其他信号的超大批次直接丢弃。`telemetry.export` 的优先级最低：节点发送队列有积压、连接断开或没有收到 `forward: true` 时直接丢弃，不进账本、不重发。

设备本地设置了 `OTEL_EXPORTER_OTLP_*` 时，batond 和子进程采用本地配置，不经过中心，也不启动本机接收端；本地没有地址时不导出。这种方式用于单机排查，或者在中心不可用时观察设备。daemon 重启后，仍存活的旧 Worker 继续使用旧随机端口和令牌，无法通过新 daemon 转发，直到该 Worker 重启。

### 网页

网页把追踪和回放发到同源的 `/api/v1/telemetry/v1/{traces,logs}`。中心要求有效的登录会话并校验 Origin；traces 使用自定义请求头并校验 CSRF token。固定版本回放录制器不支持自定义请求头，logs 依靠 Origin 和 `SameSite=Strict` 会话 Cookie。单个请求体不超过 1 MiB，超过时返回 413。转发关闭时返回 404；网页下一次追踪导出收到 404 后停止采集，已排队的回放批次仍可能发送。

### 构建与部署

安装包、桌面客户端和网页构建产物里只有版本和提交，不包含遥测地址或 key。换后端或轮换 key，只需要修改中心的环境变量并重启中心，不需要重新发版或升级设备。第三方部署的中心不配置遥测，它的设备和网页就不会向外发送数据。

### 采样

现在的数据量全量采样也没问题。以后数据量变大，在 collector 上做尾部采样，保留出错和慢的 trace。

## 7. 网页

`web/src/telemetry/` 在 `GET /me` 返回 `telemetry` 字段后懒加载官方 `@hyperdx/otel-web` 和 `@hyperdx/otel-web-session-recorder`，导出地址固定为同源的 `/api/v1/telemetry`，不使用 key。追踪通过自定义导出器过滤实际载荷；录制器通过 rrweb eventProcessor 在发送前过滤完整快照和增量事件。

- 仅对中心同源 `/api/` 请求传播 trace context
- console 不采集，网络请求和响应的头和正文不采集
- 未捕获的异常、Promise 拒绝和界面错误只上报固定错误类型，以及可确认的当前构建源码位置，不导出原始消息或堆栈
- 会话回放默认关闭。`BATON_WEB_SESSION_REPLAY=masked` 时开启，所有文字和输入都遮住，只保留布局和交互

时间线显示的是对话、命令输出和路径，所以没有不遮挡的回放模式。需要看内容时，用 trace 里的 Thread 和 Turn 标识去中心读，读取时照常检查权限。

回放是普通日志正文固定事件名规则的例外：正文只含遮挡文字后的结构和交互事件，布局只保留枚举及数值样式，删除 DOM 属性、URL 和其他内容。SDK 使用 `rr-web.offset`、`rr-web.event`、`rr-web.chunk`、`rr-web.total-chunks` 四个整数重组事件，并使用受限 `rum.sessionId` 关联会话。退出后停止采集；此前已排队的批次仍可能发送。固定版本录制器保留一个模块级定时器，每次重新初始化会留下空的 unload 监听器。

出错的界面提供「复制诊断信息」，复制的内容包括时间、网页版本、相关的 Thread/Project/设备标识、最近一次失败请求的 trace id 和错误码，不包括正文。按 `web/WRITING.md` 的要求，界面上不显示 trace 这类词，只出现在复制出的文本里。

## 8. 排障与分析

在 HyperDX 里使用下面这些查询。`tools/observability/` 提供按官方 API schema 编写的仪表盘与告警模板；部署时需要替换 source、connection 和通知渠道，并验证当前实例的表结构与查询。

| 用途 | 定义 |
|---|---|
| 首个输出耗时 | `baton.turn` 的 `baton.turn.first_output_ms`，按 `baton.agent`、`gen_ai.provider.name`、`os.type`、`service.version` 看 p50 和 p95 |
| Turn 完成率 | `baton.turn` 里 `baton.turn.result = completed` 的比例，分组同上 |
| 断线恢复耗时 | `baton.wait.end` 里 `baton.wait.reason = device_offline` 的等待毫秒数 |
| 投递积压 | `baton.outbox.oldest_age_s`、`baton.reports.oldest_age_s` |
| Project Run 失败率与成本 | `baton.project.run` 的结果分布；`gen_ai.chat` 与 `gen_ai.embeddings` 的用量按 `gen_ai.request.model` 求和，`baton.usage.reported = false` 的单独计数 |
| LLM 会话与工具链审查 | ClickStack `/llm` 按 `gen_ai.conversation.id`、`gen_ai.agent.name`、`user.id` 聚合会话，在 Session 抽屉中查看完整提示词、思考过程、工具调用参数与结果及模型回复 |
| 版本对比 | 上面每一项按 `service.version` 分组，比较发布前后；Worker 与 batond 版本不同的 trace 单独筛出 |
| 慢查询 | 现有数据库 span 的耗时和 `db.client.connection.wait_time_ms` |

告警先设三个：`baton.wait.oldest_age_s` 超过阈值、`baton.ledger.budget_ratio` 接近预警水位、Turn 完成率比前一天明显下降。阈值先设宽，用一段时间后再收紧。

ClickStack 自带 MCP server，Claude Code、Codex 可以直接查 logs、traces、指标和仪表盘。接入方式和按 Thread ID、trace id 查询的步骤写在 AGENTS.md 的排障一节。拿到一份诊断信息后，Agent 先按 trace id 找到完整链路，再按 `baton.error.code` 查同一错误最近出现的次数和版本分布。

手动的真实 Agent 冒烟脚本可以把数据导到本地 HyperDX，四个 provider 各跑一轮，然后在同一张图里比较会话启动、首个输出和恢复耗时。冒烟脚本不进 CI。

## 9. 边界

- 遥测不可用时业务照常运行。没有任何业务逻辑读取遥测结果。
- 中心不可用期间，设备和网页的遥测直接丢弃；中心自身的数据同时中断，从中心那一侧也能看出这段时间出了问题。需要观察设备时，在设备上设置本地 `OTEL_*` 直连后端。
- daemon 重启后仍存活的旧 Worker 保留旧本机端口和令牌，不能向新 daemon 转发；重启 Worker 后采用新端口。双版本运行时的完整遥测验收尚未执行。
- 转发会增加中心的流量和 CPU。数据量变大时，在中心旁部署 collector，中心改为转发给它。
- R-23 要求的在线设备、连接、队列和 Thread 状态诊断，仍然由中心的诊断接口提供给管理员。HyperDX 是开发者深入排查用的，二者使用同一组字段名。
- 中心诊断接口和员工 status API 读的是数据库，不依赖 HyperDX。
- 产品分析（漏斗、留存、问卷）不在本设计范围内。

## 10. 验证

| 需求 | 设置与观察 | 失败条件 | 位置 |
|---|---|---|---|
| R-22、R-23 | 向白名单外的自定义属性、事件、日志正文、日志属性、指标标签、资源属性和错误详情注入敏感标记；向 `gen_ai.*` 写入超过 128 KiB 的消息与工具结果及超过 1 MiB 的输出 | 白名单外标记出现在序列化后的 OTLP 数据里；字段未按各自预算截断、破坏 JSON 结构或丢失可保留的最终回复 | `packages/telemetry/tests/tracing.test.ts` 已通过 |
| R-23 | 一条消息从中心 HTTP 进入，经 Worker 和 agent-host 回放替身完成；一次 Project Run 经 Runtime 本地模型替身完成。用本地 OTLP 接收替身收集数据 | 链路上的 span 不属于同一 trace；`baton.turn`、`baton.agent.tool`、`chat {model}`、`baton.project.tool`、`embeddings {model}` 缺少必填 `gen_ai.*` 活动或元数据字段；模型未报告用量时写成 0 | `e2e/src/provider-agents.integration.test.ts`、`e2e/src/project-telemetry.integration.test.ts` 已通过 |
| R-23、RL-A09 | 两个构建版本的 batond 和 Worker 同时运行，产生等待、失败、停止和恢复 | 资源属性的版本不是该进程实际运行的版本 | 待手工验证 |
| R-23 | 导出端不响应、返回错误、超过并发上限 | 业务结果改变，或关闭等待超过上限 | `packages/telemetry/tests/tracing.test.ts` 已通过 |
| R-23 | 节点收到或没收到 `forward: true`；同时有本地 `OTEL_*` 环境变量；连接断开；发送队列有积压；批次超过 `MaxMessageBytes` | 没有 `forward: true` 时仍发送；本地配置被覆盖；遥测进入账本、被重发或延迟业务消息 | `apps/batond/src/daemon/{reconnect,transport,telemetry-relay,cli}.test.ts`、`packages/telemetry/tests/tracing.test.ts` 已通过 |
| R-22、R-23 | 设备和网页的数据带伪造的 `baton.node.id`、`baton.employee.id`、白名单外属性、未知 `service.name` 和不合规的回放记录；后端不响应 | 伪造身份被转发；白名单外内容到达后端；转发影响中心自身导出或业务请求 | `packages/telemetry/tests/forward.test.ts`、`apps/server/src/telemetry-forward-client.test.ts` 已通过 |
| R-22 | 未登录、Origin 不符、请求体超过 1 MiB、转发关闭时访问 `/api/v1/telemetry` | 请求被接受或被转发 | `apps/server/src/http/api.integration.test.ts` 已通过 |
| R-22 | 检查 `node.sync_result`、`GET /me`、网页构建产物和 SEA 安装包 | 出现遥测地址、headers 或 key | `e2e/src/provider-agents.integration.test.ts`、`tools/telemetry-scan.test.mjs` 和 `tools/check-package.mjs` 已通过 |
| R-22 | 网页没有配置、有配置、开启回放 | 没有配置时发起连接；回放没有遮住文字或输入；采集了 console 或请求正文；发往同源以外的地址 | `web/src/telemetry/{config,export.integration,disabled.integration,loading}.test.ts` 已通过 |
| R-23 | 一条消息从网页到 agent-host、一次 Project Run 到 Runtime，数据经 batond 和中心转发到本地 OTLP 接收替身 | 链路断成多条 trace，或经转发后丢字段 | `e2e/src/provider-agents.integration.test.ts`、`e2e/src/project-telemetry.integration.test.ts` 已通过；浏览器界面到真实后端完整链路待手工验证 |

跨 app 测试以已登录 HTTP 会话提交网页测试 span 和消息，验证 HTTP → Worker → Pi agent-host → 报告，以及中心 → Project Runtime → 本地模型替身的同 trace；网页 SDK 的实际序列化和回放另由网页测试验证。双版本进程同时运行并覆盖等待、失败、停止和恢复，以及浏览器界面到真实遥测后端的完整链路尚待手工验证；构建身份和伪造环境变量覆盖检查不能替代该验证。硬 SIGTERM 会终止 Runtime，未结束的 span 不导出，等待日志与指标用于诊断。
