# Agent Inbox 技术设计

Status: approved
Owner: Asa
Basis: [PRODUCT.md](PRODUCT.md) IB-01～IB-20；[Project Agent TECH](../project-agent/TECH.md) 第 7 节；[Baton TECH](../baton/TECH.md)。

## Context

Coordinator 在 `call_tool` 事务里执行工具并保存唯一的 `tool_result`。用户处理 Project Agent 创建的事项后，结果进入输入队列，类型为 `attention_answer`。系统事项由主对话状态变化创建和解决，不产生输入。展示内容是 Markdown，Coordinator 只检查 32 KiB 字节上限和链接的 `https` 协议。

## Proposed changes

### 1. 职责

`internal/inbox` 定义事项、参数校验及事项事务操作。`internal/store` 在工具和 Project 事务中调用它，并写入用户处理产生的输入。HTTP 接口沿用员工会话、Origin 和 CSRF 检查。Runtime 的固定工具集合包含四个 `inbox.*` 工具。

### 2. 数据模型

迁移 `0018_attention_requests.sql` 新增 `attention_requests`：`id`、`employee_id`、`project_id`、`agent_id`、`conversation_id`、`origin_tool_call_id`、`source`、`thread_id`、`title`、`content`、`options`、`allow_text`、`state`、`version`、`resolution`、`resolved_at`、`withdraw_reason`、`created_at`、`updated_at`。

- `source` 为 `agent` 或 `system`。Agent 事项的 `(conversation_id, origin_tool_call_id)` 唯一。
- `state` 为 `open`、`answered`、`closed`、`withdrawn` 或 `resolved`；每次状态变化使 `version` 加一。
- 系统事项只有一种：主对话进入 `needs_attention`。同一 Project 最多一个 `open` 的系统事项，由部分唯一索引 `(project_id) WHERE source='system' AND state='open'` 保证。系统事项没有选项、文字回复和工具来源。
- `thread_id` 可空，引用同一员工的 Thread，并检查 Thread 属于本 Project。事项不保存 Thread 内容的快照，界面打开关联 Thread 查看当前内容。
- 所有归属引用使用复合外键。
- Inbox 索引为 `(employee_id, created_at DESC, id DESC)`；Project 查询索引为 `(project_id, state)`；Thread 查询索引为 `(thread_id) WHERE thread_id IS NOT NULL`。

### 3. Project Agent 工具

沿用 `call_tool` 的租约校验、已保存 assistant 校验和唯一结果。同一调用重发直接返回已有 `tool_result`。权限取自运行记录。

`inbox.ask` 参数为 `title`、`content`、`options`、`allow_text` 和可选 `thread_id`。标题 1～120 字符；0～5 个选项，ID 符合 `^[a-z][a-z0-9_-]{0,31}$` 且唯一，标签 1～40 字符，最多一个建议选项；没有选项时必须允许文字回复。Markdown 不超过 32 KiB，链接目标必须是有效 `https` URL。检查失败写 `is_error`，不创建事项。

Agent 行锁串行化同 Project 的创建；只统计 `source=agent AND state=open`，达到 10 个时拒绝。关联 Thread 不属于本 Project 时拒绝。返回 `request_id`、状态、版本和 `read_tool`。

`inbox.list` 读取本 Project 的事项摘要，按稳定 ID 分页，每页 20 条；`inbox.get` 返回完整事项和处理结果。两个只读工具复用 JSON 字节分页（`offset`、`max_bytes`），保证 `tool_result` 不超过 32 KiB。

`inbox.withdraw` 接受 `request_id` 和 1～200 字符的 `reason`，只允许撤回本 Project 的 Agent 事项。锁事项，`open` 改为 `withdrawn`；已经处理则返回当前状态和处理结果。撤回不产生输入。

锁顺序：`project_agents` → `conversations` → `attention_requests`。关联 Thread 只读校验归属，不加锁。

### 4. 用户处理与系统事项

接口位于 `/api/v1`：

