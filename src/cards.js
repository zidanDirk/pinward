export const TYPES = {
  standard: {
    name: "标准",
    title: "可靠的起点",
    color: "#e4b879",
    symbol: "↗",
    material: "木质反弹器",
    description: "改变弹道。45° 反射，让每一次碰撞都有价值。",
    effect: "命中击退 1 格",
    length: 70,
  },
  electric: {
    name: "电击",
    title: "连锁反应",
    color: "#f5d766",
    symbol: "ϟ",
    material: "导电反弹器",
    description: "弹球充电后，命中会电击附近的敌人。",
    effect: "范围连锁伤害",
    length: 72,
  },
  frost: {
    name: "冰冻",
    title: "慢一点，再慢一点",
    color: "#94dae3",
    symbol: "❄",
    material: "冰晶反弹器",
    description: "为弹球附加冰霜，使命中的敌人减速 2 秒。",
    effect: "减速 70% · 2 秒",
    length: 72,
  },
  heavy: {
    name: "重型",
    title: "退回入口",
    color: "#bca5e2",
    symbol: "↟",
    material: "合金反弹器",
    description: "蓄积冲击力，把命中的敌人向上推回 3 格。",
    effect: "3 格击退 · 1.5× 得分",
    length: 76,
  },
  split: {
    name: "分裂",
    title: "好球成双",
    color: "#ef9eaa",
    symbol: "⋔",
    material: "棱镜反弹器",
    description: "碰撞时分出一颗小弹球，制造交叉火力。",
    effect: "额外小弹球",
    length: 70,
  },
  wide: {
    name: "加宽",
    title: "多一点接球空间",
    color: "#a5cba0",
    symbol: "↔",
    material: "宽幅反弹器",
    description: "更大的碰撞面，适合边缘拦截与连接弹道。",
    effect: "加宽 37% · 60° 初始角",
    length: 96,
  },
};

export function drawCards(wave, rng) {
  const keys = Object.keys(TYPES);
  const cards = [];
  // Keep a dependable construction choice during the first four rewards.
  if (wave <= 4) cards.push(wave % 2 ? "heavy" : "standard");
  while (cards.length < 3) {
    const type = keys[Math.floor(rng() * keys.length)];
    if (!cards.includes(type)) cards.push(type);
  }
  return cards;
}

// 纯判定：在奖励阶段且尚未使用过重抽时返回 true。不修改 state。
export function canReroll(state) {
  return state.phase === "reward" && !state.rerollUsed;
}

// 重抽候选：不可重抽时返回 null 且完全不修改 state；
// 可重抽时调用 drawCards 生成新候选，写回 state.cards 并标记 rerollUsed。
export function rerollCandidates(state, rng = Math.random) {
  if (!canReroll(state)) return null;
  const cards = drawCards(state.wave, rng);
  state.cards = cards;
  state.rerollUsed = true;
  return cards;
}

// 自动选卡：lockedIndex 合法时返回该张，否则回退到第 1 张，不抛异常。
export function resolveAutoPick(candidates, lockedIndex) {
  if (
    typeof lockedIndex === "number" &&
    Number.isInteger(lockedIndex) &&
    lockedIndex >= 0 &&
    lockedIndex < candidates.length
  ) {
    return candidates[lockedIndex];
  }
  return candidates[0];
}
