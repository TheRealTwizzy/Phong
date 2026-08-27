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

## The voice

Read a few paragraphs of the surrounding section before writing — the register is consistent
and easy to match once you have seen it. The pattern, near-universally:

> **State the rule. Then name what it replaced, concretely, and what that cost a player.**

Not: *"The relay records abandoned duels."*

But: *"Walking out of a duel is losing it: `vacateSeat` calls `recordRoomMatch` with the
leaver's seat named, before the seat empties so the room is still whole. What that replaced
was a flat `rankMu` penalty and no match recorded anywhere, which is how a player could quit
every duel they were losing and keep a 100% win rate with no tracked losses, while their
opponents' wins evaporated with them."*

What makes that work, and what to carry into anything you add:

- **Name the failure in numbers a person can picture.** "Three device identities per page
  load." "Level 1 to 15 in ten requests." "The Start button sat ~160px below the viewport."
  Vague harm ("could cause issues") is the one thing these files never say.
- **Explain the mechanism, not just the outcome.** Why the bug was possible is the part that
  stops it coming back.
- **Prose, in flowing paragraphs.** Bullets appear for genuine enumerations — protocol tables,
  the list of REST routes, the file tree. A rule with reasoning is a paragraph. Resist the
  reflex to convert an argument into a list; the argument is the content.
- **Bold the standing rule, once, where it is decided.** "**Never add a match-recording path
  that has no `matchKey`.**" "**Never add a middleware order in which an `/api` call can be
  the first thing a browser does.**"
- **Em-dashes and semicolons carry the clauses.** Long sentences are fine here; the files
  earn them by being precise.
- **Present tense for what is true now, past tense for what it replaced.**
- **Record rejected alternatives and why.** A curving-in-flight spin model was built and
  rejected because it makes the ball unreadable on a blind half-court. That paragraph stops
  someone rebuilding it.
- **Record a rule that was learned twice.** The solo μ cap was wrong in both directions, and
  the section says so, because "a constant per difficulty" is only obviously right once you
  know what the two wrong answers cost.

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

TESTING.md §5 is the invariant list, and each entry names the suite that holds it. If you are
writing a new invariant there, it needs a suite; if you are removing one, the suite goes in the
same commit. **A suite that asserts old behaviour is deleted rather than read.**

## Length is not the problem

`CLAUDE.md` is long because the reasoning is long. Do not "tidy" it by compressing arguments
into bullets or trimming the bug histories — that is deleting the content and keeping the
headings. If a section is genuinely obsolete, delete the section.
