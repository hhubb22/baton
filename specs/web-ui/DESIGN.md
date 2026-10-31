# Web UI 设计系统

Baton 网页的视觉和组件以 `web/` 的代码为准，不维护单独的设计稿。组件画廊是 `web/src/dev/Gallery.tsx`，在开发服务器上用 `?gallery=1` 打开，是查看和调整设计的入口，也是验收依据。界面文案遵循 [UX Writing 规范](../../web/WRITING.md)。

## 基调

默认界面是暖灰底的高密度工具，浅色和深色主题都提供。导航的对比度低于内容，让消息和输出处在视觉最前面。磨砂层叠图像和动画只用于登录页、空状态这类低频页面，主工作区不铺图，保证长输出好读。

品牌个性放在内容和低频位置，用像素图形和衬线大标题表达，不影响内容可读性和操作效率。

## 颜色

主题由 base、accent、contrast 三个输入生成，色阶在 OKLCH 中计算。调整这三个值就能得到浅色、深色和高对比主题，页面代码不写具体颜色。代码高亮、Agent 品牌图标和图表 SVG 的颜色属于内容，不走 token。

`theme/generate.ts` 生成颜色，`theme/colors.css` 保存默认输入的结果，测试核对两边一致和 WCAG 对比度。每个值是 `light-dark()` 形式的 CSS 变量，由 `<html>` 的 `color-scheme` 决定显示哪一套；圆角和字体也是 CSS 变量，调节面板和高对比模式直接改写变量。

组件只使用语义 token（`theme/semantic.stylex.ts`），命名沿用 coss ui：`background`、`foreground`、`card`、`popover`、`primary`、`secondary`、`muted`、`accent`、`border`、`input`、`ring`、`destructive`、`info`、`success`、`warning` 及对应的 `-foreground`，侧栏使用 `sidebar` 一组。Baton 另有 `agent`（Agent 运行状态）和 `faintForeground`（三级文字）。页面代码里的 `colors` 是 `tokens.stylex.ts` 中指向这些变量的旧名称，新代码用 `semantic`。

每种颜色有固定职责：

| 职责 | 用法 |
|---|---|
| 页面和面板背景 | `background`、`card`；浮层用 `popover` |
| 组件背景的静止、悬停、选中 | `muted`、`accent` 等半透明中性色 |
| 边框 | `border` 用于分隔，`input` 用于可交互控件，`ring` 用于焦点 |
| 主按钮 | `primary`，中性色 |
| 品牌蓝 | 焦点、选中和链接，不用于大面积填充 |
| 状态 | `success`、`warning`、`destructive`、`info`，只表示状态 |

半透明色只用在背景会透出来的位置，其他位置用不透明色。同一条边界只画一次边框。

## 字体

英文和数字统一使用 Geist 家族，woff2 随网页自托管。`geist` npm 包的入口依赖 `next/font`，不直接使用其入口。中文衬线使用 Noto Serif SC 可变字体（OFL），按 `unicode-range` 分片，共约 6 MB，浏览器只下载页面用到的分片。

| 字体 | 用途 | 中文回退 |
|---|---|---|
| Geist Sans | 界面和正文 | PingFang SC、Hiragino Sans GB、Microsoft YaHei、Noto Sans CJK SC |
| Geist Mono | 代码、路径、ID、等宽数字 | 同上 |
| Geist Serif | Thread 和文档的大标题、登录页、空状态标题，只用 Regular | Noto Serif SC |
| Geist Pixel | 品牌标记、Agent 运行状态、空状态插图、大数字 | 不用于含中文的文字 |

字重只用 400、500、600。微软雅黑只有 Light、Regular、Bold，500 和 600 在 Windows 上分别显示为 Regular 和 Bold，字号层级不能只靠字重区分，需在 Windows 上实测。

文字样式按用途分为四类：Heading 用于标题，Label 用于单行界面文字，Copy 用于多行正文，Mono 用于代码。Label 和 Copy 的常用字号是 14 和 13，12 只用于三级信息。数字列使用 `tabular-nums`，正文行宽约 65 字符。

## 层级与形状

能看出层级就够，用最低的高度，不叠加。圆角和阴影由 token 定义：控件和小面板用小圆角，卡片、菜单、弹窗用大圆角，页面代码不写字面值。

