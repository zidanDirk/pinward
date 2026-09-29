import test from "node:test";
import assert from "node:assert/strict";
import { Game, COMBO_WINDOW, comboTierFor } from "../src/game.js";
import { createBall, createMonster } from "../src/entities.js";
import { TYPES, drawCards } from "../src/cards.js";
import { wavePlan, bossOrder, WAVE_MIN_SECONDS, REWARD_SECONDS } from "../src/waves.js";
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
  // 本波一次性护盾会吸收首轮触底的 HP 损失：此处显式清零以保持「10 次 leak 归零」语义。
  game.shieldLeft = 0;
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

test("hit event carries score and comboTier snapshot for combo ×2 electric kill", () => {
  const game = new Game();
  game.comboCount = 5;
  game.comboTier = comboTierFor(5);
  const m = createMonster(game.nextId++, "normal", 1, 4);
  m.hp = 1;
  game.monsters = [m];
  game.damage(m, 1, "electric");
  const hits = game.events.filter((e) => e.type === "hit");
  assert.ok(hits.length >= 1);
  // 连锁 ≥1 时取最后一条，校验 payload 含 score / comboTier 字段且值符合 15 * 1.5 * comboMul
  const last = hits[hits.length - 1];
  assert.equal(last.score, 45);
  assert.equal(last.comboTier, 2);
});

test("standard hit score is 15 with comboTier 0 and 1, both ×1", () => {
  for (const tier of [0, 1]) {
    const game = new Game();
    game.comboTier = tier;
    const m = createMonster(game.nextId++, "normal", 1, 4);
    m.hp = 5;
    game.monsters = [m];
    game.damage(m, 1, "standard");
    const hits = game.events.filter((e) => e.type === "hit");
    assert.equal(hits[hits.length - 1].score, 15);
    assert.equal(hits[hits.length - 1].comboTier, tier);
  }
});

test("damageBoss hit carries score 35 / comboTier 0 ignoring game.comboTier, lethal hit nulls score", () => {
  const game = new Game();
  game.beginBoss();
  game.comboCount = 5;
  game.comboTier = 4;
  const before = game.score;
  game.damageBoss(10, "electric");
  const midHits = game.events.filter((e) => e.type === "hit");
  assert.equal(midHits[midHits.length - 1].score, 35);
  assert.equal(midHits[midHits.length - 1].comboTier, 0);
  // 非致命命中：当局总分只 +35，不乘 comboMul
  assert.equal(game.score - before, 35);
  game.damageBoss(999, "standard");
  const allHits = game.events.filter((e) => e.type === "hit");
  // 致命一击只发一次 hit，score 固定 null
  assert.equal(allHits[allHits.length - 1].score, null);
  assert.equal(allHits[allHits.length - 1].comboTier, 0);
  // 终局击杀只 +3000，不再叠加命中分
  assert.equal(game.score - before, 35 + 3000);
  assert.equal(game.phase, "over");
  assert.equal(game.won, true);
  assert.equal(game.comboCount, 6);
});

