#!/usr/bin/env node
/**
 * Pinward 资讯采集器 —— 零依赖（只用 Node 22 内置能力）
 *
 * 用法：
 *   node collect.mjs --out <目录> [--date YYYY-MM-DD] [--hours 24] [--limit 60]
 *                    [--sources <file>] [--self-test] [--verbose]
 *
 * 设计约束：
 *   - 零 npm 依赖：只用 node:fs / node:path / 全局 fetch / AbortSignal.timeout / setTimeout。
 *   - 只读网络，只写 --out 目录；不写仓库其他位置，不调用 git。
 *   - 单个源失败绝不影响整体（Promise.allSettled）。
 *   - ESM，node --check 必须通过。
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

const SCRIPT_DIR = import.meta.dirname;
const DEFAULT_SOURCES_FILE = path.join(SCRIPT_DIR, 'sources.json');
const FIXTURES_DIR = path.join(SCRIPT_DIR, 'fixtures');
const USER_AGENT = 'pinward-news-bot/1.0 (news collector for a pinball roguelike tower-defense web game)';

/** digest.md 的字符上限（给 LLM 读，不能太大） */
const MAX_MD_CHARS = 8000;
/** 单条摘要的字符上限，按完整单词截断 */
const SUMMARY_CHARS = 200;
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_ITEMS_PER_SOURCE = 25;
/** 比参考时间晚超过这个量的「发布时间」视为脏数据，降级为无日期 */
const FUTURE_SLACK_MS = 24 * 3600 * 1000;

/** digest.md 里的分类输出顺序 */
const CATEGORY_ORDER = ['玩法与设计', '竞品动态', '技术', 'UI 与美术', '手感与特效', '行业动态'];
const FALLBACK_CATEGORY = '其他';

/* ------------------------------------------------------------------ *
 * 极简工具函数
 * ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 常见 HTML 命名实体（够用即可，未知实体原样保留） */
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', minus: '−', middot: '·', bull: '•',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„',
  laquo: '«', raquo: '»', prime: '′', times: '×', divide: '÷', deg: '°',
  copy: '©', reg: '®', trade: '™', euro: '€', pound: '£', yen: '¥', cent: '¢',
  sect: '§', para: '¶', dagger: '†', permil: '‰', frac12: '½', frac14: '¼',
  agrave: 'à', aacute: 'á', auml: 'ä', aring: 'å', ccedil: 'ç',
  egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë',
  igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï',
  ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö', oslash: 'ø',
  ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü',
  ntilde: 'ñ', szlig: 'ß', aelig: 'æ', oelig: 'œ', shy: '\u00ad',
};

/** 解码 XML / HTML 实体（含数字引用），未知实体原样保留 */
export function decodeEntities(input) {
  return String(input).replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity) => {
    if (entity[0] === '#') {
      const isHex = entity[1] === 'x' || entity[1] === 'X';
      const code = Number.parseInt(isHex ? entity.slice(2) : entity.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code)) return match;
      // 代理区码点无效，直接丢弃
      if (code >= 0xd800 && code <= 0xdfff) return '';
      if (code < 0 || code > 0x10ffff) return match;
      return String.fromCodePoint(code);
    }
    const key = entity.toLowerCase();
    return Object.hasOwn(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : match;
  });
}

/** 去掉 <![CDATA[ ... ]]> 外壳，保留内容 */
export function unwrapCdata(input) {
  return String(input).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

/** 剥离 HTML 标签与残留的孤立尖括号 */
export function stripTags(input) {
  return String(input)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>]/g, ' ');
}

/**
 * 清洗成纯文本：CDATA → 标签 → 实体 → 标签 → 实体。
 * 两轮的原因是 Steam / Google News 的 description 是「被转义的 HTML」：
 *   &lt;p&gt;hello&lt;/p&gt;  —— 必须先解码才能剥离标签。
 */
export function cleanText(input) {
  if (input === null || input === undefined) return '';
  let text = unwrapCdata(input);
  text = stripTags(text);
  text = decodeEntities(text);
  text = stripTags(text);
  text = decodeEntities(text);
  return text.replace(/\s+/g, ' ').trim();
}

/** URL 专用清洗：只解码实体 + 去空白，不动标签（避免破坏查询串） */
export function cleanUrl(input) {
  if (!input) return '';
  return decodeEntities(unwrapCdata(String(input))).replace(/\s+/g, '').trim();
}

/**
 * 截断到 max 个字符，尽量不切断单词（CJK 无空格时直接硬截）。
 * 保证返回值长度 <= max。
 */
