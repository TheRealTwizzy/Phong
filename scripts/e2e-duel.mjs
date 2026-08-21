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
  await page.waitForSelector('#onboarding-modal-overlay', { state: 'detached', timeout: 8000 });
}

async function passGatekeeper(page) {
  const sim = await page.$('#simulate-smartphone-btn');
  if (sim) await sim.click();
}

/**
 * Pick a winning score. The picker lives in the SOLO panel — multiplayer has
 * never shown one — so this is exactly how a player's PvP target gets set:
 * invisibly, from whatever they last chose for a solo match.
 */
async function pickShortMatch(page, points = 3) {
  const lobby = await page.$('#multiplayer-lobby-modal');
  if (lobby) await page.click('#btn-close-lobby');
  await page.click('#menu-mode-solo');
  const btn = await page.waitForSelector(`#menu-pts-${points}:not([disabled])`, { timeout: 4000 }).catch(() => null);
  if (!btn) fail(`winning-score button #menu-pts-${points} not available`);
  await btn.click();
  await page.click('#menu-mode-solo'); // collapse again
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
      for (const el of Array.from(document.querySelectorAll('.tracking-widest'))) {
        const txt = (el.textContent || '').trim();
        if (/^[A-HJ-NP-Z2-9]{4}$/.test(txt)) return txt;
      }
      return null;
    }, { timeout: 5000 })
    .then((h) => h.jsonValue());
}

async function guestJoin(page, code, points = 3) {
  await page.goto(`${BASE}/?room=${code}`, { waitUntil: 'networkidle' });
  await passGatekeeper(page);
  await onboard(page, 'RmGuest');
  await pickShortMatch(page, points);
  await page.click('#menu-mode-multiplayer');
  await page.waitForSelector('#btn-join-room-submit', { timeout: 5000 });
  const input = await page.$('#input-room-code');
  if ((await input.inputValue()) !== code) await input.fill(code);
  await page.click('#btn-join-room-submit');
}

async function enterCourt(page) {
  const btn = await page.waitForSelector('#btn-ready-play:not([disabled])', { timeout: 10000 }).catch(() => null);
  if (btn) await btn.click().catch(() => {});
  await page.waitForSelector('#multiplayer-lobby-modal', { state: 'detached', timeout: 5000 }).catch(() => {});
  await page.waitForSelector('#half-court-canvas', { timeout: 5000 });
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
  await enterCourt(host);
  await enterCourt(guest);
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
  await enterCourt(host);
  await enterCourt(guest);
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

  const selected = (page) =>
    page.evaluate(() =>
      [3, 5, 10, 15].find((p) => {
        const el = document.querySelector(`#lobby-pts-${p}`);
        return el && el.className.includes('border-cyan-400');
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
      return el && el.className.includes('border-cyan-400');
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

console.log('\nDUEL ROOM CHECKS PASSED');
await browser.close();
