# PS-184 验证记录

基线：`d124e58`。测试使用隔离的 PostgreSQL 17、真实 Coordinator、Gateway、batond、Session Worker 和 Project Runtime；模型通过 pi-ai faux provider 替代，无真实订阅请求。

| 验收 | 测试及观察 | 截图 |
|---|---|---|
| PA-A15 | `TestProjectUserTaskNotificationAndOwnership` 检查默认目标、Project 归属、请求幂等、跨员工拒绝、通知不启动运行、下一条用户消息领取结果。`project-control.spec.ts` 在指定设备实际执行并完成用户任务，期间运行数为 0；之后模型请求含该结果 | [用户派发来源](user-task.png) |
| PA-A16 | `TestProjectUserCancelRunningTaskCarriesActor` 检查运行中取消先待核实、停止回执后取消、重复回执只产生一次输入、操作含员工 ID 和 cancel。E2E 取消模型通过 `tasks.dispatch` 派出的运行中任务，检查节点停止时间及模型收到用户操作 | [取消状态](cancelled.png) |
| PA-A17 | `TestProjectPausedUserResolveAndRerunInputs` 检查暂停时派发、核实、新执行及幂等；新执行继承 Project 并记为用户来源。E2E 在暂停期间完成用户任务、人工核实另一任务并发消息，确认没有有效运行；恢复后 3 条输入分别仅出现在一个 input 事件中，模型收到核实结论 | [暂停时保存输入](paused.png) |
| Runtime 提示词及工具说明 | `user-control-worker.ts` 在真实 Runtime 发给模型的每次请求中断言：`expected_outputs` 写明验证方式，无法确定时说明原因；不撤销用户操作，除非用户在对话中要求；`tasks.dispatch` 说明提到验证方式 | 由 E2E 中的模型替身断言 |

验证命令：

- `go build ./...`、`go vet ./...`
- 配置隔离数据库后运行 `go test ./...`
- 在 `runtimes/project-agent` 运行 `pnpm test`；模型请求摘要按 `BATON_UPDATE_REQUEST_FIXTURE=1 pnpm test` 更新，再不设置更新变量重跑。
- 在 `web` 运行 `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm test:e2e` 和 `pnpm check:dist`。
- 定向重现：在 `web` 运行 `BATON_CAPTURE_PROJECT_CONTROL_EVIDENCE=1 pnpm exec playwright test e2e/project-control.spec.ts`；先配置隔离数据库并完成 Web 构建。

Web 单元测试还覆盖待确认任务跨 Project 补全时保留原 Project 和原请求标识，以及暂停页面只填写任务说明、可选验证方式和默认目标的提交。

本地结果：Go 全套测试、构建和 vet 通过；来源区分修正后，`internal/store`、`internal/control`、`internal/httpapi` 全部重跑通过。Runtime 18 条测试、Web 59 条单元测试及 6 条 E2E 均通过。`pnpm check:dist` 在提交前完成重建并报告待提交的产物差异，提交后再次执行确认产物一致。
