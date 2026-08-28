// Browser E2E for the menu pager.
//
// The tab bar named five destinations and had one. `const current =
// !tab.onClick` defined "the current tab" as the one with no handler, so PLAY
// was permanently accented, permanently aria-current, and a dead button that
// did nothing when tapped; the other four flipped a boolean and opened a Sheet
// OVER the menu, so navigating read as stacking rather than as going
// somewhere. The five are pages now, in a loop, and this pins the parts of
// that which only a browser can answer:
//
//  1. Five tabs, PLAY current at rest, and every one of them navigates.
//  2. A tab tap lands on its page — and the pager, the page and the tab all
//     agree about which one that is.
//  3. A drag pages, in both directions, tracking the finger: left is forward.
//  4. The loop closes at BOTH ends, which is the thing wrapIndex exists for
//     and the thing a linear track cannot do.
//  5. A drag ON THE TAB BAR pages too, and does not fire the tab underneath —
//     the click suppressor, without which a drag that starts on a tab both
//     pages and jumps.
//  6. A vertical drag does not page.
//  7. A horizontal drag on a Settings slider moves the slider, not the page.
//  8. `pointercancel` commits nothing — the CourtCanvas serve rule, one level
//     up: a notification shade must not turn the page.
//  9. Every page's scroll region actually scrolls its own overflow, so the
//     flex-collapse class of bug cannot return on four new ones.
//
// WHAT THIS SUITE CANNOT DO, stated so nobody reads more into a green run than
// is there: it cannot test `touch-action`. That is enforced by the compositor
// hit-test, and CDP's Input.dispatchTouchEvent injects downstream of it —
// measured, it scrolls a `touch-action: none` element happily. So leg 6 proves
// the JS axis lock and NOT that the browser ceded the gesture, and leg 7 proves
// the opt-out list and not that the slider's own pan-x won. The thresholds
// themselves are stated in tests/gestures.test.ts, where they can be.
//
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

const PAGES = ['play', 'leaderboard', 'achievements', 'history', 'settings'];

