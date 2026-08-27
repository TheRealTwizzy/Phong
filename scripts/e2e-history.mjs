// Browser E2E for match history, against a running server:
//  1. Two phones play a real relayed duel to a winner. Each player's history
//     then shows exactly ONE row for it — a WIN card on the winner's phone, a
//     LOSS card on the loser's — never both rows of the duel (the read-side
//     duplication this exists to hold down).
//  2. Twelve seeded solo matches paginate: ten to a page, numbered buttons,
//     page 2 selected via `data-selected`, six rows on it.
//  3. Tabs filter — PvP shows the duel, Solo the dozen, and the Ranked
//     sub-filter under Solo shows the empty-filter state (rookie never
//     ranks) while PvP+Ranked keeps the stock-rules duel.
//  4. A practice session banked via /api/practice/record appears under the
//     Practice Wall tab.
//  5. Tapping the duel opponent's name opens their public profile, which
//     carries its own public history list with the same duel row.
// Run it with `npm run test:e2e` (see scripts/e2e-run.mjs), which hands this
// a fresh server, port, DATA_DIR and Chromium.
import { chromium, devices } from 'playwright-core';

const BASE = process.env.E2E_URL || 'http://localhost:3000';
const EXEC = process.env.CHROMIUM_PATH;
if (!EXEC) {
  console.error('Set CHROMIUM_PATH to a Chromium binary.');
  process.exit(2);
}
const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
const ok = (m) => console.log('  ✓', m);

const browser = await chromium.launch({
  executablePath: EXEC,
  args: ['--no-sandbox', '--allow-loopback-in-peer-connection', '--disable-features=WebRtcHideLocalIpsWithMdns'],
});
const pageErrors = [];

async function newPage() {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  return page;
}

// The onboarding tour opens by itself for a player who has never seen it.
// Tolerant: a suite that reaches this another way is not broken by its
// absence.
let nameCounter = 0;
const uniqueName = (prefix) => `${prefix}${Date.now().toString(36).slice(-4)}${nameCounter++}`;

async function onboard(page, prefix) {
  const modal = await page.waitForSelector('#onboarding-modal-overlay', { timeout: 4000 }).catch(() => null);
  if (!modal) return;
  await page.fill('#input-onboarding-username', uniqueName(prefix));
  await page.waitForSelector('#username-status-available', { timeout: 5000 });
  await page.click('#btn-onboarding-submit');
  await page.waitForSelector('#btn-onboarding-code-continue', { timeout: 10000 })
    .then((b) => b.click())
    .catch(() => {});
  await page.waitForSelector('#onboarding-modal-overlay', { state: 'detached', timeout: 8000 });
}

async function passGatekeeper(page) {
  const sim = await page.$('#simulate-smartphone-btn');
  if (sim) await sim.click();
}

/** Winning score lives in SOLO's pre-match sheet; a duel takes the room's. */
async function pickShortMatch(page, points = 3) {
  await page.click('#building-solo');
  await page.click('#room-rookie');
  const btn = await page.waitForSelector(`#menu-pts-${points}:not([disabled])`, { timeout: 4000 }).catch(() => null);
  if (!btn) fail(`winning-score button #menu-pts-${points} not available`);
  await btn.click();
  await page.click('#btn-close-prematch');
  await page.waitForSelector('#prematch-modal', { state: 'detached', timeout: 4000 });
}

const api = (page, url) => page.evaluate(async (u) => (await fetch(u)).json(), url);

// ---- 1. A real relayed duel, then one history row per player -------------
const host = await newPage();
await host.goto(BASE, { waitUntil: 'networkidle' });
await passGatekeeper(host);
await onboard(host, 'HistHost');
await pickShortMatch(host, 3);
await host.click('#building-pvp');
await host.click('#room-casual');
await host.waitForSelector('#btn-create-room', { timeout: 5000 });
// Relay transport keeps the scoring on the server, which is the recording
// path this suite is about; P2P has its own suite.
await host.click('#toggle-p2p input, #toggle-p2p');
await host.click('#btn-create-room');
const code = await host
  .waitForFunction(() => {
    const id = document.querySelector('#lobby-table')?.getAttribute('data-room-id') || '';
    return /^[A-HJ-NP-Z2-9]{4}$/.test(id) ? id : null;
  }, { timeout: 5000 })
  .then((h) => h.jsonValue());

