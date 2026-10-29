# Baton Web UI

员工 Web UI，文案遵循 [WRITING.md](WRITING.md)。构建、开发和检查命令写在仓库根目录的 README。

## 目录

| 目录 | 内容 |
|---|---|
| `src/theme` | 设计 token、字体、浅色和深色主题；新颜色在 `tokens.stylex.ts` 声明，在 `themes.ts` 补上两套主题的取值 |
| `src/assets` | 品牌标识、favicon 和背景图；通用图标使用 Phosphor Icons，由 `Icon` 统一尺寸、颜色和语义 |
| `src/ui` | 通用组件：按钮、状态点、横幅、卡片、输入区、菜单、弹窗等 |
| `src/app` | 路由、侧栏和页面框架，以及多个页面共用的 Thread 行、Thread 详情、受限 Markdown、项目设置与记忆编辑、文件预览和选择目录弹窗 |
| `src/pages` | 各路由的页面 |
| `src/data` | `BatonClient` 接口、查询 hooks、由多个对象组合出的显示状态（`derive.ts`） |
| `src/data/http` | 默认使用的真实客户端：会话与 CSRF、设备、Project、Thread、文件与操作状态 |
| `src/data/mock` | 开发与测试使用的模拟数据、场景、状态变化、延迟和事件 |
| `src/dev` | 开发模式下的场景面板 |

## 运行方式

工作区侧栏、Project 和 Thread 的右侧面板以及文件预览列表可拖动边界调整宽度；聚焦边界后可用左右方向键调整，按住 Shift 加快调整，Home 和 End 跳到两端。宽度保存在本机浏览器中，并随窗口大小限制。

默认使用 HTTP 客户端，向同源 `/api/v1` 发出 JSON 请求。生产环境由 TypeScript 中心提供静态页面与 API；开发环境也默认连接真实后端。网页构建默认输出到 `apps/server/dist/web`，中心的 `build` 和 `dev` 会自动构建网页，SQL 迁移随中心 bundle 一同复制。开发服务器只有在地址中显式添加 `?mock=1` 或 `?scenario=<id>` 时才启用模拟客户端和场景面板。生产构建始终使用 HTTP 客户端。

使用 Vite 开发服务器连接 Coordinator 时，可设置 `BATON_DEV_BACKEND` 为后端地址。代理转发 `/api` 下的 HTTP 和 WebSocket 请求，并将 Origin 调整为后端来源；浏览器仍访问开发服务器的同源路径。该配置仅用于开发服务器，生产构建使用页面所在的来源。

Vite 代理保持后端 TLS 证书验证。后端使用私有 CA 时，在启动开发服务器前设置 `NODE_EXTRA_CA_CERTS`，指向签发该证书的 CA PEM 文件，让 Node.js 信任证书链。

## 数据

Thread 和 Project 的聊天正文使用 Streamdown 渲染 Markdown；Thread 的 Agent 回复在生成时逐段显示，保存的同一条回复出现后替换实时内容。Project 助手生成时显示带历史序号的文本预览；已保存的后续事件到达时隐藏旧预览，正式回复以持久内容为准。预览每秒最多更新一次，超限时标记截断。行内代码中的绝对路径可打开文件预览。图片和原始 HTML 不渲染，链接只允许 HTTP、HTTPS 和 mailto。shell 实时输出以纯文本显示。

Project 助手的活动默认折叠为命令、工具和笔记的数量；展开后可逐项查看命令输出或工具输入与结果。工具调用按调用 ID 与结果配对，未收到结果和调用失败分别标记；关联 Thread、回复和设备状态仍显示在对话中。

文件预览用 Highlights 为支持的语言着色，无法加载高亮器、不支持的语言或超过 262,144 个 UTF-16 代码单元的内容以原文显示；行选择和分片续读沿用相同的文本。执行过程中的 unified diff 使用 Diffs 展示；无法解析的变更和工具错误显示原文。Highlights 需要浏览器允许 WebAssembly 和 SIMD；Diffs 在不可用时使用 Shiki 的 JavaScript 后端。

对话使用流式 Markdown 展示回复，支持中文强调、表格、块级公式和 Mermaid 图表。代码高亮在 Worker 中计算，Worker 不可用时回退到主线程；流式代码保留已有高亮，新增内容先显示原文。图表禁用外部链接和图片，无法渲染时显示源码；部署时的图片 CSP 须允许 `data:` 才能显示图表预览。

Thread 回复的操作栏在桌面悬停或键盘聚焦时显示；触屏上最新回复的操作栏常显，点按较早回复可显示其操作。回复复制与提交 SHA 复制分别作用于各自内容。

