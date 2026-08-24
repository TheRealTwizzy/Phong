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
// Play first, then the menu. A player who has never hit a ball has no use for
// a rank ring or a task list, so the rudiments come first and the tour of the
// menu comes after — which means the ORDER is part of what ships, not an
// accident of the list. These record when each half was reached.
let firstCourtStep = -1;
let firstMenuOverviewStep = -1;
let matchTerms = null;
let steps = 0;
const LIMIT = 60;
for (; steps < LIMIT; steps++) {
  const here = await page.evaluate(() => ({
    open: !!document.querySelector('#onboarding-tour-card'),
    title: document.querySelector('#onboarding-tour-card h2')?.textContent || '',
    hole: !!document.querySelector('#onboarding-tour-overlay mask rect:nth-child(2)'),
    court: !!document.querySelector('#half-court-canvas'),
    scoreboard: document.querySelector('#scoreboard-header')?.textContent || '',
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
  if (here.court && firstCourtStep < 0) firstCourtStep = steps;
  if (here.court && !matchTerms) matchTerms = here.scoreboard;
  // The menu half is the modals: they are only reachable from the menu, so the
  // first one to open is where the second half begins.
  const inMenuOverview = here.prematch || here.settings || here.profile || here.leaderboard || here.tasks;
  if (inMenuOverview && firstMenuOverviewStep < 0) firstMenuOverviewStep = steps;
  // A step that names an anchor must have found it: a spotlight with no hole
  // is a step pointing at an element id that no longer exists.
  await page.click('#btn-tour-next');
  await sleep(420);
}
if (steps >= LIMIT) fail('the tour never ended');
if (steps < 12) fail(`the tour was only ${steps} steps — it is meant to cover the whole game`);
ok(`it walks ${steps} steps`);

if (firstCourtStep < 0) fail('the tour never opened a court');
if (firstMenuOverviewStep < 0) fail('the tour never opened the menu overview');
if (firstCourtStep > firstMenuOverviewStep) {
  fail(
    `the menu overview came before the match (court at step ${firstCourtStep + 1}, menu at ${firstMenuOverviewStep + 1})`
  );
}
ok(`the match comes first (step ${firstCourtStep + 1}), then the menu (step ${firstMenuOverviewStep + 1})`);

// A short match on the one rung every player has open, whatever their own
// stored settings say — a replay from Settings must not walk a veteran
// through the basics against their own Cyber difficulty at first-to-15.
if (!/rookie/i.test(matchTerms)) fail(`the tour's match was not against Rookie: ${JSON.stringify(matchTerms)}`);
// textContent runs the scoreboard together ("…0:to 3You0"), so the digit is
// followed by a letter and \b does not fire there. Guard against a longer
// number instead, which is the thing actually worth ruling out.
if (!/to\s*3(?!\d)/.test(matchTerms)) fail(`the tour's match was not first to 3: ${JSON.stringify(matchTerms)}`);
ok('and it is a Rookie match, first to 3');

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
// 4b. The scrim is pointer-events-none by design, so the court's own Home and
//     Reset stay live underneath the tour. Tapping Home used to leave the tour
//     on its match steps with no match behind them — every remaining spotlight
//     pointing at an element that was not on the page.
// ---------------------------------------------------------------------------
const wanderer = await onboard('Wnd');
await wanderer.waitForSelector('#onboarding-tour-card', { timeout: 10000 });
// Step 1 is the welcome; step 2 is the first match step.
await wanderer.click('#btn-tour-next');
await wanderer.waitForSelector('#half-court-canvas', { timeout: 8000 });

// Reset is not offered while the tour owns the match. Home is an escape hatch
// and recovers; Reset would only ever undo the frame the step is in the middle
// of describing — the serve step leaves the ball mid-flight and the two after
// it talk about it — so there is nothing there to restart. Checked here, with
// the court actually on screen: after the Home tap below there is no scoreboard
// at all and the assertion would pass for the wrong reason.
if (!(await wanderer.$('#btn-sound-toggle'))) fail('the match HUD is not on screen to check');
if (await wanderer.$('#btn-reset-match')) {
  fail('the HUD offered Reset during the tour, which only breaks the frame it is explaining');
}

// Out from under it, the way a curious player would.
await wanderer.click('#btn-quit-to-menu');
await wanderer.waitForSelector('#main-menu-screen', { timeout: 8000 });
if (!(await wanderer.$('#onboarding-tour-card'))) fail('leaving the court ended the tour');

// The next step is still a match step, so the court has to come back.
await wanderer.click('#btn-tour-next');
const recovered = await wanderer
  .waitForSelector('#half-court-canvas', { timeout: 8000 })
  .then(() => true)
  .catch(() => false);
if (!recovered) fail('the tour carried on through its match steps with no match behind them');
ok('and it puts the court back if the player wanders off it');
await wanderer.context().close();

// ---------------------------------------------------------------------------
// 4d. The scrim is pointer-events-none, so a player can open surfaces the tour
//     did not ask for — Achievements from the tab bar, or a mode's pre-match
//     sheet. Each one, left open, covers the anchor of a later step.
//
//     Two separate probes rather than one heuristic walk: opening the sheet
//     hides the tab bar, so doing both at once quietly tested only the first.
// ---------------------------------------------------------------------------
const meddler = await onboard('Mdl');
await meddler.waitForSelector('#onboarding-tour-card', { timeout: 10000 });

const look = () =>
  meddler.evaluate(() => ({
    open: !!document.querySelector('#onboarding-tour-card'),
    menu: !!document.querySelector('#main-menu-screen'),
    court: !!document.querySelector('#half-court-canvas'),
    sheet: !!document.querySelector('#prematch-modal'),
    achievements: !!document.querySelector('#achievements-modal-container'),
    lobby: !!document.querySelector('#multiplayer-lobby-modal'),
    tasks: !!document.querySelector('#missions-modal-container'),
    leaderboard: !!document.querySelector('#leaderboard-modal-container'),
    profile: !!document.querySelector('#profile-modal-container'),
  }));
// evaluate() rather than click(): the scrim fails Playwright's actionability
// check, and whether IT thinks the control is clickable is not what is being
// tested — a real finger goes through a pointer-events-none overlay anyway.
const poke = (id) =>
  meddler.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.click();
    return true;
  }, id);
const nextStep = async () => { await meddler.click('#btn-tour-next'); await sleep(420); };

// Into the MENU half: the match half has no menu to meddle with.
let sawCourt = false;
for (let i = 0; i < 40; i++) {
  const here = await look();
  if (!here.open) fail('the tour ended before it reached the menu half');
  if (here.court) sawCourt = true;
  if (sawCourt && here.menu) break;
  await nextStep();
}

// Probe 1: a surface the tour did not open must not survive the stage change.
// The stages after this open Tasks, the Leaderboard and Profile, any of which
// would otherwise mount underneath it. Two surfaces, because the rule is
// "every one the tour can reach", not "the ones we happened to think of" —
// the tab bar's Achievements, and the Duel lobby from the modes row.
if (!(await poke('#menu-nav-achievements'))) fail('no Achievements tab to meddle with');
await sleep(300);
if (!(await look()).achievements) fail('could not open Achievements under the tour scrim');
await nextStep();
if ((await look()).achievements) {
  fail('a modal the player opened survived the stage change and covers the next step’s anchor');
}

if (!(await poke('#menu-mode-multiplayer'))) fail('no Duel row to meddle with');
await sleep(300);
if (!(await look()).lobby) fail('could not open the Duel lobby under the tour scrim');
await nextStep();
if ((await look()).lobby) {
  fail('the Duel lobby the player opened survived the stage change and covers the next step’s anchor');
}

// Probe 2: the pre-match sheet. Tapping a mode row still sets the menu's own
// prematchMode — that is local state and nothing stops it — but while the tour
// is running the tour's choice is the ONLY one, so no sheet appears here and
// none appears later either. A nullish fallback instead of that rule showed it
// immediately, and kept showing it once the tour's own pre-match step had
// passed, over the tab bar and every modal stage after it.
if (!(await poke('#menu-mode-solo'))) fail('no Solo row to meddle with');
await sleep(300);
if ((await look()).sheet) {
  fail('a mode row tapped under the scrim opened a sheet the tour had not asked for');
}

let sheetOverModal = false;
for (let i = 0; i < 40; i++) {
  const here = await look();
  if (!here.open) break; // once the tour ends, the player's own sheet is their own tap
  if (here.sheet && (here.tasks || here.leaderboard || here.profile)) sheetOverModal = true;
  await nextStep();
}
if (sheetOverModal) fail('the pre-match sheet the player opened covered a later step’s modal');
ok('and a surface the player opened under the scrim never covers a later step');
await meddler.context().close();

// ---------------------------------------------------------------------------
// 4c. The tour runs on teaching terms, not the player's. A replay after they
//     have tuned their own rules would demonstrate a serve at their serve
//     power and a paddle at their paddle size — and, if they had turned the
//     sonar or the radar off, the radar step would spotlight an element that
//     is not rendered at all.
// ---------------------------------------------------------------------------
const tuner = await onboard('Tun');
await tuner.waitForSelector('#onboarding-tour-card', { timeout: 10000 });
await tuner.click('#btn-tour-skip');
await tuner.click('#btn-tour-skip-confirm');
await tuner.waitForSelector('#main-menu-screen', { timeout: 8000 });

// Everything the tour's match steps depend on, turned off — through the same
// localStorage the app reads its settings back from on load.
await tuner.evaluate(() => {
  const s = JSON.parse(localStorage.getItem('half_pong_settings') || '{}');
  s.showRadar = false;
  s.winningScore = 15;
  s.rules = { ...(s.rules || {}), opponentSonar: false, paddleScale: 0.6, servePowerMax: 1.4 };
  localStorage.setItem('half_pong_settings', JSON.stringify(s));
});
await tuner.reload({ waitUntil: 'networkidle' });
await tuner.waitForSelector('#main-menu-screen', { timeout: 10000 });

// Replay it from Settings, the way an existing player would.
await tuner.click('#menu-nav-settings');
await tuner.waitForSelector('#btn-settings-start-tour', { timeout: 8000 });
await tuner.click('#btn-settings-start-tour');
await tuner.waitForSelector('#onboarding-tour-card', { timeout: 8000 });

// Walk it, and the radar has to appear at some point regardless.
let radarSeen = false;
let tunerTerms = null;
for (let i = 0; i < 60; i++) {
  const here = await tuner.evaluate(() => ({
    open: !!document.querySelector('#onboarding-tour-card'),
    radar: !!document.querySelector('#radar-preview-container'),
    scoreboard: document.querySelector('#scoreboard-header')?.textContent || '',
    court: !!document.querySelector('#half-court-canvas'),
  }));
  if (!here.open) break;
  if (here.radar) radarSeen = true;
  if (here.court && !tunerTerms) tunerTerms = here.scoreboard;
  await tuner.click('#btn-tour-next');
  await sleep(420);
}
if (!radarSeen) fail('the radar step spotlighted nothing for a player who had turned the radar off');
if (!/to\s*3(?!\d)/.test(tunerTerms || '')) {
  fail(`the replayed tour used the player's own winning score: ${JSON.stringify(tunerTerms)}`);
}
ok('a replay ignores the player\u2019s own rules and shows the radar anyway');
await tuner.context().close();

// ---------------------------------------------------------------------------
// 4e. A room REQUEST is not a room, and that is the hole. Between tapping
//     Create and the relay answering, roomId is still null — so the lobby
//     dismisses without a confirmation and the player is back on a menu that
//     looks idle. Starting the tour there let the seat arrive underneath it,
//     and the match stage then switched to Solo without ever leaving the room:
//     relay seat still held, code possibly already sent to somebody.
// ---------------------------------------------------------------------------
const racer = await onboard('Rce');
await racer.waitForSelector('#onboarding-tour-card', { timeout: 10000 });
await racer.click('#btn-tour-skip');
await racer.click('#btn-tour-skip-confirm');
await racer.waitForSelector('#main-menu-screen', { timeout: 8000 });

// Ask for a room and shut the lobby in the same tick, so the answer cannot
// have arrived: this is the window itself, not a race against it.
await racer.click('#menu-mode-multiplayer');
await racer.waitForSelector('#btn-create-room', { timeout: 8000 });
await racer.evaluate(() => {
  document.querySelector('#btn-create-room').click();
  document.querySelector('#btn-close-lobby').click();
});

// Straight to Settings and replay, before the relay comes back.
await racer.evaluate(() => {
  document.querySelector('#menu-nav-settings')?.click();
});
const replay = await racer.waitForSelector('#btn-settings-start-tour', { timeout: 8000 }).catch(() => null);
if (replay) await racer.evaluate(() => document.querySelector('#btn-settings-start-tour')?.click());
await sleep(3000);

const raced = await racer.evaluate(async () => ({
  tour: !!document.querySelector('#onboarding-tour-card'),
  lobby: !!document.querySelector('#multiplayer-lobby-modal'),
  code: (document.querySelector('#lobby-room-code')?.textContent || '').trim(),
}));
// Either outcome is fine on its own — the tour refused and the room landed, or
// the tour ran and the room was let go. What must never happen is BOTH: a tour
// running over a seat the relay is still holding.
if (raced.tour && raced.code) {
  fail(`the tour started over an outstanding room request and kept the seat (${raced.code})`);
}
// And whichever way it went, the room must not be orphaned: if a code exists,
// the player is in the lobby holding it and can leave.
if (raced.code && !raced.lobby) fail('a room was created with no lobby to leave it from');
ok('and it never runs on top of a seat the relay is still holding');
await racer.context().close();

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

// A Solo match cannot be started from under it either. The tour's match stage
// adopts and resets whatever it finds, so a match started this way would not
// be recorded — but it would still be a match the tour did not put there, on a
// court the tour is not describing yet. Both guards exist; this pins the one
// that keeps the court empty until the tour asks for it.
await skipper.click('#btn-close-lobby').catch(() => {});
await sleep(300);
// Dispatched rather than clicked: the tour CARD sits over part of the menu, so
// Playwright's actionability check refuses some of these. The card moves from
// step to step and the scrim is pointer-events-none, so which controls are
// reachable depends on where the tour has got to — dispatching asks the
// question the guard is actually for ("what if the player does reach it")
// without depending on that.
await skipper.evaluate(() => {
  document.querySelector('#menu-mode-solo')?.click();
});
await sleep(600);
await skipper.evaluate(() => {
  document.querySelector('#menu-start-solo')?.click();
});
await sleep(1000);
if (await skipper.$('#half-court-container')) {
  fail('a Solo match was started from under the tour, on a court it had not reached');
}
ok('and no Solo match either');

if (dialogs.length) fail(`unexpected error dialog: ${dialogs.join(' | ')}`);

console.log('\nONBOARDING TOUR CHECKS PASSED');
await browser.close();
