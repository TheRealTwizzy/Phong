// Browser E2E for elite daily missions and the reroll allowances:
//   1. The hand is 5 regular + 1 elite, and the elite carries a permanent unlock.
//   2. Allowances are 5 regular + 1 elite, spent independently per tier.
//   3. Each runs out at its own limit and refuses further rerolls.
// Requires: `npm i --no-save playwright-core` + CHROMIUM_PATH. Target a running
// PRODUCTION server (NODE_ENV=production) with E2E_URL, fresh DATA_DIR.
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
await page.fill('#input-onboarding-username', `Elite${Date.now().toString(36).slice(-5)}`);
await page.waitForSelector('#username-status-available', { timeout: 6000 });
await page.click('#btn-onboarding-submit');
await page.waitForSelector('#main-menu-screen', { timeout: 10000 });

const api = (path, body) => page.evaluate(async ([p, b]) => {
  const r = await fetch(p, b ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) } : undefined);
  return { status: r.status, data: await r.json() };
}, [path, body]);

let m = await api('/api/missions');
if (m.data.missions.length !== 6) fail(`expected 6 missions, got ${m.data.missions.length}`);
const elites = m.data.missions.filter((x) => x.tier === 'elite');
if (elites.length !== 1) fail(`expected exactly 1 elite, got ${elites.length}`);
if (!elites[0].unlocks) fail('elite mission carries no permanent unlock');
ok(`hand is 5 regular + 1 elite; elite banks "${elites[0].unlocks}"`);
if (m.data.rerolls.regular !== 5 || m.data.rerolls.elite !== 1) {
  fail(`wrong allowance: ${JSON.stringify(m.data.rerolls)}`);
}
ok('allowance is 5 regular + 1 elite reroll');

// Spend a regular reroll.
const victim = m.data.missions.find((x) => x.tier === 'regular');
const r = await api('/api/missions/reroll', { missionId: victim.id });
if (r.status !== 200) fail(`reroll failed: ${r.status}`);
if (r.data.rerolls.regular !== 4 || r.data.rerolls.elite !== 1) fail('reroll spent the wrong tier');
if (r.data.missions.some((x) => x.id === victim.id)) fail('rerolled mission is still held');
if (new Set(r.data.missions.map((x) => x.id)).size !== 6) fail('reroll produced a duplicate');
ok('a regular reroll swaps the mission and spends only the regular allowance');

// Exhaust regular, then confirm elite is untouched and separately limited.
for (let i = 0; i < 4; i++) {
  const cur = (await api('/api/missions')).data.missions.find((x) => x.tier === 'regular');
  await api('/api/missions/reroll', { missionId: cur.id });
}
let after = await api('/api/missions');
if (after.data.rerolls.regular !== 0) fail(`regular should be spent: ${after.data.rerolls.regular}`);
if (after.data.rerolls.elite !== 1) fail('elite allowance was consumed by regular rerolls');
const denied = await api('/api/missions/reroll', { missionId: after.data.missions.find((x) => x.tier === 'regular').id });
if (denied.status !== 409 || denied.data.error !== 'NO_REROLLS') fail(`expected NO_REROLLS, got ${denied.status} ${denied.data.error}`);
ok('regular rerolls run out at 5 and refuse a sixth');

const eliteNow = after.data.missions.find((x) => x.tier === 'elite');
const er = await api('/api/missions/reroll', { missionId: eliteNow.id });
if (er.status !== 200) fail('elite reroll refused');
if (er.data.rerolls.elite !== 0) fail('elite allowance not spent');
const er2 = await api('/api/missions/reroll', { missionId: er.data.missions.find((x) => x.tier === 'elite').id });
if (er2.data.error !== 'NO_REROLLS') fail('a second elite reroll was allowed');
ok('the single elite reroll works once, then refuses');

// The elite theme is locked until banked.
const prof = (await api('/api/profile/me')).data;
if ((prof.eliteUnlocks || []).length !== 0) fail('a new profile already owns unlocks');
ok('a new profile owns no permanent unlocks');
if (errs.length) fail(`page errors: ${errs.join(' | ')}`);
console.log('\nELITE + REROLL CHECKS PASSED');
await browser.close();
