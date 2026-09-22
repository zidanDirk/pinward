#!/usr/bin/env bash
# PINWARD 自动化公共库。被 ops/bin/pinward source。
# 约定：所有函数使用全局变量，出错即 die（不静默）。

set -euo pipefail

# ---------------------------------------------------------------- 配置

export PINWARD_ROOT="${PINWARD_ROOT:-/opt/pinward}"
export GITHUB_REPO="${GITHUB_REPO:-zidanDirk/pinward}"
export BASE_BRANCH="${BASE_BRANCH:-master}"
export APP_DIR="${APP_DIR:-$PINWARD_ROOT/app}"
export STATE_DIR="${STATE_DIR:-$PINWARD_ROOT/state}"
export WORKTREE_DIR="${WORKTREE_DIR:-$PINWARD_ROOT/worktrees}"
export SCRATCH_DIR="${SCRATCH_DIR:-$PINWARD_ROOT/scratch}"

export RUN_DATE="${RUN_DATE:-$(date +%F)}"
export RUN_DIR="${RUN_DIR:-$STATE_DIR/runs/$RUN_DATE}"
export STATE_FILE="$STATE_DIR/state.json"

# ops/ 目录（本文件所在目录的上级）
PINWARD_OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PINWARD_OPS_DIR

export DRY_RUN="${DRY_RUN:-0}"
export LOG_PREFIX="${LOG_PREFIX:-pinward}"

# 每日熔断
export MAX_CHILDREN_PER_DAY="${MAX_CHILDREN_PER_DAY:-5}"
export MAX_IMPLEMENT_SECONDS="${MAX_IMPLEMENT_SECONDS:-5400}"
export MAX_TURNS_IMPLEMENT="${MAX_TURNS_IMPLEMENT:-40}"
export MAX_TURNS_TEXT="${MAX_TURNS_TEXT:-10}"
export CLAUDE_TIMEOUT_SECONDS="${CLAUDE_TIMEOUT_SECONDS:-1800}"
export PINWARD_BYPASS_PERMISSIONS="${PINWARD_BYPASS_PERMISSIONS:-0}"

# 人工标签（你维护）
export LABEL_PENDING="未审核"
export LABEL_APPROVED="同意实现"
export LABEL_HOLD="挂起"
export LABEL_REJECT="拒绝"
# 机器标签（脚本维护）
export LABEL_CHILD="子任务"
export LABEL_SPLIT="已拆分"
export LABEL_FAILED="AI失败"
export LABEL_RUNNING="AI实现中"

mkdir -p "$STATE_DIR" "$RUN_DIR" "$WORKTREE_DIR" "$SCRATCH_DIR"
[ -f "$STATE_FILE" ] || echo '{}' > "$STATE_FILE"

# ---------------------------------------------------------------- 日志

log()  { printf '%s [%s] %s\n' "$(date '+%F %T')" "$LOG_PREFIX" "$*" >&2; }
warn() { printf '%s [%s] WARN %s\n' "$(date '+%F %T')" "$LOG_PREFIX" "$*" >&2; }
die()  { printf '%s [%s] ERROR %s\n' "$(date '+%F %T')" "$LOG_PREFIX" "$*" >&2; exit 1; }

require_cmd() {
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "缺少命令：$c"
  done
}

# 带超时执行；把 stdout 写到 $2
with_timeout() { # <seconds> <outfile> <cmd...>
  local secs="$1" out="$2"; shift 2
  if command -v timeout >/dev/null 2>&1; then
    timeout --signal=TERM --kill-after=30 "$secs" "$@" >"$out" 2>>"${LOG_FILE:-/dev/stderr}"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout --signal=TERM --kill-after=30 "$secs" "$@" >"$out" 2>>"${LOG_FILE:-/dev/stderr}"
  else
    "$@" >"$out" 2>>"${LOG_FILE:-/dev/stderr}"
  fi
}

# ---------------------------------------------------------------- 锁

take_lock() {
  exec 9>"$STATE_DIR/pinward.lock"
  if ! flock -w "${LOCK_WAIT_SECONDS:-600}" 9; then
    warn "等待锁超时（${LOCK_WAIT_SECONDS:-600}s），本次跳过（已有实例长时间运行）"
    mkdir -p "$RUN_DIR"
    date '+%F %T 跳过：锁超时' >> "$RUN_DIR/skipped.log"
    echo "SKIPPED: 锁超时"
    exit 0
  fi
}

# ---------------------------------------------------------------- 状态

state_get() { jq -r --arg k "$1" '.[$k] // empty' "$STATE_FILE" 2>/dev/null; }

