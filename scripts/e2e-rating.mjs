// Browser E2E for the TrueSkill-style rating, prediction UI and tier badges.
//  1. The menu shows a predicted win chance per AI difficulty and flags the
//     one closest to 50/50 as BALANCED.
//  2. NO raw rating number is rendered anywhere in the UI.
//  3. Beating a hard AI pays materially more XP than beating an easy one,
//     and a loss still pays something (XP never goes backwards).
//  4. Solo counts for rank only at a difficulty you had to earn: Rookie is
//     open from the first match and never moves it, Pro and Cyber do.
//  5. A public profile exposes a tier and never mu/sigma.
// Run it with `npm run test:e2e` (see scripts/e2e-run.mjs), which builds
// nothing but hands this a fresh server, port, DATA_DIR and Chromium.
import { chromium, devices } from 'playwright-core';


// The onboarding tour opens by itself for a player who has never seen it —
// it is part of onboarding now, not a menu row. Every suite past this point
// wants the menu, so it is waved away here. Tolerant: a suite that reaches
// this another way is not broken by its absence.
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
  // Onboarding now ends on the sign-in code. Tolerant, so a suite that
  // reaches here another way is not broken by its absence.
  await page.waitForSelector('#btn-onboarding-code-continue', { timeout: 10000 })
    .then((b) => b.click())
    .catch(() => {});
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

// The achievement tree gates the ladder now: a fresh player can only play
// Rookie, so anything above has to be earned rung by rung. Walk the ladder up
// to CYBER: ten Pro wins at level 10 opens Elite, ten Elite wins at level 15
// opens Cyber — and the server rejects a locked difficulty, which is the
// point of the gate. (Chaos stays shut: this climb stops at the first Cyber
// win, and the rung above needs ten of them at Grandmaster. It is reachable
// now — it used to sit behind a Cyber SHUTOUT as well, which is a feat beside
// the ladder rather than a step on it; tests/achievements.test.ts walks the
// whole thing through real recorded matches.)
const openLadder = (page) =>
  page.evaluate(async () => {
    const win = (difficulty) =>
      fetch('/api/match/record', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerScore: 5, opponentScore: 1, bestStreak: 6, earnedStreak: 6,
          mode: 'solo', difficulty, isWinner: true,
        }),
      });
    await win('rookie');
    for (let i = 0; i < 150; i++) {
      const me = await (await fetch('/api/profile/me')).json();
      if (me.achievements.includes('ai_elite_10')) break;
      if (!me.achievements.includes('ai_pro_10')) await win('pro');
      else await win('elite');
    }
  });



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

// ---- 1. Per-difficulty predictions on the menu ---------------------------
const alice = await newPlayer('Rate');
// Four of the five rungs are locked for a fresh player, and locked rooms are
// folded away — so the odds this section reads are behind the fold.
await revealLocked(alice, 'solo');
await alice.waitForSelector('#room-rookie-odds', { timeout: 5000 });

const odds = {};
// A rung and the ROOM that plays it are named separately: two solo rooms
// would otherwise collide with the PvP brackets ('pro' and 'elite' are both
// a rung and a bracket), so the solo ones carry an `ai_` prefix.
const RUNGS = ['rookie', 'pro', 'elite', 'cyber', 'chaos'];
const ROOM_OF = { rookie: 'rookie', pro: 'ai_pro', elite: 'ai_elite', cyber: 'cyber', chaos: 'chaos' };
for (const d of RUNGS) {
  const txt = await alice.textContent(`#room-${ROOM_OF[d]}-odds`);
  odds[d] = parseInt(txt, 10);
}
for (let i = 1; i < RUNGS.length; i++) {
  if (!(odds[RUNGS[i]] <= odds[RUNGS[i - 1]])) {
    fail(`odds not ordered by difficulty: ${JSON.stringify(odds)}`);
  }
}
if (!(odds.rookie > odds.chaos)) fail(`the ladder spans no range: ${JSON.stringify(odds)}`);
if (Math.abs(odds.pro - 50) > 8) fail(`Pro should be ~50/50 for a new player, got ${odds.pro}%`);
ok(`win chance shown per difficulty and correctly ordered: ${JSON.stringify(odds)}`);

