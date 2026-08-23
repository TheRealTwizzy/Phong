import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The protocol is written down in three places that have to agree, and until
// now nothing checked that they did.
//
// CLAUDE.md §5 states the rule outright: "Adding a gameplay message means
// handling it in BOTH server.ts and src/net/p2p.ts." The duplication is
// deliberate — a P2P duel never touches the relay, so the replica has to run
// the room's rules itself — and it is exactly the kind of duplication that
// drifts. It already has: P2P scoring never reached the relay, so every P2P
// duel was recorded 0-0 and BOTH players were filed a loss.
//
// This suite reads the source rather than running it. That makes it fast
// enough to be free and, more usefully, it fails at the moment a message is
// added to one side only — which is the moment the drift is cheap to fix,
// rather than the moment a player loses a match to it.
//
// Deliberately tolerant parsing: the point is to name a missing message type,
// not to police formatting. Anything it cannot parse shows up as an empty set
// and fails loudly on the first assertion, which is the right failure.

const root = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

const TYPES = read('src/types.ts');
const SERVER = read('server.ts');
const P2P = read('src/net/p2p.ts');
const APP = read('src/App.tsx');

/** The `type: 'x'` literals inside one exported union. */
function unionMembers(source: string, name: string): string[] {
  const start = source.indexOf(`export type ${name} =`);
  if (start === -1) throw new Error(`${name} not found in src/types.ts`);
  // A union runs to its terminating semicolon at the end of a line — the
  // member lines themselves never end in one.
  const end = source.indexOf(';\n', start);
  const block = source.slice(start, end === -1 ? undefined : end);
  return [...new Set([...block.matchAll(/\{\s*type:\s*'([a-z_]+)'/g)].map((m) => m[1]))].sort();
}

/** The body of a class method, from its signature to the next member. */
function methodBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start === -1) throw new Error(`${signature} not found`);
  const rest = source.slice(start + signature.length);
  // Members of this class are all declared at two-space indent.
  const end = rest.search(/\n {2}(?:public|private|protected|get|set)\s/);
  return end === -1 ? rest : rest.slice(0, end);
}

const matchAllUnique = (source: string, re: RegExp): string[] =>
  [...new Set([...source.matchAll(re)].map((m) => m[1]))].sort();

const CLIENT_MESSAGES = unionMembers(TYPES, 'WSClientMessage');
const SERVER_MESSAGES = unionMembers(TYPES, 'WSServerMessage');

/** What the relay dispatches on: `msg.type === 'x'`. */
const RELAY_HANDLED = matchAllUnique(SERVER, /msg\.type === '([a-z_]+)'/g);

/** What the P2P replica accepts FROM a peer. */
const P2P_HANDLED = matchAllUnique(methodBody(P2P, 'private handlePeerMessage'), /case '([a-z_]+)'/g);

/** What the client acts on. Any `case 'x'` in App.tsx counts — tolerant on purpose. */
const APP_HANDLED = matchAllUnique(APP, /case '([a-z_]+)'/g);

/**
 * The messages a duel's GAMEPLAY is made of — the ones that must work
 * identically whether they arrive over the relay or a DataChannel.
 *
 * Everything else is room management (join, ready, start, config), transport
 * (rtc_signal, ping) or the replica's own report back to the relay
 * (match_sync). Those stay on the WebSocket even in a P2P match, so the
 * replica must NOT answer them — a peer that could set the room's config
 * would be a peer that could change the rules mid-rally.
 */
const GAMEPLAY_MESSAGES = [
  'ball_cross_net',
  'ball_pos',
  'paddle_move',
  'point_scored',
  'quick_chat',
  'rematch_request',
].sort();

