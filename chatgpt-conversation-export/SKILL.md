---
name: chatgpt-conversation-export
description: >
  Export/backup ChatGPT conversations from the user's own Chrome via the OMP
  browser relay — full history (bypasses frontend lazy-loading), voice-mode
  transcriptions, and attached files, rendered to Markdown. Use when the user
  asks to 扒取/导出/备份/保存 a ChatGPT 对话 (incl. 语音聊天记录), or download
  files attached in a conversation that lacks a share/export button. Requires
  the user's Chrome running with the OMP Browser Relay extension loaded.
  ChatGPT 对话导出：通过用户自己的 Chrome（relay 扩展）抓取完整对话（含语音转录）
  与附件，输出 Markdown。

metadata: {"openclaw":{"emoji":"💬","privacy":"Runs entirely inside the user's own Chrome session; nothing leaves the machine. Only the user's own conversation data is read, via the same authenticated endpoints the page itself uses.","requires":{"chrome":["relay extension installed"]},"optional":{}}}

allowed-tools: Bash(node:*)
---

# ChatGPT conversation export (via user's Chrome)

Pull a full ChatGPT conversation — including voice-mode transcriptions and
attached files — straight from the user's authenticated browser, then render
it as Markdown. No share button needed; no official export flow needed.

## When to use

- User wants to 扒取 / 导出 / 备份 / 保存 a ChatGPT conversation (custom GPT
  conversations have no share/export button).
- User wants the voice-chat transcript (语音模式聊天记录) from their own account.
- User wants files attached inside a conversation downloaded locally.

Do NOT use for: scraping *other* people's conversations (won't work anyway —
auth-bound), or conversations the user cannot open in their own browser.

## Hard-won facts (do not rediscover)

These were all empirically verified on chatgpt.com, 2026-08. Deviating from
them wastes minutes per attempt:

1. **Frontend lazy-loading is a dead end.** The conversation DOM shows only
   ~6 turns no matter how you scroll (newer turns are virtualized; older
   turns are loaded on demand). Do not try scroll loops — they stall at 6.
2. **The full data lives at one authenticated API endpoint:**
   `GET https://chatgpt.com/backend-api/conversation/{conversation_id}`
   Returns the complete `mapping` (message tree), including voice
   transcriptions. This is the single source of truth — one request, all
   messages, no scrolling.
