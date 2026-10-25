# Baton

Baton 是跨设备 AI Agent 协同系统。员工使用管理员分配的本地账号登录中心服务，注册并管理自己的设备，在指定设备和目录中使用 Cursor、Pi、Codex、Kiro Thread，也可以通过 Project Agent 主对话协调多个 Thread。中心保存输入、回复、附件引用、事项和记忆；原生会话与模型凭据保存在设备上。

## 系统架构与组件

| 组件 | 入口 / 目录 | 说明 |
|---|---|---|
| `baton-server` | `apps/server` | TypeScript + Effect 中心：员工认证、设备注册与吊销、Thread / Project / Inbox、PostgreSQL 事务、Gateway、静态网页与 API |
| `batond` | `apps/batond` | TypeScript + Effect 节点：出站 WSS、SQLite 本地账本、认证 IPC、独立 Worker、Agent 探测、目录与订阅管理 |
| Session Worker | `apps/batond/src/worker` | 每个 Thread 一个进程，维护命令回执、消息队列、intent、Turn、回复和 outbox |
| agent-host | `apps/batond/src/agent-host` | 承载 t3code fork 的完整 provider adapter，将原生事件映射给 Worker |
| Project Runtime | `runtimes/project-agent` | 基于 pi-agent-core 与 pi-ai 的项目助手，通过专用 stdio JSON-RPC 与节点交互 |
| Web UI | `web` → `apps/server/dist/web` | React + TypeScript + StyleX + Vite 前端，由中心提供静态文件 |
| 共享包 | `packages/{protocol,sqlite,telemetry}` | Effect Schema、WAL/FULL SQLite 与提交核查、OTLP/HTTP 追踪 |

中心在同一事务保存消息与投递意图，设备持久接收后回执，命令完成独立报告。Worker 在原生提交前保存 intent；崩溃恢复通过只读快照核对是否发送，无法确认时保留 unknown，避免重复执行。节点重启后通过认证 IPC 连接存活的 Worker，未确认报告按原身份补送。

Agent 接入使用 [`upstream/t3code`](third_party/t3code/README.md) 中的完整 provider。日常验证复用上游离线测试、静态转录、确定性回放和本地替身，见 [回放测试设计](specs/agent-replay/TECH.md)。

浏览器默认通过同源 `/api/v1` 连接中心，节点连接 `/v1/node`，浏览器事件使用 `/api/v1/events`。页面按 `design/` 实现；模拟数据仅在显式启用的开发场景中使用，见 [Web 文档](web/README.md)。

## 环境要求

- Node.js 26+、pnpm 12+，用于工作区开发和 bundle 运行。
- PostgreSQL 16+，用于中心数据与本地集成测试。
- Agent 所需原生 CLI 或 SDK 及设备本地认证。Cursor 使用显式配置的 `CURSOR_API_KEY`；Pi、Codex、Kiro 使用原生 CLI 配置。

## 构建与运行

首次检出后，在仓库根目录运行：

```sh
git submodule update --init
pnpm install --frozen-lockfile --ignore-scripts
node tools/build.mjs
```

统一构建从根 workspace 按锁文件安装依赖，然后构建 `@baton/server` 和 `@baton/batond`，产物位于 `apps/server/dist` 与 `apps/batond/dist`。也可分别运行：

```sh
pnpm --filter @baton/server build
pnpm --filter @baton/batond build
```

