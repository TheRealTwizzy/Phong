import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { LanguageCode } from '../types';
import { t } from '../i18n/translations';
import { Button } from './ui';
import { TourStep } from '../game/tour';

// The onboarding tour's chrome: a hole cut in a scrim, and a card beside it.
//
// NOT a Sheet. A Sheet covers what it is talking about, and this is a tour of
// a live product — the point is that the thing being explained is the real
// thing, on screen, still working. What it replaced was a four-slide deck of
// CSS dioramas plus a mini court that re-implemented physics inline, taught
// none of the actual game, was never shown to a new player, and promised
// "+50 XP" that no code anywhere awarded.
//
// Two properties the rest of it depends on:
//
//   - the scrim is pointer-events:none and only the CARD takes input, so a
//     step can point at a control the player is meant to actually use;
//   - the anchor is measured by polling rather than once, because half of
//     what it points at is inside a sheet that is still animating open, and a
//     rect measured on mount would be the rect of something mid-flight.

const PAD = 8;
const CARD_GAP = 12;
const POLL_MS = 120;

export interface OnboardingTourProps {
  isOpen: boolean;
  step: TourStep | null;
  index: number;
  total: number;
  language: LanguageCode;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const measure = (anchor?: string): Rect | null => {
  if (!anchor) return null;
  const el = document.getElementById(anchor);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  return { top: r.top, left: r.left, width: r.width, height: r.height };
};

const same = (a: Rect | null, b: Rect | null): boolean => {
  if (!a || !b) return a === b;
  return (
    Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
};

export const OnboardingTour: React.FC<OnboardingTourProps> = ({
  isOpen,
  step,
  index,
  total,
  language,
  onBack,
  onNext,
  onSkip,
}) => {
  const [rect, setRect] = useState<Rect | null>(null);

  // Polled, not measured once: an anchor inside a sheet that is animating open
  // has a rect that is still moving, and the spotlight would settle on where
  // it was rather than where it is.
  useEffect(() => {
    if (!isOpen || !step) {
      setRect(null);
      return;
    }
    let raf = 0;
    const tick = () => {
      setRect((prev) => {
        const next = measure(step.anchor);
        return same(prev, next) ? prev : next;
      });
      raf = window.setTimeout(tick, POLL_MS);
    };
    tick();
    return () => window.clearTimeout(raf);
  }, [isOpen, step]);

  if (!step) return null;

  const hole = rect
    ? {
        top: Math.max(0, rect.top - PAD),
        left: Math.max(0, rect.left - PAD),
        width: rect.width + PAD * 2,
        height: rect.height + PAD * 2,
      }
    : null;

  // Pinned to whichever END of the screen the spotlight is not at, rather
  // than floated next to it. Floating was tried and put the card off-screen
  // for anything low down: the card's height is not known before it renders,
  // so "just below the hole" has no way to check it still fits. Pinning needs
  // no measurement, never covers the hole, and never leaves the viewport.
  const viewportH = typeof window === 'undefined' ? 800 : window.innerHeight;
  const holeCentre = hole ? hole.top + hole.height / 2 : viewportH / 2;
  const pinBottom = !hole || holeCentre < viewportH * 0.55;

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          id="onboarding-tour-overlay"
          className="pointer-events-none fixed inset-0 z-[80]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          {/* The scrim, with the anchor punched out of it. An SVG mask rather
              than four divs around the hole: the rounded corners and the ring
              have to agree, and four boxes never quite do. */}
          <svg className="absolute inset-0 h-full w-full" aria-hidden="true">
            <defs>
              <mask id="tour-hole-mask">
                <rect x="0" y="0" width="100%" height="100%" fill="white" />
                {hole && (
                  <rect
                    x={hole.left}
                    y={hole.top}
                    width={hole.width}
                    height={hole.height}
                    rx="12"
                    fill="black"
                  />
                )}
              </mask>
            </defs>
            <rect
              x="0"
              y="0"
              width="100%"
              height="100%"
              className="fill-surface-0/82"
              mask="url(#tour-hole-mask)"
            />
            {hole && (
              <rect
                x={hole.left}
                y={hole.top}
                width={hole.width}
                height={hole.height}
                rx="12"
                fill="none"
                strokeWidth="2"
                className="stroke-accent"
              />
            )}
          </svg>

          <motion.div
            key={step.id}
            id="onboarding-tour-card"
            className="pointer-events-auto absolute right-3 left-3 rounded-sheet border border-accent/40 bg-surface-2 p-4 text-ink shadow-sheet"
            style={pinBottom ? { bottom: CARD_GAP } : { top: CARD_GAP }}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18 }}
          >
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-kicker text-accent uppercase">
                  {t('tour_progress', language, {
                    step: String(index + 1),
                    total: String(total),
                  })}
                </div>
                <h2 className="text-title mt-1">{t(step.titleKey, language)}</h2>
              </div>
              <button
                id="btn-tour-skip"
                onClick={onSkip}
                aria-label={t('tour_skip', language)}
                className="shrink-0 -m-1 rounded-ctl p-2 text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <p className="mt-2 text-2xs leading-relaxed font-normal tracking-normal text-ink-muted">
              {t(step.bodyKey, language)}
            </p>

            <div className="mt-4 flex items-center gap-2">
              <Button
                id="btn-tour-back"
                variant="secondary"
                disabled={index === 0}
                icon={<ChevronLeft className="h-3.5 w-3.5" />}
                onClick={onBack}
              >
                {t('tour_back', language)}
              </Button>
              <span className="flex-1" />
              <Button
                id="btn-tour-next"
                variant="primary"
                icon={<ChevronRight className="h-3.5 w-3.5" />}
                onClick={onNext}
              >
                {index === total - 1 ? t('tour_finish', language) : t('tour_next', language)}
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
