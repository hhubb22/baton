# Node sidecar 约定

Baton 的 Node sidecar 随 batond 一起分发。发布目录包含 `batond`、`baton` 和 `sidecars/<名称>/`；目标设备安装 Node.js 22.19.0 或更高版本。构建产物按目标系统分别制作，生产依赖由各 Runtime 的 `pnpm-lock.yaml` 固定，构建时禁用依赖安装脚本。

```sh
node tools/package-batond.mjs
```

该命令构建本机版本的 Go 程序和 Project Agent bundle。将整个 `bin` 目录作为安装包分发，保留 `sidecars` 内部目录和相对符号链接。不能只复制 `batond`。构建机使用 pnpm 12.11.2；目标机无需 pnpm，也无需联网安装 npm 依赖。

## Bundle

每个 sidecar 是一个独立 npm 项目，有固定的 `version`、一个 CLI 入口、`build` 命令和锁文件。通用打包命令：

```sh
node tools/package-sidecar.mjs runtimes/project-agent bin/sidecars/project-agent project-agent
```

`manifest.json` 包含 `name`、`version`、`protocol: 1` 和相对 `entry`。`internal/sidecar.Command` 优先查找 batond 可执行文件同目录的 bundle，校验版本、协议、入口范围和 Node.js 最低版本。bundle 存在但无效时拒绝启动。没有 bundle 时允许通过 PATH 查找独立安装的 Runtime；Project Agent 的 `probe` 仍须返回兼容版本 `0.1.0`。升级时整体替换程序与 bundle，运行中的进程先停止。

## stdio

`BATON_SIDECAR_TRANSPORT=stdio` 表示使用专用 stdin/stdout 管道。请求为一行 UTF-8 JSON：`{"id":1,"request":{...}}`；响应为 `{"id":1,"result":{...}}`。编号由 sidecar 分配，在同一个进程内递增。每行正文最多 192 KiB，换行符不计入容量。最多 8 个请求在途；请求和响应都必须是完整 JSON，禁止尾随内容与无效 UTF-8。stdout 专用于协议，诊断写 stderr，凭据不进入诊断输出。

Go 使用 `internal/sidecar.Serve`，TypeScript 使用 `runtimes/shared/stdio.ts`。两个实现都在读取时限制单帧容量，写入遵守管道背压。断开管道会拒绝未完成的调用；单次请求超时为 32 秒。上层操作须把响应控制在帧容量内，预留编号和协议包装的空间。

身份由宿主绑定。Project Agent 的 stdio 管道绑定当前 run，batond 覆盖 `run_id` 和 `lease_epoch`。原有带 token 的本地 IPC 契约继续可用；两条通道执行相同的请求校验。sidecar 不能续租、启动或结束其他运行。

## 进程与恢复

`internal/sidecar.Start` 启动进程树，提供幂等的 `Stop` 和等待清理完成的 `Wait`。Unix 使用独立进程组和监听 batond 管道的守护进程；Windows 在恢复主线程前把进程加入关闭即清理的 Job Object。正常退出、崩溃、租约失效、batond 退出时都回收整棵进程树。

恢复由拥有持久状态的模块决定。Project Agent 的启动意图先写本地 SQLite，同一 `run_id` 不会重启；进程结束后 batond 回报 `exited`，Coordinator 依据已保存事件和失败退避分配新的 run。新进程重新 bootstrap，复用工具调用 ID。通用进程层负责每次启动、退出通知和清理；调用者负责恢复依据与重试上限。其他 sidecar 可以复用这些接口，按自己的会话语义决定是否启动新进程。

## 私有文件

Node sidecar 的凭据使用自己的设备数据目录，不能放在项目工作目录。Project Runtime 的 OAuth 刷新通过带心跳的跨进程锁串行化，崩溃遗留锁在 120 秒后可回收。Unix 使用私有目录和 `0600` 文件，读取时检查所有者、类型和权限，拒绝符号链接。Windows 通过随包 batond 的内部 `sidecar-file` 命令复用 `internal/privatefile` 的 DACL、句柄检查和原子替换。文件内容只经父子进程管道传递。`BATON_SIDECAR_HOST` 可指定原生宿主，batond 启动 Runtime 时自动设置。

## 验证

```sh
pnpm --dir runtimes/project-agent install --frozen-lockfile
pnpm --dir runtimes/project-agent test
go test ./internal/sidecar
go test ./internal/node -run 'TestProjectRuntime|TestRuntimeProbe'
```

`node tools/check-sidecar-package.mjs` 将完整分发包复制到新目录，检查依赖链接、版本、probe 与原生私有文件读写。

CI 在 Linux、macOS、Windows 上构建并运行同一套 faux 测试。三个系统分别保存 `request.json`，后续检查使用 `cmp` 比较系统提示词、工具定义、超过 1 MiB 的分页历史和请求选项。进程树和 batond 崩溃后的回收沿用各系统的原生测试。
