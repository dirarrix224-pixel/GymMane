import test from 'node:test';
import assert from 'node:assert/strict';
import { call, makeEnv, setupAdmin } from './helpers.js';
import { dailyJob } from '../src/backup.js';

const put = (env, cookie, obj, base) =>
  call(env, 'PUT', '/api/state', { cookie, raw: JSON.stringify(obj), headers: { 'x-gymmane-base-rev': String(base) } });

test('manual backup -> list -> download -> corrupt detection', async () => {
  const env = makeEnv();
  const c = await setupAdmin(env);
  assert.equal((await call(env, 'POST', '/api/backups', { cookie: c })).status, 404, 'nothing to back up yet');
  await put(env, c, { w: [1, 2, 3] }, 0);
  const r = await call(env, 'POST', '/api/backups', { cookie: c });
  assert.equal(r.status, 201);
  const b = await r.json();
  const list = (await (await call(env, 'GET', '/api/backups', { cookie: c })).json()).backups;
  assert.equal(list.length, 1);
  const dl = await call(env, 'GET', `/api/backups/${b.id}`, { cookie: c });
  assert.match(dl.headers.get('content-disposition'), /^attachment; filename="gymmane-backup-/);
  assert.deepEqual(await dl.json(), { w: [1, 2, 3] });
  assert.deepEqual(await (await call(env, 'POST', `/api/backups/${b.id}/verify`, { cookie: c })).json(), { ok: true });
  const key = env.DB.raw.prepare('SELECT r2_key k FROM backups').get().k;
  env.MEDIA.map.get(key).bytes = new TextEncoder().encode('{"w":[9]}');
  assert.equal((await (await call(env, 'POST', `/api/backups/${b.id}/verify`, { cookie: c })).json()).ok, false);
  assert.equal((await call(env, 'GET', `/api/backups/${b.id}`, { cookie: c })).status, 500);
  const rs = await call(env, 'POST', `/api/backups/${b.id}/restore`, { cookie: c });
  assert.equal(rs.status, 503, 'a damaged backup is never restored');
  assert.deepEqual(await (await call(env, 'GET', '/api/state', { cookie: c })).json(), { w: [1, 2, 3] });
});

test('restore: brings back old data as a new rev, and saves the current data first', async () => {
  const env = makeEnv();
  const c = await setupAdmin(env);
  await put(env, c, { v: 'old' }, 0);
  const b = await (await call(env, 'POST', '/api/backups', { cookie: c })).json();
  await put(env, c, { v: 'newer' }, 1);
  const r = await call(env, 'POST', `/api/backups/${b.id}/restore`, { cookie: c });
  assert.deepEqual(await r.json(), { ok: true, rev: 3 });
  assert.deepEqual(await (await call(env, 'GET', '/api/state', { cookie: c })).json(), { v: 'old' });
  const list = (await (await call(env, 'GET', '/api/backups', { cookie: c })).json()).backups;
  assert.deepEqual(list.map((x) => x.reason).sort(), ['manual', 'pre-restore']);
  const pre = list.find((x) => x.reason === 'pre-restore');
  const dl = await call(env, 'GET', `/api/backups/${pre.id}`, { cookie: c });
  assert.deepEqual(await dl.json(), { v: 'newer' }, 'the overwritten data is recoverable');
});

test('daily job: backs up only changed accounts, is idempotent', async () => {
  const env = makeEnv();
  const c = await setupAdmin(env);
  await put(env, c, { v: 1 }, 0);
  let rep = await dailyJob(env);
  assert.equal(rep.backedUp, 1);
  rep = await dailyJob(env);
  assert.equal(rep.backedUp, 0, 'unchanged data -> no new backup');
  await put(env, c, { v: 2 }, 1);
  rep = await dailyJob(env);
  assert.equal(rep.backedUp, 1);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM backups WHERE reason='daily'").get().n, 2);
});

test('daily job: 30-day retention, never deletes the newest backup', async () => {
  const env = makeEnv();
  const c = await setupAdmin(env);
  await put(env, c, { v: 1 }, 0);
  const mk = async () => (await (await call(env, 'POST', '/api/backups', { cookie: c })).json()).id;
  const oldA = await mk();
  const oldB = await mk();
  const fresh = await mk();
  const day = 86400, now = Math.floor(Date.now() / 1000);
  env.DB.raw.prepare('UPDATE backups SET created_at = ? WHERE id = ?').run(now - 45 * day, oldA);
  env.DB.raw.prepare('UPDATE backups SET created_at = ? WHERE id = ?').run(now - 31 * day, oldB);
  env.DB.raw.prepare('UPDATE backups SET created_at = ? WHERE id = ?').run(now - 5 * day, fresh);
  const rep = await dailyJob(env);
  assert.equal(rep.prunedBackups, 2);
  const left = env.DB.raw.prepare('SELECT id FROM backups').all().map((x) => x.id);
  assert.deepEqual(left, [fresh]);
  // only backup left is old -> must survive (e.g. backups have been failing)
  env.DB.raw.prepare('UPDATE backups SET created_at = ? WHERE id = ?').run(now - 90 * day, fresh);
  await dailyJob(env);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM backups').get().n, 1);
});

test('daily job: a corrupt source is not backed up, and nothing older is deleted', async () => {
  const env = makeEnv();
  const c = await setupAdmin(env);
  await put(env, c, { v: 1 }, 0);
  const good = await (await call(env, 'POST', '/api/backups', { cookie: c })).json();
  await put(env, c, { v: 2 }, 1);
  const key = env.DB.raw.prepare('SELECT r2_key k FROM state').get().k;
  env.MEDIA.map.get(key).bytes = new TextEncoder().encode('{"v":"tampered"}');
  const rep = await dailyJob(env);
  assert.equal(rep.failed, 1);
  assert.equal(rep.backedUp, 0);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM backups').get().n, 1);
  assert.deepEqual(await (await call(env, 'GET', `/api/backups/${good.id}`, { cookie: c })).json(), { v: 1 });
});

test('daily job: prunes old versions and orphans but keeps the current object', async () => {
  const env = makeEnv();
  const c = await setupAdmin(env);
  await put(env, c, { v: 1 }, 0);
  await put(env, c, { v: 2 }, 1);
  const uid = env.DB.raw.prepare('SELECT id FROM users').get().id;
  const orphan = `users/${uid}/state/v9-deadbeef0000.json`;
  await env.MEDIA.put(orphan, new TextEncoder().encode('{}'));
  env.MEDIA.map.get(orphan).uploaded = new Date(Date.now() - 2 * 3600 * 1000);
  const fresh = `users/${uid}/state/v10-aaaaaaaaaaaa.json`;
  await env.MEDIA.put(fresh, new TextEncoder().encode('{}')); // in-flight write: must NOT be swept
  const old = Math.floor(Date.now() / 1000) - 3 * 86400;
  env.DB.raw.prepare('UPDATE state_versions SET saved_at = ? WHERE rev = 1').run(old);
  const rep = await dailyJob(env);
  assert.equal(rep.prunedVersions, 1);
  assert.equal(rep.orphans, 1);
  assert.ok(!env.MEDIA.map.has(orphan));
  assert.ok(env.MEDIA.map.has(fresh));
  assert.deepEqual(await (await call(env, 'GET', '/api/state', { cookie: c })).json(), { v: 2 });
});
