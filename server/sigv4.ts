// AWS Signature Version 4, for one caller: PUT a backup snapshot into an
// S3-compatible bucket.
//
// Pure, like server/rateLimit.ts and server/transform.ts: no I/O, no clock of
// its own. `now` is passed in, which is what lets the whole thing be stated as
// fixtures in the fast test layer instead of observed through a live request —
// a signature is only checkable against a known date.
//
// WHY THIS IS HAND-ROLLED. The runtime dependency list is exactly `express`
// and `ws`, and that is not a preference: `tests/legal.test.ts` asserts it, as
// the mechanical half of the privacy notice's "no third-party analytics". So
// reaching for `@aws-sdk/client-s3` or `aws4` would turn the PRIVACY suite red.
// The precedent is `src/media/qr.ts`, which encodes QR in-repo rather than take
// a dependency and hand a third party every room code.
//
// WHY IT LIVES IN server/ AND NOT scripts/. `tsc` does not read `.mjs`, the
// coverage `include` in vite.config.ts does not match `scripts/`, and
// `lint:suites` polices only `e2e-*.mjs`. Hand-rolled crypto is the single
// worst thing to put in that blind spot, so it goes where the typechecker and
// the coverage floor can both see it.
//
// The parts that are easy to get wrong, and are therefore pinned individually
// in tests/sigv4.test.ts rather than through one Authorization assertion:
//
//  - S3 does NOT normalize the canonical URI. Most services canonicalize the
//    path (collapsing `.` and `..`); `s3` signs the path as sent. A signer that
//    passes the generic vectors can still be wrong for every request made here.
//  - `encodeURIComponent` is not AWS's encoding. It leaves `!'()*` alone and
//    AWS escapes all of them, and it encodes a space as `%20` only because it
//    never uses `+` — but a hand-rolled encoder that reaches for
//    `encodeURI`/`replace` usually gets `+` wrong in one direction or the
//    other.
//  - Header values are whitespace-COLLAPSED, not trimmed. `"  a   b  "` signs
//    as `a b`, and a `.trim()` alone passes the first half of that and fails
//    the second.
//  - The signing key is derived per DATE. A cache keyed on the secret without
//    the date signs with yesterday's key from the first request after midnight
//    UTC, which fails exactly once a day and looks like a flake.

import crypto from 'node:crypto';

const ALGORITHM = 'AWS4-HMAC-SHA256';

const sha256hex = (data: crypto.BinaryLike): string =>
  crypto.createHash('sha256').update(data).digest('hex');

const hmac = (key: crypto.BinaryLike | crypto.KeyObject, data: string): Buffer =>
  crypto.createHmac('sha256', key).update(data, 'utf8').digest();

/** The hash of an empty body, which is what a request with no payload signs. */
export const EMPTY_PAYLOAD_SHA256 = sha256hex('');

/** For an endpoint that rejects a real payload hash. Legal only over HTTPS. */
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

export interface SigV4Input {
  method: string;
  /** Path only, with a leading `/`. Already percent-encoded by uriEncodePath. */
  path: string;
  query?: Record<string, string>;
  /** Must include `host`. Names are matched case-insensitively. */
  headers: Record<string, string>;
  /** Lowercase hex sha256 of the body, or UNSIGNED_PAYLOAD. */
  payloadHash: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  now: Date;
}

export interface SigV4Output {
  /** The input headers plus everything the signature covers. */
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
  signedHeaders: string;
  credentialScope: string;
}

/**
 * Percent-encode one path SEGMENT, AWS-style.
 *
 * Unreserved is exactly `A-Za-z0-9-._~`; everything else is `%XX` with UPPERCASE
 * hex, over UTF-8. `encodeURIComponent` agrees on most of it and leaves `!`,
 * `'`, `(`, `)` and `*` unescaped, which AWS does not — so those five are
 * patched afterwards rather than reimplementing the whole thing.
 */
