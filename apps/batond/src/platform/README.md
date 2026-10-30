# batond 平台接口

调用方从具体文件导入所需接口。Node 接口返回 Promise；Effect 接口将失败映射为 `PlatformError`，Scope 关闭时等待资源释放，释放失败作为 defect 上报。

## 私有文件

`private.ts` 导出：

- `ensurePrivateDirectory(path): Promise<void>`：创建一级目录；父目录必须存在。已有目录必须通过类型与属主检查，POSIX 权限不是 0700 时改回 0700。
- `validatePrivateDirectory(path): Promise<void>`：检查目录类型；POSIX 另查所有者与权限。
- `readPrivateFile(path): Promise<Buffer>`。
- `openPrivateFile(path, flags = O_RDONLY): Promise<FileHandle>`：只打开已有文件，支持 `O_WRONLY | O_APPEND`，拒绝创建和截断。调用方关闭句柄。
- `writePrivateFile(path, data): Promise<void>` / `writePrivateFileAtomic`：同目录临时文件、文件 fsync、rename，POSIX 再 fsync 目录。

POSIX 目录和文件须属于当前 UID，文件须为普通文件；权限不是 0700/0600 时直接改回，不因权限不符拒绝访问。打开前后通过 lstat/fstat 核对设备与 inode，使用 O_NOFOLLOW，拒绝符号链接。文件的直接父目录也必须通过私有目录检查。调用方负责从可信父目录创建数据根目录。

Windows 不设置或校验 ACL，私有目录沿用数据目录继承的权限。默认数据目录 `%USERPROFILE%\.baton-ts` 位于用户目录下，Windows 默认只授权当前用户、SYSTEM 与 Administrators。验证只检查目录类型并拒绝符号链接与 junction，文件打开前后同样核对设备与 inode；`protectPrivateDirectory` 在 Windows 上只检查类型，不改权限。Node 没有逐句柄 DACL 与 reparse point 校验。

## 独占锁

`lock.ts` 的 `acquireProcessLock(path)` 返回可调用的 `release(): Promise<void>`，其 `.record` 为 `{ pid, creationTime, token }`。path 是锁目录。`acquireProcessLockScoped(path)` 返回同一资源并登记 Scope finalizer。

`readProcessLock(path)` 返回记录或 null；格式损坏、类型或权限错误会抛错。`processLockIsHeld(path)` 核对记录中的 PID 与创建时间，供 Host 在拉起 Worker 前区分启动中与已退出的 Worker。`isProcessAlive(record)` 可直接核对身份。检查失败不能作为锁空闲的依据；Host 对 launch.lock 的持有期间应再次探测认证 IPC。

锁先在相邻随机目录中完整写入所有者记录，再原子 rename 到目标。活进程持有时抛 `ProcessLockBusy`；stale 回收与 release 仅删除核验过的 token 文件，rmdir 不会移除新所有者的非空目录。Linux 创建时间使用 boot ID 与 /proc start ticks，macOS 使用固定 UTC 的 ps lstart（精度为秒），Windows 使用 .NET 进程创建时间的 UTC ticks。macOS 同秒 PID 复用无法仅凭 ps 精确区分。

## 进程

`process-types.ts` 定义 `ProcessCommand`、`OwnedProcess`、`ProcessWatchdog`、`ProcessRecordCallbacks`、`ReapResult`；`process.ts` 同时转出这些类型。

```ts
const watchdog = await startProcessWatchdog({
  file: batondExecutable,
  args: [...batondArgs, 'watchdog'],
})
const owned = await spawnOwnedProcess(command, {
  watchdog,
  signal: startupAbortSignal,
  role: 'cursor-host',
})
// owned.child、stdin、stdout、stderr 可直接连接 Node stdio transport。
const result = await owned.reap()
if (!result.reaped) throw new Error(`Reap failed: ${result.reason}`)
await watchdog.close()
```

CLI 的 `watchdog` 分支调用 `await runWatchdogCommand()`，此分支 stdout 专用于私有控制协议。每个 Worker 创建自己的 watchdog；POSIX OwnedProcess 必须传入 watchdog。watchdog 通过独占 stdin 管道接收进程组登记，stdout 返回确认，EOF 后 SIGKILL 已登记的进程组并等待检查结果。Agent 进程使用 detached 独立进程组；其子孙进程必须保留在此组内。

独占宿主在运行 driver 前调用 `installHostProcessGroup({foldDetached?})`，返回 `HostProcessGroupPolicy`。POSIX 安装时确认自身 PGID 等于 PID。默认并组策略用于 Cursor，Proxy 代理 Node `child_process.spawn` 与 `fork`，将 `detached: true` 改为 false，保留其余参数、stdio 数组与 fd3/4；`syncBuiltinESMExports` 同步 ESM named bindings。`foldDetached: false` 用于 Pi、Codex、Kiro，保留上游进程组且不修改 builtins，独立组交给 host registrar/watchdog。

