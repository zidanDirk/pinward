import { WIDTH, HEIGHT, CELL, seededRandom } from "./physics.js";
import { TYPES } from "./cards.js";
import { MONSTERS } from "./entities.js";
import { BOSS_PHASES } from "./waves.js";

const FONT = "'Avenir Next', 'PingFang SC', sans-serif";
const MONO = "ui-monospace, monospace";
const mix = (a, b, t) => (a ?? b) + (b - (a ?? b)) * t;

// 连击 ≥3 时显示的飘字模板。combo<3 直接空串，避免在波形间隙刷屏。
export function comboText(combo, kills) {
  if (!Number.isFinite(combo) || combo < 3) return "";
  const total = Math.max(0, Math.floor(Number.isFinite(kills) ? kills : 0));
  return `+${total} 击破`;
}

// 抖动偏移：reducedMotion 直接 0；否则用 (seed, frame) 算一对 |x|,|y| ≤4px 的偏移。
export function shakeOffset(seed, frame, reduced) {
  const out = { x: 0, y: 0 };
  shakeOffsetInto(out, seed, frame, reduced);
  return out;
}

export function shakeOffsetInto(out, seed, frame, reduced) {
  if (reduced) {
    out.x = 0;
    out.y = 0;
    return out;
  }
  const rng = seededRandom(
    (((seed | 0) * 1000003 + (frame | 0)) | 0) || 1,
  );
  out.x = (rng() - 0.5) * 8;
  out.y = (rng() - 0.5) * 8;
  return out;
}

