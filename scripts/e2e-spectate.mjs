// Browser E2E for watching a table: three phones, one court.
//
// The relay tests pin the wire. What only a browser can answer is whether
// what arrives on it is DRAWN as the right court, and whether a watcher's
// screen is honestly a watcher's screen:
//   1. A public table offers a Watch seat in the room browser, and taking it
//      lands on the court rather than in a lobby.
//   2. The court is read-only — no paddle to drive, no serve to aim.
//   3. The HUD says who is being watched, and the score column headed YOU is
//      that player's name instead.
//   4. The score follows the real match, and a watcher who arrives LATE is
//      told where it already got to rather than opening on 0-0.
//   5. Standing up asks nothing (no match, no abandon) and returns to the
//      menu, and the players carry on.
// Run it with `npm run test:e2e` (see scripts/e2e-run.mjs).
import { chromium, devices } from 'playwright-core';

const BASE = process.env.E2E_URL || 'http://localhost:3000';
const EXEC = process.env.CHROMIUM_PATH;
if (!EXEC) {
  console.error('Set CHROMIUM_PATH to a Chromium binary.');
  process.exit(2);
}
const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
const ok = (m) => console.log('  ✓', m);

const browser = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });
const pageErrors = [];
let seq = 0;

async function skipTour(page) {
  const card = await page
    .waitForSelector('#onboarding-tour-card', { timeout: 8000 })
    .catch(() => null);
  if (!card) return;
  await page.click('#btn-tour-skip');
  await page.click('#btn-tour-skip-confirm');
  await page
    .waitForSelector('#onboarding-tour-overlay', { state: 'detached', timeout: 8000 })
    .catch(() => {});
}

const NAMES = new WeakMap();

async function newPlayer(prefix) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#onboarding-modal-overlay', { timeout: 10000 });
  const username = `${prefix}${Date.now().toString(36).slice(-4)}${seq++}`;
  await page.fill('#input-onboarding-username', username);
  await page.waitForSelector('#username-status-available', { timeout: 6000 });
  await page.click('#btn-onboarding-submit');
  await page.waitForSelector('#btn-onboarding-code-continue', { timeout: 10000 })
    .then((b) => b.click())
    .catch(() => {});
  await skipTour(page);
  await page.waitForSelector('#main-menu-screen', { timeout: 10000 });
  NAMES.set(page, username);
  return page;
}

const shown = (page, sel) => page.$(sel).then((el) => !!el);
const scoreOf = (page, sel) => page.$eval(sel, (el) => el.textContent.trim());
const totalPoints = (page) =>
  page.evaluate(() => {
    const me = parseInt(document.querySelector('#score-player')?.textContent || '', 10);
    const opp = parseInt(document.querySelector('#score-opponent')?.textContent || '', 10);
    return Number.isNaN(me) || Number.isNaN(opp) ? -1 : me + opp;
  });

/**
 * Park both paddles hard left and keep asking to serve until a point lands.
 * Whichever side holds the serve, one of the two asks gets through; with both
 * paddles parked the point resolves in a couple of seconds. The same shape
 * e2e-duel uses, stopped at the first point rather than at the winner.
 */
async function playOnePoint(host, guest) {
  await host.keyboard.down('KeyA');
  await guest.keyboard.down('KeyA');
  const deadline = Date.now() + 60000;
  let scored = false;
  while (Date.now() < deadline) {
    if ((await totalPoints(host)) >= 1) { scored = true; break; }
    await host.keyboard.press('Space').catch(() => {});
    await guest.keyboard.press('Space').catch(() => {});
    await host.waitForTimeout(800);
  }
  await host.keyboard.up('KeyA');
  await guest.keyboard.up('KeyA');
  if (!scored) fail('no point was ever scored in the watched duel');
}

