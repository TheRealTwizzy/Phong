// Browser E2E for a duel being ONE match rather than two private ones.
//
// The reported failure: after a match ended, one player pressed Rematch and
// their match restarted immediately while the other sat on the winner overlay
// with a greyed-out "Waiting for Opponent". Underneath it, each phone was
// applying its own winning score — taken from the SOLO menu, which is the only
// place the picker ever appeared — so a room could end for one player while
// the other was still mid-rally with no way forward.
//
// Covered here: the rematch handshake on both transports; two phones that
// disagreed about the match length before this change; and the lobby settings
// that fixed it — the host sets the room's terms, the guest reads them.
//
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

const browser = await chromium.launch({
  executablePath: EXEC,
  args: ['--no-sandbox', '--allow-loopback-in-peer-connection', '--disable-features=WebRtcHideLocalIpsWithMdns'],
});

async function newPage() {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  return page;
}

let nameCounter = 0;
const uniqueName = (prefix) => `${prefix}${Date.now().toString(36).slice(-4)}${nameCounter++}`;

async function onboard(page, prefix) {
  const modal = await page.waitForSelector('#onboarding-modal-overlay', { timeout: 4000 }).catch(() => null);
  if (!modal) return;
  await page.fill('#input-onboarding-username', uniqueName(prefix));
  await page.waitForSelector('#username-status-available', { timeout: 5000 });
  await page.click('#btn-onboarding-submit');
  // Onboarding now ends on the sign-in code. Tolerant, so a suite that
  // reaches here another way is not broken by its absence.
  await page.waitForSelector('#btn-onboarding-code-continue', { timeout: 10000 })
    .then((b) => b.click())
    .catch(() => {});
  await page.waitForSelector('#onboarding-modal-overlay', { state: 'detached', timeout: 8000 });
}

async function passGatekeeper(page) {
  const sim = await page.$('#simulate-smartphone-btn');
  if (sim) await sim.click();
}

/**
 * Pick a winning score. The picker lives in SOLO's pre-match sheet —
 * multiplayer takes its target from the room instead — so this is exactly how
 * a player's local default gets set: from whatever they last chose for a solo
 * match.
 *
 * Every mode opens a Sheet now, the duel included, so the sheet is dismissed
 * through its own close control. Tapping #menu-mode-solo a second time used
 * to collapse an accordion; it now lands on the sheet's backdrop.
 */
async function pickShortMatch(page, points = 3) {
  const lobby = await page.$('#multiplayer-lobby-modal');
  if (lobby) await page.click('#btn-close-lobby');
  await page.click('#menu-mode-solo');
  const btn = await page.waitForSelector(`#menu-pts-${points}:not([disabled])`, { timeout: 4000 }).catch(() => null);
  if (!btn) fail(`winning-score button #menu-pts-${points} not available`);
  await btn.click();
  await page.click('#btn-close-prematch');
  await page.waitForSelector('#prematch-modal', { state: 'detached', timeout: 4000 });
}

async function hostCreateRoom(page, { p2p, points = 3 }) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await passGatekeeper(page);
  await onboard(page, 'RmHost');
  await pickShortMatch(page, points);
  await page.click('#menu-mode-multiplayer');
  await page.waitForSelector('#btn-create-room', { timeout: 5000 });
  if (!p2p) await page.click('#toggle-p2p input, #toggle-p2p');
  await page.click('#btn-create-room');
  return page
    .waitForFunction(() => {
      // The code has its own element; hunting for it by a styling class meant
      // any restyle of the lobby silently broke the lookup.
      const txt = (document.querySelector('#lobby-room-code')?.textContent || '').trim();
      return /^[A-HJ-NP-Z2-9]{4}$/.test(txt) ? txt : null;
    }, { timeout: 5000 })
    .then((h) => h.jsonValue());
}

