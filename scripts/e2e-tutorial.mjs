// Browser E2E for the onboarding tour.
//
// It replaced a four-slide "How to play" deck that taught none of the actual
// game: static CSS dioramas plus a mini court that re-implemented physics
// inline, opt-in from a menu row, never remembered, never shown to a new
// player, and with a finish button promising "+50 XP" that no code anywhere
// awarded.
//
// Four things have to be true and only a browser can say so: it opens by
// itself for a new player, it walks the REAL product (the real menu, the real
// pre-match sheet, a real Solo match frozen mid-frame, the real Settings /
// Profile / Leaderboard / Active Tasks), it grants NOTHING, and it does not
// come back.
//
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });
const dialogs = [];

/** Onboard, and STOP at the menu — deliberately without skipping the tour. */
async function onboard(prefix) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`PAGE ERROR [${prefix}]:`, e.message));
  page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  const sim = await page.$('#simulate-smartphone-btn');
  if (sim) await sim.click();
  await page.waitForSelector('#onboarding-modal-overlay', { timeout: 10000 });
  await page.fill('#input-onboarding-username', `${prefix}${Date.now().toString(36).slice(-4)}`);
  await page.waitForSelector('#username-status-available', { timeout: 8000 });
  await page.click('#btn-onboarding-submit');
  await page.waitForSelector('#btn-onboarding-code-continue', { timeout: 10000 })
    .then((b) => b.click())
    .catch(() => {});
  return page;
}

const me = (page) => page.evaluate(async () => (await fetch('/api/profile/me')).json());

console.log('The onboarding tour walks the real game and gives nothing for it');

// ---------------------------------------------------------------------------
// 1. It opens by itself. The old deck never did, which is why it taught nobody.
// ---------------------------------------------------------------------------
const page = await onboard('Tut');
const card = await page.waitForSelector('#onboarding-tour-card', { timeout: 10000 }).catch(() => null);
if (!card) fail('a brand-new player was never shown the tour');
ok('it opens by itself for a new player');

// ---------------------------------------------------------------------------
// 2. It walks the REAL product. Every stage has to actually be reached — a
//    tour of screenshots would pass a step count and nothing else.
// ---------------------------------------------------------------------------
const seen = { court: false, prematch: false, settings: false, profile: false, leaderboard: false, tasks: false, ball: false };
let steps = 0;
const LIMIT = 60;
for (; steps < LIMIT; steps++) {
  const here = await page.evaluate(() => ({
    open: !!document.querySelector('#onboarding-tour-card'),
    title: document.querySelector('#onboarding-tour-card h2')?.textContent || '',
    hole: !!document.querySelector('#onboarding-tour-overlay mask rect:nth-child(2)'),
    court: !!document.querySelector('#half-court-canvas'),
    prematch: !!document.querySelector('#prematch-modal'),
    settings: !!document.querySelector('#settings-modal-overlay'),
    profile: !!document.querySelector('#profile-modal-container'),
    leaderboard: !!document.querySelector('#leaderboard-modal-container'),
    tasks: !!document.querySelector('#missions-modal-container'),
  }));
  if (!here.open) break;
  if (!here.title.trim()) fail(`step ${steps + 1} rendered no title — a missing i18n key`);
  for (const k of ['court', 'prematch', 'settings', 'profile', 'leaderboard', 'tasks']) {
    if (here[k]) seen[k] = true;
  }
  // A step that names an anchor must have found it: a spotlight with no hole
  // is a step pointing at an element id that no longer exists.
  await page.click('#btn-tour-next');
  await sleep(420);
}
if (steps >= LIMIT) fail('the tour never ended');
if (steps < 15) fail(`the tour was only ${steps} steps — it is meant to cover the whole game`);
ok(`it walks ${steps} steps`);

for (const [k, v] of Object.entries(seen)) {
  if (k === 'ball') continue;
  if (!v) fail(`the tour never reached the ${k} stage`);
}
ok('through the real menu, pre-match sheet, court, settings, profile, leaderboard and tasks');

// ---------------------------------------------------------------------------
// 3. It grants nothing. This is the whole promise: no XP, no progress, and no
//    match recorded for the one it actually played.
// ---------------------------------------------------------------------------
await page.waitForSelector('#main-menu-screen', { timeout: 10000 });
await sleep(1500);
const after = await me(page);
if (after.xp !== 0) fail(`the tour paid ${after.xp} XP`);
if (after.level !== 1) fail(`the tour moved the player to level ${after.level}`);
if (after.matchesPlayed !== 0) fail(`the tour recorded ${after.matchesPlayed} match(es)`);
if (after.highestRally !== 0) fail(`the tour banked a rally streak of ${after.highestRally}`);
if (Object.keys(after.modeStats || {}).length !== 0) {
  fail(`the tour wrote per-mode stats: ${JSON.stringify(after.modeStats)}`);
}
if ((after.achievements || []).length !== 0) {
  fail(`the tour unlocked ${after.achievements.length} achievement(s)`);
}
ok('and grants nothing at all for it');

