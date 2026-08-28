// Browser E2E for the achievement tree and the progression gate it enforces:
//   1. A new player has only Rookie and short matches open.
//   2. The server rejects a locked difficulty, not just the menu.
//   3. Beating Rookie opens Pro — and only Pro.
//   4. The tree renders per branch, with deep rungs concealed.
//   5. The toast that announces an unlock expires on its own even with a
//      match running under it, goes when tapped, and does not eat the HUD's
//      taps while it is up.
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
const browser = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('#onboarding-modal-overlay', { timeout: 10000 });
await page.fill('#input-onboarding-username', `Tree${Date.now().toString(36).slice(-5)}`);
await page.waitForSelector('#username-status-available', { timeout: 6000 });
await page.click('#btn-onboarding-submit');
// Onboarding now ends on the sign-in code. Tolerant, so a suite that
// reaches here another way is not broken by its absence.
await page.waitForSelector('#btn-onboarding-code-continue', { timeout: 10000 })
  .then((b) => b.click())
  .catch(() => {});
await page.waitForSelector('#main-menu-screen', { timeout: 10000 });

// No click: Solo is the building the menu opens on, and tapping the tab you
// are already on is now the control that unfolds its locked rooms — which is
// exactly what the next section asserts is folded.
await page.waitForSelector('#room-rookie', { timeout: 5000 });
// The onboarding tour opens by itself for a player who has never seen it —
// it is part of onboarding now, not a menu row. Every suite past this point
// wants the menu, so it is waved away here. Tolerant: a suite that reaches
// this another way is not broken by its absence.
const dis = async (sel) => page.$eval(sel, (el) => el.disabled);
const there = (sel) => page.$(sel).then((el) => !!el);

// A list is a list of places you can go, so the four rungs a new player has
// not earned are folded away rather than shown as four padlocks.
if (!(await there('#room-rookie'))) fail('Rookie should be open from the start');
if (await dis('#room-rookie')) fail('Rookie should be open from the start');
for (const r of ['ai_pro', 'ai_elite', 'cyber', 'chaos']) {
  if (await there(`#room-${r}`)) fail(`${r} is locked for a new player and should be folded away`);
}
ok('new player: Rookie on the list, the rungs above it folded away');

// The fold is the tab itself: tap the one you are already on and they open.
await revealLocked(page, 'solo');
if (!(await dis('#room-ai_pro'))) fail('Pro should be locked for a new player');
if (!(await dis('#room-ai_elite'))) fail('Elite should be locked for a new player');
if (!(await dis('#room-cyber'))) fail('Cyber should be locked for a new player');
if (!(await dis('#room-chaos'))) fail('Chaos should be locked for a new player');
if (!(await page.$('#room-ai_pro-lock'))) fail('no lock marker on Pro');
ok('revealed, they are inert and each says what opens it');

// And tapping it again folds them back.
await page.click('#building-solo');
await page
  .waitForFunction(() => !document.querySelector('#room-ai_pro'), { timeout: 5000 })
  .catch(() => fail('tapping the selected tab again did not fold the locked rooms away'));
ok('and tapping the tab again folds them back');

// The match-length picker lives in the pre-match sheet, which a ROOM opens —
// the rungs above are the room list itself, one level up from it.
await page.click('#room-rookie');
await page.waitForSelector('#menu-pts-3', { timeout: 5000 });
if (await dis('#menu-pts-3') || await dis('#menu-pts-5')) fail('short matches should be open');
if (!(await dis('#menu-pts-10')) || !(await dis('#menu-pts-15'))) fail('long matches should be locked');
ok('short matches open, long matches locked');
await page.click('#btn-prematch-back');
await page.waitForSelector('#prematch-modal', { state: 'detached', timeout: 5000 });

// The server enforces it too, not just the menu.
const blocked = await page.evaluate(async () => {
  const r = await fetch('/api/match/record', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerScore: 5, opponentScore: 0, bestStreak: 8, earnedStreak: 8, mode: 'solo', difficulty: 'cyber', isWinner: true }) });
  return { status: r.status, body: await r.text() };
});
if (blocked.status !== 403) fail(`server let a locked difficulty through: ${blocked.status}`);
ok(`server rejects a locked difficulty (${blocked.status} ${JSON.parse(blocked.body).error})`);

