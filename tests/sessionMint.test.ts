import { beforeEach, describe, expect, it, vi } from 'vitest';

// One page load must hold ONE session.
//
// Minting a session supersedes the last one, and superseding closes every
// socket opened under it — including a relay socket in the middle of joining a
// room. A player following an invitation link therefore had their join dropped
// and was shown the "you are playing elsewhere" wall, against themselves.
//
// The module already guarded mints that OVERLAP, sharing one attempt between
// boot and the first heartbeat. What it did not guard was mints that arrive in
// SEQUENCE: boot mints one, and the match-record queue — flushed on load, which
// can beat the session being established — is answered SESSION_REQUIRED and
// mints another. Measured in a browser at roughly 7.5% of loads, which produced
// a lost invitation about one join in twenty.
//
// This is deliberately a unit test rather than an e2e assertion. The race is
// intermittent, so a browser check for it would catch a regression only some
// of the time — a flaky test is worse than none. The invariant underneath is
// not intermittent at all, and is what is pinned here.

type FetchCall = { url: string; method: string };

let calls: FetchCall[];
let activeSessionId: string;

/** A stand-in relay: POST mints a NEW id, GET reports whoever holds it now. */
function installFetch() {
  calls = [];
  activeSessionId = 'session-0';
  let minted = 0;
  vi.stubGlobal('fetch', async (input: string, init?: { method?: string }) => {
    const url = String(input);
    const method = init?.method || 'GET';
    calls.push({ url, method });
    if (url === '/api/session' && method === 'POST') {
      minted += 1;
      activeSessionId = `session-${minted}`;
      return {
        ok: true,
        json: async () => ({
          status: 'active',
          sessionId: activeSessionId,
          profile: { id: 'p1', username: 'Tester' },
        }),
      };
    }
    if (url === '/api/session' && method === 'GET') {
      return {
        ok: true,
        json: async () => ({ status: 'active', sessionId: activeSessionId, build: 'b1' }),
      };
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
}

const mints = () => calls.filter((c) => c.url === '/api/session' && c.method === 'POST').length;

describe('one page load, one session', () => {
  beforeEach(() => {
    vi.resetModules();
    installFetch();
  });

  it('mints once, however many callers ask for a session', async () => {
    const { openSession } = await import('../src/net/session');

    // Boot.
    const boot = await openSession();
    expect(boot.status).toBe('active');
    expect(mints()).toBe(1);

    // The match-record queue, answered SESSION_REQUIRED, asks again — and
    // again. Sequentially, so the in-flight guard does not cover them.
    await openSession();
    await openSession();

    expect(mints()).toBe(1);
  });

  it('still shares one attempt between overlapping callers', async () => {
    const { openSession } = await import('../src/net/session');
    await Promise.all([openSession(), openSession(), openSession()]);
    expect(mints()).toBe(1);
  });

  it('mints again when the account has genuinely been taken away', async () => {
    const { openSession } = await import('../src/net/session');
    await openSession();
    expect(mints()).toBe(1);

    // Another tab took it: the id the server reports is no longer ours.
    activeSessionId = 'session-from-another-tab';
    await openSession();

    // Taking it back is what a caller that needs a live session has always
    // done, and must keep doing.
    expect(mints()).toBe(2);
  });

  it('force mints unconditionally, for a deliberate take-back', async () => {
    const { openSession } = await import('../src/net/session');
    await openSession();
    expect(mints()).toBe(1);

    // The session wall's "play here instead".
    await openSession({ force: true });
    expect(mints()).toBe(2);
  });

  it('does not read the session while a mint is still in flight', async () => {
    // Boot mints; the heartbeat's first tick reads. Both fire on mount, so on
    // anything slower than localhost they are in flight TOGETHER — and back
    // when the device cookie was established by whichever API call landed
    // first, that meant two cookieless callers and two device identities for
    // one page load. The server side is closed by establishing the cookie on
    // the document navigation; this is the client's half.
    //
    // The assertion has to be about OVERLAP, not call order: openSession
    // issues its POST synchronously, so a plain index comparison is true
    // whether or not the read waits. What matters is whether the POST had
    // come back by the time the GET went out.
    let postsInFlight = 0;
    let readOverlappedAMint = false;
    vi.stubGlobal('fetch', async (input: string, init?: { method?: string }) => {
      const url = String(input);
      const method = init?.method || 'GET';
      calls.push({ url, method });
      if (url === '/api/session' && method === 'POST') {
        postsInFlight += 1;
        // A round trip, rather than a resolved promise: the whole failure
        // mode only exists because the mint takes time.
        await new Promise((r) => setTimeout(r, 25));
        postsInFlight -= 1;
        activeSessionId = 'session-1';
        return { ok: true, json: async () => ({ status: 'active', sessionId: activeSessionId, profile: { id: 'p1' } }) };
      }
      if (url === '/api/session' && method === 'GET') {
        if (postsInFlight > 0) readOverlappedAMint = true;
        return { ok: true, json: async () => ({ status: 'active', sessionId: activeSessionId, build: 'b1' }) };
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    const { openSession, probeSession } = await import('../src/net/session');
    await Promise.all([openSession(), probeSession()]);

    expect(readOverlappedAMint).toBe(false);
    expect(mints()).toBe(1);
  });
});
