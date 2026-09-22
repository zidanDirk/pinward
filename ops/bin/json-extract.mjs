// 从 LLM 输出中提取第一个可解析的 JSON 值。
//
// 现实中的脏输出（MiniMax [1M] 变体实测会遇到）：
//   1. provider 把推理过程内联进正文：<minimax><thinking>...</thinking>{"title":...}
//   2. 推理正文里出现不成对的 { 或 [，导致「第一个 {」不是真正的 JSON 起点
//   3. 输出被 max output tokens 截断，JSON 括号不配对
//
// stdin: 模型输出的原始文本
// stdout: 规范化 JSON；失败退出 1，并在 stderr 给出可定位的诊断
import { readFileSync } from "node:fs";

let text = readFileSync(0, "utf8");

// 1) 剥离内联推理块与 provider 包装标签
text = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");
text = text.replace(/<thinking>[\s\S]*$/i, ""); // 未闭合 → 后面不可能有完整 JSON
text = text.replace(/<\/?minimax>/gi, "");
text = text.replace(/<\/?reasoning>/gi, "");
// 2) 剥离 markdown 围栏
text = text.replace(/```[a-zA-Z]*\s*/g, "");

/** 从 start 开始找配对结束位置，失败返回 -1 */
function findBalanced(source, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) return i;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

// 3) 逐个候选起点尝试，跳过推理正文里的假起点（限制次数避免大文本下的平方复杂度）
const candidates = [];
for (let i = 0; i < text.length && candidates.length < 20; i += 1) {
  if (text[i] === "{" || text[i] === "[") candidates.push(i);
}

for (const start of candidates) {
  const end = findBalanced(text, start);
  if (end < 0) continue;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    process.stdout.write(JSON.stringify(value));
    process.exit(0);
  } catch {
    // 这个起点不是合法 JSON，继续尝试下一个
  }
}

// 4) 失败时给出能直接定位原因的诊断
const trimmed = text.trim();
const opens = (text.match(/[{[]/g) || []).length;
const closes = (text.match(/[}\]]/g) || []).length;
console.error(
  `json-extract: 未找到可解析的 JSON（文本 ${text.length} 字符，候选起点 ${candidates.length} 个）`,
);
console.error(`json-extract: 括号统计 { [ × ${opens} / } ] × ${closes}${opens === closes ? "" : " —— 不配对，疑似被 max output tokens 截断"}`);
console.error(`json-extract: 末尾 120 字：${trimmed.slice(-120).replace(/\s+/g, " ")}`);
process.exit(1);
