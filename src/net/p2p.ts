import { RTCSignalPayload, WSClientMessage, WSServerMessage } from '../types';
import { transformBallForOpponent } from '../../server/transform';

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

  public status: P2PStatus = 'connecting';

  constructor(opts: P2POptions) {
    this.opts = opts;
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

  /** Reset replicated match state; call on every game_start. */
  public resetMatchState(servingPlayer: 0 | 1): void {
    this.scores = [0, 0];
    this.servingPlayer = servingPlayer;
    this.rematchVotes = [false, false];
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

    if (msg.type === 'paddle_move') {
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
      if (msg.type === 'point_scored') this.applyPointScored(msg.scorer);
      if (msg.type === 'rematch_request') this.applyRematchVote(this.opts.myIndex);
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

      case 'ball_cross_net':
        this.opts.onMessage({ type: 'ball_incoming', ball: transformBallForOpponent(msg.ball) });
        break;

      case 'point_scored':
        this.applyPointScored(msg.scorer);
        break;

      case 'quick_chat':
        this.opts.onMessage({
          type: 'quick_chat',
          text: String(msg.text || '').slice(0, 100),
          senderName: msg.senderName || this.opts.playerNames[oppIdx] || 'Opponent',
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
    this.rematchVotes[voterIdx] = true;
    if (this.rematchVotes[0] && this.rematchVotes[1]) {
      const nextServer: 0 | 1 = this.servingPlayer === 0 ? 1 : 0;
      this.resetMatchState(nextServer);
      this.opts.onMessage({ type: 'game_start', servingPlayer: nextServer });
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
