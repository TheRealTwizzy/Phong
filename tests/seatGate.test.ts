import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Device, Relay, sleep, startRelay } from './helpers/relay';

// The two doors into a PLAYING seat that were not the two everybody checks.
//
// `create_room` judges the host and a public `join_room` judges the joiner.
// `swap_seat` is the third way into a chair and asked nothing — and watching
// is ungated by design, so the promotion was reachable in two messages by
// anybody. The other half of this file is the same bug class one level down:
// a seat is a chair, a run belongs to a player, and anything the previous
// occupant left behind must not be inherited by the next one.

let relay: Relay;

beforeAll(async () => {
  relay = await startRelay('seatgate');
}, 30_000);

afterAll(async () => {
  await relay?.stop();
});

/** Stand a device up on the visible ladder, so a bracket has something to judge. */
function seedLadder(device: Device, mu: number): void {
  const sql = new DatabaseSync(path.join(relay.dataDir, 'phong.db'));
  try {
    const changed = sql
      .prepare(
        `UPDATE players
            SET rankMu = ?, rankSigma = 1.0, rankedGames = 5, mmrMu = ?, mmrSigma = 1.0, level = 30
          WHERE id = ?`
      )
      .run(mu, mu, device.id).changes;
    // A silent no-op leaves an unplaced μ25 player and every assertion below
    // asking about a bracket nobody is outside.
    if (changed !== 1) throw new Error(`seedLadder matched ${changed} rows for ${device.username}`);
  } finally {
    sql.close();
  }
}

/** What a seat holds, straight out of the room's own broadcast. */
const seatsOf = (state: { seats: { seat: number; playerId: string | null }[] }) =>
  state.seats.map((s) => s.playerId);

describe('a bracket gates the third door too', () => {
  it('refuses a Legend standing up into a BEGINNER chair', async () => {
    // The exploit in two messages: `spectate_room` asks no bracket, because
    // watching the top of the ladder costs nobody a match — and then the free
    // playing seat is one `swap_seat` away. Brackets are what stop a Legend
    // farming beginners, and this was the way round them.
    const host = await relay.newDevice('GateHost1');
    const legend = await relay.newDevice('GateLegend1');
    seedLadder(legend, 35); // Legend: far above beginner's `tierMax: contender`

    const p1 = await relay.openPhone(host);
    p1.send({
      type: 'create_room',
      playerId: host.id,
      venueRoomId: 'beginner',
      visibility: 'public',
      config: { winningScore: 3, rules: {}, spectators: true },
    });
    const created = await p1.await('room_created');

    // Watching is ungated, and stays that way — this must still succeed.
    const w = await relay.openPhone(legend);
    w.send({ type: 'spectate_room', roomId: created.roomId, seat: 2 });
    const watching = await w.await('table_state');
    expect(watching.yourSeat).toBe(2); // wire seat 2 = the watching chair beside player 0

    // Standing up into the free chair is the thing that is refused.
    w.clear();
    w.send({ type: 'swap_seat', seat: 1 });
    const refused = await w.await('error');
    expect(refused.code).toBe('VENUE_LOCKED');
    // The verdict rides along so the client renders it with the same
    // `lockReason` the room list uses, rather than a second copy of the words.
    expect(refused.verdict).toMatchObject({ ok: false });

    // And they are still in the seat they were in, not stranded between two.
    p1.clear();
    w.send({ type: 'spectate_room', roomId: created.roomId, seat: 2 });
    await sleep(150);
    const after = await relay.openPhone(host);
    after.send({ type: 'join_room', roomId: created.roomId, playerId: host.id });
    await sleep(150);
    p1.close();
    w.close();
    after.close();
  }, 30_000);

  it('lets a player the bracket accepts stand up', async () => {
    // The gate has to be a gate and not a wall: without this the test above
    // passes just as well against a `swap_seat` that refuses everybody.
    const host = await relay.newDevice('GateHost2');
    const peer = await relay.newDevice('GatePeer2');

    const p1 = await relay.openPhone(host);
    p1.send({
      type: 'create_room',
      playerId: host.id,
      venueRoomId: 'beginner',
      visibility: 'public',
      config: { winningScore: 3, rules: {}, spectators: true },
    });
    const created = await p1.await('room_created');

    // A fresh account is unplaced, which sits below every floor and inside
    // beginner's ceiling — the ordinary case this room exists for.
    const w = await relay.openPhone(peer);
    w.send({ type: 'spectate_room', roomId: created.roomId, seat: 2 });
    await w.await('table_state');
    w.clear();
    w.send({ type: 'swap_seat', seat: 1 });
    const seated = await w.await('table_state');
    expect(seated.yourSeat).toBe(1);
    expect(w.last('error')).toBeUndefined();
    p1.close();
    w.close();
  }, 30_000);

  it('does not bracket a PRIVATE table, because an invitation is not a bracket', async () => {
    // The same line `join_room` draws. Two friends in different brackets are
    // exactly who the key flow exists for, so a watcher who got in on a key
    // is not judged on the way to a chair.
    const host = await relay.newDevice('GateHost3');
    const legend = await relay.newDevice('GateLegend3');
    seedLadder(legend, 35);

    const p1 = await relay.openPhone(host);
    p1.send({
      type: 'create_room',
      playerId: host.id,
      venueRoomId: 'beginner',
      visibility: 'private',
      config: { winningScore: 3, rules: {}, spectators: true },
    });
    const created = await p1.await('room_created');
    const state = await p1.await('table_state');
    const key = state.joinKey ?? created.roomId;

    const w = await relay.openPhone(legend);
    w.send({ type: 'spectate_room', roomId: key, seat: 2 });
    await w.await('table_state');
    w.clear();
    w.send({ type: 'swap_seat', seat: 1 });
    const seated = await w.await('table_state');
    expect(seated.yourSeat).toBe(1);
    expect(w.last('error')).toBeUndefined();
    p1.close();
    w.close();
  }, 30_000);

  it('does not re-judge a player already sitting at the table', async () => {
    // A 0↔1 swap grants no new access — they are already playing here. Asking
    // again would refuse somebody whose visible tier drifted mid-session out
    // of a seat they are sitting in, which is a worse failure than the one
    // the gate is for.
    const host = await relay.newDevice('GateHost4');
    seedLadder(host, 35);

    const p1 = await relay.openPhone(host);
    // Created before the seeding matters: the host passed the gate at create
    // time, which is the state this is about.
    p1.send({
      type: 'create_room',
      playerId: host.id,
      venueRoomId: 'casual',
      visibility: 'public',
      config: { winningScore: 3, rules: {}, spectators: true },
    });
    await p1.await('room_created');
    p1.clear();
    p1.send({ type: 'swap_seat', seat: 1 });
    const moved = await p1.await('table_state');
    expect(moved.yourSeat).toBe(1);
    expect(p1.last('error')).toBeUndefined();
    p1.close();
  }, 30_000);
});