页面只通过 `BatonClient` 读写数据。对象之间用稳定 ID 关联，客户端按主题（devices、threads、files 等）和可选的变更对象发出通知，`ClientProvider` 收到后刷新对应查询，所以设备状态变化会同时反映到 Thread、Project 和文件预览。

HTTP 客户端读取真实 API 返回的记录、能力和操作结果。操作返回 `Operation`，界面按操作阶段显示进度。列表、主对话和记忆版本按各接口的游标读完全部页面。

远程 Thread 支持 Cursor、Codex、Kiro 和 Pi。设备报告保留 Agent 的 `status`、`reason` 和 `capabilities.create`；只有 `available` 且明确支持 `create` 时才能新建对话，未知状态和 `unverified` 均不可创建，并显示设备报告的原因。消息已保存、设备已接收和 Agent 已打开分别处理；`opened_at` 为空时显示启动中或等待设备，`resume_pending` 为真时持续显示恢复中，停止与归档等待设备执行结果确认。详情通过 `/threads/{id}` 和时间线读取。时间线就是 Thread 历史：中心保存的输入和回复，按游标分页，设备离线时仍然显示。网页不解析各 Agent 的原生会话，在 Baton 之外继续同一会话产生的消息不会出现。刷新页面后仍能显示待完成的恢复。

Thread 页面独立于 Project 查询。后端未提供这些接口时，远程 Thread 的创建、发送、输出、停止、恢复及归档继续使用现有 HTTP 契约；项目查询失败显示不可用，业务数据始终来自接口。选择工作目录使用 `/nodes/{id}/files` 的 roots 和 directory 响应；根目录管理、Project、附件和订阅功能需要后端提供各自的接口。

网页打开或刷新时，通过 `GET /api/v1/me` 和会话 Cookie 恢复登录状态，并取得 CSRF token。需要 CSRF 校验的写请求携带 `X-CSRF-Token`；尚未取得 token 时先读取 `/me`，收到 `csrf_rejected` 时重新读取 `/me` 并重试原请求一次。会话失效后返回登录页，保留可恢复的站内位置。首次登录或管理员重置口令后，`must_change_password` 要求用户先在 `/password` 修改口令；保存成功后重新登录，再进入工作区。

已登录且有页面订阅时，客户端连接 `/api/v1/events` WebSocket。`thread.changed` 携带 UUID `thread_id` 和 `change: "detail"` 时，读取该 Thread 的详情并更新已加载列表中的对应项，同时刷新它的消息、过程、实时输出查询与操作状态；其他 Thread 的列表项与详情保持不变。`project.changed` 携带 UUID `project_id` 和相同的 `change` 时，读取该项目及其状态并更新已加载列表中的对应项，同时刷新它的主对话、记忆、记忆来源、记忆状态。列表缓存加入新对象，保留归档对象，页面自行筛选；对象不存在时移除对应项。单对象读取失败时重新读取该类列表。缺少 ID、ID 无效或 `change` 未识别时，按事件对应的主题全量刷新。

`nodes.changed { node_id }` 表示设备同步完成或连接状态变化，收到后重新读取设备报告，并刷新项目、Thread、消息 和操作状态。收到带有 `node_id`、非负整数 `report_version` 的 `devices.changed` 后重新读取设备报告，能力以查询结果为准；这两类事件都保持文件和目录只在用户操作时读取。同时每 2 秒通知刷新设备、项目、Thread、消息 和操作状态，补充尚无服务器事件覆盖的变化；连接断开后，轮询继续执行并尝试重连。

已保存的项目、Thread、消息、记忆及版本由 Coordinator 和设备按各自职责持久化，刷新网页后从真实接口重新读取。Thread 的输入和回复从中心读取，设备离线时仍然可见。执行过程根据结束记录的 `item_count` 建立入口，同轮只在首条回复上显示；没有回复时挂在故障行或单独显示过程行。过程按步骤类型展示，从中心按游标逐页读取；加载更多和重试保留已显示的步骤，设备离线或本地会话历史删除后仍可阅读。步骤被截断时标出缺口和原始大小，可通过现有 `full_output` 接口从设备分页读取全文；设备离线只影响全文读取。步骤数据只渲染为文本，未知类型保留 JSON，Base64 命令输出标明编码。文件内容与实时输出仍从设备读取，离线、记录缺失和实时输出缺口按实际状态呈现。未保存的草稿与引用选择保存在当前页面或工作区内存中，刷新网页或离开工作区后清除。

项目侧栏在助手回复未读时显示圆点。页面可见且用户读到最新回复时更新已读水位；浏览旧记录或切到后台不清除未读。暂停保留未读，归档后不展示圆点。故障原因和重试按钮显示在输入区上方；桌面待处理计数包含有未读回复的非归档项目和有未回答问题的非归档 Thread。



