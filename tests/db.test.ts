import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import type { MatchEndPayload, MatchRules } from '../src/types';
import { levelFromXp, PLACEMENT_GAMES, PLACEMENT_SIGMA, soloMuCap } from '../src/rating';
import { SHUTOUT_MIN_POINTS, isShutout } from '../src/matchRules';

// db.ts resolves DATA_DIR at import time, so point it at a temp dir first.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-db-test-'));
process.env.DATA_DIR = TMP;
const DB_FILE = path.join(TMP, 'phong.db');

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let db: typeof import('../server/db').db;
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let ALL_ACHIEVEMENTS: typeof import('../server/db').ALL_ACHIEVEMENTS;

beforeAll(async () => {
  ({ db, ALL_ACHIEVEMENTS } = await import('../server/db'));
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const match = (playerId: string, overrides: Partial<MatchEndPayload> = {}): MatchEndPayload => ({
  playerId,
  username: `Tester-${playerId}`,
  playerScore: 7,
  opponentScore: 3,
  bestStreak: 8, endStreak: 0, earnedStreak: 8,
  mode: 'multiplayer',
  isWinner: true,
  ...overrides,
});

// Profiles must be initialized (username locked in) before they can record
// matches — mirror the onboarding step every real player goes through.
const init = (id: string, username: string) => {
  db.getProfile(id);
  const result = db.initializeProfile(id, username);
  if (!result.ok) throw new Error(`init failed: ${result.code}`);
  return result.profile!;
};

// Which way the ladder went, for the winner overlay's arrow. The overlay used
// to drop its rank tile entirely when a match did not rate — which is exactly
// when a player most wants to be told the ladder did not move — so 'none' has
// to be a real answer rather than a missing one.
describe('rankDirection', () => {
  it('is up on a rated win and down on a rated loss', () => {
    init('p_dir', 'DirCase');
    expect(db.recordMatch(match('p_dir', { matchKey: 'dir-1' })).rankDirection).toBe('up');
    expect(
      db.recordMatch(
        match('p_dir', { matchKey: 'dir-2', playerScore: 2, opponentScore: 7, isWinner: false })
      ).rankDirection
    ).toBe('down');
  });

  it('is none for a solo match at a difficulty that never rates', () => {
    init('p_dir_rookie', 'DirRookie');
    const res = db.recordMatch(
      match('p_dir_rookie', { matchKey: 'dir-rookie', mode: 'solo', difficulty: 'rookie' })
    );
    // The match still PAID — this is a movement report, not a rejection.
    expect(res.earnedXp).toBeGreaterThan(0);
    expect(res.rankDirection).toBe('none');
  });

  it('is none when the rules unranked the match, sonar included', () => {
    init('p_dir_sonar', 'DirSonar');
    const sonar = db.recordMatch(
      match('p_dir_sonar', {
        matchKey: 'dir-sonar',
        rules: { opponentSonar: true },
      })
    );
    expect(sonar.ranked).toBe(false);
    expect(sonar.rankDirection).toBe('none');

    const custom = db.recordMatch(
      match('p_dir_sonar', { matchKey: 'dir-custom', rules: { paddleScale: 1.6 } })
    );
    expect(custom.rankDirection).toBe('none');
  });

  it('replays the direction it reported the first time, never a second climb', () => {
    init('p_dir_replay', 'DirReplay');
    const first = db.recordMatch(match('p_dir_replay', { matchKey: 'dir-replay' }));
    expect(first.rankDirection).toBe('up');
    const again = db.recordMatch(match('p_dir_replay', { matchKey: 'dir-replay' }));
    expect(again.alreadyRecorded).toBe(true);
    expect(again.rankDirection).toBe('up');
    // The size replays with it, from the same stored blob. A row stamped
    // before the field existed replays 'none' rather than undefined, which
    // would draw a direction with no arrows beside it.
    expect(again.rankMagnitude).toBe(first.rankMagnitude);
    expect(again.rankMagnitude).not.toBe('none');
  });

  it('replays a row stamped before the size existed as none, never as undefined', () => {
    // The fortnight after this ships. recorded_matches keeps rows for 14 days,
    // and every one written by the previous build has a direction and no size
    // in its stored blob — so the defaults literal replayRecordedMatch spreads
    // `...stored` over is the only thing standing between those rows and a
    // direction rendered with no arrows beside it. Simulated by stripping the
    // field back out of a real stamp, which is exactly the shape of a row the
    // old build wrote.
    init('p_legacy', 'LegacyRow');
    const first = db.recordMatch(match('p_legacy', { matchKey: 'legacy-1' }));
    expect(first.rankMagnitude).not.toBe('none');

    const sql = new DatabaseSync(DB_FILE);
    try {
      const row = sql
        .prepare('SELECT result FROM recorded_matches WHERE playerId = ? AND matchKey = ?')
        .get('p_legacy', 'legacy-1') as { result: string };
      const stored = JSON.parse(row.result);
      delete stored.rankMagnitude;
      const changed = sql
        .prepare('UPDATE recorded_matches SET result = ? WHERE playerId = ? AND matchKey = ?')
        .run(JSON.stringify(stored), 'p_legacy', 'legacy-1').changes;
      // A silent no-op would leave the untouched row replaying its own field
      // and this asserting nothing at all.
      expect(changed).toBe(1);
    } finally {
      sql.close();
    }

    const again = db.recordMatch(match('p_legacy', { matchKey: 'legacy-1' }));
    expect(again.alreadyRecorded).toBe(true);
    expect(again.rankDirection).toBe('up');
    expect(again.rankMagnitude).toBe('none');
  });

  it('never reports a direction without a size, or a size without a direction', () => {
    // The pair is derived from ONE delta sharing ONE epsilon precisely so this
    // cannot drift. A test that only checked the size would pass on the bug
    // where they disagree, so both halves are asserted together across every
    // case that produces a 'none'.
    init('p_pair', 'PairCase');
    const cases = [
      db.recordMatch(match('p_pair', { matchKey: 'pair-win' })),
      db.recordMatch(
        match('p_pair', { matchKey: 'pair-loss', playerScore: 1, opponentScore: 7, isWinner: false })
      ),
      db.recordMatch(match('p_pair', { matchKey: 'pair-rookie', mode: 'solo', difficulty: 'rookie' })),
      db.recordMatch(match('p_pair', { matchKey: 'pair-sonar', rules: { opponentSonar: true } })),
    ];
    for (const res of cases) {
      expect(res.rankMagnitude === 'none').toBe(res.rankDirection === 'none');
    }
    // And the two that did rate really did report a size, or the check above
    // is satisfied by everything being 'none'.
    expect(cases[0].rankMagnitude).not.toBe('none');
    expect(cases[1].rankMagnitude).not.toBe('none');
  });
});

describe('GameDatabase', () => {
  it('creates the SQLite database file in DATA_DIR', () => {
    expect(fs.existsSync(path.join(TMP, 'phong.db'))).toBe(true);
  });

  it('proves the store is WRITABLE, not merely readable, in healthCheck', () => {
    // The probe shipped as a bare SELECT while its own comment promised it
    // caught "a full disk, a volume that vanished". A read succeeds on a
    // filesystem that is full and on one remounted read-only — two of the
    // three — so /api/health went on answering 200 while every match write
    // failed, which is the orchestrator's whole reason for asking.
    //
    // Asserted as the side effect rather than by breaking a filesystem, which
    // a unit test cannot do portably: if the write is ever dropped back to a
    // read, this row stops appearing.
    const probe = () =>
      (
        new DatabaseSync(path.join(TMP, 'phong.db'), { readOnly: true })
          .prepare("SELECT value FROM meta WHERE key = 'health_probe'")
          .get() as { value?: string } | undefined
      )?.value;

    db.healthCheck();
    const first = probe();
    expect(first).toBeTruthy();

    // ...and it is rate-limited, because /api/health is unauthenticated and
    // unmetered: one upsert per request would make the probe a write
    // amplifier, which is the shape of the findings it shipped alongside.
    //
    // The clock is moved rather than the calls being made back to back: the
    // probe writes Date.now(), so two real calls inside one millisecond write
    // the same value and the assertion would pass with the rate limit deleted.
    vi.setSystemTime(Date.now() + 5);
    db.healthCheck();
    expect(probe()).toBe(first);
    vi.setSystemTime(Date.now() + 30_000);
    db.healthCheck();
    expect(probe()).not.toBe(first);
    vi.useRealTimers();
  });

  it('mints an UNINITIALIZED profile with a placeholder name on first read', () => {
    const p = db.getProfile('p_new');
    expect(p.initialized).toBe(false);
    expect(p.username.startsWith('Paddle-')).toBe(true);
    expect(p.tier).toBe('unranked');
    expect(p.level).toBe(1);
  });

  it('initializes a profile with a chosen username exactly once', () => {
    const p = init('p_init', 'Fresh');
    expect(p.username).toBe('Fresh');
    expect(p.initialized).toBe(true);
    expect(p.initializedAt).toBeTruthy();
    expect(p.usernameChangedAt).toBeTruthy();
    const again = db.initializeProfile('p_init', 'OtherName');
    expect(again.ok).toBe(false);
    expect(again.code).toBe('ALREADY_INITIALIZED');
  });

  it('refuses to record a match for an uninitialized profile', () => {
    db.getProfile('p_uninit');
    expect(() => db.recordMatch(match('p_uninit'))).toThrow('PROFILE_NOT_INITIALIZED');
  });

  it('moves the ranked rating on a PvP win and back down on a loss', () => {
    const before = init('p_elo', 'EloCase').rankMu;
    const win = db.recordMatch(match('p_elo'));
    expect(win.profile.rankMu).toBeGreaterThan(before);
    expect(win.profile.rankedGames).toBe(1);

    const peak = win.profile.rankMu;
    const loss = db.recordMatch(match('p_elo', { isWinner: false, playerScore: 2, opponentScore: 7 }));
    expect(loss.profile.rankMu).toBeLessThan(peak);
    expect(loss.profile.rankedGames).toBe(2);
  });

  it('Rookie moves hidden MMR but NEVER the ranked rating or tier', () => {
    // Rookie is the tutorial rung, open before anything has been proved, so
    // placing against it would be a formality. Pro and Cyber have to be
    // earned, and those do count — see the ranked-solo tests below.
    const p = init('p_solo_only', 'SoloOnly');
    const beforeRank = p.rankMu;
    for (let i = 0; i < 6; i++) {
      db.recordMatch(
        match('p_solo_only', { mode: 'solo', difficulty: 'rookie', matchKey: `solo:rk:${i}` })
      );
    }
    const after = db.getProfile('p_solo_only');
    expect(after.rankMu).toBe(beforeRank);
    expect(after.rankedGames).toBe(0);
    expect(after.tier).toBe('unranked');
  });

  it('an earned solo difficulty moves the ranked rating; the tutorial rung does not', () => {
    init('p_solo_rank', 'SoloRank');
    const start = db.getProfile('p_solo_rank');

    db.recordMatch(match('p_solo_rank', { mode: 'solo', difficulty: 'rookie', matchKey: 'sr:rookie' }));
    const afterRookie = db.getProfile('p_solo_rank');
    expect(afterRookie.rankedGames).toBe(0);
    expect(afterRookie.rankMu).toBe(start.rankMu);

    db.recordMatch(match('p_solo_rank', { mode: 'solo', difficulty: 'pro', matchKey: 'sr:pro' }));
    const afterPro = db.getProfile('p_solo_rank');
    expect(afterPro.rankedGames).toBe(1);
    expect(afterPro.rankMu).toBeGreaterThan(start.rankMu);

    db.recordMatch(match('p_solo_rank', { mode: 'solo', difficulty: 'cyber', matchKey: 'sr:cyber' }));
    expect(db.getProfile('p_solo_rank').rankedGames).toBe(2);
  });

  it('places a solo player over their placement games, like a duellist', () => {
    // The promise the profile screen makes has to hold whatever the matches
    // were: reaching PLACEMENT_GAMES must place you, or solo players land on
    // "5/5, UNRANKED" — the exact trap placement was just fixed for.
    init('p_solo_place', 'SoloPlace');
    for (let i = 0; i < PLACEMENT_GAMES; i++) {
      db.recordMatch(
        match('p_solo_place', {
          mode: 'solo', difficulty: 'pro', isWinner: i % 2 === 0, matchKey: `sp:${i}`,
        })
      );
    }
    const placed = db.getProfile('p_solo_place');
    expect(placed.rankedGames).toBe(PLACEMENT_GAMES);
    expect(placed.rankSigma).toBeLessThanOrEqual(PLACEMENT_SIGMA);
    expect(placed.tier).not.toBe('unranked');
  });

  it('moves rank less for a solo win than for the same win in a duel', () => {
    // Mode asymmetry survives: a duel is always the heavier result.
    init('p_cmp_solo', 'CmpSolo');
    init('p_cmp_duel', 'CmpDuel');
    db.recordMatch(match('p_cmp_solo', { mode: 'solo', difficulty: 'pro', matchKey: 'cmp:s' }));
    db.recordMatch(match('p_cmp_duel', { mode: 'multiplayer', matchKey: 'cmp:d' }));
    const solo = db.getProfile('p_cmp_solo');
    const duel = db.getProfile('p_cmp_duel');
    expect(solo.rankMu).toBeGreaterThan(25);
    expect(duel.rankMu).toBeGreaterThan(solo.rankMu);
  });

  it('caps how far farming an AI can carry the visible rank', () => {
    // No amount of beating Pro reaches the top of the ladder; the ceiling is
    // the hardest that rung ever plays.
    init('p_farm_rank', 'FarmRank');
    for (let i = 0; i < 80; i++) {
      db.recordMatch(
        match('p_farm_rank', { mode: 'solo', difficulty: 'pro', matchKey: `farm:${i}` })
      );
    }
    const farmed = db.getProfile('p_farm_rank');
    expect(farmed.rankMu).toBeLessThanOrEqual(soloMuCap('pro') + 1e-9);
    expect(farmed.tier).not.toBe('cyber-overlord');
  });

  it('awards more XP for beating a hard AI than an easy one', () => {
    init('p_xp_hard', 'XpHard');
    init('p_xp_easy', 'XpEasy');
    const hard = db.recordMatch(match('p_xp_hard', { mode: 'solo', difficulty: 'cyber' }));
    const easy = db.recordMatch(match('p_xp_easy', { mode: 'solo', difficulty: 'rookie' }));
    expect(hard.earnedXp).toBeGreaterThan(easy.earnedXp);
  });

  it('never subtracts XP, even on a heavy loss', () => {
    const before = init('p_xp_loss', 'XpLoss').xp;
    const res = db.recordMatch(
      match('p_xp_loss', { mode: 'solo', difficulty: 'rookie', isWinner: false, playerScore: 0 })
    );
    expect(res.earnedXp).toBeGreaterThan(0);
    expect(res.profile.xp).toBeGreaterThanOrEqual(before);
  });

  it('records matches under the profile username, ignoring the payload name', () => {
    init('p_names', 'RealName');
    db.recordMatch(match('p_names', { username: 'Spoofed' }));
    const hist = db.getMatchHistory('p_names');
    expect(hist[0].player1Name).toBe('RealName');
  });

  it('keeps uncertainty above the floor after a long losing streak', () => {
    init('p_floor', 'FloorCase');
    for (let i = 0; i < 40; i++) {
      db.recordMatch(match('p_floor', { isWinner: false, playerScore: 0, bestStreak: 1 }));
    }
    const p = db.getProfile('p_floor');
    expect(p.rankSigma).toBeGreaterThanOrEqual(0.6);
    expect(p.rankMu).toBeLessThan(25);
  });

  it('unlocks first_win and multiplayer_champ on a first multiplayer win', () => {
    init('p_ach', 'AchCase');
    const res = db.recordMatch(match('p_ach'));
    const ids = res.newAchievements.map((a) => a.id);
    expect(ids).toContain('first_win');
    expect(ids).toContain('multiplayer_champ');
    // Recording again must not re-award them
    const again = db.recordMatch(match('p_ach'));
    expect(again.newAchievements.map((a) => a.id)).not.toContain('first_win');
  });

  it('places a player once they finish their placement duels', () => {
    // End to end through the real recording path: five ranked PvP matches is
    // what the profile screen asks for, so five must be what it takes.
    init('p_place', 'PlaceMe');
    for (let i = 0; i < PLACEMENT_GAMES; i++) {
      db.recordMatch(
        match('p_place', { isWinner: i % 2 === 0, matchKey: `pvp:place:${i}` })
      );
    }
    const placed = db.getProfile('p_place');
    expect(placed.rankedGames).toBe(PLACEMENT_GAMES);
    expect(placed.rankSigma).toBeLessThanOrEqual(PLACEMENT_SIGMA);
    expect(placed.tier).not.toBe('unranked');
  });

  it('is still unranked one duel short of placement', () => {
    init('p_nearly', 'NearlyThere');
    for (let i = 0; i < PLACEMENT_GAMES - 1; i++) {
      db.recordMatch(
        match('p_nearly', { isWinner: i % 2 === 0, matchKey: `pvp:nearly:${i}` })
      );
    }
    expect(db.getProfile('p_nearly').tier).toBe('unranked');
  });

  it('moves hidden MMR on a Rookie win, but never the ranked track', () => {
    // The two currencies, asserted at the seam where they could blur. Solo
    // wins used to move NEITHER: the mu cap was the difficulty's base anchor
    // and every player starts at exactly Pro's base, so the hidden rating was
    // frozen while losses moved it freely down.
    init('p_solo_mmr', 'SoloMmr');
    // Rookie's ceiling IS the starting rating, so beat it from below —
    // winning against the tutorial rung at full strength correctly proves
    // nothing and is correctly worth nothing.
    for (let i = 0; i < 2; i++) {
      db.recordMatch(
        match('p_solo_mmr', {
          mode: 'solo', difficulty: 'rookie', isWinner: false,
          playerScore: 1, opponentScore: 5, matchKey: `solo:mmr:down:${i}`,
        })
      );
    }
    const before = db.getProfile('p_solo_mmr');
    db.recordMatch(match('p_solo_mmr', { mode: 'solo', difficulty: 'rookie', matchKey: 'solo:mmr:1' }));
    const after = db.getProfile('p_solo_mmr');

    expect(after.mmrMu).toBeGreaterThan(before.mmrMu);
    // ...and the visible ladder is untouched, which is what makes a tier badge
    // mean "proven against humans".
    expect(after.rankMu).toBe(before.rankMu);
    expect(after.rankSigma).toBe(before.rankSigma);
    expect(after.rankedGames).toBe(0);
    expect(after.tier).toBe('unranked');
  });

  // "Un-Ranked must never move MMR or TrueSkill." The visible ladder half is
  // covered above; this is the hidden one, which is the half nothing renders
  // and so the half that could drift unnoticed. A match whose RULES unrank it
  // must move neither estimator — it was not played on the game the ratings
  // describe. (An earned-difficulty solo is a different thing: it displays as
  // un-ranked because it does not move the visible TIER, and it deliberately
  // does feed hidden MMR, which is what keeps the AI adapting and the
  // pre-match odds honest. That is the case directly above.)
  const RULE_BREAKERS: Array<[string, Partial<MatchRules>]> = [
    ['a paddle past its ranked band', { paddleScale: 1.6 }],
    ['a ball past its ranked band', { ballScale: 1.6 }],
    ['a speed band past its own', { ballSpeedMax: 1.6 }],
    ['the opponent sonar', { opponentSonar: true }],
  ];
  for (const [label, rules] of RULE_BREAKERS) {
    it(`moves no rating at all for a match unranked by ${label}`, () => {
      const id = `p_unranked_${label.replace(/\W/g, '')}`;
      init(id, `Unranked${label.replace(/\W/g, '').slice(0, 8)}`);
      const before = db.getProfile(id);
      const result = db.recordMatch(
        match(id, { rules, matchKey: `unranked:${label}` } as Partial<MatchEndPayload>)
      );

      const after = db.getProfile(id);
      // Neither the hidden estimator...
      expect(after.mmrMu).toBeCloseTo(before.mmrMu, 10);
      expect(after.mmrSigma).toBeCloseTo(before.mmrSigma, 10);
      // ...nor the visible ladder, nor the count that places it.
      expect(after.rankMu).toBeCloseTo(before.rankMu, 10);
      expect(after.rankSigma).toBeCloseTo(before.rankSigma, 10);
      expect(after.rankedGames).toBe(before.rankedGames);
      expect(result.ranked).toBe(false);
      expect(result.rankDirection).toBe('none');
      // It is still a match that happened: it pays XP and is on the record.
      expect(after.xp).toBeGreaterThan(before.xp);
      expect(after.matchesPlayed).toBe(before.matchesPlayed + 1);
      // And it is filed as un-ranked, so the history filters agree with the
      // rating that never moved.
      expect(db.getMatchHistory(id)[0].ranked).toBe(0);
    });
  }

  it('moves both estimators for a stock duel, so the checks above are not vacuous', () => {
    init('p_ranked_ctrl', 'RankedControl');
    const before = db.getProfile('p_ranked_ctrl');
    const result = db.recordMatch(match('p_ranked_ctrl', { matchKey: 'ranked:control' }));
    const after = db.getProfile('p_ranked_ctrl');
    expect(after.mmrMu).not.toBeCloseTo(before.mmrMu, 6);
    expect(after.rankMu).not.toBeCloseTo(before.rankMu, 6);
    expect(after.rankedGames).toBe(before.rankedGames + 1);
    expect(result.ranked).toBe(true);
    expect(db.getMatchHistory('p_ranked_ctrl')[0].ranked).toBe(1);
  });

  it('lets solo losses move hidden MMR down, and solo wins bring it back', () => {
    init('p_solo_swing', 'SoloSwing');
    const start = db.getProfile('p_solo_swing').mmrMu;
    for (let i = 0; i < 3; i++) {
      db.recordMatch(
        match('p_solo_swing', {
          mode: 'solo', difficulty: 'rookie', isWinner: false,
          playerScore: 1, opponentScore: 5, matchKey: `solo:down:${i}`,
        })
      );
    }
    const dipped = db.getProfile('p_solo_swing').mmrMu;
    expect(dipped).toBeLessThan(start);

    for (let i = 0; i < 3; i++) {
      db.recordMatch(
        match('p_solo_swing', { mode: 'solo', difficulty: 'rookie', matchKey: `solo:up:${i}` })
      );
    }
    // Recoverable, which it was not: wins were capped to zero movement.
    expect(db.getProfile('p_solo_swing').mmrMu).toBeGreaterThan(dipped);
    expect(db.getProfile('p_solo_swing').rankedGames).toBe(0);
  });

  it('pays a match carrying a matchKey exactly once', () => {
    // The same match legitimately arrives more than once: the relay records a
    // duel for both seats, each phone POSTs its own copy, a failed POST is
    // retried, and a queued one is replayed on the next load. Only the first
    // may be paid.
    init('p_once', 'OnceOnly');
    const payload = match('p_once', { matchKey: 'duel:ABCD:1' });
    const first = db.recordMatch(payload);
    expect(first.alreadyRecorded).toBeFalsy();
    expect(first.earnedXp).toBeGreaterThan(0);

    const replay = db.recordMatch(payload);
    expect(replay.alreadyRecorded).toBe(true);
    // The replay is answered with what the first call paid, so a retrying
    // client shows the player the same XP rather than a second, smaller award.
    expect(replay.earnedXp).toBe(first.earnedXp);
    expect(replay.newAchievements.map((a) => a.id)).toEqual(
      first.newAchievements.map((a) => a.id)
    );
    // ...and the profile is the CURRENT one, not the snapshot from the first
    // call: matches recorded since must still show.
    expect(replay.profile.xp).toBe(db.getProfile('p_once').xp);

    const p = db.getProfile('p_once');
    expect(p.matchesPlayed).toBe(1);
    expect(p.matchesWon).toBe(1);
    expect(p.xp).toBe(first.profile.xp);
  });

  it('treats different matchKeys as different matches', () => {
    init('p_keys', 'TwoKeys');
    db.recordMatch(match('p_keys', { matchKey: 'duel:ABCD:1' }));
    db.recordMatch(match('p_keys', { matchKey: 'duel:ABCD:2' }));
    expect(db.getProfile('p_keys').matchesPlayed).toBe(2);
  });

  it('keys the dedupe per player, so one phone cannot suppress the other', () => {
    init('p_key_a', 'KeyA');
    init('p_key_b', 'KeyB');
    const key = 'duel:WXYZ:1';
    db.recordMatch(match('p_key_a', { matchKey: key }));
    db.recordMatch(match('p_key_b', { matchKey: key, isWinner: false, playerScore: 3, opponentScore: 7 }));
    expect(db.getProfile('p_key_a').matchesWon).toBe(1);
    expect(db.getProfile('p_key_b').matchesLost).toBe(1);
  });

  it('survives 50 rapid sequential match writes without losing updates', () => {
    init('p_burst', 'Burst');
    for (let i = 0; i < 50; i++) {
      db.recordMatch(match('p_burst', { isWinner: i % 2 === 0 }));
    }
    const p = db.getProfile('p_burst');
    expect(p.matchesPlayed).toBe(50);
    expect(p.matchesWon).toBe(25);
  });

  it('re-derives level from the shared curve after achievement XP lands', () => {
    init('p_lvl', 'LevelCase');
    const res = db.recordMatch(match('p_lvl'));
    expect(res.profile.level).toBe(levelFromXp(res.profile.xp).level);
    expect(res.profile.xpNext).toBe(levelFromXp(res.profile.xp).xpNext);
  });

  it('sorts the leaderboard with placed players first', () => {
    const rows = db.getLeaderboard('elo', 50);
    expect(rows.length).toBeGreaterThan(0);
    const placedFlags = rows.map((r) => r.tier !== 'unranked');
    // Once an unranked row appears, no placed row may follow it.
    const firstUnranked = placedFlags.indexOf(false);
    if (firstUnranked >= 0) {
      expect(placedFlags.slice(firstUnranked).every((p) => !p)).toBe(true);
    }
  });

  it('records match history newest-first', () => {
    const hist = db.getMatchHistory('p_burst');
    expect(hist.length).toBeGreaterThan(0);
    for (let i = 1; i < hist.length; i++) {
      expect(Date.parse(hist[i - 1].timestamp) >= Date.parse(hist[i].timestamp)).toBe(true);
    }
  });
});

describe('scaled achievement rewards', () => {
  it('pays a scaled achievement by the prediction, not a flat constant', () => {
    // ai_elite sits deep in the ladder branch: Rookie, then Pro, then ten Pro
    // wins at level 10 or above. The whole path has to be walked before it
    // can be earned at all.
    init('p_ach_hard', 'AchHard');
    db.recordMatch(match('p_ach_hard', { mode: 'solo', difficulty: 'rookie', bestStreak: 5 }));
    for (let i = 0; i < 60 && !db.getProfile('p_ach_hard').achievements.includes('ai_pro_10'); i++) {
      db.recordMatch(match('p_ach_hard', { mode: 'solo', difficulty: 'pro', bestStreak: 5 }));
    }
    expect(db.getProfile('p_ach_hard').achievements).toContain('ai_pro_10');
    const res = db.recordMatch(match('p_ach_hard', { mode: 'solo', difficulty: 'elite', bestStreak: 5 }));
    const hard = res.newAchievements.find((a) => a.id === 'ai_elite')!;
    expect(hard).toBeTruthy();
    expect(hard.awardedXp).toBeGreaterThan(0);
    // The award is the base reward bent by the prediction, not the raw constant.
    expect(hard.awardedXp).not.toBe(hard.xpReward);
  });

  it('leaves unscaled achievements exactly at their listed reward', () => {
    init('p_ach_flat', 'AchFlat');
    const res = db.recordMatch(match('p_ach_flat', { bestStreak: 12 }));
    const flat = res.newAchievements.find((a) => a.id === 'rally_10')!;
    expect(flat.awardedXp).toBe(flat.xpReward);
  });
});

describe('renaming an achievement id', () => {
  it('keeps the award, and does not pay it a second time', () => {
    // Achievement ids are persisted in each player's JSON array, so a rename
    // without a migration silently un-awards it — and then re-awards it on the
    // next qualifying match, paying its XP twice.
    init('p_rename', 'RenameCase');
    const legacy = 'rating_1400';
    const current = 'master_tier';

    // Simulate a profile carrying the pre-rename id, as a live database would.
    const profile = db.getProfile('p_rename');
    profile.achievements.push(legacy);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).upsertProfile(profile);
    expect(db.getProfile('p_rename').achievements).toContain(legacy);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).renameAchievement(legacy, current);

    const after = db.getProfile('p_rename').achievements;
    expect(after).toContain(current);
    expect(after).not.toContain(legacy);
    // The award moved, it did not duplicate.
    expect(after.filter((a) => a === current)).toHaveLength(1);
  });

  it('is a no-op for a profile that never held the old id', () => {
    init('p_norename', 'NoRenameCase');
    const before = db.getProfile('p_norename').achievements.slice();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).renameAchievement('rating_1400', 'master_tier');
    expect(db.getProfile('p_norename').achievements).toEqual(before);
  });

  it('de-duplicates if a profile somehow held both ids', () => {
    init('p_bothids', 'BothIdsCase');
    const profile = db.getProfile('p_bothids');
    profile.achievements.push('rating_1400', 'master_tier');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).upsertProfile(profile);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).renameAchievement('rating_1400', 'master_tier');

    const after = db.getProfile('p_bothids').achievements;
    expect(after.filter((a) => a === 'master_tier')).toHaveLength(1);
    expect(after).not.toContain('rating_1400');
  });

  it('leaves no reference to the retired id in the catalogue', () => {
    expect(ALL_ACHIEVEMENTS.some((a) => a.id === 'rating_1400')).toBe(false);
    const master = ALL_ACHIEVEMENTS.find((a) => a.id === 'master_tier');
    expect(master).toBeTruthy();
    // The id and the description have to agree about what it is for.
    expect(master!.description).toMatch(/Master tier/i);
  });
});

