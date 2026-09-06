// WHICH existing bots should be playing, and where — never how good they are.
//
// Pure over an injected snapshot, the shape `server/matchmaking.ts`,
// `server/room.ts` and `server/playbotPolicy.ts` already use.
//
// SKILL-CURVE DISTRIBUTION IS A SELECTION PROBLEM, NEVER A TUNING ONE. The
// controller picks which of the bots that already exist to switch on, and the
// curve is the population it already has. If a band is thin and no bot's
// EARNED rating suits it, the answer is seeding more bots at creation — not
// retuning one that is already playing. So there is nothing here that writes a
// trait, a rating or a result, and `PopulationTarget` names bots and venues
// and nothing about outcomes.
//
// HUMANS ALWAYS TAKE PRIORITY, and that is a rule about DISPLACEMENT rather
// than about participation. The controller may and should activate bots to
// serve waiting human demand — that is most of what it is for. What it may not
// do is cause a bot to displace either participant in an otherwise valid
// human-vs-human pairing. Read it as *a bot never takes a seat a person would
// have had*, never as *a bot may not give a person a game*.

import type { PlaybotTraits } from './playbotTraits';
import { roomById, roomEntryVerdict, roomsOf } from '../src/venues';

/**
 * Who a bracket judges — level and visible tier.
 *
 * Derived from `roomEntryVerdict`'s own parameter rather than naming `Tier`,
 * so this module still imports nothing from `../src/rating`. That absence is
 * asserted: the guard next door reads this file for a write path to a rating,
 * and the cheapest way to keep it honest is to have no reason to reach for
 * that module at all.
 */
type Bracketed = NonNullable<Parameters<typeof roomEntryVerdict>[1]>;

/** One bot the controller could switch on. */
export interface PopulationBot {
  id: string;
  traits: PlaybotTraits;
  /**
   * Its EARNED rating, on the estimator the MATCHER pairs on.
   *
   * The controller SELECTS on this and never writes it: a bot suits a thin
   * band or it does not, and if none does the answer is more bots rather than
   * a different bot. The estimator is the matchmaker's own, because the only
   * thing this is compared against is `bandCentre` — a waiting human's
   * `matchmakingRating` — and the two estimators diverge by design.
   */
  mu: number;
  /** Matches it has played in the recent window, for spreading participation. */
  recentMatches: number;
  /**
   * When it was last SENT somewhere, ms epoch, or 0 for never.
   *
   * The attempt rather than the result, deliberately. A bot whose connect
   * keeps failing records no match, so `recentMatches` never rises — and with
   * that as the only idle key it stays permanently first in line and takes
   * every slot for the life of the process. Rotating on the dispatch is what
   * makes participation spread rather than reward never finishing anything.
   */
  lastDispatchedAt: number;
  /**
   * The venues the bracket gate would actually let it into, as the caller
   * judges them — the same `allowed` list `chooseVenue` is handed.
   *
   * SELECTION again, never tuning: this does not decide how good a bot is or
   * where it belongs, it reports which doors are open to the rating it has
   * already earned. Without it a table slot was spent on whoever sat nearest
   * the band centre, the relay refused the join, and the human that
   * activation existed for went on waiting.
   */
  venues: string[];
}

export interface PopulationSnapshot {
  /** Humans connected right now. */
  humansOnline: number;
  /** Humans waiting in the ranked queue. */
  queuedHumans: number;
  /** Bots waiting in it too — supply already spent on those humans. */
  queuedBots: number;
  /** How long the longest-waiting human has waited, ms. */
  longestWaitMs: number;
  /**
   * Public tables sitting with a free playing seat — ONE ENTRY PER TABLE,
   * naming the venue it is in.
   *
   * A count and a venue set as two fields is a pair that can disagree, and the
   * disagreement is silent: a fixture saying "one table" and "nowhere" reads
   * as demand no bot is eligible for. The list is both answers at once — its
   * length is how many there are — so the illegal state is unrepresentable,
   * which is the same reason a socket's seat is one union rather than two
   * nullables (CLAUDE.md §1).
   *
   * The venue matters because a bracketed room refuses a BOT on its own tier
   * exactly as it refuses a player on theirs.
   */
  openTableVenues: string[];
  /**
   * Bots already playing or seated, and therefore UNAVAILABLE.
   *
   * The two readings coincide by construction and that is load-bearing: the
   * supervisor builds this from `engaged()`, which is the same predicate
   * `dispatch` asks before sending a bot anywhere — and which deliberately
   * answers FALSE for a bot parked at a table nobody joined while a human is
   * unserved. So an available bot is already absent from this list, and
   * counting its length is counting what cannot serve new demand.
   */
  activeBotIds: string[];
  /** Every bot that could be switched on. */
  roster: PopulationBot[];
}

