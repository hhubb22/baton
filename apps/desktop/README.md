# Baton 桌面客户端

Electron 客户端加载一个 Baton 中心，使用内置 batond 管理本机连接。支持 macOS arm64 与 Windows x64，数据目录沿用 CLI 的 `~/.baton/data`，程序在 `~/.baton/program`。中心网页通过受限桥接接入和重新认证本机；已有同一中心的 CLI 身份可直接沿用。

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

未配置时显示本地说明页。接入链接格式为 `baton://connect?url=<百分号编码的 HTTPS 源>&ca=<CA DER 的 base64url>`；公共 CA 场景省略 `ca`。链接最多 8KB，中心地址只含 scheme、host 和可选端口，证书须声明 CA。客户端先显示中心地址与 SHA-256 指纹，经确认后才保存配置；取消不写入文件。已有其他中心的设备身份时拒绝替换。

部署配置位于 Electron `userData` 的 `deployment.json`，CA 镜像为 `ca.pem`，POSIX 文件权限为 0600。macOS 默认目录为 `~/Library/Application Support/Baton`，Windows 为 `%APPDATA%\Baton`。客户端不把凭据放入接入链接、进程参数或日志；注册和重新认证凭据只通过子进程环境变量 `BATON_ENROLLMENT_TOKEN` 交给 batond。外部 batond 仍在运行时须先停止该服务再重新认证。

本地说明页不暴露桥接。中心主页面通过 `window.batonDesktop` 使用 `protocol: 1`、`version`、`capabilities: [{ name, version }]`、`update()`、`status()`、`onStatus(callback)`、`enroll({ code, displayName? })` 与 `reauth({ code })`。能力列表声明 `update`、`notifications`、`tray-status`、`open-local`、`pick-directory`、`diagnostics`，版本均为 1；网页忽略未知名称或版本，缺少某项能力时不调用对应接口。`update()` 打开原生更新对话框，不接收下载地址、本机路径或命令。订阅返回取消函数；成功注册或重新认证返回公开设备状态，失败抛出不含凭据的错误。main 每次核查调用方窗口、主 frame 与源。证书验证执行签名、有效期、主机名、CA 路径长度与服务器用途检查；包含当前未支持的名称或策略约束、未知 critical 扩展时拒绝自定义信任。远程页面开启 sandbox 和 context isolation，禁用 Node integration 与 webview；非中心的 HTTP(S) 导航交给系统浏览器，其他协议不打开。

## 运行与退出

客户端运行 `batond identity` 判断身份；未注册时等待接入，同一中心的身份启动监管，其他中心的身份显示冲突。监管运行 `batond run --exit-with-stdin`，合并进程状态和经过 PID、`daemon.lock` 核查的状态文件，每秒推送托盘与网页。版本不兼容时显示原因，并打开原生更新对话框。

异常退出从 1 秒指数退避，最长 30 秒；60 秒内连续失败 5 次停止重启。退出码 78、凭据拒绝、版本不兼容或无效部署配置停止重启。客户端仍在运行时，daemon 的其他退出（含正常退出）都会重新拉起；主动退出客户端时停止监管。`daemon_running` 表示外部服务占用，每 30 秒重试接管，不停止外部进程。运行日志为 `~/.baton/data/logs/desktop-batond.log`，超过 10MB 轮转一份。

关闭窗口隐藏到托盘。托盘可打开窗口、重启 batond、打开日志目录、切换登录启动或退出。登录启动默认开启，以登录项启动时隐藏窗口；选择保存在 userData 的 `login-start.json`。退出时关闭 batond stdin 并等待最多 15 秒，超时只终止客户端自己启动的进程。替换应用保留 userData 与设备数据；升级期间不强制结束独立 Worker 或外部服务。

## 系统通知与托盘状态

中心将问题、确认请求、回复结束和异常停止写入持久通知记录，提交后通过现有 `BrowserEvent` 推送。网页使用 `/api/v1/events/replay` 重放，首次登录建立当前游标，重连或重载从本机游标继续；`notificationCursor(scope)` 和 `deliverNotifications({ scope, events, cursor })` 只在通知能力存在时使用。userData 的 `notifications.json` 按中心和员工保存游标与已消费事件 ID，在弹出前写入，避免重连、重载和重复调用再次通知。通知关闭或正在聚焦查看对应 Thread 时仍消费事件。窗口隐藏时网页继续接收事件，不启用后台节流。

`viewingThread(id | null)` 声明正在查看的 Thread，主进程再核查窗口是否可见且聚焦。点击通知显示并聚焦窗口，通过 `onOpenTarget(callback)` 打开对应 Thread、Project 或本机设备；对象已删除或归档时网页打开列表并显示原因。本机连接拒绝只使用 daemon 的持久拒绝状态，进程退出后仍按本次 PID 与启动时间校验，中心设备拒绝事件不重复弹出。

