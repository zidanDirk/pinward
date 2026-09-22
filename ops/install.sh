#!/usr/bin/env bash
# 部署 / 更新 PINWARD 自动化（root 执行，幂等，可反复运行）。
#
#   sudo bash /opt/pinward/app/ops/install.sh
#
# 做四件事：同步代码、修正权限、安装 systemd 定时器、补齐 GitHub 标签。
set -euo pipefail

PINWARD_ROOT="${PINWARD_ROOT:-/opt/pinward}"
AGENT_USER="${AGENT_USER:-pinward}"
GITHUB_REPO="${GITHUB_REPO:-zidanDirk/pinward}"
BASE_BRANCH="${BASE_BRANCH:-master}"
ENV_FILE="/etc/pinward/agent.env"
APP_DIR="$PINWARD_ROOT/app"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }
skip() { printf '    \033[90m· %s（跳过）\033[0m\n' "$*"; }
warn() { printf '    \033[33m! %s\033[0m\n' "$*"; }

[ "$(id -u)" = "0" ] || { echo "请用 root 执行：sudo bash $0" >&2; exit 1; }

# git 2.35+ 的所有权校验：本脚本以 root 操作 pinward 用户拥有的仓库，必须显式信任。
# 不加这一行会直接 fatal: detected dubious ownership，导致定时器装不上。
git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
git config --global --add safe.directory "$PINWARD_ROOT/worktrees/current" 2>/dev/null || true

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
else
  warn "$ENV_FILE 不存在，GitHub 标签同步将跳过"
fi

say "1/4 同步代码"
if [ -d "$APP_DIR/.git" ]; then
  # 同步失败不应阻断定时器安装，只告警
  if git -C "$APP_DIR" fetch --prune origin; then
    git -C "$APP_DIR" checkout -f -B "$BASE_BRANCH" "origin/$BASE_BRANCH" >/dev/null 2>&1 || true
    git -C "$APP_DIR" reset --hard "origin/$BASE_BRANCH" >/dev/null || warn "reset 失败"
    git -C "$APP_DIR" worktree prune >/dev/null 2>&1 || true
    ok "$APP_DIR @ $(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo '?')"
  else
    warn "git fetch 失败，跳过代码同步（继续安装定时器）"
  fi
elif [ -d "$APP_DIR" ] && [ -n "$(ls -A "$APP_DIR" 2>/dev/null)" ]; then
  warn "$APP_DIR 非空且不是 git 仓库，跳过克隆"
else
  git clone --branch "$BASE_BRANCH" "https://github.com/$GITHUB_REPO.git" "$APP_DIR"
  ok "已克隆到 $APP_DIR"
fi

say "2/4 目录与权限"
mkdir -p "$PINWARD_ROOT/state" "$PINWARD_ROOT/worktrees" "$PINWARD_ROOT/scratch"
chown -R "$AGENT_USER:$AGENT_USER" "$PINWARD_ROOT"
chmod +x "$APP_DIR/ops/bin/pinward" "$APP_DIR/ops/"*.sh 2>/dev/null || true
[ -f "$ENV_FILE" ] && { chmod 600 "$ENV_FILE"; chown root:root "$ENV_FILE"; }
ok "owner=${AGENT_USER}，agent.env 600 root:root"

say "3/4 systemd 定时器"
UNIT_SRC="$APP_DIR/ops/systemd"
if [ -d "$UNIT_SRC" ]; then
  install -m 644 "$UNIT_SRC/pinward@.service" /etc/systemd/system/pinward@.service
  for t in research split implement verify; do
    install -m 644 "$UNIT_SRC/pinward-$t.timer" "/etc/systemd/system/pinward-$t.timer"
  done
  systemctl daemon-reload
  for t in research split implement verify; do
    systemctl enable --now "pinward-$t.timer" >/dev/null 2>&1
  done
  ok "已安装并启用 4 个定时器"
  systemctl list-timers 'pinward-*' --no-pager 2>/dev/null | sed 's/^/    /' || true
else
  warn "未找到 $UNIT_SRC"
fi

say "4/4 GitHub 标签"
if [ -n "${GH_TOKEN:-}" ] && command -v gh >/dev/null 2>&1; then
  create_label() { # <name> <color> <desc>
    if gh label list -R "$GITHUB_REPO" --json name --jq '.[].name' 2>/dev/null | grep -qx "$1"; then
      skip "标签 $1"
    else
      gh label create "$1" -R "$GITHUB_REPO" --color "$2" --description "$3" >/dev/null 2>&1 \
        && ok "标签 $1" || warn "标签 $1 创建失败"
    fi
  }
  create_label "未审核"   fbca04 "AI 新建的每日建议，等待人工审核"
  create_label "同意实现" 0e8a16 "人工批准，自动化唯一入口"
  create_label "挂起"     d4c5f9 "人工暂停，暂不实现"
  create_label "拒绝"     b60205 "人工否决，不再处理"
  create_label "子任务"   1d76db "机器标记：拆分产生的子 issue"
  create_label "已拆分"   c2e0c6 "机器标记：父 issue 已完成拆分"
  create_label "AI失败"   e99695 "机器标记：自动化失败，需人工介入"
  create_label "AI实现中" f9d0c4 "机器标记：正在实现"
else
  warn "缺少 GH_TOKEN 或 gh，跳过标签同步"
fi

say "完成"
echo "    手动触发：sudo bash $APP_DIR/ops/pinward-run.sh <research|split|implement|verify|all|doctor|status>"
