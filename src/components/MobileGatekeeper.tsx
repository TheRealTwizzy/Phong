import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Smartphone, QrCode, MonitorX, RotateCcw, Play, Sparkles } from 'lucide-react';
import { LanguageCode } from '../types';
import { t } from '../i18n/translations';

interface MobileGatekeeperProps {
  children: React.ReactNode;
  language: LanguageCode;
}

export const MobileGatekeeper: React.FC<MobileGatekeeperProps> = ({ children, language }) => {
  const [isMobileResolution, setIsMobileResolution] = useState<boolean>(true);
  const [isLandscape, setIsLandscape] = useState<boolean>(false);
  const [isSimulatorActive, setIsSimulatorActive] = useState<boolean>(() => {
    // Check if user has enabled simulation mode in localStorage or query param
    return (
      new URLSearchParams(window.location.search).get('sim') === 'true' ||
      localStorage.getItem('half_pong_sim_mode') === 'true'
    );
  });

  useEffect(() => {
    const checkResolution = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;

      // Check if aspect ratio and width match a mobile smartphone (portrait)
      const isNarrow = width <= 540;
      const isPortrait = height >= width * 1.15;
      const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

      // Landscape check for mobile
      if (width <= 900 && width > height) {
        setIsLandscape(true);
        setIsMobileResolution(false);
      } else {
        setIsLandscape(false);
        setIsMobileResolution(isNarrow || (isPortrait && width <= 600));
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

  const currentUrl = typeof window !== 'undefined' ? window.location.href : '';
  // Generate a high-contrast QR code URL using a public QR code API
  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(
    currentUrl
  )}&bgcolor=0b0f19&color=00f0ff&margin=1`;

  // If mobile resolution is met or simulator is active, render the game
  if (isMobileResolution || isSimulatorActive) {
    if (isSimulatorActive && !isMobileResolution) {
      // Render inside a modern smartphone bezel frame for desktop inspection/testing
      return (
        <div className="w-screen h-screen bg-slate-950 flex flex-col items-center justify-center p-4 overflow-hidden relative">
          {/* Top Simulator Banner */}
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-1.5 bg-slate-900/90 border border-cyan-500/40 rounded-full shadow-lg text-xs text-cyan-300 font-mono">
            <Smartphone className="w-3.5 h-3.5 text-cyan-400" />
            <span>SMARTPHONE SIMULATOR (390 × 844)</span>
            <button
              onClick={() => {
                setIsSimulatorActive(false);
                localStorage.removeItem('half_pong_sim_mode');
              }}
              className="text-slate-400 hover:text-white underline ml-1"
            >
              Exit Sim
            </button>
          </div>

          {/* Smartphone Frame */}
          <div className="w-[390px] h-[844px] max-h-[92vh] bg-black rounded-[48px] p-3 border-[6px] border-slate-700/80 shadow-[0_0_50px_rgba(0,240,255,0.15)] flex flex-col relative overflow-hidden ring-1 ring-white/10">
            {/* Dynamic Island / Speaker Notch */}
            <div className="absolute top-4 left-1/2 -translate-x-1/2 w-28 h-5 bg-black rounded-full z-40 flex items-center justify-center border border-slate-800">
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
        </div>
      );
    }

    return <>{children}</>;
  }

  // Desktop or Tablet Non-Optimized Resolution Lock Screen
  return (
    <div className="fixed inset-0 z-50 w-screen h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-6 select-none overflow-y-auto">
      {/* Ambient background glow */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_rgba(0,240,255,0.06)_0%,_transparent_70%)] pointer-events-none" />

      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="relative max-w-md w-full bg-slate-900/90 border border-cyan-500/30 rounded-3xl p-6 sm:p-8 shadow-2xl shadow-cyan-950/40 backdrop-blur-xl flex flex-col items-center text-center"
      >
        {/* Warning Icon Badge */}
        <div className="w-16 h-16 rounded-2xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400 mb-4 shadow-lg shadow-cyan-500/10">
          {isLandscape ? <RotateCcw className="w-8 h-8 animate-spin" style={{ animationDuration: '6s' }} /> : <MonitorX className="w-8 h-8" />}
        </div>

        {/* Title & Restriction Notice */}
        <h1 className="text-xl sm:text-2xl font-black text-white tracking-wider uppercase mb-2">
          {isLandscape ? t('rotate_prompt', language) : t('mobile_only_title', language)}
        </h1>

        <p className="text-sm font-semibold text-cyan-400 mb-2">
          {t('mobile_only_subtitle', language)}
        </p>

        <p className="text-xs text-slate-400 leading-relaxed mb-6">
          {t('mobile_only_desc', language)}
        </p>

        {/* QR Code Section to open directly on Smartphone */}
        <div className="bg-slate-950 border border-slate-800 p-4 rounded-2xl flex flex-col items-center mb-6 w-full shadow-inner">
          <p className="text-[11px] font-mono font-bold text-slate-400 uppercase tracking-wider mb-3">
            {t('scan_qr', language)}
          </p>

          <div className="p-2 bg-slate-900 border border-cyan-500/40 rounded-xl shadow-md">
            <img
              src={qrCodeUrl}
              alt="Scan to open on smartphone"
              className="w-36 h-36 rounded-lg block"
              referrerPolicy="no-referrer"
            />
          </div>

          <span className="text-[10px] font-mono text-cyan-400/80 mt-2 truncate max-w-[280px]">
            {currentUrl}
          </span>
        </div>

        {/* Development / Preview Smartphone Simulator Bypass */}
        <button
          id="simulate-smartphone-btn"
          onClick={() => {
            setIsSimulatorActive(true);
            localStorage.setItem('half_pong_sim_mode', 'true');
          }}
          className="w-full py-3 px-4 bg-slate-800 hover:bg-slate-700 active:scale-98 text-white font-bold text-xs rounded-xl border border-slate-700 transition-all flex items-center justify-center gap-2"
        >
          <Smartphone className="w-4 h-4 text-cyan-400" />
          <span>{t('simulate_phone', language)}</span>
        </button>
      </motion.div>
    </div>
  );
};
