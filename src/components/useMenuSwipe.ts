import React, { useCallback, useEffect, useRef } from 'react';
import {
  SWIPE_VELOCITY_STALE_MS,
  SwipeIntent,
  pageSettle,
  swipeIntent,
  wrapIndex,
} from '../gestures';
import { DURATION } from './ui/motion';

/**
 * The menu pager's drag.
 *
 * `src/gestures.ts` decides what a drag MEANS; this does the bookkeeping, in
 * the shape `CourtCanvas` established: refs rather than state for anything the
 * pointer touches, `e.pointerId` as identity, and a terminal action that fires
 * on `pointerup` and never on `pointercancel`.
 *
 * Three things here are not obvious and each was a real defect in the first
 * design:
 *
 *  - **Capture on the move that resolves horizontal, never on `pointerdown`.**
 *    With a capture active at `pointerup`, Chromium dispatches the following
 *    `click` to the CAPTURING element rather than the one under the finger. A
 *    pager that captures every touch therefore breaks `onClick` on every button
 *    inside it — the room rows, the mission cards, the building strip — and it
 *    reads as "the menu stopped responding", not as a pager bug. (CourtCanvas
 *    captures on down safely only because it is a `touch-none` canvas with no
 *    competing scroller and no inner button to click. That reason does not
 *    transfer.)
 *  - **The transform is written imperatively.** Five heavy page subtrees
 *    re-rendering per `pointermove` at 120Hz is not something a mid-range phone
 *    holds, and `motion.ts` is explicit that this app animates transform and
 *    opacity on the compositor and nothing else.
 *  - **`current` is held until the settle animation ends.** The window is
 *    `[prev, current, next]`, so committing the index re-seats every slot; do
 *    that while a transition is running and the pages animate ACROSS the strip,
 *    which is the classic "carousel snaps backwards through every page".
 */

/**
 * Anything whose own horizontal drag beats the pager's.
 *
 * Marked explicitly with `data-swipe="off"` rather than inferred from a role:
 * `[role="tablist"]` looks like the right shorthand and is not, because
 * `#menu-buildings` is a three-column GRID that scrolls nowhere — opting it out
 * would make a large part of the PLAY page unswipeable to protect a drag that
 * does not exist. The strips that really do scroll sideways say so themselves.
 */
const SWIPE_OPT_OUT = '[data-swipe="off"], input[type="range"], select, textarea';

interface Options {
  /** How many pages the loop has. */
  count: number;
  /** The page showing now. */
  index: number;
  /** Called once the settle animation has finished, with the new index. */
  onCommit: (next: number) => void;
  /** Collapse the settle animation to nothing. */
  reduced: boolean;
}

