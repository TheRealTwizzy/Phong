import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { classifyFromSignals, DeviceSignals, openInRealBrowserUrl } from '../src/device';

// Real user-agent strings. The point of this file is the reported bypass:
// the gate used to key on viewport size, so narrowing a desktop browser
// window walked straight through it. Nothing the classifier reads is a window
// property — `DeviceSignals` has no width, height, or orientation in it, and
// that absence is the fix.

const UA = {
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  ipod: 'Mozilla/5.0 (iPod touch; CPU iPhone OS 15_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
  // iPadOS 13+ in its DEFAULT "desktop site" mode reports itself as a Mac.
  ipadDesktopMode:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15',
  androidPhone:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  androidTablet:
    'Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  windows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

const signals = (userAgent: string, maxTouchPoints = 0, uaDataMobile?: boolean): DeviceSignals => ({
  userAgent,
  maxTouchPoints,
  uaDataMobile,
});

describe('device classification', () => {
  it('admits Android and iOS phones', () => {
    expect(classifyFromSignals(signals(UA.iphone, 5))).toBe('phone');
    expect(classifyFromSignals(signals(UA.ipod, 5))).toBe('phone');
    expect(classifyFromSignals(signals(UA.androidPhone, 5))).toBe('phone');
    expect(classifyFromSignals(signals(UA.androidPhone, 5, true))).toBe('phone');
  });

  it('turns tablets away, including an iPad posing as a Mac', () => {
    expect(classifyFromSignals(signals(UA.ipad, 5))).toBe('tablet');
    // The whole reason maxTouchPoints is consulted: this UA is identical to a
    // desktop Safari's apart from the touch points.
    expect(classifyFromSignals(signals(UA.ipadDesktopMode, 5))).toBe('tablet');
    expect(classifyFromSignals(signals(UA.androidTablet, 5))).toBe('tablet');
    // Chromium saying "not mobile" outranks the UA convention.
    expect(classifyFromSignals(signals(UA.androidPhone, 5, false))).toBe('tablet');
  });

  it('turns desktops away', () => {
    expect(classifyFromSignals(signals(UA.mac, 0))).toBe('desktop');
    expect(classifyFromSignals(signals(UA.windows, 0))).toBe('desktop');
    expect(classifyFromSignals(signals(UA.linux, 0))).toBe('desktop');
    // A desktop Mac with a drawing tablet plugged in still reports 0 or 1
    // touch points; only a real iPad reports more.
    expect(classifyFromSignals(signals(UA.mac, 1))).toBe('desktop');
  });

  it('ignores the window, which is what the old gate got wrong', () => {
    // The signals a desktop presents do not change when its window is
    // resized, so neither can the verdict. There is deliberately no width or
    // height for a narrowed window to lie about.
    const desktop = signals(UA.windows, 0);
    expect(Object.keys(desktop).sort()).toEqual(['maxTouchPoints', 'uaDataMobile', 'userAgent']);
    expect(classifyFromSignals(desktop)).toBe('desktop');
  });

  it('does not take a phone UA without touch at face value', () => {
    // A desktop browser with only its UA string overridden. Real phones
    // always report touch points.
    expect(classifyFromSignals(signals(UA.iphone, 0))).toBe('desktop');
  });

  it('falls back to desktop when it knows nothing', () => {
    expect(classifyFromSignals(signals('', 0))).toBe('desktop');
  });
});

// Convention §9: "The device gate reads the platform, never the window."
//
// This is not a style rule. The gate that preceded this one decided by
// VIEWPORT SIZE, so narrowing a browser window walked straight through it —
// which is how the concurrent-account exploit was produced in the first place.
// The verdict now comes from what the browser says it runs on, and the window
// is not consulted at all.
//
// A source check rather than a behavioural one, because the failure mode is
// somebody ADDING a viewport read for a plausible-sounding reason ("tablets in
// portrait look fine"), and no set of fixtures can catch a signal that is not
// in DeviceSignals yet.
describe('the gate never looks at the window', () => {
  const raw = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'device.ts'), 'utf8');
  // Comments stripped first. The rule is about what the code READS, and a
  // guard that fires on the word "touchscreen." in a sentence is one somebody
  // deletes the first time it cries wolf.
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('reads nothing about the size or shape of the viewport', () => {
    const banned = [
      'innerWidth',
      'innerHeight',
      'outerWidth',
      'outerHeight',
      'clientWidth',
      'clientHeight',
      'matchMedia',
      'orientation',
      'devicePixelRatio',
      'screen.',
      'getBoundingClientRect',
      'ResizeObserver',
    ];
    const found = banned.filter((token) => source.includes(token));
    expect(
      found,
      `src/device.ts consults the window: ${found.join(', ')} — a window is not a device`
    ).toEqual([]);
  });

  it('keeps the desktop bypass out of production builds', () => {
    // `?desktop=1` exists for development. It must stay behind import.meta.env
    // .DEV so the branch is not present in a shipped bundle at all.
    if (!source.includes('desktop')) return;
    // Optional chaining included: the guard is written `import.meta.env?.DEV`.
    expect(source).toMatch(/import\.meta\.env\??\.DEV/);
    // The bypass may read the URL — that is not the viewport, and reading the
    // query string is the whole mechanism — but only from inside that guard.
    const guarded = source.slice(source.indexOf('import.meta.env'));
    expect(guarded).toContain("'desktop'");
  });
});

describe('handing a webview back to the real browser', () => {
  it('builds an Android intent:// url that carries the room code', () => {
    const url = openInRealBrowserUrl(
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 [FBAN/…]',
      'https://phong.example.com/?room=AB12'
    );
    expect(url).toBe(
      'intent://phong.example.com/?room=AB12#Intent;scheme=https;action=android.intent.action.VIEW;end'
    );
  });

  it('offers nothing on iOS, where no supported mechanism exists', () => {
    // x-safari-https:// often works and is undocumented. A player locked out
    // of their account is the last place to spend an unofficial trick, so iOS
    // gets the in-app browser's own menu instead.
    expect(
      openInRealBrowserUrl('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) [FBAN/…]', 'https://p.example.com/')
    ).toBeNull();
  });

  it('refuses anything that is not an ordinary web url', () => {
    const android = 'Mozilla/5.0 (Linux; Android 14) Mobile';
    expect(openInRealBrowserUrl(android, 'javascript:alert(1)')).toBeNull();
    expect(openInRealBrowserUrl(android, 'not a url')).toBeNull();
  });
});
