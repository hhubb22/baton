# Baton

员工使用部署管理员分配的本地账号登录 Coordinator，退出，并查询本人身份。初始口令只能使用到员工完成更换为止。

本目录目前包含这条路径的构建、迁移、HTTP 接口和测试。节点注册、任务和管理员网页不在这里。

## 运行要求

- Go 1.27
- PostgreSQL 17

## 配置

| 变量 | 作用 |
|---|---|
| `BATON_DATABASE_URL` | Coordinator 的 PostgreSQL 连接串 |
| `BATON_DB_SCHEMA` | 数据所在 schema，默认 `public` |
| `BATON_HTTP_ADDR` | 监听地址，默认 `127.0.0.1:8080` |
| `BATON_ALLOWED_ORIGINS` | 逗号分隔的 https Origin。`serve` 必填，写操作必须匹配其中一项 |
| `BATON_SESSION_TTL` | 会话有效期，默认 `12h`，允许 `5m` 到 `168h` |
| `BATON_TLS_CERT_FILE` | 与 `BATON_TLS_KEY_FILE` 同时设置时，进程直接提供 TLS |
| `BATON_TLS_KEY_FILE` | TLS 私钥文件 |

会话 Cookie 名为 `baton_session`，固定带 `Secure`、`HttpOnly` 和 `SameSite=Strict`。进程监听 HTTP 时也保持这些属性。浏览器只在 HTTPS 请求里送回该 Cookie；入口代理终止 TLS 时，浏览器看到的来源仍是 HTTPS。

## 命令

```text
go build -o bin/coordinator ./cmd/coordinator
```

```text
BATON_DATABASE_URL=postgres://127.0.0.1:5432/baton ./bin/coordinator migrate
```

```text
BATON_DATABASE_URL=postgres://127.0.0.1:5432/baton ./bin/coordinator admin employee create --username alice --display-name "Alice"
```

```text
BATON_DATABASE_URL=postgres://127.0.0.1:5432/baton ./bin/coordinator admin employee reset-password --username alice
```

```text
BATON_DATABASE_URL=postgres://127.0.0.1:5432/baton BATON_ALLOWED_ORIGINS=https://baton.example ./bin/coordinator serve
```

创建和重置把一次性口令写到标准输出，只显示这一次。数据库保存 Argon2id 摘要。标准错误和 HTTP 日志不记录口令、会话令牌或 CSRF 令牌。不要把标准输出并进普通运行日志。

`serve` 在迁移完成前拒绝启动。

## 会话

接口都在 `/api/v1` 下。写操作要求 `Origin` 属于 `BATON_ALLOWED_ORIGINS`。已登录的写操作还要求请求头 `X-CSRF-Token` 与登录响应里的 `csrf_token` 一致。服务端只保存会话令牌和 CSRF 令牌的 SHA-256。

`POST /login` 接收 JSON：

```json
{"username":"alice","password":"..."}
```

成功时设置会话 Cookie，并返回本人身份、`csrf_token` 和 `expires_at`。正文不包含会话令牌。账号或口令不正确时返回 `invalid_credentials`，不说明是哪一项错了。

`GET /me` 凭 Cookie 返回本人身份和会话到期时间。

`POST /logout` 使当前会话在数据库中失效，并清除 Cookie。

`POST /me/password` 接收：

```json
{"current_password":"...","new_password":"..."}
```

成功后旧口令失效，该员工的全部会话失效，需要用新口令重新登录。新口令至少 12 个字符，最长 128 个字符，不能包含控制字符或首尾空格，也不能与用户名或当前口令相同。

`GET /employees/{id}` 只返回当前会话对应的员工。其他员工标识返回 403，响应里没有对方的资料。

管理员创建或重置的账号，`must_change_password` 为 `true`。员工登录后调用更换口令接口，完成后该标志变为 `false`。

错误响应包含 `code`、`message` 和 `request_id`。

本地账号的用户名以小写字母开头，后续可以是小写字母、数字、点、下划线和连字符。认证模块保留 `Directory.FindExternal`，用于以后按已核实的外部主体查找员工。当前没有外部登录入口，这个查找本身不创建会话。

## 测试

集成测试读取 `BATON_TEST_DATABASE_URL`，只连接这个 PostgreSQL，并在其中创建临时 schema。未设置该变量或连接失败时，测试失败，不会改用模拟数据库。

```text
go test ./...
go vet ./...
```

登录、退出、身份查询、CSRF 和 Origin 的通过路径使用本地 TLS 服务，并把测试证书放进客户端信任池。明文 HTTP 测试确认响应仍带 `Secure` Cookie：按正式 Cookie 规则、不把环回地址当作安全来源的客户端不会在明文请求里带回它。CSRF 和 Origin 检查在两条路径上都生效。
