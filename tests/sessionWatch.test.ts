import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientSessionStatus, SessionSnapshot } from '../src/net/session';

// The client half of "one account, one live device".
//
// The server half is drilled hard by tests/deviceSession.test.ts. This half —
// the heartbeat that makes an eviction land in seconds instead of at the final
// whistle — was called by no test at all.
//
// The rule most worth pinning here is a NEGATIVE one. CLAUDE.md §5 is
// emphatic: `offline` is not an eviction. A dropped heartbeat is a phone
// changing cells, and walling the player off for it would throw them out of a
// match every time they went through a tunnel. It would also be an easy
// mistake to make, because every other failure here does mean "stop".

let listeners: Record<string, ((...a: unknown[]) => void)[]>;
let visibility: 'visible' | 'hidden';
let reloads: number;

const fakeStorage = () => {
  const backing = new Map<string, string>();
  return {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
    clear: () => backing.clear(),
  };
};

function installDom() {
  listeners = {};
  visibility = 'visible';
  reloads = 0;
  const add = (type: string, fn: (...a: unknown[]) => void) => {
    (listeners[type] ||= []).push(fn);
  };
  const remove = (type: string, fn: (...a: unknown[]) => void) => {
    listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
  };
  (globalThis as any).document = {
    addEventListener: add,
    removeEventListener: remove,
    get visibilityState() {
      return visibility;
    },
  };
  (globalThis as any).window = {
    addEventListener: add,
    removeEventListener: remove,
    location: { reload: () => void reloads++ },
  };
  (globalThis as any).localStorage = fakeStorage();
  (globalThis as any).sessionStorage = fakeStorage();
}

const fire = (type: string) => (listeners[type] || []).forEach((fn) => fn());
const listenerCount = () =>
  Object.values(listeners).reduce((n, fns) => n + fns.length, 0);

const HEARTBEAT_MS = 15_000;

/** A server whose answer to GET /api/session the test can change mid-flight. */
function installServer() {
  const state = {
    reply: { status: 'active', sessionId: 's-1', build: 'b1' } as Record<string, unknown>,
    throwOnGet: false,
    gets: 0,
    posts: 0,
  };
  vi.stubGlobal('fetch', async (input: string, init?: { method?: string }) => {
    const method = init?.method || 'GET';
    if (method === 'POST') {
      state.posts++;
      return {
        ok: true,
        json: async () => ({ status: 'active', sessionId: state.reply.sessionId, profile: { id: 'p1' } }),
      };
    }
    state.gets++;
    if (state.throwOnGet) throw new TypeError('Failed to fetch');
    return { ok: true, json: async () => state.reply };
  });
  return state;
}

let session: typeof import('../src/net/session');

