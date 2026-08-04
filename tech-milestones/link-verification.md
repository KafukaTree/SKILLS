# 链接验证手册

> 目标:交付物里的每个链接都真实存在。优先批量低成本验证,可疑条目升级到直读验证。

## 1. 批量状态码检查(curl)

```bash
for u in \
"https://arxiv.org/abs/1706.03762" \
"https://www.anthropic.com/news/claude-4" \
"https://ai.meta.com/blog/meta-llama-3/" \
; do code=$(curl -s -o /dev/null -w "%{http_code}" -L --max-time 15 -A "Mozilla/5.0" "$u"); echo "$code $u"; done
```

状态码判读:
| 码 | 含义 | 处理 |
|---|---|---|
| 200 | 存在 | ✅ |
| 403 | **WAF 拦截,页面通常存在**(OpenAI、GitHub blog 对 curl 常见) | 用 `read` 工具验证,不要判失效 |
| 404 | 真失效 | 换 URL 形态或搜索正确地址 |
| 000 | 超时/连接失败 | 重试;仍失败用 `read` |

## 2. 直读验证(最可靠)

- **arXiv**:`read https://arxiv.org/abs/<ID>` → 返回标题/作者/发布日期/摘要,一眼确认论文身份。**记忆中的 ID 必须直读验证**,实战错误率 >30%。
- **官方博客**:`read <URL>` → 检查页面标题与日期 meta(OpenAI/Anthropic 页面会显示发布日期)。
- **YouTube**:`read <URL>` → 返回标题、频道、上传日期、时长。
- **DOI**:`read https://doi.org/<doi>` → 走 CrossRef API 返回元数据(期刊、年份、标题)。

## 3. 常见陷阱与修复

| 陷阱 | 实例 | 修复 |
|---|---|---|
| OpenAI 域名 curl 403 | openai.com/index/* | 403≠失效;read 验证 |
| GitHub blog curl 404 | 2021 年 Copilot 旧路径 | read 试 `github.blog/news-insights/product-news/...` 新形态 |
| 记忆的 arXiv ID 错误 | Scaling Laws for Precision:2502.02539→实为 2411.04330 | 直读 arXiv 页面 |
| 官方视频托管失效 | NeurIPS 2017 官方视频在 Facebook,已移除 | 找作者本人演讲的替代视频并验证 |
| DOI curl 403 | doi.org | read 走 CrossRef |

## 4. 文件级校验(交付前)

```bash
# 缺链接条目计数(目标: 0)
awk '/^- \*\*/{if ($0 !~ /https:\/\//) c++} END{print "缺链接条目:", c+0}' <file>
# 链接总数
grep -c 'https://' <file>
# 条目总数
grep -c '^- \*\*' <file>
```

## 5. 补充查找

- 404 后找正确 URL:web_search `site:<domain> <关键词>`;官方 release notes / changelog 页常有汇总。
- 无 arXiv 的论文(GPT-2 等):官方 PDF 是权威来源,注明"该论文从未上 arXiv"。
- 精确日期:arXiv 页面"Published"字段、官方博客发布日期、changelog 条目。
