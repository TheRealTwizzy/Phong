import React, { useEffect, useRef, useState } from 'react';
import { LanguageCode, PlayerProfile, UsernameCheckResponse } from '../types';
import { ThemeConfig } from '../game/themes';
import { t } from '../i18n/translations';
import { validateUsername, USERNAME_MAX } from '../profileRules';
import { processAvatarFile, uploadAvatar } from '../media/avatar';
import { AvatarImage } from './AvatarImage';
import { Check, ImagePlus, KeyRound, Loader2, Play, ShieldCheck, X } from 'lucide-react';

// Mandatory first-arrival onboarding: every new player MUST lock in a unique
// username before touching the game (365-day rename lock starts here).
// Avatar is optional. Deliberately unclosable — the only ways out are
// initializing or restoring an existing profile with a recovery code.
interface OnboardingModalProps {
  isOpen: boolean;
  theme: ThemeConfig;
  language: LanguageCode;
  onInitialized: (profile: PlayerProfile) => void;
}

type NameStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'invalid'; reasonKey: string }
  | { kind: 'taken' }
  | { kind: 'available' };

export const OnboardingModal: React.FC<OnboardingModalProps> = ({
  isOpen,
  theme,
  language,
  onInitialized,
}) => {
  const [name, setName] = useState('');
  const [nameStatus, setNameStatus] = useState<NameStatus>({ kind: 'idle' });
  const [avatarBlob, setAvatarBlob] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showRestore, setShowRestore] = useState(false);
  const [claimCode, setClaimCode] = useState('');
  const [claimBusy, setClaimBusy] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const checkSeqRef = useRef(0);

  const reasonToKey = (reason?: string): string =>
    reason === 'reserved' ? 'username_reserved' : 'username_invalid';

  // Live validation: shared rules locally, then a debounced availability
  // probe against the server for names that pass.
  useEffect(() => {
    const trimmed = name.trim();
    const seq = ++checkSeqRef.current;
    if (!trimmed) {
      setNameStatus({ kind: 'idle' });
      return;
    }
    const local = validateUsername(trimmed);
    if (!local.ok) {
      setNameStatus({ kind: 'invalid', reasonKey: reasonToKey(local.reason) });
      return;
    }
    setNameStatus({ kind: 'checking' });
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/username-check?u=${encodeURIComponent(trimmed)}`);
        const data: UsernameCheckResponse = await res.json();
        if (checkSeqRef.current !== seq) return; // stale response
        if (!data.valid) {
          setNameStatus({ kind: 'invalid', reasonKey: reasonToKey(data.reason) });
        } else if (!data.available) {
          setNameStatus({ kind: 'taken' });
        } else {
          setNameStatus({ kind: 'available' });
        }
      } catch {
        if (checkSeqRef.current === seq) setNameStatus({ kind: 'idle' });
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [name]);

  // Object URL lifecycle for the local avatar preview
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  if (!isOpen) return null;

  const handlePickAvatar = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const blob = await processAvatarFile(file);
      setAvatarBlob(blob);
      setPreviewUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return URL.createObjectURL(blob);
      });
      setSubmitError(null);
    } catch {
      setSubmitError('avatar_failed');
    }
  };

  const handleSubmit = async () => {
    const trimmed = name.trim();
    if (submitting || nameStatus.kind !== 'available') return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch('/api/profile/initialize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data?.error === 'USERNAME_TAKEN') setNameStatus({ kind: 'taken' });
        setSubmitError(data?.error === 'USERNAME_TAKEN' ? 'username_taken' : 'username_invalid');
        return;
      }
      let finalProfile: PlayerProfile = data;
      if (avatarBlob) {
        const up = await uploadAvatar(avatarBlob);
        if (up.ok) {
          try {
            const fresh = await fetch('/api/profile/me').then((r) => r.json());
            if (fresh?.id) finalProfile = fresh;
          } catch {}
        }
        // Avatar failures don't block onboarding — it's optional anyway.
      }
      onInitialized(finalProfile);
    } catch {
      setSubmitError('username_invalid');
    } finally {
      setSubmitting(false);
    }
  };

  const handleClaim = async () => {
    if (claimBusy || !claimCode.trim()) return;
    setClaimBusy(true);
    setClaimError(null);
    try {
      const res = await fetch('/api/profile/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: claimCode.trim() }),
      });
      if (!res.ok) {
        setClaimError(t('profile_not_found', language));
        return;
      }
      // Restored profiles are already initialized; a clean reload re-enters
      // the app with the recovered identity.
      window.location.reload();
    } catch {
      setClaimError(t('profile_not_found', language));
    } finally {
      setClaimBusy(false);
    }
  };

  const canSubmit = nameStatus.kind === 'available' && !submitting;

  return (
    <div
      id="onboarding-modal-overlay"
      className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/90 backdrop-blur-md"
    >
      <div
        className="w-full max-w-md max-h-sheet scroll-y rounded-3xl border p-5 sm:p-6 flex flex-col gap-4 text-zinc-100 shadow-2xl"
        style={{
          backgroundColor: '#0f141f',
          borderColor: theme.accentColor + '50',
          boxShadow: `0 0 40px ${theme.accentColor}25`,
        }}
      >
        {/* Header */}
        <div className="flex flex-col items-center text-center gap-1.5">
          <div
            className="w-12 h-12 rounded-2xl border flex items-center justify-center"
            style={{
              color: theme.accentColor,
              borderColor: theme.accentColor + '50',
              backgroundColor: theme.accentColor + '15',
            }}
          >
            <ShieldCheck className="w-6 h-6" />
          </div>
          <h2 className="text-lg font-black font-mono tracking-wide">
            {t('onboarding_title', language)}
          </h2>
          <p className="text-[11px] text-zinc-400 leading-relaxed max-w-xs">
            {t('onboarding_subtitle', language)}
          </p>
        </div>

        {/* Avatar picker (optional) */}
        <div className="flex items-center gap-3 p-3 rounded-2xl bg-zinc-900/70 border border-zinc-800">
          <AvatarImage size={64} className="rounded-2xl" previewUrl={previewUrl} />
          <div className="flex flex-col gap-1.5 min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <button
                id="btn-onboarding-avatar"
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-mono font-bold bg-zinc-800 hover:bg-zinc-700 text-cyan-300 border border-zinc-700 transition active:scale-95"
              >
                <ImagePlus className="w-3.5 h-3.5" />
                {previewUrl ? t('change_avatar', language) : t('upload_avatar', language)}
              </button>
              {previewUrl && (
                <button
                  id="btn-onboarding-avatar-clear"
                  onClick={() => {
                    setAvatarBlob(null);
                    setPreviewUrl((old) => {
                      if (old) URL.revokeObjectURL(old);
                      return null;
                    });
                  }}
                  className="p-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-400 border border-zinc-700 transition"
                  title={t('remove_avatar', language)}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            <p className="text-[10px] text-zinc-500 leading-tight">
              {t('avatar_hint', language)} · {t('avatar_optional', language)}
            </p>
          </div>
          <input
            ref={fileInputRef}
            id="input-onboarding-avatar-file"
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handlePickAvatar}
          />
        </div>

        {/* Username (required, unique, 365-day lock) */}
        <div className="flex flex-col gap-1.5">
          <label className="text-[11px] font-mono font-bold text-zinc-300">
            {t('choose_username', language)}
          </label>
          <input
            id="input-onboarding-username"
            type="text"
            value={name}
            maxLength={USERNAME_MAX}
            autoFocus
            onChange={(e) => {
              setName(e.target.value);
              setSubmitError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSubmit();
            }}
            placeholder="NeonSmasher"
            className="w-full bg-slate-950 text-slate-100 text-base font-bold font-mono py-2.5 px-3 rounded-xl border border-slate-700 focus:border-cyan-400 focus:outline-none transition"
          />
          <div className="min-h-4 text-[10px] font-mono flex items-center gap-1">
            {nameStatus.kind === 'checking' && (
              <span className="text-zinc-400 flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" />
                {t('username_checking', language)}
              </span>
            )}
            {nameStatus.kind === 'available' && (
              <span id="username-status-available" className="text-emerald-400 flex items-center gap-1">
                <Check className="w-3 h-3" />
                {t('username_available', language)}
              </span>
            )}
            {nameStatus.kind === 'taken' && (
              <span id="username-status-taken" className="text-rose-400">
                {t('username_taken', language)}
              </span>
            )}
            {nameStatus.kind === 'invalid' && (
              <span id="username-status-invalid" className="text-amber-400">
                {t(nameStatus.reasonKey, language)}
              </span>
            )}
            {(nameStatus.kind === 'idle' || nameStatus.kind === 'invalid') && (
              <span className="text-zinc-500">
                {nameStatus.kind === 'idle' ? t('username_rules', language) : ''}
              </span>
            )}
          </div>
        </div>

        {submitError && (
          <p className="text-[11px] font-mono text-rose-400 text-center">
            {t(submitError, language)}
          </p>
        )}

        <button
          id="btn-onboarding-submit"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="w-full py-3.5 rounded-2xl font-mono text-sm font-black tracking-widest uppercase bg-cyan-500 hover:bg-cyan-400 disabled:bg-zinc-800 disabled:text-zinc-500 text-zinc-950 transition active:scale-95 shadow-lg flex items-center justify-center gap-2"
        >
          {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
          {t('lock_in_start', language)}
        </button>

        {/* Restore an existing profile instead (recovery code bypass) */}
        <div className="border-t border-zinc-800/80 pt-3 flex flex-col gap-2">
          <button
            id="btn-onboarding-show-restore"
            onClick={() => setShowRestore((v) => !v)}
            className="text-[11px] font-mono text-zinc-400 hover:text-cyan-300 transition flex items-center justify-center gap-1.5"
          >
            <KeyRound className="w-3.5 h-3.5" />
            {t('have_recovery_code', language)}
          </button>
          {showRestore && (
            <div className="flex items-center gap-2">
              <input
                id="input-onboarding-claim-code"
                type="text"
                value={claimCode}
                maxLength={9}
                onChange={(e) => setClaimCode(e.target.value.toUpperCase())}
                placeholder="XXXX-XXXX"
                className="flex-1 bg-slate-950 text-slate-100 text-base font-bold font-mono py-2.5 px-3 rounded-xl border border-slate-700 focus:border-cyan-400 focus:outline-none transition tracking-widest"
              />
              <button
                id="btn-onboarding-claim"
                onClick={handleClaim}
                disabled={claimBusy || !claimCode.trim()}
                className="px-3 py-2.5 rounded-xl font-mono text-[11px] font-bold bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-cyan-300 border border-zinc-700 transition active:scale-95"
              >
                {claimBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : t('restore_profile', language)}
              </button>
            </div>
          )}
          {claimError && (
            <p className="text-[10px] font-mono text-rose-400 text-center">{claimError}</p>
          )}
        </div>
      </div>
    </div>
  );
};
