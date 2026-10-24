# 设备管理与文件访问

`makeDeviceService({dataDirectory, runtime, onChanged})` 提供设备管理请求的 `handle(body, signal)`、能力采集 `collect(signal)` / `report(signal)` 和清理 `close()`。调用方在分派前校验控制面来源，并维护信封关联。Runtime 注入接口与 Project manager 的 `probe`、`startDeviceLogin` 一致；后台登录、进程替换和进程树清理由 Runtime host 管理，设备服务按 provider 串行发起登录，在登录结束时通知刷新能力。

目录与 Project 执行配置使用私有文件、进程锁和原子替换。同一进程的配置修改按文件串行执行；其他进程持有锁时返回失败。目录添加解析为真实路径，相同真实路径重复添加返回已有记录；重复移除保持已保存的结果。配置中的空目录列表保留。Project 命令执行默认关闭，远程切换在同一锁内保留 shell、保存并回读；损坏的配置在能力报告中显示关闭，并标记 `truncated`。

`browseFiles` 和附件解析共用登记根、realpath 边界与文件句柄身份检查。登记根被替换为符号链接、目标解析到根外、相对路径含 `..`、路径不允许访问时返回具体错误。读取内容只使用已打开的普通文件句柄，返回前复核路径和祖先身份；Linux 同时检查 `/proc/self/fd` 指向。目录最多扫描 4096 个条目，每页 200 项；文本最多预览 64 KiB，UTF-8 截断保留完整字符，截断结果附带剩余位置。二进制、图片及特殊文件返回拒绝响应。

`scanRuntimeRoots` 扫描登记根内最多 4 层、4096 个条目及 128 个仓库，不跟随遍历中的符号链接。Git 配置只读取至多 16 KiB，经本地 `git config --no-includes --file -` 解析，不读取 include 或全局配置。worktree 元数据也必须位于同一登记根。origin 只包含主机和仓库路径。每次 `collect` 先启动 Runtime 探测，再与本轮唯一的目录扫描重叠等待，共用 2 秒预算；扫描耗尽预算时保留已经完成的探测结果，整轮等待扫描结束后才返回。Runtime 探测失败时省略本次 `project_runtime`。

`boundRuntimeReport` 在合入执行 Agent 目录后再次计量报告，以带缩进的 JSON 保证 64 KiB 预算；依次删除末尾仓库、多余模型和末尾目录，并保留执行 Agent 默认模型。`parseThreadAttachments` 只生成能在授权根内打开的普通文件引用，以及有脱敏仓库地址的完整 commit SHA 引用；附件元数据限制在 4 KiB 内。

本机管理入口由 `runDeviceCLI` 提供，顶层 CLI 负责分派：

```sh
batond files add --id dev --path /绝对目录 --data-dir /私有数据目录
batond files remove --id dev --data-dir /私有数据目录
batond files list --data-dir /私有数据目录
batond project-exec --enabled=true --shell /bin/sh --data-dir /私有数据目录
batond project-exec --enabled=false --data-dir /私有数据目录
```

`project-exec` 必须显式指定 `--enabled=true|false`，开启前输出当前用户权限、任意命令、没有沙箱和注入风险说明。本机命令无需注册或连接中心。订阅登录与状态查询由 Project Runtime 的 CLI 入口提供。

定向验证只使用临时本地文件、PostgreSQL 测试 schema 和 Runtime 假进程：

```sh
pnpm --dir apps/batond exec vp test run --config ../../vitest.config.ts src/devices/devices.test.ts src/devices/config.test.ts
pnpm --dir apps/server exec vp test run --config ../../vitest.config.ts src/device-management.integration.test.ts
```
