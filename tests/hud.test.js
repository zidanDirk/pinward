import test from "node:test";
import assert from "node:assert/strict";
import { getSkillShotHudState } from "../src/hud.js";

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