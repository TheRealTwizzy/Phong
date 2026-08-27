// Browser E2E for Split Screen — the one mode with no test of any kind.
//
// Four modes ship. Solo, Practice Wall and the duel each have unit and browser
// coverage; this one had neither, and it has the most unusual input model in
// the app: two people playing on ONE device, multi-touch, with each pointer
// locked to the half of the court it started in.
//
// That locking is exactly the sort of thing that breaks silently on a browser
// update and is never noticed, because Split Screen records no match, moves no
// rating and produces no server-side trace when it goes wrong. The only
// evidence is a paddle that will not move, or one that both players are
// fighting over.
//
// Two mechanics worth knowing before reading it:
//
//  * Input goes through CDP Input.dispatchTouchEvent rather than synthetic
//    PointerEvents. handlePointerDown calls setPointerCapture, which throws on
//    an untrusted pointerId; CDP produces real pointer events, and it is also
//    the only way to get two fingers down at once.
//  * Paddles are canvas-drawn from refs and appear nowhere in the DOM, so they
//    are read back by sampling the canvas. P1 is cyan at 92% height, P2 is
//    pink at 8%. Sampling the rendered output is a fair reading of "did the
//    paddle move" — it is what the player sees.
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
const ctx = await browser.newContext({ ...devices['iPhone 13'], hasTouch: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
page.on('dialog', (d) => d.dismiss().catch(() => {}));

console.log('Split Screen: two players, one device, one pointer each');

// --- get to the court ------------------------------------------------------
await page.goto(BASE, { waitUntil: 'networkidle' });
const sim = await page.$('#simulate-smartphone-btn');
if (sim) await sim.click();

await page.waitForSelector('#onboarding-modal-overlay', { timeout: 10000 });
await page.fill('#input-onboarding-username', `Split${Date.now().toString(36).slice(-5)}`);
await page.waitForSelector('#username-status-available', { timeout: 8000 });
await page.click('#btn-onboarding-submit');
// Onboarding now ends on the sign-in code. Tolerant, so a suite that
// reaches here another way is not broken by its absence.
await page.waitForSelector('#btn-onboarding-code-continue', { timeout: 10000 })
  .then((b) => b.click())
  .catch(() => {});
await page.waitForSelector('#main-menu-screen', { timeout: 10000 });

// Every mode opens the same pre-match sheet; Start is pinned in its footer.
await page.click('#building-training');
await page.click('#room-split');
await page.waitForSelector('#menu-start-split', { timeout: 8000 });
await page.click('#menu-start-split');
await page.waitForSelector('#split-screen-match', { timeout: 8000 });
await page.waitForSelector('#split-court-canvas', { timeout: 8000 });
ok('split match opened from the menu');

const box = await (await page.$('#split-court-canvas')).boundingBox();
if (!box) fail('the court canvas has no bounding box');

// --- reading the paddles off the canvas ------------------------------------
// P1 is drawn cyan (#00f0ff) at 92% of the court height, P2 pink (#ff007f) at
// 8%. Returns each paddle's centre as a 0..1 fraction of the court width, or
// null if that colour is not on its scanline.
const readPaddles = () =>
  page.evaluate(() => {
    const canvas = document.querySelector('#split-court-canvas');
    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;

    const centreOf = (yFraction, matches) => {
      const y = Math.round(height * yFraction);
      const row = ctx.getImageData(0, y, width, 1).data;

      // Collect runs of matching pixels rather than the first and last match.
      // The court is drawn with a cyan frame, so a single pixel at each edge
      // would otherwise put every reading at dead centre no matter where the
      // paddle actually is.
      const runs = [];
      let startedAt = -1;
      for (let x = 0; x <= width; x++) {
        const i = x * 4;
        const hit = x < width && matches(row[i], row[i + 1], row[i + 2], row[i + 3]);
        if (hit && startedAt === -1) startedAt = x;
        if (!hit && startedAt !== -1) {
          runs.push([startedAt, x - 1]);
          startedAt = -1;
        }
      }
      // A paddle is 22% of the court wide; the frame is a hairline. Anything
      // under 2% is not a paddle.
      const solid = runs.filter(([a, b]) => b - a >= width * 0.02);
      if (!solid.length) return null;
      // Span of what is left. The paddle carries a dark centre stripe, so it
      // reads as two runs — min/max across them is the right reading.
      const lo = Math.min(...solid.map((r) => r[0]));
      const hi = Math.max(...solid.map((r) => r[1]));
      return (lo + hi) / 2 / width;
    };

    return {
      // Cyan: strong blue AND green, little red. Tight enough that the glow
      // and the theme's grid lines do not register.
      p1: centreOf(0.92, (r, g, b, a) => a > 200 && b > 170 && g > 150 && r < 90),
      // Pink: strong red, mid blue, little green.
      p2: centreOf(0.08, (r, g, b, a) => a > 200 && r > 170 && b > 70 && b < 200 && g < 90),
    };
  });

const settleFrames = () => page.evaluate(() =>
  new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
);

const cdp = await ctx.newCDPSession(page);
/** Put fingers down / move / lift. Coordinates are fractions of the court. */
async function touch(type, points) {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map((p) => ({
      x: box.x + box.width * p.x,
      y: box.y + box.height * p.y,
      id: p.id,
      radiusX: 5,
      radiusY: 5,
      force: 1,
    })),
  });
}

