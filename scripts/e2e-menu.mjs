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
// 10. A second flick inside the settle keeps the first turn.
// 11. A page REFETCHES when it becomes current. The window mounts three slots,
//     so a page fetches when it becomes a NEIGHBOUR and never again — leave the
//     menu on PLAY and swipe to RANKS ten minutes later and you get the
//     snapshot taken when RANKS slid into the window.
// 12. A refetch never blanks what is already on screen, which is what makes
//     leg 11 an improvement rather than a flash on every arrival.
// 13a. Arriving on RANKS refetches the PROFILE too, not only the board — the
//     header capsule prints the player's own ladder position and this page
//     prints the same ladder, so the two must not be fetched at different
//     moments and disagree on one screen. The page's refresh BUTTON is the
//     same requirement by a second door, and was missed the first time.
// 13. The progression meters are in the HEADER and not in a page. They used to
//     open the PLAY page as a rank card, so they unmounted every time the pager
//     window moved past index 0 and refilled from empty on the way back. The
//     header is the one region outside the pager, and the capsule that holds
//     them has to stay inside the offset the toast stack clears it by — a
//     failure with no build error and no red test, just toasts over the header.
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

// ---- 10. A second flick inside the settle keeps the first turn ----------
// `onCommit` is reachable ONLY from the settle timer, so a pointer arriving
// during the 180ms animation used to cancel the turn outright: the track sat
// at the adjacent page while `index` never moved, and the next paint —
// absolute, `-100% + dx` — recomputed from the OLD resting slot and snapped
// back. Two quick flicks advanced one page, or none.
//
// Deliberately NO settle between the two drags: the wait is the bug's hiding
// place, and every other drag in this suite waits.
await page.click('#menu-nav-play');
await settle();
if ((await currentPage()) !== 'play') fail(`could not get back to play to start the rapid-flick leg`);

const rapidBox = await (await page.$('#menu-pager')).boundingBox();
const rapidY = rapidBox.y + rapidBox.height / 2;
const flick = async () => {
  await page.mouse.move(rapidBox.x + rapidBox.width * 0.8, rapidY);
  await page.mouse.down();
  await page.mouse.move(rapidBox.x + rapidBox.width * 0.2, rapidY, { steps: 6 });
  await page.mouse.up();
};
await flick();
await flick();
await settle();

// play -> leaderboard -> achievements. Landing on `leaderboard` is the bug:
// the second flick discarded the first turn and repainted from play.
const afterRapid = await currentPage();
if (afterRapid === 'leaderboard') {
  fail('a second flick inside the settle discarded the first page turn (landed on leaderboard, not achievements)');
}
if (afterRapid !== 'achievements') {
  fail(`two rapid flicks from play landed on ${afterRapid}, not achievements`);
}
ok('a flick starting inside the settle finishes the previous turn rather than eating it');

// ---- 11. A page refetches when it becomes current -----------------------
// The pager mounts [prev, current, next], so a page inside that window stays
// MOUNTED. Every one of these pages fetches from an effect that fires on mount
// and on its own filters and nothing else, so the fetch happened when the page
// became a NEIGHBOUR and never again: the board a player swipes to is the
// snapshot taken whenever RANKS last slid into the window.
//
// The mount-time fetch for a page one swipe away is NOT the bug and is
// deliberately kept — it is what makes a dragged-to page show content instead
// of a spinner — so this counts it and then counts the arrivals on top of it.
let boardCalls = 0;
page.on('request', (r) => {
  if (new URL(r.url()).pathname === '/api/leaderboard') boardCalls += 1;
});

// Start two pages away, so RANKS is outside the window and its mount is the
// first call this leg sees rather than something an earlier leg left behind.
await page.click('#menu-nav-history');
await settle();
if (await page.$('#menu-page-leaderboard')) fail('RANKS is still mounted from HISTORY — the window is wrong, so the count below would be meaningless');
boardCalls = 0;

await page.click('#menu-nav-play');
await settle();
if (!(await page.$('#menu-page-leaderboard'))) fail('RANKS did not mount as PLAY\'s neighbour');
// EXACTLY one, which is a claim about the production bundle the runner serves
// (`e2e-run.mjs` sets NODE_ENV=production). Pointed at a dev server it would
// read 2: `src/main.tsx` renders under StrictMode, so React runs an effect
// setup → cleanup → setup on mount. That is the same hazard `useArrivalRefetch`
// is written around — it compares the previous VALUE rather than counting runs,
// so a mount is a non-transition under both invocations — and the arrivals
// below stay at one call each in dev, which is what that guard buys.
if (boardCalls !== 1) fail(`RANKS mounting as a neighbour fetched ${boardCalls} times, expected exactly 1`);

await page.click('#menu-nav-leaderboard');
await settle();
if (boardCalls !== 2) {
  fail(`arriving on RANKS did not refetch (${boardCalls} calls, expected 2) — a mounted page is serving whatever it fetched as a neighbour`);
}