export function useMenuSwipe({ count, index, onCommit, reduced }: Options) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  /**
   * Whether a drag currently owns the pager. STATE, unlike everything else
   * here, because it has to reach the DOM — a suite cannot otherwise tell a
   * cancel that was correctly ignored from one that never engaged, and that
   * distinction is the difference between a test and a vacuous one. Set once
   * per gesture on claim, cleared once on release: no render per move.
   */
  const [dragging, setDragging] = React.useState(false);

  /** The one pointer driving this drag. A second is ignored outright. */
  const idRef = useRef<number | null>(null);
  const startRef = useRef({ x: 0, y: 0 });
  /** A short trail of {t, x}, so velocity is a window rather than two samples. */
  const trailRef = useRef<{ t: number; x: number }[]>([]);
  /** Latched: a gesture read as vertical must never become horizontal. */
  const intentRef = useRef<SwipeIntent>('none');
  /** True once the pager owns the gesture — read by the click suppressor. */
  const claimedRef = useRef(false);
  /** Read once at claim: a per-move layout read is 120 reflows a second. */
  const widthRef = useRef(0);
  const commitTimerRef = useRef<number | null>(null);
  const indexRef = useRef(index);
  indexRef.current = index;

  /** Resting is `-100%`: slot 1 of [prev, current, next] is the one on screen. */
  const paint = useCallback(
    (px: number, animate: boolean) => {
      const el = trackRef.current;
      if (!el) return;
      el.style.transition =
        animate && !reduced ? `transform ${DURATION.enter}s var(--ease-quick)` : 'none';
      el.style.transform = `translate3d(calc(-100% + ${px}px), 0, 0)`;
    },
    [reduced]
  );

  // The window re-seats on every index change, so resting has to be re-asserted
  // with transitions OFF — otherwise the new slot 1 slides in from wherever the
  // old one left the track.
  useEffect(() => {
    paint(0, false);
  }, [index, paint]);

  const clearCommitTimer = () => {
    if (commitTimerRef.current !== null) {
      window.clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
  };

  /** Forget the drag without committing anything. Safe to call twice. */
  const abort = useCallback(() => {
    if (idRef.current === null) return;
    idRef.current = null;
    intentRef.current = 'none';
    trailRef.current = [];
    setDragging(false);
    paint(0, true);
    // `claimed` outlives this by one tick so the click suppressor below still
    // sees it: the click that follows a released drag has not fired yet.
    window.setTimeout(() => {
      claimedRef.current = false;
    }, 0);
  }, [paint]);

  // The gestures that end with NEITHER pointerup nor pointercancel: iOS
  // backgrounding mid-touch, the app switcher, a tab change — and, in this app
  // specifically, the invitation flow's `intent://` hand-off to another browser.
  // Without these the pager stays parked wherever the finger left it.
  useEffect(() => {
    const bail = () => {
      if (document.visibilityState !== 'visible') abort();
    };
    document.addEventListener('visibilitychange', bail);
    window.addEventListener('pagehide', abort);
    return () => {
      document.removeEventListener('visibilitychange', bail);
      window.removeEventListener('pagehide', abort);
      clearCommitTimer();
    };
  }, [abort]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (idRef.current !== null) return; // one pointer owns the drag
    if ((e.target as HTMLElement).closest?.(SWIPE_OPT_OUT)) return;
    clearCommitTimer();
    idRef.current = e.pointerId;
    startRef.current = { x: e.clientX, y: e.clientY };
    trailRef.current = [{ t: e.timeStamp, x: e.clientX }];
    intentRef.current = 'none';
    claimedRef.current = false;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (idRef.current !== e.pointerId) return;

    // Evaluate the lock on the EARLIEST sample that crosses the threshold, not
    // on where the batch ended. A busy main thread coalesces moves, so a first
    // event can arrive 40px out, and a fast diagonal then mis-locks.
    if (intentRef.current === 'none') {
      const native = e.nativeEvent as PointerEvent & {
        getCoalescedEvents?: () => PointerEvent[];
      };
      // `?? [native]` is NOT enough: getCoalescedEvents returns an EMPTY ARRAY
      // for an event that coalesced nothing, and `[]` is not nullish, so the
      // fallback never fires and the loop below iterates over nothing — the
      // axis never locks and the whole gesture is dead. Measured exactly that
      // way through CDP touch, which is how `e2e-menu` caught it.
      const coalesced = native.getCoalescedEvents?.() ?? [];
      const samples = coalesced.length > 0 ? coalesced : [native];
      for (const s of samples) {
        const verdict = swipeIntent(s.clientX - startRef.current.x, s.clientY - startRef.current.y);
        if (verdict !== 'none') {
          intentRef.current = verdict;
          break;
        }
      }
      if (intentRef.current === 'horizontal') {
        claimedRef.current = true;
        setDragging(true);
        widthRef.current = trackRef.current?.getBoundingClientRect().width ?? 0;
        // MOUSE ONLY, and this is the subtle one.
        //
        // A touch pointer is IMPLICITLY captured to the element it went down
        // on, and that element is inside the pager, so its moves already bubble
        // here — capture buys nothing. What it costs is the gesture: taking
        // capture TRANSFERS it, which fires `lostpointercapture` on the element
        // that had it, and that bubbles straight back into the handler below,
        // which tears the drag down on the very move that claimed it.
        //
        // A mouse has no implicit capture, so it does need this to keep
        // receiving moves once the cursor leaves the pager — and it is exactly
        // why every mouse-driven leg of e2e-menu passed while every real finger
        // would have failed. Capture on the claim, never on `pointerdown`,
        // which would retarget the following click to the pager.
        if (e.pointerType === 'mouse') {
          try {
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          } catch {}
        }
      }
    }
    if (intentRef.current !== 'horizontal') return;

    trailRef.current.push({ t: e.timeStamp, x: e.clientX });
    if (trailRef.current.length > 12) trailRef.current.shift();
    paint(e.clientX - startRef.current.x, false);
  };

  /**
   * px/ms over a ~100ms window, from the event's own timestamps.
   *
   * Not the last two samples: fingers decelerate and roll before they lift, so
   * the final pair of a genuinely fast flick very often reads near zero or
   * reverses sign — the velocity branch would then almost never fire and the
   * pager would silently degrade to distance alone. `e.timeStamp` rather than
   * `performance.now()` because the latter is when the main thread got around
   * to the handler, which with a render loop running is exactly the noise.
   */
  const velocity = () => {
    const trail = trailRef.current;
    if (trail.length < 2) return 0;
    const last = trail[trail.length - 1];
    const old = trail.find((s) => last.t - s.t <= SWIPE_VELOCITY_STALE_MS) ?? trail[0];
    const dt = last.t - old.t;
    if (dt <= 0) return 0;
    return (last.x - old.x) / dt;
  };

  /**
   * A lifted finger settles onto a page; a CANCELLED one never does.
   *
   * `pointercancel` is the browser saying it took the gesture — a vertical pan
   * winning, an iOS edge back-swipe, a notification shade. Sharing one handler
   * is how a pulled-down shade once fired a serve in CourtCanvas, and here it
   * would be a menu that turns its own page while the player is reading a
   * notification. The settle is decided from a snapshot before the refs clear.
   */
  const release = (e: React.PointerEvent, settle: boolean) => {
    if (idRef.current !== e.pointerId) return;
    const horizontal = intentRef.current === 'horizontal';
    const dx = e.clientX - startRef.current.x;
    const v = velocity();
    const width = widthRef.current;

    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}

    if (!settle || !horizontal) {
      abort();
      return;
    }

    const delta = pageSettle(dx, width, v);
    idRef.current = null;
    setDragging(false);
    intentRef.current = 'none';
    trailRef.current = [];

    paint(delta * -width, true);
    // A timer rather than `transitionend`: a zero-duration transition (reduced
    // motion) never fires that event, and the commit would simply never happen.
    commitTimerRef.current = window.setTimeout(
      () => {
        commitTimerRef.current = null;
        claimedRef.current = false;
        if (delta !== 0) onCommit(wrapIndex(indexRef.current + delta, count));
        else paint(0, false);
      },
      reduced ? 0 : DURATION.enter * 1000
    );
  };

  return {
    trackRef,
    dragging,
    /** Spread onto the pager AND the tab bar — same drag, two surfaces. */
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: (e: React.PointerEvent) => release(e, true),
      onPointerCancel: (e: React.PointerEvent) => release(e, false),
      // Only a loss of OUR pointer, and only while we still own it.
      //
      // A touch pointer is IMPLICITLY captured to the element it went down on,
      // so `setPointerCapture` on the pager TRANSFERS it — which fires
      // `lostpointercapture` on that original element, and it bubbles to here.
      // An unguarded abort therefore kills the drag on the very move that
      // claimed it, and only for touch: a mouse has no implicit capture, so
      // every mouse-driven test passes while every real finger fails.
      onLostPointerCapture: (e: React.PointerEvent) => {
        if (e.pointerId === idRef.current) abort();
      },
      // One guard for every button on every page: React dispatches capture
      // root-to-target, so stopping here prevents the target's own onClick. A
      // drag that begins on a room row must not also open that room.
      onClickCapture: (e: React.MouseEvent) => {
        if (!claimedRef.current) return;
        e.preventDefault();
        e.stopPropagation();
      },
    },
  };
}
