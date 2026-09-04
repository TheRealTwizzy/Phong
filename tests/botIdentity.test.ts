import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-botid-test-'));
process.env.DATA_DIR = TMP;
const DB_FILE = path.join(TMP, 'phong.db');

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let db: typeof import('../server/db').db;
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let isBotAccount: typeof import('../server/db').isBotAccount;
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let PLAYER_KEYED_TABLES: typeof import('../server/db').PLAYER_KEYED_TABLES;

beforeAll(async () => {
  ({ db, isBotAccount, PLAYER_KEYED_TABLES } = await import('../server/db'));
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const raw = <T>(fn: (h: DatabaseSync) => T): T => {
  const h = new DatabaseSync(DB_FILE);
  try {
    return fn(h);
  } finally {
    h.close();
  }
};

const botRowsFor = (id: string): number =>
  raw((h) => {
    const r = h.prepare('SELECT COUNT(*) AS n FROM bot_accounts WHERE botId = ?').get(id) as
      | { n: number }
      | undefined;
    return r?.n ?? 0;
  });

describe('bot_accounts is the sole authority; the prefix is a naming convention', () => {
  it('classifies an ordinary-id account WITH a row as a bot', () => {
    db.insertBot({ id: 'bot-authority-01', username: 'AuthorityOne', mu: 25 });
    // The id happens to carry the prefix because insertBot's naming guard
    // demands it. What decides the answer is the row, asserted directly.
    expect(botRowsFor('bot-authority-01')).toBe(1);
    expect(isBotAccount('bot-authority-01')).toBe(true);
  });

  it('classifies a prefixed id with NO row as a HUMAN', () => {
    // The whole point of D26: the prefix stops being the classifier. Minted
    // through the ordinary lazy-mint path — which is exactly how an id the
    // server has not seen gets a profile — so nothing on the way in could add
    // a bot_accounts row behind it. insertBot is the ONLY writer of that
    // table, and this deliberately does not go near it.
    db.getProfile('bot-impostor-01');
    expect(db.initializeProfile('bot-impostor-01', 'Impostor').ok).toBe(true);
    expect(botRowsFor('bot-impostor-01')).toBe(0);
    expect(isBotAccount('bot-impostor-01')).toBe(false);
  });

  it('answers false for an ordinary device id and for junk', () => {
    expect(isBotAccount('dev_000000000000000001')).toBe(false);
    expect(isBotAccount('')).toBe(false);
    expect(isBotAccount(null)).toBe(false);
    expect(isBotAccount(undefined)).toBe(false);
  });
});

describe('the in-memory Set is a CACHE and must equal the table', () => {
  // bot_accounts is the authority; isBotAccount reads a Set for the hot path.
  // After any COMMITTED mutation the two must agree, or a board query and a
  // recordMatch can disagree about the same account with no error anywhere.
  const cacheMatchesTable = (): void => {
    const inTable = raw((h) =>
      (h.prepare('SELECT botId FROM bot_accounts').all() as unknown as Array<{ botId: string }>).map(
        (r) => r.botId
      )
    );
    for (const id of inTable) expect(isBotAccount(id)).toBe(true);
    // And nothing the table does not name reads as a bot.
    const players = raw((h) =>
      (h.prepare('SELECT id FROM players').all() as unknown as Array<{ id: string }>).map((r) => r.id)
    );
    for (const id of players) {
      expect(isBotAccount(id)).toBe(inTable.includes(id));
    }
  };

  it('agrees after insertBot', () => {
    db.insertBot({ id: 'bot-lifecycle-01', username: 'LifecycleOne', mu: 22 });
    cacheMatchesTable();
  });

  it('agrees after a reload — the Set is rebuilt from the table at boot', async () => {
    // The cache is derived state. Rebuilding it must reproduce the table
    // exactly, or a restart silently changes who is a bot.
    const before = raw((h) =>
      (h.prepare('SELECT botId FROM bot_accounts ORDER BY botId').all() as unknown as Array<{
        botId: string;
      }>).map((r) => r.botId)
    );
    db.reloadBotAccounts();
    for (const id of before) expect(isBotAccount(id)).toBe(true);
    cacheMatchesTable();
  });

  it('a FAILED insert leaves no cache entry — the poisoning case', () => {
    // The reachable form of "a rolled-back transaction must leave no cache
    // mutation behind": seedBotRoster catches a per-bot insert failure, and a
    // username already held by a human is the real one (the unique index
    // throws). If the cache is written before the INSERT lands, that skipped
    // bot is cached as a bot with no row behind it.
    const human = 'dev_111111111111111111';
    db.getProfile(human);
    const claimed = db.initializeProfile(human, 'ContestedName');
    expect(claimed.ok).toBe(true);

    let threw = false;
    try {
      db.insertBot({ id: 'bot-collide-01', username: 'ContestedName', mu: 25 });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // No row, and — the assertion that matters — no cache entry either.
    expect(botRowsFor('bot-collide-01')).toBe(0);
    expect(isBotAccount('bot-collide-01')).toBe(false);
    cacheMatchesTable();
  });

  it('a poisoned entry would be INVISIBLE without this — the human keeps ×1.00 either way', async () => {
    // Why the assertion above is on the weight-bearing side and not just on
    // the Set. Under §2.1 the ×0.70 belongs to the HUMAN side of a
    // human-vs-bot match; the bot side is ×1.00. So a human falsely
    // classified as a bot is NEVER the one reduced — against a human the pair
    // reads human-bot with the poisoned account on the BOT side (×1.00,
    // unchanged, invisible), and against a real bot it reads bot-bot (×1.00,
    // where ×0.70 was correct).
    //
    // "Assert the poisoned account still takes ×1.00" therefore passes in
    // BOTH states and detects nothing. The discriminating case is the human
    // against a REAL bot.
    const { participantWeights, pairKindFor } = await import('../src/playbotRating');
    const humanId = 'dev_111111111111111111';
    const realBot = 'bot-authority-01';

    expect(isBotAccount(humanId)).toBe(false);
    expect(isBotAccount(realBot)).toBe(true);

    const kind = pairKindFor(isBotAccount(humanId), isBotAccount(realBot));
    expect(kind).toBe('human-bot');

    const w = participantWeights({ kind, selfIsBot: false, won: true, counts: null });
    expect(w.mu).toBeCloseTo(0.7, 10);
    expect(w.sigma).toBeCloseTo(0.7, 10);

    // Poisoned, this same pairing would read bot-bot and hand the human
    // ×1.00 — the value a correct human-vs-human match also produces, which
    // is exactly why the naive assertion cannot see it.
    const poisoned = pairKindFor(true, true);
    expect(poisoned).toBe('bot-bot');
    expect(participantWeights({ kind: poisoned, selfIsBot: true, won: true, counts: null }).mu)
      .toBeCloseTo(1, 10);
  });
});

describe('bot_accounts_backfill_v1', () => {
  it('claimed every pre-existing bot- row exactly once', () => {
    // The ONLY legitimate reading of the prefix left in the codebase: a
    // one-time migration of the old convention into the authoritative table.
    const prefixed = raw((h) =>
      (h.prepare("SELECT id FROM players WHERE id LIKE 'bot-%'").all() as unknown as Array<{
        id: string;
      }>).map((r) => r.id)
    );
    expect(prefixed.length).toBeGreaterThan(0);

    // Every prefixed row that the backfill saw is claimed; the impostor
    // inserted AFTER the backfill ran is not, which is the point — the
    // migration is one-shot and the prefix stops meaning anything after it.
    for (const id of prefixed) {
      if (id === 'bot-impostor-01') continue;
      expect(isBotAccount(id)).toBe(true);
    }
    expect(db.getMeta('bot_accounts_backfill_v1')).toBeTruthy();
  });
});

describe('bot_accounts is NOT a player-keyed table', () => {
  it('is absent from PLAYER_KEYED_TABLES, and carries no playerId column', () => {
    // A bot has no browser, so it is never moved between devices and never
    // deleted by a player. PLAYER_KEYED_TABLES is walked by moveAccount and
    // deleteAccount; a bot roster in that list would be carried onto a human's
    // new device by a sign-in.
    //
    // tests/identity.test.ts enforces the other half: it walks the LIVE schema
    // for any table with a `playerId` column and requires it in that list. So
    // the column name is load-bearing — calling it `playerId` would force this
    // table into a list it must not be in.
    expect((PLAYER_KEYED_TABLES as readonly string[]).includes('bot_accounts')).toBe(false);
    const cols = raw((h) =>
      (h.prepare('PRAGMA table_info(bot_accounts)').all() as unknown as Array<{ name: string }>).map(
        (c) => c.name
      )
    );
    expect(cols).toContain('botId');
    expect(cols).not.toContain('playerId');
  });
});
