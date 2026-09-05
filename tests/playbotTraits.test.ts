import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import type { MatchEndPayload } from '../src/types';
import { MAX_SPIN_READ, MIN_AI_COMPETENCE } from '../src/game/physics';
import {
  DEFAULT_TRAITS,
  normalizeTraits,
  seedTraits,
  styleFor,
  TRAIT_KEYS,
  type PlaybotTraits,
} from '../server/playbotTraits';

// What a play-bot IS, kept apart from what its results have made of it.
//
// The five proofs below are all one claim in different clothes: skill is
// INTRINSIC CAPABILITY and never a target rank. Creation seeds the curve;
// results alone move a bot on the ladder; and nothing in between may retune a
// bot that is already playing because a controller would like more accounts in
// some band.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phong-playbot-traits-'));
process.env.DATA_DIR = TMP;
const DB_FILE = path.join(TMP, 'phong.db');

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let db: typeof import('../server/db').db;

beforeAll(async () => {
  ({ db } = await import('../server/db'));
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

let seq = 0;
const newBot = (traits?: Partial<PlaybotTraits>) => {
  seq += 1;
  const id = `bot-trait-${seq}`;
  db.insertBot({ id, username: `TraitBot${seq}`, mu: 25, traits });
  return id;
};

describe('seeding', () => {
  it('is deterministic from the id, so a rebuilt roster plays the same', () => {
    // A bot a player recognises plays the way they remember, without the seed
    // being stored twice.
    expect(seedTraits('bot-alpha')).toEqual(seedTraits('bot-alpha'));
    expect(seedTraits('bot-alpha')).not.toEqual(seedTraits('bot-beta'));
  });

  it('keeps every trait inside its band', () => {
    for (let i = 0; i < 200; i += 1) {
      const t = seedTraits(`bot-band-${i}`);
      expect(t.skill).toBeGreaterThanOrEqual(MIN_AI_COMPETENCE);
      expect(t.skill).toBeLessThanOrEqual(1);
      expect(t.spinRead).toBeLessThanOrEqual(MAX_SPIN_READ);
      for (const key of TRAIT_KEYS) {
        expect({ key, ok: Number.isFinite(t[key]) }).toEqual({ key, ok: true });
      }
    }
  });

  it('spreads a population rather than clustering it', () => {
    // The curve is established at creation, so a seeder that returned nearly
    // the same bot every time would leave the ladder with one rung on it.
    const skills = Array.from({ length: 200 }, (_, i) => seedTraits(`bot-spread-${i}`).skill);
    const min = Math.min(...skills);
    const max = Math.max(...skills);
    expect(max - min).toBeGreaterThan(0.5);
    const distinct = new Set(skills.map((s) => s.toFixed(3)));
    expect(distinct.size).toBeGreaterThan(150);
  });

  it('is written by CREATION and by nothing else, anywhere in the server', () => {
    // The rule §4.13 turns on, and the trait module alone cannot hold it: the
    // module has no writer because the DATABASE owns the write, so a test that
    // only reads playbotTraits.ts passes while a `setBotSkill` sits in db.ts.
    // Measured — adding one reddened nothing until this existed.
    //
    // So: no UPDATE against bot_accounts anywhere in the server. That covers
    // both ways the rule is broken — a controller retuning a live bot's
    // competence, and (the step-14 case) a hand-written rewrite sweeping the
    // roster into an account move.
    const files = ['db.ts', 'playbotTraits.ts', 'bots.ts', 'matchmaking.ts', 'room.ts', 'auth.ts']
      .map((f) => path.join(process.cwd(), 'server', f))
      .concat(path.join(process.cwd(), 'server.ts'))
      .filter((f) => fs.existsSync(f));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const code = fs
        .readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/^\s*--.*$/gm, '');
      expect({ file: path.basename(file), updates: /UPDATE\s+bot_accounts/i.test(code) }).toEqual({
        file: path.basename(file),
        updates: false,
      });
    }

    // ...and every INSERT that carries traits is a CREATION path, named. Two
    // of them, because there are two ways an account becomes a bot: the
    // curated roster (`insertBot`, seeded at boot) and a play-bot the
    // supervisor onboards (`rememberPlaybot`). The backfill is the third
    // writer of this table and carries an id and a timestamp only, so a
    // claimed legacy row reads as the unremarkable default rather than as an
    // extreme.
    //
    // Asserted by the ENCLOSING METHOD rather than by a count, so a trait
    // insert that appears inside anything but a creation path reddens even if
    // the total happens to stay the same.
    const dbSrc = fs.readFileSync(path.join(process.cwd(), 'server', 'db.ts'), 'utf8');
    const parts = dbSrc.split('INSERT OR IGNORE INTO bot_accounts');
    expect(parts.length - 1).toBeGreaterThan(0);
    const owners: string[] = [];
    for (let i = 1; i < parts.length; i++) {
      if (!parts[i].slice(0, 200).includes('TRAIT_KEYS')) continue;
      const before = parts.slice(0, i).join('INSERT OR IGNORE INTO bot_accounts');
      const method = [...before.matchAll(/public\s+(\w+)\s*\(/g)].pop();
      owners.push(method ? method[1] : '<top level>');
    }
    expect(owners.sort()).toEqual(['insertBot', 'rememberPlaybot']);
  });

  it('has no function that takes a target rank, a band or a demand signal', () => {
    // The ABSENCE is the design (§4.13). A controller may choose which
    // existing bots play and where; it may not assign a rank, clamp one toward
    // a target, or retune competence to manufacture a ladder distribution — so
    // there must be nothing here for it to call.
    const src = fs.readFileSync(path.join(process.cwd(), 'server', 'playbotTraits.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const name of ['targetRank', 'towardTier', 'retune', 'steer', 'demand', 'setSkill']) {
      expect({ name, present: code.includes(name) }).toEqual({ name, present: false });
    }
    // And the only exported function that PRODUCES traits takes one argument:
    // an id. Nothing else can reach in.
    expect(seedTraits.length).toBe(1);
  });
});

describe('normalizing', () => {
  it('falls back to an unremarkable default for anything missing or junk', () => {
    expect(normalizeTraits(null)).toEqual(DEFAULT_TRAITS);
    expect(normalizeTraits({})).toEqual(DEFAULT_TRAITS);
    expect(normalizeTraits({ skill: Number.NaN }).skill).toBe(DEFAULT_TRAITS.skill);
    expect(normalizeTraits({ skill: 'fast' as unknown as number }).skill).toBe(DEFAULT_TRAITS.skill);
  });

  it('clamps rather than refusing', () => {
    expect(normalizeTraits({ skill: 9 }).skill).toBe(1);
    expect(normalizeTraits({ skill: -9 }).skill).toBe(MIN_AI_COMPETENCE);
    expect(normalizeTraits({ spinRead: 9 }).spinRead).toBe(MAX_SPIN_READ);
  });

  it('never lets skill fall below the competence floor', () => {
    // A bot that cannot return a ball is not an opponent, it is a walkover —
    // and the ladder would rate it as one, handing free rating to anybody it
    // was paired with.
    expect(normalizeTraits({ skill: 0 }).skill).toBe(MIN_AI_COMPETENCE);
  });
});

describe('traits are persistent', () => {
  it('survive a round trip through the database', () => {
    const traits = seedTraits('bot-roundtrip');
    const id = newBot(traits);
    const read = db.botTraits(id);
    for (const key of TRAIT_KEYS) {
      expect({ key, v: Number(read[key].toFixed(9)) }).toEqual({
        key,
        v: Number(traits[key].toFixed(9)),
      });
    }
  });

  it('survive a restart', async () => {
    const traits = seedTraits('bot-restart');
    const id = newBot(traits);
    const before = db.botTraits(id);
    const { db: booted } = await import('../server/db');
    expect(booted.botTraits(id)).toEqual(before);
  });

  it('survive the matches the bot plays', () => {
    // The proof that results move the RATING and not the bot. Ten matches,
    // won and lost, and the traits are the ones it was created with.
    const id = newBot(seedTraits('bot-plays'));
    const before = db.botTraits(id);
    const ratingBefore = db.getProfile(id).rankMu;
    for (let i = 0; i < 10; i += 1) {
      seq += 1;
      db.recordMatch(
        {
          playerId: id, username: `TraitBot`, playerScore: 5, opponentScore: 2,
          bestStreak: 3, endStreak: 0, earnedStreak: 3, mode: 'multiplayer',
          isWinner: i % 2 === 0, matchKey: `trait:match:${seq}`,
        } as MatchEndPayload,
        { opponentRating: { mu: 25, sigma: 3 }, opponentRankRating: { mu: 25, sigma: 3 } } as never
      );
    }
    expect(db.getProfile(id).rankMu).not.toBe(ratingBefore);
    expect(db.botTraits(id)).toEqual(before);
  });

  it('are absent from the profile a client can see', () => {
    // Traits are how a bot plays, not part of its public record. A client that
    // could read them could predict every rally it is about to be served.
    const id = newBot(seedTraits('bot-private'));
    const shape = JSON.stringify(db.getPublicProfile(id) ?? {});
    for (const key of TRAIT_KEYS) {
      expect({ key, leaked: shape.includes(key) }).toEqual({ key, leaked: false });
    }
  });
});

describe('rank is earned, never seeded', () => {
  it('lets a bot seeded high fall below its estimate on results alone', () => {
    // insertBot's `mu` is a starting ESTIMATE, not a rank and not a floor.
    const id = newBot(seedTraits('bot-falls'));
    const raw = new DatabaseSync(DB_FILE);
    try {
      raw.prepare('UPDATE players SET rankMu = 25, mmrMu = 25, rankSigma = 4, mmrSigma = 4, rankedGames = 10 WHERE id = ?').run(id);
    } finally {
      raw.close();
    }
    for (let i = 0; i < 12; i += 1) {
      seq += 1;
      db.recordMatch(
        {
          playerId: id, username: 'Faller', playerScore: 1, opponentScore: 5,
          bestStreak: 1, endStreak: 0, earnedStreak: 1, mode: 'multiplayer',
          isWinner: false, matchKey: `trait:fall:${seq}`,
        } as MatchEndPayload,
        { opponentRating: { mu: 25, sigma: 3 }, opponentRankRating: { mu: 25, sigma: 3 } } as never
      );
    }
    expect(db.getProfile(id).rankMu).toBeLessThan(25);
  });

  it('lets a bot seeded low climb past it', () => {
    const id = newBot(seedTraits('bot-climbs'));
    const raw = new DatabaseSync(DB_FILE);
    try {
      raw.prepare('UPDATE players SET rankMu = 20, mmrMu = 20, rankSigma = 4, mmrSigma = 4, rankedGames = 10 WHERE id = ?').run(id);
    } finally {
      raw.close();
    }
    for (let i = 0; i < 12; i += 1) {
      seq += 1;
      db.recordMatch(
        {
          playerId: id, username: 'Climber', playerScore: 5, opponentScore: 1,
          bestStreak: 5, endStreak: 0, earnedStreak: 5, mode: 'multiplayer',
          isWinner: true, matchKey: `trait:climb:${seq}`,
        } as MatchEndPayload,
        { opponentRating: { mu: 28, sigma: 3 }, opponentRankRating: { mu: 28, sigma: 3 } } as never
      );
    }
    expect(db.getProfile(id).rankMu).toBeGreaterThan(20);
  });

  it('leaves two bots at EQUAL earned rank playing differently', () => {
    // The separation, from the other side: rank is what results made, style is
    // what the bot is, and two accounts that have converged on one rating still
    // play nothing alike. A design that derived style from rank would make this
    // impossible by construction.
    const calm = newBot({ ...seedTraits('bot-calm'), skill: 0.5, volatility: 0.0, aggression: 0.05 });
    const wild = newBot({ ...seedTraits('bot-wild'), skill: 0.5, volatility: 0.11, aggression: 0.95 });
    const raw = new DatabaseSync(DB_FILE);
    try {
      for (const id of [calm, wild]) {
        raw.prepare('UPDATE players SET rankMu = 26, mmrMu = 26 WHERE id = ?').run(id);
      }
    } finally {
      raw.close();
    }
    expect(db.getProfile(calm).rankMu).toBe(db.getProfile(wild).rankMu);
    expect(db.botTraits(calm).skill).toBe(db.botTraits(wild).skill);
    expect(styleFor(db.botTraits(calm))).not.toEqual(styleFor(db.botTraits(wild)));
  });

  it('takes competence from the TRAIT and not from the rating', () => {
    // The reversal from the solo AI, and the one that matters most: solo
    // derives competence from the player's mu so the ladder adapts. A bot must
    // not, or its strength would chase its own results and the rating would
    // stop measuring anything.
    //
    // Asserted as an absence, because the read path is the driver's (step 20)
    // and this is what it may not do: nothing in the trait module consults a
    // rating at all.
    const src = fs.readFileSync(path.join(process.cwd(), 'server', 'playbotTraits.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const name of ['rankMu', 'mmrMu', 'competenceForMu', 'effectiveAiMu', 'tierFor']) {
      expect({ name, present: code.includes(name) }).toEqual({ name, present: false });
    }
  });
});

// Three wirings that a review found MISSING and that have nothing to observe
// at runtime without new plumbing. Read here rather than left to prose, the
// same idiom step 9's case C and step 15 use — and each one is the same shape
// as the rest of this feature's findings: a module that was right, and a
// composition that never called it.
describe('what the composition has to pass along', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  it('gives OpponentAI the bot’s persisted spinRead', () => {
    // `styleFor` returns an AIStyle — volatility and aggression and nothing
    // else — so a spinRead folded into it is dropped, and the AI derived its
    // spin reading from competence alone. Two bots differing ONLY in that
    // seeded trait then played identically against spin, which makes it an
    // inert trait rather than a style.
    expect(read('server/playbotDriver.ts')).toMatch(/spinRead:\s*opts\.traits\.spinRead/);
    // ...and the AI has to prefer it over the competence-derived value.
    expect(read('src/game/physics.ts')).toMatch(/this\.override\?\.spinRead \?\? p\.spinRead/);
  });

  it('tells the controller which band is thin', () => {
    // `liveStateFrom` has always accepted `bandCentre` and the production
    // wiring never supplied one, so `targetActivation` fell back to START_MU
    // on every tick: a high- or low-rated human queued and the middle of the
    // roster was activated, possibly outside even the matcher's widest band.
    const call = /liveStateFrom\(\{([\s\S]*?)\n      \}\)/.exec(read('server.ts'));
    expect(call, 'server.ts no longer builds a LiveState').toBeTruthy();
    expect(call![1]).toMatch(/bandCentre:/);
  });

  it('counts as demand only a table a bot could actually join', () => {
    // A human playing the MACHINE has one real player at their table, so it
    // read as somebody waiting for an opponent -- and mid-match the machine's
    // chair is not claimable, so the bot activated to serve them could not
    // join and hosted a table of its own instead. Enough concurrent CPU
    // players would activate the whole roster as though all of them were
    // waiting, which is the fading population bound defeated by people who are
    // not waiting at all.
    //
    // The same predicate the LISTING asks, so the row a bot can tap and the
    // demand that sends it there cannot disagree -- which is the venue filter
    // below, one rule up.
    const call = /liveStateFrom\(\{([\s\S]*?)\n      \}\)/.exec(read('server.ts'));
    expect(call![1]).toMatch(/!r\.config\.cpu \|\| cpuSeatClaimable\(r\)/);
  });

  it('counts as demand only the venues the dispatch will search', () => {
    // `openTable` looks in OPEN_VENUES and nowhere else, while the demand
    // count took every public room — so a human hosting in `intermediate`
    // activated a bot that searched two rooms it was never in, found nothing,
    // and opened a table of its own while that human went on waiting.
    // Narrowed at the count rather than widened at the search: the other
    // brackets gate who may PLAY, so serving them needs the bot's own tier
    // judged, which is a design step and not this fix.
    const call = /liveStateFrom\(\{([\s\S]*?)\n      \}\)/.exec(read('server.ts'));
    expect(call![1]).toMatch(/OPEN_VENUES\.includes\(r\.venueRoomId\)/);
  });

  it('clamps a bot’s return into the match’s own speed band', () => {
    // `checkPaddleCollision` can return a pace BELOW a raised `ballSpeedMin`
    // once spin has scrubbed it, and App.tsx clamps at the equivalent
    // contact — so without this the two halves of one rally obey different
    // speed rules, and the rules are a term of the match rather than of the
    // court. Read rather than driven: reaching it needs a spin-scrubbed
    // contact under a raised floor, which no fixture produces reliably.
    expect(read('server/playbotDriver.ts')).toMatch(/clampBallSpeed\(hit\.speed, this\.rules\)/);
  });

  it('holds a dispatch for the whole of it, not for a guessed grace', () => {
    // `tickSafely`'s guard covers the TICK's body, and `tick()` is synchronous
    // -- it fires its dispatches with `void` -- so `ticking` is false again
    // while every one of them is still awaiting `resume`/`connect`. The only
    // thing standing there was `dispatchedAt` plus a five-second grace, which
    // is a bet on how slow loopback can be: past it, the next tick dispatches
    // the same bot, closes and REPLACES `m.driver`, and the first
    // continuation then drives the replacement -- marking an unconnected
    // driver queued and leaving its own live socket managed by nobody.
    //
    // Read rather than driven: reproducing it needs a connect held open past
    // the grace, which is a bet in the other direction.
    const src = read('server/playbotSupervisor.ts');
    expect(src).toMatch(/if \(m\.dispatching\) return;/);
    expect(src).toMatch(/m\.dispatching = true;[\s\S]*?finally \{[\s\S]*?m\.dispatching = false;/);
  });

  it('lets go of idle drivers AFTER it has dispatched', () => {
    // The reap ran FIRST and opened with `m.retiring &&`, and both halves were
    // wrong together. The condition made it unreachable for a driver the
    // controller had simply stopped naming -- `deactivate` filters the ENGAGED
    // set, so a finished court and a stale empty lobby are exactly the states
    // that can never be named -- and the position is what makes the broader
    // condition safe, since a bot dispatched on this tick must not have the
    // socket it is about to reuse closed underneath it.
    //
    // Read rather than driven, because ORDER is the assertion: once the reap
    // is correct, a behavioural test passes from either position. What only
    // the source can say is that it sits below the dispatch.
    const src = read('server/playbotSupervisor.ts');
    // Bounded to tick()'s OWN body, at the method that follows it. Sliced to
    // end-of-file this test is vacuous in the one direction that matters:
    // `dispatchInner` closes a dead driver with the same `m.driver.close();`,
    // and it sits below tick(), so deleting the reap outright would match
    // THAT one, still be "after the dispatch", and pass.
    const start = src.indexOf('public tick(): void');
    const end = src.indexOf('private async tickSafely', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const tick = src.slice(start, end);
    const dispatched = tick.indexOf('void this.dispatch(m, action);');
    // Anchored on the CLOSE and not on the condition text: this test is about
    // where the reap sits, so wording it against the predicate would make it
    // redden for a condition change too, and then neither failure would say
    // which of the two things had moved.
    const reaped = tick.indexOf('m.driver.close();');
    expect(dispatched).toBeGreaterThan(-1);
    expect(reaped).toBeGreaterThan(-1);
    expect(reaped).toBeGreaterThan(dispatched);
  });

  it('resets a return at the same paddle edge the browser does', () => {
    // The driver put the ball back at `PADDLE_Y - radius - 0.001` where the
    // browser uses `PADDLE_Y - PADDLE_HEIGHT / 2 - radius`, so every bot return
    // started 0.011 court units FARTHER from the net than the same contact on a
    // phone -- a longer run at it, and at a steep angle up to 0.021 of court
    // width of drift by the time it crossed, which is enough to change which
    // wall it finds first.
    //
    // A source read because the divergence never reaches the wire: a crossing
    // carries `x`, `vx`, `vy`, `spin` and `speedMultiplier` and no `y` at all,
    // so there is no message in which the two courts disagree. What is
    // assertable is that both files spell the reset the same way.
    //
    // Comments are stripped for the same reason `tests/legal.test.ts` strips
    // them: prose is not code, and the note beside the fix quotes the old
    // expression to say what it replaced. Unstripped, the absence check below
    // fails on the explanation of the very thing it is checking is gone.
    const strip = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const drv = strip(read('server/playbotDriver.ts'));
    const app = strip(read('src/App.tsx'));
    expect(app).toContain('PADDLE_Y - PADDLE_HEIGHT / 2 - b.radius');
    expect(drv).toContain('PADDLE_Y - PADDLE_HEIGHT / 2 - radius');
    // And the old spelling is gone rather than merely joined: left in place
    // beside the new one this would pass with the divergence still shipping.
    expect(drv).not.toContain('PADDLE_Y - radius - 0.001');
  });

  it('spawns an incoming ball at the offset every browser court uses', () => {
    // A crossing carries no `y`, so the receiving half decides where the ball
    // appears — and the browser has said 0.02 at all three of its own entry
    // points since long before there were bots (`ball_incoming`, and both
    // halves of the solo cross-net). The driver said 0, so every ball a human
    // put over reached the bot's paddle with 0.02 of court more to travel:
    // more time to read it, and a different x by the time it arrived, since
    // the extra run is taken at the shot's own angle.
    //
    // A source read for the reason the paddle-edge one above is: `y` is not on
    // the wire, so there is no message in which the two courts can be caught
    // disagreeing. What IS assertable is that one exported constant is the
    // only thing either file spells.
    const strip = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const drv = strip(read('server/playbotDriver.ts'));
    const app = strip(read('src/App.tsx'));
    expect(drv).toContain('y: BALL_ENTRY_Y');
    expect(app).toContain('y: BALL_ENTRY_Y');
    // The literals are GONE rather than joined by the constant. Left in place,
    // this passes with the divergence still shipping — which is the whole of
    // what went wrong here, since 0 and 0.02 both look like a net line.
    expect(drv).not.toMatch(/\by: 0,/);
    expect(app).not.toMatch(/\by: 0\.02,/);
  });

  it('refreshes that bracket state on every roster read', () => {
    // The half the fifth round's own fix left open, and the note beside it
    // said the opposite: `roster()` reloads the store every tick and took `mu`
    // and `recentMatches` off the fresh row while DISCARDING `level` and
    // `tier`. So `venuesFor` judged every bot by whatever it was at startup,
    // and a bot provisioned in this process stayed level 1 and unranked for
    // good -- one that climbed past Contender went on being sent at
    // `beginner`, was refused, and left its human unserved until a restart.
    const src = read('server/playbotSupervisor.ts');
    const body = /private roster\(\)[\s\S]*?\n  \}/.exec(src);
    expect(body, 'roster() is gone').toBeTruthy();
    expect(body![0]).toMatch(/m\.level = row\.level/);
    expect(body![0]).toMatch(/m\.tier = row\.tier/);
  });

  it('never walks up to the table it is already sitting at', () => {
    // A bot in seat 1 whose host has left holds a table that is still listed,
    // with `hostId: null` -- which is not `selfId`, so a host-only comparison
    // kept it and the bot could pick its OWN room as the fallback. `join_room`
    // answers ALREADY_AT_TABLE for the room a socket already sits in, the
    // driver does not transition on it, and the same room is chosen again on
    // every tick.
    const src = read('server/playbotSupervisor.ts');
    expect(src).toMatch(/t\.id === ownRoomId/);
    expect(src).toMatch(/this\.openTable\(\s*venue,\s*allowed,\s*m\.botId,\s*m\.driver\.roomId\s*\)/);
  });

  it('offers a bot only the venues its own tier may enter', () => {
    // `chooseVenue`'s `allowed` is documented as the set the bracket gate
    // permits, supplied by the caller — and the caller passed the raw list.
    // A refused HOST fell back to casual; a refused JOIN had nowhere to fall
    // back TO and retried the same forbidden table on every tick while the
    // human it was sent to serve went on waiting. Both call sites take the
    // filtered list now, which is the root the two fallbacks were patching.
    const src = read('server/playbotSupervisor.ts');
    expect(src).toMatch(/const allowed = this\.venuesFor\(m\)/);
    expect(src).toMatch(/roomEntryVerdict\(roomById\(id\), who\)\.ok/);
    // BOTH consumers, or the half that was left raw is the half that breaks.
    expect(src).toMatch(/chooseVenue\(\{[\s\S]*?allowed,[\s\S]*?\}\)/);
    expect(src).toMatch(/this\.openTable\(\s*venue,\s*allowed,\s*m\.botId/);
  });

  it('chooses its table through the preference rather than by arrival order', () => {
    // The behaviour is `preferHumanTable`'s and is unit-tested there, across
    // venues. What can only be read here is that `openTable` GATHERS and then
    // asks it — the bug was a `return` inside the venue loop, which no test of
    // a pure chooser can see.
    const src = read('server/playbotSupervisor.ts');
    expect(src).toMatch(/return preferHumanTable\(free, /);
    expect(src).toMatch(/free\.push\(\{ id: t\.id, seatedIds \}\)/);
  });
});
