# Kiro 接入

公共 `agents/thread-agents.ts` 的 `makeThreadAgentFactory` 按 catalog 能力为每个 Thread 创建独立的 `agent-host kiro`。host 使用 fork 的 `makeAcpRegistryAdapterV2` 构造完整 ACP adapter，通用 `agent-host/driver.ts` 负责会话映射、事件与发送确认；Worker 保留持久命令、输入 intent、排队、停止裁决和 unknown 状态。

## 配置与模型

ACP registry settings 固定为 `source: local`、`agentId: kiro`、`commandPath: kiro-cli`，从 PATH 查找原生程序，启动 `kiro-cli acp --agent-engine=v3`，不下载 registry 包。host 只继承系统必要环境变量；上游 Kiro driver 不读取专有配置环境变量，Baton 不提供 `BATON_KIRO_*` 或 `KIRO_HOME` 配置入口。认证沿用设备用户的原生配置，本地映射的 profile 保存 `homedir()`，恢复时核对该位置。

Thread 模型取 `model ?? adapter_config.model ?? 'default'`。fork 在 `session/new` 中省略 `default`，由 Kiro 选择原生默认模型；具体模型 ID 经 `_meta.kiro.modelId` 传递。Thread 内固定模型，不支持 steer 或轮间换模型。`effect-acp` 按 initialize 响应协商协议，Kiro 2.32.0 离线夹具返回 v1。

## 恢复、核对与停止

恢复先核对本地映射中的 Thread、Agent 类型、原生 ID、工作目录和 profile。通用 driver 的可选 `resumeOnOpen` 仅对 Kiro 设为 `true`；resume 在 `openSession` 时传入 `initialNativeThreadId`，避免 ACP 先 `session/new` 一个空会话，再由 fork 的 `beforeLoadSession` 通过 `session/list` 核对原生会话 ID 与 cwd，之后调用 `session/load`。会话缺失、目录不符或 load 失败时明确失败，不新建空会话代替恢复。

`sent` 在独立 host 的 `openSession` 中同样传入 `initialNativeThreadId`，再调用 `readThreadSnapshot`，经同一原生会话核对与 load 路径取得快照。通用驱动用 Worker 已确认发送数定位下一条 user 消息，正文一致才确认；缺少匹配证据时返回未确认，由 Worker 保留 unknown，不重发输入。

运行时请求沿用通用策略：`command`、`file-read`、`file-change`、`permission` 当次 `accept`，questions 和 MCP elicitation 转发网页等待回答，其他请求 `cancel`，停止或关闭后的请求一律取消，不写永久授权。ACP 子进程保留自己的进程组，host 模块使用 `foldDetached: false`；POSIX 包装 spawner 经 process registrar 登记该组给 host 内部 watchdog，释放登记前回收整棵子树；Worker 持久账本登记 host 根，Windows registrar 不另记上游子进程。

## 生产能力报告

公共 `agents/probe.ts` 在临时空工作目录的独立 host 中调用 `checkAcpRegistryProviderStatus` 与 `probeAcpRegistryConfiguration`。上游会建立空的发现会话以读取能力和模型，不发送 prompt，不调用 auth/login 或打开登录流程；结束后关闭 host 并回收进程树。

Baton 在上游 status 之外运行 `kiro-cli --version`，使用 host 提供的 Node Effect `ChildProcessSpawner` 和 process registrar，由 Scope 与进程回收路径管理生命周期。版本命令限时 4 秒，stdout、stderr 各最多收集 4096 字节；只返回解析出的版本号，原始输出与诊断留在 host 内，不进入能力报告。命令超时、失败、输出超限或无法解析时，版本为 `unknown`，reason 记录相应问题；已确认程序安装时仍允许新建与恢复。缺少程序时报告 `unavailable`。

