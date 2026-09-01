import React, { useState } from 'react';
import { ChevronDown, RotateCcw, ShieldAlert, ShieldCheck } from 'lucide-react';
import { AIDifficulty, GameMode, LanguageCode, MatchRules } from '../types';
import {
  AUTO_SERVE_OPTIONS,
  DEFAULT_MATCH_RULES,
  PHYSICS_RULES,
  PhysicsRuleKey,
  UnrankedReason,
  isRuleRanked,
  clampRule,
  unrankedReasons,
  isRankedRules,
} from '../matchRules';
import { t } from '../i18n/translations';
import { SegmentedControl } from './ui';

// Pre-match rules, collapsed by default so the menu still reads as one tap to
// play. Six sliders change the physics; four toggles are presentation only.
//
// Each slider carries a RANKED BAND around stock, drawn under the track. Move
// inside it and the match still rates — the point of the band is that these
// are real, usable adjustments, not a novelty that costs you the ladder. Push
// a slider past its band and the match pays XP but moves no rating.
//
// The same panel serves the solo menu and the duel lobby; in a duel the guest
// gets it read-only, because the room's terms belong to the host.

interface Props {
  rules: MatchRules;
  onUpdateRules: (patch: Partial<MatchRules>) => void;
  lang: LanguageCode;
  /** Practice and split have no chat or sonar to speak of. */
  mode: GameMode;
  /**
   * Solo only, and only for the ranked verdict — a duel rates on its rules
   * alone. Rookie feeds hidden MMR and never the visible ladder, which the
   * badge used to say nothing about: it promised "counts for rank" for a match
   * the server was always going to refuse to rate.
   */
  difficulty?: AIDifficulty;
  /** The guest's view of the host's rules: visible, not editable. */
  readOnly?: boolean;
  /** Keeps ids unique when the lobby renders over the menu. */
  idPrefix?: string;
  /**
   * Duel only: the venue the TABLE sits in. Casual does not move the visible
   * ladder, so a duel no longer rates on its rules alone.
   */
  venueRoomId?: string | null;
  /**
   * Solo only: the player's visible ladder rating, so the badge can say when
   * a rung has been outgrown. Above that rung's own ceiling it moves no
   * rating, and promising otherwise is the same lie the Rookie case fixes.
   */
  rankMu?: number;
}

const SLIDERS: { key: PhysicsRuleKey; labelKey: string }[] = [
  { key: 'paddleScale', labelKey: 'rule_paddle_size' },
  { key: 'ballScale', labelKey: 'rule_ball_size' },
  { key: 'ballSpeedMin', labelKey: 'rule_speed_min' },
  { key: 'ballSpeedMax', labelKey: 'rule_speed_max' },
  { key: 'serveAngleMax', labelKey: 'rule_serve_angle' },
  { key: 'servePowerMax', labelKey: 'rule_serve_power' },
];

const pct = (v: number) => `${Math.round(v * 100)}%`;

/**
 * The strip has one line, so it names the FIRST reason — `unrankedReasons`
 * returns them most-fundamental first, so that is the one worth saying. The
 * count beside the header covers the rest.
 */
const UNRANKED_COPY_KEY = (reason: UnrankedReason | undefined): string => {
  switch (reason) {
    case 'mode':
      return 'rules_unranked_mode';
    case 'difficulty':
      return 'rules_unranked_difficulty';
    case 'outgrown':
      return 'rules_unranked_outgrown';
    case 'venue':
      return 'rules_unranked_venue';
    case 'sonar':
      return 'rules_unranked_sonar';
    default:
      return 'rules_unranked';
  }
};

