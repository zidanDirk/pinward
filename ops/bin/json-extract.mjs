// 从 LLM 输出中提取第一个合法的 JSON 值。
// stdin: 可能包含 markdown 围栏、前后解释文字的文本
// stdout: 规范化后的 JSON；失败时退出码 1
import { readFileSync } from "node:fs";

const text = readFileSync(0, "utf8");

// 去掉 ```json ... ``` 围栏
const cleaned = text.replace(/```[a-zA-Z]*\s*/g, "");

let start = -1;
for (let i = 0; i < cleaned.length; i += 1) {
  if (cleaned[i] === "{" || cleaned[i] === "[") {
    start = i;
    break;
  }
}
if (start < 0) {
  console.error("json-extract: 未找到 JSON 起始字符");
  process.exit(1);
}

let depth = 0;
let inString = false;
let escaped = false;
for (let i = start; i < cleaned.length; i += 1) {
  const ch = cleaned[i];
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
    if (depth === 0) {
      const candidate = cleaned.slice(start, i + 1);
      try {
        process.stdout.write(JSON.stringify(JSON.parse(candidate)));
        process.exit(0);
      } catch (error) {
        console.error(`json-extract: 解析失败 ${error.message}`);
        process.exit(1);
      }
    }
  }
}

console.error("json-extract: JSON 括号不配对");
process.exit(1);
