import React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { X } from 'lucide-react';
import { useMotion } from './motion';

// The one modal surface. Eleven components used to hand-roll this; the
// backdrop string alone was byte-identical across five of them.
//
// The important structural difference from what it replaces: AnimatePresence
// sits ABOVE the isOpen check. Every modal in the app used to `return null`
// before rendering its AnimatePresence, which unmounts the whole subtree and
// means `exit` never plays — every exit animation in the app was decorative
// code that could not run. Here `isOpen` gates the children INSIDE
// AnimatePresence, which is what lets a close animate out.
//
// Two placement rules the e2e suites depend on:
//   - `id` lands on the position:fixed backdrop. A wrapper around a fixed
//     element collapses to zero height and reads as hidden to Playwright.
//   - `cardId` lands on the card, for suites that query inside the panel
//     (e.g. '#leaderboard-modal-container button:has-text("…")').

const SIZE = {
  xs: 'max-w-xs',
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
} as const;

// Maps onto the ladder the app already uses — no new z-indices.
const LAYER = {
  default: 'z-50',
  over: 'z-[60]', // sits over another sheet (public profile, quit confirm)
  gate: 'z-[70]', // unclosable gates (onboarding)
} as const;

const ACCENT = {
  neutral: 'border-line-strong',
  accent: 'border-accent/40',
  win: 'border-win/40',
  loss: 'border-loss/40',
  warn: 'border-warn/40',
} as const;

export interface SheetProps {
  /** Goes on the fixed backdrop. */
  id?: string;
  /** Goes on the card, for suites querying inside the panel. */
  cardId?: string;
  /**
   * Inline style for the card. Exists for one caller: the public-profile sheet
   * publishes the profile OWNER's cosmetic here, so the card is painted in
   * their look while the page behind it stays in the viewer's. The backdrop is
   * deliberately not covered — it dims the viewer's app, not the owner's.
   */
  cardStyle?: React.CSSProperties;
  /** Published as data-mode, so `cos-light:` resolves inside a card that is
      wearing a different cosmetic than the page around it. */
  cardMode?: 'dark' | 'light';
  isOpen: boolean;
  /** Omit to make the sheet unclosable (an onboarding-style gate). */
  onClose?: () => void;
  size?: keyof typeof SIZE;
  variant?: 'center' | 'bottom';
  layer?: keyof typeof LAYER;
  /**
   * `solid` exists for sheets that render over the live court. A
   * backdrop-filter recompositing a 60fps canvas every frame is the worst
   * perf hazard available to this app.
   */
  backdrop?: 'blur' | 'solid';
  accent?: keyof typeof ACCENT;
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  /** Replaces the default header entirely, for modals with their own chrome. */
  header?: React.ReactNode;
  /**
   * Pinned below the scroll area as a flex sibling — never `position: sticky`,
   * which overlays the last rows and makes Playwright clicks land on the
   * footer instead of the row underneath.
   */
  footer?: React.ReactNode;
  closeId?: string;
  closeLabel?: string;
  dismissOnBackdrop?: boolean;
  /** Overrides the default body padding/layout. */
  bodyClassName?: string;
  /** Escape hatch for a card that needs its own border or background. */
  cardClassName?: string;
  children: React.ReactNode;
}

export const Sheet: React.FC<SheetProps> = ({
  id,
  cardId,
  cardStyle,
  cardMode,
  isOpen,
  onClose,
  size = 'md',
  variant = 'center',
  layer = 'default',
  backdrop = 'blur',
  accent = 'neutral',
  title,
  subtitle,
  icon,
  header,
  footer,
  closeId,
  closeLabel = 'Close',
  dismissOnBackdrop = true,
  bodyClassName,
  cardClassName = '',
  children,
}) => {
  const m = useMotion();
  const canDismiss = Boolean(onClose) && dismissOnBackdrop;

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          id={id}
          className={`fixed inset-0 ${LAYER[layer]} flex ${
            variant === 'bottom' ? 'items-end' : 'items-center'
          } justify-center p-4 pt-safe pb-safe ${
            backdrop === 'blur' ? 'bg-surface-0/80 backdrop-blur-md' : 'bg-surface-0/94'
          }`}
          {...m.backdrop}
          // Pointer-down rather than click, and only when the press actually
          // started on the scrim: a drag that happens to end out here should
          // not close the sheet.
          onPointerDown={
            canDismiss
              ? (e) => {
                  if (e.target === e.currentTarget) onClose!();
                }
              : undefined
          }
        >
          <motion.div
            id={cardId}
            style={cardStyle}
            data-mode={cardMode}
            role="dialog"
            aria-modal="true"
            className={`w-full ${SIZE[size]} max-h-sheet flex flex-col overflow-hidden rounded-sheet border ${ACCENT[accent]} bg-surface-2 text-ink shadow-sheet ${cardClassName}`}
            {...(variant === 'bottom' ? m.bottomCard : m.card)}
          >
            {header ??
              (title != null && (
                <div className="shrink-0 flex items-start gap-3 border-b border-line p-4">
                  {icon && <div className="shrink-0 text-accent">{icon}</div>}
                  <div className="min-w-0 flex-1">
                    <h2 className="text-title truncate">{title}</h2>
                    {subtitle && (
                      <p className="text-2xs mt-0.5 font-normal tracking-normal text-ink-muted">
                        {subtitle}
                      </p>
                    )}
                  </div>
                  {onClose && (
                    <button
                      id={closeId}
                      onClick={onClose}
                      aria-label={closeLabel}
                      className="shrink-0 -m-1 rounded-ctl p-2 text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
              ))}

            <div
              className={`scroll-y min-h-0 flex-1 ${
                bodyClassName ?? 'flex flex-col gap-3 p-4'
              }`}
            >
              {children}
            </div>

            {footer && (
              <div className="shrink-0 flex items-center gap-2 border-t border-line p-3">
                {footer}
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
