# Agent Inbox 技术设计

Status: approved
Owner: Asa
Date: 2026-10-19
Baseline: `hhubb22/baton@3193890`
Basis: [PRODUCT.md](PRODUCT.md) IB-01～IB-06、IB-11～IB-14、IB-17、IB-23～IB-27、IB-33～IB-35；[评审结论](../decisions/2026-10-19-daily-use-first.md)；[Project Agent TECH](../project-agent/TECH.md) 第 7 节

## Context

Coordinator 在 `call_tool` 事务里执行工具并保存唯一的 `tool_result`。用户处理 Project Agent 创建的事项后，结果进入已有输入队列，类型为 `attention_answer`。系统事项由确定的状态变化创建、解决和关闭，不产生输入。

本设计覆盖 PS-164 后端和 PS-167 页面。页面定时查询接口。OpenUI Lang、组件库、Runtime 解析与组件版本管理推迟到第一个版本之后。展示内容使用 Markdown，Coordinator 只检查 32 KiB 字节上限和链接的 `https` 协议。

## Proposed changes

### 1. 职责

`internal/inbox` 定义事项、参数校验及事项事务操作。`internal/store` 在已有工具、Project 和任务事务中调用它，并写入用户处理产生的输入。HTTP 接口沿用员工会话、Origin 和 CSRF 检查。Runtime 的固定工具集合增加四个 `inbox.*` 工具。

### 2. 数据模型

迁移 `0018_attention_requests.sql` 只新增 `attention_requests`。

主要字段：`id`、`employee_id`、`project_id`、`agent_id`、`conversation_id`、`origin_tool_call_id`、`source`、`condition_type`、`condition_object_id`、`task_id`、`task_result_version`、`task_result`、`title`、`summary`、`content`、`options`、`allow_text`、`action_url`、`state`、`version`、`resolution`、`resolved_at`、`withdraw_reason`、`created_at`、`updated_at`。

- `source` 为 `agent` 或 `system`。Agent 事项的 `(conversation_id, origin_tool_call_id)` 唯一。
- `state` 为 `open`、`answered`、`closed`、`withdrawn` 或 `resolved`；每次状态变化使 `version` 加一。
- 系统条件只有 `project_needs_attention` 和 `task_needs_verification`；对象分别为 Project ID 和任务 ID。一个对象同一条件最多一个 `open` 事项。系统事项没有选项、文字回复和工具来源，`action_url` 指向所属 Project 或任务。
- 所有归属引用使用复合外键。任务引用还检查任务属于本 Project。
- 关联任务时，在创建事务内锁定任务，保存当时的任务结果快照和 `task_result_version`。读取时保留快照，另返回 `latest_task_result_version` 和最新结果修改时间。快照包含状态、summary、error、evidence、artifacts；既有任务结果的结构继续使用。这里的版本沿用 `tasks.version`。
- Inbox 索引为 `(employee_id, created_at DESC, id DESC)`；Project 查询索引为 `(project_id, state)`。

### 3. Project Agent 工具

沿用 `call_tool` 的租约校验、已保存 assistant 校验、保存点和唯一结果。同一调用重发直接返回已有 `tool_result`。权限取自运行记录。

`inbox.ask` 参数为 `title`、`summary`、`content`、`options`、`allow_text` 和可选 `task_id`。标题 1～120 字符，摘要最多 280 字符；0～5 个选项，ID 符合 `^[a-z][a-z0-9_-]{0,31}$` 且唯一，标签 1～40 字符，可附说明，最多一个建议选项；没有选项时必须允许文字回复。Markdown 不超过 32 KiB，链接目标必须是有效 `https` URL。检查失败写 `is_error`，不创建事项。Markdown 的 HTML 和图片不由界面渲染，本单不引入组件或 HTML 检查。

Agent 行锁串行化同 Project 的创建；只统计 `source=agent AND state=open`，达到 10 个时拒绝。系统事项不计入。关联任务不属于本 Project 时拒绝。返回 `request_id`、状态、版本和 `read_tool`。

`inbox.list` 读取本 Project 的事项摘要，按稳定 ID 分页，每页 20 条；`inbox.get` 返回完整事项及原任务结果和最新版本。两个只读工具复用现有 JSON 字节分页（`offset`、`max_bytes`），保证 `tool_result` 不超过 32 KiB。

`inbox.withdraw` 接受 `request_id` 和 1～200 字符的 `reason`。只允许撤回本 Project 的 Agent 事项。锁事项，`open` 改为 `withdrawn`；已经处理则返回当前状态和处理结果。撤回不产生输入。

锁顺序：`project_agents` → `conversations` → 关联的 `tasks`（创建时）→ `attention_requests`。撤回只取最后的事项锁。

### 4. 用户处理与系统条件

接口均位于 `/api/v1`：

