// Browser E2E for watching a table: three phones, one court.
//
// The relay tests pin the wire. What only a browser can answer is whether
// what arrives on it is DRAWN as the right court, and whether a watcher's
// screen is honestly a watcher's screen:
//   1. A public table offers a Watch seat in the room browser, and taking it
//      lands on the court rather than in a lobby.
//   2. The court is read-only — no paddle to drive, no serve to aim.
//   3. The HUD says who is being watched, and the score column headed YOU is
//      that player's name instead.
//   4. The score follows the real match, and a watcher who arrives LATE is
//      told where it already got to rather than opening on 0-0.
//   5. Standing up asks nothing (no match, no abandon) and returns to the
//      menu, and the players carry on.
//   6. A machine match ENDS on the watcher's screen too, carries them into a
//      rematch, and takes its table down when its one player walks out — all
//      three of which the wire tests can only ever assert by hand, because
//      the frame that says so is one the client had no path to producing.
//   7. A WATCHER can take the machine's chair from the result overlay they
//      are already standing on, land in a playing seat, and — the one that
//      costs somebody something if it is wrong — not be charged for the match
//      they only watched.
//   8. The warm seat actually works end to end: a machine table's row is
//      OPEN when its chair is claimable and shut while its match runs, and
//      taking the chair walks the host and the watcher off the dead result
//      overlay and back to the lobby, where the Start this table now needs
//      lives. The relay was right about all of this throughout; what was
//      wrong was a payload field nobody asserted and a screen nobody left.
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

const NAMES = new WeakMap();

async function newPlayer(prefix) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#onboarding-modal-overlay', { timeout: 10000 });
  const username = `${prefix}${Date.now().toString(36).slice(-4)}${seq++}`;
  await page.fill('#input-onboarding-username', username);
  await page.waitForSelector('#username-status-available', { timeout: 6000 });
  await page.click('#btn-onboarding-submit');
  await page.waitForSelector('#btn-onboarding-code-continue', { timeout: 10000 })
    .then((b) => b.click())
    .catch(() => {});
  await page.waitForSelector('#main-menu-screen', { timeout: 10000 });
  NAMES.set(page, username);
  return page;
}

const shown = (page, sel) => page.$(sel).then((el) => !!el);
const scoreOf = (page, sel) => page.$eval(sel, (el) => el.textContent.trim());
const totalPoints = (page) =>
  page.evaluate(() => {
    const me = parseInt(document.querySelector('#score-player')?.textContent || '', 10);
    const opp = parseInt(document.querySelector('#score-opponent')?.textContent || '', 10);
    return Number.isNaN(me) || Number.isNaN(opp) ? -1 : me + opp;
  });

/**
 * Park both paddles hard left and keep asking to serve until a point lands.
 * Whichever side holds the serve, one of the two asks gets through; with both
 * paddles parked the point resolves in a couple of seconds. The same shape
 * e2e-duel uses, stopped at the first point rather than at the winner.
 */
async function playOnePoint(host, guest) {
  await host.keyboard.down('KeyA');
  await guest.keyboard.down('KeyA');
  const deadline = Date.now() + 60000;
  let scored = false;
  while (Date.now() < deadline) {
    if ((await totalPoints(host)) >= 1) { scored = true; break; }
    await host.keyboard.press('Space').catch(() => {});
    await guest.keyboard.press('Space').catch(() => {});
    await host.waitForTimeout(800);
  }
  await host.keyboard.up('KeyA');
  await guest.keyboard.up('KeyA');
  if (!scored) fail('no point was ever scored in the watched duel');
}

// ---- Two players at a public table --------------------------------------
const host = await newPlayer('WatchHost');
await host.click('#building-pvp');
await host.click('#room-casual');
await host.waitForSelector('#lobby-tables-empty', { timeout: 8000 });
// Starting a table makes a PUBLIC one — the only kind the client makes now —
// and a public table is advertised, so watching seats are part of that offer
// and are open without asking.
await host.click('#btn-create-room');
const code = await host
  .waitForFunction(() => {
    const id = document.querySelector('#lobby-table')?.getAttribute('data-room-id') || '';
    return /^[A-HJ-NP-Z2-9]{4}$/.test(id) ? id : null;
  }, { timeout: 8000 })
  .then((h) => h.jsonValue());
const hostName = NAMES.get(host);

// Watching seats start SHUT — open ones force the match onto the relay, since
// rtc_signal is refused for a watched table, and defaulting them open would
// take the direct DataChannel away from every duel in the game. So the host
// opens them deliberately, which is the flow this suite is here to drive.
await host.waitForSelector('#toggle-spectators', { timeout: 8000 });
await host.click('#toggle-spectators input');
await host.waitForFunction(
  async (c) => (await (await fetch(`/api/room/${c}`)).json()).spectatorsEnabled === true,
  code,
  { timeout: 8000 }
);
ok('the host opens the table up to watchers');

