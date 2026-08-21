// Browser E2E against the production build:
//  1. Host creates a room via the real UI, guest joins by ?room= link,
//     the WebRTC DataChannel link comes up (badge P2P on both).
//  2. GAMEPLAY over P2P: host serves, guest (paddle moved aside) misses →
//     1-0 on BOTH scoreboards; the misser then serves — guest taps serve,
//     host (paddle aside) misses → 1-1 on both. Proves the serve handoff
//     in both directions (this scenario hangs on the pre-fix freeze bug).
//  3. Second room with the P2P toggle off — badge stays RELAY.
// Requires: `npm i --no-save playwright-core` and a Chromium binary
// (set CHROMIUM_PATH, or install via `npx playwright install chromium`).
// Target a running server with E2E_URL (default http://localhost:3000).
import { chromium, devices } from 'playwright-core';

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

async function hostCreateRoom(page, { p2p }) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await passGatekeeper(page);
  await page.click('#btn-multiplayer-lobby');
  await page.waitForSelector('#btn-create-room', { timeout: 5000 });
  if (!p2p) {
    await page.click('#toggle-p2p input, #toggle-p2p');
  }
  await page.click('#btn-create-room');
  const code = await page
    .waitForFunction(() => {
      const els = Array.from(document.querySelectorAll('.tracking-widest'));
      for (const el of els) {
        const txt = (el.textContent || '').trim();
        if (/^[A-HJ-NP-Z2-9]{4}$/.test(txt)) return txt;
      }
      return null;
    }, { timeout: 5000 })
    .then((h) => h.jsonValue());
  return code;
}

async function guestJoin(page, code) {
  await page.goto(`${BASE}/?room=${code}`, { waitUntil: 'networkidle' });
  await passGatekeeper(page);
  await page.waitForSelector('#btn-join-room-submit', { timeout: 5000 });
  const input = await page.$('#input-room-code');
  const val = await input.inputValue();
  if (val !== code) await input.fill(code);
  await page.click('#btn-join-room-submit');
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

async function enterCourt(page) {
  const btn = await page.$('#btn-ready-play');
  if (btn) await btn.click().catch(() => {});
}

async function canvasBox(page) {
  const box = await (await page.$('#half-court-canvas')).boundingBox();
  if (!box) fail('canvas has no bounding box');
  return box;
}

// Single tap near the bottom center: serves when it's this player's serve
async function tapServe(page) {
  const box = await canvasBox(page);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.9);
}

// Park the paddle at the far left so a center serve is guaranteed to miss
async function movePaddleAside(page) {
  const box = await canvasBox(page);
  const y = box.y + box.height * 0.9;
  await page.mouse.move(box.x + box.width * 0.5, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.06, y, { steps: 5 });
  await page.mouse.up();
}

async function waitScore(page, selector, value, ms, label) {
  try {
    await page.waitForFunction(
      ({ sel, v }) => document.querySelector(sel)?.textContent.trim() === v,
      { sel: selector, v: value },
      { timeout: ms }
    );
  } catch {
    const cur = await page.$eval(selector, (el) => el.textContent.trim()).catch(() => '?');
    fail(`${label}: expected ${selector}=${value}, still ${cur} after ${ms}ms`);
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
{
  await enterCourt(host);
  await enterCourt(guest);
  await host.waitForSelector('#half-court-canvas');
  await guest.waitForSelector('#half-court-canvas');

  // Point 1: guest parks aside, host serves, guest misses → 1-0
  await movePaddleAside(guest);
  await tapServe(host);
  await waitScore(host, '#score-player', '1', 12000, 'point 1 (host view)');
  await waitScore(guest, '#score-opponent', '1', 4000, 'point 1 (guest view)');
  console.log('point 1 OK — host scored, both scoreboards agree 1-0');

  // Point 2: the guest missed, so the guest must now hold the serve.
  await movePaddleAside(host);
  await tapServe(guest);
  await waitScore(guest, '#score-player', '1', 12000, 'point 2 (guest view)');
  await waitScore(host, '#score-opponent', '1', 4000, 'point 2 (host view)');
  console.log('point 2 OK — misser served, host missed, both agree 1-1');

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
  if (!txt.startsWith('RELAY')) fail(`expected RELAY with toggle off, got: ${txt}`);
  console.log(`scenario 3 OK — badge: ${txt}`);
  await h2.context().close();
  await g2.context().close();
}

await browser.close();
console.log('BROWSER E2E PASSED');
process.exit(0);