中心构建自动生成 `server.cjs`、相邻的 `web/` 和 `migrations/`；启动中心时须保留这三个部分。节点 bundle 为 `apps/batond/dist/batond.cjs`，开发运行仍使用 workspace 依赖，Project Runtime 从源码入口启动。产物不提交 Git。容器与 batond SEA 的发布布局、附带依赖和系统验证范围见 [迁移设计的打包与发布](specs/ts-migration/TECH.md#打包与发布)。

### 中心服务与员工账号

先建立 PostgreSQL 数据库，并在仓库根目录配置连接和公开 HTTPS Origin：

```sh
export BATON_DATABASE_URL='postgres://用户:口令@127.0.0.1:5432/baton?sslmode=disable'
export BATON_ALLOWED_ORIGINS='https://baton.example'
node apps/server/dist/server.cjs admin employee create --username alice --display-name Alice
node apps/server/dist/server.cjs serve
```

账号创建命令输出一次性口令，员工首次登录后须修改口令并重新登录。重置口令使用 `node apps/server/dist/server.cjs admin employee reset-password --username alice`。`serve`、账号管理和 `migrate` 都先执行并核对迁移，`migrate` 完成后退出。

中心默认监听 `127.0.0.1:8080`，由支持 WebSocket 的 HTTPS 反向代理接入；直接 HTTPS 可同时配置 `BATON_TLS_CERT_FILE` 和 `BATON_TLS_KEY_FILE`。签名密钥默认保存在工作目录的 `node-signing.key`，可用 `BATON_NODE_SIGNING_KEY` 指定。文件不存在时生成 `0600` Ed25519 私钥，已有文件校验类型、权限、所有者与内容。部署时须持久保存数据库和密钥。

实验室阶段使用当前 schema 基线，结构变化后可重建本地数据。迁移按版本记录幂等执行，正式发布后可用于增量迁移。本机证书、CA、反向代理与配置细节见 [中心文档](apps/server/README.md)。

### 设备接入

登录网页，在 Devices 领取一次性注册凭据后，在设备上的仓库目录运行：

```sh
BATON_ENROLLMENT_TOKEN='<网页提供的一次性注册凭据>' \
  node apps/batond/dist/batond.cjs up --coordinator https://baton.example
```

已有身份时 `up` 直接复用。首次无目录配置时开放当前用户主目录，已有配置（含空列表）保留；可加 `--workspace /绝对路径` 幂等登记已有目录。网页设备详情和选目录弹窗也可添加或移除授权目录。显示名默认主机名，系统自动识别。

也可以分步操作：

```sh
BATON_ENROLLMENT_TOKEN='<网页提供的一次性注册凭据>' \
  node apps/batond/dist/batond.cjs register --coordinator https://baton.example
node apps/batond/dist/batond.cjs files add --id repo --path /你的代码目录
node apps/batond/dist/batond.cjs run
```

注册将规范化的中心 HTTPS 地址保存为 `identity.json` 的 `coordinator_url`，`run` 据此推导 WSS 地址；`--relay` 可显式指定。默认数据目录为 `~/.baton-ts`，所有命令使用相同的 `--data-dir`。注册凭据也可用 `--enrollment-file` 从私有文件读取；私有 CA 使用 `--ca-file`，每次运行均须提供。更多本地命令和恢复语义见 [节点文档](apps/batond/README.md)。

四个 Agent 在程序或 SDK 已安装且认证有效或未知时报告 `available`，按上游 adapter 与已实现的执行路径开放新建与恢复。版本、系统与认证未知写入诊断，缺少某个组合的验证证据不会关闭能力。缺程序、明确未认证或已确认运行依赖失败时报告 `unavailable`。探测只检查认证、模型和依赖，不发送推理请求。

### Project 与模型订阅

网页可管理 Project 主对话、事项、记忆与历史版本、目录授权、附件预览及本机命令执行开关。Project 使用设备本地的 ChatGPT、xAI 或 Claude 配置，按租约启动独立 Runtime；本机执行开关默认关闭，`nodes.exec` 通过受限 shell Thread 执行命令。

设备详情按 Runtime 报告的登录方式显示入口。ChatGPT 和 xAI 支持设备码登录，凭据保存在设备上，完成后立即刷新报告。终端登录和状态查询可使用：

```sh
node apps/batond/dist/batond.cjs login openai-codex
node apps/batond/dist/batond.cjs subscriptions
```

`login` 接受 provider ID 及 ChatGPT、xAI、Claude 别名，由 Runtime 注册表决定支持范围。Runtime 当前注册 `openai-codex`、`xai`、`anthropic`。登录和守护进程须使用同一系统用户及凭据目录；这些凭据独立于执行 Agent 的原生 CLI 账号。开发 bundle 的 Runtime 依赖仓库布局，安装包入口见迁移设计。

## 配置参考

| 环境变量 | 适用进程 | 说明 |
|---|---|---|
| `BATON_DATABASE_URL` | 中心 | PostgreSQL 连接串 |
| `BATON_DB_SCHEMA` | 中心 | 数据库 schema，默认 `public` |
| `BATON_HTTP_ADDR` | 中心 | HTTP/WebSocket 监听地址，默认 `127.0.0.1:8080` |
| `BATON_ALLOWED_ORIGINS` | 中心 | 逗号分隔的允许 HTTPS Origin，`serve` 必填 |
| `BATON_NODE_SIGNING_KEY` | 中心 | Ed25519 私钥路径，默认工作目录下的 `node-signing.key` |
| `BATON_TLS_CERT_FILE` / `BATON_TLS_KEY_FILE` | 中心 | 直接提供 HTTPS/WSS 时的证书与私钥 |
| `BATON_WEB_DIR` | 中心 | 网页目录，默认 bundle 旁的 `web/` |
| `BATON_SESSION_TTL` | 中心 | 浏览器会话期限，默认 `12h`，范围 5 分钟至 7 天 |
| `BATON_ENROLLMENT_TTL` | 中心 | 一次性注册凭据期限，默认 `10m`，范围 1 分钟至 24 小时 |
| `BATON_NODE_CREDENTIAL_TTL` | 中心 | 节点凭据期限，默认 `720h`，范围 1 小时至 90 天 |
| `BATON_HEARTBEAT_INTERVAL` | 中心 | 连接检查间隔，默认 `10s`，范围 100 ms 至 2 分钟 |
| `BATON_OFFLINE_AFTER` | 中心 | 设备离线期限，默认 `30s`，须大于心跳间隔 |
| `BATON_ENROLLMENT_TOKEN` | 节点注册 | 一次性注册凭据，也可用 `--enrollment-file` |
| `BATON_PROJECT_RUNTIME_DATA_DIR` | 节点 / Runtime | 模型凭据目录，默认 `~/.baton/project-runtime` |

控制操作预算、临时 RPC 名额和 OTLP 追踪配置见 [中心文档](apps/server/README.md)。

## 本地开发与测试

开发入口与 bundle 使用相同的 CLI 命令：

```sh
pnpm --filter @baton/server dev help
pnpm --filter @baton/batond dev help
pnpm --filter @baton/batond dev probe
```

工作区使用 Vite+ 1.4，根 `vite.config.ts` 统一配置 Oxlint、Oxfmt 与 TypeScript Go 检查，各包保留自己的编译检查。Node 与 pnpm 由本机环境提供，无需全局安装 `vp`。

```sh
pnpm check
pnpm typecheck
pnpm test
node --test tools/build.test.mjs
```

`pnpm test` 按依赖顺序串行执行，包含上游包和 [`e2e`](e2e/README.md)，数据库与进程测试不缓存。测试会构建 Runtime，须与统一构建分开执行，避免争用产物目录。适配器、跨 app 与 Runtime 验证使用离线转录和本地模型替身，不需要真实模型凭据。

数据库测试使用本机 PostgreSQL，每个夹具创建和清理独立 schema。默认测试库为 `postgres://postgres:baton@127.0.0.1:5432/baton_test?sslmode=disable`，未启动时尝试通过 `pg_ctl` 拉起 `~/.baton-postgres`；可用 `BATON_TEST_DATABASE_URL` 覆盖。

Project Runtime 与网页可单独验证：

```sh
pnpm --dir runtimes/project-agent test
pnpm --dir web format:check
pnpm --dir web lint
pnpm --dir web typecheck
pnpm --dir web test
pnpm --dir web build
```

网页开发使用 `pnpm --dir web dev`，默认连接真实后端，可用 `BATON_DEV_BACKEND` 配置代理。显式添加 `?mock=1` 或 `?scenario=<id>` 启用模拟场景。网页普通构建输出到 `apps/server/dist/web`；中心 `build` 和 `dev` 自动包含网页构建。

## 规格与设计文档

- 界面设计与流程：[design/README.md](design/README.md)
- 全局规格：[PRODUCT](specs/baton/PRODUCT.md)、[TECH](specs/baton/TECH.md)
- Agent 适配：[PRODUCT](specs/agent-adapters/PRODUCT.md)、[TECH](specs/agent-adapters/TECH.md)
- Project Agent：[PRODUCT](specs/project-agent/PRODUCT.md)、[TECH](specs/project-agent/TECH.md)
- Agent Inbox：[PRODUCT](specs/agent-inbox/PRODUCT.md)、[TECH](specs/agent-inbox/TECH.md)
- 上游转录与回放：[TECH](specs/agent-replay/TECH.md)
- TypeScript 架构、打包与验证：[TECH](specs/ts-migration/TECH.md)
