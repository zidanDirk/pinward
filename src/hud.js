// 精准一击窗口 HUD 倒计时徽章的纯状态函数。
//
// `getSkillShotHudState(skillShotWindow, skillShotConsumed)` 不读写 DOM、
// 不依赖任何模块。窗口到期或被消耗时返回隐藏结果，窗口活跃时返回
// 向上量化到 0.1 秒粒度、固定 1 位小数的倒计时文本，
// 防止在窗口可见期间出现 `0.0s`。

/**
 * 计算精准一击 HUD 倒计时徽章的可见状态。
 *
 * @param {number} skillShotWindow 剩余窗口秒数，到期后由调用方负责归零。
 * @param {boolean} skillShotConsumed 窗口内是否已消耗（首个击杀后为 true）。
 * @returns {{ hidden: boolean, text: string }} 徽章可见性与显示文本。
 */
export function getSkillShotHudState(skillShotWindow, skillShotConsumed) {
  if (skillShotConsumed === true) return { hidden: true, text: "" };
  if (!(skillShotWindow > 0)) return { hidden: true, text: "" };
  const q = Math.ceil(skillShotWindow * 10) / 10;
  return { hidden: false, text: `精准一击 · ${q.toFixed(1)}s` };
}