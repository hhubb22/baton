# Project Agent 数据库迁移

Status: draft
Owner: Asa
Date: 2026-10-18
Baseline: `hhubb22/baton@6da5ebef0d4d129fad4776de3dafd8b2e681f958`
Approval: 尚未批准
Basis: [TECH.md](TECH.md) 第 3 节；[Baton TECH](../baton/TECH.md)「中心数据」

## 编号

main 上已合并到 `0014_required_artifacts.sql`。活动 PR #21（Codex）和 #22（Pi）都没有新增迁移。本方案使用三个编号：

| 文件 | 所属工作 | 内容 |
|---|---|---|
| `0015_equal_nodes.sql` | PA-W01 | 去掉节点角色，默认 PC 改为默认设备，新增节点能力报告 |
| `0016_projects.sql` | PA-W03 | Project、Project Agent、主对话、对话事件、项目记忆 |
| `0017_project_agent_runs.sql` | PA-W04 | Inbox、运行记录、`tasks` 的来源列 |

派发 PA-W01 时一次登记 0015～0017。如果届时其他工作已经占用了其中的编号，三个编号整体顺延。已合并的迁移不修改。

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

- `internal/store/node.go` 的默认设备初选（第 175 行附近）去掉 `role = 'pc'` 条件，改为选最早注册的有效节点；`SetDefaultPC`（第 259 行附近）不再拒绝非 PC 节点。
- `internal/store/task.go` 的 `resolveDefaultPC` 改名为 `resolveDefaultDevice`，读取新列名。
- 节点注册接口（`internal/httpapi/nodes.go`）继续接受旧版 batond 发来的 `role` 字段，但不保存、不使用；节点列表响应不再返回 `role`。
- 新增 `PUT /me/default-device`，`PUT /me/default-pc` 作为别名保留；响应里的 `default_pc` 字段同时以 `default_device` 返回，Web 改用新字段。
- `nodes.capabilities` 保留，执行 Agent 的支持判断照旧使用它。`node_runtime_reports` 只用于 Project Agent 的放置和 `devices.list`。

已有员工的默认 PC 原样成为默认设备，包括指向已吊销节点的失效引用。迁移不重新计算默认值。

## 0016_projects.sql

| 表 | 关键约束 |
|---|---|
| `projects` | `UNIQUE (employee_id, id)`；`status IN ('active', 'paused', 'archived')`；`title` 1～200 字符且不含控制字符；没有任何节点或目录列 |
| `project_agents` | `UNIQUE (project_id)`，一个 Project 一个 Agent；外键 `(employee_id, project_id)`；`lease_epoch bigint NOT NULL DEFAULT 0`；`lease_run_id`、`lease_until` 同时为空或同时非空 |
| `conversations` | `UNIQUE (agent_id, kind)`，本期 `kind` 只允许 `primary`；`state IN ('active', 'needs_attention')`；`next_seq bigint NOT NULL` |
| `conversation_events` | 主键 `(conversation_id, seq)`；`UNIQUE (conversation_id, client_event_id)`；部分唯一索引 `(conversation_id, tool_call_id) WHERE kind = 'tool_result'`；`kind IN ('input', 'assistant', 'tool_result', 'compaction')`；`octet_length(payload::text) <= 196608` |
| `project_memory_entries` | 外键 `(employee_id, project_id)`；`current_revision > 0` |
| `project_memory_revisions` | 主键 `(entry_id, revision)`；`author IN ('agent', 'user')` |

`conversation_events` 和 `project_memory_revisions` 只允许插入。迁移为两张表各建一个 `BEFORE UPDATE OR DELETE` 触发器，直接抛错。这样即使应用代码出错，也不会改写原始事件。

`history.search` 第一版对 `payload` 做 `ILIKE` 查询，按 `conversation_id` 过滤，不建全文索引；对话规模变大后再加。

## 0017_project_agent_runs.sql

| 表或列 | 关键约束 |
|---|---|
| `agent_runs` | 外键 `(employee_id, node_id)` 指向 `nodes`；`state IN ('starting', 'running', 'finished', 'lost', 'failed')`；`UNIQUE (agent_id, lease_epoch)`，同一代次只有一次运行；索引 `(state) WHERE state = 'starting'`，供重发循环使用 |
| `agent_inbox` | `UNIQUE (agent_id, source_key)`；`source_type IN ('user_message', 'task_result')`；`payload_hash` 32 字节；索引 `(agent_id, id) WHERE delivered_seq IS NULL`，供领取和放置扫描使用 |
| `tasks.project_id` | 可空；外键 `(employee_id, project_id)` |
| `tasks.origin_conversation_id`、`tasks.origin_tool_call_id` | 可空，两列同时为空或同时非空；部分唯一索引 `(origin_conversation_id, origin_tool_call_id) WHERE origin_conversation_id IS NOT NULL` |

`tasks.agent_type` 现有的约束是格式检查（`^[a-z][a-z0-9._-]{0,63}$`），`shell` 已经满足，不需要修改。

放置扫描的条件是「有待处理 Inbox、租约为空或过期」。待处理 Inbox 的部分索引已经覆盖前半部分；Agent 数量在百级，租约条件直接在 `project_agents` 上过滤即可，不另建索引。

## 验证

每个迁移都在 PostgreSQL 17 上用三种库验证：空库、带有现有数据的库（包含指向已吊销节点的默认 PC），以及重复执行迁移命令（应当识别为已执行）。另外两项检查：

- 0015 之后，原来只有 Ubuntu 节点、因此没有默认 PC 的员工，会自动得到默认设备，也能手动改选；未指定目标的任务发往该设备。
- 0016 之后，对 `conversation_events` 执行 `UPDATE` 或 `DELETE` 时失败。
