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
}

export interface PopulationSnapshot {
  /** Humans connected right now. */
  humansOnline: number;
  /** Humans waiting in the ranked queue. */
  queuedHumans: number;
  /** How long the longest-waiting human has waited, ms. */
  longestWaitMs: number;
  /** Public tables sitting with a free playing seat. */
  openTables: number;
  /** Bots already playing or seated. */
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
export function unmetHumanDemand(s: Pick<PopulationSnapshot, 'queuedHumans' | 'openTables'>): number {
  return (s.queuedHumans % 2) + Math.max(0, s.openTables);
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
  return s.longestWaitMs >= PATIENCE_MS && s.queuedHumans > 0 ? 1 : 0;
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
    table: Math.max(0, s.openTables),
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

  const activate: PopulationTarget['activate'] = [];
  for (const bot of ordered) {
    if (kept.size + activate.length >= want) break;
    if (active.has(bot.id)) continue;
    const n = activate.length;
    const action: PopulationAction =
      n < demand.queue
        ? 'queue'
        : n < demand.queue + demand.table
          ? 'join'
          : actionFor(bot.traits);
    activate.push({ id: bot.id, action });
  }

  return {
    activate,
    deactivate: s.activeBotIds.filter((id) => !kept.has(id)),
  };
}
