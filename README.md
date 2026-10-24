# Baton

Baton 是跨设备 AI Agent 协同系统。员工使用管理员分配的本地账号登录中心服务（`baton-server`），注册并管理自己的设备节点（`batond`），在指定设备和目录中使用 Pi、Codex、Kiro Thread，也可以通过 Project Agent 主对话协调多个 Thread。中心保存消息、回复、附件引用与待办事项（Inbox），原生会话历史留在设备上。

## 系统架构与组件

| 组件 | 入口 / 目录 | 说明 |
|---|---|---|
| `baton-server` | `cmd/baton-server` | 中心控制面：员工认证、节点注册与凭据吊销、Project / Thread / Inbox 状态机、内置 Gateway（`/v1/node` 与 `/api/v1/events`）、嵌入式 Web UI |
| `batond` | `cmd/batond` | 节点守护进程：主动经 TLS WebSocket 连接 `baton-server`，维护本地 SQLite 账本（`node.db`），管理 Session Worker、Project Agent Runtime 及受限文件浏览根目录 |
| `baton-project-runtime` | `runtimes/project-agent` | 基于 Node.js / TypeScript 的 Project Agent 进程，通过本地 stdio JSON-RPC 与 `batond` 交互 |
| Web UI | `web/` (`internal/webui/dist`) | React + TypeScript + StyleX + Vite 前端，编译产物由 `baton-server` 直接内嵌提供 |

### 核心机制

- 消息与 Turn：中心在同一事务保存 Thread 消息和 `thread_outbox` 投递意图；设备上的独立 Session Worker 持久保存消息队列、Turn 边界和回复，确认保存后返回回执。重复命令和回复按稳定标识去重。
- 统一 Agent 适配：`internal/agent.Adapter` 提供 `Start`、`Send`、`Steer`、`Abort`、`Drain`、`Sent`、`ReadHistory`、`Capabilities` 与 `Close`，支持 Pi RPC、Codex CLI app-server、Kiro CLI ACP V3；Project Agent 命令通过 shell Thread 执行。
- 确定性回放验证：`internal/agent/replay` 与 `tools/agent-replay` 提供跨平台 NDJSON 协议录制、脱敏规范化与故障派生回放（`CutAfter` / `Drop` / `Replace`），日常测试无需调用真实外部大模型。
- 崩溃恢复：Worker 在发送消息前持久保存意图，恢复时查询原生历史确认是否已发送；无法确认时标为状态未知，避免重复执行。`batond` 重启后通过本地认证 IPC 重新连接存活的 Worker，未确认报告继续补送。

浏览器 API 使用 `/api/v1/threads`。Web 界面按 `design/` 实现，默认通过同源 `/api/v1` 连接真实后端；模拟数据仅用于显式启用的开发场景，见 [Web UI 文档](web/README.md)。

## 环境要求

- Go 1.27+
- PostgreSQL 16+
- Node.js 26+ 与 pnpm 12+（TypeScript workspace、`web/` 与 `runtimes/project-agent/`）

## 构建与常用命令

### 1. 构建完整运行目录

```sh
node tools/build.mjs
```

该命令按锁文件安装前端和 Runtime 依赖，构建 Web UI，编译 `baton-server`、`batond` 到 `bin/`（Windows 下带 `.exe` 后缀），并将 Project Agent Runtime 及其生产依赖打包到 `bin/sidecars/project-agent/`。构建产物不提交到 Git，无需另行运行打包命令。

Coordinator 嵌入 `internal/webui/dist` 中的静态文件，部署中心服务只需 `baton-server`，无需 Node.js、pnpm 或独立前端服务。设备端须保留 `batond` 与同目录的 `sidecars/`，并安装 Node.js 22.19.0 或更高版本；目标设备无需 pnpm 或联网安装 npm 依赖。登录及安装说明见 [Runtime 文档](runtimes/project-agent/README.md)。

`node tools/check-sidecar-package.mjs` 检查统一构建的设备产物：搬到临时目录、隔离 PATH 后验证 Runtime 定位、版本、订阅状态与私有文件读写，并确认缺少 bundle 时返回安装错误。CI 在统一构建后直接执行该检查，同时运行 Web 格式、lint、typecheck 和单元测试。

发布包使用原生构建产物。运行 `node tools/package-release.mjs v0.1.0-alpha.1`，在 `bin/releases/` 生成当前平台的压缩包及 `.sha256` 校验文件；打包脚本会解压最终附件，再检查 Runtime 定位、订阅状态和私有文件读写。包内含 `baton-server`、`batond`、`sidecars/`、[安装说明](runtimes/INSTALL.md)及记录源码提交的 `release.json`。

GitHub Actions 的 `Release packages` 工作流可手动指定版本，分别在 Linux amd64、macOS arm64 和 Windows amd64 的原生 runner 上构建及检查。Linux、macOS 生成 `.tar.gz`，Windows 生成 `.zip`。压缩使用系统提供的 `tar`；Windows 使用支持 zip 的系统 tar。工作流仅上传附件到 Actions artifacts，保留 30 天，不创建 tag 或发布 Release。发布前须确认同一提交的 CI 通过，并完成真实订阅登录及模型调用验收。

