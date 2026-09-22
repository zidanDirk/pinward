#!/usr/bin/env bash
# PINWARD 自动化本地冒烟测试：不联网、不碰 GitHub，验证解析与校验逻辑。
#
#   bash ops/tests/smoke.sh
set -uo pipefail

OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0

check() { # <描述> <期望:ok|fail> <实际退出码>
  if [ "$2" = "ok" ] && [ "$3" = "0" ]; then
    printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass + 1))
  elif [ "$2" = "fail" ] && [ "$3" != "0" ]; then
    printf '  \033[32m✓\033[0m %s（按预期拒绝）\n' "$1"; pass=$((pass + 1))
  else
    printf '  \033[31m✗\033[0m %s（期望 %s，实际退出码 %s）\n' "$1" "$2" "$3"; fail=$((fail + 1))
  fi
}

echo "== json-extract =="
printf '```json\n{"a":1}\n```\n' | node "$OPS_DIR/bin/json-extract.mjs" > "$TMP/a.json" 2>/dev/null
check "去掉围栏" ok $?
printf '先说明一段话。\n[{"b":2}]\n后面还有话' | node "$OPS_DIR/bin/json-extract.mjs" > "$TMP/b.json" 2>/dev/null
check "截取数组" ok $?
[ "$(cat "$TMP/a.json")" = '{"a":1}' ]; check "输出规范化" ok $?
printf '没有任何 JSON' | node "$OPS_DIR/bin/json-extract.mjs" >/dev/null 2>&1
check "无 JSON 时报错" fail $?

echo "== json-extract 脏输出（真机踩过的形态）=="
printf '<minimax><thinking>I should output JSON. Here is a stray brace { in prose.</thinking>{"a":1}</minimax>' \
  | node "$OPS_DIR/bin/json-extract.mjs" > "$TMP/c.json" 2>/dev/null
check "剥离 <minimax>/<thinking> 内联推理" ok $?
[ "$(cat "$TMP/c.json")" = '{"a":1}' ]; check "剥离后内容正确" ok $?

printf 'Let me think. Maybe {"broken": tru} then the real one {"ok":true}' \
  | node "$OPS_DIR/bin/json-extract.mjs" > "$TMP/d.json" 2>/dev/null
check "跳过推理里的假 JSON 起点" ok $?
[ "$(cat "$TMP/d.json")" = '{"ok":true}' ]; check "取到真正可解析的那个" ok $?

printf '{"title":"abc","body":"unterminated' | node "$OPS_DIR/bin/json-extract.mjs" >/dev/null 2>&1
check "被截断的输出仍然报错" fail $?

# 注意：smoke.sh 开了 pipefail，node 的非零退出会污染管道状态，这里先落盘再 grep
printf '{"title":"abc","body":"unterminated' \
  | node "$OPS_DIR/bin/json-extract.mjs" >"$TMP/trunc.out" 2>"$TMP/trunc.err" || true
grep -q "截断" "$TMP/trunc.err"
check "截断诊断里点明 max output tokens" ok $?

echo "== digest 样本 =="
cat > "$TMP/digest.json" <<'EOF'
{"items":[
  {"title":"Game feel 技巧","url":"https://example.com/feel","source":"GN","published":"2026-04-12","summary":"..."},
  {"title":"Roguelike 设计","url":"https://example.com/rogue","source":"GN","published":"2026-04-12","summary":"..."}
]}
EOF

cat > "$TMP/research-ok.json" <<'EOF'
{
  "title": "用命中停顿强化弹球打击感",
  "summary": "引入 40ms 命中停顿与屏幕震动，提升反馈强度",
  "body_markdown": "## 背景观察\n\n近一周多篇关于 game feel 的讨论都指向同一个结论：玩家对「打中了」的感知主要来自命中瞬间的停顿、位移与音效对齐，而不是特效数量。PINWARD 目前的弹球命中只有一次闪白，缺少时间维度的反馈，命中重型怪物和普通怪物在体感上几乎没有差别。\n\n## 建议\n\n### 1. 命中停顿与轻微震动\n\n- 现状：弹球击中任何怪物都是同样的闪白，没有停顿\n- 改动：命中瞬间冻结 40ms，叠加 2px 方向性震动，重型反弹器加重到 70ms\n- 预期收益：打击感显著增强，补上弹珠类游戏最核心的爽点\n\n### 2. 命中音效分层\n\n- 现状：六种反弹器共用一套命中音\n- 改动：按反弹器类型给合成音叠加不同泛音与衰减\n- 预期收益：听觉上能分辨构筑，提升正反馈密度\n\n## 优先级与工作量\n\n优先做第 1 条，工作量 M；第 2 条可放同一次改动，工作量 S。\n\n## 风险\n\n停顿会改变每帧的模拟步进，必须确认物理测试的确定性不受影响，建议补充固定种子用例。",
  "evidence": [
    { "url": "https://example.com/feel", "why": "说明命中停顿能显著提升反馈" },
    { "url": "https://example.com/rogue?utm=1", "why": "说明 roguelike 反馈节奏的重要性" }
  ],
  "impact": { "fun": "高", "ui": "低", "playability": "中", "vfx": "高", "cost": "M" }
}
EOF
node "$OPS_DIR/bin/validate.mjs" research "$TMP/research-ok.json" "$TMP/digest.json" >/dev/null 2>&1
check "research 合法样本通过" ok $?