state_put() { # <key> <json-value>
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  if jq -e . "$STATE_FILE" >/dev/null 2>&1; then
    jq --arg k "$key" --argjson v "$value" '.[$k] = $v' "$STATE_FILE" >"$tmp"
  else
    echo '{}' | jq --arg k "$key" --argjson v "$value" '.[$k] = $v' >"$tmp"
  fi
  mv "$tmp" "$STATE_FILE"
}

state_key_issue() { printf 'issue:%s' "$1"; }

# ---------------------------------------------------------------- GitHub

ghq() { gh "$@"; }

issue_labels() { # <json-issue> -> 逗号分隔标签
  printf '%s' "$1" | jq -r '[.labels[].name] | join(",")'
}

has_label() { # <json-issue> <label>
  printf '%s' "$1" | jq -e --arg l "$2" 'any(.labels[]; .name == $l)' >/dev/null 2>&1
}

list_issues() { # <label> -> json array
  ghq issue list -R "$GITHUB_REPO" --label "$1" --state open --limit 100 \
    --json number,title,body,labels,createdAt,url
}

pr_body_for_issue() { # <issue-number>
  ghq pr list -R "$GITHUB_REPO" --state all --search "#$1 in:body" --limit 5 \
    --json number,url,state 2>/dev/null || echo '[]'
}

# ---------------------------------------------------------------- Git

git_auth_check() {
  [ -n "${GH_TOKEN:-}" ] || die "GH_TOKEN 未设置（见 /etc/pinward/agent.env）"
}

sync_app() {
  [ -d "$APP_DIR/.git" ] || die "应用目录未初始化：$APP_DIR（先执行 ops/install.sh）"
  log "同步仓库：$APP_DIR -> origin/$BASE_BRANCH"
  git -C "$APP_DIR" fetch --prune origin
  git -C "$APP_DIR" checkout -f -B "$BASE_BRANCH" "origin/$BASE_BRANCH" >/dev/null 2>&1
  git -C "$APP_DIR" reset --hard "origin/$BASE_BRANCH" >/dev/null
  git -C "$APP_DIR" clean -fdx -e node_modules >/dev/null
  git -C "$APP_DIR" worktree prune
}

default_branch_guard() { # <branch> —— 双保险，禁止推默认分支
  [ "$1" != "$BASE_BRANCH" ] || die "拒绝推送默认分支：$1"
  [ "$1" != "main" ] || die "拒绝推送 main 分支"
}

slugify() {
  printf '%s' "$1" \
    | sed -e 's/\[子任务\]//g' \
    | tr '[:upper:]' '[:lower:]' \
    | tr -cd 'a-z0-9' \
    | cut -c1-24
}

# ---------------------------------------------------------------- Claude Code

CLAUDE_ALLOWED_CODE_TOOLS=(
  "Read" "Write" "Edit" "Glob" "Grep" "TodoWrite"
  "Bash(node:*)" "Bash(npm:*)" "Bash(npx:*)"
  "Bash(git status:*)" "Bash(git diff:*)" "Bash(git log:*)" "Bash(git show:*)"
  "Bash(git add:*)" "Bash(git commit:*)" "Bash(git switch:*)" "Bash(git checkout:*)"
  "Bash(git stash:*)" "Bash(git rm:*)"
  "Bash(ls:*)" "Bash(cat:*)" "Bash(head:*)" "Bash(tail:*)" "Bash(wc:*)" "Bash(grep:*)"
  "Bash(mkdir:*)" "Bash(cp:*)" "Bash(mv:*)" "Bash(rm:*)"
)

claude_profile_env() { # <m3|flash> —— 输出 KEY=VALUE 行
  case "$1" in
    m3)
      cat <<EOF
ANTHROPIC_BASE_URL=${MINIMAX_BASE_URL:-https://api.minimax.io/anthropic}
ANTHROPIC_AUTH_TOKEN=${MINIMAX_API_KEY:-}
ANTHROPIC_MODEL=${MINIMAX_MODEL:-MiniMax-M3}
ANTHROPIC_DEFAULT_OPUS_MODEL=${MINIMAX_MODEL_LONG:-MiniMax-M3[1M]}
ANTHROPIC_DEFAULT_SONNET_MODEL=${MINIMAX_MODEL_LONG:-MiniMax-M3[1M]}
ANTHROPIC_DEFAULT_HAIKU_MODEL=${MINIMAX_MODEL:-MiniMax-M3}
ANTHROPIC_SMALL_FAST_MODEL=${MINIMAX_MODEL:-MiniMax-M3}
CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000
CLAUDE_CODE_MAX_OUTPUT_TOKENS=${MINIMAX_MAX_OUTPUT_TOKENS:-32000}
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
API_TIMEOUT_MS=600000
CLAUDE_CONFIG_DIR=$HOME/.claude-m3
EOF
      ;;
    flash)
      cat <<EOF
