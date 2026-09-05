---
name: phong-persistence
description: >-
  Adding a playerId-keyed table, a column, a one-shot migration or a new write path in Phong's
  SQLite store (server/db.ts). Use this whenever the work touches the schema, PLAYER_KEYED_TABLES,
  moveAccount, deleteAccount, recordMatch, the meta-flagged migrations or the wipe_v* keys — and
  whenever the user asks to persist something new, store a stat, add a daily counter, back-fill
  existing rows or reset player data. A table added without being claimed here is not a style
  problem: it orphans rows on sign-in, silently pays a match twice, or leaves a full-screen wall
  in front of an account that exists nowhere.
---

# Touching the store

`server/db.ts` holds every row a player owns. Three rules govern anything new, and all three
have already been learned the hard way.

## 1. A rename is a rule about every table keyed on the name

`moveAccount` **renames `players.id`** — a player id *is* a device id. Any table keyed on it
must move in the same transaction or be orphaned by the rename. So a new `playerId`-keyed
table goes in `PLAYER_KEYED_TABLES`, which both `moveAccount` and `deleteAccount` walk.

This has been missed twice, and the second time was not litter:

- `player_mode_stats` was missed, so an account arrived on its new browser having played
  nothing, every carried streak back at zero — and the next match wrote that zero over the run
  the player actually had.
- Then the whole day-keyed family was missed. Orphaned `recorded_matches` stamps meant every
  match already paid for **could be paid again** by a queued or duplicate report landing after
  a sign-in; `elite_completions` left behind silently took back permanent theme unlocks.

Note the ordering inside the loop: each table clears the *claiming* device's own rows first,
because the primary keys would otherwise collide with the rows moving in.

**`matches` is the deliberate exception.** Every seat files its own row, so a duel produces
two and the second is the opponent's record of a game they played. Deletion scrubs the
pointers (`DELETED_PLAYER_ID`/`DELETED_PLAYER_NAME`) and keeps the row. History reads are
`player1Id`-only for the same reason — matching `player2Id` too is exactly how every duel
used to render twice.

**`device_links` is the row that bites.** Outliving what it points at, it resolves as
`superseded`, which is a full-screen wall telling a player their account is live elsewhere
when it is live nowhere. `wipe_v1` shipped without dropping it and learned this.

## 2. The list is checked against the live schema

`tests/identity.test.ts` reads `sqlite_master`, finds every table with a `playerId` column, and
fails when one exists that `PLAYER_KEYED_TABLES` does not name. It also populates every table
in the list and asserts the whole set arrives under the new id with nothing left behind.

That means **the suite tells you what you forgot** — but only if you run it:

```bash
npx vitest run tests/identity.test.ts tests/accountDeletion.test.ts tests/db.test.ts
```

If your table is deliberately not player-keyed, it will not be caught, and it also will not be
moved. Make that a decision.

## 3. A one-shot migration is flagged, and a wipe re-stamps everything

Non-destructive fixes (`placement_sigma_v1`, `tasks_reset_v1`, `ranked_backfill_v1`,
`chaos_relabel_v1`) and destructive wipes (`wipe_v1`…`wipe_v4`) are keyed in the `meta` table
so each runs at most once per database.

The mechanism has one sharp edge: **every wipe clears `meta`, so every wipe must re-stamp ALL
the keys.** A half-stamped sibling re-fires on the next boot and the pair wipe alternately,
forever.

Two more things about migrations here:

- **Order matters when meanings change.** `ranked_backfill_v1` classifies legacy rows under
  the *old* meaning of a field, so `chaos_relabel_v1` — which hands the name `chaos` to a
  different difficulty — runs after it.
- **Shipping a column with no backfill is a bug.** The `ranked` column shipped without one and
  a live server's entire history rendered Un-Ranked. A NULL still reads as un-ranked as the
  safety net, but the backfill is what makes the data true.

