import { describe, expect, it } from 'vitest';
import {
  SWIPE_AXIS_RATIO,
  SWIPE_CLAIM_PX,
  SWIPE_COMMIT_FRACTION,
  SWIPE_FLING_VW_PER_S,
  pageSettle,
  swipeIntent,
  wrapIndex,
} from '../src/gestures';

/**
 * The swipe rules, stated here because the browser cannot state them.
 *
 * `touch-action` is enforced by the compositor hit-test and CDP's
 * `Input.dispatchTouchEvent` injects downstream of it — measured: it scrolls a
 * `touch-action: none` element 348px. So a Playwright suite can prove the wiring
 * (a drag reaches `pageSettle`, its answer reaches the pager) and it can NOT
 * prove that the browser ceded the gesture. Everything below is therefore the
 * only place these thresholds are asserted at all.
 */

const WIDTH = 390; // a small phone, so the fractions land on awkward numbers

/** Below the fling threshold, so distance is the only thing deciding. */
const SLOW = 0;

describe('swipeIntent', () => {
  it('is undecided until a drag clears the claim distance', () => {
    expect(swipeIntent(0, 0)).toBe('none');
    expect(swipeIntent(SWIPE_CLAIM_PX, 0)).toBe('none');
    expect(swipeIntent(0, SWIPE_CLAIM_PX)).toBe('none');
    expect(swipeIntent(SWIPE_CLAIM_PX + 1, 0)).toBe('horizontal');
    expect(swipeIntent(0, SWIPE_CLAIM_PX + 1)).toBe('vertical');
  });

  it('does NOT condemn a slow horizontal drag on its first few pixels', () => {
    // The bug this exists for: "|dx| > |dy|, else vertical" evaluated on the
    // first move marks dx=2,dy=3 vertical for the life of the pointer, so a
    // careful sideways drag never moves the page however far it goes.
    expect(swipeIntent(2, 3)).toBe('none');
    expect(swipeIntent(4, 5)).toBe('none');
    // ...and the same gesture, once it has actually committed to an axis:
    expect(swipeIntent(40, 5)).toBe('horizontal');
  });

  it('claims horizontally only past the axis ratio, not at a bare 45 degrees', () => {
    const dy = 30;
    const shallow = dy * SWIPE_AXIS_RATIO - 1; // inside 45°, outside our cone
    const steep = dy * SWIPE_AXIS_RATIO + 1;
    expect(shallow).toBeGreaterThan(dy); // a bare |dx|>|dy| would have claimed it
    expect(swipeIntent(shallow, dy)).toBe('vertical');
    expect(swipeIntent(steep, dy)).toBe('horizontal');
  });

  it('claims a strongly horizontal drag that carries a little vertical drift', () => {
    // The regression this pins: testing vertical FIRST and unconditionally
    // makes anything past the claim distance on dy vertical however sideways it
    // is, so a real thumb — which never travels perfectly straight — could
    // never turn a page. Vertical is the cheap error, but the RATIO is what
    // buys it, not the order of the checks.
    expect(swipeIntent(200, 13)).toBe('horizontal');
    expect(swipeIntent(-200, -13)).toBe('horizontal');
  });

  it('reads an ambiguous fast diagonal as vertical, because ceding is the cheap error', () => {
    // A coalesced first move can arrive at 40px on a busy main thread. Both
    // axes are past the claim distance here; the browser is the other claimant
    // for vertical, so it wins the tie.
    expect(swipeIntent(40, 35)).toBe('vertical');
  });

  it('is symmetric in both directions on both axes', () => {
    expect(swipeIntent(-40, 5)).toBe('horizontal');
    expect(swipeIntent(5, -40)).toBe('vertical');
  });
});

describe('pageSettle — the sign convention', () => {
  it('sends a finger moving LEFT forward, and one moving RIGHT back', () => {
    // offsetPx is current-minus-start, so leftward is negative, and the next
    // page follows the finger in from the right. Inverting this is the single
    // easiest mistake available here.
    const far = WIDTH * (SWIPE_COMMIT_FRACTION + 0.05);
    expect(pageSettle(-far, WIDTH, SLOW)).toBe(1);
    expect(pageSettle(far, WIDTH, SLOW)).toBe(-1);
  });
});

