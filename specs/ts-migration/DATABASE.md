# 数据库访问方案

中心使用 `@effect/sql-pg@4.0.6` 与 Effect `SqlClient` 执行参数化 SQL，节点使用 `@baton/sqlite`。数据库事务、资源管理、追踪和现有迁移继续使用这一执行层。

Drizzle 是需要查询构造和结果类型推导时的候选。当前中心以显式状态机、持久命令和锁查询为主，引入 ORM 的收益尚不足以抵消另一套表定义与版本维护成本。Prisma 的执行器、生成流程和事务上下文接入成本更高。

## 方案比较

| 维度 | Effect SQL | Drizzle | Prisma |
|---|---|---|---|
| 查询类型 | `sql<T>` 由开发者声明结果；`SqlSchema` 可解码实际结果 | 查询 DSL 从表和投影推导类型；raw SQL 仍需声明或验证 | 生成模型与查询类型；v7 TypedSQL 可为 SQL 文件生成类型 |
| 复杂 PostgreSQL 查询 | 直接使用 CTE、LATERAL、JSONB、`FOR UPDATE OF … SKIP LOCKED` | 可以保留原 SQL，也可只构造 SQL | 可以在事务对象内执行原生 SQL |
| Effect 事务与取消 | 直接使用应用 PgClient、Scope 和事务上下文 | 1.0 RC 的 Effect 驱动复用 PgClient；stable 可以只构造 SQL | 需要单独接入资源与取消，普通 Promise 包装不能证明数据库查询已取消 |
| 迁移 | 沿用根目录 SQL 与共享迁移账本 | 可独立使用查询功能，继续沿用现有迁移 | 可使用外部迁移，但需同步模型或 contract，并指定唯一迁移执行器 |
| 节点 SQLite | 保留 WAL/FULL、串行事务和独立提交核验 | 官方 SQLite Effect 入口要求官方专用 SqliteClient 服务 | 需要额外实现并验证当前提交核验和客户端阻断契约 |
| 采用成本 | 最低，重点加强关键返回结果验证 | 中等，可从少量读取查询开始 | 最高，涉及版本、生成、执行器与事务边界 |

`sql<{ value: Thread }>` 给调用方提供静态类型，不能证明 SQL 实际返回 `Thread`。关键返回值应使用已有 Effect Schema 或 `effect/sql/SqlSchema` 解码。查询构造器的推导也依赖声明的数据库结构；Drizzle 的 `sql<T>` 不执行 runtime mapping。

## Drizzle 与 Effect 4

核查版本为 Drizzle stable `0.45.4`、RC `1.0.0-rc.5`。RC 提供 `drizzle-orm/effect-postgres`，peer 要求 Effect 与 `@effect/sql-pg` ≥4。`make` 从 Context 获取已有 PgClient，查询调用客户端的 `unsafe`，事务委托 `withTransaction`。同一 fiber 的事务上下文中可以混用原生 SqlClient 查询和 Drizzle 查询，无需建立另一个连接池。

stable 可以通过 `.toSQL()` 产生 SQL 和参数，再由现有 PgClient 执行。该路径没有 Drizzle 执行阶段的结果 mapper，日期、JSON、bigint 和自定义类型仍需按实际查询编码与解码。

旧 `@effect/sql-drizzle@0.51.0` 依赖 Effect 3，与当前工作区不匹配。采用 RC 原生接口时需要固定精确版本；采用 stable 构造 SQL 时继续由当前客户端管理执行、事务与取消。

## Prisma 的版本边界

核查时 `prisma` CLI 的 latest 为 `8.0.0-rc.27`，`@prisma/client` 的 latest 为 `7.10.1`，官网默认事务文档已切到 v8。选择时需固定一套已验证兼容的包与版本。

v7 的交互事务通过 `$transaction(async tx => …)` 执行，支持隔离级别、等待与运行超时。TypedSQL 生成需要可连接的数据库，本机 PostgreSQL 可以满足。v8 文档使用 `db.transaction`，允许混合 ORM 与 SQL，但事务配置和嵌套调用行为与 v7 不同；回调内再次调用根 `db.transaction` 会开启独立事务，应传递当前 `tx`。

Prisma 能执行复杂 SQL，也支持外部迁移。当前不采用的原因是整合成本：需要让模型查询与账本 SQL 共用事务，证明 Effect 中断后的查询和连接已正确收尾，并维护模型或 contract 与已有 SQL 约束的一致性。未找到已核实的官方入口可直接复用 Baton PgClient 事务。

## SQLite 的独立约束

`@baton/sqlite` 在外层事务提交前写入随机 token；COMMIT 报错且事务已结束时，独立只读连接核对同一文件的持久 token。匹配时返回原业务结果；核验失败时返回不可重试的 `CommitUnknown` 并阻止后续查询，由 Worker 停止并恢复账本。

更换查询库必须保留这条完整路径，以及嵌套 savepoint、取消保护和 `afterCommit` 行为。官方 SQLite 驱动或普通 ORM 事务不能单独证明满足该约束。当前继续保留自定义适配。

## 本地验证

固定版本原型使用 Node 26.11.1、PostgreSQL 17.11、Effect 4.0.6、TypeScript 6.0.3。验证只使用本机测试库中的连接私有临时表，连接关闭后清理，不调用在线模型或真实业务 API。

| 验证 | 结果 |
|---|---|
| Drizzle RC 与 Effect 4 严格编译 | 通过，依赖内部声明文件使用 `skipLibCheck` |
| 复用 PgClient、PostgreSQL backend PID 与事务 ID | 通过 |
| JSONB insert / returning / select 往返 | 通过 |
| 内层失败只回滚 savepoint，外层成功保留记录 | 通过 |
| 外层失败回滚 Drizzle 写入 | 通过 |
| 事务内 `pg_sleep` 被 100 ms timeout 中断，写入回滚、连接可复用 | 通过 |
| stable 构造 `FOR UPDATE SKIP LOCKED`，交由现有 PgClient 实际执行 | 通过 |
| Prisma 客户端、生成和事务原型 | 未运行，仅核对文档与发布元数据 |

取消验证覆盖单连接事务，不代表所有 multiplex 查询、提交竞争和生产负载都可立即中断。未做性能比较。验证未覆盖生产负载、HTTP 断连到数据库的取消传播或提交结果不确定的故障恢复。

## 来源

- [Drizzle RC 元数据](https://registry.npmjs.org/drizzle-orm/1.0.0-rc.5)、[Effect PostgreSQL 工厂接口](https://unpkg.com/drizzle-orm@1.0.0-rc.5/effect-postgres/driver.d.ts)、[事务实现](https://unpkg.com/drizzle-orm@1.0.0-rc.5/effect-postgres/session.js)。
- [Drizzle SQL 类型说明](https://orm.drizzle.team/docs/sql)、[旧 Effect Drizzle 适配元数据](https://registry.npmjs.org/@effect%2Fsql-drizzle/latest)。
- [Prisma v7 事务](https://www.prisma.io/docs/orm/v7/prisma-client/queries/transactions)、[v7 TypedSQL](https://www.prisma.io/docs/orm/v7/prisma-client/using-raw-sql/typedsql)、[v8 事务](https://www.prisma.io/docs/orm/fundamentals/transactions)。
- Effect 与 PgClient 行为以工作区固定版本的 `node_modules/effect/src/sql`、`node_modules/@effect/sql-pg/src` 为准。
