// Browser E2E for pre-match match rules, the aimed serve, Practice Wall XP and
// "every match is progression":
//   1. The menu shows a ranked/unranked badge that tracks the rules.
//   2. Changing the PHYSICS unranks the match; presentation toggles never do.
//   3. A custom-rules win pays XP but moves no rating.
//   4. A 0-5 loss still pays real XP.
//   5. Practice Wall banks capped XP and records no match.
//   6. Drag-to-aim serves the ball.
// Requires: `npm i --no-save playwright-core` + CHROMIUM_PATH. Target a running
// PRODUCTION server (NODE_ENV=production) with E2E_URL, fresh DATA_DIR.
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
const errs = [];

async function newPlayer(prefix) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#onboarding-modal-overlay', { timeout: 10000 });
  await page.fill('#input-onboarding-username', `${prefix}${Date.now().toString(36).slice(-5)}`);
  await page.waitForSelector('#username-status-available', { timeout: 6000 });
  await page.click('#btn-onboarding-submit');
  await page.waitForSelector('#main-menu-screen', { timeout: 10000 });
  return page;
}
const me = (p) => p.evaluate(async () => (await fetch('/api/profile/me')).json());

// The achievement tree gates the ladder now: a fresh player can only play
// Rookie, so anything that needs Pro or Cyber has to earn its way there first.
const openLadder = (page) =>
  page.evaluate(async () => {
    const win = (difficulty) =>
      fetch('/api/match/record', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerScore: 5, opponentScore: 1, maxRally: 6,
          mode: 'solo', difficulty, isWinner: true,
        }),
      });
    await win('rookie');
    await win('pro');
  });


// ---- 1. Rules panel and the ranked/unranked badge ------------------------
const page = await newPlayer('Rules');
await page.click('#menu-mode-solo');
await page.waitForSelector('#menu-rules-toggle', { timeout: 5000 });
const RATES = (s) => /counts for rank/i.test(s);
const NO_RATE = (s) => /Past ranked/i.test(s);
let status = (await page.textContent('#menu-rules-status')).trim();
if (!RATES(status)) fail(`fresh menu should read ranked, got "${status}"`);
ok(`default rules show as ranked: "${status}"`);

await page.click('#menu-rules-toggle');
await page.waitForSelector('#menu-rules-panel', { timeout: 4000 });
for (const key of ['paddleScale','ballScale','ballSpeedMin','ballSpeedMax','serveAngleMax','servePowerMax']) {
  if (!(await page.$(`#menu-rule-slider-${key}`))) fail(`missing slider for ${key}`);
}
for (const key of ['opponentSonar','trackTelemetry']) {
  if (!(await page.$(`#menu-rule-toggle-${key}`))) fail(`missing toggle for ${key}`);
}
ok('all six physics sliders and the presentation toggles render');

const setSlider = async (key, value) => {
  await page.$eval(
    `#menu-rule-slider-${key}`,
    (el, v) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, String(v));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    value
  );
  await page.waitForTimeout(400);
  return (await page.textContent('#menu-rules-status')).trim();
};

// A paddle tuned INSIDE its ranked band keeps the match rated: that is the
// whole point of the bands, and the reason these are usable settings rather
// than a novelty that costs you the ladder.
status = await setSlider('paddleScale', 1.15);
if (!RATES(status)) fail(`a paddle at the band edge should still rate, got "${status}"`);
ok(`a paddle tuned inside its band still counts for rank: "${status}"`);

// Pushed past the band, it does not.
status = await setSlider('paddleScale', 1.5);
if (!NO_RATE(status)) fail(`a 150% paddle should stop rating, got "${status}"`);
ok(`a paddle past its band flips the badge: "${status}"`);

// A presentation toggle must NOT unrank.
await page.click('#menu-rule-toggle-trackTelemetry');
await page.waitForTimeout(300);
await page.click('#menu-rules-reset');
await page.waitForTimeout(300);
await page.click('#menu-rule-toggle-opponentSonar');
await page.waitForTimeout(300);
status = (await page.textContent('#menu-rules-status')).trim();
if (NO_RATE(status)) fail(`turning sonar off must not unrank: "${status}"`);
ok('presentation toggles never cost the match its rating');

