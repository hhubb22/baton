# Runtime 子命令约定

Baton 将 Project Runtime 编入 batond 的单一 Node SEA 可执行文件。安装目录包含 `batond`（Windows 为 `batond.exe`）、旁置 `node_modules/` 和许可文件。旁置目录提供完整 Cursor SDK、当前系统及架构的平台包、Project Runtime 模型库及其生产依赖和 t3code 所需原生模块。设备无需安装 Node 或 pnpm，也无需联网安装 npm 依赖。

发布布局与平台验证范围见 [发布设计](../specs/release/TECH.md)，部署、设备接入和登录命令见 [根 README](../README.md)。安装包完整性与升级要求见 [INSTALL.md](INSTALL.md)，开发与验证命令统一见 [AGENTS.md](../AGENTS.md#常用构建与验证命令)。

## 命令入口

`apps/batond/src/index.ts` 调用 `src/cli.ts` 导出的 `runBatondCLI(args)`，按第一个参数分派。SEA 子进程均通过当前可执行文件启动：

| 子命令 | 用途 |
| --- | --- |
| `up`、`register`、`run` | 节点注册和连接中心 |
| `worker` | 独立 Thread Worker，持有账本、独占锁和认证 IPC |
| `watchdog` | POSIX 所属进程组监控与回收 |
| `agent-host <类型> --cwd <目录> --state <目录>` | 独占 Cursor、Pi、Codex 或 Kiro 执行宿主 |
| `project-runtime <命令>` | Project 的运行、能力报告与订阅登录 |
| `private-file` | 私有凭据文件 helper |

`batond --version` 返回 JSON `{sea,platform,arch,node}`。`batond agent-host --probe` 离线加载四个 Agent host 模块，输出 `agents:["cursor","pi","codex","kiro"]` 和 `nativeModules` 检查清单。这两个检查不调用模型；模块加载失败会提示检查安装包的 `node_modules` 和平台依赖并非零退出。

Project Runtime 支持 `run`、`probe`、`login <provider>`、`login-device <provider>`、`login-api-key <provider>` 和 `--version`。`project-runtime` 后的参数由导出的 `runProjectRuntimeCLI(args)` 处理。Runtime 的 `probe` 返回协议版本 `0.1.0` 与本地订阅状态。

源码和开发 bundle 通过 Runtime 包安装的 tsx loader 启动源码 CLI 与辅助入口，保留仓库布局和锁定依赖；两种入口共用 `runProjectRuntimeCLI(args)`。SEA 在检查源码路径前选择自身子命令，不要求源码目录。

## stdio

`BATON_PROJECT_RUNTIME_TRANSPORT=stdio` 表示使用专用 stdin/stdout 管道。请求为一行 UTF-8 JSON：`{"id":1,"request":{...}}`；响应为 `{"id":1,"result":{...}}`。编号由 Runtime 分配，在同一个进程内递增。每行正文最多 192 KiB，换行符不计入容量，最多 8 个请求在途。请求和响应须为完整 JSON，拒绝无效 UTF-8。stdout 专用于协议，诊断写 stderr，凭据不进入诊断输出。

Runtime 使用 `runtimes/project-agent/src/stdio.ts`，batond 宿主使用 `apps/batond/src/project/stdio.ts`；两端读取时限制单帧容量，写入遵守管道背压。断开管道会拒绝未完成的调用；单次请求超时为 32 秒。上层操作须把响应控制在帧容量内，预留编号和协议包装的空间。

身份由宿主绑定。Project Runtime 的 stdio 管道绑定当前 run，batond 覆盖 `run_id` 和 `lease_epoch`。带 token 的本地 IPC 契约也可用于源码独立运行；两条通道执行相同的请求校验。Runtime 不能续租、启动或结束其他运行。

## 进程与恢复

`apps/batond/src/platform` 管理进程身份与整棵进程树。POSIX 使用独立进程组，由监听宿主管道的 watchdog 回收已登记的组；Windows 使用持久 PID 和创建时间核查，再调用 taskkill 回收。Windows 的身份校验与回收之间存在竞争窗口，第一版未提供 Job Object。独立 Worker 由自己的锁与认证 IPC 管理，在 batond 退出后继续运行。

恢复由拥有持久状态的模块决定。Project 的启动意图先写本地 SQLite，同一 `run_id` 不会重启；进程结束后 batond 回报 `exited`，中心依据保存的事件和失败退避分配新的 run。新进程重新 bootstrap，复用工具调用 ID。WSS 重连保留现有 Runtime；节点退出或租约失效时回收 Runtime。

## 私有文件

Runtime 的凭据使用设备专用数据目录，默认 `~/.baton/project-runtime`，可用 `BATON_PROJECT_RUNTIME_DATA_DIR` 指定。OAuth 刷新通过带心跳的跨进程锁串行化，崩溃遗留锁在 120 秒后可回收。

POSIX 使用私有目录和 `0600` 文件，读取检查所有者和类型，权限不符时改回，拒绝符号链接。SEA 通过当前可执行文件的 `private-file` 入口读写凭据；Windows 使用 `apps/batond/src/platform/private-file-host.ts` 的目录 ACL 与私有文件检查。文件内容只经父子进程管道传递，helper 的 read/write 限制为 64 KiB。源码 Windows 宿主通过结构化 `BATON_PRIVATE_FILE_HOST_COMMAND` 传递程序与参数，不经过 shell。

## 验证

验证命令见 [AGENTS.md](../AGENTS.md#常用构建与验证命令)，安装包检查的范围与平台结果见 [发布设计](../specs/release/TECH.md)。

安装包检查在无源码、空 PATH 和临时 HOME 中运行，覆盖帮助、版本、完整 Worker 到认证 IPC 就绪、四个 Agent 模块加载、Project Runtime stdio 握手与旁置依赖缺失。适配器与模型行为使用本地替身和离线转录验证，不要求真实 API key。
