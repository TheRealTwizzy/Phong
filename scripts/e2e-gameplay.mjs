// Browser E2E against the production build:
//  1. Host creates a room via the real UI, guest joins by ?room= link,
//     the WebRTC DataChannel link comes up (badge P2P on both).
//  2. GAMEPLAY over P2P: host serves, guest (paddle moved aside) misses →
//     1-0 on BOTH scoreboards; the misser then serves — guest asks to serve,
//     host (paddle aside) misses → 1-1 on both. Proves the serve handoff
//     in both directions (this scenario hangs on the pre-fix freeze bug).
//  3. Second room with the P2P toggle off — badge stays RELAY.
// Run it with `npm run test:e2e` (see scripts/e2e-run.mjs), which builds
// nothing but hands this a fresh server, port, DATA_DIR and Chromium.
import { chromium, devices } from 'playwright-core';


// The onboarding tour opens by itself for a player who has never seen it —
// it is part of onboarding now, not a menu row. Every suite past this point
// wants the menu, so it is waved away here. Tolerant: a suite that reaches
// this another way is not broken by its absence.
async function skipTour(page) {
  const card = await page
    .waitForSelector('#onboarding-tour-card', { timeout: 8000 })
    .catch(() => null);
  if (!card) return false;
  await page.click('#btn-tour-skip');
  await page.click('#btn-tour-skip-confirm');
  await page
    .waitForSelector('#onboarding-tour-overlay', { state: 'detached', timeout: 8000 })
    .catch(() => {});
  return true;
}
const BASE = process.env.E2E_URL || 'http://localhost:3000';
const EXEC = process.env.CHROMIUM_PATH;
if (!EXEC) {
  console.error('Set CHROMIUM_PATH to a Chromium binary (e.g. from `npx playwright install chromium`).');
  process.exit(2);
}
const fail = (m) => { console.error('FAIL:', m); process.exit(1); };

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

async function passGatekeeper(page) {
  const sim = await page.$('#simulate-smartphone-btn');
  if (sim) await sim.click();
}

// Every fresh device must onboard (unique username) before anything else.
let nameCounter = 0;
const uniqueName = (prefix) => `${prefix}${Date.now().toString(36).slice(-4)}${nameCounter++}`;

async function onboard(page, prefix = 'E2E') {
  const modal = await page
    .waitForSelector('#onboarding-modal-overlay', { timeout: 4000 })
    .catch(() => null);
  if (!modal) return; // already onboarded (same context revisiting)
  await page.fill('#input-onboarding-username', uniqueName(prefix));
  await page.waitForSelector('#username-status-available', { timeout: 5000 });
  await page.click('#btn-onboarding-submit');
  // Onboarding now ends on the sign-in code. Tolerant, so a suite that
  // reaches here another way is not broken by its absence.
  await page.waitForSelector('#btn-onboarding-code-continue', { timeout: 10000 })
    .then((b) => b.click())
    .catch(() => {});
  await skipTour(page);
  await page.waitForSelector('#onboarding-modal-overlay', { state: 'detached', timeout: 8000 });
}

async function hostCreateRoom(page, { p2p }) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await passGatekeeper(page);
  await onboard(page, 'Host');
  await page.click('#menu-mode-multiplayer');
  await page.waitForSelector('#btn-create-room', { timeout: 5000 });
  if (!p2p) {
    await page.click('#toggle-p2p input, #toggle-p2p');
  }
  await page.click('#btn-create-room');
  const code = await page
    .waitForFunction(() => {
      // The code has its own element; hunting for it by a styling class meant
      // any restyle of the lobby silently broke the lookup.
      const txt = (document.querySelector('#lobby-room-code')?.textContent || '').trim();
      return /^[A-HJ-NP-Z2-9]{4}$/.test(txt) ? txt : null;
    }, { timeout: 5000 })
    .then((h) => h.jsonValue());
  return code;
}

async function guestJoin(page, code) {
  await page.goto(`${BASE}/?room=${code}`, { waitUntil: 'networkidle' });
  await passGatekeeper(page);
  await onboard(page, 'Guest');
  // The link joins for them once they have a name to join under; the manual
  // code box is the other path, driven by scripts/e2e-duel.mjs.
  await page.waitForSelector('#btn-leave-room', { timeout: 8000 });
}

async function waitBadge(page, expected, ms) {
  try {
    await page.waitForFunction(
      (exp) => {
        const el = document.querySelector('#link-status-badge');
        return el && el.textContent.trim() === exp;
      },
      expected,
      { timeout: ms }
    );
    return true;
  } catch {
    const el = await page.$('#link-status-badge');
    const txt = el ? await el.textContent() : '(no badge)';
    console.log(`badge state on timeout: ${txt}`);
    return false;
  }
}

