// Browser E2E for the two ways a lobby gets dismissed.
//
// PART 1 — a HOST walking out of their own room. Dismissing the lobby used to
// only hide the sheet. `room_created` has already flipped the screen to
// 'game', so the host landed alone on a live court: paddle working, serve
// refused (there is no opponent to serve to), and the relay still holding an
// open room whose code they had probably already sent someone. Leaving is now
// a decision, and taking it actually leaves.
//
// PART 2 — a join that is still in flight when the lobby is dismissed.
//
// Asking for a seat and being given one are two different moments, and the
// player can close the lobby in between — a stray tap on the X, or simply
// deciding against it a beat too late. `room_joined` then arrived against a
// shut lobby and seated them anyway: a live court, no Ready control, and a
// host waiting for a readiness they had no way to signal. Neither side could
// move, and only the guest reloading freed the room.
//
// Driven through the TYPED-CODE path with both clicks in one tick, so the
// dismissal is guaranteed to land before the server's answer rather than
// racing it. The bug is in the shared room_joined handling, so an invitation
// link reaches it the same way.
//
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });
const dialogs = [];

let seq = 0;
async function newPlayer(prefix) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`PAGE ERROR [${prefix}]:`, e.message));
  page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  const sim = await page.$('#simulate-smartphone-btn');
  if (sim) await sim.click();
  await page.waitForSelector('#onboarding-modal-overlay', { timeout: 10000 });
  await page.fill('#input-onboarding-username', `${prefix}${Date.now().toString(36).slice(-4)}${seq++}`);
  await page.waitForSelector('#username-status-available', { timeout: 8000 });
  await page.click('#btn-onboarding-submit');
  // Onboarding now ends on the sign-in code. Tolerant, so a suite that
  // reaches here another way is not broken by its absence.
  await page.waitForSelector('#btn-onboarding-code-continue', { timeout: 10000 })
    .then((b) => b.click())
    .catch(() => {});
  await page.waitForSelector('#main-menu-screen', { timeout: 10000 });
  return page;
}

console.log('Leaving a lobby is a decision, and it closes the room');

// A host with nobody else in the room. `roomId` is set, so both the X and the
// Leave button are requests rather than actions.
const solo = await newPlayer('LbX');
await solo.click('#building-pvp');
await solo.click('#room-casual');
await solo.waitForSelector('#btn-create-room', { timeout: 8000 });
await solo.click('#btn-create-room');
await solo.waitForSelector('#lobby-table', { timeout: 8000 });
const doomed = (await solo.getAttribute('#lobby-table', 'data-room-id'))?.trim();
if (!/^[A-Z0-9]{4}$/.test(doomed || '')) fail('host never got a room code');
if ((await fetch(`${BASE}/api/room/${doomed}`)).status !== 200) fail(`room ${doomed} was never open`);

await solo.click('#btn-close-lobby');
const confirmed = await solo.waitForSelector('#leave-lobby-confirm-modal', { timeout: 5000 }).catch(() => null);
if (!confirmed) fail('dismissing a lobby with a live room asked nothing — the host is on the court again');
ok('dismissing a lobby with a room open asks first');

// Escape is the keyboard's close button, and it is gated on there being an
// `onClose` rather than on the BACKDROP being dismissible. The two are
// different questions: this lobby disables backdrop dismissal deliberately,
// because a stray tap outside must not leave the room — and conflating them
// left keyboard users with no way out of the one sheet in the app that
// disables it. It raises the same confirmation the X does, and cancels the
// same way.
await solo.click('#btn-leave-lobby-cancel');
await sleep(400);
await solo.keyboard.press('Escape');
const byKey = await solo
  .waitForSelector('#leave-lobby-confirm-modal', { timeout: 5000 })
  .catch(() => null);
if (!byKey) fail('Escape did nothing in a lobby that disables backdrop dismissal');
ok('Escape closes a sheet whose backdrop is deliberately not dismissible');