// The typed-code path, deliberately WITHOUT ?room= in the URL: a link joins
// for the player by itself (scripts/e2e-invite.mjs), so driving the code box
// from a link would be racing the auto-join rather than testing this.
async function guestJoin(page, code, points = 3) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await passGatekeeper(page);
  await onboard(page, 'RmGuest');
  await pickShortMatch(page, points);
  await page.click('#menu-mode-multiplayer');
  await page.waitForSelector('#btn-join-room-submit', { timeout: 5000 });
  // Regression guard for the "match starts zoomed" bug: iOS Safari zooms the
  // page when an input under 16px is focused and STAYS zoomed afterwards —
  // typing the room code was the trigger. The input must render at >=16px
  // and the viewport must cap the scale.
  const fontPx = await page.$eval('#input-room-code', (el) => parseFloat(getComputedStyle(el).fontSize));
  if (fontPx < 16) fail(`room-code input is ${fontPx}px — iOS will zoom on focus and stay zoomed`);
  const viewport = await page.$eval('meta[name="viewport"]', (el) => el.getAttribute('content') || '');
  if (!/maximum-scale=1/.test(viewport)) fail(`viewport meta lacks maximum-scale=1: "${viewport}"`);
  const input = await page.$('#input-room-code');
  if ((await input.inputValue()) !== code) await input.fill(code);
  await page.click('#btn-join-room-submit');
}

/**
 * The lobby handshake: the GUEST readies, which enables the HOST's start
 * button; the host starts, and game_start closes BOTH lobbies at once —
 * neither player clicks their own way onto the court any more.
 */
async function startDuel(host, guest) {
  await guest.waitForSelector('#btn-ready-play', { timeout: 8000 });
  await guest.click('#btn-ready-play');
  const btn = await host.waitForSelector('#btn-ready-play:not([disabled])', { timeout: 8000 });
  await btn.click();
  for (const [page, who] of [[host, 'host'], [guest, 'guest']]) {
    const closed = await page
      .waitForSelector('#multiplayer-lobby-modal', { state: 'detached', timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    if (!closed) fail(`${who}'s lobby did not close on game_start`);
    await page.waitForSelector('#half-court-canvas', { timeout: 5000 });
  }
}

async function tapServe(page) {
  const box = await (await page.$('#half-court-canvas')).boundingBox();
  if (!box) fail('canvas has no bounding box');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.9);
}

const totalPoints = (page) =>
  page.evaluate(() => {
    const me = parseInt(document.querySelector('#score-player')?.textContent || '', 10);
    const opp = parseInt(document.querySelector('#score-opponent')?.textContent || '', 10);
    return Number.isNaN(me) || Number.isNaN(opp) ? -1 : me + opp;
  });

const overlayUp = (page) => page.$('#btn-play-again').then((el) => !!el);

/**
 * Park both paddles hard left and keep tapping serve on both phones until
 * someone wins. Whichever side holds the serve, one of the two taps lands;
 * with both paddles parked the point resolves in a couple of seconds.
 */
async function playToWinner(host, guest, label) {
  await host.keyboard.down('KeyA');
  await guest.keyboard.down('KeyA');
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (await overlayUp(host)) break;
    await tapServe(host).catch(() => {});
    await tapServe(guest).catch(() => {});
    await host.waitForTimeout(1200);
  }
  await host.keyboard.up('KeyA');
  await guest.keyboard.up('KeyA');

  for (const [page, who] of [[host, 'host'], [guest, 'guest']]) {
    const up = await page.waitForSelector('#btn-play-again', { timeout: 8000 }).catch(() => null);
    if (!up) fail(`${label}: ${who} never reached the winner overlay (points=${await totalPoints(page)})`);
  }
  ok(`${label}: both phones reached the winner overlay`);
}

/** The Rematch button's own label tells us whether this side's vote landed. */
const rematchLabel = (page) =>
  page.$eval('#btn-play-again', (el) => ({
    text: (el.textContent || '').trim(),
    disabled: el.hasAttribute('disabled'),
  }));

