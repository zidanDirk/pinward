import test from "node:test";
import assert from "node:assert/strict";
import {
  Renderer,
  comboText,
  shakeOffset,
  shakeOffsetInto,
  clampTextX,
} from "../src/renderer.js";
import { WIDTH, HEIGHT } from "../src/physics.js";

// 浏览器 API 在 node 里是 undefined。Renderer 构造里调用了 matchMedia /
// document.createElement，提前挂上桩；reduce 默认 false 让所有测试都按非退避震动跑。
if (typeof globalThis.window === "undefined") {
  globalThis.window = { devicePixelRatio: 1 };
}
if (typeof globalThis.matchMedia !== "function") {
  globalThis.matchMedia = () => ({ matches: false });
}
if (typeof globalThis.document !== "object" || !globalThis.document) {
  globalThis.document = {
    createElement(tag) {
      if (tag !== "canvas") throw new Error(`unexpected tag ${tag}`);
      // 背景图层只会被画一次；用 proxy 让任何方法调用都返回 undefined（无副作用）。
      const noopCtx = new Proxy(
        {
          fillStyle: "",
          strokeStyle: "",
          lineWidth: 1,
          globalAlpha: 1,
          font: "",
          textAlign: "",
          lineCap: "",
        },
        {
          get(t, k) {
            if (k in t) return t[k];
            return () => {};
          },
          set(t, k, v) {
            t[k] = v;
            return true;
          },
        },
      );
      // drawBackground 用到了 createRadialGradient，需要返回带 addColorStop 的对象
      noopCtx.createRadialGradient = () => ({ addColorStop: () => {} });
      return {
        width: 0,
        height: 0,
        getContext() {
          return noopCtx;
        },
      };
    },
  };
}

// ---------- comboText：纯逻辑 ----------
test("comboText 返回空串当连击小于 3", () => {
  assert.equal(comboText(0, 5), "");
  assert.equal(comboText(1, 12), "");
  assert.equal(comboText(2, 99), "");
});

test("comboText 在连击 ≥3 时返回形如「+12 击破」", () => {
  assert.equal(comboText(3, 12), "+12 击破");
  assert.equal(comboText(5, 17), "+17 击破");
  assert.equal(comboText(20, 1), "+1 击破");
});

test("comboText 容忍非有限或负值", () => {
  assert.equal(comboText(NaN, 5), "");
  assert.equal(comboText(Infinity, 5), "");
  assert.equal(comboText(-1, 5), "");
  assert.equal(comboText(3, NaN), "+0 击破");
  assert.equal(comboText(3, -4), "+0 击破");
});

// ---------- shakeOffset / shakeOffsetInto：抖动偏移 ----------
test("shakeOffset 在 reducedMotion=true 时三帧都返回 (0,0)", () => {
  for (let frame = 1; frame <= 3; frame++) {
    const o = shakeOffset(42, frame, true);
    assert.equal(o.x, 0);
    assert.equal(o.y, 0);
  }
});

test("shakeOffset 连续 3 帧序列可复现且单帧位移绝对值 ≤ 4px", () => {
  const seed = 7919;
  const seq = [
    shakeOffset(seed, 1, false),
    shakeOffset(seed, 2, false),
    shakeOffset(seed, 3, false),
  ];
  // 序列可复现：相同输入再次调用输出相同
  assert.deepEqual(shakeOffset(seed, 1, false), seq[0]);
  assert.deepEqual(shakeOffset(seed, 2, false), seq[1]);
  assert.deepEqual(shakeOffset(seed, 3, false), seq[2]);
  // 每帧 |x|、|y| ≤ 4
  for (const o of seq) {
    assert.ok(
      Math.abs(o.x) <= 4 && Math.abs(o.y) <= 4,
      `抖动越界 x=${o.x} y=${o.y}`,
    );
  }
  // 三帧间确有差异（不可能恒真），避免同义反复
  assert.ok(
    seq[0].x !== seq[1].x ||
      seq[0].y !== seq[1].y ||
      seq[1].x !== seq[2].x ||
      seq[1].y !== seq[2].y,
    "不同帧不应完全相同，否则测试等于恒真",
  );
});

test("shakeOffsetInto 把结果写到 out，不分配新对象", () => {
  const out = { x: 99, y: 99 };
  shakeOffsetInto(out, 1, 1, true);
  assert.equal(out.x, 0);
  assert.equal(out.y, 0);
  shakeOffsetInto(out, 1, 1, false);
  assert.ok(Math.abs(out.x) <= 4 && Math.abs(out.y) <= 4);
});

