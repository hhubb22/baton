# 项目配置：Baton

## 任务管理

- 模式：issue
- 提供方：Linear MCP
- Team：Personal（PS）
- Project：Baton（P-PS-11），https://linear.app/kakenhe/project/baton-66c31f86dce5
- 任务权威来源：Linear Issue。首版任务 T01～T37 对应 PS-105～PS-141，标题保留 T 编号；阶段对应 Project milestone，任务依赖用 blocked by 关系记录。
- 当前任务进展同步：在用户已授权的当前任务内更新状态与证据
- 新建或批量变更工单：逐次授权

## 代码交付

- 每张工单审查通过后提交到 `main` 并推送 `origin/main`，然后继续下一张，不在工单之间停下询问。
- 工单评论写 GitHub 提交链接，置为 Done 前勾选已验证的验收项。
- 推送被拒绝时先 fetch 查看远端提交，不强推。

## 实施代理

工单默认派给 Cursor Cloud Agent，用 `cursor-cloud` skill 调度；需要本机资源的工作才在 Herdr 中起本地 Cursor。

- 仓库 `https://github.com/hhubb22/baton`，起点 `main`，开 PR。云端环境由 `.cursor/` 定义，环境 ID `49b419f4-ca28-11f1-bec7-b2318963e0b6`；改动 `.cursor/environment.json` 后用 `cursor-cloud env-sync` 同步。
- 模型固定为 `grok-4.7`，参数 `context=500k`、`reasoning_effort=xhigh`、`fast=true`，派发时显式传入，不用其他模型。
- 提示词由工单要求、当前 `origin/main` 的提交号和 `.agents/cursor-cloud-brief.md` 组成。同时派发的工单如需新迁移，在派发时分配不同编号。
- 创建前先生成 `agentId`，创建后在工单评论写 Agent 链接、`agentId` 和 `runId`，并把 Agent 链接加为工单链接。网络失败时用同一个 `agentId` 重试。
- 用后台的 `cursor-cloud wait` 等待完成。审查时把分支取到独立 worktree，变基到 `main` 后在本机复跑验证；需要修改时用 `followup` 发回同一个 Agent。
- 审查通过后以 squash 方式合并 PR，提交信息符合下方约定，然后按「代码交付」写提交链接并关闭工单。云端开的 PR 是 draft，合并前先 `gh pr ready`；本地变基后推回 PR 分支用 `--force-with-lease`。

## 凭据

- 测试凭据放在 1Password 保险库 `Baton Test`，不写进仓库、工单、提示词或明文文件。
- 本机 Agent 用 Service Account `baton-local-agents`（读写），云端 Agent 用 `baton-cloud`（只读），令牌分别由 `~/.zshenv` 的非交互分支和 Cursor 环境 Secret `OP_SERVICE_ACCOUNT_TOKEN` 提供。
- 派发时只引用 `op://Baton Test/...`。

## 验证环境

- `go build ./...`、`go vet ./...`
- `go test ./...` 需要 `BATON_TEST_DATABASE_URL` 指向可创建临时 schema 的 PostgreSQL 17，不设置时测试失败。
- 改动 `web/` 时在该目录运行 `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm test:e2e`，提交前运行 `pnpm check:dist`，确认嵌入的构建结果已更新。
- 本地隔离验证使用自建测试数据库、真实 Baton 进程与计数执行器，不动用户已有数据库或共享设备。
- 真实 Agent、macOS、Windows、Linux 虚拟机、Plane 测试项目和跨网络验证的环境条件写在对应 Issue 中；开发环境无法覆盖时用 `lab-request`。

## 长期文档位置

`specs/baton/PRODUCT.md`（行为规格）与 `specs/baton/TECH.md`（技术设计），与对应代码同一提交。

## 术语与约定

提交信息使用 `type(scope): 中文摘要`，例如 `feat(auth): 实现员工账号与安全登录会话`。
