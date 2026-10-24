# Kiro 接入

`makeKiroAgentFactory` 为每个 Thread 创建独立的 `agent-host kiro`。host 使用 fork 的 `makeAcpRegistryAdapterV2` 构造完整 ACP adapter，通用 `agent-host/driver.ts` 负责会话映射、事件与发送确认；Worker 保留持久命令、输入 intent、排队、停止裁决和 unknown 状态。

## 配置与模型

ACP registry settings 固定为 `source: local`、`agentId: kiro`、`commandPath: kiro-cli`，从 PATH 查找原生程序，启动 `kiro-cli acp --agent-engine=v3`，不下载 registry 包。host 只继承系统必要环境变量；上游 Kiro driver 不读取专有配置环境变量，Baton 不提供 `BATON_KIRO_*` 或 `KIRO_HOME` 配置入口。认证沿用设备用户的原生配置，本地映射的 profile 保存 `homedir()`，恢复时核对该位置。

Thread 模型取 `model ?? adapter_config.model ?? 'default'`。fork 在 `session/new` 中省略 `default`，由 Kiro 选择原生默认模型；具体模型 ID 经 `_meta.kiro.modelId` 传递。Thread 内固定模型，不支持 steer 或轮间换模型。`effect-acp` 按 initialize 响应协商协议，Kiro 2.32.0 离线夹具返回 v1。

## 恢复、核对与停止

恢复先核对本地映射中的 Thread、Agent 类型、原生 ID、工作目录和 profile。通用 driver 的可选 `resumeOnOpen` 仅对 Kiro 设为 `true`；resume 在 `openSession` 时传入 `initialNativeThreadId`，避免 ACP 先 `session/new` 一个空会话，再由 fork 的 `beforeLoadSession` 通过 `session/list` 核对原生会话 ID 与 cwd，之后调用 `session/load`。会话缺失、目录不符或 load 失败时明确失败，不新建空会话代替恢复。

`sent` 在独立 host 的 `openSession` 中同样传入 `initialNativeThreadId`，再调用 `readThreadSnapshot`，经同一原生会话核对与 load 路径取得快照。通用驱动用 Worker 已确认发送数定位下一条 user 消息，正文一致才确认；缺少匹配证据时返回未确认，由 Worker 保留 unknown，不重发输入。

运行时请求沿用通用策略：`command`、`file-read`、`file-change`、`permission` 当次 `accept`，questions、MCP elicitation 和其他请求 `cancel`，停止或关闭后的请求一律取消，不写永久授权。ACP 子进程保留自己的进程组，host 模块使用 `foldDetached: false`；包装 spawner 经 process registrar 登记该组给 watchdog 与 Worker，释放登记前回收整棵子树。

## 生产能力报告

探测在临时空工作目录的独立 host 中调用 `checkAcpRegistryProviderStatus` 与 `probeAcpRegistryConfiguration`。上游会建立空的发现会话以读取能力和模型，不发送 prompt，不打开登录流程；结束后关闭 host 并回收进程树。

当前上游检查成功仍只报告 `auth.status: unknown`，本地 executable 的 `version` 为 `null`。Baton 将版本映射为 `unknown`，上报 `status: unverified`、`capabilities.create: false`、`capabilities.resume: false`，原因为“Kiro 上游只读探测尚不能确认认证与版本”。缺程序或明确未认证时报告 `unavailable`。因此生产网页与 CLI 尚不能新建 Kiro Thread，中心新建请求返回 HTTP 422、`code: "agent_unavailable"`。注册表中的 adapter 能力上限和 Kiro 2.32.0 回放版本不会绕过认证与版本检查。

## 离线验证

回放使用 fork 的 `@t3tools/provider-acp-registry/testing/replay` testkit 驱动真实 adapter 与 agent-host 子进程。Kiro CLI 2.32.0 夹具由旧 Go 录制转换，转换脚本位于 fork 的 `packages/provider-acp-registry/scripts/convert-kiro-replay.mjs`，夹具说明见 [fork README](../../../../../upstream/t3code/packages/provider-acp-registry/src/testing/fixtures/kiro/README.md)。转换保留协议响应、通知和权限结果，调整 initialize 协商请求与 prompt 形状，丢弃 version 探测和 stderr。这些夹具是用户授权保留旧资产的唯一例外；旧 Go 实现与测试不作为行为参照。

host 回放的验证范围为新建、两轮、停止（含工具执行中）、恢复与 `restore_missing` 失败，以及 `sent` 的确认和未确认。`interrupt_mid_tool` 夹具中的真实权限请求经 adapter 返回 `allow_once`，随后完成取消。进程回收测试以真实 Kiro adapter 配合本地 ACP 协议替身，确认 ACP 为独立进程组、grandchild 与 ACP 同组；正常关闭及只对 host 发 SIGKILL 后，三个进程均退出，强杀路径由 registrar watchdog 回收独立组。跨 app 的 `e2e/src/provider-agents.integration.test.ts` 通过依赖注入提供已验证 capability，驱动真实 adapter，核对网页 API 发送、回复、中心 idle、停止与恢复。回放与 e2e 验证自动化行为，不能证明本机认证有效，也不能将生产报告提升为 `available`。全部验证仅使用离线夹具和本地替身，不启动真实 `kiro-cli` 或调用在线模型。
