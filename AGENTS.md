# Baton — Agent Guide

Baton 是跨设备 AI Agent 协同系统，由 TypeScript 中心服务（`apps/server`）、节点守护进程（`apps/batond`）、独立 Session Worker、Project Agent Runtime（`runtimes/project-agent`）和 Web UI（`web/`）组成。中心与节点使用 Node 26 和 Effect，Cursor、Pi、Codex、Kiro 通过 t3code fork 的完整 provider adapter 接入。

## 核心架构与目录

| 目录 / 模块 | 职责 |
|---|---|
| `apps/server` | 员工认证、设备、Thread、Project、事项和记忆，PostgreSQL 事务、持久命令与报告、Gateway（`/v1/node` 与 `/api/v1/events`）和网页静态服务；见 `apps/server/README.md` |
| `apps/batond` | 注册和 WSS、设备 SQLite 账本、认证 IPC、Worker 管理、Agent 探测、文件浏览、Project Runtime 宿主和订阅登录；见 `apps/batond/README.md` |
| `apps/desktop` | Electron 桌面客户端、接入链接与中心证书校验、受限网页桥接、batond 监管、托盘与登录启动；见 `apps/desktop/README.md` |
| `apps/batond/src/worker` | Thread 消息队列、命令回执、intent、Turn、回复、outbox 与恢复 |
| `apps/batond/src/agent-host`、`src/agents` | t3code provider 宿主、事件映射与受限 shell；四个 Agent 在程序或 SDK 已安装且认证未明确缺失时开放新建与恢复，版本和系统不设白名单 |
| `e2e` | 中心、节点、独立 Worker 与 Runtime 的跨 app 集成测试，显式依赖两个 app；见 `e2e/README.md` |
| `packages/telemetry` | Effect 原生 OTLP/HTTP 追踪、日志、指标与标准上下文传播，统一导出字段过滤，默认不连接外部采集端 |
| `packages/{protocol,sqlite}` | Effect 协议 Schema 与 TypeScript 类型，WAL/FULL SQLite 客户端和提交结果核查 |
| `upstream/t3code` | Baton 的 t3code fork submodule，固定提交；workspace 收录所需 `@t3tools/*` 包、`effect-acp` 和 `effect-codex-app-server` |
| `runtimes/project-agent` | Project Agent 的模型、工具、压缩与恢复，通过 stdio JSON-RPC 与 batond 通信 |
| `migrations` | 中心 PostgreSQL 的版本化 SQL 迁移，由 `apps/server/src/database.ts` 执行与核对 |
| `web` | React + TypeScript + StyleX + Vite 前端，默认构建到 `apps/server/dist/web`，产物不提交 Git；界面文案遵循 `web/WRITING.md` |
| `specs` | 持久产品规格（`PRODUCT.md`）与技术设计（`TECH.md`） |

## 常用构建与验证命令

工作区使用 Node 26、pnpm 12、Vite+ 1.4。首次检出先初始化 submodule，再从根 workspace 按锁文件安装依赖：

```sh
git submodule update --init
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm typecheck
pnpm test
```

统一构建与构建脚本验证：

```sh
node --test tools/*.test.mjs
node tools/build.mjs
node tools/check-package.mjs bin
```

统一构建从根 workspace 安装依赖，构建中心和节点 bundle，再调用 `tools/package-batond.mjs --out bin` 生成当前平台的 SEA 安装包。bundle 分别位于 `apps/server/dist` 和 `apps/batond/dist`；`bin/` 包含 `batond`（Windows 为 `batond.exe`）、旁置 `node_modules/`、许可和安装包清单。打包使用支持 `--build-sea` 且保留 LICENSE 的官方 Node 26，设备运行无需安装 Node。中心的 `build` 和 `dev` 自动构建网页并复制 SQL 迁移，生成 `server.cjs` 及相邻的 `web/`、`migrations/`。可分别运行：

```sh
pnpm --filter @baton/server build
pnpm --filter @baton/batond build
```

