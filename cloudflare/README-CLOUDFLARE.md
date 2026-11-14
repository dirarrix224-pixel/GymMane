# GymMane on Cloudflare (Workers + D1 + R2)

Multi-user web version of GymMane with login. The Android app is untouched (still offline, no internet permission).

Based on GymMane by InlitX (GPL-3.0 + additional terms, see ../ADDITIONAL_TERMS.md). This folder is new code; the Flutter app is unchanged.

## Layout
- `src/` Worker: auth (PBKDF2 + sessions), `/api/state` (rev + 409, JSON in R2), `/api/media/*` (R2), backups, daily cron.
- `migrations/0001_init.sql` D1 schema (pointers, users, sessions, indexes only; no large JSON).
- `public/` login page (AR/EN, RTL, dark/light). `scripts/assemble.mjs` merges it with the Flutter build into `dist/`.
- `test/` 27 tests (`npm test`, Node 22): D1 emulated with real SQLite, R2 in memory.

## Data model
- D1 `state`: one row per user = `rev` + pointer to an immutable R2 object `users/{uid}/state/v{rev}-{random}.json` + sha256.
- Write = (1) put new object in R2 with sha256 check, (2) one atomic D1 batch `UPDATE ... WHERE rev = base`. If (2) loses, the new object is deleted and 409 is returned. The previous version is never touched on write.
- Daily cron (02:17 UTC): backup changed accounts to `users/{uid}/backups/{date}/{id}.json` (verified by read-back), keep 30 days (newest never deleted), prune old versions (>2 days) and orphans (>1 hour).
- R2 keys are built only from the authenticated user id + validated names. The bucket stays private.

## Limits chosen (Workers: 128 MB memory)
State JSON max 25 MB (original server: 64 MB), media max 80 MB per file, 2 GB per user.

## One-time setup (after approval)
```sh
cd cloudflare && npm install
npx wrangler d1 create gymmane-db          # put the id in wrangler.jsonc
npx wrangler r2 bucket create gymmane-media
npx wrangler d1 migrations apply gymmane-db --remote
npx wrangler secret put BOOTSTRAP_TOKEN    # 16+ random chars, never committed
# build: Actions "GymMane web on Cloudflare" -> artifact gymmane-dist (or: flutter build web ... && npm run assemble)
npx wrangler deploy                        # after adding the gym.dirar.me custom-domain route
```
First admin (works only while there are no users):
```sh
curl -X POST https://gym.dirar.me/api/admin/bootstrap -H 'origin: https://gym.dirar.me' -H 'content-type: application/json' \
  -d '{"token":"<BOOTSTRAP_TOKEN>","username":"admin","password":"<12+ chars>"}'
```
Then remove the secret. More users: `POST /api/admin/users` (admin session). Public registration does not exist.
Sign out: open `/login?logout=1`.

## Future phone sync (not implemented)
The phone app has no internet permission, so it cannot talk to this API today. The same `/api/state` contract (rev, 409, merge by the `packages/sync` rules) can later back an opt-in sync in the app.
