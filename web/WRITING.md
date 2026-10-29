# Baton UX Writing 规范

本规范定义 Baton 界面文案的交互原则、场景写法与语言格式约定，适用于界面设计与 Web 前端（`web/`）。

Baton 的底层跨越了中心服务、节点守护进程、项目代理和多个执行进程，但呈现在界面上的心智模型只保留三件事：

1. 你有几台自己的电脑（Devices）。
2. 你可以在任意电脑的文件夹里，直接和某个编程助手（Codex、Kiro、Pi）对话（Threads）。
3. 你可以建一个长期项目（Project），在里面交代目标，让项目助手替你在各台电脑上开对话、跑命令，遇到拿不准的事在主对话里问你。

用户不需要知道系统的进程架构、消息队列和调度规则，就能看懂每一个界面并完成操作。

---

## 一、概念收敛：把工程概念挡在界面之外

凡是只有读过架构文档才能理解的内部词，一律不进入界面文案。只在实际发生影响时，用日常语言直接描述具体事实。

| 内部规格概念（不进界面） | 用户需要知道的事实 | 界面英文表达 | 界面中文表达 |
|---|---|---|---|
| `Coordinator`（中心服务） | 对话和记录保存在账号里，换电脑也能接着看 | `Saved to your account`（或直接省去保存位置） | 已保存（或“跨电脑自动同步”） |
| `Project Agent Runtime` / `active runtime instance` | 项目助手当前在哪台电脑上干活，或者闲着 | `Running on Ubuntu Dev` / `Idle` | 正在 Ubuntu Dev 上运行 / 空闲 |
| `Worker`（会话执行器） | 电脑上的助手进程重启或断开了 | `Codex on Windows Desktop restarted` | Windows Desktop 上的 Codex 已重启 |
| `Input` / `Queued inputs`（输入队列） | 你发的消息或助手交回的回复正在等待处理 | `Reading Codex's reply…` / `3 messages waiting` | 正在读取 Codex 的回复…… / 3 条消息待处理 |
| `Turn`（一轮执行） | 当前这一条回复或这一次运行 | `Current reply` / `Current run` | 当前回复 / 本次运行 |
| `Steer` vs `Queue`（插入与排队） | 助手正忙时，新消息是等它忙完再发，还是现在立刻发进去 | `Send next` vs `Send now` | 下一条发送 vs 立即插话 |
| `Eligible device`（满足条件的设备） | 在线且已登录所需模型账号的电脑 | `An online device with ChatGPT signed in` | 已登录 ChatGPT 的在线设备 |
| `Thread` 与 Project 主对话 | Agent 在某台设备某个目录里的对话，和项目助手的对话是两回事 | 前者一律叫 `thread`（`New thread`、`Archive thread`、`No threads yet`），后者叫 `main chat`；`chat` 只作动词或用在 `main chat` 里 | Thread / 主对话 |
| `Node` / 电脑 | 用户连进 Baton 的机器 | 状态、按钮、报错和设置写 `device` 或设备名；只在讲接入一台实体电脑时写 `computer`（`Connect the computers where your code lives`） | 设备 / 电脑 |
| `attention: failing`（故障） | 项目助手连续出错停下了，需要你处理 | 直接写具体故障（如 `ChatGPT sign-in expired`） | 直接写具体故障（如 `ChatGPT 登录已过期`） |
| `Enroll device` / `Enrollment token` | 把一台电脑连进 Baton / 连接用的临时口令 | `Connect a device` / `Setup code` | 连接新设备 / 接入口令 |
| `Revoke device`（吊销凭据） | 断开并移除这台电脑 | `Disconnect device` | 断开并移除设备 |
| `Registered directories`（登记目录） | 这台电脑上允许 Baton 访问的文件夹 | `Folders`（`Folders on Ubuntu Dev`） | 文件夹 |

---

## 二、第一层：交互内容原则（Interaction Content Principles）

### 1. 先检查交互，再写文字

