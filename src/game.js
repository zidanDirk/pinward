import {
  HEIGHT,
  CELL,
  integrate,
  wallBounce,
  segmentContact,
  circleContact,
  bounce,
} from "./physics.js";
import {
  createBumper,
  createBall,
  createMonster,
  MONSTERS,
} from "./entities.js";
import { TYPES, drawCards } from "./cards.js";
import {
  TOTAL_WAVES,
  WAVE_MIN_SECONDS,
  REWARD_SECONDS,
  wavePlan,
  bossOrder,
  BOSS_PHASES,
} from "./waves.js";

export class Game {
  constructor({ rng = Math.random, slots = 2, choiceUnlocked = false } = {}) {
    this.rng = rng;
    this.nextId = 1;
    this.phase = "build";
    this.paused = false;
    this.hp = 10;
    this.wave = 0;
    this.score = 0;
    this.kills = 0;
    this.hits = 0;
    this.time = 0;
    this.elapsed = 0;
    this.waveTime = 0;
    this.launchIn = 0;
    this.aim = 0;
    this.manualAim = false;
    this.balls = [];
    this.monsters = [];
    this.bumpers = [];
    this.events = [];
    this.inventory = Object.fromEntries(
      Object.keys(TYPES).map((type) => [type, 0]),
    );
    this.selected = "standard";
    this.cards = [];
    this.rewardLeft = 0;
    this.rerollUsed = false;
    this.choiceUnlocked = choiceUnlocked;
    this.startChoice = "standard";
    this.boss = null;
    this.slowTime = 0;
    this.won = false;
    this.bumpers.push(
      createBumper(this.nextId++, "standard", 2, 9),
      createBumper(this.nextId++, "standard", 6, 9),
    );
    this.bumpers[1].angle = Math.PI / 4;
    this.inventory.standard = slots - 2;
  }

  emit(type, data = {}) {
    this.events.push({ type, ...data });
    if (this.events.length > 250) this.events.shift();
  }

  start() {
    if (this.phase !== "build") return;
    if (this.choiceUnlocked && this.startChoice === "frost") {
      const first = this.bumpers.find((bumper) => bumper.type === "standard");
      if (first) {
        first.type = "frost";
        first.length = TYPES.frost.length;
      } else if (this.inventory.standard > 0) {
        this.inventory.standard--;
        this.inventory.frost++;
        this.selected = "frost";
      }
    }
    this.beginWave();
  }

  beginWave() {
    if (this.wave >= TOTAL_WAVES) {
      this.beginBoss();
      return;
    }
    this.phase = "wave";
    this.wave++;
    this.waveTime = 0;
    this.launchIn = 0;
    this.plan = wavePlan(this.wave, this.rng);
    this.spawned = 0;
    this.emit("wave", { wave: this.wave });
  }

  beginBoss() {
    this.phase = "boss";
    this.wave = 13;
    this.waveTime = 0;
    this.launchIn = 0;
    this.balls = [];
    this.monsters = [];
    this.boss = {
      x: 270,
      y: 160,
      radius: 66,
      hp: 180,
      maxHp: 180,
      stage: 0,
      order: bossOrder(this.rng),
      attackIn: 5,
      flash: 0,
      warnings: [],
      pulseIn: 12,
    };
    this.changeBossStage(0);
  }

  changeBossStage(stage) {
    this.boss.stage = stage;
    this.boss.attackIn = 4;
    this.boss.warnings = [];
    this.slowTime = 1.2;
    this.emit("bossStage", {
      stage: stage + 1,
      ...BOSS_PHASES[this.boss.order[stage]],
    });
  }

  place(col, row) {
    if (
      !["build", "wave", "boss"].includes(this.phase) ||
      this.paused ||
      row < 2 ||
      row > 11 ||
      col < 0 ||
      col > 8
    )
      return false;
    if (
      this.bumpers.some((b) => b.col === col && b.row === row) ||
      this.inventory[this.selected] <= 0 ||
      this.bumpers.length >= 18
    )
      return false;
    const bumper = createBumper(this.nextId++, this.selected, col, row);
    this.bumpers.push(bumper);
    this.inventory[this.selected]--;
    this.emit("place", {
      x: bumper.x,
      y: bumper.y,
      color: TYPES[bumper.type].color,
    });
    return true;
  }