describe('mid-match abandons', () => {
  const day = new Date('2026-09-01T10:00:00Z');
  const laterSameDay = new Date('2026-09-01T21:00:00Z');
  const nextDay = new Date('2026-09-02T10:00:00Z');

  // recordAbandon is the BOOKKEEPING half — the day-keyed count, the career
  // counter and the verdict on today's forgiveness. The match itself (the
  // leaver's loss, the survivor's win) is the relay's recordRoomMatch, pinned
  // over a real socket in tests/duelRecord.test.ts.

  it('records nothing for a profile that never onboarded', () => {
    db.getProfile('p_ab_ghost');
    const res = db.recordAbandon('p_ab_ghost', day);
    expect(res.counted).toBe(false);
    expect(res.forgiven).toBe(false);
  });

  it('forgives the first abandon of a day and no more', () => {
    init('p_ab_rage', 'RageOne');
    const before = db.getProfile('p_ab_rage');

    // First of the day: counted and forgiven — connections drop. Forgiveness
    // spares the RATING on the loss the relay records, never the loss.
    const first = db.recordAbandon('p_ab_rage', day);
    expect(first).toEqual({ counted: true, forgiven: true, abandonsToday: 1 });
    const afterFirst = db.getProfile('p_ab_rage');
    expect(afterFirst.abandons).toBe(1);

    // Second the same day: the pattern is no longer forgiven, so the loss the
    // relay records for it rates like any other.
    const second = db.recordAbandon('p_ab_rage', laterSameDay);
    expect(second).toEqual({ counted: true, forgiven: false, abandonsToday: 2 });
    expect(db.getProfile('p_ab_rage').abandons).toBe(2);
  });

  it('never moves rating or XP by itself', () => {
    // The flat mu penalty this function used to apply is gone: the cost of
    // walking out is the genuine TrueSkill loss the relay now records, so
    // this call must leave every rating field exactly where it found it.
    init('p_ab_party', 'PartyQuit');
    const before = db.getProfile('p_ab_party');
    db.recordAbandon('p_ab_party', day);
    db.recordAbandon('p_ab_party', laterSameDay);
    const after = db.getProfile('p_ab_party');
    expect(after.abandons).toBe(2);
    expect(after.rankMu).toBeCloseTo(before.rankMu, 10);
    expect(after.rankSigma).toBeCloseTo(before.rankSigma, 10);
    expect(after.mmrMu).toBeCloseTo(before.mmrMu, 10);
    expect(after.rankedGames).toBe(before.rankedGames);
    // XP is untouched either way: levels never regress.
    expect(after.xp).toBe(before.xp);
    expect(after.level).toBe(before.level);
  });

  it('resets the forgiveness with the UTC day, not a rolling window', () => {
    init('p_ab_days', 'DayQuit');
    db.recordAbandon('p_ab_days', day);
    db.recordAbandon('p_ab_days', laterSameDay); // not forgiven
    // A new day is a new row: the first one is forgiven again, however many
    // yesterday held — while the career total keeps climbing.
    const fresh = db.recordAbandon('p_ab_days', nextDay);
    expect(fresh).toEqual({ counted: true, forgiven: true, abandonsToday: 1 });
    expect(db.getProfile('p_ab_days').abandons).toBe(3);
  });
});

