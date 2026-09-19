export const TOTAL_WAVES = 12;
export const WAVE_MIN_SECONDS = 17;
export const REWARD_SECONDS = 6;

export function wavePlan(wave, rng) {
  const count = Math.min(18, wave + 7);
  return Array.from({ length: count }, (_, i) => {
    const roll = rng();
    let type = "normal";
    if (wave >= 9 && roll < 0.22) type = "bomb";
    else if (wave >= 5 && roll < 0.43) type = "swift";
    else if (wave >= 3 && roll >= 0.43 && roll < 0.65) type = "tank";
    return { type, col: Math.floor(rng() * 9), at: i * 0.44 };
  });
}

export const BOSS_PHASES = {
  devour: {
    name: "吞噬",
    hint: "触手锁定反弹器，红圈预警后禁用 5 秒",
    color: "#ef9d88",
  },
  swarm: {
    name: "潮群",
    hint: "章鱼召唤迅捷怪，守住底部防线",
    color: "#efc66c",
  },
  gravity: {
    name: "重潮",
    hint: "重力增强，调整反弹角度把球送回上方",
    color: "#bca5e2",
  },
};

export function bossOrder(rng) {
  const order = Object.keys(BOSS_PHASES);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}