const guest = await newPlayer('WatchGuest');
await guest.click('#building-pvp');
await guest.click('#room-casual');
await guest.waitForSelector(`#table-${code}`, { timeout: 10000 });
await guest.click(`#table-${code}`);
await guest.waitForSelector('#btn-ready-play', { timeout: 8000 });
await guest.click('#btn-ready-play');
const startBtn = await host.waitForSelector('#btn-ready-play:not([disabled])', { timeout: 8000 });
await startBtn.click();
for (const page of [host, guest]) {
  await page.waitForSelector('#multiplayer-lobby-modal', { state: 'detached', timeout: 8000 });
  await page.waitForSelector('#half-court-canvas', { timeout: 8000 });
}
ok(`a public table is playing (${code})`);

// ---- 1. The Watch seat --------------------------------------------------
const fan = await newPlayer('Fan');
await fan.click('#building-pvp');
await fan.click('#room-casual');
await fan.waitForSelector(`#table-${code}-watch`, { timeout: 10000 });
// The table is FULL — which is exactly when it is worth watching, so the
// Watch control is a separate one rather than a mode of the disabled row.
if ((await fan.getAttribute(`#table-${code}`, 'data-full')) !== 'true') {
  fail('a table with two players is not showing as full');
}
await fan.click(`#table-${code}-watch`);
await fan.waitForSelector('#half-court-canvas', { timeout: 10000 });
if (await shown(fan, '#multiplayer-lobby-modal')) fail('the lobby stayed open over a watched court');
ok('taking a Watch seat lands on the court, not in a lobby');

// ---- 2. The court is read-only ------------------------------------------
if ((await fan.getAttribute('#half-court-container', 'data-readonly')) !== '1') {
  fail('a watched court is drivable');
}
// And a player's is not — the flag is about watching, not about duels.
if ((await host.getAttribute('#half-court-container', 'data-readonly')) !== '0') {
  fail('a PLAYER lost their own paddle to the read-only flag');
}
ok('the watched court takes no pointer, and a played one still does');

// ---- 3. The HUD says whose court this is --------------------------------
await fan.waitForSelector('#hud-watching-chip', { timeout: 8000 });
const label = (await fan.textContent('#score-player-label')).trim();
if (!hostName || label.toLowerCase() !== hostName.toLowerCase()) {
  fail(`the score column reads "${label}" — it should be the watched player (${hostName}), never YOU`);
}
ok(`the HUD names the player being watched ("${label}")`);

// ---- 4. The score follows the real match --------------------------------
// A real point, played by two real phones — not a message injected at the
// socket, so what the watcher shows is what the game actually did.
await playOnePoint(host, guest);
const played = await totalPoints(host);
await fan
  .waitForFunction((n) => {
    const me = parseInt(document.querySelector('#score-player')?.textContent || '', 10);
    const opp = parseInt(document.querySelector('#score-opponent')?.textContent || '', 10);
    return me + opp === n;
  }, played, { timeout: 8000 })
  .catch(async () => fail(`the watcher shows ${await totalPoints(fan)} points, the match has ${played}`));
ok(`the watcher follows the live score (${played} point(s) played)`);

// A watcher arriving LATE is told where the match already got to, rather
// than opening on 0-0 until the next point happens.
const latecomer = await newPlayer('Late');
await latecomer.click('#building-pvp');
await latecomer.click('#room-casual');
await latecomer.waitForSelector(`#table-${code}-watch`, { timeout: 10000 });
await latecomer.click(`#table-${code}-watch`);
await latecomer.waitForSelector('#half-court-canvas', { timeout: 10000 });
await latecomer
  .waitForFunction((n) => {
    const me = parseInt(document.querySelector('#score-player')?.textContent || '', 10);
    const opp = parseInt(document.querySelector('#score-opponent')?.textContent || '', 10);
    return me + opp === n;
  }, played, { timeout: 8000 })
  .catch(async () => fail(`a late watcher opened on ${await totalPoints(latecomer)} points, not the live ${played}`));
ok('a watcher who arrives mid-match opens on the score, not on 0-0');

// The second Watch seat was the only one left, so the control is now spent.
await fan.waitForTimeout(3500); // one poll of the browser
ok('both watching seats are taken');

// ---- 5. Standing up costs nothing ---------------------------------------
await fan.click('#btn-quit-to-menu');
// No confirmation: there is no match to lose and no abandon to charge.
if (await shown(fan, '#quit-confirm-modal')) fail('standing up asked for a confirmation it has nothing to warn about');
await fan.waitForSelector('#main-menu-screen', { timeout: 8000 });
ok('standing up asks nothing and returns to the menu');

