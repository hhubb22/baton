# Baton 界面设计

Baton Web UI 的 Elyx 设计项目，包括设计系统总览和第一个里程碑用到的页面。项目根目录为 `design/`，配置保存在 `elyx.json`。产品行为以仓库 `specs/` 为准，界面交互和文案遵循 [WRITING.md](WRITING.md)。设计稿里的状态对应产品规格。

在 Elyx 中打开此目录，或在仓库根目录运行：

```sh
elyx design
```

## 页面

| 文件 | 内容 | 对应规格 |
|---|---|---|
| [index.elyx](index.elyx) | 设计系统总览：设计规则、颜色、文字、控件、状态、主对话条目、输入区与横幅 | — |
| [screens/project.elyx](screens/project.elyx) | Project 页的四个状态：运行中、所有设备离线、需要处理、已暂停 | PA-07、PA-13、PA-22、PA-23 |
| [screens/project-thread.elyx](screens/project-thread.elyx) | 在 Project 页右侧打开 Thread 详情的两个状态：空闲时带展开的过程记录、事项和选中文字提问，执行中带实时输出和 Thread 输入区 | R-08、R-09、R-10、R-11、R-15、R-16、R-17、PA-19、PA-22、IB-08、IB-13 |
| [screens/inbox.elyx](screens/inbox.elyx) | 待处理：跨 Project 的事项和 Project Agent 暂停的系统事项 | IB-06、IB-10、IB-18 |
| [screens/threads.elyx](screens/threads.elyx) | Thread 页：顶部新建 Thread 的输入区、位置菜单、模型菜单、分组列表、右侧打开详情、换模型、状态未知、等待设备和文件预览 | R-05、R-06、R-07、R-08、R-10、R-13、R-14、R-18 |
| [screens/devices.elyx](screens/devices.elyx) | 设备列表、助手可用情况、允许访问的文件夹与命令权限；连接设备和断开设备确认弹窗 | R-02、R-04、R-06、PA-06、PA-21 |
| [screens/login.elyx](screens/login.elyx) | 登录、账号或口令不对、口令被管理员重置 | R-01、D2 |
| [screens/new-project.elyx](screens/new-project.elyx) | 新建项目弹窗、名称校验和创建后的任务输入引导 | PA-01、PA-04 |
| [screens/project-settings.elyx](screens/project-settings.elyx) | Project 设置弹窗和归档确认 | PA-04、PA-23、IB-16 |

Project 页的各个状态都是 `blocks/project-page.elyx` 的实例，Thread 页的各个状态都是 `blocks/thread-list.elyx` 的实例，只覆盖和默认状态不同的部分。Thread 详情的全部状态（执行中、正在停止、执行中设备离线、等待设备、状态未知、已停止、无法恢复、已归档）在 `blocks/thread-detail.elyx`；位置菜单和模型菜单在 `blocks/new-thread.elyx`，目录不存在和历史被删的状态提供换文件夹、新建对话入口；连接设备和文件预览的各个状态分别在 `blocks/enroll-dialog.elyx`、`blocks/file-preview.elyx`。

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

## 字体

设计稿文案、画板 `title` 和 `caption` 均使用英文；界面字体是 PingFang SC，代码与等宽字体是 Paper Mono。字体文件不随项目提供，在其他设备上查看时需要安装 Paper Mono。

Web 端界面使用系统 UI 字体栈，不打包字体文件：

```css
font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB",
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
