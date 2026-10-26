# 界面流程

本文说明设计稿中的入口、状态变化和返回路径。实现顺序见 [Web UI 实施计划](../specs/web-ui/PLAN.md)，产品行为以 `specs/` 为准，界面文案遵循 [WRITING.md](WRITING.md)。界面面向桌面浏览器，文案使用英文。

## 画板索引

以下路径相对于 `design/`。`文件#ref` 指定文件内的画板或组件，可用 `elyx render design/<文件> --ref <ref> -o design/renders/<名称>.png` 单独查看。

| 流程 | 主要入口与状态 |
|---|---|
| 登录导航 | `screens/login.elyx#login`、`#loginExpired`；`screens/workspace.elyx#firstVisit`、`#accountOpen`、`#signOutFailed` |
| 设备 | `screens/devices.elyx#devicesEmpty`、`#devicesSyncing`、`#devicesMissing`、`#devicesDefaultRemoved`、`#devicesPermissionEnableFailed`、`#devicesDisconnecting`；`blocks/enroll-dialog.elyx#enrollExpired` |
| Thread | `screens/threads.elyx#threadsEmpty`、`#threadsFolderRoots`、`#threadsFolderApplied`、`#threadsStopConfirm`、`#threadsArchivePending`、`#threadsArchived`、`#threadsLimited` |
| 项目协同 | `screens/new-project.elyx#creationFailed`、`#created`；`screens/project.elyx#noEligibleDevice`、`#stopping`、`#reported`；`screens/project-thread.elyx#threadRunning` |
| 查看与引用 | `screens/threads.elyx#threadsHistoryFailed`、`#threadsFileMissing`、`#threadsFileBinary`；`screens/project-thread.elyx#fileSelection`、`#questionSelection`、`#longFileSelection`、`#fileQuote`、`#longQuote`、`#referenceSent` |
| 事项 | `screens/inbox.elyx#inbox`、`#handled`、`#compactReply`；`blocks/attention-card.elyx#attentionReplyFailed`、`#attentionConflict`、`#systemResolved` |
| 项目维护 | `screens/project-settings.elyx#saveFailed`、`#archiveConfirm`；`screens/project-memory.elyx#conflictMemory`、`#archivedMemory`；`screens/project.elyx#archivedProjects`、`#archived` |

## 登录与导航

未登录时进入登录页。账号或口令错误留在表单内提示；管理员重置口令或登录失效时说明重新登录的原因。退出登录返回登录页，不提供自助注册或管理员账号管理入口。

工作区侧栏提供 Inbox、Threads、Devices 和项目列表。Baton 标识旁的新建按钮进入 Threads 并聚焦新建输入区；Projects 旁的加号打开新建项目弹窗。两种入口对应不同对象。

首次进入且没有设备时，主操作引导连接设备。用户仍可创建项目、查看已有记录；设备接入完成后可到 Threads 发起第一段对话。账号入口打开账号菜单，主题切换作用于整个工作区。

## 设备接入与管理

从 Devices 的 `Connect a device` 打开接入弹窗。选择系统、填写设备名称后，复制注册命令与临时口令；命令从环境变量或标准输入读取口令。等待接入时显示有效期，过期后通过 `Get a new code` 重新获取。关闭弹窗返回设备列表。

设备详情呈现 Agent 与订阅、允许访问的目录、命令权限和默认设备设置。允许目录在设备配置中管理。选择离线设备为默认设备仍可保存，并说明离线影响；默认设备移除后提示用户重新选择。

已连接但仍在同步的设备单独显示同步状态。Agent 缺失或订阅未登录时说明具体缺项，不能将它显示为可用。命令执行权限变更失败时保留已生效的状态，并提供重试。

断开设备前确认影响。确认后显示处理状态，凭据吊销和连接断开完成后才显示已移除。离线设备上仍在运行的进程可能继续执行，历史记录保留。

## 独立 Thread

Threads 顶部的输入区预填最近位置和模型。位置菜单包含设备与目录；`Choose another folder…` 进入允许目录内的选择界面，选定后返回输入区并保留消息草稿。模型菜单按当前位置的 Agent 分组。

发送第一条消息创建独立 Thread，不选择 Project 或执行时限。列表可按设备、Project 和归档状态筛选。打开一行后，右侧显示详情，列表收起 Project 和目录两列；关闭详情恢复完整列表，保留筛选和滚动位置。

运行中可以排队消息，支持时可以立即插话。排队消息发出前可取消；立即插话沿用当前模型。切换模型仅影响下一轮，不支持的操作在用户点击后说明原因。

停止后先显示正在停止，设备确认后才显示停止结果；尚未发送的排队消息同时撤回。归档正在运行或状态不确定的 Thread 需要先停止并等待确认。已归档的详情保留历史，隐藏输入区。

设备离线时，新消息保存后等待原设备。执行中断线保留最后报告时间，不能把过去的执行中当成当前状态。送达未知时不自动重发，用户查看记录后决定下一步。历史被删时 `New chat in this folder` 打开新建入口；目录不存在时 `Choose folder` 打开目录选择；两者保留原设备和可用模型，不向旧 Thread 重发。

