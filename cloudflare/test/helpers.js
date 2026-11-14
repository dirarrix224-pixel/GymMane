import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';

const SQL = readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8');

// D1 stand-in backed by real SQLite (node:sqlite), same schema and SQL as production.
export function makeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SQL);
  const stmt = (sql, params = []) => ({
    bind: (...p) => stmt(sql, p),
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...params).changes) } }),
  });
  const d1 = {
    raw: db,
    failBatch: false,
    prepare: (s) => stmt(s),
    batch: async (list) => {
      if (d1.failBatch) throw new Error('D1 unavailable');
      db.exec('BEGIN');
      try {
        const out = [];
        for (const s of list) out.push(await s.run());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
  return d1;
}

async function toBytes(v) {
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'string') return new TextEncoder().encode(v);
  return new Uint8Array(await new Response(v).arrayBuffer());
}

// R2 stand-in (in-memory), including put-time sha256 verification like the real service.
export function makeR2() {
  const m = new Map();
  const r2 = {
    map: m,
    failPut: false,
    async put(key, value, opts = {}) {
      if (r2.failPut) throw new Error('R2 unavailable');
      const bytes = await toBytes(value);
      if (opts.sha256) {
        const h = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
        if (h !== opts.sha256) throw new Error('checksum mismatch');
      }
      m.set(key, { bytes, uploaded: new Date(), meta: opts.customMetadata });
      return { key, size: bytes.byteLength };
    },
    async get(key) {
      const o = m.get(key);
      return o ? { body: new Response(o.bytes).body, arrayBuffer: async () => o.bytes.slice().buffer, size: o.bytes.byteLength } : null;
    },
    async delete(key) { m.delete(key); },
    async list({ prefix = '' } = {}) {
      return { objects: [...m].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, size: o.bytes.byteLength, uploaded: o.uploaded })), truncated: false };
    },
  };
  return r2;
}

export function makeEnv() {
  return {
    DB: makeD1(),
    MEDIA: makeR2(),
    ASSETS: { fetch: async (req) => new Response(`asset:${new URL(req.url).pathname}`) },
    BOOTSTRAP_TOKEN: 'bootstrap-token-for-tests-0123456789',
  };
}

export const ORIGIN = 'https://gym.test';

export async function call(env, method, path, { body, cookie, headers = {}, origin = ORIGIN, raw } = {}) {
  const h = { ...headers };
  if (origin) h.origin = origin;
  if (cookie) h.cookie = cookie;
  let payload = raw;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    h['content-type'] = 'application/json';
  }
  if (payload !== undefined && h['content-length'] === undefined) {
    h['content-length'] = String(typeof payload === 'string' ? Buffer.byteLength(payload) : payload.byteLength);
  }
  return worker.fetch(new Request(ORIGIN + path, { method, headers: h, body: payload }), env);
}

export async function setupAdmin(env, username = 'admin', password = 'correct horse battery') {
  const r = await call(env, 'POST', '/api/admin/bootstrap', { body: { token: env.BOOTSTRAP_TOKEN, username, password } });
  if (r.status !== 201) throw new Error('bootstrap failed ' + r.status);
  return signIn(env, username, password);
}

export async function signIn(env, username, password) {
  const r = await call(env, 'POST', '/api/auth/login', { body: { username, password } });
  if (r.status !== 200) throw new Error('login failed ' + r.status);
  return r.headers.get('set-cookie').split(';')[0];
}

export async function addUser(env, adminCookie, username, password = 'another long password') {
  const r = await call(env, 'POST', '/api/admin/users', { cookie: adminCookie, body: { username, password } });
  if (r.status !== 201) throw new Error('create user failed ' + r.status);
  return signIn(env, username, password);
}
