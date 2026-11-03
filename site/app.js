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

  /** Re-read the published registry index; this never writes to the repo. */
  async function refreshEntities() {
    const button = $('entityRefresh');
    if (button.disabled) return;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = '读取已发布快照…';
    try {
      const payload = await data.refreshEntitySnapshot();
      render.showToast(payload.status === 'ok'
        ? '已读取注册表快照；刷新只读取已发布文件，不会触发后台采集，也不会修改任何条目。'
        : '已读取注册表快照，但后台最近一次索引未成功；页面继续显示上次数据。');
    } catch (error) {
      render.showToast(`注册表快照读取失败：${error.message}。保留上次数据。`);
    } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = '刷新已发布快照';
      render.renderEntities();
      // The draft list names its entries from the index, so it follows the refresh.
      MO.registry.renderDrafts();
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

  /**
   * The editor holds the remote source file, not the truncated copy the index
   * published. The row opens with it so the link states the author is about to
   * change stay on screen while they type.
   */
  async function editEntityEntry(slug) {
    if (data.state.entityOpen !== slug) openEntityEntry(slug);
    const opened = await MO.registry.open(slug);
    render.showToast(opened
      ? `编辑器里是 ${MO.registry.pathFor(slug)} 的远端原文，推送前会做基线检查。`
      : `回写暂不可用：${MO.registry.state.sync.message || '需要 GitHub Token。'}`);
    return opened;
  }

  /** Clicking a link chip asks the reverse question: who else references it? */
  function selectEntityObject(key) {
    const state = data.state;
    state.entityObject = state.entityObject === key ? 'all' : key;
    state.entityPage = 1;
    render.renderEntities();
  }

  // --- Task board -----------------------------------------------------------

  let taskDrag = null;
  let taskKeyLink = null;
  let taskSnapshotRead = false;
  // --- Paper-list tracking --------------------------------------------------
  let awesomeSnapshotRead = false;

  /**
   * Where the pointer is *on the canvas*, not on the screen: the box scrolls, so
   * a drop has to be measured against the cards' own coordinates.
   */
  function taskPoint(event, canvas) {
    const rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { left: 0, top: 0 };
    return {
      x: Number(event?.clientX || 0) - (rect.left || 0) + (canvas.scrollLeft || 0),
      y: Number(event?.clientY || 0) - (rect.top || 0) + (canvas.scrollTop || 0)
    };
  }

  /** What a drop means: another card (拆解), a different lane (状态), or furniture. */
  function taskDrop(slug, point, mode = 'move') {
    const board = MO.board;
    const rows = board.rows();
    const row = board.findRow(slug, rows);
    if (!row) return { kind: 'none' };
    const over = board.hitCard(point, board.layout(rows).cards, slug);
    if (over) return { kind: 'card', target: over };
    const lane = board.laneAt(point.x);
    if (mode === 'link') return { kind: 'nowhere', lane };
    if (lane !== row.lane) return { kind: 'lane', lane };
    return { kind: 'place', point };
  }

  function taskReadout(text) {
    $('taskCanvasSize').textContent = text;
  }

  function endTaskDrag() {
    const canvas = $('taskCanvas');
    if (taskDrag?.card) taskDrag.card.classList.remove(taskDrag.mode === 'link' ? 'is-linking' : 'is-dragging');
    if (taskDrag?.hover) taskDrag.hover.classList.remove('is-target');
    if (canvas.releasePointerCapture && taskDrag?.pointerId !== undefined) {
      try { canvas.releasePointerCapture(taskDrag.pointerId); } catch (error) { /* already gone */ }
    }
    taskDrag = null;
  }

  function onTaskPointerDown(event) {
    const card = event?.target?.closest?.('[data-task-card]');
    if (!card || event.target.closest?.('button, a')) return;
    const canvas = $('taskCanvas');
    const point = taskPoint(event, canvas);
    const handle = event.target.closest?.('[data-task-link]');
    taskDrag = {
      slug: card.dataset.taskCard, mode: handle ? 'link' : 'move', card, from: point, point,
      moved: false, hover: null, pointerId: event.pointerId
    };
    card.classList.add(handle ? 'is-linking' : 'is-dragging');
    // Capture keeps the drag alive when the pointer leaves the card; a browser
    // without it still drags inside the canvas.
    if (canvas.setPointerCapture && event.pointerId !== undefined) {
      try { canvas.setPointerCapture(event.pointerId); } catch (error) { /* no pointer */ }
    }
    event.preventDefault?.();
  }

  function onTaskPointerMove(event) {
    if (!taskDrag) return;
    const canvas = $('taskCanvas');
    const point = taskPoint(event, canvas);
    if (!taskDrag.moved && Math.abs(point.x - taskDrag.from.x) + Math.abs(point.y - taskDrag.from.y) < 6) return;
    taskDrag.moved = true;
    taskDrag.point = point;
    const cards = MO.board.rows();
    const hit = MO.board.hitCard(point, MO.board.layout(cards).cards, taskDrag.slug);
    if (taskDrag.hoverSlug !== hit) {
      taskDrag.hover?.classList?.remove('is-target');
      // Looked up by dataset rather than by selector: a slug is user input, and
      // an escaped-selector path is one more way to get this wrong.
      taskDrag.hover = hit
        ? (Array.from(canvas.querySelectorAll?.('[data-task-card]') || [])
            .find(element => element.dataset?.taskCard === hit) || null)
        : null;
      taskDrag.hoverSlug = hit;
      taskDrag.hover?.classList?.add('is-target');
    }
    if (taskDrag.mode === 'move' && taskDrag.card) {
      // The box follows the pointer while the drag is alive; the commit only
      // happens on release, so a cancelled drag leaves no orphan coordinate.
      taskDrag.card.setAttribute('style', `left:${Math.round(point.x - 60)}px;top:${Math.round(point.y - 24)}px`);
    }
    taskReadout(hit
      ? (taskDrag.mode === 'link'
        ? `松手：${taskDrag.slug} 等待 ${hit}（这条线会写进 ${taskDrag.slug} 的 depends）`
        : `松手：把 ${taskDrag.slug} 拆到 ${hit} 下面（这条线会写进 ${taskDrag.slug} 的 parent）`)
      : taskDrag.mode === 'link'
        // A lane name would be a lie here: a line has no lane to land in.
        ? '松手的地方没有卡片：依赖线要落在另一张卡上。'
        : `松手：落在「${MO.board.laneLabel(MO.board.laneAt(point.x))}」道`);
  }

  /**
   * 拆解 or 依赖, from a drop or from two key presses: one sentence either way.
   * The card stays where it was - drawing a line is not a request to pile the
   * author's work on top of the task it points at.
   */
  function applyEdge(origin, target, mode) {
    const result = mode === 'link' ? MO.board.connect(origin, target) : MO.board.setParent(origin, target);
    if (!result.ok) render.showToast(result.reason);
    else if (!result.changed) {
      render.showToast(mode === 'link'
        ? `${origin} 已经在等 ${target}，这条线不用重画。`
        : `${origin} 的父任务本来就是 ${target}，没有改动。`);
    } else {
      render.showToast(mode === 'link'
        ? `已连上：${origin} 等待 ${target}。这是本地草稿，推送前不进索引。`
        : `已拆解：${origin} 现在是 ${target} 的子任务。这是本地草稿，推送前不进索引。`);
    }
    return result;
  }

  /** A lane change lands the card in that lane's next free slot. */
  function applyLane(slug, lane) {
    const geometry = MO.board.layout();
    const slot = MO.board.slotIn(lane, geometry.cards, slug);
    const result = MO.board.setStatus(slug, lane);
    if (result.ok) MO.board.move(slug, slot);
    if (result.ok && result.changed) {
      render.showToast(`状态改为「${MO.board.laneLabel(lane)}」（本地草稿）：` +
        '推送后由次日采集器重建索引。');
    } else if (result.ok) {
      render.showToast(`${slug} 本来就在「${MO.board.laneLabel(lane)}」道，状态没有改动。`);
    } else render.showToast(result.reason);
    return result;
  }

  /**
   * One release, one meaning, one sentence back. A refusal is not a silent
   * no-op: the toast repeats what the reducer said, because a card that did not
   * move is otherwise indistinguishable from a drag that missed.
   */
  function onTaskPointerUp(event) {
    if (!taskDrag) return;
    const drag = taskDrag;
    const point = taskPoint(event, $('taskCanvas'));
    endTaskDrag();
    if (!drag.moved) {
      selectTaskCard(drag.slug);
      return;
    }
    const outcome = taskDrop(drag.slug, point, drag.mode);
    let result = null;
    if (outcome.kind === 'card') result = applyEdge(drag.slug, outcome.target, drag.mode);
    else if (outcome.kind === 'lane') result = applyLane(drag.slug, outcome.lane);
    else if (outcome.kind === 'place') {
      result = MO.board.move(drag.slug, point);
      if (result.ok) render.showToast('已摆放：卡片座标只存在这台浏览器，不会进入仓库。');
    } else {
      render.showToast('松手的地方没有卡片：依赖线要从卡片右下角的把手拖到另一张卡上。');
    }
    render.renderTasks();
  }

  /**
   * Keyboard handles for the two things a drag does, so the canvas is not a
   * pointer-only surface. `l` and `d` start a line from the focused card and the
   * same key on the next focused card finishes it - a two-press gesture instead
   * of a modal the reader cannot see out of, and `Esc` always drops it.
   */
  function endTaskKeyLink(note) {
    if (!taskKeyLink) return null;
    const previous = taskKeyLink;
    taskKeyLink.card?.classList?.remove('is-linking');
    taskKeyLink = null;
    taskReadout(note || '已取消这条线。');
    return previous;
  }

  function onTaskCanvasKey(event) {
    const card = event.target?.closest?.('[data-task-card]');
    if (!card) return;
    const slug = card.dataset.taskCard;
    const key = event.key;
    if (key === 'Escape') {
      // Escape only answers for the line gesture. With nothing pending the key
      // belongs to the page again, so the handler must not claim it silently.
      if (!taskKeyLink) return;
      endTaskKeyLink(`已取消：${taskKeyLink.slug} 的线没有连到任何卡。`);
      event.preventDefault?.();
      return;
    }
    if (key >= '1' && key <= '7') {
      event.preventDefault?.();
      applyLane(slug, MO.board.LANES[Number(key) - 1]);
      render.renderTasks();
      return;
    }
    if (key === 'l' || key === 'd') {
      event.preventDefault?.();
      const mode = key === 'l' ? 'link' : 'split';
      if (taskKeyLink && taskKeyLink.slug !== slug && taskKeyLink.mode === mode) {
        applyEdge(taskKeyLink.slug, slug, mode);
        endTaskKeyLink('');
        render.renderTasks();
        return;
      }
      if (taskKeyLink && taskKeyLink.slug !== slug) endTaskKeyLink('');
      taskKeyLink = { slug, mode, card };
      card.classList?.add('is-linking');
      taskReadout(mode === 'link'
        ? `依赖线：从 ${slug} 出发，Tab 到被等的卡片再按一次 l（Esc 取消）`
        : `拆解：把 ${slug} 挂到目标卡下面，Tab 过去再按一次 d（Esc 取消）`);
      return;
    }
    if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
      event.preventDefault?.();
      if (endTaskKeyLink('')) render.renderTasks();
      selectTaskCard(slug);
    }
  }

  /** Click, keyboard or a list row: the same card detail opens either way. */
  function selectTaskCard(slug) {
    const opened = MO.board.select(slug);
    if (opened) {
      const rows = MO.board.rows();
      // A card the filters hid would otherwise open a detail below an empty
      // canvas, so the filter is cleared instead of silently keeping it hidden.
      if (!data.taskFiltered(rows).some(row => row.slug === slug)) {
        Object.assign(data.state, { taskSearch: '', taskTag: 'all', taskRef: 'all' });
      }
    }
    render.renderTasks();
    return opened;
  }

  function openTaskNewForm(show) {
    const form = $('taskNewForm');
    form.classList.toggle('hidden', !show);
    if (show) {
      $('taskNewNote').textContent = '新卡先落在这块画布上：推送后才会成为 tasks/ 下的文件并被索引。';
      $('taskNewSlug').focus?.();
    }
  }

  function createTaskCard() {
    const result = MO.board.create({ slug: $('taskNewSlug').value, title: $('taskNewTitle').value });
    $('taskNewNote').textContent = result.ok
      ? `已创建 ${result.slug}（本地卡片）：在下面「待推送」里预览原文，推送后才会成为 tasks/ 下的文件。`
      : result.reason;
    if (result.ok) {
      $('taskNewSlug').value = '';
      $('taskNewTitle').value = '';
      data.state.taskView = 'board';
      render.renderTasks();
      render.showToast(`画布上多了一张卡：${result.slug}。它还在这台浏览器里，推送才进仓库。`);
    }
    return result;
  }

  function exportTaskCsv() {
    const header = ['slug', 'title', 'status', 'parent', 'depends', 'entity', 'entity_state',
      'ddl', 'ddl_state', 'deadline_utc', 'days_left', 'tags', 'updated', 'reason',
      'draft_state', 'pushed_at', 'source_url'];
    const now = Date.now();
    const rows = data.taskFiltered(MO.board.rows()).map(task => {
      const deadline = task.ddl ? data.taskDeadline(task.ddl, now) : null;
      const receipt = MO.board.pushedOf(task.slug);
      return [task.slug, task.title, task.status || '未标注', task.parent || '',
        task.depends.join('|'), task.entity || '', task.entityState || '', task.ddl || '',
        task.ddlState || '', deadline?.found ? deadline.utc || '' : '',
        deadline?.found && deadline.ts ? Math.round((deadline.ts - now) / 86400000) : '',
        task.tags.join('|'), task.updated || '', task.reason || '',
        task.pushed ? 'pushed' : task.dirty ? 'local' : 'none',
        task.pushed ? receipt?.at || '' : '', task.url || ''];
    });
    download(`task-board-${data.state.tasks?.captured_at?.slice(0, 10) || 'local'}.csv`,
      '\uFEFF' + [header, ...rows].map(row => row.map(value => csvEscape(csvCell(value))).join(',')).join('\r\n'),
      'text/csv;charset=utf-8');
  }

  async function refreshTasks() {
    const button = $('taskRefresh');
    if (button.disabled) return;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = '读取已发布快照…';
    try {
      const payload = await data.refreshTaskSnapshot();
      render.showToast(payload.status === 'ok'
        ? '已读取任务快照；刷新只读取已发布文件，不会触发后台采集。画布上的本地草稿仍在。'
        : '已读取任务快照，但后台最近一次索引未成功；页面继续显示上次数据。');
    } catch (error) {
      render.showToast(`任务快照读取失败：${error.message}。保留上次数据。`);
    } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = '刷新已发布快照';
      render.renderTasks();
    }
  }

  /**
   * The canvas is the heaviest section on the page and sits far below the fold,
   * so first paint never asks for it. Scrolling close is what triggers the read -
   * and a local draft still paints before any snapshot arrives.
   */
  function watchTaskSection() {
    const read = () => {
      // One entry read per page: scrolling back down to the canvas must not
      // download the same snapshot again, that is what the refresh button is for.
      if (taskSnapshotRead) return;
      taskSnapshotRead = true;
      data.loadTasks().then(() => render.renderTasks());
    };
    if (!('IntersectionObserver' in window)) {
      read();
      return;
    }
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      read();
    }, { rootMargin: '300px 0px' });
    observer.observe($('tasks'));
  }

  /**
   * Manual read of the published list snapshot. This never crawls a repository:
   * the six awesome lists are fetched by the daily workflow, and re-running it
   * from the browser would turn a reader's click into somebody else's traffic.
   */
  async function refreshAwesome() {
    const button = $('awesomeRefresh');
    if (button.disabled) return;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = '读取已发布快照…';
    try {
      const payload = await data.refreshAwesomeSnapshot();
      await data.loadAwesomeHistory(Date.now());
      render.showToast(payload.status === 'ok'
        ? '已读取清单快照；刷新只读已发布文件，不会去抓别人的仓库，也不触发后台采集。'
        : payload.status === 'partial'
          ? '已读取清单快照，但部分清单本次没读到：它们沿用上次结果并标为「沿用上次」。'
          : '已读取清单快照，但后台最近一次采集未成功；页面继续显示上次数据。');
    } catch (error) {
      render.showToast(`清单快照读取失败：${error.message}。保留上次数据。`);
    } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = '刷新已发布快照';
      render.renderAwesome();
    }
  }

  /**
   * The export is the sampled flow, not the whole list: one column pair keeps
   * 实测 and 自报 apart so a spreadsheet cannot turn them into one number.
   */
  function exportAwesomeCsv() {
    const payload = data.state.awesome || {};
    const byId = new Map(data.awesomeRows().map(row => [row.id, row]));
    const header = ['repo', 'ownership', 'list_kind', 'entry_id', 'title', 'url', 'arxiv_id',
      'published', 'venue', 'section', 'is_new', 'measured_entries', 'self_reported_entries',
      'list_status', 'list_read_today', 'cadence', 'stale_days', 'list_captured_at',
      'snapshot_status', 'snapshot_captured_at'];
    const rows = data.awesomeFlow().map(entry => {
      const repo = byId.get(entry.repoId) || {};
      return [entry.repoId, entry.upstream ? 'upstream' : 'own', entry.kind, entry.id, entry.title,
        entry.url || '', entry.arxivId || '', entry.published || '', entry.venue || '',
        entry.section || '', entry.isNew ? 'yes' : '',
        repo.measured?.entries ?? '', repo.selfReported?.entries ?? '',
        entry.repoStatus || '', entry.repoNotAttempted ? 'no' : 'yes',
        repo.cadence?.cadence || '', repo.cadence?.staleDays ?? '',
        repo.capturedAt || '', payload.status || '', payload.captured_at || ''];
    });
    const date = String(payload.captured_at || '').slice(0, 10) || 'latest';
    download(`paper-lists-${date}.csv`,
      '\uFEFF' + [header, ...rows].map(row => row.map(value => csvEscape(csvCell(value))).join(',')).join('\r\n'),
      'text/csv;charset=utf-8');
  }

  /** Below the fold and crawled elsewhere: scroll close is what asks for it. */
  function watchAwesomeSection() {
    const read = () => {
      if (awesomeSnapshotRead) return;
      awesomeSnapshotRead = true;
      data.loadAwesome().then(() => render.renderAwesome());
    };
    if (!('IntersectionObserver' in window)) {
      read();
      return;
    }
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      read();
    }, { rootMargin: '300px 0px' });
    observer.observe($('awesome'));
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
      const edit = event.target.closest('[data-entity-edit]');
      if (edit) {
        editEntityEntry(edit.dataset.entityEdit);
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
      const edit = event.target.closest('[data-entity-edit]');
      if (edit) {
        editEntityEntry(edit.dataset.entityEdit);
        return;
      }
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
    // Task board: the canvas is local furniture, the semantics are drafts, and
    // every refusal has to reach the reader as a sentence.
    for (const [id, key, eventName] of [
      ['taskSearch', 'taskSearch', 'input'], ['taskTag', 'taskTag', 'change'],
      ['taskRef', 'taskRef', 'change'], ['taskSort', 'taskSort', 'change']]) {
      $(id).addEventListener(eventName, event => {
        data.state[key] = event.target.value;
        data.state.taskPage = 1;
        render.renderTaskStatus();
        if (data.state.taskView === 'board') render.renderTaskCanvas();
        else render.renderTaskList();
      });
    }
    $('taskFilterReset').addEventListener('click', () => {
      Object.assign(data.state, {
        taskSearch: '', taskTag: 'all', taskRef: 'all', taskSort: 'updated', taskPage: 1
      });
      MO.board.clearSelection();
      render.renderTasks();
    });
    document.querySelectorAll('[data-task-view]').forEach(button => {
      button.addEventListener('click', () => {
        data.state.taskView = button.dataset.taskView;
        data.state.taskPage = 1;
        render.renderTasks();
      });
    });
    $('taskCanvas').addEventListener('pointerdown', onTaskPointerDown);
    $('taskCanvas').addEventListener('pointermove', onTaskPointerMove);
    $('taskCanvas').addEventListener('pointerup', onTaskPointerUp);
    $('taskCanvas').addEventListener('keydown', onTaskCanvasKey);
    $('taskCanvas').addEventListener('pointercancel', () => {
      endTaskDrag();
      render.renderTasks();
    });
    $('taskRows').addEventListener('click', event => {
      const open = event.target.closest('[data-task-open]');
      if (open) {
        selectTaskCard(open.dataset.taskOpen);
        return;
      }
      const row = event.target.closest('[data-task-slug]');
      if (row) selectTaskCard(row.dataset.taskSlug);
    });
    $('taskDetail').addEventListener('click', event => {
      const reset = event.target.closest('[data-task-reset]');
      if (!reset) return;
      const result = MO.board.discard(reset.dataset.taskReset);
      render.showToast(result.ok
        ? `已丢弃 ${reset.dataset.taskReset} 在本机的改动，卡片回到索引里的样子。${result.note || ''}`
        : result.reason);
      render.renderTasks();
    });
    $('taskNew').addEventListener('click', () => openTaskNewForm(
      $('taskNewForm').classList.contains('hidden')));
    $('taskNewClose').addEventListener('click', () => openTaskNewForm(false));
    $('taskNewCreate').addEventListener('click', createTaskCard);
    $('taskTidy').addEventListener('click', () => {
      MO.board.resetLayout();
      render.renderTasks();
      render.showToast('画布已按所在道重新堆叠：这只动了本机的摆放，任务内容一个字都没改。');
    });
    $('taskResetEdits').addEventListener('click', () => {
      const waiting = MO.board.pushedSlugs().length;
      MO.board.resetEdits();
      MO.board.clearSelection();
      render.renderTasks();
      render.showToast('本地未推送的语义改动与新建卡已清空；索引里的任务不受影响。' +
        (waiting ? `那 ${waiting} 张已推送的卡片也会退回索引里的旧样子——远端文件已经改好，` +
          '次日采集重建索引后页面会跟上。' : ''));
    });
    $('taskRefresh').addEventListener('click', refreshTasks);
    $('taskExport').onclick = exportTaskCsv;
    $('taskPrev').addEventListener('click', () => {
      data.state.taskPage--;
      render.renderTaskList();
    });
    $('taskNext').addEventListener('click', () => {
      data.state.taskPage++;
      render.renderTaskList();
    });
    MO.board.load();
    render.renderTasks();
    watchTaskSection();
    // Paper lists: one filter bar drives both the cards and the entry flow.
    for (const [id, key, eventName] of [
      ['awesomeSearch', 'awesomeSearch', 'input'], ['awesomeKind', 'awesomeKind', 'change'],
      ['awesomeOwner', 'awesomeOwner', 'change'], ['awesomeCadence', 'awesomeCadence', 'change'],
      ['awesomeAttention', 'awesomeAttention', 'change'], ['awesomeSort', 'awesomeSort', 'change'],
      ['awesomeFlowSort', 'awesomeFlowSort', 'change']]) {
      $(id).addEventListener(eventName, event => {
        data.state[key] = event.target.value;
        data.state.awesomeFlowPage = 1;
        render.renderAwesome();
      });
    }
    $('awesomeTrendMetric').addEventListener('change', event => {
      data.state.awesomeTrendMetric = event.target.value;
      render.renderAwesomeTrend();
    });
    $('awesomeFilterReset').addEventListener('click', () => {
      Object.assign(data.state, {
        awesomeSearch: '', awesomeKind: 'all', awesomeOwner: 'all', awesomeCadence: 'all',
        awesomeAttention: 'all', awesomeSort: 'measured', awesomeFlowPage: 1, awesomeFocus: null
      });
      render.renderAwesome();
    });
    document.querySelectorAll('[data-awesome-view]').forEach(button => {
      button.addEventListener('click', () => {
        data.state.awesomeView = button.dataset.awesomeView;
        data.state.awesomeFlowPage = 1;
        render.renderAwesome();
      });
    });
    $('awesomeCards').addEventListener('click', event => {
      const registry = event.target.closest('[data-awesome-registry]');
      if (registry) {
        selectEntityObject(registry.dataset.awesomeRegistry);
        render.showToast(`已在实体注册表里反查 ${registry.dataset.awesomeRegistry}：` +
          '关系归那个栏目，条目数与节奏仍在这里。');
        document.getElementById('registry')?.scrollIntoView?.({ block: 'start' });
        return;
      }
      const focus = event.target.closest('[data-awesome-focus]');
      if (focus) {
        const id = focus.dataset.awesomeFocus;
        data.state.awesomeFocus = data.state.awesomeFocus === id ? null : id;
        data.state.awesomeFlowPage = 1;
        render.renderAwesome();
        return;
      }
      const open = event.target.closest('[data-awesome-open]');
      if (!open) return;
      const id = open.dataset.awesomeOpen;
      data.state.awesomeOpen = data.state.awesomeOpen === id ? null : id;
      render.renderAwesomeCards();
    });
    $('awesomeFocusNote').addEventListener('click', () => {
      data.state.awesomeFocus = null;
      data.state.awesomeFlowPage = 1;
      render.renderAwesome();
    });
    $('awesomeRefresh').addEventListener('click', refreshAwesome);
    $('awesomeExport').onclick = exportAwesomeCsv;
    $('awesomeFlowPrev').addEventListener('click', () => {
      data.state.awesomeFlowPage--;
      render.renderAwesomeFlow();
    });
    $('awesomeFlowNext').addEventListener('click', () => {
      data.state.awesomeFlowPage++;
      render.renderAwesomeFlow();
    });
    render.renderAwesome();
    watchAwesomeSection();
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
      try { render.renderAwesome(); } catch (secondaryError) { console.error(secondaryError); }
    }
    // The template library is independent of the download data, so it loads
    // on its own and a failure here never blocks the other boards.
    MO.templates.init().catch(error => console.error('模版库初始化失败：', error));
    MO.registry.init().catch(error => console.error('注册表回写面板初始化失败：', error));
    MO.tasksync.init().catch(error => console.error('任务回写面板初始化失败：', error));
  }

  boot();
})();