## 项目协同

新建项目填写名称、可选目标和项目助手模型。名称校验、提交或保存失败均保留输入。创建后进入空项目并引导发送第一条消息。

主对话里的项目助手每轮依次显示过程记录、相关 Thread 卡片、回复正文。概览提供目标、运行设备、Threads、Memory 和最近活动。从 Thread 卡片或概览打开右侧详情，详情替换概览；关闭详情返回概览并保留主对话位置。详情打开时，主对话输入区上方仍显示运行、等待设备和待决定数量。

项目助手没有可用设备时，主对话仍可保存消息，并显示具体等待原因。默认设备不满足条件时可以选择另一台满足条件的设备，只在对话内记录原因，默认设备设置不变。

`Stop run` 停止当前项目助手运行，现有 Thread 继续工作。停止反馈与确认状态单独呈现。持续错误引起的需要处理状态通过输入区上方横幅和 Inbox 系统事项共同呈现。

## 过程、文件与引用

Thread 回复前的过程记录默认收起，展开时从中心读取，设备离线时照常显示。运行中的一轮直接展开实时输出，结束后收起。被截断的步骤标明缺口和原始大小，全文从设备读取；加载、读取失败、设备离线、历史被删分别说明原因；输出中断或无法补齐时明确标记。

附件中的文件从设备实时预览，目录导航限定在允许范围内。长文本显示截断提示；路径越界、文件不存在、设备离线和无法预览的二进制文件显示各自的原因。文件不可用时不继续展示旧内容。返回或关闭预览恢复原 Thread 与滚动位置。

有项目上下文时，在 Thread 回复、文件预览或事项内容中选中文字，可选择 `Ask project assistant`。主对话输入区预填引用和来源，用户补充要求后发送；引用过长时注明截断和原长度。来源包含相应 Thread、回复位置、设备、文件路径与行号，或事项标识。独立 Thread 不默认关联其他项目。移除引用保留用户补充的要求。

## 待处理事项

Inbox 默认列出待处理事项，最新的在前。最新一条展开，其余各收成一行，点开再展开。展开的事项直接显示说明，头部标明所属 Project 和关联 Thread，可以选择选项或打开附言与文字回复表单。提交失败保留选择和文字。关闭事项作为独立动作，不能混同于选择名为跳过的选项。

回答或关闭后，事项离开待处理列表，侧栏和浏览器标签页数量更新。主对话和关联 Thread 原位置保留结果卡片；已处理事项入口可查看回答、关闭、撤回和解决结果。

同一事项各处共享状态。重复处理或撤回竞态显示先保存的结果，不再发送第二次回答。设备离线或项目暂停时，普通回答可以保存，等待项目助手后续处理；选项不会直接执行设备操作。

系统事项没有选项和回复表单。`Go to project` 进入对应项目的故障横幅，确认重试后事项解决；用户也可关闭通知。关闭通知不等于故障恢复，持续存在的同一故障不会立即重复创建事项。

## 项目维护

项目设置入口提供名称、目标、模型、暂停和归档操作。自动保存过程中和保存失败时在原位反馈，失败保留修改。模型变更从下次运行生效，当前运行沿用原模型。

概览的 Memory 标签只列记忆正文。点一条打开编辑弹窗，可以保存、停用，或打开来源与历史；添加和编辑取消后返回记忆列表。停用的条目收进列表末尾的 `Not in use`，从那里恢复。编辑期间条目被更新时，弹窗显示最新正文并保留用户草稿，用户核对后再保存。

暂停项目后，新输入继续保存，项目助手不再启动；Thread 和事项仍可操作。恢复后继续处理保存的输入。归档确认说明停止项目助手、关闭待处理问题、保留对话和记忆，Thread 中的工作继续执行。

归档项目有独立查看入口。归档后的主对话和记忆只读，现有 Thread 仍遵循各自的状态和操作规则。归档 Project 与归档 Thread 的影响分别呈现。

## 共用交互

- 页面切换和详情开关保留对应的筛选、草稿和滚动位置。返回入口回到来源页面，避免跳到无关默认页面。
- 菜单支持键盘选择，弹窗将焦点限制在内部；关闭后焦点返回触发控件。输入法组合输入期间不触发发送。
- 浮层最多两层，需要更深操作时替换当前弹窗。选择目录、引用内容等返回后保留原草稿。
- 提交中防止重复操作，但保留反馈；能力受限的操作可点击，并说明原因。
- 常规保存、回答和切换模型在原位反馈。停止、归档、断开设备和开启命令权限说明具体影响。
- 空状态给出下一步入口；加载和故障状态说明当前正在做什么或如何恢复。任何确认丢失都不能伪装成操作已完成。

画板描述静态状态和入口意图，完整键盘行为、滚动、跨页面同步和异步时序在前端实现时按这些规则验证。
