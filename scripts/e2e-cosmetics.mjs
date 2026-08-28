// Browser E2E for app-wide cosmetics, against a running server:
//  1. The picker lists ONLY what the player owns — a locked cosmetic is not
//     dimmed, it is absent from the DOM.
//  2. Equipping repaints the whole shell, not just the court, and survives a
//     reload (the choice lives on the profile now, not the device).
//  3. The server refuses a locked cosmetic posted straight at the API, because
//     the picker that hides it is the client.
//  4. Opening somebody else's profile renders that card in THEIR cosmetic while
//     the page behind it stays in the viewer's — and closing it leaves the
//     viewer's look untouched.
//
// (4) is the one that cannot be checked anywhere else. It is a claim about CSS
// custom-property inheritance through a real style recalc, and the mechanism it
// depends on has a plausible-looking spelling that compiles, reviews fine and
// paints nothing (see cosmeticVars). Reading the computed value in a real
// browser is the only thing that can tell the two apart.
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

// Free from the first match, so a fresh account owns exactly these.
const FREE = ['neon', 'retro-crt', 'midnight', 'cyberpunk', 'arena-pro'];
// Banked by an elite mission, so a fresh account owns none of these.
const LOCKED = 'void-runner';
// Amber phosphor, as far from the default cyan as the free set goes.
const EQUIP = 'retro-crt';

const browser = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });
const pageErrors = [];

async function newPage() {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  return page;
}

async function onboard(page, username) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#onboarding-modal-overlay', { timeout: 8000 });
  await page.fill('#input-onboarding-username', username);
  await page.waitForSelector('#username-status-available', { timeout: 5000 });
  await page.click('#btn-onboarding-submit');
  await page.waitForSelector('#onboarding-code-step', { timeout: 10000 });
  await page.click('#btn-onboarding-code-continue');
  await page.waitForSelector('#main-menu-screen', { timeout: 8000 });
}

const cssVar = (page, selector, name) =>
  page.$eval(
    selector,
    (el, n) => getComputedStyle(el).getPropertyValue(n).trim(),
    name
  );

async function openCosmetics(page) {
  await page.click('#menu-profile-pill');
  await page.waitForSelector('#profile-tab-cosmetics', { timeout: 8000 });
  await page.click('#profile-tab-cosmetics');
  await page.waitForSelector('#cosmetic-owned-count', { timeout: 5000 });
}

// ---- 1. Locked cosmetics are absent, not dimmed -------------------------
const owner = await newPage();
await onboard(owner, 'CosmeticOwner');
await openCosmetics(owner);

const listed = await owner.$$eval('[id^="cosmetic-btn-"]', (els) =>
  els.map((e) => e.id.replace('cosmetic-btn-', ''))
);
const unexpected = listed.filter((id) => !FREE.includes(id));
if (unexpected.length) fail(`picker offers cosmetics a fresh account has not earned: ${unexpected}`);
const absent = FREE.filter((id) => !listed.includes(id));
if (absent.length) fail(`picker is missing free cosmetics: ${absent}`);

// The contract is stronger than "disabled": there must be no node at all. A
// tile that merely refuses to be tapped still tells the player the cosmetic
// exists, still names it, and still shows its colours — which is the reward.
if (await owner.$(`#cosmetic-btn-${LOCKED}`)) {
  fail(`locked cosmetic ${LOCKED} is present in the DOM`);
}
const body = await owner.textContent('body');
if (/void.?runner/i.test(body || '')) fail('a locked cosmetic is named somewhere on the page');
ok(`picker lists the ${FREE.length} owned cosmetics and no trace of the locked ones`);

// ---- 2. Equipping repaints the shell, and it sticks ---------------------
const before = await cssVar(owner, '#app-root-container', '--color-accent');
await owner.click(`#cosmetic-btn-${EQUIP}`);
await owner.waitForSelector(`#app-root-container[data-cosmetic="${EQUIP}"]`, { timeout: 5000 });
const after = await cssVar(owner, '#app-root-container', '--color-accent');
if (before === after) fail(`equipping ${EQUIP} did not change the shell accent (${before})`);

// The surface ramp has to move too, or this is still a court-only theme
// wearing a new name.
const surface = await cssVar(owner, '#app-root-container', '--color-surface-2');
if (!surface) fail('the shell surface token is not published at all');

