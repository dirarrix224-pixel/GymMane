import { json, nowSec } from './util.js';

export const MAX_MEDIA = 80 * 1024 * 1024;
const MAX_USER_BYTES = 2 * 1024 * 1024 * 1024;
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;

export const validName = (n) => SAFE.test(n) && !n.includes('..');

export function typeOf(name) {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return (
    {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
      heic: 'image/heic', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
      mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav',
    }[ext] ?? 'application/octet-stream'
  );
}

// The R2 key is derived only from the authenticated user id and a validated name.
const keyOf = (uid, name) => `users/${uid}/media/${name}`;

export async function handleMedia(req, env, session, rawName) {
  let name;
  try {
    name = decodeURIComponent(rawName);
  } catch {
    return json({ error: 'name' }, 400);
  }
  if (!validName(name)) return json({ error: 'name' }, 400);
  const uid = session.id;
  const key = keyOf(uid, name);

  switch (req.method) {
    case 'GET':
    case 'HEAD': {
      const row = await env.DB.prepare('SELECT type FROM media WHERE user_id = ? AND name = ?').bind(uid, name).first();
      if (!row) return json({ error: 'missing' }, 404);
      const obj = await env.MEDIA.get(key);
      if (!obj) return json({ error: 'missing' }, 404);
      return new Response(req.method === 'GET' ? obj.body : null, {
        headers: {
          'content-type': row.type,
          'cache-control': 'private, max-age=31536000, immutable',
          'x-content-type-options': 'nosniff',
          'content-disposition': 'inline',
        },
      });
    }
    case 'PUT': {
      const len = Number(req.headers.get('content-length') ?? NaN);
      if (!Number.isFinite(len)) return json({ error: 'length_required' }, 411);
      if (len > MAX_MEDIA) return json({ error: 'too large', max: MAX_MEDIA }, 413);
      const prev = await env.DB.prepare('SELECT size FROM media WHERE user_id = ? AND name = ?').bind(uid, name).first();
      const used = await env.DB.prepare('SELECT COALESCE(SUM(size),0) AS n FROM media WHERE user_id = ?').bind(uid).first();
      if (used.n - (prev?.size ?? 0) + len > MAX_USER_BYTES) return json({ error: 'quota_exceeded' }, 413);
      let stored;
      try {
        stored = await env.MEDIA.put(key, req.body, { httpMetadata: { contentType: typeOf(name) } });
      } catch {
        return json({ error: 'storage_unavailable' }, 503, { 'retry-after': '5' });
      }
      if (!stored || stored.size !== len) {
        if (!prev) await env.MEDIA.delete(key).catch(() => {});
        return json({ error: 'size_mismatch' }, 400);
      }
      try {
        await env.DB.prepare(
          `INSERT INTO media(user_id, name, size, type, updated_at) VALUES(?,?,?,?,?)
           ON CONFLICT(user_id, name) DO UPDATE SET size = excluded.size, type = excluded.type, updated_at = excluded.updated_at`,
        ).bind(uid, name, len, typeOf(name), nowSec()).run();
      } catch {
        if (!prev) await env.MEDIA.delete(key).catch(() => {});
        return json({ error: 'storage_unavailable' }, 503, { 'retry-after': '5' });
      }
      return json({ ok: true });
    }
    case 'DELETE': {
      // index first: once the row is gone the object is unreachable even if the R2 delete fails
      await env.DB.prepare('DELETE FROM media WHERE user_id = ? AND name = ?').bind(uid, name).run();
      await env.MEDIA.delete(key).catch(() => {});
      return json({ ok: true });
    }
    default:
      return json({ error: 'method' }, 405);
  }
}