单独打包使用 `node tools/package-batond.mjs --out bin`，随后运行 `node tools/check-package.mjs bin`，在搬迁目录、空 PATH 和临时 HOME 下检查 Worker、Agent host、Project Runtime 和私有文件。bundle 与 SEA 安装包的布局、附带依赖和验证范围见 [发布设计](specs/release/TECH.md#打包与发布)。开发 bundle 的 Project Runtime 和 watchdog 从同一 bundle 的子命令启动；直接源码入口使用 Runtime 包的 tsx loader。发布构建在统一构建或单包构建时成对传入 `--version <版本> --commit <完整提交>`，默认身份为 `development`。

仅验证远程开发链路时：

```sh
pnpm --filter @baton/server --filter @baton/batond typecheck
pnpm --filter @baton/server --filter @baton/batond lint
pnpm --filter @baton/batond test
pnpm test:e2e
```

中心数据库测试使用装有 pgvector 的本机 PostgreSQL，默认连接 `postgres://postgres:baton@127.0.0.1:5432/baton_test?sslmode=disable`；未启动时尝试通过 `pg_ctl` 拉起 `~/.baton-postgres`，可用 `BATON_TEST_DATABASE_URL` 覆盖。各夹具创建和清理独立 schema，`search_path` 为夹具 schema 加 `public`，`vector` 扩展固定装在 `public`。

Project Agent Runtime 与网页验证：

```sh
pnpm --dir runtimes/project-agent test
pnpm --dir runtimes/project-agent typecheck
pnpm --dir web format:check
pnpm --dir web lint
pnpm --dir web typecheck
pnpm --dir web test
pnpm --dir web build
```

包内检查使用 `pnpm --filter <包名> typecheck`、`pnpm --filter <包名> lint` 和 `pnpm --filter <包名> test`。中心及其 e2e 使用 `pnpm --filter '...@baton/server' --workspace-concurrency=1 test`；两个 app 可将 `test` 换成 `test:unit` 或 `test:integration` 选择测试组。

桌面客户端构建、离线测试与打包：

```sh
pnpm --filter @baton/desktop build
pnpm --filter @baton/desktop typecheck
pnpm --filter @baton/desktop lint
pnpm --filter @baton/desktop test
node --test tools/package-desktop.test.mjs
node tools/package-desktop.mjs --batond bin --out apps/desktop/dist/installers
```

安装与自动化测试不下载或启动 Electron；显式打包才准备 Electron 运行时。桌面客户端只支持 macOS arm64 与 Windows x64，Windows 使用按用户安装的 NSIS。产物目录须放在输入 batond 安装目录之外。

## Effect 与开发工具

包内复用的测试辅助代码放在 `src/testing/`，静态数据放在其中的 `data/`；只供单个测试文件使用的小函数留在该文件内。跨 app 测试放在 `e2e/`，通过声明的 workspace 依赖与包导出访问源码。中心的 PostgreSQL 测试使用 `*.integration.test.ts`，根 Vitest 配置按文件名分为 `unit` 和 `integration`，两个 app 支持 `test:unit` 与 `test:integration`。`pnpm test` 包含全部组及 e2e；按包筛选受影响测试时用 `pnpm --filter '...@baton/batond' --workspace-concurrency=1 test` 包含依赖该包的 e2e。

工作区通过根目录 `vite.config.ts` 配置 Vite+ 的 Oxlint、Oxfmt 与类型检查，采用推荐规则。`pnpm lint` 和 `pnpm check` 将警告视为失败；`pnpm check` 统一执行格式、lint 和 TypeScript Go 检查，`pnpm typecheck` 保留各包编译器检查；`pnpm test` 按依赖顺序串行执行各包测试，数据库与进程集成测试不缓存。Project Runtime 测试使用根 Vitest 配置直接运行源码，包含 CLI 和恢复子进程，不写入或读取 Runtime 的 `dist/`，可与统一构建并行执行。网页使用 Vite+，Node bundle 使用 esbuild。

本仓库使用 Effect TypeScript。编写 Effect 代码前，完整阅读 `node_modules/effect/AGENTS.md`，按需阅读其中引用的示例；未覆盖的 API 查阅 `node_modules/effect/src` 中的固定版本源码。

## 文档入口

构建与部署、账号、设备接入和配置参考见 [README.md](README.md)。领域术语与代码命名见 [GLOSSARY.md](GLOSSARY.md)，系统架构见 [Baton TECH](specs/baton/TECH.md)，安装包布局与平台验证见 [发布设计](specs/release/TECH.md)。脚本参数见 [工具说明](tools/README.md)。

## 遥测排障

本地 ClickStack 单容器示例将界面映射到 8088，避免占用 Baton 中心的 8080；容器也监听 OTLP HTTP 4318 和 gRPC 4317：

```sh
docker run --rm --name baton-clickstack -p 127.0.0.1:8088:8080 -p 127.0.0.1:4318:4318 -p 127.0.0.1:4317:4317 clickhouse/clickstack-all-in-one:latest
```

此示例移除容器时不保留数据；长期部署的持久化和网络配置按官方文档设置。

在 ClickStack Team Settings → API Keys 取得 ingestion key，在中心设置 `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318` 和 `OTEL_EXPORTER_OTLP_HEADERS=authorization=<ingestion-key>`。节点通过已认证的 WSS 转发，网页发送到中心同源接口；地址和 key 不下发。中心设置 `BATON_TELEMETRY_FORWARD=off` 可关闭转发，`BATON_WEB_SESSION_REPLAY=masked` 可开启遮挡回放。单机排查可在设备本地设置 `OTEL_EXPORTER_OTLP_*` 直连。参数与权限见[部署文档](https://clickhouse.com/docs/clickstack/deployment/all-in-one)和[collector 文档](https://clickhouse.com/docs/clickstack/ingesting-data/collector)。

ClickStack MCP 的 Personal API Access Key 与 ingestion key 分开。在当前 shell 中提供 `CLICKSTACK_PERSONAL_API_KEY` 后，可配置 Codex：

```sh
codex mcp add clickstack --url http://127.0.0.1:8088/api/mcp --bearer-token-env-var CLICKSTACK_PERSONAL_API_KEY
```

该端点使用 Streamable HTTP 和 Bearer 认证，见 [ClickStack MCP](https://clickhouse.com/docs/clickstack/mcp)。先查 source 与列结构；默认 Map 表结构可用 `TraceId = '<trace id>'` 找完整链路，或用 `SpanAttributes['baton.thread.id'] = '<thread id>'` 找 Thread，再按 `baton.error.code`、版本和等待原因检查相关记录。JSON 列结构按实际 source 调整表达式。复制诊断信息只包含标识、错误码和版本，不能替代业务权限检查。未结束 span 和硬终止进程不会导出；等待日志、队列和账本指标可辅助排查。查询与仪表盘见[可观测性设计](specs/observability/TECH.md)和 [ClickStack 模板](tools/observability/README.md)。

## 开发与演进约束（防熵增守则）

1. 零外部服务与云环境依赖：全部开发与自动化测试均在本地完成，不依赖云端开发环境（Devin / Cursor Cloud）、1Password CLI（`op`）或外部在线服务。自动化测试和 CI 不使用真实 API Key、不调用在线模型推理、不与外部真实服务联调；适配器行为用上游离线转录、确定性回放与本地替身验证，新增派生夹具注明来源。需要确认真实环境时，可以写只在手动显式运行时执行的冒烟脚本，它不进 CI，也不作为合入前提。
2. 禁止在生产代码中埋入测试环境变量钩子：除 `BATON_TEST_DATABASE_URL` 外，不要在业务代码中新增读取 `BATON_TEST_*` 的 `process.env` 分支；故障注入通过 Effect Layer、依赖注入或测试替身完成。
3. 测试金字塔：按下节原则判断是否需要补测。纯逻辑、并发竞争与存储不变量优先使用包内单元测试或确定性回放，多进程与浏览器 E2E 只覆盖必须跨进程验证的核心行为。
4. 文档只写当前状态，不写工单流水账：更新 `README.md`、`PRODUCT.md`、`TECH.md` 时，原地修改对应章节以反映最新架构与行为，严禁追加工单或日期历史段落。
5. 实验室阶段统一当前结构：产品正式发布并确定版本号前，不维护旧开发版本的数据库、设备账本、结果格式或摘要兼容分支；结构变化可重建本地数据。保留协议版本、未知字段容忍和可选能力声明等扩展机制，正式发布后再为支持的版本组合提供兼容和升级路径。
6. 淘汰式迁移直接废弃旧资产：替换旧实现或接入新上游库（如 upstream/t3code）时，旧模块的代码、离线录制和测试集直接废弃，严禁作为新实现的验收依据或行为参照；新实现通过上游原有测试和当前任务规定的最小端到端用例。Kiro 夹具说明见 [fork README](upstream/t3code/packages/provider-acp-registry/src/testing/fixtures/kiro/README.md)。
7. 工作流与配置命令联动校验：修改 `.github/workflows/` 中的构建或测试命令前，必须先在对应模块的 `package.json` 或构建脚本中核对该命令实际存在，禁止凭推测写入未定义的脚本命令。
8. 界面设计保持克制：设计系统仅关注排版层级、信息密度、颜色系统与基础交互。严禁在界面设计和概念探讨中引入具象叙事性插画与文学隐喻。
9. 默认实用，能力以上游为准：Agent 的可用性和能力按上游 adapter 与 driver 的检查和报告开放，不另设平台或版本白名单，也不把拿不准的能力报成不支持。缺少验证证据的组合照样开放，在诊断中写明验证范围，出问题再修。确定的失败按失败处理，不升级成 unknown 锁住后续流程。只有存在数据丢失、越权或重复副作用的明确风险时才收紧。

## 测试与验证取舍

- 复用上游模块时，优先沿用原实现、原测试和转录，只为 Baton 的适配差异与新增关键行为补少量测试。
- 测试验证可观察行为和持久事实，合并重复场景，减少函数调用、对象引用和参数排列等实现细节断言。简单、可逆、低影响的改动可只做相关静态检查。
- 实验阶段先用离线转录与本地替身跑通主链路，普通边界问题随实际发现修复，再补最小回归。故障注入、本地跨平台检查和性能基准按具体需要安排；存在明确的数据丢失、越权或重复副作用风险时，保留能验证该风险的最小测试。
- 验证按改动影响范围选择。局部测试或文档精简运行受影响包的测试与相关检查；共享协议、构建发布或跨模块行为变化时再扩大范围。打包、SQLite、IPC 与进程回收检查在本地运行，不调用外部真实服务。
