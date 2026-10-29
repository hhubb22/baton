# ClickStack 仪表盘与告警

`dashboard.json` 和 `alerts.json` 是按 ClickStack 外部 API 结构编写的模板。它们使用默认 OTLP Map 列结构；实际部署可能使用不同数据库、表名或 JSON 列，先通过 MCP 查看 source 与列结构，再调整表达式。模板中的 `__TRACE_SOURCE_ID__`、`__LOG_SOURCE_ID__`、`__METRIC_SOURCE_ID__`、`__CONNECTION_ID__` 和 `__WEBHOOK_ID__` 必须替换为当前团队的实际 ID。不要把 key 写进模板或提交到仓库。

仪表盘覆盖 Turn 首输出 p50/p95、完成率、积压、断线恢复、数据库耗时、账本占用、Project Run 结果与模型用量。按版本分组的结果可以比较不同进程的版本。模型用量缺失单独计数，不当作零。

告警模板分别以等待超过 3600 秒、账本参考预算比例超过 0.8、最近一小时 Turn 完成率低于前一天同一小时的 80% 为初始条件。前日无数据或完成率为零时，比例为空。账本比率只是观察值，当前不会阻止创建 Thread；阈值和通知渠道由部署者按实际情况调整。

模板采用 [ClickStack 外部 API schema](https://raw.githubusercontent.com/hyperdxio/hyperdx/refs/heads/main/packages/api/openapi.json) 的 dashboard 和 inline alert 结构。替换占位符后，先将 dashboard 提交给 `POST /api/v2/dashboards/validate` 检查，再通过 `POST /api/v2/dashboards` 创建；按部署版本的 API 和数据源检查每条 alert 的 SQL 与窗口，再通过 `POST /api/v2/alerts` 创建。Raw SQL 告警使用时间过滤及间隔宏；表名 `otel_traces` 应按实际部署修改。配置 Webhook 或创建告警会产生外部通知，由部署者手动执行。模板未连接真实 ClickStack，不能视为已验证导入、查询或告警触发。
