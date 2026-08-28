import React, { useEffect, useState } from 'react';
import { GameSettings, LanguageCode, PlayerProfile } from '../types';
import { t } from '../i18n/translations';
import { SettingsPanel } from './SettingsPanel';
import { Sheet, Button } from './ui';
import { X, Sliders } from 'lucide-react';

// Device & presentation preferences only. Match settings (mode, difficulty,
// winning score) are chosen on the main menu BEFORE a match starts, and
// paddle width / ball speed are fixed constants — never editable here.
interface SettingsModalProps {
  /** Position in App's open-sheet stack; forwarded to Sheet. See Sheet's `stack`. */
  stack?: { index: number; count: number };

  isOpen: boolean;
  onClose: () => void;
  settings: GameSettings;
  onUpdateSettings: (newSettings: Partial<GameSettings>) => void;
  profile?: PlayerProfile | null;
  onTriggerShake?: () => void;
  /**
   * True while the match's rules have the opponent sonar on. The two net
   * indicators are suppressed for that match — the sonar draws the whole far
   * half anyway — so the rows show what is actually happening (off, and not
   * yours to change right now) instead of promising something that is not on
   * screen. The stored preferences are untouched and come back by themselves.
   */
  indicatorsLockedBySonar?: boolean;
  /**
   * Delete this account for good. Absent means the section is not offered —
   * from a live match, where deleting would strand an opponent in a room
   * nobody told, and for a profile with no account to delete yet.
   *
   * Resolves to the outcome rather than throwing: the flow has to be able to
   * say WHY it failed without unwinding the two steps the player just took.
   */
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  onUpdateSettings,
  profile = null,
  onTriggerShake,
  indicatorsLockedBySonar = false,
  stack,
}) => {
  const lang = settings.language || 'en';


  const header = (
    <div className="shrink-0 flex items-center justify-between gap-2 border-b border-line bg-surface-1 p-4">
      <div className="flex min-w-0 items-center gap-2.5">
        <Sliders className="h-5 w-5 text-accent" />
        <h2 className="text-title truncate">{t('settings_title', lang)}</h2>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <button
          id="btn-close-settings"
          onClick={onClose}
          aria-label={t('close', lang)}
          className="rounded-ctl p-2 text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink"
        >
          <X className="h-5 w-5" />
        </button>
      </div>
    </div>
  );

  return (
    <Sheet
      stack={stack}
      id="settings-modal-overlay"
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      accent="accent"
      header={header}
      bodyClassName="p-4 flex flex-col gap-4"
      footer={
        <Button id="btn-done-settings" variant="primary" size="lg" block onClick={onClose}>
          {t('close', lang)}
        </Button>
      }
    >
      <SettingsPanel
        settings={settings}
        onUpdateSettings={onUpdateSettings}
        onTriggerShake={onTriggerShake}
        indicatorsLockedBySonar={indicatorsLockedBySonar}
      />


    </Sheet>
  );
};
