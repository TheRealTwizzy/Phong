// Browser E2E for a join that is still in flight when the lobby is dismissed.
//
// Asking for a seat and being given one are two different moments, and the
// player can close the lobby in between — a stray tap on the X, or simply
// deciding against it a beat too late. `room_joined` then arrived against a
// shut lobby and seated them anyway: a live court, no Ready control, and a
// host waiting for a readiness they had no way to signal. Neither side could
// move, and only the guest reloading freed the room.
//
// Driven through the TYPED-CODE path with both clicks in one tick, so the
// dismissal is guaranteed to land before the server's answer rather than
// racing it. The bug is in the shared room_joined handling, so an invitation
// link reaches it the same way.
//
// Run it with `npm run test:e2e` (see scripts/e2e-run.mjs), which builds
// nothing but hands this a fresh server, port, DATA_DIR and Chromium.
import { chromium, devices } from 'playwright-core';

const BASE = process.env.E2E_URL || 'http://localhost:3000';
const EXEC = process.env.CHROMIUM_PATH;
if (!EXEC) {
  console.error('Set CHROMIUM_PATH to a Chromium binary.');
  process.exit(2);
}
const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
const ok = (m) => console.log('  ✓', m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });
const dialogs = [];

let seq = 0;
async function newPlayer(prefix) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`PAGE ERROR [${prefix}]:`, e.message));
  page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  const sim = await page.$('#simulate-smartphone-btn');
  if (sim) await sim.click();
  await page.waitForSelector('#onboarding-modal-overlay', { timeout: 10000 });
  await page.fill('#input-onboarding-username', `${prefix}${Date.now().toString(36).slice(-4)}${seq++}`);
  await page.waitForSelector('#username-status-available', { timeout: 8000 });
  await page.click('#btn-onboarding-submit');
  // Onboarding now ends on the sign-in code. Tolerant, so a suite that
  // reaches here another way is not broken by its absence.
  await page.waitForSelector('#btn-onboarding-code-continue', { timeout: 10000 })
    .then((b) => b.click())
    .catch(() => {});
  await page.waitForSelector('#main-menu-screen', { timeout: 10000 });
  return page;
}

console.log('A join in flight survives the lobby being dismissed');

const host = await newPlayer('LbH');
await host.click('#menu-mode-multiplayer');
await host.waitForSelector('#btn-create-room', { timeout: 8000 });
await host.click('#btn-create-room');
await host.waitForSelector('#btn-copy-link', { timeout: 8000 });
const code = await host.evaluate(() => {
  // Read the code from its own element rather than regexing the panel's text
  // for an English label — that coupled the suite to copy that is now
  // translated, and to the label sitting immediately before the code.
  const t = (document.querySelector('#lobby-room-code')?.textContent || '').trim();
  return /^[A-Z0-9]{4}$/.test(t) ? t : null;
});
if (!code) fail('host never got a room code');
ok(`host opened room ${code}`);

// Ask for the seat and shut the lobby in the same tick — the answer cannot
// have arrived yet, so this is the window rather than a race against it.
const guest = await newPlayer('LbG');
await guest.click('#menu-mode-multiplayer');
await guest.waitForSelector('#btn-join-room-submit', { timeout: 8000 });
await guest.fill('#input-room-code', code);
await guest.evaluate(() => {
  document.querySelector('#btn-join-room-submit').click();
  document.querySelector('#btn-close-lobby').click();
});
await sleep(2500);

// `#btn-leave-room` lives INSIDE the lobby, so it cannot tell "no seat" from
// "seat held behind a shut lobby" — which is the whole distinction here. The
// court is what the seat puts on screen either way.
const state = await guest.evaluate(() => ({
  seated: !!document.querySelector('#half-court-canvas'),
  onMenu: !!document.querySelector('#main-menu-screen'),
  lobby: !!document.querySelector('#multiplayer-lobby-modal'),
  ready: !!document.querySelector('#btn-ready-play'),
}));
if (state.onMenu || !state.seated) fail('the join never landed at all — wrong bug reproduced');
ok('the seat was granted even though the lobby had been dismissed');
if (!state.lobby) fail('guest holds a seat with the lobby shut — no way back to it');
if (!state.ready) fail('guest holds a seat but has no Ready control, so the host waits forever');
ok('a seat granted to a shut lobby reopens it, Ready control and all');

// Cosmetics are not the point: the match has to be startable from here.
await guest.click('#btn-ready-play');
await sleep(1200);
const btn = await host.waitForSelector('#btn-ready-play:not([disabled])', { timeout: 8000 }).catch(() => null);
if (!btn) fail('host could not start — the guest never managed to ready up');
await btn.click();
await sleep(2500);
const onCourt = await Promise.all([
  host.evaluate(() => !document.querySelector('#multiplayer-lobby-modal')),
  guest.evaluate(() => !document.querySelector('#multiplayer-lobby-modal')),
]);
if (!onCourt[0] || !onCourt[1]) fail(`both phones did not reach the court (host=${onCourt[0]} guest=${onCourt[1]})`);
ok('the duel starts normally afterwards');

if (dialogs.length) fail(`unexpected error dialog: ${dialogs.join(' | ')}`);

console.log('\nLOBBY DISMISSAL CHECKS PASSED');
await browser.close();