// ---------- clampTextX：x 边界 ----------
test("clampTextX 把负值与越界值夹在 [0, width] 内", () => {
  assert.equal(clampTextX(-50, WIDTH), 0);
  assert.equal(clampTextX(0, WIDTH), 0);
  assert.equal(clampTextX(WIDTH / 2, WIDTH), WIDTH / 2);
  assert.equal(clampTextX(WIDTH, WIDTH), WIDTH);
  assert.equal(clampTextX(WIDTH + 50, WIDTH), WIDTH);
});

test("clampTextX 对非数字输入返回 0", () => {
  assert.equal(clampTextX(NaN, WIDTH), 0);
  assert.equal(clampTextX(undefined, WIDTH), 0);
});

// ---------- 记录型假 ctx：捕获所有 ctx 方法 + 属性赋值 ----------
function makeFakeCtx() {
  const calls = [];
  const handler = {
    get(_target, key) {
      if (key === "calls") return calls;
      if (key === "ctx") return calls;
      // 默认每个方法调用都被记录下来
      return (...args) => {
        calls.push({ method: key, args });
      };
    },
    set(_target, key, value) {
      calls.push({ method: `set:${key}`, args: [value] });
      return true;
    },
  };
  return new Proxy({ calls }, handler);
}

function makeFakeCanvas() {
  const ctx = makeFakeCtx();
  return {
    width: WIDTH,
    height: HEIGHT,
    clientWidth: WIDTH,
    getContext: () => ctx,
    ctx,
  };
}

function makeBoss(mechanism, attackIn = 5) {
  return {
    x: 270,
    y: 160,
    radius: 66,
    hp: 180,
    maxHp: 180,
    stage: 0,
    order: [mechanism, "swarm", "gravity"],
    attackIn,
    flash: 0,
    pulseIn: 12,
    warnings:
      mechanism === "devour"
        ? [
            { id: 1, x: 200, y: 200, ttl: 1.5 },
            { id: 2, x: 360, y: 250, ttl: 1.2 },
          ]
        : [],
  };
}

function makeGame(boss) {
  return {
    phase: "boss",
    balls: [],
    monsters: [],
    bumpers: [],
    boss,
    time: 0,
    manualAim: false,
    launchIn: 4,
    aim: 0,
  };
}

// 统计「新增绘制路径」的调用次数：用于约束「单帧 ≤ 20、效果结束后回落 0」。
function newDrawCallCount(calls) {
  return calls.filter(
    (c) =>
      ["beginPath", "arc", "moveTo", "lineTo", "stroke", "fill", "fillText", "fillRect"].includes(
        c.method,
      ),
  ).length;
}

// ---------- BOSS 预警：在预警窗内每种机制各自至少绘制 1 次 ----------
// c.arc(x, y, radius, ...)：args[0]=x, args[1]=y, args[2]=radius
test("BOSS 预警：吞噬在预警窗内绘制地面震纹", () => {
  const canvas = makeFakeCanvas();
  const renderer = new Renderer(canvas);
  renderer.frame(makeGame(makeBoss("devour", 5.4)), 0, 1);
  // groundLevel = HEIGHT - 38；arc 的 args[1]=y，args[0]=x
  const groundY = HEIGHT - 38;
  const tremorArcs = canvas.ctx.calls.filter(
    (c) =>
      c.method === "arc" &&
      Math.abs(c.args[1] - groundY) <= 1 &&
      ((Math.abs(c.args[0] - 200) <= 1) || Math.abs(c.args[0] - 360) <= 1),
  );
  assert.ok(
    tremorArcs.length > 0,
    `devour 预警窗内应至少绘制 1 次震纹，实际 ${tremorArcs.length}`,
  );
  // 至少一次 set:strokeStyle 设置为吞噬色（含 alpha 后缀）
  const devourStrokes = canvas.ctx.calls.filter(
    (c) => c.method === "set:strokeStyle" && c.args[0].startsWith("#ef9d88"),
  );
  assert.ok(devourStrokes.length > 0);
  assert.equal(renderer.warningKind, "devour");
});

