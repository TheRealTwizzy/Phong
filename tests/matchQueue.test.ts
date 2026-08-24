import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MatchEndPayload } from '../src/types';

// The on-device match queue: the "no result is ever lost" guarantee.
//
// Recording a finished match used to be fire-and-forget, so a 403, a 500 or a
// dropped connection left the player on a victory screen with the match
// silently gone. What replaced it is a set of rules that are deliberately
// OPPOSITE per failure mode, and only one of them had a test:
//
//   unidentified  -> keep it; it can still be paid after re-onboarding
//   evicted       -> DROP it; replaying would credit whatever identity this
//                    browser ends up with for a match another account played
//   stale_build   -> keep it, THEN reload; the refresh must not cost the game
//   permanent     -> drop it; a 4xx is a verdict, replaying fails identically
//   needsSession  -> mint one in place and retry
//   anything else -> retry once, then park it
//
// flushPendingMatches/runFlush — the replay half — were called by no test at
// all, and the flush has divergent rules of its own plus a single-flight guard
// whose comment describes a real duplication bug.

const localStore = new Map<string, string>();
const sessionStore = new Map<string, string>();
let reloads = 0;

const fakeStorage = (backing: Map<string, string>) => ({
  getItem: (k: string) => backing.get(k) ?? null,
  setItem: (k: string, v: string) => void backing.set(k, v),
  removeItem: (k: string) => void backing.delete(k),
  clear: () => backing.clear(),
});

(globalThis as any).localStorage = fakeStorage(localStore);
(globalThis as any).sessionStorage = fakeStorage(sessionStore);
(globalThis as any).window = { location: { reload: () => void reloads++ } };

// Loaded fresh per test. Both matchRecord and session hold module state — a
// parked queue, an in-flight mint, the session id this page was handed — and a
// suite that shared it across cases would be order-dependent: a test that
// minted a session earlier changes whether a later one mints or merely
// re-checks. Resetting is cheaper than reasoning about that.
let postMatchRecord: typeof import('../src/net/matchRecord').postMatchRecord;
let flushPendingMatches: typeof import('../src/net/matchRecord').flushPendingMatches;
let pendingMatchCount: typeof import('../src/net/matchRecord').pendingMatchCount;

const QUEUE_KEY = 'phong_pending_matches';

const match = (key: string): MatchEndPayload =>
  ({
    playerId: 'dev_000000000000000000',
    username: 'Queued',
    playerScore: 5,
    opponentScore: 2,
    bestStreak: 7, endStreak: 0, earnedStreak: 7,
    mode: 'solo',
    isWinner: true,
    matchKey: key,
  }) as MatchEndPayload;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const ok = () => json(200, { xpGained: 60, newLevel: 2, achievements: [], missions: [] });

/** Everything currently parked on the device, in order. */
const queued = (): MatchEndPayload[] =>
  JSON.parse(localStore.get(QUEUE_KEY) || '[]').map((q: any) => q.payload);

/** Park matches directly, as an earlier session would have left them. */
const park = (...keys: string[]) =>
  localStore.set(
    QUEUE_KEY,
    JSON.stringify(keys.map((k) => ({ payload: match(k), queuedAt: 1 })))
  );

/**
 * A server with a scripted answer per request, and a record of what was asked.
 * `/api/session` always succeeds — minting is not what any of these cases are
 * testing, and a failing mint would mask the rule under test.
 */
function installServer(answers: (() => Response)[] | (() => Response)) {
  const record: string[] = [];
  const bodies: any[] = [];
  let n = 0;
  vi.stubGlobal('fetch', async (input: string, init?: { method?: string; body?: string }) => {
    const url = String(input);
    record.push(`${init?.method || 'GET'} ${url}`);
    if (url === '/api/match/record' && init?.body) bodies.push(JSON.parse(init.body));
    if (url === '/api/session') {
      return json(200, { status: 'active', sessionId: `s-${n}`, profile: { id: 'p1' } });
    }
    const answer = Array.isArray(answers) ? answers[Math.min(n, answers.length - 1)] : answers;
    n++;
    return answer();
  });
  return {
    record,
    bodies,
    posts: () => record.filter((r) => r.endsWith('/api/match/record')).length,
    mints: () => record.filter((r) => r === 'POST /api/session').length,
  };
}

beforeEach(async () => {
  localStore.clear();
  sessionStore.clear();
  reloads = 0;
  vi.unstubAllGlobals();
  vi.resetModules();
  ({ postMatchRecord, flushPendingMatches, pendingMatchCount } = await import(
    '../src/net/matchRecord'
  ));
});

