import React, { useState } from 'react';
import { ChevronDown, RotateCcw, ShieldAlert, ShieldCheck } from 'lucide-react';
import { LanguageCode, MatchRules } from '../types';
import {
  AUTO_SERVE_OPTIONS,
  DEFAULT_MATCH_RULES,
  PHYSICS_RULES,
  PhysicsRuleKey,
  isRankedRules,
  isRuleRanked,
  clampRule,
  unrankedRuleKeys,
} from '../matchRules';
import { t } from '../i18n/translations';

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
  /** Solo/practice/split have no chat or sonar to speak of. */
  mode: string;
  /** The guest's view of the host's rules: visible, not editable. */
  readOnly?: boolean;
  /** Keeps ids unique when the lobby renders over the menu. */
  idPrefix?: string;
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

export const MatchRulesPanel: React.FC<Props> = ({
  rules,
  onUpdateRules,
  lang,
  mode,
  readOnly = false,
  idPrefix = 'menu',
}) => {
  const [open, setOpen] = useState(false);
  const ranked = isRankedRules(rules);
  const beyond = unrankedRuleKeys(rules);

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
        className="flex items-center justify-between px-2.5 py-1.5 rounded-lg border border-zinc-800 bg-zinc-900/60 text-[10px] font-mono text-zinc-300"
      >
        <span className="flex items-center gap-1.5">
          {ranked ? (
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
          ) : (
            <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
          )}
          {t('match_rules', lang)}
          {!ranked && (
            <span id={`${idPrefix}-rules-altered-count`} className="text-amber-400">
              ({beyond.length})
            </span>
          )}
        </span>
        <ChevronDown className={`w-3.5 h-3.5 transition ${open ? 'rotate-180' : ''}`} />
      </button>

      <div
        id={`${idPrefix}-rules-status`}
        className={`px-2.5 py-1 rounded-lg text-[9px] font-mono leading-snug ${
          ranked
            ? 'bg-emerald-950/40 text-emerald-300 border border-emerald-900/60'
            : 'bg-amber-950/40 text-amber-300 border border-amber-900/60'
        }`}
      >
        {ranked ? t('rules_ranked', lang) : t('rules_unranked', lang)}
      </div>

      {open && (
        <div
          id={`${idPrefix}-rules-panel`}
          className="flex flex-col gap-2 p-2.5 rounded-lg border border-zinc-800 bg-zinc-950/60"
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
                  <label className="text-[10px] font-mono text-zinc-400">{t(labelKey, lang)}</label>
                  <span
                    id={`${idPrefix}-rule-value-${key}`}
                    className={`text-[10px] font-mono ${
                      isDefault ? 'text-zinc-500' : inBand ? 'text-cyan-300 font-bold' : 'text-amber-300 font-bold'
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
                  className={`w-full h-1 ${inBand ? 'accent-cyan-400' : 'accent-amber-400'} disabled:opacity-60`}
                />
                <div className="relative h-1 rounded-full bg-zinc-900 overflow-hidden">
                  <div
                    className="absolute inset-y-0 bg-emerald-500/40"
                    style={{ left: `${left}%`, width: `${width}%` }}
                  />
                </div>
                <span className="text-[8px] font-mono text-zinc-600">
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
                className="flex items-center justify-between px-2 py-1.5 rounded-lg border border-zinc-800 bg-zinc-900/60 disabled:opacity-60"
              >
                <span className="text-[10px] font-mono text-zinc-300">{t(tg.labelKey, lang)}</span>
                <span
                  className={`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded ${
                    rules[tg.key] ? 'bg-cyan-950 text-cyan-300' : 'bg-zinc-800 text-zinc-500'
                  }`}
                >
                  {rules[tg.key] ? t('rule_on', lang) : t('rule_off', lang)}
                </span>
              </button>
            ))}

          {mode === 'multiplayer' && (
            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-mono text-zinc-400">{t('rule_autoserve', lang)}</label>
              <div className="grid grid-cols-4 gap-1.5">
                {AUTO_SERVE_OPTIONS.map((secs) => (
                  <button
                    key={secs}
                    id={`${idPrefix}-rule-autoserve-${secs}`}
                    disabled={readOnly}
                    onClick={() => onUpdateRules({ autoServeSeconds: secs })}
                    className={`py-1.5 rounded-lg text-[10px] font-mono border transition disabled:opacity-60 ${
                      rules.autoServeSeconds === secs
                        ? 'border-cyan-400 bg-cyan-950/60 text-cyan-200 font-bold'
                        : 'border-zinc-800 bg-zinc-900/60 text-zinc-400'
                    }`}
                  >
                    {secs === 0 ? t('rule_off', lang) : `${secs}s`}
                  </button>
                ))}
              </div>
            </div>
          )}

          {!readOnly && (
            <button
              id={`${idPrefix}-rules-reset`}
              onClick={() => onUpdateRules(DEFAULT_MATCH_RULES)}
              className="flex items-center justify-center gap-1.5 py-1.5 rounded-lg border border-zinc-800 bg-zinc-900/60 text-[10px] font-mono text-zinc-300"
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
