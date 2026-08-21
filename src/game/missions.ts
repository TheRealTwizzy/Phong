import { DailyMission, MatchEndPayload, MissionType } from '../types';

// Daily mission DEFINITIONS, shared by client and server exactly like
// profileRules.ts and rating.ts. Progress and claims live on the SERVER
// (server/db.ts): missions used to be kept in localStorage and claimed by
// POSTing their own reward as an `xpDelta`, which meant clearing site data
// re-armed all five, and the raw endpoint could be called in a loop. Nothing
// in here reads or writes storage — it is pure data plus the rules for
// advancing progress.

export interface MissionDef {
  id: string;
  type: MissionType;
  titleKey: string;
  descKey: string;
  target: number;
  xpReward: number;
}

export const MISSION_DEFS: MissionDef[] = [
  {
    id: 'mission_games',
    type: 'games_played',
    titleKey: 'mission_games_title',
    descKey: 'mission_games_desc',
    target: 3,
    xpReward: 120,
  },
  {
    id: 'mission_win',
    type: 'matches_won',
    titleKey: 'mission_win_title',
    descKey: 'mission_win_desc',
    target: 1,
    xpReward: 150,
  },
  {
    id: 'mission_rally',
    type: 'rally',
    titleKey: 'mission_rally_title',
    descKey: 'mission_rally_desc',
    target: 8,
    xpReward: 120,
  },
  {
    id: 'mission_multi',
    type: 'multiplayer',
    titleKey: 'mission_multi_title',
    descKey: 'mission_multi_desc',
    target: 1,
    xpReward: 200,
  },
  {
    id: 'mission_points',
    type: 'points_scored',
    titleKey: 'mission_points_title',
    descKey: 'mission_points_desc',
    target: 12,
    xpReward: 120,
  },
];

/** Most XP a player can claim from missions in one day. */
export const MISSION_DAILY_XP_CAP = MISSION_DEFS.reduce((sum, m) => sum + m.xpReward, 0);

export const findMission = (id: string): MissionDef | undefined =>
  MISSION_DEFS.find((m) => m.id === id);

/**
 * The day a mission set belongs to, in UTC. Deliberately not local time: the
 * server owns mission state, and a local-time key would hand a player a fresh
 * set every time they changed timezone.
 */
export function missionDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Milliseconds until the next UTC midnight, for the countdown in the UI. */
export function msUntilMissionReset(now: Date = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(0, next - now.getTime());
}

export function formatMissionReset(now: Date = new Date()): string {
  const total = Math.floor(msUntilMissionReset(now) / 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

/**
 * How one recorded match advances a mission. `rally` keeps the best rally of
 * the day; everything else accumulates. Progress is never decremented, and is
 * held at the target so a mission cannot bank surplus toward tomorrow.
 */
export function missionProgressDelta(def: MissionDef, match: MatchEndPayload): number {
  switch (def.type) {
    case 'games_played':
      return 1;
    case 'matches_won':
      return match.isWinner ? 1 : 0;
    case 'multiplayer':
      return match.mode === 'multiplayer' ? 1 : 0;
    case 'points_scored':
      return Math.max(0, Math.round(match.playerScore || 0));
    case 'rally':
      return 0; // handled as a maximum, not a sum — see applyMatchToProgress
    default:
      return 0;
  }
}

/** Next progress value for `def` after `match`, given `current`. */
export function applyMatchToProgress(
  def: MissionDef,
  current: number,
  match: MatchEndPayload
): number {
  const next =
    def.type === 'rally'
      ? Math.max(current, Math.max(0, Math.round(match.maxRally || 0)))
      : current + missionProgressDelta(def, match);
  return Math.min(def.target, next);
}

export function getMissionsStatusSummary(missions: DailyMission[]): {
  total: number;
  completed: number;
  unclaimed: number;
  claimed: number;
  hasUnclaimed: boolean;
} {
  let completed = 0;
  let unclaimed = 0;
  let claimed = 0;

  missions.forEach((m) => {
    if (m.claimed) {
      claimed++;
      completed++;
    } else if (m.current >= m.target) {
      completed++;
      unclaimed++;
    }
  });

  return { total: missions.length, completed, unclaimed, claimed, hasUnclaimed: unclaimed > 0 };
}
