// Browser E2E for pre-match match rules, the aimed serve, Practice Wall XP and
// "every match is progression":
//   1. The menu shows a ranked/unranked badge that tracks the rules.
//   2. Changing the PHYSICS unranks the match, and so does the opponent sonar
//      and an unearned difficulty; telemetry and quick chat never do.
//   3. A custom-rules win pays XP but moves no rating.
//   4. A 0-5 loss still pays real XP.
//   5. Practice Wall banks capped XP and records no match.
//   6. The serving joystick: push-up-to-aim serves, and two thumbs work at
//      once — one aims while the other keeps steering the paddle.
// Run it with `npm run test:e2e` (see scripts/e2e-run.mjs), which builds
// nothing but hands this a fresh server, port, DATA_DIR and Chromium.
import { chromium, devices } from 'playwright-core';


// The onboarding tour opens by itself for a player who has never seen it —
// it is part of onboarding now, not a menu row. Every suite past this point
// wants the menu, so it is waved away here. Tolerant: a suite that reaches
// this another way is not broken by its absence.
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
  // Onboarding now ends on the sign-in code. Tolerant, so a suite that
  // reaches here another way is not broken by its absence.
  await page.waitForSelector('#btn-onboarding-code-continue', { timeout: 10000 })
    .then((b) => b.click())
    .catch(() => {});
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
          playerScore: 5, opponentScore: 1, bestStreak: 6, earnedStreak: 6,
          mode: 'solo', difficulty, isWinner: true,
        }),
      });
    await win('rookie');
    await win('pro');
  });


// ---- 1. Rules panel and the ranked/unranked badge ------------------------
const page = await newPlayer('Rules');
await page.click('#building-solo');
await page.click('#room-rookie');
await page.waitForSelector('#menu-rules-toggle', { timeout: 5000 });
// "counts for rank" is a substring of half the UNRANKED lines too ("this
// difficulty never counts for rank"), so the ranked test has to be the ranked
// line itself rather than a phrase both sides share.
const RATES = (s) => /within ranked limits/i.test(s);
const NO_RATE = (s) => !RATES(s);
let status = (await page.textContent('#menu-rules-status')).trim();

// A fresh player can only play Rookie, and Rookie feeds hidden MMR alone — it
// never moves the visible ladder. The badge used to promise "counts for rank"
// anyway, for a match the server was always going to refuse to rate.
if (!NO_RATE(status)) fail(`a Rookie solo match must not read ranked, got "${status}"`);
if (!/difficulty/i.test(status)) fail(`the badge should name the difficulty, got "${status}"`);
ok(`a Rookie solo match reads unranked, and says why: "${status}"`);

// Earn Pro and the same stock rules start counting. Nothing about the RULES
// changed between these two assertions — only the rung being played.
await openLadder(page);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('#main-menu-screen', { timeout: 10000 });
await page.click('#building-solo');
await page.waitForSelector('#room-ai_pro', { timeout: 5000 });
await page.click('#room-ai_pro');
await page.waitForTimeout(300);
status = (await page.textContent('#menu-rules-status')).trim();
if (!RATES(status)) fail(`stock rules on Pro should read ranked, got "${status}"`);
ok(`the same stock rules on an EARNED rung read ranked: "${status}"`);

await page.click('#menu-rules-toggle');
await page.waitForSelector('#menu-rules-panel', { timeout: 4000 });
for (const key of ['paddleScale','ballScale','ballSpeedMin','ballSpeedMax','serveAngleMax','servePowerMax']) {
  if (!(await page.$(`#menu-rule-slider-${key}`))) fail(`missing slider for ${key}`);
}
for (const key of ['opponentSonar','trackTelemetry']) {
  if (!(await page.$(`#menu-rule-toggle-${key}`))) fail(`missing toggle for ${key}`);
}
ok('all six physics sliders and the presentation toggles render');

