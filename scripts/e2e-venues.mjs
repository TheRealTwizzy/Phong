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
const locked = (page, sel) =>
  page.$eval(sel, (el) => el.getAttribute('data-locked') === 'true');
const selected = (page, sel) =>
  page.$eval(sel, (el) => el.getAttribute('data-selected') === 'true');
const revealing = (page, b) =>
  page.$eval(`#building-${b}`, (el) => el.getAttribute('data-reveal') === 'true');

/** Open a building's fold: tap the tab you are already on. Idempotent. */
async function revealLocked(page, building) {
  if (!(await selected(page, `#building-${building}`))) await page.click(`#building-${building}`);
  if (!(await revealing(page, building))) await page.click(`#building-${building}`);
  await page.waitForFunction(
    (b) => document.querySelector(`#building-${b}`)?.getAttribute('data-reveal') === 'true',
    building,
    { timeout: 5000 }
  );
}

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

// Rookie is the only rung a new player has, and the list is a list of places
// you can go — so it is the only one on screen until the fold is opened.
if (!(await shown(page, '#room-rookie'))) fail('the solo building is missing its Rookie room');
for (const r of ['ai_pro', 'ai_elite', 'cyber', 'chaos']) {
  if (await shown(page, `#room-${r}`)) fail(`${r} is locked and should be folded away`);
}
await revealLocked(page, 'solo');
for (const r of ['rookie', 'ai_pro', 'ai_elite', 'cyber', 'chaos']) {
  if (!(await shown(page, `#room-${r}`))) fail(`the solo building is missing its ${r} room`);
}
// One building at a time — the other buildings' rooms are not also listed.
if (await shown(page, '#room-casual')) fail('a PvP room is listed inside the Solo building');
// The strip stays — that is the point of a strip — so what must NOT survive
// is the other buildings' ROOMS, asserted above.
if (!(await shown(page, '#building-pvp'))) fail('the building strip vanished when a building was picked');
ok('the Solo building lists its five rungs and nothing else');

// ---- 1b. The fold, and the two ways it closes ---------------------------
// Tapping the tab you are already on again folds them back...
await page.click('#building-solo');
if (await shown(page, '#room-chaos')) fail('tapping the selected tab again did not fold the rooms away');
// ...and so does going somewhere else and coming back, so a building is never
// left holding a fold the player opened three screens ago.
await revealLocked(page, 'solo');
await page.click('#building-training');
await page.waitForSelector('#room-practice', { timeout: 5000 });
await page.click('#building-solo');
await page.waitForSelector('#room-rookie', { timeout: 5000 });
if (await shown(page, '#room-chaos')) fail('the fold survived a trip to another building');
// And the tab says how many it is holding, or the toggle is unfindable.
const held = (await page.textContent('#building-locked-count')).trim();
if (!/4/.test(held)) fail(`the tab does not say how many rooms are folded away, got "${held}"`);
ok(`locked rooms fold away, and the tab says how many (${held})`);

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
await revealLocked(page, 'solo');
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
// The brackets above this player fold away like the rungs did.
for (const r of ['intermediate', 'advanced', 'elite', 'pro']) {
  if (await shown(page, `#room-${r}`)) fail(`${r} is locked and should be folded away`);
}
await revealLocked(page, 'pvp');
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

// There is exactly ONE create control in a room, and this is it. There were
// two — "start a table" and "host a match" — and from the player's seat they
// were the same button: one made a listed table and the other an unlisted one,
// and both landed on the identical screen, a room code waiting for somebody.
if (await shown(browser1, '#btn-create-public-table')) {
  fail('the room still offers two create buttons that land in the same place');
}
await browser1.click('#btn-create-room');
const code = await browser1
  .waitForFunction(() => {
    const id = document.querySelector('#lobby-table')?.getAttribute('data-room-id') || '';
    return /^[A-HJ-NP-Z2-9]{4}$/.test(id) ? id : null;
  }, { timeout: 8000 })
  .then((h) => h.jsonValue());

// Casual does not move the visible ladder, and the lobby has to say so before
// anybody plays. Its own description has promised this in seven locales since
// the room shipped while the server rated it like any other bracket.
const casualStatus = await browser1
  .$eval('#lobby-rules-status', (el) => (el.textContent || '').trim())
  .catch(() => '');
if (!/no rank/i.test(casualStatus)) {
  fail(`a Casual table should say it does not count for rank, got "${casualStatus}"`);
}
ok(`the Casual lobby says the ladder is not on the line ("${casualStatus}")`);

const browser2 = await newPlayer('Finder');
await browser2.click('#building-pvp');
await browser2.click('#room-casual');
await browser2.waitForSelector(`#table-${code}`, { timeout: 10000 });
ok(`a public table is findable from the room browser (${code}) with no code typed`);

// And joining it seats them: the browser is a way IN, not just a list.
await browser2.click(`#table-${code}`);
await browser2.waitForSelector('#lobby-table', { timeout: 8000 });
const seated = await browser2.getAttribute('#lobby-table', 'data-room-id');
if (seated.trim() !== code) fail(`joining from the browser landed in ${seated.trim()}, not ${code}`);
ok('tapping a table seats the player at it');

// The one table is open by default: listed in its room, and carrying no code
// to share, because there is nothing to share — anyone in the bracket can sit
// down from the browser.
const listedNow = await browser1.evaluate(async () => {
  const r = await fetch('/api/rooms/casual/tables');
  return (await r.json()).tables.map((t) => t.id);
});
if (!listedNow.includes(code)) fail(`the created table (${code}) is not in its room's listing`);
if (await shown(browser1, '#lobby-room-code')) fail('an OPEN table is showing a key to share');
for (const gone of ['#btn-copy-link', '#btn-toggle-qr', '#lobby-qr']) {
  if (await shown(browser1, gone)) fail(`the link/QR share surface is still here: ${gone}`);
}
ok(`one table, open and findable in the room (${code}), with no link to hand out`);

