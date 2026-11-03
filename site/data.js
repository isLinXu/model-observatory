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
    modelscopeSnapshotRefreshError: null,
    modelscopeSnapshotCapturedAt: null,
    modelscopeSnapshotCheckedAt: null,
    modelscopeSnapshotStatus: null,
    modelscopeSnapshotError: null,
    modelscopeSearch: '',
    modelscopeTask: 'all',
    modelscopeSort: 'downloads',
    modelscopePage: 1,
    modelscopeModel: 'all',
    modelscopeMetric: 'downloads',
    conferences: null,
    conferenceSnapshotCheckedAt: null,
    conferenceRefreshError: null,
    conferenceSearch: '',
    conferenceArea: 'all',
    conferenceRank: 'all',
    conferenceKind: 'paper',
    conferenceWindow: '90',
    conferencePage: 1,
    stars: null,
    starDetail: null,
    starDetailStatus: 'idle',
    starDetailError: null,
    starDetailLoadedAt: null,
    starSnapshotCheckedAt: null,
    starRefreshError: null,
    starSearch: '',
    starCluster: 'all',
    starLanguage: 'all',
    starTopic: 'all',
    starStatus: 'all',
    starSort: 'stars',
    starPage: 1,
    entities: null,
    entitySnapshotCheckedAt: null,
    entityRefreshError: null,
    entitySearch: '',
    entityKind: 'all',
    entityStage: 'all',
    entityTag: 'all',
    entityLink: 'all',
    entityObject: 'all',
    entitySort: 'updated',
    entityOpen: null,
    entityPage: 1,
    tasks: null,
    taskSnapshotCheckedAt: null,
    taskRefreshError: null,
    taskView: 'board',
    taskSearch: '',
    taskTag: 'all',
    taskRef: 'all',
    taskSort: 'updated',
    taskOpen: null,
    taskPage: 1,
    awesome: null,
    awesomeHistory: null,
    awesomeHistoryError: null,
    awesomeHistoryRetention: null,
    awesomeTrendMetric: 'measured',
    awesomeFocus: null,
    awesomeSnapshotCheckedAt: null,
    awesomeRefreshError: null,
    awesomeView: 'repos',
    awesomeSearch: '',
    awesomeKind: 'all',
    awesomeOwner: 'all',
    awesomeCadence: 'all',
    awesomeAttention: 'all',
    awesomeSort: 'measured',
    awesomeOpen: null,
    awesomeFlowSort: 'published',
    awesomeFlowPage: 1,
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
  async function getJSON(url, label, options = {}) {
    const response = await fetch(url, { ...options, cache: 'no-store' });
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

  async function refreshModelScopeSnapshot() {
    try {
      const signal = AbortSignal.timeout(20000);
      const [latest, history] = await Promise.all([
        getJSON('./data/modelscope.json', 'ModelScope 数据', { signal }),
        getJSON('./data/modelscope_history.json', 'ModelScope 历史', { signal })
      ]);
      if ([latest, history].some(item => item?.schema_version !== 1 || item.author !== MODELSCOPE_AUTHOR || item.metric_source !== MODELSCOPE_SOURCE) ||
          !['ok', 'stale', 'unavailable'].includes(latest.status) || !Array.isArray(latest.models) ||
          latest.models.some(model => !msIdValid(model?.id) || !Array.isArray(model.tasks)) || !Array.isArray(history.snapshots) ||
          history.snapshots.some(snapshot => typeof snapshot?.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.date))) {
        throw new Error('ModelScope 快照格式或统计来源不兼容');
      }
      const snapshots = [...history.snapshots].sort((a, b) => a.date.localeCompare(b.date));
      const checkedAt = new Date().toISOString();
      state.modelscope = latest;
      state.modelscopeSnapshots = snapshots;
      state.modelscopeSource = 'snapshot';
      state.modelscopeSnapshotCapturedAt = latest.status === 'unavailable' ? null : latest.captured_at || null;
      state.modelscopeSnapshotCheckedAt = checkedAt;
      state.modelscopeSnapshotStatus = latest.status;
      state.modelscopeSnapshotError = latest.error || null;
      state.modelscopeSnapshotRefreshError = null;
      state.modelscopeRefreshError = null;
      if (state.modelscopeModel !== 'all' && !latest.models.some(model => model.id === state.modelscopeModel)) state.modelscopeModel = 'all';
      if (state.modelscopeTask !== 'all' && !latest.models.some(model => model.tasks.includes(state.modelscopeTask))) state.modelscopeTask = 'all';
      return latest;
    } catch (error) {
      state.modelscopeSnapshotRefreshError = error.name === 'TimeoutError' ? '读取已发布快照超时，请稍后重试' : error.message;
      throw new Error(state.modelscopeSnapshotRefreshError);
    }
  }

  async function loadModelScope() {
    try {
      await refreshModelScopeSnapshot();
    } catch (error) {
      if (!state.modelscope) {
        state.modelscope = { status: 'unavailable', author: MODELSCOPE_AUTHOR, models: [], error: error.message };
      }
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
      state.modelscopeRefreshError = error.name === 'TypeError'
        ? `网络或跨域限制（${error.message}），请使用已发布快照`
        : error.name === 'TimeoutError' ? '实时查询超时，请稍后重试或使用已发布快照' : error.message;
      throw new Error(state.modelscopeRefreshError);
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

  function modelscopeProfileSeries() {
    return state.modelscopeSnapshots.flatMap(snapshot => msCount(snapshot.profile_downloads) === null
      ? [] : [{ date: snapshot.date, value: snapshot.profile_downloads }]);
  }

  function modelscopeProfileDelta() {
    const [older, newer] = state.modelscopeSnapshots.slice(-2);
    const before = msCount(older?.profile_downloads), after = msCount(newer?.profile_downloads);
    if (before === null || after === null) return null;
    return { value: after - before, from: older.date, to: newer.date };
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

  // --- Conference deadlines -------------------------------------------------

  const CONFERENCE_SOURCE_ID = 'ccfddl';
  const CONFERENCE_PAGE_SIZE = 20;
  const WINDOW_DAYS = { 30: 30, 90: 90, 180: 180, 365: 365 };

  /** Flattened events stay cached until a new payload replaces the snapshot. */
  let conferenceIndex = null;

  function validateConferencePayload(payload) {
    if (payload?.schema_version !== 1 || payload?.source?.id !== CONFERENCE_SOURCE_ID ||
        !['ok', 'stale', 'unavailable'].includes(payload.status) || !Array.isArray(payload.conferences) ||
        payload.conferences.some(conference => typeof conference?.key !== 'string')) {
      throw new Error('会议快照格式或数据来源不兼容');
    }
    return payload;
  }

  /**
   * Re-read the published conference snapshot. The feed is refreshed by the
   * daily workflow, so a failure keeps the previous payload visible.
   */
  async function refreshConferenceSnapshot() {
    try {
      const payload = validateConferencePayload(await getJSON(
        './data/conferences.json', '会议快照', { signal: AbortSignal.timeout(20000) }));
      state.conferences = payload;
      state.conferenceSnapshotCheckedAt = new Date().toISOString();
      state.conferenceRefreshError = null;
      if (state.conferenceArea !== 'all' && !payload.conferences.some(item => item.area === state.conferenceArea)) {
        state.conferenceArea = 'all';
      }
      notify();
      return payload;
    } catch (error) {
      state.conferenceRefreshError = error.name === 'TimeoutError'
        ? '读取会议快照超时，请稍后重试' : error.message;
      throw new Error(state.conferenceRefreshError);
    }
  }

  async function loadConferences() {
    try {
      await refreshConferenceSnapshot();
    } catch (error) {
      if (!state.conferences) {
        state.conferences = { status: 'unavailable', source: { id: CONFERENCE_SOURCE_ID }, conferences: [], error: error.message };
      }
      console.warn('会议快照读取失败：', error);
    }
  }

  function conferenceEvents() {
    const payload = state.conferences;
    if (!Array.isArray(payload?.conferences)) return [];
    if (conferenceIndex && conferenceIndex.payload === payload) return conferenceIndex.rows;
    const rows = [];
    for (const conference of payload.conferences) {
      const rank = conference.rank || {};
      for (const edition of conference.editions || []) {
        for (const event of edition.events || []) {
          if (typeof event?.id !== 'string') continue;
          rows.push({
            id: event.id,
            kind: event.kind,
            round: event.round,
            comment: event.comment || '',
            tbd: event.tbd === true,
            source_local: event.source_local || '',
            timezone: event.timezone || '',
            offset_minutes: Number.isFinite(event.offset_minutes) ? event.offset_minutes : null,
            time_status: event.time_status || 'ok',
            utc: typeof event.utc === 'string' ? event.utc : null,
            ts: Date.parse(event.utc),
            key: conference.key,
            title: conference.title || conference.key,
            area: conference.area || '',
            ccf: rank.ccf || '',
            core: rank.core || '',
            edition: edition.id || '',
            year: Number.isFinite(edition.year) ? edition.year : null,
            date: edition.date || '',
            place: edition.place || '',
            url: /^https?:\/\/.+/i.test(edition.url || '') ? edition.url : null
          });
        }
      }
    }
    rows.sort((a, b) => (Number.isFinite(a.ts) ? a.ts : Infinity) - (Number.isFinite(b.ts) ? b.ts : Infinity) ||
      a.id.localeCompare(b.id));
    conferenceIndex = { payload, rows };
    return rows;
  }

  function conferenceAreas() {
    return [...new Set(conferenceEvents().map(row => row.area).filter(Boolean))].sort();
  }

  /** Rows for the current filters, soonest first (most recent first when past). */
  function conferenceRows(now = Date.now()) {
    const window = state.conferenceWindow;
    const search = state.conferenceSearch.trim().toLowerCase();
    const horizon = Object.hasOwn(WINDOW_DAYS, window) ? now + WINDOW_DAYS[window] * 86400000 : null;
    const rows = conferenceEvents().filter(row => {
      if (state.conferenceArea !== 'all' && row.area !== state.conferenceArea) return false;
      if (state.conferenceRank !== 'all' && row.ccf !== state.conferenceRank) return false;
      if (state.conferenceKind !== 'all' && row.kind !== state.conferenceKind) return false;
      if (window === 'tbd') {
        // Events without any usable instant would otherwise be invisible.
        if (!row.tbd && Number.isFinite(row.ts)) return false;
      } else if (window === 'past') {
        if (!Number.isFinite(row.ts) || row.ts >= now) return false;
      } else if (window === 'open') {
        if (!Number.isFinite(row.ts) || row.ts < now) return false;
      } else if (!Number.isFinite(row.ts) || row.ts < now || row.ts > horizon) return false;
      return !search || `${row.title} ${row.key} ${row.place} ${row.date}`.toLowerCase().includes(search);
    });
    const direction = window === 'past' ? -1 : 1;
    return rows.sort((a, b) => direction * (a.ts - b.ts) || a.id.localeCompare(b.id));
  }

  function conferencePageCount() {
    return Math.max(1, Math.ceil(conferenceRows().length / CONFERENCE_PAGE_SIZE));
  }

  function conferencePage(now = Date.now()) {
    const start = (Math.min(Math.max(1, state.conferencePage), conferencePageCount()) - 1) * CONFERENCE_PAGE_SIZE;
    return conferenceRows(now).slice(start, start + CONFERENCE_PAGE_SIZE);
  }

  /** Headline numbers, deliberately independent of the table filters. */
  function conferenceStats(now = Date.now()) {
    const stats = { events: 0, tbd: 0, paper30: 0, paper90: 0, next: null };
    for (const row of conferenceEvents()) {
      stats.events++;
      if (row.tbd) stats.tbd++;
      if (!Number.isFinite(row.ts) || row.ts < now) continue;
      if (row.kind === 'paper') {
        if (row.ts <= now + 30 * 86400000) stats.paper30++;
        if (row.ts <= now + 90 * 86400000) stats.paper90++;
      }
      if (!stats.next || row.ts < stats.next.ts) stats.next = row;
    }
    return stats;
  }

  // --- Starred repositories -------------------------------------------------

  const STAR_SOURCE_ID = 'github';
  const STAR_PAGE_SIZE = 24;
  const STAR_UNKNOWN_CLUSTER = 'lang:未知';
  /** Ring budgets for the graph: enough clusters to read, few enough to label. */
  const STAR_RINGS = { language: 10, topic: 22, owner: 10 };
  const STAR_EDGE_LIMIT = 120;

  // Module-level so `state` stays a plain serialisable object.
  let starDetailPromise = null;
  let starRowCache = null;
  let starFacetCache = null;
  let starWallCache = null;

  /** Cluster ids carry a short prefix (`lang:Python`); published nodes use the long type word. */
  const STAR_TYPE_BY_PREFIX = { lang: 'language', topic: 'topic', owner: 'owner' };

  function starClusterType(id) {
    const prefix = String(id).split(':')[0];
    return STAR_TYPE_BY_PREFIX[prefix] || prefix;
  }

  function validateStarSnapshot(payload) {
    if (payload?.schema_version !== 1 || payload?.source?.id !== STAR_SOURCE_ID ||
        !['ok', 'stale', 'unavailable'].includes(payload.status) ||
        !Array.isArray(payload.clusters) || !Array.isArray(payload.edges) ||
        payload.clusters.some(cluster => typeof cluster?.id !== 'string')) {
      throw new Error('star 快照格式或数据来源不兼容');
    }
    return payload;
  }

  /**
   * Re-read the published star graph. The wall itself needs the detail file and
   * is fetched lazily, so this snapshot alone already fills the KPIs and graph.
   */
  async function refreshStarSnapshot() {
    try {
      const payload = validateStarSnapshot(await getJSON(
        './data/stars.json', 'star 快照', { signal: AbortSignal.timeout(20000) }));
      state.stars = payload;
      state.starSnapshotCheckedAt = new Date().toISOString();
      state.starRefreshError = null;
      notify();
      return payload;
    } catch (error) {
      state.starRefreshError = error.name === 'TimeoutError'
        ? '读取 star 快照超时，请稍后重试' : error.message;
      throw new Error(state.starRefreshError);
    }
  }

  async function loadStars() {
    try {
      await refreshStarSnapshot();
    } catch (error) {
      if (!state.stars) {
        state.stars = { status: 'unavailable', source: { id: STAR_SOURCE_ID }, clusters: [], edges: [], error: error.message };
      }
      console.warn('star 快照读取失败：', error);
    }
  }

  /** Fetch the star detail rows once per payload; `force` retries a failure. */
  function ensureStarDetail(force = false) {
    if (state.starDetail && !force) return Promise.resolve(state.starDetail);
    if (starDetailPromise && !force) return starDetailPromise;
    state.starDetailStatus = 'loading';
    state.starDetailError = null;
    starDetailPromise = getJSON('./data/stars_repos.json', '仓库明细',
      { signal: AbortSignal.timeout(30000) })
      .then(payload => {
        if (payload?.schema_version !== 1 || !Array.isArray(payload.rows) ||
            payload.rows.some(row => typeof row?.n !== 'string')) {
          throw new Error('star 明细格式不完整');
        }
        state.starDetail = payload;
        state.starDetailStatus = 'ready';
        state.starDetailLoadedAt = payload.captured_at || new Date().toISOString();
        starDetailPromise = null;
        return payload;
      })
      .catch(error => {
        state.starDetailStatus = 'error';
        state.starDetailError = error.name === 'TimeoutError'
          ? '读取 star 明细超时，请重试' : error.message;
        starDetailPromise = null;
        return null;
      });
    return starDetailPromise;
  }

  function starRows() {
    const payload = state.starDetail;
    if (!Array.isArray(payload?.rows)) return [];
    if (starRowCache && starRowCache.payload === payload) return starRowCache.rows;
    const rows = payload.rows.map(row => ({
      name: row.n,
      owner: row.n.split('/', 1)[0],
      repo: row.n.split('/')[1] || row.n,
      url: `https://github.com/${row.n}`,
      language: typeof row.l === 'string' ? row.l : '',
      topics: Array.isArray(row.t) ? row.t : [],
      stars: Number.isFinite(row.s) ? row.s : null,
      description: typeof row.d === 'string' ? row.d : '',
      pushed: typeof row.p === 'string' ? row.p : null,
      fork: row.f === 1,
      archived: row.r === 1,
      org: row.o === 1,
      // The collector assigns each repository to one cluster; falling back to the
      // unknown node only covers a detail file older than the graph beside it.
      cluster: typeof row.c === 'string' && row.c ? row.c : STAR_UNKNOWN_CLUSTER
    }));
    starRowCache = { payload, rows };
    return rows;
  }

  function starClusters() {
    return (state.stars?.clusters || []).filter(cluster => cluster.repos);
  }

  function starLanguages() {
    const counts = new Map();
    starRows().forEach(row => {
      if (!row.language) return;
      counts.set(row.language, (counts.get(row.language) || 0) + 1);
    });
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([label, count]) => ({ label, count }));
  }

  function starTopics() {
    const counts = new Map();
    starRows().forEach(row => row.topics.forEach(topic =>
      counts.set(topic, (counts.get(topic) || 0) + 1)));
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([label, count]) => ({ label, count }));
  }

  function starFacets() {
    const payload = state.starDetail;
    if (starFacetCache && starFacetCache.payload === payload) return starFacetCache;
    starFacetCache = { payload, languages: starLanguages(), topics: starTopics() };
    return starFacetCache;
  }

  /** Rows for the current filters; `now` is injectable so tests stay deterministic. */
  function starFiltered(now = Date.now()) {
    const search = state.starSearch.trim().toLowerCase();
    const floor = new Date(now - 90 * 86400000).toISOString().slice(0, 10);
    const rows = starRows().filter(row => {
      if (state.starCluster !== 'all' && row.cluster !== state.starCluster) return false;
      if (state.starLanguage !== 'all' && row.language !== state.starLanguage) return false;
      if (state.starTopic !== 'all' && !row.topics.includes(state.starTopic)) return false;
      if (state.starStatus === 'archived' && !row.archived) return false;
      if (state.starStatus === 'fork' && !row.fork) return false;
      if (state.starStatus === 'undocumented' && row.description) return false;
      if (state.starStatus === 'maintained' && !(row.pushed && row.pushed >= floor)) return false;
      return !search || `${row.name} ${row.description} ${row.topics.join(' ')}`.toLowerCase().includes(search);
    });
    const sort = state.starSort;
    return rows.sort((a, b) => {
      if (sort === 'name') return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      if (sort === 'pushed') return String(b.pushed || '').localeCompare(String(a.pushed || ''));
      return (b.stars || 0) - (a.stars || 0);
    });
  }

  function starPageCount() {
    return Math.max(1, Math.ceil(starFiltered().length / STAR_PAGE_SIZE));
  }

  function starPage() {
    const start = (Math.min(Math.max(1, state.starPage), starPageCount()) - 1) * STAR_PAGE_SIZE;
    return starFiltered().slice(start, start + STAR_PAGE_SIZE);
  }

  /**
   * Headline numbers from the snapshot alone, so the board is filled before the
   * detail file arrives. `counts` is the collector's own summary.
   */
  function starStats() {
    const snapshot = state.stars || {};
    const counts = snapshot.counts || {};
    const total = Number.isFinite(counts.total) ? counts.total : 0;
    const active = Number.isFinite(counts.active_90d) ? counts.active_90d : 0;
    return {
      available: ['ok', 'stale'].includes(snapshot.status),
      total,
      active,
      activeShare: total ? active / total : null,
      languages: counts.languages || 0,
      topics: counts.topics || 0,
      owners: counts.owners || 0,
      orgOwned: counts.org_owned || 0,
      archived: counts.archived || 0,
      forks: counts.forks || 0,
      undocumented: counts.undocumented || 0,
      pages: snapshot.pages || 0,
      expected: Number.isFinite(snapshot.expected_total) ? snapshot.expected_total : null,
      changes: snapshot.changes || null,
      clusters: starClusters().length,
      publishedClusters: (snapshot.clusters || []).length,
      edges: (snapshot.edges || []).length
    };
  }

  /** Every starred repository as one cell, grouped by cluster in wall order. */
  function starWall() {
    const payload = state.starDetail;
    const snapshot = state.stars;
    if (starWallCache && starWallCache.payload === payload && starWallCache.snapshot === snapshot) {
      return starWallCache.model;
    }
    const groups = starClusters().map(cluster => ({
      id: cluster.id,
      label: cluster.label || cluster.id,
      type: cluster.type,
      appears: cluster.appears || 0,
      members: []
    }));
    const byId = new Map(groups.map(group => [group.id, group]));
    starRows().forEach(row => {
      // A detail file can outlive the snapshot beside it, so an unknown cluster
      // id still needs a group — created once per id, not once per repository.
      let group = byId.get(row.cluster);
      if (!group) {
        group = { id: row.cluster, label: row.cluster.split(':').slice(1).join(':') || row.cluster,
          type: starClusterType(row.cluster), appears: 0, members: [] };
        byId.set(group.id, group);
        groups.push(group);
      }
      group.members.push(row);
    });
    const kept = groups.filter(group => group.members.length);
    kept.forEach(group => group.members.sort((a, b) =>
      (b.stars || 0) - (a.stars || 0) || a.name.toLowerCase().localeCompare(b.name.toLowerCase())));
    kept.sort((a, b) => b.members.length - a.members.length || a.id.localeCompare(b.id));
    let offset = 0;
    const cells = [];
    for (const group of kept) {
      group.start = offset;
      group.count = group.members.length;
      group.members.forEach(row => {
        cells.push({ name: row.name, stars: row.stars, language: row.language, cluster: group.id });
        offset++;
      });
      delete group.members;
    }
    const model = { cells, groups: kept, total: cells.length };
    starWallCache = { payload, snapshot, model };
    return model;
  }

  /**
   * Nodes and edges for the ring graph. The snapshot publishes more clusters than
   * a readable graph can hold, so each type keeps a budget of the largest clusters
   * and the report says how many were left out.
   */
  function starGraph() {
    const snapshot = state.stars || {};
    const ranked = [...starClusters()].sort((a, b) => b.repos - a.repos || a.id.localeCompare(b.id));
    const taken = {};
    const nodes = [];
    for (const cluster of ranked) {
      // A type the chart cannot place gets no ring, so it must not slip past the
      // budget check and steal node slots; the note reports it as hidden.
      const budget = STAR_RINGS[cluster.type];
      if (!budget || (taken[cluster.type] || 0) >= budget) continue;
      taken[cluster.type] = (taken[cluster.type] || 0) + 1;
      nodes.push({ id: cluster.id, label: cluster.label || cluster.id, type: cluster.type,
        repos: cluster.repos, appears: cluster.appears || 0 });
    }
    const ids = new Set(nodes.map(node => node.id));
    const edges = (snapshot.edges || [])
      .filter(edge => ids.has(edge.a) && ids.has(edge.b) && Number.isFinite(edge.w))
      .slice(0, STAR_EDGE_LIMIT);
    const hidden = ranked.length - nodes.length;
    return { nodes, edges, hidden, missing: Math.max(0, ((snapshot.edges || []).length) - edges.length) };
  }

  // --- Entity registry ------------------------------------------------------

  const ENTITY_SOURCE_ID = 'registry';
  const ENTITY_PAGE_SIZE = 8;
  const ENTITY_LINK_STATES = ['resolved', 'unresolved', 'unchecked', 'out_of_scope'];
  /** Registry stages that still expect work; `shipped` and `archived` are finished. */
  const ENTITY_ACTIVE_STAGES = ['proposal', 'training', 'evaluating', 'submitting'];

  // The index is rebuilt per payload so a refresh cannot mix two snapshots.
  let entityRowCache = null;
  let entityIndexCache = null;

  function validateEntitySnapshot(payload) {
    if (payload?.schema_version !== 1 || payload?.source?.id !== ENTITY_SOURCE_ID ||
        !['ok', 'stale', 'unavailable'].includes(payload.status) || !Array.isArray(payload.entries) ||
        payload.entries.some(entry => typeof entry?.slug !== 'string')) {
      throw new Error('注册表快照格式或数据来源不兼容');
    }
    return payload;
  }

  /**
   * Re-read the published registry index. The collector runs in the daily
   * workflow, so this never asks the registry to change - the board is read-only.
   */
  async function refreshEntitySnapshot() {
    try {
      const payload = validateEntitySnapshot(await getJSON(
        './data/entities.json', '实体注册表', { signal: AbortSignal.timeout(20000) }));
      state.entities = payload;
      state.entitySnapshotCheckedAt = new Date().toISOString();
      state.entityRefreshError = null;
      notify();
      return payload;
    } catch (error) {
      state.entityRefreshError = error.name === 'TimeoutError'
        ? '读取实体注册表超时，请稍后重试' : error.message;
      throw new Error(state.entityRefreshError);
    }
  }

  async function loadEntities() {
    try {
      await refreshEntitySnapshot();
    } catch (error) {
      if (!state.entities) {
        state.entities = { status: 'unavailable', source: { id: ENTITY_SOURCE_ID }, entries: [], error: error.message };
      }
      console.warn('实体注册表快照读取失败：', error);
    }
  }

  /**
   * Published entries with their link states. Only the url fields are re-checked
   * here: the page must not offer a link the collector could not vouch for.
   */
  function entityEntries() {
    const payload = state.entities;
    if (!Array.isArray(payload?.entries)) return [];
    if (entityRowCache && entityRowCache.payload === payload) return entityRowCache.rows;
    const rows = payload.entries.map(entry => ({
      slug: entry.slug,
      title: typeof entry.title === 'string' && entry.title ? entry.title : entry.slug,
      kind: typeof entry.kind === 'string' ? entry.kind : '',
      stage: typeof entry.stage === 'string' ? entry.stage : '',
      tags: (Array.isArray(entry.tags) ? entry.tags : []).filter(tag => typeof tag === 'string'),
      updated: typeof entry.updated === 'string' ? entry.updated : '',
      url: /^https?:\/\/.+/i.test(entry.url || '') ? entry.url : null,
      body: typeof entry.body === 'string' ? entry.body : '',
      bytes: Number.isFinite(entry.bytes) ? entry.bytes : null,
      lines: Number.isFinite(entry.lines) ? entry.lines : null,
      sha: typeof entry.sha256 === 'string' ? entry.sha256 : '',
      // The git blob SHA of the whole source file: the write-back panel compares
      // it against the live one to tell "the page is stale" from "someone edited".
      blobSha: typeof entry.blob_sha === 'string' ? entry.blob_sha : '',
      truncated: entry.truncated === true,
      links: (Array.isArray(entry.links) ? entry.links : [])
        .filter(link => typeof link?.domain === 'string' && typeof link?.id === 'string')
        .map(link => ({
          domain: link.domain,
          id: link.id,
          key: `${link.domain}:${link.id}`,
          // A state the collector did not publish is a gap it could not prove,
          // so it reads as 未核对 rather than silently becoming 已核对.
          state: ENTITY_LINK_STATES.includes(link.state) ? link.state : 'unchecked',
          url: /^https?:\/\/.+/i.test(link.url || '') ? link.url : null
        }))
    }));
    entityRowCache = { payload, rows };
    return rows;
  }

  /** `domain:id` -> the entries that reference it: the reverse side of the board. */
  function entityIndex() {
    const payload = state.entities;
    if (entityIndexCache && entityIndexCache.payload === payload) return entityIndexCache.map;
    const map = new Map();
    for (const entry of entityEntries()) {
      for (const link of entry.links) {
        if (!map.has(link.key)) map.set(link.key, { key: link.key, domain: link.domain, id: link.id,
          state: link.state, url: link.url, entries: [] });
        const group = map.get(link.key);
        group.entries.push({ slug: entry.slug, title: entry.title });
        // Several entries can share one object; the object is checked once, so
        // every listing carries the same state and the first url is enough.
        if (!group.url && link.url) group.url = link.url;
      }
    }
    entityIndexCache = { payload, map };
    return map;
  }

  /** Every object the registry mentions, busiest first, for the reverse lookup. */
  function entityObjects() {
    return [...entityIndex().values()].sort((a, b) =>
      b.entries.length - a.entries.length || a.key.localeCompare(b.key));
  }

  function entityReferences(key) {
    return entityIndex().get(key)?.entries || [];
  }

  /** Links the reader has to look at: a dead id or a source we could not check. */
  function entityProblems() {
    const problems = [];
    for (const entry of entityEntries()) {
      for (const link of entry.links) {
        if (link.state === 'resolved') continue;
        problems.push({ slug: entry.slug, title: entry.title, domain: link.domain, id: link.id,
          key: link.key, state: link.state, url: link.url });
      }
    }
    const rank = state => (state === 'unresolved' ? 0 : state === 'unchecked' ? 1 : 2);
    return problems.sort((a, b) => rank(a.state) - rank(b.state) || a.slug.localeCompare(b.slug) ||
      a.key.localeCompare(b.key));
  }

  /** Per source: how much of our own published output the registry mentions. */
  function entityCoverage() {
    const payload = state.entities || {};
    const sources = payload.sources || {};
    return Object.entries(payload.coverage || {}).map(([domain, row]) => ({
      domain,
      available: row?.available === true,
      total: Number.isFinite(row?.total) ? row.total : 0,
      registered: Number.isFinite(row?.registered) ? row.registered : 0,
      missing: (Array.isArray(row?.unregistered) ? row.unregistered : []).filter(id => typeof id === 'string'),
      missingCount: Number.isFinite(row?.unregistered_count) ? row.unregistered_count : 0,
      truncated: row?.truncated === true,
      reason: typeof sources[domain]?.reason === 'string' ? sources[domain].reason : null,
      capturedAt: sources[domain]?.captured_at || null
    })).sort((a, b) => b.total - a.total || a.domain.localeCompare(b.domain));
  }

  /**
   * Headline numbers come from the collector's own summary and validation, so a
   * partially loaded board never restates a count the daily run disagrees with.
   */
  function entityStats() {
    const payload = state.entities || {};
    const summary = payload.summary || {};
    const validation = payload.validation || {};
    const byStage = summary.by_stage || {};
    const active = ENTITY_ACTIVE_STAGES.reduce((sum, stage) => sum + (byStage[stage] || 0), 0);
    const coverage = entityCoverage().filter(row => row.available);
    const total = coverage.reduce((sum, row) => sum + row.total, 0);
    const registered = coverage.reduce((sum, row) => sum + row.registered, 0);
    return {
      available: ['ok', 'stale'].includes(payload.status),
      total: Number.isFinite(summary.total) ? summary.total : entityEntries().length,
      links: Number.isFinite(summary.links) ? summary.links : entityEntries().reduce((sum, row) => sum + row.links.length, 0),
      resolved: validation.resolved || 0,
      unresolved: validation.unresolved || 0,
      unchecked: validation.unchecked || 0,
      out_of_scope: validation.out_of_scope || 0,
      problems: (validation.unresolved || 0) + (validation.unchecked || 0),
      objects: entityObjects().length,
      active,
      coverage: { registered, total, sources: coverage.length },
      // A source we publish nothing for is not a gap to fill, so it stays out of
      // the headline and the panel explains it instead.
      gaps: coverage.filter(row => row.total > 0 && row.registered === 0).map(row => row.domain),
      warnings: (payload.warnings || []).length,
      errors: (payload.structural_errors || []).length
    };
  }

  /** Filter values the entries actually offer, so no select lists a dead choice. */
  function entityFacets() {
    const counts = key => {
      const tally = new Map();
      entityEntries().forEach(entry => {
        const value = entry[key] || 'none';
        tally.set(value, (tally.get(value) || 0) + 1);
      });
      return [...tally].map(([value, count]) => ({ value, count }));
    };
    const tags = new Map();
    entityEntries().forEach(entry => entry.tags.forEach(tag => tags.set(tag, (tags.get(tag) || 0) + 1)));
    return {
      kinds: counts('kind'),
      stages: counts('stage'),
      tags: [...tags].map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    };
  }

  /** Entries for the current filters; `entityObject` is the reverse lookup. */
  function entityFiltered() {
    const search = state.entitySearch.trim().toLowerCase();
    const wantedKind = state.entityKind === 'all' ? null : state.entityKind;
    const wantedStage = state.entityStage === 'all' ? null : state.entityStage;
    const rows = entityEntries().filter(entry => {
      if (wantedKind && (entry.kind || 'none') !== wantedKind) return false;
      if (wantedStage && (entry.stage || 'none') !== wantedStage) return false;
      if (state.entityTag !== 'all' && !entry.tags.includes(state.entityTag)) return false;
      if (state.entityObject !== 'all' && !entry.links.some(link => link.key === state.entityObject)) return false;
      const linkFilter = state.entityLink;
      if (linkFilter === 'problem' && entry.links.every(link => link.state === 'resolved')) return false;
      if (linkFilter !== 'all' && linkFilter !== 'problem' &&
          !entry.links.some(link => link.state === linkFilter)) return false;
      if (!search) return true;
      const haystack = [entry.title, entry.slug, entry.tags.join(' '), entry.body,
        entry.links.map(link => `${link.domain} ${link.id}`).join(' ')].join(' ').toLowerCase();
      return haystack.includes(search);
    });
    const sort = state.entitySort;
    if (sort === 'links') return rows.sort((a, b) => b.links.length - a.links.length || a.slug.localeCompare(b.slug));
    if (sort === 'name') return rows.sort((a, b) => a.title.localeCompare(b.title) || a.slug.localeCompare(b.slug));
    return rows.sort((a, b) => b.updated.localeCompare(a.updated) || a.slug.localeCompare(b.slug));
  }

  function entityPageCount() {
    return Math.max(1, Math.ceil(entityFiltered().length / ENTITY_PAGE_SIZE));
  }

  function entityPage() {
    const start = (Math.min(Math.max(1, state.entityPage), entityPageCount()) - 1) * ENTITY_PAGE_SIZE;
    return entityFiltered().slice(start, start + ENTITY_PAGE_SIZE);
  }

  // --- Task board -----------------------------------------------------------

  const TASK_SOURCE_ID = 'tasks';
  const TASK_REF_STATES = ['resolved', 'unresolved', 'missing_index'];
  const TASK_PAGE_SIZE = 12;

  let taskRowCache = null;

  function validateTaskSnapshot(payload) {
    if (payload?.schema_version !== 1 || payload?.source?.id !== TASK_SOURCE_ID ||
        !['ok', 'stale', 'unavailable'].includes(payload.status) || !Array.isArray(payload.tasks) ||
        payload.tasks.some(task => typeof task?.slug !== 'string')) {
      throw new Error('任务看板快照格式或数据来源不兼容');
    }
    return payload;
  }

  /**
   * Re-read the published board. The collector runs in the daily workflow, so
   * this never touches `tasks/` - the canvas follows the repository, not the
   * other way round.
   */
  async function refreshTaskSnapshot() {
    try {
      const payload = validateTaskSnapshot(await getJSON(
        './data/tasks.json', '任务看板', { signal: AbortSignal.timeout(20000) }));
      state.tasks = payload;
      state.taskSnapshotCheckedAt = new Date().toISOString();
      state.taskRefreshError = null;
      notify();
      return payload;
    } catch (error) {
      state.taskRefreshError = error.name === 'TimeoutError'
        ? '读取任务看板超时，请稍后重试' : error.message;
      throw new Error(state.taskRefreshError);
    }
  }

  /** The board sits below the fold, so first paint does not ask for it. */
  async function loadTasks() {
    try {
      await refreshTaskSnapshot();
    } catch (error) {
      if (!state.tasks) {
        state.tasks = { status: 'unavailable', source: { id: TASK_SOURCE_ID }, tasks: [],
                        graph: { edges: [], dropped: [] }, error: error.message };
      }
      console.warn('任务看板快照读取失败：', error);
    }
  }

  /**
   * Published tasks, shaped for the canvas. A status the collector could not
   * read arrives as null - that card belongs to the 未标注 lane rather than to
   * whichever lane happens to be first.
   */
  function taskRows() {
    const payload = state.tasks;
    if (!Array.isArray(payload?.tasks)) return [];
    if (taskRowCache && taskRowCache.payload === payload) return taskRowCache.rows;
    const rows = payload.tasks.map(task => ({
      slug: task.slug,
      title: typeof task.title === 'string' && task.title ? task.title : task.slug,
      status: typeof task.status === 'string' ? task.status : null,
      parent: typeof task.parent === 'string' && task.parent ? task.parent : null,
      depends: (Array.isArray(task.depends) ? task.depends : [])
        .filter(item => typeof item === 'string'),
      tags: (Array.isArray(task.tags) ? task.tags : []).filter(tag => typeof tag === 'string'),
      entity: typeof task.entity === 'string' && task.entity ? task.entity : null,
      ddl: typeof task.ddl === 'string' && task.ddl ? task.ddl : null,
      // The collector's own verdict, kept separate from the id so an unchecked
      // reference never renders as a resolved one.
      entityState: TASK_REF_STATES.includes(task.entity_state) ? task.entity_state : null,
      ddlState: TASK_REF_STATES.includes(task.ddl_state) ? task.ddl_state : null,
      updated: typeof task.updated === 'string' ? task.updated : '',
      reason: typeof task.reason === 'string' ? task.reason : '',
      url: /^https?:\/\/.+/i.test(task.url || '') ? task.url : null,
      body: typeof task.body === 'string' ? task.body : '',
      bytes: Number.isFinite(task.bytes) ? task.bytes : null,
      lines: Number.isFinite(task.lines) ? task.lines : null,
      sha: typeof task.sha256 === 'string' ? task.sha256 : '',
      blobSha: typeof task.blob_sha === 'string' ? task.blob_sha : '',
      truncated: task.truncated === true
    }));
    taskRowCache = { payload, rows };
    return rows;
  }

  function taskSource(name) {
    const source = (state.tasks?.sources || {})[name] || {};
    return {
      name,
      file: source.file || `${name}.json`,
      available: source.available === true,
      capturedAt: source.captured_at || null,
      reason: typeof source.reason === 'string' ? source.reason : null
    };
  }

  /**
   * The deadline a card points at, resolved against the conference board. Only
   * the id is stored in `tasks/`; the instant and the countdown belong to
   * conferences.json, so a card that needs one asks for it here rather than
   * carrying a copy that would go stale on its own schedule.
   */
  function taskDeadline(id, now = Date.now()) {
    if (!id) return null;
    const source = taskSource('ddl');
    const event = conferenceEvents().find(row => row.id === id);
    if (!event) {
      return { id, found: false, available: source.available, reason: source.reason, capturedAt: source.capturedAt };
    }
    return {
      id, found: true, kind: event.kind, conference: event.title, edition: event.edition,
      utc: event.utc, ts: Number.isFinite(event.ts) ? event.ts : null,
      tbd: event.tbd === true, ccf: event.ccf, url: event.url,
      countdown: MO.format.countdown(event.utc, now), tone: MO.format.deadlineTone(event.utc, now),
      capturedAt: source.capturedAt
    };
  }

  /** The registry entry a task serves, if the registry knows that slug at all. */
  function taskEntity(slug) {
    if (!slug) return null;
    const source = taskSource('entity');
    const entry = entityEntries().find(row => row.slug === slug);
    return {
      slug, found: Boolean(entry), title: entry?.title || slug, url: entry?.url || null,
      available: source.available, reason: source.reason
    };
  }

  /** Edges and refusals as the daily run published them - the verified side of the graph. */
  function taskGraph() {
    const graph = state.tasks?.graph || {};
    return {
      edges: Array.isArray(graph.edges) ? graph.edges : [],
      dropped: Array.isArray(graph.dropped) ? graph.dropped : [],
      truncated: graph.truncated === true
    };
  }

  /** Headline numbers come from the collector's own summary and validation. */
  function taskStats() {
    const payload = state.tasks || {};
    const summary = payload.summary || {};
    const validation = payload.validation || {};
    const refs = validation.refs || {};
    const rows = taskRows();
    const byStatus = summary.by_status || {};
    return {
      available: ['ok', 'stale'].includes(payload.status),
      total: Number.isFinite(summary.total) ? summary.total : rows.length,
      edges: Number.isFinite(summary.edges) ? summary.edges : taskGraph().edges.length,
      roots: Number.isFinite(summary.roots) ? summary.roots : rows.filter(row => !row.parent).length,
      blocked: Number.isFinite(summary.blocked) ? summary.blocked : 0,
      byStatus,
      untriaged: rows.filter(row => !row.status).length,
      broken: (validation.parent_missing || 0) + (validation.depends_missing || 0),
      cycles: (validation.cycles || 0) + (validation.self_edges || 0),
      refs: {
        entity: { resolved: refs.entity?.resolved || 0, unresolved: refs.entity?.unresolved || 0,
                  unchecked: refs.entity?.missing_index || 0 },
        ddl: { resolved: refs.ddl?.resolved || 0, unresolved: refs.ddl?.unresolved || 0,
               unchecked: refs.ddl?.missing_index || 0 }
      },
      warnings: (payload.warnings || []).length,
      errors: (payload.structural_errors || []).length
    };
  }

  function taskFacets() {
    const tags = new Map();
    taskRows().forEach(task => task.tags.forEach(tag => tags.set(tag, (tags.get(tag) || 0) + 1)));
    return [...tags].map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  }

  /** Search, tag and reference-state filters, shared by the canvas and the list. */
  function taskFiltered(source = null) {
    const search = state.taskSearch.trim().toLowerCase();
    const pool = source || taskRows();
    const items = pool.filter(task => {
      if (state.taskTag !== 'all' && !task.tags.includes(state.taskTag)) return false;
      const wanted = state.taskRef;
      // 断引用 counts a missing parent against the pool the canvas is showing, so
      // a draft card that only exists here still resolves as a real target.
      if (wanted === 'broken' && !(task.entityState === 'unresolved' || task.ddlState === 'unresolved' ||
          (task.parent && !pool.some(row => row.slug === task.parent)))) return false;
      if (wanted === 'unchecked' && !(task.entityState === 'missing_index' || task.ddlState === 'missing_index')) return false;
      if (wanted === 'ddl' && !task.ddl) return false;
      if (wanted === 'orphan' && task.parent) return false;
      if (!search) return true;
      return [task.title, task.slug, task.tags.join(' '), task.body, task.entity, task.ddl,
        task.parent, task.depends.join(' '), task.reason].join(' ').toLowerCase().includes(search);
    });
    return sortTasks(items, state.taskSort);
  }

  function sortTasks(items, sort) {
    if (sort === 'status') {
      const order = ['blocked', 'doing', 'review', 'proposal', 'done', 'dropped'];
      return items.slice().sort((a, b) =>
        (order.indexOf(a.status) < 0 ? order.length : order.indexOf(a.status)) -
        (order.indexOf(b.status) < 0 ? order.length : order.indexOf(b.status)) ||
        a.slug.localeCompare(b.slug));
    }
    if (sort === 'ddl') {
      return items.slice().sort((a, b) => {
        const left = a.ddl ? Date.parse(taskDeadline(a.ddl)?.utc || '') : Infinity;
        const right = b.ddl ? Date.parse(taskDeadline(b.ddl)?.utc || '') : Infinity;
        return (left - right) || a.slug.localeCompare(b.slug);
      });
    }
    if (sort === 'name') return items.slice().sort((a, b) => a.title.localeCompare(b.title) || a.slug.localeCompare(b.slug));
    return items.slice().sort((a, b) => String(b.updated).localeCompare(String(a.updated)) || a.slug.localeCompare(b.slug));
  }

  function taskPageCount() {
    return Math.max(1, Math.ceil(taskFiltered().length / TASK_PAGE_SIZE));
  }

  function taskPage() {
    const start = (Math.min(Math.max(1, state.taskPage), taskPageCount()) - 1) * TASK_PAGE_SIZE;
    return taskFiltered().slice(start, start + TASK_PAGE_SIZE);
  }

  // --- Paper-list tracking --------------------------------------------------

  const AWESOME_SOURCE_ID = 'awesome';
  const AWESOME_REPO_STATES = ['ok', 'stale', 'unavailable'];
  const AWESOME_FLOW_PAGE_SIZE = 25;
  const AWESOME_URL_RE = /^https?:\/\/[^\s"'<>\\]+$/i;

  // Normalised once per payload: a refresh must never mix two snapshots.
  let awesomeRowCache = null;

  /** An absent measurement stays null; only the collector's own zeros are zeros. */
  const awesomeCount = value => (Number.isFinite(value) ? value : null);
  const awesomeFlag = value => (value === true);
  const awesomeUrl = value => (AWESOME_URL_RE.test(String(value || '')) ? String(value) : null);

  function validateAwesomeSnapshot(payload) {
    if (payload?.schema_version !== 1 || payload?.source?.id !== AWESOME_SOURCE_ID ||
        !['ok', 'partial', 'stale', 'unavailable'].includes(payload.status) ||
        !Array.isArray(payload.repos) ||
        payload.repos.some(repo => typeof repo?.id !== 'string')) {
      throw new Error('清单跟踪快照格式或数据来源不兼容');
    }
    return payload;
  }

  /**
   * Re-read the published snapshot. The collector runs in the daily workflow,
   * so this never fetches a repository - the board reports what was counted,
   * not what the reader wishes were current.
   */
  async function refreshAwesomeSnapshot() {
    try {
      const payload = validateAwesomeSnapshot(await getJSON(
        './data/awesome.json', '论文清单跟踪', { signal: AbortSignal.timeout(20000) }));
      state.awesome = payload;
      state.awesomeSnapshotCheckedAt = new Date().toISOString();
      state.awesomeRefreshError = null;
      notify();
      return payload;
    } catch (error) {
      state.awesomeRefreshError = error.name === 'TimeoutError'
        ? '读取论文清单快照超时，请稍后重试' : error.message;
      throw new Error(state.awesomeRefreshError);
    }
  }

  /** Six repositories are crawled daily, but only this board needs their rows. */
  async function loadAwesome() {
    try {
      await refreshAwesomeSnapshot();
    } catch (error) {
      if (!state.awesome) {
        state.awesome = { status: 'unavailable', source: { id: AWESOME_SOURCE_ID }, repos: [],
                          summary: {}, error: error.message };
      }
      console.warn('论文清单跟踪快照读取失败：', error);
    }
    await loadAwesomeHistory();
  }

  /**
   * The daily series is a second file and a second failure: a missing history
   * costs the trend line and nothing else, so it never marks the board stale.
   */
  async function loadAwesomeHistory(stamp) {
    try {
      const payload = await getJSON(`./data/awesome_history.json${stamp ? `?t=${stamp}` : ''}`,
        '清单跟踪历史', { signal: AbortSignal.timeout(20000) });
      if (payload?.schema_version !== 1 || payload?.source?.id !== AWESOME_SOURCE_ID ||
          !Array.isArray(payload.snapshots)) {
        throw new Error('清单跟踪历史格式或数据来源不兼容');
      }
      state.awesomeHistory = payload.snapshots
        .filter(row => typeof row?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.date))
        .map(row => ({
          date: row.date,
          capturedAt: typeof row.captured_at === 'string' ? row.captured_at : null,
          repos: awesomeCount(row.repos),
          tracked: awesomeCount(row.tracked),
          entriesMeasured: awesomeCount(row.entries_measured),
          entriesUpstream: awesomeCount(row.entries_upstream),
          added: awesomeCount(row.added),
          removed: awesomeCount(row.removed),
          stalled: awesomeCount(row.stalled),
          // A day that read fewer lists than are tracked published carried numbers;
          // a flat stretch there means "we did not look", not "nothing changed".
          partial: awesomeCount(row.tracked) !== null && awesomeCount(row.repos) !== null &&
            row.repos < row.tracked
        }))
        .sort((a, b) => a.date.localeCompare(b.date));
      state.awesomeHistoryRetention = payload.retention || null;
    } catch (error) {
      state.awesomeHistory = null;
      state.awesomeHistoryError = error.name === 'TimeoutError'
        ? '读取清单跟踪历史超时' : error.message;
      console.warn('清单跟踪历史读取失败：', error);
    }
  }

  /**
   * The trend needs three points before a slope means anything: two draw a
   * straight line no matter what happened between them.
   */
  function awesomeTrend() {
    const snapshots = state.awesomeHistory || [];
    const series = key => snapshots
      .filter(row => Number.isFinite(row[key]))
      .map(row => ({ date: row.date, value: row[key] }));
    const measured = series('entriesMeasured');
    const points = snapshots.filter(row => Number.isFinite(row.entriesMeasured) &&
      Number.isFinite(row.entriesUpstream));
    return {
      snapshots,
      measured,
      upstream: series('entriesUpstream'),
      readable: series('repos'),
      enough: measured.length >= 3,
      partialDays: snapshots.filter(row => row.partial).length,
      first: measured.length ? measured[0] : null,
      last: measured.length ? measured.at(-1) : null,
      netChange: measured.length >= 2 ? measured.at(-1).value - measured[0].value : null,
      // Summing the daily `added` would double-count a carried day as zero and a
      // re-read as new growth; the series only says what the two ends differ by.
      addedDays: points.filter(row => row.added > 0).length
    };
  }

  /**
   * One repository row, with the two numbers that must never be merged kept
   * apart: `measured` is what this collector counted today, `selfReported` is
   * what the repository says about itself.
   */
  function awesomeRows() {
    const payload = state.awesome;
    if (!Array.isArray(payload?.repos)) return [];
    if (awesomeRowCache && awesomeRowCache.payload === payload) return awesomeRowCache.rows;
    const rows = payload.repos.map(repo => {
      const measured = repo.measured || {};
      const reported = repo.self_reported || null;
      const cadence = repo.cadence || {};
      const diff = repo.diff || {};
      return {
        id: repo.id,
        name: String(repo.id).split('/').slice(1).join('/') || String(repo.id),
        kind: typeof repo.kind === 'string' ? repo.kind : '',
        upstream: awesomeFlag(repo.upstream),
        status: AWESOME_REPO_STATES.includes(repo.status) ? repo.status : 'unavailable',
        notAttempted: awesomeFlag(repo.not_attempted),
        error: typeof repo.error === 'string' ? repo.error : null,
        capturedAt: typeof repo.captured_at === 'string' ? repo.captured_at : null,
        lastAttemptAt: typeof repo.last_attempt_at === 'string' ? repo.last_attempt_at : null,
        measured: {
          entries: awesomeCount(measured.entries),
          withArxiv: awesomeCount(measured.with_arxiv),
          withCode: awesomeCount(measured.with_code),
          withDate: awesomeCount(measured.with_date),
          withVenue: awesomeCount(measured.with_venue),
          uniqueIds: awesomeCount(measured.unique_ids),
          sections: awesomeCount(measured.sections),
          skipped: awesomeCount(measured.skipped),
          duplicatedRows: awesomeCount(measured.duplicated_rows),
          topics: awesomeCount(measured.topics),
          topicsReporting: awesomeCount(measured.topics_reporting),
          topicsUnreadable: awesomeCount(measured.topics_unreadable),
          topicsAtNewest: awesomeCount(measured.topics_at_newest_month),
          topicsNotAttempted: awesomeCount(measured.topics_not_attempted),
          monthsSampled: awesomeCount(measured.months_sampled),
          newestMonth: typeof measured.newest_month === 'string' ? measured.newest_month : null,
          newestMonthAgeDays: awesomeCount(measured.newest_month_age_days),
          recent: measured.recent && typeof measured.recent === 'object' ? {
            within90d: awesomeCount(measured.recent.within_90d),
            within365d: awesomeCount(measured.recent.within_365d),
            older: awesomeCount(measured.recent.older),
            undated: awesomeCount(measured.recent.undated)
          } : null,
          datePrecision: measured.date_precision && typeof measured.date_precision === 'object'
            ? measured.date_precision : null,
          skippedNoTitle: awesomeCount(measured.skipped_no_title),
          skippedNoLink: awesomeCount(measured.skipped_no_link),
          skippedNoSignal: awesomeCount(measured.skipped_no_signal),
          unlinkedRows: awesomeCount(measured.unlinked_rows),
          byteCapped: awesomeFlag(measured.byte_capped),
          note: typeof measured.note === 'string' ? measured.note : null,
          files: (Array.isArray(measured.files) ? measured.files : []).map(file => ({
            path: typeof file?.path === 'string' ? file.path : '',
            bytes: awesomeCount(file?.bytes),
            lines: awesomeCount(file?.lines),
            rows: awesomeCount(file?.rows),
            truncated: awesomeFlag(file?.truncated),
            sha: typeof file?.sha256 === 'string' ? file.sha256 : null
          }))
        },
        selfReported: reported ? {
          file: typeof reported.file === 'string' ? reported.file : null,
          entries: awesomeCount(reported.entries),
          values: Array.isArray(reported.values) ? reported.values.filter(Number.isFinite) : [],
          generatedAt: typeof reported.generated_at === 'string' ? reported.generated_at : null,
          monthsSampled: awesomeCount(reported.months_sampled),
          extra: {
            inDocs: awesomeCount(reported.in_docs),
            new7d: awesomeCount(reported.new_7d),
            last30d: awesomeCount(reported.last_30d),
            reposTotal: awesomeCount(reported.repos_total),
            reposStars: awesomeCount(reported.repos_stars_total)
          },
          note: typeof reported.note === 'string' ? reported.note : null
        } : null,
        cadence: {
          state: typeof cadence.status === 'string' ? cadence.status : 'unknown',
          lastCommitAt: typeof cadence.last_file_commit_at === 'string'
            ? cadence.last_file_commit_at : null,
          author: typeof cadence.author === 'string' ? cadence.author : null,
          isBot: typeof cadence.is_bot === 'boolean' ? cadence.is_bot : null,
          message: typeof cadence.message === 'string' ? cadence.message : null,
          cadence: typeof cadence.cadence === 'string' ? cadence.cadence : null,
          staleDays: awesomeCount(cadence.stale_days),
          stalled: awesomeFlag(cadence.stalled),
          commitsSeen: awesomeCount(cadence.commits_seen)
        },
        diff: {
          baseline: awesomeFlag(diff.baseline),
          added: awesomeCount(diff.added),
          removed: awesomeCount(diff.removed),
          held: awesomeCount(diff.held),
          truncated: awesomeFlag(diff.truncated),
          rollingWindow: awesomeFlag(diff.rolling_window),
          note: typeof diff.note === 'string' ? diff.note : null
        },
        sample: (Array.isArray(repo.sample) ? repo.sample : []).map(entry => ({
          id: typeof entry?.id === 'string' ? entry.id : '',
          title: typeof entry?.title === 'string' ? entry.title : '',
          url: awesomeUrl(entry?.url),
          arxivId: typeof entry?.arxiv_id === 'string' ? entry.arxiv_id : null,
          published: typeof entry?.published === 'string' ? entry.published : null,
          venue: typeof entry?.venue === 'string' ? entry.venue : null,
          section: typeof entry?.section === 'string' ? entry.section : null,
          isNew: awesomeFlag(entry?.is_new)
        })),
        categories: (Array.isArray(repo.categories) ? repo.categories : []).map(item => ({
          category: typeof item?.category === 'string' ? item.category : '',
          selfReported: awesomeCount(item?.self_reported),
          rowsInDoc: awesomeCount(item?.rows_in_doc),
          new7d: awesomeCount(item?.new_7d)
        })),
        topics: (Array.isArray(repo.topics) ? repo.topics : []).map(item => ({
          topic: typeof item?.topic === 'string' ? item.topic : '',
          state: typeof item?.status === 'string' ? item.status : 'unavailable',
          latestMonth: typeof item?.latest_month === 'string' ? item.latest_month : null,
          selfReportedTotal: awesomeCount(item?.self_reported_total),
          selfReportedMonth: awesomeCount(item?.self_reported_month),
          measuredRows: awesomeCount(item?.measured_rows)
        }))
      };
    });
    awesomeRowCache = { payload, rows };
    return rows;
  }

  /**
   * Stars, forks and `pushed_at` belong to the GitHub board. The card asks that
   * snapshot by repository id and never keeps a copy of its own.
   */
  function awesomeRepoMetrics(id) {
    const repo = (state.github?.repositories || [])
      .find(row => row.id === id || row.full_name === id);
    if (!repo) {
      return {
        observed: false,
        reason: state.github?.status === 'unavailable'
          ? 'GitHub 看板本次没有可用快照'
          : '该仓库不在本站 GitHub 采集范围内（上游他人的仓库）'
      };
    }
    return {
      observed: true,
      stars: awesomeCount(repo.stars),
      forks: awesomeCount(repo.forks),
      watchers: awesomeCount(repo.watchers),
      openIssues: awesomeCount(repo.open_issues),
      language: typeof repo.language === 'string' ? repo.language : null,
      description: typeof repo.description === 'string' ? repo.description : null,
      pushedAt: typeof repo.pushed_at === 'string' ? repo.pushed_at : null,
      archived: awesomeFlag(repo.archived),
      url: awesomeUrl(repo.url) || `https://github.com/${id}`,
      capturedAt: typeof state.github?.captured_at === 'string' ? state.github.captured_at : null
    };
  }

  /**
   * What the entity registry says about this list repository. The registry owns
   * the relationship, this board owns the counts: the card only asks who has
   * registered this repo, and never copies a number out of the registry.
   */
  function awesomeRegistry(id) {
    const key = `gh_repo:${id}`;
    const group = entityIndex().get(key);
    return { key, entries: group ? group.entries : [], state: group ? group.state : null,
             url: group ? group.url : null };
  }

  /** Fields a row can be judged on: the collector counted them, that is all. */
  function awesomeCoverage(repo) {
    const total = repo.measured.entries;
    const share = value => (total ? Math.round(((value || 0) / total) * 100) : null);
    return [
      { key: 'arXiv', label: 'arXiv ID', count: repo.measured.withArxiv, share: share(repo.measured.withArxiv) },
      { key: 'code', label: '代码链接', count: repo.measured.withCode, share: share(repo.measured.withCode) },
      { key: 'date', label: '时间', count: repo.measured.withDate, share: share(repo.measured.withDate) },
      { key: 'venue', label: '会议', count: repo.measured.withVenue, share: share(repo.measured.withVenue) }
    ];
  }

  /** Repositories that need a look: baseline, stall, degraded read, moved rows. */
  function awesomeAttention(repo) {
    const notes = [];
    if (repo.notAttempted) notes.push('本次没有读取这份清单（抓取额度用完或被 --only 排除）');
    else if (repo.status === 'stale') notes.push('本次没读到，沿用上次快照');
    else if (repo.status === 'unavailable') notes.push('本次没读到，且没有可沿用的历史');
    if (repo.cadence.stalled) notes.push(`清单文件已 ${repo.cadence.staleDays} 天没动过`);
    if (repo.diff.baseline) notes.push('首次基线，新增与移出明天起才可信');
    if (repo.diff.truncated) {
      notes.push(repo.diff.added === null
        ? '上次台账被 id 上限截断，新增与移出无法比较：本次不报数'
        : '条目 id 超过台账上限，增删只是下限');
    }
    if (repo.diff.rollingWindow) notes.push('滚动窗口，移出属于正常收缩');
    if (repo.measured.byteCapped) notes.push('清单文件超过单文件上限，实测条目数是下限');
    if (repo.measured.topicsNotAttempted) {
      notes.push(`抓取额度用完，${repo.measured.topicsNotAttempted} 个主题这次没轮到`);
    }
    if (repo.selfReported && repo.selfReported.entries !== null &&
        repo.measured.entries !== null && repo.selfReported.entries !== repo.measured.entries) {
      notes.push(`自报 ${repo.selfReported.entries} 条与实测 ${repo.measured.entries} 条不一致`);
    }
    return notes;
  }

  function awesomeStats() {
    const payload = state.awesome || {};
    const summary = payload.summary || {};
    const rows = awesomeRows();
    return {
      available: ['ok', 'partial', 'stale'].includes(payload.status),
      repos: awesomeCount(summary.repos) ?? rows.length,
      reposOk: awesomeCount(summary.repos_ok) ?? rows.filter(r => r.status === 'ok').length,
      reposStale: awesomeCount(summary.repos_stale) ?? rows.filter(r => r.status === 'stale').length,
      reposUnavailable: awesomeCount(summary.repos_unavailable)
        ?? rows.filter(r => r.status === 'unavailable').length,
      measured: awesomeCount(summary.entries_measured),
      upstream: awesomeCount(summary.entries_upstream),
      byKind: summary.entries_by_kind || {},
      withArxiv: awesomeCount(summary.with_arxiv),
      withCode: awesomeCount(summary.with_code),
      added: awesomeCount(summary.added),
      removed: awesomeCount(summary.removed),
      stalled: awesomeCount(summary.stalled),
      baseline: rows.filter(repo => repo.diff.baseline).length,
      // "no attempt today" and "uncomparable against a capped ledger" are two different
      // silences, and both have to be visible next to a total that quietly excludes them
      notAttempted: rows.filter(repo => repo.notAttempted).length,
      notCompared: rows.filter(repo => repo.diff.truncated && repo.diff.added === null).length,
      // Counted out of the ids and dates the collector already read: how much of
      // what is on the board arrived recently, per list it could be asked of.
      recent90d: rows.filter(repo => repo.status === 'ok' && !repo.upstream)
        .reduce((total, repo) => total + (repo.measured.recent?.within90d || 0), 0),
      byteCapped: rows.filter(repo => repo.measured.byteCapped).length,
      skippedNoLink: rows.reduce((total, repo) => total + (repo.measured.skippedNoLink || 0), 0),
      skippedNoTitle: rows.reduce((total, repo) => total + (repo.measured.skippedNoTitle || 0), 0),
      selfReportedRepos: awesomeCount(summary.self_reported_repos),
      upstreamRepos: rows.filter(repo => repo.upstream).length,
      warnings: (payload.warnings || []).length,
      fetches: payload.fetches || null,
      sizes: payload.sizes || null,
      budget: payload.source?.budget || null
    };
  }

  /** Only choices the snapshot actually offers, so no select can filter to empty. */
  function awesomeFacets() {
    const tally = get => {
      const counts = new Map();
      awesomeRows().forEach(repo => {
        const value = get(repo) || 'none';
        counts.set(value, (counts.get(value) || 0) + 1);
      });
      return [...counts].map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    };
    return {
      kinds: tally(repo => repo.kind),
      owners: tally(repo => (repo.upstream ? 'upstream' : 'own')),
      cadences: tally(repo => repo.cadence.cadence)
    };
  }

  /** Separators are punctuation here, not part of what is searched: `world_models`
   *  means the same words as `world-models`, for a repo slug and for a title. */
  const flattenSearch = value => String(value).toLowerCase().replace(/[-_/]+/g, ' ');

  /** Kind / ownership / cadence / attention filters; `search` may match a repo or a paper. */
  function awesomeRepoFilter(source = awesomeRows()) {
    const search = flattenSearch(state.awesomeSearch.trim());
    const focus = state.awesomeFocus;
    const kind = state.awesomeKind === 'all' ? null : state.awesomeKind;
    const owner = state.awesomeOwner === 'all' ? null : state.awesomeOwner;
    const cadence = state.awesomeCadence === 'all' ? null : state.awesomeCadence;
    const attention = state.awesomeAttention;
    const items = source.filter(repo => {
      if (focus && repo.id !== focus) return false;
      if (kind && (repo.kind || 'none') !== kind) return false;
      if (owner && (repo.upstream ? 'upstream' : 'own') !== owner) return false;
      if (cadence && (repo.cadence.cadence || 'none') !== cadence) return false;
      if (attention === 'attention' && !awesomeAttention(repo).length) return false;
      if (attention === 'stale' && repo.status === 'ok') return false;
      if (attention === 'stopped' && !repo.cadence.stalled) return false;
      if (attention === 'fresh' && !repo.diff.added) return false;
      if (!search) return true;
      // A repository slug is a hyphenated name: readers type "visual reasoning".
      return flattenSearch([repo.id, repo.kind, repo.measured.note,
        repo.selfReported?.file,
        ...repo.topics.map(topic => topic.topic),
        ...repo.categories.map(category => category.category),
        ...repo.sample.map(entry => `${entry.title} ${entry.section || ''}`)]
        .join(' ')).includes(search);
    });
    const sort = state.awesomeSort;
    if (sort === 'stale') {
      // Most stale first; an unknown file history is a gap, not the freshest list.
      return items.sort((a, b) => {
        const left = a.cadence.staleDays, right = b.cadence.staleDays;
        if (left === null) return right === null ? a.id.localeCompare(b.id) : 1;
        if (right === null) return -1;
        return (right - left) || a.id.localeCompare(b.id);
      });
    }
    const rank = repo => {
      if (sort === 'added') return (repo.diff.added || 0) - (repo.diff.removed || 0);
      if (sort === 'selfReported') return repo.selfReported?.entries ?? -1;
      return repo.measured.entries ?? -1;
    };
    return items.sort((a, b) => (rank(b) - rank(a)) || a.id.localeCompare(b.id));
  }

  function awesomeFilteredRepos() {
    return awesomeRepoFilter();
  }

  /**
   * The paper flow: every sampled entry of every list that passed the filters.
   * A sample is a capped view of the list, never the list itself - the label in
   * the UI says so, and the count here is the sample count, not the total.
   */
  function awesomeFlow() {
    const search = flattenSearch(state.awesomeSearch.trim());
    const rows = [];
    awesomeRepoFilter().forEach(repo => {
      repo.sample.forEach(entry => {
        rows.push({ ...entry, repoId: repo.id, repoName: repo.name, upstream: repo.upstream,
                    kind: repo.kind, repoStatus: repo.status, repoCapturedAt: repo.capturedAt,
                    repoNotAttempted: repo.notAttempted });
      });
    });
    const filtered = search
      ? rows.filter(row => flattenSearch([row.title, row.section, row.venue, row.repoId,
                                         row.arxivId].join(' ')).includes(search))
      : rows;
    const sort = state.awesomeFlowSort;
    return filtered.sort((a, b) => {
      if (sort === 'repo') return a.repoId.localeCompare(b.repoId) ||
        String(b.published || '').localeCompare(String(a.published || ''));
      if (sort === 'added') return (b.isNew ? 1 : 0) - (a.isNew ? 1 : 0) ||
        String(b.published || '').localeCompare(String(a.published || ''));
      return String(b.published || '').localeCompare(String(a.published || '')) ||
        a.repoId.localeCompare(b.repoId);
    });
  }

  function awesomeFlowPageCount() {
    return Math.max(1, Math.ceil(awesomeFlow().length / AWESOME_FLOW_PAGE_SIZE));
  }

  function awesomeFlowPage() {
    const start = (Math.min(Math.max(1, state.awesomeFlowPage), awesomeFlowPageCount()) - 1) *
      AWESOME_FLOW_PAGE_SIZE;
    return awesomeFlow().slice(start, start + AWESOME_FLOW_PAGE_SIZE);
  }

  // --- Load every dataset ---------------------------------------------------

  async function loadAll() {
    const [downloads] = await Promise.allSettled([
      loadDownloads(), loadScholar(), loadSocial(), loadGitHub(), loadModelScope(),
      loadConferences(), loadStars(), loadEntities()
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
    refreshModelScopeSnapshot,
    modelscopeModels,
    modelscopeTotals,
    modelscopeSeries,
    modelscopeDelta,
    modelscopeProfileSeries,
    modelscopeProfileDelta,
    loadConferences,
    refreshConferenceSnapshot,
    conferenceEvents,
    conferenceAreas,
    conferenceRows,
    conferencePage,
    conferencePageCount,
    conferenceStats,
    loadStars,
    refreshStarSnapshot,
    ensureStarDetail,
    starRows,
    starClusters,
    starClusterType,
    starFacets,
    starFiltered,
    starPage,
    starPageCount,
    starStats,
    starWall,
    starGraph,
    loadEntities,
    refreshEntitySnapshot,
    entityEntries,
    entityFiltered,
    entityPage,
    entityPageCount,
    entityPageSize: () => ENTITY_PAGE_SIZE,
    entityStats,
    entityFacets,
    entityCoverage,
    entityProblems,
    entityObjects,
    entityReferences,
    loadTasks,
    refreshTaskSnapshot,
    taskRows,
    taskFiltered,
    taskPage,
    taskPageCount,
    taskPageSize: () => TASK_PAGE_SIZE,
    taskStats,
    taskFacets,
    taskGraph,
    taskSource,
    taskDeadline,
    taskEntity,
    sortTasks,
    loadAwesome,
    loadAwesomeHistory,
    awesomeTrend,
    refreshAwesomeSnapshot,
    awesomeRows,
    awesomeFilteredRepos,
    awesomeRepoMetrics,
    awesomeCoverage,
    awesomeRegistry,
    awesomeAttention,
    awesomeStats,
    awesomeFacets,
    awesomeFlow,
    awesomeFlowPage,
    awesomeFlowPageCount,
    awesomeFlowPageSize: () => AWESOME_FLOW_PAGE_SIZE
  };
})();
