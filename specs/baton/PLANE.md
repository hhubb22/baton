# Plane 测试项目实证

Status: 调查记录。文末方案已于 2026-10-18 批准，设计条款见 TECH「Plane 接入」。
Date: 2026-10-17
Basis: PRODUCT R-01、R-33、R-34、R-35、R-36；TECH「Plane 接入」与 Q4。

本次只在项目 Baton Test 中创建、修改和删除名称以 `baton-t25-` 开头的测试工单及评论，结束后 `GET /api/v1/workspaces/baton/projects/{project_id}/issues/` 的 `total_count` 回到 8，与调查开始前的演示工单数量一致。没有修改实例设置、其他项目、账号或 Webhook 的事件开关。为观察非 2xx，曾把该 Webhook 的 `url` 临时改为 `https://example.com/baton-plane-probe-missing`，记录到响应后立即改回原来的接收地址；改回后 `is_active` 仍为 true，五个事件开关和 `version` 与改前相同。

下文不记录口令、API token、Webhook 秘密、签名值或邮箱。身份以用户 ID 和显示名区分。

## 环境

`GET /api/instances/` 无需认证，返回 `instance.current_version` 为 `1.4.2`，`instance.latest_version` 为 `v1.4.2`，`instance.edition` 为 `PLANE_COMMUNITY`，`config.is_self_managed` 为 true，`config.enable_signup` 为 false。

| 对象 | 实测值 |
|---|---|
| 工作区 slug | `baton` |
| 工作区 ID | `op://Baton Test/plane/PLANE_WORKSPACE_ID` |
| 项目 | Baton Test，identifier `BATON` |
| 项目 ID | `op://Baton Test/plane/PLANE_PROJECT_ID` |
| Webhook ID | `op://Baton Test/plane/PLANE_WEBHOOK_ID` |

这些 ID 属于这一套测试数据。适配器应读取部署配置，不要把上表写死。

## 结论

1. Webhook 签名是对原始正文的 HMAC-SHA256，结果为 64 位十六进制。没有时间戳或重放窗口。
2. `X-Plane-Delivery` 是每次送出的 UUID，不是工单 ID，也不能单独代表业务动作。一次修改多个字段会产生多条事件，到达顺序不保证与 `data.updated_at` 一致。一次 HTTP 405 只留下一条 `retry_count` 为 0 的日志，到 2026-10-17T16:16:06Z 没有第二次投递。连接失败和其他状态码是否重试未测。
3. 社区版可以读到状态、标签、优先级和指派人。自定义属性端点不存在，未知 JSON 字段被忽略。当前工单事实以 `GET` 工单为准，不使用 Webhook 正文里的快照做门槛判断。
4. 现有 API token 代表管理员用户，没有单独的权限范围字段。普通成员能读写项目内工单，不能删除管理员创建的工单，也不能读取 Webhook。`activity.actor.id` 与邮箱能对应到实际操作者；工作区里还有一个未加入项目成员关系的账号，不能把它映射成员工。
5. 创建评论和修改状态都有 API。评论和工单都能带 `external_source` 与 `external_id`。重复创建返回 409 和已有 ID。评论列表的同名查询参数不会过滤。
6. 项目 `network` 为 2，但没有公开锚点。未登录不能读工单。项目成员能看到工单名称、描述和 `INTERNAL` 评论。

## Webhook 来源验证

管理员会话 `GET /api/workspaces/baton/webhooks/{webhook_id}/` 返回的 Webhook 属于上述工作区。`project`、`issue`、`cycle`、`module`、`issue_comment` 都是布尔值且均为 true，不是项目 ID。`version` 为 `v1`，`is_internal` 为 false，`is_active` 为 true。同一响应包含 `secret_key`；适配器不得记录这个响应。`GET /api/v1/workspaces/baton/webhooks/` 为 404。普通成员请求 Webhook 和工作日志均为 403，正文 `error` 为 `You don't have the required permissions.`

接收服务保存的 Plane 请求，以及 Plane 自己在 405 那次投递中记录的 `request_headers`，来自 Plane 的头是：

