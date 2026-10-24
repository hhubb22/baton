# Baton — Agent Guide

Baton 是跨设备 AI Agent 协同系统，由中心服务（`baton-server`）、节点守护进程（`batond`）、本地会话执行器（Session Worker）、Project Agent Runtime（`runtimes/project-agent`）和 Web UI（`web/`）组成。Go 的 `cmd/baton-server`、`cmd/batond`、根构建脚本与 Docker 镜像仍是发布入口，发布切换在 TypeScript 迁移 T5 进行；`apps/server` 与 `apps/batond` 提供独立的 Cursor 远程 Thread、Project 与设备管理开发入口。

## 核心架构与目录

| 目录 / 模块                                   | 职责                                                                                                                                                                   |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cmd/baton-server`                            | 中心控制面：员工认证、Project 与 Thread 调度、内置 Gateway（`/v1/node` 与 `/api/v1/events`）、嵌入式 Web UI                                                            |
| `cmd/batond`                                  | 节点守护进程：节点注册、出站 TLS WebSocket 连接、本地 SQLite 账本（`node.db`）、Session Worker 与 Project Runtime 管理                                                 |
| `internal/session`                            | Session Worker 生命周期、本地认证 IPC、Thread 消息队列与 Turn 账本                                                                                                     |
| `internal/agent/{pi,codex,kiro,shell,replay}` | 统一 `agent.Adapter` 接口实现（Pi RPC、Codex app-server、Kiro ACP V3）与确定性录制回放                                                                                 |
| `apps/server` | TypeScript 开发中心：账号、设备、Cursor 远程 Thread、Project 租约调度、主对话、事项和记忆、持久命令与回复、Gateway 和实时输出；见 `apps/server/README.md` |
| `apps/batond` | TypeScript 节点与本地 Thread：注册和 WSS、认证 IPC、持久 Worker、Cursor SDK host、受限 shell、Project Runtime 宿主、目录和订阅管理；见 `apps/batond/README.md` |
| `e2e` | 中心、节点与独立 Worker 的跨 app 集成测试，显式依赖两个 app；见 `e2e/README.md` |
| `packages/telemetry`                          | Effect 原生 OTLP/HTTP 追踪、标准上下文传播与导出字段过滤，默认不连接采集端                                                                                             |
| `packages/{protocol,sqlite}`                  | TypeScript 协议 Schema 与 WAL/FULL SQLite 客户端、提交结果核查                                                                                                         |
| `vendor/t3code`                               | Baton 的 t3code fork submodule，固定提交；workspace 收录用到的 `@t3tools/*` 包与 `effect-acp`、`effect-codex-app-server`                                                |
| `packages/{providers,provider-testing}`       | 从固定 t3code 提交复用的 Cursor SDK/runtime、上游测试和确定性回放；完整 provider 包在 fork 中，本目录保留到接入宿主层时替换                                              |
| `runtimes/project-agent`                      | 基于 Node.js / TypeScript 的 Project Agent 进程（通过 stdio JSON-RPC 与 `batond` 通信）                                                                                |
| `web`                                         | React + TypeScript + Vite 前端，默认构建到 `internal/webui/dist` 供 Go 嵌入；TS 中心使用 `apps/server/dist/web`，产物不提交 Git；界面文案遵循 `design/WRITING.md`      |
| `design`                                      | Web UI 的 Elyx 设计稿（`.elyx`）与界面文案规范（`design/WRITING.md`），前端按它实现；修改前先读 `design/AGENTS.md`                                                     |
| `specs/`                                      | 持久产品规格（`PRODUCT.md`）与技术设计（`TECH.md`）                                                                                                                    |

## 常用构建与验证命令

- **构建与静态检查**（首次检出或修改前端后先构建；脚本安装前端和 Runtime 依赖、生成静态文件，编译 `baton-server`、`batond` 到 `bin/`，并打包 Project Runtime 到 `bin/sidecars/project-agent/`）：
  ```sh
  node --test tools/*.test.mjs
  node tools/build.mjs
  node tools/check-sidecar-package.mjs
  go vet ./...
  ```
- **TypeScript workspace**（Node 26、pnpm 12、Vite+ 1.4；`vendor/t3code` 是 git submodule，首次检出先运行 `git submodule update --init`。适配器验证使用离线转录与本地替身。TS 构建和测试可独立于 Go 构建运行，配置与入口见 [中心文档](apps/server/README.md) 和 [节点文档](apps/batond/README.md)）：
  ```sh
  git submodule update --init
  pnpm install --frozen-lockfile --ignore-scripts
  pnpm check
  pnpm typecheck
  pnpm test
  pnpm --filter @baton/server build
  pnpm --filter @baton/batond build
  ```
  `@baton/server` 的 `build` 和 `dev` 自动将网页构建到 bundle 旁的 `web/`，默认无需单独构建前端。TS 中心测试使用本机 PostgreSQL，默认测试库、自动启动和 `BATON_TEST_DATABASE_URL` 与下述 Go 测试相同；各夹具使用独立 schema。仅验证远程开发链路时可运行：
  ```sh
  pnpm --filter @baton/server --filter @baton/batond typecheck
  pnpm --filter @baton/server --filter @baton/batond lint
  pnpm --filter @baton/batond test
  pnpm test:e2e
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

## Effect 与开发工具

包内复用的测试辅助代码放在 `src/testing/`，静态数据放在其中的 `data/`；只供单个测试文件使用的小函数留在该文件内。跨 app 测试放在 `e2e/`，通过声明的 workspace 依赖与包导出访问源码。中心的 PostgreSQL 测试使用 `*.integration.test.ts`，根 Vitest 配置按文件名分为 `unit` 和 `integration`，两个 app 支持 `test:unit` 与 `test:integration`。`pnpm test` 包含全部组及 e2e；按包筛选受影响测试时用 `pnpm --filter '...@baton/batond' --workspace-concurrency=1 test` 包含依赖该包的 e2e。

工作区通过根目录 `vite.config.ts` 配置 Vite+ 的 Oxlint、Oxfmt 与类型检查，采用推荐规则。`pnpm lint` 和 `pnpm check` 将警告视为失败；`pnpm check` 统一执行格式、lint 和 TypeScript Go 检查，`pnpm typecheck` 保留各包编译器检查；`pnpm test` 按依赖顺序串行执行各包的测试，数据库与进程集成测试不缓存。网页使用 Vite+，发布打包继续使用现有 esbuild 与 Go 脚本。

本仓库使用 Effect TypeScript。编写 Effect 代码前，完整阅读 `node_modules/effect/AGENTS.md`，按需阅读其中引用的示例；未覆盖的 API 查阅 `node_modules/effect/src` 中的固定版本源码。

## 部署与设备接入

以下二进制与容器命令使用 Go 发布入口。TS 开发中心使用 `pnpm --filter @baton/server dev` 运行账号管理、迁移和 `serve`，节点使用 `pnpm --filter @baton/batond dev <命令>` 运行 `up`、`register` 或 `run`；本机 HTTPS、CA 与 `--workspace` 配置见 [开发接入说明](apps/server/README.md#设备接入与远程-thread)。TS 已提供 Project、事项、记忆、目录增删、设备执行授权、附件文本预览及订阅登录；其他 Agent 与统一历史的范围和实际响应见 [能力表](apps/server/README.md#当前能力范围)。Project Runtime 从源码与已安装依赖启动，完整安装包仍归 T5。

- `baton-server serve` 自动执行数据库迁移，再检查迁移状态；签名密钥默认使用工作目录下的 `node-signing.key`，不存在时生成 `0600` 文件，也可用 `BATON_NODE_SIGNING_KEY` 指定。已有密钥的权限、类型和内容仍须通过校验。
- `Dockerfile` 构建内嵌 Web UI 的服务端镜像，使用非 root 用户运行。`compose.yaml` 编排 PostgreSQL 16 与 `baton-server`，数据库及 `/var/lib/baton` 分别持久化；需配置 `BATON_POSTGRES_PASSWORD` 和 `BATON_ALLOWED_ORIGINS`，默认通过本机端口交给 HTTPS 反向代理。
- `BATON_ENROLLMENT_TOKEN='...' ./bin/batond up --coordinator https://baton.example` 首次注册并运行，已有身份时直接复用；注册凭据也可来自 `--enrollment-file`。显示名默认主机名，系统自动推导。首次启动且尚无 `browse-roots.json` 时默认开放当前用户主目录，已有配置（含空列表）保留；可选 `--workspace /绝对路径` 在连接前幂等登记指定目录。
- 网页 Devices 的在线设备详情支持添加、移除允许访问的目录，并以设备码登录 ChatGPT / xAI 订阅；选目录弹窗也可直接输入设备路径并添加。凭据保存在设备本地，登录进程退出后立即刷新订阅报告。
- `batond register --coordinator https://主机` 将中心地址保存为身份文件的 `coordinator_url`；`batond run` 据此推导 WSS 地址，`--relay` 可显式指定。身份文件不含中心地址时需要 `--relay`。各命令使用相同的 `--data-dir`。

## 开发与演进约束（防熵增守则）

1. **零外部服务与云环境依赖**：全部开发与自动化测试均在本地闭环完成，不依赖云端开发环境（Devin / Cursor Cloud）、1Password CLI（`op`）或外部在线服务。严禁新增任何需要真实 API Key、调用在线模型推理或与外部真实服务联调的自动化测试与验证脚本，包括仅显式运行的门控脚本。所有适配器行为验证必须仅依赖本地静态录制、确定性回放与本地替身完成闭环；新增场景使用已有离线转录或注明来源的派生夹具，不得把在线补录或实机核查证据作为开发、验收或发布前提。
2. **禁止在生产代码中埋入测试环境变量钩子**：除 `BATON_TEST_DATABASE_URL` 外，不要在业务代码中新增 `os.Getenv("BATON_TEST_*")` 分支；故障注入应通过 Go 接口、依赖注入或测试替身完成。
3. **测试金字塔**：按下节原则判断是否需要补测。纯逻辑、并发竞争与存储不变量优先使用包内单元测试或确定性回放，多进程与浏览器 E2E 只覆盖必须跨进程验证的核心行为。
4. **文档只写当前状态，不写工单流水账**：更新 `README.md`、`PRODUCT.md`、`TECH.md` 时，直接原地修改对应章节以反映最新架构与行为，**严禁**追加「当前已实现 PS-xxx...」或「2026-xx-xx 修订」之类的工单历史段落。
5. **实验室阶段统一当前结构**：产品正式发布并确定版本号前，不维护旧开发版本的数据库、设备账本、结果格式或摘要兼容分支；结构变化可重建本地数据。保留协议版本、未知字段容忍和可选能力声明等扩展机制，正式发布后再为支持的版本组合提供兼容和升级路径。

## 测试与验证取舍

- 复用上游模块时，优先沿用原实现、原测试和转录，只为 Baton 的适配差异与新增关键行为补少量测试。上游已覆盖的行为直接复用其验证。
- 测试验证可观察行为和持久事实，合并重复场景，减少函数调用、对象引用和参数排列等实现细节断言。简单、可逆、低影响的改动可只做相关静态检查。
- 实验阶段先用离线转录与本地替身跑通主链路，普通边界问题随实际发现修复，再补最小回归。故障注入、本地跨平台检查和性能基准按具体需要安排；存在明确的数据丢失、越权或重复副作用风险时，保留能验证该风险的最小测试。
- 验证按改动影响范围选择。局部测试或文档精简运行受影响包的测试与相关检查；共享协议、构建发布或跨模块行为变化时再扩大范围。适配器验收统一使用离线转录、确定性回放和本地替身；打包、SQLite、IPC 与进程回收检查在本地运行且不得调用外部真实服务。
