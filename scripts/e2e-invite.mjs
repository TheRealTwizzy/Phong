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
// Requires: `npm i --no-save playwright-core` + CHROMIUM_PATH. Target a running
// server with E2E_URL, fresh DATA_DIR.
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
  const t = document.querySelector('#multiplayer-lobby-modal')?.textContent || '';
  const m = t.match(/ROOM CODE\s*([A-Z0-9]{4})/);
  return m ? m[1] : null;
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

console.log('\nPASS: an invitation link lands a brand-new player in the match');
await browser.close();