// Beat Rookie -> Pro opens.
await page.evaluate(async () => {
  await fetch('/api/match/record', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerScore: 5, opponentScore: 1, bestStreak: 8, earnedStreak: 8, mode: 'solo', difficulty: 'rookie', isWinner: true }) });
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('#main-menu-screen', { timeout: 8000 });
await revealLocked(page, 'solo');
await page.waitForSelector('#room-ai_pro', { timeout: 5000 });
if (await dis('#room-ai_pro')) fail('beating Rookie did not open Pro');
if (!(await dis('#room-ai_elite'))) fail('beating Rookie should not open Elite');
ok('beating Rookie opens Pro, and only Pro');

// A single Pro win used to hand over Cyber in a first session. It now needs
// ten Pro wins AND level 10 — a climb, not an accident.
await page.evaluate(async () => {
  await fetch('/api/match/record', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerScore: 5, opponentScore: 2, bestStreak: 8, earnedStreak: 8, mode: 'solo', difficulty: 'pro', isWinner: true }) });
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('#main-menu-screen', { timeout: 8000 });
await revealLocked(page, 'solo');
await page.waitForSelector('#room-ai_elite', { timeout: 5000 });
if (!(await dis('#room-ai_elite'))) fail('one Pro win should NOT open Elite');
ok('one Pro win does not open Elite');

const proProfile = await page.evaluate(async () => (await fetch('/api/profile/me')).json());
for (let i = 0; i < 60; i++) {
  const p = await page.evaluate(async () => (await fetch('/api/profile/me')).json());
  if (p.achievements.includes('ai_pro_10')) break;
  await page.evaluate(async () => {
    await fetch('/api/match/record', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerScore: 5, opponentScore: 2, bestStreak: 8, earnedStreak: 8, mode: 'solo', difficulty: 'pro', isWinner: true }) });
  });
}
const climbed = await page.evaluate(async () => (await fetch('/api/profile/me')).json());
if (!climbed.achievements.includes('ai_pro_10')) fail('the Elite gate never opened over 60 Pro wins');
if (climbed.level < 10) fail(`the level gate was not enforced (level ${climbed.level})`);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('#main-menu-screen', { timeout: 8000 });
await revealLocked(page, 'solo');
await page.waitForSelector('#room-ai_elite', { timeout: 5000 });
if (await dis('#room-ai_elite')) fail('the full climb did not open Elite');
if (!(await dis('#room-cyber'))) fail('the Pro climb must not open Cyber — that is Elite\'s climb');
ok(`Elite opens after the climb: ${climbed.proWins} Pro wins, level ${climbed.level} (was ${proProfile.level})`);

// Match lengths live in the pre-match sheet, a level down from the rooms.
await page.click('#room-rookie');
await page.waitForSelector('#menu-pts-10', { timeout: 5000 });
if (await dis('#menu-pts-10')) fail('a first win should open first-to-10');
ok('a first win opens longer matches');

// Achievement tree renders with branches and hidden rungs.
// The difficulty and match-length pickers above live in solo's pre-match
// sheet, which covers the tab bar the way the duel lobby always has. Close it
// before navigating — the fallback that used to be here reached for a
// #menu-nav-trophies that has never existed, so an intercepted click came
// back as a 30s timeout naming the wrong element.
await page.click('#btn-close-prematch');
await page.waitForSelector('#prematch-modal', { state: 'detached', timeout: 4000 });
await page.click('#menu-nav-achievements');
await page.waitForSelector('#ach-branch-ladder', { timeout: 5000 });
for (const b of ['foundation','rally','ladder','duel','craft','ascent','dominion','devotion']) {
  if (!(await page.$(`#ach-branch-${b}`))) fail(`missing branch tab ${b}`);
}
ok('all eight branch tabs render');

