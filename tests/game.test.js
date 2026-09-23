import test from "node:test";
import assert from "node:assert/strict";
import { Game, COMBO_WINDOW, comboTierFor } from "../src/game.js";
import { createBall, createMonster } from "../src/entities.js";
import { TYPES, drawCards } from "../src/cards.js";
import { wavePlan, bossOrder } from "../src/waves.js";
import { seededRandom, STEP } from "../src/physics.js";
import {
  defaultProfile,
  readProfile,
  saveProfile,
  recordRun,
  buyUpgrade,
} from "../src/storage.js";

const advance = (game, seconds) => {
  for (let i = 0; i < Math.round(seconds / STEP); i++) game.update(STEP);
};

test("new run has two placed bumpers, 10 hp and no retained construction", () => {
  const game = new Game();
  assert.equal(game.bumpers.length, 2);
  assert.equal(game.hp, 10);
  assert.equal(game.phase, "build");
  assert.equal(game.score, 0);
});

test("initial frost choice still works after recycling both starting bumpers", () => {
  const game = new Game({ choiceUnlocked: true });
  game.remove(2, 9);
  game.remove(6, 9);
  game.startChoice = "frost";
  game.start();
  assert.equal(game.phase, "wave");
  assert.equal(game.inventory.standard, 1);
  assert.equal(game.inventory.frost, 1);
});
test("inventory is conserved across place, rotate, occupied-cell rejection and recycle", () => {
  const game = new Game({ slots: 3 });
  assert.equal(game.inventory.standard, 1);
  assert.equal(game.place(4, 6), true);
  assert.equal(game.inventory.standard, 0);
  assert.equal(game.place(4, 6), false);
  assert.equal(game.rotate(4, 6), true);
  assert.equal(game.remove(4, 6), true);
  assert.equal(game.inventory.standard, 1);
  assert.equal(game.remove(4, 6), false);
  assert.equal(game.place(4, 0), false);
  assert.equal(game.place(4, 13), false);
});
test("pause freezes launches, enemies, reward countdown and construction", () => {
  const game = new Game();
  game.start();
  advance(game, 1);
  game.paused = true;
  const snapshot = JSON.stringify(game);
  advance(game, 10);
  assert.equal(JSON.stringify(game), snapshot);
  assert.equal(game.remove(2, 9), false);
  game.phase = "reward";
  game.rewardLeft = 6;
  advance(game, 10);
  assert.equal(game.rewardLeft, 6);
});
test("reward auto-selects first card after six seconds exactly once", () => {
  const game = new Game();
  game.wave = 1;
  game.phase = "reward";
  game.cards = ["electric", "frost", "heavy"];
  game.rewardLeft = 6;
  advance(game, 5.9);
  assert.equal(game.phase, "reward");
  advance(game, 0.2);
  assert.equal(game.wave, 2);
  assert.equal(game.inventory.electric, 1);
  assert.equal(game.chooseCard(0), false);
});
test("BOSS reroll is only available once before the boss and grants a fresh window", () => {
  const game = new Game();
  game.phase = "reward";
  game.wave = 11;
  assert.equal(game.reroll(), false);
  game.wave = 12;
  assert.equal(game.reroll(), true);
  assert.equal(game.rewardLeft, 6);
  assert.equal(game.reroll(), false);
});
test("every reward has three unique valid cards with early safety picks", () => {
  const rng = seededRandom(42);
  for (let wave = 1; wave <= 12; wave++)
    for (let i = 0; i < 40; i++) {
      const cards = drawCards(wave, rng);
      assert.equal(new Set(cards).size, 3);
      assert.ok(cards.every((c) => TYPES[c]));
      if (wave <= 4)
        assert.ok(cards.includes("standard") || cards.includes("heavy"));
    }
});
test("waves scale from 8 to 18 and introduce swift/bomb on waves 5/9", () => {
  const rng = seededRandom(99);
  for (let wave = 1; wave <= 12; wave++) {
    const plan = wavePlan(wave, rng);
    assert.equal(plan.length, Math.min(18, wave + 7));
    assert.ok(plan.every((m) => m.col >= 0 && m.col <= 8));
    if (wave < 5) assert.ok(plan.every((m) => m.type !== "swift"));
    if (wave < 9) assert.ok(plan.every((m) => m.type !== "bomb"));
  }
});
test("electric chains to neighbors; frost slows; heavy pushes three cells", () => {
  const game = new Game();
  const a = createMonster(100, "tank", 12, 4),
    b = createMonster(101, "tank", 12, 5);
  a.y = 500;
  b.y = 500;
  game.monsters = [a, b];
  game.damage(a, 1, "electric");
  assert.ok(b.hp < b.maxHp);
  assert.ok(game.events.some((e) => e.type === "lightning"));
  a.y = 500;
  game.damage(a, 1, "frost");
  assert.equal(a.frozen, 2);
  assert.equal(a.y, 440);
  a.y = 500;
  game.damage(a, 1, "heavy");
  assert.equal(a.y, 320);
});
test("split bumper creates one child without recursive exponential growth", () => {
  const game = new Game();
  game.selected = "split";
  game.inventory.split = 1;
  game.place(4, 7);
  game.start();
  const bumper = game.bumpers.at(-1);
  bumper.angle = 0;
  game.launchIn = 99;
  const ball = createBall(500, 0, bumper.x, bumper.y - 18);
  ball.vy = 760;
  game.balls = [ball];
  advance(game, 0.1);
  assert.equal(game.balls.filter((b) => b.small).length, 1);
  assert.equal(game.balls.length, 2);
});
test("bomb disables a bumper for five seconds and it recovers", () => {
  const game = new Game();
  game.start();
  game.plan = [];
  const b = game.bumpers[0];
  const monster = createMonster(500, "bomb", 9, b.col);
  monster.y = b.y - 15;
  game.monsters = [monster];
  game.launchIn = 99;
  game.update(STEP);
  assert.ok(b.disabled > 4.9);
  game.monsters = [];
  advance(game, 5.1);
  assert.equal(b.disabled, 0);
});
test("ten leaks end a run and rewards cannot resurrect it", () => {
  const game = new Game();
  game.start();
  for (let i = 0; i < 10; i++) game.leak();
  assert.equal(game.phase, "over");
  assert.equal(game.hp, 0);
  assert.equal(game.won, false);
  const time = game.time;
  advance(game, 60);
  assert.equal(game.time, time);
});
test("boss has three distinct mechanics, transition signals and a victory", () => {
  const game = new Game({ rng: seededRandom(5) });
  game.wave = 12;
  game.beginBoss();
  assert.equal(new Set(game.boss.order).size, 3);
  assert.equal(game.boss.stage, 0);
  game.damageBoss(61, "standard");
  assert.equal(game.boss.stage, 1);
  assert.equal(game.slowTime, 1.2);
  game.damageBoss(60, "heavy");
  assert.equal(game.boss.stage, 2);
  assert.equal(game.events.filter((e) => e.type === "bossStage").length, 3);
  game.damageBoss(60, "electric");
  assert.equal(game.phase, "over");
  assert.equal(game.won, true);
});
test("boss attacks actually disable, summon and change phase state", () => {
  const game = new Game();
  game.beginBoss();
  game.boss.order = ["devour", "swarm", "gravity"];
  game.boss.attackIn = 0;
  game.updateBoss(STEP);
  assert.equal(game.boss.warnings.length, 2);
  game.updateBoss(1.6);
  assert.ok(game.bumpers.every((b) => b.disabled === 5));
  game.changeBossStage(1);
  game.boss.attackIn = 0;
  game.updateBoss(STEP);
  assert.equal(game.monsters.length, 3);
  game.changeBossStage(2);
  game.boss.attackIn = 0;
  game.updateBoss(STEP);
  assert.ok(game.monsters.some((m) => m.type === "tank"));
});
test("boss order is a permutation over varied seeds", () => {
  for (let i = 0; i < 30; i++)
    assert.deepEqual(bossOrder(seededRandom(i)).sort(), [
      "devour",
      "gravity",
      "swarm",
    ]);
});

