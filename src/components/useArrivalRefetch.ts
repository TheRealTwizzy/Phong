import { useEffect, useRef } from 'react';

/**
 * Run `onArrive` each time `isCurrent` goes false → true.
 *
 * The menu pager mounts three slots — `prev`, `current`, `next` — so a page
 * inside that window stays MOUNTED once it has been a neighbour. Every one of
 * these pages fetches from an effect that fires on mount and on its own
 * filters, and nothing else, so the fetch happened the moment the page became
 * a NEIGHBOUR and never again: leave the menu on PLAY, swipe to RANKS ten
 * minutes later, and the board is the snapshot taken when RANKS first slid
 * into the window. TROPHIES and HISTORY had it identically.
 *
 * The obvious remedy — gate the fetch on being current — is worse than the
 * bug. The incoming page is not current until the settle, so a drag toward
 * RANKS would slide an empty panel in and fill it after the animation
 * finished. The mount-time fetch for a page one swipe away is what makes a
 * dragged-to page show content instead of a spinner, and it is deliberately
 * kept: this is an ARRIVAL on top of it, not a replacement for it.
 *
 * Three of these effects, written out three times, is exactly the duplication
 * CLAUDE.md keeps warning about (the relay and the P2P replica), so it is one
 * hook that three pages call.
 *
 * Two details that are not decoration:
 *
 *  - **Compare the previous VALUE, never count runs.** `src/main.tsx` renders
 *    under `StrictMode`, so an effect runs setup → cleanup → setup on mount.
 *    The obvious `const first = useRef(true); if (first.current) {
 *    first.current = false; return; }` guard is SPENT by the first setup and
 *    fires on the second — a double fetch on every mount, in dev only, where
 *    nobody would look. Seeding `was` with `isCurrent` makes a mount a
 *    non-transition under both invocations, whatever the page mounted as.
 *  - **The callback is read through a ref.** App rebuilds every callback it
 *    passes on every render (convention §14), so listing `onArrive` in the
 *    deps would re-run this effect constantly — and while a ball is in play
 *    App re-renders once per animation frame.
 */
export function useArrivalRefetch(
  isCurrent: boolean,
  onArrive: () => void,
  /**
   * Treat mounting ALREADY current as an arrival. Off by default, because a
   * page that mounts current has just run its own fetch effect and a second
   * one would be a duplicate — the pager only mounts a page current when a tab
   * tap jumps to it from outside the three-slot window.
   *
   * On for a caller that has no mount fetch of its own to lean on. RanksPage
   * refreshes two things on arrival: its board, which fetched itself on mount,
   * and the PROFILE behind the header capsule, which nothing else fetches at
   * all. Same arrival, opposite answer to "did the mount already cover this",
   * so the flag is the difference rather than two hooks.
   */
  alsoOnMount = false
) {
  // `false` makes the first effect run a transition, so a mount-while-current
  // fires exactly once — including under StrictMode, whose setup → cleanup →
  // setup sees `was` already true on the second setup. Counting runs instead
  // of comparing values is what would double here, in dev only.
  const was = useRef(alsoOnMount ? false : isCurrent);
  const cb = useRef(onArrive);
  cb.current = onArrive;

  useEffect(() => {
    const previous = was.current;
    was.current = isCurrent;
    if (isCurrent && !previous) cb.current();
  }, [isCurrent]);
}
