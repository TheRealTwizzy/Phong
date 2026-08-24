import { CourtTheme, PlayerProfile } from '../types';
import { Tier, TIER_ORDER } from '../rating';
import { findMission } from './missions';

export interface ThemeConfig {
  id: CourtTheme;
  name: string;
  background: string;
  courtColor: string;
  courtBorder: string;
  netLineColor: string;
  netGlowColor: string;
  playerPaddleColor: string;
  playerPaddleGlow: string;
  opponentPaddleColor: string;
  opponentPaddleGlow: string;
  ballColor: string;
  ballGlow: string;
  trailColor: string;
  gridColor: string;
  textColor: string;
  accentColor: string;
  scanlines: boolean;
  unlockRequirement?: {
    description: string;
    achievementId?: string;
    /** Banked permanently by ever completing this elite daily mission. */
    eliteMissionId?: string;
    minLevel?: number;
    minRally?: number;
    minWins?: number;
    // Minimum ranked tier (PvP-earned) — see src/rating.ts.
  minTier?: Tier;
  };
}

export const THEMES: Record<CourtTheme, ThemeConfig> = {
  neon: {
    id: 'neon',
    name: 'Cyber Neon',
    background: '#090d16',
    courtColor: '#0c1322',
    courtBorder: '#00f0ff',
    netLineColor: '#00f0ff',
    netGlowColor: 'rgba(0, 240, 255, 0.6)',
    playerPaddleColor: '#00f0ff',
    playerPaddleGlow: '#00f0ff',
    opponentPaddleColor: '#ff007f',
    opponentPaddleGlow: '#ff007f',
    ballColor: '#ffffff',
    ballGlow: '#00f0ff',
    trailColor: 'rgba(0, 240, 255, 0.4)',
    gridColor: 'rgba(0, 240, 255, 0.08)',
    textColor: '#e0f7fa',
    accentColor: '#00f0ff',
    scanlines: false,
  },
  'retro-crt': {
    id: 'retro-crt',
    name: '1972 Arcade CRT',
    background: '#0a0a0a',
    courtColor: '#050505',
    courtBorder: '#ffffff',
    netLineColor: '#ffffff',
    netGlowColor: 'rgba(255, 255, 255, 0.4)',
    playerPaddleColor: '#ffffff',
    playerPaddleGlow: '#ffffff',
    opponentPaddleColor: '#cccccc',
    opponentPaddleGlow: '#cccccc',
    ballColor: '#ffffff',
    ballGlow: '#ffffff',
    trailColor: 'rgba(255, 255, 255, 0.3)',
    gridColor: 'transparent',
    textColor: '#ffffff',
    accentColor: '#ffffff',
    scanlines: true,
  },
  midnight: {
    id: 'midnight',
    name: 'Midnight Minimal',
    background: '#111418',
    courtColor: '#161b22',
    courtBorder: '#30363d',
    netLineColor: '#8b949e',
    netGlowColor: 'rgba(139, 148, 158, 0.3)',
    playerPaddleColor: '#58a6ff',
    playerPaddleGlow: '#58a6ff',
    opponentPaddleColor: '#f78166',
    opponentPaddleGlow: '#f78166',
    ballColor: '#f0f6fc',
    ballGlow: '#58a6ff',
    trailColor: 'rgba(88, 166, 255, 0.25)',
    gridColor: 'rgba(255, 255, 255, 0.03)',
    textColor: '#f0f6fc',
    accentColor: '#58a6ff',
    scanlines: false,
  },
  cyberpunk: {
    id: 'cyberpunk',
    name: 'Sunset Synth',
    background: '#1a0b2e',
    courtColor: '#24103e',
    courtBorder: '#ff2a85',
    netLineColor: '#ffb300',
    netGlowColor: 'rgba(255, 179, 0, 0.6)',
    playerPaddleColor: '#ff2a85',
    playerPaddleGlow: '#ff2a85',
    opponentPaddleColor: '#00e5ff',
    opponentPaddleGlow: '#00e5ff',
    ballColor: '#ffe600',
    ballGlow: '#ffe600',
    trailColor: 'rgba(255, 42, 133, 0.4)',
    gridColor: 'rgba(255, 42, 133, 0.1)',
    textColor: '#ffeef6',
    accentColor: '#ff2a85',
    scanlines: false,
  },
  tennis: {
    id: 'tennis',
    name: 'Arena Pro',
    background: '#0d2818',
    courtColor: '#14452f',
    courtBorder: '#ffffff',
    netLineColor: '#ffffff',
    netGlowColor: 'rgba(255, 255, 255, 0.5)',
    playerPaddleColor: '#ffffff',
    playerPaddleGlow: 'transparent',
    opponentPaddleColor: '#e0e0e0',
    opponentPaddleGlow: 'transparent',
    ballColor: '#ccff00',
    ballGlow: '#ccff00',
    trailColor: 'rgba(204, 255, 0, 0.3)',
    gridColor: 'rgba(255, 255, 255, 0.05)',
    textColor: '#ffffff',
    accentColor: '#ccff00',
    scanlines: false,
  },
  'emerald-matrix': {
    id: 'emerald-matrix',
    name: 'Matrix Code',
    background: '#021208',
    courtColor: '#041c0e',
    courtBorder: '#00ff66',
    netLineColor: '#00ff66',
    netGlowColor: 'rgba(0, 255, 102, 0.7)',
    playerPaddleColor: '#00ff66',
    playerPaddleGlow: '#00ff66',
    opponentPaddleColor: '#10b981',
    opponentPaddleGlow: '#10b981',
    ballColor: '#a7f3d0',
    ballGlow: '#00ff66',
    trailColor: 'rgba(0, 255, 102, 0.4)',
    gridColor: 'rgba(0, 255, 102, 0.12)',
    textColor: '#d1fae5',
    accentColor: '#00ff66',
    scanlines: true,
    unlockRequirement: {
      description: 'Unlock by completing your first cross-net volley',
      achievementId: 'first_serve',
    },
  },
  'solar-flare': {
    id: 'solar-flare',
    name: 'Solar Flare',
    background: '#1c0800',
    courtColor: '#2b0e00',
    courtBorder: '#ff6600',
    netLineColor: '#ffbb00',
    netGlowColor: 'rgba(255, 187, 0, 0.8)',
    playerPaddleColor: '#ff5500',
    playerPaddleGlow: '#ff5500',
    opponentPaddleColor: '#ffcc00',
    opponentPaddleGlow: '#ffcc00',
    ballColor: '#ffffff',
    ballGlow: '#ff8800',
    trailColor: 'rgba(255, 102, 0, 0.45)',
    gridColor: 'rgba(255, 102, 0, 0.1)',
    textColor: '#fff7ed',
    accentColor: '#ff6600',
    scanlines: false,
    unlockRequirement: {
      description: 'Sustain a streak of 7 returns without missing one',
      achievementId: 'rally_10',
      minRally: 7,
    },
  },
  'hyper-violet': {
    id: 'hyper-violet',
    name: 'Hyper Violet',
    background: '#120424',
    courtColor: '#1d0a38',
    courtBorder: '#bf5af2',
    netLineColor: '#e08aff',
    netGlowColor: 'rgba(224, 138, 255, 0.7)',
    playerPaddleColor: '#bf5af2',
    playerPaddleGlow: '#bf5af2',
    opponentPaddleColor: '#5e5ce6',
    opponentPaddleGlow: '#5e5ce6',
    ballColor: '#ffffff',
    ballGlow: '#bf5af2',
    trailColor: 'rgba(191, 90, 242, 0.4)',
    gridColor: 'rgba(191, 90, 242, 0.09)',
    textColor: '#faf5ff',
    accentColor: '#bf5af2',
    scanlines: false,
    unlockRequirement: {
      description: 'Unlock by winning your first match',
      achievementId: 'first_win',
      minWins: 1,
    },
  },
  'monochrome-noir': {
    id: 'monochrome-noir',
    name: 'Noir Deluxe',
    background: '#0d0d0f',
    courtColor: '#17171a',
    courtBorder: '#9ca3af',
    netLineColor: '#e5e7eb',
    netGlowColor: 'rgba(229, 231, 235, 0.5)',
    playerPaddleColor: '#f3f4f6',
    playerPaddleGlow: 'rgba(255, 255, 255, 0.4)',
    opponentPaddleColor: '#9ca3af',
    opponentPaddleGlow: 'rgba(156, 163, 175, 0.3)',
    ballColor: '#ffffff',
    ballGlow: 'rgba(255, 255, 255, 0.8)',
    trailColor: 'rgba(255, 255, 255, 0.25)',
    gridColor: 'rgba(255, 255, 255, 0.04)',
    textColor: '#f9fafb',
    accentColor: '#ffffff',
    scanlines: false,
    unlockRequirement: {
      description: 'Reach Player Level 5',
      minLevel: 5,
      achievementId: 'level_5',
    },
  },
  'quantum-gold': {
    id: 'quantum-gold',
    name: 'Quantum Champion',
    background: '#191402',
    courtColor: '#261e03',
    courtBorder: '#fbbf24',
    netLineColor: '#fef08a',
    netGlowColor: 'rgba(254, 240, 138, 0.8)',
    playerPaddleColor: '#f59e0b',
    playerPaddleGlow: '#f59e0b',
    opponentPaddleColor: '#38bdf8',
    opponentPaddleGlow: '#38bdf8',
    ballColor: '#fffbeb',
    ballGlow: '#fbbf24',
    trailColor: 'rgba(251, 191, 36, 0.45)',
    gridColor: 'rgba(251, 191, 36, 0.12)',
    textColor: '#fefce8',
    accentColor: '#fbbf24',
    scanlines: false,
    unlockRequirement: {
      description: 'Sustain a streak of 18 returns, or reach Master tier',
      achievementId: 'rally_25',
      minRally: 18,
      minTier: 'master',
    },
  },
  'perpetual-blue': {
    id: 'perpetual-blue',
    name: 'Perpetual Motion',
    background: '#020a18',
    courtColor: '#04142c',
    courtBorder: '#38bdf8',
    netLineColor: '#38bdf8',
    netGlowColor: 'rgba(56,189,248,0.7)',
    playerPaddleColor: '#38bdf8',
    playerPaddleGlow: '#38bdf8',
    opponentPaddleColor: '#0ea5e9',
    opponentPaddleGlow: '#0ea5e9',
    ballColor: '#e0f2fe',
    ballGlow: '#38bdf8',
    trailColor: 'rgba(56,189,248,0.4)',
    gridColor: 'rgba(56,189,248,0.12)',
    textColor: '#e0f2fe',
    accentColor: '#38bdf8',
    scanlines: false,
    unlockRequirement: {
      description: 'Sustain a streak of 72 returns',
      achievementId: 'rally_100',
    },
  },
  'flawless-white': {
    id: 'flawless-white',
    name: 'Flawless Circuit',
    background: '#0a0a0c',
    courtColor: '#141419',
    courtBorder: '#f8fafc',
    netLineColor: '#f8fafc',
    netGlowColor: 'rgba(248,250,252,0.7)',
    playerPaddleColor: '#f8fafc',
    playerPaddleGlow: '#f8fafc',
    opponentPaddleColor: '#cbd5e1',
    opponentPaddleGlow: '#cbd5e1',
    ballColor: '#ffffff',
    ballGlow: '#f8fafc',
    trailColor: 'rgba(248,250,252,0.35)',
    gridColor: 'rgba(248,250,252,0.10)',
    textColor: '#f8fafc',
    accentColor: '#e2e8f0',
    scanlines: false,
    unlockRequirement: {
      description: 'Shut out the Cyber AI',
      achievementId: 'cyber_shutout',
    },
  },
  'legend-aurora': {
    id: 'legend-aurora',
    name: 'Aurora',
    background: '#04121a',
    courtColor: '#062230',
    courtBorder: '#22d3ee',
    netLineColor: '#a78bfa',
    netGlowColor: 'rgba(167,139,250,0.7)',
    playerPaddleColor: '#22d3ee',
    playerPaddleGlow: '#22d3ee',
    opponentPaddleColor: '#a78bfa',
    opponentPaddleGlow: '#a78bfa',
    ballColor: '#ccfbf1',
    ballGlow: '#22d3ee',
    trailColor: 'rgba(34,211,238,0.4)',
    gridColor: 'rgba(167,139,250,0.14)',
    textColor: '#ccfbf1',
    accentColor: '#a78bfa',
    scanlines: true,
    unlockRequirement: {
      description: 'Reach the Legend tier',
      achievementId: 'legend_tier',
    },
  },
  'fixture-bronze': {
    id: 'fixture-bronze',
    name: 'Old Guard',
    background: '#140d05',
    courtColor: '#241708',
    courtBorder: '#d97706',
    netLineColor: '#d97706',
    netGlowColor: 'rgba(217,119,6,0.7)',
    playerPaddleColor: '#f59e0b',
    playerPaddleGlow: '#f59e0b',
    opponentPaddleColor: '#b45309',
    opponentPaddleGlow: '#b45309',
    ballColor: '#fde68a',
    ballGlow: '#f59e0b',
    trailColor: 'rgba(245,158,11,0.4)',
    gridColor: 'rgba(217,119,6,0.12)',
    textColor: '#fde68a',
    accentColor: '#f59e0b',
    scanlines: false,
    unlockRequirement: {
      description: 'Complete 200 matches',
      achievementId: 'veteran_200',
    },
  },
  'void-runner': {
    id: 'void-runner',
    name: 'Void Runner',
    background: '#000000',
    courtColor: '#0a0a12',
    courtBorder: '#6366f1',
    netLineColor: '#6366f1',
    netGlowColor: 'rgba(99,102,241,0.75)',
    playerPaddleColor: '#818cf8',
    playerPaddleGlow: '#818cf8',
    opponentPaddleColor: '#4338ca',
    opponentPaddleGlow: '#4338ca',
    ballColor: '#c7d2fe',
    ballGlow: '#6366f1',
    trailColor: 'rgba(99,102,241,0.45)',
    gridColor: 'rgba(99,102,241,0.10)',
    textColor: '#c7d2fe',
    accentColor: '#818cf8',
    scanlines: true,
    unlockRequirement: {
      description: 'Elite: beat Cyber three times in a day',
      eliteMissionId: 'elite_cyber_3',
    },
  },
  'crimson-tide': {
    id: 'crimson-tide',
    name: 'Crimson Tide',
    background: '#12030a',
    courtColor: '#240614',
    courtBorder: '#f43f5e',
    netLineColor: '#f43f5e',
    netGlowColor: 'rgba(244,63,94,0.7)',
    playerPaddleColor: '#fb7185',
    playerPaddleGlow: '#fb7185',
    opponentPaddleColor: '#be123c',
    opponentPaddleGlow: '#be123c',
    ballColor: '#ffe4e6',
    ballGlow: '#f43f5e',
    trailColor: 'rgba(244,63,94,0.4)',
    gridColor: 'rgba(244,63,94,0.12)',
    textColor: '#ffe4e6',
    accentColor: '#fb7185',
    scanlines: false,
    unlockRequirement: {
      description: 'Elite: sustain a streak of 28 returns',
      eliteMissionId: 'elite_rally_40',
    },
  },
  'arctic-glass': {
    id: 'arctic-glass',
    name: 'Arctic Glass',
    background: '#04121a',
    courtColor: '#08202e',
    courtBorder: '#7dd3fc',
    netLineColor: '#7dd3fc',
    netGlowColor: 'rgba(125,211,252,0.7)',
    playerPaddleColor: '#bae6fd',
    playerPaddleGlow: '#bae6fd',
    opponentPaddleColor: '#38bdf8',
    opponentPaddleGlow: '#38bdf8',
    ballColor: '#f0f9ff',
    ballGlow: '#7dd3fc',
    trailColor: 'rgba(125,211,252,0.35)',
    gridColor: 'rgba(125,211,252,0.10)',
    textColor: '#f0f9ff',
    accentColor: '#7dd3fc',
    scanlines: false,
    unlockRequirement: {
      description: 'Elite: two shutouts in a day',
      eliteMissionId: 'elite_shutout_2',
    },
  },
  'molten-core': {
    id: 'molten-core',
    name: 'Molten Core',
    background: '#150703',
    courtColor: '#2a0e05',
    courtBorder: '#f97316',
    netLineColor: '#f97316',
    netGlowColor: 'rgba(249,115,22,0.75)',
    playerPaddleColor: '#fb923c',
    playerPaddleGlow: '#fb923c',
    opponentPaddleColor: '#ea580c',
    opponentPaddleGlow: '#ea580c',
    ballColor: '#ffedd5',
    ballGlow: '#f97316',
    trailColor: 'rgba(249,115,22,0.45)',
    gridColor: 'rgba(249,115,22,0.12)',
    textColor: '#ffedd5',
    accentColor: '#fb923c',
    scanlines: true,
    unlockRequirement: {
      description: 'Elite: score 60 points in a day',
      eliteMissionId: 'elite_points_60',
    },
  },
  'signal-lost': {
    id: 'signal-lost',
    name: 'Signal Lost',
    background: '#0a0f0a',
    courtColor: '#111a11',
    courtBorder: '#4ade80',
    netLineColor: '#4ade80',
    netGlowColor: 'rgba(74,222,128,0.7)',
    playerPaddleColor: '#86efac',
    playerPaddleGlow: '#86efac',
    opponentPaddleColor: '#16a34a',
    opponentPaddleGlow: '#16a34a',
    ballColor: '#dcfce7',
    ballGlow: '#4ade80',
    trailColor: 'rgba(74,222,128,0.4)',
    gridColor: 'rgba(74,222,128,0.12)',
    textColor: '#dcfce7',
    accentColor: '#86efac',
    scanlines: true,
    unlockRequirement: {
      description: 'Elite: win three duels in a day',
      eliteMissionId: 'elite_duel_3',
    },
  },
  'gilded-age': {
    id: 'gilded-age',
    name: 'Gilded Age',
    background: '#120e02',
    courtColor: '#231c05',
    courtBorder: '#eab308',
    netLineColor: '#eab308',
    netGlowColor: 'rgba(234,179,8,0.75)',
    playerPaddleColor: '#facc15',
    playerPaddleGlow: '#facc15',
    opponentPaddleColor: '#ca8a04',
    opponentPaddleGlow: '#ca8a04',
    ballColor: '#fef9c3',
    ballGlow: '#eab308',
    trailColor: 'rgba(234,179,8,0.45)',
    gridColor: 'rgba(234,179,8,0.12)',
    textColor: '#fef9c3',
    accentColor: '#facc15',
    scanlines: false,
    unlockRequirement: {
      description: 'Elite: eight aces in a day',
      eliteMissionId: 'elite_aces_8',
    },
  },
};

export function isThemeUnlocked(themeId: CourtTheme, profile: PlayerProfile | null): boolean {
  const theme = THEMES[themeId];
  if (!theme) return false;
  if (!theme.unlockRequirement) return true; // Standard themes are unlocked by default
  if (!profile) return false;

  const req = theme.unlockRequirement;

  if (req.achievementId && profile.achievements?.includes(req.achievementId)) {
    return true;
  }
  // Elite missions bank a permanent unlock the first time they are completed;
  // the mission itself rerolls away with the day, but this does not.
  if (req.eliteMissionId) {
    const mission = findMission(req.eliteMissionId);
    if (mission?.unlocks && profile.eliteUnlocks?.includes(mission.unlocks)) return true;
  }
  if (req.minLevel && profile.level >= req.minLevel) {
    return true;
  }
  if (req.minRally && profile.highestRally >= req.minRally) {
    return true;
  }
  if (req.minWins && profile.matchesWon >= req.minWins) {
    return true;
  }
  if (req.minTier && TIER_ORDER.indexOf(profile.tier as Exclude<Tier, 'unranked'>) >= TIER_ORDER.indexOf(req.minTier as Exclude<Tier, 'unranked'>) && profile.tier !== 'unranked') {
    return true;
  }

  return false;
}