export function truncateText(input, max = SUMMARY_CHARS) {
  const text = String(input ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, Math.max(1, max - 1));
  const lastSpace = cut.lastIndexOf(' ');
  // 只在空格位置足够靠后时才回退，否则（长单词 / 中日韩文本）硬截
  const body = lastSpace > cut.length * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${body.replace(/[\s,.;:!?、，。；：\-–—]+$/, '')}…`;
}

/* ------------------------------------------------------------------ *
 * 极简 RSS 2.0 / Atom 解析器（手写正则，不引依赖）
 * ------------------------------------------------------------------ */

/** 取出 <tag ...>inner</tag>；names 按优先级尝试 */
function extractTag(block, ...names) {
  for (const name of names) {
    const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i');
    const m = block.match(re);
    if (m && m[1] && m[1].trim()) return m[1];
  }
  return '';
}

/** 取出条目链接：兼容 Atom 的 <link rel="alternate" href="..."/> 与 RSS 的 <link>url</link> */
export function extractLink(block) {
  const atomAlternate =
    block.match(/<link\b[^>]*\brel=["']alternate["'][^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i) ||
    block.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']alternate["'][^>]*\/?>/i);
  if (atomAlternate) return cleanUrl(atomAlternate[1]);

  const rss = extractTag(block, 'link');
  if (rss) return cleanUrl(rss);

  const anyHref = block.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i);
  if (anyHref) return cleanUrl(anyHref[1]);

  // 最后一招：Atom 用 <id> 当永久链接
  const id = extractTag(block, 'id');
  if (id && /^https?:/i.test(id)) return cleanUrl(id);
  return '';
}

const DATE_TAGS = ['pubDate', 'published', 'updated', 'dc:date', 'date', 'lastBuildDate'];

/** 解析发布时间，返回 ISO 字符串或 null */
export function extractDate(block) {
  for (const tag of DATE_TAGS) {
    const raw = cleanText(extractTag(block, tag));
    if (!raw) continue;
    const time = Date.parse(raw);
    if (!Number.isNaN(time)) return new Date(time).toISOString();
  }
  return null;
}

/**
 * 解析 RSS 2.0 / Atom 文本，返回原始条目数组。
 * @returns {Array<{title:string,url:string,published:string|null,summary:string,publisher:string,publisherUrl:string}>}
 */
export function parseFeed(xml, meta = {}) {
  const text = String(xml ?? '');
  const blocks = [
    ...text.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi),
    ...text.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi),
  ].map((m) => m[1]);

  const items = [];
  for (const block of blocks) {
    const title = cleanText(extractTag(block, 'title'));
    const url = extractLink(block);
    if (!title || !url) continue;

    const descriptionRaw = extractTag(block, 'description', 'summary', 'content:encoded', 'content', 'media:description');
    const publisher = cleanText(extractTag(block, 'source')) || meta.publisher || '';
    const sourceTagMatch = block.match(/<source\b[^>]*\burl=["']([^"']+)["']/i);

    items.push({
      title: stripPublisherSuffix(title, publisher),
      url,
      published: extractDate(block),
      // RSS 常不给完整正文，用标题兜底，保证 digest 里每条都有可读的一行
      summary: truncateText(cleanText(descriptionRaw)) || truncateText(title),
      publisher,
      publisherUrl: sourceTagMatch ? cleanUrl(sourceTagMatch[1]) : '',
      category: meta.category || FALLBACK_CATEGORY,
      source: meta.label || meta.id || '',
    });
  }
  return items;
}

/** Google News 的标题形如 "标题 - 出版商"，去掉重复的出版商后缀 */
export function stripPublisherSuffix(title, publisher) {
  if (!publisher) return title;
  for (const sep of [' - ', ' – ', ' — ', ' | ']) {
    const suffix = sep + publisher;
    if (title.length > suffix.length && title.toLowerCase().endsWith(suffix.toLowerCase())) {
      return title.slice(0, -suffix.length).trim();
    }
  }
  return title;
}

/** 解析 Hacker News Algolia 搜索 API 的 JSON */
export function parseHn(json, meta = {}) {
  const hits = Array.isArray(json?.hits) ? json.hits : [];
  const items = [];
  for (const hit of hits) {
    const title = cleanText(hit.title || hit.story_title || '');
    const url = cleanUrl(
      hit.url ||
        hit.story_url ||
        (hit.objectID ? `https://news.ycombinator.com/item?id=${hit.objectID}` : ''),
    );
    if (!title || !url) continue;

    const parsed = hit.created_at ? Date.parse(hit.created_at) : NaN;
    const body = cleanText(hit.story_text || hit.comment_text || '');
    const meta_line = `Hacker News 热帖 · ${hit.points ?? 0} 分 · ${hit.num_comments ?? 0} 条评论`;

    items.push({
      title,
      url,
      published: Number.isNaN(parsed) ? null : new Date(parsed).toISOString(),
      summary: truncateText(body) || truncateText(meta_line),
      publisher: 'Hacker News',
      publisherUrl: 'https://news.ycombinator.com/',
      category: meta.category || FALLBACK_CATEGORY,
      source: meta.label || meta.id || '',
    });
  }
  return items;
}

/* ------------------------------------------------------------------ *
 * 规范化：URL / 标题 / 去重 / 时间窗 / 排序
 * ------------------------------------------------------------------ */

const TRACKING_PARAMS = [/^utm_/i, /^fbclid$/i, /^gclid$/i, /^oc$/i, /^mc_cid$/i, /^mc_eid$/i, /^ref_src$/i, /^igshid$/i, /^spm$/i, /^_hsenc$/i, /^_hsmi$/i];

/** 规范化 URL，仅用于去重比较（输出仍用原始 URL） */
export function normalizeUrl(raw) {
  try {
    const url = new URL(String(raw));
    if (url.protocol === 'http:') url.protocol = 'https:';
    url.hash = '';
    // www. 前缀与尾斜杠对同一篇文章没有区分意义，去掉以减少重复
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.some((re) => re.test(key))) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.toString();
  } catch {
    return String(raw ?? '').trim().toLowerCase();
  }
}

