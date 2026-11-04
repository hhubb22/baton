# 设备接入技术设计

Status: draft
Owner: Asa
Basis: [设备接入行为规格](PRODUCT.md) DS-01～DS-17；调查提交 `9c003f8`。

## 全景与架构

员工设备通过标准系统信任 TLS（HTTPS / WSS）连接中心，使用统一的设备码登录（Device Code Flow）完成身份绑定。每台设备在同一数据目录下只运行一个后台 `batond` 守护进程，对外暴露受令牌保护的本地控制通道（POSIX Unix Domain Socket / Windows Named Pipe）；CLI 与桌面客户端均只作为该控制通道的客户端，并在守护进程未运行时按需在后台拉起它。

```text
浏览器 / 桌面客户端窗口 ── HTTPS（系统根证书库校验）──► Coordinator（apps/server）
  │  GET  /api/v1/downloads                         匿名下载清单与 baton://connect?url=...
  │  GET  /downloads/<file>                         静态安装包流式下载
  │  POST /api/v1/device-auth/sessions/:id/approve  已登录员工确认设备码
  │
CLI 命令 / 桌面客户端 main 进程
  └─ ControlClient（按需持有 autostart.lock 后台拉起 batond）
       │  本地控制通道（UDS / Named Pipe + control.token）
       ▼
     batond（唯一守护进程，持有 daemon.lock）
       ├─ POST /api/v1/device-auth/{sessions,token} 发起与轮询设备码换取长效凭据
       └─ WSS  /v1/node                             长效凭据连接中心与业务同步
```

节点连接仅使用操作系统根证书库校验的 HTTPS / WSS，设备授权统一经中心设备码会话颁发长效可吊销凭据，本机 CLI 与桌面客户端统一通过本地控制通道与唯一 `batond` 交互。

## 1. 中心：安装包托管与接入链接（DS-01～DS-03）

`apps/server/src/downloads.ts` 扫描 `BATON_DOWNLOADS_DIR`（未设置时返回 `enabled: false`），核验与当前中心发布版本一致的安装包及相邻 `.sha256` 文件，不合格项跳过并记日志：

- CLI 归档：`baton-<版本>-<darwin-arm64|linux-x64|linux-arm64>.tar.gz`
- 桌面安装包：`baton-desktop-<版本>-darwin-arm64.dmg`、`baton-desktop-<版本>-win32-x64.exe`

| 匿名接口 | 契约与行为 |
|---|---|
| `GET /api/v1/downloads` | 返回 `{ enabled, version, connect_url, items: [{ kind: 'cli' \| 'desktop', platform, arch, file, size, sha256 }] }` |
| `GET /downloads/<file>` | 仅允许清单已收录文件名；原样流式返回，附 `content-length`、`content-disposition: attachment`、`cache-control: no-cache`、`x-content-type-options: nosniff`，其余路径返回 404 |

`connect_url` 按请求 `Host` 匹配 `BATON_ALLOWED_ORIGINS` 中的 HTTPS 源生成 `baton://connect?url=<encodeURIComponent(origin)>`；无匹配 HTTPS 源时 `connect_url` 为 `null`，安装包仍可下载。

## 2. 设备码登录协议（DS-04～DS-07）

### 2.1 数据表 `device_login_sessions`

中心使用 `device_login_sessions` 表记录短期设备码登录会话：

| 列 | 类型与约束 | 说明 |
|---|---|---|
| `id` | `UUID PRIMARY KEY` | 登录会话标识 |
| `device_code_hash` | `BYTEA NOT NULL UNIQUE` | 256-bit 随机 `device_code` 的 SHA-256，明文仅返回给发起方 `batond` 内存保存 |
| `user_code` | `TEXT NOT NULL` | 去歧义 Base32 短码（如 `ABCD-EFGH`），在未过期的 `pending` 会话内唯一 |
| `display_name` | `TEXT NOT NULL` | 1～80 字符设备显示名 |
| `system` | `TEXT NOT NULL` | `macos` \| `linux` \| `windows` |
| `status` | `TEXT NOT NULL` | `pending` \| `approved` \| `consumed` \| `denied` \| `expired` |
| `employee_id` | `UUID REFERENCES employees(id)` | 浏览器确认时写入 |
| `node_id` | `UUID` | 浏览器确认创建设备时写入 |
| `created_at` / `expires_at` | `TIMESTAMPTZ NOT NULL` | 默认有效期 600 秒，以 PostgreSQL `clock_timestamp()` 判定 |
| `consumed_at` | `TIMESTAMPTZ` | `batond` 首次换取凭据的时间 |

### 2.2 HTTP 接口契约

Schema 定义在 `packages/protocol/src/device.ts` 与 `http-api.ts`：

