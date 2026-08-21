import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { Smartphone, RotateCcw } from 'lucide-react';
import { LanguageCode } from '../types';
import { t } from '../i18n/translations';

interface MobileGatekeeperProps {
  children: React.ReactNode;
  language: LanguageCode;
}

// How the app is presented for the current viewport:
//  - native: phone-sized viewport, render the game full-window
//  - framed: anything larger (desktop, tablet, zoomed-out browser) — render
//    the game inside a centered phone-proportioned frame, always playable
//  - rotate: a real touch device held in landscape — ask for portrait
type ViewMode = 'native' | 'framed' | 'rotate';

export const MobileGatekeeper: React.FC<MobileGatekeeperProps> = ({ children, language }) => {
  const [viewMode, setViewMode] = useState<ViewMode>('native');

  useEffect(() => {
    const checkResolution = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

      const isNarrow = width <= 540;
      const isPortrait = height >= width * 1.15;
      const isPhoneViewport = isNarrow || (isPortrait && width <= 600);

      if (isTouch && width > height && width <= 900) {
        // A real phone (touch) held sideways: portrait is required for the
        // half-court layout, so ask for a rotation.
        setViewMode('rotate');
      } else if (isPhoneViewport) {
        setViewMode('native');
      } else {
        // Desktops, tablets, and zoom-level oddities all get the playable
        // frame — never a lock screen. Browser zoom merely resizes the frame.
        setViewMode('framed');
      }
    };

    checkResolution();
    window.addEventListener('resize', checkResolution);
    window.addEventListener('orientationchange', checkResolution);

    return () => {
      window.removeEventListener('resize', checkResolution);
      window.removeEventListener('orientationchange', checkResolution);
    };
  }, []);

  if (viewMode === 'native') {
    return <>{children}</>;
  }

  if (viewMode === 'rotate') {
    return (
      <div className="fixed inset-0 z-50 w-screen h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-6 select-none">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_rgba(0,240,255,0.06)_0%,_transparent_70%)] pointer-events-none" />
        <motion.div
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="relative max-w-md w-full bg-slate-900/90 border border-cyan-500/30 rounded-3xl p-8 shadow-2xl shadow-cyan-950/40 backdrop-blur-xl flex flex-col items-center text-center"
        >
          <div className="w-16 h-16 rounded-2xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400 mb-4 shadow-lg shadow-cyan-500/10">
            <RotateCcw className="w-8 h-8 animate-spin" style={{ animationDuration: '6s' }} />
          </div>
          <h1 className="text-xl sm:text-2xl font-black text-white tracking-wider uppercase mb-2">
            {t('rotate_prompt', language)}
          </h1>
          <p className="text-xs text-slate-400 leading-relaxed">{t('mobile_only_subtitle', language)}</p>
        </motion.div>
      </div>
    );
  }

  // framed: the game runs inside a phone bezel, centered; a side card nudges
  // players toward the real two-phone experience without ever blocking play.
  const currentUrl = typeof window !== 'undefined' ? window.location.href : '';
  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(
    currentUrl
  )}&bgcolor=0b0f19&color=00f0ff&margin=1`;

  return (
    <div className="w-screen h-screen bg-slate-950 flex items-center justify-center gap-8 p-4 overflow-hidden relative">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_rgba(0,240,255,0.05)_0%,_transparent_70%)] pointer-events-none" />

      {/* Smartphone Frame — the game itself, always interactive */}
      <div
        id="phone-frame"
        className="w-[390px] h-[844px] max-h-[96vh] bg-black rounded-[48px] p-3 border-[6px] border-slate-700/80 shadow-[0_0_50px_rgba(0,240,255,0.15)] flex flex-col relative overflow-hidden ring-1 ring-white/10 shrink-0"
      >
        {/* Dynamic Island / Speaker Notch */}
        <div className="absolute top-4 left-1/2 -translate-x-1/2 w-28 h-5 bg-black rounded-full z-40 flex items-center justify-center border border-slate-800 pointer-events-none">
          <div className="w-2.5 h-2.5 rounded-full bg-slate-900 border border-slate-800 mr-2" />
          <div className="w-2 h-2 rounded-full bg-cyan-950" />
        </div>

        {/* Inner Mobile Screen Content */}
        <div className="w-full h-full rounded-[38px] overflow-hidden relative flex flex-col bg-slate-950">
          {children}
        </div>

        {/* Home Indicator Bar */}
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 w-32 h-1 bg-slate-600/60 rounded-full z-40 pointer-events-none" />
      </div>

      {/* Side hint: play it on a real phone (hidden on smaller desktop windows) */}
      <div className="relative hidden lg:flex flex-col items-center text-center max-w-[240px] bg-slate-900/80 border border-cyan-500/20 rounded-2xl p-5 shadow-xl backdrop-blur">
        <Smartphone className="w-6 h-6 text-cyan-400 mb-2" />
        <p className="text-xs font-bold text-white uppercase tracking-wider mb-1">
          {t('mobile_only_title', language)}
        </p>
        <p className="text-[11px] text-slate-400 leading-relaxed mb-4">
          {t('mobile_only_subtitle', language)}
        </p>
        <p className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-wider mb-2">
          {t('scan_qr', language)}
        </p>
        <div className="p-2 bg-slate-950 border border-cyan-500/40 rounded-xl shadow-md">
          <img
            src={qrCodeUrl}
            alt="Scan to open on smartphone"
            className="w-28 h-28 rounded-lg block"
            referrerPolicy="no-referrer"
          />
        </div>
      </div>
    </div>
  );
};
