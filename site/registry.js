/* Model Observatory — the entity registry's write-back panel.
 *
 * The published index is a read-only view of `entities/<slug>.md`: it carries
 * the collector's link checks and a *truncated* copy of the prose. So editing
 * never starts from the snapshot - the panel reads the source file fresh from
 * GitHub through MO.repo, keeps the blob SHA it read as the draft's baseline,
 * and refuses the push when that SHA no longer matches. A page that pushed the
 * snapshot copy back would delete everything past the cut.
 *
 * Nothing here rewrites the board's numbers. A push changes the repository; the
 * next daily run re-indexes it and the page follows.
 */
window.MO = window.MO || {};

MO.registry = (() => {
  'use strict';

  const data = MO.data;
  const repo = MO.repo;
  const { esc, timestamp } = MO.format;

  const $ = id => document.getElementById(id);

  const DRAFT_KEY = 'mo.entities.drafts';
  const SLUG_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
  const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
  // The six fields the registry collector reads. Anything else in the front
  // matter is ignored by the collector, so the author hears it here instead.
  const FIELDS = ['title', 'kind', 'stage', 'tags', 'updated', 'links'];

  const state = {
    slug: null,
    text: '',
    baseline: null,
    remoteSha: null,
    drafts: {},
    conflict: null,
    sync: { state: 'idle', message: '' }
  };

  // The vocabularies come from the collector's own snapshot, so a draft is
  // checked against the set that will judge it tomorrow - not a copy kept here.
  function kinds() { return data.state.entities?.source?.kinds || []; }
  function stages() { return data.state.entities?.source?.stages || []; }
  /** The prefixes the collector can prove; an unknown one is a typo, not a link. */
  function domains() { return data.state.entities?.source?.domains || []; }

  function pathFor(slug) { return `entities/${slug}.md`; }
  function short(sha) { return String(sha || '').slice(0, 7); }

  /** Write back to the repository the collector indexed, not to a guess. */
  function adopt() {
    return repo.adopt(data.state.entities?.source || {});
  }

  // --- Draft validation ----------------------------------------------------

  function splitFrontmatter(text) {
    const lines = String(text || '').split('\n');
    if ((lines[0] || '').trim() !== '---') return null;
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (end < 0) return null;
    return { block: lines.slice(1, end), body: lines.slice(end + 1).join('\n') };
  }

  /**
   * The same structural rules `--check` enforces, run before the commit exists:
   * a mistyped link prefix is an error the author should see now, not a link
   * that quietly disappears from tomorrow's index.
   */
  function issues(text, slug = state.slug) {
    const found = [];
    const parts = splitFrontmatter(text);
    if (!parts) {
      found.push('缺少 --- 包裹的 front matter：采集器会把类型、阶段、标签与关系全部按未标注处理。');
      return found;
    }
    if (slug && !SLUG_PATTERN.test(slug)) {
      found.push(`文件名「${slug}」需为小写字母、数字与连字符。`);
    }
    const knownDomains = domains();
    let inLinks = false;
    for (const line of parts.block) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (trimmed.startsWith('- ')) {
        if (!inLinks) {
          found.push(`「${trimmed}」不在 links: 之下，采集器读不到它。`);
          continue;
        }
        const value = trimmed.slice(2).trim();
        const [domain, ...rest] = value.split(':');
        if (!rest.length || !rest.join(':').trim()) {
          found.push(`关系「${value}」不是 domain:id 形态。`);
        } else if (knownDomains.length && !knownDomains.includes(domain)) {
          found.push(`前缀「${domain}」不是本站核对的域名（可用：${knownDomains.join(' / ')}）。`);
        }
        continue;
      }
      const [key, ...rest] = trimmed.split(':');
      const value = rest.join(':').trim();
      const name = key.trim().toLowerCase();
      if (!FIELDS.includes(name)) {
        found.push(`字段「${name}」不属于注册表的六个字段，采集器会忽略它。`);
        inLinks = false;
        continue;
      }
      inLinks = name === 'links';
      if (name === 'kind' && value && kinds().length && !kinds().includes(value)) {
        found.push(`kind「${value}」不属于 ${kinds().join(' / ')}。`);
      }
      if (name === 'stage' && value && stages().length && !stages().includes(value)) {
        found.push(`stage「${value}」不属于 ${stages().join(' / ')}。`);
      }
      if (name === 'updated' && value && !DATE_PATTERN.test(value)) {
        found.push(`updated「${value}」不是 YYYY-MM-DD。`);
      }
      if (name === 'links' && value && value !== '[]') {
        const scalar = value.replace(/^\[|\]$/g, '');
        for (const item of scalar.split(/[,，]/).map(part => part.trim()).filter(Boolean)) {
          const [domain, ...id] = item.split(':');
          if (!id.length || !id.join(':').trim()) found.push(`关系「${item}」不是 domain:id 形态。`);
          else if (knownDomains.length && !knownDomains.includes(domain)) {
            found.push(`前缀「${domain}」不是本站核对的域名（可用：${knownDomains.join(' / ')}）。`);
          }
        }
      }
    }
    if (!parts.body.trim()) found.push('正文为空：条目会只剩关系，结论请写在正文里。');
    return found;
  }

  // --- Storage -------------------------------------------------------------

  function loadDrafts() {
    state.drafts = repo.readLocal(DRAFT_KEY, {}) || {};
    return state.drafts;
  }

  function storeDrafts() {
    return repo.writeLocal(DRAFT_KEY, state.drafts);
  }

  // --- Sync panel ----------------------------------------------------------

  function setSync(name, message) {
    state.sync = { state: name, message };
    renderSync();
  }

  function renderSync() {
    const map = {
      idle: ['未同步', ''],
      pending: ['有草稿待推送', 'accent'],
      syncing: ['正在读写…', 'accent'],
      done: ['已推送', 'ok'],
      error: ['推送失败', 'warn'],
      conflict: ['远端已变', 'warn']
    };
    const [label, cls] = map[state.sync.state] || map.idle;
    $('entitySyncState').textContent = label;
    $('entitySyncState').className = `template-sync-state ${cls}`;
    $('entitySyncMessage').textContent = state.sync.message || '';
  }

  function renderTokenField() {
    const field = $('entityToken');
    if (field && document.activeElement !== field) field.value = repo.coordinates().token;
  }

  // --- Editor --------------------------------------------------------------

  function title(slug) {
    return data.entityEntries().find(entry => entry.slug === slug)?.title || slug;
  }

  function renderEditor() {
    const wrap = $('entityEditor');
    if (!state.slug) {
      wrap.classList.add('hidden');
      return;
    }
    wrap.classList.remove('hidden');
    $('entityFormPath').textContent = state.slug ? pathFor(state.slug) : 'entities/<slug>.md';
    $('entityFormText').value = state.text;
    const problems = issues(state.text);
    const draft = state.drafts[state.slug];
    $('entityFormIssues').textContent = problems.length
      ? `结构检查（${problems.length} 处）：${problems.join(' ')}`
      : draft ? `本地草稿已保存于 ${timestamp(draft.savedAt)}，尚未推送。` : '结构与采集器的 --check 一致。';
    $('entityFormDiscard').disabled = !draft;
    $('entityFormConflict').classList.toggle('hidden', !state.conflict);
    if (state.conflict) {
      $('entityConflictNote').textContent =
        `远端当前是 ${short(state.conflict.sha)}，草稿基线是 ${short(state.baseline)}。` +
        '以这份文本推送会覆盖那次改动。';
    }
  }

  function renderDrafts() {
    const ids = Object.keys(state.drafts);
    $('entityDraftBadge').textContent = ids.length ? `${ids.length} 个待同步` : '无待同步';
    $('entityDraftBadge').classList.toggle('accent', ids.length > 0);
    const note = $('entityDraftNote');
    note.textContent = ids.length
      ? '草稿只存在这台浏览器的本地存储里；未推送的改动不会进入站点数据，也不会被采集器看到。'
      : '没有待推送草稿：编辑器里的改动只有保存后才会留在本地。';
    $('entityDraftList').innerHTML = ids.length ? ids.map(slug => {
      const draft = state.drafts[slug];
      return `<div class="entity-detail-item"><div class="entity-detail-text">` +
        `<div><code>${esc(slug)}</code> <span class="micro muted">${esc(title(slug))}</span></div>` +
        `<div class="micro muted">草稿保存于 ${esc(timestamp(draft.savedAt))} · 基线 ${esc(short(draft.baseline) || '新建')}</div>` +
        `</div><div class="entity-detail-actions">` +
        `<button type="button" class="button secondary" data-entity-edit="${esc(slug)}">编辑</button>` +
        `<button type="button" class="button" data-entity-push="${esc(slug)}">推送</button>` +
        `<button type="button" class="button text-button" data-entity-discard="${esc(slug)}">放弃</button>` +
        `</div></div>`;
    }).join('') : '<div class="chart-empty">没有待推送的草稿</div>';
  }

  function renderAll() {
    renderEditor();
    renderDrafts();
    renderSync();
    renderTokenField();
  }

  async function open(slug) {
    if (!slug) return null;
    adopt();
    try {
      repo.requireToken();
    } catch (error) {
      // The board stays fully readable; only the write is disabled, and the
      // panel says which of the two conditions is missing.
      setSync('error', `${error.message}；条目仍可浏览、搜索与导出。`);
      renderTokenField();
      return null;
    }
    state.slug = slug;
    state.conflict = null;
    loadDrafts();
    if (state.drafts[slug]) {
      state.text = state.drafts[slug].text;
      state.baseline = state.drafts[slug].baseline;
      setSync('pending', `正在显示本地未推送草稿（${pathFor(slug)}）。`);
      renderAll();
      return slug;
    }
    await reload();
    return slug;
  }

  /** Read the source file again, and adopt its current SHA as the baseline. */
  async function reload() {
    if (!state.slug) return null;
    adopt();
    setSync('syncing', `正在读取 ${pathFor(state.slug)} 的远端原文…`);
    try {
      const file = await repo.readFile(pathFor(state.slug));
      state.text = file.exists ? file.text : '';
      state.baseline = file.sha;
      state.remoteSha = file.sha;
      const row = data.entityEntries().find(entry => entry.slug === state.slug);
      const drifted = file.exists && row?.blobSha && row.blobSha !== file.sha;
      const indexedAt = timestamp(data.state.entities?.captured_at);
      setSync('idle', file.exists
        ? `已读取远端原文，基线 ${short(file.sha)}` +
          (drifted ? `；索引里是 ${short(row.blobSha)}，远端在 ${indexedAt} 那次索引之后又被改过，这里读到的才是最新版。`
            : `，与 ${indexedAt} 的索引一致。`)
        : `远端还没有 ${pathFor(state.slug)}，推送会新建该文件。`);
      renderAll();
      return file;
    } catch (error) {
      setSync('error', `读取远端原文失败：${error.message}`);
      renderAll();
      return null;
    }
  }

  function save() {
    if (!state.slug) return null;
    const entry = {
      text: state.text,
      baseline: state.baseline,
      savedAt: new Date().toISOString().slice(0, 19) + 'Z'
    };
    state.drafts[state.slug] = entry;
    const persisted = storeDrafts();
    setSync('pending', persisted ? `草稿已留在本地：${pathFor(state.slug)}` : '浏览器不允许本地存储，草稿仅保留在当前页面。');
    renderAll();
    return entry;
  }

  function discard(slug) {
    delete state.drafts[slug];
    storeDrafts();
    if (state.slug === slug) {
      state.conflict = null;
      return reload();
    }
    renderAll();
    return null;
  }

  /** Push one draft. `force` is the explicit human decision to overwrite. */
  async function push(slug, { force = false } = {}) {
    const draft = state.drafts[slug] || (slug === state.slug
      ? { text: state.text, baseline: state.baseline } : null);
    if (!draft) {
      setSync('error', '没有可推送的草稿。');
      return null;
    }
    const problems = issues(draft.text, slug);
    if (problems.length && !force) {
      setSync('error', `先修正 ${problems.length} 处结构问题再推送：${problems[0]}`);
      if (slug === state.slug) renderEditor();
      return null;
    }
    try {
      adopt();
      const result = await repo.pushFile({
        path: pathFor(slug),
        content: draft.text,
        message: `docs(entities): 更新 ${slug} 条目`,
        baseline: draft.baseline,
        force
      });
      delete state.drafts[slug];
      storeDrafts();
      state.conflict = null;
      setSync('done', `已推送 ${pathFor(slug)}${result?.commit?.sha ? `（提交 ${short(result.commit.sha)}）` : ''}，` +
        '次日采集会重建索引，页面不会当场改数。');
      renderAll();
      return result;
    } catch (error) {
      if (error.conflict) {
        state.conflict = { sha: error.remoteSha, text: error.remoteText || '' };
        setSync('conflict', `推送已挡下：远端不是草稿建立时的版本（${short(error.remoteSha)}）。`);
        renderAll();
        return null;
      }
      setSync('error', `推送失败：${error.message}`);
      renderAll();
      return null;
    }
  }

  async function verify() {
    try {
      repo.requireToken();
    } catch (error) {
      setSync('error', error.message);
      return;
    }
    setSync('syncing', '正在校验 Token…');
    try {
      const user = await repo.verifyToken();
      setSync('idle', `已连接 ${user?.login || '未知账户'}，可回写注册表条目。`);
    } catch (error) {
      setSync('error', `校验失败：${error.message}`);
    }
  }

  function close() {
    state.slug = null;
    state.conflict = null;
    renderEditor();
  }

  function onFormInput(event) {
    state.text = event?.target ? event.target.value : $('entityFormText').value;
    renderEditor();
  }

  function bind() {
    $('entityFormText').addEventListener('input', onFormInput);
    $('entityFormSave').addEventListener('click', () => {
      if (state.slug) save();
    });
    $('entityFormPush').addEventListener('click', async () => {
      if (!state.slug) return;
      // Never escalated by the ordinary button: after a refusal, pushing again
      // refuses again. Only 明确覆盖并推送 may overwrite, and only once asked for.
      save();
      await push(state.slug);
    });
    $('entityFormDiscard').addEventListener('click', () => { if (state.slug) discard(state.slug); });
    $('entityFormClose').addEventListener('click', close);
    $('entityConflictReload').addEventListener('click', refresh);
    $('entityConflictKeepRemote').addEventListener('click', async () => {
      if (state.conflict) {
        state.text = state.conflict.text;
        state.baseline = state.conflict.sha;
        state.conflict = null;
        await discard(state.slug);
        setSync('idle', '已丢弃本地草稿，编辑的是远端原文。');
        renderAll();
      }
    });
    $('entityConflictForce').addEventListener('click', async () => {
      if (!state.slug) return;
      save();
      await push(state.slug, { force: true });
    });
    $('entityDraftList').addEventListener('click', async event => {
      const button = event.target.closest('button');
      if (!button) return;
      if (button.dataset.entityEdit) await open(button.dataset.entityEdit);
      else if (button.dataset.entityPush) await push(button.dataset.entityPush);
      else if (button.dataset.entityDiscard) await discard(button.dataset.entityDiscard);
    });
    $('entityToken').addEventListener('input', event => {
      repo.setToken(event.target.value);
      renderTokenField();
    });
    $('entityTokenVerify').addEventListener('click', verify);
    $('entityTokenClear').addEventListener('click', () => {
      repo.clearToken();
      renderTokenField();
      setSync('idle', 'Token 已从本地清除，回写暂不可用。');
    });
  }

  /** 「重读索引」：拉一次已发布快照，让页面上的状态与远端同步。 */
  async function refreshIndex() {
    try {
      await data.refreshEntitySnapshot();
      setSync('idle', '已重读注册表快照。');
    } catch (error) {
      setSync('error', `快照重读失败：${error.message}`);
    }
    renderAll();
    return null;
  }

  /**
   * Conflict choice 1: the draft was written against an index that has since
   * moved. Re-read both the published snapshot and the live source, and keep the
   * un-pushed text as a draft instead of dropping it - re-basing is not the same
   * as deciding to overwrite, and the author may still want those words.
   */
  async function refresh() {
    const draft = state.drafts[state.slug];
    const edited = state.text && (!draft || draft.text !== state.text);
    state.conflict = null;
    if (edited) save();
    await refreshIndex();
    await reload();
    if (edited) {
      setSync('idle', `已按远端最新版重新取基线；你未推送的改动另存为草稿，推送时照旧检查。`);
      renderAll();
    }
    return null;
  }

  async function init() {
    adopt();
    loadDrafts();
    bind();
    renderAll();
  }

  return {
    init, open, reload, save, push, discard, close, refresh, refreshIndex, onFormInput,
    issues, splitFrontmatter, pathFor, renderAll, renderDrafts, renderEditor, setSync, state
  };
})();