// Concealed branches: the tab is a lock, and opening it explains what to do.
const locked = await page.$eval('#ach-branch-ascent', (el) => el.getAttribute('data-locked'));
if (locked !== 'true') fail('Ascent should be concealed for a player who has never duelled');
const openTab = await page.$eval('#ach-branch-ladder', (el) => el.getAttribute('data-locked'));
if (openTab !== 'false') fail('Ladder should be open from the start');
await page.click('#ach-branch-ascent');
await page.waitForSelector('#ach-branch-locked', { timeout: 4000 });
const hint = (await page.textContent('#ach-branch-locked')).trim();
if (!/duel/i.test(hint)) fail(`the locked branch gave no usable hint: "${hint}"`);
ok(`a concealed branch shows a lock and a hint: "${hint.split('\n').pop().trim()}"`);

// Devotion is gated on level, and this profile has climbed past it.
const devLocked = await page.$eval('#ach-branch-devotion', (el) => el.getAttribute('data-locked'));
if (devLocked !== 'false') fail('Devotion should have opened at level 5');
ok('the level-gated branch opened once the level was there');
await page.click('#ach-branch-ladder');
await page.waitForTimeout(400);
if (!(await page.$('#ach-row-cyber_slayer'))) fail('ladder branch did not render its rows');
const body = await page.textContent('#menu-page-achievements');
if (!/\?\?\?/.test(body)) fail('no hidden achievements concealed');
ok('tree renders per branch, with deep rungs concealed');


/**
 * Locked rooms are hidden until you tap the tab you are already on.
 *
 * A list is a list of places you can go, so the rooms this player cannot enter
 * are folded away — and the selected tab is the fold: tapping it opens them,
 * tapping it again (or moving to another building) closes them. Idempotent, so
 * a caller never has to know which state it is in.
 */
async function revealLocked(page, building = 'solo') {
  await page.waitForSelector(`#building-${building}`, { timeout: 8000 });
  if ((await page.getAttribute(`#building-${building}`, 'data-selected')) !== 'true') {
    await page.click(`#building-${building}`);
  }
  if ((await page.getAttribute(`#building-${building}`, 'data-reveal')) !== 'true') {
    await page.click(`#building-${building}`);
  }
  await page.waitForFunction(
    (b) => document.querySelector(`#building-${b}`)?.getAttribute('data-reveal') === 'true',
    building,
    { timeout: 5000 }
  );
}

// ---------------------------------------------------------------------------
// The toast that announces an unlock has to leave on its own, and go the
// moment it is tapped.
//
// It used to do neither. Its timer was armed by an effect that listed the
// dismiss callback among its dependencies; App rebuilds that callback on
// every render and re-renders once per animation frame while a ball is in
// play, so the timer was torn down and re-armed sixty times a second and
// never fired. It outlived the match that raised it and the menu after that,
// and there was no tap handler to cut it short.
//
// Each check gets its own fresh player: the profile above has long since
// earned first_serve, and an unlock only happens once.
// ---------------------------------------------------------------------------

// Park the paddle at the wall and keep asking to serve (Space is a no-op when
// it is not this player's serve). Who wins does not matter — only that the
// match finishes and is recorded, since `first_serve` is granted
// unconditionally on any recorded match (server/db.ts).
async function playSoloToEnd(p, ms = 90000) {
  await p.keyboard.down('KeyA');
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await p.$('#btn-play-again')) break;
    await p.keyboard.press('Space');
    await p.waitForTimeout(350);
  }
  await p.keyboard.up('KeyA');
  if (!(await p.$('#btn-play-again'))) fail('a first-to-3 solo match never finished');
}

async function freshPlayerInAMatch(label) {
  const c = await browser.newContext({ ...devices['iPhone 13'] });
  const p = await c.newPage();
  p.on('pageerror', (e) => errs.push(`${label}: ${e.message}`));
  await p.goto(BASE, { waitUntil: 'networkidle' });
  await p.waitForSelector('#onboarding-modal-overlay', { timeout: 10000 });
  await p.fill('#input-onboarding-username', `${label}${Date.now().toString(36).slice(-5)}`);
  await p.waitForSelector('#username-status-available', { timeout: 6000 });
  await p.click('#btn-onboarding-submit');
  await p.waitForSelector('#btn-onboarding-code-continue', { timeout: 10000 })
    .then((b) => b.click())
    .catch(() => {});
  await p.waitForSelector('#main-menu-screen', { timeout: 10000 });
  await p.click('#building-solo');
  await p.click('#room-rookie');
  await p.waitForSelector('#menu-pts-3', { timeout: 8000 });
  await p.click('#menu-pts-3');
  await p.click('#menu-start-solo');
  await p.waitForSelector('#half-court-canvas', { timeout: 8000 });
  return { ctx: c, page: p };
}

