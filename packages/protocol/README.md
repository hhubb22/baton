# @baton/protocol

本包提供 Effect 4.0.6 Schema 和对应 TypeScript 类型。中心、batond、Worker 与浏览器共用这里的公开契约。`src/index.ts` 是统一入口，子模块也可单独导入。

## 覆盖范围

`fixtures/go-http-node.json` 保存 115 个结构的静态字段清单，包含原始来源文件、Go 类型或匿名声明名、字段种类、可选性与可空性。`dtoSchemas` 保留这些结构，并包含 TS 新增契约。来源版本、导出方式和文件摘要见 [夹具来源](fixtures/README.md)。

| 历史来源 | 结构数 | 契约 |
| --- | ---: | --- |
| `internal/protocol` | 38 | Frame、Envelope、Route、Source、Presence、Revocation；全部 Thread、Session、文件、设备设置、订阅登录、Runtime 报告及 Project Runtime 消息 |
| `internal/httpapi` | 32 | 登录、员工、改密、设备注册、默认设备、吊销、目录、授权、登录码、文件预览、Thread 创建/模型、Project/记忆列表、错误与冲突；浏览器订阅和输出事件 |
| `internal/store` | 18 | Thread、消息、Turn、列表、详情、时间线、trace；Project 状态/运行/消息页；注册状态和记忆修订 |
| `internal/projectagent` | 16 | Project、Agent、主对话、创建/修改输入、消息、事件、记忆、bootstrap、claim、排队输入、preview、compaction |
| `internal/inbox` | 6 | 事项、选项、回答、处理参数及列表 |
| `internal/node` | 3 | 注册身份、凭据、保存的默认设备响应 |
| `internal/control` | 2 | `node.sync`、`node.sync_result` |

`http.ts` 另提供空 JSON 请求、全部 HTTP 查询参数、`ready`、`thread.changed`、`devices.changed`。查询参数保留 URL 上的字符串形式；HTTP handler 在校验后将其转换为业务数值。没有 JSON 正文的 204 响应不定义虚构的响应对象。

`worker.ts` 包含静态基线的 18 个 IPC 字段、认证、status、open/message/withdraw/resume/stop、pending/ack、session 输出读取，以及下述异步命令契约。`node.ts` 提供 Frame 和两个方向的业务消息联合类型。Project Runtime 的 16 种 operation 均有静态样例，包括 `started`、`stopped`、`wake_received`、`read_events`、`append_event`、`call_tool`、`wait_tool`、`commit_compaction`。

动态数据使用 `Schema.Json`，例如 pi-ai 的 assistant payload、签名、usage、tool arguments/results、Project Runtime 的 `data`。它们的扩展字段不会被解释或删除。回复附件须为 JSON 数组，metadata 须为 JSON 对象。中心还需校验 PostgreSQL `jsonb::text` 的数据库容量约束。

## 解码与编码

```ts
import { Schema } from 'effect'
import { CreateBrowserThreadInput, NodeBody } from '@baton/protocol'

const input = Schema.decodeUnknownSync(CreateBrowserThreadInput, {
  onExcessProperty: 'error',
})(requestBody)

const message = Schema.decodeUnknownSync(NodeBody)(nodeBody)
```

HTTP JSON 正文和工具参数严格拒绝未知字段；跨进程消息使用默认的未知字段容忍。Gateway 校验后转发保留的原始字段，不能用丢弃未知字段后的 DTO 重建待转发信封。`Source` 来自中心认证结果，不能信任节点提交的同名字段。包内 Schema 校验数据形状，连接归属、员工权限、租约和数据库事实由相应服务校验。

Schema 不填充默认值，往返时保留空串、`false`、可选字段省略、`null` 和 `[]` 的区别。HTTP 输入中的默认模型、默认设备、可省略的 goal、Patch 字段及旧 role 参数按现有 handler 的接收约定声明。时间使用 RFC 3339 字符串，保留静态基线中的九位小数，不转换为精度较低的 JavaScript Date。JSON 整数限定为 JavaScript 安全整数；数据库 bigint 超出范围时消费者必须报错，不能静默舍入。

派生结构只追加或收窄字段，使用 `mapFields(..., { unsafePreserveChecks: true })` 保留父结构的整体容量和关系检查；不改变字段的派生契约直接在原 Schema 上增加检查。回归测试直接校验每个公开 Frame/Worker 入口，避免只有基础结构受限。

## Worker 接收、状态与完成

执行请求使用 `WorkerRequest` 中的具体变体。`WorkerIPCMessage` 是完整字段集合，供夹具校验与帧检查使用；服务端处理具体操作时使用具体变体，不能只凭通用字段集合接收命令。