### 2. 部署中心服务与员工账号管理

`baton-server serve` 启动时自动执行数据库迁移，并在签名私钥不存在时生成 `0600` 私钥文件。默认路径为工作目录下的 `node-signing.key`，可用 `BATON_NODE_SIGNING_KEY` 指定；部署时持久保存该文件。已有密钥权限过宽、内容损坏或为符号链接时，启动会报错。

使用 Docker Compose 部署：

```sh
export BATON_POSTGRES_PASSWORD="$(openssl rand -hex 24)"
export BATON_ALLOWED_ORIGINS='https://baton.example'
docker compose up -d --build

# 创建员工账号，标准输出返回一次性初始口令
docker compose exec baton-server baton-server admin employee create --username alice --display-name "Alice"

# 重置员工口令并使旧会话失效
docker compose exec baton-server baton-server admin employee reset-password --username alice
```

将这两个环境变量保存在部署环境中，后续 Compose 命令使用相同配置和数据库口令。Compose 使用 PostgreSQL 16，分别以数据卷保存数据库和签名密钥，默认将 HTTP 端口绑定到本机 `127.0.0.1:8080`。通过支持 WebSocket 的 HTTPS 反向代理公开该端口，并把公开地址填入 `BATON_ALLOWED_ORIGINS`；`BATON_BIND_ADDR` 和 `BATON_PORT` 可调整宿主机绑定。容器以非 root 用户运行。

直接部署二进制时，配置数据库和公开 HTTPS Origin：

```sh
BATON_DATABASE_URL='postgres://用户:口令@127.0.0.1:5432/baton?sslmode=disable' \
BATON_ALLOWED_ORIGINS='https://baton.example' \
  ./bin/baton-server serve
```

默认监听 `127.0.0.1:8080`，由 HTTPS 反向代理转发；也可同时设置 `BATON_TLS_CERT_FILE` 和 `BATON_TLS_KEY_FILE` 直接提供 HTTPS/WSS。管理员命令使用相同的 `BATON_DATABASE_URL`，执行 `./bin/baton-server admin employee create --username alice --display-name "Alice"` 或 `./bin/baton-server admin employee reset-password --username alice`。`./bin/baton-server migrate` 可单独执行幂等迁移。

实验室阶段从当前 schema 基线创建数据库，开发结构变化后重建本地数据，不提供旧开发版本升级路径。迁移执行器按版本记录幂等执行，正式发布后可用于增量迁移。

### 3. 接入设备

登录网页并领取一次性注册凭据后，在设备上运行：

```sh
BATON_ENROLLMENT_TOKEN='<网页提供的一次性注册凭据>' \
  ./bin/batond up --coordinator https://baton.example
```

`up` 首次运行时注册并连接中心服务，后续执行 `./bin/batond up` 即可复用本地身份。首次运行且尚无 `browse-roots.json` 时，默认开放当前用户主目录；已有配置（包括空列表）保持原样。回到网页，在设备详情的 Allowed folders 中直接添加或移除设备上的目录；选目录弹窗也支持输入路径后添加并选中。可选的 `--workspace /绝对路径` 在连接前登记指定目录，要求路径已经存在，重复登记同一路径不报错。显示名默认使用清理后的主机名，系统自动识别为 `windows`、`macos` 或 `linux`；可通过 `--display-name` 和 `--system` 指定。

也可以分步注册与运行：

```sh
BATON_ENROLLMENT_TOKEN='<网页提供的一次性注册凭据>' \
  ./bin/batond register --coordinator https://baton.example
./bin/batond files add --id repo --path /你的代码目录
./bin/batond run
```

注册将规范化的中心 HTTPS 地址保存在 `identity.json` 的 `coordinator_url` 中，`run` 从中推导 `wss://主机/v1/node`。可通过 `--relay` 显式指定连接地址；身份文件没有中心地址时需要提供该参数。`register`、`up`、`run` 和 `files` 均支持 `--data-dir`，须使用同一数据目录。注册凭据也可经 `--enrollment-file` 从仅当前用户可读的文件加载。

### 4. 登录 Project assistant 的模型订阅

在网页 Devices 中展开在线设备，点击 `Sign in to ChatGPT` 或 `Sign in to xAI`，复制设备码并打开授权页完成登录。设备上报登录状态后，弹窗显示 `Signed in`。模型订阅凭据保存在设备上，不上传中心。

也可以在运行 batond 的设备上，使用同一个系统用户执行：

```sh
# ChatGPT；xAI 使用 ./bin/batond login xai
./bin/batond login openai-codex
./bin/batond subscriptions
```

登录命令会显示授权步骤；ChatGPT 支持浏览器和设备码登录。网页登录使用相同的设备本地凭据目录，授权完成后设备立即刷新订阅状态。统一构建已包含 Project Runtime bundle，设备安装时保留 `sidecars/` 目录，详见 [Runtime 安装说明](runtimes/project-agent/README.md)。凭据保存在设备上，独立于 Pi、Codex CLI 的登录记录；在线 batond 自动上报登录状态。

