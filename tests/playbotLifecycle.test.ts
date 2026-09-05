import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { seedTraits } from '../server/playbotTraits';
import { PlaybotDriver } from '../server/playbotDriver';
import { sleep, startRelay, type Relay } from './helpers/relay';

// A bot population starts with the process and stops with it, and neither end
// may cost anybody a rated match.
//
// The SIGTERM case is a claim CLAUDE.md §10 has carried since the
// `shuttingDown` flag shipped, verified at the time with two phones by hand.
// Two bots are two phones that do not need holding, so it is a test now.

let relay: Relay | null = null;

afterEach(async () => {
  await relay?.stop();
  relay = null;
});

let seq = 0;

const bootBot = async (r: Relay, label: string, skill = 0.12): Promise<PlaybotDriver> => {
  seq += 1;
  const username = `${label}${seq}`.slice(0, 16);
  const driver = new PlaybotDriver({
    base: r.base,
    wsUrl: r.wsUrl,
    username,
    traits: { ...seedTraits(username), skill },
  });
  await driver.provision((botId) => {
    const raw = new DatabaseSync(path.join(r.dataDir, 'phong.db'));
    try {
      raw
        .prepare('INSERT OR IGNORE INTO bot_accounts (botId, createdAt) VALUES (?, ?)')
        .run(botId, new Date().toISOString());
    } finally {
      raw.close();
    }
  });
  await driver.connect();
  return driver;
};

const until = async (what: string, cond: () => boolean, ms = 40_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
};

const profileOf = (dir: string, id: string) => {
  const raw = new DatabaseSync(path.join(dir, 'phong.db'), { readOnly: true });
  try {
    return raw
      .prepare('SELECT matchesPlayed, matchesWon, matchesLost, rankMu, abandons FROM players WHERE id = ?')
      .get(id) as {
      matchesPlayed: number;
      matchesWon: number;
      matchesLost: number;
      rankMu: number;
      abandons: number;
    };
  } finally {
    raw.close();
  }
};

describe('a deploy costs nobody a rated match', () => {
  it('charges no abandon when the process is asked to stop mid-duel', async () => {
    // `shutdown()` closes every client, and every close runs `vacateSeat`,
    // whose abandon predicate is true of EVERY live duel. Without the
    // `shuttingDown` flag a redeploy files a real ranked LOSS against
    // whichever seat's close handler ran first and a real WIN to the other,
    // for two players who did not leave.
    relay = await startRelay('playbot-lifecycle');
    const r = relay;
    const host = await bootBot(r, 'ShutHost');
    const guest = await bootBot(r, 'ShutGuest');

    host.host({ winningScore: 15 });
    await until('a room', () => host.roomId !== null);
    guest.join(host.roomId!);
    await until('the match to start', () => host.phase !== 'lobby' && guest.phase !== 'lobby');
    // A ball actually in play is what makes it an abandon — `inPlay` is set by
    // a crossing, so the duel has to be genuinely under way rather than
    // sitting in its countdown.
    await until('a point to be played', () => host.scores[0] + host.scores[1] > 0, 60_000);
    expect(Math.max(...host.scores)).toBeLessThan(15);

    // The PRECONDITION, checked rather than assumed: `abandoned` needs
    // `room.inPlay`, which only a crossing sets. Without this the fixture
    // could be asserting that a match nobody had started charges no abandon,
    // which is true of the empty case and says nothing.
    //
    // The id is VALIDATED before it reaches the URL. It arrives on a relay
    // message, so CodeQL reads it as a user-provided value flowing into a
    // request — correctly, as a shape: nothing here knows it came from a
    // server this test started. The guard is also a real assertion, since a
    // room code is four characters from an unambiguous alphabet and anything
    // else means the handshake went wrong rather than the fetch.
    const roomId = host.roomId ?? '';
    if (!/^[A-Z0-9]{4}$/.test(roomId)) throw new Error(`not a room code: ${roomId}`);
    const live = await fetch(`${r.base}/api/room/${roomId}`).then((x) => x.json());
    expect(live.inPlay).toBe(true);

    await r.terminate();

    const a = profileOf(r.dataDir, host.botId);
    const b = profileOf(r.dataDir, guest.botId);
    expect({ played: a.matchesPlayed, lost: a.matchesLost, abandons: a.abandons }).toEqual({
      played: 0, lost: 0, abandons: 0,
    });
    expect({ played: b.matchesPlayed, lost: b.matchesLost, abandons: b.abandons }).toEqual({
      played: 0, lost: 0, abandons: 0,
    });
    // A crash costs the match. It must not also cost the rating.
    expect(a.rankMu).toBe(25);
    expect(b.rankMu).toBe(25);

    host.close();
    guest.close();
  }, 120_000);
});

