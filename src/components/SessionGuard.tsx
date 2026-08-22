import React from 'react';
import { motion } from 'motion/react';
import { Loader2, MonitorSmartphone, RefreshCw, UserPlus } from 'lucide-react';
import { LanguageCode } from '../types';
import { ClientSessionStatus } from '../net/session';
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
// This is deliberately a WALL and not a toast. The state it reports is one
// where nothing the player does counts: no match records, no XP, no rating.
// Letting them keep playing behind a dismissible banner is exactly the bug —
// a full match played on a phone whose account had already moved to a
// desktop, discovered only when the finished match was refused.
//
// Only the states that MEAN something is wrong are on this list.
//
// `offline` is left off on purpose: a heartbeat that could not reach the
// server is a dropped connection, not an eviction, and throwing a player off
// the court every time a phone changes cells would be its own bug.
//
// `connecting` and `none` are left off for a different reason. They do not
// mean "you may not play", they mean "we have not asked yet" — and blocking
// on them put a network round trip in front of the first paint, so the menu
// and the onboarding modal arrived a beat later than they used to for every
// player on every load. Nothing is lost by rendering: writes are gated
// server-side regardless, and a match recorded before the session lands is
// answered SESSION_REQUIRED, which postMatchRecord resolves by minting one
// and retrying.
const BLOCKING: ClientSessionStatus[] = ['released', 'superseded', 'stale_build'];

export const SessionGuard: React.FC<SessionGuardProps> = ({
  status,
  busy,
  language,
  onAdopt,
  onStartFresh,
  children,
}) => {
  if (!BLOCKING.includes(status)) return <>{children}</>;

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

  return (
    <div
      id="session-guard-overlay"
      data-session-status={status}
      className="fixed inset-0 z-[60] w-screen h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6 select-none"
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

        {copy.action ? (
          <button
            id="btn-session-action"
            onClick={copy.onAction}
            disabled={busy}
            className="w-full px-5 py-3 rounded-xl bg-cyan-500 text-slate-950 font-bold uppercase tracking-wider text-xs shadow-lg shadow-cyan-500/20 disabled:opacity-50 active:scale-[0.98] transition"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : copy.action}
          </button>
        ) : (
          <Loader2 className="w-5 h-5 animate-spin text-cyan-400/70" />
        )}
      </motion.div>
    </div>
  );
};
