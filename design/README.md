# Baton 界面设计

Baton Web UI 的 Elyx 设计项目，包括设计系统总览和第一个里程碑用到的页面。项目根目录为 `design/`，配置保存在 `elyx.json`。产品行为以仓库 `specs/` 为准，设计稿里的文案和状态都对应其中的条目。

在 Elyx 中打开此目录，或在仓库根目录运行：

```sh
elyx design
```

## 页面

| 文件 | 内容 | 对应规格 |
|---|---|---|
| [index.elyx](index.elyx) | 设计系统总览：设计规则、颜色、文字、控件、状态、主对话条目、输入区与横幅 | — |
| [screens/project.elyx](screens/project.elyx) | Project 页的四个状态：运行中、所有设备离线、需要处理、已暂停 | PA-07、PA-13、PA-22、PA-23 |
| [screens/project-task.elyx](screens/project-task.elyx) | 在 Project 页右侧打开 Project Agent 开的 Thread，主对话里有对应的事项 | PA-19、PA-22、IB-08 |
| [screens/inbox.elyx](screens/inbox.elyx) | 待处理：跨 Project 的事项和系统事项 | IB-06、IB-10、IB-18 |
| [screens/devices.elyx](screens/devices.elyx) | 设备列表，展开的设备上有「允许 Project Agent 执行命令」 | PA-06、PA-21 |
| [screens/new-project.elyx](screens/new-project.elyx) | 新建 Project 弹窗和创建后的空对话 | PA-01、PA-04 |
| [screens/project-settings.elyx](screens/project-settings.elyx) | Project 设置弹窗和归档确认 | PA-04、PA-23、IB-16 |

Project 页的各个状态都是 `blocks/project-page.elyx` 的实例，只覆盖和默认状态不同的部分。

## 文件组织

| 路径 | 用途 |
|---|---|
| `tokens/` | 语义颜色、Project 头像底色、深色主题覆盖、间距、圆角和骨架尺寸 |
| `foundations/` | 文字样式 |
| `controls/` | 按钮、输入框、下拉选择、字段、开关、状态点与状态标签、数量与标签、头像、标签页、快捷键和图标 |
| `blocks/` | 侧栏、Project 标题栏、主对话条目、任务卡片、事项卡片、输入区、横幅、概览栏、任务详情、设备行、弹窗和完整的 Project 页 |
| `screens/` | 完整页面，每个文件一类页面 |
| `resources/assets/` | SVG 图标 |
| `resources/fonts/` | 项目字体目录，当前为空 |
| `renders/` | 本地渲染结果，已被 Git 忽略 |

## 字体

设计稿的界面字体是 PingFang SC，代码字体是 Paper Mono，含中文的等宽内容用 Maple Mono CN，Elyx 里的族名写 `Maple Mono Normal NF CN`。Elyx 不做字体回退，中文必须用带中文字形的字体，否则显示为缺字方框。字体文件不随项目提供，在其他设备上查看时需要安装 Paper Mono 和 Maple Mono Normal NF CN。

Web 端界面使用系统 UI 字体栈，不打包字体文件：

```css
font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB",
  "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
font-family: "Paper Mono", "Maple Mono Normal NF CN", "Maple Mono CN", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
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