export type PopulationAction = 'queue' | 'host' | 'join';

export interface PopulationTarget {
  /**
   * `venue` is set for a `join` matched to a SPECIFIC waiting table, and it is
   * the whole point of matching per slot: recorded as a bare `join`, the
   * dispatch searches every venue the bot may enter and chooses globally, so
   * two bots matched to two different venues can both walk up to the same
   * table — one join refused as full, and the other host unserved. Carrying it
   * is what makes the allocation above real rather than nominal.
   */
  activate: Array<{ id: string; action: PopulationAction; venue?: string }>;
  /** Bots that should stand down once their current match ends. */
  deactivate: string[];
}

/**
 * The venues a bot may open a table in — every listable PvP room.
 *
 * This was `['casual', 'beginner']`, and the reasoning was the wrong way
 * round: "the two ungated ones", because a bracketed room refuses a host who
 * may not play there and the brackets exist to sort HUMANS by tier. But a
 * play-bot IS a player on that ladder, and what keeps one out of a room it may
 * not enter is `venuesOpenTo` below, which asks the relay's own
 * `roomEntryVerdict` — not this constant, which was answering the same
 * question a second time and answering it wrong.
 *
 * What the narrow list actually did: `beginner` carries `tierMax: contender`,
 * whose band ends at mu 22, so the moment a bot's results carried it past
 * Vanguard the answer was `['casual']` and nothing else, for the life of that
 * account. Casual is the one room with `ranked: false`. Every bot that got
 * good was therefore exiled to the only room that could not rate it, and the
 * population could never grow a top. That is arithmetic rather than a
 * measurement: `venuesFor` filters this list through `roomEntryVerdict`, and
 * past a tier ceiling there is nothing left in it that rates.
 *
 * Derived rather than hand-listed, so a bracket added to ROOMS cannot leave
 * the population behind — the never-model-it-twice rule this feature has
 * arrived at from seven directions. `roomsOf` drops `listable: false`, which
 * is what keeps `_queue` (the matchmaker's own room) and `_default` (where a
 * venue-less table lands) out of reach: a bot hosting in either would open a
 * table nobody can browse to.
 *
 * The ladder is continuous and therefore self-sequencing. Every bracket above
 * `beginner` has a `tierMin`, and `roomEntryVerdict` waives the level gate
 * once a tier floor is met, so a fresh bot still starts in casual/beginner and
 * walks up as its own results place it. Nothing here chooses where it lands.
 */
export const OPEN_VENUES = roomsOf('pvp').map((r) => r.id);

/** The rooms one bot may enter, judged by the predicate the relay asks. */
export function venuesOpenTo(who: Bracketed): string[] {
  return OPEN_VENUES.filter((id) => roomEntryVerdict(roomById(id), who).ok);
}

/**
 * The rooms THIS roster can reach, which is not the same question as
 * OPEN_VENUES and stopped being the same answer when that list grew brackets.
 *
 * It exists because demand and supply must be judged by one predicate. The
 * demand count reads every public table with a lone human at it; against the
 * raw constant, a human hosting in `advanced` counts as somebody to serve
 * while no bot on the roster is Ace yet — `unmetHumanDemand` inflates `want`,
 * the slot loop correctly finds nobody eligible and breaks, and the surplus is
 * spent by the baseline arm on a bot playing with itself. That is the fading
 * population bound defeated by somebody the population cannot serve, which is
 * the CPU-table finding wearing a third coat.
 *
 * Empty for an empty roster, deliberately: falling back to OPEN_VENUES there
 * would restore exactly the over-count this removes.
 *
 * Ordered by OPEN_VENUES rather than by the roster, so the answer does not
 * depend on which account happened to load first.
 */
