# Baton 桌面客户端

Electron 客户端加载一个 Baton 中心，通过按需拉起的本地控制通道使用内置 `batond` 管理本机连接。支持 macOS arm64 与 Windows x64，数据目录沿用 CLI 的 `~/.baton/data`，程序在 `~/.baton/program`。中心网页通过受限桥接接入本机；已有同一中心的 CLI 身份可直接沿用。

## 构建与验证

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @baton/desktop build
pnpm --filter @baton/desktop typecheck
pnpm --filter @baton/desktop lint
pnpm --filter @baton/desktop test
node --test tools/package-desktop.test.mjs
```

`tools/build/desktop.mjs` 将 main 与 preload 打成 `dist/main.cjs`、`dist/preload.cjs`，并复制本地 `setup.html`。macOS 构建使用系统 Clang 编译 `notification-permission.node`，通过稳定 Node-API 在 Electron 主进程中读取系统通知权限；安装包将它放在 Resources 中。安装依赖和自动化测试不下载或启动 Electron。打包命令见 [工具说明](../../tools/README.md#桌面客户端)。

## 接入与身份

未配置时显示本地说明页。接入链接格式为 `baton://connect?url=<百分号编码的 HTTPS 源>`，只接受 `https` 源，不包含证书、路径、查询串或片段，最多 2 KiB。客户端显示中心地址，经确认后保存；取消不写入文件。已有其他中心的设备身份时拒绝替换，提示先运行 `batond logout`；本机尚未绑定时可确认替换已保存但未绑定的地址。

中心配置保存在 Electron `userData/coordinator.json`，格式为 `{ format: 1, coordinator_url }`，POSIX 权限为 `0600`。macOS 默认目录为 `~/Library/Application Support/Baton`，Windows 为 `%APPDATA%\Baton`。客户端不把凭据放入接入链接、进程参数或日志，也不读取或保存自定义 CA；batond 使用系统根证书库验证 TLS。外部 batond 仍在运行时由本地控制通道统一查询和接管，不再要求先停止服务。

本地说明页不暴露桥接。中心主页面通过 `window.batonDesktop` 使用 `protocol: 1`、`version`、`capabilities: [{ name, version }]`、`status()`、`onStatus(callback)`、`startLogin({ displayName? })`、`cancelLogin()` 与 `logout()`。能力列表声明 `notifications`、`tray-status`、`open-local`、`pick-directory`、`diagnostics`、`model-connection-key` 和 `device-login`，版本均为 1；网页忽略未知名称或版本，缺少某项能力时不调用对应接口。订阅返回取消函数；`startLogin` 返回待确认短码或已有绑定状态，失败抛出不含凭据的错误。preload 只在主框架且 `location.origin` 等于已保存中心源时注入桥接，main 每次调用再核查窗口、主 frame 与源。远程页面开启 sandbox 和 context isolation，禁用 Node integration 与 webview；非中心的 HTTP(S) 导航交给系统浏览器，其他协议不打开。

## 运行与退出

客户端只用内置 `resources/batond/batond(.exe)` 的 `ControlClient` 查询状态与控制本机服务。`status()` 在 `batond` 未运行时按需后台拉起；客户端每秒刷新并把公开状态推送给托盘和网页，不自己持有 `batond` 子进程。状态包含 `unbound`、`authorizing`、`connecting`、`syncing`、`online`、`rejected`、`stopped`，以及拒绝原因、待确认登录、最近错误和 `service_installed`。

Devices 页面在桌面模式且本机 `unbound` 时显示「连接这台电脑」。点击后调用 `startLogin`，主进程经本地控制通道触发设备码登录并把短码、有效期和设备信息显示在窗口内；员工确认后网页向同一中心提交 `POST /api/v1/device-auth/sessions/:id/approve`，由后台 `batond` 换取凭据并上线。页面和日志不出现 `device_code`。

关闭窗口隐藏到托盘。托盘显示连接状态和拒绝原因，可打开窗口、打开日志目录、切换登录启动或退出；未安装用户服务时还可重启 batond。登录启动默认开启，以登录项启动时隐藏窗口；选择保存在 userData 的 `login-start.json`。选择「退出」时，`service_installed === false` 先经控制通道发送 `shutdown` 并最多等待 10 秒再退出，`service_installed === true` 只退出客户端和托盘，后台服务继续在线。替换应用保留 userData 与设备数据；覆盖安装时先停止客户端和匹配的本机服务。

## 系统通知与托盘状态

中心将问题、确认请求、回复结束和异常停止写入持久通知记录，提交后通过现有 `BrowserEvent` 推送。网页使用 `/api/v1/events/replay` 重放，首次登录建立当前游标，重连或重载从本机游标继续；`notificationCursor(scope)` 和 `deliverNotifications({ scope, events, cursor })` 只在通知能力存在时使用。userData 的 `notifications.json` 按中心和员工保存游标与已消费事件 ID，在弹出前写入，避免重连、重载和重复调用再次通知。通知关闭或正在聚焦查看对应 Thread 时仍消费事件。窗口隐藏时网页继续接收事件，不启用后台节流。

