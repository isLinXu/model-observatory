---
title: 实体注册表浏览器回写
status: done
parent: task-board-canvas
depends: [mo-repo-extraction]
tags: [注册表, 回写]
updated: 2026-11-02
---
# 实体注册表浏览器回写

注册表上线时是只读的：改一条关系要编辑 `entities/<slug>.md` 并提交。等 `MO.repo` 出来，页面就能直接改 front matter 与正文并写回源文件。

## 验收口径

- 推送前用采集器发布的 blob SHA 做基线：远端在索引之后被改过就挡下，给出「重读索引 / 以远端为准 / 明确覆盖」三选，绝不静默覆盖。
- 只写关系与正文，任何数值指标都不进注册表——下载量、star 数仍各自只有一个主人和一个采集时间。
- 回写失败逐条说明原因，页面上已发布的内容不受影响。
