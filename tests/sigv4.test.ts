import { describe, expect, it } from 'vitest';
import {
  amzDates,
  canonicalQuery,
  canonicalRequest,
  credentialScope,
  signRequest,
  signingKey,
  stringToSign,
  uriEncodeComponent,
  uriEncodePath,
} from '../server/sigv4';

// SigV4, pinned against an independent implementation.
//
// WHERE THESE FIXTURES CAME FROM, because it matters and it is not the usual
// answer. The plan for this work said to transcribe AWS's published SigV4 test
// suite and the S3 documentation's worked PUT example character-for-character.
// Neither is reachable from this environment — the egress proxy denies
// docs.aws.amazon.com — so they were generated instead by signing the same
// requests with **botocore**, which is the signer the AWS CLI itself uses, and
// pasting the results below verbatim.
//
// That is the same move `tests/qr.test.ts` makes: it pins matrices produced by
// an INDEPENDENT encoder rather than by the code under test. It is weaker than
// a published spec fixture in one specific way and the weakness is worth
// stating plainly — two implementations can share a misreading of the spec in a
// way a spec fixture would have caught. It is stronger in another: it is
// executable, so the hostile cases below (header order, whitespace collapse,
// key rotation across a date and a region) are real reference output rather
// than cases nobody published.
//
// The gap is closed at the other end, out of band: `server/s3.ts`'s uploader is
// additionally checked against a real MinIO, which is an actual S3
// implementation validating an actual signature. A signer that agrees with
// botocore AND is accepted by a real server is not plausibly wrong.
//
// To regenerate (needs pip and network to pypi):
//   pip3 install --target /tmp/pylibs botocore
//   PYTHONPATH=/tmp/pylibs python3 - <<'PY'
//   from botocore.auth import SigV4Auth
//   from botocore.awsrequest import AWSRequest
//   from botocore.credentials import Credentials
//   req = AWSRequest(method='PUT', url=..., headers=..., data=...)
//   req.context['timestamp'] = '20130524T000000Z'
//   s = SigV4Auth(Credentials(KEY, SECRET), 's3', REGION)
//   s._modify_request_before_signing(req)
//   cr = s.canonical_request(req); print(cr); print(s.string_to_sign(req, cr))
//   PY
//
// The credentials are AWS's own documentation examples and are not secrets.
const KEY = 'AKIAIOSFODNN7EXAMPLE';
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

