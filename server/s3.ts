// PUT one object into an S3-compatible bucket. That is the entire surface.
//
// There is no DeleteObject and no ListObjectsV2 here, and there must never be.
// The credential this runs under should be PutObject-only, because a key that
// can delete means an attacker who reaches the server can erase the backups —
// which is the exact scenario offsite backup exists for. Retention on the
// bucket side is a lifecycle rule, not something this process does.
//
// Signing is server/sigv4.ts; this file is transport only.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import type { UploadResult } from './backup';
import { UNSIGNED_PAYLOAD, signRequest, uriEncodePath } from './sigv4';

export interface S3Target {
  /** Origin only, e.g. `https://s3.us-west-002.backblazeb2.com`. */
  endpoint: string;
  bucket: string;
  region: string;
  /** Key prefix, e.g. `phong/`. May be empty. */
  prefix: string;
  accessKeyId: string;
  sessionToken: string | null;
  virtualHost: boolean;
  unsignedPayload: boolean;
  /** e.g. `AES256`, or null. Opt-in: some providers 400 on unknown headers. */
  sse: string | null;
}

/**
 * Where the object goes, as ONE value.
 *
 * The host used in the `Host` header and the host signed inside the canonical
 * request must be the same string. Deriving them separately is the classic
 * SigV4 desync — it produces a 403 that reads exactly like a bad credential —
 * so they come out of one function and the test asserts they agree.
 *
 * Path style is the default: it works on essentially every S3-compatible
 * endpoint (MinIO, R2, B2, Garage, Wasabi, Spaces), and a bucket name
 * containing a dot breaks virtual-host TLS.
 */
export function objectUrl(
  target: S3Target,
  filename: string
): { href: string; host: string; path: string } {
  const base = new URL(target.endpoint);
  const key = `${target.prefix}${filename}`;
  const host = target.virtualHost ? `${target.bucket}.${base.host}` : base.host;
  const encodedKey = uriEncodePath(`/${key}`);
  const reqPath = target.virtualHost ? encodedKey : `/${encodeURIComponent(target.bucket)}${encodedKey}`;
  return { href: `${base.protocol}//${host}${reqPath}`, host, path: reqPath };
}

/**
 * SHA-256 of a file, streamed.
 *
 * Streamed rather than `readFileSync` because this file grows with the player
 * base: at a few hundred KB either is fine, and at 500MB `readFileSync`
 * allocates the whole database on the relay's heap in one synchronous call
 * (and Node throws outright past the buffer limit). Chunked hashing also yields
 * to the event loop between chunks, where one `update()` over a giant buffer
 * would not.
 */
export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** S3 answers errors as XML; the <Code> is the only part worth logging. */
function errorCode(body: string): string | null {
  const m = /<Code>([^<]{1,64})<\/Code>/.exec(body);
  return m ? m[1] : null;
}

/**
 * Upload one file.
 *
 * `secret` is a separate argument and never a field on `S3Target`, so that no
 * logged or serialized configuration object can carry it. A `toJSON()` would
 * not be enough — `console.error('…', obj)` goes through `util.inspect`, which
 * ignores `toJSON` entirely.
 *
 * Never rejects. Every failure comes back as `{ok: false}` with a status and a
 * code, because a rejected promise from here reaches `onFatal` in server.ts and
 * closes every socket on the server.
 */
export async function putObject(
  file: string,
  target: S3Target,
  secret: string,
  opts: { now?: Date; timeoutMs?: number } = {}
): Promise<UploadResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  try {
    const size = fs.statSync(file).size;
    const filename = path.basename(file);
    // The real digest rather than UNSIGNED-PAYLOAD by default: a truncated
    // upload becomes a 400 at the door instead of a short object in the bucket
    // that looks fine until the day it is restored. Same reasoning that put
    // integrity_check into scripts/backup.mjs.
    const payloadHash = target.unsignedPayload ? UNSIGNED_PAYLOAD : await sha256File(file);

    const { host, path: reqPath, href } = objectUrl(target, filename);
    const headers: Record<string, string> = {
      host,
      'content-length': String(size),
      'content-type': 'application/octet-stream',
    };
    if (target.sse) headers['x-amz-server-side-encryption'] = target.sse;

    const signed = signRequest({
      method: 'PUT',
      path: reqPath,
      headers,
      payloadHash,
      region: target.region,
      service: 's3',
      accessKeyId: target.accessKeyId,
      secretAccessKey: secret,
      sessionToken: target.sessionToken ?? undefined,
      now: opts.now ?? new Date(),
    });

    const url = new URL(href);
    const transport = url.protocol === 'https:' ? https : http;

    return await new Promise<UploadResult>((resolve) => {
      let settled = false;
      const done = (r: UploadResult) => {
        if (!settled) {
          settled = true;
          resolve(r);
        }
      };

      const req = transport.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || undefined,
          method: 'PUT',
          path: url.pathname + url.search,
          headers: signed.headers,
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          // Bounded: an error body is small, and a hostile endpoint answering
          // with a gigabyte must not be buffered into the relay's heap.
          let taken = 0;
          res.on('data', (c: Buffer) => {
            if (taken < 8192) {
              chunks.push(c);
              taken += c.length;
            }
          });
          res.on('end', () => {
            const status = res.statusCode ?? 0;
            const body = Buffer.concat(chunks).toString('utf8');
            if (status >= 200 && status < 300) {
              done({
                ok: true,
                status,
                code: null,
                // The first 12 hex of the digest, so an operator restoring from
                // the bucket can check the object they downloaded is this one.
                // Not a secret.
                detail: `${url.host}${reqPath} — ${(size / 1024).toFixed(0)}KB, sha256 ${payloadHash.slice(0, 12)}`,
              });
              return;
            }
            // The status and the S3 <Code> only. NEVER the body verbatim:
            // gateways echo request headers into error pages.
            done({ ok: false, status, code: errorCode(body), detail: `HTTP ${status}` });
          });
        }
      );

      req.on('timeout', () => {
        req.destroy();
        done({ ok: false, status: null, code: 'TIMEOUT', detail: `no response in ${timeoutMs}ms` });
      });
      // `err.code`/`err.message` only — some https errors carry `options`,
      // headers included, and console.error would print the Authorization.
      req.on('error', (err: NodeJS.ErrnoException) => {
        done({ ok: false, status: null, code: err.code ?? null, detail: err.message });
      });

      const body = fs.createReadStream(file);
      body.on('error', (err: Error) => {
        req.destroy();
        done({ ok: false, status: null, code: 'EREAD', detail: err.message });
      });
      body.pipe(req);
    });
  } catch (e) {
    return { ok: false, status: null, code: null, detail: (e as Error)?.message ?? String(e) };
  }
}
