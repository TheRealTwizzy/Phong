import { RoomMatchConfig, RTCSignalPayload, WSClientMessage, WSServerMessage } from '../types';
import { DEFAULT_ROOM_CONFIG } from '../matchRules';
import { transformBallForOpponent } from '../../server/transform';
import {
  StreakState,
  breakStreakOnPoint,
  countReturn,
  startMatchStreaks,
} from '../../server/room';

// Peer-to-peer game link over WebRTC DataChannels.
//
// The relay protocol stays the source of truth: peers exchange the same
// client-message shapes they would send to the server (paddle_move,
// ball_cross_net, point_scored, quick_chat, rematch_request), and this class
// converts them into the exact server-shaped messages the app already
// consumes (opponent_paddle, ball_incoming, score_update, ...). The game code
// never learns which transport delivered a message.
//
// Match state that the relay server normally owns (scores, serving player,
// rematch votes) is replicated symmetrically on both peers with the same
// deterministic rules, so the two phones cannot disagree.
//
// Signaling (SDP offers/answers, ICE candidates) rides the existing
// WebSocket via rtc_signal messages, which the server relays verbatim.
//
// Two channels: "game" is reliable+ordered for events that must arrive
// (ball crossings, points, chat, rematch); "fast" is unordered with no
// retransmits for the 20-30Hz paddle stream, where a lost packet is
// obsolete by the time it could be resent.

export type P2PStatus = 'connecting' | 'p2p' | 'closed';

interface P2POptions {
  myIndex: 0 | 1;
  playerNames: [string, string];
  sendSignal: (payload: RTCSignalPayload) => void;
  onMessage: (msg: WSServerMessage) => void;
  onStatus: (status: P2PStatus) => void;
  iceServers?: RTCIceServer[];
  /** The room's terms, as last broadcast by the relay. */
  config?: RoomMatchConfig;
  /**
   * Report the replica's match state back to the relay over the WebSocket.
   * Nothing about a P2P match otherwise reaches the server, which left it
   * believing every one of them was still 0-0 and never started — so it filed
   * both players a 0-0 loss, could not tell an abandon from a finished match,
   * and kept the room's settings editable mid-rally.
   */
  onMatchSync?: (sync: {
    matchSeq: number;
    p1Score: number;
    p2Score: number;
    bestStreaks: [number, number];
    streaks: [number, number];
    earnedBests: [number, number];
    servingPlayer: 0 | 1;
    crossingsThisPoint: number;
    rev: number;
  }) => void;
}

const CONNECT_TIMEOUT_MS = 8000;

export class P2PGameLink {
  private pc: RTCPeerConnection;
  private gameChannel: RTCDataChannel | null = null;
  private fastChannel: RTCDataChannel | null = null;
  private opts: P2POptions;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  // Signals must apply strictly in order: an ICE candidate racing ahead of
  // setRemoteDescription would be rejected and silently lost.
  private signalQueue: Promise<void> = Promise.resolve();

  // Replicated room state (mirrors the relay server's Room)
  private scores: [number, number] = [0, 0];
  private servingPlayer: 0 | 1 = 0;
  private rematchVotes: [boolean, boolean] = [false, false];
  private matchOver = false;
  /**
   * The relay's own streak rules, replicated exactly — imported rather than
   * re-implemented, because "the replica must agree with the relay" is the one
   * thing this class exists to be true and it has drifted once already.
   */
  private streaks: StreakState = {
    streaks: [0, 0],
    bestStreaks: [0, 0],
    earnedStreaks: [0, 0],
    earnedBests: [0, 0],
    crossingsThisPoint: 0,
    servingPlayer: 0,
  };
  /**
   * Which match of the room this is. Seeded from the relay's game_start and
   * incremented locally for a rematch the peers agree between themselves —
   * which the relay never runs startMatch for, so nothing else would tell the
   * two matches apart when their results are reported.
   */
  private matchSeq = 0;
  // The room's terms still come from the relay — the lobby is always relayed,
  // and the config is fixed for the match once it starts. Held here so the
  // replicated rules end the match on the same number the server would.
  private config: RoomMatchConfig = DEFAULT_ROOM_CONFIG;

  public status: P2PStatus = 'connecting';