| 头 | 实测 |
|---|---|
| `Content-Type` | `application/json` |
| `User-Agent` | `Autopilot` |
| `X-Plane-Event` | `issue` 或 `issue_comment` |
| `X-Plane-Delivery` | 36 字符 UUID |
| `X-Plane-Signature` | 64 位十六进制 |

没有 `Date`、时间戳头，也没有把 `X-Plane-Delivery` 放进正文。代理附加的转发头不参与签名。

用配置的 Webhook 秘密对接收服务保存的原始正文字节计算 HMAC-SHA256，与 `X-Plane-Signature` 一致。含非 ASCII 工单名时，正文里是 `\u` 转义而不是原始 Unicode 字符，该原始字节仍然通过校验。把 JSON 解析后再用紧凑分隔符编码，不能通过同一签名。因此校验对象是 HTTP 原始正文，不是重新序列化的对象，也不是头部。

同一批早期事件在数十分钟后仍然通过校验。签名不包含时间，重复发送同一正文和签名会通过校验。

`tools/plane-probe` 用独立测试向量覆盖上述算法，不包含这套环境的秘密。

## 事件标识与投递

正文顶层固定为 `event`、`action`、`webhook_id`、`workspace_id`、`workspace_slug`、`data`、`activity`。`webhook_id`、`workspace_id`、`workspace_slug` 与上表一致。`activity` 含 `field`、`old_value`、`new_value`、`actor`、`old_identifier`、`new_identifier`。

本次实际产生的 `event` 只有 `issue` 和 `issue_comment`。Webhook 虽然打开了 project、cycle、module，但没有制造这些对象的变更，它们的正文字段未知。

| 操作 | 观察 |
|---|---|
| `POST` 创建工单 | 一条 `issue` / `created`。`activity.field` 为 null |
| `PATCH` 一个变化字段 | 一条 `issue` / `updated`，`field` 为该字段 |
| `PATCH` 同时改 `priority` 与 `name` | 两条 `issue` / `updated` |
| `PATCH` 同时改 `labels` 与 `assignees` | 两条 `issue` / `updated` |
| `PATCH` 成当前已是的状态 | 没有新事件 |
| `POST` 评论 | 一条 `issue_comment` / `created` |
| 用相同 `external_source` 与 `external_id` 再次创建评论 | HTTP 409，没有第二条评论事件 |
| `DELETE` 工单 | HTTP 204。Plane webhook 日志条数不增加，接收服务也没有 `deleted` |

`X-Plane-Delivery` 在观察到的成功投递中互不重复，并且不等于工单 ID 或 Webhook ID。Plane webhook 日志的 `retry_count` 全部为 0，`request_method` 记录的是 `created` 或 `updated`，不是 HTTP 方法，`response_status` 是字符串。

乱序可以直接看到。同一次 `PATCH {"priority":"high","name":"...-rev"}` 产生：

| 到达时间 | `activity.field` | 该条 `data.updated_at` |
|---|---|---|
| 2026-10-17T15:59:41.711Z | `name` | 2026-10-17T15:59:41.539035Z |
| 2026-10-17T15:59:41.713Z | `priority` | 2026-10-17T15:59:41.455101Z |

后到达的 priority 事件，其 `data.updated_at` 更早。两条 `data` 都已经同时包含新名称和新优先级。另一对 labels 与 assignees 的 `data.updated_at` 相同，按到达顺序不能区分先后。头部没有序号。

非 2xx：部署的接收服务对探测过的路径都返回 200，不能用它制造失败。临时把 Webhook URL 指到 `https://example.com/baton-plane-probe-missing`。对该地址的 `POST` 直接请求返回 405。随后用 API token 创建一条评论，API 返回 201。Plane webhook 日志新增一条 `issue_comment` / `created`，`response_status` 为 `405`，`retry_count` 为 0，`created_at` 为 2026-10-17T16:04:59.087040Z。日志请求头仍然只有上面五个 Plane 头。URL 随即恢复。

