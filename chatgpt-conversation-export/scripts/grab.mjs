/**
 * grab.mjs — in-browser grabber for ChatGPT conversations.
 *
 * DESIGNED TO BE eval'd inside a `browser` tool `run` code block (Node env
 * with `page` / `tab` in scope). NOT a standalone module — no imports/exports.
 *
 * Before eval, set `globalThis.__GRAB_ARGS = { url, outDir }`:
 *   - url:    the conversation URL (https://chatgpt.com/g/.../c/{cid} or /c/{cid})
 *   - outDir: local directory for outputs (JSON + attachments)
 *
 * Flow (each step proven against chatgpt.com, 2026-08):
 *   1. Reload the page while a CDP session watches the network.
 *   2. Catch the page's OWN request to /backend-api/conversation/{cid} —
 *      it carries the auth cookie/Bearer automatically. Pull the response
 *      body via CDP (no token handling needed). This bypasses frontend
 *      lazy-loading/virtualization: the DOM only ever shows ~6 turns, but
 *      this endpoint returns the full mapping (all messages incl. voice
 *      transcriptions).
 *   3. From the same CDP stream, capture the `authorization` header used
 *      by the page (needed for the attachment download endpoint).
 *   4. For each attachment in metadata: GET /backend-api/files/download/{id}
 *      (with auth) → JSON { download_url } → GET download_url → bytes.
 *      (Direct GET of /backend-api/files/{id}/download returns 404;
 *       the files/download/{id} + signed estuary URL is the working chain.)
 *
 * Writes: {outDir}/{cid}.json and attachments. Returns a summary object.
 */
