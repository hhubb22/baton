# Plane 协议契约说明

Status: 调查记录。文末方案已于 2026-10-18 批准，设计条款见 TECH「Plane 接入」。
Date: 2026-10-17
Basis: PRODUCT R-01、R-33、R-34、R-35、R-36；TECH「Plane 接入」与 Q4。

本文记录 Plane Community Edition `v1.4.2` 的 Webhook、工单查询、身份映射与评论回写契约，作为 `internal/plane` 本地协议测试与实现的依据。不记录任何口令、API token、Webhook 秘密、签名值或邮箱。

## 环境基线

`GET /api/instances/` 无需认证，返回 `instance.current_version` 为 `1.4.2`，`instance.latest_version` 为 `v1.4.2`，`instance.edition` 为 `PLANE_COMMUNITY`，`config.is_self_managed` 为 true，`config.enable_signup` 为 false。

| 对象 | 示例字段 |
|---|---|
| 工作区 slug | `baton` |
| 工作区 ID | `{workspace_id}`（由部署配置提供） |
| 项目 | Baton Test，identifier `BATON` |
| 项目 ID | `{project_id}`（由部署配置提供） |
| Webhook ID | `{webhook_id}`（由部署配置提供） |

适配器从部署配置读取以上标识，不硬编码环境 ID。

## 结论

1. Webhook 签名是对原始正文的 HMAC-SHA256，结果为 64 位十六进制。没有时间戳或重放窗口。
2. `X-Plane-Delivery` 是每次送出的 UUID，不是工单 ID，也不能单独代表业务动作。一次修改多个字段会产生多条事件，到达顺序不保证与 `data.updated_at` 一致。一次 HTTP 405 只留下一条 `retry_count` 为 0 的日志，没有第二次投递。
3. 社区版可以读到状态、标签、优先级和指派人。自定义属性端点不存在，未知 JSON 字段被忽略。当前工单事实以 `GET` 工单为准，不使用 Webhook 正文里的快照做门槛判断。
4. 现有 API token 代表管理员用户，没有单独的权限范围字段。普通成员能读写项目内工单，不能删除管理员创建的工单，也不能读取 Webhook。`activity.actor.id` 与邮箱能对应到实际操作者；工作区里未加入项目成员关系的账号不能映射成员工。
5. 创建评论和修改状态都有 API。评论和工单都能带 `external_source` 与 `external_id`。重复创建返回 409 和已有 ID。评论列表的同名查询参数不会过滤。
6. 项目 `network` 为 2，但没有公开锚点。未登录不能读工单。项目成员能看到工单名称、描述和 `INTERNAL` 评论。

## Webhook 来源验证

管理员会话 `GET /api/workspaces/baton/webhooks/{webhook_id}/` 返回的 Webhook 属于上述工作区。`project`、`issue`、`cycle`、`module`、`issue_comment` 都是布尔值且均为 true，不是项目 ID。`version` 为 `v1`，`is_internal` 为 false，`is_active` 为 true。同一响应包含 `secret_key`；适配器不得记录这个响应。`GET /api/v1/workspaces/baton/webhooks/` 为 404。普通成员请求 Webhook 和工作日志均为 403，正文 `error` 为 `You don't have the required permissions.`

来自 Plane 的请求头：

| 头 | 实测 |
|---|---|
| `Content-Type` | `application/json` |
| `User-Agent` | `Autopilot` |
| `X-Plane-Event` | `issue` 或 `issue_comment` |
| `X-Plane-Delivery` | 36 字符 UUID |
| `X-Plane-Signature` | 64 位十六进制 |

没有 `Date`、时间戳头，也没有把 `X-Plane-Delivery` 放进正文。代理附加的转发头不参与签名。

用配置的 Webhook 秘密对原始正文字节计算 HMAC-SHA256，与 `X-Plane-Signature` 一致。校验对象是 HTTP 原始正文，不是重新序列化的对象，也不是头部。

## 事件标识与投递

正文顶层固定为 `event`、`action`、`webhook_id`、`workspace_id`、`workspace_slug`、`data`、`activity`。`activity` 含 `field`、`old_value`、`new_value`、`actor`、`old_identifier`、`new_identifier`。

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

## 触发与审批字段

状态 `GET .../states/`：

| 名称 | 组 | 默认 | ID |
|---|---|---|---|
| Backlog | `backlog` | true | `{state_id}` |
| Todo | `unstarted` | false | `{state_id}` |
| In Progress | `started` | false | `{state_id}` |
| Done | `completed` | false | `{state_id}` |
| Cancelled | `cancelled` | false | `{state_id}` |

优先级支持 `none`、`low`、`medium`、`high`、`urgent`。

读取当前工单：
- `GET /api/v1/workspaces/baton/projects/{project_id}/issues/{id}/`
- 同时带 `external_id` 与 `external_source` 查询 `GET .../issues/` 时，返回这一张工单对象，不是分页列表。不存在时 404。

## 身份与权限

`GET /api/v1/workspaces/baton/members/`：

| 用户 ID | 显示名 | `role` | 说明 |
|---|---|---|---|
| `{admin_user_id}` | admin | 20 | 管理员，`is_bot` false |
| `{member_user_id}` | member | 15 | 普通成员，`is_bot` false |
| `{plane_bot_user_id}` | Plane | 20 | 机器人账号，不在项目成员关系中 |

Webhook `activity.actor` 是用户对象，含 `id`、`email`、`display_name`。评论正文 `data.actor` 只是用户 ID 字符串，不是对象。映射应使用 `activity.actor.id`，并用邮箱与成员目录核对。

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
