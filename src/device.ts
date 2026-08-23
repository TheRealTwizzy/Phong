// What kind of device is this, and may it play?
//
// Phong is a two-phone game: the court is half a screen, the net is the top
// edge, and a duel is two handsets laid top-to-top. A desktop cannot play it
// meaningfully and a tablet is the wrong shape and weight for it, so both are
// gated behind a QR code that moves the player to their phone.
//
// The gate this replaces keyed on VIEWPORT SIZE, which is not a device fact —
// it is a window fact. Narrowing a desktop browser window (or zooming out)
// walked straight through it, which is exactly how the concurrent-account
// report was produced. So the verdict here comes from the platform the
// browser reports, and the viewport is not consulted at all.
//
// This is a product gate, not a security boundary: a desktop browser's device
// emulation reports a phone and will be believed. That is fine — nothing here
// grants privileges. What must not be bypassable is playing two matches on
// one account, and that is enforced server-side by the session rules, not
// here.

export type DeviceClass = 'phone' | 'tablet' | 'desktop';

/** Everything the classifier reads, so it can be tested without a browser. */
export interface DeviceSignals {
  userAgent: string;
  /** navigator.maxTouchPoints, with `ontouchstart` folded in as a floor. */
  maxTouchPoints: number;
  /** navigator.userAgentData?.mobile — Chromium only, absent elsewhere. */
  uaDataMobile?: boolean;
}

/**
 * Whether this is an app's embedded browser rather than the phone's own.
 *
 * It matters because a cookie jar does not cross browsers and the web has no
 * device identifier to bridge them. An invitation link tapped in Messenger
 * opens Messenger's webview, which has never met this player: onboarding
 * opens, and their own username comes back taken. Nothing can stop that — but
 * being able to NAME it turns "I got signed out" into "I am in the wrong
 * browser", which is a problem with an obvious fix the player can act on.
 *
 * Detection is by the tokens these apps append to the UA, which is the only
 * signal they offer. It is a hint, not a verdict: a false negative just means
 * the player sees the ordinary copy, and nothing is gated on it.
 */
export function detectInAppBrowser(userAgent: string): string | null {
  const ua = userAgent || '';
  // Facebook's apps (Messenger included) both carry FBAN/FBAV.
  if (/\bFBAN\b|\bFBAV\b|FB_IAB/.test(ua)) return 'Facebook';
  if (/\bInstagram\b/.test(ua)) return 'Instagram';
  if (/\bLine\/|\bLIFF\b/.test(ua)) return 'LINE';
  if (/\bTwitter\b/.test(ua)) return 'Twitter';
  if (/musical_ly|\bBytedance\b|\bTikTok\b/i.test(ua)) return 'TikTok';
  if (/\bSnapchat\b/.test(ua)) return 'Snapchat';
  if (/\bWhatsApp\b/.test(ua)) return 'WhatsApp';
  if (/\bLinkedInApp\b/.test(ua)) return 'LinkedIn';
  // Android's generic WebView marker. Deliberately last and deliberately
  // narrow: "wv" is what a webview adds, and Chrome proper never carries it.
  if (/\bAndroid\b.*;\s*wv\)/.test(ua)) return 'an app';
  return null;
}

/**
 * A URL that hands the current page to the phone's REAL browser, or null when
 * the platform offers no way to do that.
 *
 * Android only, and not for want of trying. An `intent://` URL is Android's
 * documented way for a WebView to hand a request to whatever browser the user
 * has set as default, and it works from inside the in-app browsers that cause
 * this problem. iOS has no supported equivalent: `x-safari-https://` exists
 * and often works, but it is undocumented, has never been blessed by Apple,
 * and can stop working in any release — a recovery path for someone locked out
 * of their account is the last place to spend an unofficial trick, so iOS gets
 * the honest instruction to use the in-app browser's own menu instead.
 */
export function openInRealBrowserUrl(userAgent: string, href: string): string | null {
  if (!/\bAndroid\b/.test(userAgent || '')) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const scheme = url.protocol.slice(0, -1);
  // Everything after the scheme, which is what intent:// carries verbatim.
  const rest = `${url.host}${url.pathname}${url.search}`;
  return `intent://${rest}#Intent;scheme=${scheme};action=android.intent.action.VIEW;end`;
}

export function classifyFromSignals(signals: DeviceSignals): DeviceClass {
  const ua = signals.userAgent || '';
  const touch = signals.maxTouchPoints > 0;

  // iPadOS 13+ deliberately reports itself as "Macintosh" so sites serve it
  // the desktop layout. Touch points are what give it away: no Mac has ever
  // shipped a touchscreen. Checked before the iPhone test because an iPad's
  // UA contains neither "iPhone" nor, in desktop mode, "iPad".
  if (/\biPad\b/.test(ua)) return 'tablet';
  if (/\bMacintosh\b/.test(ua) && signals.maxTouchPoints > 1) return 'tablet';

  if (/\biPhone\b|\biPod\b/.test(ua)) return touch ? 'phone' : 'desktop';

  if (/\bAndroid\b/.test(ua)) {
    // Chromium tells us outright when it knows.
    if (signals.uaDataMobile === true) return 'phone';
    if (signals.uaDataMobile === false) return 'tablet';
    // Android's long-standing convention: a phone build carries "Mobile" in
    // the token, a tablet build drops it.
    return /\bMobile\b/.test(ua) ? 'phone' : 'tablet';
  }

  // Windows Phone is long dead, but costs one test to keep honest.
  if (/Windows Phone|IEMobile/.test(ua)) return 'phone';

  // A Chromium browser that says it is mobile, on a platform not matched
  // above (KaiOS, a niche Android skin). Believe it, but only with touch.
  if (signals.uaDataMobile === true && touch) return 'phone';

  return 'desktop';
}

export function readSignals(): DeviceSignals {
  if (typeof navigator === 'undefined') return { userAgent: '', maxTouchPoints: 0 };
  const uaData = (navigator as unknown as { userAgentData?: { mobile?: boolean } }).userAgentData;
  const points = navigator.maxTouchPoints || 0;
  return {
    userAgent: navigator.userAgent || '',
    // Old iOS Safari reports maxTouchPoints 0 while supporting touch events.
    maxTouchPoints: points || (typeof window !== 'undefined' && 'ontouchstart' in window ? 1 : 0),
    uaDataMobile: uaData?.mobile,
  };
}

export const classifyDevice = (): DeviceClass => classifyFromSignals(readSignals());

/**
 * Dev-only escape hatch, so a contributor can drive the game from a laptop.
 * `import.meta.env.DEV` is resolved at build time, so this branch is not even
 * present in a production bundle — there is no flag to find and no header to
 * forge. See DEVELOPMENT.md.
 */
export function desktopPlayAllowed(): boolean {
  if (!import.meta.env?.DEV) return false;
  try {
    return new URLSearchParams(window.location.search).get('desktop') === '1';
  } catch {
    return false;
  }
}