const browser = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });
const pageErrors = [];
const ctx = await browser.newContext({ ...devices['iPhone 13'], hasTouch: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('dialog', (d) => d.dismiss().catch(() => {}));
const cdp = await ctx.newCDPSession(page);

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#onboarding-modal-overlay', { timeout: 8000 });
await page.fill('#input-onboarding-username', 'PagerPilot');
await page.waitForSelector('#username-status-available', { timeout: 5000 });
await page.click('#btn-onboarding-submit');
await page.waitForSelector('#onboarding-code-step', { timeout: 10000 });
await page.click('#btn-onboarding-code-continue');
// Wait for the modal to DETACH, not just for the menu to exist: #main-menu-screen
// is mounted behind the onboarding sheet, so waiting on it alone returns while
// the sheet still covers the pager — and every drag then lands on the sheet.
await page.waitForSelector('#onboarding-modal-overlay', { state: 'detached', timeout: 8000 });
await page.waitForSelector('#main-menu-screen', { timeout: 8000 });

const currentPage = () => page.getAttribute('#menu-pager', 'data-page');
const settle = () => page.waitForTimeout(400);

/**
 * A one-pointer horizontal drag across the middle of `selector`.
 *
 * `dir` is the direction the FINGER moves: -1 is leftward, which brings the
 * next page in from the right. page.mouse produces trusted events, so
 * setPointerCapture works; a synthetic PointerEvent would throw on its id.
 */
async function drag(selector, dir, { fraction = 0.6, steps = 12 } = {}) {
  const box = await (await page.$(selector)).boundingBox();
  const y = box.y + box.height / 2;
  const from = box.x + box.width * (dir < 0 ? 0.8 : 0.2);
  await page.mouse.move(from, y);
  await page.mouse.down();
  await page.mouse.move(from + dir * box.width * fraction, y, { steps });
  await page.mouse.up();
  await settle();
}

// ---- 1. Five tabs, and every one of them is a real control --------------
for (const id of PAGES) {
  if (!(await page.$(`#menu-nav-${id}`))) fail(`no tab for ${id}`);
}
if ((await currentPage()) !== 'play') fail(`menu did not open on play (${await currentPage()})`);
if ((await page.getAttribute('#menu-nav-play', 'aria-current')) !== 'page') {
  fail('PLAY is not marked as the current tab');
}
if ((await page.getAttribute('#menu-page-play', 'data-current')) !== 'true') {
  fail('the play page is not marked current');
}
ok('five tabs, PLAY current at rest, pager and page agree');

// ---- 2. A tab tap lands on its page -------------------------------------
await page.click('#menu-nav-history');
await settle();
if ((await currentPage()) !== 'history') fail(`tapping HISTORY landed on ${await currentPage()}`);
if ((await page.getAttribute('#menu-nav-history', 'data-selected')) !== 'true') {
  fail('the HISTORY tab did not take the selection');
}
if (await page.$('#menu-page-play')) {
  // play is two away from history, so it must have left the 3-slot window
  fail('a page three slots away is still mounted — the window is not rotating');
}
ok('a tab tap lands on its page, and the window rotates');

await page.click('#menu-nav-play');
await settle();

// ---- 3. A drag pages, and follows the finger ----------------------------
await drag('#menu-pager', -1);
if ((await currentPage()) !== 'leaderboard') {
  fail(`dragging left from play landed on ${await currentPage()}, not leaderboard`);
}
ok('a leftward drag goes forward');

await drag('#menu-pager', +1);
if ((await currentPage()) !== 'play') {
  fail(`dragging right from leaderboard landed on ${await currentPage()}, not play`);
}
ok('a rightward drag goes back');

// ---- 4. The loop closes at both ends ------------------------------------
await drag('#menu-pager', +1);
if ((await currentPage()) !== 'settings') {
  fail(`dragging back from play should wrap to settings, got ${await currentPage()}`);
}
ok('dragging back from the first page wraps to the last');

await drag('#menu-pager', -1);
if ((await currentPage()) !== 'play') {
  fail(`dragging forward from settings should wrap to play, got ${await currentPage()}`);
}
ok('dragging forward from the last page wraps to the first');

// ---- 5. The tab bar is a swipe surface, and the tap under it is eaten ----
// A drag that starts on a tab must page by ONE and must not also fire that
// tab's onClick — which would jump to whichever tab the finger happened to
// land on, and the two answers are different on purpose here: the drag starts
// over TROPHIES (three away) and pages to RANKS (one away).
const bar = await (await page.$('#menu-tabbar')).boundingBox();
const trophies = await (await page.$('#menu-nav-achievements')).boundingBox();
await page.mouse.move(trophies.x + trophies.width / 2, bar.y + bar.height / 2);
await page.mouse.down();
await page.mouse.move(trophies.x + trophies.width / 2 - bar.width * 0.6, bar.y + bar.height / 2, { steps: 12 });
await page.mouse.up();
await settle();
if ((await currentPage()) !== 'leaderboard') {
  fail(`a drag across the tab bar landed on ${await currentPage()}, not leaderboard (a tap would have given achievements)`);
}
ok('the tab bar pages on a drag without firing the tab under the finger');

await page.click('#menu-nav-play');
await settle();

// ---- 6. A vertical drag does not page -----------------------------------
// The JS axis lock only — see the header: this cannot observe touch-action.
const pager = await (await page.$('#menu-pager')).boundingBox();
await page.mouse.move(pager.x + pager.width / 2, pager.y + pager.height * 0.7);
await page.mouse.down();
await page.mouse.move(pager.x + pager.width / 2, pager.y + pager.height * 0.2, { steps: 12 });
await page.mouse.up();
await settle();
if ((await currentPage()) !== 'play') {
  fail(`a vertical drag turned the page to ${await currentPage()}`);
}
ok('a vertical drag does not page');

// ---- 7. A slider keeps its own horizontal drag --------------------------
await page.click('#menu-nav-settings');
await page.waitForSelector('#slider-sfx-volume', { timeout: 5000 });
const before = await page.$eval('#slider-sfx-volume', (el) => el.value);
await drag('#slider-sfx-volume', -1, { fraction: 0.4 });
if ((await currentPage()) !== 'settings') {
  fail(`dragging a slider turned the page to ${await currentPage()}`);
}
const after = await page.$eval('#slider-sfx-volume', (el) => el.value);
if (before === after) fail(`the slider did not move (${before}), so this proves nothing`);
ok('a horizontal drag on a slider moves the slider, not the page');

await page.click('#menu-nav-play');
await settle();

// ---- 8. pointercancel commits nothing -----------------------------------
// The rule CourtCanvas learned when a pulled-down notification shade fired a
// serve. CDP because a cancel cannot be produced with page.mouse at all.
const touch = (type, points) =>
  cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: 1, radiusX: 5, radiusY: 5, force: 1 })),
  });
