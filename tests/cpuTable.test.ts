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
    // Rookie because this account has earned nothing else — roomConfigFor
    // clamps to the best earned rung, which the test below pins directly.
    const { phone } = await seatCpu(host, { cpu: 'rookie' });
    phone.clear();
    phone.send({ type: 'start_match' });
    const start = await phone.await('game_start');
    expect(start.matchSeq).toBe(1);
    expect((start.config as any).cpu).toBe('rookie');
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

  it('clamps a rung the host has not earned, at both doors', async () => {
    // The picker hides a locked rung and the picker is the CLIENT. Both the
    // create and the edit path go through roomConfigFor for exactly this
    // reason — a rule enforced at one of two doors is a rule you get past by
    // asking twice.
    const host = await newDevice('CpuLocked1');
    // Fresh account: rookie is open, everything above it is not.
    const { phone } = await seatCpu(host, { cpu: 'chaos' });
    const created = await phone.await('room_config');
    expect((created.config as any).cpu).toBe('rookie');

    phone.clear();
    phone.send({
      type: 'set_room_config',
      config: { winningScore: 3, rules: {}, spectators: false, cpu: 'cyber' },
    });
    const edited = await phone.await('room_config');
    expect((edited.config as any).cpu).toBe('rookie');
    phone.close();
  }, 20_000);

  it('will not seat a machine on top of a person', async () => {
    // canStart asks for an EMPTY opposite seat once a CPU is named, so a
    // config holding both wedges the table: Start refuses with no error and
    // no control to press.
    const host = await newDevice('CpuOnTop1');
    const guest = await newDevice('CpuOnTop2');
    const p1 = await relay.openPhone(host);
    p1.send({ type: 'create_room', playerId: host.id, config: { winningScore: 3, rules: {} } });
    const created = await p1.await('room_created');
    const p2 = await relay.openPhone(guest);
    p2.send({ type: 'join_room', roomId: created.roomId, playerId: guest.id });
    await p2.await('room_joined');

    p1.clear();
    p1.send({
      type: 'set_room_config',
      config: { winningScore: 3, rules: {}, spectators: false, cpu: 'rookie' },
    });
    const config = await p1.await('room_config');
    expect((config.config as any).cpu).toBeNull();

    // And the table still starts as the duel it is.
    p2.send({ type: 'player_ready', ready: true });
    await p1.await('ready_state');
    p1.send({ type: 'start_match' });
    await p1.await('game_start');
    p1.close();
    p2.close();
  }, 25_000);

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