| 接口 | 鉴权 | 行为与幂等规则 |
|---|---|---|
| `POST /api/v1/device-auth/sessions` | 匿名（按 IP 限流 20 次/分钟） | 输入 `{ display_name, system }`；创建 `pending` 会话并返回 `{ session_id, device_code, user_code, verification_uri, verification_uri_complete, expires_at, expires_in_seconds: 600, interval_seconds: 2 }` |
| `GET /api/v1/device-auth/sessions/by-code/:userCode` | 员工会话 | 忽略大小写与连字符规范化 `userCode`；查找未过期的 `pending` 会话返回 `{ session_id, user_code, display_name, system, expires_at }`，不存在或已过期返回 404/410 |
| `POST /api/v1/device-auth/sessions/:id/approve` | 员工会话 + Origin + CSRF | 核对 `{ user_code }` 与 `pending` 未过期状态；单事务创建 `nodes`、`node_credentials`（长效无过期时间，版本 1）、初始化员工默认设备（若尚无）并将状态置为 `approved` |
| `POST /api/v1/device-auth/sessions/:id/deny` | 员工会话 + Origin + CSRF | 将未过期的 `pending` 会话置为 `denied` |
| `POST /api/v1/device-auth/token` | 匿名（校验 `device_code` 摘要） | 输入 `{ session_id, device_code }`。未确认返回 `{ status: 'pending', interval_seconds: 2 }`；已拒绝或过期返回 `denied` / `expired`；`approved` 时原子置为 `consumed`，按持久化的 `(node_id, credential_id, version, issued_at)` 签发 Ed25519 JWT 并返回 `{ status: 'approved', identity: NodeIdentity }`。若网络中断导致响应丢失，在原会话 `expires_at` 前且节点未吊销时用同一 `device_code` 重试会确定性返回同一份 `NodeIdentity` |

所有中心与节点 HTTPS / WSS 请求均直接使用操作系统根证书库验证服务端 TLS 证书（DS-07）。

## 3. 单一后台 `batond` 与本地控制通道（DS-08～DS-09）

### 3.1 锁、控制端点与生命周期

`apps/batond/src/daemon/control.ts` 复用 `daemon/ipc.ts` 的 `listenAuthenticated` / `requestAuthenticated`（帧上限 256 KiB，常量时间令牌比对）：

- **排他锁**：`<data-dir>/daemon.lock`（`platform/lock.ts`），保证同一数据目录最多一个 `batond` 实例。
- **控制端点**：
  - POSIX：优先 `<data-dir>/ipc/ctl-<hash20>.sock`；若路径超过 Unix Socket 103 字节上限，回退到 `$XDG_RUNTIME_DIR/baton/ctl-<hash20>.sock` 或当前用户 `0700` 私有目录 `/tmp/baton-<uid>/ctl-<hash20>.sock`。
  - Windows：`\\.\pipe\baton-ctl-<hash24>`。
- **认证令牌**：`batond` 取得 `daemon.lock` 后原子写入 `0600` 私有文件 `<data-dir>/control.token`，随后监听控制端点。
- **连接状态机**：`batond` 常驻监听本地控制通道，不在未绑定或认证被拒时退出进程；内存状态机维护 `unbound`、`authorizing`、`connecting`、`syncing`、`online`、`rejected` 六种状态。中心返回 `credential_revoked` 或 `node_version_incompatible` 时，WSS 循环停止重连并进入 `rejected`，保留 `{ code, message, at }` 供 CLI 与桌面端实时读取。

### 3.2 按需自动拉起（`ensureDaemon`）

CLI 与桌面客户端共用 `ControlClient`：

1. 读取 `control.token` 并请求控制端点；成功则直接返回。
2. 令牌缺失或连接返回 `ENOENT` / `ECONNREFUSED` 时，获取短期文件锁 `<data-dir>/autostart.lock`，串行化并发拉起。
3. 持锁重测一次控制端点；仍不可达则以分离后台模式启动 `batond serve --data-dir <dir>`（`detached: true`、`stdio` 重定向至 `<data-dir>/logs/batond.log` 并按 10 MiB 轮转、`windowsHide: true`、`unref()`）。
4. 以 50ms→200ms 退避轮询控制端点 `status` 直至就绪（上限 POSIX 5 秒、Windows 10 秒），释放 `autostart.lock` 后发送原请求。

### 3.3 控制通道方法与 CLI 路由