  rotate(col, row) {
    if (!["build", "wave", "boss"].includes(this.phase) || this.paused)
      return false;
    const b = this.bumpers.find((b) => b.col === col && b.row === row);
    if (!b) return false;
    b.angle = (b.angle + Math.PI / 4) % (Math.PI * 2);
    this.emit("rotate", { x: b.x, y: b.y, color: TYPES[b.type].color });
    return true;
  }

  remove(col, row) {
    if (!["build", "wave", "boss"].includes(this.phase) || this.paused)
      return false;
    const i = this.bumpers.findIndex((b) => b.col === col && b.row === row);
    if (i < 0) return false;
    const [b] = this.bumpers.splice(i, 1);
    this.inventory[b.type]++;
    this.emit("remove", { x: b.x, y: b.y, color: TYPES[b.type].color });
    return true;
  }

  chooseCard(index = 0) {
    if (this.phase !== "reward" || !this.cards[index]) return false;
    const type = this.cards[index];
    this.inventory[type]++;
    this.selected = type;
    this.emit("card", { card: type });
    this.cards = [];
    this.beginWave();
    return true;
  }

  reroll() {
    if (this.phase !== "reward" || this.rerollUsed || this.wave !== 12)
      return false;
    this.cards = drawCards(this.wave, this.rng);
    this.rerollUsed = true;
    this.rewardLeft = REWARD_SECONDS;
    return true;
  }

  launch() {
    const angle =
      ((this.manualAim ? this.aim : this.rng() * 30 - 15) * Math.PI) / 180;
    this.manualAim = false;
    if (this.balls.length < 18)
      this.balls.push(createBall(this.nextId++, angle));
    this.emit("launch");
    this.launchIn += 4;
  }

  damage(monster, amount, power = "standard", chain = false) {
    if (monster.hp <= 0) return;
    monster.hp -= amount;
    const previousY = monster.y;
    monster.y = Math.max(24, monster.y - (power === "heavy" ? CELL * 3 : CELL));
    monster.rotation += Math.PI;
    monster.flash = 0.12;
    if (power === "frost") monster.frozen = 2;
    const multiplier = ["electric", "heavy"].includes(power) ? 1.5 : 1;
    this.score += 15 * multiplier;
    this.hits++;
    this.emit("hit", {
      x: monster.x,
      y: previousY,
      value: amount,
      color: TYPES[power].color,
      power,
      toY: monster.y,
    });
    if (power === "electric" && !chain) {
      const adjacent = this.monsters.filter(
        (m) =>
          m !== monster &&
          m.hp > 0 &&
          Math.hypot(m.x - monster.x, m.y - previousY) < 155,
      );
      for (const m of adjacent) {
        this.emit("lightning", {
          x: monster.x,
          y: previousY,
          tx: m.x,
          ty: m.y,
        });
        this.damage(m, amount * 0.7, power, true);
      }
    }
    if (monster.hp <= 0) {
      this.kills++;
      this.score += MONSTERS[monster.type].score * multiplier;
      this.emit("kill", {
        x: monster.x,
        y: monster.y,
        color: MONSTERS[monster.type].color,
      });
    }
  }

  damageBoss(amount, power) {
    const boss = this.boss;
    if (!boss || boss.hp <= 0) return;
    boss.hp -= amount;
    boss.flash = 0.12;
    this.hits++;
    this.score += 35;
    this.emit("hit", {
      x: boss.x,
      y: boss.y,
      value: amount,
      color: TYPES[power].color,
      power,
    });
    if (boss.hp <= 0) {
      this.score += 3000;
      this.finish(true);
      return;
    }
    const stage = Math.min(2, Math.floor((1 - boss.hp / boss.maxHp) * 3));
    if (stage > boss.stage) this.changeBossStage(stage);
  }