async function rematchHandshake(host, guest, label) {
  // First voter: the host, exactly as reported.
  await host.click('#btn-play-again');
  await host.waitForTimeout(1500);

  const hostVote = await rematchLabel(host).catch(() => null);
  if (!hostVote || !hostVote.disabled) fail(`${label}: host's own vote did not register (${JSON.stringify(hostVote)})`);
  ok(`${label}: host voted — button shows "${hostVote.text}"`);

  if (!(await overlayUp(guest))) fail(`${label}: guest left the overlay on the host's vote alone`);

  // Second voter: the guest. Now BOTH have voted, so both must restart.
  await guest.click('#btn-play-again');

  const gone = async (page, who) => {
    const left = await page
      .waitForSelector('#btn-play-again', { state: 'detached', timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    if (!left) {
      const state = await rematchLabel(page).catch(() => null);
      fail(`${label}: ${who} STUCK on the winner overlay after both votes (${JSON.stringify(state)})`);
    }
  };
  await gone(guest, 'guest');
  await gone(host, 'host');
  ok(`${label}: both phones restarted on the second vote`);

  // A restarted match is a real one: 0-0 and the court is live on both.
  for (const [page, who] of [[host, 'host'], [guest, 'guest']]) {
    const pts = await totalPoints(page);
    if (pts !== 0) fail(`${label}: ${who} restarted with a stale score (total=${pts})`);
  }
  ok(`${label}: both scoreboards reset to 0-0`);
}

for (const transport of ['relay', 'p2p']) {
  console.log(`\n--- rematch over ${transport.toUpperCase()} ---`);
  const host = await newPage();
  const guest = await newPage();
  const code = await hostCreateRoom(host, { p2p: transport === 'p2p' });
  await guestJoin(guest, code);
  await startDuel(host, guest);
  const badge = await host.$eval('#link-status-badge', (el) => el.textContent.trim()).catch(() => '?');
  console.log(`  link badge: ${badge}`);
  await playToWinner(host, guest, transport);
  await rematchHandshake(host, guest, transport);
  await host.context().close();
  await guest.context().close();
}

// ---- The two phones must play ONE match, not two private ones ----
// Each phone used to apply its OWN winning score, so a room where the host
// wanted first-to-5 and the guest first-to-3 ended for the guest at 3 while
// the host was still mid-match. The guest's loop stops on its winner overlay,
// so the host can never reach 5: stuck, with no overlay and no way back but
// the menu. The room owns the winning score now, so both end together.
{
  console.log('\n--- mismatched winning scores ---');
  const host = await newPage();
  const guest = await newPage();
  const code = await hostCreateRoom(host, { p2p: false, points: 5 });
  await guestJoin(guest, code, 3);
  await startDuel(host, guest);
  await playToWinner(host, guest, 'mismatched');
  await rematchHandshake(host, guest, 'mismatched');
  await host.context().close();
  await guest.context().close();
}

// ---- The lobby is where a duel's terms are set, and both sides see them ----
{
  console.log('\n--- lobby match settings ---');
  const host = await newPage();
  const guest = await newPage();
  const code = await hostCreateRoom(host, { p2p: false, points: 5 });
  await guestJoin(guest, code, 3);

  await host.waitForSelector('#lobby-match-settings', { timeout: 8000 });
  await guest.waitForSelector('#lobby-match-settings', { timeout: 8000 });
  ok('both phones see the room settings block');

  // Read the selection from the control's own state, not from a colour. This
  // used to test `className.includes('border-cyan-400')`, which coupled the
  // suite to a literal Tailwind class and broke on any restyle.
  const selected = (page) =>
    page.evaluate(() =>
      [3, 5, 10, 15].find((p) => {
        const el = document.querySelector(`#lobby-pts-${p}`);
        return el && el.getAttribute('data-selected') === 'true';
      })
    );

  if ((await selected(host)) !== 5) fail(`host's room did not open on their own choice (got ${await selected(host)})`);
  if ((await selected(guest)) !== 5) fail(`guest sees a different length than the host (got ${await selected(guest)})`);
  ok("the room opens on the host's choice, and the guest reads the same one");

  const guestDisabled = await guest.$eval('#lobby-pts-3', (el) => el.hasAttribute('disabled'));
  if (!guestDisabled) fail("guest can edit the host's match length");
  ok("the guest's controls are read-only");

  await host.click('#lobby-pts-3');
  const followed = await guest
    .waitForFunction(() => {
      const el = document.querySelector('#lobby-pts-3');
      return el && el.getAttribute('data-selected') === 'true';
    }, { timeout: 6000 })
    .then(() => true)
    .catch(() => false);
  if (!followed) fail(`the host's change never reached the guest (guest still on ${await selected(guest)})`);
  ok("the host's change reaches the guest's lobby");

  // A tuned rule inside its band keeps the match ranked; past the band it does not.
  await host.click('#lobby-rules-toggle');
  const setSlider = (page, key, value) =>
    page.$eval(
      `#lobby-rule-slider-${key}`,
      (el, v) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, String(v));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      },
      value
    );
  const status = (page) => page.$eval('#lobby-rules-status', (el) => (el.textContent || '').trim());

  await setSlider(host, 'paddleScale', 1.15);
  await host.waitForTimeout(600);
  if (/Past ranked/i.test(await status(host))) fail('a paddle at the band edge lost the match its rating');
  ok('a paddle tuned to the edge of its band still counts for rank');

  await setSlider(host, 'paddleScale', 1.6);
  await host.waitForTimeout(600);
  if (!/Past ranked/i.test(await status(host))) fail(`a 160% paddle still reads as ranked: ${await status(host)}`);
  ok('a paddle pushed past the band unranks the match');

  const guestSees = await guest
    .waitForFunction(() => {
      const el = document.querySelector('#lobby-rules-status');
      return el && /Past ranked/i.test(el.textContent || '');
    }, { timeout: 6000 })
    .then(() => true)
    .catch(() => false);
  if (!guestSees) fail('the guest was not told the match had stopped counting for rank');
  ok('the guest is told the match no longer counts for rank');

  await host.context().close();
  await guest.context().close();
}

