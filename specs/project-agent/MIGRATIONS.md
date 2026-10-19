# Project Agent 数据库迁移

Status: approved
Owner: Asa
Date: 2026-10-19
Baseline: `hhubb22/baton@6da5ebef0d4d129fad4776de3dafd8b2e681f958`
Approval: 2026-10-18 用户确认；2026-10-19 用户确认输入队列表及消息入库前移到 0016
Basis: [TECH.md](TECH.md) 第 3 节；[Baton TECH](../baton/TECH.md)「中心数据」

## 编号

实施基线 `88e2f00` 已包含 `0015_equal_nodes.sql` 和 `0019_plane_writeback.sql`。0016、0017 留给 Project Agent，0018 留给 Inbox。迁移按未执行的文件逐个应用，可以在已应用 0019 的库上补入 0016。

| 文件 | 所属工作 | 内容 |
|---|---|---|
| `0015_equal_nodes.sql` | PA-W01（PS-153） | 去掉节点角色，默认 PC 改为默认设备，新增节点能力报告 |
| `0016_projects.sql` | PA-W03（PS-155） | Project、Project Agent、主对话、对话事件、项目记忆、输入队列及用户消息入库 |
| `0017_project_agent_runs.sql` | PA-W04（PS-156） | 运行记录、`tasks` 的来源列 |

已合并的迁移不修改。PA-W04 负责输入领取、被动通知、放置与租约，复用 0016 的输入队列表。

迁移只向前执行。Baton 只有一个活动的 Coordinator，升级时停止旧 Coordinator、执行迁移、启动新 Coordinator，不存在新旧 Coordinator 同时写库的阶段，所以不需要先扩展再收缩的两步迁移。batond 不访问数据库，旧版 batond 在升级期间不受迁移影响。

## 0015_equal_nodes.sql

```sql
DROP INDEX nodes_employee_pc_seq;
ALTER TABLE nodes DROP CONSTRAINT nodes_role_name;
ALTER TABLE nodes DROP COLUMN role;
CREATE INDEX nodes_employee_seq
    ON nodes (employee_id, registration_seq)
    WHERE revoked_at IS NULL;

ALTER TABLE employee_settings RENAME COLUMN default_pc_node_id TO default_device_node_id;

INSERT INTO employee_settings (employee_id, default_device_node_id, updated_at)
SELECT DISTINCT ON (employee_id) employee_id, id, now()
FROM nodes
WHERE revoked_at IS NULL
ORDER BY employee_id, registration_seq
ON CONFLICT (employee_id) DO UPDATE
SET default_device_node_id = EXCLUDED.default_device_node_id, updated_at = now()
WHERE employee_settings.default_device_node_id IS NULL;

CREATE TABLE node_runtime_reports (
    node_id uuid PRIMARY KEY,
    employee_id uuid NOT NULL,
    report_version bigint NOT NULL,
    reported_at timestamptz NOT NULL,
    report jsonb NOT NULL,
    CONSTRAINT node_runtime_reports_node_fk
        FOREIGN KEY (employee_id, node_id) REFERENCES nodes (employee_id, id),
    CONSTRAINT node_runtime_reports_version_positive CHECK (report_version > 0),
    CONSTRAINT node_runtime_reports_size CHECK (octet_length(report::text) <= 65536)
);
```

同一个 PR 里需要修改的代码：

- `internal/store/node.go` 的默认设备初选（第 175 行附近）去掉 `role = 'pc'` 条件，改为选最早注册的有效节点；`SetDefaultDevice` 允许选择任一本人有效节点。
- `internal/store/task.go` 的 `resolveDefaultPC` 改名为 `resolveDefaultDevice`，读取新列名。
- 节点注册接口（`internal/httpapi/nodes.go`）继续接受旧版 batond 发来的 `role` 字段，但不保存、不使用；节点列表和详情响应不返回 `role`。注册响应保留固定的 `role: "pc"`，兼容旧版 batond 的身份校验。
- 新增 `PUT /me/default-device`，`PUT /me/default-pc` 作为别名保留；响应里的 `default_pc` 字段同时以 `default_device` 返回，Web 改用新字段。
- `nodes.capabilities` 保留，执行 Agent 的支持判断照旧使用它。`node_runtime_reports` 只用于 Project Agent 的放置和 `devices.list`。

已有员工的默认 PC 原样成为默认设备，包括指向已吊销节点的失效引用。迁移仅为默认值为空或没有设置行的员工，按注册序号补选最早的有效节点；没有有效节点时保持未设置。重复执行迁移命令不重新计算默认值。

## 0016_projects.sql

