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

  /** Load every dataset. Only a download failure is fatal for the page. */
  async function loadAll() {
    await loadDownloads();
    await Promise.all([loadScholar(), loadSocial(), loadGitHub()]);
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

  function sumSeries(key, metric, range = 'all') {
    const source = range === 'all' ? state.snapshots : state.snapshots.slice(-Number(range));
    return source.map(snapshot => {
      let sum = 0, known = 0;
      Object.values(snapshot[key] || {}).forEach(point => {
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
  function netChange(newer, older, key = 'models') {
    if (!newer || !older) return null;
    let sum = 0, counted = 0, negative = 0;
    for (const id of Object.keys(newer[key] || {})) {
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

  function localModels() {
    return (state.latest?.models || []).map(model => ({
      ...model,
      d1: delta(model.id, 'prev'),
      d7: delta(model.id, 7),
      d30: delta(model.id, 30)
    }));
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
      const followers = snapshot.followers || {};
      const total = wanted.reduce((sum, id) => {
        const value = followers[id];
        return sum + (Number.isFinite(value) ? value : 0);
      }, 0);
      return { date: snapshot.date, value: total };
    }).filter(point => point.value > 0);
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
    socialDelta,
    selectedSocialIds,
    reloadGitHub,
    githubSeries,
    githubGrowth,
    githubScope,
    githubLanguages,
    githubRepositories,
    githubTotals
  };
})();