当界面需要一行说明文字来解释控件怎么用时，先改控件本身。

能靠交互和视觉惯例看懂的，不写说明文字。展开过程记录、悬停看具体时间、用青色圆点代表项目助手、用右对齐气泡代表自己发出的话，直接靠界面呈现。

首次打开界面时，用可直接点击的引导或预填默认项代替系统架构说明。新建的空项目直接给出输入框提示 `Describe what you want to build or verify…`（说说你要做什么或验证什么……），不写段落解释数据如何跨设备同步。

不可用的操作保持可点击，在用户点击或打开菜单时就地说明原因，不用沉默的灰色禁用态让用户猜。

### 2. 少说：每个字都要换来一个用户还不知道的事实（Brevity）

写完一屏后从上往下读一遍，删掉用户已经从别处知道的字。

1. 一个事实一屏只说一次。完整的话只放在一处，通常是输入区上方的横幅；标题栏、侧栏、概览栏、Thread 行和消息下方只用状态点、图标和一到三个词的状态名。横幅已经说明设备离线时，对话里不再插 `went offline` 系统提示，分组标题不再写 `Device offline`，概览栏不再重复原因。
2. 只显示异常。在线、已登录、已安装、支持的能力、成功保存这类正常状态不写，只写缺了什么、哪里不对（`Pi not signed in`、`Can't stop`）。能力列表、版本号和发现的仓库放进详情或悬停。
3. 上下文在容器上写一次。设备、Agent 和目录写在标题栏或输入区下方那一行，行内、提示文字和状态里不再重复；一组 Thread 共用同一台设备或同一个 Agent 时，组里的行省略它。
4. 横幅以标题为主。标题一句话写清哪个对象出了什么事；说明只在补充标题没交代、又影响下一步的事实时才写，例如什么会保留、什么会丢，最多一句；动作按钮自己说明怎么恢复，正文不再复述。
5. 说明文字（Helper text）只给不可逆或有安全后果的操作：归档、断开、停止、开放命令权限、重置口令。其余字段、开关和按钮靠标签自己说清，不在下面加一段解释何时生效。
6. 页面和空状态不写介绍段。页面标题用事实（`3 devices, 2 online`），空状态写一句短语（`No threads yet`）加一个起步动作，不写这个页面是做什么的。
7. 字数上限：状态名三个词以内；横幅标题十个词以内，说明一句、十五个词以内；按钮两三个词。超出时先删重复，再删正常状态，最后才压缩措辞。

### 3. 以用户的任务为中心（Task-oriented）

文案围绕用户手头要完成的事（写代码、跑测试、看日志、换电脑继续）来写，不向用户汇报软件内部是怎么运转的。

| 场景 | 推荐写法（用户任务视角） | 避免写法（内部架构视角） |
|---|---|---|
| 新建项目后的空状态 | 只显示项目目标和输入框提示 `Describe what you want to build or verify…`，不加介绍段 | `Conversation, memory, and Thread records are stored on the Coordinator. If the Project Agent runs on your Mac now, it can pick right up on Windows next time.` |
| 设备页顶部 | 标题 `3 devices, 2 online` 加 `Connect a device` 按钮；默认设备在行内标 `Default`，不写说明段 | `Project Agent runs on any eligible device: online, synced, with the Runtime installed and the required subscription available. Your default device is preferred when eligible.` |
| 项目助手正在工作 | `Reading Codex's reply`，后面跟秒数<br>正在读取 Codex 的回复 | `Processing 1 input: Codex reply from Ubuntu Dev` |

### 4. 让操作结果可以预测（Predictability）

按钮、菜单和切换项写清楚点击后会发生什么动作，让不看说明书的人也能猜准结果。不用 `OK`、`Confirm`、`Yes`，也不用内部协议代号。