// Six counters that gate three concealed achievement branches and the Cyber
// unlock, derived inside recordMatch from the result the server just accepted.
// CLAUDE.md is precise about why that matters: "a client reports a match,
// never a total." Across the whole suite they appeared in one incidental
// assertion, so what a streak or a shutout actually IS was never pinned.
describe('counters the server derives, and the client cannot report', () => {
  const played = (id: string, over: Partial<MatchEndPayload>, n = 0) =>
    db.recordMatch(match(id, { matchKey: `${id}:${n}`, ...over }));

  it('counts a win streak up, and a single loss ends it', () => {
    init('c_streak', 'StreakCase');
    played('c_streak', { isWinner: true }, 1);
    expect(db.getProfile('c_streak').winStreak).toBe(1);
    played('c_streak', { isWinner: true }, 2);
    played('c_streak', { isWinner: true }, 3);
    expect(db.getProfile('c_streak').winStreak).toBe(3);

    played('c_streak', { isWinner: false, playerScore: 2, opponentScore: 7 }, 4);
    expect(db.getProfile('c_streak').winStreak).toBe(0);
  });

  it('remembers the best streak after the current one is broken', () => {
    init('c_best', 'BestStreak');
    for (let i = 1; i <= 4; i++) played('c_best', { isWinner: true }, i);
    played('c_best', { isWinner: false, playerScore: 1, opponentScore: 7 }, 5);
    played('c_best', { isWinner: true }, 6);

    const p = db.getProfile('c_best');
    expect(p.winStreak).toBe(1);
    expect(p.bestWinStreak).toBe(4);
  });

  it('counts a shutout only for a win to nil of at least five points', () => {
    // The floor exists so a 2-0 that was never played to the end is not "a
    // shutout" — the relay records an abandoned duel at the STANDING score, so
    // without it, getting somebody to walk out early would pay like holding
    // them scoreless over a full match.
    //
    // What it costs is the whole first-to-3 format: the match caps at 3, so a
    // 3-0 there IS the entire match and still falls short. That case is in the
    // table because it is the one that surprised a player — winning 3-0
    // against Cyber over and over and moving no counter — and because the
    // achievement copy now has to state the length out loud. If the floor ever
    // moves, SHUTOUT_MIN_POINTS moves with it and the copy check in
    // tests/achievements.test.ts follows.
    expect(SHUTOUT_MIN_POINTS).toBe(5);
    const cases: [string, Partial<MatchEndPayload>, number][] = [
      ['5-0 win', { isWinner: true, playerScore: 5, opponentScore: 0 }, 1],
      ['7-0 win', { isWinner: true, playerScore: 7, opponentScore: 0 }, 1],
      ['5-1 win', { isWinner: true, playerScore: 5, opponentScore: 1 }, 0],
      ['4-0 win', { isWinner: true, playerScore: 4, opponentScore: 0 }, 0],
      // A first-to-3 caps at 3, so this IS the whole match, and it still is not one.
      ['3-0 win', { isWinner: true, playerScore: 3, opponentScore: 0 }, 0],
      ['0-5 loss', { isWinner: false, playerScore: 0, opponentScore: 5 }, 0],
    ];
    for (const [label, payload, expected] of cases) {
      // The table and the shared predicate have to agree, or this is testing
      // one of two rules and the other is free to drift.
      expect(isShutout(payload as never) ? 1 : 0, `${label} (isShutout)`).toBe(expected);
      const id = `c_shut_${label.replace(/\W/g, '')}`;
      init(id, `Shut${label.replace(/\W/g, '')}`);
      played(id, payload, 1);
      expect(db.getProfile(id).shutoutsWon, label).toBe(expected);
    }
  });

  it('credits a solo win to its own difficulty and no other', () => {
    init('c_diff', 'DiffCase');
    played('c_diff', { mode: 'solo', difficulty: 'rookie', isWinner: true }, 1);
    let p = db.getProfile('c_diff');
    expect([p.rookieWins, p.proWins, p.cyberWins]).toEqual([1, 0, 0]);

    played('c_diff', { mode: 'solo', difficulty: 'pro', isWinner: true }, 2);
    played('c_diff', { mode: 'solo', difficulty: 'cyber', isWinner: true }, 3);
    p = db.getProfile('c_diff');
    expect([p.rookieWins, p.proWins, p.cyberWins]).toEqual([1, 1, 1]);
  });

  it('credits each of the five rungs to its own counter', () => {
    // 'chaos' is a live rung again (legacy rows were relabelled once by
    // chaos_relabel_v1 — see tests/chaosRelabel.test.ts), so a chaos win
    // lands on chaosWins, not on cyber's counter.
    init('c_chaos', 'ChaosCase');
    played('c_chaos', { mode: 'solo', difficulty: 'chaos', isWinner: true }, 1);
    played('c_chaos', { mode: 'solo', difficulty: 'elite', isWinner: true }, 2);
    const counted = db.getProfile('c_chaos');
    expect(counted.chaosWins).toBe(1);
    expect(counted.eliteWins).toBe(1);
    expect(counted.cyberWins).toBe(0);
  });

  it('credits nothing per-difficulty for a loss, or for a duel', () => {
    init('c_nodiff', 'NoDiffCase');
    played('c_nodiff', { mode: 'solo', difficulty: 'pro', isWinner: false, playerScore: 1, opponentScore: 7 }, 1);
    played('c_nodiff', { mode: 'multiplayer', isWinner: true }, 2);

    const p = db.getProfile('c_nodiff');
    expect([p.rookieWins, p.proWins, p.cyberWins]).toEqual([0, 0, 0]);
    // The duel win still lands where duels are counted.
    expect(p.multiplayerWins).toBe(1);
  });

  it('leaves the streak alone when a match is abandoned rather than lost', () => {
    // recordAbandon is its own counter and nothing else: it moves no streak
    // by itself. The loss that DOES break the streak is the one the relay
    // records for the abandoned match (recordRoomMatch), which is an ordinary
    // recordMatch and breaks it exactly as any other loss would.
    init('c_ab', 'AbandonStreak');
    played('c_ab', { isWinner: true }, 1);
    played('c_ab', { isWinner: true }, 2);
    db.recordAbandon('c_ab');

    const p = db.getProfile('c_ab');
    expect(p.winStreak).toBe(2);
    expect(p.abandons).toBe(1);
  });

  it('pays a replayed match once, and counts it once', () => {
    // The idempotency ledger has to cover the counters too, or a duel reported
    // by three paths would read as a three-match win streak.
    init('c_dupe', 'DupeCounters');
    const payload = match('c_dupe', { isWinner: true, matchKey: 'dupe:1' });
    db.recordMatch(payload);
    db.recordMatch(payload);
    db.recordMatch(payload);
    expect(db.getProfile('c_dupe').winStreak).toBe(1);
  });
});


