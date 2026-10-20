# Baton

Baton 是跨设备 AI Agent 协同与任务派发系统。员工使用部署管理员分配的本地账号登录中心服务（`coordinator`），注册并管理自己的设备节点（`batond`），通过 Project Agent 主对话或直接任务派发在设备上运行受控的本地 Agent 会话（Pi、Codex、Kiro），并在中心留存结构化结果、证据引用与待办事项（Inbox）。

## 系统架构与组件

| 组件 | 入口 / 目录 | 说明 |
|---|---|---|
| `coordinator` | `cmd/coordinator` | 中心控制面：员工认证、节点注册与凭据吊销、Project / Task / Inbox 状态机、内置 Gateway（`/v1/node` 与 `/api/v1/events`）、嵌入式 Web UI |
| `batond` | `cmd/batond` | 节点守护进程：主动经 TLS WebSocket 连接 `coordinator`，维护本地 SQLite 账本（`node.db`），管理 Session Worker、Project Agent Runtime 及受限文件浏览根目录 |
| `baton` | `cmd/baton` | 节点本地 CLI：供执行中的 Agent 通过 `BATON_CONTEXT_FILE` 委托子任务、查询子任务状态与结果 |
| `baton-project-runtime` | `runtimes/project-agent` | 基于 Node.js / TypeScript 的 Project Agent 进程，通过本地 stdio JSON-RPC 与 `batond` 交互 |
| Web UI | `web/` (`internal/webui/dist`) | React + TypeScript + Vite 前端，编译产物由 `coordinator` 直接内嵌提供 |

### 核心机制

- **准备与执行分离**：任务被中心接受后，先通过 `dispatch_outbox` 发送 `prepare` 指令；节点将 `task_id -> execution_id -> session_id` 写入本地 SQLite 账本并启动独立 Session Worker 后才确认 `prepare`。Worker 向中心申请短时启动许可（`start_authorized`）并持久化 `start_intent` 后，才向底层 Agent 提交一次任务输入。
- **统一 Agent 适配**：`internal/agent.Adapter` 统一抽象 `Start`、`SubmitInput`、`DeliverResult`、`HistoryContains`、`ReadHistory`、`Drain`、`Abort`、`Close` 与 `StopObserver`，支持 Pi RPC（`internal/agent/pi`）、Codex CLI app-server（`internal/agent/codex`）与 Kiro CLI ACP V3（`internal/agent/kiro`）。
- **确定性回放验证**：`internal/agent/replay` 与 `tools/agent-replay` 提供跨平台 NDJSON 协议录制、脱敏规范化与故障派生回放（`CutAfter` / `Drop` / `Replace`），日常测试无需调用真实外部大模型。
- **锁顺序与崩溃恢复**：中心事务同时锁定任务与执行记录时，固定先锁 `tasks` 再锁 `executions`；`batond` 重启后通过本地认证 IPC 重新附着存活的 Session Worker，不重复发送任务输入。

## 环境要求

- Go 1.27+
- PostgreSQL 17+
- Node.js 24+ 与 pnpm 10+（用于 `web/` 与 `runtimes/project-agent/`）

## 构建与常用命令

### 1. 构建二进制

```sh
go build -o bin/coordinator ./cmd/coordinator
go build -o bin/batond ./cmd/batond
go build -o bin/baton ./cmd/baton
```

### 2. 数据库迁移与员工账号管理

```sh
# 执行中心数据库迁移
BATON_DATABASE_URL='postgres://postgres:baton@127.0.0.1:5432/baton?sslmode=disable' \
  ./bin/coordinator migrate

# 创建员工账号（标准输出返回一次性初始口令）
BATON_DATABASE_URL='postgres://postgres:baton@127.0.0.1:5432/baton?sslmode=disable' \
  ./bin/coordinator admin employee create --username alice --display-name "Alice"

# 重置员工口令并使旧会话失效
BATON_DATABASE_URL='postgres://postgres:baton@127.0.0.1:5432/baton?sslmode=disable' \
  ./bin/coordinator admin employee reset-password --username alice
```

### 3. 启动中心服务与注册节点

```sh
# 启动 coordinator
BATON_DATABASE_URL='postgres://postgres:baton@127.0.0.1:5432/baton?sslmode=disable' \
BATON_ALLOWED_ORIGINS='https://baton.example' \
BATON_HTTP_ADDR='127.0.0.1:8080' \
BATON_NODE_SIGNING_KEY='/path/to/node-signing.key' \
  ./bin/coordinator serve

# 注册节点（通过环境变量传入一次性注册凭据）
BATON_ENROLLMENT_TOKEN='<one-time-enrollment-token>' \
  ./bin/batond register \
  --coordinator https://baton.example \
  --display-name "Workstation" \
  --data-dir /var/lib/baton-node

# 登记受限浏览目录并运行节点守护进程
./bin/batond files add --id repo --path /srv/work/repo --data-dir /var/lib/baton-node
./bin/batond run --relay wss://baton.example/v1/node --data-dir /var/lib/baton-node
```