2026-10-17T16:16:06Z 再次读取同一 Webhook 和全部 webhook 日志：`is_active` 仍为 true，URL 已回到原接收地址。非 200 日志仍只有这一条 405，所有日志的 `retry_count` 都是 0。最后一条日志的 `created_at` 是 2026-10-17T16:07:17.065079Z，来自随后的标记复用实验，不是这次 405 的第二次投递。从 405 到复查约 11 分钟，没有新的失败日志。连接被拒绝、超时或其他状态码是否重试没有测试；继续制造失败可能在多次失败后停用 Webhook，因此没有做。

## 触发与审批字段

`GET /api/v1/workspaces/baton/projects/{project_id}/` 使用 `X-API-Key`。与触发有关的实测字段：

| 字段 | 实测 |
|---|---|
| `network` | `2` |
| `is_deployed` | false |
| `is_issue_type_enabled` | false |
| `guest_view_all_features` | false |
| `intake_view` | false |
| `estimate` | null |
| `member_role` | 调用者为 `20` |

状态 `GET .../states/`：

| 名称 | 组 | 默认 | ID |
|---|---|---|---|
| Backlog | `backlog` | true | `{state_id}` |
| Todo | `unstarted` | false | `{state_id}` |
| In Progress | `started` | false | `{state_id}` |
| Done | `completed` | false | `{state_id}` |
| Cancelled | `cancelled` | false | `{state_id}` |

状态对象含 `external_id` 与 `external_source`，当前均为 null。没有改过状态定义。

标签 `GET .../labels/` 有 `concepts`（`{label_id}`）和 `admin`（`{label_id}`），二者的 `external_id` 与 `external_source` 也为 null。

优先级实际写入并读回的值有 `none`、`low`、`medium`、`high`、`urgent`。

`GET .../estimates/`、`.../issue-types/`、`.../issue-properties/`、`.../work-item-properties/`、`.../custom-fields/` 均为 404。`GET .../issues/?pql=...` 与 `?filters=...` 为 400，正文说明这个版本不支持 PQL 和结构化过滤。`PATCH` 工单只提交未知的 `custom_properties` 返回 200，字段被忽略，没有对应 Webhook。

读取当前工单：

- `GET /api/v1/workspaces/baton/projects/{project_id}/issues/{id}/`
- 同时带 `external_id` 与 `external_source` 查询 `GET .../issues/` 时，返回这一张工单对象，不是分页列表。不存在时 404，正文 `error` 为 `The requested resource does not exist.`
- 只带 `external_id` 不会过滤，仍返回分页列表。
- `GET /api/v1/workspaces/baton/work-items/BATON-1/` 与 `GET /api/v1/workspaces/baton/issues/BATON-8/` 都能按 identifier 和序号读到已有演示工单。

v1 工单响应里的 `state`、`labels`、`assignees` 是 ID 或 ID 数组。Webhook 的 `data.state` 是 `{id,name,color,group}`，`data.labels` 是 `{id,name,color}` 数组，`data.assignees` 是用户对象数组。Webhook 的 `data` 还包含 `description_html` 与 `description_stripped`；一次创建事件中，后者是描述的纯文本。这个快照会混入同一次请求里其他字段的最终值，不能当作该条 `activity` 发生时的门槛事实。

## 身份与权限

v1 认证头是 `X-API-Key`。`GET /api/v1/users/me/` 返回管理员：ID `{admin_user_id}`，`display_name` 为 `admin`，邮箱与配置的管理员邮箱一致。响应头有 `X-RateLimit-Remaining` 和 `X-RateLimit-Reset`，没有看到 `X-RateLimit-Limit`。

管理员会话 `GET /api/users/api-tokens/` 只有一条 token：`is_active` true，`expired_at` null，`user_type` 0，`workspace` null，`is_service` false，`allowed_rate_limit` 为 `60/min`，`user` 就是上面的管理员。列表响应不含 token 秘密。用该 token 请求不存在的工作区 slug 返回 403。`GET /api/v1/workspaces/baton/` 即使带这个 token 也返回 401，正文 `detail` 为 `Authentication credentials were not provided.`；同 token 可以列出项目和工单。token 不能调用 `/api/workspaces/...` 应用接口，返回同样的 401。

会话不能调用 `/api/v1/users/me/`，返回 401。成员权限是用应用会话观察的：`GET /auth/get-csrf-token/` 后，以表单 `POST /auth/sign-in/`，成功时 302 并设置 `session-id`。

