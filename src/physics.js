export const WIDTH = 540;
export const HEIGHT = 840;
export const CELL = 60;
export const STEP = 1 / 60;

export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function reflect(vx, vy, nx, ny) {
  const dot = vx * nx + vy * ny;
  return { vx: vx - 2 * dot * nx, vy: vy - 2 * dot * ny };
}

export function circleContact(a, b) {
  const dx = a.x - b.x,
    dy = a.y - b.y;
  const distance = Math.hypot(dx, dy);
  const overlap = a.radius + b.radius - distance;
  if (overlap <= 0) return null;
  return {
    nx: distance ? dx / distance : 0,
    ny: distance ? dy / distance : -1,
    overlap,
  };
}

export function segmentContact(ball, segment) {
  const half = segment.length / 2;
  const dx = Math.cos(segment.angle) * half,
    dy = Math.sin(segment.angle) * half;
  const ax = segment.x - dx,
    ay = segment.y - dy;
  const t = clamp(
    ((ball.x - ax) * dx * 2 + (ball.y - ay) * dy * 2) / (4 * half * half),
    0,
    1,
  );
  return circleContact(ball, {
    x: ax + 2 * dx * t,
    y: ay + 2 * dy * t,
    radius: segment.radius,
  });
}

export function bounce(ball, contact) {
  ball.x += contact.nx * (contact.overlap + 0.01);
  ball.y += contact.ny * (contact.overlap + 0.01);
  if (ball.vx * contact.nx + ball.vy * contact.ny < 0)
    Object.assign(ball, reflect(ball.vx, ball.vy, contact.nx, contact.ny));
}

// Analytic constant-acceleration integration avoids frame-dependent gravity drift.
export function integrate(ball, dt, gravity) {
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt + (gravity * dt * dt) / 2;
  ball.vy += gravity * dt;
}

export function wallBounce(ball, bottom = false) {
  if (ball.x < ball.radius) {
    ball.x = 2 * ball.radius - ball.x;
    ball.vx = Math.abs(ball.vx);
  }
  if (ball.x > WIDTH - ball.radius) {
    ball.x = 2 * (WIDTH - ball.radius) - ball.x;
    ball.vx = -Math.abs(ball.vx);
  }
  if (ball.y < ball.radius) {
    ball.y = 2 * ball.radius - ball.y;
    ball.vy = Math.abs(ball.vy);
  }
  if (bottom && ball.y > HEIGHT - ball.radius) {
    ball.y = 2 * (HEIGHT - ball.radius) - ball.y;
    ball.vy = -Math.abs(ball.vy);
  }
}

export function gridPosition(x, y) {
  return {
    col: clamp(Math.floor(x / CELL), 0, 8),
    row: clamp(Math.floor(y / CELL), 0, 13),
  };
}

export function seededRandom(seed = 1) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
