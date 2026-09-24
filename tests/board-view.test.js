import test from "node:test";
import assert from "node:assert/strict";
import {
  createBoardCamera,
  fitBoardCamera,
  projectBoard,
  pickBoard,
} from "../src/board-view.js";

for (const mode of ["3d", "top"])
  for (const [width, height] of [
    [660, 800],
    [566, 660],
    [359, 473],
    [288, 380],
  ]) {
    test(`${mode} ray picking round-trips all 126 cells at ${width}×${height}`, () => {
      const camera = createBoardCamera();
      fitBoardCamera(camera, width / height, mode);
      const rect = { left: 143, top: 82, width, height };
      for (let row = 0; row < 14; row++)
        for (let col = 0; col < 9; col++) {
          const p = projectBoard(camera, rect, col * 60 + 30, row * 60 + 30);
          assert.ok(
            p.x >= rect.left && p.x <= rect.left + width,
            "board fits horizontally",
          );
          assert.ok(
            p.y >= rect.top && p.y <= rect.top + height,
            "board fits vertically",
          );
          assert.deepEqual(pickBoard(camera, rect, p.x, p.y), { col, row });
        }
    });
    test(`${mode} clicking raised bumper tops still selects the correct cell at ${width}×${height}`, () => {
      const camera = createBoardCamera();
      fitBoardCamera(camera, width / height, mode);
      const rect = { left: 15, top: 110, width, height };
      for (const [col, row] of [
        [0, 2],
        [8, 2],
        [0, 11],
        [8, 11],
        [4, 7],
        [2, 9],
      ]) {
        const p = projectBoard(camera, rect, col * 60 + 30, row * 60 + 30, 26);
        assert.deepEqual(pickBoard(camera, rect, p.x, p.y), { col, row });
      }
    });
  }
test("outside-board rays and zero-sized viewports never place edge bumpers", () => {
  const camera = createBoardCamera();
  fitBoardCamera(camera, 0.8);
  assert.equal(
    pickBoard(camera, { left: 0, top: 0, width: 0, height: 100 }, 10, 10),
    null,
  );
  const rect = { left: 0, top: 0, width: 600, height: 750 };
  for (const [x, y] of [
    [-100, 200],
    [640, 300],
    [270, -100],
    [270, 940],
  ]) {
    const p = projectBoard(camera, rect, x, y);
    assert.equal(pickBoard(camera, rect, p.x, p.y), null);
  }
});
test("switching cameras and resizing keeps picking accurate", () => {
  const camera = createBoardCamera();
  for (const mode of ["3d", "top", "3d"]) {
    const rect = {
      left: 19,
      top: 44,
      width: mode === "top" ? 360 : 600,
      height: 500,
    };
    fitBoardCamera(camera, rect.width / rect.height, mode);
    const p = projectBoard(camera, rect, 270, 450);
    assert.deepEqual(pickBoard(camera, rect, p.x, p.y), { col: 4, row: 7 });
  }
});
