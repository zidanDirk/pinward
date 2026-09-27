# 2026-09-27 Proposal Block 与 Dirty Base Repository 恢复

## 摘要

2026-09-27，PINWARD 自动化流水线围绕父 Issue #59 连续遇到两个不同阶段的问题：

1. #59 在 Split 技术审核阶段因 Proposal 内部语义冲突被安全阻止。
2. 修订 Proposal 并成功拆分后，#61 在 Implementation 阶段又因为 Automation Base Repository 为 dirty 状态而拒绝继续执行。

两个问题最终均恢复：

- #59 修订后重新 Split 成功。
- 产生子任务 #61、#62。
- #61 通过已有 worktree 的 `--resume` 恢复。
- 自动测试 137 / 137 通过。
- PR #64 合并。
- #62 在依赖解除后继续实现。
- PR #65 合并。

本次事故同时验证了 Split Blocker、Dirty Repo Protection 和 Worktree Resume 三套安全机制的价值。

---

## 关联对象

- Parent Proposal：#59
- Task 1：#61
- Task 2：#62
- Ops Alert：#63
- Task 1 PR：#64
- Task 2 PR：#65

---

## 第一阶段：#59 在 Split 阶段被阻止

### 初始流程

Research Agent 创建 #59：

    未审核
    agent:proposal

人工审核后：

    同意实现
    agent:proposal

随后 Split Worker 对 Proposal 进行技术审核。

### 根因 1：waveHadLeak 规则冲突

Proposal 一处要求：

    护盾触发后不置位 waveHadLeak

这意味着：

    怪物触底
    → 护盾抵消
    → waveHadLeak 仍为 false
    → 仍可能获得 perfectWave

但同一 Proposal 的其他说明和验收标准又要求：

    护盾只抵消 HP
    → 仍然算漏怪
    → 不获得 perfectWave / 狂热无漏

两套规则互斥。

Split Agent 如果自行选择其中一种，就等同于替需求方决定玩法和计分规则，因此自动停止是正确行为。

---

## 根因 2：leak / shieldSave 事件链冲突

原 Proposal 同时要求：

    保留 leak
    → renderer 继续产生反馈

以及新增：

    shieldSave
    → 专属 toast
    → 专属音效

当时 master 中已有行为：

    main.js
    leak → “基地受到冲击，剩余 N 点血量”

    audio.js
    leak → 普通漏怪音

    renderer.js
    leak → camera shake

如果直接连续发送：

    leak
    shieldSave

则会产生普通漏怪反馈和护盾反馈叠加。

如果完全取消 leak，则 renderer 的 shake 又会消失。

因此 Proposal 在事件消费者行为上没有唯一解释。

---

## Block 状态的含义

Split Worker 将 #59 调整为：

    agent:proposal
    agent:blocked
    挂起

并移除：

    同意实现

同时：

    tasks = []

因此不会产生 child Task，也不会进入 Implementation。

这不是 Label 错乱，而是正常的安全状态：

    Proposal
        ↓
    Split 技术审核
        ↓
    发现无法唯一解释的规则
        ↓
    Block
        ↓
    等待人工决策

经验：

**没有 PR 时，不应该直接从 Implementation 层开始排查。**

首先应该检查：

    Parent Proposal
    → Split decision
    → blockers
    → child Task
    → dependencies
    → Implementation

---

## #59 的最终规则

人工修订后将规则统一为：

    怪物触底
        ↓
    waveHadLeak = true
        ↓
    shieldLeft > 0 ?
        ↓ 是
    shieldLeft--
        ↓
    emit("leak", { shielded: true })
        ↓
    emit("shieldSave", { hpLeft })
        ↓
    不扣 HP

最终语义：

- 护盾只抵消 HP 损失。
- 护盾不能抵消“发生漏怪”这个事实。
- 护盾触发的波次不能获得 perfectWave。
- 护盾触发的波次不能获得狂热无漏。
- renderer 继续通过 leak 保留 shake。
- main.js 对 shielded leak 不显示普通漏怪 toast。
- audio.js 对 shielded leak 不播放普通漏怪音。
- shieldSave 负责唯一的护盾专属反馈。