export function servableVenues(bots: Bracketed[]): string[] {
  const reach = new Set(bots.flatMap((b) => venuesOpenTo(b)));
  return OPEN_VENUES.filter((id) => reach.has(id));
}

/**
 * How many bots keep the ladder moving when nobody is playing.
 *
 * The simulated population has to progress while humans are offline — that is
 * the whole point of it — and it has to get out of the way when they are not.
 */
export const IDLE_BASELINE = 6;

/** A human waiting this long has plainly not found anybody. */
export const PATIENCE_MS = 30_000;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Humans the queue cannot pair with each other.
 *
 * Two queued humans are a match; the third is the one who needs a bot. This is
 * the displacement rule as arithmetic: a bot is only ever activated for the
 * REMAINDER, so it can never take a seat a person would have had.
 */
export function unmetHumanDemand(
  s: Pick<PopulationSnapshot, 'queuedHumans' | 'openTableVenues'>
): number {
  return (s.queuedHumans % 2) + s.openTableVenues.length;
}

/**
 * How many bots should be playing at all.
 *
 * Unmet human demand first, always served. Then a baseline that FADES as
 * humans arrive: more human supply reduces unnecessary bot participation, and
 * an empty server keeps its ladder alive.
 */
/**
 * A human who has waited past the point of patience gets a bot even if the
 * parity arithmetic says their partner is theoretically out there — the
 * queue's own band is still widening, and somebody who has waited is not being
 * displaced by being given a game.
 *
 * Its own function because BOTH the count and the activation set need it, and
 * a rule copied into two places is one that drifts. The queue being empty has
 * to be asked separately: `longestWaitMs` is whatever the last waiter left
 * behind, so without it a quiet server keeps activating a bot to serve
 * somebody who has gone.
 */
export function impatientDemand(
  s: Pick<PopulationSnapshot, 'longestWaitMs' | 'queuedHumans'>
): number {
  if (s.queuedHumans <= 0 || s.longestWaitMs < PATIENCE_MS) return 0;
  // ...and only when the PARITY slot has not already covered them. An odd
  // queue's odd one out is precisely the person who has been waiting, so
  // counting both spent two bots on one human: on a busy server, where the
  // idle baseline is zero, a single waiting player activated two and
  // dispatched both to the queue, one of which could only take a later
  // arrival's game.
  //
  // Even is the case this exists for: parity says everybody is theoretically
  // matched, and somebody has waited anyway because the band has not opened
  // far enough to pair them.
  return s.queuedHumans % 2 === 0 ? 1 : 0;
}

export function targetActiveCount(s: PopulationSnapshot): number {
  const urgent = unmetHumanDemand(s) + impatientDemand(s);
  const idle = Math.round(IDLE_BASELINE / (1 + s.humansOnline));
  return clamp(Math.max(urgent, idle), 0, s.roster.length);
}