托盘使用网页同一 `/api/v1/activity` 员工快照统计所有设备上的运行与等待回复 Thread，包含 Project 中的 Thread，等待 Thread 去重，菜单最多列出 5 个。`setActivity({ running, waiting, threads })` 更新摘要和图标标记；退出登录清空计数。菜单按设备、工作摘要、等待 Thread、偏好、动作排列，外部服务不提供重启，迁移时保留阶段与日志入口。

通知默认开启，开关保存在 `notifications.json`，关闭通知保留计数和等待菜单。macOS 通过 UserNotifications、Windows 通过本机通知注册表设置检查系统权限，禁用时显示原因和系统通知设置入口；查询失败保留未知状态，不据此禁用通知。Windows 使用固定 AppUserModelID `dev.baton.desktop`。通知正文和凭据不写入本机去重文件。

## 本机目录与诊断

本机 Thread 的设备·目录行末尾提供打开图标，Project 页中的本机 Thread 也有同样入口。可在访达或资源管理器中打开目录，或使用客户端 Settings 中选择的编辑器；未设置编辑器时使用系统默认程序。网页只传 Thread ID，客户端通过当前登录员工核查中心对象和本机身份，再由 batond 从已有账本取得并校验授权目录。目录不存在时提示，不创建目录。其他设备的 Thread、浏览器和缺少对应能力的旧客户端不显示入口。

新建 Thread 且目标为本机时可以选择本机目录，取消保留原选择；所选路径仍须通过中心与设备的可用目录范围校验。Project 保持跨设备调度，新建 Project 不选择设备或目录。

本机设备详情显示进程状态、最近退出时间与原因、客户端与 batond 版本和已有升级阶段，可打开日志目录、复制诊断摘要。自动重启后仍保留本次客户端运行期间的最近退出事实。外部服务运行时说明由外部服务管理，不提供重启；升级或迁移阻止监管时也不能重启。旧外部服务未报告版本时显示未知。

复制摘要由主进程完成，包含设备状态、版本、平台、退出原因和当前日志末尾最多 200 行。凭据、部署配置、私钥及其续行被隐藏，URL 用户信息、查询和片段被移除。日志不通过桥接返回网页，摘要不附带身份或模型凭据文件。路径授权与桥接字段见 [桌面客户端设计](../../specs/desktop/TECH.md#本机目录与诊断桥接)。

## 更新与数据迁移

设备定期查询保存中心的签名更新清单并预下载。原生窗口菜单和托盘提供更新入口、目标版本、当前阶段及原因，并提供手动更新和空闲时自动更新设置。

更新由 batond 准备和迁移设备数据，等待正在运行的工作自然结束。桌面停止监管后使用 electron-updater 安装并重启；本机回环更新源只提供由签名清单指定并校验大小与 SHA-256 的元数据和安装包。

Windows 使用按用户安装的 NSIS 更新并重启。未使用 Authenticode 签名的安装包由签名清单和摘要保护，系统发布者身份未经认证，Windows 可能显示安全警告。macOS 自动安装需要 Developer ID 签名和公证的 ZIP；没有证书时可以提供手动安装的 DMG，自动安装不可用。

设备阶段仍由 `upgrade.json` 保存，userData 的 `desktop-version` 只记录上次成功运行的客户端版本，`updates/` 保存已校验安装包。等待、下载、安装和迁移中断后按原阶段继续或重试。每次安装前重新校验缓存，损坏包删除。迁移沿用原一致备份和逐库核验，失败显示位置与原因，保留暂停，并提供重试及日志目录；迁移期间不启动或重启 batond。进入 syncing 后启动目标 daemon，完成原结果补报和中心完成确认后才恢复原队列。详细锁与恢复规则见 [桌面客户端设计](../../specs/desktop/TECH.md)。

## 验证范围

链接解析、证书链、源与身份检查、batond 凭据传递、重启策略、stdin 关闭、日志轮转和状态合并使用 Node 离线测试。通知离线测试覆盖持久去重、并发重复提交、聚焦抑制、关闭后消费、点击目标和退出后的拒绝事实。证书夹具与生成命令见 [测试数据](src/testing/data/README.md)。

macOS Developer ID 签名和公证的自动更新，以及 Windows NSIS 自动更新与重启，尚需原生平台验证。平台验收边界见 [桌面客户端规格](../../specs/desktop/PRODUCT.md#验收)。

本机目录与诊断的 macOS arm64 隔离原生冒烟使用 Electron 44.5.1、实际 preload/IPC 和 batond bundle、本机 HTTPS 夹具，验证可信目录查询、Finder 目标目录、终止自有 batond 后读取退出事实，以及真实剪贴板复制与脱敏。编辑器启动命令成功，但未确认可见窗口；真实目录选择框已调用，未能完成选择。本轮没有完成人工手动验收，也未验证完整安装包与真实账号联调。Windows 的本机打开、目录选择和诊断原生交互未测。
