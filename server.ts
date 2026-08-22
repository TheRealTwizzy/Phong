import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { db, RecordMatchContext } from './server/db';
import { deviceIdentity, deviceIdFromCookieHeader } from './server/auth';
import { hasUnlock } from './src/achievements';
import { normalizeDifficulty } from './src/rating';
import { transformBallForOpponent } from './server/transform';
import { validateAvatarPng } from './server/image';
import { MatchEndPayload, RoomMatchConfig } from './src/types';
import { DEFAULT_ROOM_CONFIG, isRankedRules, normalizeRoomConfig } from './src/matchRules';
import { validateUsername } from './src/profileRules';
import { Rating, winProbability } from './src/rating';

interface PlayerSession {
  ws: WebSocket;
  playerId: string;
  playerName: string;
  playerIndex: 0 | 1;
}

interface Room {
  id: string;
  players: (PlayerSession | null)[];
  scores: [number, number];
  rallyCount: number;
  maxRallyInMatch: number;
  servingPlayer: 0 | 1;
  rematchVotes: [boolean, boolean];
  /**
   * The terms both phones play by. The host owns them; the server normalizes
   * whatever arrives and is the only thing either client reads them from.
   */
  config: RoomMatchConfig;
  /**
   * Whether the room's current match has been decided. The server can tell,
   * now that it owns the winning score — which is what lets it refuse a
   * rematch vote from a match still in progress and re-open the settings
   * between matches.
   */
  matchOver: boolean;
  /**
   * The lobby handshake: the guest readies, and only then can the host start.
   * Cleared whenever the terms change — a guest readied under different rules
   * has not agreed to these — and reset by every match start.
   */
  ready: [boolean, boolean];
  /**
   * Whether a ball has actually been put in play since the last start. The
   * match "begins" when the guest joins, but nobody has served yet — so the
   * lobby is still open and the host can keep setting the terms. The first
   * ball over the net locks them.
   */
  inPlay: boolean;
  lastActive: number;
}

const rooms = new Map<string, Room>();

