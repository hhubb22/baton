# 项目配置：Baton

## 任务管理

- 模式：issue
- 提供方：Linear MCP
- Team：Personal（PS）
- Project：Baton（P-PS-11），https://linear.app/kakenhe/project/baton-66c31f86dce5
- 任务权威来源：Linear Issue。首版任务 T01～T37 对应 PS-105～PS-141，标题保留 T 编号；阶段对应 Project milestone，任务依赖用 blocked by 关系记录。
- 当前任务进展同步：在用户已授权的当前任务内更新状态与证据
- 新建或批量变更工单：逐次授权

## 验证环境

- `go build ./...`、`go vet ./...`
- `go test ./...` 需要 `BATON_TEST_DATABASE_URL` 指向可创建临时 schema 的 PostgreSQL 17，不设置时测试失败。
- 本地隔离验证使用自建测试数据库、真实 Baton 进程与计数执行器，不动用户已有数据库或共享设备。
- 真实 Agent、macOS、Windows、Linux 虚拟机、Plane 测试项目和跨网络验证的环境条件写在对应 Issue 中；开发环境无法覆盖时用 `lab-request`。

## 长期文档位置

`specs/baton/PRODUCT.md`（行为规格）与 `specs/baton/TECH.md`（技术设计），与对应代码同一提交。

## 术语与约定

提交信息使用 `type(scope): 中文摘要`，例如 `feat(auth): 实现员工账号与安全登录会话`。