beforeEach(async () => {
  vi.useFakeTimers();
  installDom();
  vi.resetModules();
  session = await import('../src/net/session');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Let the pending fetch promises settle without advancing the clock. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('watchSession', () => {
  it('reports the first answer, then stays quiet while it does not change', async () => {
    const server = installServer();
    const seen: SessionSnapshot[] = [];
    const stop = session.watchSession((s) => seen.push(s));

    await settle();
    expect(seen.map((s) => s.status)).toEqual(['active']);

    // Four more heartbeats, same answer: the player is told once, not five
    // times. Anything downstream of this re-renders, and some of it is a wall.
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    }
    expect(server.gets).toBe(5);
    expect(seen.map((s) => s.status)).toEqual(['active']);
    stop();
  });

  it('reports the moment the answer does change', async () => {
    const server = installServer();
    const seen: ClientSessionStatus[] = [];
    const stop = session.watchSession((s) => seen.push(s.status));
    await settle();

    server.reply = { status: 'released', build: 'b1' };
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(seen).toEqual(['active', 'released']);
    stop();
  });

  it('calls a dropped heartbeat OFFLINE, never an eviction', async () => {
    // The rule that matters most: a phone in a tunnel keeps playing.
    const server = installServer();
    const seen: ClientSessionStatus[] = [];
    const stop = session.watchSession((s) => seen.push(s.status));
    await settle();

    server.throwOnGet = true;
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(seen).toEqual(['active', 'offline']);

    // And it is not one of the states that stops play.
    expect(session.isBlockingStatus('offline')).toBe(false);

    // It recovers by itself when the signal comes back — no reload, no wall.
    server.throwOnGet = false;
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(seen).toEqual(['active', 'offline', 'active']);
    expect(reloads).toBe(0);
    stop();
  });

  it('asks again the moment the tab comes back to the foreground', async () => {
    // The likeliest moment for the account to have moved while we were not
    // looking, and waiting up to 15s to find out is 15s of a match that will
    // not count.
    const server = installServer();
    const stop = session.watchSession(() => {});
    await settle();
    expect(server.gets).toBe(1);

    fire('visibilitychange');
    await settle();
    expect(server.gets).toBe(2);

    fire('focus');
    await settle();
    expect(server.gets).toBe(3);
    stop();
  });

  it('does not ask when the tab goes to the background', async () => {
    const server = installServer();
    const stop = session.watchSession(() => {});
    await settle();

    visibility = 'hidden';
    fire('visibilitychange');
    await settle();
    expect(server.gets).toBe(1);
    stop();
  });

  it('stops completely when torn down', async () => {
    // A heartbeat still running after the component is gone shows up as a
    // phantom eviction against a page that is no longer there.
    const server = installServer();
    const seen: ClientSessionStatus[] = [];
    const stop = session.watchSession((s) => seen.push(s.status));
    await settle();
    expect(listenerCount()).toBe(2);

    stop();
    expect(listenerCount()).toBe(0);

    const before = server.gets;
    server.reply = { status: 'released', build: 'b1' };
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    fire('visibilitychange');
    await settle();

    expect(server.gets).toBe(before);
    expect(seen).toEqual(['active']);
  });

  it('concludes SUPERSEDED when another tab on this device took the account', async () => {
    // The server sees one shared origin cookie and cannot tell two tabs apart,
    // so the older tab has to work it out: the session id it was handed is not
    // the one holding the account any more.
    const server = installServer();
    await session.openSession(); // this page is handed s-1
    server.reply = { status: 'active', sessionId: 's-2', build: 'b1' };

    const seen: ClientSessionStatus[] = [];
    const stop = session.watchSession((s) => seen.push(s.status));
    await settle();

    expect(seen).toEqual(['superseded']);
    expect(session.isBlockingStatus('superseded')).toBe(true);
    stop();
  });

  it('stays active when the id coming back is the one this page holds', async () => {
    installServer();
    await session.openSession();

    const seen: ClientSessionStatus[] = [];
    const stop = session.watchSession((s) => seen.push(s.status));
    await settle();
    expect(seen).toEqual(['active']);
    stop();
  });
});

describe('which states stop play', () => {
  it('walls off exactly the three where nothing would count', () => {
    // Enumerated rather than sampled: adding a status must be a decision about
    // this list, not an accident of where it happens to fall.
    const verdicts: Record<ClientSessionStatus, boolean> = {
      released: true,
      superseded: true,
      stale_build: true,
      active: false,
      offline: false,
      connecting: false,
      none: false,
    };
    for (const [status, blocked] of Object.entries(verdicts)) {
      expect(
        session.isBlockingStatus(status as ClientSessionStatus),
        `${status} should ${blocked ? '' : 'not '}stop play`
      ).toBe(blocked);
    }
    expect([...session.BLOCKING_STATUSES].sort()).toEqual(['released', 'stale_build', 'superseded']);
  });
});

describe('leaving the device', () => {
  it('takes a new identity, and reports the failure rather than pretending', async () => {
    const server = installServer();
    const taken = await session.resetDevice();
    expect(taken.status).toBe('active');
    expect(server.posts).toBe(1);

    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    expect((await session.resetDevice()).status).toBe('offline');
  });

  it('hands the account back on the way out, and survives being torn down', async () => {
    let sent: { url: string; init: any } | null = null;
    vi.stubGlobal('fetch', async (url: string, init: any) => {
      sent = { url, init };
      return { ok: true, json: async () => ({}) };
    });

    session.endSession();
    // keepalive, or the request is cancelled as the page unloads — which is
    // the only moment it is ever sent.
    expect(sent!.url).toBe('/api/session/end');
    expect(sent!.init.keepalive).toBe(true);

    vi.stubGlobal('fetch', () => {
      throw new Error('page is already gone');
    });
    expect(() => session.endSession()).not.toThrow();
  });
});

describe('refreshForBuild', () => {
  it('reloads onto the deployment being served, once per build', () => {
    expect(session.refreshForBuild('b2')).toBe(true);
    expect(reloads).toBe(1);
    // A reload loop is worse than an out-of-date tab.
    expect(session.refreshForBuild('b2')).toBe(false);
    expect(reloads).toBe(1);
    // A genuinely different build reloads again.
    expect(session.refreshForBuild('b3')).toBe(true);
    expect(reloads).toBe(2);
  });

  it('guards a missing build id like any other', () => {
    // An absent id used to be stored as the string "undefined" and compared
    // against the value `undefined`, so the guard against looping was exactly
    // the case that looped.
    expect(session.refreshForBuild(undefined)).toBe(true);
    expect(session.refreshForBuild(null)).toBe(false);
    expect(reloads).toBe(1);
  });
});
