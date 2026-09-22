# Pinward 资讯采集器

零依赖的资讯采集脚本，供一台服务器每天定时运行，为「弹珠 + Roguelike + 塔防」这个 Canvas 2D 网页游戏项目产出当日情报摘要。

- 只用 Node 22 内置能力（`node:fs` / `node:path` / 全局 `fetch` / `AbortSignal.timeout`），**没有任何 npm 依赖**，也没有 `package.json`。
- 只读网络、只写 `--out` 指定的目录；不改仓库其他位置，不调用 `git`。
- 所有源并发抓取（`Promise.allSettled`），**单个源失败不影响整体**。

## 用法

```sh
node ops/bin/feeds/collect.mjs --out <目录> [--date YYYY-MM-DD] [--hours 24] [--limit 60] \
                              [--sources <file>] [--self-test] [--verbose]
```

| 参数 | 说明 |
| --- | --- |
| `--out <目录>` | 必填。输出目录，不存在会自动创建 |
| `--date YYYY-MM-DD` | 参考日期，默认取本机当天。给定后时间窗以**该日 UTC 零点**为基准，用于补跑历史日期 |
| `--hours <n>` | 时间窗小时数，默认 `24`。无发布时间的条目不受时间窗限制 |
| `--limit <n>` | 最终条目上限，默认 `60` |
| `--sources <file>` | 源配置文件路径，默认 `ops/bin/feeds/sources.json` |
| `--self-test` | 离线自检：用 `fixtures/` 跑完整管线并断言，**不访问网络**，通过时打印 `SELF-TEST OK` |
| `--verbose` | 打印每个源的抓取结果 |

退出码：`0` 正常（含部分源失败）；`1` 抓取全失败或自检未通过（便于 cron 告警）；`2` 参数错误。

## 输出

写入 `<out>/` 两个文件：

- **`digest.md`** —— 给 LLM 读的 Markdown 摘要，最多 8000 字符。按分类分组（`## 玩法与设计`、`## 竞品动态`、`## 技术`、`## UI 与美术`、`## 手感与特效`、`## 行业动态`），每条形如 `- [标题](链接) — 来源 · 日期`，下一行是缩进摘要。额度紧张时按分类**轮转分配**，不会让靠前的分类吃光额度；末尾有「本次抓取失败」小节。
- **`digest.json`** —— 结构化数据，供上层做「来源真实性校验」。每条含 `title / url / source / category / published / summary`，另有 `publisher` / `publisherUrl`（Google News 会给出原始出版商与域名）；顶层含 `counts` / `failures` / `optionalFailures`。

`digest.md` 放不下的条目不会丢，都在 `digest.json` 里。两个文件里的链接**逐字一致**（不做 `<>` 包裹或百分号编码），这样模型从 md 抄回的 URL 才能在下游校验里对上 `digest.json`。

摘要行只在「确实提供了标题之外的信息」时才输出：Google News 的 `description` 往往就是「标题 + 出版商」，重复输出只会浪费 8000 字符的额度。

## 源配置（`sources.json`）

三种 `type`：

| type | 说明 |
| --- | --- |
| `google-news` | 由 `query` 拼出 `https://news.google.com/rss/search?q=...&hl=&gl=&ceid=`；`hl`/`gl`/`ceid` 可选，默认 `en-US` / `US` |
| `rss` | 直接给 `url`，RSS 2.0 与 Atom 通用解析 |
| `hn` | Hacker News Algolia JSON |

其它字段：`id`、`label`（显示名）、`category`（决定 digest.md 的分组）、`maxItems`（单源条数上限）、`optional`（`true` = 失败静默跳过）、`enabled`（`false` 停用）、`delayMs`（抓取前等待，用于给速率限制的站点错峰）、`maxAgeHours`（可选，覆盖该源的全局 `--hours`；**出厂配置故意没有启用**，因为时间窗对所有源一视同仁更符合直觉。Steam 补丁说明更新稀疏，想让它天天露面就给它加 `"maxAgeHours": 168`）。

### 如何加源

1. **Google News 搜索**（最省事，无需 API key）：在 `sources` 里加一条
   ```json
   { "id": "gnews-my-topic", "label": "Google News · my topic", "type": "google-news", "query": "my topic", "category": "玩法与设计" }
   ```
2. **Steam 单游戏**：先用商店搜索接口查 appid，再加 RSS。
   ```sh
   curl -s "https://store.steampowered.com/api/storesearch/?term=<游戏名>&l=english&cc=US"
   # → https://store.steampowered.com/feeds/news/app/<appid>/?cc=us&l=english
   ```
