#!/usr/bin/env node
// which-suites.mjs — which browser E2E suites does THIS change actually need?
//
// `npm run test:e2e` runs eighteen suites, each with its own server, port,
// DATA_DIR and Chromium. That is minutes, and it is the reason the honest
// options today are "run everything" or "run nothing and hope". Neither is
// what you want after a two-line fix to the reaper.
//
// So: map the changed files onto the flows that could plausibly break, and
// print the command. The map below is a claim about this repo, and like any
// claim it can be wrong — which is why an unmapped source file WIDENS to the
// full run rather than narrowing to none. Being slow is a cost; being quiet
// about a broken flow is a bug. If you hit the fallback, add a rule.
//
//   node .claude/skills/phong-ship-check/scripts/which-suites.mjs
//   node .claude/skills/phong-ship-check/scripts/which-suites.mjs origin/main
//   node .claude/skills/phong-ship-check/scripts/which-suites.mjs --all
//
// Advisory only: it always exits 0. It decides nothing on its own.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

// --- the suites that exist, read from the runner rather than duplicated ----
// e2e-run.mjs owns the list. Parsing it means a suite added there cannot go
// missing here, and a typo in the map below is caught rather than silently
// producing a command that fails with "Unknown suite".
function knownSuites() {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/e2e-run.mjs'), 'utf8');
  const block = src.slice(src.indexOf('const SUITES = ['), src.indexOf('];', src.indexOf('const SUITES = [')));
  return [...block.matchAll(/name:\s*'([a-z-]+)'/g)].map((m) => m[1]);
}

