import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { findMission } from '../src/game/missions';
import { duelMatchKey } from '../src/matchRules';
import { PVP_UPDATE, updateRating } from '../src/rating';
import { performanceWeight } from '../server/room';
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

const matchHistory = async (device: Device) =>
  (await fetch(`${base}/api/matches/me`, { headers: { cookie: device.cookie } })).json();

/** The ranked board the header badge has to agree with. */
const board = async (): Promise<any[]> =>
  (await (await fetch(`${base}/api/leaderboard?sort=elo`)).json()).leaderboard;

/**
 * Stand a device on the ranked ladder at a chosen rating, by hand.
 *
 * The only suite here that WRITES to the relay's database rather than reading
 * it. The top rung is μ37 and is only ever reached through PvP — deliberately,
 * so an AI cannot be farmed to the top of the board — which means the only way
 * to reach it through the relay is to play dozens of ranked duels for one
 * assertion. A second connection is safe because the database is in WAL mode
 * and the server compiles a statement per read rather than caching rows, so
 * its next `getProfile` sees this.
 *
 * Both ratings are set, not just the visible one, because a duel rates EACH
 * estimator against its own counterpart: the visible ladder against the
 * opponent's rankMu, the hidden one against their mmrMu. A fixture has to
 * stand the device up on both ladders or half of what it is testing is still
 * a default-μ25 beginner. (It used to say something narrower — that the rank
 * update rated against the opponent's hidden MMR — which was true, and was
 * the bug: the standardised margin was measured across two different scales.)
 */
function seedLadder(device: Device, mu: number, sigma: number): void {
  const sql = new DatabaseSync(path.join(relay.dataDir, 'phong.db'));
  try {
    const changed = sql
      .prepare(
        `UPDATE players
            SET rankMu = ?, rankSigma = ?, rankedGames = 5, mmrMu = ?, mmrSigma = ?
          WHERE id = ?`
      )
      .run(mu, sigma, mu, sigma, device.id).changes;
    // A silent no-op here would leave two μ25 players duelling and every
    // assertion below asking about a ladder neither is on.
    if (changed !== 1) throw new Error(`seedLadder matched ${changed} rows for ${device.username}`);
  } finally {
    sql.close();
  }
}

/**
 * Stand a device at DIFFERENT ratings on the two estimators.
 *
 * seedLadder deliberately sets them equal, which is right for a fixture about
 * the ladder alone and useless for asking WHICH of the two a duel rates
 * against — with both at the same value, either answer looks correct. The two
 * diverge in ordinary play, so a test about that has to be able to pull them
 * apart.
 */
