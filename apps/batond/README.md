# TypeScript 节点与 Thread

`@baton/batond` 通过出站 WSS 连接 [TypeScript 开发中心](../server/README.md)，提供 Cursor 远程 Thread、Project Runtime、设备目录和订阅管理。节点守护进程保存设备身份、命令与报告账本，网页可发送排队消息、撤回、停止、恢复并读取实时输出。每个 Thread 使用独立 Worker，每个 Cursor Thread 独占一个 cursor-host；Worker 管理 SQLite、Turn、回复和报告，cursor-host 通过复用的 SDK/runtime 执行本机 Cursor。本地调用方也可直接通过认证 IPC 使用 Worker。

Go 的 `cmd/baton-server`、`cmd/batond` 和根目录构建脚本仍是发布入口，TypeScript 发布切换在迁移 T5 进行。TS 提供 Cursor 远程 Thread、Project 协同和受限 shell；其他 Agent 与统一历史的范围和实际拒绝响应见 [中心能力表](../server/README.md#当前能力范围)。

## 开发入口

在仓库根目录使用 Node 26 与 pnpm 12 安装依赖：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @baton/batond dev help
pnpm --filter @baton/batond dev probe
```

`dev` 构建独立的 `dist/batond.cjs` 后运行。也可以运行 `pnpm --filter @baton/batond build`，再直接调用 `node apps/batond/dist/batond.cjs`。中心账号初始化、数据库迁移、TLS 配置和服务启动见 [中心文档](../server/README.md#本地账号迁移与启动)。`pnpm --filter @baton/server build` 和 `dev` 会自动将网页构建到中心 bundle 旁的 `web/`，默认无需单独构建前端。

显式设置 `CURSOR_API_KEY` 后运行 probe。它在独立 host 中核查 SDK 与辅助程序，调用公开的认证、模型查询接口，不建立执行会话、不发送 prompt、不打开登录浏览器。macOS arm64 / SDK 1.0.35 已启用；Linux 和 Windows 组合保持 `unverified`，依赖不满足时返回不可用原因。只有 `available` 且 `capabilities.create` 为 true 时，CLI 才允许新建。凭据只经子进程环境传递，不写入配置、命令、报告或日志。

## 远程节点

登录中心网页并完成首次改密后，从 Devices 取得一次性注册凭据。将凭据保存到私有文件，POSIX 文件权限为 0600，再接入中心：

```sh
pnpm --filter @baton/batond dev up \
  --coordinator https://localhost:8443 \
  --enrollment-file /绝对路径/enrollment-token \
  --workspace /绝对路径/工作目录 \
  --ca-file /绝对路径/local-ca.crt
```

凭据也可来自 `BATON_ENROLLMENT_TOKEN`。`up` 首次注册并保存身份，已有身份时直接连接；`register` 只注册且拒绝覆盖已有身份；`run` 读取已有身份。默认从保存的 HTTPS 中心地址推导 `/v1/node` 的 WSS 地址，`--relay` 可显式指定。后续启动示例：

```sh
pnpm --filter @baton/batond dev run --ca-file /绝对路径/local-ca.crt
pnpm --filter @baton/batond dev run --relay wss://localhost:8443/v1/node --ca-file /绝对路径/local-ca.crt
```

`--ca-file` 同时供 HTTPS 注册和 WSS 连接校验证书，使用系统已信任证书时可省略；该路径不会保存在身份中。中心地址必须为 HTTPS，Relay 必须为 WSS，证书需匹配访问主机名。

所有节点命令支持 `--data-dir`，默认 `~/.baton-ts`。仅在授权配置不存在时登记用户主目录，已有配置包括空列表都会保留；`--workspace` 在连接前按真实绝对路径幂等登记工作目录。网页设备详情与本地 `files` 命令可以增删授权根；目录选择与附件预览使用同一真实路径边界。节点锁、身份与报告恢复细节见 [远程节点模块](src/daemon/README.md)，实时输出的游标和缓冲规则见 [Worker 文档](src/worker/README.md#real-time-output)。

节点连接和能力探测分别进行。Cursor 探测完成前上报 `unverified`，创建 Thread 需等待 `available`；设备进程需显式配置 `CURSOR_API_KEY`。节点退出不结束独立 Worker，重启后从账本重新发现存活 Worker；未确认命令继续使用原 ID，已接收输入不会因为重连再次发送。

## 设备目录与模型订阅

```sh
pnpm --filter @baton/batond dev files add --id dev --path /绝对路径/工作目录
pnpm --filter @baton/batond dev files list
pnpm --filter @baton/batond dev files remove --id dev
pnpm --filter @baton/batond dev subscriptions
pnpm --filter @baton/batond dev login openai-codex
pnpm --filter @baton/batond dev project-exec --enabled=true --shell /bin/sh
pnpm --filter @baton/batond dev project-exec --enabled=false
```

目录和执行开关使用与 daemon 相同的 `--data-dir`，配置通过私有文件锁与原子替换保存。重复添加同一真实目录返回已有记录；移除全部目录后保留空列表。在线设备也可在网页保存这些设置，中心等待本机确认后才显示成功。

命令执行默认关闭。开启后，Project Agent 以设备用户身份执行任意命令；Baton 不提供沙箱，目录授权限制命令启动位置。每条命令和输出保存在 Thread 中。受限 shell 只允许 `nodes.exec` 创建一个 Turn，默认执行时限 7200 秒，等待结果的时间与命令时限分别计算。完成记录、未知结果及输出编码见 [shell 文档](src/agents/shell/README.md)。

订阅凭据使用 `BATON_PROJECT_RUNTIME_DATA_DIR`，默认 `~/.baton/project-runtime`，登录与 daemon 使用相同的系统用户和目录。`subscriptions` 只读取本地凭据和静态模型目录；终端登录支持 `openai-codex`、`xai`。网页设备码登录在取码后继续后台等待，最多 15 分钟，同服务的新请求替换旧登录，退出后刷新能力报告。凭据留在设备。

Project Runtime 按需启动，默认最多同时占用四个运行名额，WSS 重连保留现有进程。节点退出或租约失效时结束 Runtime，Thread Worker 继续独立运行。Runtime 宿主使用 `project-runtime.db` 保存启动意图、进程身份和清理证据；未确认清理持续补送，旧运行不重新启动。源码开发、租约和 stdio 说明见 [Runtime 宿主文档](src/project/README.md)。

## 本地 Thread 命令

```sh
pnpm --filter @baton/batond dev open --cwd /绝对路径/工作目录
pnpm --filter @baton/batond dev message --thread-id <UUID> --text '需要执行的内容'
pnpm --filter @baton/batond dev reports --thread-id <UUID>
pnpm --filter @baton/batond dev stop --thread-id <UUID>
pnpm --filter @baton/batond dev history --thread-id <UUID>
pnpm --filter @baton/batond dev resume --thread-id <UUID>
```

`open` 可用 `--model` 选择模型；未指定时使用 SDK 原生的 `default`。Thread 内固定该选择，轮间切换与 steer 暂未开放。`open` 返回 Thread ID 和持久接收回执。启动、发送、恢复和停止的实际终态通过 `command --command-id <UUID>` 或 `reports` 查询；Worker 就绪与 Agent 就绪分别报告。`message` 支持 `--message-id`，执行命令支持 `--command-id`，重试时保留原标识。相同命令 ID、相同内容复用回执和结果，内容冲突会被拒绝。

`withdraw --message-id <ID>` 撤回尚未提交的输入。`reports --after-worker-seq <序号>` 顺序读取有界报告，`ack --event-id <UUID> --worker-seq <序号>` 确认已消费报告。本地 `history` 提供 Cursor 的基本原生 user/assistant 消息；网页原生历史当前返回 `ok:false`，在线设备为 `history_unavailable`、离线设备为 `node_offline`。统一历史与公共分页属于迁移 T4。

## 持久化与恢复

默认数据目录为 `~/.baton-ts`，设备和 Thread 命令支持 `--data-dir`。POSIX 目录权限为 0700、文件为 0600；已有权限不符合要求时拒绝使用。UDS 路径超过系统限制时，使用更短的数据目录。Windows 使用令牌认证的命名管道和私有目录 ACL，平台限制见 [platform 文档](src/platform/README.md)。

每个 Thread 的目录包含 Worker 独占锁、IPC 令牌、`thread.db`、原生会话映射和 SDK store。账本使用 WAL 与 `synchronous=FULL`。命令回执与排队状态原子提交；原生发送前把一次采集的历史基准和 intent 原子提交。提交结果无法核查时，Worker 停止执行并关闭本次运行资源。

Worker 重启后，queued 输入可继续调度；已有 intent 只查询原生历史，无法证明已接收时标记 unknown，保留原消息结果。员工显式发送新输入或 resume 时，Worker 先确认旧进程树已回收，再恢复既有原生会话，旧 queued 撤回、旧 unknown 输入保持终态。恢复绑定原生会话、工作目录和私有 store，不重发输入、不新建空会话代替恢复。batond 或本地 CLI 退出后，存活 Worker 继续执行，后续调用通过原 IPC 重连。

停止先持久登记，再中断启动、准备或发送，撤回 queued 输入；已提交的 intent 通过历史核查裁决。取消响应与真实终止分别处理，最多一分钟后回收所属进程树。POSIX 的 SDK spawn/fork 继承 cursor-host 组，宿主取消与回合结束均核查活动子进程，Worker 崩溃时 watchdog 按该组回收。首次打开被取消时，迟到的 SDK 实例会被回收，该命令不会补报打开成功。

## 追踪

节点与独立 Worker 使用 `@baton/telemetry`，默认服务名为 `batond` 和 `baton-worker`。设置 `OTEL_EXPORTER_OTLP_ENDPOINT` 或 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` 可启用 OTLP/HTTP JSON 导出，Worker 继承配置；默认不连接采集端。配置和本地查看命令见 [中心追踪说明](../server/README.md#http-契约与追踪)。

中心持久命令携带标准 trace context，经节点账本和认证 IPC 传入 Worker。接收、派发、执行和恢复按命令、Thread 与原始上下文关联；追踪元数据独立于命令和消息的业务摘要，重试不会因为新的 span 身份而产生内容冲突。SQLite 提交核查与执行恢复语义继续由账本决定。

## 验证

```sh
pnpm --filter @baton/providers typecheck
pnpm --filter @baton/providers test
pnpm --filter @baton/provider-testing test
pnpm --filter @baton/batond typecheck
pnpm --filter @baton/batond lint
pnpm --filter @baton/batond test
```

适配器行为验证仅使用上游 SDK 静态转录、确定性回放和本地替身，驱动实际 SDK 封装、RPC、Worker 和 SQLite。测试覆盖输入不重发、命令去重、停止竞态、未知终态、独立历史、跨进程恢复、提交核查、输出字节游标与洪泛，以及 daemon 断线、持久报告和存活 Worker 重发现，禁止依赖真实 API Key、在线模型推理或外部真实服务。中心与独立 Worker 的完整远程链路验证见 [中心文档](../server/README.md#验证)。完整入口、SQLite 与本地进程测量见 [迁移工具](../../tools/ts-migration/README.md)。
