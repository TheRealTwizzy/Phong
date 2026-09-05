// Browser E2E for the play-bot population.
//
// A human plays a bot the SERVER started -- the whole feature in one flow,
// through the real UI, with nothing driving the bot from the test process.
// The runner boots this suite's server with PLAYBOT_ROSTER_SIZE set; every
// other suite runs with the population off, which is also how a deployment
// runs until step 27 has measured the ceiling.
//
// What only a browser can answer, and therefore what this owns:
//
//   * the population is reachable at all -- a human taps Quick Match and is
//     seated against a bot, with no bot-shaped step anywhere in the flow;
//   * the result strip reports the match, so a human is told what a bot duel
//     did to their ladder. The ARITHMETIC of the reduced stakes is
//     tests/playbotRecord.test.ts's -- a ×0.70 mu step is not a thing a screen
//     can be read for, and asserting a bucket here would be asserting the
//     bucketing rather than the weight;
//   * the bot's name is a TAP TARGET, in the match and in history, and what it
//     opens is an ordinary public profile carrying a BOT badge (§4.11/D27).
//     That badge is a disclosure requirement: the profile must never imply a
//     human is behind it.
//
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });
const pageErrors = [];

async function newPlayer(prefix) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#onboarding-modal-overlay', { timeout: 10000 });
  await page.fill('#input-onboarding-username', `${prefix}${Date.now().toString(36).slice(-5)}`);
  await page.waitForSelector('#username-status-available', { timeout: 6000 });
  await page.click('#btn-onboarding-submit');
  await page.waitForSelector('#btn-onboarding-code-continue', { timeout: 10000 })
    .then((b) => b.click())
    .catch(() => {});
  await page.waitForSelector('#main-menu-screen', { timeout: 10000 });
  return page;
}

// ---- 0. The population is up before anybody looks for it ------------------
// The supervisor onboards its accounts over the ordinary HTTP doors at boot,
// so they exist as soon as the server is healthy -- but provisioning is a few
// round trips and the health check does not wait for it.
let roster = 0;
for (let i = 0; i < 60; i++) {
  const board = await fetch(`${BASE}/api/leaderboard?bots=1&limit=100`).then((r) => r.json()).catch(() => null);
  // The curated ROSTER is on that board too and is not what this suite is
  // about, so count only accounts with an ISSUED id -- a play-bot onboards
  // through the ordinary doors, so its id is `dev_`-shaped like any human's.
  roster = (board?.leaderboard ?? []).filter((e) => e.isBot && e.id.startsWith('dev_')).length;
  if (roster > 0) break;
  await sleep(500);
}
if (roster === 0) fail('the server started no play-bots (is PLAYBOT_ROSTER_SIZE set for this suite?)');
ok(`the server started a population of its own (${roster} on the board)`);

// ---- 1. A human queues and meets one --------------------------------------
const human = await newPlayer('BotFoe');
await human.click('#menu-mode-quickmatch');
await human.waitForSelector('#btn-quickmatch-join', { timeout: 8000 });
await human.click('#btn-quickmatch-join');

// The wait is bounded by the population's own clock, not by luck: a bot parked
// at a table nobody joined stops counting as engaged the moment a human is
// unserved, so the next tick sends it to the queue.
const onCourt = await human
  .waitForSelector('#half-court-canvas', { timeout: 90000 })
  .then(() => true)
  .catch(() => false);
if (!onCourt) fail('a queued human never met a bot');
ok('a human taps Quick Match and is seated against the population');

// Nothing about the flow says "bot": it is the ordinary queue path.
if (await human.$('#multiplayer-lobby-modal')) fail('the human was shown a lobby');
ok('no bot-shaped step anywhere in the seating');

// ---- 2. The opponent is a tap target, and it says BOT ----------------------
const nameTap = await human.waitForSelector('#btn-view-opponent-profile', { timeout: 15000 })
  .then(() => true)
  .catch(() => false);
if (!nameTap) fail("the opponent's name is not a tap target");
const botName = (await human.textContent('#btn-view-opponent-profile')).trim();
await human.click('#btn-view-opponent-profile');
await human.waitForSelector('#public-profile-card', { timeout: 10000 });
// The badge is a DISCLOSURE, not decoration: the card must never imply a
// person is behind it. Server-derived from bot_accounts, so a client can no
// more invent it than it can invent a tier.
if (!(await human.$('#public-profile-bot-badge'))) fail(`${botName}'s profile carries no BOT badge`);
// And it is a full card rather than a reduced one -- same shape a human gets.
if (!(await human.$('#public-history-tab-all'))) fail("a bot's profile withholds its match history");
ok('the opponent name opens an ordinary public profile, badged BOT');
await human.click('#btn-close-public-profile');

// ---- 3. The match finishes and the strip says what it did -----------------
// The human never touches the paddle: the ranked auto-serve floor keeps the
// match moving from both ends, so it plays itself out to the bot's win.
const finished = await human
  .waitForSelector('#winner-modal-overlay', { timeout: 180000 })
  .then(() => true)
  .catch(() => false);
if (!finished) fail('the bot match never finished');
// Always rendered, even for a result that moved nothing -- which is exactly
// when a player most wants to be told the ladder did not move.
await human.waitForSelector('#winner-rank-tile', { timeout: 15000 })
  .catch(() => fail('the result strip has no rank tile'));
// The server owes the movement, and the tile fills in when it lands.
await human
  .waitForFunction(() => !document.querySelector('#rank-move-pending'), { timeout: 20000 })
  .catch(() => fail('the rank movement never arrived'));
ok('the result strip reports what the bot duel did to the ladder');

// ---- 4. It is a real match on a real record -------------------------------
const me = await human.evaluate(async () => (await fetch('/api/profile/me')).json());
if (!(me.matchesPlayed >= 1)) fail(`the bot duel was not recorded: played ${me.matchesPlayed}`);
if (!(me.rankedGames >= 1)) fail(`the bot duel did not count for rank: rankedGames ${me.rankedGames}`);
ok('the duel is on the human record like any other');

// ---- 5. And the bot is a tap target in history too ------------------------
await human.click('#btn-menu-from-win');
await human.waitForSelector('#main-menu-screen', { timeout: 15000 });
await human.click('#menu-nav-history');
await human.waitForSelector('#menu-page-history', { timeout: 10000 });
await human.waitForSelector('[id^="history-record-"]', { timeout: 15000 })
  .catch(() => fail('the bot duel is not in history'));
const opponentLink = await human.$('[id^="history-opponent-"]');
if (!opponentLink) fail("history does not make the bot's name a tap target");
await opponentLink.click();
await human.waitForSelector('#public-profile-card', { timeout: 10000 });
if (!(await human.$('#public-profile-bot-badge'))) fail('the history profile carries no BOT badge');
ok("history names the bot and opens the same badged profile");

if (pageErrors.length) fail(`page errors: ${pageErrors.join(' | ')}`);
console.log('\nALL PLAYBOT E2E CHECKS PASSED');
await browser.close();
process.exit(0);
