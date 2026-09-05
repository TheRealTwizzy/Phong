import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { seedTraits, type PlaybotTraits } from '../server/playbotTraits';
import { PlaybotDriver, serveAimFor } from '../server/playbotDriver';
import { BASE_BALL_SPEED } from '../src/game/physics';
import { MATCH_START_COUNTDOWN_SECONDS } from '../src/matchRules';
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
const bootBot = async (
  label: string,
  skill = 0.12,
  /**
   * What the SUPERVISOR supplies in production: who this bot turns out to be
   * sitting opposite, and the coin flip an appetite is judged against.
   * Injected here so a rematch decision is a fact rather than a fifty-fifty.
   */
  extra: {
    traits?: Partial<PlaybotTraits>;
    opponentFacts?: (opponentId: string) => { isBot: boolean; recentPairCount: number } | null;
    rollFor?: () => number;
  } = {}
): Promise<PlaybotDriver> => {
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
    traits: { ...seedTraits(username), skill, ...extra.traits },
    opponentFacts: extra.opponentFacts,
    rollFor: extra.rollFor,
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
    // 90s rather than 40s, and the ceiling is not what this asserts. Two AI
    // halves rallying is genuinely timing-dependent — the serve delays, the
    // ball travel and the points each bot happens to win — and 40s was tuned
    // on an idle box. It fell over on CI once the supervisor suite started
    // booting its own servers in a parallel test FILE, which is contention
    // rather than a slower match. What is under test is that the two drivers
    // play a duel out between them, not how long a loaded runner takes.
    await until('the match to finish', () => host.phase === 'over' && guest.phase === 'over', 90_000);
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

  it('sends a ball whose speedMultiplier matches the velocity it is sent with', async () => {
    // `speedMultiplier` is DERIVED display metadata, not a factor: the browser
    // computes it as `hypot(vx, vy) / BASE_BALL_SPEED` and integrates vx/vy
    // straight, because the 4% a paddle adds is already inside the velocity
    // `checkPaddleCollision` returns.
    //
    // The driver used to do BOTH -- multiply the integration by it AND grow it
    // another 4% per contact -- so the bot's half ran at roughly
    // `speed x 1.04^n` while the human's ran at `speed`, and the number on the
    // wire had stopped describing the ball it travelled with. This is the
    // wire's own account of that, which is the only place the divergence
    // surfaces: the identity is exact on every crossing or it is broken.
    // Skill 0.6 rather than the file's default 0.12, and the number is
    // MEASURED rather than picked: the driver passes `skill` straight through
    // as competence, and `aiServeAim`'s power rises with it, so at 0.12 the
    // serve leaves between 0.92x and 1.06x the base speed -- which straddles
    // 1, so a single crossing can land close enough to it that the old
    // accumulated value of 1 would have satisfied the identity too. Over every
    // paddle position at 0.6 the range is 1.073..1.318, clear of the guard
    // below. Nobody has to win here, so a stronger server costs nothing.
    const bot = await bootBot('SpeedHost', 0.6);
    bot.host({ winningScore: 15 }, 'casual');
    await until('a table', () => bot.roomId !== null);

    const human = await relay.newDevice('SpeedHuman');
    const phone = await relay.openPhone(human);
    phone.send({ type: 'join_room', roomId: bot.roomId!, playerId: human.id });
    await phone.await('room_joined');
    phone.send({ type: 'player_ready', ready: true });
    await phone.await('game_start');

    await phone.await('ball_incoming', 30_000);
    await sleep(500);
    const balls = phone.all('ball_incoming').map((m) => m.ball);
    expect(balls.length).toBeGreaterThan(0);

    for (const b of balls) {
      const derived = Math.hypot(b.vx, b.vy) / BASE_BALL_SPEED;
      expect(Math.abs(derived - b.speedMultiplier)).toBeLessThan(1e-6);
    }

    // ...and the identity cannot have held VACUOUSLY on a ball that happened
    // to leave at exactly the base speed, where the old accumulated value of 1
    // would have satisfied it too.
    expect(
      balls.some((b) => Math.abs(b.speedMultiplier - 1) > 0.02),
      'every crossing left at the base speed, so this proves nothing'
    ).toBe(true);

    phone.close();
    bot.close();
  }, 90_000);

  it('streams the live ball, so the far half is not dark on the sonar', async () => {
    // The driver sent `paddle_move` and never `ball_pos`. Everything a human
    // reads about the OPPONENT'S half is fed by that second stream, so against
    // a bot all of it went dark for exactly the half it exists to describe:
    // the Ball indicator -- a ranked-legal device preference that is ON BY
    // DEFAULT, so this reached every human who ever played a bot -- and the
    // opponent SONAR, which is the sharper one, because that is a match RULE a
    // player gives up their ladder to switch on (§12) and it then showed them
    // nothing during the bot's exchanges.
    //
    // Read at the WIRE as `opponent_ball`, which is where the divergence
    // actually lives: only the bot sends anything here, since the phone below
    // is a raw socket that never reports a ball of its own.
    const bot = await bootBot('SonarHost', 0.6);
    bot.host({ winningScore: 15 }, 'casual');
    await until('a table', () => bot.roomId !== null);

    const human = await relay.newDevice('SonarHuman');
    const phone = await relay.openPhone(human);
    phone.send({ type: 'join_room', roomId: bot.roomId!, playerId: human.id });
    await phone.await('room_joined');
    phone.send({ type: 'player_ready', ready: true });
    await phone.await('game_start');

    // The crossing is the end of the bot's own half-flight, so by here the
    // whole of that flight has been streamed or none of it has.
    await phone.await('ball_incoming', 30_000);
    const samples = phone.all('opponent_ball').map((m) => ({ x: m.x, y: m.y }));

    expect(samples.length).toBeGreaterThan(0);
    // In the SENDER's frame and unmirrored (§5), so they are ordinary court
    // coordinates rather than anything transformed on the way.
    for (const s of samples) {
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.x).toBeLessThanOrEqual(1);
      expect(s.y).toBeGreaterThanOrEqual(0);
      expect(s.y).toBeLessThanOrEqual(1);
    }
    // Not one frozen sample repeated: a radar fed a single position is still a
    // dark radar, and a one-shot send would satisfy the count alone.
    expect(new Set(samples.map((s) => `${s.x},${s.y}`)).size).toBeGreaterThan(1);

    // And the FRAME, which is the assertion the range check above cannot make
    // and the one §1 warns is invisible against a symmetric fixture. In the
    // sender's own frame the bot serves from its paddle at y≈0.88 and the ball
    // runs toward the net at y=0, so y falls across the flight. Mirrored on the
    // way -- the mistake this convention keeps inviting, since the RECEIVER is
    // what applies `1 - y` -- these would start near 0.12 and rise instead, and
    // every assertion above would still pass.
    expect(samples[0].y).toBeGreaterThan(0.5);
    expect(samples[0].y).toBeGreaterThan(samples[samples.length - 1].y);

    // And the SILENCE is the other half of the rule: once the ball has left
    // this half the stream stops, which is what lets the far radar go dark
    // rather than freeze on the last thing it was told. The phone never
    // returns the ball, so the bot has nothing to report from here.
    //
    // Named rather than counted, because it is catalogue shape 2 -- a guard
    // defended by guards upstream. The crossing sets `ball.active = false`,
    // nulls `this.ball` AND moves the phase to `waiting`, and the emission is
    // behind all three, so no single mutation reddens this. It is kept for the
    // invariant it states, not as cover for the line above it: a later change
    // that streamed from a cached ball to smooth the radar is what it would
    // catch, and that is the shape this whole feature keeps producing.
    const before = phone.all('opponent_ball').length;
    await sleep(500);
    expect(phone.all('opponent_ball').length).toBe(before);

    phone.close();
    bot.close();
  }, 90_000);

  it('waits out the match-start countdown before serving', async () => {
    // `game_start` arms a three-second countdown in every browser client and
    // App.tsx blocks its own serves under it -- aimed, automatic and the space
    // bar alike. `aiServeDelay` is at most 1.15s, so a bot that served on the
    // message put the ball on the human's court while their countdown overlay
    // was still up. The arriving `ball_incoming` clears their serve gate, so
    // it was not a wasted serve but a free opening attack, on every match the
    // bot opened.
    const bot = await bootBot('CountdownBot', 0.6);
    bot.host({ winningScore: 3 }, 'casual');
    await until('a table', () => bot.roomId !== null);

    const human = await relay.newDevice('CountdownHuman');
    const phone = await relay.openPhone(human);
    phone.send({ type: 'join_room', roomId: bot.roomId!, playerId: human.id });
    await phone.await('room_joined');
    phone.send({ type: 'player_ready', ready: true });
    const started = (await phone.await('game_start')) as { servingPlayer: number };
    const startedAt = Date.now();

    // THE PRECONDITION, asserted rather than assumed: if the human served
    // first, no ball would cross either way and the emptiness below would
    // prove nothing at all (vacuity shape 8).
    expect(started.servingPlayer, 'the bot is not the first server').toBe(bot.seat);

    // Sampled just inside the countdown. The old code's entire serve delay is
    // under half of this window, so it served here on every match.
    await sleep(MATCH_START_COUNTDOWN_SECONDS * 1000 - 400);
    expect(phone.all('ball_incoming')).toHaveLength(0);
    expect(Date.now() - startedAt).toBeLessThan(MATCH_START_COUNTDOWN_SECONDS * 1000);

    // ...and it does serve once the countdown is out, so the silence above was
    // the gate rather than a bot that never plays.
    await phone.await('ball_incoming', 20_000);

    phone.close();
    bot.close();
  }, 90_000);

  it('answers a human\u2019s Play Again', async () => {
    // §2.11 makes an explicit human Rematch legitimate play that nothing may
    // block or decline -- and the driver had no `rematch_state` case at all,
    // so it never cast its own vote. The human sat on the winner overlay
    // waiting for a second player who was never going to answer, until the
    // supervisor happened to move the bot somewhere else.
    const bot = await bootBot('RematchBot');
    bot.host({ winningScore: 3 }, 'casual');
    await until('a table', () => bot.roomId !== null);

    const human = await relay.newDevice('RematchHuman');
    const phone = await relay.openPhone(human);
    phone.send({ type: 'join_room', roomId: bot.roomId!, playerId: human.id });
    await phone.await('room_joined');
    phone.send({ type: 'player_ready', ready: true });
    await phone.await('game_start');

    const seat = bot.seat === 0 ? 'p1' : 'p2';
    for (let i = 1; i <= 3; i += 1) {
      phone.send({ type: 'point_scored', scorer: seat });
      await phone.awaitCount('score_update', i);
    }
    await until('the bot to see the whistle', () => bot.phase === 'over');

    // One vote from the human is all it takes: the relay needs two, and the
    // bot's is the one that was missing.
    phone.send({ type: 'rematch_request' });
    await phone.awaitCount('game_start', 2, 20_000);

    phone.close();
    bot.close();
  }, 90_000);

  it('never refuses a person, whatever its own appetite says', async () => {
    // §2.11's first rule: an explicit human Rematch is legitimate play that
    // nothing may block or decline, at ANY pair count -- including past the
    // same-pair hard cap, where the match simply rates nothing. That is a
    // rating decision and never a reason to refuse somebody a game.
    //
    // Hostile on every axis the bot arm turns on: an appetite of zero, a roll
    // that fails any threshold, and a pair already played fifty times. All
    // three are ignored because the request came from a PERSON.
    const bot = await bootBot('NeverRefuse', 0.12, {
      traits: { rematchAppetite: 0 },
      opponentFacts: () => ({ isBot: false, recentPairCount: 50 }),
      rollFor: () => 0.999,
    });
    bot.host({ winningScore: 3 }, 'casual');
    await until('a table', () => bot.roomId !== null);

    const human = await relay.newDevice('NeverRefused');
    const phone = await relay.openPhone(human);
    phone.send({ type: 'join_room', roomId: bot.roomId!, playerId: human.id });
    await phone.await('room_joined');
    phone.send({ type: 'player_ready', ready: true });
    await phone.await('game_start');

    const seat = bot.seat === 0 ? 'p1' : 'p2';
    for (let i = 1; i <= 3; i += 1) {
      phone.send({ type: 'point_scored', scorer: seat });
      await phone.awaitCount('score_update', i);
    }
    await until('the bot to see the whistle', () => bot.phase === 'over');

    phone.send({ type: 'rematch_request' });
    await phone.awaitCount('game_start', 2, 20_000);

    phone.close();
    bot.close();
  }, 90_000);

  it('answers a person anyway when it cannot find out who they are', async () => {
    // `opponentFacts` is the first thing in a message handler that reaches the
    // DATABASE, and `handle()` is called straight out of `ws.on('message')`:
    // an uncaught throw there is one CLAUDE.md §5 answers with a controlled
    // SHUTDOWN, so a failing read while deciding one bot's rematch would end
    // every live duel on the server.
    //
    // The right answer is also the safe one: a read that failed is a driver
    // that could not find out, which §2.11 says accepts.
    const bot = await bootBot('FactsThrow', 0.12, {
      traits: { rematchAppetite: 0 },
      opponentFacts: () => {
        throw new Error('the disk is full');
      },
      rollFor: () => 0.999,
    });
    bot.host({ winningScore: 3 }, 'casual');
    await until('a table', () => bot.roomId !== null);

    const human = await relay.newDevice('FactsThrowHuman');
    const phone = await relay.openPhone(human);
    phone.send({ type: 'join_room', roomId: bot.roomId!, playerId: human.id });
    await phone.await('room_joined');
    phone.send({ type: 'player_ready', ready: true });
    await phone.await('game_start');

    const seat = bot.seat === 0 ? 'p1' : 'p2';
    for (let i = 1; i <= 3; i += 1) {
      phone.send({ type: 'point_scored', scorer: seat });
      await phone.awaitCount('score_update', i);
    }
    await until('the bot to see the whistle', () => bot.phase === 'over');

    phone.send({ type: 'rematch_request' });
    await phone.awaitCount('game_start', 2, 20_000);

    phone.close();
    bot.close();
  }, 90_000);

  it('stops standing down once it is wanted again', async () => {
    // `standingDown` is a LATCH and nothing cleared it. The supervisor clears
    // its own `Managed.retiring` when demand recovers; the driver went on
    // believing it had been let go, so it left at every subsequent whistle --
    // giving up a table the controller had just decided to keep -- and, once
    // `wantsRematch` learned to consult the flag, refused every rematch.
    //
    // Including a PERSON's, which §2.11 says nothing may do. That is the half
    // this fixture drives, because it is the one that costs somebody a game:
    // the bot is stood down and then put back in service BEFORE the match, and
    // the human's Play Again has to be answered anyway.
    const bot = await bootBot('StandBack', 0.12, {
      opponentFacts: () => ({ isBot: false, recentPairCount: 0 }),
    });
    bot.host({ winningScore: 3 }, 'casual');
    await until('a table', () => bot.roomId !== null);
    // Demand falls, then recovers -- the exact sequence two population ticks
    // produce. Standing down from an EMPTY lobby gives the table up at once
    // (there is no whistle to wait for), and the recovery tick puts the bot
    // back in service and dispatches it again, which is what `host` is here.
    bot.standDown();
    await until('the table given up', () => bot.roomId === null);
    bot.backInService();
    bot.host({ winningScore: 3 }, 'casual');
    await until('a second table', () => bot.roomId !== null);

    const human = await relay.newDevice('StandBackHuman');
    const phone = await relay.openPhone(human);
    phone.send({ type: 'join_room', roomId: bot.roomId!, playerId: human.id });
    await phone.await('room_joined');
    phone.send({ type: 'player_ready', ready: true });
    await phone.await('game_start');

    const seat = bot.seat === 0 ? 'p1' : 'p2';
    for (let i = 1; i <= 3; i += 1) {
      phone.send({ type: 'point_scored', scorer: seat });
      await phone.awaitCount('score_update', i);
    }
    // Waited on LEAVING PLAY rather than on 'over', because a latched
    // stand-down leaves inside the very handler that sets it: polling for
    // 'over' would then time out and the failure would name the poll instead
    // of the bug.
    await until('the bot to leave play', () => bot.phase === 'over' || bot.phase === 'idle');
    // Still at the table, still holding its seat. A latched stand-down gives
    // both up at the whistle, and then there is nobody to answer the vote.
    expect([bot.phase, bot.roomId === null]).toEqual(['over', false]);

    phone.send({ type: 'rematch_request' });
    await phone.awaitCount('game_start', 2, 20_000);

    phone.close();
    bot.close();
  }, 90_000);

  it('asks another bot, and takes no for an answer', async () => {
    // `acceptsRematch` had no caller: the driver accepted every vote it was
    // shown and cast none of its own, so the bot-vs-bot arm was unreachable
    // and `rematchAppetite` was a seeded trait that decided nothing -- the
    // same shape as the `spinRead` that sat inert beside it.
    //
    // Both halves in one fixture, and each is a POSITIVE observation rather
    // than a wait for something not to happen. The asker's own vote can only
    // come from the initiating branch, since nobody has asked it for one; the
    // decliner's silence is read from the SAME `rematch_state` that carries
    // the asker's vote, which it received and acted on before the message
    // reached the watcher.
    const asker = await bootBot('RematchAsker', 0.12, {
      traits: { rematchAppetite: 1 },
      opponentFacts: () => ({ isBot: true, recentPairCount: 0 }),
      rollFor: () => 0,
    });
    // Appetite 0.5 against a roll of 0.99: the taper is 1 at a pair count of
    // zero, so this is the APPETITE refusing and nothing else.
    const decliner = await bootBot('RematchDecliner', 0.12, {
      traits: { rematchAppetite: 0.5 },
      opponentFacts: () => ({ isBot: true, recentPairCount: 0 }),
      rollFor: () => 0.99,
    });

    // Watching seats open, so a phone can read the votes off the wire without
    // taking a playing seat: `rematch_state` is a room broadcast and a
    // spectator receives it byte-identically.
    asker.host({ winningScore: 3, spectators: true }, 'casual');
    await until('a table', () => asker.roomId !== null);
    const watcher = await relay.newDevice('RematchWatcher');
    const phone = await relay.openPhone(watcher);
    phone.send({ type: 'spectate_room', roomId: asker.roomId! });
    await phone.await('spectator_sync');

    decliner.join(asker.roomId!);

    // Waited for at the WIRE rather than by watching both phases reach 'over'.
    // A rematch takes them straight back out of it, so a poll for that pair is
    // a race against the fix working -- it reddens for the right change and
    // for the wrong reason, which is a test that will mislead somebody later.
    // The asker volunteered this vote: nobody asked it for one.
    const first = await phone.await('rematch_state', 150_000);
    expect(first.votes.filter(Boolean).length).toBe(1);

    // And the decliner answered no, which is read from the PHASES and
    // deliberately not from a second `rematch_state`. The relay broadcasts one
    // only while the room is still short of a vote (`bothAgreed` goes straight
    // to `startMatch`), so an accepted rematch puts no further votes on the
    // wire at all and a wire assertion here would pass either way -- a guard
    // defended by a guard upstream, which is the catalogue shape this suite
    // exists to avoid. A rematch takes both drivers straight out of 'over';
    // staying there is what a room short of a second vote looks like from the
    // inside. The decliner had the message above a relay hop before the
    // watcher did, so this settle is a round trip rather than a guess at how
    // long a match takes.
    await sleep(1_000);
    expect([asker.phase, decliner.phase]).toEqual(['over', 'over']);

    phone.close();
    asker.close();
    decliner.close();
  }, 180_000);

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
