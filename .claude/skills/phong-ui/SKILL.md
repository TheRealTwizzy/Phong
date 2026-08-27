---
name: phong-ui
description: >-
  Putting something on Phong's screen — the shared primitives, and the four cross-file rules
  that are not written anywhere near the file you would be editing. Use this whenever the work
  adds or changes a component, a modal or sheet, a toast or transient notice, a scroll region,
  an overlay on the live court, or anything with a colour or a z-index, and whenever the user
  asks for a new panel, a banner, a confirmation, a settings row or a notification. There is no
  jsdom and no component tests in this repo by choice, so a layout mistake is caught only by the
  browser suites people skip: a flex child that collapses to zero height puts a Start button
  below the viewport where no gesture reaches it, and nothing goes red.
---

# Putting something on the screen

The shell has shared primitives and a semantic token system, and both document themselves well
in the file you would have open. This skill does not restate them — it points at them once, and
then carries the four rules that bite from somewhere else entirely, which are the ones that have
actually cost shipped bugs.

## Read these three headers first

1. **`src/components/ui/index.ts`** opens with the rule: *"The shell's shared primitives. Import
   from here, not from the files."* `Sheet` · `Button` · `Panel` · `ProgressBar` · `StatTile` ·
   `SegmentedControl` · `RankBadge` · `Pagination` · `ToastHost` · `LockBadge` · `useMotion`.
   Reach for one before hand-rolling; the barrel is deliberately partial, so an absence means
   the primitive has not earned its API yet, not that you should inline a new pattern.
2. **`src/components/ui/Sheet.tsx`** carries the `LAYER` map (`:30`) and the reason
   `backdrop: 'solid'` exists — a `backdrop-filter` recompositing a 60fps canvas every frame is
   the worst perf hazard available to this app. Every modal is a `Sheet`: `shrink-0` header,
   `scroll-y min-h-0 flex-1` body, `shrink-0` footer.
3. **`src/index.css`** carries the token contract with measured contrast ratios —
   `--color-ink-muted` at 6.1:1 is *the floor for body text*, `--color-ink-dim` at 3.3:1 is
   *≥18px or decorative only*, `--color-xp` is *level and XP only, never a generic highlight* —
   plus the iOS `vh` story behind `max-h-sheet` (`:214`) and why `touch-action` sits on the
   three play surfaces rather than on `body` (`:145`). The tokens are **additive by
   construction**: a `--color-*: initial` reset would silently blank the twenty-odd components
   still shipping literal palette classes, with no build error.

## A flex child with clipped overflow has a minimum size of zero

This is the one that reads as a different bug than it is. **A flex item whose `overflow` is not
`visible` has an automatic minimum size of zero**, so it squashes rather than overflowing.

The pre-match surface used to expand into the menu list as an accordion. The scroll region is a
flex column and the accordion card carried `overflow-hidden`, so nothing overflowed, nothing
scrolled, the other mode rows collapsed to ~12px slivers, and the Start button — last in a
clipped card — sat about 160px below the viewport where no gesture could reach it. *Editing a
match setting* read as *this mode cannot be started*.

**Every child of a scroll region is `shrink-0`.** That is what stops it returning.

Two smaller siblings of the same class: a `Sheet`'s `id` belongs on the fixed backdrop, because
a wrapper around a fixed element collapses to zero height and reads as hidden to Playwright; and
the footer is a flex sibling, never `position: sticky`, which would overlay the last rows and
make clicks land on the footer instead of the row underneath.

## z-index does not save you from DOM order

Two elements at the same stacking level are painted in document order, so a later sibling wins.
The theme-unlock toast sat at `z-50` and was painted over by the very Missions sheet that raised
it. `ToastHost` is `z-[75]`, above every `Sheet` layer (50 default, 60 over, 70 gate), and that
is load-bearing rather than decorative — now that the notice expires on a timer, being painted
over would make it invisible for good rather than merely late.

## A call site never arms its own timer

Convention §13: **every transient notification goes through `ToastHost`, which owns both the
timer and the tap target.** A call site supplies `ttlMs` and `onDismiss` and nothing else.

- **Never arm your own `setTimeout`.** Three call sites used to, bare and uncancelled, so
  re-raising a notice inside its window let the first timer cut the second one short.
- **A timer must never be armed by an effect that depends on the dismiss callback.** App
  rebuilds those callbacks on every render and re-renders once per animation frame while a ball
  is in play, so such an effect tears its timer down and re-arms it sixty times a second and
  never fires. That is how an achievement toast outlived its match, the winner overlay, and the
  menu after that — 15 to 30 seconds, a different number every time, since it actually expired
  4.5s after App last happened to re-render. `ToastItem` keys its effect on `[id, ttlMs]` alone
  and reads the callback through a ref (`src/components/ui/Toast.tsx:68`), so the fix holds.
- **Omitting `ttlMs` means it waits to be tapped.** `toast-record-failed` is the one entry with
  no TTL, deliberately: it reports a state that is still unresolved.
- The two exceptions are overheads, not notifications: the quick-chat bubbles and the
  match-start countdown are `pointer-events-none` so the paddle stays drivable.

## Verifying, in a repo that bet against component tests

```bash
npm run build && node scripts/e2e-run.mjs rules split achievements
npx vitest run tests/themes.test.ts
```

TESTING.md §1 is explicit that there is no jsdom, no testing-library and no component tests, and
that this is a choice — *do not add a component-test framework to chase a coverage number*. So
the only layout assertion in the repo is in `scripts/e2e-rules.mjs`: it measures
`#menu-start-solo` against the viewport, confirms `elementFromPoint` actually lands on it, and
asserts no `[id^="room-"]` row has `clientHeight < scrollHeight`. Its own comment warns that a
selector matching nothing makes the whole thing pass vacuously — so if you extend it, check that
your selector matches something before you trust the green.