describe('a deactivated bot waits for the whistle', () => {
  it('finishes the match it is in, and leaves after it', async () => {
    // A bot cut off mid-rally leaves its opponent on a dead court and is
    // judged an ABANDON by the relay: a real ranked loss for a bot that did
    // nothing, and a win handed to whoever it was playing. So deactivation is
    // a request and the whistle grants it.
    relay = await startRelay('playbot-standdown');
    const r = relay;
    const host = await bootBot(r, 'StandHost');
    const guest = await bootBot(r, 'StandGuest');

    host.host({ winningScore: 3 });
    await until('a room', () => host.roomId !== null);
    guest.join(host.roomId!);
    await until('the match to start', () => host.phase !== 'lobby' && guest.phase !== 'lobby');
    await until('a point to be played', () => host.scores[0] + host.scores[1] > 0, 60_000);

    // Asked to stand down mid-match: it stays.
    guest.standDown();
    expect(guest.roomId).not.toBeNull();
    await sleep(500);
    expect(guest.roomId).not.toBeNull();

    await until('the whistle', () => host.phase === 'over', 60_000);
    await until('the guest to have left', () => guest.roomId === null);

    // The match was RECORDED — it finished — and neither side was charged an
    // abandon for the bot standing down after it.
    await until('the result on both profiles', () => {
      const a = profileOf(r.dataDir, host.botId);
      const b = profileOf(r.dataDir, guest.botId);
      return a.matchesPlayed === 1 && b.matchesPlayed === 1;
    });
    expect(profileOf(r.dataDir, host.botId).abandons).toBe(0);
    expect(profileOf(r.dataDir, guest.botId).abandons).toBe(0);

    host.close();
    guest.close();
  }, 120_000);

  it('forgets its opponent when it gives up the room', async () => {
    // `opponentPresent` is about the ROOM, not about the bot -- the same rule
    // `resetTableForNextPair` states one level up -- and only `opponent_left`
    // ever cleared it. After an ordinary whistle it therefore stayed TRUE for
    // the life of the process, so the supervisor's next `host` dispatch opened
    // an EMPTY table that still answered `hasOpponent()` true. `engaged()`
    // reads exactly that to decide whether the idle-lobby window applies, so
    // the bot was parked at a table nobody came to permanently, instead of
    // coming free for the next demand.
    //
    // No match is played here on purpose: the defect is about the seat, not
    // the result, and a duel would take a minute to say the same thing.
    relay = await startRelay('playbot-lifecycle');
    const r = relay;
    const host = await bootBot(r, 'seata');
    const guest = await bootBot(r, 'seatb');

    host.host({ winningScore: 15 });
    await until('a room', () => host.roomId !== null);
    guest.join(host.roomId!);
    await until('the host to see somebody opposite', () => host.hasOpponent());
    expect(guest.hasOpponent()).toBe(true);

    // Standing up is what clears it.
    host.leave();
    expect(host.hasOpponent()).toBe(false);

    // And a table this bot opens next has nobody at it, which is the state
    // the supervisor's idle-lobby window is judged against.
    host.host({ winningScore: 15 });
    await until('a fresh table', () => host.roomId !== null);
    expect(host.hasOpponent()).toBe(false);

    host.close();
    guest.close();
  }, 90_000);

  it('does NOT walk out of a lobby somebody is sitting in', async () => {
    // A bot that joins a human's table stops that table counting as
    // `openTables`, so the very NEXT population tick can select it for
    // deactivation -- and `standDown` treated an occupied lobby exactly like
    // an empty one and left. The human, who had not pressed Start yet, was
    // abandoned before their match began, repeatedly.
    //
    // The host is a HUMAN deliberately: a bot host readies and starts at once,
    // so the lobby window it would leave is a few milliseconds wide and the
    // case cannot be reproduced with two bots. A person deciding when to press
    // Start is the whole of it.
    relay = await startRelay('playbot-lifecycle');
    const r = relay;
    const human = await r.newDevice('LobbySitter');
    const phone = await r.openPhone(human);
    phone.send({
      type: 'create_room',
      playerId: human.id,
      config: { winningScore: 15, rules: {} },
      visibility: 'public',
    });
    const created = (await phone.await('room_created')) as { roomId: string };

    const bot = await bootBot(r, 'stayer');
    bot.join(created.roomId);
    await until('the bot to be seated', () => bot.hasOpponent());
    expect(bot.phase).toBe('lobby');

    // Start is never pressed. The bot is stood down anyway.
    bot.standDown();
    await sleep(500);
    expect(bot.roomId).toBe(created.roomId);
    expect(bot.phase).toBe('lobby');

    // ...while an EMPTY lobby is still given up at once, which is what the
    // clause has to leave working.
    phone.send({ type: 'leave_room' });
    await until('the bot to be alone', () => !bot.hasOpponent());
    bot.standDown();
    expect(bot.roomId).toBeNull();

    phone.close();
    bot.close();
  }, 90_000);

  it('leaves the QUEUE when it is stood down', async () => {
    // `queued` is an ENGAGED phase, so a driver left sitting in it is counted
    // active forever and the supervisor's reap -- `retiring && !engaged` --
    // can never close it. `standDown` handled idle, over and lobby and not
    // this one, so a bot chosen for deactivation stayed in matchmaking
    // indefinitely and could be seated into a match afterwards.
    //
    // There is no whistle to wait for here: a bot WAITING is not a bot
    // playing, so the request is granted at once.
    relay = await startRelay('playbot-lifecycle');
    const r = relay;
    const bot = await bootBot(r, 'queuer');

    bot.queue();
    await until('the bot to be queued', () => bot.phase === 'queued');

    bot.standDown();
    expect(bot.phase).toBe('idle');
    // And the relay agrees: it answers a cancel, which it would not for a
    // socket it had never queued.
    await sleep(500);
    expect(bot.phase).toBe('idle');

    bot.close();
  }, 60_000);

  it('goes back to idle when its socket dies under it', async () => {
    // A socket can die without anybody asking -- a relay restart, a reaped
    // room, a transient fault. With no `close` handler the timer kept running
    // and the phase stayed whatever it was, so `engaged()` went on counting a
    // driver whose every send was going nowhere, and the supervisor's
    // `if (!m.driver)` never rebuilt it: repeated disconnects drained the
    // effective population until the process restarted.
    relay = await startRelay('playbot-lifecycle');
    const r = relay;
    const bot = await bootBot(r, 'dropper');

    bot.host({ winningScore: 3 });
    await until('a table', () => bot.roomId !== null);
    expect(bot.isConnected()).toBe(true);

    // Killed from underneath, the way a relay restart would.
    bot.dropSocketForTest();
    // Waited on the PHASE, not on `isConnected()`: `terminate()` flips
    // readyState synchronously while the 'close' event is delivered a turn
    // later, so a wait on the socket would race the handler under test and
    // assert against a driver that has not heard yet (vacuity shape 13).
    await until('the driver to notice', () => bot.phase === 'idle');
    expect(bot.isConnected()).toBe(false);
    expect(bot.roomId).toBeNull();

    bot.close();
  }, 60_000);
});
