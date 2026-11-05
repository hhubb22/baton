# TypeScript 节点与 Thread

`@baton/batond` 通过出站 WSS 连接 [TypeScript 开发中心](../server/README.md)，提供 Cursor、Pi、Codex、Kiro、Antigravity、Droid 远程 Thread、Project Runtime、设备目录和订阅管理。节点守护进程保存设备身份、命令与报告账本，网页可发送排队消息、撤回、停止、恢复并读取实时输出。每个 Thread 使用独立 Worker，每个执行中的 Agent Thread 独占一个 agent-host；Worker 管理 SQLite、Turn、回复和报告，agent-host 用 fork 的完整 adapter 执行本机 Agent。本地调用方也可直接通过认证 IPC 使用 Worker。

设备安装包使用单一 Node SEA 可执行文件，附带 `node_modules/` 提供 Cursor SDK、Project Runtime 模型库与原生依赖。设备无需安装 Node 或 pnpm。TS 提供 Cursor、Pi、Codex、Kiro、Antigravity、Droid 远程 Thread、Project 协同和受限 shell；六个 Agent 在程序或 SDK 已安装且认证为 valid 或 unknown 时报告 `available`，开放网页新建与恢复。缺程序或明确 `missing` 时报告 `unavailable`；系统与版本不设白名单，未知版本、其他系统和认证 unknown 保留在 reason 中。配置、恢复和离线验证范围见 [Kiro 文档](src/agents/kiro/README.md)、[Antigravity 文档](src/agents/antigravity/README.md)和 [Droid 文档](src/agents/droid/README.md)；Pi、Codex、Kiro、Cursor 的能力及中心历史读取范围见 [中心能力表](../server/README.md#当前能力范围)。

## 开发入口

中心同步允许转发时，节点通过随机端口的本机 OTLP 接收端收集自身和子进程数据，再经 WSS 发给中心。本机令牌只经环境变量传给 Worker、agent-host 和 Project Runtime，不写账本或命令行。节点本地设置 `OTEL_EXPORTER_OTLP_*` 时使用本地配置，不启动转发接收端。等待事件和周期指标来自现有状态与账本；账本预算比率目前只用于观察，不阻止新 Thread。旧开发账本可以自行重建，程序不会自动删除本地数据。详见[可观测性设计](../../specs/observability/TECH.md)。

环境要求、安装和构建命令见 [AGENTS.md](../../AGENTS.md#常用构建与验证命令)，参数见 [工具说明](../../tools/README.md#本地开发)。统一入口为 `src/index.ts`，调用 `src/cli.ts` 导出的 `runBatondCLI(args)`；开发 bundle 的 Project Runtime 与 watchdog 使用同一 bundle 的子命令，直接源码运行使用 Runtime 包解析的 tsx loader。

显式设置 `CURSOR_API_KEY` 后运行 probe。它在独立 host 中核查 SDK 与辅助程序，调用公开的认证、模型查询接口，不建立执行会话、不发送 prompt、不打开登录浏览器。SDK 安装完整且认证未明确缺失时报告 `available`，版本和系统不限制新建；平台资产不完整、辅助程序不可执行或 sandbox 检查明确失败时报告不可用原因。只有 `available` 且 `capabilities.create` 为 true 时，CLI 才允许新建。凭据只经子进程环境传递，不写入配置、命令、报告或日志。

## 安装包入口

安装目录包含 `batond`（Windows 为 `batond.exe`）、旁置的 `node_modules/` 和许可文件。`batond install` 把整个 SEA 目录安装到固定程序目录（默认 `~/.baton/program`，自定义数据目录为 `<目录>/installation`），数据目录单独保存；SEA 中 Worker、watchdog、agent-host 与 Project Runtime 使用同一程序目录的可执行文件加子命令启动，不解析源码目录。

```sh
./batond --version
./batond agent-host --probe
./batond project-runtime probe
./batond project-runtime login-api-key anthropic < key-file
```

安装、卸载和诊断输出见 [发布设计](../../specs/release/TECH.md#33-中心与设备替换升级)。`batond install` 仅接受 SEA：先停止运行中的守护进程并等待锁释放，再替换程序目录、写入 `~/.local/bin/batond` 入口，并重载已安装的用户服务；`uninstall` 先停止守护进程与服务，默认保留数据，`--purge` 才删除。`doctor` 只读检查版本、目录、入口、服务和占用空间。

`--version` 输出 JSON，包含发布版本、提交、平台、协议和存储格式、支持的 daemon 版本，以及 `sea`、`node`。`worker --version`、`agent-host --version`、`watchdog --version` 和 `project-runtime --version` 返回同一份身份；未指定构建身份时为 `development`。Worker status、Agent host 和 Runtime probe 的 `release` 字段使用同一来源。`agent-host --probe` 加载四个 host 模块，SEA 中同时加载 keyring 和 Cursor 的 tree-sitter 原生扩展，输出 `agents`、`nativeModules` 与 `release`；不读取系统钥匙串、不进行认证或模型请求。模块加载失败时非零退出并提示检查安装包的 `node_modules` 与平台依赖。`project-runtime` 后的参数直接传给 Runtime，支持 `run`、`probe`、`login`、`login-device`、`login-api-key` 和 `--version`。

`worker`、`watchdog`、和 `agent-host <类型> --cwd <目录> --state <目录>` 是内部进程入口，由宿主管理生命周期。POSIX 使用 watchdog 回收已登记的进程组，依赖系统 `/bin/ps`；Linux 的最小容器需要安装 `procps`。Windows 使用持久进程身份与 taskkill 回收。

## 远程节点

账号与安装包下载见 [根文档](../../README.md#设备接入)。设备接入使用设备码登录：

```sh
batond login --coordinator https://baton.example
batond status
batond login --cancel
batond logout
batond service install
batond service status
batond service uninstall
```

无位置参数的 `login` 经本地控制通道发起设备绑定，展示验证网址、短码和有效期，在浏览器确认后自动保存身份并上线。`login openai-codex` 等带 provider 参数的命令继续用于模型订阅登录。Ctrl-C 只退出 CLI 等待，不取消后台设备码轮询；`login --cancel` 显式取消。设备码有效期 10 分钟，拒绝或过期后可重新发起。

每个数据目录只有一个持有 `daemon.lock` 的后台守护进程，CLI 的 `ControlClient` 使用 `control.token` 认证的 UDS / Named Pipe；端点不存在时在 `autostart.lock` 下按需启动 `serve`。`run` 是用户服务的常驻入口；未绑定或被中心拒绝时进程仍保留控制通道。`status` 不带 `--thread-id` 查询本机守护进程，带该参数继续查询 Thread。状态区分 `unbound`、`authorizing`、`connecting`、`syncing`、`online` 和 `rejected`。凭据吊销或协议版本不兼容时停止重连并保存拒绝原因。

同中心已有有效身份时 `login` 直接复用，异中心或已吊销身份要求先 `logout`。登出先取消设备码轮询、断开 WSS、停止并回收受管执行进程，再清除身份，保留账本、目录配置和模型凭据；无法确认回收时不清除身份。登出前将旧绑定及其任务标识持久保存到私有的 `retired-bindings.json`；重新绑定后，不恢复旧排队任务、不发送旧报告，也不通过新绑定读取旧输出。备份或搬迁时保留整个数据目录，包括这份绑定停用记录。`shutdown` 通过控制通道正常停止守护进程。设备码登录与 WSS 使用系统根证书库校验 HTTPS / WSS，不分发应用私有 CA，设备连接凭据无闲置过期时间。

所有节点命令支持 `--data-dir`，默认 `~/.baton/data`。首次登录仅在授权配置不存在时登记用户主目录，已有空列表继续保留。目录和文件预览遵循同一真实路径边界；本地 `files` 命令和网页选目录弹窗均可维护授权目录。

macOS launchd 与 Linux systemd 用户服务使用同一常驻入口，安装时先通过控制通道停掉已有后台实例，等待锁释放再接管，失败恢复原服务定义。服务可在未绑定时安装，卸载保留身份和数据。Linux 要求有效的 `XDG_RUNTIME_DIR` 与 systemd 用户实例；未开启 linger 时注销将停止服务。Windows 使用桌面客户端或按需启动，不支持 CLI 用户服务。

六个 Agent 的探测与中心连接独立进行，程序或 SDK 已安装且认证 valid/unknown 时开放新建与恢复。缺少程序或明确认证缺失时拒绝，未知系统或版本只记录诊断。执行状态机目前继续由独立 Worker 承载；本地控制通道负责守护进程入口和绑定生命周期。

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

目录和执行开关使用与 daemon 相同的 `--data-dir`，配置通过私有文件锁与原子替换保存。重复添加同一真实目录返回已有记录；移除全部目录后保留空列表。在线设备也可在网页保存这些设置，中心等待本机确认后才显示成功。`browse-roots.json` 的 `maxRoots` 默认 256，可配置为 1～4096 的整数；修改目录时保留该设置。例如 `{"maxRoots":512,"roots":[{"id":"dev","path":"/绝对路径/工作目录"}]}`。每个目录仍须逐项授权，设备报告仍保留 64 KiB 总容量限制，超限时裁剪仓库、模型和目录并标记 `truncated`；本地授权清单保留全部目录。网页 Devices 展开设备后通过独立管理请求分页读取全部授权目录，每页 JSON 不超过 48 KiB；本地 `files list` 也可查询完整清单。翻页期间清单变化会提示重新读取。目录增删的确认响应返回有界摘要，随后刷新完整清单。

命令执行默认关闭。开启后，Project Agent 以设备用户身份执行任意命令；Baton 不提供沙箱，目录授权限制命令启动位置。`nodes.exec` 创建独立 Execution，命令进程由 `src/execution` 管理，启动意图、停止标记和报告保存在私有 SQLite 账本。默认执行时限 7200 秒，工具等待时间与命令时限分别计算。完成证据先保存再上报，无法确认结果时标为 `unknown` 且不自动重跑。状态、输出与恢复规则见 [Project Agent 设计](../../specs/project-agent/TECH.md#10-在节点上执行命令)。

订阅凭据使用 `BATON_PROJECT_RUNTIME_DATA_DIR`，默认 `~/.baton/data/credentials`，登录与 daemon 使用相同的系统用户和目录。`subscriptions` 只读取本地凭据和静态模型目录；终端登录接受 provider ID，支持 `openai-codex`、`xai`、`anthropic`，也识别 ChatGPT、xAI、Claude 别名；实际登录方式由 Runtime 注册的实现决定。API key 从 Runtime 的 `login-api-key <provider>` 标准输入配置，支持 xAI 与 Anthropic，命令和私有文件要求见 [Runtime 登录说明](../../runtimes/project-agent/README.md#运行与凭据)。Runtime 不读取环境 API key 或其他 CLI 的凭据，每个 provider 的 API key 与 OAuth 登录互相替换。网页根据设备报告的 `login_methods` 提供设备码登录或设备本地配置命令。已声明 provider 的认证状态为 `unknown` 时允许启动并由实际请求检查；明确 `login_required` 时等待登录。已知凭据权限、属主或路径错误保留具体安全原因，启动失败后可从运行的 `end_reason` 查看。网页设备码登录在取码后继续后台等待，最多 15 分钟，同服务的新请求替换旧登录，退出后刷新能力报告。凭据留在设备。

节点数据目录中的私有文件 `project-runtime.json` 配置 Project 的资源预算，POSIX 权限为 0600。各字段均可省略，修改后在下次探测或启动时生效：

```json
{
  "maxConcurrentProjects": 4,
  "probeTimeoutMs": 5000,
  "probeMaxOutputBytes": 65536,
  "maxOutputTokens": 32000,
  "maxModelCalls": 64
}
```

`maxConcurrentProjects` 范围为 1～1024，`probeTimeoutMs` 范围为 1～300000 毫秒，`probeMaxOutputBytes` 范围为 1024～196608 字节。`maxOutputTokens`、`maxModelCalls` 均为正安全整数，宿主通过 Runtime 的 `run --max-output-tokens` 和 `--max-model-calls` 传递。目录扫描单独使用 2 秒预算。探测失败时保留进程内上次成功报告的 `probed_at`，附加 `stale: true` 和 `probe_error`；Runtime 文件或凭据文件的删除、替换及权限变化会使缓存失效，成功的新报告立即替换旧认证状态。实际启动前始终重新探测，缓存不能代替启动检查。

Project Runtime 按需启动，默认最多同时占用四个运行名额，通过 `maxConcurrentProjects` 调整，中心使用节点上报的同一并发值；等待旧进程清理的运行继续占用名额。WSS 重连保留现有进程。节点退出或租约失效时结束 Runtime，Thread Worker 继续独立运行。Runtime 宿主使用 `project-runtime.db` 保存启动意图、进程身份和清理证据；未确认清理持续补送，旧运行不重新启动。源码开发、租约和 stdio 说明见 [Runtime 宿主文档](src/project/README.md)。

## 本地 Thread 命令

```sh
pnpm --filter @baton/batond dev open --cwd /绝对路径/工作目录
pnpm --filter @baton/batond dev message --thread-id <UUID> --text '需要执行的内容'
pnpm --filter @baton/batond dev reports --thread-id <UUID>
pnpm --filter @baton/batond dev stop --thread-id <UUID>
pnpm --filter @baton/batond dev resume --thread-id <UUID>
```

本地 CLI 的 `open` 支持 `--agent cursor|pi|codex|kiro`，默认 Cursor；`--model` 接受显式模型 ID，未指定时使用该 Agent 上报的默认模型。`--execution-timeout-seconds` 设置每轮执行时限，默认 7200 秒，范围为 1～2147483647 秒。重试同一个 Thread 时沿用保存的 Agent、模型和时限，配置冲突会被拒绝。Pi、Codex、Cursor 的排队消息可指定下一轮模型，省略时沿用最近确认提交的回合模型，首次使用创建配置。

`message --mode queue|steer` 默认排队；Pi、Codex 支持向活动回合插入，Cursor、Kiro 只接受排队消息，最终由 Worker 按实际能力和当前回合校验。排队消息可传 `--model`，Worker 按 Thread 的换模型能力校验；插入消息不能同时指定模型。Pi 的 `set_model` 明确拒绝或 Cursor SDK 明确拒绝模型时，该条输入持久撤回，后续排队消息继续处理。超时、断连和其他不能确认是否提交的失败保持 unknown，恢复只核对原生历史，不重发旧输入；显式恢复沿用最近确认提交的回合模型。

Kiro 的 local settings 使用 `agentId: kiro`、`commandPath: kiro-cli`，从 PATH 查找程序；host 仅继承系统必要环境变量，不提供 `BATON_KIRO_*` 或 `KIRO_HOME` 入口。Kiro 模型取 `model ?? adapter_config.model ?? 'default'`；`default` 在原生 `session/new` 中省略，具体 ID 经 `_meta.kiro.modelId` 传递，整个 Thread 固定该选择。

设备环境保存在数据目录的 `environment/` 私有目录，服务首次安装时导入通用系统、代理和证书变量，后续安装与升级复用已保存的配置。桌面客户端首次启动尝试从登录 shell 读取；读取失败时使用启动环境，并在 `env doctor` 中报告。`batond env import [--shell]` 重新导入通用变量；`env list` 列出变量名称，`env doctor` 检查代理冲突、证书和 SSH socket 路径、常见 Agent 程序以及已记录进程的配置版本，均不输出变量值。

使用 `batond env set <名称> --scope <范围>` 从标准输入读取值，`env unset <名称>` 抑制继承，`env reset <名称>` 删除当前范围的设置。范围依次为 `device`、`project:<项目 ID>`、`agent:<类型>`、`project:<项目 ID>:agent:<类型>`；未关联项目的 Thread 可使用工作目录代替项目 ID。各命令支持 `--data-dir`。显式设置值和包含凭据的代理地址保存在独立私有文件中；不采集父进程的全部密钥，也不允许设置 Node 注入选项、TLS 校验关闭变量和 Baton 内部变量。SSH socket 与图形会话地址从当前进程读取，不保存快照。

新进程按系统基础、导入值、设备、项目、Agent 和项目内 Agent 的顺序合并环境。修改配置不会中断正在执行的任务；空闲 Worker 退出后由下一次请求重新启动。daemon 自身的网络代理和证书设置需要重启 daemon 才能生效。Node 中心连接支持 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 及小写形式，设置 HTTP 代理时默认启用 `NODE_USE_ENV_PROXY`，可显式设置为 `0`；`ALL_PROXY` 透传给支持它的下游工具。证书路径应位于运行设备上。设备绑定与中心连接使用系统根证书库；Agent 对证书和代理变量的支持由各自的网络库决定。

`open` 返回 Thread ID 和持久接收回执。启动、发送、恢复和停止的实际终态通过 `command --command-id <UUID>` 或 `reports` 查询；Worker 就绪与 Agent 就绪分别报告。`message` 支持 `--message-id`，执行命令支持 `--command-id`，重试时保留原标识。相同命令 ID、相同内容复用回执和结果，内容冲突会被拒绝。

`withdraw --message-id <ID>` 撤回尚未提交的输入。`reports --after-worker-seq <序号>` 顺序读取有界报告，`ack --event-id <UUID> --worker-seq <序号>` 确认已消费报告。设备不保存原生历史。网页时间线按中心保存的 Thread 输入、回复和事件分页，实时输出通过输出接口读取。

## 持久化与恢复

默认数据目录为 `~/.baton/data`，设备和 Thread 命令支持 `--data-dir`。安装、卸载和诊断命令见 [发布设计](../../specs/release/TECH.md)。POSIX 目录权限为 0700、文件为 0600；已有权限不符合要求时拒绝使用。UDS 路径超过系统限制时，使用更短的数据目录。Windows 使用令牌认证的命名管道和私有目录 ACL，平台限制见 [platform 文档](src/platform/README.md)。

每个 Thread 的目录包含 Worker 独占锁、IPC 令牌、`thread.db`、原生会话映射和 SDK store。账本使用 WAL 与 `synchronous=FULL`。命令回执与排队状态原子提交；原生发送前把本地准备文档和 intent 原子提交。提交结果无法核查时，Worker 停止执行并关闭本次运行资源。

Worker 重启后，queued 输入可继续调度；已有 intent 只用新的只读 host 核对原生快照，无法证明已接收时标记 unknown，保留原消息结果。员工显式发送新输入或 resume 时，Worker 先确认旧进程树已回收，再恢复既有原生会话，旧 queued 撤回、旧 unknown 输入保持终态。恢复绑定原生会话、工作目录和私有 store，不重发输入、不新建空会话代替恢复。batond 或本地 CLI 退出后，存活 Worker 继续执行，后续调用通过原 IPC 重连。回复 ID 超过 512 字节时使用稳定映射，NUL 和无效 Unicode 文本以 `�` 展示；原始回复与执行身份保存在本地 Worker 账本，ACK 后保留，用于去重和核对。显示字段异常继续关联原回合终态，执行身份不匹配仍进入 unknown。

停止先持久登记，再中断启动、准备或发送，撤回 queued 输入；已提交的 intent 通过只读快照核对裁决。取消响应与真实终止分别处理，最多一分钟后回收所属进程树。POSIX 的 Cursor SDK spawn/fork 并入 agent-host 组；Pi、Codex、Kiro 使用 `foldDetached: false` 保留原生进程组，由 host 内部 registrar 和 watchdog 登记，释放登记前回收后代；Worker 账本登记 host 根进程。Windows registrar 不登记独立组。回收依靠 adapter/spawner 的 Scope、watchdog 和 Worker 外层进程树回收，确认终止后才报告 `thread.stopped`。首次打开被取消时，迟到的 SDK 实例会被回收，该命令不会补报打开成功。

## 追踪

节点与独立 Worker 使用 `@baton/telemetry`，默认服务名为 `batond` 和 `baton-worker`。中心允许转发时，子进程向本机接收端发送 OTLP/HTTP；连接断开、未启用或发送队列有积压时丢弃批次。设备本地设置 `OTEL_EXPORTER_OTLP_*` 时子进程继承本地配置并直接导出。daemon 重启后仍存活的旧 Worker 保留旧端口和令牌，直到 Worker 重启前无法通过新 daemon 转发。配置和本地查看命令见 [中心追踪说明](../server/README.md#http-契约与追踪)。

中心持久命令携带标准 trace context，经节点账本和认证 IPC 传入 Worker。接收、派发、执行和恢复按命令、Thread 与原始上下文关联；追踪元数据独立于命令和消息的业务摘要，重试不会因为新的 span 身份而产生内容冲突。SQLite 提交核查与执行恢复语义继续由账本决定。

## 验证

验证命令见 [AGENTS.md](../../AGENTS.md#常用构建与验证命令)。单元组排除数据库与进程集成文件，集成组仅运行这些文件。辅助程序集中在 `src/testing/`，跨 app 测试见 [e2e](../../e2e/README.md)。

适配器行为验证仅使用上游 SDK 静态转录、确定性回放和本地替身，驱动实际 SDK 封装、RPC、Worker 和 SQLite。

Kiro CLI 2.32.0 夹具经用户授权由旧 Go 录制转换，host 回放使用 fork 的 ACP replay testkit；e2e 注入已验证 capability 驱动真实 adapter，验证发送、回复、中心 idle、停止与恢复。该注入验证自动化行为，不能证明真实账号授权有效；生产可用性按节点的安装与认证结果判断，版本和系统只记入诊断。认证失败派生夹具基于 `provider_error`，通过真实 host 与 Worker 核对固定安全文案进入 Thread 报告、原始错误不外传和输入不重发。版本探测使用本地可执行替身测试，不启动真实 `kiro-cli`。

测试覆盖输入不重发、命令去重、停止竞态、未知终态、只读发送核对、跨进程恢复、提交核查、输出字节游标与洪泛，以及 daemon 断线、持久报告和存活 Worker 重发现，禁止依赖真实 API Key、在线模型推理或外部真实服务。中心与独立 Worker 的完整远程链路验证见 [中心文档](../server/README.md#验证)。完整入口、SQLite 与本地进程测量见 [工具说明](../../tools/README.md)。
