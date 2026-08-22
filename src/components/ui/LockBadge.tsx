import React from 'react';
import { Lock } from 'lucide-react';
import { Achievement } from '../../types';
import { Sheet } from './Sheet';

// What replaces `title={...}` on a gated control.
//
// A title attribute does not exist on touch, so on the only device this game
// runs on, every locked difficulty and match length was a dead button with no
// stated reason. The gating achievement was already available — unlockedBy()
// in achievements.ts returns the whole object — it simply had nowhere to go.
//
// The gated control itself must keep its real `disabled` attribute (the e2e
// suites read el.disabled to assert what a new player may play), and a
// disabled button fires no events. So the tap target is a SIBLING overlay
// rather than the control: the control stays honestly disabled, and the
// overlay is what the finger actually hits.

export interface LockBadgeProps {
  /** The id the suites look for, e.g. 'menu-diff-pro-lock'. */
  id?: string;
  achievement: Achievement;
  /** Omit to render the marker without making it tappable. */
  onReveal?: (achievement: Achievement) => void;
  label?: string;
}

export const LockBadge: React.FC<LockBadgeProps> = ({
  id,
  achievement,
  onReveal,
  label = 'Locked',
}) =>
  onReveal ? (
    <button
      id={id}
      type="button"
      onClick={() => onReveal(achievement)}
      aria-label={`${label} — ${achievement.title}`}
      className="absolute inset-0 flex items-start justify-end rounded-ctl p-0.5 text-locked transition-colors hover:text-ink-muted"
    >
      <Lock className="h-2.5 w-2.5" />
    </button>
  ) : (
    <Lock id={id} className="absolute top-0.5 right-0.5 h-2.5 w-2.5 text-locked" />
  );

// The reveal itself: what this is, and what opens it.
export interface UnlockHintSheetProps {
  achievement: Achievement | null;
  onClose: () => void;
  closeLabel?: string;
}

export const UnlockHintSheet: React.FC<UnlockHintSheetProps> = ({
  achievement,
  onClose,
  closeLabel,
}) => (
  <Sheet
    id="unlock-hint-sheet"
    isOpen={Boolean(achievement)}
    onClose={onClose}
    size="xs"
    layer="over"
    accent="warn"
    closeLabel={closeLabel}
    title={
      <span className="flex items-center gap-2">
        <Lock className="h-4 w-4 text-warn" />
        {achievement?.title ?? ''}
      </span>
    }
  >
    <p className="text-2xs leading-relaxed font-normal tracking-normal text-ink-muted">
      {achievement?.description}
    </p>
    {achievement != null && achievement.xpReward > 0 && (
      <span className="self-start rounded-chip border border-xp/25 bg-xp/10 px-1.5 py-0.5 text-2xs text-xp">
        +{achievement.xpReward} XP
      </span>
    )}
  </Sheet>
);