  leak() {
    this.hp = Math.max(0, this.hp - 1);
    this.emit("leak");
    if (this.hp <= 0) this.finish(false);
  }

  finish(won) {
    if (this.phase === "over") return;
    this.phase = "over";
    this.won = won;
    this.emit("over", { won });
  }

  updateBoss(dt) {
    const b = this.boss;
    b.x = 270 + Math.sin(this.waveTime * 0.56) * 160;
    b.y = 150 + Math.sin(this.waveTime * 0.8) * 28;
    b.flash = Math.max(0, b.flash - dt);
    b.attackIn -= dt;
    b.pulseIn -= dt;
    if (b.pulseIn <= 0) {
      b.pulseIn += 12;
      this.leak();
      this.emit("bossPulse");
    }
    if (b.attackIn <= 0) {
      b.attackIn += 6;
      const mechanism = b.order[b.stage];
      if (mechanism === "devour") {
        const targets = [...this.bumpers];
        for (let i = 0; i < 2 && targets.length; i++) {
          const [target] = targets.splice(
            Math.floor(this.rng() * targets.length),
            1,
          );
          b.warnings.push({
            id: target.id,
            x: target.x,
            y: target.y,
            ttl: 1.5,
          });
        }
      } else if (mechanism === "swarm") {
        for (let i = 0; i < 3; i++)
          if (this.monsters.length < 24)
            this.monsters.push(
              createMonster(
                this.nextId++,
                "swift",
                9,
                Math.floor(this.rng() * 9),
              ),
            );
      } else {
        this.emit("gravity");
        if (this.monsters.length < 24)
          this.monsters.push(
            createMonster(this.nextId++, "tank", 9, Math.floor(this.rng() * 9)),
          );
      }
    }
    for (const warning of b.warnings) {
      warning.ttl -= dt;
      if (warning.ttl <= 0) {
        const target = this.bumpers.find((x) => x.id === warning.id);
        if (target) {
          target.disabled = 5;
          this.emit("disable", { x: target.x, y: target.y });
        }
      }
    }
    b.warnings = b.warnings.filter((w) => w.ttl > 0);
  }