test("storage tolerates corruption, denied access and clamps invalid upgrades", () => {
  assert.deepEqual(
    readProfile({
      getItem() {
        throw new Error("denied");
      },
    }),
    defaultProfile(),
  );
  assert.deepEqual(
    readProfile({ getItem: () => "not json" }),
    defaultProfile(),
  );
  const profile = readProfile({
    getItem: () => JSON.stringify({ stars: -20, slots: 99, runs: ["bad"] }),
  });
  assert.equal(profile.stars, 0);
  assert.equal(profile.slots, 4);
  assert.equal(profile.runs.length, 0);
  assert.equal(saveProfile(profile, null), false);
});
test("stars persist, upgrades cost currency and a replay clears the board", () => {
  const profile = defaultProfile();
  const game = new Game();
  game.score = 8000;
  game.wave = 13;
  game.finish(true);
  assert.equal(recordRun(profile, game), 18);
  assert.equal(profile.best, 8000);
  assert.equal(buyUpgrade(profile, "slots"), true);
  assert.equal(profile.stars, 6);
  assert.equal(profile.slots, 3);
  assert.equal(buyUpgrade(profile, "choice"), false);
  profile.stars = 100;
  assert.equal(buyUpgrade(profile, "choice"), true);
  assert.equal(buyUpgrade(profile, "choice"), false);
  const replay = new Game({
    slots: profile.slots,
    choiceUnlocked: profile.choiceUnlocked,
  });
  assert.equal(replay.score, 0);
  assert.equal(replay.wave, 0);
  assert.equal(replay.bumpers.length, 2);
  assert.equal(replay.inventory.standard, 1);
  replay.startChoice = "frost";
  replay.start();
  assert.equal(replay.bumpers[0].type, "frost");
});

