// Browser E2E for the ejection notice: the player whose OWN connection dies
// mid-duel is told they were ejected and returned to the menu — not left
// staring at a court that will never move again.
//
// Chromium's offline emulation does not tear down an established WebSocket,
// so this suite owns its server process and kills it under a live duel —
// which is also the real scenario (a deploy drops in-flight matches).
//
// Run it with `npm run test:e2e` (see scripts/e2e-run.mjs), which builds
// nothing but hands this a fresh server, port, DATA_DIR and Chromium.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, devices } from 'playwright-core';

const PORT = process.env.E2E_PORT || '3199';
const BASE = `http://localhost:${PORT}`;
const EXEC = process.env.CHROMIUM_PATH;
if (!EXEC) {
  console.error('Set CHROMIUM_PATH to a Chromium binary.');
  process.exit(2);
}
const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
const ok = (m) => console.log('  ✓', m);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-eject-'));
const srv = spawn('node', ['dist/server.cjs'], {
  env: { ...process.env, NODE_ENV: 'production', PORT, DATA_DIR: dataDir },
  stdio: 'ignore',
});
process.on('exit', () => { try { srv.kill('SIGKILL'); } catch {} });

for (let i = 0; i < 40; i++) {
  const up = await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false);
  if (up) break;
  await new Promise((r) => setTimeout(r, 250));
}

const browser = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });
let n = 0;
// The onboarding tour opens by itself for a player who has never seen it —
// it is part of onboarding now, not a menu row. Every suite past this point
// wants the menu, so it is waved away here. Tolerant: a suite that reaches
// this another way is not broken by its absence.
async function skipTour(page) {
  const card = await page
    .waitForSelector('#onboarding-tour-card', { timeout: 8000 })
    .catch(() => null);
  if (!card) return false;
  await page.click('#btn-tour-skip');
  await page.click('#btn-tour-skip-confirm');
  await page
    .waitForSelector('#onboarding-tour-overlay', { state: 'detached', timeout: 8000 })
    .catch(() => {});
  return true;
}

const newPlayer = async (prefix) => {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  const sim = await page.$('#simulate-smartphone-btn');
  if (sim) await sim.click();
  const modal = await page.waitForSelector('#onboarding-modal-overlay', { timeout: 4000 }).catch(() => null);
  if (modal) {
    await page.fill('#input-onboarding-username', `${prefix}${Date.now().toString(36).slice(-4)}${n++}`);
    await page.waitForSelector('#username-status-available', { timeout: 5000 });
    await page.click('#btn-onboarding-submit');
    // Onboarding now ends on the sign-in code. Tolerant, so a suite that
    // reaches here another way is not broken by its absence.
    await page.waitForSelector('#btn-onboarding-code-continue', { timeout: 10000 })
      .then((b) => b.click())
      .catch(() => {});
    await skipTour(page);
    await page.waitForSelector('#onboarding-modal-overlay', { state: 'detached', timeout: 8000 });
  }
  return page;
};

const host = await newPlayer('EjH');
const guest = await newPlayer('EjG');
// A third player who hosts and is never joined. Their socket dies with
// everyone else's below, which is the same event the room reaper produces for
// a room past its unpaired TTL — it deletes the room and closes the seat's
// socket (that half is pinned in tests/room.test.ts). What is being asserted
// here is the client's half, which used to require an OPPONENT before it
// reacted at all: a host waiting alone was left in a lobby advertising a room
// code the relay no longer knew, so a friend typing it got "room not found"
// while the host still believed they were hosting.
const loner = await newPlayer('EjL');

await host.click('#building-pvp');
await host.click('#room-casual');
await host.waitForSelector('#btn-create-room', { timeout: 5000 });
await host.click('#toggle-p2p input, #toggle-p2p'); // relay only: P2P would outlive it
await host.click('#btn-create-room');
const code = await host
  // The code has its own element; hunting for it by a styling class meant any
  // restyle of the lobby silently broke the lookup.
  .waitForFunction(() => {
    const t = (document.querySelector('#lobby-room-code')?.textContent || '').trim();
    return /^[A-HJ-NP-Z2-9]{4}$/.test(t) ? t : null;
  }, { timeout: 5000 })
  .then((h) => h.jsonValue());

