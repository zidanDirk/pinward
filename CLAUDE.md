# PINWARD 项目约定

本文件是**所有 AI 编码代理的必读契约**。每次自动化任务都会加载它。

## 项目定位

弹珠 + Roguelike + 塔防的网页游戏。原生 ES Modules + Three.js + Web Audio。
Three.js 以仓库内 vendor 资源交付，运行时不依赖 CDN；npm 依赖由 `package-lock.json` 锁定，自动化环境使用 `npm ci` 安装。

## 硬性规则

1. **不得未经 Issue 明确授权新增、删除或升级 npm 依赖**。当前 `package.json` / `package-lock.json` 中已经锁定的依赖可以正常使用；自动化、CI 与 Git worktree 必须使用 `npm ci` 安装锁定依赖。不得擅自引入新的框架、构建体系、转译器或 CSS 预处理器。
2. **不修改以下受保护路径**（自动化脚本会直接拒绝这类改动）：
   `.github/**`、`ops/**`、`CLAUDE.md`、`package.json` 的 `scripts` 字段。
3. **所有游戏素材必须由代码生成**（Three.js 几何体、Canvas / SVG、Web Audio 合成），不得引用任何外部图片、字体、音频或 CDN。
4. **不做与任务无关的改动**。一次改动尽量聚焦在一个模块内；不做大范围重命名、重排、格式化。
5. **注释与面向玩家的文案用中文**，代码标识符用英文。
6. **必须尊重无障碍与减少动效**：响应 `prefers-reduced-motion`，按钮有可读的 aria 标签，主要流程可纯键盘完成。
7. **移动端（390×844）与桌面端都要可用**，任何改动都不得造成横向溢出。
8. **性能红线不退化**：以 `docs/validation.md` 中最近一次实际测试记录为当前 Lighthouse / FPS 基线，不得引入明显长任务或每帧不必要的新对象分配。

## 完成前必须自检

```sh
npm run check   # 语法检查（node --check 各模块）
npm test        # 全部逻辑 / 物理 / 3D 视图 / 通关模拟测试，必须全绿
```

测试不过就不算完成。若你新增了物理或规则逻辑，必须同时补充 `tests/` 下的测试。

## 目录职责

| 文件 | 职责 |
| --- | --- |
| `src/physics.js` | 常量、碰撞、反射、积分（纯函数；改动必须同步 `tests/physics.test.js`） |
| `src/entities.js` | 反弹器、球、怪物的工厂与数据结构 |
| `src/game.js` | 游戏状态机、波次推进、卡牌选择、BOSS 机制、胜负判定 |
| `src/waves.js` | 波次与 BOSS 阶段配置 |
| `src/cards.js` | 卡牌类型与抽卡逻辑 |
| `src/renderer.js` | Three.js 场景渲染、3D 对象与视觉特效 |
| `src/board-view.js` | 3D / 俯视相机适配、球台坐标投影与射线拾取 |
| `src/audio.js` | Web Audio 合成音效 |
| `src/storage.js` | localStorage 读写与容错 |
| `src/main.js` | DOM 绑定、输入处理、UI 状态与主循环 |
| `index.html` / `style.css` | 结构与样式 |
| `tests/*.test.js` | `node --test` 自动化测试 |
| `tests/browser.mjs` / `tests/scenes.mjs` | 可选 Playwright 浏览器验证（非依赖，服务器上不运行） |
| `docs/validation.md` | 验证记录，改动质量相关结论时同步更新 |

## 提交与 PR 规范

- 提交信息：`type(scope): 中文简述 (#issue号)`，`type` ∈ `feat` / `fix` / `perf` / `refactor` / `test` / `docs` / `chore`。
- 一个 PR 只做一件事。PR 描述必须包含三部分：**改了什么**、**为什么**、**怎么验证**（附 `npm run check && npm test` 的实际输出）。
- **不要推送默认分支 `master`，不要合并任何 PR**。分支由自动化脚本推送，合并永远由人类完成。
