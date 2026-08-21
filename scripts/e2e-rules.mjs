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

// ---- 1. Rules panel and the ranked/unranked badge ------------------------
const page = await newPlayer('Rules');
await page.click('#menu-mode-solo');
await page.waitForSelector('#menu-rules-toggle', { timeout: 5000 });
let status = (await page.textContent('#menu-rules-status')).trim();
if (!/ranked/i.test(status) || /unranked/i.test(status)) fail(`fresh menu should read ranked, got "${status}"`);
ok(`default rules show as ranked: "${status}"`);

await page.click('#menu-rules-toggle');
await page.waitForSelector('#menu-rules-panel', { timeout: 4000 });
for (const key of ['paddleScale','ballScale','ballSpeedMin','ballSpeedMax','serveAngleMax','servePowerMax']) {
  if (!(await page.$(`#rule-slider-${key}`))) fail(`missing slider for ${key}`);
}
for (const key of ['opponentSonar','trackTelemetry']) {
  if (!(await page.$(`#rule-toggle-${key}`))) fail(`missing toggle for ${key}`);
}
ok('all six physics sliders and the presentation toggles render');

// Widen the paddle -> unranked.
await page.$eval('#rule-slider-paddleScale', (el) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, '1.5');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(400);
status = (await page.textContent('#menu-rules-status')).trim();
if (!/unranked/i.test(status)) fail(`widening the paddle should unrank, got "${status}"`);
ok(`a widened paddle flips the badge: "${status}"`);

// A presentation toggle must NOT unrank.
await page.click('#rule-toggle-trackTelemetry');
await page.waitForTimeout(300);
await page.click('#menu-rules-reset');
await page.waitForTimeout(300);
await page.click('#rule-toggle-opponentSonar');
await page.waitForTimeout(300);
status = (await page.textContent('#menu-rules-status')).trim();
if (/unranked/i.test(status)) fail(`turning sonar off must not unrank: "${status}"`);
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

// ---- 3. Every match is progression: a loss pays real XP ------------------
const loser = await newPlayer('Loser');
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
console.log('\nALL VERIFICATION CHECKS PASSED');
await browser.close();