ANTHROPIC_BASE_URL=${DEEPSEEK_BASE_URL:-https://api.deepseek.com/anthropic}
$(if [ "${DEEPSEEK_AUTH_STYLE:-key}" = "token" ]; then
      echo "ANTHROPIC_AUTH_TOKEN=${DEEPSEEK_API_KEY:-}"
    else
      echo "ANTHROPIC_API_KEY=${DEEPSEEK_API_KEY:-}"
    fi)
ANTHROPIC_MODEL=${DEEPSEEK_MODEL:-deepseek-flash}
ANTHROPIC_SMALL_FAST_MODEL=${DEEPSEEK_MODEL:-deepseek-flash}
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
API_TIMEOUT_MS=600000
CLAUDE_CONFIG_DIR=$HOME/.claude-flash
EOF
      ;;
    *) die "未知模型档位：$1" ;;
  esac
}

# run_claude <m3|flash> <workdir> <prompt-file> <text|code> <max-turns> <envelope-out>
run_claude() {
  local profile="$1" workdir="$2" prompt_file="$3" mode="${4:-text}"
  local max_turns="${5:-$MAX_TURNS_TEXT}" out="$6"

  command -v claude >/dev/null 2>&1 || die "未找到 claude 命令"
  [ -f "$prompt_file" ] || die "提示词文件不存在：$prompt_file"

  local -a profile_env=()
  while IFS= read -r line; do profile_env+=("$line"); done < <(claude_profile_env "$profile")

  # 显式 --model：MiniMax 文档只保证 AUTH_TOKEN/BASE_URL 优先于 settings.json，
  # ANTHROPIC_MODEL 会被 settings.json 覆盖（真机踩过：以为在用 MiniMax-M3，
  # 实际跑的是 [1M] 变体）。CLI 参数优先级最高，不受配置文件影响。
  local model_name
  model_name="$(printf '%s\n' "${profile_env[@]}" | sed -n 's/^ANTHROPIC_MODEL=//p' | head -1)"
  local -a mode_args=(--max-turns "$max_turns")
  [ -n "$model_name" ] && mode_args+=(--model "$model_name")
  if [ "$mode" = "code" ]; then
    if [ "$PINWARD_BYPASS_PERMISSIONS" = "1" ]; then
      mode_args+=(--dangerously-skip-permissions)
    else
      mode_args+=(--permission-mode acceptEdits --allowedTools "${CLAUDE_ALLOWED_CODE_TOOLS[@]}")
    fi
  else
    mode_args+=(--disallowedTools "Bash,Write,Edit,NotebookEdit,WebFetch,WebSearch,Task")
  fi

  log "claude[$profile/$mode] cwd=$workdir turns=$max_turns"
  # 关键：剥离 GitHub 凭据，实施 agent 不持有仓库写权限
  (
    cd "$workdir"
    with_timeout "$CLAUDE_TIMEOUT_SECONDS" "$out" \
      env -u GH_TOKEN -u GITHUB_TOKEN \
      "NODE_OPTIONS=${NODE_OPTIONS:---max-old-space-size=1024}" \
      "${profile_env[@]}" \
      claude -p "$(cat "$prompt_file")" --output-format json "${mode_args[@]}"
  ) || {
    warn "claude[$profile] 非零退出，envelope：$out"
    dump_envelope "$out"
    return 1
  }

  # 记录用量
  if [ -s "$out" ]; then
    jq -c '{usage: .usage, duration_ms: .duration_ms, num_turns: .num_turns, is_error: .is_error}' \
      "$out" >>"$RUN_DIR/claude-usage.jsonl" 2>/dev/null || true
  fi

  # Claude Code 在 API 出错时仍可能以 0 退出，必须显式检查 envelope，
  # 否则会退化成「调用成功但输出为空」这种最难查的失败。
  if [ "$(jq -r '.is_error // false' "$out" 2>/dev/null)" = "true" ]; then
    warn "claude[$profile] 模型侧返回错误"
    dump_envelope "$out"
    return 1
  fi
  if [ "$mode" != "code" ] && [ -z "$(jq -r '.result // empty' "$out" 2>/dev/null)" ]; then
    warn "claude[$profile] 返回内容为空（subtype=$(jq -r '.subtype // "?"' "$out" 2>/dev/null)）"
    dump_envelope "$out"
    return 1
  fi
  return 0
}

