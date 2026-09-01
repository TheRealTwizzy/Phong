import { describe, expect, it } from 'vitest';
import { PATCH_NOTES, latestPatchNote } from '../src/patchNotes';
import { APP_VERSION } from '../src/version';

// Patch notes are the one part of the product that is deliberately English
// only, so nothing in tests/i18n.test.ts is watching them. These are the rules
// that would otherwise have nothing holding them.

describe('patch notes', () => {
  it('leads with the version actually running', () => {
    // The "what's new" dot compares the version a player last saw against
    // this one. If the newest entry is not the current build, the dot either
    // never clears or never appears — and the notes describe a version
    // nobody is on.
    expect(latestPatchNote().version).toBe(APP_VERSION);
  });

  it('is ordered newest first', () => {
    const versions = PATCH_NOTES.map((n) => n.version);
    const sorted = [...versions].sort((a, b) => {
      const pa = a.split('.').map(Number);
      const pb = b.split('.').map(Number);
      for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
      return 0;
    });
    expect(versions).toEqual(sorted);
  });

  it('gives every entry a real date and at least one line', () => {
    for (const note of PATCH_NOTES) {
      expect(note.version, `${note.version} is not semver`).toMatch(/^\d+\.\d+\.\d+$/);
      expect(note.date, `${note.version} has a bad date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(note.date))).toBe(false);
      expect(note.lines.length, `${note.version} has no lines`).toBeGreaterThan(0);
      for (const line of note.lines) expect(line.trim()).not.toBe('');
    }
  });

  it('names each version once', () => {
    expect(new Set(PATCH_NOTES.map((n) => n.version)).size).toBe(PATCH_NOTES.length);
  });
});