| 控制方法 | 参数 | 行为 |
|---|---|---|
| `status` | `{}` | 返回 `{ pid, batond_version, protocol_version, platform, state, coordinator_url?, node_id?, employee_id?, display_name?, rejection?, pending_login?, last_error?, service_installed }` |
| `login_start` | `{ coordinator_url, display_name? }` | 校验 HTTPS 源与现有身份（DS-06）：同中心有效身份直接触发重连并返回 `already_bound`；异中心身份或已吊销身份返回 `logout_required`；未绑定则向中心申请设备码，启动后台轮询 fiber，返回 `{ status: 'pending', session_id, user_code, verification_uri, verification_uri_complete, expires_at, expires_in_seconds }`（不向外返回 `device_code`） |
| `login_cancel` | `{}` | 中止进行中的设备码轮询 fiber，回到 `unbound` |
| `logout` | `{}` | 断开中心 WSS、中止登录轮询、停止并回收活动执行子进程树、原子删除 `<data-dir>/identity.json`，状态回到 `unbound`，保留 `node.db`、目录授权与模型凭据 |
| `resolve_thread_directory` | `{ thread_id }` | 进程内只读查询 `node.db` 的 Thread 配置并校验真实路径位于 `browse_roots` 内，供桌面端打开目录（[桌面 TECH](../desktop/TECH.md)） |
| `diagnostics` | `{}` | 返回版本、平台、运行状态、最近异常/拒绝摘要及日志末尾最多 200 行的脱敏文本 |
| `shutdown` | `{}` | 断开 WSS、有序停止并回收 `agent-host` / `project-runtime` / `execution` 子进程树、刷盘关闭 `node.db` 后进程退出 0 |

CLI 子命令分派（`apps/batond/src/cli.ts`）：
- `batond login [--coordinator <url>] [--display-name <name>]`（无位置参数）：经本地控制通道调用 `login_start`，在支持图形界面时打开浏览器展示 `verification_uri_complete`，并在终端等待状态变为 `online`（用户按 Ctrl-C 仅退出 CLI 等待，不终止后台轮询；`--cancel` 调用 `login_cancel`）。带单个位置参数 `batond login <openai-codex|xai>` 保持路由至 Project Runtime 订阅登录。
- `batond logout`：调用控制通道 `logout`。
- `batond status`：未带 `--thread-id` 时输出守护进程与中心连接状态；带 `--thread-id` 时查询对应本地 Thread 状态。

## 4. 系统用户服务（DS-10～DS-11）

`apps/batond/src/daemon/service.ts` 使用可注入命令执行器管理用户级服务定义：

| 项目 | macOS（launchd） | Linux（systemd --user） |
|---|---|---|
| 定义路径 | `~/Library/LaunchAgents/dev.baton.batond.plist` | `~/.config/systemd/user/baton-batond.service` |
| 启动命令 | `[realpath(execPath), 'run', '--data-dir', dataDir]`，`RunAtLoad=true`，`KeepAlive=true`，`ThrottleInterval=10` | `ExecStart=<execPath> run --data-dir <dataDir>`，`Restart=always`，`RestartSec=5`，`WantedBy=default.target` |
| 日志 | `StandardOutPath` / `StandardErrorPath` 指向 `<data-dir>/logs/batond.log` | `StandardOutput=append:` / `StandardError=append:` 指向同一路径 |

- **无冲突接管**：`service install` 写入服务定义前，若检测到当前已有非服务托管的后台 `batond` 正在运行，先通过本地控制通道发送 `shutdown` 并等待 `daemon.lock` 释放，再执行 `launchctl bootstrap` 或 `systemctl --user enable --now`，避免双实例锁冲突。
- **原子回滚与平台检查**：服务文件先写临时文件再原子替换，系统命令失败时恢复旧定义（原无定义则删除）。Linux 缺少可用 `systemd --user` 或 `XDG_RUNTIME_DIR` 时返回 `service_unavailable`；`service status` 额外通过 `loginctl show-user <user> -p Linger` 检查并在未开启时提示注销后服务会停止。Windows 执行 `service` 子命令返回 `service_unsupported` 并提示使用桌面客户端。
- **卸载保留数据**：`service uninstall` 停止服务并移除定义文件，不删除 `<data-dir>`。

## 5. 网页与桌面客户端接入（DS-12～DS-17）

### 5.1 浏览器端（`web/`）

- **添加设备弹窗（`EnrollDialog.tsx`）**：按平台展示安装包下载链接、SHA-256，以及无秘密的固定命令 `./batond login --coordinator <中心源>` 与 `./batond service install`；Windows 引导下载桌面客户端。普通浏览器下若 `connect_url` 存在，Devices 页显示「在客户端中打开」。
- **设备码确认页（`/device-login`）**：支持 `?code=XXXX-XXXX` 预填或手动输入短码，调用 `by-code` 展示待绑定设备的显示名与系统类型，员工点击确认调用 `approve`，取消调用 `deny`。

### 5.2 桌面客户端（`apps/desktop`）

