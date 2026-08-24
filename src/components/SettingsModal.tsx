import React, { useEffect, useState } from 'react';
import { CourtTheme, GameSettings, LanguageCode, PlayerProfile, SoundscapeType } from '../types';
import { THEMES, isThemeUnlocked } from '../game/themes';
import { LANGUAGES, t } from '../i18n/translations';
import { USERNAME_MAX } from '../profileRules';
import { sound } from '../audio/soundEffects';
import { Sheet, Button } from './ui';
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
  Trash2,
  AlertTriangle,
  Loader2,
} from 'lucide-react';

// Device & presentation preferences only. Match settings (mode, difficulty,
// winning score) are chosen on the main menu BEFORE a match starts, and
// paddle width / ball speed are fixed constants — never editable here.
interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: GameSettings;
  onUpdateSettings: (newSettings: Partial<GameSettings>) => void;
  profile?: PlayerProfile | null;
  onStartTour?: () => void;
  onTriggerShake?: () => void;
  /**
   * Delete this account for good. Absent means the section is not offered —
   * from a live match, where deleting would strand an opponent in a room
   * nobody told, and for a profile with no account to delete yet.
   *
   * Resolves to the outcome rather than throwing: the flow has to be able to
   * say WHY it failed without unwinding the two steps the player just took.
   */
  onDeleteAccount?: (username: string) => Promise<{ ok: boolean; error?: string }>;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  onUpdateSettings,
  profile = null,
  onStartTour,
  onTriggerShake,
  onDeleteAccount,
}) => {
  const lang = settings.language || 'en';

  // Deleting the account: idle → name → confirm. Two steps, because the one
  // action in the app with no undo should not be one tap away from a slider.
  //  - `name`    the username, typed exactly. The gate, not a formality.
  //  - `confirm` the reminder that this is permanent, and the last word on it:
  //              DELETE does it, BACK returns to the open Settings panel.
  const [deleteStep, setDeleteStep] = useState<'idle' | 'name' | 'confirm'>('idle');
  const [typedName, setTypedName] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Closing the sheet abandons the flow. Without this, a player who backed out
  // by shutting Settings would find the confirmation still armed and waiting
  // the next time they opened it, with no memory of having asked for it.
  useEffect(() => {
    if (isOpen) return;
    setDeleteStep('idle');
    setTypedName('');
    setDeleteError(null);
  }, [isOpen]);

  const accountName = profile?.username || '';
  // Compared exactly — case included, and untrimmed. The server does the same
  // (DELETE /api/profile/me), and the two have to agree or Continue would
  // enable on something the server then refuses. Phone keyboards capitalize
  // the first letter by themselves, which is why the input turns that off.
  const nameMatches = accountName.length > 0 && typedName === accountName;

  const closeDeleteFlow = () => {
    setDeleteStep('idle');
    setTypedName('');
    setDeleteError(null);
  };

  const handleConfirmDelete = async () => {
    if (!onDeleteAccount || deleteBusy || !nameMatches) return;
    setDeleteBusy(true);
    setDeleteError(null);
    const result = await onDeleteAccount(typedName);
    // On success the page is on its way to reloading as a brand-new player, so
    // there is deliberately nothing to put back: leaving the button spinning
    // is truer than flashing the panel back to idle over a dead account.
    if (!result.ok) {
      setDeleteBusy(false);
      setDeleteError(result.error || 'DELETE_FAILED');
    }
  };

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

  const header = (
    <div className="shrink-0 flex items-center justify-between gap-2 border-b border-line bg-surface-1 p-4">
      <div className="flex min-w-0 items-center gap-2.5">
        <Sliders className="h-5 w-5 text-accent" />
        <h2 className="text-title truncate">{t('settings_title', lang)}</h2>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {onStartTour && (
          <Button
            id="btn-settings-start-tour"
            size="sm"
            variant="secondary"
            icon={<BookOpen className="h-3.5 w-3.5" />}
            onClick={() => {
              onClose();
              onStartTour();
            }}
          >
            {t('tour_start', lang)}
          </Button>
        )}
        <button
          id="btn-close-settings"
          onClick={onClose}
          aria-label={t('close', lang)}
          className="rounded-ctl p-2 text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink"
        >
          <X className="h-5 w-5" />
        </button>
      </div>
    </div>
  );

  return (
    <Sheet
      id="settings-modal-overlay"
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      accent="accent"
      header={header}
      bodyClassName="p-4 flex flex-col gap-4"
      footer={
        <Button id="btn-done-settings" variant="primary" size="lg" block onClick={onClose}>
          {t('close', lang)}
        </Button>
      }
    >

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

        {/* Danger zone — last in the sheet, deliberately. Everything above is a
            preference that can be flipped back; this is the only thing here
            that cannot be, so it sits past all of it rather than beside it.
            Absent entirely mid-match and for a profile with no account yet:
            see the onDeleteAccount prop. */}
        {onDeleteAccount && profile?.initialized && (
          <div
            id="danger-zone"
            className="mt-2 flex flex-col gap-2.5 rounded-2xl border border-rose-500/30 bg-rose-950/20 p-3.5"
          >
            <div className="flex items-center gap-1.5 text-rose-300">
              <Trash2 className="h-4 w-4" />
              <span className="text-xs font-mono font-bold uppercase tracking-wider">
                {t('delete_account_title', lang)}
              </span>
            </div>

            {deleteStep === 'idle' && (
              <>
                <p className="text-[10px] leading-relaxed text-zinc-400">
                  {t('delete_account_desc', lang)}
                </p>
                <Button
                  id="btn-delete-account"
                  variant="ghost"
                  size="md"
                  block
                  icon={<Trash2 className="h-3.5 w-3.5" />}
                  onClick={() => {
                    setTypedName('');
                    setDeleteError(null);
                    setDeleteStep('name');
                  }}
                  className="border-rose-500/40 text-rose-300 hover:bg-rose-500/10 hover:text-rose-200"
                >
                  {t('delete_account_start', lang)}
                </Button>
              </>
            )}

            {/* Step 1 — the username, typed exactly. */}
            {deleteStep === 'name' && (
              <>
                <p className="text-[11px] font-medium leading-relaxed text-zinc-200">
                  {t('delete_account_name_prompt', lang)}
                </p>
                <p className="text-[10px] leading-relaxed text-zinc-400">
                  {t('delete_account_name_hint', lang)}
                </p>
                <div
                  id="delete-account-name-echo"
                  className="select-all rounded-xl border border-zinc-800 bg-slate-950 py-1.5 text-center font-mono text-sm font-bold tracking-wider text-zinc-300"
                >
                  {accountName}
                </div>
                <input
                  id="input-delete-confirm-name"
                  type="text"
                  value={typedName}
                  onChange={(e) => setTypedName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && nameMatches) setDeleteStep('confirm');
                  }}
                  // A phone keyboard capitalizes the first letter and offers
                  // corrections by default, both of which would fight a
                  // case-sensitive compare the player cannot see losing.
                  autoCapitalize="none"
                  autoCorrect="off"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={USERNAME_MAX}
                  placeholder={t('delete_account_name_prompt', lang)}
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 font-mono text-base text-slate-100 transition placeholder:text-slate-600 focus:border-rose-400 focus:outline-none"
                />
                {typedName.length > 0 && !nameMatches && (
                  <p id="delete-account-name-mismatch" className="text-[10px] font-mono text-rose-400">
                    {t('delete_account_name_mismatch', lang)}
                  </p>
                )}
                <div className="flex items-center gap-2">
                  <Button
                    id="btn-delete-account-cancel"
                    variant="secondary"
                    size="md"
                    block
                    onClick={closeDeleteFlow}
                  >
                    {t('cancel', lang)}
                  </Button>
                  <Button
                    id="btn-delete-account-continue"
                    variant="danger"
                    size="md"
                    block
                    disabled={!nameMatches}
                    onClick={() => setDeleteStep('confirm')}
                  >
                    {t('delete_account_continue', lang)}
                  </Button>
                </div>
              </>
            )}

            {/* Step 2 — the reminder IS the last word. Two buttons and no
                third: DELETE goes through with it, BACK returns to the open
                Settings panel with nothing spent. */}
            {deleteStep === 'confirm' && (
              <>
                <div className="flex items-center gap-1.5 text-rose-300">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  <span className="text-xs font-bold uppercase tracking-wider">
                    {t('delete_account_permanent_title', lang)}
                  </span>
                </div>
                <p
                  id="delete-account-permanent-warning"
                  className="text-[11px] leading-relaxed text-amber-200/90"
                >
                  {t('delete_account_permanent_body', lang, { name: accountName })}
                </p>
                {deleteError && (
                  <p id="delete-account-error" className="text-[10px] font-mono text-rose-400">
                    {t('delete_account_failed', lang)}
                  </p>
                )}
                <div className="flex items-center gap-2">
                  <Button
                    id="btn-delete-account-back"
                    variant="secondary"
                    size="lg"
                    block
                    disabled={deleteBusy}
                    onClick={closeDeleteFlow}
                  >
                    {t('delete_account_back', lang)}
                  </Button>
                  <Button
                    id="btn-delete-account-final"
                    variant="danger"
                    size="lg"
                    block
                    disabled={deleteBusy}
                    onClick={() => void handleConfirmDelete()}
                    icon={
                      deleteBusy ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )
                    }
                  >
                    {t('delete_account_final', lang)}
                  </Button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Done Button */}
    </Sheet>
  );
};

