# 设备接入技术设计

Status: draft
Owner: Asa
Basis: [设备接入行为规格](PRODUCT.md) DS-01～DS-23；调查提交 `2b28da5`。

## Context

设备接入现在由四段独立的流程组成：

- **注册：** `apps/batond/src/daemon/cli.ts` 的 `up` 和 `register` 首次注册可使用 SEA 安装目录中的 `deployment.json`，显式参数优先。`registerNode` 在私有数据目录中保存 `coordinator_url` 与本次使用的 CA。
- **运行：** `runDaemon`、重新认证和升级检查默认使用保存的 CA，已有身份不读取安装目录的部署配置。
- **网页：** `web/src/app/EnrollDialog.tsx` 按下载清单展示 CLI 注册与服务安装命令，凭据通过 `read -rs` 写进环境变量；未配置下载时保留依赖 PATH 中 `batond` 的命令。
- **中心：** `apps/server/src/http/index.ts` 托管网页静态文件和经核验的安装包，匿名公开接口包含 `GET /api/v1/release` 与 `GET /api/v1/downloads`；`BATON_ALLOWED_ORIGINS` 同时用于检查写请求的 Origin 和按 Host 选择部署配置中的中心地址。

daemon 在私有数据目录的 `daemon-status.json` 中报告连接状态。致命失败时，`reportBatondError` 在 stderr 输出一行 JSON 后退出，凭据拒绝和版本不兼容的退出码为 78，部署配置错误与 daemon 锁占用也有独立错误码。`daemon.lock` 由 `platform/lock.ts` 管理，第二个 daemon 的 `ProcessLockBusy` 映射为 `daemon_running`。

发布流水线 `.github/workflows/release-packages.yml` 已在 macos-15、ubuntu-24.04、ubuntu-24.04-arm、windows-2025 四个原生 runner 上产出 `baton-<版本>-<平台>.tar.gz|zip`，归档顶层目录同名，内含 `release.json`。

## 架构

```
浏览器 / 桌面客户端窗口 ──HTTPS──► 中心
  │  GET /api/v1/downloads     下载清单、接入链接（匿名）
  │  GET /downloads/<文件>      CLI 包（注入部署配置并缓存）/ 客户端安装包（原样）
  │
  └ 桌面客户端 main 进程
       ├ 部署配置存储（userData/deployment.json、ca.pem）
       ├ 证书校验：只对中心 host 使用保存的 CA
       ├ preload 桥接 window.batonDesktop（只注入中心页面）
       └ batond 进程监管 ──spawn──► resources/batond/batond run --exit-with-stdin
                                        └ 写 <数据目录>/daemon-status.json
CLI 用户：解压 CLI 包 → batond register（读包内 deployment.json）→ batond service install
```

## 部署配置

中心在 CLI 包中注入、桌面客户端从接入链接保存的内容都是同一结构：

```json
{ "format": 1, "coordinator_url": "https://10.28.243.116:8443", "ca_pem": "-----BEGIN CERTIFICATE-----..." }
```

`coordinator_url` 只允许 `https` 源（scheme、host、可选端口），不带路径。`ca_pem` 可选：中心使用公共信任的证书时不提供 CA，就不写这一项。协议 Schema 放在 `packages/protocol/src/deployment.ts`，batond、中心和客户端共用。

## 中心：安装包托管（DS-01～DS-04）

**配置**

| 环境变量 | 含义 |
|---|---|
| `BATON_DOWNLOADS_DIR` | 安装包目录；未设置时不提供下载，清单返回 `enabled: false` |
| `BATON_PUBLIC_CA_FILE` | 写入部署配置和接入链接的 CA；未设置表示中心证书由公共 CA 签发 |
| `BATON_DOWNLOADS_CACHE` | 注入后 CLI 包的缓存目录，默认工作目录下的 `downloads-cache`，权限 0700 |

**目录约定**

`BATON_DOWNLOADS_DIR` 中放发布产物和同名的 `.sha256`：
- CLI 包：`baton-<版本>-<darwin-arm64|linux-x64|linux-arm64>.tar.gz`。Windows 的 zip 不提供下载。
- 桌面客户端：`baton-desktop-<版本>-darwin-arm64.dmg` 和 `baton-desktop-<版本>-win32-x64.exe`。