// Cancelling has to put them back in the LOBBY, not behind it. This is the
// exact failure being fixed: a court with a paddle and no way to serve.
await solo.click('#btn-leave-lobby-cancel');
await sleep(600);
if (!(await solo.$('#multiplayer-lobby-modal'))) fail('cancelling the prompt still dumped the host on the court');
ok('cancelling keeps them in the lobby');

await solo.click('#btn-close-lobby');
await solo.waitForSelector('#btn-leave-lobby-confirm', { timeout: 5000 });
await solo.click('#btn-leave-lobby-confirm');
await solo.waitForSelector('#main-menu-screen', { timeout: 8000 });
await sleep(800);
const left = await solo.evaluate(() => ({
  lobby: !!document.querySelector('#multiplayer-lobby-modal'),
  court: !!document.querySelector('#half-court-canvas'),
}));
if (left.lobby) fail('confirming left the lobby sheet floating over the menu');
if (left.court) fail('confirming left the court alive behind the menu');
// The room is the point: a code that outlives the player holding it is a code
// somebody else can still be sent.
const after = (await fetch(`${BASE}/api/room/${doomed}`)).status;
if (after !== 404) fail(`room ${doomed} survived its only player leaving (status ${after})`);
ok('confirming returns to the menu and closes the room');

// ---------------------------------------------------------------------------
// Setting a match up is not playing one.
//
// The lobby used to be a sheet over a LIVE court: taking a seat flipped the
// screen to `game`, so a host picking a winning score was standing on a court
// with a ball waiting on them, and a guest who dismissed the sheet found
// themselves there with nothing to do. The court belongs to the MATCH now —
// `game_start` is the only thing that walks anybody onto it.
// ---------------------------------------------------------------------------
console.log('\nSetting up is not playing');
{
  const setup = await newPlayer('LbS');
  await setup.click('#building-pvp');
  await setup.click('#room-casual');
  await setup.waitForSelector('#btn-create-room', { timeout: 8000 });
  await setup.click('#btn-create-room');
  await setup.waitForSelector('#lobby-table', { timeout: 8000 });
  // Settle first. The screen swap is animated, so reading the DOM the instant
  // the code appears finds no court even when one is on its way — which is a
  // check that passes the very regression it exists to catch. Verified by
  // putting the regression back and watching this go red.
  await sleep(1200);

  const held = await setup.evaluate(() => ({
    court: !!document.querySelector('#half-court-canvas'),
    hud: !!document.querySelector('#scoreboard-header'),
    menu: !!document.querySelector('#main-menu-screen'),
  }));
  if (held.court) fail('a host holding a seat is standing on a live court');
  if (held.hud) fail('a host holding a seat has an in-match HUD');
  if (!held.menu) fail('the lobby is not a sheet over the menu any more');
  ok('a seat is a seat: no court, no HUD, the menu still behind the sheet');

  // And dismissing the sheet does not reveal one either — the confirmation is
  // about the ROOM the relay is holding, not about a match in progress.
  await setup.click('#btn-close-lobby');
  await setup.waitForSelector('#btn-leave-lobby-confirm', { timeout: 5000 });
  await setup.click('#btn-leave-lobby-confirm');
  await setup.waitForSelector('#main-menu-screen', { timeout: 8000 });
  if (await setup.$('#half-court-canvas')) fail('leaving the lobby uncovered a court');
  ok('and leaving it never uncovers one');
  await setup.context().close();
}

console.log('\nA join in flight survives the lobby being dismissed');

const host = await newPlayer('LbH');
await host.click('#building-pvp');
await host.click('#room-casual');
await host.waitForSelector('#btn-create-room', { timeout: 8000 });
await host.click('#btn-create-room');
await host.waitForSelector('#lobby-table', { timeout: 8000 });
const code = await host.evaluate(() => {
  // Read the code from its own element rather than regexing the panel's text
  // for an English label — that coupled the suite to copy that is now
  // translated, and to the label sitting immediately before the code.
  const t = (document.querySelector('#lobby-table')?.getAttribute('data-room-id') || '').trim();
  return /^[A-Z0-9]{4}$/.test(t) ? t : null;
});
if (!code) fail('host never got a room code');
ok(`host opened room ${code}`);