function broadcast(room: Room, payload: unknown): void {
  const json = JSON.stringify(payload);
  room.players.forEach((p) => {
    if (p?.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(json);
  });
}

/** Start (or restart) the room's match on terms both phones can see. */
function startMatch(room: Room, servingPlayer: 0 | 1): void {
  room.scores = [0, 0];
  room.rallyCount = 0;
  room.maxRallyInMatch = 0;
  room.rematchVotes = [false, false];
  room.servingPlayer = servingPlayer;
  room.matchOver = false;
  room.inPlay = false;
  room.ready = [false, false];
  // The config rides along with every start: a phone can never begin a match
  // on terms it has not been told, however it arrived in the room.
  broadcast(room, { type: 'game_start', servingPlayer, config: room.config });
}

/**
 * TrueSkill-2 style performance weight from SERVER-OBSERVED data only.
 * Dominating (5-0) counts for a little more than scraping through (5-4), and
 * a loser who sustained long rallies is punished a little less. Deliberately
 * bounded so it nudges the rating rather than driving it.
 */
function performanceWeight(myScore: number, oppScore: number, maxRally: number): number {
  const total = myScore + oppScore;
  if (total <= 0) return 1;
  const margin = (myScore - oppScore) / total; // -1..1
  const rallyQuality = Math.min(1, maxRally / 20); // 0..1
  const weight = 1 + 0.3 * margin + 0.15 * (rallyQuality - 0.5);
  return Math.max(0.5, Math.min(1.5, weight));
}

function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  // Behind Traefik/Caddy in production; needed for req.secure (Secure cookies)
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api', deviceIdentity);

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', activeRooms: rooms.size });
  });

  // ICE servers for the P2P (WebRTC) private-session mode. STUN is enough on
  // most networks; when TURN_URL + TURN_STATIC_SECRET are set (coturn with
  // use-auth-secret), time-limited credentials are minted per request so the
  // shared secret never reaches clients.
  app.get('/api/rtc-config', (req, res) => {
    const iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }> = [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    ];

    const turnUrl = process.env.TURN_URL;
    const turnSecret = process.env.TURN_STATIC_SECRET;
    if (turnUrl && turnSecret) {
      const ttlSeconds = 6 * 60 * 60;
      const username = `${Math.floor(Date.now() / 1000) + ttlSeconds}:phong`;
      const credential = crypto.createHmac('sha1', turnSecret).update(username).digest('base64');
      iceServers.push({ urls: turnUrl.split(',').map((u) => u.trim()), username, credential });
    }

    res.json({ iceServers });
  });

  // Room status check
  app.get('/api/room/:roomId', (req, res) => {
    const roomId = req.params.roomId.toUpperCase();
    const room = rooms.get(roomId);
    if (!room) {
      return res.status(404).json({ exists: false, message: 'Room not found' });
    }
    const playerCount = room.players.filter(Boolean).length;
    res.json({
      exists: true,
      roomId,
      playerCount,
      isFull: playerCount >= 2,
      // Whether a ball has actually been put in play since the last start.
      // Read-only; lets a client (and the e2e) tell a waiting room from a
      // live one.
      inPlay: room.inPlay,
    });
  });

  // Player Profile API
  // The profile belongs to the device identity in the signed cookie; clients
  // can no longer name (or forge) a player id. Profiles are minted lazily in
  // an UNINITIALIZED state — onboarding (POST /api/profile/initialize) locks
  // in the unique username before the player can record matches.
  app.get('/api/profile/me', (req, res) => {
    try {
      const profile = db.getProfile(req.deviceId!);
      res.json(profile);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // First-arrival onboarding: claim a unique username (starts the 365-day
  // rename lock). One-shot per profile.
  app.post('/api/profile/initialize', (req, res) => {
    try {
      const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
      const result = db.initializeProfile(req.deviceId!, username);
      if (!result.ok) {
        const status = result.code === 'USERNAME_INVALID' ? 400 : 409;
        return res.status(status).json({ error: result.code });
      }
      res.json(result.profile);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Live availability probe for the onboarding / rename forms.
  app.get('/api/username-check', (req, res) => {
    try {
      const u = typeof req.query.u === 'string' ? req.query.u.trim() : '';
      const check = validateUsername(u);
      if (!check.ok) {
        return res.json({ valid: false, available: false, reason: check.reason });
      }
      res.json({ valid: true, available: db.isUsernameAvailable(u, req.deviceId!) });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Rename (365-day lock). XP is never accepted from the client: mission
  // rewards are claimed by id at /api/missions/claim and paid from the server's
  // own definition table.
  app.put('/api/profile/me', (req, res) => {
    try {
      const { username } = req.body ?? {};
      let profile = null;

      if (username !== undefined) {
        if (typeof username !== 'string') {
          return res.status(400).json({ error: 'USERNAME_INVALID' });
        }
        const result = db.changeUsername(req.deviceId!, username.trim());
        if (!result.ok) {
          const status =
            result.code === 'USERNAME_INVALID' ? 400 : result.code === 'USERNAME_TAKEN' ? 409 : 403;
          return res.status(status).json({ error: result.code, unlockAt: result.unlockAt });
        }
        profile = result.profile;
      }

      if (!profile) {
        return res.status(400).json({ error: 'BAD_REQUEST' });
      }
      res.json(profile);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Avatar upload: the client sends a pre-cropped 256×256 PNG as the raw
  // body. The parser is scoped to this route so the global JSON limit stays
  // untouched; validation is dependency-free (see server/image.ts).
  app.post(
    '/api/profile/me/avatar',
    express.raw({ type: 'image/png', limit: '600kb' }),
    (req, res) => {
      try {
        const me = db.getProfile(req.deviceId!);
        if (!me.initialized) {
          return res.status(403).json({ error: 'PROFILE_NOT_INITIALIZED' });
        }
        const buf = req.body as Buffer;
        if (!Buffer.isBuffer(buf) || buf.length === 0) {
          return res
            .status(400)
            .json({ error: 'AVATAR_INVALID', message: 'Send a PNG body with Content-Type: image/png' });
        }
        const check = validateAvatarPng(buf);
        if (!check.ok) {
          return res
            .status(check.code === 'AVATAR_TOO_LARGE' ? 413 : 400)
            .json({ error: check.code, message: check.message });
        }
        const avatarVersion = db.setAvatar(req.deviceId!, buf);
        res.json({ hasAvatar: true, avatarVersion });
      } catch (e: any) {
        res.status(500).json({ error: e.message });
      }
    }
  );

  app.delete('/api/profile/me/avatar', (req, res) => {
    try {
      db.deleteAvatar(req.deviceId!);
      res.json({ hasAvatar: false });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Public, cacheable avatar image. The client cache-busts with
  // ?v=<avatarVersion> so immutable caching is safe.
  app.get('/api/avatar/:playerId', (req, res) => {
    try {
      const avatar = db.getAvatar(req.params.playerId);
      if (!avatar) {
        return res.status(404).end();
      }
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.send(Buffer.from(avatar.data));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Restore a profile on this device using its recovery code. The profile
  // moves: the previous device unlinks and the code rotates.
  app.post('/api/profile/claim', (req, res) => {
    try {
      const code = String(req.body?.code || '');
      if (!code.trim()) {
        return res.status(400).json({ error: 'Recovery code required' });
      }
      const profile = db.claimProfileByCode(code, req.deviceId!);
      if (!profile) {
        return res.status(404).json({ error: 'No profile matches that code' });
      }
      res.json(profile);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Public profile view — anyone can look up any player by id (tapping a
  // username in the UI). Sanitized server-side: no recovery code, no
  // activity timestamps. MUST stay registered after every literal
  // /api/profile/<segment> route so ":id" never shadows them.
  app.get('/api/profile/:id', (req, res) => {
    try {
      const profile = db.getPublicProfile(req.params.id);
      if (!profile) {
        return res.status(404).json({ error: 'NOT_FOUND' });
      }
      res.json({ profile });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Match Result & Stats Recording API
  app.post('/api/match/record', (req, res) => {
    try {
      const me = db.getProfile(req.deviceId!);
      if (!me.initialized) {
        return res.status(403).json({ error: 'PROFILE_NOT_INITIALIZED' });
      }
      const payload: MatchEndPayload = { ...req.body, playerId: req.deviceId!, username: me.username };

      // The achievement tree gates the ladder, so the gate is enforced here
      // too — the menu hides a locked difficulty, but the menu is the client.
      if (payload.mode === 'solo') {
        const difficulty = normalizeDifficulty(payload.difficulty);
        if (!hasUnlock(me.achievements, 'difficulty', difficulty)) {
          return res.status(403).json({ error: 'DIFFICULTY_LOCKED', difficulty });
        }
      }

      // Gameplay is client-authoritative, so a solo payload is entirely
      // self-reported and only ever feeds XP. A PvP payload, though, can be
      // checked against the room state the relay owns — when the room is
      // still live we use OUR scores and rally count, not the client's, and
      // only then do the TrueSkill-2 performance signals apply.
      const context: RecordMatchContext = {};
      if (payload.mode === 'multiplayer') {
        const room = payload.roomId ? rooms.get(String(payload.roomId).toUpperCase()) : undefined;
        const seat = room?.players.findIndex((p) => p?.playerId === req.deviceId!) ?? -1;
        if (room && seat >= 0) {
          const mine = room.scores[seat];
          const theirs = room.scores[seat === 0 ? 1 : 0];
          payload.playerScore = mine;
          payload.opponentScore = theirs;
          payload.maxRally = room.maxRallyInMatch;
          payload.isWinner = mine > theirs;

          const opponent = room.players[seat === 0 ? 1 : 0];
          if (opponent) {
            const opp = db.getProfile(opponent.playerId);
            context.opponentRating = { mu: opp.mmrMu, sigma: opp.mmrSigma };
          }
          context.performanceWeight = performanceWeight(mine, theirs, room.maxRallyInMatch);
        }
      }

      const result = db.recordMatch(payload, context);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Global Leaderboard API
  app.get('/api/leaderboard', (req, res) => {
    try {
      const sort = (req.query.sort as 'elo' | 'level' | 'rally' | 'wins') || 'elo';
      const limit = Math.min(100, parseInt((req.query.limit as string) || '50', 10));
      const includeBots = req.query.bots === '1' || req.query.bots === 'true';
      const leaderboard = db.getLeaderboard(sort, limit, includeBots);
      res.json({ leaderboard });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Practice Wall: no match is recorded and no rating moves; the client
  // reports the streak it reached and the server decides what it is worth.
  app.post('/api/practice/record', (req, res) => {
    try {
      const me = db.getProfile(req.deviceId!);
      if (!me.initialized) return res.status(403).json({ error: 'PROFILE_NOT_INITIALIZED' });
      const streak = Number(req.body?.bestStreak);
      if (!Number.isFinite(streak) || streak < 0) {
        return res.status(400).json({ error: 'BAD_REQUEST' });
      }
      res.json(db.recordPractice(req.deviceId!, streak));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Daily missions. Progress is advanced server-side by /api/match/record, so
  // these two routes only read state and pay out a completed mission once.
  app.get('/api/missions', (req, res) => {
    try {
      res.json({
        missions: db.getMissions(req.deviceId!),
        rerolls: db.rerollsRemaining(req.deviceId!),
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/missions/claim', (req, res) => {
    try {
      const { missionId } = req.body ?? {};
      if (typeof missionId !== 'string') {
        return res.status(400).json({ error: 'BAD_REQUEST' });
      }
      const result = db.claimMission(req.deviceId!, missionId);
      if (!result.ok) {
        const status = result.code === 'MISSION_UNKNOWN' ? 404 : 409;
        return res.status(status).json({ error: result.code });
      }
      res.json({
        profile: result.profile,
        missions: result.missions,
        earnedXp: result.earnedXp,
        unlocked: result.unlocked,
        // The free replacement dealt into the slot this claim emptied. It
        // costs neither allowance, which is why `rerolls` below is unchanged.
        newMissionId: result.newMissionId,
        rerolls: db.rerollsRemaining(req.deviceId!),
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Reroll one mission for another from its own pool. Allowances are per UTC
  // day and expire with it — they never bank up.
  app.post('/api/missions/reroll', (req, res) => {
    try {
      const { missionId } = req.body ?? {};
      if (typeof missionId !== 'string') {
        return res.status(400).json({ error: 'BAD_REQUEST' });
      }
      const result = db.rerollMission(req.deviceId!, missionId);
      if (!result.ok) {
        const status = result.code === 'MISSION_UNKNOWN' ? 404 : 409;
        return res.status(status).json({ error: result.code, rerolls: db.rerollsRemaining(req.deviceId!) });
      }
      res.json({
        missions: result.missions,
        rerolls: result.rerolls,
        newMissionId: result.newMissionId,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Achievements API
  app.get('/api/achievements', (req, res) => {
    try {
      const list = db.getAchievementsList(req.deviceId!);
      res.json({ achievements: list });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Match History API
  app.get('/api/matches/me', (req, res) => {
    try {
      const history = db.getMatchHistory(req.deviceId!);
      res.json({ matches: history });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  // Clean up inactive rooms older than 30 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [id, room] of rooms.entries()) {
      if (now - room.lastActive > 30 * 60 * 1000) {
        rooms.delete(id);
      }
    }
  }, 60000);

  wss.on('connection', (ws: WebSocket, upgradeReq: http.IncomingMessage) => {
    const cookieDeviceId = deviceIdFromCookieHeader(upgradeReq.headers.cookie);
    let currentRoomId: string | null = null;
    let playerIndex: 0 | 1 | null = null;
    let currentPlayerId: string = '';

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === 'create_room') {
          let code = generateRoomCode();
          while (rooms.has(code)) {
            code = generateRoomCode();
          }

          currentPlayerId = cookieDeviceId || msg.playerId || `p_${Date.now()}`;
          // Display names come from the cookie-verified profile, never from
          // the message — usernames are unique identities now.
          const hostName = cookieDeviceId ? db.getProfile(cookieDeviceId).username : 'Player 1';
          const room: Room = {
            id: code,
            players: [
              {
                ws,
                playerId: currentPlayerId,
                playerName: hostName,
                playerIndex: 0,
              },
              null,
            ],
            scores: [0, 0],
            rallyCount: 0,
            maxRallyInMatch: 0,
            servingPlayer: 0,
            rematchVotes: [false, false],
            config: normalizeRoomConfig(msg.config || DEFAULT_ROOM_CONFIG),
            matchOver: false,
            inPlay: false,
            ready: [false, false],
            lastActive: Date.now(),
          };

          rooms.set(code, room);
          currentRoomId = code;
          playerIndex = 0;

          ws.send(
            JSON.stringify({
              type: 'room_created',
              roomId: code,
              playerIndex: 0,
            })
          );
          ws.send(JSON.stringify({ type: 'room_config', config: room.config }));
        } else if (msg.type === 'join_room') {
          const code = (msg.roomId || '').toUpperCase().trim();
          const room = rooms.get(code);

          if (!room) {
            ws.send(JSON.stringify({ type: 'error', message: 'Room not found. Check the 4-letter code.' }));
            return;
          }

          if (room.players[1] !== null) {
            ws.send(JSON.stringify({ type: 'error', message: 'Room is already full (2 players).' }));
            return;
          }

          currentPlayerId = cookieDeviceId || msg.playerId || `p_${Date.now()}`;
          const guestName = cookieDeviceId ? db.getProfile(cookieDeviceId).username : 'Player 2';
          room.players[1] = {
            ws,
            playerId: currentPlayerId,
            playerName: guestName,
            playerIndex: 1,
          };
          room.rematchVotes = [false, false];
          room.lastActive = Date.now();
          currentRoomId = code;
          playerIndex = 1;

          // Notify joining player
          ws.send(
            JSON.stringify({
              type: 'room_joined',
              roomId: code,
              playerIndex: 1,
              opponentName: room.players[0]?.playerName || 'Player 1',
              opponentId: room.players[0]?.playerId || 'p1',
            })
          );

          // The guest plays the host's match, so they are told its terms before
          // the first serve — and can read them in the lobby.
          ws.send(JSON.stringify({ type: 'room_config', config: room.config }));

          // Notify host
          if (room.players[0]?.ws && room.players[0].ws.readyState === WebSocket.OPEN) {
            room.players[0].ws.send(
              JSON.stringify({
                type: 'opponent_joined',
                opponentName: room.players[1]?.playerName || 'Player 2',
                opponentId: room.players[1]?.playerId || 'p2',
              })
            );
          }

          // The match does NOT start on join any more: the guest readies in
          // the lobby, then the host starts. Both begin from a clean slate.
          room.ready = [false, false];
          broadcast(room, { type: 'ready_state', ready: room.ready });

          // Tell each phone how the matchup looks BEFORE the first serve.
          // Computed server-side so neither client ever sees the other's
          // hidden rating.
          const seats = room.players;
          if (seats[0] && seats[1]) {
            const r0 = db.getProfile(seats[0].playerId);
            const r1 = db.getProfile(seats[1].playerId);
            const a: Rating = { mu: r0.mmrMu, sigma: r0.mmrSigma };
            const b: Rating = { mu: r1.mmrMu, sigma: r1.mmrSigma };
            const p0 = winProbability(a, b);
            seats.forEach((p, idx) => {
              if (p?.ws && p.ws.readyState === WebSocket.OPEN) {
                p.ws.send(
                  JSON.stringify({
                    type: 'match_prediction',
                    winProbability: idx === 0 ? p0 : 1 - p0,
                  })
                );
              }
            });
          }

        } else if (msg.type === 'paddle_move' && currentRoomId && playerIndex !== null) {
          const room = rooms.get(currentRoomId);
          if (!room) return;
          room.lastActive = Date.now();

          const oppIdx = playerIndex === 0 ? 1 : 0;
          const opponent = room.players[oppIdx];
          if (opponent?.ws && opponent.ws.readyState === WebSocket.OPEN) {
            // Mirror coordinate for opponent perspective (1 - x)
            opponent.ws.send(
              JSON.stringify({
                type: 'opponent_paddle',
                x: 1 - msg.x,
              })
            );
          }
        } else if (msg.type === 'ball_pos' && currentRoomId && playerIndex !== null) {
          // The sonar's ball feed: each phone streams its OWN half's ball at
          // ~15Hz so the other side's radar has something real to draw — a
          // duel has no local simulation of the opponent's court. Forwarded
          // in the SENDER's frame (the radar mirrors, exactly as it does for
          // the solo AI's half), clamped, and never stored: pure telemetry.
          const room = rooms.get(currentRoomId);
          if (!room) return;
          const oppIdx = playerIndex === 0 ? 1 : 0;
          const opponent = room.players[oppIdx];
          if (opponent?.ws && opponent.ws.readyState === WebSocket.OPEN) {
            opponent.ws.send(
              JSON.stringify({
                type: 'opponent_ball',
                x: Math.max(0, Math.min(1, Number(msg.x) || 0)),
                y: Math.max(0, Math.min(1, Number(msg.y) || 0)),
              })
            );
          }
        } else if (msg.type === 'ball_cross_net' && currentRoomId && playerIndex !== null) {
          const room = rooms.get(currentRoomId);
          if (!room) return;
          room.lastActive = Date.now();
          // A ball over the net is the moment the terms stop being editable.
          room.inPlay = true;
          room.rallyCount++;
          if (room.rallyCount > room.maxRallyInMatch) {
            room.maxRallyInMatch = room.rallyCount;
          }

          const oppIdx = playerIndex === 0 ? 1 : 0;
          const opponent = room.players[oppIdx];
          if (opponent?.ws && opponent.ws.readyState === WebSocket.OPEN) {
            const incomingBall = transformBallForOpponent(msg.ball);

            opponent.ws.send(
              JSON.stringify({
                type: 'ball_incoming',
                ball: incomingBall,
              })
            );
          }
        } else if (msg.type === 'point_scored' && currentRoomId && playerIndex !== null) {
          const room = rooms.get(currentRoomId);
          if (!room) return;
          room.lastActive = Date.now();

          // A point can be won off a serve that never crossed, so this is the
          // other way a match becomes live.
          room.inPlay = true;
          // msg.scorer is either 'p1' or 'p2'
          const scorerIndex = msg.scorer === 'p1' ? 0 : 1;
          room.scores[scorerIndex]++;
          room.rallyCount = 0;

          // Next server
          const nextServer: 0 | 1 = scorerIndex === 0 ? 1 : 0;
          room.servingPlayer = nextServer;
          // Both phones end the match on this same number, so neither is left
          // playing on alone. Votes from before the final point are dropped:
          // a rematch is agreed about a match that is actually finished.
          if (room.scores[scorerIndex] >= room.config.winningScore) {
            room.matchOver = true;
            room.rematchVotes = [false, false];
          }

          broadcast(room, {
            type: 'score_update',
            p1Score: room.scores[0],
            p2Score: room.scores[1],
            reason: `Point to ${room.players[scorerIndex]?.playerName || `Player ${scorerIndex + 1}`}`,
            nextServer,
          });
        } else if (msg.type === 'quick_chat' && currentRoomId && playerIndex !== null) {
          const room = rooms.get(currentRoomId);
          if (!room) return;
          room.lastActive = Date.now();

          const oppIdx = playerIndex === 0 ? 1 : 0;
          const opponent = room.players[oppIdx];
          const sender = room.players[playerIndex];
          // Sender name from server-side session state only — a client
          // message can't impersonate another username.
          const senderName = sender?.playerName || `Player ${playerIndex + 1}`;

          if (opponent?.ws && opponent.ws.readyState === WebSocket.OPEN) {
            opponent.ws.send(
              JSON.stringify({
                type: 'quick_chat',
                text: String(msg.text || '').slice(0, 100),
                senderName,
                senderIdx: playerIndex,
              })
            );
          }
        } else if (msg.type === 'rtc_signal' && currentRoomId && playerIndex !== null) {
          // Pure pass-through: the server never inspects SDP or candidates,
          // it only ferries them between the two members of the room.
          const room = rooms.get(currentRoomId);
          if (!room) return;
          room.lastActive = Date.now();

          const oppIdx = playerIndex === 0 ? 1 : 0;
          const opponent = room.players[oppIdx];
          if (opponent?.ws && opponent.ws.readyState === WebSocket.OPEN) {
            opponent.ws.send(
              JSON.stringify({
                type: 'rtc_signal',
                payload: msg.payload,
                fromIdx: playerIndex,
              })
            );
          }
        } else if (msg.type === 'player_ready' && currentRoomId && playerIndex !== null) {
          const room = rooms.get(currentRoomId);
          if (!room) return;
          room.lastActive = Date.now();
          room.ready[playerIndex] = !!msg.ready;
          broadcast(room, { type: 'ready_state', ready: room.ready });
        } else if (msg.type === 'start_match' && currentRoomId && playerIndex !== null) {
          const room = rooms.get(currentRoomId);
          if (!room) return;
          room.lastActive = Date.now();
          // Host-only, both seated, the guest has readied, and nothing has
          // been played yet — rematches go through the two-vote handshake.
          const canStart =
            playerIndex === 0 &&
            !!room.players[0] &&
            !!room.players[1] &&
            room.ready[1] &&
            !room.inPlay &&
            !room.matchOver;
          if (!canStart) return;
          startMatch(room, 0);
        } else if (msg.type === 'set_room_config' && currentRoomId && playerIndex !== null) {
          const room = rooms.get(currentRoomId);
          if (!room) return;
          room.lastActive = Date.now();
          // The host owns the terms, and only while nothing is being played:
          // the guest cannot edit them, and neither side can change the ball
          // out from under a rally. Before the first serve and after the last
          // point, the settings are open.
          const between = !room.inPlay || room.matchOver;
          if (playerIndex !== 0 || !between) {
            ws.send(JSON.stringify({ type: 'room_config', config: room.config }));
            return;
          }
          room.config = normalizeRoomConfig(msg.config);
          broadcast(room, { type: 'room_config', config: room.config });
          // The guest readied under the OLD terms; new terms need a new yes.
          if (room.ready[1]) {
            room.ready = [false, false];
            broadcast(room, { type: 'ready_state', ready: room.ready });
          }
        } else if (msg.type === 'rematch_request' && currentRoomId && playerIndex !== null) {
          const room = rooms.get(currentRoomId);
          if (!room) return;
          room.lastActive = Date.now();
          // A vote only means anything once the room agrees the match is done.
          if (!room.matchOver) return;
          room.rematchVotes[playerIndex] = true;

          if (room.rematchVotes[0] && room.rematchVotes[1] && room.players[0] && room.players[1]) {
            // Both agreed: fresh match, the other side opens this time.
            startMatch(room, room.servingPlayer === 0 ? 1 : 0);
          } else {
            broadcast(room, { type: 'rematch_state', votes: room.rematchVotes });
          }
        } else if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', timestamp: msg.timestamp }));
        }
      } catch (err) {
        console.error('WS Error:', err);
      }
    });

    ws.on('close', () => {
      if (currentRoomId && playerIndex !== null) {
        const room = rooms.get(currentRoomId);
        if (room) {
          // A socket dying with a live, undecided ball is an abandon — the
          // opponent was denied a match they were in the middle of. Judged
          // BEFORE the seat empties, from state the relay owns: a client can
          // never report one, and the second player's departure from an
          // already-abandoned room records nothing.
          const bothSeated = !!(room.players[0] && room.players[1]);
          if (bothSeated && room.inPlay && !room.matchOver && currentPlayerId) {
            try {
              db.recordAbandon(currentPlayerId, { ranked: isRankedRules(room.config.rules) });
            } catch (e) {
              console.error('abandon record failed:', e);
            }
          }
          room.players[playerIndex] = null;
          room.rematchVotes[playerIndex] = false;
          room.ready[playerIndex] = false;
          const oppIdx = playerIndex === 0 ? 1 : 0;
          const opp = room.players[oppIdx];
          if (opp?.ws && opp.ws.readyState === WebSocket.OPEN) {
            opp.ws.send(JSON.stringify({ type: 'opponent_left' }));
          }
          if (!room.players[0] && !room.players[1]) {
            rooms.delete(currentRoomId);
          }
        }
      }
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    // Imported lazily so the production bundle never loads (or ships) vite
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // The bundled server.cjs lives inside dist/ next to the client files, so
    // prefer its own directory — this makes `node /path/to/dist/server.cjs`
    // work from any cwd. Fall back to cwd/dist for unbundled runs.
    const bundleDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
    const distPath = fs.existsSync(path.join(bundleDir, 'index.html'))
      ? bundleDir
      : path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Split-Screen Half Pong server running at http://0.0.0.0:${PORT}`);
  });

  // Render stops the old instance on every deploy of a disk-backed service;
  // close sockets and the listener cleanly instead of dying mid-request.
  const shutdown = (signal: string) => {
    console.log(`${signal} received, shutting down`);
    for (const client of wss.clients) {
      client.close(1001, 'Server restarting');
    }
    wss.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

startServer();
