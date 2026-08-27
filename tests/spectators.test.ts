import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Device, Phone, Relay, sleep, startRelay } from './helpers/relay';

// Watching a table, against the real relay.
//
// Two things live here that no pure test can reach. The first is that a
// spectator is refused every gameplay message by guards that were already
// there — `playerIndex() !== null` returns false for a watcher — and the
// point of asserting it is that nobody added a spectator branch to
// `match_sync`, which can decide a match and trigger recordRoomMatch. The
// second is `vacateSeat`'s early return: every clause of its abandon check
// (both seats filled, a ball in play, no result yet, a real device) is true
// of a watcher closing a tab mid-rally, so without that return the relay
// would write a real ranked LOSS to a player who did nothing.

let relay: Relay;
let base: string;

beforeAll(async () => {
  relay = await startRelay('spectators-test');
  base = relay.base;
}, 40000);

afterAll(async () => {
  await relay?.stop();
});

const roomInfo = async (code: string) => {
  const res = await fetch(`${base}/api/room/${code}`);
  return res.ok ? await res.json() : null;
};

const historyOf = async (device: Device) => {
  const res = await fetch(`${base}/api/matches/me`, { headers: { cookie: device.cookie } });
  return (await res.json()).matches as Array<{ result: string }>;
};

/** A table whose two watching seats are open, with the host already sitting. */
async function openTable(host: Device, winningScore = 3): Promise<{ p1: Phone; code: string }> {
  const p1 = await relay.openPhone(host);
  p1.send({
    type: 'create_room',
    playerId: host.id,
    config: { winningScore, rules: {}, spectators: true },
  } as never);
  const code = (await p1.await('room_created')).roomId;
  return { p1, code };
}

/** Host, guest and a match under way — the state a watcher arrives into. */
async function livePair(names: [string, string], winningScore = 3) {
  const host = await relay.newDevice(names[0]);
  const guest = await relay.newDevice(names[1]);
  const { p1, code } = await openTable(host, winningScore);
  const p2 = await relay.openPhone(guest);
  p2.send({ type: 'join_room', roomId: code, playerId: guest.id });
  await p2.await('room_joined');
  p2.send({ type: 'player_ready', ready: true });
  await p1.await('ready_state');
  p1.send({ type: 'start_match' });
  await p1.await('game_start');
  await p2.await('game_start');
  return { host, guest, p1, p2, code };
}

async function watch(code: string, seat: 2 | 3, name: string): Promise<{ phone: Phone; device: Device }> {
  const device = await relay.newDevice(name);
  const phone = await relay.openPhone(device);
  phone.send({ type: 'spectate_room', roomId: code, seat } as never);
  return { phone, device };
}

