// Browser E2E for the invitation flow: a link or QR should land you IN the
// match, even on a first visit.
//
// The reported failure: a player sent a join link (or scanning the QR) made an
// account and then never got into the match, though the host was still waiting
// in the lobby with the code they had been given.
//
// Two faults sat behind it, both covered here:
//   * The link was only ever PREFILLED into the lobby's code box. Prefilling is
//     not joining — someone who followed an invitation expected to arrive in
//     the match, and instead had to find and press a button.
//   * A seat could be taken before onboarding. The relay stamps a seat's
//     display name at join time and never revisits it, so a player seated
//     early showed to their opponent as Paddle-XXXX for the life of the room.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });
const dialogs = [];

async function newPage(label) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`PAGE ERROR [${label}]:`, e.message));
  page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
  return page;
}

async function passGatekeeper(page) {
  const sim = await page.$('#simulate-smartphone-btn');
  if (sim) await sim.click();
}

let nameCounter = 0;
const uniqueName = (p) => `${p}${Date.now().toString(36).slice(-4)}${nameCounter++}`;

async function onboard(page, prefix) {
  const modal = await page.waitForSelector('#onboarding-modal-overlay', { timeout: 8000 }).catch(() => null);
  if (!modal) return null;
  const name = uniqueName(prefix);
  await page.fill('#input-onboarding-username', name);
  await page.waitForSelector('#username-status-available', { timeout: 8000 });
  await page.click('#btn-onboarding-submit');
  await page.waitForSelector('#onboarding-modal-overlay', { state: 'detached', timeout: 10000 });
  return name;
}

const lobbyText = (page) =>
  page.evaluate(() => (document.querySelector('#multiplayer-lobby-modal')?.textContent || '').replace(/\s+/g, ' '));
const state = (page) =>
  page.evaluate(() => ({
    onboarding: !!document.querySelector('#onboarding-modal-overlay'),
    lobby: !!document.querySelector('#multiplayer-lobby-modal'),
    inRoom: !!document.querySelector('#btn-leave-room'),
    joinBtn: !!document.querySelector('#btn-join-room-submit'),
  }));

console.log('Invitation flow: a first-time player follows a room link');

// --- Host opens a room and gets a code to share ---
const host = await newPage('host');
await host.goto(BASE);
await passGatekeeper(host);
const hostName = await onboard(host, 'Host');
await host.waitForSelector('#menu-mode-multiplayer', { timeout: 15000 });
await host.click('#menu-mode-multiplayer');
await host.waitForSelector('#btn-create-room', { timeout: 8000 });
await host.click('#btn-create-room');
await host.waitForSelector('#btn-copy-link', { timeout: 8000 });
const code = await host.evaluate(() => {
  // Read the code from its own element rather than regexing the panel's
  // text for an English label — that coupled the suite to copy that is now
  // translated, and to the label sitting immediately before the code.
  const el = document.querySelector('#lobby-room-code');
  const t = (el?.textContent || '').trim();
  return /^[A-Z0-9]{4}$/.test(t) ? t : null;
});
if (!code) fail('host never got a room code');
ok(`host ${hostName} opened room ${code}`);

// --- A brand-new player follows the link ---
const guest = await newPage('guest');
await guest.goto(`${BASE}/?room=${code}`);
await passGatekeeper(guest);
await guest.waitForSelector('#onboarding-modal-overlay', { timeout: 8000 });

// Nothing joinable should be reachable yet: a seat taken now would carry the
// player's placeholder name for the life of the room.
const before = await state(guest);
if (before.inRoom) fail('guest took a seat before choosing a username');
if (before.joinBtn) fail('a join control was reachable while onboarding was still open');
ok('no seat is reachable before the player has a username');

// --- They make an account, and that is all they should have to do ---
const guestName = await onboard(guest, 'Guest');
await sleep(2500);

const after = await state(guest);
if (after.onboarding) fail('onboarding did not close');
if (!after.inRoom) fail('guest made an account but was never taken into the match');
ok(`guest ${guestName} was taken into the room automatically`);

const seenByHost = await lobbyText(host);
if (/Paddle-/.test(seenByHost)) fail('host sees the guest under their placeholder name');
if (!seenByHost.includes(guestName)) fail(`host does not see the guest (lobby read: ${seenByHost.slice(0, 160)})`);
ok('host sees the guest under the name they chose');

// --- And the match can actually start ---
const readyBtn = await guest.$('#btn-ready-play');
if (!readyBtn) fail('guest has no ready control in the room');
await readyBtn.click();
await sleep(1200);
const canStart = await host.evaluate(() => {
  const b = document.querySelector('#btn-ready-play');
  return b ? !b.disabled : false;
});
if (!canStart) fail('host cannot start after the guest readied');
await host.click('#btn-ready-play');
await sleep(2500);
const onCourt = await Promise.all([
  host.evaluate(() => !document.querySelector('#multiplayer-lobby-modal')),
  guest.evaluate(() => !document.querySelector('#multiplayer-lobby-modal')),
]);
if (!onCourt[0] || !onCourt[1]) fail(`both phones did not reach the court (host=${onCourt[0]} guest=${onCourt[1]})`);
ok('both phones reached the court');

if (dialogs.length) fail(`unexpected error dialog: ${dialogs.join(' | ')}`);