/** 标题指纹：小写 + 去音标 + 去掉所有标点/空白 */
export function titleKey(title) {
  return String(title ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** 先按 URL 规范化去重，再按标题完全一致（去标点后）去重 */
export function dedupe(items) {
  const seenUrl = new Set();
  const seenTitle = new Set();
  const out = [];
  for (const item of items) {
    const urlKey = normalizeUrl(item.url);
    const titleK = titleKey(item.title);
    if (urlKey && seenUrl.has(urlKey)) continue;
    if (titleK && seenTitle.has(titleK)) continue;
    if (urlKey) seenUrl.add(urlKey);
    if (titleK) seenTitle.add(titleK);
    out.push(item);
  }
  return out;
}

/** 时间窗判定：无日期/脏日期保留但不参与过滤 */
export function isWithinWindow(item, nowMs, hours) {
  if (!item.published) return true;
  const time = Date.parse(item.published);
  if (Number.isNaN(time)) return true;
  return time >= nowMs - hours * 3600 * 1000;
}

/** 时间窗过滤 */
export function applyTimeWindow(items, nowMs, hours) {
  return items.filter((item) => isWithinWindow(item, nowMs, hours));
}

/** 发布时间倒序；无日期的排最后 */
export function sortItems(items) {
  return items.slice().sort((a, b) => {
    const at = a.published ? Date.parse(a.published) : NaN;
    const bt = b.published ? Date.parse(b.published) : NaN;
    const aMissing = Number.isNaN(at);
    const bMissing = Number.isNaN(bt);
    if (aMissing && bMissing) return 0;
    if (aMissing) return 1;
    if (bMissing) return -1;
    return bt - at;
  });
}

/**
 * 单源截断：先按时间倒序再取前 N 条。
 * Google News 的 feed 是相关性排序，直接切前 N 条会丢掉「排在后面但其实很新」的条目。
 */
export function orderAndCap(items, maxItems) {
  return sortItems(items).slice(0, maxItems);
}

/** 清理脏发布时间：无法解析或明显在未来的降级为 null（保留条目，排到最后） */
function sanitizePublished(item, nowMs) {
  if (!item.published) return { ...item, published: null };
  const time = Date.parse(item.published);
  if (Number.isNaN(time) || time > nowMs + FUTURE_SLACK_MS) return { ...item, published: null };
  return item;
}

/* ------------------------------------------------------------------ *
 * digest 渲染
 * ------------------------------------------------------------------ */

const escapeMdText = (text) => String(text ?? '').replace(/[[\]\\]/g, '\\$&').replace(/\s+/g, ' ').trim();
/**
 * 链接地址原样输出，不加 <> 包裹。
 * 下游 validate.mjs 会拿 LLM 逐字抄回来的 URL 与 digest.json 做匹配，
 * 任何包装字符都会让「来源真实性校验」失败。md 是给 LLM 读的文本，不是给渲染器的。
 */
const mdUrl = (url) => String(url ?? '').trim();

/**
 * 摘要是否提供了标题之外的信息。
 * Google News 的 description 往往就是「标题 + 出版商」，重复输出只会浪费字符额度。
 */
export function summaryAddsValue(item) {
  if (!item.summary) return false;
  const summaryKey = titleKey(item.summary);
  const titleK = titleKey(item.title);
  if (!summaryKey || !titleK) return true;
  if (summaryKey === titleK) return false;
  if (summaryKey === titleK + titleKey(item.publisher || '')) return false;
  return true;
}

function renderItem(item) {
  const date = item.published ? item.published.slice(0, 10) : '日期未知';
  const origin = escapeMdText(item.publisher || item.source);
  let line = `- [${escapeMdText(item.title)}](${mdUrl(item.url)}) — ${origin} · ${date}\n`;
  if (summaryAddsValue(item)) line += `  ${escapeMdText(item.summary)}\n`;
  return line;
}

function groupByCategory(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.category || FALLBACK_CATEGORY;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const ordered = [];
  for (const key of CATEGORY_ORDER) if (groups.has(key)) ordered.push([key, groups.get(key)]);
  for (const [key, list] of groups) if (!CATEGORY_ORDER.includes(key)) ordered.push([key, list]);
  return ordered;
}

function renderFailures(failures) {
  if (!failures.length) return '';
  const lines = ['', '## 本次抓取失败', ''];
  for (const f of failures) lines.push(`- \`${f.source}\` — ${f.error}`);
  lines.push('');
  return lines.join('\n') + '\n';
}

/**
 * 构建 digest.md
 * @returns {{md:string, included:number, omitted:number}}
 */
export function buildDigestMd(ctx) {
  const { items, failures, hours, limit, rawCount, sourceCount, okCount, dateLabel } = ctx;
  const header = [
    `# 弹珠 Roguelike 资讯摘要 · ${dateLabel}`,
    '',
    `> 采集窗口：最近 ${hours} 小时 · 源 ${sourceCount} 个（成功 ${okCount} / 失败 ${failures.length}）` +
      ` · 入库 ${items.length} 条（去重前 ${rawCount} 条，上限 ${limit}）`,
    '',
  ].join('\n');

  const failSection = renderFailures(failures);
  // 预留失败小节 + 截断提示的空间，保证最终 md 一定不超过 MAX_MD_CHARS
  const reserved = failSection.length + 320;
  const contentBudget = MAX_MD_CHARS - reserved - header.length;

  const groups = groupByCategory(items).map(([category, list]) => ({
    category,
    lines: list.map(renderItem),
    headerLen: `\n## ${category}\n\n`.length,
    take: 0,
  }));

  // 额度在分类之间轮转分配：靠前的分类不会把 8000 字符吃光，每个分类都能露脸
  let used = groups.reduce((sum, group) => sum + group.headerLen, 0);
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const group of groups) {
      if (group.take >= group.lines.length) continue;
      const size = group.lines[group.take].length;
      if (used + size > contentBudget) continue;
      used += size;
      group.take += 1;
      progressed = true;
    }
  }

  let out = header;
  let included = 0;
  let omitted = 0;
  for (const group of groups) {
    if (group.take === 0) {
      omitted += group.lines.length;
      continue;
    }
    out += `\n## ${group.category}\n\n`;
    for (let i = 0; i < group.take; i += 1) {
      out += group.lines[i];
      included += 1;
    }
    omitted += group.lines.length - group.take;
  }

  if (omitted > 0) {
    out += `\n> 受 ${MAX_MD_CHARS} 字符上限限制，已省略 ${omitted} 条；完整数据见 digest.json。\n`;
  }
  out += failSection;
  return { md: out, included, omitted };
}

