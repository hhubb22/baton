# PS-167 验收证据

日期：2026-10-20。基线：`d124e58`。环境：macOS、隔离 PostgreSQL 17、真实 Coordinator、batond、Worker 和 Project Runtime，模型由 `pi-ai` 的 faux provider 提供。

## 验收对应

1. 同一事项三处显示、处理与同步：`web/e2e/inbox.spec.ts` 创建三个事项，分别在 Inbox、Project 主对话和任务详情提交回答，观察其他打开的页面。浏览器 MutationObserver 记录实际显示时间，均要求不超过 5 秒；输入队列中只有三条回答，真实 Runtime 收到回答输入。计时见 [results.json](results.json)，截图见 [Inbox](inbox.png) 和 [主对话卡片](project-card.png)。
2. Markdown：`web/src/inbox.test.tsx` 检查表格、代码、加粗、斜体、列表及 HTTPS 链接，断言 HTML、图片、HTTP、相对路径和脚本链接没有可执行元素。E2E 同时检查 HTML 未执行、没有图片、HTTPS 链接在新窗口打开。
3. 系统事项：E2E 通过真实任务结果生成「任务需要核实」，断言只有关闭按钮和处理位置链接。人工核实任务后，它显示已解决并离开待处理栏。单元测试覆盖系统事项操作区与已解决状态。
4. 任务结果版本：E2E 人工修正任务，事项仍显示原结果和修正时间；切换到最新版本再切回，原结果保持不变。见 [事项与结果版本](attention-version.png)。
5. 引用与离线：E2E 预览已登记的 `root:proof` 文本，其他引用没有预览按钮；停止执行节点后无法预览，旧内容不再显示。完整 commit SHA 仍可显示、写入并读回浏览器剪贴板。单元测试还覆盖已打开预览随节点离线清除。见 [离线任务相关事项](task-offline.png)。
6. 引用预填：E2E 在真实 Markdown DOM 中选择 10 KiB，输入框收到 8 KiB 引用、原字节长度及来源；发送前消息数量不变，编辑后保存的内容与输入框完全一致。文件预览引用带节点、路径和行号。单元测试覆盖 UTF-8 多字节截断及文件行号。
7. 桌面布局与嵌入资源：E2E 在 1024 像素宽度检查 Inbox、事项、Project 和任务详情均无页面横向滚动。`internal/webui` 的深链接与第三方地址测试通过。

## 验证命令

在 `web/` 下运行：

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm check:dist
```

Web 单元测试 65 项、完整 E2E 6 项通过。截图与计时可用 `BATON_CAPTURE_INBOX_EVIDENCE=1 pnpm test:e2e --grep 'Inbox：'` 重新生成；它使用隔离测试数据库，数据库地址通过 `BATON_TEST_DATABASE_URL` 提供。

仓库根目录的 `go build ./...`、`go vet ./...` 以及 `go test ./internal/store ./internal/httpapi ./internal/inbox ./internal/webui` 通过。Runtime 的 `pnpm check` 通过。

## 只读接口补充

`GET /inbox` 接受可选的 `project_id`、`task_id` 和 `state=all`，保留员工归属限制、分页及全局 `open_count`。事项响应增加已有数据库字段 `origin_tool_call_id`，用于定位主对话中的创建位置。回答和关闭继续使用原接口。
