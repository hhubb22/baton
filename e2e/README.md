# 跨 app 集成测试

`@baton/e2e` 通过声明的 workspace 依赖启动 TypeScript 中心、节点和本地 Worker，验证远程 Thread、Project、数据库中断恢复及 Gateway 报告流控。模型行为使用上游静态转录、确定性回放和本地替身，不调用在线模型。

`src/provider-agents.integration.test.ts` 通过网页使用的 HTTP API 创建 Thread、接收回复、停止、恢复原生会话并再次发送，覆盖 Cursor、Pi、Codex、Kiro 的独立 Worker 与真实 provider host。`src/testing/provider-replay-worker.ts` 复用生产 Worker 的 Agent factory，只按本地原生状态文件选择首次或恢复转录。Cursor 使用 `apps/batond/src/testing/cursor/replay-host.ts` 与上游 `provider-cursor/src/testing/fixtures/provider_thread_resume.ndjson`，保留录制的会话 ID 和消息，沿用节点包的 sandbox 与 runtime instructions 转换，再按 host 生命周期拆为两段。其他 provider 复用节点包导出的转录辅助模块；数据来源与适配边界见[回放测试设计](../specs/agent-replay/TECH.md)。

`src/remote.integration.test.ts` 与 `src/project.integration.test.ts` 使用 `src/testing/replay-worker.ts` 的本地 ThreadAgent 替身，分别验证重连、命令与报告去重、追踪，以及 Project Runtime 的协调行为。Project 的记忆整体流程使用 Runtime 包中的 `test/memory-flow-worker.ts` 固定模型和本地 Embedding HTTP 端点，经过实际中心、WSS、设备与独立 Runtime，验证最终回复后的后台整理、向量生成、后续召回，以及停用后新进程恢复时旧摘要与工具正文退出注入；原始事件保持保存。该替身的 probe 只返回固定能力报告，模型 SDK 与 Runtime 在 run/memory 分支加载，避免周期探测与实际运行争抢源码加载资源。用例先等待节点报告记忆能力，再分别等待前台回复和后台记忆落库；异步阶段各最多 30 秒，整例最多 120 秒。该流程已在 macOS 和本地受限 CPU 的 Linux 容器中重复验证；SEA、Windows、真实模型质量与并发竞争专项未验证。

`src/upgrade.integration.test.ts` 使用候选包、现有存储基线、实际中心/WSS/daemon 与独立 replay Worker，验证 prepare → ready → migrate → 重启 → completed 后 Project、记忆、Thread 和原标识保留，排队输入只发送一次；未 ACK 报告补报由 batond 包内测试覆盖。

依赖准备、测试、类型检查与 lint 命令统一见 [AGENTS.md](../AGENTS.md#常用构建与验证命令)，部署见 [根 README](../README.md)。根 workspace 测试按依赖顺序包含本包；按改动包筛选时需包含依赖它的 e2e。

数据库使用中心的 `testing/database` 夹具，为每个用例创建和清理独立 schema。本地连接配置与自动启动规则见 [AGENTS.md](../AGENTS.md#常用构建与验证命令)。

辅助代码放在 `src/testing/`，跨包源码通过各包的明确导出访问。包内测试继续保留在对应 app；静态转录与数据放入辅助目录中的 `data/`，可执行的 TS、MJS 辅助程序参加 lint 和格式检查。测试使用 package.json 脚本，Vite Task 默认不缓存脚本结果。