`GET /api/v1/workspaces/baton/members/`：

| 用户 ID | 显示名 | `role` | 说明 |
|---|---|---|---|
| `{admin_user_id}` | admin | 20 | 管理员，`is_bot` false |
| `op://Baton Test/plane/PLANE_MEMBER_ID` | member | 15 | 普通成员，`is_bot` false；ID 与配置的成员 ID 一致 |
| `{plane_bot_user_id}` | Plane | 20 | 邮箱不是两个已配置的人类账号 |

应用接口 `GET /api/workspaces/baton/projects/{project_id}/members/` 只有两行成员关系：管理员 `role` 20，普通成员 `role` 15。Plane 那个用户不在项目成员关系里。项目 `total_members` 为 2。v1 的 `GET .../projects/{id}/members/` 却返回三个用户对象且没有 `role`。判断项目角色时不能只看 v1 的这个列表。

普通成员在应用接口上的实测：

| 操作 | 结果 |
|---|---|
| 列出项目工单 | 200，调查开始时 `total_count` 与管理员同为 8 |
| 读取管理员创建的工单 | 200，响应含 `name` 与 `description_html` |
| 读取评论 | 200，同时看到 `access` 为 `INTERNAL` 和 `EXTERNAL` 的评论 |
| `POST` 工单、`POST` 评论 | 201 |
| `PATCH` `priority` | 204，响应体为空 |
| `PATCH` `state_id` | 204；随后 v1 `GET` 读到新状态 |
| `DELETE` 自己创建的工单 | 204 |
| `DELETE` 管理员创建的工单 | 403 |
| `PATCH` 项目 `network` | 403；项目 `network` 仍为 2 |
| 读取 Webhook 或 webhook 日志 | 403 |

没有嘉宾账号，角色 5 的能力未知。没有为普通成员创建 API token，所以普通成员调用 `/api/v1` 的结果未知。

Webhook `activity.actor` 是用户对象，含 `id`、`email`、`display_name`、`first_name`、`last_name`、`avatar`、`avatar_url`。API token 造成的事件，其 actor 是管理员而不是名为 Plane 的账号。普通成员在应用接口上的修改和评论，actor 是该成员。评论正文 `data.actor` 只是用户 ID 字符串，不是对象。映射应使用 `activity.actor.id`，并用邮箱与成员目录核对。

## 回写与去重

v1 写操作使用 `X-API-Key`，路径前缀 `/api/v1/workspaces/baton/projects/{project_id}`。

| 动作 | 方法与路径 | 结果 |
|---|---|---|
| 创建工单 | `POST /issues/` | 201，返回工单 ID、`sequence_id`、`external_id`、`external_source` |
| 修改状态 | `PATCH /issues/{id}/`，正文 `state` 为状态 ID | 200，`state` 变为该 ID |
| 修改优先级、名称、标签、指派人 | `PATCH /issues/{id}/` | 200 |
| 创建评论 | `POST /issues/{id}/comments/` | 201 |
| 按 ID 读评论 | `GET /issues/{id}/comments/{comment_id}/` | 200，含 `external_id` 与 `external_source` |
| 删除工单 | `DELETE /issues/{id}/` | 204，随后 `GET` 为 404 |

评论创建实际接受 `comment_html`、`external_source`、`external_id`、`access`。不传 `access` 时保存为 `INTERNAL`；传 `EXTERNAL` 也会保存。`actor` 和 `created_by` 都是调用者的用户 ID。

相同 `external_source` 加 `external_id` 再次 `POST` 工单或评论，返回 409，正文含 `error` 和已有对象的 `id`。评论的这条约束按项目生效：把同一对标记发到另一张工单，409 返回的仍是第一张工单上的评论 ID。删除工单后，同一对工单标记和同一对评论标记都可以再次创建成功，因此删除会放开标记。

`GET .../issues/{id}/comments/?external_id=...&external_source=...` 在存在两条评论时仍返回两条，查询参数没有过滤。`GET /api/v1/workspaces/baton/work-items/search/?search=...&project_id=...` 能按工单名搜索，按评论里的固定前缀搜索返回空的 `issues` 数组。固定前缀可以出现在 `comment_html` 里供人阅读，不能当作查询键。

