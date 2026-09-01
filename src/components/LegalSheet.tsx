import React from 'react';
import { ShieldCheck } from 'lucide-react';
import { Sheet } from './ui/Sheet';
import { Button } from './ui/Button';
import { t } from '../i18n/translations';
import { LanguageCode } from '../types';
import { CONTACT_EMAIL, PRIVACY, TERMS } from '../legal';

interface LegalSheetProps {
  isOpen: boolean;
  onClose: () => void;
  lang: LanguageCode;
  /** Opens the report form, which is the contact channel when there is no address. */
  onOpenReport: () => void;
  stack?: { index: number; count: number };
}

/**
 * What is stored, what is expected, and how to reach a person.
 *
 * The text is English (see src/legal.ts) and the sheet says so in the player's
 * own language rather than leaving them to work out why one panel changed.
 */
export const LegalSheet: React.FC<LegalSheetProps> = ({
  isOpen,
  onClose,
  lang,
  onOpenReport,
  stack,
}) => {
  return (
    <Sheet
      stack={stack}
      id="legal-sheet"
      cardId="legal-sheet-card"
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      accent="accent"
      icon={<ShieldCheck className="h-5 w-5" />}
      title={t('legal_title', lang)}
      closeId="btn-close-legal"
      closeLabel={t('close', lang)}
      bodyClassName="scroll-y p-4 flex flex-col gap-4"
      footer={
        <Button id="btn-legal-done" variant="primary" size="lg" block onClick={onClose}>
          {t('close', lang)}
        </Button>
      }
    >
      <p className="shrink-0 text-[10px] leading-snug text-ink-muted">
        {t('legal_english', lang)}
      </p>

      {[PRIVACY, TERMS].map((section) => (
        <div
          key={section.titleKey}
          id={`legal-${section.titleKey}`}
          className="shrink-0 flex flex-col gap-2 rounded-2xl border border-line bg-surface-2/60 p-3.5"
        >
          <h3 className="font-mono text-xs font-bold text-ink">{t(section.titleKey, lang)}</h3>
          {section.paragraphs.map((p, i) => (
            <p key={i} className="text-xs leading-snug text-ink-dim">
              {p}
            </p>
          ))}
        </div>
      ))}

      <div
        id="legal-contact"
        className="shrink-0 flex flex-col gap-2 rounded-2xl border border-line bg-surface-2/60 p-3.5"
      >
        <h3 className="font-mono text-xs font-bold text-ink">{t('legal_contact', lang)}</h3>
        {CONTACT_EMAIL ? (
          <a
            id="legal-contact-email"
            href={`mailto:${CONTACT_EMAIL}`}
            className="text-xs break-all text-accent underline"
          >
            {CONTACT_EMAIL}
          </a>
        ) : (
          <>
            <p className="text-xs leading-snug text-ink-dim">{t('legal_contact_form', lang)}</p>
            <Button id="btn-legal-open-report" variant="secondary" size="sm" onClick={onOpenReport}>
              {t('report_title', lang)}
            </Button>
          </>
        )}
      </div>
    </Sheet>
  );
};
