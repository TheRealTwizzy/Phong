// Browser E2E for the two surfaces a public release needs and an invited one
// did not: telling players what changed, and letting them tell us what broke.
//
// The rules underneath are stated where they can be stated properly —
// tests/reports.test.ts owns the account-lifecycle behaviour, tests/i18n.test.ts
// owns the copy, tests/patchNotes.test.ts owns the data. What only a browser
// can answer is the FLOW, and specifically the shape of failure this repo
// keeps hitting: a control that exists in the DOM and is 160px below where any
// gesture can reach it.
//
//  1. Both rows are on the SETTINGS page, and only there. The Settings PANEL
//     is also the body of the in-match HUD sheet, so a form to type into must
//     not be one tap from a live court — the same gate account deletion has.
//  2. The patch-notes sheet opens, names the version AND the build, and its
//     CTA is inside the viewport. A sheet body is a flex column and a child
//     that clips instead of scrolling collapses it; nothing goes red when
//     that happens, which is why this is measured rather than assumed.
//  3. The unread dot appears for a device that has never opened the notes and
//     is gone afterwards — the one thing that makes patch notes findable for
//     a player who is not looking for them.
//  4. Send is refused until there is actually a report, the category control
//     selects, and the exploit category says a security report is private.
//  5. A report reaches the server with diagnostics NOBODY TYPED — the build,
//     the version, the locale, the device. A report without a build id costs
//     an afternoon, and no player is going to supply one by hand.
//  6. The per-day allowance refuses the next one rather than silently
//     dropping it.
//
// Run it with `npm run test:e2e` (see scripts/e2e-run.mjs), which hands this
// a fresh server, port, DATA_DIR and Chromium.
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
  await page.waitForSelector('#onboarding-code-step', { timeout: 10000 });
  await page.click('#btn-onboarding-code-continue');
  await page.waitForSelector('#onboarding-modal-overlay', { state: 'detached', timeout: 8000 });
  await page.waitForSelector('#main-menu-screen', { timeout: 8000 });
}

/** The viewport this suite drives, so a CTA below it is a real failure. */
const VIEWPORT_H = devices['iPhone 13'].viewport.height;
async function assertReachable(page, selector, what) {
  const bottom = await page.$eval(selector, (el) => el.getBoundingClientRect().bottom);
  if (bottom > VIEWPORT_H) {
    fail(`${what} sits ${Math.round(bottom)}px down, past the ${VIEWPORT_H}px viewport`);
  }
  return bottom;
}

const page = await newPage();
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await onboard(page, 'Reporter1');

// ---- 1. Both rows are on the SETTINGS page -------------------------------
await page.click('#menu-nav-settings');
await page.waitForSelector('#btn-open-patch-notes', { timeout: 8000 })
  .catch(() => fail('the Settings page has no patch-notes row'));
if (!(await page.$('#btn-open-report'))) fail('the Settings page has no report row');
if (!(await page.$('#btn-open-legal'))) fail('the Settings page has no privacy/terms row');
ok('all three rows are on the Settings page');

// ---- 1b. THE GATE: neither row is reachable from a live court ------------
// SettingsPanel is the body of the menu's Settings PAGE *and* of the in-match
// HUD's sheet — one component, two mounts. Both rows open a sheet to type
// into, and a form over a live court is a ball nobody is watching, so App
// supplies the callbacks only from the menu (absent = not offered, the same
// contract AccountDangerZone uses).
//
// Leg 1 cannot catch a gate that is simply always open: it only ever looks
// from the menu, where the rows are supposed to be. This is the leg that
// catches it. Its own page and its own account, so it disturbs nothing.
const gated = await newPage();
await gated.goto(BASE, { waitUntil: 'domcontentloaded' });
await onboard(gated, 'GateReport1');
await gated.click('#building-solo');
await gated.click('#room-rookie');
await gated.click('#menu-start-solo');
await gated.waitForSelector('#btn-open-settings', { timeout: 10000 });
await gated.click('#btn-open-settings');
await gated.waitForSelector('#settings-modal-overlay', { timeout: 5000 });
// The panel really did render — without this the two absence checks below
// would pass on an empty sheet, which is the vacuous half of the same trap.
await gated.waitForSelector('#toggle-master-sound', { timeout: 5000 })
  .catch(() => fail('the in-match settings sheet never rendered its panel'));
if (await gated.$('#btn-open-patch-notes')) fail('patch notes were offered from a live court');
if (await gated.$('#btn-open-report')) fail('the report form was offered from a live court');
if (await gated.$('#btn-open-legal')) fail('privacy/terms were offered from a live court');
ok('none of the three rows is reachable from a live court');
await gated.context().close();

// ---- 3a. The dot is there before the notes have been opened --------------
if (!(await page.$('#patch-notes-dot'))) {
  fail('a device that has never opened the notes shows no unread dot');
}
ok('unread dot shown on a fresh device');

