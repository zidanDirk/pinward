// Browser scene QA with test-side state setup; no debug hooks ship in the game.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
await mkdir("test-results", { recursive: true });
const browser = await chromium.launch({
  headless: true,
  channel: "chrome",
  args: process.env.SOFTWARE_WEBGL
    ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
    : [],
});
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(process.env.TEST_URL || "http://localhost:4173");
  await page.evaluate(async () => {
    const { Game } = await import("./src/game.js");
    const original = Game.prototype.update;
    Game.prototype.update = function (dt) {
      window.__qaGame = this;
      return original.call(this, dt);
    };
  });
  await page.waitForFunction(() => window.__qaGame);
  await page.locator("#start").click();
  // 用真实击杀事件检查合并后的倍率 UI，暂停时连击倒计时也应冻结。
  await page.evaluate(async () => {
    const g = window.__qaGame;
    const { createMonster } = await import("./src/entities.js");
    for (let i = 0; i < 5; i++)
      g.damage(createMonster(9000 + i, "normal", 1, i), 999);
    g.paused = true;
  });
  await page.waitForTimeout(250);
  assert.equal(await page.locator("#combo-count").innerText(), "5");
  assert.match(await page.locator("#combo-text").innerText(), /2× 得分/);
  const comboTimer = await page.evaluate(() => window.__qaGame.comboTimer);
  await page.waitForTimeout(150);
  assert.equal(
    await page.evaluate(() => window.__qaGame.comboTimer),
    comboTimer,
  );
  await page.evaluate(() => {
    window.__qaGame.breakCombo();
    window.__qaGame.paused = false;
  });
  await page.waitForTimeout(150);
  assert.equal(await page.locator("#combo-badge").isVisible(), false);
  await page.evaluate(async () => {
    const g = window.__qaGame;
    const types = ["electric", "frost", "heavy", "split", "wide", "standard"];
    for (const [i, cell] of [
      [4, 9],
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
      [4, 6],
    ].entries()) {
      g.selected = types[i % types.length];
      g.inventory[g.selected]++;
      g.place(...cell);
    }
    g.beginBoss();
  });
  await page.waitForTimeout(1700);
  assert.match(await page.locator("#boss-banner").innerText(), /PHASE 1/);
  await page.screenshot({
    path: "test-results/boss-stage-1.png",
    fullPage: true,
  });
  await page.evaluate(() => {
    window.__qaGame.damageBoss(61, "electric");
  });
  await page.waitForTimeout(250);
  assert.match(await page.locator("#boss-banner").innerText(), /PHASE 2/);
  await page.screenshot({
    path: "test-results/boss-stage-2.png",
    fullPage: true,
  });
  await page.evaluate(() => {
    const g = window.__qaGame;
    g.damageBoss(Math.max(0, g.boss.hp - 55), "heavy");
  });
  await page.waitForTimeout(250);
  assert.match(await page.locator("#boss-banner").innerText(), /PHASE 3/);
  await page.screenshot({
    path: "test-results/boss-stage-3.png",
    fullPage: true,
  });
  await page.evaluate(() => window.__qaGame.damageBoss(999, "electric"));
  await page.waitForFunction(
    () => document.querySelector("#result-dialog").open,
  );
  assert.match(await page.locator("#result-title").innerText(), /防线仍在/);
  await page.screenshot({ path: "test-results/victory.png", fullPage: true });
  const stars = await page.locator("#stars").innerText();
  await page.locator("#restart").click();
  await page.waitForFunction(
    () => window.__qaGame.phase === "wave" && window.__qaGame.wave === 1,
  );
  assert.equal(await page.locator("#result-dialog").isVisible(), false);
  assert.equal(await page.locator("#wave").innerText(), "01");
  assert.equal(await page.locator("#score").innerText(), "000000");
  assert.equal(await page.locator("#stars").innerText(), stars);
  await page.evaluate(() => {
    for (let i = 0; i < 10; i++) window.__qaGame.leak();
  });
  await page.waitForFunction(
    () => document.querySelector("#result-dialog").open,
  );
  assert.match(await page.locator("#result-title").innerText(), /潮水先赢/);
  await page.screenshot({ path: "test-results/defeat.png", fullPage: true });
  await page.locator("#back-to-build").click();
  await page.waitForFunction(() => window.__qaGame.phase === "build");
  await page.locator("#mobile-records").click();
  assert.equal(await page.locator(".record-row").count(), 2);
  await page.locator('[data-close="records-dialog"]').click();
  await page.locator("#start").click();
  await page.waitForFunction(() => window.__qaGame.phase === "wave");
  // Representative late-wave rendering: many monsters and every bumper effect.
  await page.evaluate(async () => {
    const g = window.__qaGame;
    const { createMonster, createBall } = await import("./src/entities.js");
    g.wave = 12;
    g.plan = [];
    g.spawned = 0;
    g.monsters = Array.from({ length: 24 }, (_, i) =>
      Object.assign(
        createMonster(
          1000 + i,
          ["normal", "swift", "tank", "bomb"][i % 4],
          12,
          i % 9,
        ),
        { y: 120 + Math.floor(i / 9) * 100 },
      ),
    );
    for (let i = 0; i < 16; i++) {
      g.selected = ["electric", "frost", "heavy", "split", "wide", "standard"][
        i % 6
      ];
      g.inventory[g.selected]++;
      g.place(i % 9, 4 + Math.floor(i / 9) * 3);
    }
    g.balls = Array.from({ length: 18 }, (_, i) =>
      Object.assign(
        createBall(
          2000 + i,
          (i - 9) * 0.1,
          30 + (i % 9) * 60,
          500 + Math.floor(i / 9) * 100,
        ),
        { ttl: 60 },
      ),
    );
  });
  const session = await context.newCDPSession(page);
  await session.send("Performance.enable");
  const metric = async () =>
    Object.fromEntries(
      (await session.send("Performance.getMetrics")).metrics.map((m) => [
        m.name,
        m.value,
      ]),
    );
  const before = await metric();
  const fps = await page.evaluate(
    () =>
      new Promise((resolve) => {
        let frames = 0,
          start = performance.now();
        const tick = (now) => {
          frames++;
          if (now - start >= 5000) resolve((frames * 1000) / (now - start));
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
  const after = await metric();
  const performanceResult = {
    browser: await browser.version(),
    viewport: "1440×1000",
    mode: process.env.SOFTWARE_WEBGL
      ? "headless Chrome, SwiftShader WebGL"
      : "headless Chrome, native GPU WebGL",
    sampleSeconds: after.Timestamp - before.Timestamp,
    fps,
    mainThreadBusyPercent:
      (100 * (after.TaskDuration - before.TaskDuration)) /
      (after.Timestamp - before.Timestamp),
  };
  await writeFile(
    "test-results/performance.json",
    JSON.stringify(performanceResult, null, 2),
  );
  await page.screenshot({ path: "test-results/late-wave.png", fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      { scenes: "passed", performance: performanceResult },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