describe('pageSettle — distance', () => {
  it('commits at the threshold and stays put just under it', () => {
    const at = WIDTH * SWIPE_COMMIT_FRACTION;
    expect(pageSettle(-at, WIDTH, SLOW)).toBe(1);
    expect(pageSettle(-(at - 1), WIDTH, SLOW)).toBe(0);
    expect(pageSettle(at, WIDTH, SLOW)).toBe(-1);
    expect(pageSettle(at - 1, WIDTH, SLOW)).toBe(0);
  });

  it('measures the threshold against the container, not against pixels', () => {
    // The same absolute drag decides differently on two screen widths, which is
    // the whole point of the fraction.
    const drag = 300 * SWIPE_COMMIT_FRACTION + 1;
    expect(pageSettle(-drag, 300, SLOW)).toBe(1);
    expect(pageSettle(-drag, 1200, SLOW)).toBe(0);
  });
});

describe('pageSettle — the fling', () => {
  /** Signed px/ms that clears the viewport-relative fling threshold. */
  const fling = (width: number, sign: -1 | 1) =>
    (sign * (SWIPE_FLING_VW_PER_S * width)) / 1000;

  it('commits on a flick that distance alone would not have committed', () => {
    const tiny = -1; // one pixel left: nowhere near the distance threshold
    expect(pageSettle(tiny, WIDTH, SLOW)).toBe(0);
    expect(pageSettle(tiny, WIDTH, fling(WIDTH, -1))).toBe(1);
  });

  it('is viewport-relative, so the same px/ms decides differently by width', () => {
    const v = fling(390, -1); // enough on a small phone
    expect(pageSettle(-1, 390, v)).toBe(1);
    expect(pageSettle(-1, 1200, v)).toBe(0); // same speed, bigger screen, not a fling
  });

  it('puts the page back when the flick disagrees with the drag', () => {
    // Dragged well past the commit distance, then flicked back: that is a
    // player changing their mind, and it outranks the distance.
    const far = -WIDTH * (SWIPE_COMMIT_FRACTION + 0.1);
    expect(pageSettle(far, WIDTH, SLOW)).toBe(1);
    expect(pageSettle(far, WIDTH, fling(WIDTH, 1))).toBe(0);
  });

  it('does not fling on a velocity just under the threshold', () => {
    const justUnder = fling(WIDTH, -1) * 0.99;
    expect(pageSettle(-1, WIDTH, justUnder)).toBe(0);
  });
});

describe('pageSettle — guards', () => {
  it('settles on 0 rather than dividing by a zero or absent width', () => {
    expect(pageSettle(-200, 0, SLOW)).toBe(0);
    expect(pageSettle(-200, -5, SLOW)).toBe(0);
    expect(pageSettle(-200, NaN, SLOW)).toBe(0);
  });

  it('treats a non-finite velocity as no velocity rather than as a fling', () => {
    // A dt of zero between two samples is an easy way to produce Infinity, and
    // it must not read as an infinitely fast flick.
    expect(pageSettle(-1, WIDTH, Infinity)).toBe(0);
    expect(pageSettle(-1, WIDTH, NaN)).toBe(0);
  });

  it('stays put on a drag that never moved', () => {
    expect(pageSettle(0, WIDTH, SLOW)).toBe(0);
    expect(pageSettle(NaN, WIDTH, SLOW)).toBe(0);
  });
});

describe('wrapIndex', () => {
  it('closes the loop in both directions', () => {
    expect(wrapIndex(-1, 5)).toBe(4);
    expect(wrapIndex(5, 5)).toBe(0);
    expect(wrapIndex(0, 5)).toBe(0);
    expect(wrapIndex(4, 5)).toBe(4);
  });

  it('wraps a long way round without a loop', () => {
    expect(wrapIndex(-7, 5)).toBe(3);
    expect(wrapIndex(12, 5)).toBe(2);
  });

  it('has no valid index for an empty strip', () => {
    expect(wrapIndex(3, 0)).toBe(0);
    expect(wrapIndex(3, -1)).toBe(0);
    expect(wrapIndex(NaN, 5)).toBe(0);
  });
});
