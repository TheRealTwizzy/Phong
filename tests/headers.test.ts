import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Relay, startRelay } from './helpers/relay';

// Response headers, asserted against a real server rather than by reading the
// middleware. They are set on the APP rather than in `deploy/Caddyfile`
// because the compose stack's Caddy is one of two deployment paths and not the
// primary one — Dokploy's Traefik is, and this repo does not configure it — so
// a header set at the proxy covers whichever path the person editing it
// happened to have in mind.

let relay: Relay;

beforeAll(async () => {
  relay = await startRelay('headers-test');
}, 40000);

afterAll(async () => {
  await relay?.stop();
});

const headers = async (path: string): Promise<Headers> =>
  (await fetch(`${relay.base}${path}`)).headers;

describe('security headers', () => {
  it('sets them on the document', async () => {
    const h = await headers('/');
    expect(h.get('x-content-type-options')).toBe('nosniff');
    expect(h.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(h.get('x-frame-options')).toBe('DENY');
    expect(h.get('x-powered-by')).toBeNull();
  });

  it('sets them on the API too, not only the document', async () => {
    const h = await headers('/api/health');
    expect(h.get('x-content-type-options')).toBe('nosniff');
    expect(h.get('x-frame-options')).toBe('DENY');
    expect(h.get('x-powered-by')).toBeNull();
  });

  it('carries a policy the app can actually run under', async () => {
    const csp = (await headers('/')).get('content-security-policy') || '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    // The relay shares this origin, so the socket has to be reachable.
    expect(csp).toMatch(/connect-src[^;]*wss:/);
    // The avatar pipeline builds a 256x256 PNG in the browser.
    expect(csp).toMatch(/img-src[^;]*blob:/);
    // The equipped cosmetic publishes the design tokens as an inline `style`
    // ATTRIBUTE on #app-root-container. Without this the whole palette falls
    // back to the default — silently, in production, on every theme.
    expect(csp).toMatch(/style-src[^;]*'unsafe-inline'/);
    // And scripts must NOT have the same escape hatch, or the policy says
    // nothing at all.
    expect(csp).toMatch(/script-src 'self'/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-eval'/);
  });

  it('does not claim HSTS over a connection that is not HTTPS', async () => {
    // Sent unconditionally it would be a promise the deployment cannot keep,
    // and it is the header that is hardest to take back.
    expect((await headers('/')).get('strict-transport-security')).toBeNull();
  });
});
