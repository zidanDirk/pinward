import test from "node:test";
import assert from "node:assert/strict";
import {
  reflect,
  circleContact,
  segmentContact,
  bounce,
  integrate,
  wallBounce,
  WIDTH,
  HEIGHT,
} from "../src/physics.js";

const close = (actual, expected, tolerance = 1e-7) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} ≈ ${expected}`);

// 32 incidence/surface combinations: preserve energy and reverse normal velocity.
for (const degrees of [0, 15, 30, 45, 60, 90, 135, 180]) {
  for (const speed of [50, 300, 760, 1400])
    test(`elastic reflection: ${degrees}° surface at ${speed}px/s`, () => {
      const angle = (degrees * Math.PI) / 180;
      const nx = Math.cos(angle),
        ny = Math.sin(angle);
      const vx = speed * 0.6,
        vy = speed * -0.8;
      const output = reflect(vx, vy, nx, ny);
      close(Math.hypot(output.vx, output.vy), speed);
      close(output.vx * nx + output.vy * ny, -(vx * nx + vy * ny));
      close(-output.vx * ny + output.vy * nx, -vx * ny + vy * nx);
    });
}

for (const degrees of [0, 30, 45, 60, 90, 135, 180, 225]) {
  test(`segment face and endpoint collision at ${degrees}°`, () => {
    const angle = (degrees * Math.PI) / 180,
      nx = -Math.sin(angle),
      ny = Math.cos(angle);
    const segment = { x: 270, y: 420, angle, length: 80, radius: 7 };
    for (const offset of [-42, 0, 42]) {
      const ball = {
        x: 270 + Math.cos(angle) * offset + nx * 10,
        y: 420 + Math.sin(angle) * offset + ny * 10,
        radius: 8,
        vx: -nx * 760,
        vy: -ny * 760,
      };
      const contact = segmentContact(ball, segment);
      assert.ok(contact);
      bounce(ball, contact);
      assert.equal(segmentContact(ball, segment), null);
      close(Math.hypot(ball.vx, ball.vy), 760);
    }
  });
}

for (const [name, ball, axis, sign] of [
  ["left", { x: 2, y: 300, vx: -760, vy: 50 }, "vx", 1],
  ["right", { x: WIDTH - 2, y: 300, vx: 760, vy: 50 }, "vx", -1],
  ["top", { x: 300, y: 2, vx: 50, vy: -760 }, "vy", 1],
  ["bottom", { x: 300, y: HEIGHT - 2, vx: 50, vy: 760 }, "vy", -1],
])
  test(`closed arena ${name} wall`, () => {
    ball.radius = 8;
    const speed = Math.hypot(ball.vx, ball.vy);
    wallBounce(ball, true);
    assert.equal(Math.sign(ball[axis]), sign);
    assert.ok(
      ball.x >= 8 && ball.x <= WIDTH - 8 && ball.y >= 8 && ball.y <= HEIGHT - 8,
    );
    close(Math.hypot(ball.vx, ball.vy), speed);
  });

test("separate circles and tangent circles do not collide", () => {
  assert.equal(
    circleContact({ x: 0, y: 0, radius: 5 }, { x: 10, y: 0, radius: 5 }),
    null,
  );
  assert.equal(
    circleContact({ x: 0, y: 0, radius: 5 }, { x: 30, y: 0, radius: 5 }),
    null,
  );
});
test("coincident circles resolve without NaN", () => {
  const ball = { x: 0, y: 0, radius: 8, vx: 0, vy: 100 };
  const other = { x: 0, y: 0, radius: 8 };
  bounce(ball, circleContact(ball, other));
  assert.ok(Number.isFinite(ball.y));
  assert.equal(circleContact(ball, other), null);
});
test("separating contacts never reverse an outgoing ball", () => {
  const ball = { x: 14, y: 0, radius: 8, vx: 500, vy: 0 };
  bounce(ball, circleContact(ball, { x: 0, y: 0, radius: 8 }));
  close(ball.vx, 500);
});
test("gravity integration agrees across timestep partitions", () => {
  const a = { x: 200, y: 400, vx: 123, vy: -400 },
    b = { ...a };
  integrate(a, 1, 90);
  for (let i = 0; i < 240; i++) integrate(b, 1 / 240, 90);
  close(a.x, b.x);
  close(a.y, b.y);
  close(a.vy, b.vy);
});
test("empty board conserves mechanical energy within 5% over 60 seconds", () => {
  const ball = { x: 270, y: 790, radius: 8, vx: 174, vy: -740 };
  const energy = () => ball.vx ** 2 + ball.vy ** 2 - 2 * 90 * ball.y;
  const initial = energy();
  let maxDrift = 0;
  for (let i = 0; i < 60 * 240; i++) {
    integrate(ball, 1 / 240, 90);
    wallBounce(ball, true);
    maxDrift = Math.max(maxDrift, Math.abs(energy() - initial) / initial);
  }
  assert.ok(maxDrift < 0.05, `Maximum drift ${(maxDrift * 100).toFixed(3)}%`);
});
test("corner collision reflects both axes without trapping", () => {
  const ball = { x: 2, y: 2, radius: 8, vx: -400, vy: -300 };
  wallBounce(ball, true);
  assert.equal(ball.vx, 400);
  assert.equal(ball.vy, 300);
  assert.ok(ball.x > 8 && ball.y > 8);
});
test("a fast ball cannot cross a thin bumper with production substeps", () => {
  const segment = { x: 270, y: 400, length: 70, radius: 7, angle: 0 };
  const ball = { x: 270, y: 360, radius: 5, vx: 0, vy: 2200 };
  let hit = false;
  const dt = 1 / 60,
    steps = Math.ceil((Math.hypot(ball.vx, ball.vy) * dt) / 4);
  for (let frame = 0; frame < 3; frame++)
    for (let i = 0; i < steps; i++) {
      integrate(ball, dt / steps, 0);
      const contact = segmentContact(ball, segment);
      if (contact) {
        hit = true;
        bounce(ball, contact);
      }
    }
  assert.ok(hit);
  assert.ok(ball.vy < 0);
  assert.ok(ball.y < 400);
});