/**
 * Which bots, in preference order.
 *
 * `bandCentre` is where the population is THIN — the controller prefers bots
 * whose earned rating already sits near it. Preference, not assignment: no
 * bot's rating moves because it was chosen, and a roster with nobody near the
 * band simply supplies its nearest, which is the honest answer.
 *
 * ABSENT IS AN ANSWER, NOT A MISSING VALUE, and the arms are the whole design.
 * A centre exists when a named human is waiting, and preferring the bot whose
 * rating suits them is a service decision about that person. With nobody
 * waiting there is no band to serve, so this reads no rating at all.
 *
 * The caller used to substitute START_MU for the absent case, which made this
 * a homeostat: on an idle server — the server the population exists for — it
 * permanently activated whoever sat nearest mu 25 and stopped choosing any bot
 * that had climbed away from it, so a roster could never develop a top.
 *
 * No simulation is needed to see it and none is quoted: the ordering is
 * `|mu - bandCentre|`, the active set is about six of sixty, and a bot that
 * has won its way to mu 33 sits behind every account still near the start.
 * WINNING IS WHAT TOOK A BOT OUT OF THE POPULATION.
 *
 * That is also why the replacement is stronger against §4.13 rather than
 * weaker: the old idle rule was the one thing in the selection path naming a
 * target rating, so climbing was punished with deactivation. This cannot
 * express a target, because with no centre it does not read `mu`. Nothing is
 * written either way — the only lever here is which dormant account gets a
 * socket.
 *
 * Rejected, so they are not re-proposed: the population's own median (still an
 * attractor, and it flattens from the middle so the spread can never open); a
 * sweeping centre to "fill thin tiers" (steering in the plainest form the rule
 * forbids); and an anchor cohort picked by nearest-mu (puts a rating term back
 * in the idle path, and MINIMISES what builds a ladder — an even duel at sigma
 * 2 moves 0.489 mu against 0.196 for a +6 mismatch, and band-gating idle
 * pairing cut rated volume 60% without raising the top). Pairing quality has a
 * home already: `chooseOpponent`'s COMPARABLE_BAND and the queue's own band.
 *
 * Ties break on who has played LEAST, then on who was SENT least recently, so
 * participation spreads rather than falling on the same handful every evening.
 */
export function rankForActivation(
  roster: PopulationBot[],
  bandCentre?: number
): PopulationBot[] {
  return [...roster].sort((a, b) => {
    if (bandCentre !== undefined) {
      const da = Math.abs(a.mu - bandCentre);
      const db = Math.abs(b.mu - bandCentre);
      if (Math.abs(da - db) > 1e-9) return da - db;
    }
    if (a.recentMatches !== b.recentMatches) return a.recentMatches - b.recentMatches;
    if (a.lastDispatchedAt !== b.lastDispatchedAt) return a.lastDispatchedAt - b.lastDispatchedAt;
    return a.id < b.id ? -1 : 1;
  });
}

/** What this bot should go and do when it is playing for its own sake. */
function actionFor(t: PlaybotTraits): PopulationAction {
  if (t.hostAppetite >= t.joinAppetite && t.hostAppetite >= t.queueAppetite) return 'host';
  if (t.joinAppetite >= t.queueAppetite) return 'join';
  return 'queue';
}

/**
 * Unmet demand, split by WHERE the human waiting for it actually is.
 *
 * `unmetHumanDemand` adds the two together because `targetActiveCount` only
 * needs the total, and that is right — but an activation has to go to the
 * human, and the two humans are in different places. A queued human is served
 * by a bot entering the queue; a lone host at a public table is served by a
 * bot WALKING UP TO IT, and is not in the queue at all.
 *
 * Sending both to the queue is what shipped, and it makes §4.13's priority
 * rule nominal rather than operative in exactly the case it exists for: on a
 * server busy enough that the fading idle baseline reaches zero, the one
 * activated bot sat in matchmaking while the human stayed alone at their table
 * indefinitely.
 *
 * Queue demand is served first, deliberately: a queued human's band is still
 * widening, so a bot arriving there may not even be needed, whereas the same
 * bot spent on a table is spent. The totals are identical either way.
 */
export function demandSplit(s: PopulationSnapshot): { queue: number; table: number } {
  // Bots already in the queue are supply spent on exactly this demand, so they
  // come off it. Without that, queue demand is `queuedHumans % 2` and stays 1
  // for as long as that person is unpaired: the bot sent to serve them is
  // engaged, lands in `kept`, and the next tick adds the slot again on top —
  // one more activation per tick for one already-covered waiter, growing the
  // connected population toward the roster limit while `findPair` holds the
  // first bot as their fallback and their own band is still tight.
  //
  // Floored at zero rather than allowed to go negative, which would otherwise
  // let a queue full of bots subtract from TABLE demand through `room`.
  const queue = (s.queuedHumans % 2) + impatientDemand(s);
  return {
    queue: Math.max(0, queue - s.queuedBots),
    table: s.openTableVenues.length,
  };
}

