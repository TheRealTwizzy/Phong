import { CourtTheme, PlayerProfile } from '../types';

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
    minLevel?: number;
    minRally?: number;
    minWins?: number;
    minElo?: number;
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
      description: 'Unlock by completing 1st cross-net volley',
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
      description: 'Unlock with a 10+ hit rally in a single point',
      achievementId: 'rally_10',
      minRally: 10,
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
      description: 'Reach 25+ Rally or 1400+ ELO Rating',
      achievementId: 'rally_25',
      minRally: 25,
      minElo: 1400,
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
  if (req.minLevel && profile.level >= req.minLevel) {
    return true;
  }
  if (req.minRally && profile.highestRally >= req.minRally) {
    return true;
  }
  if (req.minWins && profile.matchesWon >= req.minWins) {
    return true;
  }
  if (req.minElo && profile.eloRating >= req.minElo) {
    return true;
  }

  return false;
}

