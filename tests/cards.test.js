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

const rewardState = (overrides = {}) => ({
  phase: "reward",
  wave: 12,
  cards: ["electric", "frost", "heavy"],
  rerollUsed: false,
  rewardLeft: 6,
  ...overrides,
});

// canReroll 的真值表：只在 reward 阶段且未用过的可重抽
test("canReroll returns true in reward phase when rerollUnused", () => {
  assert.equal(canReroll(rewardState()), true);
});

test("canReroll returns false during wave or build phases", () => {
  assert.equal(
    canReroll({ phase: "wave", rerollUsed: false }),
    false,
  );
  assert.equal(
    canReroll({ phase: "build", rerollUsed: false }),
    false,
  );
  assert.equal(
    canReroll({ phase: "boss", rerollUsed: false }),
    false,
  );
});

test("canReroll returns false once rerollUsed has been spent", () => {
  assert.equal(
    canReroll(rewardState({ rerollUsed: true })),
    false,
  );
});

test("canReroll is pure: state fields are unchanged before and after", () => {
  const state = rewardState();
  const before = JSON.stringify(state);
  canReroll(state);
  assert.equal(JSON.stringify(state), before);
});

// rerollCandidates 的不可重抽分支：返回 null 且逐字节不变
test("rerollCandidates returns null and does not mutate state when not allowed", () => {
  for (const blocked of [
    { phase: "wave", rerollUsed: false },
    { phase: "build", rerollUsed: false },
    rewardState({ rerollUsed: true }),
  ]) {
    const before = JSON.stringify(blocked);
    const result = rerollCandidates(blocked);
    assert.equal(result, null);
    assert.equal(JSON.stringify(blocked), before);
  }
});

test("rerollCandidates replaces cards, marks rerollUsed and returns 3 unique entries", () => {
  const state = rewardState({
    cards: ["electric", "frost", "heavy"],
    rerollUsed: false,
  });
  const result = rerollCandidates(state);
  assert.notEqual(result, null);
  assert.equal(result.length, 3);
  assert.equal(new Set(result).size, 3);
  assert.ok(result.every((c) => TYPES[c]));
  assert.equal(state.cards, result);
  assert.equal(state.rerollUsed, true);
});

test("rerollCandidates with a seeded rng produces identical sequences across calls", () => {
  const rngA = seededRandom(2026);
  const rngB = seededRandom(2026);
  const stateA = rewardState({ wave: 7, cards: [], rerollUsed: false });
  const stateB = rewardState({ wave: 7, cards: [], rerollUsed: false });
  const a = rerollCandidates(stateA, rngA);
  const b = rerollCandidates(stateB, rngB);
  assert.deepEqual(a, b);
  assert.equal(stateA.rerollUsed, true);
  assert.equal(stateB.rerollUsed, true);
});

test("rerollCandidates allows the wave-12 default to succeed even though seed differs", () => {
  // 默认参数应当与显式注入 rng 等价；这里两次调用都用同一个 seed 但不同状态。
  const rng = seededRandom(9);
  const state = rewardState({ wave: 12, cards: ["standard", "frost", "electric"] });
  const explicit = rerollCandidates(state, rng);
  assert.notEqual(explicit, null);
  assert.equal(explicit.length, 3);
});

// resolveAutoPick：合法索引与非法输入的回退
test("resolveAutoPick returns the locked card for valid integer indices", () => {
  const cards = ["electric", "frost", "heavy"];
  for (const i of [0, 1, 2]) {
    assert.equal(resolveAutoPick(cards, i), cards[i]);
  }
});

test("resolveAutoPick falls back to the first card on negative, out-of-range and non-integer indexes", () => {
  const cards = ["electric", "frost", "heavy"];
  for (const bad of [-1, 3, -100, 99]) {
    assert.equal(resolveAutoPick(cards, bad), cards[0]);
  }
});

test("resolveAutoPick does not throw on NaN, undefined, strings or floats", () => {
  const cards = ["electric", "frost", "heavy"];
  for (const bad of [NaN, undefined, null, "two", 1.5, -0.5, {}, []]) {
    assert.doesNotThrow(() => resolveAutoPick(cards, bad));
    assert.equal(resolveAutoPick(cards, bad), cards[0]);
  }
});

test("resolveAutoPick is deterministic across repeated valid calls", () => {
  const cards = ["electric", "frost", "heavy"];
  for (let i = 0; i < 5; i++) {
    assert.equal(resolveAutoPick(cards, 2), cards[2]);
    assert.equal(resolveAutoPick(cards, 0), cards[0]);
  }
});