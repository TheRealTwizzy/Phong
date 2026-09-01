import { t } from '../i18n/translations';
import { TIER_LABEL_KEY } from '../rating';
import type { EntryVerdict } from '../venues';
import type { LanguageCode, RelayErrorCode, WSServerMessage } from '../types';

/**
 * What the relay's refusals say, in the player's own language.
 *
 * The `error` frame carried a server-authored English literal and App put it
 * straight into `alert()`. Three things were wrong with that at once: English
 * in six of seven locales; a blocking OS dialog drawn over a full-screen game,
 * which halts the animation loop until it is dismissed; and it was the MOST
 * COMMON error path in the product, since mistyping a 4-character join key
 * lands here. App.tsx already states the principle a few lines above that call
 * site — "returned to the menu with a notice, instead of a blocking alert()
 * over a dead court" — and this one site never got it.
 *
 * Each key is spelled out in full rather than assembled from the code. A key
 * built at runtime is invisible to the dead-weight check in
 * `tests/i18n.test.ts` and reads as unreferenced (CLAUDE.md §11), so the map
 * has to be literal to be checkable.
 */
const RELAY_ERROR_KEY: Record<Exclude<RelayErrorCode, 'VENUE_LOCKED'>, string> = {
  ROOM_NOT_FOUND: 'relay_err_room_not_found',
  ROOM_FULL: 'relay_err_room_full',
  ALREADY_AT_TABLE: 'relay_err_already_at_table',
  SEAT_TAKEN: 'relay_err_seat_taken',
  SEATS_LOCKED: 'relay_err_seats_locked',
  NEEDS_A_PLAYER: 'relay_err_needs_a_player',
  NO_WATCH_SEATS: 'relay_err_no_watch_seats',
  WATCH_SEATS_FULL: 'relay_err_watch_seats_full',
  NOT_A_SEAT: 'relay_err_not_a_seat',
  NEEDS_USERNAME: 'relay_err_needs_username',
  LEAVE_TABLE_FIRST: 'relay_err_leave_table_first',
};

/**
 * Why a bracketed room is shut, in words the player can act on.
 *
 * Lives here rather than in `MainMenu` because the relay refuses the same
 * bracket the menu draws, and both now say so — one copy, so the two cannot
 * drift the way the menu's lock and the relay's refusal would have.
 */
export function lockReason(verdict: EntryVerdict, lang: LanguageCode): string {
  if (verdict.ok) return '';
  // Each field is optional on the shared shape and only set for its own
  // reason, so each is checked rather than asserted — this now arrives over
  // the wire from the relay, where a malformed verdict is a thing that can
  // happen, and an undefined tier would index TIER_LABEL_KEY with `undefined`.
  if (verdict.reason === 'level' && verdict.needLevel !== undefined) {
    return t('room_locked_level', lang, { level: verdict.needLevel });
  }
  if (verdict.reason === 'tier_low' && verdict.needTier) {
    return t('room_locked_tier_low', lang, { tier: t(TIER_LABEL_KEY[verdict.needTier], lang) });
  }
  if (verdict.reason === 'tier_high' && verdict.maxTier) {
    return t('room_locked_tier_high', lang, { tier: t(TIER_LABEL_KEY[verdict.maxTier], lang) });
  }
  return '';
}

/**
 * The text to show for one `error` frame.
 *
 * Falls back to the server's own English `message` for a code this bundle does
 * not know — a relay ahead of the client, or a refusal nobody has given a code
 * yet. Showing English beats showing nothing, and beats showing a raw token.
 */
export function relayErrorText(
  msg: Extract<WSServerMessage, { type: 'error' }>,
  lang: LanguageCode
): string {
  if (msg.code === 'VENUE_LOCKED' && msg.verdict) {
    return lockReason(msg.verdict, lang) || msg.message || '';
  }
  const key = msg.code ? RELAY_ERROR_KEY[msg.code as Exclude<RelayErrorCode, 'VENUE_LOCKED'>] : undefined;
  return key ? t(key, lang) : msg.message || '';
}
