import { describe, expect, it } from 'vitest';
import {
  colorDistance,
  contrastRatio,
  luminance,
  mixHex,
  oklab,
  paletteDistance,
  parseHex,
  toHex,
  withAlpha,
} from '../src/game/color';

// Forty lines of arithmetic holding up two test floors and every colour in the
// app. The cases below are the ones that were actually got wrong, plus the
// boundaries a malformed value reaches.

describe('parseHex', () => {
  it('reads all three lengths, with or without the hash', () => {
    expect(parseHex('#fff')).toEqual([1, 1, 1]);
    expect(parseHex('ffffff')).toEqual([1, 1, 1]);
    expect(parseHex('#000000')).toEqual([0, 0, 0]);
    // Alpha is parsed and ignored: the court palette carries 8-digit values.
    expect(parseHex('#ff000080')).toEqual([1, 0, 0]);
  });

  it('returns null rather than throwing for anything else', () => {
    for (const bad of ['', '#ff', '#fffff', 'rgba(0,0,0,1)', 'transparent', '#gggggg']) {
      expect(parseHex(bad), bad).toBeNull();
    }
    expect(parseHex(undefined as never)).toBeNull();
  });
});

describe('contrastRatio', () => {
  it('spans the WCAG range', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#123456', '#123456')).toBeCloseTo(1, 5);
  });

  it('is a property of the pair, not of which one you called foreground', () => {
    expect(contrastRatio('#101820', '#e8eef6')).toBeCloseTo(
      contrastRatio('#e8eef6', '#101820')!,
      10
    );
  });

  it('is null if either side is not a colour it can read', () => {
    expect(contrastRatio('transparent', '#fff')).toBeNull();
    expect(contrastRatio('#fff', 'rgba(0,0,0,0.5)')).toBeNull();
  });
});

describe('mixHex', () => {
  it('returns the endpoints exactly, and clamps past them', () => {
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(mixHex('#000000', '#ffffff', -5)).toBe('#000000');
    expect(mixHex('#000000', '#ffffff', 5)).toBe('#ffffff');
  });

  it('mixes in sRGB, which is the whole reason the surface ramp works', () => {
    // The bug this pins: mixing in LINEAR light lands #090d16 5% toward white
    // on roughly #414244 — a step the eye reads as enormous, and grey, because
    // linear mixing toward white pulls the saturation with it. In sRGB the same
    // 5% is a small step that keeps the hue, which is how the shipped token ramp
    // was authored and therefore what a derivation has to reproduce.
    const step = mixHex('#090d16', '#ffffff', 0.05);
    expect(step).toBe('#151922');
    // Halfway between black and white in sRGB is mid-grey, not the 0.73 that
    // linear-light mixing produces.
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
  });

  it('passes the first colour through when the second is unreadable', () => {
    expect(mixHex('#123456', 'transparent', 0.5)).toBe('#123456');
  });
});

describe('perceptual distance', () => {
  it('is zero for a colour against itself and rises with difference', () => {
    expect(colorDistance('#ff0000', '#ff0000')).toBe(0);
    const near = colorDistance('#ff0000', '#fe0000')!;
    const far = colorDistance('#ff0000', '#00ff00')!;
    expect(near).toBeLessThan(far);
  });

  it('separates two colours a player would call different, not two bit patterns', () => {
    // The reason this is OKLab and not sRGB. Two near-blacks are further apart
    // in raw channel distance than they look; two mid greens are closer. A
    // catalogue policed on channel distance would still ship near-duplicates.
    const blacks = colorDistance('#000010', '#100000')!;
    const greens = colorDistance('#22c55e', '#16a34a')!;
    expect(blacks).toBeLessThan(greens);
  });

  it('skips keys either palette is missing rather than counting them as distance', () => {
    const a = { x: '#ff0000', y: '#00ff00' };
    const b = { x: '#ff0000' };
    // y is absent from b, so only x is compared — and x is identical.
    expect(paletteDistance(a, b, ['x', 'y'])).toBe(0);
    expect(paletteDistance({}, {}, ['x'])).toBe(0);
  });

  it('averages, so one different swatch does not make a palette distinct', () => {
    const a = { p: '#101010', q: '#101010', r: '#101010' };
    const b = { p: '#101010', q: '#101010', r: '#ff0000' };
    const one = colorDistance('#101010', '#ff0000')!;
    expect(paletteDistance(a, b, ['p', 'q', 'r'])).toBeCloseTo(one / 3, 10);
  });
});

describe('the small conversions', () => {
  it('round-trips a colour through toHex', () => {
    expect(toHex(parseHex('#19e3ff')!)).toBe('#19e3ff');
  });

  it('clamps out-of-gamut channels instead of emitting a broken string', () => {
    expect(toHex([-1, 0.5, 2])).toBe('#0080ff');
  });

  it('writes an alpha colour a box-shadow can use', () => {
    expect(withAlpha('#19e3ff', 0.35)).toBe('rgb(25 227 255 / 0.35)');
    expect(withAlpha('transparent', 0.5)).toBe('transparent');
  });

  it('reports luminance and OKLab as null for an unreadable colour', () => {
    expect(luminance('nope')).toBeNull();
    expect(oklab('nope')).toBeNull();
    expect(colorDistance('nope', '#fff')).toBeNull();
  });
});