jq '.evidence[1].url = "https://fabricated.example.net/made-up"' "$TMP/research-ok.json" > "$TMP/research-bad.json"
node "$OPS_DIR/bin/validate.mjs" research "$TMP/research-bad.json" "$TMP/digest.json" >/dev/null 2>&1
check "research 编造来源被拒绝" fail $?

jq 'del(.impact.vfx)' "$TMP/research-ok.json" > "$TMP/research-bad2.json"
node "$OPS_DIR/bin/validate.mjs" research "$TMP/research-bad2.json" "$TMP/digest.json" >/dev/null 2>&1
check "research 缺字段被拒绝" fail $?

cat > "$TMP/split-ok.json" <<'EOF'
[
  {
    "title": "[子任务] 加入命中停顿与震动",
    "body_markdown": "## 目标\n\n弹球命中怪物的瞬间加入 40ms 时间冻结与 2px 方向性震动，让打击感有明确的时间反馈。\n\n## 具体改动\n\n在 `src/renderer.js` 的命中回调里引入一个极短的命中停顿计时器，冻结期间跳过位置积分但继续绘制；震动按命中方向给画布叠加位移，重型反弹器使用更长的 70ms 停顿。\n\n## 实现要点\n\n停顿必须通过主循环的 accumulator 实现，不要直接修改 physics.js 的常数，以免破坏现有物理测试的确定性。",
    "acceptance": ["命中后 40ms 内位置冻结", "现有 76 项测试仍全绿"],
    "files": ["src/renderer.js", "tests/game.test.js"],
    "size": "S",
    "notes": ""
  },
  {
    "title": "[子任务] 命中特效粒子回收",
    "body_markdown": "## 目标\n\n控制命中粒子的总数量，避免长时间对局后粒子堆积导致掉帧。\n\n## 具体改动\n\n在 `src/renderer.js` 的粒子池里加入数量上限与最旧优先回收逻辑，超过上限时复用最早的粒子对象，避免每帧新建对象造成 GC 抖动。\n\n## 实现要点\n\n上限值写成模块常量，便于后续调整；回收逻辑不得改变现有粒子的绘制顺序。",
    "acceptance": ["粒子数不超过 200", "帧时间不高于基线 10%"],
    "files": ["src/renderer.js"],
    "size": "S",
    "notes": "与第一个子任务同改 renderer.js，需注意先后顺序"
  }
]
EOF
node "$OPS_DIR/bin/validate.mjs" split "$TMP/split-ok.json" --max 5 >/dev/null 2>&1
check "split 合法样本通过（含文件重叠警告）" ok $?

jq '.[0].files = ["ops/bin/pinward"]' "$TMP/split-ok.json" > "$TMP/split-bad.json"
node "$OPS_DIR/bin/validate.mjs" split "$TMP/split-bad.json" --max 5 >/dev/null 2>&1
check "split 触碰受保护路径被拒绝" fail $?

jq '.[0].acceptance = []' "$TMP/split-ok.json" > "$TMP/split-bad2.json"
node "$OPS_DIR/bin/validate.mjs" split "$TMP/split-bad2.json" --max 5 >/dev/null 2>&1
check "split 缺验收标准被拒绝" fail $?

node "$OPS_DIR/bin/validate.mjs" split "$TMP/split-ok.json" --max 1 >/dev/null 2>&1
check "split 超过数量上限被拒绝" fail $?

echo "== 脚本可解析性 =="
bash -n "$OPS_DIR/bin/pinward"; check "pinward 语法" ok $?
bash -n "$OPS_DIR/bin/lib.sh"; check "lib.sh 语法" ok $?
bash -n "$OPS_DIR/bootstrap.sh"; check "bootstrap.sh 语法" ok $?
bash -n "$OPS_DIR/install.sh"; check "install.sh 语法" ok $?

echo "== shellcheck（如已安装）=="
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck -S warning "$OPS_DIR/bin/pinward" "$OPS_DIR/bin/lib.sh" >/dev/null 2>&1
  check "shellcheck" ok $?
else
  printf '  \033[90m· 未安装 shellcheck，跳过\033[0m\n'
fi

echo
printf '结果：\033[32m%s 通过\033[0m，\033[31m%s 失败\033[0m\n' "$pass" "$fail"
[ "$fail" = "0" ] && echo "SMOKE OK" || echo "SMOKE FAILED"
exit "$fail"
