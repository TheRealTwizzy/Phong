import React, { useEffect, useRef } from 'react';
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

// Bands rather than rungs, because a stack has a depth and Tailwind cannot
// generate a runtime z-index from one.
//
// Depth cannot be left to DOM order: two elements at the same z paint in
// document order, so the sheet written later in App wins — which is not the one
// the player opened last. That is the same trap the theme-unlock toast fell
// into (see phong-ui), one level up.
//
// The cap is FIVE per band, not an arbitrary headroom number: the binding
// constraint is that the top of the `gate` band must stay under `ToastHost` at
// 75, so `gate` may reach 74 and no further. App's stack is five sheets, which
// fits exactly. A sixth would clamp two of them onto one z and hand the
// decision back to DOM order — so a deeper stack means RE-SPACING the bands
// (and the toast above them), never raising this cap.
const LAYER_BASE = {
  default: 50,
  over: 60, // sits over another sheet (public profile, quit confirm)
  gate: 70, // unclosable gates (onboarding)
} as const;
const STACK_MAX = 4;

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
  layer?: keyof typeof LAYER_BASE;
  /**
   * Where this sheet sits in the open-sheet stack, when there is one.
   *
   * `index` is 0 at the bottom, `count` is how many are open. Absent means a
   * lone sheet, which is every sheet not owned by App's stack. A covered sheet
   * is pushed back rather than offset — it scales down and dims in place, so
   * it reads as depth without an offset card running off a narrow phone.
   */
  stack?: { index: number; count: number };
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
  stack,
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
  // How many sheets sit on top of this one. Capped at two steps of depth, or a
  // third sheet would push the first one to nothing.
  const above = stack ? Math.max(0, stack.count - 1 - stack.index) : 0;
  const covered = above > 0;
  const depth = Math.min(above, 2);
  const zIndex = LAYER_BASE[layer] + Math.min(stack?.index ?? 0, STACK_MAX);
  // Only the top sheet dismisses on its scrim, and only the top sheet PAINTS
  // one: two stacked `bg-surface-0/80 backdrop-blur-md` layers is double dim
  // and double blur, and the result reads as mud rather than as a cascade. The
  // top sheet's scrim already covers the screen for all of them.
  const canDismiss = Boolean(onClose) && dismissOnBackdrop && !covered;
  const cardMotion = variant === 'bottom' ? m.bottomCard : m.card;

  /**
   * The three things `aria-modal="true"` promises and this component did not
   * do: Escape closes it, focus moves into it, and focus goes back where it
   * came from. There was no `keydown` handler anywhere in `src/`, so the
   * attribute was a claim with nothing behind it.
   *
   * Only the TOP sheet, on all three counts — a covered sheet is already
   * `inert`, and a stack where Escape closed the bottom one would leave the
   * top one floating over nothing.
   */
  const cardRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<Element | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!isOpen || covered) return;
    returnFocusRef.current = document.activeElement;
    // Focus the card itself rather than its first control: a sheet opens to be
    // READ, and jumping a screen reader to the close button skips the title.
    cardRef.current?.focus({ preventScroll: true });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!closeRef.current || !dismissOnBackdrop) return;
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      // `aria-modal="true"` promises the rest of the page is not there, and
      // moving focus onto the card does not deliver that on its own: the page
      // behind the backdrop stays focusable, so Tab walked straight out of the
      // sheet into controls the player cannot see and could then activate. The
      // covered sheets below are already `inert`; what was missing was the
      // application behind ALL of them, which this sheet cannot mark without
      // reaching outside itself — so the focus is kept in instead.
      const card = cardRef.current;
      if (!card) return;
      const focusable = Array.from(
        card.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      // Nothing to land on: hold focus on the card rather than letting Tab
      // escape a sheet that is only text.
      if (focusable.length === 0) {
        e.preventDefault();
        card.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!e.shiftKey && (active === last || !card.contains(active))) {
        e.preventDefault();
        first.focus({ preventScroll: true });
      } else if (e.shiftKey && (active === first || active === card || !card.contains(active))) {
        e.preventDefault();
        last.focus({ preventScroll: true });
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const back = returnFocusRef.current;
      // Restored only if it is still in the document and still focusable —
      // a sheet that closes because the thing that opened it went away must
      // not throw on the way out.
      if (back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
    };
  }, [isOpen, covered, dismissOnBackdrop]);

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          id={id}
          style={{ zIndex }}
          inert={covered}
          className={`fixed inset-0 flex ${
            variant === 'bottom' ? 'items-end' : 'items-center'
          } justify-center p-4 pt-safe pb-safe ${
            covered
              ? ''
              : backdrop === 'blur'
                ? 'bg-surface-0/80 backdrop-blur-md'
                : 'bg-surface-0/94'
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
            ref={cardRef}
            role="dialog"
            aria-modal="true"
            // Focusable as a container so focus can be MOVED here on open
            // without landing on a control; -1 keeps it out of the tab order.
            tabIndex={-1}
            className={`w-full ${SIZE[size]} max-h-sheet flex flex-col overflow-hidden rounded-sheet border ${ACCENT[accent]} bg-surface-2 text-ink shadow-sheet ${cardClassName}`}
            {...cardMotion}
            // Transform and opacity only — motion.ts is explicit that nothing
            // here animates width, height, filter or shadow. Closing the top
            // sheet animates the one beneath from `covered` back to rest, and
            // THAT animation is the reveal: no extra machinery.
            animate={
              covered
                ? { ...(cardMotion.animate as object), scale: 1 - depth * 0.03, opacity: 0.72 }
                : cardMotion.animate
            }
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
