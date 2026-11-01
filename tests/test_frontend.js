const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadData(fetch, globals = {}) {
  const context = { console: { ...console, warn() {} }, fetch, URL, AbortSignal, ...globals };
  context.window = context;
  vm.createContext(context);
  const filename = path.join(__dirname, '..', 'site', 'data.js');
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return context.MO.data;
}

function configureSocial(data, snapshots, platforms = 'all') {
  data.state.social = {
    sources: [
      { id: 'github', followers: snapshots.at(-1)?.followers.github ?? null },
      { id: 'bilibili', followers: snapshots.at(-1)?.followers.bilibili ?? null }
    ]
  };
  data.state.socialSnapshots = snapshots;
  data.state.socialPlatforms = platforms;
}

test('social net change compares the exact UTC baseline', () => {
  const data = loadData();
  configureSocial(data, [
    { date: '2026-09-30', followers: { github: 150, bilibili: 80 } },
    { date: '2026-10-30', followers: { github: 200, bilibili: 100 } }
  ]);
  assert.deepEqual({ ...data.socialNetChange(30) }, { value: 70, compared: 2, baseline: '2026-09-30' });
});

test('social net change does not substitute another date for a missing baseline', () => {
  const data = loadData();
  configureSocial(data, [
    { date: '2026-09-29', followers: { github: 150 } },
    { date: '2026-10-30', followers: { github: 200 } }
  ]);
  assert.equal(data.socialNetChange(30), null);
});

test('social net change only compares platforms present in both snapshots', () => {
  const data = loadData();
  configureSocial(data, [
    { date: '2026-09-30', followers: { github: 150, bilibili: 80 } },
    { date: '2026-10-30', followers: { github: 200 } }
  ]);
  assert.deepEqual({ ...data.socialNetChange(30) }, { value: 50, compared: 1, baseline: '2026-09-30' });
});

test('single-platform social series honors snapshot range', () => {
  const data = loadData();
  const snapshots = Array.from({ length: 40 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
    followers: { github: index + 1 }
  }));
  configureSocial(data, snapshots, 'github');
  assert.equal(data.socialSeries('30').length, 30);
  assert.equal(data.socialSeries('30')[0].date, '2026-01-11');
  assert.equal(data.socialSeries('all').length, 40);
});

test('social series skips incomplete totals and preserves legitimate zeroes', () => {
  const data = loadData();
  configureSocial(data, [
    { date: '2026-10-28', followers: { github: 10, bilibili: 5 } },
    { date: '2026-10-29', followers: { github: 11 } },
    { date: '2026-10-30', followers: { github: 0, bilibili: 0 } }
  ]);
  assert.deepEqual(data.socialSeries('all').map(point => point.value), [15, 0]);
});

test('secondary panels finish loading when download data fails', async () => {
  const payloads = {
    './data/latest.json': { error: true },
    './data/history.json': { schema_version: 3, author: 'gatilin', snapshots: [] },
    './data/scholar.json': { profile_id: 'scholar', metrics: {}, papers: [] },
    './data/scholar_history.json': { snapshots: [{ date: '2026-10-30' }] },
    './data/social.json': { sources: [{ id: 'github', followers: 10 }] },
    './data/social_history.json': { snapshots: [{ date: '2026-10-30', followers: { github: 10 } }] },
    './data/github.json': { account: { login: 'isLinXu' }, repositories: [] },
    './data/github_history.json': { snapshots: [{ date: '2026-10-30', followers: 10 }] }
  };
  const fetch = async url => ({
    ok: !payloads[url]?.error,
    status: payloads[url]?.error ? 500 : 200,
    json: async () => payloads[url]
  });
  const data = loadData(fetch);
  await assert.rejects(data.loadAll(), /下载数据 读取失败/);
  assert.equal(data.state.scholar.profile_id, 'scholar');
  assert.equal(data.state.social.sources[0].id, 'github');
  assert.equal(data.state.github.account.login, 'isLinXu');
});

test('live model discovery follows pagination and replaces the published list', async () => {
  const firstPage = 'https://huggingface.co/api/models?author=gatilin&limit=100&expand=downloads';
  const secondPage = `${firstPage}&cursor=next`;
  const requested = [];
  const pages = {
    [firstPage]: [
      { id: 'gatilin/new-model', downloads: 4, downloadsAllTime: 9, likes: 0, pipeline_tag: 'text-generation', createdAt: '2026-10-24T01:00:00.000Z', private: false },
      { id: 'gatilin/private-model', private: true },
      { id: 'other/not-mine', private: false }
    ],
    [secondPage]: [{ id: 'gatilin/existing', downloads: 2, downloadsAllTime: 7, likes: 1, private: false }]
  };
  const fetch = async url => {
    requested.push(url);
    return {
      ok: true,
      status: 200,
      headers: { get: name => name === 'Link' && !url.includes('cursor=') ? `<${secondPage}>; rel="next"` : null },
      json: async () => pages[url.includes('cursor=') ? secondPage : firstPage]
    };
  };
  const data = loadData(fetch);
  data.state.latest = { author: 'gatilin', models: [{ id: 'gatilin/stale' }], datasets: [] };
  await data.refreshLiveModels();
  assert.equal(requested.length, 2);
  assert.match(requested[0], /expand=downloadsAllTime/);
  assert.equal(requested[1], secondPage);
  assert.deepEqual(Array.from(data.state.latest.models, model => model.id), ['gatilin/existing', 'gatilin/new-model']);
  assert.equal(data.state.latest.models[1].all_time, 9);
  assert.equal(data.state.latest.models[1].last_30d, 4);
  assert.equal(data.state.latest.models[1].url, 'https://huggingface.co/gatilin/new-model');
  assert.equal(data.state.modelSource, 'live');
});

test('live model failure keeps the published snapshot usable', async () => {
  const payloads = {
    './data/latest.json': { schema_version: 3, author: 'gatilin', captured_at: '2026-10-23T02:23:00Z', models: [{ id: 'gatilin/published' }], datasets: [] },
    './data/history.json': { schema_version: 3, author: 'gatilin', snapshots: [{ date: '2026-10-23', models: { 'gatilin/published': [7, 2] } }] },
    './data/scholar.json': { metrics: {}, papers: [] },
    './data/scholar_history.json': { snapshots: [] },
    './data/social.json': { sources: [] },
    './data/social_history.json': { snapshots: [] },
    './data/github.json': { account: {}, repositories: [] },
    './data/github_history.json': { snapshots: [] }
  };
  const fetch = async url => url.startsWith('https://huggingface.co/')
    ? { ok: false, status: 429, json: async () => ({}) }
    : { ok: true, status: 200, json: async () => payloads[url] };
  const data = loadData(fetch);
  await data.loadAll();
  assert.equal(data.state.latest.models[0].id, 'gatilin/published');
  assert.equal(data.state.modelSource, 'snapshot');
  assert.match(data.state.modelRefreshError, /429/);
});

const collectionListUrl = 'https://huggingface.co/api/collections?owner=gatilin&limit=100';
const collectionDetailUrl = slug => `https://huggingface.co/api/collections/${slug}`;
const plain = value => JSON.parse(JSON.stringify(value));
const idsOf = models => Array.from(models, model => model.id);

function jsonResponse(body, { status = 200, link = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => name.toLowerCase() === 'link' ? link : null },
    json: async () => body
  };
}

function rawCollection(slug, items = [], extra = {}) {
  return { slug, title: slug, owner: { name: 'gatilin' }, private: false, items, ...extra };
}

function collectionSnapshot(items = []) {
  return { status: 'ok', captured_at: '2026-10-20T01:02:03Z', error: null, items };
}

function seedCollections(data, items = []) {
  data.state.latest = { author: 'gatilin', models: [], datasets: [] };
  data.state.collections = collectionSnapshot(items);
  return data.state.collections;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const nextTurn = () => new Promise(resolve => setImmediate(resolve));

function testClock(iso = '2026-10-30T12:00:00.000Z') {
  let now = Date.parse(iso);
  return {
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    },
    advance(milliseconds) { now += milliseconds; },
    iso() { return new Date(now).toISOString(); }
  };
}

test('collections paginate previews, fetch each unique detail once, and cap concurrency at four', async () => {
  const secondPage = `${collectionListUrl}&cursor=next`;
  const slugs = Array.from({ length: 6 }, (_, index) => `gatilin/group-${index}`);
  const members = Array.from({ length: 6 }, (_, index) => ({ id: `gatilin/model-${index}`, type: 'model' }));
  const requested = [];
  let active = 0, peak = 0;
  const data = loadData(async url => {
    requested.push(url);
    if (url === collectionListUrl) {
      return jsonResponse([
        ...slugs.slice(0, 3).map(slug => rawCollection(slug, members.slice(0, 4))),
        rawCollection('gatilin/private', [], { private: true })
      ], { link: `<${secondPage}>; rel="next"` });
    }
    if (url === secondPage) {
      return jsonResponse(slugs.slice(2).map(slug => rawCollection(slug, members.slice(0, 4))));
    }
    const slug = slugs.find(slug => collectionDetailUrl(slug) === url);
    assert.ok(slug, `Unexpected request: ${url}`);
    active++;
    peak = Math.max(peak, active);
    await nextTurn();
    active--;
    return jsonResponse(rawCollection(slug, slug === slugs[0] ? members : []));
  });
  const previous = seedCollections(data);
  data.state.collectionRefreshError = 'old failure';
  const result = await data.refreshCollections();
  assert.deepEqual(requested.slice(0, 2), [collectionListUrl, secondPage]);
  assert.equal(peak, 4);
  assert.equal(requested.length, 8);
  for (const slug of slugs) assert.equal(requested.filter(url => url === collectionDetailUrl(slug)).length, 1);
  assert.equal(result, data.state.collections);
  assert.notEqual(result, previous);
  assert.equal(result.status, 'ok');
  assert.equal(result.error, null);
  assert.notEqual(result.captured_at, previous.captured_at);
  assert.ok(Number.isFinite(Date.parse(result.captured_at)));
  assert.equal(result.items.length, 6);
  assert.deepEqual(idsOf(result.items[0].items), idsOf(members));
  assert.equal(data.state.collectionSource, 'live');
  assert.equal(data.state.collectionRefreshError, null);
});

test('collection details skip private members, preserve plain-text notes, and use nested slugs', async () => {
  const slug = 'gatilin/notes';
  const note = '<img src=x onerror="alert(1)"> & **not markup**\nsecond line';
  const detail = rawCollection(slug, [
    { id: 'gatilin/a', type: 'model', note: { text: note } },
    { id: 'gatilin/a', type: 'model', note: { text: 'duplicate' } },
    { id: 'gatilin/secret', type: 'model', private: true },
    { private: true },
    { id: 'gatilin/a', type: 'dataset', note: { text: 'Dataset note' } },
    { id: 'database-object-id', slug: 'gatilin/nested', type: 'collection', note: { text: 'Navigation' } },
    { slug: 'gatilin/slug-only', type: 'collection' },
    { id: 'gatilin/b', type: 'model', note: 'not the API note schema' },
    { id: 'gatilin/c', type: 'model', note: { text: 42 } }
  ], { title: 'Notes', description: 'Plain description', lastUpdated: '2026-10-29T12:00:00Z' });
  const data = loadData(async url => {
    assert.ok([collectionListUrl, collectionDetailUrl(slug)].includes(url));
    return jsonResponse(url === collectionListUrl ? [rawCollection(slug)] : detail);
  });
  seedCollections(data);
  await data.refreshCollections();
  assert.deepEqual(plain(data.state.collections.items), [{
    slug, title: 'Notes', description: 'Plain description', updated_at: '2026-10-29T12:00:00Z',
    items: [
      { id: 'gatilin/a', type: 'model', note },
      { id: 'gatilin/a', type: 'dataset', note: 'Dataset note' },
      { id: 'gatilin/nested', type: 'collection', note: 'Navigation' },
      { id: 'gatilin/slug-only', type: 'collection', note: '' },
      { id: 'gatilin/b', type: 'model', note: '' },
      { id: 'gatilin/c', type: 'model', note: '' }
    ]
  }]);
  data.state.latest.models = ['a', 'b', 'c', 'secret', 'nested', 'slug-only'].map(name => ({ id: `gatilin/${name}` }));
  assert.deepEqual(idsOf(data.modelScope(slug)), ['gatilin/a', 'gatilin/b', 'gatilin/c']);
  assert.equal(data.modelCollections('gatilin/nested').length, 0);
  assert.equal(data.modelCollections('gatilin/secret').length, 0);
  const view = loadModelView(data);
  data.state.model = 'gatilin/a';
  view.render.renderDetail();
  assert.ok(view.element('detailContents').innerHTML.includes(view.context.MO.format.esc(note)));
  assert.doesNotMatch(view.element('detailContents').innerHTML, /<img|<strong>not markup/);
});

test('partial or invalid detail refreshes leave the prior collection object and timestamp untouched', async t => {
  const failures = [
    ['missing items', detail => jsonResponse({ ...detail, items: undefined }), /格式不完整/],
    ['malformed items', detail => jsonResponse({ ...detail, items: {} }), /格式不完整/],
    ['malformed member', detail => jsonResponse({ ...detail, items: [{ type: 'model' }] }), /成员格式不完整/],
    ['wrong owner', detail => jsonResponse({ ...detail, owner: { name: 'other' } }), /格式不完整/],
    ['private detail', detail => jsonResponse({ ...detail, private: true }), /格式不完整/],
    ['wrong slug', detail => jsonResponse({ ...detail, slug: 'gatilin/different' }), /与请求不一致/],
    ['HTTP error', () => jsonResponse({}, { status: 503 }), /503/],
    ['invalid JSON', () => ({ ...jsonResponse(null), json: async () => { throw new SyntaxError('invalid JSON'); } }), /invalid JSON/],
    ['network error', () => { throw new Error('offline'); }, /offline/]
  ];
  for (const [name, fail, expected] of failures) await t.test(name, async () => {
    const slugs = Array.from({ length: 5 }, (_, index) => `gatilin/new-${index}`);
    const requested = [];
    const data = loadData(async url => {
      requested.push(url);
      if (url === collectionListUrl) return jsonResponse(slugs.map(slug => rawCollection(slug)));
      const slug = slugs.find(slug => collectionDetailUrl(slug) === url);
      assert.ok(slug, `Unexpected request: ${url}`);
      const detail = rawCollection(slug, [{ id: 'gatilin/new', type: 'model' }]);
      return slug === slugs.at(-1) ? fail(detail) : jsonResponse(detail);
    });
    const previous = seedCollections(data, [{ slug: 'gatilin/old', title: 'Old', items: [] }]);
    const before = plain(previous);
    data.state.modelCollection = 'gatilin/old';
    await assert.rejects(data.refreshCollections(), expected);
    assert.equal(requested.length, 6, 'failure occurs after a complete batch of four details');
    assert.equal(data.state.collections, previous);
    assert.deepEqual(plain(previous), before);
    assert.equal(data.state.collections.captured_at, '2026-10-20T01:02:03Z');
    assert.equal(data.state.collectionSource, 'snapshot');
    assert.equal(data.state.modelCollection, 'gatilin/old');
    assert.match(data.state.collectionRefreshError, expected);
  });
});