// The HOST has the same window, and it was open. Asking for a room and being
// given one are separate moments too, and before `room_created` lands roomId
// is still null — so dismissing is a plain dismissal that asks nothing. The
// answer then flips the screen to `game` and seats the host behind a shut
// lobby: alone on a live court with no code to share and no Leave control,
// while the relay goes on holding the room they may already have sent someone.
const lone = await newPlayer('LbC');
await lone.click('#building-pvp');
await lone.click('#room-casual');
await lone.waitForSelector('#btn-create-room', { timeout: 8000 });
await lone.evaluate(() => {
  document.querySelector('#btn-create-room').click();
  document.querySelector('#btn-close-lobby').click();
});
await sleep(2500);
// Holding a seat no longer puts anybody on a court — a table you are setting
// a match up at is not a match — so the ROOM CODE is what says the seat
// landed. The menu being behind the sheet is now the expected state, not the
// evidence of a bug it used to be.
const loneState = await lone.evaluate(() => ({
  court: !!document.querySelector('#half-court-canvas'),
  lobby: !!document.querySelector('#multiplayer-lobby-modal'),
  code: (document.querySelector('#lobby-table')?.getAttribute('data-room-id') || '').trim(),
  leave: !!document.querySelector('#btn-leave-room'),
}));
if (!loneState.code) fail('the create never landed at all — wrong bug reproduced');
if (loneState.court) fail('a host setting up a match was put on a live court');
if (!loneState.lobby) fail('host holds a room with the lobby shut — no code to share, no way out');
if (!/^[A-Z0-9]{4}$/.test(loneState.code)) fail('the reopened lobby shows no room code');
if (!loneState.leave) fail('host holds a room with no Leave control');
ok('a room created into a shut lobby reopens it, code and Leave control and all');
await lone.context().close();

// Ask for the seat and shut the lobby in the same tick — the answer cannot
// have arrived yet, so this is the window rather than a race against it.
const guest = await newPlayer('LbG');
await guest.click('#building-pvp');
await guest.click('#room-casual');
await guest.waitForSelector('#btn-join-room-submit', { timeout: 8000 });
await guest.fill('#input-room-code', code);
await guest.evaluate(() => {
  document.querySelector('#btn-join-room-submit').click();
  document.querySelector('#btn-close-lobby').click();
});
await sleep(2500);

// `#btn-leave-room` lives INSIDE the lobby, so it cannot tell "no seat" from
// "seat held behind a shut lobby" — which is the whole distinction here. The
// room code can: it is only ever rendered for a seat that was actually given.
const state = await guest.evaluate(() => ({
  court: !!document.querySelector('#half-court-canvas'),
  code: (document.querySelector('#lobby-table')?.getAttribute('data-room-id') || '').trim(),
  lobby: !!document.querySelector('#multiplayer-lobby-modal'),
  ready: !!document.querySelector('#btn-ready-play'),
}));
if (!state.code) fail('the join never landed at all — wrong bug reproduced');
if (state.court) fail('a guest waiting to be started was put on a live court');
ok('the seat was granted even though the lobby had been dismissed');
if (!state.lobby) fail('guest holds a seat with the lobby shut — no way back to it');
if (!state.ready) fail('guest holds a seat but has no Ready control, so the host waits forever');
ok('a seat granted to a shut lobby reopens it, Ready control and all');

// Cosmetics are not the point: the match has to be startable from here.
await guest.click('#btn-ready-play');
await sleep(1200);
const btn = await host.waitForSelector('#btn-ready-play:not([disabled])', { timeout: 8000 }).catch(() => null);
if (!btn) fail('host could not start — the guest never managed to ready up');
await btn.click();
await sleep(2500);
const onCourt = await Promise.all([
  host.evaluate(() => !document.querySelector('#multiplayer-lobby-modal')),
  guest.evaluate(() => !document.querySelector('#multiplayer-lobby-modal')),
]);
if (!onCourt[0] || !onCourt[1]) fail(`both phones did not reach the court (host=${onCourt[0]} guest=${onCourt[1]})`);
ok('the duel starts normally afterwards');

