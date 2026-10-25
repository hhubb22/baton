# Baton Elyx 设计项目

此目录管理 Baton Web UI 的界面设计。`.elyx` 保存设计，`elyx.json` 保存项目配置。产品行为以仓库 `specs/` 为准，界面文案遵循 `design/WRITING.md`，入口和返回路径见 `design/FLOWS.md`；设计稿独立于 `web/` 里的代码，代码按设计稿实现。

## 项目结构

- `index.elyx`：设计系统总览。
- `tokens/`：浅色语义颜色（默认）、`theme=dark` 覆盖、Project 头像底色、间距、圆角和骨架尺寸。
- `foundations/`：文字样式。
- `controls/`：基础控件和图标。图标都是 `icons.glyph` 的变体，实例里用 `@with-variant(icons.<名称>)` 换图标。
- `blocks/`：组合区块。`project-page.elyx` 是完整的 Project 页，`thread-list.elyx` 是完整的 Thread 页，screens 里的页面状态都是它们的实例。`thread-detail.elyx` 收着 Thread 详情的全部状态；`new-thread.elyx` 是位置菜单和模型菜单，`enroll-dialog.elyx`、`file-preview.elyx` 是接入设备和文件预览。
- `screens/`：完整页面，一类页面一个文件，同一页面的不同状态放在同一文件的多个画板里。
- `resources/assets/`：`backdrop-day.jpg`、`backdrop-night.jpg` 是 1920×1200 的湖景背景图（原创生成），`-frost` 版本是预先模糊的磨砂底。操作图标采用 24 视框、1.7px 描边、黑色单色；Baton 品牌 SVG 保留提供的 64 视框、比例和颜色，通过 `controls/brand.elyx` 复用。

## 设计规则