// The pre-match sheet must survive its own content. Opening the rules used to
// take the whole menu down with it: match settings lived in an accordion
// inside the menu's flex-column scroll region, and the card's `overflow-hidden`
// let the column squash every row to a sliver instead of overflowing. Nothing
// overflowed, so nothing scrolled, and the Start button — last in a clipped
// card — sat ~160px below the viewport with no gesture able to reach it. That
// is why "editing a match setting" read as "this mode cannot be started".
{
  const layout = await page.evaluate(() => {
    const start = document.querySelector('#menu-start-solo');
    const b = start.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    const body = document.querySelector('#prematch-modal-container .scroll-y');
    return {
      startTop: b.top,
      startBottom: b.bottom,
      viewportH: window.innerHeight,
      startReachable: !!(hit && hit.closest('#menu-start-solo')),
      bodyScrolls: body.scrollHeight > body.clientHeight,
      // Every ROOM row behind the sheet keeps its full content height. This
      // selector has to name what is actually on the menu: the rows behind
      // the sheet are the Solo building's rooms now, and a prefix that
      // matches nothing would make this whole assertion pass vacuously —
      // which is the flex-collapse regression going unguarded.
      crushed: [...document.querySelectorAll('[id^="room-"]')]
        .filter((el) => el.clientHeight + 1 < el.scrollHeight)
        .map((el) => `${el.id} ${el.clientHeight}/${el.scrollHeight}`),
    };
  });
  if (layout.startBottom > layout.viewportH || layout.startTop < 0) {
    fail(`Start sits outside the viewport (${layout.startTop}–${layout.startBottom} of ${layout.viewportH})`);
  }
  if (!layout.startReachable) fail('Start is in the layout but nothing can tap it');
  if (!layout.bodyScrolls) fail('the sheet body does not scroll its own overflow');
  if (layout.crushed.length) fail(`menu rows crushed below their content: ${layout.crushed.join(', ')}`);
  ok('with every rule expanded: the sheet body scrolls, Start stays pinned and tappable, the menu behind is intact');
}

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

// Telemetry is free and must stay free.
await page.click('#menu-rules-reset');
await page.waitForTimeout(300);
await page.click('#menu-rule-toggle-trackTelemetry');
await page.waitForTimeout(300);
status = (await page.textContent('#menu-rules-status')).trim();
if (NO_RATE(status)) fail(`the telemetry toggle must not unrank: "${status}"`);
ok('telemetry never costs the match its rating');

// The SONAR is not. The whole game is a blind half-court, so a live mini-map
// of the half you are not allowed to see is the hardest rule in the game
// switched off — it still pays XP, and it costs the rating.
await page.click('#menu-rule-toggle-opponentSonar');
await page.waitForTimeout(300);
status = (await page.textContent('#menu-rules-status')).trim();
if (!NO_RATE(status)) fail(`turning the sonar ON must unrank: "${status}"`);
if (!/sonar/i.test(status)) fail(`the badge should name the sonar, got "${status}"`);
if (!(await page.$('#menu-sonar-unranked-note'))) {
  fail('the sonar toggle should say what it costs, where it is switched');
}
ok(`turning the sonar on unranks the match: "${status}"`);

// And back off puts the rating back — nothing was spent, it is a choice.
await page.click('#menu-rule-toggle-opponentSonar');
await page.waitForTimeout(300);
status = (await page.textContent('#menu-rules-status')).trim();
if (!RATES(status)) fail(`turning the sonar back off should re-rank: "${status}"`);
await page.click('#menu-rules-reset');
await page.waitForTimeout(300);
ok('turning it back off restores the rating');

