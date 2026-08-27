# Phong skill toolkit

Project skills for working on this repo with Claude Code. They load on demand — nothing here
is in context until the work matches — so they carry the *procedure* CLAUDE.md states as
prose: which files a change touches, in what order, and which test fails when one is missed.

| Skill | Reach for it when |
|---|---|
| `phong-ship-check` | Before committing, pushing or opening a PR. Picks which of the 19 browser suites the change needs, and runs the gauntlet in the order that fails cheapest first. |
| `phong-protocol` | Adding or changing a WebSocket message. The relay and the P2P replica are two implementations of one protocol and have drifted before. |
| `phong-i18n` | Any user-facing string. All seven locales or it does not ship — and both failure modes are silent. |
| `phong-persistence` | Schema, migrations, `PLAYER_KEYED_TABLES`, or a new write path in `server/db.ts`. |
| `phong-match-rules` | Anything a player can toggle. Decides whether it is a free device preference or a match rule that costs the rating. |
| `phong-docs` | Keeping CLAUDE.md and TESTING.md true, in their own bug-first voice. |

Two carry executable tooling:

```bash
node .claude/skills/phong-ship-check/scripts/which-suites.mjs   # changed files → E2E suites
node .claude/skills/phong-i18n/scripts/locale-key.mjs audit     # dictionary ↔ product, both ways
```

## Maintaining these

A skill that misstates a touch-list is worse than no skill, because it is trusted. When a rule
in CLAUDE.md or TESTING.md moves, check whether a skill repeats it — `grep -rl "<identifier>"
.claude/skills/` — and fix it in the same commit, the same way the suites are.

They deliberately do not restate CLAUDE.md, which is already loaded in full every session.
What they add is the ordered procedure, the test that catches each miss, and the two scripts
above.