// Away and back WITHOUT leaving the window: PLAY and RANKS are adjacent, so
// the page stays mounted and a second arrival cannot be explained by a remount.
await page.click('#menu-nav-play');
await settle();
if (!(await page.$('#menu-page-leaderboard'))) fail('RANKS unmounted on the way back to PLAY, so the third call would just be another mount');
if (boardCalls !== 2) fail(`LEAVING a page refetched it (${boardCalls} calls) — only arriving should`);
await page.click('#menu-nav-leaderboard');
await settle();
if (boardCalls !== 3) {
  fail(`the second arrival on RANKS did not refetch (${boardCalls} calls, expected 3) — one lucky mount order is not the rule`);
}
ok('a page refetches every time it becomes current, mounted or not');

// ---- 12. A refetch never blanks what is already on screen ---------------
// Leg 11 is a visible REGRESSION without this: every arrival would swap the
// board for a spinner. `MatchHistoryList` has always had the rule
// (`isLoading && rows.length === 0`); this is it on the leaderboard.
//
// Deterministic by holding the response open rather than by racing it: the
// route handler firing is itself the proof the fetch is in flight, since the
// component sets `isLoading` synchronously before calling fetch.
const boardRows = () => page.$$eval('[id^="leaderboard-row-"]', (els) => els.length);
const rowsBefore = await boardRows();
if (rowsBefore === 0) {
  fail('the leaderboard has no rows, so "the refetch did not blank it" would pass vacuously');
}

let releaseBoard = null;
let intercepted = false;
// `unroute` must not overtake the handler: releasing only schedules the
// `route.continue()`, and unrouting before it lands makes Playwright handle
// the route itself — the handler's own continue then throws "already handled"
// and takes the run down. So the handler says when it is finished.
let handlerDone = null;
const handled = new Promise((resolve) => {
  handlerDone = resolve;
});
await page.route('**/api/leaderboard*', async (route) => {
  intercepted = true;
  await new Promise((resolve) => {
    releaseBoard = resolve;
  });
  await route.continue();
  handlerDone();
});

await page.click('#btn-refresh-leaderboard');
for (let i = 0; i < 50 && !intercepted; i += 1) await page.waitForTimeout(20);
if (!intercepted) fail('the refresh button issued no request, so this leg proves nothing');
// The interception proves the request LEFT; it does not prove React has
// painted the loading state yet, and it has not. `setIsLoading(true)` runs in
// the effect that calls fetch, so its render commits a beat AFTER the request
// reaches Playwright — sampled immediately, this leg reads the pre-refresh
// paint and passes however the branch is written. Measured exactly that way:
// with the bare `isLoading` restored it read 8 rows and went green. Waiting is
// free and cannot race, because the response is held open below until we
// release it, so nothing can arrive and repopulate the list in the meantime.
await settle();

const rowsDuring = await boardRows();
if (rowsDuring !== rowsBefore) {
  fail(`a refetch blanked the board mid-flight: ${rowsBefore} rows before, ${rowsDuring} while loading`);
}

releaseBoard();
await handled;
await page.unroute('**/api/leaderboard*');
await settle();
if ((await boardRows()) === 0) fail('the board never came back after the held response was released');
ok('a refetch leaves the rows on screen while it is in flight');

// ---- 13. The progression meters live in the header, not in a page --------
// The XP bar and the rank meter opened the PLAY page as a full-width card, so
// they unmounted whenever the pager window moved past PLAY (three slots of
// five) and replayed `scaleX: 0 -> pct` on the way back — a sweep from empty
// for a value that had not changed. They are in the header now, which is the
// one region outside the pager.
await page.click('#menu-nav-play');
await settle();

const meters = await page.evaluate(() => {
  const pager = document.querySelector('#menu-pager');
  const pill = document.querySelector('#menu-profile-pill');
  const ids = ['menu-xp-bar', 'menu-rank-bar'];
  const out = {};
  for (const id of ids) {
    const el = document.getElementById(id);
    out[id] = el ? { inPager: !!pager?.contains(el), inPill: !!pill?.contains(el) } : null;
  }
  out.badge = !!pill?.querySelector('[id^="tier-badge-"]');
  return out;
});
for (const id of ['menu-xp-bar', 'menu-rank-bar']) {
  if (!meters[id]) fail(`#${id} is not in the document on the menu`);
  if (meters[id].inPager) fail(`#${id} is inside #menu-pager, so it unmounts with its page`);
}
for (const id of ['menu-rank-bar', 'menu-xp-bar']) {
  if (!meters[id].inPill) fail(`#${id} is not inside the profile capsule`);
}
if (!meters.badge) fail('the profile capsule shows no tier badge');
// This suite's player is UNRANKED, so the placement counter must be on screen:
// the rank meter measures games toward placement there rather than a rating,
// and it is the one state that can say its number out loud.
const placement = await page.textContent('#menu-placement-count').catch(() => null);
if (placement?.trim() !== `0/5`) {
  fail(`the capsule shows no placement count for an unplaced player (got ${JSON.stringify(placement)})`);
}
ok('both meters and the tier badge are inside the capsule, with the placement count beside it');

