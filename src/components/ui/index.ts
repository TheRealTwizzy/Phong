// The shell's shared primitives. Import from here, not from the files.
//
// Deliberately partial: QrBlock and the toast host land with the phases that
// consume them, rather than sitting here untested with an API guessed ahead
// of its call sites.

export { Sheet, type SheetProps } from './Sheet';
export { Button, type ButtonProps } from './Button';
export { Panel, type PanelProps } from './Panel';
export { ProgressBar, type ProgressBarProps } from './ProgressBar';
export { StatTile, type StatTileProps } from './StatTile';
export {
  SegmentedControl,
  type SegmentOption,
  type SegmentedControlProps,
} from './SegmentedControl';
export { RankBadge, type RankBadgeProps } from './RankBadge';
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
