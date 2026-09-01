import { describe, expect, it } from 'vitest';
import { LANGUAGES, TRANSLATIONS } from '../src/i18n/translations';
import { lockReason, relayErrorText } from '../src/net/relayErrors';
import type { LanguageCode, RelayErrorCode, WSServerMessage } from '../src/types';

type ErrorFrame = Extract<WSServerMessage, { type: 'error' }>;

const frame = (over: Partial<ErrorFrame> = {}): ErrorFrame => ({
  type: 'error',
  message: 'Room not found.',
  ...over,
});

// Every code the protocol declares. Written out rather than derived, so a code
// added to the union without a translation fails here instead of silently
// falling back to English for the rest of its life.
const CODES: RelayErrorCode[] = [
  'ROOM_NOT_FOUND',
  'ROOM_FULL',
  'ALREADY_AT_TABLE',
  'SEAT_TAKEN',
  'SEATS_LOCKED',
  'NEEDS_A_PLAYER',
  'NO_WATCH_SEATS',
  'WATCH_SEATS_FULL',
  'NOT_A_SEAT',
  'NEEDS_USERNAME',
  'LEAVE_TABLE_FIRST',
  'VENUE_LOCKED',
];

describe('relayErrorText', () => {
  it('says every coded refusal in every locale, and never in English by accident', () => {
    for (const code of CODES) {
      if (code === 'VENUE_LOCKED') continue;
      const en = relayErrorText(frame({ code }), 'en');
      expect(en).not.toBe('');
      // A key the dictionary lacks comes back as the key itself.
      expect(en).not.toMatch(/^relay_err_/);
      for (const { code: lang } of LANGUAGES) {
        const text = relayErrorText(frame({ code }), lang);
        expect(text).not.toBe('');
        expect(text).not.toMatch(/^relay_err_/);
      }
    }
  });

  it('renders a bracket refusal with the same wording the room list uses', () => {
    const verdict = { ok: false, reason: 'level' as const, needLevel: 12 };
    for (const { code: lang } of LANGUAGES) {
      const text = relayErrorText(
        frame({ code: 'VENUE_LOCKED', verdict, message: 'This room needs level 12.' }),
        lang
      );
      expect(text).toBe(lockReason(verdict, lang));
      expect(text).toContain('12');
    }
  });

  it('falls back to the server text for a code this bundle does not know', () => {
    // A relay ahead of the client. English beats a raw token, and beats blank.
    const ahead = frame({ code: 'SOMETHING_NEW' as RelayErrorCode, message: 'Nope.' });
    expect(relayErrorText(ahead, 'fr')).toBe('Nope.');
  });

  it('falls back to the server text when there is no code at all', () => {
    expect(relayErrorText(frame({ message: 'Old relay.' }), 'ja')).toBe('Old relay.');
  });

  it('never returns undefined, whatever arrives', () => {
    expect(relayErrorText({ type: 'error' } as ErrorFrame, 'en')).toBe('');
    expect(relayErrorText(frame({ code: 'VENUE_LOCKED' }), 'en')).toBe('Room not found.');
  });

  it('keeps a translation for every locale of every key it maps', () => {
    // The dead-weight check in i18n.test.ts proves the keys are USED; this
    // proves the map does not point at one that was never added.
    for (const code of CODES) {
      if (code === 'VENUE_LOCKED') continue;
      for (const { code: lang } of LANGUAGES) {
        const dict = TRANSLATIONS[lang as LanguageCode];
        const en = relayErrorText(frame({ code }), 'en');
        const here = relayErrorText(frame({ code }), lang);
        expect(Object.values(dict)).toContain(here);
        if (lang !== 'en') expect(here).not.toBe('');
        expect(en).not.toBe('');
      }
    }
  });
});