/**
 * The target activation set.
 *
 * Deactivation is by NAME rather than by count: the caller stands a bot down
 * once its current match ends, so nothing here interrupts a game in progress.
 */
export function targetActivation(
  s: PopulationSnapshot,
  bandCentre?: number
): PopulationTarget {
  const want = targetActiveCount(s);
  const active = new Set(s.activeBotIds);
  const demand = demandSplit(s);

  const ordered = rankForActivation(s.roster, bandCentre);
  const keep = ordered.filter((b) => active.has(b.id)).slice(0, want);
  const kept = new Set(keep.map((b) => b.id));

  // Demand gets its OWN slots, on top of what is kept.
  //
  // `want` is a target for how many bots are ACTIVE and `keep` fills it with
  // the ones already on — so with one bot mid-rally and one human newly
  // queued, `want` was 1, the busy bot satisfied it, and nobody was activated:
  // the queued player waited out an unrelated match while dormant compatible
  // bots sat in the roster. Every kept bot is by construction UNAVAILABLE
  // (`activeBotIds` is built from the same `engaged()` predicate `dispatch`
  // asks), so none of them can serve that human.
  //
  // Applied to the activation bound alone and NOT to `want`: folding it into
  // the target would let busy bots justify their own existence, so the
  // population could never shrink — measured, a fixture with thirty humans
  // online and six bots mid-match stopped standing any of them down.
  const room = Math.max(want, kept.size + demand.queue + demand.table);

  const activate: PopulationTarget['activate'] = [];
  const spent = new Set<string>();
  const available = ordered.filter((b) => !active.has(b.id));
  const hasRoom = (): boolean => kept.size + activate.length < room;
  const take = (bot: PopulationBot, action: PopulationAction, venue?: string): void => {
    spent.add(bot.id);
    activate.push(venue ? { id: bot.id, action, venue } : { id: bot.id, action });
  };

  // The queue is not narrowed: matchmaking seats its pair in the hidden
  // `_queue` room, which gates nobody, so a bot the brackets refuse is still a
  // legitimate opponent there. Narrowing it too would take supply away from
  // people in the queue in order to reserve it for a table.
  //
  // It does, however, spend the bot the TABLE cannot replace last. Serving the
  // queue first is a priority statement and this does not weaken it — the
  // queue is served either way, by somebody — but taking whoever ranks highest
  // was leaving both humans worse off: at a Beginner table, whose `tierMax` is
  // Contender, the only eligible bot can be the one nearest the band centre,
  // so the queue consumed it, the table loop found nobody, and that host
  // waited out an unrelated match while a Casual-only bot sat free that the
  // queue would have accepted. The reservation is sized to the demand it
  // protects, exactly as `findPair`'s fallback reservation is, and yields
  // completely when it would otherwise leave the queue unserved: a bot held
  // for a table nobody can fill is a bot spent on nobody.
  // Reserved PER SLOT, never against aggregate supply.
  //
  // Counting eligible bots against remaining slots discards every reservation
  // the moment supply looks sufficient in total: one dual-venue bot and two
  // Casual-only bots is three eligible against two slots, so nothing was
  // reserved — and if the dual-venue bot ranked first the queue took it and
  // Beginner became unservable, though a Casual-only bot would have served the
  // queue and all three humans would have had a game. Aggregate supply is the
  // wrong question; whether each CONSTRAINED slot still has somebody is the
  // right one.
  //
  // A bot is reserved when it is the only free candidate for some remaining
  // slot. That is the uniquely-required case and nothing wider: two dual-venue
  // bots against a Casual and a Beginner slot reserve neither, since either
  // can cover either. Hall's condition over the whole bipartite graph is the
  // complete answer and is the same maximum-matching machinery §4.14 defers;
  // this catches every case a single bot is the only door into a bracket,
  // which is what these failures are made of.
  const neededForTable = (): Set<string> => {
    const free = available.filter((b) => !spent.has(b.id));
    const taken = activate.filter((a) => a.action === 'join').length;
    const reserved = new Set<string>();
    for (const venue of s.openTableVenues.slice(0, Math.max(0, demand.table - taken))) {
      const eligible = free.filter((b) => b.venues.includes(venue));
      if (eligible.length === 1) reserved.add(eligible[0]!.id);
    }
    return reserved;
  };
  //
  // And when it must yield it takes the best-ranked bot, because by then the
  // choice cannot matter. An earlier version sorted the fallback by how many
  // demanded venues each bot could enter, and under the AGGREGATE reservation
  // that was load-bearing; under this one it is unreachable as a decision.
  // Reaching the fallback means every free bot is uniquely required by some
  // slot, and a bot eligible for strictly more venues than another is by
  // definition also eligible for that other's slot — which would make that
  // slot non-unique and leave the lesser bot unreserved for the queue to take
  // through the line above. So the two can only ever tie here, and a sort that
  // cannot change an answer is a line that reads like a rule and is not one.
  for (let i = 0; i < demand.queue && hasRoom(); i += 1) {
    const reserved = neededForTable();
    const free = available.filter((b) => !spent.has(b.id));
    const bot = free.find((b) => !reserved.has(b.id)) ?? free[0];
    if (!bot) break;
    take(bot, 'queue');
  }

  // A table slot may only be spent on a bot the bracket would actually let in.
  //
  // Ranked purely on mu, this handed the slot to whoever sat nearest the band
  // centre and then labelled it `join`: at a Beginner table — tierMax
  // Contender — a bot whose own results had carried it past that searched
  // venues it could not enter, hosted in Casual instead, became spare, and was
  // chosen again on the very next tick, because nothing about it had changed.
  // The human at that table was never served. And it needs no unusual state:
  // the band centre is the longest-waiting QUEUED human's rating, a lone table
  // host is in no queue, so the fallback is START_MU — which is the Ace floor,
  // above Beginner's ceiling.
  //
  // Ordering is untouched: this filters the candidates, so where several are
  // eligible the band preference still decides between them. A slot no bot can
  // fill is left unspent rather than sent to a door that will not open.
  //
  // Matched per SLOT rather than against the union of the venues, and the most
  // constrained slot first. `openTableVenues` is one entry per table, so a
  // candidate tested with `some` passes on any of them: with a Casual table
  // and a Beginner table waiting, two Casual-only bots both passed, both were
  // activated, and the one bot Beginner would admit stayed dormant while that
  // host waited another tick with roster capacity to spare.
  //
  // Greedy, most-constrained-first — not maximum-cardinality matching, which
  // is §4.14's own deferral one level down and would be a great deal of
  // machinery for sets this size. It answers every case with a uniquely
  // eligible bot, which is what the failure above is made of.
  const slots = s.openTableVenues.slice(0, demand.table);
  while (slots.length > 0 && hasRoom()) {
    const free = available.filter((b) => !spent.has(b.id));
    const byScarcity = slots
      .map((venue, idx) => ({ idx, eligible: free.filter((b) => b.venues.includes(venue)) }))
      .filter((x) => x.eligible.length > 0)
      .sort((a, b) => a.eligible.length - b.eligible.length);
    const pick = byScarcity[0];
    // Every remaining slot is one no available bot can enter. Left unspent
    // rather than sent to a door that will not open.
    if (!pick) break;
    take(pick.eligible[0]!, 'join', slots[pick.idx]);
    slots.splice(pick.idx, 1);
  }

  // Whatever room is left goes to bots playing for their own sake, on their
  // own appetite — the baseline that keeps the ladder moving when nobody is
  // about.
  for (const bot of available) {
    if (!hasRoom()) break;
    if (spent.has(bot.id)) continue;
    take(bot, actionFor(bot.traits));
  }

  return {
    activate,
    deactivate: s.activeBotIds.filter((id) => !kept.has(id)),
  };
}
