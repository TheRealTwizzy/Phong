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
//  2. The built client's index.html. Vite rewrites the hashed asset names into
//     it on every build, so its digest changes exactly when the client the
//     player would be running changes — and, just as importantly, does NOT
//     change when the same build merely restarts. A crash-loop or a routine
//     container restart must not log anybody out.
//  3. A per-process random value, in dev, where there is no build to hash.
//
// Twelve hex characters: short enough to sit inside a cookie token, and the
// token parser pins that shape.

const BUILD_ID_PATTERN = /^[0-9a-f]{12}$/;

function digest(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 12);
}

/** Where a production bundle keeps the client it serves. Mirrors startServer. */
function distIndexCandidates(): string[] {
  const bundleDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
  return [
    path.join(bundleDir, 'index.html'),
    path.join(bundleDir, '..', 'index.html'),
    path.join(process.cwd(), 'dist', 'index.html'),
  ];
}

function computeBuildId(): string {
  const fromEnv = (process.env.BUILD_ID || '').trim();
  if (fromEnv) {
    // Accept an already-well-formed id verbatim so the same value can be read
    // off a deployment log; hash anything else into shape.
    return BUILD_ID_PATTERN.test(fromEnv) ? fromEnv : digest(fromEnv);
  }

  for (const candidate of distIndexCandidates()) {
    try {
      return digest(fs.readFileSync(candidate));
    } catch {
      /* not this one — try the next */
    }
  }

  // Dev: no build to identify, so every restart is its own "deployment".
  return digest(crypto.randomBytes(16));
}

let cached: string | null = null;

/** The build id for this process. Computed once; stable for its lifetime. */
export function buildId(): string {
  if (!cached) cached = computeBuildId();
  return cached;
}
