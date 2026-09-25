import { Game, COMBO_WINDOW } from "./game.js";
import { Renderer } from "./renderer.js";
import { ArcadeAudio } from "./audio.js";
import { TYPES } from "./cards.js";
import { STEP, clamp } from "./physics.js";
import { BOSS_PHASES } from "./waves.js";
import { readProfile, saveProfile, recordRun, buyUpgrade } from "./storage.js";

const $ = (id) => document.getElementById(id);
let storage;
try {
  storage = window.localStorage;
} catch {
  storage = null;
}
const profile = readProfile(storage);
const audio = new ArcadeAudio(profile.muted);
const renderer = new Renderer($("board"));
let game = new Game({
  slots: profile.slots,
  choiceUnlocked: profile.choiceUnlocked,
});
let tool = "place",
  uiTime = 0,
  toastTime = 0,
  bannerTime = 0,
  lastPhase = "",
  recorded = false;
let previousTime = performance.now(),
  accumulator = 0;
let modalWasRunning = false;
const digits = (value) => Math.floor(value).toLocaleString("en-US");

$("wave-dots").innerHTML = "<i></i>".repeat(12);
$("hp-pips").innerHTML = "<i></i>".repeat(10);
$("inventory").innerHTML = Object.entries(TYPES)
  .map(
    ([type, data]) =>
      `<button class="inventory-item" data-type="${type}" aria-pressed="false" style="--bumper-color:${data.color}"><span class="inventory-icon" aria-hidden="true">${data.symbol}</span><span><span class="inventory-name">${data.name}</span><small>${data.material}</small></span><span class="inventory-count">×0</span></button>`,
  )
  .join("");

function toast(message) {
  $("toast").textContent = message;
  $("toast").classList.add("visible");
  toastTime = 2.6;
}
function persist() {
  if (!saveProfile(profile, storage))
    toast("浏览器存储不可用，本次战绩仅保留到页面关闭。");
}
function vibrate(duration = 10) {
  if (
    typeof navigator.vibrate === "function" &&
    matchMedia("(pointer: coarse)").matches
  )
    navigator.vibrate(duration);
}

function setTool(next) {
  tool = next;
  renderer.tool = next;
  renderer.selectedCell = null;
  document.querySelectorAll("[data-tool]").forEach((b) => {
    b.classList.toggle("active", b.dataset.tool === next);
    b.setAttribute("aria-pressed", String(b.dataset.tool === next));
  });
}

