import { beforeEach, describe, expect, it, vi } from 'vitest';

// The persisted per-browser ordering identity: src/net/runChain.ts.
//
// It exists to fix a gap an age cannot: two writes from ONE browser can still
// invert if their own network round trips differ, and a write parked and
// replayed after a reload has no live chain to be serialized through at all.
// A number assigned once, at event time, before any network is involved, and
// persisted so it survives the reload, sidesteps both.

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};

let nextRunSeq: typeof import('../src/net/runChain').nextRunSeq;

beforeEach(async () => {
  store.clear();
  vi.resetModules();
  ({ nextRunSeq } = await import('../src/net/runChain'));
});

describe('nextRunSeq', () => {
  it('rises by one each call and never repeats', () => {
    const seqs = Array.from({ length: 5 }, () => nextRunSeq().runSeq);
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps the same chainId across calls in one session', () => {
    const a = nextRunSeq();
    const b = nextRunSeq();
    expect(b.chainId).toBe(a.chainId);
  });

  it('survives a reload: a fresh module import continues the same chain', () => {
    // The whole point. A page reload re-imports this module from scratch —
    // simulated here by resetting the module registry — and a payload parked
    // before the reload has to stay comparable to what gets assigned after it.
    const before = nextRunSeq();
    expect(before.runSeq).toBe(1);
    return import('../src/net/runChain').then(async () => {
      vi.resetModules();
      const { nextRunSeq: reloaded } = await import('../src/net/runChain');
      const after = reloaded();
      expect(after.chainId).toBe(before.chainId);
      expect(after.runSeq).toBe(2);
    });
  });

  it('starts a fresh chain when storage cannot be read or written', () => {
    // Not a crash, and not silently identical to some other browser's chain:
    // every call in a storage-less session gets its OWN new chainId, so it
    // never accidentally matches anything and always falls back to the age.
    const broken: Storage = {
      getItem: () => {
        throw new Error('no storage');
      },
      setItem: () => {
        throw new Error('no storage');
      },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    };
    (globalThis as any).localStorage = broken;
    const a = nextRunSeq();
    const b = nextRunSeq();
    expect(a.runSeq).toBe(1);
    expect(b.runSeq).toBe(1);
    expect(a.chainId).not.toBe(b.chainId);
    (globalThis as any).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    };
  });
});