// 飘字 x 坐标夹在画布宽度内，防止 390px 移动端横向出界。
export function clampTextX(x, width) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(width, x));
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.particles = Array.from({ length: 240 }, () => ({ life: 0 }));
    this.particleIndex = 0;
    this.effects = [];
    this.shake = 0;
    this.cursor = null;
    this.tool = "place";
    // 连击 / 飘字状态
    this.combo = 0;
    this.comboTtl = 0;
    this.killsInWave = 0;
    this.comboEffects = [];
    // 微抖动状态（炸弹 + 分裂球命中触发，1~3 帧）
    this.microShake = 0;
    this.microShakeSeed = 0;
    this.frameCount = 0;
    // 当前帧绘制的预警机制（null = 没在画）；用于测试和外部观察。
    this.warningKind = null;
    // 抖动偏移复用缓冲，避免每帧分配新对象。
    this._shakeBuf = { x: 0, y: 0 };
    this.background = document.createElement("canvas");
    this.background.width = WIDTH;
    this.background.height = HEIGHT;
    // Pre-render glow once; per-ball shadowBlur is expensive on mobile Canvas.
    this.glows = Object.fromEntries(
      Object.entries(TYPES).map(([type, data]) => {
        const sprite = document.createElement("canvas");
        sprite.width = sprite.height = 48;
        const context = sprite.getContext("2d");
        const gradient = context.createRadialGradient(24, 24, 4, 24, 24, 24);
        gradient.addColorStop(0, data.color + "b0");
        gradient.addColorStop(0.4, data.color + "45");
        gradient.addColorStop(1, data.color + "00");
        context.fillStyle = gradient;
        context.fillRect(0, 0, 48, 48);
        return [type, sprite];
      }),
    );
    this.drawBackground();
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = this.canvas.clientWidth;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round((width / WIDTH) * HEIGHT * dpr);
  }

  drawBackground() {
    const c = this.background.getContext("2d");
    c.fillStyle = "#153d40";
    c.fillRect(0, 0, WIDTH, HEIGHT);
    c.fillStyle = "#194347";
    c.fillRect(12, 64, WIDTH - 24, HEIGHT - 122);
    c.strokeStyle = "#71998d19";
    c.lineWidth = 1;
    for (let x = 0; x <= WIDTH; x += CELL) {
      c.beginPath();
      c.moveTo(x, 65);
      c.lineTo(x, HEIGHT - 62);
      c.stroke();
    }
    for (let y = 120; y < HEIGHT - 60; y += CELL) {
      c.beginPath();
      c.moveTo(12, y);
      c.lineTo(WIDTH - 12, y);
      c.stroke();
    }
    c.fillStyle = "#7da59835";
    for (let x = 30; x < WIDTH; x += CELL)
      for (let y = 90; y < HEIGHT - 60; y += CELL) {
        c.beginPath();
        c.arc(x, y, 1.2, 0, Math.PI * 2);
        c.fill();
      }
    c.fillStyle = "#a8c8b6";
    c.font = `10px ${MONO}`;
    c.textAlign = "center";
    c.fillText("↓   怪 物 入 口   ↓", WIDTH / 2, 30);
    c.fillStyle = "#668e85";
    c.font = `8px ${MONO}`;
    for (let i = 0; i < 9; i++)
      c.fillText(String(i + 1).padStart(2, "0"), 30 + i * CELL, 56);
    c.strokeStyle = "#8db3a343";
    c.strokeRect(11.5, 64.5, WIDTH - 23, HEIGHT - 124);
    c.save();
    c.beginPath();
    c.rect(12, HEIGHT - 80, WIDTH - 24, 20);
    c.clip();
    c.strokeStyle = "#d788664d";
    c.lineWidth = 6;
    for (let x = -20; x < WIDTH + 30; x += 20) {
      c.beginPath();
      c.moveTo(x, HEIGHT - 58);
      c.lineTo(x + 20, HEIGHT - 82);
      c.stroke();
    }
    c.restore();
    c.fillStyle = "#b8c8b6";
    c.font = `9px ${MONO}`;
    c.fillText("守 住 这 条 线", WIDTH / 2, HEIGHT - 42);
  }

  event(e) {
    if (
      [
        "bounce",
        "hit",
        "kill",
        "place",
        "rotate",
        "remove",
        "disable",
      ].includes(e.type)
    ) {
      const count = this.reduced ? 2 : e.type === "kill" ? 13 : 6;
      for (let i = 0; i < count; i++) {
        const p = this.particles[this.particleIndex++ % this.particles.length];
        const angle = (i / count) * Math.PI * 2;
        Object.assign(p, {
          x: e.x,
          y: e.y,
          vx: Math.cos(angle) * (70 + i * 9),
          vy: Math.sin(angle) * (70 + i * 9),
          life: 0.4,
          max: 0.4,
          color: e.color || "#ef9d88",
          size: e.type === "kill" ? 4 : 2,
        });
      }
    }
    if (e.type === "hit") this.effects.push({ ...e, life: 0.65, max: 0.65 });
    if (e.type === "lightning")
      this.effects.push({ ...e, life: 0.18, max: 0.18 });
    if (e.type === "leak") {
      this.shake = 0.35;
      this.effects.push({ type: "leak", life: 0.35, max: 0.35 });
    }
    if (e.type === "bossStage") this.shake = 0.8;
    // 连击累加 + 飘字生成
    if (e.type === "kill") {
      this.combo += 1;
      this.comboTtl = 2.0;
      this.killsInWave += 1;
      const text = comboText(this.combo, this.killsInWave);
      if (text) {
        this.comboEffects.push({
          x: e.x,
          y: e.y,
          text,
          life: 1.0,
          max: 1.0,
        });
      }
    }
    // 新一波 / 新阶段：连击与累计击破清零
    if (e.type === "wave" || e.type === "bossStage") {
      this.combo = 0;
      this.comboTtl = 0;
      this.killsInWave = 0;
    }
    // 炸弹怪禁用反弹器、分裂球命中：1~3 帧微抖动
    if (e.type === "disable" || (e.type === "hit" && e.power === "split")) {
      this.microShake = 3;
      this.microShakeSeed = (this.microShakeSeed + 7919) | 0;
    }
    if (this.effects.length > 60)
      this.effects.splice(0, this.effects.length - 60);
  }

  frame(game, dt, alpha = 1) {
    const c = this.ctx;
    c.setTransform(
      this.canvas.width / WIDTH,
      0,
      0,
      this.canvas.height / HEIGHT,
      0,
      0,
    );
    c.drawImage(this.background, 0, 0);
    // 把「长抖动 + 微抖动」合并到一次 translate，避免叠加两次矩阵。
    this.frameCount = (this.frameCount + 1) | 0;
    let dx = 0;
    let dy = 0;
    if (this.shake > 0 && !this.reduced) {
      dx += Math.sin(this.shake * 90) * this.shake * 5;
      dy += Math.cos(this.shake * 110) * this.shake * 4;
    }
    if (this.microShake > 0) {
      shakeOffsetInto(this._shakeBuf, this.microShakeSeed, this.frameCount, this.reduced);
      dx += this._shakeBuf.x;
      dy += this._shakeBuf.y;
    }
    c.save();
    if (dx !== 0 || dy !== 0) c.translate(dx, dy);
    this.shake = Math.max(0, this.shake - dt);
    if (this.microShake > 0) this.microShake--;
    // 连击超时归零，归零后 comboText() 不会再产出非空文本
    if (this.comboTtl > 0) {
      this.comboTtl -= dt;
      if (this.comboTtl <= 0) this.combo = 0;
    }
    this.drawAim(game);
    if (game.phase === "build") {
      [
        { type: "normal", x: 90, y: 128 },
        { type: "normal", x: 270, y: 165 },
        { type: "swift", x: 450, y: 123 },
        { type: "tank", x: 390, y: 247 },
      ].forEach((m) =>
        this.drawMonster(
          {
            ...MONSTERS[m.type],
            ...m,
            hp: 1,
            maxHp: 1,
            rotation: 0,
            flash: 0,
            frozen: 0,
          },
          game.time,
        ),
      );
    }
    for (const b of game.bumpers) this.drawBumper(b, game.time);
    for (const m of game.monsters)
      this.drawMonster(
        { ...m, x: mix(m.px, m.x, alpha), y: mix(m.py, m.y, alpha) },
        game.time,
      );
    if (game.boss) this.drawBoss(game.boss, game.time);
    for (const ball of game.balls) {
      const color = TYPES[ball.power].color;
      if (!this.reduced)
        for (let i = ball.trail.length - 1; i >= 0; i--) {
          const p = ball.trail[i];
          c.globalAlpha = (1 - i / ball.trail.length) * 0.3;
          c.fillStyle = color;
          c.beginPath();
          c.arc(
            p.x,
            p.y,
            ball.radius * (1 - i / ball.trail.length),
            0,
            Math.PI * 2,
          );
          c.fill();
        }
      c.globalAlpha = 1;
      c.fillStyle = "#fff7df";
      c.save();
      c.translate(mix(ball.px, ball.x, alpha), mix(ball.py, ball.y, alpha));
      if (!this.reduced) c.drawImage(this.glows[ball.power], -24, -24);
      if (ball.bounceFlash > 0 && !this.reduced) {
        c.rotate(Math.atan2(ball.vy, ball.vx));
        const stretch = 1 + ball.bounceFlash * 3;
        c.scale(stretch, 1 / stretch);
      }
      c.beginPath();
      c.arc(0, 0, ball.radius, 0, Math.PI * 2);
      c.fill();
      c.restore();
    }
    this.drawCursor(game);
    // BOSS 机制预警：必须画在怪物 / 球之下，但又高于背景。
    this.drawBossWarnings(game.boss);
    // 连击飘字：画在屏幕坐标（不受 ball trail 影响）
    this.drawComboText(dt);
    this.drawEffects(dt);
    c.restore();
  }

  drawAim(game) {
    const c = this.ctx,
      angle = (game.aim * Math.PI) / 180;
    const x = 270,
      y = 790;
    c.save();
    c.translate(x, y);
    c.rotate(angle);
    c.beginPath();
    c.moveTo(0, -22);
    c.lineTo(0, -225);
    c.strokeStyle = game.manualAim ? "#edbc80a0" : "#93b8a44d";
    c.lineWidth = 1.5;
    c.setLineDash([5, 9]);
    c.stroke();
    c.setLineDash([]);
    c.fillStyle = "#122e31";
    c.beginPath();
    c.arc(0, 0, 28, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "#d58155";
    c.fillRect(-11, -27, 22, 32);
    c.fillStyle = "#efbb80";
    c.fillRect(-7, -25, 14, 6);
    c.fillStyle = "#b5cfb5";
    c.beginPath();
    c.arc(0, 4, 16, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "#28524d";
    c.beginPath();
    c.arc(0, 4, 8, 0, Math.PI * 2);
    c.fill();
    c.restore();
    c.beginPath();
    c.arc(
      x,
      y + 4,
      33,
      -Math.PI / 2,
      -Math.PI / 2 + Math.PI * 2 * (1 - Math.max(0, game.launchIn) / 4),
    );
    c.strokeStyle = "#db9c68";
    c.lineWidth = 2;
    c.stroke();
    c.font = `8px ${MONO}`;
    c.fillStyle = "#8aafa1";
    c.textAlign = "left";
    c.fillText("AUTO", 25, 811);
    c.textAlign = "right";
    c.fillText("04 SEC", 515, 811);
  }

  drawBumper(b, time) {
    const c = this.ctx,
      style = TYPES[b.type];
    c.save();
    c.translate(b.x, b.y);
    if (b.disabled > 0) c.globalAlpha = 0.35;
    c.strokeStyle = "#a9d1be20";
    c.lineWidth = 1;
    c.beginPath();
    c.arc(0, 0, 24, 0, Math.PI * 2);
    c.stroke();
    c.save();
    c.rotate(b.angle);
    const stretch =
      b.flash > 0 && !this.reduced ? 1 + Math.sin(b.flash * 30) * 0.12 : 1;
    c.scale(stretch, 1 / stretch);
    c.lineCap = "round";
    c.lineWidth = 19;
    c.strokeStyle = "#08262b";
    c.beginPath();
    c.moveTo(-b.length / 2, 5);
    c.lineTo(b.length / 2, 5);
    c.stroke();
    c.lineWidth = 14;
    c.strokeStyle = b.flash > 0 ? "#fff6d6" : style.color;
    c.beginPath();
    c.moveTo(-b.length / 2, 0);
    c.lineTo(b.length / 2, 0);
    c.stroke();
    c.lineWidth = 2;
    c.strokeStyle = "#fff9d766";
    c.beginPath();
    c.moveTo(-b.length / 2 + 4, -3);
    c.lineTo(b.length / 2 - 4, -3);
    c.stroke();
    c.fillStyle = "#183e45";
    for (const x of [-b.length / 2 + 5, b.length / 2 - 5]) {
      c.beginPath();
      c.arc(x, 0, 2, 0, Math.PI * 2);
      c.fill();
    }
    if (b.type === "electric") {
      c.strokeStyle = "#fff5b7";
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(-20, 0);
      c.lineTo(-6, -3);
      c.lineTo(2, 3);
      c.lineTo(20, -2);
      c.stroke();
    }
    if (b.type === "frost") {
      c.fillStyle = "#ffffff88";
      for (const x of [-18, 0, 18]) c.fillRect(x - 2, -6, 4, 12);
    }
    if (b.type === "heavy") {
      c.fillStyle = "#655079";
      for (const x of [-20, 20]) c.fillRect(x - 3, -7, 6, 14);
    }
    if (b.type === "split") {
      c.fillStyle = "#fbd3d8";
      c.beginPath();
      c.moveTo(-7, 0);
      c.lineTo(0, -11);
      c.lineTo(7, 0);
      c.lineTo(0, 11);
      c.closePath();
      c.fill();
    }
    c.restore();
    c.globalAlpha = 1;
    if (b.disabled > 0) {
      c.fillStyle = "#f2aa91";
      c.font = `12px ${MONO}`;
      c.textAlign = "center";
      c.fillText(Math.ceil(b.disabled) + "s", 0, 30);
    }
    c.restore();
  }

  drawMonster(m, time) {
    const c = this.ctx,
      base = MONSTERS[m.type],
      r = m.radius;
    c.save();
    c.translate(m.x, m.y);
    if (m.flash > 0 && !this.reduced)
      c.rotate(Math.sin(m.flash * 24) * 0.28 + m.rotation * m.flash);
    c.fillStyle = "#08282c66";
    c.beginPath();
    c.ellipse(0, r * 0.7 + 7, r * 0.85, 8, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = m.flash > 0 ? "#fffbe5" : base.color;
    c.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const x = Math.cos(a) * r,
        y = Math.sin(a) * r;
      if (i === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    c.closePath();
    c.fill();
    c.fillStyle = "#ffffff25";
    c.beginPath();
    c.moveTo(-r * 0.8, -r * 0.5);
    c.lineTo(0, -r);
    c.lineTo(r * 0.8, -r * 0.5);
    c.lineTo(r * 0.3, 0);
    c.lineTo(-r * 0.3, 0);
    c.closePath();
    c.fill();
    c.fillStyle = "#173b3d";
    c.fillRect(-r * 0.47, -3, 5, 7);
    c.fillRect(r * 0.27, -3, 5, 7);
    c.strokeStyle = "#173b3d";
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(-4, 9);
    c.lineTo(4, 9);
    c.stroke();
    if (m.type === "swift") {
      c.strokeStyle = "#fbe5b0";
      c.lineWidth = 3;
      for (const sign of [-1, 1]) {
        c.beginPath();
        c.moveTo(sign * r, -5);
        c.lineTo(sign * (r + 7), -12);
        c.lineTo(sign * (r + 5), 3);
        c.stroke();
      }
    }
    if (m.type === "tank") {
      c.strokeStyle = "#79688f";
      c.lineWidth = 5;
      c.beginPath();
      c.moveTo(-r + 3, 1);
      c.lineTo(-r + 8, -17);
      c.lineTo(0, -r + 1);
      c.lineTo(r - 8, -17);
      c.lineTo(r - 3, 1);
      c.stroke();
    }
    if (m.type === "bomb") {
      c.strokeStyle = "#d6b089";
      c.lineWidth = 3;
      c.beginPath();
      c.moveTo(0, -r);
      c.lineTo(5, -r - 10);
      c.stroke();
      c.fillStyle = "#ffe5a0";
      c.beginPath();
      c.arc(5, -r - 11, 3 + Math.sin(time * 12), 0, Math.PI * 2);
      c.fill();
    }
    if (m.frozen > 0) {
      c.strokeStyle = "#b5f3f5";
      c.lineWidth = 2;
      for (let i = 0; i < 6; i++) {
        const a = (i * Math.PI) / 3;
        const x = Math.cos(a) * (r + 5),
          y = Math.sin(a) * (r + 5);
        c.beginPath();
        c.moveTo(x, y - 4);
        c.lineTo(x + 4, y);
        c.lineTo(x, y + 4);
        c.lineTo(x - 4, y);
        c.closePath();
        c.stroke();
      }
    }
    if (m.hp < m.maxHp) {
      c.fillStyle = "#0f2e30";
      c.fillRect(-r, -r - 10, r * 2, 3);
      c.fillStyle = base.color;
      c.fillRect(-r, -r - 10, r * 2 * Math.max(0, m.hp / m.maxHp), 3);
    }
    c.restore();
  }

  drawBoss(b, time) {
    const c = this.ctx,
      phase = BOSS_PHASES[b.order[b.stage]];
    for (const w of b.warnings) {
      c.strokeStyle = "#ed947c";
      c.lineWidth = 2;
      c.beginPath();
      c.arc(w.x, w.y, 28 + w.ttl * 10, 0, Math.PI * 2);
      c.stroke();
      c.beginPath();
      c.moveTo(b.x, b.y + 40);
      c.lineTo(w.x, w.y);
      c.setLineDash([5, 5]);
      c.stroke();
      c.setLineDash([]);
    }
    c.save();
    c.translate(b.x, b.y);
    c.strokeStyle = b.flash > 0 ? "#fff9dd" : phase.color;
    c.lineWidth = 15;
    c.lineCap = "round";
    for (let i = 0; i < 6; i++) {
      const x = (i - 2.5) * 22;
      c.beginPath();
      c.moveTo(x * 0.8, 30);
      c.quadraticCurveTo(
        x * 1.6,
        100 + Math.sin(time * 3 + i) * 20,
        x * 1.8,
        65 + Math.cos(time * 3 + i) * 15,
      );
      c.stroke();
    }
    c.fillStyle = b.flash > 0 ? "#fff9dd" : phase.color;
    c.beginPath();
    c.ellipse(0, 0, 64, 60, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "#ffffff22";
    c.beginPath();
    c.moveTo(-48, -35);
    c.lineTo(0, -60);
    c.lineTo(50, -33);
    c.lineTo(20, -7);
    c.lineTo(-17, -8);
    c.closePath();
    c.fill();
    c.fillStyle = "#173b3d";
    c.fillRect(-32, -4, 18, 13);
    c.fillRect(14, -4, 18, 13);
    c.fillRect(-10, 25, 20, 5);
    c.fillStyle = "#fff1c7";
    c.fillRect(-23, 0, 5, 5);
    c.fillRect(18, 0, 5, 5);
    c.restore();
    c.fillStyle = "#102e31e8";
    c.fillRect(65, 67, 410, 40);
    c.fillStyle = phase.color;
    c.font = `10px ${FONT}`;
    c.textAlign = "left";
    c.fillText(`深潮章鱼 / 阶段 ${b.stage + 1} · ${phase.name}`, 76, 83);
    c.fillStyle = "#ffffff22";
    c.fillRect(76, 91, 388, 5);
    c.fillStyle = phase.color;
    c.fillRect(76, 91, 388 * Math.max(0, b.hp / b.maxHp), 5);
  }

  // BOSS 预警画面：在 attackIn 刚被重置到 6 之后的 1.5 秒窗口里绘制。
  // 复用阶段调色板 + 不同 alpha 后缀，避免与本体的不透明填色混淆。
  drawBossWarnings(boss) {
    this.warningKind = null;
    if (!boss || boss.attackIn <= 4.5) return;
    const mechanism = boss.order && boss.order[boss.stage];
    if (!mechanism || !BOSS_PHASES[mechanism]) return;
    this.warningKind = mechanism;
    const c = this.ctx;
    const phase = BOSS_PHASES[mechanism];
    const progress = Math.max(0, Math.min(1, (6 - boss.attackIn) / 1.5));
    if (mechanism === "devour") {
      // 吞噬：被锁定的反弹器下方出现地面震纹
      c.lineWidth = 2;
      c.strokeStyle = phase.color + "60";
      const warnings = boss.warnings && boss.warnings.length
        ? boss.warnings
        : this._fallbackDevourPositions();
      for (const w of warnings) {
        const groundY = HEIGHT - 38;
        const radius = 14 + (1 - w.ttl / 1.5) * 32 + 4;
        c.beginPath();
        c.arc(w.x, groundY, radius, 0, Math.PI * 2);
        c.stroke();
        c.beginPath();
        c.arc(w.x, groundY, radius * 0.6, 0, Math.PI * 2);
        c.stroke();
      }
    } else if (mechanism === "swarm") {
      // 潮群：下沿水位线随时间上抬
      c.strokeStyle = phase.color + "70";
      c.lineWidth = 3;
      const top = HEIGHT - 78 - progress * 28;
      for (let i = 0; i < 3; i++) {
        const y = top + i * 9;
        c.beginPath();
        c.moveTo(12, y);
        c.lineTo(WIDTH - 12, y);
        c.stroke();
      }
    } else if (mechanism === "gravity") {
      // 重潮：四角同时向外扩张的脉冲
      const baseR = 10 + progress * 18;
      c.lineWidth = 2;
      c.strokeStyle = phase.color + "50";
      const corners = [
        [20, 76],
        [WIDTH - 20, 76],
        [20, HEIGHT - 76],
        [WIDTH - 20, HEIGHT - 76],
      ];
      for (const [cx, cy] of corners) {
        c.beginPath();
        c.arc(cx, cy, baseR, 0, Math.PI * 2);
        c.stroke();
      }
    }
  }

  _fallbackDevourPositions() {
    // 没有 warnings 数据时（玩家拆掉了反弹器），在底部给两个固定震纹作为兜底
    return [
      { x: WIDTH * 0.3, y: HEIGHT - 38, ttl: 1.5 },
      { x: WIDTH * 0.7, y: HEIGHT - 38, ttl: 1.5 },
    ];
  }

  drawCursor(game) {
    if (!this.cursor || game.phase === "over") return;
    const { col, row } = this.cursor;
    if (row < 2 || row > 11) return;
    const c = this.ctx,
      x = col * CELL,
      y = row * CELL;
    c.fillStyle = this.tool === "remove" ? "#ee9a8025" : "#fff4cf13";
    c.fillRect(x + 2, y + 2, CELL - 4, CELL - 4);
    c.strokeStyle = this.tool === "remove" ? "#ef9d88" : "#c3d4b3";
    c.lineWidth = 1;
    c.setLineDash([3, 4]);
    c.strokeRect(x + 3, y + 3, CELL - 6, CELL - 6);
    c.setLineDash([]);
    if (
      this.tool === "place" &&
      game.inventory[game.selected] > 0 &&
      !game.bumpers.some((b) => b.col === col && b.row === row)
    ) {
      c.globalAlpha = 0.45;
      this.drawBumper(
        {
          x: x + 30,
          y: y + 30,
          angle: -Math.PI / 4,
          type: game.selected,
          length: TYPES[game.selected].length,
          disabled: 0,
          flash: 0,
        },
        0,
      );
      c.globalAlpha = 1;
    }
  }

  // 连击飘字：每帧重新算一次剩余时间，过期移除；x 坐标 clamp 到画布宽度内。
  drawComboText(dt) {
    if (!this.comboEffects.length) return;
    const c = this.ctx;
    for (const eff of this.comboEffects) {
      eff.life -= dt;
      if (eff.life <= 0) continue;
      const a = Math.max(0, eff.life / eff.max);
      c.globalAlpha = a;
      c.fillStyle = "#fff1c7";
      c.font = `bold 14px ${MONO}`;
      c.textAlign = "center";
      const x = clampTextX(eff.x, WIDTH);
      const y = eff.y - 28 - (1 - a) * 24;
      c.fillText(eff.text, x, y);
    }
    if (this.comboEffects.some((e) => e.life <= 0))
      this.comboEffects = this.comboEffects.filter((e) => e.life > 0);
    c.globalAlpha = 1;
  }

  drawEffects(dt) {
    const c = this.ctx;
    for (const p of this.particles)
      if (p.life > 0) {
        p.life -= dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        c.globalAlpha = Math.max(0, p.life / p.max);
        c.fillStyle = p.color;
        c.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }
    for (const e of this.effects) {
      e.life -= dt;
      c.globalAlpha = Math.max(0, e.life / e.max);
      if (e.type === "hit") {
        c.fillStyle = e.color;
        c.font = `bold 16px ${MONO}`;
        c.textAlign = "center";
        c.fillText(
          Math.round(e.value),
          e.x,
          e.y - 24 - (1 - e.life / e.max) * 32,
        );
        if (e.toY != null && !this.reduced) {
          c.strokeStyle = "#fff9d455";
          c.lineWidth = 9;
          c.beginPath();
          c.moveTo(e.x, e.y);
          c.lineTo(e.x, e.toY);
          c.stroke();
        }
      } else if (e.type === "lightning") {
        c.strokeStyle = "#fff2a0";
        c.lineWidth = 3;
        c.beginPath();
        c.moveTo(e.x, e.y);
        c.lineTo((e.x + e.tx) / 2 + 9, (e.y + e.ty) / 2 - 8);
        c.lineTo((e.x + e.tx) / 2 - 9, (e.y + e.ty) / 2 + 8);
        c.lineTo(e.tx, e.ty);
        c.stroke();
      } else if (e.type === "leak") {
        c.fillStyle = "#d86c404d";
        c.fillRect(0, HEIGHT - 120, WIDTH, 120);
      }
    }
    this.effects = this.effects.filter((e) => e.life > 0);
    c.globalAlpha = 1;
  }
}