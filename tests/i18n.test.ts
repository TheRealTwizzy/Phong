import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
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
    // Deliberately a key the product actually renders — pinning one that
    // nothing uses is how a test ends up being the only thing keeping a
    // dead string alive, which is exactly what the next test forbids.
    expect(t('mission_reroll_left', 'de', { n: 3 })).toBe('Noch 3 Neuauslosungen heute');
    expect(t('mission_reroll_left', 'ja', { n: 2 })).toBe('本日の引き直し残り 2');
  });

  it('falls back to English for an unknown key rather than throwing', () => {
    expect(t('definitely_not_a_key', 'fr')).toBe('definitely_not_a_key');
  });
});

// The dictionary and the product must agree in BOTH directions.
//
// 47 of 333 keys — 14% — were referenced nowhere: superseded lobby copy, a
// settings layout that no longer exists, telemetry labels describing an older
// overlay, and ten theme names that had drifted out of sync with themes.ts
// and would have rendered the wrong words if anything had used them. Dead
// weight is cheap to carry and expensive to trust: every one of them looked
// live enough to translate, and 47 x 7 locales is a lot of work spent on
// strings nobody would ever read.
//
// The reverse is worse and nothing checked it either: `t()` returns the KEY
// when it knows no translation, so a typo renders `menu_quickmach` to the
// player instead of failing anywhere a developer would notice.

const PRODUCT_ROOTS = ['src', 'server'];
const PRODUCT_FILES = ['server.ts'];
/** Every product source file, excluding the dictionary itself. */
function productSources(): string[] {
  const out: string[] = [...PRODUCT_FILES];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (['node_modules', 'dist', '.git'].includes(e.name)) continue;
        walk(p);
      } else if (/\.(ts|tsx)$/.test(e.name) && !p.endsWith(path.join('i18n', 'translations.ts'))) {
        out.push(p);
      }
    }
  };
  for (const r of PRODUCT_ROOTS) walk(r);
  return out;
}
const SOURCE = productSources()
  .map((f) => fs.readFileSync(f, 'utf8'))
  .join('\n');

describe('the dictionary matches the product', () => {
  it('defines no key the product never asks for', () => {
    // Quoted anywhere counts — keys reach `t()` directly and through fields
    // like `labelKey`, all of which are string literals. There are no
    // template-literal `t()` calls; if one is ever added, this test will
    // name the key it can no longer see, which is the intended prompt to
    // reconsider rather than to add an exception.
    const unused = Object.keys(EN).filter(
      (k) => !new RegExp(`['"\`]${k}['"\`]`).test(SOURCE)
    );
    expect(unused).toEqual([]);
  });

  it('asks for no key the dictionary lacks', () => {
    // `t()` answers an unknown key with the key itself, so this surfaces in
    // the UI as `menu_quickmach` rather than as any kind of error.
    const asked = new Set<string>();
    for (const m of SOURCE.matchAll(/\bt\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g)) {
      asked.add(m[1]);
    }
    expect([...asked].filter((k) => !(k in EN))).toEqual([]);
  });
});