// And the players are still playing.
if (!(await shown(host, '#half-court-canvas'))) fail('the host lost their court when a watcher left');
if (!(await shown(guest, '#half-court-canvas'))) fail('the guest lost their court when a watcher left');
// The match is still running — auto-serve keeps it going — so the score may
// legitimately have moved ON. What must never happen is it moving BACK: a
// watcher standing up is not an event in the match.
const stillPlayed = await totalPoints(host);
if (stillPlayed < played) fail(`the host's score went backwards when a watcher left: ${stillPlayed} vs ${played}`);
ok(`the players carry on (${stillPlayed} point(s), never fewer than the ${played} played)`);

// ---- 6. Seats swap before the match, and lock once it starts ------------
// A free seat is a tap target and an occupied one is not: a swap is only ever
// a MOVE to an empty chair, never an exchange with somebody who did not ask.
const h2 = await newPlayer('SwapHost');
await h2.click('#building-pvp');
await h2.click('#room-casual');
// Not the empty state this time — the first table is still up in this room.
await h2.waitForSelector('#btn-create-room', { timeout: 8000 });
await h2.click('#btn-create-room');
// Seats open here too, or the guest below has nowhere to stand up TO.
await h2.waitForSelector('#toggle-spectators', { timeout: 8000 });
await h2.click('#toggle-spectators input');
const code2 = await h2
  .waitForFunction(() => {
    const id = document.querySelector('#lobby-table')?.getAttribute('data-room-id') || '';
    return /^[A-HJ-NP-Z2-9]{4}$/.test(id) ? id : null;
  }, { timeout: 8000 })
  .then((h) => h.jsonValue());

const g2 = await newPlayer('SwapGuest');
await g2.click('#building-pvp');
await g2.click('#room-casual');
await g2.waitForSelector(`#table-${code2}`, { timeout: 10000 });
await g2.click(`#table-${code2}`);
await g2.waitForSelector('#lobby-seats', { timeout: 8000 });
if ((await g2.getAttribute('#seat-1', 'data-mine')) !== 'true') fail('the guest is not shown in seat 1');
if ((await g2.getAttribute('#seat-0', 'data-free')) !== 'false') fail('the host seat reads as free');

// Stand up to watch. The host is still playing, so the court is not emptied.
await g2.click('#seat-2');
await g2.waitForFunction(() => document.querySelector('#seat-2')?.getAttribute('data-mine') === 'true', { timeout: 8000 })
  .catch(() => fail('the guest could not stand up before the match'));
if ((await g2.getAttribute('#seat-1', 'data-free')) !== 'true') fail('the seat they left is still shown as taken');
ok('a player can stand up to watch before the match starts');

// And sit back down.
await g2.click('#seat-1');
await g2.waitForFunction(() => document.querySelector('#seat-1')?.getAttribute('data-mine') === 'true', { timeout: 8000 })
  .catch(() => fail('the guest could not sit back down'));
ok('and sit back down, which is what "pre-match" means');