  update(dt) {
    if (this.paused || this.phase === "build" || this.phase === "over") return;
    this.elapsed += dt;
    if (this.phase === "reward") {
      this.rewardLeft -= dt;
      if (this.rewardLeft <= 0) this.chooseCard(0);
      return;
    }
    if (this.slowTime > 0) {
      this.slowTime -= dt;
      dt *= 0.35;
    }
    this.time += dt;
    this.waveTime += dt;
    this.launchIn -= dt;
    if (this.launchIn <= 0) this.launch();
    if (this.phase === "wave") {
      while (
        this.spawned < this.plan.length &&
        this.waveTime >= this.plan[this.spawned].at
      ) {
        const item = this.plan[this.spawned++];
        this.monsters.push(
          createMonster(this.nextId++, item.type, this.wave, item.col),
        );
      }
    } else this.updateBoss(dt);
    if (this.phase === "over") return;
    for (const b of this.bumpers) {
      b.disabled = Math.max(0, b.disabled - dt);
      b.flash = Math.max(0, b.flash - dt);
    }
    for (const m of this.monsters) {
      if (m.hp <= 0) continue;
      m.px = m.x;
      m.py = m.y;
      m.y += m.speed * dt * (m.frozen > 0 ? 0.3 : 1);
      m.frozen = Math.max(0, m.frozen - dt);
      m.flash = Math.max(0, m.flash - dt);
      m.bombCooldown -= dt;
      if (m.type === "bomb" && m.bombCooldown <= 0) {
        const b = this.bumpers.find(
          (b) => b.disabled <= 0 && Math.hypot(b.x - m.x, b.y - m.y) < 48,
        );
        if (b) {
          b.disabled = 5;
          m.bombCooldown = 5;
          this.emit("disable", { x: b.x, y: b.y });
        }
      }
      if (m.y + m.radius >= HEIGHT - 35) {
        m.hp = 0;
        this.leak();
      }
    }
    if (this.phase === "over") return;
    const gravity = this.boss?.order[this.boss.stage] === "gravity" ? 180 : 90;
    // Bound travel to 4px per substep: smaller than the thinnest collider.
    for (const ball of [...this.balls]) {
      ball.px = ball.x;
      ball.py = ball.y;
      ball.bounceFlash = Math.max(0, (ball.bounceFlash || 0) - dt);
      ball.ttl -= dt;
      ball.splitCooldown -= dt;
      ball.trail.unshift({ x: ball.x, y: ball.y });
      if (ball.trail.length > 9) ball.trail.pop();
      for (const [id, until] of ball.contacts)
        if (until <= this.time) ball.contacts.delete(id);
      const steps = Math.max(
        1,
        Math.ceil(((Math.hypot(ball.vx, ball.vy) + gravity * dt) * dt) / 4),
      );
      for (let i = 0; i < steps; i++) {
        integrate(ball, dt / steps, gravity);
        const incomingX = ball.vx,
          incomingY = ball.vy;
        wallBounce(ball, true);
        if (ball.vx !== incomingX || ball.vy !== incomingY)
          ball.bounceFlash = 0.1;
        for (const b of this.bumpers) {
          if (b.disabled > 0) continue;
          const contact = segmentContact(ball, b);
          if (!contact) continue;
          bounce(ball, contact);
          ball.bounceFlash = 0.1;
          if (!ball.contacts.has(b.id)) {
            ball.contacts.set(b.id, this.time + 0.12);
            ball.power = b.type;
            b.flash = 0.1;
            this.emit("bounce", {
              x: ball.x,
              y: ball.y,
              power: b.type,
              color: TYPES[b.type].color,
            });
            if (
              b.type === "split" &&
              !ball.small &&
              ball.splitCooldown <= 0 &&
              this.balls.length < 18
            ) {
              ball.splitCooldown = 2;
              const small = createBall(this.nextId++, 0, ball.x, ball.y, true);
              const angle = Math.atan2(ball.vy, ball.vx) + 0.48;
              const speed = Math.hypot(ball.vx, ball.vy);
              small.vx = Math.cos(angle) * speed;
              small.vy = Math.sin(angle) * speed;
              small.power = "split";
              small.contacts.set(b.id, this.time + 0.2);
              this.balls.push(small);
            }
          }
        }
        for (const m of this.monsters) {
          if (m.hp <= 0 || m.y < 0 || ball.contacts.has(m.id)) continue;
          const contact = circleContact(ball, m);
          if (contact) {
            bounce(ball, contact);
            ball.bounceFlash = 0.1;
            ball.contacts.set(m.id, this.time + 0.18);
            this.damage(
              m,
              (ball.small ? 1.8 : 3.2) + this.wave * 0.08,
              ball.power,
            );
          }
        }
        if (this.boss && !ball.contacts.has("boss")) {
          const contact = circleContact(ball, this.boss);
          if (contact) {
            bounce(ball, contact);
            ball.contacts.set("boss", this.time + 0.3);
            this.damageBoss(ball.small ? 5 : 10, ball.power);
            if (this.phase === "over") return;
          }
        }
      }
    }
    this.balls = this.balls.filter(
      (b) =>
        b.ttl > 0 &&
        b.y < HEIGHT + 20 &&
        Number.isFinite(b.x) &&
        Number.isFinite(b.y),
    );
    this.monsters = this.monsters.filter((m) => m.hp > 0);
    if (
      this.phase === "wave" &&
      this.spawned === this.plan.length &&
      !this.monsters.length &&
      this.waveTime >= WAVE_MIN_SECONDS
    ) {
      this.phase = "reward";
      this.cards = drawCards(this.wave, this.rng);
      this.rewardLeft = REWARD_SECONDS;
      this.balls = [];
      this.emit("reward");
    }
  }
}
