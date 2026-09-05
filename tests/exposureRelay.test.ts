import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { Phone, startRelay, type Device, type Relay } from './helpers/relay';

// The RELAY half of the exposure store: who the room says the opponent was,
// which band it says they were in, and when it says the match was decided.
//
// Everything here runs against a real server on a real port with a real
// database, because every one of these values is only trustworthy BECAUSE it
// comes from a live room — asserted at the db layer they would all be things
// the test itself supplied.

let relay: Relay;
let dbFile: string;

beforeAll(async () => {
  relay = await startRelay('exposure-relay');
  dbFile = path.join(relay.dataDir, 'phong.db');
}, 60_000);

afterAll(async () => {
  await relay?.stop();
});

const newDevice = (name: string) => relay.newDevice(name);

/** Read straight from the server's own database file. WAL, so this is safe. */
const query = <T>(sql: string, ...args: unknown[]): T[] => {
  const raw = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return raw.prepare(sql).all(...(args as never[])) as unknown as T[];
  } finally {
    raw.close();
  }
};

const write = (sql: string, ...args: unknown[]): void => {
  const raw = new DatabaseSync(dbFile);
  try {
    raw.prepare(sql).run(...(args as never[]));
  } finally {
    raw.close();
  }
};

interface ExposureRow {
  playerId: string;
  oppId: string;
  matchKey: string;
  at: string;
  oppIsBot: number;
  oppBand: string;
}

const exposureFor = (id: string): ExposureRow[] =>
  query<ExposureRow>(
    'SELECT playerId, oppId, matchKey, at, oppIsBot, oppBand FROM competitive_exposure WHERE playerId = ? ORDER BY rowid',
    id
  );

/** Put a PLACED player on a chosen rating, so their tier is known and stable. */
const placeAt = (id: string, mu: number) =>
  write(
    'UPDATE players SET rankMu = ?, rankSigma = 4.0, rankedGames = 10, mmrMu = ?, mmrSigma = 4.0 WHERE id = ?',
    mu,
    mu,
    id
  );

/** Play a seated duel out to `winningScore` for p1. */
const finish = async (duel: Awaited<ReturnType<Relay['seatDuel']>>, score: number) => {
  for (let i = 1; i <= score; i += 1) {
    duel.p2.send({ type: 'point_scored', scorer: 'p1' });
    await duel.p2.awaitCount('score_update', i);
  }
  await duel.p1.await('match_recorded');
  await duel.p2.await('match_recorded');
};

