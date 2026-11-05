---
title: 两个 Pages 动作还在 Node 20 上：bump 来了再决定，不盲升
status: proposal
tags: [CI, 工作流, 依赖]
updated: 2026-11-03
---
# 两个 Pages 动作还在 Node 20 上：bump 来了再决定，不盲升

`pages.yml` 的六个动作已全部钉到完整 commit sha（行尾注释保留来源 tag），`.github/dependabot.yml` 开始每周开 bump PR。「钉」是今天做完的，「升」是这张卡要等人拍的板——它改的是部署链路，本地跑不了。

## 等证据是什么

- `actions/configure-pages@v5` 与 `actions/deploy-pages@v4` 的 `action.yml` 里写的是 `using: node20`（今天逐个读 `action.yml` 核对：另外三个是 `node24`，`upload-pages-artifact@v4` 是 composite 动作、没有自己的运行时）。Node 20 正在被 Actions 淘汰，两者的现行 major 分别是 v6 与 v5。
- `ubuntu-latest` 从 2026-10-19 起在数周内逐步切到 Ubuntu 26.04，公告说 2026-11-19 前完成。它改变的是采集器的运行环境（Python、系统工具链版本），不是本站任何一行代码。

## 为什么今天不顺手升

升这两个 major 只能靠一次真实部署验证，而这条链路的失败方式是「Pages 不再发布」——离线套件全绿也证明不了它能跑。所以入口固定成 dependabot 的那份 PR：PR 上跑离线套件 → 合进 `main` 后看一次定时运行把 Pages 部署成功 → 才算完成。`ubuntu-latest` 同理：今天没观察到红，就不替一个还在滚动迁移的标签做决定。

## 别在这张卡里顺手做

不要把 `permissions` 那三行加宽。`tests/test_ci.py` 钉死了它只有 `contents`／`pages`／`id-token` 三个 `*: write`，要加第四行得先说清它干什么、并把它写进 README 的「谁审查这份工作流自己」。