新模块 `apps/server/src/downloads.ts` 负责扫描、核验和注入。

**索引**

中心启动时和清单请求时扫描目录与文件属性，发现新增、删除和原地替换的安装包。对每个文件依次核验：文件名中的版本必须在 `release.supported_daemon_versions` 中，`.sha256` 存在，并且与按 size+mtime 缓存的实际哈希一致。不合格的文件写一条带原因的日志后跳过（DS-03）。

**注入**

对通过核验的 CLI 包，中心逐个流式处理：gunzip 后按 512 字节块解析 tar，核对顶层目录名和 `release.json` 中的 version 与平台；在 tar 结束块之前插入 `<顶层目录>/deployment.json`（权限 0644，mtime 取该归档里 `release.json` 的 mtime），再写结束块，并用固定压缩级别 gzip（头部 mtime 为 0）。输出写入 `<缓存目录>/<源sha256>-<配置sha256>.tar.gz`，同时生成 `.sha256`，最后原子改名。

相同输入总是产生相同字节（DS-02）。tar 按原始条目边界透传，不引入依赖。PAX 扩展头（`x`、`g`）及 GNU 长名与长链接头（`L`、`K`）保留原字节，只读取名称信息用于顶层校验和定位 `release.json`；AppleDouble 的 `._` 前缀条目不参与顶层校验。新增的 `deployment.json` 使用普通 ustar 头，原有头、内容和填充字节不变。注入在后台串行执行，完成前该文件不出现在清单中；失败任务清除去重标记，下次扫描可重试。

**对外地址**

部署配置中的中心地址按请求 `Host` 头匹配 `BATON_ALLOWED_ORIGINS` 中的同 host 源来确定，不新增配置项。没有匹配的源时，清单不列 CLI 包，`connect_url` 为空，并记录日志。注册对话框用的是 `window.location.origin`，与这个规则得到的地址相同。若同一中心配置了多个可访问的源，每个源分别生成一份缓存。

**接口**（在 `packages/protocol/src/http-api.ts` 中与 `release` 一样声明为匿名接口）

| 接口 | 响应 |
|---|---|
| `GET /api/v1/downloads` | `{ enabled, version, connect_url, ca_sha256, items: [{ kind: 'cli'\|'desktop', platform, arch, file, size, sha256 }] }` |
| `GET /downloads/<file>` | 只接受清单中列出的文件名，流式返回，带 `content-length`、`content-disposition: attachment`、`cache-control: no-cache` 和 `x-content-type-options: nosniff`；其他名字一律 404 |

`connect_url` 的格式是 `baton://connect?url=<百分号编码的源>&ca=<CA DER 的 base64url>`。文件路由与 `staticResponse` 并列，加在 `http/index.ts` 的非 `/api/` 分支前，不经过登录校验。文件响应使用 Effect 平台的文件流，按需查固定版本的源码确认 API。

## batond（DS-05～DS-11）

**部署配置读取**

新模块 `apps/batond/src/daemon/deployment.ts`。只有 SEA 运行时（`isSea()`）读取 `dirname(process.execPath)/deployment.json`；源码和 bundle 入口不读。文件缺失时视为没有部署配置；格式错误则报 `deployment_invalid` 并退出，不悄悄忽略。

**注册参数解析**（`daemon/cli.ts`）

- `--coordinator` 优先，否则用 `deployment.coordinator_url`。
- `--ca-file` 优先，否则用 `deployment.ca_pem`。
- 已有身份时完全不读部署配置（DS-07）。

**保存 CA**（DS-06）

`registerNode` 和 `reauthNode` 在写入 `identity.json` 之前，先在同一把 `identity.lock` 下用 `writePrivateFileAtomic` 写 `<数据目录>/coordinator-ca.pem`。本次没有使用 CA 时删除这个文件，让设备回到系统信任。之后由 `loadCoordinatorCA(dataDirectory, explicitFile?)` 统一取值：先用显式文件，再用保存的文件，都没有就返回 undefined。`runDaemon`、`reauthNode` 和 `checkUpgrade` 都改用这个函数。