// The lobby handshake: the guest readies, the host starts, and game_start
// closes both lobbies at once.
async function startDuel(host, guest) {
  await guest.waitForSelector('#btn-ready-play', { timeout: 8000 });
  await guest.click('#btn-ready-play');
  const btn = await host.waitForSelector('#btn-ready-play:not([disabled])', { timeout: 8000 });
  await btn.click();
  for (const page of [host, guest]) {
    await page.waitForSelector('#multiplayer-lobby-modal', { state: 'detached', timeout: 5000 });
  }
}

// Ask for the serve. Space rather than a tap: the first pointer down is the
// paddle now, always, so a lone click only moves it — serving takes a second
// finger, which a mouse does not have. A no-op when it is not this player's
// serve, exactly as the tap was.
async function pressServe(page) {
  await page.keyboard.press('Space');
}

// Keyboard paddle parking (the window-level A/D handler works in every
// state, while a pointer drag's pointerdown races the serve/lobby state
// machine). Held, not tapped: the ball can be returned off a parked corner,
// so paddles stay pinned until the point resolves.
const parkLeft = (page) => page.keyboard.down('KeyA');
const unpark = (page) => page.keyboard.up('KeyA');

async function scores(page) {
  const me = await page.$eval('#score-player', (el) => parseInt(el.textContent, 10)).catch(() => NaN);
  const opp = await page.$eval('#score-opponent', (el) => parseInt(el.textContent, 10)).catch(() => NaN);
  return { me, opp };
}

// Wait until the two scoreboard numbers sum to `total` (someone scored).
async function waitTotalPoints(page, total, ms, label) {
  try {
    await page.waitForFunction(
      (t) => {
        const me = parseInt(document.querySelector('#score-player')?.textContent || '', 10);
        const opp = parseInt(document.querySelector('#score-opponent')?.textContent || '', 10);
        return me + opp === t;
      },
      total,
      { timeout: ms }
    );
  } catch {
    const s = await scores(page);
    fail(`${label}: expected ${total} total points, still ${s.me}:${s.opp} after ${ms}ms`);
  }
}

// ---- Scenario 1: P2P link comes up ----
const host = await newPage();
const guest = await newPage();
{
  const code = await hostCreateRoom(host, { p2p: true });
  console.log('room code:', code);
  await guestJoin(guest, code);

  const hostP2P = await waitBadge(host, 'P2P', 12000);
  const guestP2P = await waitBadge(guest, 'P2P', 12000);
  if (!hostP2P || !guestP2P) fail(`P2P link did not establish (host=${hostP2P} guest=${guestP2P})`);
  console.log('scenario 1 OK — P2P link up on both');
}

// ---- Scenario 2: play two points over P2P; serve hands to the misser ----
// The serve's horizontal drift is random, so which side eventually misses
// is not deterministic (a parked corner can still return a lucky serve).
// What IS invariant, and what this scenario proves: play starts from the
// server's request, the point resolves, BOTH scoreboards agree exactly, and
// the misser holds the next serve (their request — and only theirs — starts
// point 2;
// the pre-fix freeze bug times out here).
{
  await startDuel(host, guest);
  await host.waitForSelector('#half-court-canvas');
  await guest.waitForSelector('#half-court-canvas');

  // Point 1: park the guest, host serves, then park the host too so the
  // rally must end.
  await parkLeft(guest);
  await pressServe(host);
  await parkLeft(host);
  await waitTotalPoints(host, 1, 20000, 'point 1 (host view)');
  await waitTotalPoints(guest, 1, 4000, 'point 1 (guest view)');
  const h1 = await scores(host);
  const g1 = await scores(guest);
  if (g1.me !== h1.opp || g1.opp !== h1.me) {
    fail(`scoreboards disagree after point 1: host ${h1.me}:${h1.opp} vs guest ${g1.me}:${g1.opp}`);
  }
  const guestMissed = h1.me === 1;
  console.log(`point 1 OK — ${guestMissed ? 'host' : 'guest'} scored, both scoreboards agree`);
  await unpark(host);
  await unpark(guest);

  // Point 2: the misser now holds the serve — their request must start play.
  const misser = guestMissed ? guest : host;
  const other = guestMissed ? host : guest;
  await parkLeft(other);
  await pressServe(misser);
  await parkLeft(misser);
  await waitTotalPoints(host, 2, 20000, 'point 2 (host view)');
  await waitTotalPoints(guest, 2, 4000, 'point 2 (guest view)');
  const h2 = await scores(host);
  const g2 = await scores(guest);
  if (g2.me !== h2.opp || g2.opp !== h2.me) {
    fail(`scoreboards disagree after point 2: host ${h2.me}:${h2.opp} vs guest ${g2.me}:${g2.opp}`);
  }
  console.log('point 2 OK — misser held the serve and play continued to 2 points');
  await unpark(host);
  await unpark(guest);

  await host.context().close();
  await guest.context().close();
}

