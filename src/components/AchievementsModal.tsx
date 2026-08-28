import React from 'react';
import { LanguageCode } from '../types';
import { Tier } from '../rating';
import { t } from '../i18n/translations';
import { AchievementsTree } from './AchievementsTree';
import { Sheet } from './ui';
import { X, Award } from 'lucide-react';

// The chrome around `AchievementsTree` — title, close, footer line — and
// nothing else. The completion meter and the branch strip moved into the tree,
// where the state they drive already lived, so the same tree renders inside
// this sheet or as the TROPHIES page without either one knowing about a branch.
//
// Consequence worth stating: those two now scroll with the rows rather than
// sitting pinned in the header. `e2e-achievements` reads `#ach-branch-*` and
// `#ach-row-*`, both unchanged and both still in the document; nothing asserts
// where on screen they sit.

interface Props {
  isOpen: boolean;
  onClose: () => void;
  playerId: string;
  /** Gates are measured against these — see ProgressContext in achievements.ts. */
  level: number;
  tier: Tier;
  language?: LanguageCode;
}

export const AchievementsModal: React.FC<Props> = ({
  isOpen,
  onClose,
  playerId,
  level,
  tier,
  language = 'en',
}) => {
  const header = (
    <div className="shrink-0 relative border-b border-line bg-gradient-to-r from-rank-steady/12 via-surface-2 to-surface-2 p-4">
      <button
        id="close-achievements-btn"
        onClick={onClose}
        aria-label={t('close', language)}
        className="absolute top-3 right-3 rounded-ctl p-2 text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink"
      >
        <X className="w-5 h-5" />
      </button>

      <div className="flex items-center gap-3">
        <div className="rounded-card border border-rank-steady/30 bg-rank-steady/10 p-2.5 text-rank-steady">
          <Award className="w-6 h-6" />
        </div>
        <div>
          <h2 className="text-title">Career Achievements</h2>
          <p className="text-2xs font-normal tracking-normal text-ink-muted">
            Unlock trophies and earn XP rewards
          </p>
        </div>
      </div>
    </div>
  );

  return (
    <Sheet
      cardId="achievements-modal-container"
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      accent="accent"
      header={header}
      footer={
        <p className="flex-1 text-center text-2xs font-normal tracking-normal text-ink-muted">
          Unlocking achievements accelerates your player level and leaderboard standing.
        </p>
      }
      bodyClassName="p-3 space-y-2.5"
    >
      <AchievementsTree
        language={language}
        playerId={playerId}
        level={level}
        tier={tier}
        active={isOpen}
      />
    </Sheet>
  );
};