const guest = await newPage();
await guest.goto(BASE, { waitUntil: 'networkidle' });
await passGatekeeper(guest);
await onboard(guest, 'HistGuest');
await guest.click('#building-pvp');
await guest.click('#room-casual');
await guest.waitForSelector('#input-room-code', { timeout: 5000 });
await guest.fill('#input-room-code', code);
await guest.click('#btn-join-room-submit');

await guest.waitForSelector('#btn-ready-play', { timeout: 8000 });
await guest.click('#btn-ready-play');
const startBtn = await host.waitForSelector('#btn-ready-play:not([disabled])', { timeout: 8000 });
await startBtn.click();
for (const page of [host, guest]) {
  await page.waitForSelector('#multiplayer-lobby-modal', { state: 'detached', timeout: 5000 });
  await page.waitForSelector('#half-court-canvas', { timeout: 5000 });
}
ok('duel started over the relay');

// Park both paddles hard left and keep asking to serve until someone wins.
await host.keyboard.down('KeyA');
await guest.keyboard.down('KeyA');
const deadline = Date.now() + 90000;
while (Date.now() < deadline) {
  if (await host.$('#btn-play-again')) break;
  await host.keyboard.press('Space').catch(() => {});
  await guest.keyboard.press('Space').catch(() => {});
  await host.waitForTimeout(1200);
}
await host.keyboard.up('KeyA');
await guest.keyboard.up('KeyA');
for (const [page, who] of [[host, 'host'], [guest, 'guest']]) {
  const up = await page.waitForSelector('#btn-play-again', { timeout: 8000 }).catch(() => null);
  if (!up) fail(`${who} never reached the winner overlay`);
}
ok('both phones reached the winner overlay');

// The relay records the duel at the deciding point — the API must already
// hold exactly one row per player, before either touches Rematch/Main Menu.
let hostHist = null;
for (let i = 0; i < 40; i++) {
  hostHist = await api(host, '/api/matches/me');
  if (hostHist.total >= 1) break;
  await host.waitForTimeout(250);
}
const guestHist = await api(guest, '/api/matches/me');
if (hostHist.total !== 1) fail(`host history total=${hostHist.total}, expected the one duel`);
if (guestHist.total !== 1) fail(`guest history total=${guestHist.total}, expected the one duel`);
const hostMe = await api(host, '/api/profile/me');
const guestMe = await api(guest, '/api/profile/me');
const hostRow = hostHist.matches[0];
const guestRow = guestHist.matches[0];
if (hostRow.player1Id !== hostMe.id) fail('host history row is not the host\'s own filed record');
if (guestRow.player1Id !== guestMe.id) fail('guest history row is not the guest\'s own filed record');
if (hostRow.winnerId !== guestRow.winnerId) fail('the two seats disagree about who won');
const hostWon = hostRow.winnerId === hostMe.id;
ok(`match recorded at the whistle: one row each, ${hostWon ? 'host' : 'guest'} won on both`);

// Back to the menu; the UI must show the same single card, W on the winner's
// phone, L on the loser's.
for (const page of [host, guest]) {
  await page.click('#btn-menu-from-win');
  await page.waitForSelector('#main-menu-screen', { timeout: 5000 });
  await page.click('#menu-nav-history');
  await page.waitForSelector('#match-history-container', { timeout: 5000 });
  await page.waitForSelector('[id^="history-record-"]', { timeout: 5000 });
}
const countRows = (page, prefix) =>
  page.$$eval(`[id^="${prefix}-record-"]`, (els) => els.length);
if ((await countRows(host, 'history')) !== 1) fail('host history shows more than the one duel');
if ((await countRows(guest, 'history')) !== 1) fail('guest history shows more than the one duel');
const winnerPage = hostWon ? host : guest;
const loserPage = hostWon ? guest : host;
const winnerCard = await winnerPage.$eval('[id^="history-record-"]', (el) => el.textContent);
const loserCard = await loserPage.$eval('[id^="history-record-"]', (el) => el.textContent);
if (!/VICTORY/.test(winnerCard)) fail(`winner's card reads: ${winnerCard}`);
if (/VICTORY/.test(loserCard) || !/DEFEAT/.test(loserCard)) fail(`loser's card reads: ${loserCard}`);
ok('one card per phone: VICTORY on the winner\'s, DEFEAT on the loser\'s');