// ---- 2. A custom-rules match pays XP but moves no rating -----------------
const beforeCustom = await me(page);
const custom = await page.evaluate(async () => {
  const res = await fetch('/api/match/record', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      playerScore: 5, opponentScore: 0, maxRally: 12, mode: 'multiplayer', isWinner: true,
      rules: { paddleScale: 1.5 },
    }),
  });
  return res.json();
});
const afterCustom = await me(page);
if (custom.ranked !== false) fail('a custom-rules match reported itself ranked');
if (!(custom.earnedXp > 0)) fail('a custom-rules match paid no XP');
if (afterCustom.rankedGames !== beforeCustom.rankedGames) fail('custom rules moved the rank');
if (afterCustom.xp <= beforeCustom.xp) fail('custom rules paid no XP to the profile');
ok(`custom-rules win: +${custom.earnedXp} XP, rankedGames unchanged at ${afterCustom.rankedGames}`);

// ---- 2b. Rules tuned INSIDE their bands still move the rating ------------
// The bands are what make these settings usable: a player can adjust the feel
// of a match without dropping out of the ladder. Only the extremes cost it.
const tuner = await newPlayer('Tuner');
const beforeTuned = await me(tuner);
const tuned = await tuner.evaluate(async () => (await fetch('/api/match/record', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    playerScore: 5, opponentScore: 3, maxRally: 14, mode: 'multiplayer', isWinner: true,
    rules: { paddleScale: 1.15, ballScale: 0.85, ballSpeedMax: 1.2, servePowerMax: 1.15 },
  }),
})).json());
const afterTuned = await me(tuner);
if (tuned.ranked !== true) fail('a match tuned inside the bands reported itself unranked');
if (afterTuned.rankedGames !== beforeTuned.rankedGames + 1) {
  fail(`a tuned match did not count for rank (${beforeTuned.rankedGames} -> ${afterTuned.rankedGames})`);
}
ok(`four rules tuned inside their bands still counted: rankedGames ${beforeTuned.rankedGames} -> ${afterTuned.rankedGames}`);

// ---- 3. Every match is progression: a loss pays real XP ------------------
const loser = await newPlayer('Loser');
await openLadder(loser);
const before = (await me(loser)).xp;
const loss = await loser.evaluate(async () => (await fetch('/api/match/record', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ playerScore: 0, opponentScore: 5, maxRally: 2, mode: 'solo', difficulty: 'pro', isWinner: false }),
})).json());
if (!(loss.earnedXp >= 45)) fail(`a loss paid only ${loss.earnedXp} XP`);
if ((await me(loser)).xp <= before) fail('a loss did not move XP');
ok(`a 0-5 loss to Pro still pays ${loss.earnedXp} XP`);

// ---- 4. Practice Wall banks XP, capped, and records no match -------------
const driller = await newPlayer('Drill');
const p1 = await driller.evaluate(async () => (await fetch('/api/practice/record', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ bestStreak: 40 }),
})).json());
if (!(p1.earnedXp > 0)) fail('practice paid nothing for a 40 streak');
let total = p1.earnedXp;
for (let i = 0; i < 30; i++) {
  const r = await driller.evaluate(async () => (await fetch('/api/practice/record', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bestStreak: 400 }),
  })).json());
  total += r.earnedXp;
}
const drillProfile = await me(driller);
if (drillProfile.matchesPlayed !== 0) fail('practice recorded a match');
if (total > 300) fail(`practice paid ${total} XP, past the daily cap`);
ok(`practice banked ${total} XP across 31 sessions (capped), recorded 0 matches`);

