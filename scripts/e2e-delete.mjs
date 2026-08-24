// Browser E2E for deleting your own account, from the bottom of Settings.
//
// This is the only irreversible thing a player can do to themselves, so what
// it needs from a browser is not the deletion — tests/accountDeletion.test.ts
// states that at the HTTP seam, where it can be stated properly — but the
// FLOW in front of it, which is not a rule and cannot be:
//
//  1. The section is at the bottom of the Settings sheet and is reachable —
//     the sheet scrolls to it rather than clipping it off the viewport, which
//     is exactly how the pre-match accordion put its Start button 160px below
//     where any gesture could reach.
//  2. Step one is the username typed EXACTLY. A case-flipped name does not
//     open the door, and the mismatch says so.
//  3. Step two is the permanence reminder AND the last word on it: two
//     buttons, DELETE and BACK, and nothing else.
//  4. BACK returns to the open Settings panel with the account intact — the
//     panel, not a closed sheet and not a half-armed confirmation waiting to
//     go off the next time Settings is opened.
//  5. DELETE spends the account: the page comes back as a brand-new player on
//     the onboarding modal, and the name is free again.
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

// The onboarding tour opens by itself for a player who has never seen it.
async function skipTour(page) {
  const card = await page
    .waitForSelector('#onboarding-tour-card', { timeout: 8000 })
    .catch(() => null);
  if (!card) return;
  await page.click('#btn-tour-skip');
  await page.click('#btn-tour-skip-confirm');
  await page
    .waitForSelector('#onboarding-tour-overlay', { state: 'detached', timeout: 8000 })
    .catch(() => {});
}

async function onboard(page, username) {
  await page.waitForSelector('#onboarding-modal-overlay', { timeout: 8000 });
  await page.fill('#input-onboarding-username', username);
  await page.waitForSelector('#username-status-available', { timeout: 5000 });
  await page.click('#btn-onboarding-submit');
  await page.waitForSelector('#onboarding-code-step', { timeout: 10000 });
  await page.click('#btn-onboarding-code-continue');
  await skipTour(page);
  await page.waitForSelector('#onboarding-modal-overlay', { state: 'detached', timeout: 8000 });
  await page.waitForSelector('#main-menu-screen', { timeout: 8000 });
}

async function openSettings(page) {
  await page.click('#menu-nav-settings');
  await page.waitForSelector('#settings-modal-overlay', { timeout: 5000 });
}

const NAME = 'DeleteMe01';

// ---- 1. The section is at the bottom of Settings, and reachable ----------
const page = await newPage();
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await onboard(page, NAME);
await openSettings(page);

const zone = await page.waitForSelector('#danger-zone', { timeout: 5000 })
  .catch(() => fail('no account-deletion section in the Settings sheet'));

// Last in the sheet, deliberately: everything above it is a preference that
// can be flipped back.
const isLast = await page.evaluate(() => {
  const el = document.querySelector('#danger-zone');
  const body = el?.parentElement;
  return !!body && body.lastElementChild === el;
});
if (!isLast) fail('the delete section is not the last thing in the Settings sheet');

// Reachable, not merely present. A section clipped below a scroll region that
// cannot reach it is the pre-match accordion bug all over again.
await zone.scrollIntoViewIfNeeded();
const reachable = await page.evaluate(() => {
  const r = document.querySelector('#btn-delete-account')?.getBoundingClientRect();
  return !!r && r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight + 1;
});
if (!reachable) fail('the delete button cannot be scrolled into the viewport');
ok('the delete section sits at the bottom of Settings and can be reached');

// ---- 2. Step one: the username, typed exactly ---------------------------
await page.click('#btn-delete-account');
await page.waitForSelector('#input-delete-confirm-name', { timeout: 4000 });

const continueDisabled = () => page.isDisabled('#btn-delete-account-continue');
if (!(await continueDisabled())) fail('Continue was enabled before the name was typed');

