# Project Runtime 宿主

`makeProjectManager({dataDir, runtimeCommand?, watchdogCommand?, clock?, timing?, onReportChanged?})` 返回有 Scope 所有权的 Effect。daemon 在连接循环外构造一次；`node.sync_result` 成功后调用 `setTransport(request)`，连接退出时调用 `onDisconnect()`。transport 接收 `ProjectRuntimeRequest` 和包含排队、发送、等待预算的 `AbortSignal`，返回当前连接关联到的 `ProjectRuntimeResult`。

manager 支持 `command(project_run_start|stop|wake)`、`probe()`、`report()`、`subscriptions()`、`login(provider)`、`startDeviceLogin(provider, signal?, onDone?)` 和幂等 `close()`。连接替换会取消旧请求并清除控制回执能力，现有 Runtime 保留到退出或租约失效。manager 关闭时等待进程树回收及后台操作，随后 Scope 关闭 watchdog 与数据库。

SEA 默认命令为当前可执行文件加 `project-runtime` 子命令，watchdog 使用同一可执行文件的 `watchdog` 子命令；选择 SEA 分支后不再查找源码或 tsx。源码开发命令通过 Runtime 包的 tsx loader 启动 `runtimes/project-agent/src/cli.ts`，`--import` 使用 loader 的 file URL，支持 Windows 盘符及包含空格的路径。支持源码与开发 bundle 两种布局，需要已安装的锁定依赖。SEA 与 Windows 源码入口通过结构化 `BATON_SIDECAR_HOST_COMMAND` 调用 TS 私有文件宿主，凭据读写使用 `platform/private-file-host`；SEA 凭据实现也可直接用当前可执行文件调用 `sidecar-file`。`runtimeCommand` 可提供其他本地入口，宿主追加 `probe`、`run`、`login` 或 `login-device`；环境与当前进程合并。Runtime 的命令处理导出为 `runProjectRuntimeCLI(args)`，模型、工具、恢复与压缩逻辑保持在 Runtime 内。

Runtime 通过专用 stdio 交换逐行 JSON，每帧最多 192 KiB、最多 8 个在途请求。stdout 消费者在 spawn 后同步挂接；probe 最多保留配置的输出预算（默认 64 KiB），设备码最多保留 16 KiB，stdio 在进程登记期间有界读取，登记与 SQLite 状态提交完成后才转发业务请求。宿主覆盖 run 和 epoch，只转发业务操作；续租、启动、停止和通知回执由宿主发起。普通 `poll_wake` 合并通用通知；Thread 等待只能使用中心 pending 响应建立的绑定，每 run 最多 64 个绑定。结果返回后删除绑定，并保留同一调用在途响应的最终结果，避免迟到的 pending 恢复绑定。

`project-runtime.db` 使用现有 Effect SQLite、WAL/FULL 和提交结果核查。启动意图先提交，同一 run 不再次启动；进程记录保存 PID 与创建时间。进程树、stdio 和控制目录收尾后保存清理证据，独立循环先补送 exited、再补送 stopped。领取先提交下次尝试时间，失败按最多 30 秒退避重试，并为每次管理请求预留 5 秒。SQLite 暂时不可写时，最多 4 个 run 的名额同时约束活动实例和待保存清理事实。重启后可核实的进程记录经过平台回收再补写证据；只有启动意图、没有进程或清理证据的旧记录保持未确认。

租约使用 `max(hrtime 经过值, wall 经过值)`，默认每 20 秒续租，58 秒未成功续租时自停，检查间隔 200ms。发送及接受续租前都检查原期限，成功续租从请求开始时刻计时。注入的 `clock` 和 `timing` 用于确定性测试；时钟失败会停止所属运行。

`runProjectCLI('probe'|'subscriptions'|'login', provider?, options?)` 显式保护新建的临时目录，在其中保存私有进程记录；POSIX 另启动 watchdog，不创建 manager 或 SQLite。终端登录转接标准输入输出，支持 SIGINT/SIGTERM 取消。probe 只读取本地凭据和静态模型目录，默认限制 5 秒及 64 KiB；设备采集可用 `report()` 在 probe 无效时省略能力。设备码登录取得首行后继续后台等待，最长 15 分钟，同 provider 的并发请求串行替换，退出时刷新能力。

验证：

```sh
pnpm --filter @baton/batond typecheck
pnpm exec vp fmt --check apps/batond/src/project
pnpm exec vp lint apps/batond/src/project --deny-warnings
pnpm --dir apps/batond exec vp test run --config ../../vitest.config.ts src/project
```

测试使用本机进程、SQLite、注入时钟和现有 Runtime 的 faux provider，覆盖重连、重复启动、旧 epoch、睡眠、清理证据、回执丢失、进程恢复、设备码登录和 stdio 容量。平台进程回收沿用 `platform/process` 的进程组/watchdog 与 Windows PID 创建时间/taskkill 边界；Windows 原生执行尚需在对应系统验证。
