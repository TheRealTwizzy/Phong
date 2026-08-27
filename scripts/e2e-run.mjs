// Runs the browser E2E suites in scripts/e2e-*.mjs against a real server.
//
// Each suite wants a server of its own on a fresh DATA_DIR — they mint
// profiles, claim usernames and read the leaderboard, so a shared database
// would let one suite's players decide another suite's assertions. This
// harness gives every suite a free port, a throwaway DATA_DIR and a fresh
// `node dist/server.cjs`, then reports the lot.
//
// Usage:
//   node scripts/e2e-run.mjs                 # every suite
//   node scripts/e2e-run.mjs duel invite     # only the named ones
//   node scripts/e2e-run.mjs --list
//
// Chromium comes from CHROMIUM_PATH, else Playwright's own download, else a
// system Chrome; `npx playwright-core install chromium` is the CI route.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// `ownsServer` suites start and stop their own — e2e-eject kills the server
// under a live duel, which is the whole point of it. `needsBrowser` is the
// default; build-id reads /api/health and drives no page, so asking it to
// find a Chromium it will never launch is a install step for nothing.
const SUITES = [
  { name: 'profiles', ownsServer: false },
  { name: 'venues', ownsServer: false },
  { name: 'gameplay', ownsServer: false },
  { name: 'rating', ownsServer: false },
  { name: 'rules', ownsServer: false },
  { name: 'achievements', ownsServer: false },
  { name: 'elite', ownsServer: false },
  { name: 'duel', ownsServer: false },
  { name: 'invite', ownsServer: false },
  { name: 'lobby', ownsServer: false },
  { name: 'split', ownsServer: false },
  { name: 'streak', ownsServer: false },
  { name: 'history', ownsServer: false },
  { name: 'tutorial', ownsServer: false },
  { name: 'delete', ownsServer: false },
  { name: 'eject', ownsServer: true },
  { name: 'build-id', ownsServer: true, needsBrowser: false },
];

const argv = process.argv.slice(2);
if (argv.includes('--list')) {
  for (const s of SUITES) console.log(s.name);
  process.exit(0);
}
const wanted = argv.filter((a) => !a.startsWith('-'));
const unknown = wanted.filter((w) => !SUITES.some((s) => s.name === w));
if (unknown.length) {
  console.error(`Unknown suite(s): ${unknown.join(', ')}. Known: ${SUITES.map((s) => s.name).join(', ')}`);
  process.exit(2);
}
const suites = wanted.length ? SUITES.filter((s) => wanted.includes(s.name)) : SUITES;

// --- Chromium ------------------------------------------------------------
const exists = (p) => { try { return !!p && fs.statSync(p).isFile(); } catch { return false; } };

function scanPlaywrightCache() {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), '.cache', 'ms-playwright'),
    path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'),
  ].filter(Boolean);
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root); } catch { continue; }
    // Newest revision first, so a cache holding several is unambiguous.
    const revs = entries.filter((e) => /^chromium-\d+$/.test(e))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const rev of revs) {
      for (const dir of ['chrome-linux64', 'chrome-linux']) {
        const p = path.join(root, rev, dir, 'chrome');
        if (exists(p)) return p;
      }
      const mac = path.join(root, rev, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
      if (exists(mac)) return mac;
    }
    if (exists(path.join(root, 'chromium'))) return path.join(root, 'chromium');
  }
  return null;
}

async function resolveChromium() {
  if (process.env.CHROMIUM_PATH) {
    if (!exists(process.env.CHROMIUM_PATH)) {
      console.error(`CHROMIUM_PATH is set but not a file: ${process.env.CHROMIUM_PATH}`);
      process.exit(2);
    }
    return process.env.CHROMIUM_PATH;
  }
  try {
    const { chromium } = await import('playwright-core');
    // Resolves a path whether or not the revision was ever downloaded.
    const p = chromium.executablePath();
    if (exists(p)) return p;
  } catch { /* fall through to the cache scan */ }
  const scanned = scanPlaywrightCache();
  if (scanned) return scanned;
  for (const p of [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]) if (exists(p)) return p;
  console.error('No Chromium found. Set CHROMIUM_PATH, or run: npx playwright install chromium');
  process.exit(2);
}

// --- Server --------------------------------------------------------------
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

async function waitForHealth(base, child, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) throw new Error(`server exited early (code ${child.exitCode})`);
    const up = await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false);
    if (up) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server never became healthy at ${base}`);
}

// A killed child can outlive its parent handle, so kill the group and wait
// for the exit before deleting the DATA_DIR out from under it.
function stop(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  const done = new Promise((resolve) => child.once('exit', resolve));
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
  return Promise.race([done, new Promise((r) => setTimeout(r, 5000))]);
}

function run(cmd, args, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
    child.on('error', (err) => resolve({ code: 1, out: `${out}\n${err.message}` }));
  });
}

// --- Main ----------------------------------------------------------------
if (!exists(path.join(ROOT, 'dist', 'server.cjs')) || !exists(path.join(ROOT, 'dist', 'index.html'))) {
  console.error('dist/ is missing or incomplete — run `npm run build` first.');
  process.exit(2);
}

// Resolved only if something selected actually launches one, so a run of the
// browser-free suites needs no Chromium at all.
const chromiumPath = suites.some((s) => s.needsBrowser !== false) ? await resolveChromium() : null;
console.log(`Chromium: ${chromiumPath ?? 'not needed for these suites'}`);
console.log(`Suites:   ${suites.map((s) => s.name).join(', ')}\n`);

const results = [];
for (const suite of suites) {
  const file = path.join('scripts', `e2e-${suite.name}.mjs`);
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `phong-e2e-${suite.name}-`));
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    ...(chromiumPath ? { CHROMIUM_PATH: chromiumPath } : {}),
    E2E_URL: base,
    E2E_PORT: String(port),
    DATA_DIR: dataDir,
    PORT: String(port),
  };

  let server = null;
  const started = Date.now();
  process.stdout.write(`▶ ${suite.name} … `);
  let result;
  try {
    if (!suite.ownsServer) {
      server = spawn('node', ['dist/server.cjs'], { cwd: ROOT, env, stdio: 'ignore', detached: true });
      await waitForHealth(base, server);
    }
    result = await run('node', [file], env);
  } catch (err) {
    result = { code: 1, out: `harness: ${err.message}` };
  } finally {
    await stop(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const passed = result.code === 0;
  results.push({ name: suite.name, passed, seconds, out: result.out });
  console.log(passed ? `PASS (${seconds}s)` : `FAIL (${seconds}s, exit ${result.code})`);
  if (!passed) console.log(result.out.split('\n').map((l) => `    ${l}`).join('\n'));
}

const failed = results.filter((r) => !r.passed);
console.log('\n─────────────────────────────');
for (const r of results) console.log(`${r.passed ? '✓' : '✗'} ${r.name.padEnd(14)}${r.seconds}s`);
console.log(`${results.length - failed.length}/${results.length} suites passed`);
process.exit(failed.length ? 1 : 0);
