#!/usr/bin/env node
/**
 * convert.mjs — ChatGPT conversation JSON (from /backend-api/conversation/{id})
 * → readable transcript in two formats:
 *   1. Markdown (chat-style: plain user messages collapsible <details>,
 *      math messages kept as markdown so $ formulas render in VS Code)
 *   2. Self-contained HTML (chat bubbles, per user↔assistant turn, formulas
 *      via KaTeX + marked from CDN) — open in any browser
 *
 * Directory layout:
 *   <outRoot>/htmls/<title>.html
 *   <outRoot>/mds/<title>.md
 *   <outRoot>/raws/<cid>/<cid>.json        (input)
 *   <outRoot>/raws/<cid>/attachments/<attachments>
 *
 * Usage:
 *   node convert.mjs <input.json> <outRoot> [conversation_url]
 *
 * Exit 0 on success, 2 on arg error.
 */
import fs from 'node:fs';
import path from 'node:path';

const [, , inPath, outRoot, convUrl] = process.argv;
if (!inPath || !outRoot) {
  console.error('usage: node convert.mjs <input.json> <outRoot> [conversation_url]');
  process.exit(2);
}
if (!fs.existsSync(inPath)) {
  console.error('input json not found: ' + inPath);
  process.exit(2);
}

// conversation id：优先从 URL 提取，其次从 raws/<cid>/ 目录推断
let cid = null;
const urlMatch = convUrl ? convUrl.match(/\/c\/([0-9a-f-]{36})/) : null;
if (urlMatch) cid = urlMatch[1];
if (!cid) {
  const parent = path.basename(path.dirname(inPath));
  if (/^[0-9a-f-]{36}$/.test(parent)) cid = parent;
}
if (!cid) {
  console.error('cannot determine conversation id (pass conversation_url)');
  process.exit(2);
}
const attachRel = path.join('raws', cid, 'attachments'); // 相对 htmls/ 与 mds/ 的附件目录

const data = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const mapping = data.mapping || {};
if (!Object.keys(mapping).length) {
  console.error('no mapping in ' + inPath);
  process.exit(2);
}

// --- Rebuild chronological order via parent chain (DFS from root(s)) ---
const byParent = new Map();
for (const node of Object.values(mapping)) {
  const p = node.parent ?? null;
  if (!byParent.has(p)) byParent.set(p, []);
  byParent.get(p).push(node);
}
const order = [];
const walk = (pid) => {
  for (const node of byParent.get(pid) ?? []) {
    order.push(node);
    if (node.id) walk(node.id);
  }
};
walk(null);
const inOrder = new Set(order.map((n) => n.id));
for (const node of Object.values(mapping)) {
  if (!inOrder.has(node.id) && node.message) order.push(node); // orphans fallback
}

// --- Extract visible messages ---
const roleLabel = { user: '用户', assistant: '助手', tool: '系统' };

/**
 * Normalize LaTeX delimiters: \(...\) → $...$, \[...\] → $$...$$.
 * ChatGPT stores math with \( \) and \[ \] delimiters, which most Markdown
 * renderers (Obsidian, VS Code preview) do not render; $ and $$ are
 * universally supported. Pairwise scan, handles multi-line block math.
 */
function normalizeFormulas(s) {
  const out = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < n && (s[i + 1] === '(' || s[i + 1] === '[')) {
      const delim = s[i + 1];
      const close = delim === '(' ? ')' : ']';
      const dollar = delim === '(' ? '$' : '$$';
      let j = i + 2;
      let depth = 1;
      while (j < n - 1 && depth > 0) {
        if (s[j] === '\\' && s[j + 1] === close) { depth--; j += 2; }
        else if (s[j] === '\\' && s[j + 1] === delim) { depth++; j += 2; }
        else j++;
      }
      if (depth === 0) {
        out.push(dollar, s.slice(i + 2, j - 2), dollar);
        i = j;
      } else {
        out.push('\\', delim);
        i += 2;
      }
    } else {
      out.push(ch);
      i++;
    }
  }
  return out.join('');
}

/**
 * CommonMark setext-heading hazard: inside a $$...$$ block, a line that is
 * exactly `=` or `-` (voice dictation puts operators on their own line) is
 * parsed as a setext heading underline — marked/markdown-it/Obsidian swallow
 * `$$` + the preceding line into an <h1>/<h2> and the formula never renders.
 * Append ` %` (a LaTeX comment) so the line is no longer a valid underline;
 * KaTeX eats the comment + newline, so rendering is unchanged.
 */
function protectSetextInMath(s) {
  return s.replace(/\$\$([\s\S]*?)\$\$/g, (m, inner) =>
    '$$' + inner.replace(/^([=\-]+)[ \t]*$/gm, '$1 %') + '$$');
}

/**
 * KaTeX/MathJax 数学模式不含 CJK 字形：裸中文（语音转写常见，如
 * \underbrace{A}_{力度}）会让整条公式解析失败，必须包进 \text{...}。
 * 已在 \text{...} 内的中文不动（含嵌套），并吞掉中文后随的中日韩标点。
 */
function wrapCjkInMath(s) {
  const cjk = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;
  return s.replace(/\$\$[\s\S]*?\$\$|\$[^$\n]*?\$/g, (m) => {
    let out = '';
    let i = 0;
    const n = m.length;
    while (i < n) {
      if (m.startsWith('\\text{', i)) {
        let j = i + 6;
        let depth = 1;
        while (j < n && depth > 0) {
          if (m[j] === '{') depth++;
          else if (m[j] === '}') depth--;
          j++;
        }
        out += m.slice(i, j);
        i = j;
        continue;
      }
      if (cjk.test(m[i])) {
        let j = i;
        while (j < n && cjk.test(m[j])) j++;
        out += '\\text{' + m.slice(i, j) + '}';
        i = j;
        continue;
      }
      out += m[i];
      i++;
    }
    return out;
  });
}