// ---------------------------------------------------------------------------
// A guest whose HOST walks out is not left waiting on a room that cannot start.
// Seat 0 is only ever filled by create_room, so a hostless room can never have
// one again: join_room fills seat 1, and start_match is refused to anyone but
// seat 0. The lobby deliberately does not bounce on opponent_left — but that
// is about a host going back to waiting for the next guest, which is the
// opposite situation.
// ---------------------------------------------------------------------------
const host2 = await newPlayer('LbH2');
const guest2 = await newPlayer('LbG2');

await host2.click('#building-pvp');
await host2.click('#room-casual');
await host2.waitForSelector('#btn-create-room', { timeout: 8000 });
await host2.click('#btn-create-room');
const code2 = await host2
  .waitForFunction(() => {
    const t = (document.querySelector('#lobby-table')?.getAttribute('data-room-id') || '').trim();
    return /^[A-HJ-NP-Z2-9]{4}$/.test(t) ? t : null;
  }, { timeout: 8000 })
  .then((h) => h.jsonValue());

await guest2.goto(`${BASE}/?room=${code2}`, { waitUntil: 'networkidle' });
const sim3 = await guest2.$('#simulate-smartphone-btn');
if (sim3) await sim3.click();
await guest2.waitForSelector('#btn-ready-play', { timeout: 10000 });

// The host leaves, through the confirmation this suite already exercises.
await host2.click('#btn-close-lobby');
await host2.waitForSelector('#btn-leave-lobby-confirm', { timeout: 5000 });
await host2.click('#btn-leave-lobby-confirm');

// The LOBBY closing is the signal, not the menu appearing: a player waiting to
// be started is on the menu already, with the lobby as a sheet over it, so
// `#main-menu-screen` was there before the host ever left.
const guestHome = await guest2
  .waitForSelector('#multiplayer-lobby-modal', { state: 'detached', timeout: 10000 })
  .then(() => true)
  .catch(() => false);
if (!guestHome) fail('the guest was left in a lobby whose room can never start');
if (!(await guest2.$('#main-menu-screen'))) fail('the guest was not returned to the menu');
// And the room goes with them, rather than holding its code until the reaper.
const gone = await guest2.evaluate(
  (c) => fetch(`/api/room/${c}`).then((r) => r.status),
  code2
);
if (gone !== 404) fail(`the hostless room is still open (GET /api/room returned ${gone})`);
ok('a guest whose host walks out is returned to the menu, and the room closes');