`terminateChildren(options?)` 先封住本宿主后续 spawn/fork，再仅按宿主 PGID 检查、核对并 SIGKILL 除 host 自身外的非 zombie 成员，重查到空才完成。父进程退出不改变组归属。超时或取消后仍禁止新建进程，可以重试清理。`waitQuiescent(signalOrOptions?)` 只等待同组内无活动成员，不终止工具；当前通用 driver 直接映射上游回合终态，不在此处调用静默检查；进程停止确认由 Worker 的回收路径负责。两者返回 `Promise<void>`，失败为 `PlatformError`；对应的 `terminateChildrenEffect` / `waitQuiescentEffect` 返回 typed Effect，并把 fiber 中断传给检查与等待。options 支持 `timeoutMs`、`signal`，默认 2000ms；wait 也接受直接的 AbortSignal。

组检查排除每一条并发内部观察命令的精确 PID，每份快照保留其观察期间的检查器 PID，即使其他检查器先退出也不将其视为 SDK 进程。进程名与 PPID 不作为归属依据。

生产 host 保留所选策略到 OS 退出；`runAgentHost` 没有统一的 policy 清理 finalizer，资源释放由 driver、adapter/spawner Scope、registrar/watchdog 与 Worker 外层 reap 完成。`hostProcessGroupScoped` 是可选 Scope 接口，finalizer 封住创建并回收子进程，失败作为 defect 上报；当前生产 host 使用非 scoped 的安装入口。policy 的同步幂等 `restore()` 供显式可逆测试使用。

采用默认并组策略时，SDK 按原选项调用 `kill(-childPid)` 可能找不到该子组，退回只结束直接子进程。通用 driver 的 abort 优先调用上游 interruptTurn；缺少原生 turn ID 时才尝试 policy 子进程清理，Worker 继续负责外层最终回收。代理不改写 `process.kill`，也无法控制原生后代自行调用 setsid/setpgid；具体 SDK 与系统组合仍须通过真实回收验证。Windows 不修改进程创建，两个 PGID 操作显式失败为 unsupported，不能作为停止确认。

`OwnedProcess.exited` 只表示根进程 exit。`reap()` / `close()` 幂等且共享并发回收操作；POSIX 检查整个进程组，确认无可执行成员才返回 `{ reaped: true }`。僵尸进程不能执行，不视为存活。超时或发现 PID 身份不匹配时返回 false；命令、检查与持久化错误抛出。进程树回收成功后才取消 watchdog 登记、移除持久记录和关闭 stdio。

`signal` 取消启动，包含等待 watchdog 确认及持久化回调的阶段；先发起回收，等待启动回调结束并完成清理后再拒绝。持久化回调应自行设置 I/O 期限。启动完成后由调用方显式 reap，signal 不再控制执行生命周期。

`spawnOwnedProcessEffect` 将 Effect 中断连接到启动取消，并等待清理；`spawnOwnedProcessScoped` 在 Scope 关闭时回收。`spawnDetachedWorker(command)` 使用 detached + ignore stdio + unref，允许 Worker 在 batond 退出后继续运行。Worker 由自己的独占锁与认证 IPC 管理，不能作为 OwnedProcess 登记到 batond 的 watchdog。

Windows 必须提供 `records: { add, remove }`。add 在返回 OwnedProcess 前完成，remove 在回收确认后调用。Worker 重启时将账本记录交给 `recoverRecordedProcesses(records, { remove })`：创建时间一致时 taskkill /PID /T /F，身份不匹配则保留无关进程并清除失效记录。该路径尚未在 Windows 实机验证。

Windows 第一版按设计保留三个限制：taskkill 可能遗漏中间父进程提前退出后的后代；Worker 崩溃后直到下一次启动之间，Agent 会继续运行；身份核验与 taskkill 之间存在 PID 复用竞争。Windows 返回的 reaped 表示 taskkill 完成且记录中的根进程已退出，其保证受这些限制约束。

## 本地验证

验证命令见 [AGENTS.md](../../../../AGENTS.md#常用构建与验证命令)，部署见 [根 README](../../../../README.md)。测试覆盖私有文件原子替换、追加打开、权限和 symlink 拒绝、并发独占锁、stale 与创建时间核查、旧 release 对新所有者的保护、进程组孙进程回收、受控 SDK 派生在主动停止与 Worker SIGKILL 后的回收、root 与中间父进程提前退出后的组回收、另一 Thread 的进程树存活、spawn/fork 代理的参数与 fd3/4 保留、显式恢复、Scope 结束后持续封住创建、并发检查器排除、SDK fallback 遗留与后台 FD 持有者的静默门控、取消与超时、启动与 Effect 中断清理、detached Worker 跨父进程退出存活。POSIX 进程测试在 Windows 跳过，不能作为 Windows 回收验证。