const cy = pager.y + pager.height / 2;
const cx0 = pager.x + pager.width * 0.8;
await touch('touchStart', [{ x: cx0, y: cy }]);
await touch('touchMove', [{ x: cx0 - 40, y: cy }]);
await touch('touchMove', [{ x: cx0 - pager.width * 0.7, y: cy }]);

// The drag has to be PROVEN live before it is cancelled. Without this the leg
// is vacuous, and it was: `release` returns early on a pointerId it does not
// own, so a cancel that never engaged looks exactly like one correctly
// ignored, and the suite passed with `onPointerCancel` wired to commit.
if ((await page.getAttribute('#menu-pager', 'data-dragging')) !== 'true') {
  fail('the touch drag never engaged, so cancelling it proves nothing');
}
await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
await settle();
if ((await currentPage()) !== 'play') {
  fail(`a cancelled drag committed to ${await currentPage()}`);
}
if ((await page.getAttribute('#menu-pager', 'data-dragging')) !== 'false') {
  fail('the pager is still dragging after a cancel');
}
ok('a cancelled drag engages, then commits nothing')

// ---- 8b. Every task dealt today is on PLAY, with nothing to scroll ------
// This was a scroll-x rail of at most three UNCLAIMED tasks, so the elite one
// — the permanent unlock — could sit off-screen behind a sideways scroll, and
// the row shortened through the day as tasks were claimed.
await page.click('#menu-nav-play');
await settle();
await page.waitForSelector('#menu-daily-grid', { timeout: 5000 });
const tasks = await page.$$eval('#menu-daily-grid [id^="menu-daily-"]', (els) =>
  els.map((e) => ({ id: e.id, tier: e.getAttribute('data-tier') }))
);
if (tasks.length !== 4) {
  fail(`PLAY shows ${tasks.length} tasks, not the 4 dealt (3 regular + 1 elite)`);
}
if (!tasks.some((t) => t.tier === 'elite')) {
  fail('the elite task is not among the tasks shown on PLAY');
}
const gridScrolls = await page.$eval('#menu-daily-grid', (el) => el.scrollWidth > el.clientWidth + 1);
if (gridScrolls) fail('the task grid scrolls sideways, so not all of it is visible at once');
if (await page.$('#menu-nav-missions')) fail('the header Tasks button is still there');
ok('all four dealt tasks are on PLAY, elite included, with nothing to scroll');

// ---- 9. Every page scrolls its own overflow -----------------------------
// Four new scroll regions, each a chance for the flex-collapse bug: a flex
// item whose overflow is not `visible` has an automatic minimum size of ZERO,
// so it squashes rather than overflowing and the region has nothing to scroll.
for (const id of PAGES) {
  await page.click(`#menu-nav-${id}`);
  await settle();
  const probe = await page.evaluate((pageId) => {
    const el = document.querySelector(`#menu-page-${pageId}`);
    if (!el) return { missing: true };
    const region = el.querySelector('.scroll-y') || el.firstElementChild;
    if (!region) return { noRegion: true };
    const kids = [...region.children];
    return {
      height: region.clientHeight,
      crushed: kids.filter((k) => k.clientHeight + 1 < k.scrollHeight).map((k) => k.id || k.className),
      kids: kids.length,
    };
  }, id);
  if (probe.missing) fail(`#menu-page-${id} is not in the document while it is current`);
  if (probe.noRegion) fail(`#menu-page-${id} has no scroll region`);
  if (probe.height < 100) fail(`#menu-page-${id}'s scroll region collapsed to ${probe.height}px`);
  // A selector matching nothing passes vacuously, so say so rather than
  // trusting the empty list.
  if (probe.kids === 0) fail(`#menu-page-${id} has no children to check for crushing`);
  if (probe.crushed.length) fail(`#menu-page-${id} has clipped children: ${probe.crushed.join(', ')}`);
}
ok('all five pages scroll their own overflow, and nothing is crushed');

if (pageErrors.length) fail(`page errors: ${pageErrors.join(' | ')}`);
await browser.close();
console.log('menu E2E passed');