# 打印 envelope 的关键诊断信息，便于在没有 SSH 的机器上远程定位
dump_envelope() { # <envelope-json>
  local f="$1"
  if [ ! -f "$f" ]; then
    warn "  envelope 不存在：$f"
    return 0
  fi
  warn "  envelope：$(wc -c < "$f" | tr -d ' ') 字节 | subtype=$(jq -r '.subtype // "?"' "$f" 2>/dev/null) | is_error=$(jq -r '.is_error // "?"' "$f" 2>/dev/null) | api_error_status=$(jq -r '.api_error_status // "-"' "$f" 2>/dev/null) | num_turns=$(jq -r '.num_turns // "-"' "$f" 2>/dev/null) | result 长度=$(jq -r '(.result // "") | length' "$f" 2>/dev/null)"
  {
    printf '\n----- result 前 600 字 -----\n'
    jq -r '.result // "(没有 result 字段)"' "$f" 2>/dev/null | head -c 600
    printf '\n-----------------------------\n'
  } >&2
}

claude_result() { # <envelope-file> —— 打印 .result 文本
  jq -r '.result // empty' "$1"
}

sibling_branches() { # <parent-number> <current-number> —— 同父 issue 中序号更小、已实现的分支，按序输出
  jq -r --argjson p "$1" --argjson c "$2" '
    to_entries
    | map(select(.value.parent == $p and .value.stage == "pr_open" and (.value.branch // "") != ""))
    | map({ n: (.key | sub("^issue:"; "") | tonumber), b: .value.branch })
    | sort_by(.n)
    | .[] | select(.n < $c) | .b
  ' "$STATE_FILE" 2>/dev/null || true
}

parent_of_issue() { # <issue-json> —— 从子 issue 正文里的 pinward-parent 标记取父号
  printf '%s' "$1" | jq -r '.body // ""' | sed -n 's/.*pinward-parent:\([0-9][0-9]*\).*/\1/p' | head -1
}

# 查询某个子 issue 是否已有 PR。
# 用 headRefName 前缀精确匹配，而不是 GitHub 搜索 —— 搜索是模糊的、会受索引与
# 令牌影响，且失败时的输出不可信（真机踩过：gh 往 stdout 写噪声后失败，
# 被误判成「已有 PR」而静默跳过）。
# 返回：0 且 stdout 为 PR 号或空串 = 查询成功；非 0 = 查询不可用，调用方应继续执行。
pr_for_issue() { # <issue-number>
  local n="$1" raw
  raw="$(ghq pr list -R "$GITHUB_REPO" --state all --limit 200 --json number,headRefName 2>/dev/null || true)"
  if ! printf '%s' "$raw" | jq -e 'type == "array"' >/dev/null 2>&1; then
    return 1
  fi
  printf '%s' "$raw" | jq -r --arg p "ai/$n-" '[.[] | select(.headRefName | startswith($p))] | (.[0].number // empty)'
  return 0
}

# 统计今天是否已经建过「每日资讯」issue。
# 同样不用搜索：拉回标题列表本地过滤，输出必须是纯数字，否则返回非 0 让调用方继续创建。
research_issue_count() { # <date>
  local d="$1" raw count
  raw="$(ghq issue list -R "$GITHUB_REPO" --state all --limit 200 --json number,title 2>/dev/null || true)"
  if ! printf '%s' "$raw" | jq -e 'type == "array"' >/dev/null 2>&1; then
    return 1
  fi
  count="$(printf '%s' "$raw" | jq -r --arg d "$d" '[.[] | select(.title | startswith("「每日资讯」" + $d))] | length')"
  printf '%s' "$count" | grep -qE '^[0-9]+$' || return 1
  printf '%s' "$count"
  return 0
}

# ---------------------------------------------------------------- 校验

# 校验 issue 正文/PR 正文是否触碰受保护路径
protected_paths_violation() { # <file-list-file> —— 打印违规行，无违规则无输出
  grep -E '^(ops/|\.github/|CLAUDE\.md$)' "$1" || true
}

notify_failure() {
  local subject="$1" body="$2"
  [ -n "${PINWARD_WEBHOOK_URL:-}" ] || return 0
  curl -fsS -m 15 -X POST "$PINWARD_WEBHOOK_URL" \
    -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg s "$subject" --arg b "$body" '{subject:$s, body:$b}')" \
    >/dev/null 2>&1 || warn "webhook 通知失败"
  return 0
}
