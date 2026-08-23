import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WSClientMessage, WSServerMessage } from '../src/types';
import { transformBallForOpponent } from '../server/transform';
import { normalizeRoomConfig } from '../src/matchRules';
import { Relay, sleep, startRelay } from './helpers/relay';

// A P2P duel and a relayed duel must be the SAME match.
//
// src/net/p2p.ts re-implements the relay's room rules — scoring, serve
// rotation, the matchOver lock, rematch votes — because a DataChannel match
// never reaches the server. That duplication is deliberate and it is also the
// single largest correctness risk in the project: the two implementations have
// already drifted once, and every P2P duel was filed as a 0-0 loss for BOTH
// players until match_sync was added.
//
// Rather than assert the replica's rules from memory, this suite runs one
// identical script of client messages through BOTH transports and compares
// what each player is told. A rule changed on one side and not the other
// fails here, whichever side it was.
//
// Only the constructor of P2PGameLink touches WebRTC, so a small fake peer
// connection is enough to drive the whole class. Channel delivery is
// synchronous — determinism is worth more than realism for a rule comparison.

// ---------------------------------------------------------------- fake WebRTC

class FakeChannel {
  readyState: 'connecting' | 'open' | 'closed' = 'connecting';
  peer: FakeChannel | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public label: string) {}

  send(data: string): void {
    if (this.readyState !== 'open') throw new Error(`send on ${this.readyState} channel`);
    this.peer?.onmessage?.({ data });
  }
  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.onclose?.();
  }
  open(): void {
    this.readyState = 'open';
    this.onopen?.();
  }
}

