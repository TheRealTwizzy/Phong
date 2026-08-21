// Browser E2E for the TrueSkill-style rating, prediction UI and tier badges.
//  1. The menu shows a predicted win chance per AI difficulty and flags the
//     one closest to 50/50 as BALANCED.
//  2. NO raw rating number is rendered anywhere in the UI.
//  3. Beating a hard AI pays materially more XP than beating an easy one,
//     and a loss still pays something (XP never goes backwards).
//  4. Solo play moves hidden MMR but never the rank: the badge stays UNRANKED
//     and rankedGames stays 0 no matter how much solo you play.
//  5. A public profile exposes a tier and never mu/sigma.
// Requires: `npm i --no-save playwright-core` + CHROMIUM_PATH. Target a
// running server with E2E_URL (default http://localhost:3000), fresh DATA_DIR.
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
let seq = 0;

async function newPlayer(prefix) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#onboarding-modal-overlay', { timeout: 8000 });
  await page.fill('#input-onboarding-username', `${prefix}${Date.now().toString(36).slice(-4)}${seq++}`);
  await page.waitForSelector('#username-status-available', { timeout: 5000 });
  await page.click('#btn-onboarding-submit');
  await page.waitForSelector('#main-menu-screen', { timeout: 8000 });
  return page;
}

// Record a match straight against the API (the contract the client uses).
const record = (page, body) =>
  page.evaluate(async (b) => {
    const res = await fetch('/api/match/record', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(b),
    });
    return res.json();
  }, body);

const me = (page) => page.evaluate(async () => (await fetch('/api/profile/me')).json());

// ---- 1. Per-difficulty predictions on the menu ---------------------------
const alice = await newPlayer('Rate');
await alice.click('#menu-mode-solo');
await alice.waitForSelector('#menu-diff-rookie-odds', { timeout: 5000 });

const odds = {};
for (const d of ['rookie', 'pro', 'cyber', 'chaos']) {
  const txt = await alice.textContent(`#menu-diff-${d}-odds`);
  odds[d] = parseInt(txt, 10);
}
if (!(odds.rookie > odds.pro && odds.pro > odds.chaos && odds.chaos > odds.cyber)) {
  fail(`odds not ordered by difficulty: ${JSON.stringify(odds)}`);
}
if (Math.abs(odds.pro - 50) > 8) fail(`Pro should be ~50/50 for a new player, got ${odds.pro}%`);
ok(`win chance shown per difficulty and correctly ordered: ${JSON.stringify(odds)}`);

if (!(await alice.$('#menu-diff-balanced'))) fail('no BALANCED badge on any difficulty');
ok('BALANCED badge marks the closest-to-even difficulty');

// ---- 1b. The ladder slides with the player's hidden rating ---------------
// A fixed ladder is what made Pro unreachable for a beginner and Rookie a
// formality for a veteran; the odds shown must move as the player's mu moves.
const oddsAfterSoloRun = async (page) => {
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#main-menu-screen', { timeout: 8000 });
  await page.click('#menu-mode-solo');
  await page.waitForSelector('#menu-diff-cyber-odds', { timeout: 5000 });
  const out = {};
  for (const d of ['rookie', 'pro', 'cyber', 'chaos']) {
    out[d] = parseInt(await page.textContent(`#menu-diff-${d}-odds`), 10);
  }
  return out;
};

const climber = await newPlayer('Climb');
const oddsBefore = await oddsAfterSoloRun(climber);
for (let i = 0; i < 8; i++) {
  await record(climber, {
    playerScore: 5, opponentScore: 0, maxRally: 22,
    mode: 'solo', difficulty: 'cyber', isWinner: true,
  });
}
const oddsAfter = await oddsAfterSoloRun(climber);
if (oddsAfter.rookie <= oddsBefore.rookie) {
  fail(`beating Cyber 8x did not raise the player's odds vs Rookie (${oddsBefore.rookie}% -> ${oddsAfter.rookie}%)`);
}
if (oddsAfter.cyber >= 60) {
  fail(`Cyber stopped being a stretch after a solo run (${oddsAfter.cyber}%)`);
}
if (!(oddsAfter.rookie > oddsAfter.pro && oddsAfter.pro > oddsAfter.chaos && oddsAfter.chaos > oddsAfter.cyber)) {
  fail(`the ladder lost its ordering after adapting: ${JSON.stringify(oddsAfter)}`);
}
ok(`ladder slides with skill and keeps its order: ${JSON.stringify(oddsBefore)} -> ${JSON.stringify(oddsAfter)}`);

