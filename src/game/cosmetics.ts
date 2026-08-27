import { CosmeticId, PlayerProfile } from '../types';
import { Tier, TIER_ORDER } from '../rating';
import { findMission } from './missions';
import { contrastRatio, mixHex, withAlpha } from './color';

/**
 * A cosmetic is the whole look of the game, not just the court.
 *
 * It used to be a `Cosmetic`: seventeen colours the canvas painted with, plus
 * one low-alpha accent wash on the menu, deliberately kept off the rest of the
 * shell so that "twenty themes cannot turn the menu into twenty different
 * designs". That restraint made sense while a theme could only be authored as
 * loose colours with nothing checking them. It is lifted here because the two
 * things that made it risky are now enforced rather than trusted: every
 * cosmetic's shell is DERIVED from its own court palette by `shellFrom`, so it
 * cannot drift into an unrelated design, and `tests/cosmetics.test.ts` holds a
 * measured contrast floor on the result, so it cannot drift into an unreadable
 * one.
 */
export type CosmeticMode = 'dark' | 'light';

/** What the canvas paints with. Flat, and unchanged from what shipped. */
export interface CourtPalette {
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
  accentColor: string;
}

/**
 * What the SHELL paints with — published as `--theme-*` custom properties and
 * read back by every Tailwind token utility in the app. The names mirror
 * `src/index.css`'s token block one-for-one, and `cosmeticVars` is what maps
 * between them; a name added here needs one there too or it is published to
 * nothing.
 */
export interface ShellPalette {
  surface0: string;
  surface1: string;
  surface2: string;
  surface3: string;
  surface4: string;
  line: string;
  lineStrong: string;
  ink: string;
  inkMuted: string;
  inkDim: string;
  inkOnAccent: string;
  accent: string;
  accentPress: string;
}

/**
 * Semantic status colours do NOT follow the cosmetic. Green means won and red
 * means lost; a cosmetic that recoloured those would be changing what the
 * screen says, not how it looks. What a cosmetic picks is which RAMP to use,
 * because a set tuned for a dark ground fails contrast on a light one — so the
 * hue is constant and only the lightness moves.
 */
export interface StatusPalette {
  win: string;
  loss: string;
  warn: string;
  xp: string;
  locked: string;
  rankSteady: string;
}

const STATUS_DARK: StatusPalette = {
  win: '#2fd97b',
  loss: '#ff4d6a',
  warn: '#ffb224',
  xp: '#ffc53d',
  locked: '#4c5668',
  rankSteady: '#a78bfa',
};

const STATUS_LIGHT: StatusPalette = {
  win: '#0f7a42',
  loss: '#c11c38',
  warn: '#8a5200',
  xp: '#8a5f00',
  locked: '#8b93a1',
  rankSteady: '#5b3fc4',
};

export const STATUS_RAMPS: Record<CosmeticMode, StatusPalette> = {
  dark: STATUS_DARK,
  light: STATUS_LIGHT,
};

const WHITE = '#ffffff';
const BLACK = '#000000';

/**
 * Build a shell palette out of a cosmetic's own background and accent.
 *
 * Derived rather than hand-authored, for two reasons. Twenty hand-written
 * thirteen-colour palettes is 260 values nobody can hold in their head, and the
 * first one to drift would be a cosmetic whose menu belongs to a different
 * design than its court. And a derivation is a thing a test can check ONCE, for
 * every cosmetic, including the twenty-first.
 *
 * The mixes run through linear light (see `mixHex`), so the surface steps are
 * even to the eye rather than bunched at the dark end.
 */
