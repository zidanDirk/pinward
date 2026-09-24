import { TYPES } from "./cards.js";
import { CELL } from "./physics.js";

export function createBumper(id, type, col, row) {
  return {
    id,
    type,
    col,
    row,
    x: col * CELL + CELL / 2,
    y: row * CELL + CELL / 2,
    angle: type === "wide" ? Math.PI / 3 : -Math.PI / 4,
    length: TYPES[type].length,
    radius: 7,
    disabled: 0,
    flash: 0,
  };
}

export function createBall(id, angle = 0, x = 270, y = 790, small = false) {
  return {
    id,
    x,
    y,
    vx: Math.sin(angle) * 760,
    vy: -Math.cos(angle) * 760,
    radius: small ? 5 : 8,
    ttl: small ? 8 : 18,
    small,
    power: "standard",
    splitCooldown: 0,
    contacts: new Map(),
    trail: [],
  };
}

export const MONSTERS = {
  normal: {
    name: "普通",
    color: "#95e5bf",
    radius: 21,
    hp: 2,
    speed: 35,
    score: 100,
  },
  swift: {
    name: "迅捷",
    color: "#ffce77",
    radius: 16,
    hp: 2,
    speed: 46,
    score: 140,
  },
  tank: {
    name: "坦克",
    color: "#afa6f4",
    radius: 29,
    hp: 4,
    speed: 29,
    score: 200,
  },
  bomb: {
    name: "炸弹",
    color: "#ff9fbe",
    radius: 22,
    hp: 3,
    speed: 38,
    score: 180,
  },
};

export function createMonster(id, type, wave, col) {
  const base = MONSTERS[type];
  const hp = base.hp * (1 + (wave - 1) * 0.08);
  return {
    id,
    type,
    x: col * CELL + CELL / 2,
    y: -30,
    radius: base.radius,
    hp,
    maxHp: hp,
    speed: base.speed * (1 + (wave - 1) * 0.05),
    frozen: 0,
    flash: 0,
    rotation: 0,
    bombCooldown: 0,
  };
}