function updateUI(force = false) {
  $("stars").textContent = digits(profile.stars);
  $("best").textContent = digits(profile.best);
  $("wave").textContent =
    game.wave > 12 ? "B" : String(Math.max(1, game.wave)).padStart(2, "0");
  $("score").textContent = String(Math.floor(game.score)).padStart(6, "0");
  $("hp").textContent = `${game.hp} / 10`;
  $("phase-label").textContent = {
    build: "准备布阵",
    wave: "防守中",
    reward: "构筑时间",
    boss: "深潮章鱼",
    over: game.won ? "章节通关" : "防线失守",
  }[game.phase];
  $("board-status").textContent = game.paused
    ? "休息一下"
    : {
        build: "准备开弹",
        wave: "防线营业中",
        reward: "补充新队员",
        boss: "BOSS 来啦",
        over: "本局结束",
      }[game.phase];
  $("timer").textContent =
    `${String(Math.floor(game.elapsed / 60)).padStart(2, "0")}:${String(Math.floor(game.elapsed % 60)).padStart(2, "0")}`;
  [...$("wave-dots").children].forEach((dot, i) => {
    dot.classList.toggle("done", i + 1 < game.wave);
    dot.classList.toggle("current", i + 1 === Math.max(1, game.wave));
  });
  [...$("hp-pips").children].forEach((pip, i) =>
    pip.classList.toggle("empty", i >= game.hp),
  );
  $("hp-pips").classList.toggle("low", game.hp <= 3);
  $("bumper-count").innerHTML =
    `${String(game.bumpers.length).padStart(2, "0")}<span> / 18</span>`;
  document.querySelectorAll("[data-type]").forEach((button) => {
    const type = button.dataset.type,
      count = game.inventory[type];
    button.classList.toggle("selected", type === game.selected);
    button.classList.toggle("available", count > 0);
    button.setAttribute("aria-pressed", String(type === game.selected));
    button.title = `${TYPES[type].name}反弹器，库存 ${count}`;
    const counter = button.querySelector(".inventory-count");
    counter.textContent = `×${count}`;
    counter.classList.toggle("empty", count === 0);
  });
  const info = TYPES[game.selected];
  $("detail-material").textContent = info.material;
  $("detail-text").textContent = info.description;
  $("detail-effect").textContent = info.effect;
  const selected =
    renderer.selectedCell &&
    game.bumpers.find(
      (b) =>
        b.col === renderer.selectedCell.col &&
        b.row === renderer.selectedCell.row,
    );
  $("selection-toolbar").hidden =
    !selected || game.paused || !["build", "wave", "boss"].includes(game.phase);
  if (selected)
    $("selection-name").textContent =
      `${TYPES[selected.type].name}${selected.disabled > 0 ? ` · 恢复 ${Math.ceil(selected.disabled)}s` : "反弹器"}`;
  $("boss-hud").hidden = game.phase !== "boss";
  if (game.boss) {
    $("boss-health").style.transform =
      `scaleX(${Math.max(0, game.boss.hp / game.boss.maxHp)})`;
    $("boss-stage-label").textContent =
      `${game.boss.stage + 1} / 3 · ${BOSS_PHASES[game.boss.order[game.boss.stage]].name}`;
  }
  $("start-overlay").hidden = game.phase !== "build";
  $("start-choice").hidden = !game.choiceUnlocked;
  $("pause-overlay").hidden =
    !game.paused || [...document.querySelectorAll("dialog[open]")].length > 0;
  $("pause").disabled = ["build", "over"].includes(game.phase);
  $("pause").setAttribute("aria-label", game.paused ? "继续游戏" : "暂停游戏");
  $("sound").setAttribute("aria-pressed", String(!profile.muted));
  $("sound").setAttribute(
    "aria-label",
    profile.muted ? "开启声音" : "关闭声音",
  );
  $("sound").textContent = "♪";
  $("sound").classList.toggle("muted", profile.muted);
  $("launch-status").textContent =
    game.phase === "build"
      ? "发射器待命"
      : game.paused
        ? "时间已冻结"
        : game.phase === "reward"
          ? "补充你的防线"
          : game.phase === "over"
            ? "本局结束"
            : `${game.manualAim ? "角度已锁定 · " : "自动发射 · "}${Math.max(0, game.launchIn).toFixed(1)}s`;
  $("field-note").textContent =
    game.wave >= 13
      ? "深潮章鱼每 12 秒冲击基地。把弹球送向上方，尽快结束战斗。"
      : game.wave >= 9
        ? "炸弹怪来了。留意禁用倒计时，回收、补位，让防线继续运转。"
        : game.wave >= 5
          ? "迅捷怪正在加速。冰冻与重型反弹器能为你争取时间。"
          : "先从两块标准反弹器开始。好角度，比数量更重要。";
  if (game.phase === "reward") {
    $("reward-seconds").textContent = Math.max(1, Math.ceil(game.rewardLeft));
    $("reward-progress").style.transform =
      `scaleX(${Math.max(0, game.rewardLeft / 6)})`;
    $("reward-resume").hidden = !game.paused;
  }
  // 连击徽章仅在 10Hz 的 updateUI 中刷新，避免 60Hz 主循环产生每帧分配。
  const comboCount = Math.max(0, game.comboCount | 0);
  const comboTier = Math.max(0, game.comboTier | 0);
  const comboMultiplier = Math.max(1, comboTier);
  $("combo-count").textContent = comboCount;
  $("combo-text").textContent = `连击 · ${comboMultiplier}× 得分`;
  const comboBadge = $("combo-badge");
  const inactive = comboCount <= 0;
  comboBadge.hidden = inactive || !["wave", "boss"].includes(game.phase);
  comboBadge.setAttribute(
    "aria-label",
    inactive
      ? "当前没有连击"
      : `连击 ${comboCount} 次，得分倍率 ${comboMultiplier} 倍`,
  );
  $("combo-progress").style.transform =
    `scaleX(${inactive ? 0 : Math.max(0, game.comboTimer / COMBO_WINDOW)})`;
  if (force || lastPhase !== game.phase) {
    if (game.phase === "reward") showRewards();
    else if ($("reward-dialog").open) $("reward-dialog").close();
    if (game.phase === "over" && !recorded) showResult();
    lastPhase = game.phase;
  }
}

