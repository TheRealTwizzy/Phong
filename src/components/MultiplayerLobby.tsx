import React, { useState, useEffect } from 'react';
import { ThemeConfig } from '../game/themes';
import { isLinkableId } from '../profileRules';
import { t } from '../i18n/translations';
import { Achievement, LanguageCode, MatchRules, RoomMatchConfig } from '../types';
import { MatchRulesPanel } from './MatchRulesPanel';
import { DEFAULT_ROOM_CONFIG, WINNING_SCORES, normalizeRules } from '../matchRules';
import { hasUnlock, unlockedBy } from '../achievements';
import { Copy, Check, QrCode, Smartphone, Users, Wifi, ArrowRight, X, Play, User, Lock } from 'lucide-react';

interface MultiplayerLobbyProps {
  isOpen: boolean;
  onClose: () => void;
  theme: ThemeConfig;
  roomId: string | null;
  playerIndex: 0 | 1 | null;
  opponentName: string | null;
  isConnected: boolean;
  // The locked-in profile username — matches always play under it; there is
  // no free-text callsign anymore.
  currentUsername?: string;
  onCreateRoom: () => void;
  onJoinRoom: (roomId: string) => void;
  onLeaveRoom: () => void;
  onOpenTutorial?: () => void;
  p2pEnabled?: boolean;
  onToggleP2P?: (enabled: boolean) => void;
  opponentId?: string | null;
  onViewProfile?: (id: string) => void;
  /** Server-computed chance THIS player wins, once the opponent has joined. */
  winProbability?: number | null;
  /**
   * The room's terms. The host edits them here while waiting; the guest reads
   * them. Null before a room exists.
   */
  roomConfig?: RoomMatchConfig | null;
  onUpdateRoomConfig?: (patch: Partial<RoomMatchConfig>) => void;
  /** The lobby handshake as the server last broadcast it: [host, guest]. */
  readyStates?: [boolean, boolean];
  /** Guest: signal (or withdraw) readiness. */
  onSendReady?: (ready: boolean) => void;
  /** Host: start the match — only meaningful once the guest has readied. */
  onStartMatch?: () => void;
  /** The host's own achievements, so the length picker gates as the menu does. */
  earnedAchievements?: string[];
  language?: LanguageCode;
}

