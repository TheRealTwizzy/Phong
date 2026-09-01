import React from 'react';
import { Newspaper } from 'lucide-react';
import { Sheet } from './ui/Sheet';
import { Button } from './ui/Button';
import { t } from '../i18n/translations';
import { LanguageCode } from '../types';
import { PATCH_NOTES } from '../patchNotes';
import { APP_VERSION } from '../version';

interface PatchNotesSheetProps {
  isOpen: boolean;
  onClose: () => void;
  lang: LanguageCode;
  /** The deployment's build id, shown beside the version. */
  build: string | null;
  stack?: { index: number; count: number };
}

/**
 * What changed, and which version you are on.
 *
 * The notes themselves are English (see src/patchNotes.ts for why); every
 * label around them is not, and the sheet says which is which in the player's
 * own language rather than leaving them to work it out.
 *
 * The version and the build id are shown together because they answer
 * different questions — the first is what changed, the second is what is
 * actually running — and a support conversation needs both.
 */
export const PatchNotesSheet: React.FC<PatchNotesSheetProps> = ({
  isOpen,
  onClose,
  lang,
  build,
  stack,
}) => {
  const header = (
    <div className="shrink-0 flex items-center gap-2.5 border-b border-line bg-surface-1 p-4">
      <Newspaper className="h-5 w-5 text-accent" />
      <div className="flex min-w-0 flex-col">
        <h2 className="text-title truncate">{t('patch_notes_title', lang)}</h2>
        <span id="patch-notes-build" className="font-mono text-[10px] text-ink-muted">
          v{APP_VERSION}
          {build ? ` · ${build}` : ''}
        </span>
      </div>
    </div>
  );

  return (
    <Sheet
      stack={stack}
      id="patch-notes-sheet"
      cardId="patch-notes-sheet-card"
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      accent="accent"
      header={header}
      closeId="btn-close-patch-notes"
      closeLabel={t('close', lang)}
      bodyClassName="scroll-y p-4 flex flex-col gap-4"
      footer={
        <Button id="btn-patch-notes-done" variant="primary" size="lg" block onClick={onClose}>
          {t('close', lang)}
        </Button>
      }
    >
      <p className="shrink-0 text-[10px] leading-snug text-ink-muted">
        {t('patch_notes_english', lang)}
      </p>
      {PATCH_NOTES.map((note) => (
        <div
          key={note.version}
          id={`patch-note-${note.version}`}
          className="shrink-0 flex flex-col gap-2 rounded-2xl border border-line bg-surface-2/60 p-3.5"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-mono text-xs font-bold text-ink">v{note.version}</span>
            <span className="text-[10px] text-ink-muted">
              {new Date(`${note.date}T00:00:00Z`).toLocaleDateString(lang, {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                timeZone: 'UTC',
              })}
            </span>
          </div>
          <ul className="flex flex-col gap-1.5">
            {note.lines.map((line, i) => (
              <li key={i} className="flex gap-2 text-xs leading-snug text-ink-dim">
                <span aria-hidden className="text-accent">
                  •
                </span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </Sheet>
  );
};
