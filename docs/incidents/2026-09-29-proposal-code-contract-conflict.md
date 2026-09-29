# 2026-09-29 Proposal 与现有代码契约冲突导致 Split Blocked

## 摘要

Issue #67 在人工标记为「同意实现」后，没有创建子任务，而是被 Split 技术审核调整为：

    agent:proposal
    agent:blocked
    挂起

这不是 Split Worker 故障，而是 Proposal 中部分技术描述与当前 master 的真实代码行为不一致，导致自动化无法得到唯一、安全的实现方案。

人工统一规则后，#67 重新通过 Split，创建：

    #73
    #74

对应实现最终通过：

    PR #75
    PR #76

合并到 master。

Maintenance 随后完成收尾：

    #73 → agent:done + closed
    #74 → agent:done + closed
    #67 → agent:done + closed

---

## 关联对象

- Parent Proposal：#67
- Task 1：#73
- Task 2：#74
- Task 1 PR：#75
- Task 2 PR：#76

---

## 原始目标

#67 希望把现有命中飘字从：

    e.value
    伤害数字

调整为：

    e.score
    本次实际得分贡献

并根据 comboTier 对飘字的颜色和尺寸进行分级。

整体方向与项目现有设计兼容，但 Proposal 对部分既有代码行为的描述并不准确。

---

## 根因 1：BOSS 致命一击的 hit 事件描述错误

Proposal 原本声称：

    BOSS 击杀由 finish(true) 走结算
    不发 hit 事件
    保持原样

但 master 中真实的 `damageBoss()` 顺序是：

    boss.hp -= amount
        ↓
    emit("hit")
        ↓
    if (boss.hp <= 0)
        ↓
    score += 3000
        ↓
    finish(true)

因此：

**BOSS 致命一击本来就会发出 hit 事件。**

如果为了满足 Proposal 中“不发 hit”的验收标准而取消这个事件，会顺带改变已有：

- hit 粒子
- hit 音效
- hit 事件消费者行为

这与 Proposal 同时要求：

    保持原样
    不修改 BOSS 既有逻辑

直接冲突。

Split Agent 无法安全决定应该保留哪一种语义，因此正确地停止拆分。

---

## 根因 2：Proposal 引用了不存在的颜色

Proposal 希望四档分别使用：

    ×1 奶油白
    ×2 青柠黄
    ×3 粉紫
    ×4 潮玩粉

同时又要求：

    仅使用现有 COLORS
    不新增色值

但 master 中 `COLORS` 实际只有：

    ink
    blue
    pink
    lime
    white

不存在：

    粉紫

如果 ×3 和 ×4 都使用 pink，则无法满足“四档颜色”。

如果新建一个紫色，又违反“不新增色值”。

因此这一要求同样没有唯一实现。

---

## 根因 3：reduced-motion 伪代码混淆了 Event 与 Effect

Proposal 中曾建议：

    if (this.reduced && e.kind === "number")

但 `renderer.event(e)` 中的：

    e

是 Game 发出的事件，例如：

    hit
    kill
    leak
    lightning

其中并不存在：

    kind

`kind: "number"` 是 Renderer 在创建内部 effect 后才写入的字段：

    {
      kind: "number",
      object: sprite,
      life: 0.7,
      max: 0.7
    }

因此 Proposal 混淆了：

    Game Event

与：

    Renderer Effect

两个不同数据层。

---

## 为什么 Split Block 是正确行为

此时存在多个互斥解释：

### 方案 A

按照 Proposal 的文字：

    BOSS 致命一击不发 hit

结果会改变既有粒子和音效。

### 方案 B

按照 master 当前行为：

    BOSS 致命一击继续发 hit

但若直接把 renderer 改成：

    Math.round(e.score)

而致命 hit 没有有效 score，则可能产生：

    NaN

### 方案 C

新增新的 BOSS 特殊事件

这又超出了 Proposal 原本范围。

Split Agent 不应该自行替产品需求选择其中之一。

因此：

    agent:blocked
    挂起

是正确的安全结果，而不是自动化失败。

---

## 人工统一后的 BOSS 规则