describe('the protocol is written down in one place', () => {
  it('parses all three implementations', () => {
    // If any of these came back empty the assertions below would pass
    // vacuously, so the parse is checked before it is trusted.
    expect(CLIENT_MESSAGES.length).toBeGreaterThan(10);
    expect(SERVER_MESSAGES.length).toBeGreaterThan(10);
    expect(RELAY_HANDLED.length).toBeGreaterThan(10);
    expect(P2P_HANDLED.length).toBeGreaterThan(3);
    expect(APP_HANDLED.length).toBeGreaterThan(10);
  });

  it('has the relay handle every client message', () => {
    const unhandled = CLIENT_MESSAGES.filter((t) => !RELAY_HANDLED.includes(t));
    expect(unhandled, `server.ts dispatches nothing for: ${unhandled.join(', ')}`).toEqual([]);
  });

  it('has the client handle every server message', () => {
    // A message the relay sends and App.tsx ignores is a feature that silently
    // does nothing — match_prediction and session_invalid both arrive this way.
    const unhandled = SERVER_MESSAGES.filter((t) => !APP_HANDLED.includes(t));
    expect(unhandled, `App.tsx acts on nothing for: ${unhandled.join(', ')}`).toEqual([]);
  });

  it('never invents a message the union does not declare', () => {
    // src/types.ts is the source of truth (convention §4). A relay branch on a
    // type nobody can send is dead; a client branch on one is a typo that
    // would never fire.
    const relayGhosts = RELAY_HANDLED.filter((t) => !CLIENT_MESSAGES.includes(t));
    expect(relayGhosts, `server.ts branches on undeclared: ${relayGhosts.join(', ')}`).toEqual([]);

    const p2pGhosts = P2P_HANDLED.filter((t) => !CLIENT_MESSAGES.includes(t));
    expect(p2pGhosts, `p2p.ts branches on undeclared: ${p2pGhosts.join(', ')}`).toEqual([]);
  });
});

describe('the P2P replica keeps step with the relay', () => {
  it('handles every gameplay message the relay does', () => {
    const missing = GAMEPLAY_MESSAGES.filter((t) => !P2P_HANDLED.includes(t));
    expect(
      missing,
      `src/net/p2p.ts does not handle: ${missing.join(', ')} — a P2P duel would silently drop it`
    ).toEqual([]);
  });

  it('handles nothing BUT the gameplay messages', () => {
    // The other direction matters just as much. Room management stays on the
    // relay in a P2P match; a replica that answered set_room_config or
    // start_match would let one phone rewrite the match its opponent is
    // playing, with nothing on the server able to see it.
    const extra = P2P_HANDLED.filter((t) => !GAMEPLAY_MESSAGES.includes(t));
    expect(extra, `src/net/p2p.ts answers room-management messages: ${extra.join(', ')}`).toEqual([]);
  });

  it('sends every gameplay message it handles', () => {
    // sendGame() is the other half: a message the replica accepts but never
    // transmits can only ever arrive over the relay, which is the drift again
    // pointing the other way.
    const sendable = methodBody(P2P, 'public sendGame');
    const unsent = GAMEPLAY_MESSAGES.filter((t) => !sendable.includes(`'${t}'`));
    expect(unsent, `p2p.ts sendGame never transmits: ${unsent.join(', ')}`).toEqual([]);
  });

  it('agrees with the relay about which messages are gameplay', () => {
    // Every gameplay message must ALSO be a relay message — P2P is an
    // optimisation over the relay, never a separate protocol. If this fails,
    // a message exists that only works peer-to-peer.
    const relayOnly = GAMEPLAY_MESSAGES.filter((t) => !RELAY_HANDLED.includes(t));
    expect(relayOnly, `gameplay message the relay cannot carry: ${relayOnly.join(', ')}`).toEqual([]);
  });
});

describe('the match key is computed in one place', () => {
  it('is never rebuilt by hand', () => {
    // duelMatchKey() is the idempotency key behind "every match is recorded
    // once", and it is derived independently by the relay, by the record
    // route's cross-check, and by the client. They agree because all three
    // call the same function; a hand-rolled `duel:${...}` anywhere would be
    // the one that drifts, and the match would be paid twice.
    for (const [name, source] of [
      ['server.ts', SERVER],
      ['src/App.tsx', APP],
      ['src/net/p2p.ts', P2P],
    ] as const) {
      const handRolled = [...source.matchAll(/['"`]duel:/g)];
      expect(handRolled.length, `${name} builds a duel match key by hand`).toBe(0);
    }
  });
});
