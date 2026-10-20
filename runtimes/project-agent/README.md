# Project Agent Runtime

`baton-project-runtime` 使用 pi-agent-core 和 pi-ai 1.3.0，在 Coordinator 保存的主对话上运行。生产工具由 Coordinator 执行并提交结果；Runtime 提供固定工具定义、顺序调用、模型重试、写入屏障、自动上下文压缩和恢复。

## 安装与登录

使用随 batond 分发的固定版本 Node bundle，构建和进程约定见 [Node sidecar 约定](../README.md)。在解压后的安装目录运行：

```sh
node sidecars/project-agent/dist/project-agent/src/cli.js --version
node sidecars/project-agent/dist/project-agent/src/cli.js login openai-codex
node sidecars/project-agent/dist/project-agent/src/cli.js probe
```

支持 `openai-codex` 和 `xai` 的 OAuth 登录。凭据默认保存在用户主目录下的 `.baton/project-runtime`；可用 `BATON_PROJECT_RUNTIME_DATA_DIR` 指定 Runtime 专用的私有目录。`probe` 只检查本地凭据状态，不刷新 token，不请求模型，不输出 token。过期但带有刷新凭据的订阅会在下一次真实请求时刷新。

batond 检查版本 `0.1.0`、登录状态和租约后，在空控制目录启动 `run`。正常安装使用 stdio；独立运行也支持 TECH 规定的本地 IPC 环境变量。Runtime 从不加载项目目录中的 AGENTS.md、skills、扩展或 MCP。

## 模型请求与持久化

`prompt_version=1` 选择固定的角色提示词，标题和目标来自当前对话的提示词快照。快照随 assistant 的 `pi-ai/1` payload 一起保存；恢复时复用最早保留的快照。生成压缩摘要并写入新快照时才采用新的标题和目标；只清理工具结果时沿用原快照。未知版本拒绝运行。

每次模型请求都根据 Coordinator 的事件重建历史，保留 provider 的签名、reasoning 和扩展字段，递归排序对象键。`sessionId` 为主对话 ID，`maxTokens=32000`，关闭 provider 内部重试。错误或超过 160 KiB 的回复不保存，分别等待 5、15、45 秒重试，仍失败时调用 `report_failure`。

assistant 的 `message_end` 监听器先等待 `append_event` 提交，再按消息内的顺序发出 `call_tool`。每个工具结果由 Coordinator 保存；后续模型请求使用中心保存的结果。Runtime 的工具执行模式为 `sequential`。恢复时读取已有结果，只为缺少结果的工具调用发送原 ID；最后一条非压缩事件为 input 或 tool_result 时调用 `continue()`，为无工具 assistant 时领取下一批输入；压缩事件不改变未完成轮次的恢复位置。

闲置 180 秒，或运行满 15 分钟并处理完当前轮次后，先检查是否需要压缩，再调用 `finish`。收尾只释放 Project Agent 租约，已派出的 Task 继续执行。

## 上下文压缩

每次模型请求前超过窗口的 80%、运行收尾超过 50% 时触发，还会为模型输出预留容量。先把较早、已被后续 assistant 分析的大工具结果替换为带原始序号的读取提示，保护最近三批输入及尚未分析的结果；降到窗口的 40% 以下即可结束，无需调用摘要模型。

仍需缩减时，优先保留最近两批输入对应的对话及窗口 15% 的最近内容。长单轮可以在完整工具批次之间切分。摘要请求重放原系统提示词、工具声明、provider 签名和待压缩消息前缀，沿用对话 `sessionId`，最后追加协调角色的摘要指令并禁止工具调用。摘要保留用户要求、任务 ID、设备、状态、决定和未完成事项。缓存能否命中取决于模型服务。

空白、截断、工具调用、超限或没有缩短上下文的摘要不会提交。Coordinator 校验租约、历史序号、工具配对和范围，在同一事务里保存压缩事件并更新读取起点。回执丢失后重发同一事件标识；历史或配置变化时丢弃旧摘要，重新读取。生成失败按 5、15、45 秒重试，仍失败时报告模型请求失败。普通模型请求明确超限后，可在有效缩减上下文后重试一次。

压缩结果只改变发给模型的视图，原始历史完整保留，可以通过 `history.search/read` 找回。默认预算位于 `src/compaction.ts`，宿主可用 `ProjectRuntime` 第四个构造参数覆盖，CLI 使用默认值。

## 验收证据

```sh
pnpm --dir runtimes/project-agent test
node tools/package-batond.mjs
```

测试包括请求前与收尾压缩、旧工具结果保护、前缀与签名复用、超限恢复、重复压缩、提交冲突与丢失回执、无效摘要拒绝、结尾表四种情况、部分工具已有结果、真实子进程在保存和工具事务前后被杀、失败屏障禁止工具执行、模型失败与超限输出、虚拟时钟下的 180 秒与 15 分钟边界、OAuth 文件权限与锁、无网络 probe。跨系统请求测试用超过 1 MiB 的历史验证分页和 provider 扩展字段的保留；CI 上传三个系统的请求文件并逐字节比较。

faux 恢复测试的 Coordinator 替身负责持久化和事务去重。真实 Node Runtime、batond、Gateway、Coordinator 与 PostgreSQL 的连接由以下集成测试覆盖，需先设置项目约定的 `BATON_TEST_DATABASE_URL`：

```sh
BATON_TEST_NODE_PROJECT_RUNTIME=1 go test -v -count=1 ./internal/gateway -run '^TestProjectRuntimePiFauxRealCoordinator$'
```

该测试通过实际 Runtime 保存 assistant、调用 `memory.write`，用长回复触发收尾摘要，检查工具结果、记忆、压缩事件与读取起点在 Coordinator 保存，原始消息保留，运行正常结束。PS-157 的事务故障注入测试继续验证服务端去重。真实订阅及三设备端到端场景由 PA-W08 验证。