export function buildDigestJson(ctx) {
  const { items, failures, optionalFailures, now, hours, limit, dateLabel, sourceCount, okCount } = ctx;
  return {
    generatedAt: new Date(now).toISOString(),
    date: dateLabel,
    windowHours: hours,
    limit,
    counts: {
      sources: sourceCount,
      ok: okCount,
      failed: failures.length,
      optionalSkipped: optionalFailures.length,
      items: items.length,
    },
    items: items.map((item) => ({
      title: item.title,
      url: item.url,
      source: item.source,
      category: item.category,
      published: item.published,
      summary: item.summary,
      ...(item.publisher ? { publisher: item.publisher } : {}),
      ...(item.publisherUrl ? { publisherUrl: item.publisherUrl } : {}),
    })),
    failures: failures.map((f) => ({ source: f.source, id: f.id, error: f.error })),
    ...(optionalFailures.length
      ? { optionalFailures: optionalFailures.map((f) => ({ source: f.source, id: f.id, error: f.error })) }
      : {}),
  };
}

/* ------------------------------------------------------------------ *
 * 源配置
 * ------------------------------------------------------------------ */

export function buildGoogleNewsUrl(source) {
  const hl = source.hl || 'en-US';
  const gl = source.gl || 'US';
  const ceid = source.ceid || `${gl}:${hl.split('-')[0]}`;
  return `https://news.google.com/rss/search?q=${encodeURIComponent(source.query)}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
}

export function resolveSourceUrl(source) {
  if (source.url) return source.url;
  if (source.type === 'google-news' && source.query) return buildGoogleNewsUrl(source);
  throw new Error(`源 ${source.id || '(未命名)'} 既没有 url 也没有 query`);
}

/** 校验 sources.json 结构，返回规范化后的源数组 */
export function validateSourcesConfig(config) {
  if (!config || typeof config !== 'object') throw new Error('sources 配置不是对象');
  if (!Array.isArray(config.sources) || config.sources.length === 0) throw new Error('sources 配置缺少非空的 sources 数组');

  const seen = new Set();
  const sources = config.sources.map((raw, index) => {
    const source = { ...raw };
    if (!source.id) source.id = `source-${index + 1}`;
    if (seen.has(source.id)) throw new Error(`源 id 重复：${source.id}`);
    seen.add(source.id);
    source.url = resolveSourceUrl(source);
    source.label = source.label || source.id;
    source.category = source.category || FALLBACK_CATEGORY;
    source.type = source.type === 'hn' ? 'hn' : 'rss';
    if (source.enabled === false) return null;
    return source;
  }).filter(Boolean);

  if (sources.length === 0) throw new Error('sources 配置里没有启用的源');
  return sources;
}

/* ------------------------------------------------------------------ *
 * 抓取
 * ------------------------------------------------------------------ */

async function fetchSource(source, options) {
  const timeoutMs = source.timeoutMs || options.timeoutMs || DEFAULT_TIMEOUT_MS;
  if (source.delayMs) await sleep(source.delayMs);

  let response;
  try {
    response = await fetch(source.url, {
      redirect: 'follow',
      headers: {
        'user-agent': options.userAgent || USER_AGENT,
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, application/json;q=0.9, */*;q=0.8',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError') throw new Error(`超时 ${timeoutMs}ms`);
    // fetch 会把真实原因（ENOTFOUND / ECONNREFUSED / 证书错误）塞在 cause 里，运维排障需要它
    const cause = error?.cause?.code || error?.cause?.message;
    const message = error?.message || String(error);
    throw new Error(cause && !message.includes(cause) ? `${message}（${cause}）` : message);
  }

  if (!response.ok) throw new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`);

  const text = await response.text();
  if (!text || !text.trim()) throw new Error('响应体为空');

  const items = source.type === 'hn' ? parseHn(JSON.parse(text), source) : parseFeed(text, source);
  if (items.length === 0) throw new Error('解析到 0 条（feed 可能已失效或查询过窄）');

  // 先按时间倒序再截断：Google News 的 feed 是相关性排序而非时间排序，
  // 直接切前 N 条会把「排在后面但其实很新」的条目丢掉，时间窗一过滤就整源空手而归。
  const maxItems = source.maxItems ?? options.maxItemsPerSource ?? DEFAULT_MAX_ITEMS_PER_SOURCE;
  return orderAndCap(items, maxItems).map((item) => ({
    ...item,
    sourceId: source.id,
    maxAgeHours: source.maxAgeHours || 0,
  }));
}