class FakePeerConnection {
  connectionState = 'new';
  channels: Record<string, FakeChannel> = {};
  onicecandidate: ((ev: unknown) => void) | null = null;
  ondatachannel: ((ev: { channel: FakeChannel }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  createDataChannel(label: string): FakeChannel {
    const channel = new FakeChannel(label);
    this.channels[label] = channel;
    return channel;
  }
  async createOffer() {
    return { type: 'offer', sdp: 'fake-offer' };
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'fake-answer' };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  async addIceCandidate() {}
  close() {}
}

(globalThis as any).RTCPeerConnection = FakePeerConnection;

// Imported after the global exists — the module itself does not construct one
// at import time, but keeping the order explicit costs nothing.
const { P2PGameLink } = await import('../src/net/p2p');

const NAMES: [string, string] = ['Host', 'Guest'];

// The room's terms as the RELAY states them. In production the replica is fed
// the relay's room_config, which is always normalized — every rule filled in.
// Seeding the replica with a bare `{winningScore, rules:{}}` here would have
// the two transports disagree about the contents of game_start for a reason
// that never happens in the app.
const CONFIG = normalizeRoomConfig({ winningScore: 3 });

interface Side {
  link: InstanceType<typeof P2PGameLink>;
  got: WSServerMessage[];
  /**
   * Whatever the replica reports, in full — narrowing this to the fields a
   * test happened to need is how a new one goes unasserted.
   */
  syncs: Parameters<NonNullable<ConstructorParameters<typeof P2PGameLink>[0]['onMatchSync']>>[0][];
}

/** Two linked peers, channels open, seeded on match 1 exactly as game_start does. */
async function pairedPeers(): Promise<[Side, Side]> {
  const sides: Side[] = [];
  for (const myIndex of [0, 1] as const) {
    const got: WSServerMessage[] = [];
    const syncs: Side['syncs'] = [];
    const link = new P2PGameLink({
      myIndex,
      playerNames: NAMES,
      config: CONFIG,
      sendSignal: () => {},
      onMessage: (m) => got.push(m),
      onStatus: () => {},
      onMatchSync: (s) => syncs.push(s),
    });
    sides.push({ link, got, syncs });
  }
  const [a, b] = sides;

  // Host creates the channels; the guest receives them through ondatachannel,
  // which is the path adoptChannel is actually reached by on that side.
  await a.link.startAsHost();
  const aPc: FakePeerConnection = (a.link as any).pc;
  const bPc: FakePeerConnection = (b.link as any).pc;
  for (const label of ['game', 'fast']) {
    const aCh = aPc.channels[label];
    const bCh = new FakeChannel(label);
    bPc.channels[label] = bCh;
    aCh.peer = bCh;
    bCh.peer = aCh;
    bPc.ondatachannel?.({ channel: bCh });
  }
  for (const label of ['game', 'fast']) {
    aPc.channels[label].open();
    bPc.channels[label].open();
  }

  // The relay's game_start is what names match 1 and sets the server; both
  // replicas take it, exactly as App.tsx does.
  a.link.resetMatchState(0, 1);
  b.link.resetMatchState(0, 1);
  a.got.length = 0;
  b.got.length = 0;
  a.syncs.length = 0;
  b.syncs.length = 0;
  return [a, b];
}

// ------------------------------------------------------------------ the script

const BALL = { x: 0.3, vx: 0.4, vy: -0.9, spin: 0.25, speedMultiplier: 1.2 };

/**
 * One duel, expressed as client messages and who sent them. Deliberately
 * exercises everything the two implementations both own: crossings from both
 * directions, a decided match, the matchOver lock, and a two-vote rematch.
 */
const SCRIPT: { from: 0 | 1; msg: WSClientMessage }[] = [
  { from: 0, msg: { type: 'ball_cross_net', ball: BALL } },
  { from: 1, msg: { type: 'ball_cross_net', ball: { ...BALL, x: 0.7, vx: -0.2 } } },
  { from: 0, msg: { type: 'ball_cross_net', ball: { ...BALL, x: 0.5 } } },
  { from: 0, msg: { type: 'point_scored', scorer: 'p1' } },
  { from: 1, msg: { type: 'ball_cross_net', ball: { ...BALL, x: 0.1 } } },
  { from: 1, msg: { type: 'point_scored', scorer: 'p2' } },
  { from: 0, msg: { type: 'point_scored', scorer: 'p1' } },
  { from: 0, msg: { type: 'point_scored', scorer: 'p1' } }, // 3-1 — decides it
  { from: 0, msg: { type: 'rematch_request' } },
  { from: 1, msg: { type: 'rematch_request' } },
];

/** The message types both transports are responsible for producing. */
const COMPARED = ['ball_incoming', 'score_update', 'rematch_state', 'game_start'];
const compare = (msgs: WSServerMessage[]) => msgs.filter((m) => COMPARED.includes(m.type));

/**
 * How many compared messages a step produces across BOTH players.
 *
 * The relay is two sockets, so firing the script in a tight loop lets one
 * player's message overtake the other's and the points land in a different
 * order — which changes who serves next and makes the comparison
 * nondeterministic. Waiting for each step's own consequence before sending the
 * next is what pins the order. (The peers are synchronous and need none of
 * this, which is precisely why the relay is the side that has to be settled.)
 */
const stepYield = (msg: WSClientMessage): number => {
  if (msg.type === 'ball_cross_net') return 1; // ball_incoming, opponent only
  if (msg.type === 'point_scored') return 2; // score_update, both
  if (msg.type === 'rematch_request') return 2; // rematch_state, or game_start on the second
  return 0;
};

// ------------------------------------------------------------------- the suite

let relay: Relay;

beforeAll(async () => {
  relay = await startRelay('p2p-parity');
}, 40000);

afterAll(async () => {
  await relay?.stop();
});

describe('a P2P duel and a relayed duel are the same match', () => {
  it('tells both players exactly the same thing, message for message', async () => {
    // --- over a DataChannel
    const [a, b] = await pairedPeers();
    for (const step of SCRIPT) (step.from === 0 ? a : b).link.sendGame(step.msg);

    // --- over the relay
    const host = await relay.newDevice('Host');
    const guest = await relay.newDevice('Guest');
    const { p1, p2 } = await relay.seatDuel(host, guest, 3);
    p1.clear();
    p2.clear();
    let settled = 0;
    for (const step of SCRIPT) {
      (step.from === 0 ? p1 : p2).send(step.msg);
      settled += stepYield(step.msg);
      const deadline = Date.now() + 5000;
      while (compare(p1.received).length + compare(p2.received).length < settled) {
        if (Date.now() > deadline) {
          throw new Error(
            `relay stalled on ${step.msg.type}: ` +
              `${compare(p1.received).length + compare(p2.received).length}/${settled} messages`
          );
        }
        await sleep(10);
      }
    }

    expect(compare(p1.received)).toEqual(compare(a.got));
    expect(compare(p2.received)).toEqual(compare(b.got));

    // And the transports agree with each other about the result, not merely
    // with their own opposite number.
    const finalScore = (msgs: WSServerMessage[]) => {
      const scores = msgs.filter((m) => m.type === 'score_update') as any[];
      return scores.length ? [scores.at(-1).p1Score, scores.at(-1).p2Score] : null;
    };
    expect(finalScore(a.got)).toEqual([3, 1]);
    expect(finalScore(p1.received)).toEqual([3, 1]);

    p1.close();
    p2.close();
  }, 30000);
});

describe('the replica applies the relay rules it owns alone', () => {
  it('drops a rematch vote banked before the final point', async () => {
    const [a, b] = await pairedPeers();
    a.link.sendGame({ type: 'point_scored', scorer: 'p1' });
    a.got.length = 0;
    b.got.length = 0;

    // 1-0 in a first-to-3: the match is live, so the vote means nothing. The
    // relay ignores it for the same reason; both sides must, or one phone
    // restarts a match the other is still playing.
    a.link.sendGame({ type: 'rematch_request' });
    expect(a.got.filter((m) => m.type === 'rematch_state')).toEqual([]);
    expect(b.got.filter((m) => m.type === 'rematch_state')).toEqual([]);
    expect(a.got.filter((m) => m.type === 'game_start')).toEqual([]);
  });

  it('mirrors the ball with the same transform the relay uses', async () => {
    const [a, b] = await pairedPeers();
    a.link.sendGame({ type: 'ball_cross_net', ball: BALL });

    const incoming = b.got.find((m) => m.type === 'ball_incoming') as any;
    expect(incoming.ball).toEqual(transformBallForOpponent(BALL));
    // The sender does not receive its own ball back.
    expect(a.got.find((m) => m.type === 'ball_incoming')).toBeUndefined();
  });

  it('credits each crossing to the streak of the player who made it', async () => {
    const [a, b] = await pairedPeers();
    // A rally streak belongs to one player: their own consecutive returns,
    // never the opponent's. p1 serves, so p1's first ball opens the point
    // rather than continuing one and counts for nobody. After that the two
    // alternate, and each crossing is its sender's own return.
    a.link.sendGame({ type: 'ball_cross_net', ball: BALL }); // p1 serves
    b.link.sendGame({ type: 'ball_cross_net', ball: BALL }); // p2: 1
    a.link.sendGame({ type: 'ball_cross_net', ball: BALL }); // p1: 1
    b.link.sendGame({ type: 'ball_cross_net', ball: BALL }); // p2: 2
    a.link.sendGame({ type: 'ball_cross_net', ball: BALL }); // p1: 2
    b.link.sendGame({ type: 'ball_cross_net', ball: BALL }); // p2: 3
    // p1 takes the point, so p2 is the one who let it past.
    a.link.sendGame({ type: 'point_scored', scorer: 'p1' });

    // Both peers reach the same two numbers from the same events — which is
    // the whole point of the replica, and the thing that drifted before.
    expect(a.syncs.at(-1)!.bestStreaks).toEqual([2, 3]);
    expect(b.syncs.at(-1)!.bestStreaks).toEqual([2, 3]);
  });

  it('ends only the streak of the player who missed, and carries the other across the point', async () => {
    const [a, b] = await pairedPeers();
    a.link.sendGame({ type: 'ball_cross_net', ball: BALL }); // p1 serves
    b.link.sendGame({ type: 'ball_cross_net', ball: BALL }); // p2: 1
    a.link.sendGame({ type: 'ball_cross_net', ball: BALL }); // p1: 1
    a.link.sendGame({ type: 'point_scored', scorer: 'p1' }); // p2 let it past
    // p2 serves the next point, so p1's next ball is a genuine return — and it
    // CONTINUES the streak p1 already had. Winning a point was never a reason
    // to lose your own streak, which is exactly what the shared counter did to
    // both players every time either of them scored.
    b.link.sendGame({ type: 'ball_cross_net', ball: BALL }); // p2 serves
    a.link.sendGame({ type: 'ball_cross_net', ball: BALL }); // p1: 2
    b.link.sendGame({ type: 'ball_cross_net', ball: BALL }); // p2: 1
    // A point always reports, and the last one is what the match is recorded
    // from — but so does every crossing before it, so the relay is never more
    // than one event behind the rally.
    a.link.sendGame({ type: 'point_scored', scorer: 'p1' });
    expect(a.syncs.at(-1)!.bestStreaks).toEqual([2, 1]);
    expect(b.syncs.at(-1)!.bestStreaks).toEqual([2, 1]);
  });

  it('tells the relay about EVERY crossing, not just the first of the point', async () => {
    const [a] = await pairedPeers();
    a.link.sendGame({ type: 'ball_cross_net', ball: BALL });
    // The first still earns its report on its own — it is what puts the match
    // in play, which is what makes a walk-out an abandon and shuts the lobby's
    // settings.
    expect(a.syncs).toHaveLength(1);
    expect(a.syncs.at(-1)!.crossingsThisPoint).toBe(1);

    // And so does each one after it. This used to stop at one per point, on
    // the grounds that the rest would be "noise at 20Hz" — which confused this
    // with ball_pos. A crossing is one message per trip over the net, and the
    // relay is where the match gets RECORDED: a DataChannel dying mid-rally
    // hands the rest of the point back over the relay, which then resumes from
    // whatever it was last told. Stale, every return since is gone from the
    // streak, the XP and the daily tasks, and the point phase is wrong by the
    // same amount so the next relayed crossing is miscounted too.
    a.link.sendGame({ type: 'ball_cross_net', ball: BALL });
    expect(a.syncs).toHaveLength(2);
    expect(a.syncs.at(-1)!.crossingsThisPoint).toBe(2);
    expect(a.syncs.at(-1)!.bestStreaks).toEqual([1, 0]);
  });

  it('reports every point to the relay, the last one especially', async () => {
    const [a] = await pairedPeers();
    for (let i = 0; i < 3; i++) a.link.sendGame({ type: 'point_scored', scorer: 'p1' });
    // The relay records the finished duel onto both profiles from this.
    expect(a.syncs.map((s) => [s.p1Score, s.p2Score])).toEqual([
      [1, 0],
      [2, 0],
      [3, 0],
    ]);
    expect(a.syncs.every((s) => s.matchSeq === 1)).toBe(true);
  });

  it('clips a chat message to the same 100 characters the relay does', async () => {
    const [a, b] = await pairedPeers();
    a.link.sendGame({ type: 'quick_chat', text: 'x'.repeat(250) });
    const chat = b.got.find((m) => m.type === 'quick_chat') as any;
    expect(chat.text).toHaveLength(100);
    // And it is attributed to the sender, not to whoever the payload claims.
    expect(chat.senderIdx).toBe(0);
    expect(chat.senderName).toBe('Host');
  });

  it('numbers a locally agreed rematch so its result is a different match', async () => {
    const [a, b] = await pairedPeers();
    for (let i = 0; i < 3; i++) a.link.sendGame({ type: 'point_scored', scorer: 'p1' });
    a.link.sendGame({ type: 'rematch_request' });
    b.link.sendGame({ type: 'rematch_request' });

    // The relay never ran startMatch for this one, so the replica's own
    // numbering is the only thing that tells match 2's result from match 1's —
    // and duelMatchKey is built from it. Sharing a number would have the
    // second match recognised as a replay of the first and paid nothing.
    const restart = a.got.filter((m) => m.type === 'game_start').at(-1) as any;
    expect(restart.matchSeq).toBe(2);
    expect((b.got.filter((m) => m.type === 'game_start').at(-1) as any).matchSeq).toBe(2);
    // The other side opens this time. p1 took the last point, so p2 was left
    // serving; the rematch flips it back — the relay's own rule, replicated.
    expect(restart.servingPlayer).toBe(0);
  });
});
