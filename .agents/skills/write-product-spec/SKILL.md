---
name: write-product-spec
description: "编写或修订特性的外部行为规格（PRODUCT.md）；用于用户可见行为、CLI/API 契约、边界条件或验收标准需要书面约定时。"
license: MIT
---

# Write Product Spec — 产品行为规格

## Goal

定义清晰、可检验的外部系统行为规格（`specs/<feature>/PRODUCT.md`）。写作规范见 [technical-writing.md](references/technical-writing.md)，通用红线见 [operating-contract.md](references/operating-contract.md)。

## Workflow

1. **核对上下文**：读取已确认的需求与现有代码/文档，明确本次新增或变更的外部行为。
2. **编写或原地更新 `PRODUCT.md`**：参照 [PRODUCT.template.md](assets/PRODUCT.template.md) 与 [example-product.md](references/example-product.md)，重点写清：
   - **目标与非目标（Goals & Non-goals）**
   - **核心概念与外部契约**：用户/调用方可见的输入、输出、状态流转与权限边界（优先用表格呈现）。
   - **需求条目（Requirements）**：采用「触发条件 → 系统行为 / 可观察结果」格式，每条规则具备唯一编号（如 `R-01`）。
   - **验收标准（Acceptance Criteria）**：正常、边界与错误场景的可验证条件。

## Guardrails

- **只写外部可观察行为**：不写内部函数名、数据库表结构或具体代码实现细节（这些属于 `TECH.md`）。
- **文档反映当前状态，严禁写工单流水账**：修订已有 `PRODUCT.md` 时，直接原地修改对应章节并删除过期条款，严禁追加按工单排列的历史变更记录。

## Stop Rules

- 交付 `PRODUCT.md` 草稿与待决问题（Open Questions）后停下，等待用户审阅批准。