function showRewards() {
  $("reward-wave").textContent =
    `WAVE ${String(game.wave).padStart(2, "0")} / CLEAR`;
  $("reward-title").textContent =
    game.wave === 12 ? "最后一次构筑。深潮将至。" : "让防线，多一种可能。";
  $("reward-cards").innerHTML = game.cards
    .map((type, index) => {
      const card = TYPES[type];
      return `<button class="reward-card" data-card="${index}" style="--bumper-color:${card.color}"><span class="card-symbol" aria-hidden="true">${card.symbol}</span><b>${card.name}反弹器</b><small>${card.title}</small><p>${card.description}</p><span class="card-effect">${card.effect}</span></button>`;
    })
    .join("");
  $("reroll").hidden = game.wave !== 12 || game.rerollUsed;
  if (!$("reward-dialog").open) $("reward-dialog").showModal();
  $("reward-cards").querySelector("button")?.focus();
}

function showResult() {
  recorded = true;
  const earned = recordRun(profile, game);
  persist();
  $("result-tag").textContent = game.won
    ? "CHAPTER 01 / COMPLETE"
    : "THE TIDE WILL RETURN";
  $("result-emblem").textContent = game.won ? "✦" : "↗";
  $("result-title").textContent = game.won
    ? "潮水退去，防线仍在。"
    : "这次，潮水先赢了一步。";
  $("result-description").textContent = game.won
    ? `你击退了深潮章鱼，以 ${game.hp} 点基地血量完成第一章节。`
    : `你的防线拦下了 ${game.kills} 只怪物。带上这次的经验，再试一个新角度。`;
  $("result-score").textContent = digits(game.score);
  $("result-wave").textContent = game.wave > 12 ? "BOSS" : `${game.wave} / 12`;
  $("result-stars").textContent = `+${earned}`;
  const unused = Object.values(game.inventory).reduce((a, b) => a + b, 0);
  $("result-tip").textContent =
    unused > 0
      ? `工坊里还有 ${unused} 块未放置的反弹器。下次选牌后及时放到网格里，让每一份火力都派上用场。`
      : `本局布置了 ${game.bumpers.length} 块反弹器，覆盖 ${Math.round((game.bumpers.length / 90) * 100)}% 的可用网格。试着在底部布置重型 + 冰冻，或让电击反弹器连接上方的弹道。`;
  $("result-dialog").showModal();
  $("restart").focus();
}

function newGame(instant) {
  document.querySelectorAll("dialog[open]").forEach((d) => d.close());
  game = new Game({
    slots: profile.slots,
    choiceUnlocked: profile.choiceUnlocked,
  });
  game.startChoice = $("initial-type").value;
  lastPhase = "";
  recorded = false;
  accumulator = 0;
  renderer.reset();
  bannerTime = 0;
  $("boss-banner").hidden = true;
  $("aim").value = "0";
  $("aim-value").textContent = "0°";
  setTool("place");
  if (instant) {
    audio.unlock();
    game.start();
  }
  updateUI(true);
}

function togglePause() {
  if (
    ["build", "over"].includes(game.phase) ||
    document.querySelector("dialog[open]")
  )
    return;
  game.paused = !game.paused;
  accumulator = 0;
  updateUI();
}

function showUtility(id) {
  if (document.querySelector("dialog[open]")) return;
  modalWasRunning = !game.paused && ["wave", "boss"].includes(game.phase);
  if (modalWasRunning) game.paused = true;
  $(id).showModal();
  updateUI();
}

function applyAction(cell, action = tool) {
  audio.unlock();
  if (!cell || game.paused || !["build", "wave", "boss"].includes(game.phase))
    return;
  const existing = game.bumpers.find(
    (b) => b.col === cell.col && b.row === cell.row,
  );
  if (action === "place" && existing) {
    renderer.selectedCell = cell;
    updateUI();
    return;
  }
  const success =
    action === "rotate"
      ? game.rotate(cell.col, cell.row)
      : action === "remove"
        ? game.remove(cell.col, cell.row)
        : game.place(cell.col, cell.row);
  if (success) {
    vibrate(15);
    renderer.selectedCell = action === "remove" ? null : cell;
  } else if (action === "place") {
    if (cell.row < 2 || cell.row > 11)
      toast("入口与基地需要留空，请放在中间 10 行。");
    else if (game.bumpers.some((b) => b.col === cell.col && b.row === cell.row))
      toast("此处已有反弹器。切换「旋转」调整角度。");
    else if (game.bumpers.length >= 18)
      toast("已达到 18 块上限，回收一块后重新布置。");
    else toast("这类反弹器暂无库存。守过一波，选牌补充。");
  }
  updateUI();
}

