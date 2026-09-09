---
name: code-review
description: Review the current git changes and report issues, risks, and suggestions
---

# Code Review

审查当前仓库的未提交变更：

1. 运行 `git diff HEAD` 获取当前改动
2. 按以下维度审查：
   - 正确性：逻辑错误、边界条件
   - 安全性：注入、凭据泄露、权限问题
   - 性能：明显低效的查询或循环
   - 风格：与仓库既有约定的一致性
3. 输出结构化审查报告：问题清单（严重度 + 位置 + 建议）