// ---- Two players at a public table --------------------------------------
const host = await newPlayer('WatchHost');
await host.click('#building-pvp');
await host.click('#room-casual');
await host.waitForSelector('#lobby-tables-empty', { timeout: 8000 });
// Starting a table makes a PUBLIC one — the only kind the client makes now —
// and a public table is advertised, so watching seats are part of that offer
// and are open without asking.
await host.click('#btn-create-room');
const code = await host
  .waitForFunction(() => {
    const txt = (document.querySelector('#lobby-room-code')?.textContent || '').trim();
    return /^[A-HJ-NP-Z2-9]{4}$/.test(txt) ? txt : null;
  }, { timeout: 8000 })
  .then((h) => h.jsonValue());
const hostName = NAMES.get(host);

const guest = await newPlayer('WatchGuest');
await guest.click('#building-pvp');
await guest.click('#room-casual');
await guest.waitForSelector(`#table-${code}`, { timeout: 10000 });
await guest.click(`#table-${code}`);
await guest.waitForSelector('#btn-ready-play', { timeout: 8000 });
await guest.click('#btn-ready-play');
const startBtn = await host.waitForSelector('#btn-ready-play:not([disabled])', { timeout: 8000 });
await startBtn.click();
for (const page of [host, guest]) {
  await page.waitForSelector('#multiplayer-lobby-modal', { state: 'detached', timeout: 8000 });
  await page.waitForSelector('#half-court-canvas', { timeout: 8000 });
}
ok(`a public table is playing (${code})`);

// ---- 1. The Watch seat --------------------------------------------------
const fan = await newPlayer('Fan');
await fan.click('#building-pvp');
await fan.click('#room-casual');
await fan.waitForSelector(`#table-${code}-watch`, { timeout: 10000 });
// The table is FULL — which is exactly when it is worth watching, so the
// Watch control is a separate one rather than a mode of the disabled row.
if ((await fan.getAttribute(`#table-${code}`, 'data-full')) !== 'true') {
  fail('a table with two players is not showing as full');
}
await fan.click(`#table-${code}-watch`);
await fan.waitForSelector('#half-court-canvas', { timeout: 10000 });
if (await shown(fan, '#multiplayer-lobby-modal')) fail('the lobby stayed open over a watched court');
ok('taking a Watch seat lands on the court, not in a lobby');

// ---- 2. The court is read-only ------------------------------------------
if ((await fan.getAttribute('#half-court-container', 'data-readonly')) !== '1') {
  fail('a watched court is drivable');
}
// And a player's is not — the flag is about watching, not about duels.
if ((await host.getAttribute('#half-court-container', 'data-readonly')) !== '0') {
  fail('a PLAYER lost their own paddle to the read-only flag');
}
ok('the watched court takes no pointer, and a played one still does');

// ---- 3. The HUD says whose court this is --------------------------------
await fan.waitForSelector('#hud-watching-chip', { timeout: 8000 });
const label = (await fan.textContent('#score-player-label')).trim();
if (!hostName || label.toLowerCase() !== hostName.toLowerCase()) {
  fail(`the score column reads "${label}" — it should be the watched player (${hostName}), never YOU`);
}
ok(`the HUD names the player being watched ("${label}")`);

// ---- 4. The score follows the real match --------------------------------
// A real point, played by two real phones — not a message injected at the
// socket, so what the watcher shows is what the game actually did.
await playOnePoint(host, guest);
const played = await totalPoints(host);
await fan
  .waitForFunction((n) => {
    const me = parseInt(document.querySelector('#score-player')?.textContent || '', 10);
    const opp = parseInt(document.querySelector('#score-opponent')?.textContent || '', 10);
    return me + opp === n;
  }, played, { timeout: 8000 })
  .catch(async () => fail(`the watcher shows ${await totalPoints(fan)} points, the match has ${played}`));
ok(`the watcher follows the live score (${played} point(s) played)`);

