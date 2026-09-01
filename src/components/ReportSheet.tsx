import React, { useEffect, useState } from 'react';
import { Flag } from 'lucide-react';
import { Sheet } from './ui/Sheet';
import { Button } from './ui/Button';
import { t } from '../i18n/translations';
import { LanguageCode } from '../types';
import {
  REPORTS_PER_DAY,
  REPORT_CATEGORIES,
  REPORT_TEXT_MIN,
  ReportCategory,
} from '../reportRules';

interface ReportSheetProps {
  isOpen: boolean;
  onClose: () => void;
  lang: LanguageCode;
  /** Diagnostics the player should never have to type. */
  context: Record<string, unknown>;
  stack?: { index: number; count: number };
}

type Status = 'idle' | 'sending' | 'sent' | 'error';

/** Which locale key names each category, so the list stays data. */
const CATEGORY_KEY: Record<ReportCategory, string> = {
  bug: 'report_cat_bug',
  exploit: 'report_cat_exploit',
  abuse: 'report_cat_abuse',
  other: 'report_cat_other',
};

/**
 * Tell us what went wrong.
 *
 * The body a player types is NOT localized and cannot be — it is theirs. What
 * is localized is every label around it, which is the line convention §11 is
 * really drawing: product chrome ships in seven locales, authored content
 * does not.
 *
 * The diagnostics ride along without being typed. Nobody reports a build id by
 * hand, and a report without one costs an afternoon — so the build, the
 * version, the locale, the screen and the last match key are attached by the
 * caller and shown, collapsed, so it is disclosure rather than telemetry.
 */
export const ReportSheet: React.FC<ReportSheetProps> = ({
  isOpen,
  onClose,
  lang,
  context,
  stack,
}) => {
  const [category, setCategory] = useState<ReportCategory>('bug');
  const [text, setText] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);

  // Closing the sheet abandons the draft rather than banking it, the same rule
  // AccountDangerZone applies to its half-armed confirmation: a form that
  // remembers what you decided not to send is a form that sends it later.
  useEffect(() => {
    if (isOpen) return;
    setCategory('bug');
    setText('');
    setStatus('idle');
    setError(null);
  }, [isOpen]);

  const tooShort = text.trim().length < REPORT_TEXT_MIN;

  const submit = async (): Promise<void> => {
    if (tooShort || status === 'sending') return;
    setStatus('sending');
    setError(null);
    try {
      const res = await fetch('/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, text: text.trim(), context }),
      });
      if (res.ok) {
        setStatus('sent');
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setStatus('error');
      setError(
        body.error === 'TOO_MANY_REPORTS'
          ? t('report_error_too_many', lang, { n: REPORTS_PER_DAY })
          : t('report_error_generic', lang)
      );
    } catch {
      setStatus('error');
      setError(t('report_error_offline', lang));
    }
  };

  return (
    <Sheet
      stack={stack}
      id="report-sheet"
      cardId="report-sheet-card"
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      accent="accent"
      icon={<Flag className="h-5 w-5" />}
      title={t('report_title', lang)}
      closeId="btn-close-report"
      closeLabel={t('close', lang)}
      bodyClassName="scroll-y p-4 flex flex-col gap-3.5"
      footer={
        status === 'sent' ? (
          <Button id="btn-report-done" variant="primary" size="lg" block onClick={onClose}>
            {t('close', lang)}
          </Button>
        ) : (
          <Button
            id="btn-report-send"
            variant="primary"
            size="lg"
            block
            disabled={tooShort || status === 'sending'}
            onClick={() => void submit()}
          >
            {status === 'sending' ? t('report_sending', lang) : t('report_send', lang)}
          </Button>
        )
      }
    >
      {status === 'sent' ? (
        <p id="report-sent" className="shrink-0 text-xs text-win">
          {t('report_sent', lang)}
        </p>
      ) : (
        <>
          <div className="shrink-0 flex flex-col gap-1.5">
            <span className="text-2xs text-ink-muted uppercase">{t('report_category', lang)}</span>
            <div className="grid grid-cols-2 gap-1.5">
              {REPORT_CATEGORIES.map((c) => (
                <button
                  key={c}
                  id={`report-cat-${c}`}
                  data-selected={category === c ? 'true' : 'false'}
                  onClick={() => setCategory(c)}
                  className={`rounded-ctl border px-2 py-2 text-2xs font-mono transition-colors ${
                    category === c
                      ? 'border-accent/50 bg-accent/15 text-accent'
                      : 'border-line-strong bg-surface-2 text-ink-muted'
                  }`}
                >
                  {t(CATEGORY_KEY[c], lang)}
                </button>
              ))}
            </div>
          </div>

          {category === 'exploit' && (
            <p id="report-exploit-note" className="shrink-0 text-[10px] leading-snug text-ink-muted">
              {t('report_exploit_note', lang)}
            </p>
          )}

          <div className="shrink-0 flex flex-col gap-1.5">
            <label htmlFor="report-text" className="text-2xs text-ink-muted uppercase">
              {t('report_what_happened', lang)}
            </label>
            <textarea
              id="report-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={6}
              maxLength={2000}
              placeholder={t('report_placeholder', lang)}
              /* text-base: anything under 16px makes iOS Safari zoom the page
                 on focus, and the game presents at exactly device size. */
              className="w-full resize-none rounded-ctl border border-line-strong bg-surface-2 p-2.5 text-base text-ink placeholder:text-ink-muted"
            />
            <span className="text-[10px] text-ink-muted">
              {t('report_english_note', lang)}
            </span>
          </div>

          <details id="report-context" className="shrink-0 rounded-ctl bg-surface-2/60 p-2.5">
            <summary className="cursor-pointer text-[10px] text-ink-muted">
              {t('report_context_summary', lang)}
            </summary>
            <pre className="mt-2 overflow-x-auto text-[10px] break-all whitespace-pre-wrap text-ink-dim">
              {JSON.stringify(context, null, 1)}
            </pre>
          </details>

          {error && (
            <p id="report-error" className="shrink-0 text-xs text-loss">
              {error}
            </p>
          )}
        </>
      )}
    </Sheet>
  );
};