export function uriEncodeComponent(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

/**
 * Percent-encode a whole path, preserving the separators.
 *
 * `/` is a separator here and must survive; everything inside a segment is
 * encoded. Note what this does NOT do: it does not normalize `.` or `..`,
 * because S3 signs the path as sent, and collapsing them here would sign a
 * different request than the one that goes on the wire.
 */
export function uriEncodePath(path: string): string {
  return path.split('/').map(uriEncodeComponent).join('/');
}

/** `20130524T000000Z` and `20130524`, both derived from one instant. */
export function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/**
 * The canonical query string: sorted by key, then by value, both encoded.
 *
 * Sorted on the ENCODED key rather than the raw one, which is what AWS
 * specifies and is observable whenever a key contains a character that encodes
 * to something that sorts differently.
 */
export function canonicalQuery(query: Record<string, string> | undefined): string {
  if (!query) return '';
  const pairs = Object.entries(query).map(
    ([k, v]) => [uriEncodeComponent(k), uriEncodeComponent(v)] as const
  );
  // Sorted on the ENCODED key. AWS also specifies a tiebreak on the value for
  // repeated keys, and there is deliberately none here: the input is a
  // `Record`, so two entries cannot share a key, and percent-encoding is
  // injective so two distinct keys cannot encode to the same string either.
  // A tiebreak would be a branch no test could ever reach.
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

/**
 * Lowercased names, whitespace-collapsed values, sorted, one per line.
 *
 * The collapse is the part that is easy to half-do: a value is trimmed AND its
 * internal runs of whitespace are folded to a single space, so `"  a   b  "`
 * signs as `a b`. A `.trim()` alone produces `a   b` and every signature is
 * wrong for any header a proxy happened to pad.
 */
function canonicalHeaders(headers: Record<string, string>): {
  canonical: string;
  signed: string;
} {
  // Merged before sorting, because header names are case-insensitive and a
  // `Record` can carry `Host` and `host` as two entries. AWS's rule for a
  // repeated name is one line with the values comma-joined — emitting two
  // lines instead produces a canonical request the server will never
  // reconstruct, and the 403 blames the credentials.
  const merged = new Map<string, string>();
  for (const [k, v] of Object.entries(headers)) {
    const name = k.toLowerCase().trim();
    const value = String(v).trim().replace(/\s+/g, ' ');
    const seen = merged.get(name);
    merged.set(name, seen === undefined ? value : `${seen},${value}`);
  }
  const entries = [...merged.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return {
    canonical: entries.map(([k, v]) => `${k}:${v}\n`).join(''),
    signed: entries.map(([k]) => k).join(';'),
  };
}

/** The canonical request, exactly as it is hashed into the string to sign. */
export function canonicalRequest(input: {
  method: string;
  path: string;
  query?: Record<string, string>;
  headers: Record<string, string>;
  payloadHash: string;
}): { text: string; signedHeaders: string } {
  const { canonical, signed } = canonicalHeaders(input.headers);
  const text = [
    input.method.toUpperCase(),
    input.path || '/',
    canonicalQuery(input.query),
    canonical,
    signed,
    input.payloadHash,
  ].join('\n');
  return { text, signedHeaders: signed };
}

export function credentialScope(dateStamp: string, region: string, service: string): string {
  return `${dateStamp}/${region}/${service}/aws4_request`;
}

export function stringToSign(creq: string, amzDate: string, scope: string): string {
  return [ALGORITHM, amzDate, scope, sha256hex(creq)].join('\n');
}

/**
 * The four-step derived key.
 *
 * Derived per date, and the tests assert that two different dates produce two
 * different keys — a cache that forgets the date signs with yesterday's key
 * from the first request after midnight UTC.
 */
export function signingKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string
): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

/**
 * Sign one request, returning the headers to send AND the intermediates.
 *
 * The intermediates are returned rather than kept private because that is what
 * makes the tests non-vacuous: asserting only the final Authorization header is
 * one bit of information and says nothing about WHERE a mismatch came from.
 * They are cheap strings and nothing is obliged to look at them.
 */
export function signRequest(input: SigV4Input): SigV4Output {
  const { amzDate, dateStamp } = amzDates(input.now);
  const scope = credentialScope(dateStamp, input.region, input.service);

  // x-amz-date and x-amz-content-sha256 are part of what is signed, so they are
  // added BEFORE the canonical request is built rather than bolted on after.
  const headers: Record<string, string> = {
    ...input.headers,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': input.payloadHash,
  };
  if (input.sessionToken) headers['x-amz-security-token'] = input.sessionToken;

  const { text: creq, signedHeaders } = canonicalRequest({
    method: input.method,
    path: input.path,
    query: input.query,
    headers,
    payloadHash: input.payloadHash,
  });
  const sts = stringToSign(creq, amzDate, scope);
  const signature = hmac(
    signingKey(input.secretAccessKey, dateStamp, input.region, input.service),
    sts
  ).toString('hex');

  return {
    headers: {
      ...headers,
      authorization:
        `${ALGORITHM} Credential=${input.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    canonicalRequest: creq,
    stringToSign: sts,
    signature,
    signedHeaders,
    credentialScope: scope,
  };
}

/** Exported for the uploader: hashing a body is the caller's job, not ours. */
export const hashBytes = sha256hex;