/** 并发抓取所有源，单个失败不影响整体 */
async function fetchAllSources(sources, options) {
  const settled = await Promise.allSettled(sources.map((source) => fetchSource(source, options)));
  const ok = [];
  const failures = [];
  const optionalFailures = [];
  const raw = [];

  settled.forEach((result, index) => {
    const source = sources[index];
    if (result.status === 'fulfilled') {
      ok.push(source);
      raw.push(...result.value);
      options.onProgress?.(`[ok]   ${source.label} → ${result.value.length} 条`);
      return;
    }
    const record = { id: source.id, source: source.label, error: result.reason?.message || String(result.reason) };
    (source.optional ? optionalFailures : failures).push(record);
    options.onProgress?.(`[${source.optional ? 'skip' : 'fail'}] ${source.label} → ${record.error}`);
  });

  return { ok, failures, optionalFailures, raw };
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

export function parseArgs(argv) {
  const args = { out: null, date: null, hours: 24, limit: 60, sources: DEFAULT_SOURCES_FILE, selfTest: false, verbose: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`参数 ${arg} 缺少取值`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--out': args.out = next(); break;
      case '--date': args.date = next(); break;
      case '--hours': args.hours = Number(next()); break;
      case '--limit': args.limit = Number(next()); break;
      case '--sources': args.sources = next(); break;
      case '--self-test': args.selfTest = true; break;
      case '--verbose': args.verbose = true; break;
      case '--help': case '-h': args.help = true; break;
      default: throw new Error(`未知参数：${arg}`);
    }
  }

  if (args.help) return args;
  if (args.date && !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new Error('--date 需要 YYYY-MM-DD 格式');
  if (!Number.isFinite(args.hours) || args.hours <= 0) throw new Error('--hours 需要正数');
  if (!Number.isInteger(args.limit) || args.limit <= 0) throw new Error('--limit 需要正整数');
  if (!args.selfTest && !args.out) throw new Error('缺少必填参数 --out <目录>');
  return args;
}

const HELP = `Pinward 资讯采集器（零依赖）

用法：
  node collect.mjs --out <目录> [--date YYYY-MM-DD] [--hours 24] [--limit 60]
                   [--sources <file>] [--self-test] [--verbose]

  --out <目录>        输出目录（不存在则创建），写入 digest.md 与 digest.json
  --date YYYY-MM-DD   参考日期（默认取本机当天）；时间窗与标题日期以它为准
  --hours <n>         时间窗小时数，默认 24；无发布时间的条目不受此限制
  --limit <n>         最终条目上限，默认 60
  --sources <file>    源配置文件路径，默认同目录 sources.json
  --self-test         离线自检：用 fixtures 跑完整管线，不访问网络
  --verbose           打印每个源的抓取结果
`;

function formatLocalDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 参考时间：--date 给出则取该日 UTC 零点，否则取本机当前时间 */
export function resolveNow(args) {
  return args.date ? Date.parse(`${args.date}T00:00:00Z`) : Date.now();
}

async function loadSources(args) {
  const file = path.resolve(args.sources);
  let config;
  try {
    config = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`读取源配置失败 ${file}：${error.message}`);
  }
  return {
    file,
    sources: validateSourcesConfig(config),
    defaults: config.defaults && typeof config.defaults === 'object' ? config.defaults : {},
  };
}

/** 若 --out 落在仓库内，给出警告（脚本本身只写 out 目录） */
function warnIfInsideRepo(outDir) {
  let dir = SCRIPT_DIR;
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(path.join(dir, '.git'))) {
      const relative = path.relative(dir, outDir);
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        process.stderr.write(`[warn] 输出目录在仓库内（${relative}），建议改用 /var/log/pinward-digest 之类的仓库外路径\n`);
      }
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

export async function run(args) {
  const now = resolveNow(args);
  if (Number.isNaN(now)) throw new Error('无法解析参考时间');

  const { sources, defaults } = await loadSources(args);
  const dateLabel = args.date || formatLocalDate(new Date(now));
  const outDir = path.resolve(args.out);

  const progress = (line) => {
    if (args.verbose) process.stderr.write(`${line}\n`);
  };
  progress(`[info] 参考时间 ${new Date(now).toISOString()} · 窗口 ${args.hours}h · 上限 ${args.limit} · 源 ${sources.length} 个`);

  const { ok, failures, optionalFailures, raw } = await fetchAllSources(sources, {
    timeoutMs: Number(defaults.timeoutMs) || DEFAULT_TIMEOUT_MS,
    maxItemsPerSource: Number(defaults.maxItemsPerSource) || DEFAULT_MAX_ITEMS_PER_SOURCE,
    userAgent: USER_AGENT,
    onProgress: progress,
  });

  // 失败源必须打到 stderr；可选源（如 Reddit）静默跳过
  for (const failure of failures) process.stderr.write(`[fail] ${failure.source} — ${failure.error}\n`);
  for (const failure of optionalFailures) process.stderr.write(`[skip] 可选源 ${failure.source} — ${failure.error}\n`);

  // 时间窗：源可用 maxAgeHours 覆盖全局 --hours（竞品补丁说明更新稀疏）
  const withWindow = raw
    .map((item) => sanitizePublished(item, now))
    .filter((item) => isWithinWindow(item, now, item.maxAgeHours || args.hours));

  const deduped = dedupe(withWindow);
  const sorted = sortItems(deduped);
  const items = sorted.slice(0, args.limit);

  const ctx = {
    items,
    failures,
    optionalFailures,
    now,
    hours: args.hours,
    limit: args.limit,
    dateLabel,
    rawCount: raw.length,
    sourceCount: sources.length,
    okCount: ok.length,
  };

  const { md, included, omitted } = buildDigestMd(ctx);
  const json = buildDigestJson(ctx);

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'digest.md'), md, 'utf8');
  await writeFile(path.join(outDir, 'digest.json'), `${JSON.stringify(json, null, 2)}\n`, 'utf8');

  progress(`[info] 去重后 ${deduped.length} 条 → 入 md ${included} 条${omitted ? `（省略 ${omitted} 条）` : ''}`);
  process.stderr.write(
    `[done] 源 ${sources.length}（成功 ${ok.length} / 失败 ${failures.length} / 可选跳过 ${optionalFailures.length}）· 条目 ${items.length} · digest.md ${md.length} 字符 → ${outDir}\n`,
  );

  return { md, json, okCount: ok.length, failures, items };
}