describe('a match that does not land the first time', () => {
  it('keeps a match the server does not recognise the device for', async () => {
    // The device cookie stopped verifying (a wipe rotated the signing secret).
    // Not the player's fault and not permanent: once they re-onboard it can
    // still be paid.
    installServer(() => json(403, { error: 'PROFILE_NOT_INITIALIZED' }));
    const outcome = await postMatchRecord(match('m1'));
    expect(outcome).toEqual({ ok: false, reason: 'unidentified' });
    expect(pendingMatchCount()).toBe(1);
  });

  it('DROPS a match played under an account this device no longer holds', async () => {
    // The one case that must not be queued. Replaying it later would credit
    // whatever fresh identity this browser ends up with for somebody else's
    // match — the concurrent-account bug, arrived at from the other end.
    for (const error of ['DEVICE_RELEASED', 'SESSION_SUPERSEDED']) {
      localStore.clear();
      installServer(() => json(403, { error }));
      const outcome = await postMatchRecord(match('m-evicted'));
      expect(outcome).toEqual({ ok: false, reason: 'evicted' });
      expect(pendingMatchCount()).toBe(0);
    }
  });

  it('parks a match BEFORE reloading onto a newer deployment', async () => {
    const server = installServer(() =>
      json(401, { error: 'SESSION_STALE_BUILD', sessionStatus: 'stale_build', build: 'b2' })
    );
    const outcome = await postMatchRecord(match('m-stale'));

    expect(outcome.reason).toBe('stale_build');
    expect(reloads).toBe(1);
    // The order is the point: the refresh must not cost the player the game
    // they just finished, so the queue is written first and survives it.
    expect(pendingMatchCount()).toBe(1);
    // And it must NOT paper over the stale build by minting a session.
    expect(server.mints()).toBe(0);
  });

  it('drops a match the server refuses outright', async () => {
    // A locked difficulty, say. Replaying it fails identically forever.
    installServer(() => json(403, { error: 'DIFFICULTY_LOCKED' }));
    const outcome = await postMatchRecord(match('m-locked'));
    expect(outcome).toEqual({ ok: false, reason: 'rejected' });
    expect(pendingMatchCount()).toBe(0);
  });

  it('mints a session in place and retries, rather than queueing', async () => {
    // The common case on a fresh load: the match beats the session being
    // established. Recoverable without troubling the player.
    const server = installServer([() => json(401, { error: 'SESSION_REQUIRED' }), ok]);
    const outcome = await postMatchRecord(match('m-nosession'));

    expect(outcome.ok).toBe(true);
    expect(server.mints()).toBe(1);
    expect(server.posts()).toBe(2);
    expect(pendingMatchCount()).toBe(0);
  });

  it('retries a transient failure once, then parks it', async () => {
    const server = installServer(() => {
      throw new Error('network down');
    });
    const outcome = await postMatchRecord(match('m-flaky'));

    expect(outcome).toEqual({ ok: false, reason: 'queued' });
    expect(server.posts()).toBe(2);
    expect(pendingMatchCount()).toBe(1);
  }, 10000);

  it('recovers when the retry is the one that lands', async () => {
    const server = installServer([() => json(500, { error: 'boom' }), ok]);
    const outcome = await postMatchRecord(match('m-retry'));

    expect(outcome.ok).toBe(true);
    expect(server.posts()).toBe(2);
    expect(pendingMatchCount()).toBe(0);
  }, 10000);
});

