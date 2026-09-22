#!/usr/bin/env bash
# PINWARD 服务器一次性初始化（Ubuntu 24.04，root 执行）。
#
#   sudo bash /opt/pinward/app/ops/bootstrap.sh
#
# 幂等：重复执行是安全的。已经配置好的项会跳过。
# 用法：
#   --reconfigure   重新输入密钥
#   --no-ufw        跳过防火墙配置
set -euo pipefail

GITHUB_REPO="${GITHUB_REPO:-zidanDirk/pinward}"
BASE_BRANCH="${BASE_BRANCH:-master}"
PINWARD_ROOT="${PINWARD_ROOT:-/opt/pinward}"
AGENT_USER="${AGENT_USER:-pinward}"
ENV_DIR="/etc/pinward"
ENV_FILE="$ENV_DIR/agent.env"
SWAP_SIZE_MB="${SWAP_SIZE_MB:-4096}"

RECONFIGURE=0
SETUP_UFW=1
for arg in "$@"; do
  case "$arg" in
    --reconfigure) RECONFIGURE=1 ;;
    --no-ufw) SETUP_UFW=0 ;;
    *) echo "未知参数：$arg" >&2; exit 1 ;;
  esac
done

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }
skip() { printf '    \033[90m· %s（已就绪，跳过）\033[0m\n' "$*"; }
warn() { printf '    \033[33m! %s\033[0m\n' "$*"; }

[ "$(id -u)" = "0" ] || { echo "请用 root 执行：sudo bash $0" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive

say "1/9 时区"
if [ "$(timedatectl show -p Timezone --value)" = "Asia/Singapore" ]; then
  skip "时区已是 Asia/Singapore"
else
  timedatectl set-timezone Asia/Singapore
  ok "时区设置为 Asia/Singapore（$(date '+%F %T %Z')）"
fi

say "2/9 Swap"
CURRENT_SWAP_MB="$(awk '/SwapTotal/{printf "%d", $2/1024}' /proc/meminfo)"
if [ "$CURRENT_SWAP_MB" -ge "$((SWAP_SIZE_MB - 128))" ]; then
  skip "已有 ${CURRENT_SWAP_MB} MB swap"
else
  warn "当前 swap 仅 ${CURRENT_SWAP_MB} MB，创建 ${SWAP_SIZE_MB} MB（2 GB 内存跑 Claude Code 必需）"
  if [ -f /swapfile ]; then swapoff /swapfile 2>/dev/null || true; rm -f /swapfile; fi
  if ! fallocate -l "${SWAP_SIZE_MB}M" /swapfile 2>/dev/null; then
    dd if=/dev/zero of=/swapfile bs=1M count="$SWAP_SIZE_MB" status=none
  fi
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  printf 'vm.swappiness=10\nvm.vfs_cache_pressure=50\n' > /etc/sysctl.d/99-pinward.conf
  sysctl -q -p /etc/sysctl.d/99-pinward.conf
  ok "swap $(awk '/SwapTotal/{printf "%.1f GB", $2/1048576}' /proc/meminfo)，swappiness=10"
fi

say "3/9 基础软件包"
apt-get update -qq
apt-get install -y -qq git curl ca-certificates jq unzip rsync >/dev/null
ok "git / curl / jq / unzip / rsync"

if ! command -v node >/dev/null 2>&1 || ! node --version | grep -qE '^v(2[2-9]|[3-9][0-9])'; then
  say "4/9 Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
  ok "Node $(node --version)"
else
  say "4/9 Node.js 22"
  skip "Node $(node --version)"
fi

if ! command -v gh >/dev/null 2>&1; then
  say "5/9 GitHub CLI"
  mkdir -p -m 755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
  chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list
  apt-get update -qq
  apt-get install -y -qq gh >/dev/null
  ok "gh $(gh --version | head -1 | awk '{print $3}')"
else
  say "5/9 GitHub CLI"
  skip "gh $(gh --version | head -1 | awk '{print $3}')"
fi

say "6/9 运行用户与 Claude Code"
if id -u "$AGENT_USER" >/dev/null 2>&1; then
  skip "用户 $AGENT_USER 已存在"
else
  useradd -m -s /bin/bash "$AGENT_USER"
  ok "已创建用户 $AGENT_USER（无 sudo 权限）"
fi
if command -v claude >/dev/null 2>&1; then
  skip "claude $(claude --version 2>/dev/null | head -1)"
else
  npm install -g @anthropic-ai/claude-code >/dev/null 2>&1
  ok "claude $(claude --version 2>/dev/null | head -1 || echo '已安装')"
fi

say "7/9 密钥与模型配置"
mkdir -p "$ENV_DIR" "$PINWARD_ROOT"
chmod 700 "$ENV_DIR"

if [ -f "$ENV_FILE" ] && [ "$RECONFIGURE" = "0" ]; then
  skip "$ENV_FILE 已存在（如需重填：bash $0 --reconfigure）"
  # shellcheck disable=SC1090
  source "$ENV_FILE"
else
  echo "    需要三个凭据，输入时不会回显："
  echo "    MiniMax 接口区域（必须与 key 的来源平台一致）："
  echo "      1 = 国际站 https://api.minimax.io/anthropic    （platform.minimax.io 申请的 key）"
  echo "      2 = 国内站 https://api.minimaxi.com/anthropic  （platform.minimaxi.com 申请的 key）"
  read -rp "    选择 [1/2，默认 2]: " REGION_CHOICE || true
  case "${REGION_CHOICE:-2}" in
    1) MINIMAX_BASE_URL="https://api.minimax.io/anthropic" ;;
    *) MINIMAX_BASE_URL="https://api.minimaxi.com/anthropic" ;;
  esac
  read -rsp "    MiniMax API Key: " MINIMAX_API_KEY; echo
  read -rsp "    DeepSeek API Key（sk-…）: " DEEPSEEK_API_KEY; echo
  read -rsp "    GitHub fine-grained PAT（github_pat_…，仅限 $GITHUB_REPO）: " GH_TOKEN; echo
  read -rp  "    失败通知 Webhook URL（可留空回车跳过）: " PINWARD_WEBHOOK_URL || true
  [ -n "${MINIMAX_API_KEY:-}" ] || { echo "MiniMax Key 不能为空" >&2; exit 1; }
  [ -n "${DEEPSEEK_API_KEY:-}" ] || { echo "DeepSeek Key 不能为空" >&2; exit 1; }
  [ -n "${GH_TOKEN:-}" ] || { echo "GitHub PAT 不能为空" >&2; exit 1; }

  cat > "$ENV_FILE" <<EOF
