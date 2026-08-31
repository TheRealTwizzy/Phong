import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { WSServerMessage } from '../../src/types';

// A real server, on a real port, with a real database — the shared harness for
// every suite that has to test something living at the HTTP or WebSocket seam.
//
// This was duplicated in tests/duelRecord.test.ts and tests/deviceSession.test.ts
// before tests/p2pParity.test.ts needed a third copy. The pieces here are
// exactly those two files' own, moved rather than rewritten: the details below
// are all scar tissue from CI and are not worth rediscovering per suite.
//
// Each caller gets its OWN port and DATA_DIR. A shared database would let one
// suite's players decide another suite's assertions — the same reasoning
// scripts/e2e-run.mjs applies to the browser suites.

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Ask the OS for a port nobody is using, so parallel suites cannot collide. */
export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });

export interface Device {
  cookie: string;
  id: string;
  username: string;
}

/** Collect Set-Cookie into a jar, keeping the newest value of each name. */
export function mergeCookies(jar: string, res: Response): string {
  const current = new Map<string, string>();
  for (const pair of jar.split('; ').filter(Boolean)) {
    current.set(pair.slice(0, pair.indexOf('=')), pair);
  }
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const pair = raw.split(';')[0];
    current.set(pair.slice(0, pair.indexOf('=')), pair);
  }
  return [...current.values()].join('; ');
}

/** A connected phone: its socket plus every server message it has received. */
export class Phone {
  ws: WebSocket;
  received: WSServerMessage[] = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (raw) => this.received.push(JSON.parse(raw.toString())));
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** The most recent message of `type`, or undefined. */
  last<T extends WSServerMessage['type']>(type: T): Extract<WSServerMessage, { type: T }> | undefined {
    for (let i = this.received.length - 1; i >= 0; i--) {
      if (this.received[i].type === type) return this.received[i] as any;
    }
    return undefined;
  }

  /** Every message of `type`, oldest first — for asserting a whole sequence. */
  all<T extends WSServerMessage['type']>(type: T): Extract<WSServerMessage, { type: T }>[] {
    return this.received.filter((m) => m.type === type) as any;
  }

  /** Wait until a message of `type` has arrived. */
  async await<T extends WSServerMessage['type']>(
    type: T,
    timeoutMs = 5000
  ): Promise<Extract<WSServerMessage, { type: T }>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = this.last(type);
      if (hit) return hit;
      await sleep(20);
    }
    throw new Error(`timed out waiting for ${type}`);
  }

  /** Wait until `count` messages of `type` have arrived. */
  async awaitCount<T extends WSServerMessage['type']>(
    type: T,
    count: number,
    timeoutMs = 5000
  ): Promise<Extract<WSServerMessage, { type: T }>[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hits = this.all(type);
      if (hits.length >= count) return hits;
      await sleep(20);
    }
    throw new Error(`timed out waiting for ${count}× ${type} (saw ${this.all(type).length})`);
  }

  clear(): void {
    this.received = [];
  }

  close(): void {
    this.ws.close();
  }
}

export interface SeatedDuel {
  p1: Phone;
  p2: Phone;
  roomId: string;
  matchSeq: number;
}

export interface Relay {
  /** http://127.0.0.1:PORT */
  base: string;
  /** ws://127.0.0.1:PORT/ws */
  wsUrl: string;
  /** The throwaway DATA_DIR this server was given. */
  dataDir: string;
  stop(): Promise<void>;
  /** A browser: own cookie jar, own profile, onboarded, holding a session. */
  newDevice(username: string): Promise<Device>;
  /** A browser with a session but no username yet — mid-onboarding. */
  newUnclaimedDevice(): Promise<Device>;
  openPhone(device: Device): Promise<Phone>;
  seatDuel(host: Device, guest: Device, winningScore?: number): Promise<SeatedDuel>;
}

/**
 * Boot a server and return everything a suite needs to talk to it.
 *
 * `label` only names the temp directory, so a stranded one says which suite
 * left it.
 */
