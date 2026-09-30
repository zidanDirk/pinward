# 2026-09-30 Issue #79 Repair Agent 耗尽与 BLOCKED Recovery

## 摘要

2026-09-30，PINWARD 自动化流水线处理子任务 #79：

> BOSS 脉冲倒计时条与机制预警音

Implementation Agent 已正常完成代码修改，但新增测试中有两个测试 fixture 与游戏已有时间语义不一致。

自动测试失败后，Repair Agent 连续执行两次仍未正确修复，并最终达到 Claude Code 的 `max-turns=35` 上限。

流水线随后正确进入：

    BLOCKED

并且：

- 没有 commit
- 没有 push
- 没有创建 Pull Request
- 保留了原始 worktree
- 保留了失败日志和 Repair 日志

人工仅修正错误测试后：

    tests 152
    pass 152
    fail 0

随后复用原有 dirty worktree 完成恢复：

    BLOCKED
        ↓
    PREPARED
        ↓
    IMPLEMENTED
        ↓
    VERIFYING
        ↓
    VERIFIED
        ↓
    COMMITTING
        ↓
    COMMITTED
        ↓
    PUSHING
        ↓
    PUSHED
        ↓
    PR_OPEN

最终创建：

- Child Issue：#79
- Parent Proposal：#72
- Pull Request：#80
- Commit：`f187c15753653f2971a4e0e3935fced55b51a353`

本次事故验证了质量门、dirty worktree 保留和 publish checkpoint 的有效性，同时暴露了 Repair Agent 上下文质量和 BLOCKED 恢复流程的自动化缺口。

---

## 关联对象

- Parent Proposal：#72
- Child Task：#79
- Pull Request：#80
- Implementation branch：`ai/79-task`
- Implementation base：`4d94575a68df0d84d1a3dc04cc88a95174e28df9`
- Implementation commit：`f187c15753653f2971a4e0e3935fced55b51a353`

---

## 原始任务

#79 要求为 BOSS 增加：

- 12 秒脉冲倒计时 HUD
- `<3s` warning 状态
- `<1.5s` 下穿沿预警事件
- 180Hz → 120Hz 提示音
- reduced-motion 降级
- progressbar 无障碍语义

明确要求：

- 不修改 BOSS 12 秒周期
- 不修改游戏数值
- 不修改 `game.js`
- UI 时间必须与 `game.boss.pulseIn` 同步
- 暂停与慢动作期间使用游戏时间而非挂钟时间

Implementation 修改范围符合 Allowed Files：

    index.html
    style.css
    src/main.js
    src/audio.js
    tests/game.test.js

---

## 第一次测试失败

实现完成后，质量门执行：

    npm ci
    npm run check
    npm test

新增的四个 BOSS pulse 测试中，两项失败。

### 失败 1：暂停恢复测试

测试原本执行：

    game.beginBoss()

    const before = game.boss.pulseIn

    game.paused = true
    game.update(STEP)

    game.paused = false
    game.update(STEP)

    expected:
    before - STEP

实际结果：

    expected:
    11.983333333333333

    actual:
    11.994166666666667

差异并非 `pulseIn` 实现错误。

---

## 根因 1：测试忽略 BOSS 开场 slowTime

现有游戏逻辑中：

    beginBoss()
        ↓
    changeBossStage(0)
        ↓
    slowTime = 1.2

主循环随后执行：

    if (slowTime > 0) {
      slowTime -= dt
      dt *= 0.35
    }

    updateBoss(dt)

因此刚进入 BOSS 后：

    STEP = 1 / 60

实际传给 `updateBoss()` 的时间是：

    STEP × 0.35

所以：

    12 - STEP × 0.35
    =
    11.994166666666667

与失败日志完全一致。

生产行为正确。

错误来自测试 fixture 没有隔离 BOSS 入场慢动作。

最终修复：

    game.beginBoss()
    game.slowTime = 0

然后再单独验证 pause / resume 语义。

---

## 失败 2：两个完整 pulse 周期只产生一次事件

测试原本使用：

    for (...) {
      game.update(STEP)
    }

并假设：

    24 秒挂钟时间
    =
    两个 12 秒 bossPulse 周期

实际结果：

    expected: 2
    actual: 1

---

## 根因 2：测试错误使用完整 game.update()

`game.update()` 不只是更新 `boss.pulseIn`。

它还会处理：

- slowTime
- 自动发球
- 弹球物理
- BOSS 受伤
- 怪物
- phase 转换
- 游戏结束

因此该测试实际上同时测试了大量与 pulse timer 无关的系统。

在第二个 pulse 之前，完整游戏状态可能已经改变，甚至 BOSS 已结束。

此外，开场 slowTime 也会使最初一段墙钟时间以 0.35 倍游戏速度推进。

