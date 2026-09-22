#!/usr/bin/env bash
# 配置 GitHub 侧的分支保护（幂等，可反复执行）。
#
# 在仓库所有者的机器上执行即可（需要 repo 权限的 gh 登录，或带 Administration 的 token）：
#   bash ops/setup-github.sh
#
# 注意：服务器上的 fine-grained PAT **不需要** Administration 权限，这个脚本只在
# 初始化或策略变更时手动跑一次。
set -euo pipefail

GITHUB_REPO="${GITHUB_REPO:-zidanDirk/pinward}"
BASE_BRANCH="${BASE_BRANCH:-master}"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()  { printf '    \033[32m✓\033[0m %s\n' "$*"; }
warn(){ printf '    \033[33m! %s\033[0m\n' "$*"; }

[ -n "${GH_TOKEN:-}" ] || GH_TOKEN="$(gh auth token 2>/dev/null || true)"
[ -n "${GH_TOKEN:-}" ] || { echo "需要 GH_TOKEN 或已登录的 gh" >&2; exit 1; }
export GH_TOKEN
command -v gh >/dev/null 2>&1 || { echo "需要 gh" >&2; exit 1; }

say "分支保护：$GITHUB_REPO / $BASE_BRANCH"
# 说明：
#  - required_approving_review_count = 0：强制走 PR，但因为 AI PR 的作者就是 PAT 所有者，
#    要求 approve 会导致无法自审通过，所以把「人工合并」这个动作本身作为闸门。
#  - strict = false：不要求每个 PR 都 rebase 到最新，否则串行 5 个 PR 会互相作废，
#    冲突改由 pinward verify 的集成试合并提前暴露。
#  - enforce_admins = true：管理员也不能直推，机器与人都必须走 PR。
if gh api -X PUT "repos/$GITHUB_REPO/branches/$BASE_BRANCH/protection" --input - >/tmp/pinward-protection.json 2>/tmp/pinward-protection.err <<'JSON'
{
  "required_status_checks": { "strict": false, "contexts": ["test"] },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": false,
    "require_code_owner_reviews": false
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": false,
  "lock_branch": false
}
JSON
then
  jq -r '"    要求 PR：\(.required_pull_request_reviews != null)\n    必需检查：\(.required_status_checks.contexts | join(","))\n    管理员也受限：\(.enforce_admins.enabled)\n    允许强推：\(.allow_force_pushes.enabled)"' /tmp/pinward-protection.json 2>/dev/null || true
  ok "分支保护已生效"
else
  warn "设置失败：$(cat /tmp/pinward-protection.err)"
  warn "常见原因：PAT 缺少 Administration: write 权限，或仓库为私有且套餐不含保护功能"
  exit 1
fi

say "校验：直接推 master 应当被拒绝"
if git ls-remote "https://github.com/$GITHUB_REPO.git" "$BASE_BRANCH" >/dev/null 2>&1; then
  ok "远端可读（真正的拒绝会在 push 时返回 protected branch 错误）"
fi

say "完成"