// ---- 2. The sheet opens, names version AND build, and is reachable -------
await page.click('#btn-open-patch-notes');
await page.waitForSelector('#patch-notes-sheet-card', { timeout: 5000 });
const header = (await page.textContent('#patch-notes-build'))?.trim() ?? '';
if (!/^v\d+\.\d+\.\d+ · [0-9a-f]{12}$/.test(header)) {
  fail(`the header reads "${header}" rather than a version and a build id`);
}
// The two answer different questions and a support conversation needs both,
// so this asserts the pair rather than either alone.
const live = await page.evaluate(() => fetch('/api/health').then((r) => r.json()));
if (!header.includes(live.version)) fail(`header ${header} disagrees with /api/health ${live.version}`);
if (!header.includes(live.build)) fail(`header ${header} disagrees with the served build ${live.build}`);
ok(`patch notes name the running version and build ("${header}")`);

const cta = await assertReachable(page, '#btn-patch-notes-done', 'the patch-notes CTA');
ok(`patch-notes CTA is reachable (bottom at ${Math.round(cta)}px)`);

// ---- 3b. ...and gone once they have been read ----------------------------
await page.click('#btn-patch-notes-done');
await page.waitForSelector('#patch-notes-sheet-card', { state: 'detached', timeout: 5000 });
if (await page.$('#patch-notes-dot')) fail('the unread dot survived opening the notes');
ok('the dot clears once the notes are read');

// ---- 4. The form refuses an empty report --------------------------------
await page.click('#btn-open-report');
await page.waitForSelector('#report-sheet-card', { timeout: 5000 });
if (!(await page.$eval('#btn-report-send', (el) => el.disabled))) {
  fail('send is enabled with an empty body');
}
await page.click('#report-cat-exploit');
if ((await page.$eval('#report-cat-exploit', (el) => el.dataset.selected)) !== 'true') {
  fail('the exploit category did not select');
}
if (!(await page.$('#report-exploit-note'))) {
  fail('the exploit category does not say a security report is private');
}
ok('send is refused until there is a report, and exploit says it is private');

// ---- 5. A real report carries diagnostics nobody typed -------------------
await page.click('#report-cat-bug');
await page.fill('#report-text', 'The ball vanished after a wall bounce at the top left.');
if (await page.$eval('#btn-report-send', (el) => el.disabled)) {
  fail('send is still disabled with a real report in the box');
}
await assertReachable(page, '#btn-report-send', 'the report CTA');
await page.click('#btn-report-send');
await page.waitForSelector('#report-sent', { timeout: 8000 })
  .catch(() => fail('the report was never accepted'));
ok('a report is accepted');

// ---- 6. The per-day allowance refuses rather than dropping ---------------
// Driven at the seam rather than through the form: the point is that the
// SERVER refuses, and typing twenty reports through a textarea would be
// asserting the same thing far more slowly.
const flood = await page.evaluate(async () => {
  const send = () =>
    fetch('/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: 'bug', text: 'flooding the allowance' }),
    }).then((r) => r.status);
  const seen = [];
  for (let i = 0; i < 25; i++) seen.push(await send());
  return seen;
});
if (!flood.includes(429)) fail('the per-day report allowance never refused anything');
// And it refuses rather than accepting-and-discarding, which is the failure
// mode that would leave a player believing they had been heard.
if (flood[flood.length - 1] !== 429) fail('the allowance stopped refusing');
ok(`the daily allowance refuses (first 429 after ${flood.indexOf(429)} more)`);

// A malformed category is refused too — the route is the boundary, and the
// four categories are shared client/server for exactly this reason.
const bad = await page.evaluate(() =>
  fetch('/api/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category: 'not-a-category', text: 'x'.repeat(40) }),
  }).then((r) => r.status)
);
if (bad !== 400) fail(`an unknown category answered ${bad} rather than 400`);
ok('an unknown category is refused');

// ---- 7. Privacy and terms exist, and reach a person ---------------------
// A privacy notice is relied on, so what a browser has to answer is that it
// is REACHABLE and that its contact section leads somewhere. Whether its
// claims are true of the code is not a thing a browser can check — that is
// tests/legal.test.ts, which reads the server source.
await page.click('#btn-close-report');
await page.waitForSelector('#report-sheet-card', { state: 'detached', timeout: 5000 });
await page.click('#btn-open-legal');
await page.waitForSelector('#legal-sheet-card', { timeout: 5000 });
for (const id of ['#legal-legal_privacy', '#legal-legal_terms', '#legal-contact']) {
  if (!(await page.$(id))) fail(`${id} is missing from the privacy sheet`);
}
await assertReachable(page, '#btn-legal-done', 'the privacy/terms CTA');
ok('privacy, terms and a contact section are all present and reachable');

// The contact section must lead SOMEWHERE. With no address configured it
// offers the report form, which is a real channel; with one it is a mailto.
// A section that names neither would be the failure worth catching.
const hasEmail = await page.$('#legal-contact-email');
const hasForm = await page.$('#btn-legal-open-report');
if (!hasEmail && !hasForm) fail('the contact section offers no way to reach anybody');
if (hasForm) {
  await page.click('#btn-legal-open-report');
  await page.waitForSelector('#report-sheet-card', { timeout: 5000 })
    .catch(() => fail('the contact section did not open the report form'));
  ok('with no address configured, contact opens the report form');
} else {
  ok('contact offers a mail address');
}

if (pageErrors.length) fail(`page errors: ${pageErrors.join(' | ')}`);
console.log('\nALL REPORT / PATCH-NOTES E2E CHECKS PASSED');
await browser.close();
