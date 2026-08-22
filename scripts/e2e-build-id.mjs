// The build identity that force-refreshes session auth on every deployment.
//
// Sessions are minted under a build id and die with it, so shipping a new
// build logs every client in the field out of its SESSION (never its account)
// and each one reloads onto what is actually deployed. That promise is only
// as good as the id: derive it from too little and a deploy goes unnoticed,
// derive it from too much and a routine restart throws everybody out
// mid-match. Four properties, and nothing else covered them — no test
// referenced server/build.ts at all.
//
// Reported by review on #37: hashing the client's index.html alone left a
// SERVER-ONLY deploy — an auth fix, a protocol change, precisely what this
// mechanism exists for — producing the same id as the deploy before it. That
// was fixed before #37 merged; this pins it so it stays fixed.
//
// Runs against real production artifacts: each case is a temp copy of dist/
// with its own `node server.cjs`, so the cases cannot see each other and the
// repo's own dist/ is never mutated. No browser — the id is read from
// /api/health, which serves it unauthenticated.
//
// Run it with `npm run test:e2e` (see scripts/e2e-run.mjs), which builds
// nothing but hands this a fresh server, port, DATA_DIR and Chromium.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
const ok = (m) => console.log('  ✓', m);

const ROOT = path.resolve(process.cwd());
const DIST = path.join(ROOT, 'dist');
for (const f of ['server.cjs', 'index.html']) {
  if (!fs.existsSync(path.join(DIST, f))) fail(`dist/${f} is missing — run \`npm run build\` first`);
}

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

const temps = [];
/** A throwaway copy of the built deployment, optionally mutated first. */
function stageDeployment(label, mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `phong-build-${label}-`));
  temps.push(dir);
  fs.cpSync(DIST, dir, { recursive: true });
  // The bundle is built with --packages=external, and node resolves a CJS
  // require from the SCRIPT's directory chain rather than the cwd, so the copy
  // needs the repo's modules reachable from where it sits.
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  if (mutate) mutate(dir);
  return dir;
}

/** Boot that copy and ask it who it is. */
async function buildIdOf(dir, env = {}) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-build-data-'));
  temps.push(dataDir);
  // BUILD_ID beats the artifacts by design, so an inherited one would answer
  // every case with the same pinned value — the artifact cases would fail
  // having tested nothing. Cases that want it pass it explicitly.
  const inherited = { ...process.env };
  delete inherited.BUILD_ID;
  // Artifact discovery keys off the script's own __dirname, so running the
  // staged copy is what makes it report the staged build.
  const srv = spawn('node', [path.join(dir, 'server.cjs')], {
    cwd: dir,
    env: { ...inherited, NODE_ENV: 'production', PORT: String(port), DATA_DIR: dataDir, ...env },
    stdio: 'ignore',
    detached: true,
  });
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (srv.exitCode !== null) throw new Error(`server exited early (code ${srv.exitCode})`);
      const body = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json()).catch(() => null);
      if (body?.build) return body.build;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error('server never reported a build id');
  } finally {
    const gone = new Promise((r) => srv.once('exit', r));
    try { process.kill(-srv.pid, 'SIGKILL'); } catch { try { srv.kill('SIGKILL'); } catch {} }
    await Promise.race([gone, new Promise((r) => setTimeout(r, 5000))]);
  }
}

console.log('Build identity: what changes it, and what must not');

const pristine = stageDeployment('pristine');

// 1. The same deployment is the same deployment. A container restart or a
//    crash-loop must not read as a new build and evict everyone mid-match.
const first = await buildIdOf(pristine);
const second = await buildIdOf(pristine);
if (!/^[0-9a-f]{12}$/.test(first)) fail(`build id is not 12 hex chars: ${first}`);
if (first !== second) fail(`the same build reported two ids (${first} then ${second}) — a restart would log everyone out`);
ok(`the same deployment keeps one id across restarts (${first})`);

// 2. A SERVER-ONLY change is still a deployment. This is the reported bug.
const serverOnly = stageDeployment('server', (dir) => {
  fs.appendFileSync(path.join(dir, 'server.cjs'), '\n// a server-only change\n');
});
const afterServer = await buildIdOf(serverOnly);
if (afterServer === first) {
  fail('a server-only deploy produced the SAME id — every session in the field would stay valid, which is exactly the case this mechanism exists for');
}
ok(`a server-only change moves the id (${first} -> ${afterServer})`);

// 3. A client-only change is a deployment too.
const clientOnly = stageDeployment('client', (dir) => {
  fs.appendFileSync(path.join(dir, 'index.html'), '\n<!-- a client-only change -->\n');
});
const afterClient = await buildIdOf(clientOnly);
if (afterClient === first) fail('a client-only deploy produced the same id');
if (afterClient === afterServer) fail('client and server changes are not distinguished');
ok(`a client-only change moves the id (${first} -> ${afterClient})`);

// 4. A host that already has an identity worth using wins outright.
const pinned = await buildIdOf(pristine, { BUILD_ID: 'abc123abc123' });
if (pinned !== 'abc123abc123') fail(`BUILD_ID was not honoured verbatim: ${pinned}`);
const hashed = await buildIdOf(pristine, { BUILD_ID: 'v1.2.3-some-image-tag' });
if (!/^[0-9a-f]{12}$/.test(hashed)) fail(`a free-form BUILD_ID was not hashed into shape: ${hashed}`);
if (hashed === first) fail('a free-form BUILD_ID was ignored');
ok('BUILD_ID overrides the artifacts, verbatim when well-formed and hashed when not');

for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
console.log('\nBUILD IDENTITY CHECKS PASSED');
