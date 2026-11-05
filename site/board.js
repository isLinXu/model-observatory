/* Model Observatory — the task board's canvas model.
 *
 * One task is one file (`tasks/<slug>.md`) and the daily collector owns what it
 * says. This module owns only what happens on the canvas: which lane a card is
 * dragged into, which line is drawn between two cards, and where a card sits.
 * It fetches nothing and writes nothing to GitHub - the write path is MO.repo's.
 *
 * Two rules keep the board honest:
 *
 *   1. Coordinates are local. Where a card sits says nothing about the work, so
 *      positions live in this browser's storage and never enter a commit.
 *   2. Semantic edits (status, parent, depends, a new card) are an overlay on
 *      top of the published snapshot. They stay marked as drafts until a push
 *      lands them in the repository, and a pushed card still says it is waiting
 *      for the index: the collector's own checks - the ones that call a reference
 *      断链 or 未核对 - have not seen it yet.
 *
 * Every reducer returns `{ok, reason, ...}` instead of throwing: a drag that
 * would create a cycle has to be refused *with a sentence*, on the spot, because
 * a line you cannot drag out of is worse than no line at all.
 */
window.MO = window.MO || {};

MO.board = (() => {
  'use strict';

  const data = MO.data;
  const repo = MO.repo;

  const EDIT_KEY = 'mo.board.edits';     // what the cards say, until they are pushed
  const LAYOUT_KEY = 'mo.board.layout';  // where the cards sit, forever local

  // Six states that describe the person doing the work, deliberately not the
  // registry's stages. `untriaged` is the lane a card lands in when the file has
  // no readable status - the collector publishes it as null rather than guessing.
  const STATUSES = ['proposal', 'doing', 'blocked', 'review', 'done', 'dropped'];
  const UNTRIAGED = 'untriaged';
  const LANES = STATUSES.concat(UNTRIAGED);
  const LANE_LABELS = {
    proposal: '提案', doing: '进行中', blocked: '受阻', review: '待验收',
    done: '已完成', dropped: '已放弃', untriaged: '未标注'
  };
  const SLUG_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
  const TITLE_LIMIT = 120;
  const POINT_LIMIT = 400;
  // The collector publishes at most this many depends per task; a longer list is
  // truncated there, so a canvas that allowed it would promise an edge tomorrow's
  // index does not have.
  const DEPENDS_LIMIT = 12;

  // Canvas geometry. A card is a fixed box so the edge layer can predict where
  // a line starts without measuring the DOM after every repaint.
  const CARD_W = 236;
  const CARD_H = 112;
  const LANE_W = 264;
  const LANE_GAP = 18;
  const PAD = 16;
  const HEAD_H = 44;
  const ROW_GAP = 14;

  const state = {
    edits: {},      // slug -> {status?, parent?, depends?}  (what the card wants)
    created: {},    // slug -> {title, status, parent, depends, tags}  (new files)
    pushed: {},     // slug -> {signature, at, commit}  (pushed, index not rebuilt yet)
    bases: {},      // slug -> {status, parent, depends}  (the remote as last read)
    layout: {},     // slug -> {x, y}  (never pushed)
    storageWarning: ''
  };

  // --- Vocabulary -----------------------------------------------------------

  function laneOf(status) {
    return STATUSES.includes(status) ? status : UNTRIAGED;
  }

  function laneLabel(lane) {
    return LANE_LABELS[lane] || lane;
  }

  function refusal(reason) {
    return { ok: false, reason, changed: false };
  }

  // --- Storage --------------------------------------------------------------

  function plain(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function load() {
    // One record for the semantic overlay (edits, new cards, push receipts and
    // the remote fields they were checked against), one for the layout: the
    // first is a draft waiting for its push, the second is furniture.
    const overlay = plain(repo.readLocal(EDIT_KEY, {}));
    state.edits = plain(overlay.edits);
    state.created = plain(overlay.created);
    state.pushed = plain(overlay.pushed);
    // A flat record from before `bases` existed is still a valid overlay; the
    // merge base simply falls back to the published index until the next read.
    state.bases = plain(overlay.bases);
    state.layout = plain(repo.readLocal(LAYOUT_KEY, {}));
    return state;
  }

  function persist() {
    const stored = repo.writeLocal(EDIT_KEY, {
      edits: state.edits, created: state.created, pushed: state.pushed, bases: state.bases
    });
    const keptLayout = repo.writeLocal(LAYOUT_KEY, state.layout);
    state.storageWarning = !stored || !keptLayout
      ? '浏览器不允许本地存储，画布上的改动只保留在当前页面，刷新即失。' : '';
    return stored && keptLayout;
  }

  // --- Rows: published snapshot plus the local overlay ----------------------

  /** One published task, or one card that only exists here so far. */
  function isDraft(slug) {
    return Boolean(state.created[slug]);
  }

  /** Does the index know this task, i.e. is there a `tasks/<slug>.md` to point at? */
  function isPublished(slug) {
    return data.taskRows().some(row => row.slug === slug);
  }

  function patchOf(slug) {
    return state.edits[slug] || null;
  }

  /**
   * The overlay applied to the collector's rows. Derived fields (the reference
   * states, the counts) still come from the index, so a dirty card says which
   * numbers were checked and which ones are still just what the author typed.
   */
  function rows() {
    const published = data.taskRows().map(row => {
      const patch = patchOf(row.slug);
      if (!patch) {
        return { ...row, lane: laneOf(row.status), draft: false, dirty: false, localOnly: false };
      }
      const next = { ...row };
      if ('status' in patch) next.status = patch.status;
      if ('parent' in patch) next.parent = patch.parent;
      if ('depends' in patch) next.depends = patch.depends;
      next.lane = laneOf(next.status);
      return {
        ...next,
        draft: true,
        dirty: true,
        localOnly: false,
        // A card can be pushed and still dirty: the file on GitHub has the change
        // while the index has not been rebuilt, so the canvas keeps showing it and
        // says which of the two it is waiting for.
        pushed: pushState(row.slug) === 'pushed',
        // What the index still believes about this card, so the panel can show
        // 进行中 → 待验收 instead of only the half the author touched.
        was: { status: row.status, parent: row.parent, depends: row.depends }
      };
    });
    const fresh = Object.entries(state.created).map(([slug, task]) => {
      const pushed = pushState(slug) === 'pushed';
      return {
        slug,
        title: task.title || slug,
        status: task.status || null,
        parent: task.parent || null,
        depends: (Array.isArray(task.depends) ? task.depends : []).slice(),
        tags: (Array.isArray(task.tags) ? task.tags : []).slice(),
        entity: task.entity || null,
        ddl: task.ddl || null,
        entityState: null,
        ddlState: null,
        reason: task.reason || null,
        updated: task.updated || null,
        lane: laneOf(task.status || null),
        draft: true,
        dirty: true,
        localOnly: true,
        pushed,
        bytes: 0,
        lines: 0,
        sha: '',
        blobSha: '',
        truncated: false,
        // There is no file to point at before the push; after it the card should
        // say where the thing it became lives.
        url: pushed ? `https://github.com/${repo.coordinates().owner}/` +
          `${repo.coordinates().name}/blob/${repo.coordinates().branch}/tasks/${slug}.md` : null,
        body: typeof task.body === 'string' ? task.body : ''
      };
    });
    return published.concat(fresh);
  }

  function findRow(slug, list = rows()) {
    return list.find(row => row.slug === slug) || null;
  }

  // --- Graph: two independent questions -------------------------------------

  /**
   * Can `start` already reach `target` through these edges? If so, adding
   * target -> start closes a loop, and a loop cannot be dragged out of on a
   * canvas - the collector drops the same edge, so the page must not draw it.
   */
  function reaches(adjacency, start, target) {
    const seen = new Set();
    const stack = [start];
    while (stack.length) {
      const node = stack.pop();
      if (node === target) return true;
      if (seen.has(node)) continue;
      seen.add(node);
      (adjacency[node] || []).forEach(next => stack.push(next));
    }
    return false;
  }

  /**
   * Would this edge survive the collector? Same three refusals, same reasons,
   * so a line drawn here is a line that will still be there tomorrow.
   */
  function edgeCheck(kind, from, to, list = rows()) {
    if (!from || !to) return refusal('缺少一端：这条线还没有连上任何卡片。');
    if (from === to) return refusal(`${from} 不能连到自己。`);
    const slugs = new Set(list.map(row => row.slug));
    if (!slugs.has(to)) return refusal(`目标 ${to} 不在看板上。`);
    if (!slugs.has(from)) return refusal(`${from} 不在看板上。`);
    const adjacency = {};
    for (const row of list) {
      if (kind === 'parent' && row.parent) (adjacency[row.slug] = adjacency[row.slug] || []).push(row.parent);
      if (kind === 'depends') row.depends.forEach(target => {
        (adjacency[row.slug] = adjacency[row.slug] || []).push(target);
      });
    }
    if (reaches(adjacency, to, from)) {
      return refusal(`${to} 已经能回到 ${from}，这条线会成环，画布上拖不出来。`);
    }
    return { ok: true, reason: '', changed: true };
  }

  /**
   * Both graphs at once, with what was dropped and why. `dropped` is what the
   * card has to show: a refused line is the author's unfinished sentence, not a
   * rendering bug.
   */
  function graph(list = rows()) {
    const edges = [];
    const dropped = [];
    const slugs = new Set(list.map(row => row.slug));
    const graphs = { parent: {}, depends: {} };

    const offer = (kind, from, to) => {
      const check = edgeCheck(kind, from, to, list);
      if (!check.ok) {
        dropped.push({ from, to, type: kind, reason: check.reason });
        return;
      }
      (graphs[kind][from] = graphs[kind][from] || []).push(to);
      edges.push({ from, to, type: kind });
    };

    list.forEach(row => { if (row.parent) offer('parent', row.slug, row.parent); });
    list.forEach(row => row.depends.forEach(target => offer('depends', row.slug, target)));
    return {
      edges,
      dropped,
      known: slugs.size,
      // A parent that points at nothing is a broken line, not an empty canvas.
      missingParents: list.filter(row => row.parent && !slugs.has(row.parent)).length
    };
  }

  /** Children of `slug`, so a card can say what it was split into. */
  function childrenOf(slug, list = rows()) {
    return list.filter(row => row.parent === slug).map(row => row.slug);
  }

  /** Who waits on `slug`, so a blocked card can name what it is blocking. */
  function blockersOf(slug, list = rows()) {
    return list.filter(row => row.depends.includes(slug)).map(row => row.slug);
  }

  // --- Reducers -------------------------------------------------------------

  function write(slug, patch) {
    const next = { ...(state.edits[slug] || {}), ...patch };
    // A field put back the way the index has it is not a change. Dropping it here
    // is what keeps "3 处本地改动" honest after a card is dragged out and back.
    const published = data.taskRows().find(row => row.slug === slug);
    ['status', 'parent', 'depends'].forEach(field => {
      if (!published || !(field in patch)) return;
      const wanted = published[field];
      const now = next[field];
      const same = field === 'depends'
        ? Array.isArray(now) && now.join(',') === (wanted || []).join(',')
        : now === wanted;
      if (same) delete next[field];
    });
    if (Object.keys(next).length) state.edits[slug] = next; else delete state.edits[slug];
  }

  function setStatus(slug, lane, { at = null } = {}) {
    if (!LANES.includes(lane)) return refusal(`状态「${lane}」不属于六态词表。`);
    const row = findRow(slug);
    if (!row) return refusal(`任务 ${slug} 不在看板上。`);
    if (row.lane === lane) return { ok: true, changed: false, reason: '', slug, lane };
    const status = lane === UNTRIAGED ? null : lane;
    if (row.localOnly) state.created[slug] = { ...state.created[slug], status };
    else write(slug, { status });
    persist();
    return { ok: true, changed: true, reason: '', slug, lane };
  }

  /** 拆解：把一张卡挂到另一张卡下面。一个任务只有一个父亲，所以这是替换。 */
  function setParent(slug, parent) {
    const row = findRow(slug);
    if (!row) return refusal(`任务 ${slug} 不在看板上。`);
    if (!parent) {
      if (!row.parent) return { ok: true, changed: false, reason: '', slug, parent: null };
      if (row.localOnly) delete state.created[slug].parent; else write(slug, { parent: null });
      persist();
      return { ok: true, changed: true, reason: '', slug, parent: null };
    }
    const check = edgeCheck('parent', slug, parent);
    if (!check.ok) return check;
    if (row.parent === parent) return { ok: true, changed: false, reason: '', slug, parent };
    if (row.localOnly) state.created[slug].parent = parent; else write(slug, { parent });
    persist();
    return { ok: true, changed: true, reason: '', slug, parent };
  }

  /** 连接：这张图等那张图做完。depends 是一张清单，所以是追加。 */
  function connect(slug, target) {
    const row = findRow(slug);
    if (!row) return refusal(`任务 ${slug} 不在看板上。`);
    const check = edgeCheck('depends', slug, target);
    if (!check.ok) return check;
    if (row.depends.includes(target)) return { ok: true, changed: false, reason: '', slug, target };
    const depends = row.depends.concat(target);
    if (row.localOnly) state.created[slug].depends = depends; else write(slug, { depends });
    persist();
    return { ok: true, changed: true, reason: '', slug, target };
  }

  function disconnect(slug, target) {
    const row = findRow(slug);
    if (!row) return refusal(`任务 ${slug} 不在看板上。`);
    if (!row.depends.includes(target)) return { ok: true, changed: false, reason: '', slug, target };
    const depends = row.depends.filter(item => item !== target);
    if (row.localOnly) state.created[slug].depends = depends; else write(slug, { depends });
    persist();
    return { ok: true, changed: true, reason: '', slug, target };
  }

  /**
   * A new card is created here, but it is a file only after a push. The slug is
   * the filename, so the same rule the collector applies to names applies now -
   * a Chinese title is fine, but it has to pick its own latin slug.
   *
   * `body` is for a card created *from a row of another board*: such a card
   * starts life with one fact it did not invent (where the row came from), and
   * a heading alone would make the reader re-derive it.
   */
  function create({ slug, title = '', status = 'proposal', parent = null, body = '' } = {}) {
    const clean = String(slug || '').trim().toLowerCase();
    if (!SLUG_PATTERN.test(clean)) {
      return refusal('文件名需为小写字母、数字与连字符（例如 task-board-canvas）。');
    }
    if (data.taskRows().some(row => row.slug === clean) || state.created[clean]) {
      return refusal(`${clean} 已经在看板上。`);
    }
    const heading = String(title || '').trim().slice(0, TITLE_LIMIT) || clean;
    if (parent) {
      const provisional = rows().concat([{ slug: clean, depends: [], parent: null }]);
      const check = edgeCheck('parent', clean, parent, provisional);
      if (!check.ok) return check;
    }
    state.created[clean] = {
      slug: clean, title: heading, status, parent: parent || null,
      depends: [], tags: [], body: (String(body || '').trim() || `# ${heading}`).trimEnd() + '\n',
      updated: new Date().toISOString().slice(0, 10)
    };
    persist();
    return { ok: true, changed: true, reason: '', slug: clean };
  }

  /** Remove a card *from the canvas*: local drafts vanish, published work does not. */
  function discard(slug) {
    const receipt = state.pushed[slug];
    if (state.created[slug]) {
      delete state.created[slug];
      delete state.edits[slug];
      delete state.layout[slug];
      delete state.pushed[slug];
      persist();
      return {
        ok: true, changed: true, reason: '', slug,
        note: receipt ? `这张新卡已经推过一次${commitLabel(receipt.commit)}：本机不再显示它，` +
          `远端的 tasks/${slug}.md 仍在，要删它得改源文件。` : ''
      };
    }
    if (state.edits[slug]) {
      delete state.edits[slug];
      delete state.pushed[slug];
      persist();
      return {
        ok: true, changed: true, reason: '', slug,
        note: receipt ? `本机的改动记录清掉了；${commitLabel(receipt.commit)}那次提交仍在远端。` : ''
      };
    }
    return refusal('索引里的任务不会被画布删除：那要改动 tasks/ 下的源文件。');
  }

  function resetEdits() {
    state.edits = {};
    state.created = {};
    state.pushed = {};
    persist();
    return { ok: true, changed: true, reason: '' };
  }

  function resetLayout() {
    state.layout = {};
    persist();
    return { ok: true, changed: true, reason: '' };
  }

  // --- Layout ---------------------------------------------------------------

  function positionOf(slug) {
    const stored = state.layout[slug];
    if (stored && Number.isFinite(stored.x) && Number.isFinite(stored.y)) {
      return { x: stored.x, y: stored.y };
    }
    return null;
  }

  function laneX(index) {
    return PAD + index * (LANE_W + LANE_GAP);
  }

  function laneCenter(lane) {
    return laneX(LANES.indexOf(lane)) + (LANE_W - CARD_W) / 2;
  }

  /**
   * Where a card lands when nothing was dragged: stacked inside its lane, newest
   * first. A stored position wins over this, which is what makes the canvas
   * someone's own arrangement instead of a table wearing a costume.
   */
  function autoPosition(row, index, taken) {
    const x = laneCenter(row.lane);
    let y = HEAD_H + PAD + index * (CARD_H + ROW_GAP);
    // Skip slots another card already holds in this lane, so a manual layout and
    // a fresh card never sit on top of each other.
    while ([...taken].some(other => Math.abs(other.y - y) < 4 && Math.abs(other.x - x) < 4)) {
      y += CARD_H + ROW_GAP;
    }
    return { x, y };
  }

  /**
   * Cards with coordinates, lanes with headers, and the canvas size that holds
   * them. Pure: the same rows in give the same boxes out, which is what lets a
   * test assert the geometry instead of eyeballing a screenshot.
   */
  function layout(list = rows()) {
    const perLane = {};
    list.forEach(row => {
      const lane = LANES.includes(row.lane) ? row.lane : UNTRIAGED;
      (perLane[lane] = perLane[lane] || []).push(row);
    });
    const taken = [];
    const cards = [];
    LANES.forEach((lane, index) => {
      const rowsInLane = (perLane[lane] || []).slice().sort((a, b) =>
        String(b.updated || '').localeCompare(String(a.updated || '')) || a.slug.localeCompare(b.slug));
      rowsInLane.forEach((row, position) => {
        const fallback = autoPosition(row, position, taken);
        const point = positionOf(row.slug) || fallback;
        taken.push(point);
        cards.push({
          slug: row.slug, lane, x: point.x, y: point.y, w: CARD_W, h: CARD_H,
          stored: Boolean(positionOf(row.slug))
        });
      });
    });
    const lanes = LANES.map((lane, index) => ({
      id: lane, label: laneLabel(lane), x: laneX(index), w: LANE_W,
      count: (perLane[lane] || []).length
    })).filter(lane => lane.count || lane.id !== UNTRIAGED);
    const width = PAD * 2 + LANES.length * LANE_W + (LANES.length - 1) * LANE_GAP;
    const height = cards.reduce((max, card) => Math.max(max, card.y + card.h), HEAD_H + PAD) + PAD;
    return { lanes, cards, width, height: Math.max(height, HEAD_H + PAD * 2 + CARD_H),
      cardWidth: CARD_W, cardHeight: CARD_H, laneWidth: LANE_W };
  }

  /** The next free slot in a lane, used when a card is dropped into it. */
  function slotIn(lane, cards, except = null) {
    const x = laneCenter(lane);
    const used = cards.filter(card => card.slug !== except && Math.abs(card.x - x) < LANE_W / 2)
      .map(card => card.y);
    let y = HEAD_H + PAD;
    while (used.some(other => Math.abs(other - y) < CARD_H)) y += CARD_H + ROW_GAP;
    return { x, y };
  }

  /** Which lane a canvas x falls in, including the gaps between lanes. */
  function laneAt(x) {
    const index = Math.min(LANES.length - 1, Math.max(0, Math.floor((x - PAD) / (LANE_W + LANE_GAP))));
    return LANES[index];
  }

  /** The card under a point - how a drop decides between a lane and a parent. */
  function hitCard(point, cards = layout().cards, except = null) {
    const hit = cards.find(card => card.slug !== except &&
      point.x >= card.x && point.x <= card.x + CARD_W &&
      point.y >= card.y && point.y <= card.y + CARD_H);
    return hit ? hit.slug : null;
  }

  /** Free-drag result: a clamped coordinate and the lane that coordinate falls in. */
  function move(slug, point) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return refusal('座标无效：卡片只能落在画布内。');
    }
    const box = layout();
    state.layout[slug] = {
      x: Math.round(Math.min(Math.max(point.x, PAD), Math.max(PAD, box.width - PAD - CARD_W))),
      y: Math.round(Math.max(point.y, HEAD_H))
    };
    persist();
    return { ok: true, changed: true, reason: '', slug, lane: laneAt(point.x) };
  }

  // --- Edges: geometry ------------------------------------------------------

  /**
   * Anchor points on the two boxes. Dominant axis decides which sides meet, so
   * a same-lane pair joins vertically instead of drawing a line through the
   * lane header, and a long horizontal link leaves from the facing sides.
   */
  function anchors(a, b) {
    const acx = a.x + a.w / 2;
    const acy = a.y + a.h / 2;
    const bcx = b.x + b.w / 2;
    const bcy = b.y + b.h / 2;
    if (Math.abs(bcx - acx) >= Math.abs(bcy - acy)) {
      return bcx > acx
        ? { x1: a.x + a.w, y1: acy, x2: b.x, y2: bcy, side: 'right' }
        : { x1: a.x, y1: acy, x2: b.x + b.w, y2: bcy, side: 'left' };
    }
    return bcy > acy
      ? { x1: acx, y1: a.y + a.h, x2: bcx, y2: b.y, side: 'down' }
      : { x1: acx, y1: a.y, x2: bcx, y2: b.y + b.h, side: 'up' };
  }

  /** A cubic curve between two cards - deterministic, so it can be tested. */
  function edgeCurve(a, b) {
    const { x1, y1, x2, y2, side } = anchors(a, b);
    const vertical = side === 'up' || side === 'down';
    const pull = Math.min(120, (vertical ? Math.abs(y2 - y1) : Math.abs(x2 - x1)) / 2 + 24);
    const c1 = vertical ? { x: x1, y: y1 + (side === 'down' ? pull : -pull) }
      : { x: x1 + (side === 'right' ? pull : -pull), y: y1 };
    const c2 = vertical ? { x: x2, y: y2 + (side === 'down' ? -pull : pull) }
      : { x: x2 + (side === 'right' ? -pull : pull), y: y2 };
    const round = value => Math.round(value * 100) / 100;
    return {
      d: `M ${round(x1)} ${round(y1)} C ${round(c1.x)} ${round(c1.y)}, ` +
        `${round(c2.x)} ${round(c2.y)}, ${round(x2)} ${round(y2)}`,
      x1, y1, x2, y2, midX: round((x1 + x2) / 2), midY: round((y1 + y2) / 2)
    };
  }

  /**
   * Every drawable line, already carrying its curve. `cards` is the *visible*
   * subset: a line whose other end is filtered out is counted, not drawn,
   * because a stroke into empty canvas reads as a bug in the board.
   */
  function edges(list = rows(), cards = null) {
    const cardOf = {};
    (cards || layout(list).cards).forEach(card => { cardOf[card.slug] = card; });
    const lines = [];
    let hidden = 0;
    graph(list).edges.forEach(edge => {
      const a = cardOf[edge.from];
      const b = cardOf[edge.to];
      if (!a || !b) { hidden += 1; return; }
      lines.push({ ...edge, ...edgeCurve(a, b),
        draft: isDraft(edge.from) || Boolean(patchOf(edge.from)) });
    });
    return { lines, hidden };
  }

  /** Lines this canvas refused, plus the collector's own dropped edges. */
  function droppedEdges(list = rows()) {
    return graph(list).dropped;
  }

  // --- Draft accounting -----------------------------------------------------

  function commitLabel(sha) {
    return sha ? `（提交 ${String(sha).slice(0, 7)}）` : '';
  }

  function draftSlugs() {
    return [...new Set(Object.keys(state.edits).concat(Object.keys(state.created)))];
  }

  /**
   * What a push would change about this card, as one string. A successful push
   * records it, so the panel can tell 「已推送，等次日索引」 apart from 「还没推」 -
   * and a further drag after a push makes the card pending again by itself.
   */
  function patchSignature(slug) {
    const patch = patchFor(slug);
    if (!patch) return '';
    return ['title', 'status', 'parent', 'depends', 'entity', 'ddl', 'reason']
      .map(field => `${field}=${Array.isArray(patch[field]) ? patch[field].join(',') : (patch[field] ?? '')}`)
      .join(';');
  }

  function pushState(slug) {
    const signature = patchSignature(slug);
    if (!signature) return 'clean';
    const receipt = state.pushed[slug];
    return receipt && receipt.signature === signature ? 'pushed' : 'pending';
  }

  function pendingSlugs() {
    return draftSlugs().filter(slug => pushState(slug) === 'pending');
  }

  function pushedSlugs() {
    return draftSlugs().filter(slug => pushState(slug) === 'pushed');
  }

  function markPushed(slug, { commit = null, at = null } = {}) {
    state.pushed[slug] = { signature: patchSignature(slug), commit, at };
    persist();
    return state.pushed[slug];
  }

  function pushedOf(slug) {
    return state.pushed[slug] || null;
  }

  /**
   * The remote's own fields, as this browser last read or wrote them.
   *
   * A conflict is a *three-way* question - what the draft wants against what the
   * file says, with the index as the point they diverged from. Once that index is
   * a day behind, comparing against it forever would make every card need an
   * explicit overwrite until the daily run catches up, so the last known remote
   * state is kept here and used as the merge base instead. It is written after a
   * successful push and after a rebase, never by a drag.
   */
  function setBase(slug, fields) {
    state.bases[slug] = fields;
    persist();
    return fields;
  }

  function baseOf(slug) {
    return state.bases[slug] || null;
  }

  /**
   * Fields the remote already has. After a rebase a draft stops claiming a change
   * it no longer makes, so 「3 处本地改动」 never counts a field somebody else set
   * for us in the meantime.
   */
  function dropFields(slug, names) {
    const patch = state.edits[slug];
    if (!patch) return refusal(`任务 ${slug} 没有本地改动。`);
    const next = { ...patch };
    const dropped = [];
    names.forEach(name => {
      if (name in next) { delete next[name]; dropped.push(name); }
    });
    if (Object.keys(next).length) state.edits[slug] = next; else delete state.edits[slug];
    persist();
    return { ok: true, changed: dropped.length > 0, reason: '', slug, dropped,
      left: Object.keys(next) };
  }

  function draftSummary() {
    const pending = pendingSlugs();
    return {
      edited: Object.keys(state.edits).length,
      created: Object.keys(state.created).length,
      total: draftSlugs().length,
      pending: pending.length,
      waiting: pushedSlugs().length,
      positions: Object.keys(state.layout).length,
      warning: state.storageWarning
    };
  }

  /**
   * The fields a push has to write for one card. `MO.tasksync` turns this into the
   * front matter of `tasks/<slug>.md`, so the canvas never has to guess how a task
   * is spelled on disk - it only says what it changed.
   */
  function patchFor(slug) {
    const created = state.created[slug];
    if (created) return { ...created, create: true };
    const patch = patchOf(slug);
    if (!patch) return null;
    return { slug, ...patch, update: true };
  }

  // --- The file a push writes ----------------------------------------------
  // Pure text: this board never fetches, so `sourceText` is handed in by
  // MO.tasksync straight after it read the live file.

  const FILE_KEYS = ['title', 'status', 'parent', 'depends', 'entity', 'ddl', 'tags', 'updated', 'reason'];
  const inlineList = list => `[${(list || []).join(', ')}]`;

  function splitFile(text) {
    const lines = String(text || '').split('\n');
    if ((lines[0] || '').trim() !== '---') return null;
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (end < 0) return null;
    return { head: lines.slice(1, end), body: lines.slice(end + 1).join('\n') };
  }

  /**
   * The three fields the canvas owns, read back out of a file. Only the inline
   * `key: value` shape matters here: the `- item` block is folded away by
   * `setField` when it replaces that key, and the collector reads both.
   */
  function fieldsOf(text) {
    const parts = splitFile(text);
    if (!parts) return null;
    const out = { status: null, parent: null, depends: [] };
    let pending = null;
    for (const line of parts.head) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) { pending = null; continue; }
      if (trimmed.startsWith('- ')) {
        if (pending === 'depends') out.depends.push(trimmed.slice(2).trim());
        continue;
      }
      const [key, ...rest] = trimmed.split(':');
      const name = key.trim().toLowerCase();
      const value = rest.join(':').trim();
      pending = name;
      if (name === 'status') out.status = value || null;
      if (name === 'parent') out.parent = value || null;
      if (name === 'depends') out.depends = value.replace(/^\[|\]/g, '').split(/[,\s]+/).filter(Boolean);
    }
    return out;
  }

  /** Replace one front-matter key, or drop it when `value` is null. */
  function setField(lines, name, value) {
    const out = [];
    let index = 0;
    let placed = false;
    while (index < lines.length) {
      const line = lines[index];
      const trimmed = line.trim();
      const isTarget = trimmed.includes(':') && !trimmed.startsWith('- ') && !trimmed.startsWith('#')
        && trimmed.split(':')[0].trim().toLowerCase() === name;
      if (isTarget) {
        let next = index + 1;
        while (next < lines.length && lines[next].trim().startsWith('- ')) next += 1;
        if (value !== null && value !== undefined) {
          out.push(`${name}: ${value}`);
          placed = true;
        }
        index = next;
        continue;
      }
      out.push(line);
      index += 1;
    }
    if (!placed && value !== null && value !== undefined) out.push(`${name}: ${value}`);
    return out;
  }

  /**
   * The whole file one push would write.
   *
   * A draft only names the fields the canvas touched, so everything else is
   * copied from the *live* source rather than from the snapshot: the index keeps a
   * truncated copy of the prose, and pushing that copy back would delete the
   * author's notes past the cut. `updated` moves with the edit because that is the
   * date the collector's own changelog reads - a card whose date stayed behind
   * claims nothing happened.
   */
  function compose(patch, sourceText = '', { at = null } = {}) {
    const slug = String(patch.slug || '');
    if (!SLUG_PATTERN.test(slug)) {
      return refusal(`文件名「${slug}」需为小写字母、数字与连字符，不能写成路径或中文。`);
    }
    const stamp = at || new Date().toISOString().slice(0, 10);
    const notes = [];
    let head;
    let body;
    if (patch.create) {
      const parts = sourceText ? splitFile(sourceText) : null;
      if (sourceText && !parts) {
        // Somebody else made this file between the click and the push. Its prose
        // is worth more than a local card, so this is an update now - and says so.
        return refusal(`远端已经有 tasks/${slug}.md，但它没有 --- front matter：` +
          '这里不覆盖一份采集器读不到的文件。');
      }
      head = parts ? parts.head.slice() : [];
      // The card's own note, not a second copy of its title: `create` already
      // writes the heading, and a file with two of them reads as a template.
      body = parts ? parts.body
        : (String(patch.body || '').trim() || `# ${patch.title || slug}`).trimEnd() + '\n';
      if (parts) notes.push('远端已有同名文件：这次只把卡片字段写进它的原文，本地新建的正文没有覆盖过去。');
      if (!head.length && !String(patch.title || '').trim()) {
        return refusal('新建卡没有标题：文件名会当作标题写进 title:，先想好这个名字。');
      }
    } else {
      const parts = splitFile(sourceText);
      if (!parts) {
        return refusal(`远端的 tasks/${slug}.md 读不到 --- front matter（或已被删除）：` +
          '先修正源文件，这里不重写整份正文。');
      }
      head = parts.head.slice();
      body = parts.body;
    }
    // 未标注 is a lane, not a state on disk: an empty `status:` is a structural
    // error for `--check`, so a push refuses rather than breaking the daily run.
    if ('status' in patch && !patch.status) {
      return refusal(`「${laneLabel(UNTRIAGED)}」是画布上的道，不是能写进文件的状态：` +
        `把 ${slug} 拖回六态之一再推（空 status 会被 CI 的结构检查判为错误）。`);
    }
    if ('status' in patch) head = setField(head, 'status', patch.status || null);
    if ('parent' in patch) head = setField(head, 'parent', patch.parent || null);
    if ('depends' in patch) head = setField(head, 'depends', inlineList(patch.depends));
    if (patch.create) {
      head = setField(head, 'title', patch.title || slug);
      if (patch.entity) head = setField(head, 'entity', patch.entity);
      if (patch.ddl) head = setField(head, 'ddl', patch.ddl);
      if (Array.isArray(patch.tags) && patch.tags.length) head = setField(head, 'tags', inlineList(patch.tags));
    }
    if (Array.isArray(patch.depends) && patch.depends.length > DEPENDS_LIMIT) {
      return refusal(`depends 写了 ${patch.depends.length} 条，超过采集器发布的 ${DEPENDS_LIMIT} 条上限：先拆掉几个。`);
    }
    head = setField(head, 'updated', stamp);
    const text = `---\n${head.join('\n')}\n---\n\n${String(body || '').replace(/^\n+/, '')}`;
    if (fieldsOf(text).status === 'blocked' &&
        !/^[ \t]*reason:/m.test(head.join('\n'))) {
      notes.push('受阻卡没有 reason:：索引会显示受阻，但卡片上不会出现 ⚑ 说明。');
    }
    const unknown = head
      .filter(line => line.trim() && !line.trim().startsWith('#') && !line.trim().startsWith('- ') &&
        line.trim().includes(':') && !FILE_KEYS.includes(line.trim().split(':')[0].trim().toLowerCase()))
      .map(line => line.trim().split(':')[0].trim());
    if (unknown.length) notes.push(`采集器不读这些字段：${unknown.join(' / ')}（保留在文件里，不受本次推送影响）。`);
    return { ok: true, changed: true, reason: '', text, notes, slug };
  }

  /**
   * Which card's detail is open. The render layer reads this straight from the
   * shared data state, so a canvas click and a list row's 「详情」 button are
   * the same action and cannot disagree about what is open.
   */
  function select(slug) {
    data.state.taskOpen = data.state.taskOpen === slug ? null : slug;
    return data.state.taskOpen;
  }

  function clearSelection() {
    data.state.taskOpen = null;
  }

  return {
    STATUSES, LANES, UNTRIAGED, LANE_LABELS, EDIT_KEY, LAYOUT_KEY,
    DEPENDS_LIMIT, FILE_KEYS,
    geometry: { CARD_W, CARD_H, LANE_W, LANE_GAP, PAD, HEAD_H, ROW_GAP },
    state, load, rows, findRow, graph, edges, anchors, edgeCurve,
    layout, move, slotIn, laneOf, laneLabel, laneCenter, laneX, laneAt, hitCard, positionOf,
    setStatus, setParent, connect, disconnect, create, discard,
    resetEdits, resetLayout, patchFor, draftSlugs, draftSummary,
    pendingSlugs, pushedSlugs, pushState, markPushed, pushedOf, setBase, baseOf,
    dropFields, patchSignature,
    compose, fieldsOf, splitFile, setField, commitLabel,
    childrenOf, blockersOf, isDraft, isPublished, patchOf, select, clearSelection, persist
  };
})();