| 接口 | 内容 |
|---|---|
| `GET /inbox?state=open\|done\|all&cursor=&project_id=&thread_id=` | 本人的事项，创建时间倒序，附 `open_count` 和下一页 cursor |
| `GET /attention-requests/{id}` | 完整事项和处理结果 |
| `POST /attention-requests/{id}/answer` | `expected_version`、`client_request_id`、可选 `option_id`、`text` |
| `POST /attention-requests/{id}/close` | `expected_version`、`client_request_id` |

处理事务只锁事项，确认员工归属，先检查已保存的 `client_request_id`：同一请求返回 200；其他请求面对非 open 状态或版本不一致返回 409 和当前事项（IB-12、IB-15）。回答检查选项属于声明集合，文字最多 4 KiB；无选项回复要求 `allow_text` 且文字非空。系统事项只允许关闭。

成功处理保存状态、选项 ID 和标签、文字、员工 ID、时间、`client_request_id`，增加版本。Agent 事项在同一事务插入唯一 `attention_answer`，`source_key=attention:{id}:resolution`，包含事项 ID、标题、状态和回答，JSON 上限 32 KiB。锁顺序是 `attention_requests` → `project_agent_input_queue`。

离线和暂停不影响处理（IB-11）。归档事务先锁 Agent，撤回该 Project 所有 open 事项，原因为「Project 已归档」，再结束运行（IB-16）。

**系统事项。** 模型失败达到重试上限、把主对话改为 `needs_attention` 的同一事务创建系统事项；确认重试把主对话恢复 active 的同一事务，将仍 open 的系统事项改为 `resolved`（IB-18、IB-19）。锁顺序为 Agent → conversation → attention_request。用户关闭后条件仍在时不重新创建，只有主对话再次从 active 进入 `needs_attention` 才创建新事项。

### 5. Web 页面

`/inbox` 列出待处理和已处理事项，`/inbox/{id}`、主对话里 `inbox.ask` 的位置和关联 Thread 里显示同一张事项卡片（IB-08）。卡片只用于等用户决定的事项，按 `design/` 实现。

Markdown 使用 `react-markdown` 和 `remark-gfm` 渲染，启用 `skipHtml`，禁用图片，链接只保留有效的 `https` URL 并在新窗口打开（IB-07）。回答和关闭携带版本与请求标识；冲突后读取当前记录，响应丢失后由用户查询处理结果，不自动重发。Inbox 数量、已展开的列表和当前事项每 5 秒查询一次。

选中文字后的「问 Project Agent」把文字和来源（Thread ID 与回复位置、文件的设备路径行号、事项 ID）预填到主对话输入框（IB-13）。引用按 UTF-8 截至 8 KiB，超限注明原始字节长度。草稿只在当前页面内存中，用户提交后才写入普通消息接口。

## Testing and validation

| 需求 | 设置与观察 | 失败条件 | 位置 |
|---|---|---|---|
| IB-01～IB-04 | 工具重发、10 个上限、系统事项不计数、关联其他 Project 的 Thread | 出现第二个事项；超限仍创建；跨 Project 关联成功 | PostgreSQL 集成、模型替身进程测试 |
| IB-07 | Markdown 超过 32 KiB；含 `http` 链接 | 创建了事项 | 单元测试、`call_tool` 进程测试 |
| IB-10～IB-12 | 两连接同时回答；同一请求重试 | 两次处理都生效；输入队列多于一条；重试返回 409 | PostgreSQL / HTTP 集成 |
| IB-11 | 离线、暂停时回答，之后恢复 | 处理失败；恢复后 Project Agent 没有收到 | PostgreSQL 集成 |
| IB-14、IB-15 | 回答与撤回并发 100 轮 | 两者都生效；撤回产生输入 | PostgreSQL 集成 |
| IB-16 | 归档有 3 个 open 事项的 Project | 有事项仍为 open | PostgreSQL 集成 |
| IB-18～IB-20 | 模型替身持续失败直到重试上限，用户关闭后再重试 | 没有系统事项；关闭后条件仍在时重新创建；输入队列出现系统事项 | 模型替身进程测试 |
| IB-08 | 主对话、Inbox、Thread 三处同时打开，在其中一处回答 | 其他两处 5 秒内未显示新状态 | Web 测试 |
| IB-09 | 1024 像素宽窗口打开 Inbox 和事项 | 出现横向滚动 | Web 测试 |
