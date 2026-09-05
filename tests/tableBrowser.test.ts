import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Relay, sleep, startRelay } from './helpers/relay';

// The table browser, and the brackets behind it, against the real relay.
//
// Two rules live here that a pure test cannot reach, because both are about
// what a real socket and a real HTTP read agree on:
//
//  - `visibility` is the ENTIRE boundary protecting today's invite-code
//    tables. The listing is an unauthenticated read of live room state, so a
//    private table appearing in it makes every private room's 4-letter code
//    harvestable by anyone who can call the endpoint.
//  - a bracket the MENU draws has to be a bracket the RELAY enforces. The
//    menu is the client; roomEntryVerdict is shared so the two cannot drift,
//    and this is where "shared" is proved rather than asserted.

let relay: Relay;
let base: string;

beforeAll(async () => {
  relay = await startRelay('table-browser-test');
  base = relay.base;
}, 40000);

afterAll(async () => {
  await relay?.stop();
});

const listTables = async (venue: string) => {
  const res = await fetch(`${base}/api/rooms/${venue}/tables`);
  return { status: res.status, body: res.ok ? await res.json() : null };
};

const roomInfo = async (code: string) => {
  const res = await fetch(`${base}/api/room/${code}`);
  return res.ok ? await res.json() : null;
};

describe('the table browser', () => {
  it('lists a public table in its own venue, and nowhere else', async () => {
    const host = await relay.newDevice('BrowseHostA');
    const phone = await relay.openPhone(host);
    phone.send({ type: 'create_room', playerId: host.id, venueRoomId: 'casual', visibility: 'public' } as never);
    const code = (await phone.await('room_created')).roomId;

    const casual = await listTables('casual');
    expect(casual.status).toBe(200);
    expect(casual.body.tables.map((t: { id: string }) => t.id)).toContain(code);
    // The row carries what the browser draws, so a stale poll is still honest
    // about whether a table can be sat at.
    const row = casual.body.tables.find((t: { id: string }) => t.id === code);
    expect(row).toMatchObject({ hostName: 'BrowseHostA', playerCount: 1, isFull: false, inPlay: false });

    // A table belongs to ONE venue: it must not leak into a sibling bracket.
    const beginner = await listTables('beginner');
    expect(beginner.body.tables.map((t: { id: string }) => t.id)).not.toContain(code);
    phone.close();
  });

  it('never lists a private table — the whole boundary in one assertion', async () => {
    const host = await relay.newDevice('BrowseHostB');
    const phone = await relay.openPhone(host);
    // Exactly today's invite-code table: no venue named, no visibility named.
    phone.send({ type: 'create_room', playerId: host.id } as never);
    const code = (await phone.await('room_created')).roomId;

    // It exists and is reachable BY CODE — an invitation still works...
    expect(await roomInfo(code)).toMatchObject({ exists: true, visibility: 'private' });
    // ...and it is in the default venue, so this is the listing it would leak
    // into if the filter were wrong.
    for (const venue of ['casual', 'beginner', 'intermediate', 'advanced', 'elite', 'pro']) {
      const listed = await listTables(venue);
      expect({ venue, leaked: (listed.body?.tables ?? []).some((t: { id: string }) => t.id === code) })
        .toEqual({ venue, leaked: false });
    }
    phone.close();
  });

  it('drops a table from the listing the moment its last player goes', async () => {
    const host = await relay.newDevice('BrowseHostC');
    const phone = await relay.openPhone(host);
    phone.send({ type: 'create_room', playerId: host.id, venueRoomId: 'casual', visibility: 'public' } as never);
    const code = (await phone.await('room_created')).roomId;
    expect((await listTables('casual')).body.tables.map((t: { id: string }) => t.id)).toContain(code);

    phone.send({ type: 'leave_room' });
    await sleep(200);
    // "Empty tables are never listed" has to hold INSIDE the 15s window before
    // the reaper sweeps, which is why the listing filters on a live player of
    // its own rather than trusting the sweep to have run.
    expect((await listTables('casual')).body.tables.map((t: { id: string }) => t.id)).not.toContain(code);
    phone.close();
  });

  it('names everybody seated, not just whoever opened the table', async () => {
    // A table outlives its host (CLAUDE.md §1), so seat 0 empties and seat 1
    // stays -- and `hostId` is `players[0]` alone, so that table lists with a
    // NULL host while a person is sitting at it. Anything reading the row to
    // ask "is a human waiting here" therefore could not see them: the play-bot
    // population's own table search reads exactly this row, and a bot
    // dispatched to serve that person walked past them to a bot's table.
    const host = await relay.newDevice('BrowseHostE');
    const guest = await relay.newDevice('BrowseGuestE');
    const hp = await relay.openPhone(host);
    hp.send({ type: 'create_room', playerId: host.id, venueRoomId: 'casual', visibility: 'public' } as never);
    const code = (await hp.await('room_created')).roomId;
    const gp = await relay.openPhone(guest);
    gp.send({ type: 'join_room', roomId: code, playerId: guest.id } as never);
    await gp.await('room_joined');

    const both = (await listTables('casual')).body.tables.find((t: { id: string }) => t.id === code);
    expect(both.seatedIds).toEqual([host.id, guest.id]);

    // No match has started, so this costs nobody an abandon -- it is just the
    // host going back to the menu.
    hp.send({ type: 'leave_room' });
    await sleep(200);

    const row = (await listTables('casual')).body.tables.find((t: { id: string }) => t.id === code);
    // Still listed: it has a live player. And the seat-0 field cannot say who.
    expect(row).toBeTruthy();
    expect(row.hostId).toBeNull();
    expect(row.seatedIds).toEqual([guest.id]);
    hp.close();
    gp.close();
  });

  it('refuses to list a room nobody may browse', async () => {
    // The queue's room is excluded as DATA (listable: false), not by a special
    // case in the route — so asking for it is a 404, not an empty list that
    // would look like "no tables right now".
    expect((await listTables('_queue')).status).toBe(404);
  });
});

