import React, { useEffect, useState } from 'react';
import { GameSettings, LanguageCode, PlayerProfile, SoundscapeType } from '../types';
import { LANGUAGES, t } from '../i18n/translations';
import { USERNAME_MAX } from '../profileRules';
import { sound } from '../audio/soundEffects';
import { Sheet, Button } from './ui';
import {
  X,
  Smartphone,
  Sliders,
  Volume2,
  VolumeX,
  Music,
  Vibrate,
  Eye,
  Activity,
  Globe,
  Flame,
  Crosshair,
  Radio,
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
  onTriggerShake,
  indicatorsLockedBySonar = false,
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
                title="Mute SFX"
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
                title="Mute Music"
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
                <div className="text-[10px] text-ink-muted">Decaying velocity comet trail for high-speed tracking</div>
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
                <div className="text-[10px] text-ink-muted">Tilt phone left/right to move paddle</div>
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
                <div className="text-[10px] text-ink-muted">Mini overlay preview of hidden court</div>
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

        {/* Danger zone — last in the sheet, deliberately. Everything above is a
            preference that can be flipped back; this is the only thing here
            that cannot be, so it sits past all of it rather than beside it.
            Absent entirely mid-match and for a profile with no account yet:
            see the onDeleteAccount prop. */}
        {onDeleteAccount && profile?.initialized && (
          <div
            id="danger-zone"
            className="mt-2 flex flex-col gap-2.5 rounded-2xl border border-loss/30 bg-loss/20 p-3.5"
          >
            <div className="flex items-center gap-1.5 text-loss">
              <Trash2 className="h-4 w-4" />
              <span className="text-xs font-mono font-bold uppercase tracking-wider">
                {t('delete_account_title', lang)}
              </span>
            </div>

            {deleteStep === 'idle' && (
              <>
                <p className="text-[10px] leading-relaxed text-ink-muted">
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
                  className="border-loss/40 text-loss hover:bg-loss/10 hover:text-loss"
                >
                  {t('delete_account_start', lang)}
                </Button>
              </>
            )}

            {/* Step 1 — the username, typed exactly. */}
            {deleteStep === 'name' && (
              <>
                <p className="text-[11px] font-medium leading-relaxed text-ink">
                  {t('delete_account_name_prompt', lang)}
                </p>
                <p className="text-[10px] leading-relaxed text-ink-muted">
                  {t('delete_account_name_hint', lang)}
                </p>
                <div
                  id="delete-account-name-echo"
                  className="select-all rounded-xl border border-line bg-surface-0 py-1.5 text-center font-mono text-sm font-bold tracking-wider text-ink"
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
                  className="w-full rounded-xl border border-line-strong bg-surface-0 px-3 py-2.5 font-mono text-base text-ink transition placeholder:text-ink-dim focus:border-loss focus:outline-none"
                />
                {typedName.length > 0 && !nameMatches && (
                  <p id="delete-account-name-mismatch" className="text-[10px] font-mono text-loss">
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
                <div className="flex items-center gap-1.5 text-loss">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  <span className="text-xs font-bold uppercase tracking-wider">
                    {t('delete_account_permanent_title', lang)}
                  </span>
                </div>
                <p
                  id="delete-account-permanent-warning"
                  className="text-[11px] leading-relaxed text-warn/90"
                >
                  {t('delete_account_permanent_body', lang, { name: accountName })}
                </p>
                {deleteError && (
                  <p id="delete-account-error" className="text-[10px] font-mono text-loss">
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

