import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { PLACEMENT_GAMES, PLACEMENT_SIGMA } from '../src/rating';
import type { MatchEndPayload } from '../src/types';

// The one-shot placement_sigma_v1 migration. Placement needed BOTH enough
// ranked games AND sigma <= PLACEMENT_SIGMA, and at the ordinary PvP shrink
// the sigma condition was not reachable until roughly the sixteenth ranked
// game — while the profile screen counted to five and stopped. Placement
// matches now shed uncertainty faster, but that only helps people placing from
// here on; anyone already past their placement games carries a sigma earned
// under the old rule and would go on waiting forever.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-placement-test-'));
process.env.DATA_DIR = TMP;

const DB_FILE = path.join(TMP, 'phong.db');
const STRANDED_SIGMA = 5.36; // what five ranked games actually left behind

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let mod: typeof import('../server/db');

const duel = (playerId: string, i: number, isWinner: boolean): MatchEndPayload => ({
  playerId,
  username: 'ignored',
  playerScore: isWinner ? 5 : 2,
  opponentScore: isWinner ? 2 : 5,
  maxRally: 8,
  mode: 'multiplayer',
  isWinner,
  matchKey: `${playerId}:pvp:${i}`,
});

const init = (id: string, username: string) => {
  mod.db.getProfile(id);
  const res = mod.db.initializeProfile(id, username);
  if (!res.ok) throw new Error(`init failed: ${res.code}`);
};

/** Put the database back into the state the OLD placement rule left behind. */
function rewindToOldRule(ids: string[]) {
  const raw = new DatabaseSync(DB_FILE);
  for (const id of ids) {
    raw.prepare('UPDATE players SET rankSigma = ? WHERE id = ?').run(STRANDED_SIGMA, id);
  }
  raw.prepare('DELETE FROM meta WHERE key = ?').run('placement_sigma_v1');
  raw.close();
}

beforeAll(async () => {
  mod = await import('../server/db');
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('releasing players stranded by the old placement rule', () => {
  it('places someone who finished their placement duels but never got a badge', async () => {
    init('dev_stranded_aaaaaaaaaaaa', 'Stranded');
    for (let i = 0; i < PLACEMENT_GAMES; i++) {
      mod.db.recordMatch(duel('dev_stranded_aaaaaaaaaaaa', i, i % 2 === 0));
    }
    // Under today's rule they are placed the moment placement ends.
    expect(mod.db.getProfile('dev_stranded_aaaaaaaaaaaa').tier).not.toBe('unranked');

    // Someone who has barely started must NOT be swept up by the rescue.
    init('dev_early_bbbbbbbbbbbbbb', 'TooEarly');
    mod.db.recordMatch(duel('dev_early_bbbbbbbbbbbbbb', 0, true));

    rewindToOldRule(['dev_stranded_aaaaaaaaaaaa', 'dev_early_bbbbbbbbbbbbbb']);

    // Confirm the rewind really did strand them before the migration runs.
    vi.resetModules();
    const before = new DatabaseSync(DB_FILE);
    const row = before
      .prepare('SELECT rankSigma, rankedGames FROM players WHERE id = ?')
      .get('dev_stranded_aaaaaaaaaaaa') as { rankSigma: number; rankedGames: number };
    before.close();
    expect(row.rankedGames).toBe(PLACEMENT_GAMES);
    expect(row.rankSigma).toBeGreaterThan(PLACEMENT_SIGMA);

    // Boot again: the migration runs and the badge follows, because the tier
    // is derived on read rather than stored.
    mod = await import('../server/db');
    const rescued = mod.db.getProfile('dev_stranded_aaaaaaaaaaaa');
    expect(rescued.rankSigma).toBeLessThanOrEqual(PLACEMENT_SIGMA);
    expect(rescued.tier).not.toBe('unranked');

    // ...and nobody is placed who had not earned it.
    const early = mod.db.getProfile('dev_early_bbbbbbbbbbbbbb');
    expect(early.rankedGames).toBeLessThan(PLACEMENT_GAMES);
    expect(early.tier).toBe('unranked');
  });

  it('runs exactly once, so a later sigma is never quietly reset', async () => {
    // A placed player whose uncertainty legitimately grew again (tau adds
    // uncertainty every match) must not be re-clamped on every boot.
    const raw = new DatabaseSync(DB_FILE);
    raw.prepare('UPDATE players SET rankSigma = ? WHERE id = ?').run(6.5, 'dev_stranded_aaaaaaaaaaaa');
    raw.close();

    vi.resetModules();
    mod = await import('../server/db');
    expect(mod.db.getProfile('dev_stranded_aaaaaaaaaaaa').rankSigma).toBeCloseTo(6.5, 6);
    expect(mod.db.getMeta('placement_sigma_v1')).toBeTruthy();
  });
});
