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

  it('is written for a player, not for whoever wrote the diff', () => {
    // These notes are the only place the product speaks to a player about a
    // change, and the failure mode is not a typo — it is a line that reads
    // like a commit message. `scripts/check-release-note.mjs` makes every
    // shipped change add a line here, which is exactly the pressure that
    // produces "refactor roomConfigFor() to clamp difficulty", so the guard
    // belongs beside the rule that creates the pressure.
    //
    // Narrow on purpose: a filename, a source path, or an identifier written
    // as a call. Prose about "the relay" or "the ladder" is fine — players
    // read those words in the game.
    for (const note of PATCH_NOTES) {
      for (const line of note.lines) {
        expect(line, `${note.version}: names a source file`).not.toMatch(/\.tsx?\b/);
        expect(line, `${note.version}: names a path`).not.toMatch(/\b(src|server|tests|scripts)\//);
        expect(line, `${note.version}: names a function`).not.toMatch(/\w\(\)/);
      }
    }
  });

  it('keeps a line to something a phone can show', () => {
    // PatchNotesSheet renders these at `text-xs` in `text-ink-dim`, bulleted,
    // inside a scrolling sheet. A line is a BULLET, not a paragraph: at that
    // size on a 390px phone, 150 characters is about three lines and is the
    // point where a release note stops being scanned and starts being
    // skipped.
    //
    // Written after 1.0.1 shipped its first draft at 240 characters a bullet
    // against 1.0.0's 60-to-125. The rule that forces a line for every shipped
    // change is exactly the pressure that produces an essay in one, so the
    // ceiling belongs next to it. Split a long one into two bullets — they are
    // free, and two short lines read better than one long one.
    for (const note of PATCH_NOTES) {
      for (const line of note.lines) {
        expect(line.length, `${note.version}: "${line.slice(0, 48)}…" is ${line.length} chars`).toBeLessThanOrEqual(150);
      }
    }
  });
});
