import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Device, Relay, sleep, startRelay } from './helpers/relay';

// A CPU seated at a real relay table: what the relay lets it do, and what it
// must not.
//
// The rules that can be stated purely are in tests/room.test.ts and
// tests/matchRules.test.ts. What needs a live server is the seam between them
// — the handlers, and above all the record route, where `roomId` on a solo
// payload is a client-chosen string and the relay writes no second copy of
// the match to check it against.

let relay: Relay;
let base: string;

beforeAll(async () => {
  relay = await startRelay('cputable');
  base = relay.base;
}, 30_000);

afterAll(async () => {
  await relay?.stop();
});

const newDevice = (username: string) => relay.newDevice(username);

/** Open a table with a CPU in the other seat, and start the match. */
async function seatCpu(
  host: Device,
  opts: { cpu?: string; spectators?: boolean; winningScore?: number } = {}
) {
  const p = await relay.openPhone(host);
  p.send({
    type: 'create_room',
    playerId: host.id,
    config: {
      winningScore: opts.winningScore ?? 3,
      rules: {},
      spectators: opts.spectators ?? false,
      cpu: opts.cpu ?? 'pro',
    },
  });
  const created = await p.await('room_created');
  return { phone: p, roomId: created.roomId as string };
}

const rankOf = async (device: Device): Promise<{ rankMu: number; rankedGames: number }> => {
  const profile = await fetch(`${base}/api/profile/me`, {
    headers: { cookie: device.cookie },
  }).then((r) => r.json());
  return { rankMu: profile.rankMu, rankedGames: profile.rankedGames };
};

/**
 * Beat Rookie once, which is what opens Pro.
 *
 * Through the real route rather than by writing achievements: the ladder is
 * walked, and a test that grants a rung by hand stops proving that the rung
 * the relay accepts is one the player actually earned.
 */
async function unlockPro(device: Device): Promise<void> {
  await fetch(`${base}/api/match/record`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: device.cookie },
    body: JSON.stringify({
      playerId: device.id,
      mode: 'solo',
      difficulty: 'rookie',
      isWinner: true,
      playerScore: 3,
      opponentScore: 1,
      bestStreak: 3,
      earnedStreak: 3,
      endStreak: 3,
      rules: {},
      matchKey: `unlock-${device.id}`,
    }),
  });
}

const record = (device: Device, body: Record<string, unknown>) =>
  fetch(`${base}/api/match/record`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: device.cookie },
    body: JSON.stringify({
      playerId: device.id,
      mode: 'solo',
      difficulty: 'pro',
      isWinner: true,
      playerScore: 3,
      opponentScore: 0,
      bestStreak: 5,
      earnedStreak: 5,
      endStreak: 5,
      rules: {},
      ...body,
    }),
  }).then((r) => r.json());

describe('a table with a CPU in it', () => {
  it('starts without a second person, because seating the CPU is the yes', async () => {
    // canStart is `players[0] && players[1] && ready[1]`, not
    // `ready[0] && ready[1]` — so a CPU that only set a ready flag would
    // satisfy one clause of four and Start would silently do nothing, with
    // matchSeq never advancing and no watcher ever reaching the court.
    const host = await newDevice('CpuHost1');
    const { phone } = await seatCpu(host);
    phone.clear();
    phone.send({ type: 'start_match' });
    const start = await phone.await('game_start');
    expect(start.matchSeq).toBe(1);
    expect((start.config as any).cpu).toBe('pro');
    phone.close();
  }, 20_000);

  it('starts a SECOND match on one vote, or Play Again could never work', async () => {
    // Without this the room stays matchOver at the final score forever:
    // point_scored is refused, every watcher sees a frozen scoreboard, and
    // the most common thing a solo player does is broken.
    const host = await newDevice('CpuHost2');
    const { phone } = await seatCpu(host);
    phone.send({ type: 'start_match' });
    await phone.await('game_start');
    // The score rides on cpu_frame, not point_scored — that handler requires
    // two seated humans and is right to, since a crossing from a lone socket
    // is not a rally. This is the relay learning the match is over.
    phone.send({
      type: 'cpu_frame',
      hostPaddle: 0.5,
      cpuPaddle: 0.5,
      ball: null,
      scores: [3, 0],
      live: false,
    });
    await sleep(50);
    phone.clear();
    phone.send({ type: 'rematch_request' });
    const again = await phone.await('game_start');
    expect(again.matchSeq).toBe(2);
    phone.close();
  }, 20_000);

  it('refuses a host trying to sit in the CPU’s chair', async () => {
    // swap_seat reads room.players[target], and the CPU is not in `players`.
    // Unfixed, the host shares the chair, becomes playerIndex 1 — so every
    // host-only guard then refuses the only person at the table — and the CPU
    // can never be removed.
    const host = await newDevice('CpuHost3');
    const { phone } = await seatCpu(host);
    phone.clear();
    phone.send({ type: 'swap_seat', seat: 1 });
    const err = await phone.await('error');
    expect(err.code).toBe('SEAT_TAKEN');
    phone.close();
  }, 20_000);

  it('lets a human take the CPU’s seat between matches, and not during one', async () => {
    const host = await newDevice('CpuHost4');
    const walkUp = await newDevice('WalkUp4');
    const { phone, roomId } = await seatCpu(host, { winningScore: 3 });
    phone.send({ type: 'start_match' });
    await phone.await('game_start');
    // Mid-match: refused, so the browser can offer Watch instead.
    phone.send({ type: 'cpu_frame', hostPaddle: 0.5, cpuPaddle: 0.5, ball: null, scores: [1, 0], live: true });
    const guest = await relay.openPhone(walkUp);
    guest.send({ type: 'join_room', roomId, playerId: walkUp.id });
    const refused = await guest.await('error');
    expect(refused.code).toBe('ROOM_FULL');

    // Between matches: the CPU gives up its chair.
    phone.send({ type: 'cpu_frame', hostPaddle: 0.5, cpuPaddle: 0.5, ball: null, scores: [3, 0], live: false });
    guest.clear();
    guest.send({ type: 'join_room', roomId, playerId: walkUp.id });
    const joined = await guest.await('room_joined');
    expect(joined.playerIndex).toBe(1);
    const config = await guest.await('room_config');
    expect((config.config as any).cpu).toBeNull();
    phone.close();
    guest.close();
  }, 25_000);
});

