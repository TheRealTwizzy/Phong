import { beforeEach, describe, expect, it } from 'vitest';
import { meterOrigin, rememberMeter, resetMeterMemory } from '../src/components/ui/meterMemory';

/**
 * Where a progress meter resumes from, stated here because the browser layer
 * cannot state it.
 *
 * The two meters this exists for live in MainMenu's header, and the case it is
 * built for is the menu → match → menu round trip: App unmounts MainMenu
 * wholesale while a match is on, so the bar that comes back is a fresh mount
 * and used to replay `scaleX: 0 → pct` — a full sweep from empty, at exactly
 * the moment the value had just changed and the MOVEMENT was the thing worth
 * showing. No Playwright suite plays a match and samples a meter on the way
 * back, so this is the only layer that can hold these rules.
 */

describe('meterMemory', () => {
  beforeEach(resetMeterMemory);

  it('resumes a band it has never seen from empty', () => {
    expect(meterOrigin('menu-xp:1')).toBe(0);
  });

  it('reads back what it was told', () => {
    rememberMeter('menu-xp:7', 0.42);
    expect(meterOrigin('menu-xp:7')).toBe(0.42);
  });

  it('clamps to the range a scaleX can mean', () => {
    rememberMeter('over', 1.4);
    rememberMeter('under', -0.3);
    expect(meterOrigin('over')).toBe(1);
    expect(meterOrigin('under')).toBe(0);
  });

  it('drops a non-finite value rather than poisoning the band', () => {
    // NaN compares false against everything, so a poisoned key resumes a bar at
    // `scaleX: NaN` — which paints nothing at all, silently, for the rest of the
    // session. Refusing the write leaves the last good value standing.
    rememberMeter('menu-xp:3', 0.6);
    rememberMeter('menu-xp:3', NaN);
    rememberMeter('menu-xp:3', Infinity);
    expect(meterOrigin('menu-xp:3')).toBe(0.6);
  });

  it('keeps bands apart, so two mounted bars cannot write each other', () => {
    rememberMeter('menu-xp:7', 0.9);
    rememberMeter('rank:ace', 0.1);
    expect(meterOrigin('menu-xp:7')).toBe(0.9);
    expect(meterOrigin('rank:ace')).toBe(0.1);
  });

  it('a level-up is a new band, so the bar fills from empty instead of sweeping backwards', () => {
    // The whole reason the key names a BAND rather than a meter. XP into level 7
    // runs to 0.95 and then a win drops it to 0.05 of level 8 — resumed from the
    // old band, the bar would animate 0.95 → 0.05 and report a level GAINED as a
    // long slide leftward.
    rememberMeter('menu-xp:7', 0.95);
    expect(meterOrigin('menu-xp:8')).toBe(0);
  });

  it('a promotion is a new band too, and placement is a band of its own', () => {
    rememberMeter('rank:placement', 0.8); // 4 of 5 placement games
    rememberMeter('rank:vanguard', 0.9);
    expect(meterOrigin('rank:ace')).toBe(0);
    expect(meterOrigin('rank:placement')).toBe(0.8);
  });

  it('is idempotent, because StrictMode runs the write effect twice on mount', () => {
    rememberMeter('menu-xp:2', 0.33);
    rememberMeter('menu-xp:2', 0.33);
    expect(meterOrigin('menu-xp:2')).toBe(0.33);
  });
});
