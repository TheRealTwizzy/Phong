import React from 'react';
import { ChevronLeft, ChevronRight, Newspaper } from 'lucide-react';
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
 * What changed, and which version you are on — ONE RELEASE PER PAGE.
 *
 * Every merged pull request adds a release (convention §17), so this list only
 * grows, and what it replaced rendered all of them at once in a single scroll.
 * That is fine at two entries and useless at thirty: no way to tell where one
 * release ends and the next begins without reading, and no way to get to a
 * specific version at all. A player asking "what changed in the update I just
 * got" had to scroll past every release that came after it.
 *
 * A pager rather than a collapse-the-old-ones toggle, because the question is
 * "what happened in THIS release" and a page is that question's unit. Newest is
 * page 1: it is the one the unread dot is about, and the one nearly everybody
 * opening this wants.
 *
 * Buttons, not a swipe. `useMenuSwipe` exists and is deliberately not reused —
 * it is built for the menu pager, which is a `touch-none` region with nothing
 * scrolling inside it; this is a scrolling sheet, and CLAUDE.md §1 records what
 * copying that pattern onto ordinary DOM costs (an ancestor `touch-action`
 * silently withdraws vertical panning from everything inside it, with no build
 * error and nothing to see but scrolling that stopped working).
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
  const [page, setPage] = React.useState(0);
  const total = PATCH_NOTES.length;

  // Back to the newest every time it opens. The sheet is normally reached from
  // the unread dot, which is about the newest release — landing on whichever
  // page was left behind last time would answer a question nobody asked.
  React.useEffect(() => {
    if (isOpen) setPage(0);
  }, [isOpen]);

  // Clamped rather than trusted: a release added while this is mounted (a
  // deploy mid-session) shortens nothing, but the clamp costs nothing and an
  // out-of-range index renders an empty sheet with no way back.
  const index = Math.min(Math.max(page, 0), Math.max(total - 1, 0));
  const note = PATCH_NOTES[index];
  const atNewest = index === 0;
  const atOldest = index >= total - 1;

  return (
    <Sheet
      stack={stack}
      id="patch-notes-sheet"
      cardId="patch-notes-sheet-card"
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      accent="accent"
      icon={<Newspaper className="h-5 w-5" />}
      title={t('patch_notes_title', lang)}
      subtitle={
        <span id="patch-notes-build" className="font-mono">
          v{APP_VERSION}
          {build ? ` · ${build}` : ''}
        </span>
      }
      closeId="btn-close-patch-notes"
      closeLabel={t('close', lang)}
      bodyClassName="scroll-y p-4 flex flex-col gap-4"
      footer={
        <div className="flex w-full flex-col gap-2">
          {/* The pager sits ABOVE the CTA and inside the fixed footer, so it is
              reachable however long a release is — a nav pinned under the last
              bullet is one a long release pushes off the screen. */}
          <div className="flex items-center gap-2">
            <Button
              id="patch-notes-newer"
              variant="ghost"
              size="sm"
              disabled={atNewest}
              onClick={() => setPage(index - 1)}
              aria-label={t('patch_notes_newer', lang)}
            >
              <ChevronLeft className="h-4 w-4" />
              {t('patch_notes_newer', lang)}
            </Button>
            <span
              id="patch-notes-position"
              className="flex-1 text-center text-[10px] tabular-nums text-ink-muted"
            >
              {t('patch_notes_position', lang, { n: String(index + 1), total: String(total) })}
            </span>
            <Button
              id="patch-notes-older"
              variant="ghost"
              size="sm"
              disabled={atOldest}
              onClick={() => setPage(index + 1)}
              aria-label={t('patch_notes_older', lang)}
            >
              {t('patch_notes_older', lang)}
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          <Button id="btn-patch-notes-done" variant="primary" size="lg" block onClick={onClose}>
            {t('close', lang)}
          </Button>
        </div>
      }
    >
      <p className="shrink-0 text-[10px] leading-snug text-ink-muted">
        {t('patch_notes_english', lang)}
      </p>
      {note && (
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
      )}
    </Sheet>
  );
};
