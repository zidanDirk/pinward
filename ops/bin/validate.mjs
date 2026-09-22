// 校验 LLM 产出的结构化数据，不通过则退出码 1（stderr 打印原因）。
//
//   node validate.mjs research <payload.json> <digest.json>
//   node validate.mjs split    <payload.json> [--max N]
import { readFileSync } from "node:fs";

const [kind, file, extra] = process.argv.slice(2);
const errors = [];
const warnings = [];

function fail(message) {
  errors.push(message);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(`validate: 无法读取 JSON ${path}：${error.message}`);
    process.exit(1);
  }
}

const PROTECTED = /^(ops\/|\.github\/|CLAUDE\.md$)/;

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return `${url.origin}${url.pathname}`.replace(/\/$/, "");
  } catch {
    return null;
  }
}

function validateResearch(payload, digest) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return fail("research 结果必须是 JSON 对象");
  }
  const title = payload.title;
  if (typeof title !== "string" || title.trim().length < 6 || title.length > 60) {
    fail(`title 必须是 6-60 字符的字符串（当前：${JSON.stringify(title)}）`);
  }
  const body = payload.body_markdown;
  if (typeof body !== "string" || body.length < 300) {
    fail(`body_markdown 至少 300 字符（当前 ${typeof body === "string" ? body.length : 0}）`);
  } else if (!/^##\s/m.test(body)) {
    fail("body_markdown 必须包含至少一个二级标题");
  } else if (!/验收|预期|收益/.test(body)) {
    warnings.push("body_markdown 里没有出现「验收/预期/收益」，可能缺少可判断的收益描述");
  }

  const digestItems = Array.isArray(digest) ? digest : Array.isArray(digest?.items) ? digest.items : [];
  const known = new Set(digestItems.map((item) => normalizeUrl(item?.url)).filter(Boolean));
  const evidence = payload.evidence;
  if (!Array.isArray(evidence) || evidence.length < 2) {
    fail("evidence 至少需要 2 条");
  } else {
    let grounded = 0;
    for (const [index, item] of evidence.entries()) {
      if (typeof item?.url !== "string" || !item.url.startsWith("http")) {
        fail(`evidence[${index}].url 不是合法链接`);
        continue;
      }
      if (typeof item?.why !== "string" || item.why.trim().length < 4) {
        fail(`evidence[${index}].why 过短`);
      }
      const normalized = normalizeUrl(item.url);
      if (known.size === 0 || (normalized && known.has(normalized))) grounded += 1;
    }
    if (known.size > 0 && grounded < 2) {
      fail(`evidence 中只有 ${grounded} 条链接来自今日采集结果，存在编造来源的嫌疑`);
    }
  }

  const impact = payload.impact;
  if (typeof impact !== "object" || impact === null) {
    fail("缺少 impact 对象");
  } else {
    for (const key of ["fun", "ui", "playability", "vfx", "cost"]) {
      if (typeof impact[key] !== "string" || impact[key].trim() === "") {
        fail(`impact.${key} 缺失或为空`);
      }
    }
  }
}

function validateSplit(payload, max) {
  if (!Array.isArray(payload)) return fail("split 结果必须是 JSON 数组");
  if (payload.length < 1) return fail("split 结果为空数组");
  if (payload.length > max) fail(`子任务数量 ${payload.length} 超过上限 ${max}`);

  const titles = new Set();
  const fileOwners = new Map();
  payload.forEach((child, index) => {
    const at = `[${index}]`;
    if (typeof child?.title !== "string" || child.title.trim().length < 4) {
      fail(`${at}.title 缺失或过短`);
    } else {
      if (child.title.length > 80) fail(`${at}.title 超过 80 字符`);
      if (/每日资讯/.test(child.title)) fail(`${at}.title 不得沿用父 issue 的标题前缀`);
      if (titles.has(child.title)) fail(`${at}.title 与其它子任务重复`);
      titles.add(child.title);
    }
    if (typeof child?.body_markdown !== "string" || child.body_markdown.length < 120) {
      fail(`${at}.body_markdown 至少 120 字符`);
    }
    if (!Array.isArray(child?.acceptance) || child.acceptance.length < 1) {
      fail(`${at}.acceptance 至少需要 1 条可验证的验收标准`);
    } else if (child.acceptance.some((line) => typeof line !== "string" || line.trim().length < 4)) {
      fail(`${at}.acceptance 存在空项`);
    }
    if (!Array.isArray(child?.files) || child.files.length < 1) {
      fail(`${at}.files 至少需要 1 个建议改动文件`);
    } else {
      for (const file of child.files) {
        if (typeof file !== "string" || file.trim() === "") {
          fail(`${at}.files 存在空项`);
          continue;
        }
        if (PROTECTED.test(file)) fail(`${at}.files 包含受保护路径：${file}`);
        if (!fileOwners.has(file)) fileOwners.set(file, []);
        fileOwners.get(file).push(index);
      }
    }
  });

  for (const [file, owners] of fileOwners) {
    if (owners.length > 1) {
      warnings.push(`文件 ${file} 被多个子任务同时改动（${owners.join(",")}），可能导致 PR 冲突`);
    }
  }
}

if (!kind || !file) {
  console.error("用法：validate.mjs research <payload.json> <digest.json> | validate.mjs split <payload.json> [--max N]");
  process.exit(1);
}

const payload = readJson(file);

if (kind === "research") {
  validateResearch(payload, readJson(process.argv[4]));
} else if (kind === "split") {
  const maxArg = extra === "--max" ? Number(process.argv[5]) : 5;
  validateSplit(payload, Number.isFinite(maxArg) && maxArg > 0 ? maxArg : 5);
} else {
  console.error(`validate: 未知类型 ${kind}`);
  process.exit(1);
}

for (const message of warnings) console.error(`validate: 警告：${message}`);
if (errors.length > 0) {
  for (const message of errors) console.error(`validate: 不通过：${message}`);
  process.exit(1);
}
console.log(`validate: ${kind} 校验通过${warnings.length ? `（${warnings.length} 条警告）` : ""}`);