## 配置参考

| 环境变量 | 适用进程 | 说明 |
|---|---|---|
| `BATON_DATABASE_URL` | `coordinator` | PostgreSQL 连接串 |
| `BATON_DB_SCHEMA` | `coordinator` | 数据库 schema，默认 `public` |
| `BATON_HTTP_ADDR` | `coordinator` | HTTP/WebSocket 监听地址，默认 `127.0.0.1:8080` |
| `BATON_ALLOWED_ORIGINS` | `coordinator` | 逗号分隔的允许 HTTPS Origin（`serve` 必填） |
| `BATON_NODE_SIGNING_KEY` | `coordinator` | Ed25519 PKCS#8 私钥文件路径（仅当前用户可读，`0600`） |
| `BATON_TLS_CERT_FILE` / `BATON_TLS_KEY_FILE` | `coordinator` | 直接提供 HTTPS/WSS 时的证书与私钥路径 |
| `BATON_SESSION_TTL` | `coordinator` | 浏览器登录会话有效期，默认 `12h`（`5m`～`168h`） |
| `BATON_ENROLLMENT_TTL` | `coordinator` | 一次性节点注册凭据有效期，默认 `10m`（`1m`～`24h`） |
| `BATON_NODE_CREDENTIAL_TTL` | `coordinator` | 节点连接凭据有效期，默认 `720h`（`1h`～`2160h`） |
| `BATON_HEARTBEAT_INTERVAL` | `coordinator` / `batond` | 心跳间隔，默认 `10s`（`100ms`～`2m`） |
| `BATON_OFFLINE_AFTER` | `coordinator` | 超过该时间未联系判定节点离线，默认 `30s`（须大于心跳间隔） |
| `BATON_PLANE_URL` / `BATON_PLANE_API_KEY` / `BATON_PLANE_WEBHOOK_SECRET` / `BATON_PLANE_CONFIG` | `coordinator` | 可选 Plane Webhook 接入与回写配置 |
| `BATON_ENROLLMENT_TOKEN` | `batond register` | 一次性节点注册凭据（也可通过 `--enrollment-token-file` 提供） |
| `BATON_TLS_CA_FILE` | `batond` | 额外信任的根证书文件路径 |

## 本地开发与测试

### Go 测试（零配置）

集成测试使用真实 PostgreSQL 并在独立临时 schema 中执行迁移与清理。未设置 `BATON_TEST_DATABASE_URL` 时，默认连接本机 `postgres://postgres:baton@127.0.0.1:5432/baton_test?sslmode=disable`（若 `~/.baton-postgres` 存在且未启动，测试辅助库会自动尝试通过 `pg_ctl` 拉起）：

```sh
go build ./...
go vet ./...
go test ./...
```

如需指定其他测试库实例，可显式设置 `BATON_TEST_DATABASE_URL`。

### Project Agent Runtime 测试

```sh
pnpm --dir runtimes/project-agent install
pnpm --dir runtimes/project-agent test
```

### Web 前端开发与验证

`web/` 构建结果直接输出到 `internal/webui/dist` 并由 `internal/webui` 嵌入：

```sh
pnpm --dir web install
pnpm --dir web lint
pnpm --dir web typecheck
pnpm --dir web test:unit
pnpm --dir web build
pnpm --dir web check:dist
pnpm --dir web test:e2e
```

## 规格与设计文档

- 全局产品规格：[specs/baton/PRODUCT.md](specs/baton/PRODUCT.md)
- 全局技术设计：[specs/baton/TECH.md](specs/baton/TECH.md)
- Project Agent 规格与设计：[specs/project-agent/PRODUCT.md](specs/project-agent/PRODUCT.md)、[specs/project-agent/TECH.md](specs/project-agent/TECH.md)
- Agent Inbox 规格与设计：[specs/agent-inbox/PRODUCT.md](specs/agent-inbox/PRODUCT.md)、[specs/agent-inbox/TECH.md](specs/agent-inbox/TECH.md)
- Agent 录制与回放设计：[specs/agent-replay/PRODUCT.md](specs/agent-replay/PRODUCT.md)、[specs/agent-replay/TECH.md](specs/agent-replay/TECH.md)