## 配置参考

| 环境变量 | 适用进程 | 说明 |
|---|---|---|
| `BATON_DATABASE_URL` | `baton-server` | PostgreSQL 连接串 |
| `BATON_DB_SCHEMA` | `baton-server` | 数据库 schema，默认 `public` |
| `BATON_HTTP_ADDR` | `baton-server` | HTTP/WebSocket 监听地址，默认 `127.0.0.1:8080`，容器内为 `0.0.0.0:8080` |
| `BATON_ALLOWED_ORIGINS` | `baton-server` | 逗号分隔的允许 HTTPS Origin（`serve` 必填） |
| `BATON_NODE_SIGNING_KEY` | `baton-server` | Ed25519 PKCS#8 私钥文件路径，默认 `node-signing.key`，不存在时自动生成（仅当前用户可读，`0600`）；容器内为 `/var/lib/baton/node-signing.key` |
| `BATON_TLS_CERT_FILE` / `BATON_TLS_KEY_FILE` | `baton-server` | 直接提供 HTTPS/WSS 时的证书与私钥路径 |
| `BATON_SESSION_TTL` | `baton-server` | 浏览器登录会话有效期，默认 `12h`（`5m`～`168h`） |
| `BATON_ENROLLMENT_TTL` | `baton-server` | 一次性节点注册凭据有效期，默认 `10m`（`1m`～`24h`） |
| `BATON_NODE_CREDENTIAL_TTL` | `baton-server` | 节点连接凭据有效期，默认 `720h`（`1h`～`2160h`） |
| `BATON_HEARTBEAT_INTERVAL` | `baton-server` / `batond` | 心跳间隔，默认 `10s`（`100ms`～`2m`） |
| `BATON_OFFLINE_AFTER` | `baton-server` | 超过该时间未联系判定节点离线，默认 `30s`（须大于心跳间隔） |
| `BATON_ENROLLMENT_TOKEN` | `batond register` / `batond up` | 一次性节点注册凭据（也可通过 `--enrollment-file` 提供） |
| `BATON_TLS_CA_FILE` | `batond` | 额外信任的根证书文件路径 |
| `BATON_PROJECT_RUNTIME_DATA_DIR` | `batond` / Project Runtime | 模型订阅凭据目录，默认 `~/.baton/project-runtime`；登录和守护进程须使用相同配置 |

## 本地开发与测试

### TypeScript 远程与本地 Thread

`apps/server` 与 `apps/batond` 提供 Cursor 远程 Thread、Project 协同与设备管理：员工登录网页、注册设备后，可以新建会话、排队、撤回、停止、恢复、归档并读取回复和实时输出，也可管理 Project 主对话、事项、记忆、授权目录和模型订阅。中心使用 PostgreSQL 保存账号、设备、命令、回复与 Project 状态；节点通过出站 WSS 连接，使用私有 SQLite 保存投递和 Runtime 生命周期事实，再通过认证 IPC 连接独立 Worker。本地 CLI 也可直接调用同一 Worker。发布构建仍使用 Go 入口，TS 使用独立开发命令：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @baton/server build
pnpm --filter @baton/batond build
pnpm --filter @baton/server dev help
pnpm --filter @baton/batond dev help
pnpm --filter @baton/batond dev probe
```

中心构建包含网页和 SQL 迁移。账号初始化、HTTPS 配置和设备接入见 [中心文档](apps/server/README.md)；节点与本地命令、恢复语义见 [Thread 文档](apps/batond/README.md)。Cursor 使用设备上显式配置的 `CURSOR_API_KEY`；后台探测只查询认证和模型、检查本机依赖，不发送推理请求。仅 `available` 且声明创建能力的 SDK / 系统组合允许新建。Project 使用设备本地的 ChatGPT 或 xAI 订阅，提供带租约的独立 Runtime 和受限 shell Thread；目录与执行开关默认遵守本机配置。Runtime 从源码与已安装依赖启动，完整安装包和发布切换归迁移 T5；其他 Agent 与统一原生历史归 T4。

验证使用本机 PostgreSQL、确定性回放和本地替身，无需真实模型凭据；包括独立 Worker、中心与节点重启、ACK 丢失、数据库连接中断和跨员工隔离。Node 26、pnpm 12 的工作区检查为：

```sh
pnpm check
pnpm typecheck
pnpm test
```

工作区使用 Vite+ 1.4：根目录 `vite.config.ts` 统一配置 Oxlint 推荐规则、Oxfmt 和 TypeScript Go 检查，测试通过内置 Vitest 运行。`pnpm lint` 和 `pnpm check` 对警告返回失败，CI 使用同一检查入口。`pnpm typecheck` 同时保留各包现有编译检查。Node 与 pnpm 继续由现有环境提供，无需安装全局 `vp`。

工作区测试按依赖顺序串行执行，不启用任务结果缓存；测试会构建 Project Runtime，须与 `node tools/build.mjs` 分开执行，避免同时清理同一个产物目录。上游复用范围见 [providers 文档](packages/providers/README.md)。

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
