import { StorageError, json, nowSec, randomHex, sha256Hex } from './util.js';

export const MAX_STATE = 25 * 1024 * 1024; // buffered in Worker memory (128 MB limit)

async function safeDelete(env, key) {
  try {
    await env.MEDIA.delete(key);
  } catch {
    // leftover orphan objects are removed by the daily sweep
  }
}

// Commit a new immutable state version. R2 object first, then an atomic D1 pointer swap guarded by rev.
// Returns {rev} | {conflict: true, rev}. Throws StorageError if nothing was committed.
export async function writeState(env, uid, bytes, { baseRev = null, source = 'web' } = {}) {
  const cur = await env.DB.prepare('SELECT rev FROM state WHERE user_id = ?').bind(uid).first();
  const curRev = cur?.rev ?? 0;
  if (baseRev !== null && curRev !== 0 && baseRev !== curRev) return { conflict: true, rev: curRev };

  const rev = curRev + 1;
  const key = `users/${uid}/state/v${rev}-${randomHex(6)}.json`;
  const sha = await sha256Hex(bytes);
  const at = nowSec();
  let stored;
  try {
    stored = await env.MEDIA.put(key, bytes, {
      sha256: sha,
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { sha256: sha, rev: String(rev), source },
    });
  } catch {
    throw new StorageError('r2_put_failed');
  }
  if (!stored || stored.size !== bytes.byteLength) {
    await safeDelete(env, key);
    throw new StorageError('r2_size_mismatch');
  }

  const ver = env.DB.prepare(
    `INSERT INTO state_versions(user_id, rev, r2_key, size, sha256, saved_at)
     SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM state WHERE user_id = ? AND r2_key = ?)`,
  ).bind(uid, rev, key, bytes.byteLength, sha, at, uid, key);
  const swap =
    curRev === 0
      ? env.DB.prepare(
          `INSERT INTO state(user_id, rev, r2_key, size, sha256, saved_at, source) VALUES(?,?,?,?,?,?,?)
           ON CONFLICT(user_id) DO NOTHING`,
        ).bind(uid, rev, key, bytes.byteLength, sha, at, source)
      : env.DB.prepare(
          'UPDATE state SET rev=?, r2_key=?, size=?, sha256=?, saved_at=?, source=? WHERE user_id=? AND rev=?',
        ).bind(rev, key, bytes.byteLength, sha, at, source, uid, curRev);

  let committed;
  try {
    const res = await env.DB.batch([swap, ver]);
    committed = res[0].meta.changes === 1;
  } catch {
    await safeDelete(env, key);
    throw new StorageError('d1_commit_failed');
  }
  if (!committed) {
    await safeDelete(env, key);
    const now = await env.DB.prepare('SELECT rev FROM state WHERE user_id = ?').bind(uid).first();
    return { conflict: true, rev: now?.rev ?? 0 };
  }
  return { rev, size: bytes.byteLength, sha256: sha };
}

export async function getState(env, uid) {
  const row = await env.DB.prepare('SELECT rev, r2_key, saved_at, source FROM state WHERE user_id = ?').bind(uid).first();
  if (!row) return new Response(null, { status: 204, headers: { 'x-gymmane-rev': '0', 'x-gymmane-source': 'none', 'cache-control': 'no-store' } });
  const obj = await env.MEDIA.get(row.r2_key);
  if (!obj) return json({ error: 'state_object_missing', rev: row.rev }, 500);
  return new Response(obj.body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-gymmane-rev': String(row.rev),
      'x-gymmane-source': row.source === 'restore' ? 'web' : row.source,
    },
  });
}

export async function handleState(req, env, session) {
  if (req.method === 'GET') return getState(env, session.id);
  if (req.method !== 'PUT') return json({ error: 'method' }, 405);
  const len = Number(req.headers.get('content-length') ?? NaN);
  if (!Number.isFinite(len)) return json({ error: 'length_required' }, 411);
  if (len > MAX_STATE) return json({ error: 'too large', max: MAX_STATE }, 413);
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength > MAX_STATE) return json({ error: 'too large', max: MAX_STATE }, 413);
  try {
    const v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw 0;
  } catch {
    return json({ error: 'invalid' }, 400);
  }
  const raw = req.headers.get('x-gymmane-base-rev');
  const base = raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
  try {
    const r = await writeState(env, session.id, bytes, { baseRev: base });
    if (r.conflict) return json({ rev: r.rev }, 409);
    return json({ rev: r.rev });
  } catch (e) {
    if (e instanceof StorageError) return json({ error: 'storage_unavailable', detail: e.message }, 503, { 'retry-after': '5' });
    throw e;
  }
}

export async function handleRev(env, session) {
  const r = await env.DB.prepare('SELECT rev FROM state WHERE user_id = ?').bind(session.id).first();
  return json({ rev: r?.rev ?? 0 });
}