// ---- Auto-serve must not start a match against nobody --------------------
// The host sits on the court underneath the lobby from the moment the room
// exists. Setting auto-serve while waiting used to arm the timer right away:
// it fired, served, and the "match" began with no opponent in the room.
{
  console.log('\n--- auto-serve while waiting for an opponent ---');
  const host = await newPage();
  const code = await hostCreateRoom(host, { p2p: false });

  // Set the shortest auto-serve from the lobby, then just wait it out.
  await host.waitForSelector('#lobby-match-settings', { timeout: 8000 });
  await host.click('#lobby-rules-toggle');
  await host.click('#lobby-rule-autoserve-1');
  await host.click('#lobby-rules-toggle'); // collapse so Play stays reachable
  await host.waitForTimeout(3500);

  const room = await host.evaluate(async (c) => (await fetch(`/api/room/${c}`)).json(), code);
  if (!room.exists) fail('the room disappeared while waiting');
  if (room.playerCount !== 1) fail(`expected a lone host, got ${room.playerCount} players`);
  if (room.inPlay) fail('auto-serve started the match with no opponent in the room');
  if (!(await host.$('#multiplayer-lobby-modal'))) fail('the lobby closed by itself');
  ok('a 1s auto-serve waited out 3.5s without a ball entering play');

  // The guard releases: once an opponent joins and both enter the court, the
  // same timer serves for real.
  const guest = await newPage();
  await guestJoin(guest, code);
  await startDuel(host, guest);
  const live = await host
    .waitForFunction(
      async (c) => (await (await fetch(`/api/room/${c}`)).json()).inPlay,
      code,
      { timeout: 10000, polling: 1000 }
    )
    .then(() => true)
    .catch(() => false);
  if (!live) fail('auto-serve never fired once the duel was actually ready');
  ok('the same timer serves once an opponent is in and the lobby is closed');
  await host.context().close();
  await guest.context().close();
}

