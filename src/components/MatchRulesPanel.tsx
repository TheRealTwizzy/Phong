import React, { useState } from 'react';
import { ChevronDown, RotateCcw, ShieldAlert, ShieldCheck } from 'lucide-react';
import { GameSettings, LanguageCode, MatchRules } from '../types';
import {
  AUTO_SERVE_OPTIONS,
  DEFAULT_MATCH_RULES,
  PHYSICS_RULES,
  PhysicsRuleKey,
  alteredRuleKeys,
  clampRule,
  isRankedRules,
} from '../matchRules';
import { t } from '../i18n/translations';

// Pre-match rules, collapsed by default so the menu still reads as one tap to
// play. Six sliders change the physics and cost the match its rating; four
// toggles are presentation only and never do.

interface Props {
  settings: GameSettings;
  onUpdateRules: (patch: Partial<MatchRules>) => void;
  lang: LanguageCode;
  /** Solo/practice/split have no chat or sonar to speak of. */
  mode: string;
}

const SLIDERS: { key: PhysicsRuleKey; labelKey: string }[] = [
  { key: 'paddleScale', labelKey: 'rule_paddle_size' },
  { key: 'ballScale', labelKey: 'rule_ball_size' },
  { key: 'ballSpeedMin', labelKey: 'rule_speed_min' },
  { key: 'ballSpeedMax', labelKey: 'rule_speed_max' },
  { key: 'serveAngleMax', labelKey: 'rule_serve_angle' },
  { key: 'servePowerMax', labelKey: 'rule_serve_power' },
];

export const MatchRulesPanel: React.FC<Props> = ({ settings, onUpdateRules, lang, mode }) => {
  const [open, setOpen] = useState(false);
  const rules = settings.rules;
  const ranked = isRankedRules(rules);
  const altered = alteredRuleKeys(rules);

  const toggles: { key: 'opponentSonar' | 'trackTelemetry' | 'quickChat'; labelKey: string; shown: boolean }[] = [
    { key: 'opponentSonar', labelKey: 'rule_sonar', shown: mode === 'solo' || mode === 'multiplayer' },
    { key: 'trackTelemetry', labelKey: 'rule_telemetry', shown: true },
    { key: 'quickChat', labelKey: 'rule_quickchat', shown: mode === 'multiplayer' },
  ];

  return (
    <div className="flex flex-col gap-1.5">
      <button
        id="menu-rules-toggle"
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
            <span id="menu-rules-altered-count" className="text-amber-400">
              ({altered.length})
            </span>
          )}
        </span>
        <ChevronDown className={`w-3.5 h-3.5 transition ${open ? 'rotate-180' : ''}`} />
      </button>

      <div
        id="menu-rules-status"
        className={`px-2.5 py-1 rounded-lg text-[9px] font-mono leading-snug ${
          ranked
            ? 'bg-emerald-950/40 text-emerald-300 border border-emerald-900/60'
            : 'bg-amber-950/40 text-amber-300 border border-amber-900/60'
        }`}
      >
        {ranked ? t('rules_ranked', lang) : t('rules_unranked', lang)}
      </div>

      {open && (
        <div id="menu-rules-panel" className="flex flex-col gap-2 p-2.5 rounded-lg border border-zinc-800 bg-zinc-950/60">
          {SLIDERS.map(({ key, labelKey }) => {
            const spec = PHYSICS_RULES[key];
            const value = rules[key];
            const isDefault = Math.abs(value - spec.default) < 1e-6;
            return (
              <div key={key} className="flex flex-col gap-0.5">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] font-mono text-zinc-400">{t(labelKey, lang)}</label>
                  <span
                    id={`rule-value-${key}`}
                    className={`text-[10px] font-mono ${isDefault ? 'text-zinc-500' : 'text-amber-300 font-bold'}`}
                  >
                    {Math.round(value * 100)}%
                  </span>
                </div>
                <input
                  id={`rule-slider-${key}`}
                  type="range"
                  min={spec.min}
                  max={spec.max}
                  step={spec.step}
                  value={value}
                  onChange={(e) => onUpdateRules({ [key]: clampRule(key, Number(e.target.value)) })}
                  className="w-full accent-cyan-400 h-1"
                />
              </div>
            );
          })}

          {toggles
            .filter((tg) => tg.shown)
            .map((tg) => (
              <button
                key={tg.key}
                id={`rule-toggle-${tg.key}`}
                onClick={() => onUpdateRules({ [tg.key]: !rules[tg.key] })}
                className="flex items-center justify-between px-2 py-1.5 rounded-lg border border-zinc-800 bg-zinc-900/60"
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
                    id={`rule-autoserve-${secs}`}
                    onClick={() => onUpdateRules({ autoServeSeconds: secs })}
                    className={`py-1.5 rounded-lg text-[10px] font-mono border transition ${
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

          <button
            id="menu-rules-reset"
            onClick={() => onUpdateRules(DEFAULT_MATCH_RULES)}
            disabled={ranked && rules.autoServeSeconds === DEFAULT_MATCH_RULES.autoServeSeconds}
            className="flex items-center justify-center gap-1.5 py-1.5 rounded-lg border border-zinc-800 bg-zinc-900/60 text-[10px] font-mono text-zinc-300 disabled:opacity-40"
          >
            <RotateCcw className="w-3 h-3" />
            {t('rules_reset', lang)}
          </button>
        </div>
      )}
    </div>
  );
};