describe('per-mode stats', () => {
  // The career totals on the profile pool solo and duel into one number,
  // which answers "how much have you played" and nothing at all about how you
  // play each mode. These are the same measures kept apart.

  it('keeps a mode’s numbers to that mode', () => {
    const id = 'dev_modestats00000001';
    init(id, 'ModeStats');
    db.recordMatch(match(id, { mode: 'solo', difficulty: 'rookie', isWinner: true, playerScore: 5, opponentScore: 1, bestStreak: 6, endStreak: 0, earnedStreak: 6, aces: 2 }));
    db.recordMatch(match(id, { mode: 'solo', difficulty: 'rookie', isWinner: false, playerScore: 2, opponentScore: 5, bestStreak: 9 }));
    db.recordMatch(match(id, { mode: 'multiplayer', isWinner: true, playerScore: 5, opponentScore: 0, bestStreak: 4 }));

    const stats = db.getModeStats(id);
    expect(stats.solo).toMatchObject({
      matchesPlayed: 2,
      matchesWon: 1,
      matchesLost: 1,
      pointsScored: 7,
      aces: 2,
      bestStreak: 9,
    });
    expect(stats.multiplayer).toMatchObject({
      matchesPlayed: 1,
      matchesWon: 1,
      matchesLost: 0,
      pointsScored: 5,
      bestStreak: 4,
    });
    // And the pooled totals are untouched by the split.
    const profile = db.getProfile(id);
    expect(profile.matchesPlayed).toBe(3);
    expect(profile.highestRally).toBe(9);
  });

  it('hands the client the row it just wrote, not the one before it', () => {
    // MatchEndResult.profile is installed whole by the client, and `profile`
    // is read at the top of recordMatch — before the per-mode row is bumped.
    // Stale, the first match's row was missing outright and every later one
    // was a match behind for the rest of the page session.
    const id = 'dev_modefresh0000001';
    init(id, 'ModeFresh');
    const first = db.recordMatch(
      match(id, { mode: 'solo', difficulty: 'rookie', isWinner: true, playerScore: 5, bestStreak: 9, endStreak: 9, earnedStreak: 9 })
    );
    expect(first.profile.modeStats?.solo?.matchesPlayed).toBe(1);
    expect(first.profile.modeStats?.solo?.currentStreak).toBe(9);

    const second = db.recordMatch(
      match(id, { mode: 'solo', difficulty: 'rookie', isWinner: true, playerScore: 5, bestStreak: 12, endStreak: 12, earnedStreak: 3 })
    );
    expect(second.profile.modeStats?.solo?.matchesPlayed).toBe(2);
    expect(second.profile.modeStats?.solo?.currentStreak).toBe(12);
    // And it agrees with what the database actually holds.
    expect(second.profile.modeStats).toEqual(db.getModeStats(id));
  });

  it('does not bank a mode row for a match that failed to record', () => {
    // The per-mode row is the one write in recordMatch with no ceiling of its
    // own — mission progress caps at its target and the profile is upserted
    // whole, but matchesPlayed and the rest only ever add. Written outside the
    // transaction, a failure anywhere after it left the row bumped and the
    // match unstamped, so the client's retry counted the same match again.
    const id = 'dev_modeatomic000001';
    init(id, 'ModeAtomic');
    db.recordMatch(
      match(id, { mode: 'solo', difficulty: 'rookie', isWinner: true, playerScore: 5, bestStreak: 6, endStreak: 6, earnedStreak: 6 })
    );
    const before = db.getModeStats(id).solo;
    expect(before?.matchesPlayed).toBe(1);

    // Fail the transaction after the bump, the way a constraint violation or
    // a full disk would.
    const store = db as unknown as { insertMatch: (m: unknown) => void };
    const real = store.insertMatch;
    store.insertMatch = () => {
      throw new Error('injected: the match record could not be written');
    };
    try {
      expect(() =>
        db.recordMatch(
          match(id, { mode: 'solo', difficulty: 'rookie', isWinner: true, playerScore: 5, bestStreak: 9, endStreak: 9, earnedStreak: 9, matchKey: 'atomic-1' })
        )
      ).toThrow(/injected/);
    } finally {
      store.insertMatch = real;
    }

    // Nothing moved: not the count, not the streak the next match carries.
    expect(db.getModeStats(id).solo).toEqual(before);

    // And the retry that follows counts it exactly once.
    db.recordMatch(
      match(id, { mode: 'solo', difficulty: 'rookie', isWinner: true, playerScore: 5, bestStreak: 9, endStreak: 9, earnedStreak: 9, matchKey: 'atomic-1' })
    );
    expect(db.getModeStats(id).solo?.matchesPlayed).toBe(2);
  });

  it('does not let a delayed result overwrite a newer run', () => {
    // Idempotency tells two matches apart; it does not put them in sequence.
    // currentStreak is the one column here that is ASSIGNED, so the last write
    // wins — and the last write is not the last match. A result that failed to
    // POST sits in the on-device queue while the player replays, and lands
    // afterwards: match A's run of 10 comes back over replay B's 0, and the
    // next reload starts on a run that was already broken.
    const id = 'dev_modeorder0000001';
    init(id, 'ModeOrder');
    // Results say how OLD they are, not when they happened — see the note in
    // bumpModeStats on why an age and not a clock. `aged(ms)` is a payload
    // sent that long after its own whistle.
    const aged = (ms: number) => ({ endedAt: 1_000_000, clientNow: 1_000_000 + ms });

    // A ends at 10 but its POST is delayed.
    // B is played and lost immediately after, and lands first.
    db.recordMatch(
      match(id, { mode: 'solo', difficulty: 'rookie', isWinner: false, playerScore: 2, bestStreak: 10, endStreak: 0, earnedStreak: 4, ...aged(0), matchKey: 'ord-b' })
    );
    expect(db.getModeStats(id).solo?.currentStreak).toBe(0);

    // Now A's queued POST arrives, saying it is a minute stale.
    db.recordMatch(
      match(id, { mode: 'solo', difficulty: 'rookie', isWinner: true, playerScore: 5, bestStreak: 10, endStreak: 10, earnedStreak: 10, ...aged(60_000), matchKey: 'ord-a' })
    );
    // The run stays broken...
    expect(db.getModeStats(id).solo?.currentStreak).toBe(0);
    // ...but the match itself is still counted and its peak still stands: it
    // happened, and it is owed everything except the ordering.
    expect(db.getModeStats(id).solo?.matchesPlayed).toBe(2);
    expect(db.getModeStats(id).solo?.bestStreak).toBe(10);
  });

  it('still takes a result that really is the newest', () => {
    const id = 'dev_modeorder0000002';
    init(id, 'ModeOrder2');
    const aged = (ms: number) => ({ endedAt: 1_000_000, clientNow: 1_000_000 + ms });
    db.recordMatch(
      match(id, { mode: 'solo', difficulty: 'rookie', isWinner: true, playerScore: 5, bestStreak: 6, endStreak: 6, earnedStreak: 6, ...aged(5000), matchKey: 'ord2-a' })
    );
    expect(db.getModeStats(id).solo?.currentStreak).toBe(6);
    // Fresher than the one before it, so it wins.
    db.recordMatch(
      match(id, { mode: 'solo', difficulty: 'rookie', isWinner: true, playerScore: 5, bestStreak: 9, endStreak: 9, earnedStreak: 3, ...aged(0), matchKey: 'ord2-b' })
    );
    expect(db.getModeStats(id).solo?.currentStreak).toBe(9);
  });

  it('treats a result with no stamp at all as happening now', () => {
    // An older client, or the relay writing a duel as it finishes. Absent must
    // not read as "the beginning of time" and be discarded.
    const id = 'dev_modeorder0000003';
    init(id, 'ModeOrder3');
    db.recordMatch(
      match(id, { mode: 'solo', difficulty: 'rookie', isWinner: true, playerScore: 5, bestStreak: 7, endStreak: 7, earnedStreak: 7, matchKey: 'ord3-a' })
    );
    db.recordMatch(
      match(id, { mode: 'solo', difficulty: 'rookie', isWinner: false, playerScore: 1, bestStreak: 7, endStreak: 0, earnedStreak: 0, matchKey: 'ord3-b' })
    );
    expect(db.getModeStats(id).solo?.currentStreak).toBe(0);
  });

  it('does not let a delayed win extend a run a newer loss had ended', () => {
    // Same disease as currentStreak, different column: winStreak accumulates,
    // and bestWinStreak is a maximum of it, so an out-of-order win inflates a
    // best permanently. An older result does not move the run at all.
    const id = 'dev_modewinord000001';
    init(id, 'ModeWinOrder');
    const solo = (won: boolean, ageMs: number, key: string) =>
      match(id, {
        mode: 'solo', difficulty: 'rookie', isWinner: won,
        playerScore: won ? 5 : 1, opponentScore: won ? 1 : 5,
        bestStreak: 4, endStreak: won ? 4 : 0, earnedStreak: 4,
        endedAt: 1_000_000, clientNow: 1_000_000 + ageMs, matchKey: key,
      });

    db.recordMatch(solo(false, 2000, 'win-b')); // a loss, two seconds stale
    db.recordMatch(solo(true, 0, 'win-c')); // then a win, fresh — after it
    expect(db.getModeStats(id).solo?.bestWinStreak).toBe(1);

    // Now the queued older win arrives, a minute stale. It must not make that
    // a run of two.
    db.recordMatch(solo(true, 60_000, 'win-a'));
    expect(db.getModeStats(id).solo?.bestWinStreak).toBe(1);
    // The match itself is still counted — it happened, and it is owed that.
    expect(db.getModeStats(id).solo?.matchesPlayed).toBe(3);
    expect(db.getModeStats(id).solo?.matchesWon).toBe(2);
  });

  it('keeps the order the client queued writes in, even when one stalls', () => {
    // The age is measured when a request is SENT, so it does not include that
    // request's own time on the wire — and the client chain makes B wait for
    // A's response, so B's age DOES include A's round trip. Stamped
    // `now - age`, A lands at its late arrival and B lands near its earlier
    // event, which inverts them: the later run is refused as stale.
    //
    // A stalls two seconds; B happens half a second in and goes out when A
    // lands. Both are live writes from one page, in the order the player did
    // them.
    const id = 'dev_modequeueord0001';
    init(id, 'ModeQueueOrder');

    const write = (endStreak: number, ageMs: number, key: string, seq: number) =>
      db.recordMatch(
        match(id, {
          mode: 'solo', difficulty: 'rookie', isWinner: true,
          playerScore: 5, opponentScore: 1,
          bestStreak: 12, endStreak, earnedStreak: 4,
          endedAt: 1_000_000, clientNow: 1_000_000 + ageMs, matchKey: key,
          // Purely a client-side ordering hint now (src/net/runChain.ts) — not
          // set by the route. Here it stands for "both of these came from the
          // same browser's chain".
          chainId: 'chain_queueorder', runSeq: seq,
        })
      );

    write(7, 0, 'queue-a', 1); // sent at once, two seconds on the wire
    write(0, 2_000, 'queue-b', 2); // queued behind it; a miss ended the run

    // B is the later event and the run is broken. Reading 7 here means the
    // stall reordered them.
    expect(db.getModeStats(id).solo?.currentStreak).toBe(0);
  });

  it('orders by chain position when a slower request arrives out of turn', () => {
    // The gap the previous case does not close: two writes need not be queued
    // behind one another at all to have their OWN round trips finish out of
    // causal order. Event A happens, then event B happens two seconds later
    // (a genuinely LATER event, not a queued retry of the same one) — but A's
    // own request takes ten seconds to arrive and B's takes a few
    // milliseconds, so B reaches the database first and A reaches it after.
    //
    // Age cannot fix this: A's age is small (it was sent promptly) and so is
    // B's, so both stamp near "now" at their own arrival times, and whichever
    // arrives LAST simply wins by stamp — which here is the STALE one, A.
    // runSeq does not have this problem, because it is assigned once, before
    // either request exists, and never revised by how the request went.
    const id = 'dev_modeoutoforder01';
    init(id, 'ModeOutOfOrder');

    const write = (endStreak: number, key: string, seq: number) =>
      db.recordMatch(
        match(id, {
          mode: 'solo', difficulty: 'rookie', isWinner: true,
          playerScore: 5, opponentScore: 1,
          bestStreak: 9, endStreak, earnedStreak: 4,
          // Small, ordinary ages for both — this is not about staleness.
          endedAt: 1_000_000, clientNow: 1_000_100, matchKey: key,
          chainId: 'chain_outoforder', runSeq: seq,
        })
      );

    // B (the LATER event, seq 2) reaches the database first.
    write(0, 'ooo-b', 2);
    expect(db.getModeStats(id).solo?.currentStreak).toBe(0);

    // A (the EARLIER event, seq 1) arrives after, carrying a stale run.
    write(11, 'ooo-a', 1);
    // Still 0: A's lower seq loses to B's higher one, regardless of arrival
    // order. Reading 11 here means arrival order won instead of causal order.
    expect(db.getModeStats(id).solo?.currentStreak).toBe(0);
  });

  it('breaks a same-seq tie by age instead of always favoring arrival order', () => {
    // Two TABS on one device can collide on the exact same chain position:
    // nextRunSeq() reads its persisted counter, increments, and writes it
    // back in three separate steps, none atomic across tabs — both can read
    // the SAME starting value before either write lands, and both then report
    // the identical chainId and the identical next seq for two genuinely
    // different events. `seq > prevSeq` alone rejects whichever one's request
    // happens to reach the database second, always, regardless of which one
    // actually happened later. That is a real bias, not a coin flip, and this
    // is what removes it: on a tie, fall back to the age.
    const id = 'dev_modeseqtiebreak1';
    init(id, 'ModeSeqTie');

    // The server stamps on ITS OWN clock at write time, minus the reported
    // age — so within one fast synchronous test, both calls land at nearly
    // the same server "now" regardless of what endedAt says. The only way to
    // make one genuinely stamp later than the other here is to give it the
    // SMALLER age (closer to "now" when written), which is also exactly how
    // this would look for real: a message that left the browser promptly
    // stamps close to the moment it arrives, one that sat around first does
    // not.
    const write = (endStreak: number, key: string, ageMs: number) =>
      db.recordMatch(
        match(id, {
          mode: 'solo', difficulty: 'rookie', isWinner: true,
          playerScore: 5, opponentScore: 1,
          bestStreak: 9, endStreak, earnedStreak: 4,
          endedAt: 1_000_000, clientNow: 1_000_000 + ageMs, matchKey: key,
          // Same chain, same seq — the collision.
          chainId: 'chain_tie', runSeq: 4,
        })
      );

    // The earlier of the two reaches the database first, as it usually would,
    // carrying a large age (it sat around before being sent).
    write(3, 'tie-earlier', 1_000);
    expect(db.getModeStats(id).solo?.currentStreak).toBe(3);

    // The later one arrives second, tied on seq, with a near-zero age. It
    // must still win: it is the one that actually happened after.
    write(8, 'tie-later', 0);
    expect(db.getModeStats(id).solo?.currentStreak).toBe(8);
  });

  it('will not read a backwards clock jump as "just now"', () => {
    // The age is a difference between two readings of ONE clock, which is what
    // makes it free of that clock's offset — but not of a clock CHANGE between
    // them. A match ends while the phone runs fast, fails to send, and is
    // replayed after NTP corrects it: `clientNow` is now BEHIND `endedAt` and
    // the difference comes out negative.
    //
    // Negative means the elapsed time is not knowable from these two numbers.
    // "Just now" is the reading that lets the result overwrite whatever is
    // stored, so it is exactly the wrong guess — the queued result would land
    // on top of the newer one that overtook it. It is read as old instead.
    const id = 'dev_modebackclock001';
    init(id, 'ModeBackClock');

    // The newer result lands first: a miss, run back to zero.
    db.recordMatch(
      match(id, {
        mode: 'solo', difficulty: 'rookie', isWinner: false,
        playerScore: 1, opponentScore: 5,
        bestStreak: 4, endStreak: 0, earnedStreak: 4,
        matchKey: 'back-new',
      })
    );
    expect(db.getModeStats(id).solo?.currentStreak).toBe(0);

    // Then the queued one, whose two readings straddle the correction.
    db.recordMatch(
      match(id, {
        mode: 'solo', difficulty: 'rookie', isWinner: true,
        playerScore: 5, opponentScore: 1,
        bestStreak: 9, endStreak: 9, earnedStreak: 9,
        endedAt: 5_000_000, clientNow: 5_000_000 - 90_000, matchKey: 'back-old',
      })
    );
    // The run stays broken. Its additive half is still paid — it happened.
    expect(db.getModeStats(id).solo?.currentStreak).toBe(0);
    expect(db.getModeStats(id).solo?.matchesPlayed).toBe(2);
    expect(db.getModeStats(id).solo?.bestStreak).toBe(9);
  });

  it('does not care what a device thinks the time is, only how stale it is', () => {
    // Ordering off a device's absolute clock breaks in BOTH directions: a
    // phone running fast parks the stored stamp in the future and freezes the
    // column until reality catches up, and a phone running slow has every
    // result it ever sends look older than what is stored and be ignored the
    // same way. Neither can happen when the two numbers compared come from
    // one clock.
    const id = 'dev_modeclock0000001';
    init(id, 'ModeClock');
    const forty = 40 * 24 * 60 * 60 * 1000;

    // A device forty days AHEAD, reporting as it plays.
    const ahead = Date.now() + forty;
    db.recordMatch(
      match(id, { mode: 'solo', difficulty: 'rookie', isWinner: true, playerScore: 5, bestStreak: 8, endStreak: 8, earnedStreak: 8, endedAt: ahead, clientNow: ahead, matchKey: 'clk-a' })
    );
    expect(db.getModeStats(id).solo?.currentStreak).toBe(8);

    // Then the account moves to a device forty days BEHIND. Its results are
    // newer in reality and must be taken.
    const behind = Date.now() - forty;
    db.recordMatch(
      match(id, { mode: 'solo', difficulty: 'rookie', isWinner: false, playerScore: 1, bestStreak: 8, endStreak: 0, earnedStreak: 0, endedAt: behind, clientNow: behind, matchKey: 'clk-b' })
    );
    expect(db.getModeStats(id).solo?.currentStreak).toBe(0);

    // And a genuinely stale result from that same slow device still loses.
    db.recordMatch(
      match(id, { mode: 'solo', difficulty: 'rookie', isWinner: true, playerScore: 5, bestStreak: 8, endStreak: 5, earnedStreak: 5, endedAt: behind - 600_000, clientNow: behind, matchKey: 'clk-c' })
    );
    expect(db.getModeStats(id).solo?.currentStreak).toBe(0);
  });

  it('runs a win streak per mode, so a loss in one does not end the other', () => {
    const id = 'dev_modestreak000001';
    init(id, 'ModeStreak');
    db.recordMatch(match(id, { mode: 'solo', difficulty: 'rookie', isWinner: true }));
    db.recordMatch(match(id, { mode: 'solo', difficulty: 'rookie', isWinner: true }));
    // A duel loss between them must not touch the solo run.
    db.recordMatch(match(id, { mode: 'multiplayer', isWinner: false }));
    db.recordMatch(match(id, { mode: 'solo', difficulty: 'rookie', isWinner: true }));

    const stats = db.getModeStats(id);
    expect(stats.solo.bestWinStreak).toBe(3);
    expect(stats.multiplayer.bestWinStreak).toBe(0);
    // The profile-wide streak DOES mix them, which is what it is for.
    expect(db.getProfile(id).bestWinStreak).toBe(2);
  });

  it('gives a practice session a row of its own, with no wins in it', () => {
    const id = 'dev_modepractice0001';
    init(id, 'ModePractice');
    db.recordPractice(id, { bestStreak: 22, earnedStreak: 22 });
    const stats = db.getModeStats(id);
    expect(stats.practice).toMatchObject({
      matchesPlayed: 1,
      matchesWon: 0,
      matchesLost: 0,
      bestStreak: 22,
    });
    // Practice has never touched the career rally, and still does not.
    expect(db.getProfile(id).highestRally).toBe(0);
  });

  it('rides along on the profile the device reads for itself', () => {
    const id = 'dev_modeonprofile001';
    init(id, 'ModeOnProfile');
    db.recordMatch(match(id, { mode: 'solo', difficulty: 'rookie', bestStreak: 5 }));
    expect(db.getProfile(id).modeStats?.solo?.bestStreak).toBe(5);
    // But never on the sanitized public shape.
    expect((db.getPublicProfile(id) as unknown as Record<string, unknown>).modeStats).toBeUndefined();
  });
});