interface Vector {
  name: string;
  method: string;
  path: string;
  query: Record<string, string> | null;
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  amzDate: string;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

/** `20130524T000000Z` back to the instant signRequest takes. */
const instant = (amzDate: string): Date =>
  new Date(
    `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T` +
      `${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`
  );

const VECTORS: Vector[] = [
  {
    "name": "s3-put-payload",
    "method": "PUT",
    "path": "/test.txt",
    "query": null,
    "headers": {
      "x-amz-storage-class": "REDUCED_REDUNDANCY",
      "host": "examplebucket.s3.amazonaws.com"
    },
    "payloadHash": "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072",
    "region": "us-east-1",
    "amzDate": "20130524T000000Z",
    "canonicalRequest": "PUT\n/test.txt\n\nhost:examplebucket.s3.amazonaws.com\nx-amz-content-sha256:44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072\nx-amz-date:20130524T000000Z\nx-amz-storage-class:REDUCED_REDUNDANCY\n\nhost;x-amz-content-sha256;x-amz-date;x-amz-storage-class\n44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072",
    "stringToSign": "AWS4-HMAC-SHA256\n20130524T000000Z\n20130524/us-east-1/s3/aws4_request\nb38b1ed7dba3dbd8767139cc29c08de4f7262f169bace064e9169e9f4a0b0c57",
    "signature": "8bfcb7a29cb0d36a7b913f965bdf326e45ead55ea3e659d54e5ab46b6be3b616"
  },
  {
    "name": "path-style",
    "method": "PUT",
    "path": "/phong-backups/phong/phong-2026-09-02T00-00-00-000Z.db",
    "query": null,
    "headers": {
      "content-type": "application/octet-stream",
      "host": "s3.example.com"
    },
    "payloadHash": "6a70d98b55f71fa10b6d012fbd7aebc45daa182bf722e9b7f07f855dabf2703f",
    "region": "us-east-1",
    "amzDate": "20130524T000000Z",
    "canonicalRequest": "PUT\n/phong-backups/phong/phong-2026-09-02T00-00-00-000Z.db\n\ncontent-type:application/octet-stream\nhost:s3.example.com\nx-amz-content-sha256:6a70d98b55f71fa10b6d012fbd7aebc45daa182bf722e9b7f07f855dabf2703f\nx-amz-date:20130524T000000Z\n\ncontent-type;host;x-amz-content-sha256;x-amz-date\n6a70d98b55f71fa10b6d012fbd7aebc45daa182bf722e9b7f07f855dabf2703f",
    "stringToSign": "AWS4-HMAC-SHA256\n20130524T000000Z\n20130524/us-east-1/s3/aws4_request\nc279b6f37db28c7065af105de293f259e876a21b37a0141e8ca55704922284b9",
    "signature": "df31c4aaa0ed9a708044ce37e80158031c12288f70d00eba797cc64a99bbba1e"
  },
  {
    "name": "hostile-headers",
    "method": "PUT",
    "path": "/b/k",
    "query": null,
    "headers": {
      "zzz": "last",
      "aaa": "first",
      "x-amz-meta-pad": "  a   b  ",
      "host": "s3.example.com"
    },
    "payloadHash": "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",
    "region": "us-east-1",
    "amzDate": "20130524T000000Z",
    "canonicalRequest": "PUT\n/b/k\n\naaa:first\nhost:s3.example.com\nx-amz-content-sha256:2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881\nx-amz-date:20130524T000000Z\nx-amz-meta-pad:a b\nzzz:last\n\naaa;host;x-amz-content-sha256;x-amz-date;x-amz-meta-pad;zzz\n2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",
    "stringToSign": "AWS4-HMAC-SHA256\n20130524T000000Z\n20130524/us-east-1/s3/aws4_request\n388d9e6db324e172c8773546a2be388de4492f9bf75b8b0755e413d095ee2722",
    "signature": "bf632c95196196c64a16149de521a2254aee473e25a67f594478553bea74e654"
  },
  {
    "name": "query-order",
    "method": "GET",
    "path": "/b/k",
    "query": {
      "b": "2",
      "a": "1",
      "c": "hello"
    },
    "headers": {
      "host": "s3.example.com"
    },
    "payloadHash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "region": "us-east-1",
    "amzDate": "20130524T000000Z",
    "canonicalRequest": "GET\n/b/k\na=1&b=2&c=hello\nhost:s3.example.com\nx-amz-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\nx-amz-date:20130524T000000Z\n\nhost;x-amz-content-sha256;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "stringToSign": "AWS4-HMAC-SHA256\n20130524T000000Z\n20130524/us-east-1/s3/aws4_request\nfde97a02b73828077ac251627cca1cc9f81b1eb4f4f63c97f856923e4d3dafc6",
    "signature": "c06f78b9e251549b0267ff2fc4c71600eec0e6f96855e2425fb5fd1e50128896"
  },
  {
    "name": "next-day",
    "method": "PUT",
    "path": "/phong-backups/phong/phong-2026-09-02T00-00-00-000Z.db",
    "query": null,
    "headers": {
      "content-type": "application/octet-stream",
      "host": "s3.example.com"
    },
    "payloadHash": "6a70d98b55f71fa10b6d012fbd7aebc45daa182bf722e9b7f07f855dabf2703f",
    "region": "us-east-1",
    "amzDate": "20130525T000000Z",
    "canonicalRequest": "PUT\n/phong-backups/phong/phong-2026-09-02T00-00-00-000Z.db\n\ncontent-type:application/octet-stream\nhost:s3.example.com\nx-amz-content-sha256:6a70d98b55f71fa10b6d012fbd7aebc45daa182bf722e9b7f07f855dabf2703f\nx-amz-date:20130525T000000Z\n\ncontent-type;host;x-amz-content-sha256;x-amz-date\n6a70d98b55f71fa10b6d012fbd7aebc45daa182bf722e9b7f07f855dabf2703f",
    "stringToSign": "AWS4-HMAC-SHA256\n20130525T000000Z\n20130525/us-east-1/s3/aws4_request\nc54d6cd046774329f35fb4d44d7646c2afa07e990576175bbc98600547afe91d",
    "signature": "7061c52ae94d24bbf7f4cf7a7a3400efbc48f22f3e68adb31a1f5954c4195fe1"
  },
  {
    "name": "other-region",
    "method": "PUT",
    "path": "/phong-backups/phong/phong-2026-09-02T00-00-00-000Z.db",
    "query": null,
    "headers": {
      "content-type": "application/octet-stream",
      "host": "s3.example.com"
    },
    "payloadHash": "6a70d98b55f71fa10b6d012fbd7aebc45daa182bf722e9b7f07f855dabf2703f",
    "region": "us-west-002",
    "amzDate": "20130524T000000Z",
    "canonicalRequest": "PUT\n/phong-backups/phong/phong-2026-09-02T00-00-00-000Z.db\n\ncontent-type:application/octet-stream\nhost:s3.example.com\nx-amz-content-sha256:6a70d98b55f71fa10b6d012fbd7aebc45daa182bf722e9b7f07f855dabf2703f\nx-amz-date:20130524T000000Z\n\ncontent-type;host;x-amz-content-sha256;x-amz-date\n6a70d98b55f71fa10b6d012fbd7aebc45daa182bf722e9b7f07f855dabf2703f",
    "stringToSign": "AWS4-HMAC-SHA256\n20130524T000000Z\n20130524/us-west-002/s3/aws4_request\nc279b6f37db28c7065af105de293f259e876a21b37a0141e8ca55704922284b9",
    "signature": "253a1ad002349809b85000562731f7e3f4da751accd6b85444592f19c47e2b54"
  }
];

describe('SigV4 against botocore', () => {
  // Asserted in THREE pieces, not one. A single Authorization assertion is one
  // bit of information: it tells you something is wrong and nothing about
  // where, and the three stages fail for completely different reasons — the
  // canonical request for header/query/path handling, the string to sign for
  // the scope and the date, the signature for the key derivation.
  it.each(VECTORS)('$name — canonical request', (v) => {
    const out = signRequest({
      method: v.method,
      path: v.path,
      query: v.query ?? undefined,
      headers: v.headers,
      payloadHash: v.payloadHash,
      region: v.region,
      service: 's3',
      accessKeyId: KEY,
      secretAccessKey: SECRET,
      now: instant(v.amzDate),
    });
    expect(out.canonicalRequest).toBe(v.canonicalRequest);
  });

  it.each(VECTORS)('$name — string to sign', (v) => {
    const out = signRequest({
      method: v.method, path: v.path, query: v.query ?? undefined,
      headers: v.headers, payloadHash: v.payloadHash, region: v.region,
      service: 's3', accessKeyId: KEY, secretAccessKey: SECRET, now: instant(v.amzDate),
    });
    expect(out.stringToSign).toBe(v.stringToSign);
  });

  it.each(VECTORS)('$name — signature', (v) => {
    const out = signRequest({
      method: v.method, path: v.path, query: v.query ?? undefined,
      headers: v.headers, payloadHash: v.payloadHash, region: v.region,
      service: 's3', accessKeyId: KEY, secretAccessKey: SECRET, now: instant(v.amzDate),
    });
    expect(out.signature).toBe(v.signature);
  });

  it('puts the same signature in the Authorization header, with the scope and the signed set', () => {
    const v = VECTORS[0];
    const out = signRequest({
      method: v.method, path: v.path, query: v.query ?? undefined,
      headers: v.headers, payloadHash: v.payloadHash, region: v.region,
      service: 's3', accessKeyId: KEY, secretAccessKey: SECRET, now: instant(v.amzDate),
    });
    expect(out.headers.authorization).toBe(
      `AWS4-HMAC-SHA256 Credential=${KEY}/${out.credentialScope}, ` +
        `SignedHeaders=${out.signedHeaders}, Signature=${out.signature}`
    );
    // SignedHeaders must be exactly what is actually sent, sorted and lowercased
    // — a set that names a header the request does not carry is a 403 that
    // reads like a credential problem.
    const sent = Object.keys(out.headers)
      .filter((h) => h !== 'authorization')
      .map((h) => h.toLowerCase())
      .sort();
    expect(out.signedHeaders.split(';')).toEqual(sent);
  });
});

describe('the parts that fail quietly', () => {
  // Every case here kills a specific plausible implementation. Each was checked
  // by writing the wrong version and watching this go red.

  it('sorts headers, however they arrive', () => {
    // `hostile-headers` supplies zzz before aaa. An implementation that signs
    // in insertion order matches on a fixture that happens to be sorted and
    // fails on every real request, because header order is not stable.
    const v = VECTORS.find((x) => x.name === 'hostile-headers')!;
    expect(Object.keys(v.headers)[0]).toBe('zzz'); // the fixture is genuinely hostile
    const { text } = canonicalRequest({
      method: 'PUT', path: '/b/k', headers: v.headers, payloadHash: v.payloadHash,
    });
    const names = text.split('\n').slice(3).filter((l) => l.includes(':')).map((l) => l.split(':')[0]);
    expect(names).toEqual([...names].sort());
  });

  it('COLLAPSES whitespace in a header value rather than trimming it', () => {
    // `.trim()` alone turns "  a   b  " into "a   b" and passes any test that
    // only checks the ends. The canonical form is "a b".
    const { text } = canonicalRequest({
      method: 'PUT', path: '/', headers: { host: 'h', pad: '  a   b  ' }, payloadHash: 'x',
    });
    expect(text).toContain('pad:a b\n');
    expect(text).not.toContain('pad:a   b');
  });

  it('sorts the query by key and encodes both halves', () => {
    expect(canonicalQuery({ b: '2', a: '1', c: 'hello' })).toBe('a=1&b=2&c=hello');
    // A space is %20 and never +, and a literal + is %2B. Getting this backwards
    // is the single most common SigV4 bug and it only shows up on keys that
    // happen to contain one.
    expect(canonicalQuery({ k: 'a b+c' })).toBe('k=a%20b%2Bc');
  });

  it('encodes a path AWS-style, not encodeURIComponent-style', () => {
    // The five encodeURIComponent leaves alone and AWS does not. A signer that
    // just calls encodeURIComponent passes every ASCII-safe fixture and then
    // 403s on the first object key containing an apostrophe.
    expect(uriEncodeComponent("!'()*")).toBe('%21%27%28%29%2A');
    expect(uriEncodeComponent('a b')).toBe('a%20b');
    expect(uriEncodeComponent('c+d')).toBe('c%2Bd');
    expect(uriEncodeComponent('é')).toBe('%C3%A9'); // UTF-8, uppercase hex
    // Unreserved must survive untouched.
    expect(uriEncodeComponent("aZ0-._~")).toBe('aZ0-._~');
    // Separators survive; segments are encoded.
    expect(uriEncodePath('/a b/c+d/é.db')).toBe('/a%20b/c%2Bd/%C3%A9.db');
  });

  it('does NOT normalize dot segments, because S3 signs the path as sent', () => {
    // Most services canonicalize `.` and `..` out of the path; `s3` does not.
    // Normalizing here would sign a different request than the one on the wire.
    expect(uriEncodePath('/a/./b/../c')).toBe('/a/./b/../c');
  });

  it('derives a different signing key for a different DATE', () => {
    // A cache keyed on the secret but not the date signs with yesterday's key
    // from the first request after midnight UTC — a failure that happens once
    // a day and looks like a flake.
    const a = signingKey(SECRET, '20130524', 'us-east-1', 's3');
    const b = signingKey(SECRET, '20130525', 'us-east-1', 's3');
    expect(a.equals(b)).toBe(false);
    // And the vectors prove it end to end: same request, next day.
    const same = VECTORS.find((v) => v.name === 'path-style')!;
    const next = VECTORS.find((v) => v.name === 'next-day')!;
    expect(same.signature).not.toBe(next.signature);
  });

  it('derives a different signing key for a different REGION', () => {
    const a = signingKey(SECRET, '20130524', 'us-east-1', 's3');
    const b = signingKey(SECRET, '20130524', 'us-west-002', 's3');
    expect(a.equals(b)).toBe(false);
    const east = VECTORS.find((v) => v.name === 'path-style')!;
    const west = VECTORS.find((v) => v.name === 'other-region')!;
    expect(east.signature).not.toBe(west.signature);
  });

  it('actually consumes the secret', () => {
    // Cheap, and it documents that the key is not decorative: an implementation
    // that derived from the access key id would pass every structural check
    // above.
    const flipped = SECRET.slice(0, -1) + (SECRET.endsWith('Y') ? 'Z' : 'Y');
    const v = VECTORS[0];
    const args = {
      method: v.method, path: v.path, headers: v.headers, payloadHash: v.payloadHash,
      region: v.region, service: 's3', accessKeyId: KEY, now: instant(v.amzDate),
    };
    expect(signRequest({ ...args, secretAccessKey: flipped }).signature).not.toBe(
      signRequest({ ...args, secretAccessKey: SECRET }).signature
    );
  });

  it('never puts the secret in anything it returns', () => {
    const v = VECTORS[0];
    const out = signRequest({
      method: v.method, path: v.path, headers: v.headers, payloadHash: v.payloadHash,
      region: v.region, service: 's3', accessKeyId: KEY, secretAccessKey: SECRET,
      now: instant(v.amzDate),
    });
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it('carries a session token into the signed set when there is one', () => {
    const v = VECTORS[0];
    const base = {
      method: v.method, path: v.path, headers: v.headers, payloadHash: v.payloadHash,
      region: v.region, service: 's3', accessKeyId: KEY, secretAccessKey: SECRET,
      now: instant(v.amzDate),
    };
    const withToken = signRequest({ ...base, sessionToken: 'tok' });
    expect(withToken.headers['x-amz-security-token']).toBe('tok');
    expect(withToken.signedHeaders).toContain('x-amz-security-token');
    // And it changes the signature — a token that is sent but not signed is a
    // 403 the moment the credential is temporary.
    expect(withToken.signature).not.toBe(signRequest(base).signature);
  });

  it('merges a repeated header name into one comma-joined line', () => {
    // Header names are case-insensitive and a Record can hold `Host` and
    // `host` as two entries. AWS's canonical form is ONE line with the values
    // joined; two lines produces a request the server never reconstructs, and
    // the 403 it answers with blames the credentials.
    const { text, signedHeaders } = canonicalRequest({
      method: 'PUT',
      path: '/b/k',
      headers: { 'X-Amz-Meta-A': 'one', 'x-amz-meta-a': 'two', host: 'h' },
      payloadHash: 'x',
    });
    expect(text).toContain('x-amz-meta-a:one,two\n');
    expect(signedHeaders).toBe('host;x-amz-meta-a');
    expect(signedHeaders.split(';').length).toBe(2);
  });

  it('signs a bare "/" when the path is empty', () => {
    // An empty canonical URI is not legal; the root is.
    const { text } = canonicalRequest({
      method: 'GET', path: '', headers: { host: 'h' }, payloadHash: 'x',
    });
    expect(text.split('\n')[1]).toBe('/');
  });

  it('renders the date and the scope the way the string to sign expects', () => {
    const { amzDate, dateStamp } = amzDates(new Date('2013-05-24T00:00:00.000Z'));
    expect(amzDate).toBe('20130524T000000Z');
    expect(dateStamp).toBe('20130524');
    expect(credentialScope(dateStamp, 'us-east-1', 's3')).toBe('20130524/us-east-1/s3/aws4_request');
    expect(stringToSign('creq', amzDate, 'scope').split('\n')[0]).toBe('AWS4-HMAC-SHA256');
  });
});

