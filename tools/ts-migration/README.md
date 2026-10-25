# TypeScript 开发与测量

这里包含 TS 开发中心、远程节点与本地 Thread 的构建入口、安装包检查、完整 Worker 测量，以及 P0 阶段的独立测量脚本。发布节点使用 SEA 和旁置 `node_modules`；开发入口使用 workspace 依赖。检查与测量结果输出为 JSON，包含 Node、系统和架构。请在目标系统本机执行；容器结果必须注明宿主虚拟机和数据库所在文件系统。

## 本地开发

`build-server.mjs`、`run-server.mjs`、`build-batond.mjs` 和 `run-batond.mjs` 使用 workspace 依赖；`worker-startup.mjs` 可用 `--prepared` 读取预打包驱动。在仓库根目录准备 Node 26 和 pnpm 12，然后安装依赖：

```sh
pnpm install --frozen-lockfile --ignore-scripts
node tools/ts-migration/build-server.mjs
node tools/ts-migration/run-server.mjs --help
node tools/ts-migration/build-batond.mjs
node tools/ts-migration/run-batond.mjs --help
```

`build-server.mjs [输出路径]` 先通过 Vite+ 的 `vp build` 调用 Vite，将网页构建到输出 bundle 旁的 `web/`，再将中心打包为 CJS，默认输出 `apps/server/dist/server.cjs`，并将根目录的 SQL 迁移复制到 bundle 旁的 `migrations/`。`run-server.mjs [中心参数...]` 先构建再运行开发 bundle，支持 `migrate`、`serve`、`admin employee create` 和 `admin employee reset-password`；向子进程转发 SIGINT/SIGTERM。对应 workspace 命令为 `pnpm --filter @baton/server build` 与 `pnpm --filter @baton/server dev <参数...>`。

中心 `build` 和 `dev` 均包含网页构建，默认即可提供网页。静态目录默认是 bundle 旁的 `web/`，也可由 `BATON_WEB_DIR` 指定。若只需重建默认输出布局的网页，可单独运行：

```sh
pnpm --dir web build --outDir ../apps/server/dist/web
```