// ---- Countdown, the ranked auto-serve mandate, and the disconnect bounce --
{
  console.log('\n--- countdown, ranked auto-serve, disconnect ---');
  const host = await newPage();
  const guest = await newPage();
  const code = await hostCreateRoom(host, { p2p: false });

  // A fresh room's default rules are ranked, and ranked play MUST carry an
  // auto-serve timer: the lobby arrives with 5s already selected and the
  // "off" option refused.
  await host.waitForSelector('#lobby-match-settings', { timeout: 8000 });
  await host.click('#lobby-rules-toggle');
  const offDisabled = await host.$eval('#lobby-rule-autoserve-0', (el) => el.hasAttribute('disabled'));
  const fiveSelected = await host.$eval(
    '#lobby-rule-autoserve-5',
    (el) => el.getAttribute('data-selected') === 'true'
  );
  if (!offDisabled) fail('auto-serve "off" is selectable on a ranked room');
  if (!fiveSelected) fail('a ranked room did not arrive with the 5s auto-serve forced');
  ok('ranked room: auto-serve arrives forced to 5s and "off" is refused');
  // Collapse the panel again: left open it pushes the Play button off the
  // phone viewport and the court-entry click silently misses.
  await host.click('#lobby-rules-toggle');

  await guestJoin(guest, code);

  // The host cannot start until the guest readies: an opponent merely
  // JOINING no longer enables the start button.
  await guest.waitForSelector('#btn-ready-play', { timeout: 8000 });
  await host.waitForTimeout(800);
  const hostGated = await host.$eval('#btn-ready-play', (el) => el.hasAttribute('disabled'));
  if (!hostGated) fail('the host could start before the guest readied');
  ok('the host is gated until the guest clicks ready');

  // game_start closes both lobbies at once now, so the two countdowns run
  // together — and neither started early behind a lobby.
  await startDuel(host, guest);
  await host.waitForSelector('#match-countdown', { timeout: 3000 });
  await guest.waitForSelector('#match-countdown', { timeout: 3000 });
  ok('both phones count down together from the moment the host starts');

  // The host holds the first serve: a tap during the countdown must not put
  // a ball in play.
  await tapServe(host).catch(() => {});
  const early = await host.evaluate(async (c) => (await fetch(`/api/room/${c}`)).json(), code);
  if (early.inPlay) fail('a serve landed during the start countdown');
  ok('serves are refused while the countdown runs');

  // Countdown done + the mandated 5s timer -> the ball enters play by itself.
  const live = await host
    .waitForFunction(
      async (c) => (await (await fetch(`/api/room/${c}`)).json()).inPlay,
      code,
      { timeout: 15000, polling: 1000 }
    )
    .then(() => true)
    .catch(() => false);
  if (!live) fail('the mandated auto-serve never started the ranked match');
  ok('the mandated timer serves once the countdown clears');

  // Quitting a live duel asks first — walking out is an abandon, and it
  // should never happen off a single mis-tap.
  await guest.click('#btn-quit-to-menu');
  await guest.waitForSelector('#quit-confirm-modal', { timeout: 4000 });
  await guest.click('#btn-quit-cancel');
  await guest.waitForSelector('#quit-confirm-modal', { state: 'detached', timeout: 3000 });
  if (!(await guest.$('#half-court-canvas'))) fail('cancelling the quit did not stay in the match');
  ok('quitting a live match asks for confirmation; cancel stays in');

  // Mid-match, the guest's connection dies. The host must not be stranded on
  // a dead court: they are returned to the menu with a notice.
  await guest.context().close();
  await host.waitForSelector('#main-menu-screen', { timeout: 8000 }).catch(() => {
    fail('host was not returned to the menu after a mid-match disconnect');
  });
  await host.waitForSelector('#toast-opponent-left', { timeout: 4000 }).catch(() => {
    fail('no notice shown for the mid-match disconnect');
  });
  ok('a mid-match disconnect bounces the survivor to the menu with a notice');
  await host.context().close();
}

