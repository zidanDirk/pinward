import * as THREE from "three";
import { WIDTH, HEIGHT, CELL } from "./physics.js";
import { TYPES } from "./cards.js";
import { MONSTERS } from "./entities.js";
import { BOSS_PHASES } from "./waves.js";
import { createBoardCamera, fitBoardCamera, pickBoard } from "./board-view.js";

const mix = (a, b, t) => (a ?? b) + (b - (a ?? b)) * t;
const COLORS = {
  ink: 0x25264f,
  blue: 0x5260ff,
  pink: 0xff91ca,
  lime: 0xdbff82,
  white: 0xfffdf5,
};

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.mode = "3d";
    this.cursor = null;
    this.selectedCell = null;
    this.tool = "place";
    this.time = 0;
    this.shake = 0;
    this.effects = [];
    this.particles = Array.from({ length: 180 }, () => ({ life: 0 }));
    this.particleIndex = 0;
    this.entities = new Map();
    this.resources = new Set();
    this.geometryCache = new Map();
    this.materialCache = new Map();
    this.textures = new Map();
    this.webgl = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    this.webgl.setPixelRatio(
      Math.min(
        devicePixelRatio || 1,
        matchMedia("(pointer: coarse)").matches ? 1.5 : 2,
      ),
    );
    this.webgl.setClearColor(0x000000, 0);
    this.webgl.outputColorSpace = THREE.SRGBColorSpace;
    this.webgl.toneMapping = THREE.ACESFilmicToneMapping;
    this.webgl.toneMappingExposure = 1.18;
    this.webgl.shadowMap.enabled = false;
    this.webgl.shadowMap.type = THREE.PCFShadowMap;
    this.scene = new THREE.Scene();
    this.camera = createBoardCamera();
    this.world = new THREE.Group();
    this.scene.add(this.world);
    this.scene.add(new THREE.HemisphereLight(0xf8f5ff, 0x5e5490, 2.5));
    const sun = new THREE.DirectionalLight(0xfff2df, 3.5);
    sun.position.set(-350, 1000, 550);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, {
      left: -650,
      right: 650,
      top: 650,
      bottom: -650,
      near: 10,
      far: 2500,
    });
    sun.shadow.normalBias = 1.5;
    sun.shadow.bias = -0.0003;
    this.scene.add(sun);
    const rim = new THREE.DirectionalLight(0xb0c5ff, 1.7);
    rim.position.set(500, 500, -600);
    this.scene.add(rim);
    this.buildTable();
    this.makeCursor();
    this.makeParticlePool();
    this.makeContactShadows();
    this.makePreview();
    this.resize();
    canvas.dataset.renderer = "three-webgl";
  }

  geo(key, factory) {
    if (!this.geometryCache.has(key)) {
      const geometry = factory();
      this.geometryCache.set(key, geometry);
      this.resources.add(geometry);
    }
    return this.geometryCache.get(key);
  }
  mat(color, basic = false) {
    const key = `${color}:${basic}`;
    if (!this.materialCache.has(key)) {
      const material = basic
        ? new THREE.MeshBasicMaterial({ color })
        : new THREE.MeshPhongMaterial({
            color,
            shininess: 55,
            specular: 0x555570,
          });
      this.materialCache.set(key, material);
      this.resources.add(material);
    }
    return this.materialCache.get(key);
  }
  mesh(geometry, material, parent, x = 0, y = 0, z = 0) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    parent.add(mesh);
    return mesh;
  }
  box(parent, w, h, d, color, x = 0, y = 0, z = 0, radius = 0) {
    const geometry = this.geo(`box:${w}:${h}:${d}:${radius}`, () => {
      if (!radius) return new THREE.BoxGeometry(w, h, d);
      const s = new THREE.Shape(),
        a = -w / 2,
        b = -d / 2,
        r = radius;
      s.moveTo(a + r, b);
      s.lineTo(a + w - r, b);
      s.quadraticCurveTo(a + w, b, a + w, b + r);
      s.lineTo(a + w, b + d - r);
      s.quadraticCurveTo(a + w, b + d, a + w - r, b + d);
      s.lineTo(a + r, b + d);
      s.quadraticCurveTo(a, b + d, a, b + d - r);
      s.lineTo(a, b + r);
      s.quadraticCurveTo(a, b, a + r, b);
      const g = new THREE.ExtrudeGeometry(s, {
        depth: h,
        bevelEnabled: false,
        curveSegments: 5,
      });
      g.rotateX(-Math.PI / 2);
      g.translate(0, -h / 2, 0);
      return g;
    });
    return this.mesh(geometry, this.mat(color), parent, x, y, z);
  }
  sphere(parent, radius, color, x = 0, y = 0, z = 0) {
    const m = this.mesh(
      this.geo("sphere", () => new THREE.SphereGeometry(1, 16, 12)),
      this.mat(color),
      parent,
      x,
      y,
      z,
    );
    m.scale.setScalar(radius);
    return m;
  }
  cylinder(parent, radius, height, color, x = 0, y = 0, z = 0) {
    return this.mesh(
      this.geo(
        `cylinder:${radius}:${height}`,
        () => new THREE.CylinderGeometry(radius, radius, height, 20),
      ),
      this.mat(color),
      parent,
      x,
      y,
      z,
    );
  }
  textTexture(text, color = "#fffdf5", width = 512, height = 96) {
    const key = `${text}:${color}:${width}`;
    if (!this.textures.has(key)) {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = color;
      ctx.font = `900 ${height * 0.56}px 'Avenir Next', 'PingFang SC', sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, width / 2, height / 2);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      this.textures.set(key, texture);
      this.resources.add(texture);
    }
    return this.textures.get(key);
  }
  floorLabel(text, width, depth, x, z, color = "#fffdf5") {
    const material = new THREE.MeshBasicMaterial({
      map: this.textTexture(text, color),
      transparent: true,
      depthWrite: false,
    });
    this.resources.add(material);
    const label = this.mesh(
      this.geo(
        `plane:${width}:${depth}`,
        () => new THREE.PlaneGeometry(width, depth),
      ),
      material,
      this.world,
      x,
      1.2,
      z,
    );
    label.rotation.x = -Math.PI / 2;
    label.castShadow = false;
    return label;
  }

  buildTable() {
    const w = this.world;
    // 潮玩球台：抬高的护栏、圆角外壳、支脚与内嵌台面。
    this.box(w, 606, 50, 920, 0x4843bb, 0, -32, 0, 38).castShadow = true;
    this.box(w, 590, 12, 904, 0x7972f2, 0, -8, 0, 33);
    this.box(w, 544, 4, 844, 0x302e74, 0, -2, 0, 21).receiveShadow = true;
    for (const x of [-290, 290]) {
      this.box(w, 17, 32, 847, 0xaaa1ff, x, 13, 0, 8);
      this.box(w, 7, 6, 816, 0xffa1d5, x, 31, 0, 3);
      for (const z of [-385, 385])
        this.cylinder(w, 19, 44, 0x343077, x * 0.85, -75, z);
    }
    this.box(w, 559, 30, 18, 0xaaa1ff, 0, 12, -437, 8);
    this.box(w, 559, 30, 18, 0xaaa1ff, 0, 12, 437, 8);
    this.box(w, 178, 6, 24, COLORS.lime, 0, 30, 437, 9);
    const grid = [];
    for (let x = -270; x <= 270; x += CELL)
      grid.push(x, 0.7, -300, x, 0.7, 300);
    for (let z = -300; z <= 300; z += CELL)
      grid.push(-270, 0.7, z, 270, 0.7, z);
    const gridGeometry = new THREE.BufferGeometry();
    gridGeometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(grid, 3),
    );
    const gridMaterial = new THREE.LineBasicMaterial({
      color: 0x7772c0,
      transparent: true,
      opacity: 0.28,
    });
    this.resources.add(gridGeometry);
    this.resources.add(gridMaterial);
    w.add(new THREE.LineSegments(gridGeometry, gridMaterial));
    for (let i = 0; i < 9; i++)
      this.box(w, 24, 3, 5, 0x9b95e8, -240 + i * 60, 2, -320, 2);
    this.floorLabel("MONSTER DROP ↓", 236, 42, 0, -379, "#c3bbff");
    this.floorLabel("HOLD. THE. LINE.", 227, 39, 0, 338, "#dfff8a");
    for (let i = 0; i < 18; i++) {
      const stripe = this.box(
        w,
        17,
        2,
        10,
        i % 2 ? 0x6660a3 : 0xdfff8a,
        -246 + i * 29,
        1,
        305,
        2,
      );
      stripe.rotation.y = -0.35;
    }
    this.launcher = new THREE.Group();
    this.launcher.position.set(0, 0, 375);
    w.add(this.launcher);
    this.cylinder(this.launcher, 31, 12, 0x21204e, 0, 7, 0);
    this.cylinder(this.launcher, 26, 9, COLORS.lime, 0, 16, 0);
    this.cylinder(this.launcher, 17, 11, 0x5f60d9, 0, 24, 0);
    this.box(this.launcher, 24, 24, 46, COLORS.lime, 0, 26, -19, 7);
    this.sphere(this.launcher, 10, COLORS.white, 0, 26, -40);
    const aimGeometry = new THREE.BufferGeometry();
    aimGeometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(new Float32Array(27), 3),
    );
    const aimMaterial = new THREE.LineDashedMaterial({
      color: COLORS.lime,
      dashSize: 10,
      gapSize: 9,
      transparent: true,
      opacity: 0.75,
    });
    this.aimLine = new THREE.Line(aimGeometry, aimMaterial);
    this.resources.add(aimGeometry);
    this.resources.add(aimMaterial);
    w.add(this.aimLine);
    const shadowCanvas = document.createElement("canvas");
    shadowCanvas.width = 384;
    shadowCanvas.height = 512;
    const shadowContext = shadowCanvas.getContext("2d");
    shadowContext.shadowColor = "#30265e";
    shadowContext.shadowBlur = 28;
    shadowContext.fillStyle = "#30265e";
    shadowContext.fillRect(45, 40, 294, 432);
    const shadowTexture = new THREE.CanvasTexture(shadowCanvas);
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(745, 1060),
      new THREE.MeshBasicMaterial({
        map: shadowTexture,
        transparent: true,
        opacity: 0.13,
        depthWrite: false,
      }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.set(22, -98, 20);
    this.resources.add(shadowTexture);
    this.resources.add(shadow.geometry);
    this.resources.add(shadow.material);
    this.scene.add(shadow);
  }

  makeCursor() {
    const geometry = this.geo("cursor", () => new THREE.BoxGeometry(57, 2, 57));
    this.cursorMaterial = new THREE.MeshBasicMaterial({
      color: COLORS.lime,
      transparent: true,
      opacity: 0.24,
      depthWrite: false,
    });
    this.resources.add(this.cursorMaterial);
    this.cursorMesh = this.mesh(
      geometry,
      this.cursorMaterial,
      this.world,
      0,
      3,
      0,
    );
    this.cursorMesh.castShadow = false;
    const edgeGeometry = new THREE.EdgesGeometry(geometry);
    this.resources.add(edgeGeometry);
    const material = new THREE.LineBasicMaterial({ color: COLORS.lime });
    this.resources.add(material);
    this.cursorMesh.add(new THREE.LineSegments(edgeGeometry, material));
    this.cursorMesh.visible = false;
    this.selection = new THREE.Mesh(
      this.geo("selection", () => new THREE.TorusGeometry(28, 1.8, 6, 36)),
      this.mat(COLORS.white, true),
    );
    this.selection.rotation.x = -Math.PI / 2;
    this.selection.position.y = 3;
    this.selection.visible = false;
    this.world.add(this.selection);
    this.ghost = null;
  }

  makeBumper(b) {
    const group = new THREE.Group(),
      length = TYPES[b.type].length;
    const bodyMaterial = new THREE.MeshPhongMaterial({
      color: TYPES[b.type].color,
      shininess: b.type === "frost" ? 100 : 55,
      specular: 0x555570,
      emissive: TYPES[b.type].color,
      emissiveIntensity: 0,
    });
    const geometry = this.geo(
      `capsule:${length}`,
      () => new THREE.CapsuleGeometry(9, length - 18, 4, 10),
    );
    const body = this.mesh(geometry, bodyMaterial, group, 0, 17, 0);
    body.rotation.z = Math.PI / 2;
    body.castShadow = true;
    for (const x of [-length / 2 + 9, length / 2 - 9]) {
      this.cylinder(group, 10, 12, 0x181c43, x, 6, 0);
      this.cylinder(group, 4, 3, COLORS.white, x, 26, 0);
    }
    if (b.type === "electric") {
      for (const x of [-20, 0, 20]) {
        const band = this.mesh(
          this.geo(
            "electric-band",
            () => new THREE.TorusGeometry(10, 1.5, 6, 12),
          ),
          this.mat(0xfffc9b, true),
          group,
          x,
          17,
          0,
        );
        band.rotation.y = Math.PI / 2;
      }
    } else if (b.type === "frost") {
      for (const x of [-20, 0, 20]) {
        const gem = this.mesh(
          this.geo("crystal", () => new THREE.OctahedronGeometry(7)),
          this.mat(0xd6fbff),
          group,
          x,
          27,
          0,
        );
        gem.scale.set(0.7, 1.3, 0.7);
      }
    } else if (b.type === "heavy") {
      for (const x of [-22, 22])
        this.box(group, 8, 25, 24, 0x443583, x, 14, 0, 3);
    } else if (b.type === "split") {
      this.mesh(
        this.geo("prism", () => new THREE.OctahedronGeometry(15)),
        this.mat(0xffc7ed),
        group,
        0,
        27,
        0,
      );
    }
    group.userData = {
      body,
      material: bodyMaterial,
      owned: [bodyMaterial],
      type: b.type,
    };
    return group;
  }

  makeMonster(m) {
    const group = new THREE.Group(),
      r = m.radius;
    const bodyMaterial = new THREE.MeshPhongMaterial({
      color: MONSTERS[m.type].color,
      shininess: 45,
      specular: 0x555570,
      emissive: 0xffffff,
      emissiveIntensity: 0,
    });
    const body = this.mesh(
      this.geo("monster-body", () => new THREE.SphereGeometry(1, 14, 10)),
      bodyMaterial,
      group,
      0,
      r + 2,
      0,
    );
    body.castShadow = true;
    body.scale.set(r, r * 0.88, r);
    for (const x of [-0.34, 0.34]) {
      const eye = this.sphere(
        group,
        r * 0.3,
        COLORS.white,
        r * x,
        r * 1.7,
        r * 0.62,
      );
      eye.scale.y *= 1.13;
      this.sphere(group, r * 0.13, COLORS.ink, r * x, r * 1.83, r * 0.81);
      const foot = this.sphere(
        group,
        r * 0.33,
        MONSTERS[m.type].color,
        r * x * 1.5,
        5,
        3,
      );
      foot.scale.y *= 0.6;
    }
    const mouth = this.box(
      group,
      r * 0.28,
      3,
      3,
      COLORS.ink,
      0,
      r * 0.85,
      r * 0.95,
      1,
    );
    mouth.rotation.x = 0.25;
    if (m.type === "swift")
      for (const sign of [-1, 1]) {
        const wing = this.mesh(
          this.geo("wing", () => new THREE.ConeGeometry(10, 23, 3)),
          this.mat(0xff9fcd),
          group,
          r * sign,
          r,
          0,
        );
        wing.rotation.z = -sign * 1.0;
      }
    if (m.type === "tank") {
      const helmet = this.mesh(
        this.geo(
          "helmet",
          () =>
            new THREE.SphereGeometry(
              1,
              14,
              8,
              0,
              Math.PI * 2,
              0,
              Math.PI * 0.48,
            ),
        ),
        this.mat(0x5e63b8),
        group,
        0,
        r * 1.18,
        0,
      );
      helmet.scale.set(r * 1.08, r * 0.94, r * 1.08);
      this.box(group, 8, 9, r * 1.8, 0x9aa3ff, 0, r * 2.05, -3, 3);
    }
    if (m.type === "bomb") {
      this.cylinder(group, 5, 13, COLORS.ink, 0, r * 2, 0);
      this.sphere(group, 5, COLORS.lime, 0, r * 2 + 9, 0);
    }
    const ice = this.mesh(
      this.geo(`ice:${r}`, () => new THREE.TorusGeometry(r + 6, 2, 4, 6)),
      this.mat(0x9cfaff, true),
      group,
      0,
      5,
      0,
    );
    ice.rotation.x = Math.PI / 2;
    ice.visible = false;
    const bar = this.box(group, r * 1.6, 3, 4, COLORS.lime, 0, r * 2.55, 0);
    bar.visible = false;
    group.userData = {
      body,
      material: bodyMaterial,
      ice,
      bar,
      owned: [bodyMaterial],
    };
    return group;
  }

  makeBall(ball) {
    const group = new THREE.Group();
    const material = new THREE.MeshPhongMaterial({
      color: COLORS.white,
      emissive: TYPES[ball.power].color,
      emissiveIntensity: 0.65,
      shininess: 100,
    });
    const mesh = this.mesh(
      this.geo("ball", () => new THREE.SphereGeometry(1, 12, 8)),
      material,
      group,
    );
    group.userData = { mesh, material, owned: [material] };
    return group;
  }

  makeBoss() {
    const group = new THREE.Group();
    const material = new THREE.MeshPhongMaterial({
      color: COLORS.pink,
      shininess: 70,
      specular: 0x555570,
      emissive: 0xffffff,
    });
    const head = this.mesh(
      this.geo("boss-head", () => new THREE.SphereGeometry(1, 22, 16)),
      material,
      group,
      0,
      83,
      0,
    );
    head.scale.set(67, 67, 59);
    head.castShadow = true;
    const tentacles = [];
    for (let i = 0; i < 8; i++) {
      const angle = (i * Math.PI) / 4;
      const geometry = this.geo(
        `tentacle:${i}`,
        () =>
          new THREE.TubeGeometry(
            new THREE.CatmullRomCurve3([
              new THREE.Vector3(28, 42, 0),
              new THREE.Vector3(58, 16, 0),
              new THREE.Vector3(87, 10, 9),
              new THREE.Vector3(99, 27, 19),
            ]),
            10,
            10,
            7,
            false,
          ),
      );
      const t = this.mesh(geometry, material, group);
      t.rotation.y = angle;
      tentacles.push(t);
    }
    for (const sign of [-1, 1]) {
      this.sphere(group, 19, COLORS.white, sign * 26, 96, 46);
      this.sphere(group, 9, COLORS.ink, sign * 23, 99, 63);
      this.box(group, 27, 7, 8, 0x813b97, sign * 27, 117, 55, 3).rotation.z =
        sign * -0.2;
    }
    this.sphere(group, 13, 0x993e8d, 0, 69, 55).scale.set(1, 0.55, 0.3);
    const crown = this.mesh(
      this.geo("crown", () => new THREE.ConeGeometry(22, 26, 5, 1, true)),
      this.mat(COLORS.lime),
      group,
      0,
      152,
      0,
    );
    crown.rotation.z = 0.18;
    group.userData = { material, tentacles, owned: [material] };
    return group;
  }

  makePreview() {
    this.preview = new THREE.Group();
    this.world.add(this.preview);
    [
      { type: "normal", x: 90, y: 200 },
      { type: "swift", x: 390, y: 170 },
      { type: "tank", x: 275, y: 295 },
      { type: "bomb", x: 460, y: 370 },
    ].forEach((m, i) => {
      const model = this.makeMonster({ ...m, radius: MONSTERS[m.type].radius });
      model.position.set(m.x - 270, 0, m.y - 420);
      model.userData.index = i;
      this.preview.add(model);
    });
  }
  makeParticlePool() {
    const material = new THREE.MeshBasicMaterial();
    this.resources.add(material);
    this.particleMesh = new THREE.InstancedMesh(
      this.geo("particle", () => new THREE.BoxGeometry(1, 1, 1)),
      material,
      this.particles.length,
    );
    this.particleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.particleMesh.frustumCulled = false;
    this.world.add(this.particleMesh);
    this.dummy = new THREE.Object3D();
    this.tempColor = new THREE.Color();
    const trailMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
    });
    this.resources.add(trailMaterial);
    this.trailMesh = new THREE.InstancedMesh(
      this.geo("ball", () => new THREE.SphereGeometry(1, 12, 8)),
      trailMaterial,
      18 * 6,
    );
    this.trailMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.trailMesh.frustumCulled = false;
    this.world.add(this.trailMesh);
  }
  makeContactShadows() {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const context = canvas.getContext("2d"),
      gradient = context.createRadialGradient(32, 32, 5, 32, 32, 31);
    gradient.addColorStop(0, "#110c4680");
    gradient.addColorStop(0.5, "#110c4640");
    gradient.addColorStop(1, "#110c4600");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 64, 64);
    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
    });
    this.resources.add(texture);
    this.resources.add(material);
    const geometry = this.geo("contact-shadow", () => {
      const g = new THREE.PlaneGeometry(1, 1);
      g.rotateX(-Math.PI / 2);
      return g;
    });
    this.contactShadows = new THREE.InstancedMesh(geometry, material, 70);
    this.contactShadows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.contactShadows.frustumCulled = false;
    this.world.add(this.contactShadows);
  }
  releaseModel(model) {
    for (const trail of model.userData.trails || []) this.world.remove(trail);
    for (const material of model.userData.owned || []) material.dispose();
    this.world.remove(model);
  }
  reset() {
    for (const model of this.entities.values()) this.releaseModel(model);
    this.entities.clear();
    this.particles.forEach((p) => (p.life = 0));
    for (const e of this.effects) this.releaseEffect(e);
    this.effects = [];
    this.shake = 0;
    this.selectedCell = null;
  }
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.webgl.setSize(rect.width, rect.height, false);
    fitBoardCamera(this.camera, rect.width / rect.height, this.mode);
  }
  setView(mode) {
    this.mode = mode;
    this.resize();
  }
  pick(clientX, clientY) {
    return pickBoard(
      this.camera,
      this.canvas.getBoundingClientRect(),
      clientX,
      clientY,
    );
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
      const count = this.reduced ? 2 : e.type === "kill" ? 13 : 7;
      for (let i = 0; i < count; i++) {
        const p = this.particles[this.particleIndex++ % this.particles.length],
          a = (i / count) * Math.PI * 2;
        Object.assign(p, {
          x: e.x - 270,
          y: 18,
          z: e.y - 420,
          vx: Math.cos(a) * (60 + i * 8),
          vy: 70 + i * 5,
          vz: Math.sin(a) * (60 + i * 8),
          life: 0.45,
          max: 0.45,
          color: e.color || "#ff98c4",
          size: e.type === "kill" ? 6 : 4,
        });
      }
    }
    if (e.type === "hit" && this.effects.length < 32) {
      const material = new THREE.SpriteMaterial({
        map: this.textTexture(String(Math.round(e.value)), "#ffffff", 128, 96),
        color: e.color,
        depthTest: false,
      });
      const sprite = new THREE.Sprite(material);
      sprite.position.set(e.x - 270, 70, e.y - 420);
      sprite.scale.set(33, 25, 1);
      this.world.add(sprite);
      this.effects.push({
        kind: "number",
        object: sprite,
        life: 0.7,
        max: 0.7,
      });
    }
    if (e.type === "lightning" && this.effects.length < 32) {
      const points = [
        new THREE.Vector3(e.x - 270, 28, e.y - 420),
        new THREE.Vector3((e.x + e.tx) / 2 - 259, 43, (e.y + e.ty) / 2 - 430),
        new THREE.Vector3((e.x + e.tx) / 2 - 281, 22, (e.y + e.ty) / 2 - 410),
        new THREE.Vector3(e.tx - 270, 28, e.ty - 420),
      ];
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({ color: 0xeaff8d, transparent: true }),
      );
      this.world.add(line);
      this.effects.push({
        kind: "lightning",
        object: line,
        life: 0.18,
        max: 0.18,
      });
    }
    if (e.type === "leak") this.shake = 0.35;
    if (e.type === "bossStage") this.shake = 0.65;
  }
  releaseEffect(effect) {
    this.world.remove(effect.object);
    effect.object.material.dispose();
    if (effect.kind === "lightning") effect.object.geometry.dispose();
  }

  frame(game, dt, alpha = 1) {
    if (this.contextLost) return;
    this.time += dt;
    this.world.position.x =
      !this.reduced && this.shake > 0
        ? Math.sin(this.shake * 90) * this.shake * 3
        : 0;
    this.shake = Math.max(0, this.shake - dt);
    this.preview.visible = game.phase === "build";
    if (this.preview.visible)
      this.preview.children.forEach((m, i) => {
        m.position.y = this.reduced ? 0 : Math.sin(this.time * 2 + i) * 4;
        m.rotation.y = Math.sin(this.time + i) * 0.14;
      });
    const alive = new Set();
    for (const b of game.bumpers) {
      const key = `bumper:${b.id}:${b.type}`;
      alive.add(key);
      if (!this.entities.has(key)) {
        const model = this.makeBumper(b);
        this.world.add(model);
        this.entities.set(key, model);
      }
      const model = this.entities.get(key);
      model.position.set(b.x - 270, 0, b.y - 420);
      model.rotation.y = -b.angle;
      model.scale.set(
        1 + (this.reduced ? 0 : b.flash * 0.7),
        1,
        1 - (this.reduced ? 0 : b.flash),
      );
      model.userData.material.emissiveIntensity = b.flash * 5;
      model.userData.material.color.set(
        b.disabled > 0 ? 0x625b88 : TYPES[b.type].color,
      );
      model.position.y = b.disabled > 0 ? -5 : 0;
    }
    for (const m of game.monsters) {
      const key = `monster:${m.id}`;
      alive.add(key);
      if (!this.entities.has(key)) {
        const model = this.makeMonster(m);
        this.world.add(model);
        this.entities.set(key, model);
      }
      const model = this.entities.get(key);
      model.visible = m.y >= 0;
      model.position.set(
        mix(m.px, m.x, alpha) - 270,
        this.reduced ? 0 : Math.sin(this.time * 8 + m.id) * 2,
        mix(m.py, m.y, alpha) - 420,
      );
      model.rotation.y = this.reduced ? 0 : m.flash * m.rotation;
      model.userData.material.emissiveIntensity = m.flash * 4;
      model.userData.ice.visible = m.frozen > 0;
      model.userData.bar.visible = m.hp < m.maxHp;
      model.userData.bar.scale.x = Math.max(0.01, m.hp / m.maxHp);
    }
    for (const ball of game.balls) {
      const key = `ball:${ball.id}`;
      alive.add(key);
      if (!this.entities.has(key)) {
        const model = this.makeBall(ball);
        this.world.add(model);
        this.entities.set(key, model);
      }
      const model = this.entities.get(key),
        data = model.userData;
      model.position.set(
        mix(ball.px, ball.x, alpha) - 270,
        ball.radius + 5,
        mix(ball.py, ball.y, alpha) - 420,
      );
      data.mesh.scale.setScalar(
        ball.radius * (1 + (this.reduced ? 0 : ball.bounceFlash || 0)),
      );
      data.material.emissive.set(TYPES[ball.power].color);
    }
    if (game.boss) {
      alive.add("boss");
      if (!this.entities.has("boss")) {
        const model = this.makeBoss();
        this.world.add(model);
        this.entities.set("boss", model);
      }
      const model = this.entities.get("boss"),
        b = game.boss;
      model.position.set(
        b.x - 270,
        this.reduced ? 0 : Math.sin(this.time * 2) * 4,
        b.y - 420,
      );
      model.userData.material.color.set(BOSS_PHASES[b.order[b.stage]].color);
      model.userData.material.emissiveIntensity = b.flash * 4;
      model.userData.tentacles.forEach((t, i) => {
        t.rotation.z = this.reduced ? 0 : Math.sin(this.time * 3 + i) * 0.09;
      });
    }
    for (const [key, model] of this.entities)
      if (!alive.has(key)) {
        this.releaseModel(model);
        this.entities.delete(key);
      }
    this.updateAim(game);
    this.updateTrails(game.balls);
    this.updateContactShadows(game);
    this.updateCursor(game);
    this.updateEffects(dt);
    this.updateWarnings(game);
    this.webgl.render(this.scene, this.camera);
    if (this.canvas.dataset.ready !== "true")
      this.canvas.dataset.ready = "true";
  }

  updateAim(game) {
    this.launcher.rotation.y = (-game.aim * Math.PI) / 180;
    const array = this.aimLine.geometry.attributes.position.array;
    const angle = (game.aim * Math.PI) / 180;
    for (let i = 0; i < 9; i++) {
      const distance = i * 24;
      array[i * 3] = Math.sin(angle) * distance;
      array[i * 3 + 1] = 5;
      array[i * 3 + 2] = 370 - Math.cos(angle) * distance;
    }
    this.aimLine.geometry.attributes.position.needsUpdate = true;
    this.aimLine.computeLineDistances();
    this.aimLine.material.opacity = game.manualAim ? 0.95 : 0.4;
  }
  updateTrails(balls) {
    for (let i = 0; i < 18 * 6; i++) {
      const ball = balls[Math.floor(i / 6)],
        index = i % 6,
        point = ball?.trail[index];
      if (point && !this.reduced) {
        this.dummy.position.set(point.x - 270, ball.radius + 4, point.y - 420);
        this.dummy.scale.setScalar(ball.radius * (1 - index / 7) * 0.7);
        this.tempColor.set(TYPES[ball.power].color);
      } else {
        this.dummy.scale.setScalar(0);
        this.tempColor.set(0xffffff);
      }
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.updateMatrix();
      this.trailMesh.setMatrixAt(i, this.dummy.matrix);
      this.trailMesh.setColorAt(i, this.tempColor);
    }
    this.trailMesh.instanceMatrix.needsUpdate = true;
    this.trailMesh.instanceColor.needsUpdate = true;
  }
  updateContactShadows(game) {
    const shadows = [
      ...game.bumpers.map((b) => ({
        x: b.x,
        y: b.y,
        w: b.length + 15,
        h: 27,
        angle: -b.angle,
      })),
      ...game.monsters
        .filter((m) => m.y >= 0)
        .map((m) => ({ x: m.x, y: m.y, w: m.radius * 2.6, h: m.radius * 2.3 })),
      ...game.balls.map((b) => ({
        x: b.x,
        y: b.y,
        w: b.radius * 3,
        h: b.radius * 3,
      })),
    ];
    if (game.phase === "build")
      for (const m of this.preview.children)
        shadows.push({
          x: m.position.x + 270,
          y: m.position.z + 420,
          w: 60,
          h: 55,
        });
    if (game.boss)
      shadows.push({ x: game.boss.x, y: game.boss.y, w: 180, h: 165 });
    for (let i = 0; i < 70; i++) {
      const shadow = shadows[i];
      if (shadow) {
        this.dummy.position.set(shadow.x - 269, 0.4, shadow.y - 418);
        this.dummy.scale.set(shadow.w, 1, shadow.h);
        this.dummy.rotation.set(0, shadow.angle || 0, 0);
      } else this.dummy.scale.setScalar(0);
      this.dummy.updateMatrix();
      this.contactShadows.setMatrixAt(i, this.dummy.matrix);
    }
    this.contactShadows.instanceMatrix.needsUpdate = true;
  }
  updateCursor(game) {
    const cell = this.cursor;
    const editable =
      !game.paused && ["build", "wave", "boss"].includes(game.phase);
    this.cursorMesh.visible =
      !!cell && cell.row >= 2 && cell.row <= 11 && editable;
    if (this.cursorMesh.visible) {
      this.cursorMesh.position.set(cell.col * 60 - 240, 3, cell.row * 60 - 390);
      const occupied = game.bumpers.some(
        (b) => b.col === cell.col && b.row === cell.row,
      );
      const valid =
        this.tool !== "place" ||
        (!occupied &&
          game.inventory[game.selected] > 0 &&
          game.bumpers.length < 18);
      this.cursorMaterial.color.set(
        this.tool === "remove" || !valid ? 0xff90c2 : COLORS.lime,
      );
      const showGhost = this.tool === "place" && valid;
      if (showGhost && this.ghost?.userData.type !== game.selected) {
        if (this.ghost) this.releaseModel(this.ghost);
        this.ghost = this.makeBumper({ type: game.selected });
        this.ghost.traverse((o) => {
          if (o.isMesh) o.castShadow = false;
        });
        this.ghost.userData.material.transparent = true;
        this.ghost.userData.material.opacity = 0.55;
        this.world.add(this.ghost);
      }
      if (this.ghost) {
        this.ghost.visible = showGhost;
        this.ghost.position.set(cell.col * 60 - 240, 5, cell.row * 60 - 390);
        this.ghost.rotation.y =
          game.selected === "wide" ? -Math.PI / 3 : Math.PI / 4;
      }
    } else if (this.ghost) this.ghost.visible = false;
    this.selection.visible =
      !!this.selectedCell &&
      editable &&
      game.bumpers.some(
        (b) =>
          b.col === this.selectedCell.col && b.row === this.selectedCell.row,
      );
    if (this.selection.visible)
      this.selection.position.set(
        this.selectedCell.col * 60 - 240,
        3,
        this.selectedCell.row * 60 - 390,
      );
  }
  updateWarnings(game) {
    this.warningRings ??= [];
    const warnings = game.boss?.warnings || [];
    while (this.warningRings.length < warnings.length) {
      const ring = new THREE.Mesh(
        this.geo("warning", () => new THREE.TorusGeometry(30, 2, 6, 40)),
        this.mat(0xff7eb2, true),
      );
      ring.rotation.x = Math.PI / 2;
      this.world.add(ring);
      this.warningRings.push(ring);
    }
    this.warningRings.forEach((ring, i) => {
      ring.visible = !!warnings[i];
      if (warnings[i]) {
        const w = warnings[i];
        ring.position.set(w.x - 270, 5, w.y - 420);
        ring.scale.setScalar(1 + w.ttl * 0.3);
      }
    });
  }
  updateEffects(dt) {
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (p.life > 0) {
        p.life = Math.max(0, p.life - dt);
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z += p.vz * dt;
        p.vy -= 220 * dt;
        this.dummy.position.set(p.x, Math.max(2, p.y), p.z);
        this.dummy.rotation.set(p.life * 4, p.life * 3, p.life * 5);
        this.dummy.scale.setScalar((p.size * p.life) / p.max);
        this.tempColor.set(p.color);
        this.particleMesh.setColorAt(i, this.tempColor);
      } else this.dummy.scale.setScalar(0);
      this.dummy.updateMatrix();
      this.particleMesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.particleMesh.instanceMatrix.needsUpdate = true;
    if (this.particleMesh.instanceColor)
      this.particleMesh.instanceColor.needsUpdate = true;
    for (const e of this.effects) {
      e.life -= dt;
      e.object.material.opacity = Math.max(0, e.life / e.max);
      if (e.kind === "number") e.object.position.y += dt * 45;
      if (e.life <= 0) this.releaseEffect(e);
    }
    this.effects = this.effects.filter((e) => e.life > 0);
  }
  dispose() {
    this.reset();
    if (this.ghost) this.releaseModel(this.ghost);
    this.preview.children.forEach((m) =>
      m.userData.owned.forEach((r) => r.dispose()),
    );
    this.resources.forEach((resource) => resource.dispose());
    this.webgl.dispose();
  }
}
