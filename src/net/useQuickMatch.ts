import { useCallback, useRef, useState } from 'react';
import { PublicProfile, WSClientMessage, WSServerMessage } from '../types';

// The ranked queue, client side.
//
// This was the seam a queue would one day drop into — a stub with
// `available: false` so the menu could present the slot honestly rather than
// as a broken button. The relay implements it now, and the contract settled
// back then held: `join`/`cancel` send, `state` is driven by the replies, and
// nothing above this hook needed a new screen or a layout change.
//
// `accept` survives as a documented no-op, and `declined` as an unreachable
// status. A found match is not offered to be accepted: the relay seats the
// pair and starts the match itself. Queueing is the consent, because a queue
// table plays ONE fixed, disclosed config that nobody can change — which is
// exactly what the guest-ready handshake exists to protect against elsewhere
// ("a yes to old rules is not a yes to new ones"). They are kept rather than
// deleted because the union is the frozen contract and an unreachable arm
// costs nothing, where a changed shape costs every call site.
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
  /** Enter the queue. */
  join: () => void;
  cancel: () => void;
  /** Unreachable in v1: a found match starts itself. See the note above. */
  accept: () => void;
  /** Back to idle without telling the relay — for when the match has begun. */
  reset: () => void;
  /** Feed the relay's `queue_state` in. Called by App's dispatch. */
  apply: (msg: Extract<WSServerMessage, { type: 'queue_state' }>) => void;
  available: boolean;
}

export interface QuickMatchOptions {
  send: (msg: WSClientMessage) => void;
  /** This page's last measured round trip, sent as a pairing tiebreak hint. */
  rttMs?: number;
}

export function useQuickMatch({ send, rttMs }: QuickMatchOptions): QuickMatch {
  const [state, setState] = useState<QueueState>({ status: 'idle' });
  // Read through a ref so `join` does not change identity every time the ping
  // does — App re-renders once per animation frame while a ball is in play.
  const rttRef = useRef<number | undefined>(rttMs);
  rttRef.current = rttMs;
  const sendRef = useRef(send);
  sendRef.current = send;

  const join = useCallback(() => {
    // Optimistic, so the spinner starts on the tap rather than a round trip
    // later. The relay's own `searching` reply keeps whichever `since` is
    // already showing, so the elapsed counter never jumps backwards.
    setState((prev) => (prev.status === 'searching' ? prev : { status: 'searching', since: Date.now() }));
    sendRef.current({ type: 'queue_join', rttMs: rttRef.current });
  }, []);

  const cancel = useCallback(() => {
    setState({ status: 'idle' });
    sendRef.current({ type: 'queue_cancel' });
  }, []);

  const accept = useCallback(() => {
    /* No-op: a found match starts itself. See the note at the top. */
  }, []);

  const reset = useCallback(() => setState({ status: 'idle' }), []);

  const apply = useCallback((msg: Extract<WSServerMessage, { type: 'queue_state' }>) => {
    setState((prev) => {
      if (msg.status === 'cancelled') return { status: 'idle' };
      if (msg.status === 'found' && msg.opponent) {
        // `acceptBy` is now: there is nothing to accept, and a deadline in the
        // future would make a countdown out of a beat that lasts one message.
        return { status: 'found', opponent: msg.opponent, acceptBy: Date.now() };
      }
      return prev.status === 'searching' ? prev : { status: 'searching', since: Date.now() };
    });
  }, []);

  return { state, join, cancel, accept, reset, apply, available: true };
}
