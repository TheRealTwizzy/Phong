import React, { useEffect, useState } from 'react';
import { LanguageCode, PlayerProfile } from '../types';
import { t } from '../i18n/translations';
import { USERNAME_MAX } from '../profileRules';
import { Button } from './ui';
import { Trash2, AlertTriangle, Loader2 } from 'lucide-react';

// Deleting the account. Lifted out of the Settings sheet when Settings became a
// PAGE of the menu pager: a page is reachable from the menu only, which is the
// right home for this, but the Settings panel is also what the in-match HUD
// renders, and nothing here may be one tap from a live court.
//
// So it lives in the Profile modal instead, last in the Stats tab — everything
// above it is reversible and this is the one thing that is not, the same
// reasoning that put it last in the sheet.
//
// THE GATE IS THE WHOLE POINT. ProfileModal opens from the menu's header pill
// AND from the in-match HUD (ScoreBoard #btn-open-profile), the same instance
// both times. `onDeleteAccount` is passed only when `screen === 'menu'`, so
// this section is simply absent mid-match. Without that, deleting from a live
// duel would walk the player out of the match, leave an opponent alone in a
// room nobody told, and charge the abandon to an account that no longer exists.

export interface AccountDangerZoneProps {
  /** The host modal's open state — closing it abandons a half-armed flow. */
  isOpen: boolean;
  profile: PlayerProfile | null;
  language: LanguageCode;
  /** Absent = not offered. Menu only; see the note above. */
  onDeleteAccount?: (username: string) => Promise<{ ok: boolean; error?: string }>;
}