程序已安装且认证为 valid 或 unknown 时报告 `available`，开放 `capabilities.create` 和 `capabilities.resume`。系统和版本不设白名单，预发布、构建后缀与未知版本也允许新建。reason 保留版本、系统和认证未知提示，认证由原生程序在首次执行时检查；明确 `missing` 或程序缺失则报告 `unavailable`。模型目录不可读时可使用原生默认模型。整次 host 探测失败且安装状态未确认时报告 `unverified`。四个 Agent 共用这一规则。上游 Kiro adapter 报告不支持 steer 和 Thread 内换模型，reason 同时说明这两项限制。

Kiro 的思考强度是 ACP 配置项 `effortLevel`，只有部分模型提供。探测在一次性的空 session 里逐个切换模型，读取各模型的选项后写入 `model_thinking`，不发送消息。发消息时把选中的档位通过 `session/set_config_option` 设置给当前 session。

网页按节点报告开放 Kiro 的新建与恢复；不满足准入条件的新建请求返回 HTTP 422、`code: "agent_unavailable"`。本地 CLI 的 `open --agent` 支持四个 hosted Agent。

实际回合中的明确认证失败向 Thread 返回固定文案“Sign in to Kiro CLI and try again.”；其他 provider 错误返回“Check Kiro CLI on this device and try again.”。原始错误不透传，Baton 不自动登录或重发输入。

## 离线验证

回放使用 fork 的 `@t3tools/provider-acp-registry/testing/replay` testkit 驱动真实 adapter 与 agent-host 子进程。Kiro CLI 2.32.0 夹具由旧 Go 录制转换，转换脚本位于 fork 的 `packages/provider-acp-registry/scripts/convert-kiro-replay.mjs`，夹具说明见 [fork README](../../../../../upstream/t3code/packages/provider-acp-registry/src/testing/fixtures/kiro/README.md)。转换保留协议响应、通知和权限结果，调整 initialize 协商请求与 prompt 形状，丢弃 version 探测和 stderr。这些夹具是用户授权保留旧资产的唯一例外；旧 Go 实现与测试不作为行为参照。

host 回放的验证范围为新建、两轮、停止（含工具执行中）、恢复与 `restore_missing` 失败，以及 `sent` 的确认和未确认。认证失败场景由 `provider_error` 派生夹具驱动真实 adapter、agent-host 与 Worker；认证失败和原始 provider 错误分别接上 `simple` 的成功回合，核对失败结束及固定安全原因、输入保持 sent、队列继续执行并收到回复、最终 idle，以及原生会话与进程保留。原始诊断不外传，失败输入不重发。`interrupt_mid_tool` 夹具中的真实权限请求经 adapter 返回 `allow_once`，随后完成取消。进程回收测试以真实 Kiro adapter 配合本地 ACP 协议替身，确认 ACP 为独立进程组、grandchild 与 ACP 同组；正常关闭及只对 host 发 SIGKILL 后，三个进程均退出，强杀路径由 registrar watchdog 回收独立组。跨 app 的 `e2e/src/provider-agents.integration.test.ts` 通过依赖注入提供已验证 capability，驱动真实 adapter，核对网页 API 发送、回复、中心 idle、停止与恢复，以及明确失败后时间线可读原因、Thread 回到 idle 并能继续发送。

版本探测测试使用本地可执行替身，覆盖版本解析、预发布后缀保留、诊断不外传、非零退出、缺少程序，以及超时后回收进程；公共探测测试核对未知版本、其他系统、认证 unknown 放行，以及缺程序和明确 missing 拒绝。夹具 README 与 metadata 的 `agentVersion` 明确记录 Kiro CLI `2.32.0`，转录协议的 `version: "1"` 是协议格式版本。离线回放与 e2e 验证自动化行为，不能证明设备上真实账号的授权有效；节点按安装与认证结果报告可用性，版本和系统保留为诊断信息。全部验证仅使用离线夹具和本地替身，不启动真实 `kiro-cli` 或调用在线模型。

部署与设备接入见 [根 README](../../../../../README.md)，验证命令见 [AGENTS.md](../../../../../AGENTS.md#常用构建与验证命令)。
