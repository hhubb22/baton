# Baton

Baton 是跨设备 AI Agent 协同系统。员工使用管理员分配的本地账号登录中心服务（`coordinator`），注册并管理自己的设备节点（`batond`），在指定设备和目录中使用 Pi、Codex、Kiro Thread，也可以通过 Project Agent 主对话协调多个 Thread。中心保存消息、回复、附件引用与待办事项（Inbox），原生会话历史留在设备上。

## 系统架构与组件

| 组件 | 入口 / 目录 | 说明 |
|---|---|---|
| `coordinator` | `cmd/coordinator` | 中心控制面：员工认证、节点注册与凭据吊销、Project / Thread / Inbox 状态机、内置 Gateway（`/v1/node` 与 `/api/v1/events`）、嵌入式 Web UI |
| `batond` | `cmd/batond` | 节点守护进程：主动经 TLS WebSocket 连接 `coordinator`，维护本地 SQLite 账本（`node.db`），管理 Session Worker、Project Agent Runtime 及受限文件浏览根目录 |
| `baton-project-runtime` | `runtimes/project-agent` | 基于 Node.js / TypeScript 的 Project Agent 进程，通过本地 stdio JSON-RPC 与 `batond` 交互 |
| Web UI | `web/` (`internal/webui/dist`) | React + TypeScript + StyleX + Vite 前端，编译产物由 `coordinator` 直接内嵌提供 |

### 核心机制

- 消息与 Turn：中心在同一事务保存 Thread 消息和 `thread_outbox` 投递意图；设备上的独立 Session Worker 持久保存消息队列、Turn 边界和回复，确认保存后返回回执。重复命令和回复按稳定标识去重。
- 统一 Agent 适配：`internal/agent.Adapter` 提供 `Start`、`Send`、`Steer`、`Abort`、`Drain`、`Sent`、`ReadHistory`、`Capabilities` 与 `Close`，支持 Pi RPC、Codex CLI app-server、Kiro CLI ACP V3；Project Agent 命令通过 shell Thread 执行。
- 确定性回放验证：`internal/agent/replay` 与 `tools/agent-replay` 提供跨平台 NDJSON 协议录制、脱敏规范化与故障派生回放（`CutAfter` / `Drop` / `Replace`），日常测试无需调用真实外部大模型。
- 崩溃恢复：Worker 在发送消息前持久保存意图，恢复时查询原生历史确认是否已发送；无法确认时标为状态未知，避免重复执行。`batond` 重启后通过本地认证 IPC 重新连接存活的 Worker，未确认报告继续补送。

浏览器 API 使用 `/api/v1/threads`。Web 界面按 `design/` 实现，默认通过同源 `/api/v1` 连接真实后端；模拟数据仅用于显式启用的开发场景，见 [Web UI 文档](web/README.md)。

## 环境要求

- Go 1.27+
- PostgreSQL 16+
- Node.js 24+ 与 pnpm 10+（用于 `web/` 与 `runtimes/project-agent/`）

## 构建与常用命令

### 1. 构建完整运行目录

```sh
node tools/build.mjs
```

该命令按锁文件安装前端和 Runtime 依赖，构建 Web UI，编译 `coordinator`、`batond` 到 `bin/`（Windows 下带 `.exe` 后缀），并将 Project Agent Runtime 及其生产依赖打包到 `bin/sidecars/project-agent/`。构建产物不提交到 Git，无需另行运行打包命令。

Coordinator 嵌入 `internal/webui/dist` 中的静态文件，部署中心服务只需 `coordinator`，无需 Node.js、pnpm 或独立前端服务。设备端须保留 `batond` 与同目录的 `sidecars/`，并安装 Node.js 22.19.0 或更高版本；目标设备无需 pnpm 或联网安装 npm 依赖。登录及安装说明见 [Runtime 文档](runtimes/project-agent/README.md)。

`node tools/check-sidecar-package.mjs` 检查统一构建的设备产物：搬到临时目录、隔离 PATH 后验证 Runtime 定位、版本、订阅状态与私有文件读写，并确认缺少 bundle 时返回安装错误。CI 在统一构建后直接执行该检查，同时运行 Web 格式、lint、typecheck 和单元测试。

### 2. 数据库迁移与员工账号管理

实验室阶段从当前 schema 基线创建数据库，开发结构变化后重建本地数据，不提供旧开发版本升级路径。迁移执行器按版本记录幂等执行，正式发布后可用于增量迁移。

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
  --system macos \
  --data-dir "$HOME/Library/Application Support/baton/node"

