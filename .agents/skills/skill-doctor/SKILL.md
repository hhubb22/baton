---
name: skill-doctor
description: "复盘指定编码会话中的 Agent 行为、skills、工具与开发环境，提出有证据的最小改进；用于误触发、异常停顿、反复失败、工具低效或上下文丢失时。"
license: MIT
compatibility: "正文可独立使用；可选离线会话收集脚本需要 Python 3.10+。"
---

# Skill Doctor — 会话与工作流复盘

## Goal

基于真实会话记录与代码库现状，诊断 Agent 误触发、指令膨胀、工具低效或环境摩擦，遵循「删减优于堆砌」原则提出最小改进方案。通用红线见 [operating-contract.md](references/operating-contract.md)，评估准则见 [rubric.md](references/rubric.md)。

## Workflow

1. **收集证据**：
   - 分析用户指定的会话记录、相关 skill 文件、`AGENTS.md` 或构建/测试脚本（需要离线整理 JSONL 时可使用 [collect_sessions.py](scripts/collect_sessions.py)）。
2. **定位根因（优先做减法）**：
   - 区分四类问题：**指令过长/冲突**（稀释模型注意力）、**缺少阶段门禁**（跳步或死循环）、**工具/环境摩擦**（测试需手动配环境、脚本脆弱）、**机械规则被滥用**（把文档写成流水账）。
   - 能用确定性代码、默认配置或 linter 解决的问题，绝不往 Prompt / Skill 里加长篇文字规则。
3. **输出复盘报告与最小补丁**：
   - 参考 [REPORT.template.md](assets/REPORT.template.md)，列出证据位置、根因分类与具体删改建议（优先删除或精简冗余指令）。

## Guardrails

- 复盘阶段默认不直接改写正式规则文件，除非用户明确要求一并应用改进。
- 报告与导出材料必须脱敏，不得包含任何凭据或私有密钥。

## Stop Rules

- 交付复盘报告（或在用户明确授权下应用精简补丁并验证）后停下。