describe('reporting a run with no match to report it', () => {
  // Only a finished match reports itself, and a run does not only change when
  // one finishes: carry a run in, miss, walk out. Without a way to say so the
  // stored run stays where the last COMPLETED match left it, so the miss
  // survives a reload and every return after it extends a run that was over.

  it('writes the run without counting a match or paying anything', () => {
    const id = 'dev_report0000000001';
    init(id, 'Reporter');
    db.recordMatch(
      match(id, { mode: 'solo', difficulty: 'rookie', isWinner: true, playerScore: 5, bestStreak: 9, endStreak: 9, earnedStreak: 9, matchKey: 'rep-a' })
    );
    const before = db.getProfile(id);
    expect(before.modeStats?.solo?.currentStreak).toBe(9);

    const out = db.reportStreak(id, 'solo', 0);
    expect(out.ok).toBe(true);
    expect(out.modeStats.solo?.currentStreak).toBe(0);
    // Nothing else moved: no match, no XP, no peak, no rating.
    const after = db.getProfile(id);
    expect(after.modeStats?.solo?.matchesPlayed).toBe(1);
    expect(after.modeStats?.solo?.bestStreak).toBe(9);
    expect(after.xp).toBe(before.xp);
    expect(after.matchesPlayed).toBe(before.matchesPlayed);
    expect(after.highestRally).toBe(before.highestRally);
  });

  it('refuses the modes it has no business writing', () => {
    // The relay owns a duel's runs and writes them from state no client can
    // touch; split banks nothing at all.
    const id = 'dev_report0000000002';
    init(id, 'Reporter2');
    expect(db.reportStreak(id, 'multiplayer', 0).ok).toBe(false);
    expect(db.reportStreak(id, 'split', 0).ok).toBe(false);
    expect(db.getModeStats(id).multiplayer).toBeUndefined();
  });

  it('is ordered like every other write to that run', () => {
    const id = 'dev_report0000000003';
    init(id, 'Reporter3');
    db.recordMatch(
      match(id, { mode: 'solo', difficulty: 'rookie', isWinner: true, playerScore: 5, bestStreak: 6, endStreak: 6, earnedStreak: 6, endedAt: 1_000_000, clientNow: 1_000_000, matchKey: 'rep3-a' })
    );
    // A report claiming to be an hour stale cannot undo a fresher match.
    db.reportStreak(id, 'solo', 0, 60 * 60 * 1000);
    expect(db.getModeStats(id).solo?.currentStreak).toBe(6);
    // One sent as it happens — which is what the route actually does — can.
    db.reportStreak(id, 'solo', 0);
    expect(db.getModeStats(id).solo?.currentStreak).toBe(0);
  });

  it('is ordered against a practice session too, not only against matches', () => {
    // Every writer that ASSIGNS the run shares one mechanism, or the ones that
    // do not are simply stamped on arrival and outrank whatever overtook them.
    const id = 'dev_report0000000005';
    init(id, 'Reporter5');
    // A session ending on a broken run, sent as it happens.
    db.recordPractice(id, { bestStreak: 9, earnedStreak: 9, endStreak: 0 });
    expect(db.getModeStats(id).practice?.currentStreak).toBe(0);
    // An older session's report, stalled a minute on the wire, must not put
    // its run back.
    db.recordPractice(id, { bestStreak: 8, earnedStreak: 8, endStreak: 8, ageMs: 60_000 });
    expect(db.getModeStats(id).practice?.currentStreak).toBe(0);
    // ...while a genuinely newer one is taken.
    db.recordPractice(id, { bestStreak: 8, earnedStreak: 8, endStreak: 8 });
    expect(db.getModeStats(id).practice?.currentStreak).toBe(8);
  });

  it('refuses nonsense rather than storing it', () => {
    const id = 'dev_report0000000004';
    init(id, 'Reporter4');
    expect(db.reportStreak(id, 'solo', -3).ok).toBe(false);
    expect(db.reportStreak(id, 'solo', Number.NaN).ok).toBe(false);
    expect(db.getModeStats(id).solo).toBeUndefined();
  });
});

