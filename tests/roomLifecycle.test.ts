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
});
