# Model Observatory · @gatilin

一个**直接托管到 GitHub Pages** 的 Hugging Face 模型与数据集下载统计看板，并附带类 Google Scholar 的公开学术档案板块、社交平台粉丝数板块、GitHub 账号/仓库看板、ModelScope 模型计数板块、顶会投稿截止看板、GitHub 星星墙、实体注册表、任务看板与论文清单跟踪。静态前端，无后端服务器和前端密钥；页面打开时会通过 Hugging Face 公共 API 自动分页读取最新公开模型清单，新上传模型无需等待每日采集即可出现；GitHub Actions 每日自动抓取你的 **全部公开模型与数据集**、**公开 Google Scholar 档案**、**各平台公开粉丝数**、**GitHub 账号与公开仓库**、**ModelScope 公开模型计数**、**顶会截止时间目录**、**全部公开 star 的仓库**、**六个公开 awesome 清单的内容与更新节奏**，并索引仓库里手写的 **`entities/` 实体注册表**与 **`tasks/` 任务看板**，提交历史 JSON，同时重新部署网站。

支持：模型排行、单模型详情、总体趋势、最近 30 天活跃下载、历史累计、相邻快照净变化、7/30 日净变、统计下调异常标记、3 模型对比、搜索和 CSV / JSON 导出；数据集板块与模型完全同口径；学术主页展示引用总数、h-index、i10-index、逐年引用分布、每日引用快照与论文列表；社交媒体板块展示各平台粉丝数、平台筛选、时间范围筛选与卡片/表格双视图；GitHub 看板展示粉丝历史趋势、增长量与增长率，以及仓库的名称 / Star / Fork / 语言 / 最近更新时间，支持搜索、排序、语言筛选、**仅自有 / 含 Fork 口径切换**、分页与一键跳转，并可导出 CSV；ModelScope 看板展示匿名公开接口可见的模型下载计数、点赞与逐日快照趋势；**顶会投稿截止看板**把 CCF-Deadlines 目录展开成截止时间线，可按领域 / CCF 等级 / 截止类型 / 时间窗口筛选、倒计时、分页，并把当前筛选导出成 CSV 或 `.ics` 日历（只有能定到时刻的节点会进日历）；**星星墙**把全部 star 的仓库画成一格一仓库的方块墙，配聚类关系图、图例与明细清单，可按聚类 / 语言 / 主题 / 状态筛选、排序、分页与导出 CSV；**实体注册表**把 `entities/` 里手写的研究对象连成关系网，每条关联的核对状态由当日各来源快照当场判定，可按类型 / 阶段 / 标签 / 链接状态筛选、按对象反查「谁引用了它」、查看来源覆盖率与断链清单并导出 CSV；**任务看板**把 `tasks/` 里手写的任务画成可拖动的画布，拖动换道改状态、拖到别的卡上就是拆解、拉线就是依赖，卡片只引注册表与顶会目录的 id 而不复制任何数字，未推送的草稿与新建卡只留在本机浏览器里，可页内回写（远端在索引之后改过同样的字段就挡下并给三选）、可切清单视图按状态 / 引用 / 截止排序并导出 17 列 CSV；**论文清单跟踪**逐行数过六个公开 awesome 清单，把「本站实测」与「仓库自报」并排公布、永不相加，按文件而非按仓库判断更新节奏，新增与移出由条目 id 台账算出（第一次读到只建基线，不谎报变化），可按形态 / 归属 / 节奏 / 状态筛选、切卡片与条目流水两种视图、把卡片与流水一起收敛到单份清单（只看这份）、读逐日历史画观测趋势、把流水的一行变成一张只带那行事实的本机任务草稿，并导出 20 列 CSV；**模型清单核实**逐行数过 `isLinXu/model-list` 的 🆕／🔄／⚠️ 三态核实总表，把本站数出来的行数与清单自报的核实增量并排公布（差值只发布不相抵、`200+` 这类区间不取整成自己的数），来源等级 A／B／C 只转述该清单的判定、本站不重复核实，清单标注的「截至」日期与它自己 README 的提交节奏分列（后者含他们生成的每日自动日报，日更不等于每天核一遍），可按三态／等级／提供方／行的状态筛选与搜索、切「实测行数」与「清单自报增量」两种趋势指标、把表格的一行变成本机任务草稿、导出 27 列 CSV，而下方表格只是三态轮转取的样本——砍掉的是样本，不是任何计数。界面支持**明暗双主题**，默认跟随系统偏好。首次采集仅有当天数据，不伪造历史走势。首屏另有一行**采集健康**：最近一次运行自己说跑没跑完、哪一步没成功，这份记录只覆盖采集与索引那一段，构建与部署排在它提交之后、不在其口径里；浏览器读不到记录时那一行只说读不到，不等于采集失败。

**所有实体都带 `url` 字段**：模型、数据集、论文、仓库、项目与会议届次在列表中点击名称即可在新标签页打开原始页面；链接缺失时优雅降级为纯文本，不产生死链。

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
离线测试套件（回归门：Python unittest + node --test，全部不联网）
                ↓
Hugging Face API 读取 @gatilin 全部公开模型与数据集
                +
抓取公开 Google Scholar 档案（失败不影响其余流程）
                +
抓取各平台公开粉丝数（失败不影响其余流程）
                +
抓取 GitHub 账号指标与全部分页公开仓库（失败不影响其余流程）
                +
抓取 ModelScope 公开 OpenAPI 模型计数（失败不影响其余流程）
                +
抓取 CCF-Deadlines 会议目录并把截止时间归一为 UTC（失败不影响其余流程）
                +
分页读取账号全部公开 star 的仓库并聚合为聚类图（需要仓库令牌，失败不影响其余流程）
                +
逐行数过六个公开 awesome 清单，并查每个清单文件的最近提交节奏
（读别人仓库的公开文件，失败不影响其余流程）
                +
逐行数过 model-list 的 🆕 / 🔄 / ⚠️ 三态核实总表，并与它自报的核实增量并排发布
（读别人仓库的 README，失败不影响其余流程）
                +
索引 templates/ 下的 Skill 与 Prompt 模版（只读仓库，不访问网络）
                +
索引 entities/ 下的研究对象条目，并用同日快照核对关系链接（只读仓库，不访问网络）
                +
索引 tasks/ 下的任务卡，并用同日快照核对 entity / ddl 引用（只读仓库，不访问网络）
                ↓
记录本次运行自己：scripts/record_run.py 读 steps 上下文，写 data/runs.json
（哪一步在 continue-on-error 下面没产出，只有运行本身知道）
                ↓
更新 data/latest.json、data/history.json、
data/scholar.json、data/scholar_history.json、
data/social.json、data/social_history.json、
data/github.json、data/github_history.json、
data/modelscope.json、data/modelscope_history.json、
data/conferences.json、
data/stars.json、data/stars_repos.json、data/stars_history.json、
data/templates.json、data/templates_history.json、
data/entities.json、data/entities_history.json、
data/tasks.json、data/tasks_history.json、
data/awesome.json、data/awesome_history.json、data/awesome_ledger.json、
data/homc.json、data/homc_history.json、data/homc_ledger.json、
data/runs.json
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

### 谁审查这份工作流自己

这份工作流是唯一往 `main` 写入的东西：它按计划跑、带 `contents: write`、把快照 push 上去再部署。所以它的属性不能只靠「有人看过 yaml」维持，四条都写成了离线断言（`tests/test_ci.py`）：

- **回归门排在任何采集之前**。`Run offline test suite` 必须早于第一个 `Capture` 步骤和 `Commit` 步骤——采集器是联网代码，先让门跑绿，再让它写仓库。顺序被人拖动时测试变红，而不是部署变红。
- **动作全部钉到完整 commit sha**，行尾注释写明它来自哪个 tag（`# actions/checkout@v6`）。上游挪动一个 tag 等于在这里跑没被审过的代码；注释不是装饰——dependabot 靠它知道这个 sha 代表什么版本。
- **dependabot（`.github/dependabot.yml`）每周开 PR，覆盖 `github-actions` 与 `pip`**。钉住只让动作**不可变**，不让它**最新**；没有 bump 通道的一串 sha 会安静地腐烂。bump 的审查就是那份 PR 上跑的离线套件，**不自动合并**。
- **`permissions` 的三行是写死的**。要加第四行，先在这里写清它干什么。

**没有 ESLint，也没有 Ruff，这是决定而不是遗漏。** 本站的定位是没有打包器、没有类型检查、依赖只有 `requirements.txt` 里那一个包；装 linter 意味着加依赖、加配置，并让 CI 先 `npm install`。而这个仓库真正犯过的错从来不是风格，是两类别的东西：**「这个文件从没被任何运行时解析过」**（`index.html` 一个个加载普通脚本，一个语法错就是一块空栏目）和**「字符串对不上」**（页面点名的脚本、栏目查的 DOM id、构建发布的文件名）。前者由 `tests/test_syntax.py` 付账——`node --check` 用页面自己的解析器扫 `site/*.js` 与前端测试，Python 侧用内建 `compile()`，**装什么都不用**；后者由 `tests/test_wiring.py` 付账。node 不在 PATH 时那条测试报 `skip` 而不是通过：没跑过的检查不能说跑过了。

两个已知会变的下游事实记在这里，等 dependabot 的 PR 或单独一次决定，而不是顺手盲升。两条都是今天读 `action.yml` 与 GitHub 公告核对过的：**六个动作里有两个声明 `using: node20`**——`actions/configure-pages@v5` 与 `actions/deploy-pages@v4`（`checkout`／`setup-python`／`setup-node` 那三个声明 `node24`，`upload-pages-artifact@v4` 是 composite 动作、自己没有运行时），Node 20 正在被 Actions 淘汰，前两者的现行 major 分别是 v6 与 v5；**`ubuntu-latest` 从 2026-10-19 起在数周内逐步切到 Ubuntu 26.04**（公告说 2026-11-19 前完成），影响的是采集器的运行环境而不是本站代码。两者都不是今天红的原因，所以不在这里替它们做决定。

### 采集健康：这次运行自己说了什么

上面那一节管的是「这份工作流被人改坏了会怎样」，这一节管的是「它今天跑成什么样」。板块上的每个数字都能说自己多新，没有一个能回答读者真正先问的那句：**今天的采集到底跑了没有，中间是不是死了一步。**`continue-on-error: true` 让这件事在数据里看不出痕迹——一个被咽下去的失败，看起来跟「这块板子今天没更新」一模一样。

所以工作流在提交之前多跑一步 `scripts/record_run.py`，产出 `data/runs.json`，页面在 hero 下面用一行话说它（`MO.data.runHealth()` + `MO.render.renderRunHealth()`）。四条口径：

- **读 `outcome`，不读 `conclusion`。** 一个在 `continue-on-error` 下面失败的步骤，Actions 给的 `conclusion` 是 `success`（那是作业的决定），`outcome` 才是 `failure`（那是发生的事）。用前者写健康记录，会恰好对这份文件存在的理由说「没问题」。
- **`unknown` 是一个答案，不是占位。** 没有步骤映射（这脚本单独跑、或那段 JSON 解析不了）时，文件只说「这趟跑过，没交出步骤结果」；它**不会**默认成 `ok`，也不会把 16 步全列成「没跑到」——一个 JSON 的缺席不支持「所有采集都被跳过」这种断言。
- **`partial` 与 `failed` 的分别是运行自己给的**：作业状态是 `failure`/`cancelled` 就写 `failed`，作业扛过去了但有步骤没产出就写 `partial`，两个列表（`steps_failed`／`steps_missing`）用步骤的中文标签点名是哪一步。
- **这份记录只说自己那段**：`covers` 写明它覆盖采集与索引，而**构建与 Pages 部署排在这份记录提交之后**，所以这行绿不等于站点更新了。步骤清单里没有 `Build`／`Deploy`，不是遗漏，是因为它们的结果此刻还不存在。

还有一条不在口径里而在位置上：`data/runs.json` 由这一步写、由同一次运行的提交步骤带进仓库，所以**它描述的正是发布它的那次提交**；那一步带 `if: ${{ !cancelled() }}`，作业硬失败时（后续步骤被跳过、`job.status` 为 failure）它仍会写——那正是最需要留下记录的一次，而被主动取消的作业不写、也不假装写过。本地 `_site/` 里今天没有这个文件（只有 CI 会写它），页面因此显示「这台浏览器没读到运行记录——读不到不等于采集失败」，并把原因放进 `title`：一次浏览器里失败的 fetch 不是一次失败的采集。同一句话也在 `loadAll` 抛错的兜底分支里画——主数据读坏了，健康行恰恰最有用。

保留窗口是 60 次运行，按 `(run_id, attempt)` 去重（重跑同一 attempt 是替换不是叠加），新条目排最前；`retention.kept` 说这次留下了几条。超过 2 天的记录会补一句「距今 N 天」，天数只走 `MO.format.ageInDays`。`run_url` 在采集端就要 https + 合法 `owner/repo` + 纯数字才拼，到前端再过一次 http(s) 白名单，两个方向都不给非 https 链接开口子。步骤清单与 `.github/workflows/pages.yml` 里的 `id:` 必须一一对应，这条由 `tests/test_runs.py` 离线钉住：改了那边的名字而没改这里，健康报告会安静地不再覆盖那一步。

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
python scripts/collect_entities.py --check        # 只校验 entities/ 结构与链接，不写文件
python scripts/collect_entities.py --ids --domain hf_dataset   # 列出本次能链接的真实 id
python scripts/build.py && python scripts/serve.py --port 8080
```

产出 `data/templates.json`（当前索引，含完整正文）与 `data/templates_history.json`（每日一份，用于「模版库规模趋势」图）。目录不存在时标记为 `unavailable` 并保留上一次快照，不会让看板空白。

### 从页面推送回 GitHub

栏目底部的「同步到 GitHub」面板提供完整回写链路：

1. 新建 / 编辑模版 → 草稿先存在浏览器 `localStorage`，右侧实时预览将要写入的文件内容；
2. 「保存并推送到 GitHub」→ 通过 Contents API 写入 `templates/{skills,prompts}/<slug>.md`（已存在时自动带 `sha` 覆盖）；
3. 推送成功触发 GitHub Actions，重新采集索引并部署，页面的模版列表随之更新。

**Token 约定**：需要一个 **fine-grained personal access token**，只勾选目标仓库的 `Contents: Read and write`。Token 仅保存在当前标签页的 `sessionStorage`，只发送给 `api.github.com`；关闭标签页后由浏览器清除。旧版本保存在 `localStorage` 的 Token 会在下次打开页面时迁移到会话存储并删除持久副本。本站是纯静态页面，没有后端代理；在公共电脑上仍应在使用后点「清除」。

这套规则由 `site/repo.js` 统一持有（键 `mo.repo.token`），模版库与实体注册表的回写共用同一个 Token；`mo.templates.token` 里的旧值会被**移动**而不是复制。模版库的推送历史上不带基线（见下方注册表回写的「基线冲突」），注册表条目则每次推送都先核对 `blob_sha`。

未配置 Token 时模版库仍可完整浏览、复制与导出草稿，只有写回被禁用——面板会明确提示缺什么，不会静默失败。

### 采集失败时的行为

| 情况 | 行为 |
| --- | --- |
| `templates/` 目录不存在 | 标记 `status: unavailable`，保留上一次索引 |
| 单个文件无法读取或文件名非法 | 跳过该文件并在日志中提示，其余正常索引 |
| 正文超过 20000 字符 | 截断后发布并置 `truncated: true`，`bytes` 仍记录真实体积 |
| 未配置 Token 就点推送 | 面板与toast 提示「请先填写 GitHub Token」，草稿保留 |
| GitHub 返回 401/403/422 | 显示 GitHub 的错误原文，不丢失已保存的草稿 |

## 顶会投稿截止看板：数据来源与口径

「顶会截止」栏目把社区维护的 CCF-Deadlines 目录变成可筛选、可倒计时、可导出的投稿时间线，由 `scripts/collect_conferences.py` 独立采集，输出单文件 `data/conferences.json`（当前快照，不含历史）。

### 数据来源

| 内容 | 接口 | 是否需要凭据 |
| --- | --- | --- |
| 全部会议 / 届次 / 截止时间 | `https://ccfddl.com/conference/allconf.json` | 否 |