---

## 第二次 Split

修订 #59 后重新执行：

    node app/split-issues.mjs --issue=59

Dry Run 结果：

    decision = split
    consistency = pass
    codeFit = pass
    scope = pass
    blockers = []

正式 Publish 后创建：

    #61
    #62

父 Issue 进入：

    同意实现
    agent:proposal
    agent:split

说明 Proposal 已经成功进入 Implementation 阶段。

---

## 第二阶段：#61 Implementation 失败

2026-09-27 16:10，Implementation Worker 开始处理 #61。

日志：

    ===== IMPLEMENT TASK #61 =====
    ===== Sync base repository =====
    ===== IMPLEMENT FAILED =====

    Error:
    Base repository is dirty.
    Refusing to reset it.

随后：

    pinward-implement.service
    → exit status 1

systemd OnFailure 自动创建：

    #63
    [Agent Alert][2026-09-27] pinward-implement.service failed

---

## 为什么 Dirty Repo 时必须停止

Automation Base Repository：

    /opt/pinward-agent/repo/pinward

是所有 Agent worktree 的 master 基准。

如果它存在未提交修改时自动执行：

    git reset --hard origin/master

可能永久删除：

- 未提交代码
- 人工编辑文档
- 临时诊断修改
- 尚未保存到独立 branch 的工作

因此：

    Base repository is dirty.
    Refusing to reset it.

是正确的安全保护。

不应该通过取消检测或强制 reset 来“修复”这个问题。

---

## 为什么无法确定当时具体哪个文件 Dirty

故障后再次执行：

    git status --short
    git diff --name-only
    git ls-files --others --exclude-standard

三项都为空。

因此当前只能确定：

**Implementation Worker 在 16:10 执行瞬间检测到 Base Repository 为 dirty。**

无法准确确认具体污染文件。

不能在事故记录中猜测文件来源。

原因是当时 `ensureBaseRepository()` 只记录：

    Base repository is dirty.
    Refusing to reset it.

没有记录：

    git status --porcelain

导致瞬时状态消失后，具体 dirty path 无法复原。

---

## #62 为什么没有同时实现

#62 依赖 #61。

在 #61 PR 尚未合并时，Worker 输出：

    ===== WAITING FOR DEPENDENCIES =====

    Dependency task 1 is #61,
    but branch ai/61-task
    has no merged PR into master yet.

这是正常行为。

正确依赖流程：

    #61
    → Implementation
    → PR
    → Human Merge
    → Maintenance
    → agent:done
    → #62 dependency satisfied

---

## #61 的 Worktree 恢复

Base Repository 恢复 clean 后再次执行：

    node app/implement-task.mjs --issue=61

程序发现已有：

    /opt/pinward-agent/worktrees/issue-61

并且其中已经存在修改。

因此拒绝直接覆盖：

    Worktree already contains changes.

    Use --resume to continue
    the existing Dry Run,
    or --publish to publish
    the verified changes.

这也是正确的安全保护。

没有删除 worktree，而是使用：

    node app/implement-task.mjs \
      --issue=61 \
      --resume

继续之前的工作现场。

---

## Resume 验证

恢复后依次完成：

    npm ci
    npm run check
    npm test

结果：

    tests 137
    pass 137
    fail 0

修改范围：

    docs/validation.md
    src/game.js
    tests/game.test.js

全部属于 #61 Allowed Files。

随后正式 Publish，创建：

    PR #64
    feat(game): 每波一次性护盾
    shieldLeft 与 shieldSave 事件

PR #64 经人工审核后合并。

---

## #62 恢复

PR #64 合并并执行 Maintenance 后：

    #61
    → agent:done
    → closed

#62 的 Dependency 满足，Implementation Worker 随后继续执行。

产生：

    PR #65
    feat(ui): 护盾的差异化 toast、
    音效与 HUD 徽章

PR #65 最终同样人工合并。

至此 #59 的业务实现完成。

---

## Automation Base Repository 使用规范

目录：

    /opt/pinward-agent/repo/pinward

定义为：

**Automation Base Repository**