describe('the relay enforces the bracket the menu draws', () => {
  it('refuses to create a table in a room the player is too weak for', async () => {
    // A fresh device is unplaced and level 1: below every floor.
    const weak = await relay.newDevice('BracketWeak');
    const phone = await relay.openPhone(weak);
    phone.send({ type: 'create_room', playerId: weak.id, venueRoomId: 'pro', visibility: 'public' } as never);
    const err = await phone.await('error');
    expect(err.message).toMatch(/level/i);
    // And nothing was created — a refusal must not leave a table behind.
    expect((await listTables('pro')).body.tables).toEqual([]);
    phone.close();
  });

  it('lets the same player into the ungated rooms', async () => {
    const weak = await relay.newDevice('BracketOk');
    const phone = await relay.openPhone(weak);
    phone.send({ type: 'create_room', playerId: weak.id, venueRoomId: 'casual', visibility: 'public' } as never);
    expect((await phone.await('room_created')).roomId).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);
    phone.close();
  });

  it('keeps the seat a player already holds when a create is refused', async () => {
    // Nothing that can REFUSE may run after the old seat is given up — the
    // same rule join_room already holds to. A refused create must not cost a
    // player the room they were in, still less charge them an abandon.
    const dev = await relay.newDevice('BracketKeep');
    const phone = await relay.openPhone(dev);
    phone.send({ type: 'create_room', playerId: dev.id, venueRoomId: 'casual', visibility: 'public' } as never);
    const first = (await phone.await('room_created')).roomId;
    phone.clear();

    phone.send({ type: 'create_room', playerId: dev.id, venueRoomId: 'elite', visibility: 'public' } as never);
    await phone.await('error');
    await sleep(150);
    expect(await roomInfo(first)).toMatchObject({ exists: true, playerCount: 1 });
    phone.close();
  });

  it('does not bracket a PRIVATE table: an invitation is an invitation', async () => {
    // Two friends in different brackets are exactly who the code flow exists
    // for, and the invite suite's guest is a brand-new level-1 player. The
    // host's own create is still judged; the guest's join is not.
    const host = await relay.newDevice('InviteHost');
    const guest = await relay.newDevice('InviteGuest');
    const hp = await relay.openPhone(host);
    hp.send({ type: 'create_room', playerId: host.id } as never);
    const code = (await hp.await('room_created')).roomId;

    const gp = await relay.openPhone(guest);
    gp.send({ type: 'join_room', roomId: code, playerId: guest.id });
    const joined = await gp.await('room_joined');
    expect(joined.roomId).toBe(code);
    hp.close();
    gp.close();
  });
});