export const MatchRulesPanel: React.FC<Props> = ({
  rules,
  onUpdateRules,
  lang,
  mode,
  difficulty,
  readOnly = false,
  idPrefix = 'menu',
  venueRoomId = null,
  rankMu,
}) => {
  const [open, setOpen] = useState(false);
  // Everything standing between this match and the ladder, not just the
  // sliders: the mode, the difficulty and the sonar count too.
  const blockers = unrankedReasons({ rules, mode, difficulty, venueRoomId, rankMu });
  const ranked = blockers.length === 0;
  const sonarUnranks = blockers.includes('sonar');
  // The auto-serve floor asks a NARROWER question than the badge does, and
  // conflating them made the control lie. `normalizeRoomConfig` forces the
  // timer on when `isRankedRules(rules)` — the rules alone — while `ranked`
  // above is the whole verdict, including the venue. On a Casual table the
  // venue unranks the match, so `ranked` was false, so "Off" was offered as a
  // real choice — and the server then overwrote it with 5s, silently. A Casual
  // duel is still a duel between two humans on ranked-legal rules, which is
  // exactly the stall the floor exists for.
  const autoServeForced = isRankedRules(rules);

  const toggles: { key: 'opponentSonar' | 'trackTelemetry' | 'quickChat'; labelKey: string; shown: boolean }[] = [
    { key: 'opponentSonar', labelKey: 'rule_sonar', shown: mode === 'solo' || mode === 'multiplayer' },
    { key: 'trackTelemetry', labelKey: 'rule_telemetry', shown: true },
    { key: 'quickChat', labelKey: 'rule_quickchat', shown: mode === 'multiplayer' },
  ];

  return (
    <div className="flex flex-col gap-1.5">
      <button
        id={`${idPrefix}-rules-toggle`}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center justify-between px-2.5 py-1.5 rounded-ctl border border-line bg-surface-3 text-2xs font-normal tracking-normal text-ink"
      >
        <span className="flex items-center gap-1.5">
          {ranked ? (
            <ShieldCheck className="w-3.5 h-3.5 text-win" />
          ) : (
            <ShieldAlert className="w-3.5 h-3.5 text-warn" />
          )}
          {t('match_rules', lang)}
          {!ranked && (
            <span id={`${idPrefix}-rules-altered-count`} className="text-warn">
              ({blockers.length})
            </span>
          )}
        </span>
        <ChevronDown className={`w-3.5 h-3.5 transition ${open ? 'rotate-180' : ''}`} />
      </button>

      <div
        id={`${idPrefix}-rules-status`}
        className={`px-2.5 py-1 rounded-ctl text-2xs leading-snug ${
          ranked
            ? 'border border-win/40 bg-win/10 text-win'
            : 'border border-warn/40 bg-warn/10 text-warn'
        }`}
      >
        {ranked ? t('rules_ranked', lang) : t(UNRANKED_COPY_KEY(blockers[0]), lang)}
      </div>

      {open && (
        <div
          id={`${idPrefix}-rules-panel`}
          className="flex flex-col gap-2 p-2.5 rounded-ctl border border-line bg-surface-1/60"
        >
          {SLIDERS.map(({ key, labelKey }) => {
            const spec = PHYSICS_RULES[key];
            const value = rules[key];
            const isDefault = Math.abs(value - spec.default) < 1e-6;
            const inBand = isRuleRanked(key, value);
            // The band drawn as a slice of the full track, so "how far can I
            // push this and still rate?" is answerable at a glance.
            const span = spec.max - spec.min;
            const left = ((spec.ranked.min - spec.min) / span) * 100;
            const width = ((spec.ranked.max - spec.ranked.min) / span) * 100;
            return (
              <div key={key} className="flex flex-col gap-0.5">
                <div className="flex items-center justify-between">
                  <label className="text-2xs font-normal tracking-normal text-ink-muted">{t(labelKey, lang)}</label>
                  <span
                    id={`${idPrefix}-rule-value-${key}`}
                    className={`text-2xs font-normal tracking-normal ${
                      isDefault ? 'text-ink-dim' : inBand ? 'text-accent font-bold' : 'text-warn font-bold'
                    }`}
                  >
                    {pct(value)}
                  </span>
                </div>
                <input
                  id={`${idPrefix}-rule-slider-${key}`}
                  type="range"
                  min={spec.min}
                  max={spec.max}
                  step={spec.step}
                  value={value}
                  disabled={readOnly}
                  onChange={(e) => onUpdateRules({ [key]: clampRule(key, Number(e.target.value)) })}
                  className={`w-full h-1 ${inBand ? 'accent-accent' : 'accent-warn'} disabled:opacity-60`}
                />
                <div className="relative h-1 rounded-full bg-surface-1 overflow-hidden">
                  <div
                    className="absolute inset-y-0 bg-win/40"
                    style={{ left: `${left}%`, width: `${width}%` }}
                  />
                </div>
                <span className="text-2xs font-normal tracking-normal text-ink-dim">
                  {t('rule_ranked_band', lang, { lo: pct(spec.ranked.min), hi: pct(spec.ranked.max) })}
                </span>
              </div>
            );
          })}

          {toggles
            .filter((tg) => tg.shown)
            .map((tg) => (
              <button
                key={tg.key}
                id={`${idPrefix}-rule-toggle-${tg.key}`}
                disabled={readOnly}
                onClick={() => onUpdateRules({ [tg.key]: !rules[tg.key] })}
                className="flex items-center justify-between px-2 py-1.5 rounded-ctl border border-line bg-surface-3 disabled:opacity-60"
              >
                <span className="text-2xs font-normal tracking-normal text-ink">{t(tg.labelKey, lang)}</span>
                <span
                  className={`text-2xs font-bold px-1.5 py-0.5 rounded ${
                    rules[tg.key] ? 'bg-accent/20 text-accent' : 'bg-surface-3 text-ink-dim'
                  }`}
                >
                  {rules[tg.key] ? t('rule_on', lang) : t('rule_off', lang)}
                </span>
              </button>
            ))}

          {/* The sonar is the one presentation toggle that costs the rating,
              so it is the one that has to say so where it is switched.
              Telemetry and quick chat are still free and still say nothing. */}
          {sonarUnranks && (
            <span
              id={`${idPrefix}-sonar-unranked-note`}
              className="text-2xs font-normal tracking-normal text-warn"
            >
              {t('rules_unranked_sonar', lang)}
            </span>
          )}

          {mode === 'multiplayer' && (
            <div className="flex flex-col gap-1">
              <label className="text-2xs font-normal tracking-normal text-ink-muted">{t('rule_autoserve', lang)}</label>
              <SegmentedControl
                columns={4}
                ariaLabel={t('rule_autoserve', lang)}
                value={rules.autoServeSeconds}
                readOnly={readOnly}
                onChange={(secs) => onUpdateRules({ autoServeSeconds: secs })}
                options={AUTO_SERVE_OPTIONS.map((secs) => ({
                  value: secs,
                  id: `${idPrefix}-rule-autoserve-${secs}`,
                  label: secs === 0 ? t('rule_off', lang) : `${secs}s`,
                  // Ranked play always carries a timer — "off" is only on the
                  // table once the rules have left the ranked bands.
                  disabled: secs === 0 && autoServeForced,
                }))}
              />
              {autoServeForced && (
                <span id={`${idPrefix}-autoserve-ranked-note`} className="text-2xs font-normal tracking-normal text-ink-dim">
                  {t('rule_autoserve_ranked', lang)}
                </span>
              )}
            </div>
          )}

          {!readOnly && (
            <button
              id={`${idPrefix}-rules-reset`}
              onClick={() => onUpdateRules(DEFAULT_MATCH_RULES)}
              className="flex items-center justify-center gap-1.5 py-1.5 rounded-ctl border border-line bg-surface-3 text-2xs font-normal tracking-normal text-ink"
            >
              <RotateCcw className="w-3 h-3" />
              {t('rules_reset', lang)}
            </button>
          )}
        </div>
      )}
    </div>
  );
};
