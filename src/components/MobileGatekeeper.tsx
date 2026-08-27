import React, { useMemo, useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { RotateCcw, Smartphone } from 'lucide-react';
import { LanguageCode } from '../types';
import { t } from '../i18n/translations';
import { classifyDevice, DeviceClass, desktopPlayAllowed } from '../device';
import { encodeQr, qrToSvgPath } from '../media/qr';

interface MobileGatekeeperProps {
  children: React.ReactNode;
  language: LanguageCode;
}

// Phong is a smartphone game and now says so.
//
// What was here before decided by VIEWPORT SIZE and, whatever it decided,
// always rendered the game — a desktop just got it inside a drawn phone
// bezel, with a 200×200 QR fetched from api.qrserver.com beside it. Two
// problems, both reported: resizing a desktop window walked through the
// check, and every desktop visitor's URL was handed to a third party to have
// its picture taken.
//
// So: the verdict comes from the platform the browser reports (see
// src/device.ts), the QR is generated here with no network call and no
// dependency, and it is an SVG — crisp at whatever size the screen can show,
// rather than a 200px bitmap stretched over a retina panel.

type ViewMode = 'play' | 'rotate' | 'blocked';

/** A phone must be held in portrait: the half-court IS the tall half of a screen. */
function useViewMode(): { mode: ViewMode; device: DeviceClass } {
  const [device] = useState<DeviceClass>(() => (desktopPlayAllowed() ? 'phone' : classifyDevice()));
  const [landscape, setLandscape] = useState(false);

  useEffect(() => {
    if (device !== 'phone') return;
    const check = () => setLandscape(window.innerWidth > window.innerHeight);
    check();
    window.addEventListener('resize', check);
    window.addEventListener('orientationchange', check);
    return () => {
      window.removeEventListener('resize', check);
      window.removeEventListener('orientationchange', check);
    };
  }, [device]);

  if (device !== 'phone') return { mode: 'blocked', device };
  return { mode: landscape ? 'rotate' : 'play', device };
}

const Panel: React.FC<{ children: React.ReactNode; wide?: boolean; id?: string; device?: DeviceClass }> = ({
  children,
  wide,
  id,
  device,
}) => (
  // The id lives on the FIXED element, not a wrapper around it: a wrapper
  // whose only child is position:fixed collapses to zero height, which reads
  // as hidden to anything measuring it (the e2e did exactly that).
  <div
    id={id}
    data-device={device}
    className="fixed inset-0 z-50 w-screen h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6 select-none overflow-auto"
  >
    <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_rgba(0,240,255,0.06)_0%,_transparent_70%)] pointer-events-none" />
    <motion.div
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className={`relative w-full ${wide ? 'max-w-md' : 'max-w-sm'} bg-slate-900/90 border border-cyan-500/30 rounded-3xl p-8 shadow-2xl shadow-surface-0/60 backdrop-blur-xl flex flex-col items-center text-center`}
    >
      {children}
    </motion.div>
  </div>
);

export const MobileGatekeeper: React.FC<MobileGatekeeperProps> = ({ children, language }) => {
  const { mode, device } = useViewMode();

  // The URL is stable for the life of the page, and encoding is the only
  // non-trivial work this component does.
  const url = typeof window !== 'undefined' ? window.location.href : '';
  const qr = useMemo(() => {
    if (mode !== 'blocked' || !url) return null;
    try {
      // Level Q: a phone camera reads this off a monitor, at an angle, with
      // glare. The extra redundancy is worth the handful of modules.
      const matrix = encodeQr(url, 'Q');
      return { path: qrToSvgPath(matrix, 4), extent: matrix.size + 8 };
    } catch {
      // A URL too long for version 10 is not a reason to show nothing; the
      // address below the code is still readable and typable.
      return null;
    }
  }, [mode, url]);

  if (mode === 'play') return <>{children}</>;

  if (mode === 'rotate') {
    return (
      <Panel>
        <div className="w-16 h-16 rounded-2xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400 mb-4 shadow-lg shadow-accent/10">
          <RotateCcw className="w-8 h-8 animate-spin" style={{ animationDuration: '6s' }} />
        </div>
        <h1 className="text-xl sm:text-2xl font-black text-white tracking-wider uppercase mb-2">
          {t('rotate_prompt', language)}
        </h1>
        <p className="text-xs text-slate-400 leading-relaxed">{t('mobile_only_subtitle', language)}</p>
      </Panel>
    );
  }

  return (
    <Panel wide id="device-gate" device={device}>
      <div className="w-16 h-16 rounded-2xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400 mb-4 shadow-lg shadow-accent/10">
        <Smartphone className="w-8 h-8" />
      </div>
      <h1 className="text-xl sm:text-2xl font-black text-white tracking-wider uppercase mb-2">
        {t('mobile_only_title', language)}
      </h1>
      <p className="text-xs text-slate-400 leading-relaxed mb-6">
        {t(device === 'tablet' ? 'gate_tablet_body' : 'gate_desktop_body', language)}
      </p>

      {qr && (
        <>
          <p className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-wider mb-3">
            {t('gate_scan_hint', language)}
          </p>
          {/* Rendered from the matrix, so it is exact at any size — no
              upscaled bitmap, and nothing fetched from anywhere. */}
          <svg
            id="device-gate-qr"
            viewBox={`0 0 ${qr.extent} ${qr.extent}`}
            className="w-64 h-64 max-w-full rounded-xl bg-white p-1 shadow-lg"
            shapeRendering="crispEdges"
            role="img"
            aria-label={t('gate_scan_hint', language)}
          >
            <rect width={qr.extent} height={qr.extent} fill="#ffffff" />
            <path d={qr.path} fill="#020617" />
          </svg>
        </>
      )}

      <p className="text-[10px] text-slate-500 uppercase tracking-wider mt-6 mb-1">
        {t('gate_url_label', language)}
      </p>
      <p className="text-[11px] font-mono text-cyan-300/90 break-all leading-relaxed">{url}</p>
    </Panel>
  );
};
