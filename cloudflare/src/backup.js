import { StorageError, json, nowSec, randomHex, sha256Hex } from './util.js';
import { writeState } from './state.js';

export const KEEP_DAYS = 30;
const MAX_BACKUPS = 200;
const ID = /^[a-f0-9]{16}$/;
const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);

async function readVerified(env, key, sha256, size) {
  const obj = await env.MEDIA.get(key);
  if (!obj) throw new StorageError('object_missing');
  const bytes = new Uint8Array(await obj.arrayBuffer());
  if (bytes.byteLength !== size || (await sha256Hex(bytes)) !== sha256) throw new StorageError('integrity_failed');
  return bytes;
}

// Copy the user's current state to an immutable backup object and verify it by reading it back.
export async function createBackup(env, uid, reason = 'manual') {
  const cur = await env.DB.prepare('SELECT rev, r2_key, size, sha256 FROM state WHERE user_id = ?').bind(uid).first();
  if (!cur) return null;
  const bytes = await readVerified(env, cur.r2_key, cur.sha256, cur.size); // never copy a corrupt source
  const id = randomHex(8);
  const now = nowSec();
  const key = `users/${uid}/backups/${day(now)}/${id}.json`;
  await env.MEDIA.put(key, bytes, {
    sha256: cur.sha256,
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { sha256: cur.sha256, rev: String(cur.rev), reason },
  });
  try {
    await readVerified(env, key, cur.sha256, cur.size);
  } catch (e) {
    await env.MEDIA.delete(key).catch(() => {});
    throw e;
  }
  await env.DB.prepare('INSERT INTO backups(id, user_id, day, r2_key, size, sha256, rev, reason, created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .bind(id, uid, day(now), key, cur.size, cur.sha256, cur.rev, reason, now).run();
  return { id, day: day(now), rev: cur.rev, size: cur.size, sha256: cur.sha256, reason, createdAt: now };
}

const row = (b) => ({ id: b.id, day: b.day, rev: b.rev, size: b.size, sha256: b.sha256, reason: b.reason, createdAt: b.created_at });

export async function handleBackups(req, env, session, rest) {
  const uid = session.id;
  if (rest === '' || rest === '/') {
    if (req.method === 'GET') {
      const { results } = await env.DB.prepare('SELECT * FROM backups WHERE user_id = ? ORDER BY created_at DESC, id').bind(uid).all();
      return json({ backups: results.map(row), keepDays: KEEP_DAYS });
    }
    if (req.method === 'POST') {
      const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM backups WHERE user_id = ?').bind(uid).first();
      if (n.n >= MAX_BACKUPS) return json({ error: 'too_many_backups' }, 429);
      try {
        const b = await createBackup(env, uid, 'manual');
        return b ? json(b, 201) : json({ error: 'no_state' }, 404);
      } catch (e) {
        if (e instanceof StorageError) return json({ error: 'backup_failed', detail: e.message }, 503);
        throw e;
      }
    }
    return json({ error: 'method' }, 405);
  }
  const m = rest.match(/^\/([a-f0-9]{16})(\/restore|\/verify)?$/);
  if (!m || !ID.test(m[1])) return json({ error: 'not_found' }, 404);
  // looked up by (id AND authenticated user): another user's id behaves as nonexistent
  const b = await env.DB.prepare('SELECT * FROM backups WHERE id = ? AND user_id = ?').bind(m[1], uid).first();
  if (!b) return json({ error: 'not_found' }, 404);

  if (!m[2] && req.method === 'GET') {
    try {
      const bytes = await readVerified(env, b.r2_key, b.sha256, b.size);
      return new Response(bytes, {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="gymmane-backup-${b.day}-${b.id.slice(0, 6)}.json"`,
          'cache-control': 'no-store',
        },
      });
    } catch (e) {
      return json({ error: 'backup_corrupt', detail: e.message }, 500);
    }
  }
  if (!m[2] && req.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM backups WHERE id = ? AND user_id = ?').bind(b.id, uid).run();
    await env.MEDIA.delete(b.r2_key).catch(() => {});
    return json({ ok: true });
  }
  if (m[2] === '/verify' && req.method === 'POST') {
    try {
      await readVerified(env, b.r2_key, b.sha256, b.size);
      return json({ ok: true });
    } catch (e) {
      return json({ ok: false, detail: e.message }, 200);
    }
  }
  if (m[2] === '/restore' && req.method === 'POST') {
    try {
      const bytes = await readVerified(env, b.r2_key, b.sha256, b.size); // refuse a damaged backup
      const cur = await env.DB.prepare('SELECT rev FROM state WHERE user_id = ?').bind(uid).first();
      if (cur) {
        const had = await env.DB.prepare('SELECT 1 AS x FROM backups WHERE user_id = ? AND rev = ?').bind(uid, cur.rev).first();
        if (!had) await createBackup(env, uid, 'pre-restore'); // current data stays recoverable
      }
      const r = await writeState(env, uid, bytes, { baseRev: null, source: 'restore' });
      return json({ ok: true, rev: r.rev });
    } catch (e) {
      if (e instanceof StorageError) return json({ error: 'restore_failed', detail: e.message }, 503);
      throw e;
    }
  }
  return json({ error: 'method' }, 405);
}

async function listAll(env, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await env.MEDIA.list({ prefix, cursor, limit: 1000 });
    out.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

// Daily job: backup changed accounts, then prune. Failures of one user never stop the others,
// and a failed backup never deletes anything older.
export async function dailyJob(env) {
  const report = { backedUp: 0, failed: 0, prunedBackups: 0, prunedVersions: 0, orphans: 0 };
  const now = nowSec();
  const { results: users } = await env.DB.prepare(
    `SELECT s.user_id, s.rev FROM state s JOIN users u ON u.id = s.user_id
     WHERE u.disabled = 0 AND s.rev > COALESCE((SELECT MAX(rev) FROM backups b WHERE b.user_id = s.user_id), 0)`,
  ).all();
  for (const u of users) {
    try {
      await createBackup(env, u.user_id, 'daily');
      report.backedUp++;
    } catch {
      report.failed++;
    }
  }

  // retention: older than KEEP_DAYS, but never the newest backup of a user
  const { results: old } = await env.DB.prepare(
    `SELECT id, r2_key FROM backups b WHERE created_at < ?
     AND id != (SELECT id FROM backups x WHERE x.user_id = b.user_id ORDER BY created_at DESC, id DESC LIMIT 1)`,
  ).bind(now - KEEP_DAYS * 86400).all();
  for (const b of old) {
    try {
      await env.MEDIA.delete(b.r2_key);
      await env.DB.prepare('DELETE FROM backups WHERE id = ?').bind(b.id).run();
      report.prunedBackups++;
    } catch {}
  }

  // state versions older than 2 days (the current one is never touched; backups cover the long term)
  const { results: vers } = await env.DB.prepare(
    `SELECT v.user_id, v.rev, v.r2_key FROM state_versions v JOIN state s ON s.user_id = v.user_id
     WHERE v.saved_at < ? AND v.r2_key != s.r2_key`,
  ).bind(now - 2 * 86400).all();
  for (const v of vers) {
    try {
      await env.MEDIA.delete(v.r2_key);
      await env.DB.prepare('DELETE FROM state_versions WHERE user_id = ? AND rev = ?').bind(v.user_id, v.rev).run();
      report.prunedVersions++;
    } catch {}
  }

  // orphan sweep: state objects not referenced by any version, uploaded more than an hour ago
  const { results: all } = await env.DB.prepare('SELECT id FROM users').all();
  for (const u of all) {
    try {
      const known = new Set((await env.DB.prepare('SELECT r2_key FROM state_versions WHERE user_id = ?').bind(u.id).all()).results.map((r) => r.r2_key));
      for (const o of await listAll(env, `users/${u.id}/state/`)) {
        if (!known.has(o.key) && now - Math.floor(new Date(o.uploaded).getTime() / 1000) > 3600) {
          await env.MEDIA.delete(o.key);
          report.orphans++;
        }
      }
    } catch {}
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM login_attempts WHERE first_at < ?').bind(now - 86400),
  ]);
  return report;
}
