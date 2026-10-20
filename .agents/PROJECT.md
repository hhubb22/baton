# 项目配置：Baton

## 任务与工单管理（轻量化原则）

- **日常开发默认不走工单**：小修复、局部重构、补测试或单次会话可闭环的改动，直接在对话中确认并完成代码提交，**无需创建或查询 Linear Issue**。
- **仅跨会话大特性或待办 Bug 建卡**：
  - 提供方：Linear MCP（Team：`Personal` / `PS`，Project：`Baton`）
  - **粗粒度切片**：一个跨天大特性控制在 **3～5 张**垂直切片 Issue，严禁将建表、写内部函数、修测试拆成独立碎卡。
  - **极简工单正文（≤ 10 行）**：只写「一句话目标 + 关联 `specs/` 章节路径 + 3～4 条核心完成标准」，不把规格全文抄进工单。
  - **极简关单**：完成并合入后直接置为 Done，仅附一行最终 Commit SHA 或简短结论，不做逐项勾选 checkbox 或贴长篇终端日志的仪式。

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