export function shellFrom(
  background: string,
  accent: string,
  mode: CosmeticMode
): ShellPalette {
  // The ramp is built toward a TINT of the cosmetic's own accent, never toward
  // flat white or black. Mixing toward white desaturates as it lightens, so a
  // ramp built that way arrives grey — the surfaces stop belonging to the
  // cosmetic exactly where there is most of them.
  const toward = mode === 'dark' ? mixHex(WHITE, accent, 0.3) : mixHex(BLACK, accent, 0.25);
  const away = mode === 'dark' ? BLACK : WHITE;

  // surface1 IS the cosmetic's own background: the court and the menu behind it
  // are the same ground, which is what stops the two reading as two products.
  const surface1 = background;
  const surface2 = mixHex(background, toward, mode === 'dark' ? 0.05 : 0.5);
  const ink = mixHex(mode === 'dark' ? WHITE : '#0a0e15', accent, 0.06);

  // The muted and dim inks are the two a floor actually binds, so they are
  // stated as a mix TOWARD the surface they will be read on rather than as
  // fixed greys: on a light cosmetic a fixed grey is the wrong side of legible.
  const inkMuted = mixHex(ink, surface2, mode === 'dark' ? 0.42 : 0.38);
  const inkDim = mixHex(ink, surface2, mode === 'dark' ? 0.62 : 0.56);

  // Whichever of near-black or near-white can actually be read on this accent.
  // Picked rather than assumed: a yellow accent and a blue one disagree, and
  // assuming dark text is how a light-on-light chip gets shipped.
  const onDark = mixHex(background, BLACK, 0.55);
  const onLight = '#f7fbff';
  const inkOnAccent =
    (contrastRatio(onDark, accent) ?? 0) >= (contrastRatio(onLight, accent) ?? 0)
      ? onDark
      : onLight;

  return {
    surface0: mixHex(background, away, mode === 'dark' ? 0.45 : 0.06),
    surface1,
    surface2,
    surface3: mixHex(background, toward, mode === 'dark' ? 0.09 : 0.36),
    surface4: mixHex(background, toward, mode === 'dark' ? 0.15 : 0.24),
    line: mixHex(background, toward, mode === 'dark' ? 0.12 : 0.14),
    lineStrong: mixHex(background, toward, mode === 'dark' ? 0.21 : 0.28),
    ink,
    inkMuted,
    inkDim,
    inkOnAccent,
    accent,
    accentPress: mixHex(accent, away, 0.18),
  };
}

/** A catalogue entry, as authored. `shell` overrides land on the derivation. */
export interface CosmeticDef extends CourtPalette {
  id: CosmeticId;
  /** i18n key, spelled in full so the locale parity suite can see it. */
  nameKey: string;
  mode: CosmeticMode;
  scanlines: boolean;
  shell?: Partial<ShellPalette>;
  unlockRequirement?: {
    achievementId?: string;
    /** Banked permanently by ever completing this elite daily mission. */
    eliteMissionId?: string;
    minLevel?: number;
    minRally?: number;
    minWins?: number;
    /** Minimum ranked tier (PvP-earned) — see src/rating.ts. */
    minTier?: Tier;
  };
}

/** A catalogue entry, resolved: the shell is no longer optional. */
export interface Cosmetic extends Omit<CosmeticDef, 'shell'> {
  shell: ShellPalette;
  status: StatusPalette;
}