describe('a streak carries between matches', () => {
  // "Streaks must carry over between matches." A match ending is not a miss,
  // and a miss is the only thing that ends a run — so the run outlives the
  // match, and it has to outlive a reload and a different browser too, which
  // is why it is stored here rather than kept in the client.

  it('remembers the run a match ended ON, per mode', () => {
    const id = 'dev_carrymode0000001';
    init(id, 'CarryMode');
    db.recordMatch(match(id, { mode: 'solo', difficulty: 'rookie', bestStreak: 9, endStreak: 9, matchKey: 'cm:1' }));
    expect(db.getModeStats(id).solo.currentStreak).toBe(9);
    // A duel is a different run and does not disturb it.
    db.recordMatch(match(id, { mode: 'multiplayer', bestStreak: 3, endStreak: 0, earnedStreak: 3, matchKey: 'cm:2' }));
    expect(db.getModeStats(id).solo.currentStreak).toBe(9);
    expect(db.getModeStats(id).multiplayer.currentStreak).toBe(0);
  });

  it('ends the run when the match ended on a miss', () => {
    const id = 'dev_carryend00000001';
    init(id, 'CarryEnd');
    db.recordMatch(match(id, { mode: 'solo', difficulty: 'rookie', bestStreak: 12, endStreak: 12, matchKey: 'ce:1' }));
    expect(db.getModeStats(id).solo.currentStreak).toBe(12);
    db.recordMatch(match(id, { mode: 'solo', difficulty: 'rookie', bestStreak: 14, endStreak: 0, earnedStreak: 14, matchKey: 'ce:2' }));
    // Assigned, not maxed: a run that ended is over, however high it got.
    expect(db.getModeStats(id).solo.currentStreak).toBe(0);
    expect(db.getModeStats(id).solo.bestStreak).toBe(14);
  });

  it('refuses a run that claims to have ended higher than it ever reached', () => {
    const id = 'dev_carryliar0000001';
    init(id, 'CarryLiar');
    db.recordMatch(match(id, { mode: 'solo', difficulty: 'rookie', bestStreak: 4, endStreak: 900, matchKey: 'cl:1' }));
    expect(db.getModeStats(id).solo.currentStreak).toBe(4);
  });

  it('carries a practice run out of the session it was built in', () => {
    const id = 'dev_carrywall0000001';
    init(id, 'CarryWall');
    db.recordPractice(id, { bestStreak: 31, earnedStreak: 31, endStreak: 31 });
    expect(db.getModeStats(id).practice.currentStreak).toBe(31);
    db.recordPractice(id, { bestStreak: 5, earnedStreak: 5, endStreak: 0 });
    expect(db.getModeStats(id).practice.currentStreak).toBe(0);
    expect(db.getModeStats(id).practice.bestStreak).toBe(31);
  });

  it('pays a match for a carried run only up to the cap', () => {
    // Without a ceiling the SAME run is paid for again in every match it
    // spans, and a player who stops missing earns more and more for it.
    init('dev_carryxp000000001', 'CarryXpA');
    init('dev_carryxp000000002', 'CarryXpB');
    const big = db.recordMatch(match('dev_carryxp000000001', {
      mode: 'solo', difficulty: 'rookie', bestStreak: 400, endStreak: 400, matchKey: 'cx:1',
    }));
    const huge = db.recordMatch(match('dev_carryxp000000002', {
      mode: 'solo', difficulty: 'rookie', bestStreak: 4000, endStreak: 4000, matchKey: 'cx:2',
    }));
    expect(huge.earnedXp).toBe(big.earnedXp);
  });
});


