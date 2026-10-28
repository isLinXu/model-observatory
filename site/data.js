/* Model Observatory — data access layer.
 * Owns the shared state and every network call. Rendering code never touches
 * fetch() directly, so adding a new data source means touching this file only.
 */
window.MO = window.MO || {};

MO.data = (() => {
  'use strict';

  const state = {
    latest: null,
    history: null,
    snapshots: [],
    snapshotMap: new Map(),
    metric: 'all_time',
    range: '30',
    compare: [],
    model: null,
    datasetMetric: 'all_time',
    datasetRange: '30',
    scholar: null,
    scholarSnapshots: [],
    social: null,
    socialSnapshots: [],
    socialView: 'cards',
    socialPlatforms: 'all',
    socialRange: '30',
    github: null,
    githubSnapshots: [],
    githubView: 'repositories',
    githubSort: 'updated',
    githubLanguage: 'all',
    githubSearch: '',
    githubPage: 1,
    githubPageSize: 12,
    // 'own' counts only repositories you created; 'all' also includes forks.
    // GitHub's own profile page lists owned repositories, so 'own' is the
    // default and keeps the headline number comparable with github.com.
    githubForks: 'own',
    modelSource: 'snapshot',
    modelsCapturedAt: null,
    modelRefreshError: null,
    collections: null,
    collectionSource: 'snapshot',
    collectionRefreshError: null,
    modelCollection: 'all',
    modelSearch: '',
    modelSort: 'last_30d',
    modelOnlyAnomalies: false,
    modelscope: null,
    modelscopeSnapshots: [],
    modelscopeSource: 'snapshot',
    modelscopeRefreshError: null,
    modelscopeSearch: '',
    modelscopeTask: 'all',
    modelscopeSort: 'downloads',
    modelscopePage: 1,
    modelscopeModel: 'all',
    modelscopeMetric: 'downloads',
    status: 'loading'
  };

  const listeners = [];

  /** Subscribe to state changes. Returns an unsubscribe function. */
  function subscribe(callback) {
    listeners.push(callback);
    return () => {
      const index = listeners.indexOf(callback);
      if (index >= 0) listeners.splice(index, 1);
    };
  }

  function notify() {
    listeners.forEach(callback => {
      try {
        callback(state);
      } catch (error) {
        console.error('渲染回调执行失败：', error);
      }
    });
  }

  function getDateShift(day, minusDays) {
    const date = new Date(`${day}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - minusDays);
    return date.toISOString().slice(0, 10);
  }

  /** Fetch JSON with a clear error message instead of a bare status code. */
  async function getJSON(url, label) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`${label} 读取失败（HTTP ${response.status}）`);
    return response.json();
  }

  function liveModelNumber(value) {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  function liveNextPage(header, currentUrl) {
    const part = String(header || '').split(',').find(value => /;\s*rel="?next"?/.test(value));
    const target = part?.match(/<([^>]+)>/)?.[1];
    if (!target) return null;
    const url = new URL(target, currentUrl);
    if (url.origin !== 'https://huggingface.co' || url.pathname !== '/api/models') {
      throw new Error('HF 模型分页地址无效');
    }
    return url.href;
  }

  async function fetchLiveModels(author) {
    const fields = ['downloads', 'downloadsAllTime', 'likes', 'pipeline_tag', 'createdAt', 'private'];
    const query = fields.map(field => `expand=${encodeURIComponent(field)}`).join('&');
    let url = `https://huggingface.co/api/models?author=${encodeURIComponent(author)}&limit=100&${query}`;
    const visited = new Set();
    const models = [];
    const ids = new Set();
    while (url) {
      if (visited.has(url)) throw new Error('HF 模型分页出现循环');
      visited.add(url);
      const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`HF 实时模型读取失败（HTTP ${response.status}）`);
      const batch = await response.json();
      if (!Array.isArray(batch)) throw new Error('HF 实时模型响应格式不完整');
      for (const item of batch) {
        const id = item?.id;
        if (typeof id !== 'string' || !id.startsWith(`${author}/`) || item.private || ids.has(id)) continue;
        ids.add(id);
        models.push({
          id,
          url: `https://huggingface.co/${id.split('/').map(encodeURIComponent).join('/')}`,
          all_time: liveModelNumber(item.downloadsAllTime),
          last_30d: liveModelNumber(item.downloads),
          likes: liveModelNumber(item.likes),
          pipeline: typeof item.pipeline_tag === 'string' && item.pipeline_tag ? item.pipeline_tag : 'other',
          created_at: typeof item.createdAt === 'string' ? item.createdAt : null
        });
      }
      url = liveNextPage(response.headers.get('Link'), url);
    }
    if (!models.length) throw new Error(`HF API 未返回 ${author} 的公开模型，保留已发布快照`);
    return models.sort((a, b) => a.id.toLowerCase().localeCompare(b.id.toLowerCase()));
  }

  async function refreshLiveModels() {
    const models = await fetchLiveModels(state.latest.author);
    state.latest = { ...state.latest, models };
    state.modelSource = 'live';
    state.modelsCapturedAt = new Date().toISOString();
    state.modelRefreshError = null;
    return models;
  }

  function normalizeCollection(item, author) {
    if (!item || typeof item.slug !== 'string' || !item.slug.startsWith(`${author}/`) ||
        !/^[\w-]+\/[\w.-]+$/.test(item.slug) || item.private || item.owner?.name !== author ||
        typeof item.title !== 'string' || !Array.isArray(item.items)) {
      throw new Error('HF 集合详情格式不完整');
    }
    const seen = new Set();
    const items = [];
    for (const entry of item.items) {
      if (entry.private) continue;
      const id = entry.type === 'collection' ? entry.slug : entry.id;
      if (typeof id !== 'string' || typeof entry.type !== 'string') throw new Error('HF 集合成员格式不完整');
      const key = `${entry.type}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ id, type: entry.type, note: typeof entry.note?.text === 'string' ? entry.note.text : '' });
    }
    return {
      slug: item.slug, title: item.title,
      description: typeof item.description === 'string' ? item.description : '',
      updated_at: typeof item.lastUpdated === 'string' ? item.lastUpdated : null,
      items
    };
  }

  async function refreshCollections() {
    try {
      const author = state.latest.author;
      let url = `https://huggingface.co/api/collections?owner=${encodeURIComponent(author)}&limit=100`;
      const visited = new Set();
      const slugs = new Set();
      const read = async target => {
        const response = await fetch(target, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error(`HF 集合读取失败（HTTP ${response.status}）`);
        return response;
      };
      while (url) {
        if (visited.has(url)) throw new Error('HF 集合分页出现循环');
        visited.add(url);
        const response = await read(url);
        const batch = await response.json();
        if (!Array.isArray(batch)) throw new Error('HF 集合列表格式不完整');
        for (const item of batch) {
          if (item.private) continue;
          if (item.owner?.name !== author || typeof item.slug !== 'string' ||
              !item.slug.startsWith(`${author}/`) || !/^[\w-]+\/[\w.-]+$/.test(item.slug)) {
            throw new Error('HF 集合地址无效');
          }
          slugs.add(item.slug);
        }
        const part = String(response.headers.get('Link') || '').split(',').find(value => /;\s*rel="?next"?/.test(value));
        const target = part?.match(/<([^>]+)>/)?.[1];
        const next = target ? new URL(target, url) : null;
        if (next && (next.origin !== 'https://huggingface.co' || next.pathname !== '/api/collections')) {
          throw new Error('HF 集合分页地址无效');
        }
        url = next?.href;
      }
      const items = [];
      const queue = [...slugs];
      // Collection listings contain previews, not complete membership.
      for (let index = 0; index < queue.length; index += 4) {
        const batch = await Promise.all(queue.slice(index, index + 4).map(async slug => {
          const response = await read(`https://huggingface.co/api/collections/${slug}`);
          const detail = normalizeCollection(await response.json(), author);
          if (detail.slug !== slug) throw new Error('HF 集合详情与请求不一致');
          return detail;
        }));
        items.push(...batch);
      }
      state.collections = {
        status: 'ok', captured_at: new Date().toISOString(), error: null,
        items: items.sort((a, b) => a.title.localeCompare(b.title))
      };
      state.collectionSource = 'live';
      state.collectionRefreshError = null;
      if (state.modelCollection !== 'all' && state.modelCollection !== 'unassigned' &&
          !items.some(item => item.slug === state.modelCollection)) state.modelCollection = 'all';
      return state.collections;
    } catch (error) {
      state.collectionRefreshError = error.message;
      throw error;
    }
  }

  async function loadDownloads() {
    const [latest, history] = await Promise.all([
      getJSON('./data/latest.json', '下载数据'),
      getJSON('./data/history.json', '历史快照')
    ]);
    // v1: models only. v2: models + datasets. v3: adds the `url` field.
    const supported = [1, 2, 3];
    if (!supported.includes(latest.schema_version) || !supported.includes(history.schema_version)) {
      throw new Error('下载数据格式不兼容');
    }
    if (latest.author !== history.author) throw new Error('下载数据的作者不一致');
    if (!Array.isArray(latest.models) || !Array.isArray(history.snapshots)) throw new Error('下载数据结构不完整');
    if (!latest.captured_at) throw new Error('缺少更新时间信息');
    state.latest = latest;
    state.history = history;
    state.snapshots = [...history.snapshots].sort((a, b) => a.date.localeCompare(b.date));
    state.snapshotMap = new Map(state.snapshots.map(snapshot => [snapshot.date, snapshot]));
    state.modelSource = 'snapshot';
    state.modelsCapturedAt = null;
    state.modelRefreshError = null;
    state.collections = latest.collections || null;
    state.collectionSource = 'snapshot';
    state.collectionRefreshError = null;
    await Promise.all([
      refreshLiveModels().catch(error => {
        state.modelRefreshError = error.message;
        console.warn('HF 实时模型读取失败，使用已发布快照：', error);
      }),
      refreshCollections().catch(error => {
        console.warn('HF 实时集合读取失败，保留集合快照：', error);
      })
    ]);
  }

  async function loadScholar() {
    try {
      const [profile, history] = await Promise.all([
        getJSON('./data/scholar.json', '学术档案'),
        getJSON('./data/scholar_history.json', '学术快照')
      ]);
      state.scholar = profile;
      state.scholarSnapshots = Array.isArray(history.snapshots)
        ? [...history.snapshots].sort((a, b) => a.date.localeCompare(b.date))
        : [];
    } catch (error) {
      // The academic profile is a secondary panel: keep the rest of the site alive.
      console.warn('学术档案数据读取失败：', error);
      state.scholar = { status: 'unavailable', error: error.message, metrics: {}, papers: [] };
    }
  }

  async function loadSocial() {
    try {
      const [latest, history] = await Promise.all([
        getJSON('./data/social.json', '社交数据'),
        getJSON('./data/social_history.json', '社交历史')
      ]);
      state.social = latest;
      state.socialSnapshots = Array.isArray(history.snapshots)
        ? [...history.snapshots].sort((a, b) => a.date.localeCompare(b.date))
        : [];
    } catch (error) {
      console.warn('社交数据读取失败：', error);
      state.social = { status: 'unavailable', error: error.message, sources: [] };
      state.socialSnapshots = [];
    }
  }

  /**
   * GitHub account metrics. The panel is optional: a failure keeps the rest of
   * the site alive and the board reports the reason inside the section.
   */
  async function loadGitHub() {
    try {
      const [latest, history] = await Promise.all([
        getJSON('./data/github.json', 'GitHub 数据'),
        getJSON('./data/github_history.json', 'GitHub 历史')
      ]);
      state.github = latest;
      state.githubSnapshots = Array.isArray(history.snapshots)
        ? [...history.snapshots].sort((a, b) => a.date.localeCompare(b.date))
        : [];
    } catch (error) {
      console.warn('GitHub 数据读取失败：', error);
      state.github = { status: 'unavailable', error: error.message, account: {}, repositories: [], projects: { items: [] } };
      state.githubSnapshots = [];
    }
  }

  /**
   * Re-read the published GitHub snapshot, bypassing the browser cache.
   * The site is static, so this refreshes the view from the latest deployed
   * data; a full re-collection is triggered by the GitHub Actions workflow
   * (workflow_dispatch) and lands on the next deployment.
   */
  async function reloadGitHub() {
    const stamp = Date.now();
    const [latest, history] = await Promise.all([
      getJSON(`./data/github.json?t=${stamp}`, 'GitHub 数据'),
      getJSON(`./data/github_history.json?t=${stamp}`, 'GitHub 历史')
    ]);
    state.github = latest;
    state.githubSnapshots = Array.isArray(history.snapshots)
      ? [...history.snapshots].sort((a, b) => a.date.localeCompare(b.date))
      : [];
    notify();
    return latest;
  }

  const MODELSCOPE_AUTHOR = 'isLinXu';
  const MODELSCOPE_SOURCE = 'modelscope-openapi-v1';
  const msIdValid = id => typeof id === 'string' && /^isLinXu\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && !id.includes('..');
  const msCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

  async function loadModelScope() {
    try {
      const [latest, history] = await Promise.all([
        getJSON('./data/modelscope.json', 'ModelScope 数据'),
        getJSON('./data/modelscope_history.json', 'ModelScope 历史')
      ]);
      if ([latest, history].some(item => item?.schema_version !== 1 || item.author !== MODELSCOPE_AUTHOR || item.metric_source !== MODELSCOPE_SOURCE) ||
          !['ok', 'stale', 'unavailable'].includes(latest.status) || !Array.isArray(latest.models) ||
          latest.models.some(model => !msIdValid(model.id) || !Array.isArray(model.tasks)) || !Array.isArray(history.snapshots)) {
        throw new Error('ModelScope 快照格式或统计来源不兼容');
      }
      state.modelscope = latest;
      state.modelscopeSnapshots = [...history.snapshots].sort((a, b) => a.date.localeCompare(b.date));
    } catch (error) {
      state.modelscope = { status: 'unavailable', author: MODELSCOPE_AUTHOR, models: [], error: error.message };
      state.modelscopeSnapshots = [];
      console.warn('ModelScope 快照读取失败：', error);
    }
  }

  async function refreshModelScope() {
    const models = [], ids = new Set();
    const budget = AbortSignal.timeout(120000);
    let total = null;
    try {
      for (let page = 1; page <= 60; page++) {
        const url = `https://www.modelscope.cn/openapi/v1/models?owner=${MODELSCOPE_AUTHOR}&page_number=${page}&page_size=50`;
        const response = await fetch(url, {
          credentials: 'omit', redirect: 'error', cache: 'no-store',
          signal: AbortSignal.any([budget, AbortSignal.timeout(20000)])
        });
        if (!response.ok) throw new Error(`ModelScope 读取失败（HTTP ${response.status}）`);
        const payload = await response.json(), batch = payload?.data;
        if (payload.success !== true || !Array.isArray(batch?.models) || msCount(batch.total_count) === null ||
            batch.page_number !== page || batch.page_size !== 50 || batch.total_count > 3000 ||
            (total !== null && batch.total_count !== total)) throw new Error('ModelScope 分页不完整或清单已变化');
        total = batch.total_count;
        if (batch.models.length !== Math.min(50, total - (page - 1) * 50)) throw new Error('ModelScope 模型清单不完整');
        for (const model of batch.models) {
          if (!msIdValid(model?.id) || model.private !== false || typeof model.gated !== 'boolean' || ids.has(model.id)) {
            throw new Error('ModelScope 返回重复、非公开或非当前账户的模型');
          }
          ids.add(model.id);
          models.push({
            id: model.id, name: typeof model.display_name === 'string' ? model.display_name : model.id.split('/')[1],
            url: `https://www.modelscope.cn/models/${model.id}`,
            downloads: msCount(model.downloads), likes: msCount(model.likes), gated: model.gated,
            tasks: Array.isArray(model.tasks) ? model.tasks.filter(task => typeof task === 'string') : [],
            license: typeof model.license === 'string' ? model.license : '',
            created_at: typeof model.created_at === 'string' ? model.created_at : null,
            updated_at: typeof model.last_modified === 'string' ? model.last_modified : null
          });
        }
        if (models.length === total) break;
      }
      if (models.length !== total) throw new Error('ModelScope 清单超过分页范围');
      const capture = new Date().toISOString();
      state.modelscope = {
        ...state.modelscope, schema_version: 1, author: MODELSCOPE_AUTHOR, metric_source: MODELSCOPE_SOURCE,
        status: 'ok', error: null, captured_at: capture, date: capture.slice(0, 10), models
      };
      state.modelscopeSource = 'live';
      state.modelscopeRefreshError = null;
      if (state.modelscopeModel !== 'all' && !ids.has(state.modelscopeModel)) state.modelscopeModel = 'all';
      if (state.modelscopeTask !== 'all' && !models.some(model => model.tasks.includes(state.modelscopeTask))) state.modelscopeTask = 'all';
      return state.modelscope;
    } catch (error) {
      state.modelscopeRefreshError = error.message;
      throw error;
    }
  }

  function modelscopeModels() {
    const search = state.modelscopeSearch.trim().toLowerCase();
    const rows = (state.modelscope?.models || []).filter(model =>
      (state.modelscopeTask === 'all' || model.tasks.includes(state.modelscopeTask)) &&
      (!search || `${model.id} ${model.name} ${model.tasks.join(' ')}`.toLowerCase().includes(search)));
    const sort = state.modelscopeSort;
    return rows.sort((a, b) => sort === 'name' ? a.id.localeCompare(b.id)
      : sort === 'updated_at' ? String(b.updated_at || '').localeCompare(String(a.updated_at || '')) || a.id.localeCompare(b.id)
        : (b[sort] ?? -Infinity) - (a[sort] ?? -Infinity) || a.id.localeCompare(b.id));
  }

  function modelscopeTotals() {
    const models = state.modelscope?.models || [];
    const metric = key => {
      const known = models.filter(model => Number.isFinite(model[key]));
      return { value: known.length ? known.reduce((sum, model) => sum + model[key], 0) : null, known: known.length };
    };
    return { count: models.length, downloads: metric('downloads'), likes: metric('likes') };
  }

  function modelscopeSeries() {
    const index = state.modelscopeMetric === 'likes' ? 1 : 0;
    return state.modelscopeSnapshots.flatMap(snapshot => {
      const values = state.modelscopeModel === 'all' ? Object.values(snapshot.models || {}).map(pair => pair[index])
        : [snapshot.models?.[state.modelscopeModel]?.[index]];
      if (!values.length || values.some(value => !Number.isFinite(value))) return [];
      return [{ date: snapshot.date, value: values.reduce((sum, value) => sum + value, 0) }];
    });
  }

  function modelscopeDelta(id = null) {
    const [older, newer] = state.modelscopeSnapshots.slice(-2);
    if (!older || !newer) return null;
    let value = 0, compared = 0;
    for (const key of id ? [id] : Object.keys(newer.models || {})) {
      const before = older.models?.[key]?.[0], after = newer.models?.[key]?.[0];
      if (!Number.isFinite(before) || !Number.isFinite(after)) continue;
      value += after - before;
      compared++;
    }
    return compared ? { value, compared, from: older.date, to: newer.date } : null;
  }

  /** Load every dataset. Only a download failure is fatal for the page. */
  async function loadAll() {
    const [downloads] = await Promise.allSettled([
      loadDownloads(), loadScholar(), loadSocial(), loadGitHub(), loadModelScope()
    ]);
    if (downloads.status === 'rejected') throw downloads.reason;
    state.status = 'ready';
  }

  // --- Derived series ------------------------------------------------------

  function modelSeries(id, metric, range = 'all') {
    const source = range === 'all' ? state.snapshots : state.snapshots.slice(-Number(range));
    return source.flatMap(snapshot => {
      const point = snapshot.models?.[id];
      if (!point) return [];
      const value = point[metric === 'all_time' ? 0 : 1];
      return Number.isFinite(value) ? [{ date: snapshot.date, value }] : [];
    });
  }

  function sumSeries(key, metric, range = 'all', ids = null) {
    const source = range === 'all' ? state.snapshots : state.snapshots.slice(-Number(range));
    return source.map(snapshot => {
      let sum = 0, known = 0;
      Object.entries(snapshot[key] || {}).forEach(([id, point]) => {
        if (ids && !ids.has(id)) return;
        const value = point[metric === 'all_time' ? 0 : 1];
        if (Number.isFinite(value)) { sum += value; known++; }
      });
      return known ? { date: snapshot.date, value: sum } : null;
    }).filter(Boolean);
  }

  function datasetSeries(id, metric, range = 'all') {
    const source = range === 'all' ? state.snapshots : state.snapshots.slice(-Number(range));
    return source.flatMap(snapshot => {
      const point = snapshot.datasets?.[id];
      if (!point) return [];
      const value = point[metric === 'all_time' ? 0 : 1];
      return Number.isFinite(value) ? [{ date: snapshot.date, value }] : [];
    });
  }

  function pairDelta(id, newer, older, key = 'models') {
    if (!newer || !older) return null;
    const current = newer[key]?.[id]?.[0], previous = older[key]?.[id]?.[0];
    return Number.isFinite(current) && Number.isFinite(previous) ? current - previous : null;
  }

  /** Net change of a whole collection between two snapshots. */
  function netChange(newer, older, key = 'models', ids = null) {
    if (!newer || !older) return null;
    let sum = 0, counted = 0, negative = 0;
    for (const id of Object.keys(newer[key] || {})) {
      if (ids && !ids.has(id)) continue;
      const value = pairDelta(id, newer, older, key);
      if (value === null) continue;
      sum += value;
      counted++;
      if (value < 0) negative++;
    }
    return { value: counted ? sum : null, compared: counted, revised: negative };
  }

  function delta(id, days, key = 'models') {
    const latest = state.snapshots.at(-1);
    if (!latest) return null;
    const baseline = days === 'prev'
      ? state.snapshots.at(-2)
      : state.snapshotMap.get(getDateShift(latest.date, days));
    return pairDelta(id, latest, baseline, key);
  }

  function collectionsAvailable() {
    return ['ok', 'stale'].includes(state.collections?.status);
  }

  function modelCollections(id) {
    return (state.collections?.items || []).filter(collection =>
      collection.items.some(item => item.type === 'model' && item.id === id));
  }

  function modelScope(collection = state.modelCollection) {
    const models = state.latest?.models || [];
    if (collection === 'all') return models;
    if (!collectionsAvailable()) return [];
    if (collection === 'unassigned') return models.filter(model => !modelCollections(model.id).length);
    const group = state.collections.items.find(item => item.slug === collection);
    const ids = new Set((group?.items || []).filter(item => item.type === 'model').map(item => item.id));
    return models.filter(model => ids.has(model.id));
  }

  function modelScopeIds() {
    return state.modelCollection === 'all' ? null : new Set(modelScope().map(model => model.id));
  }

  function collectionStats(collection) {
    const models = modelScope(collection);
    const total = metric => {
      const known = models.filter(model => Number.isFinite(model[metric]));
      return { value: known.length ? known.reduce((sum, model) => sum + model[metric], 0) : null, known: known.length };
    };
    return { count: models.length, all_time: total('all_time'), last_30d: total('last_30d') };
  }

  function localModels() {
    return modelScope().map(model => ({
      ...model,
      d1: delta(model.id, 'prev'),
      d7: delta(model.id, 7),
      d30: delta(model.id, 30)
    }));
  }

  function filteredModels() {
    const search = state.modelSearch.trim().toLowerCase();
    const rows = localModels().filter(model =>
      (!search || model.id.toLowerCase().includes(search)) && (!state.modelOnlyAnomalies || model.d1 < 0));
    const sort = state.modelSort;
    if (sort === 'name') rows.sort((a, b) => a.id.localeCompare(b.id));
    else rows.sort((a, b) => ((b[sort] ?? -Infinity) - (a[sort] ?? -Infinity)) || a.id.localeCompare(b.id));
    return rows;
  }

  function localDatasets() {
    return (state.latest?.datasets || []).map(item => ({
      ...item,
      d1: delta(item.id, 'prev', 'datasets'),
      d7: delta(item.id, 7, 'datasets'),
      d30: delta(item.id, 30, 'datasets')
    }));
  }

  // --- Social helpers ------------------------------------------------------

  /** Sources that carry a usable follower count, ordered by that count. */
  function socialSources() {
    const sources = state.social?.sources || [];
    return sources
      .filter(source => Number.isFinite(source.followers))
      .sort((a, b) => b.followers - a.followers);
  }

  /** Follower total across the selected platforms, per snapshot. */
  function socialSeries(range = '30') {
    const source = range === 'all' ? state.socialSnapshots : state.socialSnapshots.slice(-Number(range));
    const wanted = selectedSocialIds();
    return source.map(snapshot => {
      let total = 0;
      for (const id of wanted) {
        const value = snapshot.followers?.[id];
        if (!Number.isFinite(value)) return null;
        total += value;
      }
      return wanted.length ? { date: snapshot.date, value: total } : null;
    }).filter(Boolean);
  }

  function socialNetChange(days) {
    const latest = state.socialSnapshots.at(-1);
    if (!latest) return null;
    const baselineDate = getDateShift(latest.date, days);
    const baseline = state.socialSnapshots.find(snapshot => snapshot.date === baselineDate);
    if (!baseline) return null;
    let value = 0;
    let compared = 0;
    for (const id of selectedSocialIds()) {
      const current = latest.followers?.[id];
      const previous = baseline.followers?.[id];
      if (!Number.isFinite(current) || !Number.isFinite(previous)) continue;
      value += current - previous;
      compared++;
    }
    return { value: compared ? value : null, compared, baseline: baselineDate };
  }

  /** Ids of the platforms currently included in the social views. */
  function selectedSocialIds() {
    const all = socialSources().map(source => source.id);
    if (state.socialPlatforms === 'all') return all;
    return all.filter(id => state.socialPlatforms.split(',').includes(id));
  }

  /** Change of a platform's followers between the last two snapshots. */
  function socialDelta(id) {
    const snapshots = state.socialSnapshots;
    if (snapshots.length < 2) return null;
    const current = snapshots.at(-1).followers?.[id];
    const previous = snapshots.at(-2).followers?.[id];
    if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
    return current - previous;
  }

  // --- GitHub helpers -------------------------------------------------------

  /** Follower count per daily snapshot, for the trend chart. */
  function githubSeries() {
    return state.githubSnapshots
      .filter(snapshot => Number.isFinite(snapshot.followers))
      .map(snapshot => ({ date: snapshot.date, value: snapshot.followers }));
  }

  /**
   * Follower growth since the previous snapshot.
   * Returns { delta, rate } where rate is a fraction (0.05 = +5%).
   */
  function githubGrowth() {
    const snapshots = state.githubSnapshots
      .filter(snapshot => Number.isFinite(snapshot.followers));
    if (snapshots.length < 2) return { delta: null, rate: null, from: null, to: null };
    const previous = snapshots.at(-2), latest = snapshots.at(-1);
    const delta = latest.followers - previous.followers;
    const rate = previous.followers ? delta / previous.followers : null;
    return { delta, rate, from: previous.date, to: latest.date };
  }

  /**
   * Repository list honouring the fork scope switch.
   * `own` keeps only repositories you created (what GitHub shows on your
   * profile); `all` also includes forks. Every derived figure - totals,
   * language chart, top list, table and CSV - goes through this helper so
   * the numbers on the page always describe the same set.
   */
  function githubScope() {
    const repos = state.github?.repositories || [];
    return state.githubForks === 'all' ? repos : repos.filter(repo => !repo.is_fork);
  }

  /** Distinct languages present in the repository list, most used first. */
  function githubLanguages() {
    const counts = new Map();
    for (const repo of githubScope()) {
      const language = repo.language || '';
      if (!language) continue;
      counts.set(language, (counts.get(language) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([language, count]) => ({ language, count }));
  }

  /**
   * Repositories filtered by the current search box and language dropdown,
   * then sorted. Sorting is always descending for the numeric columns.
   */
  function githubRepositories() {
    const search = state.githubSearch.trim().toLowerCase();
    const language = state.githubLanguage;
    let rows = githubScope().filter(repo => {
      if (language !== 'all' && (repo.language || '') !== language) return false;
      if (!search) return true;
      const haystack = [
        repo.name || '', repo.full_name || '', repo.description || '',
        repo.language || '', (repo.topics || []).join(' ')
      ].join(' ').toLowerCase();
      return haystack.includes(search);
    });
    const sort = state.githubSort;
    if (sort === 'name') rows.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    else if (sort === 'stars') rows.sort((a, b) => (b.stars || 0) - (a.stars || 0) || (a.name || '').localeCompare(b.name || ''));
    else if (sort === 'forks') rows.sort((a, b) => (b.forks || 0) - (a.forks || 0) || (a.name || '').localeCompare(b.name || ''));
    else rows.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
    return rows;
  }

  /**
   * Totals for the current fork scope. `forks` counts forks received by the
   * scoped repositories; `excludedForks` reports how many fork repositories
   * the current scope hides, so the UI can explain the difference.
   */
  function githubTotals() {
    const all = state.github?.repositories || [];
    const repos = githubScope();
    return {
      repositories: repos.length,
      stars: repos.reduce((sum, repo) => sum + (repo.stars || 0), 0),
      forks: repos.reduce((sum, repo) => sum + (repo.forks || 0), 0),
      excludedForks: all.length - repos.length,
      totalForks: all.filter(repo => repo.is_fork).length,
      languages: new Set(repos.map(repo => repo.language).filter(Boolean)).size
    };
  }

  return {
    state,
    subscribe,
    notify,
    loadAll,
    refreshLiveModels,
    refreshCollections,
    collectionsAvailable,
    modelCollections,
    modelScope,
    modelScopeIds,
    collectionStats,
    filteredModels,
    getJSON,
    getDateShift,
    modelSeries,
    sumSeries,
    datasetSeries,
    pairDelta,
    netChange,
    delta,
    localModels,
    localDatasets,
    socialSources,
    socialSeries,
    socialNetChange,
    socialDelta,
    selectedSocialIds,
    reloadGitHub,
    githubSeries,
    githubGrowth,
    githubScope,
    githubLanguages,
    githubRepositories,
    githubTotals,
    refreshModelScope,
    modelscopeModels,
    modelscopeTotals,
    modelscopeSeries,
    modelscopeDelta
  };
})();
