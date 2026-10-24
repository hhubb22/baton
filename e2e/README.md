# 跨 app 集成测试

`@baton/e2e` 通过声明的 workspace 依赖启动 TypeScript 中心、节点和本地 Worker，验证远程 Thread、Project、数据库中断恢复及 Gateway 报告流控。模型行为使用确定性回放和本地替身。

在仓库根目录运行：

```sh
pnpm test:e2e
pnpm --filter @baton/e2e typecheck
pnpm --filter @baton/e2e lint
```

数据库使用中心的 `testing/database` 夹具，为每个用例创建和清理独立 schema。PostgreSQL 的本地默认值、自动启动及 `BATON_TEST_DATABASE_URL` 配置见[中心验证说明](../apps/server/README.md#验证)。

`pnpm test` 按包依赖顺序包含本包。按改动包筛选时，使用前置省略号包含依赖该包的测试，例如：

```sh
pnpm --filter '...@baton/batond' --workspace-concurrency=1 test
pnpm --filter '...@baton/server' --workspace-concurrency=1 test
```

辅助代码放在 `src/testing/`，跨包源码通过各包的明确导出访问。包内测试继续保留在对应 app；静态转录与数据放入辅助目录中的 `data/`，可执行的 TS、MJS 辅助程序参加 lint 和格式检查。测试使用 package.json 脚本，Vite Task 默认不缓存脚本结果。