最终决定保留 master 的既有事件语义。

### 普通怪命中

Game 发出：

    hit {
      score,
      comboTier
    }

其中：

    score = 15 * multiplier * comboMul

`comboTier` 使用本次 damage 开始时已经锁定的档位。

---

## BOSS 非致命命中

继续发：

    hit

同时增加：

    score = 35
    comboTier = 0

因此 Renderer 显示固定：

    35

并使用 ×1 档视觉样式。

---

## BOSS 致命一击

继续保留既有：

    emit("hit")

这样：

- hit 粒子保持
- hit 音效保持
- 既有事件链保持

但事件中设置：

    score = null
    comboTier = 0

Renderer 只有满足：

    Number.isFinite(e.score)

时才创建得分 sprite。

因此：

    BOSS 致命一击
    → hit 事件仍存在
    → 粒子 / 音效仍存在
    → 不产生得分飘字
    → 最终仍只结算 3000 分
    → finish(true)

没有改变既有 BOSS 得分规则。

---

## 最终颜色规则

不新增任何颜色。

四档固定使用当前已有 COLORS：

    ×1 → COLORS.white
    ×2 → COLORS.lime
    ×3 → COLORS.blue
    ×4 → COLORS.pink

尺寸分别为：

    ×1 → 33 × 25
    ×2 → 38 × 28
    ×3 → 43 × 31
    ×4 → 50 × 36

这样同时满足：

- 四档可视觉区分
- 不新增 palette token
- 不产生不存在的设计变量

---

## 最终 reduced-motion 规则

不再判断不存在的：

    event.kind

Renderer 创建 number sprite 的条件统一为：

    e.type === "hit"
    &&
    Number.isFinite(e.score)
    &&
    !this.reduced
    &&
    this.effects.length < 32

因此 reduced-motion 用户：

    不创建 number sprite
    不会上升
    不会淡出

无需创建后再立即销毁。

---

## 修订与恢复

人工修改 #67 后：

    agent:blocked
    挂起

被移除，并恢复：

    同意实现
    agent:proposal

随后重新执行 Split Dry Run。

审核结果确认 Proposal 已经：

    consistency = pass
    codeFit = pass
    scope = pass
    blockers = []

随后正式 Split。

---

## 第二次 Split 结果

#67 被拆为两个子任务。

### #73

    feat(game):
    hit 事件携带 score 与 comboTier，
    BOSS 致命一击 score=null

负责：

- 普通怪 hit score
- comboTier 快照
- BOSS 非致命 score=35
- BOSS 致命 score=null
- 对应 Game 单元测试

对应：

    PR #75

PR #75 合并后 Maintenance 将 #73 标记：

    agent:task
    agent:done

并关闭 Issue。

---

## #74

    feat(renderer):
    命中飘字改为得分数字，
    并按 comboTier 分级颜色与尺寸

负责：

- 使用 e.score 替代 e.value
- Number.isFinite(score) 守卫
- reduced-motion 守卫
- white / lime / blue / pink 四档
- 保持 effects 上限 32
- 保持 0.7s 生命周期与 45 units/s 上飘

对应：

    PR #76

PR #76 合并后 Maintenance 将 #74 标记：

    agent:task
    agent:done

并关闭 Issue。

---

## Parent Proposal 收尾

当 #73 与 #74 都变为：

    agent:done

Maintenance 检测到：

    2 / 2 child tasks completed

于是 #67 自动变为：

    agent:proposal
    agent:split
    agent:done

并关闭。

这再次验证了父子 Issue 生命周期：

    Proposal
        ↓
    Split
        ↓
    Child Tasks
        ↓
    PR Merge
        ↓
    Maintenance
        ↓
    Child agent:done
        ↓
    All Children Done
        ↓
    Parent agent:done
        ↓
    Parent Closed

---

## 本次恢复过程中出现的权限问题

人工重新执行：

    node app/split-issues.mjs --issue=67

时曾经使用 root 用户，导致：

    fatal:
    detected dubious ownership in repository

原因是：

    /opt/pinward-agent/repo/pinward

属于：

    pinward-agent

