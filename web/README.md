# Baton Web UI

员工 Web UI，按 `design/` 的 Elyx 设计稿实现，文案遵循 `design/WRITING.md`。构建、开发和检查命令写在仓库根目录的 README。

## 目录

| 目录 | 内容 |
|---|---|
| `src/theme` | 设计 token、字体、浅色和深色主题。`tokens.stylex.ts` 与 `themes.ts` 由 `pnpm tokens` 从 `design/tokens` 生成，不手改 |
| `src/ui` | 通用组件：按钮、状态点、横幅、卡片、输入区、菜单、弹窗等 |
| `src/app` | 路由、侧栏和页面框架，以及多个页面共用的 Thread 行、Thread 详情、事项卡片、受限 Markdown、项目设置与记忆编辑、文件预览和选择目录弹窗 |
| `src/pages` | 各路由的页面 |
| `src/data` | `BatonClient` 接口、查询 hooks、由多个对象组合出的显示状态（`derive.ts`） |
| `src/data/http` | 默认使用的真实客户端：会话与 CSRF、设备、Project、Thread、Inbox、文件与操作状态 |
| `src/data/mock` | 开发与测试使用的模拟数据、场景、状态变化、延迟和事件 |
| `src/dev` | 开发模式下的场景面板 |

## 运行方式

默认使用 HTTP 客户端，向同源 `/api/v1` 发出 JSON 请求。生产环境由 Coordinator 提供嵌入式页面与 API；开发环境也默认连接真实后端。开发服务器只有在地址中显式添加 `?mock=1` 或 `?scenario=<id>` 时才启用模拟客户端和场景面板。生产构建始终使用 HTTP 客户端。

使用 Vite 开发服务器连接 Coordinator 时，可设置 `BATON_DEV_BACKEND` 为后端地址。代理转发 `/api` 下的 HTTP 和 WebSocket 请求，并将 Origin 调整为后端来源；浏览器仍访问开发服务器的同源路径。该配置仅用于开发服务器，生产构建使用页面所在的来源。

Vite 代理保持后端 TLS 证书验证。后端使用私有 CA 时，在启动开发服务器前设置 `NODE_EXTRA_CA_CERTS`，指向签发该证书的 CA PEM 文件，让 Node.js 信任证书链。

## 数据

页面只通过 `BatonClient` 读写数据。对象之间用稳定 ID 关联，客户端按主题（devices、threads、files 等）发出变化通知，`ClientProvider` 收到后刷新对应查询，所以设备状态变化会同时反映到 Thread、Project 和文件预览。

HTTP 客户端读取真实 API 返回的记录、能力和操作结果。操作返回 `Operation`，界面按操作阶段显示进度；事项处理在保存后返回生效或冲突结果。列表、主对话和记忆版本按各接口的游标读完全部页面。

远程 Thread 支持 Cursor、Codex、Kiro 和 Pi。设备报告保留 Agent 的 `status`、`reason` 和 `capabilities.create`；只有 `available` 且明确支持 `create` 时才能新建对话，未知状态和 `unverified` 均不可创建，并显示设备报告的原因。消息已保存、设备已接收和 Agent 已打开分别处理；`opened_at` 为空时显示启动中或等待设备，`resume_pending` 为真时持续显示恢复中，停止与归档等待设备执行结果确认。详情通过现有 `/threads/{id}` 和时间线读取，刷新页面后仍能显示待完成的恢复。

Thread 页面独立于 Project 和 Inbox 查询。后端未提供这些接口时，远程 Thread 的创建、发送、输出、停止、恢复及归档继续使用现有 HTTP 契约；项目查询失败显示不可用，业务数据始终来自接口。选择工作目录使用 `/nodes/{id}/files` 的 roots 和 directory 响应；根目录管理、Project、附件和订阅功能需要后端提供各自的接口。

网页打开或刷新时，通过 `GET /api/v1/me` 和会话 Cookie 恢复登录状态，并取得 CSRF token。需要 CSRF 校验的写请求携带 `X-CSRF-Token`；尚未取得 token 时先读取 `/me`，收到 `csrf_rejected` 时重新读取 `/me` 并重试原请求一次。会话失效后返回登录页，保留可恢复的站内位置。首次登录或管理员重置口令后，`must_change_password` 要求用户先在 `/password` 修改口令；保存成功后重新登录，再进入工作区。

