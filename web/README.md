# Baton Web UI

员工 Web UI，按 `design/` 的 Elyx 设计稿实现，文案遵循 `design/WRITING.md`。构建、开发和检查命令写在仓库根目录的 README。

## 目录

| 目录 | 内容 |
|---|---|
| `src/theme` | 设计 token、字体、浅色和深色主题。`tokens.stylex.ts` 与 `themes.ts` 由 `pnpm tokens` 从 `design/tokens` 生成，不手改 |
| `src/ui` | 通用组件：按钮、状态点、横幅、卡片、输入区、菜单、弹窗等 |
| `src/app` | 路由、侧栏和页面框架，以及多个页面共用的 Thread 行、文件预览 |
| `src/pages` | 各路由的页面 |
| `src/data` | `BatonClient` 接口、查询 hooks、由多个对象组合出的显示状态（`derive.ts`） |
| `src/data/mock` | 模拟数据：场景、状态变化、延迟和事件都在这里 |
| `src/dev` | 开发模式下的场景面板 |

## 数据

页面只通过 `BatonClient` 读写数据。对象之间用稳定 ID 关联，客户端按主题（devices、threads、files 等）发出变化通知，`ClientProvider` 收到后刷新对应查询，所以设备状态变化会同时反映到 Thread、Project 和文件预览。

目前只有模拟实现。操作返回 `Operation`，依次经过已提交、已保存、等待设备、执行中、已停止等阶段，界面按阶段显示进度。模拟延迟和后台事件都经过 `Scheduler`，测试中用 `manualScheduler` 手动推进时间。

## 模拟场景

开发模式下页面右下角有场景面板，可以切换场景、重置数据、切换设备在线状态，以及模拟连不上 Baton（登录和退出都会失败）。已登录时还可以让登录过期或模拟管理员重置密码，页面会回到登录页并显示对应提示。也可以在地址栏加 `?scenario=<id>` 打开指定场景。

| 场景 | 内容 |
|---|---|
| `normal` | 三台设备、四个 Project、进行中的 Thread 和待处理事项 |
| `empty` | 已登录但还没有设备，显示首次使用引导 |
| `signedOut` | 未登录，打开任何页面都进入登录页 |
| `offline` | Ubuntu Dev 和 MacBook Pro 离线：执行中的 Thread 提示设备离线，Project 助手等待可用设备 |
| `waiting` | Windows Desktop 同步中，发给它的消息已保存等待发送；另一条消息排在执行中的 Thread 后面 |
| `error` | Thread 停止、Thread 状态未知，ChatGPT 登录过期导致 Project 助手停止 |
| `conflict` | 事项已在别处处理，回答时提示冲突 |

模拟登录接受任意非空用户名和密码，密码为 `wrong` 时返回登录失败。仓库里不保存真实账号或口令。

## StyleX 约定

样式用 `stylex.create` 定义，颜色、间距、圆角和尺寸取自 `src/theme/tokens.stylex.ts`，文字样式取自 `src/theme/text.ts`。页面不写内联 `style`，因为生产环境的 CSP 只允许同源样式表；Base UI 通过 `CSPProvider disableStyleElements` 关闭运行时插入的 `<style>`。

修改 `design/tokens` 后运行 `pnpm --dir web tokens` 重新生成主题文件。