const layout = [
  [4, 9],
  [4, 6],
  [2, 6],
  [6, 6],
  [1, 4],
  [7, 4],
  [3, 3],
  [5, 3],
  [0, 8],
  [8, 8],
  [3, 11],
  [5, 11],
];
for (let seed = 1; seed <= 8; seed++)
  test(`full 12-wave run + three-phase boss, seed ${seed}, finishes in 4–6 minutes`, () => {
    const game = new Game({ rng: seededRandom(seed) });
    game.start();
    let elapsed = 0;
    const stages = new Set(),
      waves = new Set();
    while (game.phase !== "over" && elapsed < 400) {
      if (game.phase === "reward" && game.rewardLeft < 0.05) {
        const index = game.cards.findIndex(
          (c) => c === "electric" || c === "split",
        );
        game.chooseCard(Math.max(index, 0));
      }
      for (const [type, count] of Object.entries(game.inventory))
        if (count > 0) {
          game.selected = type;
          for (const [col, row] of layout) if (game.place(col, row)) break;
        }
      game.update(STEP);
      elapsed += STEP;
      for (const event of game.events) {
        if (event.type === "bossStage") stages.add(event.stage);
        if (event.type === "wave") waves.add(event.wave);
      }
      game.events = [];
      assert.ok(
        game.balls.length <= 18 &&
          game.bumpers.length <= 18 &&
          game.monsters.length <= 24,
      );
      assert.ok(
        game.balls.every((b) => Number.isFinite(b.x) && Number.isFinite(b.y)),
      );
    }
    assert.equal(game.won, true);
    assert.equal(game.wave, 13);
    assert.equal(waves.size, 12);
    assert.equal(stages.size, 3);
    assert.ok(elapsed >= 240 && elapsed <= 360, `Run length ${elapsed}s`);
  });

test("comboTierFor maps thresholds and caps at tier 4", () => {
  assert.equal(comboTierFor(0), 0);
  assert.equal(comboTierFor(-3), 0);
  assert.equal(comboTierFor(1), 1);
  assert.equal(comboTierFor(4), 1);
  assert.equal(comboTierFor(5), 2);
  assert.equal(comboTierFor(9), 2);
  assert.equal(comboTierFor(10), 3);
  assert.equal(comboTierFor(14), 3);
  assert.equal(comboTierFor(15), 4);
  assert.equal(comboTierFor(16), 4);
  assert.equal(comboTierFor(99), 4);
});

