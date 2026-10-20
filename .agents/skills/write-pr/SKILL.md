---
name: write-pr
description: "为已有代码修改编写 PR/MR 描述和审核者说明，沿用项目模板并引用验证证据；用于准备合并请求、更新描述或用 HTML 解释改动时。普通 commit message 用项目约定。"
license: MIT
---

# Write PR — 合并请求描述

## Goal

基于真实代码 diff 与实际运行的测试证据，生成清晰、高信噪比的 PR/MR 描述（及按需生成 HTML 导读页）。证据规则见 [evidence.md](references/evidence.md)，通用红线见 [operating-contract.md](references/operating-contract.md)。

## Workflow

1. **核对最終 Diff 与验证结果**：
   - 检查当前分支相对于目标分支的完整 diff 与 commit 列表。
   - 收集已实际执行的构建与测试命令结果。
2. **编写 PR 描述**：
   - 优先沿用仓库已有模板；无模板时使用 [PR.template.md](assets/PR.template.md)。
   - 简明写清：**背景与动机（Why）**、**核心改动（What）**、**验证方式与结果（Verification）**、**影响与回滚风险（Impact）**。
3. **按需生成 HTML 导读（可选）**：
   - 仅当用户明确要求或改动涉及复杂跨模块状态流转时，参考 [html-writing.md](references/html-writing.md) 与 [REVIEW.template.html](assets/REVIEW.template.html) 生成 `REVIEW.html`。

## Guardrails

- 严禁编造未运行的测试结果；未执行的验证项明确标注「未验证」。
- 不要在 Git 仓库跟踪目录中提交临时截图或过程文件。

## Stop Rules

- 交付 PR 描述正文（或在授权下更新远端 PR）后停下。
