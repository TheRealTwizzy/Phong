import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Relay, startRelay, sleep } from './helpers/relay';

// Deleting your own account, from the bottom of Settings.
//
// The flow the player sees is two steps and no undo: their username typed
// exactly, then the reminder that this is permanent, answered with DELETE or
// BACK. Both steps live in a client, which is why the server checks the name
// again — a bare DELETE with no confirmation, or one carrying a near-miss,
// must not be the thing that spends an account.
//
// What the fast layer cannot state is everything that has to be true at the
// HTTP seam afterwards: that the session is spent, that the browser comes back
// as a NEW player rather than as a walled-off one, and that a second browser
// which had signed in is not left facing a wall about an account that exists
// nowhere. That last one is the failure mode this area keeps producing — a
// `device_links` row outliving what it points at resolves as `superseded`,
// which is a full-screen wall, and wipe_v1 shipped without dropping the table
// for exactly the same reason.

let relay: Relay;
let base: string;

beforeAll(async () => {
  relay = await startRelay('account-deletion');
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

const del = (jar: Jar, username: string) =>
  call(jar, '/api/profile/me', { method: 'DELETE', body: JSON.stringify({ username }) });

/** The live server's own database, read-only — for facts with no HTTP surface. */
function query<T>(sql: string, ...args: (string | number)[]): T[] {
  const file = path.join(relay.dataDir, 'phong.db');
  expect(fs.existsSync(file)).toBe(true);
  const raw = new DatabaseSync(file, { readOnly: true });
  try {
    return raw.prepare(sql).all(...args) as unknown as T[];
  } finally {
    raw.close();
  }
}

describe('the username is the confirmation, and it is checked here too', () => {
  it('refuses a name that differs only in case', async () => {
    // The step says "type it exactly". A forgiving compare on this side would
    // quietly turn the gate into a button with one more tap in front of it,
    // and the client would be the only thing holding the line.
    const jar = await onboard('CaseMatters');
    expect((await del(jar, 'casematters')).body.error).toBe('USERNAME_MISMATCH');
    expect((await del(jar, 'CASEMATTERS')).body.error).toBe('USERNAME_MISMATCH');
    expect((await del(jar, ' CaseMatters')).body.error).toBe('USERNAME_MISMATCH');
    expect((await del(jar, 'CaseMatters ')).body.error).toBe('USERNAME_MISMATCH');
    expect((await del(jar, '')).status).toBe(400);
    // Every one of those left the account exactly where it was.
    expect((await call(jar, '/api/profile/me')).body.username).toBe('CaseMatters');
  });

  it('refuses a request carrying no confirmation at all', async () => {
    const jar = await onboard('NoBodyHere');
    const res = await call(jar, '/api/profile/me', { method: 'DELETE' });
    expect(res.status).toBe(400);
    expect((await call(jar, '/api/profile/me')).body.username).toBe('NoBodyHere');
  });

  it('refuses a browser with no live session, and one with no account yet', async () => {
    // Every write in this app sits behind requireActiveSession; the one with
    // no undo is not the place to make an exception.
    const nobody = new Jar();
    expect((await del(nobody, 'Anyone')).status).toBe(401);

    const unclaimed = new Jar();
    await call(unclaimed, '/api/session', { method: 'POST' });
    const me = await call(unclaimed, '/api/profile/me');
    expect(me.body.initialized).toBe(false);
    // A placeholder profile has nothing to delete and no name to type at it.
    expect((await del(unclaimed, me.body.username)).status).toBe(403);
  });
});

describe('deleting takes the account and everything it reached', () => {
  it('frees the name, spends the session, and leaves a NEW player behind', async () => {
    const jar = await onboard('GoingAway');
    const before = await call(jar, '/api/profile/me');
    expect(before.body.initialized).toBe(true);

    const gone = await del(jar, 'GoingAway');
    expect(gone.status).toBe(200);
    expect(gone.body).toMatchObject({ deleted: true, username: 'GoingAway' });
    // The session named an account that no longer exists, so it is dropped.
    expect(jar.has('phong_session')).toBe(false);

    // The device cookie is untouched — this is still the same browser. It is
    // simply a browser with no account, which is a NEW player and not a
    // walled-off one: nothing here may resolve to `released` or `superseded`,
    // whose walls are about an account that is alive somewhere else.
    expect(jar.has('phong_device')).toBe(true);
    const session = await call(jar, '/api/session');
    expect(['none', 'active']).toContain(session.body.status);

    const after = await call(jar, '/api/profile/me');
    expect(after.status).toBe(200);
    expect(after.body.initialized).toBe(false);
    expect(after.body.recoveryCode).not.toBe(before.body.recoveryCode);

    // The name is back in the pool, and this browser can take it again.
    expect((await call(jar, '/api/username-check?u=GoingAway')).body).toMatchObject({
      valid: true,
      available: true,
    });
    await call(jar, '/api/session', { method: 'POST' });
    expect(
      (await call(jar, '/api/profile/initialize', { method: 'POST', body: JSON.stringify({ username: 'GoingAway' }) }))
        .status
    ).toBe(200);
  });

  it('lets somebody ELSE claim the freed name', async () => {
    const mine = await onboard('Recyclable');
    expect((await del(mine, 'Recyclable')).status).toBe(200);

    const stranger = new Jar();
    await call(stranger, '/api/session', { method: 'POST' });
    const claimed = await call(stranger, '/api/profile/initialize', {
      method: 'POST',
      body: JSON.stringify({ username: 'Recyclable' }),
    });
    expect(claimed.status).toBe(200);
    expect(claimed.body.username).toBe('Recyclable');
  });

  it('does not wall off the other browsers the account belonged to', async () => {
    // The one that bites. players.id IS a device id, so signing in on a second
    // browser MOVES the row and records both as members. Delete the account
    // from either of them and a surviving device_links row points at nothing —
    // which resolveSession reads as "linked but not holding", i.e. `superseded`:
    // a full-screen wall telling this browser its account is live elsewhere,
    // about an account that is live nowhere.
    const home = await onboard('TwoBrowsers');
    const code = (await call(home, '/api/profile/me')).body.recoveryCode;

    const webview = new Jar();
    await call(webview, '/api/session', { method: 'POST' });
    expect(
      (await call(webview, '/api/profile/claim', { method: 'POST', body: JSON.stringify({ code }) })).status
    ).toBe(200);
    // The account now lives on the webview and `home` is a displaced member.
    expect((await call(home, '/api/session')).body.status).toBe('superseded');

    expect((await del(webview, 'TwoBrowsers')).status).toBe(200);

    // Neither browser is behind a wall, and neither is holding a link into a
    // deleted account.
    for (const jar of [home, webview]) {
      const status = (await call(jar, '/api/session')).body.status;
      expect(status).not.toBe('superseded');
      expect(status).not.toBe('released');
      const me = await call(jar, '/api/profile/me');
      expect(me.status).toBe(200);
      expect(me.body.initialized).toBe(false);
    }
    expect(query('SELECT deviceId FROM device_links').length).toBe(0);

    // And the code is spent with the account, not merely detached from it.
    const outsider = new Jar();
    await call(outsider, '/api/session', { method: 'POST' });
    expect(
      (await call(outsider, '/api/profile/claim', { method: 'POST', body: JSON.stringify({ code }) })).status
    ).toBe(404);
  });

  it('takes the relay socket with it', async () => {
    // The upgrade check refuses a NEW socket for a browser with no live
    // account, but an already-open one sails past it — and neither eviction
    // path covers a DELETE: seatStillHoldsAccount asks whether anything has
    // DISPLACED this seat, and after a delete nothing has, because the row is
    // simply gone. Left open, a phone goes on playing a duel the relay will
    // still try to record.
    const host = await relay.newDevice('SocketHost');
    const guest = await relay.newDevice('SocketGuest');
    const duel = await relay.seatDuel(host, guest);

    const jar = new Jar();
    // Reuse the cookie jar startRelay handed out for that device.
    for (const pair of host.cookie.split('; ').filter(Boolean)) {
      jar.absorb({
        headers: { getSetCookie: () => [pair] },
      } as unknown as Response);
    }
    expect((await del(jar, 'SocketHost')).status).toBe(200);

    for (let i = 0; i < 100 && duel.p1.ws.readyState < 2; i++) await sleep(20);
    expect(duel.p1.ws.readyState).toBeGreaterThanOrEqual(2); // CLOSING or CLOSED
    expect(duel.p1.last('session_invalid')).toBeTruthy();
    duel.p1.ws.close();
    duel.p2.ws.close();
  });
});
