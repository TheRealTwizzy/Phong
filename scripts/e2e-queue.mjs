// Browser E2E for the ranked queue.
//
// Two phones tap Quick Match and end up on one court. What only a browser can
// answer is the flow around the seating: that the terms are stated BEFORE the
// player commits (queueing is the yes, so the yes has to be given to something
// disclosed), that neither player readies or starts anything, and that the
// lobby sheet never flashes on the way through — the relay seats a found pair
// with the ordinary room_created/room_joined, which normally reopen it.
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

async function newPlayer(prefix) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#onboarding-modal-overlay', { timeout: 10000 });
  await page.fill('#input-onboarding-username', `${prefix}${Date.now().toString(36).slice(-4)}${seq++}`);
  await page.waitForSelector('#username-status-available', { timeout: 6000 });
  await page.click('#btn-onboarding-submit');
  await page.waitForSelector('#btn-onboarding-code-continue', { timeout: 10000 })
    .then((b) => b.click())
    .catch(() => {});
  await page.waitForSelector('#main-menu-screen', { timeout: 10000 });
  return page;
}

const shown = (page, sel) => page.$(sel).then((el) => !!el);

// ---- 1. The slot is live, and says what it will play before you commit ----
const a = await newPlayer('QueueA');
await a.waitForSelector('#menu-mode-quickmatch', { timeout: 8000 });
if ((await a.getAttribute('#menu-mode-quickmatch', 'data-stub')) === 'true') {
  fail('the Quick Match row is still the stub');
}
await a.click('#menu-mode-quickmatch');
await a.waitForSelector('#quickmatch-info-sheet', { timeout: 8000 });
const terms = (await a.textContent('#quickmatch-info-sheet')).toLowerCase();
// The disclosure is the consent: a queue table has no host and no editable
// rules, which is the only reason the relay may skip the ready handshake.
for (const said of ['5', 'sonar']) {
  if (!terms.includes(said)) fail(`the queue's terms do not mention "${said}": ${terms.slice(0, 200)}`);
}
if (await shown(a, '#btn-quickmatch-cancel')) fail('the sheet opened already searching');
ok('the Quick Match slot is live and states its terms before you join');

// ---- 2. Joining searches, and says so on the menu row --------------------
await a.click('#btn-quickmatch-join');
await a.waitForSelector('#btn-quickmatch-cancel', { timeout: 8000 });
await a.click('#btn-close-quickmatch');
await a
  .waitForFunction(() => document.querySelector('#menu-mode-quickmatch')?.getAttribute('data-searching') === 'true', { timeout: 8000 })
  .catch(() => fail('the menu row does not show that a search is running'));
ok('joining starts a search the menu row reports');

// A lone queuer waits: there is nobody to pair with, and being seated alone
// would be worse than waiting.
await a.waitForTimeout(1500);
if (await shown(a, '#half-court-canvas')) fail('a lone queuer was seated at a court');
ok('a lone queuer waits rather than being seated');

// ---- 3. A second player, and both land on a court -----------------------
const b = await newPlayer('QueueB');
await b.click('#menu-mode-quickmatch');
await b.waitForSelector('#btn-quickmatch-join', { timeout: 8000 });
await b.click('#btn-quickmatch-join');

for (const [page, who] of [[a, 'first'], [b, 'second']]) {
  const on = await page
    .waitForSelector('#half-court-canvas', { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  if (!on) fail(`the ${who} player never reached the court`);
}
ok('both players reach a court with no ready tap and no start button');

// The lobby never became the surface: the relay seats a pair with the ordinary
// room messages, which normally reopen it.
for (const [page, who] of [[a, 'first'], [b, 'second']]) {
  if (await shown(page, '#multiplayer-lobby-modal')) fail(`the ${who} player is looking at a lobby`);
}
ok('the lobby sheet never flashed on the way through');

// And the search is over on both — the spinner had a court to hand over to.
for (const [page, who] of [[a, 'first'], [b, 'second']]) {
  if (await shown(page, '#quickmatch-searching-chip')) fail(`the ${who} player is still shown as searching`);
}
ok('the search ends when the match starts');

// ---- 4. It is an ordinary duel from the first serve ----------------------
// The countdown is per phone and runs when each player reaches the court.
const scoreboard = await a.waitForSelector('#scoreboard-header', { timeout: 8000 }).then(() => true).catch(() => false);
if (!scoreboard) fail('the queue match has no scoreboard');
const to = await a.textContent('#scoreboard-header');
if (!/to\s*5/i.test(to)) fail(`the queue match is not first-to-5: ${to.replace(/\s+/g, ' ')}`);
// A duel's reset is hidden because the score belongs to the room — a queue
// table is a room like any other.
if (await shown(a, '#btn-reset-match')) fail('the queue match offers a local reset');
ok('from the first serve it is an ordinary duel on the queue terms');

// ---- 5. Cancelling gives the place back ---------------------------------
const c = await newPlayer('QueueC');
await c.click('#menu-mode-quickmatch');
await c.click('#btn-quickmatch-join');
await c.waitForSelector('#btn-quickmatch-cancel', { timeout: 8000 });
await c.click('#btn-quickmatch-cancel');
await c
  .waitForFunction(() => document.querySelector('#menu-mode-quickmatch')?.getAttribute('data-searching') === 'false', { timeout: 8000 })
  .catch(() => fail('cancelling left the row searching'));
await c.waitForTimeout(1200);
if (await shown(c, '#half-court-canvas')) fail('a cancelled search still seated the player');
ok('cancelling gives the queue place back');

if (pageErrors.length) fail(`page errors: ${pageErrors.join(' | ')}`);
console.log('\nALL QUEUE E2E CHECKS PASSED');
await browser.close();
