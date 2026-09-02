import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { objectUrl, putObject, sha256File, type S3Target } from '../server/s3';

// The uploader, against a real socket.
//
// A loopback http server rather than a mock, because what is being checked is
// what actually goes on the wire: the request line, the Host header, the
// content-length, and that the bytes arriving are the bytes on disk. A mock of
// `https.request` would assert the shape of the call and miss all four.

const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

let server: http.Server;
let port: number;
let seen: Seen[] = [];
let reply: { status: number; body: string } = { status: 200, body: '' };
let dir: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-s3-'));
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      res.writeHead(reply.status, { 'content-type': 'application/xml' });
      res.end(reply.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

const target = (over: Partial<S3Target> = {}): S3Target => ({
  endpoint: `http://127.0.0.1:${port}`,
  bucket: 'phong-backups',
  region: 'us-east-1',
  prefix: 'phong/',
  accessKeyId: 'AKIAEXAMPLE',
  sessionToken: null,
  virtualHost: false,
  unsignedPayload: false,
  sse: null,
  ...over,
});

function write(name: string, bytes: Buffer | string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

beforeAll(() => {
  seen = [];
  reply = { status: 200, body: '' };
});

describe('objectUrl', () => {
  // The Host header and the host signed inside the canonical request must be
  // the same string. Deriving them separately is the classic SigV4 desync, and
  // it produces a 403 that reads exactly like a bad credential — so they come
  // out of one function and this pins that they agree.
  it('puts the bucket in the PATH by default', () => {
    const t = target({ endpoint: 'https://s3.example.com' });
    expect(objectUrl(t, 'phong-x.db')).toEqual({
      href: 'https://s3.example.com/phong-backups/phong/phong-x.db',
      host: 's3.example.com',
      path: '/phong-backups/phong/phong-x.db',
    });
  });

  it('puts it in the HOST when asked, and the two stay in step', () => {
    const t = target({ endpoint: 'https://s3.example.com', virtualHost: true });
    const u = objectUrl(t, 'phong-x.db');
    expect(u).toEqual({
      href: 'https://phong-backups.s3.example.com/phong/phong-x.db',
      host: 'phong-backups.s3.example.com',
      path: '/phong/phong-x.db',
    });
    expect(u.href).toContain(u.host);
  });

  it('encodes a key AWS-style rather than leaving it raw', () => {
    const t = target({ endpoint: 'https://s3.example.com', prefix: 'a b/' });
    expect(objectUrl(t, "c'd.db").path).toBe('/phong-backups/a%20b/c%27d.db');
  });
});

describe('putObject', () => {
  it('PUTs the file, with the bytes and the length that are actually on disk', async () => {
    seen = [];
    reply = { status: 200, body: '' };
    const file = write('phong-2026-09-02T00-00-00-000Z.db', Buffer.from('sqlite-bytes'));
    const res = await putObject(file, target(), SECRET);
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);

    const req = seen.at(-1)!;
    expect(req.method).toBe('PUT');
    expect(req.url).toBe('/phong-backups/phong/phong-2026-09-02T00-00-00-000Z.db');
    expect(req.headers.host).toBe(`127.0.0.1:${port}`);
    expect(req.headers['content-length']).toBe(String(fs.statSync(file).size));
    expect(req.body.toString()).toBe('sqlite-bytes');
  });

  it('signs the payload with a digest the TEST computed, not the module', async () => {
    // Hashing with the module's own hasher and comparing would pass against any
    // implementation, including one that hashed the wrong thing.
    seen = [];
    const bytes = crypto.randomBytes(4096);
    const file = write('phong-2026-09-02T00-00-01-000Z.db', bytes);
    const expected = crypto.createHash('sha256').update(bytes).digest('hex');
    await putObject(file, target(), SECRET);
    expect(seen.at(-1)!.headers['x-amz-content-sha256']).toBe(expected);
    expect(await sha256File(file)).toBe(expected);
  });

  it('streams a large file rather than buffering it', async () => {
    // 1MB, which is larger than any single read chunk. What this really pins is
    // that content-length was not computed from a truncated read: if the body
    // were buffered short, the server would see fewer bytes than the header
    // promised and the assertion below would fail.
    seen = [];
    const big = crypto.randomBytes(1024 * 1024);
    const file = write('phong-2026-09-02T00-00-02-000Z.db', big);
    const res = await putObject(file, target(), SECRET);
    expect(res.ok).toBe(true);
    const req = seen.at(-1)!;
    expect(req.body.length).toBe(big.length);
    expect(req.headers['content-length']).toBe(String(big.length));
    expect(req.body.equals(big)).toBe(true);
  });

  it('sends the session token when there is one, and never otherwise', async () => {
    seen = [];
    const file = write('phong-2026-09-02T00-00-03-000Z.db', 'x');
    await putObject(file, target({ sessionToken: 'tok-123' }), SECRET);
    expect(seen.at(-1)!.headers['x-amz-security-token']).toBe('tok-123');
    await putObject(file, target(), SECRET);
    expect(seen.at(-1)!.headers['x-amz-security-token']).toBeUndefined();
  });

  it('asks for server-side encryption only when configured', async () => {
    seen = [];
    const file = write('phong-2026-09-02T00-00-04-000Z.db', 'x');
    await putObject(file, target({ sse: 'AES256' }), SECRET);
    expect(seen.at(-1)!.headers['x-amz-server-side-encryption']).toBe('AES256');
    await putObject(file, target(), SECRET);
    expect(seen.at(-1)!.headers['x-amz-server-side-encryption']).toBeUndefined();
  });

  it('sends UNSIGNED-PAYLOAD only when asked', async () => {
    seen = [];
    const file = write('phong-2026-09-02T00-00-05-000Z.db', 'x');
    await putObject(file, target({ unsignedPayload: true }), SECRET);
    expect(seen.at(-1)!.headers['x-amz-content-sha256']).toBe('UNSIGNED-PAYLOAD');
  });

  it('reports a 403 with its S3 code, and does NOT throw', async () => {
    // A rejected promise from here reaches onFatal in server.ts and closes
    // every socket on the server. Every failure is a resolved value.
    reply = {
      status: 403,
      body: '<?xml version="1.0"?><Error><Code>SignatureDoesNotMatch</Code><Message>nope</Message></Error>',
    };
    const file = write('phong-2026-09-02T00-00-06-000Z.db', 'x');
    const res = await putObject(file, target(), SECRET);
    expect(res).toMatchObject({ ok: false, status: 403, code: 'SignatureDoesNotMatch' });
    reply = { status: 200, body: '' };
  });

  it('never echoes the response body, which a gateway may fill with our headers', async () => {
    reply = { status: 400, body: '<Error><Code>Bad</Code></Error> Authorization: AWS4-HMAC-SHA256 leaked' };
    const file = write('phong-2026-09-02T00-00-07-000Z.db', 'x');
    const res = await putObject(file, target(), SECRET);
    expect(JSON.stringify(res)).not.toContain('leaked');
    expect(JSON.stringify(res)).not.toContain('AWS4-HMAC-SHA256');
    expect(res.code).toBe('Bad');
    reply = { status: 200, body: '' };
  });

  it('resolves rather than hanging when nothing is listening', async () => {
    const file = write('phong-2026-09-02T00-00-08-000Z.db', 'x');
    // Port 1 is reserved and refuses immediately.
    const res = await putObject(file, target({ endpoint: 'http://127.0.0.1:1' }), SECRET);
    expect(res.ok).toBe(false);
    expect(res.status).toBeNull();
  });

  it('resolves when the file is not there', async () => {
    const res = await putObject(path.join(dir, 'no-such-file.db'), target(), SECRET);
    expect(res.ok).toBe(false);
  });

  it('gives up on a server that never answers', async () => {
    const silent = http.createServer(() => {
      /* accept and say nothing */
    });
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
    const p = (silent.address() as { port: number }).port;
    const file = write('phong-2026-09-02T00-00-09-000Z.db', 'x');
    const res = await putObject(file, target({ endpoint: `http://127.0.0.1:${p}` }), SECRET, {
      timeoutMs: 300,
    });
    expect(res).toMatchObject({ ok: false, code: 'TIMEOUT' });
    await new Promise<void>((r) => silent.close(() => r()));
  });

  it('never puts the secret in the result, whatever happened', async () => {
    const file = write('phong-2026-09-02T00-00-10-000Z.db', 'x');
    const good = await putObject(file, target(), SECRET);
    const bad = await putObject(file, target({ endpoint: 'http://127.0.0.1:1' }), SECRET);
    expect(JSON.stringify(good)).not.toContain(SECRET);
    expect(JSON.stringify(bad)).not.toContain(SECRET);
  });

  it('hardcodes no endpoint or bucket anywhere in the module', () => {
    // Same spirit as tests/device.test.ts scanning src/device.ts for viewport
    // reads: a default destination can never be smuggled in, and this fails
    // loudly if someone tries.
    //
    // Comments are stripped first, exactly as tests/legal.test.ts does before
    // counting `req.ip` — the doc comment on S3Target names an example
    // endpoint so a reader knows what shape the value takes, and prose is not
    // a hardcoded default. This caught that example on the first run, which is
    // the check working rather than the check being wrong.
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'server', 's3.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code.match(/https?:\/\/[a-z0-9.-]+/gi) ?? []).toEqual([]);
  });
});
