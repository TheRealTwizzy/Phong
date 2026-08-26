> **TEMPORARY — working document, not project documentation.**
> Implementation plan for the Building/Room/Table navigation, spectator and SBMM work on
> `claude/building-room-table-nav-j7xsiq`. Delete this file when the work lands; the durable
> record belongs in `CLAUDE.md` and `TESTING.md`, which the plan itself says to update in the
> same commits as the code.

# Building / Room / Table navigation, spectators and SBMM

## Context

Phong's menu today is a flat list of four mode rows (`src/components/MainMenu.tsx:184-197`).
Picking Solo opens a pre-match `Sheet`; picking Duel opens `MultiplayerLobby`, where the only
way to reach another human is to type or scan a 4-letter room code. There is no way to
*discover* a match — no browsing, no queue, no way to watch. `src/net/useQuickMatch.ts` is a
45-line stub whose header says outright that it is "the seam a ranked queue drops into", with
`available: false` and a `#menu-mode-quickmatch` button carrying a SOON chip.

Separately, players report the AI is too easy. The ladder has three rungs; `MAX_AI_COMPETENCE`
is clamped at `0.66` (`src/game/physics.ts:410`), which puts the hardest opponent in the game
at ~85% of balls returned, and `soloMuCap` converges solo farming well short of the top.

This change gives the game a **place structure** — a player walks into a *building*, picks a
*room* matched to their skill, and sits at a *table* with an opponent and, optionally,
spectators — and raises both ends of the AI ladder to five rungs. It also implements the SBMM
queue the Quick Match slot has been holding open.

Five phases, committed in dependency order on `claude/building-room-table-nav-j7xsiq`, each
independently green (`npm run lint && npm test && npm run test:e2e`).

### Decisions this plan is built on

| | |
|---|---|
| AI anchors | Re-anchored to hit the tier targets; Cyber gets meaningfully harder |
| Skill ceiling | `MAX_AI_COMPETENCE` `0.66 → 0.78` (~90% returns); the hard rule becomes **< 93%** |
| `chaos` | Name reused at the top, with a one-shot migration relabelling legacy rows |
| Ranked solo | Pro/Elite/Cyber/Chaos rate; capped just below the Overlord floor |
| Practice + Split | A third TRAINING building; SOLO AI rooms have no tables |
| Spectators + P2P | Spectator tables are relay-only, enforced **server-side** |
| Spectators + rank | No spectator seats in ADVANCE/ELITE/PRO; elsewhere matches rate normally |
| Spectating | Ungated — anyone may watch any room that has seats |
| SBMM band | 45-55% → 40-60% at 30s → widening past 90s |

**Two things the brief and the repo disagree about, flagged rather than buried.**

1. The brief says "do not match players unless the win% is within 40-60%" *and* "ensure players
   always find another player". Those are incompatible on a low-population server:
   `winProbability` is symmetric, so a lone queuer never matches however long the search widens.
   Per your decision the band is a **target held for the first 90 seconds**, not an absolute.
