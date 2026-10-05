import test from "node:test";
import assert from "node:assert/strict";
import { getSkillShotHudState, hpWarningTier } from "../src/hud.js";

// 0.6 秒初始窗口：精确 0.1 秒粒度，无上溢。
test("getSkillShotHudState(0.6, false) shows 0.6s", () => {
  assert.deepEqual(getSkillShotHudState(0.6, false), {
    hidden: false,
    text: "精准一击 · 0.6s",
  });
});

// 0.31 → 向上量化到 0.4s（避免误显示 0.3s 导致窗口可用时间被低估）。
test("getSkillShotHudState(0.31, false) rounds up to 0.4s", () => {
  assert.deepEqual(getSkillShotHudState(0.31, false), {
    hidden: false,
    text: "精准一击 · 0.4s",
  });
});

// 0.01 → 向上量化到 0.1s，确保可见期间绝不出现 0.0s。
test("getSkillShotHudState(0.01, false) keeps 0.1s before expiry", () => {
  assert.deepEqual(getSkillShotHudState(0.01, false), {
    hidden: false,
    text: "精准一击 · 0.1s",
  });
});

// 窗口恰好到期：隐藏徽章。
test("getSkillShotHudState(0, false) hides badge", () => {
  assert.deepEqual(getSkillShotHudState(0, false), {
    hidden: true,
    text: "",
  });
});

// 负残值（update() 减到 <= 0 后实际字段值）：隐藏徽章，不出现 -0.0s。
test("getSkillShotHudState(-0.016, false) hides badge", () => {
  assert.deepEqual(getSkillShotHudState(-0.016, false), {
    hidden: true,
    text: "",
  });
});

// 窗口已被首个击杀消耗：隐藏徽章（即便 skillShotWindow 字段尚未清零）。
test("getSkillShotHudState(0.5, true) hides badge when consumed", () => {
  assert.deepEqual(getSkillShotHudState(0.5, true), {
    hidden: true,
    text: "",
  });
});

// 安全档（满血）：空字符串，#hp-pips 不挂任何警告 class。
test("hpWarningTier(10) returns empty tier", () => {
  assert.equal(hpWarningTier(10), "");
});

// 安全档（半数以上血量）：空字符串。
test("hpWarningTier(5) returns empty tier", () => {
  assert.equal(hpWarningTier(5), "");
});

// 低档（hp = 3）：仅 low，无脉冲动画。
test("hpWarningTier(3) returns low tier", () => {
  assert.equal(hpWarningTier(3), "low");
});

// 紧急档（hp = 2）：urgent，进入 1.2s 脉冲。
test("hpWarningTier(2) returns urgent tier", () => {
  assert.equal(hpWarningTier(2), "urgent");
});

// 危急档（hp = 1）：critical，进入 0.6s 脉冲并抖动 #hp。
test("hpWarningTier(1) returns critical tier", () => {
  assert.equal(hpWarningTier(1), "critical");
});

// 边界（hp = 0，game over 边缘）：仍按 hp <= 1 返回 critical。
test("hpWarningTier(0) returns critical tier", () => {
  assert.equal(hpWarningTier(0), "critical");
});