项目标题栏的操作菜单提供设置、Memory、暂停恢复和归档入口；概览右上角也可打开设置。名称和目标在字段失去焦点时自动保存，订阅和模型在选择后保存，同一项目的设置写入按顺序完成。保存失败保留修改并提供重试；设置可随时关闭，未保存内容在当前工作区内按项目保留，重新打开后继续编辑，也可以明确丢弃。暂停和恢复直接作用于已保存的项目，与字段保存独立；字段保存的缓存更新只合并本次修改的字段，保留同时写入的最新项目状态。模型配置从下一次助手运行生效，当前运行沿用开始时的配置。

离线设备也可一次点击设为默认。保存后提示设备当前离线，新建在该设备上的 Thread 等待重连，Project 可使用其他可用设备。

项目订阅和模型目录来自设备上报的 `project_runtime.providers[].models`，按 provider 合并并去重；Thread 的 Agent 和模型来自设备对应的 Agent 能力报告。Project Runtime 当前支持 `openai-codex` 和 `xai`，界面分别显示 ChatGPT 和 xAI。设备未上报模型目录时，界面显示空目录提示并提供手填 provider ID、model ID 的入口；已有未出现在目录中的配置保留原值，可继续编辑或切回设备目录。选择模型后仍需有在线、同步完成、Runtime 已安装且声明该 provider 的设备，助手才能运行。认证检查为 unknown 时允许尝试，界面注明检查未知；明确 `login_required` 时提示登录。设备报告的凭据权限、归属、路径和安全打开错误显示具体原因，不统一解释为未登录。

对话输入区根据设备上报的模型能力展示思考强度。每条开启新回复的消息保存所选值；重新打开对话时，若最近一条排队消息使用当前模型，则显示它的选择；切换模型后使用该模型默认值。立即插话沿用当前回复的设置。

Memory 展示最新内容、版本、来源和时间，可添加、编辑并查看保留的历史版本。保存冲突展示最新已保存内容，保留用户草稿；点击 `Review latest` 核对后，再次保存产生新版本。名称、目标和记忆修改作为被动更新，等下一次主动输入一起交给项目助手；同一条记忆的连续修改只交付最新版本。

暂停会中断当前助手运行并保存未处理输入，主对话新消息仍可保存，Thread 照常可用。恢复后继续处理积压输入；普通模型失败按退避继续自动尝试，用户也可显式重试。归档停止助手和运行中的 Thread，保留主对话、记忆及版本。侧栏的 `Archived projects` 打开归档列表；归档项目的主对话、设置和记忆只读。

设置弹窗和 Memory 标签分别由地址中的 `settings`、`view=memory` 参数控制，归档确认可通过 `settings=true&archive=true` 打开。设置和记忆的未保存草稿按项目或记忆 ID 留在当前工作区内，页面往返时保留；保存完成后清除对应草稿，取消记忆编辑也会清除该草稿。刷新或退出工作区清除全部草稿。

## 桌面桥接

网页通过 `window.batonDesktop` 的 `protocol: 1` 使用桌面能力。`capabilities` 是可选的名称与版本列表；当前识别 `notifications` 和 `tray-status` 的版本 1，忽略未知名称或版本。普通浏览器和没有声明能力的客户端继续使用原有网页功能；旧客户端的设备接入不依赖能力列表。

通知沿用协议的 `BrowserNotification` 事件。网页打开、WebSocket `ready`、通知到达及后台数据刷新时，从 `/api/v1/events/replay?after=<cursor>&limit=100` 按顺序重放，整页交给原生端确认保存后才推进游标。实时事件只触发重放，不直接跳到实时游标。第一次没有原生游标时，读取中心当前游标建立基线；重新加载和断线重连继续读取已保存游标之后的事件。游标保持十进制字符串，按中心来源与员工 ID 隔离，原生端持久化并去重。暂时断网或原生保存失败时，下次数据刷新重试。

网页把路由中实际打开的 Thread ID 交给原生端，由原生端同时检查窗口是否聚焦和可见，决定是否抑制通知。原生通知或托盘菜单传回对象 ID 后，网页重新读取对象：可用的 Thread 在列表详情或所属 Project 中打开；已删除或归档的 Thread 回到 Threads，已删除或归档的 Project 回到项目归档列表，并显示原因。设备通知使用 `/devices?device=<id>` 展开对应设备。退出工作区时取消通知订阅，清除原生端的当前 Thread 和托盘计数。

托盘从 `/api/v1/activity` 读取全员工快照。运行数是运行中的 Thread 数；等待数是有待回答问题的 Thread 数和有未读回复的项目数之和。等待菜单最多显示 5 条 Thread。模拟客户端使用 Thread 和项目状态计算相同统计。通知标题和正文沿用中心返回的内容，通知开关和系统权限由原生客户端管理。

