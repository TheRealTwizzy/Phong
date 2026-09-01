import React, { useState, useEffect, useRef } from 'react';
import { PlayerProfile, PlayerStatus, LanguageCode, CosmeticId } from '../types';
import { COSMETICS, COSMETIC_IDS, cosmeticVars, isCosmeticUnlocked } from '../game/cosmetics';
import { sound } from '../audio/soundEffects';
import { USERNAME_MAX } from '../profileRules';
import { PLACEMENT_GAMES, xpForLevel } from '../rating';
import { processAvatarFile, uploadAvatar, deleteAvatar } from '../media/avatar';
import { AvatarImage } from './AvatarImage';
import { MatchHistoryList } from './MatchHistoryList';
import { AccountDangerZone } from './AccountDangerZone';
import { TierBadge } from './TierBadge';
import { t } from '../i18n/translations';
import { Sheet, ProgressBar } from './ui';
import {
  X,
  Trophy,
  Flame,
  Zap,
  Award,
  Check,
  Edit2,
  KeyRound,
  Copy,
  ImagePlus,
  Trash2,
} from 'lucide-react';

interface Props {
  /** Position in App's open-sheet stack; forwarded to Sheet. See Sheet's `stack`. */
  stack?: { index: number; count: number };

  isOpen: boolean;
  onClose: () => void;
  profile: PlayerProfile | null;
  playerStatus?: PlayerStatus;
  onUpdateUsername: (
    newName: string
  ) => Promise<{ ok: boolean; error?: string; unlockAt?: string }>;
  onRefreshProfile: () => void;
  onViewProfile?: (id: string) => void;
  equippedCosmetic: CosmeticId;
  onEquipCosmetic: (id: CosmeticId) => void;
  language?: LanguageCode;
  /**
   * Deleting the account, offered only when it is safe to offer.
   *
   * Absent means not offered, and App passes it only while `screen === 'menu'`
   * — this modal opens from the in-match HUD too, and deleting mid-duel would
   * charge an abandon to an account that no longer exists.
   */
  onDeleteAccount?: (username: string) => Promise<{ ok: boolean; error?: string }>;
}

/**
 * The cosmetics this player owns, and nothing else.
 *
 * A locked cosmetic is not greyed out here, it is ABSENT — no tile, no name, no
 * swatch, not in the DOM at all. What this replaced listed all twenty with the
 * fifteen locked ones dimmed, captioned with what they cost, and previewing
 * their colours in three chips, which gave away the thing the reward is: the
 * look. A cosmetic you have seen is a cosmetic you have mostly had.
 *
 * The consequence is that the UNLOCK MOMENT is the only time a player meets one,
 * which is why App raises a toast for every route into this list rather than
 * only for the elite missions that used to have one.
 *
 * Each tile previews itself by applying its own `cosmeticVars` and then using
 * the ordinary token classes inside. The preview is the real thing rather than a
 * hand-picked trio of swatches, so it cannot drift from what equipping actually
 * does — and it exercises the same scoping the public-profile card relies on.
 */