// ---- Scenario 3: P2P toggle off — stays on relay ----
{
  const h2 = await newPage();
  const g2 = await newPage();
  const code = await hostCreateRoom(h2, { p2p: false });
  await guestJoin(g2, code);
  await h2.waitForTimeout(2500);
  const txt = await h2.$eval('#link-status-badge', (el) => el.textContent.trim());
  // Strict equality, not startsWith. The badge used to append the ping to its
  // own text, so this assertion had to be loosened — which is exactly what
  // hid it, since the P2P path (asserted strictly above) never appends. The
  // ping is a sibling now, so both states can be compared the same way.
  if (txt !== 'RELAY') fail(`expected exactly RELAY with toggle off, got: ${txt}`);
  const ping = await h2.$eval('#link-ping', (el) => el.textContent.trim()).catch(() => null);
  if (ping !== null && !/^\d+ms$/.test(ping)) fail(`ping badge is malformed: ${ping}`);
  console.log(`scenario 3 OK — badge: ${txt}${ping ? `, ping: ${ping}` : ''}`);
  await h2.context().close();
  await g2.context().close();
}

// ---- Scenario 4: desktop and tablet are gated to a phone, at any window size ----
{
  // The reported bypass was that the old gate keyed on VIEWPORT SIZE, so
  // narrowing a desktop window walked through it and the game was playable on
  // a desktop browser. The gate now reads the platform, so every one of these
  // window sizes must land on the same wall.
  for (const vp of [{ width: 1280, height: 900, label: 'desktop 100%' },
                    { width: 2400, height: 1400, label: 'desktop zoomed-out' },
                    { width: 800, height: 600, label: 'small desktop window' },
                    { width: 420, height: 900, label: 'desktop narrowed to phone width' }]) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    await page.goto(BASE, { waitUntil: 'networkidle' });

    const gate = await page.waitForSelector('#device-gate', { timeout: 5000 })
      .catch(() => fail(`${vp.label}: desktop was not gated`));
    if ((await gate.getAttribute('data-device')) !== 'desktop') {
      fail(`${vp.label}: gated as "${await gate.getAttribute('data-device')}", expected desktop`);
    }
    // Nothing playable behind it: no menu, no onboarding, no court.
    if (await page.$('#main-menu-screen')) fail(`${vp.label}: main menu rendered behind the gate`);
    if (await page.$('#onboarding-modal-overlay')) fail(`${vp.label}: onboarding rendered behind the gate`);

    // The QR is generated in-page — no request to any image host — and is a
    // vector, so it is sharp at whatever size the panel gives it.
    const qr = await page.$('#device-gate-qr');
    if (!qr) fail(`${vp.label}: no QR code on the gate`);
    const paths = await page.$eval('#device-gate-qr path', (el) => el.getAttribute('d')?.length || 0);
    if (paths < 200) fail(`${vp.label}: QR path looks empty (${paths} chars)`);
    const box = await qr.boundingBox();
    if (!box || box.width < 180) fail(`${vp.label}: QR rendered too small (${box && box.width}px)`);
    console.log(`scenario 4 OK — ${vp.label}: gated, QR ${Math.round(box.width)}px`);
    await ctx.close();
  }

  // A tablet is turned away too, and says so in its own words.
  const iPad = devices['iPad Pro 11'] || devices['iPad (gen 7)'];
  if (iPad) {
    const ctx = await browser.newContext({ ...iPad });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });
    const gate = await page.waitForSelector('#device-gate', { timeout: 5000 })
      .catch(() => fail('tablet was not gated'));
    const kind = await gate.getAttribute('data-device');
    if (kind !== 'tablet') fail(`tablet gated as "${kind}"`);
    console.log('scenario 4 OK — tablet gated as tablet');
    await ctx.close();
  }
}

