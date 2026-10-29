# 遥测

`@baton/telemetry` 为中心、batond、Worker、agent-host 和 Project Runtime 提供 Effect OTLP/HTTP traces、logs 和 metrics。中心未配置地址时不连接外部采集端；节点可能向本机接收端发送后丢弃。进程从自己的构建元数据报告版本和提交，设备进程附带节点 ID。

设置 `OTEL_EXPORTER_OTLP_ENDPOINT` 可导出三种信号；`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`、`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` 和 `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` 可分别指定完整地址。认证头使用 `OTEL_EXPORTER_OTLP_HEADERS`，环境属性使用 `OTEL_RESOURCE_ATTRIBUTES`；`OTEL_TRACES_EXPORTER=none`、`OTEL_LOGS_EXPORTER=none` 和 `OTEL_METRICS_EXPORTER=none` 可分别关闭导出。指标默认每 30 秒导出，可用 `OTEL_METRIC_EXPORT_INTERVAL` 覆盖。

中心用上述配置导出自身数据并转发节点和网页数据，`BATON_TELEMETRY_FORWARD=off` 关闭转发。节点默认使用受令牌保护的本机接收端，中心未允许转发或连接断开时丢弃批次。设备本地出现 `OTEL_EXPORTER_OTLP_*` 配置时不启动该接收端；没有本地地址时也不会导出。

三种信号共享每进程两个并发导出名额，每次最多等待三秒，失败或超限丢弃该批并暂停 60 秒。同一地址的不同信号设置了不同超时时，使用较短上限。导出和资源字段经过白名单过滤，不导出正文、路径、凭据、原始错误或堆栈；用户指定的模型 ID 原样记录。完整字段、采集范围和验证边界见[可观测性设计](../../specs/observability/TECH.md)。