卡片按内容决定是否使用。Frame 用于设置分组、Project 概览和工具结果这类成组内容，面板内不再嵌套卡片。

## 动效

使用频率决定动效。每天用上百次的操作不加动画：命令面板、键盘触发的操作和右键菜单直接出现，连续悬停的第二个 Tooltip 不再延迟。

需要动效时，进出场用 ease-out，屏幕内移动用 ease-in-out，从 0.9 以上的缩放开始，弹层从触发点展开。微交互 100–150 ms，Tooltip 和菜单 150–250 ms，弹窗 200–300 ms，退场比进场快约 20%。按钮按下时缩放到 0.97。系统开启减少动态效果时关闭位移和缩放。

## 组件

组件从 coss ui（MIT）转写为 Base UI + StyleX，保留其结构和交互；已有组件保留 Baton 的 prop 名称，页面调用不变。Tailwind 中无法直接表达的后代和 `has-` 选择器，改写成 prop、`stylex.when` 或少量全局 CSS。图标沿用 `web/src/ui/Icon`。

`web/src/ui` 的现有组件已转写，并增加了 Frame、Select、Tooltip、Command，其余组件在页面需要时转写。

菜单默认按内容定宽，最小 96px、最大 304px，超长文字截断。带搜索框的模型菜单最小 240px，过滤时宽度基本不跳动，长名称可撑到 304px。带两行说明的菜单固定 304px，文件夹和执行权限菜单属于这一类。侧栏账号菜单和账号按钮同宽，侧栏收起时最小 160px。Select 的触发器撑满容器，弹层最小和触发器同宽。

状态只有一份定义：`data/derive.ts` 的 `threadView` 给出状态符号 `mark`，颜色由 `threadStatusTones` 决定，页面不各自指定。

| 状态 | 颜色 | 16px 图标 | 6px 小点 |
|---|---|---|---|
| 运行中 | Agent 色 | 像素追逐动画 | 实心 |
| 需要处理 | 警示色 | 实心圆加感叹号 | 实心 |
| 已停止 | 灰色 | 实心圆加横线 | 实心 |
| 等待设备、启动和恢复中、正在停止、设备离线前最后在运行 | 灰色 | 虚线圈 | 空心 |
| 空闲 | 淡灰色 | 细空心圈 | 空心 |
| 已归档 | 灰色 | 归档图标 | 空心 |

列表行首用 `ui/ThreadStatusIcon.tsx` 的 16px 图标，每行都有符号；紧挨文字的位置用 `StatusDot`，旁边必须写状态文字。已停止用灰色，确实需要用户处理的失败由时间线提示用红色说明。系统开启减少动态效果时，像素环保持静止。

未读和状态分开：蓝点放在行尾固定列，紧贴时间左侧，侧栏项目同样放在行尾；标题同时用 500 字重。分组列表共用纵向对齐线：状态图标和分组箭头同一中线，标题和分组名同一左边。分组标题已写明状态，所以每行不再写状态文字，只保留悬停提示和读屏文字。

Composer 分两层。`ui/composer-editor/` 是完整转写的结构化编辑器，包括草稿、提及和斜杠命令；`ui/Composer.tsx` 在它之上提供页面用的输入区，页面只管文字，Enter 发送，Shift+Enter 换行。提及和斜杠命令目前只在画廊中演示，页面没有接入：Baton 没有斜杠命令的数据来源，也还没有可提及文件的数据来源。

Chat UI 只取跳到最新（`ui/JumpToLatest.tsx`），Thread 和 Project 的滚动跟随都用 `ui/useChatScroll.ts`。气泡、表情回应和已读面向人与人的聊天，Agent 的工具步骤和长输出继续使用 Baton 自己的组件，因此不引入 `motion`。

## 组件画廊

画廊展示全部组件的各个状态，并提供调节 base、accent、contrast、圆角和字体的面板。真实页面验收用这些压力场景：含代码和 diff 的长 Thread、侧栏、Project 概览、设置表单、菜单和对话框，每个场景都核对浅色、深色和高对比主题，以及中文和英文内容。这些场景已在 macOS 上验收，Windows 上还没有验收。
