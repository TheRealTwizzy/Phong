import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
// `vitest/config` re-exports Vite's defineConfig and adds the `test` key, so
// one file still configures both the app build and the test run. Vitest is a
// devDependency and this file is only ever loaded by tooling.
import { defineConfig } from 'vitest/config';

// Coverage floors, and why they are shaped like this.
//
// There is deliberately NO global threshold. Most of src/components is at zero
// because this project bets on Playwright for UI — eleven browser suites drive
// the real thing against a real server — and a global number would either fail
// on that bet or be set so low it measured nothing.
//
// What is gated is the shared pure logic: the rules that decide ratings,
// unlocks, match identity and what the relay believes. Those are cheap to test
// and expensive to get wrong. Each floor sits a few points under where the
// module actually is, so the ratchet holds without going red on the next
// honest refactor. Raise one when a module genuinely improves; lower one only
// with a reason in the commit message.
const FLOORS = {
  // The rules everything else is derived from.
  'src/rating.ts': { statements: 90, branches: 90 },
  'src/matchRules.ts': { statements: 95, branches: 90 },
  'src/achievements.ts': { statements: 95, branches: 90 },
  'src/profileRules.ts': { statements: 100, branches: 95 },
  // The bracket predicate the menu and the relay share. A room the menu draws
  // as open is a room the server has to seat, so this is cheap to test and
  // expensive to get wrong — the same bet as matchRules.ts beside it.
  'src/venues.ts': { statements: 95, branches: 85 },
  // Thirty lines of arithmetic that decides every page change on the menu, and
  // the ONLY place the swipe thresholds are asserted at all: `touch-action` is
  // enforced by the compositor hit-test, and CDP's Input.dispatchTouchEvent
  // injects downstream of it (measured — it scrolls a `touch-action: none`
  // element), so the browser layer can prove the wiring and never the rules.
  'src/gestures.ts': { statements: 95, branches: 95 },
  'src/game/physics.ts': { statements: 90, branches: 88 },
  'src/game/cosmetics.ts': { statements: 95, branches: 95 },
  // Forty lines of arithmetic that the contrast and distinctness floors both
  // stand on, and that decides every colour the app paints. A gap here is a
  // gap in both floors at once.
  'src/game/color.ts': { statements: 95, branches: 95 },
  'src/game/missions.ts': { statements: 80, branches: 80 },
  'src/media/qr.ts': { statements: 95, branches: 95 },
  // The client networking layer: every one of these was under 55% before the
  // coverage pass that set these floors.
  'src/net/matchRecord.ts': { statements: 90, branches: 88 },
  'src/net/session.ts': { statements: 90, branches: 75 },
  // The relay's refusals, in the player's language. Small, and shared by two
  // surfaces that must not disagree: the menu's bracket lock and the relay's
  // bracket refusal render from one `lockReason`, and the verdict now crosses
  // the WIRE, so a malformed one is a thing that reaches this file.
  'src/net/relayErrors.ts': { statements: 95, branches: 90 },
  // p2p.ts duplicates the relay's rules by design. The untested remainder is
  // WebRTC signalling and teardown, which a fake peer connection can only say
  // so much about; the rules themselves are covered.
  'src/net/p2p.ts': { statements: 65, branches: 70 },
  // Server-side.
  'server/transform.ts': { statements: 100, branches: 100 },
  'server/room.ts': { statements: 95, branches: 92 },
  // Pairing rules, pure for the same reason room.ts is: who the queue puts
  // together is worth arguing about in a test rather than on a live server.
  'server/matchmaking.ts': { statements: 95, branches: 92 },
  'server/db.ts': { statements: 90, branches: 88 },
  'server/image.ts': { statements: 90, branches: 88 },
  'server/bots.ts': { statements: 100, branches: 100 },
};

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
    test: {
      coverage: {
        provider: 'v8' as const,
        // Report on everything that could reasonably be unit-tested, so a
        // module sliding is visible even where it is not gated. Left out:
        // the i18n dictionary (2600 lines of data that would dominate the
        // total without saying anything about behaviour) and the components,
        // which are Playwright's job.
        include: [
          'src/*.ts',
          'src/game/**/*.ts',
          'src/media/**/*.ts',
          'src/net/**/*.ts',
          'server/**/*.ts',
        ],
        exclude: ['src/types.ts', 'src/vite-env.d.ts'],
        reporter: ['text', 'json-summary'],
        thresholds: FLOORS,
      },
    },
  };
});
