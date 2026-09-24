# 2026-09-24 Research Agent 校验失败事故记录

## 摘要

2026-09-24 09:00（Asia/Singapore），`pinward-research.service` 由 systemd timer 正常启动。

MiniMax 已成功完成 Research 并返回结果，但 `app/research.mjs` 在 `validateProposal()` 阶段因来源字段校验过严而失败，最终 service 以 exit code 1 退出。

systemd `OnFailure` 链路正常工作，并自动创建 GitHub Alert #40。

修复后重新运行 Research 成功，当日 Proposal #41 正常创建，随后拆分出 #42、#43、#44。

## 时间线

### 09:00:01

Research 正常启动并完成：

- 同步 `origin/master`
- 加载 GitHub Issues
- 加载 Pull Requests
- 启动 MiniMax Research

### 09:03:15

Proposal 校验失败：

    ===== RESEARCH FAILED =====
    Error: Every source requires title, url and insight.
        at validateProposal (
          file:///opt/pinward-agent/app/research.mjs:310:13
        )

systemd 状态：

    Result=exit-code
    ExecMainCode=1
    ExecMainStatus=1

随后触发 `OnFailure` 并创建：

- #40 `[Agent Alert][2026-09-24] pinward-research.service failed`

## 根因

实际执行流程是：

    MiniMax Research
    → stdout 返回
    → extractJson()
    → validateProposal()
    → FAILED

因此 MiniMax API、systemd、GitHub API 都不是此次直接故障原因。

当时 `sources[]` 实际要求：

- `title`
- `url`
- `sourceType`
- `insight`

但是 `sourceType` 不应该成为硬性校验条件。

来源可信度应该通过 URL/domain 判断，而不是依赖模型自己声明 `sourceType`。

## 关于 unrecognized_model

日志同时出现：

    [claude-code:unrecognized_model]
    {"model":"MiniMax-M3","query_source":"sdk"}

该信息是 Claude Code 的模型目录警告，不是本次失败根因。

真正导致进程退出的是 `validateProposal()` 抛出的异常。

## 修复

### 1. sourceType 改为可选

来源只强制要求：

- `title`
- `url`
- `insight`

来源可信度继续通过 URL/domain 规则判断。

### 2. 改进校验错误

错误从：

    Every source requires title, url and insight.

改为：

    Source #N missing required fields: ...

例如：

    Source #3 missing required fields: insight

这样可以直接定位具体坏数据。

### 3. 保存 Research 原始结果

新增诊断目录：

    /opt/pinward-agent/state/research/

后续新的 Research 会保存：

    <timestamp>-raw.txt
    <timestamp>-stderr.txt
    <timestamp>-proposal.json

其中：

- `raw.txt`：MiniMax 原始 stdout
- `stderr.txt`：Claude Code stderr
- `proposal.json`：`extractJson()` 后、`validateProposal()` 前的结构化数据

核心原则：

    AI 输出
    → 先落盘
    → 再校验

该功能是在 2026-09-24 当日成功重跑后加入，因此当天早上的执行没有历史 snapshot。

## 修复验证

修复后重新运行 Research 成功。

正常创建：

- #41 `[Daily Idea][2026-09-24] 无漏波奖励与庆祝反馈`

随后正常拆分：

- #42
- #43
- #44

链路恢复：

    systemd
    → Research
    → MiniMax
    → JSON parse
    → Proposal validation
    → GitHub Proposal
    → Split

## 常用排查命令

查看 Research 状态：

    systemctl status pinward-research.service --no-pager -l

查看日志：

    journalctl -u pinward-research.service -n 200 --no-pager

查看退出状态：

    systemctl show pinward-research.service \
      -p Result \
      -p ExecMainCode \
      -p ExecMainStatus

查看所有 Timer：

    systemctl list-timers 'pinward-*' --all

查看 Research 快照：

    ls -lht /opt/pinward-agent/state/research

## 后续排查原则

1. 没出现 `PINWARD Daily Research`：检查 systemd、Node、环境变量和权限。
2. Sync 阶段失败：检查 Git、GitHub Token 和网络。
3. 已出现 `Start MiniMax research`：说明基础运行环境基本正常。
4. stack trace 指向 `validateProposal()`：优先检查 Research snapshot 和 Schema。
5. 不要仅凭 `unrecognized_model` 判断模型 API 故障。
6. 重跑前检查 GitHub 是否已经产生部分写入，避免重复 Proposal。

## 预防原则

- AI Schema 只要求真正必要的字段。
- 不依赖模型自报 `sourceType` 判断可信度。
- 来源质量优先根据 URL/domain 判断。
- 校验错误明确指出具体 source index 和字段。
- AI 输出在 validation 前落盘。
- warning 和 fatal error 分开判断。
- 失败后先保存现场，再决定是否重跑。
- Research 重跑必须保持幂等。

## 关联记录

- Alert：#40
- 当日 Proposal：#41
- 子任务：#42、#43、#44
- 服务：`pinward-research.service`
- 脚本：`app/research.mjs`
- 诊断目录：`/opt/pinward-agent/state/research/`

## 结论

本次事故属于 **AI 结构化输出校验过严导致的业务级失败**。

稳定流程：

    MiniMax
    → 保存 raw output
    → JSON parse
    → 保存 proposal.json
    → 最小必要字段校验
    → URL/domain 来源质量校验
    → 创建 GitHub Proposal