3. **行业媒体**：直接填 feed 地址，例如 `https://www.gamedeveloper.com/rss.xml`。

**加完源务必先实测再提交**：

```sh
# 只跑某个源：写一个临时 sources 文件，enabled 之外只留它
node ops/bin/feeds/collect.mjs --out /tmp/probe --sources /tmp/one-source.json --verbose
```

## 源清单（2026-09-22 实测）

29 个源，逐个在真实网络下测过。抓到条数为「单源上限内、时间窗过滤前」的数量。

| 分类 | 源 | 类型 | 实测 |
| --- | --- | --- | --- |
| 玩法与设计 | Google News · roguelike game design | google-news | ✅ 20 |
| 玩法与设计 | Google News · pinball roguelike | google-news | ✅ 20 |
| 玩法与设计 | Google News · tower defense game | google-news | ✅ 20 |
| 玩法与设计 | Google News · roguelike deckbuilder | google-news | ✅ 15 |
| 玩法与设计 | Google News · 弹珠游戏（zh-CN） | google-news | ✅ 15 |
| 玩法与设计 | Hacker News · roguelike（`advancedSyntax` 短语匹配） | hn | ✅ 15 |
| 玩法与设计 | Reddit · r/roguelikes `top/.rss?t=day` | rss（**optional**） | ⚠️ 间歇：成功时 2 条，被限流时 429 静默跳过 |
| 竞品动态 | Steam · Peglin（appid 1296610） | rss | ✅ 8 |
| 竞品动态 | Steam · BALL x PIT（appid 2062430） | rss | ✅ 8 |
| 竞品动态 | Steam · Ballionaire（appid 2667120） | rss | ✅ 8 |
| 竞品动态 | Steam · Dome Keeper（appid 1637320） | rss | ✅ 8 |
| 竞品动态 | Steam · 全站新闻 | rss | ✅ 10 |
| 竞品动态 | Google News · Ball x Pit | google-news | ✅ 15 |
| 竞品动态 | Google News · Peglin | google-news | ✅ 10 |
| 技术 | Google News · html5 canvas game | google-news | ✅ 15 |
| 技术 | Google News · web game development javascript | google-news | ✅ 15 |
| 技术 | Google News · indie game development | google-news | ✅ 15 |
| 技术 | Hacker News · game engine | hn | ✅ 15 |
| 技术 | Game Developer | rss | ✅ 20 |
| UI 与美术 | Google News · indie game UI design | google-news | ✅ 15 |
| UI 与美术 | Google News · pixel art game | google-news | ✅ 15 |
| UI 与美术 | Google News · mobile game ui ux | google-news | ✅ 15 |
| UI 与美术 | 80.lv | rss | ✅ 8 |
| 手感与特效 | Google News · game feel | google-news | ✅ 15 |
| 手感与特效 | Google News · game juice | google-news | ✅ 15 |
| 手感与特效 | Google News · hit stop game feel | google-news | ✅ 12 |
| 行业动态 | GamesIndustry.biz | rss | ✅ 8 |
| 行业动态 | Rock Paper Shotgun | rss | ✅ 8 |
| 行业动态 | PC Gamer | rss | ✅ 8 |

> 三个泛行业媒体（GamesIndustry / RPS / PC Gamer）每天产量很高，`maxItems` 收到 8 是为了不让它们挤掉更贴题的分类。同理，单源截断是**先按时间倒序再取前 N 条**：Google News 的 feed 是相关性排序，直接切前 N 条会把「排在后面但其实很新」的条目丢掉（实测这一项修复让 72 小时窗口内的可用条目从 71 条涨到 83 条）。

### 实测中被剔除 / 降级的源

| 源 | 结果 | 处理 |
| --- | --- | --- |
| Reddit `r/roguelikes/top.json` | **HTTP 403**（本机直接拒绝 JSON 接口） | 弃用，改用 Atom 版 `.rss` |
| Reddit 多个 sub 连发 | **HTTP 429**（限制约 1 请求 / 数秒） | 只保留 1 个 Reddit 源并标 `optional: true` + `delayMs`；云服务器 IP 上仍可能 403/429，失败会**静默跳过**，不影响其它源 |
| `news.google.com/rss/search?q=site:reddit.com roguelike` | 返回 0 条（Google News 不支持 `site:` 定向） | 弃用 |
| Google News `game feel juice` | 75 条里 72 小时内只有 1 条 | 换成 `game feel`（72 小时 8 条） |
| Google News `particle effects game` | 72 小时内 0 条 | 换成 `game juice`（72 小时 6 条） |
| Google News `pixel art game ui` | 72 小时内 0 条 | 换成 `pixel art game`（72 小时 3 条） |
| Google News `game ui design` / `game hud design` | 168 小时内 0 条 | 改用 `mobile game ui ux` |
| `80.lv/feed/` | 301 跳转 | `fetch` 默认跟随重定向，保留 |
| Google News `game juice vfx screen shake` | 仅 2 条且最新为 7 月，接近空源 | 剔除（同类由 `game feel` / `game juice` 覆盖） |