// ---------------------------------------------------------------------------
// The other half of the reported failure: the invitee is NOT a new player.
//
// An invitation link is the one way into Phong that gets tapped from another
// app, so it routinely opens in a browser that is not the one holding the
// player's account — a chat app's in-app browser, or wherever a QR scan hands
// off to. The server cannot tell that browser from a first-time visitor, so
// onboarding opens and their own username comes back taken, by themselves.
// "They were not only unable to join the lobby, they got signed out and their
// account still exists but they lost access somehow."
//
// Nothing can stop a foreign browser being a foreign browser. What had to stop
// was every door out of it being one-way: restoring the account into the
// throwaway browser RELEASED the real one, and the wall a released device gets
// offered exactly one button — "start as a new player" — which mints a new
// device identity and leaves the account reachable by nobody, forever.
console.log('\nThe same link, followed by a player who already has an account');

const homeCtx = await browser.newContext({ ...devices['iPhone 13'] });
const home = await homeCtx.newPage();
home.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
await home.goto(BASE);
await passGatekeeper(home);
const homeName = await onboard(home, 'Home');
await home.waitForSelector('#menu-mode-multiplayer', { timeout: 15000 });
const homeCode = await home.evaluate(() => fetch('/api/profile/me').then((r) => r.json()).then((p) => p.recoveryCode));
ok(`${homeName} has an account in the browser they play in`);

// A fresh host: the one above is on a live court, where there is no room to
// open. Its own page, its own account, its own room.
const host2 = await newPage('host2');
await host2.goto(BASE);
await passGatekeeper(host2);
const host2Name = await onboard(host2, 'Host2');
await host2.waitForSelector('#menu-mode-multiplayer', { timeout: 15000 });
await host2.click('#menu-mode-multiplayer');
await host2.waitForSelector('#btn-create-room', { timeout: 8000 });
await host2.click('#btn-create-room');
await host2.waitForSelector('#btn-copy-link', { timeout: 8000 });
const code2 = await host2.evaluate(() => document.querySelector('#lobby-room-code')?.textContent?.trim() || null);
if (!code2) fail('the second host never got a room code');
ok(`${host2Name} opened room ${code2}`);

// The link opens somewhere with no cookie jar of its own.
const foreign = await newPage('foreign');
await foreign.goto(`${BASE}/?room=${code2}`);
await passGatekeeper(foreign);
await foreign.waitForSelector('#onboarding-modal-overlay', { timeout: 8000 });

// It must SAY why, or being asked to pick a username reads as being signed out
// of an account that is in fact perfectly safe where it was left.
if (!(await foreign.$('#onboarding-other-browser-note'))) {
  fail('an invitee in a foreign browser is not told why onboarding opened');
}
ok('the invitee is told their account stays with the browser it was made in');

// Their own name comes back taken. That is the loudest possible signal that
// this is their account, so it has to point at the door that gets it back.
await foreign.fill('#input-onboarding-username', homeName);
await foreign.waitForSelector('#username-status-taken', { timeout: 8000 });
if (!(await foreign.$('#username-taken-restore-hint'))) fail('a taken name does not point at restoring');
if (!(await foreign.$('#input-onboarding-claim-code'))) fail('a taken name does not open the restore door');
ok('their own username reads as taken, and points at restoring rather than a dead end');

// They restore here — which releases the browser they actually play in.
await foreign.fill('#input-onboarding-claim-code', homeCode);
await foreign.click('#btn-onboarding-claim');
await sleep(3000);
if (!(await foreign.$('#btn-leave-room'))) fail('restoring on the invite link did not land them in the match');
ok('restoring takes them into the match they were invited to');

// And now the part that used to cost people their accounts.
await home.bringToFront();
// The wall arrives on the session heartbeat, which fires on refocus and then
// every 15s. Poll rather than guess: a fixed sleep here is either flaky or
// slower than it needs to be.
let wall = null;
for (let i = 0; i < 45 && wall !== 'released'; i++) {
  await sleep(700);
  wall = await home.evaluate(
    () => document.querySelector('#session-guard-overlay')?.getAttribute('data-session-status') || null
  );
}
if (wall !== 'released') fail(`the browser that lost the account should be walled as released, got ${wall}`);
if (!(await home.$('#input-session-claim-code'))) fail('the released wall offers no way to keep the account');
if (await home.$('#btn-session-action')) fail('starting over is still one press away from irreversible');
ok('the released wall leads with restoring, and starting over is not the only button');

const rotated = await foreign.evaluate(() => fetch('/api/profile/me').then((r) => r.json()).then((p) => p.recoveryCode));
await home.fill('#input-session-claim-code', rotated);
await home.click('#btn-session-claim');
// The restore reloads the page, so wait for the wall to actually go rather
// than for a guess at how long a reload takes.
let stillWalled = 'unknown';
for (let i = 0; i < 30; i++) {
  await sleep(700);
  stillWalled = await home
    .evaluate(() => document.querySelector('#session-guard-overlay')?.getAttribute('data-session-status') || null)
    .catch(() => 'navigating');
  if (stillWalled === null) break;
}
if (stillWalled !== null) fail(`restoring did not clear the wall (still ${stillWalled})`);
const recovered = await home.evaluate(() => fetch('/api/profile/me').then((r) => r.json()).then((p) => p.username));
if (recovered !== homeName) fail(`the account did not come home: expected ${homeName}, got ${recovered}`);
ok(`${homeName} took their account back without spending it`);

if (dialogs.length) fail(`unexpected error dialog: ${dialogs.join(' | ')}`);

console.log('\nPASS: an invitation lands a new player in the match, and never costs a returning one their account');
await browser.close();