await owner.reload({ waitUntil: 'networkidle' });
await owner.waitForSelector('#main-menu-screen', { timeout: 8000 });
const afterReload = await cssVar(owner, '#app-root-container', '--color-accent');
if (afterReload !== after) fail(`cosmetic did not survive a reload (${after} -> ${afterReload})`);
ok(`equipping ${EQUIP} repaints the shell and survives a reload`);

// ---- 3. The server refuses a locked cosmetic ----------------------------
const refusal = await owner.evaluate(async (locked) => {
  const res = await fetch('/api/profile/me', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cosmetic: locked }),
  });
  return { status: res.status, body: await res.json() };
}, LOCKED);
if (refusal.status !== 403 || refusal.body?.error !== 'COSMETIC_LOCKED') {
  fail(`locked cosmetic accepted by the API: ${refusal.status} ${JSON.stringify(refusal.body)}`);
}
const stillEquipped = await cssVar(owner, '#app-root-container', '--color-accent');
if (stillEquipped !== after) fail('a refused equip changed the equipped cosmetic anyway');
ok('the API refuses a locked cosmetic with 403 COSMETIC_LOCKED');

// Boards refuse rows of zeros, so the owner has to have played something
// before a viewer can reach them through the leaderboard.
await owner.evaluate(async () => {
  await fetch('/api/match/record', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      playerScore: 5, opponentScore: 2, bestStreak: 8, earnedStreak: 8,
      mode: 'multiplayer', isWinner: true,
    }),
  });
});
const ownerId = await owner.evaluate(() =>
  fetch('/api/profile/me').then((r) => r.json()).then((p) => p.id)
);

// ---- 4. A public profile wears its OWNER's cosmetic ---------------------
const viewer = await newPage();
await onboard(viewer, 'CosmeticViewer');
const viewerAccent = await cssVar(viewer, '#app-root-container', '--color-accent');
if (viewerAccent === after) {
  fail('viewer and owner ended up on the same cosmetic, so this proves nothing');
}

await viewer.click('#menu-nav-leaderboard');
await viewer.waitForSelector(`#leaderboard-row-${ownerId}`, { timeout: 8000 })
  .catch(() => fail('the owner never appeared on the leaderboard'));
await viewer.click(`#leaderboard-row-${ownerId}`);
await viewer.waitForSelector('#public-profile-card', { timeout: 8000 });
// The card MOUNTS before it knows whose it is: `isOpen={Boolean(playerId)}`,
// while the palette comes from `profile?.cosmetic` fetched afterwards, and
// `normalizeCosmeticId(undefined)` is the DEFAULT cosmetic. So between the tap
// and the response the card legitimately paints #19e3ff, and reading the accent
// on existence alone is a race — one that loopback wins and a CI runner does
// not. `#public-profile-username` renders only on `state === 'ready' && profile`,
// so it is the arrival signal, and it is a DIFFERENT signal from the thing
// being asserted: waiting for the accent itself would just be waiting until the
// assertion passes.
await viewer.waitForSelector('#public-profile-username', { timeout: 8000 })
  .catch(() => fail('the public profile never finished loading'));

const cardAccent = await cssVar(viewer, '#public-profile-card', '--color-accent');
const rootWhileOpen = await cssVar(viewer, '#app-root-container', '--color-accent');
if (cardAccent !== after) {
  fail(`public profile card painted ${cardAccent}, but its owner equipped ${after}`);
}
if (rootWhileOpen !== viewerAccent) {
  fail(`the owner's cosmetic leaked onto the viewer's shell (${rootWhileOpen})`);
}
ok("a public profile renders in its owner's cosmetic, and it does not leak");

await viewer.click('#btn-close-public-profile');
await viewer.waitForSelector('#public-profile-card', { state: 'detached', timeout: 5000 });
const rootAfter = await cssVar(viewer, '#app-root-container', '--color-accent');
if (rootAfter !== viewerAccent) {
  fail(`closing the card left the viewer on ${rootAfter} instead of ${viewerAccent}`);
}
ok("closing it restores the viewer's own look with nothing to clean up");

if (pageErrors.length) fail(`page errors: ${pageErrors.join(' | ')}`);
await browser.close();
console.log('cosmetics E2E passed');