// --- 1. It expires while a match is running underneath it -------------------
{
  const { ctx, page: p } = await freshPlayerInAMatch('Expiry');
  await playSoloToEnd(p);
  if (!(await p.waitForSelector('[data-toast="achievement"]', { timeout: 20000 }).catch(() => null))) {
    fail('a first-ever match announced no unlock at all');
  }
  ok('a first match announces its unlock');

  // Play Again puts a live court back under the toast, and serving gets the
  // ball moving — which is exactly the condition that used to make the toast
  // immortal. Space is pressed round the loop so a rally is always in flight.
  await p.click('#btn-play-again');
  await p.waitForSelector('#half-court-canvas', { timeout: 8000 });
  await p.keyboard.down('KeyA');
  let stillUp = true;
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    await p.keyboard.press('Space');
    await p.waitForTimeout(300);
    if (!(await p.$('[data-toast="achievement"]'))) { stillUp = false; break; }
  }
  await p.keyboard.up('KeyA');
  if (stillUp) fail('the toast outlived a match running under it — its timer is being re-armed by App re-renders');
  ok('the toast expires on schedule with a ball in play');
  await ctx.close();
}

// --- 2. Tapping it dismisses it, and it does not eat the HUD's taps ---------
{
  const { ctx, page: p } = await freshPlayerInAMatch('Tap');
  await playSoloToEnd(p);
  const toast = await p.waitForSelector('[data-toast="achievement"]', { timeout: 20000 }).catch(() => null);
  if (!toast) fail('no achievement toast to tap');

  // Back to a live court so the HUD is on screen under the toast. Everything
  // from here runs inside the toast's own dwell, so it is still up.
  await p.click('#btn-play-again');
  await p.waitForSelector('#half-court-canvas', { timeout: 8000 });

  const hit = await p.evaluate(() => {
    const t = document.querySelector('[data-toast="achievement"]');
    if (!t) return { gone: true };
    const btn = document.querySelector('#btn-sound-toggle');
    if (!btn) return { noButton: true };
    const b = btn.getBoundingClientRect();
    const el = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
    return { intercepted: !!(el && t.contains(el)) };
  });
  if (hit.gone) fail('the toast vanished inside its own dwell — cannot test what it blocks');
  if (hit.noButton) fail('no HUD sound button to test against');
  if (hit.intercepted) fail('the toast is swallowing taps meant for the HUD underneath it');
  ok('the HUD stays reachable while a toast is up');

  // A first-ever match unlocks several at once, so each card is tapped on its
  // own id: dismissing one must take that one and leave its siblings, which is
  // the whole reason the dismiss is a functional update.
  const ids = await p.$$eval('[data-toast="achievement"]', (els) => els.map((e) => e.id));
  if (!ids.length) fail('the toast vanished before it could be tapped');
  await p.click(`#${ids[0]}`);
  const went = await p
    .waitForSelector(`#${ids[0]}`, { state: 'detached', timeout: 1500 })
    .then(() => true)
    .catch(() => false);
  if (!went) fail('tapping the achievement toast did not dismiss it');
  const left = await p.$$eval('[data-toast="achievement"]', (els) => els.length);
  if (left !== ids.length - 1) fail(`tapping one card took ${ids.length - left} of ${ids.length} cards with it`);
  ok(`tapping a card dismisses that card alone (${ids.length} unlocked, ${left} left)`);
  await ctx.close();
}

if (errs.length) fail(`page errors: ${errs.join(' | ')}`);
console.log('\nTREE + GATING CHECKS PASSED');
await browser.close();
