# Baton 桌面客户端

Electron 客户端加载一个 Baton 中心，使用内置 batond 管理本机连接。支持 macOS arm64 与 Windows x64，数据目录沿用 CLI 的 `~/.baton-ts`。网页的桌面接入按钮尚未接入桥接；已有同一中心的 CLI 身份可直接沿用。

## 构建与验证

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @baton/desktop build
pnpm --filter @baton/desktop typecheck
pnpm --filter @baton/desktop lint
pnpm --filter @baton/desktop test
node --test tools/package-desktop.test.mjs
```

`tools/build/desktop.mjs` 将 main 与 preload 打成 `dist/main.cjs`、`dist/preload.cjs`，并复制本地 `setup.html`。安装依赖和自动化测试不下载或启动 Electron。打包命令见 [工具说明](../../tools/README.md#桌面客户端)。

## 接入与身份

未配置时显示本地说明页。接入链接格式为 `baton://connect?url=<百分号编码的 HTTPS 源>&ca=<CA DER 的 base64url>`；公共 CA 场景省略 `ca`。链接最多 8KB，中心地址只含 scheme、host 和可选端口，证书须声明 CA。客户端先显示中心地址与 SHA-256 指纹，经确认后才保存配置；取消不写入文件。已有其他中心的设备身份时拒绝替换。

部署配置位于 Electron `userData` 的 `deployment.json`，CA 镜像为 `ca.pem`，POSIX 文件权限为 0600。macOS 默认目录为 `~/Library/Application Support/Baton`，Windows 为 `%APPDATA%\Baton`。客户端不把凭据放入接入链接、进程参数或日志；注册和重新认证凭据只通过子进程环境变量 `BATON_ENROLLMENT_TOKEN` 交给 batond。外部 batond 仍在运行时须先停止该服务再重新认证。

本地说明页不暴露桥接。中心主页面通过 `window.batonDesktop` 使用 `protocol: 1`、`version`、`capabilities: { update: 1 }`、`update()`、`status()`、`onStatus(callback)`、`enroll({ code, displayName? })` 与 `reauth({ code })`。`update()` 打开原生更新对话框，不接收下载地址、本机路径或命令。订阅返回取消函数；成功注册或重新认证返回公开设备状态，失败抛出不含凭据的错误。main 每次核查调用方窗口、主 frame 与源。证书验证执行签名、有效期、主机名、CA 路径长度与服务器用途检查；包含当前未支持的名称或策略约束、未知 critical 扩展时拒绝自定义信任。远程页面开启 sandbox 和 context isolation，禁用 Node integration 与 webview；非中心的 HTTP(S) 导航交给系统浏览器，其他协议不打开。

## 运行与退出

客户端运行 `batond identity` 判断身份；未注册时等待接入，同一中心的身份启动监管，其他中心的身份显示冲突。监管运行 `batond run --exit-with-stdin`，合并进程状态和经过 PID、`daemon.lock` 核查的状态文件，每秒推送托盘与网页。版本不兼容时显示原因，并打开原生更新对话框。

异常退出从 1 秒指数退避，最长 30 秒；60 秒内连续失败 5 次停止重启。退出码 78、凭据拒绝、版本不兼容或无效部署配置停止重启。客户端仍在运行时，daemon 的其他退出（含正常退出）都会重新拉起；主动退出客户端时停止监管。`daemon_running` 表示外部服务占用，每 30 秒重试接管，不停止外部进程。运行日志为 `~/.baton-ts/logs/desktop-batond.log`，超过 10MB 轮转一份。

关闭窗口隐藏到托盘。托盘可打开窗口、重启 batond、打开日志目录、切换登录启动或退出。登录启动默认开启，以登录项启动时隐藏窗口；选择保存在 userData 的 `login-start.json`。退出时关闭 batond stdin 并等待最多 15 秒，超时只终止客户端自己启动的进程。替换应用保留 userData 与设备数据；升级期间不强制结束独立 Worker 或外部服务。

## 更新与数据迁移

启动及每 6 小时从保存中心查询公开发布信息和下载列表。客户端以中心版本为目标，精确比较版本字符串，支持升到或退到中心托管的版本。原生窗口菜单和托盘提供更新入口、目标版本、当前阶段及原因；中心拒绝设备版本时直接提供该入口。中心没有当前平台的安装包时说明缺包原因，可重新检查。

更新复用 batond 的 `upgrade prepare/status/cancel/migrate` 和设备目录中的 `upgrade.json`。选择更新后暂停新执行，等待当前工作结束，显示本机工作、进程及结果补报；可选择停止等待中的工作或取消更新。停止沿用原停止规则，会撤回该工作未发送的输入；普通准备和完成升级均保留原队列。就绪后停止本客户端的 batond 监管，再下载并校验安装包。HTTPS 使用保存的 CA 或系统信任，拒绝重定向；只接受保存中心的标准安装包，核对大小与 SHA-256 后才安装。

Windows 使用按用户安装的 NSIS 静默更新并重新启动。macOS 打开 DMG，提示把新版拖入「应用程序」替换，随后退出旧版；员工打开新版后自动迁移设备数据。未经过准备就直接替换时，新版先用自身 batond 发起准备，等全部登记进程退出后才迁移，不强制停止独立进程。外部服务占用数据目录时显示等待原因，需要服务管理者停止原服务。

设备阶段仍由 `upgrade.json` 保存，userData 的 `desktop-version` 只记录上次成功运行的客户端版本，`updates/` 保存已校验安装包。等待、下载、安装和迁移中断后按原阶段继续或重试。每次安装前重新校验缓存，损坏包删除。迁移沿用原一致备份和逐库核验，失败显示位置与原因，保留暂停，并提供重试及日志目录；迁移期间不启动或重启 batond。进入 syncing 后启动目标 daemon，完成原结果补报和中心完成确认后才恢复原队列。详细锁与恢复规则见 [桌面客户端设计](../../specs/desktop/TECH.md)。

## 验证范围

链接解析、证书链、源与身份检查、batond 凭据传递、重启策略、stdin 关闭、日志轮转和状态合并使用 Node 离线测试。更新测试覆盖同源下载、缓存损坏、取消恢复、直接替换、失败重试及原队列身份保留；batond 和跨 app 升级测试验证实际账本与独立进程。证书夹具与生成命令见 [测试数据](src/testing/data/README.md)。

macOS arm64 已从官方 Node 26.11.1 的 SEA 包生成 Electron 44.5.1 DMG，验证说明页无桥接与 Node API；两个实际候选客户端的中心版本拒绝、下载校验、DMG 打开、退出、手动复制替换、首次启动迁移及设备恢复在线已使用本机 HTTPS/WSS 中心替身验证，原身份和数据文件摘要保持不变。平台验收边界见 [桌面客户端规格](../../specs/desktop/PRODUCT.md#验收)。Windows NSIS 自动更新与重启未测；真实中心接入、系统重启后的登录启动与 Windows 进程回收尚未手动验证。
