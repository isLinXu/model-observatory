/* Model Observatory — skill & prompt library.
 *
 * A self-contained module for the 模版库 board. It owns:
 *
 *   1. browsing the published index (search, kind / tag filters, sorting,
 *      card and table views, detail view with copy-to-clipboard);
 *   2. composing new or edited templates as local drafts;
 *   3. pushing those drafts to GitHub through the Contents API, so the
 *      Markdown under templates/ stays the single source of truth.
 *
 * Token handling: the personal access token lives in sessionStorage only and is
 * sent exclusively to api.github.com. Nothing is proxied through this site,
 * which is static and has no backend. Without a token the library still
 * browses and exports; only the write-back is disabled.
 */
window.MO = window.MO || {};

MO.templates = (() => {
  'use strict';

  const { esc, fmt, timestamp } = MO.format;
  const charts = MO.charts;
  const data = MO.data;

  const $ = id => document.getElementById(id);

  const TOKEN_KEY = 'mo.templates.token';
  const DRAFT_KEY = 'mo.templates.drafts';
  const API = 'https://api.github.com';

  const KIND_LABEL = { skill: 'Skill', prompt: 'Prompt' };

  const state = {
    library: null,
    entries: [],
    history: [],
    search: '',
    kind: 'all',
    tag: 'all',
    sort: 'name',
    view: 'cards',
    selected: null,
    draft: null,
    drafts: {},
    repo: { owner: '', name: '', branch: 'main' },
    token: '',
    status: 'loading',
    sync: { state: 'idle', message: '' },
    revealToken: false
  };

  // --- Storage -------------------------------------------------------------
  // Browser storage can throw in private modes, so every access is guarded;
  // the board stays fully usable as a read-only library in that case.

  function readStore(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function writeStore(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      return false;
    }
  }

  function clearStore(key) {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      /* nothing to clean up */
    }
  }

  function readSession(key) {
    try {
      return sessionStorage.getItem(key) || '';
    } catch (error) {
      return '';
    }
  }

  function writeSession(key, value) {
    try {
      sessionStorage.setItem(key, value);
    } catch (error) {
      /* Keep the token in memory for this page. */
    }
  }

  function clearSession(key) {
    try {
      sessionStorage.removeItem(key);
    } catch (error) {
      /* nothing to clean up */
    }
  }

  // --- Derived data --------------------------------------------------------

  function summary() {
    return state.library?.summary || { total: 0, skills: 0, prompts: 0, bytes: 0, tags: [], categories: [] };
  }

  /** Entries after search, kind and tag filters, in display order. */
  function visibleEntries() {
    const search = state.search.trim().toLowerCase();
    let rows = state.entries.filter(entry => {
      if (state.kind !== 'all' && entry.kind !== state.kind) return false;
      if (state.tag !== 'all' && !entry.tags.includes(state.tag)) return false;
      if (!search) return true;
      const haystack = [entry.name, entry.slug, entry.description, entry.category,
        entry.author, entry.kind, entry.tags.join(' '), entry.body].join(' ').toLowerCase();
      return haystack.includes(search);
    });
    const byName = (a, b) => a.name.localeCompare(b.name, 'zh-CN');
    if (state.sort === 'kind') rows = rows.sort((a, b) => a.kind.localeCompare(b.kind) || byName(a, b));
    else if (state.sort === 'size') rows = rows.sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
    else rows = rows.sort(byName);
    return rows;
  }

  function draftCount() {
    return Object.keys(state.drafts).length;
  }

  /** The composed draft when one is open, otherwise the selected entry. */
  function currentEntry() {
    if (state.draft) return state.draft;
    if (!state.selected) return null;
    return state.entries.find(entry => entry.id === state.selected) || null;
  }

  // --- Markdown serialisation ---------------------------------------------

  function toMarkdown(entry) {
    const lines = ['---'];
    lines.push(`name: ${entry.name || entry.slug}`);
    if (entry.description) lines.push(`description: ${entry.description}`);
    if (entry.category) lines.push(`category: ${entry.category}`);
    if (entry.tags?.length) lines.push(`tags: [${entry.tags.join(', ')}]`);
    if (entry.version) lines.push(`version: ${entry.version}`);
    if (entry.author) lines.push(`author: ${entry.author}`);
    lines.push('---', '');
    return lines.join('\n') + (entry.body || '');
  }

  /** UTF-8 safe base64: btoa alone throws on any non-Latin-1 character. */
  function toBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
  }

  function slugify(value) {
    const slug = String(value || '').trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return slug;
  }

  function pathFor(entry) {
    const folder = entry.kind === 'skill' ? 'skills' : 'prompts';
    return `templates/${folder}/${entry.slug}.md`;
  }

  // --- GitHub --------------------------------------------------------------

  function headers(extra) {
    return {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...extra
    };
  }

  async function apiGet(path) {
    const response = await fetch(`${API}${path}`, { headers: headers() });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub API ${response.status}`);
    return response.json();
  }

  /** Blob sha of the existing file, or null when it does not exist yet. */
  async function fileSha(path) {
    const file = await apiGet(`/repos/${state.repo.owner}/${state.repo.name}/contents/${path}`);
    return file ? file.sha : null;
  }

  async function pushFile(path, content, message) {
    const sha = await fileSha(path);
    const response = await fetch(`${API}/repos/${state.repo.owner}/${state.repo.name}/contents/${path}`, {
      method: 'PUT',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ message, content: toBase64(content), branch: state.repo.branch, ...(sha ? { sha } : {}) })
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.message || `GitHub API ${response.status}`);
    }
    return response.json();
  }

  function requireToken() {
    if (!state.token) throw new Error('请先填写 GitHub Token');
    if (!state.repo.owner || !state.repo.name) throw new Error('仓库信息缺失');
  }

  // --- Rendering: board chrome -------------------------------------------

  function renderSummary() {
    const stats = summary();
    $('templateCountBadge').textContent = fmt(stats.total);
    $('statTemplatesTotal').textContent = fmt(stats.total);
    $('statTemplatesTotalSub').textContent = state.library?.library
      ? `源仓库 ${state.repo.owner}/${state.repo.name}`
      : '暂无模版索引';
    $('statTemplatesSkills').textContent = fmt(stats.skills);
    $('statTemplatesSkillsSub').textContent = '可复用的技能定义';
    $('statTemplatesPrompts').textContent = fmt(stats.prompts);
    $('statTemplatesPromptsSub').textContent = '可复用的提示词模版';
    $('statTemplatesTags').textContent = fmt(stats.tags.length);
    $('statTemplatesTagsSub').textContent = stats.categories.length
      ? `分类：${stats.categories.map(item => item.category).join(' · ')}`
      : '尚未标注分类';
    const age = state.library?.captured_at ? Date.parse(state.library.captured_at) : NaN;
    $('templateCapturedAt').textContent = Number.isNaN(age) ? '—' : `索引于 ${timestamp(state.library.captured_at)} UTC`;
  }

  function renderBanner() {
    const banner = $('templateBanner');
    const library = state.library;
    if (!library || library.status === 'unavailable') {
      banner.textContent = library?.error
        ? `模版索引读取失败：${library.error}。${state.entries.length ? '已保留上一次结果，' : ''}可手动刷新重试。`
        : '尚未建立模版索引。';
      banner.classList.remove('hidden', 'info');
      return;
    }
    if (!state.entries.length) {
      banner.textContent = '模版库为空。把 Markdown 放进 templates/skills 或 templates/prompts，运行采集器后即可显示。';
      banner.classList.add('info');
      banner.classList.remove('hidden');
      return;
    }
    banner.classList.add('hidden');
  }

  function renderTrend() {
    const points = state.history.map(snapshot => ({ date: snapshot.date, value: snapshot.total }));
    charts.line($('templateChart'), [{ name: '模版总数', points, color: 'var(--chart-2)' }], {
      area: true,
      label: '模版库规模趋势'
    });
    $('templateChartNote').textContent = state.history.length >= 2
      ? `最近 ${state.history.length} 个快照 · 新增 ${Math.max(0, points.at(-1).value - points[0].value)} 个`
      : '需要至少两天的模版快照才能绘制变化曲线。';
  }

  function renderTagFilter() {
    const select = $('filterTemplateTag');
    const stats = summary();
    const current = state.tag;
    select.innerHTML = '<option value="all">全部标签</option>' +
      stats.tags.map(item =>
        `<option value="${esc(item.tag)}">${esc(item.tag)} (${item.count})</option>`).join('');
    // A tag can vanish when the published index changes; fall back gracefully.
    const exists = current === 'all' || stats.tags.some(item => item.tag === current);
    if (!exists) state.tag = 'all';
    select.value = state.tag;
  }

  function card(entry) {
    const tags = entry.tags.slice(0, 4).map(tag =>
      `<span class="template-tag">${esc(tag)}</span>`).join('');
    const more = entry.tags.length > 4 ? `<span class="template-tag muted">+${entry.tags.length - 4}</span>` : '';
    const title = entry.name;
    const inner = entry.url
      ? `<a class="template-title" href="${esc(entry.url)}" target="_blank" rel="noopener noreferrer">${esc(title)}</a>`
      : `<span class="template-title">${esc(title)}</span>`;
    return `<article class="template-card" data-template-id="${esc(entry.id)}" tabindex="0" role="button" aria-label="查看 ${esc(title)}">
      <div class="template-card-head">
        <span class="template-kind ${esc(entry.kind)}">${esc(KIND_LABEL[entry.kind] || entry.kind)}</span>
        ${entry.version ? `<span class="template-version">v${esc(entry.version)}</span>` : ''}
      </div>
      <div class="template-card-title">${inner}</div>
      <p class="template-desc">${esc(entry.description || '（未提供描述）')}</p>
      <div class="template-tags">${tags}${more}</div>
      <div class="template-card-foot"><span>${esc(entry.category || '未分类')}</span><span>${fmt(entry.lines)} 行 · ${fmt(entry.bytes)} B</span></div>
    </article>`;
  }

  function row(entry) {
    const name = entry.url
      ? `<a class="model-link" href="${esc(entry.url)}" target="_blank" rel="noopener noreferrer">${esc(entry.name)}</a>`
      : `<span class="model-link-plain">${esc(entry.name)}</span>`;
    return `<tr><td>${name}<span class="repo-desc">${esc(entry.description || '')}</span></td>
      <td><span class="template-kind ${esc(entry.kind)}">${esc(KIND_LABEL[entry.kind] || entry.kind)}</span></td>
      <td>${esc(entry.category || '—')}</td>
      <td>${esc(entry.tags.join('、') || '—')}</td>
      <td class="align-right">${fmt(entry.lines)}</td>
      <td>${esc(entry.version || '—')}</td></tr>`;
  }

  function renderList() {
    const rows = visibleEntries();
    const total = state.entries.length;
    $('templateTableCount').textContent = `${fmt(rows.length)} / ${fmt(total)} TEMPLATES`;
    $('templateCountBadge').textContent = fmt(total);

    if (!state.entries.length) {
      $('templateCards').innerHTML = '<div class="chart-empty">尚未建立模版索引</div>';
      $('templateRows').innerHTML = '<tr><td colspan="6" class="no-rows">尚未建立模版索引</td></tr>';
      return;
    }
    if (!rows.length) {
      const empty = '<div class="chart-empty">没有符合当前筛选条件的模版</div>';
      $('templateCards').innerHTML = empty;
      $('templateRows').innerHTML = '<tr><td colspan="6" class="no-rows">没有符合当前筛选条件的模版</td></tr>';
      return;
    }
    $('templateCards').innerHTML = rows.map(card).join('');
    $('templateRows').innerHTML = rows.map(row).join('');
  }

  function renderView() {
    const isCards = state.view === 'cards';
    $('templateCards').classList.toggle('hidden', !isCards);
    $('templateTableWrap').classList.toggle('hidden', isCards);
    document.querySelectorAll('[data-template-view]').forEach(button => {
      const active = button.dataset.templateView === state.view;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  function renderDraftBadge() {
    const count = draftCount();
    const badge = $('templateDraftBadge');
    badge.textContent = count ? `${count} 个待同步` : '无待同步';
    badge.classList.toggle('accent', count > 0);
  }

  // --- Rendering: detail + composer ---------------------------------------

  function renderDetail() {
    const entry = currentEntry();
    const wrap = $('templateDetail');
    if (!entry) {
      wrap.classList.add('hidden');
      return;
    }
    const isDraft = Boolean(state.draft);
    wrap.classList.remove('hidden');
    $('templateDetailTitle').textContent = isDraft ? '编辑模版（草稿）' : entry.name;
    $('templateDetailMeta').innerHTML =
      `<span class="template-kind ${esc(entry.kind)}">${esc(KIND_LABEL[entry.kind] || entry.kind)}</span>` +
      `<span>${esc(entry.category || '未分类')}</span>` +
      (entry.version ? `<span>v${esc(entry.version)}</span>` : '') +
      `<span>${fmt(entry.lines)} 行</span>` +
      (entry.truncated ? '<span class="missing">正文已截断</span>' : '');
    $('templateDetailBody').textContent = entry.body || '（空正文）';
    $('templateDetailTags').innerHTML = entry.tags.map(tag =>
      `<span class="template-tag">${esc(tag)}</span>`).join('');
    $('templateDetailActions').innerHTML =
      `<button class="button" id="templateCopy">⧉ 复制正文</button>` +
      `<button class="button secondary" id="templateDownload">↓ 下载 .md</button>` +
      `<button class="button secondary" id="templateEdit">✎ 复制为草稿</button>` +
      (entry.url ? `<a class="button secondary" href="${esc(entry.url)}" target="_blank" rel="noopener noreferrer">GitHub 源文件 ↗</a>` : '');
    $('templateCloseDetail').onclick = closeDetail;
    $('templateCopy').onclick = () => copyText(entry.body || '', '模版正文已复制');
    $('templateDownload').onclick = () => downloadMarkdown(entry);
    $('templateEdit').onclick = () => openComposer(entry);
  }

  function closeDetail() {
    state.selected = null;
    state.draft = null;
    $('templateComposer').classList.add('hidden');
    renderDetail();
  }

  function downloadMarkdown(entry) {
    const blob = new Blob([toMarkdown(entry)], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${entry.slug}.md`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function copyText(text, message) {
    try {
      await navigator.clipboard.writeText(text);
      MO.render.showToast(message || '已复制');
    } catch (error) {
      // Clipboard needs a secure context; fall back to a selectable field.
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.append(area);
      area.select();
      try {
        document.execCommand('copy');
        MO.render.showToast(message || '已复制');
      } catch (fallbackError) {
        MO.render.showToast('复制失败，请手动选择文本');
      }
      area.remove();
    }
  }

  // --- Composer ------------------------------------------------------------

  function openComposer(entry) {
    const source = entry || { kind: 'prompt', slug: '', name: '', description: '', category: '', tags: [], version: '', author: '', body: '' };
    state.draft = {
      ...source,
      slug: source.slug || slugify(source.name) || '',
      tags: [...(source.tags || [])]
    };
    $('templateFormKind').value = state.draft.kind;
    $('templateFormSlug').value = state.draft.slug;
    $('templateFormName').value = state.draft.name;
    $('templateFormDescription').value = state.draft.description;
    $('templateFormCategory').value = state.draft.category;
    $('templateFormTags').value = state.draft.tags.join(', ');
    $('templateFormVersion').value = state.draft.version;
    $('templateFormAuthor').value = state.draft.author;
    $('templateFormBody').value = state.draft.body;
    $('templateFormPreview').textContent = toMarkdown(collectForm());
    $('templateComposer').classList.remove('hidden');
    renderDetail();
  }

  function closeComposer() {
    $('templateComposer').classList.add('hidden');
    state.draft = null;
    renderDetail();
  }

  function collectForm() {
    const slug = slugify($('templateFormSlug').value || $('templateFormName').value);
    return {
      id: `${$('templateFormKind').value}/${slug}`,
      kind: $('templateFormKind').value,
      slug,
      name: $('templateFormName').value.trim() || slug,
      description: $('templateFormDescription').value.trim(),
      category: $('templateFormCategory').value.trim(),
      tags: $('templateFormTags').value.split(/[,，、]/).map(tag => tag.trim()).filter(Boolean),
      version: $('templateFormVersion').value.trim(),
      author: $('templateFormAuthor').value.trim(),
      body: $('templateFormBody').value,
      url: null
    };
  }

  function saveDraft() {
    const entry = collectForm();
    if (!entry.slug) {
      MO.render.showToast('请填写有效的文件名（字母、数字、连字符）');
      return null;
    }
    if (!entry.body.trim()) {
      MO.render.showToast('正文不能为空');
      return null;
    }
    state.drafts[entry.id] = entry;
    const persisted = writeStore(DRAFT_KEY, state.drafts);
    state.draft = entry;
    $('templateFormPreview').textContent = toMarkdown(entry);
    renderDraftBadge();
    if (!persisted) MO.render.showToast('浏览器不允许本地存储，草稿仅保留在当前页面');
    return entry;
  }

  function discardDraft(id) {
    delete state.drafts[id];
    writeStore(DRAFT_KEY, state.drafts);
    renderDraftBadge();
    renderList();
  }

  // --- Sync ----------------------------------------------------------------

  function setSync(stateName, message) {
    state.sync = { state: stateName, message };
    renderSync();
  }

  function renderSync() {
    const badge = $('templateSyncState');
    const map = {
      idle: ['未同步', ''],
      pending: ['有改动待推送', 'accent'],
      syncing: ['正在推送…', 'accent'],
      done: ['已推送', 'ok'],
      error: ['推送失败', 'warn']
    };
    const [label, cls] = map[state.sync.state] || map.idle;
    badge.textContent = label;
    badge.className = `template-sync-state ${cls}`;
    $('templateSyncMessage').textContent = state.sync.message || '';
  }

  async function syncDrafts() {
    requireToken();
    const ids = Object.keys(state.drafts);
    if (!ids.length) {
      setSync('idle', '没有需要推送的草稿');
      return;
    }
    setSync('syncing', `正在推送 ${ids.length} 个草稿…`);
    const done = [];
    for (const id of ids) {
      const entry = state.drafts[id];
      try {
        await pushFile(pathFor(entry), toMarkdown(entry), `feat(templates): ${entry.kind} ${entry.slug}`);
        done.push(id);
      } catch (error) {
        setSync('error', `${entry.name} 推送失败：${error.message}`);
        return;
      }
    }
    done.forEach(id => delete state.drafts[id]);
    writeStore(DRAFT_KEY, state.drafts);
    setSync('done', `已推送 ${done.length} 个模版到 ${state.repo.owner}/${state.repo.name}@${state.repo.branch}。GitHub Actions 会自动重建索引。`);
    renderDraftBadge();
    renderList();
  }

  function verifyToken() {
    try {
      requireToken();
    } catch (error) {
      setSync('error', error.message);
      return;
    }
    setSync('syncing', '正在校验 Token…');
    apiGet('/user')
      .then(user => setSync('idle', `已连接 ${user.login}，可推送草稿`))
      .catch(error => setSync('error', `校验失败：${error.message}`));
  }

  // --- Export --------------------------------------------------------------

  function exportBundle() {
    const payload = {
      exported_at: new Date().toISOString(),
      library: state.library?.library || state.repo,
      templates: Object.values(state.drafts)
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `templates-drafts-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // --- Load ----------------------------------------------------------------

  async function load() {
    try {
      const [library, history] = await Promise.all([
        data.getJSON('./data/templates.json', '模版索引'),
        data.getJSON('./data/templates_history.json', '模版历史')
      ]);
      state.library = library;
      state.entries = Array.isArray(library.templates) ? library.templates : [];
      state.history = Array.isArray(history.snapshots)
        ? [...history.snapshots].sort((a, b) => a.date.localeCompare(b.date))
        : [];
      const repo = library.library || {};
      state.repo = {
        owner: String(repo.repo || '').split('/')[0] || 'isLinXu',
        name: String(repo.repo || '').split('/')[1] || 'model-observatory',
        branch: repo.branch || 'main'
      };
      state.status = 'ready';
    } catch (error) {
      console.warn('模版索引读取失败：', error);
      state.library = { status: 'unavailable', error: error.message, templates: [], summary: null };
      state.entries = [];
      state.history = [];
      state.status = 'ready';
    }
    state.drafts = readStore(DRAFT_KEY, {}) || {};
    const legacyToken = readStore(TOKEN_KEY, '') || '';
    state.token = readSession(TOKEN_KEY) || legacyToken;
    if (legacyToken) {
      writeSession(TOKEN_KEY, legacyToken);
      clearStore(TOKEN_KEY);
    }
  }

  async function refresh() {
    const stamp = Date.now();
    try {
      const [library, history] = await Promise.all([
        data.getJSON(`./data/templates.json?t=${stamp}`, '模版索引'),
        data.getJSON(`./data/templates_history.json?t=${stamp}`, '模版历史')
      ]);
      state.library = library;
      state.entries = Array.isArray(library.templates) ? library.templates : [];
      state.history = Array.isArray(history.snapshots) ? history.snapshots : state.history;
    } catch (error) {
      MO.render.showToast('索引刷新失败：' + error.message);
    }
    renderAll();
  }

  // --- Render all ----------------------------------------------------------

  function renderAll() {
    renderSummary();
    renderBanner();
    renderTrend();
    renderTagFilter();
    renderList();
    renderView();
    renderDraftBadge();
    renderSync();
    renderDetail();
    renderTokenField();
  }

  function renderTokenField() {
    const field = $('templateToken');
    if (document.activeElement !== field) {
      field.value = state.token;
    }
    field.type = state.revealToken ? 'text' : 'password';
    $('templateTokenToggle').textContent = state.revealToken ? '隐藏' : '显示';
  }

  // --- Events --------------------------------------------------------------

  function openEntry(id) {
    state.draft = null;
    state.selected = id;
    $('templateComposer').classList.add('hidden');
    renderDetail();
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    $('templateDetail').scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'nearest' });
  }

  function bind() {
    $('templateSearch').addEventListener('input', event => {
      state.search = event.target.value;
      renderList();
    });
    $('filterTemplateKind').addEventListener('change', event => {
      state.kind = event.target.value;
      renderList();
    });
    $('filterTemplateTag').addEventListener('change', event => {
      state.tag = event.target.value;
      renderList();
    });
    $('sortTemplate').addEventListener('change', event => {
      state.sort = event.target.value;
      renderList();
    });
    document.querySelectorAll('[data-template-view]').forEach(button => {
      button.addEventListener('click', () => {
        state.view = button.dataset.templateView;
        renderView();
      });
    });
    $('templateCards').addEventListener('click', event => {
      const item = event.target.closest('[data-template-id]');
      if (item) openEntry(item.dataset.templateId);
    });
    $('templateCards').addEventListener('keydown', event => {
      const item = event.target.closest('[data-template-id]');
      if (item && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        openEntry(item.dataset.templateId);
      }
    });
    $('templateRows').addEventListener('click', event => {
      const row = event.target.closest('tr');
      if (!row) return;
      const match = state.entries.find(entry => entry.name === row.querySelector('.model-link, .model-link-plain')?.textContent);
      if (match) openEntry(match.id);
    });
    $('templateNew').addEventListener('click', () => openComposer(null));
    $('templateRefresh').addEventListener('click', refresh);
    $('templateExport').addEventListener('click', exportBundle);

    $('templateFormKind').addEventListener('change', () => {
      $('templateFormPreview').textContent = toMarkdown(collectForm());
    });
    ['templateFormSlug', 'templateFormName', 'templateFormDescription', 'templateFormCategory',
      'templateFormTags', 'templateFormVersion', 'templateFormAuthor', 'templateFormBody']
      .forEach(id => $(id).addEventListener('input', () => {
        $('templateFormPreview').textContent = toMarkdown(collectForm());
      }));
    $('templateFormSave').addEventListener('click', () => {
      if (saveDraft()) MO.render.showToast('草稿已保存到本地，可推送到 GitHub');
    });
    $('templateFormPush').addEventListener('click', async () => {
      if (!saveDraft()) return;
      // requireToken throws when no token is configured; that is an expected
      // state, not a crash, so it is reported through the sync panel.
      try {
        await syncDrafts();
      } catch (error) {
        setSync('error', error.message);
        MO.render.showToast(error.message);
      }
    });
    $('templateFormClose').addEventListener('click', closeComposer);

    $('templateToken').addEventListener('input', event => {
      state.token = event.target.value.trim();
      writeSession(TOKEN_KEY, state.token);
    });
    $('templateTokenToggle').addEventListener('click', () => {
      state.revealToken = !state.revealToken;
      renderTokenField();
    });
    $('templateTokenVerify').addEventListener('click', verifyToken);
    $('templateTokenClear').addEventListener('click', () => {
      state.token = '';
      clearStore(TOKEN_KEY);
      clearSession(TOKEN_KEY);
      renderTokenField();
      setSync('idle', 'Token 已从本地清除');
    });
  }

  async function init() {
    await load();
    bind();
    renderAll();
  }

  return { init, state, toMarkdown, slugify, currentEntry };
})();