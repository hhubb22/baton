# PS-161 验证记录

初始验证基线：`badc7c8`。当前已 rebase 到 `42228d8`，保留 PS-184 提示词及 PS-162 的 nodes.exec、wait_tool，按合并后的提示词和工具定义重新生成请求快照。Runtime 32 项测试及类型检查通过。验证使用独立 PostgreSQL 17，测试自行创建并清理 schema。

## 验收对应证据

- 50% 收尾阈值与 80% 请求前阈值：在 `runtimes/project-agent` 运行 `pnpm test`。`compaction.test.ts` 覆盖两处触发、先清除后摘要、40% 停止条件、至少两轮与 15% 保留窗口、缓存 token 计入 usage，以及清除后与恢复后的 usage 扣减。子进程在压缩提交前后被杀，恢复后原文保持完整，每种情况只保存一次压缩。
- 摘要前缀：同一测试比较正常请求和摘要请求的完整消息前缀，检查 `toolChoice: "none"`、模型、系统消息中的工具定义和稳定会话 ID。重复摘要测试检查旧摘要进入下一次摘要范围。
- 程序范围说明与原文：`BATON_TEST_NODE_PROJECT_RUNTIME=1 go test -v -count=1 ./internal/gateway -run '^TestProjectCompactionRealProcesses$'` 通过。实际 Node Runtime、batond、Gateway、Coordinator 和 PostgreSQL 处理八轮约 400 KiB 的历史，每个工具输出约 30 KiB；压缩后用 `history.read` 和 `history.search` 找回原始工具结果。
- 每类工具结果的只读恢复：`go test -v -count=1 ./internal/store -run '^TestProjectCompaction'` 通过。`TestProjectCompactionEveryToolResultRecoverable` 清除当前 15 类工具的输出，再通过 `history.read` 按原序号和字节分页恢复完整 payload，与数据库原文逐项比较。nodes.exec 的二进制命令输出还通过 tasks.get 恢复，命令任务始终只有一条。写入类工具没有重放。另有测试检查摘要覆盖的原文、清除占位涉及的原文、范围回退、未来序号、重复序号、过近的工具结果和事件标识冲突。

以上 Go 命令需设置项目约定的 `BATON_TEST_DATABASE_URL`。`go build ./...` 和 `go vet ./...` 通过。

合并 PS-162 后的进程验证也通过，覆盖命令等待、退出码、二进制输出、取消、超时、Runtime 崩溃、Worker 崩溃和节点禁用：

```sh
BATON_TEST_NODE_PROJECT_RUNTIME=1 go test -v -count=1 ./internal/store ./internal/gateway -run '^TestProjectCompaction|^TestProjectExec|^TestLivingWorkerResultSurvivesMissingLedger$'
```

## 真实订阅缓存观察

在 `runtimes/project-agent` 中显式执行：

```sh
BATON_TEST_PROJECT_CACHE=1 pnpm exec tsx test/cache-live.ts
```

脚本使用 Runtime 的凭据存储接口和 Pi 的 `openai/gpt-6.1-sol` 订阅，复用生产代码的摘要请求构造。正常请求与摘要请求使用相同模型、提示词、工具定义、消息前缀和会话 ID；摘要追加指令并禁用工具。仅输出前缀 SHA-256 和 usage，要求 `summaryUsage.cacheRead > 0`。测试数据为脚本生成的对话；此命令不执行 Baton 工具。

真实订阅观察尚未运行：等待测试订阅的 1Password 引用或已登录 Runtime 订阅的使用说明。
