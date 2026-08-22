import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// The identity of the deployment currently being served.
//
// Every session is minted under a build id and dies with it, so shipping a new
// build logs every client in the field out of its SESSION — never out of its
// account, which is held by the long-lived device cookie — and each one
// re-syncs and reloads onto the build that is actually deployed. That is the
// standing rule for this project: an update always force-refreshes session
// auth, and it does so by construction rather than by anyone remembering to
// bump a constant.
//
// Three sources, in order:
//  1. BUILD_ID from the environment — an image tag or commit sha, for hosts
//     that already have one worth using.
//  2. A digest of the built artifacts — the client's index.html AND the server
//     bundle. Vite rewrites the hashed asset names into index.html on every
//     client build, and the server bundle changes whenever server code does,
//     so between them the digest changes exactly when what is being served
//     changes — and, just as importantly, does NOT change when the same build
//     merely restarts. A crash-loop or a routine container restart must not
//     log anybody out.
//
//     The server bundle is in there deliberately. Hashing the client alone
//     left a server-only deploy — an auth fix, a protocol change, exactly the
//     kind of thing this mechanism exists for — producing the SAME id as the
//     deploy before it, so every session in the field stayed valid and
//     nothing refreshed.
//  3. A per-process random value, in dev, where there is nothing built to hash.
//
// Twelve hex characters: short enough to sit inside a cookie token, and the
// token parser pins that shape.

const BUILD_ID_PATTERN = /^[0-9a-f]{12}$/;

function digest(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 12);
}

/**
 * Where a production bundle keeps what it serves. Mirrors startServer's own
 * search, plus the server bundle sitting beside it.
 */
function artifactCandidates(): string[][] {
  const bundleDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
  const dirs = [bundleDir, path.join(bundleDir, '..'), path.join(process.cwd(), 'dist')];
  // One list per artifact: the first readable path in each list is used, so a
  // layout that only has one of them still yields a stable id from the other.
  return [
    dirs.map((d) => path.join(d, 'index.html')),
    dirs.map((d) => path.join(d, 'server.cjs')),
  ];
}

/** The first of these paths that can be read, digested. */
function firstDigest(paths: string[]): string | null {
  for (const candidate of paths) {
    try {
      return digest(fs.readFileSync(candidate));
    } catch {
      /* not this one — try the next */
    }
  }
  return null;
}

function computeBuildId(): string {
  const fromEnv = (process.env.BUILD_ID || '').trim();
  if (fromEnv) {
    // Accept an already-well-formed id verbatim so the same value can be read
    // off a deployment log; hash anything else into shape.
    return BUILD_ID_PATTERN.test(fromEnv) ? fromEnv : digest(fromEnv);
  }

  // Digest of digests: order is fixed, so the same pair of artifacts always
  // produces the same id, and a change in EITHER produces a different one.
  const parts = artifactCandidates().map(firstDigest).filter(Boolean);
  if (parts.length) return digest(parts.join('|'));

  // Dev: nothing built to identify, so every restart is its own "deployment".
  return digest(crypto.randomBytes(16));
}

let cached: string | null = null;

/** The build id for this process. Computed once; stable for its lifetime. */
export function buildId(): string {
  if (!cached) cached = computeBuildId();
  return cached;
}
