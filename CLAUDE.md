# CLAUDE.md – Phong Project Guide


This document provides a comprehensive overview of **Phong**, an arcade sports web application featuring a "blind half-court" gameplay mechanic and cross-device 2-phone multiplayer.


---


## 1. Project Overview & Core Concept


**Phong** is a reimagining of classic Pong designed for mobile and desktop web. Instead of viewing the entire court, each player only sees their own half of the court.


- **The Net Boundary**: The glowing top edge of the player's screen represents the net.
- **Cross-Net Cyber Jump**: When a ball hits the top net, it leaves the player's screen and crosses the cyberspace boundary into the opponent's screen.
- **Opponent Sonar / Radar**: A mini radar display tracks the opponent's movements and ball position in real time on their half.
- **Physical 2-Phone Duel**: Players place two smartphones top-to-top on a flat table. A 4-letter room code connects them via WebSockets, allowing the ball to physically transition across phone screens.
- **Single-Player & Dual Simulation**: Includes an adaptive AI opponent (Rookie, Pro, Master) and a split-screen Dual Court simulator for testing.


---


## 2. Tech Stack


- **Frontend**: React 18, TypeScript, Vite, Tailwind CSS, Motion (`motion/react`), Lucide React icons, Canvas Confetti.
- **Backend / Server**: Express 5 (`server.ts`), Socket.IO (real-time WebSocket relay), Node.js.
- **Audio Engine**: Pure Web Audio API procedural synthesizer (zero external audio assets; retro SFX, chiptune BGM, ambient soundscapes).
- **Data & Persistence**: Server-side JSON store (`data/game_database.json`) via `server/db.ts` with local client fallback storage.


---


## 3. Normalized Coordinate & Physics Model


All positions, velocities, and dimensions are strictly normalized in the range `[0.0, 1.0]`.
code
Code
Opponent Court (Remote / Sonar)
+-----------------------------------------------+ (Opponent Baseline y = 1.0)
| [Opponent Paddle] |
| |
+===================== NET =====================+ (y = 0.0 for both players)
| |
| (Ball) |
| |
| [Player Paddle] |
+-----------------------------------------------+ (Player Baseline y = 1.0)
code
Code
### Coordinate Transforms Across Net:
When the ball crosses the net (`y <= 0`):
- `opponent_x = 1.0 - player_x` (horizontal inversion for head-to-head orientation)
- `opponent_vx = -player_vx`
- `opponent_vy = Math.abs(player_vy)` (travels toward opponent paddle)
- Spin & speed multipliers are preserved across the net.


### Paddle Deflection & Spin:
- Paddle hit offset: `offset = (ball.x - paddle.x) / (paddleWidth / 2)` (clamped between `-1.0` and `1.0`).
- Sharp deflection angle: `ball.vx = offset * MAX_HORIZONTAL_SPEED`.
- Ball spin modifies trajectory dynamically on wall rebounds.


---


## 4. Codebase Directory Structure
├── CLAUDE.md # This project guide
├── index.html # Main HTML entry point
├── metadata.json # Platform configuration & permissions
├── package.json # Dependencies & scripts
├── server.ts # Express server + Socket.IO real-time relay
├── tsconfig.json # TypeScript configuration
├── vite.config.ts # Vite bundler configuration
│
├── data/
│ └── game_database.json # Persistent player profiles, matches, leaderboards
│
├── server/
│ └── db.ts # Server-side JSON database operations, ELO calculation & XP progression
│
└── src/
├── main.tsx # React application bootstrap
├── App.tsx # Main game controller, loop, state orchestrator
├── types.ts # TypeScript interfaces, types, and enums
├── index.css # Global Tailwind CSS styles
│
├── audio/
│ └── soundEffects.ts # Procedural Web Audio API sound synthesis (SFX, BGM, Soundscapes)
│
├── game/
│ ├── physics.ts # Ball movement, collision detection, spin calculations
│ └── themes.ts # Visual themes & palette definitions with unlock requirements
│
├── i18n/
│ └── translations.ts # 12-language localization dictionary & helper functions
│
└── components/
├── AchievementToast.tsx # Toast notification for unlocked achievements
├── AchievementsModal.tsx # Full achievements gallery & milestone progress
├── CourtCanvas.tsx # Main 60FPS HTML5 Canvas court renderer with screen shake & particles
├── DualCourtSimulator.tsx # Split-screen sandbox simulator for two players on one device
├── LeaderboardModal.tsx # Global ELO rankings & match win leaders
├── MatchHistoryModal.tsx # Historical match logs with point breakdowns
├── MissionsModal.tsx # Daily missions with XP rewards
├── MobileGatekeeper.tsx # Mobile orientation & fullscreen helper overlay
├── MultiplayerLobby.tsx # 4-letter room creation, joining, QR code share
├── ProfileModal.tsx # Player profile, avatar picker, ELO stats, streak banner
├── QuickChat.tsx # Real-time in-game emoji & tactical chat bubble overlay
├── RadarPreview.tsx # Live opponent court radar / sonar tracker
├── ScoreBoard.tsx # Score display, rally counter, daily streak badge, match timers
├── SettingsModal.tsx # Visual customization, difficulty, audio, haptics & screen shake
├── StatsOverlay.tsx # On-screen HUD for FPS, ball speed, spin & rally metrics
└── TutorialModal.tsx # Step-by-step interactive onboarding tutorial