- 界面中的青色（`agent`、`agentText`、`agentSoft`）用于 Project Agent：它的标识、运行中状态和它给出的建议。Baton 彩色品牌标识保留 SVG 自带的青色，不作为状态提示。用户主操作用蓝色 `accent`，即发送和主按钮；卡片里的次要动作用 `accentSoft` 底配 `accentText` 文字。执行中的状态点用 `accent`，计时器和状态文字用 `accentText`，链接也用 `accentText`，界面里不再有别的蓝色。侧栏用 Baton 单色标识，颜色跟随 `text`；登录页用随主题切换的彩色标识。项目头像继续使用项目名称首字母，不与 Baton 品牌标识混用。
- 一屏最多一个实心主按钮，其余用 secondary 或 ghost。
- 浮层最多两层。需要第三层时改用弹窗，并替换当前弹窗。
- 弱化文字用 `muted` 或 `faint`，不用透明度。`faint` 只给占位符和元信息。
- 主对话是一列：用户消息、Project Agent 的回复、卡片、状态片和输入区共用最宽 720px 的同一列，左右边缘对齐。用户消息是右对齐的浅灰气泡，Project Agent 的回复是靠左的正文，没有头像和名字。
- Thread 详情和主对话用同一套聊天样式：发给 Agent 的消息是右对齐气泡，Project Agent 发的在气泡左下角带它的青色标识，你发的不带；Agent 的回复是靠左的正文，开头一行可展开的过程记录，收着这一轮的工具调用、命令和文件改动，点开时从设备读取，设备离线时写明暂不可查看；执行中的一轮把这一行换成往上走的计时器，下方展开实时输出，这一轮结束后收起；附件列在正文后，挂在分支线上；关联的事项以卡片出现在时间线里。标题栏只放名称和状态；设备和目录是 Thread 输入区下方一行浅色小字，Agent 写在输入区的提示文字里。
- 文案、画板 `title` 和 `caption` 全部用英文，写短句，不写说明书。能靠交互表达的（点开、展开、悬停），不写成文字。时间、设备、发送方这类背景信息交给惯例：时间和用时悬停显示，执行环境放在输入区附近，发送方用标识区分。文字留给需要说明原因或下一步的状态，例如 `offline, unavailable`、`Sending next · Cancel`。
- 输入区白底、发丝线外框、两层浅阴影、20px 圆角，提示文字在上，工具栏在下：左边是全圆角选择片（位置、模型）和分段切换，右边是 32px 圆形发送按钮。主对话输入区只给 Project Agent 发消息，没有选择片。Agent 不单独做选择片，写在提示文字里，例如 `Message Codex on Windows Desktop…`；Thread 输入区的模型选择片只列这个 Agent 的模型。Thread 详情替换概览栏时，输入区上方显示状态片，汇总执行中、等待设备和等你决定的数量。
- Project Agent 一轮里的内容按顺序排：先是一行可展开的过程记录，收着这一轮执行的命令和记忆修改，每条一行，点开在原位展开；然后是 Thread 卡片，这一轮开过或发过消息的 Thread 每个占一行；最后是正文。Thread 行写状态点、名称、目录的最后一段，右侧是设备 · Agent 和状态；执行中只显示这一轮往上走的计时器，其余状态只显示状态名。点 Thread 行在右侧打开详情。
- Thread 页顶部是新建 Thread 的输入区，选位置和模型，发出第一条消息即新建；位置写成 `目录 · 设备`，预填默认设备上次用的目录，模型预填这个位置上次用的 Agent 和模型。网页上新建的 Thread 不属于 Project，不选 Project；每轮执行时限默认 2 小时，新建时和已有 Thread 中均可修改。时限按每轮总时长表达，从该轮开始计算；运行中延长不会重置计时。侧栏的新建按钮跳到 Thread 页并聚焦这个输入区。输入区下面是占满宽度的分组列表，按设备、Project 和是否归档筛选。列表的状态列只在执行中显示计时器，等你处理的行写明原因（`Stopped`、`Status unknown`），等待设备和空闲的行留空，分组标题已经说明。点一行在右侧打开详情，列表收起 Project 和目录两列；这里的详情没有返回按钮。概览栏的 Thread 行第一行是状态点和名称，第二行是设备和目录，不写 Agent；最后活动时间只在悬停时显示（`threadRowHover`）。主对话里的系统提示不带时间。
- 等待和异常状态（等待设备、状态未知、执行中设备离线、已停止、无法恢复、已归档）用输入区上方的横幅表达。Thread 不能再继续时（已归档、无法恢复、启动失败）不显示输入区；已归档的横幅没有动作；历史被删时提供 `New chat in this folder`，目录不存在时提供 `Choose folder`，新建时保留原设备和可用的模型。恢复动作打开对应的新建入口，不向旧对话重发消息。
- 注册凭据只在弹窗里显示和复制，注册命令从环境变量或标准输入读入凭据，不把凭据写进命令行参数。
- 文件预览从设备实时读取，设备离线或路径不在登记目录内时只显示原因和动作，不显示旧内容。
- 少画框。一屏只有一个需要你处理的东西做成实体面：输入区上方的问题横幅用反色浮条（`inverse` 底、`onInverse` 和 `onInverseMuted` 文字、16px 圆角、两层阴影，深色主题下改用比 `surface` 亮一档的灰，不反成白色），其余等待状态的横幅用 `panel`。对话里的 Thread 组和等你决定的事项不加卡片外壳：一行 `muted` 的标题，下面的行挂在左侧一条 `borderSoft` 竖线上（分支线），附件列表同样处理。目录名写成 `faint` 的等宽文字，不加底色片。对话时间线和 Thread 详情里不用卡片，等你决定的事项、Thread 组和附件都挂在分支线上，不套标签片或带底色的说明块。页面级列表（Inbox、设备、设置）和概览栏用整页的行，靠 `borderSoft` 分隔线和间距分组，不画外框：组内间距 4 到 8px，组间 16 到 24px。
- 事项先读问题，再选答案。第一行是浅色元信息（Inbox 里是项目，对话里是关联的 Thread）和右侧的关闭图标；问题用 `heading`；下面一段 `muted` 的背景说明；选项挂在分支线上，没有外框，序号写在 20px 的 `subtle` 键帽里，悬停时整行加 `hover` 底；推荐项用 Medium 字重，右侧写青色 `Suggested`；最后一行 `Other…` 打开文字回复。Inbox 里同时只展开一条事项，其余收成项目加问题两行（`inboxRow`、`inboxSystemRow`），点开时原位展开并收起上一条。处理过的事项收成问题加一行结果（✓ 选择 · 谁 · 时间），不再显示说明和选项。
- 状态点只有六种颜色：蓝执行中，灰等待设备、空闲、已归档或离线，绿设备在线，红已停止，橙状态未知或等你处理，青 Project Agent 运行中。Baton 不判断一轮成功还是失败，没有表示成功或失败的颜色。具体含义由旁边的文字说明。
- 每个等待或异常状态都配一句标题和一句说明，能处理时才配一个动作。同一屏里这句完整的话只出现在一个地方，通常是输入区上方的横幅；标题栏、概览栏和侧栏只放状态点和两三个词的状态，例如 `Sign-in expired`、`Needs sign-in`。
- 不可用的操作保持可点，点击后说明原因，不用禁用态表达。
- 工作区分三层。最底层是磨砂背景：模糊过的背景图叠 `glass` 色，侧栏直接放在上面，没有底色和边框。中间是内容卡片：主内容区和 Thread 详情用实色 `canvas`（详情用 `surface`），`hairline` 外框、12px 圆角、`shadowNear` 与 `shadowFar` 两层阴影，和页面边缘、侧栏之间留 8px（`gutter`）。概览栏用半透明的 `glassLift` 配 `glassEdge` 外框。最上层是卡片、输入区和弹窗，用 `surface`。`panel` 只给提示条和内嵌区域，`subtle` 给悬停与标签底色。侧栏和按钮的选中态用 `raised` 配 1px `shadowNear` 阴影。边框用 `borderSoft`、`border`、`borderStrong`，卡片和输入区外框用更浅的 `hairline`。
- 背景图只出现在磨砂背景层和登录页。正文、Thread 卡片、输入区和弹窗都是实色，图像不透到文字下面。登录页显示清晰的背景图，表单放在居中的磨砂面板上。深色主题由 `glass` 等颜色 token 切换，工作区共用同一张模糊图；登录页的深色画板改用夜景图。设计稿用预先模糊的图片模拟磨砂，网页实现用原图加 `backdrop-filter`。动画只用于登录页和空状态的背景，周期不短于 20 秒，系统开启减少动态效果时停用。
- 主按钮在 `accent` 底上叠一层由上往下渐隐的 `sheen`，顶边 1px `highlight` 内阴影，下方 `accentShadow` 投影；secondary 和 danger 只有 1px `shadowNear` 投影，ghost 没有阴影。
- 颜色在 OKLCH 里取值，中性色统一用色相 262、低彩度的冷灰，表面、边框、阴影和遮罩都从它派生，和背景图同一色温。用来阅读的文字（`text`、`muted`、`faint`、各 `*Text`、`danger`、`success`）在 `canvas`、`surface`、`subtle` 上都达到 4.5:1。阴影只用 `shadowSoft`（控件和行）、`shadowNear` 与 `shadowFar`（卡片、输入区、弹窗的两层），遮罩用 `overlay`。组件和画板里不写原始 `rgb()`，新颜色先加进 `tokens/colors.elyx` 和 `colors@dark.elyx`。
- 实例不改组件内部图层的颜色。按钮、状态标签、横幅、输入框这类组件的每种用法都做成变体，实例用 `@with-variant` 选择，例如弹窗的确认按钮在 `buttons.button` 和 `buttons.danger` 之间选，状态文字用 `status.label*`，危险的小按钮用 `buttons.smallDanger` 或 `smallGhostDanger`。文字颜色随用途变化时换文字样式：输入框占位符 `t.smallPlaceholder`，有值后换成 `t.small`；错误说明 `t.captionDanger`，需要处理的提醒 `t.captionAttention`。声明文字或图标图层时用颜色 token 定颜色是正常写法。行的选中、展开这类和状态无关的底色可以在实例根上设 `selected` 或 `panel`，因为一个变体只能表达一个维度。需要新的颜色组合时新增变体。
- Agent 的官方标识（Codex、Kiro、Pi、Cursor 等）只出现在选择 Agent 或模型的菜单、设备详情的 Agent 列表这类正在选择或配置的地方。列表行、卡片、标题栏和概览栏不放官方标识，用文字名称，并且同一屏能推断出来时省略。
- 界面字体 Inter（`resources/fonts/`，SIL OFL），中文回落到 PingFang SC；字重只用 Regular、Medium、SemiBold；代码用 Paper Mono。字距按 Inter 的字号规则收紧（20px -1.7%，15px -0.9%，14px -0.6%，13px -0.3%），`caption` 用等宽数字。常用字号 20、15、14、13、12。控件高度 20、28、32，圆角 4、6、8、12；卡片 14，气泡 18，输入区 20，分段切换、选择片和状态片用全圆角。
- 界面文案遵循 `design/WRITING.md`：向用户隐藏 `Coordinator`、`Runtime`、`Worker`、`Turn`、`Steer` 等内部工程概念，使用日常任务语言、Sentence case 和自然句式表达。

## 编写注意

- Elyx 保留字不能作声明名，例如 `where`、`use`、`type`、`data`、`in`、`ref`，完整列表见 `elyx man syntax`。
- `@with-variant` 只能写在实例内部的子块上；要直接用某个变体，写成 `name = frame : file.variant {}`。
- `insert`、`remove` 的参数按词法查找，要写完整路径，例如 `remove(page.projectPage.main.transcript.typing)`。
- 组件声明不写 `left` 时以 x=0 居中，画板和组件示例都写明 `left`、`top`。
- 插进 slot（例如弹窗的 `content`）的子图层，在变体和实例里要写在 `content { }` 下覆盖。
- 代码文字里用空格缩进，不用制表符。
- 用 `subrange` 把正文里的路径或命令设成 Paper Mono，不拆成多个文字图层。实例覆盖里的 `subrange` 会被 normalize 删掉，需要时在实例里新建文字图层。

## 验证

使用 Elyx skill 和 CLI 检查解析后的组件、实例和布局。修改 `.elyx` 后，运行 `elyx normalize -w <文件>` 和 `elyx diagnostics design`，并渲染受影响的页面。命令均从仓库根目录运行。渲染截图写入被 Git 忽略的 `design/renders/`，验证日志保留在仓库外。
