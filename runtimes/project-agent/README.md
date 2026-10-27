# Project Agent Runtime

`baton-project-runtime` 使用 pi-agent-core 和 pi-ai 1.3.0，在 Coordinator 保存的主对话上运行。生产工具由 Coordinator 执行并提交结果；Runtime 提供固定工具定义、顺序调用、模型重试、写入屏障、自动上下文压缩和恢复。

## 运行与凭据

Runtime 编入 batond 的 SEA，通过 `project-runtime` 子命令运行；进程与 stdio 契约见 [Runtime 子命令约定](../README.md)。部署、设备接入与登录命令统一见 [根 README](../../README.md)，开发与验证入口见 [AGENTS.md](../../AGENTS.md#常用构建与验证命令)。

Runtime 使用同一份 provider 注册表生成执行实例、模型目录、认证探测和登录入口，当前注册 `openai-codex`（ChatGPT）、`xai`（xAI）和 `anthropic`（Claude）。ChatGPT 使用 OAuth，xAI 与 Claude 支持 OAuth 或 API key。登录可选择已实现的交互方式，取消会结束登录进程。API key 从设备本地标准输入接受非空单行文本，最多 16 KiB，允许末尾换行；每个 provider 保存一份凭据，API key 会替换同 provider 的 OAuth 登录。Runtime 只读取自己的凭据目录，实际模型请求确认授权有效性。

设备设置 API 可发起在线设备的非交互登录，支持 ChatGPT 和 xAI 的设备码流程；Claude 的 OAuth 使用终端交互。设备报告的 `login_methods` 来自已注册 provider 的认证实现和设备码能力，网页据此显示设备码登录或本地配置命令。API key 始终从设备本地输入，不经过网页和中心。Runtime 的 `login-device <provider>` 自动选择设备码方式，stdout 首行返回 `{type:"device_code",provider,verification_uri,user_code,expires_in_seconds}`，随后继续轮询直到凭据保存完成；未提供有效期时使用 900 秒。SIGINT、SIGTERM 或标准输入关闭取消登录，其他交互输入返回错误。batond 取得设备码后让进程在后台继续等待，结束时立即刷新订阅报告。

`batond` 的 SEA 和开发 bundle 均通过自身子命令启动 `project-runtime`，加载可执行文件旁 `node_modules/` 中的固定依赖。源码 CLI 与编译入口共用导出的 `runProjectRuntimeCLI(args)`。

使用运行 `batond run` 的同一个系统用户登录。凭据默认保存在用户主目录下的 `.baton/project-runtime`；可用 `BATON_PROJECT_RUNTIME_DATA_DIR` 指定 Runtime 专用的私有目录，登录和守护进程须使用相同配置。凭据与 Pi、Codex CLI 的登录记录分别保存，不上传 Coordinator。`FileCredentials` 负责 OAuth 事务与跨进程锁，在 Runtime 进程内直接读写凭据文件。POSIX 目录和文件须属于当前 UID，文件须为普通文件；权限不是 `0700`/`0600` 时读写前改回，拒绝符号链接，打开前后核对设备与 inode。Windows 沿用数据目录继承的 ACL，只检查类型与符号链接，限制见 [平台私有文件约定](../../apps/batond/src/platform/README.md#私有文件)。凭据 JSON 按 UTF-8 字节限制为 64 KiB，写入使用同目录临时文件、文件 fsync 和原子替换，POSIX 再同步目录。

`batond subscriptions` 显示各 provider 的已登录、需要登录或无法读取状态，并在需要登录时给出命令。它调用 Runtime 的 `probe`，只检查本地凭据，不刷新 token，不请求模型，不输出 token。已登录表示本地存在所需凭据；实际授权是否有效由后续请求确认。过期但带有刷新凭据的订阅会在下一次真实请求时刷新。

在线的 batond 会在下一轮能力采集后自动上报登录状态，无需重新注册或重启；刷新网页即可查看。安装包依赖缺失或探测失败时，命令返回错误。

Runtime 的 `--version` 和 probe 中的 `release` 来自与中心、batond 共用的构建元数据；直接源码运行显示 `development`。batond 校验探测报告结构、登录状态和租约后，在空控制目录启动 `run`。正常安装使用 stdio；独立运行也支持 TECH 规定的本地 IPC 环境变量。Runtime 从不加载项目目录中的 AGENTS.md、skills、扩展或 MCP。

## 后台记忆与 Embedding

`batond project-runtime embedding-key <profile>` 从 stdin 保存设备 Embedding 密钥，profile 为 1～64 位小写字母、数字或连字符，文件保存在现有 Runtime 凭据目录的 embeddings 子目录。Project 只保存端点、模型和可选 profile；省略 profile 表示明确使用匿名端点，SDK 不发送 Authorization。聊天 OAuth 不用于 Embedding。

`project-runtime memory` 使用同一 stdio、私有目录、watchdog 和宿主进程账本，probe 声明 memory_protocol=1。中心按 attempt/run 身份授权，后台操作为 memory_bootstrap、read_sources、lookup_items、commit_chunk、pending_embeddings、commit_embedding、defer_embedding、finish 和 report_failure，不能调用前台业务工具。整理只读已完成批次保存的来源分片，同时参考中心提供的只读上下文（同批次其他来源和批次前最近一条回复）与未解除的停用、纠正断言。每条提案至少引用当前分片，也可引用上下文中可见的范围；中心逐条做修订、抑制和证据检查，并在 outcomes 中返回结果或拒绝原因。提交遇到 memory_conflict 时，Runtime 重新查询相关条目、再提取一次并以 final 提交，仍冲突的提案由中心记为被拒。每次最多 8 个模型请求、5 分钟，核心或冲突提案增加一次核验；分片提交后才推进游标。当前提取只使用用户和具体执行来源，agent_report 作为历史保留，不独自形成后台知识。

后台只在设备空闲时运行，前台待处理时先撤销后台 claim，实际回收后释放占用。向量生成独立于整理，不要求聊天登录；向量失败保留 pending 并按 1、5、15 分钟退避。后台状态、来源游标、等待、错误和用量保存在中心工作记录，用量未提供时为未知；请求用量另记设备 stderr，不记录查询或正文。

## 模型请求与持久化

`prompt_version=1` 选择固定的角色提示词，标题和目标来自当前对话的提示词快照。快照随 assistant 的 `pi-ai/1` payload 一起保存；恢复时复用最早保留的快照。生成压缩摘要并写入新快照时才采用新的标题和目标；只清理工具结果时沿用原快照。未知版本拒绝运行。

`checkedRPC` 按 operation 关联结果类型，集中校验外层回复、bootstrap、事件分页、输入领取、事件提交、工具 pending/终态与本地等待结果。结构无效时返回 `invalid_response`，中心失败回复保留字符串错误码。校验返回原始 data，事件 payload 和 pi-ai 消息中的扩展字段完整保留。

每次模型请求都根据 Coordinator 的事件重建历史，保留 provider 的签名、reasoning 和扩展字段，递归排序对象键。`sessionId` 为主对话 ID，关闭 provider 内部重试。`run --max-output-tokens <正整数>` 设置普通回复和摘要的输出预算，默认 32000，实际传给 provider 的值不超过模型的 `maxTokens`；`run --max-model-calls <正整数>` 设置单次运行的模型调用总预算，默认 64 次，普通生成、失败重试和摘要请求都计入。宿主可通过 `ProjectRuntime` 第五个构造参数的 `maxOutputTokens`、`maxModelCalls` 设置相同预算。provider 是否执行 token 上限取决于其 API；固定版本的 Codex 请求体不传输出 token 上限，Runtime 仍检查完整回复的容量。batond 从设备数据目录的 `project-runtime.json` 读取同名的 `maxOutputTokens`、`maxModelCalls`，启动 Runtime 时传入上述 CLI 参数。

完整 assistant payload 的 JSON 超过 160 KiB 时不保存、不执行其中的工具，立即降低下一次请求的输出预算，并反馈容量和精简要求，最多恢复三次。`length` 终态包含工具调用时，工具参数可能被截断；Runtime 丢弃该回复并要求减少或缩短完整调用；容量超限与工具截断共用每次请求最多三次的恢复额度。恢复耗尽分别以 `model_output_too_large`、`model_output_truncated_tools` 调用 `report_failure`，不会截取半条工具调用保存。普通模型错误按 5、15、45 秒退避重试，耗尽后报告 `model_request_failed`；模型调用总预算耗尽报告 `model_call_budget_exhausted`。

assistant 的 `message_end` 监听器先等待 `append_event` 提交，再按消息内的顺序发出 `call_tool`。每个工具结果由 Coordinator 保存；后续模型请求使用中心保存的结果。Runtime 的工具执行模式为 `sequential`。恢复时读取已有结果，只为缺少结果的工具调用发送原 ID；最后一条非压缩事件为 input 或 tool_result 时调用 `continue()`，为无工具 assistant 时领取下一批输入；压缩事件不改变未完成轮次的恢复位置。

项目记忆使用 `memory.recall/read/remember/correct/retire/restore`。写入引用已保存的原始来源，`memory.read` 可通过主对话序号及队列 input_id 登记来源，中心决定角色、归属与可读边界。新知识合并独立证据，修改检查当前修订，停用恢复须有用户请求证据；操作标识由中心从工具调用身份生成。事实变化使用带有效时间的 supersede，普通编辑保持停用或替代关系。每次模型请求前通过 prepare_context 保存当前核心要求和相关片段，并传入当前视图中记忆工具结果读到的条目版本（view_refs）；快照作为一条消息放在本批输入之前，同一批次内多次请求的前缀保持一致。普通请求的 assistant payload 记录 memory_context_id。核心要求、快照读到的条目版本变化或自然到期使新输出失效时，Runtime 刷新上下文并在模型调用预算内重试；恢复先完成原工具调用和 pending nodes.exec。默认关闭 Embedding。启用时 Runtime 先调用 embedding_query，使用 OpenAI 7.19.0 SDK 生成向量，再把配置和查询哈希绑定结果交给 prepare_context；显式 memory.recall 的向量放在 call_tool payload，原工具 arguments 保持不变。缺凭据或端点请求失败只降级到词法召回。每次普通请求取得当前快照后，只替换读到的条目版本已不在快照 view_refs 中的记忆工具结果，保留工具配对与原文读取入口；其他工具结果和摘要原样保留。

开发工作通过 `threads.create` 和 `threads.send` 交给执行 Agent，使用 `threads.get/read` 查询状态和回复，`threads.stop/archive` 停止当前一轮或归档 Thread。新建时按设备能力、用户要求和项目记忆选择 Agent 与模型；`threads.create` 的 `model` 省略时使用设备上该 Agent 的默认模型。`threads.send` 可用 `model` 指定下一轮模型，省略时沿用当前模型；设备须支持换模型，模型目录用于发现与补全，显式 ID 交给原生 Agent 判定，`steer` 沿用当前一轮模型。工具操作的 Thread 都属于本 Project，由 Project Agent 新建；用户随后可以在其中开启自己的轮次，回复按每轮第一条消息的发送方决定是否送回 Project Agent。`inbox.ask` 可用 `thread_id` 关联本 Project 的 Thread。

`nodes.exec` 的 pending 响应携带 `thread_id`；`wait_protocol=1` 时还携带非负安全整数 `version` 和 `wait_remaining_ms`。batond 声明 `local_wait_protocol=1` 时，Runtime 用 `{thread_id, after_version, wait_ms}` 本地等待最多 25 秒，然后通过 `wait_tool` 查询中心保存的状态。未声明协议时每 250ms 查询一次；运行期限到达时用 `finish_wait=true` 保存当前状态。等待结束后命令继续执行，输出可通过 `threads.read` 获取。

闲置 180 秒，或运行满 15 分钟并处理完当前轮次后，先检查是否需要压缩，再调用 `finish`。收尾摘要生成失败、没有有效缩减或模型调用预算耗尽时保留原始历史，将 `finish_compaction_failed` 和具体错误码写入 stderr，仍正常 `finish`。下一次请求按窗口占用重新判断是否必须压缩；租约丢失、提交错误等仍立即退出。收尾只释放 Project Agent 租约，已开启的 Thread 继续执行。

## 上下文压缩

每次模型请求前超过窗口的 80%、运行收尾超过 50% 时触发，还会为模型输出预留容量。先把较早、已被后续 assistant 分析的大工具结果替换为带原始序号的读取提示，保护最近三批输入及尚未分析的结果；降到窗口的 40% 以下即可结束，无需调用摘要模型。

仍需缩减时，优先保留最近两批输入对应的对话及窗口 15% 的最近内容。长单轮可以在完整工具批次之间切分。摘要请求重放原系统提示词、工具声明、provider 签名和待压缩消息前缀，将记忆工具正文换成读取提示，不注入动态记忆快照，沿用对话 `sessionId`，最后追加协调角色的摘要指令并禁止工具调用。摘要保留用户要求、准确 Thread ID、设备、目录、当前状态、最后的结论、决定和未完成事项。缓存能否命中取决于模型服务。

空白、截断、工具调用、超限或没有缩短上下文的摘要不会提交。Coordinator 校验租约、历史序号、工具配对和范围，在同一事务里保存压缩事件并更新读取起点。摘要不包含记忆内容，不记录记忆快照，记忆变化后继续有效；新摘要的 `memory_index` 为空。回执丢失后重发同一事件标识；历史或配置变化时丢弃旧摘要，重新读取。摘要生成失败按 5、15、45 秒重试，请求前必需的压缩失败仍报告模型请求失败。

普通请求明确上下文溢出后，只要压缩持续减少估算 token、运行未满 15 分钟且模型调用总预算有剩余，就可以多次压缩并恢复。同一请求连续溢出时，逐次将保留 token 比例减半，始终只在完整工具批次之间切分。没有可继续缩减的历史或压缩未减少 token 时报告 `context_overflow_no_progress`；时间或调用预算耗尽时报告 `context_overflow_budget_exhausted`。失败回复不保存、不执行工具。

压缩结果只改变发给模型的视图，原始历史完整保留，可以通过 `history.search/read` 找回。压缩比例等默认值位于 `src/compaction.ts`，宿主可用 `ProjectRuntime` 第四个构造参数覆盖，CLI 使用这些默认压缩设置。

## 验收证据

验证命令见 [AGENTS.md](../../AGENTS.md#常用构建与验证命令)，安装包检查见 [发布设计](../../specs/release/TECH.md)。

测试包括请求前与收尾压缩、旧工具结果保护、前缀与签名复用、超限恢复、重复压缩、提交冲突与丢失回执、无效摘要拒绝、结尾表四种情况、部分工具已有结果、真实子进程在保存和工具事务前后被杀、失败屏障禁止工具执行、模型失败与超限输出、虚拟时钟下的 180 秒与 15 分钟边界、凭据文件的权限修复、属主、类型、符号链接、64 KiB 边界、缺失文件、原子替换与事务锁，以及无网络 probe。跨系统请求测试用超过 1 MiB 的历史验证分页和 provider 扩展字段的保留。

faux 恢复测试的 Coordinator 替身负责持久化和事务去重。真实 Runtime、batond、Gateway、Coordinator 与 PostgreSQL 的跨 app 集成测试位于 [e2e/](../../e2e/README.md)。测试检查工具结果、记忆、压缩事件与读取起点在 Coordinator 保存，原始消息保留，运行正常结束。事务故障注入测试验证服务端去重。Runtime、跨设备调度和恢复的自动验收使用本地模型替身及离线录制；真实订阅检查仅在显式手动运行冒烟时执行。