响应丢失时的实测找回方式是用同一对 `external_source` 与 `external_id` 再执行创建。201 表示这次写入成功，409 的 `id` 表示已经存在；再用评论或工单的 `GET` 核对标记。不要依赖评论列表的查询参数。

## 工单摘要可见性

未登录请求 v1 或应用接口的工单列表均为 401。`GET /api/public/workspaces/baton/projects/{project_id}/anchor/` 在无认证、成员会话、管理员会话和 API token 下都是 404，正文 `error` 为 `The required object does not exist.` 项目 `is_deployed` 为 false。因此当前没有可匿名打开的公开页。`network` 数值为 2；本次没有改这个字段，也不能由此推出改成其他值后的可见性。

项目成员能在列表和详情中看到工单 `name` 与 `description_html`，并能看到 `INTERNAL` 评论。Webhook 正文同样带有描述。回写若写进工单描述或 `EXTERNAL` 评论，项目成员现在就能阅读；项目一旦被公开，`EXTERNAL` 评论还会进入公开评论接口。本次没有公开项目，匿名读取公开评论的结果未知。

## 适配器契约

以下只使用上面确认过的行为。

**验证。** 读取 HTTP 原始正文，用 Webhook 秘密做 HMAC-SHA256，与 `X-Plane-Signature` 做常量时间比较。签名必须是 64 位十六进制。缺少秘密、签名格式不对或比较失败则拒绝，不创建任务。不检查时间戳，因为请求里没有。不要解析后再编码正文来验签。`go run ./tools/plane-probe -body FILE -signature HEX` 做同样的比较，秘密只从 `PLANE_WEBHOOK_SECRET` 读取并且不打印。

**投递去重。** 同时保存 `X-Plane-Delivery` 和原始正文的 SHA-256。任一已经处理过就不再次进入触发判断。`X-Plane-Delivery` 单独不够：它是每次送出的新 UUID，而相同正文会算出相同签名。本次没有观察到 Plane 重发同一 delivery，但 405 也没有提供新的 delivery。

**乱序。** 收到事件后按 `data.id` 调用 v1 `GET` 工单，用读到的状态、标签、优先级和指派人决定是否触发。不按到达顺序折叠 `activity`，也不把 Webhook `data` 当作当前事实。`data.updated_at` 更早的事件可以后到，而且 `data` 可能已经包含同一次请求中其他字段的新值。同一字段的重复 `PATCH` 如果值没变，Plane 不发送事件；这不能代替 Baton 自己的触发去重。

**执行去重。** Webhook 去重只消除同一投递。是否创建执行仍按已批准设计使用 `trigger_id`：重新读取工单后，条件不再满足则不触发。员工明确发起的新一轮执行使用新的触发记录。Baton 回写产生的评论带下面的标记；处理 `issue_comment` 时，`external_source` 为约定的 Baton 来源则不作为新的执行触发。

**读取当前事实。** `GET /api/v1/workspaces/{slug}/projects/{project_id}/issues/{id}/`，头 `X-API-Key`。已知外部标记时使用 `GET .../issues/?external_id={id}&external_source={source}`，两个参数必须同时存在。需要人类可读编号时使用 `GET /api/v1/workspaces/{slug}/work-items/{identifier}-{sequence_id}/`。

**回写。** 评论使用 `POST .../issues/{id}/comments/`，正文至少包含 `comment_html`、`external_source`、`external_id`。状态使用 `PATCH .../issues/{id}/`，v1 字段名是 `state`。创建返回 201；相同标记返回 409 且带已有 `id`。409 或网络失败后用该 `id` 做 `GET`，确认 `external_source` 与 `external_id`，确认过就不再创建第二条。评论列表查询参数不能用来找回。工单或评论删除后标记可以再次使用，所以不能把已删除对象的标记继续当成永久幂等键。

**身份。** 触发身份取 `activity.actor.id`，并核对该对象上的邮箱。只接受配置过的 Plane 用户 ID。`{plane_bot_user_id}` 没有项目成员关系，不能映射为员工。没有映射则不执行。当前 API token 的写操作会显示为管理员 `{admin_user_id}`，因此回写事件的 actor 是集成账号，不是工单上的指派人。