// ---- 2. A custom-rules match pays XP but moves no rating -----------------
const beforeCustom = await me(page);
const custom = await page.evaluate(async () => {
  const res = await fetch('/api/match/record', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      playerScore: 5, opponentScore: 0, bestStreak: 12, earnedStreak: 12, mode: 'multiplayer', isWinner: true,
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
    playerScore: 5, opponentScore: 3, bestStreak: 14, earnedStreak: 14, mode: 'multiplayer', isWinner: true,
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
  body: JSON.stringify({ playerScore: 0, opponentScore: 5, bestStreak: 2, earnedStreak: 2, mode: 'solo', difficulty: 'pro', isWinner: false }),
})).json());
if (!(loss.earnedXp >= 45)) fail(`a loss paid only ${loss.earnedXp} XP`);
if ((await me(loser)).xp <= before) fail('a loss did not move XP');
ok(`a 0-5 loss to Pro still pays ${loss.earnedXp} XP`);

// ---- 4. Practice Wall banks XP, capped, and records no match -------------
//
// A session reports three numbers: the run's PEAK (carried run included), how
// much of it was EARNED here, and where the run stands. Only the earned figure
// is paid — a rally streak carries between sessions, and the wall is entered
// and left at will, so paying on the peak let a player carry a run in, open
// the wall, leave without touching the ball, and collect for it again.
const drill = (page, body) => page.evaluate(async (b) => (await fetch('/api/practice/record', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(b),
})).json(), body);

const driller = await newPlayer('Drill');
const p1 = await drill(driller, { bestStreak: 40, earnedStreak: 40, endStreak: 40 });
if (!(p1.earnedXp > 0)) fail('practice paid nothing for a 40 streak');
let total = p1.earnedXp;
for (let i = 0; i < 30; i++) {
  total += (await drill(driller, { bestStreak: 400, earnedStreak: 400, endStreak: 400 })).earnedXp;
}
const drillProfile = await me(driller);
if (drillProfile.matchesPlayed !== 0) fail('practice recorded a match');
if (total > 300) fail(`practice paid ${total} XP, past the daily cap`);
ok(`practice banked ${total} XP across 31 sessions (capped), recorded 0 matches`);

// The farm, closed: a session that returned nothing pays nothing, however long
// the run it walked in with.
const farmer = await newPlayer('Farm');
const farmed = await drill(farmer, { bestStreak: 400, earnedStreak: 0, endStreak: 400 });
if (farmed.earnedXp !== 0) {
  fail(`a session that returned nothing still paid ${farmed.earnedXp} XP for a carried run`);
}
const farmProfile = await me(farmer);
if (farmProfile.xp !== 0) fail(`the carried run paid ${farmProfile.xp} XP anyway`);
// And leaving is not missing: the run is still going.
if (farmProfile.modeStats?.practice?.currentStreak !== 400) {
  fail(`leaving the wall ended the run (${JSON.stringify(farmProfile.modeStats?.practice)})`);
}
ok('a session that returned nothing pays nothing, and the run carries on');

// ---- 5. One finger is the paddle, and only ever the paddle -------------
await page.click('#menu-rules-toggle');
await page.click('#menu-start-solo');
await page.waitForTimeout(1200);
const canvasText = await page.evaluate(() => !!document.querySelector('#half-court-canvas'));
if (!canvasText) fail('court did not open');
// The serve prompt and the joystick are drawn to canvas, so the court
// container's own flag is what says whether a serve is still pending. This
// used to be read out of `document.body.textContent`, which canvas text never
// reaches — the check passed no matter what the app did.
const serving = (p) => p.$eval('#half-court-container', (el) => el.dataset.serving === '1');
// The paddle is drawn to canvas too; telemetry is the one place it is legible.
await page.click('#btn-show-stats-overlay');
await page.waitForSelector('#telemetry-paddle-pos', { timeout: 5000 });
const paddleAt = (p) => p.$eval('#telemetry-paddle-pos', (el) => parseInt(el.textContent, 10));
const box = await (await page.$('#half-court-canvas')).boundingBox();
// A lone pointer drags the PADDLE, serve or no serve. It used to be captured
// as the aim joystick, which took the paddle away from the very thumb the
// player was already holding it with when the point ended.
await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.9);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.62, { steps: 10 });
await page.waitForTimeout(200);
const dragged = await paddleAt(page);
if (Math.abs(dragged - 25) > 4) {
  fail(`a lone pointer did not drive the paddle (${dragged}%, wanted ~25)`);
}
await page.mouse.up();
await page.waitForTimeout(400);
if (!(await serving(page))) fail('a one-finger drag served — the first pointer is the paddle');
ok('a lone pointer drives the paddle and never serves');