export const MultiplayerLobby: React.FC<MultiplayerLobbyProps> = ({
  isOpen,
  onClose,
  theme,
  roomId,
  playerIndex,
  opponentName,
  isConnected,
  currentUsername,
  onCreateRoom,
  p2pEnabled = true,
  onToggleP2P,
  onJoinRoom,
  onLeaveRoom,
  onOpenTutorial,
  opponentId = null,
  onViewProfile,
  winProbability = null,
  roomConfig = null,
  onUpdateRoomConfig,
  readyStates = [false, false],
  onSendReady,
  onStartMatch,
  earnedAchievements = [],
  language = 'en',
}) => {
  const playerName = currentUsername || 'Player';
  const [joinCodeInput, setJoinCodeInput] = useState<string>('');
  const [copied, setCopied] = useState<boolean>(false);
  const [showQR, setShowQR] = useState<boolean>(false);

  // Check URL query parameters for auto room join (?room=CODE)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomFromUrl = params.get('room');
    if (roomFromUrl && !roomId) {
      setJoinCodeInput(roomFromUrl.toUpperCase());
    }
  }, [roomId]);

  if (!isOpen) return null;

  const shareableUrl = roomId
    ? `${window.location.origin}${window.location.pathname}?room=${roomId}`
    : '';

  const handleCopyLink = () => {
    if (!shareableUrl) return;
    navigator.clipboard.writeText(shareableUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCreate = () => {
    onCreateRoom();
  };

  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!joinCodeInput.trim()) return;
    onJoinRoom(joinCodeInput.trim().toUpperCase());
  };

  const opponentLinkable = onViewProfile && isLinkableId(opponentId);
  // The host owns the room's terms; the guest sees exactly the same panel
  // with every control disabled.
  const isHost = playerIndex === 0;
  const config = roomConfig || DEFAULT_ROOM_CONFIG;
  const guestReady = readyStates[1];
  const myReady = playerIndex !== null ? readyStates[playerIndex] : false;
  const scoreOpen = (pts: number) => hasUnlock(earnedAchievements, 'winningScore', pts);

  return (
    <div
      id="multiplayer-lobby-modal"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200"
    >
      <div
        className="w-full max-w-md rounded-2xl border p-6 shadow-2xl relative flex flex-col gap-5 text-zinc-100"
        style={{
          backgroundColor: '#10141e',
          borderColor: theme.accentColor + '50',
          boxShadow: `0 0 30px ${theme.accentColor}20`,
        }}
      >
        {/* Close Button */}
        <button
          id="btn-close-lobby"
          onClick={onClose}
          className="absolute top-4 right-4 p-1.5 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-zinc-400 hover:text-white transition"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Header */}
        <div className="flex items-center gap-3">
          <div
            className="p-3 rounded-xl border flex items-center justify-center"
            style={{
              backgroundColor: theme.accentColor + '15',
              borderColor: theme.accentColor + '40',
              color: theme.accentColor,
            }}
          >
            <Smartphone className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-lg font-bold font-mono tracking-wide flex items-center gap-2">
              2-PHONE MULTIPLAYER
            </h2>
            <p className="text-xs text-zinc-400">
              Each phone displays one half of the court. Cross the net to reach the opponent!
            </p>
          </div>
        </div>

        {/* Locked identity — matches always play under the profile username */}
        <div
          id="lobby-playing-as"
          className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-zinc-900/90 border border-zinc-800"
        >
          <User className="w-4 h-4 text-cyan-400 shrink-0" />
          <span className="text-xs font-mono text-zinc-400">{t('playing_as', language)}</span>
          <span className="text-sm font-mono font-bold text-white truncate">{playerName}</span>
        </div>

        {/* Active Room View */}
        {roomId ? (
          <div className="flex flex-col gap-4 p-4 rounded-xl bg-zinc-900/70 border border-zinc-800">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-[11px] font-mono text-zinc-400">ROOM CODE</span>
                <div className="text-3xl font-black font-mono tracking-widest" style={{ color: theme.accentColor }}>
                  {roomId}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  id="btn-copy-link"
                  onClick={handleCopyLink}
                  className="px-3 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs font-mono flex items-center gap-1.5 transition active:scale-95"
                >
                  {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                  <span>{copied ? 'Copied Link' : 'Copy Link'}</span>
                </button>
                <button
                  id="btn-toggle-qr"
                  onClick={() => setShowQR(!showQR)}
                  className="p-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs font-mono transition"
                  title="Show QR Code"
                >
                  <QrCode className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* QR Code view */}
            {showQR && (
              <div className="flex flex-col items-center justify-center p-3 bg-white rounded-xl shadow-inner my-1">
                <img
                  src={`https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(shareableUrl)}`}
                  alt="Room QR Code"
                  className="w-36 h-36 rounded"
                />
                <span className="text-[10px] font-mono text-zinc-700 mt-1">
                  Scan with 2nd phone camera to join
                </span>
              </div>
            )}

            {/* Players Status in Room (opponent name taps to their profile) */}
            <div className="flex flex-col gap-2 pt-2 border-t border-zinc-800 text-xs font-mono">
              <div className="flex items-center justify-between">
                <span className="text-zinc-400">Device 1 (Host / Bottom):</span>
                {playerIndex !== 0 && opponentLinkable ? (
                  <button
                    id="btn-lobby-view-opponent"
                    onClick={() => onViewProfile!(opponentId!)}
                    className="font-semibold text-cyan-300 underline decoration-dotted underline-offset-2 active:scale-95 transition"
                  >
                    {opponentName || 'Player 1'}
                  </button>
                ) : (
                  <span className="font-semibold text-emerald-400">
                    {playerIndex === 0 ? `${playerName} (You)` : opponentName || 'Player 1'}
                  </span>
                )}
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-400">Device 2 (Opponent / Top):</span>
                {playerIndex !== 1 && opponentName && opponentLinkable ? (
                  <button
                    id="btn-lobby-view-opponent-2"
                    onClick={() => onViewProfile!(opponentId!)}
                    className="font-semibold text-cyan-300 underline decoration-dotted underline-offset-2 active:scale-95 transition"
                  >
                    {opponentName}
                  </button>
                ) : (
                  <span className={`font-semibold ${opponentName || playerIndex === 1 ? 'text-emerald-400' : 'text-amber-400 animate-pulse'}`}>
                    {playerIndex === 1
                      ? `${playerName} (You)`
                      : opponentName
                      ? opponentName
                      : 'Waiting for 2nd phone...'}
                  </span>
                )}
              </div>
            </div>

            {/* Pre-match prediction, straight from the server */}
            {opponentName && winProbability !== null && (
              <div
                id="lobby-prediction"
                className="flex items-center justify-between pt-2 border-t border-zinc-800 text-xs font-mono"
              >
                <span className="text-zinc-400">{t('win_chance', language)}</span>
                <span
                  className={`font-bold ${
                    winProbability >= 0.6
                      ? 'text-emerald-400'
                      : winProbability >= 0.4
                        ? 'text-amber-400'
                        : 'text-rose-400'
                  }`}
                >
                  {Math.round(winProbability * 100)}%
                  <span className="ml-1.5 text-[10px] text-zinc-500">
                    {winProbability >= 0.55
                      ? t('favoured', language)
                      : winProbability <= 0.45
                        ? t('underdog', language)
                        : t('even_match', language)}
                  </span>
                </span>
              </div>
            )}

            {isHost && opponentName && (
              <div
                id="lobby-opponent-ready"
                className={`px-2.5 py-1.5 rounded-lg text-[10px] font-mono border ${
                  guestReady
                    ? 'bg-emerald-950/40 text-emerald-300 border-emerald-900/60'
                    : 'bg-zinc-900/60 text-zinc-400 border-zinc-800'
                }`}
              >
                {guestReady
                  ? t('opponent_is_ready', language)
                  : t('opponent_not_ready', language)}
              </div>
            )}

            {/* The room's terms. Set here, by the host, while the other phone
                is still on its way — and readable by the guest, so nobody
                walks into a match whose rules they have not seen. */}
            <div id="lobby-match-settings" className="flex flex-col gap-2 pt-2 border-t border-zinc-800">
              <div className="flex items-center justify-between">
                <span className="text-[9px] font-mono font-bold text-zinc-500 uppercase tracking-widest">
                  {t('match_settings', language)}
                </span>
                <span
                  id="lobby-settings-owner"
                  className="text-[9px] font-mono text-zinc-500"
                >
                  {isHost ? t('lobby_you_set_terms', language) : t('lobby_host_sets_terms', language)}
                </span>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-[10px] font-mono text-zinc-400">{t('winning_score', language)}</label>
                <div className="grid grid-cols-4 gap-1.5">
                  {WINNING_SCORES.map((pts) => {
                    const open = isHost ? scoreOpen(pts) : true;
                    const gate: Achievement | null = open ? null : unlockedBy('winningScore', pts);
                    const selected = config.winningScore === pts;
                    return (
                      <button
                        key={pts}
                        id={`lobby-pts-${pts}`}
                        disabled={!isHost || !open}
                        title={gate ? `${gate.title} — ${gate.description}` : undefined}
                        onClick={() => onUpdateRoomConfig?.({ winningScore: pts })}
                        className={`py-1.5 rounded-lg text-[10px] font-mono border transition flex items-center justify-center gap-1 ${
                          !open
                            ? 'border-zinc-800 bg-zinc-950/70 text-zinc-600 cursor-not-allowed'
                            : selected
                              ? 'border-cyan-400 bg-cyan-950/60 text-cyan-200 font-bold'
                              : 'border-zinc-800 bg-zinc-900/60 text-zinc-400'
                        } ${!isHost ? 'cursor-default' : ''}`}
                      >
                        {!open && <Lock className="w-2.5 h-2.5" />}
                        {pts}
                      </button>
                    );
                  })}
                </div>
              </div>

              <MatchRulesPanel
                rules={config.rules}
                onUpdateRules={(patch: Partial<MatchRules>) =>
                  onUpdateRoomConfig?.({ rules: normalizeRules({ ...config.rules, ...patch }) })
                }
                lang={language}
                mode="multiplayer"
                readOnly={!isHost}
                idPrefix="lobby"
              />
            </div>

            {/* Action buttons */}
            <div className="flex items-center gap-2 pt-2">
              <button
                id="btn-leave-room"
                onClick={onLeaveRoom}
                className="flex-1 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-mono text-xs transition active:scale-95"
              >
                Leave Room
              </button>
              {/* The handshake: the guest readies, and only then can the
                  host start. game_start is what closes both lobbies — nobody
                  walks onto the court until the room says the match exists. */}
              {isHost ? (
                <button
                  id="btn-ready-play"
                  onClick={() => onStartMatch?.()}
                  disabled={!opponentName || !guestReady}
                  className={`flex-1 py-2.5 rounded-xl font-mono text-xs font-bold flex items-center justify-center gap-1.5 transition active:scale-95 shadow-md ${
                    opponentName && guestReady
                      ? 'bg-gradient-to-r from-cyan-500 to-blue-600 text-white hover:brightness-110'
                      : 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                  }`}
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>
                    {!opponentName
                      ? t('waiting_for_opponent', language)
                      : guestReady
                        ? t('start_match', language)
                        : t('waiting_for_ready', language)}
                  </span>
                </button>
              ) : (
                <button
                  id="btn-ready-play"
                  onClick={() => onSendReady?.(!myReady)}
                  className={`flex-1 py-2.5 rounded-xl font-mono text-xs font-bold flex items-center justify-center gap-1.5 transition active:scale-95 shadow-md ${
                    myReady
                      ? 'bg-emerald-600 text-white hover:brightness-110'
                      : 'bg-gradient-to-r from-cyan-500 to-blue-600 text-white hover:brightness-110'
                  }`}
                >
                  {myReady ? <Check className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 fill-current" />}
                  <span>{myReady ? t('ready_waiting_host', language) : t('ready_up', language)}</span>
                </button>
              )}
            </div>
          </div>
        ) : (
          /* Create or Join Options */
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {/* Create Room Box */}
            <div className="flex flex-col justify-between p-4 rounded-xl bg-zinc-900/60 border border-zinc-800 gap-3">
              <div>
                <h3 className="text-sm font-bold font-mono text-cyan-400 flex items-center gap-1.5">
                  <Wifi className="w-4 h-4" />
                  CREATE ROOM
                </h3>
                <p className="text-xs text-zinc-400 mt-1">
                  Start a match and share the code or QR with a friend on another device.
                </p>
              </div>
              {onToggleP2P && (
                <label
                  id="toggle-p2p"
                  className="flex items-center justify-between gap-2 text-[11px] font-mono text-zinc-400 cursor-pointer select-none"
                  title="Connect the two devices directly (WebRTC). Falls back to the server relay automatically if a direct link can't be established."
                >
                  <span>Direct connect (P2P)</span>
                  <input
                    type="checkbox"
                    checked={p2pEnabled}
                    onChange={(e) => onToggleP2P(e.target.checked)}
                    className="accent-cyan-500 w-4 h-4"
                  />
                </label>
              )}
              <button
                id="btn-create-room"
                onClick={handleCreate}
                className="w-full py-2.5 rounded-xl font-mono text-xs font-bold bg-cyan-500 hover:bg-cyan-400 text-zinc-950 transition active:scale-95"
              >
                Host Match
              </button>
            </div>

            {/* Join Room Box */}
            <form
              onSubmit={handleJoin}
              className="flex flex-col justify-between p-4 rounded-xl bg-zinc-900/60 border border-zinc-800 gap-3"
            >
              <div>
                <h3 className="text-sm font-bold font-mono text-emerald-400 flex items-center gap-1.5">
                  <Users className="w-4 h-4" />
                  JOIN ROOM
                </h3>
                <p className="text-xs text-zinc-400 mt-1">
                  Enter 4-letter room code from your friend's screen.
                </p>
              </div>

              <div className="flex flex-col gap-2">
                <input
                  id="input-room-code"
                  type="text"
                  maxLength={6}
                  value={joinCodeInput}
                  onChange={(e) => setJoinCodeInput(e.target.value.toUpperCase())}
                  placeholder="CODE (e.g. AB12)"
                  className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-700 text-center font-mono font-bold text-base tracking-widest uppercase focus:outline-none focus:border-emerald-400"
                />
                <button
                  id="btn-join-room-submit"
                  type="submit"
                  disabled={!joinCodeInput.trim()}
                  className={`w-full py-2.5 rounded-xl font-mono text-xs font-bold flex items-center justify-center gap-1 transition active:scale-95 ${
                    joinCodeInput.trim()
                      ? 'bg-emerald-500 hover:bg-emerald-400 text-zinc-950'
                      : 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                  }`}
                >
                  <span>Join Game</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Info Explainer & Start Tutorial */}
        <div className="flex flex-col gap-2">
          <div className="p-3 rounded-xl bg-zinc-900/40 border border-zinc-800/80 text-[11px] text-zinc-400 flex items-start gap-2">
            <Smartphone className="w-4 h-4 text-zinc-300 shrink-0 mt-0.5" />
            <span>
              <strong>Pro Tip:</strong> Place two phones end-to-end facing each other! When you smash the ball over the net, it jumps instantaneously across screens onto your opponent's phone.
            </span>
          </div>

          {onOpenTutorial && (
            <button
              id="btn-lobby-start-tutorial"
              onClick={() => {
                onClose();
                onOpenTutorial();
              }}
              className="w-full py-2 rounded-xl bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 text-xs font-mono font-bold flex items-center justify-center gap-2 transition active:scale-95"
            >
              <span>🎓 Practice First? Start Interactive Tutorial</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
