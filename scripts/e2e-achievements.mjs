// Browser E2E for the achievement tree and the progression gate it enforces:
//   1. A new player has only Rookie and short matches open.
//   2. The server rejects a locked difficulty, not just the menu.
//   3. Beating Rookie opens Pro — and only Pro.
//   4. The tree renders per branch, with deep rungs concealed.
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
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('#onboarding-modal-overlay', { timeout: 10000 });
await page.fill('#input-onboarding-username', `Tree${Date.now().toString(36).slice(-5)}`);
await page.waitForSelector('#username-status-available', { timeout: 6000 });
await page.click('#btn-onboarding-submit');
await page.waitForSelector('#main-menu-screen', { timeout: 10000 });

await page.click('#menu-mode-solo');
await page.waitForSelector('#menu-diff-rookie', { timeout: 5000 });
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
if (await dis('#menu-pts-10')) fail('a first win should open first-to-10');
ok('a first win opens longer matches');

// Achievement tree renders with branches and hidden rungs.
await page.click('#menu-nav-achievements').catch(async () => { await page.click('#menu-nav-trophies'); });
await page.waitForSelector('#ach-branch-ladder', { timeout: 5000 });
for (const b of ['foundation','rally','ladder','duel','craft']) {
  if (!(await page.$(`#ach-branch-${b}`))) fail(`missing branch tab ${b}`);
}
ok('all five branch tabs render');
await page.click('#ach-branch-ladder');
await page.waitForTimeout(400);
if (!(await page.$('#ach-row-cyber_slayer'))) fail('ladder branch did not render its rows');
const body = await page.textContent('#achievements-modal-container');
if (!/\?\?\?/.test(body)) fail('no hidden achievements concealed');
ok('tree renders per branch, with deep rungs concealed');
if (errs.length) fail(`page errors: ${errs.join(' | ')}`);
console.log('\nTREE + GATING CHECKS PASSED');
await browser.close();
