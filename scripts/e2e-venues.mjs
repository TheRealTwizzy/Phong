// Browser E2E for the Building -> Room navigation.
//
// The menu used to be a flat list of four mode rows. It is a PLACE now: a
// building says what kind of game, a room says who you are playing and at
// what level, and the match begins from there. What this suite pins:
//   1. The three buildings are on the menu as a TAB STRIP, and the one that
//      is selected shows its rooms and nothing else.
//   2. Switching buildings is one tap, and the strip marks where you are.
//   3. A SOLO room is a rung — entering one sets the difficulty the sheet
//      then confirms, rather than asking a second time.
//   4. A locked rung says what opens it, and cannot be entered.
//   5. A PVP bracket a fresh player is too weak for is locked and SAYS the
//      level it needs; the ungated rooms stay open to them.
//   6. Training rooms reach the Practice Wall and Split Screen.
//   7. The table browser: an empty room offers to start one, a public table
//      is findable and joinable with no code, and a private one is not listed
//      at all — that last is the whole boundary protecting invite codes.
// Run it with `npm run test:e2e` (see scripts/e2e-run.mjs).
import { chromium, devices } from 'playwright-core';

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
  await skipTour(page);
  await page.waitForSelector('#main-menu-screen', { timeout: 10000 });
  return page;
}

const shown = (page, sel) => page.$(sel).then((el) => !!el);
const locked = (page, sel) =>
  page.$eval(sel, (el) => el.getAttribute('data-locked') === 'true');
const selected = (page, sel) =>
  page.$eval(sel, (el) => el.getAttribute('data-selected') === 'true');

// ---- 1. The three buildings, and walking into one ------------------------
const page = await newPlayer('Venue');
for (const b of ['pvp', 'solo', 'training']) {
  if (!(await shown(page, `#building-${b}`))) fail(`the ${b} building is not on the menu`);
}
// The strip opens on a building rather than on nothing: a menu whose PLAY
// section is empty until you tap something has a dead first screen.
await page.waitForSelector('#room-rookie', { timeout: 5000 });
if (!(await selected(page, '#building-solo'))) fail('the menu did not open on a building');
ok('three buildings on the menu, opened on one of them');

for (const r of ['rookie', 'ai_pro', 'ai_elite', 'cyber', 'chaos']) {
  if (!(await shown(page, `#room-${r}`))) fail(`the solo building is missing its ${r} room`);
}
// One building at a time — the other buildings' rooms are not also listed.
if (await shown(page, '#room-casual')) fail('a PvP room is listed inside the Solo building');
// The strip stays — that is the point of a strip — so what must NOT survive
// is the other buildings' ROOMS, asserted above.
if (!(await shown(page, '#building-pvp'))) fail('the building strip vanished when a building was picked');
ok('the Solo building lists its five rungs and nothing else');

// ---- 2. Switching buildings is one tap, and the strip says where you are --
await page.click('#building-training');
await page.waitForSelector('#room-practice', { timeout: 5000 });
if (await shown(page, '#room-rookie')) fail('the previous building\'s rooms survived the switch');
if ((await selected(page, '#building-solo')) || !(await selected(page, '#building-training'))) {
  fail('the strip does not mark the building actually being shown');
}
await page.click('#building-solo');
await page.waitForSelector('#room-rookie', { timeout: 5000 });
ok('the building strip switches rooms in one tap and marks the current one');

// ---- 3. A solo room IS a rung --------------------------------------------
// The pre-match sheet used to ask for the difficulty. The room already
// answered, so the sheet states it — one answer, given once, where the player
// gave it.
await page.click('#building-solo');
await page.click('#room-rookie');
await page.waitForSelector('#prematch-modal', { timeout: 5000 });
const named = (await page.textContent('#prematch-difficulty-name')).trim().toLowerCase();
if (named !== 'rookie') fail(`the sheet does not confirm the room's rung, got "${named}"`);
// Scoped to the SHEET: the room list is still rendered behind it (a sheet is
// a modal over the menu, not a replacement for it), so an unscoped query
// finds the room row and proves nothing.
if (await shown(page, '#prematch-modal-container [id^="menu-diff-"]')) {
  fail('the sheet still offers a difficulty picker, which the room already answered');
}
const odds = parseInt(await page.textContent('#prematch-difficulty-odds'), 10);
if (!(odds > 0 && odds <= 100)) fail(`no win chance shown for the entered room: ${odds}`);
ok(`entering ROOKIE sets the rung and the sheet confirms it (${odds}%)`);

await page.click('#btn-prematch-back');
await page.waitForSelector('#prematch-modal', { state: 'detached', timeout: 5000 });