export async function startRelay(label: string): Promise<Relay> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `phong-${label}-`));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/ws`;

  const server: ChildProcess = spawn('npx', ['tsx', 'server.ts'], {
    cwd: path.resolve(__dirname, '..', '..'),
    // production skips the Vite middleware, which is all this needs and much
    // faster to boot; the API and the relay are the same either way.
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group, so it can be killed as a whole. `npx tsx` is a
    // TREE — a shell, npx, then the server — and signalling only the process
    // we spawned leaves the actual server running: every test run stranded one
    // holding a port and a deleted temp directory, until CI reaped it as an
    // orphan at the end of the job.
    detached: true,
  });

  /** Kill the server's whole process group and wait for it to actually be gone. */
  const stop = async (): Promise<void> => {
    if (server?.pid && server.exitCode === null) {
      const exited = new Promise<void>((resolve) => server.once('exit', () => resolve()));
      try {
        // Negative pid = the group, which is the point of spawning detached.
        process.kill(-server.pid, 'SIGKILL');
      } catch {
        server.kill('SIGKILL');
      }
      // Don't leave the temp directory being deleted out from under a live server.
      await Promise.race([exited, sleep(3000)]);
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  };

  let up = false;
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) {
        up = true;
        break;
      }
    } catch {
      /* not listening yet */
    }
    await sleep(100);
  }
  if (!up) {
    await stop();
    throw new Error(`server did not start on ${base}`);
  }

  const newDevice = async (username: string): Promise<Device> => {
    const first = await fetch(`${base}/api/session`, { method: 'POST' });
    const cookie = mergeCookies('', first);
    const res = await fetch(`${base}/api/profile/initialize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ username }),
    });
    const profile = await res.json();
    if (!profile?.id) throw new Error(`onboarding failed: ${JSON.stringify(profile)}`);
    return { cookie, id: profile.id, username };
  };

  const newUnclaimedDevice = async (): Promise<Device> => {
    // A session, but no username yet — which is exactly the state a real
    // browser is in while the onboarding modal is up: the session is minted on
    // load, and onboarding happens after it. Without the session the relay
    // would refuse this socket for having no live session at all, which is a
    // true answer to a different question than the one this device is here to
    // ask.
    const first = await fetch(`${base}/api/session`, { method: 'POST' });
    const cookie = mergeCookies('', first);
    const { profile } = await first.json();
    return { cookie, id: profile.id, username: profile.username };
  };

  const openPhone = async (device: Device): Promise<Phone> => {
    const ws = new WebSocket(wsUrl, { headers: { cookie: device.cookie } });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return new Phone(ws);
  };

  /** Host + guest, through the lobby handshake, to the first serve of a match. */
  const seatDuel = async (host: Device, guest: Device, winningScore = 3): Promise<SeatedDuel> => {
    const p1 = await openPhone(host);
    p1.send({ type: 'create_room', playerId: host.id, config: { winningScore, rules: {} } });
    const created = await p1.await('room_created');

    const p2 = await openPhone(guest);
    p2.send({ type: 'join_room', roomId: created.roomId, playerId: guest.id });
    await p2.await('room_joined');

    p2.send({ type: 'player_ready', ready: true });
    await p1.await('ready_state');
    p1.send({ type: 'start_match' });
    const start = await p1.await('game_start');
    await p2.await('game_start');

    // A real duel negotiates a DataChannel (MultiplayerLobby's toggle is on by
    // default) and the relay is the only signaling path, so a seated duel that
    // never signals is a table the relay has no reason to believe carries a
    // replica — and match_sync, which IS that replica's account, is refused on
    // one. Sent after game_start rather than during the ready handshake: the
    // negotiation genuinely overlaps the countdown, and injecting a message
    // mid-handshake perturbs the very sequence tests/p2pParity.test.ts is
    // comparing message-for-message.
    p1.send({ type: 'rtc_signal', payload: { kind: 'offer', sdp: 'v=0' } });
    await sleep(30);

    return { p1, p2, roomId: created.roomId, matchSeq: start.matchSeq };
  };

  return { base, wsUrl, dataDir, stop, newDevice, newUnclaimedDevice, openPhone, seatDuel };
}
