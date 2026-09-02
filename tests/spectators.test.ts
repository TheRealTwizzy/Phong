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

/**
 * Wait for a `table_state` that says what we are waiting for.
 *
 * `Phone.await` returns the LAST message of a type, and a seat change produces
 * several in a row — the join's, the swap's — so waiting on the type alone
 * reads whichever happened to be there first. Poll on the CONTENT instead.
 */
async function awaitState(
  phone: Phone,
  pred: (s: Extract<import('../src/types').WSServerMessage, { type: 'table_state' }>) => boolean,
  what: string
) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const hit = phone.all('table_state').filter(pred).at(-1);
    if (hit) return hit;
    await sleep(20);
  }
  throw new Error(`timed out waiting for a table_state where ${what}`);
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
    // `null`/absent are NOT junk: they mean "any free seat", which is what
    // the browser sends — a viewer cares which SIDE they watch, not which of
    // the two chairs they are in, and that is what swap_seat is for.
    const junk = [0, 1, 4, -1, 'two', 2.5, '2', true, {}];
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

  it('takes whichever seat is free when none is named, and refuses when neither is', async () => {
    const host = await relay.newDevice('AnySeatHost');
    const { p1, code } = await openTable(host);

    const first = await relay.openPhone(await relay.newDevice('AnySeatA'));
    first.send({ type: 'spectate_room', roomId: code } as never);
    expect((await first.await('table_state')).yourSeat).toBe(2);

    const second = await relay.openPhone(await relay.newDevice('AnySeatB'));
    second.send({ type: 'spectate_room', roomId: code } as never);
    expect((await second.await('table_state')).yourSeat).toBe(3);

    const third = await relay.openPhone(await relay.newDevice('AnySeatC'));
    third.send({ type: 'spectate_room', roomId: code } as never);
    expect((await third.await('error')).message).toMatch(/both seats/i);

    expect((await roomInfo(code)).spectatorCount).toBe(2);
    first.close();
    second.close();
    third.close();
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

describe('the fan-out', () => {
  // Every position here is ASYMMETRIC on purpose. A paddle at 0.5 looks
  // right whether or not somebody mirrored it, so a symmetric fixture would
  // pass against the likeliest bug in the whole feature.
  it('gives a watcher the raw court beside them and the mirrored one opposite', async () => {
    const { p1, p2, code } = await livePair(['FanHost', 'FanGuest']);
    const { phone } = await watch(code, 2, 'FanWatcher'); // beside seat 0
    await phone.await('spectator_sync');
    phone.clear();

    // Seat 0's own paddle: raw, because the watcher is drawing seat 0's court
    // in seat 0's coordinates. A `1 - x` here would put it at 0.83.
    p1.send({ type: 'paddle_move', x: 0.17 });
    expect((await phone.await('watched_paddle')).x).toBeCloseTo(0.17, 5);

    // Seat 1's paddle: pre-mirrored, byte-identical to seat 0's own copy.
    p2.send({ type: 'paddle_move', x: 0.17 });
    const mirrored = await phone.await('opponent_paddle');
    expect(mirrored.x).toBeCloseTo(0.83, 5);
    expect(mirrored).toEqual(await p1.await('opponent_paddle'));

    // The sonar feed, the same way round: raw for this side, sender-frame
    // (which the radar mirrors itself) for the far one.
    p1.send({ type: 'ball_pos', x: 0.22, y: 0.71 });
    expect(await phone.await('watched_ball')).toMatchObject({ x: 0.22, y: 0.71 });
    p2.send({ type: 'ball_pos', x: 0.22, y: 0.71 });
    expect(await phone.await('opponent_ball')).toEqual(await p1.await('opponent_ball'));

    phone.close();
    p1.close();
    p2.close();
  });

  it('tells a watcher the ball has left the half it is drawing', async () => {
    const { p1, p2, code } = await livePair(['LeaveHost', 'LeaveGuest']);
    const { phone } = await watch(code, 3, 'LeaveWatcher'); // beside seat 1
    await phone.await('spectator_sync');
    phone.clear();

    // Seat 1 puts the ball over: the watcher beside them loses it...
    p2.send({ type: 'ball_cross_net', ball: { x: 0.13, vx: 0.2, vy: -0.9, spin: 0.4, speedMultiplier: 1 } });
    await phone.await('watched_ball_left');
    // ...and it does NOT arrive on their own court as an incoming ball.
    expect(phone.all('ball_incoming')).toEqual([]);

    // Seat 0 puts one over: now it arrives, transformed into seat 1's frame,
    // byte-identical to seat 1's own copy.
    p1.send({ type: 'ball_cross_net', ball: { x: 0.13, vx: 0.2, vy: -0.9, spin: 0.4, speedMultiplier: 1 } });
    const incoming = await phone.await('ball_incoming');
    expect(incoming).toEqual(await p2.await('ball_incoming'));
    expect(incoming.ball.x).toBeCloseTo(0.87, 5);

    phone.close();
    p1.close();
    p2.close();
  });

  it('never sends a watcher another player\'s result', async () => {
    // match_recorded carries XP, missions and a rank direction that belong to
    // one seat. It is sent to named sockets, never broadcast, and this is the
    // assertion that keeps it that way.
    // 3 is the shortest match the rules allow, so this is three points.
    const { p1, p2, code, host } = await livePair(['ResultHost', 'ResultGuest'], 3);
    const { phone } = await watch(code, 2, 'ResultWatcher');
    await phone.await('spectator_sync');

    p1.send({ type: 'ball_cross_net', ball: { x: 0.4, vx: 0.1, vy: -0.4, spin: 0, speedMultiplier: 1 } });
    for (let i = 0; i < 3; i++) p1.send({ type: 'point_scored', scorer: 'p1' });
    await p1.await('match_recorded');
    await p2.await('match_recorded');

    // The score reached them — that is a fact about the match — and the
    // result did not.
    expect((await phone.await('score_update')).p1Score).toBe(3);
    expect(phone.all('match_recorded')).toEqual([]);
    // And the match is on the players' records, not the watcher's.
    expect((await historyOf(host)).length).toBe(1);

    phone.close();
    p1.close();
    p2.close();
  });
});

describe('swapping seats', () => {
  it('moves a watcher to the other side, and re-seeds what they are looking at', async () => {
    const { p1, p2, code } = await livePair(['SwapHostA', 'SwapGuestA']);
    p1.send({ type: 'ball_cross_net', ball: { x: 0.4, vx: 0.1, vy: -0.4, spin: 0, speedMultiplier: 1 } });
    p1.send({ type: 'point_scored', scorer: 'p1' });
    await p1.await('score_update');

    const { phone } = await watch(code, 2, 'SideSwapper');
    await phone.await('table_state');
    phone.clear();

    // 2 -> 3 is allowed mid-match: it touches no playing seat.
    phone.send({ type: 'swap_seat', seat: 3 } as never);
    await awaitState(phone, (x) => x.yourSeat === 3, 'this socket holds seat 3');
    // A different court is a different orientation, so the snapshot is
    // re-sent rather than left as it was.
    const sync = (await phone.await('spectator_sync')).snapshot;
    expect({ p1: sync.p1Score, p2: sync.p2Score }).toEqual({ p1: 1, p2: 0 });

    // And the fan-out follows: seat 1's paddle is now the raw one.
    phone.clear();
    p2.send({ type: 'paddle_move', x: 0.31 });
    expect((await phone.await('watched_paddle')).x).toBeCloseTo(0.31, 5);

    phone.close();
    p1.close();
    p2.close();
  });

  it('locks every seat that touches the court once a match is on', async () => {
    // Stricter than set_room_config's own guard, by exactly the countdown
    // window: startRatings is already sampled for this matchSeq, so a swap
    // would invalidate the pre-match pair both seats are rated against. And
    // "stand up, look at the hidden half, sit back down" is a two-second
    // cheat in a game whose whole premise is the blind half-court.
    const { p1, p2, code } = await livePair(['LockHost', 'LockGuest']);
    const { phone } = await watch(code, 2, 'LockWatcher');
    await phone.await('table_state');

    // A player may not stand up...
    p1.clear();
    p1.send({ type: 'swap_seat', seat: 3 } as never);
    expect((await p1.await('error')).message).toMatch(/locked/i);

    // ...and a watcher may not sit down.
    phone.clear();
    phone.send({ type: 'swap_seat', seat: 0 } as never);
    expect((await phone.await('error')).message).toMatch(/locked|taken/i);

    const info = await roomInfo(code);
    expect(info).toMatchObject({ playerCount: 2, spectatorCount: 1 });
    phone.close();
    p1.close();
    p2.close();
  });

  it('lets a player stand up before the match, and clears the run off the chair', async () => {
    // A run belongs to a player, not to a chair: startMatchStreaks opens
    // bestStreaks ON streaks, so a value left behind by a departed occupant
    // becomes the next one's opening PEAK — which is permanent, being what
    // the career best and the rally achievements are keyed on.
    const host = await relay.newDevice('StandHost');
    const guest = await relay.newDevice('StandGuest');
    const { p1, code } = await openTable(host);
    const p2 = await relay.openPhone(guest);
    p2.send({ type: 'join_room', roomId: code, playerId: guest.id });
    await p2.await('room_joined');

    // The guest stands up. The host is still playing, so the court is not
    // emptied, and no match has started so nothing is abandoned.
    p2.send({ type: 'swap_seat', seat: 2 } as never);
    const state = await awaitState(p2, (x) => x.yourSeat === 2, 'this socket holds seat 2');
    expect(state.seats[1].playerId).toBe(null);
    expect((await roomInfo(code))).toMatchObject({ playerCount: 1, spectatorCount: 1 });
    // Nobody's history moved: standing up is not leaving.
    expect(await historyOf(guest)).toEqual([]);
    expect(await historyOf(host)).toEqual([]);

    // And they can sit back down.
    p2.send({ type: 'swap_seat', seat: 1 } as never);
    await awaitState(p2, (x) => x.yourSeat === 1, 'this socket is back in seat 1');
    expect((await roomInfo(code))).toMatchObject({ playerCount: 2, spectatorCount: 0 });

    p1.close();
    p2.close();
  });

  it('refuses a swap that would leave nobody playing', async () => {
    // leave_room is the only way to empty a court, and it is judged as an
    // abandon. A swap must not be the free version of it.
    const host = await relay.newDevice('EmptyCourtHost');
    const { p1, code } = await openTable(host);
    p1.clear();
    p1.send({ type: 'swap_seat', seat: 2 } as never);
    expect((await p1.await('error')).message).toMatch(/playing/i);
    expect(await roomInfo(code)).toMatchObject({ playerCount: 1, spectatorCount: 0 });
    p1.close();
  });

  it('is a silent no-op on the seat already held, and refuses junk without taking seat 0', async () => {
    const host = await relay.newDevice('NoopHost');
    const guest = await relay.newDevice('NoopGuest');
    const { p1, code } = await openTable(host);
    const p2 = await relay.openPhone(guest);
    p2.send({ type: 'join_room', roomId: code, playerId: guest.id });
    await p2.await('room_joined');
    p2.send({ type: 'player_ready', ready: true });
    // The JOIN broadcasts a ready_state of its own, so wait for the one that
    // actually carries the guest's yes rather than for the type.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !p1.all('ready_state').some((r) => r.ready[1])) await sleep(20);
    expect(p1.all('ready_state').some((r) => r.ready[1])).toBe(true);
    p1.clear();
    p2.clear();

    // Already there: no broadcast, so nobody's readiness is cleared by a
    // repeated tap.
    p2.send({ type: 'swap_seat', seat: 1 } as never);
    await sleep(200);
    expect(p2.all('table_state')).toEqual([]);
    expect(p1.all('ready_state')).toEqual([]);

    for (const junk of [4, -1, 'one', null, undefined, 1.5, {}]) {
      p2.clear();
      p2.send({ type: 'swap_seat', seat: junk } as never);
      expect({ junk, msg: (await p2.await('error')).message }).toMatchObject({
        msg: expect.stringMatching(/seat/i),
      });
    }
    // Above all, the host still has seat 0 and the guest is still in seat 1.
    // Read from a socket that has just arrived, so what it describes is the
    // table as it stands now rather than as it was before the junk.
    const { phone: witness } = await watch(code, 2, 'NoopWitness');
    const seats = (await witness.await('table_state')).seats;
    expect(seats.map((x) => x.playerName)).toEqual([
      'NoopHost',
      'NoopGuest',
      'NoopWitness',
      null,
    ]);
    witness.close();

    p1.close();
    p2.close();
  });
});

describe('a watched table is a relayed table', () => {
  it('refuses WebRTC signaling while the seats are open', async () => {
    // The boundary, not the hint. A P2P match never reaches the relay at all
    // — paddles, balls and points all travel the DataChannel — so a watcher
    // at one would sit in front of a frozen court. The client declines to
    // offer a connection when seats are open; the relay is the ONLY signaling
    // path, so this is what a modified client cannot get past.
    const { p1, p2 } = await livePair(['RtcHost', 'RtcGuest']);
    p2.clear();
    p1.send({ type: 'rtc_signal', payload: { kind: 'offer', sdp: 'v=0' } } as never);
    await sleep(200);
    expect(p2.all('rtc_signal')).toEqual([]);
    p1.close();
    p2.close();
  });

  it('still relays signaling for a table with no seats open', async () => {
    // The refusal is about watching, not about duels: an ordinary invite-code
    // table is peer-to-peer exactly as it always was.
    const host = await relay.newDevice('RtcOkHost');
    const guest = await relay.newDevice('RtcOkGuest');
    const { p1, p2 } = await relay.seatDuel(host, guest);
    p2.clear();
    p1.send({ type: 'rtc_signal', payload: { kind: 'offer', sdp: 'v=0' } } as never);
    expect((await p2.await('rtc_signal')).fromIdx).toBe(0);
    p1.close();
    p2.close();
  });

  it('asks the peers off their link when the seats are opened, without claiming their score', async () => {
    // endP2P, not takeOverFromP2P: the relay has counted nothing here, and
    // setting `relayCounted` would make applyMatchSync discard the peers'
    // true streaks and peaks — which are maxima, so permanent — to guard
    // against a divergence that has not happened.
    const host = await relay.newDevice('OpenSeatsHost');
    const guest = await relay.newDevice('OpenSeatsGuest');
    const { p1, p2, roomId, matchSeq } = await relay.seatDuel(host, guest);
    p1.clear();
    p2.clear();

    p1.send({
      type: 'set_room_config',
      config: { winningScore: 3, rules: {}, spectators: true },
    } as never);
    await p1.await('p2p_fallback');
    await p2.await('p2p_fallback');

    // A snapshot from a peer still counts: nothing has been taken over.
    p2.send({
      type: 'match_sync',
      rev: 5,
      matchSeq,
      p1Score: 0,
      p2Score: 1,
      bestStreaks: [0, 7],
      streaks: [0, 7],
      earnedBests: [0, 7],
      servingPlayer: 0,
      crossingsThisPoint: 0,
    } as never);
    await sleep(200);
    const info = await fetch(`${base}/api/room/${roomId}`).then((r) => r.json());
    expect(info).toMatchObject({ exists: true, spectatorsEnabled: true });
    p1.close();
    p2.close();
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

describe('a seat that changes hands after the whistle', () => {
  it('lets a player stand up and a watcher take the chair they freed', async () => {
    // The premise behind a client-side guard, pinned here because it is the
    // relay's to keep: this sequence is PERMITTED, and it is the one sequence
    // that clears a watcher's `spectating` while their `winner` is still set.
    //
    // Every step passes a guard that is doing its job. `matchOver` is true, so
    // the seat lock (`matchSeq > 0 && !matchOver`) is open — correctly, since
    // the whole point of it is the countdown window and there is no match on.
    // `NEEDS_A_PLAYER` lets the first player stand up because the second is
    // still sitting. And freeing a seat this way does NOT run
    // `resetTableForNextPair` — only `vacateSeat` does — so `matchOver` stays
    // true and the next swap is legal too.
    //
    // What that leaves is a client holding a result overlay about a match it
    // only watched, at the moment it stops being a watcher. App.tsx's record
    // effect returns early for a spectator and must MARK its ref on the way
    // out, or the promotion files somebody else's match onto this account.
    // Nothing here can observe that — it is a POST from a browser — so the
    // behavioural half is `scripts/e2e-spectate.mjs`, which can only reach it
    // once a watcher has a way to take a seat without leaving the table.
    const { p1, p2, code } = await livePair(['HandoverHost', 'HandoverGuest']);
    const { phone: fan } = await watch(code, 2, 'HandoverFan');
    await fan.await('table_state');

    for (let i = 0; i < 3; i++) {
      p1.send({ type: 'point_scored', scorer: 'p1' } as never);
      await sleep(30);
    }
    expect(fan.last('score_update')?.p1Score).toBe(3);

    // The winner stands up to watch. Seat 0 is now free and `matchOver` still
    // true, because nothing here went through `vacateSeat`.
    p1.clear();
    p1.send({ type: 'swap_seat', seat: 3 } as never);
    const stood = await awaitState(p1, (s) => s.yourSeat === 3, 'the player is watching');
    expect(stood.yourSeat).toBe(3);
    expect(p1.last('error')).toBeUndefined();

    // And the watcher takes it.
    fan.clear();
    fan.send({ type: 'swap_seat', seat: 0 } as never);
    const seated = await awaitState(fan, (s) => s.yourSeat === 0, 'the watcher is playing');
    expect(seated.yourSeat).toBe(0);
    expect(fan.last('error')).toBeUndefined();

    p1.close();
    p2.close();
    fan.close();
  }, 30_000);
});
