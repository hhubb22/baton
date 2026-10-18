# 云端实施约束

这段附在每个派给 Devin 云端会话的 Baton 工单后面。工单本身的范围、验收和迁移编号写在前面。

## 环境

- 仓库在 `~/repos/baton`。开始前运行 `git fetch origin`，确认工作分支包含工单给出的基线提交；落后于 `origin/main` 时先快进或变基到 `origin/main`，再开始改动。
- 环境变量在 `/etc/profile.d/baton.sh`。`go`、`BATON_TEST_DATABASE_URL` 不可用时先执行 `. /etc/profile.d/baton.sh`。
- 会话开始时测试数据库没有运行，先执行 `bash .cursor/start.sh`，重复执行无副作用。
- 不要连接工单没有要求的数据库或外部服务。
- 工单需要的测试凭据在 1Password 保险库 `Baton Test`，用 `op read "op://Baton Test/<条目>/<字段>"` 或 `op run` 读取（`OP_SERVICE_ACCOUNT_TOKEN` 由 Devin Secret 提供，只读）。不要把凭据的值写进文件、日志、测试数据、提交或回复。

## 实现

- 先读 `specs/baton/PRODUCT.md` 与 `specs/baton/TECH.md` 中工单列出的条目，再读相关代码，按现有风格实现。
- 优先使用维护活跃的成熟库，不手写 syscall、协议或通用算法。
- 新迁移文件只使用工单中分配的编号；不要修改已有迁移，除非工单明确要求。
- 同步更新 README 和 `specs/baton/TECH.md` 开头的「当前已实现」。实现与 TECH 不一致的地方写进最终回复，不要改设计条款。
- 不要修改 Linear，不要合并 PR。

## 验证

完成前以下命令全部通过：

```text
go build ./...
GOOS=windows go build ./...
GOOS=darwin go build ./...
go vet ./...
go test -count=1 ./...
```

并发相关的包再跑 `go test -race`。合并前会在 macOS 上复跑，时序和 Linux 不同：进程测试里，节点日志、门闩文件或 batond 重启之后不要立即读取中心记录或调用 CLI，要等待对应的中心事实（字段非空、状态变化、新进程的 `event=synced`）。新增的进程测试至少用 `-count=10` 跑一遍。改动 `web/` 时，在 `web/` 下运行 `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm test:e2e` 和 `pnpm check:dist`，并提交更新后的 `internal/webui/dist`。Windows、macOS 只能交叉编译的部分，在回复里列出。

## 提交

- 提交信息使用 `type(scope): 中文摘要`，正文说明改了什么，最后一行写 `Refs: <工单编号>`。
- 推送到你的工作分支并开 PR。

## 最终回复

用中文简短写：改动文件、实现要点、新增依赖、实际运行的测试命令和结果、与设计的偏离、需要决定的问题。
