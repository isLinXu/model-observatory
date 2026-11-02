/* Model Observatory — application entry point.
 * Wires the layers together: binds events, loads data, triggers renders.
 * All behaviour lives in format.js / charts.js / data.js / render.js / theme.js.
 */
(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const { fmt, signed, tone, timestamp } = MO.format;
  const data = MO.data;
  const render = MO.render;
  let detailTrigger = null;

  function setActiveButton(selector, activeButton) {
    document.querySelectorAll(selector).forEach(button => {
      const active = button === activeButton;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  function csvEscape(value) {
    return `"${String(value ?? '').replace(/"/g, '""')}"`;
  }

  function download(name, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportModelCsv() {
    const header = ['model_id', 'downloads_all_time', 'downloads_rolling_30d', 'change_since_previous_snapshot',
      'change_7d', 'change_30d', 'likes', 'pipeline', 'date_utc', 'huggingface_url', 'collections', 'collection_slugs', 'collections_captured_at'];
    const rows = data.filteredModels().map(model => [
      model.id, model.all_time, model.last_30d, model.d1, model.d7, model.d30, model.likes,
      model.pipeline, data.state.latest.date, `https://huggingface.co/${model.id}`,
      data.modelCollections(model.id).map(item => item.title).join('; '),
      data.modelCollections(model.id).map(item => item.slug).join('; '),
      data.state.collections?.captured_at
    ]);
    download(`gatilin-models-${data.state.latest.date || 'latest'}.csv`,
      '\uFEFF' + [header, ...rows].map(row => row.map(csvEscape).join(',')).join('\r\n'),
      'text/csv;charset=utf-8');
  }

  function exportModelScopeCsv() {
    const latest = data.state.modelscope;
    const header = ['model_id', 'name', 'modelscope_downloads', 'modelscope_likes', 'snapshot_download_change',
      'tasks', 'gated', 'updated_at', 'observed_at', 'source', 'url'];
    const rows = data.modelscopeModels().map(model => [model.id, model.name, model.downloads, model.likes,
      data.modelscopeDelta(model.id)?.value, model.tasks.join('; '), model.gated, model.updated_at,
      latest.captured_at, latest.metric_source, `https://www.modelscope.cn/models/${model.id}`]);
    const content = [header, ...rows].map(row => row.map(value =>
      csvEscape(typeof value === 'string' && /^[=+\-@\t\r\n]/.test(value) ? `'${value}` : value)).join(',')).join('\r\n');
    download(`isLinXu-modelscope-${latest.date || 'latest'}.csv`, '\uFEFF' + content, 'text/csv;charset=utf-8');
  }

  async function refreshModelScope(live = false) {
    const snapshotButton = $('modelscopeRefresh'), liveButton = $('modelscopeLiveRefresh');
    if (snapshotButton.disabled || liveButton.disabled) return;
    const button = live ? liveButton : snapshotButton;
    snapshotButton.disabled = liveButton.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = live ? '查询实时清单…' : '读取已发布快照…';
    try {
      if (live) {
        await data.refreshModelScope();
        render.showToast('实时查询成功；仅更新模型清单，主页下载、关注者及历史曲线仍来自每日快照。');
      } else {
        const latest = await data.refreshModelScopeSnapshot();
        render.showToast(latest.status === 'ok'
          ? '已读取已发布快照；采集时间以页面标注为准，不会触发后台采集。'
          : '已读取已发布快照，但后台尚无新的成功采集；不会触发后台采集。');
      }
    } catch (error) {
      render.showToast(`${live ? '实时查询' : '快照读取'}失败：${error.message}。保留上次数据。`);
    } finally {
      snapshotButton.disabled = liveButton.disabled = false;
      button.setAttribute('aria-busy', 'false');
      snapshotButton.textContent = '刷新已发布快照';
      liveButton.textContent = '尝试实时查询';
      render.renderModelScopeBoard();
    }
  }

  /** Third-party text can start with a formula marker, so guard CSV cells. */
  function csvCell(value) {
    return typeof value === 'string' && /^[=+\-@\t\r\n]/.test(value) ? `'${value}` : value;
  }

  function exportConferenceCsv() {
    const payload = data.state.conferences || {};
    const header = ['event_id', 'conference', 'conference_key', 'area', 'ccf', 'core', 'edition', 'year',
      'kind', 'round', 'comment', 'deadline_utc', 'utc_offset_minutes', 'timezone_label', 'source_local',
      'time_status', 'date_tbd', 'event_date', 'place', 'url', 'snapshot_captured_at', 'source_updated_at'];
    const rows = data.conferenceRows().map(row => [
      row.id, row.title, row.key, row.area, row.ccf, row.core, row.edition, row.year, row.kind, row.round,
      row.comment, row.utc, row.offset_minutes, row.timezone, row.source_local, row.time_status, row.tbd,
      row.date, row.place, row.url, payload.captured_at, payload.source_updated_at
    ]);
    const date = String(payload.captured_at || '').slice(0, 10) || 'latest';
    download(`conference-deadlines-${date}.csv`,
      '\uFEFF' + [header, ...rows].map(row => row.map(value => csvEscape(csvCell(value))).join(',')).join('\r\n'),
      'text/csv;charset=utf-8');
  }

  /** Re-read the published conference snapshot; collection stays in the daily workflow. */
  async function refreshConferences() {
    const button = $('conferenceRefresh');
    if (button.disabled) return;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = '读取已发布快照…';
    try {
      const payload = await data.refreshConferenceSnapshot();
      render.showToast(payload.status === 'ok'
        ? '已读取会议快照；采集时间以页面标注为准，不会触发后台采集。'
        : '已读取会议快照，但后台最近一次采集未成功；页面继续显示上次数据。');
    } catch (error) {
      render.showToast(`会议快照读取失败：${error.message}。保留上次数据。`);
    } finally {
      button.disabled = false;
      button.setAttribute('aria-busy', 'false');
      button.textContent = '刷新已发布快照';
      render.renderConferences();
    }
  }

  const STAR_TYPE_LABELS = { language: '语言', topic: '主题', owner: '账户' };

  function exportStarCsv() {
    const snapshot = data.state.stars || {};
    const header = ['repository', 'owner', 'repo', 'url', 'stars', 'language', 'topics', 'description',
      'pushed_at', 'is_fork', 'is_archived', 'owner_is_organization', 'cluster_id', 'cluster_type',
      'cluster_label', 'snapshot_captured_at', 'detail_captured_at'];
    const rows = data.starFiltered().map(row => [row.name, row.owner, row.repo, row.url, row.stars,
      row.language, row.topics.join('; '), row.description, row.pushed, row.fork, row.archived, row.org,
      row.cluster, data.starClusterType(row.cluster), row.cluster.split(':')[1] || row.cluster,
      snapshot.captured_at, data.state.starDetail?.captured_at]);
    const date = String(snapshot.captured_at || '').slice(0, 10) || 'latest';
    download(`github-starred-${date}.csv`,
      '\uFEFF' + [header, ...rows].map(row => row.map(value => csvEscape(csvCell(value))).join(',')).join('\r\n'),
      'text/csv;charset=utf-8');
  }

  /** Re-read the published star snapshot; collection stays in the daily workflow. */
  async function refreshStars() {
    const button = $('starRefresh');
    if (button.disabled) return;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = '读取已发布快照…';
    try {
      const payload = await data.refreshStarSnapshot();
      render.showToast(payload.status === 'ok'
        ? '已读取 star 快照；采集时间以页面标注为准，不会触发后台采集。'
        : '已读取 star 快照，但后台最近一次采集未成功；页面继续显示上次数据。');
    } catch (error) {
      render.showToast(`star 快照读取失败：${error.message}。保留上次数据。`);
    } finally {
      button.disabled = false;
      button.setAttribute('aria-busy', 'false');
      button.textContent = '刷新已发布快照';
      render.renderStars();
    }
  }

  /** The wall and CSV need per-repository rows, which the aggregate snapshot omits. */
  async function loadStarDetail(force = false) {
    const state = data.state, button = $('starDetailLoad');
    if (state.starDetailStatus === 'loading') return;
    if (state.starDetail && !force) { render.renderStars(); return; }
    button.textContent = '读取 star 明细…';
    button.setAttribute('aria-busy', 'true');
    render.renderStarStatus();
    const payload = await data.ensureStarDetail(force);
    button.removeAttribute('aria-busy');
    render.showToast(payload
      ? `已加载 ${fmt(data.starRows().length)} 个 star 仓库明细；墙、清单与 CSV 现已可用。`
      : `${state.starDetailError || 'star 明细读取失败'}。KPI 与关系图仍来自聚合快照。`);
    render.renderStars();
  }

  /** Hover readout resolves the cell index the wall SVG stamped into `data-i`. */
  function starCellText(index) {
    const cell = data.starWall().cells[index];
    if (!cell) return '悬停任意格子查看仓库名、语言与 star 数。';
    const label = cell.cluster.split(':').slice(1).join(':') || cell.cluster;
    return `${cell.name} · ★${fmt(cell.stars || 0)} · ${cell.language || '语言未标注'} · ` +
      `${STAR_TYPE_LABELS[data.starClusterType(cell.cluster)] || '聚类'}：${label}`;
  }

  function selectStarCluster(id) {
    data.state.starCluster = data.state.starCluster === id ? 'all' : id;
    data.state.starPage = 1;
    render.renderStars();
  }

  function bindStarWall() {
    const wall = $('starWall');
    wall.addEventListener('mouseover', event => {
      const cell = event.target.closest('[data-i]');
      if (cell) $('starWallReadout').textContent = starCellText(Number(cell.dataset.i));
    });
    wall.addEventListener('click', event => {
      const cell = event.target.closest('[data-i]');
      if (cell) selectStarCluster(data.starWall().cells[Number(cell.dataset.i)]?.cluster || 'all');
    });
    // Wall blocks are only labelled through their colour, so the legend carries
    // the same click as the cells, and the graph nodes link back to the wall.
    $('starWallLegend').addEventListener('click', event => {
      const chip = event.target.closest('[data-cluster]');
      if (chip) selectStarCluster(chip.dataset.cluster);
    });
    $('starGraph').addEventListener('click', event => {
      const node = event.target.closest('[data-cluster]');
      if (node) selectStarCluster(node.dataset.cluster);
    });
  }

  /**
   * The detail file is the largest payload in this section and sits below the
   * fold, so first paint only needs the aggregate snapshot and the browser
   * pulls the rows when the reader gets close to the wall.
   */
  function watchStarSection() {
    if (!('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      if (data.state.starDetailStatus === 'idle') loadStarDetail();
    }, { rootMargin: '300px 0px' });
    observer.observe($('stars'));
  }

  function exportDatasetCsv() {
    const header = ['dataset_id', 'downloads_all_time', 'downloads_rolling_30d', 'change_since_previous_snapshot',
      'change_7d', 'change_30d', 'likes', 'modality', 'languages', 'date_utc', 'huggingface_url'];
    const rows = data.localDatasets().map(item => [
      item.id, item.all_time, item.last_30d, item.d1, item.d7, item.d30, item.likes,
      (item.modality || []).join('|'), (item.languages || []).join('|'),
      data.state.latest.date, `https://huggingface.co/datasets/${item.id}`
    ]);
    download(`gatilin-datasets-${data.state.latest.date || 'latest'}.csv`,
      '\uFEFF' + [header, ...rows].map(row => row.map(csvEscape).join(',')).join('\r\n'),
      'text/csv;charset=utf-8');
  }

  function exportSocialCsv() {
    const header = ['platform', 'handle', 'followers', 'following', 'posts', 'likes',
      'change_since_previous_snapshot', 'status', 'updated_at', 'url'];
    const rows = (data.state.social?.sources || []).map(source => [
      source.label, source.handle, source.followers, source.following, source.posts, source.likes,
      data.socialDelta(source.id), source.status, source.updated_at, source.url
    ]);
    download(`gatilin-social-${data.state.social?.captured_at?.slice(0, 10) || 'latest'}.csv`,
      '\uFEFF' + [header, ...rows].map(row => row.map(csvEscape).join(',')).join('\r\n'),
      'text/csv;charset=utf-8');
  }

  /**
   * Manual refresh of the GitHub board. The site is static, so this re-reads
   * the deployed snapshot with the cache bypassed. To collect fresh upstream
   * data, run the "Sync Hugging Face & deploy Pages" workflow manually.
   */
  async function refreshGitHub() {
    const button = $('githubRefresh');
    const original = button.textContent;
    button.disabled = true;
    button.textContent = '↻ 刷新中…';
    try {
      const latest = await data.reloadGitHub();
      render.renderGitHub();
      const captured = latest?.captured_at;
      render.showToast(captured
        ? `已刷新至最新发布的快照（${timestamp(captured)} UTC）。若需重新采集上游数据，请在 Actions 中手动运行同步工作流。`
        : '已刷新 GitHub 快照。');
    } catch (error) {
      render.showToast('刷新失败：' + error.message + '。当前仍显示上一次成功的数据。');
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  function exportGitHubCsv() {
    const header = ['full_name', 'name', 'url', 'stars', 'forks', 'language', 'updated_at',
      'pushed_at', 'is_fork', 'archived', 'description'];
    const rows = data.githubRepositories().map(repo => [
      repo.full_name, repo.name, repo.url, repo.stars, repo.forks, repo.language,
      repo.updated_at, repo.pushed_at, repo.is_fork, repo.archived, repo.description
    ]);
    download(`gatilin-github-repos-${data.state.github?.captured_at?.slice(0, 10) || 'latest'}.csv`,
      '\uFEFF' + [header, ...rows].map(row => row.map(csvEscape).join(',')).join('\r\n'),
      'text/csv;charset=utf-8');
  }

  function openDetail(id) {
    if (!data.state.latest.models.some(model => model.id === id)) return;
    detailTrigger = document.activeElement;
    data.state.model = id;
    $('detailOverlay').classList.remove('hidden');
    $('detailOverlay').setAttribute('aria-hidden', 'false');
    document.querySelector('.shell').inert = true;
    document.body.style.overflow = 'hidden';
    render.renderDetail();
    $('closeDetail').focus();
  }

  function closeDetail() {
    if (!data.state.model) return;
    data.state.model = null;
    document.querySelector('.shell').inert = false;
    document.body.style.overflow = '';
    if (detailTrigger instanceof HTMLElement) detailTrigger.focus();
    $('detailOverlay').classList.add('hidden');
    $('detailOverlay').setAttribute('aria-hidden', 'true');
    detailTrigger = null;
  }

  function trapDetailFocus(event) {
    const focusable = [...document.querySelectorAll(
      '#detailOverlay button:not([disabled]), #detailOverlay a[href], #detailOverlay [tabindex]:not([tabindex="-1"])'
    )].filter(element => element.getClientRects().length);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && (document.activeElement === first || !document.activeElement.closest('#detailOverlay'))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !document.activeElement.closest('#detailOverlay'))) {
      event.preventDefault();
      first.focus();
    }
  }

  /** Toggle a platform in the social filter. Clicking the active chip resets to all. */
  function toggleSocialPlatform(id) {
    const current = data.state.socialPlatforms;
    if (id === 'all') {
      data.state.socialPlatforms = 'all';
    } else if (current === 'all') {
      data.state.socialPlatforms = id;
    } else {
      const selected = current.split(',');
      data.state.socialPlatforms = selected.includes(id)
        ? (selected.length === 1 ? 'all' : selected.filter(item => item !== id).join(','))
        : [...selected, id].join(',');
    }
    render.renderSocial();
  }

  function renderModelScope() {
    const ids = new Set(data.modelScope().map(model => model.id));
    data.state.compare = data.state.compare.filter(id => ids.has(id));
    render.renderCollections();
    render.renderSummary();
    render.renderOverall();
    render.renderTop();
    render.renderTable();
    render.renderCompare();
  }

  function selectCollection(slug) {
    data.state.modelCollection = slug;
    renderModelScope();
  }

  async function refreshCollections() {
    const button = $('collectionRefresh');
    button.disabled = true;
    button.textContent = '刷新中…';
    try {
      await data.refreshCollections();
    } catch (error) {
      render.showToast(`集合刷新失败：${error.message}。已保留上次数据。`);
    } finally {
      renderModelScope();
      button.disabled = false;
      button.textContent = '刷新集合';
    }
  }

  function exportEntityCsv() {
    const payload = data.state.entities || {};
    const header = ['slug', 'title', 'kind', 'stage', 'tags', 'updated', 'link_count', 'link_domains',
      'link_ids', 'link_states', 'link_urls', 'source_url', 'body_bytes', 'body_lines', 'body_sha256',
      'body_truncated', 'snapshot_captured_at'];
    const rows = data.entityFiltered().map(entry => [
      entry.slug, entry.title, entry.kind, entry.stage, entry.tags.join('; '), entry.updated,
      entry.links.length, entry.links.map(link => link.domain).join('; '),
      entry.links.map(link => link.id).join('; '), entry.links.map(link => link.state).join('; '),
      entry.links.map(link => link.url || '').join('; '), entry.url, entry.bytes, entry.lines,
      entry.sha, entry.truncated, payload.captured_at
    ]);
    const date = String(payload.captured_at || '').slice(0, 10) || 'latest';
    // Only the relationships are exported; the prose stays in git, where a
    // Markdown body keeps its formatting and its history.
    download(`entity-registry-${date}.csv`,
      '\uFEFF' + [header, ...rows].map(row => row.map(value => csvEscape(csvCell(value))).join(',')).join('\r\n'),
      'text/csv;charset=utf-8');
  }

  /** Re-read the published registry index; the board is read-only by design. */
  async function refreshEntities() {
    const button = $('entityRefresh');
    if (button.disabled) return;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = '读取已发布快照…';
    try {
      const payload = await data.refreshEntitySnapshot();
      render.showToast(payload.status === 'ok'
        ? '已读取注册表快照；本页只读，不会触发后台采集，也不会修改任何条目。'
        : '已读取注册表快照，但后台最近一次索引未成功；页面继续显示上次数据。');
    } catch (error) {
      render.showToast(`注册表快照读取失败：${error.message}。保留上次数据。`);
    } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = '刷新已发布快照';
      render.renderEntities();
    }
  }

  /**
   * Open one entry's prose and full link list. The audit panel links straight to
   * an entry that the current filters may hide, so the filters give way rather
   * than silently showing nothing.
   */
  function openEntityEntry(slug) {
    const state = data.state;
    state.entityOpen = state.entityOpen === slug ? null : slug;
    if (!state.entityOpen) {
      state.entityPage = 1;
    } else {
      if (!data.entityFiltered().some(row => row.slug === slug)) {
        Object.assign(state, { entitySearch: '', entityKind: 'all', entityStage: 'all',
          entityTag: 'all', entityLink: 'all', entityObject: 'all' });
      }
      const index = data.entityFiltered().findIndex(row => row.slug === slug);
      if (index >= 0) state.entityPage = Math.floor(index / data.entityPageSize()) + 1;
    }
    render.renderEntities();
    return state.entityOpen;
  }

  /** Clicking a link chip asks the reverse question: who else references it? */
  function selectEntityObject(key) {
    const state = data.state;
    state.entityObject = state.entityObject === key ? 'all' : key;
    state.entityPage = 1;
    render.renderEntities();
  }

  function bind() {
    $('modelscopeRefresh').addEventListener('click', () => refreshModelScope());
    $('modelscopeLiveRefresh').addEventListener('click', () => refreshModelScope(true));
    $('modelscopeExport').onclick = exportModelScopeCsv;
    for (const [id, key, eventName] of [['modelscopeSearch', 'modelscopeSearch', 'input'], ['modelscopeTask', 'modelscopeTask', 'change'], ['modelscopeSort', 'modelscopeSort', 'change']]) {
      $(id).addEventListener(eventName, event => {
        data.state[key] = event.target.value;
        data.state.modelscopePage = 1;
        render.renderModelScopeTable();
      });
    }
    $('modelscopePrev').addEventListener('click', () => {
      data.state.modelscopePage--;
      render.renderModelScopeTable();
    });
    $('modelscopeNext').addEventListener('click', () => {
      data.state.modelscopePage++;
      render.renderModelScopeTable();
    });
    $('modelscopeMetric').addEventListener('change', event => {
      data.state.modelscopeMetric = event.target.value;
      render.renderModelScopeChart();
    });
    $('modelscopeChartReset').addEventListener('click', () => {
      data.state.modelscopeModel = 'all';
      render.renderModelScopeChart();
      render.renderModelScopeTable();
    });
    $('modelscopeRows').addEventListener('click', event => {
      const button = event.target.closest('[data-ms-model]');
      if (!button) return;
      data.state.modelscopeModel = button.dataset.msModel;
      render.renderModelScopeChart();
      render.renderModelScopeTable();
      $('modelscopeChartReset').focus({ preventScroll: true });
      $('modelscopeChart').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
    });
    // Conference board: filters only touch the list and the urgency panel.
    for (const [id, key, eventName] of [
      ['conferenceSearch', 'conferenceSearch', 'input'], ['conferenceArea', 'conferenceArea', 'change'],
      ['conferenceRank', 'conferenceRank', 'change'], ['conferenceKind', 'conferenceKind', 'change'],
      ['conferenceWindow', 'conferenceWindow', 'change']]) {
      $(id).addEventListener(eventName, event => {
        data.state[key] = event.target.value;
        data.state.conferencePage = 1;
        render.renderConferenceUpcoming();
        render.renderConferenceTable();
        render.renderConferenceStatus();
      });
    }
    $('conferenceFilterReset').addEventListener('click', () => {
      Object.assign(data.state, {
        conferenceSearch: '', conferenceArea: 'all', conferenceRank: 'all',
        conferenceKind: 'paper', conferenceWindow: '90', conferencePage: 1
      });
      render.renderConferences();
    });
    $('conferencePrev').addEventListener('click', () => {
      data.state.conferencePage--;
      render.renderConferenceTable();
    });
    $('conferenceNext').addEventListener('click', () => {
      data.state.conferencePage++;
      render.renderConferenceTable();
    });
    $('conferenceRefresh').addEventListener('click', refreshConferences);
    $('conferenceExport').onclick = exportConferenceCsv;
    // Star wall: filters only touch the wall legend, the list and the CSV.
    for (const [id, key, eventName] of [
      ['starSearch', 'starSearch', 'input'], ['starCluster', 'starCluster', 'change'],
      ['starLanguage', 'starLanguage', 'change'], ['starTopic', 'starTopic', 'change'],
      ['starStatusFilter', 'starStatus', 'change'], ['starSort', 'starSort', 'change']]) {
      $(id).addEventListener(eventName, event => {
        data.state[key] = event.target.value;
        data.state.starPage = 1;
        render.renderStarWall();
        render.renderStarTable();
        render.renderStarStatus();
      });
    }
    $('starFilterReset').addEventListener('click', () => {
      Object.assign(data.state, {
        starSearch: '', starCluster: 'all', starLanguage: 'all',
        starTopic: 'all', starStatus: 'all', starSort: 'stars', starPage: 1
      });
      render.renderStars();
    });
    $('starRows').addEventListener('click', event => {
      const cluster = event.target.closest('[data-cluster]');
      if (cluster) { selectStarCluster(cluster.dataset.cluster); return; }
      const topic = event.target.closest('[data-star-topic]');
      if (topic) {
        data.state.starTopic = data.state.starTopic === topic.dataset.starTopic ? 'all' : topic.dataset.starTopic;
        data.state.starPage = 1;
        render.renderStars();
      }
    });
    $('starPrev').addEventListener('click', () => {
      data.state.starPage--;
      render.renderStarTable();
    });
    $('starNext').addEventListener('click', () => {
      data.state.starPage++;
      render.renderStarTable();
    });
    $('starRefresh').addEventListener('click', refreshStars);
    $('starDetailLoad').addEventListener('click', () => loadStarDetail(true));
    $('starExport').onclick = exportStarCsv;
    bindStarWall();
    watchStarSection();
    // Entity registry: filters and the reverse lookup only touch this board.
    for (const [id, key, eventName] of [
      ['entitySearch', 'entitySearch', 'input'], ['entityKind', 'entityKind', 'change'],
      ['entityStage', 'entityStage', 'change'], ['entityTag', 'entityTag', 'change'],
      ['entityLink', 'entityLink', 'change'], ['entityObject', 'entityObject', 'change'],
      ['entitySort', 'entitySort', 'change']]) {
      $(id).addEventListener(eventName, event => {
        data.state[key] = event.target.value;
        data.state.entityPage = 1;
        render.renderEntityStatus();
        render.renderEntityReverseNote();
        render.renderEntityTable();
      });
    }
    $('entityFilterReset').addEventListener('click', () => {
      Object.assign(data.state, {
        entitySearch: '', entityKind: 'all', entityStage: 'all', entityTag: 'all',
        entityLink: 'all', entityObject: 'all', entitySort: 'updated', entityOpen: null, entityPage: 1
      });
      render.renderEntities();
    });
    // A link chip is a question in both directions: filter by the object, or open
    // the entry that claims it.
    $('entityRows').addEventListener('click', event => {
      const open = event.target.closest('[data-entity-open]');
      if (open) {
        openEntityEntry(open.dataset.entityOpen);
        return;
      }
      const object = event.target.closest('[data-entity-object]');
      if (object) {
        selectEntityObject(object.dataset.entityObject);
        return;
      }
      const tag = event.target.closest('[data-entity-tag]');
      if (tag) {
        data.state.entityTag = data.state.entityTag === tag.dataset.entityTag ? 'all' : tag.dataset.entityTag;
        data.state.entityPage = 1;
        render.renderEntities();
      }
    });
    $('entityProblems').addEventListener('click', event => {
      const open = event.target.closest('[data-entity-open]');
      if (open) openEntityEntry(open.dataset.entityOpen);
    });
    $('entityPrev').addEventListener('click', () => {
      data.state.entityPage--;
      render.renderEntityTable();
    });
    $('entityNext').addEventListener('click', () => {
      data.state.entityPage++;
      render.renderEntityTable();
    });
    $('entityRefresh').addEventListener('click', refreshEntities);
    $('entityExport').onclick = exportEntityCsv;
    $('collectionFilter').addEventListener('change', event => selectCollection(event.target.value));
    $('collectionReset').addEventListener('click', () => selectCollection('all'));
    $('collectionRefresh').addEventListener('click', refreshCollections);
    $('collectionCards').addEventListener('click', event => {
      const button = event.target.closest('[data-collection]');
      if (!button) return;
      selectCollection(button.dataset.collection);
      $('collectionFilter').focus({ preventScroll: true });
      $('collectionScope').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    });
    document.querySelectorAll('.segmented button, .range-controls button').forEach(button =>
      button.setAttribute('aria-pressed', String(button.classList.contains('active'))));
    document.querySelectorAll('[data-metric]').forEach(button => button.addEventListener('click', () => {
      data.state.metric = button.dataset.metric;
      setActiveButton('[data-metric]', button);
      render.renderOverall();
    }));

    document.querySelectorAll('[data-range]').forEach(button => button.addEventListener('click', () => {
      data.state.range = button.dataset.range;
      setActiveButton('[data-range]', button);
      render.renderOverall();
      render.renderCompare();
    }));

    document.querySelectorAll('[data-dataset-metric]').forEach(button => button.addEventListener('click', () => {
      data.state.datasetMetric = button.dataset.datasetMetric;
      setActiveButton('[data-dataset-metric]', button);
      render.renderDatasetChart();
    }));

    document.querySelectorAll('[data-dataset-range]').forEach(button => button.addEventListener('click', () => {
      data.state.datasetRange = button.dataset.datasetRange;
      setActiveButton('[data-dataset-range]', button);
      render.renderDatasetChart();
    }));

    $('modelSearch').addEventListener('input', event => {
      data.state.modelSearch = event.target.value;
      render.renderTable();
    });
    $('sortModel').addEventListener('change', event => {
      data.state.modelSort = event.target.value;
      render.renderTable();
    });
    $('onlyAnomalies').addEventListener('change', event => {
      data.state.modelOnlyAnomalies = event.target.checked;
      render.renderTable();
    });
    $('modelRows').addEventListener('click', event => {
      const button = event.target.closest('button[data-detail]');
      if (button) openDetail(button.dataset.detail);
      const collection = event.target.closest('[data-collection]');
      if (collection) {
        selectCollection(collection.dataset.collection);
        $('modelSearch').focus({ preventScroll: true });
      }
    });
    $('modelRows').addEventListener('change', event => {
      const box = event.target.closest('input[data-compare]');
      if (!box) return;
      const id = box.dataset.compare;
      if (box.checked && data.state.compare.length >= 3) {
        box.checked = false;
        render.showToast('最多同时比较 3 个模型，请先取消其他模型。');
        return;
      }
      data.state.compare = box.checked
        ? [...data.state.compare, id]
        : data.state.compare.filter(item => item !== id);
      render.renderCompare();
    });
    $('clearCompare').onclick = () => {
      data.state.compare = [];
      render.renderTable();
      render.renderCompare();
    };

    $('exportCSV').onclick = exportModelCsv;
    $('exportJSON').onclick = () =>
      download('gatilin-hf-download-history.json', JSON.stringify(data.state.history, null, 2), 'application/json;charset=utf-8');
    $('exportDatasetCSV').onclick = exportDatasetCsv;
    $('exportDatasetJSON').onclick = () =>
      download('gatilin-hf-dataset-history.json', JSON.stringify({
        author: data.state.latest.author,
        date: data.state.latest.date,
        snapshots: data.state.snapshots.map(snapshot => ({ date: snapshot.date, datasets: snapshot.datasets || {} }))
      }, null, 2), 'application/json;charset=utf-8');
    $('exportSocialCSV').onclick = exportSocialCsv;
    $('exportGitHubCSV').onclick = exportGitHubCsv;

    $('datasetSearch').addEventListener('input', render.renderDatasetTable);
    $('sortDataset').addEventListener('change', render.renderDatasetTable);
    $('paperSearch').addEventListener('input', render.renderPapers);

    // Social section: platform filter, range filter and view switch.
    $('socialPlatformFilter').addEventListener('click', event => {
      const chip = event.target.closest('[data-platform]');
      if (chip) toggleSocialPlatform(chip.dataset.platform);
    });
    document.querySelectorAll('[data-social-range]').forEach(button => button.addEventListener('click', () => {
      data.state.socialRange = button.dataset.socialRange;
      setActiveButton('[data-social-range]', button);
      render.renderSocialChart();
    }));
    document.querySelectorAll('[data-social-view]').forEach(button => button.addEventListener('click', () => {
      data.state.socialView = button.dataset.socialView;
      render.renderSocial();
    }));

    // GitHub board: search, sort, language filter, paging and manual refresh.
    $('githubSearch').addEventListener('input', event => {
      data.state.githubSearch = event.target.value;
      data.state.githubPage = 1;
      render.renderGitHubTable();
    });
    $('sortGithub').addEventListener('change', event => {
      data.state.githubSort = event.target.value;
      data.state.githubPage = 1;
      render.renderGitHubTable();
    });
    $('filterGithubLanguage').addEventListener('change', event => {
      data.state.githubLanguage = event.target.value;
      data.state.githubPage = 1;
      render.renderGitHubTable();
    });
    // Fork scope: "仅自有" matches the repository count GitHub shows on the
    // profile page; "含 Fork" lists every public repository.
    document.querySelectorAll('[data-github-forks]').forEach(button => {
      button.addEventListener('click', () => {
        const scope = button.dataset.githubForks;
        if (data.state.githubForks === scope) return;
        data.state.githubForks = scope;
        data.state.githubPage = 1;
        setActiveButton('[data-github-forks]', button);
        render.renderGitHub();
      });
    });
    $('githubPrevPage').addEventListener('click', () => {
      data.state.githubPage = Math.max(1, data.state.githubPage - 1);
      render.renderGitHubTable();
    });
    $('githubNextPage').addEventListener('click', () => {
      data.state.githubPage += 1;
      render.renderGitHubTable();
    });
    $('githubRefresh').addEventListener('click', refreshGitHub);

    $('closeDetail').onclick = closeDetail;
    $('closeOverlayBg').onclick = closeDetail;
    document.addEventListener('keydown', event => {
      if (!data.state.model) return;
      if (event.key === 'Escape') closeDetail();
      else if (event.key === 'Tab') trapDetailFocus(event);
    });
    document.querySelectorAll('.navlinks a').forEach(link => link.addEventListener('click', () => {
      document.querySelectorAll('.navlinks a').forEach(item => item.classList.toggle('active', item === link));
    }));
  }

  function renderAll() {
    render.renderCollections();
    render.renderSummary();
    render.renderOverall();
    render.renderTop();
    render.renderTable();
    render.renderCompare();
    render.renderDatasetSummary();
    render.renderDatasetChart();
    render.renderTopDatasets();
    render.renderDatasetTable();
    render.renderScholar();
    render.renderPapers();
    render.renderSocial();
    render.renderGitHub();
    render.renderModelScopeBoard();
    render.renderConferences();
    render.renderStars();
    render.renderEntities();
  }

  async function boot() {
    MO.theme.init();
    bind();
    try {
      await data.loadAll();
      if (!data.state.latest.models.length) $('emptyBanner').classList.remove('hidden');
      renderAll();
    } catch (error) {
      $('freshLabel').textContent = '数据读取失败';
      render.stateMessage('页面可以加载，但读取历史 JSON 失败：' + error.message +
        '。请检查 GitHub Actions 是否成功完成采集与部署。');
      // Secondary panels still render so a partial failure is visible, not blank.
      try { render.renderScholar(); } catch (secondaryError) { console.error(secondaryError); }
      try { render.renderPapers(); } catch (secondaryError) { console.error(secondaryError); }
      try { render.renderSocial(); } catch (secondaryError) { console.error(secondaryError); }
      try { render.renderGitHub(); } catch (secondaryError) { console.error(secondaryError); }
      try { render.renderModelScopeBoard(); } catch (secondaryError) { console.error(secondaryError); }
      try { render.renderConferences(); } catch (secondaryError) { console.error(secondaryError); }
      try { render.renderStars(); } catch (secondaryError) { console.error(secondaryError); }
      try { render.renderEntities(); } catch (secondaryError) { console.error(secondaryError); }
    }
    // The template library is independent of the download data, so it loads
    // on its own and a failure here never blocks the other boards.
    MO.templates.init().catch(error => console.error('模版库初始化失败：', error));
  }

  boot();
})();
