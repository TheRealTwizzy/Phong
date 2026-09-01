import React, { useState, useEffect } from 'react';
import { Cosmetic } from '../game/cosmetics';
import { isLinkableId } from '../profileRules';
import { t } from '../i18n/translations';
import { Button, Panel, Sheet, SegmentedControl, UnlockHintSheet } from './ui';
import {
  Achievement,
  AIDifficulty,
  LanguageCode,
  MatchRules,
  RoomMatchConfig,
  TableSeat,
  TableSeatInfo,
} from '../types';
import { MatchRulesPanel } from './MatchRulesPanel';
import { DEFAULT_ROOM_CONFIG, WINNING_SCORES, normalizeRules } from '../matchRules';
import { hasUnlock, unlockedBy } from '../achievements';
import { DEFAULT_VENUE_ROOM, roomAllowsSpectators, roomsOf } from '../venues';
import {
  Bot,
  Check,
  Copy,
  Share2,
  Smartphone,
  Users,
  Wifi,
  ArrowRight,
  Play,
  User,
  RefreshCw,
  Eye,
} from 'lucide-react';

/**
 * The localized name of an AI rung.
 *
 * Reads the SOLO building's own room labels rather than a second dictionary
 * of five: the rung a host seats here is the same rung the menu's Solo
 * building lists, and two spellings of one name is one of them going stale.
 */
const rungLabelKey = (d: AIDifficulty): string =>
  roomsOf('solo').find((r) => r.difficulty === d)?.labelKey ?? 'mode_solo';

interface MultiplayerLobbyProps {
  /** Position in App's open-sheet stack; forwarded to Sheet. See Sheet's `stack`. */
  stack?: { index: number; count: number };

  isOpen: boolean;
  onClose: () => void;
  theme: Cosmetic;
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
  /**
   * The venue room the player walked in from, or null for the bare invite
   * flow. Present means the browser above is shown: a bracket lists its own
   * open tables, and "host a match" there creates a PUBLIC one.
   */
  venueRoomId?: string | null;
  tables?: TableSummary[];
  tablesLoading?: boolean;
  onRefreshTables?: () => void;
  /** Take a watching seat at a table rather than a playing one. */
  onWatchTable?: (roomId: string) => void;
  /** Who is sitting where at the table this player is at, or null. */
  tableState?: {
    seats: TableSeatInfo[];
    yourSeat: TableSeat | null;
    spectatorsEnabled: boolean;
    /** The venue this TABLE is in, which `venueRoomId` above is not. */
    venueRoomId?: string;
  } | null;
  /** Move to another seat at this table. Refused server-side once a match is on. */
  onSwapSeat?: (seat: TableSeat) => void;
  /** Whether this table is locked, and the key that opens it if it is. */
  isPrivate?: boolean;
  joinKey?: string | null;
  /** Host-only, pre-match. Turning it ON always mints a FRESH key. */
  onSetPrivate?: (isPrivate: boolean) => void;
  /**
   * This player's VISIBLE ladder rating, for the ranked badge.
   *
   * Only ever read for a CPU table, where the match is judged as the solo
   * match it is: a rung the host has climbed past moves no rating, and the
   * badge has to say so here exactly as the menu's pre-match sheet does. A
   * duel rates on its rules and its venue, so this is unread on that path.
   */
  rankMu?: number;
}

