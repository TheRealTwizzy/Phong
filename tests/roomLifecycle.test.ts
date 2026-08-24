import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Relay, sleep, startRelay } from './helpers/relay';

// Rooms that outlive everybody in them, tested against the real relay.
//
// reapRooms is pure and covered in tests/room.test.ts, but the leak it exists
// for is not in the sweep — it is in how a seat is TAKEN. `create_room` and
// `join_room` both just overwrite the socket's currentRoomId/playerIndex, so
// a socket that takes a second seat leaves a PlayerSession behind in the first
// room. `vacateSeat` runs off a close event and only ever reaches the room the
// socket is in NOW, so the abandoned one is unreachable by every disconnect
// path there is: no player can rejoin it (the seat looks taken) and no handler
// will ever delete it. It sat in memory holding a 4-letter code out of
// circulation until the 30-minute idle clock happened to notice.
//
// That is a two-line rule about seat ownership and it needs a real process to
// see, so it lives here rather than beside the pure reaper.

let relay: Relay;
let base: string;

beforeAll(async () => {
  relay = await startRelay('room-lifecycle-test');
  base = relay.base;
}, 40000);

afterAll(async () => {
  await relay?.stop();
});

const roomStatus = async (code: string): Promise<number> =>
  (await fetch(`${base}/api/room/${code}`)).status;

const waitingMs = async (code: string): Promise<number | null> => {
  const res = await fetch(`${base}/api/room/${code}`);
  if (!res.ok) return null;
  return (await res.json()).waitingMs;
};

const activeRooms = async (): Promise<number> =>
  (await (await fetch(`${base}/api/health`)).json()).activeRooms;

describe('a socket that takes a second seat', () => {
  it('gives up the room it was already in', async () => {
    const host = await relay.newDevice('RoomLifeA');
    const phone = await relay.openPhone(host);

    phone.send({ type: 'create_room', playerId: host.id });
    const first = (await phone.await('room_created')).roomId;
    expect(await roomStatus(first)).toBe(200);

    phone.clear();
    phone.send({ type: 'create_room', playerId: host.id });
    const second = (await phone.await('room_created')).roomId;
    expect(second).not.toBe(first);

    // Without the vacate, `first` is still in the map with a seat holding this
    // very socket — and closing the socket below would only free `second`.
    await sleep(200);
    expect(await roomStatus(first)).toBe(404);
    expect(await roomStatus(second)).toBe(200);

    phone.close();
    await sleep(300);
    expect(await roomStatus(second)).toBe(404);
    expect(await activeRooms()).toBe(0);
  }, 30000);

  it('leaves nothing behind when it moves from its own room into somebody else’s', async () => {
    const a = await relay.newDevice('RoomLifeB');
    const b = await relay.newDevice('RoomLifeC');
    const pa = await relay.openPhone(a);
    const pb = await relay.openPhone(b);

    pb.send({ type: 'create_room', playerId: b.id });
    const theirs = (await pb.await('room_created')).roomId;

    pa.send({ type: 'create_room', playerId: a.id });
    const mine = (await pa.await('room_created')).roomId;

    pa.clear();
    pa.send({ type: 'join_room', roomId: theirs, playerId: a.id });
    await pa.await('room_joined');

    await sleep(200);
    expect(await roomStatus(mine)).toBe(404);
    expect(await roomStatus(theirs)).toBe(200);
    expect(await activeRooms()).toBe(1);

    pa.close();
    pb.close();
    await sleep(300);
    expect(await activeRooms()).toBe(0);
  }, 30000);

  it('keeps the seat it has when the join is refused', async () => {
    // Giving up the old seat is right when the new one is actually taken, and
    // wrong the instant the join can fail: vacating first meant a mistyped
    // code, an expired room or a full one cost the player the room they were
    // already in — and, mid-duel, charged them an abandon for a match they
    // had not left.
    const a = await relay.newDevice('RoomLifeD');
    const pa = await relay.openPhone(a);

    pa.send({ type: 'create_room', playerId: a.id });
    const mine = (await pa.await('room_created')).roomId;

    // A code that resolves to nothing.
    pa.clear();
    pa.send({ type: 'join_room', roomId: 'ZZZZ', playerId: a.id });
    expect((await pa.await('error')).message).toMatch(/not found/i);
    await sleep(200);
    expect(await roomStatus(mine)).toBe(200);

    // And one that is real but full.
    const b = await relay.newDevice('RoomLifeE');
    const c = await relay.newDevice('RoomLifeF');
    const pb = await relay.openPhone(b);
    const pc = await relay.openPhone(c);
    pb.send({ type: 'create_room', playerId: b.id });
    const full = (await pb.await('room_created')).roomId;
    pc.send({ type: 'join_room', roomId: full, playerId: c.id });
    await pc.await('room_joined');

    pa.clear();
    pa.send({ type: 'join_room', roomId: full, playerId: a.id });
    expect((await pa.await('error')).message).toMatch(/full/i);
    await sleep(200);
    expect(await roomStatus(mine)).toBe(200);

    // The seat is still genuinely theirs, not just a room still in the map:
    // closing the socket is what frees it.
    pa.close();
    await sleep(300);
    expect(await roomStatus(mine)).toBe(404);

    pb.close();
    pc.close();
    await sleep(300);
    expect(await activeRooms()).toBe(0);
  }, 30000);

  it('hands a room back to the solo clock when its guest leaves', async () => {
    // Through the real relay, because the clock is started and stopped by the
    // seat handlers rather than by the reaper (whose own rule is pinned in
    // tests/room.test.ts). It used to be a one-way flag set when a second
    // player arrived, so a room that had been a duel was exempt from the one
    // clock that can expire a busy one-player room — which made the leak
    // reachable by having somebody join and then leave.
    const a = await relay.newDevice('RoomLifeH');
    const b = await relay.newDevice('RoomLifeI');
    const pa = await relay.openPhone(a);
    const pb = await relay.openPhone(b);

    pa.send({ type: 'create_room', playerId: a.id });
    const code = (await pa.await('room_created')).roomId;
    // One player: the clock is running.
    expect(await waitingMs(code)).not.toBeNull();

    pb.send({ type: 'join_room', roomId: code, playerId: b.id });
    await pb.await('room_joined');
    await sleep(150);
    // Two players: stopped.
    expect(await waitingMs(code)).toBeNull();

    // The guest walks out. The host stays, and the room is one player again —
    // so the clock restarts rather than staying stopped forever.
    pb.close();
    await sleep(300);
    expect(await roomStatus(code)).toBe(200);
    expect(await waitingMs(code)).not.toBeNull();

    pa.close();
    await sleep(300);
    expect(await activeRooms()).toBe(0);
  }, 30000);

  it('refuses a join to the room it is already sitting in', async () => {
    // Not a move: the vacate would empty this very room and delete it, and
    // the seat would then be taken in an object no longer in the map — a room
    // reachable only by the sockets already holding it.
    const a = await relay.newDevice('RoomLifeG');
    const pa = await relay.openPhone(a);

    pa.send({ type: 'create_room', playerId: a.id });
    const mine = (await pa.await('room_created')).roomId;

    pa.clear();
    pa.send({ type: 'join_room', roomId: mine, playerId: a.id });
    expect((await pa.await('error')).message).toMatch(/already in this room/i);
    await sleep(200);
    expect(await roomStatus(mine)).toBe(200);
    expect(await activeRooms()).toBe(1);

    pa.close();
    await sleep(300);
    expect(await activeRooms()).toBe(0);
  }, 30000);
});
