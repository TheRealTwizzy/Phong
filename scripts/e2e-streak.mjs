// Browser E2E for what a rally streak produces, end to end from a real match.
//
// The RULE — a streak counts one player's own consecutive returns and breaks
// only when that player misses — is pinned where it can be pinned exactly:
// src/game/streaks.ts in tests/streaks.test.ts, server/room.ts in
// tests/room.test.ts, the P2P replica in tests/p2pParity.test.ts, and the
// whole relay chain through a real server in tests/duelRecord.test.ts. Every
// one of those was checked by breaking the rule and watching it go red.
//
// Asserting the rule through a browser was tried and deliberately abandoned:
// it needs a real solo rally, a scripted paddle cannot be relied on to produce
// one (a first-to-5 against Rookie goes 5-0 often enough to fail the suite for
// a reason that is not the rule), and TESTING.md is explicit that a flaky
// suite is worse than none. What is left here is what a browser CAN say
// deterministically, and what nothing else covers: a real match, played by a
// real client, lands its streak in the right places and no others.
//
// Run it with `npm run test:e2e` (see scripts/e2e-run.mjs).
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

async function newPlayer(prefix) {
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
  await skipTour(page);
  await page.waitForSelector('#main-menu-screen', { timeout: 10000 });
  return page;
}

console.log('A match banks its streak where it belongs, and carries it onward');

