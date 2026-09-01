import React from 'react';
import { GameSettings, LanguageCode, SoundscapeType } from '../types';
import { LANGUAGES, t } from '../i18n/translations';
import { sound } from '../audio/soundEffects';
import { APP_VERSION } from '../version';
import {
  Smartphone,
  Volume2,
  VolumeX,
  Music,
  Vibrate,
  Eye,
  Globe,
  Flame,
  Crosshair,
  Waves,
  Zap,
  ChevronRight,
  Newspaper,
  Flag,
} from 'lucide-react';

// Every device and presentation preference, with no chrome of its own — so the
// same controls serve the in-match HUD's sheet and the SETTINGS page. Match
// settings (mode, difficulty, winning score) are chosen on the main menu BEFORE
// a match starts, and paddle width / ball speed are fixed constants: never here.
//
// Account deletion is deliberately NOT in this panel. It is the one thing here
// that cannot be flipped back, and it is gated on being out of a match, so it
// stays with its host rather than travelling to every surface that wants a
// volume slider.

export interface SettingsPanelProps {
  settings: GameSettings;
  onUpdateSettings: (newSettings: Partial<GameSettings>) => void;
  onTriggerShake?: () => void;
  /**
   * True while the match's rules have the opponent sonar on. The two net
   * indicators are suppressed for that match — the sonar draws the whole far
   * half anyway — so the rows show what is actually happening (off, and not
   * yours to change right now) instead of promising something that is not on
   * screen. The stored preferences are untouched and come back by themselves.
   */
  indicatorsLockedBySonar?: boolean;
  /**
   * Absent = not offered, the same contract AccountDangerZone uses for
   * deletion. Both of these are menu-only: this panel is also the body of the
   * in-match settings modal, and a form to type into is not something to open
   * over a live court with a ball on it.
   */
  onOpenPatchNotes?: () => void;
  onOpenReport?: () => void;
  /** True when the newest patch note is one this device has not opened. */
  patchNotesUnread?: boolean;
}

