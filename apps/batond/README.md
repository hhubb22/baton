# TypeScript 本地 Thread

本地调用方通过认证 IPC 使用独立的 Worker；每个 Cursor Thread 独占一个 cursor-host。Worker 管理 SQLite、消息排队、Turn、回复和报告，cursor-host 通过复用的 SDK/runtime 执行本机 Cursor。服务端、网页与 Project 的远程接入由迁移后续切片实现。

## 开发入口

在仓库根目录使用 Node 26 与 pnpm 12 安装依赖：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @baton/batond dev help
pnpm --filter @baton/batond dev probe
```

`dev` 构建独立的 `dist/batond.cjs` 后运行。也可以运行 `pnpm --filter @baton/batond build`，再直接调用 `node apps/batond/dist/batond.cjs`。发布构建使用根目录原有入口。

显式设置 `CURSOR_API_KEY` 后运行 probe。它在独立 host 中核查 SDK 与辅助程序，调用公开的认证、模型查询接口，不建立执行会话、不发送 prompt、不打开登录浏览器。macOS arm64 / SDK 1.0.35 已启用；Linux 和 Windows 组合保持 `unverified`，依赖不满足时返回不可用原因。只有 `available` 且 `capabilities.create` 为 true 时，CLI 才允许新建。凭据只经子进程环境传递，不写入配置、命令、报告或日志。

```sh
pnpm --filter @baton/batond dev open --cwd /绝对路径/工作目录
pnpm --filter @baton/batond dev message --thread-id <UUID> --text '需要执行的内容'
pnpm --filter @baton/batond dev reports --thread-id <UUID>
pnpm --filter @baton/batond dev stop --thread-id <UUID>
pnpm --filter @baton/batond dev history --thread-id <UUID>
pnpm --filter @baton/batond dev resume --thread-id <UUID>
```

`open` 可用 `--model` 选择模型；未指定时使用 SDK 原生的 `default`。Thread 内固定该选择，轮间切换与 steer 暂未开放。`open` 返回 Thread ID 和持久接收回执。启动、发送、恢复和停止的实际终态通过 `command --command-id <UUID>` 或 `reports` 查询；Worker 就绪与 Agent 就绪分别报告。`message` 支持 `--message-id`，执行命令支持 `--command-id`，重试时保留原标识。相同命令 ID、相同内容复用回执和结果，内容冲突会被拒绝。

`withdraw --message-id <ID>` 撤回尚未提交的输入。`reports --after-worker-seq <序号>` 顺序读取有界报告，`ack --event-id <UUID> --worker-seq <序号>` 确认已消费报告。当前历史入口提供 Cursor 的基本原生 user/assistant 消息；公共历史分页与缓存由迁移 T4 提供。

## 持久化与恢复

默认数据目录为 `~/.baton-ts`，所有命令支持 `--data-dir`。POSIX 目录权限为 0700、文件为 0600；已有权限不符合要求时拒绝使用。UDS 路径超过系统限制时，使用更短的数据目录。Windows 使用令牌认证的命名管道和私有目录 ACL，平台限制见 [platform 文档](src/platform/README.md)。

每个 Thread 的目录包含 Worker 独占锁、IPC 令牌、`thread.db`、原生会话映射和 SDK store。账本使用 WAL 与 `synchronous=FULL`。命令回执与排队状态原子提交；原生发送前把一次采集的历史基准和 intent 原子提交。提交结果无法核查时，Worker 停止执行并关闭本次运行资源。

Worker 重启后，queued 输入可继续调度；已有 intent 只查询原生历史，无法证明已接收时标记 unknown，保留原消息结果。员工显式发送新输入或 resume 时，Worker 先确认旧进程树已回收，再恢复既有原生会话，旧 queued 撤回、旧 unknown 输入保持终态。恢复绑定原生会话、工作目录和私有 store，不重发输入、不新建空会话代替恢复。batond 或本地 CLI 退出后，存活 Worker 继续执行，后续调用通过原 IPC 重连。

停止先持久登记，再中断启动、准备或发送，撤回 queued 输入；已提交的 intent 通过历史核查裁决。取消响应与真实终止分别处理，最多一分钟后回收所属进程树。POSIX 的 SDK spawn/fork 继承 cursor-host 组，宿主取消与回合结束均核查活动子进程，Worker 崩溃时 watchdog 按该组回收。首次打开被取消时，迟到的 SDK 实例会被回收，该命令不会补报打开成功。

## 验证

```sh
pnpm --filter @baton/providers typecheck
pnpm --filter @baton/providers test
pnpm --filter @baton/provider-testing test
pnpm --filter @baton/batond typecheck
pnpm --filter @baton/batond lint
pnpm --filter @baton/batond test
```

自动化测试使用上游 SDK 转录和本地替身，驱动实际 SDK 封装、RPC、Worker 和 SQLite，无需真实认证或模型调用。行为测试围绕输入不重发、命令去重、停止竞态、未知终态、恢复和提交核查组织。完整入口测量与显式真实 Cursor 验证见 [迁移工具](../../tools/ts-migration/README.md)。真实验证命令会调用模型，在临时工作目录执行受控 shell 操作，不属于日常 `pnpm test`。