注册时传入的 CA 被服务器证书校验通过并成功注册后才保存；重新认证成功后替换。`upgrade migrate` 的备份复制整个私有数据目录，自然包含这个文件。

**状态文件**

daemon 在连接状态变化时原子写 `<数据目录>/daemon-status.json`：

```json
{ "pid": 1234, "state": "connecting|online|rejected|stopping", "code": "node_version_incompatible", "message": "...", "updated_at": "..." }
```

- 认证成功写 `online`。
- 每次重连写 `connecting`。
- 致命失败在退出前写 `rejected`，附上 code。
- 正常停止写 `stopping`。

读取方用 `pid` 加 `daemon.lock` 判断状态是否过期。这个文件不含凭据。

**退出码和错误码**

`reportBatondError` 新增几个 code：
- `needs_reauth`：对应 `NeedsReauthentication`。
- `daemon_running`：在 `daemon.lock` 上遇到 `ProcessLockBusy`，提示服务或客户端正在运行（DS-11）。
- `deployment_invalid`：包内部署配置格式错误。

`needs_reauth` 和 `node_version_incompatible` 以退出码 78 退出，供服务管理器区分「不该重启」；其他失败仍为 1。

**`--exit-with-stdin`**

这是 `run` 的内部参数，供桌面客户端使用。开启后 stdin 读到 EOF 就触发与 SIGTERM 相同的中止路径。Windows 无法向子进程发 SIGTERM，客户端靠关闭 stdin 正常停止 batond；客户端崩溃时，管道关闭也会让 batond 退出。

**`batond identity`**

输出 `{ registered, coordinator_url, node_id, display_name, system }`，不含凭据，供客户端判断本机身份。

**`batond service install|uninstall|status`**

新模块 `apps/batond/src/daemon/service.ts`。服务定义由纯函数生成，系统命令通过可注入的 runner 执行，便于测试。

| | macOS | Linux |
|---|---|---|
| 定义文件 | `~/Library/LaunchAgents/dev.baton.batond.plist` | `~/.config/systemd/user/baton-batond.service` |
| 启动 | `ProgramArguments=[可执行文件, run, --data-dir, 目录]`，`RunAtLoad`，`KeepAlive.SuccessfulExit=false`，`ThrottleInterval=30` | `ExecStart=… run --data-dir …`，`Restart=on-failure`，`RestartSec=5`，`RestartPreventExitStatus=78`，`WantedBy=default.target` |
| 日志 | `StandardOutPath` 和 `StandardErrorPath` 指向 `<数据目录>/logs/batond.log` | `StandardOutput=append:` 和 `StandardError=append:` 指向同一文件 |
| 安装命令 | `launchctl bootout`（忽略未加载）后 `launchctl bootstrap gui/<uid> <plist>` | `systemctl --user daemon-reload` 后 `enable --now`，再 `restart` |
| 状态 | `launchctl print gui/<uid>/dev.baton.batond` | `systemctl --user show -p ActiveState,MainPID,ExecStart`；`loginctl show-user <user> -p Linger` |

- **安装前提：** 设备必须已注册；可执行文件路径用 `realpath(process.execPath)`。
- **原子安装：** 定义文件先写临时文件再改名；systemctl 或 launchctl 失败时恢复原来的定义文件，原来没有就删除（DS-10）。
- **单一服务：** 每个系统用户只有一个服务；用另一个数据目录安装会替换原服务。
- **无法安装的情况：** Linux 上 `systemctl --user` 不可用，或拿不到 `XDG_RUNTIME_DIR`，就报 `service_unavailable`；Windows 上报 `service_unsupported`，并提示使用桌面客户端。
- **状态输出：** `service status` 返回 `installed`、`running`、`program_path`、`log_path` 和 `daemon`。路径取自已安装的定义，不取调用时的 `--data-dir`；`daemon` 从该服务数据目录的 `daemon-status.json` 读取，未安装时使用 `--data-dir`。文件缺失、不可读或内容无效时 `daemon` 为 null。有效时包含 `pid`、`state`、`updated_at` 和可选的 `code`、`message`，其中状态沿用 `connecting|online|rejected|stopping`；另附 `stale`，锁不存在、锁属主 PID 与快照不同或锁属主进程已退出时为 true，锁无法核实时也为 true。过期快照保留最后的拒绝原因，服务当前是否运行仍以 `running` 为准。Linux 额外返回 `linger`（无法查询时为 null）；未开启或无法查询时在顶层 `message` 中说明。
- **launchd 限制：** launchd 不能按退出码阻止重启，所以 78 退出后仍会每 30 秒拉起一次；`service status` 的 `daemon` 附上最后的拒绝原因与错误码。

