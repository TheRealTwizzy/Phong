// The shell's shared primitives. Import from here, not from the files.
//
// Deliberately partial: the toast host lands with the phases that
// consume them, rather than sitting here untested with an API guessed ahead
// of its call sites.

export { Sheet, type SheetProps } from './Sheet';
export { Button, type ButtonProps } from './Button';
export { Panel, type PanelProps } from './Panel';
export { ProgressBar, type ProgressBarProps } from './ProgressBar';
// ProgressBar's backing store. `resumeKey` is the whole surface a call
// site needs, so only the reset is re-exported — App has to empty it when
// this browser changes account (see App.startFreshIdentity).
export { resetMeterMemory } from './meterMemory';
export { StatTile, type StatTileProps } from './StatTile';
export {
  SegmentedControl,
  type SegmentOption,
  type SegmentedControlProps,
} from './SegmentedControl';
export { RankBadge, type RankBadgeProps } from './RankBadge';
export { Pagination, type PaginationProps } from './Pagination';
export { ToastHost, TOAST_TTL, type ToastSpec } from './Toast';
export {
  LockBadge,
  UnlockHintSheet,
  type LockBadgeProps,
  type UnlockHintSheetProps,
} from './LockBadge';
export {
  useMotion,
  DURATION,
  EASE_QUICK,
  EASE_EXIT,
  type MotionSet,
  type Choreography,
} from './motion';