/** One row of the table browser, as GET /api/rooms/:venue/tables returns it. */
export interface TableSummary {
  id: string;
  hostName: string | null;
  hostId: string | null;
  playerCount: number;
  isFull: boolean;
  inPlay: boolean;
  waitingMs: number | null;
  /** Whether this table opens its two watching seats at all. */
  spectatorsEnabled?: boolean;
  spectatorCount?: number;
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
  venueRoomId = null,
  tables = [],
  tablesLoading = false,
  onRefreshTables,
  onWatchTable,
  tableState = null,
  onSwapSeat,
  isPrivate = false,
  joinKey = null,
  onSetPrivate,
  rankMu,
  stack,
}) => {
  const playerName = currentUsername || 'Player';
  const [copied, setCopied] = useState<boolean>(false);
  // Feature-detected once: a device with no share sheet gets no share button
  // rather than one that silently does nothing.
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const [joinCodeInput, setJoinCodeInput] = useState<string>('');
  // A gated match length explains itself on tap, rather than through a title
  // attribute that no touch device renders.
  const [gateHint, setGateHint] = useState<Achievement | null>(null);
  // Which playing seat the host is filling, or null. A seat rather than a
  // boolean because the host is not always at seat 0 any more — `join_room`
  // takes the first free PLAYING seat, so a newcomer adopting a hostless
  // table sits at 0 and the chair they are filling is 1, but a table adopted
  // the other way round exists too.
  const [cpuSeatPicker, setCpuSeatPicker] = useState<0 | 1 | null>(null);

  // Check URL query parameters for auto room join (?room=CODE)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomFromUrl = params.get('room');
    if (roomFromUrl && !roomId) {
      setJoinCodeInput(roomFromUrl.toUpperCase());
    }
  }, [roomId]);


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
  const difficultyOpen = (d: AIDifficulty) => hasUnlock(earnedAchievements, 'difficulty', d);
  // The five rungs, named by the SOLO building's own room labels rather than
  // by five new keys: the same rung must read the same word in both places,
  // and a second dictionary entry for it is a second thing to drift.
  const RUNGS = roomsOf('solo')
    .map((r) => r.difficulty)
    .filter((d): d is AIDifficulty => !!d);

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
      stack={stack}
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
      // The one screen whose entire purpose is waiting on a network, and it
      // said nothing about the network: `isConnected` was declared,
      // destructured and never read. A player watching a room code with a dead
      // socket had no way to tell that from a friend who had not typed it yet.
      subtitle={isConnected ? t('lobby_subtitle', language) : t('lobby_offline', language)}
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
                // A machine in the chair needs no Ready tap: seating it IS the
                // yes, and there is nobody to ask. Without this arm the relay
                // accepts the start and the button that would send it stays
                // disabled forever, waiting on an `opponentName` only
                // `room_joined`/`opponent_joined` ever set — the feature not
                // working at all, with nothing on screen to say why.
                disabled={config.cpu ? false : !opponentName || !guestReady}
                icon={<Play className="h-3.5 w-3.5 fill-current" />}
                onClick={() => onStartMatch?.()}
              >
                {config.cpu
                  ? t('start_match', language)
                  : !opponentName
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
            {/* The lock, and the key it mints.
                A table is OPEN by default: it is listed in its room's browser
                and anyone in the bracket can sit down, so there is nothing to
                share and nothing to copy. Locking it takes it out of the
                listing and mints a 4-character key, which is then the only way
                in — the room id is how the relay indexes the table, not a door.
                Turning the lock on again re-keys it, so a key already given
                out stops working: sharing one is a decision you can take back.

                This replaced a Copy Link button and a QR block. Both handed
                out a URL that outlived any decision to share it, and neither
                could be revoked. */}
            {/* The table's identity is an attribute, not a line of text. It
                is real — the relay indexes the table by it and it appears in
                GET /api/room/:id — but it is not a door for a locked table and
                must not read as one. The only code-like TEXT here is the key,
                and only while the lock is on. */}
            <Panel
              id="lobby-table"
              data-room-id={roomId}
              variant="raised"
              className="flex flex-col gap-3"
            >
              <label
                id="toggle-private"
                data-on={isPrivate ? 'true' : 'false'}
                data-readonly={isHost ? 'false' : 'true'}
                className={`flex items-center justify-between gap-2 text-2xs font-normal tracking-normal text-ink-muted select-none ${
                  isHost ? 'cursor-pointer' : 'opacity-60'
                }`}
              >
                <span>{t('lobby_private', language)}</span>
                <input
                  type="checkbox"
                  checked={isPrivate}
                  disabled={!isHost}
                  onChange={(e) => onSetPrivate?.(e.target.checked)}
                  className="h-4 w-4 accent-accent"
                />
              </label>

              {isPrivate ? (
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className="text-kicker text-ink-muted uppercase">
                      {t('lobby_room_key', language)}
                    </span>
                    <div
                      id="lobby-room-code"
                      className="text-numeral tnum tracking-[0.2em] text-accent"
                    >
                      {joinKey || '····'}
                    </div>
                    <p className="mt-1 text-2xs font-normal tracking-normal text-ink-dim">
                      {t('lobby_key_hint', language)}
                    </p>
                  </div>
                  {/* The key and NOTHING else — no URL, no sentence around it.
                      A link is a credential that outlives the decision to
                      share it and cannot be taken back; four characters the
                      host can re-mint is the whole design. `navigator.share`
                      is offered only where the device actually has one. */}
                  {joinKey && (
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button
                        id="btn-copy-key"
                        size="sm"
                        variant="secondary"
                        icon={
                          copied ? (
                            <Check className="h-4 w-4 text-win" />
                          ) : (
                            <Copy className="h-4 w-4" />
                          )
                        }
                        onClick={() => {
                          navigator.clipboard?.writeText(joinKey);
                          setCopied(true);
                          setTimeout(() => setCopied(false), 2000);
                        }}
                      >
                        {copied ? t('lobby_copied', language) : t('lobby_copy_key', language)}
                      </Button>
                      {canShare && (
                        <button
                          id="btn-share-key"
                          onClick={() => {
                            // `text` alone. Passing `url` as well is what turns
                            // a share into a link, which is the thing this
                            // replaced.
                            navigator.share?.({ text: joinKey }).catch(() => {});
                          }}
                          aria-label={t('lobby_share_key', language)}
                          className="rounded-ctl border border-line bg-surface-3 p-2 text-ink-muted transition-colors hover:text-ink"
                        >
                          <Share2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <p id="lobby-open-hint" className="text-2xs font-normal tracking-normal text-ink-dim">
                  {t('lobby_open_hint', language)}
                </p>
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

            {/* Who is sitting where, and the way to move.
                A free seat is a tap target and an occupied one is not: a swap
                is only ever a MOVE to an empty chair, never an exchange with
                somebody who did not ask. The relay refuses everything else —
                a seat taken, a table with no watching seats, and above all any
                move touching a playing seat once the match is on, because
                "stand up, look at the hidden half, sit back down" is a
                two-second cheat in a game whose whole premise is the blind
                half-court. */}
            {tableState && onSwapSeat && (
              <div id="lobby-seats" className="flex flex-col gap-1.5">
                <span className="text-kicker text-ink-dim uppercase">{t('lobby_seats', language)}</span>
                <div className="grid grid-cols-2 gap-1.5">
                  {tableState.seats.map((info) => {
                    const mine = tableState.yourSeat === info.seat;
                    const free = info.playerId === null;
                    const watchSeat = info.seat >= 2;
                    const cpuHere = info.occupant === 'cpu';
                    // The OPPONENT chair, from the host's side: the other
                    // playing seat, filled by a machine or by nobody. Tapping
                    // it picks who sits there rather than swapping into it —
                    // and a swap into it was never available anyway, since
                    // `swap_seat` refuses any move that would leave nobody
                    // playing, so the host tapping the only other playing
                    // seat at their own table was a guaranteed error message.
                    const opponentChair =
                      isHost && !watchSeat && !mine && (free || cpuHere) && !!onUpdateRoomConfig;
                    const tappable = opponentChair || (info.enabled && free && !mine);
                    return (
                      <button
                        key={info.seat}
                        id={`seat-${info.seat}`}
                        data-mine={mine ? 'true' : 'false'}
                        data-free={free ? 'true' : 'false'}
                        data-occupant={info.occupant ?? (free ? 'none' : 'human')}
                        disabled={!tappable}
                        onClick={() =>
                          opponentChair
                            ? setCpuSeatPicker(info.seat as 0 | 1)
                            : onSwapSeat(info.seat)
                        }
                        className={`flex min-w-0 flex-col items-start rounded-card border px-2 py-1.5 text-left transition-transform active:scale-[0.99] motion-reduce:active:scale-100 ${
                          mine
                            ? 'border-accent/50 bg-accent/12'
                            : tappable
                              ? 'border-line bg-surface-2'
                              : 'border-line bg-surface-1 opacity-60'
                        }`}
                      >
                        <span className="flex items-center gap-1 text-2xs font-normal tracking-normal text-ink-dim uppercase">
                          {watchSeat ? (
                            <Eye className="h-3 w-3" />
                          ) : cpuHere ? (
                            <Bot className="h-3 w-3" />
                          ) : (
                            <User className="h-3 w-3" />
                          )}
                          {watchSeat ? t('watch_table', language) : `P${info.seat + 1}`}
                        </span>
                        <span className="w-full truncate text-2xs text-ink">
                          {!info.enabled
                            ? '—'
                            : cpuHere && config.cpu
                              ? t(rungLabelKey(config.cpu), language)
                              : info.playerName ||
                                (opponentChair
                                  ? t('lobby_cpu_pick', language)
                                  : t('lobby_seat_free', language))}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
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
                  lockLabel={t('locked', language)}
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

              {/* Whether anybody may watch. A term of the match beside the
                  winning score rather than a MatchRule, so it never appears in
                  the "what unranks this match" list — and offered only where
                  the VENUE allows it, since the top three brackets have no
                  watching seats at all and a toggle there would look live and
                  do nothing. */}
              {roomAllowsSpectators(venueRoomId || DEFAULT_VENUE_ROOM) && (
                <label
                  id="toggle-spectators"
                  data-readonly={isHost ? 'false' : 'true'}
                  className={`flex items-center justify-between gap-2 text-2xs font-normal tracking-normal text-ink-muted select-none ${
                    isHost ? 'cursor-pointer' : 'opacity-60'
                  }`}
                >
                  <span>{t('lobby_spectators', language)}</span>
                  <input
                    type="checkbox"
                    checked={config.spectators}
                    disabled={!isHost}
                    onChange={(e) => onUpdateRoomConfig?.({ spectators: e.target.checked })}
                    className="h-4 w-4 accent-accent"
                  />
                </label>
              )}

              <MatchRulesPanel
                rules={config.rules}
                onUpdateRules={(patch: Partial<MatchRules>) =>
                  onUpdateRoomConfig?.({ rules: normalizeRules({ ...config.rules, ...patch }) })
                }
                lang={language}
                // A table with a CPU in the other chair is playing a SOLO
                // match — the table is only WHERE it is played and who may
                // watch — so the badge has to judge it as one: the rung's own
                // ceiling applies, Rookie never rates, and the watching seats
                // decide the rest. Handing it 'multiplayer' would price a
                // machine match as a duel on screen while the server priced it
                // correctly, which is the disagreement `unrankedReasons`
                // exists to make impossible.
                mode={config.cpu ? 'solo' : 'multiplayer'}
                difficulty={config.cpu ?? undefined}
                rankMu={config.cpu ? rankMu : undefined}
                // The host is choosing this in this very panel, two rows up,
                // so the badge answers in the same breath rather than a frame
                // later.
                watched={config.cpu ? config.spectators : undefined}
                readOnly={!isHost}
                idPrefix="lobby"
                // The TABLE's venue, not the room the player walked in from.
                // `venueRoomId` above is the browse venue and is null for
                // anyone who arrived on a join key, so reading it here would
                // make the badge right for the host and silent for the guest —
                // the exact failure the venue reason exists to prevent.
                venueRoomId={tableState?.venueRoomId ?? null}
              />
            </div>
          </>
        ) : (
          <>
            {/* The tables open in this room. Shown only when the player
                walked in from one — the bare invite flow (a link, a QR, a
                typed code) has no venue and no browser, exactly as before.

                Empty is a real state and says so rather than showing nothing:
                a room with no tables is a room you START one in, which is why
                the empty copy carries the CTA rather than sitting above a
                separate button the player has to find. */}
            {venueRoomId && (
              <Panel as="section" variant="raised" className="flex flex-col gap-2.5">
                <div className="flex items-center gap-1.5">
                  <h3 className="flex flex-1 items-center gap-1.5 text-2xs text-ink">
                    <Users className="h-4 w-4 text-accent" />
                    {t('lobby_tables_title', language)}
                  </h3>
                  {onRefreshTables && (
                    <button
                      id="btn-refresh-tables"
                      onClick={onRefreshTables}
                      aria-label={t('lobby_tables_refresh', language)}
                      className="rounded-ctl border border-line bg-surface-2 p-1.5 text-ink-muted transition-colors active:scale-95 motion-reduce:active:scale-100"
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${tablesLoading ? 'animate-spin' : ''}`} data-motion-essential />
                    </button>
                  )}
                </div>

                {tables.length === 0 ? (
                  <p id="lobby-tables-empty" className="text-2xs font-normal tracking-normal text-ink-muted">
                    {t('lobby_tables_empty', language)}
                  </p>
                ) : (
                  <ul id="lobby-tables" className="flex flex-col gap-1.5">
                    {tables.map((table) => (
                      <li key={table.id} className="flex items-stretch gap-1.5">
                        <button
                          id={`table-${table.id}`}
                          data-full={table.isFull ? 'true' : 'false'}
                          disabled={table.isFull}
                          onClick={() => onJoinRoom(table.id)}
                          className={`flex w-full items-center gap-2 rounded-card border p-2.5 text-left transition-transform active:scale-[0.99] motion-reduce:active:scale-100 ${
                            table.isFull ? 'border-line bg-surface-1 opacity-60' : 'border-line bg-surface-2'
                          }`}
                        >
                          <div className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate text-2xs text-ink">
                              {table.hostName || t('lobby_tables_host_unknown', language)}
                            </span>
                            <span className="text-2xs font-normal tracking-normal text-ink-dim">
                              {table.inPlay
                                ? t('lobby_tables_in_play', language)
                                : t('lobby_tables_waiting', language)}
                            </span>
                          </div>
                          <span className="shrink-0 text-2xs tnum font-normal tracking-normal text-ink-muted">
                            {table.playerCount}/2
                          </span>
                        </button>
                        {/* A separate control, not a mode of the row: joining
                            and watching are different intents, and a full
                            table is still worth watching — which is exactly
                            when the row itself is disabled. */}
                        {onWatchTable && table.spectatorsEnabled && (
                          <button
                            id={`table-${table.id}-watch`}
                            data-full={(table.spectatorCount ?? 0) >= 2 ? 'true' : 'false'}
                            disabled={(table.spectatorCount ?? 0) >= 2}
                            title={
                              (table.spectatorCount ?? 0) >= 2
                                ? t('seat_watch_full', language)
                                : t('watch_table', language)
                            }
                            onClick={() => onWatchTable(table.id)}
                            className={`flex shrink-0 items-center gap-1 rounded-card border border-line px-2.5 text-2xs transition-transform active:scale-[0.99] motion-reduce:active:scale-100 ${
                              (table.spectatorCount ?? 0) >= 2
                                ? 'bg-surface-1 text-ink-dim opacity-60'
                                : 'bg-surface-2 text-ink-muted'
                            }`}
                          >
                            <Eye className="h-3.5 w-3.5" />
                            {t('watch_table', language)}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            )}

            {/* One column. The md: breakpoint this used to carry never fires
                on a phone-only app.

                And ONE way to open a table. There were two, and from the
                player's seat they were the same button: "start a table" made a
                listed one and "host a match" an unlisted one, and both landed
                on the identical screen — a room code, waiting for somebody.
                Listed-versus-unlisted is invisible to the person who just
                pressed it, so it was never a choice, only a fork.

                What survives is the table reachable BOTH ways: listed in the
                room's browser, and still carrying the 4-letter code and the QR.
                What it costs is stated in CLAUDE.md §5 rather than hidden — a
                listed table can be sat at by a stranger before the friend you
                sent the code to arrives, and its joiner is judged against the
                room's bracket, which an unlisted one never was. If invite-only
                tables are wanted back, they belong beside "let people watch" as
                a term of the room, not as a second front door. */}
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
                    className="h-4 w-4 accent-accent"
                  />
                </label>
              )}
              <Button id="btn-create-room" variant="primary" size="lg" block onClick={handleCreate}>
                {t('lobby_tables_create', language)}
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
      </Sheet>

      {/* Who sits in the opponent chair.
          `layer="over"` because it opens FROM the lobby and the lobby has to
          stay legible behind it — the host is choosing an opponent for the
          table they can see. `set_room_config` carries the answer, so there
          is no new message and no ordering hazard against the winning score
          or the watching seats being set in the same breath. */}
      <Sheet
        id="cpu-picker"
        isOpen={cpuSeatPicker !== null}
        onClose={() => setCpuSeatPicker(null)}
        closeId="btn-close-cpu-picker"
        layer="over"
        size="sm"
        icon={<Bot className="h-4 w-4" />}
        title={t('lobby_cpu_title', language)}
        subtitle={t('lobby_cpu_hint', language)}
        closeLabel={t('close', language)}
      >
        <SegmentedControl
          columns={3}
          ariaLabel={t('lobby_cpu_title', language)}
          value={config.cpu ?? 'none'}
          onLockTap={setGateHint}
          lockLabel={t('locked', language)}
          onChange={(value) => {
            onUpdateRoomConfig?.({ cpu: value === 'none' ? null : (value as AIDifficulty) });
            setCpuSeatPicker(null);
          }}
          options={[
            // Taking the machine back out, so the chair is a chair again.
            // First rather than last: it is the state the table starts in,
            // and the one a host reaches for when somebody is on their way.
            { value: 'none' as const, id: 'cpu-none', label: t('lobby_cpu_none', language), lock: null },
            ...RUNGS.map((d) => ({
              value: d,
              id: `cpu-${d}`,
              label: t(rungLabelKey(d), language),
              // The same gate the menu's Solo rooms draw and the same one
              // /api/match/record enforces — the menu is the client, and so
              // is this. A rung this profile has not earned is shown, and
              // tapping its lock says which achievement opens it.
              lock: difficultyOpen(d) ? null : unlockedBy('difficulty', d) ?? null,
            })),
          ]}
        />
      </Sheet>

      <UnlockHintSheet
        achievement={gateHint}
        onClose={() => setGateHint(null)}
        closeLabel={t('close', language)}
      />
    </>
  );
};