| Schema | 约定 |
| --- | --- |
| `WorkerOpen` | 必须有原始 `command_id`、`thread_id`、`storage_generation`、`open_config`。配置中的 Thread 与代次必须相同 |
| `WorkerOpenConfig` | 保存 node、Thread、代次、Agent、目录、可选模型、执行期限及 `adapter_config`；配置只含非敏感路径和标识 |
| `WorkerMessage` | 同一执行身份，加 `client_message_id`、`payload`、可选 mode/model；正文最多 64 KiB |
| `WorkerWithdraw`、`WorkerResume`、`WorkerStop` | 同一执行身份；withdraw 还需消息 ID |
| `WorkerCommandReceipt` | `{ command_id, thread_id, storage_generation, action }`。这是同事务持久保存的接收事实，重复同 ID/同内容返回同一 receipt |
| `WorkerCommandStatus` | `{ command_id, state, command_outcome?, reason? }`。accepted/running 没有 outcome；四种终态必须与 outcome 相同 |
| `WorkerCommandResult` | `type: result`、`ok: true`、receipt、command_status。两处 command ID 必须相同；存在 session_id/代次时必须与 receipt 一致 |
| `WorkerCommandStatusQuery` | `type: thread_command_status`，携带原始 command ID、Thread、代次；只查询持久结果，不再次调度执行 |
| `WorkerStatusResult` | `worker_ready` 与 `agent_ready` 必须分别返回；Agent ready 要求 Worker ready。原生启动中返回前者 true、后者 false |

命令未被持久接收时，查询返回普通 `WorkerResult`，`ok: false, code: command_not_found`。相同 ID/不同内容的拒绝同样返回错误结果。传输重试继续使用中心信封的 `message_id`；`ThreadCommand` 正文不另造一个命令 ID。

withdraw 在撤回事实持久保存后以 succeeded 结束；已经无法撤回的请求明确失败；执行事实不能确定时使用 unknown。accepted/running 只用于本地执行状态，不能作为 `command_outcome`。

`ThreadCommandResult` 的 `storage_generation` 是正式字段。接收 open 的中心使用 `ThreadOpenCommandResult` 或 `isCommandReceiptFor(command, result)`，以保证成功回执携带代次；其他动作的回执不强制重复代次。接收确认不产生 opened/resumed/idle。

`CommandCompleted` 是 `ThreadReport` 的 `command.completed` 变体，必需 command ID、Thread、event ID、正 worker_seq、存储代次、reason 和 `succeeded | failed | cancelled | unknown` 结果。`ThreadReport` 本身也校验完成字段不能缺失。中心可使用 `isCommandCompletionFor(expected, report, authenticatedNodeID)` 检查命令 ID、Thread、节点及代次。完成 JSONB 可保存该完整报告；接收时间与完成时间分别记录。数据库事务仍须验证当前员工、连接、命令存在性、报告序号、重复摘要和状态转换，保持业务报告在完成报告之前。

## 设备能力与浏览器事件

`RuntimeAgent` 正式保留 `reason`、`status` 和全部 capability，包括 `create`。reason 最多 1024 UTF-8 字节，拒绝 NUL、控制字符及常见 token/API key/Bearer/JWT 格式。生产者负责从诊断输出提取脱敏摘要；格式检查无法识别任意上下文中的秘密。完整报告仍受 64 KiB 限制。

`DevicesChanged` 的 wire 结构为：

```json
{
  "type": "devices.changed",
  "node_id": "12345678-1234-4234-8234-123456789abc",
  "report_version": 2
}
```

`node_id` 是本人设备，`report_version` 是已经保存的非负能力报告版本，与节点报告 ACK 的同名字段一致；nodes DTO 中对应 `runtime_report_version`。中心在 reason-only 等设备报告变更持久保存后发送此事件。浏览器收到后重新读取设备报告，避免凭事件推测能力或解析 reason。该事件是刷新提示；重复或相同版本不构成新的执行事实。C 负责发送，W 负责消费。

## Thread 历史与实时输出

Thread 历史通过中心时间线读取已保存的输入、回复和事件，设备不保存原生历史。`SessionRequest` 仅用于实时输出，`SessionResult` 返回输出状态、正文、游标和缺口。

## 静态基线与契约检查

```sh
pnpm --dir packages/protocol run typecheck
pnpm --dir packages/protocol run lint
pnpm --dir packages/protocol run test
```

`fixtures/` 中的三个 JSON 是已提交的静态基线，测试直接读取，不需要生成步骤或 Go 工具链。文件保留 `go-` 前缀、原始排版及来源元数据，便于追溯；各文件的历史来源和样例性质见 [夹具来源](fixtures/README.md)。

TS 测试按静态字段清单核对 Schema 的字段和可选性，并显式列出允许的 TS 新增字段及输入可选性调整；逐字段拒绝错误种类，再以 `onExcessProperty: error` 解码当前 TS 契约使用的样例并重新编码比较。原生历史的 `ThreadHistoryQuery` 和 Worker `native_history` 样例保留作来源证据，测试跳过这两项。Thread 详情样例补入当前必需的 `pending_questions`、`question_answers` 空数组后校验。测试另覆盖容量、控制字符、整数、状态、完成身份、ready 区分和新增契约的无效样例。

新契约及调整由 TS Schema、调用方和独立样例共同验证，静态基线用于检查保留的字段与传输值。协议测试验证传输契约；账本事务、ACK/完成到达顺序、数据库 JSONB 容量、Agent 行为、跨系统进程和安装包由各模块的测试验证。
