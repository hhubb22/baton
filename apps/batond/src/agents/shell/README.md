# Shell Thread

Shell 只用于 Project 的 `nodes.exec`。中心验证工具调用来源，Worker open 配置携带 `project_id`、`origin_conversation_id`、`origin_tool_call_id`，设备和 Worker 都要求三项齐全。员工创建和 `threads.create` 工具的 shell 禁令由中心准入执行。

`makeShellAgentFactory({dataDirectory,watchdog,records})` 接入与其他 Agent 相同的 ThreadAgent 和 Worker。`dataDirectory` 由本机 Worker 启动参数注入；远端的 shell、目录权限和命令执行开关不能代替本地配置。打开和实际发送前都重新读取 `devices/config.ts` 的 `readProjectExec`，并用 `daemon/roots.ts` 解析真实目录、检查授权根。shell 路径使用本机 `project-exec.json`，命令以设备运行用户的权限执行。

`execution_timeout_seconds` 由 Worker 的执行计时器处理，计入睡眠。`nodes.exec` 默认 7200 秒；可接受范围沿用现有 Thread 的 1～2147483647 秒。工具的 `wait_seconds` 与命令执行时限分别处理，等待结束不会停止命令。

每个 Thread 只接收一条命令。重复客户端消息 ID 返回原有执行事实，第二个消息 ID 和显式恢复请求被拒绝。POSIX 使用 `<shell> -lc <command>`，Windows 使用 `<shell> -NoProfile -Command <command>`。进程通过平台 `spawnOwnedProcess` 启动，立即绑定输出消费者，随后完成 watchdog 和持久 PID / 创建时间登记；取消及清理使用整棵进程树的回收证据。POSIX 回收覆盖所属进程组，Windows 沿用平台第一版的 taskkill 与持久进程记录限制。

原生映射绑定 Thread、节点、存储代次、工作目录、Project 来源及执行时限。发送准备绑定完整消息和控制代次，由 Worker 与 intent 一起落盘。`shell-submission.json` 在启动前保存，禁止再次启动；它只用于拒绝重复执行。`sent` 仅接受身份匹配的完成记录。

命令退出后有界等待输出管道，回收残余进程树，再原子保存私有 `output.json`，最后产生一条回复和结束事件。完成记录包含输入准备摘要、消息标识、执行标识、结果和进程树已停止事实。恢复从该记录补报原回复，Worker 按稳定回复 ID 去重；记录缺失、损坏、来源或输入不匹配时进入 `unknown`。执行后被取消的结果保留为副作用未知。未提交 intent 的队列可以从原有映射恢复发送，已提交的命令只读取证据。

stdout 和 stderr 合并保留开头、结尾各 16 KiB。回复的 `original_bytes` 是合并输出的原始字节数，`truncated` 表示输出是否超过 32 KiB，`metadata.exit_code` 为进程退出码。保留字节含无效 UTF-8、不可展示控制字符或 JSON 转义容量过大时整体以 base64 编码，`metadata.encoding` 为 `base64`。Worker 报告保留完整 base64 文本，不再按编码后的长度裁剪；历史读取返回同一份本机完成结果。

实现和测试依据 Baton `b15fde0` 的 `internal/agent/shell/{adapter,thread,completion}.go`、Go shell 的完成证据与进程回收测试，以及 `specs/project-agent/TECH.md` 第 10 节。此目录没有外部模型转录；测试使用本机 shell、确定性命令、受控事件交付和真实 SQLite。覆盖完成保存后尚未报告的 sent / intent 恢复、证据缺失或不匹配不重发、快命令输出、目录授权、开关重读、进程组取消和 base64 报告。

```sh
pnpm --dir apps/batond exec vp test run --config ../../vitest.config.ts src/agents/shell/index.test.ts src/worker/index.test.ts src/worker/output.test.ts src/platform/process.test.ts
pnpm --dir apps/batond exec tsc --noEmit
```

进程行为测试在 Windows 上跳过，Windows 原生进程回收和 PowerShell 命令行为需要在目标系统执行现有平台验证。