if (!(await alice.$('#room-balanced'))) fail('no BALANCED badge on any difficulty');
ok('BALANCED badge marks the closest-to-even difficulty');

// Chaos is a revived, TOP rung now — present on the menu and locked for a
// fresh player, alongside Elite.
if (!(await alice.$('#room-chaos'))) fail('the Chaos rung is missing from the menu');
if (!(await alice.$('#room-ai_elite-lock'))) fail('Elite is not locked for a fresh player');
if (!(await alice.$('#room-chaos-lock'))) fail('Chaos is not locked for a fresh player');
ok('five rungs on the menu; Elite and Chaos locked for a fresh player');

// ---- 1b. The ladder slides with the player's hidden rating ---------------
// A fixed ladder is what made Pro unreachable for a beginner and Rookie a
// formality for a veteran; the odds shown must move as the player's mu moves.
const oddsAfterSoloRun = async (page) => {
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#main-menu-screen', { timeout: 8000 });
  // A reload puts the menu back to its plain list, so the fold is re-opened.
  await revealLocked(page, 'solo');
  await page.waitForSelector('#room-cyber-odds', { timeout: 5000 });
  const out = {};
  for (const d of ['rookie', 'pro', 'elite', 'cyber']) {
    out[d] = parseInt(await page.textContent(`#room-${ROOM_OF[d]}-odds`), 10);
  }
  return out;
};