const BOTTOM = 0.8; // clearly in P1's half
const TOP = 0.2; // clearly in P2's half

await settleFrames();
const start = await readPaddles();
if (start.p1 === null || start.p2 === null) {
  fail(`could not find both paddles on the canvas: ${JSON.stringify(start)}`);
}
ok(`both paddles found (p1 ${start.p1.toFixed(2)}, p2 ${start.p2.toFixed(2)})`);

const moved = (before, after) => Math.abs(after - before) > 0.05;

// --- 1. a finger in the bottom half drives P1, and only P1 -----------------
await touch('touchStart', [{ x: 0.25, y: BOTTOM, id: 1 }]);
await touch('touchMove', [{ x: 0.2, y: BOTTOM, id: 1 }]);
await settleFrames();
let now = await readPaddles();
if (!moved(start.p1, now.p1)) fail(`P1 did not follow a finger in its own half (${start.p1} -> ${now.p1})`);
if (moved(start.p2, now.p2)) fail(`P2 moved for a finger in P1's half (${start.p2} -> ${now.p2})`);
await touch('touchEnd', []);
ok("a finger in the bottom half drives P1, and leaves P2 alone");

// --- 2. and the same the other way round ------------------------------------
await settleFrames();
const beforeTop = await readPaddles();
await touch('touchStart', [{ x: 0.75, y: TOP, id: 2 }]);
await touch('touchMove', [{ x: 0.82, y: TOP, id: 2 }]);
await settleFrames();
now = await readPaddles();
if (!moved(beforeTop.p2, now.p2)) fail(`P2 did not follow a finger in its own half (${beforeTop.p2} -> ${now.p2})`);
if (moved(beforeTop.p1, now.p1)) fail(`P1 moved for a finger in P2's half (${beforeTop.p1} -> ${now.p1})`);
await touch('touchEnd', []);
ok('a finger in the top half drives P2, and leaves P1 alone');

// --- 3. both at once, in opposite directions --------------------------------
// The whole point of the mode: two people playing at the same time. A single
// shared pointer would show up here as one paddle following the other.
await settleFrames();
const beforeBoth = await readPaddles();
await touch('touchStart', [
  { x: 0.5, y: BOTTOM, id: 10 },
  { x: 0.5, y: TOP, id: 11 },
]);
await touch('touchMove', [
  { x: 0.15, y: BOTTOM, id: 10 },
  { x: 0.85, y: TOP, id: 11 },
]);
await settleFrames();
now = await readPaddles();
if (now.p1 > 0.35) fail(`P1 did not follow its own finger to the left (at ${now.p1})`);
if (now.p2 < 0.65) fail(`P2 did not follow its own finger to the right (at ${now.p2})`);
if (Math.abs(now.p1 - now.p2) < 0.3) {
  fail(`both paddles ended up together (${now.p1} / ${now.p2}) — they are sharing a pointer`);
}
await touch('touchEnd', []);
ok('two fingers move both paddles independently, in opposite directions');

// --- 4. a finger that crosses the net keeps the paddle it started with ------
// The half a pointer STARTS in decides the paddle for the life of that
// pointer. Without that, dragging past the halfway line would hand the other
// player's paddle to whoever swiped furthest.
await settleFrames();
const beforeCross = await readPaddles();
await touch('touchStart', [{ x: 0.5, y: BOTTOM, id: 20 }]);
await touch('touchMove', [{ x: 0.3, y: 0.55, id: 20 }]);
await touch('touchMove', [{ x: 0.12, y: TOP, id: 20 }]); // over the net
await settleFrames();
now = await readPaddles();
if (now.p1 > 0.3) fail(`P1 stopped following a finger that crossed the net (at ${now.p1})`);
if (moved(beforeCross.p2, now.p2)) {
  fail(`P2 was stolen by a finger that started in P1's half (${beforeCross.p2} -> ${now.p2})`);
}
await touch('touchEnd', []);
ok('a finger dragged over the net keeps driving the paddle it started on');

// --- 5. the mode is playable and unranked -----------------------------------
// It records no match and saves no stats; the exit is the only way out and it
// must not leave the player stranded on a dead court.
if (!(await page.$('#btn-split-reset'))) fail('no reset control on the split HUD');
await page.click('#btn-split-exit-p1');
await page.waitForSelector('#main-menu-screen', { timeout: 8000 });
ok('exits cleanly back to the main menu');

await sleep(100);
await browser.close();
console.log('split: PASS');