## 模拟场景

在开发服务器地址中添加 `?mock=1` 或 `?scenario=<id>` 后，页面右下角显示场景面板，可以切换场景、重置数据、切换设备在线状态，以及模拟连不上 Baton（登录和退出都会失败）。模拟业务数据在刷新或重置场景时重新生成，延迟和后台事件经过 `Scheduler`，测试中用 `manualScheduler` 手动推进时间。模拟模型目录和助手回复仅用于这些开发场景。

已登录时还可以让登录过期或模拟管理员重置口令，页面会回到登录页并显示对应提示。设备页的连接弹窗打开后，面板会出现「Setup code waiting」，可以模拟设备接入、设置码过期或已在别处使用。

| 场景 | 内容 |
|---|---|
| `normal` | 三台设备、四个 Project 和进行中的 Thread。Baton Dev 的助手开了一个 Thread 正在等回复，Compatibility 的助手已经汇报结果。`Rebuild web UI foundation` 的回复包含 Markdown 示例、执行过程、文件和提交附件；Ubuntu Dev 的 `logs` 目录里有超过 64 KB 的日志，模拟文件树的 `apps/server/src/testing/data` 中有二进制样本 |
| `streamingMarkdown` | `Streaming Markdown demo` 逐段生成包含表格、代码块和链接的回复；通过场景面板的重置按钮重新播放 |
| `streamingProject` | Compatibility 的模拟助手逐段生成回复，再显示工具调用和返回结果；通过场景面板的重置按钮重新播放 |
| `downloads` | 提供 macOS、Linux CLI 与 macOS、Windows 桌面下载元数据，展示安装命令和接入链接；模拟文件不可实际下载 |
| `noDownloads` | 下载未启用，注册对话框显示原有终端命令 |
| `empty` | 已登录但还没有设备，显示首次使用引导 |
| `noChats` | 设备已接入但还没有对话，Threads 页显示空列表，可以从顶部输入区开始第一个对话 |
| `signedOut` | 未登录，打开任何页面都进入登录页 |
| `offline` | Ubuntu Dev 和 MacBook Pro 离线：执行中的 Thread 只显示最后报告的状态，停止请求等设备连上再发出，Project 助手等待可用设备，发给它的消息已保存；Ubuntu Dev 重新连上后，Fix gateway reconnect race 的实时输出标出断开期间丢失的一段 |
| `waiting` | Windows Desktop 同步中，发给它的消息已保存等待发送；另一条消息排在执行中的 Thread 后面；Kiro 收到停止后没有停下，一分钟后由设备结束进程；Docs Cleanup 的模拟订阅尚未在在线设备上登录，消息保存后等待设备 |
| `error` | 展示 Thread 的停止原因、状态未知和 Project 助手的登录故障，以及保存和读取失败后的重试 |
| `maintenance` | 项目设置、Memory、暂停恢复与归档，可从 `/projects/prj-compat?settings=true&scenario=maintenance` 开始 |
| `maintenanceError` | 项目列表、Compatibility 的记忆首次读取失败；设置、记忆和项目状态各有一次保存失败，均可重试 |
| `memoryConflict` | 首次编辑 `mem-compat-1` 时，助手先保存一个新版本，展示最新内容并保留用户草稿 |
| `archived` | Compatibility 已归档，主对话、设置和记忆只读，原有 Thread 保留 |

模拟的 Project 助手按关键词判断消息是不是要在设备上做的事（run、test、fix 等），按消息里提到的设备开 Thread；提到两台设备或写了 both、two 时开两个，每个 Thread 约 8 秒后回复，全部回复后助手汇报。

模拟登录用于验证表单、失败反馈与页面跳转，真实模式的身份与口令校验由 Coordinator 完成。

## StyleX 约定

样式用 `stylex.create` 定义，颜色、间距、圆角和尺寸取自 `src/theme/tokens.stylex.ts`，文字样式取自 `src/theme/text.ts`。流式 Markdown 使用 `@lobehub/streamdown`，该组件会插入动画样式和内联动画时序；部署时的 CSP 须允许内联样式。Base UI 通过 `CSPProvider disableStyleElements` 关闭自身运行时插入的 `<style>`。

开发、构建和测试使用 Vite+。代码格式与推荐 lint 规则由根目录 `vite.config.ts` 中的 Oxfmt、Oxlint 配置统一管理；改完运行 `pnpm check`，单独格式化运行 `pnpm --dir web format`。依赖统一使用根工作区锁文件。Markdown 不参与格式化，表格沿用仓库其他文档的紧凑写法。