await guest.goto(`${BASE}/?room=${code}`, { waitUntil: 'networkidle' });
const sim2 = await guest.$('#simulate-smartphone-btn');
if (sim2) await sim2.click();
// Following the link IS the join — no button to press (scripts/e2e-invite.mjs
// is where that contract is asserted; here it is just how a guest gets in).
await guest.waitForSelector('#btn-leave-room', { timeout: 8000 });

// The handshake: guest readies, host starts, both lobbies close.
await guest.waitForSelector('#btn-ready-play', { timeout: 8000 });
await guest.click('#btn-ready-play');
const btn = await host.waitForSelector('#btn-ready-play:not([disabled])', { timeout: 8000 });
await btn.click();
for (const p of [host, guest]) {
  await p.waitForSelector('#multiplayer-lobby-modal', { state: 'detached', timeout: 5000 });
  await p.waitForSelector('#half-court-canvas', { timeout: 5000 });
}
ok('duel is live on both phones');

await loner.click('#building-pvp');
await loner.click('#room-casual');
await loner.waitForSelector('#btn-create-room', { timeout: 5000 });
await loner.click('#btn-create-room');
await loner.waitForSelector('#btn-leave-room', { timeout: 8000 });
ok('and a third player is hosting a room nobody has joined');

// The server dies under the match. Every socket closes (code 1001), so BOTH
// players' own connections drop: each must be told and returned to the menu.
srv.kill('SIGTERM');
for (const [page, who] of [[host, 'host'], [guest, 'guest']]) {
  const home = await page
    .waitForSelector('#main-menu-screen', { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  if (!home) fail(`${who} was not returned to the menu when their connection died`);
  if (!(await page.$('#toast-ejected'))) fail(`${who} was never told they were ejected`);
}
ok('both dropped players are told they were ejected and returned to the menu');

// The lone host is the same close and a different sentence: there was no
// match, so "you were removed from the match" would be describing one that
// never existed.
// Longer than the other two, and deliberately: this is the only one of the
// three pages with nothing driving it. The host and guest are mid-duel, so
// their tabs render every frame; the loner has sat idle in a lobby, and
// Chromium throttles an idle tab's rAF — which is what the screen swap
// animates on. Reaching the menu is what is being asserted, not how fast the
// transition paints, and this failed here once in nine runs at 10s.
const lonerHome = await loner
  .waitForSelector('#main-menu-screen', { timeout: 20000 })
  .then(() => true)
  .catch(() => false);
if (!lonerHome) {
  // Say what state they were actually left in. This one has failed
  // intermittently and "did not reach the menu" narrows it to nothing: the
  // close may never have arrived, or it arrived and was swallowed.
  const state = await loner
    .evaluate(() => ({
      lobby: !!document.querySelector('#multiplayer-lobby-modal'),
      court: !!document.querySelector('#half-court-canvas'),
      code: document.querySelector('#lobby-room-code')?.textContent?.trim() || null,
      expired: !!document.querySelector('#toast-room-expired'),
      ejected: !!document.querySelector('#toast-ejected'),
    }))
    .catch((e) => ({ unreadable: String(e) }));
  fail(`the lone host was left in a lobby holding a room that no longer exists: ${JSON.stringify(state)}`);
}
if (!(await loner.$('#toast-room-expired'))) fail('the lone host was not told their room had gone');
if (await loner.$('#toast-ejected')) fail('the lone host was told they were removed from a match they never had');
if (await loner.$('#multiplayer-lobby-modal')) fail('the lobby stayed open over the menu');
ok('and the lone host is told their room expired, not that they were ejected');

await browser.close();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log('\nEJECTION CHECKS PASSED');
