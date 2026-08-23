// Browser E2E for the achievement tree and the progression gate it enforces:
//   1. A new player has only Rookie and short matches open.
//   2. The server rejects a locked difficulty, not just the menu.
//   3. Beating Rookie opens Pro — and only Pro.
//   4. The tree renders per branch, with deep rungs concealed.
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
const browser = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('#onboarding-modal-overlay', { timeout: 10000 });
await page.fill('#input-onboarding-username', `Tree${Date.now().toString(36).slice(-5)}`);
await page.waitForSelector('#username-status-available', { timeout: 6000 });
await page.click('#btn-onboarding-submit');
// Onboarding now ends on the sign-in code. Tolerant, so a suite that
// reaches here another way is not broken by its absence.
await page.waitForSelector('#btn-onboarding-code-continue', { timeout: 10000 })
  .then((b) => b.click())
  .catch(() => {});
await skipTour(page);
await page.waitForSelector('#main-menu-screen', { timeout: 10000 });

await page.click('#menu-mode-solo');
await page.waitForSelector('#menu-diff-rookie', { timeout: 5000 });
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

const dis = async (sel) => page.$eval(sel, (el) => el.disabled);
if (await dis('#menu-diff-rookie')) fail('Rookie should be open from the start');
if (!(await dis('#menu-diff-pro'))) fail('Pro should be locked for a new player');
if (!(await dis('#menu-diff-cyber'))) fail('Cyber should be locked for a new player');
ok('new player: Rookie open, Pro and Cyber locked');
if (!(await page.$('#menu-diff-pro-lock'))) fail('no lock marker on Pro');
ok('locked difficulties show a lock');
if (await dis('#menu-pts-3') || await dis('#menu-pts-5')) fail('short matches should be open');
if (!(await dis('#menu-pts-10')) || !(await dis('#menu-pts-15'))) fail('long matches should be locked');
ok('short matches open, long matches locked');

// The server enforces it too, not just the menu.
const blocked = await page.evaluate(async () => {
  const r = await fetch('/api/match/record', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerScore: 5, opponentScore: 0, maxRally: 8, mode: 'solo', difficulty: 'cyber', isWinner: true }) });
  return { status: r.status, body: await r.text() };
});
if (blocked.status !== 403) fail(`server let a locked difficulty through: ${blocked.status}`);
ok(`server rejects a locked difficulty (${blocked.status} ${JSON.parse(blocked.body).error})`);

// Beat Rookie -> Pro opens.
await page.evaluate(async () => {
  await fetch('/api/match/record', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerScore: 5, opponentScore: 1, maxRally: 8, mode: 'solo', difficulty: 'rookie', isWinner: true }) });
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('#main-menu-screen', { timeout: 8000 });
await page.click('#menu-mode-solo');
await page.waitForSelector('#menu-diff-pro', { timeout: 5000 });
if (await dis('#menu-diff-pro')) fail('beating Rookie did not open Pro');
if (!(await dis('#menu-diff-cyber'))) fail('beating Rookie should not open Cyber');
ok('beating Rookie opens Pro, and only Pro');

// A single Pro win used to hand over Cyber in a first session. It now needs
// ten Pro wins AND level 10 — a climb, not an accident.
await page.evaluate(async () => {
  await fetch('/api/match/record', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerScore: 5, opponentScore: 2, maxRally: 8, mode: 'solo', difficulty: 'pro', isWinner: true }) });
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('#main-menu-screen', { timeout: 8000 });
await page.click('#menu-mode-solo');
await page.waitForSelector('#menu-diff-cyber', { timeout: 5000 });
if (!(await dis('#menu-diff-cyber'))) fail('one Pro win should NOT open Cyber');
ok('one Pro win does not open Cyber');

const proProfile = await page.evaluate(async () => (await fetch('/api/profile/me')).json());
for (let i = 0; i < 60; i++) {
  const p = await page.evaluate(async () => (await fetch('/api/profile/me')).json());
  if (p.achievements.includes('ai_pro_10')) break;
  await page.evaluate(async () => {
    await fetch('/api/match/record', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerScore: 5, opponentScore: 2, maxRally: 8, mode: 'solo', difficulty: 'pro', isWinner: true }) });
  });
}
const climbed = await page.evaluate(async () => (await fetch('/api/profile/me')).json());
if (!climbed.achievements.includes('ai_pro_10')) fail('the Cyber gate never opened over 60 Pro wins');
if (climbed.level < 10) fail(`the level gate was not enforced (level ${climbed.level})`);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('#main-menu-screen', { timeout: 8000 });
await page.click('#menu-mode-solo');
await page.waitForSelector('#menu-diff-cyber', { timeout: 5000 });
if (await dis('#menu-diff-cyber')) fail('the full climb did not open Cyber');
ok(`Cyber opens after the climb: ${climbed.proWins} Pro wins, level ${climbed.level} (was ${proProfile.level})`);
if (await dis('#menu-pts-10')) fail('a first win should open first-to-10');
ok('a first win opens longer matches');

// Achievement tree renders with branches and hidden rungs.
// The difficulty and match-length pickers above live in solo's pre-match
// sheet, which covers the tab bar the way the duel lobby always has. Close it
// before navigating — the fallback that used to be here reached for a
// #menu-nav-trophies that has never existed, so an intercepted click came
// back as a 30s timeout naming the wrong element.
await page.click('#btn-close-prematch');
await page.waitForSelector('#prematch-modal', { state: 'detached', timeout: 4000 });
await page.click('#menu-nav-achievements');
await page.waitForSelector('#ach-branch-ladder', { timeout: 5000 });
for (const b of ['foundation','rally','ladder','duel','craft','ascent','dominion','devotion']) {
  if (!(await page.$(`#ach-branch-${b}`))) fail(`missing branch tab ${b}`);
}
ok('all eight branch tabs render');

// Concealed branches: the tab is a lock, and opening it explains what to do.
const locked = await page.$eval('#ach-branch-ascent', (el) => el.getAttribute('data-locked'));
if (locked !== 'true') fail('Ascent should be concealed for a player who has never duelled');
const openTab = await page.$eval('#ach-branch-ladder', (el) => el.getAttribute('data-locked'));
if (openTab !== 'false') fail('Ladder should be open from the start');
await page.click('#ach-branch-ascent');
await page.waitForSelector('#ach-branch-locked', { timeout: 4000 });
const hint = (await page.textContent('#ach-branch-locked')).trim();
if (!/duel/i.test(hint)) fail(`the locked branch gave no usable hint: "${hint}"`);
ok(`a concealed branch shows a lock and a hint: "${hint.split('\n').pop().trim()}"`);

// Devotion is gated on level, and this profile has climbed past it.
const devLocked = await page.$eval('#ach-branch-devotion', (el) => el.getAttribute('data-locked'));
if (devLocked !== 'false') fail('Devotion should have opened at level 5');
ok('the level-gated branch opened once the level was there');
await page.click('#ach-branch-ladder');
await page.waitForTimeout(400);
if (!(await page.$('#ach-row-cyber_slayer'))) fail('ladder branch did not render its rows');
const body = await page.textContent('#achievements-modal-container');
if (!/\?\?\?/.test(body)) fail('no hidden achievements concealed');
ok('tree renders per branch, with deep rungs concealed');
if (errs.length) fail(`page errors: ${errs.join(' | ')}`);
console.log('\nTREE + GATING CHECKS PASSED');
await browser.close();
