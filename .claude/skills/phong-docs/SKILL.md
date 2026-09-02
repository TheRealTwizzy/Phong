---
name: phong-docs
description: >-
  Keeping Phong's CLAUDE.md and TESTING.md honest, and writing in their very particular house
  voice. Use this whenever a change lands that makes something in those files untrue, whenever
  the user asks to update the docs, document a decision, record why something works this way,
  or add a section — and before writing any prose into either file. Both carry a standing "when
  the code and this file disagree, fix this file" rule, and both are written in a bug-first
  style that generic documentation prose does not match; a bland bullet list dropped into them
  is immediately visible and loses the reasoning the files exist to carry.
---

# Writing in these files

`CLAUDE.md` and `TESTING.md` are not reference documentation. They are a record of **what was
tried, what broke, and why the code is shaped the way it is** — and that is what makes them
worth their length. A section that only describes current behaviour could be replaced by
reading the code. A section that says what the code used to do, and what that cost, could not.

Both open with the same standing rule: **when the code and this file disagree, fix this file.**
So doc updates are part of the change, not a follow-up.

## Which file

- **`CLAUDE.md`** — the product, the architecture, the protocol, the rules, the conventions.
  §-numbered, and cross-references are by section (`see §5`, `convention §12`).
- **`TESTING.md`** — the two test layers, what each suite owns, the coverage floors, and §5's
  **standing invariants**. A rule the *suite* exists to hold goes here; a rule the *product*
  obeys goes in CLAUDE.md. Several rules legitimately appear in both, stated from each side.
- **`src/patchNotes.ts`** — the same obligation pointed at a PLAYER, and it is the one file in
  this skill's remit that ships. Every change a player can observe adds a line and moves the
  version (`package.json` + `src/version.ts` + a new top entry, all three); `npm run lint:notes`
  fails a pull request that touched shipped code without touching it, and CI runs the same
  check. The voice is the opposite of the one below: **no reasoning, no history, no
  identifiers** — say what a player can now do, or what stopped being broken, in a sentence
  they would say themselves. `tests/patchNotes.test.ts` refuses a line naming a file, a path,
  or a function, because the check that forces a line is exactly the pressure that produces a
  commit message in its place. Convention §17 carries the whole rule.

## The voice

Read a few paragraphs of the surrounding section before writing — the register is consistent and
easy to match once seen. The pattern, near-universally:

> **State the rule. Then name what it replaced, concretely, and what that cost a player.**

Not: *"The relay records abandoned duels."* But: *"Walking out of a duel is losing it:
`vacateSeat` calls `recordRoomMatch` with the leaver's seat named, before the seat empties so the
room is still whole. What that replaced was a flat `rankMu` penalty and no match recorded
anywhere, which is how a player could quit every duel they were losing and keep a 100% win rate
with no tracked losses, while their opponents' wins evaporated with them."*

What makes that work, and what to carry into anything you add:

- **Name the failure in numbers a person can picture.** "Three device identities per page
  load." "Level 1 to 15 in ten requests." Vague harm is the one thing these files never say.
- **Explain the mechanism, not just the outcome.** Why the bug was possible is the part that
  stops it coming back.
- **Prose, in flowing paragraphs.** Bullets are for genuine enumerations — protocol tables, the
  REST routes, the file tree. A rule with reasoning is a paragraph; the argument is the content.
- **Bold the standing rule, once, where it is decided.** "**Never add a match-recording path
  that has no `matchKey`.**"
- **Em-dashes and semicolons carry the clauses.** Long sentences are fine here; the files earn
  them by being precise.
- **Present tense for what is true now, past tense for what it replaced.**
- **Record a rule that was learned twice.** The solo μ cap was wrong in both directions and the
  section says so — "a constant per difficulty" is only obviously right once you know why.

## Writing it before the code

Most of this is about prose written when a change lands. Two parts can be written *before*, and
should be: nine of the last nine feature PRs edited `CLAUDE.md`, all at the end, from memory.

**Write the rule as one bolded sentence.** A rule you cannot state in one sentence is one you
have not decided — a design problem, not a writing one, and it belongs back with the
classification question `phong-match-rules` asks.

**Write down the alternative you rejected, and why, as you reject it.** There is no RFC
convention here but a strong habit of recording rejected designs — the curving-in-flight spin
model, the `anchor + AI_ADAPT_BAND` cap formula, the accordion pre-match sheet. Those paragraphs
stop work being rebuilt, and they are currently reconstructed weeks late.

**What you cannot write yet is the bug history.** The voice above wants past tense for what a
change replaced, and before the code there is no past — told to "write the paragraph first", an
author invents one, or writes "could cause issues". Add the failure when the change lands.

## Updating rather than appending

The failure mode is a file that grows a new paragraph per change and contradicts itself three
sections up. When a rule moves:

1. **Find every place that states it.** These files deliberately repeat load-bearing rules
   from different angles — the sonar rule appears in §1, §3, §7 and convention §12. Grep for
   the identifier, not the prose.
2. **Rewrite in place.** Do not leave the old claim standing next to the new one.
3. **Keep the history where it is still load-bearing, delete it where it is not.** The
   spectator section keeps a superseded sentence *and says why it was restated rather than
   deleted* — a pre-match `swap_seat` can now fill seat 0, so the old "a hostless room can
   never have one again" had to change while the guards it justified did not. That is worth
   the words. A stale claim nobody depends on is not.
4. **Fix the file tree in §4** when files are added or removed, and the suite lists in
   TESTING.md §2 when a suite is.

## When a rule changes, its test changes too

TESTING.md §5 is the invariant list, and each entry names the suite that holds it. A new
invariant needs a suite; a removed one takes its suite in the same commit. **A suite that
asserts old behaviour is deleted rather than read.**

## Length is not the problem

`CLAUDE.md` is long because the reasoning is long. Do not "tidy" it by compressing arguments
into bullets or trimming bug histories — that deletes the content and keeps the headings.
