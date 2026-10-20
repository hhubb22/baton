---
name: work
description: "按工作流阶段选择并衔接本库 skills；用于推进新特性、重构或缺陷修复，或不确定下一步该用哪个 skill 时。"
license: MIT
---

# Work — 研发主路径路由

## Goal

根据任务复杂度和当前阶段，选择最小必要的工作流步骤，在保证质量的前提下实现低摩擦交付。通用红线见 [operating-contract.md](references/operating-contract.md)。

## Workflow

### 1. 按复杂度分流（避免过度设计）

| 任务规模 | 适用路径 |
|---|---|
| **小型改动 / 明确修复**（单模块、需求清晰） | 直接 `implement-specs`（或 `diagnose-bugs`）→ `code-review` |
| **中型特性**（涉及外部行为或接口变化，单次会话可完成） | `align` → `write-product-spec` / `write-tech-spec`（按需）→ `implement-specs` → `code-review` |
| **大型跨会话特性**（多模块、需拆分子任务分批交付） | `align` → `write-product-spec` → `write-tech-spec` → `to-tasks` → `implement-specs` → `code-review` → `write-pr` |

### 2. 核心 Skills 职责速查

- `align`：复述需求目标、边界与假设，提出阻塞问题供用户确认。
- `write-product-spec`：编写或原地更新 `PRODUCT.md`（外部可观察行为与验收标准）。
- `write-tech-spec`：编写或原地更新 `TECH.md`（架构、数据模型、接口与关键机制）。
- `to-tasks`：将已批准的设计拆分为可独立验证的垂直切片任务（本地清单或 Linear Issue）。
- `implement-specs`：实现代码、编写自动化测试并同步更新长期文档现状。
- `diagnose-bugs`：建立可复现反馈回路，定位根因并补充回归测试。
- `code-review`：审查代码差异的正确性、架构卫生与需求符合性。
- `write-pr`：基于真实 diff 与验证证据生成 PR 描述。
- `issue-tracking`：在声明 `issue` 模式时通过 Linear MCP 同步工单。

## Guardrails

- 读取仓库 `AGENTS.md` 与 `.agents/PROJECT.md`（模板见 [PROJECT.template.md](assets/PROJECT.template.md)）获取验证命令与项目约定。
- 不要为简单改动强行走全套文档与拆卡流程。

## Stop Rules

- **单阶段门禁**：除非用户明确要求连续自动推进多个阶段，否则每完成一个阶段（如对齐、写完规格、拆完任务或完成实现）即交付结果并停下，等待用户确认后再进入下一阶段。
