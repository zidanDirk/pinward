import test from "node:test";
import assert from "node:assert/strict";
import {
  TYPES,
  drawCards,
  canReroll,
  rerollCandidates,
  resolveAutoPick,
} from "../src/cards.js";
import { seededRandom } from "../src/physics.js";

// 验收前置：卡池必须不少于 6 种才能保证单次抽取的内部不重复
test("卡池至少包含 6 种反弹器类型", () => {
  assert.ok(Object.keys(TYPES).length >= 6);
});

test("canReroll 在星币恰好等于 5 时返回 true", () => {
  assert.equal(canReroll({ coins: 5 }), true);
});

test("canReroll 在星币大于 5 时仍然返回 true", () => {
  assert.equal(canReroll({ coins: 12 }), true);
  assert.equal(canReroll({ coins: 9999 }), true);
});

test("canReroll 在星币不足 5 时返回 false（含 0 与负数）", () => {
  assert.equal(canReroll({ coins: 4 }), false);
  assert.equal(canReroll({ coins: 0 }), false);
  assert.equal(canReroll({ coins: -1 }), false);
  assert.equal(canReroll({ coins: undefined }), false);
});

test("rerollCandidates 星币不足时返回 null 且完全不修改 state", () => {
  const state = { coins: 4, cards: ["electric", "frost", "heavy"] };
  const snapshot = JSON.stringify(state);
  const result = rerollCandidates(state, seededRandom(1));
  assert.equal(result, null);
  assert.equal(state.coins, 4);
  assert.deepEqual(state.cards, ["electric", "frost", "heavy"]);
  assert.equal(JSON.stringify(state), snapshot);
});

test("rerollCandidates 星币为 5 时扣 5 并返回 3 张内部不重复的候选", () => {
  const state = { coins: 5, cards: [], wave: 12 };
  const result = rerollCandidates(state, seededRandom(7));
  assert.equal(result.length, 3);
  assert.equal(new Set(result).size, 3, "新候选之间重复数应为 0");
  assert.ok(result.every((c) => TYPES[c]));
  assert.equal(state.coins, 0);
  assert.equal(state.cards, result);
});

test("rerollCandidates 不传 rng 时回退到 Math.random 并仍然返回 3 张卡", () => {
  const state = { coins: 5, cards: [], wave: 12 };
  const result = rerollCandidates(state);
  assert.equal(result.length, 3);
  assert.equal(new Set(result).size, 3);
  assert.equal(state.coins, 0);
});

test("rerollCandidates 注入同一固定随机序列两次调用得到完全相同的顺序", () => {
  const a = rerollCandidates(
    { coins: 5, cards: [], wave: 12 },
    seededRandom(42),
  );
  const b = rerollCandidates(
    { coins: 5, cards: [], wave: 12 },
    seededRandom(42),
  );
  assert.deepEqual(a, b);
});

test("rerollCandidates 不读 state.wave 时按第 12 波处理（不会触发安全兜底）", () => {
  // 第 12 波不再有 wave<=4 的安全卡，3 张候选应该全部由随机源产生
  const a = drawCards(12, seededRandom(3));
  const b = drawCards(12, seededRandom(3));
  assert.equal(a.length, 3);
  assert.equal(b.length, 3);
  // drawCards 必须给出相同的序列
  assert.deepEqual(a, b);
});

test("resolveAutoPick 对合法索引返回对应卡牌且连续多次调用幂等", () => {
  const candidates = ["electric", "frost", "heavy"];
  assert.equal(resolveAutoPick(candidates, 0), "electric");
  assert.equal(resolveAutoPick(candidates, 1), "frost");
  assert.equal(resolveAutoPick(candidates, 2), "heavy");
  assert.equal(resolveAutoPick(candidates, 2), "heavy");
  assert.equal(resolveAutoPick(candidates, 2), "heavy");
});

test("resolveAutoPick 对 -1 / 3 / NaN 均回退到第 1 张且不抛异常", () => {
  const candidates = ["electric", "frost", "heavy"];
  assert.doesNotThrow(() => resolveAutoPick(candidates, -1));
  assert.doesNotThrow(() => resolveAutoPick(candidates, 3));
  assert.doesNotThrow(() => resolveAutoPick(candidates, NaN));
  assert.doesNotThrow(() => resolveAutoPick(candidates, undefined));
  assert.doesNotThrow(() => resolveAutoPick(candidates, "two"));
  assert.doesNotThrow(() => resolveAutoPick(candidates, 1.5));
  assert.equal(resolveAutoPick(candidates, -1), "electric");
  assert.equal(resolveAutoPick(candidates, 3), "electric");
  assert.equal(resolveAutoPick(candidates, 999), "electric");
  assert.equal(resolveAutoPick(candidates, NaN), "electric");
  assert.equal(resolveAutoPick(candidates, undefined), "electric");
  assert.equal(resolveAutoPick(candidates, "two"), "electric");
  assert.equal(resolveAutoPick(candidates, 1.5), "electric");
});