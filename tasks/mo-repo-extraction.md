---
title: 抽出 MO.repo 写路径
status: done
parent: task-board-canvas
tags: [回写, 前端]
updated: 2026-11-02
---
# 抽出 MO.repo 写路径

站点现在只有一处能写仓库：`site/templates.js` 里的凭据与 Contents API 传输。把它上提成 `MO.repo`，模版库、注册表回写与任务看板共用同一条路径。

## 验收口径

- Token 只进 `sessionStorage`，只发往 `api.github.com`，永不出现在任何 JSON 里。
- 未配置 Token 时浏览、复制、导出草稿照常，只有写回禁用并说明缺什么。
- 模版库行为不变（既有用例全部保持通过），批量推送逐条回显成功与失败。