| 场景 | 推荐写法 | 避免写法 |
|---|---|---|
| 助手运行中发消息的方式切换 | `Send next` / `Send now`<br>不支持打断时无需显示切换器，只在输入框旁提示 `Sends after current reply`（当前回复结束后发出） | `Queue` / `Steer`<br>`Queue only · steering unsupported` |
| 接入新电脑的入口与口令重发 | `Connect a device` / `Get a new code`（连接设备 / 获取新口令） | `Enroll device` / `Regenerate` |
| 报错横幅里跳转到项目 | `Go to project` 或直接提供 `Retry`（前往项目 / 重试） | `Open Project to retry` |
| 撤回还在排队的已发消息 | `Sending next · Cancel`（等待发送 · 取消） | `Queued · Withdraw` |

### 5. 优先提供决策所需的信息（Information Relevance）

常规操作不写说明；只有停止进程、断开电脑、开放命令权限或归档项目这类操作，才把影响判断的事实写出来：什么会停、什么会保留、什么不会自动回滚。只写会让用户改变决定的事实，一到两句。

| 场景 | 推荐写法 | 避免写法 |
|---|---|---|
| 归档项目确认弹窗 | `Stops the project assistant and its running threads. Chat, memory, and thread history are kept.`<br>停止项目助手和运行中的 Thread。对话、记忆和 Thread 记录都保留。 | `The Project Agent will stop its current run and will not start again. Conversation history, memory, and Threads are preserved.` |
| 断开并移除电脑 | `Agents already running on it keep running locally.`<br>上面正在运行的助手会在本地继续执行。 | `Disconnects immediately; running Agents on an offline device will not be stopped.` |
| 开启命令行执行权限 | 开关标签 `Allow project assistant to run commands`，下方一行 `Shell commands the project assistant runs itself. Threads set their own access.`；打开时弹窗确认，正文一句 `Commands run directly as kaken and can reach files outside your folders.`<br>只管项目助手自己的命令，Thread 的权限在新建时设置。打开前说清实际影响：以 kaken 身份直接运行，能访问文件夹之外的文件。 | `Project Agent can run arbitrary commands inside registered directories as kaken via zsh. Baton does not sandbox or inspect these commands.` |

### 6. 在恰当的时机和位置提供信息（Contextual Communication）

把信息放在用户正盯着的控件旁边，只在状态真的影响当前操作时才提醒。

1. 输入框占位符只写发送对象的 Agent（`Message Codex…`），设备和目录写在输入区下方那一行，不在占位符里重复，也不放使用规则。
2. 目标电脑离线或助手正忙时，原因写在输入区上方的横幅里一次；工具栏和消息下方只留短状态（`Sends when online`、`Sending next · Cancel`）。电脑在线且空闲时，工具栏保持干净，不写状态字样。
3. 字段格式或权限说明只在第 2 条第 5 款允许的场景写在输入框下方，不在用户填写中途弹警告。
4. 跨页面的阻塞问题（如某台电脑上的登录过期导致项目停摆）在对应项目输入区上方写完整原因并提供重试。

### 7. 准确表达系统状态（Accurate Feedback）

如实区分“已保存”“等待发送”“正在运行”“正在停止”和“失去联系”，不把“消息发到了服务器”说成“助手已经收到”，也不替用户判断代码改对了没有。准确靠选对词，不靠多写字。

1. 电脑离线时发出消息：气泡下方写 `Sends when online`（上线后发送），设备名和原因留在横幅里。
2. 点击停止按钮后：在电脑确认进程退出前，显示 `Stopping…`，强制退出的倒计时悬停显示；确认退出后才变为 `Stopped`。
3. 电脑中途重启导致不确定消息有没有送达：直说事实，不自动重发避免重复执行命令。气泡下方只放一个警示图标，完整的话放在横幅标题里。
   - 推荐写法：标题 `Codex may have missed your last message`，动作 `View activity`。（Codex 可能没收到你的上一条消息。）
   - 避免写法：`Message delivery unconfirmed — The Worker on the device restarted before delivery could be confirmed. Baton will not resend automatically.`
