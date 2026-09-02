#!/usr/bin/env node
// A change to shipped code carries a release note.
//
// A merge to `main` is a DEPLOY here — Dokploy auto-deploys the branch — so a
// merge with no note is a release players cannot see, and src/version.ts says
// out loud that the version must move only when the game does. Nothing else in
// this repository can notice a missing note: tests/patchNotes.test.ts holds the
// SHAPE of the file (newest entry is the running version, ordered, dated) and
// cannot know whether the diff beside it deserved a line.
//
// Scoped to shipped code deliberately. Tests, docs, CI and the deployment
// manifests change nothing a player can observe, so demanding a note for them
// would make PATCH_NOTES a changelog of the repository rather than of the game
// — and a rule that fires when it should not is a rule people learn to bypass.
//
// The escape is a LABEL on the pull request (`no-release-note`), checked by the
// workflow rather than here: deliberate, visible, and auditable afterwards. A
// magic string in a commit message would be none of those.
//
// Usage:
//   node scripts/check-release-note.mjs                  # origin/main...HEAD
//   BASE=<sha> HEAD=<sha> node scripts/check-release-note.mjs
import { execFileSync } from 'node:child_process';

const NOTES = 'src/patchNotes.ts';

/** Changes a player could observe. Everything else is repository upkeep. */
const SHIPPED = [
  /^src\//,
  /^server\//,
  /^server\.ts$/,
  /^index\.html$/,
  /^scripts\/(?!e2e-|check-)/, // backup.mjs and db-reset ship; the suites do not
];
/** Read by the build but never by a player, and the note file itself. */
const EXEMPT = [/^src\/patchNotes\.ts$/, /^src\/version\.ts$/, /^src\/i18n\//];

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

// In CI both ends are commits, so the three-dot form asks the right question:
// what this branch changed, ignoring what main did meanwhile.
//
// Locally there is no HEAD to compare against yet — the point is to answer
// BEFORE committing — so it diffs the working tree against the merge base. The
// two forms are not interchangeable: `A...HEAD` compares commits and would
// report a note as missing while it sits unstaged in front of you.
let range;
if (process.env.BASE && process.env.HEAD) {
  range = [`${process.env.BASE}...${process.env.HEAD}`];
} else {
  range = [git('merge-base', 'origin/main', 'HEAD')];
}

let files;
try {
  files = git('diff', '--name-only', ...range).split('\n').filter(Boolean);
} catch (e) {
  // A missing base is a CI configuration problem, not a verdict on the diff.
  // Say which, rather than failing as though the note were missing.
  console.error(`[release-note] cannot diff ${range.join(' ')}: ${e.message}`);
  console.error('[release-note] the verify job needs fetch-depth: 0 to see the base commit.');
  process.exit(2);
}

const shipped = files.filter(
  (f) => SHIPPED.some((re) => re.test(f)) && !EXEMPT.some((re) => re.test(f))
);

if (shipped.length === 0) {
  console.log(`No shipped code in ${files.length} changed file(s) — no release note needed.`);
  process.exit(0);
}
if (files.includes(NOTES)) {
  console.log(`${shipped.length} shipped file(s) changed, and ${NOTES} was updated.`);
  process.exit(0);
}

console.error(`This change touches ${shipped.length} file(s) a player can observe:\n`);
for (const f of shipped.slice(0, 20)) console.error(`  ${f}`);
if (shipped.length > 20) console.error(`  … and ${shipped.length - 20} more`);
console.error(
  `\n${NOTES} was not updated.\n\n` +
    'Merging to main deploys, so a merge with no note is a release nobody can see.\n' +
    'Bump the version in package.json AND src/version.ts, then add a PATCH_NOTES\n' +
    'entry for it — the newest entry has to be the version actually running, which\n' +
    'is what makes the "what\'s new" dot fire.\n\n' +
    'If this genuinely changes nothing a player experiences, label the pull request\n' +
    '`no-release-note`. That is a decision somebody takes on purpose, in the open.'
);
process.exit(1);
