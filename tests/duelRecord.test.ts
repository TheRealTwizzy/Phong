import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findMission } from '../src/game/missions';
import { Device, Phone as PhoneSocket, Relay, sleep, startRelay } from './helpers/relay';

// A duel end-to-end through the REAL relay and the REAL record route, because
// that seam is where duel results went missing and no unit test could see it:
//
//  - a P2P duel scores over the DataChannel, so the relay saw a room that was
//    still 0-0 — and /api/match/record, cross-checking against room state,
//    overwrote the winner's result with that blank score and filed them a
//    LOSS. "Win a match" could not be completed by winning a P2P duel.
//  - a result was recorded only by the phone that POSTed it, so a phone that
//    died on the final point left the match on neither profile.
//  - a room is reused by every rematch and reset to 0-0, so a slow or replayed
//    POST for match 1 was cross-checked against match 2's blank score.
//
// The server, the cookie jars, the Phone socket wrapper and the lobby
// handshake all live in tests/helpers/relay.ts now — a third suite needed
// them. What is left here is this suite's own subject.

let relay: Relay;
let base: string;

beforeAll(async () => {
  relay = await startRelay('duel-test');
  base = relay.base;
}, 40000);

afterAll(async () => {
  await relay?.stop();
});

// Bound to this suite's relay so the cases below read exactly as they did
// when the harness was local to this file.
const newDevice = (username: string): Promise<Device> => relay.newDevice(username);
const newUnclaimedDevice = (): Promise<Device> => relay.newUnclaimedDevice();
const seatDuel = (host: Device, guest: Device, winningScore = 3) =>
  relay.seatDuel(host, guest, winningScore);
const Phone = { open: (device: Device): Promise<PhoneSocket> => relay.openPhone(device) };

const getProfile = async (device: Device) =>
  (await fetch(`${base}/api/profile/me`, { headers: { cookie: device.cookie } })).json();

const getMissions = async (device: Device) =>
  (await fetch(`${base}/api/missions`, { headers: { cookie: device.cookie } })).json();

/**
 * A device dealt a mission that a duel win actually satisfies.
 *
 * Missions are a hand dealt from (playerId, dayKey), so which ones a player
 * holds cannot be chosen — and half the pool's win missions are restricted to
 * a solo difficulty, which a duel is right not to advance. Minting devices
 * until one holds an unrestricted win mission keeps this testing the recording
 * path rather than the luck of the deal.
 */
async function newDeviceHoldingAWinMission(
  prefix: string
): Promise<{ device: Device; missionId: string }> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const device = await newDevice(`${prefix}${attempt}`);
    const hand = await getMissions(device);
    const wanted = hand.missions.find((m: any) => {
      const def = findMission(m.id);
      return def?.type === 'matches_won' && !def.difficulty && (!def.mode || def.mode === 'multiplayer');
    });
    if (wanted) return { device, missionId: wanted.id };
  }
  throw new Error('no device was dealt an unrestricted win mission');
}


describe('taking a seat in a room', () => {
  it('refuses a player who has not chosen a username yet', async () => {
    // The relay stamps a seat's display name at join time and never revisits
    // it, so a player seated before onboarding is shown to their opponent as
    // Paddle-XXXX for the life of the room. The app gates everything else
    // behind onboarding; a seat was the one thing still reachable without it.
    const host = await newDevice('SeatHost');
    const { p1, roomId } = await seatDuel(host, await newDevice('SeatGuest'), 3);

    const stranger = await newUnclaimedDevice();
    expect(stranger.username.startsWith('Paddle-')).toBe(true);
    const p3 = await Phone.open(stranger);

    p3.send({ type: 'join_room', roomId, playerId: stranger.id });
    const refusedJoin = await p3.await('error');
    expect(refusedJoin.message).toMatch(/username/i);
    expect(p3.last('room_joined')).toBeUndefined();

    p3.clear();
    p3.send({ type: 'create_room', playerId: stranger.id, config: { winningScore: 3, rules: {} } });
    const refusedCreate = await p3.await('error');
    expect(refusedCreate.message).toMatch(/username/i);
    expect(p3.last('room_created')).toBeUndefined();

    p3.close();
    p1.close();
  });

  it('seats a player once they have a username, under that name', async () => {
    const host = await newDevice('NamedHost');
    const guest = await newDevice('NamedGuest');
    const { p1, p2 } = await seatDuel(host, guest, 3);
    // The host is told who joined, by the name they actually chose.
    expect((await p1.await('opponent_joined')).opponentName).toBe('NamedGuest');
    expect((await p2.await('room_joined')).opponentName).toBe('NamedHost');
    p1.close();
    p2.close();
  });
});

