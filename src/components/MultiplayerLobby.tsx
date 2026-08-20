import React, { useState, useEffect } from 'react';
import { ThemeConfig } from '../game/themes';
import { Copy, Check, QrCode, Smartphone, Users, Wifi, ArrowRight, X, Play } from 'lucide-react';

interface MultiplayerLobbyProps {
  isOpen: boolean;
  onClose: () => void;
  theme: ThemeConfig;
  roomId: string | null;
  playerIndex: 0 | 1 | null;
  opponentName: string | null;
  isConnected: boolean;
  currentUsername?: string;
  onCreateRoom: (playerName: string) => void;
  onJoinRoom: (roomId: string, playerName: string) => void;
  onLeaveRoom: () => void;
  onReadyToPlay: () => void;
  onOpenTutorial?: () => void;
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
  onJoinRoom,
  onLeaveRoom,
  onReadyToPlay,
  onOpenTutorial,
}) => {
  const [playerName, setPlayerName] = useState<string>(() => {
    return currentUsername || localStorage.getItem('half_pong_player_name') || `Player ${Math.floor(Math.random() * 900 + 100)}`;
  });

  useEffect(() => {
    if (currentUsername) {
      setPlayerName(currentUsername);
    }
  }, [currentUsername]);
  const [joinCodeInput, setJoinCodeInput] = useState<string>('');
  const [copied, setCopied] = useState<boolean>(false);
  const [showQR, setShowQR] = useState<boolean>(false);

  useEffect(() => {
    localStorage.setItem('half_pong_player_name', playerName);
  }, [playerName]);

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
    onCreateRoom(playerName.trim() || 'Player 1');
  };

  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!joinCodeInput.trim()) return;
    onJoinRoom(joinCodeInput.trim().toUpperCase(), playerName.trim() || 'Player 2');
  };

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

        {/* Player Name Input */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-mono text-zinc-400">YOUR CALLSIGN / NICKNAME</label>
          <input
            id="input-player-name"
            type="text"
            maxLength={14}
            value={playerName}
            onChange={(e) => setPlayerName(e.target.value)}
            placeholder="Enter your name..."
            className="w-full px-3.5 py-2 rounded-xl bg-zinc-900/90 border border-zinc-700 text-white font-mono text-sm focus:outline-none focus:border-cyan-400 transition"
          />
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

            {/* Players Status in Room */}
            <div className="flex flex-col gap-2 pt-2 border-t border-zinc-800 text-xs font-mono">
              <div className="flex items-center justify-between">
                <span className="text-zinc-400">Device 1 (Host / Bottom):</span>
                <span className="font-semibold text-emerald-400">
                  {playerIndex === 0 ? `${playerName} (You)` : opponentName || 'Player 1'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-400">Device 2 (Opponent / Top):</span>
                <span className={`font-semibold ${opponentName || playerIndex === 1 ? 'text-emerald-400' : 'text-amber-400 animate-pulse'}`}>
                  {playerIndex === 1
                    ? `${playerName} (You)`
                    : opponentName
                    ? opponentName
                    : 'Waiting for 2nd phone...'}
                </span>
              </div>
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
              <button
                id="btn-ready-play"
                onClick={() => {
                  onReadyToPlay();
                  onClose();
                }}
                disabled={!opponentName && playerIndex === 0}
                className={`flex-1 py-2.5 rounded-xl font-mono text-xs font-bold flex items-center justify-center gap-1.5 transition active:scale-95 shadow-md ${
                  opponentName || playerIndex === 1
                    ? 'bg-gradient-to-r from-cyan-500 to-blue-600 text-white hover:brightness-110'
                    : 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                }`}
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>{opponentName || playerIndex === 1 ? 'Play Match' : 'Waiting for Opponent'}</span>
              </button>
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
                  className="w-full px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-700 text-center font-mono font-bold text-sm tracking-widest uppercase focus:outline-none focus:border-emerald-400"
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
