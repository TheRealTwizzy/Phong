// Browser E2E for the two ways a lobby gets dismissed.
//
// PART 1 — a HOST walking out of their own room. Dismissing the lobby used to
// only hide the sheet. `room_created` has already flipped the screen to
// 'game', so the host landed alone on a live court: paddle working, serve
// refused (there is no opponent to serve to), and the relay still holding an
// open room whose code they had probably already sent someone. Leaving is now
// a decision, and taking it actually leaves.
//
// PART 2 — a join that is still in flight when the lobby is dismissed.
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
  await skipTour(page);
  await page.waitForSelector('#main-menu-screen', { timeout: 10000 });
  return page;
}

console.log('Leaving a lobby is a decision, and it closes the room');

// A host with nobody else in the room. `roomId` is set, so both the X and the
// Leave button are requests rather than actions.
const solo = await newPlayer('LbX');
await solo.click('#menu-mode-multiplayer');
await solo.waitForSelector('#btn-create-room', { timeout: 8000 });
await solo.click('#btn-create-room');
await solo.waitForSelector('#btn-copy-link', { timeout: 8000 });
const doomed = (await solo.textContent('#lobby-room-code'))?.trim();
if (!/^[A-Z0-9]{4}$/.test(doomed || '')) fail('host never got a room code');
if ((await fetch(`${BASE}/api/room/${doomed}`)).status !== 200) fail(`room ${doomed} was never open`);

await solo.click('#btn-close-lobby');
const confirmed = await solo.waitForSelector('#leave-lobby-confirm-modal', { timeout: 5000 }).catch(() => null);
if (!confirmed) fail('dismissing a lobby with a live room asked nothing — the host is on the court again');
ok('dismissing a lobby with a room open asks first');

// Cancelling has to put them back in the LOBBY, not behind it. This is the
// exact failure being fixed: a court with a paddle and no way to serve.
await solo.click('#btn-leave-lobby-cancel');
await sleep(600);
if (!(await solo.$('#multiplayer-lobby-modal'))) fail('cancelling the prompt still dumped the host on the court');
ok('cancelling keeps them in the lobby');

await solo.click('#btn-close-lobby');
await solo.waitForSelector('#btn-leave-lobby-confirm', { timeout: 5000 });
await solo.click('#btn-leave-lobby-confirm');
await solo.waitForSelector('#main-menu-screen', { timeout: 8000 });
await sleep(800);
const left = await solo.evaluate(() => ({
  lobby: !!document.querySelector('#multiplayer-lobby-modal'),
  court: !!document.querySelector('#half-court-canvas'),
}));
if (left.lobby) fail('confirming left the lobby sheet floating over the menu');
if (left.court) fail('confirming left the court alive behind the menu');
// The room is the point: a code that outlives the player holding it is a code
// somebody else can still be sent.
const after = (await fetch(`${BASE}/api/room/${doomed}`)).status;
if (after !== 404) fail(`room ${doomed} survived its only player leaving (status ${after})`);
ok('confirming returns to the menu and closes the room');

console.log('\nA join in flight survives the lobby being dismissed');

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

// ---------------------------------------------------------------------------
// A guest whose HOST walks out is not left waiting on a room that cannot start.
// Seat 0 is only ever filled by create_room, so a hostless room can never have
// one again: join_room fills seat 1, and start_match is refused to anyone but
// seat 0. The lobby deliberately does not bounce on opponent_left — but that
// is about a host going back to waiting for the next guest, which is the
// opposite situation.
// ---------------------------------------------------------------------------
const host2 = await newPlayer('LbH2');
const guest2 = await newPlayer('LbG2');

await host2.click('#menu-mode-multiplayer');
await host2.waitForSelector('#btn-create-room', { timeout: 8000 });
await host2.click('#btn-create-room');
const code2 = await host2
  .waitForFunction(() => {
    const t = (document.querySelector('#lobby-room-code')?.textContent || '').trim();
    return /^[A-HJ-NP-Z2-9]{4}$/.test(t) ? t : null;
  }, { timeout: 8000 })
  .then((h) => h.jsonValue());

await guest2.goto(`${BASE}/?room=${code2}`, { waitUntil: 'networkidle' });
const sim3 = await guest2.$('#simulate-smartphone-btn');
if (sim3) await sim3.click();
await guest2.waitForSelector('#btn-ready-play', { timeout: 10000 });

// The host leaves, through the confirmation this suite already exercises.
await host2.click('#btn-close-lobby');
await host2.waitForSelector('#btn-leave-lobby-confirm', { timeout: 5000 });
await host2.click('#btn-leave-lobby-confirm');

const guestHome = await guest2
  .waitForSelector('#main-menu-screen', { timeout: 10000 })
  .then(() => true)
  .catch(() => false);
if (!guestHome) fail('the guest was left in a lobby whose room can never start');
if (await guest2.$('#multiplayer-lobby-modal')) fail('the lobby stayed open over the menu');
// And the room goes with them, rather than holding its code until the reaper.
const gone = await guest2.evaluate(
  (c) => fetch(`/api/room/${c}`).then((r) => r.status),
  code2
);
if (gone !== 404) fail(`the hostless room is still open (GET /api/room returned ${gone})`);
ok('a guest whose host walks out is returned to the menu, and the room closes');

if (dialogs.length) fail(`unexpected error dialog: ${dialogs.join(' | ')}`);

console.log('\nLOBBY DISMISSAL CHECKS PASSED');
await browser.close();
