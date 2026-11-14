import test from 'node:test';
import assert from 'node:assert/strict';
import { call, makeEnv, setupAdmin, addUser } from './helpers.js';

const put = (env, cookie, obj, base) =>
  call(env, 'PUT', '/api/state', { cookie, raw: JSON.stringify(obj), headers: base === undefined ? {} : { 'x-gymmane-base-rev': String(base) } });

test('state: empty -> 204 rev 0; save; reload returns identical data; JSON lives in R2, D1 holds pointer only', async () => {
  const env = makeEnv();
  const c = await setupAdmin(env);
  let r = await call(env, 'GET', '/api/state', { cookie: c });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('x-gymmane-rev'), '0');
  const data = { workouts: [{ id: 1, name: 'Squat', sets: [5, 5, 5] }], arabic: 'تمرين الأكتاف' };
  r = await put(env, c, data, 0);
  assert.deepEqual(await r.json(), { rev: 1 });
  r = await call(env, 'GET', '/api/state', { cookie: c });
  assert.equal(r.headers.get('x-gymmane-rev'), '1');
  assert.deepEqual(await r.json(), data);
  const row = env.DB.raw.prepare('SELECT * FROM state').get();
  assert.match(row.r2_key, /^users\/u_[a-f0-9]{16}\/state\/v1-[a-f0-9]{12}\.json$/);
  assert.ok(env.MEDIA.map.has(row.r2_key));
  assert.equal(Object.keys(row).includes('data'), false, 'no JSON column in D1');
});

test('rev: increments; stale base -> 409 with current rev; object versions are immutable', async () => {
  const env = makeEnv();
  const c = await setupAdmin(env);
  await put(env, c, { v: 1 }, 0);
  const k1 = env.DB.raw.prepare('SELECT r2_key k FROM state').get().k;
  let r = await put(env, c, { v: 2 }, 1);
  assert.deepEqual(await r.json(), { rev: 2 });
  const k2 = env.DB.raw.prepare('SELECT r2_key k FROM state').get().k;
  assert.notEqual(k1, k2);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(env.MEDIA.map.get(k1).bytes)), { v: 1 }, 'old version untouched');
  r = await put(env, c, { v: 'stale' }, 1);
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { rev: 2 });
  const cur = await (await call(env, 'GET', '/api/state', { cookie: c })).json();
  assert.deepEqual(cur, { v: 2 }, 'conflicting write did not overwrite');
  assert.equal(env.MEDIA.map.size, 2, 'losing write left no orphan object');
});

test('two windows writing with the same base rev at once: exactly one wins, other gets 409', async () => {
  const env = makeEnv();
  const c = await setupAdmin(env);
  await put(env, c, { v: 0 }, 0);
  const results = await Promise.all([put(env, c, { w: 'A' }, 1), put(env, c, { w: 'B' }, 1), put(env, c, { w: 'C' }, 1)]);
  const codes = results.map((r) => r.status).sort();
  assert.deepEqual(codes, [200, 409, 409]);
  assert.equal(env.DB.raw.prepare('SELECT rev FROM state').get().rev, 2);
  const live = [...env.MEDIA.map.keys()].filter((k) => k.includes('/state/'));
  assert.equal(live.length, 2, 'no leftover objects from losers');
});

test('invalid / oversize / non-object bodies are rejected without touching storage', async () => {
  const env = makeEnv();
  const c = await setupAdmin(env);
  for (const raw of ['not json', '[1,2]', '"str"', 'null']) {
    const r = await call(env, 'PUT', '/api/state', { cookie: c, raw });
    assert.equal(r.status, 400, raw);
  }
  const r = await call(env, 'PUT', '/api/state', { cookie: c, raw: '{}', headers: { 'content-length': String(26 * 1024 * 1024) } });
  assert.equal(r.status, 413);
  assert.equal(env.MEDIA.map.size, 0);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM state').get().n, 0);
});

test('partial failure: R2 down -> 503, D1 unchanged', async () => {
  const env = makeEnv();
  const c = await setupAdmin(env);
  await put(env, c, { v: 1 }, 0);
  env.MEDIA.failPut = true;
  const r = await put(env, c, { v: 2 }, 1);
  assert.equal(r.status, 503);
  env.MEDIA.failPut = false;
  assert.equal(env.DB.raw.prepare('SELECT rev FROM state').get().rev, 1);
  assert.deepEqual(await (await call(env, 'GET', '/api/state', { cookie: c })).json(), { v: 1 });
});

test('partial failure: R2 ok but D1 commit fails -> 503, new object removed, old state intact', async () => {
  const env = makeEnv();
  const c = await setupAdmin(env);
  await put(env, c, { v: 1 }, 0);
  const before = env.MEDIA.map.size;
  env.DB.failBatch = true;
  const r = await put(env, c, { v: 2 }, 1);
  assert.equal(r.status, 503);
  env.DB.failBatch = false;
  assert.equal(env.MEDIA.map.size, before);
  assert.deepEqual(await (await call(env, 'GET', '/api/state', { cookie: c })).json(), { v: 1 });
  const ok = await put(env, c, { v: 3 }, 1);
  assert.equal(ok.status, 200, 'recovers on retry');
});

