---
name: to-tasks
description: "把已确认的设计拆成可独立验证的垂直切片任务，标明依赖和验证方式；用于工作跨多个会话或需分批交付时。"
license: MIT
---

# To Tasks — 任务拆分

## Goal

将已获批准的规格与技术设计拆分为粒度适中、可独立验证的垂直切片任务（Vertical Slices）。通用红线见 [operating-contract.md](references/operating-contract.md)。

## Workflow

1. **确认任务承载方式**：读取 `.agents/PROJECT.md`。`local` 模式使用 [TASKS.template.md](assets/TASKS.template.md) 输出本地任务清单；`issue` 模式先在对话中给出任务拆分草案，获用户确认后再调用 `issue-tracking` 写入 Linear。
2. **按端到端垂直切片拆分**：
   - 每个任务必须交付一个可独立运行和验证的增量能力，避免按「只建表 → 只写内部函数 → 最后才接入口」做无法独立验收的水平切分。
   - 控制任务数量与粒度：单次可完成的特性无需强行拆碎；跨会话特性每个任务应能在一轮实施内闭环。
3. **写清每个任务的四要素**：
   - **交付目标**（引用对应 `PRODUCT.md` / `TECH.md` 章节，不重复抄写大段设计）
   - **前置依赖**（Blocked by）
   - **验证方式**（优先单元测试与模块级集成测试，避免每个小任务都要求重跑全量重型 E2E）
   - **验收清单**（`条件 → 可观察结果`）

## Guardrails

- 不要把同一套设计完整复制进每张任务卡，任务描述保持精炼并指向规格章节。
- 未获用户授权前，不得直接在远端工单系统批量创建或覆盖工单。

## Stop Rules

- 输出任务拆分方案后停下，等待用户确认（在 `issue` 模式下，确认后才执行建卡）。
