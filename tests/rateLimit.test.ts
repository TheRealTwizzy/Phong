import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Relay, startRelay } from './helpers/relay';
import {
  createRateLimit,
  limitSpent,
  noteAttempt,
  sweepExpired,
} from '../server/rateLimit';

// The limiter exists because three unauthenticated routes cost something
// PERMANENT per call — a players row, a username out of the pool, and an
// account-existence oracle — and until this shipped, exactly one route in the
// whole server was limited at all.
//
// `now` is a parameter rather than a clock, so every rule here is stated
// exactly rather than slept for.

const KEYS = ['d:dev_a', 'i:1.2.3.4'];
const T0 = 1_000_000;

describe('a fixed window', () => {
  it('allows exactly max attempts and refuses the next', () => {
    const state = createRateLimit(1000, 3);
    for (let i = 0; i < 3; i++) {
      expect(limitSpent(state, KEYS, T0)).toBe(false);
      noteAttempt(state, KEYS, T0);
    }
    expect(limitSpent(state, KEYS, T0)).toBe(true);
  });

  it('reopens once the window has closed', () => {
    const state = createRateLimit(1000, 1);
    noteAttempt(state, KEYS, T0);
    expect(limitSpent(state, KEYS, T0 + 999)).toBe(true);
    expect(limitSpent(state, KEYS, T0 + 1001)).toBe(false);
  });

  it('starts a fresh window rather than resuming a closed one', () => {
    // The bug this pins: treating an expired row as "n attempts already
    // spent" would let one old burst hold a key closed forever.
    const state = createRateLimit(1000, 2);
    noteAttempt(state, KEYS, T0);
    noteAttempt(state, KEYS, T0);
    noteAttempt(state, KEYS, T0 + 2000);
    expect(limitSpent(state, KEYS, T0 + 2000)).toBe(false);
  });

  it('goes on limiting after a window has closed once', () => {
    // The FAIL-OPEN direction, and the one that matters. An expired entry
    // has to be replaced rather than incremented: leave its `until` in the
    // past and the count climbs forever while limitSpent — which checks
    // expiry itself — answers false every time. The limiter would work for
    // exactly one window per key and then quietly stop, which is worse than
    // not having one, because nothing would ever say so.
    const state = createRateLimit(1000, 2);
    noteAttempt(state, KEYS, T0);
    noteAttempt(state, KEYS, T0);
    expect(limitSpent(state, KEYS, T0)).toBe(true);

    const later = T0 + 5000;
    noteAttempt(state, KEYS, later);
    noteAttempt(state, KEYS, later);
    expect(limitSpent(state, KEYS, later)).toBe(true);
  });
});

describe('the keys are independent', () => {
  it('counts an attempt against every key it is given', () => {
    // Not the first that matches. A caller is counted against their device
    // AND their IP, which is what makes the IP catch a burst of fresh
    // cookieless identities — every one of those has a different device key.
    const state = createRateLimit(1000, 2);
    noteAttempt(state, ['d:one', 'i:shared'], T0);
    noteAttempt(state, ['d:two', 'i:shared'], T0);
    expect(limitSpent(state, ['d:three', 'i:shared'], T0)).toBe(true);
    expect(limitSpent(state, ['d:three'], T0)).toBe(false);
  });

  it('does not let one device spend a shared IP alone', () => {
    // The mirror case, and the reason the device key is kept at all: one
    // phone behind a NAT must not lock out the building.
    const state = createRateLimit(1000, 4);
    for (let i = 0; i < 4; i++) noteAttempt(state, ['d:noisy', 'i:nat'], T0);
    expect(limitSpent(state, ['d:noisy'], T0)).toBe(true);
    expect(limitSpent(state, ['d:quiet', 'i:nat'], T0)).toBe(true);
    // ...but a different IP is untouched by any of it.
    expect(limitSpent(state, ['d:quiet', 'i:elsewhere'], T0)).toBe(false);
  });
});

describe('the map is bounded', () => {
  it('drops closed windows and keeps live ones', () => {
    // Without this the map is a slow leak keyed by attacker-chosen ids —
    // the same shape as the thing being defended against, one layer down.
    const state = createRateLimit(1000, 1);
    noteAttempt(state, ['old'], T0);
    noteAttempt(state, ['fresh'], T0 + 900);
    sweepExpired(state, T0 + 1500);
    expect([...state.hits.keys()]).toEqual(['fresh']);
  });
});

// ---------------------------------------------------------------------------
// And that a real route actually refuses.
//
// The rules above are pure; this is the wiring. It has to be deliberate,
// because the browser suites can no longer stumble into it: requests from
// 127.0.0.1 are exempt (server.ts explains why — the harness onboards 87
// accounts in twenty seconds, which is the attack shape, so no single ceiling
// permits the harness and refuses an attacker).
//
// `X-Forwarded-For` is what gets past that exemption, and it is not a trick:
// `trust proxy` is set to a hop count precisely so the single header entry a
// proxy writes becomes `req.ip`. Sending one directly is the same code path a
// real deployment takes, with this test standing in for Caddy.

describe('a route with a ceiling', () => {
  let relay: Relay;
  beforeAll(async () => {
    relay = await startRelay('ratelimit');
  }, 30_000);
  afterAll(async () => {
    await relay?.stop();
  });

  it('refuses a session mint once the window is spent, and only for that caller', async () => {
    const mint = (ip: string) =>
      fetch(`${relay.base}/api/session`, {
        method: 'POST',
        headers: { 'X-Forwarded-For': ip },
      });

    // The ceiling is 20/minute. Walk past it.
    let refusedAt = -1;
    for (let i = 0; i < 40; i++) {
      const res = await mint('203.0.113.7');
      if (res.status === 429) {
        refusedAt = i;
        expect(await res.json()).toEqual({ error: 'TOO_MANY_REQUESTS' });
        break;
      }
    }
    expect(refusedAt).toBeGreaterThan(0);

    // A different caller is untouched — the counter is per key, not global,
    // so one noisy address must not close the route for everybody.
    expect((await mint('198.51.100.9')).status).toBe(200);

    // And loopback still walks straight through, which is the exemption the
    // whole test suite depends on.
    expect((await fetch(`${relay.base}/api/session`, { method: 'POST' })).status).toBe(200);
  }, 30_000);
});