const pointers = new Map();
let holdTimer = null,
  multiGesture = false;
const canvas = $("board");
function cellFor(event) {
  return renderer.pick(event.clientX, event.clientY);
}
function cancelHold() {
  clearTimeout(holdTimer);
  holdTimer = null;
}
canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  const cell = cellFor(event);
  if (!cell) {
    renderer.selectedCell = null;
    updateUI();
    return;
  }
  event.preventDefault();
  canvas.focus({ preventScroll: true });
  canvas.setPointerCapture(event.pointerId);
  pointers.set(event.pointerId, {
    cell,
    x: event.clientX,
    y: event.clientY,
    used: false,
  });
  renderer.cursor = cell;
  if (event.pointerType !== "mouse") {
    cancelHold();
    if (pointers.size > 1) {
      multiGesture = true;
      for (const pointer of pointers.values()) pointer.used = true;
      const first = [...pointers.values()][0];
      holdTimer = setTimeout(() => {
        if (pointers.size >= 2) applyAction(first.cell, "remove");
      }, 800);
    } else {
      holdTimer = setTimeout(() => {
        const pointer = pointers.get(event.pointerId);
        if (pointer) {
          pointer.used = true;
          applyAction(pointer.cell, "rotate");
        }
      }, 800);
    }
  }
});
canvas.addEventListener("pointermove", (event) => {
  renderer.cursor = cellFor(event);
  const pointer = pointers.get(event.pointerId);
  if (
    pointer &&
    Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 12
  ) {
    pointer.used = true;
    cancelHold();
  }
});
canvas.addEventListener("pointerup", (event) => {
  cancelHold();
  const pointer = pointers.get(event.pointerId);
  if (pointer && !pointer.used && !multiGesture)
    applyAction(pointer.cell, event.altKey ? "rotate" : tool);
  pointers.delete(event.pointerId);
  if (!pointers.size) multiGesture = false;
});
canvas.addEventListener("pointercancel", (event) => {
  cancelHold();
  pointers.delete(event.pointerId);
  if (!pointers.size) multiGesture = false;
});
canvas.addEventListener("pointerleave", () => {
  if (!pointers.size) renderer.cursor = null;
});
canvas.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  applyAction(cellFor(event), "remove");
});
window.addEventListener("blur", () => {
  cancelHold();
  pointers.clear();
  multiGesture = false;
  if (["wave", "boss", "reward"].includes(game.phase)) {
    game.paused = true;
    updateUI();
  }
});

document.querySelectorAll("[data-tool]").forEach((button) =>
  button.addEventListener("click", () => {
    setTool(button.dataset.tool);
    updateUI();
  }),
);
document.querySelectorAll("[data-view]").forEach((button) =>
  button.addEventListener("click", () => {
    renderer.setView(button.dataset.view);
    document.querySelectorAll("[data-view]").forEach((b) => {
      b.classList.toggle("active", b === button);
      b.setAttribute("aria-pressed", String(b === button));
    });
  }),
);
$("rotate-selected").addEventListener("click", () =>
  applyAction(renderer.selectedCell, "rotate"),
);
$("remove-selected").addEventListener("click", () =>
  applyAction(renderer.selectedCell, "remove"),
);
$("clear-selected").addEventListener("click", () => {
  renderer.selectedCell = null;
  updateUI();
});
canvas.addEventListener("webglcontextlost", (event) => {
  event.preventDefault();
  renderer.contextLost = true;
  game.paused = true;
  $("render-error").hidden = false;
  updateUI();
});
canvas.addEventListener("webglcontextrestored", () => {
  renderer.contextLost = false;
  $("render-error").hidden = true;
  game.paused = !["build", "over"].includes(game.phase);
  renderer.resize();
  updateUI();
});
$("inventory").addEventListener("click", (event) => {
  const button = event.target.closest("[data-type]");
  if (button) {
    game.selected = button.dataset.type;
    setTool("place");
    updateUI();
  }
});
$("start").addEventListener("click", () => {
  game.startChoice = $("initial-type").value;
  audio.unlock();
  game.start();
  updateUI();
  canvas.focus({ preventScroll: true });
});
$("restart").addEventListener("click", () => newGame(true));
$("back-to-build").addEventListener("click", () => newGame(false));
$("pause").addEventListener("click", togglePause);
$("resume").addEventListener("click", togglePause);
$("sound").addEventListener("click", () => {
  audio.unlock();
  profile.muted = !profile.muted;
  audio.muted = profile.muted;
  persist();
  updateUI();
});
$("help").addEventListener("click", () => showUtility("help-dialog"));
$("reward-cards").addEventListener("click", (event) => {
  const button = event.target.closest("[data-card]");
  if (button && game.chooseCard(Number(button.dataset.card))) {
    toast(`${TYPES[game.selected].name}反弹器已入库，点击空格放置。`);
    setTool("place");
    updateUI();
  }
});
$("reroll").addEventListener("click", () => {
  if (game.reroll()) showRewards();
});
$("reward-resume").addEventListener("click", () => {
  game.paused = false;
  updateUI();
});
for (const id of ["reward-dialog", "result-dialog"])
  $(id).addEventListener("cancel", (event) => event.preventDefault());
