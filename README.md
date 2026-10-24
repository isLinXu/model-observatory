# Model Observatory · @gatilin

一个**直接托管到 GitHub Pages** 的 Hugging Face 模型与数据集下载统计看板，并附带类 Google Scholar 的公开学术档案板块、社交平台粉丝数板块与 GitHub 账号/仓库看板。静态前端，无后端服务器和前端密钥；页面打开时会通过 Hugging Face 公共 API 自动分页读取最新公开模型清单，新上传模型无需等待每日采集即可出现；GitHub Actions 每日自动抓取你的 **全部公开模型与数据集**、**公开 Google Scholar 档案**、**各平台公开粉丝数**、**GitHub 账号与公开仓库**并提交历史 JSON，同时重新部署网站。

支持：模型排行、单模型详情、总体趋势、最近 30 天活跃下载、历史累计、相邻快照净变化、7/30 日净变化、统计下调异常标记、3 模型对比、搜索和 CSV / JSON 导出；数据集板块与模型完全同口径；学术主页展示引用总数、h-index、i10-index、逐年引用分布、每日引用快照与论文列表；社交媒体板块展示各平台粉丝数、平台筛选、时间范围筛选与卡片/表格双视图；GitHub 看板展示粉丝历史趋势、增长量与增长率，以及仓库的名称 / Star / Fork / 语言 / 最近更新时间，支持搜索、排序、语言筛选、**仅自有 / 含 Fork 口径切换**、分页与一键跳转，并可导出 CSV。界面支持**明暗双主题**，默认跟随系统偏好。首次采集仅有当天数据，不伪造历史走势。

**所有实体都带 `url` 字段**：模型、数据集、论文、仓库与项目在列表中点击名称即可在新标签页打开原始页面；链接缺失时优雅降级为纯文本，不产生死链。

**质量保障**：每次 push 与每日定时任务都会先跑完整的 Python 采集测试与 Node.js 前端回归测试，不通过则不采集、不部署。历史快照采用分级留存，避免数据文件无限膨胀（见下文）。

## GitHub CLI 一键发布（无需手动上传文件）

