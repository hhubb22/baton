# Project Agent Runtime

`baton-project-runtime` 使用 pi-agent-core 和 pi-ai 1.3.0，在 Coordinator 保存的主对话上运行。生产工具由 Coordinator 执行并提交结果；Runtime 提供固定工具定义、顺序调用、模型重试、写入屏障和恢复。

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

`prompt_version=1` 选择固定的角色提示词，标题和目标来自当前对话的提示词快照。快照随 assistant 的 `pi-ai/1` payload 一起保存；恢复时复用最早保留的快照。后续压缩写入新快照时才采用新的标题和目标。未知版本拒绝运行。

每次模型请求都根据 Coordinator 的事件重建历史，保留 provider 的签名、reasoning 和扩展字段，递归排序对象键。`sessionId` 为主对话 ID，`maxTokens=32000`，关闭 provider 内部重试。错误或超过 160 KiB 的回复不保存，分别等待 5、15、45 秒重试，仍失败时调用 `report_failure`。

assistant 的 `message_end` 监听器先等待 `append_event` 提交，再按消息内的顺序发出 `call_tool`。每个工具结果由 Coordinator 保存；后续模型请求使用中心保存的结果。Runtime 的工具执行模式为 `sequential`。恢复时读取已有结果，只为缺少结果的工具调用发送原 ID；对话结尾为 input 或 tool_result 时调用 `continue()`，结尾为无工具 assistant 或 compaction 时领取下一批输入。

闲置 180 秒后调用 `finish`。运行满 15 分钟时处理完当前输入触发的整轮回复和工具调用，再调用 `finish`。收尾只释放 Project Agent 租约，已派出的 Task 继续执行。收尾时上下文超过 50%、请求前超过 80% 时压缩。先把三轮以前的工具结果替换为带原序号的占位；仍达到 40% 时，把较早对话生成摘要，保留最近两轮和至少 15% 窗口。阈值和轮数是常量。摘要沿用正常请求的模型、系统提示词、工具定义与消息前缀，追加压缩指令，设置 `toolChoice: "none"`。通过 `append_compaction` 保存后才切换视图；原始事件可由 `history.read/search` 读取。

## 验收证据

```sh
pnpm --dir runtimes/project-agent test
node tools/package-batond.mjs
```

测试包括结尾表四种情况、部分工具已有结果、真实子进程在保存和工具事务前后被杀、失败屏障禁止工具执行、模型失败与超限输出、虚拟时钟下的 180 秒与 15 分钟边界、OAuth 文件权限与锁、无网络 probe。跨系统请求测试用超过 1 MiB 的历史验证分页和 provider 扩展字段的保留；CI 上传三个系统的请求文件并逐字节比较。

faux 恢复测试的 Coordinator 替身负责持久化和事务去重。真实 Node Runtime、batond、Gateway、Coordinator 与 PostgreSQL 的连接由以下集成测试覆盖，需先设置项目约定的 `BATON_TEST_DATABASE_URL`：

```sh
BATON_TEST_NODE_PROJECT_RUNTIME=1 go test -v -count=1 ./internal/gateway -run 'TestProjectRuntimePiFauxRealCoordinator|TestProjectCompactionRealProcesses'
```

这些测试通过实际 Runtime 验证 assistant 保存、工具事务和正常收尾。压缩进程测试使用八轮约 400 KiB 的历史和接近 32 KiB 的工具结果，检查摘要与只读原文恢复。压缩提交前后的子进程故障注入和 14 类工具输出的恢复另由 Runtime 与 Store 测试覆盖。三设备端到端场景由 PA-W08 验证。
