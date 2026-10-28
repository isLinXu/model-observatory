const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadData(fetch) {
  const context = { console: { ...console, warn() {} }, fetch, URL, AbortSignal };
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
function loadModelView(data) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      innerHTML: '', textContent: '', value: '', events: {},
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(type, listener) { this.events[type] = listener; },
      setAttribute() {}, click() {}, remove() {}
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
    setTimeout(callback) { callback(); }
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
  const view = loadModelView({ ...data, loadAll: async () => {} });
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
    './data/github_history.json': { snapshots: [] }
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
      assert.equal(requested.length, 10);
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
