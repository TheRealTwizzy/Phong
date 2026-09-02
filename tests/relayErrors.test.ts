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

// Every code the protocol declares — spelled as an exhaustive RECORD rather
// than as a bare array, and that change is the point.
//
// The array this replaces carried exactly this comment, claiming that a code
// added to the union without a translation would "fail here instead of
// silently falling back to English for the rest of its life". A hand-written
// list cannot deliver that: it is only ever as complete as the last person to
// remember it, and it is not the kind of omission review notices, because the
// suite goes on passing over the codes that ARE listed. `ROOM_MID_MATCH` is
// how it was found — added to the union, translated into seven locales, and
// covered by nothing.
//
// A Record keyed on the union makes the compiler answer instead: a member
// missing from here is a tsc error, not a quiet gap.
const ALL_CODES: Record<RelayErrorCode, true> = {
  ROOM_NOT_FOUND: true,
  ROOM_FULL: true,
  ROOM_MID_MATCH: true,
  ALREADY_AT_TABLE: true,
  SEAT_TAKEN: true,
  SEATS_LOCKED: true,
  NEEDS_A_PLAYER: true,
  NO_WATCH_SEATS: true,
  WATCH_SEATS_FULL: true,
  NOT_A_SEAT: true,
  NEEDS_USERNAME: true,
  LEAVE_TABLE_FIRST: true,
  VENUE_LOCKED: true,
};
const CODES = Object.keys(ALL_CODES) as RelayErrorCode[];

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

  it('renders both tier refusals, at both ends of a bracket', () => {
    // Both ends, because a bracket with only a floor is one a veteran farms —
    // so `tier_high` is a real verdict and not a defensive branch.
    const low = { ok: false, reason: 'tier_low' as const, needTier: 'grandmaster' as const };
    const high = { ok: false, reason: 'tier_high' as const, maxTier: 'ace' as const };
    for (const { code: lang } of LANGUAGES) {
      const lowText = relayErrorText(frame({ code: 'VENUE_LOCKED', verdict: low }), lang);
      const highText = relayErrorText(frame({ code: 'VENUE_LOCKED', verdict: high }), lang);
      expect(lowText).toBe(lockReason(low, lang));
      expect(highText).toBe(lockReason(high, lang));
      expect(lowText).not.toBe('');
      expect(highText).not.toBe('');
      expect(lowText).not.toBe(highText);
    }
  });

  it('does not render a verdict whose own field is missing', () => {
    // It crosses the WIRE now, so a malformed one is a thing that happens —
    // and an undefined tier would index TIER_LABEL_KEY with `undefined`.
    for (const bad of [
      { ok: false, reason: 'level' as const },
      { ok: false, reason: 'tier_low' as const },
      { ok: false, reason: 'tier_high' as const },
      { ok: false },
      { ok: true },
    ]) {
      expect(lockReason(bad, 'en')).toBe('');
      // The frame still says SOMETHING, because `message` is the fallback.
      expect(relayErrorText(frame({ code: 'VENUE_LOCKED', verdict: bad }), 'en')).toBe(
        'Room not found.'
      );
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
