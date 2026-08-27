/**
 * Colour maths for the cosmetic floors. Dependency-free on purpose: the runtime
 * dependencies of this project are `express` + `ws` and nothing else, and this
 * is forty lines of arithmetic.
 *
 * Two questions are asked of a cosmetic, and they are different questions:
 *
 *   - `contrastRatio` — can the text be READ on the surface behind it. WCAG
 *     relative luminance, which is what `src/index.css` already quotes its ink
 *     ramp in ("6.1:1 — the floor for body text").
 *   - `paletteDistance` — can two cosmetics be TOLD APART. Perceptual, so it
 *     has to be OKLab: sRGB distance calls `#000010` and `#100000` as far apart
 *     as two colours a player would describe as "black", and a catalogue
 *     policed on that metric would still ship near-duplicates.
 *
 * Both are pure and total. A malformed hex returns null rather than throwing,
 * because the callers are a test floor and a render path, and neither is
 * improved by an exception.
 */

/** `#rgb`, `#rrggbb` or `#rrggbbaa` → sRGB channels in [0,1]. Alpha ignored. */
export function parseHex(hex: string): [number, number, number] | null {
  if (typeof hex !== 'string') return null;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim());
  if (!m) return null;
  let body = m[1];
  if (body.length === 3) body = body.split('').map((c) => c + c).join('');
  const n = (i: number) => parseInt(body.slice(i, i + 2), 16) / 255;
  return [n(0), n(2), n(4)];
}

/** sRGB → linear light. The 0.04045 knee is the sRGB transfer curve, not a fudge. */
function linearize(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance. */
export function luminance(hex: string): number | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map(linearize);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG contrast ratio, 1 (identical) to 21 (black on white). Order-independent:
 * the ratio between two colours is a property of the pair, not of which one you
 * called the foreground.
 */
export function contrastRatio(a: string, b: string): number | null {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) return null;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** sRGB → OKLab (Björn Ottosson's matrices). */
export function oklab(hex: string): [number, number, number] | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map(linearize);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Perceptual distance between two colours. 0 is identical. */
export function colorDistance(a: string, b: string): number | null {
  const pa = oklab(a);
  const pb = oklab(b);
  if (!pa || !pb) return null;
  return Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
}

/**
 * How far apart two palettes look, as the MEAN distance over the colours they
 * have in common.
 *
 * Mean rather than minimum, deliberately. A minimum calls two cosmetics
 * "different" the moment any single swatch differs, which is exactly the case
 * that shipped: `retro-crt` and `monochrome-noir` differ in one accent and
 * agree everywhere else, and a player reads them as the same cosmetic. The mean
 * is the thing being asked about — the overall impression, not the best-case
 * swatch.
 *
 * Keys absent from either side are skipped rather than counted as distance, so
 * a palette that gains a field cannot make every existing pair look further
 * apart than it did yesterday.
 */
export function paletteDistance(
  a: object,
  b: object,
  keys: readonly string[]
): number {
  const read = (o: object, k: string): string => {
    const v = (o as Record<string, unknown>)[k];
    return typeof v === 'string' ? v : '';
  };
  let total = 0;
  let counted = 0;
  for (const key of keys) {
    const d = colorDistance(read(a, key), read(b, key));
    if (d === null) continue;
    total += d;
    counted++;
  }
  return counted === 0 ? 0 : total / counted;
}

/** Channels in [0,1] → `#rrggbb`. */
export function toHex(rgb: [number, number, number]): string {
  return (
    '#' +
    rgb
      .map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0'))
      .join('')
  );
}

/**
 * Blend two colours, `t` of the way from `a` to `b`, in sRGB.
 *
 * sRGB and NOT linear light, which is the counterintuitive half. Linear mixing
 * is right for compositing — it is what light actually does — and wrong for
 * building a UI surface ramp, because sRGB is already roughly perceptual and
 * linear is not. Mixing `#090d16` 5% toward white in linear light lands on
 * `#414244`: a step the eye reads as enormous, and grey, because linear mixing
 * toward white pulls the saturation out at the same time. The shipped token
 * ramp was authored as even sRGB steps; this reproduces it, and a derivation
 * that could not reproduce the design it came from is not a derivation.
 */
export function mixHex(a: string, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return a;
  const k = Math.min(1, Math.max(0, t));
  return toHex(ca.map((c, i) => c * (1 - k) + cb[i] * k) as [number, number, number]);
}

/** `#rrggbb` + alpha → `rgb(r g b / a)`, for a colour going into a shadow. */
export function withAlpha(hex: string, alpha: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const [r, g, b] = rgb.map((c) => Math.round(c * 255));
  return `rgb(${r} ${g} ${b} / ${alpha})`;
}
