import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startRelay, sleep, type Relay } from './helpers/relay';

// A play-bot is a CLIENT: it speaks the ordinary protocol into the relay's own
// `wss.on('connection')` handler through an in-process socket. This suite is
// the proof of that claim end to end, against a real server, because nothing
// smaller can make it — `wss` lives inside `startServer`, so a bot can only be
// observed the way a player observes one: by its table showing up.
//
// The load-bearing assertion is the FIRST one. A bot cannot present a device
// cookie — `verifyToken` requires /^dev_[0-9a-f]{18}$/ and a bot id is `bot-`
// by definition — so its identity comes from an in-process registry instead.
// If that ever regresses the relay will simply treat a bot as a cookieless
// socket: it will connect, and then be refused a seat with NEEDS_USERNAME,
// which looks like nothing at all from the outside. No table would appear and
// no error would be logged anywhere a person is looking.

let relay: Relay;
/** The same server with the population OFF — the control for every claim below. */
let control: Relay;

/** The seeded roster's usernames, so a table can be shown to be a BOT's. */
const ROSTER_NAMES = [
  'CircuitPup', 'StaticDrift', 'HaloJet', 'NovaTrace',
  'IronEcho', 'VoltHalcyon', 'ZeroKelvin', 'ObsidianArc',
];

beforeAll(async () => {
  // The roster is seeded at boot, so the bots this asks for already exist.
  [relay, control] = await Promise.all([
    startRelay('botplayers', { PLAY_BOTS: '3' }),
    startRelay('botplayers-off'),
  ]);
}, 90_000);

afterAll(async () => {
  await Promise.all([relay?.stop(), control?.stop()]);
});

/** The open tables in a room, as the lobby browser sees them. */
/**
 * Where an unplaced bot opens its table.
 *
 * `beginner`, not `casual`, and that is the whole point: casual carries
 * `ranked: false`, so a bot playing there would never earn a `rankedGames` and
 * would sit at 0/5 Unranked forever. See `botVenue`.
 */
const BOT_ROOM = 'beginner';

async function tables(venueRoomId: string, on: Relay = relay): Promise<any[]> {
  const res = await fetch(`${on.base}/api/rooms/${venueRoomId}/tables`);
  // A room with `listable: false` is a 404 rather than an empty list, and the
  // two mean different things — collapsing them is how a "no tables here"
  // assertion passes for the wrong reason.
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`tables ${venueRoomId}: ${res.status}`);
  const body = (await res.json()) as { tables?: any[] };
  return body.tables ?? [];
}

describe('the play-bot population', () => {
  it('seats bots that hold listed tables', async () => {
    // The population opens its tables on the first scheduler pass, which runs
    // immediately at boot — but the server is answering /api/health before
    // that pass has necessarily completed, so give it a moment rather than
    // racing it.
    let open: any[] = [];
    for (let i = 0; i < 40 && open.length === 0; i++) {
      open = await tables(BOT_ROOM);
      if (open.length === 0) await sleep(250);
    }
    expect(open.length).toBeGreaterThan(0);
    // And they are BOTS' tables, not some other thing the server opened. A
    // count alone would pass for the wrong reason.
    for (const t of open) expect(ROSTER_NAMES).toContain(t.hostName);
  }, 30_000);

  it('opens no tables at all when the population is off', async () => {
    // The control, and the reason every other assertion here means anything:
    // an identical server with PLAY_BOTS unset shows an empty room. Without
    // this, a suite that silently stopped seating bots would still be green if
    // anything else in the boot path ever opened a table.
    expect(await tables(BOT_ROOM, control)).toEqual([]);
  }, 30_000);

  it('lists them as real, joinable, one-player tables', async () => {
    const open = await tables(BOT_ROOM);
    expect(open.length).toBeGreaterThan(0);
    for (const t of open) {
      // A bot alone at a table is one occupant and a free seat — that is the
      // whole offer. `isFull` here is `join_room`'s own answer, so a row that
      // said otherwise would be a door a player cannot walk through.
      expect(t.playerCount).toBe(1);
      expect(t.isFull).toBe(false);
    }
  }, 30_000);

  it('never opens more tables than the cap allows', async () => {
    const open = await tables(BOT_ROOM);
    // Three bots were asked for, so three is the ceiling here whatever
    // MAX_HOSTED_TABLES is — the cap is a minimum of the two.
    expect(open.length).toBeLessThanOrEqual(3);
  }, 30_000);

  // Bots PLAYING a match to a recorded result is asserted in
  // `scripts/e2e-bots.mjs`, not here. It takes about a minute of wall clock —
  // two bots have to rally out a first-to-5 — and this file is in the FAST
  // layer, which the whole repo runs on every change. A minute is what the
  // separate e2e job is for.

  it('puts its tables only in the room its tier has actually opened', async () => {
    // What this holds is the POLICY — `botVenue` — and not the gate.
    // Worth saying plainly, because the tempting comment here ("this catches
    // an exemption to roomEntryVerdict") would be false: the bots never
    // attempt a bracketed room, so the relay's refusal is never exercised and
    // this would stay green if that gate were removed entirely. An assertion
    // that passes for a reason other than the one written beside it is the
    // failure mode this repo keeps rediscovering.
    //
    // The gate itself is held where it can actually be exercised, over every
    // tier and a spread of levels, in tests/venues.test.ts.
    // Casual is the one an unplaced bot would land in if `botVenue` fell back,
    // and the harder brackets are the ones its tier does not open yet.
    for (const room of ['casual', 'intermediate', 'advanced', 'elite', 'pro']) {
      expect(await tables(room), room).toEqual([]);
    }
  }, 30_000);
});
