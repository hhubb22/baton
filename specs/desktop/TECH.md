# 桌面客户端技术设计

Status: implemented
Basis: [桌面客户端行为规格](PRODUCT.md) DC-01～DC-21；[发布设计](../release/TECH.md)；[设备接入规格](../device-setup/PRODUCT.md)。

## 更新与安装

桌面进程在启动时调用内嵌 SEA 的 `batond update bootstrap`。首次安装将完整安装包引导到设备持久版本目录，返回固定 launcher 和 dispatch 参数；已有受信任入口时核验并复用当前选择，不用新版桌面应用内嵌的 batond 覆盖。后续 identity、注册、监管和更新命令均通过同一个 launcher 交给当前选中的 batond。

「更新并重启」先经 `batond update manifest` 读取设备已验证的签名清单，确认目标平台包含桌面安装包，再调用 `batond update`，并读取 `batond update status` 的持久状态。状态进入 ready 时，桌面停止自己监管的旧 daemon；进入 syncing 时按同一目标版本交接桌面安装，新桌面启动固定入口后由 daemon 完成中心同步与结果补报。draining 和 ready 可通过 `batond update cancel` 取消。迁移、失败阶段不启动普通 daemon，未知或无法读取的状态显示原因。设备更新状态由 batond 保存，桌面不维护另一套设备更新状态机。

桌面安装包通过 `batond update desktop-download` 按受信任密钥验证的清单获取。交接前再次核对清单中的 kind、版本、平台、文件名、大小与 SHA-256，并确认操作身份、尝试次数及目标状态未变化。Windows 交给按用户 NSIS 安装，macOS 打开 DMG 并提示替换应用；两者不覆盖设备持久版本目录。preload 的 `update` 能力仅打开本机对话框，main 校验窗口、frame 和来源；网页不能指定路径、命令或下载地址。

客户端退出或系统重启后，设备更新进度依据持久状态恢复。无法确认进程回收或迁移结果时保持暂停并显示原因；本机数据和已有报告不自动重建。

## 本机目录与诊断桥接

preload 的 `open-local`、`pick-directory`、`diagnostics` 能力版本均为 1。网页仅在能力存在且对象的设备 ID 与本机公开身份相同时显示入口。浏览器和未声明能力的客户端保持原行为。Project 不绑定工作目录，本机打开入口属于 Project 中的本机 Thread；新建 Project 不选择目录。

| 桥接方法 | 输入 | 返回或动作 |
|---|---|---|
| `openLocal` | `{ threadId, action: 'reveal' \| 'editor' }` | 打开该 Thread 的工作目录，不接收路径 |
| `pickDirectory` | `{ nodeId }` | 返回原生目录选择框选出的绝对路径，取消返回 `null` |
| `diagnostics` | `{ nodeId }` | 客户端和 batond 版本、平台、进程状态、最近退出时间与原因、升级阶段、能否重启 |
| `restartDaemon` | `{ nodeId }` | 通过现有监管重启客户端自己管理的 batond |
| `openLogs` | `{ nodeId }` | 打开固定设备日志目录 |
| `copyDiagnostics` | `{ nodeId }` | 主进程将脱敏摘要写入系统剪贴板，日志不返回网页 |

每次 IPC 首先核查当前窗口、保存中心的源与主 frame，并用 Schema 拒绝无效参数和额外路径字段。随后通过当前 Electron session 向保存中心请求 `/api/v1/me`，将当前登录员工与 batond 的公开 `employee_id` 比较；本机身份还必须属于保存中心。设备动作只接受此身份的设备 ID。网页不能通过传入另一个员工 ID 授权自己。目录选择框关闭后再次检查员工和设备身份，取消不修改网页选择。

打开 Thread 时，主进程还通过当前登录会话请求 `/api/v1/threads/:id`，确认对象存在、可被当前员工读取且属于本机设备。随后只把 Thread ID 交给内置 batond 的 `desktop-directory` 命令。batond 以只读方式查询现有 `node.db` 中由中心下发并持久化的 `node_workers` 配置，核对 Thread ID 和节点 ID；没有中心配置的本地 Thread、其他设备和不存在的 Thread 均拒绝。此查询不启动 Worker、不创建账本、不修改现有持久化格式。

工作目录来自该配置的 `working_directory`。batond 检查目录存在并解析真实路径，复用当前登记目录的授权检查，拒绝范围外的路径及逃出授权范围的符号链接。返回值包含中心、员工、设备和规范路径，main 再核对身份、目录类型和真实路径后打开。目录不存在时提示且不创建。文件管理器入口使用系统打开文件夹；编辑器路径只能通过客户端原生设置选择并私有保存，macOS 用固定 `/usr/bin/open -a` 启动所选应用，Windows 直接启动所选程序，参数只含工作目录，不经过 shell。未选编辑器时使用系统默认程序。

新建 Thread 的原生目录选择只提供路径候选，不扩大设备的登记目录范围。网页继续通过中心的设备目录接口校验候选目录，只有范围内且设备确认可用的目录才能选中；失败保留原选择并显示原因。中心和 batond 原有的新建 Thread 授权检查继续生效。

诊断复用监管状态、经 PID 和 `daemon.lock` 验证的设备状态，以及更新组件已有的 `upgrade.json` 阶段。监管保留最近一次真实进程退出的时间、退出码或信号、已知原因，自动拉起后仍可查看。外部服务状态不提供重启，实际运行版本来自 daemon 状态的可选 `batond_version`；旧服务未报告时显示未知。迁移或其他阻止监管的升级阶段不允许重启，执行前再次核查。

诊断摘要包含版本、平台、设备状态、退出事实、升级阶段和当前日志末尾最多 200 行。日志读取有大小上限；复制前隐藏凭据、注册与认证字段、模型密钥、部署配置、私钥、结构化私密内容及其续行，去掉 URL 中的用户信息、查询和片段。摘要不读取或附带身份文件、模型凭据文件及部署配置文件。

## 验证

本机能力离线测试覆盖三项能力声明、每个 IPC 的中心主 frame 来源检查、员工与设备身份、Thread 目录授权、缺失目录、目录选择取消、诊断脱敏，以及升级停止取消在途重启。网页测试覆盖本机和其他设备、浏览器和旧客户端、中心拒绝范围外目录、Project 的 Thread 入口与外部服务无重启入口。

macOS arm64 的隔离原生冒烟使用实际 preload、batond bundle 和本机 HTTPS 夹具，验证 Finder 目标目录、退出事实与真实剪贴板脱敏。编辑器只确认启动命令成功；原生目录选择未完成，未进行人工手动验收。Windows 原生交互未测，详细边界见行为规格的验收表。

离线测试以依赖注入的进程、下载与安装替身验证准备、取消、ready、替换、首次迁移、syncing 与 completed；保留原排队输入身份，不重复派发。batond 测试验证直接替换时仍存活的 Worker 阻挡迁移、目标绑定、锁与失败重跑。下载测试覆盖离源重定向、错误版本、路径、大小、校验值及损坏缓存。macOS arm64 已使用两个实际打包候选版本、本机 HTTPS/WSS 中心替身和私有 CA 验证版本拒绝、ready、DMG 下载校验与打开、旧版退出、手动复制替换、首次迁移、完成确认及设备恢复在线；设备身份与数据文件摘要保持不变。Windows 真机 NSIS 安装和自动重启未测，具体范围见 [平台验收](PRODUCT.md#验收)。
