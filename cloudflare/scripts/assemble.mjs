// Builds ./dist = Flutter web build + login page. Usage: node scripts/assemble.mjs [path/to/build/web]
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const web = resolve(process.argv[2] ?? join(root, '..', 'build', 'web'));
if (!existsSync(join(web, 'index.html'))) {
  console.error(`No Flutter web build at ${web}. Run: flutter build web --wasm --release --no-web-resources-cdn --pwa-strategy=none`);
  process.exit(1);
}
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(web, dist, { recursive: true });
cpSync(join(root, 'public'), dist, { recursive: true });
console.log(`dist ready: ${dist}`);