export const AccountDangerZone: React.FC<AccountDangerZoneProps> = ({
  isOpen,
  profile,
  language: lang,
  onDeleteAccount,
}) => {
  // idle → name → confirm. Two steps, because the one action in the app with
  // no undo should not be one tap away from a slider.
  //  - `name`    the username, typed exactly. The gate, not a formality.
  //  - `confirm` the reminder that this is permanent, and the last word on it.
  const [deleteStep, setDeleteStep] = useState<'idle' | 'name' | 'confirm'>('idle');
  const [typedName, setTypedName] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Closing the host abandons the flow. Without this, a player who backed out
  // by shutting the modal would find the confirmation still armed and waiting
  // the next time they opened it, with no memory of having asked for it.
  useEffect(() => {
    if (isOpen) return;
    setDeleteStep('idle');
    setTypedName('');
    setDeleteError(null);
  }, [isOpen]);

  const accountName = profile?.username || '';
  // Compared exactly — case included, and untrimmed. The server does the same
  // (DELETE /api/profile/me), and the two have to agree or Continue would
  // enable on something the server then refuses. Phone keyboards capitalize
  // the first letter by themselves, which is why the input turns that off.
  const nameMatches = accountName.length > 0 && typedName === accountName;

  const closeDeleteFlow = () => {
    setDeleteStep('idle');
    setTypedName('');
    setDeleteError(null);
  };

  const handleConfirmDelete = async () => {
    if (!onDeleteAccount || deleteBusy || !nameMatches) return;
    setDeleteBusy(true);
    setDeleteError(null);
    const result = await onDeleteAccount(typedName);
    // On success the page is on its way to reloading as a brand-new player, so
    // there is deliberately nothing to put back: leaving the button spinning
    // is truer than flashing the panel back to idle over a dead account.
    if (!result.ok) {
      setDeleteBusy(false);
      setDeleteError(result.error || 'DELETE_FAILED');
    }
  };

  return (
    <>
      {/* Danger zone — last in the sheet, deliberately. Everything above is a
          preference that can be flipped back; this is the only thing here
          that cannot be, so it sits past all of it rather than beside it.
          Absent entirely mid-match and for a profile with no account yet:
          see the onDeleteAccount prop. */}
      {onDeleteAccount && profile?.initialized && (
        <div
          id="danger-zone"
          className="mt-2 flex flex-col gap-2.5 rounded-2xl border border-loss/30 bg-loss/20 p-3.5"
        >
          <div className="flex items-center gap-1.5 text-loss">
            <Trash2 className="h-4 w-4" />
            <span className="text-xs font-mono font-bold uppercase tracking-wider">
              {t('delete_account_title', lang)}
            </span>
          </div>

          {deleteStep === 'idle' && (
            <>
              <p className="text-[10px] leading-relaxed text-ink-muted">
                {t('delete_account_desc', lang)}
              </p>
              <Button
                id="btn-delete-account"
                variant="ghost"
                size="md"
                block
                icon={<Trash2 className="h-3.5 w-3.5" />}
                onClick={() => {
                  setTypedName('');
                  setDeleteError(null);
                  setDeleteStep('name');
                }}
                className="border-loss/40 text-loss hover:bg-loss/10 hover:text-loss"
              >
                {t('delete_account_start', lang)}
              </Button>
            </>
          )}

          {/* Step 1 — the username, typed exactly. */}
          {deleteStep === 'name' && (
            <>
              <p className="text-[11px] font-medium leading-relaxed text-ink">
                {t('delete_account_name_prompt', lang)}
              </p>
              <p className="text-[10px] leading-relaxed text-ink-muted">
                {t('delete_account_name_hint', lang)}
              </p>
              <div
                id="delete-account-name-echo"
                className="select-all rounded-xl border border-line bg-surface-0 py-1.5 text-center font-mono text-sm font-bold tracking-wider text-ink"
              >
                {accountName}
              </div>
              <input
                id="input-delete-confirm-name"
                type="text"
                value={typedName}
                onChange={(e) => setTypedName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && nameMatches) setDeleteStep('confirm');
                }}
                // A phone keyboard capitalizes the first letter and offers
                // corrections by default, both of which would fight a
                // case-sensitive compare the player cannot see losing.
                autoCapitalize="none"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
                maxLength={USERNAME_MAX}
                placeholder={t('delete_account_name_prompt', lang)}
                className="w-full rounded-xl border border-line-strong bg-surface-0 px-3 py-2.5 font-mono text-base text-ink transition placeholder:text-ink-dim focus:border-loss focus:outline-none"
              />
              {typedName.length > 0 && !nameMatches && (
                <p id="delete-account-name-mismatch" className="text-[10px] font-mono text-loss">
                  {t('delete_account_name_mismatch', lang)}
                </p>
              )}
              <div className="flex items-center gap-2">
                <Button
                  id="btn-delete-account-cancel"
                  variant="secondary"
                  size="md"
                  block
                  onClick={closeDeleteFlow}
                >
                  {t('cancel', lang)}
                </Button>
                <Button
                  id="btn-delete-account-continue"
                  variant="danger"
                  size="md"
                  block
                  disabled={!nameMatches}
                  onClick={() => setDeleteStep('confirm')}
                >
                  {t('delete_account_continue', lang)}
                </Button>
              </div>
            </>
          )}

          {/* Step 2 — the reminder IS the last word. Two buttons and no
              third: DELETE goes through with it, BACK returns to the open
              Settings panel with nothing spent. */}
          {deleteStep === 'confirm' && (
            <>
              <div className="flex items-center gap-1.5 text-loss">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span className="text-xs font-bold uppercase tracking-wider">
                  {t('delete_account_permanent_title', lang)}
                </span>
              </div>
              <p
                id="delete-account-permanent-warning"
                className="text-[11px] leading-relaxed text-warn/90"
              >
                {t('delete_account_permanent_body', lang, { name: accountName })}
              </p>
              {deleteError && (
                <p id="delete-account-error" className="text-[10px] font-mono text-loss">
                  {t('delete_account_failed', lang)}
                </p>
              )}
              <div className="flex items-center gap-2">
                <Button
                  id="btn-delete-account-back"
                  variant="secondary"
                  size="lg"
                  block
                  disabled={deleteBusy}
                  onClick={closeDeleteFlow}
                >
                  {t('delete_account_back', lang)}
                </Button>
                <Button
                  id="btn-delete-account-final"
                  variant="danger"
                  size="lg"
                  block
                  disabled={deleteBusy}
                  onClick={() => void handleConfirmDelete()}
                  icon={
                    deleteBusy ? (
                      <Loader2 className="h-4 w-4 animate-spin" data-motion-essential />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )
                  }
                >
                  {t('delete_account_final', lang)}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
};