test('collection pagination rejects unsafe and looping Link targets before fetching them again', async t => {
  const targets = [
    ['foreign origin', 'https://example.org/api/collections?owner=gatilin', /地址无效/],
    ['protocol-relative foreign origin', '//example.org/api/collections', /地址无效/],
    ['insecure protocol', 'http://huggingface.co/api/collections', /地址无效/],
    ['wrong endpoint', 'https://huggingface.co/api/models?author=gatilin', /地址无效/],
    ['detail endpoint', collectionDetailUrl('gatilin/group'), /地址无效/],
    ['self loop', collectionListUrl, /循环/],
    ['two-page loop', `${collectionListUrl}&cursor=next`, /循环/]
  ];
  for (const [name, target, expected] of targets) await t.test(name, async () => {
    const requested = [];
    const data = loadData(async url => {
      requested.push(url);
      assert.ok(requested.length <= 2, 'pagination must stop instead of retrying');
      return jsonResponse([rawCollection('gatilin/group')], {
        link: `<${url === collectionListUrl ? target : collectionListUrl}>; rel="next"`
      });
    });
    const previous = seedCollections(data);
    await assert.rejects(data.refreshCollections(), expected);
    assert.deepEqual(requested, name === 'two-page loop' ? [collectionListUrl, target] : [collectionListUrl]);
    assert.equal(data.state.collections, previous);
    assert.equal(previous.captured_at, '2026-10-20T01:02:03Z');
    assert.match(data.state.collectionRefreshError, expected);
  });
});

test('zero public collections is a successful refresh and resets a removed selected slug', async t => {
  for (const privateOnly of [false, true]) await t.test(privateOnly ? 'private collections only' : 'empty list', async () => {
    const requested = [];
    const data = loadData(async url => {
      requested.push(url);
      return jsonResponse(privateOnly ? [rawCollection('gatilin/private', [], { private: true })] : []);
    });
    const previous = seedCollections(data, [{ slug: 'gatilin/removed', title: 'Removed', items: [] }]);
    data.state.latest.models = [{ id: 'gatilin/a' }];
    data.state.modelCollection = 'gatilin/removed';
    data.state.collectionRefreshError = 'previous failure';
    await data.refreshCollections();
    assert.deepEqual(requested, [collectionListUrl]);
    assert.notEqual(data.state.collections, previous);
    assert.equal(data.state.collections.status, 'ok');
    assert.equal(data.state.collections.error, null);
    assert.equal(data.state.collectionRefreshError, null);
    assert.equal(data.state.collectionSource, 'live');
    assert.equal(data.collectionsAvailable(), true);
    assert.equal(data.state.modelCollection, 'all');
    assert.equal(data.state.collections.items.length, 0);
    assert.deepEqual(idsOf(data.modelScope('unassigned')), ['gatilin/a']);
  });
});

test('unavailable collection data never classifies all current models as unassigned', () => {
  const data = loadData();
  seedCollections(data);
  data.state.latest.models = [{ id: 'gatilin/a' }];
  for (const collections of [null, { status: 'unavailable', captured_at: null, error: 'offline', items: [] }]) {
    data.state.collections = collections;
    assert.equal(data.collectionsAvailable(), false);
    assert.deepEqual(idsOf(data.modelScope('all')), ['gatilin/a']);
    for (const scope of ['unassigned', 'gatilin/unknown']) {
      data.state.modelCollection = scope;
      assert.deepEqual(idsOf(data.modelScope()), []);
      assert.equal(data.modelScopeIds().size, 0);
      assert.deepEqual(idsOf(data.filteredModels()), []);
    }
  }
});

function configureCollectionModels(data) {
  const member = (id, type = 'model') => ({ id: `gatilin/${id}`, type, note: '' });
  const group = (name, items) => ({ slug: `gatilin/${name}`, title: name, description: '', updated_at: null, items });
  seedCollections(data, [
    group('a', [member('alpha'), member('alpha'), member('zero'), member('missing'),
      { id: 'other/external', type: 'model', note: '' }, member('dataset-only', 'dataset')]),
    group('b', [member('alpha')]),
    group('navigation', [member('a', 'collection'), member('alpha', 'collection')]),
    group('datasets', [member('alpha', 'dataset'), member('dataset-only', 'dataset')]),
    group('zero-only', [member('zero')]),
    group('missing-only', [member('missing')])
  ]);
  data.state.latest.models = [
    { id: 'gatilin/alpha', all_time: 10, last_30d: null },
    { id: 'gatilin/zero', all_time: 0, last_30d: 0 },
    { id: 'gatilin/missing', all_time: null },
    { id: 'gatilin/dataset-only', all_time: 4, last_30d: 1 },
    { id: 'gatilin/loose', all_time: 20, last_30d: 6 }
  ];
  data.state.latest.datasets = [{ id: 'gatilin/alpha', all_time: 99999, last_30d: 999 }];
}

test('collection scopes deduplicate overlapping current models and ignore external, dataset and navigation entries', () => {
  const data = loadData();
  configureCollectionModels(data);
  assert.deepEqual(idsOf(data.modelScope('a')), [], 'unknown slug is not a title lookup');
  assert.deepEqual(idsOf(data.modelScope('gatilin/a')), ['gatilin/alpha', 'gatilin/zero', 'gatilin/missing']);
  assert.deepEqual(idsOf(data.modelScope('gatilin/b')), ['gatilin/alpha']);
  assert.deepEqual(Array.from(data.modelCollections('gatilin/alpha'), group => group.slug), ['gatilin/a', 'gatilin/b']);
  assert.deepEqual(idsOf(data.modelScope('gatilin/navigation')), []);
  assert.deepEqual(idsOf(data.modelScope('gatilin/datasets')), []);
  assert.deepEqual(idsOf(data.modelScope('unassigned')), ['gatilin/dataset-only', 'gatilin/loose']);
  assert.equal(data.modelScope('all').length, 5);
  assert.equal(new Set(idsOf(data.modelScope('all'))).size, 5);
  assert.equal(data.modelScopeIds(), null);
  data.state.modelCollection = 'gatilin/a';
  assert.deepEqual(Array.from(data.modelScopeIds()), ['gatilin/alpha', 'gatilin/zero', 'gatilin/missing']);
  data.state.collections.status = 'stale';
  assert.equal(data.collectionsAvailable(), true);
  assert.equal(data.modelScope().length, 3, 'stale but complete membership remains usable');
});

test('collection totals distinguish missing measurements from genuine zero and count each model once', () => {
  const data = loadData();
  configureCollectionModels(data);
  const expected = {
    all: { count: 5, all_time: { value: 34, known: 4 }, last_30d: { value: 7, known: 3 } },
    'gatilin/a': { count: 3, all_time: { value: 10, known: 2 }, last_30d: { value: 0, known: 1 } },
    'gatilin/zero-only': { count: 1, all_time: { value: 0, known: 1 }, last_30d: { value: 0, known: 1 } },
    'gatilin/missing-only': { count: 1, all_time: { value: null, known: 0 }, last_30d: { value: null, known: 0 } },
    'gatilin/navigation': { count: 0, all_time: { value: null, known: 0 }, last_30d: { value: null, known: 0 } }
  };
  for (const [scope, stats] of Object.entries(expected)) assert.deepEqual(plain(data.collectionStats(scope)), stats, scope);
});

test('scoped history sums and deltas use current membership, retaining negative changes and missing rows', () => {
  const data = loadData();
  configureCollectionModels(data);
  data.state.modelCollection = 'gatilin/a';
  data.state.snapshots = [
    { date: '2026-10-27', models: {
      'gatilin/alpha': [20, 5], 'gatilin/zero': [0, 0], 'gatilin/missing': [null, null],
      'gatilin/loose': [30, 2], 'gatilin/removed': [1000, 100], 'other/external': [400, 40]
    }, datasets: { 'gatilin/alpha': [100, 10], 'gatilin/loose': [999, 10] } },
    { date: '2026-10-28', models: {
      'gatilin/alpha': [15, 3], 'gatilin/zero': [0, 0], 'gatilin/missing': [null, 7],
      'gatilin/loose': [35, 4], 'gatilin/dataset-only': [4, 1]
    }, datasets: { 'gatilin/alpha': [90, 0], 'gatilin/loose': [999, 10] } },
    { date: '2026-10-29', models: { 'gatilin/loose': [40, 8], 'gatilin/missing': [null, null] } },
    { date: '2026-10-30', models: { 'gatilin/zero': [0, 0], 'gatilin/missing': [null, null], 'gatilin/removed': [900, 90] } },
    { date: '2026-10-31' }
  ];
  const ids = data.modelScopeIds();
  const [older, newer, missing, zero] = data.state.snapshots;
  assert.deepEqual(plain(data.sumSeries('models', 'all_time', 'all', ids)), [
    { date: older.date, value: 20 }, { date: newer.date, value: 15 }, { date: zero.date, value: 0 }
  ]);
  assert.deepEqual(Array.from(data.sumSeries('models', 'last_30d', 'all', ids), point => point.value), [5, 10, 0]);
  assert.deepEqual(plain(data.sumSeries('models', 'all_time', '2', ids)), [{ date: zero.date, value: 0 }]);
  assert.equal(data.sumSeries('models', 'all_time', 'all', new Set()).length, 0);
  assert.equal(data.sumSeries('models', 'all_time')[0].value, 1450, 'omitted scope still includes historical models');
  assert.deepEqual(plain(data.netChange(newer, older, 'models', ids)), { value: -5, compared: 2, revised: 1 });
  assert.deepEqual(plain(data.netChange(zero, newer, 'models', ids)), { value: 0, compared: 1, revised: 0 });
  assert.deepEqual(plain(data.netChange(missing, newer, 'models', ids)), { value: null, compared: 0, revised: 0 });
  assert.deepEqual(plain(data.netChange(newer, older, 'models', new Set())), { value: null, compared: 0, revised: 0 });
  assert.equal(data.netChange(newer, null, 'models', ids), null);
  assert.equal(data.netChange(null, older, 'models', ids), null);
  assert.deepEqual(plain(data.netChange(newer, older)), { value: 0, compared: 3, revised: 1 });
  assert.deepEqual(Array.from(data.sumSeries('datasets', 'all_time', 'all', ids), point => point.value), [100, 90]);
  assert.deepEqual(plain(data.netChange(newer, older, 'datasets', ids)), { value: -10, compared: 1, revised: 1 });
  data.state.collections.items[0].items = [{ id: 'gatilin/zero', type: 'model', note: '' }];
  assert.deepEqual(Array.from(data.sumSeries('models', 'all_time', 'all', data.modelScopeIds()), point => point.value), [0, 0, 0]);
  assert.deepEqual(plain(data.netChange(newer, older, 'models', data.modelScopeIds())), { value: 0, compared: 1, revised: 0 });
});

// Minimal DOM and download sink: run the actual renderer and app event bindings,
// while leaving unrelated panels, chart drawing, and boot-time networking out.
function loadModelView(data, globals = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      innerHTML: '', textContent: '', value: '', events: {}, attributes: {}, disabled: false,
      dataset: {},
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(type, listener) { this.events[type] = listener; },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      getAttribute(name) { return this.attributes[name] ?? null; },
      removeAttribute(name) { delete this.attributes[name]; },
      click() {}, remove() {}
    });
    return elements.get(id);
  };
  const blobs = [];
  const context = {
    console,
    MO: { data, charts: { line() {} } },
    document: {
      getElementById: element, querySelectorAll: () => [], addEventListener() {},
      createElement: () => ({ click() {}, remove() {} }), body: { append() {} }
    },
    Blob,
    URL: { createObjectURL(blob) { blobs.push(blob); return 'blob:local-test'; }, revokeObjectURL() {} },
    setTimeout(callback) { callback(); },
    ...globals
  };
  context.window = context;
  vm.createContext(context);
  const run = name => {
    const filename = path.join(__dirname, '..', 'site', name);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  };
  run('format.js');
  run('render.js');
  return { context, element, blobs, run, render: context.MO.render };
}

test('year bars define their shared gradient only once', () => {
  const view = loadModelView(loadData());
  view.run('charts.js');
  const node = view.element('yearChart');
  view.context.MO.charts.yearBars(node, [
    { year: 2024, citations: 10 }, { year: 2025, citations: 20 }, { year: 2026, citations: 30 }
  ]);
  const definitions = [...node.innerHTML.matchAll(/<linearGradient id="([^"]+)"/g)];
  assert.equal(definitions.length, 1);
  const fills = [...node.innerHTML.matchAll(/fill="url\(#([^)]+)\)"/g)];
  assert.equal(fills.length, 3);
  assert.ok(fills.every(fill => fill[1] === definitions[0][1]));
});

test('closing model details restores focus before hiding the overlay', async () => {
  const data = loadData();
  data.state.latest = { models: [{ id: 'gatilin/A' }] };
  const view = loadModelView({ ...data, loadAll: async () => {}, refreshModelScope: async () => {} });
  const document = view.context.document;
  const shell = { inert: false };
  class Element {
    focus() {
      assert.equal(shell.inert, false);
      document.activeElement = this;
    }
  }
  const trigger = new Element();
  document.activeElement = trigger;
  document.body.style = {};
  document.querySelector = () => shell;
  view.context.HTMLElement = Element;
  view.element('closeDetail').focus = () => { document.activeElement = view.element('closeDetail'); };
  const hidden = [];
  view.element('detailOverlay').setAttribute = (name, value) => {
    if (name === 'aria-hidden' && value === 'true') {
      assert.equal(document.activeElement, trigger);
      assert.equal(shell.inert, false);
      hidden.push(value);
    }
  };
  const booted = deferred();
  view.context.MO.theme = { init() {} };
  view.context.MO.templates = { init: async () => { booted.resolve(); } };
  view.context.MO.render = Object.fromEntries(Object.keys(view.render).map(name => [name, () => {}]));
  view.run('app.js');
  await booted.promise;
  view.element('modelRows').events.click({ target: {
    closest: selector => selector === 'button[data-detail]' ? { dataset: { detail: 'gatilin/A' } } : null
  } });
  assert.equal(shell.inert, true);
  assert.equal(document.activeElement, view.element('closeDetail'));
  view.element('closeDetail').onclick();
  assert.deepEqual(hidden, ['true']);
  assert.equal(data.state.model, null);
  assert.equal(document.body.style.overflow, '');
});

