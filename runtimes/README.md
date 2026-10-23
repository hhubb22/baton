# Node sidecar 约定

Baton 的 Node sidecar 随 batond 一起分发。设备安装目录包含 `batond` 和 `sidecars/<名称>/`；目标设备安装 Node.js 22.19.0 或更高版本。构建产物按目标系统分别制作，生产依赖由各 Runtime 的 `pnpm-lock.yaml` 固定，构建时禁用依赖安装脚本。

```sh
node tools/build.mjs
```

统一构建安装锁定的前端及 Runtime 依赖，生成 `bin/baton-server`、`bin/batond` 和 `bin/sidecars/project-agent/`。只构建设备安装包时，可运行 `node tools/package-batond.mjs [输出目录]`，默认输出到 `bin/`；该命令也会自动安装 Runtime 构建依赖。两个入口共用 `tools/package-sidecar.mjs` 打包 Runtime，统一构建只编译一次 Go 程序。

向设备分发时保留 `batond` 与同目录的 `sidecars/`，包括其内部目录和相对符号链接。不能只复制 `batond`。构建机使用 pnpm 10+；目标机无需 pnpm，也无需联网安装 npm 依赖。

设备首次接入可用 `batond up --coordinator https://主机 --workspace /绝对工作目录`，通过 `BATON_ENROLLMENT_TOKEN` 或 `--enrollment-file` 提供一次性注册凭据。显示名和系统自动推导；后续 `batond up` 复用身份。也可先运行 `batond register --coordinator https://主机`，再运行 `batond run`，连接地址从身份文件的 `coordinator_url` 推导，可用 `--relay` 指定。安装步骤见 [INSTALL.md](INSTALL.md)。

中心服务 `baton-server` 可独立部署或通过仓库的 `compose.yaml` 与 PostgreSQL 一起运行。`serve` 自动迁移数据库并生成缺失的签名密钥；容器将密钥持久保存到 `/var/lib/baton`，具体配置见 [仓库 README](../README.md)。

## 发布附件

完整构建后，执行 `node tools/package-release.mjs <版本号>`，从 `bin/` 中选择两个 Go 程序和 `sidecars/`，生成带安装说明及源码提交信息的发布包。输出位于 `bin/releases/`，Linux amd64、macOS arm64 使用 tar.gz，Windows amd64 使用 zip；压缩由系统 tar 完成。脚本解压最终附件、运行安装包检查并生成 SHA-256 校验文件，临时文件和设备数据不进入附件。

`Release packages` 工作流在三个原生平台上执行相同流程，以 `CGO_ENABLED=0` 构建 Go 程序，并验证原生 sidecar 宿主。附件上传到 Actions artifacts，不自动创建 tag 或 Release。发布仍需对同一提交完成 CI 及真实订阅验收。

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

`node tools/check-sidecar-package.mjs [安装包目录]` 默认检查 `bin/`，不重新打包。检查将完整设备产物复制到临时目录，从安装目录之外运行，只在 PATH 中提供 Node，验证依赖链接、版本、probe、订阅状态与原生私有文件读写；移走 bundle 后须返回安装错误，防止独立安装的 Runtime 掩盖包内缺项。

CI 在 Linux 上直接检查统一构建生成的安装包，并运行 Go 与 Runtime 的 faux 测试。跨系统测试使用相同的请求夹具，覆盖系统提示词、工具定义、超过 1 MiB 的分页历史和请求选项。进程树和 batond 崩溃后的回收沿用各系统的原生测试。
