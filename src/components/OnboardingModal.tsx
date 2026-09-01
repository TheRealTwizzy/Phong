import React, { useEffect, useRef, useState } from 'react';
import { LanguageCode, PlayerProfile, UsernameCheckResponse } from '../types';
import { Cosmetic } from '../game/cosmetics';
import { t } from '../i18n/translations';
import { Sheet } from './ui';
import { validateUsername, USERNAME_MAX } from '../profileRules';
import { detectInAppBrowser, openInRealBrowserUrl } from '../device';
import { processAvatarFile, uploadAvatar } from '../media/avatar';
import { AvatarImage } from './AvatarImage';
import { Check, ExternalLink, ImagePlus, KeyRound, Loader2, Play, ShieldCheck, X } from 'lucide-react';

// Mandatory first-arrival onboarding: every new player MUST lock in a unique
// username before touching the game (365-day rename lock starts here).
// Avatar is optional. Deliberately unclosable — the only ways out are
// initializing or restoring an existing profile with a recovery code.
interface OnboardingModalProps {
  isOpen: boolean;
  theme: Cosmetic;
  language: LanguageCode;
  /**
   * This player arrived on an invitation link. It matters because that link is
   * the one way into Phong that gets tapped from another app, so it routinely
   * opens in a browser that is not the one holding the player's account — a
   * chat app's in-app browser, or wherever a QR scan hands off to. The server
   * cannot tell that browser from a first-time visitor, so onboarding opens
   * and reads as "I have been signed out", with the player's own username
   * coming back as taken. Both are true and neither means what it looks like:
   * the account is intact in the browser it was made in. Saying that, here, is
   * what stops someone spending their way out of it.
   */
  invited?: boolean;
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
  invited = false,
  onInitialized,
}) => {
  const [name, setName] = useState('');
  const [nameStatus, setNameStatus] = useState<NameStatus>({ kind: 'idle' });
  const [avatarBlob, setAvatarBlob] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showRestore, setShowRestore] = useState(false);
  // The account exists; the player has not been shown how to get back into it
  // yet. Held here rather than closing straight to the menu — see the panel.
  const [savedProfile, setSavedProfile] = useState<PlayerProfile | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);
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
      // NOT onInitialized yet. A sign-in code the player has never seen is a
      // code they do not have: identity here is the browser's cookie, and a
      // cookie jar does not cross browsers, so the first time they open a link
      // in Messenger's webview the code is the only thing that gets them back
      // to this account. The one moment they are guaranteed to be looking is
      // right now, having just made it.
      setSavedProfile(finalProfile);
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
  // Naming the app is what turns "I got signed out" into "I am in the wrong
  // browser" — a problem the player can actually act on.
  const inApp = detectInAppBrowser(typeof navigator === 'undefined' ? '' : navigator.userAgent);
  // Android can hand the page to the real browser outright; iOS cannot, so it
  // gets the link to carry across by hand. Both beat "your account is
  // somewhere else, good luck".
  const handOff =
    typeof navigator === 'undefined' || typeof window === 'undefined'
      ? null
      : openInRealBrowserUrl(navigator.userAgent, window.location.href);
  const [linkCopied, setLinkCopied] = useState(false);

  return (
    <Sheet
      id="onboarding-modal-overlay"
      isOpen={isOpen}
      size="md"
      layer="gate"
      accent="accent"
      bodyClassName="p-5 flex flex-col gap-4"
    >
        {savedProfile ? (
          /* The account is made. Before the player is let anywhere near the
             game, they are shown the one thing that gets them back into it
             from a browser this one cannot reach — which, on a phone where
             invitation links open in whatever webview sent them, is a matter
             of when rather than if. It is deliberately a step and not a toast:
             a code nobody read is a code nobody has. */
          <div id="onboarding-code-step" className="flex flex-col gap-4">
            <div className="flex flex-col items-center text-center gap-1.5">
              <div
                className="w-12 h-12 rounded-2xl border flex items-center justify-center"
                style={{
                  color: theme.accentColor,
                  borderColor: theme.accentColor + '50',
                  backgroundColor: theme.accentColor + '15',
                }}
              >
                <KeyRound className="w-6 h-6" />
              </div>
              <h2 className="text-lg font-black tracking-wider uppercase text-ink">
                {t('onboarding_code_title', language)}
              </h2>
              <p className="text-[11px] font-mono text-ink-muted leading-relaxed">
                {t('onboarding_code_body', language)}
              </p>
            </div>

            <button
              id="onboarding-code-value"
              onClick={() => {
                navigator.clipboard?.writeText(savedProfile.recoveryCode || '').catch(() => {});
                setCodeCopied(true);
                setTimeout(() => setCodeCopied(false), 2000);
              }}
              className="w-full py-4 rounded-2xl bg-surface-0 border border-dashed text-2xl font-black font-mono tracking-[0.3em] text-center active:scale-[0.99] transition"
              style={{ color: theme.accentColor, borderColor: theme.accentColor + '60' }}
            >
              {savedProfile.recoveryCode || '····-····'}
            </button>
            <p className="text-[10px] font-mono text-ink-muted text-center -mt-2">
              {codeCopied ? t('lobby_copied', language) : t('onboarding_code_copy', language)}
            </p>

            <button
              id="btn-onboarding-code-continue"
              onClick={() => onInitialized(savedProfile)}
              className="w-full py-3.5 rounded-2xl font-mono text-sm font-black tracking-widest uppercase bg-accent hover:bg-accent text-ink-on-accent transition active:scale-95 shadow-lg flex items-center justify-center gap-2"
            >
              <Play className="w-4 h-4" />
              {t('onboarding_code_continue', language)}
            </button>
          </div>
        ) : (
        <>
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
          <p className="text-[11px] text-ink-muted leading-relaxed max-w-xs">
            {t('onboarding_subtitle', language)}
          </p>
        </div>

        {/* Avatar picker (optional) */}
        <div className="flex items-center gap-3 p-3 rounded-2xl bg-surface-2/70 border border-line">
          <AvatarImage size={64} className="rounded-2xl" previewUrl={previewUrl} />
          <div className="flex flex-col gap-1.5 min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <button
                id="btn-onboarding-avatar"
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-mono font-bold bg-surface-3 hover:bg-surface-4 text-accent border border-line-strong transition active:scale-95"
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
                  className="p-1.5 rounded-xl bg-surface-3 hover:bg-surface-4 text-ink-muted border border-line-strong transition"
                  title={t('remove_avatar', language)}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            <p className="text-[10px] text-ink-muted leading-tight">
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

        {/* Arrived on an invitation into a browser that holds no account. The
            player is about to read "pick a username" as "you were signed out",
            and their own name as "taken by someone else". */}
        {invited && (
          <p
            id="onboarding-other-browser-note"
            className="text-[11px] font-mono text-accent/80 leading-relaxed bg-accent/5 border border-accent/20 rounded-xl p-3"
          >
            {inApp
              ? t('onboarding_in_app_browser', language, { app: inApp })
              : t('onboarding_other_browser', language)}
          </p>
        )}

        {/* The way out of the wrong browser. On Android this genuinely opens
            the system default browser; on iOS there is no supported mechanism,
            so the link goes to the clipboard for the player to paste. */}
        {invited && inApp && (
          handOff ? (
            <a
              id="btn-open-real-browser"
              href={handOff}
              className="w-full py-3 rounded-2xl font-mono text-xs font-black tracking-widest uppercase bg-accent/15 border border-accent/40 text-accent text-center active:scale-[0.98] transition flex items-center justify-center gap-2"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              {t('onboarding_open_real_browser', language)}
            </a>
          ) : (
            <button
              id="btn-copy-invite-link"
              onClick={() => {
                navigator.clipboard?.writeText(window.location.href).catch(() => {});
                setLinkCopied(true);
                setTimeout(() => setLinkCopied(false), 2500);
              }}
              className="w-full py-3 rounded-2xl font-mono text-xs font-black tracking-widest uppercase bg-accent/15 border border-accent/40 text-accent active:scale-[0.98] transition flex items-center justify-center gap-2"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              {linkCopied ? t('lobby_copied', language) : t('onboarding_copy_link', language)}
            </button>
          )
        )}

        {/* Username (required, unique, 365-day lock) */}
        <div className="flex flex-col gap-1.5">
          <label className="text-[11px] font-mono font-bold text-ink">
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
            className="w-full bg-surface-0 text-ink text-base font-bold font-mono py-2.5 px-3 rounded-xl border border-line-strong focus:border-accent focus:outline-none transition"
          />
          <div className="min-h-4 text-[10px] font-mono flex items-center gap-1">
            {nameStatus.kind === 'checking' && (
              <span className="text-ink-muted flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" data-motion-essential />
                {t('username_checking', language)}
              </span>
            )}
            {nameStatus.kind === 'available' && (
              <span id="username-status-available" className="text-win flex items-center gap-1">
                <Check className="w-3 h-3" />
                {t('username_available', language)}
              </span>
            )}
            {nameStatus.kind === 'taken' && (
              <span id="username-status-taken" className="text-loss">
                {t('username_taken', language)}
              </span>
            )}
            {nameStatus.kind === 'invalid' && (
              <span id="username-status-invalid" className="text-warn">
                {t(nameStatus.reasonKey, language)}
              </span>
            )}
            {(nameStatus.kind === 'idle' || nameStatus.kind === 'invalid') && (
              <span className="text-ink-muted">
                {nameStatus.kind === 'idle' ? t('username_rules', language) : ''}
              </span>
            )}
          </div>
        </div>

        {nameStatus.kind === 'taken' && (
          <p id="username-taken-restore-hint" className="text-[11px] font-mono text-warn/90 text-center leading-relaxed">
            {t('username_taken_restore', language)}
          </p>
        )}

        {submitError && (
          <p className="text-[11px] font-mono text-loss text-center">
            {t(submitError, language)}
          </p>
        )}

        <button
          id="btn-onboarding-submit"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="w-full py-3.5 rounded-2xl font-mono text-sm font-black tracking-widest uppercase bg-accent hover:bg-accent disabled:bg-surface-3 disabled:text-ink-muted text-ink-on-accent transition active:scale-95 shadow-lg flex items-center justify-center gap-2"
        >
          {submitting ? <Loader2 className="w-4 h-4 animate-spin" data-motion-essential /> : <Play className="w-4 h-4" />}
          {t('lock_in_start', language)}
        </button>

        {/* Disclosure, not consent — and the distinction is the reason this is
            a line of text rather than a banner with a button.

            The device cookie is already set by the time this modal is on
            screen: it is established by the document NAVIGATION, before a line
            of JS runs, because anything later races itself and mints three
            identities on a slow connection (CLAUDE.md §5). So there is nothing
            here to agree to — the honest thing is to say what happened and
            where the detail is, which is one tap away in Settings. */}
        <p id="onboarding-privacy-note" className="text-[10px] font-mono text-ink-muted text-center leading-relaxed">
          {t('onboarding_privacy_note', language)}
        </p>

        {/* Restore an existing profile instead (recovery code bypass) */}
        <div className="border-t border-line/80 pt-3 flex flex-col gap-2">
          <button
            id="btn-onboarding-show-restore"
            onClick={() => setShowRestore((v) => !v)}
            className="text-[11px] font-mono text-ink-muted hover:text-accent transition flex items-center justify-center gap-1.5"
          >
            <KeyRound className="w-3.5 h-3.5" />
            {t('have_recovery_code', language)}
          </button>
          {(showRestore || nameStatus.kind === 'taken') && (
            <div className="flex items-center gap-2">
              <input
                id="input-onboarding-claim-code"
                type="text"
                value={claimCode}
                maxLength={9}
                onChange={(e) => setClaimCode(e.target.value.toUpperCase())}
                placeholder="XXXX-XXXX"
                className="flex-1 bg-surface-0 text-ink text-base font-bold font-mono py-2.5 px-3 rounded-xl border border-line-strong focus:border-accent focus:outline-none transition tracking-widest"
              />
              <button
                id="btn-onboarding-claim"
                onClick={handleClaim}
                disabled={claimBusy || !claimCode.trim()}
                className="px-3 py-2.5 rounded-xl font-mono text-[11px] font-bold bg-surface-3 hover:bg-surface-4 disabled:opacity-50 text-accent border border-line-strong transition active:scale-95"
              >
                {claimBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" data-motion-essential /> : t('restore_profile', language)}
              </button>
            </div>
          )}
          {claimError && (
            <p className="text-[10px] font-mono text-loss text-center">{claimError}</p>
          )}
        </div>
        </>
        )}
    </Sheet>
  );
};
