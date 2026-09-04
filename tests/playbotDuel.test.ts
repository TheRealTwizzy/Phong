import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { seedTraits } from '../server/playbotTraits';
import { PlaybotDriver, serveAimFor } from '../server/playbotDriver';
import { sleep, startRelay, type Relay } from './helpers/relay';

// Two bots, a real relay, a real socket each, and a duel played out to a
// recorded result.
//
// Everything here goes through the doors a phone goes through: a device
// cookie, a session from POST /api/session, the WS upgrade, the lobby
// handshake. There is no privileged in-process path, and that is the point —
// a shortcut past `requireActiveSession` or the upgrade would be a second door
// into everything those two guard.

let relay: Relay;
let dbFile: string;
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let auth: typeof import('../server/auth');
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let db: typeof import('../server/db').db;

beforeAll(async () => {
  relay = await startRelay('playbot-duel');
  dbFile = path.join(relay.dataDir, 'phong.db');
  // The relay runs in its own process against its own DATA_DIR; this side
  // reads and signs against the same file.
  process.env.DATA_DIR = relay.dataDir;
  auth = await import('../server/auth');
  ({ db } = await import('../server/db'));
}, 60_000);

afterAll(async () => {
  await relay?.stop();
});

let seq = 0;

/** A play-bot: onboarded through the ordinary doors, then marked as a bot. */
const bootBot = async (label: string, skill = 0.12): Promise<PlaybotDriver> => {
  seq += 1;
  const username = `${label}${seq}`.slice(0, 16);
  // Traits are seeded from the id, which is ISSUED — so they are applied after
  // onboarding, which is also the moment the marker row is written.
  const driver = new PlaybotDriver({
    base: relay.base,
    wsUrl: relay.wsUrl,
    username,
    // Seeded traits with the SKILL turned down. Two bots at a seeded skill
    // rally for about seventy seconds a match, which is honest play and a bad
    // test: what is under test here is the plumbing, not how good a bot is,
    // and a fixture that takes a minute is one that goes flaky on a loaded
    // runner. `tests/playbotTraits.test.ts` owns the strength side.
    traits: { ...seedTraits(username), skill },
  });
  await driver.provision((botId) => {
    // The one step with no HTTP route behind it, deliberately: a client that
    // could declare itself a bot could take the reduced stakes with it.
    const raw = new DatabaseSync(dbFile);
    try {
      raw
        .prepare('INSERT OR IGNORE INTO bot_accounts (botId, createdAt) VALUES (?, ?)')
        .run(botId, new Date().toISOString());
    } finally {
      raw.close();
    }
    db.reloadBotAccounts();
  });
  await driver.connect();
  return driver;
};

const profileOf = (id: string) => {
  const raw = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return raw
      .prepare(
        'SELECT matchesPlayed, matchesWon, matchesLost, xp, rankMu, rankedGames, rankedDuels FROM players WHERE id = ?'
      )
      .get(id) as {
      matchesPlayed: number;
      matchesWon: number;
      matchesLost: number;
      xp: number;
      rankMu: number;
      rankedGames: number;
      rankedDuels: number;
    };
  } finally {
    raw.close();
  }
};

/** Wait for a condition, or fail with what was actually true. */
const until = async (what: string, cond: () => boolean, ms = 25_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
};

describe('two bots play a duel', () => {
  it('plays it out and records it on both profiles', async () => {
    const host = await bootBot('DriverHost');
    const guest = await bootBot('DriverGuest');

    host.host({ winningScore: 3 });
    await until('the host to hold a room', () => host.roomId !== null);
    guest.join(host.roomId!);
    await until('the match to start', () => host.phase !== 'lobby' && guest.phase !== 'lobby');

    // Played by the two AI halves, with no help from here: the serve, the
    // rally, the crossings and the points are all the drivers' own.
    await until('the match to finish', () => host.phase === 'over' && guest.phase === 'over', 40_000);
    expect(Math.max(...host.scores)).toBe(3);
    expect(host.scores).toEqual(guest.scores);

    // The relay records a decided duel for BOTH seats the moment the score
    // decides it, so the result is on both profiles without either bot
    // POSTing anything.
    await until('both profiles to be recorded', () => {
      const a = profileOf(host.botId);
      const b = profileOf(guest.botId);
      return a.matchesPlayed === 1 && b.matchesPlayed === 1;
    });

    const hostId = host.botId;
    const guestId = guest.botId;
    const a = profileOf(hostId);
    const b = profileOf(guestId);

    expect(a.matchesPlayed).toBe(1);
    expect(b.matchesPlayed).toBe(1);
    // One winner, one loser — not two of either.
    expect(a.matchesWon + b.matchesWon).toBe(1);
    expect(a.matchesLost + b.matchesLost).toBe(1);
    // Bots earn persistent XP, so they level and open content like any
    // account (§2.8: XP is untouched everywhere, bots included).
    expect(a.xp).toBeGreaterThan(0);
    expect(b.xp).toBeGreaterThan(0);
    // The ladder moved for both, and the duel counted toward the apex gate:
    // a bot always takes x1.00, so bot-vs-bot progresses exactly like the
    // equivalent human duel.
    expect(a.rankMu).not.toBe(25);
    expect(b.rankMu).not.toBe(25);
    // Onboarded as an ordinary account, so this is its FIRST ranked game —
    // `insertBot`'s pre-placed roster seeding is not on this path.
    expect(a.rankedGames).toBe(1);
    expect(a.rankedDuels).toBe(1);
    expect(b.rankedDuels).toBe(1);

    host.close();
    guest.close();
  }, 90_000);
});