// ---- The opponent sonar in a duel: fed by the other phone's stream --------
// The radar used to be hard-gated to solo — in PvP it simply never rendered —
// and even ungated it had nothing to show, because a phone never simulates
// the opponent's half in a duel. The opponent's phone now streams its live
// ball (ball_pos → opponent_ball), so the sonar behaves exactly as in solo:
// visible while the ball is on the half you cannot see, dark while it is on
// yours or between points.
for (const transport of ['relay', 'p2p']) {
  console.log(`\n--- opponent sonar in a duel (${transport.toUpperCase()}) ---`);
  const host = await newPage();
  const guest = await newPage();
  const code = await hostCreateRoom(host, { p2p: transport === 'p2p' });
  await guestJoin(guest, code);
  await startDuel(host, guest);

  for (const [page, who] of [[host, 'host'], [guest, 'guest']]) {
    if (!(await page.$('#radar-preview-container'))) fail(`${who} has no sonar on the court in a duel`);
  }
  ok('the sonar renders on both phones in a duel');

  // Park the guest's paddle hard left and let the room play itself: the
  // countdown clears, the mandated 5s auto-serve fires, the ball crosses,
  // the parked guest misses, the next serve fires. Every crossing should
  // flip each phone's sonar, so sample both radars until each has been seen
  // BOTH visible and hidden, and has flipped at least twice.
  await guest.keyboard.down('KeyA');
  const seen = { host: new Set(), guest: new Set() };
  const flips = { host: 0, guest: 0 };
  const last = { host: null, guest: null };
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    for (const [page, who] of [[host, 'host'], [guest, 'guest']]) {
      const op = await page
        .$eval('#radar-preview-container', (el) => getComputedStyle(el).opacity)
        .catch(() => null);
      if (op === null) continue;
      const vis = parseFloat(op) > 0.5 ? 'visible' : 'hidden';
      seen[who].add(vis);
      if (last[who] && last[who] !== vis) flips[who]++;
      last[who] = vis;
    }
    if (flips.host >= 2 && flips.guest >= 2) break;
    await host.waitForTimeout(120);
  }
  for (const who of ['host', 'guest']) {
    if (!seen[who].has('visible')) fail(`${who}'s sonar never lit up while the opponent held the ball`);
    if (!seen[who].has('hidden')) fail(`${who}'s sonar never went dark while the ball was on their own half`);
    if (flips[who] < 2) fail(`${who}'s sonar never alternated with the ball (${flips[who]} flips)`);
  }
  ok('both sonars alternate as the ball changes halves');

  // The mirror direction: the guest is parked hard LEFT in their own frame,
  // which head-to-head is the host's RIGHT. Before the fix the paddle arrived
  // pre-mirrored and the radar mirrored it AGAIN, planting it on the wrong
  // side — exactly the kind of desync a blind half-court cannot afford.
  const paddleLeft = await host.$eval('#radar-opp-paddle', (el) => parseFloat(el.style.left));
  if (!(paddleLeft > 55)) {
    fail(`host's sonar shows the guest's paddle at left=${paddleLeft}% — parked left should read on the RIGHT`);
  }
  ok(`the sonar mirrors the opponent's paddle head-to-head (left=${Math.round(paddleLeft)}%)`);

  await guest.keyboard.up('KeyA');
  await host.context().close();
  await guest.context().close();
}

console.log('\nDUEL ROOM CHECKS PASSED');
await browser.close();