// ---- 5. The serve prompt now offers aiming ------------------------------
await page.click('#menu-rules-toggle');
await page.click('#menu-start-solo');
await page.waitForTimeout(1200);
const canvasText = await page.evaluate(() => !!document.querySelector('#half-court-canvas'));
if (!canvasText) fail('court did not open');
const box = await (await page.$('#half-court-canvas')).boundingBox();
// Push UP from the paddle to aim, then release to serve. The gesture must
// reach FULL power without leaving the screen: the paddle sits at 90% of the
// court height, so a pull-back gesture had only ~10% of travel below it and
// maximum power was unreachable on a phone.
const startY = box.y + box.height * 0.9;
await page.mouse.move(box.x + box.width * 0.5, startY);
await page.mouse.down();
const fullPowerY = startY - box.height * 0.35;
if (fullPowerY < box.y) fail('a full-power serve gesture runs off the top of the court');
await page.mouse.move(box.x + box.width * 0.62, fullPowerY, { steps: 10 });
await page.waitForTimeout(250);
await page.mouse.up();
await page.waitForTimeout(700);
const served = await page.evaluate(() => !/PUSH UP TO AIM/.test(document.body.textContent));
if (!served) fail('a push-release did not serve the ball');
ok('push-up-to-aim reaches full power on screen and serves');

if (errs.length) fail(`page errors: ${errs.join(' | ')}`);
// ---- 6. Sonar tracks sides frame-accurately; telemetry starts hidden ------
{
  const solo = await newPlayer('Sonar');
  await solo.click('#menu-mode-solo');
  await solo.click('#menu-start-solo');
  await solo.waitForSelector('#half-court-canvas', { timeout: 5000 });

  // Telemetry rule is on by default, but the PANEL starts hidden: only the
  // small opener button is on the court until the player asks for it.
  if (await solo.$('#court-stats-overlay')) fail('telemetry panel visible at match start');
  if (!(await solo.$('#btn-show-stats-overlay'))) fail('no telemetry opener on the court');
  ok('telemetry defaults hidden, with its opener on the court');

  // The sonar exists to show the half you cannot see: with the ball in the
  // player's hand (serve prompt), it must be hidden.
  const opacity = () =>
    solo.$eval('#radar-preview-container', (el) => parseFloat(getComputedStyle(el).opacity));
  await solo.waitForTimeout(400);
  if ((await opacity()) > 0.1) fail('sonar visible while the ball is on the PLAYER side');
  ok('sonar hidden while the ball is in the player\'s view');

  // Serve, then watch a few seconds of real rally: the sonar must appear
  // while the ball is on the opponent's half and vanish when it comes back.
  const box = await (await solo.$('#half-court-canvas')).boundingBox();
  await solo.mouse.click(box.x + box.width / 2, box.y + box.height * 0.9);
  let sawVisible = false;
  let sawHidden = false;
  let lastBallLeft = null;
  let dotMoved = false;
  const until = Date.now() + 9000;
  while (Date.now() < until) {
    const o = await opacity().catch(() => 0);
    if (o > 0.9) {
      sawVisible = true;
      // The dot must actually track between samples — the old radar fed a
      // 75ms CSS transition from throttled state and trailed the ball.
      const left = await solo
        .$$eval('#radar-preview-container .rounded-full.-translate-x-1\\/2', (els) =>
          els.length ? els[0].style.left : null
        )
        .catch(() => null);
      if (left && lastBallLeft && left !== lastBallLeft) dotMoved = true;
      if (left) lastBallLeft = left;
    }
    if (o < 0.1) sawHidden = true;
    if (sawVisible && sawHidden && dotMoved) break;
    await solo.waitForTimeout(100);
  }
  if (!sawVisible) fail('sonar never appeared while the ball was on the opponent half');
  if (!sawHidden) fail('sonar never hid while the ball was on the player half');
  if (!dotMoved) fail('the sonar ball dot never moved between frames');
  ok('sonar appears on the opponent half, hides on the player half, and the dot tracks live');

  // Open telemetry mid-match, then start a NEW match: it must be hidden again.
  await solo.click('#btn-show-stats-overlay');
  await solo.waitForSelector('#court-stats-overlay', { timeout: 3000 });
  ok('the player can open telemetry during the match');
  await solo.click('#btn-quit-to-menu');
  await solo.waitForSelector('#main-menu-screen', { timeout: 5000 });
  await solo.click('#menu-mode-solo');
  await solo.click('#menu-start-solo');
  await solo.waitForSelector('#half-court-canvas', { timeout: 5000 });
  if (await solo.$('#court-stats-overlay')) fail('telemetry stayed open into the next match');
  ok('telemetry resets to hidden for every new match');
}

console.log('\nALL VERIFICATION CHECKS PASSED');
await browser.close();