const DEFS: Record<CosmeticId, CosmeticDef> = {
  neon: {
    id: 'neon',
    nameKey: 'cosmetic_neon',
    mode: 'dark',
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
    accentColor: '#00f0ff',
    scanlines: false,
  },
  'retro-crt': {
    id: 'retro-crt',
    nameKey: 'cosmetic_retro-crt',
    mode: 'dark',
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
    accentColor: '#ffffff',
    scanlines: true,
  },
  midnight: {
    id: 'midnight',
    nameKey: 'cosmetic_midnight',
    mode: 'dark',
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
    accentColor: '#58a6ff',
    scanlines: false,
  },
  cyberpunk: {
    id: 'cyberpunk',
    nameKey: 'cosmetic_cyberpunk',
    mode: 'dark',
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
    accentColor: '#ff2a85',
    scanlines: false,
  },
  'arena-pro': {
    id: 'arena-pro',
    nameKey: 'cosmetic_arena-pro',
    mode: 'dark',
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
    accentColor: '#ccff00',
    scanlines: false,
  },
  'emerald-matrix': {
    id: 'emerald-matrix',
    nameKey: 'cosmetic_emerald-matrix',
    mode: 'dark',
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
    accentColor: '#00ff66',
    scanlines: true,
    unlockRequirement: {
      achievementId: 'first_serve',
    },
  },
  'solar-flare': {
    id: 'solar-flare',
    nameKey: 'cosmetic_solar-flare',
    mode: 'dark',
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
    accentColor: '#ff6600',
    scanlines: false,
    unlockRequirement: {
      achievementId: 'rally_10',
      minRally: 7,
    },
  },
  'hyper-violet': {
    id: 'hyper-violet',
    nameKey: 'cosmetic_hyper-violet',
    mode: 'dark',
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
    accentColor: '#bf5af2',
    scanlines: false,
    unlockRequirement: {
      achievementId: 'first_win',
      minWins: 1,
    },
  },
  'monochrome-noir': {
    id: 'monochrome-noir',
    nameKey: 'cosmetic_monochrome-noir',
    mode: 'dark',
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
    accentColor: '#ffffff',
    scanlines: false,
    unlockRequirement: {
      minLevel: 5,
      achievementId: 'level_5',
    },
  },
  'quantum-gold': {
    id: 'quantum-gold',
    nameKey: 'cosmetic_quantum-gold',
    mode: 'dark',
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
    accentColor: '#fbbf24',
    scanlines: false,
    unlockRequirement: {
      achievementId: 'rally_25',
      minRally: 18,
      minTier: 'master',
    },
  },
  'perpetual-blue': {
    id: 'perpetual-blue',
    nameKey: 'cosmetic_perpetual-blue',
    mode: 'dark',
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
    accentColor: '#38bdf8',
    scanlines: false,
    unlockRequirement: {
      achievementId: 'rally_100',
    },
  },
  'flawless-white': {
    id: 'flawless-white',
    nameKey: 'cosmetic_flawless-white',
    mode: 'dark',
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
    accentColor: '#e2e8f0',
    scanlines: false,
    unlockRequirement: {
      achievementId: 'cyber_shutout',
    },
  },
  'legend-aurora': {
    id: 'legend-aurora',
    nameKey: 'cosmetic_legend-aurora',
    mode: 'dark',
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
    accentColor: '#a78bfa',
    scanlines: true,
    unlockRequirement: {
      achievementId: 'legend_tier',
    },
  },
  'fixture-bronze': {
    id: 'fixture-bronze',
    nameKey: 'cosmetic_fixture-bronze',
    mode: 'dark',
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
    accentColor: '#f59e0b',
    scanlines: false,
    unlockRequirement: {
      achievementId: 'veteran_200',
    },
  },
  'void-runner': {
    id: 'void-runner',
    nameKey: 'cosmetic_void-runner',
    mode: 'dark',
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
    accentColor: '#818cf8',
    scanlines: true,
    unlockRequirement: {
      eliteMissionId: 'elite_cyber_3',
    },
  },
  'crimson-tide': {
    id: 'crimson-tide',
    nameKey: 'cosmetic_crimson-tide',
    mode: 'dark',
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
    accentColor: '#fb7185',
    scanlines: false,
    unlockRequirement: {
      eliteMissionId: 'elite_rally_40',
    },
  },
  'arctic-glass': {
    id: 'arctic-glass',
    nameKey: 'cosmetic_arctic-glass',
    mode: 'dark',
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
    accentColor: '#7dd3fc',
    scanlines: false,
    unlockRequirement: {
      eliteMissionId: 'elite_shutout_2',
    },
  },
  'molten-core': {
    id: 'molten-core',
    nameKey: 'cosmetic_molten-core',
    mode: 'dark',
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
    accentColor: '#fb923c',
    scanlines: true,
    unlockRequirement: {
      eliteMissionId: 'elite_points_60',
    },
  },
  'signal-lost': {
    id: 'signal-lost',
    nameKey: 'cosmetic_signal-lost',
    mode: 'dark',
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
    accentColor: '#86efac',
    scanlines: true,
    unlockRequirement: {
      eliteMissionId: 'elite_duel_3',
    },
  },
  'gilded-age': {
    id: 'gilded-age',
    nameKey: 'cosmetic_gilded-age',
    mode: 'dark',
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
    accentColor: '#facc15',
    scanlines: false,
    unlockRequirement: {
      eliteMissionId: 'elite_aces_8',
    },
  },
};

/**
 * The catalogue, resolved. Each entry's shell is derived from its own court
 * palette, then any authored override is laid on top — so an override is a
 * deliberate exception to the derivation and reads as one in the diff, rather
 * than being indistinguishable from thirteen values somebody typed out.
 */
export const COSMETICS: Record<CosmeticId, Cosmetic> = Object.fromEntries(
  Object.entries(DEFS).map(([id, def]) => [
    id,
    {
      ...def,
      shell: { ...shellFrom(def.background, def.accentColor, def.mode), ...def.shell },
      status: STATUS_RAMPS[def.mode],
    },
  ])
) as Record<CosmeticId, Cosmetic>;

export const COSMETIC_IDS = Object.keys(COSMETICS) as CosmeticId[];

/**
 * The shipped default. Taken from the head of the free group rather than named,
 * for the reason `DEFAULT_SETTINGS` takes its difficulty from the head of
 * `DIFFICULTY_ORDER`: a default that names a value is a default that can be
 * changed into a locked one, and every match a new player played would be
 * refused.
 */
export const DEFAULT_COSMETIC_ID: CosmeticId = 'neon';