test("kills within window accumulate comboCount and reset comboTimer each time", () => {
  const game = new Game();
  game.start();
  // 清空 plan 防止 update() 期间生成额外怪物干扰连击状态断言
  game.plan = [];
  const killOne = () => {
    const m = createMonster(game.nextId++, "normal", 1, 4);
    m.hp = 1;
    game.monsters = [m];
    game.damage(m, 1, "standard");
  };
  killOne();
  assert.equal(game.comboCount, 1);
  assert.equal(game.comboTier, 1);
  assert.equal(game.comboTimer, COMBO_WINDOW);
  // 1.5 秒后仍未超时：定时器递减但 comboCount 不变
  game.monsters = [];
  game.plan = [];
  advance(game, 1.5);
  assert.equal(game.comboCount, 1);
  assert.ok(game.comboTimer < COMBO_WINDOW);
  assert.ok(game.comboTimer > COMBO_WINDOW - 1.6);
  // 窗口内再击杀一次：计数 +1、定时器重置回 COMBO_WINDOW
  killOne();
  assert.equal(game.comboCount, 2);
  assert.equal(game.comboTier, 1);
  assert.equal(game.comboTimer, COMBO_WINDOW);
});

test("combo times out after COMBO_WINDOW seconds and emits comboBreak exactly once", () => {
  const game = new Game();
  game.start();
  game.plan = [];
  const m = createMonster(game.nextId++, "normal", 1, 4);
  m.hp = 1;
  game.monsters = [m];
  game.damage(m, 1, "standard");
  game.events = [];
  game.monsters = [];
  game.plan = [];
  advance(game, COMBO_WINDOW + 0.1);
  assert.equal(game.comboCount, 0);
  assert.equal(game.comboTier, 0);
  assert.equal(game.comboTimer, 0);
  assert.equal(
    game.events.filter((e) => e.type === "comboBreak").length,
    1,
  );
  // 后续帧不得重复发 comboBreak
  advance(game, 1);
  assert.equal(game.events.filter((e) => e.type === "comboBreak").length, 1);
});

test("breakCombo is silent when combo is already zero", () => {
  const game = new Game();
  game.events = [];
  game.breakCombo();
  assert.equal(
    game.events.filter((e) => e.type === "comboBreak").length,
    0,
  );
  // 即使 update() 推进多帧，没有击杀也不会触发 comboBreak
  game.start();
  game.plan = [];
  advance(game, 5);
  assert.equal(
    game.events.filter((e) => e.type === "comboBreak").length,
    0,
  );
});

test("non-killing hit does not advance comboCount or refresh comboTimer", () => {
  const game = new Game();
  const tank = createMonster(game.nextId++, "tank", 12, 4);
  game.monsters = [tank];
  game.damage(tank, 1, "standard");
  assert.ok(tank.hp > 0);
  assert.equal(game.comboCount, 0);
  assert.equal(game.comboTier, 0);
  assert.equal(game.comboTimer, 0);
});

test("combo multiplier multiplies hit and kill score using the pre-kill snapshot", () => {
  const game = new Game();
  // 提前把 tier 拉到 2（×2），但不触发击杀累加，保证本帧倍率快照唯一。
  game.comboCount = 5;
  game.comboTier = comboTierFor(5);
  const before = game.score;
  const m = createMonster(game.nextId++, "normal", 1, 4);
  m.hp = 1;
  game.monsters = [m];
  // electric ×1.5 叠加 combo ×2：命中 15*1.5*2 = 45，击杀 MONSTERS.normal.score*1.5*2 = 100*1.5*2 = 300
  game.damage(m, 1, "electric");
  assert.equal(game.score - before, 45 + 300);
  assert.equal(game.comboCount, 6);
  assert.equal(game.comboTier, 2);
});

test("boss hit and finish scores ignore combo multiplier", () => {
  const game = new Game();
  game.beginBoss();
  game.comboCount = 5;
  game.comboTier = 4;
  const before = game.score;
  game.damageBoss(10, "electric");
  assert.equal(game.score - before, 35);
  game.damageBoss(999, "standard");
  assert.equal(game.score - before, 35 + 3000);
  assert.equal(game.phase, "over");
  // 终局击杀仍触发一次 registerKill
  assert.equal(game.comboCount, 6);
});