describe('what a CPU match is worth', () => {
  it('moves the ladder at a table nobody may watch', async () => {
    const host = await newDevice('CpuRated1');
    await unlockPro(host);
    const { phone, roomId } = await seatCpu(host, { spectators: false });
    phone.send({ type: 'start_match' });
    await phone.await('game_start');
    const before = await rankOf(host);
    const result = await record(host, { roomId, matchSeq: 1, matchKey: 'cpu-rated-1' });
    expect(result.error).toBeUndefined();
    const after = await rankOf(host);
    expect(after.rankedGames).toBe(before.rankedGames + 1);
    phone.close();
  }, 25_000);

  it('does NOT move the ladder at a table whose watching seats are open', async () => {
    const host = await newDevice('CpuWatched1');
    await unlockPro(host);
    const { phone, roomId } = await seatCpu(host, { spectators: true });
    phone.send({ type: 'start_match' });
    await phone.await('game_start');
    const before = await rankOf(host);
    const result = await record(host, { roomId, matchSeq: 1, matchKey: 'cpu-watched-1' });
    expect(result.error).toBeUndefined();
    const after = await rankOf(host);
    // XP still paid — every match is progression — but the visible ladder
    // stands still, because a watcher sees the hidden half and only one side
    // here has a rating at stake.
    expect(after.rankedGames).toBe(before.rankedGames);
    phone.close();
  }, 25_000);

  it('refuses a table that has no CPU in it, however watched', async () => {
    // The seat clause alone is not enough: a player sitting at an ordinary
    // two-human table with its watching seats open holds a real seat at a
    // real room, so without asking what the table actually IS, every solo
    // match they report while parked there would come back unranked.
    const host = await newDevice('CpuNoCpu1');
    const guest = await newDevice('CpuNoCpu2');
    await unlockPro(host);

    const p1 = await relay.openPhone(host);
    p1.send({
      type: 'create_room',
      playerId: host.id,
      config: { winningScore: 3, rules: {}, spectators: true },
    });
    const created = await p1.await('room_created');
    const p2 = await relay.openPhone(guest);
    p2.send({ type: 'join_room', roomId: created.roomId, playerId: guest.id });
    await p2.await('room_joined');
    p2.send({ type: 'player_ready', ready: true });
    await p1.await('ready_state');
    p1.send({ type: 'start_match' });
    await p1.await('game_start');

    const before = await rankOf(host);
    await record(host, { roomId: created.roomId, matchSeq: 1, matchKey: 'cpu-nocpu-1' });
    const after = await rankOf(host);
    expect(after.rankedGames).toBe(before.rankedGames + 1);
    p1.close();
    p2.close();
  }, 30_000);

  it('refuses to read a table the caller does not sit at', async () => {
    // The one-way ratchet this vouch exists to stop: win and POST with your
    // own table, lose and POST with the id of any table whose seats are open
    // — or one you created privately a moment earlier — and take no rating
    // hit. `roomId` on a solo payload is a client-chosen string and the relay
    // writes no second copy of the match to check it against.
    const host = await newDevice('CpuRatchet1');
    const bystander = await newDevice('CpuRatchet2');
    await unlockPro(host);

    // A watched table belonging to SOMEBODY ELSE.
    const other = await seatCpu(bystander, { spectators: true });
    other.phone.send({ type: 'start_match' });
    await other.phone.await('game_start');

    // Our own honest match, at our own unwatched table.
    const mine = await seatCpu(host, { spectators: false });
    mine.phone.send({ type: 'start_match' });
    await mine.phone.await('game_start');

    const before = await rankOf(host);
    // Naming the stranger's watched table must not buy an unranked loss.
    await record(host, {
      roomId: other.roomId,
      matchSeq: 1,
      matchKey: 'cpu-ratchet-1',
      isWinner: false,
      playerScore: 0,
      opponentScore: 3,
    });
    const after = await rankOf(host);
    expect(after.rankedGames).toBe(before.rankedGames + 1);
    expect(after.rankMu).toBeLessThan(before.rankMu);
    mine.phone.close();
    other.phone.close();
  }, 30_000);
});
