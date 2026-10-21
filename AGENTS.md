# Baton — Agent Guide

Baton 是跨设备 AI Agent 协同与任务派发系统，由中心服务（`coordinator`）、节点守护进程（`batond`）、本地会话执行器（Session Worker）、Project Agent Runtime（`runtimes/project-agent`）和嵌入式 Web UI（`web/`）组成。

## 核心架构与目录

| 目录 / 模块 | 职责 |
|---|---|
| `cmd/coordinator` | 中心控制面：员工认证、Project 与任务调度、内置 Gateway（`/v1/node` 与 `/api/v1/events`）、嵌入式 Web UI |
| `cmd/batond` | 节点守护进程：节点注册、出站 TLS WebSocket 连接、本地 SQLite 账本（`node.db`）、Session Worker 与 Project Runtime 管理 |
| `internal/session` | Session Worker 生命周期、本地认证 IPC 与幂等执行账本 |
| `internal/agent/{pi,codex,kiro,replay}` | 统一 `agent.Adapter` 接口实现（Pi RPC、Codex app-server、Kiro ACP V3）与确定性录制回放 |
| `runtimes/project-agent` | 基于 Node.js / TypeScript 的 Project Agent 进程（通过 stdio JSON-RPC 与 `batond` 通信） |
| `web` | React + TypeScript + Vite 前端，构建产物生成到 `internal/webui/dist` 后嵌入 Coordinator，不提交到 Git |
| `design` | Web UI 的 Elyx 设计稿（`.elyx`），前端按它实现；修改前先读 `design/AGENTS.md` |
| `specs/` | 持久产品规格（`PRODUCT.md`）与技术设计（`TECH.md`） |

## 常用构建与验证命令

- **构建与静态检查**（首次检出或修改前端后先构建；脚本安装前端依赖、生成静态文件，再编译 `coordinator`、`batond` 两个 Go 二进制到 `bin/`）：
  ```sh
  node tools/build.mjs
  go vet ./...
  ```
- **Go 单元与集成测试**（先完成上述构建；默认连接本机 `postgres://postgres:baton@127.0.0.1:5432/baton_test?sslmode=disable`，若未启动会自动尝试通过 `pg_ctl` 拉起 `~/.baton-postgres`，可通过 `BATON_TEST_DATABASE_URL` 覆盖）：
  ```sh
  go test ./...
  ```
- **Project Agent Runtime 测试**：
  ```sh
  pnpm --dir runtimes/project-agent test
  ```
- **Web 前端构建与测试**：
  ```sh
  pnpm --dir web lint
  pnpm --dir web typecheck
  pnpm --dir web test
  pnpm --dir web build
  ```

## 开发与演进约束（防熵增守则）

1. **零外部服务与云环境依赖**：全部开发与自动化测试均在本地闭环完成，不依赖云端开发环境（Devin / Cursor Cloud）、1Password CLI（`op`）或外部在线服务。
2. **禁止在生产代码中埋入测试环境变量钩子**：除 `BATON_TEST_DATABASE_URL` 外，不要在业务代码中新增 `os.Getenv("BATON_TEST_*")` 分支；故障注入应通过 Go 接口、依赖注入或测试替身完成。
3. **测试金字塔**：边界条件、错误分支、并发竞争与存储不变量优先使用包内单元测试或确定性回放验证，全栈多进程与浏览器 E2E 测试只覆盖核心主链路。
4. **文档只写当前状态，不写工单流水账**：更新 `README.md`、`PRODUCT.md`、`TECH.md` 时，直接原地修改对应章节以反映最新架构与行为，**严禁**追加「当前已实现 PS-xxx...」或「2026-xx-xx 修订」之类的工单历史段落。