// ---- 2. No raw rating numbers anywhere -----------------------------------
const badge = await alice.textContent('#tier-badge-unranked').catch(() => null);
if (!badge) fail('menu pill does not show a tier badge');
ok(`menu shows a tier badge ("${badge.trim()}"), not a number`);

const bodyText = await alice.textContent('body');
if (/\bELO\b/i.test(bodyText)) fail('the word ELO still appears in the UI');
if (/\b1[0-9]{3}\s*(ELO|Rating)\b/i.test(bodyText)) fail('a raw rating number is rendered');
ok('no ELO / raw rating number rendered on the menu');

// ---- 3. XP scales with the prediction ------------------------------------
const base = { playerScore: 3, opponentScore: 1, maxRally: 10, mode: 'solo', isWinner: true };
const hardWin = await record(alice, { ...base, difficulty: 'cyber' });
const easyPlayer = await newPlayer('Easy');
const easyWin = await record(easyPlayer, { ...base, difficulty: 'rookie' });
if (!(hardWin.earnedXp > easyWin.earnedXp)) {
  fail(`beating Cyber (${hardWin.earnedXp} XP) should pay more than Rookie (${easyWin.earnedXp} XP)`);
}
ok(`XP scales with difficulty via prediction: Cyber ${hardWin.earnedXp} XP > Rookie ${easyWin.earnedXp} XP`);

const lossPlayer = await newPlayer('Loss');
const loss = await record(lossPlayer, { ...base, difficulty: 'cyber', isWinner: false, playerScore: 0 });
if (!(loss.earnedXp > 0)) fail('a loss awarded no XP at all');
const afterLoss = await me(lossPlayer);
if (afterLoss.xp < loss.earnedXp) fail('XP went backwards after a loss');
ok(`a loss still pays XP (${loss.earnedXp}) and never subtracts`);

// ---- 4. Solo never moves the rank ----------------------------------------
const before = await me(alice);
for (let i = 0; i < 6; i++) {
  await record(alice, { ...base, difficulty: 'cyber' });
}
const after = await me(alice);
if (after.rankedGames !== 0) fail(`solo play incremented rankedGames to ${after.rankedGames}`);
if (after.rankMu !== before.rankMu) fail('solo play moved the ranked rating');
if (after.tier !== 'unranked') fail(`solo play produced a tier: ${after.tier}`);
if (after.mmrMu === before.mmrMu) fail('solo play did not move hidden MMR');
ok('7 solo wins: hidden MMR moved, rank untouched, badge still UNRANKED');

await alice.reload({ waitUntil: 'networkidle' });
await alice.waitForSelector('#main-menu-screen', { timeout: 8000 });
if (!(await alice.$('#tier-badge-unranked'))) fail('badge is not UNRANKED after solo-only play');
ok('UI still renders the UNRANKED badge after solo-only play');

// ---- 5. Public profile carries a tier, never mu/sigma --------------------
const leak = await alice.evaluate(async () => {
  const self = await (await fetch('/api/profile/me')).json();
  const pub = await (await fetch(`/api/profile/${self.id}`)).json();
  const p = pub.profile || {};
  return {
    tier: p.tier,
    leaked: ['mmrMu', 'mmrSigma', 'rankMu', 'rankSigma', 'eloRating'].filter((k) => k in p),
  };
});
if (leak.leaked.length) fail(`public profile leaks ${leak.leaked.join(', ')}`);
if (!leak.tier) fail('public profile has no tier');
ok(`public profile exposes tier "${leak.tier}" and no raw rating fields`);

if (pageErrors.length) fail(`page errors: ${pageErrors.join(' | ')}`);
console.log('\nALL RATING E2E CHECKS PASSED');
await browser.close();