// ---- 4. A locked rung says what opens it ---------------------------------
if (await locked(page, '#room-rookie')) fail('Rookie should be open from the first match');
for (const r of ['ai_pro', 'ai_elite', 'cyber', 'chaos']) {
  if (!(await locked(page, `#room-${r}`))) fail(`${r} should be locked for a fresh player`);
  if (!(await shown(page, `#room-${r}-lock`))) fail(`${r} is locked but says nothing about why`);
}
const proLock = (await page.textContent('#room-ai_pro-lock')).trim();
if (!proLock) fail('the Pro lock reason is empty');
// A locked room is inert: tapping it must not open a sheet.
await page.click('#room-ai_pro', { force: true }).catch(() => {});
if (await shown(page, '#prematch-modal')) fail('a locked room opened its pre-match sheet');
ok(`a locked rung is inert and names its unlock ("${proLock}")`);

// ---- 5. PvP brackets gate on level and tier ------------------------------
await page.click('#building-pvp');
await page.waitForSelector('#room-casual', { timeout: 5000 });
// The queue's own room is never browsable — excluded as data, not by a
// special case in the listing.
if (await shown(page, '#room-_queue')) fail('the hidden matchmaking room is listed in the browser');
// A fresh player is unplaced: below every floor, so the ungated rooms are
// theirs and nothing above is.
if (await locked(page, '#room-casual')) fail('Casual must be open to everyone');
if (await locked(page, '#room-beginner')) fail('Beginner must be open to an unplaced player');
for (const r of ['intermediate', 'advanced', 'elite', 'pro']) {
  if (!(await locked(page, `#room-${r}`))) fail(`${r} should be locked for a fresh player`);
}
const interLock = (await page.textContent('#room-intermediate-lock')).trim();
if (!/\d/.test(interLock)) fail(`a level-gated room should name the level it needs, got "${interLock}"`);
ok(`PvP brackets gate an unplaced player correctly, and say why ("${interLock}")`);

// ---- 6. Training reaches the Practice Wall and Split Screen --------------
await page.click('#building-training');
await page.waitForSelector('#room-practice', { timeout: 5000 });
for (const r of ['practice', 'split']) {
  if (await locked(page, `#room-${r}`)) fail(`${r} should never be gated`);
}
await page.click('#room-practice');
await page.waitForSelector('#menu-start-practice', { timeout: 5000 });
await page.click('#menu-start-practice');
await page.waitForSelector('#half-court-canvas', { timeout: 8000 });
ok('the Training building reaches the Practice Wall');

// ---- 7. The table browser inside a PvP room ------------------------------
// A room with no tables is a room you START one in, so the empty state says
// exactly that rather than showing nothing.
const browser1 = await newPlayer('Table');
await browser1.click('#building-pvp');
await browser1.click('#room-casual');
await browser1.waitForSelector('#lobby-tables-empty', { timeout: 8000 });
ok('an empty room shows the empty state, not a blank browser');

// Starting a table there makes it PUBLIC — and a second player standing in
// the same room finds it without ever being told a code.
await browser1.click('#btn-create-public-table');
const code = await browser1
  .waitForFunction(() => {
    const txt = (document.querySelector('#lobby-room-code')?.textContent || '').trim();
    return /^[A-HJ-NP-Z2-9]{4}$/.test(txt) ? txt : null;
  }, { timeout: 8000 })
  .then((h) => h.jsonValue());

const browser2 = await newPlayer('Finder');
await browser2.click('#building-pvp');
await browser2.click('#room-casual');
await browser2.waitForSelector(`#table-${code}`, { timeout: 10000 });
ok(`a public table is findable from the room browser (${code}) with no code typed`);

// And joining it seats them: the browser is a way IN, not just a list.
await browser2.click(`#table-${code}`);
await browser2.waitForSelector('#lobby-room-code', { timeout: 8000 });
const seated = await browser2.textContent('#lobby-room-code');
if (seated.trim() !== code) fail(`joining from the browser landed in ${seated.trim()}, not ${code}`);
ok('tapping a table seats the player at it');

// The private flow is untouched and stays out of the listing entirely.
const priv = await newPlayer('Priv');
await priv.click('#building-pvp');
await priv.click('#room-casual');
await priv.waitForSelector('#btn-create-room', { timeout: 8000 });
await priv.click('#btn-create-room');
const privCode = await priv
  .waitForFunction(() => {
    const txt = (document.querySelector('#lobby-room-code')?.textContent || '').trim();
    return /^[A-HJ-NP-Z2-9]{4}$/.test(txt) ? txt : null;
  }, { timeout: 8000 })
  .then((h) => h.jsonValue());
const listed = await priv.evaluate(async () => {
  const r = await fetch('/api/rooms/casual/tables');
  return (await r.json()).tables.map((t) => t.id);
});
if (listed.includes(privCode)) {
  fail(`a private table (${privCode}) is listed in the room browser — its code is harvestable`);
}
ok(`"host a match" still makes a PRIVATE table (${privCode}), absent from the listing`);

if (pageErrors.length) fail(`page errors: ${pageErrors.join(' | ')}`);
console.log('\nALL VENUE E2E CHECKS PASSED');
await browser.close();
