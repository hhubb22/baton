# PS-159 主对话界面验证

基线：`3193890`。验证环境：macOS arm64、PostgreSQL 17、Chromium 桌面浏览器。E2E 启动独立 schema、真实 Coordinator、两台 batond 和 Worker；Project Agent 使用实际 Pi Runtime 与 faux 模型，执行任务使用计数执行器。测试过程中只推进 Coordinator 的失败退避时间，三次失败均由 Runtime 实际上报。

## 工单验收

| 验收 | 自动验证 | 截图 |
| --- | --- | --- |
| 所有设备离线仍可发送消息，显示等待设备 | `web/e2e/projects.spec.ts`：发送响应丢失后刷新页面，查询原消息成功；队列只有一条用户消息，无运行实例；运行状态显示所有设备离线 | [离线等待](offline.png) |
| 显示等待原因与当前设备；停止不影响已派任务 | E2E 读取真实运行设备，点击停止后检查原运行 `end_reason=user_stopped`、节点退出回执；任务状态和版本保持不变，随后启动另一设备，任务完成 | [运行设备](running.png) |
| 需要处理时显示错误和重试，重试从原位置继续 | 三次模型失败后显示 `model_request_failed` 和重试按钮；点击后恢复工具调用与文本回复，初始输入事件完全相同，用户消息和派出任务各只有一条 | [错误与重试](needs-attention.png) |
| Project 列出本项目任务，点击进入任务详情 | 按 `project_id` 查询，列表标明来源；点击任务后 URL 为 `/tasks/{id}`，详情显示来源和结果摘要，刷新仍可查看 | [Project 任务](project-tasks.png) |

## 其他交付

- 主对话分页读取与临时流式片段：[流式预览](streaming.png)。Go 测试验证预览不进入历史、过期租约和过时序号被拒绝；Runtime 测试验证完整回复保存前的预览顺序。
- 项目记忆查看、新建、修改与版本冲突：[记忆修改](memory.png)。E2E 将模型写入的记忆更新为版本 2；Web 单元测试验证编辑过程中出现新版本仍使用打开时的版本，冲突保留草稿并禁止自动重提。
- Project 创建、订阅和模型设置、深链接与前进后退；查询失败隐藏过时运行状态，保留已读对话；异步旧响应不会混入其他 Project。
- 项目筛选和任务来源由后端读取真实字段；Go 测试验证跨员工隔离、消息分页、等待同步、缺少 Runtime、订阅需要登录及模型未配置。
- 模型回复、工具内容和流式片段均作为文本显示；Web 单元测试验证 HTML 文本不会形成可执行节点。

## 验证命令

在 `web/`：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm test:e2e`、`pnpm check:dist`。Web 单元测试 56 项，E2E 5 项。

在仓库根目录：`go build ./...`、`go vet ./...`、`go test ./... -count=1`。在 `runtimes/project-agent/`：`pnpm test`，13 项。

截图由 `BATON_CAPTURE_PROJECT_EVIDENCE=1 pnpm test:e2e` 生成。普通 E2E 将截图保存在测试输出目录，不修改仓库证据。截图仅包含运行状态、回复文本、任务摘要和记忆，不包含测试口令、令牌或机器目录。该测试覆盖模型替身流程；使用真实订阅的跨设备里程碑由 PS-160 验证。
