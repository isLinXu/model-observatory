/* Model Observatory — rendering layer.
 * Every function here reads from MO.data.state and writes into the DOM.
 * No network access and no event binding live in this file.
 */
window.MO = window.MO || {};

MO.render = (() => {
  'use strict';

  const { esc, fmt, compact, countCN, signed, signedCN, tone, dayLabel, timestamp, ageInDays } = MO.format;
  const charts = MO.charts;
  const data = MO.data;

  const $ = id => document.getElementById(id);

  // --- Shared chrome --------------------------------------------------------

  function stateMessage(message, type = 'error') {
    const element = $('errorBanner');
    element.textContent = message;
    element.classList.remove('hidden');
    element.classList.toggle('info', type === 'info');
  }

  function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'notice toast';
    toast.setAttribute('role', 'status');
    toast.textContent = message;
    document.body.append(toast);
    setTimeout(() => toast.remove(), 3300);
  }

  // --- Models ---------------------------------------------------------------

  function renderSummary() {
    const state = data.state;
    const models = state.latest.models;
    const withTotal = models.filter(model => Number.isFinite(model.all_time));
    const withRolling = models.filter(model => Number.isFinite(model.last_30d));
    const lifetime = withTotal.reduce((sum, model) => sum + model.all_time, 0);
    const rolling = withRolling.reduce((sum, model) => sum + model.last_30d, 0);
    const latest = state.snapshots.at(-1), previous = state.snapshots.at(-2);
    const net = data.netChange(latest, previous);

    $('statModels').textContent = fmt(models.length);
    $('statLifetime').textContent = withTotal.length ? countCN(lifetime) : '—';
    $('statLifetime').title = withTotal.length ? fmt(lifetime) : '无累计数据';
    $('statLifetimeSub').textContent = withTotal.length !== models.length
      ? `已知 ${withTotal.length}/${models.length} 个模型的累计值`
      : '全部当前公开模型累计之和';
    $('statRolling').textContent = withRolling.length ? countCN(rolling) : '—';
    $('statRolling').title = fmt(rolling);
    $('statDelta').textContent = net?.value === null || !net ? '—' : signed(net.value);
    $('statDelta').classList.toggle('neg', Boolean(net?.value < 0));
    $('statDeltaSub').textContent = previous ? `可比 ${net?.compared || 0} 个模型 · 自 ${previous.date} 起` : '需要至少两天快照';

    $('lastSync').textContent = timestamp(state.latest.captured_at);
    $('snapshotCount').textContent = fmt(state.snapshots.length);
    $('snapshotDate').textContent = `最新快照 ${state.latest.date} UTC`;
    $('modelCountBadge').textContent = fmt(models.length);

    const age = ageInDays(state.latest.captured_at);
    $('freshLed').className = 'status-led ' + (age !== null && age <= 2 ? 'good' : 'warn');
    $('freshLabel').textContent = age === null
      ? '采集时间未知'
      : age <= 2 ? '自动采集正常' : `数据已过期 ${Math.floor(age)} 天`;

    const revised = net?.revised || 0;
    $('correctionBadge').textContent = revised ? `${revised} 个模型累计值下降 · 请核查` : '未检测到累计值下降';
    $('correctionBadge').classList.toggle('warn', revised > 0);
  }

  function renderOverall() {
    const state = data.state;
    const metric = state.metric;
    $('overallLegend').textContent = metric === 'all_time'
      ? '历史累计下载 · 各日当时公开模型之和'
      : '滚动30天下载 · 各日当时公开模型之和';
    charts.line($('overallChart'), [{
      name: metric === 'all_time' ? '历史累计' : '滚动30天',
      points: data.sumSeries('models', metric, state.range),
      color: 'var(--chart-1)'
    }], { area: true, label: '模型总体下载趋势' });

    const snapshots = state.snapshots.slice(-16);
    const points = [];
    for (let index = 1; index < snapshots.length; index++) {
      const change = data.netChange(snapshots[index], snapshots[index - 1]);
      points.push({
        date: snapshots[index].date,
        previous: snapshots[index - 1].date,
        value: change?.value,
        revised: change?.revised || 0
      });
    }
    charts.delta($('deltaChart'), points);
    $('deltaPeriod').textContent = `${points[0]?.previous || '—'} — ${points.at(-1)?.date || '—'}`;
  }

  function renderTop() {
    const top = [...data.state.latest.models]
      .filter(model => model.last_30d !== null)
      .sort((a, b) => (b.last_30d ?? 0) - (a.last_30d ?? 0))
      .slice(0, 6);
    if (!top.length) {
      $('topModels').innerHTML = '<div class="chart-empty">暂无滚动 30 天数据</div>';
      return;
    }
    const max = top[0].last_30d || 1;
    $('topModels').innerHTML = top.map((model, index) =>
      `<div class="top-item"><span class="rank-index">${String(index + 1).padStart(2, '0')}</span>` +
      `<div><div class="rank-model"><span class="rank-name" title="${esc(model.id)}">${esc(model.id.split('/').slice(1).join('/'))}</span></div>` +
      `<div class="rank-progress"><span style="width:${(model.last_30d / max * 100).toFixed(1)}%"></span></div></div>` +
      `<span class="rank-number" title="${esc(fmt(model.last_30d))}">${esc(compact(model.last_30d))}</span></div>`
    ).join('');
  }

  function renderTable() {
    const state = data.state;
    const search = $('modelSearch').value.trim().toLowerCase();
    const sort = $('sortModel').value;
    const onlyNegative = $('onlyAnomalies').checked;
    let rows = data.localModels().filter(model =>
      (!search || model.id.toLowerCase().includes(search)) && (!onlyNegative || model.d1 < 0));
    if (sort === 'name') rows.sort((a, b) => a.id.localeCompare(b.id));
    else rows.sort((a, b) => ((b[sort] ?? -Infinity) - (a[sort] ?? -Infinity)) || a.id.localeCompare(b.id));

    $('tableCount').textContent = `${fmt(rows.length)} / ${fmt(state.latest.models.length)} MODELS`;
    $('modelRows').innerHTML = rows.length ? rows.map(model => {
      const stateName = model.all_time === null ? '累计缺失' : model.d1 < 0 ? '统计修正?' : model.d1 === null ? '待积累' : '正常';
      const stateClass = model.all_time === null ? 'missing' : model.d1 < 0 ? 'alert' : model.d1 === null ? 'new' : '';
      const checked = state.compare.includes(model.id) ? 'checked' : '';
      return `<tr><td><button class="model-link" data-detail="${esc(model.id)}" title="查看 ${esc(model.id)} 的历史">` +
        `<span class="model-square">${esc(model.id.split('/').at(-1).slice(0, 1).toUpperCase())}</span>` +
        `<span class="model-title">${esc(model.id.split('/').slice(1).join('/'))}</span></button>` +
        `${model.url ? `<a class="ext-link" href="${esc(model.url)}" target="_blank" rel="noopener noreferrer" title="在 Hugging Face 打开 ${esc(model.id)}" aria-label="打开 ${esc(model.id)} 的 Hugging Face 页面">↗</a>` : ''}</td>` +
        `<td class="align-right">${esc(fmt(model.all_time))}</td>` +
        `<td class="align-right">${esc(fmt(model.last_30d))}</td>` +
        `<td class="align-right ${tone(model.d1)}">${esc(signed(model.d1))}</td>` +
        `<td class="align-right ${tone(model.d7)}">${esc(signed(model.d7))}</td>` +
        `<td class="align-right ${tone(model.d30)}">${esc(signed(model.d30))}</td>` +
        `<td><span class="state ${stateClass}">${esc(stateName)}</span></td>` +
        `<td class="compare-col"><input type="checkbox" class="compare-check" data-compare="${esc(model.id)}" aria-label="对比 ${esc(model.id)}" ${checked}></td></tr>`;
    }).join('') : '<tr><td colspan="8" class="no-rows">没有符合条件的模型</td></tr>';
  }

  function renderCompare() {
    const state = data.state;
    $('compareSelected').innerHTML = state.compare.length
      ? state.compare.map((id, index) =>
        `<div class="compare-pill"><span class="compare-dot" style="background:${charts.colorAt(index)}"></span>${esc(id.split('/').slice(1).join('/'))}</div>`
      ).join('')
      : '<span class="muted micro">尚未选择模型，在上方表格中勾选即可对比。</span>';
    charts.line($('compareChart'), state.compare.map((id, index) => ({
      name: id,
      points: data.modelSeries(id, 'all_time', state.range),
      color: charts.colorAt(index)
    })), { label: '所选模型历史累计下载对比' });
  }

  // --- Datasets -------------------------------------------------------------

  function renderDatasetSummary() {
    const state = data.state;
    const datasets = state.latest.datasets || [];
    const withTotal = datasets.filter(item => Number.isFinite(item.all_time));
    const withRolling = datasets.filter(item => Number.isFinite(item.last_30d));
    const lifetime = withTotal.reduce((sum, item) => sum + item.all_time, 0);
    const rolling = withRolling.reduce((sum, item) => sum + item.last_30d, 0);
    const latest = state.snapshots.at(-1), previous = state.snapshots.at(-2);
    const net = data.netChange(latest, previous, 'datasets');

    $('statDatasets').textContent = fmt(datasets.length);
    $('statDatasetLifetime').textContent = withTotal.length ? countCN(lifetime) : '—';
    $('statDatasetLifetime').title = withTotal.length ? fmt(lifetime) : '无累计数据';
    $('statDatasetLifetimeSub').textContent = withTotal.length !== datasets.length
      ? `已知 ${withTotal.length}/${datasets.length} 个数据集的累计值`
      : '所有数据集累计指标之和';
    $('statDatasetRolling').textContent = withRolling.length ? countCN(rolling) : '—';
    $('statDatasetRolling').title = fmt(rolling);
    $('statDatasetDelta').textContent = net?.value === null || !net ? '—' : signed(net.value);
    $('statDatasetDelta').classList.toggle('neg', Boolean(net?.value < 0));
    $('statDatasetDeltaSub').textContent = previous ? `可比 ${net?.compared || 0} 个数据集 · 自 ${previous.date} 起` : '需要至少两天快照';
    $('datasetCountBadge').textContent = fmt(datasets.length);
    $('datasetSnapshotDate').textContent = latest ? `最新快照 ${latest.date} UTC` : '—';
  }

  function renderDatasetChart() {
    const state = data.state;
    const metric = state.datasetMetric;
    $('datasetLegend').textContent = metric === 'all_time'
      ? '全部数据集累计下载 · 各日当时公开数据集之和'
      : '滚动30天下载 · 各日当时公开数据集之和';
    charts.line($('datasetChart'), [{
      name: metric === 'all_time' ? '历史累计' : '滚动30天',
      points: data.sumSeries('datasets', metric, state.datasetRange),
      color: 'var(--chart-2)'
    }], { area: true, label: '数据集总体下载趋势' });
  }

  function renderTopDatasets() {
    const top = [...(data.state.latest.datasets || [])]
      .filter(item => item.last_30d !== null)
      .sort((a, b) => (b.last_30d ?? 0) - (a.last_30d ?? 0))
      .slice(0, 6);
    if (!top.length) {
      $('topDatasets').innerHTML = '<div class="chart-empty">暂无滚动 30 天数据</div>';
      return;
    }
    const max = top[0].last_30d || 1;
    $('topDatasets').innerHTML = top.map((item, index) =>
      `<div class="top-item"><span class="rank-index">${String(index + 1).padStart(2, '0')}</span>` +
      `<div><div class="rank-model"><span class="rank-name" title="${esc(item.id)}">${esc(item.id.split('/').slice(1).join('/'))}</span></div>` +
      `<div class="rank-progress"><span style="width:${(item.last_30d / max * 100).toFixed(1)}%"></span></div></div>` +
      `<span class="rank-number" title="${esc(fmt(item.last_30d))}">${esc(compact(item.last_30d))}</span></div>`
    ).join('');
  }

  function renderDatasetTable() {
    const search = $('datasetSearch').value.trim().toLowerCase();
    const sort = $('sortDataset').value;
    let rows = data.localDatasets().filter(item => !search || item.id.toLowerCase().includes(search));
    if (sort === 'name') rows.sort((a, b) => a.id.localeCompare(b.id));
    else rows.sort((a, b) => ((b[sort] ?? -Infinity) - (a[sort] ?? -Infinity)) || a.id.localeCompare(b.id));

    $('datasetTableCount').textContent = `${fmt(rows.length)} / ${fmt((data.state.latest.datasets || []).length)} DATASETS`;
    $('datasetRows').innerHTML = rows.length ? rows.map(item => {
      const stateName = item.all_time === null ? '累计缺失' : item.d1 < 0 ? '统计修正?' : item.d1 === null ? '待积累' : '正常';
      const stateClass = item.all_time === null ? 'missing' : item.d1 < 0 ? 'alert' : item.d1 === null ? 'new' : '';
      const tags = [...(item.modality || []), ...(item.languages || []).slice(0, 2)].slice(0, 3);
      return `<tr><td>${item.url
        ? `<a class="model-link" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer" title="在 Hugging Face 打开 ${esc(item.id)}">`
        : `<span class="model-link model-link-plain" title="该数据集没有可用的外部链接">`}` +
        `<span class="model-square">${esc(item.id.split('/').at(-1).slice(0, 1).toUpperCase())}</span>` +
        `<span class="model-title">${esc(item.id.split('/').slice(1).join('/'))}</span>` +
        `${item.url ? '</a>' : '</span>'}</td>` +
        `<td class="align-right">${esc(fmt(item.all_time))}</td>` +
        `<td class="align-right">${esc(fmt(item.last_30d))}</td>` +
        `<td class="align-right ${tone(item.d1)}">${esc(signed(item.d1))}</td>` +
        `<td class="align-right ${tone(item.d7)}">${esc(signed(item.d7))}</td>` +
        `<td class="align-right ${tone(item.d30)}">${esc(signed(item.d30))}</td>` +
        `<td><span class="state ${stateClass}">${esc(stateName)}</span></td>` +
        `<td class="dataset-tags">${tags.length ? tags.map(tag => `<span class="chip tiny">${esc(tag)}</span>`).join('') : '—'}</td></tr>`;
    }).join('') : '<tr><td colspan="8" class="no-rows">没有符合条件的数据集</td></tr>';
  }

  // --- Academic profile -----------------------------------------------------

  function renderScholar() {
    const scholar = data.state.scholar;
    const metrics = scholar?.metrics || {};
    if (!scholar || scholar.status === 'unavailable') {
      $('scholarCard').innerHTML = `<div class="chart-empty">学术档案暂不可用${scholar?.error ? `：${esc(scholar.error)}` : '。采集器会在下一次每日运行时重试，历史数据保持不变。'}</div>`;
      ['statCitations', 'statHIndex', 'statI10', 'statPapers'].forEach(id => { $(id).textContent = '—'; });
      $('paperRows').innerHTML = '<tr><td colspan="5" class="no-rows">尚无学术档案数据</td></tr>';
      charts.yearBars($('scholarYearChart'), [], { emptyText: '暂无逐年引用数据。' });
      charts.line($('scholarTrendChart'), [], { label: '引用总量趋势', emptyText: '需要至少两天的学术快照才能绘制变化曲线。' });
      return;
    }
    const initials = (scholar.name || '?').split(/\s+/).map(word => word[0]).filter(Boolean).join('').slice(0, 2).toUpperCase();
    $('scholarCard').innerHTML =
      `<div class="scholar-avatar">${esc(initials)}</div>` +
      `<div class="scholar-main"><div class="scholar-name">${esc(scholar.name || '—')}</div>` +
      `<div class="scholar-affil">${esc(scholar.affiliation || '—')}` +
      `${scholar.verified_email ? ` · <span class="verified">已验证邮箱 ${esc(scholar.verified_email)}</span>` : ''}</div>` +
      `<div class="chip-row">${(scholar.interests || []).map(item => `<span class="chip">${esc(item)}</span>`).join('') || '<span class="chip muted-chip">未填写研究方向</span>'}</div></div>` +
      `<div class="scholar-side"><div class="scholar-stat"><span>近 5 年引用</span><strong>${esc(fmt(metrics.citations_recent))}</strong></div>` +
      `<div class="scholar-stat"><span>档案采集时间</span><strong>${esc(timestamp(scholar.captured_at))}</strong></div></div>`;

    $('statCitations').textContent = fmt(metrics.citations_all);
    $('statCitationsSub').textContent = `累计引用 · 近 5 年 ${fmt(metrics.citations_recent)}`;
    $('statHIndex').textContent = fmt(metrics.h_index_all);
    $('statI10').textContent = fmt(metrics.i10_all);
    $('statPapers').textContent = fmt(metrics.publications);
    $('statPapersSub').textContent = metrics.truncated ? `已列出 ${fmt(metrics.publications_listed)} 篇 · 存在更多论文` : 'Google Scholar 收录数';
    $('scholarCapturedAt').textContent = scholar.captured_at ? `档案快照 ${timestamp(scholar.captured_at)} UTC` : '—';

    charts.yearBars($('scholarYearChart'), scholar.citations_by_year || []);
    const total = (scholar.citations_by_year || []).reduce((sum, row) => sum + (row.citations || 0), 0);
    $('scholarYearTotal').textContent = `逐年合计 ${fmt(total)} · 全部 ${fmt(metrics.citations_all)}`;

    const points = data.state.scholarSnapshots
      .filter(snapshot => Number.isFinite(snapshot.citations_all))
      .map(snapshot => ({ date: snapshot.date, value: snapshot.citations_all }));
    charts.line($('scholarTrendChart'), [{ name: '引用总数', points, color: 'var(--chart-3)' }],
      { area: true, label: '引用总量每日快照' });
    $('scholarSnapshotCount').textContent = `${fmt(data.state.scholarSnapshots.length)} 个学术快照`;
  }

  function renderPapers() {
    const papers = data.state.scholar?.papers || [];
    const search = $('paperSearch').value.trim().toLowerCase();
    const rows = papers.filter(paper => !search || `${paper.title} ${paper.authors || ''} ${paper.venue || ''}`.toLowerCase().includes(search));
    $('paperCount').textContent = `${fmt(rows.length)} / ${fmt(papers.length)} PAPERS`;
    $('paperRows').innerHTML = rows.length ? rows.map(paper =>
      `<tr><td>${paper.url
        ? `<a class="paper-title" href="${esc(paper.url)}" target="_blank" rel="noopener noreferrer">${esc(paper.title)}</a>`
        : `<span class="paper-title paper-title-plain" title="该论文没有可用的外部链接">${esc(paper.title)}</span>`}</td>` +
      `<td class="paper-authors">${esc(paper.authors || '—')}</td>` +
      `<td class="paper-venue">${esc(paper.venue || '—')}</td>` +
      `<td class="align-right">${esc(paper.year ?? '—')}</td>` +
      `<td class="align-right">${esc(fmt(paper.citations))}</td></tr>`
    ).join('') : '<tr><td colspan="5" class="no-rows">没有符合条件的论文</td></tr>';
  }

  // --- Social media ---------------------------------------------------------

  /** Platform filter chips, built from whatever the snapshot contains. */
  function renderSocialFilters() {
    const sources = data.state.social?.sources || [];
    const ids = data.socialSources().map(source => source.id);
    const current = data.state.socialPlatforms;
    const chips = [`<button class="platform-chip${current === 'all' ? ' active' : ''}" data-platform="all">全部平台</button>`];
    sources.forEach(source => {
      const active = current === 'all' || current.split(',').includes(source.id);
      const label = ids.includes(source.id) ? source.label : `${source.label} · 未配置`;
      chips.push(`<button class="platform-chip${current !== 'all' && active ? ' active' : ''}" data-platform="${esc(source.id)}" ` +
        `style="--chip-accent:${esc(source.color || 'var(--chart-1)')}">${esc(label)}</button>`);
    });
    $('socialPlatformFilter').innerHTML = chips.join('');
  }

  function renderSocialSummary() {
    const sources = data.socialSources();
    const selected = data.selectedSocialIds();
    const selectedSources = sources.filter(source => selected.includes(source.id));
    const total = selectedSources.reduce((sum, source) => sum + source.followers, 0);
    const delta = selectedSources.reduce((sum, source) => sum + (data.socialDelta(source.id) ?? 0), 0);
    const latest = data.state.socialSnapshots.at(-1);
    const capturedAt = data.state.social?.captured_at;

    // Rolling 30-day total: the sum over the last 30 daily snapshots minus the
    // sum over the 30 before that, so it answers "how many new followers in
    // the last month" using the same daily-snapshot source as everything else.
    const snapshots = data.state.socialSnapshots;
    const window30 = snapshots.slice(-30);
    const previousWindow = snapshots.slice(-60, -30);
    const sumWindow = (window, ids) => window.reduce((sum, snapshot) => {
      const followers = snapshot.followers || {};
      return sum + ids.reduce((inner, id) => {
        const value = followers[id];
        return inner + (Number.isFinite(value) ? value : 0);
      }, 0);
    }, 0);
    const rolling = previousWindow.length
      ? sumWindow(window30, selected) - sumWindow(previousWindow, selected)
      : null;

    $('statSocialTotal').textContent = selected.length ? countCN(total) : '—';
    $('statSocialTotal').title = fmt(total);
    $('statSocialTotalSub').textContent = selected.length
      ? `${selected.length} 个平台粉丝数合计`
      : '尚未选择任何平台';
    $('statSocialPlatforms').textContent = fmt(sources.length);
    $('statSocialPlatformsSub').textContent = sources.length
      ? `其中 ${sources.filter(source => source.status === 'ok').length} 个采集成功`
      : '暂无已配置的平台';
    $('statSocialRolling').textContent = rolling === null ? '—' : countCN(rolling);
    $('statSocialRolling').title = rolling === null ? '需要至少 30 天快照' : fmt(rolling);
    $('statSocialRollingSub').textContent = rolling === null
      ? '需至少 60 天快照才能计算'
      : `最近 30 天净增 · 窗口 ${window30.length} 天`;
    $('statSocialDelta').textContent = snapshots.length >= 2 ? signedCN(delta) : '—';
    $('statSocialDelta').classList.toggle('neg', Boolean(delta < 0));
    $('statSocialDeltaSub').textContent = snapshots.length >= 2
      ? `自 ${snapshots.at(-2).date} 起`
      : '需至少两日快照';
    $('socialUpdatedAt').textContent = capturedAt ? `数据更新 ${timestamp(capturedAt)} UTC` : '尚无社交数据';
    $('socialSnapshotDate').textContent = latest ? `最新快照 ${latest.date} UTC` : '—';
    $('socialCountBadge').textContent = fmt(sources.length);
  }

  function renderSocialCards() {
    const state = data.state;
    const sources = state.social?.sources || [];
    if (!sources.length) {
      $('socialCards').innerHTML = '<div class="chart-empty">尚未配置社交平台数据源。请在 config/social_sources.json 中添加平台账号，运行采集器后即可显示。</div>';
      return;
    }
    const selected = data.selectedSocialIds();
    $('socialCards').innerHTML = sources.map(source => {
      const hasValue = Number.isFinite(source.followers);
      const change = data.socialDelta(source.id);
      const isStale = source.stale || source.status !== 'ok';
      const meta = [];
      if (Number.isFinite(source.following)) meta.push(`关注 ${countCN(source.following)}`);
      if (Number.isFinite(source.posts)) meta.push(`作品 ${countCN(source.posts)}`);
      if (Number.isFinite(source.likes)) meta.push(`获赞 ${countCN(source.likes)}`);
      return `<article class="social-card${selected.includes(source.id) ? '' : ' muted-card'}" style="--card-accent:${esc(source.color || 'var(--chart-1)')}">` +
        `<header class="social-card-head">` +
        `<span class="social-platform">${esc(source.label)}</span>` +
        `<span class="state ${source.status === 'ok' ? '' : source.status === 'disabled' ? 'missing' : 'alert'}">` +
        `${source.status === 'ok' ? '已同步' : source.status === 'disabled' ? '未配置' : '暂不可用'}</span>` +
        `</header>` +
        `<div class="social-followers" title="${hasValue ? esc(fmt(source.followers)) : '无数据'}">${hasValue ? esc(countCN(source.followers)) : '—'}</div>` +
        `<div class="social-followers-label">粉丝数</div>` +
        `<div class="social-meta">${meta.length ? meta.map(item => `<span>${esc(item)}</span>`).join('') : '<span class="muted">暂无其他指标</span>'}</div>` +
        `<div class="social-delta ${tone(change)}">${change === null ? '—' : `${esc(signedCN(change))} · 自上次快照`}</div>` +
        `<footer class="social-card-foot">` +
        `<span class="social-updated" title="${esc(source.updated_at ? `采集于 ${source.updated_at}` : '尚未成功采集')}">` +
        `${source.updated_at ? `更新 ${esc(timestamp(source.updated_at))}` : '未成功采集'}</span>` +
        (source.url ? `<a class="social-link" href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">主页 ↗</a>` : '') +
        `</footer>` +
        (isStale && source.error ? `<p class="social-error" title="${esc(source.error)}">${esc(source.error)}</p>` : '') +
        `</article>`;
    }).join('');
  }

  function renderSocialTable() {
    const sources = data.state.social?.sources || [];
    const selected = data.selectedSocialIds();
    const rows = sources.filter(source => selected.includes(source.id) || data.state.socialPlatforms === 'all');
    $('socialTableCount').textContent = `${fmt(rows.length)} / ${fmt(sources.length)} PLATFORMS`;
    $('socialRows').innerHTML = rows.length ? rows.map(source => {
      const change = data.socialDelta(source.id);
      return `<tr><td><span class="social-dot" style="background:${esc(source.color || 'var(--chart-1)')}"></span>` +
        `<span class="social-name">${esc(source.label)}</span>` +
        `${source.detail ? `<span class="social-detail">${esc(source.detail)}</span>` : ''}</td>` +
        `<td class="align-right">${esc(fmt(source.followers))}</td>` +
        `<td class="align-right">${esc(countCN(source.followers))}</td>` +
        `<td class="align-right">${esc(Number.isFinite(source.following) ? fmt(source.following) : '—')}</td>` +
        `<td class="align-right">${esc(Number.isFinite(source.posts) ? fmt(source.posts) : '—')}</td>` +
        `<td class="align-right ${tone(change)}">${esc(change === null ? '—' : signed(change))}</td>` +
        `<td><span class="state ${source.status === 'ok' ? '' : source.status === 'disabled' ? 'missing' : 'alert'}">` +
        `${source.status === 'ok' ? '已同步' : source.status === 'disabled' ? '未配置' : '暂不可用'}</span></td>` +
        `<td>${source.updated_at ? esc(timestamp(source.updated_at)) : '—'}</td></tr>`;
    }).join('') : '<tr><td colspan="8" class="no-rows">没有符合条件的数据源</td></tr>';
  }

  function renderSocialChart() {
    const state = data.state;
    const points = data.socialSeries(state.socialRange);
    const selected = data.selectedSocialIds();
    const series = selected.length === 1
      ? [{
        name: data.socialSources().find(source => source.id === selected[0])?.label || '',
        points: state.socialSnapshots.map(snapshot => {
          const value = snapshot.followers?.[selected[0]];
          return { date: snapshot.date, value: Number.isFinite(value) ? value : NaN };
        }).filter(point => Number.isFinite(point.value)),
        color: data.socialSources().find(source => source.id === selected[0])?.color
      }]
      : [{ name: '粉丝总数', points, color: 'var(--chart-1)' }];
    charts.line($('socialChart'), series, {
      area: true,
      label: '社交平台粉丝数趋势',
      emptyText: '需要至少两天的社交快照才能绘制粉丝变化曲线。'
    });
    $('socialChartTotal').textContent = points.length
      ? `合计 ${countCN(points.at(-1).value)} · ${selected.length} 个平台`
      : '—';
  }

  function renderSocial() {
    renderSocialFilters();
    renderSocialSummary();
    renderSocialCards();
    renderSocialTable();
    renderSocialChart();
    const view = data.state.socialView;
    $('socialCards').classList.toggle('hidden', view !== 'cards');
    $('socialTableWrap').classList.toggle('hidden', view !== 'table');
    document.querySelectorAll('[data-social-view]').forEach(button =>
      button.classList.toggle('active', button.dataset.socialView === view));
  }

  // --- GitHub board ---------------------------------------------------------

  /** Banner inside the GitHub section for errors and stale data. */
  function renderGitHubBanner() {
    const github = data.state.github;
    const banner = $('githubBanner');
    if (!github) {
      banner.classList.add('hidden');
      return;
    }
    if (github.status === 'unavailable') {
      banner.textContent = `GitHub 数据暂不可用：${github.error || '未知原因'}。看板将保留空白，其他板块不受影响。`;
      banner.classList.remove('hidden');
      banner.classList.remove('info');
      return;
    }
    if (github.status === 'stale' && github.error) {
      banner.textContent = `本次抓取失败，展示的是上一次成功快照：${github.error}`;
      banner.classList.remove('hidden');
      banner.classList.add('info');
      return;
    }
    banner.classList.add('hidden');
  }

  function renderGitHubSummary() {
    const github = data.state.github || {};
    const account = github.account || {};
    const totals = data.githubTotals();
    const growth = data.githubGrowth();
    const followers = Number.isFinite(account.followers) ? account.followers : null;

    $('statGithubFollowers').textContent = followers === null ? '—' : countCN(followers);
    $('statGithubFollowers').title = followers === null ? '无数据' : fmt(followers);
    $('statGithubFollowersSub').textContent = followers === null
      ? '暂未采集到粉丝数'
      : `精确值 ${fmt(followers)} · ${esc(account.login || '—')}`;

    $('statGithubGrowth').textContent = growth.delta === null ? '—' : signedCN(growth.delta);
    $('statGithubGrowth').classList.toggle('neg', Boolean(growth.delta < 0));
    $('statGithubGrowthSub').textContent = growth.delta === null
      ? '需至少两日快照'
      : `自 ${growth.from} 至 ${growth.to}`;

    $('statGithubRate').textContent = growth.rate === null
      ? '—'
      : `${growth.rate > 0 ? '+' : ''}${(growth.rate * 100).toFixed(2)}%`;
    $('statGithubRate').classList.toggle('neg', Boolean(growth.rate < 0));
    $('statGithubRateSub').textContent = growth.rate === null
      ? '需至少两日快照'
      : `基于 ${fmt(growth.delta)} 人的净增`;

    $('statGithubRepos').textContent = fmt(totals.repositories);
    $('statGithubReposSub').textContent = `Star ${fmt(totals.stars)} · Fork ${fmt(totals.forks)} · ${fmt(totals.languages)} 种语言`;

    $('githubRepoBadge').textContent = fmt(totals.repositories);
    $('githubCapturedAt').textContent = github.captured_at
      ? `采集于 ${timestamp(github.captured_at)} UTC`
      : '尚无 GitHub 数据';

    const profileUrl = account.url || 'https://github.com/isLinXu';
    $('githubProfileLink').href = profileUrl;
  }

  function renderGitHubChart() {
    const points = data.githubSeries();
    charts.line($('githubChart'), [{ name: '关注者', points, color: 'var(--chart-4)' }], {
      area: true,
      label: 'GitHub 粉丝数趋势',
      emptyText: '需要至少两天的 GitHub 快照才能绘制粉丝变化曲线。'
    });
    $('githubChartNote').textContent = points.length
      ? `${fmt(points.length)} 个快照 · 最新 ${fmt(points.at(-1).value)}`
      : '—';
  }

  function renderGitHubLanguageChart() {
    const languages = data.githubLanguages().slice(0, 8);
    const total = data.githubLanguages().reduce((sum, item) => sum + item.count, 0);
    if (!languages.length) {
      charts.yearBars($('githubLangChart'), [], { emptyText: '暂无语言数据。' });
      $('githubLangTotal').textContent = '—';
      return;
    }
    charts.ranking($('githubLangChart'), languages.map(item => ({
      label: item.language,
      value: item.count,
      color: 'var(--chart-2)'
    })), { emptyText: '暂无语言数据。' });
    $('githubLangTotal').textContent = `共 ${fmt(total)} 个带语言标注的仓库`;
  }

  function renderGitHubTopRepos() {
    const repos = [...(data.state.github?.repositories || [])]
      .filter(repo => (repo.stars || 0) > 0)
      .sort((a, b) => (b.stars || 0) - (a.stars || 0))
      .slice(0, 8);
    if (!repos.length) {
      $('githubTopRepos').innerHTML = '<div class="chart-empty">暂无带 Star 的公开仓库</div>';
      return;
    }
    const max = repos[0].stars || 1;
    $('githubTopRepos').innerHTML = repos.map((repo, index) =>
      `<div class="top-item"><span class="rank-index">${String(index + 1).padStart(2, '0')}</span>` +
      `<div><div class="rank-model"><a class="rank-name" href="${esc(repo.url || '#')}" target="_blank" rel="noopener noreferrer" title="${esc(repo.full_name)}">${esc(repo.name)}</a></div>` +
      `<div class="rank-progress"><span style="width:${(repo.stars / max * 100).toFixed(1)}%"></span></div></div>` +
      `<span class="rank-number" title="${esc(fmt(repo.stars))} 个 Star">${esc(compact(repo.stars))}</span></div>`
    ).join('');
  }

  function renderGitHubTable() {
    const all = data.state.github?.repositories || [];

    // Keep the language dropdown in sync with whatever the snapshot contains.
    const select = $('filterGithubLanguage');
    const languages = data.githubLanguages().map(item => item.language);
    const wanted = ['all', ...languages].join('|');
    if (select.dataset.signature !== wanted) {
      select.dataset.signature = wanted;
      const current = data.state.githubLanguage;
      select.innerHTML = ['<option value="all">全部语言</option>']
        .concat(languages.map(language => `<option value="${esc(language)}">${esc(language)}</option>`))
        .join('');
      select.value = languages.includes(current) ? current : 'all';
      data.state.githubLanguage = select.value;
    }

    const rows = data.githubRepositories();
    const size = data.state.githubPageSize;
    const pages = Math.max(1, Math.ceil(rows.length / size));
    const page = Math.min(Math.max(1, data.state.githubPage), pages);
    data.state.githubPage = page;
    const slice = rows.slice((page - 1) * size, page * size);

    $('githubTableCount').textContent = `${fmt(rows.length)} / ${fmt(all.length)} REPOSITORIES`;
    $('githubRows').innerHTML = slice.length ? slice.map(repo => {
      const flags = [];
      if (repo.is_fork) flags.push('Fork');
      if (repo.archived) flags.push('已归档');
      const stateName = repo.archived ? '已归档' : repo.is_fork ? 'Fork 仓库' : '正常';
      const stateClass = repo.archived ? 'missing' : repo.is_fork ? 'new' : '';
      return `<tr><td><a class="model-link" href="${esc(repo.url || '#')}" target="_blank" rel="noopener noreferrer" title="${esc(repo.full_name)}">` +
        `<span class="model-square">${esc((repo.name || '?').slice(0, 1).toUpperCase())}</span>` +
        `<span class="model-title">${esc(repo.name)}</span></a>` +
        `${repo.description ? `<span class="repo-desc" title="${esc(repo.description)}">${esc(repo.description)}</span>` : ''}</td>` +
        `<td class="align-right">${esc(fmt(repo.stars))}</td>` +
        `<td class="align-right">${esc(fmt(repo.forks))}</td>` +
        `<td>${repo.language ? `<span class="chip tiny">${esc(repo.language)}</span>` : '—'}</td>` +
        `<td class="repo-updated">${esc(timestamp(repo.updated_at))}</td>` +
        `<td><span class="state ${stateClass}">${esc(stateName)}</span>${flags.length ? `<span class="repo-flags">${flags.map(flag => `<span class="chip tiny muted-chip">${esc(flag)}</span>`).join('')}</span>` : ''}</td></tr>`;
    }).join('') : '<tr><td colspan="6" class="no-rows">没有符合条件的仓库</td></tr>';

    const pagination = $('githubPagination');
    pagination.hidden = rows.length <= size;
    $('githubPageInfo').textContent = `第 ${fmt(page)} / ${fmt(pages)} 页 · 每页 ${fmt(size)} 条`;
    $('githubPrevPage').disabled = page <= 1;
    $('githubNextPage').disabled = page >= pages;
  }

  function renderGitHubProjects() {
    const projects = data.state.github?.projects || {};
    const items = projects.items || [];
    const wrap = $('githubProjects');
    if (!items.length) {
      wrap.classList.add('hidden');
      return;
    }
    wrap.classList.remove('hidden');
    $('githubProjectList').innerHTML = items.map(project =>
      `<a class="project-card" href="${esc(project.url || '#')}" target="_blank" rel="noopener noreferrer">` +
      `<div class="project-title">${esc(project.title || '未命名项目')}</div>` +
      `${project.description ? `<div class="project-desc">${esc(project.description)}</div>` : ''}` +
      `<div class="project-meta"><span>#${esc(project.number ?? '—')}</span>` +
      `<span>${esc(project.state || '')}</span>` +
      `<span>${esc(timestamp(project.updated_at))}</span></div></a>`
    ).join('');
  }

  function renderGitHub() {
    renderGitHubBanner();
    renderGitHubSummary();
    renderGitHubChart();
    renderGitHubLanguageChart();
    renderGitHubTopRepos();
    renderGitHubTable();
    renderGitHubProjects();
  }

  // --- Model detail overlay -------------------------------------------------

  function renderDetail() {
    const id = data.state.model;
    if (!id) return;
    const model = data.state.latest.models.find(item => item.id === id);
    if (!model) return;
    $('detailTitle').textContent = model.id.split('/').slice(1).join('/');
    $('detailID').textContent = model.id;
    const d1 = data.delta(id, 'prev'), d7 = data.delta(id, 7), d30 = data.delta(id, 30);
    $('detailContents').innerHTML =
      `<div class="detail-metrics">` +
      `<div class="detail-stat"><span>历史累计下载</span><strong>${esc(fmt(model.all_time))}</strong></div>` +
      `<div class="detail-stat"><span>滚动 30 天</span><strong>${esc(fmt(model.last_30d))}</strong></div>` +
      `<div class="detail-stat"><span>上次变化</span><strong class="${tone(d1)}">${esc(signed(d1))}</strong></div>` +
      `<div class="detail-stat"><span>7日净变化</span><strong class="${tone(d7)}">${esc(signed(d7))}</strong></div></div>` +
      `<div class="detail-chart-title">历史累计下载</div>` +
      `<p class="detail-note">同一模型的累计下载计数；如有下降，说明存在统计回调、重算或其他异常。</p>` +
      `<div id="detailChartAll" class="chart-area" style="height:225px"></div>` +
      `<div class="detail-section"><div class="detail-chart-title">滚动 30 天下载量</div>` +
      `<p class="detail-note">该曲线可以正常回落，不应解释为历史下载被取消。</p>` +
      `<div id="detailChartRolling" class="chart-area" style="height:225px"></div></div>` +
      `<div class="detail-section"><div class="detail-chart-title">最近快照</div>` +
      `<div class="detail-note">30日净变：<b class="${tone(d30)}">${esc(signed(d30))}</b> · 点开曲线可查各采集日期的具体数字</div>` +
      `<table class="history-table"><thead><tr><th>UTC 日期</th><th class="align-right">累计</th>` +
      `<th class="align-right">滚动30天</th><th class="align-right">相邻净变化</th></tr></thead><tbody id="detailTable"></tbody></table></div>` +
      (model.url
        ? `<a class="detail-action" href="${esc(model.url)}" target="_blank" rel="noopener noreferrer">前往 Hugging Face 模型主页 ↗</a>`
        : '<p class="detail-note">该模型没有可用的外部链接。</p>');

    charts.line($('detailChartAll'), [{ name: id, points: data.modelSeries(id, 'all_time'), color: 'var(--chart-1)' }],
      { area: true, label: '该模型累计下载趋势' });
    charts.line($('detailChartRolling'), [{ name: id, points: data.modelSeries(id, 'last_30d'), color: 'var(--chart-2)' }],
      { area: true, label: '该模型滚动30天趋势' });

    const existing = data.state.snapshots.filter(snapshot => snapshot.models?.[id]).slice(-15).reverse();
    $('detailTable').innerHTML = existing.map(snapshot => {
      const index = data.state.snapshots.indexOf(snapshot);
      const value = data.pairDelta(id, snapshot, data.state.snapshots[index - 1]);
      const current = snapshot.models[id];
      return `<tr><td>${esc(snapshot.date)}</td><td class="align-right">${esc(fmt(current[0]))}</td>` +
        `<td class="align-right">${esc(fmt(current[1]))}</td>` +
        `<td class="align-right ${tone(value)}">${esc(signed(value))}</td></tr>`;
    }).join('');
  }

  return {
    stateMessage,
    showToast,
    renderSummary,
    renderOverall,
    renderTop,
    renderTable,
    renderCompare,
    renderDatasetSummary,
    renderDatasetChart,
    renderTopDatasets,
    renderDatasetTable,
    renderScholar,
    renderPapers,
    renderSocial,
    renderSocialFilters,
    renderSocialSummary,
    renderSocialCards,
    renderSocialTable,
    renderSocialChart,
    renderGitHub,
    renderGitHubBanner,
    renderGitHubSummary,
    renderGitHubChart,
    renderGitHubLanguageChart,
    renderGitHubTopRepos,
    renderGitHubTable,
    renderGitHubProjects,
    renderDetail
  };
})();