3. **Plain `fetch` from the page context returns 404** for that endpoint
   (missing `authorization` header — the page adds a `Bearer` token the
   page's JS holds, not in localStorage). Do NOT fight this: **let the page
   make the request itself and capture it over CDP**
   (`Network.responseReceived` → `Network.getResponseBody`). The page
   reloads → issues its own authenticated request → CDP hands you the body.
   Zero token handling.
4. **Attachment download chain** (direct `/backend-api/files/{id}/download`
   is a 404 dead end):
   a. `GET /backend-api/files/download/{fid}?inline=true&download_intent=false&check_context_scopes_for_conversation_id={cid}`
      (needs `authorization` — capture it from any page API request header
      via CDP) → JSON `{ "download_url": "…/estuary/content?id=…&sig=…" }`
   b. `GET` that signed `download_url` (no auth needed) → file bytes.
   If the signed URL is stale (404), re-fetch step (a) for a fresh one.
5. **Message content types**: typed messages are `content_type === "text"`
   with plain-string `parts`; voice is `"multimodal_text"` with parts
   `{ content_type: "audio_transcription", text, direction }`
   (`in` = user said it, `out` = assistant said it); image-generation
   requests are `content_type === "code"` (render as a fenced code block with
   `language`); `role: "tool"` nodes are mostly internal noise but may carry
   generated images (see fact 9).
6. Message order = tree order via `mapping[node].parent` (DFS from the root
   node whose `parent` is null). `create_time` is a Unix epoch seconds.
7. **Math delimiters**: ChatGPT stores LaTeX as `\(...\)` (inline) and
   `\[...\]` (block, often multi-line). Most Markdown renderers (Obsidian,
   VS Code preview, GitHub) only render `$...$` / `$$...$$`. convert.mjs
   normalizes them with a pairwise scanner (handles nesting & multi-line
   blocks, leaves stray backslashes alone).
8. **KaTeX auto-render gotcha**: only configure `$` and `$$` delimiters in
   the HTML view. Including `\[`/`\(` makes auto-render eat plain-text
   brackets — ChatGPT's entity annotations (`\ue200entity\ue202["people",…]\ue201`)
   got rendered as math. Since convert.mjs already normalizes `\(`/`\[` to
   `$`/`$$`, the narrower delimiter set loses nothing.
9. **GPT/DALL-E generated images** live in *tool* messages'
   `content.parts[].image_asset_pointer` (`asset_pointer: "sediment://file_…"`,
   `metadata.dalle.gen_id`), NOT in `metadata.attachments`. Grab them with the
   same files/download chain, name them `<gen_id>.png`, and dedupe against
   attachment file ids (the same file can appear both as an upload and as an
   asset_pointer). convert.mjs attaches them to the *preceding* assistant
   message (the one that issued the generation request).
10. **`file://` pages share one localStorage origin** — marks and panel
    collapse state from one conversation leak into every other exported HTML.
    All localStorage keys must be suffixed with the conversation id
    (`chatgpt-export-marks-<cid>` etc.). Do NOT migrate the old unsuffixed
    key: it holds another conversation's marks (shared origin), so a
    "one-time migration" leaks them into every new export. Clear the stale
    unsuffixed keys once instead.
11. **browser.run cleanup**: at run end the tool always calls
    `page.setRequestInterception(false)`; if the page is still busy (large
    base64 transfers just finished) it times out and reports
    "Failed to clear browser request interception" — harmless, but avoidable:
    finish with `Network.disable` + `client.detach()` + ~1.2s idle sleep.
    When it fires, the run block's **return value is swallowed too**. That is
    why grab.mjs persists `raws/<cid>/summary.json` and prints
    `GRAB_SUMMARY …` — ALWAYS verify from the file, never from the run output.
12. **Tab may drift away**: if the user navigates their Chrome elsewhere,
    the grabber must verify `location.href` contains the cid and `page.goto`
    back before reloading; if the conversation request is still not observed
    (SPA cache), fall back to `fetch`ing the endpoint directly with the CDP-
    captured `authorization` header.
13. **`xd://` write validation is flaky**: the `write` tool targeting
    `xd://browser` intermittently rejects args that lack a `path` field
    ("path must be file path"), even when an earlier identical call passed.
    The reliable form is `path` as a **TOP-LEVEL parameter of the write
    call** (`path: "xd://browser"` next to `content`, NOT inside the JSON
    args). On "Validation failed" retry the same call once — it goes through.
14. **Stale relay tab → attach error**: `Protocol error (Target.attachToTarget)`
    means the previously adopted tab is gone (user navigated/closed it).
    Recovery: `close` (`all: true, kill: false`), then `open` again. The
    relay re-adopts the *currently visible* tab, which may not be
    chatgpt.com — that's fine, the grabber self-navigates (fact 12).
15. **Verification selectors (exact — do not guess)**: HTML sidebar links use
    classes `side-item` / `side-title` — there is NO `.sidebar` class; count
    anchors with `a[href^="#"]`. Turns live in `.turn`, images in
    `.turn img`, KaTeX output in `.katex`. When embedding verification code
    inside tool args, NEVER write literal `\(`, `\[`, or `\\` (invalid JSON
    escapes) — build the backslash as `String.fromCharCode(92)`.
16. **Bulk/batch pattern (list + fetch beats reloads)**: the conversation
    LIST endpoint is `GET /backend-api/conversations?offset=0&limit=100&order=updated`
    (auth'd; items carry `gizmo_id`, `is_archived`, `snippet` etc. — useful
    for screening titles without opening chats). For grabbing many
    conversations, do NOT chain reloads: same-origin SPA navigations and
    reloads get served from bfcache and the conversation request is silently
    swallowed (only ~30% of reloads fire it). Instead capture the
    `authorization` header once (any backend-api request), then
    `fetch('/backend-api/conversation/{cid}')` from the page context for
    each cid — deterministic, no reloads. This is grab.mjs's own fallback.
17. **Custom GPT conversations need the gizmo prefix**: a conversation whose
    list item has `gizmo_id` lives at `/g/{gizmo_id}/c/{cid}`; navigating to
    bare `/c/{cid}` may not render it. When fetching directly (fact 16) the
    plain `/backend-api/conversation/{cid}` endpoint still works regardless.

## One-shot runbook (fresh conversation — do NOT improvise)

Execute exactly these steps; each has a deterministic success check. Anything
outside this list is rework:

1. `write` `xd://browser` with `{"action":"open","app":{"relay":true},"path":"xd://browser"}`
   (the `path` field is required — fact 13). Success = a tab line with a URL.
   On "extension never connected" → redo Step 0.3. On "Validation failed" →
   retry once unchanged. On attach/Protocol error → `close` (`all:true,
   kill:false`) then `open` again (fact 14).
2. `write` `xd://browser` a `run` block that evals grab.mjs with
   `__GRAB_ARGS = { url, outDir }` (template in Step 1). The user sees one
   tab flash/reload — expected.
3. **Ignore the run's return value** (fact 11). Success check, from disk:
   `raws/<cid>/<cid>.json` exists AND `raws/<cid>/summary.json` shows every
   `attachments[].saved` truthy and no `error`. Only if summary.json is
   missing or shows errors, re-run the grab once.
4. Run convert.mjs (Step 2). Success check: convert prints
   用户 + 助手 + 跳过内部消息 == summary `messageCount`, and
   附件 == number of attachment entries.
5. Disk verify (Step 3 items 1–3): counts, attachment files, MD first/last
   turns.
6. HTML verify with the exact snippet from Step 3 item 4 (selectors per
   fact 15). Then you are done — do not iterate on the page.

## Workflow

### Step 0 — Prerequisites (one-time)

1. Install the relay extension: `omp browser-relay install`
2. Enable: `omp config set browser.relay true`
3. Have the user load the extension once in Chrome:
   `chrome://extensions` → Developer mode → "Load unpacked" →
   `C:\Users\<用户名>\.omp\browser-relay\extension` (badge shows **on**).
4. Verify: `browser` tool `open` with `app: { relay: true }` succeeds.

The user must be logged in to chatgpt.com in that Chrome.

### Step 1 — Grab the conversation JSON + attachments

Open the conversation page, then eval the grabber in a `browser` `run` block:

```js
const fs = require('node:fs');
globalThis.__GRAB_ARGS = {
  url: 'https://chatgpt.com/g/g-p-xxxx/c/6a78b41e-…', // the conversation URL
  outDir: 'C:/tmp/chatgpt_export',                     // export root dir
};
const grabber = fs.readFileSync(
  'C:/Users/<用户名>/.omp/agent/skills/chatgpt-conversation-export/scripts/grab.mjs', 'utf8');
const summary = await eval(grabber);
summary;
```

Output layout under `outDir`:

```
<outDir>/
  raws/<conversation_id>/<conversation_id>.json   raw API payload
  raws/<conversation_id>/summary.json             grab summary (counts, roles, per-attachment status)
  raws/<conversation_id>/attachments/…         attachments (uploaded + DALL-E)
```

The grabber navigates to the URL if the tab is elsewhere, reloads the page
and captures the page's own authenticated request — the user will see the
tab flash/reload once. If the request is not observed (SPA cache), it falls
back to fetching the conversation endpoint directly with the captured
`authorization` header. Attachments include both `metadata.attachments`
(uploads) and `content.parts[].image_asset_pointer` (GPT/DALL-E generated
images, named `<gen_id>.png`), deduped by file id.

The run block's return value may be lost to the cleanup warning (fact 11);
grab.mjs persists `raws/<cid>/summary.json` (message counts, role/content
histograms, per-attachment download status) and prints `GRAB_SUMMARY …`.
Verify from that file on disk — never from the run's output.

### Step 2 — Render Markdown + HTML

```bash
node C:/Users/<用户名>/.omp/agent/skills/chatgpt-conversation-export/scripts/convert.mjs \
  C:/tmp/chatgpt_export/raws/6a78b41e-…/6a78b41e-….json C:/tmp/chatgpt_export '<对话URL>'
```

Produces under the same export root:

```
<outRoot>/
  mds/<title>.md      chat-style Markdown
  htmls/<title>.html  self-contained reading view
  raws/<cid>/…        unchanged raw data (referenced via ../raws/<cid>/attachments/)
```

- **`mds/<title>.md`** — chat-style Markdown. Plain-text user messages are
  collapsible `<details>` groups (summary shows the question, body right-
  aligned); messages containing math stay as plain markdown paragraphs so
  `$...$` formulas render in VS Code; image attachments are inlined
  (`<img>` inside `<details>`, `![](../raws/<cid>/attachments/file)` in markdown
  paragraphs).
- **`htmls/<title>.html`** — self-contained reading view for any browser:
  fixed left sidebar listing every user question as a jump anchor (click
  scrolls to that turn, current turn highlighted on scroll), all turns fully
  expanded, user bubbles right-aligned / assistant left-aligned, formulas
  rendered by KaTeX (marked + KaTeX loaded from CDN with unpkg fallback;
  falls back to raw text offline). Marks/collapse state are stored under
  `localStorage` keys suffixed with the conversation id — `file://` pages
  share one origin, so without the suffix marks leak across conversations.

Math delimiters are normalized to `$`/`$$` in both outputs (see fact 7).

### Step 3 — Verify (always; from disk, never from the run's return value)

1. Cross-check `raws/<cid>/summary.json` against convert's output:
   summary `messageCount` == convert 用户 + 助手 + 跳过内部消息;
   `roles` shows user ≈ assistant; `contentTypes` tells the chat kind
   (`text` = typed, `multimodal_text` = voice).
2. Attachment check: every `attachments[]` entry has truthy `saved`; the file
   exists under `raws/<cid>/attachments/` with non-trivial size (PNG byte-
   identical to metadata; JPEG may be re-encoded smaller — verify the `FF D8`
   header and dimensions instead of byte count).
3. Spot-check the first turn (usually the opener + attachments) and the last
   turn (the farewell) in `mds/<title>.md`.
4. Open `htmls/<title>.html` in the relay tab and run this exact check
   (selectors per fact 15; note `String.fromCharCode(92)` — never literal
   backslashes in tool args):

```js
// in a browser run block, after page.goto(file://…/htmls/<title>.html) + ~4s settle:
await tab.evaluate(() => {
  const BS = String.fromCharCode(92);
  const imgs = [...document.querySelectorAll('.turn img')];
  const broken = imgs.filter(i => !i.complete || i.naturalWidth === 0).length;
  const rawMath = [...document.querySelectorAll('.turn')].filter(t =>
    t.textContent.includes('$$') || t.textContent.includes(BS + '(') || t.textContent.includes(BS + '[')).length;
  return {
    title: document.title,
    turns: document.querySelectorAll('.turn').length,
    anchors: document.querySelectorAll('a[href^="#"]').length,
    imgs: imgs.length, broken,
    katex: document.querySelectorAll('.katex').length,
    rawMathLeft: rawMath,
  };
});
```

   Success: `anchors` == summary `roles.user` (every user question has a
   sidebar jump anchor), `imgs` >= attachment count with `broken == 0`
   (relative `../raws/<cid>/attachments/` paths resolve), `katex > 0`,
   `rawMathLeft == 0`. `turns` should also equal `roles.user`; if it does
   not, do not guess — re-run the snippet with `.turn` counts dumped.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `browser` open fails: "extension never connected" | Relay extension not loaded in Chrome; redo Step 0.3 |
| grabber: "conversation request not observed" | Grabber already auto-navigates to the URL and falls back to direct fetch; if it still fails the user is not logged in or the cid is wrong. Check `tab.evaluate(() => document.title)` and re-run. |
| `{cid}.json` saved but attachment shows `error: no download_url` | Missing `authorization` (authPromise timed out). Re-run grabber — it reloads and re-captures; or click a file tile in the page to force an authenticated request, then re-run. |
| attachment `saved: false` / stale URL | Grabber retries with re-signing automatically; if still failing, download chain may have changed — capture the page's own download request via CDP (`Network.requestWillBeSent` for `/files/download/`) and follow its headers/redirects. |
| attachment saved size ≠ metadata `size` (JPEG) | Expected. OpenAI re-encodes uploaded JPEGs on ingest (e.g. 2.4 MB → 290 KB, same dimensions); PNGs are stored losslessly (byte-identical). The downloaded file IS the server-side original — nothing more is available. Verify the JPEG header (`FF D8`) and dimensions instead of byte count. |
| convert: counts mismatch | Some nodes have no `message` (children pointers). 178 visible = 87 user + 88 assistant + 3 tool is the expected shape for a voice dialogue. |
| "Failed to clear browser request interception after browser.run" | Harmless tool cleanup warning; grabber's `Network.disable` + detach + 1.2s idle buffer usually prevents it. **It also swallows the run's return value** — verify from `raws/<cid>/summary.json`, never the run output. No data impact either way. |
|HTML shows previous conversation's marks|localStorage under `file://` is origin-global; re-run convert.mjs (keys are now cid-suffixed) and clear the old `chatgpt-export-marks` key once.|
|公式含单独一行的 `=`/`-` 时渲染失败|语音转写常把运算符独占一行;CommonMark 把它当 setext 标题下划线,`$$` 块被吞成 `<h1>`。convert.mjs 会在 `$$` 块内给这类行补 ` %`(LaTeX 注释)防误判,重新转换即可。|
|HTML 里个别公式显示原始 `$$...$$`|marked 把公式里的 `_` 当强调标记(如 `E_{\tau\sim\pi_\theta}` 的 `_` 对变 `<em>`),`$$` 块被拆碎。convert.mjs 在 marked 前对数学做占位保护,重新转换即可。|
|公式含裸中文(如 `\underbrace{A}_{力度}`)不渲染|KaTeX/MathJax 数学模式无 CJK 字形,convert.mjs 自动把数学内的中文包进 `\text{...}`(已在 `\text` 内的不动),重新转换即可。|

## Notes

- The raw JSON is the authoritative artifact — keep it; the Markdown/HTML are
  renderings. If the renderer changes later, re-run convert.mjs on the JSON.
- Large attachments are base64-transferred through the page context; a few
  MB is fine, tens of MB may need chunked transfer (grabber chunks at 0x8000).
- Timezone: convert.mjs renders timestamps in UTC+8 (China). Adjust the
  `+ 8 * 3600e3` offset if the user is elsewhere.
- HTML view performance for long conversations: KaTeX renders with
  `output: 'html'` (skips the MathML double DOM), marked/KaTeX run in
  requestIdleCallback chunks (~12 ms each) so the page stays interactive
  while formulas stream in, and `.turn` uses `content-visibility: auto` so
  off-screen turns skip layout. Sidebar jumps use `behavior: 'instant'` —
  no smooth-scroll animation, no transition frames.
- HTML view features: left sidebar = question anchors (☆ = mark, marks get
  tags/delete in the right panel, both panels collapsible), image lightbox
  (wheel zoom / drag pan / rotate buttons), copy buttons (⧉) for message
  markdown, tables/code blocks, and formulas (LaTeX source, \boxed kept).
