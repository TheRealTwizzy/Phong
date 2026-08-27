# Phong skill toolkit

Project skills for working on this repo with Claude Code. They load on demand — nothing here
is in context until the work matches — so they carry the *procedure* CLAUDE.md states as
prose: which files a change touches, in what order, and which test fails when one is missed.

| Skill | Reach for it when |
|---|---|
| `phong-ship-check` | Before committing, pushing or opening a PR. The gauntlet in the order that fails cheapest first, and how to read what comes back. |
| `phong-protocol` | Adding or changing a WebSocket message. The relay and the P2P replica are two implementations of one protocol and have drifted before. |
| `phong-i18n` | Any user-facing string. All seven locales or it does not ship — and both failure modes are silent. |
| `phong-persistence` | Schema, migrations, `PLAYER_KEYED_TABLES`, or a new write path in `server/db.ts`. |
| `phong-match-rules` | Anything a player can toggle. Decides whether it is a free device preference or a match rule that costs the rating. |
| `phong-docs` | Keeping CLAUDE.md and TESTING.md true, in their own bug-first voice. |

Two carry executable tooling:

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
What they add is the ordered procedure, the test that catches each miss, and the two scripts
above.