所以：

    24 秒 wall-clock

并不等价于：

    24 秒 boss timer

正确测试方式是直接调用：

    game.updateBoss(STEP)

这样测试只覆盖 pulse timer 本身。

最终测试：

    for (...) {
      game.updateBoss(STEP)
    }

结果：

    bossPulse === 2

---

## 为什么不能修改 game.js 来让测试通过

Issue #79 明确要求 HUD 与：

    game.boss.pulseIn

保持同步，并且：

    暂停
    slowTime
    phase transition

都必须使用真实游戏时间。

如果为了让测试得到：

    before - STEP

而让 `pulseIn` 绕开 slowTime，就会改变正确的生产语义。

因此正确原则是：

> 测试与已有正确生产语义冲突时，修测试 fixture，而不是修改生产逻辑迎合测试。

---

## Repair Agent 为什么没有修好

当时 Repair 流程主要把：

    String(testError).slice(0, 60000)

直接提供给 Coding Agent。

模型需要自行从大段测试输出中重新寻找：

- 失败测试
- test file
- production implementation
- slowTime 来源
- phase 语义
- fixture 条件

同时 Repair 使用固定：

    --max-turns 35

两次 Repair 都没有正确识别：

    beginBoss()
        ↓
    changeBossStage()
        ↓
    slowTime = 1.2

以及：

    game.update()

并不是 pulse timer 的纯测试入口。

最终日志包含：

    Error: Reached max turns (35)

日志中还出现：

    [claude-code:unrecognized_model]

但和此前事故相同，该 warning 本身不是这次失败的直接根因。

真正导致 Repair 非 0 退出的是：

    Reached max turns (35)

---

## 为什么安全机制是正确的

Repair 最终失败后，流水线没有：

    git add
    git commit
    git push
    createPullRequest

而是：

    phase = BLOCKED

GitHub Issue 进入：

    agent:task
    agent:blocked

并移除：

    同意实现

这避免了：

> 测试仍然失败的实现被自动发布为 PR。

更重要的是，自动化没有删除：

    /opt/pinward-agent/worktrees/issue-79

所以人工修复后仍然可以复用原现场。

---

## 人工恢复

人工没有重新运行 Implementation Agent。

只修改了错误的两个测试。

最终：

    tests 152
    pass 152
    fail 0

然后恢复 Issue approval，并执行现有 publish checkpoint。

自动化检测到：

    Existing worktree changes detected

因此没有重新运行 MiniMax，而是：

    reuse dirty worktree
        ↓
    inspect Allowed Files
        ↓
    npm ci
        ↓
    npm run check
        ↓
    npm test
        ↓
    commit
        ↓
    push
        ↓
    PR

最终创建 PR #80。

---

## P1-5 Repair Hardening

事故后部署了新的 Repair Diagnostics。

新增：

    app/repair-diagnostics.mjs

Repair 在调用模型前先确定性提取：

- failing test name
- test file / line
- expected
- actual
- assertion operator
- error code
- failure category hint
- failure signature
- Allowed File 内失败测试附近源码

不再把 60KB 原始 TAP 作为主要 Repair 上下文。

Repair prompt 明确要求先分类：

    implementation_bug
    new_test_bug
    fixture_or_parameter_bug
    wrong_expected_value
    documentation_test_count
    unknown

并再次强化：

> 必须先核对生产语义。

---

## Failure Signature

每次测试失败都会生成稳定的：

    failureSignature

并保存结构化 artifact：

    state/implement/
      issue-N-test-failure-M.txt
      issue-N-test-failure-M.json
      issue-N-repair-M-meta.json

JSON 中记录：

- signature
- categoryHint
- failing tests
- locations
- expected / actual
- operator
- Repair 前后文件 fingerprint
- Agent exit error

这样后续故障无需重新从数千行日志人工定位。

---

## Repair Stagnation Guard

新增熔断规则：

    Failure signature 相同
        +
    上一轮 Repair 没有产生文件变化
        ↓
    STOP

即：

    Repair stagnation detected

不会继续浪费模型 turns。

安全原则仍然保持：

> Repair Agent 非 0 退出不代表修改一定无效。

即使 Claude 因 max-turns 退出，只要已经修改文件，外层仍会继续执行：

    Allowed Files 检查
        ↓
    npm check
        ↓
    npm test

最终事实来源始终是文件系统和测试，而不是模型退出码。

---

## Repair Budget 配置化

原本：

    --max-turns 35

已经改为：

    PINWARD_REPAIR_MAX_TURNS

默认：

    50

允许范围：

    10 ～ 80

Repair 次数也可通过：

    PINWARD_MAX_REPAIR_ATTEMPTS