# PINWARD 自动化凭据与配置 —— 权限 600，仅 root 可读。
GH_TOKEN=$GH_TOKEN
MINIMAX_API_KEY=$MINIMAX_API_KEY
DEEPSEEK_API_KEY=$DEEPSEEK_API_KEY
MINIMAX_BASE_URL=$MINIMAX_BASE_URL
MINIMAX_MODEL=${MINIMAX_MODEL:-MiniMax-M3}
MINIMAX_MODEL_LONG=${MINIMAX_MODEL_LONG:-MiniMax-M3[1M]}
DEEPSEEK_BASE_URL=${DEEPSEEK_BASE_URL:-https://api.deepseek.com/anthropic}
DEEPSEEK_MODEL=${DEEPSEEK_MODEL:-deepseek-flash}
PINWARD_WEBHOOK_URL=${PINWARD_WEBHOOK_URL:-}
GITHUB_REPO=$GITHUB_REPO
BASE_BRANCH=$BASE_BRANCH
PINWARD_ROOT=$PINWARD_ROOT
MAX_CHILDREN_PER_DAY=5
MAX_IMPLEMENT_SECONDS=5400
MAX_TURNS_IMPLEMENT=40
CLAUDE_TIMEOUT_SECONDS=1800
FEED_HOURS=72
FEED_LIMIT=60
EOF
  chmod 600 "$ENV_FILE"
  chown root:root "$ENV_FILE"
  ok "已写入 $ENV_FILE（600 root:root，MiniMax 端点 $MINIMAX_BASE_URL）"
fi

# Claude Code 两套独立配置目录，避免模型配置互相污染
write_profile() { # <profile> <base-url> <model> <small-model>
  local profile="$1" base="$2" model="$3" small="$4"
  local cfg_dir="/home/$AGENT_USER/.claude-$profile"
  mkdir -p "$cfg_dir"
  cat > "$cfg_dir/settings.json" <<EOF
    {
      "env": {
        "ANTHROPIC_BASE_URL": "$base",
        "ANTHROPIC_MODEL": "$model",
        "ANTHROPIC_SMALL_FAST_MODEL": "$small",
        "ANTHROPIC_DEFAULT_OPUS_MODEL": "$model",
        "ANTHROPIC_DEFAULT_SONNET_MODEL": "$model",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": "$small",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        "API_TIMEOUT_MS": "600000"
      },
      "includeCoAuthoredBy": false
    }
EOF
  cat > "$cfg_dir/.claude.json" <<EOF
    {
      "hasCompletedOnboarding": true,
      "theme": "dark",
      "autoUpdates": false,
      "projects": {
        "$PINWARD_ROOT/app": { "hasTrustDialogAccepted": true, "allowedTools": [] },
        "$PINWARD_ROOT/scratch": { "hasTrustDialogAccepted": true, "allowedTools": [] },
        "$PINWARD_ROOT/worktrees/current": { "hasTrustDialogAccepted": true, "allowedTools": [] }
      }
    }
EOF
  chown -R "$AGENT_USER:$AGENT_USER" "$cfg_dir"
  ok "配置目录 $cfg_dir（$model）"
}

write_profile m3 \
  "${MINIMAX_BASE_URL:-https://api.minimaxi.com/anthropic}" \
  "${MINIMAX_MODEL_LONG:-MiniMax-M3[1M]}" \
  "${MINIMAX_MODEL:-MiniMax-M3}"
write_profile flash \
  "${DEEPSEEK_BASE_URL:-https://api.deepseek.com/anthropic}" \
  "${DEEPSEEK_MODEL:-deepseek-flash}" \
  "${DEEPSEEK_MODEL:-deepseek-flash}"

# git 凭据：让 pinward 用 gh 的 token 推送
GITCONFIG="/home/$AGENT_USER/.gitconfig"
if ! grep -q 'gh auth git-credential' "$GITCONFIG" 2>/dev/null; then
  cat >> "$GITCONFIG" <<'EOF'
[credential "https://github.com"]
	helper = !gh auth git-credential
[user]
	name = pinward-bot
	email = pinward-bot@users.noreply.github.com
[safe]
	directory = *
EOF
  chown "$AGENT_USER:$AGENT_USER" "$GITCONFIG"
  ok "已配置 git 凭据助手"
else
  skip "git 凭据助手已配置"
fi

say "8/9 首次克隆仓库"
mkdir -p "$PINWARD_ROOT/state" "$PINWARD_ROOT/worktrees" "$PINWARD_ROOT/scratch"
if [ -d "$PINWARD_ROOT/app/.git" ]; then
  skip "$PINWARD_ROOT/app 已存在"
else
  git clone --branch "$BASE_BRANCH" "https://github.com/$GITHUB_REPO.git" "$PINWARD_ROOT/app" >/dev/null 2>&1
  ok "已克隆到 $PINWARD_ROOT/app"
fi
chown -R "$AGENT_USER:$AGENT_USER" "$PINWARD_ROOT"
chmod +x "$PINWARD_ROOT/app/ops/bin/pinward" 2>/dev/null || true

say "9/9 防火墙"
if [ "$SETUP_UFW" = "0" ]; then
  skip "按参数要求跳过 ufw"
elif ufw status 2>/dev/null | grep -q "Status: active"; then
  skip "ufw 已启用"
else
  SSH_PORT="$(ss -tlnp 2>/dev/null | awk '/sshd/{print $4}' | sed 's/.*://' | sort -u | head -1)"
  SSH_PORT="${SSH_PORT:-22}"
  apt-get install -y -qq ufw >/dev/null
  ufw --force default deny incoming >/dev/null
  ufw --force default allow outgoing >/dev/null
  ufw allow "$SSH_PORT"/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw --force enable >/dev/null
  ok "ufw 已启用：放行 SSH $SSH_PORT / 443 / 80，其余入站拒绝"
  warn "如果 SSH 端口判断有误（当前识别为 $SSH_PORT），请立刻用七牛 Web 命令行执行：ufw allow <正确端口>/tcp"
fi

say "安装 systemd 定时任务"
bash "$PINWARD_ROOT/app/ops/install.sh"

say "初始化完成"
cat <<EOF
    下一步：
      1. 以 pinward 身份体检：sudo -u $AGENT_USER -H bash -lc 'set -a; . $ENV_FILE; set +a; $PINWARD_ROOT/app/ops/bin/pinward doctor'
      2. 把上面 doctor 的输出整段回贴给我。
      3. 定时器：research 09:00 / split 10:00 / implement 10:30 / verify 11:30（Asia/Singapore）
EOF
