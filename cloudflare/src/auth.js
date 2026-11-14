import { enc, json, nowSec, randomHex, readJson, safeEqual, sha256Hex, hex } from './util.js';

export const COOKIE = '__Host-gm_session';
export const SESSION_TTL = 30 * 24 * 3600;
export const PBKDF2_ITER = 100000; // Workers' maximum for PBKDF2
const WINDOW = 15 * 60;
const MAX_PER_USER = 5;
const MAX_PER_IP = 30;

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITER}$${hex(salt)}$${hex(await derive(password, salt, PBKDF2_ITER))}`;
}

export async function verifyPassword(password, stored) {
  const [alg, iter, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'pbkdf2' || !saltHex || !hashHex) return false;
  const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  return safeEqual(hex(await derive(password, salt, Number(iter))), hashHex);
}

let dummy;
async function dummyHash() {
  return (dummy ??= hashPassword('gymmane-dummy-password'));
}

export const validUsername = (u) => typeof u === 'string' && /^[a-z0-9._-]{3,32}$/.test(u);
export const validPassword = (p) => typeof p === 'string' && p.length >= 12 && p.length <= 200;

const clientIp = (req) => req.headers.get('cf-connecting-ip') || 'local';

async function isLimited(env, checks) {
  const now = nowSec();
  for (const [k, max] of checks) {
    const r = await env.DB.prepare('SELECT count, first_at FROM login_attempts WHERE k = ?').bind(k).first();
    if (r && now - r.first_at < WINDOW && r.count >= max) return Math.max(1, WINDOW - (now - r.first_at));
  }
  return 0;
}

async function recordFailure(env, keys) {
  const now = nowSec();
  for (const k of keys) {
    await env.DB.prepare(
      `INSERT INTO login_attempts(k, count, first_at) VALUES(?, 1, ?)
       ON CONFLICT(k) DO UPDATE SET
         count = CASE WHEN ? - first_at >= ? THEN 1 ELSE count + 1 END,
         first_at = CASE WHEN ? - first_at >= ? THEN ? ELSE first_at END`,
    ).bind(k, now, now, WINDOW, now, WINDOW, now).run();
  }
}

export async function createSession(env, userId) {
  const token = randomHex(32);
  const now = nowSec();
  await env.DB.prepare('INSERT INTO sessions(token_hash, user_id, created_at, expires_at) VALUES(?,?,?,?)')
    .bind(await sha256Hex(token), userId, now, now + SESSION_TTL).run();
  return token;
}

const cookieHeader = (token, maxAge) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

export async function getSession(env, req) {
  const m = (req.headers.get('cookie') || '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  const token = m?.slice(COOKIE.length + 1);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.username, u.role, s.token_hash FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0`,
  ).bind(await sha256Hex(token), nowSec()).first();
  return row ?? null;
}

export async function login(req, env) {
  const body = await readJson(req);
  const username = typeof body?.username === 'string' ? body.username.trim().toLowerCase() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!username || !password || password.length > 200) return json({ error: 'invalid' }, 400);
  const ipKey = `ip:${clientIp(req)}`;
  const userKey = `user:${username}`;
  const wait = await isLimited(env, [[ipKey, MAX_PER_IP], [userKey, MAX_PER_USER]]);
  if (wait) return json({ error: 'rate_limited', retryAfter: wait }, 429, { 'retry-after': String(wait) });

  const user = await env.DB.prepare('SELECT id, pass_hash, disabled FROM users WHERE username = ?').bind(username).first();
  const ok = await verifyPassword(password, user ? user.pass_hash : await dummyHash());
  if (!user || !ok || user.disabled) {
    await recordFailure(env, [ipKey, userKey]);
    return json({ error: 'bad_credentials' }, 401);
  }
  await env.DB.prepare('DELETE FROM login_attempts WHERE k = ?').bind(userKey).run();
  const token = await createSession(env, user.id);
  return json({ ok: true }, 200, { 'set-cookie': cookieHeader(token, SESSION_TTL) });
}

export async function logout(req, env, session) {
  if (session) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(session.token_hash).run();
  return json({ ok: true }, 200, { 'set-cookie': cookieHeader('', 0) });
}

export async function changePassword(req, env, session) {
  const b = await readJson(req);
  if (!b || !validPassword(b.new)) return json({ error: 'weak_password', min: 12 }, 400);
  const row = await env.DB.prepare('SELECT pass_hash FROM users WHERE id = ?').bind(session.id).first();
  if (!(await verifyPassword(String(b.current ?? ''), row.pass_hash))) return json({ error: 'bad_credentials' }, 401);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').bind(await hashPassword(b.new), session.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(session.id, session.token_hash),
  ]);
  return json({ ok: true });
}

// First admin: only while the users table is empty, and only with the BOOTSTRAP_TOKEN secret.
export async function bootstrap(req, env) {
  const ipKey = `ip:${clientIp(req)}`;
  const wait = await isLimited(env, [[ipKey, MAX_PER_USER]]);
  if (wait) return json({ error: 'rate_limited' }, 429, { 'retry-after': String(wait) });
  const b = await readJson(req);
  const secret = env.BOOTSTRAP_TOKEN;
  if (!secret || secret.length < 16 || typeof b?.token !== 'string' || !safeEqual(b.token, secret)) {
    await recordFailure(env, [ipKey]);
    return json({ error: 'forbidden' }, 403);
  }
  if (!validUsername(b.username) || !validPassword(b.password)) {
    return json({ error: 'invalid', rules: 'username 3-32 [a-z0-9._-], password 12+ chars' }, 400);
  }
  const r = await env.DB.prepare(
    `INSERT INTO users(id, username, pass_hash, role, created_at)
     SELECT ?, ?, ?, 'admin', ? WHERE NOT EXISTS (SELECT 1 FROM users)`,
  ).bind('u_' + randomHex(8), b.username, await hashPassword(b.password), nowSec()).run();
  if (r.meta.changes !== 1) return json({ error: 'forbidden' }, 403);
  return json({ ok: true }, 201);
}

export async function createUser(req, env) {
  const b = await readJson(req);
  if (!b || !validUsername(b.username) || !validPassword(b.password)) {
    return json({ error: 'invalid', rules: 'username 3-32 [a-z0-9._-], password 12+ chars' }, 400);
  }
  const role = b.role === 'admin' ? 'admin' : 'user';
  try {
    await env.DB.prepare('INSERT INTO users(id, username, pass_hash, role, created_at) VALUES(?,?,?,?,?)')
      .bind('u_' + randomHex(8), b.username, await hashPassword(b.password), role, nowSec()).run();
  } catch {
    return json({ error: 'exists' }, 409);
  }
  return json({ ok: true }, 201);
}

export async function listUsers(env) {
  const { results } = await env.DB.prepare('SELECT username, role, disabled, created_at FROM users ORDER BY created_at').all();
  return json({ users: results });
}

export async function setDisabled(req, env, session, username) {
  const b = await readJson(req);
  if (!b || typeof b.disabled !== 'boolean') return json({ error: 'invalid' }, 400);
  const u = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
  if (!u) return json({ error: 'not_found' }, 404);
  if (u.id === session.id) return json({ error: 'cannot_disable_self' }, 400);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET disabled = ? WHERE id = ?').bind(b.disabled ? 1 : 0, u.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u.id),
  ]);
  return json({ ok: true });
}