2. Raising `MAX_AI_COMPETENCE` reverses a decision CLAUDE.md §7 documents deliberately (the
   clamp came *down* from 0.9 because a near-wall opponent made the top rung "a lottery on the
   AI's own error"). 0.78 is a middle position, and the reasoning in `rating.ts`, `physics.ts`,
   CLAUDE.md §7 and `tests/physics.test.ts` must be rewritten to say what is true now — not left
   describing a ceiling that has moved.

---

## Phase 1 — The AI ladder: five rungs, higher floor and ceiling

### Anchors and the competence curve

`src/rating.ts` — `AI_RATINGS` re-anchored so each rung simulates the tier band it is named for:

| Rung | μ now | μ after | Simulates (tier floors: contender 19 · vanguard 22 · ace 25 · master 28 · GM 31 · legend 34) |
|---|---|---|---|
| `rookie` | 18 | **20** | Unranked / Contender |
| `pro` | 25 | **24** | Vanguard / Ace |
| `elite` | — | **30** | Master / Grandmaster |
| `cyber` | 29 | **33** | Grandmaster / Legend |
| `chaos` | — | **36** | Legend+ |

`src/game/physics.ts` — `MAX_AI_COMPETENCE` `0.66 → 0.78`, and `COMPETENCE_KNOTS` replaced.
The current knots are `[12,.05] [18,.28] [25,.49] [29,CEILING_C]` with a straight line
`(mu-12)/29` at and above 29. The new curve is knots all the way up:

```ts
const COMPETENCE_KNOTS = [
  [12, 0.05],
  [20, 0.34],   // rookie   → target ~72% of balls returned
  [24, 0.47],   // pro      → ~79%
  [30, 0.62],   // elite    → ~85%
  [33, 0.70],   // cyber    → ~88%
  [36, MAX_AI_COMPETENCE], // chaos → ~90%
];
```

**These knot values are seeds, not answers.** They must be calibrated against the existing
rally simulation in `tests/physics.test.ts` (`returnRate()`, line 126 — it drives real balls
through the real `checkPaddleCollision`) until the measured rates land on the targets above.
Calibrate by measuring, then set the bounds below the observed tail — TESTING.md §5,
"an assertion on a DIFFERENCE needs a bigger sample than one on a value".

`lapseForCompetence` (`physics.ts:488-492`) is currently pinned to `CEILING_C` derived from
`CEILING_MU = 29`. Both constants go; re-express the lapse curve against the new top so the
bottom stays cut (`0.075` at the floor) and the top keeps trending to zero.

`AI_STYLES` (`physics.ts:463-467`) gains two rows. `chaos` recovers its historical identity —
strength is the anchor, *style* is volatility:

```ts
elite: { volatility: 0.05, aggression: 0.75 },
chaos: { volatility: 0.11, aggression: 0.95 },
```

### The `chaos` name

`chaos` is currently a RETIRED id mapped to `cyber` by `RETIRED_DIFFICULTIES`
(`src/rating.ts:90`) — and it originally meant a rung *between* Pro and Cyber. Reviving it at
the top would silently promote every legacy row.

- Drop `RETIRED_DIFFICULTIES` (now empty) and the `chaos → cyber` arm of `normalizeDifficulty`.
- Add a one-shot `chaos_relabel_v1` migration in `server/db.ts` beside `ranked_backfill_v1`
  (`db.ts:783-797` is the template): `UPDATE matches SET difficulty = 'cyber' WHERE difficulty
  = 'chaos'`, stamped in `meta`. This runs **before** the name changes hands, so a legacy row
  keeps its original meaning.
- `tests/physics.test.ts:494-497` ("the retired difficulty") asserts the old behaviour and is
  **deleted**, replaced by a `tests/rankedBackfill.test.ts`-shaped suite for the migration.

### Ranked solo track and the cap

```ts
export const RANKED_SOLO_DIFFICULTIES = ['pro', 'elite', 'cyber', 'chaos'];
/** Just under the Overlord floor: the apex stays a PvP achievement. */
export const SOLO_MU_CEILING = 36.9;
export const soloMuCap = (d) => Math.min(AI_RATINGS[d].mu + AI_ADAPT_BAND, SOLO_MU_CEILING);
```

Rookie stays off the ranked track (open from the first match). Note one documented property
does change: Rookie's cap was `18 + 7 = 25`, exactly `START_MU`, "so farming the easiest rung
from a standing start still moves nothing". At μ20 it becomes 27. That is deliberate — Rookie
at μ20 with the raised floor is a genuinely competent opponent, and the pathology the old note
guarded against (Pro's base sitting *exactly* on `START_MU`, so beating Pro moved μ by nothing)
is gone now that Pro anchors at 24. Update the note in `rating.ts` and CLAUDE.md §7 in the same
commit rather than special-casing the formula.

### Unlock chain and achievements

`src/achievements.ts` — `DIFFICULTY_ORDER = ['rookie','pro','elite','cyber','chaos']`, and
`UNLOCKS` becomes a five-rung walk:

| Achievement | Opens |
|---|---|
| `ai_rookie` (beat Rookie) | `pro` |
| `ai_pro_10` (10 Pro wins, level 10) | `elite` *(was: cyber)* |
| `ai_elite_10` (new — 10 Elite wins, gate `tier: 'ace'`) | `cyber` |
| `cyber_10` (existing, gate `tier: 'ace'` → raise to `grandmaster`) | `chaos` |

New nodes on the `ladder` branch, following the shape at `achievements.ts:296-373`:
`ai_elite` (parent `ai_pro_10`, `scaled: true`), `ai_elite_10` (parent `ai_elite`,
`gate: { level: 15 }`), `ai_chaos` (parent `cyber_10`, `scaled: true`, `hidden: true`),
`chaos_10` (parent `ai_chaos`, `gate: { tier: 'legend' }`, `hidden: true`). `cyber_slayer`
and `cyber_shutout` re-parent onto `ai_elite_10`.

`tests/achievements.test.ts` already asserts "no gate is ever locked behind something that
needs it" and the `ACHIEVEMENT_BAND_CAP` no-two-level-gain rule above level 4 — both must stay
green with four new nodes, which constrains their `xpReward` values.

### Win counters

`recordMatch` increments `rookieWins`/`proWins`/`cyberWins` (`db.ts:2369-2371`) and reads them
for unlocks (`db.ts:2463-2468`). Add `eliteWins` and `chaosWins` following the identical,
already-tested pattern — six touch points each: `PlayerRow` (`db.ts:253`), `rowToProfile`
(`:301`), the `CREATE TABLE` (`:385`), `addColumn` (`:700`), `upsertProfile`'s column list /
`DO UPDATE SET` / positional args (`:890,903,934`), the lazy-mint default (`:1032`) and
`insertBot` (`:2112`). Plus `PlayerProfile` in `src/types.ts:208-287`.

Two columns on an already-33-column hand-written upsert is the risk here; `db.ts:425-432`'s own
comment warns about exactly this. It is still lower-risk than a new table, which would drag in
`PLAYER_KEYED_TABLES`, `applyWipe`'s DROP list and `tests/identity.test.ts:384`.
`tests/db.test.ts`'s "server-derived counters" describe is where this gets claimed.

### i18n

Two difficulty names plus their descriptions × 7 locales, in the same commit as the code that
references them — `tests/i18n.test.ts` fails on both a key nothing quotes and a key nothing
defines. Place them in the `// App & Modes` section of each locale block (en at line 151, then
+487 / +471 / +471 / +471 / +471 / +471 for es/ja/de/fr/pt/zh).

### Tests to change in this phase

- `tests/physics.test.ts`: `LADDER` grows to five. The bounds at `:155` (`< 0.88`), `:201`
  (`rookie < 0.74`), `:209` (`> 0.6`), `:217` (`pro > 0.73`) and `:193` (spread `> 0.11`) all
  move. **`:220-237` ("leaves the top of the ladder EXACTLY where it was") is deleted** — it
  pins the old straight line by construction, and the ceiling moving is the point of this
  phase. Replace with a bound at the new ceiling: **no difficulty may return ≥ 93%**.
- `tests/rating.test.ts`: anchors, `soloMuCap` (including the new Overlord clamp),
  `recommendedDifficulty` across five rungs, `RANKED_SOLO_DIFFICULTIES`.
- `tests/achievements.test.ts`, `tests/themes.test.ts` (`flawless-white` = shut out Cyber
  survives; check the copy-quotes-a-threshold rule), `tests/db.test.ts`, `tests/i18n.test.ts`.
- `scripts/e2e-rating.mjs` drives the difficulty picker and the BALANCED badge.

---

## Phase 2 — Buildings and Rooms (client navigation)

### A new shared module: `src/venues.ts`

Following the project convention that shared rules live in `src/` and the server imports them
(`src/profileRules.ts`, `src/matchRules.ts`, `src/rating.ts`). It gets its own coverage floor
in `vite.config.ts`.

```ts
export type BuildingId = 'solo' | 'pvp' | 'training';
export type PvpRoomId = 'casual' | 'beginner' | 'intermediate' | 'advanced' | 'elite' | 'pro';
/** The hidden room SBMM seats its pairs in. Never listed, never browsable. */
export const MATCHMAKING_ROOM = '_queue';

export interface RoomGate {
  level?: number;
  tierMin?: Tier;      // inclusive
  tierMax?: Tier;      // inclusive — a bracket has a ceiling as well as a floor
}
export interface RoomDef {
  id: string; building: BuildingId; labelKey: string; descKey: string;
  gate?: RoomGate;
  /** Solo rooms only. */
  difficulty?: AIDifficulty;
  /** CHAOS: physics rules are clamped to their ranked bands and sonar forced off. */
  rankedOnly?: boolean;
}
export type EntryVerdict = { ok: true } | { ok: false; reason: 'level' | 'tier_low' | 'tier_high'; need: ... };
export function roomEntryVerdict(room: RoomDef, profile): EntryVerdict;
```

Rooms:

| Building | Room | Gate to PLAY | Spectator seats |
|---|---|---|---|
| SOLO AI | rookie / pro / elite / cyber / chaos | the achievement `UNLOCKS` chain from Phase 1; `chaos` additionally `rankedOnly` | n/a — no tables |
| PVP | `casual` | level 1, any tier | ✅ |
| | `beginner` | level 1, tier ≤ contender | ✅ |
| | `intermediate` | level 5, contender…master | ✅ |
| | `advanced` | level 12, ace…grandmaster | ❌ |
| | `elite` | level 20, grandmaster…legend | ❌ |
| | `pro` | level 30, legend+ | ❌ |
| TRAINING | `practice` / `split` | ungated | n/a — no tables |

Brackets are enforced at **both** ends — a Legend cannot enter BEGINNER. `tierRank()` already
exists in `achievements.ts` as `TIER_ORDER.indexOf(tier)`; note `unranked` yields `-1`, so an
unplaced player must be handled explicitly (they may enter `casual` and `beginner` only).

**Spectator seats are a property of the ROOM, not of a match.** The top three brackets have
none, so a rated ladder match cannot be watched — a spectator sees the hidden half live with
sonar forced on and can simply describe it over a voice call, which is the sonar rule (CLAUDE.md
§1, §12) with a second person attached. Drawing the line by room rather than per-match means no
`spectatedThisMatch` bookkeeping, no `forceUnranked`, and no new `unrankedReasons` case — a
match in a room that permits spectators rates exactly as it does today.

**Spectating itself is ungated.** Within a room that has spectator seats, anyone may take one
regardless of their own level or tier. The bracket gates who may *play*.

**Residual hole, named rather than hidden.** A *private* invite-code table has no bracket, may
enable spectators, and rates. That is the side channel again, at a much smaller scale: it
requires two people who already know each other and have swapped a 4-letter code. Accepting it
keeps today's invite flow byte-identical; closing it would mean the per-match `forceUnranked`
route this decision rejected. Worth revisiting only if the ladder is ever seen to be abused.

### `MainMenu` restructure

No new `screen` value — `screen` stays `'menu' | 'game'` and there is still no router. The
menu's PLAY section becomes a small local nav stack:

```ts
const [nav, setNav] = useState<{ building: BuildingId | null; room: string | null }>({...});
```

Rendered in the existing single scroll region, with every direct child `shrink-0` (the flex
`min-height:0` collapse documented at `MainMenu.tsx:51-80` is the trap here). Buildings list →
room list → destination:

- **SOLO AI room** → the existing pre-match `Sheet`, pre-set to that room's difficulty. No
  tables (a solo match simulates its opponent locally and streams nothing to the relay).
- **TRAINING room** → the existing pre-match `Sheet` for `practice` / `split`.
- **PVP room** → the table browser (Phase 3).

The room list reuses the established tabbed pattern verbatim: the
`grid-cols-N gap-1 rounded-card border border-line bg-surface-1 p-1` tablist from
`MatchHistoryList.tsx`, with `role="tab"`, `aria-selected`, and — critically — `data-selected`
and `data-locked` as the machine-readable state, never a Tailwind class. Gated rooms follow
`AchievementsModal.tsx`'s locked-branch precedent (`data-locked="true"` + `LockBadge` +
`UnlockHintSheet`). Ids: `#building-{id}`, `#room-{id}`.

**Tour interaction — do not skip this.** The `OnboardingTour` scrim is `pointer-events-none`,
so a player can tap a building or room mid-tour. `MainMenu` already carries three overrides for
exactly this (`MainMenu.tsx:148,162,163`) plus the `useEffect` keyed on `tourActive` alone
(`:176-181`) that clears the raw state on the true start/end transition. `nav` must join all
four: `tourActive ? { building: null, room: null } : nav`, and be cleared in that effect. Also
add `nav` to the mode-row step's anchor so `scripts/e2e-tutorial.mjs` still finds its target.

---

## Phase 3 — Tables (2 seats, no spectators yet)

The relay's `Room` **is** a table. It gains a venue and a visibility, and becomes listable.

- `Room` grows `venueRoomId: string` and `visibility: 'public' | 'private'`. Both arrive as
  **optional** fields on `create_room`, defaulting to `private` and a private venue — that
  default is what keeps `tests/helpers/relay.ts`'s `seatDuel` and every existing suite green
  without a line changed. `venueRoomId` is normalized against a `VENUE_ROOMS` whitelist in
  `src/venues.ts`, never accepted as free client text, or the browser becomes an unbounded index
  keyed on attacker-supplied strings.
- **New REST**, deliberately not a WS message so `tests/protocolParity.test.ts` is untouched by
  browsing: `GET /api/rooms/:venueRoomId/tables` → `{ tables: TableSummary[] }`, where a summary
  is `{ id, hostName, hostId, playerCount, spectatorCount, spectatorsEnabled, config, inPlay,
  waitingMs }`. Modelled on `GET /api/room/:roomId` (`server.ts:615-638`), which stays. Polled
  every ~3s, with a 1s in-process cache keyed on venue.
- **`visibility` is the entire security boundary protecting today's invite-code rooms.** The
  listing is an unauthenticated read of live room state; a bug that lists a private table makes
  every private room's code harvestable. It filters on venue **and** `visibility === 'public'`
  **and** has-a-live-player — that last clause is what makes "empty tables are never listed"
  true inside the 15s reaper window, on top of `vacateSeat` already deleting a room whose seats
  are both empty (`server.ts:1891-1893`).
- The hidden matchmaking venue is excluded by **data, not a special case in the route**:
  `RoomDef` carries `listable: boolean`, false for `MATCHMAKING_ROOM`.
- Register the route **before** anything `/api/room/:roomId`-shaped — the same ordering trap
  CLAUDE.md §5 records for `/api/profile/:id`.
- A room with zero tables shows a **Create Table** CTA, which is `handleCreateRoom` with the
  venue and visibility attached.

The relay's own room-code namespace is unchanged (4 letters from `ROOM_CODE_ALPHABET`), so an
invite link to a public table still works.

Staged: **3a** types + `VENUE_ROOMS`/`normalizeVenueRoomId` (optional fields on an existing
union member add no member, so protocolParity is untouched) · **3b** the two `Room` fields, read
by nothing · **3c** `create_room` populates them, `GET /api/room/:roomId` reports them · **3d**
the listing route + `tests/tableBrowser.test.ts` · **3e** the client browser. Each green.

---

## Phase 4 — Spectators and seat swapping

This is the deepest surgery. The governing principle: **`Room.players` stays exactly as it is
— a length-2 array of playing seats — and spectators live in a parallel array.**

A unified 4-seat array was considered and rejected. `players[0]`/`players[1]` and the derived
`const oppIdx = playerIndex === 0 ? 1 : 0` are load-bearing in ~14 places across `server.ts`
(every gameplay handler, `recordRoomMatch:352-419`, `vacateSeat:1827-1900`,
`duelStartRatings:307`, `persistDuelStreaks:181`) and in every function in `server/room.ts`
(`startMatch`, `applyMatchSync`, `countReturn`, `breakStreakOnPoint`, `isRoomEmpty`,
`performanceWeight`). A parallel array touches none of them.

### `Room` and the new session type

```ts
export interface SpectatorSession {
  ws: WebSocket; playerId: string; playerName: string;
  /** Which player they sit beside. DERIVED from the slot, never taken from a message. */
  side: 0 | 1;
  deviceId: string | null; sessionId: string | null;
}

export interface Room {
  ...unchanged...
  venueRoomId: string;                          // Phase 3
  visibility: 'public' | 'private';             // Phase 3
  /** Slot 0 sits beside player 0, slot 1 beside player 1. */
  spectators: (SpectatorSession | null)[];
}
```

`SpectatorSession` deliberately has **no `playerIndex`** — a field of that name is how it
eventually gets passed to something that indexes `streaks`. It keeps `deviceId`/`sessionId` not
because a spectator is ever recorded (it never is) but because `evictStaleSockets` /
`closeDisplacedSockets` / `closeAccountSockets` (`server.ts:200-256`) walk `liveSockets` and
must be able to evict a watching socket for the same reasons they evict a playing one.

**Whether spectator seats exist goes on `RoomMatchConfig` as `spectators: boolean`** — a
sibling of `winningScore` (`src/types.ts:594-597`), normalized in `normalizeRoomConfig`. It is
already "the terms both phones play by, which the host owns and the server normalizes", it
rides `room_config` and `game_start` for free, and it is already locked during play by
`set_room_config`'s `between` guard. It must **not** go in `MatchRules`: that feeds
`isRankedRules` and `unrankedReasons`, and a seat-availability flag would surface in the
"what unranks this match" UI as though it were physics. Its default is `false`, and a room whose
`RoomDef` forbids spectators has it forced to `false` server-side.

### Socket bookkeeping — a discriminated union, not a fourth variable

Today a socket's seat is three closure variables (`server.ts:1364-1366`). Replace two of them:

```ts
type Seat = { role: 'player'; index: 0 | 1 } | { role: 'spectator'; slot: 0 | 1 };
let currentRoomId: string | null = null;
let seat: Seat | null = null;
let currentPlayerId: string = '';
const playerIndex = (): 0 | 1 | null => (seat?.role === 'player' ? seat.index : null);
```

A union rather than `playerIndex` + `spectatorSlot`, because two nullables give four states of
which only three are legal, and the illegal one (both set) is the orphaned-seat bug class
CLAUDE.md §5 already records. The union makes it unrepresentable.

The mechanical change across `server.ts:1577-1801` is then a rename: `playerIndex !== null` →
`playerIndex() !== null`. **This is the most valuable property of the design.** A spectator
socket sending `paddle_move`, `ball_pos`, `ball_cross_net`, `point_scored`, `match_sync`,
`player_ready`, `start_match`, `set_room_config`, `rematch_request`, `quick_chat` or
`rtc_signal` is refused by a guard that is *already there*. `match_sync` matters most — it can
decide a match and trigger `recordRoomMatch` (`server/room.ts:406-411`) — and it is closed for
free. Pin that with a test rather than asserting it.

### `vacateSeat` — the sharpest hazard in the feature

```ts
if (seat.role === 'spectator') { /* clear slot, broadcast table_state */ return; }
// ...today's body verbatim...
```

**The early return must come before the abandon computation, not be folded into it as another
`&&`.** `abandoned` is `bothSeated && room.inPlay && !room.matchOver && !!currentPlayerId`
(`server.ts:1843`). Every one of those four is true for a spectator closing a tab mid-rally, and
`currentPlayerId` is never cleared by `vacateSeat` today. Without the early return it would call
`recordRoomMatch(room, { winnerSeat: ... })` with a spectator's *slot* standing in for a seat
index — writing a real ranked LOSS to a real player who did nothing, plus a `db.recordAbandon`
against the spectator's own device.

Note also that `persistDuelStreaks`'s own guard does **not** save you: it is
`!room.inPlay || room.matchOver` (`server.ts:183`), and a spectator leaving mid-rally is exactly
`inPlay && !matchOver`. It would write `db.recordDuelStreak` for both players from a non-event.

Everything the spectator branch must skip: `recordRoomMatch`, `persistDuelStreaks`,
`room.ready[i]` / `room.rematchVotes[i]` (indexed by *player* seat — a slot would clear a
player's flag), `opponent_left` (the players lost nobody), `soloSince`, and `rooms.delete`.

The player branch gains one thing: when it deletes the table (`server.ts:1891-1893`) it must
`ejectSpectators` first — one shared function, also called by the reaper, for the same reason
`vacateSeat` is one implementation for two departures.

`join_room` for a table this socket already sits at must stay refused **role-independently**
(`server.ts:1486-1493`), pointing at `swap_seat`. Otherwise vacate-then-seat works by accident
and bypasses every swap guard, notably the match lock.

### The reaper: `isRoomEmpty` is already correct

`isRoomEmpty` (`server/room.ts:495-497`) asks only about `players`, so a spectator-only table is
**already** `'empty'` and swept within 15s — exactly the brief's "at least one player waiting to
play", obtained for free and as a safety net when a player's socket dies half-open and
`vacateSeat` never runs. Only its JSDoc changes, to say "empty" now means *no live player*,
which is narrower than *nobody connected*. `ReapReason` gains nothing.

One real change: the close loop at `server.ts:1294-1302` skips closing for `'empty'` on the
grounds that "an empty room has nothing attached by definition" — which stops being true.
It becomes `persistDuelStreaks` → `if (reason !== 'empty') closeLivePlayers` →
`ejectSpectators` **always**.

**`soloSince` must not be touched by spectators, in either direction.** A spectator arriving
must not clear it: clearing it exempts a one-player table from the only clock that can expire a
busy one, so a player could park a table forever by having a friend sit down — reopening the
exact `pairedAt` leak that field was rewritten to close (`server/room.ts:112-128`). After any
successful swap: `room.soloSince = (players[0] && players[1]) ? null : (room.soloSince ?? Date.now())`.
The `??` is load-bearing, or a lone host restarts the 30-minute TTL by swapping 0↔1 repeatedly.

**`lastActive` must not be written by `swap_seat` at all** — not even for players. Two
spectators swapping back and forth would otherwise hold a dead table past the idle clock.
Closing that by simply not writing the field beats closing it with a role check.

### New protocol

Flat wire seat addressing: `TableSeat = 0 | 1 | 2 | 3` (0/1 player, 2/3 spectator), mapped to
`(array, index)` at the server boundary. Clients get one namespace; the server keeps its
parallel arrays. All of these are room management, so `src/net/p2p.ts` must **not** handle them
— which `protocolParity`'s "handles nothing BUT the gameplay messages" already enforces, and
which means `p2p.ts` never learns the word "spectator". Every member stays on **one line**, and
every name is `[a-z_]` only — the parity regex sees no digits or capitals.

Client → server: `spectate_room { roomId, seat }`, `swap_seat { seat }`.

Server → client: `table_state { seats, yourSeat, spectatorsEnabled }` (declare `TableSeatInfo`
as a separate interface *above* the union so the member stays short), plus
`watched_paddle { x }`, `watched_ball { x, y }`, `watched_ball_left {}`, and `spectator_sync`.

**`spectator_sync` is the one that is easy to forget.** A spectator joining at 3-2 has missed
`game_start` and every `score_update`; the relay is the only party that knows the current state.
Without it the client renders 0-0 until the next point. Sent on arrival and on a 2↔3 side flip.

### The fan-out

The design principle: **make a spectator look, on the wire, exactly like the player it is
watching — plus one extra stream for that player's own court.** Then App.tsx's existing
`opponent_paddle` / `opponent_ball` / `ball_incoming` / `score_update` / `game_start` handlers
work unmodified.

For a spectator on side S:

| Relay event | Spectator receives | Frame |
|---|---|---|
| `paddle_move` from S | `watched_paddle { x }` | **raw, NOT mirrored** |
| `paddle_move` from 1−S | `opponent_paddle { x: 1 - x }`, byte-identical to player S's copy | pre-mirrored |
| `ball_pos` from S | `watched_ball { x, y }` | raw |
| `ball_pos` from 1−S | `opponent_ball { x, y }`, byte-identical | sender's frame |
| `ball_cross_net` from S | `watched_ball_left {}` | — |
| `ball_cross_net` from 1−S | `ball_incoming`, byte-identical to player S's copy | transformed into S's frame |
| `score_update` `game_start` `room_config` `ready_state` `rematch_state` `quick_chat` | byte-identical | absolute |
| `match_prediction` | side S's number (`server.ts:1567-1573` already computes both) | per-side |
| `match_recorded` | **never** — it carries another player's XP, missions and rank direction | — |
| `opponent_left` | **never** — `table_state` instead; the players lost nobody | — |

**The trap, stated plainly:** `watched_paddle`/`watched_ball` are the only new frames and their
rule is **raw, no transform**, because the spectator draws seat S's own court in seat S's own
coordinates. A stray `1 - x` there is the likeliest bug in the whole client change and is
invisible against a symmetric fixture — a paddle at 0.5 looks right either way. Every test must
use an asymmetric position.

Replace the four per-opponent forward sites (`server.ts:1583-1591, 1600-1610, 1633-1648,
1713-1727`) with `viewersOf(room, seat): WebSocket[]` — the player in that seat plus the
spectator beside them — and **hoist the `JSON.stringify` above the loop**, as `broadcast`
already does and those sites do not.

`ball_pos` is already sent unconditionally in every duel (`App.tsx:2344`), *not* gated on the
sonar rule, so the feed needs no new obligation on the players' clients. It arrives at 20Hz, not
60; the spectator dead-reckons between samples from the velocity `ball_incoming` already
carries. Do **not** raise `ball_pos`'s rate for spectated tables — that spends the players'
bandwidth on someone else's view.

### Spectator sonar

Forced on **client-side, for the spectator only** — `activeConfig` (`App.tsx:389-406`) gains a
spectating arm overriding `rules.opponentSonar`. It must **never** be written to `room.config`:
that field unranks the match for the *players*, so writing it would let a losing player unrank a
match on demand by having a friend sit down.

### Closing P2P properly — the client toggle is not the boundary

The host offers WebRTC when the **guest** joins, which is before any spectator can arrive. So a
spectator can join a table already on a DataChannel and watch a frozen court. Three layers:

1. *Preventive (client):* the host does not call `startAsHost()` when `config.spectators` is on.
   A hint, not a boundary.
2. **Enforcing (server): refuse `rtc_signal` when `room.config.spectators` is true** — one added
   condition at `server.ts:1729`. The relay is the only signaling path, so a modified client
   cannot bypass it. **This is the real boundary.**
3. *Residual:* a spectator arriving at an already-P2P table gets a bare `p2p_fallback`
   broadcast — but **without setting `relayCounted`**. `takeOverFromP2P` (`server.ts:339-349`)
   does both, and setting the flag when the relay has not actually counted an event makes
   `applyMatchSync` discard the peers' true streaks and peaks (`server/room.ts:348-392`) for no
   reason. Factor the broadcast out of the flag so both callers share the message but not the
   authority change.

### Seat swapping — the guards, in order

1. Socket holds a seat here (`join_room` is the way in).
2. **Strict enum membership on `msg.seat`. Do NOT use `clampInt`** — it turns junk into `lo`,
   which here is **seat 0, the host seat**. It exists for bounded gameplay scalars; for an enum
   it silently reinterprets garbage as a privileged request.
3. Target equals the seat held → silent no-op, no broadcast, no re-seed.
4. Target occupied → refuse. Test **non-null, not non-live**: a seat holding a dead socket is
   occupied until its close handler clears it, and treating it as free orphans a `PlayerSession`.
5. **The match lock**: refuse any swap touching a *player* seat when `matchSeq > 0 && !matchOver`.
   This is deliberately **stricter than** `set_room_config`'s `between = !inPlay || matchOver`
   by exactly the countdown window — `startRatings` is already sampled for that `matchSeq` by
   then, so `between` would let a swap invalidate the pre-match rating pair. A spectator↔
   spectator swap (2↔3) is exempt and allowed any time, with a `spectator_sync` re-seed.
   *A player may never become a spectator mid-match* — the bookkeeping reason is the abandon
   path, but the deeper one is that "stand up, look at the hidden half, sit back down" is a
   two-second cheat in a game whose whole premise is the blind half-court. That is the comment
   this guard deserves.
6. A swap emptying **both** player seats → refuse. `leave_room` is the only way to empty a court,
   and it is judged as an abandon.
7. Spectator target requires `room.config.spectators` — re-checked at claim time, because the
   browser is polled and can be stale.
8. Add `swap_seat` and `spectate_room` to `seatRefusal()`'s list (`server.ts:1392`): an
   uninitialized profile takes no seat of any kind. Do not tighten the cookieless fallback —
   that is the load test's path.
9. Refuse a spectator seat to a `deviceId` already seated at that table — one `.some()` over
   both arrays. Otherwise one account displaced across two devices takes two of four seats.

On success: `ready` and `rematchVotes` → `[false, false]` + broadcast (a readiness given
against opponent A is not a readiness against opponent B — `set_room_config:1784-1787`'s
reasoning); the taken player seat is re-seeded with `carriedStreak(deviceId)` and the vacated
one **zeroed** via a new pure `clearSeatStreaks(state, seat)` beside `resetStreaks`
(`server/room.ts:586-593`) — `startMatchStreaks` opens `bestStreaks` *on* `streaks`, so a stale
value becomes the next occupant's opening peak; `startRatings`/`startRatingsSeq` → `null`/`0`;
`soloSince` maintained per the `??` rule above; `match_prediction` re-fired when both player
seats are filled. Node is single-threaded, so two sockets racing one seat is safe **only** if
nothing is awaited between the occupancy check and the assignment — `carriedStreak` is
synchronous, and must stay so.

Do **not** call `persistDuelStreaks` on a swap. It is a no-op by its own guard (swaps are
pre-match), but "a seat is emptying, persist its run" is a reasonable-looking instinct and is
wrong here: nothing was ever taken from the store, so nothing needs writing back. Say so in a
comment.

**One documented rule changes.** CLAUDE.md §1: "seat 0 is only ever filled by `create_room`, so
a room whose host has gone can never have one again." With swapping that must become **the host
is whoever holds seat 0 right now; a table with no seat 0 has no host and cannot start until
somebody takes it.** `start_match`'s and `set_room_config`'s `playerIndex === 0` guards already
say exactly that and need no edit — only the doc does. The consequence is a *removal* of client
logic: `App.tsx:1660-1696`'s `strandedGuest` rule (bounce the guest when the host leaves) becomes
"the table is gone ⇒ leave", driven by the socket close the server already performs. The
alternative — an explicit `hostDeviceId` — invalidates both guards and lets a host who became a
spectator still own the settings of a match they are not in.

Teardown needs a **third** message: `App.tsx` currently says two different things on an
unexpected close depending on whether a match was live. A spectator needs "the table you were
watching has ended", or they get an abandon notice about a match they were never in.

### Also

- `GET /api/room/:roomId`'s `playerCount`/`isFull` keep meaning **players** — existing clients
  and e2e suites read them. *Add* `spectatorCount`/`spectatorsEnabled`; never redefine a field.
- `/api/health`'s `activeRooms` is asserted `=== 0` in four places in `roomLifecycle`. It stays
  true only because spectator-only tables are deleted rather than kept.
- `recordRoomMatch`'s `seatStillHoldsAccount` check is untouched — it iterates `room.players`.

---

## Phase 5 — SBMM

`server/matchmaking.ts` — a **pure** module, following the `server/room.ts` precedent (the
reason that file exists is that pure rules can be tested without booting a process, and it
carries a 95/92 coverage floor). No database, no sockets.

```ts
export interface Candidate { deviceId: string; mu: number; sigma: number; joinedAt: number; rttMs: number | null }
/** The acceptable win-probability window, widening with wait time. */
export function bandFor(waitedMs: number): { lo: number; hi: number };
export function findPair(queue: Candidate[], now: number): [Candidate, Candidate] | null;
```

Band schedule, per your decision:

| Waited | Window |
|---|---|
| 0-30s | 0.45 – 0.55 |
| 30-90s | 0.40 – 0.60 |
| 90s+ | widens linearly toward 0.20 – 0.80, so a lone queuer eventually always matches |

The band is evaluated on the **more-waited** of the two candidates. Among candidates inside the
band, prefer the one closest to 0.50; break remaining ties on measured RTT.

**RTT.** The only latency signal in the repo is a display-only `pingMs` computed client-side
(`App.tsx:1699`) and never sent anywhere. Phase 5 has `queue_join` carry the client's last
measured RTT as a hint. It is a tiebreak only and is never trusted for anything — a modified
client can forge it, and forging it buys nothing but a slightly better-connected opponent.
**No geolocation** — there is no IP handling anywhere in the repo and adding one is a privacy
surface this does not need.

Four new WS messages, exactly as `useQuickMatch.ts:12` predicted:

- client: `queue_join`, `queue_cancel`, `queue_accept`
- server: `queue_state` (searching / found / cancelled), plus the existing `room_joined` once
  the pair is seated

Each union member in `src/types.ts` must stay on **one line** —
`tests/protocolParity.test.ts` parses the union to the first line-ending semicolon and a
multi-line member truncates the whole parse. Queue messages are room management, not gameplay,
so `server.ts` must dispatch a literal `msg.type === 'queue_join'` and `src/net/p2p.ts` must
**not** handle them at all — `protocolParity`'s "handles nothing BUT the gameplay messages"
assertion enforces that direction, and `sendGame` already returns `false` for room management.
Every new *server* message needs a real `case` in `App.tsx` in the **same commit** as the union
member, or CI is red in between.

On a pair: the relay creates a table in `MATCHMAKING_ROOM` with `visibility: 'private'` and
spectator seats **disabled**, seats both players, and sends each `queue_state { status:
'found' }` followed by the ordinary `room_joined` / `room_config` / `ready_state` flow. From
that moment it is an ordinary table and every existing rule applies unchanged.

`useQuickMatch` is rewired to send those messages and flips `available: true`. Its `QueueState`
union and `join`/`cancel`/`accept` signatures do not change — the stub's whole point.
`MainMenu.tsx:362-381` drops `data-stub`, `aria-disabled` and the SOON chip; the
`#quickmatch-info-sheet` becomes the searching UI.

After 45 seconds with no candidate the searching UI additionally offers "open a public table
instead", which drops the player into the PVP room browser for their bracket. The search keeps
running underneath.

---

## Files

**New:** `src/venues.ts`, `server/matchmaking.ts`, `src/components/TableBrowser.tsx`,
`src/components/BuildingNav.tsx`, `tests/venues.test.ts`, `tests/tableBrowser.test.ts`,
`tests/spectators.test.ts`, `tests/matchmaking.test.ts`, `tests/chaosRelabel.test.ts`,
`scripts/e2e-venues.mjs`, `scripts/e2e-spectate.mjs`.

`src/venues.ts` and `server/matchmaking.ts` are pure shared rules and get their own floors in
`vite.config.ts`'s `FLOORS`, following the `server/room.ts` precedent (95/92). Note also that
`coverage.include` already covers `src/*.ts` and `server/**/*.ts`, so both land in the report
whether or not they are gated.

**Heavily touched:** `src/rating.ts`, `src/game/physics.ts`, `src/achievements.ts`,
`src/types.ts`, `server/room.ts`, `server.ts`, `server/db.ts`, `src/App.tsx`,
`src/components/MainMenu.tsx`, `src/components/MultiplayerLobby.tsx`, `src/net/p2p.ts`,
`src/net/useQuickMatch.ts`, `src/i18n/translations.ts`.

**Docs, in the same commits as the code:** `CLAUDE.md` §1 (navigation, spectators), §3 (the AI
ladder), §5 (both protocol tables + the REST inventory), §7 (anchors, competence, the solo cap,
the unlock chain); `TESTING.md` §2 and §5.

---

## Verification

Per phase, in order — each must pass before the next commit:

```bash
npm run lint
npm test
npm run test:coverage      # per-module floors; new modules get their own
npm run build
npm run test:e2e           # needs the build
```

Targeted checks:

- **Phase 1.** `npx vitest run tests/physics.test.ts tests/rating.test.ts` repeatedly (≥10×) —
  return rates are samples and the ladder-spread assertion is the one made on a *difference*.
  Confirm the measured rates match the table above before fixing the bounds.
  `node scripts/e2e-run.mjs rating achievements`.
- **Phase 2.** `node scripts/e2e-run.mjs tutorial` — the tour walks the real menu, and the new
  `nav` state is the fourth thing its scrim can leak into. New `scripts/e2e-venues.mjs`: a
  gated room shows locked with a readable reason, an open one reaches the pre-match sheet.
- **Phase 3.** Extend `tests/roomLifecycle.test.ts` (real server): a public table appears in
  `GET /api/rooms/:id/tables`, disappears when its host leaves, and a private one never
  appears. `node scripts/e2e-run.mjs duel lobby invite` must stay green — today's invite flow
  is `visibility: 'private'` and must not change.
- **Phase 4**, staged so the riskiest commit is isolated: **4a** `server/room.ts` only
  (`SpectatorSession`, `Room.spectators`, `clearSeatStreaks`, the `isRoomEmpty` JSDoc) + the
  three-line `room()` factory fix + new pure tests · **4b** `RoomMatchConfig.spectators` through
  `normalizeRoomConfig` — **re-verify `tests/p2pParity.test.ts` here**, since `game_start.config`
  must carry an identical value on both transports · **4c** the `Seat`-union bookkeeping
  refactor of `server.ts`, spectator branch unreachable because nothing seats one yet.
  **Green with zero test changes is the acceptance criterion for 4c, and it is the commit to
  review hardest** · **4d** seating, `table_state`, `spectator_sync`, `ejectSpectators` ·
  **4e** the fan-out and the watched-court rendering · **4f** `swap_seat` · **4g** the
  `rtc_signal` refusal and the CLAUDE.md §1/§5 edits.

  New `tests/spectators.test.ts` on the real relay: a third socket takes a spectator seat and
  receives `watched_paddle` at an **asymmetric** position (0.5 passes either way — the `1 - x`
  trap); a spectator sending `match_sync`, `point_scored` and `start_match` changes nothing;
  a spectator leaving a live duel records **no** match and **no** abandon (assert via
  `/api/profile/:id/matches`); a spectator arriving does **not** clear `waitingMs`; the last
  player leaving deletes the table and closes the spectator's socket.
  New `scripts/e2e-spectate.mjs` drives three browser contexts.
  `npx vitest run tests/p2pParity.test.ts tests/protocolParity.test.ts tests/room.test.ts
  tests/roomLifecycle.test.ts tests/duelRecord.test.ts tests/matchRules.test.ts`.
- **Phase 5.** `tests/matchmaking.test.ts` pins `bandFor` at each boundary and `findPair`'s
  preference order, plus the property that two queuers who are inside the band are always
  paired. A relay-booting test that two devices calling `queue_join` end up seated in the same
  table. `node scripts/e2e-run.mjs` in full.

Manual: `npm run dev`, two phone contexts plus a third for the spectator seat.
