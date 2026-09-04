import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { seedTraits } from '../server/playbotTraits';
import { PlaybotDriver } from '../server/playbotDriver';
import { sleep, startRelay, type Relay } from './helpers/relay';

// A bot population starts with the process and stops with it, and neither end
// may cost anybody a rated match.
//
// The SIGTERM case is a claim CLAUDE.md §10 has carried since the
// `shuttingDown` flag shipped, verified at the time with two phones by hand.
// Two bots are two phones that do not need holding, so it is a test now.

let relay: Relay | null = null;

afterEach(async () => {
  await relay?.stop();
  relay = null;
});

let seq = 0;

const bootBot = async (r: Relay, label: string, skill = 0.12): Promise<PlaybotDriver> => {
  seq += 1;
  const username = `${label}${seq}`.slice(0, 16);
  const driver = new PlaybotDriver({
    base: r.base,
    wsUrl: r.wsUrl,
    username,
    traits: { ...seedTraits(username), skill },
  });
  await driver.provision((botId) => {
    const raw = new DatabaseSync(path.join(r.dataDir, 'phong.db'));
    try {
      raw
        .prepare('INSERT OR IGNORE INTO bot_accounts (botId, createdAt) VALUES (?, ?)')
        .run(botId, new Date().toISOString());
    } finally {
      raw.close();
    }
  });
  await driver.connect();
  return driver;
};

const until = async (what: string, cond: () => boolean, ms = 40_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
};

const profileOf = (dir: string, id: string) => {
  const raw = new DatabaseSync(path.join(dir, 'phong.db'), { readOnly: true });
  try {
    return raw
      .prepare('SELECT matchesPlayed, matchesWon, matchesLost, rankMu, abandons FROM players WHERE id = ?')
      .get(id) as {
      matchesPlayed: number;
      matchesWon: number;
      matchesLost: number;
      rankMu: number;
      abandons: number;
    };
  } finally {
    raw.close();
  }
};

describe('a deploy costs nobody a rated match', () => {
  it('charges no abandon when the process is asked to stop mid-duel', async () => {
    // `shutdown()` closes every client, and every close runs `vacateSeat`,
    // whose abandon predicate is true of EVERY live duel. Without the
    // `shuttingDown` flag a redeploy files a real ranked LOSS against
    // whichever seat's close handler ran first and a real WIN to the other,
    // for two players who did not leave.
    relay = await startRelay('playbot-lifecycle');
    const r = relay;
    const host = await bootBot(r, 'ShutHost');
    const guest = await bootBot(r, 'ShutGuest');

    host.host({ winningScore: 15 });
    await until('a room', () => host.roomId !== null);
    guest.join(host.roomId!);
    await until('the match to start', () => host.phase !== 'lobby' && guest.phase !== 'lobby');
    // A ball actually in play is what makes it an abandon — `inPlay` is set by
    // a crossing, so the duel has to be genuinely under way rather than
    // sitting in its countdown.
    await until('a point to be played', () => host.scores[0] + host.scores[1] > 0, 60_000);
    expect(Math.max(...host.scores)).toBeLessThan(15);

    // The PRECONDITION, checked rather than assumed: `abandoned` needs
    // `room.inPlay`, which only a crossing sets. Without this the fixture
    // could be asserting that a match nobody had started charges no abandon,
    // which is true of the empty case and says nothing.
    const live = await fetch(`${r.base}/api/room/${host.roomId}`).then((x) => x.json());
    expect(live.inPlay).toBe(true);

    await r.terminate();

    const a = profileOf(r.dataDir, host.botId);
    const b = profileOf(r.dataDir, guest.botId);
    expect({ played: a.matchesPlayed, lost: a.matchesLost, abandons: a.abandons }).toEqual({
      played: 0, lost: 0, abandons: 0,
    });
    expect({ played: b.matchesPlayed, lost: b.matchesLost, abandons: b.abandons }).toEqual({
      played: 0, lost: 0, abandons: 0,
    });
    // A crash costs the match. It must not also cost the rating.
    expect(a.rankMu).toBe(25);
    expect(b.rankMu).toBe(25);

    host.close();
    guest.close();
  }, 120_000);
});

describe('a deactivated bot waits for the whistle', () => {
  it('finishes the match it is in, and leaves after it', async () => {
    // A bot cut off mid-rally leaves its opponent on a dead court and is
    // judged an ABANDON by the relay: a real ranked loss for a bot that did
    // nothing, and a win handed to whoever it was playing. So deactivation is
    // a request and the whistle grants it.
    relay = await startRelay('playbot-standdown');
    const r = relay;
    const host = await bootBot(r, 'StandHost');
    const guest = await bootBot(r, 'StandGuest');

    host.host({ winningScore: 3 });
    await until('a room', () => host.roomId !== null);
    guest.join(host.roomId!);
    await until('the match to start', () => host.phase !== 'lobby' && guest.phase !== 'lobby');
    await until('a point to be played', () => host.scores[0] + host.scores[1] > 0, 60_000);

    // Asked to stand down mid-match: it stays.
    guest.standDown();
    expect(guest.roomId).not.toBeNull();
    await sleep(500);
    expect(guest.roomId).not.toBeNull();

    await until('the whistle', () => host.phase === 'over', 60_000);
    await until('the guest to have left', () => guest.roomId === null);

    // The match was RECORDED — it finished — and neither side was charged an
    // abandon for the bot standing down after it.
    await until('the result on both profiles', () => {
      const a = profileOf(r.dataDir, host.botId);
      const b = profileOf(r.dataDir, guest.botId);
      return a.matchesPlayed === 1 && b.matchesPlayed === 1;
    });
    expect(profileOf(r.dataDir, host.botId).abandons).toBe(0);
    expect(profileOf(r.dataDir, guest.botId).abandons).toBe(0);

    host.close();
    guest.close();
  }, 120_000);
});
