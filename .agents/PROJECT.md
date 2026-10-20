# 项目配置：Baton

## 任务管理

- 模式：issue
- 提供方：Linear MCP
- Team：Personal（PS）
- Project：Baton（P-PS-11），https://linear.app/kakenhe/project/baton-66c31f86dce5
- 任务权威来源：Linear Issue。
- 当前任务进展同步：在用户已授权的当前任务内更新状态与证据。
- 新建或批量变更工单：逐次由用户授权。

## 本地开发与验证环境

- 所有开发与验证均在本地环境完成，不使用云端开发环境或外部密码管理器依赖。
- Go 验证：`go build ./...`、`go vet ./...`、`go test ./...`（默认使用本地 PostgreSQL 17 测试库 `postgres://postgres:baton@127.0.0.1:5432/baton_test?sslmode=disable`，也可通过 `BATON_TEST_DATABASE_URL` 覆盖）。
- Project Agent Runtime 验证：在 `runtimes/project-agent/` 运行 `pnpm test`。
- Web 验证：改动 `web/` 时在该目录运行 `pnpm lint`、`pnpm typecheck`、`pnpm test:unit`、`pnpm test:e2e`，提交前运行 `pnpm check:dist` 确认嵌入的构建产物已同步。

## 长期文档位置

- 根级说明：`AGENTS.md`、`README.md`
- 规格与设计：`specs/*/PRODUCT.md`（行为规格）与 `specs/*/TECH.md`（技术设计）
- 维护原则：文档只反映当前系统状态，原地修改对应章节，不追加按工单编号排列的实现流水账。

## 提交约定

提交信息使用 `type(scope): 中文摘要`，例如 `feat(auth): 实现员工账号与安全登录会话`。