// ---------------------------------------------------------------------------
// PART 4 — the opponent chair, and what a machine in it makes the match.
//
// The largest cost of seating a CPU at a table is on the CLIENT: `mode` has
// to stay 'solo' at a relay seat, which is a fourth state App has never had,
// and `tsc` names none of the branches that get it wrong. Left alone the
// match records as an unranked PvP duel against nobody, the quit confirmation
// never fires, and the run is written into the duel mode's stats. The HUD's
// Reset button is the cheapest honest witness: it is hidden in a DUEL,
// deliberately, because the score belongs to the room.
// ---------------------------------------------------------------------------
console.log('\nA machine in the opponent chair');
{
  const cpu = await newPlayer('LbC');
  await cpu.click('#building-pvp');
  await cpu.click('#room-casual');
  await cpu.waitForSelector('#btn-create-room', { timeout: 8000 });
  await cpu.click('#btn-create-room');
  await cpu.waitForSelector('#lobby-seats', { timeout: 8000 });

  // The chair opposite the host. Free, and the host's to fill — a SWAP into
  // it was never available, since `swap_seat` refuses any move that would
  // leave nobody playing.
  await cpu.click('#seat-1');
  await cpu.waitForSelector('#cpu-picker', { timeout: 5000 });
  ok('tapping the free opponent seat opens the picker');

  // A fresh account has earned nothing above Rookie, so the rungs above it
  // render as locks rather than as dead rows.
  const locked = await cpu.evaluate(() => ({
    rookie: !!document.querySelector('#cpu-rookie'),
    // A locked segment is honestly `disabled`; the lock's own tap target is
    // a sibling overlay, which is why this reads the button rather than a
    // wrapper — a `data-` attribute that drifted onto one would make this
    // assertion pass vacuously.
    cyber: document.querySelector('#cpu-cyber')?.disabled,
  }));
  if (!locked.rookie) fail('the picker offered no Rookie rung');
  if (locked.cyber !== true) fail('an unearned rung was offered as selectable');
  ok('unearned rungs are locked rather than absent');

  await cpu.click('#cpu-rookie');
  await cpu.waitForSelector('#cpu-picker', { state: 'detached', timeout: 5000 });
  await sleep(600);
  const seated = await cpu.getAttribute('#seat-1', 'data-occupant');
  if (seated !== 'cpu') fail(`the seat did not take the machine (data-occupant=${seated})`);
  ok('the chair holds the machine');

  // The badge is about the SOLO match this now is, not about a duel — so it
  // answers with the solo verdicts. Read as data rather than as prose: the
  // sentence has seven translations and the verdict is what has to be right.
  //
  // Rookie is all a fresh account can pick and Rookie never rates, so shut
  // seats read `difficulty`. That makes this a stronger check than a bare
  // ranked/unranked flip: `unrankedReasons` is ORDERED and the panel renders
  // blockers[0] alone, so `watched` appearing here proves it outranks
  // `difficulty` — which is what stops the badge telling a host that picking
  // a harder rung would restore a ladder the open seats have already taken.
  const shutBadge = await cpu.getAttribute('#lobby-rules-status', 'data-blocker');
  if (shutBadge !== 'difficulty') {
    fail(`a Rookie table nobody may watch read as ${shutBadge}, not difficulty`);
  }
  await cpu.click('#toggle-spectators input');
  await sleep(600);
  const openBadge = await cpu.getAttribute('#lobby-rules-status', 'data-blocker');
  if (openBadge !== 'watched') fail(`opening the watching seats read as ${openBadge}, not watched`);
  ok('opening the watching seats outranks every other reason it is unrated');
  await cpu.click('#toggle-spectators input');
  await sleep(400);

  // Start needs no second person and no Ready tap: seating the machine is the
  // yes. `canStart` is `players[0] && players[1] && ready[1]`, so a design
  // that only set a ready flag would leave this button doing nothing at all.
  // And the Start button is live with nobody opposite: seating the machine is
  // the yes, so there is no Ready tap to wait on. It is gated on
  // `opponentName` otherwise, which a CPU never sets — the relay would accept
  // the start and the button that sends it would stay dead forever.
  if (await cpu.evaluate(() => document.querySelector('#btn-ready-play')?.disabled)) {
    fail('Start is disabled at a CPU table — the relay would accept it and nothing can send it');
  }
  await cpu.click('#btn-ready-play');
  await cpu.waitForSelector('#half-court-canvas', { timeout: 10000 });
  ok('the host starts alone, because seating the machine is the yes');

  const hud = await cpu.evaluate(() => ({
    reset: !!document.querySelector('#btn-reset-match'),
    lobby: !!document.querySelector('#multiplayer-lobby-modal'),
  }));
  if (hud.lobby) fail('the lobby stayed open over the court');
  // The witness: Reset is hidden in a duel and offered in a solo match.
  if (!hud.reset) fail('the court came up in MULTIPLAYER mode — the match will record as a duel');
  ok('the court is a solo court: Reset offered, so mode stayed solo');

  await cpu.context().close();
}

if (dialogs.length) fail(`unexpected error dialog: ${dialogs.join(' | ')}`);

console.log('\nLOBBY DISMISSAL CHECKS PASSED');
await browser.close();