describe('a carried run is not paid for twice', () => {
  // The exploit this closes: a run carries between sessions, and the Practice
  // Wall is entered and left at will. Paying on the run's PEAK meant a player
  // could carry a streak in, open the wall, leave without touching the ball,
  // and collect for it again — every day, up to the daily cap.

  it('pays a practice session nothing when nothing was returned in it', () => {
    const id = 'dev_wallfarm00000001';
    init(id, 'WallFarm');
    // A real session, which pays.
    const real = db.recordPractice(id, { bestStreak: 40, earnedStreak: 40, endStreak: 40 });
    expect(real.earnedXp).toBeGreaterThan(0);
    expect(db.getModeStats(id).practice.currentStreak).toBe(40);

    // Now open the wall and leave, carrying the same run. The peak is real and
    // still 40; nothing was earned, so nothing is paid.
    const farmed = db.recordPractice(id, { bestStreak: 40, earnedStreak: 0, endStreak: 40 });
    expect(farmed.earnedXp).toBe(0);
    // And the run is still going, because leaving is not missing.
    expect(db.getModeStats(id).practice.currentStreak).toBe(40);
  });

  it('still banks the run’s true peak, and the rungs that go with it', () => {
    const id = 'dev_wallpeak00000001';
    init(id, 'WallPeak');
    // The wall rungs hang off rally_10, so a match has to open them first.
    db.recordMatch(match(id, {
      mode: 'solo', difficulty: 'rookie', bestStreak: 12, earnedStreak: 12, endStreak: 0, matchKey: 'wp:1',
    }));
    expect(db.getProfile(id).achievements).toContain('rally_10');

    // A session that earned almost nothing, on a run carried in.
    db.recordPractice(id, { bestStreak: 95, earnedStreak: 2, endStreak: 95 });
    // The peak is what the wall rungs and the mode's best are about — a
    // carried run is a real run of returns, however many sessions it took.
    expect(db.getModeStats(id).practice.bestStreak).toBe(95);
    const earned = db.getProfile(id).achievements;
    expect(earned).toContain('wall_30');
    expect(earned).toContain('wall_90');
  });

  it('pays a match on what it earned, not on the run it started with', () => {
    init('dev_carrypay00000001', 'CarryPayA');
    init('dev_carrypay00000002', 'CarryPayB');
    // Same match, same peak. One player built all of it here; the other walked
    // in on it and returned one ball.
    const built = db.recordMatch(match('dev_carrypay00000001', {
      mode: 'solo', difficulty: 'rookie', bestStreak: 14, earnedStreak: 14, endStreak: 14, matchKey: 'cp:1',
    }));
    const carried = db.recordMatch(match('dev_carrypay00000002', {
      mode: 'solo', difficulty: 'rookie', bestStreak: 14, earnedStreak: 1, endStreak: 14, matchKey: 'cp:2',
    }));
    expect(built.earnedXp).toBeGreaterThan(carried.earnedXp);
    // But the career best is the run, for both of them.
    expect(db.getProfile('dev_carrypay00000001').highestRally).toBe(14);
    expect(db.getProfile('dev_carrypay00000002').highestRally).toBe(14);
  });

  it('refuses a claim to have earned more than the run ever reached', () => {
    // Two players rather than two matches: a second match on one profile has
    // moved its own rating, so the XP is no longer comparable.
    init('dev_carrylie00000001', 'CarryLieA');
    init('dev_carrylie00000002', 'CarryLieB');
    const honest = db.recordMatch(match('dev_carrylie00000001', {
      mode: 'solo', difficulty: 'rookie', bestStreak: 3, earnedStreak: 3, endStreak: 3, matchKey: 'cl:a',
    }));
    const liar = db.recordMatch(match('dev_carrylie00000002', {
      mode: 'solo', difficulty: 'rookie', bestStreak: 3, earnedStreak: 9999, endStreak: 3, matchKey: 'cl:b',
    }));
    expect(liar.earnedXp).toBe(honest.earnedXp);
  });
});