  constructor(opts: P2POptions) {
    this.opts = opts;
    if (opts.config) this.config = opts.config;
    this.pc = new RTCPeerConnection({
      iceServers: opts.iceServers?.length
        ? opts.iceServers
        : [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
    });

    this.pc.onicecandidate = (ev) => {
      this.opts.sendSignal({ kind: 'ice', candidate: ev.candidate ? ev.candidate.toJSON() : null });
    };

    this.pc.ondatachannel = (ev) => {
      this.adoptChannel(ev.channel);
    };

    this.pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected', 'closed'].includes(this.pc.connectionState)) {
        this.markClosed();
      }
    };

    this.connectTimer = setTimeout(() => {
      if (this.status !== 'p2p') this.markClosed();
    }, CONNECT_TIMEOUT_MS);
  }

  /** Host side: create the channels and send the offer. */
  public async startAsHost(): Promise<void> {
    this.adoptChannel(this.pc.createDataChannel('game', { ordered: true }));
    this.adoptChannel(this.pc.createDataChannel('fast', { ordered: false, maxRetransmits: 0 }));
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.opts.sendSignal({ kind: 'offer', sdp: offer.sdp });
  }

  /** Both sides: feed rtc_signal payloads relayed by the server. */
  public handleSignal(payload: RTCSignalPayload): Promise<void> {
    this.signalQueue = this.signalQueue.then(() => this.applySignal(payload));
    return this.signalQueue;
  }

  private async applySignal(payload: RTCSignalPayload): Promise<void> {
    if (this.closed) return;
    try {
      if (payload.kind === 'offer' && payload.sdp) {
        await this.pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.opts.sendSignal({ kind: 'answer', sdp: answer.sdp });
      } else if (payload.kind === 'answer' && payload.sdp) {
        await this.pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
      } else if (payload.kind === 'ice') {
        // A null candidate marks end-of-candidates; passing undefined to
        // addIceCandidate signals that to the browser.
        await this.pc.addIceCandidate(payload.candidate ?? undefined);
      }
    } catch (e) {
      console.warn('P2P signaling error (staying on relay):', e);
    }
  }

  public get isOpen(): boolean {
    return this.status === 'p2p' && this.gameChannel?.readyState === 'open';
  }

  /** Keep the replica's terms in step with the relay's room_config. */
  public setConfig(config: RoomMatchConfig): void {
    this.config = config;
  }

  /**
   * Reset replicated match state; call on every game_start.
   *
   * `carried` is each seat's run as the relay has it — a streak carries
   * between matches AND between rooms, and the relay is the only party that
   * knows both sides of that. Starting from zero here reported the peak of
   * only what happened after the reset, which the relay then took a maximum
   * against its own carried value: a run of ten that gained two returns was
   * recorded as ten.
   */
  public resetMatchState(
    servingPlayer: 0 | 1,
    matchSeq?: number,
    carried: [number, number] = [this.streaks.streaks[0], this.streaks.streaks[1]]
  ): void {
    this.scores = [0, 0];
    this.servingPlayer = servingPlayer;
    this.rematchVotes = [false, false];
    this.matchOver = false;
    this.streaks.streaks = [Math.max(0, carried[0] || 0), Math.max(0, carried[1] || 0)];
    startMatchStreaks(this.streaks, servingPlayer);
    // A new match's revisions count from zero, matching the relay's reset.
    this.syncRev = 0;
    // A relayed start names the match; a locally agreed rematch counts on.
    this.matchSeq = matchSeq ?? this.matchSeq + 1;
  }

  /**
   * How many events this match has produced here — a logical clock the relay
   * uses to spot a snapshot that arrives behind one it has already applied.
   * Both peers process the same events in the same order, so the same number
   * means the same moment on either side of the link.
   */
  private syncRev = 0;

  /** Tell the relay where this match has got to. */
  private syncToRelay(): void {
    this.syncRev += 1;
    this.opts.onMatchSync?.({
      matchSeq: this.matchSeq,
      rev: this.syncRev,
      p1Score: this.scores[0],
      p2Score: this.scores[1],
      bestStreaks: [this.streaks.bestStreaks[0], this.streaks.bestStreaks[1]],
      // Where each run IS, not only how high it got. The relay sees no
      // crossings and no points in a P2P match, so this is the only thing that
      // tells it what to carry into the next one.
      streaks: [this.streaks.streaks[0], this.streaks.streaks[1]],
      earnedBests: [this.streaks.earnedBests[0], this.streaks.earnedBests[1]],
      // Where the POINT is, so a handover back to the relay lands mid-rally
      // without it having to guess. If the DataChannel dies, sendGame starts
      // returning false and crossings go to the relay again — which judges
      // them with countReturn, asking "was this the serve?" from exactly these
      // two fields. Stale, the first crossing after the handover is read as a
      // serve and dropped, or a real serve is counted as a return.
      servingPlayer: this.streaks.servingPlayer,
      crossingsThisPoint: this.streaks.crossingsThisPoint,
    });
  }

  /**
   * A ball over the net from `seat` — that player's own return, and their own
   * streak. The relay reaches these numbers from exactly these events, so the
   * replica reaches them the same way, through the same code.
   */
  private countCrossing(seat: 0 | 1): void {
    countReturn(this.streaks, seat);
    // EVERY crossing, not just the first of the point.
    //
    // The first one earns a message on its own — it is what puts the match in
    // play, which is what makes a walk-out an abandon and shuts the lobby's
    // settings. But the relay is also where this match gets recorded, and a
    // DataChannel can die in the middle of a rally: sendGame starts returning
    // false and the rest of the point goes over the relay instead. Synced
    // once per point, the relay resumes from the state it had at crossing one
    // — every return since is simply gone from the streak, the XP, the daily
    // tasks and the performance weight, and the phase it resumes on is wrong
    // by the same amount, so the next relayed crossing is miscounted too.
    //
    // The cost is one small message per net crossing, and only in P2P mode.
    // Relayed play already sends the relay strictly more than this.
    this.syncToRelay();
  }

  /**
   * Try to send a gameplay message peer-to-peer. Returns false when the link
   * is not open — the caller then falls back to the WebSocket relay.
   * Messages that the relay server would answer (point_scored,
   * rematch_request) are also applied locally, since the peer cannot echo
   * anything back to us.
   */
  public sendGame(msg: WSClientMessage): boolean {
    if (!this.isOpen) return false;

    if (msg.type === 'paddle_move' || msg.type === 'ball_pos') {
      if (this.fastChannel?.readyState === 'open') {
        this.fastChannel.send(JSON.stringify(msg));
        return true;
      }
      // Fast channel down but game channel up: better ordered than lost
      this.gameChannel!.send(JSON.stringify(msg));
      return true;
    }

    if (
      msg.type === 'ball_cross_net' ||
      msg.type === 'point_scored' ||
      msg.type === 'quick_chat' ||
      msg.type === 'rematch_request'
    ) {
      this.gameChannel!.send(JSON.stringify(msg));
      if (msg.type === 'ball_cross_net') this.countCrossing(this.opts.myIndex);
      if (msg.type === 'point_scored') this.applyPointScored(msg.scorer);
      if (msg.type === 'rematch_request') this.applyRematchVote(this.opts.myIndex);
      // Note: a rematch_request sent before the replica saw the final point is
      // dropped on BOTH sides by the same rule, so the two stay in step.
      return true;
    }

    // Room management, pings etc. stay on the relay
    return false;
  }

  public close(): void {
    this.markClosed(true);
  }

  private adoptChannel(channel: RTCDataChannel): void {
    if (channel.label === 'game') this.gameChannel = channel;
    else if (channel.label === 'fast') this.fastChannel = channel;
    else return;

    channel.onmessage = (ev) => this.handlePeerMessage(ev.data);
    channel.onopen = () => {
      if (this.gameChannel?.readyState === 'open' && this.status === 'connecting') {
        this.status = 'p2p';
        if (this.connectTimer) clearTimeout(this.connectTimer);
        this.opts.onStatus('p2p');
      }
    };
    channel.onclose = () => this.markClosed();
  }

  private handlePeerMessage(raw: unknown): void {
    let msg: WSClientMessage;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    const oppIdx = this.opts.myIndex === 0 ? 1 : 0;

    switch (msg.type) {
      case 'paddle_move':
        this.opts.onMessage({ type: 'opponent_paddle', x: 1 - msg.x });
        break;

      case 'ball_pos':
        // Sonar telemetry, forwarded in the sender's frame like the relay
        // does — the radar applies the head-to-head mirror itself.
        this.opts.onMessage({
          type: 'opponent_ball',
          x: Math.max(0, Math.min(1, msg.x)),
          y: Math.max(0, Math.min(1, msg.y)),
        });
        break;

      case 'ball_cross_net':
        this.countCrossing(this.opts.myIndex === 0 ? 1 : 0);
        this.opts.onMessage({ type: 'ball_incoming', ball: transformBallForOpponent(msg.ball) });
        break;

      case 'point_scored':
        this.applyPointScored(msg.scorer);
        break;

      case 'quick_chat':
        // The name comes from the LINK's own record of who is on the other
        // end, never from the payload. `WSClientMessage` carries an optional
        // `senderName` and App populates it on every send, so preferring it
        // here let a modified peer render 100 arbitrary characters attributed
        // to an arbitrary username inside its opponent's court — the one
        // thing the relay's own handler is explicit about refusing ("a client
        // message can't impersonate another username", server.ts). The relay
        // and this replica are two implementations of one protocol, and this
        // is exactly the kind of drift tests/protocolParity.test.ts exists
        // for; the field stays on the wire for older bundles and is ignored.
        this.opts.onMessage({
          type: 'quick_chat',
          text: String(msg.text || '').slice(0, 100),
          senderName: this.opts.playerNames[oppIdx] || `Player ${oppIdx + 1}`,
          senderIdx: oppIdx,
        });
        break;

      case 'rematch_request':
        this.applyRematchVote(oppIdx);
        break;
    }
  }

  // Identical rules to the relay server's point_scored handler.
  private applyPointScored(scorer: 'p1' | 'p2'): void {
    const scorerIndex = scorer === 'p1' ? 0 : 1;
    this.scores[scorerIndex]++;
    const nextServer: 0 | 1 = scorerIndex === 0 ? 1 : 0;
    this.servingPlayer = nextServer;
    // The scorer's OPPONENT is the one who missed, so theirs is the only
    // streak that ends. Same rule, same code, as the relay's handler.
    breakStreakOnPoint(this.streaks, scorerIndex, nextServer);
    if (this.scores[scorerIndex] >= this.config.winningScore) {
      this.matchOver = true;
      this.rematchVotes = [false, false];
    }
    // Every point goes to the relay, the last one especially: that report is
    // what has it record the finished duel onto both players' profiles.
    this.syncToRelay();
    this.opts.onMessage({
      type: 'score_update',
      p1Score: this.scores[0],
      p2Score: this.scores[1],
      reason: `Point to ${this.opts.playerNames[scorerIndex] || `Player ${scorerIndex + 1}`}`,
      nextServer,
    });
  }

  // Identical rules to the relay server's rematch_request handler.
  private applyRematchVote(voterIdx: 0 | 1): void {
    // Same rule as the relay: a vote counts only once the replica agrees the
    // match is decided, so a stray press mid-rally cannot bank a vote.
    if (!this.matchOver) return;
    this.rematchVotes[voterIdx] = true;
    if (this.rematchVotes[0] && this.rematchVotes[1]) {
      const nextServer: 0 | 1 = this.servingPlayer === 0 ? 1 : 0;
      // No `carried` argument: a locally agreed rematch continues the runs the
      // replica is already holding, which is exactly what carrying means.
      this.resetMatchState(nextServer);
      this.opts.onMessage({
        type: 'game_start',
        servingPlayer: nextServer,
        config: this.config,
        matchSeq: this.matchSeq,
        streaks: [this.streaks.streaks[0], this.streaks.streaks[1]],
      });
    } else {
      this.opts.onMessage({ type: 'rematch_state', votes: [...this.rematchVotes] });
    }
  }

  private markClosed(silent = false): void {
    if (this.closed) return;
    this.closed = true;
    this.status = 'closed';
    if (this.connectTimer) clearTimeout(this.connectTimer);
    try {
      this.gameChannel?.close();
      this.fastChannel?.close();
      this.pc.close();
    } catch {
      // already closed
    }
    if (!silent) this.opts.onStatus('closed');
  }
}