test("BOSS 预警：潮群在预警窗内绘制下沿水位线", () => {
  const canvas = makeFakeCanvas();
  const renderer = new Renderer(canvas);
  renderer.frame(makeGame(makeBoss("swarm", 5.4)), 0, 1);
  // 水位线接近底部：lineTo/moveTo 的 y 在 HEIGHT - 110 .. HEIGHT - 50
  const waterCalls = canvas.ctx.calls.filter(
    (c) =>
      (c.method === "moveTo" || c.method === "lineTo") &&
      c.args[1] >= HEIGHT - 110 &&
      c.args[1] <= HEIGHT - 50,
  );
  assert.ok(
    waterCalls.length > 0,
    `swarm 预警窗内应至少绘制 1 次水位线段，实际 ${waterCalls.length}`,
  );
  // 至少一次 set:strokeStyle 设置为潮群色
  const swarmStrokes = canvas.ctx.calls.filter(
    (c) => c.method === "set:strokeStyle" && c.args[0].startsWith("#efc66c"),
  );
  assert.ok(swarmStrokes.length > 0);
  assert.equal(renderer.warningKind, "swarm");
});

test("BOSS 预警：重潮在预警窗内绘制四角色脉冲", () => {
  const canvas = makeFakeCanvas();
  const renderer = new Renderer(canvas);
  renderer.frame(makeGame(makeBoss("gravity", 5.4)), 0, 1);
  // 四角之一：arc 的 args[0]=cx, args[1]=cy
  const cornerArcs = canvas.ctx.calls.filter(
    (c) =>
      c.method === "arc" &&
      [20, WIDTH - 20].some((cx) => Math.abs(c.args[0] - cx) <= 1) &&
      [76, HEIGHT - 76].some((cy) => Math.abs(c.args[1] - cy) <= 1),
  );
  assert.ok(
    cornerArcs.length > 0,
    `gravity 预警窗内应至少绘制 1 次角脉冲，实际 ${cornerArcs.length}`,
  );
  const gravityStrokes = canvas.ctx.calls.filter(
    (c) => c.method === "set:strokeStyle" && c.args[0].startsWith("#bca5e2"),
  );
  assert.ok(gravityStrokes.length > 0);
  assert.equal(renderer.warningKind, "gravity");
});

test("BOSS 预警：离开预警窗后绘制次数回落为 0", () => {
  // 先在预警窗内跑一帧，确认预警真的有绘制（用 devour 震纹特征）
  const canvasActive = makeFakeCanvas();
  const rendererActive = new Renderer(canvasActive);
  rendererActive.frame(makeGame(makeBoss("devour", 5.4)), 0, 1);
  const groundY = HEIGHT - 38;
  const tremorActive = canvasActive.ctx.calls.filter(
    (c) =>
      c.method === "arc" && Math.abs(c.args[1] - groundY) <= 1,
  );
  assert.ok(tremorActive.length > 0, "预警窗内应至少绘制 1 次震纹");

  // 离开预警窗：attackIn ≤ 4.5 → drawBossWarnings 应直接 return
  const canvasQuiet = makeFakeCanvas();
  const rendererQuiet = new Renderer(canvasQuiet);
  rendererQuiet.frame(makeGame(makeBoss("devour", 4.2)), 0, 1);
  const tremorAfter = canvasQuiet.ctx.calls.filter(
    (c) =>
      c.method === "arc" && Math.abs(c.args[1] - groundY) <= 1,
  );
  assert.equal(
    tremorAfter.length,
    0,
    `预警结束后震纹绘制次数应回落 0，实际 ${tremorAfter.length}`,
  );
  assert.equal(rendererQuiet.warningKind, null);
});

test("BOSS 预警：单帧新增绘制调用次数 ≤ 20，且不逐帧增长", () => {
  // 关键：本测试只统计预警独有的绘制路径，而不是整帧所有绘制。
  for (const mech of ["devour", "swarm", "gravity"]) {
    const canvas = makeFakeCanvas();
    const renderer = new Renderer(canvas);
    // 跑一帧（不设 baseline，因为其他绘制与本测试无关）
    renderer.frame(makeGame(makeBoss(mech, 5.4)), 0, 1);
    const warningDraws1 = warningDrawCount(canvas.ctx.calls, mech);
    assert.ok(
      warningDraws1 <= 20,
      `${mech} 预警单帧绘制 ${warningDraws1} 超出 20 上限`,
    );

    // 再跑一帧：预警独有绘制次数不应比第一帧更多（不会逐帧累积增长）
    renderer.frame(makeGame(makeBoss(mech, 5.0)), 1 / 60, 1);
    const warningDraws2 = warningDrawCount(canvas.ctx.calls, mech);
    assert.ok(
      warningDraws2 - warningDraws1 <= 20,
      `${mech} 第二帧预警绘制 ${warningDraws2 - warningDraws1} 超过第一帧 20 增量`,
    );

    // 离开预警窗后再跑一帧，预警独有绘制增量必须为 0
    const before = canvas.ctx.calls.length;
    renderer.frame(makeGame(makeBoss(mech, 4.0)), 1 / 60, 1);
    const allCalls = canvas.ctx.calls.slice(before);
    const newWarningDraws = warningDrawCount(allCalls, mech);
    assert.equal(
      newWarningDraws,
      0,
      `预警结束后独有绘制应回落 0，实际 ${newWarningDraws}`,
    );
  }
});

