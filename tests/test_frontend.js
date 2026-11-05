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
function fakeElement() {
  const classes = new Set();
  return {
    innerHTML: '', textContent: '', value: '', events: {}, attributes: {}, disabled: false,
    dataset: {}, classes, scrolled: [],
    classList: {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      toggle: (name, on) => {
        const show = on === undefined ? !classes.has(name) : Boolean(on);
        if (show) classes.add(name); else classes.delete(name);
        return show;
      },
      contains: name => classes.has(name)
    },
    addEventListener(type, listener) { this.events[type] = listener; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name] ?? null; },
    removeAttribute(name) { delete this.attributes[name]; },
    click() {}, remove() {},
    // A browser element always answers this; the fake records instead of moving a
    // viewport, so a test can name the section a click is supposed to reach.
    scrollIntoView(options) { this.scrolled.push(options || {}); }
  };
}

function elementFactory(map = new Map()) {
  return id => {
    if (!map.has(id)) map.set(id, fakeElement());
    return map.get(id);
  };
}

function loadModelView(data, globals = {}) {
  const elements = new Map();
  const element = elementFactory(elements);
  const blobs = [];
  const chartCalls = [];
  const context = {
    console,
    MO: {
      data,
      charts: {
        line() {},
        yearBars() {},
        // render.js captures MO.charts at load time, so the star panels need the
        // same entry points the chart module exposes. Record the arguments so a
        // test can read exactly what the renderer asked the chart to draw.
        starWall(node, model, opts) { chartCalls.push({ name: 'starWall', node, model, opts }); },
        starGraph(node, graph, opts) { chartCalls.push({ name: 'starGraph', node, graph, opts }); },
        starColor: index => `var(--chart-${index % 5 + 1})`
      },
      // app.js boots the write-back panel next to the board itself. A test that
      // cares what the panel was asked to do replaces these methods and records.
      registry: {
        init: async () => {}, renderDrafts() {}, open: async slug => slug,
        pathFor: slug => `entities/${slug}.md`, state: { sync: {} }
      },
      tasksync: { init: async () => {}, renderPanel() {} }
    },
    document: {
      getElementById: element, querySelectorAll: () => [], addEventListener() {},
      createElement: () => ({ click() {}, remove() {} }), body: { append() {} }
    },
    Blob,
    URL: { createObjectURL(blob) { blobs.push(blob); return 'blob:local-test'; }, revokeObjectURL() {} },
    setTimeout(callback) { callback(); },
    // The task canvas is the one section the page reads lazily, so a harness
    // that never scrolls owes it no request. Boards that test the canvas build
    // their own observer; here it only has to exist.
    IntersectionObserver: class {
      observe() {}
      disconnect() {}
    },
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
  // app.js binds the canvas pointer handlers, so the modules behind them have
  // to be the real ones here too - a stub board would let a broken binding pass.
  run('repo.js');
  run('board.js');
  return { context, element, blobs, chartCalls, run, render: context.MO.render };
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
    './data/conferences.json': conferencePayload([conference('Keep', [conferenceEvent('AI/keep:keep26:paper:1')])]),
    './data/stars.json': starSnapshot(),
    './data/entities.json': entityPayload([entityEntry('youtu-ft-v1')])
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
      assert.equal(requested.length, 16, 'first paint now includes the run record');
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
    assert.equal(requested.length, 16, 'the run record is first-paint data, like the registry index');
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

function starCluster(id, type, label, repos, appears = repos) {
  return { id, type, label, repos, appears, reps: [{ n: 'a/one', s: 10 }] };
}

function starRow(name, extra = {}) {
  return { n: name, l: 'Python', t: ['llm'], s: 10, d: 'desc', p: '2026-10-01',
    f: 0, r: 0, o: 0, c: 'lang:Python', ...extra };
}

function starSnapshot(clusters = [starCluster('lang:Python', 'language', 'Python', 3)], extra = {}) {
  return {
    schema_version: 1,
    source: { id: 'github', login: 'isLinXu', api: 'users/isLinXu/starred', per_page: 100 },
    status: 'ok', error: null, captured_at: '2026-10-31T02:23:00Z', last_attempt_at: '2026-10-31T02:23:00Z',
    pages: 1, expected_total: 3,
    counts: { total: 3, languages: 1, topics: 1, owners: 2, org_owned: 0, archived: 0, forks: 0,
      undocumented: 1, active_90d: 2 },
    changes: { status: 'compared', added: [], removed: [], added_count: 1, removed_count: 0, truncated: false },
    clusters, edges: [], warnings: [], ...extra
  };
}

function starDetail(rows = [starRow('a/one')], extra = {}) {
  return {
    schema_version: 1, source: { id: 'github', login: 'isLinXu' },
    captured_at: '2026-10-31T02:23:00Z', count: rows.length, rows, ...extra
  };
}

function entityLink(domain, id, extra = {}) {
  return { domain, id, state: 'resolved', url: `https://example.invalid/${domain}/${id}`, ...extra };
}

function entityEntry(slug, extra = {}) {
  return {
    slug, title: slug.replace(/-/g, ' '), kind: 'project', stage: 'training', tags: ['demo'],
    updated: '2026-10-30', links: [entityLink('hf_model', `gatilin/${slug}`)],
    bytes: 200, lines: 6, sha256: 'abc123def456',
    // The page only ever compares this string against the live one, so a fixture
    // needs a distinct value per entry rather than a real git hash.
    blob_sha: `sha-${slug}`, truncated: false,
    url: `https://github.com/isLinXu/model-observatory/blob/main/entities/${slug}.md`,
    body: `# ${slug}\n\n正文说明`, ...extra
  };
}

function entityPayload(entries = [entityEntry('one')], extra = {}) {
  const links = entries.flatMap(entry => entry.links);
  const counted = state => links.filter(link => link.state === state).length;
  const tally = key => entries.reduce((map, entry) => {
    const value = entry[key] || '未标注';
    map[value] = (map[value] || 0) + 1;
    return map;
  }, {});
  return {
    schema_version: 1,
    source: { id: 'registry', directory: 'entities', repo: 'isLinXu/model-observatory', branch: 'main',
      url: 'https://github.com/isLinXu/model-observatory/tree/main/entities',
      kinds: ['project', 'model', 'dataset', 'paper'],
      stages: ['proposal', 'training', 'evaluating', 'submitting', 'shipped', 'archived'],
      domains: ['hf_model', 'hf_dataset', 'hf_collection', 'hf_space', 'ms_model', 'gh_repo',
        'scholar', 'conf', 'template'] },
    status: 'ok', error: null, captured_at: '2026-10-31T02:23:00Z', last_attempt_at: '2026-10-31T02:23:00Z',
    summary: { total: entries.length, links: links.length, by_kind: tally('kind'), by_stage: tally('stage'), tags: [] },
    validation: { resolved: counted('resolved'), unresolved: counted('unresolved'),
      unchecked: counted('unchecked'), out_of_scope: counted('out_of_scope') },
    coverage: {}, sources: {},
    changes: { status: 'compared', added: [], removed: [], revised: [], added_count: 0,
      removed_count: 0, revised_count: 0, truncated: false },
    entries, structural_errors: [], warnings: [], ...extra
  };
}

function seedEntities(data, entries, extra = {}) {
  data.state.entities = entityPayload(entries, extra);
  return data.state.entities;
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

test('the calendar export writes only real instants, escapes the source, and folds by octets', async () => {
  const clock = testClock('2026-10-30T12:00:00.000Z');
  const data = loadData(undefined, { Date: clock.Date });
  seedConferences(data, [
    conference('NeurIPS, 主会; 终稿\\v2', [
      conferenceEvent('AI/nips:nips26:paper:1', {
        utc: '2026-11-08T23:59:59Z', round: 2, comment: 'Camera ready, see; notes\\full'
      }),
      conferenceEvent('AI/nips:nips26:paper:2', {
        utc: '2026-12-01T09:00:00Z', timezone: '', source_local: ''
      })
    ], { key: 'AI/nips' }),
    conference('Pending', [conferenceEvent('AI/tbd:tbd26:paper:1', {
      utc: null, tbd: true, source_local: 'TBD'
    })]),
    conference('Mars', [conferenceEvent('AI/mars:mars26:paper:1', {
      utc: null, time_status: 'unknown_timezone', timezone: 'Mars/Olympus', source_local: '2026-12-05 23:59'
    })])
  ]);
  data.state.latest = { models: [] };
  const booted = deferred();
  const view = loadModelView({ ...data, loadAll: async () => {} });
  view.context.Date = clock.Date;
  view.context.MO.theme = { init() {} };
  view.context.MO.templates = { init: async () => booted.resolve() };
  const toasts = [];
  view.context.MO.render = { ...view.render, showToast: message => toasts.push(message) };
  view.run('app.js');
  await booted.promise;

  assert.equal(view.element('conferenceIcs').disabled, false,
    'the same snapshot that feeds the CSV enables the calendar');
  view.element('conferenceIcs').onclick();
  assert.equal(view.blobs.length, 1, 'one click writes one file');
  assert.equal(view.blobs[0].type, 'text/calendar;charset=utf-8');
  const text = await view.blobs[0].text();
  assert.ok(!text.startsWith('\uFEFF'), 'a calendar file opens with BEGIN, not with a byte-order mark');
  const lines = text.split('\r\n');
  for (const line of lines) {
    assert.ok(new TextEncoder().encode(line).length <= 75, `over the 75 octet line limit: ${line}`);
  }
  assert.ok(lines.some(line => line.startsWith(' ')), 'a long value really did need folding');
  const property = name => {
    const values = [];
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].startsWith(`${name}:`)) continue;
      let value = lines[index].slice(name.length + 1);
      while (lines[index + 1]?.startsWith(' ')) value += lines[++index].slice(1);
      values.push(value);
    }
    return values;
  };

  assert.deepEqual(property('UID'), ['AI-nips-nips26-paper-1@ccfddl.model-observatory',
    'AI-nips-nips26-paper-2@ccfddl.model-observatory'], 'the event id is the uid, so re-imports update');
  assert.deepEqual(property('DTSTART'), ['20261108T235959Z', '20261201T090000Z'],
    'UTC in the compact form, soonest first');
  assert.deepEqual(property('DTSTAMP'), ['20261030T120000Z', '20261030T120000Z']);
  assert.deepEqual(property('SUMMARY'), [
    'NeurIPS\\, 主会\\; 终稿\\\\v2 2026 · 论文截止 第 2 轮',
    'NeurIPS\\, 主会\\; 终稿\\\\v2 2026 · 论文截止'
  ], 'commas, semicolons and backslashes in source text are escaped, not dropped');
  const [firstNote] = property('DESCRIPTION');
  assert.match(firstNote, /来源备注：Camera ready\\, see\\; notes\\\\full/);
  assert.match(firstNote, /评级：CCF A/);
  assert.match(firstNote, /来源标注：2026-12-01 23:59:59（UTC-12），此处换算为 UTC/);
  assert.match(firstNote, /快照采集于 2026-10-30T02:23:00Z/);
  assert.match(property('DESCRIPTION')[1], /会期：December 2026 · Nowhere/,
    'a row with no timezone note still says when and where the conference is');
  assert.equal(property('DESCRIPTION')[1].includes('来源标注'), false,
    'an empty source label is not printed as an empty claim');
  assert.deepEqual(property('URL'), ['https://example.com/nips', 'https://example.com/nips'],
    'a URI keeps its punctuation instead of being TEXT-escaped');
  assert.equal(lines.filter(line => line === 'BEGIN:VEVENT').length, 2);
  assert.doesNotMatch(text, /AI-tbd|Olympus/,
    '待定 and unparseable timezones are left out rather than invented as all-day events');
  assert.match(property('X-WR-CALDESC')[0], /日期待定或时区认不出的节点不会写入/);
  assert.match(toasts.at(-1), /已导出 2 个节点/);

  data.state.conferenceWindow = 'tbd';
  view.element('conferenceIcs').onclick();
  assert.equal(view.blobs.length, 1, 'a filter with no instant at all writes no file');
  assert.match(toasts.at(-1), /都没能定到时刻/);
});

// --- Star wall and cluster graph --------------------------------------------

test('the star board paints from the aggregate snapshot and leaves the detail file lazy', async () => {
  const payloads = publishedPayloads();
  const detail = starDetail([starRow('a/one'), starRow('b/two', { s: 40, l: 'Rust', c: 'lang:Rust' })]);
  payloads['./data/stars_repos.json'] = detail;
  const requested = [];
  const data = loadData(publishedFetch(payloads, requested));
  await data.loadAll();

  assert.equal(requested.filter(url => url === './data/stars.json').length, 1);
  assert.equal(requested.filter(url => url === './data/stars_repos.json').length, 0,
    'the detail file must stay out of the first paint');
  assert.equal(data.state.starDetailStatus, 'idle');
  assert.equal(data.state.starDetail, null);
  assert.equal(data.starRows().length, 0);
  assert.equal(data.starWall().total, 0, 'the wall is empty until the detail arrives');
  assert.deepEqual(plain(data.starGraph().nodes.map(node => node.id)), ['lang:Python'],
    'the graph already has nodes from the snapshot alone');
  assert.deepEqual(plain(data.starStats()), {
    available: true, total: 3, active: 2, activeShare: 2 / 3, languages: 1, topics: 1, owners: 2,
    orgOwned: 0, archived: 0, forks: 0, undocumented: 1, pages: 1, expected: 3,
    changes: starSnapshot().changes, clusters: 1, publishedClusters: 1, edges: 0
  });

  assert.equal(await data.ensureStarDetail(), detail);
  assert.equal(requested.filter(url => url === './data/stars_repos.json').length, 1);
  assert.equal(data.state.starDetailStatus, 'ready');
  assert.equal(data.state.starDetailLoadedAt, detail.captured_at);
  assert.equal(data.starWall().total, 2);
  assert.equal(await data.ensureStarDetail(), detail, 'the cached payload answers without a second fetch');
  assert.equal(requested.filter(url => url === './data/stars_repos.json').length, 1);
});

test('star detail shares one in-flight request, retries only on demand, and keeps rows when a retry fails', async () => {
  const detail = starDetail([starRow('a/one'), starRow('b/two', { s: 40 })]);
  let calls = 0, failing = false;
  const data = loadData(async url => {
    if (!url.endsWith('stars_repos.json')) return jsonResponse({}, { status: 404 });
    calls++;
    return failing ? jsonResponse({}, { status: 503 }) : jsonResponse(detail);
  });
  const pending = data.ensureStarDetail();
  assert.equal(data.state.starDetailStatus, 'loading');
  const shared = data.ensureStarDetail();
  assert.equal(await pending, detail);
  assert.equal(await shared, detail);
  assert.equal(calls, 1, 'concurrent callers share the in-flight request');

  failing = true;
  assert.equal(await data.ensureStarDetail(true), null);
  assert.equal(calls, 2);
  assert.equal(data.state.starDetailStatus, 'error');
  assert.equal(data.state.starDetailError, '仓库明细 读取失败（HTTP 503）');
  assert.equal(data.state.starDetail, detail, 'a failed retry keeps the rows already on screen');
  assert.equal(data.starRows().length, 2);
  assert.equal(await data.ensureStarDetail(), detail);
  assert.equal(calls, 2, 'without force the cached payload still answers');

  failing = false;
  assert.equal(await data.ensureStarDetail(true), detail);
  assert.equal(data.state.starDetailStatus, 'ready');
  assert.equal(data.state.starDetailError, null);
});

test('star detail refuses payloads it cannot render instead of drawing half a wall', async () => {
  for (const bad of [
    { schema_version: 2, rows: [] },
    { schema_version: 1, rows: [{ n: 42 }] },
    { schema_version: 1, rows: 'not a list' }
  ]) {
    const data = loadData(async () => jsonResponse(bad));
    assert.equal(await data.ensureStarDetail(), null);
    assert.equal(data.state.starDetailStatus, 'error');
    assert.match(data.state.starDetailError, /star 明细格式不完整/);
    assert.equal(data.state.starDetail, null);
    assert.deepEqual(plain(data.starRows()), []);
  }
});

test('a missing or incompatible star snapshot degrades the board alone', async () => {
  const payloads = publishedPayloads();
  delete payloads['./data/stars.json'];
  const requested = [];
  const data = loadData(publishedFetch(payloads, requested));
  await data.loadAll();
  assert.equal(requested.filter(url => url === './data/stars_repos.json').length, 0);
  assert.equal(data.state.stars.status, 'unavailable');
  assert.equal(data.state.stars.source.id, 'github');
  assert.deepEqual(plain(data.state.stars.clusters), []);
  assert.deepEqual(plain(data.state.stars.edges), []);
  assert.match(data.state.stars.error, /HTTP 404/);
  assert.equal(data.starStats().available, false);
  assert.equal(data.starStats().total, 0);
  assert.equal(data.state.status, 'ready', 'a missing star snapshot must not sink the page');
  assert.equal(data.state.conferences.status, 'ok');

  const foreign = publishedPayloads();
  foreign['./data/stars.json'] = starSnapshot(undefined, { source: { id: 'gitlab' } });
  const other = loadData(publishedFetch(foreign));
  await other.loadStars();
  assert.equal(other.state.stars.status, 'unavailable');
  assert.match(other.state.stars.error, /格式或数据来源不兼容/);

  const keep = publishedPayloads();
  const third = loadData(publishedFetch(keep));
  await third.loadStars();
  const snapshot = third.state.stars, checkedAt = third.state.starSnapshotCheckedAt;
  keep['./data/stars.json'] = starSnapshot(undefined, { schema_version: 0 });
  await assert.rejects(third.refreshStarSnapshot(), /格式或数据来源不兼容/);
  assert.equal(third.state.stars, snapshot, 'a rejected refresh keeps the last good snapshot');
  assert.equal(third.state.starSnapshotCheckedAt, checkedAt, 'a failed read is not logged as a successful one');
  assert.match(third.state.starRefreshError, /格式或数据来源不兼容/);

  third.state.starCluster = 'topic:llm';
  keep['./data/stars.json'] = starSnapshot([starCluster('lang:Python', 'language', 'Python', 4)]);
  assert.equal(await third.refreshStarSnapshot(), keep['./data/stars.json']);
  assert.equal(third.state.stars.clusters.length, 1);
  assert.equal(third.state.starRefreshError, null, 'a successful read clears the previous read failure');
});

test('star rows, filters, facets and paging read the published detail without inventing data', () => {
  const clock = testClock('2026-10-31T06:00:00.000Z');
  const data = loadData(undefined, { Date: clock.Date });
  data.state.stars = starSnapshot([
    starCluster('lang:Python', 'language', 'Python', 3),
    starCluster('lang:Rust', 'language', 'Rust', 1)
  ]);
  const payload = starDetail([
    starRow('a/fresh', { s: 500 }),
    starRow('b/old', { s: 40, l: 'Rust', c: 'lang:Rust', p: '2025-01-01' }),
    starRow('c/plain', { s: null, l: '', t: [], d: '', p: null, f: 1, c: '' }),
    starRow('d/archived', { s: 10, r: 1 })
  ]);
  const before = plain(payload);
  data.state.starDetail = payload;

  assert.deepEqual(plain(data.starRows()[0]), {
    name: 'a/fresh', owner: 'a', repo: 'fresh', url: 'https://github.com/a/fresh',
    language: 'Python', topics: ['llm'], stars: 500, description: 'desc', pushed: '2026-10-01',
    fork: false, archived: false, org: false, cluster: 'lang:Python'
  });
  assert.equal(data.starRows()[2].cluster, 'lang:未知', 'a row with no cluster id lands on the unknown node');
  assert.equal(data.starRows()[2].stars, null, 'an unknown counter is never presented as zero');
  assert.equal(data.starClusterType('lang:Python'), 'language', 'the id prefix maps to the published type');
  assert.equal(data.starClusterType('topic:llm'), 'topic');
  assert.equal(data.starClusterType('license:MIT'), 'license', 'an unknown prefix stays visible as itself');

  const names = rows => plain(rows.map(row => row.name));
  assert.deepEqual(names(data.starFiltered()), ['a/fresh', 'b/old', 'd/archived', 'c/plain']);
  data.state.starCluster = 'lang:Rust';
  assert.deepEqual(names(data.starFiltered()), ['b/old']);
  data.state.starCluster = 'lang:未知';
  assert.deepEqual(names(data.starFiltered()), ['c/plain']);
  data.state.starCluster = 'all';
  data.state.starLanguage = 'Rust';
  assert.deepEqual(names(data.starFiltered()), ['b/old']);
  data.state.starLanguage = 'all';
  data.state.starTopic = 'llm';
  assert.deepEqual(names(data.starFiltered()), ['a/fresh', 'b/old', 'd/archived']);
  data.state.starTopic = 'all';
  for (const [status, expected] of [
    ['maintained', ['a/fresh', 'd/archived']], ['archived', ['d/archived']],
    ['fork', ['c/plain']], ['undocumented', ['c/plain']]
  ]) {
    data.state.starStatus = status;
    assert.deepEqual(names(data.starFiltered()), expected, `status filter ${status}`);
  }
  data.state.starStatus = 'all';
  data.state.starSearch = '  ARCHIVED ';
  assert.deepEqual(names(data.starFiltered()), ['d/archived']);
  data.state.starSearch = '';

  data.state.starSort = 'name';
  assert.deepEqual(names(data.starFiltered()), ['a/fresh', 'b/old', 'c/plain', 'd/archived']);
  data.state.starSort = 'pushed';
  assert.deepEqual(names(data.starFiltered()), ['a/fresh', 'd/archived', 'b/old', 'c/plain']);
  data.state.starSort = 'stars';

  assert.deepEqual(plain(data.starFacets()), {
    payload, languages: [{ label: 'Python', count: 2 }, { label: 'Rust', count: 1 }],
    topics: [{ label: 'llm', count: 3 }]
  });
  assert.equal(data.starFacets(), data.starFacets(), 'facets are memoised per payload');
  assert.deepEqual(plain(payload), before, 'the published detail is never mutated');

  const many = starDetail(Array.from({ length: 60 },
    (_, index) => starRow(`p/n${String(index).padStart(2, '0')}`, { s: 60 - index })));
  const paged = loadData();
  paged.state.starDetail = many;
  assert.equal(paged.starPageCount(), 3);
  assert.equal(paged.starPage().length, 24);
  paged.state.starPage = 3;
  assert.equal(paged.starPage().at(-1).name, 'p/n59');
  paged.state.starPage = 9;
  assert.deepEqual(names(paged.starPage()), names(paged.starFiltered().slice(48, 60)),
    'a page index past the end clamps to the last page');
});

test('the star wall groups one contiguous run per cluster id, even when the detail outlives the snapshot', () => {
  const data = loadData();
  data.state.stars = starSnapshot([]);
  data.state.starDetail = starDetail([
    starRow('a/one', { c: 'lang:Python' }),
    starRow('b/two', { c: 'lang:Python', s: 20 }),
    starRow('c/three', { c: 'lang:Rust' }),
    starRow('d/four', { c: 'lang:Rust' }),
    starRow('e/five', { c: 'lang:Rust' }),
    starRow('f/six', { c: '' })
  ]);
  const wall = data.starWall();
  assert.equal(wall.total, 6);
  assert.equal(wall.groups.length, 3, 'one group per cluster id, not one per repository');
  assert.deepEqual(plain(wall.groups.map(group => [group.id, group.count, group.start])),
    [['lang:Rust', 3, 0], ['lang:Python', 2, 3], ['lang:未知', 1, 5]]);
  assert.deepEqual(plain(wall.cells.map(cell => cell.name)),
    ['c/three', 'd/four', 'e/five', 'b/two', 'a/one', 'f/six'],
    'cells flow in group order and bigger clusters come first');
  assert.equal(wall.groups[1].label, 'Python', 'the id suffix becomes the readable label');
  assert.equal(wall.groups[1].type, 'language');
  assert.equal(wall.groups[2].label, '未知');
  assert.equal(data.starWall(), wall, 'the model is memoised per payload and snapshot');
  assert.deepEqual(plain(data.starWall().groups.map(group => group.id)), plain(wall.groups.map(group => group.id)),
    're-reading the model still yields one group per cluster');

  // The same detail beside a snapshot that publishes those clusters uses their labels.
  data.state.stars = starSnapshot([
    starCluster('lang:Rust', 'language', 'Rust 语言', 3),
    starCluster('lang:Python', 'language', 'Python', 2)
  ]);
  assert.deepEqual(plain(data.starWall().groups.map(group => [group.id, group.label, group.appears])),
    [['lang:Rust', 'Rust 语言', 3], ['lang:Python', 'Python', 2], ['lang:未知', '未知', 0]],
    'snapshot labels win over the derived ones');
});

test('the star graph keeps one ring budget per cluster type and reports what it left out', () => {
  const clusters = [
    ...Array.from({ length: 12 }, (_, index) => starCluster(`lang:l${index}`, 'language', `L${index}`, 100 - index)),
    ...Array.from({ length: 24 }, (_, index) => starCluster(`topic:t${index}`, 'topic', `T${index}`, 50 - index)),
    ...Array.from({ length: 11 }, (_, index) => starCluster(`owner:o${index}`, 'owner', `O${index}`, 20 - index)),
    starCluster('lang:zero', 'language', 'Zero', 0),
    starCluster('license:MIT', 'license', 'MIT', 9)
  ];
  const data = loadData();
  data.state.stars = starSnapshot(clusters, { edges: [
    { a: 'lang:l0', b: 'topic:t0', w: 5 },
    { a: 'lang:l10', b: 'topic:t0', w: 4 },
    { a: 'lang:l0', b: 'owner:o0', w: 3 },
    { a: 'lang:l0', b: 'lang:l1', w: 0 }
  ] });
  const graph = data.starGraph();
  const perType = type => graph.nodes.filter(node => node.type === type).length;
  assert.deepEqual({ language: perType('language'), topic: perType('topic'), owner: perType('owner') },
    { language: 10, topic: 22, owner: 10 });
  assert.equal(graph.nodes[0].id, 'lang:l0', 'the largest clusters are drawn first');
  assert.equal(graph.hidden, 6, 'smaller clusters and unplaceable types stay out of the rings');
  assert.deepEqual(plain(graph.edges.map(edge => edge.w)), [5, 3, 0], 'a zero co-occurrence is a real edge');
  assert.equal(graph.missing, 1, 'edges to a node the budget dropped are counted, not silently lost');

  const empty = loadData();
  empty.state.stars = starSnapshot([]);
  assert.deepEqual(plain(empty.starGraph()), { nodes: [], edges: [], hidden: 0, missing: 0 });
});

