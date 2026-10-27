# Baton 界面设计

Baton Web UI 的 Elyx 设计项目，包含设计系统、品牌资源，以及登录、设备、Thread、项目协同、文件与引用、事项处理、项目维护的页面和状态。项目根目录为 `design/`，配置保存在 `elyx.json`。产品行为以仓库 `specs/` 为准，入口与返回路径见 [FLOWS.md](FLOWS.md)，界面文案遵循 [WRITING.md](WRITING.md)。前端实施顺序和验收范围见 [Web UI 实施计划](../specs/web-ui/PLAN.md)。

在 Elyx 中打开此目录，或在仓库根目录运行：

```sh
elyx design
```

## 页面

| 文件 | 内容 | 对应规格 |
|---|---|---|
| [index.elyx](index.elyx) | 设计系统总览：设计规则、颜色、文字、控件、状态、主对话条目、输入区与横幅 | — |
| [screens/login.elyx](screens/login.elyx) | 登录、提交中、账号或口令错误、口令被重置、登录失效、退出与连接失败 | R-01、D2 |
| [screens/workspace.elyx](screens/workspace.elyx) | 首次进入、账号菜单、退出处理中与失败、收起侧栏、首台设备接入 | R-01、R-02、R-17 |
| [screens/devices.elyx](screens/devices.elyx) | 空设备列表、同步中、能力缺失、默认设备、命令权限保存与失败、断开确认及结果 | R-02～R-06、PA-06、PA-21 |
| [screens/threads.elyx](screens/threads.elyx) | 新建与筛选、目录选择、模型菜单、详情、停止与归档确认、离线等待、恢复、历史读取与文件预览 | R-05～R-18 |
| [screens/new-project.elyx](screens/new-project.elyx) | 创建、校验、提交中与失败、无可用设备时创建、创建后引导 | PA-01、PA-04、PA-07 |
| [screens/project.elyx](screens/project.elyx) | 主对话、运行与等待原因、换设备、停止、暂停恢复、汇报、项目菜单及归档记录 | PA-07、PA-13、PA-22、PA-23、IB-16 |
| [screens/project-thread.elyx](screens/project-thread.elyx) | 项目内 Thread 详情、实时输出、文字引用预填与发送、归档项目内继续使用 Thread | R-08～R-17、PA-19、PA-22、IB-08、IB-13 |
| [screens/desktop-system.elyx](screens/desktop-system.elyx) | 系统通知文案、托盘菜单顺序、系统通知权限、登录启动和编辑器偏好说明 | DC-11～DC-16、DS-19～DS-22 |
| [screens/desktop-thread.elyx](screens/desktop-thread.elyx) | 桌面 Thread 的行内本机图标、macOS / Windows 悬停文案、目录不存在、原生目录选择与范围外错误、保留草稿 | DC-17～DC-19 |
| [screens/desktop-project.elyx](screens/desktop-project.elyx) | 桌面 Project 的行内本机图标与悬停文案、新建时本机目录选择、范围外错误与保留表单 | DC-17～DC-19 |
| [screens/desktop-device.elyx](screens/desktop-device.elyx) | 本机进程、最近退出、版本、升级准备、迁移与失败、外部服务、复制诊断摘要 | DC-20、DC-21 |
| [screens/inbox.elyx](screens/inbox.elyx) | 待处理、空列表、加载与失败、已处理列表、1024px 回答画面 | IB-06～IB-12、IB-18～IB-20 |
| [screens/project-settings.elyx](screens/project-settings.elyx) | 自动保存、失败重试、暂停恢复、归档确认与结果、只读设置 | PA-04、PA-23、IB-16 |
| [screens/project-memory.elyx](screens/project-memory.elyx) | 记忆列表、添加编辑、保存与失败、版本冲突、归档后只读 | PA-17、PA-22 |

Project、Thread 和 Inbox 页面分别复用 `blocks/project-page.elyx`、`blocks/thread-list.elyx` 和 `blocks/inbox-page.elyx`。同一页面的状态只覆盖差异部分。弹窗、表单和卡片的独立状态位于对应 block 文件，便于在多个入口复用。