describe('a bot at a table with a human', () => {
  it('hosts one a human can find and join, and plays the match out', async () => {
    const bot = await bootBot('DriverTableHost');
    bot.host({ winningScore: 3 }, 'casual');
    await until('the table to exist', () => bot.roomId !== null);

    // Found the way a human finds one: the room browser's own listing.
    const listed = await fetch(`${relay.base}/api/rooms/casual/tables`).then((r) => r.json());
    // The listing names a table `id`, not `roomId` — the two routes that
    // describe a table do not spell it the same way.
    expect((listed.tables as Array<{ id: string }>).some((t) => t.id === bot.roomId)).toBe(true);

    const human = await relay.newDevice('TableHuman');
    const phone = await relay.openPhone(human);
    phone.send({ type: 'join_room', roomId: bot.roomId, playerId: human.id });
    await phone.await('room_joined');
    phone.send({ type: 'player_ready', ready: true });
    await phone.await('game_start');

    // The human concedes the match; what is under test is that the bot took
    // the seat, ran the handshake and is playing, not who wins.
    for (let i = 1; i <= 3; i += 1) {
      phone.send({ type: 'point_scored', scorer: bot.seat === 0 ? 'p1' : 'p2' });
      await phone.awaitCount('score_update', i);
    }
    await phone.await('match_recorded');
    await until('the bot to see the match end', () => bot.phase === 'over');

    phone.close();
    bot.close();
  }, 90_000);

  it('joins a table a human is hosting', async () => {
    const human = await relay.newDevice('TableOwner');
    const phone = await relay.openPhone(human);
    phone.send({
      type: 'create_room',
      playerId: human.id,
      config: { winningScore: 3, rules: {} },
      visibility: 'public',
    });
    const created = (await phone.await('room_created')) as { roomId: string };

    const bot = await bootBot('DriverJoiner');
    bot.join(created.roomId);
    // The bot readies itself on arrival — a bot that took a human's table and
    // then never said yes would leave the host waiting on a Start they can
    // never press.
    await phone.await('ready_state');
    phone.send({ type: 'start_match' });
    await phone.await('game_start');
    await until('the bot onto the court', () => bot.phase !== 'lobby' && bot.phase !== 'idle');

    // The bot's paddle reaches the other phone. That stream is for the
    // OPPONENT's benefit — their net indicators, and the aim of their own
    // serve — so a bot that never sent one would play a valid match against
    // somebody serving blind. Nothing else here would notice: measured,
    // removing the send reddened none of the duels.
    await phone.await('opponent_paddle');

    phone.close();
    bot.close();
  }, 60_000);
});

describe('the serve frame', () => {
  it('aims AWAY from where the opponent is standing, in this half’s coordinates', () => {
    // The likeliest bug in the driver and the least visible: `aiServeAim` was
    // written for solo, where the caller hands it the local player's paddle in
    // the PLAYER's frame, so it mirrors internally. `opponent_paddle` arrives
    // ALREADY mirrored into this half's frame, so it must be un-mirrored going
    // in. Backwards, the bot serves straight AT the opponent — which changes
    // who wins and is invisible to a match-level test: measured, flipping it
    // reddened none of the three duels above.
    //
    // Asserted over many serves because the aim carries deliberate noise; a
    // single serve says nothing about where it was pointed.
    const mean = (oppX: number): number => {
      let total = 0;
      for (let i = 0; i < 400; i += 1) total += serveAimFor(0.8, oppX).angle;
      return total / 400;
    };
    // Opponent hard left in this frame → serve to the right, and the reverse.
    expect(mean(0.05)).toBeGreaterThan(0.2);
    expect(mean(0.95)).toBeLessThan(-0.2);
    // Dead centre commits to neither side on average.
    expect(Math.abs(mean(0.5))).toBeLessThan(0.2);
  });
});
