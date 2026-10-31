# Droid 接入

公共 `agents/thread-agents.ts` 的 `makeThreadAgentFactory` 按 catalog 能力为每个 Thread 创建独立的 `agent-host droid`。host 使用 fork 的 `makeAcpRegistryAdapterV2` 构造完整 ACP adapter，通用 `agent-host/driver.ts` 负责会话映射、事件与发送确认；Worker 保留持久命令、输入 intent、排队、停止裁决和 unknown 状态。

## 配置与模型

ACP registry settings 固定为 `source: local`、`agentId: factory-droid`、`commandPath: droid`、`commandArgs: ['exec', '--output-format', 'acp']`，从 PATH 查找原生程序，不下载 registry 包。host 只继承系统必要环境变量，另外允许设备通过 `FACTORY_API_KEY` 传入 API key；没有其他 `BATON_DROID_*` 配置入口。认证优先沿用设备用户 `~/.factory` 下 `droid` 已有的登录，缺少登录时由原生程序报错。

Thread 模型取 `model ?? adapter_config.model ?? 'auto'`。探测报告把 `auto` 作为默认模型；显式模型 ID 交给原生程序判定。Thread 内逐轮换模型，思考档位是 ACP 配置项 `reasoning_effort`，随输入通过 `session/set_config_option` 设置。上游 adapter 不支持 steer，插入消息一律拒绝。

## 运行模式与审批

`droidSessionModeForPolicy` 把 Baton 的执行权限映射到原生 session mode：`plan` 交互模式使用 `spec`；`approval-required` 与 `auto-accept-edits` 使用 `normal`，具体工具调用由 ACP 客户端按原生请求逐次裁决；`auto` 与 `full-access` 使用 `auto-high`。`normal` 和 `spec` 都不提供系统隔离，审批通过不代表文件或网络被沙箱限制。

`AskUser` 表单由 fork 的 `extractDroidElicitationForm` 解析。Droid 给每个选项附一个 `question_N_other` 自定义答案字段，client 已经提供自由输入，因此 host 隐藏伴随字段，并在回答时恢复成 `other` 加文本。其他 elicitation schema 交给 ACP 通用路径。

## 恢复、核对与停止

恢复与发送核对从打开 adapter 起传入既有原生会话 ID，启用 `resumeOnOpen`，由 fork 直接执行 `session/load`；`failClosedOnSessionLoad` 保证会话缺失或 load 失败时明确失败，不退回 `session/new` 伪造恢复。

`sent` 在独立 host 的 `openSession` 中同样传入 `initialNativeThreadId`，再调用 `readThreadSnapshot`，通过同一原生会话的 load 路径取得快照。通用驱动用 Worker 已确认发送数定位下一条 user 消息，正文一致才确认；缺少匹配证据时返回未确认，由 Worker 保留 unknown，不重发输入。

运行时请求沿用通用策略：`command`、`file-read`、`file-change`、`permission` 当次 `accept`，questions 和 MCP elicitation 转发网页等待回答，其他请求 `cancel`，停止或关闭后的请求一律取消，不写永久授权。ACP 子进程保留自己的进程组，host 模块使用 `foldDetached: false`；POSIX 包装 spawner 经 process registrar 登记该组给 host 内部 watchdog，释放登记前回收整棵子树；Worker 持久账本登记 host 根，Windows registrar 不另记上游子进程。

## 生产能力报告

公共 `agents/probe.ts` 在临时空工作目录的独立 host 中调用 `checkAcpRegistryProviderStatus` 与 `probeAcpRegistryConfiguration`。上游建立一次空的发现会话，直接读取 `session/new` 返回的模型和默认模型的 `configOptions`，不逐模型调用 `session/set_config_option`，也不发送 prompt。结束后关闭 host 并回收进程树。

Baton 在上游 status 之外运行 `droid --version`，复用 host 的 Node Effect `ChildProcessSpawner` 和 process registrar。版本命令限时 4 秒，stdout、stderr 各最多收集 4096 字节；只返回解析出的版本号，原始输出与诊断留在 host 内。命令超时、失败、输出超限或无法解析时版本为 `unknown`，reason 记录相应问题；已确认程序安装时仍允许新建与恢复。

程序已安装且认证为 valid 或 unknown 时报告 `available`，开放 `capabilities.create` 和 `capabilities.resume`。系统和版本不设白名单。reason 保留版本、系统和认证未知提示；明确 `missing` 或程序缺失则报告 `unavailable`。模型目录不可读时可使用原生默认模型。认证变化通过 `~/.factory/settings.json`、`~/.factory/auth.v2.loginkeychain` 和 PATH 中 `droid` 的文件元数据触发重新探测，不读取凭据内容。

实际回合中的明确认证失败向 Thread 返回固定文案“Sign in to the Factory Droid CLI and try again.”；其他 provider 错误返回“Check the Factory Droid CLI on this device and try again.”。原始错误不透传，Baton 不自动登录或重发输入。

## 离线验证

`src/testing/droid/probe.ndjson` 与 `approved-turn.ndjson` 录自 macOS arm64 上的 `droid` 1.1.0，经本地 ACP replay testkit 由真实 adapter 和 agent-host 回放。探测夹具是一次空会话，读取 69 个模型和默认模型的 `reasoning_effort`，不发送 prompt；回合夹具在新会话中设置模型、`autonomy_level`、`reasoning_effort`，执行一次带审批的 shell 工具调用并完成回复。

host 回放验证新建、探测、`normal` 模式设置、权限请求经 adapter 返回 `allow_once`、回复和停止。Windows 和 Linux 上的行为尚未验证，版本和系统范围只写入诊断，不阻塞开放。离线回放验证自动化行为，不能证明设备上真实账号的授权有效。
