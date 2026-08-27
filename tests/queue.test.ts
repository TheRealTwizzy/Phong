import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Phone, Relay, sleep, startRelay } from './helpers/relay';
import { DEFAULT_MATCH_RULES, RANKED_AUTO_SERVE_SECONDS } from '../src/matchRules';

// The ranked queue, end to end on a real relay.
//
// The pure rules live in tests/matchmaking.test.ts. What only a real server
// can answer is the seating: two sockets ask for a game and end up on one
// court, with no lobby and no ready tap between them — and on terms neither of
// them can change, which is the whole reason skipping that tap is sound.

let relay: Relay;
let base: string;

beforeAll(async () => {
  relay = await startRelay('queue-test');
  base = relay.base;
}, 40000);

afterAll(async () => {
  await relay?.stop();
});

const roomInfo = async (code: string) => {
  const res = await fetch(`${base}/api/room/${code}`);
  return res.ok ? await res.json() : null;
};

async function queued(name: string): Promise<Phone> {
  const device = await relay.newDevice(name);
  const phone = await relay.openPhone(device);
  phone.send({ type: 'queue_join' } as never);
  return phone;
}

describe('joining the queue', () => {
  it('seats two even players and starts the match, with no lobby in between', async () => {
    const a = await queued('QueueA');
    expect((await a.await('queue_state')).status).toBe('searching');
    // Nobody to pair with yet: a lone queuer is not seated, however long.
    await sleep(300);
    expect(a.last('game_start')).toBeUndefined();

    const b = await queued('QueueB');

    // Both are told a match exists, and told who by.
    const foundA = await a.awaitCount('queue_state', 2);
    expect(foundA.at(-1)).toMatchObject({ status: 'found' });
    expect(foundA.at(-1)!.opponent?.username).toBe('QueueB');
    expect((await b.await('queue_state')).opponent?.username).toBe('QueueA');

    // And seated in the ordinary shapes, so no client handler had to learn
    // anything new: one of them is seat 0, the other seat 1.
    const created = await a.await('room_created');
    const joined = await b.await('room_joined');
    expect(created.roomId).toBe(joined.roomId);
    expect(created.playerIndex).toBe(0);
    expect(joined.playerIndex).toBe(1);

    // Neither of them readied and neither of them started it.
    const startA = await a.await('game_start');
    const startB = await b.await('game_start');
    expect(startA.matchSeq).toBe(1);
    expect(startB.matchSeq).toBe(1);

    const info = await roomInfo(created.roomId);
    expect(info).toMatchObject({ exists: true, playerCount: 2, spectatorCount: 0 });
    // Never watched, and never listed: a queue table is a pairing, not a place.
    expect(info.spectatorsEnabled).toBe(false);
    expect(info.visibility).toBe('private');
    const listing = await fetch(`${base}/api/rooms/${info.venueRoomId}/tables`);
    expect(listing.status).toBe(404);

    a.close();
    b.close();
  });

  it('plays one fixed, disclosed config that nobody can edit', async () => {
    // The premise behind skipping the handshake: the guest-ready step exists
    // because a room's terms are the host's to change, and "a yes to old rules
    // is not a yes to new ones". A queue table has no host and no editable
    // terms, so queueing IS the yes — and this is what keeps that true by
    // construction rather than by everyone remembering it.
    const a = await queued('QueueCfgA');
    const b = await queued('QueueCfgB');
    const start = await a.await('game_start');
    expect(start.config).toMatchObject({
      winningScore: 5,
      spectators: false,
      rules: { ...DEFAULT_MATCH_RULES, autoServeSeconds: RANKED_AUTO_SERVE_SECONDS },
    });

    a.clear();
    b.clear();
    a.send({ type: 'set_room_config', config: { winningScore: 15, rules: {} } } as never);
    // Refused, and answered with the terms as they stand rather than silently.
    expect((await a.await('room_config')).config.winningScore).toBe(5);
    await sleep(200);
    expect(b.all('room_config')).toEqual([]);

    a.close();
    b.close();
  });
});

describe('leaving the queue', () => {
  it('cancels on request, and stops being pairable', async () => {
    const a = await queued('QueueCancelA');
    await a.await('queue_state');
    a.clear();
    a.send({ type: 'queue_cancel' } as never);
    expect((await a.await('queue_state')).status).toBe('cancelled');

    const b = await queued('QueueCancelB');
    await sleep(400);
    expect(a.all('game_start')).toEqual([]);
    expect(b.all('game_start')).toEqual([]);

    a.close();
    b.close();
  });

  it('gives up the queue place when a seat is taken, and the seat when queueing', async () => {
    // The two are one commitment. Without this the relay could seat somebody
    // who is already mid-duel, and the abandon would be charged to them for a
    // match they never asked to leave.
    const host = await relay.newDevice('QueueSeatA');
    const a = await relay.openPhone(host);
    a.send({ type: 'queue_join' } as never);
    await a.await('queue_state');
    a.send({ type: 'create_room', playerId: host.id } as never);
    await a.await('room_created');

    const b = await queued('QueueSeatB');
    await sleep(400);
    // The table-holder was not dragged into a queue match.
    expect(a.all('game_start')).toEqual([]);
    expect(b.all('game_start')).toEqual([]);

    // And the other way: holding a seat refuses a queue place outright.
    a.clear();
    a.send({ type: 'queue_join' } as never);
    expect((await a.await('error')).message).toMatch(/leave your table/i);

    a.close();
    b.close();
  });

  it('drops a socket that goes away, so nobody is paired with a ghost', async () => {
    const a = await queued('QueueGhostA');
    await a.await('queue_state');
    a.close();
    await sleep(200);

    const b = await queued('QueueGhostB');
    await sleep(500);
    expect(b.all('game_start')).toEqual([]);
    expect(b.all('room_joined')).toEqual([]);
    b.close();
  });

  it('refuses a profile with no username, the same gate a seat uses', async () => {
    const device = await relay.newUnclaimedDevice();
    const phone = await relay.openPhone(device);
    phone.send({ type: 'queue_join' } as never);
    expect((await phone.await('error')).message).toMatch(/username/i);
    phone.close();
  });

  it('does not let a rejoin reset the wait it has already banked', async () => {
    // The band widens with the wait, so a client that could restart its own
    // clock could hold out for a softer opponent — or, rejoining, hand itself
    // a wider band than it had earned.
    const a = await queued('QueueRejoinA');
    await a.await('queue_state');
    await sleep(150);
    a.send({ type: 'queue_join', rttMs: 40 } as never);
    await sleep(150);
    const b = await queued('QueueRejoinB');
    // Still pairs — two fresh profiles are an even game either way. What is
    // being pinned is that the rejoin was absorbed rather than duplicated.
    await a.await('game_start');
    const info = await roomInfo((await a.await('room_created')).roomId);
    expect(info.playerCount).toBe(2);
    a.close();
    b.close();
  });
});