4. 助手回复完毕后状态统一为 `Idle`（空闲），命令执行只标退出码（如 `exit 0`），不显示“任务成功”或“执行失败”的绿勾红叉。测试通没通过由回复正文陈述。

### 8. 帮助用户预防和恢复错误（Error Prevention & Recovery）

先用默认值和输入容错减少报错：新建对话自动带出上次用过的电脑、文件夹和模型；口令和路径输入框自动去除首尾多余空格。

报错时，区分用户输入问题与环境问题：

1. 表单校验错误：紧贴出错字段下方，复用字段名直接说怎么改（如 `Enter a project name.`），绝不清空用户已经填好的内容。
2. 环境与运行故障：标题写清楚哪个对象出了什么问题，动作按钮写怎么恢复；只有已发的消息或改动会保留或丢失时，才加一句说明。不抛原始错误码，也不用内部组件名。

| 场景 | 推荐写法 | 避免写法 |
|---|---|---|
| 模型订阅登录过期 | 标题：`ChatGPT sign-in expired on Ubuntu Dev`<br>说明：`Messages wait until you sign in.`<br>按钮：`Retry` | 标题：`Project Agent paused: 5 consecutive model request failures`<br>说明：`ChatGPT subscription on Ubuntu Dev needs a new sign-in. Incoming messages stay saved and resume from where it stopped.` |
| 工作目录不存在 | 标题：`~/src/baton-old no longer exists`<br>按钮：`Choose folder` | 标题：`Could not start Codex`<br>说明：`Directory ~/src/baton-old does not exist.`<br>按钮：`View devices` |
| 历史文件被删无法恢复会话 | 标题：`Thread history was deleted on MacBook Pro`<br>按钮：`New thread in this folder` | 标题：`Cannot resume original session`<br>说明：`Session history on the device was deleted.` |
| 访问授权目录外的软链接 | 标题：`Link points outside the device's folders`<br>说明：等宽路径 `C:\Users\dev\certs`<br>按钮：`Go back` | 标题：`Outside registered directories`<br>说明：`This symlink points to C:\Users\dev\certs. Only registered directories on the device can be browsed.` |

### 9. 尊重用户的注意力与自主权（Respect for User Agency）

按事情的轻重缓急决定提示强度，把控制权交给用户：

- 高频日常动作（发消息、改项目名、切换模型、回答问题）直接在原位更新状态，不弹 Toast 或通知横幅。
- 默认电脑离线而项目助手自动换到另一台在线电脑运行时，不弹窗打断，只在对话流里留一行浅色小字：`Switched to Ubuntu Dev · MacBook Pro offline`（MacBook Pro 离线，已换到 Ubuntu Dev）。
- 用户明确指定在某台电脑上开的独立对话（Thread），如果那台电脑离线，就留在原电脑等待上线（`Waiting for MacBook Pro to come online`），绝不擅自改派到别的电脑。

---

## 三、界面场景写法速查（Scenario Patterns）

| 界面场景 | 核心要求 | 正面示例 |
|---|---|---|
| 侧栏与导航 | 用简短复数名词，不加 `My` / `Your` | `Threads`、`Devices`、`Projects` |
| 输入框占位符 | 只写对话对象，电脑写在输入区下方 | 主对话：`Ask the project assistant…`<br>独立对话：`Message Codex…` |
| 过程记录折叠行 | 用过去式动词短语汇总实际做过的事，不写“思考完成” | `Ran 1 command, saved 1 note`<br>`Ran 1 command, edited 1 file` |
| 暂停横幅 | 标题说谁停了，说明只写会保留什么，按钮负责恢复 | 标题：`Project paused`<br>说明：`New messages wait until you resume.`<br>按钮：`Resume` |
| 超时停止横幅 | 标题说为什么停，说明只写本地改动还在；接着聊靠输入框本身 | 标题：`Stopped at the 2-hour limit`<br>说明：`Changed files were kept.` |
| 项目故障 | 在输入区上方写完整原因，并提供重试按钮 | `ChatGPT 登录已过期` / `重试` |
| 空状态 | 一个短语说这里还没有什么，加一个起步动作；不解释页面用途 | `No threads yet` |
| 连接新电脑弹窗 | 按步骤写清：选系统、运行命令、粘贴口令 | 标题：`Connect a device`<br>口令标签：`Setup code`，有效期写在旁边 `10 min`<br>命令标签：`Run in terminal`<br>底部状态：`Waiting for device…` |

