import React, { useEffect, useState } from 'react';
import { User } from 'lucide-react';

// A player's avatar, or the classic gradient/User-icon tile when they have
// none (or the image fails to load). `avatarVersion` cache-busts the
// immutably-cached /api/avatar/:id response after re-uploads; `previewUrl`
// short-circuits to a local object URL (onboarding preview before upload).
interface AvatarImageProps {
  playerId?: string | null;
  hasAvatar?: boolean;
  avatarVersion?: number;
  size?: number; // px
  className?: string;
  previewUrl?: string | null;
}

export const AvatarImage: React.FC<AvatarImageProps> = ({
  playerId,
  hasAvatar = false,
  avatarVersion,
  size = 40,
  className = '',
  previewUrl = null,
}) => {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [playerId, avatarVersion, previewUrl]);

  const src =
    previewUrl ||
    (playerId && hasAvatar
      ? `/api/avatar/${encodeURIComponent(playerId)}${avatarVersion ? `?v=${avatarVersion}` : ''}`
      : null);

  return (
    <div
      className={`relative overflow-hidden bg-gradient-to-tr from-accent to-indigo-500 flex items-center justify-center shrink-0 ${className}`}
      style={{ width: size, height: size }}
    >
      {src && !failed ? (
        <img
          src={src}
          alt=""
          className="w-full h-full object-cover"
          draggable={false}
          onError={() => setFailed(true)}
        />
      ) : (
        <User className="text-ink/85" style={{ width: size * 0.5, height: size * 0.5 }} />
      )}
    </div>
  );
};