在已安装 [GitHub CLI](https://cli.github.com/) 的电脑上，执行 `gh auth login` 一次，解压本项目 ZIP 后进入项目目录并运行：

```bash
bash deploy_once.sh
```

脚本将读取 GitHub CLI 当前登录的用户，**经终端输入 `publish` 明确确认后**创建一个全新的公开仓库 `hf-model-observatory`，推送源码，配置 GitHub Pages 的 Actions 模式，并触发第一次采集与部署。已存在同名仓库时拒绝覆盖。

如果要指定别的仓库名：`bash deploy_once.sh another-repo-name`。运行完成后访问脚本打印的 Actions 页面查看执行结果；只有 Actions 成功、网站内容更新后才算部署成功。

> 对于 GitHub 组织的政策或分支保护导致的工作流写入失败，需要管理员调整相关设置。脚本不会绕过权限控制。

## 3 步上线

1. 在 GitHub 创建新仓库，例如 `hf-model-observatory`，默认分支使用 `main`。将这个项目的**所有文件（含隐藏的 `.github` 文件夹）**上传到仓库根目录，不要额外套一层目录。
2. 进入仓库 **Settings → Pages → Build and deployment → Source**，选择 **GitHub Actions**。确保 **Settings → Actions → General → Workflow permissions** 允许 GitHub Actions 写入仓库（如有必要，选择 `Read and write permissions`；分支保护规则也需允许 bot 推送快照）。
3. 进入 **Actions → Sync Hugging Face & deploy Pages → Run workflow**，手动运行一次。成功后网站地址为：

   `https://<你的GitHub用户名>.github.io/hf-model-observatory/`

每天 UTC **02:23** 自动采集和部署。GitHub 定时工作流有可能延迟；部分长期不活跃仓库还会自动停用 schedule，届时需要手动恢复。

> **注意：GitHub Pages 网站一般是公开可访问的。** 即使仓库本身设为私有，也不要把密钥、隐私数据或私有模型元数据放入前端或 `data` 目录。当前采集器明确使用未认证 API，只收集公开模型。不需要 `HF_TOKEN`。

### 工作流行为

单个 `.github/workflows/pages.yml` 文件管理所有流程：

```text
GitHub push / 每日定时 / 手动运行
                ↓
Hugging Face API 读取 @gatilin 全部公开模型与数据集
                +
抓取公开 Google Scholar 档案（失败不影响其余流程）
                +
抓取各平台公开粉丝数（失败不影响其余流程）
                +
抓取 GitHub 账号指标与全部分页公开仓库（失败不影响其余流程）
                ↓
更新 data/latest.json、data/history.json、
data/scholar.json、data/scholar_history.json、
data/social.json、data/social_history.json、
data/github.json、data/github_history.json
                ↓
自动提交历史快照到 main
                ↓
复制 site/ + data/ → _site/
                ↓
actions/upload-pages-artifact + deploy-pages
                ↓
             Pages 网站
```

GitHub Actions 使用 `GITHUB_TOKEN` 写入快照，不需要额外配置 GitHub Personal Access Token。因为自动提交由 `GITHUB_TOKEN` 执行不会继续触发新的 push 工作流，故已将采集、提交和部署集成在**同一次工作流运行**中。

## 下载量的准确口径

- 模型总数、模型表格、热门模型与当前下载总量在页面加载时读取 HF 实时公开 API，自动跟随全部分页；实时接口失败或限流时回退到 `data/latest.json`，不会清空页面。历史趋势、7/30 日变化和 CSV 历史导出仍使用每日 UTC 快照，浏览器不会改写历史。
- `downloads`: Hugging Face 官方**滚动近 30 天**下载次数，降低属正常。
- `downloadsAllTime`: 官方历史累计下载数（SDK: `downloads_all_time`），一般应随时间上升，但可能因官方修正而下调。看板保存负变化并标记待核查。
- `上次变化`: 同一模型最近两次**不同 UTC 日期**累计快照之差；如果采集漏天，显示为「上次变化」，而不是伪称 24 小时下载。
- `7日净变` / `30日净变`: 与**恰好** 7/30 天前的 UTC 快照比较；没有基线则显示 `—`，不做插值、不把它当 0。注意“30日净变”不同于“滚动近 30 天下载”。
- 账户趋势：各个采集日当时可见公开模型的指标之和。若新模型加入、旧模型消失/更名，整体趋势变化会受模型集合变化影响；单模型对比更可靠。
- 账户“上次采集以来净变化”只统计两天都存在且累计值可用的模型，避免把新仓库计作当天凭空新增下载。

## 数据集与学术档案口径

数据集与模型使用**完全相同**的 HF 公开 API 口径（`downloads` / `downloadsAllTime`），只是仓库类型不同；`data/history.json` 的每个快照同时保存 `models` 与 `datasets` 两张表。数据集的 `modality` / `languages` 来自仓库标签，仅用于表格展示。

学术档案板块的数据全部来自**公开的 Google Scholar 档案页**：

- 引用总数、h-index、i10-index 取自 Scholar 官方「Cited by」面板，含「全部」与「近 5 年」两列。
- 逐年引用分布取自 Scholar 档案页的官方直方图，**按发表年份**统计，与「全部累计」可能存在小额差异（页面四舍五入）。
- 论文列表、作者、会议/期刊与被引次数直接来自 Scholar 出版物表格。
- 本项目只抓取档案首页可见的论文列表：Google 的 robots 策略允许 `/citations?user=`，但禁止分页参数 `cstart`，因此超过一页的论文不会被抓取，页面会标注「已列出 N 篇 · 存在更多论文」。
- 抓取失败（验证码、页面结构变化、网络问题）**不会中断工作流**：保留上一次成功的快照，前端显示「学术档案暂不可用」并说明原因。学术档案 ID 写在 `.github/workflows/pages.yml` 的 `SCHOLAR_USER_ID`。
- 数据并非独立用户数；并非精确到请求时间或小时的真实下载流。

## 社交平台粉丝数：数据来源与配置方式

社交板块的数据**完全由配置文件驱动**，不写死在代码里。平台清单在 `config/social_sources.json`：

```json
{
  "id": "bilibili",
  "label": "哔哩哔哩",
  "method": "bilibili",
  "handle": "9567749",
  "url": "https://space.bilibili.com/9567749",
  "color": "#ff9db4",
  "enabled": true,
  "hint": "填入 UP 主主页数字 ID（mid）"
}
```

字段含义：

| 字段 | 说明 |
| --- | --- |
| `id` | 平台唯一标识，历史快照以此为键，不要随意更改 |
| `label` | 页面显示名称 |
| `method` | 采集方式，决定调用哪个 fetcher（见下表） |
| `handle` | 账号标识：GitHub 用户名 / B 站 mid / 知乎 url_token / 小红书用户 ID |
| `url` | 平台主页链接，卡片上的「主页 ↗」指向它 |
| `color` | 平台主题色，用于卡片顶部色条与图表曲线 |
| `enabled` | `false` 时该平台显示为「未配置」，不发起请求 |
| `hint` | 可选，未配置时展示给用户的说明文字 |

**新增一个平台的完整步骤**（三步，无需改动前端）：

1. 在 `config/social_sources.json` 的 `sources` 里追加一条，声明 `id` / `label` / `method` / `handle` / `url` / `color`。
2. 在 `scripts/collect_social.py` 的 `FETCHERS` 字典里注册一个同名 fetcher 函数，签名 `fetcher(source: dict) -> dict`，返回 `followers` / `following` / `posts` / `likes` / `detail` / `source` 六个字段。抛 `PlatformError` 即视为该平台本次采集失败。
3. 前端无需任何改动：卡片、筛选 chip、表格行、趋势曲线都是**从快照数据动态生成**的。

### 内置的采集方式

| `method` | 适用平台 | 是否需要登录 | 实现要点 |
| --- | --- | --- | --- |
| `github` | GitHub | 否 | `api.github.com/users/<handle>`，返回 followers / following / public_repos |
| `bilibili` | 哔哩哔哩 | 否 | `api.bilibili.com/x/relation/stat?vmid=<mid>`，返回 follower / following |
| `bilibili_search` | 哔哩哔哩 | 否 | 先用 wbi 签名搜索按昵称反查 mid，再走 `bilibili`；可用 `exact_name` 精确匹配 |
| `zhihu` | 知乎 | **是** | `www.zhihu.com/api/v4/members/<token>`，需要 `ZHIHU_COOKIE` |
| `xiaohongshu` | 小红书 | **是** | 解析主页 `__INITIAL_STATE__` 里的 `user.userPageData.basicInfo`，需要 `XIAOHONGSHU_COOKIE` |
| `manual` | 任意 | 否 | 直接读取配置里的 `followers` 字段，适合没有公开接口的平台手工维护 |

### 各平台账号的填写方法

- **B 站**：`handle` 填主页 URL `space.bilibili.com/<数字>` 里的数字（mid）。想按昵称自动查找可改用 `bilibili_search`，`handle` 填昵称、`exact_name` 填完整昵称。
- **知乎**：`handle` 填个人主页 `zhihu.com/people/<url_token>` 里的标识。知乎接口**必须带登录态**，请把浏览器 Cookie 放进仓库 Secret `ZHIHU_COOKIE`（形如 `z_c0=...; d_c0=...`）。没有 Cookie 时采集会失败并提示。
- **小红书**：`handle` 填 `xiaohongshu.com/user/profile/<id>` 里的 id。同样需要登录态，Cookie 放在 Secret `XIAOHONGSHU_COOKIE`。
- **GitHub**：`handle` 填用户名即可，匿名可采。

### 采集失败时的行为

单个平台失败**不会中断整条工作流**，也不会影响其它平台：

- 该平台状态标记为 `unavailable`，页面显示具体原因（如「知乎要求登录，请在环境变量 ZHIHU_COOKIE 中提供有效 Cookie」）。
- 若之前采集成功过，**保留上一次的粉丝数**并标记为过期（卡片变淡、状态标注），保证趋势曲线不断裂。
- `data/social_history.json` 只记录当天**采集成功**的平台，不会把失败当成 0 写入历史。

### 社交数据的口径

- 粉丝数是**各平台自身的统计口径**，彼此不可直接相加比较（平台对「粉丝/关注」的定义不同），看板的「粉丝总数」仅作量级参考。
- 「近 30 天粉丝净增」= 最新快照粉丝数 − 恰好 30 天前的粉丝数；没有该 UTC 日期的基线则显示 `—`，只汇总两个日期都有有效值的平台。
- 趋势曲线只使用所选平台都有有效值的快照；平台采集失败不会被当成 0，合法的 0 粉丝数仍会保留。
- 「上次采集以来净变化」是相邻两次 UTC 快照之差，负值表示平台统计被回调。
- 采集频率为每日一次 UTC，与下载统计同步。

## GitHub 看板：数据来源与同步策略

GitHub 板块由 `scripts/collect_github.py` 独立采集，输出 `data/github.json`（当前快照）与 `data/github_history.json`（逐日粉丝快照）。

### 数据来源

| 内容 | 接口 | 是否需要凭据 |
| --- | --- | --- |
| 粉丝 / 关注 / 公开仓库数 | `api.github.com/users/<login>` | 否 |
| 全部公开仓库（分页） | `api.github.com/users/<login>/repos?per_page=100&page=N` | 否 |
| GitHub Projects 列表 | `api.github.com/graphql`（`projectsV2`） | **是**，需 `read:project` 权限的 token |

- 账号名写在 `.github/workflows/pages.yml` 的 `GITHUB_LOGIN`，默认 `isLinXu`。
- 仓库采集会自动翻页直到取完（上限 20 页 = 2000 个仓库），因此 400+ 仓库的账号也能完整收录。
- 匿名 REST 调用有 60 次/小时 的 IP 限速；配置 `GITHUB_TOKEN`（仓库 Secret）可提升到 5000 次/小时，同时解锁 Projects 列表。**没有 token 时仓库看板依然完整可用**，只是 Projects 区域不显示。
- Projects 通过 GraphQL 读取，需要带 `read:project` scope 的 Personal Access Token；未配置时该区域整体隐藏，不影响其它内容。

### 两种更新方式

1. **定时自动同步**：每天 UTC **02:23** 由 GitHub Actions 自动采集并重新部署（`schedule` 触发）。
2. **手动触发采集**：在仓库 **Actions → Sync Hugging Face & deploy Pages → Run workflow** 手动运行一次即可立刻重新采集并部署。
3. **页面内手动刷新**：GitHub 板块右上角的「↻ 手动刷新」按钮会**绕过浏览器缓存**重新拉取已发布的 `data/github.json`。由于站点是纯静态的，这个按钮刷新的是「当前线上快照」；要真正重新抓取上游数据，仍需走上面第 2 条的工作流手动触发。刷新成功后会提示快照时间，失败则保留原数据并提示原因。

### 采集失败时的降级行为

- 抓取异常（限流、封禁、网络中断）**不会中断整条工作流**，`continue-on-error: true` 保证其它板块照常采集与部署。
- 失败时**保留上一次成功的快照**，`status` 标记为 `stale` 并记录具体原因；页面在板块顶部显示提示条（信息级），数据区继续展示上次的仓库列表与粉丝数。
- 只有当 GitHub 完全返回零个公开仓库时，采集器才拒绝覆盖已有快照，避免异常响应把看板清空。
- `data/github_history.json` 只在采集成功时写入当天快照，粉丝趋势曲线因此不会因一次失败而断裂。

### 仓库统计口径：Fork 默认不计入

`is_fork` 字段在采集时即已保存，但看板**默认只统计自有仓库**，与 GitHub 个人主页显示的仓库数一致：

| 口径 | 仓库数 | Star | Fork |
| --- | --- | --- | --- |
| **仅自有**（默认） | 192 | 2,047 | 272 |
| 含 Fork | 431 | 2,177 | 279 |

原因是 fork 仓库的 Star 属于原作者，把它们计入会让「公开仓库」与 Star 总数同时失真（当前账号 431 个仓库中有 239 个是 fork，占 55%）。工具栏的「仅自有 / 含 Fork」开关会同步切换 **KPI、语言分布、高星榜、表格、CSV 导出**的全部数字，KPI 下方的「已排除 N 个 fork」会说明差异来源。搜索「yolo」时两种口径分别命中 9 与 18 条，可用来直观对比。

### 看板功能

- **粉丝趋势**：KPI 显示当前粉丝数、较上次快照的增长量（`+12`）与增长率（`+3.59%`），并绘制逐日历史折线。
- **仓库浏览**：表格列出仓库的名称、Star、Fork、语言与最近更新时间，可按「最近更新 / Star / Fork / 名称」四种方式排序，按语言下拉筛选，按名称、描述、话题或语言关键词搜索，每页 12 条分页浏览。
- **高星仓库 TOP 8** 与 **仓库语言分布** 两个概览面板。
- **一键跳转**：每个仓库名称都是指向 GitHub 原始页面的链接，在新标签页打开；缺少 `url` 的条目降级为纯文本，不生成指向 `#` 的死链。
- **CSV 导出**：导出当前筛选结果，含 `url` 列。

## 模版库：Skill 与 Prompt 的保存与同步

站点的「模版库」栏目用于集中保存可复用的 Skill 定义与 Prompt 模版，并把它们同步回 GitHub。**仓库中的 Markdown 是唯一事实源**，看板只是它的索引视图。

### 目录与文件格式

```
templates/
  skills/<slug>.md      # Skill 定义
  prompts/<slug>.md     # Prompt 模版
```

`<slug>` 只允许小写字母、数字与单个连字符 / 下划线（因为它同时是 GitHub 的路径片段）。每个文件以 frontmatter 描述元数据，正文原样保存：

```markdown
---
name: 代码审查
description: 以最小 diff 为目标审查一段改动。
category: 工程
tags: [代码审查, 协作]
version: 2.0.0
author: gatilin
---

# 代码审查

正文从这里开始……
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | 否 | 缺省时回退为 `<slug>` |
| `description` | 否 | 卡片副标题 |
| `category` | 否 | 单值分类，用于 KPI 说明 |
| `tags` | 否 | 支持 `tags: [a, b]` 与 `- a` 两种写法 |
| `version` / `author` | 否 | 仅展示 |

缺少 frontmatter 的文件也能被索引，只是没有元数据。

### 采集与本地预览

```bash
python scripts/collect_templates.py              # 只读本地目录，不访问网络
python scripts/collect_templates.py --repo owner/name --branch main
python scripts/build.py && python scripts/serve.py --port 8080
```

产出 `data/templates.json`（当前索引，含完整正文）与 `data/templates_history.json`（每日一份，用于「模版库规模趋势」图）。目录不存在时标记为 `unavailable` 并保留上一次快照，不会让看板空白。

### 从页面推送回 GitHub

栏目底部的「同步到 GitHub」面板提供完整回写链路：

1. 新建 / 编辑模版 → 草稿先存在浏览器 `localStorage`，右侧实时预览将要写入的文件内容；
2. 「保存并推送到 GitHub」→ 通过 Contents API 写入 `templates/{skills,prompts}/<slug>.md`（已存在时自动带 `sha` 覆盖）；
3. 推送成功触发 GitHub Actions，重新采集索引并部署，页面的模版列表随之更新。

**Token 约定**：需要一个 **fine-grained personal access token**，只勾选目标仓库的 `Contents: Read and write`。Token 仅保存在当前标签页的 `sessionStorage`，只发送给 `api.github.com`；关闭标签页后由浏览器清除。旧版本保存在 `localStorage` 的 Token 会在下次打开页面时迁移到会话存储并删除持久副本。本站是纯静态页面，没有后端代理；在公共电脑上仍应在使用后点「清除」。

未配置 Token 时模版库仍可完整浏览、复制与导出草稿，只有写回被禁用——面板会明确提示缺什么，不会静默失败。

### 采集失败时的行为

| 情况 | 行为 |
| --- | --- |
| `templates/` 目录不存在 | 标记 `status: unavailable`，保留上一次索引 |
| 单个文件无法读取或文件名非法 | 跳过该文件并在日志中提示，其余正常索引 |
| 正文超过 20000 字符 | 截断后发布并置 `truncated: true`，`bytes` 仍记录真实体积 |
| 未配置 Token 就点推送 | 面板与toast 提示「请先填写 GitHub Token」，草稿保留 |
| GitHub 返回 401/403/422 | 显示 GitHub 的错误原文，不丢失已保存的草稿 |

## 历史快照的保留策略

每日快照会随时间线性增长，若不做处理，`data/history.json`（139 个模型 × 每日）一年后可达数 MB，且首屏每次都要全量下载。因此采集器在写入时做**分级留存**：

| 文件 | 策略 | 说明 |
| --- | --- | --- |
| `data/history.json` | 近 400 天日粒度，更早按周聚合 | 周桶取该周的均值而非末值（下载计数可正可负，均值更能反映净变化），带 `granularity: "weekly"` 与 `days` 字段 |
| `data/github_history.json` | 保留最近 1100 天 | 每条快照仅 4 个整数，体积可忽略，只做上限不做降采样 |
| `data/scholar_history.json` | 保留最近 1100 天 | 同上 |

周桶以该周**最后一天**为日期戳，并丢弃跨越保留边界的桶，保证日期序列严格递增且不与日粒度段重叠。历史文件的读取端无需改动——旧快照与周桶都是相同的 `{id: [累计, 滚动30天]}` 结构。

## 元数据的 url 字段约定

四类实体统一使用 `url` 作为「可一键直达的外部链接」字段，存储位置与可选性如下：

| 实体 | 存储位置 | 字段名 | 取值 | 可选性 |
| --- | --- | --- | --- | --- |
| 模型 | `data/latest.json` → `models[]` | `url` | `https://huggingface.co/<owner>/<repo>` | 可选，缺失为 `null` |
| 数据集 | `data/latest.json` → `datasets[]` | `url` | `https://huggingface.co/datasets/<owner>/<repo>` | 可选，缺失为 `null` |
| 论文 | `data/scholar.json` → `papers[]` | `url` | Scholar 引用页链接（`cited_by_url` 为被引检索链接） | 可选，缺失为 `null` |
| 仓库 | `data/github.json` → `repositories[]` | `url` | `https://github.com/<owner>/<repo>` | 可选，缺失为 `null` |
| 项目 | `data/github.json` → `projects.items[]` | `url` | GitHub Projects 页面地址 | 可选，缺失为 `null` |
| 模版 | `data/templates.json` → `templates[]` | `url` | 仓库内 Markdown 源文件地址 | 必填，由 `path` 生成 |

约定细节：

- 字段名统一为 `url`（不使用 `homepage` / `link` 等别名），前端只认这一个名字。
- **URL 始终是可选的**：数据源无法提供链接时写入 `null`，前端渲染为不可点击的纯文本（`<span class="model-link-plain">`），不会生成指向 `#` 的死链。
- 模型与数据集的 `url` 由采集器根据仓库 ID **自动生成**（`scripts/collect.py` 的 `entity_url()`），因此只要仓库 ID 正确，链接必然有效。
- 前端表现：模型表的名称按钮打开站内详情弹窗，旁边附带一个 `↗` 外链图标直达 Hugging Face；数据集与仓库的名称本身就是外链；论文标题为外链。全部使用 `target="_blank" rel="noopener noreferrer"`。

### 向后兼容

- `data/latest.json` 与 `data/history.json` 的 `schema_version` 从 2 升到 **3**，新增 `url` 字段。**读取端同时接受 1 / 2 / 3**（`site/data.js` 的 `supported` 数组），旧数据文件无需迁移即可正常展示。
- 历史快照 `data/history.json` 内部仍保持紧凑的 `{id: [累计, 滚动30天]}` 结构，**不在历史里写 url**——url 只属于 `latest.json` 中的实体记录，这样既保持了旧读取端的兼容性，也让历史文件体积不变。
- 采集器遇到 v1 / v2 的历史文件会自动迁移到当前 schema（`migrate_history()`），迁移只补齐 `datasets` 键，不改变既有数值。

## 明暗主题

所有颜色都以 CSS 变量定义在 `site/style.css` 顶部：`:root` 为深色，`[data-theme="light"]` 为浅色，两套主题使用**同一组变量名**，因此新增组件只要引用变量就自动适配两种主题。

- 顶栏右侧的 ☀ / ☾ 按钮切换主题，选择结果写入 `localStorage` 的 `mo-theme`，刷新后保持。
- 首次访问（无存储记录）跟随系统的 `prefers-color-scheme`。
- 图表的 SVG 描边、网格线与坐标轴文字同样使用变量，不会出现「深色文字画在浅色图上」的割裂感。

## 在电脑本地预览

```bash
python -m pip install -r requirements.txt

# 采集四类数据（都会实际访问网络）
python scripts/collect.py --author gatilin
python scripts/collect_scholar.py --user oTYM_I8AAAAJ
python scripts/collect_social.py --config config/social_sources.json
python scripts/collect_github.py --login isLinXu

# 模版库只读本地目录，不访问网络
python scripts/collect_templates.py

# 构建静态站点并启动本地预览
python scripts/build.py
python scripts/serve.py --port 8080
```

访问 <http://localhost:8080/>。

> 用 `scripts/serve.py` 而不是 `python -m http.server`：标准库的单线程服务器会在第一个浏览器标签页的 keep-alive 连接上阻塞第二个标签页，导致后续页面加载到空数据。

采集命令会实际访问 Hugging Face、公开的 Google Scholar 档案页和各平台接口；如果网络不通，可直接预览 `site` 文件，但没有数据时网页会显示等待首次采集。日后运行 `python scripts/collect.py` 将更新同一 UTC 日期的快照（同一天内重复运行会替换当天快照），不会导致同一天被算成多个采样点。

只采集某一个平台可以加 `--only`：

```bash
python scripts/collect_social.py --only github bilibili
```

### 运行测试

```bash
PYTHONPATH=. python -m unittest discover -s tests
node --test tests/test_frontend.js
```

Python 套件覆盖数据集转换、历史迁移、url 字段生成、Scholar 解析、社交配置校验、各平台降级路径与小红书状态解析、GitHub 仓库转换与降级逻辑。Node.js 套件覆盖社交净增基线、缺失平台处理、趋势范围及辅助数据加载隔离；全部离线运行，不访问网络。

`data/latest.json` 保存最新模型与数据集清单及对应数值，`data/history.json` 保存逐日快照。历史格式：

```json
{
  "schema_version": 2,
  "author": "gatilin",
  "updated_at": "2026-10-21T02:23:00Z",
  "snapshots": [{
    "date": "2026-10-21",
    "captured_at": "2026-10-21T02:23:00Z",
    "models": {"gatilin/example-model": [1200, 420]},
    "datasets": {"gatilin/example-dataset": [800, 120]}
  }]
}
```

数组 `[1200,420]` 依次为 `[downloads_all_time, downloads_rolling_30d]`。`null` 表示 API 未提供数据，而不是 0。`schema_version` 1 表示只含模型，2 增加数据集，3 为实体记录增加 `url` 字段；采集器会自动迁移旧版本。以上仅是示例数据，不包含在正式仓库的首日页面中。

`data/scholar.json` 保存最新的学术档案，`data/scholar_history.json` 保存逐日的引用、h-index、i10-index 与论文数快照：

```json
{
  "schema_version": 1,
  "profile_id": "oTYM_I8AAAAJ",
  "updated_at": "2026-10-21T02:23:00Z",
  "snapshots": [{
    "date": "2026-10-21", "captured_at": "2026-10-21T02:23:00Z",
    "citations_all": 2376, "h_index_all": 4, "i10_all": 4, "publications": 4
  }]
}
```

`data/social.json` 保存最新的社交平台指标，`data/social_history.json` 保存逐日的粉丝数快照：

```json
{
  "schema_version": 1,
  "captured_at": "2026-10-21T02:23:00Z",
  "sources": [{
    "id": "github", "label": "GitHub", "method": "github", "handle": "isLinXu",
    "url": "https://github.com/isLinXu", "color": "#9faeff",
    "status": "ok", "followers": 344, "following": 992, "posts": 431, "likes": null,
    "detail": "Hertz", "source": "api.github.com",
    "updated_at": "2026-10-21T02:23:00Z", "error": null
  }]
}
```

`status` 取值：`ok`（采集成功）、`unavailable`（本次失败，`error` 说明原因）、`disabled`（配置中未启用）。失败但此前成功过的平台会额外带 `stale: true` 并保留上次的数值。

`data/github.json` 保存最新的 GitHub 账号指标与仓库清单，`data/github_history.json` 保存逐日的粉丝数快照：

```json
{
  "schema_version": 1,
  "captured_at": "2026-10-21T09:51:04Z",
  "status": "ok",
  "error": null,
  "account": {
    "login": "isLinXu", "name": "Hertz",
    "followers": 344, "following": 992, "public_repos": 431,
    "url": "https://github.com/isLinXu"
  },
  "repositories": [{
    "id": "isLinXu/model-observatory", "name": "model-observatory",
    "full_name": "isLinXu/model-observatory",
    "url": "https://github.com/isLinXu/model-observatory",
    "language": "JavaScript", "stars": 0, "forks": 0,
    "is_fork": false, "archived": false,
    "updated_at": "2026-10-21T09:11:38Z"
  }],
  "projects": {"status": "unavailable", "reason": "未配置 GITHUB_TOKEN，无法读取 GitHub Projects", "items": []}
}
```

`status` 取值：`ok`（采集成功）、`stale`（本次失败，展示的是上一次快照，原因见 `error`）。`projects.status` 取值：`ok`、`unavailable`（缺少 token 或 GraphQL 报错）、`skipped`（本次运行跳过了 Projects 查询）。

## 修改为其他 HF 账号

修改 `.github/workflows/pages.yml` 中的 `HF_AUTHOR: gatilin`，并同步把 `data/latest.json` / `data/history.json` 的 `author` 改成新用户名、清空 `snapshots`，更新 `site/index.html` 中账户固定文案。或者直接重建空白 JSON。采集器会校验作者，避免不同账户数据混在一起。学术档案同理：修改 `SCHOLAR_USER_ID`，并清空 `data/scholar.json` / `data/scholar_history.json`（`profile_id` 变化时旧文件会被采集器拒绝覆盖，需要手动删除）。

## 文件组织

前端按职责拆分为独立文件，用 `window.MO` 命名空间共享，**没有构建步骤**，浏览器直接加载：

```text
.github/workflows/pages.yml   # 每日采集、提交历史、Pages 自动部署
config/social_sources.json    # 社交平台数据源声明式配置
scripts/collect.py            # Hugging Face 模型 + 数据集 API、异常保护、快照持久化
scripts/collect_scholar.py    # 公开 Google Scholar 档案抓取与解析
scripts/collect_social.py     # 社交平台粉丝数采集（可插拔 fetcher 注册表）
scripts/collect_github.py      # GitHub 账号指标、公开仓库分页与 Projects 采集
scripts/collect_templates.py   # 索引 templates/ 下的 Skill 与 Prompt 模版（只读本地）
scripts/build.py              # 组装纯静态站点
scripts/serve.py              # 本地预览用多线程静态服务器
templates/skills/<slug>.md    # Skill 定义（frontmatter + 正文）
templates/prompts/<slug>.md   # Prompt 模版（frontmatter + 正文）
site/index.html               # 看板 DOM
site/style.css                # 设计令牌 + 明暗双主题 + 响应式布局
site/format.js                # 数值格式化（万/亿、千位分隔、日期、涨跌符号）
site/charts.js                # SVG 图表原语（折线、柱状、排行）
site/data.js                  # 数据获取与全局状态、派生序列计算
site/render.js                # 各板块渲染逻辑
site/templates.js             # 模版库：浏览、草稿、复制与 GitHub 回写
site/theme.js                 # 明暗主题切换与持久化
site/app.js                   # 事件绑定与启动编排
site/favicon.svg
requirements.txt
data/latest.json              # 最新模型 + 数据集清单
data/history.json             # 逐日快照（models + datasets）
data/scholar.json             # 最新学术档案
data/scholar_history.json     # 逐日引用快照
data/social.json              # 最新社交平台指标
data/social_history.json      # 逐日粉丝数快照
data/github.json              # 最新 GitHub 账号指标 + 公开仓库 + Projects
data/github_history.json      # 逐日 GitHub 粉丝快照
data/templates.json           # 最新模版索引（含完整正文）
data/templates_history.json   # 逐日模版数量快照
tests/test_collect.py         # 离线测试（数据集 + url 字段 + 档案解析）
tests/test_social.py          # 离线测试（社交配置、降级、小红书解析）
tests/test_github.py          # 离线测试（仓库转换、历史、降级）
tests/test_templates.py       # 离线测试（frontmatter 解析、标签归一、索引与降级）
tests/test_frontend.js        # 前端派生指标与辅助数据加载回归测试
tests/fixtures/               # 离线测试用的真实页面片段
```

**新增一个平台通常只需要改两个文件**：`config/social_sources.json` 加一条配置，`scripts/collect_social.py` 注册一个 fetcher。前端因为是数据驱动的，无需改动。

分层原则：`data.js` 负责取数与状态，`render.js` 只负责把状态画到 DOM，`charts.js` 只负责画 SVG，`format.js` 只负责把数字变成字符串。渲染层不发起网络请求，取数层不触碰 DOM，因此新增板块时边界保持清晰。

## 注意事项

- 如果 `git push` 在 Actions 中失败，先检查 workflow permissions 或分支保护策略。工作流需要把数据提交回仓库来保证历史永久保存。
- 如果 `deploy-pages` 返回配置问题，核对 Settings → Pages → Source = GitHub Actions。
- 页面会直接请求 HF 的公开模型 API 来发现新上传模型；该接口允许跨域且无需 Token。单次请求超过 10 秒、请求失败或限流时自动回退到自己站点的 `./data/latest.json`，数据集和其它板块仍只读取发布的 JSON。
- 模型清单实时读取，历史仍是每天一个 UTC 快照，定时采集不等于实时历史。可以手动重新运行工作流刷新当天快照。
- 历史按前文策略有界保留：HF 近 400 天为日粒度，更早数据按周聚合并最多保留 104 个周桶；GitHub、Scholar 与模版历史保留最近 1100 天。
- 学术档案依赖 Google Scholar 的公开页面：若被验证码拦截，采集会跳过并保留上一次成功的快照，网站仍可正常展示下载统计。不要提高抓取频率，工作流每日一次即可。
- 知乎与小红书需要登录态，请把 Cookie 存在**仓库 Secret**（`ZHIHU_COOKIE` / `XIAOHONGSHU_COOKIE`）而不是提交进代码库。Cookie 会过期，属于正常现象：过期后该平台显示为「暂不可用」并保留上次数据，其它平台不受影响。
- 社交平台的粉丝数会随平台自身的风控与统计口径变化，与下载统计一样，负向跳变会被保留并标记为待核查，而不是被静默抹平。
- GitHub 匿名 REST 有 60 次/小时的 IP 限速。仓库数量多时（>1000）建议配置 `GITHUB_TOKEN`；触发限速时采集器会自动退避重试，仍失败则保留上次快照并在页面提示。

**官方文档**：[HF Hub HfApi.list_models](https://huggingface.co/docs/huggingface_hub/en/package_reference/hf_api) · [GitHub Pages 自定义 Actions](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