// ---------------------------------------------------------------------------
// 4. It does not come back — including in a browser that has never seen it,
//    because the flag is on the ACCOUNT, not in this page's memory.
// ---------------------------------------------------------------------------
if (!after.tutorialCompletedAt) fail('finishing the tour was never recorded');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('#main-menu-screen', { timeout: 10000 });
await sleep(1500);
if (await page.$('#onboarding-tour-card')) fail('the tour reopened after a reload');
ok('and does not come back');

// ---------------------------------------------------------------------------
// 5. Skipping counts as seen. A player who waves it away has decided about it.
// ---------------------------------------------------------------------------
const skipper = await onboard('Skp');
await skipper.waitForSelector('#onboarding-tour-card', { timeout: 10000 });
await skipper.click('#btn-tour-skip');
await skipper.waitForSelector('#tour-skip-modal', { timeout: 5000 });
// Cancelling keeps it running — skipping is a decision, not a stray tap.
await skipper.click('#btn-tour-skip-cancel');
await sleep(400);
if (!(await skipper.$('#onboarding-tour-card'))) fail('cancelling the skip prompt ended the tour anyway');
ok('skipping asks first');

await skipper.click('#btn-tour-skip');
await skipper.click('#btn-tour-skip-confirm');
await skipper.waitForSelector('#main-menu-screen', { timeout: 8000 });
await sleep(1500);
if (await skipper.$('#onboarding-tour-card')) fail('the tour survived being skipped');
const skipped = await me(skipper);
if (!skipped.tutorialCompletedAt) fail('skipping the tour was not remembered');
if (skipped.xp !== 0 || skipped.matchesPlayed !== 0) fail('skipping the tour still granted something');
ok('and skipping is remembered, and grants nothing either');

// ---------------------------------------------------------------------------
// 6. It is still reachable afterwards, from Settings.
// ---------------------------------------------------------------------------
await skipper.click('#menu-nav-settings');
await skipper.waitForSelector('#btn-settings-start-tour', { timeout: 8000 });
await skipper.click('#btn-settings-start-tour');
if (!(await skipper.waitForSelector('#onboarding-tour-card', { timeout: 8000 }).catch(() => null))) {
  fail('the tour could not be replayed from Settings');
}
ok('and can be replayed from Settings');

// ---------------------------------------------------------------------------
// 7. But only from the menu. Replaying it out of a live match walked the menu
//    steps over a court nobody had left — anchorless cards over a running
//    game, and a duel silently swapped for the tour's Solo match, leaving the
//    opponent alone in a room that was never told anybody had gone.
// ---------------------------------------------------------------------------
await skipper.click('#btn-tour-skip');
await skipper.click('#btn-tour-skip-confirm');
await skipper.waitForSelector('#main-menu-screen', { timeout: 8000 });

await skipper.click('#menu-mode-solo');
await skipper.waitForSelector('#menu-start-solo', { timeout: 8000 });
await skipper.click('#menu-start-solo');
await skipper.waitForSelector('#half-court-container', { timeout: 8000 });
await skipper.click('#btn-open-settings');
await skipper.waitForSelector('#btn-close-settings', { timeout: 8000 });
if (await skipper.$('#btn-settings-start-tour')) {
  fail('the tour could be replayed from inside a live match');
}
ok('and cannot be started from inside a live match');

// ---------------------------------------------------------------------------
// 8. And no room can be opened from under it. The scrim is deliberately
//    pointer-events-none — the app underneath is the real app and stays
//    usable, which is the point — but a room opened during the tour is one the
//    tour then walks away from: reaching the match stage switches straight to
//    Solo, leaving the relay holding a seat whose code somebody may already
//    have been sent.
// ---------------------------------------------------------------------------
// Section 7 left Settings open over the court.
await skipper.click('#btn-close-settings');
await skipper.waitForSelector('#btn-close-settings', { state: 'detached', timeout: 8000 });
await skipper.click('#btn-quit-to-menu');
await skipper.waitForSelector('#main-menu-screen', { timeout: 8000 });
await skipper.click('#menu-nav-settings');
await skipper.waitForSelector('#btn-settings-start-tour', { timeout: 8000 });
await skipper.click('#btn-settings-start-tour');
await skipper.waitForSelector('#onboarding-tour-card', { timeout: 8000 });

const roomsBefore = await skipper.evaluate(() =>
  fetch('/api/health').then((r) => r.json()).then((h) => h.activeRooms)
);
await skipper.click('#menu-mode-multiplayer');
const createBtn = await skipper
  .waitForSelector('#btn-create-room', { timeout: 4000 })
  .catch(() => null);
if (createBtn) {
  await createBtn.click();
  await sleep(1200);
}
const roomsAfter = await skipper.evaluate(() =>
  fetch('/api/health').then((r) => r.json()).then((h) => h.activeRooms)
);
if (roomsAfter !== roomsBefore) {
  fail(`a room was opened from under the tour (${roomsBefore} → ${roomsAfter})`);
}
ok('and no room can be opened from under it');

if (dialogs.length) fail(`unexpected error dialog: ${dialogs.join(' | ')}`);

console.log('\nONBOARDING TOUR CHECKS PASSED');
await browser.close();
