import crypto from 'crypto';
import express from 'express';
import http from 'http';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';
import { db, ALL_ACHIEVEMENTS } from './server/db';
import { transformBallForOpponent } from './server/transform';
import { MatchEndPayload } from './src/types';

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
  lastActive: number;
}

const rooms = new Map<string, Room>();

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

  app.use(express.json());

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
    });
  });

  // Player Profile API
  app.get('/api/profile/:id', (req, res) => {
    try {
      const defaultUsername = (req.query.username as string) || undefined;
      const profile = db.getProfile(req.params.id, defaultUsername);
      res.json(profile);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.put('/api/profile/:id', (req, res) => {
    try {
      const { username } = req.body;
      if (!username) {
        return res.status(400).json({ error: 'Username is required' });
      }
      const updated = db.updateUsername(req.params.id, username);
      res.json(updated);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Match Result & Stats Recording API
  app.post('/api/match/record', (req, res) => {
    try {
      const payload: MatchEndPayload = req.body;
      if (!payload.playerId) {
        return res.status(400).json({ error: 'Player ID required' });
      }
      const result = db.recordMatch(payload);
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
      const leaderboard = db.getLeaderboard(sort, limit);
      res.json({ leaderboard });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Achievements API
  app.get('/api/achievements', (req, res) => {
    try {
      const playerId = req.query.playerId as string | undefined;
      const list = db.getAchievementsList(playerId);
      res.json({ achievements: list });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Match History API
  app.get('/api/matches/:playerId', (req, res) => {
    try {
      const history = db.getMatchHistory(req.params.playerId);
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

  wss.on('connection', (ws: WebSocket) => {
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

          currentPlayerId = msg.playerId || `p_${Date.now()}`;
          const room: Room = {
            id: code,
            players: [
              {
                ws,
                playerId: currentPlayerId,
                playerName: msg.playerName || 'Player 1',
                playerIndex: 0,
              },
              null,
            ],
            scores: [0, 0],
            rallyCount: 0,
            maxRallyInMatch: 0,
            servingPlayer: 0,
            rematchVotes: [false, false],
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

          currentPlayerId = msg.playerId || `p_${Date.now()}`;
          room.players[1] = {
            ws,
            playerId: currentPlayerId,
            playerName: msg.playerName || 'Player 2',
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

          // Start the game!
          const startingServer: 0 | 1 = 0;
          room.servingPlayer = startingServer;
          room.players.forEach((p) => {
            if (p?.ws && p.ws.readyState === WebSocket.OPEN) {
              p.ws.send(
                JSON.stringify({
                  type: 'game_start',
                  servingPlayer: startingServer,
                })
              );
            }
          });
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
        } else if (msg.type === 'ball_cross_net' && currentRoomId && playerIndex !== null) {
          const room = rooms.get(currentRoomId);
          if (!room) return;
          room.lastActive = Date.now();
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

          // msg.scorer is either 'p1' or 'p2'
          const scorerIndex = msg.scorer === 'p1' ? 0 : 1;
          room.scores[scorerIndex]++;
          room.rallyCount = 0;

          // Next server
          const nextServer: 0 | 1 = scorerIndex === 0 ? 1 : 0;
          room.servingPlayer = nextServer;

          room.players.forEach((p) => {
            if (p?.ws && p.ws.readyState === WebSocket.OPEN) {
              p.ws.send(
                JSON.stringify({
                  type: 'score_update',
                  p1Score: room.scores[0],
                  p2Score: room.scores[1],
                  reason: `Point to ${room.players[scorerIndex]?.playerName || `Player ${scorerIndex + 1}`}`,
                  nextServer,
                })
              );
            }
          });
        } else if (msg.type === 'quick_chat' && currentRoomId && playerIndex !== null) {
          const room = rooms.get(currentRoomId);
          if (!room) return;
          room.lastActive = Date.now();

          const oppIdx = playerIndex === 0 ? 1 : 0;
          const opponent = room.players[oppIdx];
          const sender = room.players[playerIndex];
          const senderName = msg.senderName || sender?.playerName || `Player ${playerIndex + 1}`;

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
        } else if (msg.type === 'rematch_request' && currentRoomId && playerIndex !== null) {
          const room = rooms.get(currentRoomId);
          if (!room) return;
          room.lastActive = Date.now();
          room.rematchVotes[playerIndex] = true;

          if (room.rematchVotes[0] && room.rematchVotes[1] && room.players[0] && room.players[1]) {
            // Both agreed: fresh match, loser of the coin toss last time serves first now
            room.scores = [0, 0];
            room.rallyCount = 0;
            room.maxRallyInMatch = 0;
            room.rematchVotes = [false, false];
            room.servingPlayer = room.servingPlayer === 0 ? 1 : 0;
            room.players.forEach((p) => {
              if (p?.ws && p.ws.readyState === WebSocket.OPEN) {
                p.ws.send(
                  JSON.stringify({
                    type: 'game_start',
                    servingPlayer: room.servingPlayer,
                  })
                );
              }
            });
          } else {
            room.players.forEach((p) => {
              if (p?.ws && p.ws.readyState === WebSocket.OPEN) {
                p.ws.send(
                  JSON.stringify({
                    type: 'rematch_state',
                    votes: room.rematchVotes,
                  })
                );
              }
            });
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
          room.players[playerIndex] = null;
          room.rematchVotes[playerIndex] = false;
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
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
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
