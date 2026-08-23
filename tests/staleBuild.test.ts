import { beforeEach, describe, expect, it, vi } from 'vitest';

// The standing promise of this project is that an update force-refreshes
// session auth in the field. A finished match is the one request that can
// arrive from a bundle older than the deployment serving it — the player was
// mid-match when the deploy landed — so it is exactly where that promise is
// most easily broken, and was: SESSION_STALE_BUILD was classified as
// "recoverable in place", so the client minted a session under the NEW build,
// the retry succeeded, and the next heartbeat said `active`. The old bundle
// carried on indefinitely, talking a protocol nobody was serving any more.

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

const { postMatchRecord, pendingMatchCount } = await import('../src/net/matchRecord');

const payload = {
  playerId: 'dev_000000000000000000',
  username: 'Stale',
  playerScore: 5,
  opponentScore: 1,
  bestStreak: 4, endStreak: 0, earnedStreak: 4,
  mode: 'solo' as const,
  isWinner: true,
  matchKey: 'solo:stale-build',
};

const jsonError = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  localStore.clear();
  sessionStore.clear();
  reloads = 0;
});

describe('a match recorded from a bundle older than the deployment', () => {
  it('reloads onto the new build instead of quietly minting a session under it', async () => {
    const calls: string[] = [];
    (globalThis as any).fetch = vi.fn(async (url: string) => {
      calls.push(url);
      return jsonError(401, { error: 'SESSION_STALE_BUILD', sessionStatus: 'stale_build', build: 'abcdef012345' });
    });

    const outcome = await postMatchRecord(payload as any);

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('stale_build');
    expect(reloads).toBe(1);
    // The whole point: it must NOT paper over the stale build by minting a
    // fresh session and carrying on.
    expect(calls).not.toContain('/api/session');
    // And the match is kept, so the reload does not cost the player the game
    // they just finished — the queue survives it and replays.
    expect(pendingMatchCount()).toBe(1);
  });

  it('does not reload twice for the same build', async () => {
    (globalThis as any).fetch = vi.fn(async () =>
      jsonError(401, { error: 'SESSION_STALE_BUILD', sessionStatus: 'stale_build', build: 'abcdef012345' })
    );
    await postMatchRecord(payload as any);
    await postMatchRecord({ ...payload, matchKey: 'solo:stale-build-2' } as any);
    // A reload that lands on the same build again is a loop, not a refresh.
    expect(reloads).toBe(1);
  });

  it('still mints a session in place when there simply is not one', async () => {
    const calls: string[] = [];
    (globalThis as any).fetch = vi.fn(async (url: string) => {
      calls.push(url);
      if (url === '/api/session') {
        return new Response(JSON.stringify({ status: 'active', profile: { id: 'x' } }), { status: 200 });
      }
      // Refused once for want of a session, accepted on the retry that follows.
      return calls.filter((c) => c === '/api/match/record').length === 1
        ? jsonError(401, { error: 'SESSION_REQUIRED', sessionStatus: 'none' })
        : new Response(JSON.stringify({ earnedXp: 60 }), { status: 200 });
    });

    const outcome = await postMatchRecord(payload as any);

    expect(outcome.ok).toBe(true);
    expect(calls).toContain('/api/session');
    // Missing a session is not a stale build, and must not reload the page.
    expect(reloads).toBe(0);
    expect(pendingMatchCount()).toBe(0);
  });
});