它只用于：

- fetch origin
- 同步 origin/master
- 提供 master 基准
- 创建 Agent worktree

禁止直接在该目录做人工代码或文档修改。

人工修改必须创建独立 worktree，例如：

    git worktree add \
      -b docs/some-change \
      /opt/pinward-agent/worktrees/manual-some-change \
      origin/master

然后仅在：

    /opt/pinward-agent/worktrees/manual-some-change

中完成：

- 编辑
- commit
- push
- PR

目标是让 Base Repository 长期满足：

    git status --short
    → empty

---

## Git 与系统用户边界

Git / Agent 操作统一使用：

    pinward-agent

systemd 运维统一使用：

    root

不应依赖 root 的：

    safe.directory

配置绕过 Git dubious ownership 保护。

正确边界：

    Repository owner
    → pinward-agent

    Git / Agent
    → pinward-agent

    systemctl
    → root

权限边界本身也是自动化安全机制的一部分。

---

## 永久改进 1：Dirty Repo 错误必须输出具体路径

当前日志：

    Base repository is dirty.
    Refusing to reset it.

信息不足。

以后建议输出：

    Base repository is dirty.
    Refusing to reset it.

    Dirty paths:
     M docs/example.md
    ?? some-file

即将：

    git status --porcelain

结果直接附加到异常信息。

这样 systemd 日志和 Ops Alert 就可以直接定位污染源。

---

## 永久改进 2：不要削弱 Split Blocker

#59 证明 Split 可以正确阻止一个内部规则互相矛盾的 Proposal。

因此不应为了提高自动化成功率而取消或降低 Blocker。

正确职责：

    Research
    → 尽可能生成自洽 Proposal

    Split
    → 独立技术审核
    → 继续作为安全门

---

## 永久改进 3：Research 输出前增加语义自洽检查

Research Agent 在输出 Proposal 前应检查：

- Proposal、实现思路、验收标准是否描述同一套规则。
- 同一个状态字段不能同时要求“置位”和“不置位”。
- 多个事件消费者的行为必须明确。
- 不允许一处要求直接 return，而另一处依赖 return 后的行为。
- 验收标准必须能够被实现方案直接满足。
- 出现真正产品决策冲突时，应统一为一套规则，而不是同时保留互斥描述。

---

## 标准排障顺序

以后遇到：

    Proposal 已批准
    但没有 PR

建议依次检查：

    1. Parent Proposal labels
    2. Split decision
    3. blockers
    4. child Task 是否存在
    5. Task dependencies
    6. Implementation service
    7. Base Repository 状态
    8. Worktree 状态
    9. npm ci
    10. npm run check
    11. npm test
    12. Git commit / push
    13. PR

不要一开始就假设是模型、npm 或 Git Push 失败。

---

## 完整恢复链路

最终事件链：

    #59 Proposal
        ↓
    人工批准
        ↓
    Split 发现语义冲突
        ↓
    agent:blocked + 挂起
        ↓
    人工统一规则
        ↓
    Split PASS
        ↓
    #61 / #62
        ↓
    #61 Implementation
        ↓
    Base Repo dirty
        ↓
    安全中止
        ↓
    #63 Ops Alert
        ↓
    Base Repo 恢复 clean
        ↓
    已存在 issue-61 worktree
        ↓
    --resume
        ↓
    137 / 137 tests PASS
        ↓
    PR #64
        ↓
    Human Merge
        ↓
    Maintenance
        ↓
    #61 agent:done
        ↓
    #62 dependency satisfied
        ↓
    PR #65
        ↓
    Human Merge

---

## 核心经验

### 1. Blocked 不等于失败

Split 在需求无法唯一解释时停止，比自动生成错误实现更安全。

### 2. Automation Base Repository 必须保持 clean

人工修改全部通过独立 worktree 完成。

### 3. 不要破坏故障现场

Base dirty 时不要自动 reset。

已有 worktree 修改时不要直接删除，优先使用 `--resume`。

### 4. 可诊断性也是自动化能力的一部分

安全失败不仅应该阻止危险操作，还必须输出足够的信息帮助人快速恢复。

