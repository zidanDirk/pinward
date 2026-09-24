// Optional browser QA. Install Playwright separately; the app serves vendored Three.js.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const { chromium, webkit } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const url = process.env.TEST_URL || "http://localhost:4173";
await mkdir("test-results", { recursive: true });
const results = [];
const launchArgs = process.env.SOFTWARE_WEBGL
  ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
  : [];

async function checkBrowser(type, name, options = {}) {
  const browser = await type.launch({
    headless: true,
    ...(type === chromium ? { args: launchArgs } : {}),
    ...(name === "Chrome desktop" ? { channel: "chrome" } : {}),
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      ...options,
    });
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await page.goto(url);
    await page.waitForFunction(
      () => document.querySelector("canvas").dataset.ready === "true",
    );
    assert.equal(await page.locator("#render-error").isVisible(), false);
    assert.equal(
      await page.locator("canvas").getAttribute("data-renderer"),
      "three-webgl",
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    // Inspect state only in the test harness, with no production debug globals.
    await page.evaluate(async () => {
      const { Game } = await import("./src/game.js");
      const { Renderer } = await import("./src/renderer.js");
      const update = Game.prototype.update,
        frame = Renderer.prototype.frame;
      Game.prototype.update = function (dt) {
        window.__qaGame = this;
        return update.call(this, dt);
      };
      Renderer.prototype.frame = function (...args) {
        window.__qaRenderer = this;
        return frame.apply(this, args);
      };
    });
    await page.waitForFunction(() => window.__qaRenderer && window.__qaGame);
    const details = await page.evaluate(() => {
      const r = window.__qaRenderer;
      let meshes = 0;
      r.scene.traverse((o) => {
        if (o.isMesh) meshes++;
      });
      return {
        webgl2: r.webgl.getContext() instanceof WebGL2RenderingContext,
        meshes,
        triangles: r.webgl.info.render.triangles,
      };
    });
    assert.equal(details.webgl2, true);
    assert.ok(details.meshes > 40);
    assert.ok(details.triangles > 1000);
    async function checkContextRecovery(pausedAfter) {
      await page.evaluate(() => {
        window.__qaContextLoss = window.__qaRenderer.webgl
          .getContext()
          .getExtension("WEBGL_lose_context");
        window.__qaContextLoss.loseContext();
      });
      await page.waitForFunction(
        () => !document.querySelector("#render-error").hidden,
      );
      await page.waitForTimeout(150);
      await page.evaluate(() => window.__qaContextLoss.restoreContext());
      await page.waitForFunction(
        () =>
          !window.__qaRenderer.contextLost &&
          document.querySelector("#render-error").hidden,
      );
      assert.equal(
        await page.evaluate(() => window.__qaGame.paused),
        pausedAfter,
      );
    }
    if (name === "Chrome desktop") await checkContextRecovery(false);
    const slug = name.toLowerCase().replaceAll(" ", "-");
    await page.screenshot({
      path: `test-results/${slug}-start.png`,
      fullPage: true,
    });
    await page.locator("#help").click();
    assert.equal(await page.locator("#help-dialog").isVisible(), true);
    await page.locator('[data-close="help-dialog"]').click();
    await page.locator("#mobile-upgrades").click();
    assert.equal(await page.locator("#upgrade-options button").count(), 2);
    await page.locator('[data-close="upgrade-dialog"]').click();
    await page.locator("#mobile-records").click();
    assert.match(await page.locator("#record-list").innerText(), /第一段/);
    await page.locator('[data-close="records-dialog"]').click();
    async function pointFor(col, row, height = 18) {
      await page.locator("canvas").scrollIntoViewIfNeeded();
      return page.evaluate(
        async ({ col, row, height }) => {
          const { projectBoard } = await import("./src/board-view.js");
          return projectBoard(
            window.__qaRenderer.camera,
            document.querySelector("canvas").getBoundingClientRect(),
            col * 60 + 30,
            row * 60 + 30,
            height,
          );
        },
        { col, row, height },
      );
    }
    async function clickCell(col, row, height = 18) {
      const p = await pointFor(col, row, height);
      await page.mouse.click(p.x, p.y);
    }
    // Click a visible 3D bumper, use its context controls, then repeat in top view.
    for (const mode of ["3d", "top"]) {
      await page.locator(`[data-view="${mode}"]`).click();
      await clickCell(2, 9);
      assert.equal(await page.locator("#selection-toolbar").isVisible(), true);
      const before = await page.evaluate(
        () =>
          window.__qaGame.bumpers.find((b) => b.col === 2 && b.row === 9).angle,
      );
      await page.locator("#rotate-selected").click();
      const after = await page.evaluate(
        () =>
          window.__qaGame.bumpers.find((b) => b.col === 2 && b.row === 9).angle,
      );
      assert.ok(Math.abs(after - before - Math.PI / 4) < 1e-8);
      await page.locator("#remove-selected").click();
      assert.equal(
        await page.evaluate(() => window.__qaGame.bumpers.length),
        1,
      );
      await page.locator('[data-type="standard"]').click();
      await clickCell(2, 9, 0);
      assert.equal(
        await page.evaluate(() => window.__qaGame.bumpers.length),
        2,
      );
      await page.locator("#clear-selected").click();
    }
    await page.locator('[data-view="3d"]').click();
    // Touch gestures must hit the projected board, including raised object tops.
    const point = await pointFor(2, 9);
    const startTouch = async (ids) =>
      page.locator("canvas").evaluate(
        (c, { ids, point }) => {
          c.setPointerCapture = () => {};
          for (const id of ids)
            c.dispatchEvent(
              new PointerEvent("pointerdown", {
                bubbles: true,
                pointerId: id,
                pointerType: "touch",
                button: 0,
                clientX: point.x,
                clientY: point.y,
              }),
            );
        },
        { ids, point },
      );
    const endTouch = async (ids) =>
      page.locator("canvas").evaluate((c, ids) => {
        for (const id of ids)
          c.dispatchEvent(
            new PointerEvent("pointerup", {
              bubbles: true,
              pointerId: id,
              pointerType: "touch",
            }),
          );
      }, ids);
    const initialAngle = await page.evaluate(
      () =>
        window.__qaGame.bumpers.find((b) => b.col === 2 && b.row === 9).angle,
    );
    await startTouch([11]);
    await page.waitForTimeout(900);
    await endTouch([11]);
    assert.ok(
      Math.abs(
        (await page.evaluate(
          () =>
            window.__qaGame.bumpers.find((b) => b.col === 2 && b.row === 9)
              .angle,
        )) -
          initialAngle -
          Math.PI / 4,
      ) < 1e-8,
    );
    await startTouch([21, 22]);
    await page.waitForTimeout(900);
    await endTouch([21, 22]);
    assert.equal(await page.evaluate(() => window.__qaGame.bumpers.length), 1);
    await page.locator('[data-type="standard"]').click();
    await clickCell(2, 9, 0);
    await page.locator("#start").click();
    if (name === "Chrome desktop") {
      await checkContextRecovery(true);
      await page.locator("#resume").click();
    }
    await page.waitForTimeout(700);
    assert.match(await page.locator("#board-status").innerText(), /防线营业/);
    await page.locator("#pause").click();
    const elapsed = await page.locator("#timer").innerText();
    await page.waitForTimeout(250);
    assert.equal(await page.locator("#timer").innerText(), elapsed);
    await page.locator("#resume").click();
    await page.locator("#aim").fill("12");
    await page.locator("#aim-confirm").click();
    assert.equal(await page.locator("#aim-value").innerText(), "+12°");
    await page.locator("#sound").click();
    assert.equal(
      await page.locator("#sound").getAttribute("aria-pressed"),
      "false",
    );
    await page.screenshot({
      path: `test-results/${slug}-playing.png`,
      fullPage: true,
    });
    if (name === "Chrome desktop") {
      // Advance the real simulation to its next reward, then observe its real six-second UI timeout.
      await page.evaluate(() => {
        const g = window.__qaGame;
        for (let i = 0; i < 3600 && g.phase === "wave"; i++) g.update(1 / 60);
      });
      await page.waitForFunction(
        () => document.querySelector("#reward-dialog").open,
      );
      assert.equal(await page.locator("[data-card]").count(), 3);
      await page.screenshot({
        path: "test-results/reward.png",
        fullPage: true,
      });
      await page.waitForFunction(
        () => !document.querySelector("#reward-dialog").open,
        {},
        { timeout: 15000 },
      );
      assert.equal(await page.locator("#wave").innerText(), "02");
      await page.evaluate(() => navigator.serviceWorker.ready);
      await page.waitForFunction(() => !!navigator.serviceWorker.controller);
      await context.setOffline(true);
      await page.reload();
      await page.waitForFunction(
        () => document.querySelector("canvas").dataset.ready === "true",
      );
      assert.equal(await page.locator("#start").isEnabled(), true);
      assert.equal(
        await page.locator("#sound").getAttribute("aria-pressed"),
        "false",
      );
      await context.setOffline(false);
      const unsupported = await context.newPage();
      await unsupported.addInitScript(() => {
        const getContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, ...args) {
          return type.startsWith("webgl")
            ? null
            : getContext.call(this, type, ...args);
        };
      });
      await unsupported.goto(url);
      await unsupported.waitForFunction(
        () => !document.querySelector("#render-error").hidden,
      );
      assert.equal(await unsupported.locator("#start").isDisabled(), true);
      await unsupported.close();
    }
    assert.deepEqual(errors, []);
    results.push({ browser: name, passed: true, ...details });
    await writeFile(
      "test-results/browser-results-3d.json",
      JSON.stringify(results, null, 2),
    );
    console.log(
      `PASS ${name}: ${details.meshes} 3D meshes, ${details.triangles} triangles`,
    );
  } finally {
    await browser.close();
  }
}
for (const [type, name, options] of [
  [chromium, "Chrome desktop"],
  [
    chromium,
    "Chromium mobile emulation",
    {
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    },
  ],
  [webkit, "WebKit desktop"],
])
  if (!process.env.TEST_BROWSER || name.includes(process.env.TEST_BROWSER))
    await checkBrowser(type, name, options);
