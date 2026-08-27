// Browser E2E for elite daily missions and the reroll allowances:
//   1. The hand is the dealt slot counts, and the elite carries a permanent unlock.
//   2. Allowances are 5 regular + 1 elite, spent independently per tier.
//   3. Each runs out at its own limit and refuses further rerolls.
// Run it with `npm run test:e2e` (see scripts/e2e-run.mjs), which builds
// nothing but hands this a fresh server, port, DATA_DIR and Chromium.
import fs from 'node:fs';
import { chromium, devices } from 'playwright-core';


// The onboarding tour opens by itself for a player who has never seen it —
// it is part of onboarding now, not a menu row. Every suite past this point
// wants the menu, so it is waved away here. Tolerant: a suite that reaches
// this another way is not broken by its absence.
// The hand size is a product decision that has already moved once (5 regular
// down to 3). Read it from the module that decides it rather than restating
// it here, so tuning the slots does not leave this suite red over a number it
// was never testing.
const missionsSrc = fs.readFileSync(new URL('../src/game/missions.ts', import.meta.url), 'utf8');
const slotCount = (name) => {
  const m = missionsSrc.match(new RegExp(`export const ${name} = (\\d+);`));
  if (!m) throw new Error(`could not read ${name} from src/game/missions.ts`);
  return Number(m[1]);
};
const REGULAR_SLOTS = slotCount('REGULAR_SLOTS');
const ELITE_SLOTS = slotCount('ELITE_SLOTS');
const HAND = REGULAR_SLOTS + ELITE_SLOTS;

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
// Onboarding now ends on the sign-in code. Tolerant, so a suite that
// reaches here another way is not broken by its absence.
await page.waitForSelector('#btn-onboarding-code-continue', { timeout: 10000 })
  .then((b) => b.click())
  .catch(() => {});
await page.waitForSelector('#main-menu-screen', { timeout: 10000 });

const api = (path, body) => page.evaluate(async ([p, b]) => {
  const r = await fetch(p, b ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) } : undefined);
  return { status: r.status, data: await r.json() };
}, [path, body]);

let m = await api('/api/missions');
if (m.data.missions.length !== HAND) fail(`expected ${HAND} missions, got ${m.data.missions.length}`);
const elites = m.data.missions.filter((x) => x.tier === 'elite');
if (elites.length !== ELITE_SLOTS) fail(`expected exactly ${ELITE_SLOTS} elite, got ${elites.length}`);
if (!elites[0].unlocks) fail('elite mission carries no permanent unlock');
ok(`hand is ${REGULAR_SLOTS} regular + ${ELITE_SLOTS} elite; elite banks "${elites[0].unlocks}"`);
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
if (new Set(r.data.missions.map((x) => x.id)).size !== HAND) fail('reroll produced a duplicate');
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