| 表 | 关键约束 |
|---|---|
| `projects` | `UNIQUE (employee_id, id)`；`status IN ('active', 'paused', 'archived')`；`title` 1～200 字符且不含控制字符；没有任何节点或目录列 |
| `project_agents` | `UNIQUE (project_id)`，一个 Project 一个 Agent；外键 `(employee_id, project_id)`；`lease_epoch bigint NOT NULL DEFAULT 0`；`lease_run_id`、`lease_until` 同时为空或同时非空 |
| `conversations` | `UNIQUE (agent_id, kind)`，本期 `kind` 只允许 `primary`；`state IN ('active', 'needs_attention')`；`next_seq bigint NOT NULL` |
| `conversation_events` | 主键 `(conversation_id, seq)`；`UNIQUE (conversation_id, client_event_id)`；部分唯一索引 `(conversation_id, tool_call_id) WHERE kind = 'tool_result'`；`kind IN ('input', 'assistant', 'tool_result', 'compaction')`；`octet_length(payload::text) <= 163840` |
| `project_memory_entries` | 外键 `(employee_id, project_id)`；`current_revision > 0` |
| `project_memory_revisions` | 主键 `(entry_id, revision)`；`author IN ('agent', 'user')` |
| `project_agent_input_queue` | `UNIQUE (agent_id, source_key)`；`source_type IN ('user_message', 'task_result', 'attention_answer', 'memory_updated', 'project_updated')`；`payload_hash` 32 字节；`octet_length(payload::text) <= 73728`；索引 `(agent_id, id) WHERE delivered_seq IS NULL` |

`conversation_events` 和 `project_memory_revisions` 只允许插入。迁移为两张表各建一个 `BEFORE UPDATE OR DELETE` 触发器，直接抛错。这样即使应用代码出错，也不会改写原始事件。

新表使用包含 `employee_id` 的复合外键检查归属。`project_memory_entries` 的当前版本外键延迟到事务提交时检查，条目与修订必须一起提交。创建 Project 时标题必填，订阅和模型可以暂时为空，配置保存于其唯一 Agent。

用户消息的 `source_key` 为 `user:{client_message_id}`，payload 为 `{"content":"正文"}`，`payload_hash` 是正文 UTF-8 字节的 SHA-256。同一 Agent 的重复消息在唯一约束上等待，已提交后比较原正文；相同内容返回原记录，不同内容返回 409。正文最多 64 KiB，jsonb 规范文本最多 72 KiB；大量转义字符导致后者超限时同样返回 413。领取前 `delivered_seq` 为空，主对话不新增事件。

`history.search` 第一版对 `payload` 做 `ILIKE` 查询，按 `conversation_id` 过滤，不建全文索引；对话规模变大后再加。

## 0017_project_agent_runs.sql

| 表或列 | 关键约束 |
|---|---|
| `agent_runs` | 外键 `(employee_id, node_id)` 指向 `nodes`；`state IN ('starting', 'running', 'finished', 'lost', 'failed')`；`provider`、`model` 保存启动时的配置；`stop_acked_at` 记录节点停止回执；`UNIQUE (agent_id, lease_epoch)`，同一代次只有一次运行；索引 `(state) WHERE state = 'starting'`，供重发循环使用 |
| `tasks.project_id` | 可空；外键 `(employee_id, project_id)` |
| `tasks.origin_conversation_id`、`tasks.origin_tool_call_id` | 可空，两列同时为空或同时非空；部分唯一索引 `(origin_conversation_id, origin_tool_call_id) WHERE origin_conversation_id IS NOT NULL` |

`tasks.agent_type` 现有的约束是格式检查（`^[a-z][a-z0-9._-]{0,63}$`），`shell` 已经满足，不需要修改。

放置扫描的条件是「有待处理的主动输入（`user_message`、`task_result`）、租约为空或过期」。待处理输入的部分索引已经覆盖前半部分，`source_type` 在索引结果上过滤；Agent 数量在百级，租约条件直接在 `project_agents` 上过滤即可，不另建索引。

## 验证

每个迁移都在 PostgreSQL 17 上用三种库验证：空库、带有现有数据的库（包含指向已吊销节点的默认 PC），以及重复执行迁移命令（应当识别为已执行）。另外两项检查：

- 0015 之后，原来只有 Ubuntu 节点、因此没有默认 PC 的员工，会自动得到默认设备，也能手动改选；未指定目标的任务发往该设备。
- 0016 之后，对 `conversation_events` 和 `project_memory_revisions` 执行 `UPDATE` 或 `DELETE` 时失败；在已应用 0019 且含已有员工与吊销默认设备的库上补入 0016 后，旧数据保持不变。