# 登记受限浏览目录并运行节点守护进程
./bin/batond files add --id repo --path /你的代码目录 --data-dir "$HOME/Library/Application Support/baton/node"
./bin/batond run --relay wss://baton.example/v1/node --data-dir "$HOME/Library/Application Support/baton/node"
```

### 4. 登录 Project assistant 的模型订阅

在运行 batond 的设备上，使用同一个系统用户执行：

```sh
# ChatGPT；xAI 使用 ./bin/batond login xai
./bin/batond login openai-codex
./bin/batond subscriptions
```

登录命令会显示授权步骤；ChatGPT 支持浏览器和设备码登录。统一构建已包含 Project Runtime bundle，设备安装时保留 `sidecars/` 目录，详见 [Runtime 安装说明](runtimes/project-agent/README.md)。凭据保存在设备上，独立于 Pi、Codex CLI 的登录记录；在线 batond 自动上报登录状态。

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
| `BATON_ENROLLMENT_TOKEN` | `batond register` | 一次性节点注册凭据（也可通过 `--enrollment-token-file` 提供） |
| `BATON_TLS_CA_FILE` | `batond` | 额外信任的根证书文件路径 |
| `BATON_PROJECT_RUNTIME_DATA_DIR` | `batond` / Project Runtime | 模型订阅凭据目录，默认 `~/.baton/project-runtime`；登录和守护进程须使用相同配置 |

## 本地开发与测试

### Go 单元与集成测试

集成测试使用真实 PostgreSQL 并在独立临时 schema 中执行迁移与清理。未设置 `BATON_TEST_DATABASE_URL` 时，默认连接本机 `postgres://postgres:baton@127.0.0.1:5432/baton_test?sslmode=disable`（若 `~/.baton-postgres` 存在且未启动，测试辅助库会自动尝试通过 `pg_ctl` 拉起）：

首次检出或修改前端源码后，先运行统一构建命令，生成 Go 嵌入所需的静态文件：

```sh
node tools/build.mjs
go vet ./...
go test ./...
```

如需指定其他测试库实例，可显式设置 `BATON_TEST_DATABASE_URL`。CI 使用 PostgreSQL 16 运行测试，并在 Go 测试中启用真实 Node Runtime 与 Coordinator 的模型替身集成测试。数据库停机/恢复测试通过本机 `pg_config --bindir` 寻找 PostgreSQL 16+ 程序，也可用 `BATON_TEST_POSTGRES_BINDIR` 指定程序目录。

### Project Agent Runtime 测试

```sh
pnpm --dir runtimes/project-agent install
pnpm --dir runtimes/project-agent test
```

### Web 前端开发与验证

开发时使用 Vite 提供热更新页面，默认连接真实后端；可用 `BATON_DEV_BACKEND` 配置 Coordinator 代理地址。显式添加 `?mock=1` 或 `?scenario=<id>` 可启用模拟场景，无需启动后端；运行方式和场景说明见 [web/README.md](web/README.md)。

```sh
pnpm --dir web install --frozen-lockfile
pnpm --dir web dev
```

前端检查命令如下。`pnpm --dir web build` 会生成被 Go 嵌入的静态文件；发布构建统一使用 `node tools/build.mjs`。

```sh
pnpm --dir web install
pnpm --dir web format:check
pnpm --dir web lint
pnpm --dir web typecheck
pnpm --dir web test
pnpm --dir web build
```

## 规格与设计文档

- Elyx 界面设计项目：[design/README.md](design/README.md)
- 全局产品规格：[specs/baton/PRODUCT.md](specs/baton/PRODUCT.md)
- 全局技术设计：[specs/baton/TECH.md](specs/baton/TECH.md)
- Project Agent 规格与设计：[specs/project-agent/PRODUCT.md](specs/project-agent/PRODUCT.md)、[specs/project-agent/TECH.md](specs/project-agent/TECH.md)
- Agent Inbox 规格与设计：[specs/agent-inbox/PRODUCT.md](specs/agent-inbox/PRODUCT.md)、[specs/agent-inbox/TECH.md](specs/agent-inbox/TECH.md)
- Agent 录制与回放设计：[specs/agent-replay/PRODUCT.md](specs/agent-replay/PRODUCT.md)、[specs/agent-replay/TECH.md](specs/agent-replay/TECH.md)
