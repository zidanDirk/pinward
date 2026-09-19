// Optional QA tooling only. The shipped game and npm test have zero dependencies.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node tests/browser.mjs
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const { chromium, webkit } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const url = process.env.TEST_URL || "http://localhost:4173";
await mkdir("test-results", { recursive: true });
const results = [];

async function checkBrowser(type, name, options = {}) {
  const browser = await type.launch({
    headless: true,
    ...(type === chromium ? { args: ["--disable-gpu"] } : {}),
    ...(name === "Chrome desktop" ? { channel: "chrome" } : {}),
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      ...options,
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.addInitScript(() => {
      let seed = 1;
      Math.random = () => {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    });
    await page.goto(url);
    await page.waitForFunction(
      () => document.querySelectorAll("[data-type]").length === 6,
    );
    await page.waitForFunction(
      () =>
        document
          .querySelector("canvas")
          .getContext("2d")
          .getImageData(20, 20, 1, 1).data[3] === 255,
    );
    const slug = name.toLowerCase().replaceAll(" ", "-");
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      "no horizontal overflow",
    );
    const background = await page
      .locator("canvas")
      .evaluate((c) => [...c.getContext("2d").getImageData(20, 20, 1, 1).data]);
    assert.equal(background[3], 255);
    assert.ok(background[1] > background[0], "teal board is rendered");
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
    await page.locator("#start").click();
    await page.waitForTimeout(1000);
    assert.match(
      await page.locator("#board-status").innerText(),
      /DEFENSE ACTIVE/,
    );
    await page.locator("#pause").click();
    const paused = await page.locator("#timer").innerText();
    await page.waitForTimeout(300);
    assert.equal(await page.locator("#timer").innerText(), paused);
    assert.equal(await page.locator("#pause-overlay").isVisible(), true);
    await page.locator("#resume").click();
    await page.locator("#aim").fill("12");
    await page.locator("#aim-confirm").click();
    assert.equal(await page.locator("#aim-value").innerText(), "+12°");
    await page.locator("#sound").click();
    assert.equal(
      await page.locator("#sound").getAttribute("aria-pressed"),
      "false",
    );
    // Tool buttons are the accessible equivalent of mouse and touch gestures.
    await page.locator('[data-tool="remove"]').click();
    await page.locator("canvas").scrollIntoViewIfNeeded();
    // Recompute viewport coordinates after mobile scrolling.
    async function clickCell(col, row) {
      const box = await page.locator("canvas").boundingBox();
      await page.mouse.click(
        box.x + ((col + 0.5) / 9) * box.width,
        box.y + ((row + 0.5) / 14) * box.height,
      );
    }
    await clickCell(2, 9);
    assert.match(await page.locator("#bumper-count").innerText(), /01/);
    await page.locator('[data-type="standard"]').click();
    await page.locator("canvas").scrollIntoViewIfNeeded();
    await clickCell(2, 9);
    assert.match(await page.locator("#bumper-count").innerText(), /02/);
    await page.locator('[data-tool="rotate"]').click();
    await page.locator("canvas").scrollIntoViewIfNeeded();
    await clickCell(2, 9);
    await page.locator("#pause").click();
    await page.locator("#resume").click();
    await page.screenshot({
      path: `test-results/${slug}-playing.png`,
      fullPage: true,
    });
    assert.deepEqual(errors, [], "no browser console errors");
    if (name === "Chrome desktop") {
      // Accelerate wall time without changing game logic or adding test hooks to production.
      await page.clock.install();
      for (
        let i = 0;
        i < 90 && !(await page.locator("#reward-dialog").isVisible());
        i++
      )
        await page.clock.runFor(500);
      assert.equal(
        await page.locator("#reward-dialog").isVisible(),
        true,
        "reward UI is reachable",
      );
      assert.equal(await page.locator("[data-card]").count(), 3);
      await page.screenshot({
        path: "test-results/reward.png",
        fullPage: true,
      });
      await page.clock.runFor(6100);
      assert.equal(
        await page.locator("#reward-dialog").isVisible(),
        false,
        "timeout resumes play",
      );
      assert.equal(await page.locator("#wave").innerText(), "02");
      // Test a real touch long-press via PointerEvents on a desktop viewport.
      await page.locator("canvas").evaluate((c) => {
        const r = c.getBoundingClientRect();
        const x = r.left + (2.5 / 9) * r.width,
          y = r.top + (9.5 / 14) * r.height;
        c.setPointerCapture = () => {};
        c.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            pointerId: 11,
            pointerType: "touch",
            button: 0,
            clientX: x,
            clientY: y,
          }),
        );
      });
      await page.clock.runFor(850);
      await page
        .locator("canvas")
        .evaluate((c) =>
          c.dispatchEvent(
            new PointerEvent("pointerup", {
              bubbles: true,
              pointerId: 11,
              pointerType: "touch",
            }),
          ),
        );
      assert.match(
        await page.locator("#bumper-count").innerText(),
        /02/,
        "long press rotates, does not delete",
      );
      await page.locator("canvas").evaluate((c) => {
        const r = c.getBoundingClientRect();
        for (const id of [21, 22]) c.dispatchEvent(new PointerEvent("pointerdown", {
          bubbles: true, pointerId: id, pointerType: "touch", button: 0,
          clientX: r.left + 2.5 / 9 * r.width,
          clientY: r.top + 9.5 / 14 * r.height,
        }));
      });
      await page.clock.runFor(850);
      await page.locator("canvas").evaluate((c) => {
        for (const id of [21, 22]) c.dispatchEvent(new PointerEvent("pointerup", {
          bubbles: true, pointerId: id, pointerType: "touch",
        }));
      });
      assert.match(await page.locator("#bumper-count").innerText(), /01/, "two-finger hold recycles one bumper");
      // Offline navigation must retain the playable app and all local modules.
      await page.evaluate(() => navigator.serviceWorker.ready);
      await context.setOffline(true);
      await page.reload();
      await page.waitForFunction(
        () => document.querySelectorAll("[data-type]").length === 6,
      );
      assert.equal(await page.locator("#start").isVisible(), true);
      assert.equal(
        await page.locator("#sound").getAttribute("aria-pressed"),
        "false",
        "settings survive reload",
      );
      await context.setOffline(false);
    }
    results.push({ browser: name, passed: true, errors });
    await writeFile(
      "test-results/browser-results.json",
      JSON.stringify(results, null, 2),
    );
    console.log(`PASS ${name}`);
  } finally {
    await browser.close();
  }
}

const cases = [
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
];
for (const [type, name, options] of cases)
  if (!process.env.TEST_BROWSER || name.includes(process.env.TEST_BROWSER))
    await checkBrowser(type, name, options);
await writeFile(
  "test-results/browser-results.json",
  JSON.stringify(results, null, 2),
);