// ---------------------------------------------------------------------------
// A run outlives the match it was built in — and a reload, and the browser's
// memory. This half is deterministic: it needs a stored run and a fresh match,
// not a lucky rally.
// ---------------------------------------------------------------------------
{
  const carrier = await newPlayer('Cry');
  const status = await carrier.evaluate(async () => {
    const res = await fetch('/api/match/record', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerScore: 5, opponentScore: 2, bestStreak: 11, endStreak: 11,
        mode: 'solo', difficulty: 'rookie', isWinner: true, matchKey: 'carry-solo-1',
      }),
    });
    return res.status;
  });
  if (status !== 200) fail(`could not bank a run to carry (status ${status})`);

  // Reloading proves the run is STORED, not remembered by the page.
  await carrier.reload({ waitUntil: 'networkidle' });
  await carrier.waitForSelector('#main-menu-screen', { timeout: 10000 });
  const stored = await carrier.evaluate(async () =>
    (await (await fetch('/api/profile/me')).json()).modeStats
  );
  if (stored?.solo?.currentStreak !== 11) {
    fail(`the run did not survive a reload (${JSON.stringify(stored?.solo)})`);
  }
  ok('a run survives the match it was built in, and a reload');

  await carrier.click('#menu-mode-solo');
  await carrier.waitForSelector('#menu-start-solo', { timeout: 8000 });
  await carrier.click('#menu-start-solo');
  await carrier.waitForSelector('#half-court-canvas', { timeout: 8000 });
  await carrier.click('#btn-show-stats-overlay');
  await carrier.waitForSelector('#court-stats-overlay', { timeout: 5000 });
  await sleep(400);
  const opened = await carrier.evaluate(() => ({
    mine: document.querySelector('#telemetry-my-streak')?.textContent,
    best: document.querySelector('#telemetry-my-best')?.textContent,
    opp: document.querySelector('#telemetry-opp-streak')?.textContent,
  }));
  if (opened.mine !== '11') {
    fail(`a new match started this player from ${opened.mine} instead of their run of 11`);
  }
  // The per-match peak opens AT the carried run — it is genuinely part of the
  // longest streak this match will contain.
  if (opened.best !== '11') fail(`the match peak opened at ${opened.best}, not the carried run`);
  // The opponent is a different opponent, and starts from nothing.
  if (opened.opp !== '0') fail(`the opponent carried a run in too (${opened.opp})`);
  ok('and a new match opens on it, with the opponent starting from nothing');

  // The HUD's Reset restarts the match; it is not a miss, so the run stands
  // where it stands — the same thing Play Again does. Nothing has touched the
  // ball here, so 11 in must be 11 out. Wired straight to onClick, resetMatch
  // was handed the React event as its mode and looked up nothing, so Reset
  // confiscated the run by accident; tidying that to `() => resetMatch()`
  // would instead have RELOADED the stored carry, resurrecting a run the
  // player had already missed away. Neither is what a restart means.
  await carrier.click('#btn-reset-match');
  // A reset closes the telemetry overlay along with everything else it clears.
  await carrier.waitForSelector('#court-stats-overlay', { state: 'detached', timeout: 5000 });
  await carrier.click('#btn-show-stats-overlay');
  await carrier.waitForSelector('#court-stats-overlay', { timeout: 5000 });
  await sleep(400);
  const afterReset = await carrier.evaluate(() => ({
    mine: document.querySelector('#telemetry-my-streak')?.textContent,
    best: document.querySelector('#telemetry-my-best')?.textContent,
  }));
  if (afterReset.mine !== '11') {
    fail(`Reset took the run from 11 to ${afterReset.mine} without a miss`);
  }
  if (afterReset.best !== '11') fail(`Reset reopened the match peak at ${afterReset.best}`);
  ok('and the HUD Reset restarts the match without ending the run');

  // Carrying the run into the restarted match is only half of it — the server
  // has to be told, or a reload before the restarted match finishes puts the
  // pre-Reset run straight back. The case that bites is a miss, which a
  // scripted paddle cannot be relied on to produce; but the REPORT itself is
  // testable without one. Knock the stored run out of step through the real
  // route, press Reset, and the page must have put it back.
  const storedSolo = async (page) =>
    page.evaluate(async () => {
      const p = await (await fetch('/api/profile/me')).json();
      return p.modeStats?.solo?.currentStreak ?? null;
    });
  await carrier.evaluate(() =>
    fetch('/api/profile/me/streak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'solo', endStreak: 3 }),
    }).then((r) => r.json())
  );
  if ((await storedSolo(carrier)) !== 3) fail('could not knock the stored run out of step');

  await carrier.click('#btn-reset-match');
  await carrier.waitForSelector('#court-stats-overlay', { state: 'detached', timeout: 5000 });
  await sleep(600);
  const reportedAfterReset = await storedSolo(carrier);
  if (reportedAfterReset !== 11) {
    fail(`Reset did not tell the server where the run stands (server says ${reportedAfterReset})`);
  }
  ok('and tells the server where the run stands, so a reload cannot undo it');

  await carrier.click('#btn-show-stats-overlay');
  await carrier.waitForSelector('#court-stats-overlay', { timeout: 5000 });

  // Quitting an UNFINISHED match ends the run wherever it stands — which for
  // an untouched ball is exactly where it came in. Only a finished match
  // reports itself, so the run has to be remembered on the way out. Same two
  // halves as Reset above, and asserted the same two ways: the run survives
  // the walk out (quitting must not CONFISCATE one either), and the server is
  // told, which is checkable without the miss the first half would need.
  await carrier.evaluate(() =>
    fetch('/api/profile/me/streak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'solo', endStreak: 2 }),
    }).then((r) => r.json())
  );
  await carrier.click('#btn-quit-to-menu');
  await carrier.waitForSelector('#main-menu-screen', { timeout: 8000 });
  await carrier.click('#menu-mode-solo');
  await carrier.waitForSelector('#menu-start-solo', { timeout: 8000 });
  await carrier.click('#menu-start-solo');
  await carrier.waitForSelector('#half-court-canvas', { timeout: 8000 });
  await carrier.click('#btn-show-stats-overlay');
  await carrier.waitForSelector('#court-stats-overlay', { timeout: 5000 });
  await sleep(400);
  const afterQuit = await carrier.evaluate(
    () => document.querySelector('#telemetry-my-streak')?.textContent
  );
  if (afterQuit !== '11') {
    fail(`quitting an unfinished match took the run from 11 to ${afterQuit}`);
  }
  const reportedAfterQuit = await storedSolo(carrier);
  if (reportedAfterQuit !== 11) {
    fail(`quitting did not tell the server where the run stands (server says ${reportedAfterQuit})`);
  }
  ok('and quitting an unfinished match neither ends the run nor forgets to say so');

  // Modes keep their own runs: solo does not seed practice.
  await carrier.click('#btn-quit-to-menu');
  await carrier.waitForSelector('#main-menu-screen', { timeout: 8000 });
  await carrier.click('#menu-mode-practice');
  await carrier.waitForSelector('#menu-start-practice', { timeout: 8000 });
  await carrier.click('#menu-start-practice');
  await carrier.waitForSelector('#half-court-canvas', { timeout: 8000 });
  await sleep(500);
  const wall = await carrier.evaluate(() =>
    document.querySelector('#practice-rally-count')?.textContent
  );
  if (wall !== '0') fail(`the Practice Wall inherited the solo run (opened at ${wall})`);
  ok('and another mode does not inherit it');
}

