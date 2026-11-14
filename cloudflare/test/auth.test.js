import test from 'node:test';
import assert from 'node:assert/strict';
import { call, makeEnv, setupAdmin, addUser, signIn } from './helpers.js';

test('bootstrap: needs the secret, works once, never stores the password in clear', async () => {
  const env = makeEnv();
  let r = await call(env, 'POST', '/api/admin/bootstrap', { body: { token: 'wrong', username: 'admin', password: 'correct horse battery' } });
  assert.equal(r.status, 403);
  await setupAdmin(env);
  r = await call(env, 'POST', '/api/admin/bootstrap', { body: { token: env.BOOTSTRAP_TOKEN, username: 'second', password: 'correct horse battery' } });
  assert.equal(r.status, 403, 'bootstrap must be closed once a user exists');
  const u = env.DB.raw.prepare('SELECT pass_hash FROM users').get();
  assert.match(u.pass_hash, /^pbkdf2\$100000\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
  assert.ok(!u.pass_hash.includes('correct horse'));
});

test('bootstrap is refused when no BOOTSTRAP_TOKEN secret is configured', async () => {
  const env = makeEnv();
  delete env.BOOTSTRAP_TOKEN;
  const r = await call(env, 'POST', '/api/admin/bootstrap', { body: { token: '', username: 'admin', password: 'correct horse battery' } });
  assert.equal(r.status, 403);
});

test('login sets a hardened cookie; me / logout work; token is stored hashed', async () => {
  const env = makeEnv();
  await setupAdmin(env);
  const r = await call(env, 'POST', '/api/auth/login', { body: { username: 'Admin', password: 'correct horse battery' } });
  assert.equal(r.status, 200);
  const sc = r.headers.get('set-cookie');
  for (const part of ['__Host-gm_session=', 'HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(sc.includes(part), part);
  assert.ok(!/Domain=/i.test(sc));
  const cookie = sc.split(';')[0];
  const token = cookie.split('=')[1];
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM sessions WHERE token_hash = ?').get(token).n, 0, 'raw token must not be stored');
  let me = await call(env, 'GET', '/api/auth/me', { cookie });
  assert.deepEqual(await me.json(), { username: 'admin', role: 'admin' });
  await call(env, 'POST', '/api/auth/logout', { cookie });
  me = await call(env, 'GET', '/api/auth/me', { cookie });
  assert.equal(me.status, 401, 'session must be dead after logout');
});

test('wrong password / unknown user give the same 401; no public registration', async () => {
  const env = makeEnv();
  await setupAdmin(env);
  const a = await call(env, 'POST', '/api/auth/login', { body: { username: 'admin', password: 'nope nope nope nope' } });
  const b = await call(env, 'POST', '/api/auth/login', { body: { username: 'ghost', password: 'nope nope nope nope' } });
  assert.equal(a.status, 401);
  assert.deepEqual(await a.json(), await b.json());
  for (const p of ['/api/auth/register', '/api/register', '/api/admin/users']) {
    const r = await call(env, 'POST', p, { body: { username: 'evil', password: 'evil evil evil evil' } });
    assert.ok([401, 404].includes(r.status), `${p} -> ${r.status}`);
  }
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
});

test('rate limit: 5 bad passwords lock the account, even for the right password', async () => {
  const env = makeEnv();
  await setupAdmin(env);
  for (let i = 0; i < 5; i++) {
    const r = await call(env, 'POST', '/api/auth/login', { body: { username: 'admin', password: 'bad bad bad bad bad' } });
    assert.equal(r.status, 401);
  }
  const r = await call(env, 'POST', '/api/auth/login', { body: { username: 'admin', password: 'correct horse battery' } });
  assert.equal(r.status, 429);
  assert.ok(r.headers.get('retry-after'));
});

test('CSRF: cross-origin or origin-less writes are refused', async () => {
  const env = makeEnv();
  const cookie = await setupAdmin(env);
  let r = await call(env, 'PUT', '/api/state', { cookie, raw: '{}', origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  r = await call(env, 'PUT', '/api/state', { cookie, raw: '{}', origin: null });
  assert.equal(r.status, 403);
  r = await call(env, 'PUT', '/api/state', { cookie, raw: '{}', origin: null, headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(r.status, 200);
});

test('admin creates users; normal users cannot; weak passwords rejected; disabling kills sessions', async () => {
  const env = makeEnv();
  const admin = await setupAdmin(env);
  const bob = await addUser(env, admin, 'bob');
  let r = await call(env, 'POST', '/api/admin/users', { cookie: bob, body: { username: 'eve', password: 'long enough password' } });
  assert.equal(r.status, 403);
  r = await call(env, 'POST', '/api/admin/users', { cookie: admin, body: { username: 'weak', password: 'short' } });
  assert.equal(r.status, 400);
  r = await call(env, 'POST', '/api/admin/users/bob/disabled', { cookie: admin, body: { disabled: true } });
  assert.equal(r.status, 200);
  assert.equal((await call(env, 'GET', '/api/auth/me', { cookie: bob })).status, 401);
  await assert.rejects(signIn(env, 'bob', 'another long password'));
});

test('password change keeps this session, drops the others', async () => {
  const env = makeEnv();
  const c1 = await setupAdmin(env);
  const c2 = await signIn(env, 'admin', 'correct horse battery');
  let r = await call(env, 'POST', '/api/auth/password', { cookie: c1, body: { current: 'correct horse battery', new: 'a brand new password!' } });
  assert.equal(r.status, 200);
  assert.equal((await call(env, 'GET', '/api/auth/me', { cookie: c1 })).status, 200);
  assert.equal((await call(env, 'GET', '/api/auth/me', { cookie: c2 })).status, 401);
  await signIn(env, 'admin', 'a brand new password!');
});

test('static gate: login page public, app requires a session', async () => {
  const env = makeEnv();
  const cookie = await setupAdmin(env);
  let r = await call(env, 'GET', '/login', { origin: null });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cross-origin-opener-policy'), 'same-origin');
  r = await call(env, 'GET', '/', { origin: null, headers: { accept: 'text/html' } });
  assert.equal(r.status, 302);
  assert.ok(r.headers.get('location').endsWith('/login'));
  r = await call(env, 'GET', '/main.dart.wasm', { origin: null });
  assert.equal(r.status, 401);
  r = await call(env, 'GET', '/', { cookie, origin: null, headers: { accept: 'text/html' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cross-origin-embedder-policy'), 'require-corp');
  assert.equal(r.headers.get('cache-control'), 'no-cache');
});

test('API without session: 401 everywhere', async () => {
  const env = makeEnv();
  for (const [m, p] of [['GET', '/api/state'], ['GET', '/api/rev'], ['GET', '/api/info'], ['GET', '/api/media/a.png'], ['GET', '/api/backups'], ['POST', '/api/backups']]) {
    assert.equal((await call(env, m, p)).status, 401, p);
  }
});
