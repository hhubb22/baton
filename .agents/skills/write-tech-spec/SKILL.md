---
name: write-tech-spec
description: "基于现有代码编写或修订技术设计（TECH.md）；用于跨模块架构、数据模型、协议接口变更或重要实现取舍。"
license: MIT
---

# Write Tech Spec — 技术设计

## Goal

基于代码库真实结构，编写高信噪比的技术设计文档（`specs/<feature>/TECH.md`）。写作规范见 [technical-writing.md](references/technical-writing.md)，通用红线见 [operating-contract.md](references/operating-contract.md)。

## Workflow

1. **调查现有代码**：阅读相关包、数据表迁移、接口定义与测试方式，优先复用既有机制。
2. **编写或原地更新 `TECH.md`**：参照 [TECH.template.md](assets/TECH.template.md) 与 [example-tech.md](references/example-tech.md)，用表格、列表和简图写清：
   - **架构与模块职责**：受影响的进程、包路径及调用关系。
   - **数据模型与状态不变量**：Schema 变更、状态迁移表、锁顺序、幂等与崩溃恢复机制。
   - **接口与协议契约**：API / IPC / CLI 的请求、响应与错误码。
   - **验证策略**：遵循测试金字塔，明确哪些逻辑用单元测试/确定性回放覆盖，哪些主链路用集成或端到端测试验证。

## Guardrails

- **文档即当前架构，严禁追加实现流水账**：更新已有 `TECH.md` 时，直接原地修改对应设计章节以反映当前系统状态，**严禁**在文档头部或正文中追加「当前已实现 PS-xxx...」或「2026-xx-xx 修订」等历史段落。
- **不与 `PRODUCT.md` 重复**：通过需求编号（如 `R-01`）关联产品规格，不重复抄写用户故事。

## Stop Rules

- 交付 `TECH.md` 草案与关键技术取舍后停下，等待用户审阅批准。
