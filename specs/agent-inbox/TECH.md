# Agent Inbox 技术设计

Status: draft
Owner: Asa
Date: 2026-10-18
Baseline: `hhubb22/baton@3450d12`；`@openuidev/lang-core` 1.0.1、`@openuidev/react-lang` 1.0.1；`github.com/SherClockHolmes/webpush-go` v1.4.0；Web Push 协议 RFC 8030、消息加密 RFC 8291、VAPID RFC 8292
Approval: 尚未批准
Basis: [PRODUCT.md](PRODUCT.md) IB-01～IB-32；[Project Agent TECH](../project-agent/TECH.md) 第 3、4、7 节；[Baton TECH](../baton/TECH.md)

## Context

事项由 Project Agent 通过工具创建，用户在浏览器里处理，处理结果回到 Project Agent 的输入队列。所以这个特性跨四个地方：Runtime（Node.js）、Coordinator（Go）、浏览器页面和浏览器的 Service Worker。下面这些现状决定了设计：

- Project Agent 的工具由 Coordinator 在 `call_tool` 事务里执行，结果写成 `tool_result`；同一个 `tool_call_id` 重发时返回已保存的结果（Project Agent TECH 第 5、7 节）。事项的创建要放进同一个事务。
- 输入队列已经预留了主动输入 `attention_answer`（迁移 0017）。主动输入会触发放置和唤醒（Project Agent TECH 第 4 节）。
- Coordinator 是 Go 程序，没有 OpenUI 解析器。展示内容由 Runtime 用 lang-core 检查，Coordinator 只写结果（Project Agent TECH 第 7 节）。
- Web 界面由 `internal/webui` 嵌入 Go 二进制。它的 CSP 是 `worker-src 'none'`、`style-src-attr 'none'`、`connect-src 'self'`（`internal/webui/handler.go` 的 `csp`）。`TestEmbeddedUIHasNoThirdPartyHosts` 检查构建结果里不出现 `cdn.jsdelivr.net` 等地址。页面目前没有 URL 路由，静态处理器只对 `/` 和存在的文件返回内容，其他路径交给 API。
- 会话 Cookie 是 `Secure`、`HttpOnly`、`SameSite=Strict`（`internal/auth/auth.go` 的 `SessionCookie`）；写请求还要带 CSRF 令牌，令牌只在页面内存里。
- 浏览器的实时通道 `/api/v1/events` 已经写进 Baton TECH，但还没有实现。
- 任务结果的证据和产物都是 `task.ResultRef`（`internal/task/result.go`）。其中指向已登记目录文件的引用，`storage_ref` 形如 `root:<root_id>`，`resource_id` 是根目录内的路径（`internal/fileaccess/artifact.go`）。这类引用可以直接交给现有的 `GET /api/v1/nodes/{id}/files?root_id=&path=` 预览。
- Web Push 不允许静默推送。Chrome 在推送事件没有显示通知时，会替网站显示一条「此网站已在后台更新」。Safari 会直接撤销网站的推送权限。[Apple 文档](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)、[说明](https://pushpad.xyz/blog/chrome-push-notifications-this-site-has-been-updated-in-the-background)

## Proposed changes

### 1. 组件与数据流

```text
Runtime ── call_tool(inbox.*) ──► Coordinator ── PostgreSQL
  │ lang-core 检查展示内容              │  attention_requests / push_*
  │                                     │
  │                       ┌─────────────┼──────────────────┐
  │                       ▼             ▼                  ▼
  │                  /api/v1 接口   /api/v1/events     推送发送循环 ──► 浏览器厂商的推送服务
  │                       │             │                                   │
  │                       └──── 浏览器页面（React + react-lang） ◄── Service Worker
  │                                     │
  └──────────── 输入队列 attention_answer ◄─ 用户回答或关闭
```

Coordinator 新增 `internal/inbox` 包，负责事项的状态变化、API、推送订阅和发送循环；`internal/projectagent` 的工具分发调用它。Runtime 新增展示内容检查。Web 新增 `web/src/inbox/`，包含 Inbox 页面、事项卡片、OpenUI 组件库和渲染器。Service Worker 是 `web/public/sw.js`，构建后位于 `dist/sw.js`。

### 2. 数据模型

迁移 `0018_attention_requests.sql`，派发第一个工作项时登记编号。所有表都带 `employee_id`，跨表引用使用复合外键，沿用现有的归属检查。

| 表 | 主要字段 | 说明 |
|---|---|---|
| `attention_requests` | id, employee_id, project_id, agent_id, conversation_id, origin_tool_call_id, task_id, title, summary, content, content_lang, library_version, options, allow_text, state, version, resolution, resolved_by, resolved_at, withdraw_reason, created_at, updated_at | `(conversation_id, origin_tool_call_id)` 唯一；`state IN ('open', 'answered', 'closed', 'withdrawn')`；`options` 是 0～5 项的 JSON 数组，每项有 `id`、`label`、`description`、`recommended`；`content` 不超过 32 KiB；`task_id` 可空，外键 `(employee_id, task_id)` |
| `push_subscriptions` | id, employee_id, endpoint, p256dh, auth, label, vapid_key_id, created_at, last_success_at, failure_count | `endpoint` 唯一；`label` 是界面上显示的浏览器名称，例如「Chrome · mac-studio」 |
| `push_deliveries` | id, employee_id, subscription_id, attention_request_id, state, attempts, next_attempt_at, last_status, created_at | `state IN ('pending', 'sent', 'skipped', 'failed')`；`(subscription_id, attention_request_id)` 唯一；索引 `(next_attempt_at) WHERE state = 'pending'` |

索引：`attention_requests (employee_id, created_at DESC) WHERE state = 'open'` 用于 Inbox；`(project_id, state)` 用于上限检查和 `inbox.list`。

`version` 每次状态变化加一，用户处理时带 `expected_version`，沿用任务核实的做法（`POST /tasks/{id}/resolve`）。`resolution` 保存 `option_id`、`option_label`、`text`、处理时的浏览器标签和 `client_request_id`。`resolved_by` 区分用户和 Project Agent。

`content_lang` 固定为 `1.0`，`library_version` 是生成展示内容时的 Baton 组件库版本（第 5 节），两者都由 Runtime 填写（IB-19）。

### 3. Project Agent 工具

四个工具都在 `call_tool` 的事务里执行，结果写成 `tool_result`。事务开头已经锁定了 `project_agents` 行（Project Agent TECH 第 7 节），所以同一个 Project 的上限检查不会并发出错。

**`inbox.ask`。** 模型给出的参数：`title`、`summary`、`content`、`options`（每项 `id`、`label`、可选 `description` 和 `recommended`）、`allow_text`、可选的 `task_id`。选项 ID 符合 `^[a-z][a-z0-9_-]{0,31}$`，在同一事项内唯一，最多一个 `recommended`。Runtime 在 `call_tool` 请求里另外附上 `content_lang`、`library_version` 和检查结果；这些字段不在模型的参数里，模型无法伪造。

Coordinator 依次检查：

1. Runtime 报告检查失败：把解析器的错误写成 `is_error` 结果，不创建事项（IB-18）。
2. 长度和格式：标题、摘要、选项数量和长度、`content` 的字节数；没有选项时 `allow_text` 必须为真（IB-01）。
3. `task_id` 属于同一个 Project（IB-02）。
4. 本 Project 的 `open` 事项少于 10 个（IB-05）。

通过后插入 `attention_requests`，为该员工每个有效的推送订阅插入一行 `push_deliveries`，提交后发出事件（第 6 节）。结果是 `{request_id, state: "open"}`。重发同一个调用时，`tool_result` 已经存在，直接返回保存的结果（IB-04）；唯一索引是第二道保护。

**`inbox.list`。** 返回本 Project 最近 50 个事项的 ID、标题、状态、关联任务、创建时间和处理摘要，按创建时间倒序，不超过 32 KiB。

**`inbox.get`。** 返回一个事项的全部字段和处理结果。`content` 超过 16 KiB 时只返回开头，并注明原长度，让工具输出不超过 32 KiB。模型很少需要读回自己写的展示内容，这样截短不影响 PA-18。

**`inbox.withdraw`。** 参数 `request_id` 和 `reason`（1～200 个字符）。锁定事项行：状态是 `open` 时改为 `withdrawn`，记录原因，版本加一，把未发送的 `push_deliveries` 标为 `skipped`；状态已经不是 `open` 时，返回当前状态和处理内容，不报错（IB-24）。撤回不写输入（IB-23）。

锁顺序：`project_agents` → `conversations` → `attention_requests` → `push_deliveries`。

### 4. 用户处理事项

```text
POST /api/v1/attention-requests/{id}/answer  { expected_version, option_id?, text?, client_request_id }
POST /api/v1/attention-requests/{id}/close   { expected_version, client_request_id }
```

两个接口都检查会话、Origin 和 CSRF，与现有写接口一致。事务内：

1. `SELECT … FOR UPDATE` 锁定事项，确认属于本人。
2. 状态不是 `open`：如果 `resolution.client_request_id` 等于本次请求的值，说明是网络重试，返回 200 和当前事项；否则返回 409，附带当前事项，包括处理内容或撤回原因（IB-13、IB-24）。
3. `expected_version` 不一致：返回 409 和当前事项。
4. 校验 `option_id` 在 `options` 里、文字不超过 4 KiB、没有选项时必须有文字。
5. 更新状态和 `resolution`，版本加一；把这个事项还没发送的 `push_deliveries` 标为 `skipped`。
6. 向输入队列插入一条 `attention_answer`，`source_key = attention:{id}:resolution`，内容是事项 ID、标题、状态、选项 ID 和标签、文字（IB-12）。
7. 提交后发出事件。

这条路径不锁 `project_agents`，锁顺序是 `attention_requests` → `project_agent_input_queue` → `push_deliveries`。它和第 3 节的路径都先锁事项行，再锁之后的表，不会形成环。回答和撤回同时到达时，两边都在等同一个行锁，先拿到的生效，后到的一方看到的状态已经不是 `open`（IB-21、IB-24）。

插入输入后，放置和唤醒按 Project Agent TECH 第 4 节进行。Project 暂停时输入照常写入，放置扫描要求 Project 为 active，所以等恢复后再处理（IB-12）。

**Project 归档。** `PATCH /projects/{id}` 把状态改为 archived 的事务里，同时把该 Project 的 `open` 事项改为 `withdrawn`，原因为「Project 已归档」，并把未发送的推送标为 `skipped`（IB-25）。锁顺序沿用 `project_agents` → `attention_requests`。

### 5. 展示内容：组件库、提示词和检查

**组件库只定义一次。** Baton 组件库写在 `web/src/inbox/openui/library.tsx`：每个组件用 Zod 定义参数，用 React 实现渲染；表格的行数、列数等上限也写在 Zod 里，解析器会报出超限。动作有 `@Answer(optionId)` 一个自定义动作，加上内置的 `@OpenUrl`、`@ToAssistant`、`@Set`、`@Reset`。

脚本 `pnpm gen:openui` 从这个库生成 `runtimes/project-agent/src/generated/openui-library.json`，内容包括：

- `library_version`：手工维护的整数。
- `schema`：`library.toJSONSchema()` 的结果。
- `schema_hash`：`schema` 的哈希。
- `prompt`：`library.prompt()` 的输出，开场白换成「`content` 参数是一段 OpenUI Lang 程序」的说明。

生成的文件提交进仓库，CI 重新生成并比对，沿用 `check:dist` 的做法。`schema` 变化而 `library_version` 没有增加时测试失败，避免旧事项和新组件库对不上却没人察觉。Runtime 不依赖 React，只用 lang-core 和这个 JSON。

**提示词。** Runtime 把 `prompt` 放进 `inbox.ask` 的工具说明，约 1000～1600 token（2026-10-18 用 9 个组件实测）。`prompt_version` 包含 `library_version`，组件库变化时缓存前缀随之变化。lang-core 对同一个库两次生成的提示词完全相同，不破坏 prompt cache（同次实测）。

**Runtime 的检查（IB-18）。** 用 `createParser(schema, "Card")` 解析 `content`，以下任一情况都算失败：

- 超过 32 KiB，`meta.incomplete` 为真，`root` 为空，或 `meta.unresolved` 不为空。
- `meta.errors` 不为空，包括未知组件、缺少必填参数和超过上限。
- `queryStatements` 或 `mutationStatements` 不为空。
- 遍历 AST 时出现 `@Answer`、`@OpenUrl`、`@ToAssistant`、`@Set`、`@Reset` 以外的 `@` 调用，包括 `@Run` 和内置函数。
- `@OpenUrl` 的参数不是 `https://` 开头的字面量。
- `@Answer` 的参数不是字面量，或者不在 `options` 的 ID 里。

失败时附上的错误不超过 4 KiB，每条包括 code、所在语句和解析器的说明，写进 `is_error` 结果后模型可以据此改正。

**浏览器的渲染。** `AttentionContent` 组件用 react-lang 的 `Renderer` 渲染，`toolProvider` 传 `null`。即使检查被绕过，`Query` 和 `Mutation` 也没有工具可调。`onAction` 的处理：

| 动作 | 浏览器做什么 |
|---|---|
| `@Answer(id)` | 在固定界面里选中这个选项，不提交（IB-16） |
| `@OpenUrl(url)` | 再检查一次 `https:`，用 `window.open(url, "_blank", "noopener,noreferrer")` 打开 |
| `@ToAssistant(text)` | 跳到所属 Project 的主对话，把文字和事项引用预填进输入框，不发送（IB-15） |
| 其他 | 忽略 |

渲染失败时，按两种情况显示「这部分内容无法显示」（IB-19）：

- 组件渲染时抛错：每个组件外包一层 React 错误边界，在原位置显示。
- 解析器丢弃了组件，例如组件已删除或参数不匹配：渲染前先用同一个 schema 解析一遍。出错的语句如果本身就是一个组件调用，就在程序末尾追加 `<语句名> = Unavailable()`，利用「同名语句后写的生效」，在原位置显示占位。出错的组件写在别的语句里面时没法单独替换，就在内容下方显示一行「部分内容无法显示」。提示词要求每个组件单独一行，所以多数情况能在原位置显示。

**CSP 和依赖。** 我们的组件只用 CSS 类，不用内联 `style` 属性；React 的 `style` 属性通过 CSSOM 设置，`style-src-attr 'none'` 也不拦截。`worker-src` 改为 `'self'`，允许注册 `sw.js`。

react-lang 在 `NODE_ENV=development` 时会从 jsDelivr 加载开发工具（`devtoolsBootstrap`），生产构建会删掉这段代码。开发模式下，`main.tsx` 在引入 react-lang 之前设置 `globalThis[Symbol.for("openui.devtools.autoMount")] = true` 把它关掉；现有的 `TestEmbeddedUIHasNoThirdPartyHosts` 继续检查构建结果。

lang-core 的 `postinstall` 会发送匿名安装统计。pnpm 默认不运行依赖的安装脚本，项目不把它加入允许名单；CI 另外设置 `DO_NOT_TRACK=1`。依赖锁定确切版本，不使用 `@openuidev/react-ui`。

### 6. 页面、接口和多页面同步

接口都在 `/api/v1` 下：

| 接口 | 作用 |
|---|---|
| `GET /inbox?state=open\|done&cursor=` | 列出事项；`open` 按创建时间倒序，`done` 按处理时间倒序；响应附带 `open_count` |
| `GET /attention-requests/{id}` | 事项的完整内容和处理结果 |
| `POST /attention-requests/{id}/answer`、`/close` | 第 4 节 |
| `GET /push/config` | VAPID 公钥及其 ID |
| `GET /push-subscriptions`、`POST /push-subscriptions`、`DELETE /push-subscriptions/{id}` | 第 7 节 |

**同步（IB-08）。** Coordinator 进程内维护一个按员工分组的广播器。事项状态变化的事务提交后，发出 `attention_request.changed {id, state, version, open_count}`，经 `/api/v1/events` 送到本人所有打开的页面，页面收到后重新读取这个事项。事件只用来提醒页面刷新，丢失也不影响正确性：页面在 WebSocket 重连后、窗口重新获得焦点时都会重新读取。Coordinator 只有一个实例，不需要跨进程广播。`/api/v1/events` 如果在本特性之前还没有实现，由本特性的工作项实现它的连接、鉴权和这一种事件，其余事件由 T21 补充。

**主对话里的事项。** 主对话按 `conversation_events` 渲染。遇到 `inbox.ask` 的工具调用和它的结果时，用结果里的 `request_id` 读取事项，在这个位置显示事项卡片。

**任务详情（IB-20）。** 读取现有的 `GET /tasks/{id}`。`storage_ref` 以 `root:` 开头的引用显示「预览」，调用 `GET /nodes/{node_id}/files?root_id=&path=`；返回 `node_offline` 时显示暂不可查看。其他引用只显示字段，不提供预览。

**问 Project Agent（IB-21、IB-22）。** 在浏览器里完成：把选中的文字（超过 8 KiB 时截短并注明原长度）和来源组成一段引用，预填进主对话的输入框。用户修改后发送，作为普通文本走 `POST /projects/{id}/messages`。引用不另设结构化字段，Project Agent 收到的就是用户看到的那段文字。

**页面路由。** 通知要能直接打开某个事项，页面因此需要 URL 路由：`/inbox`、`/inbox/{id}`、`/projects/{id}`、`/tasks/{id}`。`internal/webui` 对这几个前缀返回 `index.html`，其他未知路径仍然交给 API，现有测试的意图不变。用户点击通知后打开的第一个页面请求可能不带 `SameSite=Strict` 的 Cookie；这不影响使用，因为 `index.html` 不需要登录，页面加载后的接口请求是同站请求，会带上 Cookie。

### 7. 浏览器推送通知

**密钥。** Coordinator 第一次启动时生成一对 P-256 VAPID 密钥，私钥按 `internal/privatefile` 的约定保存在数据目录，公钥和密钥 ID 由 `GET /push/config` 提供。部署配置提供 VAPID 的 `subject`（`mailto:` 或 `https:` 地址，RFC 8292 要求）。更换密钥后，旧订阅全部失效：服务器删除 `vapid_key_id` 不匹配的订阅，页面发现浏览器里的订阅用的是旧公钥时会提示重新开启。

**开启（IB-28）。** 设置页的开关触发以下步骤，权限请求只发生在用户点击时：

1. `navigator.serviceWorker.register("/sw.js")`。
2. `Notification.requestPermission()`。
3. `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`。
4. 把 `endpoint`、`keys` 和浏览器标签 POST 给 Coordinator。

同一个 `endpoint` 已经属于另一个员工时，转给当前员工，因为同一个浏览器配置在同一时刻只属于一个登录者。关闭时先 DELETE 订阅，再 `unsubscribe()`。页面用 `pushManager.getSubscription()` 的 `endpoint` 在列表里标出「当前浏览器」。

**发送。** 发送循环每秒领取到期的 `push_deliveries`（`FOR UPDATE SKIP LOCKED`）。发送前再读一次事项，状态不是 `open` 就标为 `skipped`。消息内容是 `{type: "attention", id, project_title, title, url: "/inbox/{id}"}`，用 webpush-go 按 RFC 8291 加密后 POST 到 `endpoint`（IB-32）。请求头：

- `TTL: 86400`。
- `Urgency: normal`。
- `Topic`：事项 ID 的短哈希。推送服务对同一 Topic 只保留最新一条未送达的消息。

结果处理：

| 推送服务返回 | 处理 |
|---|---|
| 201 | 标为 `sent`，更新订阅的 `last_success_at` |
| 404、410 | 删除订阅；界面上这个浏览器显示为未开启（IB-31） |
| 429、5xx、网络错误 | 按 10 秒、1 分钟、5 分钟、30 分钟重试，第 5 次仍失败就标为 `failed` |
| 其他 4xx | 标为 `failed`，记录状态码 |

推送失败不影响事项本身（IB-31）。

webpush-go 依赖的 `golang-jwt/jwt/v5` 和 `golang.org/x/crypto` 已经在 `go.mod` 里，不引入新的传递依赖。

**`endpoint` 的安全检查。** `endpoint` 由浏览器提交，Coordinator 会向它发请求，所以要防止被用来访问内网（SSRF）。检查规则：

- 只接受 `https`、443 端口、主机名在允许列表里的地址。
- 默认允许 `fcm.googleapis.com`、`updates.push.services.mozilla.com`、`web.push.apple.com` 和 `*.notify.windows.com`，部署可以在配置里增加。
- 发送时不跟随重定向，连接超时 10 秒，响应体最多读 4 KiB。

**Service Worker。** `sw.js` 用原生 JavaScript 编写，不经过打包，只处理两种事件：

- `push`：每条推送都调用 `showNotification`，标题是「{Project 标题}：需要你决定」，正文是事项标题，`tag` 是事项 ID，`data.url` 是事项地址。按 Chrome 和 Safari 的规则，每次推送都必须显示通知（见 Context）。
- `notificationclick`：已有 Baton 页面时，聚焦它并跳到事项地址；没有时 `clients.openWindow(url)`。

**移除已处理事项的通知（IB-30）。** 推送不能用来关通知，因为每条推送都必须显示一条新通知。改由页面清理：只要这个浏览器里开着 Baton 页面，页面在加载时、以及收到 `attention_request.changed` 时，调用 `registration.getNotifications()`，关闭对应事项已经不是 `open` 的通知。没有打开 Baton 页面时，旧通知会留到用户点开它（打开后显示「已回答」）或下次打开 Baton（IB-30）。

### 8. 工作项

| 编号 | 内容 | 依赖 |
|---|---|---|
| IB-W01 | 0018 迁移；`internal/inbox` 的状态变化与锁顺序；四个工具接入 `call_tool`；处理接口；归档时撤回 | PA-W05 |
| IB-W02 | Baton 组件库、`gen:openui` 与 CI 比对；Runtime 的工具说明和展示内容检查 | PA-W06、IB-W01 |
| IB-W03 | 页面路由；Inbox 页面、事项卡片、`AttentionContent`；主对话里的事项；任务详情的结果与预览；问 Project Agent | PA-W07、IB-W01、IB-W02；任务详情页与 T22 的分工待定 |
| IB-W04 | `/api/v1/events` 的连接与 `attention_request.changed`（T21 尚未实现时） | IB-W01 |
| IB-W05 | VAPID、订阅接口、发送循环、`sw.js`、设置页、页面清理通知；CSP 改动 | IB-W01、IB-W03 |
| IB-W06 | 验收 IB-A01～IB-A15 | 以上全部，PA-W08 |

IB-W01 和 IB-W02 可以并行。IB-W05 的服务器部分只依赖 IB-W01。

## Testing and validation

| Requirement | Setup and observation | Failure condition | Where | Status |
|---|---|---|---|---|
| IB-04、IB-05 | 同一个 `tool_call_id` 重发 `inbox.ask`；已有 10 个待处理事项时再创建；两个 Project 交错创建 | 出现第二个事项；第 11 个被创建；上限算到了别的 Project | PostgreSQL 集成测试 | planned |
| IB-13、IB-24 | 两个连接同时 `answer`；`answer` 与 `inbox.withdraw` 并发 100 轮；同一 `client_request_id` 重试 | 两次都成功；输入队列有两条；重试返回 409；撤回后仍写入了输入 | PostgreSQL 集成测试 | planned |
| IB-12 | 所有节点离线时回答；Project 暂停时回答，之后恢复 | 回答失败；暂停期间启动了运行；恢复后没有处理 | 集成测试，模型替身 | planned |
| IB-18 | 用一组夹具调用 Runtime 的检查：未知组件、缺少参数、`Query`、`Mutation`、`@Run`、内置函数、`http` 链接、未声明的 `@Answer`、超过 32 KiB、截断的程序 | 任一夹具通过检查；错误信息超过 4 KiB 或缺少所在语句 | Runtime 单元测试 | planned |
| IB-18 | 检查失败的调用经 `call_tool` 送达 | 创建了事项；没有 `is_error` 结果 | 进程测试，模型替身 | planned |
| IB-15、IB-16 | 渲染包含 `@Answer`、`@OpenUrl`、`@ToAssistant` 的内容并点击；渲染一段绕过检查、含 `Query` 的内容 | `@Answer` 直接提交了；`@ToAssistant` 发出了消息；打开了非 https 链接；发出了 `Query` 请求 | Web 单元测试 | planned |
| IB-19 | 用旧版组件库生成的内容在删除一个组件后渲染；组件渲染时抛错 | 整段内容空白；选项不可用；单独一行的组件没有原位占位 | Web 单元测试 | planned |
| IB-19 | 修改组件 schema 但不增加 `library_version` | CI 通过 | CI | planned |
| 第 5 节 | 构建 `dist` 后扫描第三方地址；开发模式启动页面 | 出现 `cdn.jsdelivr.net`；开发模式请求了 jsDelivr | 现有 webui 测试；Web E2E | planned |
| IB-08 | 两个浏览器页面打开同一事项，在一个页面回答；断开另一个页面的 WebSocket 后再回答 | 5 秒内另一个页面没有更新；重连后仍显示旧状态 | Web E2E | planned |
| IB-20 | 任务结果包含 `root:` 引用和其他引用；预览时节点离线 | 其他引用出现预览按钮；离线时显示了旧内容 | Web E2E | planned |
| IB-21、IB-22 | 选中 10 KiB 文字并选择「问 Project Agent」，修改后发送 | 未截短；发送前没有经过输入框；发出的内容和输入框不一致 | Web E2E | planned |
| IB-25 | 归档有 3 个待处理事项的 Project | 有事项仍是 open；未发送的推送仍被发出 | PostgreSQL 集成测试 | planned |
| IB-31 | 推送服务替身依次返回 201、410、503、400；发送前事项被回答 | 410 后订阅仍在；503 没有重试；400 被重试；已回答的事项仍被推送 | Go 单元测试，HTTP 替身 | planned |
| 第 7 节 | 提交 `http`、IP 地址、非 443 端口、不在允许列表的 `endpoint`；替身返回 302 | 被接受；跟随了重定向 | Go 单元测试 | planned |
| IB-29、IB-30、IB-32 | macOS 上的 Chrome 和 Safari 开启通知后创建事项、点击通知、在另一个浏览器回答 | 没有收到通知；点击没有打开事项；打开页面后旧通知仍在；Safari 撤销了权限 | 真实浏览器手工验收 | planned |
| IB-A01 | 真实 Runtime、最便宜的订阅模型、三台设备 | 见 PRODUCT 验收表 | 实机 | planned |

## Open questions

- 任务详情页由 T22 先做，还是由 IB-W03 补上需要的部分。影响 IB-W03 的范围，不阻塞本设计。
- 同步 5 秒的预算是提案值，依赖 `/api/v1/events`。WebSocket 断开时页面只在重连和重新获得焦点时刷新；需要更强的保证时再加轮询。