describe('recording a duel', () => {
  it('gives every match in a room its own sequence number', async () => {
    const host = await newDevice('SeqHost');
    const guest = await newDevice('SeqGuest');
    const { p1, matchSeq } = await seatDuel(host, guest);
    expect(matchSeq).toBe(1);
    p1.close();
  });

  // Two sockets, one relay: messages from DIFFERENT clients have no ordering
  // guarantee between them, and these cases are entirely about order. So each
  // crossing waits for the effect the relay broadcasts for it — the opponent's
  // ball_incoming — before the next one is sent. Without the barrier the tests
  // pass nearly always, which is the worst kind.
  const BALL = { x: 0.5, vx: 0.1, vy: -1, spin: 0, speedMultiplier: 1 };
  const cross = async (from: PhoneSocket, to: PhoneSocket, nth: number): Promise<void> => {
    from.send({ type: 'ball_cross_net', ball: BALL });
    await to.awaitCount('ball_incoming', nth);
  };
  const point = async (from: PhoneSocket, scorer: 'p1' | 'p2', nth: number): Promise<void> => {
    from.send({ type: 'point_scored', scorer });
    await from.awaitCount('score_update', nth);
  };

  it('records each seat its OWN rally streak, counted from its own returns', async () => {
    // The whole chain, through the real relay: ball_cross_net decides whose
    // return it was, point_scored decides whose streak ended, recordRoomMatch
    // writes each seat the number that belongs to it, and the profile banks
    // it. Before this, one shared counter — fed by both players and reset
    // whenever either scored — was written to BOTH profiles as if it were
    // each player's own.
    const host = await newDevice('StreakHost');
    const guest = await newDevice('StreakGuest');
    // 3 is the shortest match normalizeRoomConfig will allow.
    const { p1, p2, matchSeq } = await seatDuel(host, guest, 3);
    expect(matchSeq).toBe(1);

    // p1 serves (seatDuel leaves servingPlayer at 0), so p1's first ball opens
    // the point and counts for nobody. After that each crossing is its own
    // sender's return.
    await cross(p1, p2, 1); // serve
    await cross(p2, p1, 1); // p2: 1
    await cross(p1, p2, 2); // p1: 1
    await cross(p2, p1, 2); // p2: 2
    await cross(p1, p2, 3); // p1: 2
    await cross(p2, p1, 3); // p2: 3
    await cross(p2, p1, 4); // p2: 4
    // p2 let the next one past, so p1 takes the point — and two more after
    // it, neither of which is a rally.
    await point(p2, 'p1', 1);
    await point(p2, 'p1', 2);
    await point(p2, 'p1', 3);

    await p1.await('match_recorded');
    await p2.await('match_recorded');

    const hostProfile = await getProfile(host);
    const guestProfile = await getProfile(guest);
    // Two different numbers, from one match, for the two players in it.
    expect(hostProfile.highestRally).toBe(2);
    expect(guestProfile.highestRally).toBe(4);
    p1.close();
    p2.close();
  });

  it('keeps a winner’s streak running across the point they won', async () => {
    // "A rally streak must never be determined by the opponent's hit/miss."
    // The opponent missing is a point WON, and it used to zero the winner's
    // counter along with the loser's.
    const host = await newDevice('CarryHost');
    const guest = await newDevice('CarryGuest');
    const { p1, p2, matchSeq } = await seatDuel(host, guest, 3);
    expect(matchSeq).toBe(1);

    await cross(p1, p2, 1); // p1 serves
    await cross(p2, p1, 1); // p2: 1
    await cross(p1, p2, 2); // p1: 1
    await point(p2, 'p1', 1); // p2 missed; p2 serves next

    await cross(p2, p1, 2); // p2 serves
    await cross(p1, p2, 3); // p1: 2 — CARRIED, not restarted
    await point(p2, 'p1', 2);
    await point(p2, 'p1', 3);

    await p1.await('match_recorded');
    const hostProfile = await getProfile(host);
    expect(hostProfile.highestRally).toBe(2);
    p1.close();
    p2.close();
  });

  it('carries a duel run into the next ROOM, not just the next match', async () => {
    // "Streaks must carry over between matches." A new room is not a miss
    // either, so a seat opens on whatever run this player already had going in
    // this mode — read from the store by the relay, never taken from the
    // client, because it decides what the match is rated and paid on.
    const host = await newDevice('CarryRoomA');
    const guest = await newDevice('CarryRoomB');

    {
      const { p1, p2 } = await seatDuel(host, guest, 3);
      await cross(p1, p2, 1); // p1 serves
      await cross(p2, p1, 1); // p2: 1
      await cross(p1, p2, 2); // p1: 1
      await cross(p2, p1, 2); // p2: 2
      await cross(p1, p2, 3); // p1: 2
      // p2 misses, so p1 takes the point on a live run of 2 and two more after.
      await point(p2, 'p1', 1);
      await point(p2, 'p1', 2);
      await point(p2, 'p1', 3);
      await p1.await('match_recorded');
      await p2.await('match_recorded');
      p1.close();
      p2.close();
    }
    await sleep(300);

    // A brand new room, and p1's run is still going.
    const second = await seatDuel(host, guest, 3);
    await cross(second.p1, second.p2, 1); // p1 serves — not a return
    await cross(second.p2, second.p1, 1); // p2: 1
    await cross(second.p1, second.p2, 2); // p1: 3, carried from the last room
    await point(second.p2, 'p1', 1);
    await point(second.p2, 'p1', 2);
    await point(second.p2, 'p1', 3);
    await second.p1.await('match_recorded');

    const hostProfile = await getProfile(host);
    expect(hostProfile.highestRally).toBe(3);
    expect(hostProfile.modeStats?.multiplayer?.currentStreak).toBe(3);
    second.p1.close();
    second.p2.close();
  }, 45000);

  it('records a P2P duel for BOTH players, with the winner marked as one', async () => {
    const host = await newDevice('P2PWinner');
    const guest = await newDevice('P2PLoser');
    const { p1, p2, roomId, matchSeq } = await seatDuel(host, guest, 3);

    // Exactly what a P2P match looks like from the relay's side: no
    // point_scored ever arrives, only the peers' own account of the score.
    // Before match_sync existed the relay saw 0-0 here and filed both a loss.
    p1.send({ type: 'match_sync', matchSeq, p1Score: 1, p2Score: 0, bestStreaks: [6, 6] });
    p2.send({ type: 'match_sync', matchSeq, p1Score: 1, p2Score: 0, bestStreaks: [6, 6] });
    p1.send({ type: 'match_sync', matchSeq, p1Score: 3, p2Score: 1, bestStreaks: [11, 11] });

    const hostRecord = await p1.await('match_recorded');
    const guestRecord = await p2.await('match_recorded');
    expect(hostRecord.matchKey).toBe(`duel:${roomId}:${matchSeq}`);
    expect(guestRecord.matchKey).toBe(hostRecord.matchKey);

    const hostProfile = await getProfile(host);
    const guestProfile = await getProfile(guest);
    expect(hostProfile.matchesPlayed).toBe(1);
    expect(hostProfile.matchesWon).toBe(1);
    expect(hostProfile.multiplayerWins).toBe(1);
    expect(hostProfile.totalPointsScored).toBe(3);
    // The half that used to be missing entirely: the loser's own profile.
    expect(guestProfile.matchesPlayed).toBe(1);
    expect(guestProfile.matchesLost).toBe(1);
    expect(guestProfile.matchesWon).toBe(0);
    expect(guestProfile.xp).toBeGreaterThan(0);

    p1.close();
    p2.close();
  });

  it("advances the winner's 'win a match' mission from a P2P duel", async () => {
    // The mission that started this: "win a match against an AI or human
    // opponent" could not be finished by winning a duel, because the relay
    // overwrote the result with the room's untouched 0-0 and filed a loss.
    const host = await newDeviceHoldingAWinMission('MissionWin');
    const guest = await newDevice('MissionFoe');
    const { p1, p2, matchSeq } = await seatDuel(host.device, guest, 3);

    p1.send({ type: 'match_sync', matchSeq, p1Score: 3, p2Score: 0, bestStreaks: [9, 9] });
    await p1.await('match_recorded');

    const winner = await getMissions(host.device);
    const loser = await getMissions(guest);
    const held = (hand: any, id: string) => hand.missions.find((m: any) => m.id === id);

    expect(held(winner, host.missionId).current).toBeGreaterThan(0);
    // The loser was dealt their own hand; whatever win mission they hold,
    // losing must not have moved it.
    for (const mission of loser.missions.filter((m: any) => m.type === 'matches_won')) {
      expect(mission.current).toBe(0);
    }
    // Both played a game, whoever won it.
    for (const hand of [winner, loser]) {
      for (const mission of hand.missions.filter((m: any) => m.type === 'games_played')) {
        expect(mission.current).toBeGreaterThan(0);
      }
    }

    p1.close();
    p2.close();
  });

  it('pays a match once however many times it is reported', async () => {
    const host = await newDevice('DedupeHost');
    const guest = await newDevice('DedupeGuest');
    const { p1, p2, roomId, matchSeq } = await seatDuel(host, guest, 3);

    p1.send({ type: 'match_sync', matchSeq, p1Score: 3, p2Score: 2, bestStreaks: [14, 14] });
    await p1.await('match_recorded');
    const afterRelay = await getProfile(host);

    // The phone POSTs its own copy, exactly as it always has.
    const res = await fetch(`${base}/api/match/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: host.cookie },
      body: JSON.stringify({
        playerScore: 3,
        opponentScore: 2,
        bestStreak: 14, endStreak: 0,
        mode: 'multiplayer',
        isWinner: true,
        roomId,
        matchSeq,
      }),
    });
    const result = await res.json();
    expect(res.status).toBe(200);
    expect(result.alreadyRecorded).toBe(true);

    const afterPost = await getProfile(host);
    expect(afterPost.xp).toBe(afterRelay.xp);
    expect(afterPost.matchesPlayed).toBe(1);
    expect(afterPost.matchesWon).toBe(1);

    p1.close();
    p2.close();
  });

  it('records a relayed duel for both players when the score decides it', async () => {
    const host = await newDevice('RelayHost');
    const guest = await newDevice('RelayGuest');
    const { p1, p2, matchSeq } = await seatDuel(host, guest, 3);

    // The guest wins 3-0 the ordinary relayed way: the player who missed the
    // ball reports the point against themselves.
    for (let i = 0; i < 3; i++) p1.send({ type: 'point_scored', scorer: 'p2' });

    const guestRecord = await p2.await('match_recorded');
    await p1.await('match_recorded');
    expect(guestRecord.result.profile.matchesWon).toBe(1);
    expect(guestRecord.matchKey.endsWith(`:${matchSeq}`)).toBe(true);

    expect((await getProfile(guest)).matchesWon).toBe(1);
    expect((await getProfile(host)).matchesLost).toBe(1);

    p1.close();
    p2.close();
  });

  it('does not fold a rematch into the match before it', async () => {
    const host = await newDevice('RematchHost');
    const guest = await newDevice('RematchGuest');
    const { p1, p2, matchSeq } = await seatDuel(host, guest, 3);

    for (let i = 0; i < 3; i++) p1.send({ type: 'point_scored', scorer: 'p2' });
    await p2.await('match_recorded');
    p1.clear();
    p2.clear();

    p1.send({ type: 'rematch_request' });
    p2.send({ type: 'rematch_request' });
    const restart = await p1.await('game_start');
    expect(restart.matchSeq).toBe(matchSeq + 1);

    for (let i = 0; i < 3; i++) p2.send({ type: 'point_scored', scorer: 'p1' });
    await p1.await('match_recorded');

    // Two matches, one each — not one match recorded twice.
    expect((await getProfile(host)).matchesPlayed).toBe(2);
    expect((await getProfile(guest)).matchesPlayed).toBe(2);
    expect((await getProfile(host)).matchesWon).toBe(1);
    expect((await getProfile(guest)).matchesWon).toBe(1);

    p1.close();
    p2.close();
  });

  it('does not cross-check a late result against the match that replaced it', async () => {
    const host = await newDevice('LateHost');
    const guest = await newDevice('LateGuest');
    const { p1, p2, roomId, matchSeq } = await seatDuel(host, guest, 3);

    // The host wins match 1, but their phone never manages to POST it — say
    // it was offline, and the match went into the on-device queue.
    for (let i = 0; i < 3; i++) p1.send({ type: 'point_scored', scorer: 'p1' });
    await p1.await('match_recorded');
    p1.clear();

    // Meanwhile the room moves on to a rematch and is reset to 0-0.
    p1.send({ type: 'rematch_request' });
    p2.send({ type: 'rematch_request' });
    await p1.await('game_start');

    // The queued match is replayed now. It must be recognised as match 1 —
    // already recorded — rather than cross-checked against the blank room.
    const res = await fetch(`${base}/api/match/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: host.cookie },
      body: JSON.stringify({
        playerScore: 3,
        opponentScore: 0,
        bestStreak: 5, endStreak: 0,
        mode: 'multiplayer',
        isWinner: true,
        roomId,
        matchSeq,
      }),
    });
    const result = await res.json();
    expect(result.alreadyRecorded).toBe(true);
    const profile = await getProfile(host);
    expect(profile.matchesPlayed).toBe(1);
    expect(profile.matchesWon).toBe(1);
    expect(profile.matchesLost).toBe(0);

    p1.close();
    p2.close();
  });

  it('deduplicates a duel POST from a client that does not name the match', async () => {
    // An older bundle still open in a tab POSTs without a matchSeq. It must
    // fall back to the match the room is on — the one that just ended — or
    // the relay's record and this POST would both be paid.
    const host = await newDevice('StaleHost');
    const guest = await newDevice('StaleGuest');
    const { p1, p2, roomId } = await seatDuel(host, guest, 3);

    for (let i = 0; i < 3; i++) p1.send({ type: 'point_scored', scorer: 'p1' });
    await p1.await('match_recorded');

    const res = await fetch(`${base}/api/match/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: host.cookie },
      body: JSON.stringify({
        playerScore: 3,
        opponentScore: 0,
        bestStreak: 4, endStreak: 0,
        mode: 'multiplayer',
        isWinner: true,
        roomId,
      }),
    });
    expect((await res.json()).alreadyRecorded).toBe(true);
    expect((await getProfile(host)).matchesPlayed).toBe(1);

    p1.close();
    p2.close();
  });

  it('keeps a solo match that only the device can report', async () => {
    const player = await newDevice('SoloOnly');
    const body = {
      playerScore: 5,
      opponentScore: 2,
      bestStreak: 7, endStreak: 0,
      mode: 'solo',
      difficulty: 'rookie',
      isWinner: true,
      matchKey: 'solo:test:abc123',
    };
    const post = () =>
      fetch(`${base}/api/match/record`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: player.cookie },
        body: JSON.stringify(body),
      }).then((r) => r.json());

    const first = await post();
    expect(first.alreadyRecorded).toBeFalsy();
    expect(first.earnedXp).toBeGreaterThan(0);

    // The same match replayed from the device queue pays nothing further.
    const replay = await post();
    expect(replay.alreadyRecorded).toBe(true);
    expect(replay.earnedXp).toBe(first.earnedXp);

    const profile = await getProfile(player);
    expect(profile.matchesPlayed).toBe(1);
    expect(profile.matchesWon).toBe(1);
    expect(profile.xp).toBe(first.profile.xp);
  });
});
