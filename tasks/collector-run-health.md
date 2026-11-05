---
title: 采集健康：让每日运行自己报一步没跑成
status: doing
tags: [CI, 工作流, 采集器, 前端]
updated: 2026-11-03
---
# 采集健康：让每日运行自己报一步没跑成

板块上每个数字都能说自己多新，没有一个能回答「今天的采集跑完了吗，中间死没死一步」。`continue-on-error: true` 把那件事从数据里擦掉了：被咽下去的失败与「这块板子今天没更新」在载荷里长得一模一样。所以加一份只描述运行自身的记录。

## 验收

- [x] `scripts/record_run.py` 读 `toJSON(steps)` 与 `job.status`，写 `data/runs.json`；状态只有 `ok` / `partial` / `failed` / `unknown` 四种，没有步骤映射时是 `unknown`，**不默认成 `ok`**。
- [x] 读 `outcome` 而不是 `conclusion`：`continue-on-error` 下面的失败，`conclusion` 是 `success`，`outcome` 才是 `failure`——读错这个字段，这份文件就对它存在的理由说「没问题」。
- [x] 工作流里 `id:` 加到 15 个被记录的步骤，`Record this run` 排在 `Commit historical snapshots` **之前**（这份记录只有靠那次提交才进仓库，排在后面就永远描述不了发布它的那次运行），带 `if: ${{ !cancelled() }}`；提交循环的清单加上 `runs`。
- [x] `covers` 写明范围：采集与索引这一段，**构建与 Pages 部署排在提交之后，不在这里**——这行绿不等于站点更新了。步骤清单里故意没有 `Build`／`Deploy`。
- [x] 前端 `MO.data.loadRuns()` / `runHealth()` + `MO.render.renderRunHealth()` 画在 hero 下面一行；`loadAll` 抛错的兜底分支也画它（主数据读坏了，这行恰恰最有用）。
- [x] 读不到就是读不到：「这台浏览器没读到运行记录——读不到不等于采集失败」，原因进 `title`；空文件说「记录文件还没有任何运行」，两种都不说成采集失败，也不说成 0。
- [x] 数字只走 `MO.format.ageInDays`；`run_number` 缺席时整句「第 N 次」消失，而不是印成「第 — 次」。
- [x] `run_url` 两侧各过一遍：采集端要 https + 合法 `owner/repo` + 纯数字，前端再按 http(s) 白名单；步骤标签一律转义进文本。
- [x] 保留窗口 60 次，按 `(run_id, attempt)` 去重（重跑同一 attempt 是替换），新条目在前，`retention.kept` 说这次留了几条。
- [x] 离线断言（`tests/test_runs.py`）：步骤清单与 `pages.yml` 的 `id:` 一一对应、记录步在提交步之前、`!cancelled()` 在、提交循环里有 `runs`、四种状态推导、去重与保留、`--check` 不落盘、`run_url` 白名单、`SHIPPED_DATA` 含 `runs.json`。
- [x] 前端断言（`tests/test_frontend.js`）：五种句子变体（干净／有失败与没跑到／读不到／空文件／`unknown`）、标签与链接的转义、缺 `run_number` 时子句消失、`renderAll` 真的调到它、主数据读坏时它仍然画。
- [ ] 第一次真实记录要等本卡合进 `main` 之后那次定时运行写出来；在那之前线上页面显示的就是「没读到运行记录」这一句。

## 口径落处

README「采集健康：这次运行自己说了什么」；流程图与文件组织各加一条；`tests/test_ci.py` 继续管工作流自身的四条。

## 不在这张卡里

不把别的载荷的数字搬进这一行（条目数、体积、预算各有 owner）；不给 `data/runs.json` 做页面端的重算——派生只在采集端一次；不顺手升 Pages 那两个 `node20` 动作（见 [[ci-action-bumps]]）。
