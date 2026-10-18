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

工单默认派给 Devin 云端会话；需要本机资源的工作才在 Herdr 中起本地 Agent。

- 仓库 `https://github.com/hhubb22/baton`，起点 `main`，开 PR。云端环境由 `.devin/blueprint.yaml` 定义，Devin 中对应 blueprint `snapshot-blueprint-63b9d03b81a449748bda1858087c796a`；改动后用 `devin cloud drs blueprint-write` 同步，再 `devin cloud drs build`。
- 模型固定为 GPT（当前显示为 GPT-6.1 Sol (Preview)）。v3 API 创建会话时不能选这个模型，所以会话从 CLI 创建：在 Herdr 面板里运行 `devin --cloud`，用 `/model` 选 GPT、`/repo` 选 baton，需要 macOS 或 Windows 时用 `/platform` 选，然后提交提示词。
- 每个会话占一个 Herdr 面板，面板以工单编号命名（如 `ps114`）。会话结束前不要退出这个 CLI；退出后会话会停在 `waiting_for_user`，要用 `devin --cloud -r devin-<会话 ID>` 重新接上。会话结束后优先复用它的面板：在同一 CLI 里 `/clear` 开始新会话，重新选 GPT 和 baton，再把面板改名为新工单编号。
- 提示词由工单要求、当前 `origin/main` 的提交号和 `.agents/devin-cloud-brief.md` 组成。同时派发的工单如需新迁移，在派发时分配不同编号。
- 创建后在工单评论写会话链接和会话 ID，并把会话链接加为工单链接。
- 状态用 v3 API 的 `GET /v3/organizations/{org_id}/sessions/{id}` 查，看 `status`、`status_detail` 和 `pull_requests`。后续指令在该会话的 CLI 面板里发。
- 审查时把分支取到独立 worktree，变基到 `main` 后在本机复跑验证；需要修改时在同一会话的 CLI 里跟进。
- 审查通过后以 squash 方式合并 PR，提交信息符合下方约定，然后按「代码交付」写提交链接并关闭工单。PR 是 draft 时合并前先 `gh pr ready`；本地变基后推回 PR 分支用 `--force-with-lease`。

## 凭据

- 测试凭据放在 1Password 保险库 `Baton Test`，不写进仓库、工单、提示词或明文文件。
- 本机 Agent 用 Service Account `baton-local-agents`（读写），云端 Agent 用 `baton-cloud`（只读），令牌分别由 `~/.zshenv` 的非交互分支和 Devin Secret `OP_SERVICE_ACCOUNT_TOKEN` 提供。
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
