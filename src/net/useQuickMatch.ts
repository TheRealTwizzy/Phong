import { useCallback, useState } from 'react';
import { PublicProfile } from '../types';

// The seam a ranked queue drops into.
//
// The menu is built around a Quick Match slot that is deliberately not wired
// to anything yet. Shipping that as a bare disabled button would leave the
// real question — what does the UI do while searching, and what happens when
// a match is found — unanswered until the day someone writes the server side.
// So the CLIENT contract is settled now and implemented against a stub.
//
// When the queue is built, `join`/`cancel`/`accept` send four WS messages and
// `state` is driven by the replies. Nothing above this hook changes: no new
// screens, no layout rework. That is the whole point of the slot.
//
// Deliberately NOT here: any pairing logic. Matchmaking belongs on the relay,
// which is the only participant that can see both players — see the trust
// model in CLAUDE.md §5.

export type QueueState =
  | { status: 'idle' }
  | { status: 'searching'; since: number; etaSeconds?: number }
  /** A match exists and is waiting on this player. `acceptBy` is a deadline. */
  | { status: 'found'; opponent: PublicProfile; acceptBy: number }
  | { status: 'declined' | 'cancelled' | 'unavailable' };

export interface QuickMatch {
  state: QueueState;
  /** Enter the queue. Resolves to `unavailable` until the relay implements it. */
  join: () => void;
  cancel: () => void;
  accept: () => void;
  /** False while the queue does not exist, so the menu can present the slot honestly. */
  available: boolean;
}

export function useQuickMatch(): QuickMatch {
  const [state, setState] = useState<QueueState>({ status: 'idle' });

  const join = useCallback(() => setState({ status: 'unavailable' }), []);
  const cancel = useCallback(() => setState({ status: 'idle' }), []);
  const accept = useCallback(() => setState({ status: 'unavailable' }), []);

  return { state, join, cancel, accept, available: false };
}