await page.fill('#input-delete-confirm-name', NAME.toLowerCase());
await page.waitForSelector('#btn-delete-account-continue', { timeout: 2000 });
if (!(await continueDisabled())) fail('a case-flipped username opened the confirmation');
const mismatch = await page.textContent('#delete-account-name-mismatch').catch(() => null);
if (!mismatch) fail('a wrong name gave no explanation');
ok('the name is compared exactly — a case-flipped one does not continue');

await page.fill('#input-delete-confirm-name', NAME);
if (await continueDisabled()) fail('the exact username did not enable Continue');
await page.click('#btn-delete-account-continue');

// ---- 3 & 4. The reminder IS the final confirmation, and BACK is a way out -
await page.waitForSelector('#delete-account-permanent-warning', { timeout: 4000 });
const warning = (await page.textContent('#delete-account-permanent-warning')) || '';
if (!warning.includes(NAME)) fail('the permanence reminder does not name the account it would delete');

const buttons = await page.$$eval('#danger-zone button', (els) => els.map((e) => e.id));
if (buttons.length !== 2) fail(`the final step offered ${buttons.length} buttons, not 2: ${buttons.join(', ')}`);
if (!buttons.includes('btn-delete-account-back')) fail('no BACK on the final step');
if (!buttons.includes('btn-delete-account-final')) fail('no DELETE on the final step');
ok('the reminder is the last word: exactly DELETE and BACK');

await page.click('#btn-delete-account-back');
// Back to the OPEN Settings panel — not a closed sheet, and not a
// confirmation left armed for whenever Settings is next opened.
await page.waitForSelector('#settings-modal-overlay', { timeout: 3000 });
await page.waitForSelector('#btn-delete-account', { timeout: 3000 });
if (await page.$('#delete-account-permanent-warning')) fail('BACK left the confirmation on screen');
const stillMine = await page.evaluate(() =>
  fetch('/api/profile/me').then((r) => r.json()).then((p) => p.username)
);
if (stillMine !== NAME) fail(`BACK cost the account: profile is now ${stillMine}`);
ok('BACK returns to the open Settings panel with the account intact');

// Closing Settings disarms the flow too, rather than leaving it waiting.
await page.click('#btn-delete-account');
await page.waitForSelector('#input-delete-confirm-name', { timeout: 4000 });
await page.click('#btn-close-settings');
await page.waitForSelector('#settings-modal-overlay', { state: 'detached', timeout: 4000 });
await openSettings(page);
if (await page.$('#input-delete-confirm-name')) fail('the flow was still armed after Settings was closed');
ok('closing Settings abandons the flow rather than banking it');

// ---- 5. DELETE spends the account --------------------------------------
await page.click('#btn-delete-account');
await page.fill('#input-delete-confirm-name', NAME);
await page.click('#btn-delete-account-continue');
await page.waitForSelector('#delete-account-permanent-warning', { timeout: 4000 });
await page.click('#btn-delete-account-final');

// The page reloads as a brand-new player, which is what deleting the account
// this browser holds has to leave behind.
await page.waitForSelector('#onboarding-modal-overlay', { timeout: 15000 })
  .catch(() => fail('deleting the account did not return the browser to onboarding'));
const after = await page.evaluate(() =>
  fetch('/api/profile/me').then((r) => r.json()).then((p) => ({ initialized: p.initialized }))
);
if (after.initialized) fail('the browser still holds an initialized profile after deleting it');
ok('DELETE spends the account and the browser comes back as a new player');

// And the name is genuinely back in the pool — for this browser and any other.
await page.fill('#input-onboarding-username', NAME);
await page.waitForSelector('#username-status-available', { timeout: 5000 })
  .catch(() => fail('the deleted username never came back into the pool'));
ok('the deleted username is free again');

if (pageErrors.length) fail(`page errors: ${pageErrors.join(' | ')}`);
console.log('\nALL ACCOUNT-DELETION E2E CHECKS PASSED');
await browser.close();