> Reddit 的容错是有意设计的：本机能通（需错峰），但连发会被 429，云服务器 IP 还常被 403。失败只写 `digest.json.optionalFailures` 与 stderr，**不进** `digest.md` 的失败小节。

## 本地测试

```sh
node --check ops/bin/feeds/collect.mjs     # 语法检查
node ops/bin/feeds/collect.mjs --self-test # 离线自检（65 项断言，不联网）
```

`--self-test` 断言覆盖：实体/CDATA 解码、HTML 剥离、摘要按完整单词截断到 200 字符、URL 规范化、URL 与标题两级去重、发布时间倒序且无日期排最后、时间窗、`sources.json` 结构，以及 `digest.md` / `digest.json` 两个输出文件的内容与 8000 字符上限。自检期间 `fetch` 被打桩，任何网络访问都会失败。

`fixtures/` 是固化下来的离线样本（Google News / Steam / Atom / HN，日期固定），自检失败时会把临时输出目录打印出来供排查。

真实联网跑一次：

```sh
node ops/bin/feeds/collect.mjs --out /tmp/pinward-digest --hours 72 --verbose
```

## 定时任务

新加坡服务器每天早上 9 点（SGT）：

```cron
CRON_TZ=Asia/Singapore
0 9 * * * cd /srv/pinward && /usr/bin/node ops/bin/feeds/collect.mjs --out /var/log/pinward/digest-$(date +\%F) --hours 48 >> /var/log/pinward/collect.log 2>&1
```

- `--hours 48` 比默认 24 更合适：Google News 的垂直话题（如 `roguelike game design`）常常两三天才有一条新内容，24 小时窗口容易偏空。用 `ops/bin/pinward` 跑的话，改 `/etc/pinward/agent.env` 里的 `FEED_HOURS` 即可。
- Steam 竞品源（Peglin / Ballionaire / Dome Keeper 等）的官方公告更新稀疏，24~72 小时窗口下经常全被过滤掉，「竞品动态」主要靠 Google News 的 `Ball x Pit` / `Peglin` 查询兜底。想让老一点的公告也进来，给对应源加 `"maxAgeHours": 168`（7 天）。
- 需要「今天没抓到任何东西也能一眼看出」的话，可以直接看退出码或 `digest.md` 的失败小节。

## 与 ops/ 自动化流水线的集成

`ops/bin/pinward research` 每个工作日 09:00 调用本采集器，契约如下（改动 CLI 时不要破坏）：

```sh
node ops/bin/feeds/collect.mjs --out "$RUN_DIR" --date "$RUN_DATE" --hours "$FEED_HOURS" --limit "$FEED_LIMIT"
```

- `$RUN_DIR` = `/opt/pinward/state/runs/<日期>/`，`$FEED_HOURS` / `$FEED_LIMIT` 默认 24 / 60。
- `digest.md` 会被原样拼进研究阶段的 prompt，`ops/prompts/research.md` 要求模型**逐字**引用其中的链接作为 `evidence`。
- `digest.json` 交给 `ops/bin/validate.mjs` 做来源真实性校验：模型给回的每个 `evidence[].url` 必须能在 `digest.json` 的 `items[].url` 里找到，否则判定「编造来源」。
- 因此 **`digest.md` 里的链接必须与 `digest.json` 逐字一致**，不能加 `<>` 包裹、不能改写或百分号编码；采集失败时 `digest.md` 末尾的「本次抓取失败」小节就是 `ops/README.md` 故障排查表指向的地方。
- 采集器返回非 0 会让 `pinward research` 直接 `die`，所以「全部源失败」才返回 1，部分源失败仍是 0。

> 注意 `ops/` 是 `CLAUDE.md` 与 `validate.mjs` 里的受保护路径，自动化实现 agent 的提交会被拒绝；本目录只能由人工评审后合入。

## 注意

- 脚本只在 `--out` 目录内写入；若 `--out` 落在仓库里会打一条 stderr 警告，建议用仓库外路径。
- 上游接口（Google News / Steam / Reddit）可能随时变更或限流，某个源挂了不会影响其他源，但应定期看 `digest.md` 末尾的失败小节。