| 模块 | 职责 |
|---|---|
| `src/coordinator.ts` | 读写 `userData/coordinator.json`（`{ format: 1, coordinator_url }`，`0600`）；校验 `baton://connect?url=...` 仅接受纯 HTTPS 源（长度 ≤ 2 KiB，不含用户信息、路径或查询串） |
| `src/main.ts` | 单实例锁、注册 `baton://` 协议、原生确认框保存中心地址；经 `ControlClient` 查询本机 `batond` 绑定状态，已绑定原中心时拒绝跨中心替换（DS-14） |
| `src/window.ts` | 开启 `contextIsolation` 与 `sandbox`，关闭 `nodeIntegration`；未保存中心地址时加载本地静态 `setup.html`，非中心源链接一律交由 `shell.openExternal` 打开；关闭窗口改为隐藏到托盘（DS-16） |
| `src/preload.ts` / `src/bridge.ts` | 仅在主框架且 `location.origin` 等于已保存中心源时注入 `window.batonDesktop`；提供 `status()`、`onStatus(cb)`、`startLogin({ displayName? })`、`cancelLogin()`、`logout()` 等受限方法 |
| `src/daemon-client.ts` | 封装内置 `resources/batond/batond(.exe)` 的 `ControlClient`（含按需拉起与周期性/事件驱动状态同步） |
| `src/tray.ts` / `src/autostart.ts` | 托盘展示连接状态与拒绝原因；默认开启系统登录自启并隐藏启动（`userData/login-start.json`）；选择「退出」时若 `service_installed === false` 先调用 `control.shutdown`（最多等待 10 秒）再退出应用，若 `service_installed === true` 仅退出客户端界面与托盘（DS-17） |

桌面端一键绑定流程（DS-15）：Devices 页面在桌面模式且 `state === 'unbound'` 时显示「连接这台电脑」→ 调用 `batonDesktop.startLogin({ displayName })` → 主进程经本地控制通道触发 `login_start` 取得 `{ session_id, user_code, expires_at }` → 窗口内弹出确认框展示设备信息与短码 → 员工点击确认直接请求同源 `POST /api/v1/device-auth/sessions/:id/approve` → 后台 `batond` 轮询拿到凭据后自动保存身份并连接上线。

## Testing and validation

| Requirement | Setup and observation | Failure condition | Where | Status |
|---|---|---|---|---|
| DS-01～DS-03 | 配置临时下载目录（含合法包、版本不符包、摘要损坏包），匿名请求 `/api/v1/downloads` 与 `/downloads/<file>`，切换 `Host` | 需要登录；坏包进入清单；未列出文件可下载；`connect_url` 含证书参数或匹配非允许源 | `apps/server` 单元 + 集成 | planned |
| DS-04～DS-07 | 发起设备码会话，覆盖未确认轮询、确认换取凭据、响应丢失幂等重试、过期、拒绝、同中心重登与跨中心/已吊销防覆盖 | `device_code` 泄漏到员工查询或日志；过期或拒绝后仍签发凭据；重试产生重复设备；静默覆盖异中心身份 | `apps/server` 集成 + `apps/batond` 单元 | planned |
| DS-08、DS-09 | 停止 `batond` 后并发从 CLI 与桌面客户端发起 `status`；模拟中心返回 `credential_revoked` 与 `node_version_incompatible` | 并发拉起产生双实例错误；错误控制令牌通过认证；终止类拒绝后 `batond` 仍死循环重连或退出丢失原因 | `apps/batond` 单元 + `e2e` | planned |
| DS-10、DS-11 | 用替身执行器验证 `launchd` / `systemd --user` 安装、已有后台 `batond` 平滑停机接管、命令失败回滚、`linger` 提示与卸载保留数据 | 服务定义含无效参数；未停止旧后台进程导致锁冲突；失败残留半写入文件；卸载删除数据目录 | `apps/batond` 单元 | planned |
| DS-12～DS-15 | 网页测试覆盖浏览器添加设备弹窗、`/device-login` 确认页及桌面模式一键绑定；桌面端单测覆盖 `baton://connect` 校验与跨中心保护 | 弹窗仍生成口令或 `curl -k`；非 HTTPS 源被保存；子框架或外部源可调用桥接；已绑定设备被静默换源 | `web` 单元 + `apps/desktop` 单元 | planned |
| DS-16、DS-17 | 桌面端单测验证关窗隐藏、自启配置，以及 `service_installed` 为 `false` / `true` 时的退出控制通道行为；真机验证原生托盘与安装覆盖 | 未安装服务退出客户端后 `batond` 仍残留运行；已安装服务退出客户端时误停后台服务 | `apps/desktop` 单元 + macOS / Windows 手动验证 | planned |
