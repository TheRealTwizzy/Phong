import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Relay, startRelay } from './helpers/relay';

// "They were not only unable to join the lobby, they got signed out and their
//  account still exists but they lost access somehow."
//
// An invitation link is the one way into Phong that gets tapped from ANOTHER
// app — a chat, a QR scanner — so it is the one that routinely opens in a
// browser that is not the one holding the player's account. There the server
// cannot tell an established player from a first-time visitor: onboarding
// opens, and their own username comes back taken, by themselves.
//
// Everything after that used to run one way. Restoring the account into the
// throwaway browser RELEASED the real one, and the wall a released device gets
// offered exactly one button: "start as a new player". That button mints a new
// device identity, so the account it leaves behind is reachable by nobody, and
// its username can never be claimed again. A single-button wall is not a
// choice, and the reset deleted the release record on its way out, so the
// account was not merely unreachable — it was untraceable.
//
// This suite pins the way back.

let relay: Relay;
let base: string;

beforeAll(async () => {
  relay = await startRelay('account-recovery');
  base = relay.base;
}, 40000);

afterAll(async () => {
  await relay?.stop();
});

/** A browser's cookie jar: newest value of each name, and removals honoured. */
class Jar {
  private cookies = new Map<string, string>();
  absorb(res: Response): void {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const pair = raw.split(';')[0];
      const name = pair.slice(0, pair.indexOf('='));
      const value = pair.slice(pair.indexOf('=') + 1);
      if (/(^|;\s*)Max-Age=0(;|$)/i.test(raw) || value === '') this.cookies.delete(name);
      else this.cookies.set(name, pair);
    }
  }
  get header(): string {
    return [...this.cookies.values()].join('; ');
  }
  has(name: string): boolean {
    return this.cookies.has(name);
  }
}

async function call(jar: Jar, route: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${route}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', cookie: jar.header, ...(init.headers || {}) },
  });
  jar.absorb(res);
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, body };
}

/** A browser that has opened the app and locked in a username. */
async function onboard(username: string): Promise<Jar> {
  const jar = new Jar();
  await call(jar, '/api/session', { method: 'POST' });
  const res = await call(jar, '/api/profile/initialize', {
    method: 'POST',
    body: JSON.stringify({ username }),
  });
  expect(res.status).toBe(200);
  return jar;
}

/** A browser that has a session but no username — what an invitee looks like. */
async function freshBrowser(): Promise<Jar> {
  const jar = new Jar();
  await call(jar, '/api/session', { method: 'POST' });
  return jar;
}

const recoveryCode = async (jar: Jar): Promise<string> =>
  (await call(jar, '/api/profile/me')).body.recoveryCode;

/**
 * Read the live server's own database. Read-only, and only for the one fact
 * that has no HTTP surface: whether a release was recorded or forgotten.
 */
function releasedRow(deviceId: string): { movedToPlayerId: string } | undefined {
  const file = path.join(relay.dataDir, 'phong.db');
  expect(fs.existsSync(file)).toBe(true);
  const sql = new DatabaseSync(file, { readOnly: true });
  try {
    return sql
      .prepare('SELECT movedToPlayerId FROM released_devices WHERE deviceId = ?')
      .get(deviceId) as { movedToPlayerId: string } | undefined;
  } finally {
    sql.close();
  }
}