## 网页（DS-12～DS-14）

**数据层**

`web/src/data` 新增 `getDownloads` 查询；mock 客户端提供带下载和不带下载的两种场景。

**注册对话框**（普通浏览器）

清单 `enabled` 并且有对应平台的 CLI 包时，`registerCommand` 生成：

```sh
tar xzf baton-v0.1.0-linux-x64.tar.gz && cd baton-v0.1.0-linux-x64
read -rs BATON_ENROLLMENT_TOKEN && export BATON_ENROLLMENT_TOKEN
./batond register --display-name "…" && ./batond service install
```

对话框同时显示下载链接、SHA-256 和 `curl -fLk -O <链接>`。用 `-k` 是因为此时还没有信任 CA；校验靠对话框上显示的 SHA-256。选择 Windows 时显示客户端下载。清单未启用时，保留现有命令。重新认证的命令改为 `./batond reauth && ./batond service install`。

**接入链接**

清单有 `connect_url` 且页面不在客户端中时，Devices 页面显示「在客户端中打开」，以普通链接打开 `connect_url`。

**桌面模式**

检测到 `window.batonDesktop?.protocol === 1` 时，注册对话框改为单按钮流程：
1. 调用现有的 `useCreateEnrollment` 领取凭据（重新认证调用 `issueReauthEnrollment`，节点 ID 取自 `batonDesktop.status().node_id`）。
2. 调用 `batonDesktop.enroll({ code, displayName })` 或 `reauth({ code })`，然后像现在一样轮询 `useEnrollment` 的状态。

凭据只在内存中传递，不渲染到页面。

## 桌面客户端 `apps/desktop`（DS-15～DS-23）

**技术选型**

- 框架：Electron。
- 打包：electron-builder，mac 出 dmg，Windows 出按用户安装、无需管理员的 NSIS 安装包。
- 编译：main 和 preload 用 TypeScript 写，由 esbuild 打成 CJS，与 batond bundle 的工具链一致。
- 说明页：未配置时显示的是本地静态 `setup.html`，不加载网页前端。

依赖安装沿用 `--ignore-scripts`，CI 和单元测试都不下载 Electron 二进制；打包时由 electron-builder 下载 Electron，可用 `ELECTRON_MIRROR` 指定镜像。