已登录且有页面订阅时，客户端连接 `/api/v1/events` WebSocket，收到 `thread.changed` 后刷新 Thread、消息和操作状态；收到带有 `node_id`、非负整数 `report_version` 的 `devices.changed` 后重新读取设备报告并刷新目录和文件查询，能力以查询结果为准。同时每 2 秒通知刷新设备、项目、Thread、消息、Inbox 和操作状态，补充尚无服务器事件覆盖的变化；连接断开后，轮询继续执行并尝试重连。

已保存的项目、Thread、消息、记忆及版本、事项结果由 Coordinator 和设备按各自职责持久化，刷新网页后从真实接口重新读取。完整历史、执行过程和文件内容按接口从设备读取，离线、记录缺失和输出缺口按实际状态呈现。未保存的草稿与引用选择保存在当前页面或工作区内存中，刷新网页或离开工作区后清除。

Inbox 按创建时间从新到旧列出所有项目的待处理事项，侧栏和浏览器标签页显示待处理数量。事项卡片在 Inbox、项目主对话和关联 Thread 里复用，说明默认收起，仅渲染受限 Markdown。选项、最多 4 KiB 的附言、允许时的纯文字回答，以及关闭操作都通过同一数据接口保存。处理结果保留处理人、时间和内容，可从 `Handled items` 查看；遇到其他页面已处理或助手已撤回时，显示已生效的结果。

普通事项的回答和关闭各生成一条项目输入，项目暂停或没有可用设备时仍能保存，等助手可运行时读取。系统事项只能前往项目重试或关闭通知，不生成项目输入。关闭通知后项目仍保持需要处理；设备满足运行条件后，项目中的 `Retry` 恢复助手并解决尚未关闭的系统事项。

事项的选项和回答草稿在当前工作区内按事项 ID 保存，切换页面或从另一个入口打开时保留；提交生效、遇到冲突或取消回答后清空，刷新网页或退出工作区后也清空。事项说明每次打开默认收起，Inbox 的待处理或历史筛选写入地址中的 `handled` 参数，支持直接打开和浏览器返回。

项目标题栏的操作菜单提供设置、Memory、暂停恢复和归档入口；概览右上角也可打开设置。名称和目标在字段失去焦点时自动保存，订阅和模型在选择后保存，同一项目的设置写入按顺序完成。保存失败保留修改并提供重试，关闭设置前会先保存尚未提交的修改。模型配置从下一次助手运行生效，当前运行沿用开始时的配置。

项目订阅和模型目录来自设备上报的 `project_runtime.providers[].models`，按 provider 合并并去重；Thread 的 Agent 和模型来自设备对应的 Agent 能力报告。Project Runtime 当前支持 `openai-codex` 和 `xai`，界面分别显示 ChatGPT 和 xAI。设备未上报模型目录时，界面显示空目录提示并提供手填 provider ID、model ID 的入口；已有未出现在目录中的配置保留原值，可继续编辑或切回设备目录。选择模型后仍需有在线、同步完成、Runtime 已安装且对应订阅已登录的设备，助手才能运行。

Memory 展示最新内容、版本、来源和时间，可添加、编辑并查看保留的历史版本。保存冲突展示最新已保存内容，保留用户草稿；点击 `Review latest` 核对后，再次保存产生新版本。名称、目标和记忆修改作为被动更新，等下一次主动输入一起交给项目助手；同一条记忆的连续修改只交付最新版本。

暂停会中断当前助手运行并保存未处理输入，主对话新消息和事项回答仍可保存，Thread 照常可用。恢复后继续处理积压输入；因系统故障需要处理的项目，恢复后仍需明确重试。归档停止助手并撤回全部待处理事项，保留主对话、记忆及版本，不停止或归档项目中的 Thread。侧栏的 `Archived projects` 打开归档列表；归档项目的主对话、设置和记忆只读，已有 Thread 仍可使用，在只读项目上下文中选中文字提供复制操作。

设置弹窗和 Memory 标签分别由地址中的 `settings`、`view=memory` 参数控制，归档确认可通过 `settings=true&archive=true` 打开。设置和记忆的未保存草稿按项目或记忆 ID 留在当前工作区内，页面往返时保留；保存完成后清除对应草稿，取消记忆编辑也会清除该草稿。刷新或退出工作区清除全部草稿。

## 模拟场景

在开发服务器地址中添加 `?mock=1` 或 `?scenario=<id>` 后，页面右下角显示场景面板，可以切换场景、重置数据、切换设备在线状态，以及模拟连不上 Baton（登录和退出都会失败）。模拟业务数据在刷新或重置场景时重新生成，延迟和后台事件经过 `Scheduler`，测试中用 `manualScheduler` 手动推进时间。模拟模型目录和助手回复仅用于这些开发场景。