控制。

默认：

    2

最大：

    3

这两个参数有明确硬上限，不允许无限 Repair。

---

## BLOCKED Recovery Hardening

事故前恢复 #79 需要人工执行：

    修改测试
        ↓
    npm test
        ↓
    手工改 GitHub Label
        ↓
    implement-task --publish

其中存在一个风险窗口：

    agent:blocked 被移除
        ↓
    定时 implement worker 正好启动
        ↓
    与人工 publish 发生竞争

事故后新增：

    app/recover-blocked.mjs

统一处理 BLOCKED Recovery。

推荐入口：

    node app/recover-blocked.mjs \
      --issue=<N>

先做 Dry Run。

真正发布：

    node app/recover-blocked.mjs \
      --issue=<N> \
      --publish

---

## BLOCKED Recovery 安全条件

Recovery 必须同时满足：

- task-state 存在
- phase === BLOCKED
- worktree 存在
- branch 与 state 一致
- Issue 有 `agent:task`
- Issue 有 `agent:blocked`
- Issue 没有 `agent:pr-open`
- Issue 没有人工 `挂起`
- changed files 全部属于 Allowed Files
- worktree 有待恢复修改

然后完整重新运行：

    npm ci
    npm run check
    npm test

只有三项全部 PASS 后才允许：

    添加 / 恢复 同意实现
        ↓
    移除 agent:blocked
        ↓
    implement-task --publish

测试没通过：

    BLOCKED 保持不变
    GitHub labels 不变
    不 commit
    不 push
    不创建 PR

---

## Recovery 并发保护

`recover-blocked --publish` 会自动获取：

    /opt/pinward-agent/state/pipeline.lock

与：

- Research
- Split
- Implementation
- Maintenance

使用同一流水线锁。

因此 Recovery 的：

    verify
    → label transition
    → publish

属于同一个受保护区间。

不会在：

    agent:blocked

解除后被定时 Implementation Worker 抢占。

---

## 人工产品决策仍然不可自动覆盖

Recovery 明确拒绝带有：

    挂起

的 Issue。

原因是：

    agent:blocked

可能表示技术失败；

但：

    挂起

可能表示人工产品决策。

自动化不能把人工产品暂停理解成“测试修好了，可以继续”。

---

## 本次事故形成的长期原则

### 1. 测试失败先确认测试是否理解了生产时间语义

尤其关注：

- pause
- slowTime
- phase
- lifecycle
- fixed timestep
- wall-clock vs game-clock

### 2. 单元测试应调用最窄的测试入口

测试：

    boss pulse timer

优先：

    updateBoss()

而不是：

    game.update()

后者会同时引入整个游戏状态机。

### 3. Repair 输入必须结构化

不要：

    60KB log
    → LLM
    → 希望模型自己找重点

应该：

    raw failure
        ↓
    deterministic extraction
        ↓
    failure signature
        ↓
    failing test + source slice
        ↓
    Repair Agent

### 4. 模型退出码不是代码正确性的事实来源

事实来源仍然是：

    filesystem
    Allowed Files
    npm check
    npm test

### 5. BLOCKED 必须保留现场

禁止：

    reset --hard
    删除 dirty worktree
    从头重新实现

优先：

    inspect
    repair
    verify
    recover

### 6. BLOCKED → PUBLISH 必须经过重新验证

不能因为人工声称：

    “我已经修好了”

就直接解除 blocked。

必须：

    npm ci
    npm run check
    npm test

全部真实通过。

### 7. 自动化不能覆盖人工产品决策

    agent:blocked
    ≠
    挂起

技术恢复流程只处理技术 Block。

---

## 结论

Issue #79 并不是 Implementation Agent 完全失败。

真正的问题是：

    实现完成
        ↓
    新测试错误理解已有时间语义
        ↓
    Repair 上下文不足
        ↓
    Repair 达到 max-turns
        ↓
    BLOCKED

现有 fail-safe 成功阻止了坏 PR。

事故后的目标已经从：

> Repair 多尝试几次

调整为：

> 更早获得结构化失败信息，更少做无效 Repair，并为 BLOCKED 提供一个受控、可验证、可恢复的发布入口。

最终稳定流程：

    Implementation
        ↓
    deterministic verification
        ↓ FAIL
    structured failure diagnostics
        ↓
    bounded Repair
        ↓
    stagnation guard
        ↓
    PASS ──────────────→ publish
        │
        FAIL
        ↓
    BLOCKED
        ↓
    preserve worktree
        ↓
    human correction
        ↓
    recover-blocked
        ↓
    full verification
        ↓ PASS
    atomic label recovery
        ↓
    publish checkpoint
        ↓
    PR

自动化仍然不会自动 Merge Pull Request。