// 仅统计本预警机制独有的绘制（避免被 drawBoss/drawAim/drawEffects 的常规绘制污染）。
function warningDrawCount(calls, mech) {
  if (mech === "devour") {
    const groundY = HEIGHT - 38;
    let count = 0;
    for (const c of calls) {
      if (
        c.method === "arc" &&
        Math.abs(c.args[1] - groundY) <= 1
      )
        count++;
      else if (
        c.method === "beginPath" &&
        // 通过紧跟的 arc 是否在 groundY 上来判定
        calls[calls.indexOf(c) + 1]?.method === "arc" &&
        Math.abs(calls[calls.indexOf(c) + 1].args[1] - groundY) <= 1
      )
        count++;
      else if (c.method === "stroke" && c._ground) count++;
    }
    return count;
  }
  if (mech === "swarm") {
    return calls.filter(
      (c) =>
        (c.method === "moveTo" || c.method === "lineTo") &&
        c.args[1] >= HEIGHT - 110 &&
        c.args[1] <= HEIGHT - 50,
    ).length;
  }
  // gravity
  return calls.filter(
    (c) =>
      c.method === "arc" &&
      [20, WIDTH - 20].some((cx) => Math.abs(c.args[0] - cx) <= 1) &&
      [76, HEIGHT - 76].some((cy) => Math.abs(c.args[1] - cy) <= 1),
  ).length;
}

// ---------- 连击飘字：产生 + 累计 + 归零 ----------
test("连击飘字：连击 <3 不产生新飘字，连击 ≥3 产生「+N 击破」", () => {
  const canvas = makeFakeCanvas();
  const renderer = new Renderer(canvas);
  renderer.event({ type: "kill", x: 200, y: 200 });
  assert.equal(renderer.combo, 1);
  assert.equal(renderer.comboEffects.length, 0);

  renderer.event({ type: "kill", x: 200, y: 200 });
  assert.equal(renderer.combo, 2);
  assert.equal(renderer.comboEffects.length, 0);

  renderer.event({ type: "kill", x: 200, y: 200 });
  assert.equal(renderer.combo, 3);
  assert.equal(renderer.comboEffects.length, 1);
  assert.equal(renderer.comboEffects[0].text, "+3 击破");

  renderer.event({ type: "kill", x: 200, y: 200 });
  assert.equal(renderer.combo, 4);
  assert.equal(renderer.comboEffects.length, 2);
  // X 取本波累计击破数，第 4 个击破对应 killsInWave = 4
  assert.equal(renderer.comboEffects[1].text, "+4 击破");
});

test("连击飘字：连击归零后停止生成新飘字", () => {
  const canvas = makeFakeCanvas();
  const renderer = new Renderer(canvas);
  // 先攒出 3 击破 + 一条飘字
  for (let i = 0; i < 3; i++)
    renderer.event({ type: "kill", x: 200, y: 200 });
  assert.equal(renderer.combo, 3);
  assert.ok(renderer.comboEffects.length >= 1);

  // 用 frame 把连击 ttl 耗尽（comboTtl = 2.0s，跑 130 帧 ≈ 2.17s）
  for (let i = 0; i < 130; i++) renderer.frame(makeGame(null), 1 / 60, 1);
  assert.equal(renderer.combo, 0);

  // 之后两次杀怪不会生成新飘字（combo 仍 <3）
  const before = renderer.comboEffects.length;
  renderer.event({ type: "kill", x: 200, y: 200 });
  renderer.event({ type: "kill", x: 200, y: 200 });
  assert.equal(renderer.combo, 2);
  assert.equal(renderer.comboEffects.length, before);

  // 只有再次达到 combo=3 才会重新开始产生
  renderer.event({ type: "kill", x: 200, y: 200 });
  assert.equal(renderer.combo, 3);
  assert.equal(renderer.comboEffects.length, before + 1);
});