describe('an account belongs to every browser that has signed in to it', () => {
  it('signing in elsewhere no longer costs the browser you play in', async () => {
    // A cookie jar does not cross browsers, and the web offers no device
    // identifier to bridge them — so an invitation tapped in a chat app opens
    // a webview the server cannot tell from a stranger. That part is not
    // fixable. The consequence was: signing in used to TRANSFER, tombstoning
    // the browser left behind as `released`, whose wall offered exactly one
    // irreversible button.
    const home = await onboard('HomeBrowser1');
    const code = await recoveryCode(home);

    const webview = await freshBrowser();
    // Their own name reads as taken. By them.
    const check = await call(webview, `/api/username-check?u=HomeBrowser1`);
    expect(check.body).toMatchObject({ valid: true, available: false });

    expect(
      (await call(webview, '/api/profile/claim', { method: 'POST', body: JSON.stringify({ code }) })).status
    ).toBe(200);
    expect((await call(webview, '/api/profile/me')).body.username).toBe('HomeBrowser1');

    // The browser they actually play in is evicted — the concurrency rule is
    // untouched — but it is a MEMBER of the account now, not a stranger.
    expect((await call(home, '/api/session')).body.status).toBe('superseded');

    // And a member takes the account back with no code at all: the code is
    // what gets a browser into the set, not what it presents every time after.
    const back = await call(home, '/api/session', { method: 'POST' });
    expect(back.status).toBe(200);
    expect(back.body.profile.username).toBe('HomeBrowser1');
    expect((await call(home, '/api/profile/me')).body.username).toBe('HomeBrowser1');

    // Signing in does not spend the code — a player keeps it.
    expect(await recoveryCode(home)).toBe(code);

    // Still exactly one holder at a time; the webview now asks for its turn.
    expect((await call(webview, '/api/session')).body.status).toBe('superseded');
  }, 30000);

  it('will not sign in over an account this browser already holds', async () => {
    // players.id IS a device id, so an incoming account has to take this
    // browser's row. Silently deleting an initialized one would be losing an
    // account — the exact thing this endpoint exists to prevent.
    const mine = await onboard('AlreadyMine1');
    const theirs = await onboard('SomebodyElse1');
    const theirCode = await recoveryCode(theirs);

    const refused = await call(mine, '/api/profile/claim', {
      method: 'POST',
      body: JSON.stringify({ code: theirCode }),
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('BROWSER_HAS_ACCOUNT');
    expect((await call(mine, '/api/profile/me')).body.username).toBe('AlreadyMine1');
    expect((await call(theirs, '/api/profile/me')).body.username).toBe('SomebodyElse1');
  }, 30000);

  it('no longer tombstones a browser for signing in somewhere else', async () => {
    // `released` is legacy from here on: signing in links both browsers, so
    // nothing writes a new release row. The path and its non-destructive exit
    // are kept for databases that already carry them, and `session/reset` no
    // longer deletes the record — it is the only trace that a browser held an
    // account and where it went.
    const home = await onboard('NoTombstone1');
    const homeDevice = (await call(home, '/api/session')).body.deviceId as string;
    const code = await recoveryCode(home);
    const elsewhere = await freshBrowser();
    await call(elsewhere, '/api/profile/claim', { method: 'POST', body: JSON.stringify({ code }) });

    expect(releasedRow(homeDevice)).toBeUndefined();
    expect((await call(home, '/api/session')).body.status).toBe('superseded');
  }, 30000);
});

describe('a reusable code is a credential, so guessing it is bounded', () => {
  it('locks out repeated wrong codes', async () => {
    // The code used to rotate the moment it was spent, so guessing it was a
    // race against a moving target. It is a credential the player KEEPS now —
    // that is what makes signing in on a second browser work at all — and the
    // search runs against every account at once, so the attempts are counted.
    const guesser = await freshBrowser();
    let sawLimit = false;
    for (let i = 0; i < 14; i++) {
      const res = await call(guesser, '/api/profile/claim', {
        method: 'POST',
        body: JSON.stringify({ code: `ZZZ${String(i).padStart(2, '0')}-ZZZZ` }),
      });
      if (res.status === 429) {
        expect(res.body.error).toBe('TOO_MANY_ATTEMPTS');
        sawLimit = true;
        break;
      }
      expect(res.status).toBe(404);
    }
    expect(sawLimit).toBe(true);
  }, 30000);

  it('rotating retires the old code and keeps the account', async () => {
    const jar = await onboard('RotateMine1');
    const before = await recoveryCode(jar);
    const rotated = await call(jar, '/api/profile/me/recovery-code', { method: 'POST' });
    expect(rotated.status).toBe(200);
    expect(rotated.body.recoveryCode).not.toBe(before);
    expect(await recoveryCode(jar)).toBe(rotated.body.recoveryCode);
    // The account is untouched by its credential changing.
    expect((await call(jar, '/api/profile/me')).body.username).toBe('RotateMine1');
  }, 30000);
});

describe('one page load mints one device identity', () => {
  it('establishes the device cookie on the navigation, before any API call', async () => {
    // `deviceIdentity` used to be mounted on /api alone, so the HTML document
    // set no cookie and the booting client's first API calls minted it. Those
    // calls are concurrent — the session mint and the heartbeat's first tick
    // both fire on mount — and on anything slower than localhost several are
    // in flight before any has come back, so each arrives with no cookie and
    // mints its OWN identity. Measured in a browser at 250ms latency: three
    // device identities per page load, the browser keeping whichever Set-Cookie
    // landed last. A player who onboards inside that window locks their
    // username to the identity the cookie is about to stop being: the next
    // profile read is uninitialized, onboarding re-opens, and the name they
    // just chose is taken — by themselves, seconds earlier.
    const doc = await fetch(`${base}/?room=ZZZZ`, { headers: { accept: 'text/html' } });
    const ids = (doc.headers.getSetCookie?.() ?? [])
      .map((c) => /phong_device=v1\.(dev_[0-9a-f]+)/.exec(c)?.[1])
      .filter(Boolean);
    expect(ids).toHaveLength(1);

    // And with that cookie in hand, a whole boot burst mints nothing further —
    // which is the point: the navigation always precedes the JS it delivers.
    const jar = new Jar();
    jar.absorb(doc);
    const burst = await Promise.all(
      ['/api/session', '/api/profile/me', '/api/leaderboard', '/api/achievements', '/api/missions'].map(
        (route) => fetch(`${base}${route}`, { headers: { cookie: jar.header } })
      )
    );
    const reminted = burst.flatMap((r) => (r.headers.getSetCookie?.() ?? []).filter((c) => c.startsWith('phong_device=')));
    expect(reminted).toEqual([]);
  }, 30000);

  it('shows why: cookieless API calls each mint an identity of their own', async () => {
    // Not a bug being asserted — the hazard the test above exists to keep the
    // client away from. A request with no device cookie must mint one; there
    // is nothing else it could do. What had to change is that a browser never
    // makes several of them at once.
    const cookieless = await Promise.all(
      ['/api/session', '/api/profile/me', '/api/leaderboard'].map((route) =>
        fetch(`${base}${route}`, { method: route === '/api/session' ? 'POST' : 'GET' })
      )
    );
    const minted = new Set(
      cookieless
        .flatMap((r) => r.headers.getSetCookie?.() ?? [])
        .map((c) => /phong_device=v1\.(dev_[0-9a-f]+)/.exec(c)?.[1])
        .filter(Boolean)
    );
    expect(minted.size).toBeGreaterThan(1);
  }, 30000);
});

describe('one tab closing cannot sign another one out', () => {
  it('ignores a handback that names a session the caller no longer holds', async () => {
    // `phong_session` is an ORIGIN cookie, so two tabs on one phone present
    // the same value and the server cannot tell them apart. A closing tab used
    // to hand back whatever the cookie held — which, with two tabs open, is
    // the session the OTHER tab just minted — and cleared the shared cookie
    // with it. The live tab's next request then carried no session, the relay
    // refused its socket at the upgrade, and a join in flight died.
    const jar = await onboard('TwoTabsOne01');
    const tabA = (await call(jar, '/api/session', { method: 'POST' })).body.sessionId as string;
    const tabB = (await call(jar, '/api/session', { method: 'POST' })).body.sessionId as string;
    expect(tabA).not.toBe(tabB);

    // Tab A goes away and hands back the session IT was given.
    const end = await call(jar, '/api/session/end', {
      method: 'POST',
      body: JSON.stringify({ sessionId: tabA }),
    });
    expect(end.body.status).toBe('not_mine');

    // Tab B is untouched: still holding the account, still holding a cookie.
    expect(jar.has('phong_session')).toBe(true);
    const live = await call(jar, '/api/session');
    expect(live.body.status).toBe('active');
    expect(live.body.sessionId).toBe(tabB);
  }, 30000);

  it('still hands the account back when the caller does own the session', async () => {
    const jar = await onboard('LastTabOut01');
    const mine = (await call(jar, '/api/session', { method: 'POST' })).body.sessionId as string;
    const end = await call(jar, '/api/session/end', {
      method: 'POST',
      body: JSON.stringify({ sessionId: mine }),
    });
    expect(end.body.status).toBe('ended');
    // Nobody holds it now, which is what lets the next load take it without
    // being told the account is "playing elsewhere" against itself.
    expect((await call(jar, '/api/session')).body.status).toBe('none');
  }, 30000);
});
