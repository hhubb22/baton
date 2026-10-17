# 差异范围

记录用户想检查的对象和你实际检查的范围；优先沿用清楚的指示。

- 精确提交区间的净变化用 `git diff <base> <head>`；指定单提交时查看其提交差异。不要把任意 commit 解释成 merge-base。
- 分支相对共同祖先的变化才使用 `git diff <base>...HEAD`，同时记录解析后的 base、HEAD 和 merge-base。
- “当前修改”一般包含工作区状态。先看 `git status --short`；`git diff HEAD` 涵盖已跟踪文件的暂存与未暂存净变化，未跟踪文件需按范围另读。需要区分层次时分别看 `git diff --cached` 与 `git diff`。
- 没有提交的仓库使用实际可用基线；不要让 HEAD 不存在导致跳过新增文件。
- PR 使用平台返回的实际 base/head 和 changed files；下载或读取失败时说明，不用本地相近分支冒充。

只有歧义会改变检查结果且现有上下文无法解决时才询问。空 diff 要解释范围；无代码差异不代表全部未跟踪产物已审查。

尊重本地无关变更，不执行 reset、checkout 覆盖、stash 或提交来获取“干净状态”。