// ---- 2. Pagination over seeded solo matches ------------------------------
await host.evaluate(async () => {
  for (let i = 0; i < 12; i++) {
    await fetch('/api/match/record', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerScore: 3, opponentScore: 1, bestStreak: 4, endStreak: 0, earnedStreak: 4,
        mode: 'solo', difficulty: 'rookie', isWinner: true, matchKey: `e2e:hist:solo:${i}`,
      }),
    });
  }
});
await host.click('#btn-refresh-match-history');
await host.waitForSelector('#history-page-2', { timeout: 5000 });
if ((await countRows(host, 'history')) !== 10) fail('page 1 does not hold ten rows');
await host.click('#history-page-2');
await host.waitForSelector('#history-page-2[data-selected="true"]', { timeout: 5000 });
await host.waitForFunction(
  () => document.querySelectorAll('[id^="history-record-"]').length === 3,
  { timeout: 5000 }
).catch(async () => fail(`page 2 holds ${await countRows(host, 'history')} rows, expected 3 (13 total)`));
ok('13 matches paginate: ten on page 1, three on page 2, page button selected');

// ---- 3. Tabs and the ranked sub-filter -----------------------------------
await host.click('#history-tab-pvp');
await host.waitForFunction(
  () => document.querySelectorAll('[id^="history-record-"]').length === 1,
  { timeout: 5000 }
).catch(async () => fail(`PvP tab shows ${await countRows(host, 'history')} rows, expected the one duel`));
// The stock-rules relay duel ranked, so it survives the Ranked sub-filter.
await host.click('#history-sub-ranked');
await host.waitForFunction(
  () => document.querySelectorAll('[id^="history-record-"]').length === 1,
  { timeout: 5000 }
).catch(() => fail('PvP+Ranked lost the stock-rules duel'));
ok('PvP tab isolates the duel; Ranked keeps it (stock rules ranked)');

await host.click('#history-tab-solo');
await host.waitForFunction(
  () => document.querySelectorAll('[id^="history-record-"]').length === 10,
  { timeout: 5000 }
).catch(async () => fail(`Solo tab page 1 shows ${await countRows(host, 'history')} rows, expected 10 of 12`));
// Rookie never counts for rank, so Solo+Ranked is the empty-filter state.
await host.click('#history-sub-ranked');
await host.waitForFunction(
  () => document.querySelectorAll('[id^="history-record-"]').length === 0,
  { timeout: 5000 }
).catch(() => fail('Solo+Ranked still shows rows for rookie matches'));
ok('Solo tab pages its twelve; Ranked under it is empty (rookie never ranks)');

// ---- 4. Practice sessions land under the Practice Wall tab ---------------
await host.evaluate(async () => {
  await fetch('/api/practice/record', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bestStreak: 6, earnedStreak: 6, endStreak: 6 }),
  });
});
await host.click('#history-tab-practice');
await host.waitForFunction(
  () => document.querySelectorAll('[id^="history-record-"]').length === 1,
  { timeout: 5000 }
).catch(() => fail('the banked practice session never appeared under its tab'));
const practiceCard = await host.$eval('[id^="history-record-"]', (el) => el.textContent);
if (/VICTORY|DEFEAT/.test(practiceCard)) fail('a practice session renders a W/L verdict');
ok('practice session listed under its tab, with no W/L verdict');

// ---- 4b. Quitting a live solo match records the loss ---------------------
// Quitting a match you are losing used to record nothing at all, so a player
// who quit every losing solo match kept a 100% win rate. A match a point has
// been scored in is a match that happened.
await host.click('#btn-close-match-history');
await host.waitForSelector('#main-menu-screen', { timeout: 5000 });
const lossesBefore = (await api(host, '/api/profile/me')).matchesLost;

await host.click('#building-solo');
await host.click('#room-rookie');
await host.waitForSelector('#menu-start-solo', { timeout: 5000 });
await host.click('#menu-start-solo');
await host.waitForSelector('#half-court-canvas', { timeout: 8000 });
// Park the paddle in a corner and keep asking to serve until the AI takes a
// point — the ball comes back to an empty half and goes past.
const opponentScore = () =>
  host.evaluate(() => {
    const opp = parseInt(document.querySelector('#score-opponent')?.textContent || '', 10);
    return Number.isFinite(opp) ? opp : 0;
  });
await host.keyboard.down('KeyA');
let conceded = false;
const concedeDeadline = Date.now() + 60000;
while (Date.now() < concedeDeadline) {
  if ((await opponentScore()) >= 1) {
    conceded = true;
    break;
  }
  await host.keyboard.press('Space').catch(() => {});
  await host.waitForTimeout(800);
}
await host.keyboard.up('KeyA');
if (!conceded) fail('the solo AI never took a point, so the quit-loss case never ran');

