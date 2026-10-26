# 打包与发布技术设计

Status: implemented
Basis: [Baton TECH](../baton/TECH.md)；[Agent 适配 TECH](../agent-adapters/TECH.md)；[构建与发布工具](../../tools/README.md)。

## 打包与发布

中心使用 Node 26 运行 esbuild bundle；设备端使用携带 Node 的 SEA 安装包。发布目标为 macOS arm64、Linux x64、Linux arm64 和 Windows x64。开发与验证命令见 [AGENTS.md](../../AGENTS.md)，各脚本参数见 [tools/README.md](../../tools/README.md#构建打包与发布)。

| 产物 | 内容与运行方式 |
|---|---|
| 中心 bundle | `apps/server/dist/server.cjs`，相邻的 `web/` 与 `migrations/`；构建自动生成网页并复制根目录的 SQL 迁移 |
| 中心镜像 | `node:26-bookworm-slim`，包含中心 bundle、网页与迁移；由非 root 的 `baton` 用户在专用数据目录运行，配置见根 README 与 `compose.yaml` |
| 节点开发 bundle | `apps/batond/dist/batond.cjs`；通过已安装的 Node 与 workspace 依赖运行，Project Runtime 从源码入口启动 |
| 节点安装包 | `batond`（Windows 为 `batond.exe`）、旁置 `node_modules/`、`licenses/`、`package.json`、`package-manifest.json` 与 `INSTALL.md`；设备无需另装 Node |
| 发布归档 | `baton-<带 v 前缀的版本>-<平台>.tar.gz`（Windows 为 `.zip`），附 SHA-256 文件和安装包检查 JSON；归档内另有 `release.json` |

[统一构建入口](../../tools/build.mjs) 从根 workspace 安装锁定依赖，检查网页类型，构建中心与节点 bundle，再生成 `bin/` 安装包。[节点打包器](../../tools/package-batond.mjs) 使用支持 `--build-sea` 且保留 LICENSE 的官方 Node 26，默认使用执行脚本的 Node；也可通过 `--node` 指定目标平台的官方 Node。跨系统构建由宿主 Node 将 bundle 注入目标可执行文件，目标平台依赖必须已安装。macOS 安装包必须在 macOS 上完成 ad-hoc 签名；最终检查与归档在目标平台运行。

SEA 不启用 code cache 或 snapshot，`execArgvExtension` 设为 `none`。Worker、watchdog、agent-host 和 Project Runtime 都通过自身可执行文件的子命令启动，Runtime 业务代码包含在同一 bundle 中。Runtime stdio 使用 `BATON_PROJECT_RUNTIME_TRANSPORT=stdio`，Runtime 在自身进程内读写凭据。

### 依赖与许可

完整 `@cursor/sdk` JavaScript、生产依赖与当前系统及架构的平台包放在可执行文件旁的 `node_modules/`，由 SEA 通过 `createRequire` 加载。`@napi-rs/keyring` 及其平台原生模块同样外置。Pi 的 `pi-ai`、`pi-agent-core` 保留磁盘上的 ESM 文件、模型数据与 OAuth 动态模块，构建时解析入口，SEA 运行时从附带目录加载。

[依赖复制器](../../tools/package-dependencies.mjs) 沿已安装的生产、peer 与可选依赖图复制物理文件，按目标系统、架构及 glibc 筛选平台包；相同依赖提升复用，冲突版本保留在调用方自己的 `node_modules/`。必需依赖缺失时直接失败。节点打包器不下载 Node 或依赖，产物不依赖源码目录或 pnpm store 链接。

`package-manifest.json` 记录 SEA 格式、目标平台、架构、Node 版本、附带依赖的名称、版本与相对路径，以及已打入 bundle 的包。`licenses/` 包含 Node LICENSE、t3code LICENSE、依赖包提供的许可声明和 Cursor 来源说明。Cursor 的包来源、integrity 与分发条款见 [Cursor SDK](../../third_party/cursor-sdk/README.md)。

### 官方 Node 输入

[Node 缓存工具](../../tools/release/cache-node.mjs) 仅在显式指定 `--download` 时通过 HTTPS 获取 nodejs.org 的官方归档与 `SHASUMS256.txt`，校验 SHA-256 后解包，并保留 LICENSE。缓存根目录可通过 `BATON_NODE_CACHE` 覆盖；离线输入缺失时给出下载命令。工具未核验发布者的离线签名。

已有 Node 26.11.1 归档校验记录如下，缓存操作用法见 [官方 Node 缓存](../../tools/README.md#官方-node-缓存)。这些记录不表示其他环境中已存在相应缓存。

| 官方归档 | SHA-256 |
|---|---|
| `node-v26.11.1-darwin-arm64.tar.gz` | `d916511b55965e91be7a88e17f88d895b6793ceaba3e6c9b194aefe51c2c65ac` |
| `node-v26.11.1-linux-arm64.tar.gz` | `170454fb022f5e9b5f6cc76c25fa32ef5100895be44eb04e92f9780591491bbf` |

### 发布流水线与归档

[发布工作流](../../.github/workflows/release-packages.yml) 由 `workflow_dispatch` 接收带 `v` 前缀的版本号，在 `macos-15`、`ubuntu-24.04`、`ubuntu-24.04-arm` 与 `windows-2025` 上原生构建，固定 Node 26.11.1 和 pnpm 12.11.2。Linux 执行包含本地 PostgreSQL 的工作区测试与中心构建；macOS、Windows 执行节点与 Project Runtime 测试。自动化验证使用离线转录、本地替身与本机资源。

每个平台依次执行安装包构建、搬迁检查、100 个 Worker 冷启动样本与 2000 次 FULL 账本操作，Windows 另执行进程机制检查，然后归档并验证解压产物。构建、检查、测量 JSON 与测试日志作为工作流产物上传。Windows 节点与 Runtime 测试步骤允许失败后继续打包；安装包检查失败仍会阻止后续测量与归档。工作流上传产物，不自动创建 GitHub Release。

[归档器](../../tools/package-release.mjs) 只复制可执行文件、附带依赖、许可及规定的元数据，校验帮助、SEA 平台与版本、安装包清单。`release.json` 记录版本、源码提交、工作区是否有修改、目标平台、构建 Node 与 SEA Node。Unix 生成 tar.gz，Windows 使用系统 bsdtar 生成 zip，并校验文件头。最终归档重新解压后，再检查布局、清单、发布元数据并运行完整安装包检查，通过后才写出归档、SHA-256 与检查报告。

## 安装包检查

[安装包检查入口](../../tools/check-package.mjs) 与归档器共用 [安装布局规则](../../tools/lib/installation.mjs)：可执行文件必须是非空普通文件，POSIX 上有执行权限，依赖与许可目录非空，包内链接必须解析到包内。检查将安装包复制到临时目录，以空 PATH、临时 HOME 和包外工作目录运行，不继承 provider 凭据与个人配置路径；Windows 保留系统命令所需的环境变量。

| 检查 | 观察与失败条件 |
|---|---|
| 帮助与版本 | 帮助包含 Baton 命令；版本报告 `sea=true`、当前系统与架构、有效 Node 版本 |
| Worker | 真实 `LocalWorkerHost` 启动一个 SEA Worker，认证 status 达到 `worker_ready=true` 且 `agent_ready=false`；错误 IPC 令牌被拒绝，独占锁与创建时间匹配，实际账本表和 WAL 已持久化；从 spawn 到认证 status 必须小于 Host 就绪预算（Windows 10 秒，其余系统 3 秒） |
| 清理 | POSIX 发送 SIGTERM 后确认 Worker 与 watchdog 退出、锁释放；Windows 核对 CIM 身份后执行 `taskkill /T /F`，确认退出与锁已失效，报告 `graceful=false` |
| Agent host | SEA 的 `agent-host --probe` 实际加载 Cursor、Pi、Codex、Kiro 四个模块，加载 keyring，并用 tree-sitter 与 Bash grammar 解析 `echo baton` |
| Cursor SQLite store | 隔离的 Node 子进程从搬迁安装包 `createRequire` 加载 `@cursor/sdk/sqlite`，打开并关闭临时 store；该检查由运行工具的 Node 执行 |
| Cursor 程序 | 直接运行包内 ripgrep `--version` 与 sandbox helper `--help`；核对退出码和输出 |
| Project Runtime | 通过 stdio 回应 `bootstrap`、空 `read_events`，在 `claim_inputs` 返回本地结束响应后核对 Runtime 退出码为 1；不交付输入，模型调用次数为 0 |
| 订阅凭据 | 在临时 HOME 写入本地凭据样例；订阅报告识别登录状态且不泄漏凭据值 |
| 缺失依赖 | 临时移走 `node_modules/` 后，Agent host 检查必须非零退出、无成功输出，并明确指出安装包依赖缺失 |

各项检查输出独立结果，任一失败使总结果 `passed=false` 并非零退出。调用方式及预构建驱动参数见 [安装包检查](../../tools/README.md#安装包检查)。工具与测量驱动需要 Node 26，被测 SEA 自带 Node；预构建驱动应与安装包使用同一源码版本。

Cursor store 子进程禁用 fetch 和 HTTP(S) 请求。上述加载检查不调用 `Agent.create`、`resume`、`send`，sandbox helper 的帮助输出仅证明程序能加载。认证、会话行为与停止语义由 [Agent 适配验证](../agent-adapters/TECH.md#验证策略) 覆盖，安装包模块检查与生产能力探测分别记录结果。Agent 可用性按上游安装与认证检查开放，缺少系统或版本的验证证据不增加白名单限制。

## 测量结果

macOS 与 Linux 数值来自发布工作流 run `40186351668`（源码提交 `3eba953`），使用官方 Node 26.11.1 与 GitHub 托管 runner，原始构建产物未重新复核。Windows 数值来自 Windows Server 2022 本机的当前源码与 Node 26.11.1，不替代 Windows Server 2025 runner 验证；复现方法见 [Worker 启动与 FULL 账本测量](../../tools/README.md#worker-启动与-full-账本测量)。

### FULL 同步账本

测量驱动在独立 Node 进程中运行由源码构建的真实 `makeWorker` 串行队列，预热 200 次后交替执行 2000 次 `records.add/remove`，每次事务后让出事件循环。测量包含实际账本、提交 token 核查与状态队列，COMMIT、完整队列操作和事件循环延迟分别统计。该项与 SEA Worker 冷启动分别执行，驱动源码应与安装包提交一致。

| 系统与 runner | COMMIT p99（ms） | COMMIT 最大（ms） | 队列操作 p99（ms） | 事件循环 p99（ms） |
|---|---:|---:|---:|---:|
| macOS arm64，`macos-15` | 0.528 | 3.984 | 1.445 | 3.019 |
| Linux x64，`ubuntu-24.04` | 0.579 | 5.694 | 1.297 | 2.480 |
| Linux arm64，`ubuntu-24.04-arm` | 0.467 | 3.985 | 0.855 | 1.544 |
| Windows x64，Windows Server 2022 本机，受限 Administrator 令牌 | 5.647 | 86.447 | 6.031 | 6.038 |

四个已测平台在此负载下 COMMIT p99 低于 50 ms，Windows 最大值仍超过 50 ms。测量使用 WAL、`synchronous=FULL`、`fullfsync=0`，未做断电验证；负载不含 Agent、IPC、prompt、输入 intent 或大队列，无法据此推断全部命令接收延迟。当前测量工具在 COMMIT p99 超过 50 ms 时非零退出；若测量或实际命令接收延迟超标，需提前评估将账本移入 `worker_threads`。

### SEA Worker 冷启动

完整安装包搬到临时目录，每平台启动 100 个新 Worker，每次使用新 Thread 与 SQLite 文件，空 PATH、临时 HOME。计时从真实 Host 的 spawn 前开始，到外部调用方收到最终认证 status 为止，包含就绪轮询、启动锁释放和 status 往返；Host 总耗时另包含数据目录与令牌准备。

| 系统 | spawn 到认证 status p99（ms） | spawn 到认证 status 最大（ms） | Host 总耗时最大（ms） |
|---|---:|---:|---:|
| macOS arm64 | 1201.209 | 1323.326 | 1357.314 |
| Linux x64 | 895.012 | 945.773 | 950.690 |
| Linux arm64 | 754.205 | 996.420 | 1000.820 |
| Windows x64 | 未测 | 未测 | 未测 |

macOS 与 Linux 的全部样本低于 3 秒，每次确认 SIGTERM 后 Worker、watchdog 退出与锁释放。Windows 尚无当前实现的冷启动样本。记录覆盖独占锁、实际 SQLite 建表、空账本恢复调度、该提交的 Agent 接入模块加载与 watchdog；当前构建检查强制 Worker 运行时依赖图隔离 SDK 和 host 实现，表中数值仅适用于所标明的测量提交。

系统页缓存未清空，macOS runner 为虚拟化 Apple M1。就绪状态为 `agent_ready=false`，测量没有打开 Agent 会话，也未覆盖已有大量命令或 intent 的恢复耗时。

### Cursor 加载证据

固定公开包为 `@cursor/sdk@1.0.35`，要求 Node `>=22.13`，安装禁用生命周期脚本。可行布局为完整 SDK、生产依赖与平台包旁置，由 SEA `createRequire` 加载。macOS arm64 的 SDK、SQLite store、tree-sitter/Bash 原生扩展、ripgrep 与 sandbox helper 帮助检查已有通过记录；移走附带依赖时能明确失败。

Linux arm64 的 SDK、store、tree-sitter 与 ripgrep 已有通过记录；Debian 12 / glibc 2.36 无法加载要求 `GLIBC_2.39` 的 sandbox helper，该组合的完整安装包检查失败。Linux arm64 的 Cursor helper 要求 glibc 2.39+。Ubuntu runner 的测量结果与 Debian 12 的 helper 失败分别属于各自环境，不能互相替代。Fedora 43 的本地加载证据待补。

Windows Server 2022 本机通过四个 Agent 与原生模块加载，以及 Cursor store、ripgrep、sandbox helper 的独立检查，完整安装包检查待在当前实现上复验。Linux x64 的安装包检查已有通过记录；其 Cursor store、ripgrep 与 sandbox helper 的独立检查尚缺可核实的运行结果，不能由模块导入成功推断它们全部通过。Cursor 来源与加载方案的限制见 [SDK 说明](../../third_party/cursor-sdk/README.md)。

## Windows 待修与待验证

Windows 私有目录不设置或校验 ACL，沿用数据目录继承的权限。默认数据目录 `%USERPROFILE%\.baton-ts` 和临时目录都在用户目录下，Windows 默认只授权当前用户、SYSTEM 与 Administrators；把数据目录放到其他用户可读的位置时，由设备用户自行负责权限。Worker 准备因此不再启动 PowerShell 或 `icacls`，Project Runtime 读写凭据也不再启动子进程。

Windows 本机上节点、中心与 Runtime 测试全部通过，统一构建（含 SEA）成功。测试配置在 Windows 上把超时放大 4 倍、同时运行的测试文件限为 2 个；4 个靠重命名仍被打开的目录来构造祖先替换的测试在 Windows 上跳过，因为系统拒绝这种重命名。全量运行时 Worker 的一个 TestClock 竞争测试偶发失败，单独运行通过。完整安装包检查、冷启动与 FULL 测量和 Windows 进程检查（`Grandchild missing before taskkill`）待验证；Windows Server 2025、普通本地用户的完整 workspace 测试与实际 PID 复用也待验证。

[Windows 进程脚本](../../tools/verify/windows-processes.mjs) 使用自有的 CIM 校验与 `taskkill` 包装，观察完整父子孙树、故意过期的创建时间，以及中间父进程退出后的孙进程。它检查系统机制，未调用生产 reaper，不强迫系统实际复用 PID，也不验证 Worker 崩溃到下一次启动之间的回收延迟；非 Windows 输出 `not-measured`。

第一版的 Windows 平台边界为：`taskkill /T` 可能漏掉中间父进程先退出后的后代；Worker 崩溃后 Agent 可能运行到下一次 Worker 启动；CIM 身份核对与终止之间存在竞争窗口。私有目录沿用数据目录继承的 ACL，不做 DACL 与 reparse point 检查；命名管道使用 Node 默认安全描述符，依靠私有令牌认证。实现与恢复约束见 [平台实现](../../apps/batond/src/platform/README.md) 与 [进程回收设计](../agent-adapters/TECH.md#进程组与停止回收)。

## 第一版之后

| 项目 | 条件与范围 |
|---|---|
| Windows Job Object 与逐句柄 DACL 检查 | 通过专用原生模块接入平台层，补足回收与文件访问边界 |
| Windows 命名管道限定当前用户 | 通过原生安全描述符设置收紧访问范围 |
| 包内编译升级到 TypeScript 7 | 当前包内编译器为 TypeScript 6.0.3；Vite+ 已使用 TypeScript Go 检查 |
| Worker 账本移入 `worker_threads` | 按实际测量决定；若 FULL 提交 p99 或命令接收延迟超标，提前处理 |
| 跨设备输出与控制延迟、容量压测阈值 | Baton 验证表 R-16、R-24 与 Q5 的负载阈值留待第一版之后；500 台设备、100 个执行中 Thread、24 小时是待测场景，当前无容量达标结论 |