test('missing R2 object behind a pointer is reported, not silently emptied', async () => {
  const env = makeEnv();
  const c = await setupAdmin(env);
  await put(env, c, { v: 1 }, 0);
  env.MEDIA.map.clear();
  const r = await call(env, 'GET', '/api/state', { cookie: c });
  assert.equal(r.status, 500);
  assert.equal((await r.json()).error, 'state_object_missing');
});

test('two users: state, media and backups are fully isolated', async () => {
  const env = makeEnv();
  const a = await setupAdmin(env);
  const b = await addUser(env, a, 'bob');
  await put(env, a, { owner: 'admin' }, 0);
  await put(env, b, { owner: 'bob' }, 0);
  assert.deepEqual(await (await call(env, 'GET', '/api/state', { cookie: a })).json(), { owner: 'admin' });
  assert.deepEqual(await (await call(env, 'GET', '/api/state', { cookie: b })).json(), { owner: 'bob' });
  await call(env, 'PUT', '/api/media/secret.png', { cookie: a, raw: new Uint8Array([1, 2, 3]) });
  assert.equal((await call(env, 'GET', '/api/media/secret.png', { cookie: b })).status, 404);
  assert.equal((await call(env, 'DELETE', '/api/media/secret.png', { cookie: b })).status, 200);
  assert.equal((await call(env, 'GET', '/api/media/secret.png', { cookie: a })).status, 200, "bob's delete did not touch admin's file");
  const bk = await (await call(env, 'POST', '/api/backups', { cookie: a })).json();
  for (const [m, p] of [['GET', `/api/backups/${bk.id}`], ['POST', `/api/backups/${bk.id}/restore`], ['DELETE', `/api/backups/${bk.id}`], ['POST', `/api/backups/${bk.id}/verify`]]) {
    assert.equal((await call(env, m, p, { cookie: b })).status, 404, p);
  }
  assert.deepEqual((await (await call(env, 'GET', '/api/backups', { cookie: b })).json()).backups, []);
});

test('media: roundtrip via R2, content-type, hostile names refused', async () => {
  const env = makeEnv();
  const c = await setupAdmin(env);
  const bytes = new Uint8Array(1000).map((_, i) => i % 256);
  let r = await call(env, 'PUT', '/api/media/photo-1.jpg', { cookie: c, raw: bytes });
  assert.equal(r.status, 200);
  r = await call(env, 'GET', '/api/media/photo-1.jpg', { cookie: c });
  assert.equal(r.headers.get('content-type'), 'image/jpeg');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()), bytes);
  const uid = env.DB.raw.prepare('SELECT id FROM users').get().id;
  assert.ok(env.MEDIA.map.has(`users/${uid}/media/photo-1.jpg`));
  for (const n of ['..%2F..%2Fother', '%2e%2e', 'a%2Fb.png', '.hidden', 'x'.repeat(161), 'a..b']) {
    const bad = await call(env, 'PUT', `/api/media/${n}`, { cookie: c, raw: bytes });
    assert.ok([400, 404].includes(bad.status), n + ' -> ' + bad.status); // 404 = URL normalised away from the media route
  }
  assert.equal([...env.MEDIA.map.keys()].filter((k) => k.includes('/media/')).length, 1);
  r = await call(env, 'PUT', '/api/media/huge.mp4', { cookie: c, raw: bytes, headers: { 'content-length': String(81 * 1024 * 1024) } });
  assert.equal(r.status, 413);
  r = await call(env, 'DELETE', '/api/media/photo-1.jpg', { cookie: c });
  assert.equal(r.status, 200);
  assert.equal((await call(env, 'GET', '/api/media/photo-1.jpg', { cookie: c })).status, 404);
});

test('media: R2 failure leaves no index row', async () => {
  const env = makeEnv();
  const c = await setupAdmin(env);
  env.MEDIA.failPut = true;
  const r = await call(env, 'PUT', '/api/media/a.png', { cookie: c, raw: new Uint8Array(10) });
  assert.equal(r.status, 503);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM media').get().n, 0);
});

test('info keeps the shape the app expects; phone-folder sync reports disabled', async () => {
  const env = makeEnv();
  const c = await setupAdmin(env);
  const info = await (await call(env, 'GET', '/api/info', { cookie: c })).json();
  assert.equal(info.app, 'gymmane');
  assert.equal(info.auth, true);
  assert.deepEqual(info.sync, { enabled: false });
  assert.deepEqual(await (await call(env, 'POST', '/api/sync/scan', { cookie: c })).json(), { enabled: false });
  assert.deepEqual(await (await call(env, 'GET', '/api/rev', { cookie: c })).json(), { rev: 0 });
});