本机数据库配置、账号初始化、迁移、HTTPS 与 `serve` 命令见 [中心开发文档](../../apps/server/README.md#本地账号迁移与启动)。节点通过 `up/register/run` 注册或复用身份、建立 WSS 连接；私有注册凭据、CA 和 `--workspace` 用法见 [节点接入文档](../../apps/batond/README.md#远程节点)。

`build-batond.mjs [输出路径]` 将真实 batond 打包为 CJS，默认输出 `apps/batond/dist/batond.cjs`，SDK 保持外置。`run-batond.mjs [batond 参数...]` 先构建再运行开发 bundle，并向子进程转发 SIGINT/SIGTERM。这些构建与运行脚本使用执行脚本的 Node；SEA 测量另需支持 `--build-sea` 的官方 Node，macOS 需要系统 `codesign`。

适配器行为验证统一使用上游 SDK 静态转录、确定性回放和本地替身，入口见 [节点与 Thread 文档](../../apps/batond/README.md#验证) 及 [中心验证文档](../../apps/server/README.md#验证)。多轮输入、输入去重、独立历史、跨进程恢复和取消通过离线测试验证；进程回收使用本地替身进程。测试与验证脚本禁止依赖真实 API Key、在线模型推理或外部真实服务。

## P0 测量依赖

旧 P0 脚本 `sqlite-full.mjs`、`sea-startup.mjs` 和 `cursor-sea.mjs` 通过 `BATON_MEASURE_DEPS` 使用隔离依赖，独立于 workspace 构建和测试，不修改根依赖或锁文件。需要 Node 26、npm；macOS 构建 SEA 还需要系统的 `codesign`。隔离安装公开依赖，不执行依赖安装脚本：

```sh
export BATON_MEASURE_DEPS="$(mktemp -d)"
npm install --prefix "$BATON_MEASURE_DEPS" --ignore-scripts --no-audit --no-fund effect@4.0.6 esbuild@0.27.3 @cursor/sdk@1.0.35
```

npm 会在隔离目录生成锁文件，可用该文件重装完全相同的传递依赖。P0 测量不使用员工的 SDK 登录或真实模型。SEA 测量子进程只接收临时 HOME、系统必要路径和空 PATH，不继承提供商凭据；Cursor 的 JS 加载探针同时禁用 fetch 与 HTTP 请求。

## 官方 Node 缓存

```sh
node tools/ts-migration/cache-node.mjs 26.11.1 darwin-arm64 --download
node tools/ts-migration/cache-node.mjs 26.11.1 linux-arm64 --download
node tools/ts-migration/cache-node.mjs 26.11.1 darwin-arm64
```

默认缓存为 `~/.cache/baton/node/v26.11.1/`，可用 `BATON_NODE_CACHE` 指定。只有显式 `--download` 会联网；其余调用在文件缺失时报告下载命令。脚本从 `https://nodejs.org/dist/v26.11.1/` 下载归档及 `SHASUMS256.txt`，验证 SHA256 后解包，输出归档、校验文件和可执行文件的位置。SHA256 清单通过 HTTPS 获取，未核验发布者的离线签名。SEA 构建不隐式下载二进制。

目标还支持 `linux-x64` 和 `win-x64`。Windows 上用 PowerShell `Expand-Archive` 解包 ZIP；macOS 的系统 tar 也支持 ZIP。在不支持 ZIP 的 tar 环境中，Windows 归档需自行解包。

macOS 示例使用缓存中的官方 Node，避免依赖 Homebrew 动态库：

```sh
export BATON_MEASURE_NODE="$HOME/.cache/baton/node/v26.11.1/node-v26.11.1-darwin-arm64/bin/node"
"$BATON_MEASURE_NODE" tools/ts-migration/sqlite-full.mjs 10000 100
"$BATON_MEASURE_NODE" tools/ts-migration/sea-startup.mjs 100
"$BATON_MEASURE_NODE" tools/ts-migration/cursor-sea.mjs
```

## SQLite FULL

`sqlite-full.mjs [提交次数=10000] [每次让出事件循环前的提交数=100]` 在新数据库上开启 WAL、FULL，创建一张账本表，预热 200 次，每事务写入 1 KiB 并提交。默认自动 checkpoint 为 1000 页。分别记录 COMMIT 和整个事务的 p50、p99、最大值，以及 `monitorEventLoopDelay({resolution: 1})` 的延迟。计时不含初始化和预热，包含测量期间的自动 checkpoint。

`BATON_MEASURE_STORAGE` 指定数据库父目录，默认系统临时目录。脚本输出文件系统类型及实际 PRAGMA，完成后校验行数并删除测量目录。每次让出事件循环前的事务数会影响事件循环延迟，比较结果时必须保持相同。需要另测逐事务让出时，传 `10000 1`；第二参数设为提交总数可观察持续阻塞整个批次的情况。

macOS 的默认 `fullfsync=0` 也记录在输出中。这里检查的是 SQLite `synchronous=FULL` 的实际默认行为，没有模拟断电，也没有证明磁盘控制器的断电持久性。p99 大于 50 ms 时输出 `exceeds50Ms: true`，由规格要求决定是否把账本移到 worker_threads；基准脚本本身不修改生产实现。

## SEA 启动

`sea-startup.mjs [样本数=100]` 将 Effect `4.0.6` 与 Worker 子命令骨架打包为 CJS，通过 Node `--build-sea` 生成可执行文件，macOS 上作 ad-hoc 签名。安装目录只含可执行文件；构建脚本在测量前删除。每个样本启动新进程、新建数据库、配置 WAL/FULL、建表、监听 UDS/命名管道并完成一次令牌认证。报告从父进程 spawn 前到监听通知、到认证成功的时间，包含进程创建和 Node/Effect 加载。

未清空系统页缓存。首次启动单独报告，其余样本也都新建进程和 SQLite 文件。它只衡量最小入口，生产 Worker 的锁、完整迁移、恢复和其他模块加载仍需再次验收。任一样本超过 3 秒输出 `exceeds3Seconds: true`；10 秒未就绪会杀掉测量进程并报错。

## 安装包检查与完整 Worker 测量

```sh
node tools/package-batond.mjs
node tools/check-sidecar-package.mjs bin
node tools/ts-migration/worker-startup.mjs 100 --ledger 2000 --package bin
```

`check-sidecar-package.mjs [安装目录=bin] [--prepared 驱动目录]` 将完整安装包复制到临时目录，检查符号链接没有指向包外，再以空 PATH、临时 HOME 和包外工作目录执行 SEA。检查内容包括 `--help`、`--version` 的 SEA/平台/架构/Node 信息、真实 Worker 的认证 IPC 就绪、`agent-host --probe` 加载 Cursor/Pi/Codex/Kiro 四个模块及 keyring、tree-sitter 原生扩展、`project-runtime run` 的 stdio 握手、私有文件 helper 与只读订阅探测，以及移走旁置 `node_modules` 后的明确失败。Runtime 握手成功回应 `bootstrap` 和空 `read_events`，收到 `claim_inputs` 后由本地协调者返回结束错误，确认进程以非零状态退出；不交付输入、不调用模型。检查以一个 JSON 对象报告各项结果，任一项失败即非零退出。

`worker-startup.mjs [样本数=100] [--ledger 事务数] --package <安装目录> [--prepared 驱动目录]` 直接测量该安装包，保留可执行文件旁的完整依赖。每个样本启动新 Worker、新建 Thread 与 SQLite 账本，Worker 及子进程继承空 PATH 和临时 HOME。工具本身需要 Node 26；被测 SEA 不依赖系统 Node、源码或提供商凭据。省略 `--package` 时使用 workspace 依赖构建开发 SEA，用于本地诊断；发布验收应传入实际安装包。

检查与测量共用 esbuild 打包的驱动，调用真实 `LocalWorkerHost` 新建 Worker 并请求认证 status。计时从 Host 实际调用 spawn 前开始，到外部调用方收到 `worker_ready=true` 的认证 status 为止，包含 Host 的就绪轮询、launch lock 释放及最后一次 status 往返；另报含目录与令牌准备的 Host 总耗时。Worker 使用实际独占锁、SQLite 迁移与恢复调度及 Agent 注册模块。初始恢复队列为空，不覆盖已有执行会话的恢复耗时；就绪时 `agent_ready=false`，不打开 Agent 会话。驱动另发错误令牌，确认 IPC 拒绝未认证请求。

macOS 使用短 `/tmp/bw-*` 路径，避免 UDS 路径超过 103 字节。每次核对进程锁、实际数据库表和 WAL 模式。POSIX 上核对 watchdog 身份，发送 SIGTERM 后等待 Worker 正常退出、watchdog 清理及锁释放。Windows Worker 当前不创建 watchdog；驱动通过 CIM 创建时间核对 Worker 身份，再用 `taskkill /T /F` 终止，确认进程退出且锁不再由存活进程持有。Windows 报告明确标记 `graceful=false`，不把此过程计为正常退出。CIM 检查与终止之间仍有竞争窗口。

3 秒预算保持不变，任一样本达到 3 秒、Host 就绪超时或清理失败均以非零状态退出。报告第一样本、p50、p99、max，以及平台对应的清理方式。每次删除样本目录；不清空系统页缓存。

可选 `--ledger` 在驱动所包含的真实 `makeWorker` 串行队列中交替调用 `records.add/remove`，预热 200 次后测量指定事务数。驱动使用当前 workspace 的 Worker 实现，与被测 SEA 分别运行；该项没有通过 SEA 的 IPC 执行。驱动仅包装 Node SQLite 的 COMMIT 执行计时，保留实际账本保存、提交核查和队列路径，输出实际 WAL/FULL PRAGMA、COMMIT、队列操作及 1 ms 分辨率的事件循环延迟。该负载用于检查真实账本和队列开销，不代表 prompt、intent 或 IPC 负载；`fullfsync` 使用默认值，未验证断电持久性。提交 p99 超过 50 ms 时以非零状态退出。

离线容器缺少目标系统 esbuild 二进制时，先在开发机运行：

```sh
node tools/ts-migration/worker-startup.mjs --prepare /tmp/baton-drivers
```

`--prepare` 只生成平台无关的 `measurement.cjs`，安装包另由 `package-batond.mjs` 构建。将驱动和目标系统安装包挂入容器后，两种检查均可使用 `--prepared /prepared`，此时不导入 esbuild、不构建 SEA、不安装依赖。驱动应与安装包使用同一源码版本。

## Windows 进程

Windows PowerShell 中运行：

```powershell
node tools/ts-migration/windows-processes.mjs
```

脚本仅终止自己创建并登记过的进程，创建时间通过 `Get-CimInstance Win32_Process` 读取，转为 UTC ticks 字符串保存，避免 JSON 数值精度损失。它检查三项：完整父子孙进程树可由 `taskkill /T /F` 清理；无关存活进程与故意过期的创建时间不匹配时不能被终止；中间父进程退出后，taskkill 是否遗漏孙进程。最后一项输出实际观察结果，不预设系统一定遗漏。

过期记录检查覆盖创建时间不匹配的恢复判断，未强迫操作系统真实复用同一 PID。CIM 检查与 taskkill 之间也不是原子操作，仍有 PID 复用竞争窗口；完整 Windows 进程账本验收应补测真实 PID 复用和 Worker 崩溃后重启的行为。非 Windows 系统只输出 `not-measured`，不运行进程终止检查。

## Cursor SDK

`cursor-sea.mjs` 比较默认入口 bundle、默认入口加平台目录、`/bundled` 入口、`/bundled` 入口加平台目录、完整 SDK 附带目录五种方式。最后一种以可执行文件旁的 `node_modules` 为解析基准，复制 SDK、生产依赖与当前平台包，在临时 HOME、空 PATH 下执行。检查 SDK 导出、临时 SQLite store、tree-sitter Bash 原生解析器和 ripgrep；移动附带目录后必须找不到 SDK。单独运行平台 sandbox helper 的 `--help`，只检查加载能力。

脚本不调用 Agent 执行入口。完整目录方案和 sandbox helper 加载均通过时才输出 `packagingPassed: true` 并以 0 退出。默认入口的动态解析、`/bundled` 的 `bun:sqlite` 依赖及 Linux arm64 helper 所需的 glibc 2.39 均会按实际结果记录；当前 Debian 12/glibc 2.36 的检查退出码为 1。SDK 的持久化、认证、取消与 sandbox 策略通过静态转录、确定性回放和本地替身验证。SDK 来源和许可见 [`third_party/cursor-sdk`](../../third_party/cursor-sdk/README.md)。

## 本机 Linux 容器

完整安装包可使用已有镜像、预打包驱动和目标平台的 Node 缓存运行。先准备 Linux 安装包 `bin-linux` 和驱动；数据放在 VM named volume 中：

```sh
node tools/ts-migration/worker-startup.mjs --prepare /tmp/baton-drivers
docker volume create baton-worker-measure
docker run --rm --init --pull=never --network none --read-only \
  --entrypoint /node-cache/v26.11.1/node-v26.11.1-linux-arm64/bin/node \
  -w /repo -e TMPDIR=/measure \
  -v "$PWD:/repo:ro" -v "$HOME/.cache/baton/node:/node-cache:ro" \
  -v /tmp/baton-drivers:/prepared:ro -v baton-worker-measure:/measure \
  baton-cursor-env:latest /repo/tools/check-sidecar-package.mjs \
  /repo/bin-linux --prepared /prepared
docker run --rm --init --pull=never --network none --read-only \
  --entrypoint /node-cache/v26.11.1/node-v26.11.1-linux-arm64/bin/node \
  -w /repo -e TMPDIR=/measure \
  -v "$PWD:/repo:ro" -v "$HOME/.cache/baton/node:/node-cache:ro" \
  -v /tmp/baton-drivers:/prepared:ro -v baton-worker-measure:/measure \
  baton-cursor-env:latest /repo/tools/ts-migration/worker-startup.mjs \
  100 --ledger 2000 --package /repo/bin-linux --prepared /prepared
docker volume rm baton-worker-measure
rm -rf /tmp/baton-drivers
```

命令要求本机已有 `baton-cursor-env:latest` Linux arm64 镜像；安装包内的原生依赖也必须为 Linux arm64。`--pull=never` 和 `--network none` 禁止拉取或联网。只读 workspace 挂载提供脚本，驱动从 `/prepared` 读取；被测进程的工作目录和 HOME 位于临时卷，不从 workspace 解析模块。SDK helper 的 glibc 要求由本地加载检查验证，适配器会话行为由离线转录与本地替身验证。

P0 的 Linux arm64 测量运行于本机 OrbStack 的 Linux 虚拟机，数据库放在 Docker named volume，而非 macOS bind mount。以下可在相同环境复现；`baton-cursor-env:latest` 为本机已有 Debian 容器镜像，其他环境可显式拉取官方 `node:26.11.1-bookworm-slim` 作为运行底座。运行时仍使用上文缓存的官方 Node。

```sh
docker volume create baton-p0-measure-node26
docker run --rm --entrypoint /bin/sh \
  -e HOME=/storage/emptyhome -e npm_config_userconfig=/dev/null \
  -v baton-p0-measure-node26:/storage baton-cursor-env:latest \
  -c 'mkdir -p /storage/emptyhome && npm install --prefix /storage/deps --ignore-scripts --no-audit --no-fund effect@4.0.6 esbuild@0.27.3 @cursor/sdk@1.0.35'
docker run --rm --network none --entrypoint /bin/sh \
  -v "$PWD/tools/ts-migration:/measure:ro" \
  -v "$HOME/.cache/baton/node:/node-cache:ro" \
  -v baton-p0-measure-node26:/storage baton-cursor-env:latest \
  -c 'BATON_MEASURE_STORAGE=/storage /node-cache/v26.11.1/node-v26.11.1-linux-arm64/bin/node /measure/sqlite-full.mjs 10000 100 && BATON_MEASURE_DEPS=/storage/deps /node-cache/v26.11.1/node-v26.11.1-linux-arm64/bin/node /measure/sea-startup.mjs 100 && BATON_MEASURE_DEPS=/storage/deps /node-cache/v26.11.1/node-v26.11.1-linux-arm64/bin/node /measure/cursor-sea.mjs'
docker volume rm baton-p0-measure-node26
```

Windows 和 Linux x64 需在目标系统原生执行检查与测量；arm64 容器结果不能代替其他系统和架构的验证。
