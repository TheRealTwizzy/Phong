import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { LanguageCode } from '../../types';
import { t } from '../../i18n/translations';

// Page-number navigation for a server-paged list. First and last page are
// always reachable, a small window rides around the current page, and the
// gaps collapse to an ellipsis — so the row stays one line on a phone however
// long the history gets. Renders nothing for a single page: pagination that
// cannot navigate is noise.
//
// Ids follow the e2e convention: `${idPrefix}-page-${n}` per number,
// `${idPrefix}-page-prev` / `-next` for the arrows, `data-selected` on the
// current page — tests read state, never Tailwind classes.

export interface PaginationProps {
  /** 1-based. */
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
  idPrefix: string;
  language: LanguageCode;
  className?: string;
}

/** The page numbers to render, with 'gap' where a run was collapsed. */
function pageItems(page: number, pageCount: number): Array<number | 'gap'> {
  const wanted = new Set<number>([1, pageCount, page - 1, page, page + 1]);
  const items: Array<number | 'gap'> = [];
  for (let p = 1; p <= pageCount; p++) {
    if (wanted.has(p)) items.push(p);
    else if (items[items.length - 1] !== 'gap') items.push('gap');
  }
  return items;
}

export const Pagination: React.FC<PaginationProps> = ({
  page,
  pageCount,
  onPage,
  idPrefix,
  language,
  className = '',
}) => {
  if (pageCount <= 1) return null;

  const go = (p: number) => {
    const next = Math.min(Math.max(p, 1), pageCount);
    if (next !== page) onPage(next);
  };

  return (
    <nav
      aria-label={t('history_page_label', language, {
        page: String(page),
        pages: String(pageCount),
      })}
      className={`flex flex-wrap items-center justify-center gap-1 ${className}`}
    >
      <button
        id={`${idPrefix}-page-prev`}
        type="button"
        aria-label={t('history_prev_page', language)}
        disabled={page <= 1}
        onClick={() => go(page - 1)}
        className="rounded-ctl border border-line bg-surface-3 p-1.5 text-ink-muted transition-colors hover:text-ink disabled:opacity-40"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </button>

      {pageItems(page, pageCount).map((item, idx) =>
        item === 'gap' ? (
          <span key={`gap-${idx}`} className="px-0.5 text-2xs text-ink-dim">
            …
          </span>
        ) : (
          <button
            key={item}
            id={`${idPrefix}-page-${item}`}
            type="button"
            aria-current={item === page ? 'page' : undefined}
            data-selected={item === page ? 'true' : 'false'}
            onClick={() => go(item)}
            className={`min-w-8 rounded-ctl border px-2 py-1 text-2xs tnum transition-colors ${
              item === page
                ? 'border-accent bg-accent/12 text-accent'
                : 'border-line bg-surface-3 text-ink-muted hover:text-ink'
            }`}
          >
            {item}
          </button>
        )
      )}

      <button
        id={`${idPrefix}-page-next`}
        type="button"
        aria-label={t('history_next_page', language)}
        disabled={page >= pageCount}
        onClick={() => go(page + 1)}
        className="rounded-ctl border border-line bg-surface-3 p-1.5 text-ink-muted transition-colors hover:text-ink disabled:opacity-40"
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
    </nav>
  );
};
