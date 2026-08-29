---
name: phong-ui
description: >-
  Putting something on Phong's screen — the shared primitives, and the five cross-file rules
  that are not written near the file you would be editing. Use this whenever the work
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
then carries the five rules that bite from somewhere else entirely, which are the ones that have
actually cost shipped bugs.

## Read these three headers first

1. **`src/components/ui/index.ts`** — *"Import from here, not from the files."* `Sheet` ·
   `Button` · `Panel` · `ProgressBar` · `StatTile` · `SegmentedControl` · `RankBadge` ·
   `Pagination` · `ToastHost` · `LockBadge` · `useMotion`. The barrel is deliberately partial,
   so an absence means the primitive has not earned its API yet — not that you inline a new one.
2. **`src/components/ui/Sheet.tsx`** carries the `LAYER_BASE` bands (`:38`), the `stack`
   prop that cascades them, and the reason `backdrop: 'solid'` exists — a `backdrop-filter`
   recompositing a 60fps canvas every frame is the worst perf hazard available to this app.
   Every modal is a `Sheet`: `shrink-0` header, `scroll-y min-h-0 flex-1` body, `shrink-0`
   footer. The bands are NUMBERS rather than Tailwind class strings because a stack index is
   added to them at runtime and Tailwind cannot generate a class it never saw; a sheet given
   `stack` and covered by another scales back, dims, goes `inert`, and stops painting its
   backdrop, so only the top one paints. Pass `stack` only for a sheet App owns — a lone sheet
   leaves it undefined and behaves exactly as it always did.
3. **`src/index.css`** carries the token contract — the ink ratios (`ink-muted` 4.5:1 is the
   floor for body text, `ink-dim` 3:1 is ≥18px or decorative), `--color-xp` being *level and XP
   only*, the iOS `vh` story behind `max-h-sheet` (`:214`), and why `touch-action` sits on the
   three play surfaces rather than on `body` (`:145`).

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
it. `ToastHost` is `z-[75]`, above every `Sheet` — the bands are 50 default, 60 over, 70 gate,
plus a stacked sheet's own depth capped at four, so 74 is the ceiling — and that
is load-bearing rather than decorative — now that the notice expires on a timer, being painted
over would make it invisible for good rather than merely late.

## A ProgressBar's track is the screen

`ProgressBar`'s track is `bg-surface-1`, and `--color-surface-1` is *the screen background*
(`src/index.css:51`). Drop a bar straight onto a screen and it renders as a fill with no track —
you see the amber, you never see how far it has to go. It needs a card under it: the XP meter in
the menu header carries its own `bg-surface-2` chip, and the rank meter is fine because it sits
inside the `bg-surface-2` capsule. The rank ring hit the same thing from the other side — its
`stroke-line` track against a `bg-surface-3` raised `Panel` — and was reported as "the meter has
no ring at all".

**A chip's own padding is where header slack comes from, not the gaps.** The menu capsule
stacks a label row and two meters inside the 30px its avatar sets, and the header is already
flush with the `pt-safe-bar` offset the toast stack clears it by. The first three-row build
stood at 60.09px against 60 — sub-pixel, invisible, and caused entirely by a `py-0.5` on the
tier chip. `TierBadge` grew an `xs` size to spend it. Do not buy that back from the gaps
between meters: two 4px bars need the 2px between them to read as two.

**A resume key names one meter and one BAND.** `resumeKey` makes a bar animate from where it last
stood rather than from empty, which is what a meter outside the pager needs: `MainMenu` unmounts
for the whole of a match, so the bar that comes back is a fresh mount. The key must carry the band
(`menu-xp:{level}`, `rank:{tier}`) because a level-up drops the fraction from 0.95 to 0.05 —
resumed from the old band, gaining a level animates as a long slide leftward. And two bars mounted
at once must never share a key: each would write the other's origin. The store is
`src/components/ui/meterMemory.ts`, pure and held by `tests/meterMemory.test.ts` — and it is
module scope, so it outlives an identity swap the way `carryRef` and the on-device match
queue do. `App.startFreshIdentity` calls `resetMeterMemory()` beside those two, or a brand
new account (level 1, unplaced — the ordinary case) inherits the previous player's bands and
watches its placement meter slide DOWN from their 4/5.

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

## Colour follows the equipped cosmetic, and a literal does not

`cosmeticVars()` republishes every `--color-*` per cosmetic, so `bg-surface-2` follows what the
player equipped — including inside `PublicProfileModal`, which paints in somebody ELSE's.
- **A new token needs an entry in `cosmeticVars` too.** Without it, correct for the default
  cosmetic and wrong for the other nineteen.
- **A literal palette class follows nothing.** `text-zinc-300` is off-palette on a dark cosmetic
  and *invisible* on a light one: use a token, or `cos-light:` where the hue is the point.
- **Never define a token in terms of another.** Custom properties are substituted where declared,
  so it resolves against `:root` once and never follows an override.

## Verifying, in a repo that bet against component tests

```bash
npm run build && node scripts/e2e-run.mjs rules split achievements
npx vitest run tests/cosmetics.test.ts
```

TESTING.md §1 is explicit that there is no jsdom, no testing-library and no component tests, and
that this is a choice — *do not add a component-test framework to chase a coverage number*. So the
only layout assertion in the repo is in `scripts/e2e-rules.mjs`: it measures `#menu-start-solo`
against the viewport, confirms `elementFromPoint` lands on it, and asserts no `[id^="room-"]` row
is clipped. Its own comment warns that a selector matching nothing passes vacuously — so if you
extend it, check your selector matches something before you trust the green.
