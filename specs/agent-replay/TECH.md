# Agent 适配器离线回放测试

Status: approved
Owner: Baton
Basis: [Agent 适配 TECH](../agent-adapters/TECH.md#验证策略)、[Baton TECH](../baton/TECH.md#验证)、[t3code 来源与许可](../../third_party/t3code/README.md)。

## 数据与执行边界

Cursor、Pi、Codex、Kiro 的协议行为复用 `upstream/t3code` 中的完整 provider adapter、离线测试、回放工具与静态转录。Baton 的测试辅助程序将原生 CLI、SDK 或 app-server client 替换为上游 replay 实现，保留真实 adapter、agent-host 事件映射与 Worker。自动化测试不要求真实 API Key、不运行真实 Agent 推理、不访问外部模型服务。

| Agent | 转录来源（相对 `upstream/t3code`） | 回放入口 |
|---|---|---|
| Cursor | `packages/provider-cursor/src/testing/fixtures/*.ndjson` | `@t3tools/provider-cursor/testing` 的 `layerCursorAgentSdkReplay` |
| Pi | `apps/server/src/orchestration-v2/testkit/fixtures/*/pi_transcript.ndjson` | `@t3tools/provider-pi/testing` 的 `layerPiReplaySpawner` |
| Codex | 同一 testkit 的 `*/codex_transcript.ndjson` | `effect-codex-app-server/replay` 的转录 Schema 与 `@t3tools/provider-codex/testing` 的 `layerCodexReplayClientFactory` |
| Kiro | `packages/provider-acp-registry/src/testing/fixtures/kiro/*.ndjson` | `@t3tools/provider-acp-registry/testing/replay` 的 `layerAcpReplaySpawner` |

Kiro 转录说明见 [fork README](../../upstream/t3code/packages/provider-acp-registry/src/testing/fixtures/kiro/README.md)，CI 直接读取 fork 中的夹具。

回放覆盖的版本与系统记录在转录和验证说明中。生产可用性由设备上的安装、认证和运行依赖检查决定；未覆盖的系统或版本照常开放，诊断写明范围。离线回放不能证明真实账号授权有效。

## Baton 测试辅助层

节点包的 `src/testing/{cursor,pi,codex,kiro}/transcripts.ts` 读取、校验和派生转录；相邻的 `replay-host.ts` 运行真实 Agent host。Pi 替换 spawner，Codex 替换 app-server client factory，Kiro 替换 ACP spawner，Cursor 替换 SDK service。辅助入口由测试注入，不在生产业务代码中读取测试专用环境变量。

转录按原生进程切段，首次执行和恢复可由不同 host 回放。工作目录通过上游 materialization 或测试绑定替换，Baton 的运行提示、Codex sandbox 策略等适配差异在辅助层明确处理。请求差异必须能从 Baton 当前配置或已声明的派生场景解释；上游响应保持其证据含义。

新增故障优先从已有转录派生，并在代码注释或 metadata 中注明来源与变换。例如 Kiro 的认证失败从 `provider_error` 派生，失败后继续执行的场景接上 `simple` 的成功回合；测试核对安全原因、输入 sent、后续回复、最终 idle 和原生会话保留。纯 Worker 调度与持久性场景使用可控本地 Agent 替身，进程回收使用本地协议进程及其后代。

## 验证层次

| 范围 | 当前入口 | 可观察行为 |
|---|---|---|
| 上游 provider | fork 中所用包的 `src/**/*.test.ts` | adapter、协议、取消、恢复与事件归一化 |
| Baton host | `apps/batond/src/agents/{cursor,pi,codex,kiro}/host.integration.test.ts` | 新建、多轮、停止、恢复、回复与终态映射、只读 `sent` 证据 |
| Worker | `apps/batond/src/worker/index.test.ts` | 持久回执、intent 不重发、控制代次、停止证据、回复与 outbox、失败后继续队列 |
| 进程所有权 | `apps/batond/src/agent-host/reclaim.integration.test.ts`、`src/agents/kiro/reclaim.integration.test.ts`、`src/platform/host-process-group.integration.test.ts` | 真实本地子孙进程、独立进程组登记、正常关闭及强杀后的回收 |
| 远程主链路 | `e2e/src/remote.integration.test.ts`、`provider-agents.integration.test.ts` | 中心、节点、独立 Worker，经网页 API 发送、回复、停止和恢复 |
| Project | `e2e/src/project.integration.test.ts` 与 Runtime 包测试 | 本地模型替身贯穿主对话、工具、Thread、记忆、租约与恢复 |

跨 app 测试通过声明的 workspace 导出使用节点转录辅助模块。`e2e/src/testing/provider-replay-worker.ts` 分派 Cursor、Pi、Codex、Kiro 的真实 Worker 与 provider host 回放。Cursor 使用上游 `provider_thread_resume.ndjson`，保留原生身份与消息，应用节点测试层的运行提示和 sandbox 转换，再按 host 生命周期切段。remote 与 Project 场景使用 `e2e/src/testing/replay-worker.ts` 的本地 ThreadAgent 替身，验证协调、存储与恢复，不经过 provider host。数据库中断、ACK 丢失、中心与节点重启使用真实本机 PostgreSQL、HTTP、WebSocket、SQLite 和 IPC。

回放负责验证协议与事件行为；进程回收、SQLite 提交、IPC 和安装包布局分别由本地进程、数据库与打包检查验证。Windows 的 PID／创建时间与 `taskkill` 边界、各系统未测项见 [适配设计](../agent-adapters/TECH.md#进程组与停止回收) 和 [发布验证](../release/TECH.md)。

## 运行与维护

依赖准备、静态检查和测试命令统一见 [AGENTS.md](../../AGENTS.md#常用构建与验证命令)。`pnpm test` 按依赖顺序包含所用 fork 包的上游测试；按影响范围选择 Worker、host、跨 app 或安装包验证。

升级 fork 时同时复核转录格式、请求形状与 adapter 行为。Baton 只为自己的宿主映射和可靠性保证补充最小回归；新增上游协议能力先在 fork 中维护。已有转录缺少所需场景时，先查上游工具和转录；确需新增录制时，保留来源、版本、脱敏规则和派生关系。真实订阅登录与模型调用只通过显式手动冒烟检查执行，结果与离线验证范围分别记录。