describe('replaying what an earlier session parked', () => {
  it('posts every parked match and empties the queue', async () => {
    park('a', 'b', 'c');
    const server = installServer(ok);

    expect(await flushPendingMatches()).toBe(3);
    expect(server.posts()).toBe(3);
    expect(pendingMatchCount()).toBe(0);
  });

  it('does nothing, and asks nothing, when there is nothing parked', async () => {
    const server = installServer(ok);
    expect(await flushPendingMatches()).toBe(0);
    expect(server.posts()).toBe(0);
  });

  it('drops a refusal but keeps everything that might still land', async () => {
    park('permanent', 'transient');
    let call = 0;
    installServer(() => (call++ === 0 ? json(400, { error: 'BAD' }) : json(503, {})));

    expect(await flushPendingMatches()).toBe(0);
    // The 4xx is gone for good; the 503 waits for the next load.
    expect(queued().map((p) => p.matchKey)).toEqual(['transient']);
  });

  it('drops a parked match belonging to an account this device lost', async () => {
    park('not-ours');
    installServer(() => json(403, { error: 'DEVICE_RELEASED' }));

    await flushPendingMatches();
    expect(pendingMatchCount()).toBe(0);
  });

  it('KEEPS a parked match when there is no session yet, rather than retrying it', async () => {
    // The flush runs on load and can beat the session being minted. Unlike
    // postMatchRecord, it does not retry in place — it mints and leaves the
    // match for the next attempt, so one slow session cannot cost the queue.
    park('early');
    const server = installServer(() => json(401, { error: 'SESSION_REQUIRED' }));

    expect(await flushPendingMatches()).toBe(0);
    expect(pendingMatchCount()).toBe(1);
    expect(server.mints()).toBe(1);
    expect(server.posts()).toBe(1);
  });

  it('keeps a parked match across the reload onto a new build', async () => {
    park('mid-deploy');
    installServer(() =>
      json(401, { error: 'SESSION_STALE_BUILD', sessionStatus: 'stale_build', build: 'b9' })
    );

    await flushPendingMatches();
    expect(pendingMatchCount()).toBe(1);
    expect(reloads).toBe(1);
  });

  it('posts each match ONCE when two flushes race', async () => {
    // Both flushes would read the same queue and post every entry in it. Every
    // match carries an idempotency key so the second copy is recognised rather
    // than paid — but the second flush would still rewrite the queue from a
    // snapshot taken before the first emptied it, resurrecting matches that
    // had already landed.
    park('x', 'y');
    const server = installServer(ok);

    const [first, second] = await Promise.all([flushPendingMatches(), flushPendingMatches()]);

    expect(server.posts()).toBe(2);
    expect(first).toBe(2);
    expect(second).toBe(2); // the second caller joins the first, it does not re-run
    expect(pendingMatchCount()).toBe(0);
  });

  it('flushes again once the first one has finished', async () => {
    // The guard shares an IN-FLIGHT flush; it must not latch and block later
    // ones, or nothing parked after load would ever be replayed.
    park('one');
    const server = installServer(ok);
    await flushPendingMatches();

    park('two');
    expect(await flushPendingMatches()).toBe(1);
    expect(server.posts()).toBe(2);
  });
});

describe('a replay keeps its chain position', () => {
  it('sends chainId and runSeq unchanged when replaying a parked match', async () => {
    // Earlier design: runSeq was assigned per PAGE and stripped before a
    // replay, because a parked payload's number meant nothing once the page
    // that assigned it was gone. It is now assigned once, at event time, from
    // a counter PERSISTED in localStorage (src/net/runChain.ts) — so a parked
    // payload's chainId/runSeq are exactly as meaningful after a reload as
    // they were the moment the match ended, and a replay must send them
    // exactly as parked rather than stripping them.
    localStore.set(
      QUEUE_KEY,
      JSON.stringify([
        { payload: { ...match('stale'), chainId: 'chain_a', runSeq: 5 }, queuedAt: 1 },
      ])
    );
    const server = installServer(ok);

    expect(await flushPendingMatches()).toBe(1);
    expect(server.bodies).toHaveLength(1);
    expect(server.bodies[0].matchKey).toBe('stale');
    expect(server.bodies[0].chainId).toBe('chain_a');
    expect(server.bodies[0].runSeq).toBe(5);
    // The age still travels too; the two are independent signals.
    expect(server.bodies[0].clientNow).toBeTypeOf('number');
  });

  it('keeps chainId and runSeq on a live attempt and its retry', async () => {
    // A live write and its retry are the same write, decided once; both
    // attempts must report the same position in the chain.
    const server = installServer([() => json(500, {}), ok]);
    await postMatchRecord({ ...match('live'), chainId: 'chain_b', runSeq: 3 } as any);
    expect(server.bodies).toHaveLength(2);
    for (const body of server.bodies) {
      expect(body.chainId).toBe('chain_b');
      expect(body.runSeq).toBe(3);
    }
  });

  it('flushes with no gate parameter at all', async () => {
    // The gate this suite tested earlier is gone: ordering a replay against a
    // live write no longer needs to serialize them through one queue, because
    // a persisted, event-time seq compares correctly regardless of which
    // request's own round trip finishes first. flushPendingMatches takes
    // nothing now.
    park('solo');
    const server = installServer(ok);
    expect(await flushPendingMatches()).toBe(1);
    expect(server.posts()).toBe(1);
  });
});

describe('the queue cannot grow without bound', () => {
  it('keeps the most recent matches and forgets the oldest', async () => {
    // A device offline for a long time must not fill its storage quota with
    // matches; the newest are the ones worth keeping.
    installServer(() => json(403, { error: 'PROFILE_NOT_INITIALIZED' }));
    for (let i = 0; i < 25; i++) await postMatchRecord(match(`m${i}`));

    expect(pendingMatchCount()).toBe(20);
    expect(queued()[0].matchKey).toBe('m5');
    expect(queued().at(-1)!.matchKey).toBe('m24');
  });
});
