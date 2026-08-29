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

## What is installed from outside, and what was refused

Three plugins from `sponticelli/gamedev-claude-plugins`, declared in `.claude/settings.json` so the
*choice* travels with the repo rather than with whoever made it: **`web-games`** (its
`canvas-optimization-expert` is dirty rects, layered and offscreen canvases, `willReadFrequently`
and `desynchronized`, devicePixelRatio — the things `CourtCanvas` actually does), **`multiplayer`**
(`netcode-specialist` covers prediction, reconciliation, interpolation and lag compensation, none
of which this game has), and **`juice`**. Twelve agents and twelve commands; no MCP server, and no
hooks of their own — the one hook in `.claude/settings.json` is ours, and it is what installs them.

**The declaration is not the install, and that catches everyone once.** A plugin from an external
source that only the project's settings enable does not load until it is installed on that machine:
the files live in `~/.claude/plugins/cache`, which is per-machine, so a new clone, a new machine or
a fresh cloud session gets three plugins that are declared, marked enabled, and absent.

**Which is why it is a hook now and not an instruction.** `.claude/hooks/session-start.sh` fetches
the marketplace, installs the three at project scope and runs `npm install`, on every SessionStart,
idempotently — CLAUDE.md §8 carries the timings and the never-fatal posture. Run it by hand if you
want it sooner.

**The manual loop it replaced was wrong twice over**, and both failures were invisible to the person
following it. It was missing a step: `extraKnownMarketplaces` makes the marketplace known by NAME
but never fetches its contents, so on a fresh machine every install answered `Plugin "web-games" not
found in marketplace "gamedev-claude-plugins"` — the loop as printed had never once worked on the
machine it was written for, and the three plugins stayed declared, enabled and absent exactly as if
nobody had run it. `claude plugin marketplace add sponticelli/gamedev-claude-plugins` is the missing
line. And it claimed to re-read `.claude/settings.json` and leave it unchanged, "so this dirties
nothing": in fact `claude plugin install` REWRITES that file, lifting `enabledPlugins` above
`extraKnownMarketplaces`, so following the instructions left the working tree modified every time.
The file is now committed in the order the CLI writes, which is what makes "dirties nothing" true
rather than merely claimed. That claim was made once already and was two-thirds true, in the way
that is worth recording: it was checked by installing TWICE and diffing, which only ever compares
the keys the installer had already agreed about — and `hooks`, added by the very commit making the
claim, sat at the bottom of the file where the CLI writes it FIRST. So every session reordered it,
every session opened with a dirty `git status` on a file nobody had touched, and the check said
nothing, because two installs agree with each other perfectly while both disagree with the repo.
The rule is that **the stored bytes must match what the installer emits**, and the check that
actually states it is a diff against ONE real install — where "real" excludes the fast path: an
install answered "already installed" never serializes, so on a machine with the plugins present
that check passes having checked nothing. Force the write with an uninstall/reinstall of the LAST
plugin in `enabledPlugins` (it re-appends, so the order survives), then
`git diff .claude/settings.json` and expect nothing. That cycle is also how a NEW top-level key
finds its place: the serializer decides the order (it put `permissions` first, above `hooks`), so
add the key anywhere, run the cycle, and commit the bytes the installer leaves behind. Reordering
the file by hand TOWARD that order is the fix, and is how this was fixed; reordering it away is
what puts the churn back, and the diff then lands in somebody's unrelated commit.

To check it took: `claude plugin list` names all three, or open `/plugin` → Installed (and its
Errors tab). `/reload-plugins` applies an install to the session you are already in, which matters
because a plugin the hook installed is not guaranteed to be loaded into the session that ran it.
Worth doing in the same pass: `/context`, to confirm the twelve still have their descriptions — on
overflow the listing drops them starting with the least-invoked skill, and nothing goes red.

**They are agents and slash commands, not `SKILL.md` files, and that is why they are safe here.** A
skill competes for triggers by its description; an agent is invoked deliberately. So none of these
can fire in place of one of the twelve.

**The house skill wins, always.** On build order, the release gate, which test layer a check belongs
in, or what a match pays, the answer is `phong-feature`, `phong-ship-check`, `phong-e2e` and
`phong-progression` — not an import. An outside pack is worse than a house skill getting it wrong,
because it is trusted for looking authoritative while carrying none of this repo's history. Its
`game-design` plugin is left uninstalled for exactly that reason: `phong-progression` knows
`SOLO_MU_CAPS` and why the solo cap has been wrong twice in opposite directions, and a generic
balance agent does not.

**`superpowers` and `gstack` were refused on their trigger text, not on taste.**
`superpowers:brainstorming` fires on *"any creative work — creating features, building components,
adding functionality"* and opens *"Start by classifying how much process the request needs"* — which
is `phong-feature`'s description and its first verb. `verification-before-completion` fires *"before
committing or creating PRs"*, which is `phong-ship-check` word for word. `systematic-debugging`
demands root cause on any test failure, where `phong-ship-check` rules that a red **measured**
assertion is often a draw and must never be tuned away. Both would fire, in opposite directions.

**`0xDarkMatter/claude-mods` was refused for a different reason**, worth recording because the skill
inside it is good: its `sqlite-ops` is the only public SQLite skill that treats `node:sqlite` as a
first-class host. It is one monolithic plugin that also ships `PreToolUse`/`PostToolUse` hooks
running shell on every Write, Edit and Bash call, and there is no way to take the skill without
them. `skillOverrides` does not help — the docs are explicit that plugin skills are outside it.

**`wshobson/agents` → `tailwind-design-system` was refused despite being right about Tailwind.** It
is genuine v4 CSS-first, which is why it looks like a match and why this is written down. But its
vocabulary is shadcn's — `background`, `foreground`, `primary`, `destructive`, `ring` — against our
`surface-0..4`, `ink*`, `accent`, `line*`. The one name they share, `--color-accent`, it defines as
a near-white muted hover surface where ours is the brand cyan `--color-ink-on-accent` exists to sit
on: redefining the single shared token is worse than sharing none. And it themes with `@theme` plus
a `.dark` class — two modes swapped by a class, with runtime publishing mentioned nowhere — where we
publish twenty palettes from `cosmeticVars()` as an inline style and `PublicProfileModal` paints a
different one on a subtree. It covers the case we do not have, omits the one we do, and walks into
convention 13's trap; `phong-ui` already owns this and gets it right. Its three siblings ship in the
same plugin and cannot be disabled separately — `react-state-management` opens on Zustand against
runtime deps of exactly `express` and `ws`.

**Do not re-run the search for these.** `anthropics/claude-plugins-official` carries 272 entries and
zero game plugins. Nothing public exists for skill rating or matchmaking, rollback netcode, WebRTC
DataChannel transport, or React render-loop performance; `phong-progression` and `phong-protocol`
are already more specific than anything published. Engine packs — Godot, Unity, Unreal, Bevy — are
most of what is published in this space and none of it applies to a hand-rolled canvas.