test("electric chain emits multiple hits each carrying score and comboTier", () => {
  const game = new Game();
  game.comboTier = 1;
  const a = createMonster(game.nextId++, "normal", 1, 4);
  const b = createMonster(game.nextId++, "normal", 1, 5);
  a.y = 500;
  b.y = 500;
  a.hp = 1;
  b.hp = 1;
  game.monsters = [a, b];
  // amount=2 让连锁 1.4 仍 ≥1，hp=1 的相邻怪死于同帧
  game.damage(a, 2, "electric");
  const hits = game.events.filter((e) => e.type === "hit");
  assert.ok(hits.length >= 2);
  // 连锁发生在 registerKill() 之前，整条锁都带同一档位的 score / comboTier
  for (const hit of hits) {
    assert.equal(hit.score, 15 * 1.5);
    assert.equal(hit.comboTier, 1);
  }
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

test("leak during wave phase flags waveHadLeak; boss-phase leak does not", () => {
  const game = new Game();
  // 波次阶段漏怪：标记置位
  game.phase = "wave";
  game.wave = 3;
  assert.equal(game.waveHadLeak, false);
  game.leak();
  assert.equal(game.waveHadLeak, true);
  assert.equal(game.hp, 9);
  // 同一帧再 leak：标记保持 true，HP 继续扣血
  game.leak();
  assert.equal(game.waveHadLeak, true);
  assert.equal(game.hp, 8);
  // BOSS 阶段：标记不被置位
  game.beginBoss();
  assert.equal(game.waveHadLeak, false);
  game.leak();
  assert.equal(game.waveHadLeak, false);
  // BOSS 脉冲路径：把 pulseIn 置 0，让 updateBoss 自己调用 leak()，同样不置位
  game.boss.pulseIn = 0;
  game.updateBoss(STEP);
  assert.equal(game.waveHadLeak, false);
});

test("beginWave resets waveHadLeak so two perfect waves emit two events", () => {
  const game = new Game();
  // 先让漏怪标记为 true，验证 beginWave 会复位
  game.phase = "wave";
  game.wave = 1;
  game.waveHadLeak = true;
  game.beginWave();
  assert.equal(game.waveHadLeak, false);
  assert.equal(game.wave, 2);
  // 第一波结算：构造空波 + 空怪物 + 满足最短时长
  game.events = [];
  game.plan = [];
  game.monsters = [];
  game.waveTime = WAVE_MIN_SECONDS;
  game.update(STEP);
  assert.equal(game.phase, "reward");
  const firstPerfect = game.events.filter((e) => e.type === "perfectWave");
  assert.equal(firstPerfect.length, 1);
  assert.equal(firstPerfect[0].wave, 2);
  assert.equal(firstPerfect[0].bonus, 50 + 2 * 50);
  // 手动调用 chooseCard 走通 beginWave 路径（自动选牌会先发 wave 事件并清零标记）
  // 这里直接 beginWave 进入 wave 3，验证标记也被复位
  game.waveHadLeak = true;
  game.beginWave();
  assert.equal(game.wave, 3);
  assert.equal(game.waveHadLeak, false);
  // 第二波同样构造完美结算
  game.events = [];
  game.plan = [];
  game.monsters = [];
  game.waveTime = WAVE_MIN_SECONDS;
  game.update(STEP);
  assert.equal(game.phase, "reward");
  const secondPerfect = game.events.filter((e) => e.type === "perfectWave");
  assert.equal(secondPerfect.length, 1);
  assert.equal(secondPerfect[0].wave, 3);
  assert.equal(secondPerfect[0].bonus, 50 + 3 * 50);
  // 累计：两次结算各产生一次 perfectWave，共 2 次
  assert.equal(firstPerfect.length + secondPerfect.length, 2);
});

test("perfectWave at wave=1 grants exactly 100 score and one event with bonus payload", () => {
  const game = new Game();
  game.wave = 1;
  game.phase = "wave";
  game.plan = [];
  game.monsters = [];
  game.waveTime = WAVE_MIN_SECONDS;
  game.events = [];
  const before = game.score;
  game.update(STEP);
  assert.equal(game.phase, "reward");
  assert.equal(game.score - before, 100);
  const events = game.events.filter((e) => e.type === "perfectWave");
  assert.equal(events.length, 1);
  assert.equal(events[0].wave, 1);
  assert.equal(events[0].bonus, 100);
});

test("perfectWave at wave=12 grants exactly 650 score and one event with bonus payload", () => {
  const game = new Game();
  game.wave = 12;
  game.phase = "wave";
  game.plan = [];
  game.monsters = [];
  game.waveTime = WAVE_MIN_SECONDS;
  game.events = [];
  const before = game.score;
  game.update(STEP);
  assert.equal(game.phase, "reward");
  assert.equal(game.score - before, 650);
  const events = game.events.filter((e) => e.type === "perfectWave");
  assert.equal(events.length, 1);
  assert.equal(events[0].wave, 12);
  assert.equal(events[0].bonus, 650);
});

test("leak before settlement suppresses perfectWave bonus and event", () => {
  const game = new Game();
  game.wave = 5;
  game.phase = "wave";
  game.plan = [];
  game.monsters = [];
  game.waveTime = WAVE_MIN_SECONDS;
  // 结算前先 leak()：标记置位，结算时不应加分与发事件
  game.leak();
  assert.equal(game.waveHadLeak, true);
  game.events = [];
  const before = game.score;
  game.update(STEP);
  assert.equal(game.phase, "reward");
  assert.equal(game.score, before);
  assert.equal(game.events.filter((e) => e.type === "perfectWave").length, 0);
});

test("perfectWave fires only once per wave and not after reward advances further", () => {
  const game = new Game();
  game.wave = 2;
  game.phase = "wave";
  game.plan = [];
  game.monsters = [];
  game.waveTime = WAVE_MIN_SECONDS;
  game.events = [];
  const before = game.score;
  game.update(STEP);
  assert.equal(game.phase, "reward");
  assert.equal(game.score - before, 50 + 2 * 50);
  assert.equal(game.events.filter((e) => e.type === "perfectWave").length, 1);
  // 进入 reward 后继续推进帧：reward 早退不会重复触发结算分支
  advance(game, 1);
  assert.equal(game.events.filter((e) => e.type === "perfectWave").length, 1);
  // 超过 REWARD_SECONDS 自动选卡进入下一波：waveHadLeak 复位，且不会再补发上一波的事件
  advance(game, REWARD_SECONDS);
  assert.equal(game.events.filter((e) => e.type === "perfectWave").length, 1);
});

test("tenth leak ends the run before settlement so no bonus and no perfectWave fire", () => {
  const game = new Game();
  game.wave = 4;
  game.phase = "wave";
  game.plan = [];
  game.monsters = [];
  game.waveTime = WAVE_MIN_SECONDS;
  game.hp = 1;
  // 制造结算失败：hp 归零后 finish(false) 把 phase 置为 "over"
  // 此时再次调用 update() 会因 phase === "over" 早退，永远不会进入结算分支
  game.leak();
  assert.equal(game.phase, "over");
  assert.equal(game.hp, 0);
  game.events = [];
  const before = game.score;
  game.update(STEP);
  assert.equal(game.phase, "over");
  assert.equal(game.score, before);
  assert.equal(game.events.filter((e) => e.type === "perfectWave").length, 0);
});

test("shieldLeft defaults to 0 and is set to 1 by beginWave and reset by beginBoss", () => {
  const game = new Game();
  assert.equal(game.shieldLeft, 0);
  // 直接调用 beginWave（不依赖 start 路径）以验证字段刷新逻辑
  game.beginWave();
  assert.equal(game.shieldLeft, 1);
  // 同一波内已被消耗后，第二次 beginWave 必须重新发放
  game.shieldLeft = 0;
  game.beginWave();
  assert.equal(game.shieldLeft, 1);
  // beginBoss 必须把残留的护盾复位为 0，避免跨阶段进入 BOSS 后仍生效
  game.shieldLeft = 5;
  game.beginBoss();
  assert.equal(game.shieldLeft, 0);
});

test("wave-phase first leak with shieldLeft=1 absorbs HP and emits shielded leak + shieldSave", () => {
  const game = new Game();
  game.wave = 4;
  game.phase = "wave";
  game.shieldLeft = 1;
  game.hp = 7;
  game.events = [];
  game.leak();
  // 护盾已耗尽，但 waveHadLeak 仍置位，HP 不变
  assert.equal(game.shieldLeft, 0);
  assert.equal(game.waveHadLeak, true);
  assert.equal(game.hp, 7);
  // 事件顺序：先 leak{shielded:true}，后 shieldSave{hpLeft === 扣血前的 hp}
  assert.deepEqual(
    game.events.map((e) => e.type),
    ["leak", "shieldSave"],
  );
  const [leakEvent, saveEvent] = game.events;
  assert.equal(leakEvent.shielded, true);
  assert.equal(saveEvent.hpLeft, 7);
});

test("wave-phase second leak after shield consumption applies normal HP loss and no shieldSave", () => {
  const game = new Game();
  game.wave = 4;
  game.phase = "wave";
  game.shieldLeft = 1;
  game.hp = 7;
  game.leak();
  // 同一波内第二次触底：护盾已耗尽，走原有扣血路径
  game.events = [];
  game.leak();
  assert.equal(game.shieldLeft, 0);
  assert.equal(game.hp, 6);
  assert.equal(game.waveHadLeak, true);
  assert.equal(game.events.length, 1);
  assert.equal(game.events[0].type, "leak");
  assert.equal(game.events[0].shielded, undefined);
  assert.equal(
    game.events.some((e) => e.type === "shieldSave"),
    false,
  );
});

test("leak with shieldLeft=0 matches pre-change behavior on hp, waveHadLeak and event payload", () => {
  const game = new Game();
  game.wave = 4;
  game.phase = "wave";
  game.shieldLeft = 0;
  game.hp = 7;
  game.events = [];
  game.leak();
  assert.equal(game.hp, 6);
  assert.equal(game.waveHadLeak, true);
  assert.equal(game.events.length, 1);
  assert.equal(game.events[0].type, "leak");
  assert.equal(game.events[0].shielded, undefined);
  assert.equal(
    game.events.some((e) => e.type === "shieldSave"),
    false,
  );
});

test("beginBoss clears shieldLeft and BOSS leak / pulse paths never emit shieldSave", () => {
  const game = new Game();
  game.beginBoss();
  assert.equal(game.shieldLeft, 0);
  // BOSS 阶段直接 leak：不消耗护盾、不发 shieldSave
  game.events = [];
  game.leak();
  assert.equal(game.shieldLeft, 0);
  assert.equal(game.waveHadLeak, false);
  assert.equal(game.hp, 9);
  assert.equal(
    game.events.some((e) => e.type === "shieldSave"),
    false,
  );
  // BOSS 脉冲路径：让 updateBoss 自调 leak，同样不产生 shieldSave
  game.events = [];
  game.boss.pulseIn = 0;
  game.updateBoss(STEP);
  assert.equal(
    game.events.some((e) => e.type === "shieldSave"),
    false,
  );
});

test("shield-absorbed wave still suppresses perfectWave bonus and event", () => {
  const game = new Game();
  game.wave = 5;
  game.phase = "wave";
  game.plan = [];
  game.monsters = [];
  game.waveTime = WAVE_MIN_SECONDS;
  game.shieldLeft = 1;
  // 护盾抵消漏怪：waveHadLeak 已被置位，结算时不加分、不发 perfectWave
  game.leak();
  assert.equal(game.waveHadLeak, true);
  assert.equal(game.hp, 10);
  game.events = [];
  const before = game.score;
  game.update(STEP);
  assert.equal(game.phase, "reward");
  assert.equal(game.score, before);
  assert.equal(game.events.filter((e) => e.type === "perfectWave").length, 0);
});

test("new Game() and beginWave() reset wavePeakCombo and wavePeakTier to 0", () => {
  const game = new Game();
  assert.equal(game.wavePeakCombo, 0);
  assert.equal(game.wavePeakTier, 0);
  game.wave = 1;
  game.wavePeakCombo = 7;
  game.wavePeakTier = 3;
  game.beginWave();
  assert.equal(game.wavePeakCombo, 0);
  assert.equal(game.wavePeakTier, 0);
});

test("wavePeakCombo and wavePeakTier track the max within a wave and survive breakCombo", () => {
  const game = new Game();
  game.start();
  game.plan = [];
  const killOne = () => {
    const m = createMonster(game.nextId++, "normal", 1, 4);
    m.hp = 1;
    game.monsters = [m];
    game.damage(m, 1, "standard");
  };
  // 连击累加 1→5：peakCombo=5、peakTier=2（×2）
  for (let i = 0; i < 5; i++) killOne();
  assert.equal(game.wavePeakCombo, 5);
  assert.equal(game.wavePeakTier, 2);
  // breakCombo() 清空 comboCount / comboTier，但峰值不下降
  game.breakCombo();
  assert.equal(game.comboCount, 0);
  assert.equal(game.comboTier, 0);
  assert.equal(game.wavePeakCombo, 5);
  assert.equal(game.wavePeakTier, 2);
  // 再累计到 12：peakCombo 取更大值 12、peakTier=3
  for (let i = 0; i < 12; i++) killOne();
  assert.equal(game.wavePeakCombo, 12);
  assert.equal(game.wavePeakTier, 3);
  assert.equal(game.comboTier, comboTierFor(12));
});

test("hot perfectWave doubles bonus and emits hot: true when wavePeakCombo >= 10", () => {
  for (const [peak, expectedTier] of [
    [10, 3],
    [15, 4],
  ]) {
    const game = new Game();
    game.wave = 1;
    game.phase = "wave";
    game.plan = [];
    game.monsters = [];
    game.waveTime = WAVE_MIN_SECONDS;
    game.wavePeakCombo = peak;
    game.wavePeakTier = expectedTier;
    game.events = [];
    const before = game.score;
    game.update(STEP);
    assert.equal(game.phase, "reward");
    const events = game.events.filter((e) => e.type === "perfectWave");
    assert.equal(events.length, 1);
    assert.equal(events[0].hot, true);
    assert.equal(events[0].bonus, (50 + 1 * 50) * 2);
    assert.equal(events[0].wave, 1);
    assert.equal(game.score - before, (50 + 1 * 50) * 2);
  }
});

test("non-hot perfectWave keeps bonus at 50+wave*50 and emits hot: false for peak 0 and 9", () => {
  for (const peak of [0, 9]) {
    const game = new Game();
    game.wave = 3;
    game.phase = "wave";
    game.plan = [];
    game.monsters = [];
    game.waveTime = WAVE_MIN_SECONDS;
    game.wavePeakCombo = peak;
    game.wavePeakTier = comboTierFor(peak);
    game.events = [];
    const before = game.score;
    game.update(STEP);
    assert.equal(game.phase, "reward");
    const events = game.events.filter((e) => e.type === "perfectWave");
    assert.equal(events.length, 1);
    assert.equal(events[0].hot, false);
    assert.equal(events[0].bonus, 50 + 3 * 50);
    assert.equal(events[0].wave, 3);
    assert.equal(game.score - before, 50 + 3 * 50);
  }
});

test("beginBoss resets peak fields and BOSS-phase kills never emit perfectWave", () => {
  const game = new Game();
  // 先用一次击杀把峰值拉高
  game.start();
  game.plan = [];
  const m = createMonster(game.nextId++, "normal", 1, 4);
  m.hp = 1;
  game.monsters = [m];
  game.damage(m, 1, "standard");
  assert.equal(game.wavePeakCombo, 1);
  assert.equal(game.wavePeakTier, 1);
  // 进入 BOSS 阶段：峰值归零
  game.beginBoss();
  assert.equal(game.wavePeakCombo, 0);
  assert.equal(game.wavePeakTier, 0);
  // 终结 BOSS：registerKill 会再写一次峰值，但 phase 已经是 "over"
  game.events = [];
  game.damageBoss(999, "standard");
  assert.equal(game.phase, "over");
  assert.equal(game.events.filter((e) => e.type === "perfectWave").length, 0);
});

test("hot perfectWave fires exactly once and is not re-emitted on reward advance", () => {
  const game = new Game();
  game.wave = 1;
  game.phase = "wave";
  game.plan = [];
  game.monsters = [];
  game.waveTime = WAVE_MIN_SECONDS;
  game.wavePeakCombo = 12; // 触发 hot
  game.wavePeakTier = comboTierFor(12);
  game.events = [];
  game.update(STEP);
  assert.equal(game.phase, "reward");
  assert.equal(game.events.filter((e) => e.type === "perfectWave").length, 1);
  // reward 阶段推进：不补发 perfectWave
  advance(game, 1);
  assert.equal(game.events.filter((e) => e.type === "perfectWave").length, 1);
  // 超过 REWARD_SECONDS 自动选卡进入下一波：beginWave 复位峰值且不再补发上一波事件
  advance(game, REWARD_SECONDS);
  assert.equal(game.wave, 2);
  assert.equal(game.wavePeakCombo, 0);
  assert.equal(game.events.filter((e) => e.type === "perfectWave").length, 1);
});

test("manual aim within 0.6s window grants 200*comboMul skill shot on first kill", () => {
  const game = new Game();
  const m = createMonster(game.nextId++, "normal", 1, 4);
  m.hp = 1;
  game.monsters = [m];
  // 提前记录结算前倍率快照，与 game.damage 顶部 const comboMul 同口径
  const before = game.score;
  const mul = Math.max(1, game.comboTier);
  const tierBefore = game.comboTier;
  game.events = [];
  game.manualAim = true;
  game.launch();
  // launch 之后窗口开启、标记为 false
  assert.equal(game.skillShotWindow, 0.6);
  assert.equal(game.skillShotConsumed, false);
  game.damage(m, 999);
  // 恰好一次 skillShot 事件，bonus 与 comboTier 与结算前快照一致
  const events = game.events.filter((e) => e.type === "skillShot");
  assert.equal(events.length, 1);
  assert.equal(events[0].bonus, 200 * mul);
  assert.equal(events[0].comboTier, tierBefore);
  assert.equal(game.skillShotConsumed, true);
  assert.equal(game.skillShotWindow, 0);
  // 总增分：命中 15 + 击杀 100 + 精准一击 200，全部乘结算前倍率快照
  assert.equal(game.score - before, (15 + 100 + 200) * mul);
});

test("manual aim window only fires skill shot once even when multiple kills happen within it", () => {
  const game = new Game();
  const a = createMonster(game.nextId++, "normal", 1, 4);
  const b = createMonster(game.nextId++, "normal", 1, 5);
  a.hp = 1;
  b.hp = 1;
  game.monsters = [a, b];
  game.events = [];
  game.manualAim = true;
  game.launch();
  game.damage(a, 999);
  // 首杀触发一次 skillShot、窗口被消化
  assert.equal(
    game.events.filter((e) => e.type === "skillShot").length,
    1,
  );
  assert.equal(game.skillShotConsumed, true);
  assert.equal(game.skillShotWindow, 0);
  // 窗口内后续击杀：不再补发 skillShot
  game.damage(b, 999);
  assert.equal(
    game.events.filter((e) => e.type === "skillShot").length,
    1,
  );
});

test("auto aim (-15°..+15°) never opens skill shot window and never emits skillShot", () => {
  const game = new Game();
  // 拉到 tier 2（×2）后发球，验证自动瞄准不消费 skillShot 通道
  game.comboCount = 5;
  game.comboTier = comboTierFor(5);
  game.events = [];
  const before = game.score;
  // 默认 manualAim 为 false，自动 ±15° 随机
  game.launch();
  assert.ok(game.skillShotWindow <= 0);
  assert.equal(game.skillShotConsumed, false);
  const m = createMonster(game.nextId++, "normal", 1, 4);
  m.hp = 1;
  game.monsters = [m];
  game.damage(m, 1);
  assert.equal(
    game.events.filter((e) => e.type === "skillShot").length,
    0,
  );
  // 仅命中 + 击杀（×2）：30 + 200 = 230
  assert.equal(game.score - before, 230);
  assert.equal(game.skillShotWindow, 0);
});

test("skill shot window expires naturally without bonus or event if no kill happens", () => {
  const game = new Game();
  game.manualAim = true;
  game.launch();
  assert.equal(game.skillShotWindow, 0.6);
  // 推帧 0.6 + STEP，期间清空 monsters / plan 防止 launch()/spawn 干扰
  game.monsters = [];
  game.plan = [];
  advance(game, 0.6 + STEP);
  assert.ok(game.skillShotWindow <= 0);
  game.events = [];
  const before = game.score;
  const m = createMonster(game.nextId++, "normal", 1, 4);
  m.hp = 1;
  game.monsters = [m];
  game.damage(m, 1);
  assert.equal(
    game.events.filter((e) => e.type === "skillShot").length,
    0,
  );
  // 默认 tier = 0、comboMul = 1，仅命中 + 击杀 = 15 + 100
  assert.equal(game.score - before, 15 + 100);
});

test("beginWave, beginBoss and changeBossStage silently reset skill shot window", () => {
  const game = new Game();
  // beginWave 必须静默复位窗口与消耗标记
  game.skillShotWindow = 0.3;
  game.skillShotConsumed = true;
  game.events = [];
  game.beginWave();
  assert.equal(game.skillShotWindow, 0);
  assert.equal(game.skillShotConsumed, false);
  assert.equal(
    game.events.filter((e) => e.type === "skillShot").length,
    0,
  );
  // beginBoss 同样静默复位
  game.skillShotWindow = 0.4;
  game.skillShotConsumed = true;
  game.events = [];
  game.beginBoss();
  assert.equal(game.skillShotWindow, 0);
  assert.equal(game.skillShotConsumed, false);
  assert.equal(
    game.events.filter((e) => e.type === "skillShot").length,
    0,
  );
  // changeBossStage(1) 同样静默复位；与 beginBoss → changeBossStage(0) 幂等
  game.skillShotWindow = 0.2;
  game.skillShotConsumed = true;
  game.events = [];
  game.changeBossStage(1);
  assert.equal(game.skillShotWindow, 0);
  assert.equal(game.skillShotConsumed, false);
  assert.equal(
    game.events.filter((e) => e.type === "skillShot").length,
    0,
  );
});

test("skill shot window is cleared between waves so next auto-launch has no carryover", () => {
  const game = new Game();
  game.wave = 1;
  game.phase = "wave";
  // 本波手动瞄准发球开窗：尚未结束本波
  game.manualAim = true;
  game.launch();
  assert.equal(game.skillShotWindow, 0.6);
  // 直接进入下一波：beginWave 必须显式复位窗口（场景：奖励阶段窗口冻结→换波抵消）
  game.events = [];
  game.beginWave();
  assert.equal(game.wave, 2);
  assert.equal(game.skillShotWindow, 0);
  assert.equal(game.skillShotConsumed, false);
  // 随后自动瞄准（manualAim 为 false）发球再击杀：不得触发 skillShot
  game.plan = [];
  const m = createMonster(game.nextId++, "normal", 1, 4);
  m.hp = 1;
  game.monsters = [m];
  game.launch();
  game.damage(m, 1);
  assert.equal(
    game.events.filter((e) => e.type === "skillShot").length,
    0,
  );
});

test("damageBoss path never triggers skill shot and boss kill reward stays 3000", () => {
  const game = new Game();
  game.beginBoss();
  // 手动瞄准开窗：验证 damageBoss 路径不读窗口
  game.manualAim = true;
  game.launch();
  assert.equal(game.skillShotWindow, 0.6);
  game.events = [];
  // 击杀 BOSS：仅 3000 固定奖励、不发 skillShot
  const beforeBoss = game.score;
  game.damageBoss(999, "standard");
  assert.equal(game.score - beforeBoss, 3000);
  assert.equal(
    game.events.filter((e) => e.type === "skillShot").length,
    0,
  );
  // BOSS 阶段召唤的普通怪走 damage() 时不影响 3000 分固定奖励路径：
  // 即先杀普通怪（吃一次精准一击）再杀 BOSS，BOSS 的 3000 路径仍然独立不变
  const game2 = new Game();
  game2.beginBoss();
  game2.manualAim = true;
  game2.launch();
  game2.events = [];
  const m = createMonster(game2.nextId++, "normal", 12, 4);
  m.hp = 1;
  game2.monsters = [m];
  game2.damage(m, 1);
  // 普通怪击杀：comboMul = 1，命中 15 + 击杀 100 = 115
  assert.equal(game2.skillShotConsumed, true);
  // 再击杀 BOSS：3000 分固定奖励、不再发 skillShot
  const beforeBoss2 = game2.score;
  game2.damageBoss(999, "standard");
  assert.equal(game2.score - beforeBoss2, 3000);
  assert.equal(
    game2.events.filter((e) => e.type === "skillShot").length,
    1,
  );
});
