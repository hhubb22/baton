# TypeScript 开发与测量

这里包含 TS batond 的本地开发入口、完整 Worker 测量，以及 P0 阶段的独立测量脚本。结果输出为 JSON，包含 Node、系统和架构。请在目标系统本机执行；容器结果必须注明宿主虚拟机和数据库所在文件系统。

## 本地开发

`build-batond.mjs`、`run-batond.mjs` 和 `worker-startup.mjs` 使用 workspace 依赖。在仓库根目录准备 Node 26 和 pnpm，然后安装依赖：

```sh
pnpm install --ignore-scripts
node tools/ts-migration/build-batond.mjs
node tools/ts-migration/run-batond.mjs --help
```

`build-batond.mjs [输出路径]` 将真实 batond 打包为 CJS，默认输出 `apps/batond/dist/batond.cjs`，SDK 保持外置。`run-batond.mjs [batond 参数...]` 先构建再运行开发 bundle，并向子进程转发 SIGINT/SIGTERM。两者使用执行脚本的 Node；SEA 测量另需支持 `--build-sea` 的官方 Node，macOS 需要系统 `codesign`。

适配器行为验证统一使用上游 SDK 静态转录、确定性回放和本地替身，入口见 [本地 Thread 文档](../../apps/batond/README.md#验证)。多轮输入、输入去重、独立历史、跨进程恢复和取消通过离线测试验证；进程回收使用本地替身进程。测试与验证脚本禁止依赖真实 API Key、在线模型推理或外部真实服务。

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

## 完整 Worker 启动

```sh
"$BATON_MEASURE_NODE" tools/ts-migration/worker-startup.mjs 100
"$BATON_MEASURE_NODE" tools/ts-migration/worker-startup.mjs 100 --ledger 2000
```

`worker-startup.mjs [样本数=100] [--ledger 事务数]` 使用 workspace 已安装的依赖，通过 `build-batond.mjs` 的 `buildBatond` 构建真实 batond，再用 `common.mjs` 的 `buildSea` 生成完整 SEA。请使用上文缓存中的官方 Node 26；Homebrew Node 可能禁用 SEA 构建。此脚本不需要 `BATON_MEASURE_DEPS`。

离线容器缺少目标系统 esbuild 二进制时，可在开发机运行 `worker-startup.mjs --prepare <目录>`，预打包平台无关的 batond 与测量入口 JS，再在目标系统运行 `worker-startup.mjs 100 --prepared <目录>`。SEA 仍由目标系统的缓存 Node 生成，测量与就绪判定使用相同入口。`--ledger` 可与 `--prepared` 一起使用；整个过程无需安装依赖。

测量入口由 esbuild 打包，调用真实 `LocalWorkerHost` 新建 Worker 并请求认证 status。计时从 Host 实际调用 spawn 前开始，到外部调用方收到 `worker_ready=true` 的认证 status 为止，包含 Host 的就绪轮询、launch lock 释放及最后一次 status 往返；另报含目录与令牌准备的 Host 总耗时。Worker 使用实际独占锁、SQLite 迁移与恢复调度、Agent 接入模块及 watchdog。每个样本使用新 Thread 和新数据库，初始恢复队列为空，不覆盖已有执行会话的恢复耗时。

安装目录仅保留 SEA；无 SDK 附带目录、系统 Node 或提供商凭据，Worker 和 watchdog 继承空 PATH 与临时 HOME。只验证 Worker 就绪，`agent_ready=false`，不打开原生 Agent。macOS 使用短 `/tmp/bw-*` 路径，避免 UDS 路径超过 103 字节。逐次核对进程锁、watchdog 身份和实际数据库表，发送 SIGTERM 后等待 Worker 正常退出、watchdog 清理及锁释放，再删除样本目录。3 秒预算保持不变，任一样本达到 3 秒、Host 就绪超时或清理失败均以非零状态退出。输出第一样本、p50、p99、max；不清空系统页缓存。

可选 `--ledger` 在真实 `makeWorker` 串行队列中交替调用 `records.add/remove`，预热 200 次后测量指定事务数。测量入口仅包装 Node SQLite 的 COMMIT 执行计时，不修改业务代码或事务路径，输出实际 WAL/FULL PRAGMA、COMMIT、队列操作及 1 ms 分辨率的事件循环延迟。该负载用于检查真实账本和队列开销，不代表 prompt、intent 或 IPC 负载；`fullfsync` 使用默认值，未验证断电持久性。提交 p99 超过 50 ms 时以非零状态退出。

当前清理验证依赖 POSIX 进程检查；Windows 尚未实现此测量入口。

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

完整 Worker 可使用已有镜像、只读 workspace 和 Node 缓存运行。先在开发机预打包，再在 Linux 构建 SEA；数据放在 VM named volume 中：

```sh
worker_measure_bundle="$(mktemp -d /tmp/baton-worker-linux.XXXXXX)"
"$BATON_MEASURE_NODE" tools/ts-migration/worker-startup.mjs --prepare "$worker_measure_bundle"
docker volume create baton-worker-measure
docker run --rm --init --pull=never --network none --read-only \
  --entrypoint /node-cache/v26.11.1/node-v26.11.1-linux-arm64/bin/node \
  -w /repo -e TMPDIR=/measure \
  -v "$PWD:/repo:ro" -v "$HOME/.cache/baton/node:/node-cache:ro" \
  -v "$worker_measure_bundle:/prepared:ro" -v baton-worker-measure:/measure \
  baton-cursor-env:latest /repo/tools/ts-migration/worker-startup.mjs \
  100 --ledger 2000 --prepared /prepared
docker volume rm baton-worker-measure
rm -rf "$worker_measure_bundle"
```

命令要求本机已有 `baton-cursor-env:latest` Linux arm64 镜像，`--pull=never` 和 `--network none` 禁止拉取或联网。只读挂载的 workspace 提供脚本与纯 JS 依赖，预打包入口在容器内不调用 esbuild。Worker 的临时安装目录仍仅含 Linux SEA。该测量只验证 Worker；SDK helper 的 glibc 要求由本地加载检查验证，适配器行为由离线转录与本地替身验证。

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

Windows 和 Linux x64 没有本次本机执行环境，不能由上述 arm64 容器结果推导通过。