## 未知

- 连接失败、超时或 405 以外的 HTTP 状态是否重试，以及多次失败后 Webhook 是否会被关掉。已确认的只有一次 HTTP 405：约 11 分钟内没有第二次投递，Webhook 保持启用。
- project、cycle、module 事件的正文字段。
- 普通成员持有 API token 时 `/api/v1` 的权限，以及角色 5 的权限。
- 修改 `network` 或创建公开锚点后的匿名可见性。
- 状态和标签上的 `external_id` 能否写入。本次没有改这些定义。
- v1 应用级 `GET /api/v1/workspaces/{slug}/` 为何对有效 token 返回 401。项目列表和工单接口可用，适配器不依赖这个工作区详情路径。

## 已批准的方案

2026-10-18 批准，已写入 TECH「Plane 接入」。下文保留提出时的依据。

**版本。** 继续使用已经实测的社区版 1.4.2。升级或更换部署后需要重新验证签名、404/405 是否重试，以及评论标记。

**设计已批准。** 不用自定义属性，这个实例没有该接口。也不要占用 Done：Done 的组是 `completed`，和人工验收完成混在一起。建议新增一个项目标签，名称固定为 `design-approved`，用它的标签 ID 表示设计已批准。执行触发另行使用状态组 `started`（当前名称是 In Progress）。两者都在执行前用 v1 `GET` 工单确认，不按单条 Webhook 快照放行。现有的 Backlog、Todo、Done、Cancelled 继续只表达 Plane 工作流。

**员工映射。** 配置 Plane 用户 ID 到 Baton 员工的显式表，并用 `activity.actor.email` 核对。管理员 ID `{admin_user_id}` 只在该账号本人发起时代表该员工；集成 token 造成的回写不代表他发起了新执行。成员 ID `{member_id}` 映射到对应员工。Plane 显示名账号不映射。未映射的 actor 拒绝执行。

**回写摘要。** 用评论而不是改写工单描述。`external_source` 固定为 `baton`，`external_id` 使用 Baton 回写记录 ID。`access` 使用 `INTERNAL`。`comment_html` 只包含固定前缀 `baton-writeback`、Baton 任务链接、状态、短结果和证据引用，不包含 Session 原文、命令输出或凭据。状态变更仍由项目映射决定，并且必须带可查询标记，避免响应丢失后重复评论。当前项目成员都能阅读工单描述和 `INTERNAL` 评论；匿名用户现在不能。若以后公开项目，保持 `INTERNAL`，避免摘要进入公开评论。


## T27 回写实测（2026-10-18）

测试使用 Railway `baton-plane-test` 的 Plane 社区版 1.4.2、工作区 baton、Baton Test 项目；只读取 1Password `Baton Test/plane` 中已授权字段，凭据不落盘。`TestPlaneLiveWriteback` 新建一个 `baton-t27-` 工单，并在结束时删除该工单。

- 真实 POST 返回 201 后在本地丢弃响应，Baton 保留待回写；重试逐页查到原 `external_source=baton` 与回写 UUID，确认同一评论，没有增加第二条。
- 本地故障注入层对实际 Plane 连接短时返回 503。恢复后使用原 outbox 记录发送，任务和 execution 记录均保持 1 份。
- 取消、人工核实完成和员工验收分别回写；共有 4 条 UUID 不同的 INTERNAL 评论。完成评论明确“待员工验收”，验收评论单独包含员工 ID、时间和意见。测试中的验收操作由测试员工身份提交；不代表产品发布验收。
- 结构化证据在本机事务与接口测试中验证，评论只放本人任务 API 入口，不公开存储路径、资源名或工具输出。测试使用示例 Baton HTTPS Origin，未验证该外链在真实部署上的可达性。

本次通过真实 Plane API 验证评论契约，故障由本地注入，不停用共享 Plane 服务、不修改现有 Webhook、不运行真实模型。Coordinator 进程重启由独立进程测试覆盖。Plane 页面中的员工人工操作、真实模型执行及跨网络部署验收仍需对应环境验证。
