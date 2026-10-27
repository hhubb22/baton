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

本地说明页不暴露桥接。中心主页面通过 `window.batonDesktop` 使用 `protocol: 1`、`version`、`status()`、`onStatus(callback)`、`enroll({ code, displayName? })` 与 `reauth({ code })`。订阅返回取消函数；成功注册或重新认证返回公开设备状态，失败抛出不含凭据的错误。main 每次核查调用方窗口、主 frame 与源。证书验证执行签名、有效期、主机名、CA 路径长度与服务器用途检查；包含当前未支持的名称或策略约束、未知 critical 扩展时拒绝自定义信任。远程页面开启 sandbox 和 context isolation，禁用 Node integration 与 webview；非中心的 HTTP(S) 导航交给系统浏览器，其他协议不打开。

## 运行与退出

客户端运行 `batond identity` 判断身份；未注册时等待接入，同一中心的身份启动监管，其他中心的身份显示冲突。监管运行 `batond run --exit-with-stdin`，合并进程状态和经过 PID、`daemon.lock` 核查的状态文件，每秒推送托盘与网页。版本不兼容时显示原因并打开中心设备页。

异常退出从 1 秒指数退避，最长 30 秒；60 秒内连续失败 5 次停止重启。退出码 78、凭据拒绝、版本不兼容或无效部署配置停止重启。客户端仍在运行时，daemon 的其他退出（含正常退出）都会重新拉起；主动退出客户端时停止监管。`daemon_running` 表示外部服务占用，每 30 秒重试接管，不停止外部进程。运行日志为 `~/.baton-ts/logs/desktop-batond.log`，超过 10MB 轮转一份。

关闭窗口隐藏到托盘。托盘可打开窗口、重启 batond、打开日志目录、切换登录启动或退出。登录启动默认开启，以登录项启动时隐藏窗口；选择保存在 userData 的 `login-start.json`。退出时关闭 batond stdin 并等待最多 15 秒，超时只终止客户端自己启动的进程。替换应用保留 userData 与设备数据；不自动迁移数据、更新应用或结束独立 Worker。

## 验证范围

链接解析、证书链、源与身份检查、batond 凭据传递、重启策略、stdin 关闭、日志轮转和状态合并使用 Node 离线测试。证书夹具与生成命令见 [测试数据](src/testing/data/README.md)。macOS arm64 已从统一构建的 SEA 包生成 DMG，复制安装后启动显示说明页，并核对说明页无桥接与 Node API。Windows NSIS、真实中心接入、系统重启后的登录启动与 Windows 进程回收尚未手动验证。