test('model table and CSV both use filteredModels with search, collection scope, sorting and anomalies', async () => {
  const data = loadData();
  const names = ['keep-z', 'keep-a', 'keep-ok', 'other', 'keep-outside', 'keep-unknown'];
  const rolling = [20, 10, 100, 200, 999, null];
  const totals = [100, 50, 10, 5, 9, null];
  seedCollections(data, [{
    slug: 'gatilin/selected', title: 'Selected', description: '', updated_at: null,
    items: names.filter(name => name !== 'keep-outside').map(name => ({ id: `gatilin/${name}`, type: 'model', note: '' }))
  }]);
  data.state.latest.date = '2026-10-30';
  data.state.latest.models = names.map((name, index) => ({
    id: `gatilin/${name}`, all_time: totals[index], last_30d: rolling[index]
  }));
  data.state.snapshots = [
    { date: '2026-10-29', models: Object.fromEntries(names.map(name => [`gatilin/${name}`, name === 'keep-unknown' ? [null, null] : [200, 0]])) },
    { date: '2026-10-30', models: Object.fromEntries(names.map((name, index) => [`gatilin/${name}`, [name === 'keep-ok' ? 300 : totals[index], rolling[index]]])) }
  ];
  data.state.snapshotMap = new Map(data.state.snapshots.map(snapshot => [snapshot.date, snapshot]));
  let filterCalls = 0;
  const viewData = {
    ...data,
    loadAll: async () => {},
    refreshModelScope: async () => {},
    filteredModels() { filterCalls++; return data.filteredModels(); }
  };
  const view = loadModelView(viewData);
  const booted = deferred();
  view.context.MO.theme = { init() {} };
  view.context.MO.templates = { init: async () => { booted.resolve(); } };
  view.context.MO.render = Object.fromEntries(Object.entries(view.render).map(([name, render]) =>
    [name, name === 'renderTable' ? render : () => {}]));
  view.run('app.js');
  await booted.promise;

  const check = async expectedNames => {
    const expected = expectedNames.map(name => `gatilin/${name}`);
    assert.deepEqual(idsOf(data.filteredModels()), expected);
    const before = filterCalls;
    view.render.renderTable();
    assert.equal(filterCalls, before + 1, 'table must call the shared filter');
    assert.deepEqual(Array.from(view.element('modelRows').innerHTML.matchAll(/data-detail="([^"]+)"/g), match => match[1]), expected);
    view.element('exportCSV').onclick();
    assert.equal(filterCalls, before + 2, 'CSV must call the same shared filter');
    const blob = view.blobs.at(-1);
    assert.equal(blob.type, 'text/csv;charset=utf-8');
    const [header, ...rows] = (await blob.text()).split('\r\n');
    assert.match(header, /"collection_slugs","collections_captured_at"$/);
    assert.deepEqual(rows.map(row => row.match(/^"([^"]+)"/)[1]), expected);
    for (const row of rows) assert.ok(row.endsWith(`"${data.state.collections.captured_at}"`));
  };
  const change = (id, type, target) => view.element(id).events[type]({ target });
  await check(['keep-outside', 'other', 'keep-ok', 'keep-z', 'keep-a', 'keep-unknown']);
  change('collectionFilter', 'change', { value: 'gatilin/selected' });
  assert.equal(data.state.modelCollection, 'gatilin/selected');
  await check(['other', 'keep-ok', 'keep-z', 'keep-a', 'keep-unknown']);
  change('modelSearch', 'input', { value: '  KEEP-  ' });
  assert.equal(data.state.modelSearch, '  KEEP-  ');
  await check(['keep-ok', 'keep-z', 'keep-a', 'keep-unknown']);
  change('sortModel', 'change', { value: 'name' });
  await check(['keep-a', 'keep-ok', 'keep-unknown', 'keep-z']);
  change('onlyAnomalies', 'change', { checked: true });
  assert.equal(data.state.modelOnlyAnomalies, true);
  await check(['keep-a', 'keep-z']);
  change('sortModel', 'change', { value: 'all_time' });
  await check(['keep-z', 'keep-a']);
  change('modelSearch', 'input', { value: 'no matches' });
  await check([]);
  assert.match(view.element('modelRows').innerHTML, /no-rows/);
  assert.deepEqual(idsOf(data.state.latest.models), names.map(name => `gatilin/${name}`), 'filtering never mutates the inventory');
});

function publishedPayloads(collections) {
  return {
    './data/latest.json': {
      schema_version: 3, author: 'gatilin', captured_at: '2026-10-23T02:23:00Z', date: '2026-10-23',
      models: [{ id: 'gatilin/published' }], datasets: [], ...(collections ? { collections } : {})
    },
    './data/history.json': { schema_version: 3, author: 'gatilin', snapshots: [] },
    './data/scholar.json': { metrics: {}, papers: [] },
    './data/scholar_history.json': { snapshots: [] },
    './data/social.json': { sources: [] },
    './data/social_history.json': { snapshots: [] },
    './data/github.json': { account: {}, repositories: [] },
    './data/github_history.json': { snapshots: [] },
    './data/modelscope.json': modelscopeSnapshot(),
    './data/modelscope_history.json': modelscopeHistory(),
    './data/conferences.json': conferencePayload([conference('Keep', [conferenceEvent('AI/keep:keep26:paper:1')])])
  };
}

test('loadAll tolerates collection failure and preserves published membership through live model replacement', async t => {
  for (const hasFallback of [false, true]) for (const first of ['models', 'collections']) {
    await t.test(`${hasFallback ? 'with' : 'without'} fallback, ${first} finishes first`, async () => {
      const fallback = hasFallback ? collectionSnapshot([{
        slug: 'gatilin/saved', title: 'Saved', description: '', updated_at: null,
        items: [{ id: 'gatilin/live', type: 'model', note: 'published note' }]
      }]) : null;
      const payloads = publishedPayloads(fallback);
      const published = payloads['./data/latest.json'];
      const firstRequested = deferred();
      const requested = [];
      const data = loadData(async url => {
        requested.push(url);
        if (Object.hasOwn(payloads, url)) return jsonResponse(payloads[url]);
        const kind = url === collectionListUrl ? 'collections' : new URL(url).pathname === '/api/models' ? 'models' : null;
        assert.ok(kind, `Unexpected request: ${url}`);
        if (kind === first) firstRequested.resolve();
        else { await firstRequested.promise; await nextTurn(); }
        return kind === 'collections'
          ? jsonResponse({}, { status: 503 })
          : jsonResponse([{ id: 'gatilin/live', downloads: 0, downloadsAllTime: 10, private: false }]);
      });
      data.state.modelCollection = hasFallback ? 'gatilin/saved' : 'unassigned';
      await data.loadAll();
      assert.equal(requested.length, 13);
      assert.equal(data.state.status, 'ready');
      assert.equal(data.state.modelSource, 'live');
      assert.equal(data.state.modelRefreshError, null);
      assert.deepEqual(idsOf(data.state.latest.models), ['gatilin/live']);
      assert.notEqual(data.state.latest, published);
      assert.deepEqual(idsOf(published.models), ['gatilin/published']);
      assert.equal(data.state.collections, fallback);
      assert.equal(data.state.latest.collections, published.collections);
      assert.equal(data.state.collectionSource, 'snapshot');
      assert.match(data.state.collectionRefreshError, /503/);
      assert.equal(data.state.social, payloads['./data/social.json']);
      assert.equal(data.state.scholar, payloads['./data/scholar.json']);
      assert.equal(data.state.github, payloads['./data/github.json']);
      if (hasFallback) {
        assert.equal(data.state.collections.captured_at, '2026-10-20T01:02:03Z');
        assert.deepEqual(idsOf(data.modelScope()), ['gatilin/live']);
        assert.equal(data.modelCollections('gatilin/live')[0].items[0].note, 'published note');
      } else {
        assert.equal(data.collectionsAvailable(), false);
        assert.deepEqual(idsOf(data.modelScope()), []);
      }
    });
  }
});

function modelscopeModel(name, extra = {}) {
  return {
    id: `isLinXu/${name}`, name, tasks: ['text-generation'], downloads: 10, likes: 2,
    gated: false, updated_at: '2026-10-20T01:02:03Z', ...extra
  };
}

function modelscopeSnapshot(models = [modelscopeModel('saved')], extra = {}) {
  return {
    schema_version: 1, author: 'isLinXu', metric_source: 'modelscope-openapi-v1',
    status: 'ok', error: null, captured_at: '2026-10-20T01:02:03Z', date: '2026-10-20', models, ...extra
  };
}

function modelscopeHistory(snapshots = []) {
  return { schema_version: 1, author: 'isLinXu', metric_source: 'modelscope-openapi-v1', snapshots };
}

function rawModelScope(index, extra = {}) {
  return {
    id: `isLinXu/model-${index}`, display_name: `Model ${index}`, private: false, gated: false,
    downloads: index, likes: 0, tasks: ['text-generation'], license: 'apache-2.0',
    created_at: '2026-10-01T00:00:00Z', last_modified: '2026-10-29T12:00:00Z', ...extra
  };
}

function modelscopePage(page, total) {
  return { success: true, data: {
    page_number: page, page_size: 50, total_count: total,
    models: Array.from({ length: Math.min(50, Math.max(0, total - (page - 1) * 50)) },
      (_, index) => rawModelScope((page - 1) * 50 + index))
  } };
}

function seedModelScope(data) {
  data.state.modelscope = modelscopeSnapshot(undefined, {
    profile: { status: 'ok', followers: 7, downloads: 9999, captured_at: '2026-10-19T00:00:00Z' }
  });
  data.state.modelscopeSnapshots = [
    { date: '2026-10-19', models: { 'isLinXu/saved': [12, 1] } },
    { date: '2026-10-20', models: { 'isLinXu/saved': [10, 2] } }
  ];
  data.state.modelscopeSnapshotCapturedAt = data.state.modelscope.captured_at;
  data.state.modelscopeSnapshotCheckedAt = '2026-10-21T03:04:05.000Z';
  data.state.latest = { models: [{ id: 'gatilin/published', all_time: 42 }], datasets: [] };
  data.state.snapshots = [{ date: '2026-10-20', models: { 'gatilin/published': [42, 3] } }];
  return data.state.modelscope;
}

const modelscopeLatestPath = './data/modelscope.json';
const modelscopeHistoryPath = './data/modelscope_history.json';

function retainedModelScopeState(data) {
  return Object.fromEntries([
    'modelscope', 'modelscopeSnapshots', 'modelscopeSource', 'modelscopeSnapshotCapturedAt',
    'modelscopeSnapshotCheckedAt', 'modelscopeModel', 'modelscopeTask', 'modelscopeSearch',
    'modelscopeSort', 'modelscopeMetric', 'modelscopePage'
  ].map(key => [key, data.state[key]]));
}

test('ModelScope snapshot refresh commits a validated pair only after history is ready, with one 20-second budget', async () => {
  const clock = testClock(), historyReady = deferred(), requested = [], budgets = [];
  const latest = modelscopeSnapshot([modelscopeModel('zero', { downloads: 0, likes: 0 })], {
    captured_at: '2026-10-29T02:23:00Z', date: '2026-10-29',
    profile: { status: 'ok', downloads: 0, followers: 0, captured_at: '2026-10-28T02:24:00Z' }
  });
  const history = modelscopeHistory([
    { date: '2026-10-29', models: { 'isLinXu/zero': [0, 0] }, profile_downloads: 0, profile_captured_at: latest.profile.captured_at },
    { date: '2026-10-28', models: { 'isLinXu/zero': [null, 0] } }
  ]);
  const historyBefore = plain(history);
  const data = loadData(async (url, options) => {
    requested.push({ url, options });
    assert.ok([modelscopeLatestPath, modelscopeHistoryPath].includes(url), 'snapshot refresh only reads local published JSON');
    if (url === modelscopeLatestPath) return jsonResponse(latest);
    return { ...jsonResponse(history), json: async () => { await historyReady.promise; return history; } };
  }, {
    Date: clock.Date,
    AbortSignal: { timeout(milliseconds) { budgets.push(milliseconds); return new AbortController().signal; } }
  });
  const previous = seedModelScope(data), previousHistory = data.state.modelscopeSnapshots;
  const hf = data.state.latest, hfHistory = data.state.snapshots;
  Object.assign(data.state, {
    modelscopeModel: 'isLinXu/saved', modelscopeTask: 'removed-task', modelscopeSearch: '  zero  ',
    modelscopeSort: 'likes', modelscopeMetric: 'likes', modelscopePage: 3,
    modelscopeSnapshotRefreshError: 'old snapshot failure', modelscopeRefreshError: 'old live failure'
  });
  const before = retainedModelScopeState(data), contents = plain(before);
  const refreshing = data.refreshModelScopeSnapshot();
  await nextTurn();
  assert.deepEqual(requested.map(call => call.url).sort(), [modelscopeLatestPath, modelscopeHistoryPath].sort());
  assert.deepEqual(budgets, [20000]);
  assert.equal(requested[0].options.signal, requested[1].options.signal);
  for (const { options } of requested) {
    assert.equal(options.cache, 'no-store');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    assert.ok(!options.method || options.method === 'GET');
    assert.equal(options.body, undefined);
  }
  for (const [key, value] of Object.entries(before)) assert.equal(data.state[key], value, `${key} remains unchanged while JSON is pending`);
  assert.deepEqual(plain(before), contents);
  clock.advance(1500);
  historyReady.resolve();
  const result = await refreshing;
  assert.equal(result, latest);
  assert.equal(data.state.modelscope, latest);
  assert.notEqual(result, previous);
  assert.notEqual(data.state.modelscopeSnapshots, previousHistory);
  assert.notEqual(data.state.modelscopeSnapshots, history.snapshots);
  assert.deepEqual(plain(data.state.modelscopeSnapshots), [...historyBefore.snapshots].reverse());
  assert.deepEqual(plain(history), historyBefore, 'sorting never mutates the response history');
  assert.equal(data.state.modelscopeSource, 'snapshot');
  assert.equal(data.state.modelscopeSnapshotCapturedAt, latest.captured_at);
  assert.equal(data.state.modelscopeSnapshotCheckedAt, clock.iso(), 'check time is successful retrieval time, not request start or capture');
  assert.notEqual(data.state.modelscopeSnapshotCheckedAt, latest.captured_at);
  assert.equal(data.state.modelscope.profile.captured_at, '2026-10-28T02:24:00Z');
  assert.equal(data.state.modelscopeSnapshotRefreshError, null);
  assert.equal(data.state.modelscopeRefreshError, null);
  assert.equal(data.state.modelscopeModel, 'all');
  assert.equal(data.state.modelscopeTask, 'all');
  assert.deepEqual([
    data.state.modelscopeSearch, data.state.modelscopeSort, data.state.modelscopeMetric, data.state.modelscopePage
  ], ['  zero  ', 'likes', 'likes', 3]);
  assert.deepEqual(plain(data.modelscopeTotals()), { count: 1, downloads: { value: 0, known: 1 }, likes: { value: 0, known: 1 } });
  assert.equal(data.state.modelscope.profile.downloads, 0);
  assert.equal(data.state.modelscope.profile.followers, 0);
  assert.equal(data.state.latest, hf);
  assert.equal(data.state.snapshots, hfHistory);

  data.state.modelscopeModel = 'isLinXu/zero';
  data.state.modelscopeTask = 'text-generation';
  const captures = [latest.captured_at, latest.profile.captured_at, data.state.modelscopeSnapshots[1].profile_captured_at];
  clock.advance(300000);
  await data.refreshModelScopeSnapshot();
  assert.equal(requested.length, 4, 'reading the same deployment still fetches both files');
  assert.deepEqual(budgets, [20000, 20000]);
  assert.equal(data.state.modelscopeSnapshotCheckedAt, clock.iso());
  assert.equal(data.state.modelscopeSnapshotCapturedAt, captures[0]);
  assert.deepEqual([latest.captured_at, latest.profile.captured_at, data.state.modelscopeSnapshots[1].profile_captured_at], captures);
  assert.equal(data.state.modelscopeModel, 'isLinXu/zero');
  assert.equal(data.state.modelscopeTask, 'text-generation');
});

test('ModelScope snapshot failures preserve exact prior objects and timestamps, including after manual live query, then recover', async t => {
  const failJson = () => ({ ...jsonResponse(null), json: async () => { throw new SyntaxError('invalid JSON'); } });
  const cases = [
    ['latest HTTP failure', modelscopeLatestPath, () => jsonResponse({}, { status: 503 }), /503/],
    ['history HTTP failure', modelscopeHistoryPath, () => jsonResponse({}, { status: 404 }), /404/],
    ['latest invalid JSON', modelscopeLatestPath, failJson, /invalid JSON/],
    ['history invalid JSON', modelscopeHistoryPath, failJson, /invalid JSON/],
    ['latest network failure', modelscopeLatestPath, () => { throw new Error('offline'); }, /offline/],
    ['history timeout', modelscopeHistoryPath, () => { throw new DOMException('request timed out', 'TimeoutError'); }, /超时|timed out/],
    ['latest schema failure', modelscopeLatestPath, () => jsonResponse(modelscopeSnapshot([], { schema_version: 2 })), /不兼容/],
    ['history schema failure', modelscopeHistoryPath, () => jsonResponse({ ...modelscopeHistory(), author: 'other' }), /不兼容/],
    ['history cannot be sorted', modelscopeHistoryPath, () => jsonResponse(modelscopeHistory([
      { date: '2026-10-29', models: {} }, { date: null, models: {} }
    ])), /./]
  ];
  for (const [name, failedUrl, fail, expected] of cases) for (const live of [false, true]) {
    await t.test(`${name}, retaining ${live ? 'live' : 'snapshot'} data`, async () => {
      const clock = testClock();
      const latest = modelscopeSnapshot([modelscopeModel('replacement')], { captured_at: '2026-10-29T03:04:00Z' });
      const history = modelscopeHistory([{ date: '2026-10-29', models: { 'isLinXu/replacement': [10, 2] } }]);
      let failing = true;
      const data = loadData(async url => {
        if (url.startsWith('https://www.modelscope.cn/')) return jsonResponse(modelscopePage(1, 1));
        assert.ok([modelscopeLatestPath, modelscopeHistoryPath].includes(url));
        if (failing && url === failedUrl) return fail();
        return jsonResponse(url === modelscopeLatestPath ? latest : history);
      }, { Date: clock.Date });
      seedModelScope(data);
      if (live) await data.refreshModelScope();
      Object.assign(data.state, {
        modelscopeModel: live ? 'isLinXu/model-0' : 'isLinXu/saved', modelscopeTask: 'text-generation',
        modelscopeSearch: 'keep this search', modelscopeSort: 'name', modelscopeMetric: 'likes', modelscopePage: 2,
        modelscopeRefreshError: 'earlier live failure'
      });
      const before = retainedModelScopeState(data), contents = plain(before);
      await assert.rejects(data.refreshModelScopeSnapshot(), expected);
      await nextTurn();
      for (const [key, value] of Object.entries(before)) assert.equal(data.state[key], value, `${key} survives a failed pair`);
      assert.deepEqual(plain(before), contents, 'failed replacement never mutates prior model/profile/history objects');
      assert.match(data.state.modelscopeSnapshotRefreshError, expected);
      assert.equal(data.state.modelscopeRefreshError, 'earlier live failure');
      failing = false;
      clock.advance(60000);
      assert.equal(await data.refreshModelScopeSnapshot(), latest);
      assert.equal(data.state.modelscope, latest);
      assert.deepEqual(plain(data.state.modelscopeSnapshots), history.snapshots);
      assert.equal(data.state.modelscopeSource, 'snapshot');
      assert.equal(data.state.modelscopeSnapshotCapturedAt, latest.captured_at);
      assert.equal(data.state.modelscopeSnapshotCheckedAt, clock.iso());
      assert.equal(data.state.modelscopeSnapshotRefreshError, null);
      assert.equal(data.state.modelscopeRefreshError, null);
      assert.equal(data.state.modelscopeModel, 'all');
      assert.equal(data.state.modelscopeTask, 'text-generation');
      assert.deepEqual([data.state.modelscopeSearch, data.state.modelscopeSort, data.state.modelscopeMetric], ['keep this search', 'name', 'likes']);
    });
  }
});

test('ModelScope stale, unavailable and undated snapshots are successful reads, never new captures', async t => {
  for (const [status, captured] of [['stale', '2026-10-20T01:02:03Z'], ['unavailable', null], ['ok', null]]) {
    await t.test(`${status}, capture ${captured}`, async () => {
      const clock = testClock();
      const latest = modelscopeSnapshot(status === 'unavailable' ? [] : undefined, {
        status, captured_at: captured, error: status === 'ok' ? null : 'backend unavailable'
      });
      const data = loadData(async url => jsonResponse(url === modelscopeLatestPath ? latest : modelscopeHistory()), { Date: clock.Date });
      seedModelScope(data);
      data.state.modelscopeSnapshotRefreshError = 'previous read failed';
      data.state.modelscopeRefreshError = 'previous live query failed';
      assert.equal(await data.refreshModelScopeSnapshot(), latest);
      assert.equal(data.state.modelscope.status, status);
      assert.equal(data.state.modelscope.error, latest.error, 'a successful read does not hide a backend collection failure');
      assert.equal(data.state.modelscopeSnapshotCapturedAt, captured);
      assert.equal(data.state.modelscopeSnapshotCheckedAt, clock.iso());
      assert.equal(data.state.modelscopeSnapshotRefreshError, null);
      assert.equal(data.state.modelscopeRefreshError, null);
      clock.advance(60000);
      await data.refreshModelScopeSnapshot();
      assert.equal(data.state.modelscopeSnapshotCapturedAt, captured);
      assert.equal(latest.captured_at, captured);
      assert.equal(data.state.modelscopeSnapshotCheckedAt, clock.iso());
    });
  }
});

function assertModelScopeRequest(url, options, page) {
  assert.equal(url, `https://www.modelscope.cn/openapi/v1/models?owner=isLinXu&page_number=${page}&page_size=50`);
  assert.ok(page >= 1 && page <= 60);
  assert.equal(options.credentials, 'omit');
  assert.equal(options.redirect, 'error');
  assert.equal(options.cache, 'no-store');
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.signal.aborted, false);
  assert.equal(options.headers, undefined, 'anonymous requests must not add authorization headers');
  assert.ok(!options.method || options.method === 'GET');
  assert.equal(options.body, undefined);
}

test('ModelScope refresh uses anonymous official OpenAPI and atomically replaces a complete paginated list', async () => {
  const lastPage = deferred(), reachedLastPage = deferred(), requested = [];
  const data = loadData(async (url, options) => {
    requested.push(url);
    assertModelScopeRequest(url, options, requested.length);
    if (requested.length === 2) {
      reachedLastPage.resolve();
      await lastPage.promise;
    }
    return jsonResponse(modelscopePage(requested.length, 51));
  });
  const previous = seedModelScope(data), before = plain(previous);
  const snapshots = data.state.modelscopeSnapshots, savedHistory = plain(snapshots);
  const hf = data.state.latest, hfSnapshots = data.state.snapshots;
  data.state.modelscopeModel = 'isLinXu/saved';
  data.state.modelscopeTask = 'removed-task';
  data.state.modelscopeRefreshError = 'old error';
  data.state.modelscopeSnapshotRefreshError = 'previous snapshot read failed';
  const snapshotCapture = data.state.modelscopeSnapshotCapturedAt, snapshotCheck = data.state.modelscopeSnapshotCheckedAt;
  const refreshing = data.refreshModelScope();
  await reachedLastPage.promise;
  assert.equal(data.state.modelscope, previous, 'no partial inventory is published while another page is pending');
  assert.deepEqual(plain(previous), before);
  lastPage.resolve();
  const result = await refreshing;
  assert.equal(requested.length, 2);
  assert.equal(result, data.state.modelscope);
  assert.notEqual(result, previous);
  assert.deepEqual(plain(previous), before);
  assert.deepEqual(idsOf(result.models), Array.from({ length: 51 }, (_, index) => `isLinXu/model-${index}`));
  assert.equal(result.schema_version, 1);
  assert.equal(result.author, 'isLinXu');
  assert.equal(result.metric_source, 'modelscope-openapi-v1');
  assert.equal(result.status, 'ok');
  assert.equal(result.error, null);
  assert.notEqual(result.captured_at, previous.captured_at);
  assert.ok(Number.isFinite(Date.parse(result.captured_at)));
  assert.equal(result.date, result.captured_at.slice(0, 10));
  assert.equal(result.profile, previous.profile, 'live OpenAPI does not fabricate fresh profile metrics');
  assert.equal(data.state.modelscopeSource, 'live');
  assert.equal(data.state.modelscopeRefreshError, null);
  assert.equal(data.state.modelscopeModel, 'all');
  assert.equal(data.state.modelscopeTask, 'all');
  assert.equal(data.state.modelscopeSnapshots, snapshots);
  assert.deepEqual(plain(snapshots), savedHistory, 'live refresh never appends or overwrites daily history');
  assert.equal(data.state.modelscopeSnapshotCapturedAt, snapshotCapture);
  assert.equal(data.state.modelscopeSnapshotCheckedAt, snapshotCheck);
  assert.equal(data.state.modelscopeSnapshotRefreshError, 'previous snapshot read failed');
  assert.equal(data.state.latest, hf);
  assert.equal(data.state.snapshots, hfSnapshots);
});

test('ModelScope accepts empty, exact 50-row and maximum 3000-row inventories without fetching page 61', async t => {
  for (const total of [0, 50, 3000]) await t.test(`${total} models`, async () => {
    let calls = 0;
    const data = loadData(async (url, options) => {
      assertModelScopeRequest(url, options, ++calls);
      return jsonResponse(modelscopePage(calls, total));
    });
    const previous = seedModelScope(data);
    const history = data.state.modelscopeSnapshots;
    data.state.modelscopeModel = 'isLinXu/model-0';
    data.state.modelscopeTask = 'text-generation';
    await data.refreshModelScope();
    assert.equal(calls, Math.max(1, Math.ceil(total / 50)));
    assert.equal(data.state.modelscope.models.length, total);
    assert.equal(new Set(idsOf(data.state.modelscope.models)).size, total);
    assert.notEqual(data.state.modelscope, previous);
    assert.equal(data.state.modelscope.status, 'ok');
    assert.equal(data.state.modelscopeSource, 'live');
    assert.equal(data.state.modelscopeSnapshots, history);
    assert.equal(data.state.modelscopeModel, total ? 'isLinXu/model-0' : 'all');
    assert.equal(data.state.modelscopeTask, total ? 'text-generation' : 'all');
  });
});

test('ModelScope normalizes missing or invalid counters to null, preserving genuine zero and metadata', async () => {
  const counters = [null, undefined, 0, 7, '12', false, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER];
  const payload = modelscopePage(1, counters.length);
  payload.data.models = counters.map((value, index) => rawModelScope(index, {
    downloads: value, likes: value, gated: index === 0,
    ...(index === 0 ? { display_name: null, tasks: ['vision', 7, null], license: 7, created_at: 7, last_modified: 7 } : {})
  }));
  const data = loadData(async () => jsonResponse(payload));
  await data.refreshModelScope();
  const expected = [null, null, 0, 7, null, null, null, null, null, null, null, Number.MAX_SAFE_INTEGER];
  assert.deepEqual(Array.from(data.state.modelscope.models, model => model.downloads), expected);
  assert.deepEqual(Array.from(data.state.modelscope.models, model => model.likes), expected);
  assert.deepEqual(plain(data.state.modelscope.models[0]), {
    id: 'isLinXu/model-0', name: 'model-0', url: 'https://www.modelscope.cn/models/isLinXu/model-0',
    downloads: null, likes: null, gated: true, tasks: ['vision'], license: '', created_at: null, updated_at: null
  });
  const model = data.state.modelscope.models[2];
  assert.equal(model.name, 'Model 2');
  assert.equal(model.license, 'apache-2.0');
  assert.equal(model.created_at, '2026-10-01T00:00:00Z');
  assert.equal(model.updated_at, '2026-10-29T12:00:00Z');
  for (const row of data.state.modelscope.models) {
    for (const key of ['downloads_all_time', 'downloads_rolling_30d', 'all_time', 'last_30d']) assert.equal(Object.hasOwn(row, key), false);
  }
});

test('ModelScope rejects invalid or incomplete pages and retains the exact previous object, capture and snapshots', async t => {
  const mutate = change => body => { change(body); return jsonResponse(body); };
  const invalidModel = extra => mutate(body => { Object.assign(body.data.models[1], extra); });
  const failures = [
    ['wrong owner', invalidModel({ id: 'other/model' }), /非当前账户/],
    ['wrong owner casing', invalidModel({ id: 'islinxu/model' }), /非当前账户/],
    ['unsafe id', invalidModel({ id: 'isLinXu/../secret' }), /非当前账户/],
    ['private model', invalidModel({ private: true }), /非公开/],
    ['missing private flag', invalidModel({ private: undefined }), /非公开/],
    ['string private flag', invalidModel({ private: 'false' }), /非公开/],
    ...['false', 0, null, undefined].map(value => [`gated ${String(value)}`, invalidModel({ gated: value }), /非公开/]),
    ['null model', mutate(body => { body.data.models[1] = null; }), /非公开/],
    ['duplicate across pages', invalidModel({ id: 'isLinXu/model-0' }), /重复/],
    ['duplicate within page', invalidModel({ id: 'isLinXu/model-50' }), /重复/],
    ['changed total', mutate(body => { body.data.total_count = 53; }), /清单已变化/],
    ['short last page', mutate(body => { body.data.models.pop(); }), /清单不完整/],
    ['extra row', mutate(body => { body.data.models.push(rawModelScope(52)); }), /清单不完整/],
    ['wrong page number', mutate(body => { body.data.page_number = 1; }), /分页不完整/],
    ['wrong page size', mutate(body => { body.data.page_size = 100; }), /分页不完整/],
    ['missing success', mutate(body => { delete body.success; }), /分页不完整/],
    ['unsuccessful response', mutate(body => { body.success = false; }), /分页不完整/],
    ['string success', mutate(body => { body.success = 'true'; }), /分页不完整/],
    ['missing data', () => jsonResponse({ success: true }), /分页不完整/],
    ['models object', mutate(body => { body.data.models = {}; }), /分页不完整/],
    ['null payload', () => jsonResponse(null), /./],
    ...[null, '52', -1, 1.5, 3001, Number.MAX_SAFE_INTEGER + 1].map(value => [
      `invalid total ${String(value)}`, mutate(body => { body.data.total_count = value; }), /分页不完整/
    ]),
    ['HTTP 429', () => jsonResponse({}, { status: 429 }), /429/],
    ['HTTP 503', () => jsonResponse({}, { status: 503 }), /503/],
    ['redirect rejected', () => { throw new TypeError('redirect disallowed'); }, /redirect disallowed/],
    ['invalid JSON', () => ({ ...jsonResponse(null), json: async () => { throw new SyntaxError('invalid JSON'); } }), /invalid JSON/],
    ['network error', () => { throw new Error('offline'); }, /offline/],
    ['timeout', () => { throw new Error('request timed out'); }, /timed out/]
  ];
  for (const [name, fail, expected] of failures) await t.test(name, async () => {
    let calls = 0;
    const data = loadData(async (url, options) => {
      assertModelScopeRequest(url, options, ++calls);
      assert.ok(calls <= 2, 'failure must not trigger more pages or retries');
      return calls === 1 ? jsonResponse(modelscopePage(1, 52)) : fail(modelscopePage(2, 52));
    });
    const previous = seedModelScope(data), before = plain(previous);
    const snapshots = data.state.modelscopeSnapshots, beforeHistory = plain(snapshots);
    const hf = data.state.latest, hfSnapshots = data.state.snapshots;
    data.state.modelscopeModel = 'isLinXu/saved';
    data.state.modelscopeTask = 'text-generation';
    await assert.rejects(data.refreshModelScope(), expected);
    assert.equal(calls, 2);
    assert.equal(data.state.modelscope, previous);
    assert.deepEqual(plain(previous), before);
    assert.equal(data.state.modelscope.captured_at, '2026-10-20T01:02:03Z');
    assert.equal(data.state.modelscopeSnapshots, snapshots);
    assert.deepEqual(plain(snapshots), beforeHistory);
    assert.equal(data.state.modelscopeSource, 'snapshot');
    assert.equal(data.state.modelscopeModel, 'isLinXu/saved');
    assert.equal(data.state.modelscopeTask, 'text-generation');
    assert.equal(data.state.latest, hf);
    assert.equal(data.state.snapshots, hfSnapshots);
    assert.match(data.state.modelscopeRefreshError, expected);
  });
});

test('ModelScope rejects oversized totals and short first pages immediately, even after an earlier live refresh', async t => {
  for (const kind of ['oversized total', 'short first page']) await t.test(kind, async () => {
    let calls = 0;
    const data = loadData(async () => {
      calls++;
      const body = modelscopePage(1, calls === 1 ? 1 : kind === 'oversized total' ? 3001 : 51);
      if (calls > 1 && kind === 'short first page') body.data.models.pop();
      return jsonResponse(body);
    });
    seedModelScope(data);
    await data.refreshModelScope();
    const previous = data.state.modelscope, before = plain(previous), history = data.state.modelscopeSnapshots;
    await assert.rejects(data.refreshModelScope(), /不完整/);
    assert.equal(calls, 2);
    assert.equal(data.state.modelscope, previous);
    assert.deepEqual(plain(previous), before);
    assert.equal(data.state.modelscopeSource, 'live');
    assert.equal(data.state.modelscopeSnapshots, history);
  });
});

test('ModelScope manual live errors explain network uncertainty and timeouts without changing snapshot state', async t => {
  for (const [name, error, expected] of [
    ['network', new TypeError('Failed to fetch'), /网络或跨域限制/],
    ['timeout', new DOMException('The operation was aborted due to timeout', 'TimeoutError'), /超时/]
  ]) await t.test(name, async () => {
    const data = loadData(async () => { throw error; }, { TypeError });
    seedModelScope(data);
    data.state.modelscopeSnapshotRefreshError = 'snapshot unavailable';
    const before = retainedModelScopeState(data), contents = plain(before);
    await assert.rejects(data.refreshModelScope());
    for (const [key, value] of Object.entries(before)) assert.equal(data.state[key], value);
    assert.deepEqual(plain(before), contents);
    assert.equal(data.state.modelscopeSnapshotRefreshError, 'snapshot unavailable');
    assert.match(data.state.modelscopeRefreshError, expected);
    assert.doesNotMatch(data.state.modelscopeRefreshError, /已确认.*跨域|确定.*CORS|CORS.*已阻止/i);
  });
});

function publishedFetch(payloads, requested = []) {
  return async url => {
    requested.push(url);
    if (url.startsWith('./data/')) return Object.hasOwn(payloads, url)
      ? jsonResponse(payloads[url]) : jsonResponse({}, { status: 404 });
    if (url === collectionListUrl) return jsonResponse([]);
    assert.equal(new URL(url).origin, 'https://huggingface.co', 'loadAll must not auto-fetch live ModelScope data');
    assert.equal(new URL(url).pathname, '/api/models');
    return jsonResponse([{ id: 'gatilin/live', private: false, downloads: 3, downloadsAllTime: 42 }]);
  };
}

test('loadAll loads both optional ModelScope files with the versioned author/source contract and sorts history', async t => {
  for (const status of ['ok', 'stale', 'unavailable']) await t.test(status, async () => {
    const payloads = publishedPayloads(), requested = [];
    const latest = payloads['./data/modelscope.json'] = modelscopeSnapshot(
      status === 'unavailable' ? [] : [modelscopeModel('saved', { downloads: null, likes: 0 })], { status }
    );
    const history = payloads['./data/modelscope_history.json'] = modelscopeHistory([
      { date: '2026-10-20', models: { 'isLinXu/saved': [null, 0] } },
      { date: '2026-10-19', models: { 'isLinXu/saved': [0, null] } }
    ]);
    const beforeHistory = plain(history);
    const data = loadData(publishedFetch(payloads, requested));
    await data.loadAll();
    assert.equal(requested.length, 13);
    assert.equal(requested.filter(url => url === './data/modelscope.json').length, 1);
    assert.equal(requested.filter(url => url === './data/modelscope_history.json').length, 1);
    assert.equal(data.state.modelscope, latest);
    assert.equal(data.state.modelscopeSource, 'snapshot');
    assert.notEqual(data.state.modelscopeSnapshots, history.snapshots);
    assert.deepEqual(plain(data.state.modelscopeSnapshots), [...beforeHistory.snapshots].reverse());
    assert.deepEqual(plain(history), beforeHistory);
    assert.equal(data.state.status, 'ready');
    assert.equal(data.state.modelSource, 'live');
  });
});

test('missing or incompatible ModelScope snapshots fail independently of HF and the other boards', async t => {
  const latestPath = './data/modelscope.json', historyPath = './data/modelscope_history.json';
  const cases = [
    ...[latestPath, historyPath].flatMap(file => [
      [`missing ${file}`, payloads => { delete payloads[file]; }, /404/],
      [`null ${file}`, payloads => { payloads[file] = null; }, /不兼容/],
      [`schema ${file}`, payloads => { payloads[file].schema_version = 2; }, /不兼容/],
      [`author ${file}`, payloads => { payloads[file].author = 'gatilin'; }, /不兼容/],
      [`source ${file}`, payloads => { payloads[file].metric_source = 'homepage'; }, /不兼容/]
    ]),
    ['unknown status', payloads => { payloads[latestPath].status = 'ready'; }, /不兼容/],
    ['missing model list', payloads => { delete payloads[latestPath].models; }, /不兼容/],
    ['foreign model', payloads => { payloads[latestPath].models[0].id = 'other/model'; }, /不兼容/],
    ['invalid tasks', payloads => { payloads[latestPath].models[0].tasks = 'text-generation'; }, /不兼容/],
    ['invalid snapshots', payloads => { payloads[historyPath].snapshots = {}; }, /不兼容/]
  ];
  for (const [name, change, expected] of cases) await t.test(name, async () => {
    const payloads = publishedPayloads();
    change(payloads);
    const data = loadData(publishedFetch(payloads));
    await data.loadAll();
    assert.equal(data.state.status, 'ready');
    assert.equal(data.state.modelscope.status, 'unavailable');
    assert.equal(data.state.modelscope.author, 'isLinXu');
    assert.equal(data.state.modelscope.models.length, 0);
    assert.equal(data.state.modelscopeSnapshots.length, 0, 'never expose a half-loaded ModelScope latest/history pair');
    assert.match(data.state.modelscope.error, expected);
    assert.match(data.state.modelscopeSnapshotRefreshError, expected);
    assert.equal(data.state.modelscopeSnapshotCapturedAt, null);
    assert.equal(data.state.modelscopeSnapshotCheckedAt, null);
    assert.deepEqual(idsOf(data.state.latest.models), ['gatilin/live']);
    assert.equal(data.state.scholar, payloads['./data/scholar.json']);
    assert.equal(data.state.social, payloads['./data/social.json']);
    assert.equal(data.state.github, payloads['./data/github.json']);
  });
});

test('loadAll catches later snapshot read failures without replacing an existing snapshot or live ModelScope board', async t => {
  for (const live of [false, true]) await t.test(live ? 'live board' : 'snapshot board', async () => {
    const payloads = publishedPayloads(), fetchPublished = publishedFetch(payloads);
    let failing = false;
    const data = loadData(async (url, options) => {
      if (url.startsWith('https://www.modelscope.cn/openapi/')) return jsonResponse(modelscopePage(1, 1));
      if (failing && url === modelscopeHistoryPath) return jsonResponse({}, { status: 503 });
      return fetchPublished(url, options);
    });
    await data.loadAll();
    if (live) await data.refreshModelScope();
    const before = retainedModelScopeState(data), contents = plain(before);
    failing = true;
    await data.loadAll();
    for (const [key, value] of Object.entries(before)) assert.equal(data.state[key], value);
    assert.deepEqual(plain(before), contents);
    assert.match(data.state.modelscopeSnapshotRefreshError, /503/);
    assert.equal(data.state.status, 'ready');
    assert.equal(data.state.social, payloads['./data/social.json']);
  });
});

test('HF snapshot and live failures still finish loading valid ModelScope snapshots', async t => {
  for (const failure of ['latest.json', 'history.json', 'live HF']) await t.test(failure, async () => {
    const payloads = publishedPayloads();
    payloads['./data/modelscope_history.json'] = modelscopeHistory([
      { date: '2026-10-20', models: { 'isLinXu/saved': [0, null] } }
    ]);
    const fetchPublished = publishedFetch(payloads);
    const data = loadData(async url => {
      if (url === './data/modelscope.json') await nextTurn();
      if (url === `./data/${failure}` || (failure === 'live HF' && url.startsWith('https://huggingface.co/'))) {
        return jsonResponse({}, { status: 503 });
      }
      return fetchPublished(url);
    });
    if (failure === 'live HF') {
      await data.loadAll();
      assert.equal(data.state.modelSource, 'snapshot');
      assert.match(data.state.modelRefreshError, /503/);
    } else await assert.rejects(data.loadAll(), /读取失败.*503/);
    assert.equal(data.state.modelscope, payloads['./data/modelscope.json']);
    assert.deepEqual(plain(data.state.modelscopeSnapshots), payloads['./data/modelscope_history.json'].snapshots);
    assert.equal(data.state.modelscopeSource, 'snapshot');
    assert.equal(data.state.scholar, payloads['./data/scholar.json']);
    assert.equal(data.state.social, payloads['./data/social.json']);
    assert.equal(data.state.github, payloads['./data/github.json']);
  });
});

test('ModelScope totals distinguish unknown counters from zero without mixing HF, profile or table filters', () => {
  const data = loadData();
  seedModelScope(data);
  assert.deepEqual(plain(data.modelscopeTotals()), {
    count: 1, downloads: { value: 10, known: 1 }, likes: { value: 2, known: 1 }
  });
  data.state.modelscope.models = [
    modelscopeModel('unknown', { downloads: null, likes: undefined }),
    modelscopeModel('zero', { downloads: 0, likes: 0 }),
    modelscopeModel('known', { downloads: 12, likes: 3 })
  ];
  data.state.modelscopeSearch = 'no matches';
  data.state.modelscopeTask = 'no such task';
  assert.deepEqual(plain(data.modelscopeTotals()), {
    count: 3, downloads: { value: 12, known: 2 }, likes: { value: 3, known: 2 }
  });
  data.state.modelscope.models.pop();
  assert.deepEqual(plain(data.modelscopeTotals()), {
    count: 2, downloads: { value: 0, known: 1 }, likes: { value: 0, known: 1 }
  });
  data.state.modelscope.models.pop();
  assert.deepEqual(plain(data.modelscopeTotals()), {
    count: 1, downloads: { value: null, known: 0 }, likes: { value: null, known: 0 }
  });
  data.state.modelscope = null;
  assert.deepEqual(plain(data.modelscopeTotals()), {
    count: 0, downloads: { value: null, known: 0 }, likes: { value: null, known: 0 }
  });
});

test('ModelScope series omit partial aggregate measurements, preserve zero, and support each model and metric', () => {
  const data = loadData();
  seedModelScope(data);
  data.state.modelscopeSnapshots = [
    { date: '2026-10-25', models: { 'isLinXu/a': [10, 2], 'isLinXu/b': [5, 3] } },
    { date: '2026-10-26', models: { 'isLinXu/a': [12, 4], 'isLinXu/b': [null, 5] } },
    { date: '2026-10-27', models: { 'isLinXu/a': [13, null], 'isLinXu/b': [] } },
    { date: '2026-10-28', models: {} },
    { date: '2026-10-29' },
    { date: '2026-10-30', models: { 'isLinXu/a': [0, 0], 'isLinXu/b': [0, 0] } }
  ];
  assert.deepEqual(plain(data.modelscopeSeries()), [
    { date: '2026-10-25', value: 15 }, { date: '2026-10-30', value: 0 }
  ]);
  data.state.modelscopeMetric = 'likes';
  assert.deepEqual(plain(data.modelscopeSeries()), [
    { date: '2026-10-25', value: 5 }, { date: '2026-10-26', value: 9 }, { date: '2026-10-30', value: 0 }
  ]);
  data.state.modelscopeModel = 'isLinXu/a';
  assert.deepEqual(plain(data.modelscopeSeries()), [
    { date: '2026-10-25', value: 2 }, { date: '2026-10-26', value: 4 }, { date: '2026-10-30', value: 0 }
  ]);
  data.state.modelscopeMetric = 'downloads';
  assert.deepEqual(plain(data.modelscopeSeries()), [
    { date: '2026-10-25', value: 10 }, { date: '2026-10-26', value: 12 },
    { date: '2026-10-27', value: 13 }, { date: '2026-10-30', value: 0 }
  ]);
  data.state.modelscopeModel = 'isLinXu/missing';
  assert.equal(data.modelscopeSeries().length, 0);
  data.state.modelscopeModel = 'all';
  data.state.modelscopeSnapshots = [];
  assert.equal(data.modelscopeSeries().length, 0, 'live counters never stand in for historical points');
});

test('ModelScope delta uses only the last two saved days and their intersection, preserving negative and zero changes', () => {
  const data = loadData();
  data.state.modelscope = modelscopeSnapshot([modelscopeModel('a', { downloads: 999999 })]);
  data.state.modelscopeSnapshots = [
    { date: '2026-09-01', models: { 'isLinXu/a': [10000, 10000] } },
    { date: '2026-10-20', models: {
      'isLinXu/a': [20, 2], 'isLinXu/zero': [0, 0], 'isLinXu/removed': [100, 10], 'isLinXu/missing': [null, 4]
    } },
    { date: '2026-10-30', models: {
      'isLinXu/a': [12, 50], 'isLinXu/zero': [0, 0], 'isLinXu/added': [200, 20], 'isLinXu/missing': [7, 5]
    } }
  ];
  const expected = { value: -8, compared: 2, from: '2026-10-20', to: '2026-10-30' };
  assert.deepEqual(plain(data.modelscopeDelta()), expected);
  assert.deepEqual(plain(data.modelscopeDelta('isLinXu/a')), { ...expected, compared: 1 });
  assert.deepEqual(plain(data.modelscopeDelta('isLinXu/zero')), { ...expected, value: 0, compared: 1 });
  for (const id of ['added', 'removed', 'missing', 'unknown']) assert.equal(data.modelscopeDelta(`isLinXu/${id}`), null);
  data.state.modelscopeMetric = 'likes';
  data.state.modelscopeSearch = 'no matches';
  data.state.modelscopeTask = 'missing';
  assert.deepEqual(plain(data.modelscopeDelta()), expected, 'download delta is independent of chart metric and table filters');
  data.state.modelscopeSnapshots.push({ date: '2026-10-31', models: { 'isLinXu/a': [null, 1] } });
  assert.equal(data.modelscopeDelta(), null, 'do not substitute an earlier usable day');
  data.state.modelscopeSnapshots = data.state.modelscopeSnapshots.slice(0, 1);
  assert.equal(data.modelscopeDelta(), null);
  data.state.modelscopeSnapshots = [];
  assert.equal(data.modelscopeDelta(), null);
});

test('ModelScope table and CSV share search/task/sort while pagination shows 20 rows and export includes every match', async () => {
  const data = loadData(() => { throw new Error('app tests must never make network requests'); });
  seedModelScope(data);
  assert.deepEqual([
    data.state.modelscopeSearch, data.state.modelscopeTask, data.state.modelscopeSort,
    data.state.modelscopePage, data.state.modelscopeModel, data.state.modelscopeMetric
  ], ['', 'all', 'downloads', 1, 'all', 'downloads']);
  const formulaNames = ['=SUM(1,2)', '+cmd', '-cmd', '@cmd', '\tcmd', '\rcmd', '\ncmd'];
  const models = Array.from({ length: 45 }, (_, index) => modelscopeModel(`keep-${String(index).padStart(2, '0')}`, {
    name: formulaNames[index] ?? (index === 7 ? '<img src=x onerror="bad"> & "keep"' : `Keep ${index}`),
    downloads: index === 44 ? null : index, likes: 100 - index,
    tasks: [index < 25 ? 'text-generation' : 'vision'],
    updated_at: `2026-10-${String(index % 28 + 1).padStart(2, '0')}T00:00:00Z`
  }));
  models.push(modelscopeModel('outside', { downloads: 999 }));
  data.state.modelscope.models = models;
  data.state.modelscopeSnapshots = [
    { date: '2026-10-19', models: Object.fromEntries(models.map(model => [model.id, [10, 1]])) },
    { date: '2026-10-20', models: Object.fromEntries(models.map(model => [model.id, [5, 2]])) }
  ];
  const original = plain(models), booted = deferred();
  let filterCalls = 0, liveCalls = 0, snapshotCalls = 0;
  const viewData = {
    ...data, loadAll: async () => {},
    refreshModelScope: async () => { liveCalls++; },
    refreshModelScopeSnapshot: async () => { snapshotCalls++; return data.state.modelscope; },
    modelscopeModels() { filterCalls++; return data.modelscopeModels(); }
  };
  const view = loadModelView(viewData), charts = [], toasts = [];
  view.context.MO.charts.line = (...args) => { charts.push(args); };
  view.context.MO.theme = { init() {} };
  view.context.MO.templates = { init: async () => { booted.resolve(); } };
  view.context.MO.render = Object.fromEntries(Object.entries(view.render).map(([name, render]) =>
    [name, name.startsWith('renderModelScope') ? render : name === 'showToast' ? message => toasts.push(message) : () => {}]));
  view.run('app.js');
  await booted.promise;
  await nextTurn();
  assert.equal(liveCalls, 0, 'app boot never starts an external live query');
  assert.equal(snapshotCalls, 0, 'app boot uses the snapshot already loaded by loadAll');
  assert.deepEqual(toasts, []);
  assert.equal(view.element('modelscopeRefresh').disabled, false);
  assert.equal(view.element('modelscopeLiveRefresh').disabled, false);
  const change = (id, type, target = {}) => view.element(id).events[type]({ target });
  const parseCsv = text => text.replace(/^\uFEFF/, '').split('\r\n').map(row =>
    Array.from(row.matchAll(/"((?:[^"]|"")*)"/g), match => match[1].replace(/""/g, '"')));
  const check = async expected => {
    assert.deepEqual(idsOf(data.modelscopeModels()), idsOf(expected));
    const before = filterCalls;
    view.render.renderModelScopeTable();
    assert.equal(filterCalls, before + 1);
    const page = data.state.modelscopePage;
    assert.deepEqual(Array.from(view.element('modelscopeRows').innerHTML.matchAll(/data-ms-model="([^"]+)"/g), match => match[1]),
      idsOf(expected.slice((page - 1) * 20, page * 20)));
    assert.equal(view.element('modelscopeTableCount').textContent, `${expected.length} / 46 MODELS`);
    view.element('modelscopeExport').onclick();
    assert.equal(filterCalls, before + 2, 'CSV uses the same filter, not the visible page');
    assert.equal(view.blobs.at(-1).type, 'text/csv;charset=utf-8');
    const text = await view.blobs.at(-1).text();
    assert.deepEqual(Array.from(new Uint8Array(await view.blobs.at(-1).arrayBuffer()).slice(0, 3)), [0xef, 0xbb, 0xbf]);
    const [header, ...rows] = parseCsv(text);
    assert.deepEqual(header, ['model_id', 'name', 'modelscope_downloads', 'modelscope_likes', 'snapshot_download_change',
      'tasks', 'gated', 'updated_at', 'observed_at', 'source', 'url']);
    assert.doesNotMatch(header.join(','), /all_time|30d/);
    assert.deepEqual(rows.map(row => row[0]), idsOf(expected));
    rows.forEach((row, index) => {
      const model = expected[index];
      assert.equal(row[1], /^[=+\-@\t\r\n]/.test(model.name) ? `'${model.name}` : model.name);
      assert.equal(row[2], model.downloads === null ? '' : String(model.downloads));
      assert.equal(row[3], String(model.likes));
      assert.equal(row[4], '-5', 'numeric negative changes are not string-formula escaped');
      assert.equal(row[5], model.tasks.join('; '));
      assert.equal(row[6], String(model.gated));
      assert.equal(row[7], model.updated_at);
      assert.equal(row[8], data.state.modelscope.captured_at);
      assert.equal(row[9], 'modelscope-openapi-v1');
      assert.equal(row[10], `https://www.modelscope.cn/models/${model.id}`);
    });
  };
  const byDownloads = rows => [...rows].sort((a, b) => (b.downloads ?? -Infinity) - (a.downloads ?? -Infinity));
  await check(byDownloads(models));
  assert.equal(view.element('modelscopePageInfo').textContent, '1 / 3');
  assert.equal(view.element('modelscopePrev').disabled, true);
  assert.equal(view.element('modelscopeNext').disabled, false);
  assert.equal(view.element('modelscopePagination').hidden, false);
  change('modelscopeNext', 'click');
  await check(byDownloads(models));
  assert.equal(data.state.modelscopePage, 2);
  change('modelscopeNext', 'click');
  await check(byDownloads(models));
  assert.equal(view.element('modelscopePageInfo').textContent, '3 / 3');
  assert.equal(view.element('modelscopeNext').disabled, true);
  change('modelscopeNext', 'click');
  assert.equal(data.state.modelscopePage, 3, 'renderer clamps past the last page');
  change('modelscopePrev', 'click');
  assert.equal(data.state.modelscopePage, 2);
  change('modelscopeSearch', 'input', { value: '  KEEP-  ' });
  assert.equal(data.state.modelscopeSearch, '  KEEP-  ');
  assert.equal(data.state.modelscopePage, 1);
  await check(byDownloads(models.slice(0, 45)));
  change('modelscopeNext', 'click');
  change('modelscopeTask', 'change', { value: 'text-generation' });
  assert.equal(data.state.modelscopeTask, 'text-generation');
  assert.equal(data.state.modelscopePage, 1);
  await check(byDownloads(models.slice(0, 25)));
  change('modelscopeNext', 'click');
  await check(byDownloads(models.slice(0, 25)));
  assert.equal(view.element('modelscopePageInfo').textContent, '2 / 2');
  change('modelscopeSort', 'change', { value: 'name' });
  assert.equal(data.state.modelscopeSort, 'name');
  assert.equal(data.state.modelscopePage, 1);
  await check(models.slice(0, 25));
  const html = view.element('modelscopeRows').innerHTML;
  assert.ok(html.includes(view.context.MO.format.esc(models[7].name)));
  assert.doesNotMatch(html, /<img|downloads_all_time|rolling_30d/);
  change('modelscopeSort', 'change', { value: 'likes' });
  await check(models.slice(0, 25));
  change('modelscopeSort', 'change', { value: 'updated_at' });
  await check([...models.slice(0, 25)].reverse());
  change('modelscopeSearch', 'input', { value: ' SUM(1,2) ' });
  await check([models[0]]);
  assert.equal(view.element('modelscopePagination').hidden, true);
  change('modelscopeSort', 'change', { value: 'name' });
  change('modelscopeSearch', 'input', { value: 'text-generation' });
  await check(models.slice(0, 25).concat(models[45]));
  change('modelscopeSearch', 'input', { value: 'no matches' });
  await check([]);
  assert.match(view.element('modelscopeRows').innerHTML, /没有匹配的 ModelScope 模型/);
  assert.equal(view.element('modelscopePageInfo').textContent, '1 / 1');
  assert.equal(view.element('modelscopePrev').disabled, true);
  assert.equal(view.element('modelscopeNext').disabled, true);
  assert.deepEqual(plain(models), original, 'sort/filter/export do not mutate the inventory');
  change('modelscopeMetric', 'change', { value: 'likes' });
  assert.equal(data.state.modelscopeMetric, 'likes');
  assert.match(view.element('modelscopeChartLabel').textContent, /点赞计数/);
  view.element('modelscopeChartReset').focus = () => {};
  view.element('modelscopeChart').scrollIntoView = () => {};
  view.context.matchMedia = () => ({ matches: true });
  change('modelscopeRows', 'click', { closest: () => ({ dataset: { msModel: models[0].id } }) });
  assert.equal(data.state.modelscopeModel, models[0].id);
  assert.match(view.element('modelscopeChartLabel').textContent, /isLinXu\/keep-00/);
  assert.deepEqual(plain(charts.at(-1)[1][0].points), [
    { date: '2026-10-19', value: 1 }, { date: '2026-10-20', value: 2 }
  ]);
  change('modelscopeChartReset', 'click');
  assert.equal(data.state.modelscopeModel, 'all');
  assert.equal(view.element('modelscopeChartReset').disabled, true);
  await view.element('modelscopeRefresh').events.click();
  assert.equal(snapshotCalls, 1);
  assert.equal(liveCalls, 0);
  assert.match(toasts.at(-1), /已发布快照.*不会触发后台采集/);
  assert.equal(view.element('modelscopeRefresh').disabled, false);
  assert.equal(view.element('modelscopeLiveRefresh').disabled, false);
  await view.element('modelscopeLiveRefresh').events.click();
  assert.equal(liveCalls, 1);
  assert.equal(snapshotCalls, 1);
  assert.match(toasts.at(-1), /仅更新模型清单.*主页下载、关注者及历史曲线仍来自每日快照/);
});

test('ModelScope board escapes names and tasks and labels saved/live/unavailable counters without invented metrics', () => {
  const data = loadData();
  seedModelScope(data);
  const task = '<svg onload="bad"> & vision';
  data.state.modelscope.models = [
    modelscopeModel('a', { name: '<script>bad</script> & "name"', downloads: null, likes: 0, tasks: [task], gated: true }),
    modelscopeModel('b', { downloads: 0, likes: null, tasks: [], updated_at: null })
  ];
  const view = loadModelView(data), charts = [];
  view.context.MO.charts.line = (...args) => { charts.push(args); };
  view.render.renderModelScopeBoard();
  assert.equal(view.element('statModelscopeModels').textContent, '2');
  assert.equal(view.element('statModelscopeDownloads').textContent, '0');
  assert.equal(view.element('statModelscopeLikes').textContent, '0');
  assert.equal(view.element('statModelscopeDownloadsSub').textContent, '已知 1/2 个模型 · 不含其他平台');
  assert.equal(view.element('statModelscopeFollowers').textContent, '7');
  assert.match(view.element('modelscopeProfileNote').textContent, /不混用/);
  assert.match(view.element('modelscopeStatus').textContent, /已发布 OpenAPI 快照/);
  assert.equal(view.element('modelscopeExport').disabled, false);
  const html = view.element('modelscopeRows').innerHTML;
  assert.ok(html.includes(view.context.MO.format.esc(data.state.modelscope.models[0].name)));
  assert.ok(html.includes(view.context.MO.format.esc(task)));
  assert.ok(view.element('modelscopeTask').innerHTML.includes(view.context.MO.format.esc(task)));
  assert.doesNotMatch(html, /<script|<svg/);
  assert.match(html, /需申请访问/);
  assert.match(html, /公开/);
  assert.match(html, /未标注/);
  assert.match(html, /class="align-right">—<\/td>/);
  assert.match(html, /class="align-right">0<\/td>/);
  assert.match(html, /href="https:\/\/www.modelscope.cn\/models\/isLinXu\/a" target="_blank" rel="noopener noreferrer"/);
  assert.match(view.element('modelscopeChartNote').textContent, /下载计数净变化 -2/);
  assert.doesNotMatch(JSON.stringify(charts.map(call => call.slice(1))), /all_time|30d|30 天/);
  data.state.modelscope.status = 'stale';
  data.state.modelscopeRefreshError = 'offline';
  view.render.renderModelScopeBoard();
  assert.equal(view.element('modelscopeExport').disabled, false);
  assert.match(view.element('modelscopeStatus').textContent, /后台采集失败，保留上次快照/);
  assert.match(view.element('modelscopeStatus').textContent, /实时查询失败，保留上次数据：offline/);
  assert.equal(view.element('modelscopeStatus').title, 'offline');
  data.state.modelscopeSource = 'live';
  view.render.renderModelScopeBoard();
  assert.match(view.element('modelscopeStatus').textContent, /OpenAPI 实时清单/);
  data.state.modelscope = modelscopeSnapshot([], { status: 'unavailable', profile: null });
  data.state.modelscopeSnapshots = [];
  view.render.renderModelScopeBoard();
  assert.equal(view.element('modelscopeExport').disabled, true);
  assert.equal(view.element('statModelscopeModels').textContent, '—');
  assert.equal(view.element('statModelscopeDownloads').textContent, '—');
  assert.match(view.element('modelscopeStatus').textContent, /其他看板不受影响/);
  assert.match(view.element('modelscopeProfileNote').textContent, /辅助指标暂不可用/);
  assert.match(view.element('modelscopeChartNote').textContent, /至少两日快照/);
  assert.equal(charts.at(-1)[1][0].points.length, 0);
  assert.match(charts.at(-1)[2].emptyText, /不补造历史数据/);
});

test('ModelScope profile history skips unknown counters and never mixes model sums or table scopes', () => {
  const data = loadData();
  seedModelScope(data);
  data.state.modelscopeSnapshots = [
    { date: '2026-10-25', models: { 'isLinXu/a': [9000000, 1] } },
    { date: '2026-10-26', profile_downloads: 0 },
    { date: '2026-10-27', profile_downloads: null },
    { date: '2026-10-28', profile_downloads: '123' },
    { date: '2026-10-29', profile_downloads: 1020243 },
    { date: '2026-10-30', profile_downloads: 1020223 }
  ];
  data.state.modelscopeSearch = 'no matches';
  data.state.modelscopeTask = 'unknown';
  data.state.modelscopeModel = 'isLinXu/a';
  data.state.modelscopeMetric = 'likes';
  const before = plain(data.state.modelscopeSnapshots);
  assert.deepEqual(plain(data.modelscopeProfileSeries()), [
    { date: '2026-10-26', value: 0 },
    { date: '2026-10-29', value: 1020243 },
    { date: '2026-10-30', value: 1020223 }
  ]);
  assert.deepEqual(plain(data.modelscopeProfileDelta()), { value: -20, from: '2026-10-29', to: '2026-10-30' });
  assert.deepEqual(plain(data.state.modelscopeSnapshots), before);
  for (const value of [undefined, null, '12', -1, true, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    data.state.modelscopeSnapshots.at(-1).profile_downloads = value;
    assert.equal(data.modelscopeProfileDelta(), null, 'never fall back to an earlier valid pair');
    assert.equal(data.modelscopeProfileSeries().at(-1).date, '2026-10-29');
  }
  data.state.modelscopeSnapshots = [
    { date: '2026-10-20', profile_downloads: 0 },
    { date: '2026-10-30', profile_downloads: 0 }
  ];
  assert.deepEqual(plain(data.modelscopeProfileDelta()), { value: 0, from: '2026-10-20', to: '2026-10-30' });
  data.state.modelscopeSnapshots[0].profile_downloads = null;
  assert.equal(data.modelscopeProfileDelta(), null);
  data.state.modelscopeSnapshots = [{ date: '2026-10-30', profile_downloads: 0 }];
  assert.equal(data.modelscopeProfileDelta(), null);
  data.state.modelscopeSnapshots = [];
  assert.equal(data.modelscopeProfileDelta(), null);
  assert.deepEqual(plain(data.modelscopeProfileSeries()), []);
});

test('ModelScope load and live refresh preserve profile download timestamps without backfilling old snapshots', async () => {
  const payloads = publishedPayloads();
  const capture = '2026-10-30T02:23:00Z';
  payloads['./data/modelscope.json'] = modelscopeSnapshot(undefined, {
    profile: { status: 'ok', downloads: 1020243, followers: 13, captured_at: capture }
  });
  payloads['./data/modelscope_history.json'] = modelscopeHistory([
    { date: '2026-10-28', models: { 'isLinXu/saved': [999, 2] } },
    { date: '2026-10-30', models: { 'isLinXu/saved': [1000, 3] }, profile_downloads: 1020243, profile_captured_at: capture }
  ]);
  const published = publishedFetch(payloads);
  const data = loadData((url, options) => url.startsWith('https://www.modelscope.cn/openapi/')
    ? jsonResponse(modelscopePage(1, 1)) : published(url, options));
  await data.loadAll();
  const profile = data.state.modelscope.profile, history = data.state.modelscopeSnapshots;
  const before = plain(history);
  assert.deepEqual(plain(data.modelscopeProfileSeries()), [{ date: '2026-10-30', value: 1020243 }]);
  assert.equal(data.modelscopeProfileDelta(), null);
  assert.equal(Object.hasOwn(history[0], 'profile_downloads'), false);
  await data.refreshModelScope();
  assert.equal(data.state.modelscope.profile, profile);
  assert.equal(data.state.modelscope.profile.captured_at, capture);
  assert.equal(data.state.modelscopeSnapshots, history);
  assert.deepEqual(plain(history), before);
  assert.equal(data.modelscopeProfileSeries()[0].value, 1020243);
  assert.equal(data.modelscopeTotals().downloads.value, 0);
});

test('ModelScope profile cards and chart show independent exact counts, timestamps, zero and unavailable states', () => {
  const data = loadData();
  seedModelScope(data);
  data.state.modelscope.profile = { status: 'ok', downloads: 1020243, followers: 13, captured_at: '2026-10-30T02:23:00Z' };
  data.state.modelscopeSnapshots = [
    { date: '2026-10-29', models: { 'isLinXu/saved': [8, 0] }, profile_downloads: 1000000 },
    { date: '2026-10-30', models: { 'isLinXu/saved': [10, 2] }, profile_downloads: 1020243 }
  ];
  const view = loadModelView(data), charts = [], tones = new Set();
  view.context.MO.charts.line = (...args) => charts.push(args);
  view.element('statModelscopeProfileChange').classList = { toggle(name, on) { if (on) tones.add(name); else tones.delete(name); } };
  view.render.renderModelScopeBoard();
  assert.equal(view.element('statModelscopeProfileDownloads').textContent, '102.02万');
  assert.equal(view.element('statModelscopeProfileDownloads').title, '1,020,243');
  assert.match(view.element('statModelscopeProfileDownloadsSub').textContent, /1,020,243.*User.Downloads/);
  assert.equal(view.element('statModelscopeProfileChange').title, '+20,243');
  assert.deepEqual([...tones], ['pos']);
  assert.match(view.element('statModelscopeProfileChangeSub').textContent, /2026-10-29 → 2026-10-30/);
  assert.match(view.element('modelscopeProfileCapturedAt').textContent, /2026-10-30 02:23 UTC/);
  assert.equal(view.element('statModelscopeDownloads').textContent, '10');
  const profileChart = charts.find(call => call[0] === view.element('modelscopeProfileChart'));
  assert.deepEqual(plain(profileChart[1][0].points), [
    { date: '2026-10-29', value: 1000000 }, { date: '2026-10-30', value: 1020243 }
  ]);
  assert.match(profileChart[2].label, /主页下载/);
  assert.match(view.element('modelscopeProfileChartNote').textContent, /2 个有效主页快照/);
  data.state.modelscopeSource = 'live';
  data.state.modelscope.captured_at = '2026-11-01T00:00:00Z';
  data.state.modelscopeSearch = 'no matches';
  data.state.modelscopeMetric = 'likes';
  view.render.renderModelScopeBoard();
  assert.equal(view.element('statModelscopeProfileDownloads').title, '1,020,243');
  assert.match(view.element('modelscopeProfileCapturedAt').textContent, /2026-10-30 02:23 UTC/);
  data.state.modelscope.profile.downloads = 0;
  data.state.modelscopeSnapshots.at(-1).profile_downloads = 0;
  view.render.renderModelScopeBoard();
  assert.equal(view.element('statModelscopeProfileDownloads').textContent, '0');
  assert.equal(view.element('statModelscopeProfileChange').title, '-1,000,000');
  assert.deepEqual([...tones], ['neg']);
  data.state.modelscope.status = 'stale';
  view.render.renderModelScopeBoard();
  assert.match(view.element('modelscopeProfileCapturedAt').textContent, /保留上次快照/);
  data.state.modelscope.profile = { status: 'unavailable', downloads: null, captured_at: null };
  data.state.modelscopeSnapshots.at(-1).profile_downloads = null;
  view.render.renderModelScopeBoard();
  assert.equal(view.element('statModelscopeProfileDownloads').textContent, '—');
  assert.equal(view.element('statModelscopeProfileChange').textContent, '—');
  assert.equal(tones.size, 0);
  assert.match(view.element('modelscopeProfileCapturedAt').textContent, /暂不可用.*历史记录仍保留/);
  assert.match(view.element('statModelscopeProfileChangeSub').textContent, /不跨记录比较/);
  assert.equal(view.element('statModelscopeDownloads').textContent, '10');
  data.state.modelscopeSnapshots = [{ date: '2026-10-28', models: { 'isLinXu/saved': [10, 2] } }];
  view.render.renderModelScopeBoard();
  const lastProfileChart = charts.filter(call => call[0] === view.element('modelscopeProfileChart')).at(-1);
  assert.equal(lastProfileChart[1][0].points.length, 0);
  assert.match(lastProfileChart[2].emptyText, /旧快照不回填、不补零/);
});

test('ModelScope refresh buttons serialize snapshot and live work and restore labels after failures', async () => {
  const data = loadData(() => { throw new Error('button tests must never make network requests'); });
  seedModelScope(data);
  const pending = deferred(), booted = deferred();
  let snapshotCalls = 0, liveCalls = 0, snapshotFailure = null;
  const viewData = {
    ...data, loadAll: async () => {},
    refreshModelScopeSnapshot: async () => {
      snapshotCalls++;
      await pending.promise;
      if (snapshotFailure) throw snapshotFailure;
      return data.state.modelscope;
    },
    refreshModelScope: async () => { liveCalls++; },
    modelscopeModels: data.modelscopeModels
  };
  const view = loadModelView(viewData), toasts = [];
  view.context.MO.charts.line = () => {};
  view.context.MO.theme = { init() {} };
  view.context.MO.templates = { init: async () => { booted.resolve(); } };
  view.context.MO.render = Object.fromEntries(Object.entries(view.render).map(([name, render]) =>
    [name, name.startsWith('renderModelScope') ? render : name === 'showToast' ? message => toasts.push(message) : () => {}]));
  view.run('app.js');
  await booted.promise;
  await nextTurn();
  const snapshotButton = view.element('modelscopeRefresh'), liveButton = view.element('modelscopeLiveRefresh');
  const clicking = snapshotButton.events.click();
  await nextTurn();
  assert.equal(snapshotCalls, 1);
  assert.equal(snapshotButton.disabled, true);
  assert.equal(liveButton.disabled, true);
  assert.equal(snapshotButton.getAttribute('aria-busy'), 'true');
  assert.equal(snapshotButton.textContent, '读取已发布快照…');
  liveButton.events.click();
  snapshotButton.events.click();
  await nextTurn();
  assert.deepEqual([snapshotCalls, liveCalls], [1, 0], 'once one refresh is running, both entries stay idle');
  pending.resolve();
  await clicking;
  assert.equal(snapshotButton.disabled, false);
  assert.equal(liveButton.disabled, false);
  assert.equal(snapshotButton.getAttribute('aria-busy'), 'false');
  assert.equal(snapshotButton.textContent, '刷新已发布快照');
  assert.equal(liveButton.textContent, '尝试实时查询');
  assert.match(toasts.at(-1), /已发布快照.*不会触发后台采集/);
  snapshotFailure = new Error('HTTP 503');
  await snapshotButton.events.click();
  assert.match(toasts.at(-1), /快照读取失败：HTTP 503。保留上次数据/);
  assert.equal(snapshotButton.disabled, false);
  assert.equal(liveButton.disabled, false);
  await liveButton.events.click();
  assert.equal(liveCalls, 1);
  assert.match(toasts.at(-1), /仅更新模型清单.*主页下载、关注者及历史曲线仍来自每日快照/);
});

test('ModelScope status separates capture, read, backend and live failures and flags stale data', () => {
  const clock = testClock('2026-10-23T00:00:00.000Z');
  const data = loadData();
  seedModelScope(data);
  data.state.modelscopeSnapshotCapturedAt = '2026-10-20T01:02:03Z';
  data.state.modelscopeSnapshotCheckedAt = '2026-10-22T23:00:00.000Z';
  data.state.modelscope.status = 'stale';
  data.state.modelscope.error = 'upstream unavailable';
  data.state.modelscopeSnapshotStatus = 'stale';
  data.state.modelscopeSnapshotError = 'upstream unavailable';
  data.state.modelscopeSnapshotRefreshError = 'snapshot HTTP 503';
  data.state.modelscopeRefreshError = 'live network';
  const view = loadModelView(data), charts = [];
  view.context.Date = clock.Date;
  view.context.MO.charts.line = (...args) => charts.push(args);
  view.render.renderModelScopeBoard();
  const status = view.element('modelscopeStatus').textContent;
  assert.match(status, /^已发布 OpenAPI 快照 · 最近成功采集 2026-10-20 01:02 UTC/);
  assert.match(status, /后台采集失败，保留上次快照：upstream unavailable/);
  assert.match(status, /快照读取失败，保留上次数据：snapshot HTTP 503/);
  assert.match(status, /实时查询失败，保留上次数据：live network/);
  assert.equal(view.element('modelscopeStatus').title, 'snapshot HTTP 503\nlive network\nupstream unavailable');
  assert.match(view.element('modelscopeFreshness').textContent, /模型快照：距今 2 天 · 超过 48 小时未更新/);
  assert.match(view.element('modelscopeFreshness').textContent, /主页：距今 4 天 · 超过 48 小时未更新/);
  assert.match(view.element('modelscopeSnapshotCheckedAt').textContent, /最近成功读取快照 2026-10-22 23:00 UTC · 读取不代表重新采集/);

  data.state.modelscope.status = 'ok';
  data.state.modelscope.error = null;
  data.state.modelscope.captured_at = '2026-10-22T23:30:00Z';
  data.state.modelscopeSnapshotStatus = 'ok';
  data.state.modelscopeSnapshotError = null;
  data.state.modelscopeSnapshotCapturedAt = '2026-10-22T23:30:00Z';
  data.state.modelscopeSnapshotRefreshError = null;
  data.state.modelscopeRefreshError = null;
  data.state.modelscope.profile.captured_at = '2026-10-22T23:00:00Z';
  view.render.renderModelScopeBoard();
  assert.match(view.element('modelscopeFreshness').textContent, /模型快照：距今不足 1 小时/);
  assert.doesNotMatch(view.element('modelscopeFreshness').textContent, /超过 48 小时/);

  data.state.modelscopeSource = 'live';
  data.state.modelscope.captured_at = '2026-10-23T00:00:00Z';
  data.state.modelscopeSnapshotCapturedAt = '2026-10-18T00:00:00Z';
  data.state.modelscope.profile.captured_at = '2026-10-17T00:00:00Z';
  view.render.renderModelScopeBoard();
  assert.match(view.element('modelscopeStatus').textContent, /OpenAPI 实时清单 · 实时查询成功于 2026-10-23 00:00 UTC · 后台最近成功采集 2026-10-18 00:00 UTC/);
  assert.match(view.element('modelscopeProfileCapturedAt').textContent, /主页采集于 2026-10-17 00:00 UTC/);
  assert.match(view.element('modelscopeFreshness').textContent, /主页：距今 6 天 · 超过 48 小时未更新/);

  data.state.modelscope.captured_at = null;
  data.state.modelscopeSnapshotCapturedAt = null;
  data.state.modelscope.profile.captured_at = null;
  view.render.renderModelScopeBoard();
  assert.match(view.element('modelscopeStatus').textContent, /后台最近成功采集 采集时间未知/);
  assert.match(view.element('modelscopeFreshness').textContent, /模型快照：采集时间未知/);
  assert.match(view.element('modelscopeProfileCapturedAt').textContent, /主页采集于 — UTC/);
});

// --- Conference deadline board --------------------------------------------

const CONF_NOW = Date.parse('2026-10-30T12:00:00.000Z');

function conferenceEvent(id, extra = {}) {
  return {
    id, kind: 'paper', round: 1, year: 2026, comment: '', source_local: '2026-12-01 23:59:59',
    timezone: 'UTC-12', utc: '2026-12-02T11:59:59Z', offset_minutes: -720, time_status: 'ok', tbd: false, ...extra
  };
}

function conferenceEdition(key, events, extra = {}) {
  return {
    id: `${key}26`, year: 2026, url: `https://example.com/${key}`, date: 'December 2026',
    place: 'Nowhere', timezone: 'UTC-12', events, ...extra
  };
}

function conference(title, events, extra = {}) {
  const key = (extra.key || `AI/${title}`).toLowerCase();
  return {
    key, title, description: '', area: 'AI', rank: { ccf: 'A' },
    editions: [conferenceEdition(key.split('/')[1], events)], ...extra
  };
}

function conferencePayload(conferences = [], extra = {}) {
  const events = conferences.flatMap(item => item.editions.flatMap(edition => edition.events));
  const editions = conferences.reduce((sum, item) => sum + item.editions.length, 0);
  const paper_events = events.filter(event => event.kind === 'paper').length;
  const tbd = events.filter(event => event.tbd).length;
  return {
    schema_version: 1, source: { id: 'ccfddl', name: 'CCF-Deadlines' }, status: 'ok', error: null,
    captured_at: '2026-10-30T02:23:00Z', source_updated_at: '2026-10-29T03:56:43Z',
    counts: { conferences: conferences.length, editions, events: events.length, paper_events, tbd },
    warnings: [], changes: { status: 'compared', added: 1, updated: 0, removed: 0, previous_captured_at: '2026-10-29T02:20:00Z' },
    conferences, ...extra
  };
}

function seedConferences(data, conferences) {
  data.state.conferences = conferencePayload(conferences);
  return data.state.conferences;
}

const confTitles = data => Array.from(data.conferenceRows(CONF_NOW), row => row.title);

test('conference windows keep future deadlines, order them, and separate pending and past', () => {
  const data = loadData();
  seedConferences(data, [
    conference('Soon', [conferenceEvent('AI/soon:soon26:paper:1', { utc: '2026-11-05T12:00:00Z' })]),
    conference('Later', [conferenceEvent('AI/later:later26:paper:1', { utc: '2027-01-05T00:00:00Z' })]),
    conference('Far', [conferenceEvent('AI/far:far26:paper:1', { utc: '2027-03-01T00:00:00Z' })]),
    conference('Gone', [conferenceEvent('AI/gone:gone26:paper:1', { utc: '2026-09-01T00:00:00Z' })]),
    conference('Recent', [conferenceEvent('AI/recent:recent26:paper:1', { utc: '2026-10-01T00:00:00Z' })]),
    conference('Pending', [conferenceEvent('AI/pending:pending26:paper:1', { utc: null, source_local: 'TBD', tbd: true })])
  ]);
  data.state.conferenceWindow = '90';
  assert.deepEqual(confTitles(data), ['Soon', 'Later']);
  data.state.conferenceWindow = '365';
  assert.deepEqual(confTitles(data), ['Soon', 'Later', 'Far']);
  data.state.conferenceWindow = 'open';
  assert.deepEqual(confTitles(data), ['Soon', 'Later', 'Far']);
  data.state.conferenceWindow = 'past';
  assert.deepEqual(confTitles(data), ['Recent', 'Gone']);
  data.state.conferenceWindow = 'tbd';
  assert.deepEqual(confTitles(data), ['Pending']);
});

test('conference filters combine area, rank, stage and search', () => {
  const data = loadData();
  seedConferences(data, [
    conference('Alpha', [
      conferenceEvent('AI/alpha:alpha26:abstract:1', { kind: 'abstract', utc: '2026-11-01T00:00:00Z' }),
      conferenceEvent('AI/alpha:alpha26:paper:1', { utc: '2026-11-02T00:00:00Z' })
    ]),
    conference('Beta', [conferenceEvent('DB/beta:beta26:paper:1', { utc: '2026-11-03T00:00:00Z' })],
      { key: 'DB/beta', area: 'DB', rank: { ccf: 'B' } }),
    conference('Gamma', [conferenceEvent('AI/gamma:gamma26:paper:1', { utc: '2026-11-04T00:00:00Z' })], { rank: {} })
  ]);
  assert.deepEqual(confTitles(data), ['Alpha', 'Beta', 'Gamma']);
  data.state.conferenceArea = 'DB';
  assert.deepEqual(confTitles(data), ['Beta']);
  data.state.conferenceArea = 'all';
  data.state.conferenceRank = 'A';
  assert.deepEqual(confTitles(data), ['Alpha']);
  data.state.conferenceRank = '';
  assert.deepEqual(confTitles(data), ['Gamma']);
  data.state.conferenceRank = 'all';
  data.state.conferenceKind = 'abstract';
  assert.deepEqual(confTitles(data), ['Alpha']);
  data.state.conferenceKind = 'all';
  data.state.conferenceSearch = '  GAMMA ';
  assert.deepEqual(confTitles(data), ['Gamma']);
  data.state.conferenceSearch = '';
  data.state.conferenceWindow = 'open';
  data.state.conferencePage = 99;
  assert.equal(data.conferenceRows(CONF_NOW).length, 4);
  assert.equal(data.conferencePage(CONF_NOW).length, 4);
  assert.equal(data.conferencePageCount(), 1);
});

test('conference stats count paper deadlines and pick the nearest instant of any stage', () => {
  const data = loadData();
  seedConferences(data, [
    conference('Abstract', [conferenceEvent('AI/abstract:abstract26:abstract:1',
      { kind: 'abstract', utc: '2026-11-01T00:00:00Z' })]),
    conference('Paper', [conferenceEvent('AI/paper:paper26:paper:1', { utc: '2026-11-20T00:00:00Z' })]),
    conference('Quarter', [conferenceEvent('AI/quarter:quarter26:paper:1', { utc: '2027-01-10T00:00:00Z' })]),
    conference('Overdue', [conferenceEvent('AI/overdue:overdue26:paper:1', { utc: '2026-10-01T00:00:00Z' })]),
    conference('Pending', [conferenceEvent('AI/pending:pending26:paper:1', { utc: null, tbd: true })])
  ]);
  assert.deepEqual({ ...data.conferenceStats(CONF_NOW), next: data.conferenceStats(CONF_NOW).next.id },
    { events: 5, tbd: 1, paper30: 1, paper90: 2, next: 'AI/abstract:abstract26:abstract:1' });
  // Filters must not change the headline numbers.
  data.state.conferenceKind = 'all';
  data.state.conferenceSearch = 'Paper';
  assert.equal(data.conferenceStats(CONF_NOW).paper90, 2);
});

test('conference loading validates the source, keeps the last snapshot, and degrades alone', async () => {
  let payload = conferencePayload([conference('Keep', [conferenceEvent('AI/keep:keep26:paper:1')])]);
  const data = loadData(async url => {
    assert.equal(url, './data/conferences.json');
    return jsonResponse(payload);
  });
  await data.loadConferences();
  const first = data.state.conferences;
  assert.equal(data.state.conferenceRefreshError, null);
  assert.match(data.state.conferenceSnapshotCheckedAt, /^\d{4}-\d{2}-\d{2}T/);
  payload = { ...payload, source: { id: 'somewhere-else' } };
  await assert.rejects(data.refreshConferenceSnapshot(), /格式或数据来源不兼容/);
  assert.equal(data.state.conferences, first, 'a rejected payload must not replace the good snapshot');
  assert.match(data.state.conferenceRefreshError, /格式或数据来源不兼容/);
  payload = { ...first, schema_version: 2 };
  await assert.rejects(data.refreshConferenceSnapshot(), /格式或数据来源不兼容/);

  const offline = loadData(async () => jsonResponse({}, { status: 404 }));
  await offline.loadConferences();
  assert.equal(offline.state.conferences.status, 'unavailable');
  assert.deepEqual(Array.from(offline.conferenceRows(CONF_NOW)), []);
  assert.equal(offline.conferenceStats(CONF_NOW).events, 0);
});

test('the conference board escapes third-party text, counts down, and explains stale data', () => {
  const clock = testClock('2026-10-30T12:00:00.000Z');
  const data = loadData(undefined, { Date: clock.Date });
  seedConferences(data, [
    conference('<img src=x>', [conferenceEvent('AI/evil:evil26:paper:1', { utc: '2026-11-02T05:00:00Z' })],
      { key: 'AI/evil', place: null }),
    conference('Pending', [conferenceEvent('AI/pending:pending26:paper:1',
      { utc: null, tbd: true, source_local: 'TBD', timezone: '', offset_minutes: null })]),
    conference('Unparsed', [conferenceEvent('AI/unparsed:unparsed26:paper:1',
      { utc: null, time_status: 'unknown_timezone', source_local: '2026-12-01 23:59:59', timezone: 'Mars/Olympus', offset_minutes: null })])
  ]);
  const view = loadModelView(data);
  view.context.Date = clock.Date;
  view.render.renderConferences();

  assert.match(view.element('conferenceStatus').textContent,
    /^CCF-Deadlines 快照 · 3 个会议 · 3 个时间节点（论文 3）· 源数据更新于 2026-10-29 03:56 UTC/);
  assert.match(view.element('conferenceStatus').textContent, /新增 1 · 更新 0 · 移除 0（对比 2026-10-29 02:20 UTC）/);
  assert.match(view.element('conferenceFreshness').textContent, /快照采集于 2026-10-30 02:23 UTC · 距今/);
  assert.equal(view.element('conferenceCountBadge').textContent, '3');
  assert.equal(view.element('statNextDeadline').textContent, '2 天 17 小时');
  assert.equal(view.element('statNextDeadline').className, 'kpi-value urgent');
  assert.match(view.element('statNextDeadlineSub').textContent, /<img src=x> 2026 · 论文截止 · 2026-11-02 05:00 UTC/);

  const upcoming = view.element('conferenceUpcoming').innerHTML;
  assert.ok(!upcoming.includes('<img src=x>'), 'source titles must be escaped before insertion');
  assert.ok(upcoming.includes('&lt;img src=x&gt;'));
  assert.match(upcoming, /conf-item urgent/);
  assert.doesNotMatch(upcoming, /conf-item unknown/);
  assert.match(view.element('conferenceUpcomingNote').textContent, /未来 90 天/);
  assert.equal(view.element('conferencePagination').hidden, true);
  assert.match(view.element('conferenceTableCount').textContent, /1 \/ 3 EVENTS · 未来 90 天/);
  assert.match(view.element('conferenceRows').innerHTML, /2 天 17 小时/);

  // Events that never resolve to an instant stay reachable in their own window.
  data.state.conferenceWindow = 'tbd';
  view.render.renderConferenceTable();
  const unresolved = view.element('conferenceRows').innerHTML;
  assert.match(unresolved, /日期待定/);
  assert.match(unresolved, /Mars\/Olympus · 时区无法解析/);
  assert.match(unresolved, /conf-row unknown/);
  assert.match(view.element('conferenceTableCount').textContent, /2 \/ 3 EVENTS · 待定或无法解析/);
});

test('the conference board reports a missing snapshot without touching other panels', () => {
  const data = loadData();
  data.state.conferences = { status: 'unavailable', source: { id: 'ccfddl', name: 'CCF-Deadlines' }, conferences: [], error: 'HTTP 503' };
  data.state.conferenceRefreshError = '读取会议快照超时，请稍后重试';
  const view = loadModelView(data);
  view.render.renderConferences();
  assert.match(view.element('conferenceStatus').textContent, /会议数据暂不可用，其他看板不受影响/);
  assert.match(view.element('conferenceStatus').textContent, /快照读取失败，保留上次数据：读取会议快照超时/);
  assert.equal(view.element('conferenceExport').disabled, true);
  assert.equal(view.element('statNextDeadline').textContent, '—');
  assert.match(view.element('conferenceUpcoming').innerHTML, /当前筛选没有匹配的时间节点/);
  assert.match(view.element('conferenceRows').innerHTML, /等待会议数据|没有匹配的时间节点/);
});

test('conference refresh re-reads the published snapshot without touching the collector', async () => {
  const payloads = {
    ...publishedPayloads(),
    './data/conferences.json': conferencePayload([conference('Saved', [conferenceEvent('AI/saved:saved26:paper:1')])])
  };
  const requested = [];
  const data = loadData(async url => {
    requested.push(url);
    return jsonResponse(payloads[url], { status: Object.hasOwn(payloads, url) ? 200 : 404 });
  });
  await data.refreshConferenceSnapshot();
  assert.equal(requested.filter(url => url === './data/conferences.json').length, 1);
  assert.deepEqual(requested.filter(url => !url.startsWith('./data/')), [], 'the board must not call the third-party feed');
  assert.deepEqual(Array.from(data.conferenceRows(CONF_NOW), row => row.title), ['Saved']);
  assert.equal(data.conferenceStats(CONF_NOW).events, 1);
});

test('conference filters, paging, reset, refresh and CSV stay on the published snapshot', async () => {
  const clock = testClock('2026-10-30T12:00:00.000Z');
  const data = loadData(undefined, { Date: clock.Date });
  const many = Array.from({ length: 25 }, (_, index) => conferenceEvent(
    `AI/many:many26:paper:${index + 1}`, { utc: `2026-11-${String(index + 1).padStart(2, '0')}T12:00:00Z` }));
  seedConferences(data, [
    conference('=danger', [conferenceEvent('AI/danger:danger26:paper:1', { utc: '2026-11-01T00:00:00Z' })],
      { key: 'AI/danger' }),
    conference('Many', many),
    conference('Gone', [conferenceEvent('AI/gone:gone26:paper:1', { utc: '2026-01-01T00:00:00Z' })]),
    conference('Pending', [conferenceEvent('AI/pending:pending26:paper:1', { utc: null, tbd: true, source_local: 'TBD' })])
  ]);
  data.state.latest = { models: [] };
  const booted = deferred();
  let snapshotCalls = 0, snapshotFailure = null;
  const viewData = {
    ...data, loadAll: async () => {},
    refreshConferenceSnapshot: async () => {
      snapshotCalls++;
      if (snapshotFailure) throw snapshotFailure;
      return data.state.conferences;
    }
  };
  const view = loadModelView(viewData), toasts = [];
  view.context.Date = clock.Date;
  view.context.MO.theme = { init() {} };
  view.context.MO.templates = { init: async () => { booted.resolve(); } };
  view.context.MO.render = Object.fromEntries(Object.entries(view.render).map(([name, render]) =>
    [name, name.startsWith('renderConference') ? render : name === 'showToast' ? message => toasts.push(message) : () => {}]));
  view.run('app.js');
  await booted.promise;
  assert.equal(snapshotCalls, 0, 'boot must not re-read the snapshot the page already loaded');

  const change = (id, value) => view.element(id).events[
    id === 'conferenceSearch' ? 'input' : 'change']({ target: { value } });
  assert.match(view.element('conferenceTableCount').textContent, /^26 \/ 28 EVENTS · 未来 90 天$/);
  assert.equal(view.element('conferencePagination').hidden, false);
  assert.equal(view.element('conferencePageInfo').textContent, '1 / 2');
  view.element('conferenceNext').events.click();
  assert.equal(data.state.conferencePage, 2);
  assert.match(view.element('conferencePageInfo').textContent, /^2 \/ 2$/);

  change('conferenceSearch', 'many');
  assert.equal(data.state.conferencePage, 1, 'a new filter returns to the first page');
  assert.match(view.element('conferenceTableCount').textContent, /^25 \/ 28 EVENTS/);
  change('conferenceSearch', '');
  change('conferenceWindow', 'tbd');
  assert.match(view.element('conferenceRows').innerHTML, /日期待定/);
  change('conferenceKind', 'decision');
  assert.match(view.element('conferenceRows').innerHTML, /没有匹配的时间节点/);

  view.element('conferenceFilterReset').events.click();
  assert.equal(data.state.conferenceKind, 'paper');
  assert.equal(data.state.conferenceWindow, '90');
  assert.equal(data.state.conferenceSearch, '');
  assert.equal(view.element('conferenceKind').value, 'paper');
  assert.equal(view.element('conferenceWindow').value, '90');
  assert.match(view.element('conferenceStatus').textContent, /^CCF-Deadlines 快照/);

  await view.element('conferenceRefresh').events.click();
  assert.equal(snapshotCalls, 1);
  assert.equal(view.element('conferenceRefresh').disabled, false);
  assert.equal(view.element('conferenceRefresh').getAttribute('aria-busy'), 'false');
  assert.equal(view.element('conferenceRefresh').textContent, '刷新已发布快照');
  assert.match(toasts.at(-1), /已读取会议快照.*不会触发后台采集/);
  snapshotFailure = new Error('HTTP 503');
  await view.element('conferenceRefresh').events.click();
  assert.match(toasts.at(-1), /会议快照读取失败：HTTP 503。保留上次数据/);
  assert.equal(view.element('conferenceRefresh').disabled, false);

  const parseCsv = text => text.replace(/^﻿/, '').split('\r\n').map(row =>
    Array.from(row.matchAll(/"((?:[^"]|"")*)"/g), match => match[1].replace(/""/g, '"')));
  view.element('conferenceExport').onclick();
  assert.equal(view.blobs.at(-1).type, 'text/csv;charset=utf-8');
  const [header, ...rows] = parseCsv(await view.blobs.at(-1).text());
  assert.deepEqual(header, ['event_id', 'conference', 'conference_key', 'area', 'ccf', 'core', 'edition', 'year',
    'kind', 'round', 'comment', 'deadline_utc', 'utc_offset_minutes', 'timezone_label', 'source_local',
    'time_status', 'date_tbd', 'event_date', 'place', 'url', 'snapshot_captured_at', 'source_updated_at']);
  assert.equal(rows.length, 26, 'CSV exports every filter match, not only the visible page');
  assert.deepEqual(rows.map(row => row[0]), Array.from(data.conferenceRows(CONF_NOW), row => row.id));
  assert.equal(rows[0][1], "'=danger", 'formula-leading source text is neutralised');
  assert.equal(rows[0][11], '2026-11-01T00:00:00Z');
  assert.equal(rows[0][12], '-720');
  assert.equal(rows[0][16], 'false');
  assert.equal(rows.at(-1)[11], '2026-11-25T12:00:00Z');
});
