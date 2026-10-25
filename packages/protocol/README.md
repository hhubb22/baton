# @baton/protocol

本包提供 Effect 4.0.6 Schema 和对应 TypeScript 类型。中心、batond、Worker 与浏览器共用这里的公开契约。`src/index.ts` 是统一入口，子模块也可单独导入。

## 覆盖范围

| 模块 | 契约 |
| --- | --- |
| `thread.ts` | Thread、从同一字段派生的摘要与详情、消息、回合、命令、报告及会话输出 |
| `project.ts` | Project、对话、事件、记忆、运行与 Runtime 请求及结果 |
| `device.ts` | 设备注册、身份、能力报告、授权目录、文件浏览和订阅登录 |
| `auth.ts` | 员工、登录、密码与浏览器会话 |
| `inbox.ts` | 事项、选项、处理输入与分页 |
| `http-api.ts` | 组合领域 Schema 与 Effect HttpApi 的路径、参数、状态及响应头，供中心路由与 OpenAPI 共用 |
| `http.ts` | HTTP 查询参数与浏览器事件 |
| `node.ts` | 节点 Frame、两个方向的业务消息联合类型与 `NodeBody` |
| `worker.ts` | 认证 IPC、具体 Worker 请求、持久命令接收、状态、完成及报告读取 |
| `commands.ts` | Thread 命令回执与完成报告的身份匹配 |
| `thread-question.ts`、`full-output.ts` | Agent 问题与回答、设备完整输出读取 |
| `common.ts`、`constants.ts`、`trace.ts`、`project-providers.ts` | 基础值、通用响应与诊断、容量限制、追踪上下文及 provider 标识规范化 |

领域模块不依赖 `node.ts`、`worker.ts`、`http.ts` 或 `http-api.ts`。传输模块直接组合领域 Schema；节点的 `Route`、`Source`、`Envelope` 和 `Frame` 定义在 `node.ts`。`SessionResponse` 统一定义在 `auth.ts`，`EnrollmentResponse` 统一定义在 `device.ts`，`http-api.ts` 重导出它们并在端点处附加状态与响应头。前者的 `csrf_token` 使用 `Schema.String`，两者的 `expires_at` 都使用 `Timestamp`。

`src/index.ts` 保留包入口的公开导出名，包内代码直接导入所属领域模块。

`http.ts` 另提供空 JSON 请求、全部 HTTP 查询参数、`ready`、`thread.changed`、`devices.changed`。查询参数保留 URL 上的字符串形式；HTTP handler 在校验后将其转换为业务数值。没有 JSON 正文的 204 响应不定义虚构的响应对象。

Worker IPC 包含认证、status、open/message/withdraw/resume/stop、settings、answer、pending/ack 和 session 输出读取，以及下述异步命令契约。Project Runtime 的 operation 包含启动与租约管理、事件读取与写入、输入认领、工具调用、压缩及结束确认。

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

Schema 不填充默认值，往返时保留空串、`false`、可选字段省略、`null` 和 `[]` 的区别。HTTP 输入中的默认模型、默认设备、可省略的 goal、Patch 字段及 role 参数按现有 handler 的接收约定声明。时间使用 RFC 3339 字符串，保留小数秒精度，不转换为精度较低的 JavaScript Date。JSON 整数限定为 JavaScript 安全整数；数据库 bigint 超出范围时消费者必须报错，不能静默舍入。

派生结构只追加或收窄字段，使用 `mapFields(..., { unsafePreserveChecks: true })` 保留父结构的整体容量和关系检查；不改变字段的派生契约直接在原 Schema 上增加检查。`ThreadSummary`、`ThreadView` 均从 `Thread` 派生，共用其字段约束，并各自追加列表或详情字段。

## Worker 接收、状态与完成

执行请求使用 `WorkerRequest` 中的具体变体。`WorkerIPCMessage` 是完整字段集合，供通用帧检查使用；服务端处理具体操作时使用具体变体，不能只凭通用字段集合接收命令。

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

`node_id` 是本人设备，`report_version` 是已经保存的非负能力报告版本，与节点报告 ACK 的同名字段一致；nodes DTO 中对应 `runtime_report_version`。中心在 reason-only 等设备报告变更持久保存后发送此事件。浏览器收到后重新读取设备报告，避免凭事件推测能力或解析 reason。该事件是刷新提示；重复或相同版本不构成新的执行事实。中心负责发送，网页负责消费。

## Thread 历史与实时输出

Thread 历史通过中心时间线读取已保存的输入、回复和事件，原生会话记录由设备上的 Agent 管理。`SessionRequest` / `SessionResult` 用于按需读取设备实时输出或已保存的完整输出，返回状态、正文或编码字节、游标与缺口；协议不提供原生历史查询。

## 契约测试

```sh
pnpm --dir packages/protocol run typecheck
pnpm --dir packages/protocol run lint
pnpm --dir packages/protocol run test
```

协议包使用少量 TS 自写样例验证 Thread 派生对象往返、字段约束与未知字段容忍、命令完成身份、open 成功回执的存储代次、Worker 就绪关系、问题与回答容量，以及 Inbox 选项约束。HTTP 契约测试核对路径、参数、响应与错误声明，并验证 Session、Enrollment 在领域与 HTTP 入口的响应约束。已有调用方覆盖的 Schema 随对应业务测试验证。

中心、节点、Worker 和网页的调用方测试验证这些契约在实际路由、命令接收、异步完成和事件消费中的使用。协议包只检查传输形状及局部关系；账本事务、ACK 与完成到达顺序、数据库 JSONB 容量、权限、租约、Agent 行为、跨系统进程和安装包由对应模块验证。