describe('taking a watching seat', () => {
  it('seats a watcher and tells them where the match already stands', async () => {
    const { p1, p2, code } = await livePair(['WatchHostA', 'WatchGuestA']);
    // A ball in play and a point on the board BEFORE anyone sits down: a
    // watcher arriving at 1-0 has missed game_start and every score_update,
    // and the relay is the only party that knows.
    p1.send({ type: 'ball_cross_net', ball: { x: 0.4, vx: 0.1, vy: -0.4, spin: 0, speedMultiplier: 1 } });
    p1.send({ type: 'point_scored', scorer: 'p1' });
    await p1.await('score_update');

    const { phone } = await watch(code, 2, 'WatcherA');
    const state = await phone.await('table_state');
    expect(state.yourSeat).toBe(2);
    expect(state.roomId).toBe(code);
    expect(state.spectatorsEnabled).toBe(true);
    expect(state.seats.map((s) => s.playerName)).toEqual([
      'WatchHostA',
      'WatchGuestA',
      'WatcherA',
      null,
    ]);

    const sync = (await phone.await('spectator_sync')).snapshot;
    expect(sync.p1Score).toBe(1);
    expect(sync.p2Score).toBe(0);
    expect(sync.inPlay).toBe(true);
    expect(sync.matchOver).toBe(false);
    expect(sync.config.winningScore).toBe(3);

    // And the players are told who sat down — never as `opponent_left`, which
    // would report a departure to somebody who lost nobody.
    const seen = await p2.await('table_state');
    expect(seen.yourSeat).toBe(1);
    expect(seen.seats[2].playerName).toBe('WatcherA');

    phone.close();
    p1.close();
    p2.close();
  });

  it('refuses a table that is not offering seats', async () => {
    // The default: a create_room from an old bundle, the invite flow or the
    // harness says nothing about watching, and gets no watching seats.
    const host = await relay.newDevice('NoWatchHost');
    const p1 = await relay.openPhone(host);
    p1.send({ type: 'create_room', playerId: host.id, config: { winningScore: 3, rules: {} } } as never);
    const code = (await p1.await('room_created')).roomId;

    const { phone } = await watch(code, 2, 'NoWatcher');
    expect((await phone.await('error')).message).toMatch(/no seats/i);
    expect((await roomInfo(code)).spectatorCount).toBe(0);
    phone.close();
    p1.close();
  });

  it('lets the venue overrule the host about being watched', async () => {
    // Drawn by ROOM, not per match: the queue's own room has no watching
    // seats, so a host asking for them there is simply not given them. That
    // is the whole spectator/ranked answer — a spectator sees the hidden half
    // live with sonar forced on, which is the sonar rule with a second person
    // attached, so the rooms where rating is on the line have no seats at all.
    const host = await relay.newDevice('VenueWatchHost');
    const p1 = await relay.openPhone(host);
    p1.send({
      type: 'create_room',
      playerId: host.id,
      venueRoomId: '_queue',
      config: { winningScore: 3, rules: {}, spectators: true },
    } as never);
    const code = (await p1.await('room_created')).roomId;
    expect((await p1.await('room_config')).config.spectators).toBe(false);
    expect((await roomInfo(code)).spectatorsEnabled).toBe(false);
    p1.close();
  });

  it('refuses a seat that is not a watching seat, without falling back to seat 0', async () => {
    // Strict enum membership, and deliberately NOT clampInt: that turns junk
    // into `lo`, which in a seat namespace is the HOST seat — so a malformed
    // request would read as "give me the host's chair".
    const host = await relay.newDevice('EnumHost');
    const { p1, code } = await openTable(host);
    const junk = [0, 1, 4, -1, 'two', null, undefined, 2.5, '2'];
    for (let i = 0; i < junk.length; i++) {
      const { phone } = await watch(code, junk[i] as never, `EnumWatch${i}`);
      expect({ junk: junk[i], msg: (await phone.await('error')).message }).toMatchObject({
        msg: expect.stringMatching(/seat/i),
      });
      phone.close();
    }
    const info = await roomInfo(code);
    // Above all: the host still has seat 0, and nobody is watching.
    expect(info).toMatchObject({ playerCount: 1, spectatorCount: 0 });
    expect((await p1.await('table_state')).seats[0].playerName).toBe('EnumHost');
    p1.close();
  });

  it('refuses a seat somebody is already in, and a second seat to one account', async () => {
    const { p1, p2, code, guest } = await livePair(['DupeHost', 'DupeGuest']);
    const { phone: first } = await watch(code, 2, 'DupeWatcher');
    await first.await('table_state');

    // Non-null, not non-live: a seat holding a dead socket is occupied until
    // its close handler clears it, and calling it free orphans a session.
    const { phone: second } = await watch(code, 2, 'DupeWatcherTwo');
    expect((await second.await('error')).message).toMatch(/taken/i);
    second.close();

    // One account, one seat at a table. Without this an account displaced
    // across two devices — a live state, not a hypothetical — could hold two
    // of the four seats: the guest watching their own match.
    const guestSecondTab = await relay.openPhone(guest);
    guestSecondTab.send({ type: 'spectate_room', roomId: code, seat: 3 } as never);
    expect((await guestSecondTab.await('error')).message).toMatch(/already have a seat/i);
    expect((await roomInfo(code)).spectatorCount).toBe(1);
    guestSecondTab.close();

    first.close();
    p1.close();
    p2.close();
  });
});

