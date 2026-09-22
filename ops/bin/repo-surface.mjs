// 提取各模块的导出符号与类实例字段，供拆分阶段引用**真实存在**的标识符。
//
// 背景：拆分器没有文件读取权限，只能看到文件清单。缺少真实标识符时，它会
// 编出看似合理但不存在的名字（真机踩过：把跨局星币写成 state.coins，而代码里
// 其实是 storage.js 的 profile.stars），并把这个错误前提传给实施 agent。
//
//   node repo-surface.mjs <目录>
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const dir = process.argv[2] ?? "src";

let files;
try {
  files = readdirSync(dir).filter((f) => f.endsWith(".js")).sort();
} catch (error) {
  console.error(`repo-surface: 无法读取目录 ${dir}：${error.message}`);
  process.exit(1);
}

for (const file of files) {
  let code;
  try {
    code = readFileSync(path.join(dir, file), "utf8");
  } catch {
    continue;
  }

  const symbols = new Set();
  for (const match of code.matchAll(
    /^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    symbols.add(match[1]);
  }
  for (const match of code.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of match[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) symbols.add(name);
    }
  }

  const fields = new Set();
  for (const match of code.matchAll(/this\.([A-Za-z_$][\w$]*)\s*=/g)) {
    fields.add(match[1]);
  }

  console.log(`### ${dir}/${file}`);
  console.log(`导出：${[...symbols].join(", ") || "（无）"}`);
  if (fields.size > 0) {
    console.log(`实例字段：${[...fields].sort().join(", ")}`);
  }
  console.log();
}