const ts = (t) =>
  t ? new Date(t * 1000 + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : '';

// turns: [{ role, n, time, voice, text, attach: [{name, kb}] }]
const turns = [];
let userN = 0, asstN = 0, toolN = 0;
let pendingGen = []; // tool 消息中的生成图
let lastAsstIdx = null; // turns 中最近的助手消息索引
for (const node of order) {
  const msg = node.message;
  if (!msg) continue;
  const role = msg.author?.role;
  const c = msg.content ?? {};
  const ct = c.content_type;
  const collectGen = (plist) => {
    const out = [];
    for (const p of plist) {
      if (p?.content_type === 'image_asset_pointer' && p.asset_pointer) {
        // GPT/DALL-E 生成图：sediment://file_xxx → 文件名与 grab.mjs 落盘一致
        const m = String(p.asset_pointer).match(/^sediment:\/\/(file_[0-9a-f]+)$/);
        if (m) {
          const genId = p.metadata?.dalle?.gen_id;
          const name = (genId ? genId + '.png' : m[1] + '.png');
          out.push({ name, kb: ((p.size_bytes ?? 0) / 1024).toFixed(0) });
        }
      }
    }
    return out;
  };
  if (role === 'tool') {
    toolN++;
    const gens = collectGen(c.parts ?? []);
    if (gens.length) {
      // 挂到 tool 之前最近的助手消息（发出生成请求的那条）
      if (lastAsstIdx !== null) {
        for (const g of gens) {
          turns[lastAsstIdx].attach.push({ name: g.name, kb: g.kb, fsName: g.name, isImage: true });
        }
      } else {
        pendingGen = pendingGen.concat(gens); // 兜底：留给下一条助手
      }
    }
    continue;
  }

  const attach = (msg.metadata?.attachments ?? []).map((a) => ({
    name: a.name,
    kb: ((a.size ?? 0) / 1024).toFixed(0),
    // grab.mjs 落盘时用同样规则清理文件名
    fsName: String(a.name ?? '').replace(/[\\/:*?"<>|]/g, '_'),
    isImage: /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(String(a.name ?? '')),
  }));

  // 消息文本与生成图收集
  const parts = [];
  let isVoice = false;
  const collectParts = (plist) => {
    for (const p of plist) {
      if (typeof p === 'string' && p.trim()) parts.push(p);
      else if (p?.content_type === 'audio_transcription' && p.text) {
        isVoice = true;
        parts.push(p.text);
      }
    }
  };
  if (ct === 'text') {
    collectParts(c.parts ?? []);
  } else if (ct === 'multimodal_text') {
    collectParts(c.parts ?? []);
  } else if (ct === 'code') {
    // 图像/工具生成参数（如 dalle 请求 JSON）
    const lang = c.language || '';
    parts.push('```' + lang + '\n' + (c.text ?? '') + '\n```');
  } else {
    continue; // tether_browsing_display 等内部内容
  }
  const text = wrapCjkInMath(protectSetextInMath(normalizeFormulas(parts.join('\n\n')))).trim();
  const genAttach = pendingGen.map((g) => ({ name: g.name, kb: g.kb, fsName: g.name, isImage: true }));
  pendingGen = [];
  const allAttach = attach.concat(genAttach);
  if (!text && !allAttach.length) continue;

  if (role === 'user') userN++;
  else if (role === 'assistant') asstN++;
  turns.push({
    role,
    n: role === 'user' ? userN : asstN,
    time: ts(msg.create_time),
    voice: isVoice,
    text,
    attach: allAttach,
  });
  if (role === 'assistant') lastAsstIdx = turns.length - 1;
}
if (!turns.length) {
  console.error('no visible messages in ' + inPath);
  process.exit(2);
}

const title = data.title || 'ChatGPT 对话';
const link =
  convUrl ||
  (data.id ? `https://chatgpt.com/c/${data.id}` : 'https://chatgpt.com');
const headerInfo = (t) =>
  `${roleLabel[t.role]}${t.voice ? '（语音）' : ''} #${t.n}  ${t.time}`;

// ============================ Markdown output ============================
// 输出布局：<outRoot>/mds/<title>.md  +  <outRoot>/htmls/<title>.html
const safeTitle = String(title).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
const htmlsDir = path.join(outRoot, 'htmls');
const mdsDir = path.join(outRoot, 'mds');
fs.mkdirSync(htmlsDir, { recursive: true });
fs.mkdirSync(mdsDir, { recursive: true });
const mdPath = path.join(mdsDir, safeTitle + '.md');
const htmlPath = path.join(htmlsDir, safeTitle + '.html');
const attachPre = '../' + attachRel.split(path.sep).join('/');
const attachCount = turns.reduce((n, t) => n + t.attach.length, 0);

const lines = [];
lines.push(`# ${title}（ChatGPT 语音对话导出）`, '');
lines.push(`- 对话链接：${link}`);
lines.push(`- 消息统计：用户 ${userN} 条、助手 ${asstN} 条${toolN ? `、内部消息 ${toolN} 条` : ''}`);
lines.push(`- 导出时间：${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, '');

for (const t of turns) {
  const h = headerInfo(t);
  // 图片附件行：md 段落内用 ![]() 语法；details 块内用 <img>（VSCode 中 details 内 markdown 不解析，但 HTML 渲染）
  // 附件位于 ../raws/<cid>/attachments/（相对 mds/ 目录）
  const imgMd = t.attach.filter((a) => a.isImage).map((a) => `![${a.name}](${attachPre}/${a.fsName})`).join('\n\n');
  const imgHtml = t.attach.filter((a) => a.isImage).map((a) => `<img src="${attachPre}/${a.fsName}" alt="${a.name}">`).join('<br>');
  const otherAtt = t.attach.filter((a) => !a.isImage);
  const attLines = otherAtt.map((a) => `> 附件：\`${a.name}\`（${a.kb} KB）`).join('\n');
  if (t.role === 'user') {
    // 聊天布局：用户消息折叠组 + 右对齐。
    // VSCode 中 <details>/<div> 块内 markdown 与公式不解析，故：
    //  - 纯文本消息 → <details> 折叠（summary 显示问题摘要），内容 <div align="right">
    //  - 含公式消息 → 保持 markdown 段落（公式必须可渲染）
    if (!/[$\\]/.test(t.text)) {
      const esc = t.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const body = esc.replace(/\n{2,}/g, '<br><br>').replace(/\n/g, '<br>');
      const summary = esc.replace(/<br>/g, ' ').replace(/\s+/g, ' ').trim();
      lines.push('<details>', '');
      lines.push(`<summary><b>${h}</b>　${summary.slice(0, 60)}${summary.length > 60 ? '…' : ''}</summary>`, '');
      lines.push('', `<div align="right" style="text-align:right">`, '');
      lines.push(`<b>${h}</b><br>`, '');
      lines.push(body, '');
      if (imgHtml) lines.push('', imgHtml);
      if (attLines) lines.push('', attLines);
      lines.push('', `</div>`, '', `</details>`, '');
    } else {
      lines.push(`## ${h}`, '');
      lines.push(t.text, '');
      if (imgMd) lines.push('', imgMd);
      if (attLines) lines.push('', attLines);
    }
  } else {
    lines.push(`## ${h}`, '');
    lines.push(t.text, '');
    if (imgMd) lines.push('', imgMd);
    if (attLines) lines.push('', attLines);
  }
}
fs.writeFileSync(mdPath, lines.join('\n'), 'utf8');

// ============================= HTML output =============================
// 自包含单文件：CDN 加载 marked + KaTeX（带 unpkg 备用源），
// 每轮对话一个 <details>（默认折叠，summary 显示用户问题摘要），
// 用户消息右对齐气泡、助手消息左对齐气泡，公式完整渲染。

const stripMd = (s) =>
  s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#*_>|]/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/\$[^$\n]*\$/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// 组装轮次数据：每轮 = 一个用户消息 + 随后的助手消息（可能多条助手）
// 附件相对路径（HTML 位于 htmls/，附件位于 raws/<cid>/attachments/）
const attachHrefBase = '../' + attachRel.split(path.sep).join('/') + '/';
const htmlTurns = [];
let cur = null;
for (const t of turns) {
  if (t.role === 'user') {
    cur = { user: t, assts: [], q: stripMd(t.text).slice(0, 60) };
    htmlTurns.push(cur);
  } else if (cur) {
    cur.assts.push(t);
  } else {
    // 无用户消息的孤儿助手消息
    cur = { user: null, assts: [t], q: '' };
    htmlTurns.push(cur);
  }
}
// 给每个附件补充浏览器端引用路径
for (const turn of htmlTurns) {
  for (const t of [turn.user, ...turn.assts]) {
    if (t?.attach) for (const a of t.attach) a.href = attachHrefBase + a.fsName;
  }
}

const jsonData = JSON.stringify({
  cid,
  title,
  link,
  exported: new Date().toISOString().slice(0, 16).replace('T', ' '),
  userN,
  asstN,
  turns: htmlTurns,
}).replace(/</g, '\\u003c');

const css = `
* { box-sizing: border-box; }
html, body { height: 100%; overflow: hidden; }
body { margin: 0; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; background: #f0f2f5; color: #1f2328; }
#sidebar { position: fixed; top: 0; left: 0; bottom: 0; width: 300px; background: #f8fafc; color: #1f2937; border-right: 1px solid #e5e7eb; overflow-y: auto; padding: 14px 0 40px; z-index: 10; }
#sidebar.collapsed { width: 44px; overflow: hidden; }
#sidebar .side-title { padding: 4px 18px 12px; font-weight: 700; font-size: .95em; border-bottom: 1px solid #e5e7eb; margin-bottom: 8px; color: #111827; }
#sidebar.collapsed .side-title, #sidebar.collapsed .side-item { display: none; }
.side-item { display: block; padding: 8px 18px; font-size: .82em; color: #374151; text-decoration: none; line-height: 1.45; border-left: 3px solid transparent; cursor: pointer; }
.side-item:hover { background: #eef2f7; color: #111827; }
.side-item.active { background: #e0f2fe; border-left-color: #0ea5e9; color: #0c4a6e; }
.side-item .sn { color: #6b7280; margin-right: 6px; font-size: .78em; }
#content { margin-left: 300px; margin-right: 250px; padding: 24px 28px 80px; height: 100%; overflow-y: auto; }
#content.no-side { margin-left: 44px; }
#content.no-marks { margin-right: 44px; }
#app { max-width: 860px; margin: 0 auto; }
h1 { font-size: 1.4em; margin: 0 0 4px; }
.meta { color: #666; font-size: .85em; margin-bottom: 20px; word-break: break-all; }

/* 面板折叠按钮 */
.panel-toggle { position: absolute; top: 10px; right: 10px; z-index: 11; font-size: .85em; color: #6b7280; background: #fff; border: 1px solid #d1d5db; border-radius: 6px; padding: 2px 9px; cursor: pointer; }
.panel-toggle:hover { background: #eef2f7; }
#marks .panel-toggle { right: auto; left: 10px; }

/* 右侧标记面板 */
#marks { position: fixed; top: 0; right: 0; bottom: 0; width: 250px; background: #f8fafc; border-left: 1px solid #e5e7eb; overflow-y: auto; padding: 14px 0 40px; z-index: 10; }
#marks.collapsed { width: 44px; overflow: hidden; }
#marks.collapsed .marks-title, #marks.collapsed .mark-item, #marks.collapsed .empty { display: none; }
.marks-title { display: flex; align-items: center; gap: 8px; padding: 4px 18px 12px; font-weight: 700; font-size: .95em; border-bottom: 1px solid #e5e7eb; margin-bottom: 8px; color: #111827; }
.marks-title .clear-marks { margin-left: auto; font-size: .72em; color: #6b7280; background: none; border: 1px solid #d1d5db; border-radius: 6px; padding: 2px 8px; cursor: pointer; }
.marks-title .clear-marks:hover { background: #fee2e2; border-color: #f87171; color: #b91c1c; }
.mark-item { display: block; padding: 6px 18px 7px; font-size: .8em; color: #374151; text-decoration: none; line-height: 1.45; border-left: 3px solid transparent; cursor: pointer; position: relative; }
.mark-item:hover { background: #eef2f7; }
.mark-item .mtag { display: inline-block; background: #fef3c7; color: #92400e; border-radius: 4px; padding: 0 6px; font-size: .75em; cursor: text; line-height: 1.5; }
.mark-item .mtag.empty { background: #fff; border: 1px dashed #d1d5db; color: #9ca3af; min-width: 22px; text-align: center; }
.mark-item .mtag:hover { background: #fde68a; }
.mark-item .m-q { display: block; margin-top: 2px; padding-right: 20px; color: #4b5563; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mark-item .m-del { position: absolute; right: 8px; top: 6px; background: none; border: none; color: #c0c7d0; font-size: 1em; cursor: pointer; padding: 0 4px; opacity: 0; transition: opacity .12s; }
.mark-item:hover .m-del { opacity: 1; }
.mark-item .m-del:hover { color: #dc2626; }
.mark-item .m-edit { width: 110px; font-size: .78em; border: 1px solid #f59e0b; border-radius: 4px; padding: 1px 5px; outline: none; }
#marks .empty { padding: 20px 18px; color: #9ca3af; font-size: .8em; }

/* 对话轮次高亮（已标记） */
.turn.marked { box-shadow: 0 0 0 2px #f59e0b, 0 2px 8px rgba(0,0,0,.12); }
.side-item.marked { background: #fef9ec; }
.mark-btn { margin-left: 6px; background: none; border: none; cursor: pointer; font-size: 1em; line-height: 1; padding: 0 2px; color: #9ca3af; flex-shrink: 0; }
.mark-btn:hover { color: #6b7280; }
.side-item.marked .mark-btn { color: #f59e0b; }

/* 复制按钮（⧉ 图标） */
.copy-btn { position: absolute; top: 2px; right: 2px; z-index: 5; font-size: .85em; color: #6b7280; background: rgba(255,255,255,.85); border: 1px solid #d1d5db; border-radius: 6px; padding: 1px 7px; cursor: pointer; opacity: 0; transition: opacity .15s; font-family: "Segoe UI Symbol", "Segoe UI", sans-serif; }
.msg:hover .copy-btn { opacity: 1; }
.copy-btn:hover { background: #eef2f7; color: #111827; }

/* 公式复制按钮 */
.formula { position: relative; display: inline-block; }
.formula-display { display: block; text-align: center; }
.formula-copy { position: absolute; top: -8px; right: -6px; z-index: 5; font-size: .8em; color: #6b7280; background: #fff; border: 1px solid #d1d5db; border-radius: 6px; padding: 0 6px; cursor: pointer; opacity: 0; transition: opacity .15s; font-family: "Segoe UI Symbol", "Segoe UI", sans-serif; }
.formula:hover .formula-copy, .formula-display:hover .formula-copy { opacity: 1; }
.formula-copy:hover { background: #eef2f7; }

/* 块级复制按钮 */
.blk-copy { position: absolute; top: 6px; right: 8px; z-index: 5; font-size: .8em; color: #6b7280; background: rgba(255,255,255,.92); border: 1px solid #d1d5db; border-radius: 6px; padding: 0 7px; cursor: pointer; opacity: 0; transition: opacity .15s; font-family: "Segoe UI Symbol", "Segoe UI", sans-serif; }
.table-wrap:hover .blk-copy, .code-wrap:hover .blk-copy { opacity: 1; }
.blk-copy:hover { background: #eef2f7; color: #111827; }

/* 图片 lightbox */
.lightbox { position: fixed; inset: 0; background: rgba(15, 23, 42, .88); z-index: 100; display: flex; align-items: center; justify-content: center; }
.lightbox[hidden] { display: none; }
.lb-img { max-width: 92vw; max-height: 85vh; transform-origin: center center; transition: none; border-radius: 4px; box-shadow: 0 8px 40px rgba(0,0,0,.5); }
.lb-toolbar { position: fixed; top: 16px; right: 16px; display: flex; gap: 8px; z-index: 101; }
.lb-toolbar button { font-size: .85em; color: #e5e7eb; background: rgba(31, 41, 55, .75); border: 1px solid rgba(255,255,255,.2); border-radius: 8px; padding: 6px 12px; cursor: pointer; }
.lb-toolbar button:hover { background: rgba(55, 65, 81, .9); }
.lb-hint { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); color: #9ca3af; font-size: .78em; background: rgba(15,23,42,.7); padding: 4px 12px; border-radius: 999px; z-index: 101; }
.turn { margin: 14px 0; background: #fff; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.08); overflow: hidden; content-visibility: auto; contain-intrinsic-size: auto 480px; }
.turn-head { display: flex; align-items: baseline; gap: 10px; padding: 10px 14px; background: #f9fafb; border-bottom: 1px solid #eef0f2; font-size: .88em; }
.turn-head .qn { font-weight: 700; color: #111827; flex-shrink: 0; }
.turn-head .q { color: #444; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.turn-head .time { margin-left: auto; color: #999; font-size: .8em; flex-shrink: 0; }
.turn-body { padding: 10px 14px 14px; }
.msg { display: flex; margin: 10px 0; }
.msg.user { justify-content: flex-end; }
.bubble { max-width: 88%; padding: 9px 13px; border-radius: 14px; line-height: 1.65; font-size: .93em; overflow-wrap: break-word; width: fit-content; }
.msg.user .bubble { background: #d9f1c9; border-top-right-radius: 4px; }
.msg.assistant { justify-content: flex-start; }
.msg.assistant .bubble { background: #f4f5f7; border-top-left-radius: 4px; }
.bubble pre { background: #f6f8fa; color: #1f2328; padding: 10px 12px; border-radius: 8px; overflow-x: auto; font-size: .88em; border: 1px solid #e5e7eb; }
.code-block { position: relative; }
.code-wrap { position: relative; }
.table-wrap { position: relative; }
.bubble code { background: rgba(0,0,0,.06); padding: 1px 5px; border-radius: 4px; font-size: .92em; }
.bubble pre code { background: none; padding: 0; }
.bubble blockquote { margin: 6px 0; padding: 2px 12px; border-left: 4px solid #d0d7de; color: #57606a; }
.bubble table { border-collapse: collapse; margin: 8px 0; display: block; overflow-x: auto; }
.bubble th, .bubble td { border: 1px solid #d0d7de; padding: 4px 10px; }
.bubble th { background: #f6f8fa; }
.bubble img { max-width: 100%; border-radius: 6px; }
.bubble hr { border: none; border-top: 1px solid #d8dee4; margin: 12px 0; }
.attach { display: inline-block; margin-bottom: 6px; font-size: .85em; color: #0a5d38; text-decoration: none; }
.attach:hover { text-decoration: underline; }
.katex-display { margin: 8px 0; overflow-x: auto; overflow-y: hidden; }
@media (max-width: 1000px) {
  #sidebar { position: static; width: 100%; max-height: 200px; }
  #marks { position: static; width: 100%; max-height: 200px; border-left: none; border-top: 1px solid #e5e7eb; }
  #content { margin-left: 0; margin-right: 0; height: auto; overflow-y: visible; }
  html, body { overflow: auto; }
}
`;

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
<style>${css}</style>
</head>
<body>
<nav id="sidebar">
  <button class="panel-toggle" id="toggle-side" title="收起/展开左侧定位">«</button>
  <div class="side-title">对话定位 · ${userN} 问 / ${asstN} 答</div>
  <div id="side-list"></div>
</nav>
<nav id="marks">
  <button class="panel-toggle" id="toggle-marks" title="收起/展开右侧标记">»</button>
  <div class="marks-title">我的标记 <button class="clear-marks" id="clear-marks" title="清除全部标记">清空</button></div>
  <div id="marks-list"><div class="empty">点击左侧对话旁的 ☆ 标记关键内容，可打标签</div></div>
</nav>
<div id="content">
  <h1>${title}</h1>
  <div class="meta">
    <div>对话链接：<a href="${link}">${link}</a></div>
    <div>消息统计：用户 ${userN} 条、助手 ${asstN} 条 · 导出时间 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}</div>
  </div>
  <div id="app"></div>
</div>
<div class="lightbox" id="lightbox" hidden>
  <div class="lb-toolbar">
    <button id="lb-zoom-in" title="放大">+</button>
    <button id="lb-zoom-out" title="缩小">-</button>
    <button id="lb-rotate" title="旋转">⟳</button>
    <button id="lb-reset" title="重置">重置</button>
    <button id="lb-close" title="关闭">✕</button>
  </div>
  <img class="lb-img" id="lb-img" alt="preview">
  <div class="lb-hint">滚轮缩放 · 按住拖动平移 · 按钮旋转</div>
</div>
<script>
const DATA = ${jsonData};
function loadScript(src, fallback) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => (fallback ? loadScript(fallback).then(resolve, reject) : reject());
    document.head.appendChild(s);
  });
}
async function boot() {
  try {
    if (!window.marked) await loadScript('https://cdn.jsdelivr.net/npm/marked/marked.min.js', 'https://unpkg.com/marked/marked.min.js');
  } catch (e) { /* marked 不可用：降级为纯文本 */ }
  try {
    if (!window.katex) {
      await loadScript('https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js', 'https://unpkg.com/katex@0.16.11/dist/katex.min.js');
      await loadScript('https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js', 'https://unpkg.com/katex@0.16.11/dist/contrib/auto-render.min.js');
    }
  } catch (e) { /* KaTeX 不可用：公式显示为源码 */ }

  const app = document.getElementById('app');
  const sideList = document.getElementById('side-list');
  const mdQueue = []; // 待分片渲染的 .md 元素
  const frag = document.createDocumentFragment();
  const sideFrag = document.createDocumentFragment();
  DATA.turns.forEach((turn, i) => {
    const d = document.createElement('div');
    d.className = 'turn';
    d.id = 'turn-' + i;
    const head = document.createElement('div');
    head.className = 'turn-head';
    const qn = document.createElement('span');
    qn.className = 'qn';
    qn.textContent = '问' + (i + 1);
    const q = document.createElement('span');
    q.className = 'q';
    q.textContent = turn.q || '（无文本）';
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = turn.user ? turn.user.time : '';
    head.appendChild(qn);
    head.appendChild(q);
    head.appendChild(time);
    d.appendChild(head);

    const body = document.createElement('div');
    body.className = 'turn-body';
    const mk = (t) => {
      const m = document.createElement('div');
      m.className = 'msg ' + t.role;
      const b = document.createElement('div');
      b.className = 'bubble';
      for (const a of t.attach || []) {
        if (a.isImage) {
          const img = document.createElement('img');
          img.src = encodeURI(a.href);
          img.alt = a.name;
          img.classList.add('zoomable');
          b.appendChild(img);
        } else {
          const al = document.createElement('a');
          al.className = 'attach';
          al.href = encodeURI(a.href);
          al.textContent = '附件：' + a.name + '（' + a.kb + ' KB）';
          b.appendChild(al);
        }
      }
      const md = document.createElement('div');
      md.className = 'md';
      // 先放原文，稍后由分片队列 marked.parse + KaTeX 渲染（避免阻塞主线程）
      md.dataset.raw = t.text || '';
      md.textContent = t.text || '';
      mdQueue.push(md);
      b.appendChild(md);
      m.appendChild(b);
      // 复制整条 markdown 原文
      const copyBtn = document.createElement('button');
      copyBtn.className = 'copy-btn';
      copyBtn.textContent = '⧉';
      copyBtn.addEventListener('click', () => copyText(t.text || ''));
      m.appendChild(copyBtn);
      return m;
    };
    if (turn.user) body.appendChild(mk(turn.user));
    for (const a of turn.assts) body.appendChild(mk(a));
    d.appendChild(body);
    frag.appendChild(d);

    // 侧边栏定位项
    const item = document.createElement('a');
    item.className = 'side-item';
    item.href = '#turn-' + i;
    const sn = document.createElement('span');
    sn.className = 'sn';
    sn.textContent = (i + 1) + '.';
    const qSpan = document.createElement('span');
    qSpan.textContent = turn.q || '（无文本）';
    const markBtn = document.createElement('button');
    markBtn.className = 'mark-btn';
    markBtn.title = '标记/取消标记，可打标签';
    markBtn.textContent = '☆';
    item.appendChild(sn);
    item.appendChild(qSpan);
    item.appendChild(markBtn);
    item.addEventListener('click', (ev) => {
      if (ev.target === markBtn) return; // 由 markBtn 自己处理
      ev.preventDefault();
      const target = document.getElementById('turn-' + i);
      target.scrollIntoView({ behavior: 'instant', block: 'start' });
      history.replaceState(null, '', '#turn-' + i);
    });
    sideFrag.appendChild(item);
  });
  app.appendChild(frag);
  sideList.appendChild(sideFrag);

  // 给表格和代码块包复制按钮（data-md 保存可复制的 markdown/源码）
  // 必须在公式渲染前调用：此时单元格内公式仍是 $...$ 原文
  function wrapBlocks(root) {
    const escCell = (s) => s.replace(/\\|/g, '\\\\|').replace(/\\n/g, ' ').trim();
    root.querySelectorAll('table').forEach((tbl) => {
      const rows = [...tbl.querySelectorAll('tr')].map((tr) =>
        [...tr.querySelectorAll('th, td')].map((c) => escCell(c.textContent || '')).join(' | ')
      );
      const md = rows.map((r) => '| ' + r + ' |').join('\\n');
      const wrap = document.createElement('div');
      wrap.className = 'table-wrap';
      wrap.dataset.md = md;
      tbl.parentNode.insertBefore(wrap, tbl);
      wrap.appendChild(tbl);
      const btn = document.createElement('button');
      btn.className = 'blk-copy';
      btn.textContent = '⧉';
      wrap.appendChild(btn);
    });
    root.querySelectorAll('pre').forEach((pre) => {
      const code = pre.querySelector('code');
      const md = code ? code.textContent : pre.textContent;
      const wrap = document.createElement('div');
      wrap.className = 'code-wrap';
      wrap.dataset.md = md;
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(pre);
      const btn = document.createElement('button');
      btn.className = 'blk-copy';
      btn.textContent = '⧉';
      wrap.appendChild(btn);
    });
  }

  // 滚动时高亮当前对话
  const items = [...sideList.querySelectorAll('.side-item')];
  const turns = [...app.querySelectorAll('.turn')];
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (en.isIntersecting) {
        const idx = turns.indexOf(en.target);
        items.forEach((it, j) => it.classList.toggle('active', j === idx));
      }
    }
  }, { rootMargin: '-40% 0px -55% 0px' });
  turns.forEach((t) => io.observe(t));

  // ---- 分片渲染队列：marked.parse + KaTeX 公式，避免阻塞主线程 ----
  // 只匹配 $ 和 $$：normalizeFormulas 已把 \( \[ 转为 $ $$，
  // 含 \[ 会误伤纯文本 [（如 ChatGPT 的 entity 标记 ["people",...]）
  const MATH_RE = /\\$\\$([\\s\\S]+?)\\$\\$|\\$([^$\\n]+?)\\$/g;
  // marked 会把公式内部的 _ * [ ] 当 markdown 语法解析（典型：\mathbb{E}_{\tau\sim\pi_\theta}
  // 的两个 _ 变成 <em>，$$...$$ 被拆碎，KaTeX 正则永远匹配不到闭合符）。
  // 在 marked 之前把整段数学替换成占位符，渲染后再还原原文。
  const MATH_SPAN_RE = /\\$\\$([\\s\\S]+?)\\$\\$|\\$([^$\\n]+?)\\$/g;
  function shieldMath(src) {
    const saved = [];
    const shielded = src.replace(MATH_SPAN_RE, (m) => {
      saved.push(m);
      return '\\uE000' + saved.length + '\\uE001';
    });
    return { shielded, saved };
  }
  function restoreMath(root, saved) {
    if (!saved.length) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    for (const n of nodes) {
      if (!n.textContent.includes('\\uE000')) continue;
      n.textContent = n.textContent.replace(/\\uE000(\\d+)\\uE001/g, (_, d) => saved[Number(d) - 1]);
    }
  }
  const mathQueue = [];
  function collectMath(root) {
    if (!window.katex) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.textContent.includes('$')) mathQueue.push(node);
    }
  }
  function renderMathNode(node) {
    const text = node.textContent;
    const frag = document.createDocumentFragment();
    let last = 0, m, changed = false;
    MATH_RE.lastIndex = 0;
    while ((m = MATH_RE.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const tex = (m[1] || m[2]).trim();
      const display = !!m[1];
      const wrap = document.createElement('span');
      wrap.className = 'formula' + (display ? ' formula-display' : '');
      try {
        // output:'html' 省掉 MathML 双份 DOM，显著降低内存与布局成本
        wrap.innerHTML = katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'html' });
      } catch (e) {
        wrap.textContent = m[0];
      }
      wrap.dataset.latex = tex;
      const cbtn = document.createElement('button');
      cbtn.className = 'formula-copy';
      cbtn.textContent = '⧉';
      cbtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        copyText(tex);
      });
      wrap.appendChild(cbtn);
      frag.appendChild(wrap);
      changed = true;
      last = m.index + m[0].length;
    }
    if (changed) {
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    }
  }
  function idle(fn) {
    if ('requestIdleCallback' in window) requestIdleCallback(fn, { timeout: 120 });
    else setTimeout(fn, 20);
  }
  let mdIdx = 0;
  function mdChunk() {
    const t0 = performance.now();
    while (mdIdx < mdQueue.length && performance.now() - t0 < 12) {
      const el = mdQueue[mdIdx++];
      if (window.marked) {
        const { shielded, saved } = shieldMath(el.dataset.raw || '');
        el.innerHTML = marked.parse(shielded);
        restoreMath(el, saved);
      }
      delete el.dataset.raw; // 释放原文引用，减少内存
      wrapBlocks(el);
      collectMath(el);
    }
    if (mdIdx < mdQueue.length) { idle(mdChunk); return; }
    mathChunk();
  }
  let mathIdx = 0;
  function mathChunk() {
    if (!window.katex) return;
    const t0 = performance.now();
    while (mathIdx < mathQueue.length && performance.now() - t0 < 12) {
      renderMathNode(mathQueue[mathIdx++]);
    }
    if (mathIdx < mathQueue.length) idle(mathChunk);
  }
  mdChunk();

  // ---- 复制工具 ----
  async function copyText(txt) {
    try {
      await navigator.clipboard.writeText(txt);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = txt;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    window.__lastCopied = txt;
  }
  // 块级复制：表格 / 代码块
  document.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.blk-copy');
    if (!btn) return;
    const wrap = btn.closest('[data-md]');
    if (wrap) copyText(wrap.dataset.md);
  });

  // ---- 标记管理（左侧 ☆ + 标签，右侧列表面板，localStorage 持久化） ----
  // key 带 cid：file:// 下所有本地文件共享同一 localStorage，必须按对话隔离
  const MARKS_KEY = 'chatgpt-export-marks-' + (DATA.cid || '');
  // 旧版无 cid 的 key（file:// 共享 localStorage 时代）不属于本对话，
  // 不能迁移——迁移会把其他对话的标记灌进新对话（不同对话共享同一 origin）。
  let marks = {};
  try { marks = JSON.parse(localStorage.getItem(MARKS_KEY) || '{}'); } catch (e) {}
  const markLabel = (i) => marks[String(i)] || '';
  const hasMark = (i) => marks[String(i)] !== undefined && marks[String(i)] !== null;
  function applyMarks() {
    turns.forEach((t, i) => {
      const marked = hasMark(i);
      t.classList.toggle('marked', marked);
      const it = items[i];
      it.classList.toggle('marked', marked);
      it.querySelector('.mark-btn').textContent = marked ? '★' : '☆';
    });
    renderMarksList();
  }
  function renderMarksList() {
    const list = document.getElementById('marks-list');
    list.innerHTML = '';
    const entries = Object.keys(marks).map(Number).sort((a, b) => a - b);
    if (!entries.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = '点击左侧对话旁的 ☆ 标记关键内容，可打标签';
      list.appendChild(e);
      return;
    }
    for (const i of entries) {
      const key = String(i);
      const label = markLabel(i);
      const row = document.createElement('div');
      row.className = 'mark-item';
      // 标签：点击进入内联编辑；空标签显示 + 号
      const tag = document.createElement('span');
      tag.className = 'mtag' + (label ? '' : ' empty');
      tag.textContent = label || '+';
      tag.title = label ? '点击编辑标签' : '点击添加标签';
      tag.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const input = document.createElement('input');
        input.className = 'm-edit';
        input.value = label;
        tag.replaceWith(input);
        input.focus();
        input.select();
        const save = () => {
          const v = input.value.trim();
          if (v) marks[key] = v;
          else delete marks[key];
          localStorage.setItem(MARKS_KEY, JSON.stringify(marks));
          applyMarks();
        };
        input.addEventListener('keydown', (ke) => {
          if (ke.key === 'Enter') { ke.preventDefault(); input.blur(); }
          else if (ke.key === 'Escape') { input.blur(); applyMarks(); }
        });
        input.addEventListener('blur', save);
      });
      // 问题摘要（换行 + 省略）
      const q = document.createElement('span');
      q.className = 'm-q';
      q.textContent = '#' + (i + 1) + ' ' + ((DATA.turns[i] && DATA.turns[i].q) || '');
      // 删除（取消标记）
      const del = document.createElement('button');
      del.className = 'm-del';
      del.title = '取消标记';
      del.textContent = '×';
      del.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        delete marks[key];
        localStorage.setItem(MARKS_KEY, JSON.stringify(marks));
        applyMarks();
      });
      row.appendChild(tag);
      row.appendChild(q);
      row.appendChild(del);
      row.addEventListener('click', (ev) => {
        if (ev.target === tag || ev.target === del || ev.target.classList.contains('m-edit')) return;
        document.getElementById('turn-' + i).scrollIntoView({ behavior: 'instant', block: 'start' });
        history.replaceState(null, '', '#turn-' + i);
      });
      list.appendChild(row);
    }
  }
  items.forEach((it, i) => {
    it.querySelector('.mark-btn').addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const key = String(i);
      if (hasMark(i)) {
        delete marks[key]; // 已标记 → 取消
      } else {
        marks[key] = ''; // 直接标记，标签留空，之后可在右侧补
      }
      localStorage.setItem(MARKS_KEY, JSON.stringify(marks));
      applyMarks();
    });
  });
  document.getElementById('clear-marks').addEventListener('click', () => {
    if (Object.keys(marks).length && !confirm('清除全部标记？')) return;
    marks = {};
    localStorage.setItem(MARKS_KEY, JSON.stringify(marks));
    applyMarks();
  });
  applyMarks();

  // ---- 面板折叠（左侧定位 / 右侧标记可收起，状态记忆） ----
  const side = document.getElementById('sidebar');
  const marksPanel = document.getElementById('marks');
  const content = document.getElementById('content');
  const KEY_SIDE = 'chatgpt-export-side-collapsed-' + (DATA.cid || '');
  const KEY_MARKS = 'chatgpt-export-marks-collapsed-' + (DATA.cid || '');
  let sideCollapsed = localStorage.getItem(KEY_SIDE) === '1';
  let marksCollapsed = localStorage.getItem(KEY_MARKS) === '1';
  function applyPanelState() {
    side.classList.toggle('collapsed', sideCollapsed);
    marksPanel.classList.toggle('collapsed', marksCollapsed);
    content.classList.toggle('no-side', sideCollapsed);
    content.classList.toggle('no-marks', marksCollapsed);
    document.getElementById('toggle-side').textContent = sideCollapsed ? '»' : '«';
    document.getElementById('toggle-marks').textContent = marksCollapsed ? '«' : '»';
  }
  document.getElementById('toggle-side').addEventListener('click', () => {
    sideCollapsed = !sideCollapsed;
    localStorage.setItem(KEY_SIDE, sideCollapsed ? '1' : '0');
    applyPanelState();
  });
  document.getElementById('toggle-marks').addEventListener('click', () => {
    marksCollapsed = !marksCollapsed;
    localStorage.setItem(KEY_MARKS, marksCollapsed ? '1' : '0');
    applyPanelState();
  });
  applyPanelState();

  // ---- 图片 lightbox：点击缩放/旋转/平移 ----
  const lb = document.getElementById('lightbox');
  const lbImg = document.getElementById('lb-img');
  let lbScale = 1, lbRot = 0, lbX = 0, lbY = 0, drag = null;
  function updateLb() {
    lbImg.style.transform = 'translate(' + lbX + 'px,' + lbY + 'px) scale(' + lbScale + ') rotate(' + lbRot + 'deg)';
  }
  function openLb(src) {
    lbImg.src = src;
    lbScale = 1; lbRot = 0; lbX = 0; lbY = 0;
    updateLb();
    lb.hidden = false;
  }
  document.querySelectorAll('.zoomable').forEach((img) => {
    img.style.cursor = 'zoom-in';
    img.addEventListener('click', () => openLb(img.src));
  });
  document.getElementById('lb-close').addEventListener('click', () => { lb.hidden = true; });
  document.getElementById('lb-zoom-in').addEventListener('click', () => { lbScale = Math.min(8, lbScale * 1.25); updateLb(); });
  document.getElementById('lb-zoom-out').addEventListener('click', () => { lbScale = Math.max(0.2, lbScale / 1.25); updateLb(); });
  document.getElementById('lb-rotate').addEventListener('click', () => { lbRot = (lbRot + 90) % 360; updateLb(); });
  document.getElementById('lb-reset').addEventListener('click', () => { lbScale = 1; lbRot = 0; lbX = 0; lbY = 0; updateLb(); });
  lb.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    lbScale = Math.min(8, Math.max(0.2, lbScale * (ev.deltaY < 0 ? 1.1 : 0.9)));
    updateLb();
  }, { passive: false });
  lb.addEventListener('mousedown', (ev) => {
    if (ev.target === lbImg) { drag = { x: ev.clientX, y: ev.clientY, bx: lbX, by: lbY }; ev.preventDefault(); }
  });
  window.addEventListener('mousemove', (ev) => {
    if (drag) { lbX = drag.bx + (ev.clientX - drag.x); lbY = drag.by + (ev.clientY - drag.y); updateLb(); }
  });
  window.addEventListener('mouseup', () => { drag = null; });
  lb.addEventListener('dblclick', () => { lb.hidden = true; });
  lb.addEventListener('click', (ev) => { if (ev.target === lb) lb.hidden = true; });
}
boot();
</script>
</body>
</html>`;
fs.writeFileSync(htmlPath, html, 'utf8');

console.log(
  `OK: ${mdPath}\n    ${htmlPath}\n   用户 ${userN} 条 / 助手 ${asstN} 条 / 跳过内部消息 ${toolN} 条 / 附件 ${attachCount} 个`
);
