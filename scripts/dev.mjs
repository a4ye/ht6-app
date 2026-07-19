// One-command dev: boots the custody service (:8787) and the main server (:4000)
// together, auto-wiring the main server to the local custody URL. Ctrl+C stops both.
//
//   npm run dev
//
// The custody service reads its own custody/.env (Unifold key, treasury,
// CRYPTO_SERVICE_TOKEN, CRYPTO_STORE_BACKEND=json, NODE_ENV=development). This
// script reuses that same CRYPTO_SERVICE_TOKEN for the main server so the two
// agree without a second copy. If custody/.env is missing or has no valid token,
// the main server still starts — it just reports crypto disabled (the wallet UI
// stays dark) until you add one. See docs/unifold-deposit-runbook.md.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseDotenv(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    out[key] = value;
  }
  return out;
}

const custodyDir = join(root, 'custody');
const serverDir = join(root, 'server');
const custodyEnv = parseDotenv(join(custodyDir, '.env'));

const CRYPTO_API_URL = process.env.CRYPTO_API_URL || 'http://localhost:8787';
const CRYPTO_SERVICE_TOKEN =
  process.env.CRYPTO_SERVICE_TOKEN || custodyEnv.CRYPTO_SERVICE_TOKEN || '';

for (const [name, dir] of [['custody', custodyDir], ['server', serverDir]]) {
  if (!existsSync(join(dir, 'node_modules'))) {
    console.log(`[dev] ${name}: node_modules missing — run \`npm --prefix ${name === 'server' ? 'server' : 'custody'} install\` first.`);
  }
}
if (!process.env.MONGODB_URI) {
  console.log(
    '[dev] main server expects MongoDB at mongodb://127.0.0.1:27017 (set MONGODB_URI to override) — e.g. `docker run -d -p 27017:27017 mongo:7`.',
  );
}
if (CRYPTO_SERVICE_TOKEN.length < 32) {
  console.log(
    '[dev] No valid CRYPTO_SERVICE_TOKEN in custody/.env (need >=32 chars) — the main server will run with crypto DISABLED until you add one. See docs/unifold-deposit-runbook.md.',
  );
} else {
  console.log(`[dev] main server wired to custody at ${CRYPTO_API_URL}`);
}

const children = [];
let shuttingDown = false;

function launch(name, color, command, args, opts = {}) {
  const child = spawn(command, args, {
    cwd: opts.cwd || root,
    env: { ...process.env, ...(opts.env || {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tag = `\x1b[${color}m[${name}]\x1b[0m `;
  const prefix = (stream, out) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) out.write(tag + line + '\n');
    });
  };
  prefix(child.stdout, process.stdout);
  prefix(child.stderr, process.stderr);
  child.on('exit', (code, signal) => {
    process.stdout.write(tag + `exited (${signal || `code ${code}`})\n`);
    if (!shuttingDown) {
      // Keep the other process alive; a crashed custody just means crypto is off.
      process.stdout.write(tag + 'not restarting — the other service keeps running.\n');
    }
  });
  children.push(child);
  return child;
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Custody service — reads its own custody/.env; listens on :8787.
launch('custody', '36', 'npm', ['run', 'dev'], { cwd: custodyDir });
// Main server — auto-wired to the local custody service; listens on :4000.
launch('server', '33', 'node', ['index.js'], {
  cwd: serverDir,
  env: { CRYPTO_API_URL, CRYPTO_SERVICE_TOKEN },
});