已登录时还可以让登录过期或模拟管理员重置口令，页面会回到登录页并显示对应提示。设备页的连接弹窗打开后，面板会出现「Setup code waiting」，可以模拟设备接入、设置码过期或已在别处使用。

| 场景 | 内容 |
|---|---|
| `normal` | 三台设备、四个 Project、进行中的 Thread 和待处理事项。Baton Dev 的助手开了一个 Thread 正在等回复，Compatibility 的助手已经汇报结果。回复带执行过程、文件和提交附件；Rebuild web UI foundation 在设备上还有三轮更早的对话，每页读三条；Ubuntu Dev 的 `logs` 目录里有超过 64 KB 的日志，`internal/gateway/testdata` 里有二进制文件 |
| `empty` | 已登录但还没有设备，显示首次使用引导 |
| `noChats` | 设备已接入但还没有对话，Threads 页显示空列表，可以从顶部输入区开始第一个对话 |
| `signedOut` | 未登录，打开任何页面都进入登录页 |
| `offline` | Ubuntu Dev 和 MacBook Pro 离线：执行中的 Thread 只显示最后报告的状态，停止请求等设备连上再发出，Project 助手等待可用设备，发给它的消息已保存；Ubuntu Dev 重新连上后，Fix gateway reconnect race 的实时输出标出断开期间丢失的一段 |
| `waiting` | Windows Desktop 同步中，发给它的消息已保存等待发送；另一条消息排在执行中的 Thread 后面；Kiro 收到停止后没有停下，一分钟后由设备结束进程；Docs Cleanup 的模拟订阅尚未在在线设备上登录，消息保存后等待设备 |
| `error` | Thread 的各种停止原因：目录不存在、设备重启打断（Kiro 不能恢复，Pi 恢复时找不到对话记录）、Agent 启动失败；另一个 Thread 状态未知，不会自动重发；ChatGPT 登录过期导致 Project 助手需要处理，并生成系统事项；第一次新建 Project 和第一次处理事项保存失败，重试可再次提交；Rebuild web UI foundation 的回复过程、更早的对话和 `reconnect_test.go` 预览第一次读取失败，重试成功；Write batond setup guide 的对话记录已删除，回复过程读不到 |
| `conflict` | 事项已在别处处理，回答时提示冲突并展示生效的回答 |
| `inbox` | 选项题、纯文字问题，以及已回答、已关闭、已撤回和已解决的历史事项 |
| `inboxPaused` | Compatibility 暂停，保留全部问题和历史；回答和关闭成功后，项目输入等待恢复 |
| `inboxWithdrawn` | 处理 Windows 路径问题时，助手的撤回先保存，展示撤回原因 |
| `maintenance` | 项目设置、Memory、暂停恢复与归档，可从 `/projects/prj-compat?settings=true&scenario=maintenance` 开始 |
| `maintenanceError` | 项目列表、Compatibility 的记忆首次读取失败；设置、记忆和项目状态各有一次保存失败，均可重试 |
| `memoryConflict` | 首次编辑 `mem-compat-1` 时，助手先保存一个新版本，展示最新内容并保留用户草稿 |
| `archived` | Compatibility 已归档，待处理事项已撤回，主对话、设置和记忆只读，原有 Thread 保留 |

模拟的 Project 助手按关键词判断消息是不是要在设备上做的事（run、test、fix 等），按消息里提到的设备开 Thread；提到两台设备或写了 both、two 时开两个，每个 Thread 约 8 秒后回复，全部回复后助手汇报。

模拟登录用于验证表单、失败反馈与页面跳转，真实模式的身份与口令校验由 Coordinator 完成。

## StyleX 约定

样式用 `stylex.create` 定义，颜色、间距、圆角和尺寸取自 `src/theme/tokens.stylex.ts`，文字样式取自 `src/theme/text.ts`。页面不写内联 `style`，因为生产环境的 CSP 只允许同源样式表；Base UI 通过 `CSPProvider disableStyleElements` 关闭运行时插入的 `<style>`。

开发、构建和测试使用 Vite+。代码格式与推荐 lint 规则由根目录 `vite.config.ts` 中的 Oxfmt、Oxlint 配置统一管理；改完运行 `pnpm check`，单独格式化运行 `pnpm --dir web format`。依赖统一使用根工作区锁文件。Markdown 不参与格式化，表格沿用仓库其他文档的紧凑写法。

修改 `design/tokens` 后运行 `pnpm --dir web tokens` 重新生成主题文件。