---


## 5. Real-Time Socket.IO Protocol (`server.ts`)


| Event Name | Direction | Payload | Description |
|---|---|---|---|
| `join_room` | Client → Server | `{ roomId, playerName, playerProfile }` | Join or create a 4-letter multiplayer lobby |
| `room_state` | Server → Client | `{ roomId, host, guest, state, ... }` | Emitted when room membership or readiness changes |
| `paddle_update` | Client → Server | `{ roomId, x }` | Relays player paddle horizontal position |
| `ball_cross_net` | Client → Server | `{ roomId, ballState }` | Ball exited player screen across net -> transforms to opponent |
| `ball_lost` | Client → Server | `{ roomId, scoringPlayerId }` | Ball passed baseline, award point and update server score |
| `quick_chat` | Client → Server | `{ roomId, messageId, emoji, text }` | In-game chat bubble broadcast |
| `rematch_request` | Client → Server | `{ roomId }` | Request / accept match rematch |


---


## 6. Audio Engine Architecture (`src/audio/soundEffects.ts`)


The entire sound system runs dynamically via the **Web Audio API**:
- **Paddle Impacts**: Pitched sine/triangle wave bursts that scale with rally speed and deflection point.
- **Wall Bounces & Net Crossing**: Filtered square/sawtooth sweeps and atmospheric noise wooshes.
- **Chiptune BGM**: Dynamic procedural arpeggiator with tempo scaling matching rally intensity.
- **Ambient Soundscapes**:
  - `stadium`: Filtered crowd murmurs and cheer synthesis.
  - `cyberpunk`: Deep analog synth drone with slow FM modulation.
  - `zen`: Resonant pentatonic bamboo chimes with white-noise wind filters.


---


## 7. Progression, ELO & Unlockables


- **ELO Calculation**: Standard Chess/FIDE ELO formula executed on match completion in `server/db.ts`.
- **Daily Streak System**: Tracks consecutive days active, awarding XP boosts.
- **Unlockable Themes**:
  - `neon` / `midnight`: Default unlocked.
  - `retro`: Unlocked at Level 3.
  - `tennis`: Unlocked at Level 5.
  - `matrix`: Unlocked after winning 5 matches.
  - `solar`: Unlocked after achieving a 20-hit rally.
  - `hyper_violet`: Unlocked at Level 8.
  - `noir`: Unlocked after 3 consecutive clean sheet shutouts.
  - `quantum_gold`: Unlocked for ELO 1500+ Grandmasters.


---


## 8. Development & Build Commands


```bash
# Start development server with tsx and Vite middleware
npm run dev


# Build production bundle and esbuild CommonJS backend
npm run build


# Start production server
npm start


# Run TypeScript type check / linter
npm run lint
```

--- 


## 9. Key Conventions for Claude Code


  **1. Keep APIs and Keys Server-Side:** Server-side logic resides in server.ts or server/ files.
  **2. Strict Normalized Coordinates:** Always compute court physics using normalized floats (0.0 to 1.0) so all devices scale consistently regardless of pixel aspect ratio.
  **3. Sound System Safety:** Web Audio API contexts must always be lazily unlocked on user gesture (sound.initCtx() or sound.unlock()).
  **4. Icons:** Use lucide-react for all icons throughout UI components.
  **5. Styling:** Use Tailwind CSS utility classes; avoid inline styles except for dynamic canvas styling or theme color bindings.