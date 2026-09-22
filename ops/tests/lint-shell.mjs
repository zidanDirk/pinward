// 静态检查：$VAR 紧跟多字节字符时必须写成 ${VAR}。
//
// 原因：bash 3.2（macOS 自带）会把紧跟其后的多字节字节序列算进变量名，
// 导致展开结果被破坏；开启 set -u 时还会直接报 unbound variable。
// 服务器是 bash 5.2 不受影响，但这会让"本机先验证"这条路彻底失效 ——
// 真机踩过：warn "「$LABEL_RUNNING」…" 直接让整次运行只剩一行错误输出。
//
//   node ops/tests/lint-shell.mjs [文件...]
import { readFileSync } from "node:fs";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("用法：node lint-shell.mjs <文件...>");
  process.exit(2);
}

const ID_START = /[A-Za-z_]/;
const ID_BODY = /[A-Za-z0-9_]/;
let problems = 0;

for (const file of files) {
  let buf;
  try {
    buf = readFileSync(file);
  } catch {
    continue;
  }
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] !== 0x24) continue; // '$'
    let j = i + 1;
    if (j >= buf.length || !ID_START.test(String.fromCharCode(buf[j]))) continue;
    while (j < buf.length && ID_BODY.test(String.fromCharCode(buf[j]))) j += 1;
    if (j < buf.length && buf[j] >= 0x80) {
      const line = buf.subarray(0, i).toString("utf8").split("\n").length;
      const snippet = buf.subarray(i, Math.min(j + 10, buf.length)).toString("utf8").split("\n")[0];
      console.error(`  ${file}:${line}  应写成 \${...}：${snippet}`);
      problems += 1;
    }
  }
}

if (problems > 0) {
  console.error(`lint-shell: 发现 ${problems} 处未加花括号的多字节相邻展开`);
  process.exit(1);
}
console.log("lint-shell: OK");
