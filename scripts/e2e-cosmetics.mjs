// Browser E2E for app-wide cosmetics, against a running server:
//  1. The picker lists ONLY what the player owns — a locked cosmetic is not
//     dimmed, it is absent from the DOM.
//  1b. Titles, the second permanent reward type, obey the same rule: a fresh
//     account's title picker holds the None chip and nothing else.
//  2. Equipping repaints the whole shell, not just the court, and survives a
//     reload (the choice lives on the profile now, not the device).
//  2b. ...with ONE exception, and it is deliberate: the two progression meters
//     in the menu capsule do not follow the cosmetic. They stack, and
//     --color-xp is a fixed gold, so a rank meter on the per-cosmetic accent
//     became the same bar as the XP meter on every theme whose accent was also
//     gold — retro-crt, which this suite equips, being one of them.
//  3. The server refuses a locked cosmetic posted straight at the API, because
//     the picker that hides it is the client.
//  3b. ...and a locked title (403), an unknown one (400), while null — no title
//     — is always legal, since a title is the optional one of the three.
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

/**
 * The rank meter's painted fill. Its computed colour rather than its class, so
 * this cannot pass on a utility Tailwind never generated.
 */
const meterFill = (page) =>
  page
    .$eval('#menu-rank-bar > *', (el) => getComputedStyle(el).backgroundColor)
    .catch(() => null);

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
// Scoped to the PICKER, not the page body, and that is a repair rather than a
// weakening. Six elite TASKS are named after the TITLE they pay -- Wallbreaker,
// Cold Steel, Unbroken, Scoreboard, Sniper, Clutch -- so a body-wide regex
// cannot tell a locked reward's chip from a task tile legitimately naming the
// task. The hand is a seeded shuffle of (playerId, dayKey) and this suite's
// account is fresh every run, so it reddened on about one run in eight, on CI,
// with nothing in the diff to point at. Scoped, the check says what it means
// and can afford to name all six.
const pickerText = (sel) => owner.textContent(sel).then((t) => t || '');
if (/void.?runner/i.test(await pickerText('#cosmetic-picker'))) {
  fail('a locked cosmetic is named in the picker');
}
ok(`picker lists the ${FREE.length} owned cosmetics and no trace of the locked ones`);

// ---- 1b. Titles obey the same rule, and a fresh account owns none --------
// A title is the second permanent reward type and it shares the picker's
// contract: owned only, absent not dimmed, plus a None chip that is the one
// thing a new account can select. tests/titles.test.ts holds the route and
// the store; what only a browser can say is that the picker RENDERS that way.
const titleChips = await owner.$$eval('[id^="title-btn-"]', (els) => els.map((e) => e.id));
if (titleChips.join() !== 'title-btn-none') {
  fail(`a fresh account's title picker offers ${JSON.stringify(titleChips)}; expected only the None chip`);
}
const noneEquipped = await owner.getAttribute('#title-btn-none', 'data-equipped');
if (noneEquipped !== 'true') fail(`None is not the equipped title on a fresh account (${noneEquipped})`);
const ownedCount = await owner.textContent('#title-owned-count');
if (!/\b0\b/.test(ownedCount || '')) fail(`title count reads "${ownedCount}", expected 0 unlocked`);
const titleText = await pickerText('#title-picker');
for (const name of ['wallbreaker', 'cold steel', 'unbroken', 'scoreboard', 'sniper', 'clutch']) {
  if (new RegExp(name, 'i').test(titleText)) fail(`a locked title is named in the picker: ${name}`);
}
ok('the title picker lists no titles on a fresh account and only None is equipped');

// ---- 2. Equipping repaints the shell, and it sticks ---------------------
const before = await cssVar(owner, '#app-root-container', '--color-accent');
// Sampled here so leg 2b can compare it across the same equip. The capsule is
// behind the open profile sheet, not unmounted by it.
const meterBefore = await meterFill(owner);
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

// ---- 2b. ...except the two meters that stack ----------------------------
// The rank meter sits directly on the XP meter in the capsule, and --color-xp
// is fixed. So a rank meter painted in the per-cosmetic accent was the SAME
// COLOUR as the bar beneath it on every gold-accented theme — retro-crt among
// them, which is what this suite just equipped. It takes a fixed three-stop
// ramp instead (--color-ladder-*), and the property is that the accent moved
// and this did not.
//
// Only a browser can say this. The fast layer holds the tokens
// (tests/cosmetics.test.ts) and the stop arithmetic (tests/ladderTone.test.ts),
// but neither can see which tone RankBadge actually passes — that lives in a
// .tsx, and reverting it to `accent` reddens nothing anywhere else.
const meterAfter = await meterFill(owner);
if (!meterBefore || !meterAfter) {
  fail(`the rank meter's fill was not readable (${meterBefore} -> ${meterAfter})`);
}
if (meterBefore !== meterAfter) {
  fail(
    `equipping ${EQUIP} recoloured the rank meter (${meterBefore} -> ${meterAfter}) — it follows ` +
      `the cosmetic again, so on a gold-accented theme it is the same bar as the XP meter below it`
  );
}
ok('the capsule meters keep their own colours while the rest of the shell repaints');

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

// ---- 3b. ...and a locked title, while null is always legal ---------------
const putTitle = (title) =>
  owner.evaluate(async (t) => {
    const res = await fetch('/api/profile/me', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: t }),
    });
    return { status: res.status, body: await res.json() };
  }, title);
const lockedTitle = await putTitle('sniper');
if (lockedTitle.status !== 403 || lockedTitle.body?.error !== 'TITLE_LOCKED') {
  fail(`locked title accepted by the API: ${lockedTitle.status} ${JSON.stringify(lockedTitle.body)}`);
}
const unknownTitle = await putTitle('not-a-title');
if (unknownTitle.status !== 400 || unknownTitle.body?.error !== 'TITLE_UNKNOWN') {
  fail(`unknown title not refused as such: ${unknownTitle.status} ${JSON.stringify(unknownTitle.body)}`);
}
const clearTitle = await putTitle(null);
if (clearTitle.status !== 200 || clearTitle.body?.title !== undefined) {
  fail(`clearing a title should be a 200 with no title on the profile: ${clearTitle.status} ${JSON.stringify(clearTitle.body).slice(0, 120)}`);
}
ok('the API refuses a locked title with 403 TITLE_LOCKED, an unknown one with 400, and clears on null');

// Boards refuse rows of zeros, so the owner has to have played something
// before a viewer can reach them through the leaderboard.
//
// This POST names no room, so nothing can vouch for it as a duel: it pays XP
// and deliberately moves no rating. The viewer therefore looks at the LEVEL
// board below, whose progress filter is `xp > 0`, rather than the default
// skill board, which filters on `rankedGames > 0`. Nothing here is about
// which board — the check is that a public profile wears its owner's palette.
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
await viewer.click('#filter-leaderboard-level');
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