| 模块 | 职责 |
|---|---|
| `src/deployment.ts` | 读写 `userData/deployment.json` 与 `ca.pem`（0600）；解析和校验接入链接：只接受 https 源，CA 必须可解析且 `basicConstraints` 为 CA，链接不超过 8KB |
| `src/link.ts` | 单实例锁。macOS 处理 `open-url`，Windows 处理 `second-instance` 的 argv，`setAsDefaultProtocolClient('baton')`；用原生对话框显示源和 SHA-256 指纹，由用户确认；已有身份且源不同时拒绝替换（DS-15、DS-16） |
| `src/trust.ts` | `session.setCertificateVerifyProc`：host 与保存的源一致时，用 Node `X509Certificate` 沿 `issuerCert` 链校验签名、有效期和 `checkHost`/`checkIP`，链最终由保存的 CA 签发才放行；其他 host 返回 `-3`，交给系统校验（DS-17） |
| `src/window.ts` | `contextIsolation`、`sandbox` 开启，`nodeIntegration` 关闭。`will-navigate` 和 `setWindowOpenHandler` 把非中心源交给 `shell.openExternal`；关闭窗口改为隐藏（DS-20） |
| `src/preload.ts` | 仅当 `location.origin` 等于保存的源时，通过 `contextBridge` 暴露 `batonDesktop`：`{ protocol: 1, version, status(), onStatus(cb), enroll(input), reauth(input) }` |
| `src/bridge.ts` | main 端 IPC 处理；每次调用都核对 `event.senderFrame.url` 的源，不符就拒绝 |
| `src/batond.ts` | 解析内置 batond 的路径（`process.resourcesPath/batond/batond(.exe)`）；`identity()` 调用 `batond identity`；`enroll()` 以子进程运行 `register --coordinator <源> --ca-file <userData/ca.pem> --display-name …`，凭据只通过子进程环境变量 `BATON_ENROLLMENT_TOKEN` 传入；`reauth()` 同理 |
| `src/supervisor.ts` | 运行 `batond run --exit-with-stdin`，stdout 和 stderr 写入 `<数据目录>/logs/desktop-batond.log`（超过 10MB 轮转一份）；退出码 78 或末行 code 为终止类时停止重启，显示原因；其他退出按 1s→30s 退避重启，60 秒内连续失败 5 次则停止。`daemon_running` 时进入「外部运行」模式，读状态文件，并每 30 秒重试接管。退出客户端时关闭 stdin，等待 15 秒 |
| `src/status.ts` | 合并 supervisor 状态与 `daemon-status.json`，推送给托盘和桥接 |
| `src/tray.ts` | 状态文本，菜单项为打开窗口、重启 batond、打开日志目录、登录时启动（勾选）、退出（DS-22） |
| `src/autostart.ts` | `app.setLoginItemSettings`，默认开启；以登录项启动时隐藏窗口（DS-21） |

**身份规则**（DS-19）

客户端启动时先运行 `batond identity`：
- **未注册：** 等待网页发起接入。
- **已注册且 `coordinator_url` 等于保存的源：** 直接启动监管。
- **已注册但源不同：** 显示冲突，不启动，也不改保存的配置。

数据目录使用 batond 默认的 `~/.baton-ts`，与 CLI 共用。

**打包布局**

`tools/package-desktop.mjs --batond <batond 安装目录> --out <目录>` 把整个 batond 安装目录作为 `extraResources` 放到 `resources/batond/`，生成 `baton-desktop-<版本>-<平台>.<dmg|exe>` 及 `.sha256`。客户端版本取 batond 的 `release.json`，保证与 batond 一致。

macOS 的应用整体做临时签名，内置的 batond 保留自身的临时签名。发布流水线在 macos-15 和 windows-2025 两个 job 中，于 batond 打包之后运行 `package-desktop`，产物与 CLI 包一同上传。

**升级**（DS-23）

替换应用后，`userData` 与数据目录保持不变。中心以版本不兼容拒绝时，托盘显示状态文件中的 code，并打开中心下载页。需要数据迁移的升级不在客户端首版处理。

## Testing and validation

