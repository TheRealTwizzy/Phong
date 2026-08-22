import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { MatchEndPayload } from '../src/types';

// The reported exploit, reproduced against the REAL server, because every
// piece of it lives at the HTTP seam:
//
//   "I transferred my account to my desktop while staying logged into it on
//    my phone... played a full game on both the phone and PC, using the same
//    account. However, when the phone's match was complete, I was prompted to
//    immediately create a new account (as if I were only a guest)."
//
// What made that possible: transferring a profile RENAMES the player row's id
// to the claiming device's id, so the phone's cookie stopped matching any row
// — and `getProfile` mints a fresh, uninitialized profile for any id it has
// not seen. A device that had just handed its account away was therefore
// indistinguishable from a browser the server had never met. It was quietly
// issued a new empty profile, allowed to play a whole match under it, and
// only told at the final whistle, when the finished match was refused.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-session-test-'));
let server: ChildProcess;
let base: string;
let wsUrl: string;

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;
  server = spawn('npx', ['tsx', 'server.ts'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), DATA_DIR: TMP, NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {
      /* not listening yet */
    }
    await sleep(100);
  }
  throw new Error('server did not start');
}, 40000);

afterAll(async () => {
  if (server?.pid && server.exitCode === null) {
    const exited = new Promise<void>((resolve) => server.once('exit', () => resolve()));
    try {
      process.kill(-server.pid, 'SIGKILL');
    } catch {
      server.kill('SIGKILL');
    }
    await Promise.race([exited, sleep(3000)]);
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

/** A browser's cookie jar: newest value of each cookie name wins. */
class Jar {
  private cookies = new Map<string, string>();
  absorb(res: Response): void {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const pair = raw.split(';')[0];
      const name = pair.slice(0, pair.indexOf('='));
      const value = pair.slice(pair.indexOf('=') + 1);
      // An expiring cookie (Max-Age=0) is a removal, not a value.
      if (/(^|;\s*)Max-Age=0(;|$)/i.test(raw) || value === '') this.cookies.delete(name);
      else this.cookies.set(name, pair);
    }
  }
  get header(): string {
    return [...this.cookies.values()].join('; ');
  }
  get raw(): Map<string, string> {
    return this.cookies;
  }
}

async function call(jar: Jar, path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
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

/** A browser that has opened the app and onboarded. */
async function onboard(username: string): Promise<Jar> {
  const jar = new Jar();
  await call(jar, '/api/session', { method: 'POST' });
  const res = await call(jar, '/api/profile/initialize', {
    method: 'POST',
    body: JSON.stringify({ username }),
  });
  if (!res.body?.id) throw new Error(`onboarding failed: ${JSON.stringify(res.body)}`);
  return jar;
}

const soloWin = (key: string): MatchEndPayload =>
  ({
    playerScore: 10,
    opponentScore: 4,
    maxRally: 8,
    mode: 'solo',
    difficulty: 'rookie',
    isWinner: true,
    matchKey: key,
  }) as unknown as MatchEndPayload;

const record = (jar: Jar, key: string) =>
  call(jar, '/api/match/record', { method: 'POST', body: JSON.stringify(soloWin(key)) });

interface DialResult {
  message: any;
  closed: boolean;
  code: number;
}

/**
 * Open a relay socket with this jar's cookies. `opened` settles once the
 * socket is up OR the relay refused it at the upgrade; `outcome` reports what
 * finally became of it.
 *
 * The two are separate on purpose. A test about DISPLACEMENT has to know the
 * socket was actually accepted before ownership moves, or it races the
 * upgrade check and passes on the wrong mechanism entirely — which is exactly
 * what the first version of that test did.
 */
function dialLive(jar: Jar, settleMs = 1000): { opened: Promise<boolean>; outcome: Promise<DialResult> } {
  const ws = new WebSocket(wsUrl, { headers: { cookie: jar.header } });
  let message: any = null;
  let isOpen = false;

  const opened = new Promise<boolean>((resolve) => {
    ws.on('open', () => {
      isOpen = true;
      resolve(true);
    });
    ws.on('close', () => resolve(isOpen));
    ws.on('error', () => resolve(false));
  });

  const outcome = new Promise<DialResult>((resolve, reject) => {
    // A refusal is synchronous in the connection handler, so a socket still
    // open after a moment was accepted.
    const timer = setTimeout(() => {
      ws.close();
      resolve({ message, closed: false, code: 0 });
    }, settleMs);
    ws.on('message', (raw) => {
      message = JSON.parse(raw.toString());
    });
    ws.on('close', (code) => {
      clearTimeout(timer);
      resolve({ message, closed: true, code });
    });
    ws.on('error', reject);
  });

  return { opened, outcome };
}

/** Dial and wait for the verdict, for tests that do not need the open moment. */
const dial = (jar: Jar, settleMs = 1000): Promise<DialResult> => dialLive(jar, settleMs).outcome;

describe('one account, one live device', () => {
  it('evicts the phone the moment the desktop claims the account', async () => {
    const phone = await onboard(`Phone${Date.now().toString(36).slice(-5)}`);

    // The phone plays and is paid, as it should be while it holds the account.
    const before = await record(phone, `solo-before-${Date.now()}`);
    expect(before.status).toBe(200);
    expect(before.body.earnedXp).toBeGreaterThan(0);

    const me = (await call(phone, '/api/profile/me')).body;
    expect(me.recoveryCode).toBeTruthy();

    // The desktop takes the account over with the recovery code.
    const desktop = new Jar();
    await call(desktop, '/api/session', { method: 'POST' });
    const claim = await call(desktop, '/api/profile/claim', {
      method: 'POST',
      body: JSON.stringify({ code: me.recoveryCode }),
    });
    expect(claim.status).toBe(200);
    expect(claim.body.username).toBe(me.username);

    // THE BUG. The phone used to be handed a brand-new empty profile here and
    // allowed to play a full match on it. Now it is told, in one round trip,
    // that this device holds nothing — before a ball is served.
    const heartbeat = await call(phone, '/api/session');
    expect(heartbeat.body.status).toBe('released');

    // ...and it cannot record a match even if it plays one anyway.
    const after = await record(phone, `solo-after-${Date.now()}`);
    expect(after.status).toBe(409);
    expect(after.body.error).toBe('DEVICE_RELEASED');

    // Reading a profile must not mint one either — that lazy mint is what made
    // the released device look like a new player in the first place.
    const read = await call(phone, '/api/profile/me');
    expect(read.status).toBe(409);
    expect(read.body.error).toBe('DEVICE_RELEASED');

    // The desktop, meanwhile, holds a working account with the history intact.
    const moved = (await call(desktop, '/api/profile/me')).body;
    expect(moved.username).toBe(me.username);
    expect(moved.matchesPlayed).toBe(me.matchesPlayed);
    expect((await record(desktop, `solo-desktop-${Date.now()}`)).status).toBe(200);
  }, 30000);

  it('lets an evicted device start over as a new player, and only that way', async () => {
    const phone = await onboard(`Start${Date.now().toString(36).slice(-5)}`);
    const code = (await call(phone, '/api/profile/me')).body.recoveryCode;
    const desktop = new Jar();
    await call(desktop, '/api/session', { method: 'POST' });
    await call(desktop, '/api/profile/claim', { method: 'POST', body: JSON.stringify({ code }) });

    // A released device cannot simply mint itself a session back onto the
    // account it gave away.
    const retry = await call(phone, '/api/session', { method: 'POST' });
    expect(retry.status).toBe(409);
    expect(retry.body.error).toBe('DEVICE_RELEASED');

    // It has to take a fresh identity, which lands it on an EMPTY profile —
    // a new player, not the one it handed over.
    const beforeDevice = phone.raw.get('phong_device');
    const reset = await call(phone, '/api/session/reset', { method: 'POST' });
    expect(reset.status).toBe(200);
    expect(reset.body.status).toBe('active');
    expect(phone.raw.get('phong_device')).not.toBe(beforeDevice);
    expect(reset.body.profile.initialized).toBe(false);
    expect(reset.body.profile.matchesPlayed).toBe(0);
    expect((await call(phone, '/api/session')).body.status).toBe('active');
  }, 30000);

  it('refuses a second concurrent session on the same account', async () => {
    // Two browsers holding the SAME device cookie: a copied cookie jar, or the
    // same account opened twice. Exactly one of them may act.
    const first = await onboard(`Twin${Date.now().toString(36).slice(-5)}`);
    const second = new Jar();
    second.absorb(
      new Response(null, { headers: { 'set-cookie': first.raw.get('phong_device')! } })
    );

    // The newest load wins: the player is sitting at the device they just
    // opened, so that is the one that keeps playing.
    const taken = await call(second, '/api/session', { method: 'POST' });
    expect(taken.body.status).toBe('active');

    expect((await call(first, '/api/session')).body.status).toBe('superseded');
    const refused = await record(first, `solo-twin-${Date.now()}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('SESSION_SUPERSEDED');

    // The one holding the account plays normally.
    expect((await record(second, `solo-live-${Date.now()}`)).status).toBe(200);

    // And the displaced one can take it back — whoever taps last owns it.
    await call(first, '/api/session', { method: 'POST' });
    expect((await call(first, '/api/session')).body.status).toBe('active');
    expect((await call(second, '/api/session')).body.status).toBe('superseded');
  }, 30000);

  it('refuses a relay socket from a device that no longer holds the account', async () => {
    // The duel half of the same rule. Barred from recording a SOLO match, an
    // evicted device could otherwise still play a duel — and the relay records
    // a finished duel onto both seats itself, so the exploit would simply have
    // moved from one mode to the other.
    const phone = await onboard(`Duel${Date.now().toString(36).slice(-5)}`);
    const live = await dial(phone);
    expect(live.closed).toBe(false);
    expect(live.message).toBeNull();

    const code = (await call(phone, '/api/profile/me')).body.recoveryCode;
    const desktop = new Jar();
    await call(desktop, '/api/session', { method: 'POST' });
    await call(desktop, '/api/profile/claim', { method: 'POST', body: JSON.stringify({ code }) });

    const evicted = await dial(phone);
    expect(evicted.closed).toBe(true);
    expect(evicted.code).toBe(4001);
    // Told WHY before the close, so the client acts on the reason rather than
    // on a bare disconnect it would otherwise try to reconnect through.
    expect(evicted.message?.type).toBe('session_invalid');
    expect(evicted.message?.status).toBe('released');

    // The device that DOES hold the account is seated normally.
    const holder = await dial(desktop);
    expect(holder.closed).toBe(false);
  }, 30000);

  it('closes a live socket the moment a newer session displaces it', async () => {
    // The upgrade check is a SNAPSHOT. Ownership moves while sockets stay
    // open, and the relay writes a finished duel onto both seats itself — so
    // a socket that kept playing after being displaced would have its result
    // recorded under an account it no longer holds. Closing it at the moment
    // of displacement is what stops that, rather than leaving it to the
    // displaced client's next heartbeat seconds later.
    const first = await onboard(`Displace${Date.now().toString(36).slice(-5)}`);
    const socket = dialLive(first, 6000);
    // Seated FIRST. Without this the displacement races the upgrade check and
    // the test passes on the wrong mechanism.
    expect(await socket.opened).toBe(true);

    // The same device, opened again elsewhere: a newer session takes over.
    const second = new Jar();
    second.absorb(new Response(null, { headers: { 'set-cookie': first.raw.get('phong_device')! } }));
    await call(second, '/api/session', { method: 'POST' });

    const displaced = await socket.outcome;
    expect(displaced.closed).toBe(true);
    expect(displaced.code).toBe(4001);
    expect(displaced.message?.type).toBe('session_invalid');
    expect(displaced.message?.status).toBe('superseded');
  }, 30000);

  it('closes a live socket when the account is transferred out from under it', async () => {
    const phone = await onboard(`Transfer${Date.now().toString(36).slice(-5)}`);
    const socket = dialLive(phone, 6000);
    expect(await socket.opened).toBe(true);

    const code = (await call(phone, '/api/profile/me')).body.recoveryCode;
    const desktop = new Jar();
    await call(desktop, '/api/session', { method: 'POST' });
    await call(desktop, '/api/profile/claim', { method: 'POST', body: JSON.stringify({ code }) });

    const evicted = await socket.outcome;
    expect(evicted.closed).toBe(true);
    expect(evicted.message?.status).toBe('released');
  }, 30000);

  it('refuses an identity reset from a device that still holds its account', async () => {
    // The escape hatch for a released device, and nothing else. For a device
    // that still HELD its account, a reset swapped the cookie for a fresh
    // identity while the initialized profile stayed behind under the old one
    // — not deleted, merely unreachable.
    const jar = await onboard(`NoReset${Date.now().toString(36).slice(-5)}`);
    const before = (await call(jar, '/api/profile/me')).body;

    const refused = await call(jar, '/api/session/reset', { method: 'POST' });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('DEVICE_NOT_RELEASED');

    // Untouched: same device, same account, still playable.
    const after = (await call(jar, '/api/profile/me')).body;
    expect(after.id).toBe(before.id);
    expect(after.username).toBe(before.username);
    expect((await call(jar, '/api/session')).body.status).toBe('active');
  }, 30000);

  it('keeps the device — and so the account — across losing a session', async () => {
    const jar = await onboard(`Keep${Date.now().toString(36).slice(-5)}`);
    const device = jar.raw.get('phong_device');
    const before = (await call(jar, '/api/profile/me')).body;

    await call(jar, '/api/session/end', { method: 'POST' });
    expect((await call(jar, '/api/session')).body.status).toBe('none');

    // Re-minting a session lands on the SAME profile. This is the promise the
    // whole design rests on: sessions are disposable, the device binding is
    // not, so a forced refresh never costs anybody their account.
    const back = await call(jar, '/api/session', { method: 'POST' });
    expect(back.body.status).toBe('active');
    expect(jar.raw.get('phong_device')).toBe(device);
    expect(back.body.profile.id).toBe(before.id);
    expect(back.body.profile.username).toBe(before.username);
    expect(back.body.profile.xp).toBe(before.xp);
  }, 30000);

  it('retires sessions minted by a previous deployment', async () => {
    const jar = await onboard(`Build${Date.now().toString(36).slice(-5)}`);
    const build = (await call(jar, '/api/session')).body.build;
    expect(build).toMatch(/^[0-9a-f]{12}$/);
    expect((await call(jar, '/api/health')).body.build).toBe(build);

    // A session token carries the build it was minted under, and the server
    // pins that shape. Forging a different build cannot verify — which is
    // what makes "every update logs the field out of its session" hold
    // without the client having to cooperate.
    const token = jar.raw.get('phong_session')!.split('=').slice(1).join('=');
    const parts = token.split('.');
    expect(parts[3]).toBe(build);
    const forged = new Jar();
    forged.absorb(
      new Response(null, {
        headers: { 'set-cookie': `phong_session=${[parts[0], parts[1], parts[2], 'ffffffffffff', parts[4]].join('.')}` },
      })
    );
    forged.absorb(new Response(null, { headers: { 'set-cookie': jar.raw.get('phong_device')! } }));
    // Not 'stale_build': the signature covers the build, so an altered one is
    // simply not a session at all.
    expect((await call(forged, '/api/session')).body.status).toBe('none');
  }, 30000);
});