(async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { url, outDir } = globalThis.__GRAB_ARGS || {};
  if (!url || !outDir) throw new Error('grab.mjs: set globalThis.__GRAB_ARGS = { url, outDir } first');

  const cidMatch = url.match(/\/c\/([0-9a-f-]{36})/);
  if (!cidMatch) throw new Error('grab.mjs: cannot extract conversation id from ' + url);
  const cid = cidMatch[1];
  // 目录布局：<outDir>/raws/<cid>/<cid>.json  +  <outDir>/raws/<cid>/attachments/<附件>
  const rawDir = path.join(outDir, 'raws', cid);
  const attachDir = path.join(rawDir, 'attachments');
  fs.mkdirSync(attachDir, { recursive: true });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const client = await page.createCDPSession();
  await client.send('Network.enable');

  // 校验页面是否在目标对话；不在则直接导航（tab 可能被用户切到别处）
  const cur = await tab.evaluate(() => location.href);
  if (!cur.includes(cid)) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(2000);
  }

  let convBody = null;      // { body, b64, status }
  let authHeader = null;    // authorization from any page API request

  const tryBody = async (reqId) => {
    for (let i = 0; i < 5; i++) {
      try {
        const b = await client.send('Network.getResponseBody', { requestId: reqId });
        return b;
      } catch (e) {
        if (i === 4) return null;
        await sleep(500);
      }
    }
  };

  const sawConv = new Promise((resolve) => {
    client.on('Network.responseReceived', async (e) => {
      if (!convBody && e.response.url.includes(`/conversation/${cid}`)) {
        const b = await tryBody(e.requestId);
        if (b) convBody = { body: b.body, b64: b.base64Encoded, status: e.response.status };
        resolve();
      }
    });
  });

  // Capture auth from ANY backend-api request (fires for the conversation request too).
  const authPromise = new Promise((resolve) => {
    client.on('Network.requestWillBeSent', (e) => {
      if (!authHeader && /backend-api/.test(e.request.url)) {
        const h = e.request.headers['authorization'] || e.request.headers['Authorization'];
        if (h) { authHeader = h; resolve(); }
      }
    });
  });

  // Reload so the page re-issues its own (authenticated) conversation request.
  try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (e) {}

  await Promise.race([sawConv, sleep(25000)]);
  if (!convBody) {
    // 页面请求未捕获（缓存/SPA 未重发）：用捕获的 auth 直接 fetch 对话端点
    await Promise.race([authPromise, sleep(15000)]);
    if (authHeader) {
      const r = await tab.evaluate(async ({ cid, authHeader }) => {
        const res = await fetch(`https://chatgpt.com/backend-api/conversation/${cid}`, {
          headers: { accept: 'application/json', authorization: authHeader },
        });
        if (!res.ok) return { error: 'status ' + res.status };
        return { body: await res.text() };
      }, { cid, authHeader });
      if (r && !r.error) convBody = { body: r.body, b64: false, status: 200 };
    }
    if (!convBody) throw new Error('grab.mjs: conversation request not observed; is the page logged in / on the right URL?');
  }

  const jsonPath = path.join(rawDir, cid + '.json');
  if (convBody.b64) {
    fs.writeFileSync(jsonPath, Buffer.from(convBody.body, 'base64'));
  } else {
    fs.writeFileSync(jsonPath, convBody.body, 'utf8');
  }
  if (convBody.status !== 200) {
    console.warn('grab.mjs: conversation endpoint status ' + convBody.status + ' (saved anyway)');
  }

  // --- Attachments ---
  await Promise.race([authPromise, sleep(15000)]);
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const mapping = data.mapping || {};
  const attachIds = new Set();
  const seenFids = new Set();
  for (const node of Object.values(mapping)) {
    const msg = node?.message;
    if (!msg) continue;
    // 1. metadata.attachments（用户上传的附件）
    for (const a of msg.metadata?.attachments ?? []) {
      if (a.id && a.name) {
        attachIds.add(JSON.stringify([a.id, a.name, a.size ?? 0]));
        seenFids.add(a.id);
      }
    }
    // 2. content.parts 里的 image_asset_pointer（GPT/DALL-E 生成图，asset_pointer: sediment://file_xxx）
    //    与 attachments 同 fid 的跳过（已下载）
    const parts = msg.content?.parts ?? [];
    for (const p of parts) {
      if (p?.content_type === 'image_asset_pointer' && p.asset_pointer) {
        const m = String(p.asset_pointer).match(/^sediment:\/\/(file_[0-9a-f]+)$/);
        if (m && !seenFids.has(m[1])) {
          const fid = m[1];
          const genId = p.metadata?.dalle?.gen_id;
          const name = (genId ? genId + '.png' : fid + '.png');
          const size = p.size_bytes ?? 0;
          attachIds.add(JSON.stringify([fid, name, size]));
          seenFids.add(fid);
        }
      }
    }
  }

  const downloads = [];
  for (const entry of attachIds) {
    const [fid, name, size] = JSON.parse(entry);
    // 1. auth'd download endpoint → signed URL
    const dlEndpoint = `https://chatgpt.com/backend-api/files/download/${fid}?inline=true&download_intent=false&check_context_scopes_for_conversation_id=${cid}`;
    let dlJson = null;
    for (let attempt = 0; attempt < 3 && !dlJson; attempt++) {
      dlJson = await tab.evaluate(async ({ dlEndpoint, authHeader }) => {
        const res = await fetch(dlEndpoint, { headers: { accept: '*/*', authorization: authHeader } });
        if (!res.ok) return { error: 'status ' + res.status };
        try { return await res.json(); } catch (e) { return { error: 'bad json' }; }
      }, { dlEndpoint, authHeader });
      if (!dlJson || dlJson.error) dlJson = null;
    }
    if (!dlJson || !dlJson.download_url) {
      downloads.push({ name, error: 'no download_url' });
      continue;
    }
    // 2. signed estuary URL → bytes (works without auth; re-sign if stale)
    const outPath = path.join(attachDir, name.replace(/[\\/:*?"<>|]/g, '_'));
    let saved = false;
    for (let attempt = 0; attempt < 3 && !saved; attempt++) {
      const b64 = await tab.evaluate(async (u) => {
        const res = await fetch(u, { headers: { accept: '*/*' } });
        if (!res.ok) return { error: 'status ' + res.status, len: 0 };
        const bytes = new Uint8Array(await res.arrayBuffer());
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return { len: bytes.length, b64: btoa(bin) };
      }, dlJson.download_url);
      if (b64 && b64.b64) {
        fs.writeFileSync(outPath, Buffer.from(b64.b64, 'base64'));
        saved = b64.len;
      } else {
        await sleep(1500);
        // re-sign: fetch the download endpoint again for a fresh URL
        dlJson = await tab.evaluate(async ({ dlEndpoint, authHeader }) => {
          const res = await fetch(dlEndpoint, { headers: { accept: '*/*', authorization: authHeader } });
          return res.ok ? await res.json() : null;
        }, { dlEndpoint, authHeader });
      }
    }
    downloads.push({ name, size, saved });
  }

  // 收尾：显式禁用 Network 域，避免 browser run 清理拦截时对已残留的 CDP 状态报
  // "Failed to clear browser request interception"（纯警告，不影响数据）
  try { await client.send('Network.disable'); } catch (e) {}
  try { await client.detach(); } catch (e) {}
  // 给浏览器一点空闲时间，避免 run 结束清理 setRequestInterception 时超时
  await sleep(1200);

  const msgs = Object.values(mapping).filter((n) => n?.message);
  const roles = {};
  const contentTypes = {};
  for (const n of msgs) {
    const m = n.message;
    const r = m.author?.role || '?';
    roles[r] = (roles[r] || 0) + 1;
    const ct = m.content?.content_type || '?';
    contentTypes[ct] = (contentTypes[ct] || 0) + 1;
  }
  const summary = {
    conversationId: cid,
    title: data.title || null,
    json: jsonPath,
    messageCount: msgs.length,
    roles,
    contentTypes,
    attachments: downloads,
  };
  // 持久化 summary：browser.run 的返回值可能被清理告警吞掉（fact 11），
  // 对账永远以磁盘上的 summary.json 为准。
  fs.writeFileSync(path.join(rawDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log('GRAB_SUMMARY ' + JSON.stringify(summary));
  return summary;
})();
