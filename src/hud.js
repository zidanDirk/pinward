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

// 低血量三档视觉反馈的纯状态函数。
//
// `hpWarningTier(hp)` 与 `#hp-pips` 的 `.low` / `.urgent` / `.critical`
// class 同源，仅依据当前血量返回档位字符串；不读写 DOM、不依赖其他模块，
// 由 main.js 的 updateUI 负责将其落地到 DOM（互斥布尔 toggle，避免每帧
// 反复重启 CSS 动画）。血量从 4 起视为安全档，返回空字符串。

/**
 * 计算基地血量的低血量警告档位。
 *
 * @param {number} hp 当前基地血量（0-10）。
 * @returns {"critical" | "urgent" | "low" | ""} 警告档位，空串表示无警告。
 */
export function hpWarningTier(hp) {
  if (hp <= 1) return "critical";
  if (hp <= 2) return "urgent";
  if (hp <= 3) return "low";
  return "";
}