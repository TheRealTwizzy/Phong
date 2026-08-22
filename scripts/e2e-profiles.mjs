// Browser E2E for the player-identity overhaul, against a running server:
//  1. Fresh device is FORCED through onboarding: live username validation
//     (invalid → available), lock-in, lands on the menu as that player.
//  2. Avatar upload via the Profile modal: an oddly-sized source image is
//     auto-cropped to an exactly 256×256 PNG served from /api/avatar/:id.
//  3. Rename inside the 365-day lock is refused with the unlock date.
//  4. A second device cannot take the same name (case-flipped), onboards
//     under its own, and the two play multiplayer under their REAL
//     usernames (no callsign field anywhere).
//  5. Tapping the opponent's name in-match and a leaderboard row opens the
//     sanitized public profile modal.
// Run it with `npm run test:e2e` (see scripts/e2e-run.mjs), which builds
// nothing but hands this a fresh server, port, DATA_DIR and Chromium.
import { chromium, devices } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const BASE = process.env.E2E_URL || 'http://localhost:3000';
const EXEC = process.env.CHROMIUM_PATH;
if (!EXEC) {
  console.error('Set CHROMIUM_PATH to a Chromium binary.');
  process.exit(2);
}
const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
const ok = (m) => console.log('  ✓', m);

// --- Minimal PNG writer (RGB, no deps) for the avatar source image -------
function makePng(width, height) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      row[1 + x * 3] = (x * 255 / width) | 0;
      row[2 + x * 3] = (y * 255 / height) | 0;
      row[3 + x * 3] = 200;
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const SRC_IMAGE = path.join(os.tmpdir(), `phong-e2e-avatar-${Date.now()}.png`);
fs.writeFileSync(SRC_IMAGE, makePng(640, 400)); // deliberately non-square

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

async function onboard(page, username) {
  await page.waitForSelector('#onboarding-modal-overlay', { timeout: 8000 });
  await page.fill('#input-onboarding-username', username);
  await page.waitForSelector('#username-status-available', { timeout: 5000 });
  await page.click('#btn-onboarding-submit');
  await page.waitForSelector('#onboarding-modal-overlay', { state: 'detached', timeout: 8000 });
  await page.waitForSelector('#main-menu-screen', { timeout: 8000 });
}

// ---- 1. Forced onboarding with live validation --------------------------
const alice = await newPage();
await alice.goto(BASE, { waitUntil: 'networkidle' });
await alice.waitForSelector('#onboarding-modal-overlay', { timeout: 8000 });
if (await alice.$('#main-menu-screen button#menu-start-solo')) fail('menu reachable before onboarding');

await alice.fill('#input-onboarding-username', 'ab');
await alice.waitForSelector('#username-status-invalid', { timeout: 5000 });
ok('too-short name rejected live');
await alice.fill('#input-onboarding-username', 'Paddle-1234');
await alice.waitForSelector('#username-status-invalid', { timeout: 5000 });
ok('reserved Paddle- prefix rejected live');

await onboard(alice, 'PlayerOne');
const pill = await alice.textContent('#menu-profile-pill');
if (!pill.includes('PlayerOne')) fail('menu pill does not show the locked-in username');
ok('onboarding locks in PlayerOne and reaches the menu');