/* ------------------------------------------------------------------ *
 * --self-test：离线跑完整管线并断言
 * ------------------------------------------------------------------ */

function createSelfTestSources() {
  const fixture = (name) => path.join(FIXTURES_DIR, name);
  return [
    { id: 'fix-gnews', label: 'Google News · fixture', category: '玩法与设计', file: fixture('google-news.xml') },
    { id: 'fix-steam', label: 'Steam · fixture', category: '竞品动态', file: fixture('steam-app.xml') },
    { id: 'fix-atom', label: 'Atom · fixture', category: 'UI 与美术', file: fixture('atom-feed.xml') },
    { id: 'fix-hn', label: 'HN · fixture', category: '技术', file: fixture('hn.json'), type: 'hn' },
  ];
}

async function readFixtureItems(sources, nowMs) {
  const raw = [];
  for (const source of sources) {
    const text = await readFile(source.file, 'utf8');
    const parsed = source.type === 'hn' ? parseHn(JSON.parse(text), source) : parseFeed(text, source);
    raw.push(...parsed);
  }
  return raw.map((item) => sanitizePublished(item, nowMs));
}

function makeAsserter() {
  const failures = [];
  let count = 0;
  const assert = (condition, label, detail = '') => {
    count += 1;
    if (!condition) failures.push(detail ? `${label} :: ${detail}` : label);
  };
  const equal = (actual, expected, label) =>
    assert(actual === expected, label, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  return { assert, equal, failures, total: () => count };
}

export async function selfTest() {
  const t = makeAsserter();
  // 自检绝不能碰网络：任何 fetch 调用直接失败
  globalThis.fetch = () => {
    throw new Error('self-test 不允许访问网络');
  };

  /* --- 1. 实体解码 / CDATA / 标签剥离 --- */
  t.equal(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x27;f&#x27;'), `a & b <c> "d" 'e' 'f'`, 'decodeEntities 基本实体');
  t.equal(decodeEntities('caf&eacute; &mdash; &nbsp;ok'), 'café —  ok', 'decodeEntities 命名实体与重音字符');
  t.equal(decodeEntities('&#x4E2D;&#25991;'), '中文', 'decodeEntities 十六进制与十进制中文');
  t.equal(decodeEntities('&unknownentity; &amp;'), '&unknownentity; &', 'decodeEntities 未知实体原样保留');
  t.equal(unwrapCdata('<![CDATA[hello & <b>world</b>]]>'), 'hello & <b>world</b>', 'unwrapCdata 保留内容');
  t.assert(!cleanText('<p>Hello <b>there</b> &amp; welcome</p>').includes('<'), 'cleanText 剥离 HTML 标签');
  t.equal(cleanText('&lt;p&gt;escaped &amp;amp; text&lt;/p&gt;'), 'escaped & text', 'cleanText 处理被转义的 HTML（Steam/Google News 形态）');
  t.equal(cleanText('<![CDATA[<p>球</p>&nbsp;弹珠]]>'), '球 弹珠', 'cleanText 同时处理 CDATA + HTML + 实体');

  /* --- 2. 摘要截断：不超长、保留完整单词 --- */
  const longText = `${'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima '.repeat(6)}omega`;
  const truncated = truncateText(longText, SUMMARY_CHARS);
  t.assert(truncated.length <= SUMMARY_CHARS, '截断结果不超过上限', `实际 ${truncated.length}`);
  t.assert(truncated.endsWith('…'), '截断结果以省略号结尾');
  t.assert(!truncated.includes('ome'), '截断不残留半个单词（最后一个词被整词丢弃）');
  t.equal(truncateText('  short   text  ', SUMMARY_CHARS), 'short text', '短摘要只做空白折叠');
  const cjk = truncateText('弹珠'.repeat(200), SUMMARY_CHARS);
  t.assert(cjk.length <= SUMMARY_CHARS, 'CJK 无空格文本也能安全截断');

  /* --- 3. URL 规范化与去重 --- */
  t.equal(
    normalizeUrl('http://WWW.Example.com/a/b/?utm_source=x&b=2&a=1#frag'),
    'https://example.com/a/b?a=1&b=2',
    'normalizeUrl 去协议差异/跟踪参数/锚点/尾斜杠并排序参数',
  );
  t.equal(titleKey('Hello, World! — 弹珠'), 'helloworld弹珠', 'titleKey 去标点并保留 CJK');

  const dedupeInput = [
    { title: 'A', url: 'https://example.com/x?utm_source=a', published: '2026-09-20T00:00:00Z' },
    { title: 'A 副本', url: 'https://www.example.com/x/', published: '2026-09-19T00:00:00Z' },
    { title: 'B!!!', url: 'https://example.com/b', published: '2026-09-18T00:00:00Z' },
    { title: 'b', url: 'https://example.com/c', published: '2026-09-17T00:00:00Z' },
    { title: 'C', url: 'https://example.com/c2', published: null },
  ];
  const dedupedInput = dedupe(dedupeInput);
  t.equal(dedupedInput.length, 3, '先按 URL 去重再按标题去重');
  t.equal(dedupedInput[0].title, 'A', 'URL 去重保留先出现的条目');
  t.equal(dedupedInput[1].title, 'B!!!', '标题去重保留先出现的条目');
  t.equal(dedupedInput[2].title, 'C', '无日期条目保留');

  /* --- 4. 排序 + 时间窗 --- */
  const nowMs = Date.parse('2026-09-22T00:00:00Z');
  const sortedInput = sortItems([
    { title: 'old', url: 'https://e.com/1', published: '2026-09-01T00:00:00Z' },
    { title: 'new', url: 'https://e.com/2', published: '2026-09-21T00:00:00Z' },
    { title: 'undated', url: 'https://e.com/3', published: null },
    { title: 'mid', url: 'https://e.com/4', published: '2026-09-10T00:00:00Z' },
  ]);
  t.equal(sortedInput.map((i) => i.title).join(','), 'new,mid,old,undated', '按发布时间倒序且无日期排最后');

  const windowed = applyTimeWindow(sortedInput, nowMs, 24);
  t.equal(windowed.map((i) => i.title).join(','), 'new,undated', '默认 24h 窗口只保留窗口内条目与无日期条目');

  // 单源截断必须留最新的，而不是 feed 里排最前的（Google News 是相关性排序）
  const capped = orderAndCap(
    [
      { title: 'relevance-first-but-old', url: 'https://e.com/old', published: '2026-01-01T00:00:00Z' },
      { title: 'buried-but-fresh', url: 'https://e.com/fresh', published: '2026-09-21T00:00:00Z' },
    ],
    1,
  );
  t.equal(capped.length, 1, 'orderAndCap 截断到指定条数');
  t.equal(capped[0].title, 'buried-but-fresh', 'maxItems 保留最新条目而不是 feed 里排最前的');

  /* --- 5. 完整离线管线：fixtures → digest --- */
  const sources = createSelfTestSources();
  for (const source of sources) {
    t.assert(existsSync(source.file), `fixture 存在：${path.basename(source.file)}`);
  }

  const raw = await readFixtureItems(sources, nowMs);
  t.assert(raw.length >= 8, '从 fixtures 解析出足够多的条目', `实际 ${raw.length}`);

  const fixturesText = await readFile(path.join(FIXTURES_DIR, 'steam-app.xml'), 'utf8');
  t.assert(!parseFeed(fixturesText)[0].summary.includes('<'), 'fixture 摘要里没有残留 HTML 标签');
  t.equal(parseFeed(fixturesText)[0].summary.length <= SUMMARY_CHARS, true, 'fixture 长摘要被截断到 200 字符内');

  const gnItems = parseFeed(await readFile(path.join(FIXTURES_DIR, 'google-news.xml'), 'utf8'), { label: 'GN' });
  t.equal(gnItems[0].publisher, 'Rogueliker', 'Google News <source> 被解析为 publisher');
  t.assert(!gnItems[0].title.endsWith('Rogueliker'), 'Google News 标题去掉了重复的出版商后缀');
  t.equal(gnItems[0].published, '2026-09-15T10:13:35.000Z', 'RSS pubDate 解析为 ISO');

  const atomItems = parseFeed(await readFile(path.join(FIXTURES_DIR, 'atom-feed.xml'), 'utf8'));
  t.assert(atomItems.length >= 2, 'Atom fixture 解析出条目');
  t.assert(atomItems.every((i) => /^https?:/.test(i.url)), 'Atom <link rel=alternate href> 被正确提取');

  const hnItems = parseHn(JSON.parse(await readFile(path.join(FIXTURES_DIR, 'hn.json'), 'utf8')));
  t.assert(hnItems.some((i) => i.url.includes('news.ycombinator.com/item?id=')), 'HN 无外链条目回退到讨论页链接');

  const dedupedRaw = dedupe(raw);
  t.assert(dedupedRaw.length < raw.length, 'fixtures 里存在可被去重的重复条目');
  const finalItems = sortItems(dedupedRaw);
  t.assert(
    finalItems.every((item, i) => i === 0 || !item.published || !finalItems[i - 1].published || Date.parse(finalItems[i - 1].published) >= Date.parse(item.published)),
    '最终列表严格按发布时间倒序',
  );

  // 竞品源用 maxAgeHours 放宽窗口：9 月 1 日距参考时间约 504 小时
  t.equal(isWithinWindow({ published: '2026-09-01T00:00:00Z' }, nowMs, 24), false, '24h 窗口滤掉 3 周前的条目');
  t.equal(isWithinWindow({ published: '2026-09-01T00:00:00Z' }, nowMs, 720), true, '720h 窗口保留 3 周前的条目');

  /* --- 6. 输出文件 --- */
  const outDir = path.join(process.env.TMPDIR || '/tmp', `pinward-feeds-selftest-${process.pid}-${Date.now()}`);
  const ctx = {
    items: finalItems,
    failures: [{ id: 'broken', source: '坏掉的源', error: 'HTTP 503 Service Unavailable' }],
    optionalFailures: [],
    now: nowMs,
    hours: 72,
    limit: 60,
    dateLabel: '2026-09-22',
    rawCount: raw.length,
    sourceCount: sources.length,
    okCount: sources.length,
  };
  const { md, included, omitted } = buildDigestMd(ctx);
  const json = buildDigestJson(ctx);

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'digest.md'), md, 'utf8');
  await writeFile(path.join(outDir, 'digest.json'), `${JSON.stringify(json, null, 2)}\n`, 'utf8');

  t.assert(md.length <= MAX_MD_CHARS, `digest.md 不超过 ${MAX_MD_CHARS} 字符`, `实际 ${md.length}`);
  t.equal(omitted, 0, 'fixture 数据量下没有触发截断');
  t.equal(included, finalItems.length, 'md 收录条目数与数据一致');
  t.assert(md.startsWith('# 弹珠 Roguelike 资讯摘要 · 2026-09-22'), 'digest.md 有标题与日期');
  t.assert(md.includes('## 玩法与设计') && md.includes('## 技术'), 'digest.md 按分类分组输出');
  t.assert(md.includes('## 本次抓取失败') && md.includes('HTTP 503'), 'digest.md 末尾有「本次抓取失败」小节');
  t.assert(md.includes('\n  '), 'digest.md 的摘要行有缩进');
  t.equal(renderItem(gnItems[0]).trim().split('\n').length, 1, 'Google News 摘要与「标题+出版商」重复时不重复输出');
  t.equal(summaryAddsValue({ title: 'A', summary: 'A', publisher: '' }), false, '摘要等于标题时不输出');
  t.equal(summaryAddsValue({ title: 'A', summary: 'A PC Gamer', publisher: 'PC Gamer' }), false, '摘要等于标题+出版商时不输出');
  t.equal(summaryAddsValue({ title: 'A', summary: '完全不同的正文', publisher: '' }), true, '摘要提供新信息时输出');
  t.assert(md.indexOf('## 本次抓取失败') > md.indexOf('## 玩法与设计'), '失败小节位于最后');
  t.assert(existsSync(path.join(outDir, 'digest.md')) && existsSync(path.join(outDir, 'digest.json')), '两个输出文件都已写出');

  const roundTrip = JSON.parse(await readFile(path.join(outDir, 'digest.json'), 'utf8'));
  t.equal(roundTrip.items.length, finalItems.length, 'digest.json 条目数正确');
  t.assert(
    roundTrip.items.every((i) => i.title && i.url && i.source && i.summary && 'published' in i),
    'digest.json 每条都含 title/url/source/published/summary',
  );
  t.equal(roundTrip.counts.failed, 1, 'digest.json 记录失败源数量');

  /* --- 7. 小 limit 下的截断行为 --- */
  const small = buildDigestMd({ ...ctx, limit: 1, items: finalItems.slice(0, 1) });
  t.equal(small.included, 1, '--limit 生效：只收录 1 条');

  /* --- 8. 巨大的输入也要守住 8000 字符上限 --- */
  const huge = Array.from({ length: 400 }, (_, i) => ({
    title: `压测标题 ${i} `.repeat(3),
    url: `https://example.com/post/${i}`,
    source: '压测源',
    publisher: '',
    category: CATEGORY_ORDER[i % CATEGORY_ORDER.length],
    published: new Date(nowMs - i * 3600 * 1000).toISOString(),
    summary: 'x '.repeat(180),
  }));
  const hugeMd = buildDigestMd({ ...ctx, items: huge });
  t.assert(hugeMd.md.length <= MAX_MD_CHARS, '400 条输入下 digest.md 仍不超过字符上限', `实际 ${hugeMd.md.length}`);
  t.assert(hugeMd.omitted > 0, '超长时给出省略计数');
  t.assert(
    CATEGORY_ORDER.every((category) => hugeMd.md.includes(`## ${category}`)),
    '额度紧张时每个分类仍都出现（轮转分配，靠前分类不垄断）',
  );

  /* --- 9. sources.json 结构校验（本地文件，不联网） --- */
  try {
    const config = JSON.parse(await readFile(DEFAULT_SOURCES_FILE, 'utf8'));
    const validated = validateSourcesConfig(config);
    t.assert(validated.length >= 10, 'sources.json 至少有 10 个启用的源', `实际 ${validated.length}`);
    t.assert(validated.every((s) => s.url.startsWith('https://')), 'sources.json 里所有源都用 https');
    t.assert(new Set(validated.map((s) => s.id)).size === validated.length, 'sources.json 源 id 唯一');
    t.assert(validated.filter((s) => s.category === '竞品动态').length >= 3, 'sources.json 覆盖竞品动态');
    t.assert(validated.some((s) => s.optional === true), 'sources.json 保留了可选（失败静默跳过）的源');
  } catch (error) {
    t.assert(false, 'sources.json 校验通过', error.message);
  }

  /* --- 汇总 --- */
  if (t.failures.length > 0) {
    process.stderr.write(`\nSELF-TEST FAILED（${t.failures.length}/${t.total()} 项断言未通过）\n`);
    for (const failure of t.failures) process.stderr.write(`  ✗ ${failure}\n`);
    process.stderr.write(`  保留现场：${outDir}\n`);
    return 1;
  }

  // 全部通过才清理临时目录
  await rm(outDir, { recursive: true, force: true });
  process.stdout.write(`SELF-TEST OK（${t.total()} 项断言通过）\n`);
  return 0;
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[error] ${error.message}\n\n${HELP}`);
    return 2;
  }

  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.selfTest) return selfTest();

  try {
    warnIfInsideRepo(path.resolve(args.out));
    const result = await run(args);
    // 全军覆没时用非 0 退出码，便于 cron 告警；部分失败仍算成功
    return result.okCount === 0 ? 1 : 0;
  } catch (error) {
    process.stderr.write(`[error] ${error.message}\n`);
    return 1;
  }
}

// 仅在被直接执行时运行，便于测试导入
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SCRIPT_DIR, 'collect.mjs')) {
  process.exitCode = await main();
}