// ---- Scenario 5: device identity — cookie survives wipes, codes transfer ----
{
  const me = (page) => page.evaluate(() => fetch('/api/profile/me').then((r) => r.json()));

  const ctxA = await browser.newContext({ ...devices['iPhone 13'] });
  const a = await ctxA.newPage();
  a.on('dialog', (d) => d.accept().catch(() => {}));
  await a.goto(BASE, { waitUntil: 'networkidle' });
  // Onboarding locks in a distinctive unique name (renames are 365d-locked,
  // so the name is chosen here, not via PUT)
  const keeperName = uniqueName('Keeper');
  await a.fill('#input-onboarding-username', keeperName);
  await a.waitForSelector('#username-status-available', { timeout: 5000 });
  await a.click('#btn-onboarding-submit');
  // Onboarding now ends on the sign-in code. Tolerant, so a suite that
  // reaches here another way is not broken by its absence.
  await a.waitForSelector('#btn-onboarding-code-continue', { timeout: 10000 })
    .then((b) => b.click())
    .catch(() => {});
  await skipTour(a);
  await a.waitForSelector('#onboarding-modal-overlay', { state: 'detached', timeout: 8000 });
  const profA1 = await me(a);
  if (!/^dev_[0-9a-f]{18}$/.test(profA1.id)) fail(`server-issued id malformed: ${profA1.id}`);
  if (!/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(profA1.recoveryCode)) fail(`bad recovery code: ${profA1.recoveryCode}`);
  if (profA1.username !== keeperName) fail(`onboarding did not set username: ${profA1.username}`);

  // localStorage wipe must NOT re-roll identity (the cookie is the anchor)
  await a.evaluate(() => localStorage.clear());
  await a.reload({ waitUntil: 'networkidle' });
  const profA2 = await me(a);
  if (profA2.id !== profA1.id) fail(`identity re-rolled after localStorage clear: ${profA1.id} -> ${profA2.id}`);
  if (!profA2.initialized) fail('initialized profile lost onboarding state after localStorage clear');
  console.log('scenario 5a OK — identity survives localStorage wipe');

  // Second device claims A's code straight from the onboarding modal (the
  // restore path is the onboarding bypass for returning players)
  const ctxB = await browser.newContext({ ...devices['iPhone 13'] });
  const b = await ctxB.newPage();
  b.on('dialog', (d) => d.accept().catch(() => {}));
  await b.goto(BASE, { waitUntil: 'networkidle' });
  const profB1 = await me(b);
  if (profB1.id === profA1.id) fail('two devices shared an identity');
  if (profB1.initialized) fail('fresh device arrived pre-initialized');

  await b.waitForSelector('#btn-onboarding-show-restore', { timeout: 5000 });
  await b.click('#btn-onboarding-show-restore');
  await b.fill('#input-onboarding-claim-code', profA1.recoveryCode);
  await Promise.all([
    b.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}),
    b.click('#btn-onboarding-claim'),
  ]);
  const profB2 = await me(b);
  if (profB2.username !== keeperName) fail(`claim did not move profile: got ${profB2.username}`);
  if (profB2.id !== profB1.id) fail('device id changed on claim');
  if (profB2.recoveryCode !== profA1.recoveryCode) fail('sign-in code should survive being used');
  if (!profB2.initialized) fail('claimed profile lost its initialized state');

  // The browser left behind is evicted — the concurrency rule is unchanged.
  // It used to be handed a brand-new empty profile silently, which is what let
  // a transferred-away phone play a whole match before finding out at the
  // final whistle that it had been a guest the entire time.
  const evictedRead = await a.evaluate(async () => {
    const r = await fetch('/api/profile/me');
    return { status: r.status, body: await r.json() };
  });
  if (evictedRead.status !== 409 || evictedRead.body.error !== 'ACCOUNT_ELSEWHERE') {
    fail(`evicted browser still resolves a profile: ${JSON.stringify(evictedRead)}`);
  }
  const evictedState = await a.evaluate(() =>
    fetch('/api/session').then((r) => r.json()).then((d) => d.status)
  );
  // `superseded`, not `released`: signing in links both browsers rather than
  // tombstoning the one left behind, and `superseded` has always had a way
  // back where `released` had only a way out.
  if (evictedState !== 'superseded') fail(`evicted browser reports "${evictedState}"`);

  // ...and the way back needs no code and no wall. Opening Phong in a browser
  // that has signed in before simply brings the account to it — a member's
  // device cookie IS the credential. This is the whole point: the account is
  // reachable from any browser on the phone that has signed in to it once.
  await a.reload({ waitUntil: 'networkidle' });
  await a.waitForSelector('#main-menu-screen', { timeout: 15000 })
    .catch(() => fail('a browser that signed in before could not get back to the menu'));
  if (await a.$('#session-guard-overlay')) fail('a member was walled off from its own account');
  const profA3 = await me(a);
  if (profA3.username !== profA1.username) fail(`account did not come back: ${profA3.username}`);
  if (profA3.matchesPlayed !== profA1.matchesPlayed) fail('history did not come back with it');
  if (!profA3.initialized) fail('the account came back uninitialized');

  // Exactly one browser holds it at a time — B has to ask for its turn now.
  const bNow = await b.evaluate(() => fetch('/api/session').then((r) => r.json()).then((d) => d.status));
  if (bNow !== 'superseded') fail(`both browsers hold the account at once (B is "${bNow}")`);

  console.log('scenario 5b OK — signing in moves the account and evicts the old browser');
  console.log('scenario 5c OK — a browser that signed in takes the account back with one tap, no code');

  await ctxA.close();
  await ctxB.close();
}

await browser.close();
console.log('BROWSER E2E PASSED');
process.exit(0);