| Requirement | Setup and observation | Failure condition | Where | Status |
|---|---|---|---|---|
| DS-02、DS-03 | 使用发布脚本相同的系统 tar 参数生成归档，另测 ustar 和 GNU 长名；注入两次并比较原 tar 条目字节及解包内容；目录中放版本、哈希、顶层名和 release 平台不符的包 | 两次输出字节不同，解包后除 `deployment.json` 外有变化，不合格的包出现在清单中 | `apps/server` 单元 + 集成 | implemented |
| DS-01、DS-02 | 中心集成测试启用下载，匿名请求清单与文件，变换 Host | 需要登录；清单哈希与下载内容不一致；未列出的文件名能被下载；Host 不匹配时仍生成部署配置 | `apps/server` 集成 | implemented |
| 后台注入重试 | 注入函数首次报临时错误；再次扫描同一源包与部署配置 | 恢复后仍不重试或包不能进入清单 | `apps/server` 单元 | implemented |
| DS-05～DS-07 | 用注入的 transport 注册和重新认证；SEA 场景用临时目录模拟 `deployment.json` | 未保存或未替换 CA；已有身份时读了部署配置；显式参数没有优先 | `apps/batond` 单元 | implemented |
| DS-08～DS-10 | 生成 plist 和 unit 文本；用替身 runner 验证重复安装替换、命令失败回滚、状态查询、daemon 快照读取与过期判断、卸载保留数据 | 定义缺少参数；失败后残留或覆盖了原定义；状态遗漏拒绝原因；快照缺失或损坏导致查询失败；卸载删除数据目录 | `apps/batond` 单元 | implemented |
| DS-11 | 持有 `daemon.lock` 时运行 `run` | 没有输出 `daemon_running` | `apps/batond` 单元 | implemented |
| 状态文件、`--exit-with-stdin` | 复用 `reconnect.test.ts` 的协议替身检查认证、拒绝和停止状态；CLI 单元测试检查 stdin EOF 触发中止，中心 e2e 检查连接与停止状态 | 状态缺失或不准；关闭 stdin 后 daemon 不退出 | `apps/batond` 单元 + `e2e` | implemented |
| DS-12、DS-13 | 渲染有无下载、各平台和重新认证的注册对话框，以及 Devices 页的接入链接 | 下载命令包含凭据或部署参数；无下载时旧命令丢失；Windows 显示 CLI 命令；客户端中的页面仍显示接入链接 | `web` 单元 | implemented |
| DS-14 | 渲染桌面桥接替身下的注册对话框与本机接入入口 | 桌面模式显示命令或凭据被渲染 | `web` 单元 | planned |
| DS-15～DS-17 | 测试数据中固定一套 CA、叶子和其他 CA 签发的叶子（附生成命令）；测试链接解析和证书校验 | 接受 http 源或非 CA 证书；非中心 host 使用了保存的 CA；用其他 CA 签发的叶子通过校验 | `apps/desktop` 单元（Node，不启动 Electron） | planned |
| DS-18～DS-20 | supervisor 使用替身 spawn：正常退出、78、反复崩溃、`daemon_running`、退出流程 | 终止类失败仍重启；退避或次数上限不对；退出时没有关闭 stdin | `apps/desktop` 单元 | planned |
| CLI 全链路 | 现有 HTTPS e2e 中心，在数据目录外注入安装目录与 `deployment.json`，不带中心地址和 CA 参数注册并连接 | 必须传 `--coordinator` 或 `--ca-file` | `e2e` | implemented |
| DS-08、DS-09 launchd | macOS arm64 上用开发 bundle、临时数据目录与离线身份执行 install → status → uninstall；连接地址仅指向本机不可用端口 | 状态未显示运行、程序或日志路径不符、卸载后仍有服务定义或 daemon、身份与日志被删除 | 手动，结果见 release TECH「验证」 | manual |
| systemd、客户端安装与常驻 | 在 Debian 12、macOS arm64、Windows 11 上按 PRODUCT 验收表手动执行 | 任一验收行不符 | 手动，结果写入 release TECH | planned |

自动化测试不下载 Electron，也不访问外部服务。系统服务和桌面集成依赖真实系统，只做手动验证，未测的平台如实记录。

## 实施顺序

1. 部署配置 Schema、batond 读取部署配置和保存 CA、`identity` 命令、状态文件、错误码、`--exit-with-stdin`。客户端和 CLI 都依赖这一步。
2. 中心安装包托管与注入、下载接口，以及网页注册对话框的 CLI 部分。
3. `batond service`。
4. `apps/desktop`、网页桌面模式、`package-desktop` 与发布流水线。

第 2～4 步只依赖第 1 步，可以并行。

## Open questions

- electron-builder 在 macOS 上做临时签名后，内置 batond 的签名是否保持有效、能否正常运行，需要在第 4 步首次打包时实测。若失效，改为在打包后对 batond 重新做临时签名。不阻塞前三步。
- Windows 上 Electron 启动的 batond，在客户端被强制结束时，Worker 是否随 Job Object 一起退出，沿用 [发布 TECH](../release/TECH.md) 记录的 Windows 进程回收边界，手动验证时记录结果。
