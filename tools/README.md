# 工具

工具使用 Node 26 和 workspace 的锁定依赖。请在仓库根目录执行以下命令；安装包构建使用支持 `--build-sea` 且保留 LICENSE 的官方 Node 26，macOS 还需要系统 `codesign`。

## 本地开发

```sh
pnpm install --frozen-lockfile --ignore-scripts
node tools/build/server.mjs
node tools/dev/server.mjs --help
node tools/build/batond.mjs
node tools/dev/batond.mjs --help
```

`build/server.mjs [输出路径]` 默认生成 `apps/server/dist/server.cjs`，同时构建相邻的 `web/` 并复制 SQL 迁移到 `migrations/`。`build/batond.mjs [输出路径]` 默认生成 `apps/batond/dist/batond.cjs`，SDK 从已安装依赖加载。两个脚本从自身位置确定仓库根目录，可从其他工作目录调用。

`dev/server.mjs [中心参数...]` 与 `dev/batond.mjs [节点参数...]` 共用 `runBundle`，先构建再运行，转发 SIGINT/SIGTERM。对应 app 命令为 `pnpm --filter @baton/server dev <参数...>`、`pnpm --filter @baton/batond dev <参数...>`；`build` 命令只构建。中心配置与账号管理见 [中心文档](../apps/server/README.md)，设备接入见 [节点文档](../apps/batond/README.md)。

## 构建、打包与发布

```sh
node tools/build.mjs
node tools/check-package.mjs bin
node tools/package-batond.mjs --out bin/package
node tools/package-release.mjs v0.1.0-alpha.1 bin/package
```

`build.mjs` 安装锁定依赖、检查网页类型、构建中心与节点，再生成 `bin/` SEA 安装包。`package-batond.mjs` 单独构建节点安装包，包含可执行文件、旁置 `node_modules/`、许可和清单；`--node <路径>` 可指定目标平台的官方 Node。

`package-release.mjs <版本> [安装目录=bin] [输出目录=bin/releases]` 检查布局、帮助、SEA 版本和清单，归档后重新解压并运行 `check-package`。输出对应平台的 tar.gz 或 zip、SHA256 和检查报告。应在目标平台执行发布验证。

## 安装包检查

```sh
node tools/check-package.mjs bin/package
```

`check-package.mjs [安装目录=bin] [--prepared 驱动目录]` 将完整安装包复制到临时目录，检查布局和包内链接，以空 PATH、临时 HOME 和包外工作目录运行。检查包括帮助、SEA 平台与版本、真实 Worker 的认证 IPC 就绪、四个 Agent 模块和原生扩展、Project Runtime stdio 握手、私有文件与订阅探测，以及移走 `node_modules` 后的明确失败。各项结果输出为 JSON，任一失败时非零退出。

Cursor 检查按执行环境分别验证：`agent-host --probe` 由 SEA 加载 SDK 及原生模块；SQLite store 检查由隔离的 Node 子进程运行 `verify/cursor-package.mjs`，通过以搬迁安装包为基准的 `createRequire` 加载 `@cursor/sdk/sqlite`，打开并关闭临时 store；ripgrep 和 sandbox helper 的 `--help` 直接执行安装包内的程序。SQLite 子进程检查使用运行工具的 Node，需要 Node 26。检查禁用网络请求，不调用模型；sandbox 的 `--help` 只验证程序能加载。

Runtime 握手回应 `bootstrap` 和空 `read_events`，收到 `claim_inputs` 后由本地协调者结束，核对非零退出，不交付输入或调用模型。

## Worker 启动与 FULL 账本测量

```sh
node tools/measure/worker-startup.mjs 100 --package bin/package --ledger 2000
```

`measure/worker-startup.mjs [样本数=100] --package <安装目录> [--ledger 事务数] [--prepared 驱动目录]` 要求实际安装包，并保留旁置依赖。每个样本使用新 Worker、Thread 和 SQLite 账本，在空 PATH、临时 HOME 下调用真实 `LocalWorkerHost`。计时从实际 spawn 前开始，到外部调用方收到 `worker_ready=true` 的认证 status 为止；另报含目录和令牌准备的 Host 总耗时。驱动验证错误令牌被拒绝、Worker 独占锁、实际迁移与 WAL 模式。就绪时 `agent_ready=false`，不打开 Agent 会话。

POSIX 核对 watchdog 身份，发送 SIGTERM 后等待 Worker、watchdog 退出和锁释放。Windows 核对 CIM 创建时间，再用 `taskkill /T /F` 终止，报告 `graceful=false`；创建时间检查与终止之间仍有竞争窗口。macOS 使用短临时路径以满足 UDS 限制。

报告第一样本、p50、p99、最大值与清理方式；任一样本达到 3 秒、就绪超时或清理失败时非零退出。不清空系统页缓存，不测已有会话的恢复耗时。

`--ledger` 在驱动包含的真实 `makeWorker` 串行队列中交替执行 `records.add/remove`，预热 200 次，测量实际 WAL/FULL 提交、队列操作和事件循环延迟。该项使用当前源码，与被测 SEA 分别运行；负载不包含 Agent、IPC、prompt 或 intent，未验证断电持久性。COMMIT p99 超过 50 ms 时非零退出。

## 预构建测量驱动

```sh
node tools/measure/worker-startup.mjs --prepare /tmp/baton-drivers
node tools/check-package.mjs bin/package --prepared /tmp/baton-drivers
node tools/measure/worker-startup.mjs 100 --package bin/package --prepared /tmp/baton-drivers
```

`--prepare` 通过 esbuild 将普通源码 `measure/worker-driver.mjs` 打包成 `measurement.cjs`，不构建安装包。`--prepared` 读取该文件，适合目标环境缺少 esbuild 的情况。驱动与安装包应使用同一源码版本；工具与驱动需要 Node 26，被测 SEA 自带 Node。检查和测量在目标系统本机运行，容器结果应注明宿主虚拟机和数据库文件系统。

## 官方 Node 缓存

```sh
node tools/release/cache-node.mjs 26.11.1 darwin-arm64 --download
node tools/release/cache-node.mjs 26.11.1 linux-arm64 --download
node tools/release/cache-node.mjs 26.11.1 darwin-arm64
```

支持 `darwin-arm64`、`linux-x64`、`linux-arm64` 和 `win-x64`。默认缓存为 `~/.cache/baton/node/v<版本>/`，可用 `BATON_NODE_CACHE` 指定。只有显式 `--download` 会联网，从 nodejs.org 获取归档和 `SHASUMS256.txt`，校验 SHA256 后解包，输出可执行文件与归档位置。校验清单通过 HTTPS 获取，未核验发布者的离线签名；SEA 构建不隐式下载 Node。

## Windows 进程检查

```powershell
node tools/verify/windows-processes.mjs
```

脚本只终止自己创建并登记过的进程，以 CIM 创建时间识别进程，检查完整父子孙进程树的 `taskkill /T /F` 回收、过期创建时间对无关进程的保护，以及中间父进程退出后是否遗漏孙进程。非 Windows 系统输出 `not-measured`。检查不强迫操作系统复用 PID，也不验证 Worker 崩溃后的重启行为。

## 工具测试

```sh
node --test tools/*.test.mjs
```

测试使用本地夹具，覆盖构建顺序、依赖与许可复制、安装包布局、临时安装清理、发布参数及测量驱动构建。完整 SEA 安装包由 `check-package` 单独验证。
