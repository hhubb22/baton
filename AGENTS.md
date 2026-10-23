# Baton — Agent Guide

Baton 是跨设备 AI Agent 协同系统，由中心服务（`baton-server`）、节点守护进程（`batond`）、本地会话执行器（Session Worker）、Project Agent Runtime（`runtimes/project-agent`）和嵌入式 Web UI（`web/`）组成。

## 核心架构与目录

| 目录 / 模块 | 职责 |
|---|---|
| `cmd/baton-server` | 中心控制面：员工认证、Project 与 Thread 调度、内置 Gateway（`/v1/node` 与 `/api/v1/events`）、嵌入式 Web UI |
| `cmd/batond` | 节点守护进程：节点注册、出站 TLS WebSocket 连接、本地 SQLite 账本（`node.db`）、Session Worker 与 Project Runtime 管理 |
| `internal/session` | Session Worker 生命周期、本地认证 IPC、Thread 消息队列与 Turn 账本 |
| `internal/agent/{pi,codex,kiro,shell,replay}` | 统一 `agent.Adapter` 接口实现（Pi RPC、Codex app-server、Kiro ACP V3）与确定性录制回放 |
| `runtimes/project-agent` | 基于 Node.js / TypeScript 的 Project Agent 进程（通过 stdio JSON-RPC 与 `batond` 通信） |
| `web` | React + TypeScript + Vite 前端，构建产物生成到 `internal/webui/dist` 后嵌入 Coordinator，不提交到 Git；界面文案遵循 `design/WRITING.md` |
| `design` | Web UI 的 Elyx 设计稿（`.elyx`）与界面文案规范（`design/WRITING.md`），前端按它实现；修改前先读 `design/AGENTS.md` |
| `specs/` | 持久产品规格（`PRODUCT.md`）与技术设计（`TECH.md`） |

## 常用构建与验证命令

- **构建与静态检查**（首次检出或修改前端后先构建；脚本安装前端和 Runtime 依赖、生成静态文件，编译 `baton-server`、`batond` 到 `bin/`，并打包 Project Runtime 到 `bin/sidecars/project-agent/`）：
  ```sh
  node --test tools/*.test.mjs
  node tools/build.mjs
  node tools/check-sidecar-package.mjs
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
  pnpm --dir web format:check
  pnpm --dir web lint
  pnpm --dir web typecheck
  pnpm --dir web test
  pnpm --dir web build
  ```

## 部署与设备接入

- `baton-server serve` 自动执行数据库迁移，再检查迁移状态；签名密钥默认使用工作目录下的 `node-signing.key`，不存在时生成 `0600` 文件，也可用 `BATON_NODE_SIGNING_KEY` 指定。已有密钥的权限、类型和内容仍须通过校验。
- `Dockerfile` 构建内嵌 Web UI 的服务端镜像，使用非 root 用户运行。`compose.yaml` 编排 PostgreSQL 16 与 `baton-server`，数据库及 `/var/lib/baton` 分别持久化；需配置 `BATON_POSTGRES_PASSWORD` 和 `BATON_ALLOWED_ORIGINS`，默认通过本机端口交给 HTTPS 反向代理。
- `BATON_ENROLLMENT_TOKEN='...' ./bin/batond up --coordinator https://baton.example` 首次注册并运行，已有身份时直接复用；注册凭据也可来自 `--enrollment-file`。显示名默认主机名，系统自动推导。首次启动且尚无 `browse-roots.json` 时默认开放当前用户主目录，已有配置（含空列表）保留；可选 `--workspace /绝对路径` 在连接前幂等登记指定目录。
- 网页 Devices 的在线设备详情支持添加、移除允许访问的目录，并以设备码登录 ChatGPT / xAI 订阅；选目录弹窗也可直接输入设备路径并添加。凭据保存在设备本地，登录进程退出后立即刷新订阅报告。
- `batond register --coordinator https://主机` 将中心地址保存为身份文件的 `coordinator_url`；`batond run` 据此推导 WSS 地址，`--relay` 可显式指定。身份文件不含中心地址时需要 `--relay`。各命令使用相同的 `--data-dir`。

## 开发与演进约束（防熵增守则）

1. **零外部服务与云环境依赖**：全部开发与自动化测试均在本地闭环完成，不依赖云端开发环境（Devin / Cursor Cloud）、1Password CLI（`op`）或外部在线服务。
2. **禁止在生产代码中埋入测试环境变量钩子**：除 `BATON_TEST_DATABASE_URL` 外，不要在业务代码中新增 `os.Getenv("BATON_TEST_*")` 分支；故障注入应通过 Go 接口、依赖注入或测试替身完成。
3. **测试金字塔**：边界条件、错误分支、并发竞争与存储不变量优先使用包内单元测试或确定性回放验证，全栈多进程与浏览器 E2E 测试只覆盖核心主链路。
4. **文档只写当前状态，不写工单流水账**：更新 `README.md`、`PRODUCT.md`、`TECH.md` 时，直接原地修改对应章节以反映最新架构与行为，**严禁**追加「当前已实现 PS-xxx...」或「2026-xx-xx 修订」之类的工单历史段落。
5. **实验室阶段统一当前结构**：产品正式发布并确定版本号前，不维护旧开发版本的数据库、设备账本、结果格式或摘要兼容分支；结构变化可重建本地数据。保留协议版本、未知字段容忍和可选能力声明等扩展机制，正式发布后再为支持的版本组合提供兼容和升级路径。