// ---- 7a. The badge follows the TABLE, not the room you came from --------
// The divergence the venue rides table_state for. A guest who walked into a
// different bracket and typed a Casual table's code has a BROWSE venue of
// `beginner` while sitting at a `casual` table — so a lobby reading the room
// the player came from tells them the opposite of the truth about the match
// they are about to play. Its own table, so it takes nobody's seat.
const casualHost = await newPlayer('CasHost');
await casualHost.click('#building-pvp');
await casualHost.click('#room-casual');
await casualHost.waitForSelector('#btn-create-room', { timeout: 8000 });
await casualHost.click('#btn-create-room');
const casualCode = await casualHost
  .waitForFunction(() => {
    const id = document.querySelector('#lobby-table')?.getAttribute('data-room-id') || '';
    return /^[A-HJ-NP-Z2-9]{4}$/.test(id) ? id : null;
  }, { timeout: 8000 })
  .then((h) => h.jsonValue());

const keyJoiner = await newPlayer('CodeJoin');
await keyJoiner.click('#building-pvp');
await keyJoiner.click('#room-beginner');
await keyJoiner.waitForSelector('#btn-join-room-submit', { timeout: 8000 });
await (await keyJoiner.$('#input-room-code')).fill(casualCode);
await keyJoiner.click('#btn-join-room-submit');
await keyJoiner.waitForSelector('#lobby-table', { timeout: 8000 });
const joinerStatus = await keyJoiner
  .waitForFunction(
    () => {
      const el = document.querySelector('#lobby-rules-status');
      return el && /no rank/i.test(el.textContent || '') ? el.textContent.trim() : null;
    },
    { timeout: 8000 }
  )
  .then((h) => h.jsonValue())
  .catch(() => null);
if (!joinerStatus) {
  const got = await keyJoiner.textContent('#lobby-rules-status').catch(() => '(none)');
  fail(`a guest who typed a Casual code from another bracket was told "${got}"`);
}
ok(`the badge follows the table the guest is AT, not the room they came from ("${joinerStatus}")`);
await keyJoiner.context().close();
await casualHost.context().close();

// ---- 7b. The lock, and the key it mints ---------------------------------
// Turning Private on takes the table out of the listing and mints a
// 4-character key. The key is the ONLY way in: the room id still indexes the
// table and still answers GET /api/room/:id, and it must not open the door.
await browser1.click('#toggle-private input');
await browser1.waitForSelector('#lobby-room-code', { timeout: 8000 });
const key1 = (await browser1.textContent('#lobby-room-code')).trim();
if (!/^[A-HJ-NP-Z2-9]{4}$/.test(key1)) fail(`locking the table minted no key, got "${key1}"`);
if (key1 === code) fail('the key is just the room id — locking it changed nothing');

const listedLocked = await browser1.evaluate(async () => {
  const r = await fetch('/api/rooms/casual/tables');
  return (await r.json()).tables.map((t) => t.id);
});
if (listedLocked.includes(code)) fail(`a locked table (${code}) is still in the room's listing`);
ok(`locking mints a key (${key1}) and takes the table out of the listing`);

// Re-locking RE-KEYS it, which is what makes sharing a key revocable.
await browser1.click('#toggle-private input'); // off
await browser1.waitForFunction(() => !document.querySelector('#lobby-room-code'), { timeout: 8000 });
await browser1.click('#toggle-private input'); // on again
await browser1.waitForSelector('#lobby-room-code', { timeout: 8000 });
const key2 = (await browser1.textContent('#lobby-room-code')).trim();
if (key2 === key1) fail('re-locking reused the old key — a shared key can never be taken back');
ok(`turning the lock again re-keys it (${key1} -> ${key2})`);

// And the key is offered as FOUR CHARACTERS, not as a link.
if (!(await shown(browser1, '#btn-copy-key'))) fail('no way to copy the key');
const copyOnly = await browser1.evaluate(async () => {
  let captured = null;
  const real = navigator.clipboard?.writeText?.bind(navigator.clipboard);
  navigator.clipboard.writeText = async (v) => { captured = v; return real ? undefined : undefined; };
  document.querySelector('#btn-copy-key').click();
  await new Promise((r) => setTimeout(r, 150));
  return captured;
});
if (copyOnly !== key2) fail(`copying put "${copyOnly}" on the clipboard, not the bare key ${key2}`);
ok('copying puts the four characters on the clipboard and nothing else');

// And its watching seats start SHUT. Not cosmetic: open seats force the match
// onto the relay, because rtc_signal is refused for a watched table — a P2P
// match never reaches the relay and a watcher would sit in front of a frozen
// court. Defaulting them open would take the direct DataChannel away from
// every duel in the game. e2e-duel prints its link badge but does not assert
// it, so a silently relay-only build passes there; this is the assertion that
// would have caught it.
const madeTable = await browser1.evaluate(
  async (c) => (await fetch(`/api/room/${c}`)).json(),
  code
);
if (madeTable.spectatorsEnabled !== false) {
  fail('a freshly created table opens its watching seats, which forces every duel onto the relay');
}
ok('a new table keeps its watching seats shut, so P2P is still on the table');

if (pageErrors.length) fail(`page errors: ${pageErrors.join(' | ')}`);
console.log('\nALL VENUE E2E CHECKS PASSED');
await browser.close();
