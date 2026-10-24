# Baton — Agent Guide

Baton 是跨设备 AI Agent 协同系统，由中心服务（`baton-server`）、节点守护进程（`batond`）、本地会话执行器（Session Worker）、Project Agent Runtime（`runtimes/project-agent`）和嵌入式 Web UI（`web/`）组成。

## 核心架构与目录

| 目录 / 模块 | 职责 |
|---|---|
| `cmd/baton-server` | 中心控制面：员工认证、Project 与 Thread 调度、内置 Gateway（`/v1/node` 与 `/api/v1/events`）、嵌入式 Web UI |
| `cmd/batond` | 节点守护进程：节点注册、出站 TLS WebSocket 连接、本地 SQLite 账本（`node.db`）、Session Worker 与 Project Runtime 管理 |
| `internal/session` | Session Worker 生命周期、本地认证 IPC、Thread 消息队列与 Turn 账本 |
| `internal/agent/{pi,codex,kiro,shell,replay}` | 统一 `agent.Adapter` 接口实现（Pi RPC、Codex app-server、Kiro ACP V3）与确定性录制回放 |
| `apps/batond` | TypeScript 本地 Thread 开发入口：认证 IPC、持久 Worker、Cursor SDK host 与平台进程回收；独立于 Go 发布入口 |
| `packages/{protocol,sqlite}` | TypeScript 协议 Schema 与 WAL/FULL SQLite 客户端、提交结果核查 |
| `packages/{providers,provider-testing}` | 从固定 t3code 提交复用的 Cursor SDK/runtime、上游测试和确定性回放 |
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
- **TypeScript workspace**（Node 26、pnpm 12；真实 Cursor 验证单独显式运行，见 `apps/batond/README.md`）：
  ```sh
  pnpm install --frozen-lockfile --ignore-scripts
  pnpm -r typecheck
  pnpm -r lint
  pnpm -r test
  pnpm --filter @baton/batond build
  ```
- **Go 单元与集成测试**（先运行 `node tools/build.mjs`；默认连接本机 `postgres://postgres:baton@127.0.0.1:5432/baton_test?sslmode=disable`，若未启动会自动尝试通过 `pg_ctl` 拉起 `~/.baton-postgres`，可通过 `BATON_TEST_DATABASE_URL` 覆盖）：
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
3. **测试金字塔**：按下节原则判断是否需要补测。纯逻辑、并发竞争与存储不变量优先使用包内单元测试或确定性回放，多进程与浏览器 E2E 只覆盖必须跨进程验证的核心行为。
4. **文档只写当前状态，不写工单流水账**：更新 `README.md`、`PRODUCT.md`、`TECH.md` 时，直接原地修改对应章节以反映最新架构与行为，**严禁**追加「当前已实现 PS-xxx...」或「2026-xx-xx 修订」之类的工单历史段落。
5. **实验室阶段统一当前结构**：产品正式发布并确定版本号前，不维护旧开发版本的数据库、设备账本、结果格式或摘要兼容分支；结构变化可重建本地数据。保留协议版本、未知字段容忍和可选能力声明等扩展机制，正式发布后再为支持的版本组合提供兼容和升级路径。

## 测试与验证取舍

- 复用上游模块时，优先沿用原实现、原测试和转录，只为 Baton 的适配差异与新增关键行为补少量测试。上游已覆盖的行为直接复用其验证。
- 测试验证可观察行为和持久事实，合并重复场景，减少函数调用、对象引用和参数排列等实现细节断言。简单、可逆、低影响的改动可只做相关静态检查。
- 实验阶段先跑通真实主链路并投入使用，普通边界问题随实际发现修复，再补最小回归。故障注入、全平台门控和性能基准按具体需要安排；存在明确的数据丢失、越权或重复副作用风险时，保留能验证该风险的最小测试。
- 验证按改动影响范围选择。局部测试或文档精简运行受影响包的测试与相关检查；共享协议、构建发布或跨模块行为变化时再扩大范围。真实 Agent 门控单独显式运行。