describe('what a watcher sees of a CPU match', () => {
  // The asymmetric fixture is the whole point. `watched_*` is RAW — a watcher
  // draws that player's court in that player's own coordinates — and
  // `opponent_*` is PRE-MIRRORED, because it crosses the net. Against a
  // centred fixture a paddle at 0.5 looks identical either way, so a stray
  // `1 - x` would pass silently; every number below is picked so its mirror
  // is a different number.
  const HOST_PADDLE = 0.2;
  const CPU_PADDLE = 0.7;
  const BALL_X = 0.35;
  const BALL_Y = 0.6;

  it('draws each half raw and mirrors only what crosses the net', async () => {
    const host = await newDevice('CpuWatch1');
    const nearHost = await newDevice('CpuWatch2');
    const nearCpu = await newDevice('CpuWatch3');
    const { phone, roomId } = await seatCpu(host, { spectators: true, cpu: 'rookie' });
    phone.send({ type: 'start_match' });
    await phone.await('game_start');

    // Seat 2 sits beside the host (playing seat 0); seat 3 beside the CPU.
    const w0 = await relay.openPhone(nearHost);
    w0.send({ type: 'spectate_room', roomId, seat: 2 });
    await w0.await('table_state');
    const w1 = await relay.openPhone(nearCpu);
    w1.send({ type: 'spectate_room', roomId, seat: 3 });
    await w1.await('table_state');
    w0.clear();
    w1.clear();

    // The ball on the HOST's half.
    phone.send({
      type: 'cpu_frame',
      hostPaddle: HOST_PADDLE,
      cpuPaddle: CPU_PADDLE,
      ball: { side: 0, x: BALL_X, y: BALL_Y },
      scores: [1, 0],
      live: true,
    });

    // Beside the host: their own court raw, the CPU's paddle mirrored in.
    expect((await w0.await('watched_paddle')).x).toBeCloseTo(HOST_PADDLE, 6);
    expect((await w0.await('opponent_paddle')).x).toBeCloseTo(1 - CPU_PADDLE, 6);
    const ballHere = await w0.await('watched_ball');
    expect(ballHere.x).toBeCloseTo(BALL_X, 6);
    expect(ballHere.y).toBeCloseTo(BALL_Y, 6);

    // Beside the CPU: the CPU's court raw, the host's paddle mirrored in —
    // and the ball is NOT on this half, so it leaves and comes back as a
    // radar sample in the SENDER's frame, which the radar mirrors itself.
    expect((await w1.await('watched_paddle')).x).toBeCloseTo(CPU_PADDLE, 6);
    expect((await w1.await('opponent_paddle')).x).toBeCloseTo(1 - HOST_PADDLE, 6);
    expect(w1.all('watched_ball_left').length).toBe(1);
    expect(w1.last('watched_ball')).toBeUndefined();
    expect((await w1.await('opponent_ball')).x).toBeCloseTo(BALL_X, 6);

    phone.close();
    w0.close();
    w1.close();
  }, 30_000);

  it('clears the watcher’s ball whenever it is not on that half', async () => {
    // The CPU's SERVE materialises inside its own half and the CPU's MISS
    // ends past its baseline — neither is a crossing. A design that emitted
    // `watched_ball_left` only on a crossing would leave this watcher
    // dead-reckoning a ghost ball off the bottom of the screen after every
    // point, which is why the frame carries the ball's SIDE as a state.
    const host = await newDevice('CpuWatch4');
    const viewer = await newDevice('CpuWatch5');
    const { phone, roomId } = await seatCpu(host, { spectators: true, cpu: 'rookie' });
    phone.send({ type: 'start_match' });
    await phone.await('game_start');
    const w = await relay.openPhone(viewer);
    w.send({ type: 'spectate_room', roomId, seat: 2 });
    await w.await('table_state');
    w.clear();

    const frame = (ball: unknown) =>
      phone.send({
        type: 'cpu_frame',
        hostPaddle: HOST_PADDLE,
        cpuPaddle: CPU_PADDLE,
        ball,
        scores: [0, 0],
        live: true,
      });

    frame({ side: 0, x: BALL_X, y: BALL_Y });
    await w.await('watched_ball');
    // Gone entirely — the point ended and nothing is in play.
    frame(null);
    await w.await('watched_ball_left');
    // And with no ball there is no far-half sample either, or the radar would
    // go on drawing the last one it was sent.
    expect(w.all('opponent_ball').length).toBe(0);

    phone.close();
    w.close();
  }, 30_000);

  it('refuses the frame at a table with no CPU in it', async () => {
    // The guard is on the TABLE having a CPU, not on `playerIndex() !== null`
    // — copying the usual pattern is the natural mistake and it is
    // exploitable: at a real two-human duel seat 0 could otherwise inject a
    // ball onto seat 1's live court, clearing their serve and replacing the
    // ball so the point can never end.
    const host = await newDevice('CpuNoFrame1');
    const guest = await newDevice('CpuNoFrame2');
    const seated = await relay.seatDuel(host, guest);
    seated.p2.clear();
    seated.p1.send({
      type: 'cpu_frame',
      hostPaddle: HOST_PADDLE,
      cpuPaddle: CPU_PADDLE,
      ball: { side: 1, x: BALL_X, y: BALL_Y },
      scores: [2, 0],
      live: true,
    });
    await sleep(150);
    expect(seated.p2.all('ball_incoming').length).toBe(0);
    expect(seated.p2.all('opponent_paddle').length).toBe(0);
    expect(seated.p2.all('score_update').length).toBe(0);
    seated.p1.close();
    seated.p2.close();
  }, 30_000);
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
    // The stranger's table must be a genuine Pro table, or the difficulty
    // clause refuses this POST and the seat clause — the one under test —
    // never gets asked.
    await unlockPro(bystander);

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
