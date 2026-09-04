/**
 * The version a PLAYER sees, and the one patch notes are keyed on.
 *
 * Deliberately not the build id. That is a 12-hex digest of the built
 * artifacts (server/build.ts) whose job is to retire sessions on every
 * deployment; it changes when a comment changes, it is not ordered, and it
 * means nothing to anybody reading it. A player asking "am I on the new one"
 * needs a number that only moves when the game does.
 *
 * The two are shown together — `v1.0.0 · 4f2a91c0d3e1` — because they answer
 * different questions: the first is what changed, the second is what is
 * running, and a support conversation needs both.
 *
 * package.json is the source of truth and this must match it;
 * tests/version.test.ts holds that, because a version string that disagrees
 * with the package it ships in is worse than no version string. It is
 * duplicated rather than imported because the client bundle and the server
 * bundle are built by different tools, and `resolveJsonModule` in one of them
 * would put the whole manifest into the browser.
 */
export const APP_VERSION = '1.1.1';