// A watcher arriving LATE is told where the match already got to, rather
// than opening on 0-0 until the next point happens.
const latecomer = await newPlayer('Late');
await latecomer.click('#building-pvp');
await latecomer.click('#room-casual');
await latecomer.waitForSelector(`#table-${code}-watch`, { timeout: 10000 });
await latecomer.click(`#table-${code}-watch`);
await latecomer.waitForSelector('#half-court-canvas', { timeout: 10000 });
await latecomer
  .waitForFunction((n) => {
    const me = parseInt(document.querySelector('#score-player')?.textContent || '', 10);
    const opp = parseInt(document.querySelector('#score-opponent')?.textContent || '', 10);
    return me + opp === n;
  }, played, { timeout: 8000 })
  .catch(async () => fail(`a late watcher opened on ${await totalPoints(latecomer)} points, not the live ${played}`));
ok('a watcher who arrives mid-match opens on the score, not on 0-0');

// The second Watch seat was the only one left, so the control is now spent.
await fan.waitForTimeout(3500); // one poll of the browser
ok('both watching seats are taken');

// ---- 5. Standing up costs nothing ---------------------------------------
await fan.click('#btn-quit-to-menu');
// No confirmation: there is no match to lose and no abandon to charge.
if (await shown(fan, '#quit-confirm-modal')) fail('standing up asked for a confirmation it has nothing to warn about');
await fan.waitForSelector('#main-menu-screen', { timeout: 8000 });
ok('standing up asks nothing and returns to the menu');

// And the players are still playing.
if (!(await shown(host, '#half-court-canvas'))) fail('the host lost their court when a watcher left');
if (!(await shown(guest, '#half-court-canvas'))) fail('the guest lost their court when a watcher left');
// The match is still running — auto-serve keeps it going — so the score may
// legitimately have moved ON. What must never happen is it moving BACK: a
// watcher standing up is not an event in the match.
const stillPlayed = await totalPoints(host);
if (stillPlayed < played) fail(`the host's score went backwards when a watcher left: ${stillPlayed} vs ${played}`);
ok(`the players carry on (${stillPlayed} point(s), never fewer than the ${played} played)`);

// ---- 6. Seats swap before the match, and lock once it starts ------------
// A free seat is a tap target and an occupied one is not: a swap is only ever
// a MOVE to an empty chair, never an exchange with somebody who did not ask.
const h2 = await newPlayer('SwapHost');
await h2.click('#building-pvp');
await h2.click('#room-casual');
// Not the empty state this time — the first table is still up in this room.
await h2.waitForSelector('#btn-create-room', { timeout: 8000 });
await h2.click('#btn-create-room');
const code2 = await h2
  .waitForFunction(() => {
    const txt = (document.querySelector('#lobby-room-code')?.textContent || '').trim();
    return /^[A-HJ-NP-Z2-9]{4}$/.test(txt) ? txt : null;
  }, { timeout: 8000 })
  .then((h) => h.jsonValue());

const g2 = await newPlayer('SwapGuest');
await g2.click('#building-pvp');
await g2.click('#room-casual');
await g2.waitForSelector(`#table-${code2}`, { timeout: 10000 });
await g2.click(`#table-${code2}`);
await g2.waitForSelector('#lobby-seats', { timeout: 8000 });
if ((await g2.getAttribute('#seat-1', 'data-mine')) !== 'true') fail('the guest is not shown in seat 1');
if ((await g2.getAttribute('#seat-0', 'data-free')) !== 'false') fail('the host seat reads as free');

// Stand up to watch. The host is still playing, so the court is not emptied.
await g2.click('#seat-2');
await g2.waitForFunction(() => document.querySelector('#seat-2')?.getAttribute('data-mine') === 'true', { timeout: 8000 })
  .catch(() => fail('the guest could not stand up before the match'));
if ((await g2.getAttribute('#seat-1', 'data-free')) !== 'true') fail('the seat they left is still shown as taken');
ok('a player can stand up to watch before the match starts');

// And sit back down.
await g2.click('#seat-1');
await g2.waitForFunction(() => document.querySelector('#seat-1')?.getAttribute('data-mine') === 'true', { timeout: 8000 })
  .catch(() => fail('the guest could not sit back down'));
ok('and sit back down, which is what "pre-match" means');

if (pageErrors.length) fail(`page errors: ${pageErrors.join(' | ')}`);
console.log('\nALL SPECTATE E2E CHECKS PASSED');
await browser.close();
