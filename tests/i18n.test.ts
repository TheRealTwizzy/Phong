import { describe, expect, it } from 'vitest';
import { LANGUAGES, TRANSLATIONS, t } from '../src/i18n/translations';

// Every locale carries every key.
//
// `t()` falls back to English for a key a locale is missing, so untranslated
// strings never crash and never show a raw key — which is exactly why 70 of
// them accumulated unnoticed across all six non-English locales. A Japanese
// player just saw a menu that was half English, and nothing in the build, the
// typechecker or the browser suites had an opinion about it.
//
// Nothing here asserts a translation is GOOD. It asserts the set is complete,
// which is the part that silently rots when a feature ships new English copy.

const EN = TRANSLATIONS.en;
const OTHERS = Object.keys(TRANSLATIONS).filter((l) => l !== 'en') as (keyof typeof TRANSLATIONS)[];

/** `{count}`, `{name}`, `{n}` … — a locale that drops one renders a literal hole. */
const params = (s: string) => (s.match(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/g) ?? []).sort();

describe('translations', () => {
  it('offers exactly the locales it can serve', () => {
    expect(LANGUAGES.map((l) => l.code).sort()).toEqual(Object.keys(TRANSLATIONS).sort());
  });

  it.each(OTHERS)('%s defines every English key, and no key English lacks', (locale) => {
    const dict = TRANSLATIONS[locale];
    expect(Object.keys(EN).filter((k) => !(k in dict))).toEqual([]);
    expect(Object.keys(dict).filter((k) => !(k in EN))).toEqual([]);
  });

  it.each(OTHERS)('%s has no empty or whitespace-only value', (locale) => {
    const blank = Object.entries(TRANSLATIONS[locale])
      .filter(([, v]) => typeof v !== 'string' || v.trim() === '')
      .map(([k]) => k);
    expect(blank).toEqual([]);
  });

  it.each(OTHERS)('%s keeps every interpolation placeholder English declares', (locale) => {
    const dropped = Object.entries(EN)
      .filter(([k, en]) => params(en).length > 0)
      .filter(([k, en]) => params(TRANSLATIONS[locale][k]).join() !== params(en).join())
      .map(([k]) => k);
    expect(dropped).toEqual([]);
  });

  it('substitutes params in a non-English locale', () => {
    // Guards the fallback path too: a real translated string, not English.
    expect(t('streak_days', 'de', { count: 7 })).toBe('7 Tage in Folge');
    expect(t('streak_days', 'ja', { count: 3 })).toBe('3 日連続');
  });

  it('falls back to English for an unknown key rather than throwing', () => {
    expect(t('definitely_not_a_key', 'fr')).toBe('definitely_not_a_key');
  });
});