// --- the map -------------------------------------------------------------
// Each rule: what it matches, which flows it puts at risk, and why. The
// `why` is printed, so a suite never shows up in the list without saying
// what it is doing there — otherwise the honest response to a long list is
// to ignore it.
const RULES = [
  { re: /^src\/types\.ts$/, suites: ['gameplay', 'duel', 'spectate', 'queue', 'eject'],
    why: 'the protocol union — every transport reads its shapes from here' },
  { re: /^src\/net\/p2p\.ts$/, suites: ['gameplay', 'duel'],
    why: 'the DataChannel replica; e2e-gameplay is the only place a real P2P link comes up' },
  // server.ts is the relay AND the whole REST API in one file, so a
  // file-granular rule cannot tell which half moved. The relay-flow subset it
  // used to name missed every route-driven suite: e2e-elite drives
  // /api/missions/reroll, and rating/rules/achievements/history/profiles all
  // POST /api/match/record or /api/practice/record. Same reasoning as App.tsx.
  { re: /^server\.ts$/, suites: ['*'],
    why: 'the relay and every REST route in one file — no subset can be right' },
  { re: /^server\/room\.ts$/, suites: ['duel', 'lobby', 'spectate', 'queue', 'eject'],
    why: 'room rules, seats and the reaper' },
  { re: /^server\/matchmaking\.ts$/, suites: ['queue'], why: 'who the ranked queue pairs' },
  { re: /^server\/transform\.ts$/, suites: ['gameplay'], why: 'the cross-net mirror both phones depend on' },
  { re: /^server\/auth\.ts$/, suites: ['profiles', 'invite', 'delete', 'build-id'],
    why: 'device cookies and sessions — every identity flow' },
  { re: /^server\/build\.ts$/, suites: ['build-id'], why: 'the deploy-refresh promise' },
  { re: /^server\/db\.ts$/, suites: ['history', 'rating', 'achievements', 'elite', 'delete'],
    why: 'recordMatch derives ratings, counters, missions and history from here' },
  { re: /^server\/image\.ts$/, suites: ['profiles'], why: 'avatar validation' },
  { re: /^server\/bots\.ts$/, suites: ['rating'], why: 'the seeded roster the leaderboard shows' },
  { re: /^server\/admin\.ts$/, suites: [], why: 'the read-only support CLI — bundled beside the server, never served to a player' },

  { re: /^src\/rating\.ts$/, suites: ['rating', 'achievements'], why: 'tiers, prediction, XP' },
  { re: /^src\/achievements\.ts$/, suites: ['achievements', 'elite'], why: 'the tree and the unlocks it gates' },
  { re: /^src\/matchRules\.ts$/, suites: ['rules', 'duel'], why: 'ranked bands and the pre-match badge' },
  { re: /^src\/venues\.ts$/, suites: ['venues', 'queue'], why: 'the bracket predicate the menu draws and the relay enforces' },
  { re: /^src\/profileRules\.ts$/, suites: ['profiles', 'delete'], why: 'username rules, shared both sides' },
  { re: /^src\/device\.ts$/, suites: ['profiles'], why: 'the smartphone gate every suite has to get past' },
  { re: /^src\/game\/physics\.ts$/, suites: ['gameplay', 'rules', 'split'], why: 'ball, collisions, serve aim, AI' },
  { re: /^src\/game\/streaks\.ts$/, suites: ['streak', 'rules'], why: 'the run carried between matches' },
  { re: /^src\/game\/themes\.ts$/, suites: ['elite'], why: 'elite missions bank theme unlocks' },
  { re: /^src\/game\/missions\.ts$/, suites: ['elite'], why: 'the dealt hand and the reroll allowances' },
  { re: /^src\/net\/session\.ts$/, suites: ['profiles', 'invite', 'build-id'], why: 'the heartbeat and the blocking states' },
  { re: /^src\/net\/matchRecord\.ts$/, suites: ['rating', 'history'], why: 'the POST and the on-device replay queue' },
  { re: /^src\/net\/runChain\.ts$/, suites: ['streak'], why: 'run ordering across writes' },
  { re: /^src\/net\/useQuickMatch\.ts$/, suites: ['queue'], why: 'the queue client' },
  { re: /^src\/media\/avatar\.ts$/, suites: ['profiles'], why: 'the client crop/resize pipeline' },
  { re: /^src\/media\/qr\.ts$/, suites: [], why: 'pinned exactly by tests/qr.test.ts; no browser flow depends on it' },
  { re: /^src\/i18n\//, suites: [], why: 'tests/i18n.test.ts states this completely — the browser adds nothing' },
  { re: /^src\/audio\//, suites: [], why: 'procedural audio; no suite asserts sound' },

  // App.tsx is not a component among components: it is the whole controller —
  // both screens, every socket handler, the game loop, the match lifecycle and
  // the state every modal reads. Naming a subset here is guessing which flows a
  // 4,000-line controller touches, and the honest answer is all of them.
  { re: /^src\/App\.tsx$/, suites: ['*'],
    why: 'the controller — every screen, socket handler, match lifecycle and modal reads from it' },
  { re: /^src\/components\/CourtCanvas\.tsx$/,
    suites: ['achievements', 'duel', 'eject', 'gameplay', 'history', 'lobby', 'queue', 'rules', 'spectate', 'streak', 'venues'],
    why: 'the court, the joystick, the indicators — every suite that reaches a match' },
  // 16 of 18 suites drive an id this file defines: every one of them starts at
  // the menu and launches its mode from here. A subset is fiction.
  { re: /^src\/components\/MainMenu\.tsx$/, suites: ['*'], why: 'the menu every suite launches its mode from' },
  { re: /^src\/components\/MultiplayerLobby\.tsx$/,
    suites: ['duel', 'eject', 'gameplay', 'history', 'invite', 'lobby', 'profiles', 'queue', 'spectate', 'venues'],
    why: 'the lobby, the table browser and the invite box' },
  { re: /^src\/components\/MatchRulesPanel\.tsx$/, suites: ['rules', 'duel'], why: 'the shared rules panel, solo sheet and duel lobby' },
  { re: /^src\/components\/SplitScreenMatch\.tsx$/, suites: ['split'], why: 'two thumbs on one device' },
  // Literally every suite onboards before it can touch anything else.
  { re: /^src\/components\/OnboardingModal\.tsx$/, suites: ['*'], why: 'every suite onboards before it can do anything' },
  { re: /^src\/components\/SettingsModal\.tsx$/, suites: ['delete', 'rules'], why: 'account deletion at the bottom of the sheet, and the device preferences above it' },
  { re: /^src\/components\/SessionGuard\.tsx$/, suites: ['gameplay', 'invite', 'build-id'], why: 'the released/superseded/stale-build walls' },
  { re: /^src\/components\/MatchHistory/, suites: ['history'], why: 'tabs, filters and paging' },
  { re: /^src\/components\/(Missions|Achievement)/, suites: ['elite', 'achievements'], why: 'the tasks sheet and the tree' },
  { re: /^src\/components\/MobileGatekeeper\.tsx$/, suites: ['gameplay', 'profiles'], why: 'the gate in front of every suite' },
  { re: /^src\/components\/(Leaderboard|Profile|PublicProfile|TierBadge|AvatarImage)/, suites: ['profiles', 'rating', 'history'], why: 'identity surfaces' },
  { re: /^src\/components\/(ScoreBoard|StatsOverlay|QuickChat|RadarPreview)/,
    suites: ['achievements', 'duel', 'gameplay', 'history', 'lobby', 'profiles', 'queue', 'rules', 'spectate', 'streak'],
    why: 'in-match HUD — read by every suite that watches a score' },
  // The shared primitives sit under every modal and every sheet in the app, so
  // there is no subset: --verify found SegmentedControl alone driven by five
  // suites. Sheet's scroll/clipping is what put a Start button 160px below the
  // viewport once, and that was reachable from any flow that opens a sheet.
  { re: /^src\/components\/ui\//, suites: ['*'],
    why: 'shared primitives under every modal and sheet in the app' },

  { re: /^src\/(main\.tsx|index\.css|vite-env\.d\.ts)$/, suites: ['gameplay', 'venues'], why: 'app shell and base styles' },
  { re: /^index\.html$/, suites: ['build-id', 'profiles'], why: 'the document that sets the device cookie, and the hashed build id' },
  { re: /^(vite\.config\.ts|tsconfig\.json|package(-lock)?\.json)$/, suites: ['*'], why: 'build or dependency change — nothing is safely excluded' },

  // A browser suite is not shipped to a player, but editing one and running
  // nothing is the gate failing at its own job: a broken selector or a syntax
  // error in scripts/e2e-queue.mjs survives a clean "no browser suite needed".
  // `null` means "resolve the suite from the filename"; the shared runner and
  // anything else under scripts/ widen, since a helper serves all of them.
  { re: /^scripts\/e2e-(?!run\b)[a-z-]+\.mjs$/, suites: null, why: 'this suite itself changed' },
  { re: /^scripts\/e2e-run\.mjs$/, suites: ['*'], why: 'the shared runner every suite is launched by' },
  { re: /^(scripts|tests|deploy|\.github|\.claude)\//, suites: [], why: 'not shipped to a player' },
  { re: /\.(md|yml|yaml|example)$|^(Dockerfile|docker-compose\.yml|render\.yaml|\.nvmrc|\.gitignore|\.dockerignore)$/, suites: [], why: 'docs / infra' },
];

// --- resolving a rule ----------------------------------------------------
/**
 * The suites one file selects: an explicit list, the '*' sentinel, or — for a
 * rule carrying `suites: null` — the suite named by the file itself.
 */
function suitesForFile(file) {
  const rule = RULES.find((r) => r.re.test(file));
  if (!rule) return { rule: null, suites: null, unknown: true };
  if (rule.suites === null) {
    const named = file.match(/e2e-([a-z-]+)\.mjs$/);
    return { rule, suites: named ? [named[1]] : [] };
  }
  return { rule, suites: rule.suites };
}

// --- changed files -------------------------------------------------------
const git = (args) => {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};

// Returns what to diff against, and how. Three-dot ("what this branch added")
// is what you want, but it needs a merge base — and these checkouts are often
// SHALLOW, where merge-base simply fails. Falling back to a two-dot tree
// compare keeps the tool working there; it can over-report when the base has
// moved on, which is the safe direction.
function resolveBase(explicit) {
  const candidates = explicit ? [explicit] : ['origin/main', 'main'];
  for (const ref of candidates) {
    if (!git(['rev-parse', '--verify', '--quiet', ref])) continue;
    if (git(['merge-base', 'HEAD', ref])) return { label: ref, spec: `${ref}...HEAD` };
    return { label: `${ref} (no merge base — shallow clone, comparing trees)`, spec: ref };
  }
  // A base the caller NAMED and git cannot resolve is an error, not a reason to
  // quietly fall back. Degrading to uncommitted-only would answer a misspelled
  // ref with "Nothing to run" on a branch full of committed changes — the one
  // output this script must never produce when it has not actually looked.
  if (explicit) {
    console.error(`error: cannot resolve base ref "${explicit}" — check the name, or fetch it first.`);
    process.exit(2);
  }
  return { label: 'HEAD (uncommitted only)', spec: null };
}

function changedFiles({ spec }) {
  const committed = spec ? git(['diff', '--name-only', spec]).split('\n') : [];
  // Uncommitted work counts: the whole point is to run this BEFORE committing.
  // Deliberately NOT `status --porcelain` — its two-column status prefix has to
  // be sliced off, and slicing a trimmed first line silently eats a character
  // off one path per run ("erver/room.ts"). These two ask for paths directly.
  const dirty = git(['diff', '--name-only', 'HEAD']).split('\n');
  const untracked = git(['ls-files', '--others', '--exclude-standard']).split('\n');
  return [...new Set([...committed, ...dirty, ...untracked].filter(Boolean))].sort();
}

// --- decide --------------------------------------------------------------
const argv = process.argv.slice(2);
const ALL = knownSuites();

if (argv.includes('--all')) {
  console.log(`All ${ALL.length} suites:\n  npm run test:e2e`);
  process.exit(0);
}

// --verify: check the map against what the suites actually drive.
//
// The map is a claim, and a hand-written claim about eighteen suites drifts —
// it drifted three times in this file's first day, always in the direction of
// selecting too few. This derives a FLOOR from evidence rather than memory:
// every `#id` a suite drives, resolved to the source files that define it. A
// rule that omits a suite the derivation found is reported.
//
// It is a floor, not the map. It sees DOM coupling only, so a file a suite
// depends on behaviourally will not appear — that is what the reasoned `why`
// on each rule is for. Widening past the floor is always allowed; falling
// below it is the bug.
if (argv.includes('--verify')) {
  const suiteFiles = fs
    .readdirSync(path.join(ROOT, 'scripts'))
    .filter((f) => /^e2e-(?!run\b)[a-z-]+\.mjs$/.test(f));
  const srcFiles = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(e.name)) srcFiles.push(full);
    }
  };
  walk(path.join(ROOT, 'src'));
  const srcText = new Map(srcFiles.map((f) => [path.relative(ROOT, f), fs.readFileSync(f, 'utf8')]));

  const floor = new Map(); // relative src path -> Set(suite)
  for (const f of suiteFiles) {
    const suite = f.slice('e2e-'.length, -'.mjs'.length);
    const body = fs.readFileSync(path.join(ROOT, 'scripts', f), 'utf8');
    const ids = new Set([...body.matchAll(/#([a-z][a-z0-9-]{3,})/g)].map((m) => m[1]));
    for (const id of ids) {
      const quoted = new RegExp(`['"\`]${id}['"\`]`);
      for (const [rel, text] of srcText) {
        if (!quoted.test(text)) continue;
        if (!floor.has(rel)) floor.set(rel, new Set());
        floor.get(rel).add(suite);
      }
    }
  }

  let gaps = 0;
  for (const [file, needed] of [...floor].sort()) {
    const { suites, unknown } = suitesForFile(file);
    if (unknown) {
      console.log(`  ${file}\n      no rule covers it, but ${[...needed].sort().join(' ')} drive it`);
      gaps++;
      continue;
    }
    if (suites.includes('*')) continue;
    const missing = [...needed].filter((x) => !suites.includes(x)).sort();
    if (!missing.length) continue;
    console.log(`  ${file}\n      selects ${suites.join(' ')}\n      but these also drive it: ${missing.join(' ')}`);
    gaps++;
  }
  if (gaps) {
    console.log(`\n${gaps} rule(s) below the derived floor. Widen them, or say in the rule's \`why\` that the coupling is not real.`);
    process.exit(1);
  }
  console.log(`Map covers the derived floor: ${floor.size} source file(s) checked against ${suiteFiles.length} suites.`);
  process.exit(0);
}

const base = resolveBase(argv.find((a) => !a.startsWith('-')));
const files = changedFiles(base);

if (!files.length) {
  console.log(`No changes against ${base.label}. Nothing to run.`);
  process.exit(0);
}

const picked = new Map(); // suite -> reasons
const unmapped = [];
const broad = [];
let everything = false;

for (const file of files) {
  const { rule, suites, unknown } = suitesForFile(file);
  if (unknown) {
    unmapped.push(file);
    continue;
  }
  if (suites.includes('*')) {
    everything = true;
    broad.push(`${file} — ${rule.why}`);
    continue;
  }
  for (const suite of suites) {
    if (!ALL.includes(suite)) {
      console.error(`map error: rule for ${rule.re} names unknown suite "${suite}"`);
      continue;
    }
    if (!picked.has(suite)) picked.set(suite, new Set());
    picked.get(suite).add(`${file} — ${rule.why}`);
  }
}

console.log(`Changed vs ${base.label}: ${files.length} file(s)\n`);

if (broad.length) {
  console.log('Changed something the whole build rests on:');
  for (const f of broad) console.log(`  ${f}`);
  console.log('');
}

if (unmapped.length) {
  // Widening, not narrowing. A file nobody has classified is exactly the file
  // whose blast radius nobody has thought about.
  console.log('No rule covers:');
  for (const f of unmapped) console.log(`  ${f}`);
  console.log('\n→ Add a rule to the map in this script if that is wrong.\n');
}

if (everything || unmapped.length) {
  console.log('→ Running everything.\n');
  console.log('  npm run build && npm run test:e2e');
  process.exit(0);
}

if (!picked.size) {
  console.log('Nothing shipped to a player changed — no browser suite needed.');
  console.log('Still run:  npm run lint && npm run test:coverage');
  process.exit(0);
}

const suites = [...picked.keys()].sort((a, b) => ALL.indexOf(a) - ALL.indexOf(b));
console.log(`${suites.length} of ${ALL.length} suites:\n`);
for (const suite of suites) {
  console.log(`  ${suite}`);
  for (const reason of picked.get(suite)) console.log(`      ${reason}`);
}
console.log(`\n  npm run build && node scripts/e2e-run.mjs ${suites.join(' ')}`);
