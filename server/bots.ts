import { START_MU, START_SIGMA } from '../src/rating';

// The play-bot roster.
//
// These are PLAYERS. Each one holds a real account, opens a table, plays real
// matches against humans and against other bots, and climbs the same ladder
// under the same gates. That reverses what this file used to be, and the old
// version is worth stating because the reversal is deliberate rather than
// drift: it was eight static rows with hand-written careers, seeded pre-placed
// so an empty leaderboard had a scale beside it, and its header said in as
// many words that the roster was "NOT a fake player base".
//
// A scale drawn beside the ladder is exactly what a fake career is, and it has
// two problems the moment bots start playing. A bot handed a tier has not
// earned one, so the board would show some bots that placed and some that were
// simply given a rung — on the same screen, indistinguishable. And a fabricated
// win rate rots: one edit and a Legend has a losing record.
//
// So every bot now starts where every person starts: mu 25, sigma 25/3,
// ZERO ranked games, and therefore Unranked, reading `0/5` exactly as a new
// human does. Nothing is asserted about where a bot belongs; the ladder finds
// out. What differs between bots is their STRENGTH, which is fixed for the
// account's lifetime and derived from its id (`trueSkillForBot` in
// server/botPlayers.ts) rather than stored here — so it survives a restart,
// cannot drift from the account it describes, and needs no hand-authored
// column that a later edit could contradict.
//
// The consequence for a fresh deployment is that the board opens EMPTY-ish and
// fills within minutes of real play rather than being pre-populated. That is
// the honest version of the same thing, and it is why the roster no longer
// carries a single number to keep consistent.

export interface BotSeed {
  /** Must start with `bot-`; that prefix is what every bot check keys on. */
  id: string;
  username: string;
}

/**
 * Sixteen accounts.
 *
 * Enough that the strength spread (`trueSkillForBot`) has bots in most tier
 * bands once they have placed, and few enough that a room browser reads as
 * lived-in rather than papered over. How many are actually SEATED is a
 * separate, smaller number — `PLAY_BOTS` — because a seated bot is a live
 * socket and an unseated row is just an account.
 *
 * Names are deliberately synthetic. Every one occupies the same unique,
 * case-insensitive username index a person's does, so a roster name is a name
 * no human can ever have — short or desirable handles are somebody else's.
 */
export const BOT_ROSTER: BotSeed[] = [
  { id: 'bot-ladder-01', username: 'CircuitPup' },
  { id: 'bot-ladder-02', username: 'StaticDrift' },
  { id: 'bot-ladder-03', username: 'HaloJet' },
  { id: 'bot-ladder-04', username: 'NovaTrace' },
  { id: 'bot-ladder-05', username: 'IronEcho' },
  { id: 'bot-ladder-06', username: 'VoltHalcyon' },
  { id: 'bot-ladder-07', username: 'ZeroKelvin' },
  { id: 'bot-ladder-08', username: 'ObsidianArc' },
  { id: 'bot-ladder-09', username: 'PixelMarrow' },
  { id: 'bot-ladder-10', username: 'DriftCanon' },
  { id: 'bot-ladder-11', username: 'AmberRelay' },
  { id: 'bot-ladder-12', username: 'HollowSignal' },
  { id: 'bot-ladder-13', username: 'TinCathedral' },
  { id: 'bot-ladder-14', username: 'GlassFurnace' },
  { id: 'bot-ladder-15', username: 'SlowThunder' },
  { id: 'bot-ladder-16', username: 'PaleLantern' },
];

/**
 * A roster row as `insertBot` wants it: a brand-new account.
 *
 * Every field that a career would fill is left at zero, and the rating is the
 * one every human opens on. `rankedGames: 0` is what makes `tierFor` answer
 * `unranked` — the counter the profile screen prints is then the promise being
 * kept rather than a number that was handed over.
 */
export function botProfileFields(bot: BotSeed) {
  return {
    id: bot.id,
    username: bot.username,
    mu: START_MU,
    rankSigma: START_SIGMA,
    mmrSigma: START_SIGMA,
    xp: 0,
    matchesPlayed: 0,
    matchesWon: 0,
    matchesLost: 0,
    highestRally: 0,
    totalPointsScored: 0,
    multiplayerWins: 0,
    rankedGames: 0,
    rankedDuels: 0,
  };
}
