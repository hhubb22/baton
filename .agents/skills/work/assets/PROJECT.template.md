# 项目配置：<项目名>

保存在仓库 `.agents/PROJECT.md` 并纳入版本管理；仅保留与当前项目实际相关的配置项。

## 任务管理

- 模式：<local 或 issue；默认 local>
- 提供方：<issue 模式填写，如 Linear MCP>
- Team：<Team 名称或 ID>
- Project：<Project 名称或 ID>
- 当前任务进展同步：在用户已授权的当前任务内更新状态与证据
- 新建或批量变更工单：逐次由用户授权

## 本地开发与验证环境

- 构建与静态检查命令：<如 `go build ./...`、`go vet ./...`>
- 单元与集成测试命令：<如 `go test ./...`，需支持本地零配置运行>

## 长期文档位置

- 根级说明：`AGENTS.md`、`README.md`
- 规格与设计：`specs/<特性>/PRODUCT.md`（行为规格）与 `specs/<特性>/TECH.md`（技术设计）

## 提交约定

- 提交格式：<如 `type(scope): 中文摘要`>
