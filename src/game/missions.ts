import { DailyMission } from '../types';

const STORAGE_PREFIX = 'half_pong_daily_missions_';

export function getTodayDateKey(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getDefaultMissions(): DailyMission[] {
  return [
    {
      id: 'mission_games',
      type: 'games_played',
      titleKey: 'mission_games_title',
      descKey: 'mission_games_desc',
      target: 3,
      current: 0,
      xpReward: 120,
      claimed: false,
    },
    {
      id: 'mission_win',
      type: 'matches_won',
      titleKey: 'mission_win_title',
      descKey: 'mission_win_desc',
      target: 1,
      current: 0,
      xpReward: 150,
      claimed: false,
    },
    {
      id: 'mission_rally',
      type: 'rally',
      titleKey: 'mission_rally_title',
      descKey: 'mission_rally_desc',
      target: 8,
      current: 0,
      xpReward: 120,
      claimed: false,
    },
    {
      id: 'mission_multi',
      type: 'multiplayer',
      titleKey: 'mission_multi_title',
      descKey: 'mission_multi_desc',
      target: 1,
      current: 0,
      xpReward: 200,
      claimed: false,
    },
    {
      id: 'mission_points',
      type: 'points_scored',
      titleKey: 'mission_points_title',
      descKey: 'mission_points_desc',
      target: 12,
      current: 0,
      xpReward: 120,
      claimed: false,
    },
  ];
}

export function loadDailyMissions(): DailyMission[] {
  const dateKey = getTodayDateKey();
  const storageKey = `${STORAGE_PREFIX}${dateKey}`;

  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    }
  } catch (e) {
    console.warn('Failed to load daily missions from storage', e);
  }

  const defaults = getDefaultMissions();
  saveDailyMissions(defaults);
  return defaults;
}

export function saveDailyMissions(missions: DailyMission[]): void {
  const dateKey = getTodayDateKey();
  const storageKey = `${STORAGE_PREFIX}${dateKey}`;
  try {
    localStorage.setItem(storageKey, JSON.stringify(missions));
  } catch (e) {
    console.warn('Failed to save daily missions', e);
  }
}

export function updateMissionProgress(
  eventType: 'games_played' | 'matches_won' | 'rally' | 'multiplayer' | 'points_scored',
  amount: number = 1
): { missions: DailyMission[]; newlyCompleted: DailyMission[] } {
  const missions = loadDailyMissions();
  const newlyCompleted: DailyMission[] = [];

  const updated = missions.map((m) => {
    if (m.type === eventType) {
      const prevCompleted = m.current >= m.target;
      let nextCurrent = m.current;

      if (eventType === 'rally') {
        // For rally, we track the max rally hit today
        nextCurrent = Math.max(m.current, amount);
      } else {
        nextCurrent = m.current + amount;
      }

      const isNowCompleted = nextCurrent >= m.target;
      if (!prevCompleted && isNowCompleted) {
        newlyCompleted.push({ ...m, current: nextCurrent });
      }

      return {
        ...m,
        current: Math.min(m.target * 2, nextCurrent), // Cap reasonable display
      };
    }
    return m;
  });

  saveDailyMissions(updated);
  return { missions: updated, newlyCompleted };
}

export function claimMission(missionId: string): { missions: DailyMission[]; claimedMission: DailyMission | null } {
  const missions = loadDailyMissions();
  let claimedMission: DailyMission | null = null;

  const updated = missions.map((m) => {
    if (m.id === missionId && m.current >= m.target && !m.claimed) {
      claimedMission = { ...m, claimed: true };
      return { ...m, claimed: true };
    }
    return m;
  });

  saveDailyMissions(updated);
  return { missions: updated, claimedMission };
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

  return {
    total: missions.length,
    completed,
    unclaimed,
    claimed,
    hasUnclaimed: unclaimed > 0,
  };
}

export function getTimeUntilNextMidnight(): { hours: number; minutes: number; seconds: number; formatted: string } {
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
  const diffMs = Math.max(0, tomorrow.getTime() - now.getTime());

  const totalSeconds = Math.floor(diffMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const formatted = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

  return { hours, minutes, seconds, formatted };
}