| 接口 | 内容 |
|---|---|
| `GET /inbox?state=open\|done\|all&cursor=&project_id=&task_id=` | 本人的事项，创建时间倒序，附 `open_count` 和下一页 cursor |
| `GET /attention-requests/{id}` | 完整事项、处理结果、原任务结果和最新版本 |
| `POST /attention-requests/{id}/answer` | `expected_version`、`client_request_id`、可选 `option_id`、`text` |
| `POST /attention-requests/{id}/close` | `expected_version`、`client_request_id` |

处理事务只锁事项，确认员工归属，先检查已保存的 `client_request_id`：同一请求返回 200；其他请求面对非 open 状态或版本不一致返回 409 和当前事项。回答检查选项属于声明集合，文字最多 4 KiB；无选项回复要求 `allow_text` 且文字非空。系统事项只允许关闭。

成功处理保存状态、选项 ID 和标签、文字、员工 ID、时间、`client_request_id`，增加版本。Agent 事项随后在同一事务插入唯一 `attention_answer`，`source_key=attention:{id}:resolution`，包含事项 ID、标题、状态和回答。该来源的 JSON 上限为 32 KiB，以保存 4 KiB 回复转义后的内容。系统事项关闭直接提交。锁顺序是 `attention_requests` → `project_agent_input_queue`，不取 Agent 或任务锁，避免与工具路径形成环。

离线不影响处理。Project 暂停时输入照常保存，已有放置逻辑只为 active Project 启动运行，恢复后处理。归档事务先锁 Agent，撤回该 Project 所有 open 事项，原因为「Project 已归档」，再结束运行。

**Project 需要处理。** 模型失败达到重试上限，把主对话改为 `needs_attention` 的同一事务创建系统事项。确认重试把主对话恢复 active 的同一事务，将仍 open 的对应事项改为 `resolved`。沿用 Agent → conversation → attention_request 锁顺序。

**任务待核实。** 任务从其他状态进入 `needs_verification` 的事务创建系统事项；离开该状态的事务将仍 open 的对应事项改为 `resolved`。每次只按本次任务状态变化处理，不扫描或重新计算规则。创建时先取得所属 Project 的共享行锁，与归档串行；锁顺序为 tasks → projects → attention_request；系统事项创建不取 Agent 行锁，不写队列。

用户关闭系统事项后，条件仍在时不会重新创建：只有从其他状态进入条件才创建。条件消失后再次进入时，生成新事项。归档 Project 不再创建新系统事项。创建、解决与触发状态变化一起回滚或提交。

### 5. Web 页面

`/inbox` 的待处理、已处理两栏使用紧凑事项卡片，展示内容可展开；`/inbox/{id}`、Project 主对话和任务详情复用完整卡片。`internal/webui` 为这些前缀返回 `index.html`。Inbox 入口和标签页标题显示待处理数量。

事项卡片使用 `react-markdown` 和 `remark-gfm` 渲染 Markdown，启用 `skipHtml`，禁用图片，链接只保留有效的 `https` URL，并在新窗口打开。固定回答区始终独立于展示内容。回答和关闭使用已有版本与请求标识；冲突后查询当前记录，响应丢失后由用户查询处理结果，不自动重发。

`GET /inbox` 支持可选的 `project_id`、`task_id` 筛选和 `state=all`，仍只读取当前员工的事项。返回的 `origin_tool_call_id` 用于在对应的 `inbox.ask` 工具调用位置显示卡片。Inbox 两栏按事项 ID 合并查询结果，保留版本较新的记录后再按状态分栏，避免异步查询短暂重复显示同一事项。页面读取并保留分页，Inbox 数量、已展开的列表、相关事项及当前事项每 5 秒查询一次；主对话原有的 2 秒查询保持不变。

事项中的任务结果默认使用保存的快照，有新版本时显示更新时间，可以读取任务详情切换查看，再返回原快照。文件预览复用已有 `root:` 接口；节点状态变为离线时清除已显示的文件内容。代码产物显示仓库和完整 SHA，并提供复制。

选中文字后，固定的「问 Project Agent」按钮将文字和任务、字段、事项来源预填到主对话输入框，文件来源还包括节点、路径和行号。引用按 UTF-8 截至 8 KiB，超限注明原始字节长度。草稿仅保存在当前页面内存中，用户编辑并提交后才写入普通消息接口。

## Testing and validation

| 验收 | 证据 |
|---|---|
| 工具重发、10 个上限、系统事项不计数、跨 Project 归属 | PostgreSQL 集成测试及模型替身进程测试 |
| 两连接回答、请求重试、409 当前事项 | PostgreSQL/HTTP 集成测试 |
| 回答与撤回并发 100 轮，无撤回输入 | PostgreSQL 集成测试 |
| 离线、暂停回答，恢复后处理 | PostgreSQL 集成测试，恢复后领取输入 |
| 归档撤回 3 个事项 | PostgreSQL 集成测试 |
| Markdown 32 KiB 与 https 链接 | 校验单元测试及 call_tool 进程测试 |
| 重试上限事项、确认重试解决，无系统输入 | 模型替身进程测试 |
| 待核实、关闭不重建、条件重入 | PostgreSQL 集成测试 |
| 人工修正保留原结果，返回最新版本 | PostgreSQL 集成测试 |