test("连击飘字：x 坐标 clamp 在 [0, canvas.width] 内，不出界", () => {
  const canvas = makeFakeCanvas();
  const renderer = new Renderer(canvas);
  // 三次杀怪分别在负值 / 越界值 / 居中
  renderer.event({ type: "kill", x: -120, y: 300 });
  renderer.event({ type: "kill", x: WIDTH + 300, y: 300 });
  renderer.event({ type: "kill", x: 270, y: 300 });
  // 跑一帧让飘字被画出来
  renderer.frame(makeGame(null), 0.01, 1);

  // 抓所有 fillText 的 x 参数（第 2 个参数）
  const textXs = canvas.ctx.calls
    .filter((c) => c.method === "fillText")
    .map((c) => c.args[1]);
  assert.ok(textXs.length > 0, "应至少画出一条飘字");
  for (const x of textXs) {
    assert.ok(
      x >= 0 && x <= WIDTH,
      `飘字 x=${x} 超出 [0, ${WIDTH}]`,
    );
  }
});

// ---------- 微抖动：reducedMotion 时归零；事件触发后 1~3 帧存在 ----------
test("微抖动：reducedMotion=true 时连续 3 帧抖动位移全部为 0", () => {
  const canvas = makeFakeCanvas();
  const renderer = new Renderer(canvas);
  renderer.reduced = true;
  renderer.event({ type: "disable", x: 200, y: 200 });
  assert.equal(renderer.microShake, 3);
  const offsets = [];
  for (let i = 0; i < 3; i++) {
    renderer.frame(makeGame(null), 1 / 60, 1);
    offsets.push({ x: renderer._shakeBuf.x, y: renderer._shakeBuf.y });
  }
  for (const o of offsets) {
    assert.equal(o.x, 0);
    assert.equal(o.y, 0);
  }
});

test("微抖动：bomb disable 与 split hit 都触发 1~3 帧抖动，单帧位移 ≤ 4px", () => {
  // bomb disable 触发
  const canvas1 = makeFakeCanvas();
  const r1 = new Renderer(canvas1);
  r1.reduced = false;
  r1.event({ type: "disable", x: 200, y: 200 });
  assert.ok(r1.microShake >= 1 && r1.microShake <= 3);
  // 跑一帧，看 _shakeBuf 是否在合理范围
  r1.frame(makeGame(null), 1 / 60, 1);
  assert.ok(
    Math.abs(r1._shakeBuf.x) <= 4 && Math.abs(r1._shakeBuf.y) <= 4,
    `disable 抖动越界 x=${r1._shakeBuf.x} y=${r1._shakeBuf.y}`,
  );
  // 抖动自然衰减：最多 3 帧后归 0
  for (let i = 0; i < 5; i++) r1.frame(makeGame(null), 1 / 60, 1);
  assert.equal(r1.microShake, 0);

  // 分裂球命中触发
  const canvas2 = makeFakeCanvas();
  const r2 = new Renderer(canvas2);
  r2.reduced = false;
  r2.event({ type: "hit", x: 200, y: 200, power: "split", value: 3 });
  assert.ok(r2.microShake >= 1 && r2.microShake <= 3);
});

test("微抖动：抖动结束后 microShake 归 0，不再逐帧产生偏移", () => {
  const canvas = makeFakeCanvas();
  const renderer = new Renderer(canvas);
  renderer.reduced = false;
  renderer.event({ type: "disable", x: 200, y: 200 });
  assert.ok(renderer.microShake > 0);
  // 跑完整个抖动窗口（最多 3 帧）
  for (let i = 0; i < 4; i++) renderer.frame(makeGame(null), 1 / 60, 1);
  assert.equal(renderer.microShake, 0, "抖动结束后 microShake 应归 0");
  // 再跑一帧，_shakeBuf 不变（不再产生新抖动偏移）
  const beforeX = renderer._shakeBuf.x;
  const beforeY = renderer._shakeBuf.y;
  renderer.frame(makeGame(null), 1 / 60, 1);
  assert.equal(renderer._shakeBuf.x, beforeX);
  assert.equal(renderer._shakeBuf.y, beforeY);
});

test("波形 / BOSS 阶段切换时连击与累计击破归零", () => {
  const canvas = makeFakeCanvas();
  const renderer = new Renderer(canvas);
  for (let i = 0; i < 5; i++) renderer.event({ type: "kill", x: 200, y: 200 });
  assert.equal(renderer.combo, 5);
  assert.equal(renderer.killsInWave, 5);
  renderer.event({ type: "wave", wave: 2 });
  assert.equal(renderer.combo, 0);
  assert.equal(renderer.killsInWave, 0);
  assert.equal(renderer.comboTtl, 0);
});