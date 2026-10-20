# Linear MCP 轻量操作约定

优先使用宿主已连接的 Linear MCP 工具。

## 常用工具速查

| 动作 | Linear MCP 工具 | 要点 |
|---|---|---|
| 定位 Project / Team | `list_projects`、`list_teams` | 按 `.agents/PROJECT.md` 确认目标归属 |
| 查询待办或单个工单 | `list_issues`、`get_issue` | 按需读取描述与 `blockedBy` 关系 |
| 创建或更新工单 | `save_issue` | 更新时必传 `id`；正文保持 ≤ 10 行（目标 + `specs/` 链接 + 3～4 条完成标准） |
| 留存结项记录 | `save_comment` | 仅在关单或重要节点留 1～3 行简短结论（如 Commit SHA 与核心验证结果） |

## 极简工单模板（创建时参考）

```markdown
<1～2 句话说明要解决的问题与交付结果，设计详见 `specs/<feature>/TECH.md`>

Done when:
- <核心可观察结果 1>
- <核心可观察结果 2>
- <核心验证通过（如 `go test ./...`）>
```

## 极简结项评论模板（完成时参考）

```markdown
已完成并合入 `main`（`<commit-sha>`），`<验证命令>` 通过。
```
