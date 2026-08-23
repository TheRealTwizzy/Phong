import React, { useState } from 'react';
import { motion } from 'motion/react';
import { Loader2, MonitorSmartphone, RefreshCw, UserPlus } from 'lucide-react';
import { LanguageCode } from '../types';
import { ClientSessionStatus, isBlockingStatus } from '../net/session';
import { t } from '../i18n/translations';

interface SessionGuardProps {
  status: ClientSessionStatus;
  busy: boolean;
  language: LanguageCode;
  /** Take (or take back) the account for this device. */
  onAdopt: () => void;
  /** Give up this device's identity and start over as a new player. */
  onStartFresh: () => void;
  children: React.ReactNode;
}

// The visible half of "one account, one live device".
//
// Which states get a wall — and, just as importantly, which do not — is
// decided by BLOCKING_STATUSES in src/net/session.ts, next to the session
// model it describes. The reasoning lives there.
//
// `released` is the one that had to change. It is the state a player reaches
// after their account was transferred to another browser, and it used to offer
// exactly one button: "start as a new player". That button is irreversible —
// it mints a new device identity, so the account left behind is reachable by
// nobody, ever, and its username can never be claimed again. A full-screen
// wall with a single button is not a choice, it is an instruction, and players
// followed it. "My account still exists but I lost access" is what that reads
// like from the other side.
//
// So the wall now leads with the non-destructive way out — restore the account
// here with its recovery code — and starting over has to be confirmed, with
// the consequence said out loud first.

const RestoreForm: React.FC<{ language: LanguageCode }> = ({ language }) => {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy || !code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/profile/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim() }),
      });
      if (!res.ok) {
        setError(t('profile_not_found', language));
        return;
      }
      // The claim issued this device a session as well as the account, so a
      // clean reload comes back on the far side of the wall.
      window.location.reload();
    } catch {
      setError(t('profile_not_found', language));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full flex flex-col gap-2">
      <p className="text-[10px] text-slate-400 leading-relaxed">
        {t('session_moved_restore_hint', language)}
      </p>
      <div className="flex items-center gap-2">
        <input
          id="input-session-claim-code"
          type="text"
          value={code}
          maxLength={9}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
          placeholder="XXXX-XXXX"
          className="flex-1 min-w-0 bg-slate-950 text-slate-100 text-base font-bold font-mono py-2.5 px-3 rounded-xl border border-slate-700 focus:border-cyan-400 focus:outline-none transition tracking-widest"
        />
        <button
          id="btn-session-claim"
          onClick={() => void submit()}
          disabled={busy || !code.trim()}
          className="px-4 py-2.5 rounded-xl bg-cyan-500 text-slate-950 font-bold uppercase tracking-wider text-[11px] disabled:opacity-40 active:scale-[0.98] transition shrink-0"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : t('restore_profile', language)}
        </button>
      </div>
      {error && <p className="text-[10px] font-mono text-rose-400 text-center">{error}</p>}
    </div>
  );
};

export const SessionGuard: React.FC<SessionGuardProps> = ({
  status,
  busy,
  language,
  onAdopt,
  onStartFresh,
  children,
}) => {
  // Starting over is one press away from being irrecoverable, so it takes two:
  // the first says what it costs, the second does it.
  const [confirmingFresh, setConfirmingFresh] = useState(false);

  if (!isBlockingStatus(status)) return <>{children}</>;

  const copy = {
    released: {
      icon: <UserPlus className="w-8 h-8" />,
      title: t('session_moved_title', language),
      body: t('session_moved_body', language),
      action: t('session_moved_action', language),
      onAction: onStartFresh,
    },
    superseded: {
      icon: <MonitorSmartphone className="w-8 h-8" />,
      title: t('session_taken_title', language),
      body: t('session_taken_body', language),
      action: t('session_taken_action', language),
      onAction: onAdopt,
    },
    stale_build: {
      icon: <RefreshCw className="w-8 h-8 animate-spin" style={{ animationDuration: '2s' }} />,
      title: t('session_update_title', language),
      body: t('session_update_body', language),
      // Nothing to press: the reload is already under way.
      action: '',
      onAction: onAdopt,
    },
  }[status as 'released' | 'superseded' | 'stale_build'];

  const isReleased = status === 'released';

  return (
    <div
      id="session-guard-overlay"
      data-session-status={status}
      className="fixed inset-0 z-[60] w-screen h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6 select-none overflow-y-auto"
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_rgba(0,240,255,0.06)_0%,_transparent_70%)] pointer-events-none" />
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="relative w-full max-w-sm bg-slate-900/90 border border-cyan-500/30 rounded-3xl p-8 shadow-2xl shadow-cyan-950/40 backdrop-blur-xl flex flex-col items-center text-center"
      >
        <div className="w-16 h-16 rounded-2xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400 mb-4">
          {copy.icon}
        </div>
        <h1 className="text-xl font-black text-white tracking-wider uppercase mb-2">{copy.title}</h1>
        <p className="text-xs text-slate-400 leading-relaxed mb-6">{copy.body}</p>

        {/* The way out that keeps the account. Deliberately above the one that
            spends it — this is the wall a player reaches by following an
            invitation into a browser that is not the one they play in. */}
        {isReleased && (
          <>
            <RestoreForm language={language} />
            <div className="w-full h-px bg-slate-800 my-5" />
          </>
        )}

        {copy.action ? (
          isReleased && confirmingFresh ? (
            <div className="w-full flex flex-col gap-2">
              <p className="text-[11px] text-amber-300/90 leading-relaxed">
                {t('session_moved_confirm', language)}
              </p>
              <div className="flex items-center gap-2">
                <button
                  id="btn-session-fresh-cancel"
                  onClick={() => setConfirmingFresh(false)}
                  className="flex-1 px-3 py-3 rounded-xl bg-slate-800 text-slate-200 font-bold uppercase tracking-wider text-[11px] active:scale-[0.98] transition"
                >
                  {t('cancel', language)}
                </button>
                <button
                  id="btn-session-action"
                  onClick={copy.onAction}
                  disabled={busy}
                  className="flex-1 px-3 py-3 rounded-xl bg-rose-500 text-slate-950 font-bold uppercase tracking-wider text-[11px] disabled:opacity-50 active:scale-[0.98] transition"
                >
                  {busy ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : t('session_moved_confirm_action', language)}
                </button>
              </div>
            </div>
          ) : (
            <button
              id={isReleased ? 'btn-session-fresh' : 'btn-session-action'}
              onClick={isReleased ? () => setConfirmingFresh(true) : copy.onAction}
              disabled={busy}
              className={
                isReleased
                  ? 'w-full px-5 py-3 rounded-xl bg-transparent text-slate-400 border border-slate-700 font-bold uppercase tracking-wider text-[11px] disabled:opacity-50 active:scale-[0.98] transition'
                  : 'w-full px-5 py-3 rounded-xl bg-cyan-500 text-slate-950 font-bold uppercase tracking-wider text-xs shadow-lg shadow-cyan-500/20 disabled:opacity-50 active:scale-[0.98] transition'
              }
            >
              {busy && !isReleased ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : copy.action}
            </button>
          )
        ) : (
          <Loader2 className="w-5 h-5 animate-spin text-cyan-400/70" />
        )}
      </motion.div>
    </div>
  );
};