正确恢复方式不是配置：

    git config --global --add safe.directory ...

而是使用正确的执行用户：

    pinward-agent

最终权限规范保持为：

    Git / Split / Implement
    → pinward-agent

    systemctl / journalctl 运维
    → root

不要通过 safe.directory 绕过 ownership 保护。

---

## Research 阶段暴露出的长期问题

2026-09-27 的 #59 已经证明：

    Proposal 本身可能内部语义不一致

#67 又进一步证明：

    Proposal 即使内部文字自洽，
    仍可能与当前 master 的真实代码契约冲突

因此 Research 阶段不能只检查自然语言自洽性。

还需要进行：

**代码契约校验。**

---

## Research 输出前建议增加的检查

### 1. 真实事件顺序

如果 Proposal 描述：

    某事件不会发生
    某事件发生在某条件之后

必须先核对真实控制流。

尤其检查：

    emit()
    score +=
    registerKill()
    finish()
    return

的实际顺序。

---

### 2. 常量必须真实存在

引用以下对象时：

    COLORS
    TYPES
    config
    enum
    CSS variable

必须确认 key 在 master 中真实存在。

不能根据自然语言描述臆造：

    粉紫
    successBlue
    hotPink

等不存在的 token。

---

### 3. 区分不同数据层

必须明确区分：

    Game Event

与：

    Renderer Effect

例如：

    event.type
    event.score

不等于：

    effect.kind
    effect.life

不能把下游内部结构当成上游事件字段。

---

### 4. “保持原样”必须和验收标准一致

如果 Proposal 写：

    保持原样

但验收标准要求：

    删除现有事件
    改变现有得分
    改变既有反馈

则 Proposal 本身已经违反代码契约。

应在 Research 阶段修正，而不是交给 Implementation 猜测。

---

### 5. 视觉得分必须等于真实得分

floating score 的语义必须是：

    玩家本次实际获得的 score

不能为了视觉效果显示一个实际上并没有加入 Game.score 的数字。

---

## 推荐的标准排障顺序

遇到：

    Issue 已批准
    但没有实现

建议按以下顺序检查：

    1. Parent labels
    2. 是否执行过 Split
    3. Split decision
    4. blockers
    5. codeFit
    6. 是否生成 child Task
    7. dependencies
    8. Implementation
    9. worktree
    10. tests
    11. PR
    12. Maintenance

如果：

    tasks = []

就应该优先看 Split Review，而不是从 Implementation 开始排查。

---

## 完整恢复链路

    #67
        ↓
    人工批准
        ↓
    Split Review
        ↓
    发现 Proposal 与 master 冲突
        ↓
    agent:blocked + 挂起
        ↓
    人工核对真实代码
        ↓
    明确 BOSS hit 语义
        ↓
    明确 COLORS
        ↓
    修正 reduced-motion 方案
        ↓
    恢复 同意实现
        ↓
    Split Dry Run PASS
        ↓
    #73 / #74
        ↓
    PR #75 merged
        ↓
    #73 agent:done
        ↓
    PR #76 merged
        ↓
    #74 agent:done
        ↓
    #67 2/2 tasks complete
        ↓
    #67 agent:done
        ↓
    #67 closed

---

## 核心经验

### 1. Proposal 自洽不等于代码契约正确

Research 不能只判断文字是否自洽，还必须与当前 master 对照。

### 2. 代码是既有行为的事实来源

对于：

- 事件顺序
- 得分顺序
- 状态生命周期
- palette token
- event payload

应以 master 的真实代码为准。

### 3. 不要为了满足错误 Proposal 而破坏既有行为

本次没有删除 BOSS 致命 hit，而是通过：

    score = null

明确表达：

    保留命中反馈
    不显示得分飘字

这是比修改既有 BOSS 事件链更小、更安全的变化。

### 4. Blocked 是安全机制成功

需求无法唯一映射到当前代码时：

    停止
    请求人工决策

比继续自动生成代码更可靠。

### 5. 自动化必须尊重系统用户边界

    Agent / Git
    → pinward-agent

    systemd
    → root

不要用 `safe.directory` 掩盖 ownership 问题。

