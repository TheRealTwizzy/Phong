import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { WSServerMessage } from '../src/types';
import { findMission } from '../src/game/missions';

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-duel-test-'));
let server: ChildProcess;
let base: string;
let wsUrl: string;

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;
  server = spawn('npx', ['tsx', 'server.ts'], {
    cwd: path.resolve(__dirname, '..'),
    // production skips the Vite middleware, which is all this needs and much
    // faster to boot; the API and the relay are the same either way.
    env: { ...process.env, PORT: String(port), DATA_DIR: TMP, NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group, so it can be killed as a whole. `npx tsx` is a
    // TREE — a shell, npx, then the server — and signalling only the process
    // we spawned leaves the actual server running: every test run stranded one
    // holding a port and a deleted temp directory, until CI reaped it as an
    // orphan at the end of the job.
    detached: true,
  });
  for (let i = 0; i < 200; i++) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return;
    } catch {
      /* not listening yet */
    }
    await sleep(100);
  }
  throw new Error('server did not start');
}, 40000);

afterAll(async () => {
  await stopServer();
  fs.rmSync(TMP, { recursive: true, force: true });
});

/** Kill the server's whole process group and wait for it to actually be gone. */
async function stopServer(): Promise<void> {
  if (!server?.pid || server.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => server.once('exit', () => resolve()));
  try {
    // Negative pid = the group, which is the point of spawning detached.
    process.kill(-server.pid, 'SIGKILL');
  } catch {
    server.kill('SIGKILL');
  }
  // Don't leave the temp directory being deleted out from under a live server.
  await Promise.race([exited, sleep(3000)]);
}

interface Device {
  cookie: string;
  id: string;
  username: string;
}

/** A browser: its own cookie jar, its own profile, onboarded. */
async function newDevice(username: string): Promise<Device> {
  const first = await fetch(`${base}/api/profile/me`);
  const cookie = (first.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0])
    .join('; ');
  const res = await fetch(`${base}/api/profile/initialize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ username }),
  });
  const profile = await res.json();
  if (!profile?.id) throw new Error(`onboarding failed: ${JSON.stringify(profile)}`);
  return { cookie, id: profile.id, username };
}

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

/** A connected phone: its socket plus every server message it has received. */
class Phone {
  ws: WebSocket;
  received: WSServerMessage[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (raw) => this.received.push(JSON.parse(raw.toString())));
  }

  static async open(device: Device): Promise<Phone> {
    const ws = new WebSocket(wsUrl, { headers: { cookie: device.cookie } });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return new Phone(ws);
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** The most recent message of `type`, or undefined. */
  last<T extends WSServerMessage['type']>(type: T): Extract<WSServerMessage, { type: T }> | undefined {
    for (let i = this.received.length - 1; i >= 0; i--) {
      if (this.received[i].type === type) return this.received[i] as any;
    }
    return undefined;
  }

  /** Wait for a message of `type` that arrives after `after` messages. */
  async await<T extends WSServerMessage['type']>(
    type: T,
    timeoutMs = 5000
  ): Promise<Extract<WSServerMessage, { type: T }>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = this.last(type);
      if (hit) return hit;
      await sleep(20);
    }
    throw new Error(`timed out waiting for ${type}`);
  }

  clear(): void {
    this.received = [];
  }

  close(): void {
    this.ws.close();
  }
}

/** Host + guest, through the lobby handshake, to the first serve of a match. */
async function seatDuel(host: Device, guest: Device, winningScore = 3) {
  const p1 = await Phone.open(host);
  p1.send({ type: 'create_room', playerId: host.id, config: { winningScore, rules: {} } });
  const created = await p1.await('room_created');

  const p2 = await Phone.open(guest);
  p2.send({ type: 'join_room', roomId: created.roomId, playerId: guest.id });
  await p2.await('room_joined');

  p2.send({ type: 'player_ready', ready: true });
  await p1.await('ready_state');
  p1.send({ type: 'start_match' });
  const start = await p1.await('game_start');
  await p2.await('game_start');
  return { p1, p2, roomId: created.roomId, matchSeq: start.matchSeq };
}

describe('recording a duel', () => {
  it('gives every match in a room its own sequence number', async () => {
    const host = await newDevice('SeqHost');
    const guest = await newDevice('SeqGuest');
    const { p1, matchSeq } = await seatDuel(host, guest);
    expect(matchSeq).toBe(1);
    p1.close();
  });

  it('records a P2P duel for BOTH players, with the winner marked as one', async () => {
    const host = await newDevice('P2PWinner');
    const guest = await newDevice('P2PLoser');
    const { p1, p2, roomId, matchSeq } = await seatDuel(host, guest, 3);

    // Exactly what a P2P match looks like from the relay's side: no
    // point_scored ever arrives, only the peers' own account of the score.
    // Before match_sync existed the relay saw 0-0 here and filed both a loss.
    p1.send({ type: 'match_sync', matchSeq, p1Score: 1, p2Score: 0, maxRally: 6 });
    p2.send({ type: 'match_sync', matchSeq, p1Score: 1, p2Score: 0, maxRally: 6 });
    p1.send({ type: 'match_sync', matchSeq, p1Score: 3, p2Score: 1, maxRally: 11 });

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

    p1.send({ type: 'match_sync', matchSeq, p1Score: 3, p2Score: 0, maxRally: 9 });
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

    p1.send({ type: 'match_sync', matchSeq, p1Score: 3, p2Score: 2, maxRally: 14 });
    await p1.await('match_recorded');
    const afterRelay = await getProfile(host);

    // The phone POSTs its own copy, exactly as it always has.
    const res = await fetch(`${base}/api/match/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: host.cookie },
      body: JSON.stringify({
        playerScore: 3,
        opponentScore: 2,
        maxRally: 14,
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
        maxRally: 5,
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
        maxRally: 4,
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
      maxRally: 7,
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
