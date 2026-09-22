#!/usr/bin/env bash
# 以 pinward 身份手动运行 pinward 子命令，密钥由 systemd 以 root 身份注入进程环境。
#
#   sudo bash /opt/pinward/app/ops/pinward-run.sh doctor
#   sudo bash /opt/pinward/app/ops/pinward-run.sh research --dry-run
#   sudo bash /opt/pinward/app/ops/pinward-run.sh implement --issue 12
#
# 为什么不直接 `sudo -u pinward bash -lc '. /etc/pinward/agent.env; ...'`：
# agent.env 是 600 root:root，pinward 用户读不到（这是有意为之）。
# 用 systemd-run 复刻定时器的运行条件：同一用户、同一环境、同一内存上限。
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/pinward/app}"
AGENT_USER="${AGENT_USER:-pinward}"
ENV_FILE="${ENV_FILE:-/etc/pinward/agent.env}"
PINWARD_ROOT="${PINWARD_ROOT:-/opt/pinward}"

usage() {
  echo "用法：sudo bash $0 <research|split|implement|verify|all|doctor|status> [参数...]" >&2
  echo "例如：sudo bash $0 doctor" >&2
}

[ $# -ge 1 ] || { usage; exit 1; }

# 非 root 时自动提权
if [ "$(id -u)" != "0" ]; then
  exec sudo -E bash "$0" "$@"
fi

[ -f "$ENV_FILE" ] || { echo "缺少 ${ENV_FILE}，请先执行 ops/bootstrap.sh" >&2; exit 1; }
[ -x "$APP_DIR/ops/bin/pinward" ] || { echo "缺少可执行的 $APP_DIR/ops/bin/pinward" >&2; exit 1; }
command -v systemd-run >/dev/null 2>&1 || { echo "缺少 systemd-run（需要 systemd）" >&2; exit 1; }

# 只在有 TTY 时申请伪终端，否则输出会进 journal
pty_args=()
[ -t 1 ] && pty_args=(--pty)

exec systemd-run --quiet --wait --collect "${pty_args[@]}" \
  --unit="pinward-manual-$$" \
  --uid="$AGENT_USER" --gid="$AGENT_USER" \
  -p "WorkingDirectory=$APP_DIR" \
  -p "EnvironmentFile=$ENV_FILE" \
  -p "Environment=HOME=/home/$AGENT_USER" \
  -p "Environment=PINWARD_ROOT=$PINWARD_ROOT" \
  -p "Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  -p "Environment=LANG=C.UTF-8" \
  -p "MemoryMax=1700M" \
  -- "$APP_DIR/ops/bin/pinward" "$@"
