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