// Space is the desktop serve, and none of this touches it.
await page.keyboard.press('Space');
await page.waitForTimeout(600);
if (await serving(page)) fail('space did not serve the ball');
ok('space still serves');

// ---- 5b. Two thumbs: the first holds the paddle, the second aims --------
// A player comes into a serve already holding the paddle from the point they
// just lost. A role is the pointer's AGE RANK among the fingers currently
// down: the oldest drives the paddle, always, and the second — while this
// player is serving — is the aim joystick.
//
// It used to be the reverse. The first finger down took the joystick and any
// later one drove the paddle, so the thumb already playing was conscripted
// into aiming and steering was handed to the thumb that came to aim.
//
// Only a browser can say this — and only through CDP, because
// setPointerCapture throws on a synthetic pointer id, so dispatched
// PointerEvents cannot get two fingers onto this canvas at once.
{
  const two = await newPlayer('TwoThumb');
  await two.click('#building-solo');
  await two.click('#room-rookie');
  await two.click('#menu-start-solo');
  await two.waitForSelector('#half-court-canvas', { timeout: 5000 });
  await two.click('#btn-show-stats-overlay');
  await two.waitForSelector('#telemetry-paddle-pos', { timeout: 5000 });

  const cbox = await (await two.$('#half-court-canvas')).boundingBox();
  const cdp = await two.context().newCDPSession(two);
  const touch = (type, points) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: points.map((p) => ({
        x: cbox.x + cbox.width * p.x,
        y: cbox.y + cbox.height * p.y,
        id: p.id,
        radiusX: 5,
        radiusY: 5,
        force: 1,
      })),
    });
  const settle = () =>
    two.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    );

  await settle();
  if (!(await serving(two))) fail('the second court did not open on a serve');

  // Thumb one is down when the serve starts: it is the paddle, and it steers.
  await touch('touchStart', [{ x: 0.5, y: 0.9, id: 1 }]);
  await touch('touchMove', [{ x: 0.35, y: 0.9, id: 1 }]);
  await settle();
  const held = await paddleAt(two);
  if (Math.abs(held - 35) > 4) {
    fail(`the first thumb did not hold the paddle (${held}%, wanted ~35)`);
  }
  ok('the first thumb down holds the paddle, serving or not');

  // Thumb two lands and aims. The paddle must not follow it anywhere.
  await touch('touchStart', [
    { x: 0.35, y: 0.9, id: 1 },
    { x: 0.7, y: 0.7, id: 2 },
  ]);
  await touch('touchMove', [
    { x: 0.35, y: 0.9, id: 1 },
    { x: 0.78, y: 0.45, id: 2 },
  ]);
  await settle();
  const whileAiming = await paddleAt(two);
  if (Math.abs(whileAiming - 35) > 4) {
    fail(`the aiming thumb dragged the paddle (${held}% -> ${whileAiming}%)`);
  }
  if (!(await serving(two))) fail('aiming served the ball before the thumb was lifted');
  ok('a second thumb aims without taking the paddle');

  // And the first thumb keeps steering while the second is still aiming.
  await touch('touchMove', [
    { x: 0.2, y: 0.9, id: 1 },
    { x: 0.78, y: 0.45, id: 2 },
  ]);
  await settle();
  const steered = await paddleAt(two);
  if (Math.abs(steered - 20) > 4) {
    fail(`the paddle thumb stopped steering while aiming (${steered}%, wanted ~20)`);
  }
  ok('the paddle thumb keeps steering while the second aims');

  // Lifting the AIMING thumb is the serve; the paddle thumb stays down.
  //
  // `touchEnd` takes the points being RELEASED, not the ones left active —
  // the opposite of what the protocol's own wording ("Active touch points on
  // the touch device") suggests, and verified against a real Chromium. This
  // suite used to end with `touchEnd([])`, which releases nothing at all; the
  // serve it then asserted was read out of `document.body.textContent`, which
  // canvas text never reaches, so both halves passed no matter what happened.
  await touch('touchEnd', [{ x: 0.78, y: 0.45, id: 2 }]);
  await two.waitForTimeout(700);
  if (await serving(two)) fail('releasing the aiming thumb did not serve');
  const after = await paddleAt(two);
  if (Math.abs(after - 20) > 4) {
    fail(`the paddle jumped when the serve fired (${steered}% -> ${after}%)`);
  }
  ok('releasing the aiming thumb serves, and the paddle never moves for it');
  await two.context().close();
}