- 该聚合文件由 [`ccfddl/ccf-deadlines`](https://github.com/ccfddl/ccf-deadlines)（MIT）生成，本站只做匿名读取与归一化：不跟随重定向、禁用系统代理、响应上限 8 MB、整体 90 秒预算、可重试错误（429 / 5xx / 网络与超时）最多重试两次。
- 采集器按「会议 → 届次 → 事件」三层展开。上游 timeline 的四个字段分别归一为 `abstract`（摘要截止）、`paper`（论文截止）、`rebuttal`（Rebuttal）、`decision`（录用通知），同一届的多轮次用 `round` + `comment` 保留，不按「一届一条」压缩。
- 当前快照规模：383 个会议 / 2,346 个届次 / 4,446 个事件，其中论文截止 2,926 个、待定（TBD）115 个；领域覆盖 `AI/CG/CT/DB/DS/HI/MX/NW/SC/SE`，CCF 等级分布为 A 58 / B 131 / C 146 / N 48（`N` = 目录中未评级的会议，下拉里标为「未评级 (N)」）。
- 每日采集由 `.github/workflows/pages.yml` 的「Capture conference deadline feed」步骤承担，`continue-on-error: true`：上游宕机或格式变更不会阻塞下载看板的采集与 Pages 部署。

### 时间口径：归一化只发生在采集端

上游发布的是**裸的本地时间 + 时区标签**（例如 `2026-08-07 23:59:59` + `PT`）。直接按字符串比较会让倒计时偏差十几个小时，因此采集时就换算成 UTC 时刻，前端不再猜时区：

| 标签 | 处理 |
| --- | --- |
| `AoE` | 固定 `UTC-12`（学术截止的惯例写法） |
| `PT` | `zoneinfo` 的 `America/Los_Angeles`，自动跟随夏令时 |
| `UTC±H` / `UTC±H:MM` | 按固定偏移解析（超出 ±14 小时视为无法解析） |
| 缺失、拼写不认识、时间文本无法解析 | **不做猜测**：`utc` 写 `null`，`time_status` 标记 `unknown_timezone` 或 `invalid_time` |
| `TBD` | `tbd: true` + `time_status: "tbd"`，原样保留 |

每条事件因此同时带三个时间视图：`utc`（排序、倒计时、窗口筛选都用它）、`source_local` + `timezone`（与会议官网公告对照）、`offset_minutes`（展示偏移）。无法解析的时间不参与倒计时，只会出现在「待定或无法解析」窗口里。

### 与其他板块不同的留存策略

`data/conferences.json` 是**单文件当前快照，不写历史**：上游目录是「截止时间」而不是计数器，逐日累积没有可加指标，而 1.4 MB 的体量再存历史会迅速拖慢首屏。看板改用**相邻两次采集的差异**来表达变化：

```json
{"status": "compared", "added": 6, "updated": 12, "removed": 0,
 "previous_captured_at": "2026-10-31T02:23:11Z"}
```

差异按事件 ID 与内容签名计算，首次采集为 `status: "initial"`。`captured_at` 只在成功时更新，`last_attempt_at` 每次运行都更新——提示条据此区分「数据变旧」与「采集一直没跑成」。

### 采集失败时的行为

| 情况 | 行为 |
| --- | --- |
| 不可达 / 非 200 / 重定向 / 超过 8 MB / 非法 JSON | 保留上一次快照，`status` 置 `stale` 并记录 `error`，页面顶部显示信息级提示条 |
| 顶层不是数组、为空、会议键或届次 ID 非法、`conference_key` 或届次 ID 重复 | 整次采集判定失败（同上），**不做部分写入**，避免格式变更静默清空看板 |
| timeline 结构异常、截止时间不是字符串、会议链接非法、某会议无届次 | 跳过问题内容并记入 `warnings`（去重、上限 100 条），其余正常发布 |
| 首次运行前就失败（没有历史可留） | 写入 `status: unavailable` 的空壳，`counts` 全 0 |
| 采集时间早于已有快照 | 拒绝写入且不改动文件，防止旧数据覆盖新数据 |
| 快照缺失或版本 / 来源不认识 | 前端仅本栏目降级为「暂无数据」，其它板块照常加载 |

### 看板功能

- **KPI**：「最近一个截止」显示剩余时间（≤7 天转红、≤30 天转橙），副标题给出会议、节点类型与换算后的 UTC 时刻；「未来 30 天 / 90 天论文截止」只统计 `paper` 事件；「收录时间节点」是全部事件数，副标题说明其中多少个尚未公布日期。四项统计基于全部事件，**不随筛选变化**，筛选影响的是下面的列表。
- **NEXT UP**：最近 6 条截止，卡片左边框按紧迫度着色（`urgent` / `soon` / `past` / `unknown`）。
- **筛选与搜索**：领域、CCF 等级、截止类型（默认只看论文截止）、时间窗口（未来 30 / 90 / 180 / 365 天、全部未截止、待定或无法解析、已截止），关键词覆盖会议名、缩写、地点与日期描述；每页 20 条，「已截止」窗口按时间倒序。
- **CSV 导出**：导出当前筛选结果（不是仅当前页），22 列同时保留 `deadline_utc` 与 `source_local` / `timezone_label` / `time_status`。
- **日历导出（`.ics`）**：同一筛选链下的另一份产物，`conferenceRows()` 里能定到时刻的行逐条写成 `VEVENT`，`DTSTART` 一律是 UTC 紧凑时刻（`20261103T115959Z`），`UID` 用事件 id（`AI/aaai:aaai27:paper:1` → `AI-aaai-aaai27-paper-1@ccfddl.model-observatory`），所以同一份数据反复导入是更新而不是越导越多。第三方的标题、备注、地点都会进 `SUMMARY` / `DESCRIPTION`，因此按 RFC 5545 转义 `\` `;` `,` 与换行，并按**字节**（不是字符）折成每行 75 个 octet——一个汉字是三个字节，按字符数折会把一个汉字切成两半。文件不带 BOM（CSV 那个是为了 Excel 才带的，日历解析器第一行要读到的却是 `BEGIN:VCALENDAR`）。**日期待定与时区认不出的节点不会写入**：日历里的一个时刻是承诺，猜出来的 00:00 会让读者按一个上游没说过的时间行动，宁可不写；`X-WR-CALDESC` 与导出提示都说明这条规则，若当前筛选一个时刻都没有（例如停在「待定或无法解析」窗口）就不下载空文件，只说为什么。
- **手动刷新**：读取线上已发布的 `data/conferences.json`（绕过缓存）；要真正重新抓取上游，仍需手动运行工作流。

口径提醒：同一会议的多轮次与多类截止**不能相加**为「投稿次数」；倒计时以浏览器当前时间对比快照中的 UTC 时刻，快照本身是每日一份；目录由社区维护，可能与官网不同步，**投稿前以会议官网为准**。第三方的会议名、地点、备注都是不可信文本，渲染时统一转义，导出时对以 `=`、`+`、`-`、`@` 开头的单元格加前置单引号，避免被电子表格当作公式执行。

## GitHub 星星墙与聚类知识图谱：数据来源与口径

「星星墙」栏目把 `isLinXu` 的公开 star 列表画成**一格一仓库**的方块墙，并用语言 / 主题 / 账户三类聚类节点及其共现关系构成知识图谱，由 `scripts/collect_starred.py` 采集。一次运行产出三个文件，浏览器按需下载：

| 文件 | 内容 | 页面何时读取 |
| --- | --- | --- |
| `data/stars.json` | 聚合快照：计数、聚类节点、共现边、与上次采集的差异 | 首屏，与其它看板一起 |
| `data/stars_repos.json` | 每仓库一行的明细（10 个紧凑字段），全站最大的单个文件 | **进入本节视口才拉取**，另留手动加载 / 重试按钮 |
| `data/stars_history.json` | 逐日的 star 总数与结构计数 | 页面不请求，供离线分析 |

拆成两份的原因是墙、清单与 CSV 需要逐仓库数据，而 KPI、聚类下拉与关系图只需要聚合结果，首屏因此不必下载最大的文件。明细读取失败时看板会明说「指标与图谱仍来自快照」，而不是把两个来源混成一个数字。

### 只用仓库令牌，不读 starred_at

- 一次采集＝每 100 个 star 一次请求（页数上限 80 页，即 8,000 个仓库）。匿名 REST 只有 60 次/小时，而同一次工作流里 GitHub 仓库看板已消耗了部分额度，所以这一步显式注入 workflow 自带的 `secrets.GITHUB_TOKEN`（认证后 5,000 次/小时）。
- **不需要、也不会请求任何个人 PAT**：`starred_at`（哪个仓库是哪天 star 的）只有账户自身的 OAuth 令牌才返回。本站只读公开元数据，所以墙上没有「star 日期」这一列，页面写的是「取消 star 会体现在次日快照中」。
- 没有令牌时采集器直接发布 `status: unavailable` 并说明原因。发布出去的三个文件里不会出现令牌、URL 或响应原文：失败原因统一成 5 条固定文案（`token` / `count` / `empty` / `pages` / `schema`），其余异常只归为「无法访问 GitHub API」或「GitHub 返回 HTTP 状态码」，回归测试对此有断言。
- 解析出的仓库数与 GitHub 在 `Link` 头里公布的分页总数比对，偏差超过 `max(10, 1%)` 就判定列表在翻页期间变了样，保留上次快照并标记 `stale`，不发布半个列表。

### 一个仓库只归入一个聚类

明细行按 **语言 → 足够热门的主题 → 足够热门的账户 → `lang:未知`** 的顺序取第一个可用节点（`primary_node`），因此：

- 各聚类的**仓库数可以相加**，相加等于 star 仓库总数；
- 节点的「出现次数」（`appears`，同一仓库会在多个维度上出现）**不能相加**；
- 节点规模有上限：语言全收录（名称最长 40 字符），主题取前 120 个且至少 8 个仓库，账户取前 60 个且至少 3 个仓库；每个节点另附最多 8 个代表仓库；共现边要求两端至少有 5 个共同仓库，最多发布 600 条。

图谱要在一屏内可读，前端再按每环节点预算取前 10 个语言 / 22 个主题 / 10 个账户，连线最多画 120 条，并在图注里如实说明「多少个较小聚类未绘出、多少条关系因另一端未入选而省略」。

### 明细行的字段压缩

`stars_repos.json` 每行是 `{n, l, t, s, d, p, f, r, o, c}`：仓库名、语言、主题（最多 6 个）、star 数、描述（截断 120 字符）、最近推送日期、是否 fork、是否归档、所有者是否组织、采集端分配的聚类 ID。`null` 与 `0` 严格区分：star 数未知显示 `—`；`o: null` 表示 GitHub 未给出 `owner.type`，不冒充「个人」。聚类 ID 由采集端下发而不是前端重算，避免两处阈值走偏。仓库链接由前端按名称拼成 `https://github.com/<owner>/<repo>`，明细里不重复存 url。

### 采集失败时的行为

| 情况 | 行为 |
| --- | --- |
| 未配置令牌 | 直接发布 `unavailable` 空壳并写入固定原因，即使本地已有快照也不复用——墙与图谱没有可核对的来源 |
| 401 / 403 / 429 / 网络与超时 / 单页格式异常 | 保留上次快照，`status` 置 `stale`（没有历史时同样写 `unavailable` 空壳），原因写入 `error` |
| 结构非法、空列表、超出页数上限、总数与实际解析数量不符 | 整次采集判定失败（同上），**不做部分写入** |
| 单条记录名称 / 日期 / 链接非法、语言或描述超长、含控制字符、`owner.login` 与仓库标识不一致 | 跳过或截断问题字段并记入 `warnings`（去重、上限 100 条 + 一条「更多告警已省略」哨兵），其余正常发布 |
| 采集时间早于已有快照 | 拒绝写入，防止旧数据覆盖新数据 |
| 快照缺失、`schema_version` 或 `source.id` 不认识 | 前端仅本栏目降级为「star 数据暂不可用」，其它板块照常加载 |
| 明细读取失败（404 / 超时 / 行格式不完整） | 墙、清单与 CSV 显示失败原因并提供重试按钮，KPI 与关系图继续由快照供数 |

`captured_at` 只在成功时更新，`last_attempt_at` 每次运行都更新，看板据此区分「数据变旧」与「采集一直没跑成」，并单独显示「最近读取快照」的时间——页面上的刷新按钮只读线上已发布的 JSON，不触发采集。工作流另有一步报告三个文件的字节数，`stars.json` 超 150 KB 或 `stars_repos.json` 超 3 MB 时发出 warning，提示去收紧聚类预算或给墙加分页。

### 看板功能

- **KPI**：star 仓库总数、90 天内有推送的占比、聚类数、归档 + fork 数四项全部来自聚合快照，明细加载与否都不会改变；聚类 KPI 与下拉、关系图、来源说明用同一个口径——**只统计至少分到一座仓库的节点**，快照里另有只作为维度出现、没有归属仓库的节点，它们不计数也不画，卡片副标题把两个数一起写出来（例如「232 个快照节点，仅 124 个分到仓库」）；副标题给出语言 / 主题 / 所有者数量与特殊状态明细。
- **星星墙**：一个 SVG、一格一仓库、行优先密排；格子大小是 star 数的对数映射，颜色按聚类分段（图例给出名称与数量），悬停读出仓库名 / star / 语言 / 归属聚类，点击格子或图例即按该聚类筛选，再点一次取消。明细尚未加载时如实写「滚动到本节会自动读取，也可以手动加载」。
- **聚类关系图**：内环语言、中环主题、外环账户；节点大小随归属仓库数，连线粗细与亮度随共同 star 的仓库数，点击节点同样落到筛选；图注说明被每节预算挡在外面的聚类数与省略的关系数。
- **明细清单**：每页 24 条、7 列（仓库 / 归属聚类 / 语言 / 主题 / star / 最近推送 / 状态标记），聚类与主题 chip 可点选；搜索覆盖仓库名、描述与主题，另可按语言、主题、状态（90 天内有推送 / 已归档 / fork / 无描述）筛选，按 star、最近推送或仓库名排序。
- **CSV 导出**：导出当前筛选结果而不是当前页，17 列同时给出 `cluster_id` / `cluster_type` / `cluster_label` 与快照、明细两个采集时间。
- **两个手动按钮**：「刷新已发布快照」只重读 `data/stars.json`，「加载 / 重新加载 / 重试 star 明细」强制重读 `data/stars_repos.json`；两者都不触发采集，采集时间一律以文件里的 `captured_at` 为准。

口径提醒：star 数是仓库当前的公开计数，与「谁 star 了本账号」无关；`counts.total` 是 star 的仓库数，而账号主页的 `public_repos` 是**拥有**的仓库数，两者不可互换；墙上格子的大小只是 star 数的对数映射，不构成第三种指标。第三方文本（仓库名、描述、主题）渲染时统一转义，链接只接受 `https://github.com/<owner>/<repo>` 形态，CSV 导出对以 `=`、`+`、`-`、`@` 开头的单元格加前置单引号。


## 实体注册表：数据来源与口径

「实体注册表」栏目把 `entities/` 里手写的研究对象索引成**一条一文件**的关系网，由 `scripts/collect_entities.py` 采集。这一步不访问任何外部 API：条目来自本仓库，链接的核对来自**同一天其它采集器已经发布的快照**。

| 文件 | 内容 | 页面何时读取 |
| --- | --- | --- |
| `entities/<slug>.md` | 唯一由人维护的来源：front matter 登记关系，正文写结论 | 采集器读，浏览器不读 |
| `data/entities.json` | 索引快照：条目、四种链接状态、来源覆盖率、与上次采集的差异 | 首屏，与其它看板一起 |
| `data/entities_history.json` | 逐日的实体数、链接数与状态分布 | 页面不请求，供离线分析 |

首屏就拉它，是因为反向链接要回答「哪个实体引用了这个模型 / 数据集 / 仓库」，必须有整份索引在手；按视口懒加载只会让反查在滚到那一屏之前一直空着。代价是这个文件会随正文变长，所以正文有截断预算，工作流也在索引超过 200 KB 时报警——先收紧正文，而不是把栏目改成懒加载。

### 只登记关系，不复制指标

注册表里没有任何数值指标：下载量、粉丝数、star 数、引用数仍分别握在自己看板手里，每个数字只有一个 `captured_at`。同一指标一旦被抄进第二份文件，就会有两个采集时间，页面迟早要当场编一个说法。所以新条目只写 `links:` 与结论，不要把 HF 下载数、ModelScope 浏览量抄进 Markdown 或 front matter。

- `links:` 是 `domain:id` 列表，9 个前缀可用：`hf_model` / `hf_dataset` / `hf_collection` / `hf_space` / `ms_model` / `gh_repo` / `scholar` / `conf` / `template`。前缀写错**不是告警而是结构错误**——`--check` 直接以 1 退出，让作者当场知道，而不是等这条链接在页面上悄悄消失。
- `scholar:` 后面写论文标题即可。采集器取第一个冒号（中冒号同样算）之前的短语压成别名，`MME: A Comprehensive ...` → `mme`；标题里没有冒号就退化为前 5 个词。规则确定，页面也如实说明这条链接按标题别名匹配，读者可以自己手算复现。
- `gh_repo` 忽略大小写匹配（GitHub 路由本就不区分），匹配到之后**发布的 id 与 URL 采用快照里的写法**；Hugging Face 的 id 大小写敏感，因为大小写是标识符的一部分，`--ids --domain hf_model` 会打印准确写法。
- 「论文清单跟踪」的六个清单仓库各有一条 `kind: project` 的条目，正文只写这份清单是什么、该按什么口径读，**条目数、覆盖率与更新节奏都留给那个栏目**——注册表把清单登记成可被任务卡引用的对象，而不是把计数抄一遍。其中 `BradyFU/Awesome-Multimodal-Large-Language-Models` 是他人的仓库，页面如实显示「范围外」：它既不是断链，也不是等待补上的缺口。

### 四种链接状态，各自有来源

状态在采集时逐条对照当日快照得出，不是前端猜的：

| 状态 | 含义 | 是否发布链接 |
| --- | --- | --- |
| `已核对`（`resolved`） | 该来源当天的快照里确实有这个对象 | 是，URL 取自那份快照 |
| `断链`（`unresolved`） | 来源当天回答了我们，但清单里没有这个 ID：条目要改，或对象已下架 | 否 |
| `未核对`（`unchecked`） | 对应来源本次没有可用快照（或像 `hf_space` 那样本站还没有采集器） | 否 |
| `范围外`（`out_of_scope`） | 他人的仓库，既不是缺口也不是断链，本站不核对 | 否 |

- **只有 `resolved` 才发布 URL**：页面上的一条链接是一个断言，说这个对象当天在某个来源里被见到。
- **「未核对」不会被写成「断链」**——采集失败与目标消失是两件事，混在一起只会让读者忽略提示。未核对的行与覆盖面板都会把所属来源的原因原文显示出来（例如「学术档案快照不可用」）。
- 原因与采集时间住在 `sources[domain]`（`file` / `available` / `captured_at` / `reason`），`coverage[domain]` 只放计数。两个块各说一件事，前端读覆盖率原因时取的是 `sources`，不是把原因再抄一份。
- `hf_space` 显式声明为「无可用来源」而不是从字典里删掉：域名留在载荷里，缺口就看得见；删掉只会让链接被悄悄丢弃。

### 覆盖率是工作队列，不是数据集

`coverage` 只统计**本站自有输出**的 7 个来源；`conf` 被排除在外——顶会 key 是一个目录条目，不是我们的产出，所以它的链接照常核对，但不计入缺口。分母来自各来源自己的当日快照：GitHub 只算账户发布的**非 fork** 仓库（fork 是别人的仓库，既不是缺口也绝不该出现在待补清单里），学术档案按标题别名匹配。

每源发布 `已登记 / 总数`、未登记清单（**最多 50 条**）、`unregistered_count` 与 `truncated`。清单是拿来干活的，不是拿来当数据用的：一屏要能读，剩下的靠计数说明，而不是把几百个 id 塞进每一次页面加载。看板另有两处如实交代：**「`x / y` 个来源当日可用」**（不可用的来源显示自己的原因，不假装 0/0），以及 KPI 副标题里的**零登记缺口**（有对象可登记却一条都没登记的来源）——只在有缺口时出现。

### 结构与预算上限

一条条目只有六个可用字段，其余内容都是正文：

```markdown
---
title: Youtu-FT-V1
kind: project          # project / model / dataset / paper
stage: shipped         # proposal / training / evaluating / submitting / shipped / archived
tags: [后训练, MoE, 轻量模型]
updated: 2026-11-02    # YYYY-MM-DD，作者改的日期，不是文件 mtime
links:
  - hf_model:gatilin/Youtu-FT-V1-4B
  - hf_space:gatilin/Youtu-VL-demo
---
正文：为什么做、结论是什么、下一步。
```

- 文件名即 slug，需匹配 `^[a-z0-9]+(?:[-_][a-z0-9]+)*$`；条目按文件名排序，`title` 缺失时回退为 slug。
- `kind` ∈ `project / model / dataset / paper`，`stage` ∈ `proposal / training / evaluating / submitting / shipped / archived`。非法值不整条丢弃，而是**按未标注处理**并记入 `structural_errors`；`updated` 不是 `YYYY-MM-DD` 同理。空 `links:` 是合法的——只有作者知道它该连向哪里。
- 上限各不相同：**超出就要说明**。条目超过 500 条、单条链接超过 40 条时，其余不发布并记入 `warnings`；标题截到 120 字符、标签取前 12 个，属于就地截断。
- 正文取前 20,000 字符，而 `bytes` / `lines` / `sha256` 描述**整个正文**：被截断的条目仍显示真实大小，只改了截断线之后的内容也仍会被 `changes` 认作一次修订。
- 「今日更新」只认作者改的东西。差异键由 `sha256` + 标题 + 类型 + 阶段 + `updated` + 标签 + `domain:id` 组成，**不含链接状态与 URL**，所以兄弟快照移动不会把全部条目刷成「已修订」；链接状态跟着其它采集器每天变，那是它自己的事。

### 采集失败时的行为

| 情况 | 行为 |
| --- | --- |
| `entities/` 目录不存在 | 保留上次索引，`status` 置 `stale`（没有历史时写 `unavailable` 空壳），原因写入 `error` |
| 文件名非法 | 跳过该文件并记入 `structural_errors`（其余条目照常发布） |
| front matter 无法解析、`kind` / `stage` / `updated` 非法、链接不是 `domain:id`、前缀未知、冒号后为空 | 字段按未标注处理或忽略该条链接，条目仍发布，问题记入 `structural_errors`（`--check` 会失败） |
| 条目数 / 链接数超预算、正文超长、标签与标题截断 | 截断发布并记入 `warnings`（去重、上限 100 条 + 一条「更多条目已省略」哨兵） |
| 某个来源快照缺失、或其 `status` 不是 `ok` / `stale`、或清单为空 | 该来源置 `available: false`，其中链接一律 `未核对`，覆盖率不计缺口，原因写入 `sources[domain].reason` |
| 采集时间早于已有快照 | 拒绝写入，防止旧数据覆盖新数据 |
| 快照缺失、`schema_version` 或 `source.id` 不认识 | 前端仅本栏目降级为「注册表数据暂不可用」，其它板块照常加载 |

`captured_at` 只在成功时更新，`last_attempt_at` 每次运行都更新；失败时**不做部分写入**，上次索引整份保留。对外发布的失败原因是固定文案，不含路径、令牌或响应原文。本地写作可用 `python scripts/collect_entities.py --check`（只解析与核对，不写文件）、`--strict`（把断链也判为失败）、`--ids [--domain --grep]`（列出本次能链接的真实 id）。工作流另有一步在 `data/entities.json` 超过 200 KB 时发出 warning：这个文件是首屏拉取的，长文应该留在 Markdown 源文件里，而不是继续塞进索引。

### 看板功能

- **KPI**：注册实体（副标题按类型分布）、关联链接（副标题给出四种状态分布）、自有对象已登记 `已登记 / 总数`（副标题写明来源可用数与零登记缺口）、进行中实体（提案 / 训练 / 评测 / 投稿，副标题给已交付 / 归档 / 未标注）四项全部直接取自采集器的 `summary` 与 `validation`，前端不重算——部分加载的看板不会报出一个与当日采集不一致的数字。
- **来源覆盖**：每源一行进度条 + `已登记 / 未登记` + 分母的采集时间，未登记对象以 chip 列出前若干个并说明剩余数量；不可用的来源显示自己的原因。
- **断链与未核对**：断链排前、未核对其次、范围外最后，每条写明该状态的口径（未核对还会带上来源原因），点「来自实体 …」即展开那条条目；如果它正被当前筛选挡住，则先把筛选清空并跳到它所在页。
- **明细清单**：每页 8 条、7 列（实体 / 类型与阶段 / 关联对象 / 标签 / 核对 / 更新 / 正文），搜索覆盖实体名、slug、标签、正文与对象 ID；可按类型、阶段、标签、链接状态（含「仅含问题链接」）、反查对象筛选，按更新时间 / 关联数量 / 名称排序。类型、阶段、标签下拉**只列条目里真正出现过的值**并带计数，空值作为一个可筛选项显示为「未标注类型 / 阶段」，不会出现选了永远为空的选项。关联对象列最多画 3 个 chip，其余以 `+N` 计数。
- **反向链接**：点任一关联对象 chip 即按该对象反查「哪些实体引用了它」，说明行给出对象所属来源、核对状态与引用它的实体标题；再点一次或选回「反查：全部对象」取消。标签 chip 同样可点选。同一个对象被多个实体引用时共用一次核对结果，因为核对是按来源做的。
- **正文行**：展开后按源文件原文放进 `<pre>` 展示，**不解析成 HTML**；如实标注「正文在采集中被截断：源文件共 N 字节 / M 行」或给出 `sha256` 摘要，并列出每条关联的状态解释、反向链接数、回源编辑链接，以及「在页内编辑」按钮。
- **CSV 导出**：导出当前筛选结果而不是当前页，17 列给出 `link_ids` / `link_states` / `link_urls` 与快照 `captured_at`；**不含正文**——Markdown 的排版与历史属于 git，不属于表格。
- **刷新已发布快照**：只重读 `data/entities.json`（一次点击一次请求），不触发采集；失败时保留上次快照并说明原因，采集时间一律以文件里的 `captured_at` 为准。状态行把「快照采集于」「快照距今多久」「最近读取」三件事分开写，页面上另有一个指向 `entities/` 源目录的按钮。

### 浏览器回写：`site/repo.js` + `site/registry.js`

注册表是本仓库对自己的描述，所以**改条目的正规路径仍然是 git 提交**；页面另外提供的回写只是省掉本地 clone，规则如下。

- **编辑器读的是源文件，不是快照**：点「在页内编辑」后用 Contents API 重新 `GET entities/<slug>.md`，把远端当前原文放进编辑框。快照里的正文是截断副本，用它推送会丢掉截断线之后的内容。
- **Token 只进 `sessionStorage`**（键 `mo.repo.token`），只发往 `api.github.com`，本站是纯静态页、没有后端可代理，因此它也绝不会出现在任何 `data/*.json` 里。模版库早期的 `mo.templates.token` 会被**移动**而不是复制到这个键。未填 Token 时条目照常浏览、搜索、导出，只有回写禁用并说明缺什么。
- **路径守卫**：所有请求都拼在 `https://api.github.com` 之后且必须是以 `/` 开头的相对路径，含 `..` 的路径直接拒绝（`fetch` 会先折叠 `..`，不挡就等于把写入口变成任意 URL）；文件名逐段 `encodeURIComponent`。
- **基线冲突**：采集器为每条条目发布 `blob_sha`（整个源文件的 git blob SHA，与展示用的正文 `sha256` 是两个东西）。草稿记住自己来自哪个 SHA，推送前重新读一次远端：不一致就**挡下**，给出「重读原文与索引 / 以远端为准（丢弃草稿） / 明确覆盖并推送」三选，绝不静默覆盖；普通的「保存并推送」按钮不构成覆盖授权。
- **草稿留在本机**：`localStorage` 的 `mo.entities.drafts` 只存 `{text, baseline, savedAt}`，未推送的改动不进站点数据、也不被采集器看到；推送成功后次日采集才会重建索引，页面不会当场改数。
- **当场自检**：`--check` 的结构规则（六个字段、`domain:id`、`kind` / `stage` / `updated` 取值、slug 形态、正文非空）在浏览器里跑一遍，词汇表直接取自快照发布的 `source.kinds` / `source.stages` / `source.domains`——**页面不再自己抄一份**，避免这里放行而采集器报错。快照没带词汇表时只跳过取值检查，不凭空报错。
- **失败信息**：推送被拒时只转发 GitHub 自己的那句话（截 200 字符），请求头、路径与令牌都不外泄；失败的草稿保留原样。

口径与隐私提醒：注册表是**本仓库对自己的描述**，不是外部指标来源，改动仍然走 git 提交——页内回写只是把「编辑文件 + 提交」搬到浏览器里，它不碰任何指标，也不改采集器。条目文本（标题、标签、正文、来源原因）渲染时统一转义，链接只接受 `http(s)` 形态，条目源文件链接一律由采集器按 `--repo` / `--branch` 拼成 `https://github.com/<repo>/blob/<branch>/entities/<slug>.md`（slug 用文件名的原始写法，保证指向真实存在的路径），CSV 导出对以 `=`、`+`、`-`、`@` 开头的单元格加前置单引号。**私有监控录像、摄像头标识与人员档案不进入 `entities/`，也不进入任何发布载荷**：注册表里关于这类工作只写公开的研究对象与其关系，`entities/argus-visual-decision.md` 里就把这条边界写在了正文中。


## 任务看板：数据来源与口径

「任务看板」栏目把 `tasks/` 里手写的任务卡索引成一张能拖动的画布，由 `scripts/collect_tasks.py` 采集。**一个任务一个文件**：front matter 写结构（状态、从哪张卡拆出来、等谁、服务于哪个研究对象或哪个截止），正文写只有作者知道的验收说明。格式沿用 `entities/` 那一套——同一个解析器、同一条 slug 规则、同一种失败行为。这一步不访问任何外部 API：引用的核对来自**同一天其它采集器已经发布的快照**。

| 文件 | 内容 | 页面何时读取 |
| --- | --- | --- |
| `tasks/<slug>.md` | 唯一由人维护的来源：front matter 写结构，正文写验收 | 采集器读，浏览器不读 |
| `data/tasks.json` | 索引快照：卡片、拆解与依赖两张图、引用三态、与上次采集的差异 | 滚到本栏目视口才读 |
| `data/tasks_history.json` | 逐日的任务数、边数、根任务数与六态分布 | 页面不请求，供离线分析 |

与注册表**相反，这个文件是懒加载**的：画布需要整份卡片才能连线，但首屏并没有非它不可的东西，所以 `app.js` 用一个 `IntersectionObserver` 盯住 `#tasks`，进视口才发那一次请求。代价是卡片正文会跟着索引走，因此正文有截断预算，工作流在索引超过 120 KB 时报警——先收紧卡片上的说明，而不是把画布改成"只画当前页"。

### 六个状态是这套看板自己的词，不是注册表的阶段

`proposal / doing / blocked / review / done / dropped`（提案 / 进行中 / 受阻 / 待验收 / 已完成 / 已放弃）描述的是**我**——做这件事的人此刻卡在哪一步；注册表的 `stage` 描述的是**研究对象**处于哪个阶段。两套词曾经是同一个意图，硬并成一套会让两个看板同时变得说不清事情。

- 「推进 / 回退 / 移动」按 `review`、`done` 为已完成桶判定，**不是按词表里的位置**：`doing → blocked` 是一次移动而不是倒退，画布上七条道的左右顺序也不构成进度条。
- **画布上有第七条道（未标注），文件里没有这个状态**。空 `status:` 会被 `--check` 的结构检查判为错误，所以推送在组装阶段就拒绝，而不是把坏数据写进仓库等明天 CI 报错。
- `blocked` 应该配 `reason:`（卡片上的 ⚑ 说明）。受阻没有原因**不是错误**：索引照发，页面上只是少一行说明；推送预览会把它作为一条 note 提醒作者，而不是拦下这次推送。超过 160 字符才由采集器截断并记入 `warnings`。

### 看板存的是工作，不是指标

卡片绝不复制任何数值。需要指向一个对象时写 `entity: <slug>`（注册表的 id），需要挂一个投稿窗口时写 `ddl: <环节 id>`（顶会目录的 id），**数字与倒计时仍然只有一个主人、一个 `captured_at`**：页面上的截止天数每次现取 `conferences.json`，所以顶会快照更新之后卡片上的数字会跟着动，而不会出现第二个主人。

引用与连线各有三态，全在采集时逐条对照当日快照得出：

| 状态 | 含义 | 前端 |
| --- | --- | --- |
| `已核对`（`resolved`） | 目标在对应来源当天的快照里 | 展开对象名、倒计时、反向链接 |
| `未找到`（`unresolved`） | 来源当天回答了我们，但这个 id 不在清单里：卡片要改，或对象已消失 | 排进「边与引用待办」 |
| `未核对`（`missing_index`） | 那次采集没有可用快照，什么都没说明 | 与断链分开列出，附来源原因 |

- **`missing_index` 不会被写成 `unresolved`**——采集失败与目标消失是两件事，混在一起只会训练读者忽略提示。
- 指向不存在的任务、自己连自己、成环：采集器当场挡下并发布原因，**画布用同一套规则拒绝拖动与拉线**，所以这里能连出来的线，明天仍在索引里。
- 拆解（`parent`）与依赖（`depends`）是两张图，边数分开计数，实线与虚线分开画；`depends` 的块状写法（`- item`）在推送时被折叠成行内形式，索引里只有一种形态。

### 结构与预算上限

```markdown
---
status: doing            # 六态之一；留空＝画布上的「未标注」，不能进文件
title: 任务看板画布       # 缺失时回退为文件名
parent: task-board       # 从哪张卡拆出来
depends: [collect-tasks] # 这个任务等谁
entity: mme              # 注册表里的研究对象 id
ddl: AI/cvpr:cvpr27:paper:1  # 顶会目录里的环节 id
tags: [看板, 前端]
updated: 2026-11-02      # YYYY-MM-DD，作者改的日期，不是文件 mtime
reason: 等采集口径定下来  # 受阻原因
---
正文：做到哪一步了、验收标准是什么。
```

- 文件名即 slug，需匹配 `^[a-z0-9]+(?:[-_][a-z0-9]+)*$`（小写字母、数字、连字符）；**`title` 才能写中文**。
- 上限各不相同，**超出就要说明**：卡片 400 张、边 600 条、单卡 `depends` 12 条、标题 120 字符、标签 8 个、受阻原因 160 字符；差异清单 200 条、告警 100 条并附「更多条目已省略」哨兵。
- 正文取前 20,000 字符，而 `bytes` / `lines` / `sha256` 描述**整个正文**，`blob_sha` 哈希**整个文件**：被截断的卡仍显示真实大小，只改了截断线之后的内容也仍会被认作一次修订，并且**仍会移动推送基线**——基线本来就该对这些内容敏感。
- 「今日更新」只认作者改的东西。差异键由正文 `sha256` + 标题 + 父子 + 依赖 + `entity` / `ddl` / `reason` + `updated` + 标签组成，**不含状态，也不含引用状态**：状态变化单独报成「推进 / 回退 / 移动」，一次编辑只留一条记录；引用状态跟着其它采集器每天变，那是它自己的事。`blob_sha` 只做推送基线，不进差异键。

### 画布：座标属于这台浏览器，语义属于仓库

- **拖动卡片换道＝改状态**，把一张卡拖到另一张卡上＝**拆到它下面**（写 `parent`），按住右下角把手拉到别的卡＝**建立依赖**（写 `depends`）。拒绝会当场说明原因，不会画出一条你拖不出去的线。
- 键盘等价：卡片聚焦后 `1`–`7` 换到第 N 条道，`l` 起一条依赖线（Tab 到目标卡再按一次 `l` 落线），`d` 起一次拆解，`Esc` 取消并把起点卡的名字说回来。`Esc` 只在真的有线待定时才被占用，空闲时把键还给页面。
- **座标写进 `localStorage` 的 `mo.board.layout`，永不进入仓库**；同一份存储里的 `mo.board.edits` 保存 `{edits, created, pushed, bases}` 四块：草稿、本机新建卡、推送收据与冲突基线。「整理画布」只清座标，「清空本地改动」只清语义，两件事分开，因为放弃一种摆法不代表放弃一种拆分。
- **新建卡有两个入口**：这块画布自己的表单，和「论文清单跟踪」流水每行尾的「建卡」。后者只抄那行已有的事实（来源清单、链接、分区），文件名跟着 arXiv id 走，因此同一篇论文被两份清单收录也只会落成一个 slug；它同样要推送才是文件。

### 页内回写：只写字段，正文归源文件

推送走 `site/repo.js`——与注册表、模版库**同一个写入口**，`site/tasksync.js` 只管任务自己的编排与面板。

- **Token 只进 `sessionStorage`**（键 `mo.repo.token`），只发往 `api.github.com`，本站是纯静态页、没有后端可代理，因此它也绝不会出现在任何 `data/*.json` 里。未填 Token 时画布、清单、筛选与导出照常，只有推送禁用并说明缺什么——**一次推送请求都不会发出**。
- **组装发生在远端原文上，不是在索引副本上**：预览与推送都先 `GET tasks/<slug>.md` 拿到远端当前文本，只替换这张卡改过的字段（更新卡是 `status` / `parent` / `depends` + 必刷的 `updated`；新建卡另写 `title` / `entity` / `ddl` / `tags`）。索引里的正文是截断副本，用它推送会丢掉截断线之后的段落。
- **冲突是三方问题**，所以基线记在 `mo.board.edits.bases`：本浏览器最后一次读到或写出的那份远端内容。三方比较（基线 / 远端 / 你的草稿）而不是「索引 vs 远端」，否则远端每天在你之后被采集器读到，每张卡都会天天喊冲突。冲突时三选：**按远端重做基线**（远端已经是你想要的值就从草稿里去掉，其余保留）、**以远端为准**（丢弃草稿）、**明确覆盖并推送**。「推送全部」按钮不构成覆盖授权。
- **新建卡有竞态保护**：点推送时若远端已出现同名文件，且它带 front matter，就降级为"只把卡片字段写进它的原文"，本地正文不覆盖过去；若它不带 front matter，直接拒绝——这里不重写一份采集器读不到的文件。
- **推送成功后卡片不会当场改数**：收据 `{signature, commit, at}` 写入本机，卡片显示「已推送 · 等索引」，直到次日采集器重建索引才与站点数据一致。此时再拖动会重新变成「本地改动」，因为草稿是草稿、收据是收据。

### 清单与导出

清单视图每页 12 条、8 列（任务 / 状态 / 父任务 / 依赖 / 引用 / 标签 / 更新 / 详情），搜索覆盖任务名、文件名、标签、正文与被引对象；可按标签、引用状态（含「仅断引用」「仅未核对」「仅挂了截止」「仅无父任务」）筛选，按更新时间 / 状态（受阻优先）/ 截止时间 / 名称排序。CSV 导出**当前筛选结果**而不是当前页，17 列为 `slug, title, status, parent, depends, entity, entity_state, ddl, ddl_state, deadline_utc, days_left, tags, updated, reason, draft_state, pushed_at, source_url`；`draft_state` 取 `pushed / local / none`，`deadline_utc` 与 `days_left` 是从顶会看板当场算出的视图而非第二份数据，**不含正文**。

### 采集失败时的行为

| 情况 | 行为 |
| --- | --- |
| `tasks/` 目录不存在 | 保留上次快照，`status` 置 `stale`（没有历史时写 `unavailable` 空壳），原因写入 `error` |
| 文件名非法 | 跳过该文件并记入 `structural_errors`（其余卡片照常发布） |
| front matter 无法解析、`status` 不是六态、`updated` 不是 `YYYY-MM-DD` | 字段按未标注处理，卡片仍发布，问题记入 `structural_errors`（`--check` 会失败） |
| 父子或依赖指向不存在的卡、自己连自己、成环 | 该条边不发布，写入 `graph.dropped` 并注明原因（`missing` / `self` / `cycle`）；`validation.parent_missing` 单独统计「父卡不存在」的卡片数，与 `summary.roots`（本来就没有父的根任务）是两件事 |
| `depends` 超过 12 条、卡片或边超预算、正文与标签截断 | 截断发布并记入 `warnings` |
| 注册表或顶会目录当天不可用 | `entity_state` / `ddl_state` 置 `missing_index` 并把原因写进来源块，**不谎报断链** |
| 采集时间早于已有快照 | 拒绝写入，防止旧数据覆盖新数据 |
| 快照缺失、`schema_version` 或 `source.id` 不认识 | 前端仅本栏目降级为「任务数据暂不可用」，其它板块照常加载 |

`captured_at` 只在成功时更新，`last_attempt_at` 每次运行都更新；失败时**不做部分写入**，上次快照整份保留。对外发布的失败原因来自固定文案表，不含路径、令牌或响应原文。本地写作可用 `python scripts/collect_tasks.py --check`（只解析与核对，不写文件；同时打印索引规模与引用三态计数）、`--strict`（把断引用也判为失败）、`--ids [--domain entity|ddl --grep 片段]`（列出本次能指向的真实 id）。工作流最后一步在 `data/tasks.json` 超过 120 KB 时发出 warning：画布要整份下载才能连线，长说明应该写在 Markdown 里。

口径与隐私提醒：任务卡描述的是**你正在做的工作**，不是外部指标来源，改动仍然走 git 提交——页内回写只是把「编辑文件 + 提交」搬到浏览器里，它不碰任何指标，也不改采集器。卡片文本（标题、标签、正文、受阻原因）渲染时统一转义，链接只接受 `http(s)` 形态，源文件链接一律由采集器按 `--repo` / `--branch` 拼成 `https://github.com/<repo>/blob/<branch>/tasks/<slug>.md`（slug 用文件名的原始写法，保证指向真实存在的路径），CSV 导出对以 `=`、`+`、`-`、`@` 开头的单元格加前置单引号。**私有监控录像、摄像头标识与人员档案不进入 `tasks/`，也不进入任何发布载荷**：这个仓库和它的数据文件都是公开的，卡片只写公开的研究对象、公开仓库与工作本身的一句话说明。


## 论文清单跟踪：数据来源与口径

「论文清单跟踪」栏目把六个公开清单**逐行数过**，由 `scripts/collect_awesome.py` 采集。读的只是别人仓库里的公开文件：正文一律走 `https://raw.githubusercontent.com/<repo>/HEAD/<path>`（匿名、不需要令牌），每个清单再打一次 `api.github.com/repos/<repo>/commits?path=…&per_page=3` 问「这个文件上次何时动过」。整份 Markdown 只出现在采集端，页面拿到的是结构——计数、覆盖率、节奏与一小段最近条目，**没有正文**。

| 清单 | 形态 | 读什么 | 为什么这样读 |
| --- | --- | --- | --- |
| `isLinXu/awesome-agent-world-model` | `markdown-table` | `docs/papers.md` | 按滚动窗口维护，旧条目会被删掉；移出因此标 `rolling_window`，不算数据丢失 |
| `isLinXu/awesome-native-multimodal-models` | `markdown-table` | `README.md` | 每个分区的表头都不一样，六个清单里只有标题和链接是有保证的列 |
| `isLinXu/awesome-visual-reasoning` | `machine-json` | `data/papers.json` + `data/stats.json` | 清单自己发布结构化索引：前者逐行数过，后者原样放进自报列 |
| `BradyFU/Awesome-Multimodal-Large-Language-Models` | `markdown-table` | `README.md`，标 `upstream` | 别人的仓库：行数照常计数与公布，但不进本站任何合计 |
| `isLinXu/paper-list` | `topic-archives` | `README.md` 的主题索引 → 最新归档月的主题分册 | 5 万余行不该每天重下一遍，改按主题比最新月 |
| `isLinXu/idea-research-list` | `report` | `docs/04-论文清单与图鉴.md` | 一次性调研报告，没有更新流：只登记基线，新增与移出一律 `null`；正文按会议引用论文，无外链但认得出会议或日期的行仍算条目（见「行准入」） |

四种形态**故意不共用一个解析器**：它们不是同一种对象。把机器人维护的滚动表、发布 JSON 的索引、按月归档的主题库和一份报告塞进同一个 reader，只会让最先崩的那个形态拖垮其它三个。

### 实测与自报：并排放，永不相加

- `measured` 是本站今天在抓到的字节里数出来的：条目数、带 arXiv / 代码链接 / 日期 / 会议的行数、去重后的 id 数、日期精度分布、分区数、被跳过的行（按原因拆成三个，见下）、`recent` 年龄分桶，以及这份数是**全量还是下限**（`byte_capped`）。
- `self_reported` 是仓库对自己的说法——它自己的 `data/stats.json`、README 徽章、`Total papers: **N**` 那一行。两列并排展示（「实测与自报」面板深色＝逐行数过、浅色＝仓库自己的说法），**不相加、不相除、不互为分母**。
- 徽章自报多个互不相同的数字时不挑一个「对」的用：`values` 把冲突都列出来，`entries` 取其中**最大**的一个，并在告警里说明「本页一律以实测计数为准」。
- `paper-list` 是这套规则最直白的例子：各主题索引页自报的 `Total papers` 之和是 5 万余，本站只逐行数过**归档月份等于全局最新月份的那批主题页**，且最多取 6 个主题（一篇论文常同时归档在几个主题下，跨主题按 id 去重，所以实测几百条）。**这两个数不可比**，页面上就写不可比，不折算成"覆盖率 0.7%"之类的假指标。
- **一个数字只有一个归属**：本站测的 star、fork、`pushed_at`、粉丝数只在 `data/github.json` 与 `data/stars_repos.json` 里，本栏目的 `measured` 一个都不复制。唯一的例外是**别人对自己清单的自述**：`awesome-native-multimodal-models` 的 `data/stats.json` 里写了它收录仓库的 star 之和，这个数原样放在 `self_reported.extra` 里并注明「那是别人仓库的 star 之和，与本站任何指标都不同源」——删掉它是替别人改口径，拿它当本站指标更是。`cadence` 只回答「这个文件上次何时动过」——`pushed_at` 回答不了，因为往任何其它路径推一次都会移动它。

### 什么算一条：行准入与 `skipped` 归账

一行 markdown 成为「条目」的条件按清单形态不同，而且**差别是发布出来的，不靠读者猜**：

- **表格类清单**（`markdown-table`）带链接列，因此**没有链接的行不算条目**——那类行是排行榜、导航表或统计表，长得像表格但不是一份论文。它们计入 `skipped_no_link`。
- **`skipped_no_link` 里其实是两种行，本站把这个区别发布出来**：`measured.paper_table_rows_without_link` 数的是「所在表的表头点名了链接列（复用已有的 `COLUMN_ROLES` 判定：`链接`/`link`/`pdf`/`arxiv`/`url`），这一行自己却一个链接都没写」的行——清单把它放进了论文表、把链接留空，那是漏了链接，不是漏了表格。剩下的无链接行落在没有链接列的表里（时间线、名次表、导航），去掉它们不是少数了论文。有这个数在，「实测条目数」才敢被读成**下限**而不是终值。
- **为什么不干脆把这批行算作条目**：改判会让第二天的台账报出一大坨「新增」——那是本站换了规则，不是清单长了论文；而且没有链接的行在页面上点不到，把它计入「条目」就让条目和能读的东西分家了。所以这里只发布区别，不改准入。本轮（2026-11-03）`isLinXu/awesome-native-multimodal-models` 的 193 行无链接拆成 **126**（表头没有可识别的链接列）／**5**（只有指向该清单自己 Pages 站或仓内相对路径 PDF 的自链接）／**62**（论文表里把链接留空）。
- **一次性报告**（`report`，即 `idea-research-list`）根本没有链接列：正文按「会议名 + 论文名」引用论文，很多行天然没有外链。这里改成**认得出会议或日期就算条目**，`unlinked_rows` 说明其中多少行没有链接，只有两者都认不出的行才计入 `skipped_no_signal`。这条规则只作用于报告类清单：把它套到表格清单上，`awesome-native-multimodal-models` 会一次多出近 80 行时间线与名次表。
- 认不出标题的行计入 `skipped_no_title`（也是这类行不能进台账的原因）。
- 三个原因之和恒等于 `skipped`，每条卡片的「没成为条目的行」把这份账摊开——`skipped` 不是一个说不清的数字。摊开时也说清去掉的是哪一种：这个子集**缺席**（`null`，机器 JSON 与主题归档没有「行」可判）不等于 0；0 说的是「无链接的行没有一个落在点名了链接列的表里，去掉的是导航表与榜单，不是论文」。

### 清单有多新：`recent` 与归档月月龄

`measured.recent` 把已经数过的条目按年龄分桶（`within_90d` / `within_365d` / `older` / `undated`），日期优先取 arXiv id 自己的 `YYMM`，其次取行内识别出的日期；**只有年份的按当年 1 月计**——这只会让条目显得更老，因此不会把「近 90 天」inflate 成虚高。`undated` 单独成桶，认不出日期不等于 2026 年。`paper-list` 另发 `newest_month_age_days`（最新归档月距今天数），因为「最新月是 2026-10」和「最新月距今 32 天」对读者是两个信息，前者会被下一个归档月直接顶掉。这两个字段只用已下载的内容算出，**不多打一次请求**。

### 增删是台账算出来的，不是猜的

条目身份是一个小而稳定的 key（`arxiv:<id>`，没有 arXiv id 时用 `title:<slug>`），记在 `data/awesome_ledger.json` 里。有了它，"新增 / 移出"才是事实而不是猜测：

- **slug 只保留 ASCII 字母与数字**，中文标题会压成空串，所以压不成 slug 的行改用**标题自己的 SHA-256 前 16 位**。若退化成对空串取哈希，所有中文标题会共用一个 id，清单就安静地少掉大半——没有标题的行不进台账，只计入 `skipped_no_title`。**身份 key 只有 `arxiv:` 与 `title:` 两种**：过去那个「链接哈希」分支已经删掉——认身份时标题已经是硬前提（没有标题的行在此之前就进了 `skipped_no_title`），而 `slugify()` 对压不成 slug 的标题回退到标题自身的哈希，所以永远存在一个非空 key，那个分支一步都走不到。留着它只会让人以为同一篇论文换个链接就会被认成新条目。
- 首次读到某清单时 `diff.baseline` 为真，`note` 写明「本次只建立基线，明日起的新增与移出才是可信的变化量」——**第一次抓到 2,860 行不等于今天新增了 2,860 条**。
- 台账每清单最多记 `LEDGER_ID_LIMIT` 个 id。超出时不悄悄丢弃：`diff.truncated` 置真、告警说明「新增与移出因此是下限而非全量」，**台账里同时记下 `capped`**。下一次运行看到上次是被截断的，就发布 `added: null` / `removed: null` 并说明不可比——被记住的只是前 N 个 id，剩下的每天都会看起来像「新增」。
- 两个来源故意不走逐行台账：`paper-list` 比的是「主题 × 最新归档月」这对 key（`month:<主题>:<YYYY-MM>`），`idea-research-list` 是基线、没有更新流。
- 同一行在一份文件里重复出现、或换到另一个分区，**既不算新增也不算移出**：身份是 id，不是「文件名 + 分区」。
- 采集失败的那一清单一整行沿用上次结果并标 `stale`，`last_attempt_at` 仍然更新；「今天没读到」与「清单里少了条目」是两件事。
- **本次根本没去抓的清单**（`MAX_FETCHES` 用尽、或 `--only` 排除了它）也留着一整行，带 `not_attempted: true`、`error` 固定文案，**`last_attempt_at` 不前进**（没尝试过就不能写一次尝试的时间），它的台账 id 原样保留。把行删掉会同时删掉台账，明天这条清单就成了「第一次见到」。

### 节奏：以文件为单位，不按仓库

`cadence` 取该清单文件最近三次提交里最新的一条，`stale_days` 是它距今天的天数，标签为 `daily`（≤2 天）/ `weekly`（≤9）/ `monthly`（≤40）/ `manual`（更久）。提交者是不是 bot 与第一行提交说明一并公布，所以「每天凌晨被 github-actions[bot] 重写」和「作者半年前手改过一次」在页面上不是一回事。超过 `STALL_AFTER_DAYS`（45 天）标 `stalled`，前端筛选里的「仅停更」用的就是这个字段。查不到提交时 `status: "unknown"`、各计数为 `null`——接口挂了不能写成「这个清单 0 天没动」。

### 趋势：读逐日历史，但不把沿用值当成持平

「逐日观测趋势」画的是 `data/awesome_history.json`：自有实测条目与上游实测条目**两条线**（不是相加），另一个可切换的指标是「当日可读清单数」。三条口径写在图注里，而不是等读者自己推断：

- **少于三个点不解释斜率**：两点连出来的是一条直线，中间发生了什么它不知道，图注就写「样本太少，看不出趋势」，并给出一个可以回来的日子：`readyOn` = 最后一个已记录日 + 还差的点数（按每日一次的节奏推算）。这是**排期不是观测**——中间漏跑一次，日期就顺延，本站不补造历史让第 3 天提前。
- **净变化只比两端**（首日 → 末日），不把每天的 `added` 加起来：沿用的那天报 0 新增，重读的那天会把同一条目再说成一次新增——加出来的总数两种都不是。
- **没读全的日子标出来**：`repos < tracked` 的那天发布的是沿用数字，曲线在那里走平意味着「那天没读到」，不是「清单没长」。`retention` 字段把逐日/按月的留存规则一起发布，读者知道早段为什么是一个月一个点。

历史文件是**第二个来源、第二种失败**：读不到它只让这张图空着并在图注说明原因，当日快照、卡片与流水照常，也不弹提示。

### 结构与预算上限

```python
TITLE_LIMIT = 200           # 单条标题
SECTION_LIMIT = 60          # 分区名
SAMPLE_LIMIT = 40           # 每清单发布的最近条目
LEDGER_ID_LIMIT = 4000      # 每清单记住的 id
TOPIC_LIMIT = 40            # paper-list 的主题索引页
MONTH_SAMPLE_LIMIT = 6      # 真正逐行数过的主题分页数
MAX_BYTES = 2_500_000       # 单个抓取文件
MAX_FETCHES = 80            # 单次运行抓取文件数
WARNING_LIMIT = 100         # 告警条数
CHANGE_LIMIT = 120          # 差异清单条数
STALL_AFTER_DAYS = 45       # 停更判定
PAYLOAD_BUDGET_BYTES = 122_880   # 索引（浏览器要下载）120 KB
LEDGER_BUDGET_BYTES = 204_800    # 台账（仓库自己留着）200 KB
```

- 每一个上限的存在理由相同：**别人仓库的增长不能变成本站无界的下载，也不能变成本站无界的载荷**。撞到 `MAX_FETCHES` 时剩余清单留到下一次运行，而不是把这次伪装成成功；索引里的 `fetches.max_files` 与 `fetches.budget_hit` 把「这次跑了几个 / 上限多少 / 有没有没轮到的」写在文件里。
- 单个文件超过 `MAX_BYTES` 时**在上限处切片**，读到的部分照常逐行数过，但这份清单的 `measured.byte_capped` 置真、`files[].truncated` 逐文件标注，告警与卡片都写明「实测条目数是**下限**」。截至最近一次运行，最大的清单文件是 1,073,876 B，还没撞到 2,500,000 B 的上限——这条规则是给别人的仓库留的余地，不是给本站留的借口。
- 索引超过 120 KB 预算时，**削的是样本尾巴，不是数字**：从每清单 40 条起，一轮砍 5 条、只砍样本，`measured`、`self_reported` 与台账都不受影响；告警会写清本次压到了多少条，`sizes.sample_limit_applied` 也把「这次真的发了几条」写在文件里——`source.budget.sample_limit` 是上限，不是本次的发货量。样本全砍完仍超预算则如实报超——要么少跟一个清单，要么抬预算，不能让读者下载一个越来越大的文件。
- 台账超预算**只报不砍**：删掉的 id 明天会被重新算成「新增」，砍台账就是造假变化量。该调的是 `LEDGER_ID_LIMIT`，工作流与页面告警都这么写。
- `data/awesome.json` 自己报告写盘字节数（`sizes.payload_bytes`，与磁盘上的紧凑 JSON 完全一致：包含这个字段本身，也包含**随后追加的告警文本**——量的是最后那一次写入），页面状态行显示「快照 72 KB／预算 120 KB」，超预算时标红。
- 工作流在 `data/awesome.json` > 120 KB、`data/awesome_ledger.json` > 200 KB 时分别发出 warning。

### 只看结构，不搬运正文

原始 Markdown 不进入载荷：条目只保留标题、链接、arXiv id、日期、会议与所在分区，标题限 200 字符，分区名限 60。日期按四种形态从行文本里认（`YYYY-MM-DD` / `YYYY-MM` / `YYYY Qn` / `YYYY`），**但 id 里的四位前缀不是年份**：`arxiv.org/abs/1905.12345` 是 2019 年 5 月的论文，行内只有这一个日期时按 id 自己的 `YYMM` 发布 `2019-05`（`precision: month`），不发布「1905 年」。有些文件以 AIGC 溯源块开头，那个块用 `---` 包住，长得和 front matter 一模一样——朴素解析器会把一段 base64 当成元数据读进去、然后一个条目也找不到，所以采集器先剥掉它。所有链接在发布前重新过一次 `http(s)` 白名单，前端渲染时再转义一次；两个仓库名的形态在采集端就按 `https://github.com/<owner>/<name>` 校验，因此源文件链接必然指向真实路径。

### 采集失败时的行为

| 情况 | 行为 |
| --- | --- |
| 某个清单抓不到（404、限流、超时） | 该清单整行沿用上次快照并标 `stale`，`error` 写固定文案；其它清单照常 |
| 所有清单都没读到 | 保留上次整份快照并标 `stale`（没有历史时写 `unavailable`），`captured_at` 沿用旧值，本次的 `last_attempt_at`、抓取计数与告警照常更新 |
| 部分清单读到 | `status` 置 `partial`，读到的照常发布，刷新按钮给出对应措辞的提示 |
| 提交节奏查不到 | `cadence.status` 置 `unknown`，各计数为 `null`，不写成「0 天没动」 |
| 表头认不出 / 没有标题列 | 该分区计入 `skipped`，不猜列；每条 skip 归入 `skipped_no_title` / `skipped_no_link` / `skipped_no_signal` 三个原因之一 |
| 表头点名了链接列、这一行却没写链接 | **准入不变**（不算条目），但 `measured.paper_table_rows_without_link` 单独公布这一子类：大于 0 时实测条目数按**下限**读，等于 0 说明去掉的是导航表与榜单而不是论文，缺席（机器 JSON 与主题归档没有「行」可判）不说成 0 |
| 单个文件超过 `MAX_BYTES` | 在上限处切片，读到的部分照常数，但 `measured.byte_capped` 置真、该文件标 `truncated`，实测条目数按**下限**发布并写进告警 |
| 文件读到了却一行条目都没认出 | 按**清单换格式**处理：沿用上次快照并标 `stale`，台账不动，发布的原因是「格式认不出任何条目」——绝不发布 0 条，否则明天的差异就成了「整份清单被删光」。原因是「额度用尽」还是「服务器没给」分开写（`budget` / `network`），本站不把没问过当成 404 |
| id 超过 `LEDGER_ID_LIMIT`、样本或告警超预算 | 截断发布并记入 `warnings`（差异标 `truncated`，说明它是下限；**下一次**运行发现上次被截断就改发 `added: null`，不报一个虚增数） |
| 抓取达到 `MAX_FETCHES` | 剩余清单留到下一次并写入告警，`fetches.budget_hit` 置真。它们**仍然各占一行**（`not_attempted: true`，沿用上次数字、`last_attempt_at` 不动，台账不删），没读到的一律不是 `ok`，所以本次最多算 `partial` |
| `paper-list` 的主题页没全轮到 | 没问过的主题标 `topics[].error: no_budget`、`measured.topics_not_attempted` 计数并出告警；已读到的主题照常发布 |
| 用 `--only` 只跑其中几份 | 同上：这次没跑的清单位沿用上次并标 `not_attempted`，索引里的 `source.repos` 仍然列出全部行——**只有从 `SOURCES` 里删掉一个条目才叫停止跟踪**，那才会把它报成「已移除」 |
| 采集时间早于已有快照 | 拒绝写入，防止旧数据覆盖新数据 |
| 快照缺失、`schema_version` 或 `source.id` 不认识 | 前端仅本栏目降级为「清单数据暂不可用」，其它板块照常加载 |

`captured_at` 只在该清单成功时更新，`last_attempt_at` 每次运行都更新；失败不做部分写入，上次快照整份保留。对外发布的失败原因来自固定文案表，不含路径、令牌或响应原文。本地可以 `python scripts/collect_awesome.py --check`（抓取与汇总但不写文件，打印索引与台账规模）、`--only isLinXu/paper-list`（重复可用，只跟部分清单）、`--offline DIR`（从 `DIR/<owner>/<name>/<path>` 读录音文件，节奏改读 `<owner>/<name>/.github/commits.json`，测试与断网复现都用它）。

### `--check` 的退出码与 CI 告警：谁负责变红

- **`--check` 对 `partial` 返回 0**，这是刻意的口径而不是疏漏：六个清单里多数是别人仓库的内容，某份今天读不到是一条**观测结果**，不是采集器坏了。把 `partial` 算作失败会让本地 `--check` 天天红，而天天红的信号等于没有信号。真正一份都没读到（`stale` 无历史 / `unavailable`）才返回 1。
- 代价由「报得够响」支付，不靠退出码：`--check` 打印的标题直接带状态词（`check partial: …`），汇总末尾在有小节没读到或预算用尽时追加「本轮没读到（数字是沿用的）：owner/name…」与「抓取预算 80/80 已用尽」，随后打印本次的十条告警——本地看不到失败信号的那句话，现在写在同一屏里。
- **升级告警是工作流的事**。「Report list tracking sizes」一步读完快照后把坏消息逐条转成 workflow annotation（`::warning::`）：状态不是 `ok`、有清单本轮没读到、单文件撞了字节上限、抓取预算用尽（含用到 80 % 的余量提醒）、索引或台账用到 80 % 预算，以及仍在搭基线的清单数。基线那条只在台账原本不存在时发——已跟踪的仓库突然回到基线，说明台账丢了，是另一条告警。CI 变黄、本地退出码表示「采集器跑通了」，两边各司其职，都不需要读者去开页面。
- 「没预算」与「服务器说没有这个文件」在本地采集时直接打印；面向页面只留措辞分开的两条：前者写「本轮抓取预算已用满，以下主题文件没有问到」，后者才写「不存在」。

### 只看一份清单，以及它和实体注册表的关系

- **「只看这份」**（卡片底部）把 `awesomeFocus` 设成那个仓库：卡片与「论文流水」同时收敛到这一份清单，工具栏出现一个可点的虚线 chip（`只看 owner/name`）提醒读者现在看的不是全部，点它或再点一次卡片按钮都取消。它和搜索、形态、归属、节奏、状态筛选走同一条过滤链，因此也归「重置筛选」管——取消后各筛选条件不动。
- **卡片明细里的「实体注册表」一行**只问一个问题：这份仓库被哪些实体条目登记过。它列出条目的 slug 与标题、对象状态（`已解析` / `断链` / `未核对` / `范围外`），点 chip 跳到注册表做反查（等同注册表里的反查芯片）。**数字不跨栏目复制**：这一行不出现条目数、覆盖率或 star——关系归注册表，计数归本栏目，两边各自只有一个归属（见「实体注册表」一节：那 6 条 `kind: project` 条目刻意不抄计数）。
- 没被登记的清单写「还没有条目登记这份仓库」，而不是空着——空白在这里会被读成读取失败。注册表索引尚未载入时说明「载入后这里会列出…」，不写 0。

### 流水的一行变成一张任务卡

- 每行标题后面跟着一个「建卡」。它只把**这行已经说过**的事实写进一张本机草稿——条目来自哪份清单、有没有链接、在清单里的哪个分区——然后交给任务看板的 `create`。推送才会成为 `tasks/<slug>.md`，与页内新建的卡走同一条路、同一套竞态保护；不推送就只在这台浏览器的 `mo.board.edits.created` 里。
- 文件名跟着 arXiv id 走（`arxiv:2611.01790` → `paper-2611-01790`），所以同一篇论文出现在两份清单里也只有一张卡：再点一次说的是「已经在看板上」，不是做第二张。没有 arXiv id 的行退回条目 id 去掉前缀的形态；两者都没有就拒绝，并说明取不出一个能重复点击的文件名——这里不发明随机名。
- **计数不跨栏目复制**：卡里没有条目数、覆盖率、更新节奏或停更天数。那句「清单的条目数与更新节奏归『论文清单跟踪』栏目」写在正文里，是为了让半年后打开这张卡的人知道该去哪儿看数。
- 状态一律从 `proposal` 起：清单担保过这篇论文存在，没有替你决定要不要读。

### 导出列

CSV 导出的是**当前筛选后的样本流水**（含「只看一份」），20 列：`repo, ownership, list_kind, entry_id, title, url, arxiv_id, published, venue, section, is_new, measured_entries, self_reported_entries, list_status, list_read_today, cadence, stale_days, list_captured_at, snapshot_status, snapshot_captured_at`。四个"何时/什么状态"的列各有分工：`list_status` 是这一行今天的状态，`list_read_today` 区分「今天读到的」与「沿用上次快照的」（`stale` 本身分不清是没读到还是读到但失败），`list_captured_at` 是该清单最后一次成功读取，`snapshot_status` 是产生这份文件的那次运行（`ok` / `partial` / `stale`）——在表格里筛 `partial` 就能把沿用的数字整体排除。实测与自报仍是两列，`url` 已经过 `http(s)` 白名单，公式前缀保护照常。

口径与隐私提醒：本栏目跟踪的是**公开的清单仓库**，页面下载的是本站已经发布的结构文件——读者的「刷新已发布快照」只重读 `data/awesome.json` 一次，绝不会替读者的点击去访问别人的仓库。`data/awesome_ledger.json` 要分两件事说，混着讲会讲错：**它是公开可见的**——每日工作流把它连同快照一起提交进这个公开仓库，因为「新增 / 移出」是拿今天的 id 集合比昨天的算出来的，而 Pages 没有服务端存储，仓库就是采集器唯一的跨日记忆；**它不是页面数据**——`scripts/build.py` 不把它复制进 `_site/`，`site/*.js` 里也没有一处请求它，读者能下载的只有索引与流水。所以「不公开」是错的措辞，「不发布」才是事实，两侧各有断言兜着（`tests/test_wiring.py`：工作流里必须有它、发布清单与页面请求里必须没有它）。条目文本（标题、分区、提交说明）渲染时统一转义，链接只接受 `http(s)` 形态，CSV 导出对以 `=`、`+`、`-`、`@` 开头的单元格加前置单引号，导出的是**当前筛选后的样本流水**而不是整份清单。

## 模型清单核实（HOMC）：数据来源与口径

「模型清单核实」栏目读的是 `isLinXu/model-list` 仓库里的 `README.md`，由 `scripts/collect_homc.py` 采集。这份清单的计量单位不是「一行模型」而是**一条核实声明**：§2.0 把本轮增量拆成 🆕 新增已核实 / 🔄 更新已核实 / ⚠️ 待确认三张总表，每行的信息来源列标 A / B / C，并写明「只有一个 B 源的行，日期与参数须复核」。它的 Pages 站 `https://islinxu.github.io/model-list/` 由同一份 README 生成，所以**这里读源文件、只把站点当出口链**——解析渲染后的页面等于在量我们对它标记的猜测。

| 读什么 | 位置 | 拿到的是 |
| --- | --- | --- |
| 三张总表 | `README.md` §2.0.2 / §2.0.3 / §2.0.4 | 逐行的名称、提供方、日期、类别、能力、可用状态、来源等级、行首标记，以及本站数出来的三态行数 |
| 核实表共同的列契约 | 每张表的表头 | 七列必须按既定顺序出现，第八列允许长大（`标记…`）；列对不上的一律**不计入**并点名是哪张表 |
| 花色索引 | §1.6（♠ ♥ ♦ ♣ 🃏） | 只对同名行把花色抄到行首；`suit_matched` / `suit_unmatched` 说的是这份对得上多少 |
| 核心统计 | 「核心统计」表 | 清单对自己的说法（`model_series` / `arxiv_papers` / `github_repos` / `hf_links` / `vendors` / `benchmarks` / `increment`），原样发布 |
| 核实截止日 | §2.0 标题里的「截至 YYYY-MM-DD」 | `as_of` 与 `as_of_age_days`——认不出来就告警，不代替他们标注 |
| 文件节奏 | `api.github.com/repos/…/commits?path=README.md` | 上次何时提交、作者是谁、是不是机器人 |

### 实测与自报：差是事实，不是要抹平的误差

- `measured.rows.total` 是本站在**这次抓到的字节里**数出来的表格行；`self_reported.increment` 是清单在「核心统计」里写给自己的本轮核实条数。`comparison.delta` 把差发布出来，`compare_claim` 同时在告警里写「两个数都保留，谁也不改成对方的数」——深色条是本站数的，浅色条是他们的说法，两者不相减、不互为分母。
- **区间不取整**：`200+` 这类写法原样进 `…_claimed`；只有既不含 `+` 也不含「约」的值才另发一个整数。把 `200+` 写成 200 就变成本站的数字了，页面上那句「区间或约数，本站不替他们取整」就是为此。
- 自报的 🆕／🔄／⚠️ 拆分从「核心统计」的说明文字里认（`🆕 新增 N / 🔄 更新 M / ⚠️ 待确认 K`）；认出总数认不出拆分时**只报总数并告警说明**，不猜三个数。
- 这一栏与**本站的 Hugging Face 下载观测永不相加**：那个数的是模型仓库，这个数的是别人的核实条目，不是同一批对象。这条写在 `source.caliber.never_merged` 里，随载荷一起发布。

### 等级是清单判的，本站只转述

`[A]` / `[B]` / `[C]` 从该行的信息来源列里读，含义按他们的口径发布：A 厂商一手、B 独立二手（最好两处）、C 单一二手或传闻。所以页面只说「这份清单把这一行标成 A」，永远不说「这一行是真的」——**核实归他们，本站没有替任何一行去开过厂商页面**。三条由此分开的口径：

- `measured.grades` 是「**带该级来源的行数**」，一行可以同时列 A 与 B，所以三级之和可以大于行数合计；这句写在 `caliber.grades` 里，不等读者自己推断。
- `single_b_source` 只由**形状**判定（这一行只标了一个 `[B]`，且没有 A／C）；清单自己在说明列写的「单一 B 源须复核」是另一件事，存在 `row.note` 里。两者并存、互不改写，谁也不把谁当成对方。
- 一行的等级、日期或类别认不出来时降级成 `null` 并照常成行，而不是丢掉——丢掉会让「实测行数」变成「本站认得出的行数」。

### 什么算一行：列契约、重复行与指向章节的行

- **表头不合规的表不计入**，但点名：状态小节里一张列序对不上既定七列的表，会被写成「`<表名>`：N 张表的列与既定核实表不一致，未计入」。按它计数就是把许可证列读成日期列。
- **同一模型应只落在三张表之一**：`homc:<名称 slug>|<提供方 slug>` 这个 id 第二次出现时按首次计并告警，因为「重复」是这份文档的性质，值得说一句，而不是安静地去重。所以 `rows_parsed` 可能小于三态行数之和，页面把两个数都写出来（`statHomcRowsSub`）。
- **行首标记与所在表不一致时按所在表归类**，`marker_mismatch` 单独公布这个数——本站不替清单改判 🆕 还是 ⚠️。
- **指向章节的纠偏行照数并单独标注**（`section_reference_rows`、行上的「指向章节」芯片）：它是不是一个模型由清单决定，本站只负责数到了并说清是哪一行。
- 名称为空的行只留 id；纯中文名称压不成 slug 时退化成哈希，因为 id 要有个能重复点击的写法，而不是因为名字不是英文就不是一行。

### 两种「新」：`as_of` 与文件节奏

`cadence` 问的是 `README.md` **这个文件**上次何时被提交（含提交者与是不是机器人），`as_of` 是清单在 §2.0 标题里标注的核实截止日，`as_of_age_days` 是它的月龄。这两件事在这份仓库里特别容易混：它的提交里含自己生成的每日自动日报（§2.0.8），所以「README 每天都动」为真，**「人工核实表每天都在核」不为真**。因此 `caliber.cadence` 随载荷发布那句话，页面上「日更 / 周更 / 停更」的标签只描述文件，一轮核实有多新看 `as_of` 与它的天数。超过 `STALL_AFTER_DAYS`（45 天）标 `stalled` 并告警——那条告警说的是总表按人工核对节奏看待，不是清单坏了。

### 增删是台账算出来的，不是猜的

行的身份 id 记在 `data/homc_ledger.json`：

- **第一次读到只建基线**：`diff.baseline` 为真，KPI 写「基线」，正文写「首次读到：记下 N 个 id，明日起才是变化量」。今天数到 194 行不等于今天新增 194 行。
- 台账最多记 `LEDGER_ID_LIMIT`（4000）个 id；超出时 `capped` 与 `diff.truncated` 置真、增删按下限报告，下一次运行发现上次被截断就不报变化——被忘掉的那批 id 每天都会看起来像新增。
- `rows[].is_new` 由台账里真正的「新增」标记，前端的「仅本次新增的行」与「先看本次新增」用的都是它，不是按日期猜的。
- 与清单跟踪同一套纪律：`data/homc_ledger.json` **每天随快照提交进这个公开仓库**（Pages 没有服务端存储，仓库是采集器唯一的跨日记忆），但**不作为页面数据发布**——不进 `_site/`，`site/*.js` 里没有一处请求它。`tests/test_wiring.py` 两侧都钉着。

### 样本、预算与上限

```python
ROW_LIMIT = 120             # 发布到页面的样本行数（三态轮转）
LINKS_PER_ROW = 4           # 每行保留的外链数（总数仍记 link_count）
NOTE_LIMIT = 160            # 清单写在这一行上的说明
VENDOR_LIMIT = 60           # 提供方名的长度
LEDGER_ID_LIMIT = 4000      # 台账记住的 id
STALL_AFTER_DAYS = 45       # 文件停更判定
PAYLOAD_BUDGET_BYTES = 163_840   # 快照（浏览器要下载）160 KB
LEDGER_BUDGET_BYTES = 204_800    # 台账（仓库自己留着）200 KB
ROW_TRIM_STEP = 10          # 超预算时每轮砍掉的样本行数
MAX_BYTES / MAX_FETCHES = 2_500_000 / 80   # 复用 collect_awesome 的同一套读取边界
```

- **表格是窗口，不是全量**：`rows` 按**三态轮转**取前 `ROW_LIMIT` 行（每态内部新→旧）。轮转的理由写在 `balanced_sample` 里：如果按状态排序再截尾，最大的那张表（通常是 🆕）会占满整个样本，页面就没有任何东西可说 🔄 与 ⚠️ 了。砍掉的始终是样本尾巴，`measured` 的每一个计数与台账都不因此变小——`caliber.sampled` 与表格上方的「样本是三态轮转取的窗口，不是全量」说的是同一件事。
- **超预算削的也是行数**：从 120 行起每轮减 `ROW_TRIM_STEP`，直到 fit；`sizes.row_limit_applied` 把「这次真的发了几行」写进文件，行全砍完仍超预算就如实报超并说明该砍的是每行留的链接数。台账超预算**只报不砍**（砍台账就是造假变化量）。
- `README.md` 撞上 `MAX_BYTES`（2.5 MB）时在上限处切片，读到的照常数，但 `measured.byte_capped` 与 `files[].truncated` 置真，实测行数按**下限**发布并写进告警。
- 快照自己报告写盘字节数（`sizes.payload_bytes`，与磁盘上的紧凑 JSON 一致），页面状态行显示「快照 78 KB（预算 160 KB）」，超预算标红；工作流另有一步「Report HOMC sizes」在快照 > 144 KB、台账 > 200 KB 时发 `::warning::`，并对状态不是 `ok`、实测与自报有差、README 停更、预算用到 80 % 逐条发告警。

### 采集失败时的行为

| 情况 | 行为 |
| --- | --- |
| `README.md` 抓不到（404、限流、超时） | 有上次快照就整份沿用并标 `stale`、`last_attempt_at` 前进、告警写明「今天没读到，页面显示的是 … 的快照」；没有历史就写 `unavailable` |
| 文件读到了，但三张总表一行都认不出 | 按**清单换格式**处理：沿用上次快照并标 `stale`，台账不动，绝不发布 0 行——否则明天的差异就成了「整份清单被删光」 |
| 首次运行就一行都认不出 | 直接 `unavailable`（没有可信的旧数可沿用），原因为固定文案「总表本轮一行都没解析出来」 |
| 提交节奏查不到 | `cadence.status` 置 `unknown`、各计数 `null`，不写成「0 天没动」 |
| 「核心统计」表没读到 | `self_reported` 为 `null`，页面写「这次没读到他们的核心统计表：自报数缺席，本站只报实测」——缺席不写成 0 |
| `as_of` 认不出 | 只报本站采集时间并告警，不代替他们标注口径日期 |
| 状态词不在 `ok / stale / unavailable` 里 | 前端按 `unavailable` 处理：这是别人家的状态词（清单跟踪用的 `partial` 就是一个），说明这份文件不是本栏目发布的 |
| `source.id` 或 `schema_version` 不对 | 前端拒绝整份载荷并说明格式不兼容，只让本栏目降级，其它板块照常 |
| 采集时间早于已有快照 | 拒绝写入，防止旧数据覆盖新数据 |

对外发布的失败原因来自固定文案表（`ERROR_MESSAGES`），不含路径、令牌或响应原文。本地可用 `python scripts/collect_homc.py --check`（抓取并打印，一个字节都不写）、`--offline tests/fixtures/homc`（从 `DIR/<owner>/<name>/<path>` 读录音文件，断网复现与测试都用它）。**`--check` 的退出码口径与清单跟踪一致**：`ok` 与 `stale` 都返回 0——别人仓库今天读不到是一条观测结果，不是采集器坏了，天天红的信号等于没有信号；`unavailable`（从没读到过）才返回 1。代价由打印付账：`report()` 那一行带状态词、实测与自报的差、告警条数与快照字节。

### 看板功能

栏目在 `#homc`，**懒加载**：`IntersectionObserver` 盯住它，进视口才发那一次请求（连同逐日历史共两个文件），首屏因此不多下载任何东西；「刷新已发布快照」只重读本站已经发布的 `data/homc.json`，既不访问别人的仓库，也不触发后台采集。

- 5 张 KPI：实测三态行（含逐行数过与去重后的名字数）、🆕／🔄／⚠️ 拆分（含标记不一致的行数）、新增／移出（首次读到写「基线」）、单一 B 源须复核、没有链接的行（含对得上花色索引的行数）。
- 「实测与自报」面板把三态的本站数与他们的拆分并排画成两条柱，差值原样写「两边都发布，差距请自己看行」；下面「清单自己的核心统计」逐条原样引用，区间不取整。
- 「口径与告警」面板把 `source.caliber` 的 7 条口径与本次 `warnings` 一起发出来。**没读到的那一轮这里不宣布干净**：没有载荷时写「这次没读到总表：读不到不等于没有告警」，`待读行数` 也说成无数可报而不是 0——只有采集器真发出来的告警才带计数。
- 「逐日观测趋势」可切「实测行数」与「清单自报核实增量」两条线（同一份历史里的两个字段，**不相加**）；少于 3 个点不解释斜率，并给出一个可以回来的日子（`readyOn`，按每天一次的节奏推算，**是排期不是观测**）；没数出行数的那天空着，图注写「那天的点是断开的，不是零」。
- 表格工具栏：搜索（名称／提供方／类别／能力／可用状态／说明）、三态、来源等级、提供方、行的状态（仅待读／仅本次新增／仅没日期／仅没链接／仅指向章节）、五种排序、每页 25 行分页与「重置筛选」。
- 每行尾部的「建卡」把**这一行自己说过的**事实变成本机任务草稿，只走一次 `MO.board.create`，与页内新建的卡同一条推送路径。
- 「HOMC 站点 ↗」「清单原文 ↗」两个出口只在载荷给出地址时才出现；地址一律过 `http(s)` 白名单，非 https 形态的 `site_url` 直接不画按钮，而不是照单信任。

### 导出列

27 列：行的 22 列（`row_id, name, vendor, state_table, group, date, date_precision, date_state, category, capability, availability, source_grades, single_b_source, link_count, links, primary_url, row_marker, marker_state, list_note, is_section_reference, suit, is_new`）加 5 列出处（`measured_rows_total, claimed_increment, list_as_of, snapshot_status, snapshot_captured_at`），所以 CSV 里每一行都带着「这个数是哪天、按哪份快照数出来的」。导出的是**当前筛选后的样本**，`primary_url` 已过白名单，以 `=`／`+`／`-`／`@` 开头的单元格加前置单引号（公式防护照常）。

口径与边界：本栏目读的是**公开仓库里的公开文件**，读者页面下载的是本站已经发布的结构文件；行的正文只有清单自己写的那句说明（限 160 字符），原始 Markdown 从不发布。`data/homc.json` 与 `data/homc_history.json` 进 `_site/`，`data/homc_ledger.json` 不进。

## 历史快照的保留策略

每日快照会随时间线性增长，若不做处理，`data/history.json`（139 个模型 × 每日）一年后可达数 MB，且首屏每次都要全量下载。因此采集器在写入时做**分级留存**：

| 文件 | 策略 | 说明 |
| --- | --- | --- |
| `data/history.json` | 近 400 天日粒度，更早按周聚合 | 周桶取该周的均值而非末值（下载计数可正可负，均值更能反映净变化），带 `granularity: "weekly"` 与 `days` 字段 |
| `data/github_history.json` | 保留最近 1100 天 | 每条快照仅 4 个整数，体积可忽略，只做上限不做降采样 |
| `data/scholar_history.json` | 保留最近 1100 天 | 同上 |
| `data/modelscope_history.json` | 保留最近 400 天 | 不做周聚合：ModelScope 计数按快照整条存储，漏采的日期不补点 |
| `data/templates_history.json` | 保留最近 1100 天 | 每天只有几个整数 |
| `data/conferences.json` | 只保留当前快照（约 1.4 MB） | 截止时间不是可累加指标，逐日历史没有意义，变化量由 `changes` 差异代替 |
| `data/stars.json` / `data/stars_repos.json` | 只保留当前快照 | 墙需要的是「此刻 star 了哪些仓库」，逐日重复整份明细只会拖慢首屏；变化量同样由 `changes` 差异给出 |
| `data/stars_history.json` | 保留最近 1100 天 | 每天只有 star 总数与几个结构计数，体积可忽略；页面本身不请求它 |
| `data/entities.json` | 只保留当前索引 | 关系网要的是「此刻登记了什么」，逐日重复整份条目只会拖慢首屏；变化量由 `changes` 差异给出 |
| `data/entities_history.json` | 保留最近 1100 天 | 每天只有实体数、链接数、按阶段分布与被引用 id 列表；页面本身不请求它 |
| `data/tasks.json` | 只保留当前索引 | 画布要的是「此刻这些卡在哪条道上、连着谁」，逐日重复整份卡片只会让懒加载的那一次请求变慢；变化量由 `changes` 差异给出 |
| `data/tasks_history.json` | 保留最近 1100 天 | 每天只有任务数、边数、根任务数与六态分布几个整数；页面本身不请求它 |
| `data/awesome.json` | 只保留当前索引，预算 120 KB | 栏目要的是「今天这些清单里有多少行、上次何时动过」；逐日重复整份结构只会让懒加载的那一次请求越来越重，变化量由 `changes` 与条目 id 台账给出 |
| `data/awesome_history.json` | 最近 120 天逐日，更早每月留一个点（最多 24 个月），总跨度 1100 天 | 每天只有可读清单数、实测条目、覆盖率与增删几个整数；「逐日观测趋势」那张图就是读它画的。逐日留下去三年就是 150 KB 的整数，读者的眼睛用不上，所以更早的月份只留**该月最后一次真实读取**——不是平均，也不是插值，留存规则随文件发布在 `retention` 里 |
| `data/awesome_ledger.json` | 每清单最多 4,000 个 id；2026-11-03 实测 92,388 B／预算 204,800 B。**每日提交进仓库，但不复制进 `_site/`** | 「新增 / 移出」是拿今天的 id 集合比昨天的算出来的，而 Pages 没有服务端存储，仓库就是唯一的跨日记忆，所以它必须留在仓库里。留在公开仓库里 ≡ 读者能直接看到，这一点不含糊；「不发布」说的只是页面不把它当数据下载（`tests/test_wiring.py` 钉住两侧） |
| `data/runs.json` | 最近 **60 次运行**，按 `(run_id, attempt)` 去重；每次运行只追加一条几十字的自述 | 它说的是运行自己，不是数据：一次采集有没有跑完、哪一步在 `continue-on-error` 下面没产出。留 60 次够读者看见「不是今天才坏的」，再多就没有读者需要——`retention.kept` 每次把实际留了几条写在文件里 |

周桶以该周**最后一天**为日期戳，并丢弃跨越保留边界的桶，保证日期序列严格递增且不与日粒度段重叠。历史文件的读取端无需改动——旧快照与周桶都是相同的 `{id: [累计, 滚动30天]}` 结构。

## 元数据的 url 字段约定

各实体统一使用 `url` 作为「可一键直达的外部链接」字段，存储位置与可选性如下：

| 实体 | 存储位置 | 字段名 | 取值 | 可选性 |
| --- | --- | --- | --- | --- |
| 模型 | `data/latest.json` → `models[]` | `url` | `https://huggingface.co/<owner>/<repo>` | 可选，缺失为 `null` |
| 数据集 | `data/latest.json` → `datasets[]` | `url` | `https://huggingface.co/datasets/<owner>/<repo>` | 可选，缺失为 `null` |
| 论文 | `data/scholar.json` → `papers[]` | `url` | Scholar 引用页链接（`cited_by_url` 为被引检索链接） | 可选，缺失为 `null` |
| 仓库 | `data/github.json` → `repositories[]` | `url` | `https://github.com/<owner>/<repo>` | 可选，缺失为 `null` |
| 项目 | `data/github.json` → `projects.items[]` | `url` | GitHub Projects 页面地址 | 可选，缺失为 `null` |
| 模版 | `data/templates.json` → `templates[]` | `url` | 仓库内 Markdown 源文件地址 | 必填，由 `path` 生成 |
| 会议届次 | `data/conferences.json` → `conferences[].editions[]` | `url` | 会议官网页面（`https?` 且长度 ≤2048 才保留） | 可选，缺失为 `null` |
| star 的仓库 | **不存 url** | — | 前端按明细的 `n` 拼成 `https://github.com/<owner>/<repo>` | 名称已在采集端按同一形态校验，因此链接必然有效 |
| 实体条目 | `data/entities.json` → `entries[]` | `url` | 源文件地址 `https://github.com/<repo>/blob/<branch>/entities/<slug>.md` | 必填，由 `--repo` / `--branch` 与文件名拼成（slug 用文件名的原始写法，保证指向真实存在的路径） |
| 注册表的关联对象 | `data/entities.json` → `entries[].links[]` | `url` | 该对象在来源当日快照里的地址 | **只有 `resolved` 才发布**，其余三种状态为 `null` |
| 任务卡 | `data/tasks.json` → `tasks[]` | `url` | 源文件地址 `https://github.com/<repo>/blob/<branch>/tasks/<slug>.md` | 必填，由 `--repo` / `--branch` 与文件名拼成（slug 用文件名的原始写法） |
| 任务卡引用的对象 | `data/tasks.json` → `tasks[]` | **不存 url** | 只存 `entity` / `ddl` 两个 id 与 `entity_state` / `ddl_state` | 地址、倒计时与对象名一律回源到注册表与顶会看板当天的快照，卡片不复制第二份 |
| 清单跟踪的条目 | `data/awesome.json` → `repos[].sample[]` | `url` | 条目在清单里原本的地址（arXiv / 代码 / 会议页） | 可选，缺失为 `null`；发布前逐个重新过 `http(s)` 白名单，不合规的直接不写 |
| 清单跟踪的仓库 | `data/awesome.json` → `repos[]` | **不存 url** | 只有 `id`（`owner/name`） | 地址由前端按 `https://github.com/<id>` 拼；仓库名在采集端就按同一形态校验，因此链接必然有效 |
| 核实总表的行 | `data/homc.json` → `rows[]` | `url`（另有 `links[]`） | 该行在清单里原本的地址（厂商页 / 论文 / HF 权重页） | 可选，缺失为 `null`；`links` 每行最多 4 个但 `link_count` 记全数，`url` 优先取 HF 权重页，发布前逐个重过 `http(s)` 白名单 |
| HOMC 这份清单 | `data/homc.json` → `source` | `site_url` / `readme_path` | 它的 Pages 站与仓库内 README | 「HOMC 站点 ↗」「清单原文 ↗」两个按钮只在地址过白名单时才画出来；非 https 形态不点击、也不改写成 https |
| 采集健康的那次运行 | `data/runs.json` → `runs[]` | `run_url` | `https://<server>/<owner>/<repo>/actions/runs/<id>` | 可选：采集端要求 https + 合法 `owner/repo` + 纯数字才拼，前端再过一次 `http(s)` 白名单；环境没给够就 `null`，页面上那半句锚点整个消失 |

约定细节：

- 字段名统一为 `url`（不使用 `homepage` / `link` 等别名），前端只认这一个名字。
- **URL 始终是可选的**：数据源无法提供链接时写入 `null`，前端渲染为不可点击的纯文本（`<span class="model-link-plain">`），不会生成指向 `#` 的死链。
- 模型与数据集的 `url` 由采集器根据仓库 ID **自动生成**（`scripts/collect.py` 的 `entity_url()`），因此只要仓库 ID 正确，链接必然有效。
- 注册表的关联对象 URL **不由作者手写**：front matter 只写 `domain:id`，URL 由采集器从对应来源的当日快照取。手写的地址会在页面下线，而「当天在这个来源里见过」是可以核对的。
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

# ModelScope 公开模型计数（匿名接口，不需要令牌）
python scripts/collect_modelscope.py --author isLinXu

# 模版库只读本地目录，不访问网络
python scripts/collect_templates.py

# 顶会截止时间：匿名读取 ccfddl.com 的聚合 JSON，访问网络但不需要凭据
python scripts/collect_conferences.py

# 星星墙：分页读取账号全部公开 star；每 100 个仓库一次请求，匿名额度不够，需要仓库令牌
GITHUB_TOKEN=$GITHUB_TOKEN python scripts/collect_starred.py --login isLinXu

# 论文清单跟踪：逐行数过六个公开清单；正文走 raw.githubusercontent（匿名），
# 每个清单再打一次 commits 查节奏（配了 GITHUB_TOKEN 只是提高额度，不是必需）
python scripts/collect_awesome.py
python scripts/collect_awesome.py --check    # 抓取与汇总但不写文件；一份都没读到才退出 1（读到部分＝partial，只报不失败）
python scripts/collect_awesome.py --only isLinXu/paper-list   # 只跟部分清单，可重复
python scripts/collect_awesome.py --offline tests/fixtures/awesome   # 用录音文件复现，不访问网络

# 实体注册表：只读 entities/ 与同日已发布的其它快照，不访问网络（因此放在最后跑）
python scripts/collect_entities.py
python scripts/collect_entities.py --check   # 只解析与核对，不写文件；有结构错误就退出 1

# 任务看板：只读 tasks/ 与同日已发布的 entities.json / conferences.json，不访问网络（因此排在最后）
python scripts/collect_tasks.py
python scripts/collect_tasks.py --check      # 只解析与核对，并打印索引规模与引用三态计数
python scripts/collect_tasks.py --ids --domain ddl   # 列出卡片能挂的顶会环节 id

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

Python 套件覆盖数据集转换、历史迁移、url 字段生成、Scholar 解析、社交配置校验、各平台降级路径与小红书状态解析、GitHub 仓库转换与降级逻辑、会议目录的时区归一（`AoE` / `PT` / 固定偏移）、TBD 与「无法解析」的区分、逐条校验与告警上限、差异计算和失败保旧快照、**关闭错误响应本身失败时也不把「HTTP 5xx」降级成「采集失败」**（魔搭那条同形的路径各钉一遍），star 列表的分页聚合、单仓库唯一聚类归属、共现权重与页数上限，以及实体注册表的四种链接状态（来源不可用只能说「未核对」，不能谎报失效）、覆盖率分母只算自有非 fork 仓库、论文标题别名规则、`domain:id` 与枚举的结构校验、正文截断仍保留完整度量与失败保旧快照，以及任务看板的六态取值与「未标注不能写进文件」、「今日更新」的差异键不含状态、父子与依赖的「指向不存在 / 自己连自己 / 成环」三态挡边、`entity` / `ddl` 引用在没有当日快照时只能说「未核对」、`blob_sha` 哈希整份文件而正文度量止于截断线、卡片与边的预算上限与失败保旧快照；Node.js 套件覆盖社交净增基线、缺失平台处理、趋势范围、辅助数据加载隔离，顶会看板的窗口筛选与排序、统计口径、来源校验降级、倒计时渲染转义和 CSV 公式防护，星星墙的**首屏不下载明细**、明细单飞与强制重试、快照校验降级、墙的一聚类一段、图环节点预算、渲染转义与 CSV 公式防护，以及实体注册表索引的**首屏加载与单栏目降级**、行与反向索引只信任采集器发布的状态和 URL、筛选与反查的组合、每页 8 条的钳位、审计按「断链 → 未核对 → 范围外」排序、KPI 一律取自采集器汇总、正文按原文渲染转义、刷新只发一次请求与 17 列 CSV 的公式防护，以及任务看板的**无 Token 时一次请求都不发**、画布模型是纯函数（道序、座标、两张图与各自的拒绝语都算得出来且不碰 DOM）、草稿 / 新建卡 / 推送收据 / 冲突基线四块在本地存储里各归各位、推送只在**远端原文**上替换字段所以截断线之后的正文能活下来、三方基线冲突的三种选择与「远端已经是你要的值就从草稿里去掉」、父卡先推的顺序、`已推送 · 等索引` 与次日重建、新建卡遇到同名文件的两种反应、`1`–`7` / `l` / `d` / `Esc` 的键盘等价与空闲时不吞键、清单筛选与 17 列导出，以及论文清单跟踪的四种形态各自读数（表格按分区表头、JSON 读索引、主题库比最新归档月、报告只建基线）、实测与自报永不相加、上游仓库的行数不进本站合计、id 台账算增删且**首次读到只报基线**、滚动窗口的移出不算丢失、同一行换分区不重复计数、文件读到但认不出行时按格式变化沿用旧快照而不是发布 0 条、节奏按文件而非按仓库、停更与「今天没读到」分列、抓样与 id 的预算上限、索引超 120 KB 只削样本尾巴不动数字、台账超 200 KB 只报不砍、页面报告的字节数与写盘字节数一致，以及单文件撞 `MAX_BYTES` 时把实测标成下限（`byte_capped`／`files[].truncated`）、「没预算」与「服务器说没有」分列（`no_budget`／`missing`／`http`，`fetches.budget_hit` 与 `topics_not_attempted` 进载荷）、`skipped` 的三个成因、`skipped_no_link` 内部再点名「论文表里把链接留空」这一子类（只发布区别、不改准入）、只用已下载字节算出的 `recent` 年龄分桶与归档月月龄、逐日历史的分级留存（最近 120 天逐日、更早每月留最后一个真实点，且沿用的日子标 `tracked`）、`--check` 的退出码口径（`partial` 返回 0 并把没读到的清单打进输出，`unavailable` 才返回 1），以及模型清单核实的三张总表按**列契约**准入（表头认不出既定七列的表点名而不计数、列序被换就整张拒绝因为那会把许可证列读成日期、纯基线表与机器摘要小节都不接管）、`measured.grades` 是「带该级来源的行数」而非来源个数（一级一行可以并列，所以之和允许大于行数）、`single_b_source` 只由形状判定且**永不改写**清单自己写的须复核说明、行首标记与所在表不一致时按所在表归类并单独报数、指向章节的纠偏行照数并点名、同一模型出现在两张表只按首次计、名称为空的行说出原因而不是悄悄少一行、花色索引 ♠♥♦♣🃏（含没有点数的 Joker）**只在名称完全相等时**抄到行首、月不升成日与「待核实／未披露」保留成状态而非空串（否则排序会把没日期的行当最老的）、日期分桶之和恒等于行数、`as_of` 认不出就留空并告警而不代标注、**三态轮转的样本在任何一态都不被预算砍光**（新到旧排在每态前面、无日期落尾）、`ROW_LIMIT` 与总预算只削行数不削计数并写出本次真正用的上限、预算小到装不下计数时发布零行、装不下的快照把责任指向每行链接数而不是读者的下载量、台账超预算只报不砍、首次读到是基线而不是「新增一堆」、第二次读到同样的行不动增删、id 撞上限时答 `null` 而不是一个好看的数、历史点两侧各存一个数且永不合并、没读到时沿用上次并标注、读到但没有一行时按格式变化处理、第一次就什么都没读到才发布「明确缺席」、stale 那一次不写台账也不动历史、**提交日只是文件动过不是新一轮核实**（`cadence` 与 `as_of` 各说各的）、停更说清是多少天、查不到提交是 `unknown` 不是 `ok`、只有 `http(s)` 链接能活下来、标记与控制字符不进载荷、不发布原始 Markdown 正文、长格子截到字段上限、`--check` 不落盘、`report()` 打印的就是载荷里的同一批数、来自未来的快照拒绝覆盖现有文件，以及前端侧的**每页只在进入视口时读一次快照**、卡片与流水两种视图、筛选与搜索、逐清单降级、刷新不访问别人的仓库、转义与 URL 白名单、趋势图不足三点不解释斜率且历史读不到只空一张图、「只看这份」把两份视图一起收敛、「实体注册表」那行只链过去不抄任何数字、20 列导出的公式防护、流水每行的「建卡」只抄那行已有的事实（同一篇论文两份清单也只有一个 slug，第二次点被拒而不是复制）、卡片里「没成为条目的行」那句按「没测过／有／一个也没有」三种说法分别成句（缺席的说缺席，不写成 0，也不写成下限），以及模型清单核实栏目的**实测与自报并排而不互相改数**（差值原样写「两边都发布，差距请自己看行」、`200+` 保留成区间并另给一个只在没有「+／约」时才存在的整数、自报缺席时那根浅色柱整条不画并说「清单没有自报这一态的拆分」）、**没读到的那一轮每个数都是 `—` 且不说自己干净**（`status` 归一后 `available` 由它推，所以别人家的状态词不会一边写「没读到」一边把数字画满；告警栏写「读不到不等于没有告警」，`0 条采集告警` 只在载荷真的存在时才报，样本缺席时「待读行数」说无数可报而不是 0，导出与两个出口按钮一起禁用／隐藏）、逐行降级的五种残缺各说各的（认不出的状态词、`S` 这样的等级、非 ISO 日期、`link_count` 不是数、名称为空退回 id）、`homcWatch` 把一行有待读的理由逐条点名且「仅待读」取的是并集、三态轮转的窗口从不冒充全量（「实测共 N 行」与「每页 25 行」并排、页数钳位、筛选变空时说「这里没有不等于清单里没有」）、转义与 `http(s)` 白名单、基线／比对／沿用三种日子各说各的（`沿用上次`、「截至 …（已经 N 天）」、机器人作者与「已停更 N 天」）、趋势两条线不相加且只有 1～2 点时给出可回来的日子、历史读不到只空一张图、27 列导出的公式防护与每行自带的四列出处、「建卡」只抄那一行说过的话（同一 id 第二次点被拒、id 认不出名称部分就拒绝、卡里不出现本站任何计数）、**滚到那一屏才读一次并断开观察器、全程不请求 `homc_ledger.json`**、刷新按钮只重读本站已发布的文件；采集健康那半边由 `tests/test_runs.py` 与前端断言付账——步骤清单与 `pages.yml` 的 `id:` 一一对应、记录步排在提交步之前、`!cancelled()` 在、读的是 `outcome` 而不是 `conclusion`、四种状态各自成句、同 attempt 重跑是替换、保留窗口会砍并如实报 `kept`、`run_url` 与步骤标签两侧都过白名单、`--check` 不落盘，前端那行则把「干净／有步骤没成功／读不到／空文件／`unknown`」五种说法分别钉住，并确认主数据读坏时它仍然画得出来；全部离线运行，不访问网络（清单测试读 `tests/fixtures/awesome/`、模型清单测试读 `tests/fixtures/homc/` 里的录音文件）。

**解释器版本：CI 钉 3.12，本地是哪个版本得先查——所以要各跑一遍，不要假设一致。** 工作流用 `actions/setup-python@v6` 的 `python-version: '3.12'`（`node-version: '24'`）。这台开发机 2026-11-06 能跑的只有三个解释器：`~/.local/bin/python3.12`、`~/.local/bin/python3.11`（3.11.16）和 PATH 里的 `python3`（系统的 3.9.6）——**没有比 3.12 更新的版本**，2026-11-03 记下的「默认 `python3` 是 3.14」今天已不成立，那句说的只是那台机器那天。三个解释器各跑一遍都是 `Ran 678 tests … OK`，另加 `node --test tests/test_frontend.js` 的 272 pass 与 `tests/test_wiring.py` 的 7 OK；这条对表本身就是要记的事实：**没有版本差异被证明之前，「本地全绿」只是「我这台机器全绿」**。

最老的那个解释器今天不是白跑的，它抓到一个**「失败原因被降级」**的真缺陷：`collect_conferences.fetch_once()` 在 `except urllib.error.HTTPError` 里调 `error.close()` 释放错误响应体，而一个没有附带 body 的 `HTTPError` 在 3.9 的标准库里关闭时会从它自己的 tempfile 清理里抛 `KeyError: 'file'`——异常在 `except` 块里被换成另一个类型，采集器最终发布的理由就从 `Conference source HTTP 500.` 退化成兜底的 `Conference collection failed.`。状态还是「没读到」，但**具体是哪一档 HTTP 错了**这件事丢了，而读者能重开核对的正是那句话。修法是让清理失败不能顶替被报告的状态码（`collect_conferences.py` 与同形的 `collect_modelscope.py` 各一处），并各补一条断言「`close()` 炸掉时发布的理由仍是那档 HTTP 状态、且不泄露来源细节」——把保护去掉，这两条新测试当场就红（已实测，不是推定）。

2026-11-03 那天真正暴露出来的则是**日历**：`test_the_command_line_reports_what_the_reader_can_re_open` 走的是命令行入口，入口原先自己读墙上时钟，而 fixture 里 `isLinXu/idea-research-list` 的最新提交是 2026-09-18——距 2026-11-02 正好 45 天（`STALL_AFTER_DAYS`，不算停更），距 2026-11-03 就是 46 天（算）。于是「停更 1 个」这条断言在跨线的那一天必红，跟解释器无关。修法是给 `collect_awesome.py` 的 `main()` 一个可选的 `at=`（与 `collect_conferences.py` 同形的注入点），测试把时钟钉住；新增的 `test_the_command_line_stall_count_follows_the_clock_not_the_calendar` 把「换个日期就是换个答案」写成断言而不是意外。

**接线（`tests/test_wiring.py`）管的是「字符串对不上」这一类错。** 这个站点没有打包器也没有类型检查，`index.html` 用字符串点名脚本、各栏目用字符串查 DOM id、`scripts/build.py` 用一份写死的清单点名要发布的数据文件——所以三处各写错一个名字，浏览器里都只是「这块板子空了」或一次 404，本地跑不出任何失败。今天就在 `app.js` 里抓到一个：清单卡片的「实体注册表」芯片把页面滚向 `registry`，而注册表那一段在 `index.html` 里的 id 是 `entities`——提示语说「已反查」，页面却原地不动，读者不会知道自己错过了什么。三条线索因此被固化成五条断言：**资产**——页面点名的每个本地 `src`/`href` 都在 `site/` 里，`site/` 里每个脚本都被 `index.html` 加载（少一个标签等于一个模块从未运行）；**id**——每个脚本查的 id 都在 `index.html` 或某个脚本生成的标记里声明过；**数据**——页面请求的每个 `data/*.json` 都在 `scripts/build.py` 的发布清单里，`latest.json`／`history.json` 是缺了就该让构建炸掉的那两个，而台账在发布清单里**没有**、在工作流里**有**。静态读源码证明不了的那部分说清楚而不是假装覆盖：模板里插值的 id（`id="task-arrow-${kind}"` 这一类，今天 4 处）不参与比对，条数被写成断言，多了就要人去看是不是新造了一个查不到的 id。

**语法门与工作流门（`tests/test_syntax.py`、`tests/test_ci.py`）管的是「从没被任何运行时解析过」和「唯一写仓库的那个 job」。** 没有打包器还有一层代价：一个语法错的 `site/*.js` 不会让构建失败，只会让那一块栏目空白；`tests/test_syntax.py` 因此用页面自己的解析器扫一遍——`node --check` 跑 `site/*.js` 与前端测试，Python 侧用内建 `compile()` 跑 `scripts/*.py` 与 `tests/*.py`，**不装 linter、不加依赖**（为什么不装见「谁审查这份工作流自己」），而 node 不在 PATH 时那条报 `skip` 而不是 pass。`tests/test_ci.py` 读的是 `.github/workflows/pages.yml` 本身：六个 `uses:` 全是 40 位 sha 且行尾带 `# repo@vN`（条数钉成 6，读不到行的门等于没门）、`permissions` 只有那三行 `*: write`、dependabot 覆盖 `github-actions` 与 `pip`、以及**回归门排在任何 `Capture`／`Commit` 步骤之前**——这条顺序是这份 yaml 里唯一「先审再写」的东西，被人拖下去时应当有人被拦下。

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
scripts/collect_modelscope.py  # ModelScope 匿名 OpenAPI 模型计数与逐日快照
scripts/collect_templates.py   # 索引 templates/ 下的 Skill 与 Prompt 模版（只读本地）
scripts/collect_conferences.py # 抓取 CCF-Deadlines 目录并把截止时间归一为 UTC
scripts/collect_starred.py     # 分页读取账号全部公开 star，聚合为聚类图与仓库明细
scripts/collect_entities.py    # 索引 entities/ 条目，并与同日快照交叉核对关系链接（只读本地）
scripts/collect_tasks.py       # 索引 tasks/ 任务卡，并与同日快照核对 entity / ddl 引用（只读本地）
scripts/collect_awesome.py     # 逐行数过六个公开 awesome 清单，含 id 台账增删与文件级更新节奏
scripts/collect_homc.py       # 逐行数过 model-list 的 🆕/🔄/⚠️ 三态核实总表，与它的自报增量并排发布
scripts/record_run.py         # 本次运行自己报健康：读 steps 的 outcome，写 data/runs.json（不联网、不复制别人的数字）
scripts/build.py              # 组装纯静态站点（发布清单是模块常量，页面请求的数据与它由 tests/test_wiring.py 比对）
scripts/serve.py              # 本地预览用多线程静态服务器
templates/skills/<slug>.md    # Skill 定义（frontmatter + 正文）
templates/prompts/<slug>.md   # Prompt 模版（frontmatter + 正文）
entities/<slug>.md            # 一个研究对象一条：frontmatter 写关系，正文写结论
tasks/<slug>.md               # 一个任务一条：frontmatter 写状态与父子/依赖/引用，正文写验收
site/index.html               # 看板 DOM
site/style.css                # 设计令牌 + 明暗双主题 + 响应式布局
site/format.js                # 数值格式化（万/亿、千位分隔、日期、涨跌符号）
site/charts.js                # SVG 图表原语（折线、柱状、排行）
site/data.js                  # 数据获取与全局状态、派生序列计算
site/render.js                # 各板块渲染逻辑
site/repo.js                  # 唯一的 GitHub 写回通道：Token 边界 + Contents API + 基线冲突
site/board.js                 # 任务画布的纯模型：道与座标、两张图、草稿与新建卡、文件文本的组装与拆解
site/templates.js             # 模版库：浏览、草稿、复制与 GitHub 回写
site/registry.js              # 实体注册表回写：读原文、结构自检、草稿与三选冲突处理
site/tasksync.js              # 任务卡回写：推送编排、三方基线冲突与三选、待推送队列
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
data/modelscope.json          # 最新 ModelScope 公开模型清单与计数
data/modelscope_history.json  # 逐日 ModelScope 计数快照
data/templates.json           # 最新模版索引（含完整正文）
data/templates_history.json   # 逐日模版数量快照
data/conferences.json         # 当前会议目录（含归一化后的 UTC 截止时间，无历史文件）
data/stars.json               # star 聚合快照（计数、聚类节点、共现边、差异），首屏读取
data/stars_repos.json         # 一格一仓库的明细，进入星星墙视口才读取
data/stars_history.json       # 逐日 star 总数与结构计数
data/entities.json            # 最新实体索引（正文、四种链接状态、覆盖率工作队列），首屏读取
data/entities_history.json    # 逐日实体与链接状态快照
data/tasks.json               # 最新任务索引（卡片、两张图、引用三态），进入本栏目视口才读取
data/tasks_history.json       # 逐日任务数、边数与六态分布
data/awesome.json             # 最新清单索引（实测与自报两列、节奏、样本条目），进入本栏目视口才读取
data/awesome_history.json     # 逐日可读清单数、实测条目与增删
data/awesome_ledger.json      # 每清单记住的条目 id（增删由此算出）；每日随快照提交进仓库，但不进 _site/、页面也不请求它
data/homc.json                # 最新核实总表快照（实测行数、来源等级、自报核心统计、节奏与样本行），进入本栏目视口才读取
data/homc_history.json        # 逐日实测行数与清单自报增量（两个可切换的指标，不相加）
data/homc_ledger.json         # 记住的三态行 id（增删由此算出）；每日随快照提交进仓库，但不进 _site/、页面也不请求它
data/runs.json                # 最近 60 次运行自己报的健康记录（哪步在 continue-on-error 下面没产出）；首屏读取
tests/test_collect.py         # 离线测试（数据集 + url 字段 + 档案解析）
tests/test_social.py          # 离线测试（社交配置、降级、小红书解析）
tests/test_github.py          # 离线测试（仓库转换、历史、降级）
tests/test_modelscope.py      # 离线测试（OpenAPI 转换、身份校验、分页与降级）
tests/test_templates.py       # 离线测试（frontmatter 解析、标签归一、索引与降级）
tests/test_conferences.py     # 离线测试（时区归一、事件展开、差异比对、失败保旧快照）
tests/test_starred.py         # 离线测试（star 分页聚合、聚类归属、共现与告警、失败保旧快照）
tests/test_entities.py        # 离线测试（四种链接状态、覆盖率口径、别名规则、失败保旧快照）
tests/test_tasks.py           # 离线测试（六态与「未标注」、挡边三态、引用三态、预算上限、失败保旧快照）
tests/test_awesome.py         # 离线测试（四种清单形态、实测与自报分列、id 台账增删与基线、预算与格式变化降级）
tests/test_homc.py            # 离线测试（三态总表的列契约、等级只转述不判定、自报区间不取整、花色只对同名、轮转样本与预算、失败保旧快照、`--check` 退出码）
tests/test_wiring.py          # 离线测试（页面点名的资产真的存在、脚本查的 DOM id 有处声明、页面要的数据都在发布清单里、台账只进仓库不进页面）
tests/test_syntax.py          # 离线测试（页面加载的每个脚本用 node --check 解析、每个 .py 用内建 compile() 编译；不装 linter 的那半边决定）
tests/test_ci.py              # 离线测试（动作钉到 commit sha 且带 tag 注释、dependabot 覆盖两个生态、回归门排在任何采集与提交之前、permissions 三行是写死的）
tests/test_runs.py            # 离线测试（步骤清单与工作流 id 一一对应、outcome 而非 conclusion、四种状态、去重与保留窗口、run_url 白名单、记录排在提交之前）
tests/test_frontend.js        # 前端派生指标、辅助数据加载，以及 MO.repo / 注册表回写 / 任务画布与卡片回写 / 清单跟踪与模型清单核实栏目的回归测试
tests/fixtures/               # 离线测试用的真实页面片段（awesome/ 是六个清单的录音副本、homc/ 是核实总表的录音副本，都供 --offline 复现）
```

**新增一个平台通常只需要改两个文件**：`config/social_sources.json` 加一条配置，`scripts/collect_social.py` 注册一个 fetcher。前端因为是数据驱动的，无需改动。

分层原则：`data.js` 负责取数与状态，`render.js` 只负责把状态画到 DOM，`charts.js` 只负责画 SVG，`format.js` 只负责把数字变成字符串。渲染层不发起网络请求，取数层不触碰 DOM，因此新增板块时边界保持清晰。任务看板多加了一层：`board.js` 是**纯模型**——道与座标、两张图的拒绝、本地存储的形状、文件文本的组装与拆解都在它里面，不碰 DOM 也不发请求，所以同一套规则能被采集器语义对齐、被 Node 直接测；`app.js` 才把指针与键盘事件翻译成对它的调用。写回只有一个入口：`repo.js` 持有 Token 边界、Contents API 与基线检查，`templates.js`、`registry.js` 与 `tasksync.js` 各自只管自己的表单、草稿与冲突编排——新增一块可写回的看板时不要再复制这套逻辑。

## 注意事项

- 如果 `git push` 在 Actions 中失败，先检查 workflow permissions 或分支保护策略。工作流需要把数据提交回仓库来保证历史永久保存。
- 如果 `deploy-pages` 返回配置问题，核对 Settings → Pages → Source = GitHub Actions。
- 页面会直接请求 HF 的公开模型 API 来发现新上传模型；该接口允许跨域且无需 Token。单次请求超过 10 秒、请求失败或限流时自动回退到自己站点的 `./data/latest.json`，数据集和其它板块仍只读取发布的 JSON。
- 模型清单实时读取，历史仍是每天一个 UTC 快照，定时采集不等于实时历史。可以手动重新运行工作流刷新当天快照。
- 历史按前文策略有界保留：HF 近 400 天为日粒度，更早数据按周聚合并最多保留 104 个周桶；GitHub、Scholar、模版、star 与实体注册表历史保留最近 1100 天，ModelScope 历史保留最近 400 天日粒度；`data/conferences.json`、`data/stars*.json`（明细与聚合）与 `data/entities.json` 只有当前快照。
- 学术档案依赖 Google Scholar 的公开页面：若被验证码拦截，采集会跳过并保留上一次成功的快照，网站仍可正常展示下载统计。不要提高抓取频率，工作流每日一次即可。
- 知乎与小红书需要登录态，请把 Cookie 存在**仓库 Secret**（`ZHIHU_COOKIE` / `XIAOHONGSHU_COOKIE`）而不是提交进代码库。Cookie 会过期，属于正常现象：过期后该平台显示为「暂不可用」并保留上次数据，其它平台不受影响。
- 社交平台的粉丝数会随平台自身的风控与统计口径变化，与下载统计一样，负向跳变会被保留并标记为待核查，而不是被静默抹平。
- GitHub 匿名 REST 有 60 次/小时的 IP 限速。仓库数量多时（>1000）建议配置 `GITHUB_TOKEN`；触发限速时采集器会自动退避重试，仍失败则保留上次快照并在页面提示。星星墙采集是例外：一次运行需要几十个分页请求，**必须**依赖工作流自带的 `secrets.GITHUB_TOKEN`（无需任何个人 PAT），本地手动运行时也要为该次命令导出 `GITHUB_TOKEN`，否则只发布 `unavailable` 快照。

**官方文档**：[HF Hub HfApi.list_models](https://huggingface.co/docs/huggingface_hub/en/package_reference/hf_api) · [GitHub Pages 自定义 Actions](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