const page = await newPlayer('Stk');

await page.click('#menu-mode-solo');
await page.waitForSelector('#menu-start-solo', { timeout: 8000 });
await page.click('#menu-start-solo');
await page.waitForSelector('#half-court-canvas', { timeout: 8000 });

// Four readouts, not one. The HUD used to carry a single number that both
// players fed; the telemetry overlay is where you can see there are now two
// streaks and that they are separate fields.
await page.click('#btn-show-stats-overlay');
await page.waitForSelector('#court-stats-overlay', { timeout: 5000 });
const readouts = await page.evaluate(() =>
  ['#telemetry-my-streak', '#telemetry-my-best', '#telemetry-opp-streak', '#telemetry-opp-best']
    .map((id) => document.querySelector(id)?.textContent ?? null)
);
if (readouts.some((r) => r === null)) {
  fail(`the telemetry overlay is missing a streak readout: ${JSON.stringify(readouts)}`);
}
ok('the HUD reports both players’ streaks as separate numbers');

// Hold the paddle aside and serve until the match resolves. Keyboard rather
// than a pointer drag: the window-level handler works in every state, where a
// pointerdown races the serve state machine (see scripts/e2e-gameplay.mjs).
const box = await (await page.$('#half-court-canvas')).boundingBox();
const over = () => page.evaluate(() => !!document.querySelector('#btn-play-again'));
await page.keyboard.down('KeyA');
const deadline = Date.now() + 90000;
while (Date.now() < deadline && !(await over())) {
  await page.mouse.click(box.x + box.width * 0.12, box.y + box.height * 0.9);
  await sleep(600);
}
await page.keyboard.up('KeyA');
if (!(await over())) fail('the match never finished — nothing was recorded');
ok('played a solo match to a result');

await sleep(1500);
const recorded = await page.evaluate(async () => {
  const me = await (await fetch('/api/profile/me')).json();
  return { highestRally: me.highestRally, modeStats: me.modeStats };
});

const solo = recorded.modeStats?.solo;
if (!solo) fail('the match recorded no per-mode row at all');
if (solo.matchesPlayed !== 1) fail(`solo mode row is wrong: ${JSON.stringify(solo)}`);
if (solo.matchesWon + solo.matchesLost !== 1) {
  fail(`the solo row counted neither a win nor a loss: ${JSON.stringify(solo)}`);
}
ok('the match landed in its own mode row');

// The career best and the mode's best come from the same number and must say
// the same thing — a solo match is the only thing this player has ever done.
if (solo.bestStreak !== recorded.highestRally) {
  fail(`the mode row and the career best disagree (${solo.bestStreak} vs ${recorded.highestRally})`);
}
ok('agreeing with the career best');

// And nowhere else: a solo match is not a duel and is not a practice session.
if (recorded.modeStats?.multiplayer) fail('a solo match wrote a duel row');
if (recorded.modeStats?.practice) fail('a solo match wrote a practice row');
ok('and nowhere else');

if (dialogs.length) fail(`unexpected error dialog: ${dialogs.join(' | ')}`);

console.log('\nRALLY STREAK CHECKS PASSED');
await browser.close();