// Reset ends the match just as surely as walking out, so it asks the same
// question — and "keep playing" leaves the match exactly where it was.
await host.click('#btn-reset-match');
await host.waitForSelector('#quit-confirm-modal', { timeout: 4000 });
const resetWarning = await host.textContent('#quit-confirm-consequence');
if (!/loss/i.test(resetWarning || '')) fail(`the reset confirmation does not mention the loss: ${resetWarning}`);
await host.click('#btn-quit-cancel');
await host.waitForSelector('#quit-confirm-modal', { state: 'detached', timeout: 4000 });
if (!(await host.$('#half-court-canvas'))) fail('cancelling the confirmation left the court');
if ((await opponentScore()) < 1) fail('cancelling the confirmation reset the match anyway');
ok('Reset asks before it ends the match, and cancelling keeps it running');

// Leaving a live match asks first, and says what it costs — that is the
// feature, not an obstacle, so the suite reads the warning before answering.
await host.click('#btn-quit-to-menu');
await host.waitForSelector('#quit-confirm-modal', { timeout: 4000 });
const warning = await host.textContent('#quit-confirm-consequence');
if (!/loss/i.test(warning || '')) fail(`the leave confirmation does not mention the loss: ${warning}`);
await host.click('#btn-quit-confirm');
await host.waitForSelector('#main-menu-screen', { timeout: 5000 });
ok('leaving a live solo match warns that it records a loss');
let afterQuit = null;
for (let i = 0; i < 40; i++) {
  afterQuit = await api(host, '/api/profile/me');
  if (afterQuit.matchesLost > lossesBefore) break;
  await host.waitForTimeout(250);
}
if (afterQuit.matchesLost !== lossesBefore + 1) {
  fail(`quitting a live solo match recorded ${afterQuit.matchesLost - lossesBefore} losses, expected 1`);
}
const soloHistory = await api(host, '/api/matches/me?tab=solo');
const quitRow = soloHistory.matches[0];
if (quitRow.winnerId === (await api(host, '/api/profile/me')).id) {
  fail('the quit match was recorded as a win');
}
ok('quitting a live solo match records it as a loss');

// A match nobody has scored in is not a match: quitting at 0-0 records
// nothing, so backing out of one that never started costs nothing.
const beforeIdle = (await api(host, '/api/matches/me')).total;
await host.click('#building-solo');
await host.click('#room-rookie');
await host.waitForSelector('#menu-start-solo', { timeout: 5000 });
await host.click('#menu-start-solo');
await host.waitForSelector('#half-court-canvas', { timeout: 8000 });
await host.click('#btn-quit-to-menu');
// Nothing is at stake at 0-0, so nothing is asked: the confirmation exists
// for exits that cost the match, and would be noise on one that does not.
if (await host.$('#quit-confirm-modal')) fail('quitting at 0-0 asked for confirmation');
await host.waitForSelector('#main-menu-screen', { timeout: 5000 });
await host.waitForTimeout(1000);
const afterIdle = (await api(host, '/api/matches/me')).total;
if (afterIdle !== beforeIdle) fail(`quitting at 0-0 recorded ${afterIdle - beforeIdle} match(es)`);
ok('quitting at 0-0 asks nothing and records nothing');

// Re-open history for the public-profile leg below.
await host.click('#menu-nav-history');
await host.waitForSelector('#match-history-container', { timeout: 5000 });

// ---- 5. Public history on the opponent's profile -------------------------
await host.click('#history-tab-pvp');
await host.waitForSelector('[id^="history-opponent-"]', { timeout: 5000 });
await host.click('[id^="history-opponent-"]');
await host.waitForSelector('#public-profile-username', { timeout: 5000 });
const pubName = (await host.textContent('#public-profile-username')).trim();
if (pubName !== guestMe.username) fail(`public profile shows "${pubName}", expected ${guestMe.username}`);
await host.waitForSelector('#public-history-tab-all', { timeout: 5000 });
await host.waitForSelector('[id^="public-history-record-"]', { timeout: 5000 });
const pubRows = await host.$$eval('[id^="public-history-record-"]', (els) => els.length);
if (pubRows !== 1) fail(`public history shows ${pubRows} rows, expected the guest's one duel`);
ok('opponent tap opens their public profile with its own public history');

if (pageErrors.length) fail(`page errors: ${pageErrors.join(' | ')}`);
console.log('\nALL MATCH HISTORY E2E CHECKS PASSED');
await browser.close();