describe('the room supplies the pair', () => {
  it('writes both seats one row each, on ONE anchor, keyed on the trusted ids', async () => {
    const host = await newDevice('RelayHost');
    const guest = await newDevice('RelayGuest');
    const duel = await relay.seatDuel(host, guest, 3);
    await finish(duel, 3);

    const mine = exposureFor(host.id);
    const theirs = exposureFor(guest.id);
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(1);
    // Mirrored: each seat's row names the other's account.
    expect(mine[0].oppId).toBe(guest.id);
    expect(theirs[0].oppId).toBe(host.id);
    // ONE anchor. Both seats read the same rolling window from it, so neither
    // can be at a different point on the same ladder — and a per-seat
    // `new Date()` would differ by the milliseconds the two records take.
    expect(mine[0].at).toBe(theirs[0].at);
    // One match, one key, one row apiece.
    expect(mine[0].matchKey).toBe(theirs[0].matchKey);
    duel.p1.close();
    duel.p2.close();
  }, 30_000);

  it('writes a row for a duel the CLIENT\u2019s own POST recorded first', async () => {
    // The relay is not the only path. A duel legitimately arrives up to three
    // times and whichever lands FIRST is the one that pays; the others are
    // answered by the ledger. For a relayed duel the relay always wins, since
    // it decides inside `point_scored` while this POST needs a round trip \u2014
    // but a P2P duel has no such ordering, and CLAUDE.md \u00a75 documents the
    // winner's own report legitimately outrunning the deciding `match_sync`.
    //
    // On that path `server.ts` supplied the opponent's RATINGS and never its
    // IDENTITY, so `pairing` was null: no exposure row, no saturation
    // modifier, full unsaturated weight. A pair replaying P2P duels therefore
    // never accumulated a pair count and never reached the human pair band at
    // all \u2014 the anti-farming safeguard simply absent for that transport.
    //
    // The fixture is that race, at the wire: a real seated duel the relay has
    // NOT decided (0-0, so the cross-check stands aside exactly as it does
    // when the POST is ahead), recorded by the client alone.
    const host = await newDevice('RaceHost');
    const guest = await newDevice('RaceGuest');
    placeAt(guest.id, 31.5);
    const duel = await relay.seatDuel(host, guest, 3);

    const body = {
      playerId: host.id,
      playerScore: 3,
      opponentScore: 1,
      isWinner: true,
      mode: 'multiplayer',
      maxRally: 4,
      bestStreak: 4,
      endStreak: 4,
      earnedStreak: 4,
      aces: 0,
      durationMs: 30_000,
      roomId: duel.roomId,
      matchSeq: duel.matchSeq,
    };
    const res = await fetch(`${relay.base}/api/match/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: host.cookie },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    expect(res.alreadyRecorded).toBeFalsy();

    const mine = exposureFor(host.id);
    expect(mine).toHaveLength(1);
    // From the ROOM's seat, never from the payload \u2014 which named no
    // opponent at all here, so a row keyed on the payload could not exist.
    expect(mine[0].oppId).toBe(guest.id);
    // And the START-of-match band off the room's own cache, not re-derived
    // after both ratings have moved.
    expect(mine[0].oppBand).toBe('grandmaster');
    expect(mine[0].oppIsBot).toBe(0);

    duel.p1.close();
    duel.p2.close();
  }, 30_000);

  it('takes the opponent from the SEAT, never from the id the client sent', async () => {
    // The trust boundary, and the fixture had to be rebuilt to be about it.
    // Written with two cookie-holding devices sending forged playerIds it
    // proved nothing: `currentPlayerId = cookieDeviceId || msg.playerId`, so
    // the relay had already discarded the forgery upstream of anything the
    // exposure store does — the assertion passed for a reason other than the
    // one it named.
    //
    // The two values can only DIFFER for a cookieless socket, and that is the
    // fixture: a real host against an opponent with no account. Keyed on the
    // seat's `playerId`, the host's row would be filed against the synthetic
    // id that socket sent, which a farming client changes every match. Keyed
    // on the verified `deviceId` — which is null here — no row forms at all,
    // because there is no account to key a pair on.
    const host = await newDevice('AnonHost');
    const p1 = await relay.openPhone(host);
    const anon = new WebSocket(relay.wsUrl);
    await new Promise<void>((resolve, reject) => {
      anon.once('open', () => resolve());
      anon.once('error', reject);
    });
    const anonPhone = new Phone(anon);

    p1.send({ type: 'create_room', playerId: host.id, config: { winningScore: 3, rules: {} } });
    const created = (await p1.await('room_created')) as { roomId: string };
    anonPhone.send({ type: 'join_room', roomId: created.roomId, playerId: 'dev_forged_guest' });
    await anonPhone.await('room_joined');
    anonPhone.send({ type: 'player_ready', ready: true });
    await p1.await('ready_state');
    p1.send({ type: 'start_match' });
    await p1.await('game_start');
    await anonPhone.await('game_start');
    for (let i = 1; i <= 3; i += 1) {
      anonPhone.send({ type: 'point_scored', scorer: 'p1' });
      await anonPhone.awaitCount('score_update', i);
    }
    await p1.await('match_recorded');

    // The host's match WAS recorded — an accountless opponent does not stop
    // that — and it carries no exposure row, because there is no pair.
    expect(exposureFor(host.id)).toHaveLength(0);
    expect(exposureFor('dev_forged_guest')).toHaveLength(0);
    p1.close();
    anon.close();
  }, 30_000);
});

describe('the band is captured at match START', () => {
  it('records the tier the opponent held before the match moved it', async () => {
    // The discriminating fixture, and it needs the opponent to CROSS a tier
    // boundary during the match: 24.9 is vanguard, and the win carries them
    // over the ace floor of 25. Derived at record time the guest's row would
    // read `ace` — a band the host was never in when they played.
    //
    // It is also why the relay writes seat 0 first and this still holds: the
    // sample is taken once, when the match begins, and cached on the room.
    const host = await newDevice('BandHost');
    const guest = await newDevice('BandGuest');
    placeAt(host.id, 24.9);
    placeAt(guest.id, 24.9);

    const duel = await relay.seatDuel(host, guest, 3);
    await finish(duel, 3);

    const after = query<{ rankMu: number }>('SELECT rankMu FROM players WHERE id = ?', host.id);
    // The host won, so their rating really did cross the boundary.
    expect(after[0].rankMu).toBeGreaterThan(25);

    // The GUEST's row describes the host as they were at the whistle's start.
    expect(exposureFor(guest.id)[0].oppBand).toBe('vanguard');
    duel.p1.close();
    duel.p2.close();
  }, 30_000);

  it('re-samples on a rematch, so the second match reads the new band', async () => {
    // `duelStartRatings` is keyed on matchSeq and re-sampled when it changes,
    // which is what stops a room's cache going stale across matches. Without
    // it the second match would be rated and banded against the pair as they
    // stood before the first.
    const host = await newDevice('RematchHost');
    const guest = await newDevice('RematchGuest');
    placeAt(host.id, 24.9);
    placeAt(guest.id, 20);

    const duel = await relay.seatDuel(host, guest, 3);
    await finish(duel, 3);
    expect(exposureFor(guest.id)[0].oppBand).toBe('vanguard');

    // Both vote, which is what restarts the match at a new matchSeq.
    duel.p1.send({ type: 'rematch_request' });
    duel.p2.send({ type: 'rematch_request' });
    await duel.p1.awaitCount('game_start', 2);
    await duel.p2.awaitCount('game_start', 2);
    for (let i = 1; i <= 3; i += 1) {
      duel.p2.send({ type: 'point_scored', scorer: 'p1' });
      await duel.p2.awaitCount('score_update', 3 + i);
    }
    await duel.p1.awaitCount('match_recorded', 2);
    await duel.p2.awaitCount('match_recorded', 2);

    const rows = exposureFor(guest.id);
    expect(rows).toHaveLength(2);
    // The host crossed into ace winning the first match, and the second
    // match's row says so — a stale cache would repeat `vanguard`.
    expect(rows[1].oppBand).toBe('ace');
    expect(rows[1].matchKey).not.toBe(rows[0].matchKey);
    duel.p1.close();
    duel.p2.close();
  }, 30_000);
});
