# 桌面客户端技术设计

Status: implemented
Owner: Asa
Basis: [桌面客户端行为规格](PRODUCT.md) DC-01～DC-15；[设备接入设计](../device-setup/TECH.md)；[发布设计](../release/TECH.md)。

## 全景与边界

桌面客户端（`apps/desktop`）是围绕已保存中心网页的受限 Electron 宿主，不打包前端静态资源，也不维护独立的设备更新协调器或子进程守护循环。客户端主进程通过 `ControlClient` 连接本机默认数据目录（`~/.baton/data`）的本地控制通道（未运行时自动在后台拉起内置 `resources/batond/batond(.exe)`），为网页提供受严格来源与归属核验约束的本机桥接能力。首次接入、常驻、登录自启与退出语义见 [设备接入技术设计](../device-setup/TECH.md#52-桌面客户端-appsdesktop)。

## 1. 能力协商与调用隔离（DC-01～DC-03、DC-04）

`apps/desktop/src/capabilities.ts` 向已保存中心的主框架页面声明固定能力列表（版本均为 `1`）：

| 能力名 | 用途 | 关联 |
|---|---|---|
| `device-login` | 本机设备码登录、取消、登出与实时连接状态 | DS-15 |
| `notifications` | 系统通知投递、游标去重与点击聚焦跳转 | DC-05～DC-08 |
| `tray-status` | 同步运行中与待回复 Thread 摘要至系统托盘 | DC-09、DC-10 |
| `open-local` | 在访达 / 资源管理器或指定编辑器打开本机 Thread 目录 | DC-11、DC-12 |
| `pick-directory` | 调用原生目录选择框为新建本机 Thread 提供候选路径 | DC-13 |
| `diagnostics` | 读取本机 `batond` 诊断状态、重启非服务托管守护进程、打开日志与复制脱敏摘要 | DC-14、DC-15 |
| `model-connection-key` | 将模型 API 连接密钥直接写入本机凭据存储，不经过中心 | Baton R-06 |

安全边界（`src/preload.ts`、`src/bridge.ts`、`src/main.ts`）：
1. **注入与来源核查**：仅当 `window === window.top` 且 `location.origin` 等于 `userData/coordinator.json` 保存的 HTTPS 源时，`preload` 才通过 `contextBridge` 暴露 `window.batonDesktop`；主进程每个 IPC handler 再次校验 `event.sender === mainWindow.webContents`、`event.senderFrame === mainWindow.webContents.mainFrame` 及 `senderFrame.url` 源一致，本地 `setup.html`、子框架与外部源一律拒绝。
2. **窄参数与身份对齐**：所有桥接输入使用 Effect Schema 严格解码，拒绝未知或越界路径参数。涉及设备或业务对象的操作先通过当前 Electron session 请求中心 `/api/v1/me` 取得当前登录 `employee_id`，与本地控制通道 `status` 返回的本机公开身份（`coordinator_url`、`employee_id`、`node_id`）比对一致后才放行。
3. **协议版本不兼容展示（DC-04）**：本地控制通道 `status` 返回 `state === 'rejected'` 且 `rejection.code === 'node_version_incompatible'` 时，托盘菜单与本机设备详情页显示版本不兼容提示，并提供通过系统浏览器或下载入口获取中心匹配版本安装包的动作；覆盖安装新客户端后直接沿用原有 `userData` 与 `~/.baton/data`。

## 2. 系统通知与托盘运行摘要（DC-05～DC-10）

- **去重与游标持久化（`src/notifications.ts`）**：按 `(coordinator_url, employee_id)` 作为 `scope` 在 `userData/notifications.json`（`0600` 原子替换）保存 `{ enabled, scopes: { [scope]: { cursor, seen } } }`。网页重连或刷新时先读取已保存 `cursor`，同一 `event_id` 只弹窗一次。
- **焦点抑制与点击导航**：当主窗口可见、聚焦且网页报告用户正处于同一 `thread_id` 视图时，抑制该 Thread 的通知弹窗；本机设备进入 `rejected` 状态时同样生成单次本机拒绝通知。点击通知调用窗口恢复聚焦，并向中心页面派发导航目标 `{ thread_id?, project_id?, node_id? }`（对象已删除或归档时由网页回退列表并提示）。
- **系统权限检查（`src/notification-permission.ts`）**：托盘菜单提供「通知」开关；操作系统层禁用客户端通知权限时（含 macOS 原生权限探针 `.m`），托盘菜单注明已被系统关闭并提供打开系统通知设置的入口。
- **托盘摘要模型（`src/tray-model.ts`、`src/tray.ts`）**：合并本地控制通道的连接状态与网页上报的 `Activity`（`running` 计数、`waiting` 计数、最多 5 个待回复 `{ id, title }`）。`waiting > 0` 时切换醒目托盘标记；点击菜单中的待回复 Thread 直接唤醒窗口并跳转该 Thread。

## 3. 本机打开与目录选择（DC-11～DC-13）

| 桥接方法 | 输入 | 主进程与本地控制通道交互 |
|---|---|---|
| `openLocal` | `{ threadId, action: 'reveal' \| 'editor' }` | 1. 经当前登录会话请求 `/api/v1/threads/:id`，确认当前员工可读且 `node_id` 等于本机设备；<br>2. 调用本地控制通道 `resolve_thread_directory({ thread_id })`，由 `batond` 在进程内只读查询 `node.db` 的 `threads` 配置，核验目录存在且 `realpath` 位于当前 `browse_roots` 授权范围内（拒绝越界符号链接）；<br>3. 主进程复核返回的中心、员工、设备身份与目录类型后打开，不向网页接收任何路径 |
| `pickDirectory` | `{ nodeId }` | 核验本机 `nodeId` 与登录员工身份后打开原生目录选择框；关闭对话框后再次复核员工与设备身份未切换，返回绝对路径候选（取消返回 `null`）。网页随后走既有中心目录登记与校验接口，客户端不直接绕过校验改写 `browse_roots` |

打开方式实现（`src/local.ts`、`src/editor.ts`）：目录缺失时直接返回可诊断原因且不自动创建目录。「在访达/资源管理器中显示」调用系统文件夹打开接口；编辑器路径仅由客户端原生设置选择并私有保存，macOS 以 `/usr/bin/open -a <app> <dir>`、Windows 直接 `spawn` 目标程序（单参数传入目录路径，不经过 shell），未配置时使用系统默认关联程序。

## 4. 本机诊断与脱敏复制（DC-14～DC-15）

| 桥接方法 | 输入 | 行为 |
|---|---|---|
| `diagnostics` | `{ nodeId }` | 核验本机身份后调用本地控制通道 `status` 与 `diagnostics`，返回客户端版本、`batond` 版本、平台、连接状态、`service_installed`、最近一次异常或拒绝的时间与原因，以及 `canRestart: !service_installed` |
| `restartDaemon` | `{ nodeId }` | 仅在 `!service_installed` 时允许：调用本地控制通道 `shutdown` 等待旧实例退出，再由 `ControlClient` 自动拉起新后台 `batond` |
| `openLogs` | `{ nodeId }` | 打开固定日志目录 `~/.baton/data/logs` |
| `copyDiagnostics` | `{ nodeId }` | 主进程从本地控制通道 `diagnostics` 取得脱敏摘要与末尾最多 200 行日志（带字节上限），再次剥离凭据令牌、设备码、会话 Cookie、模型 API 密钥、私钥块及 URL 查询/用户信息后直接写入系统剪贴板，日志正文不返回给网页渲染进程 |

## Testing and validation

| Requirement | Setup and observation | Failure condition | Where | Status |
|---|---|---|---|---|
| DC-01～DC-03 | 在浏览器、完整客户端、裁剪能力客户端、外部源、子框架与 `setup.html` 下分别触发桥接调用 | 浏览器显示桌面专属入口；非保存中心主框架调用未被拒绝；Schema 放过额外路径字段或跨员工设备请求 | `web` 单元 + `apps/desktop` 单元 | automated |
| DC-04 | 本地控制通道替身返回 `rejected(node_version_incompatible)`；模拟客户端覆盖升级后读取同一 `userData` 与数据目录 | 托盘或详情页未显示版本不兼容与下载入口；升级后丢失原中心配置或设备身份 | `apps/desktop` 单元 + `web` 单元 | automated |
| DC-05～DC-10 | 模拟窗口隐藏、聚焦同 Thread、聚焦其他 Thread、页面重载与待回复列表变化 | 聚焦同 Thread 仍弹窗；重载后重复弹已见事件；`waiting > 0` 未更新托盘标记或菜单跳转失效 | `apps/desktop` 单元 | automated |
| DC-11～DC-13 | 用控制通道替身覆盖本机 Thread、其他设备 Thread、缺失目录、越界符号链接、编辑器无 shell 启动及目录选择取消 | 其他设备或 Project 显示入口；缺失目录被自动创建；越界链接被打开；取消选择改动原输入 | `apps/desktop` 单元 + `web` 单元 | automated |
| DC-14、DC-15 | 注入含连接凭据、设备码、模型密钥与带参 URL 的日志末尾，分别在 `service_installed` 为 `true`/`false` 下查看详情并复制摘要 | 服务托管时仍开放重启；网页脚本能读到原始日志；剪贴板摘要残留任何秘密或查询串 | `apps/desktop` 单元 | automated |
| 原生平台验证 | macOS arm64 DMG 与 Windows x64 NSIS 真机核验窗口常驻、通知权限、访达/资源管理器打开与剪贴板 | 任一原生交互与规格不符 | 手动验证（未测平台如实记录） | manual pending |
