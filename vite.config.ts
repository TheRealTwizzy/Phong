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
// because this project bets on Playwright for UI — twenty-one browser suites drive
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
  // The cookie and session layer — the one file where a regression is somebody
  // losing their account. The STATEMENT number is low and honest about why:
  // most of this file is exercised by the suites that boot a real server, and
  // those run out of process where V8 cannot see them (TESTING.md says the
  // same about `server.ts`). The BRANCH floor is the real one — the decisions
  // this file makes are covered, and that is what must not slide.
  'server/auth.ts': { statements: 35, branches: 90 },
  // Small, pure, and 100% today. Floored now that the report can see them at
  // all: they were inside `src/components`, which the include never matched,
  // so thirteen passing tests read as absent.
  'src/components/ui/meterMemory.ts': { statements: 95, branches: 95 },
  'src/components/ui/ladderTone.ts': { statements: 95, branches: 95 },
  'server/image.ts': { statements: 90, branches: 88 },
  'server/bots.ts': { statements: 100, branches: 100 },
  // Pure and complete, like transform.ts. It is small enough that anything
  // below 100 means a rule went in without a case, and the rules here decide
  // whether three unauthenticated routes have a ceiling at all.
  'server/rateLimit.ts': { statements: 100, branches: 100 },
};

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        output: {
          /**
           * Split the libraries out of the app chunk.
           *
           * Everything shipped as one 820KB file, so every deployment — and
           * this project force-refreshes sessions on every deployment by
           * design (see `server/build.ts`) — invalidated React, Motion and the
           * icon set along with the twenty lines of game code that actually
           * changed. Separated, a deploy re-downloads the app chunk and the
           * vendor chunk stays in the browser cache it was already in, which
           * is what the `immutable, max-age=1y` on `/assets` is for.
           *
           * Deliberately coarse: three buckets, matched on the dependency
           * path, so nothing here has to be kept in step with the import graph
           * — a library that moves between them still lands in a vendor chunk.
           */
          manualChunks(id: string) {
            if (!id.includes('node_modules')) return undefined;
            if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react';
            if (/[\\/]node_modules[\\/](motion|framer-motion|canvas-confetti)/.test(id)) return 'motion';
            return 'vendor';
          },
        },
      },
    },
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
          // The non-component logic that lives among the components:
          // meterMemory, ladderTone and motion are plain modules with real
          // unit tests, and the report could not see any of it. A module with
          // thirteen tests reading as absent is the same blind spot as one
          // with none.
          'src/components/**/*.ts',
          // 600-odd lines with no tests at all. Reported rather than floored,
          // deliberately: procedural Web Audio needs an AudioContext, so this
          // is honest visibility of a gap and not a threshold anybody is being
          // asked to meet today.
          'src/audio/**/*.ts',
          'server/**/*.ts',
        ],
        exclude: ['src/types.ts', 'src/vite-env.d.ts'],
        reporter: ['text', 'json-summary'],
        thresholds: FLOORS,
      },
    },
  };
});
