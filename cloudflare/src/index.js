import { bootstrap, changePassword, createUser, getSession, listUsers, login, logout, setDisabled } from './auth.js';
import { dailyJob, handleBackups } from './backup.js';
import { handleMedia } from './media.js';
import { handleRev, handleState } from './state.js';
import { json } from './util.js';

const VERSION = '1.0.0';
const PUBLIC = new Set(['/login', '/gm-login.js', '/favicon.png', '/manifest.json']);
const isPublicAsset = (p) => PUBLIC.has(p) || p.startsWith('/icons/');

// CSRF: cookies are SameSite=Strict; additionally every state-changing request must be same-origin.
function sameOrigin(req) {
  const o = req.headers.get('origin');
  if (o) return o === new URL(req.url).origin;
  return req.headers.get('sec-fetch-site') === 'same-origin';
}

async function api(req, env, url) {
  const route = url.pathname.slice(5);
  const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (unsafe && !sameOrigin(req)) return json({ error: 'csrf' }, 403);

  if (route === 'health') return json({ ok: true });
  if (route === 'auth/login' && req.method === 'POST') return login(req, env);
  if (route === 'admin/bootstrap' && req.method === 'POST') return bootstrap(req, env);

  const session = await getSession(env, req);
  if (!session) return json({ error: 'unauthorized' }, 401);

  if (route === 'auth/logout' && req.method === 'POST') return logout(req, env, session);
  if (route === 'auth/me') return json({ username: session.username, role: session.role });
  if (route === 'auth/password' && req.method === 'POST') return changePassword(req, env, session);

  if (route.startsWith('admin/')) {
    if (session.role !== 'admin') return json({ error: 'forbidden' }, 403);
    if (route === 'admin/users' && req.method === 'POST') return createUser(req, env);
    if (route === 'admin/users' && req.method === 'GET') return listUsers(env);
    const m = route.match(/^admin\/users\/([a-z0-9._-]{3,32})\/disabled$/);
    if (m && req.method === 'POST') return setDisabled(req, env, session, m[1]);
    return json({ error: 'not found' }, 404);
  }

  if (route === 'info' && req.method === 'GET') {
    const s = await env.DB.prepare('SELECT rev, saved_at, source FROM state WHERE user_id = ?').bind(session.id).first();
    return json({
      app: 'gymmane', version: VERSION, platform: 'cloudflare', rev: s?.rev ?? 0,
      ...(s ? { savedAt: new Date(s.saved_at * 1000).toISOString() } : {}),
      source: s?.source ?? 'none', auth: true, user: session.username,
      sync: { enabled: false },
    });
  }
  if (route === 'rev' && req.method === 'GET') return handleRev(env, session);
  if (route === 'state') return handleState(req, env, session);
  if (route.startsWith('media/')) return handleMedia(req, env, session, route.slice(6));
  if (route === 'backups' || route.startsWith('backups/')) return handleBackups(req, env, session, route.slice(7));
  // the phone-folder (Syncthing) sync of the self-hosted server does not exist on Workers
  if (route === 'sync/scan' || route === 'sync/export') return json({ enabled: false });
  return json({ error: 'not found' }, 404);
}

function withHeaders(res, extra) {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(extra)) r.headers.set(k, v);
  return r;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, env, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, { status: 405 });

      const base = {
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'require-corp',
        'cross-origin-resource-policy': 'same-origin',
      };
      if (url.pathname === '/login') {
        const a = await env.ASSETS.fetch(new Request(new URL('/login.html', url), req));
        return withHeaders(a, { ...base, 'cache-control': 'no-cache', 'x-frame-options': 'DENY' });
      }
      if (!isPublicAsset(url.pathname)) {
        const session = await getSession(env, req);
        if (!session) {
          const wantsHtml = (req.headers.get('accept') || '').includes('text/html');
          return wantsHtml ? Response.redirect(new URL('/login', url).toString(), 302) : new Response('Unauthorized', { status: 401 });
        }
      }
      const a = await env.ASSETS.fetch(req);
      const entry = url.pathname === '/' || /(index\.html|flutter_bootstrap\.js|flutter_service_worker\.js)$/.test(url.pathname);
      return withHeaders(a, { ...base, 'cache-control': entry ? 'no-cache' : 'private, max-age=3600' });
    } catch (e) {
      console.error('unhandled', e?.message);
      return json({ error: 'internal' }, 500);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(dailyJob(env).then((r) => console.log('daily', JSON.stringify(r))));
  },
};