| 文件 | 独立交互状态 |
|---|---|
| [blocks/enroll-dialog.elyx](blocks/enroll-dialog.elyx) | 各系统注册命令、口令加载与失败、过期、接入结果、复制反馈 |
| [blocks/new-thread.elyx](blocks/new-thread.elyx) | 位置与模型菜单、允许目录选择、设备选择、无目录及读取失败 |
| [blocks/thread-actions.elyx](blocks/thread-actions.elyx) | 操作菜单、停止和归档确认、能力受限原因 |
| [blocks/thread-detail.elyx](blocks/thread-detail.elyx) | 运行、停止、离线、未知、恢复、归档、历史加载分页与实时输出 |
| [blocks/file-preview.elyx](blocks/file-preview.elyx) | 正常、截断、加载、离线、越界、文件不存在、二进制和读取失败 |
| [blocks/project-reference.elyx](blocks/project-reference.elyx) | Thread、文件、事项和长引用的主对话输入区 |
| [blocks/attention-card.elyx](blocks/attention-card.elyx) | 事项默认与展开、回复、终态、重复处理与撤回竞态、系统事项 |
| [blocks/attention-reply.elyx](blocks/attention-reply.elyx) | 附言与纯文字回复、提交中、保存失败、空内容与长度校验 |

桌面画板复用现有页面组件，浏览器画板保持原样。本机目录操作和诊断只在客户端声明对应能力、且目标是本机设备时出现。通知和托盘使用系统原生界面，`screens/desktop-system.elyx#systemReference` 记录文案与顺序，不定义系统控件的视觉样式。`blocks/desktop-local.elyx`、`blocks/desktop-diagnostics.elyx` 和 `blocks/desktop-system.elyx` 提供桌面组合与说明行。

## 文件组织

| 路径 | 用途 |
|---|---|
| `tokens/` | 语义颜色、Project 头像底色、深色主题覆盖、间距、圆角和骨架尺寸 |
| `foundations/` | 文字样式 |
| `controls/` | 按钮、输入框、下拉选择、字段、开关、状态点与状态标签、数量与标签、头像、标签页与分段切换、输入区工具栏的选择片、状态片、快捷键和图标 |
| `blocks/` | 侧栏、Project 标题栏、主对话条目与过程记录、Thread 行与 Thread 卡片、事项卡片、输入区、横幅、概览栏、Thread 详情、Thread 列表、位置与模型菜单、文件预览、设备行、接入设备、弹窗和完整的 Project 页 |
| `screens/` | 完整页面，每个文件一类页面 |
| `resources/assets/` | SVG 图标 |
| `resources/fonts/` | 项目字体目录，当前为空 |
| `renders/` | 本地渲染结果，已被 Git 忽略 |

## 品牌资源

`resources/assets/` 保留原始 SVG，`controls/brand.elyx` 提供设计组件。

| 资源 | 用途 |
|---|---|
| `baton-mark-mono.svg` | 侧栏单色标识，颜色跟随当前主题的正文色 |
| `baton-mark.svg` | 浅色背景上的彩色标识，用于登录页 |
| `baton-mark-dark.svg` | 深色背景上的彩色标识 |
| `baton-app-icon.svg` | 带背景的应用图标 |
| `favicon.svg` | 浏览器图标，通过 SVG 内的媒体查询适配系统主题，供前端接入 |

Baton 品牌标识与项目头像分开使用；项目头像保留项目名称首字母。品牌 SVG 的自带颜色不表示运行状态。

`baton-app-icon-flattened.svg` 是应用图标的设计预览资源，将原 SVG 的变换展开到路径坐标，供 Elyx 渲染使用。前端使用原始 `baton-app-icon.svg`。两个 SVG 的 1024 × 1024 光栅化结果逐像素一致。

彩色标识嵌入可复用组件时，父组件的深色变体显式选择 `brand.colorMarkDark`；示例见 `controls/brand.elyx` 和 `blocks/login-shell.elyx`。

## 字体

设计稿文案、画板 `title` 和 `caption` 均使用英文；界面字体是 Inter，中文回落到 PingFang SC，代码与等宽字体是 Paper Mono。Inter 的 Regular、Medium、SemiBold 和许可证在 `resources/fonts/`，Elyx 通过 `elyx.json` 的 `fonts.include` 加载；Paper Mono 不随项目提供，在其他设备上查看时需要安装。

Web 端随网页打包 Inter 的 woff2 文件，中文和等宽字体用系统字体栈：

```css
font-family: "Inter", system-ui, -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB",
  "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
font-family: "Paper Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
```

## 检查与渲染

修改 `.elyx` 文件后，在仓库根目录对该文件执行格式规范化，再检查整个项目：

```sh
elyx normalize -w design/screens/project.elyx
elyx diagnostics design
```

渲染总览和页面：

```sh
mkdir -p design/renders
elyx render design/index.elyx --ref overview -o design/renders/index.png
elyx render design/screens/project.elyx -o design/renders/project.png
elyx render design/screens/project.elyx --ref offline -o design/renders/project-offline.png
```

默认是浅色主题。查看深色效果时加载深色 token 并选择上下文：

```sh
elyx render design/screens/inbox.elyx --extra-file design/tokens/colors@dark.elyx --context theme=dark -o design/renders/inbox-dark.png
```