if (errs.length) fail(`page errors: ${errs.join(' | ')}`);
// ---- 6. Sonar: opt-in, tracks sides frame-accurately, and owns the net
//         indicators while it runs. Telemetry starts hidden. -------------
{
  const solo = await newPlayer('Sonar');
  await solo.click('#building-solo');
  await solo.click('#room-rookie');
  // The sonar is opt-in now, and opting in costs the match its rating — it
  // draws the half the whole game exists to hide. It used to be on by default,
  // which is why this suite never had to ask for it.
  await solo.click('#menu-rules-toggle');
  await solo.waitForSelector('#menu-rule-toggle-opponentSonar', { timeout: 4000 });
  await solo.click('#menu-rule-toggle-opponentSonar');
  await solo.waitForTimeout(300);
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
  await solo.keyboard.press('Space');
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

  // The two net indicators are suppressed for a match played WITH the sonar —
  // it already draws the whole far half. The rows have to SAY that rather than
  // reading as on while nothing is drawn, and the stored preference is not
  // spent: it comes back by itself the next time the sonar is off.
  await solo.click('#btn-open-settings');
  await solo.waitForSelector('#toggle-opponent-indicator', { timeout: 5000 });
  for (const id of ['#toggle-opponent-indicator', '#toggle-ball-indicator']) {
    if (!(await solo.$eval(id, (el) => el.disabled))) {
      fail(`${id} should be locked while the sonar is on`);
    }
  }
  const lockedNote = await solo.$eval('#toggle-opponent-indicator', (el) =>
    el.closest('div.flex.items-center.justify-between').textContent
  );
  if (!/sonar/i.test(lockedNote)) {
    fail(`the locked indicator rows should say why: "${lockedNote}"`);
  }
  ok('a sonar match locks both net indicators off, and says the sonar owns them');
  await solo.click('#btn-close-settings').catch(() => solo.keyboard.press('Escape'));
  await solo.waitForTimeout(400);

  // Open telemetry mid-match, then start a NEW match: it must be hidden again.
  await solo.click('#btn-show-stats-overlay');
  await solo.waitForSelector('#court-stats-overlay', { timeout: 3000 });
  ok('the player can open telemetry during the match');
  await solo.click('#btn-quit-to-menu');
  // Quitting a solo match a point has been scored in is an abandon, and it
  // asks first. Whether this scripted match HAS a point on the board by now
  // depends on how many balls the AI got back, so the confirmation is walked
  // through when it appears rather than assumed either way — it started
  // appearing here when the AI ladder's floor came up.
  await solo
    .waitForSelector('#quit-confirm-modal', { timeout: 2000 })
    .then(() => solo.click('#btn-quit-confirm'))
    .catch(() => {});
  await solo.waitForSelector('#main-menu-screen', { timeout: 5000 });
  await solo.click('#building-solo');
  await solo.click('#room-rookie');
  await solo.click('#menu-start-solo');
  await solo.waitForSelector('#half-court-canvas', { timeout: 5000 });
  if (await solo.$('#court-stats-overlay')) fail('telemetry stayed open into the next match');
  ok('telemetry resets to hidden for every new match');
}

console.log('\nALL VERIFICATION CHECKS PASSED');
await browser.close();