export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  settings,
  onUpdateSettings,
  onTriggerShake,
  indicatorsLockedBySonar = false,
  onOpenPatchNotes,
  onOpenReport,
  patchNotesUnread = false,
}) => {
  const lang = settings.language || 'en';

  const handleRequestTiltPermission = async () => {
    const DeviceOrientation = window.DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<'granted' | 'denied'>;
    };

    if (typeof DeviceOrientation?.requestPermission === 'function') {
      try {
        const response = await DeviceOrientation.requestPermission();
        if (response === 'granted') {
          onUpdateSettings({ tiltEnabled: true });
        } else {
          alert(t('motion_permission_denied', lang));
        }
      } catch (err) {
        console.error(err);
      }
    } else {
      onUpdateSettings({ tiltEnabled: !settings.tiltEnabled });
    }
  };

  const handleTestHaptic = () => {
    if (navigator.vibrate) {
      const ms = Math.round(30 * ((settings.hapticIntensity || 70) / 100));
      try {
        navigator.vibrate(ms);
      } catch {}
    }
  };

  const handleTestShake = () => {
    if (onTriggerShake) {
      onTriggerShake();
    }
    sound.playWallBounce();
  };

  const soundscapes: { id: SoundscapeType; labelKey: string; icon: string; desc: string }[] = [
    { id: 'none', labelKey: 'soundscape_none', icon: '🔇', desc: 'No background ambient audio' },
    { id: 'stadium', labelKey: 'soundscape_stadium', icon: '🏟️', desc: 'Cheering stadium crowd atmosphere' },
    { id: 'cyberpunk', labelKey: 'soundscape_cyberpunk', icon: '🌃', desc: 'Futuristic city hum & synth waves' },
    { id: 'zen', labelKey: 'soundscape_zen', icon: '🎋', desc: 'Calm bamboo wind & natural resonance' },
  ];

  return (
    <>

      {/* Language Selection Dropdown */}
      <div className="flex flex-col gap-1.5 p-3 rounded-2xl bg-surface-2/70 border border-line">
        <label className="text-xs font-mono font-bold text-ink flex items-center gap-1.5">
          <Globe className="w-4 h-4 text-accent" />
          {t('language', lang)}
        </label>
        <p className="text-[10px] text-ink-muted mb-1">
          {t('language_desc', lang)}
        </p>
        <div className="relative">
          <select
            id="language-select-dropdown"
            value={lang}
            onChange={(e) => onUpdateSettings({ language: e.target.value as LanguageCode })}
            className="w-full bg-surface-0 text-ink text-xs font-bold font-mono py-2.5 px-3 rounded-xl border border-line-strong hover:border-accent/60 focus:border-accent focus:outline-none transition cursor-pointer appearance-none"
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code} className="bg-surface-2 text-ink py-1">
                {l.flag} {l.nativeName} ({l.label})
              </option>
            ))}
          </select>
          <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-ink-muted">
            <span className="text-xs">▼</span>
          </div>
        </div>
      </div>

      {/* Audio & Environment Soundscape Section */}
      <div className="flex flex-col gap-3.5 p-3.5 rounded-2xl bg-surface-2/60 border border-line">
        <div className="flex items-center justify-between">
          <span className="text-xs font-mono font-bold text-ink flex items-center gap-1.5">
            <Volume2 className="w-4 h-4 text-win" />
            {t('sound_effects', lang)}
          </span>
          <button
            id="toggle-master-sound"
            onClick={() => onUpdateSettings({ soundEnabled: !settings.soundEnabled })}
            className={`text-[10px] px-2 py-0.5 rounded-lg font-mono font-bold border transition ${
              settings.soundEnabled
                ? 'bg-win/20 text-win border-win/40'
                : 'bg-surface-3 text-ink-muted border-line-strong'
            }`}
          >
            {settings.soundEnabled ? t('sound_on', lang) : t('sound_off', lang)}
          </button>
        </div>

        {/* SFX Volume Slider */}
        <div>
          <div className="flex justify-between text-xs font-mono mb-1.5">
            <span className="text-ink-muted flex items-center gap-1">
              <Volume2 className="w-3.5 h-3.5 text-accent" />
              {t('sound_effects', lang)}
            </span>
            <span className="text-accent font-bold">{settings.sfxVolume ?? 80}%</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onUpdateSettings({ sfxVolume: (settings.sfxVolume ?? 80) === 0 ? 80 : 0 })}
              className="text-ink-muted hover:text-ink p-0.5"
              title={t('mute_sfx', lang)}
              aria-label={t('mute_sfx', lang)}
            >
              {(settings.sfxVolume ?? 80) === 0 ? (
                <VolumeX className="w-4 h-4 text-loss" />
              ) : (
                <Volume2 className="w-4 h-4 text-ink-muted" />
              )}
            </button>
            <input
              id="slider-sfx-volume"
              type="range"
              min="0"
              max="100"
              step="5"
              value={settings.sfxVolume ?? 80}
              onChange={(e) => onUpdateSettings({ sfxVolume: parseInt(e.target.value, 10) })}
              className="w-full accent-cyan-400 h-1.5 rounded-lg bg-surface-4 cursor-pointer"
            />
          </div>
        </div>

        {/* Background Music (BGM) Slider */}
        <div>
          <div className="flex justify-between text-xs font-mono mb-1.5">
            <span className="text-ink-muted flex items-center gap-1">
              <Music className="w-3.5 h-3.5 text-rank-steady" />
              {t('bgm_music', lang)}
            </span>
            <span className="text-rank-steady font-bold">{settings.bgmVolume ?? 50}%</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onUpdateSettings({ bgmVolume: (settings.bgmVolume ?? 50) === 0 ? 50 : 0 })}
              className="text-ink-muted hover:text-ink p-0.5"
              title={t('mute_music', lang)}
              aria-label={t('mute_music', lang)}
            >
              {(settings.bgmVolume ?? 50) === 0 ? (
                <VolumeX className="w-4 h-4 text-loss" />
              ) : (
                <Music className="w-4 h-4 text-ink-muted" />
              )}
            </button>
            <input
              id="slider-bgm-volume"
              type="range"
              min="0"
              max="100"
              step="5"
              value={settings.bgmVolume ?? 50}
              onChange={(e) => onUpdateSettings({ bgmVolume: parseInt(e.target.value, 10) })}
              className="w-full accent-purple-400 h-1.5 rounded-lg bg-surface-4 cursor-pointer"
            />
          </div>
        </div>

        {/* Environment Soundscape Selection & Volume */}
        <div className="pt-2 border-t border-line/80 flex flex-col gap-2.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Waves className="w-4 h-4 text-accent" />
              <span className="text-xs font-mono font-bold text-ink">
                {t('environment_title', lang)}
              </span>
            </div>
            <span className="text-[10px] font-mono text-accent font-bold uppercase">
              {settings.soundscape || 'none'}
            </span>
          </div>

          {/* Soundscape Options Grid */}
          <div className="grid grid-cols-2 gap-1.5">
            {soundscapes.map((sc) => {
              const isSelected = (settings.soundscape || 'none') === sc.id;
              return (
                <button
                  key={sc.id}
                  id={`soundscape-select-${sc.id}`}
                  onClick={() => {
                    onUpdateSettings({ soundscape: sc.id });
                    if (sc.id !== 'none') {
                      sound.startSoundscape(sc.id, (settings.soundscapeVolume ?? 40) / 100);
                    } else {
                      sound.stopSoundscape();
                    }
                  }}
                  className={`p-2 rounded-xl border text-left flex items-center gap-2 transition active:scale-95 ${
                    isSelected
                      ? 'border-accent bg-accent/50 text-accent font-bold shadow-sm'
                      : 'border-line bg-surface-0/60 hover:bg-surface-3/50 text-ink-muted'
                  }`}
                >
                  <span className="text-sm">{sc.icon}</span>
                  <div className="flex flex-col min-w-0">
                    <span className="text-xs font-mono truncate">{t(sc.labelKey, lang)}</span>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Soundscape Volume Slider */}
          {settings.soundscape && settings.soundscape !== 'none' && (
            <div className="mt-1">
              <div className="flex justify-between text-xs font-mono mb-1">
                <span className="text-ink-muted">{t('soundscape_volume', lang)}</span>
                <span className="text-accent font-bold">{settings.soundscapeVolume ?? 40}%</span>
              </div>
              <input
                id="slider-soundscape-volume"
                type="range"
                min="0"
                max="100"
                step="5"
                value={settings.soundscapeVolume ?? 40}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10);
                  onUpdateSettings({ soundscapeVolume: val });
                  sound.setSoundscapeVolume(val / 100);
                }}
                className="w-full accent-cyan-400 h-1.5 rounded-lg bg-surface-4 cursor-pointer"
              />
            </div>
          )}
        </div>
      </div>

      {/* Screen Shake Intensity Control */}
      <div className="flex flex-col gap-2 p-3.5 rounded-2xl bg-surface-2/60 border border-line">
        <div className="flex items-center justify-between">
          <span className="text-xs font-mono font-bold text-ink flex items-center gap-1.5">
            <Zap className="w-4 h-4 text-warn" />
            {t('screen_shake', lang)}
          </span>
          <div className="flex items-center gap-2">
            <span className="text-warn font-bold text-xs font-mono">
              {settings.screenShakeIntensity ?? 60}%
            </span>
            <button
              id="btn-test-screen-shake"
              onClick={handleTestShake}
              className="text-[10px] px-2.5 py-0.5 rounded-lg bg-surface-3 hover:bg-surface-4 text-ink border border-line-strong active:scale-95 transition"
            >
              {t('test_shake', lang)}
            </button>
          </div>
        </div>
        <p className="text-[10px] text-ink-muted">
          {t('screen_shake_desc', lang)}
        </p>
        <input
          id="slider-screen-shake"
          type="range"
          min="0"
          max="100"
          step="10"
          value={settings.screenShakeIntensity ?? 60}
          onChange={(e) => onUpdateSettings({ screenShakeIntensity: parseInt(e.target.value, 10) })}
          className="w-full accent-amber-400 h-1.5 rounded-lg bg-surface-4 cursor-pointer"
        />
      </div>

      {/* Haptic Feedback Intensity Slider */}
      <div className="flex flex-col gap-2.5 p-3.5 rounded-2xl bg-surface-2/60 border border-line">
        <div className="flex items-center justify-between">
          <span className="text-xs font-mono font-bold text-ink flex items-center gap-1.5">
            <Vibrate className="w-4 h-4 text-warn" />
            {t('haptics', lang)}
          </span>
          <button
            id="toggle-haptics"
            onClick={() => onUpdateSettings({ hapticsEnabled: !settings.hapticsEnabled })}
            className={`w-10 h-5 rounded-full transition-colors relative p-0.5 ${
              settings.hapticsEnabled ? 'bg-warn' : 'bg-surface-4'
            }`}
          >
            <div
              className={`w-4 h-4 rounded-full bg-white cos-light:bg-surface-1 transition-transform ${
                settings.hapticsEnabled ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        {settings.hapticsEnabled && (
          <div className="pt-1">
            <div className="flex justify-between items-center text-xs font-mono mb-1.5">
              <span className="text-ink-muted">{t('haptic_intensity', lang)}</span>
              <div className="flex items-center gap-2">
                <span className="text-warn font-bold">{settings.hapticIntensity ?? 75}%</span>
                <button
                  onClick={handleTestHaptic}
                  className="text-[10px] px-2 py-0.5 rounded-lg bg-surface-3 hover:bg-surface-4 text-ink border border-line-strong active:scale-95 transition"
                >
                  {t('test_tap', lang)}
                </button>
              </div>
            </div>
            <input
              id="slider-haptic-intensity"
              type="range"
              min="10"
              max="100"
              step="5"
              value={settings.hapticIntensity ?? 75}
              onChange={(e) => onUpdateSettings({ hapticIntensity: parseInt(e.target.value, 10) })}
              className="w-full accent-amber-400 h-1.5 rounded-lg bg-surface-4 cursor-pointer"
            />
          </div>
        )}
      </div>

      {/* Toggles: Ball Trails, Gyroscope Tilt, Sonar Radar, the two net markers */}
      <div className="flex flex-col gap-2">
        {/* Dynamic Ball Velocity Trails */}
        <div className="flex items-center justify-between p-2.5 rounded-2xl bg-surface-2/40 border border-line">
          <div className="flex items-center gap-2">
            <Flame className="w-4 h-4 text-warn" />
            <div>
              <div className="text-xs font-mono font-medium">{t('ball_trails', lang)}</div>
              <div className="text-[10px] text-ink-muted">{t('ball_trails_desc', lang)}</div>
            </div>
          </div>
          <button
            id="toggle-ball-trails"
            onClick={() => onUpdateSettings({ showTrails: !settings.showTrails })}
            className={`w-11 h-6 rounded-full transition-colors relative p-0.5 ${
              settings.showTrails ? 'bg-warn' : 'bg-surface-4'
            }`}
          >
            <div
              className={`w-5 h-5 rounded-full bg-white cos-light:bg-surface-1 transition-transform ${
                settings.showTrails ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        {/* Tilt motion */}
        <div className="flex items-center justify-between p-2.5 rounded-2xl bg-surface-2/40 border border-line">
          <div className="flex items-center gap-2">
            <Smartphone className="w-4 h-4 text-accent" />
            <div>
              <div className="text-xs font-mono font-medium">{t('tilt_gyro', lang)}</div>
              <div className="text-[10px] text-ink-muted">{t('tilt_gyro_desc', lang)}</div>
            </div>
          </div>
          <button
            id="toggle-tilt-control"
            onClick={handleRequestTiltPermission}
            className={`w-11 h-6 rounded-full transition-colors relative p-0.5 ${
              settings.tiltEnabled ? 'bg-accent' : 'bg-surface-4'
            }`}
          >
            <div
              className={`w-5 h-5 rounded-full bg-white cos-light:bg-surface-1 transition-transform ${
                settings.tiltEnabled ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        {/* Sonar Radar Preview */}
        <div className="flex items-center justify-between p-2.5 rounded-2xl bg-surface-2/40 border border-line">
          <div className="flex items-center gap-2">
            <Eye className="w-4 h-4 text-win" />
            <div>
              <div className="text-xs font-mono font-medium">{t('opponent_radar', lang)}</div>
              <div className="text-[10px] text-ink-muted">{t('opponent_radar_desc', lang)}</div>
            </div>
          </div>
          <button
            id="toggle-radar-preview"
            onClick={() => onUpdateSettings({ showRadar: !settings.showRadar })}
            className={`w-11 h-6 rounded-full transition-colors relative p-0.5 ${
              settings.showRadar ? 'bg-win' : 'bg-surface-4'
            }`}
          >
            <div
              className={`w-5 h-5 rounded-full bg-white cos-light:bg-surface-1 transition-transform ${
                settings.showRadar ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        {/* The two net indicators. Unlike the sonar above them these survive
            inside a ranked match, which is the whole trade: the sonar hands
            you the far half and costs the rating, these two name where the
            opponent is and whether the ball is over there, and cost nothing.
            A match played WITH the sonar suppresses both, and the rows say
            so rather than reading as on while nothing is drawn. */}
        {(
          [
            {
              id: 'toggle-opponent-indicator',
              key: 'showOpponentIndicator',
              labelKey: 'setting_opponent_indicator',
              hintKey: 'setting_opponent_indicator_hint',
            },
            {
              id: 'toggle-ball-indicator',
              key: 'showBallIndicator',
              labelKey: 'setting_ball_indicator',
              hintKey: 'setting_ball_indicator_hint',
            },
          ] as const
        ).map((row) => {
          const on = settings[row.key] && !indicatorsLockedBySonar;
          return (
            <div
              key={row.id}
              className={`flex items-center justify-between p-2.5 rounded-2xl bg-surface-2/40 border border-line ${
                indicatorsLockedBySonar ? 'opacity-60' : ''
              }`}
            >
              <div className="flex items-center gap-2">
                <Crosshair className="w-4 h-4 text-accent" />
                <div>
                  <div className="text-xs font-mono font-medium">{t(row.labelKey, lang)}</div>
                  <div className="text-[10px] text-ink-muted">
                    {indicatorsLockedBySonar
                      ? t('indicator_locked_by_sonar', lang)
                      : t(row.hintKey, lang)}
                  </div>
                </div>
              </div>
              <button
                id={row.id}
                disabled={indicatorsLockedBySonar}
                onClick={() => onUpdateSettings({ [row.key]: !settings[row.key] })}
                className={`w-11 h-6 rounded-full transition-colors relative p-0.5 disabled:cursor-not-allowed ${
                  on ? 'bg-accent' : 'bg-surface-4'
                }`}
              >
                <div
                  className={`w-5 h-5 rounded-full bg-white cos-light:bg-surface-1 transition-transform ${
                    on ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
          );
        })}
      </div>

      {/* About & feedback.
          Rendered only where the callbacks are supplied, which is the menu:
          see the prop docs. A row that opens a sub-sheet is new to this
          panel — every other control here mutates `settings` in place — so it
          is built as a plain button carrying the same card chrome the sections
          above use, rather than a new primitive nothing else would reuse. */}
      {(onOpenPatchNotes || onOpenReport) && (
        <div className="flex flex-col gap-2 rounded-2xl border border-line bg-surface-2/60 p-3.5">
          {onOpenPatchNotes && (
            <button
              id="btn-open-patch-notes"
              onClick={onOpenPatchNotes}
              className="flex items-center justify-between gap-2 rounded-ctl px-1 py-1.5 text-left transition-colors hover:bg-surface-3"
            >
              <span className="flex min-w-0 items-center gap-1.5 text-xs font-mono font-bold text-ink">
                <Newspaper className="h-4 w-4 shrink-0 text-accent" />
                <span className="truncate">{t('patch_notes_title', lang)}</span>
                {patchNotesUnread && (
                  <span
                    id="patch-notes-dot"
                    aria-label={t('patch_notes_new', lang)}
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                  />
                )}
              </span>
              <span className="flex shrink-0 items-center gap-1">
                <span className="font-mono text-[10px] text-ink-muted">v{APP_VERSION}</span>
                <ChevronRight className="h-4 w-4 text-ink-muted" />
              </span>
            </button>
          )}
          {onOpenReport && (
            <button
              id="btn-open-report"
              onClick={onOpenReport}
              className="flex items-center justify-between gap-2 rounded-ctl px-1 py-1.5 text-left transition-colors hover:bg-surface-3"
            >
              <span className="flex min-w-0 items-center gap-1.5 text-xs font-mono font-bold text-ink">
                <Flag className="h-4 w-4 shrink-0 text-warn" />
                <span className="truncate">{t('report_title', lang)}</span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-ink-muted" />
            </button>
          )}
        </div>
      )}
    </>
  );
};
