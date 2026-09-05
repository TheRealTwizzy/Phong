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

/** One bot the controller could switch on. */
export interface PopulationBot {
  id: string;
  traits: PlaybotTraits;
  /**
   * Its EARNED ladder rating. The controller SELECTS on this and never writes
   * it: a bot suits a thin band or it does not, and if none does the answer is
   * more bots rather than a different bot.
   */
  mu: number;
  /** Matches it has played in the recent window, for spreading participation. */
  recentMatches: number;
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
  activate: Array<{ id: string; action: PopulationAction }>;
  /** Bots that should stand down once their current match ends. */
  deactivate: string[];
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
 * Ties break on who has played LEAST recently, so participation spreads rather
 * than falling on the same handful every evening.
 */
export function rankForActivation(
  roster: PopulationBot[],
  bandCentre: number
): PopulationBot[] {
  return [...roster].sort((a, b) => {
    const da = Math.abs(a.mu - bandCentre);
    const db = Math.abs(b.mu - bandCentre);
    if (Math.abs(da - db) > 1e-9) return da - db;
    if (a.recentMatches !== b.recentMatches) return a.recentMatches - b.recentMatches;
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
  return {
    queue: (s.queuedHumans % 2) + impatientDemand(s),
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
  bandCentre: number
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
  const take = (bot: PopulationBot, action: PopulationAction): void => {
    spent.add(bot.id);
    activate.push({ id: bot.id, action });
  };

  // The queue is not narrowed: matchmaking seats its pair in the hidden
  // `_queue` room, which gates nobody, so a bot the brackets refuse is still a
  // legitimate opponent there. Narrowing it too would take supply away from
  // people in the queue in order to reserve it for a table.
  for (let i = 0; i < demand.queue && hasRoom(); i += 1) {
    const bot = available.find((b) => !spent.has(b.id));
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
  for (let i = 0; i < demand.table && hasRoom(); i += 1) {
    const bot = available.find(
      (b) => !spent.has(b.id) && s.openTableVenues.some((v) => b.venues.includes(v))
    );
    if (!bot) break;
    take(bot, 'join');
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
