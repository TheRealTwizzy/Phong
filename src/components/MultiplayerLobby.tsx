import React, { useState, useEffect } from 'react';
import { ThemeConfig } from '../game/themes';
import { isLinkableId } from '../profileRules';
import { t } from '../i18n/translations';
import { Button, Panel, QrBlock, Sheet, SegmentedControl, UnlockHintSheet } from './ui';
import { Achievement, LanguageCode, MatchRules, RoomMatchConfig } from '../types';
import { MatchRulesPanel } from './MatchRulesPanel';
import { DEFAULT_ROOM_CONFIG, WINNING_SCORES, normalizeRules } from '../matchRules';
import { hasUnlock, unlockedBy } from '../achievements';
import {
  Copy,
  Check,
  QrCode,
  Smartphone,
  Users,
  Wifi,
  ArrowRight,
  Play,
  User,
  GraduationCap,
} from 'lucide-react';

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
  // A gated match length explains itself on tap, rather than through a title
  // attribute that no touch device renders.
  const [gateHint, setGateHint] = useState<Achievement | null>(null);

  // Check URL query parameters for auto room join (?room=CODE)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomFromUrl = params.get('room');
    if (roomFromUrl && !roomId) {
      setJoinCodeInput(roomFromUrl.toUpperCase());
    }
  }, [roomId]);


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

  // One seat in the room. The handshake used to be two label:value rows and a
  // separate chip; making each seat a row with its own ready state is what
  // turns "who is here and are they ready" into something readable at a
  // glance rather than assembled from three places.
  const PlayerSlot: React.FC<{
    id?: string;
    role: string;
    name: string | null;
    isYou: boolean;
    ready: boolean;
    linkable?: boolean;
    onTap?: () => void;
  }> = ({ id, role, name, isYou, ready, linkable, onTap }) => (
    <div
      className={`flex items-center justify-between gap-2 rounded-card border p-2.5 ${
        name ? 'border-line bg-surface-3' : 'border-dashed border-line-strong bg-surface-1'
      }`}
    >
      <div className="flex min-w-0 flex-col">
        <span className="text-2xs font-normal tracking-normal text-ink-dim uppercase">{role}</span>
        {name ? (
          linkable && onTap ? (
            <button
              id={id}
              onClick={onTap}
              className="truncate text-left text-2xs text-accent underline decoration-dotted underline-offset-2"
            >
              {name}
            </button>
          ) : (
            <span className="truncate text-2xs text-ink">
              {name}
              {isYou && (
                <span className="ml-1 text-ink-dim">({t('lobby_you', language)})</span>
              )}
            </span>
          )
        ) : (
          <span className="animate-ready-pulse truncate text-2xs text-warn">
            {t('lobby_waiting_phone', language)}
          </span>
        )}
      </div>
      {name && (
        <span
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${
            ready ? 'bg-win' : 'animate-ready-pulse bg-warn'
          }`}
          aria-label={ready ? t('opponent_is_ready', language) : t('opponent_not_ready', language)}
        />
      )}
    </div>
  );

  const hostName = playerIndex === 0 ? playerName : opponentName;
  const guestName = playerIndex === 1 ? playerName : opponentName;

  return (
    <>
    <Sheet
      id="multiplayer-lobby-modal"
      isOpen={isOpen}
      onClose={onClose}
      size="md"
      accent="accent"
      // The lobby renders over a LIVE CourtCanvas once room_created flips the
      // screen to 'game'. A backdrop-filter would recomposite a 60fps canvas
      // every frame.
      backdrop="solid"
      dismissOnBackdrop={false}
      closeId="btn-close-lobby"
      closeLabel={t('close', language)}
      icon={<Smartphone className="h-5 w-5" />}
      title={t('mode_multiplayer', language)}
      subtitle={t('lobby_subtitle', language)}
      bodyClassName="scroll-y p-4 flex flex-col gap-3"
      footer={
        roomId ? (
          <>
            <Button id="btn-leave-room" variant="ghost" onClick={onLeaveRoom}>
              {t('lobby_leave', language)}
            </Button>
            {/* The handshake: the guest readies, and only then can the host
                start. game_start is what closes both lobbies — nobody walks
                onto the court until the room says the match exists. */}
            {isHost ? (
              <Button
                id="btn-ready-play"
                variant="primary"
                block
                disabled={!opponentName || !guestReady}
                icon={<Play className="h-3.5 w-3.5 fill-current" />}
                onClick={() => onStartMatch?.()}
              >
                {!opponentName
                  ? t('waiting_for_opponent', language)
                  : guestReady
                    ? t('start_match', language)
                    : t('waiting_for_ready', language)}
              </Button>
            ) : (
              <Button
                id="btn-ready-play"
                variant={myReady ? 'secondary' : 'primary'}
                block
                icon={
                  myReady ? (
                    <Check className="h-3.5 w-3.5 text-win" />
                  ) : (
                    <Play className="h-3.5 w-3.5 fill-current" />
                  )
                }
                onClick={() => onSendReady?.(!myReady)}
              >
                {myReady ? t('ready_waiting_host', language) : t('ready_up', language)}
              </Button>
            )}
          </>
        ) : undefined
      }
    >
        {/* Locked identity — matches always play under the profile username */}
        <div
          id="lobby-playing-as"
          className="flex items-center gap-2 rounded-card border border-line bg-surface-1 px-3 py-2"
        >
          <User className="h-4 w-4 shrink-0 text-accent" />
          <span className="text-2xs font-normal tracking-normal text-ink-muted">
            {t('playing_as', language)}
          </span>
          <span className="truncate text-2xs text-ink">{playerName}</span>
        </div>

        {roomId ? (
          <>
            {/* Share block. The label and the code stay adjacent, in that
                order — #lobby-room-code is what the suites read now. */}
            <Panel variant="raised" className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <span className="text-kicker text-ink-muted uppercase">
                    {t('lobby_room_code', language)}
                  </span>
                  <div
                    id="lobby-room-code"
                    className="text-numeral tnum tracking-[0.2em] text-(--theme-accent)"
                  >
                    {roomId}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    id="btn-copy-link"
                    size="sm"
                    variant="secondary"
                    icon={
                      copied ? (
                        <Check className="h-4 w-4 text-win" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )
                    }
                    onClick={handleCopyLink}
                  >
                    {copied ? t('lobby_copied', language) : t('lobby_copy_link', language)}
                  </Button>
                  <button
                    id="btn-toggle-qr"
                    onClick={() => setShowQR(!showQR)}
                    aria-label={t('lobby_show_qr', language)}
                    aria-pressed={showQR}
                    className="rounded-ctl border border-line bg-surface-3 p-2 text-ink-muted transition-colors hover:text-ink"
                  >
                    <QrCode className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {/* Encoded in-repo: no third party ever sees the room URL. */}
              {showQR && (
                <QrBlock
                  id="lobby-qr"
                  value={shareableUrl}
                  caption={t('lobby_scan_hint', language)}
                />
              )}
            </Panel>

            <div className="flex flex-col gap-2">
              <PlayerSlot
                id="btn-lobby-view-opponent"
                role={t('lobby_host_slot', language)}
                name={hostName}
                isYou={playerIndex === 0}
                ready={readyStates[0]}
                linkable={playerIndex !== 0 && Boolean(opponentLinkable)}
                onTap={() => onViewProfile?.(opponentId!)}
              />
              <PlayerSlot
                id="btn-lobby-view-opponent-2"
                role={t('lobby_guest_slot', language)}
                name={guestName}
                isYou={playerIndex === 1}
                ready={readyStates[1]}
                linkable={playerIndex !== 1 && Boolean(opponentLinkable)}
                onTap={() => onViewProfile?.(opponentId!)}
              />
            </div>

            {/* Pre-match prediction, straight from the server */}
            {opponentName && winProbability !== null && (
              <Panel
                id="lobby-prediction"
                variant="inset"
                className="flex items-center justify-between gap-2"
              >
                <span className="text-2xs font-normal tracking-normal text-ink-muted">
                  {t('win_chance', language)}
                </span>
                <span
                  className={`text-2xs tnum ${
                    winProbability >= 0.6
                      ? 'text-win'
                      : winProbability >= 0.4
                        ? 'text-warn'
                        : 'text-loss'
                  }`}
                >
                  {Math.round(winProbability * 100)}%
                  <span className="ml-1.5 font-normal tracking-normal text-ink-dim">
                    {winProbability >= 0.55
                      ? t('favoured', language)
                      : winProbability <= 0.45
                        ? t('underdog', language)
                        : t('even_match', language)}
                  </span>
                </span>
              </Panel>
            )}

            {isHost && opponentName && (
              <span
                id="lobby-opponent-ready"
                className={`rounded-ctl border px-2.5 py-1.5 text-2xs ${
                  guestReady
                    ? 'border-win/40 bg-win/10 text-win'
                    : 'border-line bg-surface-1 text-ink-muted'
                }`}
              >
                {guestReady
                  ? t('opponent_is_ready', language)
                  : t('opponent_not_ready', language)}
              </span>
            )}

            {/* The room's terms. Set here, by the host, while the other phone
                is still on its way — and readable by the guest, so nobody
                walks into a match whose rules they have not seen. */}
            <div id="lobby-match-settings" className="flex flex-col gap-2 border-t border-line pt-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-kicker text-ink-dim uppercase">
                  {t('match_settings', language)}
                </span>
                {/* Who owns the terms, said plainly. The guest used to get the
                    host's controls looking live but silently disabled. */}
                <span
                  id="lobby-settings-owner"
                  className={`rounded-chip border px-1.5 py-0.5 text-2xs ${
                    isHost
                      ? 'border-accent/40 bg-accent/12 text-accent'
                      : 'border-line bg-surface-3 text-ink-muted'
                  }`}
                >
                  {isHost ? t('lobby_role_host', language) : t('lobby_role_guest', language)}
                </span>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-2xs font-normal tracking-normal text-ink-muted">
                  {t('winning_score', language)}
                </label>
                <SegmentedControl
                  columns={4}
                  ariaLabel={t('winning_score', language)}
                  value={config.winningScore}
                  readOnly={!isHost}
                  onLockTap={setGateHint}
                  onChange={(pts) => onUpdateRoomConfig?.({ winningScore: pts })}
                  options={WINNING_SCORES.map((pts) => ({
                    value: pts,
                    id: `lobby-pts-${pts}`,
                    label: String(pts),
                    lock: (isHost ? scoreOpen(pts) : true)
                      ? null
                      : unlockedBy('winningScore', pts) ?? null,
                  }))}
                />
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
          </>
        ) : (
          <>
            {/* One column. The md: breakpoint this used to carry never fires
                on a phone-only app. */}
            <Panel variant="raised" className="flex flex-col gap-2.5">
              <div>
                <h3 className="flex items-center gap-1.5 text-2xs text-ink">
                  <Wifi className="h-4 w-4 text-accent" />
                  {t('lobby_create_title', language)}
                </h3>
                <p className="mt-1 text-2xs font-normal tracking-normal text-ink-muted">
                  {t('lobby_create_desc', language)}
                </p>
              </div>
              {onToggleP2P && (
                <label
                  id="toggle-p2p"
                  className="flex cursor-pointer items-center justify-between gap-2 text-2xs font-normal tracking-normal text-ink-muted select-none"
                >
                  <span>{t('lobby_p2p', language)}</span>
                  <input
                    type="checkbox"
                    checked={p2pEnabled}
                    onChange={(e) => onToggleP2P(e.target.checked)}
                    className="h-4 w-4 accent-cyan-500"
                  />
                </label>
              )}
              <Button id="btn-create-room" variant="primary" size="lg" block onClick={handleCreate}>
                {t('lobby_host_match', language)}
              </Button>
            </Panel>

            <div className="flex items-center gap-2">
              <span className="h-px flex-1 bg-line" />
              <span className="text-2xs font-normal tracking-normal text-ink-dim uppercase">
                {t('lobby_or', language)}
              </span>
              <span className="h-px flex-1 bg-line" />
            </div>

            <Panel as="section" variant="raised" className="flex flex-col gap-2.5">
              <div>
                <h3 className="flex items-center gap-1.5 text-2xs text-ink">
                  <Users className="h-4 w-4 text-win" />
                  {t('lobby_join_title', language)}
                </h3>
                <p className="mt-1 text-2xs font-normal tracking-normal text-ink-muted">
                  {t('lobby_join_desc', language)}
                </p>
              </div>
              <form onSubmit={handleJoin} className="flex flex-col gap-2">
                {/* A single input, and >=16px: iOS auto-zooms a smaller one and
                    the page stays zoomed afterwards. */}
                <input
                  id="input-room-code"
                  type="text"
                  maxLength={6}
                  value={joinCodeInput}
                  onChange={(e) => setJoinCodeInput(e.target.value.toUpperCase())}
                  placeholder={t('lobby_code_placeholder', language)}
                  aria-label={t('lobby_join_title', language)}
                  className="w-full rounded-ctl border border-line-strong bg-surface-1 px-3 py-2.5 text-center text-base font-bold tracking-[0.3em] text-ink uppercase placeholder:text-ink-dim focus:border-accent focus:outline-none"
                />
                <Button
                  id="btn-join-room-submit"
                  type="submit"
                  variant="primary"
                  size="lg"
                  block
                  disabled={!joinCodeInput.trim()}
                  iconRight={<ArrowRight className="h-3.5 w-3.5" />}
                >
                  {t('lobby_join_game', language)}
                </Button>
              </form>
            </Panel>
          </>
        )}

        <Panel variant="inset" className="flex items-start gap-2">
          <Smartphone className="mt-0.5 h-4 w-4 shrink-0 text-ink-muted" />
          <span className="text-2xs leading-relaxed font-normal tracking-normal text-ink-muted">
            <strong className="text-ink">{t('lobby_tip_label', language)}:</strong>{' '}
            {t('lobby_tip', language)}
          </span>
        </Panel>

        {onOpenTutorial && (
          <Button
            id="btn-lobby-start-tutorial"
            variant="ghost"
            block
            icon={<GraduationCap className="h-4 w-4" />}
            onClick={() => {
              onClose();
              onOpenTutorial();
            }}
          >
            {t('lobby_tutorial', language)}
          </Button>
        )}
      </Sheet>

      <UnlockHintSheet
        achievement={gateHint}
        onClose={() => setGateHint(null)}
        closeLabel={t('close', language)}
      />
    </>
  );
};