// ---- 7. Watching a MACHINE match ----------------------------------------
//
// The point of putting the CPU in a seat: a solo match becomes a listed,
// watchable table, so the AI stops being a substitute for a person and
// becomes a warm seat somebody can walk up to. The wire is pinned by
// tests/cpuTable.test.ts against an asymmetric fixture; what only a browser
// can say is that the watcher's screen is a WATCHER's screen — read-only,
// headed with the player's name, and drawing a live court rather than a
// frozen one.
{
  const solo = await newPlayer('CpuHost');
  await solo.click('#building-pvp');
  await solo.click('#room-casual');
  await solo.waitForSelector('#btn-create-room', { timeout: 8000 });
  await solo.click('#btn-create-room');
  const cpuCode = await solo
    .waitForFunction(() => {
      const id = document.querySelector('#lobby-table')?.getAttribute('data-room-id') || '';
      return /^[A-HJ-NP-Z2-9]{4}$/.test(id) ? id : null;
    }, { timeout: 8000 })
    .then((h) => h.jsonValue());

  await solo.waitForSelector('#toggle-spectators', { timeout: 8000 });
  await solo.click('#toggle-spectators input');
  // First to 3, the shortest match anybody can pick, because this leg plays
  // one out to the whistle and every point is a real rally in a real browser.
  await solo.click('#lobby-pts-3');
  await solo.click('#seat-1');
  await solo.waitForSelector('#cpu-picker', { timeout: 5000 });
  await solo.click('#cpu-rookie');
  await solo.waitForSelector('#cpu-picker', { state: 'detached', timeout: 5000 });
  await solo.waitForFunction(
    () => document.querySelector('#seat-1')?.getAttribute('data-occupant') === 'cpu',
    { timeout: 8000 }
  );
  await solo.click('#btn-ready-play');
  await solo.waitForSelector('#half-court-canvas', { timeout: 10000 });
  ok(`a machine match is a table (${cpuCode})`);

  // It is a table like any other in the browser: listed, and offering a seat.
  const onlooker = await newPlayer('CpuFan');
  await onlooker.click('#building-pvp');
  await onlooker.click('#room-casual');
  await onlooker.waitForSelector(`#table-${cpuCode}-watch`, { timeout: 10000 });
  // Full because the MATCH IS RUNNING, which is a narrower claim than the one
  // this used to make. `isFull` is *can I join*, and the machine gives its
  // chair up between matches — so a machine table is only closed while its
  // match is on. Section 8 asserts the other half.
  if ((await onlooker.getAttribute(`#table-${cpuCode}`, 'data-full')) !== 'true') {
    fail('a machine table is joinable while its match is running');
  }
  // And the row says what it is full OF. The route has always sent this and no
  // row ever read it, so a machine table was indistinguishable from a duel.
  // Read off `data-cpu` and not off the rendered text: the rung's label is
  // translated, and matched against the row's whole textContent an English
  // regex would also be satisfied by a player whose NAME contained it.
  if ((await onlooker.getAttribute(`#table-${cpuCode}`, 'data-cpu')) !== 'rookie') {
    fail('the row does not name the machine it is full of');
  }
  ok('the browser row names the machine, and is shut while its match runs');
  await onlooker.click(`#table-${cpuCode}-watch`);
  await onlooker.waitForSelector('#half-court-canvas', { timeout: 10000 });
  if ((await onlooker.getAttribute('#half-court-container', 'data-readonly')) !== '1') {
    fail('a watched machine match is drivable');
  }
  ok('a stranger can watch it, read-only, from the room browser');

  // The court has to be LIVE, not a still. A real point, played by a real
  // phone against the machine — and the score is the honest witness, because
  // on a CPU table it can only reach the watcher through `cpu_frame`:
  // `point_scored` is refused at a table with one human in it, so a design
  // that forgot to forward the score leaves a live court under a scoreboard
  // frozen at whatever `spectator_sync` handed over.
  await solo.keyboard.down('KeyA');
  const deadline = Date.now() + 60000;
  let seen = 0;
  while (Date.now() < deadline && seen < 1) {
    await solo.keyboard.press('Space').catch(() => {});
    await solo.waitForTimeout(800);
    seen = await totalPoints(solo);
  }
  await solo.keyboard.up('KeyA');
  if (seen < 1) fail('no point was ever scored against the machine');
  const followed = await onlooker
    .waitForFunction((n) => {
      const me = parseInt(document.querySelector('#score-player')?.textContent || '', 10);
      const opp = parseInt(document.querySelector('#score-opponent')?.textContent || '', 10);
      return me + opp >= n;
    }, seen, { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  if (!followed) {
    fail(`the watcher shows ${await totalPoints(onlooker)} points, the machine match has ${seen}`);
  }
  ok(`and the court is live: the watcher follows the score (${seen} point(s))`);

  // ---- and the END of it, which is where this all used to fall apart -----
  //
  // The relay learns a machine match is over from one thing only: a
  // `cpu_frame` carrying `live: false` and the deciding score. The publisher
  // sat below the loop's `isServing || winner` return, so that frame could
  // never be produced — the relay kept the table `inPlay` at a stale score,
  // the watcher never got the final `score_update`, and they sat in front of
  // a court that had simply stopped. None of that is visible from the wire
  // tests, which send the frame by hand.
  await solo.keyboard.down('KeyA');
  const finish = Date.now() + 90000;
  while (Date.now() < finish) {
    if (await shown(solo, '#winner-modal-overlay')) break;
    await solo.keyboard.press('Space').catch(() => {});
    await solo.waitForTimeout(700);
  }
  await solo.keyboard.up('KeyA');
  if (!(await shown(solo, '#winner-modal-overlay'))) fail('the machine match never finished');

  const sawResult = await onlooker
    .waitForSelector('#winner-modal-overlay', { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  if (!sawResult) fail('the watcher was left on a court whose match had ended');
  ok('the watcher is told the machine match is over');

  // Play Again has to go through the relay, or match two happens on the
  // host's phone alone: no game_start, so the watcher's court is never reset
  // and — now that they HAVE a result overlay — the next match plays out
  // underneath it, since game_start is one of only two things that clears one.
  await solo.click('#btn-play-again');
  const followedIn = await onlooker
    .waitForFunction(
      () =>
        !document.querySelector('#winner-modal-overlay') &&
        (document.querySelector('#score-player')?.textContent || '').trim() === '0' &&
        (document.querySelector('#score-opponent')?.textContent || '').trim() === '0',
      undefined,
      { timeout: 15000 }
    )
    .then(() => true)
    .catch(() => false);
  if (!followedIn) fail('the watcher was not taken into the rematch');
  ok('Play Again starts a real second match, and the watcher is taken into it');

  // And the reported bug: leaving. A machine table's host is in `solo` mode,
  // so Main Menu never reached the code that leaves a room — the socket
  // stayed open, the seat stayed held, and `isRoomEmpty` therefore saw a live
  // player, so neither the vacate path nor the reaper touched the table for
  // half an hour. Meanwhile the loop stops publishing the moment the screen is
  // no longer the court, so the watcher sat on a still frame of a match
  // nobody was playing, and could walk back into the same dead table.
  await solo.click('#btn-quit-to-menu');
  if (await shown(solo, '#quit-confirm-modal')) await solo.click('#btn-quit-confirm');
  await solo.waitForSelector('#main-menu-screen', { timeout: 10000 });

  const ejected = await onlooker
    .waitForSelector('#half-court-canvas', { state: 'detached', timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  if (!ejected) fail('the watcher is still sitting at a table with nobody playing at it');
  ok('leaving a machine table closes it, and the watchers with it');

  // Gone from the browser too, not merely closed on the people who were in it.
  await onlooker.waitForSelector('#main-menu-screen', { timeout: 10000 });
  await onlooker.click('#building-pvp');
  await onlooker.click('#room-casual');
  const delisted = await onlooker
    .waitForFunction((id) => !document.querySelector(`#table-${id}`), cpuCode, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  if (!delisted) fail(`table ${cpuCode} is still listed with nobody playing at it`);
  ok('and it is gone from the room browser');

  await onlooker.context().close();
  await solo.context().close();
}

// ---- 8. The warm seat: a person takes the machine's chair -----------------
//
// The whole premise of seating a CPU is that you play it until somebody takes
// its chair. Nothing had ever walked that path end to end, and it was broken
// at both ends.
//
// The door did not exist: both listing routes counted the machine into
// `isFull`, and the row is `disabled={table.isFull}`, so every machine table
// in the game was greyed out at 2/2 — while `join_room` would happily have
// seated the tapper between matches. And walking through it wedged the table
// for both people: `resetTableForNextPair` clears `matchOver` for the pair
// about to sit down, so the host was left on the winner overlay of the machine
// match with two live controls, one of which (Play Again → `rematch_request`)
// the relay silently drops on `!matchOver` and the other of which gives up the
// table — while the arrival sat readied in a lobby waiting on a Start nobody
// could press.
//
// Neither half is visible from the wire. The relay's own behaviour was correct
// throughout and is already pinned by tests/cpuTable.test.ts; what was wrong
// was a payload field nobody had asserted and a screen nobody was taken off.
{
  const host = await newPlayer('WarmHost');
  await host.click('#building-pvp');
  await host.click('#room-casual');
  await host.waitForSelector('#btn-create-room', { timeout: 8000 });
  await host.click('#btn-create-room');
  const code = await host
    .waitForFunction(() => {
      const id = document.querySelector('#lobby-table')?.getAttribute('data-room-id') || '';
      return /^[A-HJ-NP-Z2-9]{4}$/.test(id) ? id : null;
    }, { timeout: 8000 })
    .then((h) => h.jsonValue());

  await host.waitForSelector('#toggle-spectators', { timeout: 8000 });
  await host.click('#toggle-spectators input');
  await host.click('#lobby-pts-3');
  await host.click('#seat-1');
  await host.waitForSelector('#cpu-picker', { timeout: 5000 });
  await host.click('#cpu-rookie');
  await host.waitForSelector('#cpu-picker', { state: 'detached', timeout: 5000 });
  await host.waitForFunction(
    () => document.querySelector('#seat-1')?.getAttribute('data-occupant') === 'cpu',
    { timeout: 8000 }
  );

  // Somebody watching, so the fix has to take THEM back to the lobby too —
  // they were left holding a stale result overlay.
  const fan = await newPlayer('WarmFan');
  await fan.click('#building-pvp');
  await fan.click('#room-casual');
  await fan.waitForSelector(`#table-${code}-watch`, { timeout: 10000 });

  // Before Start, the chair is claimable — so the row is OPEN. This is the
  // state the old `isFull` was most wrong about: a host who has seated a
  // machine and not yet pressed Start is advertising a free seat, and the
  // relay would have taken the join.
  //
  // The wait on `data-cpu` is what stops this passing VACUOUSLY. The listing
  // polls every 3 seconds and the Watch button above needs only
  // `spectatorsEnabled`, which is set several UI steps before the machine is
  // seated — so a poll that landed in between shows a row with no CPU and one
  // player, which is `isFull: false` for the ordinary reason and says nothing
  // whatever about the clause under test.
  await fan.waitForFunction(
    (id) => document.querySelector(`#table-${id}`)?.getAttribute('data-cpu') === 'rookie',
    code,
    { timeout: 15000 }
  );
  if ((await fan.getAttribute(`#table-${code}`, 'data-full')) !== 'false') {
    fail('a machine table with no match on it is showing as full');
  }
  await fan.click(`#table-${code}-watch`);
  ok('a machine table offers its chair before the match starts');

  await host.click('#btn-ready-play');
  await host.waitForSelector('#half-court-canvas', { timeout: 10000 });

  // Play it out. Same shape as section 7 — real points, real rallies.
  await host.keyboard.down('KeyA');
  const finish = Date.now() + 90000;
  while (Date.now() < finish) {
    if (await shown(host, '#winner-modal-overlay')) break;
    await host.keyboard.press('Space').catch(() => {});
    await host.waitForTimeout(700);
  }
  await host.keyboard.up('KeyA');
  if (!(await shown(host, '#winner-modal-overlay'))) fail('the machine match never finished');
  ok('the machine match is played to the whistle');

  // The door. A third player browses, and the row has opened up.
  const challenger = await newPlayer('WarmChallenger');
  await challenger.click('#building-pvp');
  await challenger.click('#room-casual');
  const opened = await challenger
    .waitForFunction(
      (id) => {
        const row = document.querySelector(`#table-${id}`);
        // Both, so this cannot be satisfied by a row that has already lost its
        // machine to somebody else.
        return row?.getAttribute('data-cpu') === 'rookie' && row?.getAttribute('data-full') === 'false';
      },
      code,
      { timeout: 15000 }
    )
    .then(() => true)
    .catch(() => false);
  if (!opened) fail(`table ${code} never offered the machine's chair after the whistle`);
  ok('after the whistle the row opens up, and the machine’s chair is offered');

  await challenger.click(`#table-${code}`);
  // Waited on the SEAT, not on the lobby sheet: the challenger is already
  // looking at that sheet — it is where the table browser lives — so a refused
  // join (the ROOM_MID_MATCH race this change introduces by making the row
  // tappable, or a bracket verdict) would leave it open and satisfy it. The
  // footer's Ready/Start control renders only once `roomId` is set.
  await challenger.waitForSelector('#btn-ready-play', { timeout: 10000 });

  // ...and the host is taken off the dead result overlay and back to the
  // lobby, which is the only place the Start this table now needs lives.
  const hostReturned = await host
    .waitForFunction(
      () =>
        !document.querySelector('#winner-modal-overlay') &&
        !!document.querySelector('#multiplayer-lobby-modal'),
      undefined,
      { timeout: 20000 }
    )
    .then(() => true)
    .catch(() => false);
  if (!hostReturned) fail('the host was left on the machine match’s result overlay');

  const fanReturned = await fan
    .waitForFunction(
      () =>
        !document.querySelector('#winner-modal-overlay') &&
        !!document.querySelector('#multiplayer-lobby-modal'),
      undefined,
      { timeout: 20000 }
    )
    .then(() => true)
    .catch(() => false);
  if (!fanReturned) fail('the watcher was left on the machine match’s result overlay');
  ok('taking the chair takes the host and the watcher back to the lobby');

  // ---- and the one moment the two predicates DISAGREE --------------------
  //
  // Right now this table has `matchSeq > 0` (a machine match was played on it)
  // and `matchOver: false` (the eviction ran `resetTableForNextPair`), with
  // nothing being played. That is the ONLY state in which the client's old
  // read and its new one differ, and it is not reachable anywhere else in this
  // suite: every other watcher here sits down at a live match, where the two
  // agree. Old, a watcher arriving here was walked onto an empty court.
  //
  // Vitest cannot reach this — it never loads a .tsx — and the relay half is
  // pinned by tests/spectators.test.ts, which can only assert the FIELD. This
  // is the assertion that says the client reads it.
  const straggler = await newPlayer('WarmStraggler');
  await straggler.click('#building-pvp');
  await straggler.click('#room-casual');
  await straggler.waitForSelector(`#table-${code}-watch`, { timeout: 10000 });
  await straggler.click(`#table-${code}-watch`);
  // Wait for the SEAT to appear in the map, not for the lobby sheet — the
  // sheet is where the table browser lives, so it is already open and would
  // satisfy anything. A watching seat marked as mine means `table_state` and
  // the `spectator_sync` behind it have both landed, which is what makes the
  // negative below mean something rather than mean "not yet".
  await straggler.waitForFunction(
    () =>
      document.querySelector('#seat-2')?.getAttribute('data-mine') === 'true' ||
      document.querySelector('#seat-3')?.getAttribute('data-mine') === 'true',
    undefined,
    { timeout: 10000 }
  );
  if (await shown(straggler, '#half-court-canvas')) {
    fail('a watcher sitting down between matches was walked onto an empty court');
  }
  ok('and a watcher arriving between matches gets the table, not an empty court');

  // And the table works: the handshake the relay was ready for all along.
  await challenger.click('#btn-ready-play');
  await host.waitForFunction(
    () => {
      const b = document.querySelector('#btn-ready-play');
      return !!b && !b.disabled;
    },
    undefined,
    { timeout: 10000 }
  );
  await host.click('#btn-ready-play');
  for (const [page, who] of [[host, 'host'], [challenger, 'challenger'], [fan, 'watcher']]) {
    // Both halves, because all three are sitting in the lobby right now and
    // the host and the watcher were on a court a moment ago: waiting on the
    // canvas alone could be satisfied by a node that never went away. The
    // lobby sheet closing is what `game_start` does, and only it.
    const onCourt = await page
      .waitForFunction(
        () =>
          !document.querySelector('#multiplayer-lobby-modal') &&
          !!document.querySelector('#half-court-canvas'),
        undefined,
        { timeout: 15000 }
      )
      .then(() => true)
      .catch(() => false);
    if (!onCourt) fail(`the ${who} never reached the duel that replaced the machine match`);
  }
  ok('the machine’s chair became a real duel, watchers and all');

  await straggler.context().close();
  await challenger.context().close();
  await fan.context().close();
  await host.context().close();
}

// ---- 9. The warm seat from INSIDE: a watcher takes the chair --------------
//
// Section 8 is the warm seat reached from the room browser. This is the same
// promise reached from where a watcher actually is: sitting on the result
// overlay of the machine match they just watched, looking at an empty chair.
//
// `swap_seat` treated that chair as occupied unconditionally — right about a
// PLAYER, whose swapping onto it would leave seat 0 empty and silently unseat
// the opponent the host chose, and wrong about a watcher, for whom it is the
// only door. The relay half is pinned by tests/cpuTable.test.ts; what only a
// browser can say is that the control exists, that taking it lands the
// watcher in a playing seat rather than back on a dead court, and — the one
// that costs a player something if it is wrong — that they are not charged
// for the match they only WATCHED.
{
  const host = await newPlayer('ChairHost');
  await host.click('#building-pvp');
  await host.click('#room-casual');
  await host.waitForSelector('#btn-create-room', { timeout: 8000 });
  await host.click('#btn-create-room');
  const code = await host
    .waitForFunction(() => {
      const id = document.querySelector('#lobby-table')?.getAttribute('data-room-id') || '';
      return /^[A-HJ-NP-Z2-9]{4}$/.test(id) ? id : null;
    }, { timeout: 8000 })
    .then((h) => h.jsonValue());

  await host.waitForSelector('#toggle-spectators', { timeout: 8000 });
  await host.click('#toggle-spectators input');
  await host.click('#lobby-pts-3');
  await host.click('#seat-1');
  await host.waitForSelector('#cpu-picker', { timeout: 5000 });
  await host.click('#cpu-rookie');
  await host.waitForSelector('#cpu-picker', { state: 'detached', timeout: 5000 });
  await host.waitForFunction(
    () => document.querySelector('#seat-1')?.getAttribute('data-occupant') === 'cpu',
    { timeout: 8000 }
  );

  const fan = await newPlayer('ChairFan');
  await fan.click('#building-pvp');
  await fan.click('#room-casual');
  await fan.waitForSelector(`#table-${code}-watch`, { timeout: 10000 });
  await fan.click(`#table-${code}-watch`);
  await fan.waitForFunction(
    () =>
      document.querySelector('#seat-2')?.getAttribute('data-mine') === 'true' ||
      document.querySelector('#seat-3')?.getAttribute('data-mine') === 'true',
    undefined,
    { timeout: 10000 }
  );

  // What this account had played before it watched anything.
  const playedBefore = await fan.evaluate(async () => {
    const p = await (await fetch('/api/profile/me')).json();
    // Named exactly, with no `?? 0` fallback: a defaulted read of a field
    // that had been renamed would compare 0 to 0 and pass while measuring
    // nothing.
    return { played: p.matchesPlayed, xp: p.xp };
  });

  await host.click('#btn-ready-play');
  await host.waitForSelector('#half-court-canvas', { timeout: 10000 });
  await fan.waitForSelector('#half-court-canvas', { timeout: 10000 });

  await host.keyboard.down('KeyA');
  const finish = Date.now() + 90000;
  while (Date.now() < finish) {
    if (await shown(host, '#winner-modal-overlay')) break;
    await host.keyboard.press('Space').catch(() => {});
    await host.waitForTimeout(700);
  }
  await host.keyboard.up('KeyA');
  if (!(await shown(host, '#winner-modal-overlay'))) fail('the machine match never finished');
  await fan.waitForSelector('#winner-modal-overlay', { timeout: 15000 });
  ok('a watched machine match reaches the whistle on both screens');

  // The control, on the overlay where the watcher is standing.
  await fan.waitForSelector('#btn-take-seat', { timeout: 10000 });
  await fan.click('#btn-take-seat');

  // They land in a PLAYING seat, in the lobby — not back on the dead court
  // the machine match left behind.
  const seated = await fan
    .waitForFunction(
      () =>
        !document.querySelector('#winner-modal-overlay') &&
        !!document.querySelector('#multiplayer-lobby-modal') &&
        (document.querySelector('#seat-0')?.getAttribute('data-mine') === 'true' ||
          document.querySelector('#seat-1')?.getAttribute('data-mine') === 'true'),
      undefined,
      { timeout: 20000 }
    )
    .then(() => true)
    .catch(() => false);
  if (!seated) fail('the watcher who took the chair did not land in a playing seat');

  // The host comes off the same overlay, because their table is a duel now.
  const hostReturned = await host
    .waitForFunction(
      () =>
        !document.querySelector('#winner-modal-overlay') &&
        !!document.querySelector('#multiplayer-lobby-modal'),
      undefined,
      { timeout: 20000 }
    )
    .then(() => true)
    .catch(() => false);
  if (!hostReturned) fail('the host was left on the machine match’s result overlay');
  ok('taking the chair seats the watcher and returns the host to the lobby');

  // The one that costs somebody something if it is wrong. A watcher's
  // `winner` is set — the whole fan-out makes them look like the player they
  // sit beside — and the record effect is keyed on it, so the instant they
  // stop being a watcher it can file a match this device only WATCHED onto
  // this account.
  //
  // TWO independent things stop it, and on this path either alone is enough,
  // which is worth knowing before anyone edits one of them: the lobby-return
  // clears `winner` before `table_state` clears `spectating`, and the record
  // effect MARKS its ref on the spectator branch rather than merely skipping.
  // Measured by removing them one at a time — the suite stays green — and
  // then both, where this assertion fires with `played 0 -> 1` and
  // `xp 0 -> 366`. So it is an OUTCOME check with real teeth and no single
  // mechanism it pins; do not read it as cover for either one.
  const playedAfter = await fan.evaluate(async () => {
    const p = await (await fetch('/api/profile/me')).json();
    // Named exactly, with no `?? 0` fallback: a defaulted read of a field
    // that had been renamed would compare 0 to 0 and pass while measuring
    // nothing.
    return { played: p.matchesPlayed, xp: p.xp };
  });
  if (playedAfter.played !== playedBefore.played || playedAfter.xp !== playedBefore.xp) {
    fail(
      `the promoted watcher was charged for the match they watched: ` +
        `${JSON.stringify(playedBefore)} -> ${JSON.stringify(playedAfter)}`
    );
  }
  ok('and they are not charged for the match they only watched');

  // And the table plays: the handshake, from a seat nobody joined.
  await fan.click('#btn-ready-play');
  await host.waitForFunction(
    () => {
      const b = document.querySelector('#btn-ready-play');
      return !!b && !b.disabled;
    },
    undefined,
    { timeout: 10000 }
  );
  await host.click('#btn-ready-play');
  for (const [page, who] of [[host, 'host'], [fan, 'promoted watcher']]) {
    const onCourt = await page
      .waitForFunction(
        () =>
          !document.querySelector('#multiplayer-lobby-modal') &&
          !!document.querySelector('#half-court-canvas'),
        undefined,
        { timeout: 15000 }
      )
      .then(() => true)
      .catch(() => false);
    if (!onCourt) fail(`the ${who} never reached the duel the claimed chair became`);
  }
  ok('the claimed chair became a real duel');

  await fan.context().close();
  await host.context().close();
}

if (pageErrors.length) fail(`page errors: ${pageErrors.join(' | ')}`);
console.log('\nALL SPECTATE E2E CHECKS PASSED');
await browser.close();