function seedSplit(
  device: Device,
  r: { rankMu: number; rankSigma: number; mmrMu: number; mmrSigma: number }
): void {
  const sql = new DatabaseSync(path.join(relay.dataDir, 'phong.db'));
  try {
    const changed = sql
      .prepare(
        `UPDATE players
            SET rankMu = ?, rankSigma = ?, rankedGames = 5, mmrMu = ?, mmrSigma = ?
          WHERE id = ?`
      )
      .run(r.rankMu, r.rankSigma, r.mmrMu, r.mmrSigma, device.id).changes;
    if (changed !== 1) throw new Error(`seedSplit matched ${changed} rows for ${device.username}`);
  } finally {
    sql.close();
  }
}

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

  it('files nothing at all when a snapshot claims BOTH seats won', async () => {
    // The reported bug, end to end: two players saw a red down-arrow after one
    // ranked duel. updateRating cannot invert a sign — a winner always gains —
    // so a red arrow means the server believed that seat LOST, and both red
    // meant both were recorded as losers. One match_sync with each score at
    // the cap was enough: the two are clamped independently, so [9, 9] landed
    // as [3, 3], reported the match decided, and recordRoomMatch's
    // `mine > theirs` was false for BOTH seats.
    //
    // room.test.ts holds the boundary that refuses it. This holds the outcome,
    // and it is not the same assertion: a recordRoomMatch that still ties
    // passes there and fails here.
    const host = await newDevice('TieHost');
    const guest = await newDevice('TieGuest');
    const { p1, p2, matchSeq } = await seatDuel(host, guest, 3);

    p1.send({ type: 'match_sync', matchSeq, rev: 1, p1Score: 1, p2Score: 1 });
    p1.send({ type: 'match_sync', matchSeq, rev: 2, p1Score: 9, p2Score: 9 });
    p2.send({ type: 'match_sync', matchSeq, rev: 3, p1Score: 3, p2Score: 3 });
    await sleep(400);

    const hostProfile = await getProfile(host);
    const guestProfile = await getProfile(guest);
    // Neither a loss for either of them, nor a win for either — an undecided
    // duel has no result to file, and inventing one for both is how a player
    // lost rating to a match nobody won.
    for (const p of [hostProfile, guestProfile]) {
      expect(p.matchesPlayed).toBe(0);
      expect(p.matchesLost).toBe(0);
      expect(p.matchesWon).toBe(0);
      expect(p.rankedGames).toBe(0);
      expect(p.xp).toBe(0);
    }
    expect(p1.all('match_recorded')).toHaveLength(0);
    expect(p2.all('match_recorded')).toHaveLength(0);

    // And the room is still playable afterwards: the refusal drops the
    // snapshot, not the match.
    p1.send({ type: 'match_sync', matchSeq, rev: 4, p1Score: 3, p2Score: 1 });
    const decided = await p1.await('match_recorded');
    expect(decided.result.rankDirection).toBe('up');
    expect((await getProfile(host)).matchesWon).toBe(1);
    expect((await getProfile(guest)).matchesLost).toBe(1);

    p1.close();
    p2.close();
  }, 45000);

  it('does not file the WINNER a 0-0 loss when their POST outruns the sync', async () => {
    // The second route to two red arrows, and the likelier one: it needs no
    // malformed message, just an ordinary race. In a P2P duel the deciding
    // match_sync goes over the WebSocket while the client's own POST goes over
    // HTTP, so the winner's report can reach the relay first — against a room
    // still reading 0-0. The cross-check then overwrote the payload from that
    // room, and `isWinner = mine > theirs` was false, so the WINNER was filed a
    // 0-0 loss. The shared matchKey deduped the relay's correct record away
    // afterwards, so the wrong one stood: winner red, loser red.
    //
    // A room that has not decided the match has nothing to say about it, so
    // the client's own account stands — the same rule as no room at all.
    const host = await newDevice('EarlyWin');
    const guest = await newDevice('EarlyLose');
    const race = await seatDuel(host, guest, 3);

    const early = await fetch(`${base}/api/match/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: host.cookie },
      body: JSON.stringify({
        playerScore: 3, opponentScore: 0,
        bestStreak: 4, endStreak: 4, earnedStreak: 4,
        mode: 'multiplayer', isWinner: true,
        roomId: race.roomId, matchSeq: race.matchSeq,
      }),
    });
    expect(early.status).toBe(200);
    const result = await early.json();
    expect(result.rankDirection).toBe('up');

    const hostProfile = await getProfile(host);
    expect(hostProfile.matchesWon).toBe(1);
    expect(hostProfile.matchesLost).toBe(0);
    expect(hostProfile.totalPointsScored).toBe(3);

    race.p1.close();
    race.p2.close();
  }, 45000);

  it('rates the visible ladder against the opponent\'s LADDER, not their hidden MMR', async () => {
    // The two estimators diverge by design: a solo match moves mmrMu and never
    // rankMu, SOLO_MU_CAPS caps one while AI_ADAPT_BAND moves the other, and a
    // Rookie solo moves the first and not the second. So a fixture can stand a
    // player far apart on the two, and then the ladder update either used the
    // right one or it did not.
    //
    // The host is a Legend on the ladder and an ordinary μ25 in hidden MMR.
    // Beating them is a big upset on the ladder and a coin flip on MMR, so the
    // guest's rank gain is much larger when it is measured against the rank
    // pair — which is the whole point of the fix. Asserted against
    // updateRating itself rather than a magic number, so it stays true if the
    // constants move.
    const host = await newDevice('SplitRating');
    const guest = await newDevice('SplitChallenger');
    seedSplit(host, { rankMu: 34, rankSigma: 2, mmrMu: 25, mmrSigma: 2 });
    seedSplit(guest, { rankMu: 25, rankSigma: 2, mmrMu: 25, mmrSigma: 2 });

    const { p1, p2, matchSeq } = await seatDuel(host, guest, 3);
    p1.send({ type: 'match_sync', matchSeq, rev: 1, p1Score: 1, p2Score: 3 });
    const guestRecord = await p2.await('match_recorded');
    expect(guestRecord.result.rankDirection).toBe('up');

    const after = await getProfile(guest);
    const perf = performanceWeight(3, 1, 0);
    const againstRank = updateRating(
      { mu: 25, sigma: 2 },
      { mu: 34, sigma: 2 },
      true,
      { ...PVP_UPDATE, performance: perf }
    );
    const againstMmr = updateRating(
      { mu: 25, sigma: 2 },
      { mu: 25, sigma: 2 },
      true,
      { ...PVP_UPDATE, performance: perf }
    );
    expect(after.rankMu).toBeCloseTo(againstRank.mu, 6);
    // And the two answers really are far apart, or this proves nothing.
    expect(Math.abs(againstRank.mu - againstMmr.mu)).toBeGreaterThan(0.3);

    // The hidden estimator still rates against the hidden pair, untouched.
    expect(after.mmrMu).toBeCloseTo(againstMmr.mu, 6);

    p1.close();
    p2.close();
  }, 45000);

  it('moves exactly one seat up the ladder and the other down', async () => {
    // The direct regression assertion for "both arrows were red". The rank
    // tile draws MatchEndResult.rankDirection, so a decided ranked duel has to
    // produce one 'up' and one 'down' — never two of a kind, in either
    // direction. Nothing in the browser layer asserts the arrow, which is how
    // this reached a player in the first place.
    const host = await newDevice('DirUp');
    const guest = await newDevice('DirDown');
    const { p1, p2, matchSeq } = await seatDuel(host, guest, 3);

    p1.send({ type: 'match_sync', matchSeq, rev: 1, p1Score: 3, p2Score: 1 });
    const hostRecord = await p1.await('match_recorded');
    const guestRecord = await p2.await('match_recorded');

    const directions = [hostRecord.result.rankDirection, guestRecord.result.rankDirection];
    expect(directions.filter((d: string) => d === 'up')).toHaveLength(1);
    expect(directions.filter((d: string) => d === 'down')).toHaveLength(1);
    expect(hostRecord.result.rankDirection).toBe('up');
    expect(guestRecord.result.rankDirection).toBe('down');

    p1.close();
    p2.close();
  }, 45000);

  it('tells both phones to come off P2P the moment it starts counting', async () => {
    // The fix for the divergence rather than a rule for living with it. Every
    // way of reconciling two peers' accounts after they split trades one wrong
    // answer for another — discard the return the relay counted, or discard
    // the point the still-open peer scored. So they are not reconciled: the
    // relay says "everyone onto me", and it is then the only thing keeping
    // score. The guard on the assigned fields stays behind it, because a
    // broadcast is a request and a client takes a moment to act on one.
    const host = await newDevice('FallbackH');
    const guest = await newDevice('FallbackG');
    const { p1, p2 } = await seatDuel(host, guest, 3);

    // Nothing yet: the peers are on their own link and the relay has counted
    // nothing, so it has no business ending their P2P session.
    await sleep(150);
    expect(p1.all('p2p_fallback').length).toBe(0);
    expect(p2.all('p2p_fallback').length).toBe(0);

    // One peer falls back and relays a crossing.
    await cross(p2, p1, 1);

    // BOTH are told — including the one that reported it, whose own link may
    // be the half that is still up.
    await p1.await('p2p_fallback');
    await p2.await('p2p_fallback');

    // And only once, however many events follow: it is a state change, not a
    // per-crossing broadcast.
    await cross(p1, p2, 1);
    await cross(p2, p1, 2);
    await sleep(150);
    expect(p1.all('p2p_fallback').length).toBe(1);

    p1.close();
    p2.close();
  }, 20000);

  it('keeps a relay-counted return when the other peer has not noticed the link is down', async () => {
    // The second half of a one-sided fallback. p2 notices first and relays its
    // crossing, which the relay counts. p1 has not noticed, so it is told about
    // that crossing only as a ball_incoming — a message its P2P replica never
    // sees — and its next snapshot is a genuinely LATER revision describing a
    // match one return short. Ordering cannot save this: the revision is not
    // stale, the picture is. So the relay stops taking the fields a snapshot
    // ASSIGNS once it is counting the match itself.
    //
    // Through the real relay because the flag is set in server.ts's handler;
    // the room suite reaches countReturn directly and sets it by hand.
    const host = await newDevice('DivergeH');
    const guest = await newDevice('DivergeG');
    const { p1, p2, matchSeq } = await seatDuel(host, guest, 3);

    // Mid-point, p1 three returns in. Sent on p2's socket so it is ordered
    // against p2's crossing below; messages from two sockets are not.
    p2.send({
      type: 'match_sync', matchSeq, rev: 1,
      p1Score: 0, p2Score: 0,
      bestStreaks: [3, 0], streaks: [3, 0], earnedBests: [3, 0],
      servingPlayer: 0, crossingsThisPoint: 4,
    });

    // p2 falls back and relays its return. Awaiting p1's ball_incoming is the
    // barrier: the relay has counted it before p1 says anything else.
    await cross(p2, p1, 1);

    // p1, still on P2P, reports the moment that ends the match — from a
    // replica that never saw p2's return.
    p1.send({
      type: 'match_sync', matchSeq, rev: 2,
      p1Score: 3, p2Score: 0,
      bestStreaks: [3, 0], streaks: [3, 0], earnedBests: [3, 0],
      servingPlayer: 0, crossingsThisPoint: 4,
    });

    await p1.await('match_recorded');
    await p2.await('match_recorded');

    // The run p2 walks away with is the one the relay counted, not the one p1
    // never knew about. Zero here means the snapshot undid the return.
    const guestProfile = await getProfile(guest);
    expect(guestProfile.modeStats?.multiplayer?.currentStreak).toBe(1);
    // p1's own run is untouched either way — this is not a case of the relay
    // taking something away from the peer that reported it.
    expect((await getProfile(host)).modeStats?.multiplayer?.currentStreak).toBe(3);

    p1.close();
    p2.close();
  }, 20000);

  it('rates the second seat against the opponent it started against, whichever path records first', async () => {
    // A duel reaches the ladder by two routes — the relay writes it the moment
    // the score decides it, and each phone POSTs its own copy as the fallback
    // for a match the relay never saw. Both used to read the opponent's rating
    // live, so whichever committed first moved that player's rating and the
    // second seat was rated against an opponent that had already played the
    // match. In a P2P duel the two routes travel different connections, so
    // which lands first is a race.
    //
    // The control is the same match with only the relay recording it. The
    // loser's rating has to come out identical either way: it is the same
    // match against the same opponent, and the opponent's own paperwork
    // landing first is not a fact about the loser.
    const ctlHost = await newDevice('RateCtlH');
    const ctlGuest = await newDevice('RateCtlG');
    const ctl = await seatDuel(ctlHost, ctlGuest, 3);
    const FINAL = {
      p1Score: 3, p2Score: 0,
      bestStreaks: [5, 2] as [number, number],
      streaks: [5, 2] as [number, number],
      earnedBests: [5, 2] as [number, number],
      servingPlayer: 0 as const,
      crossingsThisPoint: 0,
    };
    ctl.p1.send({ type: 'match_sync', matchSeq: ctl.matchSeq, rev: 1, ...FINAL });
    await ctl.p2.await('match_recorded');
    const control = await getProfile(ctlGuest);
    ctl.p1.close();
    ctl.p2.close();

    // The same match, with the winner's own POST landing first. It is
    // cross-checked against a room the deciding sync has not reached yet, so
    // it records a different result for the WINNER — which is the point: it
    // moves their rating before the relay reaches the loser.
    const host = await newDevice('RateRaceH');
    const guest = await newDevice('RateRaceG');
    const race = await seatDuel(host, guest, 3);
    const early = await fetch(`${base}/api/match/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: host.cookie },
      body: JSON.stringify({
        playerScore: 3, opponentScore: 0,
        bestStreak: 5, endStreak: 5, earnedStreak: 5,
        mode: 'multiplayer', isWinner: true,
        roomId: race.roomId, matchSeq: race.matchSeq,
      }),
    });
    expect(early.status).toBe(200);
    // It really did move: otherwise this proves nothing.
    expect((await getProfile(host)).mmrMu).not.toBe(control.mmrMu);

    race.p1.send({ type: 'match_sync', matchSeq: race.matchSeq, rev: 1, ...FINAL });
    await race.p2.await('match_recorded');
    const raced = await getProfile(guest);

    expect(raced.mmrMu).toBeCloseTo(control.mmrMu, 10);
    expect(raced.mmrSigma).toBeCloseTo(control.mmrSigma, 10);

    race.p1.close();
    race.p2.close();
  }, 20000);

  it('samples the opponent rating at the START of the match, not at whoever records it first', async () => {
    // duelStartRatings used to populate lazily, on first touch by whichever
    // recording path reached the room first — safe against the room's OWN two
    // recording paths racing each other, but not against a completely
    // unrelated write moving the same player's mmrMu in between. The most
    // concrete version: a stale SOLO match, queued from before this duel even
    // started, finally replays successfully WHILE the duel is live — and if
    // the cache is still empty at that point, the eventual sample captures the
    // post-solo mmrMu instead of what the host had when the duel began.
    //
    // The control has no such interleaving. The two guests must be rated
    // identically: it is the same duel against the same starting host, and an
    // unrelated match the host happens to also be playing is not a fact about
    // the host's rating AT THE MOMENT THIS DUEL STARTED.
    const ctlHost = await newDevice('EagerCtlH');
    const ctlGuest = await newDevice('EagerCtlG');
    const ctl = await seatDuel(ctlHost, ctlGuest, 3);
    const FINAL = {
      p1Score: 3, p2Score: 0,
      bestStreaks: [5, 2] as [number, number],
      streaks: [5, 2] as [number, number],
      earnedBests: [5, 2] as [number, number],
      servingPlayer: 0 as const,
      crossingsThisPoint: 0,
    };
    ctl.p1.send({ type: 'match_sync', matchSeq: ctl.matchSeq, rev: 1, ...FINAL });
    await ctl.p2.await('match_recorded');
    const control = await getProfile(ctlGuest);
    ctl.p1.close();
    ctl.p2.close();

    const host = await newDevice('EagerRaceH');
    const guest = await newDevice('EagerRaceG');
    const race = await seatDuel(host, guest, 3);

    // The interleaving write: an unrelated solo match for the HOST, landing
    // strictly AFTER the duel has already started (seatDuel returns only once
    // start_match has fired) and strictly BEFORE the duel is recorded.
    const soloRes = await fetch(`${base}/api/match/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: host.cookie },
      body: JSON.stringify({
        playerScore: 5, opponentScore: 0,
        bestStreak: 9, endStreak: 9, earnedStreak: 9,
        mode: 'solo', difficulty: 'rookie', isWinner: true,
        matchKey: 'solo:eager-interleave:1',
      }),
    });
    expect(soloRes.status).toBe(200);
    // It really did move: otherwise this proves nothing.
    expect((await getProfile(host)).mmrMu).not.toBe(control.mmrMu);

    race.p1.send({ type: 'match_sync', matchSeq: race.matchSeq, rev: 1, ...FINAL });
    await race.p2.await('match_recorded');
    const raced = await getProfile(guest);

    // The guest is rated as though the interleaved solo match never happened
    // — because as far as THIS duel is concerned, at the moment it started,
    // it hadn't.
    expect(raced.mmrMu).toBeCloseTo(control.mmrMu, 10);
    expect(raced.mmrSigma).toBeCloseTo(control.mmrSigma, 10);

    race.p1.close();
    race.p2.close();
  }, 20000);

  it('takes a peer’s snapshot after the relay counted a crossing for the other', async () => {
    // A DataChannel does not fail for both peers at the same instant. The one
    // that notices first falls back and relays its next crossing; the one that
    // has not noticed keeps playing P2P and keeps reporting. The relay used to
    // count its own crossings into the PEERS' revision clock, so that report
    // arrived carrying a revision the relay had just taken and was refused as
    // stale — and a P2P match is decided by nothing else, so the match that
    // report was announcing went unrecorded for both players.
    //
    // This has to run through the real relay: what must not advance the clock
    // is server.ts's ball_cross_net handler, and the unit suite reaches
    // countReturn directly, so it cannot see it either way.
    const host = await newDevice('RevHost');
    const guest = await newDevice('RevGuest');
    const { p1, p2, roomId, matchSeq } = await seatDuel(host, guest, 3);

    p1.send({
      type: 'match_sync', matchSeq, rev: 1,
      p1Score: 1, p2Score: 0,
      bestStreaks: [4, 0], streaks: [4, 0], earnedBests: [4, 0],
      servingPlayer: 0, crossingsThisPoint: 0,
    });

    // p2 sees the link die and relays its next crossing. The relay counts it.
    await cross(p2, p1, 1);

    // p1 has not noticed yet, and its next snapshot is the one that ends the
    // match. With the clocks shared it lands at the mark and is dropped.
    p1.send({
      type: 'match_sync', matchSeq, rev: 2,
      p1Score: 3, p2Score: 0,
      bestStreaks: [7, 1], streaks: [7, 1], earnedBests: [7, 1],
      servingPlayer: 0, crossingsThisPoint: 0,
    });

    const record = await p1.await('match_recorded');
    expect(record.matchKey).toBe(`duel:${roomId}:${matchSeq}`);
    await p2.await('match_recorded');

    const hostProfile = await getProfile(host);
    expect(hostProfile.matchesWon).toBe(1);
    expect((await getProfile(guest)).matchesLost).toBe(1);

    p1.close();
    p2.close();
    // Longer than the awaits inside it, so a regression fails naming the
    // message that never arrived rather than as a bare test timeout.
  }, 20000);

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
        bestStreak: 14, endStreak: 0, earnedStreak: 14,
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
        bestStreak: 5, endStreak: 0, earnedStreak: 5,
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
        bestStreak: 4, endStreak: 0, earnedStreak: 4,
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

  it('deduplicates a duel POST that carries the key but not the room', async () => {
    // A leave or ejection racing the final point can null the client's room
    // state before the recording effect runs — so the payload arrives with no
    // roomId for the server to re-derive the key from. The client mints and
    // caches the duel key at game_start for exactly this case; the ledger
    // must recognise it on the key alone, or the relay's record and this POST
    // are both paid.
    const host = await newDevice('KeyOnlyHost');
    const guest = await newDevice('KeyOnlyGuest');
    const { p1, p2, roomId, matchSeq } = await seatDuel(host, guest, 3);

    for (let i = 0; i < 3; i++) p1.send({ type: 'point_scored', scorer: 'p1' });
    await p1.await('match_recorded');

    const res = await fetch(`${base}/api/match/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: host.cookie },
      body: JSON.stringify({
        playerScore: 3,
        opponentScore: 0,
        bestStreak: 4, endStreak: 0, earnedStreak: 4,
        mode: 'multiplayer',
        isWinner: true,
        matchKey: duelMatchKey(roomId, matchSeq),
      }),
    });
    expect((await res.json()).alreadyRecorded).toBe(true);
    expect((await getProfile(host)).matchesPlayed).toBe(1);

    p1.close();
    p2.close();
  });

  it('refuses a record whose mode is not a match', async () => {
    // Practice and Split Screen never call this route — practice reports
    // through /api/practice/record and split records nothing — but a
    // hand-rolled payload naming them used to reach recordMatch, where
    // normalizeDifficulty defaults 'pro' and the ranking rule never checked
    // the mode: a "practice" result could move rankedGames and rating.
    const player = await newDevice('WallPoster');
    for (const mode of ['practice', 'split', 'garbage']) {
      const res = await fetch(`${base}/api/match/record`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: player.cookie },
        body: JSON.stringify({
          playerScore: 5,
          opponentScore: 0,
          bestStreak: 3, endStreak: 0, earnedStreak: 3,
          mode,
          isWinner: true,
          matchKey: `bad:${mode}:1`,
        }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('BAD_REQUEST');
    }
    const profile = await getProfile(player);
    expect(profile.matchesPlayed).toBe(0);
    expect(profile.rankedGames).toBe(0);
    expect(profile.xp).toBe(0);
  });

  it('serves each player one paged history row per match, publicly too', async () => {
    const host = await newDevice('PubHistHost');
    const guest = await newDevice('PubHistGuest');
    const { p1, p2 } = await seatDuel(host, guest, 3);
    for (let i = 0; i < 3; i++) p1.send({ type: 'point_scored', scorer: 'p1' });
    await p1.await('match_recorded');
    await p2.await('match_recorded');

    // Own history: one row for the one duel, own perspective, and the paging
    // envelope alongside the back-compatible `matches` field.
    const mine = await (
      await fetch(`${base}/api/matches/me`, { headers: { cookie: host.cookie } })
    ).json();
    expect(mine.matches).toHaveLength(1);
    expect(mine.total).toBe(1);
    expect(mine.page).toBe(1);
    expect(mine.pageSize).toBe(10);
    expect(mine.matches[0].winnerId).toBe(host.id);
    expect(mine.matches[0].ranked).toBe(1);

    // The loser's history is one LOSS — not their row plus the winner's copy.
    const theirs = await (
      await fetch(`${base}/api/matches/me`, { headers: { cookie: guest.cookie } })
    ).json();
    expect(theirs.matches).toHaveLength(1);
    expect(theirs.matches[0].player1Id).toBe(guest.id);
    expect(theirs.matches[0].winnerId).toBe(host.id);

    // The same rows are public, cookie or no cookie, with the same filters.
    const pub = await fetch(`${base}/api/profile/${host.id}/matches`);
    expect(pub.status).toBe(200);
    const pubBody = await pub.json();
    expect(pubBody.total).toBe(1);
    expect(pubBody.matches[0].player1Id).toBe(host.id);
    const pvp = await (
      await fetch(`${base}/api/profile/${host.id}/matches?tab=pvp&ranked=ranked`)
    ).json();
    expect(pvp.total).toBe(1);
    const solo = await (await fetch(`${base}/api/profile/${host.id}/matches?tab=solo`)).json();
    expect(solo.total).toBe(0);

    // 'me' is never a stored id, and an uninitialized profile has no public
    // history — both are the same 404 the public profile route answers.
    expect((await fetch(`${base}/api/profile/me/matches`)).status).toBe(404);
    const stranger = await newUnclaimedDevice();
    expect((await fetch(`${base}/api/profile/${stranger.id}/matches`)).status).toBe(404);

    p1.close();
    p2.close();
  });

  it('keeps a solo match that only the device can report', async () => {
    const player = await newDevice('SoloOnly');
    const body = {
      playerScore: 5,
      opponentScore: 2,
      bestStreak: 7, endStreak: 0, earnedStreak: 7,
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

  it('rates both seats against the same pair of ratings', async () => {
    // The relay writes both results, seat 0 first — and seat 0's write commits
    // its MMR before seat 1's payload is built. Reading the opponent's profile
    // inside the loop therefore gave seat 1 an opponent that had already
    // moved: one match, two different preconditions, and the difference falls
    // the same way every time.
    //
    // Two players with identical histories play a mirror-image match, so
    // whatever the ratings do, they must do it symmetrically.
    const a = await newDevice('SymA');
    const b = await newDevice('SymB');
    const { p1, p2 } = await seatDuel(a, b, 3);

    // 3-0 to seat 0. The loser's loss must mirror the winner's win.
    await point(p1, 'p1', 1);
    await point(p1, 'p1', 2);
    await point(p1, 'p1', 3);
    const hostRecord = await p1.await('match_recorded');
    const guestRecord = await p2.await('match_recorded');

    // The prediction is the clean read. Two players cannot both be more likely
    // than not to win: P(A beats B) and P(B beats A) sum to exactly 1, and
    // they do so only if both were computed from the same pair of ratings.
    // With seat 0 committed first, seat 1 was predicted against an opponent
    // that had already absorbed its own win — so the pair summed to less.
    //
    // Deliberately not asserted on the mu change: performanceWeight scales
    // that by margin of victory, so a 3-0 moves the two seats by different
    // amounts on purpose and would hide this rather than show it.
    // Tolerance because erf is approximated in-module (see rating.ts), so the
    // pair lands about 1e-9 off exact. The defect being caught is four orders
    // of magnitude wider than that: seat 0's mu moves by ~2.5 in this match,
    // which shifts the second prediction by ~0.05.
    const pWin = hostRecord.result.winProbability + guestRecord.result.winProbability;
    expect(Math.abs(pWin - 1)).toBeLessThan(1e-6);
    // Both did move, so this is not vacuously true of an unrated match.
    expect((await getProfile(a)).mmrMu).toBeGreaterThan(25);
    expect((await getProfile(b)).mmrMu).toBeLessThan(25);
    p1.close();
    p2.close();
  });

  it('records an abandoned duel as a loss for the leaver and a win for the survivor', async () => {
    // Walking out of a live duel used to be written by nobody: no loss for
    // the leaver, and the survivor's win evaporated with them. That is how a
    // profile reaches a 100% win rate with no tracked losses — quit every
    // duel you are losing. An abandoned duel is a match both of them PLAYED,
    // and leaving it is losing it.
    const host = await newDevice('AbandonHost');
    const guest = await newDevice('AbandonGuest');
    const { p1, p2 } = await seatDuel(host, guest, 3);

    await cross(p1, p2, 1); // p1 serves — counts for nobody
    await cross(p2, p1, 1); // p2: 1
    await cross(p1, p2, 2); // p1: 1
    await cross(p2, p1, 2); // p2: 2
    await cross(p2, p1, 3); // p2: 3

    // The host walks out mid-rally. Nothing decides the match on the score.
    p1.close();
    await sleep(400);

    const hostProfile = await getProfile(host);
    const guestProfile = await getProfile(guest);
    // Each seat's own run, stored where the next duel will read it — the
    // records the relay writes carry them, so a run is not lost to a walkout.
    expect(hostProfile.modeStats?.multiplayer?.currentStreak).toBe(1);
    expect(guestProfile.modeStats?.multiplayer?.currentStreak).toBe(3);
    // The match is on both records, once each, pointing the same way.
    expect(hostProfile.matchesPlayed).toBe(1);
    expect(hostProfile.matchesLost).toBe(1);
    expect(hostProfile.matchesWon).toBe(0);
    expect(guestProfile.matchesPlayed).toBe(1);
    expect(guestProfile.matchesWon).toBe(1);
    expect(guestProfile.abandons ?? 0).toBe(0); // the survivor did not abandon
    expect(hostProfile.abandons).toBe(1);

    const hostHistory = await matchHistory(host);
    const guestHistory = await matchHistory(guest);
    expect(hostHistory.total).toBe(1);
    expect(guestHistory.total).toBe(1);
    expect(hostHistory.matches[0].winnerId).toBe(guest.id);
    expect(guestHistory.matches[0].winnerId).toBe(guest.id);
    // The day's FIRST abandon is forgiven on the rating only: the leaver's
    // copy goes down un-ranked, while the survivor's win rates normally.
    expect(hostHistory.matches[0].ranked).toBe(0);
    expect(guestHistory.matches[0].ranked).toBe(1);
    expect(hostProfile.rankedGames).toBe(0);
    expect(guestProfile.rankedGames).toBe(1);
    p2.close();
  });

  it('rates the loss once the day’s forgiveness is spent', async () => {
    const host = await newDevice('RageQuitHost');
    const guest = await newDevice('RageQuitGuest');

    // First abandon of the day — forgiven, so it costs the record but not the
    // ladder.
    {
      const { p1, p2 } = await seatDuel(host, guest, 3);
      await cross(p1, p2, 1);
      await cross(p2, p1, 1);
      p1.close();
      await sleep(400);
      p2.close();
    }
    const afterFirst = await getProfile(host);
    expect(afterFirst.matchesLost).toBe(1);
    expect(afterFirst.rankedGames).toBe(0);

    // Second the same day: the pattern is not forgiven, so this loss rates
    // like any other — the real cost of walking out, and no flat penalty.
    {
      const { p1, p2 } = await seatDuel(host, guest, 3);
      await cross(p1, p2, 1);
      await cross(p2, p1, 1);
      p1.close();
      await sleep(400);
      p2.close();
    }
    const afterSecond = await getProfile(host);
    expect(afterSecond.matchesLost).toBe(2);
    expect(afterSecond.rankedGames).toBe(1);
    expect(afterSecond.rankMu).toBeLessThan(afterFirst.rankMu);
    const history = await matchHistory(host);
    expect(history.matches.map((m: any) => m.ranked)).toEqual([1, 0]); // newest first
  });

  it('numbers two Overlords against the ladder BOTH results left behind', async () => {
    // `ladderPosition` is the one field on a match result that is a statement
    // about every other player, and a duel moves two of them. recordRoomMatch
    // writes seat 0 first, so a position derived while seat 1 still holds its
    // pre-match row answers for a ladder one update out of date — and the case
    // where that is visible is precisely two adjacent Overlords swapping
    // order, which is the case anybody at the top of the board is watching.
    //
    // Concretely, with the send back inside the recording loop: the winner is
    // numbered while the loser still stands above them, so BOTH seats are told
    // they are #2 and the board shows nobody at #1.
    //
    // The ratings are written straight into the database because there is no
    // other way to reach μ37 — the top rung is only ever reached through PvP,
    // by design (see CLAUDE.md §7), so manufacturing one through the relay
    // would mean playing dozens of duels to test one line. After newDevice so
    // the row exists, and before seatDuel because startMatch samples both
    // seats then and caches them for the match.
    const HOST_MU = 39.5;
    const GUEST_MU = 40.2;
    const host = await newDevice('LadderHost');
    const guest = await newDevice('LadderGuest');
    // The sigmas are the fixture, not decoration. A rank step scales with the
    // player's own sigma, so a confident host moves a little and an uncertain
    // guest moves a lot — which is what puts the host's new rating between the
    // guest's new one and the guest's OLD one, the only band in which a stale
    // read answers differently from a fresh one. Symmetric sigmas make the
    // winner clear the loser's pre-match rating outright and the bug becomes
    // invisible; that version of this test passed against the broken server.
    seedLadder(host, HOST_MU, 1.0);
    seedLadder(guest, GUEST_MU, 3.9);

    const before = await board();
    expect(before.slice(0, 2).map((e: any) => e.username)).toEqual(['LadderGuest', 'LadderHost']);

    const { p1, p2 } = await seatDuel(host, guest, 3);
    await cross(p1, p2, 1);
    await cross(p2, p1, 1);
    for (let i = 0; i < 3; i++) await point(p1, 'p1', i + 1);

    const hostResult = (await p1.await('match_recorded')).result as any;
    const guestResult = (await p2.await('match_recorded')).result as any;

    // The upset landed, or this test is no longer about the thing it names.
    expect(hostResult.profile.tier).toBe('overlord');
    expect(guestResult.profile.tier).toBe('overlord');
    const after = await board();
    expect(after.slice(0, 2).map((e: any) => e.username)).toEqual(['LadderHost', 'LadderGuest']);
    // And the band still holds. Stated rather than assumed because a retune of
    // the rank step would move the winner clear of the loser's old rating, at
    // which point every assertion below passes against a server that never had
    // the fix — the fixture would go quiet instead of red. rankMu is read from
    // the player's OWN profile, which is the only place it is ever legible.
    const hostMuAfter = (await getProfile(host)).rankMu;
    const guestMuAfter = (await getProfile(guest)).rankMu;
    expect(guestMuAfter).toBeLessThan(hostMuAfter);
    expect(hostMuAfter).toBeLessThan(GUEST_MU);

    // The assertion that matters is not either number on its own — it is that
    // each seat was told what the BOARD says about it. A number checked alone
    // passes on the bug, because #2 is a perfectly plausible answer.
    const rankOf = (name: string) => after.find((e: any) => e.username === name)!.rank;
    expect(hostResult.profile.ladderPosition).toBe(rankOf('LadderHost'));
    expect(guestResult.profile.ladderPosition).toBe(rankOf('LadderGuest'));
    // And spelled out, because "both agree with the board" would also be
    // satisfied by a board this suite had somehow left empty.
    expect([hostResult.profile.ladderPosition, guestResult.profile.ladderPosition]).toEqual([1, 2]);

    p1.close();
    p2.close();
  });

  it('records no match when a lobby seat is left before any ball crosses', async () => {
    // Only a LIVE match is one you can walk out of. Leaving a lobby, or a
    // room whose match already ended, is not an abandon and not a loss.
    const host = await newDevice('LobbyLeaveHost');
    const guest = await newDevice('LobbyLeaveGuest');
    const { p1, p2 } = await seatDuel(host, guest, 3);
    p1.close();
    await sleep(400);

    const hostProfile = await getProfile(host);
    expect(hostProfile.matchesPlayed).toBe(0);
    expect(hostProfile.abandons ?? 0).toBe(0);
    expect((await getProfile(guest)).matchesPlayed).toBe(0);
    p2.close();
  });
});