/**
 * Ids that have been renamed, read forward.
 *
 * The equipped cosmetic is persisted in two places that outlive a deployment —
 * `localStorage` on the device and `players.cosmetic` in the database — so a
 * renamed id is not a compile error, it is a player quietly losing a cosmetic
 * they own: the lookup misses, the fallback returns the default, and nothing
 * says anything. This is the same forward-reading shape `normalizeDifficulty`
 * uses for the retired `'chaos'`, and it is why renaming an id here costs one
 * line rather than a migration.
 *
 * Note what must NOT be renamed to match: `MissionDef.unlocks` is the value
 * banked in `elite_completions`, and `isCosmeticUnlocked` compares against that,
 * never against the cosmetic's own id. The two strings look like they have to
 * agree and they do not — rewriting the ledger to keep them matching would be
 * taking back permanent unlocks to fix a spelling.
 */
export const LEGACY_COSMETIC_IDS: Record<string, CosmeticId> = {
  // 'tennis' described the court it painted, back when a cosmetic was only a
  // court. Its name has always been "Arena Pro".
  tennis: 'arena-pro',
};

/**
 * Whatever arrived — from a client, from localStorage, from a row written by an
 * older build — resolved to an id this build actually has.
 */
export function normalizeCosmeticId(value: unknown): CosmeticId {
  if (typeof value !== 'string') return DEFAULT_COSMETIC_ID;
  if (value in COSMETICS) return value as CosmeticId;
  return LEGACY_COSMETIC_IDS[value] ?? DEFAULT_COSMETIC_ID;
}

/**
 * The custom properties for one cosmetic, as an inline style.
 *
 * It publishes `--color-*` — the design tokens themselves — and NOT a separate
 * `--theme-*` layer pointing at them. That indirection was the obvious design
 * and it silently does not work, which is worth writing down because it costs
 * nothing to build and everything to debug:
 *
 *     :root { --theme-s2: #111; --color-s2: var(--theme-s2); }
 *     #scope { --theme-s2: red; }              .util { background: var(--color-s2) }
 *
 * `#scope` renders `#111`, not red. Custom properties are substituted at
 * computed-value time, so `--color-s2` is resolved ONCE against `:root` and what
 * descendants inherit is the already-substituted value — overriding the inner
 * variable downstream changes nothing. Overriding `--color-s2` itself does work.
 * Verified in Chromium rather than reasoned about, because both spellings
 * compile, both look right in review, and only one of them paints.
 *
 * Publishing the token directly is also what keeps this additive in the sense
 * `src/index.css` means: the names written here are the project's own, and no
 * stock Tailwind scale is touched.
 *
 * Called in exactly two places: `#app-root-container` for the cosmetic this
 * player has equipped, and the public-profile card for the cosmetic its OWNER
 * has equipped. That second call is the whole "viewing someone's profile shows
 * their look" feature — properties inherit, so a subtree that redeclares them is
 * skinned independently of the page around it, and leaving it restores the page
 * with no cleanup to forget.
 */
export function cosmeticVars(cosmetic: Cosmetic): Record<string, string> {
  const s = cosmetic.shell;
  const st = cosmetic.status;
  return {
    '--color-surface-0': s.surface0,
    '--color-surface-1': s.surface1,
    '--color-surface-2': s.surface2,
    '--color-surface-3': s.surface3,
    '--color-surface-4': s.surface4,
    '--color-line': s.line,
    '--color-line-strong': s.lineStrong,
    '--color-ink': s.ink,
    '--color-ink-muted': s.inkMuted,
    '--color-ink-dim': s.inkDim,
    '--color-ink-on-accent': s.inkOnAccent,
    '--color-accent': s.accent,
    '--color-accent-press': s.accentPress,
    '--color-win': st.win,
    '--color-loss': st.loss,
    '--color-warn': st.warn,
    '--color-xp': st.xp,
    '--color-locked': st.locked,
    '--color-rank-steady': st.rankSteady,
    // The elevation tokens bake their colours, so they have to be rebuilt here
    // or a cosmetic gets somebody else's rim light. Same reason as above: a
    // `color-mix()` referring to --color-ink inside @theme would be resolved
    // once, at :root, and never follow the cosmetic.
    '--shadow-card': `inset 0 1px 0 0 ${withAlpha(s.ink, 0.045)}, 0 10px 24px -14px ${withAlpha(s.surface0, 0.9)}`,
    '--shadow-sheet': `inset 0 1px 0 0 ${withAlpha(s.ink, 0.06)}, 0 28px 64px -20px ${withAlpha(s.surface0, 0.9)}`,
    '--shadow-accent': `0 0 0 1px ${withAlpha(s.accent, 0.35)}, 0 10px 30px -12px ${withAlpha(s.accent, 0.45)}`,
  };
}

export function isCosmeticUnlocked(cosmeticId: CosmeticId, profile: PlayerProfile | null): boolean {
  const theme = COSMETICS[cosmeticId];
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

