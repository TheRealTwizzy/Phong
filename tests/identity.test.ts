import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import type { MatchEndPayload } from '../src/types';
import { DELETED_PLAYER_ID, DELETED_PLAYER_NAME } from '../src/profileRules';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-identity-test-'));
process.env.DATA_DIR = TMP;
const DB_FILE = path.join(TMP, 'phong.db');

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let db: typeof import('../server/db').db;
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let PLAYER_KEYED_TABLES: typeof import('../server/db').PLAYER_KEYED_TABLES;
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let auth: typeof import('../server/auth');

beforeAll(async () => {
  ({ db, PLAYER_KEYED_TABLES } = await import('../server/db'));
  auth = await import('../server/auth');
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const win = (playerId: string): MatchEndPayload => ({
  playerId,
  username: 'Mover',
  playerScore: 5,
  opponentScore: 2,
  bestStreak: 6, endStreak: 0, earnedStreak: 6,
  mode: 'multiplayer',
  isWinner: true,
});

// Onboard a device with a chosen username (matches require initialization).
const init = (id: string, username: string) => {
  db.getProfile(id);
  const result = db.initializeProfile(id, username);
  if (!result.ok) throw new Error(`init failed: ${result.code}`);
  return result.profile!;
};

describe('device tokens', () => {
  it('mint/verify round-trips', () => {
    const id = auth.mintDeviceId();
    expect(id).toMatch(/^dev_[0-9a-f]{18}$/);
    const token = auth.mintToken(id);
    expect(auth.verifyToken(token)).toBe(id);
  });

  it('rejects tampered ids and signatures', () => {
    const token = auth.mintToken(auth.mintDeviceId());
    const [v, id, mac] = token.split('.');
    const otherId = auth.mintDeviceId();
    expect(auth.verifyToken(`${v}.${otherId}.${mac}`)).toBeNull();
    expect(auth.verifyToken(`${v}.${id}.${mac}x`)).toBeNull();
    expect(auth.verifyToken('v1.not-a-device.abc')).toBeNull();
    expect(auth.verifyToken(undefined)).toBeNull();
    expect(auth.verifyToken('garbage')).toBeNull();
  });

  it('extracts the device id from a cookie header', () => {
    const id = auth.mintDeviceId();
    const header = `foo=bar; ${auth.DEVICE_COOKIE}=${auth.mintToken(id)}; baz=1`;
    expect(auth.deviceIdFromCookieHeader(header)).toBe(id);
    expect(auth.deviceIdFromCookieHeader('foo=bar')).toBeNull();
    expect(auth.deviceIdFromCookieHeader(undefined)).toBeNull();
  });
});

describe('sign-in codes and the browsers an account belongs to', () => {
  it('every new profile gets a well-formed unique code', () => {
    const a = db.getProfile('dev_aaaaaaaaaaaaaaaaaa');
    const b = db.getProfile('dev_bbbbbbbbbbbbbbbbbb');
    expect(a.recoveryCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(b.recoveryCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(a.recoveryCode).not.toBe(b.recoveryCode);
  });

  it('signing in moves the profile and its history, and the code still works', () => {
    // A cookie jar does not cross browsers, so signing in somewhere else is
    // the ordinary case — an invitation tapped in a chat app opens a webview
    // that is not the browser the account was made in. It used to be a one-way
    // transfer that also spent the only credential that could undo it.
    const oldDevice = 'dev_111111111111111111';
    const newDevice = 'dev_222222222222222222';
    init(oldDevice, 'Mover');
    db.recordMatch(win(oldDevice));
    const code = db.getProfile(oldDevice).recoveryCode!;

    const signedIn = db.signInWithCode(code, newDevice);
    expect(signedIn).not.toBeNull();
    expect(signedIn!.id).toBe(newDevice);
    expect(signedIn!.username).toBe('Mover');
    expect(signedIn!.matchesWon).toBe(1);
    // The code is a credential the player keeps, not a one-shot token.
    expect(signedIn!.recoveryCode).toBe(code);
    // Match history followed the move
    const hist = db.getMatchHistory(newDevice);
    expect(hist.length).toBe(1);
    expect(hist[0].winnerId).toBe(newDevice);

    // Both browsers now belong to the account, and the one that handed it
    // over is NOT tombstoned — `released` is the state whose only exit used to
    // be destroying the account.
    expect(db.releasedDevice(oldDevice)).toBeNull();
    expect(db.linkedAccount(oldDevice)).toEqual({ playerId: newDevice, holdsIt: false });
    expect(db.linkedAccount(newDevice)).toEqual({ playerId: newDevice, holdsIt: true });
  });

  it('a browser that has signed in can take the account back with no code', () => {
    const first = 'dev_777777777777777771';
    const second = 'dev_777777777777777772';
    init(first, 'RoamsBack');
    const code = db.getProfile(first).recoveryCode!;
    db.signInWithCode(code, second);
    expect(db.linkedAccount(first)!.holdsIt).toBe(false);

    // Presenting the device cookie of a member IS the credential; the code is
    // what gets a browser into the set, not what it shows every time after.
    const back = db.reclaimLinkedAccount(first, 'ses_000000000000000000000001');
    expect(back).not.toBeNull();
    expect(back!.id).toBe(first);
    expect(back!.username).toBe('RoamsBack');
    expect(db.linkedAccount(second)).toEqual({ playerId: first, holdsIt: false });
    // ...and it can go back and forth, which is the point.
    expect(db.reclaimLinkedAccount(second, null)!.id).toBe(second);
  });

  it('refuses to reclaim for a browser that never signed in', () => {
    expect(db.reclaimLinkedAccount('dev_999999999999999999', null)).toBeNull();
  });

  it('rotating the code retires the old one', () => {
    const dev = 'dev_888888888888888881';
    init(dev, 'Rotator');
    const first = db.getProfile(dev).recoveryCode!;
    const next = db.rotateRecoveryCode(dev);
    expect(next).not.toBe(first);
    expect(db.getProfile(dev).recoveryCode).toBe(next);
    // The retired code no longer opens anything.
    expect(db.profileByRecoveryCode(first)).toBeNull();
    expect(db.profileByRecoveryCode(next!)!.id).toBe(dev);
  });

  it('sign-in accepts unformatted input and rejects unknown codes', () => {
    const dev = 'dev_333333333333333333';
    const target = 'dev_444444444444444444';
    const code = init(dev, 'CaseTest').recoveryCode!;
    const sloppy = code.toLowerCase().replace('-', ' ');
    const claimed = db.signInWithCode(sloppy, target);
    expect(claimed?.username).toBe('CaseTest');
    expect(db.signInWithCode('ZZZZ-ZZZZ', target)).toBeNull();
  });

  it('signing in replaces the throwaway profile already on the device', () => {
    const source = 'dev_555555555555555555';
    const device = 'dev_666666666666666666';
    db.getProfile(device); // uninitialized throwaway
    const code = init(source, 'Keeper').recoveryCode!;
    // Played once, so the claimed profile qualifies for the board — which is
    // what makes the no-duplicate-rows assertion below mean something.
    db.recordMatch({
      playerId: source, username: 'Keeper', playerScore: 5, opponentScore: 1,
      bestStreak: 4, endStreak: 0, earnedStreak: 4, mode: 'multiplayer', isWinner: true,
    } as never);
    const claimed = db.signInWithCode(code, device);
    expect(claimed!.username).toBe('Keeper');
    // The throwaway row is gone (no duplicate ids, leaderboard stays clean)
    const board = db.getLeaderboard('elo', 100);
    expect(board.filter((e) => e.id === device).length).toBe(1);
  });

  it('the avatar follows the profile on sign-in', () => {
    const source = 'dev_aaaaaaaaaaaaaaaa01';
    const device = 'dev_aaaaaaaaaaaaaaaa02';
    init(source, 'AvatarOwner');
    db.setAvatar(source, new Uint8Array([1, 2, 3, 4]));
    const code = db.getProfile(source).recoveryCode!;

    const claimed = db.signInWithCode(code, device);
    expect(claimed!.hasAvatar).toBe(true);
    expect(db.getAvatar(device)).not.toBeNull();
    expect(db.getAvatar(source)).toBeNull();
  });

  it('the per-mode history, and the run each mode is on, follow it too', () => {
    // players.id IS the device id, so a sign-in RENAMES the row — and every
    // table keyed on that id has to be renamed with it or it is orphaned.
    // player_mode_stats was not, so an account arrived on the new browser
    // having played nothing, with every carried streak back at zero; the next
    // match recorded there then wrote that zero over the run the player had.
    const source = 'dev_aaaaaaaaaaaaaaaa11';
    const device = 'dev_aaaaaaaaaaaaaaaa12';
    init(source, 'ModeMover');
    db.recordMatch({
      playerId: source, username: 'ModeMover', playerScore: 5, opponentScore: 1,
      bestStreak: 12, endStreak: 12, earnedStreak: 12, mode: 'solo',
      difficulty: 'rookie', isWinner: true,
    } as never);
    db.recordPractice(source, { bestStreak: 6, earnedStreak: 6, endStreak: 6 });
    const before = db.getProfile(source);
    expect(before.modeStats?.solo?.currentStreak).toBe(12);

    const claimed = db.signInWithCode(before.recoveryCode!, device);
    expect(claimed!.modeStats?.solo?.currentStreak).toBe(12);
    expect(claimed!.modeStats?.solo?.matchesWon).toBe(1);
    expect(claimed!.modeStats?.practice?.currentStreak).toBe(6);
    // And nothing is left behind under the old id to diverge from it.
    expect(db.getProfile(source).modeStats?.solo).toBeUndefined();
  });

  it('does not collide with per-mode rows already on the claiming browser', () => {
    // The primary key is (playerId, mode), so rows moving onto a device that
    // already has its own would violate it. They are cleared first, exactly
    // as that device's avatar is — and this is reachable rather than
    // belt-and-braces: any account moved by a build before the line above
    // existed left its per-mode rows orphaned under the old device id, and
    // signing back into that browser walks straight into them.
    const source = 'dev_aaaaaaaaaaaaaaaa13';
    const device = 'dev_aaaaaaaaaaaaaaaa14';
    init(source, 'CollideOwner');
    db.recordMatch({
      playerId: source, username: 'CollideOwner', playerScore: 5, opponentScore: 0,
      bestStreak: 20, endStreak: 20, earnedStreak: 20, mode: 'solo',
      difficulty: 'rookie', isWinner: true,
    } as never);
    // The claiming browser has a solo row of its own to be displaced.
    init(device, 'CollideSquatter');
    db.recordMatch({
      playerId: device, username: 'CollideSquatter', playerScore: 5, opponentScore: 3,
      bestStreak: 3, endStreak: 3, earnedStreak: 3, mode: 'solo',
      difficulty: 'rookie', isWinner: true,
    } as never);
    expect(db.getProfile(device).modeStats?.solo?.currentStreak).toBe(3);

    const code = db.getProfile(source).recoveryCode!;
    const claimed = db.signInWithCode(code, device);
    expect(claimed!.username).toBe('CollideOwner');
    // The arriving account's run, not the displaced one's and not a merge.
    expect(claimed!.modeStats?.solo?.currentStreak).toBe(20);
  });

  it('never leaks recovery codes through the leaderboard', () => {
    const rows = db.getLeaderboard('elo', 100) as unknown as Array<Record<string, unknown>>;
    expect(rows.every((r) => !('recoveryCode' in r))).toBe(true);
  });
});

// Deleting an account: the same rule the rename above holds to, with nowhere
// for a missed row to go.
//
// `moveAccount` renames players.id and every table keyed on it has to move in
// the same transaction or be orphaned — player_mode_stats was missed once and
// an account arrived on its new browser having played nothing. A delete is
// that rule with a sharper edge: a surviving row does not merely diverge, it
// points at an account that is not there. The one that bites is device_links,
// where "linked but not holding" resolves as `superseded` — a full-screen wall
// telling another of the player's browsers that the account is live somewhere
// else, about an account that exists nowhere at all.

/** Every table in the live schema that keys rows by a `playerId` column. */
function playerKeyedTablesInSchema(): string[] {
  const raw = new DatabaseSync(DB_FILE, { readOnly: true });
  try {
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as unknown as Array<{ name: string }>;
    return tables
      .filter((tbl) => {
        const cols = raw.prepare(`PRAGMA table_info(${tbl.name})`).all() as unknown as Array<{ name: string }>;
        return cols.some((c) => c.name === 'playerId');
      })
      .map((tbl) => tbl.name)
      .sort();
  } finally {
    raw.close();
  }
}

describe('moving an account', () => {
  it('carries every playerId-keyed table to the new device', () => {
    // moveAccount walks PLAYER_KEYED_TABLES now, but this test is what makes
    // that stick: it populates every table in the list under the old device
    // and asserts the whole set arrives under the new one, so a table added
    // to the schema (and, via the invariant test below, to the list) is
    // automatically part of the contract. The bug this pins down: the move
    // used to carry only avatars and player_mode_stats, and the orphaned
    // recorded_matches stamps meant every match the account had already been
    // paid for could be paid AGAIN after a sign-in — while elite_completions
    // (permanent theme unlocks) and the daily tables were silently lost.
    const from = 'dev_aaaaaaaaaaaaaaaa31';
    const to = 'dev_aaaaaaaaaaaaaaaa32';
    init(from, 'Carrier');
    db.setAvatar(from, new Uint8Array([1, 2, 3, 4]));
    const hand = db.getMissions(from); // deals: slots + recent_missions
    expect(db.rerollMission(from, hand[0].id).ok).toBe(true); // daily_rerolls
    db.recordMatch({ ...win(from), matchKey: 'move:duel:1' } as never); // mode stats + recorded_matches
    db.recordAbandon(from, { ranked: false }); // daily_abandons
    db.recordPractice(from, { bestStreak: 4, earnedStreak: 4, endStreak: 4 }); // daily_practice
    // The two tables nothing above reaches deterministically (mission
    // progress only advances for tasks the dealt hand happens to hold, and an
    // elite completion needs a finished elite task) get their rows by hand.
    const seed = new DatabaseSync(DB_FILE);
    try {
      seed.prepare(
          'INSERT INTO daily_missions (playerId, dayKey, missionId, progress) VALUES (?, ?, ?, ?)'
        )
        .run(from, '2020-01-01', 'seed_mission', 1);
      seed.prepare(
          'INSERT INTO elite_completions (playerId, missionId, unlockId, completedAt) VALUES (?, ?, ?, ?)'
        )
        .run(from, 'seed_elite', 'void-runner', new Date().toISOString());
    } finally {
      seed.close();
    }

    // Precondition: every table in the list actually holds rows under the old
    // id — otherwise the assertions below would pass vacuously.
    const countRows = (raw: DatabaseSync, table: string, id: string): number =>
      (raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE playerId = ?`).get(id) as { n: number }).n;
    const before = new Map<string, number>();
    {
      const raw = new DatabaseSync(DB_FILE, { readOnly: true });
      try {
        for (const table of PLAYER_KEYED_TABLES) {
          const n = countRows(raw, table, from);
          expect({ table, populated: n > 0 }).toEqual({ table, populated: true });
          before.set(table, n);
        }
      } finally {
        raw.close();
      }
    }

    const code = db.getProfile(from).recoveryCode!;
    expect(db.signInWithCode(code, to)).not.toBeNull();

    const raw = new DatabaseSync(DB_FILE, { readOnly: true });
    try {
      for (const table of PLAYER_KEYED_TABLES) {
        expect({ table, left: countRows(raw, table, from) }).toEqual({ table, left: 0 });
        expect({ table, moved: countRows(raw, table, to) }).toEqual({
          table,
          moved: before.get(table),
        });
      }
    } finally {
      raw.close();
    }
  });

  it('still pays a moved account exactly once per match', () => {
    // The concrete cost of an orphaned stamp: a queued or retried copy of a
    // match the account was already paid for, replayed after a sign-in, was
    // paid in full a second time — XP, matchesPlayed, wins, rankedGames.
    const from = 'dev_aaaaaaaaaaaaaaaa33';
    const to = 'dev_aaaaaaaaaaaaaaaa34';
    init(from, 'PaidOnce');
    const first = db.recordMatch({ ...win(from), matchKey: 'move:dup:1' } as never);
    const code = db.getProfile(from).recoveryCode!;
    expect(db.signInWithCode(code, to)).not.toBeNull();

    const moved = db.getProfile(to);
    expect(moved.matchesPlayed).toBe(1);

    const replay = db.recordMatch({ ...win(from), playerId: to, matchKey: 'move:dup:1' } as never);
    expect(replay.alreadyRecorded).toBe(true);
    // A replay reports what the match paid the first time — and pays nothing.
    expect(replay.earnedXp).toBe(first.earnedXp);
    const after = db.getProfile(to);
    expect(after.matchesPlayed).toBe(1);
    expect(after.matchesWon).toBe(1);
    expect(after.xp).toBe(moved.xp);
  });
});

describe('deleting an account', () => {
  it('names every playerId-keyed table the schema actually has', () => {
    // The list deleteAccount walks is hand-written, so this is the thing that
    // fails when a table is added without being added to it — the same way
    // player_mode_stats was added without being added to moveAccount. Proven
    // able to fail by dropping a name from PLAYER_KEYED_TABLES.
    //
    // device_links is the one deliberate omission: its rows have to go by
    // BOTH columns (every browser of the account, not only the id the account
    // lives under), so deleteAccount handles it by hand rather than in the
    // loop. Named here so the exception is a decision and not a gap.
    const HANDLED_APART = ['device_links'];
    expect(playerKeyedTablesInSchema()).toEqual(
      [...PLAYER_KEYED_TABLES, ...HANDLED_APART].sort()
    );
  });

  it('erases the account, everything keyed on it, and frees the name', () => {
    const device = 'dev_aaaaaaaaaaaaaaaa21';
    init(device, 'Departing');
    db.setAvatar(device, new Uint8Array([9, 9, 9, 9]));
    db.recordMatch({
      playerId: device, username: 'Departing', playerScore: 5, opponentScore: 1,
      bestStreak: 9, endStreak: 9, earnedStreak: 9, mode: 'solo',
      difficulty: 'rookie', isWinner: true, matchKey: 'delete:solo:1',
    } as never);
    db.recordPractice(device, { bestStreak: 4, earnedStreak: 4, endStreak: 4 });
    // Held tasks, a reroll allowance row, a day-keyed abandon: the day-keyed
    // working state a live account accumulates without being asked.
    db.getMissions(device);

    const before = db.getProfile(device);
    expect(before.initialized).toBe(true);
    expect(before.modeStats?.solo?.currentStreak).toBe(9);

    const result = db.deleteAccount(device);
    expect(result.deleted).toBe(true);
    expect(result.username).toBe('Departing');

    // Nothing left in any table that keys off the id.
    const raw = new DatabaseSync(DB_FILE, { readOnly: true });
    try {
      for (const table of PLAYER_KEYED_TABLES) {
        const row = raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE playerId = ?`).get(device) as { n: number };
        expect({ table, n: row.n }).toEqual({ table, n: 0 });
      }
      const players = raw.prepare('SELECT COUNT(*) AS n FROM players WHERE id = ?').get(device) as { n: number };
      expect(players.n).toBe(0);
      const links = raw.prepare('SELECT COUNT(*) AS n FROM device_links WHERE deviceId = ? OR playerId = ?')
        .get(device, device) as { n: number };
      expect(links.n).toBe(0);
    } finally {
      raw.close();
    }

    // The name is back in the pool, and the browser is a new player rather
    // than a walled-off one: getProfile mints it a fresh, uninitialized row.
    expect(db.isUsernameAvailable('Departing')).toBe(true);
    expect(db.isUsernameAvailable('departing')).toBe(true);
    const after = db.getProfile(device);
    expect(after.initialized).toBe(false);
    expect(after.modeStats?.solo).toBeUndefined();
    expect(after.recoveryCode).not.toBe(before.recoveryCode);
    // And that fresh row can claim the freed name, which is what "released
    // back into the pool" has to mean for the player who wants it back.
    expect(db.initializeProfile(device, 'Departing').ok).toBe(true);
  });

  it('takes the sign-in code with it, and every browser signed in to it', () => {
    const first = 'dev_aaaaaaaaaaaaaaaa22';
    const second = 'dev_aaaaaaaaaaaaaaaa23';
    init(first, 'MultiBrowser');
    const code = db.getProfile(first).recoveryCode!;
    // A second browser signs in — the account moves to it and BOTH are members.
    expect(db.signInWithCode(code, second)).not.toBeNull();
    expect(db.linkedDevices(second).map((d) => d.deviceId).sort()).toEqual([first, second].sort());

    const result = db.deleteAccount(second);
    expect(result.deleted).toBe(true);
    // Both browsers are reported, so the caller can shut both their sockets.
    expect([...result.devices].sort()).toEqual([first, second].sort());

    // The code matches nothing, and — the part that bites — neither browser is
    // left linked to a playerId that no longer exists. A surviving link
    // resolves as `superseded`: a wall saying the account is live elsewhere.
    expect(db.profileByRecoveryCode(code)).toBeNull();
    expect(db.signInWithCode(code, first)).toBeNull();
    expect(db.linkedAccount(first)).toBeNull();
    expect(db.linkedAccount(second)).toBeNull();
    expect(db.reclaimLinkedAccount(first, 'ses_000000000000000000000000')).toBeNull();
  });

  it("keeps the opponent's own record of the match, minus the pointers", () => {
    // Every seat files its OWN match row (recordMatch writes the reporter as
    // player1), so a duel produces two. Deleting the opponent's copy would
    // take a game they played out of their history while their career
    // counters — which are not derived from that table — went on counting it.
    const leaver = 'dev_aaaaaaaaaaaaaaaa24';
    const stayer = 'dev_aaaaaaaaaaaaaaaa25';
    init(leaver, 'Leaver');
    init(stayer, 'Stayer');
    db.recordMatch({
      playerId: stayer, username: 'Stayer', opponentId: leaver, opponentName: 'Leaver',
      playerScore: 3, opponentScore: 5, bestStreak: 4, endStreak: 4, earnedStreak: 4,
      mode: 'multiplayer', isWinner: false, matchKey: 'delete:duel:1',
    } as never);
    db.recordMatch({
      playerId: leaver, username: 'Leaver', opponentId: stayer, opponentName: 'Stayer',
      playerScore: 5, opponentScore: 3, bestStreak: 6, endStreak: 6, earnedStreak: 6,
      mode: 'multiplayer', isWinner: true, matchKey: 'delete:duel:1',
    } as never);
    // Two rows in the table, ONE in each player's history: a duel is filed
    // once per seat, and getMatchHistory reads only the row the player filed
    // themselves (player1) — reading both id columns is how every duel used
    // to show up twice. What matters below is which row survives whom.
    expect(db.getMatchHistory(leaver).length).toBe(1);
    expect(db.getMatchHistory(stayer).length).toBe(1);

    db.deleteAccount(leaver);

    // The leaver's own row is gone, and the stayer's no longer names them, so
    // there is nothing left for the deleted id to match.
    expect(db.getMatchHistory(leaver)).toEqual([]);
    // The stayer keeps their own record of the game, and it still reads as a
    // loss — scrubbing the winner's id must not silently hand them the win.
    const kept = db.getMatchHistory(stayer);
    expect(kept.length).toBe(1);
    expect(kept[0].player1Id).toBe(stayer);
    expect(kept[0].player2Id).toBe(DELETED_PLAYER_ID);
    expect(kept[0].player2Name).toBe(DELETED_PLAYER_NAME);
    expect(kept[0].winnerId).toBe(DELETED_PLAYER_ID);
    expect(kept[0].winnerId).not.toBe(stayer);
    // Nothing points back at a name that is now anybody's to claim.
    expect(JSON.stringify(kept)).not.toContain('Leaver');
    expect(db.getPublicProfile(DELETED_PLAYER_ID)).toBeNull();
  });

  it('is a no-op for a browser with no account', () => {
    expect(db.deleteAccount('dev_aaaaaaaaaaaaaaaa26').deleted).toBe(false);
  });
});

describe('a rotated signing secret retires every device cookie', () => {
  it('refuses a cookie signed with a different secret', () => {
    // This is the failure behind "my match was not saved". The device cookie
    // is an HMAC over a secret held in the database's meta table, so a reset —
    // or a deploy that loses the data volume — rotates it. The browser keeps
    // sending the old cookie and it stops verifying.
    const deviceId = 'dev_aaaaaaaaaaaaaaaaaa';
    expect(auth.verifyToken(auth.mintToken(deviceId))).toBe(deviceId);

    // Same device id, signed with what a previous secret would have produced.
    const stale = crypto.createHmac('sha256', 'a-previous-secret').update(deviceId).digest('base64url');
    expect(auth.verifyToken(`v1.${deviceId}.${stale}`)).toBeNull();
  });

  it('mints a fresh, UNINITIALIZED identity for an unverifiable cookie', () => {
    // The important half: the replacement identity has no username, so
    // /api/match/record answers 403 PROFILE_NOT_INITIALIZED rather than
    // silently recording against a stranger's profile. The client has to
    // notice that and re-onboard — otherwise every match is lost while the
    // UI still shows the old cached profile.
    expect(auth.deviceIdFromCookieHeader('phong_device=v1.dev_aaaaaaaaaaaaaaaaaa.bogus')).toBeNull();

    const minted = auth.mintDeviceId();
    expect(db.getProfile(minted).initialized).toBe(false);
    expect(() =>
      db.recordMatch({
        playerId: minted,
        username: 'Ghost',
        playerScore: 5,
        opponentScore: 1,
        bestStreak: 8, endStreak: 0, earnedStreak: 8,
        mode: 'solo',
        difficulty: 'pro',
        isWinner: true,
      })
    ).toThrow('PROFILE_NOT_INITIALIZED');
  });
});
