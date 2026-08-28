# Phong skill toolkit

Project skills for working on this repo with Claude Code. They load on demand — nothing here
is in context until the work matches — so they carry the *procedure* CLAUDE.md states as
prose: which files a change touches, in what order, and which test fails when one is missed.

Start at `phong-feature` when the work is a whole feature; it classifies the change and routes
into the rest. The others stand alone when you already know what you are editing.

| Skill | Reach for it when |
|---|---|
| `phong-feature` | Designing or landing a feature or mechanic. The questions that classify it, the order the pieces land in, and which skill owns each answer. |
| `phong-match-rules` | Anything a player can toggle. Decides whether it is a free device preference or a match rule that costs the rating. |
| `phong-protocol` | Adding or changing a WebSocket message. The relay and the P2P replica are two implementations of one protocol and have drifted before. |
| `phong-persistence` | Schema, migrations, `PLAYER_KEYED_TABLES`, or a new write path in `server/db.ts`. |
| `phong-session` | A new route, socket path or way to earn. Which gate it sits behind, and why a gameplay path needs the check twice. |
| `phong-progression` | What a match pays or moves. XP curve, level bands, reward budgets, the TrueSkill update and the per-rung solo caps. |
| `phong-streaks` | Rally runs. Which of the three numbers to read, who owns the run, and how two writes about it are ordered. |
| `phong-ui` | Anything on screen. The shared primitives, and the five cross-file rules that are not written near the file you are editing. |
| `phong-i18n` | Any user-facing string. All seven locales or it does not ship — and both failure modes are silent. |
| `phong-e2e` | Writing a test. Which layer it belongs in, and the browser mechanics that cost time to discover. |
| `phong-docs` | Keeping CLAUDE.md and TESTING.md true, in their own bug-first voice. |
| `phong-ship-check` | Before committing, pushing or opening a PR. The gauntlet in the order that fails cheapest first, and how to read what comes back. |

One carries executable tooling:

```bash
node .claude/skills/phong-i18n/scripts/locale-key.mjs audit   # dictionary ↔ product, both ways
```

`phong-ship-check` shipped with a second script — a changed-file → E2E-suite mapper — and it
was **deleted after review**. Six rounds, and every rule anybody checked was too narrow, always
in the direction that lets a targeted run pass while skipping the broken flow. The coupling that
matters (which suites play a match, or a relayed point) is behavioural and not derivable, so a
map of it is a claim that looks precise and is trusted for looking precise. The skill keeps the
reasoning under "Which suites to run" so the idea is not rebuilt from scratch. What survived is
`npm run lint:suites`, now `scripts/check-suites-registered.mjs`: a suite file missing from the
runner never executes and nothing else in the repo can notice.

## Maintaining these

A skill that misstates a touch-list is worse than no skill, because it is trusted. When a rule
in CLAUDE.md or TESTING.md moves, check whether a skill repeats it — `grep -rl "<identifier>"
.claude/skills/` — and fix it in the same commit, the same way the suites are.

They deliberately do not restate CLAUDE.md, which is already loaded in full every session.
What they add is the ordered procedure, the test that catches each miss, and the script above.

They also do not restate each other. Where two could rule on one question, exactly one owns it
and the other defers by name — `phong-feature` hands the release decision to `phong-ship-check`,
`phong-progression` hands the AI's own error rate to it too, and `phong-ui` points at the file
headers rather than copying them. That is not tidiness: two skills that can both be active and
give opposite instructions is worse than either being wrong alone, which is how `phong-i18n`
came to carry a ruling about which browser suites to run.

And they stay short enough to read in one pass: **at most 130 lines, 3–7 H2s, and no H3s at
all.** Those are one constraint counted three ways. A skill is loaded whole when its description
matches, but the binding limit is not tokens — it is that past roughly this length a document
needs internal navigation to be usable, and the no-H3 rule is what keeps these flat. There is no
minimum: 85 lines is merely the shortest of the twelve, and padding a lean skill to reach a
number is the bloat the ceiling exists to prevent. The question a short skill should face is a
different one — under about 60 lines, ask whether its content belongs as a comment in the file it
describes rather than as a document somebody has to load to see.

**The tripwire is not the number.** When a change only fits by cutting a clause that carried a
*reason*, the file is full whatever `wc -l` says, and the answer is to split it or drop a rule —
never to keep trimming. That is the failure the ceiling is for: a touch-list trusted because it is
terse and wrong because it was trimmed.

It was 104 and written down nowhere, which is how it came close to making an architectural
decision by itself. `phong-feature` could absorb its last two rules only by compressing its own
prose, and the next addition would have forced a split chosen for space rather than on its merits.
That split was weighed and declined, so nobody re-derives it: `phong-feature` deliberately owns
two things — classifying a change and ordering it — and separating them would set the toolkit's
two closest descriptions against each other, with an asymmetric cost, because the ordering half
firing alone means building in the right order having never asked whether it is a match rule.

```bash
for f in .claude/skills/*/SKILL.md; do printf "%-46s %3s lines %s H2 %s H3\n" \
  "$(basename $(dirname $f))" "$(wc -l < $f)" "$(grep -c '^## ' $f)" "$(grep -c '^### ' $f)"; done
```