// ---------------------------------------------------------------------------
// Solo XP momentum and fatigue, through the real store. The pure shape lives
// in tests/xp.test.ts; what THIS half owns is the plumbing: the win streak is
// read from player_mode_stats BEFORE the match's own bump, the fatigue tally
// rides recordMatch's transaction and idempotency, and PvP never touches it.
// Rookie is the fixture on purpose: its solo cap IS START_MU, so a fresh
// player's hidden rating cannot move and the prediction stays put — which
// leaves momentum as the only force moving the payout.
// ---------------------------------------------------------------------------

describe('solo XP momentum, recorded', () => {
  const soloWin = (id: string, n: number) =>
    db.recordMatch(
      match(id, {
        mode: 'solo',
        difficulty: 'rookie',
        playerScore: 5,
        opponentScore: 2,
        bestStreak: 4,
        earnedStreak: 4,
        endStreak: 0,
        matchKey: `momentum:${id}:${n}`,
      })
    );

  it('ramps consecutive wins up, and a loss resets the ramp', () => {
    init('p_momentum', 'Momentum');
    const run: number[] = [];
    for (let i = 0; i < 5; i++) run.push(soloWin('p_momentum', i).earnedXp);
    // Each consecutive win pays more than the last — the streak walked in on
    // grows faster than the day's fatigue accrues.
    for (let i = 1; i < run.length; i++) expect(run[i]).toBeGreaterThan(run[i - 1]);

    db.recordMatch(
      match('p_momentum', {
        mode: 'solo', difficulty: 'rookie', playerScore: 1, opponentScore: 5,
        isWinner: false, bestStreak: 2, earnedStreak: 2, endStreak: 0,
        matchKey: 'momentum:p_momentum:loss',
      })
    );
    // The next win walks in on a reset streak AND a fatigued day: well below
    // the pre-loss peak.
    const afterLoss = soloWin('p_momentum', 99).earnedXp;
    expect(afterLoss).toBeLessThan(run[run.length - 1]);
  });

  it('counts a solo game into the day once per matchKey, and never for a duel', () => {
    init('p_fatigue', 'FatigueCase');
    soloWin('p_fatigue', 1);
    // A replay of the same matchKey is answered from the stamp: no second
    // payment, and no second tick on the fatigue tally.
    soloWin('p_fatigue', 1);
    db.recordMatch(match('p_fatigue', { matchKey: 'momentum:p_fatigue:duel' })); // multiplayer
    const raw = new DatabaseSync(DB_FILE, { readOnly: true });
    try {
      const row = raw
        .prepare("SELECT gamesPlayed FROM daily_solo WHERE playerId = 'p_fatigue'")
        .get() as { gamesPlayed: number } | undefined;
      expect(row?.gamesPlayed).toBe(1);
    } finally {
      raw.close();
    }
  });
});

describe('pruneStaleGuests', () => {
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  const age = (id: string, days: number) => {
    const when = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    (db as unknown as { sql: { prepare: (q: string) => { run: (...a: unknown[]) => void } } }).sql
      .prepare('UPDATE players SET lastActive = ? WHERE id = ?')
      .run(when, id);
  };

  it('drops a placeholder nobody came back to', () => {
    db.getProfile('guest_old');
    age('guest_old', 30);
    expect(db.pruneStaleGuests(WEEK)).toBeGreaterThanOrEqual(1);
    expect(
      (db as unknown as { sql: { prepare: (q: string) => { get: (...a: unknown[]) => unknown } } }).sql
        .prepare('SELECT id FROM players WHERE id = ?')
        .get('guest_old')
    ).toBeUndefined();
  });

  it('keeps a placeholder that is still recent', () => {
    db.getProfile('guest_fresh');
    db.pruneStaleGuests(WEEK);
    expect(db.getProfile('guest_fresh').id).toBe('guest_fresh');
  });

  it('never touches an account, however long it has been idle', () => {
    db.getProfile('guest_real');
    db.initializeProfile('guest_real', 'GuestReal');
    age('guest_real', 400);
    db.pruneStaleGuests(WEEK);
    const back = db.getProfile('guest_real');
    expect(back.username).toBe('GuestReal');
    expect(back.initialized).toBe(true);
  });

  it('never touches a placeholder that has actually played', () => {
    db.getProfile('guest_played');
    db.initializeProfile('guest_played', 'GuestPlayed');
    db.recordMatch({
      playerId: 'guest_played',
      username: 'GuestPlayed',
      playerScore: 5,
      opponentScore: 1,
      bestStreak: 4,
      endStreak: 0,
      earnedStreak: 4,
      mode: 'solo',
      difficulty: 'rookie',
      isWinner: true,
    });
    age('guest_played', 400);
    db.pruneStaleGuests(WEEK);
    expect(db.getProfile('guest_played').matchesPlayed).toBe(1);
  });

  it('leaves the seeded bots alone', () => {
    const bots = (
      db as unknown as { sql: { prepare: (q: string) => { all: () => { n: number }[] } } }
    ).sql.prepare("SELECT COUNT(*) AS n FROM players WHERE id LIKE 'bot-%'").all()[0].n;
    db.pruneStaleGuests(0);
    const after = (
      db as unknown as { sql: { prepare: (q: string) => { all: () => { n: number }[] } } }
    ).sql.prepare("SELECT COUNT(*) AS n FROM players WHERE id LIKE 'bot-%'").all()[0].n;
    expect(after).toBe(bots);
  });
});