describe('what a watcher cannot do', () => {
  it('is refused every gameplay message by the guards that were already there', async () => {
    const { p1, p2, code, host, guest } = await livePair(['MuteHost', 'MuteGuest']);
    const { phone } = await watch(code, 3, 'MuteWatcher');
    await phone.await('spectator_sync');
    p1.clear();
    p2.clear();

    // match_sync matters most of all: it can decide a match outright and
    // trigger recordRoomMatch from a score the relay never saw.
    phone.send({
      type: 'match_sync',
      rev: 99,
      matchSeq: 1,
      p1Score: 9,
      p2Score: 0,
      bestStreaks: [50, 0],
      streaks: [50, 0],
      earnedBests: [50, 0],
      servingPlayer: 0,
      crossingsThisPoint: 0,
    } as never);
    phone.send({ type: 'point_scored', scorer: 'p1' } as never);
    phone.send({ type: 'start_match' } as never);
    phone.send({ type: 'set_room_config', config: { winningScore: 15, rules: {} } } as never);
    phone.send({ type: 'player_ready', ready: true } as never);
    phone.send({ type: 'ball_cross_net', ball: { x: 0.9, vx: 0, vy: -1, spin: 0, speedMultiplier: 1 } } as never);
    phone.send({ type: 'paddle_move', x: 0.9 } as never);
    await sleep(250);

    // Nothing reached the players, and nothing reached the room.
    expect(p1.all('score_update')).toEqual([]);
    expect(p1.all('game_start')).toEqual([]);
    expect(p1.all('ball_incoming')).toEqual([]);
    expect(p2.all('opponent_paddle')).toEqual([]);
    expect((await p1.await('room_config', 500).catch(() => null))).toBe(null);
    expect(await historyOf(host)).toEqual([]);
    expect(await historyOf(guest)).toEqual([]);

    phone.close();
    p1.close();
    p2.close();
  });

  it('records no match and no abandon when it leaves a live duel', async () => {
    // The sharpest hazard in the feature. Every clause of vacateSeat's
    // abandon check is true of a watcher closing a tab mid-rally.
    const { p1, p2, code, host, guest } = await livePair(['AbandonHost', 'AbandonGuest']);
    p1.send({ type: 'ball_cross_net', ball: { x: 0.4, vx: 0.1, vy: -0.4, spin: 0, speedMultiplier: 1 } });
    await p2.await('ball_incoming');

    const { phone, device } = await watch(code, 2, 'LeavingWatcher');
    await phone.await('spectator_sync');
    phone.close();
    await sleep(400);

    expect(await historyOf(host)).toEqual([]);
    expect(await historyOf(guest)).toEqual([]);
    expect(await historyOf(device)).toEqual([]);
    // The match is still going: the players lost nobody.
    const info = await roomInfo(code);
    expect(info).toMatchObject({ exists: true, playerCount: 2, spectatorCount: 0 });
    expect(p1.all('opponent_left')).toEqual([]);
    expect(p2.all('opponent_left')).toEqual([]);

    p1.close();
    p2.close();
  });

  it('does not stop the clock on a table with nobody to play against', async () => {
    // Clearing soloSince would exempt a one-player table from the only clock
    // that can expire a busy one — a host could park a table forever by
    // having a friend sit down, which is the pairedAt leak that field was
    // rewritten to close.
    const host = await relay.newDevice('SoloClockHost');
    const { p1, code } = await openTable(host);
    const before = (await roomInfo(code)).waitingMs;
    expect(before).not.toBe(null);

    const { phone } = await watch(code, 2, 'ClockWatcher');
    await phone.await('table_state');
    await sleep(120);

    const after = await roomInfo(code);
    expect(after.waitingMs).not.toBe(null);
    expect(after.waitingMs).toBeGreaterThanOrEqual(before);
    expect(after.spectatorCount).toBe(1);

    phone.close();
    p1.close();
  });
});

describe('a table that goes away', () => {
  it('closes its watchers when the last player leaves', async () => {
    const host = await relay.newDevice('LastOutHost');
    const { p1, code } = await openTable(host);
    const { phone } = await watch(code, 2, 'StrandedWatcher');
    await phone.await('table_state');

    const closed = new Promise<void>((resolve) => phone.ws.once('close', () => resolve()));
    p1.send({ type: 'leave_room' });
    await Promise.race([closed, sleep(3000)]);

    expect(phone.ws.readyState).toBe(3);
    expect(await roomInfo(code)).toBe(null);
    p1.close();
  });

  it('closes its watchers when the host shuts the seats', async () => {
    // "No spectators" is not a term that can be true while two people are
    // watching, so closing the seats closes them on whoever is in them.
    const host = await relay.newDevice('ShutSeatsHost');
    const { p1, code } = await openTable(host);
    const { phone } = await watch(code, 3, 'ShutOutWatcher');
    await phone.await('table_state');

    const closed = new Promise<void>((resolve) => phone.ws.once('close', () => resolve()));
    p1.send({ type: 'set_room_config', config: { winningScore: 3, rules: {}, spectators: false } } as never);
    await Promise.race([closed, sleep(3000)]);

    expect(phone.ws.readyState).toBe(3);
    expect((await roomInfo(code)).spectatorCount).toBe(0);
    p1.close();
  });
});
