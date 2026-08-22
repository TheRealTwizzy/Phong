import React from 'react';
import { CourtTheme, GameSettings, LanguageCode, PlayerProfile, SoundscapeType } from '../types';
import { THEMES, ThemeConfig, isThemeUnlocked } from '../game/themes';
import { LANGUAGES, t } from '../i18n/translations';
import { sound } from '../audio/soundEffects';
import {
  X,
  Smartphone,
  Sparkles,
  Sliders,
  Volume2,
  VolumeX,
  Music,
  Vibrate,
  Eye,
  Activity,
  Globe,
  Flame,
  Radio,
  Lock,
  CheckCircle,
  BookOpen,
  Waves,
  Zap,
} from 'lucide-react';

// Device & presentation preferences only. Match settings (mode, difficulty,
// winning score) are chosen on the main menu BEFORE a match starts, and
// paddle width / ball speed are fixed constants — never editable here.
interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: GameSettings;
  onUpdateSettings: (newSettings: Partial<GameSettings>) => void;
  currentTheme: ThemeConfig;
  profile?: PlayerProfile | null;
  onOpenTutorial?: () => void;
  onTriggerShake?: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  onUpdateSettings,
  currentTheme,
  profile = null,
  onOpenTutorial,
  onTriggerShake,
}) => {
  if (!isOpen) return null;
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
          alert('Motion sensor permission was denied in your browser settings.');
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
    <div
      id="settings-modal-overlay"
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/85 backdrop-blur-md animate-in fade-in duration-200"
    >
      <div
        className="w-full max-w-lg max-h-[92vh] rounded-3xl border p-4 sm:p-6 shadow-2xl relative flex flex-col gap-4 overflow-y-auto text-zinc-100"
        style={{
          backgroundColor: '#0f141f',
          borderColor: currentTheme.accentColor + '50',
          boxShadow: `0 0 35px ${currentTheme.accentColor}20`,
        }}
      >
        {/* Close Button */}
        <button
          id="btn-close-settings"
          onClick={onClose}
          className="absolute top-4 right-4 p-2 rounded-xl bg-zinc-800/80 hover:bg-zinc-700 text-zinc-400 hover:text-white transition"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Header with Tutorial Launch Button */}
        <div className="flex items-center justify-between pr-8">
          <div className="flex items-center gap-2.5">
            <Sliders className="w-5 h-5" style={{ color: currentTheme.accentColor }} />
            <h2 className="text-base sm:text-lg font-bold font-mono tracking-wide">
              {t('settings_title', lang)}
            </h2>
          </div>

          {onOpenTutorial && (
            <button
              id="btn-settings-start-tutorial"
              onClick={() => {
                onClose();
                onOpenTutorial();
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-mono font-bold bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 border border-cyan-500/40 transition active:scale-95 shadow-sm"
            >
              <BookOpen className="w-3.5 h-3.5" />
              <span>{t('start_tutorial', lang)}</span>
            </button>
          )}
        </div>

        {/* Language Selection Dropdown */}
        <div className="flex flex-col gap-1.5 p-3 rounded-2xl bg-zinc-900/70 border border-zinc-800">
          <label className="text-xs font-mono font-bold text-zinc-300 flex items-center gap-1.5">
            <Globe className="w-4 h-4 text-cyan-400" />
            {t('language', lang)}
          </label>
          <p className="text-[10px] text-zinc-400 mb-1">
            {t('language_desc', lang)}
          </p>
          <div className="relative">
            <select
              id="language-select-dropdown"
              value={lang}
              onChange={(e) => onUpdateSettings({ language: e.target.value as LanguageCode })}
              className="w-full bg-slate-950 text-slate-100 text-xs font-bold font-mono py-2.5 px-3 rounded-xl border border-slate-700 hover:border-cyan-500/60 focus:border-cyan-400 focus:outline-none transition cursor-pointer appearance-none"
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code} className="bg-slate-900 text-white py-1">
                  {l.flag} {l.nativeName} ({l.label})
                </option>
              ))}
            </select>
            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-slate-400">
              <span className="text-xs">▼</span>
            </div>
          </div>
        </div>

        {/* Audio & Environment Soundscape Section */}
        <div className="flex flex-col gap-3.5 p-3.5 rounded-2xl bg-zinc-900/60 border border-zinc-800">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono font-bold text-zinc-300 flex items-center gap-1.5">
              <Volume2 className="w-4 h-4 text-emerald-400" />
              {t('sound_effects', lang)}
            </span>
            <button
              id="toggle-master-sound"
              onClick={() => onUpdateSettings({ soundEnabled: !settings.soundEnabled })}
              className={`text-[10px] px-2 py-0.5 rounded-lg font-mono font-bold border transition ${
                settings.soundEnabled
                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                  : 'bg-zinc-800 text-zinc-500 border-zinc-700'
              }`}
            >
              {settings.soundEnabled ? t('sound_on', lang) : t('sound_off', lang)}
            </button>
          </div>

          {/* SFX Volume Slider */}
          <div>
            <div className="flex justify-between text-xs font-mono mb-1.5">
              <span className="text-zinc-400 flex items-center gap-1">
                <Volume2 className="w-3.5 h-3.5 text-cyan-400" />
                {t('sound_effects', lang)}
              </span>
              <span className="text-cyan-400 font-bold">{settings.sfxVolume ?? 80}%</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => onUpdateSettings({ sfxVolume: (settings.sfxVolume ?? 80) === 0 ? 80 : 0 })}
                className="text-zinc-500 hover:text-zinc-300 p-0.5"
                title="Mute SFX"
              >
                {(settings.sfxVolume ?? 80) === 0 ? (
                  <VolumeX className="w-4 h-4 text-rose-400" />
                ) : (
                  <Volume2 className="w-4 h-4 text-zinc-400" />
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
                className="w-full accent-cyan-400 h-1.5 rounded-lg bg-zinc-700 cursor-pointer"
              />
            </div>
          </div>

          {/* Background Music (BGM) Slider */}
          <div>
            <div className="flex justify-between text-xs font-mono mb-1.5">
              <span className="text-zinc-400 flex items-center gap-1">
                <Music className="w-3.5 h-3.5 text-purple-400" />
                {t('bgm_music', lang)}
              </span>
              <span className="text-purple-400 font-bold">{settings.bgmVolume ?? 50}%</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => onUpdateSettings({ bgmVolume: (settings.bgmVolume ?? 50) === 0 ? 50 : 0 })}
                className="text-zinc-500 hover:text-zinc-300 p-0.5"
                title="Mute Music"
              >
                {(settings.bgmVolume ?? 50) === 0 ? (
                  <VolumeX className="w-4 h-4 text-rose-400" />
                ) : (
                  <Music className="w-4 h-4 text-zinc-400" />
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
                className="w-full accent-purple-400 h-1.5 rounded-lg bg-zinc-700 cursor-pointer"
              />
            </div>
          </div>

          {/* Environment Soundscape Selection & Volume */}
          <div className="pt-2 border-t border-zinc-800/80 flex flex-col gap-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Waves className="w-4 h-4 text-cyan-400" />
                <span className="text-xs font-mono font-bold text-zinc-300">
                  {t('environment_title', lang)}
                </span>
              </div>
              <span className="text-[10px] font-mono text-cyan-400 font-bold uppercase">
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
                        ? 'border-cyan-400 bg-cyan-950/50 text-cyan-200 font-bold shadow-sm'
                        : 'border-zinc-800 bg-zinc-950/60 hover:bg-zinc-800/50 text-zinc-400'
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
                  <span className="text-zinc-400">{t('soundscape_volume', lang)}</span>
                  <span className="text-cyan-400 font-bold">{settings.soundscapeVolume ?? 40}%</span>
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
                  className="w-full accent-cyan-400 h-1.5 rounded-lg bg-zinc-700 cursor-pointer"
                />
              </div>
            )}
          </div>
        </div>

        {/* Screen Shake Intensity Control */}
        <div className="flex flex-col gap-2 p-3.5 rounded-2xl bg-zinc-900/60 border border-zinc-800">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono font-bold text-zinc-300 flex items-center gap-1.5">
              <Zap className="w-4 h-4 text-amber-400" />
              {t('screen_shake', lang)}
            </span>
            <div className="flex items-center gap-2">
              <span className="text-amber-400 font-bold text-xs font-mono">
                {settings.screenShakeIntensity ?? 60}%
              </span>
              <button
                id="btn-test-screen-shake"
                onClick={handleTestShake}
                className="text-[10px] px-2.5 py-0.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 active:scale-95 transition"
              >
                {t('test_shake', lang)}
              </button>
            </div>
          </div>
          <p className="text-[10px] text-zinc-400">
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
            className="w-full accent-amber-400 h-1.5 rounded-lg bg-zinc-700 cursor-pointer"
          />
        </div>

        {/* Haptic Feedback Intensity Slider */}
        <div className="flex flex-col gap-2.5 p-3.5 rounded-2xl bg-zinc-900/60 border border-zinc-800">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono font-bold text-zinc-300 flex items-center gap-1.5">
              <Vibrate className="w-4 h-4 text-amber-400" />
              {t('haptics', lang)}
            </span>
            <button
              id="toggle-haptics"
              onClick={() => onUpdateSettings({ hapticsEnabled: !settings.hapticsEnabled })}
              className={`w-10 h-5 rounded-full transition-colors relative p-0.5 ${
                settings.hapticsEnabled ? 'bg-amber-500' : 'bg-zinc-700'
              }`}
            >
              <div
                className={`w-4 h-4 rounded-full bg-white transition-transform ${
                  settings.hapticsEnabled ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          {settings.hapticsEnabled && (
            <div className="pt-1">
              <div className="flex justify-between items-center text-xs font-mono mb-1.5">
                <span className="text-zinc-400">{t('haptic_intensity', lang)}</span>
                <div className="flex items-center gap-2">
                  <span className="text-amber-400 font-bold">{settings.hapticIntensity ?? 75}%</span>
                  <button
                    onClick={handleTestHaptic}
                    className="text-[10px] px-2 py-0.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 active:scale-95 transition"
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
                className="w-full accent-amber-400 h-1.5 rounded-lg bg-zinc-700 cursor-pointer"
              />
            </div>
          )}
        </div>

        {/* Unlockable Themes & Color Palettes Grid */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <label className="text-xs font-mono text-zinc-400 flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
              {t('court_theme', lang)}
            </label>
            <span className="text-[10px] font-mono text-zinc-400">
              {profile ? `Level ${profile.level}` : ''}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2">
            {(Object.keys(THEMES) as CourtTheme[]).map((themeKey) => {
              const th = THEMES[themeKey];
              const isSelected = settings.theme === themeKey;
              const unlocked = isThemeUnlocked(themeKey, profile);

              return (
                <button
                  key={themeKey}
                  id={`theme-btn-${themeKey}`}
                  disabled={!unlocked}
                  onClick={() => {
                    if (unlocked) {
                      onUpdateSettings({ theme: themeKey });
                      sound.playPaddleHit(1.0);
                    }
                  }}
                  className={`p-2.5 rounded-2xl border text-left flex flex-col gap-1.5 transition active:scale-95 relative overflow-hidden ${
                    isSelected
                      ? 'border-cyan-400 bg-cyan-950/40 text-white font-bold ring-1 ring-cyan-400/50 shadow-md'
                      : unlocked
                      ? 'border-zinc-800 bg-zinc-900/60 hover:bg-zinc-800/40 text-zinc-300'
                      : 'border-zinc-900 bg-zinc-950/80 opacity-60 text-zinc-500 cursor-not-allowed'
                  }`}
                >
                  <div className="flex items-center justify-between w-full">
                    <div className="flex items-center gap-2">
                      <span
                        className="w-3.5 h-3.5 rounded-full border border-white/20 shrink-0"
                        style={{ backgroundColor: th.accentColor }}
                      />
                      <span className="text-xs font-mono font-bold truncate">{th.name}</span>
                    </div>

                    {unlocked ? (
                      isSelected ? (
                        <CheckCircle className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                      ) : null
                    ) : (
                      <Lock className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                    )}
                  </div>

                  {/* Color preview chips */}
                  <div className="flex items-center gap-1">
                    <div className="h-1.5 flex-1 rounded-full" style={{ backgroundColor: th.courtColor }} />
                    <div className="h-1.5 flex-1 rounded-full" style={{ backgroundColor: th.playerPaddleColor }} />
                    <div className="h-1.5 flex-1 rounded-full" style={{ backgroundColor: th.ballColor }} />
                  </div>

                  {/* Unlock requirement description if locked */}
                  {!unlocked && th.unlockRequirement && (
                    <span className="text-[9px] font-mono text-amber-400/90 leading-tight">
                      🔒 {th.unlockRequirement.description}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Toggles: Ball Trails, Live Stats Overlay, Gyroscope Tilt, Sonar Radar */}
        <div className="flex flex-col gap-2">
          {/* Dynamic Ball Velocity Trails */}
          <div className="flex items-center justify-between p-2.5 rounded-2xl bg-zinc-900/40 border border-zinc-800">
            <div className="flex items-center gap-2">
              <Flame className="w-4 h-4 text-amber-400" />
              <div>
                <div className="text-xs font-mono font-medium">{t('ball_trails', lang)}</div>
                <div className="text-[10px] text-zinc-400">Decaying velocity comet trail for high-speed tracking</div>
              </div>
            </div>
            <button
              id="toggle-ball-trails"
              onClick={() => onUpdateSettings({ showTrails: !settings.showTrails })}
              className={`w-11 h-6 rounded-full transition-colors relative p-0.5 ${
                settings.showTrails ? 'bg-amber-500' : 'bg-zinc-700'
              }`}
            >
              <div
                className={`w-5 h-5 rounded-full bg-white transition-transform ${
                  settings.showTrails ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          {/* Tilt motion */}
          <div className="flex items-center justify-between p-2.5 rounded-2xl bg-zinc-900/40 border border-zinc-800">
            <div className="flex items-center gap-2">
              <Smartphone className="w-4 h-4 text-cyan-400" />
              <div>
                <div className="text-xs font-mono font-medium">{t('tilt_gyro', lang)}</div>
                <div className="text-[10px] text-zinc-400">Tilt phone left/right to move paddle</div>
              </div>
            </div>
            <button
              id="toggle-tilt-control"
              onClick={handleRequestTiltPermission}
              className={`w-11 h-6 rounded-full transition-colors relative p-0.5 ${
                settings.tiltEnabled ? 'bg-cyan-500' : 'bg-zinc-700'
              }`}
            >
              <div
                className={`w-5 h-5 rounded-full bg-white transition-transform ${
                  settings.tiltEnabled ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          {/* Sonar Radar Preview */}
          <div className="flex items-center justify-between p-2.5 rounded-2xl bg-zinc-900/40 border border-zinc-800">
            <div className="flex items-center gap-2">
              <Eye className="w-4 h-4 text-emerald-400" />
              <div>
                <div className="text-xs font-mono font-medium">{t('opponent_radar', lang)}</div>
                <div className="text-[10px] text-zinc-400">Mini overlay preview of hidden court</div>
              </div>
            </div>
            <button
              id="toggle-radar-preview"
              onClick={() => onUpdateSettings({ showRadar: !settings.showRadar })}
              className={`w-11 h-6 rounded-full transition-colors relative p-0.5 ${
                settings.showRadar ? 'bg-emerald-500' : 'bg-zinc-700'
              }`}
            >
              <div
                className={`w-5 h-5 rounded-full bg-white transition-transform ${
                  settings.showRadar ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
        </div>

        {/* Done Button */}
        <button
          id="btn-done-settings"
          onClick={onClose}
          className="w-full py-3.5 rounded-2xl font-mono text-sm font-bold bg-cyan-500 hover:bg-cyan-400 text-zinc-950 transition active:scale-95 shadow-lg"
        >
          {t('close', lang)}
        </button>
      </div>
    </div>
  );
};