const CosmeticPicker: React.FC<{
  profile: PlayerProfile;
  equipped: CosmeticId;
  onEquip: (id: CosmeticId) => void;
  language: LanguageCode;
}> = ({ profile, equipped, onEquip, language }) => {
  const owned = COSMETIC_IDS.filter((id) => isCosmeticUnlocked(id, profile));
  return (
    <div className="flex flex-col gap-3">
      <p id="cosmetic-owned-count" className="text-2xs text-ink-dim">
        {t('cosmetics_owned', language, { n: String(owned.length) })}
      </p>
      <div className="grid grid-cols-2 gap-2">
        {owned.map((id) => {
          const cosmetic = COSMETICS[id];
          const isEquipped = id === equipped;
          return (
            <button
              key={id}
              id={`cosmetic-btn-${id}`}
              data-equipped={isEquipped ? 'true' : 'false'}
              onClick={() => {
                onEquip(id);
                sound.playPaddleHit(1.0);
              }}
              style={cosmeticVars(cosmetic) as React.CSSProperties}
              className={`flex flex-col gap-2 rounded-card border p-2.5 text-left transition-colors active:scale-95 motion-reduce:active:scale-100 ${
                isEquipped ? 'border-accent ring-1 ring-accent/50' : 'border-line'
              } bg-surface-2`}
            >
              <span className="flex items-center gap-1.5">
                <span
                  className="h-3 w-3 shrink-0 rounded-full border border-line-strong bg-accent"
                  aria-hidden
                />
                <span className="truncate text-2xs text-ink">{t(cosmetic.nameKey, language)}</span>
                {isEquipped && <Check className="ml-auto h-3 w-3 shrink-0 text-accent" />}
              </span>
              {/* A slice of the actual court, in this cosmetic's own colours. */}
              <span
                className="flex h-6 items-end gap-1 rounded-chip px-1.5 pb-1"
                style={{ backgroundColor: cosmetic.courtColor }}
              >
                <span className="h-1 flex-1 rounded-full" style={{ backgroundColor: cosmetic.playerPaddleColor }} />
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: cosmetic.ballColor }} />
                <span className="h-1 flex-1 rounded-full" style={{ backgroundColor: cosmetic.opponentPaddleColor }} />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

// Solo before duel before practice: the order a player meets them in.
const MODE_ORDER = ['solo', 'multiplayer', 'practice'] as const;
// The mode names the rest of the app already uses, rather than a third
// spelling of them: `mode_solo`/`mode_multiplayer`/`mode_practice` have been in
// all seven locales since the modes shipped.
const MODE_LABEL_KEY: Record<string, string> = {
  solo: 'mode_solo',
  multiplayer: 'mode_multiplayer',
  practice: 'mode_practice',
};

export const ProfileModal: React.FC<Props> = ({
  isOpen,
  onClose,
  profile,
  playerStatus = 'online',
  onUpdateUsername,
  onRefreshProfile,
  onViewProfile,
  equippedCosmetic,
  onEquipCosmetic,
  language = 'en',
  onDeleteAccount,
  stack,
}) => {
  const [isEditingName, setIsEditingName] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);
  const [claimCode, setClaimCode] = useState('');
  const [claimBusy, setClaimBusy] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  // `uploadAvatar` returns a typed `{ ok, error }` and this screen threw it
  // away, so a rejected upload — a 413 from the route's 600kb limit, a file
  // the decoder could not read, a dropped connection — produced no visible
  // change whatsoever: the avatar stayed as it was and nothing said why.
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);

  const handlePickAvatar = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || avatarBusy) return;
    setAvatarBusy(true);
    setAvatarError(null);
    try {
      const blob = await processAvatarFile(file);
      const result = await uploadAvatar(blob);
      if (result.ok) onRefreshProfile();
      else setAvatarError(t('avatar_failed', language));
    } catch {
      // Undecodable file — leave the current avatar untouched, and say so.
      setAvatarError(t('avatar_failed', language));
    } finally {
      setAvatarBusy(false);
    }
  };

  const handleRemoveAvatar = async () => {
    if (avatarBusy) return;
    setAvatarBusy(true);
    setAvatarError(null);
    try {
      if (await deleteAvatar()) onRefreshProfile();
      else setAvatarError(t('avatar_failed', language));
    } finally {
      setAvatarBusy(false);
    }
  };

  const copyRecoveryCode = () => {
    if (!profile?.recoveryCode) return;
    navigator.clipboard
      ?.writeText(profile.recoveryCode)
      .then(() => {
        setCodeCopied(true);
        setTimeout(() => setCodeCopied(false), 2000);
      })
      .catch(() => {});
  };

  const handleClaim = async () => {
    if (!claimCode.trim() || claimBusy) return;
    if (
      profile &&
      profile.matchesPlayed > 0 &&
      !window.confirm(t('restore_replaces_confirm', language))
    ) {
      return;
    }
    setClaimBusy(true);
    setClaimError(null);
    try {
      const res = await fetch('/api/profile/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: claimCode }),
      });
      const data = await res.json();
      if (!res.ok) {
        // The server's `error` is a CODE, not prose — showing it raw put
        // things like `BROWSER_HAS_ACCOUNT` in front of the player.
        setClaimError(t('restore_failed', language));
        return;
      }
      // Identity swapped server-side; reload so every view reflects it
      window.location.reload();
    } catch {
      setClaimError(t('network_error_retry', language));
    } finally {
      setClaimBusy(false);
    }
  };
  const [tempName, setTempName] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<'stats' | 'cosmetics' | 'history'>('stats');

  useEffect(() => {
    if (profile) {
      setTempName(profile.username);
    }
  }, [profile]);

  if (!profile) return null;

  const handleSaveName = async () => {
    if (!tempName.trim()) return;
    setIsSaving(true);
    setNameError(null);
    try {
      const result = await onUpdateUsername(tempName.trim());
      if (result.ok) {
        setIsEditingName(false);
      } else if (result.error === 'USERNAME_LOCKED' && result.unlockAt) {
        setNameError(
          t('username_locked_until', language, {
            date: new Date(result.unlockAt).toLocaleDateString(language, {
              year: 'numeric',
              month: 'short',
              day: 'numeric',
            }),
          })
        );
      } else if (result.error === 'USERNAME_TAKEN') {
        setNameError(t('username_taken', language));
      } else {
        setNameError(t('username_invalid', language));
      }
    } finally {
      setIsSaving(false);
    }
  };

  const winRate =
    profile.matchesPlayed > 0
      ? Math.round((profile.matchesWon / profile.matchesPlayed) * 100)
      : 0;

  // XP calculation for current level slice
  const xpCurrentLevelBase = xpForLevel(profile.level);
  const xpCurrentLevelProgress = Math.max(0, profile.xp - xpCurrentLevelBase);
  const xpNeededForLevel = Math.max(1, profile.xpNext - xpCurrentLevelBase);
  const xpPercent = Math.min(100, Math.round((xpCurrentLevelProgress / xpNeededForLevel) * 100));

  // A stable order, so the table does not reshuffle as rows appear. Modes with
  // no row yet are simply absent — a player who has never opened Practice has
  // nothing to say about it.
  const modeRows = MODE_ORDER.flatMap((mode) => {
    const st = profile.modeStats?.[mode];
    return st && st.matchesPlayed > 0 ? [[mode, st] as const] : [];
  });

  const header = (
    <div className="shrink-0">
          {/* Header Banner */}
          <div className="relative bg-gradient-to-r from-accent/12 via-surface-2 to-surface-2 p-4 border-b border-line">
            <button
              id="close-profile-btn"
              onClick={onClose}
              className="absolute top-4 right-4 p-2 text-ink-muted hover:text-ink rounded-full hover:bg-white/10 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-4">
              <div className="relative">
                <AvatarImage
                  playerId={profile.id}
                  hasAvatar={profile.hasAvatar}
                  avatarVersion={profile.avatarVersion}
                  size={72}
                  className="rounded-2xl border-2 border-accent/40 shadow-lg shadow-accent/20"
                />
                <div className="absolute -bottom-2 -right-2 bg-gradient-to-r from-warn to-xp text-ink-on-accent font-black text-xs px-2 py-0.5 rounded-full shadow border border-line">
                  LV {profile.level}
                </div>
                {/* Avatar change / remove controls */}
                <div className="absolute -top-2 -right-2 flex gap-1">
                  <button
                    id="btn-change-avatar"
                    onClick={() => avatarInputRef.current?.click()}
                    disabled={avatarBusy}
                    title={profile.hasAvatar ? t('change_avatar', language) : t('upload_avatar', language)}
                    className="p-1 rounded-lg bg-surface-3/95 hover:bg-surface-4 text-accent border border-line-strong shadow transition active:scale-95 disabled:opacity-50"
                  >
                    <ImagePlus className="w-3 h-3" />
                  </button>
                  {profile.hasAvatar && (
                    <button
                      id="btn-remove-avatar"
                      onClick={handleRemoveAvatar}
                      disabled={avatarBusy}
                      title={t('remove_avatar', language)}
                      className="p-1 rounded-lg bg-surface-3/95 hover:bg-surface-4 text-loss border border-line-strong shadow transition active:scale-95 disabled:opacity-50"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </div>
                <input
                  ref={avatarInputRef}
                  id="input-avatar-file"
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handlePickAvatar}
                />
                {avatarError && (
                  <p
                    id="avatar-error"
                    role="alert"
                    className="mt-1 max-w-[9rem] text-2xs font-normal leading-snug tracking-normal text-loss"
                  >
                    {avatarError}
                  </p>
                )}
              </div>

              <div className="flex-1 min-w-0">
                {isEditingName ? (
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        maxLength={USERNAME_MAX}
                        value={tempName}
                        onChange={(e) => {
                          setTempName(e.target.value);
                          setNameError(null);
                        }}
                        className="bg-surface-3 border border-accent/60 rounded-lg px-3 py-1 text-base text-ink font-bold focus:outline-none focus:ring-2 focus:ring-accent min-w-0"
                        autoFocus
                      />
                      <button
                        id="btn-save-username"
                        onClick={handleSaveName}
                        disabled={isSaving}
                        className="p-1.5 bg-accent hover:bg-accent-press text-ink-on-accent rounded-lg"
                      >
                        <Check className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => {
                          setTempName(profile.username);
                          setIsEditingName(false);
                          setNameError(null);
                        }}
                        className="p-1.5 bg-surface-3 hover:bg-surface-4 text-ink-muted rounded-lg"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                    {nameError && (
                      <p id="username-edit-error" className="text-[10px] font-mono text-loss">
                        {nameError}
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <h2 className="text-xl font-black text-ink truncate">{profile.username}</h2>
                    <span
                      className={`inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded-full border ${
                        playerStatus === 'online'
                          ? 'bg-win/10 text-win border-win/30'
                          : playerStatus === 'idle'
                          ? 'bg-warn/10 text-warn border-warn/30'
                          : 'bg-surface-3 text-ink-muted border-line-strong'
                      }`}
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${
                          playerStatus === 'online'
                            ? 'bg-win animate-pulse'
                            : playerStatus === 'idle'
                            ? 'bg-warn'
                            : 'bg-ink-dim'
                        }`}
                      />
                      {t(
                      playerStatus === 'online'
                        ? 'status_active'
                        : playerStatus === 'idle'
                          ? 'status_idle'
                          : 'status_offline',
                      language
                    )}
                    </span>
                    <button
                      id="edit-username-btn"
                      onClick={() => setIsEditingName(true)}
                      className="text-ink-muted hover:text-accent transition-colors p-1"
                      title={t('edit_callsign', language)}
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}

                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <TierBadge
                    tier={profile.tier}
                    language={language}
                    size="md"
                    ladderPosition={profile.ladderPosition}
                  />
                  {profile.tier === 'unranked' && (
                    <span className="text-[10px] text-ink-muted font-mono">
                      {t('placement_progress', language, {
                        // Clamped like RankBadge's meter: placement counts
                        // games AND needs sigma to settle, so an unplaced
                        // player can legitimately hold more ranked games than
                        // the placement number — "12/5" reads as a bug.
                        played: String(Math.min(profile.rankedGames, PLACEMENT_GAMES)),
                        total: String(PLACEMENT_GAMES),
                      })}
                    </span>
                  )}
                  {/* Daily Streak Header Badge */}
                  <span
                    id="profile-streak-badge"
                    className="inline-flex items-center gap-1 text-xs font-mono font-bold px-2 py-0.5 rounded-md bg-gradient-to-r from-warn/20 to-warn/20 text-warn border border-warn/40 shadow-sm"
                  >
                    <Flame className="w-3.5 h-3.5 text-warn fill-warn animate-pulse" />
                    <span>{profile.dailyStreak || 1} Day Streak</span>
                  </span>
                </div>
              </div>
            </div>

            {/* Level XP Bar */}
            <div className="mt-5">
              <div className="flex justify-between text-xs text-ink-muted font-semibold mb-1">
                <span>Progress to Level {profile.level + 1}</span>
                {/* Progress WITHIN this level, matching the bar beside it.
                    These used to be the cumulative totals while the bar showed
                    the level slice, so the number and the fill disagreed:
                    at level 3 the bar read 38% next to the text "700 / 930". */}
                <span className="text-accent">
                  {xpCurrentLevelProgress.toLocaleString()} / {xpNeededForLevel.toLocaleString()} XP
                </span>
              </div>
              <ProgressBar value={xpPercent / 100} tone="xp" ariaLabel={t('xp', language)} />
            </div>
          </div>

          {/* Navigation Tabs */}
          <div className="flex border-b border-line bg-surface-0/50">
            <button
              id="profile-tab-stats"
              onClick={() => setActiveTab('stats')}
              className={`flex-1 py-3 text-xs font-bold uppercase tracking-wider transition-colors border-b-2 ${
                activeTab === 'stats'
                  ? 'border-accent text-accent bg-accent/5'
                  : 'border-transparent text-ink-muted hover:text-ink'
              }`}
            >
              {t('profile_tab_stats', language)}
            </button>
            <button
              id="profile-tab-cosmetics"
              onClick={() => setActiveTab('cosmetics')}
              className={`flex-1 py-3 text-xs font-bold uppercase tracking-wider transition-colors border-b-2 ${
                activeTab === 'cosmetics'
                  ? 'border-accent text-accent bg-accent/5'
                  : 'border-transparent text-ink-muted hover:text-ink'
              }`}
            >
              {t('cosmetics', language)}
            </button>
            <button
              id="profile-tab-history"
              onClick={() => setActiveTab('history')}
              className={`flex-1 py-3 text-xs font-bold uppercase tracking-wider transition-colors border-b-2 ${
                activeTab === 'history'
                  ? 'border-accent text-accent bg-accent/5'
                  : 'border-transparent text-ink-muted hover:text-ink'
              }`}
            >
              {t('public_history_section', language)}
            </button>
          </div>

    </div>
  );

  return (
    <Sheet
      stack={stack}
      cardId="profile-modal-container"
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      accent="accent"
      header={header}
      footer={
        <>
          <span className="flex-1 text-2xs font-normal tracking-normal text-ink-muted">
            Player ID: <code className="text-ink-muted">{profile.id.slice(0, 10)}...</code>
          </span>
          <button onClick={onRefreshProfile} className="text-2xs text-accent hover:text-ink">
            Sync Data
          </button>
        </>
      }
      bodyClassName="p-4 space-y-4"
    >
            {activeTab === 'cosmetics' ? (
              <CosmeticPicker
                profile={profile}
                equipped={equippedCosmetic}
                onEquip={onEquipCosmetic}
                language={language}
              />
            ) : activeTab === 'stats' ? (
              <div className="space-y-4">
                {/* Daily Streak Highlight Banner */}
                <div className="bg-gradient-to-r from-warn/12 via-warn/8 to-surface-2/60 border border-warn/40 rounded-2xl p-4 flex items-center justify-between shadow-lg shadow-warn/10">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-xl bg-warn/20 border border-warn/50 flex items-center justify-center text-warn shadow-inner">
                      <Flame className="w-7 h-7 fill-warn animate-bounce" />
                    </div>
                    <div>
                      <div className="text-xs font-mono font-bold text-warn uppercase tracking-wide">
                        {t('profile_streak_title', language)}
                      </div>
                      <div className="text-2xl font-black text-ink flex items-baseline gap-1.5">
                        <span>{profile.dailyStreak || 1}</span>
                        <span className="text-xs font-sans text-ink-muted font-normal">
                          {(profile.dailyStreak || 1) === 1
                            ? t('profile_streak_day', language)
                            : t('profile_streak_days', language)}
                        </span>
                      </div>
                      <div className="text-[11px] text-warn/70 mt-0.5">
                        {t('profile_streak_hint', language)}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Device Identity & Recovery */}
                <div
                  id="recovery-card"
                  className="bg-surface-2/70 border border-accent/25 rounded-2xl p-4 space-y-3"
                >
                  <div className="flex items-center gap-2 text-accent">
                    <KeyRound className="w-4 h-4" />
                    <span className="text-xs font-mono font-bold uppercase tracking-wider">
                      {t('recovery_code_title', language)}
                    </span>
                  </div>
                  <p className="text-[11px] text-ink-muted leading-relaxed">
                    {t('recovery_code_body', language)}
                  </p>
                  <div className="flex items-center gap-2">
                    <code
                      id="recovery-code"
                      className="flex-1 text-center text-lg font-black font-mono tracking-[0.2em] text-accent bg-surface-0 border border-line rounded-xl py-2 select-all"
                    >
                      {profile.recoveryCode || '····-····'}
                    </code>
                    <button
                      id="btn-copy-recovery"
                      onClick={copyRecoveryCode}
                      title={t('copy_code', language)}
                      className="p-2.5 rounded-xl bg-surface-3 hover:bg-surface-4 text-ink border border-line-strong transition active:scale-95"
                    >
                      {codeCopied ? <Check className="w-4 h-4 text-win" /> : <Copy className="w-4 h-4" />}
                    </button>
                  </div>
                  <div className="pt-1 border-t border-line/80 space-y-2">
                    <p className="text-[11px] text-ink-muted">
                      {t('have_recovery_code', language)}
                    </p>
                    <div className="flex items-center gap-2">
                      <input
                        id="input-claim-code"
                        value={claimCode}
                        onChange={(e) => setClaimCode(e.target.value.toUpperCase())}
                        placeholder="XXXX-XXXX"
                        maxLength={9}
                        className="flex-1 bg-surface-0 border border-line-strong rounded-xl px-3 py-2 text-base font-mono tracking-widest text-ink placeholder:text-ink-dim focus:outline-none focus:border-accent/60"
                      />
                      <button
                        id="btn-claim-profile"
                        onClick={handleClaim}
                        disabled={claimBusy || !claimCode.trim()}
                        className="px-4 py-2 rounded-xl font-mono text-xs font-bold bg-accent hover:bg-accent disabled:bg-surface-3 disabled:text-ink-muted text-ink transition active:scale-95"
                      >
                        {claimBusy ? '…' : t('restore_profile', language)}
                      </button>
                    </div>
                    {claimError && <p className="text-[11px] text-loss">{claimError}</p>}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-surface-3/60 border border-line-strong/60 rounded-2xl p-3.5 flex flex-col">
                    <div className="flex items-center gap-2 text-ink-muted text-xs font-medium mb-1">
                      <Trophy className="w-4 h-4 text-xp" />
                      <span>{t('win_rate', language)}</span>
                    </div>
                    <div className="text-2xl font-black text-ink">{winRate}%</div>
                    <div className="text-[11px] text-ink-muted mt-1">
                      {profile.matchesWon} Won / {profile.matchesPlayed} Matches
                    </div>
                  </div>

                  <div className="bg-surface-3/60 border border-line-strong/60 rounded-2xl p-3.5 flex flex-col">
                    <div className="flex items-center gap-2 text-ink-muted text-xs font-medium mb-1">
                      <Flame className="w-4 h-4 text-warn" />
                      <span>{t('longest_rally', language)}</span>
                    </div>
                    <div className="text-2xl font-black text-ink">{profile.highestRally}</div>
                    <div className="text-[11px] text-ink-muted mt-1">{t('best_return_streak', language)}</div>
                  </div>

                  <div className="bg-surface-3/60 border border-line-strong/60 rounded-2xl p-3.5 flex flex-col">
                    <div className="flex items-center gap-2 text-ink-muted text-xs font-medium mb-1">
                      <Zap className="w-4 h-4 text-accent" />
                      <span>{t('total_points', language)}</span>
                    </div>
                    <div className="text-2xl font-black text-ink">{profile.totalPointsScored}</div>
                    <div className="text-[11px] text-ink-muted mt-1">{t('volleys_past_opponent', language)}</div>
                  </div>

                  <div className="bg-surface-3/60 border border-line-strong/60 rounded-2xl p-3.5 flex flex-col">
                    <div className="flex items-center gap-2 text-ink-muted text-xs font-medium mb-1">
                      <Award className="w-4 h-4 text-rank-steady" />
                      <span>{t('achievements', language)}</span>
                    </div>
                    <div className="text-2xl font-black text-ink">{profile.achievements.length}</div>
                    <div className="text-[11px] text-ink-muted mt-1">{t('badges_unlocked', language)}</div>
                  </div>
                </div>

                {/* Per mode. The grid above pools solo and duel into single
                    numbers, which say how much you have played and nothing
                    about how you play each mode. Split Screen is absent
                    because only one of the two people at that phone has an
                    account to write to. */}
                {modeRows.length > 0 && (
                  <div id="profile-mode-stats" className="space-y-2">
                    <div className="text-xs font-mono font-bold uppercase tracking-wider text-ink-muted">
                      By Mode
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-[11px] text-ink">
                        <thead>
                          <tr className="text-ink-muted text-left whitespace-nowrap">
                            <th className="py-1 pr-2 font-medium">{t('stats_mode', language)}</th>
                            <th className="py-1 px-1.5 font-medium text-right">{t('stats_played', language)}</th>
                            <th className="py-1 px-1.5 font-medium text-right">{t('stats_wl', language)}</th>
                            <th className="py-1 px-1.5 font-medium text-right">{t('stats_pts', language)}</th>
                            <th className="py-1 px-1.5 font-medium text-right">{t('stats_streak', language)}</th>
                            <th className="py-1 pl-1.5 font-medium text-right">{t('stats_win_run', language)}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {modeRows.map(([mode, st]) => (
                            <tr
                              key={mode}
                              id={`profile-mode-${mode}`}
                              className="border-t border-line/80 whitespace-nowrap"
                            >
                              <td className="py-1.5 pr-2 text-ink">
                                {MODE_LABEL_KEY[mode] ? t(MODE_LABEL_KEY[mode], language) : mode}
                              </td>
                              <td className="py-1.5 px-1.5 text-right tabular-nums">{st.matchesPlayed}</td>
                              <td className="py-1.5 px-1.5 text-right tabular-nums">
                                {mode === 'practice' ? '—' : `${st.matchesWon}–${st.matchesLost}`}
                              </td>
                              <td className="py-1.5 px-1.5 text-right tabular-nums">
                                {mode === 'practice' ? '—' : st.pointsScored}
                              </td>
                              <td className="py-1.5 px-1.5 text-right tabular-nums text-warn">
                                {st.bestStreak}
                              </td>
                              <td className="py-1.5 pl-1.5 text-right tabular-nums">
                                {mode === 'practice' ? '—' : st.bestWinStreak}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Last in the tab, deliberately: everything above it is
                    reversible and this is the only thing here that is not.
                    Absent entirely mid-match — see the onDeleteAccount prop. */}
                <AccountDangerZone
                  isOpen={isOpen}
                  profile={profile}
                  language={language}
                  onDeleteAccount={onDeleteAccount}
                />
              </div>
            ) : (
              // The shared list — the same tabs, filters, pagination and row
              // renderer as the history modal and the public profile view.
              // The ad-hoc renderer this replaces printed the raw stored
              // scoreP1-scoreP2, which read reversed on any row the opponent
              // had authored, and shipped its strings in English only.
              <MatchHistoryList
                language={language}
                perspectiveId={profile.id}
                source={{ kind: 'me' }}
                onViewProfile={onViewProfile}
                idPrefix="profile-history"
              />
            )}
    </Sheet>
  );
};
