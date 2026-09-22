# PINWARD 每日自动化运维手册

这台机器（七牛云轻量 T1 / 2C2G / Ubuntu 24.04 / 新加坡）每天早上自动做四件事：

| 时间（Asia/Singapore） | 命令 | 模型 | 产出 |
| --- | --- | --- | --- |
| 09:00 | `pinward research` | MiniMax M3 | 抓互联网资讯 → 生成优化建议 issue（标签 `未审核`） |
| 10:00 | `pinward split` | DeepSeek flash | 取 `同意实现` 的 issue → 拆成子 issue（`同意实现` + `子任务`） |
| 10:30 | `pinward implement` | MiniMax M3 | 逐个实现子 issue → 每个一个 draft PR |
| 11:30 | `pinward verify` | — | 把当天所有 `ai/*` PR 试合并 + 跑测试，把结果评论回 PR |

**人类只需要做两件事**：09:30 前把 issue 的标签改成 `同意实现` / `挂起` / `拒绝`；下午评审并合并 PR。

## 标签约定

| 标签 | 谁维护 | 含义 |
| --- | --- | --- |
| `未审核` | 机器创建 | 当天新建议，等人工裁决 |
| `同意实现` | **人工** | 批准；这是 `split` 与 `implement` 唯一的入口条件 |
| `挂起` | **人工** | 暂不实现 |
| `拒绝` | **人工** | 否决 |
| `子任务` | 机器 | 由拆分产生，用于区分「待拆分」与「待实现」，防止无限递归拆分 |
| `已拆分` | 机器 | 父 issue 已拆分完成 |
| `AI失败` | 机器 | 自动化失败，需人工介入；**移除该标签后会被重新捡起** |
| `AI实现中` | 机器 | 正在实现中 |

## 目录

```
/opt/pinward/
├── app/          # 仓库工作副本（每次运行前 reset 到 origin/master）
├── worktrees/current/  # 实现用的临时 worktree（串行复用）
├── scratch/      # 研究与拆分的工作目录（不接触仓库）
└── state/
    ├── state.json          # issue -> 阶段
    ├── pinward.lock        # 全局互斥锁
    └── runs/<日期>/        # 每天的 prompt、模型原始输出、测试日志、用量
/etc/pinward/agent.env      # 600 root:root，密钥
/etc/systemd/system/pinward@.service + pinward-{research,split,implement,verify}.timer
```

## 首次部署

```bash
# 1. 七牛控制台 → Web 命令行（或 SSH），以 root 执行
mkdir -p /opt/pinward/app && cd /opt/pinward/app
git clone --branch master https://github.com/zidanDirk/pinward.git .
sudo bash ops/bootstrap.sh        # 幂等，会交互式询问三个密钥
```

`bootstrap.sh` 会：设置时区 → 建 4GB swap → 装 Node 22 / gh / jq → 建无 sudo 的 `pinward` 用户 → 装 Claude Code → 写两套模型配置 → 写密钥文件（600）→ 配置 git 凭据 → 克隆仓库 → 启用 ufw → 安装并启用 systemd 定时器。

### 需要准备的三个凭据

| 变量 | 从哪来 | 权限要求 |
| --- | --- | --- |
| `MINIMAX_API_KEY` | MiniMax 开放平台 Token Plan | 无 |
| `DEEPSEEK_API_KEY` | DeepSeek 开放平台 | 无 |
| `GH_TOKEN` | GitHub **fine-grained PAT** | 仅限 `zidanDirk/pinward`：Issues RW、Contents RW、Pull requests RW、Metadata R |

## 日常运维

```bash
# 手动触发（调试用）
sudo -u pinward -H bash -lc 'set -a; . /etc/pinward/agent.env; set +a; /opt/pinward/app/ops/bin/pinward doctor'
sudo -u pinward -H bash -lc '... pinward research --dry-run'      # 只生成不建 issue
sudo -u pinward -H bash -lc '... pinward implement --issue 12'    # 只补做某条
sudo -u pinward -H bash -lc '... pinward status'                  # 状态总览

# 看日志
journalctl -u pinward@research -n 200 --no-pager
ls -lt /opt/pinward/state/runs/ | head

# 定时器
systemctl list-timers 'pinward-*'
systemctl start pinward@research        # 立即跑一次
```

更新自动化脚本本身：改 `ops/` → 合并到 `master` → 在服务器执行 `sudo bash /opt/pinward/app/ops/install.sh`。

## 安全边界（重要）

1. **机器不能合并、不能推 `master`**。脚本内有 `default_branch_guard`，GitHub 侧还有分支保护（require PR + require status check `test`）。
2. **实施 agent 不持有 GitHub 凭据**。调用 Claude Code 时用 `env -u GH_TOKEN` 剥离 token；`git push` 与 `gh pr create` 由外层脚本在通过校验之后执行。所以模型即使被注入，也无法直接操作远端。
3. **研究与拆分阶段没有文件/命令权限**，只能输出文本，产物还要过 JSON schema 校验。这意味着注入要生效必须穿过人工审核这一关。
4. **受保护路径**：AI 分支不得改 `ops/`、`.github/`、`CLAUDE.md`、`package.json`。脚本在提交前拒绝，CI 的 `guard` job 再拦一道。
5. `agent.env` 是 `600 root:root`，`pinward` 用户读不到文件本身；密钥通过 systemd 注入进程环境。
6. 残余风险：实施 agent 有 `Bash(node:*)` 等权限，理论上可以读自己的进程环境拿到模型 Key。彻底隔离需要容器化（见「后续加固」）。

## 成本与熔断

`/etc/pinward/agent.env` 里可调：

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `MAX_CHILDREN_PER_DAY` | 5 | 单次实现的最多子任务数 |
| `MAX_IMPLEMENT_SECONDS` | 5400 | 实现阶段的总时间预算（秒） |
| `MAX_TURNS_IMPLEMENT` | 40 | 单次实现的最大对话轮数 |
| `CLAUDE_TIMEOUT_SECONDS` | 1800 | 单次 Claude 调用的硬超时 |
| `FEED_HOURS` / `FEED_LIMIT` | 24 / 60 | 资讯时间窗与条数上限 |
| `PINWARD_WEBHOOK_URL` | 空 | 填了就把每日结果 POST 过去（JSON：`{subject, body}`） |

systemd 单元还有 `MemoryHigh=1200M` / `MemoryMax=1700M`，超限只杀本单元，不拖垮整机。

## 故障排查

| 现象 | 先看 |
| --- | --- |
| 早上没有新 issue | `journalctl -u pinward@research -n 100`；`state/runs/<日期>/digest.md` 里「本次抓取失败」小节 |
| issue 创建了但内容是废话 | `state/runs/<日期>/research.json` 与 `research-validation.log` |
| `split` 没动作 | 确认 issue 是 `同意实现` 且**没有** `子任务`/`已拆分`/`AI失败` 标签 |
| PR 没建出来 | `state/runs/<日期>/implement-<N>-test.log`；issue 上会有失败评论 |
| 卡在锁 | `state/runs/<日期>/skipped.log`；检查是否有残留的 `claude` 进程 |
| 模型 401 | `pinward doctor` 看两个模型回显；确认 base URL（MiniMax 国际站 `api.minimax.io`） |

## 后续加固（未实现，按需开启）

- 用 Docker 跑实施 agent，容器内不注入 GitHub 凭据，只挂载 worktree；
- 用 GitHub App 替代 PAT，让 AI PR 的作者是独立机器人账号，从而支持「必须他人 approve」的分支保护；
- 加 Playwright 做 UI 改动的截图验证（当前 2 GB 内存下默认不装 Chromium）。
