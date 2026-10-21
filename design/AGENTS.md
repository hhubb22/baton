# Baton Elyx 设计项目

此目录管理 Baton Web UI 的界面设计。`.elyx` 保存设计，`elyx.json` 保存项目配置。产品行为以仓库 `specs/` 为准；设计稿独立于 `web/` 里的代码，代码按设计稿实现。

## 项目结构

- `index.elyx`：设计系统总览。
- `tokens/`：浅色语义颜色（默认）、`theme=dark` 覆盖、Project 头像底色、间距、圆角和骨架尺寸。
- `foundations/`：文字样式。
- `controls/`：基础控件和图标。图标都是 `icons.glyph` 的变体，实例里用 `@with-variant(icons.<名称>)` 换图标。
- `blocks/`：组合区块。`project-page.elyx` 是完整的 Project 页，screens 里的 Project 状态都是它的实例。
- `screens/`：完整页面，一类页面一个文件，同一页面的不同状态放在同一文件的多个画板里。
- `resources/assets/`：SVG 图标，24 视框、1.7px 描边、黑色单色。

## 设计规则

- 青色（`agent`、`agentText`、`agentSoft`）只用于 Project Agent：它的标识、运行中状态和它给出的建议。用户主操作用近黑色 `accent`，链接和焦点用蓝色。
- 一屏最多一个实心主按钮，其余用 secondary 或 ghost。
- 浮层最多两层。需要第三层时改用弹窗，并替换当前弹窗。
- 弱化文字用 `muted` 或 `faint`，不用透明度。`faint` 只给占位符和元信息。
- 主对话里的引用只说发生了什么，例如「给 Windows 台式机派发了一个任务」「执行了 1 条命令」。设备、目录、用时这些细节放进详情，靠点开查看，不在外部重复。执行中只显示一个往上走的计时器，结束后只显示状态。
- 文案写短句，不写说明书。能靠交互表达的（点开、展开、悬停），不写成文字。
- 输入区比对话列窄，居中悬浮，不跟主区域等宽。
- 卡片只用于等用户决定的事项。派发的任务、执行的命令和记忆修改在主对话里各占一行，任务点开在右侧显示详情，命令和记忆点开在原位展开。列表、选项和引用都用发丝线分隔的行，不加边框。
- 状态点只有六种颜色：蓝执行中、灰等待设备或已取消、绿已完成、红失败、橙待核实或等你处理、青 Project Agent 运行中。具体含义由旁边的文字说明。
- 每个等待或异常状态都配一句标题、一句说明和一个动作。
- 不可用的操作保持可点，点击后说明原因，不用禁用态表达。
- 表面分四级：`canvas` 主内容区、`panel` 侧栏与概览栏、`surface` 卡片输入区弹窗、`subtle` 悬停与标签底色。边框用 `borderSoft`、`border`、`borderStrong`（8%、11%、16%）。
- 界面字体 PingFang SC，字重只用 Regular、Medium、Semibold；代码用 Paper Mono，含中文的等宽内容用 Maple Mono CN（族名 `Maple Mono Normal NF CN`）。常用字号 20、15、14、13、12。控件高度 20、28、32，圆角 4、6、8、12。
- 文案按 specs 的说法写，例如「Project Agent」「派发」「待核实」「等待设备」「事项」。

## 编写注意

- Elyx 保留字不能作声明名，例如 `where`、`use`、`type`、`data`、`in`、`ref`，完整列表见 `elyx man syntax`。
- `@with-variant` 只能写在实例内部的子块上；要直接用某个变体，写成 `name = frame : file.variant {}`。
- `insert`、`remove` 的参数按词法查找，要写完整路径，例如 `remove(page.projectPage.main.transcript.typing)`。
- 用 `subrange` 把正文里的路径或命令设成 Paper Mono，不拆成多个文字图层。实例覆盖里的 `subrange` 会被 normalize 删掉，需要时在实例里新建文字图层。

## 验证

使用 Elyx skill 和 CLI 检查解析后的组件、实例和布局。修改 `.elyx` 后，运行 `elyx normalize -w <文件>` 和 `elyx diagnostics design`，并渲染受影响的页面。命令均从仓库根目录运行。渲染截图写入被 Git 忽略的 `design/renders/`，验证日志保留在仓库外。