Each migration gets a suite: `db-wipe`, `taskReset`, `placementRescue`, `rankedBackfill`,
`chaosRelabel`, `advancedLadder` (which covers both of the history-column backfills),
`botIdentity` (`bot_accounts_backfill_v1`).

**A one-shot is INVISIBLE to any test that does not un-stamp it and re-import.** Its key is
already in `meta` by the time a suite runs, so nothing drives it and a mutation to its SQL
reddens nothing — measured. Clear the key, `vi.resetModules()`, re-import `server/db`, and assert
the repair actually happened.

**`playerId` is not the only identity-bearing column, and the live-schema walk cannot see the
others.** `competitive_exposure` names TWO accounts (`playerId` and `oppId`): the first moves
through `PLAYER_KEYED_TABLES` and the second is rewritten explicitly by `moveAccount` and deleted
by `deleteAccount`. Rewriting the SQL correctly and still resetting the counter look identical at
the schema level, so assert the CONTINUITY — the same pair's rolling count carries across a
move — and not just the absence of the old id. `bot_accounts` is the mirror case: its column is
`botId` deliberately, because a bot has no browser to be moved to and naming it `playerId` would
force the roster into a list that carries rows onto a human's new device.

**`bot_accounts` is the sole authoritative RUNTIME CLASSIFIER of bot identity, and it is cached.**
`isBotAccount` reads an in-memory `Set`; the `bot-` prefix decides nothing and survives only where
code reasons about the identifier NAMESPACE (the insert naming guard, the legacy backfill,
`isLinkableId`). The cache is derived state with a lifecycle rule: after any COMMITTED mutation it
must equal the table, so mutate it AFTER the transaction and never inside one. A rollback that
left an id in the Set makes an ordinary human classify as a bot — reduced stakes on somebody
else's rating — and because the table is the SOLE classifier, nothing downstream can notice.

**`meta` is not only for migration flags.** Three rows hold the backup schedule —
`backup_attempt_at`, `backup_ok_at`, `backup_upload_ok_at` — and they are there rather than in
`BACKUP_DIR` on purpose: the backup directory is the thing that may be ephemeral, and a stamp
that vanishes makes every boot "due", which on a crash-loop is a backup storm. They are not
`playerId`-keyed, so they are correctly absent from `PLAYER_KEYED_TABLES` and are neither
moved by `moveAccount` nor cleared by `deleteAccount`; they describe the SERVER, not a player.
A wipe clears `meta`, which loses them — harmless, since the next boot reads "never" and takes
a backup, and a wipe is the one moment there is nothing worth backing up.

**A backup is why deleting an account is complete in the database and not in the system.** Up
to `DEFAULT_BACKUP_KEEP` daily snapshots still contain the erased row until they age out, and
`src/legal.ts` says so in the privacy notice with `tests/legal.test.ts` holding the number
against the constant. If you change the retention, change the sentence in the same commit.

## Writing inside `recordMatch`

Everything it derives — the profile upsert, the match row, the `recorded_matches` stamp, the
per-mode bump, the daily tallies — rides **one transaction**. The per-mode bump in particular
has no ceiling of its own (matches played and points only ever add), so a bump that landed
while the match went unstamped would be counted again by the client's retry, and again by the
next one.

And the standing rule above all of it: **never add a match-recording path without a
`matchKey`.** A duel legitimately arrives up to three times — the relay writes it for both
seats, both clients POST it as a fallback, the on-device queue may replay it. `duelMatchKey()`
is the only thing that says they are the same match.

**Never add a route that takes an XP amount from the client.** The localStorage missions this
replaced were claimed via a client-chosen `xpDelta` on `PUT /api/profile/me`, which was
verified to take a profile from level 1 to 15 in ten requests.

## Resetting locally

`npm run db:reset -- --yes` (server stopped first). `node dist/admin.cjs whois <username>` is
the read-only support CLI (and `backups` there answers when this server last backed itself up) — it deliberately does not import `db.ts`, whose constructor would
run migrations and seed bots as a side effect of answering a support question.
