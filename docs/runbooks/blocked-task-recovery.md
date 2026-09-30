# BLOCKED Implementation Task 恢复 Runbook

本 Runbook 用于处理：

    agent:task
    +
    agent:blocked

且因为 Implementation / Verification 技术失败而保留 dirty worktree 的任务。

典型案例：

- Issue #79
- 测试失败
- Repair Agent 未完成修复
- 没有 commit / push / PR
- worktree 仍然存在

---

## 不适用情况

如果 Issue 含有：

    挂起

不要使用本 Recovery 自动继续。

`挂起` 可能表示人工产品决策。

需要人工重新审核需求后再处理。

同样，如果已经存在：

    agent:pr-open

也不要使用该恢复入口。

---

## 1. 使用哪个 Linux 账号

使用：

    pinward-agent

不要使用 root 执行 Git / worktree / implementation recovery。

例如：

    sudo -iu pinward-agent

---

## 2. 查看 Task State

    cd /opt/pinward-agent

    cat state/tasks/<ISSUE>.json

应该确认：

    phase = BLOCKED

并检查：

- branch
- worktree
- baseSha
- allowedFiles
- changedFiles
- attempts
- lastError

---

## 3. 查看 worktree

    git \
      --git-dir=/opt/pinward-agent/repo/pinward.git \
      worktree list --porcelain

然后：

    git \
      -C /opt/pinward-agent/worktrees/issue-<ISSUE> \
      status --short

不要执行：

    git reset --hard

也不要删除 dirty worktree。

---

## 4. 查看结构化 Failure Diagnostics

    ls -lh \
      /opt/pinward-agent/state/implement/issue-<ISSUE>-*

重点查看：

    issue-<ISSUE>-test-failure-*.json

其中包含：

- failureSignature
- categoryHint
- failing test
- file / line
- expected
- actual
- operator

以及：

    issue-<ISSUE>-repair-*-meta.json

其中包含：

- Repair 前 fingerprint
- Repair 后 fingerprint
- 是否产生有效文件变化
- Agent exit error

---

## 5. 人工修正时遵守 Allowed Files

只能修改：

    state/tasks/<ISSUE>.json

中的：

    allowedFiles

所列出的业务文件。

不要为了让测试通过扩大修改范围。

不要修改：

- `.github/**`
- automation systemd
- unrelated source files
- package scripts
- dependencies

除非原 Issue 本身明确允许。

---

## 6. Dry Run Recovery

修复完成后不要先改 GitHub Label。

运行：

    cd /opt/pinward-agent

    node app/recover-blocked.mjs \
      --issue=<ISSUE>

Dry Run 会验证：

- task state
- BLOCKED phase
- GitHub labels
- branch
- worktree
- Allowed Files
- npm ci
- npm run check
- npm test

Dry Run 不会：

- 修改 GitHub labels
- commit
- push
- 创建 PR
- merge PR

看到：

    RECOVERY PRECHECK: PASS

才进入下一步。

---

## 7. 正式恢复

运行：

    node app/recover-blocked.mjs \
      --issue=<ISSUE> \
      --publish

Recovery 会自动获取：

    /opt/pinward-agent/state/pipeline.lock

然后再次完整执行：

    npm ci
    npm run check
    npm test

三项全部通过后才会：

    恢复 同意实现
        ↓
    移除 agent:blocked
        ↓
    implement-task --publish

随后由现有 Implementation checkpoint 完成：

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

---

## 8. 成功检查

Task State：

    cat \
      /opt/pinward-agent/state/tasks/<ISSUE>.json

预期：

    phase = PR_OPEN

并且：

    verification.npmCi = pass
    verification.check = pass
    verification.test = pass

GitHub：

    gh issue view <ISSUE> \
      --repo zidanDirk/pinward \
      --json number,state,labels,url

预期包含：

    同意实现
    agent:task
    agent:pr-open

检查 PR：

    gh pr list \
      --repo zidanDirk/pinward \
      --state open \
      --head ai/<ISSUE>-task \
      --json number,title,url,headRefName,baseRefName

---

## 9. Recovery 失败时

如果：

    npm ci
    npm run check
    npm test

任何一步失败，Recovery 不会解除：

    agent:blocked

如果测试已经通过，但后续 publish 失败，Recovery 会尽最大努力重新恢复：

    agent:blocked

并记录：

    blocked_recovery_failure

此时继续保留 worktree 排查。

不要直接手工 push。

---

## 10. 不要执行的操作

禁止把以下操作当成恢复捷径：

    git reset --hard
    rm -rf worktrees/issue-N
    git push --force
    gh pr merge
    手工把 task-state 改成 VERIFIED
    测试没跑就移除 agent:blocked

Task State 是 checkpoint，不应该人工伪造。

---

## 11. Repair 参数

默认：

    PINWARD_MAX_REPAIR_ATTEMPTS=2
    PINWARD_REPAIR_MAX_TURNS=50

允许：

    PINWARD_MAX_REPAIR_ATTEMPTS
      0 ～ 3

    PINWARD_REPAIR_MAX_TURNS
      10 ～ 80

不要通过无限增加 Repair 次数或 turns 掩盖：

- 测试 fixture 错误
- 需求语义冲突
- 基础设施问题

---

## 12. 判断是业务 Block 还是基础设施故障

业务测试失败：

    npm test FAIL
        ↓
    bounded Repair
        ↓
    BLOCKED

这类情况不会因为业务 Block 本身触发 Ops Alert。

基础设施故障例如：

- npm registry/network
- GitHub permission
- SSH push
- repository ownership
- filesystem
- systemd

应进入 Failure Ledger / Ops Alert 排查流程。

---

## 13. 最终原则

BLOCKED Recovery 的核心不是：

> 让任务尽快重新跑起来。

而是：

> 保留失败现场，在重新验证成功后，安全地继续原有 publish checkpoint。

稳定路径：

    BLOCKED
        ↓
    inspect
        ↓
    minimal correction
        ↓
    recover-blocked --issue=N
        ↓
    full verification
        ↓
    recover-blocked --issue=N --publish
        ↓
    PR_OPEN
        ↓
    Human Review
        ↓
    Human Merge

自动化不会自动 Merge PR。