test('the star board separates snapshot metrics from detail rows and escapes every third-party string', () => {
  const clock = testClock('2026-10-31T06:00:00.000Z');
  const data = loadData(undefined, { Date: clock.Date });
  data.state.stars = starSnapshot([
    starCluster('lang:Python', 'language', 'Python', 2),
    starCluster('topic:llm', 'topic', '<i>LLM</i>', 1),
    // The collector also publishes nodes that a repository never lands on as its
    // primary cluster; drawing or counting them would restate the KPI.
    starCluster('owner:nobody', 'owner', 'nobody', 0)
  ], { edges: [{ a: 'lang:Python', b: 'topic:llm', w: 1 }] });
  data.state.starDetail = starDetail([
    starRow('a/fresh', { s: 500 }),
    starRow('a/second', { s: 200 }),
    starRow('<svg/onload>bad</svg/onload>', { s: 4, d: '<img src=x onerror=alert(1)>', r: 1, c: 'topic:llm' }),
    starRow('c/plain', { s: null, l: '', d: '', p: null, f: 1, c: '' })
  ]);
  data.state.starDetailStatus = 'ready';
  data.state.starDetailLoadedAt = '2026-10-31T02:23:00Z';
  data.state.starSnapshotCheckedAt = '2026-10-31T05:59:00Z';
  const view = loadModelView({ ...data, loadAll: async () => {} }, { Date: clock.Date });
  view.render.renderStars();

  assert.equal(view.element('starStatus').textContent,
    'GitHub 公开 star 快照 · 3 个仓库 · 1 页 · 采集于 2026-10-31 02:23 UTC · 较上次采集 新增 1 · 取消 0');
  assert.equal(view.element('starFreshness').textContent,
    '快照采集于 2026-10-31 02:23 UTC · 距今 3 小时 · 最近读取 2026-10-31 05:59 UTC（读取不触发采集）');
  assert.equal(view.element('starSnapshotCheckedAt').textContent,
    '最近成功读取快照 2026-10-31 05:59 UTC · 采集由每日工作流完成');
  assert.equal(view.element('starDetailNote').textContent,
    '4 个仓库明细已加载 · 明细采集于 2026-10-31 02:23 UTC · 仅在进入本节视口时读取，首屏不下载' +
    ' · 墙、清单与 CSV 来自明细，KPI 与关系图来自 2 个聚类节点的快照');
  assert.equal(view.element('starExport').disabled, false);
  assert.equal(view.element('starDetailLoad').textContent, '重新加载 star 明细');
  assert.equal(view.element('starFilterReset').disabled, true, 'no filter is active yet');
  // The headline numbers stay on the collector summary even when the detail file
  // is a different day, so a KPI is never quietly restated from a partial load.
  assert.deepEqual({
    total: view.element('statStars').textContent,
    sub: view.element('statStarsSub').textContent,
    active: view.element('statStarActive').textContent,
    activeSub: view.element('statStarActiveSub').textContent,
    clusters: view.element('statStarClusters').textContent,
    special: view.element('statStarSpecial').textContent
  }, {
    total: '3', sub: '1 种语言 · 1 个主题 · 2 个所有者', active: '66.7%',
    activeSub: '90 天内有推送 2 / 3 个仓库', clusters: '2', special: '0'
  });

  // A node that owns no repository is not a filter choice, and the board states
  // one cluster count wherever it appears rather than 2 in one line and 3 in another.
  const clusterOptions = view.element('starCluster').innerHTML;
  assert.doesNotMatch(clusterOptions, /owner:nobody/);
  assert.match(clusterOptions, /value="topic:llm"/);
  assert.doesNotMatch(view.element('starDetailNote').textContent, /3 个聚类节点/);
  assert.equal(view.element('statStarClustersSub').textContent, '3 个快照节点，仅 2 个分到仓库');

  const wall = view.chartCalls.filter(call => call.name === 'starWall').at(-1);
  assert.equal(wall.node, view.element('starWall'));
  assert.equal(wall.model.total, 4);
  assert.deepEqual(plain(wall.model.groups.map(group => [group.id, group.count])),
    [['lang:Python', 2], ['lang:未知', 1], ['topic:llm', 1]]);
  assert.equal(wall.opts.activeCluster, 'all');
  assert.equal(wall.opts.label, 'star 星星墙：4 个仓库，一格一个');
  const graph = view.chartCalls.filter(call => call.name === 'starGraph').at(-1);
  assert.deepEqual(plain(graph.graph.nodes.map(node => node.id)), ['lang:Python', 'topic:llm']);
  assert.equal(graph.graph.edges.length, 1);
  assert.match(view.element('starGraphNote').textContent,
    /^内环＝语言，中环＝主题，外环＝账户 · 2 个节点、1 条关系 · 连线粗细/);

  const legend = view.element('starWallLegend').innerHTML;
  assert.doesNotMatch(legend, /<i>LLM<\/i>/);
  assert.match(legend, /&lt;i&gt;LLM&lt;\/i&gt;/);
  assert.match(legend, /data-cluster="topic:llm"/);
  assert.match(legend, /--star-chip:var\(--chart-1\)/);
  assert.match(legend, /<b>2<\/b>/);
  assert.match(view.element('starWallNote').textContent, /^4 格 · 一格一仓库 · 3 种颜色对应 3 个聚类/);

  const markup = view.element('starRows').innerHTML;
  assert.doesNotMatch(markup, /<svg\/onload>|<img src=x/);
  assert.match(markup, /&lt;svg\/onload&gt;bad&lt;\/svg\/onload&gt;/);
  assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(markup, /href="https:\/\/github\.com\/&lt;svg\/onload&gt;bad&lt;\/svg\/onload&gt;"/);
  assert.match(markup, /star-flag-archived">归档</);
  assert.match(markup, /star-flag-fork">fork</);
  assert.match(markup, /star-flag-undocumented">无描述</);
  assert.match(markup, /data-star-topic="llm"/);
  assert.match(markup, /语言 · 未知/);
  assert.match(markup, /主题 · &lt;i&gt;LLM&lt;\/i&gt;/);
  assert.match(markup, /正常</);
  assert.equal(view.element('starTableCount').textContent, '4 / 4 REPOSITORIES');
  assert.equal(view.element('starPagination').hidden, true);

  // A detail failure only removes the wall, list and export; the snapshot panels stay.
  data.state.starDetail = null;
  data.state.starDetailStatus = 'error';
  data.state.starDetailError = '仓库明细 读取失败（HTTP 404）';
  view.render.renderStars();
  assert.equal(view.element('starDetailNote').textContent,
    '仓库明细 读取失败（HTTP 404）；指标与图谱仍来自快照。');
  assert.equal(view.element('starExport').disabled, true);
  assert.equal(view.element('starDetailLoad').textContent, '重试加载 star 明细');
  const failedWall = view.chartCalls.filter(call => call.name === 'starWall').at(-1);
  assert.equal(failedWall.model.total, 0);
  assert.equal(failedWall.opts.emptyText,
    '仓库明细 读取失败（HTTP 404），可点击「重试加载 star 明细」。');
  assert.match(view.element('starTableCount').textContent, /^等待 star 明细$/);
  assert.match(view.element('starRows').innerHTML, /star 明细尚未加载/);
  assert.deepEqual(plain(view.chartCalls.filter(call => call.name === 'starGraph').at(-1).graph.nodes
    .map(node => node.id)), ['lang:Python', 'topic:llm'], 'the graph keeps working from the snapshot');

  // Nothing has been fetched yet on a fresh page.
  data.state.starDetailStatus = 'idle';
  data.state.starDetailError = null;
  data.state.starSnapshotCheckedAt = null;
  view.render.renderStars();
  assert.equal(view.element('starDetailLoad').textContent, '加载 star 明细');
  assert.match(view.element('starDetailNote').textContent, /^star 明细尚未加载：滚动到本节会自动读取/);
  assert.match(view.element('starSnapshotCheckedAt').textContent, /^尚未成功读取快照 · 采集由每日工作流完成$/);
});

test('the star selects follow the options that are actually on screen', () => {
  const data = loadData();
  data.state.stars = starSnapshot([starCluster('lang:Python', 'language', 'Python', 2)]);
  data.state.starDetail = starDetail([
    starRow('a/one'),
    starRow('a/two', { l: 'Rust', c: 'lang:Rust' })
  ]);
  data.state.starDetailStatus = 'ready';
  data.state.starCluster = 'lang:Gone';
  data.state.starLanguage = 'Go';
  data.state.starTopic = 'rl';
  const view = loadModelView({ ...data, loadAll: async () => {} });
  view.render.renderStars();

  assert.equal(data.state.starCluster, 'all', 'a cluster that is on neither wall nor snapshot cannot stay selected');
  assert.equal(data.state.starLanguage, 'all', 'a language the detail does not list cannot stay selected');
  assert.equal(data.state.starTopic, 'all');
  assert.deepEqual({
    cluster: view.element('starCluster').value,
    language: view.element('starLanguage').value,
    topic: view.element('starTopic').value
  }, { cluster: 'all', language: 'all', topic: 'all' });
  assert.match(view.element('starCluster').innerHTML, /^<option value="all">全部聚类<\/option>/);
  assert.match(view.element('starLanguage').innerHTML, /<option value="Rust">Rust \(1\)<\/option>/);
  assert.doesNotMatch(view.element('starLanguage').innerHTML, /<option value="all">全部聚类/);

  // Once the wall is on screen its own clusters are selectable, even when the
  // snapshot beside it has not caught up with the detail file yet.
  assert.match(view.element('starCluster').innerHTML, /<option value="lang:Rust">语言 · Rust \(1\)<\/option>/);
  data.state.starCluster = 'lang:Rust';
  view.render.renderStars();
  assert.equal(data.state.starCluster, 'lang:Rust', 'a cluster the wall draws keeps its selection');
  assert.equal(view.element('starCluster').value, 'lang:Rust');
  assert.equal(view.element('starLanguage').value, 'all');

  data.state.starLanguage = 'Python';
  view.render.renderStars();
  assert.equal(data.state.starLanguage, 'Python', 'an option that exists keeps its selection');
  assert.equal(view.element('starLanguage').value, 'Python');
});

test('the star wall chart gives every repository one cell and dims only the unselected clusters', () => {
  const data = loadData();
  data.state.stars = starSnapshot([
    starCluster('lang:Python', 'language', '<b>Python</b>', 150),
    starCluster('topic:llm', 'topic', 'LLM', 50)
  ]);
  data.state.starDetail = starDetail([
    ...Array.from({ length: 150 }, (_, index) => starRow(`p/py${index}`, { s: 1000 - index })),
    ...Array.from({ length: 50 }, (_, index) => starRow(`p/llm${index}`, { s: 10, c: 'topic:llm' }))
  ]);
  const view = loadModelView(data);
  view.run('charts.js');
  const charts = view.context.MO.charts;
  const node = view.element('starWall');
  const model = data.starWall();
  assert.equal(model.groups.length, 2, 'the snapshot clusters, not the detail rows, define the groups');

  charts.starWall(node, model, { activeCluster: 'all' });
  const markup = node.innerHTML;
  const cells = [...markup.matchAll(/<rect data-i="(\d+)" x="([\d.]+)" y="([\d.]+)" width="(\d+)" height="\4"/g)];
  assert.equal(cells.length, 200, 'one cell per starred repository');
  assert.deepEqual(plain(cells.map(cell => Number(cell[1]))), Array.from({ length: 200 }, (_, index) => index),
    'cell indexes flow in wall order for the hover readout');
  const [, width, height] = markup.match(/viewBox="0 0 (\d+) (\d+)"/);
  assert.equal(Number(width) % 15, 0, 'the grid pitch is one fifth of the viewBox width');
  assert.ok(Number(width) <= 140 * 15 && Number(height) <= 40 * 15, 'the wall stays one dense SVG, not thousands of rows');
  for (const cell of cells) {
    assert.ok(Number(cell[2]) < Number(width) && Number(cell[3]) < Number(height), `${cell[1]} is inside the viewBox`);
  }
  assert.equal((markup.match(/<g /g) || []).length, 2);
  assert.match(markup, /<g fill="var\(--chart-1\)" data-cluster="lang:Python"/);
  assert.match(markup, /<g fill="var\(--chart-2\)" data-cluster="topic:llm"/);
  assert.doesNotMatch(markup, /opacity=/, 'nothing is dimmed while every cluster is in scope');
  assert.doesNotMatch(markup, /<b>Python<\/b>/);
  assert.match(markup, /<title>&lt;b&gt;Python&lt;\/b&gt; · 150 个仓库</);
  const sizes = cells.map(cell => Number(cell[4]));
  assert.ok(sizes[0] > sizes[150], 'a 1000-star repository is larger than a 10-star one');

  charts.starWall(node, model, { activeCluster: 'topic:llm' });
  assert.equal((node.innerHTML.match(/opacity="\.22"/g) || []).length, 1,
    'only the other clusters fade out');
  assert.match(node.innerHTML, /data-cluster="topic:llm">/);
  assert.doesNotMatch(node.innerHTML, /data-cluster="topic:llm" opacity/);

  charts.starWall(node, { cells: [], groups: [], total: 0 }, { activeCluster: 'all' });
  assert.equal(node.innerHTML, '<div class="chart-empty">等待 star 明细：滚动到本节会自动读取，也可以手动重试。</div>');
  charts.starWall(node, { cells: [], groups: [], total: 0 }, { emptyText: '明细读取失败' });
  assert.match(node.innerHTML, /^<div class="chart-empty">明细读取失败<\/div>$/);
});

test('the cluster graph chart rings each type and weights edges by co-occurrence', () => {
  const view = loadModelView(loadData());
  view.run('charts.js');
  const charts = view.context.MO.charts;
  const node = view.element('starGraph');
  const nodes = [
    { id: 'lang:Python', label: 'Python', type: 'language', repos: 9, appears: 9 },
    { id: 'lang:Rust', label: 'Rust', type: 'language', repos: 4, appears: 4 },
    { id: 'topic:<b>llm</b>', label: '<b>llm</b>', type: 'topic', repos: 4, appears: 6 },
    { id: 'owner:gatilin', label: 'gatilin', type: 'owner', repos: 1, appears: 1 }
  ];
  charts.starGraph(node, { nodes, edges: [
    { a: 'lang:Python', b: 'topic:<b>llm</b>', w: 10 },
    { a: 'lang:Rust', b: 'owner:gatilin', w: 1 }
  ] }, {});
  const markup = node.innerHTML;
  const circles = [...markup.matchAll(/<circle class="star-node" data-cluster="([^"]+)" cx="([\d.-]+)" cy="([\d.-]+)" r="([\d.]+)"/g)];
  assert.equal(circles.length, 4);
  const ringOf = { lang: 74, topic: 146, owner: 196 };
  for (const circle of circles) {
    const type = circle[1].split(':')[0];
    const distance = Math.hypot(Number(circle[2]) - 420, Number(circle[3]) - 226);
    assert.ok(Math.abs(distance - ringOf[type]) < 0.5, `${type} sits on ring ${ringOf[type]}`);
  }
  const radiusOf = id => Number(circles.find(circle => circle[1].startsWith(id))[4]);
  assert.ok(radiusOf('lang:Python') > radiusOf('lang:Rust'), 'node size follows repository count');
  assert.ok(radiusOf('lang:Rust') > radiusOf('owner:gatilin'));
  const lines = [...markup.matchAll(/<line class="star-edge"[^>]*stroke-width="([\d.]+)" opacity="([\d.]+)"/g)];
  assert.deepEqual(plain(lines.map(line => [Number(line[1]), Number(line[2])])), [[3.1, 0.56], [0.76, 0.18]],
    'the strongest co-occurrence draws the heaviest line');
  assert.equal((markup.match(/class="svg-label star-node-label"/g) || []).length, 3,
    'only the large clusters get a label, so the rings stay readable');
  assert.doesNotMatch(markup, /<b>llm<\/b>/);
  assert.match(markup, /&lt;b&gt;llm&lt;\/b&gt;/);

  charts.starGraph(node, { nodes: [nodes[0]], edges: [{ a: 'lang:Python', b: 'lang:Gone', w: 3 }] }, {});
  assert.doesNotMatch(node.innerHTML, /<line/, 'an edge with a missing end is never drawn');
  charts.starGraph(node, { nodes: [], edges: [] }, { emptyText: '等待 star 快照中的聚类节点。' });
  assert.equal(node.innerHTML, '<div class="chart-empty">等待 star 快照中的聚类节点。</div>');
});

test('the star board pulls the detail on viewport entry, filters the wall, and exports the published rows', async () => {
  const payloads = publishedPayloads();
  payloads['./data/stars_repos.json'] = starDetail([
    starRow('a/fresh', { s: 500 }),
    starRow('b/old', { s: 40, l: 'Rust', c: 'lang:Rust', p: '2025-01-01', o: 1 }),
    starRow('=danger', { s: 5, d: '=cmd', c: 'topic:llm' })
  ]);
  const requested = [];
  const data = loadData(publishedFetch(payloads, requested));
  await data.loadAll();
  assert.equal(requested.filter(url => url === './data/stars.json').length, 1);

  const observers = [];
  class IntersectionObserver {
    constructor(callback, options) { this.callback = callback; this.options = options; observers.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.disconnected = (this.disconnected || 0) + 1; }
  }
  const booted = deferred();
  let snapshotCalls = 0, snapshotFailure = null;
  const viewData = {
    ...data, loadAll: async () => {},
    refreshStarSnapshot: async () => {
      snapshotCalls++;
      if (snapshotFailure) throw snapshotFailure;
      return data.state.stars;
    }
  };
  const view = loadModelView(viewData, { IntersectionObserver });
  const toasts = [];
  view.context.MO.theme = { init() {} };
  view.context.MO.templates = { init: async () => { booted.resolve(); } };
  view.context.MO.render = Object.fromEntries(Object.entries(view.render).map(([name, render]) =>
    [name, /^(renderStar|renderConference)/.test(name) ? render
      : name === 'showToast' ? message => toasts.push(message) : () => {}]));
  view.run('app.js');
  await booted.promise;

  const detailCalls = () => requested.filter(url => url === './data/stars_repos.json').length;
  assert.equal(detailCalls(), 0, 'first paint must not download the detail file');
  // Three sections read on entry: the star detail, the task canvas and the paper
  // lists. None of them is asked for before the reader gets near it.
  assert.deepEqual(observers.map(observer => observer.target),
    [view.element('stars'), view.element('tasks'), view.element('awesome')]);
  const observers0 = observers;
  const starObserver = observers0[0];
  assert.equal(starObserver.options.rootMargin, '300px 0px');
  assert.equal(observers[1].options.rootMargin, '300px 0px');
  assert.equal(observers[2].options.rootMargin, '300px 0px');
  assert.equal(requested.filter(url => url === './data/tasks.json').length, 0,
    'the canvas is not downloaded while it is still below the fold');

  starObserver.callback([{ isIntersecting: false }]);
  assert.equal(detailCalls(), 0, 'leaving the section must not fetch');
  starObserver.callback([{ isIntersecting: true }]);
  await nextTurn();
  await nextTurn();
  assert.equal(detailCalls(), 1);
  assert.equal(starObserver.disconnected, 1, 'the observer stops after the first entry');
  assert.equal(data.state.starDetailStatus, 'ready');
  assert.match(toasts.at(-1), /已加载 3 个 star 仓库明细/);
  assert.equal(view.element('starExport').disabled, false);
  assert.equal(view.chartCalls.filter(call => call.name === 'starWall').at(-1).model.total, 3);
  starObserver.callback([{ isIntersecting: true }]);
  await nextTurn();
  assert.equal(detailCalls(), 1, 'a second entry does not refetch');

  const change = (id, value, event = 'change') => view.element(id).events[event]({ target: { value } });
  assert.equal(view.element('starTableCount').textContent, '3 / 3 REPOSITORIES');
  assert.equal(view.element('starPagination').hidden, true);
  assert.equal(view.element('starNext').disabled, true);
  change('starSearch', 'fresh', 'input');
  assert.equal(view.element('starTableCount').textContent, '1 / 3 REPOSITORIES');
  change('starStatusFilter', 'archived');
  assert.equal(view.element('starTableCount').textContent, '0 / 3 REPOSITORIES');
  assert.match(view.element('starRows').innerHTML, /当前筛选没有匹配的仓库/);
  assert.equal(view.element('starFilterReset').disabled, false);

  const cell = index => ({ target: { closest: selector =>
    selector === '[data-i]' ? { dataset: { i: String(index) } } : null } });
  view.element('starWall').events.mouseover(cell(2));
  assert.equal(view.element('starWallReadout').textContent, '=danger · ★5 · Python · 主题：llm');
  view.element('starWall').events.mouseover(cell(99));
  assert.match(view.element('starWallReadout').textContent, /^悬停任意格子查看/);

  view.element('starFilterReset').events.click();
  assert.deepEqual({
    cluster: data.state.starCluster, language: data.state.starLanguage, topic: data.state.starTopic,
    status: data.state.starStatus, sort: data.state.starSort, search: data.state.starSearch,
    page: data.state.starPage
  }, { cluster: 'all', language: 'all', topic: 'all', status: 'all', sort: 'stars', search: '', page: 1 });
  assert.equal(view.element('starTableCount').textContent, '3 / 3 REPOSITORIES');

  const chip = value => ({ target: { closest: selector =>
    selector === '[data-cluster]' ? { dataset: { cluster: value } } : null } });
  view.element('starWall').events.click(cell(1));
  assert.equal(data.state.starCluster, 'lang:Rust');
  assert.equal(view.element('starTableCount').textContent, '1 / 3 REPOSITORIES');
  assert.equal(view.chartCalls.filter(call => call.name === 'starWall').at(-1).opts.activeCluster, 'lang:Rust');
  view.element('starWallLegend').events.click(chip('lang:Rust'));
  assert.equal(data.state.starCluster, 'all', 'clicking the active cluster again clears the filter');
  view.element('starGraph').events.click(chip('topic:llm'));
  assert.equal(data.state.starCluster, 'topic:llm');
  view.element('starRows').events.click(chip('lang:Python'));
  assert.equal(data.state.starCluster, 'lang:Python', 'a table chip selects that cluster');
  view.element('starRows').events.click({ target: { closest: selector =>
    selector === '[data-cluster]' ? null : { dataset: { starTopic: 'llm' } } } });
  assert.equal(data.state.starTopic, 'llm', 'a topic chip filters the list');
  view.element('starFilterReset').events.click();

  await view.element('starRefresh').events.click();
  assert.equal(snapshotCalls, 1);
  assert.equal(detailCalls(), 1, 'reading the snapshot must not pull the detail file');
  assert.equal(view.element('starRefresh').disabled, false);
  assert.equal(view.element('starRefresh').getAttribute('aria-busy'), 'false');
  assert.equal(view.element('starRefresh').textContent, '刷新已发布快照');
  assert.match(toasts.at(-1), /已读取 star 快照.*不会触发后台采集/);
  snapshotFailure = new Error('HTTP 503');
  await view.element('starRefresh').events.click();
  assert.match(toasts.at(-1), /star 快照读取失败：HTTP 503。保留上次数据/);
  assert.equal(view.element('starRefresh').disabled, false);
  snapshotFailure = null;

  await view.element('starDetailLoad').events.click();
  await nextTurn();
  await nextTurn();
  assert.equal(detailCalls(), 2, 'the manual button always forces a fresh read');
  assert.match(toasts.at(-1), /已加载 3 个 star 仓库明细/);
  assert.equal(view.element('starDetailLoad').textContent, '重新加载 star 明细');

  const parseCsv = text => text.replace(/^﻿/, '').split('\r\n').map(row =>
    Array.from(row.matchAll(/"((?:[^"]|"")*)"/g), match => match[1].replace(/""/g, '"')));
  view.element('starExport').onclick();
  assert.equal(view.blobs.at(-1).type, 'text/csv;charset=utf-8');
  const [header, ...csvRows] = parseCsv(await view.blobs.at(-1).text());
  assert.deepEqual(header, ['repository', 'owner', 'repo', 'url', 'stars', 'language', 'topics', 'description',
    'pushed_at', 'is_fork', 'is_archived', 'owner_is_organization', 'cluster_id', 'cluster_type',
    'cluster_label', 'snapshot_captured_at', 'detail_captured_at']);
  assert.equal(csvRows.length, 3, 'CSV exports every filter match, not only the visible page');
  assert.deepEqual(csvRows[0], ['a/fresh', 'a', 'fresh', 'https://github.com/a/fresh', '500', 'Python', 'llm',
    'desc', '2026-10-01', 'false', 'false', 'false', 'lang:Python', 'language', 'Python',
    '2026-10-31T02:23:00Z', '2026-10-31T02:23:00Z']);
  assert.equal(csvRows[1][11], 'true', 'organization ownership survives the export');
  assert.deepEqual(plain(csvRows[2].slice(12, 15)), ['topic:llm', 'topic', 'llm']);
  assert.equal(csvRows[2][0], "'=danger", 'formula-leading repository names are neutralised');
  assert.equal(csvRows[2][7], "'=cmd", 'formula-leading descriptions are neutralised');

  change('starCluster', 'lang:Rust');
  view.element('starExport').onclick();
  const filtered = parseCsv(await view.blobs.at(-1).text()).slice(1);
  assert.deepEqual(filtered.map(row => row[0]), ['b/old'], 'the export follows the active filter');
});

// --- Entity registry board ---------------------------------------------------

test('the registry index is first-paint data and a missing file degrades that board alone', async () => {
  const payloads = publishedPayloads();
  const requested = [];
  const data = loadData(publishedFetch(payloads, requested));
  await data.loadAll();
  assert.equal(requested.filter(url => url === './data/entities.json').length, 1,
    'the reverse lookup needs the whole index, so the board cannot wait for a scroll event');
  assert.equal(data.state.entities.status, 'ok');
  assert.equal(data.state.entityRefreshError, null);
  assert.match(data.state.entitySnapshotCheckedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.deepEqual(plain(data.entityEntries().map(row => row.slug)), ['youtu-ft-v1']);
  assert.equal(data.entityStats().resolved, 1);

  const missing = publishedPayloads();
  delete missing['./data/entities.json'];
  const other = loadData(publishedFetch(missing));
  await other.loadAll();
  assert.equal(other.state.entities.status, 'unavailable');
  assert.equal(other.state.entities.source.id, 'registry');
  assert.deepEqual(plain(other.entityEntries()), []);
  assert.match(other.state.entities.error, /HTTP 404/);
  assert.equal(other.entityStats().available, false);
  assert.equal(other.state.status, 'ready', 'a missing registry must not sink the page');
  assert.equal(other.state.conferences.status, 'ok');

  const foreign = publishedPayloads();
  foreign['./data/entities.json'] = entityPayload([entityEntry('one')], { source: { id: 'gitlab' } });
  const third = loadData(publishedFetch(foreign));
  await third.loadEntities();
  assert.equal(third.state.entities.status, 'unavailable');
  assert.match(third.state.entities.error, /格式或数据来源不兼容/);

  const keep = publishedPayloads();
  const fourth = loadData(publishedFetch(keep));
  await fourth.loadEntities();
  const snapshot = fourth.state.entities, checkedAt = fourth.state.entitySnapshotCheckedAt;
  keep['./data/entities.json'] = entityPayload([], { schema_version: 0 });
  await assert.rejects(fourth.refreshEntitySnapshot(), /格式或数据来源不兼容/);
  assert.equal(fourth.state.entities, snapshot, 'a rejected refresh keeps the last good index');
  assert.equal(fourth.state.entitySnapshotCheckedAt, checkedAt, 'a failed read is not logged as a successful one');
  assert.match(fourth.state.entityRefreshError, /格式或数据来源不兼容/);
  fourth.state.entityKind = 'project';
  const refreshed = entityPayload([entityEntry('other')]);
  keep['./data/entities.json'] = refreshed;
  assert.equal(await fourth.refreshEntitySnapshot(), refreshed);
  assert.equal(fourth.state.entities, refreshed);
  assert.equal(fourth.state.entityRefreshError, null, 'a successful read clears the previous read failure');
});

test('registry rows only trust the link states and urls the collector published', () => {
  const data = loadData();
  seedEntities(data, [entityEntry('odd', {
    title: '',
    bytes: '200', lines: null, sha256: 42, truncated: 'yes', url: 'ftp://example.invalid/odd.md',
    tags: ['demo', 7],
    links: [
      entityLink('hf_model', 'gatilin/odd', { state: 'maybe' }),
      { domain: 'gh_repo', id: 'isLinXu/odd', state: 'resolved', url: 'javascript:alert(1)' },
      { domain: 'scholar', id: 'me', state: 'unchecked' },
      { id: 'no-domain' }
    ]
  })]);
  const [row] = data.entityEntries();
  assert.equal(row.title, 'odd', 'an entry with no published title falls back to its slug');
  assert.equal(row.url, null, 'a non-http source url never becomes a link');
  assert.deepEqual(plain(row.tags), ['demo'], 'only text tags survive');
  assert.equal(row.bytes, null, 'a counter the collector wrote as text is not a number');
  assert.equal(row.lines, null);
  assert.equal(row.sha, '', 'the digest is only published as text');
  assert.equal(row.truncated, false);
  assert.deepEqual(plain(row.links.map(link => [link.domain, link.state, link.url])), [
    ['hf_model', 'unchecked', 'https://example.invalid/hf_model/gatilin/odd'],
    ['gh_repo', 'resolved', null],
    ['scholar', 'unchecked', null]
  ], 'an unknown state reads as 未核对, never as 已核对');
  assert.equal(data.entityProblems().length, 2, 'a link with no url is a gap, not a dead end');
  assert.equal(data.entityStats().errors, 0);
});

test('registry filters combine kind, stage, tag, link state, search and the reverse object', () => {
  const data = loadData();
  seedEntities(data, [
    entityEntry('alpha', { kind: 'project', stage: 'training', tags: ['ft', 'vision'], updated: '2026-10-30',
      links: [entityLink('hf_model', 'gatilin/shared'), entityLink('gh_repo', 'isLinXu/alpha', { state: 'unresolved' })] }),
    entityEntry('beta', { kind: 'model', stage: 'shipped', tags: ['ft'], updated: '2026-10-29',
      links: [entityLink('hf_model', 'gatilin/shared', { state: 'unchecked' })] }),
    entityEntry('gamma', { kind: null, stage: null, tags: [], updated: '2026-10-28', links: [],
      body: '只有正文里出现的一句话' }),
    entityEntry('delta', { kind: 'dataset', stage: 'proposal', tags: ['data'], updated: '2026-11-01',
      links: [entityLink('template', 'tmpls/a', { state: 'out_of_scope' })] })
  ]);
  const slugs = () => plain(data.entityFiltered().map(row => row.slug));
  assert.deepEqual(slugs(), ['delta', 'alpha', 'beta', 'gamma'], 'newest update first, then slug');

  data.state.entityKind = 'model';
  assert.deepEqual(slugs(), ['beta']);
  data.state.entityKind = 'none';
  assert.deepEqual(slugs(), ['gamma'], 'an unlabeled entry is filterable as 未标注');
  data.state.entityKind = 'all';
  data.state.entityStage = 'shipped';
  assert.deepEqual(slugs(), ['beta']);
  data.state.entityStage = 'all';
  data.state.entityTag = 'ft';
  assert.deepEqual(slugs(), ['alpha', 'beta']);
  data.state.entityTag = 'all';
  data.state.entityLink = 'problem';
  assert.deepEqual(slugs(), ['delta', 'alpha', 'beta'], 'a resolved-only entry stays out of the audit');
  data.state.entityLink = 'unchecked';
  assert.deepEqual(slugs(), ['beta'], 'one state at a time is still selectable');
  data.state.entityLink = 'resolved';
  assert.deepEqual(slugs(), ['alpha'], 'only an entry that claims a checked object matches');
  data.state.entityLink = 'all';
  data.state.entitySearch = ' vision ';
  assert.deepEqual(slugs(), ['alpha'], 'search trims and matches tags');
  data.state.entitySearch = '一句话';
  assert.deepEqual(slugs(), ['gamma'], 'the published body is searchable');
  data.state.entitySearch = 'template';
  assert.deepEqual(slugs(), ['delta'], 'link domains are searchable too');
  data.state.entitySearch = 'gatilin/shared';
  assert.deepEqual(slugs(), ['alpha', 'beta']);
  data.state.entitySearch = 'nothing matches this';
  assert.deepEqual(slugs(), []);
  data.state.entitySearch = '';
  data.state.entityObject = 'hf_model:gatilin/shared';
  assert.deepEqual(slugs(), ['alpha', 'beta'], 'the reverse lookup is a filter, not a separate page');
  data.state.entitySort = 'links';
  assert.deepEqual(slugs(), ['alpha', 'beta'], 'most links first, then slug');
  data.state.entitySort = 'name';
  assert.deepEqual(plain(data.entityFiltered().map(row => row.title)), ['alpha', 'beta']);

  const facets = data.entityFacets();
  assert.deepEqual(plain(facets.kinds), [
    { value: 'project', count: 1 }, { value: 'model', count: 1 }, { value: 'none', count: 1 }, { value: 'dataset', count: 1 }
  ]);
  assert.deepEqual(plain(facets.stages.map(item => item.value)), ['training', 'shipped', 'none', 'proposal']);
  assert.deepEqual(plain(facets.tags), [{ value: 'ft', count: 2 }, { value: 'data', count: 1 }, { value: 'vision', count: 1 }]);
});

test('registry paging shows eight entries and clamps to what the filter leaves', () => {
  const data = loadData();
  seedEntities(data, Array.from({ length: 20 }, (_, index) => entityEntry(`entry-${index}`, {
    updated: `2026-11-${String(index + 1).padStart(2, '0')}`,
    links: index % 3 === 0 ? [] : [entityLink('hf_model', `gatilin/model-${index}`)]
  })));
  assert.equal(data.entityPageSize(), 8);
  assert.equal(data.entityPageCount(), 3);
  assert.deepEqual(plain(data.entityPage().map(row => row.slug)),
    ['entry-19', 'entry-18', 'entry-17', 'entry-16', 'entry-15', 'entry-14', 'entry-13', 'entry-12']);
  data.state.entityPage = 3;
  assert.deepEqual(plain(data.entityPage().map(row => row.slug)), ['entry-3', 'entry-2', 'entry-1', 'entry-0']);
  data.state.entityPage = 9;
  assert.equal(data.entityPage()[0].slug, 'entry-3', 'a stale page number clamps to the last page');
  data.state.entityPage = 0;
  assert.equal(data.entityPage()[0].slug, 'entry-19', 'and never below the first');

  data.state.entityPage = 1;
  data.state.entitySort = 'links';
  assert.deepEqual(plain(data.entityFiltered().slice(13).map(row => row.slug)),
    ['entry-0', 'entry-12', 'entry-15', 'entry-18', 'entry-3', 'entry-6', 'entry-9'],
    'linkless entries sort last instead of disappearing');
  data.state.entitySort = 'updated';
  data.state.entityObject = 'hf_model:gatilin/model-19';
  assert.equal(data.entityPageCount(), 1);
  assert.deepEqual(plain(data.entityFiltered().map(row => row.slug)), ['entry-19']);
});

test('the reverse index groups references per object and the audit ranks dead links first', () => {
  const data = loadData();
  seedEntities(data, [
    entityEntry('alpha', { links: [entityLink('hf_model', 'gatilin/shared'),
      entityLink('gh_repo', 'isLinXu/ghost', { state: 'unresolved', url: null })] }),
    entityEntry('beta', { links: [entityLink('hf_model', 'gatilin/shared', { state: 'unresolved', url: null })] }),
    entityEntry('gamma', { links: [entityLink('template', 'tmpls/a', { state: 'out_of_scope' }),
      entityLink('scholar', 'me', { state: 'unchecked' })] })
  ]);
  assert.deepEqual(plain(data.entityObjects().map(item => [item.key, item.entries.length])), [
    ['hf_model:gatilin/shared', 2], ['gh_repo:isLinXu/ghost', 1], ['scholar:me', 1], ['template:tmpls/a', 1]
  ], 'busiest objects first, then key');
  assert.deepEqual(plain(data.entityReferences('hf_model:gatilin/shared').map(item => item.slug)), ['alpha', 'beta']);
  assert.deepEqual(plain(data.entityReferences('nothing:here')), [], 'an unlisted object has no references');
  const shared = data.entityObjects().find(item => item.key === 'hf_model:gatilin/shared');
  assert.equal(shared.state, 'resolved', 'the object keeps the state the collector published, not the worst claim');
  assert.equal(shared.entries[1].title, 'beta');

  assert.deepEqual(plain(data.entityProblems().map(item => [item.state, item.slug, item.key])), [
    ['unresolved', 'alpha', 'gh_repo:isLinXu/ghost'],
    ['unresolved', 'beta', 'hf_model:gatilin/shared'],
    ['unchecked', 'gamma', 'scholar:me'],
    ['out_of_scope', 'gamma', 'template:tmpls/a']
  ], 'a dead id is listed before an unverified one, which is before an out-of-scope one');
  const stats = data.entityStats();
  assert.equal(stats.resolved, 1);
  assert.equal(stats.unresolved, 2);
  assert.equal(stats.problems, 3);
  assert.equal(stats.objects, 4);
});

test('registry headline numbers come from the collector and skip sources with no snapshot', () => {
  const data = loadData();
  seedEntities(data, [entityEntry('alpha', { stage: 'evaluating' }), entityEntry('beta', { stage: 'archived' })], {
    coverage: {
      hf_model: { available: true, total: 155, registered: 6, unregistered: ['gatilin/x'], unregistered_count: 149, truncated: true },
      hf_space: { available: false, total: 0, registered: 0, unregistered: [], unregistered_count: 0, truncated: false },
      ms_model: { available: true, total: 314, registered: 0, unregistered: [], unregistered_count: 314, truncated: true }
    },
    sources: {
      hf_model: { available: true, captured_at: '2026-11-02T03:18:55Z', reason: null },
      hf_space: { available: false, captured_at: null, reason: '本站还没有 Space 来源，无法核对' },
      ms_model: { available: true, captured_at: '2026-11-02T03:19:15Z', reason: null }
    },
    warnings: ['one odd field'], structural_errors: ['alpha has no kind']
  });
  const stats = data.entityStats();
  assert.equal(stats.total, 2);
  assert.equal(stats.links, 2);
  assert.equal(stats.active, 1, 'shipped and archived entries are finished work');
  assert.deepEqual(plain(stats.coverage), { registered: 6, total: 469, sources: 2 });
  assert.deepEqual(plain(stats.gaps), ['ms_model'], 'a source we register nothing for is a gap to fill');
  assert.equal(stats.errors, 1);
  assert.equal(stats.warnings, 1);
  assert.deepEqual(plain(data.entityCoverage().map(row => row.domain)), ['ms_model', 'hf_model', 'hf_space'],
    'the largest denominators lead');
  const space = data.entityCoverage().find(row => row.domain === 'hf_space');
  assert.equal(space.available, false);
  assert.equal(space.reason, '本站还没有 Space 来源，无法核对', 'the reason lives in the sources block');

  // A board reading a failed index must not restate any count itself.
  const empty = loadData();
  empty.state.entities = { status: 'unavailable', source: { id: 'registry' }, entries: [], error: 'HTTP 503' };
  assert.deepEqual(plain(empty.entityStats()), {
    available: false, total: 0, links: 0, resolved: 0, unresolved: 0, unchecked: 0, out_of_scope: 0,
    problems: 0, objects: 0, active: 0, coverage: { registered: 0, total: 0, sources: 0 },
    gaps: [], warnings: 0, errors: 0
  });
});

test('the entity board escapes registry text and keeps every link state on screen', () => {
  const longId = 'isLinXu/long-repository-name-that-will-not-fit-the-column-either';
  const data = loadData();
  seedEntities(data, [
    entityEntry('danger', { title: '<b>危险</b>', tags: ['<i>tag</i>'],
      links: [entityLink('hf_model', '<gatilin/x>', { state: 'unresolved', url: null })] }),
    entityEntry('wide', { truncated: true, bytes: 900, lines: 40, body: '# 标题\n\n<i>原样展示</i>', links: [
      entityLink('template', 'tmpls/a', { state: 'out_of_scope' }),
      entityLink('scholar', 'me', { state: 'unchecked' }),
      entityLink('gh_repo', longId),
      entityLink('conf', 'ccf-ai/aaai27:paper:1'),
      entityLink('hf_dataset', 'gatilin/ds')
    ] })
  ], {
    coverage: {
      hf_space: { available: false, total: 0, registered: 0, unregistered: [], unregistered_count: 0, truncated: false },
      hf_model: { available: true, total: 155, registered: 6,
        unregistered: Array.from({ length: 8 }, (_, index) => `gatilin/missing-${index}`), unregistered_count: 149, truncated: true }
    },
    sources: {
      hf_space: { available: false, captured_at: null, reason: '<none>' },
      scholar: { available: false, captured_at: null, reason: '学术档案快照不可用' },
      hf_model: { available: true, captured_at: '2026-11-02T03:18:55Z', reason: null }
    },
    structural_errors: ['wide has no stage'], warnings: ['one odd field']
  });
  const view = loadModelView(data);
  view.render.renderEntities();

  const rows = view.element('entityRows').innerHTML;
  assert.doesNotMatch(rows, /<b>危险<\/b>|<i>tag<\/i>|<i>原样展示<\/i>|<gatilin|x>/);
  assert.match(rows, /&lt;b&gt;危险&lt;\/b&gt;/);
  assert.doesNotMatch(rows, /href="javascript:/, 'only http(s) urls reach the page');
  assert.doesNotMatch(rows, /原样展示|class="entity-body"/, 'the prose only ships in the expanded row');
  for (const [state, label] of [['unresolved', '断链'], ['unchecked', '未核对'],
                                ['out_of_scope', '范围外'], ['resolved', '已核对']]) {
    assert.match(rows, new RegExp(`entity-${state}"[^>]*>${label} \\d<`), `${label} stays visible`);
  }
  assert.ok(rows.includes(`${longId.slice(0, 44)}…`), 'a long id is clamped, not wrapped away');
  assert.match(rows, /entity-more">\+2</, 'the fourth and fifth objects are counted, not hidden');

  data.state.entityOpen = 'wide';
  view.render.renderEntityTable();
  const detail = view.element('entityRows').innerHTML;
  assert.match(detail, /class="entity-body"/);
  assert.match(detail, /&lt;i&gt;原样展示&lt;\/i&gt;/, 'the prose is placed in the page as text, never as HTML');
  assert.match(detail, /正文在采集中被截断：源文件共 900 字节 \/ 40 行/);
  assert.doesNotMatch(detail, /正文摘要 sha256/, 'a truncated body never claims a whole-file digest');
  assert.match(detail, /在 GitHub 编辑源文件 ↗/);
  assert.match(detail, /data-entity-edit="wide"/, 'the expanded row offers in-page write-back');
  assert.doesNotMatch(detail, /本页只读/, 'the board no longer claims to be read-only');
  assert.match(detail, /反向链接：1 个实体引用该对象/);
  assert.match(detail, /学术档案快照不可用/, 'an unchecked link explains which source was missing');

  data.state.entityOpen = 'danger';
  view.render.renderEntityTable();
  assert.match(view.element('entityRows').innerHTML,
    /源文件 200 字节 \/ 6 行 · 正文摘要 sha256 abc123def456/, 'an intact body shows its size and digest');

  const problems = view.element('entityProblems').innerHTML;
  assert.match(problems, /entity-problem unresolved/, 'the dead link leads the list');
  assert.match(problems, /data-entity-open="(danger|wide)"/);
  assert.match(problems, /data-entity-edit="(danger|wide)"/, 'a dead link offers the edit that fixes it');
  assert.equal(data.entityProblems().length, 3);

  const coverage = view.element('entityCoverageList').innerHTML;
  assert.match(coverage, /本来源无可用快照：&lt;none&gt;/);
  assert.match(coverage, /另有 141 项未列出/, 'the hidden tail of the gap list is counted');
  assert.equal((coverage.match(/gatilin\/missing-/g) || []).length, 6, 'only six missing ids are printed');
  assert.match(view.element('entityCoverageNote').textContent,
    /1 \/ 2 个来源当日可用 · 分母是本站自有对象 · 未登记对象合计 149 个/);

  assert.match(view.element('entityStatus').textContent, /1 条结构错误按未标注处理/);
  assert.match(view.element('entityStatus').textContent, /1 条字段告警/);
  assert.match(view.element('entityStatus').textContent, /采集于 2026-10-31 02:23/);
  assert.equal(view.element('entityExport').disabled, false);
  assert.equal(view.element('entityFilterReset').disabled, true);
  assert.match(view.element('statEntityLinksSub').textContent, /已核对 3 · 断链 1 · 未核对 1 · 范围外 1/);
  assert.match(view.element('statEntityCoverageSub').textContent, /1 个来源当日可用 · 每个来源都有条目/);

  // A refreshed index can drop the object the reader was tracing.
  data.state.entityObject = 'hf_model:gatilin/gone';
  data.state.entityKind = 'dataset';
  view.render.renderEntities();
  assert.equal(data.state.entityObject, 'all', 'a reverse target that left the index is released');
  assert.equal(data.state.entityKind, 'all', 'a facet no entry still offers is released too');

  const broken = loadData();
  broken.state.entities = { status: 'unavailable', source: { id: 'registry' }, entries: [], error: 'HTTP 503' };
  const brokenView = loadModelView(broken);
  brokenView.render.renderEntities();
  assert.equal(brokenView.element('entityExport').disabled, true, 'nothing to export from an unavailable index');
  assert.match(brokenView.element('entityStatus').textContent, /暂不可用/);
  assert.match(brokenView.element('entityRows').innerHTML, /注册表还没有条目，或快照读取失败/);
  assert.match(brokenView.element('entityCoverageList').innerHTML, /等待注册表数据/);
  assert.match(brokenView.element('entityProblems').innerHTML, /没有断链/);
});

test('entity filters, the reverse lookup, the audit jump and CSV export stay on the published snapshot', async () => {
  const payloads = publishedPayloads();
  payloads['./data/entities.json'] = entityPayload([
    ...Array.from({ length: 12 }, (_, index) => entityEntry(`entry-${String(index + 1).padStart(2, '0')}`)),
    entityEntry('ghost', { links: [entityLink('hf_model', 'gatilin/ghost', { state: 'unresolved', url: null })] }),
    entityEntry('=drop', { title: '+sheet', tags: ['-tag'], links: [entityLink('hf_model', '@evil/id')] }),
    entityEntry('shared', { tags: ['demo', 'ft'], links: [entityLink('hf_model', 'gatilin/entry-01')] })
  ]);
  const requested = [];
  const data = loadData(publishedFetch(payloads, requested));
  await data.loadAll();

  const view = loadModelView({ ...data, loadAll: async () => {} });
  const toasts = [];
  view.context.MO.theme = { init() {} };
  const booted = deferred();
  view.context.MO.templates = { init: async () => { booted.resolve(); } };
  view.context.MO.render = Object.fromEntries(Object.entries(view.render).map(([name, render]) =>
    [name, /^renderEntit/.test(name) ? render
      : name === 'showToast' ? message => toasts.push(message) : () => {}]));
  view.run('app.js');
  await booted.promise;
  view.render.renderEntities();

  const entityCalls = () => requested.filter(url => url === './data/entities.json').length;
  assert.equal(entityCalls(), 1, 'the index arrives with the first paint');
  assert.equal(view.element('entityTableCount').textContent, '15 / 15 ENTRIES');
  assert.equal((view.element('entityRows').innerHTML.match(/class="entity-row/g) || []).length, 8,
    'one page shows eight entries');
  assert.equal(view.element('entityPagination').hidden, false);
  assert.equal(view.element('entityPageInfo').textContent, '1 / 2');
  assert.equal(view.element('entityPrev').disabled, true);

  view.element('entityNext').events.click();
  assert.equal(view.element('entityPageInfo').textContent, '2 / 2');
  assert.match(view.element('entityRows').innerHTML, /data-entity-open="ghost"/);

  const change = (id, value, event = 'change') => view.element(id).events[event]({ target: { value } });
  change('entitySearch', 'entry-11', 'input');
  assert.equal(view.element('entityTableCount').textContent, '1 / 15 ENTRIES');
  assert.equal(view.element('entityPageInfo').textContent, '1 / 1', 'a narrowing filter returns to page one');
  assert.equal(view.element('entityFilterReset').disabled, false);

  view.element('entityProblems').events.click({ target: {
    closest: selector => selector === '[data-entity-open]' ? { dataset: { entityOpen: 'ghost' } } : null } });
  assert.equal(data.state.entitySearch, '', 'the audit jump gives way rather than showing nothing');
  assert.equal(data.state.entityOpen, 'ghost');
  assert.equal(data.state.entityPage, 2, 'the row the reader asked for is on screen, not paginated away');
  assert.match(view.element('entityRows').innerHTML, /正文（按源文件原文展示）/);
  view.element('entityProblems').events.click({ target: {
    closest: selector => selector === '[data-entity-open]' ? { dataset: { entityOpen: 'ghost' } } : null } });
  assert.equal(data.state.entityOpen, null);
  assert.equal(data.state.entityPage, 1);

  const chip = key => ({ target: { closest: selector =>
    selector === '[data-entity-open]' ? null : selector === '[data-entity-object]' ? { dataset: { entityObject: key } } : null } });
  view.element('entityRows').events.click(chip('hf_model:gatilin/entry-01'));
  assert.equal(data.state.entityObject, 'hf_model:gatilin/entry-01');
  assert.equal(view.element('entityTableCount').textContent, '2 / 15 ENTRIES · 反查中');
  assert.match(view.element('entityReverseNote').textContent, /引用该对象的实体 2 个：entry 01、shared/);
  view.element('entityRows').events.click(chip('hf_model:gatilin/entry-01'));
  assert.equal(data.state.entityObject, 'all', 'the same chip clears the reverse lookup');
  change('entityObject', 'hf_model:gatilin/ghost');
  assert.equal(view.element('entityTableCount').textContent, '1 / 15 ENTRIES · 反查中');

  const tag = name => ({ target: { closest: selector =>
    selector === '[data-entity-tag]' ? { dataset: { entityTag: name } } : null } });
  view.element('entityFilterReset').events.click();
  view.element('entityRows').events.click(tag('demo'));
  assert.equal(data.state.entityTag, 'demo');
  assert.equal(view.element('entityTableCount').textContent, '14 / 15 ENTRIES');
  view.element('entityRows').events.click(tag('demo'));
  assert.equal(data.state.entityTag, 'all');

  let draftRenders = 0;
  view.context.MO.registry.renderDrafts = () => { draftRenders += 1; };
  await view.element('entityRefresh').events.click();
  assert.equal(entityCalls(), 2, 'refresh re-reads the index only');
  assert.equal(draftRenders, 1, 'the local draft list follows the refreshed index');
  assert.equal(requested.filter(url => url === './data/stars.json').length, 1, 'no other board is refetched');
  assert.equal(view.element('entityRefresh').textContent, '刷新已发布快照');
  assert.equal(view.element('entityRefresh').disabled, false);
  assert.equal(view.element('entityRefresh').getAttribute('aria-busy'), null);
  assert.match(toasts.at(-1), /刷新只读取已发布文件，不会触发后台采集，也不会修改任何条目/);
  assert.match(view.element('entityFreshness').textContent, /最近读取 .*UTC（读取不触发采集）/);

  // The row's edit button is the one write path on this board: it hands the slug
  // to the panel and does not toggle the row closed underneath it.
  const edits = [];
  view.context.MO.registry.open = async slug => { edits.push(slug); return slug; };
  view.element('entityRows').events.click({ target: {
    closest: selector => (selector === '[data-entity-edit]' ? { dataset: { entityEdit: 'ghost' } } : null)
  } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(edits, ['ghost']);
  assert.equal(data.state.entityOpen, 'ghost', 'the row opens so the link states stay visible');
  assert.match(toasts.at(-1), /entities\/ghost\.md 的远端原文/);

  // Without a token the panel refuses and says why; the board itself is untouched.
  view.context.MO.registry.open = async () => {
    view.context.MO.registry.state.sync = { message: '请先填写 GitHub Token（仅需 Contents 读写权限）' };
    return null;
  };
  view.element('entityRows').events.click({ target: {
    closest: selector => (selector === '[data-entity-edit]' ? { dataset: { entityEdit: 'shared' } } : null)
  } });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(toasts.at(-1), /回写暂不可用：请先填写 GitHub Token/);
  assert.equal(data.state.entityOpen, 'shared', 'the entry still opens for reading');

  const snapshot = data.state.entities, checkedAt = data.state.entitySnapshotCheckedAt;
  payloads['./data/entities.json'] = entityPayload([], { source: { id: 'notion' } });
  await view.element('entityRefresh').events.click();
  assert.equal(data.state.entities, snapshot, 'a rejected refresh keeps the index already on screen');
  assert.equal(data.state.entitySnapshotCheckedAt, checkedAt);
  assert.match(toasts.at(-1), /注册表快照读取失败：.*保留上次数据/);
  assert.match(view.element('entityStatus').textContent, /快照读取失败，保留上次数据/);

  const parseCsv = text => text.replace(/^﻿/, '').split('\r\n').map(row =>
    Array.from(row.matchAll(/"((?:[^"]|"")*)"/g), match => match[1].replace(/""/g, '"')));
  view.element('entityFilterReset').events.click();
  view.element('entityExport').onclick();
  assert.equal(view.blobs.at(-1).type, 'text/csv;charset=utf-8');
  const [header, ...csvRows] = parseCsv(await view.blobs.at(-1).text());
  assert.deepEqual(header, ['slug', 'title', 'kind', 'stage', 'tags', 'updated', 'link_count', 'link_domains',
    'link_ids', 'link_states', 'link_urls', 'source_url', 'body_bytes', 'body_lines', 'body_sha256',
    'body_truncated', 'snapshot_captured_at']);
  assert.equal(csvRows.length, 15, 'CSV exports every filter match, not only the visible page');
  assert.equal(csvRows[0][0], "'=drop", 'a formula-leading slug is neutralised');
  assert.equal(csvRows[0][1], "'+sheet", 'a formula-leading title is neutralised');
  assert.equal(csvRows[0][4], "'-tag", 'a formula-leading tag is neutralised');
  assert.equal(csvRows[0][8], "'@evil/id", 'a formula-leading object id is neutralised');
  assert.equal(csvRows[0][9], 'resolved');
  assert.ok(!csvRows.some(row => row.some(cell => cell.includes('正文说明'))),
    'the prose stays in git, where Markdown keeps its formatting');
  change('entitySearch', 'entry-0', 'input');
  view.element('entityExport').onclick();
  const scoped = parseCsv(await view.blobs.at(-1).text()).slice(1);
  assert.deepEqual(scoped.map(row => row[0]),
    ['entry-01', 'entry-02', 'entry-03', 'entry-04', 'entry-05', 'entry-06', 'entry-07', 'entry-08', 'entry-09',
      'shared'],
    'the export follows the active filter, not the visible page');
  assert.ok(scoped.at(-1)[8].includes('entry-01'), 'shared matches through the object it references');
});

// --- Write-back: MO.repo and the registry editor ----------------------------

const SOURCE_TEXT = ['---', 'title: Youtu-FT-V1', 'kind: project', 'stage: training',
  'tags: [ft, vlm]', 'updated: 2026-11-02', 'links:', '  - hf_model:gatilin/Youtu-FT-V1', '---',
  '# Youtu-FT-V1', '', '训练中的合并分支，中文说明留在源文件里。', ''].join('\n');

const b64 = text => Buffer.from(text, 'utf8').toString('base64');
const unb64 = value => Buffer.from(value, 'base64').toString('utf8');
const contentsRoute = (slug, method = 'GET') =>
  `${method} /repos/isLinXu/model-observatory/contents/entities/${slug}.md`;
// The Contents API answer this site cares about: the blob SHA and the file body.
const fileReply = (sha, text = SOURCE_TEXT) =>
  jsonResponse({ sha, content: b64(text), last_commit: null });

function fakeStorage(initial = {}) {
  const store = { ...initial };
  return {
    store,
    getItem: key => (key in store ? store[key] : null),
    setItem: (key, value) => { store[key] = String(value); },
    removeItem: key => { delete store[key]; }
  };
}

// repo.js is the only code on this site that sends a credential anywhere, so the
// harness hands it the browser pieces a vm lacks - storage, base64, text codecs
// and fetch - and then reads back exactly what it did with them. Every request
// is recorded, so a test can fail on a URL rather than on a message.
function loadWriteBackView({ payload = null, token = '', session = {}, routes = {} } = {}) {
  const index = payload || entityPayload([entityEntry('one', {
    blob_sha: 'sha-a', body: '快照里的截断正文', truncated: true
  })]);
  const local = fakeStorage();
  const tab = fakeStorage(token ? { 'mo.repo.token': token, ...session } : session);
  const requests = [];
  const fetchImpl = async (target, options = {}) => {
    const url = String(target);
    const method = options.method || 'GET';
    requests.push({ url, method, headers: options.headers || {},
      body: typeof options.body === 'string' ? JSON.parse(options.body) : null });
    if (url.startsWith('https://api.github.com')) {
      const reply = routes[`${method} ${url.slice('https://api.github.com'.length)}`];
      if (!reply) throw new Error(`测试没有准备 ${method} ${url} 的响应`);
      return reply;
    }
    return jsonResponse(index);
  };
  const data = loadData(fetchImpl);
  data.state.entities = index;
  const element = elementFactory(new Map());
  const context = {
    console: { ...console, warn() {} },
    document: { getElementById: element, querySelectorAll: () => [], addEventListener() {},
      createElement: () => ({ click() {}, remove() {} }), body: { append() {} } },
    localStorage: local, sessionStorage: tab, fetch: fetchImpl,
    TextEncoder, TextDecoder,
    btoa: binary => Buffer.from(binary, 'binary').toString('base64'),
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    MO: { data }
  };
  context.window = context;
  vm.createContext(context);
  const run = name => {
    const filename = path.join(__dirname, '..', 'site', name);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  };
  run('format.js');
  run('repo.js');
  run('registry.js');
  return { data, element, requests, routes, local, tab, repo: context.MO.repo,
    registry: context.MO.registry, ready: context.MO.registry.init() };
}

// Typing and clicking, so the bindings are what is under test.
function type(view, text) {
  view.element('entityFormText').events.input({ target: { value: text } });
}

test('the write-back token stays in the tab and only travels toward api.github.com', async () => {
  const view = loadWriteBackView({ token: 'ghp-secret', routes: { [contentsRoute('one')]: fileReply('sha-a') } });
  await view.ready;
  await view.registry.open('one');
  type(view, `${SOURCE_TEXT}改一条关系\n`);
  view.element('entityFormSave').events.click();

  assert.equal(view.tab.store['mo.repo.token'], 'ghp-secret', 'sessionStorage holds it for this tab');
  assert.equal(view.local.store['mo.repo.token'], undefined, 'never mirrored into storage that outlives the tab');
  const drafts = JSON.parse(view.local.store['mo.entities.drafts']);
  assert.deepEqual(Object.keys(drafts.one).sort(), ['baseline', 'savedAt', 'text']);
  assert.ok(!JSON.stringify(drafts).includes('ghp-secret'), 'no draft file ever carries the credential');
  assert.deepEqual(view.requests.map(request => request.url),
    ['https://api.github.com/repos/isLinXu/model-observatory/contents/entities/one.md']);
  assert.equal(view.requests[0].headers.Authorization, 'Bearer ghp-secret');

  // The token field is the only place it is typed, and clearing must take effect
  // at once rather than after the next request.
  view.element('entityToken').events.input({ target: { value: '  typed-token  ' } });
  assert.equal(view.repo.coordinates().token, 'typed-token');
  assert.equal(view.tab.store['mo.repo.token'], 'typed-token', 'trimmed before it is stored');
  view.element('entityTokenClear').events.click();
  assert.equal(view.repo.coordinates().token, '', 'the panel stops being able to write immediately');
  assert.equal(view.tab.store['mo.repo.token'], undefined);
  assert.equal(view.element('entityToken').value, '');
});

test('without a token the editor explains itself and asks the network for nothing', async () => {
  const view = loadWriteBackView();
  await view.ready;
  assert.equal(await view.registry.open('one'), null);
  assert.equal(view.requests.length, 0, 'no request means no credential can leak');
  assert.equal(view.registry.state.slug, null, 'no editor was opened');
  assert.match(view.element('entitySyncMessage').textContent,
    /请先填写 GitHub Token.*条目仍可浏览、搜索与导出/s);
});

test('a token left behind by the library board is moved to the shared store, not copied', async () => {
  const view = loadWriteBackView({ session: { 'mo.templates.token': 'legacy-token' } });
  await view.ready;
  assert.equal(view.repo.coordinates().token, 'legacy-token');
  assert.equal(view.tab.store['mo.repo.token'], 'legacy-token');
  assert.equal(view.tab.store['mo.templates.token'], undefined, 'the old key is emptied');
  assert.equal(view.local.store['mo.templates.token'], undefined);
});

test('the editor holds the remote source file, not the truncated copy the index published', async () => {
  const view = loadWriteBackView({ token: 't', routes: {
    [contentsRoute('one')]: fileReply('sha-a'),
    [contentsRoute('one', 'PUT')]: jsonResponse({ commit: { sha: 'commit-1' } })
  } });
  await view.ready;
  await view.registry.open('one');
  assert.equal(view.element('entityFormText').value, SOURCE_TEXT,
    'the whole file is on screen, so a push cannot lose the tail of a long entry');
  assert.equal(view.registry.state.baseline, 'sha-a', 'and the baseline is the SHA of that file');
  assert.equal(view.element('entityFormPath').textContent, 'entities/one.md');
  assert.equal(view.element('entityFormIssues').textContent, '结构与采集器的 --check 一致。');

  view.element('entityFormPush').events.click();
  await nextTurn();
  const put = view.requests.find(request => request.method === 'PUT');
  assert.equal(unb64(put.body.content), SOURCE_TEXT, 'pushed verbatim, with no edit made');
  assert.equal(put.body.sha, 'sha-a');
  assert.equal(put.body.branch, 'main');
  assert.equal(put.body.message, 'docs(entities): 更新 one 条目');
  assert.match(view.element('entitySyncMessage').textContent, /次日采集会重建索引/);
});

test('a push whose baseline no longer matches the remote is refused until a person overwrites', async () => {
  const view = loadWriteBackView({ token: 't', routes: {
    [contentsRoute('one')]: fileReply('sha-a'),
    [contentsRoute('one', 'PUT')]: jsonResponse({ commit: { sha: 'commit-1' } })
  } });
  await view.ready;
  await view.registry.open('one');
  type(view, `${SOURCE_TEXT}我还没推的改动\n`);
  view.element('entityFormSave').events.click();
  // Somebody else edits the file between the draft and the push.
  view.routes[contentsRoute('one')] = fileReply('sha-b', `${SOURCE_TEXT}别人的改动\n`);

  view.element('entityFormPush').events.click();
  await nextTurn();
  assert.equal(view.requests.some(request => request.method === 'PUT'), false, 'the write never happened');
  assert.equal(view.registry.state.conflict.sha, 'sha-b');
  assert.match(view.element('entityConflictNote').textContent, /远端当前是 sha-b，草稿基线是 sha-a/);
  assert.equal(view.element('entityFormConflict').classes.has('hidden'), false, 'the choice is offered');

  // The ordinary push button refuses again: overwriting has to be asked for.
  view.element('entityFormPush').events.click();
  await nextTurn();
  assert.equal(view.requests.some(request => request.method === 'PUT'), false);

  await view.element('entityConflictForce').events.click();
  const put = view.requests.find(request => request.method === 'PUT');
  assert.equal(put.body.sha, 'sha-b', 'the overwrite is applied to the version actually on the branch');
  assert.equal(unb64(put.body.content), `${SOURCE_TEXT}我还没推的改动\n`,
    'an explicit overwrite sends what the author was shown, not what they typed first');
  assert.equal(view.registry.state.conflict, null);
  assert.equal(view.registry.state.drafts.one, undefined, 'a pushed draft stops being pending');
});

test('the two gentle choices keep the remote version and the un-pushed words apart', async () => {
  const view = loadWriteBackView({ token: 't', routes: {
    [contentsRoute('one')]: fileReply('sha-a'),
    [contentsRoute('one', 'PUT')]: jsonResponse({ commit: { sha: 'commit-1' } })
  } });
  await view.ready;
  await view.registry.open('one');
  type(view, `${SOURCE_TEXT}我还没推的改动\n`);
  view.element('entityFormSave').events.click();
  view.routes[contentsRoute('one')] = fileReply('sha-b', `${SOURCE_TEXT}别人的改动\n`);
  await view.registry.push('one');

  // 重读原文与索引: re-base on the branch, keep the draft that refuses.
  await view.element('entityConflictReload').events.click();
  assert.equal(view.registry.state.baseline, 'sha-b', 'the editor now points at the version on the branch');
  assert.equal(view.element('entityFormText').value, `${SOURCE_TEXT}别人的改动\n`);
  assert.equal(view.registry.state.conflict, null);
  assert.equal(view.registry.state.drafts.one.text, `${SOURCE_TEXT}我还没推的改动\n`,
    'the un-pushed words are kept instead of dropped');
  assert.equal(view.registry.state.drafts.one.baseline, 'sha-a',
    'and that draft still refuses until it is re-based too');

  // 以远端为准: the draft is thrown away on purpose.
  await view.registry.push('one');
  assert.equal(view.registry.state.conflict.sha, 'sha-b');
  await view.element('entityConflictKeepRemote').events.click();
  assert.equal(view.registry.state.drafts.one, undefined);
  assert.equal(JSON.parse(view.local.store['mo.entities.drafts']).one, undefined);
  assert.match(view.element('entitySyncMessage').textContent, /已丢弃本地草稿/);
  assert.equal(view.requests.filter(request => request.method === 'PUT').length, 0,
    'neither choice wrote anything');
});

test('the editor catches the structural mistakes the collector would fail the run on', async () => {
  const view = loadWriteBackView();
  await view.ready;
  const check = text => view.registry.issues(text, 'one');
  assert.equal(check(SOURCE_TEXT).length, 0, 'the seed-shaped file passes');
  assert.ok(check(SOURCE_TEXT.replace('hf_model:', 'hf_modal:'))
    .some(note => note.includes('hf_modal') && note.includes('不是本站核对的域名')),
  'a mistyped prefix is an error here, not a link that quietly stops being checked');
  assert.ok(check(SOURCE_TEXT.replace('kind: project', 'kind: projectx'))
    .some(note => note.includes('projectx')), 'an unknown kind is named');
  assert.ok(check(SOURCE_TEXT.replace('updated: 2026-11-02', 'updated: 2026-11-2'))
    .some(note => note.includes('YYYY-MM-DD')));
  assert.ok(check(SOURCE_TEXT.replace('- hf_model:', '-  hf_model:').replace('links:', 'links2:'))
    .some(note => note.includes('不在 links: 之下')));
  assert.ok(check(SOURCE_TEXT.replace('tags: [ft, vlm]', 'owner: me'))
    .some(note => note.includes('六个字段')));
  assert.ok(check(SOURCE_TEXT.replace('  - hf_model:gatilin/Youtu-FT-V1', '  - hf_model'))
    .some(note => note.includes('domain:id')));
  assert.ok(check(`${SOURCE_TEXT.split('\n').slice(0, -4).join('\n')}\n`)
    .some(note => note.includes('正文为空')));
  assert.ok(check(SOURCE_TEXT.replace(/^---/, '')).some(note => note.includes('front matter')));
  assert.ok(view.registry.issues(SOURCE_TEXT, 'One Two').some(note => note.includes('小写')),
    'the file name is checked too');
  // hf_space is a prefix the collector accepts but cannot yet prove, so the
  // editor must not call it a typo.
  assert.equal(check(SOURCE_TEXT.replace('- hf_model:', '- hf_space:')).length, 0);

  // A snapshot published before the vocabulary existed cannot invent errors.
  const bare = loadWriteBackView({ payload: entityPayload([entityEntry('one')], { source: { id: 'registry' } }) });
  assert.equal(bare.registry.issues(SOURCE_TEXT, 'one').length, 0,
    'no published list, no vocabulary claims');
});

test('repo.js refuses any target that would turn the page into an arbitrary fetch', async () => {
  const view = loadWriteBackView({ token: 't' });
  await view.ready;
  await assert.rejects(() => view.repo.apiGet('https://evil.invalid/leak'), /必须以 \/ 开头/);
  await assert.rejects(() => view.repo.pushFile({ path: '../secrets', content: 'x', message: 'x' }),
    /不能跳出所在目录/);
  assert.equal(view.requests.length, 0, 'refused before any socket was opened');
  assert.equal(view.repo.contentsPath('entities/中文名 带空格.md'),
    '/repos/isLinXu/model-observatory/contents/entities/%E4%B8%AD%E6%96%87%E5%90%8D%20%E5%B8%A6%E7%A9%BA%E6%A0%BC.md',
    'a name cannot escape its folder');
});

test('a rejected push reports GitHub sentence, not the request that carried the token', async () => {
  const view = loadWriteBackView({ token: 't', routes: {
    [contentsRoute('one')]: fileReply('sha-a'),
    'PUT /repos/isLinXu/model-observatory/contents/entities/one.md':
      jsonResponse({ message: 'this branch is not codebase accessible' }, { status: 403 })
  } });
  await view.ready;
  await view.registry.open('one');
  type(view, `${SOURCE_TEXT}改一条关系\n`);
  await view.element('entityFormPush').events.click();
  assert.match(view.element('entitySyncMessage').textContent, /推送失败：this branch is not codebase accessible/);
  assert.ok(!JSON.stringify(view.registry.state).includes('Bearer'), 'no header text is kept on screen');
  assert.equal(view.registry.state.drafts.one.text, `${SOURCE_TEXT}改一条关系\n`,
    'a failed push keeps the draft so nothing typed is lost');
});

test('a brand new entry is created rather than refused for having no baseline', async () => {
  const view = loadWriteBackView({ token: 't', routes: {
    [contentsRoute('brand-new')]: jsonResponse({ message: 'Not Found' }, { status: 404 }),
    [contentsRoute('brand-new', 'PUT')]: jsonResponse({ commit: { sha: 'commit-new' } })
  } });
  await view.ready;
  await view.registry.open('brand-new');
  assert.match(view.element('entitySyncMessage').textContent, /远端还没有 entities\/brand-new\.md/);
  type(view, SOURCE_TEXT);
  await view.element('entityFormPush').events.click();
  const put = view.requests.find(request => request.method === 'PUT');
  assert.equal(put.body.sha, undefined, 'a create carries no sha at all');
  assert.equal(put.body.branch, 'main');
});






// --- Task board: the canvas -----------------------------------------------

// One task is one file, so the fixture speaks the collector's field names. The
// camelCase the page uses is what taskRows() makes of them, never what is on
// disk - a test that wrote `blobSha` here would be testing a file format the
// daily run does not produce.
const TASK_DEADLINE_ID = 'AI/cvpr:cvpr27:paper:1';
// The countdown is measured against the wall clock, so the fixture deadline sits
// thirty days out instead of being a date that would silently rot next month.
const TASK_DEADLINE_UTC = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 19) + 'Z';

function taskFile(slug, extra = {}) {
  return {
    slug, title: `任务 ${slug}`, status: 'doing', parent: null, depends: [], tags: [],
    entity: null, ddl: null, entity_state: null, ddl_state: null, updated: '2026-11-01',
    reason: '', bytes: 180, lines: 8, sha256: `sha-${slug}`, blob_sha: `blob-${slug}`,
    truncated: false,
    url: `https://github.com/isLinXu/model-observatory/blob/main/tasks/${slug}.md`,
    body: `# 任务 ${slug}\n\n正文`, ...extra
  };
}

// The summary, the graph and the reference tally are derived here the same way
// collect_tasks.py derives them, so a fixture that disagrees with its own tasks
// array is a bug in the test rather than a second opinion.
function taskPayload(tasks, extra = {}) {
  const edges = [];
  tasks.forEach(task => {
    if (task.parent) edges.push({ from: task.slug, to: task.parent, type: 'parent' });
    (task.depends || []).forEach(target => edges.push({ from: task.slug, to: target, type: 'depends' }));
  });
  const byStatus = tasks.reduce((map, task) => {
    const key = task.status || 'untriaged';
    map[key] = (map[key] || 0) + 1;
    return map;
  }, {});
  const refs = key => TASK_REF_FIXTURES.reduce((map, kind) => {
    const value = key(kind);
    if (value) map[value] = (map[value] || 0) + 1;
    return map;
  }, { resolved: 0, unresolved: 0, missing_index: 0 });
  return {
    schema_version: 1,
    source: { id: 'tasks', directory: 'tasks', repo: 'isLinXu/model-observatory', branch: 'main',
      url: `https://github.com/isLinXu/model-observatory/tree/main/tasks` },
    status: 'ok', error: null,
    captured_at: '2026-11-02T01:00:00Z', last_attempt_at: '2026-11-02T01:00:00Z',
    summary: {
      total: tasks.length, edges: edges.length,
      roots: tasks.filter(task => !task.parent).length,
      blocked: byStatus.blocked || 0, by_status: byStatus
    },
    validation: {
      parent_missing: tasks.filter(task => task.parent &&
        !tasks.some(other => other.slug === task.parent)).length,
      depends_missing: tasks.reduce((sum, task) => sum + (task.depends || [])
        .filter(target => !tasks.some(other => other.slug === target)).length, 0),
      self_edges: tasks.filter(task => (task.depends || []).includes(task.slug)).length,
      cycles: 0,
      refs: { entity: refs(kind => tasks.find(task => task.slug === kind)?.entity_state),
        ddl: refs(kind => tasks.find(task => task.slug === kind)?.ddl_state) }
    },
    sources: {
      entity: { file: 'entities.json', available: true, captured_at: '2026-11-02T01:00:00Z', reason: null },
      ddl: { file: 'conferences.json', available: true, captured_at: '2026-11-02T01:00:00Z', reason: null }
    },
    graph: { edges, dropped: [], truncated: false },
    changes: { status: 'initial' },
    warnings: [], structural_errors: [], tasks, ...extra
  };
}

const TASK_REF_FIXTURES = ['resolved', 'unresolved', 'missing_index'];

function loadBoardView({ tasks = null, payload = null, entities = [], token = '', routes = {},
  awesome = null, history, runs = null, globals = {} } = {}) {
  const index = payload || taskPayload(tasks || [
    taskFile('parent', { status: 'doing' }),
    taskFile('child', { status: 'proposal', parent: 'parent' }),
    taskFile('waiter', { status: 'blocked', depends: ['child'], reason: '等 child 收敛' })
  ]);
  const local = fakeStorage();
  const tab = fakeStorage(token ? { 'mo.repo.token': token } : {});
  const blobs = [];
  const anchors = [];
  const requests = [];
  // data.js resolves the Link header with `new URL`, while app.js exports with
  // `URL.createObjectURL`, so the harness needs both halves on one constructor.
  class TestURL extends URL {
    static createObjectURL(blob) { blobs.push(blob); return 'blob:local-test'; }
    static revokeObjectURL() {}
  }
  const fetchImpl = async (target, options = {}) => {
    const url = String(target);
    const method = options.method || 'GET';
    requests.push({ url, method, headers: options.headers || {},
      body: typeof options.body === 'string' ? JSON.parse(options.body) : null });
    if (url.startsWith('https://api.github.com')) {
      // Every write test names the routes it expects; an unexpected request is
      // an error, not a silently undefined reply a push would paper over.
      const reply = routes[`${method} ${url.slice('https://api.github.com'.length)}`];
      if (!reply) throw new Error(`测试没有准备 ${method} ${url} 的响应`);
      return reply;
    }
    if (url.includes('/data/awesome_history.json')) {
      // A missing history costs the trend line and nothing else, so the harness
      // serves an empty one unless a test names what it wants back.
      if (history === null) throw new Error(`测试没有准备清单历史：${url}`);
      return jsonResponse(history === undefined
        ? { schema_version: 1, source: { id: 'awesome' }, snapshots: [] } : history);
    }
    if (url.includes('/data/tasks.json')) return jsonResponse(index);
    if (url.includes('/data/runs.json')) {
      // The run-health line paints whatever it gets, including nothing, so a
      // test that does not name a record still gets the unread sentence rather
      // than an invented clean run.
      if (!runs) throw new Error(`测试没有准备运行记录：${url}`);
      return jsonResponse(runs);
    }
    if (url.includes('/data/awesome.json')) {
      // The paper-list board is only served when a test asks for it, so a panel
      // that never reached the fold cannot quietly depend on a missing reply.
      if (!awesome) throw new Error(`测试没有准备论文清单快照：${url}`);
      return jsonResponse(awesome);
    }
    throw new Error(`测试没有准备 ${url} 的响应`);
  };
  const element = elementFactory(new Map());
  // One context for the whole section, exactly like the page: taskDeadline asks
  // MO.format for the countdown, so a harness that loads data.js on its own
  // would be testing a module graph the browser never builds.
  const context = {
    console: { ...console, warn() {} },
    document: { getElementById: element, querySelectorAll: () => [], addEventListener() {},
      createElement: () => { const created = fakeElement(); anchors.push(created); return created; },
      body: { append() {}, style: {} } },
    localStorage: local, sessionStorage: tab, fetch: fetchImpl, URL: TestURL, AbortSignal, Blob,
    TextEncoder, TextDecoder,
    btoa: binary => Buffer.from(binary, 'binary').toString('base64'),
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    matchMedia: () => ({ matches: true }),
    setTimeout: callback => callback(),
    ...globals
  };
  context.window = context;
  vm.createContext(context);
  const run = name => {
    const filename = path.join(__dirname, '..', 'site', name);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  };
  ['format.js', 'charts.js', 'data.js', 'repo.js', 'board.js', 'render.js', 'tasksync.js'].forEach(run);
  const data = context.MO.data;
  data.state.tasks = index;
  data.state.conferences = conferencePayload([
    conference('CVPR', [conferenceEvent(TASK_DEADLINE_ID, { utc: TASK_DEADLINE_UTC })])
  ]);
  data.state.entities = entityPayload(entities);
  return { data, element, context, run, blobs, anchors, requests, local, tab,
    board: context.MO.board, render: context.MO.render, tasksync: context.MO.tasksync,
    repo: context.MO.repo };
}

// The bindings only exist once app.js has booted, and boot awaits the whole
// page's data. The section under test keeps its own renderers real - the markup
// *is* the claim - while every other board and the write-back panels are
// stubbed, and toasts are collected instead of painted.
async function startApp(view, keep, {
  IntersectionObserver = class { observe() {} disconnect() {} },
  loadAll = async () => {} } = {}) {
  const toasts = [];
  const booted = deferred();
  // The page always ships an observer, so the harness hands app.js one that
  // never fires: a test that forgot to trigger the read would then fail on the
  // snapshot it did not ask for, not on a canvas that loaded too early.
  view.context.IntersectionObserver = IntersectionObserver;
  view.context.MO.theme = { init() {} };
  view.context.MO.templates = { init: async () => {} };
  view.context.MO.data = { ...view.data, loadAll };
  view.data.state.latest = view.data.state.latest || { models: [] };
  view.context.MO.registry = { init: async () => { booted.resolve(); } };
  view.context.MO.render = Object.fromEntries(Object.entries(view.render).map(([name, fn]) => [
    name,
    keep.some(prefix => name.startsWith(prefix)) ? fn
      : name === 'showToast' ? message => toasts.push(message) : () => {}
  ]));
  view.run('app.js');
  await booted.promise;
  return { toasts };
}

const startTaskApp = (view, options) => startApp(view, ['renderTask'], options);
const startAwesomeApp = (view, options) => startApp(view, ['renderAwesome'], options);

const canvasPoint = (x, y, extra = {}) => ({ clientX: x, clientY: y, pointerId: 7, preventDefault() {}, ...extra });

function taskCanvas(view, cards = []) {
  const canvas = view.element('taskCanvas');
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0 });
  canvas.scrollLeft = 0;
  canvas.scrollTop = 0;
  canvas.querySelectorAll = () => cards;
  return canvas;
}

test('the canvas paints one card per task in its own lane and draws the edges the index drew', () => {
  const view = loadBoardView();
  view.board.load();
  view.render.renderTasks();
  const canvas = view.element('taskCanvas').innerHTML;
  assert.equal((canvas.match(/data-task-card="/g) || []).length, 3);
  assert.equal((canvas.match(/data-task-lane="/g) || []).length, 6,
    'an empty 未标注 lane is not a lane the reader has to look for');
  assert.match(canvas, /data-task-card="waiter"[^>]*style="left:594px;top:60px"/);
  assert.match(canvas, /⚑ 等 child 收敛/);
  assert.match(canvas, /↳ parent/);
  // The layer is painted inside the canvas, not left beside it: the canvas writes
  // its own innerHTML on every repaint, so a node it owns would be gone by the
  // second one and the page would crash on a null the moment a card is dragged.
  const layerStart = canvas.indexOf('<svg id="taskEdgeLayer"');
  assert.ok(layerStart >= 0, 'the line layer travels with the canvas markup');
  const edges = canvas.slice(layerStart, canvas.indexOf('</svg>') + 6);
  assert.match(edges, /viewBox="0 0 1988 \d+"/);
  assert.equal((edges.match(/task-edge-parent/g) || []).length, 1);
  assert.equal((edges.match(/task-edge-depends/g) || []).length, 1);
  assert.match(edges, /marker-end="url\(#task-arrow-parent\)"/);
  assert.match(edges, /<title>child 拆自 parent<\/title>/);
  view.render.renderTasks();
  assert.equal((view.element('taskCanvas').innerHTML.match(/<svg id="taskEdgeLayer"/g) || []).length, 1,
    'one layer per repaint');
  assert.equal(view.element('taskCanvasSize').textContent,
    '3 / 3 张卡在同屏 · 2 条连线 · 卡片座标只存本机');
  assert.equal(view.element('statTaskEdges').textContent, '2');
  assert.equal(view.element('taskCountBadge').textContent, '3');
  assert.equal(view.element('taskLanes').textContent,
    '提案 → 进行中 → 受阻 → 待验收 → 已完成 → 已放弃 → 未标注');
});

test('a task whose status the collector could not read falls to 未标注, not to the first lane', () => {
  const view = loadBoardView({ tasks: [taskFile('mystery', { status: null })] });
  view.board.load();
  view.render.renderTasks();
  const canvas = view.element('taskCanvas').innerHTML;
  assert.match(canvas, /data-task-lane="untriaged"/);
  assert.match(canvas, /class="task-card" data-task-card="mystery"/);
  assert.match(canvas, /task-untriaged">未标注</);
  assert.match(view.element('taskStatus').textContent,
    /1 个任务落在「未标注」道，需要补 status/);
});

test('a card position is furniture while a lane change is a draft that has to be pushed', () => {
  const view = loadBoardView({ tasks: [taskFile('one')] });
  view.board.load();
  view.render.renderTasks();
  assert.equal(view.board.rows().filter(row => row.dirty).length, 0);
  assert.equal(view.element('taskDraftBadge').textContent, '无本地改动');

  view.board.move('one', { x: 640, y: 220 });
  view.render.renderTasks();
  assert.equal(view.board.draftSummary().total, 0, '摆放不是改动：它永远不会进仓库');
  assert.equal(view.board.draftSummary().positions, 1);
  assert.match(view.element('taskCanvas').innerHTML, /is-placed/);
  assert.match(view.element('taskCanvas').innerHTML, /data-task-card="one" style="left:640px;top:220px"/);
  assert.equal(view.element('taskDraftBadge').textContent, '无本地改动');
  assert.equal(JSON.parse(view.local.store['mo.board.layout']).one.x, 640);
  assert.ok(!JSON.stringify(view.local.store['mo.board.layout']).includes('doing'),
    'the layout file holds coordinates and nothing about the work');

  view.board.setStatus('one', 'review');
  view.render.renderTasks();
  assert.equal(view.board.draftSummary().total, 1);
  assert.equal(view.element('taskDraftBadge').textContent, '1 张卡待推送');
  assert.match(view.element('taskDraftBadge').title, /座标 1 张只留在本机/);
  const canvas = view.element('taskCanvas').innerHTML;
  assert.match(canvas, /class="task-card is-draft is-placed"/);
  assert.match(canvas, /本地改动/);
  assert.deepEqual(JSON.parse(view.local.store['mo.board.edits']).edits.one, { status: 'review' });
  assert.match(view.element('taskStatus').textContent, /1 张卡有本地改动，尚未推送/);
});

test('a card dragged out of a lane and back is not a change', () => {
  const view = loadBoardView({ tasks: [taskFile('one', { status: 'doing' })] });
  view.board.load();
  assert.equal(view.board.setStatus('one', 'review').changed, true);
  assert.equal(view.board.patchOf('one') !== null, true);
  assert.equal(view.board.setStatus('one', 'doing').changed, true);
  assert.equal(view.board.patchOf('one'), null, 'back to what the index says is no draft');
  assert.equal(view.board.draftSummary().total, 0);
  view.render.renderTasks();
  assert.doesNotMatch(view.element('taskCanvas').innerHTML, /is-draft/);
});

test('the canvas refuses the edges the collector would drop, and says why out loud', () => {
  const view = loadBoardView({ tasks: [
    taskFile('a', { status: 'doing' }),
    taskFile('b', { status: 'proposal', parent: 'a' }),
    taskFile('c', { status: 'blocked', depends: ['b'] })
  ] });
  view.board.load();
  const selfLink = view.board.connect('a', 'a');
  assert.equal(selfLink.ok, false);
  assert.equal(selfLink.changed, false);
  assert.equal(selfLink.reason, 'a 不能连到自己。');
  assert.deepEqual(view.board.connect('a', 'ghost').reason, '目标 ghost 不在看板上。');
  assert.match(view.board.connect('b', 'c').reason, /c 已经能回到 b，这条线会成环/);
  assert.match(view.board.setParent('a', 'b').reason, /b 已经能回到 a，这条线会成环/);
  assert.equal(view.board.draftSummary().total, 0, 'a refused line writes nothing');

  const added = view.board.connect('a', 'c');
  assert.equal(added.ok, true);
  assert.equal(view.board.patchOf('a').depends.join(','), 'c');
  const lines = view.board.edges().lines;
  const depends = lines.find(edge => edge.type === 'depends' && edge.from === 'a');
  assert.equal(depends.draft, true, 'a line only this browser drew is marked as such');
  assert.match(depends.d, /^M -?\d+\.?\d* -?\d+\.?\d* C /);
});

test('the queue keeps 画布拒绝, 索引拒绝 and 未核对 apart and never calls an unchecked link a 断链', () => {
  const view = loadBoardView({ tasks: [
    taskFile('root', { status: 'doing', ddl: TASK_DEADLINE_ID, ddl_state: 'unresolved' }),
    taskFile('kid', { status: 'proposal', parent: 'ghost', entity: 'mme', entity_state: 'missing_index' })
  ] });
  const payload = view.data.state.tasks;
  payload.graph.dropped = [{ from: 'gone', to: 'nobody', type: 'parent', reason: 'missing' }];
  payload.structural_errors = ['kid: status「nope」不属于六态词表'];
  view.render.renderTasks();
  const queue = view.element('taskQueue').innerHTML;
  assert.match(queue, /画布拒绝<\/span><div class="entity-detail-text"><code>kid -parent-&gt; ghost/);
  assert.match(queue, /索引拒绝/);
  assert.match(queue, /断引用/);
  assert.match(queue, /ddl AI\/cvpr:cvpr27:paper:1 在当日快照里找不到/);
  assert.match(queue, /未核对/);
  assert.match(queue, /来源本次没有可用快照，这不是断链/);
  assert.match(queue, /结构错误/);
  assert.match(view.element('taskQueueNote').textContent, /5 条需要看一眼/);
  assert.equal(view.board.graph().dropped.length, 1);
  assert.equal(view.board.graph().missingParents, 1);
});

test('cards escape what the repository says and never turn a non-http url into a link', () => {
  const view = loadBoardView({ tasks: [taskFile('xss', {
    title: '<img src=x onerror="bad"> & "quoted"',
    reason: "javascript:alert(1)",
    url: 'javascript:alert(1)',
    body: '<script>steal()</script>'
  })] });
  view.board.load();
  view.render.renderTasks();
  const canvas = view.element('taskCanvas').innerHTML;
  assert.ok(!canvas.includes('<img src=x'), 'the title arrives escaped');
  assert.match(canvas, /&lt;img src=x onerror=&quot;bad&quot;&gt;/);
  view.data.state.taskOpen = 'xss';
  view.render.renderTasks();
  const detail = view.element('taskDetail').innerHTML;
  assert.ok(!detail.includes('<script>steal'), 'the body copy is never treated as markup');
  assert.ok(!detail.includes('href="javascript:'), 'a crafted url is not a link');
  assert.match(detail, /索引没有给出可以打开的源文件链接/);
  assert.ok(!detail.includes('在 GitHub 打开源文件'), 'nothing is linked that the collector did not publish');
  view.data.state.taskView = 'list';
  view.render.renderTasks();
  const rows = view.element('taskRows').innerHTML;
  assert.ok(!rows.includes('href="javascript'), 'the list links nothing untrusted');
  assert.match(rows, /&lt;img src=x/);
});

test('a ddl card borrows the countdown from the conference board and never keeps a copy', () => {
  const view = loadBoardView({ tasks: [
    taskFile('camera', { status: 'doing', ddl: TASK_DEADLINE_ID, ddl_state: 'resolved' })
  ] });
  view.board.load();
  view.render.renderTasks();
  assert.equal('utc' in view.board.rows()[0], false, 'the row carries an id, not a timestamp');
  assert.equal(view.board.rows()[0].ddl, TASK_DEADLINE_ID);
  const canvas = view.element('taskCanvas').innerHTML;
  assert.match(canvas, /task-ref task-ddl task-ddl-resolved/);
  assert.match(canvas, /◴ AI\/cvpr:cvpr27:paper:1/);
  assert.match(canvas, /距截止 \d+ 天/);
  assert.match(canvas, /title="倒计时取自 conferences\.json，任务卡只保存这个 ID"/);
  assert.match(view.element('statTaskDeadline').textContent, /\d+ 天$/);
  assert.match(view.element('statTaskDeadlineSub').textContent, /｜数字归顶会看板所有$/);
  assert.match(view.element('statTaskDeadlineSub').textContent, /CVPR/);
});

test('an id the conference board does not know is named as missing, not counted down', () => {
  const view = loadBoardView({ tasks: [
    taskFile('ghost', { status: 'doing', ddl: 'AI/cvpr:cvpr27:paper:9', ddl_state: 'unresolved' })
  ] });
  view.board.load();
  view.render.renderTasks();
  assert.match(view.element('taskCanvas').innerHTML, /顶会目录里没有这个环节 ID/);
  assert.doesNotMatch(view.element('taskCanvas').innerHTML, /距截止/);
  assert.equal(view.element('statTaskDeadline').textContent, '—');
  assert.equal(view.element('statTaskDeadlineSub').textContent, '没有任务挂 ddl 截止时间');
  // The queue is where an id nobody can resolve has to show up.
  assert.match(view.element('taskQueue').innerHTML, /断引用/);
});

test('a task snapshot that could not read its sources says 未核对 instead of guessing', () => {
  const payload = taskPayload([taskFile('blind', { status: 'doing', entity: 'mme',
    entity_state: 'missing_index', ddl: TASK_DEADLINE_ID, ddl_state: 'missing_index' })]);
  payload.sources.ddl = { file: 'conferences.json', available: false, captured_at: null,
    reason: '顶会采集当日失败' };
  const view = loadBoardView({ payload, entities: [entityEntry('mme')] });
  view.data.state.conferences = conferencePayload([], { status: 'unavailable' });
  view.board.load();
  view.render.renderTasks();
  const canvas = view.element('taskCanvas').innerHTML;
  assert.match(canvas, /task-ddl-missing_index/);
  assert.match(canvas, /顶会快照本次不可用，未核对/);
  assert.doesNotMatch(canvas, /距截止/, 'a blind source cannot produce a countdown');
  // The chip says which side went dark, and the queue refuses to call it a 断链.
  assert.match(canvas, /未核对——那次采集没有可用快照，所以这里什么都没说。｜顶会采集当日失败/);
  assert.match(view.element('taskQueue').innerHTML, /未核对[\s\S]*来源本次没有可用快照，这不是断链/);
});

test('the list view shares the canvas filter, pages twelve at a time and marks local rows', () => {
  const view = loadBoardView({ tasks: Array.from({ length: 13 }, (unused, index) => taskFile(
    `t${String(index).padStart(2, '0')}`, { status: index === 0 ? 'blocked' : 'doing',
      tags: index < 3 ? ['看板'] : [] })) });
  view.data.state.taskView = 'list';
  view.board.load();
  view.render.renderTasks();
  assert.equal((view.element('taskRows').innerHTML.match(/<tr class="task-row/g) || []).length, 12);
  assert.equal(view.element('taskPageInfo').textContent, '第 1 / 2 页');
  assert.equal(view.element('taskNext').disabled, false);
  assert.equal(view.element('taskPrev').disabled, true);
  assert.equal(view.element('taskTableCount').textContent, '13 / 13 TASKS · 清单与画布共用同一份筛选');
  view.data.state.taskPage = 2;
  view.render.renderTaskList();
  assert.equal((view.element('taskRows').innerHTML.match(/<tr class="task-row/g) || []).length, 1);
  assert.equal(view.element('taskNext').disabled, true);

  view.data.state.taskPage = 1;
  view.data.state.taskTag = '看板';
  view.data.state.taskView = 'board';
  view.render.renderTasks();
  assert.equal(view.board.rows().length, 13, 'the board still knows every card');
  assert.equal(view.element('taskCanvasSize').textContent,
    '3 / 13 张卡在同屏 · 0 条连线 · 卡片座标只存本机');
  view.data.state.taskRef = 'broken';
  view.render.renderTasks();
  const hidden = view.element('taskCanvas').innerHTML;
  assert.equal((hidden.match(/data-task-card="/g) || []).length, 0,
    'a blocked card with no broken reference is filtered out');
  assert.equal((hidden.match(/data-task-lane="/g) || []).length, 6,
    'an empty result still shows the lanes, so the filter has not eaten the board');
  assert.match(view.element('taskCanvasSize').textContent, /^0 \/ 13 张卡在同屏/);

  view.data.state.taskRef = 'all';
  view.data.state.taskTag = 'all';
  view.board.setStatus('t00', 'review');
  view.render.renderTaskList();
  assert.match(view.element('taskRows').innerHTML, /task-row is-draft/);
  assert.match(view.element('taskRows').innerHTML, /task-flag">本地</);
});

test('a drag onto a card 拆解 the work, a drag into a lane changes 状态, and a refused one says so', async () => {
  const view = loadBoardView();
  const app = await startTaskApp(view);
  const cards = ['parent', 'child', 'waiter'].map(slug => {
    const card = fakeElement();
    card.dataset.taskCard = slug;
    return card;
  });
  const canvas = taskCanvas(view, cards);
  const pointer = (index, x, y, handle = null) => canvasPoint(x, y, { target: {
    closest: selector => (selector === '[data-task-card]' ? cards[index]
      : selector === '[data-task-link]' ? handle : null)
  } });

  // waiter (受阻, x 594) dragged onto child (提案, x 30): a parent line, no relocation.
  canvas.events.pointerdown(pointer(2, 700, 116));
  canvas.events.pointermove(pointer(2, 148, 116));
  assert.match(view.element('taskCanvasSize').textContent,
    /松手：把 waiter 拆到 child 下面（这条线会写进 waiter 的 parent）/);
  canvas.events.pointerup(pointer(2, 148, 116));
  assert.equal(view.board.patchOf('waiter').parent, 'child');
  assert.match(app.toasts.at(-1), /已拆解：waiter 现在是 child 的子任务。这是本地草稿/);
  assert.equal(view.board.state.layout.waiter, undefined,
    'drawing a line is not a request to pile the card on top of its new parent');

  // The same drop the other way round closes a loop, and the canvas refuses it.
  canvas.events.pointerdown(pointer(1, 148, 116));
  canvas.events.pointermove(pointer(1, 700, 116));
  canvas.events.pointerup(pointer(1, 700, 116));
  assert.match(app.toasts.at(-1), /会成环，画布上拖不出来/);
  assert.equal(view.board.patchOf('child'), null, 'a refused drag writes nothing');

  // parent (进行中) released over the 待验收 lane: a status draft and a new slot.
  canvas.events.pointerdown(pointer(0, 400, 116));
  canvas.events.pointermove(pointer(0, 900, 116));
  assert.match(view.element('taskCanvasSize').textContent, /松手：落在「待验收」道/);
  canvas.events.pointerup(pointer(0, 900, 116));
  assert.equal(view.board.patchOf('parent').status, 'review');
  assert.match(app.toasts.at(-1), /状态改为「待验收」（本地草稿）/);
  assert.match(view.element('taskCanvas').innerHTML,
    /data-task-card="parent" style="left:876px;top:60px"/);

  // A release inside the card's own lane is furniture, not a change.
  canvas.events.pointerdown(pointer(1, 148, 100));
  canvas.events.pointermove(pointer(1, 150, 200));
  canvas.events.pointerup(pointer(1, 150, 200));
  assert.match(app.toasts.at(-1), /已摆放：卡片座标只存在这台浏览器/);
  assert.equal(view.board.draftSummary().edited, 2, 'the placement added no draft');
  assert.equal(view.board.draftSummary().positions, 2);

  // A press that never travelled is a click, and a click never re-lanes anything.
  canvas.events.pointerdown(pointer(0, 900, 100));
  canvas.events.pointermove(pointer(0, 902, 100));
  canvas.events.pointerup(pointer(0, 900, 100));
  assert.equal(view.data.state.taskView, 'board');
  assert.equal(view.data.state.taskOpen, 'parent');
  assert.equal(Object.keys(view.board.patchOf('parent')).join(','), 'status',
    'a drag that never travelled draws nothing');
});

test('the link handle draws a 依赖 line and a still click opens the card instead', async () => {
  const view = loadBoardView();
  const app = await startTaskApp(view);
  const cards = ['parent', 'child', 'waiter'].map(slug => {
    const card = fakeElement();
    card.dataset.taskCard = slug;
    return card;
  });
  const canvas = taskCanvas(view, cards);
  const pointer = (index, x, y, handle = null) => canvasPoint(x, y, { target: {
    closest: selector => (selector === '[data-task-card]' ? cards[index]
      : selector === '[data-task-link]' ? handle : null)
  } });

  canvas.events.pointerdown(pointer(0, 400, 116, { dataset: { taskLink: 'parent' } }));
  canvas.events.pointermove(pointer(0, 700, 116, { dataset: { taskLink: 'parent' } }));
  assert.match(view.element('taskCanvasSize').textContent,
    /松手：parent 等待 waiter（这条线会写进 parent 的 depends）/);
  canvas.events.pointerup(pointer(0, 700, 116));
  assert.deepEqual(plain(view.board.patchOf('parent').depends), ['waiter']);
  assert.match(app.toasts.at(-1), /已连上：parent 等待 waiter/);
  assert.equal(view.board.state.layout.parent, undefined, 'the handle never moves the box');

  // Releasing over empty canvas is not a line, and the readout says so while the
  // pointer is still down - a lane name would promise a lane change the mode cannot do.
  canvas.events.pointerdown(pointer(1, 148, 116, { dataset: { taskLink: 'child' } }));
  canvas.events.pointermove(pointer(1, 1500, 116, { dataset: { taskLink: 'child' } }));
  assert.match(view.element('taskCanvasSize').textContent,
    /松手的地方没有卡片：依赖线要落在另一张卡上/);
  canvas.events.pointerup(pointer(1, 1500, 116));
  assert.match(app.toasts.at(-1), /松手的地方没有卡片/);
  assert.equal(view.board.patchOf('child'), null);

  // A press that never moves is a click, and a click opens the card.
  canvas.events.pointerdown(pointer(2, 700, 116));
  canvas.events.pointerup(pointer(2, 700, 116));
  assert.equal(view.data.state.taskOpen, 'waiter');
  assert.match(view.element('taskDetail').innerHTML, /等 child 收敛/);
  canvas.events.pointerdown(pointer(2, 700, 116));
  canvas.events.pointerup(pointer(2, 700, 116));
  assert.equal(view.data.state.taskOpen, null, 'the same card clicked twice closes itself');

  // The list row and the detail's 撤销 button drive the same two reducers.
  view.element('taskRows').events.click({ target: {
    closest: selector => selector === '[data-task-open]' ? { dataset: { taskOpen: 'child' } } : null } });
  assert.equal(view.data.state.taskOpen, 'child');
  view.element('taskDetail').events.click({ target: {
    closest: selector => selector === '[data-task-reset]' ? { dataset: { taskReset: 'parent' } } : null } });
  assert.equal(view.board.patchOf('parent'), null);
  assert.match(app.toasts.at(-1), /已丢弃 parent 在本机的改动/);
});

test('a focused card opens with Enter and with Space, and Space does not scroll past it', async () => {
  const view = loadBoardView();
  await startTaskApp(view);
  const card = fakeElement();
  card.dataset.taskCard = 'child';
  let defaulted = false;
  const press = key => {
    defaulted = false;
    view.element('taskCanvas').events.keydown({
      key, preventDefault() { defaulted = true; },
      target: { closest: selector => selector === '[data-task-card]' ? card : null }
    });
  };
  press('Tab');
  assert.equal(view.data.state.taskOpen, null, 'a key that means nothing to a button is left alone');
  assert.equal(defaulted, false);
  press('Enter');
  assert.equal(view.data.state.taskOpen, 'child');
  assert.match(view.element('taskDetail').innerHTML, /# 任务 child/);
  assert.equal(defaulted, true);
  press(' ');
  assert.equal(view.data.state.taskOpen, null, 'the same card toggled shut by the same key');
  assert.equal(defaulted, true, 'Space belongs to the card, not to the scrollbar');
});

test('a new card is a file name first, and the export carries the draft flag behind the formula guard', async () => {
  const view = loadBoardView({ tasks: [
    taskFile('draw', { status: 'doing', title: '=SUM(1,2)', reason: '+cmd' })
  ] });
  const app = await startTaskApp(view);
  assert.equal(view.requests.filter(request => request.url.includes('/data/tasks.json')).length, 0,
    'booting the page asks for the task snapshot no earlier than the reader reaches it');

  view.element('taskNewSlug').value = '任务看板';
  view.element('taskNewTitle').value = '画布拆分';
  view.element('taskNewCreate').events.click();
  assert.match(view.element('taskNewNote').textContent, /文件名需为小写字母、数字与连字符/);
  assert.equal(view.board.rows().length, 1, 'a name that cannot be a file never becomes a card');

  // A space is not a hyphen: the file name rule is literal, so the canvas says so
  // instead of inventing a name the author never typed.
  view.element('taskNewSlug').value = 'Board Canvas';
  view.element('taskNewCreate').events.click();
  assert.match(view.element('taskNewNote').textContent, /文件名需为小写字母、数字与连字符/);
  assert.equal(view.board.rows().length, 1, 'a name with a space in it is still not a file');

  view.element('taskNewSlug').value = 'Board-Canvas';
  view.element('taskNewTitle').value = '画布拆分';
  view.element('taskNewCreate').events.click();
  assert.equal(view.board.rows().length, 2);
  assert.match(app.toasts.at(-1), /画布上多了一张卡：board-canvas/);
  const canvas = view.element('taskCanvas').innerHTML;
  assert.match(canvas, /data-task-card="board-canvas"/);
  assert.match(canvas, /新建 · 未推送/);
  assert.equal(view.board.draftSummary().created, 1);
  assert.equal(view.element('taskDraftBadge').textContent, '1 张卡待推送');

  const patch = view.board.patchFor('board-canvas');
  assert.equal(patch.create, true);
  assert.equal(patch.slug, 'board-canvas');
  assert.equal(patch.title, '画布拆分', 'the file name is latin, the title keeps what the author typed');
  assert.equal(view.board.patchFor('draw'), null, 'a card nobody edited has nothing to push');
  view.board.setStatus('board-canvas', 'doing');
  assert.equal(view.board.patchFor('board-canvas').status, 'doing', 'a draft card edits itself, not an overlay');

  view.element('taskExport').onclick();
  const text = await view.blobs[0].text();
  // The export is sorted by what the page shows, so the rows are found by slug
  // instead of by a position the sort is free to change.
  const [header, ...records] = text.replace(/^\uFEFF/, '').split('\r\n').map(row =>
    Array.from(row.matchAll(/"((?:[^"]|"")*)"/g), match => match[1].replace(/""/g, '"')));
  const bySlug = Object.fromEntries(records.map(row => [row[0], row]));
  assert.equal(header[0], 'slug');
  assert.equal(header.length, 17);
  assert.equal(header[14], 'draft_state', 'three states, because a pushed card is neither local nor clean');
  assert.equal(bySlug.draw[1], "'=SUM(1,2)", 'a formula stays a string when the csv is opened');
  assert.equal(bySlug.draw[14], 'none', 'the published card is not a local draft');
  assert.equal(bySlug['board-canvas'][14], 'local', 'the card only this browser made is marked as one');
  assert.equal(bySlug['board-canvas'][15], '', 'a draft that never went out carries no push time');
  assert.equal(bySlug['board-canvas'][2], 'doing');
  assert.equal(view.anchors.at(-1).download, 'task-board-2026-11-02.csv');
});

test('the canvas reads its snapshot when the reader reaches it and never re-reads on a second entry', async () => {
  const observers = [];
  class IntersectionObserver {
    constructor(callback, options) { this.callback = callback; this.options = options; observers.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.disconnected = (this.disconnected || 0) + 1; }
  }
  const view = loadBoardView({ tasks: [taskFile('one')] });
  const app = await startTaskApp(view, { IntersectionObserver });
  assert.equal(view.data.state.taskSnapshotCheckedAt, null);
  assert.match(view.element('taskCheckedAt').textContent, /尚未成功读取快照/);
  // Three lazy sections watch the page; the task one is the box under test.
  const taskObserver = observers.find(observer => observer.target === view.element('tasks'));
  assert.equal(observers.length, 3, 'the star wall, the canvas and the paper lists each get one watcher');
  assert.ok(taskObserver, 'the canvas is watched, not downloaded at boot');

  taskObserver.callback([{ isIntersecting: true }]);
  await nextTurn();
  await nextTurn();
  assert.equal(view.requests.filter(request => request.url.includes('/data/tasks.json')).length, 1);
  assert.equal(taskObserver.disconnected, 1);
  assert.match(view.element('taskCheckedAt').textContent, /最近成功读取快照 .*采集由每日工作流完成/);
  assert.match(view.element('taskFreshness').textContent, /读取不触发采集/);

  taskObserver.callback([{ isIntersecting: true }]);
  await nextTurn();
  assert.equal(view.requests.filter(request => request.url.includes('/data/tasks.json')).length, 1);
  assert.equal(app.toasts.length, 0, 'an entry read is not an event that shouts at the reader');

  view.element('taskRefresh').events.click();
  await nextTurn();
  await nextTurn();
  assert.equal(view.requests.filter(request => request.url.includes('/data/tasks.json')).length, 2);
  assert.match(app.toasts.at(-1), /刷新只读取已发布文件，不会触发后台采集/);
  assert.equal(view.element('taskRefresh').textContent, '刷新已发布快照', 'the button gives its label back');
});

// --- Task board: pushing the draft back -----------------------------------

// The file as it sits on the remote. The index only carries a truncated copy of
// this prose, so the tail sentence is part of the assertions below: a push
// assembled from the snapshot instead would cut it off, and nobody would see it
// happen.
const TASK_REMOTE_TEXT = [
  '---',
  'title: 母任务',
  'status: doing',
  'parent: index-lost',
  'entity: mme',
  'ddl: AI/cvpr:cvpr27:paper:1',
  'tags: [board, ui]',
  'updated: 2026-11-01',
  'reason: 等采集口径定下来',
  'notes: 采集器不读这个字段',
  'depends:',
  '  - collect-tasks',
  '  - repo-layer',
  '---',
  '',
  '# 母任务',
  '',
  '远端的正文比索引里的截断副本长：这一句必须活过一次推送。',
  ''
].join('\n');

// The same file after somebody else moved its status - the shape every three-way
// test below starts from.
const TASK_REMOTE_MOVED = TASK_REMOTE_TEXT.replace('status: doing', 'status: blocked');
const WAITER_REMOTE_TEXT = ['---', 'title: 等上游', 'status: blocked', 'depends: [child]',
  'reason: 等 child 收敛', 'updated: 2026-10-30', '---', '', '# 等上游', '',
  '被挡住的是口径，不是代码。', ''].join('\n');

const taskRoute = (slug, method = 'GET') =>
  `${method} /repos/isLinXu/model-observatory/contents/tasks/${slug}.md`;
const taskReply = (sha, text = TASK_REMOTE_TEXT) =>
  jsonResponse({ sha, content: b64(text), last_commit: null });
const taskPutReply = (sha = 'deadbee') => jsonResponse({ commit: { sha } });
// The Contents API answer for a file that simply is not there.
const taskMissing = () => jsonResponse({ message: 'Not Found' }, { status: 404 });
const putsOf = view => view.requests.filter(request => request.method === 'PUT');
const putOf = view => putsOf(view)[0];
const written = request => unb64(request.body.content);

test('a push rewrites only the fields the card touched, onto the live source text', () => {
  const view = loadBoardView();
  const composed = view.board.compose(
    { slug: 'parent', status: 'review', depends: ['child'], update: true },
    TASK_REMOTE_TEXT, { at: '2026-11-02' });
  assert.ok(composed.ok, composed.reason);
  assert.deepEqual(plain(composed.notes),
    ['采集器不读这些字段：notes（保留在文件里，不受本次推送影响）。']);
  const fields = plain(view.board.fieldsOf(composed.text));
  assert.deepEqual(fields, { status: 'review', parent: 'index-lost', depends: ['child'] },
    'the field the canvas never touched keeps what the remote says');
  assert.match(composed.text, /^updated: 2026-11-02$/m);
  assert.match(composed.text, /depends: \[child\]/);
  assert.match(composed.text, /这一句必须活过一次推送/, 'the body is the remote file, not the index copy');
  assert.match(composed.text, /reason: 等采集口径定下来/);
  assert.match(composed.text, /entity: mme/);
  assert.ok(!/^[ \t]+- /m.test(composed.text), 'no orphan list item survives the key it belonged to');
});

test('compose refuses the drafts the collector would reject tomorrow', () => {
  const view = loadBoardView();
  const untriaged = view.board.compose({ slug: 'parent', status: null, update: true }, TASK_REMOTE_TEXT);
  assert.equal(untriaged.ok, false);
  assert.match(untriaged.reason, /「未标注」是画布上的道，不是能写进文件的状态/);
  assert.match(untriaged.reason, /CI 的结构检查/);

  const crowded = view.board.compose({ slug: 'parent', update: true,
    depends: Array.from({ length: 13 }, (unused, index) => `t${index}`) }, TASK_REMOTE_TEXT);
  assert.match(crowded.reason, /超过采集器发布的 12 条上限/);

  const headless = view.board.compose({ slug: 'parent', status: 'done', update: true }, '# 只剩正文\n');
  assert.match(headless.reason, /读不到 --- front matter/);

  const escape = view.board.compose({ slug: '../tasks/x', status: 'done', update: true }, TASK_REMOTE_TEXT);
  assert.match(escape.reason, /需为小写字母、数字与连字符，不能写成路径或中文/);
});

test('a local card becomes a file, and a file somebody made first keeps its own prose', () => {
  const view = loadBoardView();
  const created = view.board.compose({ slug: 'sub-task', title: '子任务', status: 'proposal',
    depends: ['parent'], tags: ['board'], body: '# 子任务\n\n拆出来的说明', create: true }, '',
    { at: '2026-11-02' });
  assert.ok(created.ok, created.reason);
  assert.deepEqual(plain(view.board.fieldsOf(created.text)),
    { status: 'proposal', parent: null, depends: ['parent'] });
  assert.match(created.text, /title: 子任务/);
  assert.match(created.text, /tags: \[board\]/);
  assert.match(created.text, /拆出来的说明/);
  assert.equal((created.text.match(/^# /gm) || []).length, 1,
    'one heading, not one from the card and one from the template');

  // Somebody made tasks/sub-task.md between the click and the push.
  const raced = view.board.compose({ slug: 'sub-task', title: '子任务', status: 'review', create: true },
    TASK_REMOTE_TEXT, { at: '2026-11-02' });
  assert.ok(raced.ok, raced.reason);
  assert.match(raced.notes.join(' '), /远端已有同名文件/);
  assert.match(raced.text, /这一句必须活过一次推送/, 'the remote prose wins over the local card');
  assert.equal(view.board.fieldsOf(raced.text).status, 'review');

  assert.equal(view.board.compose({ slug: 'sub-task', title: '子任务', create: true }, '# 只有正文\n').ok, false);
  assert.match(view.board.compose({ slug: 'sub-task', create: true }, '', { at: '2026-11-02' }).reason,
    /新建卡没有标题/);

  // What the collector cannot see is said out loud instead of quietly dropped.
  const bare = '---\ntitle: 小任务\nstatus: doing\n---\n\n# 小任务\n';
  const blocked = view.board.compose({ slug: 'small', status: 'blocked', update: true }, bare,
    { at: '2026-11-02' });
  assert.ok(blocked.ok, blocked.reason);
  assert.match(blocked.notes.join(' '), /受阻卡没有 reason:/);
  assert.match(blocked.text, /^updated: 2026-11-02$/m, 'a file with no updated gets one');
});

test('a push reads the live file, writes only the card fields and remembers the commit', async () => {
  const view = loadBoardView({ token: 'ghp-test', routes: {
    [taskRoute('parent')]: taskReply('sha-a'),
    [taskRoute('parent', 'PUT')]: taskPutReply('deadbee')
  } });
  await view.tasksync.init();
  view.board.setStatus('parent', 'review');
  view.render.renderTasks();
  assert.equal(view.board.pushState('parent'), 'pending');
  assert.equal(view.element('taskDraftBadge').textContent, '1 张卡待推送');
  assert.match(view.element('taskCanvas').innerHTML, />本地改动</);
  assert.equal(view.element('taskPushAll').textContent, '按顺序推送全部（1）');
  assert.equal(view.element('taskPushAll').disabled, false);

  const outcome = await view.tasksync.push('parent');
  assert.equal(outcome.status, 'pushed');
  assert.match(outcome.notes.join(' '), /采集器不读这些字段：notes/);
  const put = putOf(view);
  assert.equal(put.body.sha, 'sha-a', 'the blob SHA just read is the baseline the write is guarded by');
  assert.equal(put.body.branch, 'main');
  assert.equal(put.body.message, 'docs(tasks): 更新 parent 任务卡');
  assert.equal(put.headers.Authorization, 'Bearer ghp-test');
  const file = written(put);
  assert.match(file, /status: review/);
  assert.match(file, /这一句必须活过一次推送/);
  assert.match(file, /^updated: \d{4}-\d{2}-\d{2}$/m, 'updated is the date of this change');

  assert.equal(view.board.pushState('parent'), 'pushed');
  assert.equal(view.board.pendingSlugs().length, 0);
  assert.deepEqual(plain(view.board.pushedSlugs()), ['parent']);
  assert.equal(view.board.baseOf('parent').status, 'review',
    'the version just written is what the next draft is measured against');
  assert.equal(JSON.parse(view.local.store['mo.board.edits']).bases.parent.status, 'review',
    'and it survives a reload');
  assert.match(view.element('taskSyncMessage').textContent, /已推送 tasks\/parent\.md（提交 deadbee）/);
  view.render.renderTasks();
  assert.equal(view.element('taskDraftBadge').textContent, '1 张已推送 · 等索引');
  assert.match(view.element('taskCanvas').innerHTML, />已推送 · 等索引</);
  assert.match(view.element('taskDraftList').innerHTML, /再推一次/);
  assert.match(view.element('taskCheckedAt').textContent, /已推送 1 张，次日索引才会反映它们/);

  // A further drag after a push is a new draft, never an amendment of that commit.
  view.board.setStatus('parent', 'done');
  assert.equal(view.board.pushState('parent'), 'pending');
});

test('a remote that moved under the draft is refused, and 以远端为准 leaves the file alone', async () => {
  const view = loadBoardView({ token: 't', routes: { [taskRoute('parent')]: taskReply('sha-b', TASK_REMOTE_MOVED) } });
  await view.tasksync.init();
  view.board.setStatus('parent', 'blocked');
  const outcome = await view.tasksync.push('parent');
  assert.equal(outcome.status, 'conflict');
  assert.deepEqual(plain(outcome.fields), ['status']);
  assert.equal(view.tasksync.state.conflict.slug, 'parent');
  assert.equal(putOf(view), undefined, 'nothing is written while the three choices are open');
  assert.equal(view.element('taskSyncState').textContent, '远端已变');
  assert.match(view.element('taskSyncMessage').textContent, /状态在远端被改过，推送已挡下/);
  assert.equal(view.element('taskPushConflict').classes.has('hidden'), false);
  assert.match(view.element('taskConflictNote').textContent,
    /状态 — 基线 进行中 \/ 远端 受阻 \/ 你的草稿 受阻/);

  view.element('taskConflictKeepRemote').events.click();
  assert.equal(view.board.patchOf('parent'), null);
  assert.equal(view.tasksync.state.conflict, null);
  assert.equal(putOf(view), undefined, 'the remote file is not touched by the choice that defers to it');
  assert.match(view.element('taskSyncMessage').textContent,
    /已以远端为准：parent 的本机改动已丢弃.*远端文件一个字都没动/);
});

test('按远端重做基线 folds away what the remote already has, then pushes what is still yours', async () => {
  const view = loadBoardView({ token: 't', routes: {
    [taskRoute('parent')]: taskReply('sha-b', TASK_REMOTE_MOVED),
    [taskRoute('parent', 'PUT')]: taskPutReply('cafe111')
  } });
  await view.tasksync.init();
  view.board.setStatus('parent', 'blocked');
  view.board.connect('parent', 'waiter');
  const outcome = await view.tasksync.push('parent');
  assert.equal(outcome.status, 'conflict');
  assert.deepEqual(plain(outcome.fields), ['status', 'depends']);

  const rebased = await view.tasksync.rebase();
  assert.deepEqual(plain(rebased.settled), ['status'], 'the status the remote already had stops being a draft');
  assert.deepEqual(plain(rebased.mine), ['depends']);
  assert.equal(view.board.patchOf('parent').status, undefined);
  assert.deepEqual(view.board.patchOf('parent').depends, ['waiter']);
  assert.equal(view.tasksync.state.conflict, null);
  assert.match(view.element('taskSyncMessage').textContent,
    /状态 远端已经是你要的值，已从草稿里去掉；依赖 仍是你的改动/);
  assert.equal(putOf(view), undefined, 're-basing reads, it does not write');

  const next = await view.tasksync.push('parent');
  assert.equal(next.status, 'pushed',
    'with the remote as the base, the same card pushes without asking twice');
  assert.equal(putOf(view).body.sha, 'sha-b');
  assert.match(written(putOf(view)), /depends: \[waiter\]/);
  assert.match(written(putOf(view)), /status: blocked/, 'the remote status is kept, not restored from the stale index');
});

test('明确覆盖 is the only path that wins a field over somebody else, and it says so', async () => {
  const view = loadBoardView({ token: 't', routes: {
    [taskRoute('parent')]: taskReply('sha-b', TASK_REMOTE_MOVED),
    [taskRoute('parent', 'PUT')]: taskPutReply('feedc0d')
  } });
  await view.tasksync.init();
  view.board.setStatus('parent', 'review');
  const outcome = await view.tasksync.push('parent');
  assert.equal(outcome.status, 'conflict', 'the draft wants a different status than the remote now has');

  const forced = await view.tasksync.overwrite();
  assert.equal(forced.status, 'pushed');
  assert.equal(putOf(view).body.sha, 'sha-b');
  assert.match(written(putOf(view)), /status: review/);
  assert.match(view.element('taskSyncMessage').textContent, /已推送 tasks\/parent\.md（提交 feedc0d）/);
  assert.equal(view.tasksync.state.conflict, null);
});

test('拖进未标注道 is a place on the canvas, not something a push is allowed to write', async () => {
  const view = loadBoardView({ token: 't', routes: { [taskRoute('parent')]: taskReply('sha-a') } });
  await view.tasksync.init();
  view.board.setStatus('parent', view.board.UNTRIAGED);
  const outcome = await view.tasksync.push('parent');
  assert.equal(outcome.status, 'refused');
  assert.match(view.element('taskSyncMessage').textContent, /「未标注」是画布上的道/);
  assert.match(view.element('taskSyncMessage').textContent, /拖回六态之一再推/);
  assert.equal(putOf(view), undefined);
  assert.equal(view.board.pushState('parent'), 'pending',
    'the draft stays, so the reader can still move it somewhere real');
});

test('a card whose file vanished and a name somebody took first are both refused, not rewritten', async () => {
  const view = loadBoardView({ token: 't', routes: {
    [taskRoute('child')]: taskMissing(),
    [taskRoute('racer')]: taskReply('sha-r', TASK_REMOTE_TEXT)
  } });
  await view.tasksync.init();
  view.board.setStatus('child', 'done');
  const gone = await view.tasksync.push('child');
  assert.equal(gone.status, 'missing');
  assert.match(view.element('taskSyncMessage').textContent, /远端已经没有 tasks\/child\.md/);
  assert.match(view.element('taskSyncMessage').textContent, /不重建整份文件/);

  view.board.create({ slug: 'Racer', title: '抢先' });
  const raced = await view.tasksync.push('racer');
  assert.equal(raced.status, 'exists');
  assert.match(view.element('taskSyncMessage').textContent, /远端已经有 tasks\/racer\.md/);
  assert.equal(putsOf(view).length, 0, 'a local card never overwrites a file somebody else made');
});

test('按顺序推送全部 lands the new card before the line that points at it', async () => {
  const view = loadBoardView({ token: 't', routes: {
    [taskRoute('new-part')]: taskMissing(),
    [taskRoute('new-part', 'PUT')]: taskPutReply('c0ffee'),
    [taskRoute('waiter')]: taskReply('sha-w', WAITER_REMOTE_TEXT),
    [taskRoute('waiter', 'PUT')]: taskPutReply('bada55')
  } });
  const app = await startTaskApp(view);
  view.board.create({ slug: 'New-Part', title: '新部件' });
  view.board.setParent('waiter', 'new-part');
  assert.deepEqual(plain(view.board.pendingSlugs()), ['waiter', 'new-part'],
    'the referrer is first in the queue, so the order has to be earned');

  const lone = await view.tasksync.push('waiter');
  assert.equal(lone.status, 'orphan');
  assert.match(lone.reason, /new-part 还只在这块画布上/);
  assert.match(view.element('taskSyncMessage').textContent, /按顺序推送全部/);
  assert.equal(putOf(view), undefined, 'a lone push never ships a dangling parent');

  await view.element('taskPushAll').events.click();
  const batch = putsOf(view);
  assert.deepEqual(batch.map(request => request.url.split('/contents/')[1]),
    ['tasks/new-part.md', 'tasks/waiter.md'], 'the file that is pointed at lands first');
  assert.equal(batch[0].body.sha, undefined, 'a create carries no sha');
  assert.match(written(batch[0]), /title: 新部件/);
  assert.equal(batch[1].body.sha, 'sha-w');
  assert.match(written(batch[1]), /parent: new-part/);
  assert.match(written(batch[1]), /被挡住的是口径/, 'the prose of the file it read survives');
  assert.deepEqual(plain(view.board.pushedSlugs()), ['waiter', 'new-part']);
  assert.equal(view.board.draftSummary().waiting, 2);
  assert.match(view.element('taskSyncMessage').textContent, /已推送 2 张卡/);
  view.render.renderTasks();
  assert.equal(view.element('taskDraftBadge').textContent, '2 张已推送 · 等索引');
  assert.match(view.element('taskCanvas').innerHTML, /新建 · 已推送/,
    'a card this browser made is now a file, and still says so');

  // The export tells the three states apart, because a pushed card is neither a
  // local draft nor a clean row.
  view.element('taskExport').onclick();
  const [header, ...records] = (await view.blobs[0].text()).replace(/^\uFEFF/, '')
    .split('\r\n').map(row => Array.from(row.matchAll(/"((?:[^"]|"")*)"/g),
      match => match[1].replace(/""/g, '"')));
  const bySlug = Object.fromEntries(records.map(row => [row[0], row]));
  assert.equal(header[15], 'pushed_at');
  assert.equal(bySlug['new-part'][14], 'pushed');
  assert.equal(bySlug.waiter[14], 'pushed');
  assert.equal(bySlug.parent[14], 'none', 'a card nobody touched is not a draft in the export either');
  assert.match(bySlug['new-part'][15], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    'the receipt carries when that commit happened, so a stale badge is checkable');
  assert.equal(bySlug.parent[15], '');
  assert.match(bySlug['new-part'][16], /\/tasks\/new-part\.md$/,
    'a card that became a file points at the file it became');
  assert.match(app.toasts.at(-1), /批量推送：2 张已推送/, 'one sentence for the whole batch');
});

test('a create whose file appeared in the meantime is refused instead of silently overwriting', async () => {
  const view = loadBoardView({ token: 't', routes: { [taskRoute('late')]: taskReply('sha-late') } });
  view.repo.adopt(view.data.state.tasks.source);
  await assert.rejects(() => view.repo.pushFile({
    path: 'tasks/late.md', content: 'x', message: 'docs(tasks): 新建 late 任务卡', baseline: null
  }), error => {
    assert.equal(error.conflict, true);
    assert.equal(error.created, true, 'a create race has to be tellable apart from an edit race');
    assert.equal(error.remoteSha, 'sha-late');
    assert.match(error.remoteText, /这一句必须活过一次推送/);
    assert.match(error.message, /而草稿是按「文件还不存在」写的/);
    return true;
  });
  assert.equal(putOf(view), undefined);
});

test('without a token the board still reads: preview works and push says what is missing', async () => {
  const view = loadBoardView({ routes: { [taskRoute('parent')]: taskReply('sha-a') } });
  await view.tasksync.init();
  view.board.setStatus('parent', 'review');
  view.render.renderTasks();
  assert.match(view.element('taskDraftList').innerHTML, /待推送/);

  assert.equal(await view.tasksync.push('parent'), null);
  assert.equal(view.requests.length, 0, 'a push without a credential asks the network for nothing');
  assert.match(view.element('taskSyncMessage').textContent,
    /请先填写 GitHub Token.*画布、清单与导出照常，草稿仍留在本机/s);

  const composed = await view.tasksync.preview('parent');
  assert.ok(composed.ok, 'reading a public source file needs no token');
  assert.equal(view.element('taskPushBox').classes.has('hidden'), false);
  assert.equal(view.element('taskPushPath').textContent, 'tasks/parent.md');
  assert.match(view.element('taskPushText').textContent, /status: review/);
  assert.match(view.element('taskPushText').textContent, /这一句必须活过一次推送/);
  assert.match(view.element('taskPushNote').textContent, /只替换 status/);
  assert.match(view.element('taskSyncMessage').textContent, /正文取自远端/);
  assert.match(view.element('taskPushEdit').getAttribute('href'),
    /^https:\/\/github\.com\/isLinXu\/model-observatory\/edit\/main\/tasks\/parent\.md$/,
    'the link is built from the coordinates the collector published');
  assert.equal(putOf(view), undefined, 'a preview never writes');

  const discardButton = { dataset: { taskDiscard: 'parent' } };
  view.element('taskDraftList').events.click({ target: {
    closest: selector => selector === 'button' ? discardButton : null } });
  assert.equal(view.board.patchOf('parent'), null);
  assert.match(view.element('taskDraftList').innerHTML, /没有待推送或待索引的卡片/);
});

test('the keyboard drives the canvas: digits change lane, l and d draw in two presses, Esc drops', async () => {
  const view = loadBoardView();
  const app = await startTaskApp(view);
  const cards = {};
  ['parent', 'child', 'waiter'].forEach(slug => {
    const card = fakeElement();
    card.dataset.taskCard = slug;
    cards[slug] = card;
  });
  const canvas = view.element('taskCanvas');
  const press = (slug, key) => {
    let defaulted = false;
    canvas.events.keydown({ key, preventDefault() { defaulted = true; },
      target: { closest: selector => selector === '[data-task-card]' ? cards[slug] : null } });
    return defaulted;
  };

  assert.equal(press('parent', '9'), false, 'a digit outside the seven lanes belongs to the page');
  assert.equal(press('parent', '3'), true);
  assert.equal(view.board.patchOf('parent').status, 'blocked');
  assert.match(app.toasts.at(-1), /状态改为「受阻」（本地草稿）/);
  assert.match(canvas.innerHTML, /data-task-card="parent" style="left:594px/);
  press('parent', '3');
  assert.match(app.toasts.at(-1), /parent 本来就在「受阻」道，状态没有改动/);

  press('parent', 'l');
  assert.match(view.element('taskCanvasSize').textContent, /依赖线：从 parent 出发/);
  press('waiter', 'l');
  assert.deepEqual(view.board.patchOf('parent').depends, ['waiter']);
  assert.match(app.toasts.at(-1), /已连上：parent 等待 waiter/);

  // A different key mid-gesture abandons the first line instead of crossing it.
  press('child', 'd');
  press('parent', 'l');
  assert.equal(view.board.patchOf('child'), null, 'a 拆解 line does not become a 依赖 line');
  assert.match(view.element('taskCanvasSize').textContent, /依赖线：从 parent 出发/,
    'the abandoned line is replaced by the one asked for next, not left half drawn');

  // Escape abandons it too, and names the card it came from.
  press('waiter', 'd');
  press('child', 'Escape');
  assert.match(view.element('taskCanvasSize').textContent, /已取消：waiter 的线没有连到任何卡/);
  assert.equal(view.board.patchOf('waiter'), null, 'the cancelled 拆解 wrote nothing');

  press('waiter', 'd');
  press('child', 'd');
  assert.equal(view.board.patchOf('waiter').parent, 'child');
  assert.match(app.toasts.at(-1), /已拆解：waiter 现在是 child 的子任务/);

  // With no line pending, Escape is the page's key again.
  assert.equal(press('child', 'Escape'), false);
});

// --- Paper lists: boundaries, degradation and byte budgets ------------------

// A row in the shape the collector publishes: snake_case, with the two counts
// that must never be merged sitting in their own fields.
function awesomeRowFixture(id, extra = {}) {
  return {
    id, kind: 'markdown-table', upstream: false, status: 'ok', error: null,
    captured_at: '2026-11-02T14:49:06Z', last_attempt_at: '2026-11-02T14:49:06Z',
    measured: { entries: 10, with_arxiv: 8, with_code: 3, with_date: 6, with_venue: 1,
      unique_ids: 10, sections: 2, skipped: 1,
      files: [{ path: 'README.md', bytes: 4096, lines: 120, rows: 10 }] },
    self_reported: { file: 'README.md', entries: 12, values: [12] },
    cadence: { status: 'ok', last_file_commit_at: '2026-11-01T04:00:00Z', author: 'isLinXu',
      is_bot: false, cadence: 'daily', stale_days: 1, stalled: false, commits_seen: 3 },
    diff: { baseline: false, added: 2, removed: 0, held: 10 },
    sample: [{ id: 'arxiv:2611.00001', title: 'A paper', url: 'https://arxiv.org/abs/2611.00001',
      arxiv_id: '2611.00001', published: '2026-11', venue: null, section: '最新', is_new: true }],
    files: [{ path: 'README.md', bytes: 4096 }],
    ...extra
  };
}

function awesomeSnapshotFixture(repos, extra = {}) {
  return {
    schema_version: 1,
    source: { id: 'awesome', budget: { sample_limit: 40, ledger_id_limit: 4000 } },
    status: 'ok', captured_at: '2026-11-02T14:49:06Z', last_attempt_at: '2026-11-02T14:49:06Z',
    error: null, warnings: [], fetches: { files: 3, bytes: 2048 },
    sizes: { payload_bytes: 40000, payload_budget_bytes: 122880,
      ledger_bytes: 9000, ledger_budget_bytes: 204800 },
    summary: { repos: repos.length, repos_ok: repos.filter(row => row.status === 'ok').length,
      repos_stale: repos.filter(row => row.status === 'stale').length,
      entries_measured: 10, entries_upstream: 0, entries_by_kind: { 'markdown-table': 10 },
      with_arxiv: 8, with_code: 3, added: 2, removed: 0, stalled: 0, self_reported_repos: 1 },
    changes: { added: [], removed: [], grown: [], shrunk: [], status: [] },
    repos,
    ...extra
  };
}

test('what a list claims about itself never joins what we counted, and an upstream row stays on its own side', () => {
  const data = loadData();
  data.state.awesome = awesomeSnapshotFixture([
    awesomeRowFixture('isLinXu/own', { self_reported: { file: 'README.md', entries: 999, values: [999] } }),
    awesomeRowFixture('BradyFU/theirs', { upstream: true, self_reported: null,
      measured: { entries: 30, with_arxiv: 30, unique_ids: 30 } })
  ], { summary: { repos: 2, repos_ok: 2, entries_measured: 10, entries_upstream: 30,
    entries_by_kind: { 'markdown-table': 10 }, added: 2, removed: 0, stalled: 0,
    self_reported_repos: 1 } });
  const stats = data.awesomeStats();
  assert.equal(stats.measured, 10, 'the headline is our own count, not ours plus the upstream list');
  assert.equal(stats.upstream, 30, 'the upstream count is published next to it, never inside it');
  assert.equal(stats.selfReportedRepos, 1);
  assert.equal(stats.upstreamRepos, 1);
  const view = loadModelView(data);
  view.render.renderAwesome();
  assert.equal(view.element('statAwesomeMeasured').textContent, '10');
  assert.equal(view.element('statAwesomeMeasuredSub').textContent, 'Markdown 表格 10',
    'the caption breaks our own count down by list kind, and adds nothing else');
  assert.match(view.element('awesomeStatus').textContent, /实测 10 条（自有） \+ 30 条（上游）/);
  assert.match(view.element('awesomeCards').innerHTML, /自报<\/span><b>999<\/b>/,
    'the claim is shown, labelled as the repository speaking about itself');
  assert.ok(!/999/.test(view.element('statAwesomeMeasured').textContent +
    view.element('statAwesomeMeasuredSub').textContent), 'no self-reported number reaches a total');
});

test('a row that lost its cadence, badge or sample still gets a card, and an unknown status degrades to 未读到', () => {
  const data = loadData();
  data.state.awesome = awesomeSnapshotFixture([
    { id: 'isLinXu/bare', kind: 'markdown-table', status: 'ok' },
    awesomeRowFixture('isLinXu/whole', { status: 'stale' }),
    awesomeRowFixture('isLinXu/weird', { status: 'exploded' })
  ], { status: 'partial' });
  const rows = data.awesomeRows();
  assert.deepEqual(plain(rows.map(row => row.status)), ['ok', 'stale', 'unavailable']);
  assert.equal(rows[0].cadence.state, 'unknown');
  assert.equal(rows[0].selfReported, null);
  assert.deepEqual(plain(rows[0].sample), []);
  assert.equal(rows[0].measured.entries, null, 'an absent count stays absent instead of becoming a zero');
  assert.equal(rows[0].diff.baseline, false);
  const view = loadModelView(data);
  view.render.renderAwesome();
  assert.match(view.element('awesomeStatus').textContent, /部分清单本次没读到/);
  assert.match(view.element('awesomeCards').innerHTML, /isLinXu\/bare/);
  assert.match(view.element('awesomeCards').innerHTML, /isLinXu\/weird/);
  assert.match(view.element('awesomeNotes').innerHTML, /沿用上次/);
  assert.deepEqual(plain(data.awesomeFlow().map(entry => entry.repoId)).sort(),
    ['isLinXu/weird', 'isLinXu/whole'].sort(), 'a row that lost its sample adds no line to the flow');
});

test('a snapshot the board cannot read leaves the other panels alone and says so in its own section', async () => {
  const data = loadData(async url => {
    if (url.includes('awesome.json')) throw new TypeError('Failed to fetch');
    return jsonResponse({ schema_version: 1, source: { id: 'other' }, status: 'ok' });
  }, { TypeError });
  await data.loadAwesome();
  assert.equal(data.state.awesome.status, 'unavailable');
  assert.deepEqual(plain(data.awesomeRows()), []);
  assert.equal(data.awesomeStats().available, false);
  const view = loadModelView(data);
  view.render.renderAwesome();
  assert.match(view.element('awesomeStatus').textContent, /清单跟踪数据暂不可用/);
  assert.match(view.element('awesomeCards').innerHTML, /快照还没读到/);
  assert.ok(view.element('awesomeExport').disabled, 'an empty board has nothing to export');

  // A snapshot that arrives later is kept: a second failure does not wipe a board
  // the reader already trusted, it only says the read failed.
  data.state.awesome = awesomeSnapshotFixture([awesomeRowFixture('isLinXu/own')]);
  const payload = data.state.awesome;
  await assert.rejects(() => data.refreshAwesomeSnapshot(), /Failed to fetch|其他/);
  assert.equal(data.state.awesome, payload, 'a failed refresh keeps the last good snapshot');
  assert.match(data.state.awesomeRefreshError, /Failed to fetch/);
});

test('a snapshot from another source is refused rather than rendered as paper lists', async () => {
  const data = loadData(async () => jsonResponse(
    awesomeSnapshotFixture([awesomeRowFixture('isLinXu/own')], { source: { id: 'github' } })));
  await data.loadAwesome();
  assert.equal(data.state.awesome.status, 'unavailable',
    'a payload for a different board never borrows this section\'s markup');
  assert.match(data.state.awesome.error, /不兼容|格式/);
});

test('cards escape what a list says and never turn a non-http link into an anchor', () => {
  const data = loadData();
  const hostile = awesomeRowFixture('isLinXu/evil', {
    measured: { entries: 1, note: '![badge](https://evil.test/track.png)',
      files: [{ path: '"><script>alert(1)</script>', bytes: 1 }] },
    self_reported: { file: '"><b>x</b>', entries: null, values: [] },
    cadence: { status: 'ok', author: '<img src=x onerror=alert(1)>', cadence: 'daily', stale_days: 0 },
    diff: { baseline: false, added: 0, removed: 0, held: 1 },
    sample: [{ id: 'x', title: '<script>alert(1)</script>=SUM(1,2)',
      url: 'javascript:alert(1)', arxiv_id: null, published: null, venue: null,
      section: '"><u>s</u>', is_new: false }],
    topics: [{ topic: '<i>t</i>', status: 'ok', latest_month: '2026-11' }]
  });
  data.state.awesome = awesomeSnapshotFixture([hostile]);
  const view = loadModelView(data);
  data.state.awesomeOpen = 'isLinXu/evil';
  view.render.renderAwesome();
  const cards = view.element('awesomeCards').innerHTML + view.element('awesomeNotes').innerHTML;
  data.state.awesomeView = 'flow';
  view.render.renderAwesome();
  const flow = view.element('awesomeFlowRows').innerHTML;
  for (const [name, markup] of [['cards', cards], ['flow', flow]]) {
    assert.ok(!/<script/i.test(markup), `${name}: no markup survives from a list into the page`);
    assert.ok(!/href="javascript:/i.test(markup), `${name}: a javascript url is never made clickable`);
    assert.ok(!/href="https:\/\/evil\.test/i.test(markup), `${name}: a badge url is not turned into a link`);
    // text a reader can see may still describe an attack; what matters is that it
    // sits inside escaped text, never inside a tag or an attribute.
    assert.ok(!/onerror=/i.test(markup.replace(/&lt;[\s\S]*?&gt;/g, '')),
      `${name}: an event handler stays where esc() put it`);
  }
  assert.match(cards, /&lt;script&gt;/);
  assert.match(flow, /&lt;script&gt;/);
  const rows = data.awesomeRows();
  assert.equal(rows[0].sample[0].url, null, 'the allowlist rejects it before the renderer sees it');
  assert.equal(data.awesomeFlow()[0].url, null);
});

test('the reader gets one snapshot per page, and the button re-reads the published file without collecting', async () => {
  const observers = [];
  class IntersectionObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.disconnected = (this.disconnected || 0) + 1; }
  }
  const view = loadBoardView({ awesome: awesomeSnapshotFixture([awesomeRowFixture('isLinXu/own')]) });
  const app = await startAwesomeApp(view, { IntersectionObserver });
  const awesome = observers.find(observer => observer.target === view.element('awesome'));
  assert.ok(awesome, 'the paper lists are watched, not downloaded at boot');
  assert.equal(view.requests.filter(request => request.url.includes('/data/awesome.json')).length, 0);

  awesome.callback([{ isIntersecting: true }]);
  await nextTurn();
  await nextTurn();
  assert.equal(view.requests.filter(request => request.url.includes('/data/awesome.json')).length, 1);
  assert.equal(awesome.disconnected, 1);
  assert.match(view.element('awesomeCheckedAt').textContent,
    /最近成功读取快照 .*采集由每日工作流完成/);
  assert.match(view.element('awesomeCheckedAt').textContent, /快照 39 KB／预算 120 KB/,
    'the size the collector reported for the file the reader just downloaded');
  assert.equal(view.element('awesomeExport').disabled, false);

  awesome.callback([{ isIntersecting: true }]);
  await nextTurn();
  assert.equal(view.requests.filter(request => request.url.includes('/data/awesome.json')).length, 1,
    'a second entry into the section is not a second download');
  assert.equal(app.toasts.length, 0, 'an entry read stays quiet');

  view.element('awesomeRefresh').events.click();
  await nextTurn();
  await nextTurn();
  assert.equal(view.requests.filter(request => request.url.includes('/data/awesome.json')).length, 2);
  assert.match(app.toasts.at(-1), /刷新只读已发布文件，不会去抓别人的仓库/);
  assert.equal(view.element('awesomeRefresh').textContent, '刷新已发布快照');
});

test('a snapshot that reports no sizes still renders: the budget line is the only thing lost', async () => {
  const snapshot = awesomeSnapshotFixture([awesomeRowFixture('isLinXu/own')]);
  delete snapshot.sizes;
  delete snapshot.fetches;
  const view = loadBoardView({ awesome: snapshot });
  const app = await startAwesomeApp(view);
  await view.data.loadAwesome();
  view.render.renderAwesome();
  assert.match(view.element('awesomeCheckedAt').textContent, /采集由每日工作流完成$/);
  assert.ok(!/KB/.test(view.element('awesomeCheckedAt').textContent));
  assert.equal(app.toasts.length, 0);
});

test('the list export keeps the two counts in their own columns and guards a title that looks like a formula', async () => {
  const view = loadBoardView({ awesome: awesomeSnapshotFixture([
    awesomeRowFixture('isLinXu/own', {
      self_reported: { file: 'README.md', entries: 999, values: [999] },
      sample: [{ id: 'arxiv:2611.00002', title: '=SUM(1,2)', url: 'javascript:alert(1)',
        arxiv_id: '2611.00002', published: '2026-11', venue: 'CVPR', section: '最新', is_new: true }]
    }),
    awesomeRowFixture('BradyFU/theirs', { upstream: true, self_reported: null,
      measured: { entries: 30, with_arxiv: 30, unique_ids: 30 } })
  ]) });
  await startAwesomeApp(view);
  await view.data.loadAwesome();
  view.element('awesomeExport').onclick();
  const text = await view.blobs[0].text();
  const [header, ...records] = text.replace(/^﻿/, '').split('\r\n').map(row =>
    Array.from(row.matchAll(/"((?:[^"]|"")*)"/g), match => match[1].replace(/""/g, '"')));
  assert.equal(header.length, 20);
  assert.equal(header[11], 'measured_entries');
  assert.equal(header[12], 'self_reported_entries',
    'two columns because two numbers: our count and the list\'s own claim');
  const own = records.find(row => row[0] === 'isLinXu/own');
  const theirs = records.find(row => row[0] === 'BradyFU/theirs');
  assert.equal(own[4], "'=SUM(1,2)", 'a formula stays a string when the csv is opened');
  assert.equal(own[5], '', 'a rejected url exports as nothing, not as a guess');
  assert.equal(own[11], '10');
  assert.equal(own[12], '999');
  assert.equal(theirs[1], 'upstream');
  assert.equal(theirs[12], '', 'an upstream list with no badge exports an empty cell, not a zero');
  assert.equal(theirs[14], 'yes', 'this row was read today, not carried over');
  assert.equal(theirs[17], '2026-11-02T14:49:06Z', 'every row carries the snapshot it came from');
  assert.equal(theirs[18], 'ok', 'and the run that produced it: a partial export says partial');
  assert.equal(theirs[19], '2026-11-02T14:49:06Z');
  assert.equal(view.anchors.at(-1).download, 'paper-lists-2026-11-02.csv');
});

test('a baseline reads 基线, a one-off report reads 不更新, and only a compared row reads numbers', () => {
  const data = loadData();
  data.state.awesome = awesomeSnapshotFixture([
    awesomeRowFixture('isLinXu/new', { diff: { baseline: true, added: 0, removed: 0, held: 10,
      note: '首次读到这份清单：本次只建立基线，明日起的新增与移出才是可信的变化量。' } }),
    awesomeRowFixture('isLinXu/report', { kind: 'report', diff: { baseline: false, added: null,
      removed: null, held: 66, note: '一次性调研报告，没有更新流' } }),
    awesomeRowFixture('isLinXu/compared', { diff: { baseline: false, added: 4, removed: 1, held: 10 } })
  ]);
  const view = loadModelView(data);
  view.render.renderAwesome();
  const cards = view.element('awesomeCards').innerHTML;
  assert.match(cards, /新增 \/ 移出<\/span><b>基线<\/b>/,
    'a first read is not reported as "zero changes"');
  assert.match(cards, /新增 \/ 移出<\/span><b>不更新<\/b>/,
    'a report has no change stream to claim');
  assert.match(cards, /新增 \/ 移出<\/span><b>\+4 \/ −1<\/b>/);
  assert.match(cards, /awesome-flag">基线</);
  assert.match(view.element('awesomeStatus').textContent, /1 个清单还在建立基线/);
});

test('a list this run never fetched keeps its numbers, and says it was not read', () => {
  const data = loadData();
  data.state.awesome = awesomeSnapshotFixture([
    awesomeRowFixture('isLinXu/fetched'),
    awesomeRowFixture('isLinXu/skipped', {
      status: 'stale', not_attempted: true, captured_at: '2026-11-01T12:00:00Z',
      diff: { baseline: false, added: null, removed: null, held: 10, truncated: true }
    })
  ], { status: 'partial' });
  const view = loadModelView(data);
  data.state.awesomeView = 'repos';
  view.render.renderAwesome();
  const cards = view.element('awesomeCards').innerHTML;
  assert.match(cards, /awesome-state">本次未读取</, 'the card does not claim a read it did not do');
  assert.match(cards, /本次没有读取这份清单/);
  assert.match(cards, /新增 \/ 移出<\/span><b>不可比<\/b>/,
    'a ledger cut by the cap compares with nothing, so no number is published');
  assert.match(view.element('statAwesomeReposSub').textContent, /1 个本次没抓取/);
  assert.match(view.element('statAwesomeDeltaSub').textContent, /1 个清单增删不可比/);
  data.state.awesomeView = 'flow';
  view.render.renderAwesome();
  assert.match(view.element('awesomeFlowRows').innerHTML,
    /本次未读取 · 2026-11-01 12:00/, 'a carried sample is dated in the flow too');
});

test('按停更天数 puts the coldest list first and a list with no file history last', () => {
  const data = loadData();
  data.state.awesome = awesomeSnapshotFixture([
    awesomeRowFixture('isLinXu/fresh', { cadence: { status: 'ok', cadence: 'daily', stale_days: 0 } }),
    awesomeRowFixture('isLinXu/cold', { cadence: { status: 'ok', cadence: 'weekly', stale_days: 241,
      stalled: true } }),
    awesomeRowFixture('isLinXu/unknown', { cadence: { status: 'unknown' } }),
    awesomeRowFixture('isLinXu/warm', { cadence: { status: 'ok', cadence: 'weekly', stale_days: 4 } }),
    awesomeRowFixture('isLinXu/reused', { status: 'stale',
      cadence: { status: 'ok', cadence: 'weekly', stale_days: 60 } })
  ], { status: 'partial' });
  data.state.awesomeSort = 'stale';
  assert.deepEqual(plain(data.awesomeFilteredRepos().map(row => row.id)),
    ['isLinXu/cold', 'isLinXu/reused', 'isLinXu/warm', 'isLinXu/fresh', 'isLinXu/unknown'],
    'an unreadable file history is a gap, not the freshest list on the board');
  data.state.awesomeAttention = 'stopped';
  assert.deepEqual(plain(data.awesomeFilteredRepos().map(row => row.id)), ['isLinXu/cold'],
    'the 停更 filter asks the file, and only a stalled file answers');
  data.state.awesomeAttention = 'stale';
  assert.deepEqual(plain(data.awesomeFilteredRepos().map(row => row.id)), ['isLinXu/reused'],
    'the 过期 filter asks the row: 60 days on a file nobody stalled is not a stale snapshot');
});

test('a reader who types the words without the hyphens still finds the list, in cards and in the flow', () => {
  const data = loadData();
  data.state.awesome = awesomeSnapshotFixture([
    awesomeRowFixture('isLinXu/awesome-visual-reasoning', { kind: 'machine-json',
      sample: [{ id: 'arxiv:2611.00009', title: 'Reasoning about pixels', url: null,
        arxiv_id: '2611.00009', published: '2026-11', venue: null, section: null, is_new: false }] }),
    awesomeRowFixture('isLinXu/paper-list', { kind: 'topic-archives',
      topics: [{ topic: 'World_Models', status: 'ok', latest_month: '2026-10' }] })
  ]);
  data.state.awesomeSearch = 'visual reasoning';
  assert.deepEqual(plain(data.awesomeFilteredRepos().map(row => row.id)),
    ['isLinXu/awesome-visual-reasoning']);
  assert.deepEqual(plain(data.awesomeFlow().map(row => row.repoId)),
    ['isLinXu/awesome-visual-reasoning']);
  data.state.awesomeSearch = 'paper list';
  assert.deepEqual(plain(data.awesomeFilteredRepos().map(row => row.id)), ['isLinXu/paper-list'],
    'a slug typed as two words is still the same list');
  data.state.awesomeSearch = 'world_models';
  assert.deepEqual(plain(data.awesomeFilteredRepos().map(row => row.id)), ['isLinXu/paper-list'],
    'a topic the repository names is searchable, underscores and all');
  data.state.awesomeSearch = 'world-models';
  assert.deepEqual(plain(data.awesomeFilteredRepos().map(row => row.id)), ['isLinXu/paper-list'],
    'the same words with a hyphen are the same search, not an empty panel');
  data.state.awesomeSearch = 'reasoning-about';
  assert.equal(data.awesomeFlow().length, 1,
    'a title hit survives the reader typing a hyphen where the title has a space');
  data.state.awesomeSearch = 'reasoning';
  assert.equal(data.awesomeFlow().length, 1, 'a flow row that matches only its title still counts as found');
  data.state.awesomeSearch = 'no such list';
  assert.equal(data.awesomeFilteredRepos().length, 0);
  assert.equal(data.awesomeFlow().length, 0);
});

test('the attention filter names the reasons a card needs a look and keeps them apart', () => {
  const data = loadData();
  const rows = [
    awesomeRowFixture('isLinXu/baseline', { diff: { baseline: true, added: 0, removed: 0, held: 10 } }),
    awesomeRowFixture('isLinXu/truncated', { diff: { baseline: false, added: 1, removed: 0,
      held: 4000, truncated: true } }),
    awesomeRowFixture('isLinXu/rolling', { diff: { baseline: false, added: 0, removed: 3, held: 10,
      rolling_window: true } }),
    awesomeRowFixture('isLinXu/mismatch', { self_reported: { file: 'README.md', entries: 400, values: [400] } }),
    awesomeRowFixture('isLinXu/capped', {
      measured: { entries: 60, byte_capped: true, unique_ids: 60 },
      self_reported: null }),
    awesomeRowFixture('isLinXu/report', { kind: 'report',
      measured: { entries: 60, unlinked_rows: 21, skipped: 0, unique_ids: 60,
        note: '该文件是一次性报告：无外链的行只在认得出会议或日期时才计入' },
      self_reported: { file: 'README.md', entries: 60, values: [60] } }),
    awesomeRowFixture('isLinXu/quiet', { self_reported: { file: 'README.md', entries: 10, values: [10] } })
  ];
  data.state.awesome = awesomeSnapshotFixture(rows);
  const flagged = Object.fromEntries(rows.map(row =>
    [row.id, plain(data.awesomeAttention(data.awesomeRows().find(entered => entered.id === row.id)))]));
  assert.match(flagged['isLinXu/baseline'].join(' '), /首次基线/);
  assert.match(flagged['isLinXu/truncated'].join(' '), /下限/);
  assert.match(flagged['isLinXu/rolling'].join(' '), /滚动窗口/);
  assert.match(flagged['isLinXu/mismatch'].join(' '), /自报 400 条与实测 10 条不一致/);
  assert.match(flagged['isLinXu/capped'].join(' '), /超过单文件上限/);
  assert.deepEqual(flagged['isLinXu/report'], [],
    '报告里按会议引用的行已经计入条目数，它是一句口径说明，不是待办');
  assert.deepEqual(flagged['isLinXu/quiet'], [], 'a list that agrees with itself asks for nothing');
  data.state.awesomeAttention = 'attention';
  assert.deepEqual(plain(data.awesomeFilteredRepos().map(row => row.id)).sort(), [
    'isLinXu/baseline', 'isLinXu/capped', 'isLinXu/mismatch', 'isLinXu/rolling', 'isLinXu/truncated'
  ].sort());
});

test('the ledger cap and the sample are said out loud instead of being quietly exceeded', () => {
  const data = loadData();
  data.state.awesome = awesomeSnapshotFixture([
    awesomeRowFixture('isLinXu/huge', { sample: Array.from({ length: 40 }, (unused, index) => ({
      id: `arxiv:2611.000${index}`, title: `Paper ${index}`, url: 'https://arxiv.org/abs/2611.00001',
      arxiv_id: '2611.00001', published: '2026-11', venue: null, section: null, is_new: index < 3
    })) })
  ], { summary: { repos: 1, repos_ok: 1, entries_measured: 10, added: 3, removed: 0, stalled: 0,
    self_reported_repos: 1, entries_by_kind: { 'markdown-table': 10 } } });
  const view = loadModelView(data);
  view.render.renderAwesome();
  assert.match(view.element('statAwesomeDeltaSub').textContent,
    /台账上限 4,000 个 id／清单/, 'the budget is stated in the panel, not only in the code');
  data.state.awesomeOpen = 'isLinXu/huge';
  view.render.renderAwesomeCards();
  const detail = view.element('awesomeCards').innerHTML;
  assert.equal((detail.match(/<li class="awesome-entry/g) || []).length, 40,
    'the detail opens the capped view, and says it is one');
  assert.match(detail, /最近条目样本：上限来自采集器预算/,
    'the sample is labelled as a window, not as the list');
});

test('the daily history file has a reader, and it says when there is too little of it', async () => {
  const snapshot = awesomeSnapshotFixture([awesomeRowFixture('isLinXu/own')]);
  const day = (offset, repos, measured, upstream) => ({
    date: `2026-10-2${offset}`, captured_at: `2026-10-2${offset}T14:49:06Z`,
    repos, tracked: 6, entries_measured: measured, entries_upstream: upstream,
    added: 0, removed: 0, stalled: 0
  });
  // the shape loadAwesomeHistory writes into state, for the sparse branches
  // that re-render without a second fetch
  const stateDay = (date, measured, upstream) => ({
    date, repos: 6, tracked: 6, entriesMeasured: measured, entriesUpstream: upstream,
    added: 0, removed: 0, stalled: 0, partial: false
  });
  const view = loadBoardView({
    awesome: snapshot,
    history: {
      schema_version: 1, source: { id: 'awesome' },
      retention: { daily_days: 120, monthly_points: 24 },
      // out of order on purpose: the file is drawn as a series, not as a log
      snapshots: [day(3, 6, 4390, 512), day(1, 6, 4300, 500), day(2, 3, 4360, 510)]
    }
  });
  await startAwesomeApp(view);
  await view.data.loadAwesome();
  const trend = view.data.awesomeTrend();
  assert.deepEqual(plain(trend.measured.map(point => point.date)),
    ['2026-10-21', '2026-10-22', '2026-10-23'], 'the series is sorted by day, not by file order');
  assert.equal(trend.enough, true);
  assert.equal(trend.netChange, 90, 'the change is between the two ends, not a sum of days');
  assert.equal(trend.partialDays, 1, 'a day that read 3 of 6 lists carried numbers');
  assert.equal(trend.readyOn, null, 'three points is already enough to draw a slope');
  view.render.renderAwesome();
  assert.match(view.element('awesomeTrendNote').textContent, /净变化 \+90/);
  assert.match(view.element('awesomeTrendNote').textContent, /沿用的/,
    'a flat stretch is called what it is: a day we did not read');
  assert.match(view.element('awesomeTrendNote').textContent, /120 天逐日/);

  view.data.state.awesomeHistory = [stateDay('2026-10-23', 4390, 512)];
  view.render.renderAwesomeTrend();
  assert.match(view.element('awesomeTrendNote').textContent, /样本太少，看不出趋势/,
    'two points would draw a straight line over whatever happened between them');
  assert.equal(view.data.awesomeTrend().readyOn, '2026-10-25',
    'the last recorded day plus the two runs still missing, at one per day');
  assert.match(view.element('awesomeTrendNote').textContent, /2026-10-25 才够 3 个点/,
    'the reader is told which day to come back to, not just "later"');
  view.data.state.awesomeHistory = [stateDay('2026-10-21', 4300, 500),
    stateDay('2026-10-23', 4390, 512)];
  assert.equal(view.data.awesomeTrend().readyOn, '2026-10-24',
    'the gap counts recorded days, not the calendar between them: the 22nd is still missing');
  assert.equal(view.element('awesomeTrendMetric').value, 'measured');
  view.data.state.awesomeTrendMetric = 'readable';
  view.render.renderAwesomeTrend();
  assert.match(view.element('awesomeTrendLabel').textContent, /当天真正读到的清单数/);
});

test('a history file the board cannot read costs the trend and nothing else', async () => {
  const view = loadBoardView({ awesome: awesomeSnapshotFixture([awesomeRowFixture('isLinXu/own')]),
    history: null });
  const app = await startAwesomeApp(view);
  await view.data.loadAwesome();
  view.render.renderAwesome();
  assert.equal(view.data.state.awesomeHistory, null);
  assert.match(view.element('awesomeTrendNote').textContent, /历史读取失败/);
  assert.match(view.element('awesomeCards').innerHTML, /isLinXu\/own/,
    'the snapshot the reader came for still renders');
  assert.match(view.element('awesomeStatus').textContent, /实测 10 条（自有）/);
  assert.equal(app.toasts.length, 0, 'a missing side file is not a toast');
});

test('one list can be read on its own, and its registry entry links back instead of copying over',
  async () => {
    const view = loadBoardView({
      awesome: awesomeSnapshotFixture([
        awesomeRowFixture('isLinXu/own'), awesomeRowFixture('isLinXu/other')
      ]),
      entities: [entityEntry('awesome-own', { links: [entityLink('gh_repo', 'isLinXu/own')] })]
    });
    const app = await startAwesomeApp(view);
    await view.data.loadAwesome();
    const data = view.data;
    view.render.renderAwesome();

    const click = (selector, dataset) => view.element('awesomeCards').events.click({
      target: { closest: asked => (asked === selector ? { dataset } : null) }
    });

    data.state.awesomeOpen = 'isLinXu/own';
    view.render.renderAwesomeCards();
    const detail = view.element('awesomeCards').innerHTML;
    assert.match(detail, /实体注册表<\/b>：1 条登记了这份仓库/, 'the card asks the registry who is in');
    assert.match(detail, /awesome-own/, 'and names the entry, not a copied number');
    const registryLine = detail.slice(detail.indexOf('实体注册表</b>'));
    assert.ok(!/实测/.test(registryLine.slice(0, registryLine.indexOf('</div>'))),
      'the registry line names entries and states nothing about counts: the numbers stay on this board');

    click('[data-awesome-registry]', { awesomeRegistry: 'gh_repo:isLinXu/own' });
    assert.equal(data.state.entityObject, 'gh_repo:isLinXu/own',
      'the chip asks the reverse question in the registry board');
    assert.match(app.toasts.at(-1), /关系归那个栏目/);
    // The toast claims the registry answered, so the page has to carry the reader
    // to it: `entities` is the section id index.html gives that board, and the
    // harness reports prefers-reduced-motion, which asks for an instant jump.
    const jumped = view.element('entities').scrolled;
    assert.equal(jumped.length, 1, 'the chip scrolls the entity registry section into view');
    assert.equal(jumped[0].behavior, 'auto');

    click('[data-awesome-focus]', { awesomeFocus: 'isLinXu/own' });
    assert.equal(data.state.awesomeFocus, 'isLinXu/own');
    assert.deepEqual(plain(data.awesomeFilteredRepos().map(row => row.id)), ['isLinXu/own']);
    assert.deepEqual(plain([...new Set(data.awesomeFlow().map(entry => entry.repoId))]), ['isLinXu/own'],
      'the flow narrows to the same list the cards did');
    assert.equal(view.element('awesomeFocusNote').hidden, false);
    assert.match(view.element('awesomeFocusNote').textContent, /只看 isLinXu\/own/);
    assert.equal(view.element('awesomeFilterReset').disabled, false,
      'a focus is a filter, so reset has to be reachable');

    click('[data-awesome-focus]', { awesomeFocus: 'isLinXu/own' });
    assert.equal(data.state.awesomeFocus, null, 'the same button clears it');
    assert.equal(view.element('awesomeFocusNote').hidden, true);

    click('[data-awesome-focus]', { awesomeFocus: 'isLinXu/other' });
    view.element('awesomeFocusNote').events.click();
    assert.equal(data.state.awesomeFocus, null, 'the toolbar chip clears it too');

    data.state.awesomeOpen = 'isLinXu/other';
    view.render.renderAwesomeCards();
    assert.match(view.element('awesomeCards').innerHTML, /还没有条目登记这份仓库/,
      'a list nobody registered says so instead of looking like a read failure');
  });

test('a list that left links out of its own paper tables says its count is a floor', () => {
  const data = loadData();
  const skipped = (extra = {}) => ({
    entries: 8, with_arxiv: 4, unique_ids: 8, sections: 3, skipped: 12, skipped_no_link: 12,
    ...extra
  });
  data.state.awesome = awesomeSnapshotFixture([
    awesomeRowFixture('isLinXu/blank-links', { measured: skipped({ paper_table_rows_without_link: 5 }) }),
    awesomeRowFixture('isLinXu/tables-are-full', { measured: skipped({ paper_table_rows_without_link: 0 }) }),
    // A snapshot written before this number was measured: absence is not a zero.
    awesomeRowFixture('isLinXu/older-run', { measured: skipped() })
  ]);
  const rows = plain(data.awesomeRows());
  assert.deepEqual(rows.map(row => row.measured.paperTableRowsWithoutLink), [5, 0, null],
    'the subset is read as published, and a number nobody counted is not a zero');

  const notes = rows.map(repo => plain(data.awesomeAttention(repo)).join('\n'));
  assert.match(notes[0], /论文表里有 5 行没给链接/);
  assert.match(notes[0], /实测条目数是下限/);
  assert.ok(!notes[1].includes('下限'), 'a measured zero says nothing is missing');
  assert.ok(!notes[2].includes('下限'), 'and an unmeasured snapshot may not claim either way');

  const view = loadModelView(data);
  const detail = id => {
    data.state.awesomeOpen = id;
    view.render.renderAwesome();
    return view.element('awesomeCards').innerHTML;
  };
  assert.match(detail('isLinXu/blank-links'),
    /有 5 行，所在的表头点名了链接列[\s\S]*把链接留空，所以这里的实测条目数是下限/);
  assert.match(detail('isLinXu/tables-are-full'),
    /没有一个落在点名了链接列的表里，去掉的是导航表与榜单，不是论文/);
  const silent = detail('isLinXu/older-run');
  assert.ok(!silent.includes('点名了链接列'),
    'the skipped line still explains the rule, but it cannot speak for a number we never read');
  assert.match(silent, /导航表与榜单行在这里被排除/);
});

test('a row of the paper flow becomes a card on the canvas, and carries only what the row said',
  async () => {
    const view = loadBoardView({ awesome: awesomeSnapshotFixture([
      awesomeRowFixture('isLinXu/own'),
      awesomeRowFixture('isLinXu/other', {
        measured: { entries: 42, with_arxiv: 42, unique_ids: 42 },
        self_reported: { file: 'README.md', entries: 400, values: [400] },
        sample: [{ id: 'title:Another paper', title: 'Another paper', url: null,
          arxiv_id: null, published: '2026-12', venue: null, section: null, is_new: false }]
      }),
      awesomeRowFixture('isLinXu/anon', {
        sample: [{ id: '', title: 'A row with no id at all', url: null, arxiv_id: null,
          published: null, venue: null, section: null, is_new: false }]
      })
    ]) });
    // Both sections stay real: the flow markup holds the button, the canvas shows
    // the card it made, and the claim under test is exactly that the two agree.
    const app = await startApp(view, ['renderAwesome', 'renderTask']);
    await view.data.loadAwesome();
    const data = view.data;
    data.state.awesomeView = 'flow';
    view.render.renderAwesome();

    const flow = view.element('awesomeFlowRows').innerHTML;
    assert.deepEqual(plain([...flow.matchAll(/data-awesome-card="(\d+)"/g)].map(match => match[1])),
      ['0', '1', '2'], 'one button per row, numbered by the place the reader sees it in');

    const click = index => view.element('awesomeFlowRows').events.click({
      target: { closest: asked => (asked === '[data-awesome-card]'
        ? { dataset: { awesomeCard: String(index) } } : null) }
    });

    view.element('awesomeFlowRows').events.click({ target: { closest: () => null } });
    assert.deepEqual(plain(view.board.draftSlugs()), [],
      'a click that landed on the row instead of the button makes nothing');

    const withId = data.awesomeFlow().findIndex(entry => entry.arxivId === '2611.00001');
    click(withId);
    assert.deepEqual(plain(view.board.draftSlugs()), ['paper-2611-00001'],
      'the file name follows the arXiv id, so the same paper in two lists is one card');
    assert.equal(view.board.findRow('paper-2611-00001').status, 'proposal',
      'a row a list vouched for is a proposal, not something the reader already did');
    assert.match(view.element('taskCanvas').innerHTML, /data-task-card="paper-2611-00001"/,
      'the canvas the toast points at really does hold the new card');
    assert.match(app.toasts.at(-1), /它还在这台浏览器里/);
    assert.match(app.toasts.at(-1), /推送才进仓库/);

    click(withId);
    assert.match(app.toasts.at(-1), /paper-2611-00001 已经在看板上/);
    assert.equal(view.board.draftSlugs().length, 1, 'a second click is refused, not a second card');

    // The composed file is what a push would write, so this is where "only what
    // the row said" is checked: the link and the section are in, the list's own
    // counts stay out.
    const fromId = plain(view.board.compose(view.board.patchFor('paper-2611-00001'), '',
      { at: '2026-11-03' }));
    assert.match(fromId.text, /# A paper\n\n条目来自清单 isLinXu\/own。\n\n原文：https:\/\/arxiv\.org\/abs\/2611\.00001\n\n/,
      'the card is prose a reader can scan, not one run-on line');
    assert.match(fromId.text, /分区：最新。\n\n清单的条目数/);
    assert.match(fromId.text, /^title: A paper$/m);
    assert.match(fromId.text, /^status: proposal$/m);

    const other = data.awesomeFlow().findIndex(entry => entry.id === 'title:Another paper');
    click(other);
    const fromTitle = plain(view.board.compose(view.board.patchFor('paper-another-paper'), '',
      { at: '2026-11-03' }));
    assert.match(fromTitle.text, /条目来自清单 isLinXu\/other/, 'the list it came from is the one fact kept');
    assert.match(fromTitle.text, /没有给这一行一个链接/, 'and a missing link is said, not guessed');
    assert.ok(!/\n\n\n/.test(fromTitle.text),
      'a row with no section costs a paragraph, not an empty block in the file');
    for (const count of ['42', '400']) {
      assert.ok(!fromTitle.text.includes(count),
        `the card carries no count from the list board: ${count} would be a second owner of one number`);
    }

    const anonymous = data.awesomeFlow().findIndex(entry => entry.id === '');
    click(anonymous);
    assert.match(app.toasts.at(-1), /既没有 arXiv id 也没有条目 id/);
    assert.equal(view.board.draftSlugs().length, 2,
      'a row with nothing to name it gets a refusal, not a card with a random file name');
  });

// --- 采集健康：data/runs.json -----------------------------------------------
// The one payload about the collector instead of the numbers it collects. It is
// the only sentence on the page that can name a failure `continue-on-error`
// swallowed, so what it must never do is turn "this browser could not read the
// file" into "the collection failed".

function runRow(extra = {}) {
  return {
    run_id: '12345', run_number: 312, attempt: 1, date: '2026-11-03',
    recorded_at: '2026-11-03T02:23:00Z', job_status: 'success', status: 'ok',
    steps_watched: 15, steps_failed: [], steps_missing: [],
    run_url: 'https://github.com/isLinXu/model-observatory/actions/runs/12345',
    ...extra
  };
}

function runsPayload(rows = [runRow()], extra = {}) {
  return {
    schema_version: 1, source_id: 'runs', updated_at: '2026-11-03T02:23:00Z',
    covers: '采集与索引这一段；构建与 Pages 部署排在这份记录提交之后，不在这里',
    statuses: ['ok', 'partial', 'failed', 'unknown'],
    retention: { runs: 60, kept: rows.length },
    runs: rows,
    ...extra
  };
}

function runsData(payload, globals = {}) {
  return loadData(async url => (url.includes('runs.json')
    ? jsonResponse(payload)
    : jsonResponse({ schema_version: 1, source_id: 'other' })), globals);
}

const healthClock = () => testClock('2026-11-03T06:00:00.000Z');

test('the health line reads the run\'s own report and keeps its boundary in the title', async () => {
  const data = runsData(runsPayload());
  await data.loadRuns();
  const health = data.runHealth();
  assert.equal(health.loaded, true);
  assert.equal(health.latest.runId, '12345');
  assert.equal(health.kept, 1);
  assert.equal(health.notOk, 0, 'a clean run is not counted as one that was not clean');

  const view = loadModelView(data, { Date: healthClock().Date });
  view.render.renderRunHealth();
  const line = view.element('runHealth');
  assert.match(line.innerHTML, /最近一次运行 2026-11-03（第 312 次）15 步都成功/);
  assert.match(line.innerHTML, /href="https:\/\/github\.com\/isLinXu\/model-observatory\/actions\/runs\/12345"/);
  assert.match(line.innerHTML, /rel="noopener noreferrer"/);
  assert.equal(line.className, 'run-health good');
  assert.match(line.title, /构建与 Pages 部署排在这份记录提交之后/,
    'a green line here is not a claim that the site redeployed');
  assert.match(line.title, /作业状态 success/);
});

test('a failure continue-on-error swallowed is named, with the step it was', async () => {
  const data = runsData(runsPayload([
    runRow({ status: 'partial', steps_failed: ['会议截止目录'], steps_missing: ['star 图谱'] }),
    runRow({ run_id: '12344', run_number: 311, status: 'ok' })
  ]));
  await data.loadRuns();
  assert.equal(data.runHealth().notOk, 1);
  const view = loadModelView(data, { Date: healthClock().Date });
  view.render.renderRunHealth();
  const line = view.element('runHealth');
  assert.match(line.innerHTML, /2 步没成功/);
  assert.match(line.innerHTML, /会议截止目录（失败）/);
  assert.match(line.innerHTML, /star 图谱（没跑到）/);
  assert.match(line.innerHTML, /保留的 2 次记录里 1 次不干净/,
    'the retention window is spoken about as what it holds, not as the whole history');
  assert.equal(line.className, 'run-health warn');
});

test('an unread record file is said as unread, never as a failed collection', async () => {
  const data = loadData(async url => {
    if (url.includes('runs.json')) throw new TypeError('Failed to fetch');
    return jsonResponse({ schema_version: 1, source_id: 'other' });
  }, { TypeError });
  await data.loadRuns();
  assert.equal(data.state.runs, null);
  assert.equal(data.runHealth().loaded, false);
  assert.match(data.runHealth().error, /Failed to fetch/);
  const view = loadModelView(data);
  view.render.renderRunHealth();
  const line = view.element('runHealth');
  assert.match(line.textContent, /这台浏览器没读到运行记录/);
  assert.match(line.textContent, /读不到不等于采集失败/);
  assert.match(line.title, /Failed to fetch/);
  assert.equal(line.className, 'run-health warn');
});

test('a record file nothing has written to yet is empty, not broken', async () => {
  const data = runsData(runsPayload([]));
  await data.loadRuns();
  assert.equal(data.runHealth().latest, null);
  const view = loadModelView(data);
  view.render.renderRunHealth();
  const line = view.element('runHealth');
  assert.match(line.textContent, /记录文件还没有任何运行/);
  assert.ok(!/失败/.test(line.textContent), 'an empty file blames nobody');
  assert.equal(line.className, 'run-health');
});

test('a status word the page does not know degrades to unknown rather than to ok', async () => {
  const data = runsData(runsPayload([runRow({ status: 'green' })]));
  await data.loadRuns();
  assert.equal(data.runHealth().latest.status, 'unknown');
  const view = loadModelView(data, { Date: healthClock().Date });
  view.render.renderRunHealth();
  assert.match(view.element('runHealth').innerHTML, /没交出步骤结果/);
});

test('a record older than the daily cadence says its own age instead of going quiet', async () => {
  const data = runsData(runsPayload([runRow({
    date: '2026-10-30', recorded_at: '2026-10-30T02:23:00Z', status: 'unknown'
  })]));
  await data.loadRuns();
  const view = loadModelView(data, { Date: healthClock().Date });
  view.render.renderRunHealth();
  assert.match(view.element('runHealth').innerHTML, /距今 4 天/);
});

test('a run with no number loses the clause rather than printing 第 — 次', async () => {
  const data = runsData(runsPayload([runRow({ run_number: null, steps_watched: null })]));
  await data.loadRuns();
  const view = loadModelView(data, { Date: healthClock().Date });
  view.render.renderRunHealth();
  const line = view.element('runHealth');
  assert.match(line.innerHTML, /最近一次运行 2026-11-03各步都成功/);
  assert.ok(!/—/.test(line.innerHTML), 'absence silences a sentence instead of decorating it');
});

test('the run line refuses another board\'s payload and a non-http link', async () => {
  const foreign = runsData(runsPayload([runRow()], { source_id: 'github' }));
  await foreign.loadRuns();
  assert.equal(foreign.state.runs, null, 'a payload for a different file is not read as run health');
  assert.match(foreign.state.runsError, /不兼容/);

  const hostile = runsData(runsPayload([runRow({
    run_url: 'javascript:alert(1)',
    steps_failed: ['<img src=x onerror=alert(1)>']
  })]));
  await hostile.loadRuns();
  assert.equal(hostile.runHealth().latest.runUrl, null, 'only an http(s) url becomes a link');
  const view = loadModelView(hostile, { Date: healthClock().Date });
  view.render.renderRunHealth();
  const line = view.element('runHealth');
  assert.ok(!/href="javascript:/i.test(line.innerHTML), line.innerHTML);
  assert.ok(!/<img/i.test(line.innerHTML), 'a step label is text, never markup');
  assert.match(line.innerHTML, /&lt;img/);
});

test('the run line survives a failed payload read, because that is when it matters', async () => {
  const view = loadBoardView();
  const app = await startApp(view, ['renderRunHealth'], {
    loadAll: async () => { throw new Error('history.json 读取失败'); }
  });
  assert.equal(view.element('freshLabel').textContent, '数据读取失败');
  const line = view.element('runHealth');
  assert.match(line.textContent, /这台浏览器没读到运行记录/,
    'the health line paints from its own file, so a broken latest.json still leaves the reader with a sentence');
  assert.equal(line.className, 'run-health warn');
});

test('boot paints the run line from the record file, next to the boards it can read', async () => {
  const view = loadBoardView({ runs: runsPayload([runRow()]) });
  await view.data.loadRuns();
  await startApp(view, ['renderRunHealth']);
  assert.match(view.element('runHealth').innerHTML, /最近一次运行 2026-11-03（第 312 次）15 步都成功/,
    'renderAll has to reach the new line, not just export a function nobody calls');
  assert.equal(view.element('runHealth').className, 'run-health good');
});