`viewingThread(id | null)` 声明正在查看的 Thread，主进程再核查窗口是否可见且聚焦。点击通知显示并聚焦窗口，通过 `onOpenTarget(callback)` 打开对应 Thread、Project 或本机设备；对象已删除或归档时网页打开列表并显示原因。本机连接拒绝只使用 daemon 的持久拒绝状态，进程退出后仍按本次 PID 与启动时间校验，中心设备拒绝事件不重复弹出。

托盘使用网页同一 `/api/v1/activity` 员工快照统计所有设备上的运行与等待回复 Thread，包含 Project 中的 Thread，等待 Thread 去重，菜单最多列出 5 个。`setActivity({ running, waiting, threads })` 更新摘要和图标标记；退出登录清空计数。菜单按设备、工作摘要、等待 Thread、偏好、动作排列，已安装用户服务时不提供重启。

通知默认开启，开关保存在 `notifications.json`，关闭通知保留计数和等待菜单。macOS 通过 UserNotifications、Windows 通过本机通知注册表设置检查系统权限，禁用时显示原因和系统通知设置入口；查询失败保留未知状态，不据此禁用通知。Windows 使用固定 AppUserModelID `dev.baton.desktop`。通知正文和凭据不写入本机去重文件。

## 本机目录与诊断

本机 Thread 的设备·目录行末尾提供打开图标，Project 页中的本机 Thread 也有同样入口。可在访达或资源管理器中打开目录，或使用客户端 Settings 中选择的编辑器；未设置编辑器时使用系统默认程序。网页只传 Thread ID，客户端通过当前登录员工核查中心对象和本机身份，再由 batond 从已有账本取得并校验授权目录。目录不存在时提示，不创建目录。其他设备的 Thread、浏览器和缺少对应能力的旧客户端不显示入口。

新建 Thread 且目标为本机时可以选择本机目录，取消保留原选择；所选路径仍须通过中心与设备的可用目录范围校验。Project 保持跨设备调度，新建 Project 不选择设备或目录。

本机设备详情显示进程状态、最近退出时间与原因、客户端与 batond 版本，可打开日志目录、复制诊断摘要。最近退出事实来自控制通道的持久状态。已安装用户服务或客户端正在退出时不提供重启；未报告版本时显示未知。

复制摘要由主进程完成，只含时间、客户端与 batond 版本、设备 ID 和最近退出映射的固定错误码；不读取日志文件，不含平台、进程状态、退出原因、路径、凭据或业务正文。日志可在本机打开目录查看，不通过桥接返回网页。路径授权与桥接字段见 [桌面客户端设计](../../specs/desktop/TECH.md#本机目录与诊断桥接)。

## 停机替换升级

桌面客户端不执行在线自更新，也不下载或安装更新包。升级时退出旧客户端，停止本机守护进程或已安装的 CLI 用户服务，再用新版 DMG 或 NSIS 安装包覆盖安装；替换应用保留 userData 与 `~/.baton/data` 中的设备身份、目录配置、账本和模型凭据。

中心拒绝不兼容协议时，客户端显示中心返回的失败原因和覆盖安装提示，`batond` 停止重连并保留 `rejected` 状态，恢复后由新进程重新连接。Windows 未使用 Authenticode 签名时系统可能显示发布者警告；macOS 未使用 Developer ID 签名与公证时可能要求手动放行。

## 验证范围

接入链接解析、中心地址存储、跨中心替换判断、桥接注入源、控制通道状态映射，以及 `service_installed` 两种退出行为使用 Node 离线测试。网页测试覆盖桌面模式下的「连接这台电脑」、短码确认和取消。通知离线测试覆盖持久去重、并发重复提交、聚焦抑制、关闭后消费、点击目标和退出后的拒绝事实。

macOS Developer ID 签名和公证，以及 Windows Authenticode 签名尚需原生平台验证；停机替换安装不依赖在线更新。平台验收边界见 [桌面客户端规格](../../specs/desktop/PRODUCT.md#验收)。

本机目录与诊断的 macOS arm64 隔离原生冒烟使用 Electron 44.5.1、实际 preload/IPC 和 batond bundle、本机 HTTPS 夹具，验证可信目录查询、Finder 目标目录、终止自有 batond 后读取退出事实，以及真实剪贴板复制与脱敏。编辑器启动命令成功，但未确认可见窗口；真实目录选择框已调用，未能完成选择。本轮没有完成人工手动验收，也未验证完整安装包与真实账号联调。Windows 的本机打开、目录选择和诊断原生交互未测。
