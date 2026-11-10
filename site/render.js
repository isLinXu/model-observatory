/* Model Observatory — rendering layer.
 * Every function here reads from MO.data.state and writes into the DOM.
 * No network access and no event binding live in this file.
 */
window.MO = window.MO || {};

MO.render = (() => {
  'use strict';

  const { esc, fmt, compact, countCN, signed, signedCN, tone, dayLabel, timestamp, plate, ageInDays,
    countdown, deadlineTone, offsetLabel } = MO.format;
  const charts = MO.charts;
  const data = MO.data;

  const $ = id => document.getElementById(id);

  function pageWindow(page, pages) {
    if (pages <= 7) return Array.from({ length: pages }, (_, index) => index + 1);
    const picked = new Set([1, pages, page - 1, page, page + 1]);
    if (page <= 3) [2, 3, 4].forEach(n => picked.add(n));
    if (page >= pages - 2) [pages - 3, pages - 2, pages - 1].forEach(n => picked.add(n));
    const items = [];
    [...picked].filter(n => n >= 1 && n <= pages).sort((a, b) => a - b).forEach(n => {
      if (items.length && n - items.at(-1) > 1) items.push('…');
      items.push(n);
    });
    return items;
  }

  function renderPager(id, pager) {
    const element = $(id);
    if (!element) return pager;
    element.hidden = pager.total <= pager.size;
    if (element.hidden) {
      element.innerHTML = '';
      return pager;
    }
    const numbers = pageWindow(pager.page, pager.pages).map(item => item === '…'
      ? '<span class="page-ellipsis" aria-hidden="true">…</span>'
      : `<button type="button" class="page-num${item === pager.page ? ' is-current' : ''}" data-page="${item}"${item === pager.page ? ' aria-current="page"' : ''} aria-label="第 ${item} 页">${item}</button>`
    ).join('');
    element.innerHTML =
      `<button type="button" class="button secondary" data-page="${pager.page - 1}" ${pager.page <= 1 ? 'disabled' : ''} aria-label="上一页">← 上一页</button>` +
      `<div class="page-numbers">${numbers}</div>` +
      `<button type="button" class="button secondary" data-page="${pager.page + 1}" ${pager.page >= pager.pages ? 'disabled' : ''} aria-label="下一页">下一页 →</button>` +
      `<span class="micro muted page-status" aria-live="polite">第 ${fmt(pager.page)} / ${fmt(pager.pages)} 页 · 每页 ${fmt(pager.size)} 条</span>`;
    return pager;
  }

  const HEADLINE = {
    empty: '等待第一次公开快照。',
    waiting: '首次快照已就位，变化从第二次采集开始。',
    idle: '各领域公开指标保持稳定。'
  };

  function headlineText(headline) {
    if (!headline) return '正在读取公开快照…';
    if (headline.kind === 'delta') return `${headline.label} ${signed(headline.value)}`;
    if (headline.kind === 'warn') return `${fmt(headline.value)} 个模型累计值下降，待核查。`;
    return HEADLINE[headline.kind] || HEADLINE.idle;
  }

  function renderBriefing() {
    if (typeof data.briefing !== 'function') return;
    const brief = data.briefing();
    const headline = $('briefingHeadline');
    if (headline) {
      if (brief.headline?.kind === 'delta') {
        headline.innerHTML = `${esc(brief.headline.label)} <em>${esc(signed(brief.headline.value))}</em>`;
      } else {
        headline.textContent = headlineText(brief.headline);
      }
      headline.classList.toggle('is-warn', brief.headline?.kind === 'warn');
      headline.classList.toggle('is-down', brief.headline?.kind === 'delta' && brief.headline.value < 0);
    }
    const notes = $('briefingNotes');
    if (notes) {
      notes.hidden = !brief.notes.length;
      notes.innerHTML = brief.notes.map(note => {
        const body = note.href ? `<a href="${esc(note.href)}">${esc(note.text)}</a>` : esc(note.text);
        return `<li class="briefing-note ${esc(note.tone)}"><span class="mark" aria-hidden="true"></span><span>${body}</span></li>`;
      }).join('');
    }
    const grid = $('pulseGrid');
    if (grid) grid.innerHTML = brief.pulses.map(pulse => {
      const value = pulse.id === 'models' || pulse.id === 'datasets' || pulse.id === 'social'
        ? countCN(pulse.value) : fmt(pulse.value);
      const caption = pulse.id === 'github' && pulse.available
        ? `Star ${fmt(pulse.stars)} · ${fmt(pulse.repositories)} 个仓库`
        : pulse.caption;
      const delta = pulse.delta === null || pulse.delta === undefined ? '—'
        : pulse.delta === 0 ? '持平' : signed(pulse.delta);
      const lead = brief.headline?.kind === 'delta' && pulse.label === brief.headline.label;
      return `<a class="pulse${pulse.available ? '' : ' muted'}${lead ? ' is-lead' : ''}" href="${esc(pulse.href)}">` +
        `<div class="pulse-kicker">${esc(pulse.label)}</div>` +
        `<div class="pulse-value" title="${esc(fmt(pulse.value))}">${esc(value)}</div>` +
        `<div class="pulse-delta ${tone(pulse.delta)}">${esc(delta)}</div>` +
        `<div class="pulse-caption">${esc(caption)}</div></a>`;
    }).join('');
  }

  function renderAttention() {
    const host = $('attentionList');
    if (!host || typeof data.attention !== 'function') return;
    const items = data.attention();
    host.hidden = !items.length;
    host.innerHTML = items.map(item => {
      const kicker = item.domain === 'conferences' ? '截止'
        : item.tone === 'warn' ? '需处理' : '提示';
      return `<li class="attention-item ${esc(item.tone)}"><a href="${esc(item.href)}">` +
        `<span class="attention-kicker">${kicker}</span>` +
        `<strong>${esc(item.title)}</strong><span>${esc(item.detail || '')}</span></a></li>`;
    }).join('');
  }

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

  function renderCollections() {
    const state = data.state;
    const available = data.collectionsAvailable();
    const collections = state.collections?.items || [];
    const selected = collections.find(item => item.slug === state.modelCollection);
    const scopeName = state.modelCollection === 'all' ? '全部模型'
      : state.modelCollection === 'unassigned' ? '未归入集合' : selected?.title || '集合不可用';
    $('collectionFilter').innerHTML = '<option value="all">全部模型</option>' + (available
      ? '<option value="unassigned">未归入集合</option>' + collections.map(item =>
        `<option value="${esc(item.slug)}">${esc(item.title)} · ${fmt(data.modelScope(item.slug).length)} 个模型</option>`).join('')
      : '');
    $('collectionFilter').value = state.modelCollection;
    $('collectionFilter').disabled = !available;
    $('collectionReset').disabled = state.modelCollection === 'all';
    $('modelScopeLabel').textContent = scopeName;
    const scopeHost = $('collectionScope');
    const onList = scopeHost && typeof scopeHost.closest === 'function'
      && scopeHost.closest('[data-workspace]')?.dataset.workspace === 'models';
    $('modelScopeNote').textContent = onList
      ? '这个范围筛的是下面这份清单。同一范围的曲线在「下载趋势」。'
      : state.modelCollection === 'all'
        ? '这里的范围同时作用于曲线、热门模型和清单。'
        : '按当前集合归属回看历史，仅统计当前公开模型；缺失字段不当作 0。';
    $('collectionDescription').textContent = selected?.description || '';
    $('collectionCount').textContent = fmt(collections.length);
    const error = state.collectionRefreshError || state.collections?.error;
    const source = available ? state.collectionSource === 'live' ? 'HF 实时集合' : '已发布集合快照' : '集合暂不可用';
    $('collectionSource').textContent = `${source}${state.collections?.captured_at ? ` · ${timestamp(state.collections.captured_at)} UTC` : ''}${error ? ' · 刷新失败，保留上次数据' : ''}`;
    $('collectionSource').title = error || '';
    $('collectionSource').classList.toggle('neg', Boolean(error));
    const all = state.latest?.models || [];
    const covered = new Set(all.filter(model => data.modelCollections(model.id).length).map(model => model.id));
    $('collectionCoverage').textContent = available
      ? `已归类 ${fmt(covered.size)} / ${fmt(all.length)} 个公开模型 · 未归类 ${fmt(all.length - covered.size)} 个`
      : '集合不可用时不会把模型误判为未归类。';
    if (!available || !collections.length) {
      $('collectionCards').innerHTML = `<div class="chart-empty">${available ? '该账户暂无公开集合，可继续观测全部模型。' : '暂时无法读取公开集合；模型下载与其他看板不受影响。'}</div>`;
      return;
    }
    $('collectionCards').innerHTML = collections.map((collection, index) => {
      const stats = data.collectionStats(collection.slug);
      const members = collection.items.filter(item => item.type === 'model');
      const other = collection.items.length - members.length;
      const href = `https://huggingface.co/collections/${collection.slug.split('/').map(encodeURIComponent).join('/')}`;
      const metric = (key, label) => `<div><span>${label}</span><strong title="${esc(fmt(stats[key].value))}">${esc(countCN(stats[key].value))}</strong>` +
        `<small>有效 ${stats[key].known}/${stats.count} 个</small></div>`;
      return `<article class="collection-card${state.modelCollection === collection.slug ? ' selected' : ''}" style="--collection-accent:${charts.colorAt(index)}">` +
        `<div class="collection-card-head"><span class="collection-kind">${members.length ? '模型集合' : '导航 / 其他条目'}</span><span class="micro muted">${stats.count} 个模型</span></div>` +
        `<h3><a href="${href}" target="_blank" rel="noopener noreferrer">${esc(collection.title)} ↗</a></h3>` +
        `<p class="collection-description" title="${esc(collection.description)}">${esc(collection.description || '暂无集合说明')}</p>` +
        `<div class="collection-metrics">${metric('all_time', '累计下载')}${metric('last_30d', '滚动 30 天')}</div>` +
        `<div class="collection-card-foot"><span>${members.length - stats.count} 个模型不在当前清单${other ? ` · ${other} 个非模型条目` : ''}</span>` +
        `<button class="button secondary" data-collection="${esc(collection.slug)}" aria-pressed="${state.modelCollection === collection.slug}">观测集合</button></div></article>`;
    }).join('');
  }

  function renderModelScopeTable() {
    const state = data.state, rows = data.modelscopeModels();
    const pages = Math.max(1, Math.ceil(rows.length / 20));
    state.modelscopePage = Math.min(Math.max(1, state.modelscopePage), pages);
    $('modelscopeTableCount').textContent = `${fmt(rows.length)} / ${fmt(state.modelscope?.models?.length || 0)} 个模型`;
    $('modelscopeRows').innerHTML = rows.length ? rows.slice((state.modelscopePage - 1) * 20, state.modelscopePage * 20).map(model => {
      const change = data.modelscopeDelta(model.id);
      const href = `https://www.modelscope.cn/models/${model.id.split('/').map(encodeURIComponent).join('/')}`;
      return `<tr><td><a class="model-link" href="${href}" target="_blank" rel="noopener noreferrer">${esc(model.name || model.id)} ↗</a>` +
        `<div class="micro muted">${esc(model.id)}</div></td><td class="align-right">${esc(fmt(model.downloads))}</td>` +
        `<td class="align-right">${esc(fmt(model.likes))}</td><td class="align-right ${tone(change?.value)}">${esc(signed(change?.value))}</td>` +
        `<td>${esc(model.tasks.join(' · ') || '未标注')}</td><td>${esc(model.updated_at?.slice(0, 10) || '—')}</td>` +
        `<td>${model.gated ? '需申请访问' : '公开'}</td><td><button class="button text-button" data-ms-model="${esc(model.id)}" aria-pressed="${state.modelscopeModel === model.id}">观测趋势</button></td></tr>`;
    }).join('') : '<tr><td colspan="8" class="no-rows">没有匹配的 ModelScope 模型</td></tr>';
    $('modelscopePageInfo').textContent = `${state.modelscopePage} / ${pages}`;
    $('modelscopePrev').disabled = state.modelscopePage === 1;
    $('modelscopeNext').disabled = state.modelscopePage === pages;
    $('modelscopePagination').hidden = rows.length <= 20;
  }

  function renderModelScopeChart() {
    const state = data.state;
    const label = state.modelscopeMetric === 'likes' ? '点赞计数' : '下载计数';
    const model = state.modelscopeModel === 'all' ? '全部 OpenAPI 模型' : state.modelscopeModel;
    $('modelscopeChartLabel').textContent = `${model} · ${label}`;
    $('modelscopeChartReset').disabled = state.modelscopeModel === 'all';
    const points = data.modelscopeSeries();
    charts.line($('modelscopeChart'), [{ name: label, points, color: 'var(--chart-4)' }], {
      area: true, label: `ModelScope ${label}历史观测`, emptyText: '尚无有效历史快照；每日采集后开始积累，不补造历史数据。'
    });
    const delta = data.modelscopeDelta(state.modelscopeModel === 'all' ? null : state.modelscopeModel);
    $('modelscopeChartNote').textContent = `${points.length} 个有效快照` + (delta
      ? ` · 下载计数净变化 ${signed(delta.value)}（${delta.from} → ${delta.to}，${delta.compared} 个可比模型）`
      : ' · 至少两日快照后显示下载计数净变化');
  }

  function renderModelScopeProfile() {
    const latest = data.state.modelscope || {}, profile = latest.profile;
    const downloads = profile?.status === 'ok' ? profile.downloads : null;
    $('statModelscopeProfileDownloads').textContent = countCN(downloads);
    $('statModelscopeProfileDownloads').title = fmt(downloads);
    $('statModelscopeProfileDownloadsSub').textContent = Number.isFinite(downloads)
      ? `精确值 ${fmt(downloads)} · 公开主页 User.Downloads`
      : '未采集到有效主页下载计数，不以模型计数替代';
    const previousCapture = data.state.modelscopeSnapshots.findLast(snapshot => snapshot.profile_captured_at && Number.isFinite(snapshot.profile_downloads))?.profile_captured_at;
    $('modelscopeProfileCapturedAt').textContent = profile?.status === 'ok'
      ? `主页采集于 ${timestamp(profile.captured_at)} UTC${latest.status === 'stale' ? ' · 保留上次快照' : ''}`
      : `主页采集暂不可用；已有历史记录仍保留${previousCapture ? ` · 最近有效记录 ${timestamp(previousCapture)} UTC` : ''}`;
    const delta = data.modelscopeProfileDelta();
    $('statModelscopeProfileChange').textContent = signedCN(delta?.value);
    $('statModelscopeProfileChange').title = signed(delta?.value);
    $('statModelscopeProfileChange').classList.toggle('neg', Boolean(delta?.value < 0));
    $('statModelscopeProfileChange').classList.toggle('pos', Boolean(delta?.value > 0));
    $('statModelscopeProfileChangeSub').textContent = delta
      ? `${delta.from} → ${delta.to} · 精确差值 ${signed(delta.value)}`
      : '需最近两次快照均含主页下载计数；缺失时不跨记录比较';
    const points = data.modelscopeProfileSeries();
    charts.line($('modelscopeProfileChart'), [{ name: '主页下载计数', points, color: 'var(--chart-2)' }], {
      area: true, label: 'ModelScope 主页下载计数历史', yFormatter: countCN,
      emptyText: '尚无主页下载历史；从首次成功记录开始积累，旧快照不回填、不补零。'
    });
    $('modelscopeProfileChartNote').textContent = points.length
      ? `${points.length} 个有效主页快照 · ${points[0].date} → ${points.at(-1).date} · 缺失记录不补零`
      : '主页下载历史尚未开始；模型历史不作为替代';
  }

  function snapshotFreshness(capture) {
    const age = ageInDays(capture);
    if (age === null) return { text: '采集时间未知', overdue: false };
    const elapsed = age < 1 / 24 ? '距今不足 1 小时' : age < 2 ? `距今 ${Math.floor(age * 24)} 小时` : `距今 ${Math.floor(age)} 天`;
    return { text: `${elapsed}${age >= 2 ? ' · 超过 48 小时未更新，请检查后台采集与部署' : ''}`, overdue: age >= 2 };
  }

  function renderModelScopeBoard() {
    const state = data.state, latest = state.modelscope || {}, totals = data.modelscopeTotals();
    const available = ['ok', 'stale'].includes(latest.status);
    $('statModelscopeModels').textContent = available ? fmt(totals.count) : '—';
    for (const [metric, id] of [['downloads', 'statModelscopeDownloads'], ['likes', 'statModelscopeLikes']]) {
      $(id).textContent = countCN(totals[metric].value);
      $(id).title = fmt(totals[metric].value);
      $(id + 'Sub').textContent = `已知 ${totals[metric].known}/${totals.count} 个模型 · 不含其他平台`;
    }
    const profile = latest.profile;
    $('statModelscopeFollowers').textContent = countCN(profile?.followers);
    $('statModelscopeFollowers').title = fmt(profile?.followers);
    $('modelscopeProfileNote').textContent = profile?.status === 'ok'
      ? `公开主页显示 ${fmt(profile.model_count)} 个模型（含预发布），主页下载计数 ${fmt(profile.downloads)}；与本看板 OpenAPI 清单和计数不混用。主页指标采集于 ${timestamp(profile.captured_at)} UTC。`
      : '公开主页辅助指标暂不可用；不影响 OpenAPI 模型观测。';
    const live = state.modelscopeSource === 'live';
    const capture = live ? state.modelscopeSnapshotCapturedAt : latest.captured_at;
    const savedStatus = live ? state.modelscopeSnapshotStatus : latest.status;
    const savedError = live ? state.modelscopeSnapshotError : latest.error;
    const captureLabel = value => Number.isFinite(Date.parse(value)) ? `${timestamp(value)} UTC` : '采集时间未知';
    const status = [available
      ? live ? `OpenAPI 实时清单 · 实时查询成功于 ${captureLabel(latest.captured_at)} · 后台最近成功采集 ${captureLabel(capture)}`
        : `已发布 OpenAPI 快照 · 最近成功采集 ${captureLabel(capture)}`
      : 'ModelScope 数据暂不可用，其他看板不受影响。'];
    if (savedStatus === 'stale' || savedError) status.push(`后台采集失败，保留上次快照${savedError ? `：${savedError}` : ''}`);
    if (state.modelscopeSnapshotRefreshError) status.push(`快照读取失败，保留上次数据：${state.modelscopeSnapshotRefreshError}`);
    if (state.modelscopeRefreshError) status.push(`实时查询失败，保留上次数据：${state.modelscopeRefreshError}`);
    $('modelscopeStatus').textContent = status.join(' · ');
    $('modelscopeStatus').title = [state.modelscopeSnapshotRefreshError, state.modelscopeRefreshError, savedError].filter(Boolean).join('\n');
    $('modelscopeStatus').classList.toggle('neg', !available || status.length > 1);
    const modelAge = snapshotFreshness(capture);
    const profileCapture = profile?.status === 'ok' ? profile.captured_at
      : state.modelscopeSnapshots.findLast(snapshot => snapshot.profile_captured_at && Number.isFinite(snapshot.profile_downloads))?.profile_captured_at;
    const profileAge = snapshotFreshness(profileCapture);
    $('modelscopeFreshness').textContent = `模型快照：${modelAge.text}；主页${profile?.status === 'ok' ? '' : '最近有效历史'}：${profileAge.text}。`;
    $('modelscopeFreshness').classList.toggle('neg', modelAge.overdue || profileAge.overdue);
    $('modelscopeSnapshotCheckedAt').textContent = `${state.modelscopeSnapshotCheckedAt
      ? `最近成功读取快照 ${timestamp(state.modelscopeSnapshotCheckedAt)} UTC` : '尚未成功读取快照'} · 读取不代表重新采集`;
    $('modelscopeExport').disabled = !available;
    const tasks = [...new Set((latest.models || []).flatMap(model => model.tasks))].sort();
    $('modelscopeTask').innerHTML = '<option value="all">全部任务类型</option>' + tasks.map(task => `<option value="${esc(task)}">${esc(task)}</option>`).join('');
    $('modelscopeTask').value = state.modelscopeTask;
    renderModelScopeProfile();
    renderModelScopeChart();
    renderModelScopeTable();
  }

  // --- Conference deadlines -------------------------------------------------

  const DEADLINE_KIND_LABELS = { abstract: '摘要截止', paper: '论文截止', rebuttal: 'Rebuttal', decision: '录用通知' };
  const WINDOW_LABELS = { 30: '未来 30 天', 90: '未来 90 天', 180: '未来 180 天', 365: '未来 365 天', open: '全部未截止', tbd: '待定或无法解析', past: '已截止' };
  const TIME_STATUS_LABELS = { unknown_timezone: '时区无法解析', invalid_time: '时间无法解析' };

  const kindLabel = row => DEADLINE_KIND_LABELS[row.kind] || row.kind || '未标注环节';

  /** Only a resolvable UTC instant gets a countdown; anything else says why. */
  function deadlineCountdown(row) {
    if (row.tbd) return '日期待定';
    if (!row.utc) return TIME_STATUS_LABELS[row.time_status] || '缺少可用时间';
    return countdown(row.utc);
  }

  function deadlineChips(row) {
    return `<span class="chip tiny conf-area">${esc(row.area || '未分类')}</span>` +
      (row.ccf ? `<span class="chip tiny ccf-${esc(String(row.ccf).toLowerCase())}">CCF ${esc(row.ccf)}</span>` : '') +
      (row.core ? `<span class="chip tiny">CORE ${esc(row.core)}</span>` : '');
  }

  function renderConferenceStatus() {
    const state = data.state, payload = state.conferences;
    const available = payload && ['ok', 'stale'].includes(payload.status);
    const counts = payload?.counts || {};
    const changes = payload?.changes;
    const lines = [available
      ? `${payload.source?.name || 'CCF-Deadlines'} 快照 · ${fmt(counts.conferences)} 个会议 · ${fmt(counts.events)} 个时间节点（论文 ${fmt(counts.paper_events)}）· 源数据更新于 ${timestamp(payload.source_updated_at)} UTC`
      : '会议数据暂不可用，其他看板不受影响。'];
    if (changes?.status === 'compared') {
      lines.push(`较上次采集 新增 ${fmt(changes.added)} · 更新 ${fmt(changes.updated)} · 移除 ${fmt(changes.removed)}` +
        `（对比 ${changes.previous_captured_at ? `${timestamp(changes.previous_captured_at)} UTC` : '—'}）`);
    } else if (changes?.status === 'initial') lines.push('首次采集，后续每日快照开始对比变化');
    if (payload?.status === 'stale' || payload?.error) lines.push(`后台采集失败，保留上次快照${payload.error ? `：${payload.error}` : ''}`);
    if (state.conferenceRefreshError) lines.push(`快照读取失败，保留上次数据：${state.conferenceRefreshError}`);
    if (available && (payload.warnings || []).length) lines.push(`${fmt(payload.warnings.length)} 条源记录有异常，已按原始标注保留`);
    $('conferenceStatus').textContent = lines.join(' · ');
    $('conferenceStatus').title = [payload?.error, state.conferenceRefreshError].filter(Boolean).join('\n');
    $('conferenceStatus').classList.toggle('neg', !available || lines.length > 1);
    const age = snapshotFreshness(payload?.captured_at);
    $('conferenceFreshness').textContent = `${available ? `快照采集于 ${timestamp(payload.captured_at)} UTC · ` : ''}${age.text}` +
      `${state.conferenceSnapshotCheckedAt ? ` · 最近读取 ${timestamp(state.conferenceSnapshotCheckedAt)} UTC（读取不触发采集）` : ''}`;
    $('conferenceFreshness').classList.toggle('neg', age.overdue && Boolean(available));
    $('conferenceExport').disabled = !available;
    $('conferenceIcs').disabled = !available;
    $('conferenceFilterReset').disabled = state.conferenceArea === 'all' && state.conferenceRank === 'all' &&
      state.conferenceKind === 'paper' && state.conferenceWindow === '90' && !state.conferenceSearch;
  }

  function renderConferenceSummary() {
    const stats = data.conferenceStats();
    const next = stats.next;
    $('conferenceCountBadge').textContent = fmt(stats.events);
    $('statConferenceEvents').textContent = fmt(stats.events);
    $('statConferenceEventsSub').textContent = `${fmt(stats.tbd)} 个节点尚未公布日期 · 来自每日快照`;
    $('statPaper30').textContent = fmt(stats.paper30);
    $('statPaper30Sub').textContent = stats.paper30 ? `未来 90 天共 ${fmt(stats.paper90)} 个论文截止` : '未来 30 天暂无论文截止';
    $('statPaper90').textContent = fmt(stats.paper90);
    const value = $('statNextDeadline');
    value.textContent = next ? countdown(next.utc) : '—';
    value.className = 'kpi-value ' + (next ? deadlineTone(next.utc) : '');
    $('statNextDeadlineSub').textContent = next
      ? [`${next.title}${next.year ? ` ${next.year}` : ''}`, kindLabel(next), `${timestamp(next.utc)} UTC`].join(' · ')
      : '快照中没有未到期的时间节点';
    $('statNextDeadline').title = next ? `${next.key} · ${next.edition}` : '';
  }

  function renderConferenceUpcoming() {
    const rows = data.conferenceRows().slice(0, 6);
    $('conferenceUpcomingNote').textContent = `${WINDOW_LABELS[data.state.conferenceWindow] || '当前筛选'} · 按剩余时间排序`;
    if (!rows.length) {
      $('conferenceUpcoming').innerHTML = '<div class="chart-empty">当前筛选没有匹配的时间节点。放宽窗口、换领域，或先清空搜索。</div>';
      return;
    }
    $('conferenceUpcoming').innerHTML = rows.map(row => {
      const tone = row.tbd || !row.utc ? 'unknown' : deadlineTone(row.utc);
      const label = `${row.title}${row.year ? ` ${row.year}` : ''}`;
      return `<div class="conf-item ${tone}">` +
        `<div class="conf-when"><strong>${esc(deadlineCountdown(row))}</strong>` +
        `<small>${row.utc ? `${esc(timestamp(row.utc))} UTC` : esc(row.source_local || '源数据未给出时间')}</small></div>` +
        `<div class="conf-body"><div class="conf-name">` +
        (row.url ? `<a href="${esc(row.url)}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>` : `<span>${esc(label)}</span>`) +
        deadlineChips(row) + `</div>` +
        `<div class="conf-meta">${esc(kindLabel(row))}${row.round > 1 ? ` · 第 ${esc(row.round)} 轮` : ''}` +
        `${row.comment ? ` · ${esc(row.comment)}` : ''} · ${esc(row.timezone || '时区未标注')}` +
        `${row.offset_minutes !== null ? ` (${esc(offsetLabel(row.offset_minutes))})` : ''}</div>` +
        `<div class="conf-meta conf-place">${esc([row.date, row.place].filter(Boolean).join(' · ') || '会议日期与地点待定')}</div>` +
        `</div></div>`;
    }).join('');
  }

  function renderConferenceTable() {
    const state = data.state;
    const rows = data.conferenceRows();
    const pages = data.conferencePageCount();
    state.conferencePage = Math.min(Math.max(1, state.conferencePage), pages);
    $('conferenceTableCount').textContent =
      `${fmt(rows.length)} / ${fmt(data.conferenceEvents().length)} 个节点 · ${WINDOW_LABELS[state.conferenceWindow] || ''}`;
    const offset = (state.conferencePage - 1) * 20;
    $('conferenceRows').innerHTML = rows.length ? rows.slice(offset, offset + 20).map(row => {
      const tone = row.tbd || !row.utc ? 'unknown' : deadlineTone(row.utc);
      return `<tr class="conf-row ${tone}">` +
        `<td>${row.url ? `<a class="model-link" href="${esc(row.url)}" target="_blank" rel="noopener noreferrer">${esc(row.title)} ↗</a>` : `<span class="model-title">${esc(row.title)}</span>`}` +
        `<div class="micro muted">${esc(row.key)} · ${esc(row.edition)}</div></td>` +
        `<td>${deadlineChips(row)}</td>` +
        `<td>${esc(kindLabel(row))}${row.round > 1 ? ` · 第 ${esc(row.round)} 轮` : ''}` +
        `${row.comment ? `<div class="micro muted">${esc(row.comment)}</div>` : ''}</td>` +
        `<td class="align-right conf-utc">${row.utc ? `${esc(timestamp(row.utc))}<div class="micro muted">${esc(offsetLabel(row.offset_minutes))}</div>` : '<span class="muted">—</span>'}</td>` +
        `<td>${esc(row.source_local || '—')}<div class="micro muted">${esc(row.timezone || '时区未标注')}` +
        `${TIME_STATUS_LABELS[row.time_status] ? ` · ${esc(TIME_STATUS_LABELS[row.time_status])}` : ''}</div></td>` +
        `<td class="align-right conf-left">${esc(deadlineCountdown(row))}</td>` +
        `<td class="micro">${esc([row.date, row.place].filter(Boolean).join(' · ') || '待定')}</td></tr>`;
    }).join('') : '<tr><td colspan="7" class="no-rows">当前筛选没有匹配的时间节点</td></tr>';
    $('conferencePageInfo').textContent = `${state.conferencePage} / ${pages}`;
    $('conferencePrev').disabled = state.conferencePage === 1;
    $('conferenceNext').disabled = state.conferencePage === pages;
    $('conferencePagination').hidden = rows.length <= 20;
  }

  function renderConferences() {
    const state = data.state;
    const select = $('conferenceArea');

    // Only rebuild the area list when the snapshot changes, so the open
    // dropdown is not thrown away on every re-render.
    const areas = data.conferenceAreas();
    const signature = ['all', ...areas].join('|');
    if (select.dataset.signature !== signature) {
      select.dataset.signature = signature;
      select.innerHTML = '<option value="all">全部领域</option>' +
        areas.map(area => `<option value="${esc(area)}">${esc(area)}</option>`).join('');
      if (!areas.includes(state.conferenceArea)) state.conferenceArea = 'all';
    }
    select.value = state.conferenceArea;
    $('conferenceRank').value = state.conferenceRank;
    $('conferenceKind').value = state.conferenceKind;
    $('conferenceWindow').value = state.conferenceWindow;
    $('conferenceSearch').value = state.conferenceSearch;
    renderConferenceStatus();
    renderConferenceSummary();
    renderConferenceUpcoming();
    renderConferenceTable();
  }

  // --- Starred repositories -------------------------------------------------

  const STAR_TYPE_LABELS = { language: '语言', topic: '主题', owner: '账户' };
  const STAR_STATUS_LABELS = { archived: '归档', fork: 'fork', org: '组织', undocumented: '无描述' };

  function starClusterLabel(id) {
    const cluster = (data.state.stars?.clusters || []).find(item => item.id === id);
    return cluster?.label || String(id).split(':')[1] || id;
  }

  function renderStarStatus() {
    const state = data.state, snapshot = state.stars || {}, stats = data.starStats();
    const changes = snapshot.changes;
    const lines = [stats.available
      ? `GitHub 公开 star 快照 · ${fmt(stats.total)} 个仓库 · ${fmt(stats.pages)} 页 · 采集于 ${timestamp(snapshot.captured_at)} UTC`
      : 'star 数据暂不可用，其他看板不受影响。'];
    if (changes?.status === 'initial') lines.push('首次采集，后续每日快照开始对比 star 列表变化');
    else if (changes?.status === 'compared') lines.push(`较上次采集 新增 ${fmt(changes.added_count)} · 取消 ${fmt(changes.removed_count)}` +
      (changes.truncated ? '（变化清单已截断，计数为完整值）' : ''));
    if (snapshot.status === 'stale' || snapshot.error) lines.push(`后台采集失败，保留上次快照${snapshot.error ? `：${snapshot.error}` : ''}`);
    if (state.starRefreshError) lines.push(`快照读取失败，保留上次数据：${state.starRefreshError}`);
    if (stats.expected !== null && stats.expected !== stats.total) {
      lines.push(`列表分页报告 ${fmt(stats.expected)} 个 star，实际解析 ${fmt(stats.total)} 个`);
    }
    if ((snapshot.warnings || []).length) lines.push(`${fmt(snapshot.warnings.length)} 条记录字段异常，已按可用部分保留`);
    $('starStatus').textContent = lines.join(' · ');
    $('starStatus').title = [snapshot.error, state.starRefreshError].filter(Boolean).join('\n');
    $('starStatus').classList.toggle('neg', !stats.available || lines.length > 1);
    const age = snapshotFreshness(snapshot.captured_at);
    $('starFreshness').textContent = `${stats.available ? `快照采集于 ${timestamp(snapshot.captured_at)} UTC · ` : ''}${age.text}` +
      `${state.starSnapshotCheckedAt ? ` · 最近读取 ${timestamp(state.starSnapshotCheckedAt)} UTC（读取不触发采集）` : ''}`;
    $('starFreshness').classList.toggle('neg', age.overdue && stats.available);
    const detailStatus = state.starDetailStatus;
    $('starDetailNote').textContent = (detailStatus === 'ready'
      ? `${fmt(data.starRows().length)} 个仓库明细已加载 · 明细采集于 ${timestamp(state.starDetailLoadedAt)} UTC · 仅在进入本节视口时读取，首屏不下载`
      : detailStatus === 'loading' ? '正在读取 star 明细…'
        : detailStatus === 'error' ? `${state.starDetailError}；指标与图谱仍来自快照。`
          : 'star 明细尚未加载：滚动到本节会自动读取，也可以手动加载。') +
      `${detailStatus === 'ready' ? ` · 墙、清单与 CSV 来自明细，KPI 与关系图来自 ${fmt(stats.clusters)} 个聚类节点的快照` : ''}`;
    $('starDetailNote').classList.toggle('neg', detailStatus === 'error');
    $('starSnapshotCheckedAt').textContent = `${state.starSnapshotCheckedAt
      ? `最近成功读取快照 ${timestamp(state.starSnapshotCheckedAt)} UTC` : '尚未成功读取快照'} · 采集由每日工作流完成`;
    $('starExport').disabled = detailStatus !== 'ready';
    $('starDetailLoad').disabled = detailStatus === 'loading';
    $('starDetailLoad').textContent = detailStatus === 'ready' ? '重新加载 star 明细'
      : detailStatus === 'error' ? '重试加载 star 明细'
        : detailStatus === 'loading' ? '读取 star 明细…' : '加载 star 明细';
    $('starFilterReset').disabled = !state.starSearch && state.starCluster === 'all' && state.starLanguage === 'all' &&
      state.starTopic === 'all' && state.starStatus === 'all';
  }

  function renderStarSummary() {
    const stats = data.starStats();
    $('starCountBadge').textContent = fmt(stats.total);
    $('statStars').textContent = countCN(stats.total);
    $('statStars').title = fmt(stats.total);
    $('statStarsSub').textContent = `${fmt(stats.languages)} 种语言 · ${fmt(stats.topics)} 个主题 · ${fmt(stats.owners)} 个所有者`;
    $('statStarActive').textContent = stats.activeShare === null ? '—' : `${(stats.activeShare * 100).toFixed(1)}%`;
    $('statStarActiveSub').textContent = `90 天内有推送 ${fmt(stats.active)} / ${fmt(stats.total)} 个仓库`;
    $('statStarClusters').textContent = fmt(stats.clusters);
    $('statStarClustersSub').textContent = stats.publishedClusters > stats.clusters
      ? `${fmt(stats.publishedClusters)} 个快照节点，仅 ${fmt(stats.clusters)} 个分到仓库`
      : `${fmt(stats.clusters)} 个聚类均有仓库归属 · ${fmt(stats.edges)} 条共现关系`;
    $('statStarSpecial').textContent = fmt(stats.archived + stats.forks);
    $('statStarSpecialSub').textContent = `归档 ${fmt(stats.archived)} · fork ${fmt(stats.forks)} · 无描述 ${fmt(stats.undocumented)} · 组织所有 ${fmt(stats.orgOwned)}`;
  }

  function renderStarWall() {
    const state = data.state;
    const model = state.starDetailStatus === 'ready' ? data.starWall() : null;
    charts.starWall($('starWall'), model || { cells: [], groups: [], total: 0 }, {
      emptyText: state.starDetailStatus === 'loading' ? '正在读取 star 明细…'
        : state.starDetailStatus === 'error'
          ? `${state.starDetailError || 'star 明细读取失败'}，可点击「重试加载 star 明细」。`
          : 'star 明细尚未加载；滚动到本节会自动读取，也可以手动加载。',
      label: `star 星星墙：${fmt(model?.total || 0)} 个仓库，一格一个`,
      activeCluster: state.starCluster
    });
    $('starWallLegend').innerHTML = model?.groups.length
      ? model.groups.map((group, index) =>
        `<button type="button" class="star-legend-item${state.starCluster === group.id ? ' active' : ''}" ` +
        `data-cluster="${esc(group.id)}" title="${esc(STAR_TYPE_LABELS[group.type] || group.type)} · 出现 ${fmt(group.appears)} 次">` +
        `<span class="star-legend-chip" style="--star-chip:${charts.starColor(index, model.groups.length)}"></span>` +
        `<span class="star-legend-name">${esc(group.label)}</span><b>${fmt(group.count)}</b></button>`).join('')
      : '';
    $('starWallNote').textContent = model
      ? `${fmt(model.total)} 格 · 一格一仓库 · ${fmt(model.groups.length)} 种颜色对应 ${fmt(model.groups.length)} 个聚类 · 格子大小随 star 数增长 · 悬停查看仓库，点击格子或图例按聚类筛选`
      : '加载明细后，这里会显示全部 star 仓库的方块墙。';
    $('starWallReadout').textContent = '悬停任意格子查看仓库名、语言与 star 数。';
  }

  function renderStarGraph() {
    const graph = data.starGraph();
    charts.starGraph($('starGraph'), graph, { emptyText: '快照中没有可绘制的聚类节点；等待后台成功采集一次 star 列表。' });
    $('starGraphNote').textContent = graph.nodes.length
      ? `内环＝语言，中环＝主题，外环＝账户 · ${fmt(graph.nodes.length)} 个节点、${fmt(graph.edges.length)} 条关系` +
        `${graph.hidden > 0 ? ` · ${fmt(graph.hidden)} 个较小聚类未绘出（受每环节点预算限制）` : ''}` +
        `${graph.missing > 0 ? ` · ${fmt(graph.missing)} 条关系因另一端未入选而省略` : ''} · 连线粗细与亮度＝共同 star 的仓库数`
      : '关系节点来自每日快照，不随明细加载变化。';
  }

  function renderStarTable() {
    const state = data.state;
    const rows = data.starFiltered();
    const pages = data.starPageCount();
    state.starPage = Math.min(Math.max(1, state.starPage), pages);
    const offset = (state.starPage - 1) * 24;
    $('starTableCount').textContent = state.starDetailStatus === 'ready'
      ? `${fmt(rows.length)} / ${fmt(data.starRows().length)} 个仓库`
      : '等待 star 明细';
    $('starRows').innerHTML = rows.length ? rows.slice(offset, offset + 24).map(row => {
      const flags = [row.archived && 'archived', row.fork && 'fork', row.org && 'org', !row.description && 'undocumented']
        .filter(Boolean);
      return `<tr class="star-row${row.archived ? ' dim' : ''}">` +
        `<td><a class="model-link" href="${esc(row.url)}" target="_blank" rel="noopener noreferrer">${esc(row.name)} ↗</a>` +
        `<div class="micro muted star-desc">${esc(row.description || '该仓库没有公开描述')}</div></td>` +
        `<td><button type="button" class="chip tiny star-cluster-chip" data-cluster="${esc(row.cluster)}" ` +
        `title="按该聚类筛选">${esc(STAR_TYPE_LABELS[data.starClusterType(row.cluster)] || '聚类')} · ${esc(starClusterLabel(row.cluster))}</button></td>` +
        `<td>${esc(row.language || '—')}</td>` +
        `<td>${row.topics.length ? row.topics.slice(0, 3).map(topic =>
          `<span class="chip tiny" data-star-topic="${esc(topic)}">${esc(topic)}</span>`).join('') +
          (row.topics.length > 3 ? `<span class="micro muted"> +${fmt(row.topics.length - 3)}</span>` : '') : '<span class="muted">—</span>'}</td>` +
        `<td class="align-right">${row.stars === null ? '—' : fmt(row.stars)}</td>` +
        `<td class="align-right">${esc(row.pushed || '—')}</td>` +
        `<td class="micro">${flags.length ? flags.map(flag =>
          `<span class="chip tiny star-flag-${flag}">${esc(STAR_STATUS_LABELS[flag])}</span>`).join('') : '<span class="muted">正常</span>'}</td></tr>`;
    }).join('') : `<tr><td colspan="7" class="no-rows">${state.starDetailStatus === 'ready'
      ? '当前筛选没有匹配的仓库' : 'star 明细尚未加载'}</td></tr>`;
    $('starPageInfo').textContent = `${state.starPage} / ${pages}`;
    $('starPrev').disabled = state.starPage === 1;
    $('starNext').disabled = state.starPage === pages;
    $('starPagination').hidden = rows.length <= 24;
  }

  /** Rebuild a select only when its option list changes; keep state in sync. */
  function fillSelect(id, options, key, allLabel) {
    const select = $(id);
    const signature = [allLabel, ...options.map(item => item.value)].join('|');
    if (select.dataset.signature !== signature) {
      select.dataset.signature = signature;
      select.innerHTML = `<option value="all">${esc(allLabel)}</option>` +
        options.map(item => `<option value="${esc(item.value)}">${esc(item.label)}</option>`).join('');
    }
    const current = data.state[key];
    // A new snapshot can drop the selected facet; the filter must follow the
    // options that are actually on screen.
    data.state[key] = current === 'all' || options.some(item => item.value === current) ? current : 'all';
    select.value = data.state[key];
  }

  /**
   * Cluster options come from the snapshot while the detail is still lazy; once
   * the wall is on screen they follow its groups, so clicking a wall cell always
   * lands on an option that exists even if the snapshot beside it is older.
   */
  function starClusterOptions() {
    const published = new Map(data.starClusters().map(cluster => [cluster.id, cluster]));
    const source = data.state.starDetailStatus === 'ready'
      ? data.starWall().groups.map(group => ({ id: group.id, label: group.label, type: group.type,
        count: published.get(group.id)?.repos ?? group.count }))
      : data.starClusters().map(cluster => ({ id: cluster.id, label: cluster.label,
        type: cluster.type, count: cluster.repos }));
    return source.map(cluster => ({
      value: cluster.id,
      label: `${STAR_TYPE_LABELS[cluster.type] || cluster.type} · ${cluster.label} (${fmt(cluster.count)})`
    }));
  }

  function renderStars() {
    const state = data.state;
    const facets = data.starFacets();
    fillSelect('starCluster', starClusterOptions(), 'starCluster', '全部聚类');
    fillSelect('starLanguage', facets.languages.map(item => ({
      value: item.label, label: `${item.label} (${fmt(item.count)})`
    })), 'starLanguage', '全部语言');
    fillSelect('starTopic', facets.topics.map(item => ({
      value: item.label, label: `${item.label} (${fmt(item.count)})`
    })), 'starTopic', '全部主题');
    $('starSort').value = state.starSort;
    $('starStatusFilter').value = state.starStatus;
    $('starSearch').value = state.starSearch;
    renderStarStatus();
    renderStarSummary();
    renderStarWall();
    renderStarGraph();
    renderStarTable();
  }

  // --- Entity registry ------------------------------------------------------

  const ENTITY_STATE_LABELS = { resolved: '已核对', unresolved: '断链', unchecked: '未核对', out_of_scope: '范围外' };
  const ENTITY_STATE_EXPLAINED = {
    unresolved: '来源当天回答了我们，但清单里没有这个 ID：条目要改，或对象已下架',
    unchecked: '对应来源本次没有可用快照，链接未被核对，不作为断链处理',
    out_of_scope: '他人的仓库，不属于本站核对范围',
    resolved: '在本次每日快照中找到'
  };
  const ENTITY_KIND_LABELS = { project: '项目', model: '模型', dataset: '数据集', paper: '论文' };
  const ENTITY_STAGE_LABELS = { proposal: '提案', training: '训练中', evaluating: '评测中',
    submitting: '投稿中', shipped: '已交付', archived: '归档' };
  const ENTITY_DOMAIN_LABELS = { hf_model: 'HF 模型', hf_dataset: 'HF 数据集', hf_collection: 'HF 集合',
    hf_space: 'HF Space', ms_model: 'ModelScope 模型', gh_repo: 'GitHub 仓库', scholar: '学术档案',
    conf: '顶会目录', template: '模版库' };

  const entityDomainLabel = domain => ENTITY_DOMAIN_LABELS[domain] || domain;
  const entityValueLabel = (labels, value, empty) => value ? (labels[value] || value) : empty;
  /** Facets publish an unlabeled entry as `none`, so its option needs its own text. */
  const entityFacetLabel = (labels, value, empty) =>
    value === 'none' ? empty : (labels[value] || value);

  /** A link is both a claim and a filter: clicking it asks who else references it. */
  function entityLinkChip(link, index, total) {
    const label = link.id.length > 46 ? `${link.id.slice(0, 44)}…` : link.id;
    return `<button type="button" class="chip tiny entity-link entity-${esc(link.state)}` +
      `${link.state === 'resolved' ? '' : ' entity-flag'}" data-entity-object="${esc(link.key)}" ` +
      `title="${esc(entityDomainLabel(link.domain))} · ${esc(ENTITY_STATE_LABELS[link.state] || link.state)}：` +
      `${esc(ENTITY_STATE_EXPLAINED[link.state] || '')}｜点击查看引用该对象的其他实体">` +
      `${esc(entityDomainLabel(link.domain))} · ${esc(label)}</button>` +
      (link.url ? `<a class="ext-link" href="${esc(link.url)}" target="_blank" rel="noopener noreferrer" ` +
        `title="在来源打开 ${esc(link.id)}" aria-label="打开 ${esc(link.id)}">↗</a>` : '') +
      (index === 2 && total > 3 ? `<span class="micro muted entity-more">+${fmt(total - 3)}</span>` : '');
  }

  function renderEntityStatus() {
    const state = data.state, payload = state.entities || {}, stats = data.entityStats();
    const changes = payload.changes || {};
    const lines = [stats.available
      ? `注册表快照 · ${fmt(stats.total)} 个实体 · ${fmt(stats.links)} 条关联 · ${fmt(stats.objects)} 个被引用对象 · 采集于 ${timestamp(payload.captured_at)} UTC`
      : '注册表数据暂不可用，其他看板不受影响。'];
    if (changes.status === 'initial') lines.push('首次发布注册表索引，后续每日快照开始对比条目增删与修订');
    else if (changes.status === 'compared') lines.push(`较上次采集 新增 ${fmt(changes.added_count)} · 删除 ${fmt(changes.removed_count)} · 修订 ${fmt(changes.revised_count)}` +
      (changes.truncated ? '（变化清单已截断，计数为完整值）' : ''));
    if (payload.status === 'stale' || payload.error) lines.push(`后台索引失败，保留上次快照${payload.error ? `：${payload.error}` : ''}`);
    if (state.entityRefreshError) lines.push(`快照读取失败，保留上次数据：${state.entityRefreshError}`);
    // The author-facing report stays on the board: a field the collector could
    // not read is published as 未标注, and the reader deserves to know.
    if (stats.errors) lines.push(`${fmt(stats.errors)} 条结构错误按未标注处理（CI --check 会失败）`);
    if (stats.warnings) lines.push(`${fmt(stats.warnings)} 条字段告警，已按可用部分保留`);
    $('entityStatus').textContent = lines.join(' · ');
    $('entityStatus').title = [payload.error, state.entityRefreshError].filter(Boolean).join('\n');
    $('entityStatus').classList.toggle('neg', !stats.available || lines.length > 1);
    const age = snapshotFreshness(payload.captured_at);
    $('entityFreshness').textContent = `${stats.available ? `快照采集于 ${timestamp(payload.captured_at)} UTC · ` : ''}${age.text}` +
      `${state.entitySnapshotCheckedAt ? ` · 最近读取 ${timestamp(state.entitySnapshotCheckedAt)} UTC（读取不触发采集）` : ''}`;
    $('entityFreshness').classList.toggle('neg', age.overdue && stats.available);
    $('entitySnapshotCheckedAt').textContent = `${state.entitySnapshotCheckedAt
      ? `最近成功读取快照 ${timestamp(state.entitySnapshotCheckedAt)} UTC` : '尚未成功读取快照'} · 采集由每日工作流完成`;
    $('entityExport').disabled = !stats.available;
    $('entityFilterReset').disabled = !state.entitySearch && state.entityKind === 'all' &&
      state.entityStage === 'all' && state.entityTag === 'all' && state.entityLink === 'all' &&
      state.entityObject === 'all';
  }

  function renderEntitySummary() {
    const payload = data.state.entities || {}, stats = data.entityStats();
    const byKind = payload.summary?.by_kind || {};
    const byStage = payload.summary?.by_stage || {};
    $('entityCountBadge').textContent = fmt(stats.total);
    $('statEntities').textContent = fmt(stats.total);
    $('statEntitiesSub').textContent = Object.keys(byKind).length
      ? Object.entries(byKind).map(([kind, count]) => `${entityValueLabel(ENTITY_KIND_LABELS, kind, '未标注')} ${fmt(count)}`).join(' · ')
      : '暂无条目';
    $('statEntityLinks').textContent = fmt(stats.links);
    $('statEntityLinksSub').textContent = `已核对 ${fmt(stats.resolved)} · 断链 ${fmt(stats.unresolved)} · ` +
      `未核对 ${fmt(stats.unchecked)} · 范围外 ${fmt(stats.out_of_scope)}`;
    $('statEntityLinks').title = stats.problems ? `${fmt(stats.problems)} 条链接需要看一眼` : '全部链接核对通过';
    $('statEntityCoverage').textContent = stats.coverage.total ? `${fmt(stats.coverage.registered)} / ${fmt(stats.coverage.total)}` : '—';
    $('statEntityCoverageSub').textContent = stats.coverage.sources
      ? `${fmt(stats.coverage.sources)} 个来源当日可用 · ` +
        (stats.gaps.length ? `零登记：${stats.gaps.map(entityDomainLabel).join('、')}` : '每个来源都有条目')
      : '当日没有可比对的来源快照';
    $('statEntityActive').textContent = fmt(stats.active);
    $('statEntityActiveSub').textContent = `已交付 ${fmt(byStage.shipped || 0)} · 归档 ${fmt(byStage.archived || 0)} · ` +
      `未标注 ${fmt(byStage['未标注'] || 0)}`;
  }

  function renderEntityCoverage() {
    const rows = data.entityCoverage();
    const usable = rows.filter(row => row.available);
    $('entityCoverageNote').textContent = rows.length
      ? `${fmt(usable.length)} / ${fmt(rows.length)} 个来源当日可用 · 分母是本站自有对象 · 未登记对象合计 ${fmt(rows.reduce((sum, row) => sum + row.missingCount, 0))} 个`
      : '等待注册表数据';
    $('entityCoverageList').innerHTML = rows.length ? rows.map(row => {
      const share = row.available && row.total ? Math.min(100, (row.registered / row.total) * 100) : 0;
      const hidden = Math.max(0, row.missingCount - row.missing.length);
      return `<div class="entity-cov-row${row.available ? '' : ' off'}">` +
        `<div class="entity-cov-head"><span class="entity-domain">${esc(entityDomainLabel(row.domain))}</span>` +
        `<b>${row.available ? `${fmt(row.registered)} / ${fmt(row.total)}` : '未核对'}</b></div>` +
        `<div class="entity-cov-bar"><i style="width:${share.toFixed(1)}%"></i></div>` +
        `<div class="micro muted entity-cov-meta">` +
        (row.available
          ? `已登记 ${fmt(row.registered)} · 未登记 ${fmt(row.missingCount)} · 分母采集于 ` +
            `${row.capturedAt ? esc(timestamp(row.capturedAt)) : '时间未知'}`
          : `本来源无可用快照：${esc(row.reason || '未说明原因')}｜该域链接按未核对处理`) +
        `</div>` +
        (row.available && row.missing.length
          ? `<div class="entity-cov-missing">${row.missing.slice(0, 6).map(id =>
              `<span class="chip tiny muted-chip" title="尚未被任何实体引用">${esc(id)}</span>`).join('')}` +
            `${hidden ? `<span class="micro muted">另有 ${fmt(hidden)} 项未列出</span>` : ''}</div>`
          : '') +
        `</div>`;
    }).join('') : '<div class="chart-empty">等待注册表数据</div>';
  }

  function renderEntityProblems() {
    const stats = data.entityStats(), problems = data.entityProblems();
    const sources = data.state.entities?.sources || {};
    $('entityProblemNote').textContent = problems.length
      ? `${fmt(problems.length)} 条链接需要留意 · 断链 ${fmt(stats.unresolved)} · 未核对 ${fmt(stats.unchecked)} · 范围外 ${fmt(stats.out_of_scope)}`
      : `${fmt(stats.links)} 条关联全部在当日快照中核对通过`;
    $('entityProblems').innerHTML = problems.length ? problems.map(problem =>
      `<div class="entity-problem ${esc(problem.state)}">` +
      `<span class="chip tiny entity-state entity-${esc(problem.state)}">${esc(ENTITY_STATE_LABELS[problem.state] || problem.state)}</span>` +
      `<div class="entity-problem-body"><div class="entity-problem-link">` +
      `<span class="entity-domain">${esc(entityDomainLabel(problem.domain))}</span> <code>${esc(problem.id)}</code>` +
      `${problem.url ? `<a class="ext-link" href="${esc(problem.url)}" target="_blank" rel="noopener noreferrer">↗</a>` : ''}</div>` +
      `<div class="micro muted entity-problem-why">${esc(ENTITY_STATE_EXPLAINED[problem.state] || '')}` +
      `${problem.state === 'unchecked' && sources[problem.domain]?.reason ? `（${esc(sources[problem.domain].reason)}）` : ''}</div>` +
      `<div class="micro entity-problem-from">来自实体 <button type="button" class="button text-button" ` +
      `data-entity-open="${esc(problem.slug)}">${esc(problem.title)}</button> · 点开查看正文与全部关联` +
      `<button type="button" class="button text-button" data-entity-edit="${esc(problem.slug)}" ` +
      'title="读取该条目的远端原文，改掉这条关系">改这条关联 ⌄</button></div>' +
      `</div></div>`).join('')
      : '<div class="chart-empty">没有断链，也没有未核对链接。注册表只登记关系，指标仍在各自看板。</div>';
  }

  /** Rebuild the reverse select with one optgroup per source. */
  function fillEntityObjectSelect() {
    const select = $('entityObject'), state = data.state;
    const objects = data.entityObjects();
    const signature = objects.map(item => item.key).join('|');
    if (select.dataset.signature !== signature) {
      select.dataset.signature = signature;
      const domains = [];
      objects.forEach(item => {
        if (!domains.includes(item.domain)) domains.push(item.domain);
      });
      select.innerHTML = '<option value="all">反查：全部对象</option>' + domains.map(domain =>
        `<optgroup label="${esc(entityDomainLabel(domain))}">` +
        objects.filter(item => item.domain === domain).map(item =>
          `<option value="${esc(item.key)}">${esc(item.id)} (${fmt(item.entries.length)})</option>`).join('') +
        '</optgroup>').join('');
    }
    // A refreshed snapshot can drop the object the reader was tracing.
    state.entityObject = state.entityObject === 'all' ||
      objects.some(item => item.key === state.entityObject) ? state.entityObject : 'all';
    select.value = state.entityObject;
  }

  function renderEntityReverseNote() {
    const state = data.state;
    if (state.entityObject === 'all') {
      $('entityReverseNote').textContent = '反向链接：点条目行里的关联对象，或选择上方「反查对象」，' +
        '即可看到哪个实体引用了这个模型、数据集或仓库。';
      return;
    }
    const group = (data.entityObjects() || []).find(item => item.key === state.entityObject);
    const matches = data.entityReferences(state.entityObject);
    $('entityReverseNote').textContent = `反查 ${entityDomainLabel(group?.domain || state.entityObject.split(':')[0])} · ` +
      `${group?.id || state.entityObject}（${ENTITY_STATE_LABELS[group?.state] || group?.state || '未知状态'}）· ` +
      `引用该对象的实体 ${fmt(matches.length)} 个：${matches.map(item => item.title).join('、') || '无'}` +
      '｜表格已按该对象筛选，再选「反查：全部对象」取消。';
  }

  function entityDetailRow(entry) {
    const reason = data.state.entities?.sources || {};
    return `<tr class="entity-detail"><td colspan="7"><div class="entity-detail-grid">` +
      `<div class="entity-detail-main">` +
      `<div class="panel-overline">正文（按源文件原文展示）</div>` +
      `<pre class="entity-body">${esc(entry.body || '（该条目没有正文）')}</pre>` +
      (entry.truncated
        ? `<p class="micro muted">正文在采集中被截断：源文件共 ${fmt(entry.bytes)} 字节 / ${fmt(entry.lines)} 行，` +
          '快照只发布前一段，完整内容请打开原文。</p>'
        : `<p class="micro muted">源文件 ${fmt(entry.bytes)} 字节 / ${fmt(entry.lines)} 行 · ` +
          `正文摘要 sha256 ${esc(entry.sha || '未公开')}</p>`) +
      `</div>` +
      `<div class="entity-detail-links"><div class="panel-overline">关联对象与核对</div>` +
      (entry.links.length ? entry.links.map(link =>
        `<div class="entity-detail-item"><span class="chip tiny entity-state entity-${esc(link.state)}">` +
        `${esc(ENTITY_STATE_LABELS[link.state] || link.state)}</span><div class="entity-detail-text">` +
        `<div><span class="entity-domain">${esc(entityDomainLabel(link.domain))}</span> <code>${esc(link.id)}</code>` +
        `${link.url ? `<a class="ext-link" href="${esc(link.url)}" target="_blank" rel="noopener noreferrer">↗</a>` : ''}</div>` +
        `<div class="micro muted">${esc(ENTITY_STATE_EXPLAINED[link.state] || '')}` +
        `${link.state === 'unchecked' && reason[link.domain]?.reason ? `（${esc(reason[link.domain].reason)}）` : ''}</div>` +
        `<div class="micro">反向链接：${fmt(data.entityReferences(link.key).length)} 个实体引用该对象</div>` +
        `</div></div>`).join('') : '<p class="micro muted">该条目还没有登记任何关联对象——注册表允许空链接，只有作者知道它该连向哪里。</p>') +
      `<div class="entity-detail-actions">${entry.url
        ? `<a class="button secondary" href="${esc(entry.url)}" target="_blank" rel="noopener noreferrer">在 GitHub 编辑源文件 ↗</a>`
        : '<span class="micro muted">源文件链接不可用</span>'}` +
      `<button type="button" class="button" data-entity-edit="${esc(entry.slug)}" ` +
      `title="读取源文件原文并在页内编辑，推送前用采集器发布的 blob SHA 做基线">在页内编辑 ⌄</button>` +
      '<span class="micro muted">回写需要 GitHub Token（只留在本标签页）</span></div>' +
      `</div></div></td></tr>`;
  }

  function renderEntityTable() {
    const state = data.state;
    const total = data.entityFiltered().length;
    const pages = data.entityPageCount();
    state.entityPage = Math.min(Math.max(1, state.entityPage), pages);
    const rows = data.entityPage();
    $('entityTableCount').textContent = `${fmt(total)} / ${fmt(data.entityEntries().length)} 条` +
      `${state.entityObject !== 'all' ? ' · 反查中' : ''}`;
    $('entityRows').innerHTML = rows.length ? rows.map(entry => {
      const counts = entry.links.reduce((tally, link) => {
        tally[link.state] = (tally[link.state] || 0) + 1;
        return tally;
      }, {});
      const open = state.entityOpen === entry.slug;
      const summary = Object.entries(counts).map(([stateName, count]) =>
        `<span class="chip tiny entity-state entity-${esc(stateName)}" title="${esc(ENTITY_STATE_EXPLAINED[stateName] || '')}">` +
        `${esc(ENTITY_STATE_LABELS[stateName] || stateName)} ${fmt(count)}</span>`).join('');
      return `<tr class="entity-row${open ? ' open' : ''}">` +
        `<td>${entry.url
          ? `<a class="model-link" href="${esc(entry.url)}" target="_blank" rel="noopener noreferrer">${esc(entry.title)} ↗</a>`
          : `<span class="model-title">${esc(entry.title)}</span>`}` +
        `<div class="micro muted">${esc(entry.slug)}</div></td>` +
        `<td><span class="chip tiny entity-kind">${esc(entityValueLabel(ENTITY_KIND_LABELS, entry.kind, '未标注类型'))}</span>` +
        `<span class="chip tiny entity-stage">${esc(entityValueLabel(ENTITY_STAGE_LABELS, entry.stage, '未标注阶段'))}</span></td>` +
        `<td class="entity-links">${entry.links.length
          ? entry.links.slice(0, 3).map((link, index) => entityLinkChip(link, index, entry.links.length)).join('')
          : '<span class="muted">未登记关联</span>'}</td>` +
        `<td class="entity-tags">${entry.tags.length ? entry.tags.slice(0, 3).map(tag =>
          `<button type="button" class="chip tiny" data-entity-tag="${esc(tag)}" title="按该标签筛选">${esc(tag)}</button>`).join('') +
          (entry.tags.length > 3 ? `<span class="micro muted"> +${fmt(entry.tags.length - 3)}</span>` : '')
          : '<span class="muted">—</span>'}</td>` +
        `<td class="align-right entity-check">${counts.unresolved || counts.unchecked
          ? summary : (entry.links.length ? `<span class="chip tiny entity-state entity-resolved">已核对 ${fmt(counts.resolved || 0)}</span>` : '<span class="muted">—</span>')}</td>` +
        `<td class="align-right entity-updated">${esc(entry.updated || '—')}</td>` +
        `<td><button type="button" class="button text-button" data-entity-open="${esc(entry.slug)}" ` +
        `aria-pressed="${open}">${open ? '收起正文 ✕' : '查看正文 ⌄'}</button></td></tr>` +
        (open ? entityDetailRow(entry) : '');
    }).join('') : `<tr><td colspan="7" class="no-rows">${data.entityEntries().length
      ? '当前筛选没有匹配的实体' : '注册表还没有条目，或快照读取失败'}</td></tr>`;
    $('entityPageInfo').textContent = `${state.entityPage} / ${pages}`;
    $('entityPrev').disabled = state.entityPage === 1;
    $('entityNext').disabled = state.entityPage === pages;
    $('entityPagination').hidden = total <= data.entityPageSize();
  }

  function renderEntities() {
    const state = data.state;
    const facets = data.entityFacets();
    fillSelect('entityKind', facets.kinds.map(item => ({
      value: item.value,
      label: `${entityFacetLabel(ENTITY_KIND_LABELS, item.value, '未标注类型')} (${fmt(item.count)})`
    })), 'entityKind', '全部类型');
    fillSelect('entityStage', facets.stages.map(item => ({
      value: item.value,
      label: `${entityFacetLabel(ENTITY_STAGE_LABELS, item.value, '未标注阶段')} (${fmt(item.count)})`
    })), 'entityStage', '全部阶段');
    fillSelect('entityTag', facets.tags.map(item => ({
      value: item.value, label: `${item.label} (${fmt(item.count)})`
    })), 'entityTag', '全部标签');
    fillEntityObjectSelect();
    $('entityLink').value = state.entityLink;
    $('entitySort').value = state.entitySort;
    $('entitySearch').value = state.entitySearch;
    renderEntityStatus();
    renderEntitySummary();
    renderEntityCoverage();
    renderEntityProblems();
    renderEntityReverseNote();
    renderEntityTable();
  }

  // --- Task board -----------------------------------------------------------

  /** Coordinates into CSS: fmt() adds thousands separators, which no style can read. */
  const px = value => Math.round(Number(value) || 0);

  const TASK_REF_LABELS = {
    resolved: '已核对', unresolved: '断链', missing_index: '未核对'
  };
  const TASK_REF_EXPLAINED = {
    resolved: '当日快照里确实有这个目标。',
    unresolved: '来源当天回答了我们，却没有这个 ID。',
    missing_index: '那次采集没有可用快照，所以这里什么都没说。'
  };

  /** A card's own status: the canvas words, not the registry's stages. */
  function taskStatusLabel(status) {
    if (!status) return '未标注';
    return MO.board.laneLabel(status) || status;
  }

  function taskCountdownText(deadline) {
    if (!deadline) return '';
    if (!deadline.found) {
      return deadline.available
        ? '顶会目录里没有这个环节 ID' : '顶会快照本次不可用，未核对';
    }
    if (deadline.tbd) return '上游时间待定';
    return deadline.utc ? `距截止 ${deadline.countdown}` : '无截止时间';
  }

  function taskRefChip(kind, id, refState, source) {
    const label = TASK_REF_LABELS[refState] || TASK_REF_LABELS.missing_index;
    const explained = TASK_REF_EXPLAINED[refState] || TASK_REF_EXPLAINED.missing_index;
    const reason = !source?.available && source?.reason ? `｜${source.reason}` : '';
    return `<span class="chip tiny entity-state task-ref task-${esc(kind)} ` +
      `task-${esc(kind)}-${esc(refState || 'missing_index')}" ` +
      `title="${esc(kind === 'ddl' ? '截止时间（数字归顶会看板所有）' : '研究实体（关系归注册表所有）')}：` +
      `${esc(label)}——${esc(explained)}${esc(reason)}">` +
      `${esc(kind === 'ddl' ? '◴' : '⌗')} ${esc(id)}</span>`;
  }

  function taskCardMarkup(card, row) {
    const board = MO.board;
    const deadline = row.ddl ? data.taskDeadline(row.ddl) : null;
    const ddlText = taskCountdownText(deadline);
    const children = board.childrenOf(row.slug);
    const waiters = board.blockersOf(row.slug);
    const patch = board.patchOf(row.slug);
    const lines = [
      `<div class="task-card-top"><span class="chip tiny task-status task-${esc(row.lane)}">` +
      `${esc(taskStatusLabel(row.status))}</span>`,
      row.localOnly ? `<span class="chip tiny task-flag${row.pushed ? ' is-pushed' : ''}" title="${
        row.pushed ? '文件已写回 tasks/ 下；索引要等次日采集，所以这条卡仍显示你推送的样子'
          : '这张卡片只在这台浏览器里，推送后才会成为 tasks/ 下的文件'}">` +
        `${row.pushed ? '新建 · 已推送' : '新建 · 未推送'}</span>` : '',
      patch ? `<span class="chip tiny task-flag${row.pushed ? ' is-pushed' : ''}" title="${
        row.pushed ? '已经写回 tasks/ 下的源文件；明天采集重建索引前，这里仍显示你推送的样子'
          : `画布上的改动尚未推送：状态是 ${esc((patch.status ?? row.status) || '未标注')}`}">` +
        `${row.pushed ? '已推送 · 等索引' : '本地改动'}</span>` : '',
      `<span class="task-card-spacer"></span><span class="micro muted task-updated">${esc(row.updated || '—')}</span></div>`,
      `<div class="task-card-title" title="${esc(row.title)}">${esc(row.title)}</div>`,
      `<div class="task-card-code"><code>${esc(row.slug)}</code></div>`,
      `<div class="task-card-meta">`,
      row.parent ? `<span class="micro" title="父任务：这张卡是从它拆出来的">↳ ${esc(row.parent)}</span>` : '',
      row.depends.length ? `<span class="micro" title="依赖：等这些任务先完成">⤷ 依赖 ${fmt(row.depends.length)}</span>` : '',
      children.length ? `<span class="micro" title="已拆出的子任务">⑂ 拆出 ${fmt(children.length)}</span>` : '',
      waiters.length ? `<span class="micro" title="等待本任务的其他卡">⧗ 被等 ${fmt(waiters.length)}</span>` : '',
      row.entity ? taskRefChip('entity', row.entity, row.entityState, data.taskSource('entity')) : '',
      row.ddl ? taskRefChip('ddl', row.ddl, row.ddlState, data.taskSource('ddl')) : '',
      ddlText ? `<span class="micro task-countdown tone-${esc(deadline?.tone || 'unknown')}" ` +
        `title="倒计时取自 conferences.json，任务卡只保存这个 ID">${esc(ddlText)}</span>` : '',
      `</div>`,
      row.reason ? `<div class="task-card-reason" title="${esc(row.reason)}">⚑ ${esc(row.reason)}</div>` : '',
      `<div class="task-card-tags">${row.tags.slice(0, 2)
        .map(tag => `<span class="chip tiny" title="标签 ${esc(tag)}">${esc(tag)}</span>`).join('')}` +
      `${row.tags.length > 2 ? `<span class="micro muted">+${fmt(row.tags.length - 2)}</span>` : ''}</div>`
    ];
    return `<div class="task-card${row.dirty ? ' is-draft' : ''}${row.localOnly ? ' is-new' : ''}${
      card.stored ? ' is-placed' : ''}${data.state.taskOpen === row.slug ? ' is-open' : ''}" ` +
      `data-task-card="${esc(row.slug)}" style="left:${px(card.x)}px;top:${px(card.y)}px" ` +
      `tabindex="0" role="button" aria-label="${esc(row.title)}（${esc(taskStatusLabel(row.status))}）——` +
      `拖动换道即改状态，拖到别的卡上建立父子，右下角把手可拉依赖；` +
      '键盘：1–7 换道，l 起依赖线，d 起拆解，Enter 打开详情">' +
      `${lines.join('')}<span class="task-card-handle" data-task-link="${esc(row.slug)}" ` +
      `title="按住拖到另一张卡上，建立「这个任务等那个任务」"></span></div>`;
  }

  function renderTaskStatus() {
    const state = data.state, payload = state.tasks || {}, stats = data.taskStats();
    const drafts = MO.board.draftSummary();
    const changes = payload.changes || {};
    const lines = [stats.available
      ? `任务看板快照 · ${fmt(stats.total)} 个任务 · ${fmt(stats.edges)} 条边 · ` +
        `${fmt(stats.blocked)} 个受阻 · 采集于 ${timestamp(payload.captured_at)} UTC`
      : state.tasks
        ? '任务快照暂不可用，画布只显示这台浏览器上的草稿卡。'
        : '还没有读取任务快照：滚动到本节、点「刷新已发布快照」，或直接在画布上建卡。'];
    if (changes.status === 'initial') lines.push('首次发布任务索引，后续每日快照开始对比增删与推进');
    else if (changes.status === 'compared') {
      lines.push(`较上次采集 新增 ${fmt(changes.added_count)} · 移除 ${fmt(changes.removed_count)} · ` +
        `修订 ${fmt(changes.revised_count)} · 推进 ${fmt(changes.advanced_count)} · ` +
        `回退 ${fmt(changes.regressed_count)}`);
    }
    if (payload.status === 'stale' || payload.error) {
      lines.push(`后台索引失败，保留上次快照${payload.error ? `：${payload.error}` : ''}`);
    }
    if (state.taskRefreshError) lines.push(`快照读取失败，保留上次数据：${state.taskRefreshError}`);
    if (stats.errors) lines.push(`${fmt(stats.errors)} 条结构错误按未标注处理（CI --check 会失败）`);
    if (stats.untriaged) lines.push(`${fmt(stats.untriaged)} 个任务落在「未标注」道，需要补 status`);
    if (drafts.pending) lines.push(`${fmt(drafts.pending)} 张卡有本地改动，尚未推送`);
    if (drafts.waiting) lines.push(`${fmt(drafts.waiting)} 张已写回远端，等次日采集重建索引`);
    if (drafts.warning) lines.push(drafts.warning);
    $('taskStatus').textContent = lines.join(' · ');
    $('taskStatus').title = [payload.error, state.taskRefreshError].filter(Boolean).join('\n');
    $('taskStatus').classList.toggle('neg', !stats.available || lines.length > 1);
    const age = snapshotFreshness(payload.captured_at);
    $('taskFreshness').textContent = `${stats.available ? `快照采集于 ${timestamp(payload.captured_at)} UTC · ` : ''}${age.text}` +
      `${state.taskSnapshotCheckedAt ? ` · 最近读取 ${timestamp(state.taskSnapshotCheckedAt)} UTC（读取不触发采集）` : ''}`;
    $('taskFreshness').classList.toggle('neg', age.overdue && stats.available);
    $('taskCheckedAt').textContent = `${state.taskSnapshotCheckedAt
      ? `最近成功读取快照 ${timestamp(state.taskSnapshotCheckedAt)} UTC` : '尚未成功读取快照'} · ` +
      '采集由每日工作流完成' +
      (drafts.waiting ? ` · 已推送 ${fmt(drafts.waiting)} 张，次日索引才会反映它们` : '');
    $('taskExport').disabled = !stats.available && !drafts.total;
    $('taskFilterReset').disabled = !state.taskSearch && state.taskTag === 'all' && state.taskRef === 'all';
    $('taskDraftBadge').textContent = drafts.pending
      ? `${fmt(drafts.pending)} 张卡待推送`
      : drafts.waiting ? `${fmt(drafts.waiting)} 张已推送 · 等索引` : '无本地改动';
    $('taskDraftBadge').classList.toggle('accent', drafts.pending > 0);
    $('taskDraftBadge').title = `座标 ${fmt(drafts.positions)} 张只留在本机，不计入待推送` +
      (drafts.waiting ? ` · ${fmt(drafts.waiting)} 张已写回远端，等次日采集重建索引` : '');
  }

  function renderTaskSummary() {
    const payload = data.state.tasks || {}, stats = data.taskStats();
    const board = MO.board;
    const rows = board.rows();
    const byLane = {};
    rows.forEach(row => { byLane[row.lane] = (byLane[row.lane] || 0) + 1; });
    const graph = board.graph(rows);
    $('taskCountBadge').textContent = fmt(rows.length);
    $('statTasks').textContent = fmt(rows.length);
    $('statTasksSub').textContent = board.LANES.slice(0, 6)
      .map(lane => `${board.laneLabel(lane)} ${fmt(byLane[lane] || 0)}`).join(' · ');
    $('statTaskEdges').textContent = fmt(graph.edges.length);
    const published = data.taskGraph();
    $('statTaskEdgesSub').textContent = `索引里 ${fmt(published.edges.length)} 条 · ` +
      `画布挡下 ${fmt(graph.dropped.length)} 条 · 采集器挡下 ${fmt(published.dropped.length)} 条`;
    $('statTaskBlocked').textContent = fmt(byLane.blocked || 0);
    const blocked = rows.filter(row => row.lane === 'blocked');
    $('statTaskBlockedSub').textContent = blocked.length
      ? `被等合计 ${fmt(blocked.reduce((sum, row) => sum + board.blockersOf(row.slug).length, 0))} 条 · ` +
        (blocked.some(row => row.reason) ? '受阻原因已写在卡上' : '这些卡还没有受阻原因')
      : '没有受阻任务';
    const nearest = rows.map(row => row.ddl ? data.taskDeadline(row.ddl) : null)
      .filter(item => item?.found && Number.isFinite(item.ts))
      .sort((a, b) => a.ts - b.ts)[0];
    $('statTaskDeadline').textContent = nearest ? nearest.countdown : '—';
    $('statTaskDeadlineSub').textContent = nearest
      ? `${nearest.conference} ${nearest.edition} · ${nearest.kind}｜数字归顶会看板所有`
      : '没有任务挂 ddl 截止时间';
  }

  function renderTaskQueue() {
    const board = MO.board;
    const rows = board.rows();
    const graph = board.graph(rows);
    const published = data.taskGraph();
    const items = [
      ...graph.dropped.map(edge => ({
        kind: '画布拒绝', text: `${edge.from} -${edge.type}-> ${edge.to}`,
        note: edge.reason, tone: 'warn'
      })),
      ...published.dropped.map(edge => ({
        kind: '索引拒绝', text: `${edge.from} -${edge.type}-> ${edge.to}`,
        note: `每日采集已把这条边挡下（${edge.reason}）`, tone: 'warn'
      })),
      ...rows.filter(row => row.entityState === 'unresolved' || row.ddlState === 'unresolved').map(row => ({
        kind: '断引用', text: row.slug,
        note: [row.entityState === 'unresolved' ? `entity ${row.entity}` : '',
          row.ddlState === 'unresolved' ? `ddl ${row.ddl}` : ''].filter(Boolean).join(' · ') +
          ' 在当日快照里找不到',
        tone: 'neg'
      })),
      ...rows.filter(row => row.entityState === 'missing_index' || row.ddlState === 'missing_index').map(row => ({
        kind: '未核对', text: row.slug,
        note: '来源本次没有可用快照，这不是断链', tone: ''
      })),
      ...(data.state.tasks?.structural_errors || []).map(note => ({
        kind: '结构错误', text: note, note: '采集器按未标注处理，CI --check 会失败', tone: 'neg'
      }))
    ];
    $('taskQueueNote').textContent = items.length
      ? `${fmt(items.length)} 条需要看一眼：画布上的线只连到已存在的卡，成环与自连当场拒绝`
      : rows.length ? '父子与依赖全部可用，引用都能在当日快照里找到' : '等待任务数据';
    $('taskQueue').innerHTML = items.length ? items.slice(0, 12).map(item =>
      `<div class="entity-detail-item"><span class="chip tiny task-state-${esc(item.kind)}">${esc(item.kind)}</span>` +
      `<div class="entity-detail-text"><code>${esc(item.text)}</code>` +
      `<div class="micro muted">${esc(item.note)}</div></div></div>`).join('') +
      (items.length > 12 ? `<p class="micro muted">另有 ${fmt(items.length - 12)} 条未列出</p>` : '')
      : '<div class="chart-empty">没有待处理的边或引用</div>';
  }

  /** A lane's own box, so a filtered canvas still shows where the lanes are. */
  function taskLaneMarkup(lane) {
    return `<div class="task-lane${lane.id === MO.board.UNTRIAGED ? ' is-untriaged' : ''}" ` +
      `data-task-lane="${esc(lane.id)}" style="left:${px(lane.x)}px;width:${px(lane.w)}px">` +
      `<div class="task-lane-head">${esc(lane.label)} ` +
      `<span class="micro muted">${fmt(lane.count)}</span></div></div>`;
  }

  function taskEdgeMarkup(edge) {
    const word = edge.type === 'parent' ? '拆自' : '等待';
    return `<path class="task-edge task-edge-${esc(edge.type)}${edge.draft ? ' is-draft' : ''}" ` +
      `d="${esc(edge.d)}" fill="none" marker-end="url(#task-arrow-${esc(edge.type)})">` +
      `<title>${esc(edge.from)} ${word} ${edge.to}${edge.draft ? '（本地改动，未推送）' : ''}</title></path>` +
      `<text class="task-edge-label" x="${px(edge.midX)}" y="${px(edge.midY - 6)}" ` +
      `text-anchor="middle">${word}</text>`;
  }

  const TASK_ARROW = kind =>
    `<marker id="task-arrow-${kind}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" ` +
    `markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" ` +
    `class="task-arrow task-arrow-${kind}"></path></marker>`;

  /**
   * The layer is painted *inside* the canvas instead of being a node the page
   * handed over: the canvas writes its own innerHTML on every repaint, so a node
   * living there would be deleted by the first one and the second would crash on
   * a null. It stays the first child, absolutely positioned at the content origin,
   * so a line lands on the box the reader sees and scrolls with it.
   */
  function taskLayerMarkup(geometry, edges) {
    const size = { width: px(geometry.width), height: px(geometry.height) };
    return `<svg id="taskEdgeLayer" class="task-edge-layer" aria-hidden="true" focusable="false" ` +
      `viewBox="0 0 ${size.width} ${size.height}" width="${size.width}" height="${size.height}">` +
      `<defs>${TASK_ARROW('parent')}${TASK_ARROW('depends')}</defs>` +
      edges.lines.map(taskEdgeMarkup).join('') + '</svg>';
  }

  function renderTaskCanvas() {
    const board = MO.board;
    const rows = board.rows();
    const box = $('taskCanvas');
    if (!rows.length) {
      box.innerHTML = '<div class="chart-empty">还没有任务：点「＋ 新建卡片」在提案道落下第一张卡，' +
        '或等每日采集读到 tasks/ 目录。</div>';
      $('taskCanvasSize').textContent = '空画布';
      return;
    }
    const geometry = board.layout(rows);
    const visible = data.taskFiltered(rows);
    const slugs = new Set(visible.map(row => row.slug));
    const cards = geometry.cards.filter(card => slugs.has(card.slug));
    const edges = board.edges(rows, cards);
    box.innerHTML = taskLayerMarkup(geometry, edges) +
      geometry.lanes.map(taskLaneMarkup).join('') +
      cards.map(card => taskCardMarkup(card, rows.find(row => row.slug === card.slug))).join('');
    $('taskCanvasSize').textContent = `${fmt(cards.length)} / ${fmt(rows.length)} 张卡在同屏 · ` +
      `${fmt(edges.lines.length)} 条连线` +
      (edges.hidden ? `（${fmt(edges.hidden)} 条的另一端被筛选隐藏）` : '') +
      ` · 卡片座标只存本机`;
  }

  function taskDetailMarkup() {
    const slug = data.state.taskOpen;
    const wrap = $('taskDetail');
    if (!slug) {
      wrap.classList.add('hidden');
      wrap.innerHTML = '';
      return;
    }
    const row = MO.board.findRow(slug);
    if (!row) {
      wrap.classList.add('hidden');
      wrap.innerHTML = '';
      data.state.taskOpen = null;
      return;
    }
    wrap.classList.remove('hidden');
    wrap.innerHTML = taskDetailRow(row);
  }

  function renderTaskList() {
    const board = MO.board;
    const rows = board.rows();
    const filtered = data.taskFiltered(rows);
    const pages = Math.max(1, Math.ceil(filtered.length / data.taskPageSize()));
    data.state.taskPage = Math.min(Math.max(1, data.state.taskPage), pages);
    const start = (data.state.taskPage - 1) * data.taskPageSize();
    const page = filtered.slice(start, start + data.taskPageSize());
    $('taskTableCount').textContent = `${fmt(filtered.length)} / ${fmt(rows.length)} 个任务 · ` +
      '清单与画布共用同一份筛选';
    $('taskRows').innerHTML = page.length ? page.map(task => {
      const children = board.childrenOf(task.slug);
      const waiters = board.blockersOf(task.slug);
      const deadline = task.ddl ? data.taskDeadline(task.ddl) : null;
      return `<tr class="task-row${task.dirty ? ' is-draft' : ''}" data-task-slug="${esc(task.slug)}">` +
        `<td><div class="table-primary">${esc(task.title)}</div>` +
        `<div class="micro muted"><code>${esc(task.slug)}</code>${task.url
          ? ` · <a href="${esc(task.url)}" target="_blank" rel="noopener noreferrer">源文件 ↗</a>` : ''}</div></td>` +
        `<td><span class="chip tiny task-status task-${esc(task.lane)}">${esc(taskStatusLabel(task.status))}</span>` +
        `${task.dirty ? `<span class="chip tiny task-flag${task.pushed ? ' is-pushed' : ''}">` +
          `${task.pushed ? '已推送' : '本地'}</span>` : ''}</td>` +
        `<td class="micro">${esc(task.parent || '—')}${children.length ? ` · ⑂ ${fmt(children.length)} 张子卡` : ''}</td>` +
        `<td class="micro">${task.depends.length ? esc(task.depends.join('、')) : '—'}` +
        `${waiters.length ? `<div class="micro muted">被 ${fmt(waiters.length)} 个任务等</div>` : ''}</td>` +
        `<td class="micro">${task.entity ? esc(task.entity) : '—'}` +
        `${task.ddl ? `<div class="micro muted">${esc(task.ddl)} · ${esc(taskCountdownText(deadline))}</div>` : ''}</td>` +
        `<td class="micro">${task.tags.length ? esc(task.tags.join(' · ')) : '—'}</td>` +
        `<td class="align-right micro">${esc(task.updated || '—')}</td>` +
        `<td><button type="button" class="button text-button" data-task-open="${esc(task.slug)}">` +
        `${data.state.taskOpen === task.slug ? '收起' : '详情'}</button></td></tr>`;
    }).join('') : '<tr><td colspan="8" class="no-rows">没有符合筛选的任务</td></tr>';
    $('taskPrev').disabled = data.state.taskPage <= 1;
    $('taskNext').disabled = data.state.taskPage >= pages;
    $('taskPageInfo').textContent = `第 ${fmt(data.state.taskPage)} / ${fmt(pages)} 页`;
    $('taskPagination').hidden = filtered.length <= data.taskPageSize();
  }

  /** 状态：进行中 → 待验收 — a draft names what the index still says, not just the new value. */
  function taskDraftDiff(task, patch) {
    const copy = { status: '状态', parent: '父任务', depends: '依赖' };
    const show = (field, value) => {
      if (field === 'depends') return (value || []).length ? value.join('、') : '（无）';
      if (field === 'status') return value ? taskStatusLabel(value) : '（未标注）';
      return value || '（无）';
    };
    return Object.keys(copy).filter(field => field in patch).map(field =>
      `${copy[field]}：${show(field, task.was?.[field])} → ${show(field, patch[field])}`).join(' · ');
  }

  function taskDetailRow(task) {
    const board = MO.board;
    const entity = task.entity ? data.taskEntity(task.entity) : null;
    const deadline = task.ddl ? data.taskDeadline(task.ddl) : null;
    const children = board.childrenOf(task.slug);
    const waiters = board.blockersOf(task.slug);
    const patch = board.patchOf(task.slug);
    const source = name => data.taskSource(name);
    return `<div class="entity-detail-main"><div class="panel-overline">正文（索引里的副本）</div>` +
      `<pre class="entity-body">${esc(task.body || '（这张卡还没有正文）')}</pre>` +
      (task.localOnly
        ? `<p class="micro neg">${task.pushed
          ? `这张新卡已写回 tasks/${esc(task.slug)}.md` +
            esc(MO.board.commitLabel(MO.board.pushedOf(task.slug)?.commit)) + '，索引要等次日采集，' +
            '所以现在只有画布看得到它。'
          : '这是一张本地新建卡：还没有对应的 tasks/ 文件，推送后才会进入索引。'}</p>`
        : `<p class="micro muted">源文件 ${fmt(task.bytes ?? 0)} 字节 / ${fmt(task.lines ?? 0)} 行 · ` +
          `正文摘要 sha256 ${esc(task.sha || '未公开')} · 推送基线 ${esc(task.blobSha ? task.blobSha.slice(0, 7) : '未公开')}</p>`) +
      (patch ? `<p class="micro accent">${task.pushed ? '已推送，等次日索引：' : '本地改动：'}` +
        `${esc(taskDraftDiff(task, patch))}</p>` : '') +
      `</div><div class="entity-detail-links"><div class="panel-overline">结构与引用</div>` +
      `<div class="entity-detail-item"><div class="entity-detail-text">` +
      `<div>父任务：<code>${esc(task.parent || '无')}</code></div>` +
      `<div class="micro muted">拆出 ${fmt(children.length)} 张子卡${children.length ? `：${esc(children.join('、'))}` : ''}</div>` +
      `<div class="micro muted">被 ${fmt(waiters.length)} 张卡等待${waiters.length ? `：${esc(waiters.join('、'))}` : ''}</div>` +
      `<div class="micro muted">依赖：${task.depends.length ? esc(task.depends.join('、')) : '无'}</div>` +
      `</div></div>` +
      (task.entity ? `<div class="entity-detail-item"><span class="chip tiny entity-state task-ref-${esc(task.entityState || 'missing_index')}">` +
        `${esc(TASK_REF_LABELS[task.entityState] || '未核对')}</span><div class="entity-detail-text">` +
        `<div><span class="entity-domain">注册表</span> <code>${esc(task.entity)}</code>` +
        `${entity?.url ? `<a class="ext-link" href="${esc(entity.url)}" target="_blank" rel="noopener noreferrer">↗</a>` : ''}</div>` +
        `<div class="micro muted">${esc(TASK_REF_EXPLAINED[task.entityState] || TASK_REF_EXPLAINED.missing_index)}` +
        `${!source('entity').available ? `（${esc(source('entity').reason || '来源不可用')}）` : ''}</div>` +
        `</div></div>` : '') +
      (task.ddl ? `<div class="entity-detail-item"><span class="chip tiny entity-state task-ref-${esc(task.ddlState || 'missing_index')}">` +
        `${esc(TASK_REF_LABELS[task.ddlState] || '未核对')}</span><div class="entity-detail-text">` +
        `<div><span class="entity-domain">顶会截止</span> <code>${esc(task.ddl)}</code></div>` +
        `<div class="micro muted">${esc(deadline?.found
          ? `${deadline.conference || ''} ${deadline.edition || ''} · ${deadline.kind || ''} · UTC ${deadline.utc || '待定'}`
          : TASK_REF_EXPLAINED[task.ddlState] || TASK_REF_EXPLAINED.missing_index)}</div>` +
        (deadline?.found && deadline.utc
          ? `<div class="micro">倒计时 ${esc(deadline.countdown)}｜这个数只有一个主人：conferences.json</div>` : '') +
        `</div></div>` : '') +
      (task.reason ? `<p class="micro">⚑ 受阻原因：${esc(task.reason)}</p>` : '') +
      `<div class="entity-detail-actions">${task.url
        ? `<a class="button secondary" href="${esc(task.url)}" target="_blank" rel="noopener noreferrer">在 GitHub 打开源文件 ↗</a>`
        : `<span class="micro muted">${task.localOnly
          ? '本地新建卡还没有源文件' : '索引没有给出可以打开的源文件链接'}</span>`}</div>` +
      `<button type="button" class="button text-button" data-task-reset="${esc(task.slug)}" ` +
      `title="只丢弃这张卡在本机的语义改动；座标不动">撤销本地改动</button></div>` +
      `</div>`;
  }

  function renderTasks() {
    const state = data.state;
    const board = MO.board;
    fillSelect('taskTag', data.taskFacets().map(item => ({
      value: item.value, label: `${item.value} (${fmt(item.count)})`
    })), 'taskTag', '全部标签');
    $('taskRef').value = state.taskRef;
    $('taskSort').value = state.taskSort;
    $('taskSearch').value = state.taskSearch;
    renderTaskStatus();
    renderTaskSummary();
    renderTaskQueue();
    $('taskCanvasWrap').classList.toggle('hidden', state.taskView !== 'board');
    $('taskTableWrap').classList.toggle('hidden', state.taskView !== 'list');
    document.querySelectorAll('[data-task-view]').forEach(button => {
      const active = button.dataset.taskView === state.taskView;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    if (state.taskView === 'board') renderTaskCanvas();
    else renderTaskList();
    taskDetailMarkup();
    $('taskLanes').textContent = board.LANES
      .map(lane => `${board.laneLabel(lane)}`).join(' → ');
    // The push panel reads the same overlay the canvas just painted, so a drag and
    // its 待推送 count can never be one render apart - but the panel owns its own
    // nodes, and this is the only line between the two.
    if (MO.tasksync) MO.tasksync.renderPanel();
  }

  // --- Paper-list tracking --------------------------------------------------

  const AWESOME_KIND_LABELS = {
    'markdown-table': 'Markdown 表格', 'machine-json': '机器可读索引',
    'topic-archives': '主题月度归档', report: '一次性报告'
  };
  const AWESOME_CADENCE_LABELS = { daily: '日更', weekly: '周更', monthly: '月更', manual: '手动' };
  const AWESOME_STATE_LABELS = { ok: '已读取', stale: '沿用上次', unavailable: '未读到' };
  const AWESOME_KIND_EXPLAINED = {
    'markdown-table': '逐行读表格与条目符号，表头按每个分区自己的列名解释',
    'machine-json': '读该仓库自己发布的 JSON 索引，不碰 README',
    'topic-archives': '一个主题一个索引页，逐月归档；只数最新月份抽样到的主题',
    report: '一次性调研报告：只统计带外链的行，不声称有更新流'
  };

  const awesomeKindLabel = kind => AWESOME_KIND_LABELS[kind] || kind || '未标注形态';
  const awesomeValue = value => (value === null || value === undefined ? '—' : fmt(value));

  /** A baseline is not "zero changes", and a report has no change stream at all. */
  function awesomeDeltaText(repo) {
    const diff = repo.diff;
    if (diff.baseline) return '基线';
    if (diff.added === null || diff.removed === null) return diff.truncated ? '不可比' : '不更新';
    return `${signed(diff.added)} / ${diff.removed ? `−${fmt(diff.removed)}` : '0'}`;
  }

  /** Two numbers, two cells: the measured count and the list's own claim. */
  function awesomeNumberCell(label, value, note, toneClass) {
    return `<div class="awesome-number${toneClass ? ` ${toneClass}` : ''}">` +
      `<span class="awesome-number-label">${esc(label)}</span>` +
      `<b>${value}</b><span class="micro muted">${esc(note)}</span></div>`;
  }

  /** Field coverage: a list can be large and still say nothing about its rows. */
  function awesomeCoverageBar(repo) {
    return data.awesomeCoverage(repo).map(field =>
      `<div class="awesome-cov-row">` +
      `<span class="awesome-cov-name">${esc(field.label)}</span>` +
      `<div class="awesome-cov-bar"><i style="width:${(field.share || 0).toFixed(1)}%"></i></div>` +
      `<span class="micro">${field.count === null ? '—' : `${fmt(field.count)} · ` +
        `${field.share === null ? '—' : `${field.share}%`}`}</span></div>`).join('');
  }

  /** The one number that has another owner: this board only points at it. */
  function awesomeRepoLine(repo) {
    const metrics = data.awesomeRepoMetrics(repo.id);
    if (!metrics.observed) {
      return `<div class="micro muted awesome-foreign">仓库指标：${esc(metrics.reason)}` +
        `｜本站不代他人仓库保存 star 数</div>`;
    }
    return `<div class="micro muted awesome-foreign">仓库指标（由 GitHub 看板持有，采集于 ` +
      `${esc(timestamp(metrics.capturedAt))} UTC）：★ ${fmt(metrics.stars)} · ` +
      `fork ${fmt(metrics.forks)} · 推送 ${esc(timestamp(metrics.pushedAt))}` +
      `${metrics.archived ? ' · 已归档' : ''}${metrics.language ? ` · ${esc(metrics.language)}` : ''}` +
      `｜这里的「推送」是整仓最后一次，清单文件自己的改动时间见上方节奏</div>`;
  }

  function awesomeEntryRow(entry) {
    return `<li class="awesome-entry${entry.isNew ? ' fresh' : ''}">` +
      (entry.url
        ? `<a class="model-link" href="${esc(entry.url)}" target="_blank" rel="noopener noreferrer">` +
          `${esc(entry.title || entry.id)} ↗</a>`
        : `<span class="model-title">${esc(entry.title || entry.id)}</span>`) +
      `<span class="micro muted awesome-entry-meta">` +
      [entry.section, entry.published, entry.venue].filter(Boolean).map(esc).join(' · ') +
      `</span>${entry.isNew ? '<span class="chip tiny awesome-fresh">本次新增</span>' : ''}</li>`;
  }

  /**
   * The registry owns the relationship, this board owns the counts. The card
   * asks one question of it — "has anybody registered this repository, and under
   * what" — and links to the reverse lookup instead of copying anything over.
   */
  function awesomeRegistryLine(repoId) {
    const key = `gh_repo:${repoId}`;
    if (!data.state.entities) {
      return '<div class="awesome-topic-note"><b>实体注册表</b>：注册表索引还没载入，' +
        '载入后这里会列出登记了这份清单的实体条目</div>';
    }
    const found = data.awesomeRegistry(repoId);
    if (!found.entries.length) {
      return `<div class="awesome-topic-note"><b>实体注册表</b>：还没有条目登记这份仓库` +
        `（注册表把清单登记成可被任务卡引用的对象，条目数与节奏仍归本栏目）</div>`;
    }
    const state = ENTITY_STATE_LABELS[found.state] || found.state || '未核对';
    return `<div class="awesome-topic-note"><b>实体注册表</b>：${fmt(found.entries.length)} 条登记了这份仓库` +
      `（对象状态 ${esc(state)}）：` +
      found.entries.map(entry =>
        `<button type="button" class="chip tiny awesome-registry-chip" ` +
        `data-awesome-registry="${esc(key)}" title="到注册表反查 ${esc(key)}">${esc(entry.slug)} · ` +
        `${esc(entry.title)}</button>`).join(' ') + `</div>`;
  }

  function awesomeCardDetail(repo) {
    const files = repo.measured.files.filter(file => file.path);
    const extras = [awesomeRegistryLine(repo.id)];
    if (repo.measured.recent) {
      const recent = repo.measured.recent;
      extras.push(`<div class="awesome-topic-note"><b>条目年龄</b>（本站从已数到的 arXiv id ` +
        `与日期里分桶，只有年份的按当年 1 月计，宁老不新）：近 90 天 ${fmt(recent.within90d)} 条 · ` +
        `近一年 ${fmt(recent.within365d)} 条 · 更早 ${fmt(recent.older)} 条 · ` +
        `认不出日期 ${fmt(recent.undated)} 条</div>`);
    }
    if (repo.measured.skipped) {
      const unlinked = repo.measured.paperTableRowsWithoutLink;
      extras.push(`<div class="awesome-topic-note"><b>没成为条目的行</b>：${fmt(repo.measured.skipped)} 行 =` +
        ` 认不出标题 ${fmt(repo.measured.skippedNoTitle || 0)} + 无链接 ${fmt(repo.measured.skippedNoLink || 0)}` +
        ` + 既无链接也无会议／日期 ${fmt(repo.measured.skippedNoSignal || 0)}。` +
        `表格清单按链接列判定条目，所以导航表与榜单行在这里被排除；` +
        `报告类清单没有链接列，认得出会议或日期就算条目` +
        // Which of the two the excluded rows really were is published, and the
        // sentence has to be able to say either way: 论文表里留空 is a floor on the
        // count, 全都是别的表 is not.
        (unlinked === null ? '' : unlinked
          ? `；这些无链接的行里有 ${fmt(unlinked)} 行，所在的表头点名了链接列，自己却一个链接都没写` +
            '——清单把它们放进了论文表、把链接留空，所以这里的实测条目数是下限'
          : '；这些无链接的行没有一个落在点名了链接列的表里，去掉的是导航表与榜单，不是论文') +
        '</div>');
    }
    if (repo.topics.length) {
      const stale = repo.topics.filter(topic => topic.state !== 'ok');
      extras.push(`<div class="awesome-topic-note"><b>主题归档</b>：${fmt(repo.topics.length)} 个主题页，` +
        `${fmt(repo.measured.monthsSampled || 0)} 个（最新月 ${esc(repo.measured.newestMonth || '—')}` +
        `${repo.measured.newestMonthAgeDays !== null ? ` · 距今 ${fmt(repo.measured.newestMonthAgeDays)} 天` : ''}）` +
        `被逐行数过 · ` +
        `合计实测 ${fmt(repo.measured.entries)} 条（同一篇跨主题只数一次，重复 ${fmt(repo.measured.duplicatedRows || 0)} 次）` +
        `${stale.length ? ` · ${fmt(stale.length)} 个主题本次读不到` : ''}｜未挂进索引的主题文件不计入，` +
        `因此这里的实测小于仓库自己的归档总量</div>`);
    }
    if (repo.categories.length) {
      extras.push(`<div class="awesome-topic-note"><b>自报分类</b>（该仓库自己的 stats.json）：` +
        repo.categories.map(item =>
          `${esc(item.category)} ${fmt(item.selfReported)}（7 日新增 ${fmt(item.new7d || 0)}）`).join(' · ') +
        `</div>`);
    }
    if (repo.selfReported?.extra?.reposStars !== null && repo.selfReported?.extra?.reposStars !== undefined) {
      extras.push(`<div class="awesome-topic-note">自报代码仓库总数 ${fmt(repo.selfReported.extra.reposTotal)} 个、` +
        `合计 star ${fmt(repo.selfReported.extra.reposStars)}——那是别人仓库的 star 之和，` +
        `与本站的任何指标都不同源，只作为该清单自己的说法保留</div>`);
    }
    return `<div class="awesome-card-detail">` +
      (repo.diff.note || repo.measured.note || repo.selfReported?.note
        ? `<p class="micro awesome-caliber">${esc([repo.diff.note, repo.measured.note, repo.selfReported?.note]
            .filter(Boolean).join('　｜　'))}</p>` : '') +
      (files.length
        ? `<p class="micro muted">读取文件：${files.map(file =>
            `<code>${esc(file.path)}</code>${file.bytes !== null
              ? ` ${(file.bytes / 1024).toFixed(0)} KB` : ''}${file.rows !== null ? ` · ${fmt(file.rows)} 行` : ''}` +
              `${file.truncated ? ' · 已在单文件上限处截断' : ''}`
            ).join(' · ')}${repo.status === 'stale' ? '（上一次成功读取时的尺寸）' : ''}</p>` : '') +
      extras.join('') +
      `<p class="micro awesome-sample-note">最近条目样本：上限来自采集器预算，` +
        `是清单的一扇窗口而不是全量（实测 ${awesomeValue(repo.measured.entries)} 条中的 ` +
        `${fmt(repo.sample.length)} 条，优先展示本次新增）</p>` +
      (repo.sample.length
        ? `<ul class="awesome-entries">${repo.sample.map(awesomeEntryRow).join('')}</ul>`
        : '<p class="chart-empty">本次没有可读的条目样本</p>') +
      `</div>`;
  }

  function renderAwesomeStatus() {
    const state = data.state, payload = state.awesome || {}, stats = data.awesomeStats();
    const changes = payload.changes || {};
    const lines = [stats.available
      ? `清单快照 · ${fmt(stats.reposOk)} / ${fmt(stats.repos)} 个可读 · 实测 ${awesomeValue(stats.measured)} 条（自有）` +
        ` + ${awesomeValue(stats.upstream)} 条（上游） · 采集于 ${timestamp(payload.captured_at)} UTC`
      : state.awesome
        ? '清单跟踪数据暂不可用，其他看板不受影响。'
        : '还没有读取清单快照：滚动到本节会自动读取，或点上方「刷新已发布快照」。'];
    if (payload.status === 'partial') {
      lines.push('部分清单本次没读到新数字：读失败的沿用上次快照并标「沿用上次」，' +
        '没轮到的沿用上次并标「本次未读取」');
    } else if (payload.status === 'stale' || payload.error) {
      lines.push(`后台采集失败，保留上次快照${payload.error ? `：${payload.error}` : ''}`);
    }
    if (Array.isArray(changes.added) && changes.added.length) {
      lines.push(`本次新纳入跟踪的清单：${changes.added.join('、')}`);
    }
    if (Array.isArray(changes.removed) && changes.removed.length) {
      lines.push(`已从跟踪中移除：${changes.removed.join('、')}`);
    }
    if (state.awesomeRefreshError) lines.push(`快照读取失败，保留上次数据：${state.awesomeRefreshError}`);
    if (stats.baseline) lines.push(`${fmt(stats.baseline)} 个清单还在建立基线，明日起的新增与移出才是可信变化量`);
    if (stats.byteCapped) {
      lines.push(`${fmt(stats.byteCapped)} 个清单的文件超过单文件上限，实测条目数是下限`);
    }
    if (stats.recent90d) {
      lines.push(`自有清单里近 90 天的条目 ${fmt(stats.recent90d)} 条（按 id 与日期分桶，本站数出来的）`);
    }
    if (stats.warnings) lines.push(`${fmt(stats.warnings)} 条采集告警，列在下方「口径与告警」`);
    $('awesomeStatus').textContent = lines.join(' · ');
    $('awesomeStatus').title = [payload.error, state.awesomeRefreshError].filter(Boolean).join('\n');
    $('awesomeStatus').classList.toggle('neg', !stats.available || lines.length > 1);
    const age = snapshotFreshness(payload.captured_at);
    $('awesomeFreshness').textContent = `${stats.available ? `快照采集于 ${timestamp(payload.captured_at)} UTC · ` : ''}${age.text}` +
      `${payload.last_attempt_at && payload.last_attempt_at !== payload.captured_at
        ? ` · 最近一次尝试 ${timestamp(payload.last_attempt_at)} UTC` : ''}` +
      `${state.awesomeSnapshotCheckedAt ? ' · 页面最近读取 ' + timestamp(state.awesomeSnapshotCheckedAt) + ' UTC（读取不触发采集）' : ''}`;
    $('awesomeFreshness').classList.toggle('neg', age.overdue && stats.available);
    $('awesomeCheckedAt').textContent = `${state.awesomeSnapshotCheckedAt
      ? `最近成功读取快照 ${timestamp(state.awesomeSnapshotCheckedAt)} UTC` : '尚未成功读取快照'} · 采集由每日工作流完成`;
    if (stats.fetches) {
      $('awesomeCheckedAt').textContent += ` · 本次抓取 ${fmt(stats.fetches.files)} 个文件` +
        `${stats.fetches.max_files !== undefined ? `／上限 ${fmt(stats.fetches.max_files)}` : ''} / ` +
        `${(stats.fetches.bytes / 1024).toFixed(0)} KB` +
        `${stats.fetches.budget_hit ? '（额度已用满，没轮到的清单标「本次未读取」）' : ''}`;
    }
    if (stats.sizes) {
      const over = stats.sizes.payload_bytes > stats.sizes.payload_budget_bytes;
      $('awesomeCheckedAt').textContent += ` · 快照 ${(stats.sizes.payload_bytes / 1024).toFixed(0)} KB` +
        `／${over ? '已超' : '预算'} ${(stats.sizes.payload_budget_bytes / 1024).toFixed(0)} KB`;
      $('awesomeCheckedAt').classList.toggle('neg', over);
    }
    $('awesomeExport').disabled = !stats.available || !data.awesomeFlow().length;
    $('awesomeFilterReset').disabled = !state.awesomeSearch && state.awesomeKind === 'all' &&
      state.awesomeOwner === 'all' && state.awesomeCadence === 'all' &&
      state.awesomeAttention === 'all' && !state.awesomeFocus;
  }

  function renderAwesomeSummary() {
    const payload = data.state.awesome || {}, stats = data.awesomeStats();
    const byKind = stats.byKind || {};
    $('awesomeCountBadge').textContent = fmt(stats.reposOk);
    $('statAwesomeRepos').textContent = `${fmt(stats.reposOk)} / ${fmt(stats.repos)}`;
    $('statAwesomeReposSub').textContent = stats.reposUnavailable || stats.reposStale
      ? `沿用上次 ${fmt(stats.reposStale)} · 未读到 ${fmt(stats.reposUnavailable)}` +
        `${stats.notAttempted ? ` · 其中 ${fmt(stats.notAttempted)} 个本次没抓取` : ''}`
      : '全部清单当日可读';
    $('statAwesomeMeasured').textContent = awesomeValue(stats.measured);
    $('statAwesomeMeasuredSub').textContent = Object.keys(byKind).length
      ? Object.entries(byKind).map(([kind, count]) => `${awesomeKindLabel(kind)} ${fmt(count)}`).join(' · ')
      : '暂无实测';
    $('statAwesomeMeasured').title = '实测＝本站今天逐行数过的行；上游仓库的行数另计，不并进来';
    $('statAwesomeDelta').textContent = stats.added === null
      ? '—' : `${signed(stats.added)} / ${signed(stats.removed)}`;
    $('statAwesomeDeltaSub').textContent = `${fmt(stats.baseline)} 个清单仍在基线` +
      `${stats.notCompared ? ` · ${fmt(stats.notCompared)} 个清单增删不可比` : ''} · ` +
      `台账上限 ${fmt(stats.budget?.ledger_id_limit || 0)} 个 id／清单`;
    $('statAwesomeStalled').textContent = awesomeValue(stats.stalled);
    $('statAwesomeStalledSub').textContent = `自报与实测并列 ${fmt(stats.selfReportedRepos)} 个 · ` +
      `上游 ${fmt(stats.upstreamRepos)} 个 · 告警 ${fmt(stats.warnings)} 条`;
  }

  /** 实测 / 自报 side by side, so a badge can never become our statistic. */
  function renderAwesomeCompare() {
    const repos = data.awesomeFilteredRepos();
    const both = repos.filter(repo => repo.selfReported && repo.selfReported.entries !== null);
    const scale = Math.max(...repos.map(repo => Math.max(repo.measured.entries || 0,
      repo.selfReported?.entries || 0)), 1);
    $('awesomeCompareNote').textContent = repos.length
      ? `${fmt(repos.length)} 个清单 · ${fmt(both.length)} 个有自报数字 · 两条永远分列，不相减也不相加`
      : '等待清单数据';
    $('awesomeCompareList').innerHTML = repos.length ? repos.map(repo => {
      const measured = repo.measured.entries;
      const reported = repo.selfReported?.entries;
      return `<div class="awesome-cmp${repo.status === 'ok' ? '' : ' off'}">` +
        `<div class="awesome-cmp-head"><code>${esc(repo.id)}</code>` +
        `<span class="micro muted">${esc(awesomeKindLabel(repo.kind))}</span></div>` +
        `<div class="awesome-cmp-bar"><i class="measured" style="width:${(((measured || 0) / scale) * 100).toFixed(1)}%"></i>` +
        (reported ? `<i class="reported" style="width:${((reported / scale) * 100).toFixed(1)}%"></i>` : '') +
        `</div><div class="micro muted">实测 ${awesomeValue(measured)}` +
        `${reported ? ` · 自报 ${fmt(reported)}（${esc(repo.selfReported.file || '仓库自述')}）` : ' · 无自报数字'}` +
        `${measured !== null && reported && reported !== measured ? ' · 两边都发布，差距请自己看条子' : ''}</div>` +
        `</div>`;
    }).join('') : '<div class="chart-empty">等待清单数据</div>';
  }

  function renderAwesomeNotes() {
    const payload = data.state.awesome || {};
    const warnings = payload.warnings || [];
    const repos = data.awesomeFilteredRepos();
    const watch = repos.filter(repo => data.awesomeAttention(repo).length);
    $('awesomeNoteCount').textContent = `${fmt(warnings.length)} 条采集告警 · ${fmt(watch.length)} 个清单有待办`;
    $('awesomeNotes').innerHTML = (warnings.length || watch.length)
      ? warnings.map(note => `<div class="awesome-note warn">${esc(note)}</div>`).join('') +
        watch.map(repo => `<div class="awesome-note"><code>${esc(repo.id)}</code>：` +
          `${data.awesomeAttention(repo).map(esc).join('；')}</div>`).join('')
      : '<div class="chart-empty">没有告警：每个清单都读到了，且新增与移出已有基线可比</div>';
  }

  function renderAwesomeCards() {
    const state = data.state;
    const repos = data.awesomeFilteredRepos();
    $('awesomeCards').innerHTML = repos.length ? repos.map(repo => {
      const open = state.awesomeOpen === repo.id;
      const notes = data.awesomeAttention(repo);
      return `<article class="awesome-card${repo.upstream ? ' upstream' : ''}` +
        `${repo.status === 'ok' ? '' : ` ${repo.status}`}">` +
        `<div class="awesome-card-head"><div>` +
        `<a class="model-link" href="https://github.com/${esc(repo.id)}" target="_blank" ` +
        `rel="noopener noreferrer">${esc(repo.id)} ↗</a>` +
        `<div class="micro muted">${esc(awesomeKindLabel(repo.kind))} · ` +
        `${esc(AWESOME_KIND_EXPLAINED[repo.kind] || '逐行数过清单文件')}</div></div>` +
        `<div class="awesome-badges">` +
        `<span class="chip tiny awesome-owner">${repo.upstream ? '上游 · 他人仓库' : '自有'}</span>` +
        `<span class="chip tiny awesome-state">` +
        `${esc(repo.notAttempted ? '本次未读取' : (AWESOME_STATE_LABELS[repo.status] || repo.status))}</span>` +
        (repo.cadence.stalled ? `<span class="chip tiny awesome-flag">停更 ${fmt(repo.cadence.staleDays)} 天</span>` : '') +
        (repo.diff.baseline ? '<span class="chip tiny awesome-flag">基线</span>' : '') +
        (repo.diff.truncated ? '<span class="chip tiny awesome-flag">增删为下限</span>' : '') +
        `</div></div>` +
        `<div class="awesome-numbers">` +
        awesomeNumberCell('实测', fmt(repo.measured.entries),
          repo.notAttempted ? '本次未读取，数字是上次快照的'
            : repo.status === 'stale' ? '沿用上次快照'
            : `arXiv ${awesomeValue(repo.measured.withArxiv)} · 代码 ${awesomeValue(repo.measured.withCode)}`) +
        awesomeNumberCell('自报', awesomeValue(repo.selfReported?.entries),
          repo.selfReported ? `${repo.selfReported.file || '仓库自述'} · 不参与合计` : '该清单没有自报数字') +
        awesomeNumberCell('新增 / 移出', awesomeDeltaText(repo),
          repo.diff.baseline ? '首次读到，明日起才是变化量'
            : repo.diff.added === null ? (repo.diff.truncated
              ? '上次台账被 id 上限截断，本次不报增删' : '没有更新流：这类清单不报增删')
            : `保留 ${awesomeValue(repo.diff.held)} 条${repo.diff.rollingWindow ? ' · 滚动窗口' : ''}`) +
        awesomeNumberCell('节奏', esc(AWESOME_CADENCE_LABELS[repo.cadence.cadence] || '未知'),
          repo.cadence.lastCommitAt
            ? `${timestamp(repo.cadence.lastCommitAt)} · ${esc(repo.cadence.author || '未知作者')}` +
              `${repo.cadence.isBot ? '（机器人）' : ''}`
            : '清单文件的改动时间未知') +
        `</div>` +
        `<div class="awesome-cov">${awesomeCoverageBar(repo)}</div>` +
        awesomeRepoLine(repo) +
        (notes.length
          ? `<ul class="awesome-card-notes">${notes.map(note => `<li>${esc(note)}</li>`).join('')}</ul>` : '') +
        (repo.error ? `<p class="micro awesome-error">${esc(repo.error)}</p>` : '') +
        `<div class="awesome-card-foot"><button type="button" class="button text-button" ` +
        `data-awesome-open="${esc(repo.id)}" aria-pressed="${open}">` +
        `${open ? '收起明细 ✕' : `展开明细（样本 ${fmt(repo.sample.length)} 条）⌄`}</button>` +
        `<button type="button" class="button text-button" data-awesome-focus="${esc(repo.id)}" ` +
        `aria-pressed="${state.awesomeFocus === repo.id}" ` +
        `title="把卡片与论文流水都收敛到这一份清单">` +
        `${state.awesomeFocus === repo.id ? '取消只看' : '只看这份'}</button>` +
        `<span class="micro muted">${repo.topics.length ? `${fmt(repo.topics.length)} 个主题`
          : repo.categories.length ? `${fmt(repo.categories.length)} 个分类`
          : `${awesomeValue(repo.measured.sections)} 个分区 · ${awesomeValue(repo.measured.skipped)} 行未成条目` +
            (repo.measured.skipped ? `（无链接 ${fmt(repo.measured.skippedNoLink || 0)} 行）` : '')}</span></div>` +
        (open ? awesomeCardDetail(repo) : '') +
        `</article>`;
    }).join('') : `<div class="chart-empty">${data.awesomeRows().length
      ? '当前筛选没有匹配的清单，试试重置筛选'
      : '快照还没读到：滚动到本节会自动读取，也可以点上方「刷新已发布快照」重试'}</div>`;
  }

  function renderAwesomeFlow() {
    const state = data.state;
    const total = data.awesomeFlow().length;
    const pages = data.awesomeFlowPageCount();
    state.awesomeFlowPage = Math.min(Math.max(1, state.awesomeFlowPage), pages);
    const rows = data.awesomeFlowPage();
    $('awesomeFlowCount').textContent = `${fmt(total)} 条样本 · 第 ${state.awesomeFlowPage} / ${pages} 页` +
      `（每页 ${fmt(data.awesomeFlowPageSize())} 条，来自各清单的最近条目抽样）`;
    $('awesomeFlowRows').innerHTML = rows.length ? rows.map((entry, index) =>
      `<tr class="awesome-flow-row${entry.isNew ? ' fresh' : ''}">` +
      `<td>${entry.url
        ? `<a class="model-link" href="${esc(entry.url)}" target="_blank" rel="noopener noreferrer">` +
          `${esc(entry.title || entry.id)} ↗</a>`
        : `<span class="model-title">${esc(entry.title || entry.id)}</span>`}` +
      `${entry.isNew ? '<span class="chip tiny awesome-fresh">本次新增</span>' : ''}` +
      `<button type="button" class="button text-button" data-awesome-card="${index}" ` +
      `title="把这一条变成本机任务草稿：推送后才会成为 tasks/ 下的文件">建卡</button></td>` +
      `<td><code>${esc(entry.repoId)}</code>${entry.upstream ? '<span class="chip tiny upstream">上游</span>' : ''}` +
      `${entry.repoStatus === 'ok' ? '' : '<span class="chip tiny awesome-flag">' +
        esc(entry.repoNotAttempted ? '本次未读取' : '沿用上次') +
        (entry.repoCapturedAt ? ` · ${esc(timestamp(entry.repoCapturedAt))}` : '') + '</span>'}</td>` +
      `<td class="micro">${esc(entry.section || '—')}</td>` +
      `<td class="align-right">${esc(entry.published || '—')}</td>` +
      `<td class="align-right">${esc(entry.venue || '—')}</td>` +
      `<td class="align-right">${entry.arxivId ? `<a class="ext-link" href="https://arxiv.org/abs/${esc(entry.arxivId)}" ` +
        `target="_blank" rel="noopener noreferrer">arXiv ↗</a>` : '<span class="muted">—</span>'}</td></tr>`).join('')
      : `<tr><td colspan="6" class="no-rows">${data.awesomeRows().length
        ? '当前筛选下没有条目样本。流水只是每清单的最近条目抽样，不在这里出现不等于清单里没有'
        : '等待清单快照'}</td></tr>`;
    $('awesomeFlowPageInfo').textContent = `${state.awesomeFlowPage} / ${pages}`;
    $('awesomeFlowPrev').disabled = state.awesomeFlowPage === 1;
    $('awesomeFlowNext').disabled = state.awesomeFlowPage === pages;
    $('awesomeFlowPagination').hidden = total <= data.awesomeFlowPageSize();
  }

  function renderAwesomeTrend() {
    const state = data.state;
    const trend = data.awesomeTrend();
    const readable = state.awesomeTrendMetric === 'readable';
    $('awesomeTrendMetric').value = state.awesomeTrendMetric;
    $('awesomeTrendLabel').textContent = readable
      ? '当天真正读到的清单数：其余数字在没读到的日子是沿用的'
      : '本站每天逐行数出来的条目行，自有与上游分列，永不相加';
    charts.line($('awesomeTrendChart'), readable
      ? [{ name: '当日可读清单数', points: trend.readable, color: 'var(--chart-2)' }]
      : [{ name: '实测条目（自有）', points: trend.measured, color: 'var(--chart-1)' },
        { name: '实测条目（上游另计）', points: trend.upstream, color: 'var(--chart-4)' }], {
      area: readable,
      label: '论文清单跟踪逐日快照',
      emptyText: trend.snapshots.length
        ? '逐日历史里还没有可画的整数：可能是历史文件比快照更早，等下一次采集补齐。'
        : '还没有逐日历史。每天采集一次后开始积累，本站不补造历史数据。'
    });
    const lines = [];
    if (state.awesomeHistoryError) lines.push(`历史读取失败，趋势暂缺：${state.awesomeHistoryError}`);
    else if (!trend.snapshots.length) lines.push('还没有逐日历史文件');
    else {
      lines.push(`${fmt(trend.snapshots.length)} 个逐日快照`);
      if (trend.enough && Number.isFinite(trend.netChange)) {
        lines.push(`自 ${trend.first.date} 起实测条目净变化 ${signed(trend.netChange)}` +
          `（${fmt(trend.first.value)} → ${fmt(trend.last.value)}，只比两端，不逐日累加）`);
      } else if (trend.snapshots.length) {
        lines.push('样本太少，看不出趋势：两点连成的直线说明不了中间发生过什么，第 3 天起才有净变化' +
          (trend.readyOn ? `——按每天一次的节奏推算，${trend.readyOn} 才够 3 个点，本站不补造历史` : ''));
      }
      if (trend.partialDays) {
        lines.push(`其中 ${fmt(trend.partialDays)} 天没读全所有清单，那些天的数字是沿用的，` +
          '曲线走平可能只是没读到');
      }
      const retention = state.awesomeHistoryRetention;
      if (retention?.daily_days) {
        lines.push(`留存：最近 ${fmt(retention.daily_days)} 天逐日，更早每月留一个点` +
          `（最多 ${fmt(retention.monthly_points)} 个月）`);
      }
    }
    $('awesomeTrendNote').textContent = lines.join(' · ');
    $('awesomeTrendNote').classList.toggle('neg', Boolean(state.awesomeHistoryError));
  }

  function renderAwesome() {
    const state = data.state;
    fillSelect('awesomeKind', data.awesomeFacets().kinds.map(item => ({
      value: item.value,
      label: `${item.value === 'none' ? '未标注形态' : awesomeKindLabel(item.value)} (${fmt(item.count)})`
    })), 'awesomeKind', '全部形态');
    fillSelect('awesomeOwner', data.awesomeFacets().owners.map(item => ({
      value: item.value, label: `${item.value === 'upstream' ? '上游他人仓库' : '自有清单'} (${fmt(item.count)})`
    })), 'awesomeOwner', '全部归属');
    fillSelect('awesomeCadence', data.awesomeFacets().cadences.map(item => ({
      value: item.value, label: `${item.value === 'none' ? '节奏未知' : (AWESOME_CADENCE_LABELS[item.value] || item.value)} (${fmt(item.count)})`
    })), 'awesomeCadence', '全部节奏');
    $('awesomeAttention').value = state.awesomeAttention;
    $('awesomeSort').value = state.awesomeSort;
    $('awesomeFlowSort').value = state.awesomeFlowSort;
    $('awesomeSearch').value = state.awesomeSearch;
    document.querySelectorAll('[data-awesome-view]').forEach(button => {
      const active = button.dataset.awesomeView === state.awesomeView;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    const focus = data.awesomeFilteredRepos();
    $('awesomeFocusNote').hidden = !state.awesomeFocus;
    $('awesomeFocusNote').textContent = state.awesomeFocus
      ? `只看 ${state.awesomeFocus}（余 ${fmt(focus.length)} 份，点此取消）` : '';
    renderAwesomeStatus();
    renderAwesomeSummary();
    renderAwesomeCompare();
    renderAwesomeNotes();
    renderAwesomeTrend();
    $('awesomeCards').classList.toggle('hidden', state.awesomeView !== 'repos');
    $('awesomeFlowWrap').classList.toggle('hidden', state.awesomeView !== 'flow');
    if (state.awesomeView === 'repos') renderAwesomeCards();
    else renderAwesomeFlow();
  }

  // --- HOMC 核实总表 --------------------------------------------------------

  const HOMC_STATE_LABELS = { new: '新增', updated: '更新', unverified: '待确认' };
  const HOMC_STATE_GLYPHS = { new: '🆕', updated: '🔄', unverified: '⚠️' };
  // The same read_cadence words the list-tracking collector publishes, so one
  // vocabulary gets one set of labels rather than two that can drift apart.
  const HOMC_CADENCE_LABELS = AWESOME_CADENCE_LABELS;
  const HOMC_CLAIM_LABELS = {
    model_series: '模型系列', arxiv_papers: 'arXiv 论文', github_repos: 'GitHub 仓库',
    hf_links: 'Hugging Face 链接', vendors: '厂商 / 组织', benchmarks: '评测基准',
    increment: '本轮核实增量'
  };
  const HOMC_GRADE_EXPLAINED = {
    A: '一手来源', B: '独立二手来源', C: '单一二手或传闻'
  };

  const homcValue = value => (value === null || value === undefined ? '—' : fmt(value));
  const homcStateLabel = word => (word
    ? `${HOMC_STATE_GLYPHS[word] || ''} ${HOMC_STATE_LABELS[word] || word}`.trim() : '未归表');
  const homcGradeText = (stats, grade) => (stats.grades && Number.isFinite(stats.grades[grade])
    ? fmt(stats.grades[grade]) : '—');
  const homcKb = value => (Number.isFinite(value) ? `${(value / 1024).toFixed(0)} KB` : '—');

  /** The list's own 核心统计 rows, in the shape it wrote them: "200+" stays a range. */
  function homcClaims(claimed) {
    return Object.entries(HOMC_CLAIM_LABELS)
      .filter(([key]) => typeof (claimed || {})[`${key}_claimed`] === 'string')
      .map(([key, label]) => ({
        key, label, value: claimed[`${key}_claimed`],
        exact: Number.isFinite(claimed[key]) ? claimed[key] : null
      }));
  }

  function homcNumberCell(label, value, note, toneClass) {
    return `<div class="awesome-number${toneClass ? ` ${toneClass}` : ''}">` +
      `<span class="awesome-number-label">${esc(label)}</span>` +
      `<span class="awesome-number-value">${value}</span>` +
      `<span class="awesome-number-note micro muted">${esc(note || '')}</span></div>`;
  }

  function renderHomcStatus() {
    const state = data.state, stats = data.homcStats();
    const payload = state.homc || {};
    const age = ageInDays(stats.capturedAt);
    const lines = [];
    if (!state.homc) lines.push('正在读取模型清单快照…');
    else if (stats.status === 'unavailable') {
      lines.push(`这次没读到 HOMC 总表${stats.error ? `：${stats.error}` : ''}` +
        `${stats.unavailableReason ? `（${stats.unavailableReason}）` : ''}，页面没有可发布的内容`);
    } else if (stats.status === 'stale') {
      lines.push('今天没读到 HOMC 总表，下面是上次快照的内容并标注为「沿用上次」');
    } else {
      lines.push(`三态总表 · 实测 ${homcValue(stats.rowsTotal)} 行` +
        `（🆕 ${homcValue(stats.rowsNew)} / 🔄 ${homcValue(stats.rowsUpdated)} / ` +
        `⚠️ ${homcValue(stats.rowsUnverified)}）`);
      lines.push(stats.claimedIncrement === null
        ? '清单这次没写出核心统计表，自报数缺席'
        : `清单自报本轮核实 ${homcValue(stats.claimedIncrement)} 条`);
    }
    if (stats.asOf) {
      lines.push(`清单标注「截至 ${stats.asOf}」` +
        (stats.asOfAgeDays === null ? '' : ` · 已经 ${fmt(Math.floor(stats.asOfAgeDays))} 天`));
    }
    if (state.homcRefreshError) lines.push(`快照读取失败，保留上次数据：${state.homcRefreshError}`);
    $('homcStatus').textContent = lines.join(' · ');
    $('homcStatus').title = [stats.error, state.homcRefreshError].filter(Boolean).join('\n');
    $('homcStatus').classList.toggle('neg', stats.status !== 'ok' || lines.length > 3);
    $('homcFreshness').textContent = (stats.capturedAt
      ? `快照采集于 ${timestamp(stats.capturedAt)} UTC · ` : '') +
      (Number.isFinite(age) ? `距今 ${fmt(Math.floor(age))} 天` : '采集时间未知') +
      (stats.cadence.lastCommitAt
        ? ` · 清单文件上次改动 ${timestamp(stats.cadence.lastCommitAt)} UTC` +
          `（${esc(stats.cadence.author || '作者未知')}${stats.cadence.isBot ? ' · 机器人' : ''}）`
        : '') +
      (stats.cadence.stalled ? ` · 已停更 ${fmt(stats.cadence.staleDays)} 天` : '');
    $('homcFreshness').classList.toggle('neg', stats.cadence.stalled || stats.status === 'stale');
    $('homcCheckedAt').textContent = `${state.homcSnapshotCheckedAt
      ? `最近成功读取快照 ${timestamp(state.homcSnapshotCheckedAt)} UTC` : '尚未成功读取快照'
      } · 采集由每日工作流完成`;
    if (stats.fetches.files !== null) {
      $('homcCheckedAt').textContent += ` · 本次抓取 ${fmt(stats.fetches.files)} 个文件` +
        `，读到 ${homcKb(stats.fetches.bytes ?? 0)}`;
    }
    if (stats.sizes.payloadBytes !== null && stats.sizes.payloadBudget !== null) {
      const over = stats.sizes.payloadBytes >= stats.sizes.payloadBudget;
      $('homcCheckedAt').textContent += ` · 快照 ${homcKb(stats.sizes.payloadBytes)}` +
        `（预算 ${homcKb(stats.sizes.payloadBudget)}）`;
      $('homcCheckedAt').classList.toggle('neg', over);
    }
    $('homcExport').disabled = !stats.available || !data.homcFiltered().length;
    $('homcFilterReset').disabled = !state.homcSearch && state.homcState === 'all' &&
      state.homcGrade === 'all' && state.homcVendor === 'all' && state.homcAttention === 'all';
    // The two buttons that reach outside the board are links to their owner's
    // page; a payload without them leaves the buttons off rather than guessing.
    $('homcSiteLink').hidden = !stats.siteUrl;
    if (stats.siteUrl) $('homcSiteLink').href = stats.siteUrl;
    $('homcReadmeLink').hidden = !stats.readmeUrl;
    if (stats.readmeUrl) $('homcReadmeLink').href = stats.readmeUrl;
  }

  function renderHomcSummary() {
    const stats = data.homcStats();
    $('homcCountBadge').textContent = homcValue(stats.rowsTotal);
    $('statHomcRows').textContent = homcValue(stats.rowsTotal);
    $('statHomcRowsSub').textContent = !stats.available ? '这次没有数出行数'
      : stats.rowsParsed === null || stats.rowsParsed === stats.rowsTotal
      ? `本站逐行数过 · ${homcValue(stats.distinctVendors)} 个提供方`
      : `逐行数过，去重后 ${fmt(stats.rowsParsed)} 个名字：${stats.byteCapped
        ? '文件在抓取上限处截断，行数为下限' : '同名同提供方的行按首次计，重复的另有一行说明'}`;
    $('statHomcSplit').textContent = stats.rowsTotal === null ? '—'
      : `${homcValue(stats.rowsNew)} / ${homcValue(stats.rowsUpdated)} / ${homcValue(stats.rowsUnverified)}`;
    $('statHomcSplitSub').textContent = stats.markerMismatch
      ? `${fmt(stats.markerMismatch)} 行的行首标记与所在表不一致，按所在表归类`
      : `带说明的行 ${homcValue(stats.withNote)} 行 · 指向章节的行 ${homcValue(stats.sectionRefs)} 行`;
    $('statHomcDelta').textContent = !stats.available ? '—'
      : stats.diff.baseline ? '基线'
      : stats.diff.added === null ? '—'
      : `${signed(stats.diff.added)} / ${signed(-(stats.diff.removed ?? 0))}`;
    $('statHomcDeltaSub').textContent = !stats.available ? '本站第一次读到这张总表之前不报变化'
      : stats.diff.baseline ? `首次读到：记下 ${homcValue(stats.diff.held)} 个 id，明日起才是变化量`
      : stats.diff.added === null
        ? (stats.diff.truncated ? '上次台账被 id 上限截断，增删按下限报告' : '没有可比对的上一日台账')
        : `保留 ${homcValue(stats.diff.held)} 行${stats.diff.truncated ? ' · 增删为下限' : ''}`;
    $('statHomcSingleB').textContent = homcValue(stats.singleB);
    $('statHomcSingleBSub').textContent = `来源等级 A ${homcGradeText(stats, 'A')} · B ${homcGradeText(stats, 'B')}` +
      ` · C ${homcGradeText(stats, 'C')}${stats.withoutGrade ? ` · 无等级 ${fmt(stats.withoutGrade)} 行` : ''}`;
    $('statHomcLinkless').textContent = homcValue(stats.withoutLink);
    $('statHomcLinklessSub').textContent = `可对上花色索引 ${homcValue(stats.suitMatched)} 行` +
      ` · 对不上 ${homcValue(stats.suitUnmatched)} 行`;
  }

  function renderHomcCompare() {
    const stats = data.homcStats();
    const claims = homcClaims(stats.claimed);
    $('homcCompareNote').textContent = stats.available
      ? `三态表：本站数出来的行数，与清单在「核心统计」里自报的拆分`
      : '等待模型清单快照';
    const states = [
      { key: 'new', measured: stats.rowsNew, claimed: stats.claimed?.increment_new },
      { key: 'updated', measured: stats.rowsUpdated, claimed: stats.claimed?.increment_updated },
      { key: 'unverified', measured: stats.rowsUnverified, claimed: stats.claimed?.increment_unverified }
    ].filter(item => item.measured !== null || Number.isFinite(item.claimed));
    const scale = Math.max(1, ...states.map(item => Math.max(item.measured || 0, item.claimed || 0)));
    $('homcCompareList').innerHTML = states.length ? states.map(item => {
      const claimed = Number.isFinite(item.claimed) ? item.claimed : null;
      const gap = claimed !== null && item.measured !== null && claimed !== item.measured;
      return `<div class="awesome-cmp">` +
        `<div class="awesome-cmp-head"><code>${esc(item.key)}</code>` +
        `<span class="micro muted">${esc(homcStateLabel(item.key))}</span></div>` +
        `<div class="awesome-cmp-bar">` +
        `<i class="measured" style="width:${(((item.measured || 0) / scale) * 100).toFixed(1)}%"></i>` +
        (claimed !== null
          ? `<i class="reported" style="width:${(((claimed) / scale) * 100).toFixed(1)}%"></i>` : '') +
        `</div><div class="micro muted">实测 ${homcValue(item.measured)}` +
        `${claimed === null ? ' · 清单没有自报这一态的拆分' : ` · 自报 ${fmt(claimed)}`}` +
        `${gap ? ' · 两边都发布，差距请自己看行' : ''}</div></div>`;
    }).join('') : '<div class="chart-empty">等待模型清单快照</div>';
    $('homcClaimNote').textContent = claims.length
      ? `清单自己的「核心统计」表，原样引用：${fmt(claims.length)} 项`
      : '这次没读到他们的核心统计表';
    $('homcClaimList').innerHTML = claims.length ? claims.map(claim =>
      `<div class="homc-claim"><span class="homc-claim-label">${esc(claim.label)}</span>` +
      `<span class="homc-claim-value">${esc(claim.value)}</span>` +
      `<span class="micro muted">${claim.exact === null
        ? '区间或约数，本站不替他们取整' : `写作整数即 ${fmt(claim.exact)}`}</span></div>`).join('')
      : '<div class="chart-empty">清单这次没写出核心统计表：自报数缺席，本站只报实测</div>';
  }

  function renderHomcNotes() {
    const stats = data.homcStats();
    // A row the board may not publish is also a row it may not call 待读: the
    // count has to follow the same availability as the table below it.
    const rows = stats.available ? data.homcFiltered() : [];
    const watch = rows.filter(row => data.homcWatch(row).length);
    // The collector's own warning list belongs to the payload, so a run that
    // read nothing still says how many warnings it raised. With no payload at
    // all, "0 alerts" would be a count nobody made — and the 待读 half is a
    // claim about the sample this page publishes, so no sample reports none.
    $('homcNoteCount').textContent = stats.available
      ? `${fmt(stats.warnings.length)} 条采集告警 · ` +
        `本页样本里 ${fmt(watch.length)} 行有待读理由`
      : stats.warnings.length
        ? `${fmt(stats.warnings.length)} 条采集告警 · 这次没读到样本，待读行数无数可报`
        : '这次没读到快照：告警与待读都没有可报的数';
    const caliber = stats.caliber || {};
    const lines = [];
    if (stats.warnings.length) {
      lines.push(...stats.warnings.map(note =>
        `<div class="awesome-note warn">${esc(note)}</div>`));
    }
    Object.entries(caliber).forEach(([key, text]) => {
      if (typeof text === 'string') {
        lines.push(`<div class="awesome-note"><code>${esc(key)}</code>：${esc(text)}</div>`);
      }
    });
    if (stats.diff.baseline && stats.available) {
      lines.push('<div class="awesome-note">这次只建立基线：台账里的 id 是第一次记下的，' +
        '明天的新增与移出才是变化量，今天报 0 会是假的。</div>');
    }
    if (stats.diff.truncated) {
      lines.push('<div class="awesome-note">上次台账被 id 上限截断，本次不报新增与移出：' +
        '比对不了的就不是变化，而是下限。</div>');
    }
    if (stats.rowLimit !== null && stats.rowsTotal !== null && stats.rowsTotal > stats.rowLimit) {
      lines.push(`<div class="awesome-note">下方表格只是样本：三态轮转取前 ${fmt(stats.rowLimit)} 行，` +
        `实测 ${fmt(stats.rowsTotal)} 行的计数与台账都不因此变小。</div>`);
    }
    $('homcNotes').innerHTML = lines.length ? lines.join('')
      : `<div class="chart-empty">${stats.available
        ? '没有告警：总表读到了，行首标记与所在表也一致'
        : '这次没读到总表：读不到不等于没有告警，这里不替它宣布干净。'}</div>`;
  }

  function renderHomcTrend() {
    const state = data.state;
    const trend = data.homcTrend();
    const claimed = state.homcTrendMetric === 'claimed';
    $('homcTrendMetric').value = state.homcTrendMetric;
    $('homcTrendLabel').textContent = claimed
      ? '清单在「核心统计」里自报的本轮核实条数，不是本站数出来的行数'
      : '本站每天逐行数出来的三态总表行数';
    charts.line($('homcTrendChart'), [{
      name: claimed ? '清单自报核实增量' : '实测行数',
      points: claimed ? trend.claimed : trend.measured,
      color: claimed ? 'var(--chart-4)' : 'var(--chart-1)'
    }], {
      area: true,
      label: 'HOMC 三态总表逐日快照',
      emptyText: trend.snapshots.length
        ? '逐日历史里还没有可画的整数：可能是历史文件比快照更早，等下一次采集补齐。'
        : '还没有逐日历史。每天采集一次后开始积累，本站不补造历史数据。'
    });
    const lines = [];
    if (state.homcHistoryError) lines.push(`历史读取失败，趋势暂缺：${state.homcHistoryError}`);
    else if (!trend.snapshots.length) lines.push('还没有逐日历史文件');
    else {
      lines.push(`${fmt(trend.snapshots.length)} 个逐日快照`);
      if (trend.enough && Number.isFinite(trend.netChange)) {
        lines.push(`自 ${trend.first.date} 起实测行数净变化 ${signed(trend.netChange)}` +
          `（${fmt(trend.first.value)} → ${fmt(trend.last.value)}，只比两端，不逐日累加）`);
      } else if (trend.snapshots.length) {
        lines.push('样本太少，看不出趋势：两点连成的直线说明不了中间发生过什么，第 3 天起才有净变化' +
          (trend.readyOn ? `——按每天一次的节奏推算，${trend.readyOn} 才够 3 个点，本站不补造历史` : ''));
      }
      const gap = trend.snapshots.filter(row => !Number.isFinite(row.rowsTotal)).length;
      if (gap) {
        lines.push(`其中 ${fmt(gap)} 天没数出行数，那天的点是断开的，不是零`);
      }
      const retention = state.homcHistoryRetention;
      if (retention?.daily_days) {
        lines.push(`留存：最近 ${fmt(retention.daily_days)} 天逐日，更早每月留一个点` +
          `（最多 ${fmt(retention.monthly_points)} 个月）`);
      }
    }
    $('homcTrendNote').textContent = lines.join(' · ');
    $('homcTrendNote').classList.toggle('neg', Boolean(state.homcHistoryError));
  }

  function homcSourceCell(row) {
    const grades = row.grades.length
      ? row.grades.map(grade => `<span class="chip tiny homc-grade" ` +
        `title="${esc(HOMC_GRADE_EXPLAINED[grade] || '由该清单判定的来源等级')}">${esc(grade)}</span>`).join('')
      : '<span class="chip tiny homc-grade none">无等级</span>';
    return `<div class="homc-sources">${grades}` +
      (row.singleB ? '<span class="chip tiny homc-flag">单一 B 源</span>' : '') +
      (row.links.length
        ? `<a class="ext-link" href="${esc(row.links[0])}" target="_blank" ` +
          `rel="noopener noreferrer">来源 ↗</a>` +
          (row.links.length > 1 || (row.linkCount ?? 0) > row.links.length
            ? `<span class="micro muted">共 ${fmt(row.linkCount ?? row.links.length)} 个</span>` : '')
        : '<span class="micro muted">无链接</span>') +
      `</div>`;
  }

  function homcRowCell(row) {
    const labels = data.homcDateLabels();
    // A row without a date says which kind of "without" it is; the list writes
    // its own word for 待核实 / 未发布 / 未披露 / 不适用, and a blank cell is a
    // fifth case that is not the same thing as any of them.
    const when = row.date
      ? `<span class="homc-date">${esc(row.date)}</span>` +
        (row.precision === 'month' || row.precision === 'year'
          ? `<span class="micro muted">（清单只写到${row.precision === 'month' ? '月' : '年'}）</span>`
          : '')
      : `<span class="micro muted">${row.dateState
        ? `无日期：${esc(labels[row.dateState] || row.dateState)}` : '日期栏是空的'}</span>`;
    return `<div class="homc-name-cell">` +
      `<div class="homc-name"><code class="homc-suit">${esc(row.suit || '')}</code>` +
      `${row.url
        ? `<a class="model-link" href="${esc(row.url)}" target="_blank" rel="noopener noreferrer">` +
          `${esc(row.name)} ↗</a>`
        : `<span class="model-title">${esc(row.name)}</span>`}` +
      `${row.isNew ? '<span class="chip tiny awesome-fresh">本次新增</span>' : ''}` +
      `${row.sectionRef ? '<span class="chip tiny homc-flag">指向章节</span>' : ''}</div>` +
      `<div class="micro muted">${esc([row.vendor || '提供方未标注', row.group, row.category]
        .filter(Boolean).join(' · '))}</div>` +
      (row.capability ? `<div class="homc-prose micro">${esc(row.capability)}</div>` : '') +
      (row.availability ? `<div class="micro muted">${esc(row.availability)}</div>` : '') +
      `<div class="micro">${when}${row.note
        ? ` <span class="homc-note">${esc(row.note)}</span>` : ''}</div>` +
      `</div>`;
  }

  function renderHomcTable() {
    const state = data.state;
    const total = data.homcFiltered().length;
    const pages = data.homcPageCount();
    state.homcPage = Math.min(Math.max(1, state.homcPage), pages);
    const stats = data.homcStats();
    const rows = stats.available ? data.homcPage() : [];
    $('homcRowCount').textContent = stats.available
      ? `${fmt(total)} 行样本 · 第 ${state.homcPage} / ${pages} 页` +
        `（每页 ${fmt(data.homcPageSize())} 行；实测共 ${homcValue(stats.rowsTotal)} 行，` +
        '样本是三态轮转取的窗口，不是全量）'
      : '这次没读到快照，本页没有可展示的样本行';
    $('homcTableRows').innerHTML = rows.length ? rows.map((row, index) =>
      `<tr class="homc-row${row.isNew ? ' fresh' : ''}${row.state ? ` s-${esc(row.state)}` : ''}">` +
      `<td>${homcRowCell(row)}</td>` +
      `<td><span class="chip tiny homc-state-${esc(row.state || 'none')}">` +
      `${esc(homcStateLabel(row.state))}</span>` +
      (row.marker && row.markerState !== row.state
        ? `<div class="micro muted">行首写作 ${esc(row.marker)}</div>` : '') + '</td>' +
      `<td class="align-right">${esc(row.date || '—')}</td>` +
      `<td>${homcSourceCell(row)}</td>` +
      `<td><button type="button" class="button text-button" data-homc-card="${index}" ` +
      `title="把这一行变成本机任务草稿：推送后才会成为 tasks/ 下的文件">建卡</button>` +
      (data.homcWatch(row).length
        ? `<div class="micro muted homc-watch">${esc(data.homcWatch(row)[0])}</div>` : '') +
      `</td></tr>`).join('')
      : `<tr><td colspan="5" class="no-rows">${stats.available && data.homcRows().length
        ? '当前筛选下没有样本行。样本只是三态轮转的窗口，这里没有不等于清单里没有'
        : '快照还没读到：滚动到本节会自动读取，也可以点上方「刷新已发布快照」重试'}</td></tr>`;
    $('homcPageInfo').textContent = `${state.homcPage} / ${pages}`;
    $('homcPrev').disabled = state.homcPage === 1;
    $('homcNext').disabled = state.homcPage === pages;
    $('homcPagination').hidden = total <= data.homcPageSize();
  }

  function renderHomc() {
    const state = data.state;
    fillSelect('homcState', data.homcFacets().states.map(item => ({
      value: item.value, label: `${homcStateLabel(item.value)} (${fmt(item.count)})`
    })), 'homcState', '全部三态');
    fillSelect('homcGrade', data.homcFacets().grades.map(item => ({
      value: item.value, label: `${item.value} · ${HOMC_GRADE_EXPLAINED[item.value] || '等级'} (${fmt(item.count)})`
    })), 'homcGrade', '全部来源等级');
    fillSelect('homcVendor', data.homcFacets().vendors.map(item => ({
      value: item.value, label: `${item.value} (${fmt(item.count)})`
    })), 'homcVendor', '全部提供方');
    $('homcAttention').value = state.homcAttention;
    $('homcSort').value = state.homcSort;
    $('homcSearch').value = state.homcSearch;
    renderHomcStatus();
    renderHomcSummary();
    renderHomcCompare();
    renderHomcNotes();
    renderHomcTrend();
    renderHomcTable();
  }

  // --- Models ---------------------------------------------------------------

  function renderSummary() {
    const state = data.state;
    const models = data.modelScope();
    const withTotal = models.filter(model => Number.isFinite(model.all_time));
    const withRolling = models.filter(model => Number.isFinite(model.last_30d));
    const lifetime = withTotal.reduce((sum, model) => sum + model.all_time, 0);
    const rolling = withRolling.reduce((sum, model) => sum + model.last_30d, 0);
    const latest = state.snapshots.at(-1), previous = state.snapshots.at(-2);
    const net = data.netChange(latest, previous, 'models', data.modelScopeIds());

    $('statModels').textContent = fmt(models.length);
    $('statModelsSub').textContent = state.modelSource === 'live'
      ? `HF 实时清单 · ${timestamp(state.modelsCapturedAt)} UTC`
      : state.modelRefreshError ? '实时接口暂不可用 · 显示已发布快照' : '每日快照中的公开模型仓库';
    $('statLifetime').textContent = withTotal.length ? countCN(lifetime) : '—';
    $('statLifetime').title = withTotal.length ? fmt(lifetime) : '无累计数据';
    $('statLifetimeSub').textContent = withTotal.length !== models.length
      ? `已知 ${withTotal.length}/${models.length} 个模型的累计值`
      : '当前观测范围公开模型累计之和';
    $('statRolling').textContent = withRolling.length ? countCN(rolling) : '—';
    $('statRolling').title = withRolling.length ? `${fmt(rolling)} · 有效 ${withRolling.length}/${models.length} 个模型` : '无有效数据';
    $('statDelta').textContent = net?.value === null || !net ? '—' : signed(net.value);
    $('statDelta').classList.toggle('neg', Boolean(net?.value < 0));
    $('statDeltaSub').textContent = previous ? `可比 ${net?.compared || 0} 个模型 · 自 ${previous.date} 起` : '需要至少两天快照';

    $('lastSync').textContent = timestamp(state.latest.captured_at);
    $('snapshotCount').textContent = fmt(state.snapshots.length);
    $('snapshotDate').textContent = state.modelSource === 'live'
      ? `清单实时 · 趋势快照 ${state.latest.date} UTC`
      : `最新快照 ${state.latest.date} UTC`;
    $('snapshotDate').title = state.modelSource === 'live'
      ? `模型清单读取于 ${timestamp(state.modelsCapturedAt)} UTC；历史趋势不会由浏览器改写`
      : '';
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

  /**
   * One line about the run that produced the numbers above it.
   *
   * Two things it has to say, and one it must not fake. It says which steps did
   * not produce, because those are the failures `continue-on-error` hides
   * everywhere else on the page. It says its own boundary (`covers`), because the
   * deploy that follows the commit is not in this file and a green line here is
   * not proof the site updated. And an unread file is reported as unread: a fetch
   * that failed in this browser is not a failed collection.
   */
  function renderRunHealth() {
    const health = data.runHealth();
    const host = $('runHealth');
    if (!health.loaded) {
      host.textContent = '采集健康：这台浏览器没读到运行记录——读不到不等于采集失败';
      host.title = health.error ? `读取原因：${health.error}` : '运行记录未载入';
      host.className = 'run-health warn';
      return;
    }
    const latest = health.latest;
    if (!latest) {
      host.textContent = '采集健康：记录文件还没有任何运行';
      host.title = health.covers || '';
      host.className = 'run-health';
      return;
    }

    const words = {
      ok: latest.stepsWatched === null ? '各步都成功' : `${fmt(latest.stepsWatched)} 步都成功`,
      partial: `${fmt(latest.stepsFailed.length + latest.stepsMissing.length)} 步没成功`,
      failed: '作业本身失败了',
      unknown: '说了这趟跑过，没交出步骤结果'
    };
    const pieces = [`采集健康：最近一次运行 ${esc(latest.date || '日期认不出')}` +
      // An absent run number silences its own clause; `第 — 次` would read as a
      // count the page failed to print rather than one it never got.
      (latest.runNumber === null ? '' : `（第 ${fmt(latest.runNumber)} 次）`) + words[latest.status]];
    const blamed = [...latest.stepsFailed.map(item => `${item}（失败）`),
      ...latest.stepsMissing.map(item => `${item}（没跑到）`)];
    if (blamed.length) pieces.push(`没成功的步骤：${esc(blamed.join('、'))}`);
    const age = ageInDays(latest.recordedAt);
    if (age !== null && age > 2) pieces.push(`距今 ${Math.floor(age)} 天`);
    if (health.kept > 1 && health.notOk) {
      pieces.push(`保留的 ${fmt(health.kept)} 次记录里 ${fmt(health.notOk)} 次不干净`);
    }
    host.innerHTML = pieces.join(' · ') +
      (latest.runUrl ? ` <a href="${esc(latest.runUrl)}" target="_blank" rel="noopener noreferrer">看那次运行 ↗</a>` : '');
    host.title = health.covers
      ? `${health.covers}${latest.jobStatus ? `；作业状态 ${latest.jobStatus}` : ''}` : '';
    host.className = `run-health ${latest.status === 'ok' ? 'good' : 'warn'}`;
  }

  function renderOverall() {
    const state = data.state;
    const metric = state.metric;
    const ids = data.modelScopeIds();
    $('overallLegend').textContent = `${metric === 'all_time' ? '历史累计下载' : '滚动30天下载'} · ${ids ? '当前集合成员的历史观测值' : '各日当时公开模型之和'}`;
    charts.line($('overallChart'), [{
      name: metric === 'all_time' ? '历史累计' : '滚动30天',
      points: data.sumSeries('models', metric, state.range, ids),
      color: 'var(--chart-1)'
    }], { area: true, label: '模型总体下载趋势' });

    const snapshots = state.snapshots.slice(-16);
    const points = [];
    for (let index = 1; index < snapshots.length; index++) {
      const change = data.netChange(snapshots[index], snapshots[index - 1], 'models', ids);
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
    const top = [...data.modelScope()]
      .filter(model => Number.isFinite(model.last_30d))
      .sort((a, b) => (b.last_30d ?? 0) - (a.last_30d ?? 0))
      .slice(0, 6);
    if (!top.length) {
      $('topModels').innerHTML = '<div class="chart-empty">暂无滚动 30 天数据</div>';
      return;
    }
    const max = top[0].last_30d || 1;
    $('topModels').innerHTML = top.map((model, index) =>
      `<div class="top-item"><span class="rank-index">${String(index + 1).padStart(2, '0')}</span>` +
      `<div><div class="rank-model"><button type="button" class="rank-name" data-detail="${esc(model.id)}" title="查看 ${esc(model.id)} 的历史">${esc(model.id.split('/').slice(1).join('/'))}</button></div>` +
      `<div class="rank-progress"><span style="width:${(model.last_30d / max * 100).toFixed(1)}%"></span></div></div>` +
      `<span class="rank-number" title="${esc(fmt(model.last_30d))}">${esc(compact(model.last_30d))}</span></div>`
    ).join('');
  }

  function renderTable() {
    const state = data.state;
    const rows = data.filteredModels();
    const onlyNew = $('onlyNewModels');
    if (onlyNew) onlyNew.checked = state.modelShift === 'added';
    const onlyAnomalies = $('onlyAnomalies');
    if (onlyAnomalies) onlyAnomalies.checked = state.modelOnlyAnomalies;
    const pager = data.paginate ? data.paginate(rows, state.modelPage, state.modelPageSize) : {
      page: 1, pages: 1, size: rows.length || 1, total: rows.length, rows
    };
    if (data.paginate) state.modelPage = pager.page;

    $('tableCount').textContent = `${fmt(pager.total)} / ${fmt(data.modelScope().length)} 个模型 · 账户共 ${fmt(state.latest.models.length)}`;
    $('modelRows').innerHTML = pager.rows.length ? pager.rows.map(model => {
      const stateName = model.all_time === null ? '累计缺失' : model.d1 < 0 ? '统计修正?' : model.d1 === null ? '待积累' : '正常';
      const stateClass = model.all_time === null ? 'missing' : model.d1 < 0 ? 'alert' : model.d1 === null ? 'new' : '';
      const checked = state.compare.includes(model.id) ? 'checked' : '';
      const groups = data.modelCollections(model.id);
      const membership = groups.length ? groups.map(group =>
        `<button class="chip tiny collection-tag" data-collection="${esc(group.slug)}" title="${esc(group.title)}">${esc(group.title.split('|').at(-1).trim())}</button>`).join('')
        : `<span class="micro muted">${data.collectionsAvailable() ? '未归入集合' : '集合归属未知'}</span>`;
      return `<tr><td><button class="model-link" data-detail="${esc(model.id)}" title="查看 ${esc(model.id)} 的历史">` +
        `<span class="model-square">${esc(model.id.split('/').at(-1).slice(0, 1).toUpperCase())}</span>` +
        `<span class="model-title">${esc(model.id.split('/').slice(1).join('/'))}</span></button>` +
        `${model.url ? `<a class="ext-link" href="${esc(model.url)}" target="_blank" rel="noopener noreferrer" title="在 Hugging Face 打开 ${esc(model.id)}" aria-label="打开 ${esc(model.id)} 的 Hugging Face 页面">↗</a>` : ''}` +
        `<div class="model-collections">${membership}</div></td>` +
        `<td class="align-right">${esc(fmt(model.all_time))}</td>` +
        `<td class="align-right">${esc(fmt(model.last_30d))}</td>` +
        `<td class="align-right ${tone(model.d1)}">${esc(signed(model.d1))}</td>` +
        `<td class="align-right ${tone(model.d7)}">${esc(signed(model.d7))}</td>` +
        `<td class="align-right ${tone(model.d30)}">${esc(signed(model.d30))}</td>` +
        `<td><span class="state ${stateClass}">${esc(stateName)}</span></td>` +
        `<td class="compare-col"><input type="checkbox" class="compare-check" data-compare="${esc(model.id)}" aria-label="对比 ${esc(model.id)}" ${checked}></td></tr>`;
    }).join('') : '<tr><td colspan="8" class="no-rows">没有符合条件的模型</td></tr>';
    if (data.paginate) renderPager('modelPagination', pager);
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

    $('datasetTableCount').textContent = `${fmt(rows.length)} / ${fmt((data.state.latest.datasets || []).length)} 个数据集`;
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
    $('paperCount').textContent = `${fmt(rows.length)} / ${fmt(papers.length)} 篇论文`;
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
    const chips = [`<button class="platform-chip${current === 'all' ? ' active' : ''}" data-platform="all" aria-pressed="${current === 'all'}">全部平台</button>`];
    sources.forEach(source => {
      const active = current === 'all' || current.split(',').includes(source.id);
      const selected = current !== 'all' && active;
      const label = ids.includes(source.id) ? source.label : `${source.label} · 未配置`;
      chips.push(`<button class="platform-chip${selected ? ' active' : ''}" data-platform="${esc(source.id)}" aria-pressed="${selected}" ` +
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

    const snapshots = data.state.socialSnapshots;
    const rolling = data.socialNetChange(30);

    $('statSocialTotal').textContent = selected.length ? countCN(total) : '—';
    $('statSocialTotal').title = fmt(total);
    $('statSocialTotalSub').textContent = selected.length
      ? `${selected.length} 个平台粉丝数合计`
      : '尚未选择任何平台';
    $('statSocialPlatforms').textContent = fmt(sources.length);
    $('statSocialPlatformsSub').textContent = sources.length
      ? `其中 ${sources.filter(source => source.status === 'ok').length} 个采集成功`
      : '暂无已配置的平台';
    $('statSocialRolling').textContent = !rolling || rolling.value === null ? '—' : countCN(rolling.value);
    $('statSocialRolling').title = !rolling || rolling.value === null ? '需要恰好 30 天前的快照' : fmt(rolling.value);
    $('statSocialRollingSub').textContent = !rolling || rolling.value === null
      ? '需恰好 30 天前的可比快照'
      : `相比 ${rolling.baseline} · ${rolling.compared} 个平台`;
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
    $('socialTableCount').textContent = `${fmt(rows.length)} / ${fmt(sources.length)} 个平台`;
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
        points,
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
    document.querySelectorAll('[data-social-view]').forEach(button => {
      const active = button.dataset.socialView === view;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
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
    const scopeNote = data.state.githubForks === 'own' && totals.excludedForks
      ? ` · 已排除 ${fmt(totals.excludedForks)} 个 fork`
      : '';
    $('statGithubReposSub').textContent =
      `Star ${fmt(totals.stars)} · Fork ${fmt(totals.forks)} · ${fmt(totals.languages)} 种语言${scopeNote}`;

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
    const repos = [...data.githubScope()]
      .filter(repo => (repo.stars || 0) > 0)
      .sort((a, b) => (b.stars || 0) - (a.stars || 0))
      .slice(0, 8);
    if (!repos.length) {
      $('githubTopRepos').innerHTML = '<div class="chart-empty">暂无带 Star 的公开仓库</div>';
      return;
    }
    const max = repos[0].stars || 1;
    // A repository without a url renders as plain text rather than a dead
    // link pointing at the current page.
    $('githubTopRepos').innerHTML = repos.map((repo, index) => {
      const name = repo.url
        ? `<a class="rank-name" href="${esc(repo.url)}" target="_blank" rel="noopener noreferrer" title="${esc(repo.full_name)}">${esc(repo.name)}</a>`
        : `<span class="rank-name" title="${esc(repo.full_name)}">${esc(repo.name)}</span>`;
      return `<div class="top-item"><span class="rank-index">${String(index + 1).padStart(2, '0')}</span>` +
        `<div><div class="rank-model">${name}</div>` +
        `<div class="rank-progress"><span style="width:${(repo.stars / max * 100).toFixed(1)}%"></span></div></div>` +
        `<span class="rank-number" title="${esc(fmt(repo.stars))} 个 Star">${esc(compact(repo.stars))}</span></div>`;
    }).join('');
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

    $('githubTableCount').textContent = `${fmt(rows.length)} / ${fmt(all.length)} 个仓库`;
    $('githubRows').innerHTML = slice.length ? slice.map(repo => {
      const flags = [];
      if (repo.is_fork) flags.push('Fork');
      if (repo.archived) flags.push('已归档');
      const stateName = repo.archived ? '已归档' : repo.is_fork ? 'Fork 仓库' : '正常';
      const stateClass = repo.archived ? 'missing' : repo.is_fork ? 'new' : '';
      const square = `<span class="model-square">${esc((repo.name || '?').slice(0, 1).toUpperCase())}</span>`;
      // Repositories without a url fall back to plain text so the page never
      // links back to itself.
      const label = repo.url
        ? `<a class="model-link" href="${esc(repo.url)}" target="_blank" rel="noopener noreferrer" title="${esc(repo.full_name)}">${square}<span class="model-title">${esc(repo.name)}</span></a>`
        : `<span class="model-link model-link-plain" title="${esc(repo.full_name)}">${square}<span class="model-title">${esc(repo.name)}</span></span>`;
      return `<tr><td>${label}` +
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
    $('githubProjectList').innerHTML = items.map(project => {
      const meta = `<div class="project-meta"><span>#${esc(project.number ?? '—')}</span>` +
        `<span>${esc(project.state || '')}</span>` +
        `<span>${esc(timestamp(project.updated_at))}</span></div>`;
      const title = `<div class="project-title">${esc(project.title || '未命名项目')}</div>` +
        (project.description ? `<div class="project-desc">${esc(project.description)}</div>` : '');
      return project.url
        ? `<a class="project-card" href="${esc(project.url)}" target="_blank" rel="noopener noreferrer">${title}${meta}</a>`
        : `<div class="project-card project-card-plain">${title}${meta}</div>`;
    }).join('');
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
    const groups = data.modelCollections(id);
    $('detailContents').innerHTML =
      `<div class="detail-collections"><h3>集合归属与条目备注</h3>${groups.length ? groups.map(group => {
        const note = group.items.find(item => item.type === 'model' && item.id === id)?.note;
        const href = `https://huggingface.co/collections/${group.slug.split('/').map(encodeURIComponent).join('/')}`;
        return `<div><a href="${href}" target="_blank" rel="noopener noreferrer">${esc(group.title)} ↗</a>` +
          `<p>${esc(note || '该条目暂无备注')}</p></div>`;
      }).join('') : `<p>${data.collectionsAvailable() ? '未归入当前公开集合' : '集合归属暂不可用'}</p>`}</div>` +
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
    kindLabel,
    renderCollections,
    renderModelScopeBoard,
    renderModelScopeTable,
    renderConferences,
    renderStars,
    renderStarStatus,
    renderStarSummary,
    renderStarWall,
    renderStarGraph,
    renderStarTable,
    renderEntities,
    renderEntityStatus,
    renderEntitySummary,
    renderEntityCoverage,
    renderEntityProblems,
    renderEntityReverseNote,
    renderEntityTable,
    renderTasks,
    renderTaskStatus,
    renderTaskSummary,
    renderTaskQueue,
    renderTaskCanvas,
    renderTaskList,
    taskCardMarkup,
    taskDetailMarkup,
    taskDraftDiff,
    taskStatusLabel,
    renderAwesome,
    renderAwesomeStatus,
    renderAwesomeSummary,
    renderAwesomeCompare,
    renderAwesomeNotes,
    renderAwesomeTrend,
    renderAwesomeCards,
    renderAwesomeFlow,
    renderHomc,
    renderHomcStatus,
    renderHomcSummary,
    renderHomcCompare,
    renderHomcNotes,
    renderHomcTrend,
    renderHomcTable,
    renderConferenceStatus,
    renderConferenceSummary,
    renderConferenceUpcoming,
    renderConferenceTable,
    renderModelScopeChart,
    renderModelScopeProfile,
    renderBriefing,
    renderAttention,
    renderSummary,
    renderRunHealth,
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
