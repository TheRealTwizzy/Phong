// Cross-net coordinate transform. Both phones face each other, so when the
// ball leaves one screen at the net it must be mirrored horizontally and sent
// travelling downward into the opponent's half. Kept in one server-side place
// so the two clients can never disagree about where the ball arrived.

export interface CrossNetBall {
  x: number;
  vx: number;
  vy: number;
  spin: number;
  speedMultiplier: number;
}

export function transformBallForOpponent(raw: {
  x: number;
  vx: number;
  vy: number;
  spin?: number;
  speedMultiplier?: number;
}): CrossNetBall {
  return {
    x: Math.max(0.02, Math.min(0.98, 1 - raw.x)),
    vx: -raw.vx,
    vy: Math.abs(raw.vy), // moving DOWN into the opponent's screen
    spin: -(raw.spin || 0),
    speedMultiplier: raw.speedMultiplier || 1.0,
  };
}