---

## 四、第二层：语言与风格规范（Language & Style Conventions）

### 1. 语气与人称

1. 语气平实、直接，像一位熟知上下文的同事在汇报进展。不用 `Please`（请）、`Sorry`（抱歉）、`Oops`，不用感叹号（`!`），也不在常规动作后加 `Successfully`（成功）。
2. 直接对用户说 `you` / `你`（不用 `您`）。
3. 严禁使用 `we` / `us` / `our`（我们）。出现问题或说明规则时，永远指明具体主语：是哪台电脑（`Windows Desktop`）、哪个助手（`Codex`）、还是 `Baton`。

### 2. 英文大小写与语法约定

1. 全部界面元素（页面标题、弹窗标题、横幅标题、按钮、菜单项、标签、状态词）统一使用 **Sentence case**，只大写句首第一个词和专有名词。
2. 只有在指代具体产品或品牌名时才大写首字母：`Baton`、`Codex`、`Kiro`、`Pi`、`ChatGPT`、`Claude`、`Windows`、`macOS`、`Ubuntu`。
3. 取消句中人为造出的大写概念词：句中写 `project`、`thread`、`memory` 时一律用普通小写名词，不写成 `switching models mid-Thread` 或 `Open Project to retry`。
4. 按钮、标签和状态片省略冠词（`a`、`an`、`the`）；横幅正文、空状态和表单说明保留完整冠词和自然语序，不写成电报体。
5. 涉及安全边界、数据去向或不可逆后果的句子，使用完整否定形式（`does not`、`will not`、`cannot`），不用缩略式。

### 3. 中文书写约定

1. 中文与英文单词、数字之间留一个半角空格（`在 Ubuntu Dev 上运行 2 个测试`），中文标点与英文或数字之间不留空格。
2. 助手名称（`Codex`、`Kiro`、`Pi`）、系统名称和命令保持英文原名；其余概念尽量用中文自然词（“项目”“项目助手”“对话”“设备”“问题”“记忆”），不在中文句子里夹杂 `Runtime`、`Coordinator`、`Worker`、`Turn`、`Steer` 等英文工程词。
3. 引用用户命名的名称时，中文用直角引号 `「交换机巡检」`，英文用弯双引号 `“Switch Patrol”`。文件路径、命令和分支名直接用等宽字体展示，外层不加引号。

### 4. 标点、数字与时间格式

1. 句号规则：标题、按钮、菜单项、标签、状态名、占位符和用 `·` 连接的短提示末尾不加句号；完整句子组成的说明正文、错误提示和帮助文字末尾加句号。
2. 行内元信息分隔：同一行内的电脑名、路径、文件大小、状态统一用前后带空格的中点 ` · ` 连接，如 `Windows Desktop · D:\src\baton · 18.2 KB`。
3. 时间与时长：
   - 时刻统一用 24 小时制（`14:33`）。
   - 正在运行的计时器用 `mm:ss`（`03:12`）。
   - 短提示与列表里的耗时用紧凑格式：`3.8s`、`5m ago`、`2h ago`、`Yesterday`；在横幅或弹窗的完整英文句子里写全称：`2-hour limit`、`within 10 minutes`。
4. 容量单位：统一使用日常习惯的 `KB`、`MB`、`GB`（数字与单位间留一个空格，如 `Showing first 64 KB`、`2.4 MB`），不在界面上向用户展示 `KiB`、`MiB`。