// ---- 2. Avatar upload: crop to 256×256, served from /api/avatar ---------
await alice.click('#menu-profile-pill');
await alice.waitForSelector('#btn-change-avatar', { timeout: 5000 });
await alice.setInputFiles('#input-avatar-file', SRC_IMAGE);
// Poll from Node (waitForFunction can't await an async predicate)
let me = null;
for (let i = 0; i < 40 && !me?.hasAvatar; i++) {
  await alice.waitForTimeout(250);
  me = await alice.evaluate(async () => await (await fetch('/api/profile/me')).json());
}
if (!me?.hasAvatar) fail('avatar upload never landed on the profile');
const avatarCheck = await alice.evaluate(async () => {
  const me = await (await fetch('/api/profile/me')).json();
  const res = await fetch(`/api/avatar/${me.id}?v=${me.avatarVersion}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const view = new DataView(buf.buffer);
  return {
    status: res.status,
    type: res.headers.get('content-type'),
    width: view.getUint32(16),
    height: view.getUint32(20),
  };
});
if (avatarCheck.status !== 200 || avatarCheck.type !== 'image/png') fail(`avatar serve: ${JSON.stringify(avatarCheck)}`);
if (avatarCheck.width !== 256 || avatarCheck.height !== 256) fail(`avatar not 256×256: ${avatarCheck.width}×${avatarCheck.height}`);
ok('640×400 source auto-cropped to a served 256×256 PNG');

// ---- 3. Rename inside the 365-day lock is refused ------------------------
await alice.click('#edit-username-btn');
await alice.fill('#profile-modal-container input[type="text"]', 'RenameTry');
await alice.click('#profile-modal-container button.bg-cyan-500');
await alice.waitForSelector('#username-edit-error', { timeout: 5000 });
const lockMsg = await alice.textContent('#username-edit-error');
if (!/locked/i.test(lockMsg)) fail(`expected lock message, got: ${lockMsg}`);
ok(`rename refused: "${lockMsg.trim()}"`);
await alice.click('#close-profile-btn');

// ---- 4. Second device: uniqueness is case-insensitive --------------------
const bob = await newPage();
await bob.goto(BASE, { waitUntil: 'networkidle' });
await bob.waitForSelector('#onboarding-modal-overlay', { timeout: 8000 });
await bob.fill('#input-onboarding-username', 'playerone');
await bob.waitForSelector('#username-status-taken', { timeout: 5000 });
ok('case-flipped "playerone" reported taken');
await onboard(bob, 'PlayerTwo');

// ---- 5. Multiplayer under real usernames + public profiles ---------------
await alice.click('#menu-mode-multiplayer');
await alice.waitForSelector('#lobby-playing-as', { timeout: 5000 });
const playingAs = await alice.textContent('#lobby-playing-as');
if (!playingAs.includes('PlayerOne')) fail('lobby identity line missing username');
if (await alice.$('#input-player-name')) fail('free-text callsign input still exists');
ok('lobby shows locked identity, no callsign field');

await alice.click('#btn-create-room');
const code = await alice
  .waitForFunction(() => {
    // The code has its own element; hunting for it by a styling class meant
    // any restyle of the lobby silently broke the lookup.
    const txt = (document.querySelector('#lobby-room-code')?.textContent || '').trim();
    return /^[A-HJ-NP-Z2-9]{4}$/.test(txt) ? txt : null;
  }, { timeout: 5000 })
  .then((h) => h.jsonValue());

await bob.click('#menu-mode-multiplayer');
await bob.waitForSelector('#input-room-code', { timeout: 5000 });
await bob.fill('#input-room-code', code);
await bob.click('#btn-join-room-submit');
await bob.waitForSelector('#scoreboard-header', { timeout: 8000 });

// The lobby handshake: bob (guest) readies, which is what enables alice's
// (host's) start button; her start closes both lobbies.
await bob.waitForSelector('#btn-ready-play', { timeout: 8000 });
await bob.click('#btn-ready-play');
await alice.waitForSelector('#btn-ready-play:not([disabled])', { timeout: 8000 });
await alice.click('#btn-ready-play');
await alice.waitForSelector('#multiplayer-lobby-modal', { state: 'detached', timeout: 5000 });
await alice.waitForSelector('#scoreboard-header', { timeout: 8000 });

await alice.waitForSelector('#btn-view-opponent-profile', { timeout: 8000 });
const oppName = (await alice.textContent('#btn-view-opponent-profile')).trim();
if (!/playertwo/i.test(oppName)) fail(`opponent shown as "${oppName}", expected PlayerTwo`);
await alice.click('#btn-view-opponent-profile');
await alice.waitForSelector('#public-profile-username', { timeout: 5000 });
const pubName = await alice.textContent('#public-profile-username');
if (pubName.trim() !== 'PlayerTwo') fail(`public profile shows "${pubName}"`);
// Boards refuse rows of zeros, so PlayerTwo has to have actually played
// something before either leaderboard scene below can find them.
await bob.evaluate(async () => {
  await fetch('/api/match/record', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      playerScore: 5, opponentScore: 3, maxRally: 9, mode: 'multiplayer', isWinner: true,
    }),
  });
});
const boardChecks = await alice.evaluate(async () => {
  const me = await (await fetch('/api/profile/me')).json();
  const opp = await (await fetch(`/api/leaderboard?limit=50`)).json();
  const other = opp.leaderboard.find((e) => e.id !== me.id);
  const pub = other ? await (await fetch(`/api/profile/${other.id}`)).json() : null;
  return {
    foundOther: !!other,
    leaksCode: pub ? 'recoveryCode' in (pub.profile || {}) : false,
    // Alice has recorded nothing: onboarded, but with no progress at all,
    // she must not be on the board herself.
    selfListed: opp.leaderboard.some((e) => e.id === me.id),
  };
});
if (!boardChecks.foundOther) fail('PlayerTwo (who has played) missing from the leaderboard');
if (boardChecks.leaksCode) fail('public profile leaks recoveryCode');
if (boardChecks.selfListed) fail('a player with zero progress appears on the leaderboard');
ok('a zero-progress player stays off the board; a played one is on it');
ok('in-match opponent tap opens sanitized public profile of PlayerTwo');
await alice.click('#btn-close-public-profile');

// Leave the room, then tap a leaderboard row → public profile. Quitting a
// live duel asks for confirmation first — that is the feature, not an
// obstacle — so the suite answers it.
await alice.click('#btn-quit-to-menu');
await alice.waitForSelector('#quit-confirm-modal', { timeout: 4000 });
await alice.click('#btn-quit-confirm');
await alice.waitForSelector('#main-menu-screen', { timeout: 5000 });
await alice.click('#menu-nav-leaderboard');
await alice.waitForSelector('#leaderboard-modal-container', { timeout: 5000 });
await alice.click('#leaderboard-modal-container button:has-text("PlayerTwo")');
await alice.waitForSelector('#public-profile-username', { timeout: 5000 });
ok('leaderboard row tap opens the public profile');

if (pageErrors.length) fail(`page errors: ${pageErrors.join(' | ')}`);
console.log('\nALL PROFILE E2E CHECKS PASSED');
await browser.close();
fs.rmSync(SRC_IMAGE, { force: true });
