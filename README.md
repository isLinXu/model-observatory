# Model Observatory · @gatilin

一个**直接托管到 GitHub Pages** 的 Hugging Face 模型与数据集下载统计看板，并附带一个类 Google Scholar 的公开学术档案板块。静态前端，无后端服务器和前端密钥；GitHub Actions 每日自动抓取你的 **全部公开模型与数据集**、**公开 Google Scholar 档案**并提交历史 JSON，同时重新部署网站。

支持：模型排行、单模型详情、总体趋势、最近 30 天活跃下载、历史累计、相邻快照净变化、7/30 日净变化、统计下调异常标记、3 模型对比、搜索和 CSV / JSON 导出；数据集板块与模型完全同口径；学术主页展示引用总数、h-index、i10-index、逐年引用分布、每日引用快照与论文列表。首次采集仅有当天数据，不伪造历史走势。

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
                ↓
更新 data/latest.json、data/history.json、
data/scholar.json、data/scholar_history.json
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

## 在电脑本地预览

```bash
python -m pip install -r requirements.txt
python scripts/collect.py --author gatilin
python scripts/collect_scholar.py --user oTYM_I8AAAAJ
python scripts/build.py
python -m http.server 8080 --directory _site
```

访问 <http://localhost:8080/>。采集命令会实际访问 Hugging Face 与公开的 Google Scholar 档案页；如果网络不通，可直接预览 `site` 文件，但没有数据时网页会显示等待首次采集。日后运行 `python scripts/collect.py` 将更新同一 UTC 日期的快照（同一天内重复运行会替换当天快照），不会导致同一天被算成多个采样点。

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

数组 `[1200,420]` 依次为 `[downloads_all_time, downloads_rolling_30d]`。`null` 表示 API 未提供数据，而不是 0。`schema_version` 1 表示只含模型，采集器会自动迁移为 2。以上仅是示例数据，不包含在正式仓库的首日页面中。

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

## 修改为其他 HF 账号

修改 `.github/workflows/pages.yml` 中的 `HF_AUTHOR: gatilin`，并同步把 `data/latest.json` / `data/history.json` 的 `author` 改成新用户名、清空 `snapshots`，更新 `site/index.html` 中账户固定文案。或者直接重建空白 JSON。采集器会校验作者，避免不同账户数据混在一起。学术档案同理：修改 `SCHOLAR_USER_ID`，并清空 `data/scholar.json` / `data/scholar_history.json`（`profile_id` 变化时旧文件会被采集器拒绝覆盖，需要手动删除）。

## 文件组织

```text
.github/workflows/pages.yml   # 每日采集、提交历史、Pages 自动部署
scripts/collect.py            # Hugging Face 模型 + 数据集 API、异常保护、快照持久化
scripts/collect_scholar.py    # 公开 Google Scholar 档案抓取与解析
scripts/build.py              # 组装纯静态站点
site/index.html               # 看板 DOM
site/style.css                # 响应式深色视觉设计
site/app.js                   # 交互、SVG 曲线、排行、筛选、导出
site/favicon.svg
requirements.txt
data/latest.json              # 最新模型 + 数据集清单
data/history.json             # 逐日快照（models + datasets）
data/scholar.json             # 最新学术档案
data/scholar_history.json     # 逐日引用快照
tests/test_collect.py         # 离线测试（数据集 + 档案解析）
tests/fixtures/               # 离线测试用的真实页面片段
```

## 注意事项

- 如果 `git push` 在 Actions 中失败，先检查 workflow permissions 或分支保护策略。工作流需要把数据提交回仓库来保证历史永久保存。
- 如果 `deploy-pages` 返回配置问题，核对 Settings → Pages → Source = GitHub Actions。
- 此项目不请求浏览器直接访问 HF，不受浏览器跨域（CORS）限制；运行时页面只请求自己的 `./data/*.json`。
- 每天一个 UTC 快照，定时采集不等于实时统计。可以手动重新运行工作流刷新当天数据。
- 全部历史默认永久保留；账户模型极多且运行多年时，`data/history.json` 会逐年增长，可以进一步拆分年度历史文件。
- 学术档案依赖 Google Scholar 的公开页面：若被验证码拦截，采集会跳过并保留上一次成功的快照，网站仍可正常展示下载统计。不要提高抓取频率，工作流每日一次即可。

**官方文档**：[HF Hub HfApi.list_models](https://huggingface.co/docs/huggingface_hub/en/package_reference/hf_api) · [GitHub Pages 自定义 Actions](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