// TROPHIES is two pages from PLAY, so the window drops PLAY entirely. Anything
// still in the document after this outlives the page it used to live on.
await page.click('#menu-nav-achievements');
await settle();
if (await page.$('#menu-page-play')) fail('PLAY is still mounted, so this leg proves nothing');
const survived = await page.evaluate(() =>
  ['menu-xp-bar', 'menu-rank-bar'].filter((id) => !document.getElementById(id))
);
if (survived.length) fail(`the meters unmounted with PLAY: ${survived.join(', ')}`);
ok('the meters outlive the page they used to open');

// The header must not grow past the offset the toast stack clears it by.
// `pt-safe-bar` is pt-safe + 48px and today's header is exactly that, so the
// budget is zero: a taller capsule silently puts every toast over the header.
// Read the utility itself rather than hardcoding 48, or this goes stale the
// day index.css changes and says nothing while it does.
await page.click('#menu-nav-play');
await settle();
const headerBox = await page.evaluate(() => {
  const probe = document.createElement('div');
  probe.className = 'pt-safe-bar';
  document.body.appendChild(probe);
  const offset = parseFloat(getComputedStyle(probe).paddingTop);
  probe.remove();
  const header = document.querySelector('#main-menu-screen header');
  if (!header) return { missing: true };
  const r = header.getBoundingClientRect();
  return { offset, bottom: r.bottom, overflow: header.scrollWidth - header.clientWidth };
});
if (headerBox.missing) fail('the menu has no header');
if (!(headerBox.offset > 0)) fail(`pt-safe-bar resolved to ${headerBox.offset}px, so this leg proves nothing`);
if (headerBox.bottom > headerBox.offset) {
  fail(`the header runs to ${headerBox.bottom}px, past the ${headerBox.offset}px the toast stack clears it by`);
}
if (headerBox.overflow > 1) fail(`the header row overflows its own width by ${headerBox.overflow}px`);
ok(`the header ends at ${headerBox.bottom}px, inside the ${headerBox.offset}px toast offset, and does not overflow`);
// What this does NOT cover, so nobody reads more into it: the test player is
// UNRANKED (8 characters) with a short username, so the overflow check never
// meets "Cyber Overlord" (14) or a 16-character name — the case the capsule's
// `truncate` and `max-w` exist for. And no suite plays a match and samples a
// meter on the way back, so the resume itself is held by
// tests/meterMemory.test.ts, not here.

// ---- 13a. Arriving on RANKS refetches the profile ------------------------
// The header shows the player's own ladder position; RANKS prints the same
// ladder for everybody. Nothing else refreshes that number while the menu sits
// open — the 15s session heartbeat reads the session and never a profile — so
// another player passing an Overlord left the header holding a stale #N beside
// a board that had just fetched the true one. Same arrival the board's own
// refetch spends (leg 11), so this is not a second concept.
let profileCalls = 0;
const countProfile = (r) => {
  if (new URL(r.url()).pathname === '/api/profile/me') profileCalls += 1;
};
page.on('request', countProfile);

await page.click('#menu-nav-history');
await settle();
profileCalls = 0;
await page.click('#menu-nav-leaderboard');
await settle();
if (profileCalls < 1) {
  fail('arriving on RANKS did not refetch the profile, so the header can disagree with the board it is standing next to');
}
// The refresh BUTTON is the same requirement through a second door, and it
// shipped without this for a release: it bumped the board's reloadKey alone, so
// a player sitting on RANKS watching the top of the ladder — which is exactly
// who presses this, and presses it repeatedly — refreshed the rows and left the
// header holding the number they had arrived with. Arrival was fixed first
// because it was the one reported; the invariant is the two numbers agreeing on
// screen, not the moment that asked for them.
profileCalls = 0;
await page.click('#btn-refresh-leaderboard');
await settle();
if (profileCalls < 1) {
  fail('the RANKS refresh button asked the board again and not the profile, so the header can hold a stale position beside the rows that just moved');
}
// And NOT on every page: four times the requests to fix one disagreement.
profileCalls = 0;
await page.click('#menu-nav-history');
await settle();
if (profileCalls !== 0) {
  fail(`arriving on HISTORY refetched the profile ${profileCalls} times — only RANKS shows a competing copy of that number`);
}
page.off('request', countProfile);
ok('RANKS refetches the profile behind the header on arrival AND on its refresh button, and no other page does');

if (pageErrors.length) fail(`page errors: ${pageErrors.join(' | ')}`);
await browser.close();
console.log('menu E2E passed');
