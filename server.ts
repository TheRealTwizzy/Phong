import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { db, RecordMatchContext } from './server/db';
import { BOT_ROSTER } from './server/bots';
import {
  clearSessionCookie,
  deviceIdentity,
  deviceIdFromCookieHeader,
  issueSession,
  blockReleasedDevice,
  requireActiveSession,
  resetDeviceIdentity,
  requireRestorableSession,
  resolveSession,
  sessionIdentity,
} from './server/auth';
import { buildId } from './server/build';
import { hasUnlock } from './src/achievements';
import { normalizeDifficulty } from './src/rating';
import { transformBallForOpponent } from './server/transform';
import {
  applyMatchSync,
  clampInt,
  generateRoomCode,
  performanceWeight,
  PlayerSession,
  Room,
  startMatch as resetRoomForMatch,
} from './server/room';
import { validateAvatarPng } from './server/image';
import { MatchEndPayload, RoomMatchConfig } from './src/types';
import { DEFAULT_ROOM_CONFIG, duelMatchKey, isRankedRules, normalizeRoomConfig } from './src/matchRules';
import { validateUsername } from './src/profileRules';
import { Rating, winProbability } from './src/rating';


const rooms = new Map<string, Room>();

function broadcast(room: Room, payload: unknown): void {
  const json = JSON.stringify(payload);
  room.players.forEach((p) => {
    if (p?.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(json);
  });
}

/**
 * Start (or restart) the room's match and tell both phones.
 *
 * The state change lives in server/room.ts, where it can be tested without a
 * socket; the broadcast has to happen here, and every start must do both — a
 * phone that is not told has not started.
 */
function startMatch(room: Room, servingPlayer: 0 | 1): void {
  broadcast(room, resetRoomForMatch(room, servingPlayer));
}

interface LiveSocket {
  ws: WebSocket;
  deviceId: string;
  sessionId: string | null;
}

/**
 * Every relay socket that arrived with a verified device. Small — one entry
 * per connected phone — and the only thing it is for is displacement.
 */
const liveSockets = new Set<LiveSocket>();

/**
 * Whether a seat still holds the account it was seated under. The upgrade
 * check cannot answer this on its own: ownership moves while sockets stay
 * open, and the relay writes a finished duel onto both seats itself.
 */
function seatStillHoldsAccount(seat: { deviceId: string | null; sessionId: string | null }): boolean {
  if (!seat.deviceId) return false;
  if (db.releasedDevice(seat.deviceId)) return false;
  const owner = db.activeSessionId(seat.deviceId);
  // No recorded owner means nothing has displaced this seat.
  return !owner || owner === seat.sessionId;
}

/**
 * Close any socket this device holds under a DIFFERENT session. Called when a
 * session is issued, so the device that just lost the account finds out in
 * milliseconds instead of at its next heartbeat — and cannot land another
 * point in between.
 */
function closeDisplacedSockets(deviceId: string, keepSessionId: string): void {
  for (const entry of liveSockets) {
    if (entry.deviceId !== deviceId || entry.sessionId === keepSessionId) continue;
    try {
      entry.ws.send(JSON.stringify({ type: 'session_invalid', status: 'superseded', build: buildId() }));
      entry.ws.close(4001, 'session superseded');
    } catch {
      /* already gone */
    }
  }
}

/**
 * Close every registered socket that no longer holds the account it was
 * seated under, whatever made that true. Used after a transfer, where the
 * device that gave the account away is still sitting on an open socket.
 */
function evictStaleSockets(): void {
  for (const entry of liveSockets) {
    if (seatStillHoldsAccount(entry)) continue;
    const status = db.releasedDevice(entry.deviceId) ? 'released' : 'superseded';
    try {
      entry.ws.send(JSON.stringify({ type: 'session_invalid', status, build: buildId() }));
      entry.ws.close(4001, `session ${status}`);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Write a decided duel onto BOTH players' profiles, from the score the relay
 * owns, and hand each of them the result.
 *
 * A duel used to be recorded only by whichever phone POSTed it, so a result
 * reached a profile only if that player's client survived the final point. A
 * phone that locked, backgrounded, dropped its signal or was simply closed on
 * the losing screen recorded nothing at all — the match had happened for one
 * player and not for the other. The relay knows who won the moment the score
 * decides it, so it is what writes the result; the clients' POSTs stay as the
 * fallback for a match the relay never saw, and the shared match key means
 * whichever of them arrives second is recognised rather than paid again.
 */
function recordRoomMatch(room: Room): void {
  const seats: Array<0 | 1> = [0, 1];
  // Both seats must still be occupied. A match decided after one player left
  // is their abandon, already judged on the socket close; recording a result
  // on top of it would charge the same departure twice.
  if (!room.players[0] || !room.players[1]) return;

  const matchKey = duelMatchKey(room.id, room.matchSeq);
  const rules = room.config.rules;
  for (const seat of seats) {
    const me = room.players[seat];
    const them = room.players[seat === 0 ? 1 : 0];
    // No verified cookie, no profile to record onto — never invent one. Nor
    // for a device whose account was claimed away DURING this duel: it holds
    // nothing, and `getProfile` would mint it a stray empty profile to fail
    // against. The other seat is still recorded.
    if (!me?.deviceId || !them) continue;
    // Not just "was this device released" — also "does this seat still hold
    // the account". A socket displaced mid-duel would otherwise have its
    // result written here by the relay, under an account it no longer holds.
    if (!seatStillHoldsAccount(me)) continue;

    const mine = room.scores[seat];
    const theirs = room.scores[seat === 0 ? 1 : 0];
    const payload: MatchEndPayload = {
      playerId: me.deviceId,
      username: me.playerName,
      opponentId: them.playerId,
      opponentName: them.playerName,
      playerScore: mine,
      opponentScore: theirs,
      maxRally: room.maxRallyInMatch,
      mode: 'multiplayer',
      isWinner: mine > theirs,
      rules,
      roomId: room.id,
      matchSeq: room.matchSeq,
      matchKey,
    };

    const context: RecordMatchContext = {
      performanceWeight: performanceWeight(mine, theirs, room.maxRallyInMatch),
    };
    if (them.deviceId && seatStillHoldsAccount(them)) {
      const opp = db.getProfile(them.deviceId);
      context.opponentRating = { mu: opp.mmrMu, sigma: opp.mmrSigma };
    }

    try {
      const result = db.recordMatch(payload, context);
      if (me.ws.readyState === WebSocket.OPEN) {
        me.ws.send(JSON.stringify({ type: 'match_recorded', matchKey, result }));
      }
    } catch (e: any) {
      // An uninitialized profile can't hold a match (it has no identity yet);
      // anything else is worth seeing in the log. Either way the other seat
      // still gets its result.
      if (e?.message !== 'PROFILE_NOT_INITIALIZED') {
        console.error(`duel record failed for seat ${seat} in ${room.id}:`, e);
      }
    }
  }
}



async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  // Behind Traefik/Caddy in production; needed for req.secure (Secure cookies)
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api', deviceIdentity, sessionIdentity);

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', activeRooms: rooms.size, build: buildId() });
  });

  // ---- Session: which one device is holding this account right now --------
  //
  // The heartbeat. Cheap, unauthenticated, and safe to call from a device
  // that has just lost its account — being told so is precisely what it is
  // for. The client polls this while it plays, so an eviction lands within
  // seconds instead of at the final whistle of a match that will then be
  // refused.
  app.get('/api/session', (req, res) => {
    const session = req.session!;
    res.json({
      status: session.status,
      build: buildId(),
      deviceId: req.deviceId,
      // Which session the account is actually held by. Cookies are scoped to
      // the ORIGIN, not to a page, so two tabs on one device share this one
      // and the newest value wins for both — the server cannot tell them
      // apart. Reporting the id lets a tab compare it against the one IT was
      // given and notice it has been displaced.
      sessionId: session.sessionId,
      // Only ever the fact of the move, never the profile it moved to: a
      // released device has no claim on the account's details any more.
      ...(session.status === 'released' ? { released: true } : {}),
    });
  });

  // Take the account for this browser. Called on every load, and after any
  // status the client cannot play under. A device that was transferred away
  // cannot start a session at all — it has no account to start one on.
  app.post('/api/session', (req, res) => {
    try {
      if (req.session!.status === 'released') {
        return res.status(409).json({ error: 'DEVICE_RELEASED', sessionStatus: 'released', build: buildId() });
      }
      const sessionId = issueSession(req, res, req.deviceId!);
      // Whatever this device was holding open under an older session is over
      // NOW, not at that client's next heartbeat — otherwise the displaced
      // phone has seconds in which to keep scoring on an account it has just
      // lost, and the relay would write the result.
      closeDisplacedSockets(req.deviceId!, sessionId);
      res.json({ status: 'active', sessionId, build: buildId(), profile: db.getProfile(req.deviceId!) });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Start over as a new player. The one way off a released device: the
  // account this browser used to hold is alive on another device, so it is
  // issued a fresh device identity rather than handed the old one back.
  app.post('/api/session/reset', (req, res) => {
    try {
      // Only a released device may take this door. It is documented and
      // surfaced as the escape hatch for one, but the endpoint served anyone
      // who called it — and for a device that still HELD its account, a reset
      // swapped the cookie for a fresh identity while the initialized profile
      // stayed behind under the old one. The account would not be deleted,
      // merely unreachable: stranded under an id no browser holds any more.
      if (req.session!.status !== 'released') {
        return res.status(409).json({
          error: 'DEVICE_NOT_RELEASED',
          sessionStatus: req.session!.status,
          build: buildId(),
        });
      }
      const previous = req.deviceId!;
      const deviceId = resetDeviceIdentity(req, res);
      // The tombstone is KEPT. It used to be deleted here on the grounds that
      // the old identity is gone from the cookie jar and will never be
      // presented again — true, and precisely why deleting it hurts: the row
      // is the only record that this browser's account moved, and where it
      // moved to. Once it is gone an account left behind by a reset is not
      // merely unreachable, it is untraceable, and "my account still exists
      // but I lost access" has no answer. One row per transfer is nothing.
      const sessionId = issueSession(req, res, deviceId);
      // The old identity's sockets belong to a device that no longer exists.
      closeDisplacedSockets(previous, sessionId);
      res.json({ status: 'active', sessionId, build: buildId(), profile: db.getProfile(deviceId) });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Hand the account back voluntarily (the tab is closing). Best-effort: the
  // next load displaces whatever still holds it anyway.
  app.post('/api/session/end', (req, res) => {
    const session = req.session!;
    // A page hands back ITS OWN session, and the id it names is the only way
    // the server can tell which page is talking. `phong_session` is an ORIGIN
    // cookie: two tabs on one phone present the same value, so a closing tab
    // arrives holding whatever the NEWEST load minted. Ending that, and
    // clearing the shared cookie with it, signed the tab still sitting in a
    // lobby out of its own account — its next request carried no session, the
    // relay refused the socket at the upgrade, and the join died. Which tab
    // the player closed decided whether the other one could still play.
    const named = typeof req.body?.sessionId === 'string' ? req.body.sessionId : null;
    if (named && named !== session.sessionId) {
      return res.json({ status: 'not_mine' });
    }
    if (session.status === 'active' && session.sessionId) {
      db.endSession(req.deviceId!, session.sessionId);
    }
    clearSessionCookie(req, res);
    res.json({ status: 'ended' });
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
  app.get('/api/profile/me', blockReleasedDevice, (req, res) => {
    try {
      const profile = db.getProfile(req.deviceId!);
      res.json(profile);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // First-arrival onboarding: claim a unique username (starts the 365-day
  // rename lock). One-shot per profile.
  app.post('/api/profile/initialize', requireActiveSession, (req, res) => {
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
  app.put('/api/profile/me', requireActiveSession, (req, res) => {
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
    requireActiveSession,
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

  app.delete('/api/profile/me/avatar', requireActiveSession, (req, res) => {
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
  app.post('/api/profile/claim', requireRestorableSession, (req, res) => {
    try {
      const code = String(req.body?.code || '');
      if (!code.trim()) {
        return res.status(400).json({ error: 'Recovery code required' });
      }
      // A RELEASED device is allowed through this door, and deliberately so:
      // it is the browser whose account was transferred away, and the session
      // wall offers it exactly one button — "start as a new player" — which
      // mints a new device identity and leaves the account behind reachable by
      // nobody. Restoring is the non-destructive order of the same two moves,
      // and it grants nothing extra: the credential is the account's own
      // recovery code, and the same call was already reachable by pressing
      // "start fresh" first. A released device holds no session to hand to the
      // row, so it takes one on the way in.
      const wasReleased = req.session!.status === 'released';
      const profile = db.claimProfileByCode(code, req.deviceId!, req.session!.sessionId);
      if (!profile) {
        return res.status(404).json({ error: 'No profile matches that code' });
      }
      if (wasReleased) {
        // claimProfileByCode has already cleared this device's tombstone, so
        // the account is here again and only a session is missing. Issuing it
        // now is what makes the restore land in one move instead of leaving
        // the player looking at the wall they just escaped.
        issueSession(req, res, req.deviceId!);
      }
      // The device that just gave the account away may be sitting on an open
      // socket in a live duel. It stops being able to play the moment the
      // transfer lands, not whenever it next asks.
      evictStaleSockets();
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
  app.post('/api/match/record', requireActiveSession, (req, res) => {
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
        // Which match in that room this result is from. A client that doesn't
        // say (an older bundle still open in a tab) means the one the room is
        // on, which for a result being reported now is the one that just
        // ended — so it is deduped against the relay's own record of it
        // rather than paid a second time.
        const claimed = Number(payload.matchSeq);
        const seq = Number.isFinite(claimed) ? Math.floor(claimed) : room?.matchSeq;
        // A duel is recorded under a key both the relay and this client can
        // derive, so the relay's record of the same match (see recordRoomMatch)
        // and this POST cannot pay it twice — whichever arrives second is
        // answered with what the first one paid.
        if (payload.roomId && seq !== undefined) {
          payload.matchKey = duelMatchKey(String(payload.roomId), seq);
        }
        // The room may only speak for the match this result actually came
        // from. A room is reused by every rematch and reset to 0-0 by each
        // one, so an unqualified cross-check overwrote a slow or replayed POST
        // with the NEXT match's blank score and filed it as a 0-0 loss.
        if (room && seat >= 0 && room.matchSeq === seq) {
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
  app.post('/api/practice/record', requireActiveSession, (req, res) => {
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
  app.get('/api/missions', blockReleasedDevice, (req, res) => {
    try {
      res.json({
        missions: db.getMissions(req.deviceId!),
        rerolls: db.rerollsRemaining(req.deviceId!),
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/missions/claim', requireActiveSession, (req, res) => {
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
  app.post('/api/missions/reroll', requireActiveSession, (req, res) => {
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
  app.get('/api/achievements', blockReleasedDevice, (req, res) => {
    try {
      const list = db.getAchievementsList(req.deviceId!);
      res.json({ achievements: list });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Match History API
  app.get('/api/matches/me', blockReleasedDevice, (req, res) => {
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

    // A duel is the relay's own record-keeping: it writes a finished match
    // onto both seats' profiles. So the same rule the REST routes hold to
    // applies at the upgrade — a device that handed its account to another
    // device, or a session displaced by a newer load, does not get a court.
    // Without this the exploit simply moved: barred from recording a solo
    // match, an evicted device could still play (and be recorded for) a duel.
    let cookieSessionId: string | null = null;
    if (cookieDeviceId) {
      const session = resolveSession(cookieDeviceId, upgradeReq.headers.cookie);
      if (session.status !== 'active') {
        ws.send(JSON.stringify({ type: 'session_invalid', status: session.status, build: buildId() }));
        ws.close(4001, 'session not active');
        return;
      }
      cookieSessionId = session.sessionId;
      // Registered so a later session on this device can displace it. The
      // check above is a snapshot; this is what keeps it true afterwards.
      const entry: LiveSocket = { ws, deviceId: cookieDeviceId, sessionId: cookieSessionId };
      liveSockets.add(entry);
      ws.on('close', () => liveSockets.delete(entry));
    }

    let currentRoomId: string | null = null;
    let playerIndex: 0 | 1 | null = null;
    let currentPlayerId: string = '';

    /**
     * Whether this socket may take a seat in a room.
     *
     * The relay stamps a seat's display name at join time and never revisits
     * it, so a player who joins before choosing a username is shown to their
     * opponent as Paddle-XXXX for the life of the room — and the app gates
     * everything else behind onboarding, so a seat was the one thing an
     * unidentified player could still take.
     *
     * Only a cookie that resolves to a real, uninitialized profile is
     * refused. A socket with no cookie at all is the synthetic-id fallback
     * the load test and other tooling run on; it records nothing either way.
     */
    const seatRefusal = (): string | null => {
      if (!cookieDeviceId) return null;
      return db.getProfile(cookieDeviceId).initialized
        ? null
        : 'Pick a username before joining a match.';
    };

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === 'create_room' || msg.type === 'join_room') {
          const refusal = seatRefusal();
          if (refusal) {
            ws.send(JSON.stringify({ type: 'error', message: refusal }));
            return;
          }
        }

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
                deviceId: cookieDeviceId || null,
                sessionId: cookieSessionId,
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
            matchSeq: 0,
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
            deviceId: cookieDeviceId || null,
            sessionId: cookieSessionId,
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
          const decided = room.scores[scorerIndex] >= room.config.winningScore;
          if (decided) {
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

          // The score is out first — the DB write must never delay the point
          // both phones are waiting on — and the result follows it.
          if (decided) recordRoomMatch(room);
        } else if (msg.type === 'match_sync' && currentRoomId && playerIndex !== null) {
          const room = rooms.get(currentRoomId);
          if (!room) return;
          room.lastActive = Date.now();
          // Deliberately silent: in a P2P match both phones already have this
          // score from each other, so echoing it back would be a second
          // score_update arriving a round-trip late, mid-serve.
          // Recording is the caller's job now: server/room.ts stays free of
          // the database so its guards can be tested without one.
          if (applyMatchSync(room, msg).decided) recordRoomMatch(room);
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
        } else if (msg.type === 'leave_room') {
          // Declared in the protocol and sent by the client since forever, and
          // handled nowhere: the relay only ever learned about a departure from
          // the socket close that happens to follow it. That worked, but it
          // made a documented message a no-op and left the room's cleanup
          // depending on a side effect. Leaving is now its own event, and the
          // close that follows finds the seat already empty.
          vacateSeat();
        }
      } catch (err) {
        console.error('WS Error:', err);
      }
    });

    /**
     * Empty a seat, however the player left it.
     *
     * Both ways in are the same event as far as the room is concerned: an
     * explicit `leave_room`, and the socket simply dying. Keeping one
     * implementation is what stops them judging an abandon differently —
     * quitting a live duel IS an abandon, and a player who walks out must not
     * get a better outcome than one whose phone died.
     */
    const vacateSeat = (): void => {
      if (!currentRoomId || playerIndex === null) return;
      const room = rooms.get(currentRoomId);
      if (!room) return;
      // Guard against running twice: `leave_room` is followed by the client
      // closing its socket, so the close handler arrives moments later. The
      // seat is already empty by then, and re-running would count a second
      // abandon for one departure.
      if (!room.players[playerIndex]) return;

      // A socket dying with a live, undecided ball is an abandon — the
      // opponent was denied a match they were in the middle of. Judged
      // BEFORE the seat empties, from state the relay owns: a client can
      // never report one, and the second player's departure from an
      // already-abandoned room records nothing.
      const bothSeated = !!(room.players[0] && room.players[1]);
      if (bothSeated && room.inPlay && !room.matchOver && currentPlayerId) {
        try {
          // Same rule as recordRoomMatch: a seat that no longer holds
          // its account has no profile to charge — and when the relay
          // itself closed that socket to displace it, charging the
          // player an abandon for our own eviction would be perverse.
          if (seatStillHoldsAccount({ deviceId: currentPlayerId, sessionId: cookieSessionId })) {
            db.recordAbandon(currentPlayerId, { ranked: isRankedRules(room.config.rules) });
          }
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
      currentRoomId = null;
      playerIndex = null;
    };

    ws.on('close', () => vacateSeat());
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
    // The hashed assets under /assets are immutable and may be cached hard;
    // index.html must NOT be, or a client told its session is stale would
    // reload straight back onto the build it was already running and the
    // deploy would never reach it.
    app.use(
      express.static(distPath, {
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
        },
      })
    );
    app.get('*', (req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // The leaderboard's pace-setters. One-shot and flagged in the DB, so this
  // is a no-op on every boot after the first — it lives here rather than in
  // the schema migrations because a curated roster is a deployment decision,
  // not a shape the database needs to be correct.
  db.seedBotRoster(BOT_ROSTER);

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
