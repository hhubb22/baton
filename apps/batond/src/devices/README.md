# 设备管理与文件访问

`makeDeviceService({dataDirectory, runtime, onChanged})` 提供设备管理请求的 `handle(body, signal)`、能力采集 `collect(signal)` / `report(signal)` 和清理 `close()`。调用方在分派前校验控制面来源，并维护信封关联。Runtime 注入接口与 Project manager 的 `probe`、`startDeviceLogin` 一致；后台登录、进程替换和进程树清理由 Runtime host 管理，设备服务按 provider 串行发起登录，在登录结束时通知刷新能力。

`roots.ts` 统一负责授权目录的初始化、读取、增删与工作目录授权，配置格式为 `{ roots: [{ id, path }], maxRoots? }`，数量上限默认 256，可配置为 1～4096。初始化和增删先进入同一进程内队列，再取得 `browse-roots.lock`，使用私有文件和原子替换；其他进程持有锁时返回失败。初始化仅在配置不存在时登记主目录，已保存的空列表继续拒绝访问；显式 `--workspace` 可添加目录。目录添加解析为真实路径，相同真实路径重复添加返回已有记录；重复移除保持已保存的结果。Project 执行配置使用独立的 `project-exec.lock`，同样按文件串行执行。Project 命令执行默认关闭，远程切换在同一锁内保留 shell、保存并回读；损坏的配置在能力报告中显示关闭，并标记 `truncated`。

`browseFiles` 和附件解析共用登记根、realpath 边界与文件句柄身份检查。登记根被替换为符号链接、目标解析到根外、相对路径含 `..`、路径不允许访问时返回具体错误。读取内容只使用已打开的普通文件句柄，返回前复核路径和祖先身份；Linux 同时检查 `/proc/self/fd` 指向。祖先目录仅 ctime 变化时丢弃结果，重新授权、打开并读取，最多尝试 3 次；持续变化返回 `path_changed`，inode 或路径替换继续返回 `path_escaped`。目录每页最多处理 4096 个新条目、返回 200 项，续页重新打开目录并跳过已读位置，游标携带目录版本和扫描位置，可继续读取整个目录；目录变化返回 `directory_changed`。文本每片最多 64 KiB，UTF-8 截断保留完整字符，返回 `offset`、`version` 和可选 `next_offset`；续读必须提交偏移及版本，文件变化返回 `file_changed`。POSIX 名称中的冒号和反斜杠按字面值处理，Windows 继续拒绝驱动器、ADS 和替代分隔符。二进制、图片及特殊文件返回拒绝响应。

`scanRuntimeRoots` 扫描登记根内最多 4 层、4096 个条目及 128 个仓库，不跟随遍历中的符号链接。Git 配置只读取至多 16 KiB，经本地 `git config --no-includes --file -` 解析，不读取 include 或全局配置。worktree 元数据也必须位于同一登记根。origin 只包含主机和仓库路径。`collect` 独立刷新仓库、执行配置和 Runtime 报告：仓库扫描缓存五分钟，授权根配置被替换或修改时重新扫描；执行配置按文件元数据缓存，变更不触发仓库扫描。目录增删响应复用本次扫描结果，后续采集不重复扫描。缓存仅用于展示报告，实际文件访问和命令授权仍读取当前配置。目录扫描使用独立的 2 秒预算，Runtime probe 使用自己的配置预算（默认 5 秒），两者都受调用方与服务生命周期的取消约束。

Runtime `report` 复用一分钟内的成功探测；程序、凭据、连接、Runtime 配置或设备环境文件元数据变化时失效。并发探测合并，单个调用方取消不影响其他等待者；所有等待者取消或宿主关闭时回收探测进程。失败按 5～60 秒指数退避重试，元数据仍匹配的旧成功报告带 stale 标记返回；没有可用缓存时省略 `project_runtime`。显式 `probe` 和订阅查询跳过报告有效期缓存，仍共享在途探测。

`boundRuntimeReport` 在合入执行 Agent 目录后再次计量报告，以带缩进的 JSON 保证 64 KiB 预算；依次删除末尾仓库、多余模型和末尾目录，并保留执行 Agent 默认模型。目录增删的确认响应使用 48 KiB 摘要预算并标记 `truncated`。`node.browse_roots_get` 直接读取本地完整清单，按 JSON 字节切成最多 48 KiB 的 `page:{roots,next_cursor?}`，管理响应最多 64 KiB；读取不扫描仓库。游标包含完整清单的 SHA-256 和下一项位置，清单变化返回 `roots_changed`，网页重读第一页。Devices 展开设备时加载全部页，保存目录后刷新，读取失败时提供重试。`parseThreadAttachments` 通过 `withAuthorizedRead` 完整校验后生成普通文件引用，目录 ctime 变化时重新授权并打开，最多尝试 3 次；越界或路径替换仍拒绝生成引用。重试耗尽或其他读取失败时记录授权根 ID 和错误码，不记录文件内容，失败候选不加入附件。解析也支持有脱敏仓库地址的完整 commit SHA 引用，附件元数据限制在 4 KiB 内。Worker 的附件提取预算为 1 秒，超时或整体失败时记录 Thread ID 和错误类型；中心将缺失的附件列表统一保存为 `[]`，时间线和回复历史返回相同字段。

本机管理入口由 `runDeviceCLI(command, args, dataDirectory, output?)` 提供，顶层 CLI 负责分派数据目录；命令用法见根 README。

`project-exec` 必须显式指定 `--enabled=true|false`，开启前输出当前用户权限、任意命令、没有沙箱和注入风险说明。本机命令无需注册或连接中心。订阅登录与状态查询由 Project Runtime 的 CLI 入口提供。

定向测试使用临时本地文件、PostgreSQL 独立 schema 和 Runtime 替身，覆盖 roots、目录与文件浏览、设备设置和管理 RPC。

部署与设备接入见 [根 README](../../../../README.md)，验证命令见 [AGENTS.md](../../../../AGENTS.md#常用构建与验证命令)。
