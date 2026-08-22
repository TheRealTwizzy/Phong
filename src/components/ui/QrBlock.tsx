import React, { useMemo } from 'react';
import { encodeQr, qrToSvgPath, type EccLevel } from '../../media/qr';

// A QR code rendered from the in-repo encoder, as a single SVG path.
//
// The lobby used to fetch its code as a bitmap from api.qrserver.com, which
// handed every room URL to a third party, broke on any network that could not
// reach them, and pixelated when scaled. src/media/qr.ts has been sitting
// beside it the whole time — MobileGatekeeper already uses it for exactly
// this. Zero dependencies, zero network, exact at any size.

export interface QrBlockProps {
  id?: string;
  value: string;
  /**
   * Level Q by default: a phone camera reads this off another phone's screen,
   * at an angle, often with glare. The extra redundancy is worth the modules.
   */
  level?: EccLevel;
  className?: string;
  /** Rendered under the code — the fallback when a camera will not cooperate. */
  caption?: React.ReactNode;
}

export const QrBlock: React.FC<QrBlockProps> = ({
  id,
  value,
  level,
  className = '',
  caption,
}) => {
  const ecc: EccLevel = level ?? 'Q';
  const qr = useMemo(() => {
    if (!value) return null;
    try {
      const matrix = encodeQr(value, ecc);
      return { path: qrToSvgPath(matrix, 4), extent: matrix.size + 8 };
    } catch {
      // A URL too long for version 10 is not a reason to show nothing: the
      // room code itself is still readable and typable.
      return null;
    }
  }, [value, ecc]);

  if (!qr) return null;

  return (
    <div className={`flex flex-col items-center gap-1.5 ${className}`}>
      <div className="rounded-card bg-white p-2.5">
        <svg
          id={id}
          viewBox={`0 0 ${qr.extent} ${qr.extent}`}
          className="h-40 w-40 max-w-full"
          role="img"
          aria-label="Room join code"
          shapeRendering="crispEdges"
        >
          <path d={qr.path} fill="#000" />
        </svg>
      </div>
      {caption != null && (
        <span className="text-2xs font-normal tracking-normal text-ink-muted">{caption}</span>
      )}
    </div>
  );
};
