---
name: phong-streaks
description: >-
  Phong's rally streaks — which of the three numbers a change should read, who owns the run, and
  how two writes about it are ordered. Use this whenever the work touches bestStreak, endStreak,
  earnedStreak, src/game/streaks.ts, CarryStore, src/net/runChain.ts, countReturn or
  breakStreakOnPoint in server/room.ts, player_mode_stats.currentStreak, or any reward that
  reads a rally figure — and whenever the user asks to pay for a rally, add a streak stat, show
  a run in the UI or fix a streak that looks wrong. The three numbers answer three different
  questions and every one of them is a plausible-looking choice, so reading the wrong one does
  not crash: it silently pays for work nobody did, or confiscates a run a player still had.
---

# Which of the three numbers is this?

A rally streak belongs to **one player**. It counts that player's own consecutive returns and
breaks only when **that player** fails to return one — the opponent missing is a point you won,
not a streak you lost. So a run crosses points, and crosses matches: a match ending is not a
miss. What that replaced was a single counter both players incremented and that reset whenever
either scored, so a player's rally number was mostly a statement about their opponent.

## The three numbers, and which one anything is paid on

`MatchEndPayload` carries all three because they answer different questions. Pick deliberately.

1. **`bestStreak` — the peak the run reached**, opening on whatever was carried in. This is what
   the career best, the mode best and the rally achievements are about. It is a maximum, so it
   is permanent once written.
2. **`endStreak` — where the run stands when the match ends.** This is what the next match
   starts from, and the only one of the three that legitimately goes *down*.
3. **`earnedStreak` — how much of the peak was built here, counted from zero.** **This is the
   only one anything is paid or rated on**: `matchXp`, `practiceDayXp`, `performanceWeight` and the
   daily rally tasks.

**Paying on the peak is a farm with no work in it.** Carry a run in, open the Practice Wall,
leave without touching the ball, and collect for it again — every day, up to the daily cap. At
its worst it paid an elite task's 600 XP and its permanent theme unlock for nothing.

How easy is the mix-up? `matchXp`'s parameter is *named* `bestStreak` (`src/rating.ts:445`)
while `server/db.ts` correctly passes `earnedStreak` into it. Do not follow the name.

## The rule is written three times and must not drift

- **`server/room.ts`** — `countReturn` (`:707`), `breakStreakOnPoint` (`:726`),
  `startMatchStreaks` (`:664`). The relay's copy, and **imported wholesale by
  `src/net/p2p.ts`**, so the DataChannel replica cannot disagree with it. Change it here.
- **`src/game/streaks.ts`** — `ownReturn`/`ownMiss`/`opponentReturn`/`opponentMiss` (`:31-52`)
  for the client, which is the only authority in a solo match.
- **`clearSeatStreaks` (`:696`)** when a seat is vacated. A run belongs to a player, not a
  chair, and `startMatchStreaks` opens `bestStreaks` *on* `streaks` — so a value left behind
  becomes the next occupant's opening peak, which is a maximum, which is permanent.

The relay derives its own `earnedStreaks`/`earnedBests` rather than believing the client's, and
the server bounds every figure by the peak: neither what a match earned nor where its run ended
can stand higher than the run ever reached.

## Two sources, and the precedence is itself a rule

The run a new match opens on has two possible answers, and the precedence lives in
`CarryStore` (`src/game/streaks.ts:114`) rather than in `App.tsx`:

**What this page last saw for itself wins; the profile is the fallback, and the only source
after a reload.** The profile only learns a match's ending run when that match's POST comes
back, and Play Again is a synchronous button — read from the profile alone, a replay opens on
the run from *before* the match just played, discarding a run a winning point had left intact
and then reporting the smaller number back over the correct one. `carriedStreak` (`:134`) is
asserted in both directions, because a test that only checks the fallback passes on the bug.

`CarryStore` is never cleared, since a refreshed profile can arrive before the match POST does —
but `startFreshIdentity` must clear it explicitly, or a fresh account's first session opens on
the run the player just gave up.

## Every exit reports where the run stands, and every writer numbers itself

**A match ending is not the only way a run ends.** The final whistle, the Practice Wall, quitting
an unfinished match, the HUD's Reset (locally *and* to the server, or a reload puts the pre-Reset
run straight back) and an **abandoned duel** all report — that last decided by nobody, so the
relay writes both seats itself and the survivor counts as much as the leaver. Without all of
them, a player who carried a run in, missed and walked out was seeded from the stale carry next
time: the miss simply undone.

**Ordering needs two mechanisms because there are two questions.** An age (`endedAt` against
`clientNow`, a difference of two readings of one clock, never an absolute time) orders a write
against writes from other moments. It cannot order two writes from the same browser whose own
round trips differ, so `nextRunSeq()` (`src/net/runChain.ts:91`) *numbers* instead: a
`chainId`/`runSeq` pair assigned once per event, before anything is sent, persisted so a payload
parked and replayed after a reload keeps the number it was decided at. A failed write returns a
**fresh random `chainId`**, never the incremented-but-unpersisted number — that would look fine
once and then repeat identically forever, reintroducing the exact bug it exists to remove.
**Every writer that assigns the run carries the pair**: `/api/match/record`,
`/api/practice/record` and `/api/profile/me/streak`.

## Verifying

```bash
npx vitest run tests/streaks.test.ts tests/room.test.ts tests/db.test.ts \
  tests/p2pParity.test.ts tests/duelRecord.test.ts
npm run build && node scripts/e2e-run.mjs streak
```

Assert each half separately: a test that only checks the peak passes on the bug. `e2e-streak`
reaches for the side effect rather than the readout — it knocks the stored run out of step
through the real route, presses Reset, and asserts the page told the server, which fails
outright when the report is removed.
