/* Model Observatory — the task board's push panel.
 *
 * The canvas keeps semantic edits as a local overlay; this module is the step
 * that turns one overlay into `tasks/<slug>.md`. It reads the live source file
 * through MO.repo and writes back only the fields the card touched, so the prose
 * past the snapshot's cut survives a push - the index copy is a truncated view,
 * never the thing to edit.
 *
 * What it refuses, and why:
 *
 *   - no token: browsing, dragging, exporting and saving drafts all keep working.
 *   - an empty status: 未标注 is a lane, and `--check` fails the daily run on a
 *     file whose status the collector cannot read.
 *   - an edge whose other end is a card that only exists on this canvas: the
 *     collector would drop it tomorrow, so a lone push says "push the batch".
 *   - a remote that changed a field this draft also changed: the three choices
 *     below (按远端重做 / 以远端为准 / 明确覆盖) are the only ways past it, and
 *     overwriting needs a human to ask for it twice.
 */
window.MO = window.MO || {};

MO.tasksync = (() => {
  'use strict';

  const data = MO.data;
  const repo = MO.repo;
  const board = MO.board;
  const { esc, timestamp } = MO.format;

  const $ = id => document.getElementById(id);

  const COPY = { status: '状态', parent: '父任务', depends: '依赖' };
  const FIELD_ORDER = ['status', 'parent', 'depends'];

  const state = {
    conflict: null,
    preview: null,
    sync: { state: 'idle', message: '' },
    busy: false
  };

  function pathFor(slug) { return `tasks/${slug}.md`; }
  function short(sha) { return String(sha || '').slice(0, 7); }
  function today() { return new Date().toISOString().slice(0, 10); }

  /** Write back to the repository the collector indexed, not to a guess. */
  function adopt() {
    return repo.adopt(data.state.tasks?.source || {});
  }

  function editUrl(slug) {
    const { owner, name, branch } = repo.coordinates();
    return `https://github.com/${owner}/${name}/edit/${branch}/${pathFor(slug)}`;
  }

  // --- Sync panel ----------------------------------------------------------

  function setSync(name, message) {
    state.sync = { state: name, message };
    renderSync();
  }

  function renderSync() {
    const map = {
      idle: ['未推送', ''],
      pending: ['有草稿待推送', 'accent'],
      syncing: ['正在读写…', 'accent'],
      done: ['已推送', 'ok'],
      error: ['推送失败', 'warn'],
      conflict: ['远端已变', 'warn']
    };
    const [label, cls] = map[state.sync.state] || map.idle;
    $('taskSyncState').textContent = label;
    $('taskSyncState').className = `template-sync-state ${cls}`;
    $('taskSyncMessage').textContent = state.sync.message || '';
  }

  function renderTokenField() {
    const field = $('taskToken');
    if (field && document.activeElement !== field) field.value = repo.coordinates().token;
  }

  // --- Three-way: base vs remote vs draft ---------------------------------

  /**
   * What the card looked like before anybody edited it. The published index row
   * is that answer until this browser has read or written the file itself, after
   * which the last known remote state is the honest one - the index is a daily
   * photograph and can be a day behind.
   */
  function baseRow(slug) {
    return board.baseOf(slug) || data.taskRows().find(row => row.slug === slug) || null;
  }

  function sameValue(field, a, b) {
    if (field === 'depends') return (a || []).join(',') === (b || []).join(',');
    return (a || null) === (b || null);
  }

  /**
   * The fields where the remote moved away from the base - i.e. where somebody
   * edited this card after the version the draft was built on. Writing such a
   * field is a decision to overwrite them, so it is never taken quietly.
   */
  function fieldConflicts(patch, base, theirs) {
    if (!theirs || !base) return [];
    return FIELD_ORDER.filter(field => field in patch &&
      !sameValue(field, base[field], theirs[field]));
  }

  /**
   * Is the other end of this line something tomorrow's collector will find?
   *
   * A target inside the current batch counts as ready only once it has landed,
   * which is what makes 「按顺序推送全部」 write parents before the cards that point
   * at them: a referrer is re-queued to the next pass instead of shipping an edge
   * whose other end is still only in this browser.
   */
  function targetReady(slug, batch) {
    if (batch.has(slug)) return board.pushState(slug) === 'pushed';
    return board.isPublished(slug) || board.pushState(slug) === 'pushed';
  }

  function orphanTarget(patch, batch) {
    const targets = [];
    if (patch.parent) targets.push({ kind: 'parent', slug: patch.parent });
    (patch.depends || []).forEach(slug => targets.push({ kind: 'depends', slug }));
    return targets.find(target => !targetReady(target.slug, batch)) || null;
  }

  function commitMessage(patch, slug) {
    return patch.create ? `docs(tasks): 新建 ${slug} 任务卡` : `docs(tasks): 更新 ${slug} 任务卡`;
  }

  // --- Push ---------------------------------------------------------------

  /**
   * One card, one read, one write. Returns a status so `pushAll` can decide what
   * to retry; the caller renders the sentence.
   */
  async function pushOnce(slug, { batch = new Set(), force = false } = {}) {
    const patch = board.patchFor(slug);
    if (!patch) return { status: 'clean', slug };
    const base = baseRow(slug);
    const orphan = force ? null : orphanTarget(patch, batch);
    if (orphan) {
      return {
        status: 'orphan', slug, orphan,
        reason: `${slug} 的${orphan.kind === 'parent' ? '父任务' : '依赖'} ${orphan.slug} 还只在这块画布上：` +
          '单独推它会留下一条明天被采集器丢掉的边。用「按顺序推送全部」两张一起落库。'
      };
    }
    const file = await repo.readFile(pathFor(slug));
    if (patch.update && !file.exists) {
      return {
        status: 'missing', slug,
        reason: `远端已经没有 ${pathFor(slug)}，而索引里还有这条任务：它可能在最近一次索引之后被删除或改名。` +
          '这里不重建整份文件，请先在源文件里确认。'
      };
    }
    if (patch.create && file.exists) {
      return {
        status: 'exists', slug, file,
        reason: `远端已经有 tasks/${slug}.md（有人先建了同名文件）：这张本地卡不能覆盖它。` +
          '选「以远端为准」把本地卡并入它，或改个文件名再建。'
      };
    }
    const theirs = file.exists ? board.fieldsOf(file.text) : null;
    const collide = force ? [] : fieldConflicts(patch, base, theirs);
    if (collide.length) return { status: 'conflict', slug, patch, base, file, fields: collide };
    const composed = board.compose(patch, file.text, { at: today() });
    if (!composed.ok) return { status: 'refused', slug, reason: composed.reason };
    const result = await repo.pushFile({
      path: pathFor(slug),
      content: composed.text,
      message: commitMessage(patch, slug),
      baseline: file.sha,
      force
    });
    const commit = result?.commit?.sha || null;
    // The file this push wrote is now the version the next draft is compared
    // against; the index will only catch up with it tomorrow.
    board.setBase(slug, board.fieldsOf(composed.text));
    board.markPushed(slug, { commit, at: new Date().toISOString().slice(0, 19) + 'Z' });
    return { status: 'pushed', slug, commit, notes: composed.notes || [], path: pathFor(slug) };
  }

  function describePush(outcome) {
    if (outcome.status === 'pushed') {
      return `已推送 ${outcome.path}${board.commitLabel(outcome.commit)}：远端文件已改好，` +
        '次日采集会重建索引，在此之前卡片仍标「已推送 · 等索引」。' +
        (outcome.notes.length ? ` ${outcome.notes.join(' ')}` : '');
    }
    if (outcome.status === 'conflict') {
      return `${outcome.slug} 的${outcome.fields.map(name => COPY[name]).join('、')}在远端被改过，` +
        '推送已挡下：下面三选一，覆盖需要你明确点头。';
    }
    return outcome.reason;
  }

  /** Push one card and paint the result. */
  async function push(slug, { force = false, batch = new Set() } = {}) {
    if (state.busy) return null;
    adopt();
    try {
      repo.requireToken();
    } catch (error) {
      setSync('error', `${error.message}；画布、清单与导出照常，草稿仍留在本机。`);
      renderAll();
      return null;
    }
    state.busy = true;
    setSync('syncing', `正在读 ${pathFor(slug)} 并写回…`);
    let outcome = null;
    try {
      outcome = await pushOnce(slug, { batch, force });
    } catch (error) {
      if (error.conflict) {
        outcome = {
          status: 'conflict', slug, patch: board.patchFor(slug), fields: [], raced: true,
          file: { exists: true, sha: error.remoteSha, text: error.remoteText || '' }
        };
      } else {
        outcome = { status: 'error', slug, reason: `推送失败：${error.message}` };
      }
    } finally {
      state.busy = false;
    }
    if (outcome.status === 'conflict') {
      state.conflict = {
        slug: outcome.slug,
        fields: outcome.fields,
        raced: Boolean(outcome.raced),
        remoteSha: outcome.file?.sha || null,
        remoteText: outcome.file?.text || '',
        theirs: outcome.file?.exists ? board.fieldsOf(outcome.file.text) : null
      };
      setSync('conflict', describePush(outcome));
      renderAll();
      return outcome;
    }
    state.conflict = null;
    if (outcome.status === 'pushed') setSync('done', describePush(outcome));
    else if (outcome.status === 'clean') setSync('idle', `${slug} 与索引一致，没有要推的改动。`);
    else setSync('error', describePush(outcome));
    renderAll();
    return outcome;
  }

  /**
   * Push every pending card, parents first. A card whose target is still local is
   * re-queued instead of refused, so one click lands a whole decomposition - and
   * a conflict stops that card only, never the batch.
   */
  async function pushAll() {
    adopt();
    const queue = board.pendingSlugs();
    if (!queue.length) {
      setSync('idle', '没有待推送的卡片：画布上的改动要么已推送，要么根本没动过。');
      renderAll();
      return null;
    }
    try {
      repo.requireToken();
    } catch (error) {
      setSync('error', `${error.message}；${queue.length} 张卡的草稿仍留在本机。`);
      renderAll();
      return null;
    }
    const batch = new Set(queue);
    const done = [];
    const failed = [];
    let conflict = null;
    let remaining = queue.slice();
    state.busy = true;
    for (let pass = 0; pass <= queue.length && remaining.length; pass += 1) {
      const waiting = [];
      let moved = 0;
      for (const slug of remaining) {
        if (conflict) { waiting.push(slug); continue; }
        setSync('syncing', `正在推送 ${done.length + failed.length + 1} / ${queue.length}：${slug}…`);
        let outcome;
        try {
          outcome = await pushOnce(slug, { batch });
        } catch (error) {
          outcome = error.conflict
            ? { status: 'conflict', slug, fields: [], file: { exists: true, sha: error.remoteSha, text: error.remoteText || '' } }
            : { status: 'error', slug, reason: `推送失败：${error.message}` };
        }
        if (outcome.status === 'pushed') { done.push(slug); moved += 1; }
        else if (outcome.status === 'orphan') waiting.push(slug);
        else if (outcome.status === 'conflict') {
          conflict = {
            slug, fields: outcome.fields, remoteSha: outcome.file?.sha || null,
            remoteText: outcome.file?.text || '',
            theirs: outcome.file?.exists ? board.fieldsOf(outcome.file.text) : null
          };
        } else failed.push({ slug, reason: describePush(outcome) });
      }
      remaining = waiting;
      // Nothing landed and the rest only wait on each other: the canvas refuses a
      // cycle, so this is unreachable in practice - stop rather than spin.
      if (!moved) break;
    }
    state.busy = false;
    if (conflict) {
      state.conflict = conflict;
      setSync('conflict', `${conflict.slug} 挡住了批次：${done.length} 张已推送、` +
        `${failed.length + remaining.length} 张还没推。远端在那几个字段上被改过，三选一。`);
    } else if (done.length && !failed.length) {
      setSync('done', `已推送 ${done.length} 张卡：远端的 tasks/ 已更新，索引由次日采集重建，` +
        '页面在此之前不会当场改数。');
    } else if (done.length) {
      setSync('error', `已推送 ${done.length} 张，${failed.length} 张被挡下：${failed[0].reason}`);
    } else {
      setSync('error', failed.length ? failed[0].reason : '没有卡片被推送。');
    }
    renderAll();
    MO.render.showToast(describeBatch({ done, failed, conflict, remaining: remaining.length }));
    return { done, failed, conflict };
  }

  function describeBatch({ done, failed, conflict, remaining }) {
    const parts = [];
    if (done.length) parts.push(`${done.length} 张已推送`);
    if (conflict) parts.push(`${conflict.slug} 等一次三选`);
    if (failed.length) parts.push(`${failed.length} 张被挡下（${failed[0].reason.slice(0, 40)}…）`);
    if (remaining) parts.push(`${remaining} 张留待下一次`);
    return parts.length ? `批量推送：${parts.join(' · ')}` : '批量推送：没有卡片被改动。';
  }

  // --- Conflict choices ----------------------------------------------------

  /**
   * Choice 1 - 按远端重做. Re-read the index and the source, then drop the fields
   * the remote already has; what is left is still the author's draft, now based on
   * the version the repository actually holds.
   */
  async function rebase() {
    const conflict = state.conflict;
    if (!conflict) return null;
    adopt();
    setSync('syncing', '正在按远端最新版重做基线…');
    let file = null;
    try {
      await data.refreshTaskSnapshot();
      file = await repo.readFile(pathFor(conflict.slug));
    } catch (error) {
      setSync('error', `重读失败：${error.message}；草稿仍在本机。`);
      renderAll();
      return null;
    }
    const theirs = file.exists ? board.fieldsOf(file.text) : null;
    const patch = board.patchFor(conflict.slug);
    const settled = patch ? FIELD_ORDER.filter(field => field in patch && theirs &&
      sameValue(field, patch[field], theirs[field])) : [];
    if (settled.length) board.dropFields(conflict.slug, settled);
    // Re-basing means the remote as it stands now becomes what the next draft is
    // measured against; the fields still in the draft are then the author's own
    // change, and pushing replaces the remote with them - which is what the
    // 「仍是你自己的改动」 sentence says out loud instead of leaving as a surprise.
    if (theirs) board.setBase(conflict.slug, theirs);
    const mine = FIELD_ORDER.filter(field =>
      field in (board.patchFor(conflict.slug) || {}));
    state.conflict = null;
    setSync(mine.length ? 'pending' : 'idle',
      `已按远端重做基线：${settled.length
        ? `${settled.map(name => COPY[name]).join('、')} 远端已经是你要的值，已从草稿里去掉；` : ''}` +
      (mine.length ? `${mine.map(name => COPY[name]).join('、')} 仍是你的改动，推送时替换远端现在的内容。`
        : '这张卡没有本地改动要推了。'));
    renderAll();
    MO.render.renderTasks();
    return { settled, mine };
  }

  /** Choice 2 - 以远端为准. The local draft goes; the remote file is untouched. */
  function keepRemote() {
    const conflict = state.conflict;
    if (!conflict) return null;
    const result = board.discard(conflict.slug);
    state.conflict = null;
    setSync('idle', `已以远端为准：${conflict.slug} 的本机改动已丢弃` +
      `${result.note ? `。${result.note}` : '，远端文件一个字都没动。'}`);
    renderAll();
    MO.render.renderTasks();
    return result;
  }

  /** Choice 3 - 明确覆盖. The only path that wins a field over somebody else. */
  async function overwrite() {
    const conflict = state.conflict;
    if (!conflict) return null;
    const outcome = await push(conflict.slug, { force: true });
    if (outcome?.status === 'pushed') {
      MO.render.showToast(`已明确覆盖 ${conflict.slug}：远端那次的改动被这份草稿替掉了，` +
        `要回滚就去 ${pathFor(conflict.slug)} 的历史。`);
    }
    return outcome;
  }

  // --- Preview -------------------------------------------------------------

  /**
   * Show the exact bytes a push would write. Reading the source needs no token -
   * this is a public repository - so an author can check a draft before deciding
   * to hand over a credential.
   */
  async function preview(slug) {
    adopt();
    const patch = board.patchFor(slug);
    if (!patch) {
      state.preview = null;
      setSync('idle', `${slug} 没有本地改动，预览里没有可写的东西。`);
      renderAll();
      return null;
    }
    setSync('syncing', `正在读取 ${pathFor(slug)} 的远端原文…`);
    let file;
    try {
      file = await repo.readFile(pathFor(slug));
    } catch (error) {
      setSync('error', `预览需要读远端原文，这次没读到：${error.message}`);
      renderAll();
      return null;
    }
    const composed = board.compose(patch, file.text, { at: today() });
    if (!composed.ok) {
      state.preview = { slug, path: pathFor(slug), text: '', reason: composed.reason, notes: [] };
      setSync('error', composed.reason);
      renderAll();
      return null;
    }
    const theirs = file.exists ? board.fieldsOf(file.text) : null;
    const base = baseRow(slug);
    const collide = fieldConflicts(patch, base, theirs);
    state.preview = {
      slug, path: pathFor(slug), text: composed.text, notes: composed.notes || [],
      create: Boolean(patch.create), remoteExists: file.exists, remoteSha: file.sha,
      conflict: collide
    };
    setSync(collide.length ? 'conflict' : 'idle', collide.length
      ? `预览已生成，但 ${collide.map(name => COPY[name]).join('、')} 与远端冲突，推送会先要一次三选。`
      : `预览是 ${pathFor(slug)} 的远端原文加上这张卡的字段；正文取自远端，不是索引里的截断副本。`);
    renderAll();
    return composed;
  }

  function closePreview() {
    state.preview = null;
    renderPreview();
  }

  // --- Panel ---------------------------------------------------------------

  function draftLine(row) {
    const patch = board.patchFor(row.slug);
    const pending = board.pushState(row.slug) === 'pending';
    const receipt = board.pushedOf(row.slug);
    const described = MO.render.taskDraftDiff ? MO.render.taskDraftDiff(row, patch) : '';
    const diff = patch.create
      ? `新建 tasks/${row.slug}.md：${patch.title || row.title}`
      : (described || '字段与索引不同');
    const status = pending
      ? '待推送'
      : `已推送${board.commitLabel(receipt && receipt.commit)}，等次日索引重建`;
    return `<div class="entity-detail-item"><div class="entity-detail-text">` +
      `<div><code>${esc(row.slug)}</code> <span class="micro muted">${esc(row.title)}</span></div>` +
      `<div class="micro muted">${esc(diff)} · ${esc(status)}</div>` +
      `</div><div class="entity-detail-actions">` +
      `<button type="button" class="button secondary" data-task-preview="${esc(row.slug)}">预览原文</button>` +
      `<button type="button" class="button${pending ? '' : ' secondary'}" data-task-push="${esc(row.slug)}">` +
      `${pending ? '推送这张卡' : '再推一次'}</button>` +
      `<button type="button" class="button text-button" data-task-discard="${esc(row.slug)}">撤销本地改动</button>` +
      `<a class="button text-button" href="${esc(editUrl(row.slug))}" target="_blank" rel="noopener noreferrer">编辑源文件 ↗</a>` +
      `</div></div>`;
  }

  function renderDrafts() {
    const rows = board.rows().filter(row => row.dirty);
    const pending = board.pendingSlugs();
    $('taskDraftNote').textContent = rows.length
      ? `${pending.length} 张待推送 · ${rows.length - pending.length} 张已推送等索引重建。` +
        '推送只写这张卡的字段，正文与其余字段取自远端原文。'
      : '画布上没有语义改动：拖动卡片换到的道、连上的线都还没发生，索引里的一切照旧。';
    $('taskDraftList').innerHTML = rows.length
      ? rows.map(draftLine).join('')
      : '<div class="chart-empty">没有待推送或待索引的卡片</div>';
    $('taskPushAll').disabled = !pending.length || state.busy;
    $('taskPushAll').textContent = pending.length
      ? `按顺序推送全部（${pending.length}）` : '按顺序推送全部';
  }

  function renderPreview() {
    const box = $('taskPushBox');
    const preview = state.preview;
    if (!preview) {
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');
    $('taskPushPath').textContent = preview.path;
    $('taskPushText').textContent = preview.text || '（这次预览没有可写的内容）';
    $('taskPushEdit').setAttribute('href', editUrl(preview.slug));
    $('taskPushNote').textContent = [
      preview.create
        ? (preview.remoteExists ? '本地新建卡：远端已有同名文件，这次只写字段。' : '本地新建卡：推送会新建这个文件。')
        : (preview.remoteExists ? '更新已有文件：只替换 status / parent / depends 与 updated。' : '远端读不到这个文件，推送会被挡下。'),
      preview.conflict?.length ? `冲突字段：${preview.conflict.map(name => COPY[name]).join('、')}` : '',
      (preview.notes || []).join(' '),
      preview.reason || ''
    ].filter(Boolean).join(' ');
  }

  function renderConflict() {
    const box = $('taskPushConflict');
    const conflict = state.conflict;
    if (!conflict) {
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');
    const base = baseRow(conflict.slug);
    const patch = board.patchFor(conflict.slug) || {};
    const perField = (conflict.fields || []).map(name => {
      // A status reads as the lane word the card itself shows; a slug stays a
      // slug, because that is the string the author has to go and fix.
      const show = value => (name === 'depends' ? (value || []).join('、')
        : name === 'status' ? board.laneLabel(value) : value) || '（无）';
      return `${COPY[name]} — 基线 ${show(base?.[name])} / 远端 ${show(conflict.theirs?.[name])} / ` +
        `你的草稿 ${show(patch[name])}`;
    });
    $('taskConflictNote').textContent = conflict.raced
      ? `刚读完又变了：${conflict.slug} 的远端现在是 ${short(conflict.remoteSha)}，` +
        '草稿的基线对不上。重读一次通常就够了。'
      : `${conflict.slug}：这几个字段在最近一次索引之后被改过，按草稿推送会替掉那次改动。` +
        (perField.length ? ` ${perField.join('；')}` : '');
  }

  function renderAll() {
    renderDrafts();
    renderPreview();
    renderConflict();
    renderSync();
    renderTokenField();
  }

  function renderPanel() {
    // Before the first snapshot lands there is nothing to compare a draft with,
    // so the panel keeps its placeholder words instead of claiming "no drafts".
    if (!data.state.tasks && !board.draftSlugs().length) return;
    renderAll();
  }

  // --- Bindings ------------------------------------------------------------

  function bind() {
    $('taskToken').addEventListener('input', event => {
      repo.setToken(event.target.value);
      renderTokenField();
    });
    $('taskTokenVerify').addEventListener('click', async () => {
      try {
        repo.requireToken();
      } catch (error) {
        setSync('error', error.message);
        return;
      }
      setSync('syncing', '正在校验 Token…');
      try {
        const user = await repo.verifyToken();
        setSync('idle', `已连接 ${user?.login || '未知账户'}，可回写 tasks/ 下的任务卡。`);
      } catch (error) {
        setSync('error', `校验失败：${error.message}`);
      }
    });
    $('taskTokenClear').addEventListener('click', () => {
      repo.clearToken();
      renderTokenField();
      setSync('idle', 'Token 已从本标签页清除，推送暂不可用；草稿与预览不受影响。');
    });
    $('taskPushAll').addEventListener('click', pushAll);
    $('taskDraftList').addEventListener('click', async event => {
      const button = event.target.closest('button');
      if (!button) return;
      if (button.dataset.taskPreview) await preview(button.dataset.taskPreview);
      else if (button.dataset.taskPush) await push(button.dataset.taskPush);
      else if (button.dataset.taskDiscard) {
        const result = board.discard(button.dataset.taskDiscard);
        setSync('idle', result.ok
          ? `已丢弃 ${button.dataset.taskDiscard} 的本机改动${result.note ? `。${result.note}` : '。'}`
          : result.reason);
        renderAll();
        MO.render.renderTasks();
      }
    });
    $('taskPushClose').addEventListener('click', closePreview);
    $('taskConflictRebase').addEventListener('click', rebase);
    $('taskConflictKeepRemote').addEventListener('click', keepRemote);
    $('taskConflictForce').addEventListener('click', overwrite);
  }

  async function init() {
    adopt();
    board.load();
    bind();
    renderAll();
    return null;
  }

  return {
    init, bind, renderAll, renderPanel, renderDrafts, renderConflict, renderPreview, setSync,
    preview, closePreview, push, pushAll, rebase, keepRemote, overwrite,
    pathFor, fieldConflicts, orphanTarget, targetReady, commitMessage, pushOnce, describePush,
    sameValue, editUrl, state
  };
})();
