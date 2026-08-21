import { AVATAR_SIZE, AVATAR_MAX_BYTES } from '../profileRules';

// Client-side avatar pipeline: decode whatever image the player picked,
// center-crop it square, resize to exactly AVATAR_SIZE × AVATAR_SIZE, and
// re-encode as PNG — the only shape/format the server accepts.
export async function processAvatarFile(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    if (!side) throw new Error('not-an-image');

    const sx = (img.naturalWidth - side) / 2;
    const sy = (img.naturalHeight - side) / 2;

    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_SIZE;
    canvas.height = AVATAR_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas-unavailable');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('encode-failed');
    if (blob.size > AVATAR_MAX_BYTES) throw new Error('too-large');
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('not-an-image'));
    img.src = url;
  });
}

export interface AvatarUploadResult {
  ok: boolean;
  avatarVersion?: number;
  error?: string;
}

export async function uploadAvatar(blob: Blob): Promise<AvatarUploadResult> {
  try {
    const res = await fetch('/api/profile/me/avatar', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: blob,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: data?.error || 'AVATAR_INVALID' };
    }
    return { ok: true, avatarVersion: data.avatarVersion };
  } catch {
    return { ok: false, error: 'NETWORK' };
  }
}

export async function deleteAvatar(): Promise<boolean> {
  try {
    const res = await fetch('/api/profile/me/avatar', { method: 'DELETE' });
    return res.ok;
  } catch {
    return false;
  }
}