for (const id of ["help-dialog", "upgrade-dialog", "records-dialog"])
  $(id).addEventListener("close", () => {
    if (modalWasRunning && !document.hidden) game.paused = false;
    modalWasRunning = false;
    updateUI();
  });
document
  .querySelectorAll("[data-close]")
  .forEach((button) =>
    button.addEventListener("click", () => $(button.dataset.close).close()),
  );
$("aim").addEventListener("input", () => {
  game.aim = Number($("aim").value);
  $("aim-value").textContent = `${game.aim > 0 ? "+" : ""}${game.aim}°`;
});
function lockAim() {
  game.manualAim = true;
  toast(`下一球角度已锁定为 ${game.aim}°`);
  updateUI();
}
$("aim-confirm").addEventListener("click", lockAim);
document.addEventListener("keydown", (event) => {
  if (document.querySelector("dialog[open]")) return;
  if (event.code === "KeyP" || event.code === "Escape") {
    event.preventDefault();
    togglePause();
    return;
  }
  if (
    !["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)
  ) {
    const number = /^Digit([1-6])$/.exec(event.code);
    if (number) {
      event.preventDefault();
      document.querySelectorAll("[data-type]")[Number(number[1]) - 1].click();
      canvas.focus({ preventScroll: true });
      return;
    }
    if (event.code === "KeyR" && renderer.selectedCell) {
      event.preventDefault();
      applyAction(renderer.selectedCell, "rotate");
      return;
    }
    if (["Delete", "Backspace"].includes(event.code) && renderer.selectedCell) {
      event.preventDefault();
      applyAction(renderer.selectedCell, "remove");
      return;
    }
  }
  if (
    ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(
      document.activeElement.tagName,
    )
  )
    return;
  if (event.code === "Space") {
    event.preventDefault();
    lockAim();
  }
  if (document.activeElement === canvas) {
    let cell = renderer.cursor || { col: 4, row: 9 };
    if (event.code.startsWith("Arrow")) {
      event.preventDefault();
      cell = {
        col: clamp(
          cell.col +
            (event.code === "ArrowRight"
              ? 1
              : event.code === "ArrowLeft"
                ? -1
                : 0),
          0,
          8,
        ),
        row: clamp(
          cell.row +
            (event.code === "ArrowDown"
              ? 1
              : event.code === "ArrowUp"
                ? -1
                : 0),
          2,
          11,
        ),
      };
      renderer.cursor = cell;
    }
    if (event.code === "Enter") {
      event.preventDefault();
      applyAction(cell);
    }
    if (event.code === "KeyR") {
      event.preventDefault();
      applyAction(cell, "rotate");
    }
    if (["Delete", "Backspace"].includes(event.code)) {
      event.preventDefault();
      applyAction(cell, "remove");
    }
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && ["wave", "boss", "reward"].includes(game.phase)) {
    game.paused = true;
    cancelHold();
    updateUI();
  }
  previousTime = performance.now();
  accumulator = 0;
});

function renderUpgrades() {
  $("upgrade-options").innerHTML =
    `<div class="upgrade-option"><div><b>初始反弹器 +1</b><p>目前 ${profile.slots} 块，上限 4 块。<br>额外反弹器放入新一局库存。</p></div><button data-upgrade="slots" ${profile.slots >= 4 || profile.stars < (profile.slots === 2 ? 12 : 24) ? "disabled" : ""}>${profile.slots >= 4 ? "已满级" : `✦ ${profile.slots === 2 ? 12 : 24} 解锁`}</button></div><div class="upgrade-option"><div><b>初始配置二选一</b><p>双标准，或冰冻 + 标准。<br>在开局前选择你的第一步。</p></div><button data-upgrade="choice" ${profile.choiceUnlocked || profile.stars < 16 ? "disabled" : ""}>${profile.choiceUnlocked ? "已解锁" : "✦ 16 解锁"}</button></div>`;
  $("upgrade-status").textContent = `可用星币：${profile.stars}`;
}
$("upgrades").addEventListener("click", () => {
  renderUpgrades();
  showUtility("upgrade-dialog");
});
$("upgrade-options").addEventListener("click", (event) => {
  const kind = event.target.closest("[data-upgrade]")?.dataset.upgrade;
  if (kind && buyUpgrade(profile, kind)) {
    persist();
    renderUpgrades();
    updateUI();
    $("upgrade-status").textContent = "已解锁，将于下一局生效。";
  }
});
$("records").addEventListener("click", () => {
  const list = $("record-list");
  list.replaceChildren();
  if (!profile.runs.length) {
    const p = document.createElement("p");
    p.className = "modal-description";
    p.textContent = "第一段防守故事，从这一局开始。";
    list.append(p);
  }
  profile.runs.forEach((run, i) => {
    const row = document.createElement("div");
    row.className = "record-row";
    const rank = document.createElement("span");
    rank.textContent = String(i + 1).padStart(2, "0");
    const info = document.createElement("span");
    info.textContent = `${run.won ? "章节通关" : run.wave > 12 ? "BOSS 战" : `第 ${run.wave} 波`} · ${TYPES[run.style]?.name || "标准"}构筑`;
    const sub = document.createElement("small");
    sub.textContent = `剩余血量 ${Number(run.hp) || 0} / 10`;
    info.append(sub);
    const score = document.createElement("strong");
    score.textContent = digits(run.score);
    row.append(rank, info, score);
    list.append(row);
  });
  showUtility("records-dialog");
});
$("mobile-upgrades").addEventListener("click", () => $("upgrades").click());
$("mobile-records").addEventListener("click", () => $("records").click());

function processEvents() {
  for (const event of game.events.splice(0)) {
    renderer.event(event);
    audio.event(event);
    if (event.type === "bounce") vibrate();
    if (event.type === "wave")
      toast(
        event.wave === 1
          ? "第一波来袭。弹球已自动发射。"
          : `第 ${event.wave} 波来袭`,
      );
    if (event.type === "card") {
      setTool("place");
      toast(`${TYPES[event.card].name}反弹器已入库，点击空格放置。`);
    }
    if (event.type === "bossStage") {
      $("boss-banner").replaceChildren();
      const small = document.createElement("small");
      small.textContent = `BOSS / PHASE ${event.stage}`;
      const title = document.createElement("b");
      title.textContent = event.name;
      const hint = document.createElement("span");
      hint.textContent = event.hint;
      $("boss-banner").append(small, title, hint);
      $("boss-banner").hidden = false;
      bannerTime = 3;
    }
    if (event.type === "leak") toast(`基地受到冲击，剩余 ${game.hp} 点血量。`);
    if (event.type === "comboTier") toast(`连击 ×${event.tier}`);
    if (event.type === "comboBreak") toast("连击中断");
    if (event.type === "perfectWave") {
      toast(event.hot ? `狂热无漏！+${event.bonus}` : `无漏击！+${event.bonus}`);
      if (event.hot) vibrate(20);
    }
  }
}

function frame(now) {
  const dt = Math.min((now - previousTime) / 1000, 0.1);
  previousTime = now;
  accumulator += dt;
  while (accumulator >= STEP) {
    game.update(STEP);
    accumulator -= STEP;
  }
  processEvents();
  renderer.frame(game, game.paused ? 0 : dt, accumulator / STEP);
  if (!game.paused)
    audio.update(dt, game.phase === "boss" ? game.boss.stage : null);
  toastTime -= dt;
  if (toastTime <= 0) $("toast").classList.remove("visible");
  if (!game.paused) bannerTime -= dt;
  if (bannerTime <= 0) $("boss-banner").hidden = true;
  uiTime += dt;
  if (uiTime >= 0.1 || lastPhase !== game.phase) {
    updateUI();
    uiTime = 0;
  }
  requestAnimationFrame(frame);
}
new ResizeObserver(() => {
  renderer.resize();
  renderer.frame(game, 0, 1);
}).observe(canvas);
updateUI(true);
renderer.frame(game, 0, 1);
$("start").disabled = false;
requestAnimationFrame(frame);
if ("serviceWorker" in navigator)
  navigator.serviceWorker.register("./sw.js").catch(() => {});