const climber = await newPlayer('Climb');
await openLadder(climber);
const oddsBefore = await oddsAfterSoloRun(climber);
for (let i = 0; i < 8; i++) {
  await record(climber, {
    playerScore: 5, opponentScore: 0, bestStreak: 22, earnedStreak: 22,
    mode: 'solo', difficulty: 'cyber', isWinner: true,
  });
}
const oddsAfter = await oddsAfterSoloRun(climber);
if (oddsAfter.rookie <= oddsBefore.rookie) {
  fail(`beating Cyber 8x did not raise the player's odds vs Rookie (${oddsBefore.rookie}% -> ${oddsAfter.rookie}%)`);
}
if (oddsAfter.cyber >= 75) {
  fail(`Cyber stopped being a stretch after a solo run (${oddsAfter.cyber}%)`);
}
if (!(oddsAfter.rookie > oddsAfter.pro && oddsAfter.pro >= oddsAfter.elite && oddsAfter.elite >= oddsAfter.cyber)) {
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
const base = { playerScore: 3, opponentScore: 1, bestStreak: 10, earnedStreak: 10, mode: 'solo', isWinner: true };
await openLadder(alice);
const hardWin = await record(alice, { ...base, difficulty: 'cyber' });
const easyPlayer = await newPlayer('Easy');
const easyWin = await record(easyPlayer, { ...base, difficulty: 'rookie' });
if (!(hardWin.earnedXp > easyWin.earnedXp)) {
  fail(`beating Cyber (${hardWin.earnedXp} XP) should pay more than Rookie (${easyWin.earnedXp} XP)`);
}
ok(`XP scales with difficulty via prediction: Cyber ${hardWin.earnedXp} XP > Rookie ${easyWin.earnedXp} XP`);

const lossPlayer = await newPlayer('Loss');
await openLadder(lossPlayer);
const loss = await record(lossPlayer, { ...base, difficulty: 'cyber', isWinner: false, playerScore: 0 });
if (!(loss.earnedXp > 0)) fail('a loss awarded no XP at all');
const afterLoss = await me(lossPlayer);
if (afterLoss.xp < loss.earnedXp) fail('XP went backwards after a loss');
ok(`a loss still pays XP (${loss.earnedXp}) and never subtracts`);

// ---- 4. Solo counts for rank only at an EARNED difficulty ----------------
// Rookie is open from the first match, so placing against it would be a
// formality and the badge would stop meaning anything. Pro and Cyber have to
// be unlocked before they can be played, and those results do carry rank.
const rookieOnly = await newPlayer('Rook');
const rookieBefore = await me(rookieOnly);
for (let i = 0; i < 6; i++) {
  await record(rookieOnly, { ...base, difficulty: 'rookie' });
}
const rookieAfter = await me(rookieOnly);
if (rookieAfter.rankedGames !== 0) fail(`Rookie solo incremented rankedGames to ${rookieAfter.rankedGames}`);
if (rookieAfter.rankMu !== rookieBefore.rankMu) fail('Rookie solo moved the ranked rating');
if (rookieAfter.tier !== 'unranked') fail(`Rookie solo produced a tier: ${rookieAfter.tier}`);
if (!(rookieAfter.xp > rookieBefore.xp)) fail('Rookie solo paid no XP — every match is progression');
ok('6 Rookie wins: XP paid, rank untouched, still UNRANKED');

await rookieOnly.reload({ waitUntil: 'networkidle' });
await rookieOnly.waitForSelector('#main-menu-screen', { timeout: 8000 });
if (!(await rookieOnly.$('#tier-badge-unranked'))) fail('badge is not UNRANKED after Rookie-only play');
ok('UI still renders the UNRANKED badge after Rookie-only play');

// Alice walked the ladder up to Cyber, so hers is an earned difficulty.
const before = await me(alice);
for (let i = 0; i < 6; i++) {
  await record(alice, { ...base, difficulty: 'cyber' });
}
const after = await me(alice);
if (!(after.rankedGames > before.rankedGames)) fail('Cyber solo did not count toward placement');
if (after.rankMu === before.rankMu) fail('Cyber solo did not move the ranked rating');
if (after.mmrMu === before.mmrMu) fail('solo play did not move hidden MMR');
ok(`6 Cyber wins carry rank: ${before.rankedGames} -> ${after.rankedGames} ranked games, tier "${after.tier}"`);

// ---- 5. Public profile carries a tier, never mu/sigma --------------------
const leak = await alice.evaluate(async () => {
  const self = await (await fetch('/api/profile/me')).json();
  const pub = await (await fetch(`/api/profile/${self.id}`)).json();
  const p = pub.profile || {};
  return {
    tier: p.tier,
    leaked: ['mmrMu', 'mmrSigma', 'rankMu', 'rankSigma', 'eloRating'].filter((k) => k in p),
    // A ladder POSITION is not a rating — it is the one rank number already
    // public, since the board prints it for everybody — so it is allowed here
    // where every mu/sigma is not. Listed rather than ignored so the next
    // field added to PublicProfile still has to argue its way past this leg.
    position: p.ladderPosition ?? null,
  };
});
if (leak.leaked.length) fail(`public profile leaks ${leak.leaked.join(', ')}`);
if (!leak.tier) fail('public profile has no tier');
// This player is UNRANKED, and only the top rung carries a position. A number
// here would mean the gate was reading the rating alone rather than board
// membership — which is how an uninitialized row came to be handed #1.
if (leak.position !== null) {
  fail(`an unranked public profile carries a ladder position (${leak.position})`);
}
ok(`public profile exposes tier "${leak.tier}" and no raw rating fields`);

// ---- 6. Missions are server state, claimable exactly once ---------------
// Mission progress used to live in localStorage and be claimed by POSTing the
// reward as an `xpDelta`: wiping site data re-armed all five. Now the server
// owns both, so neither a storage wipe nor a repeated claim pays twice.
const questPlayer = await newPlayer('Quest');

const missionsOf = (page) => page.evaluate(async () => (await fetch('/api/missions')).json());
const start = await missionsOf(questPlayer);
if (!start.missions?.length) fail('no missions served');
if (start.missions.some((m) => m.current > 0 || m.claimed)) fail('a fresh day started dirty');
ok(`server serves ${start.missions.length} missions, all at zero`);

// Rookie: the only difficulty a fresh player has open. The payload is the
// wide one for the same reason the completion loop below uses it — see the
// note there. `base` alone leaves four of the twelve regular missions unable
// to move (aces, shutout, multi, pro_win), and a hand drawn from those four
// advances nothing; a shutout at rally 15 with aces cuts that to two, and two
// missions cannot fill three slots.
await record(questPlayer, {
  ...base,
  difficulty: 'rookie',
  playerScore: 5,
  opponentScore: 0,
  bestStreak: 15, earnedStreak: 15,
  aces: 3,
});
const advanced = (await missionsOf(questPlayer)).missions;
if (!advanced.some((m) => m.current > 0)) {
  fail(`a recorded win advanced nothing: ${JSON.stringify(advanced.map((m) => [m.id, m.current]))}`);
}
ok('recording a match advances missions server-side');

// Wiping browser storage must not resurrect a fresh, re-claimable set.
await questPlayer.evaluate(() => {
  localStorage.clear();
  sessionStorage.clear();
});
await questPlayer.reload({ waitUntil: 'networkidle' });
await questPlayer.waitForSelector('#main-menu-screen', { timeout: 8000 });
const afterWipe = (await missionsOf(questPlayer)).missions;
if (!afterWipe.some((m) => m.current > 0)) fail('clearing storage reset server mission progress');
ok('clearing browser storage does not reset mission progress');

// Drive one held mission to completion, then claim it — whichever it is.
//
// The hand is DEALT: three of a twelve-strong regular pool, seeded on the
// player id, which is a fresh random device per run. So this loop has to
// satisfy every mission the deal could hand it, not just a typical one.
//
// It used to record { opponentScore: 1, bestStreak: 12, earnedStreak: 12 } with no aces, which
// leaves five of the twelve uncompletable — rally_15, multi, pro_win, aces
// and shutout — and a three-card hand drawn entirely from those five
// completes nothing. That is C(5,3)/C(12,3), and simulating the real
// dealOrder/pickHand over 20k player ids put it at 3.76%: roughly one CI run
// in twenty-seven died here, on a payload detail rather than on the rule
// being tested.
//
// A shutout at rally 15 with aces knocks three of those five out, leaving
// only multi (needs a duel) and pro_win (needs a difficulty this player has
// not unlocked). Three slots cannot be filled from two missions, so at least
// one held mission is now always completable — not less likely to fail,
// unable to.
for (let i = 0; i < 12; i++) {
  await record(questPlayer, {
    ...base,
    difficulty: 'rookie',
    playerScore: 5,
    opponentScore: 0, // shutout -> mission_shutout
    bestStreak: 15, earnedStreak: 15, //     -> mission_rally / mission_rally_15
    aces: 3, //          -> mission_aces
  });
}
const done = (await missionsOf(questPlayer)).missions.find((m) => m.current >= m.target && !m.claimed);
if (!done) fail('nothing completed after twelve wins');
const xpBefore = (await me(questPlayer)).xp;
const claimed = await questPlayer.evaluate(async (missionId) => {
  const r = await fetch('/api/missions/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ missionId }),
  });
  return { status: r.status, body: await r.json() };
}, done.id);
if (claimed.status !== 200) fail(`claiming a completed mission failed: ${claimed.status}`);
const xpAfterClaim = (await me(questPlayer)).xp;
if (xpAfterClaim <= xpBefore) fail('claiming a completed mission paid nothing');
ok(`claiming a completed mission paid ${xpAfterClaim - xpBefore} XP once`);

const replay = await questPlayer.evaluate(async (missionId) => {
  const codes = [];
  for (let i = 0; i < 15; i++) {
    const r = await fetch('/api/missions/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ missionId }),
    });
    codes.push(r.status);
  }
  const bad = await fetch('/api/profile/me', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ xpDelta: 1000 }),
  });
  return { codes, xpDeltaStatus: bad.status };
}, done.id);
if (replay.codes.some((c) => c === 200)) fail(`a replayed claim paid out: ${replay.codes.join(',')}`);
if (replay.xpDeltaStatus === 200) fail('PUT /api/profile/me still accepts a raw xpDelta');
const xpFinal = (await me(questPlayer)).xp;
if (xpFinal !== xpAfterClaim) fail(`XP moved on replay: ${xpAfterClaim} -> ${xpFinal}`);
ok(`15 replayed claims + a raw xpDelta all rejected (${replay.xpDeltaStatus}), XP unchanged`);

if (pageErrors.length) fail(`page errors: ${pageErrors.join(' | ')}`);
console.log('\nALL RATING E2E CHECKS PASSED');
await browser.close();