test("beginWave and changeBossStage silently reset combo fields without events", () => {
  const game = new Game({ rng: seededRandom(3) });
  // 直接喂一个低血量怪物制造一次击杀拉起连击
  const m = createMonster(game.nextId++, "normal", 1, 4);
  m.hp = 1;
  game.monsters = [m];
  game.damage(m, 1, "standard");
  assert.equal(game.comboCount, 1);
  game.events = [];
  game.beginWave();
  assert.equal(game.comboCount, 0);
  assert.equal(game.comboTimer, 0);
  assert.equal(game.comboTier, 0);
  assert.equal(
    game.events.some((e) => e.type === "comboBreak" || e.type === "comboTier"),
    false,
  );
  // chooseCard 触发的下一波也走 beginWave，同样静默
  game.comboCount = 3;
  game.comboTier = 1;
  game.comboTimer = 1;
  game.events = [];
  game.beginWave();
  assert.equal(game.comboCount, 0);
  assert.equal(game.comboTier, 0);
  assert.equal(game.comboTimer, 0);
  assert.equal(
    game.events.some((e) => e.type === "comboBreak" || e.type === "comboTier"),
    false,
  );
  // BOSS 阶段切换同样静默清零
  game.beginBoss();
  game.comboCount = 7;
  game.comboTier = 2;
  game.comboTimer = 1.5;
  game.events = [];
  game.changeBossStage(1);
  assert.equal(game.comboCount, 0);
  assert.equal(game.comboTier, 0);
  assert.equal(game.comboTimer, 0);
  assert.equal(
    game.events.some((e) => e.type === "comboBreak" || e.type === "comboTier"),
    false,
  );
});

test("electric chain registers combo for each kill in the same frame", () => {
  const game = new Game();
  const a = createMonster(game.nextId++, "normal", 1, 4);
  const b = createMonster(game.nextId++, "normal", 1, 5);
  a.y = 500;
  b.y = 500;
  a.hp = 1;
  b.hp = 1;
  game.monsters = [a, b];
  // amount=2 使连锁衰减后仍 ≥1，确保 hp=1 的相邻怪也死于同帧
  game.damage(a, 2, "electric");
  assert.equal(game.comboCount, 2);
  assert.equal(game.comboTier, 1);
});

test("comboTier event fires only on tier promotion past ×1", () => {
  const game = new Game();
  const killOne = () => {
    const m = createMonster(game.nextId++, "normal", 1, 4);
    m.hp = 1;
    game.monsters = [m];
    game.damage(m, 1, "standard");
  };
  game.events = [];
  for (let i = 0; i < 5; i++) killOne();
  const tiers = game.events.filter((e) => e.type === "comboTier");
  // 前 4 杀停在 ×1，第 5 杀触发 ×2
  assert.equal(tiers.length, 1);
  assert.equal(tiers[0].tier, 2);
  assert.equal(tiers[0].count, 5);
});

test("comboTier caps at 4 and emits only on 5/10/15 promotions", () => {
  const game = new Game();
  const killOne = () => {
    const m = createMonster(game.nextId++, "normal", 1, 4);
    m.hp = 1;
    game.monsters = [m];
    game.damage(m, 1, "standard");
  };
  game.events = [];
  for (let i = 0; i < 16; i++) killOne();
  assert.equal(game.comboCount, 16);
  assert.equal(game.comboTier, 4);
  const tiers = game.events.filter((e) => e.type === "comboTier");
  assert.equal(tiers.length, 3);
  assert.deepEqual(
    tiers.map((e) => [e.count, e.tier]),
    [
      [5, 2],
      [10, 3],
      [15, 4],
    ],
  );
});

test("combo timer freezes while paused and resumes afterwards", () => {
  const game = new Game();
  game.start();
  game.plan = [];
  const m = createMonster(game.nextId++, "normal", 1, 4);
  m.hp = 1;
  game.monsters = [m];
  game.damage(m, 1, "standard");
  assert.equal(game.comboCount, 1);
  game.paused = true;
  game.monsters = [];
  advance(game, 5);
  // 暂停期间 combo 冻结
  assert.equal(game.comboCount, 1);
  assert.equal(game.comboTimer, COMBO_WINDOW);
  game.paused = false;
  advance(game, COMBO_WINDOW + 0.1);
  assert.equal(game.comboCount, 0);
  assert.equal(game.comboTimer, 0);
  assert.ok(
    game.events.some((e) => e.type === "comboBreak"),
  );
});
