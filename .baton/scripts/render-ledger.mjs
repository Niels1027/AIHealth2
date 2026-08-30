// 台账可视化页生成器（确定性渲染；入账即重跑；手编 ledger/index.html 与 anchors.json 会被覆盖）
// 三处互链：台账条目 ↔ 原型锚点（#baton-block=）↔ 讨论出处（session 文件 / 评论线程）
// 附产 anchors.json：区块 → 条目的反转索引（评论框拍板提示 / @AI 本地查的数据源）
// 用法：node .baton/scripts/render-ledger.mjs <feature>
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, repoRoot, readTeam, readTask, featureDir, readYamlFile, readJsonl, esc, nowIso } from './_lib.mjs';

const { pos } = parseArgs(process.argv.slice(2));
const feature = pos[0];
if (!feature) { console.error('用法：render-ledger.mjs <feature>'); process.exit(1); }

const root = repoRoot();
const team = readTeam(root);
const dir = featureDir(root, team, feature);
const ledgerDir = path.join(dir, 'ledger');
fs.mkdirSync(ledgerDir, { recursive: true });

let task = null; try { task = readTask(root, team, feature); } catch { /* 允许无档案渲染 */ }
const entries = fs.readdirSync(ledgerDir)
  .filter((f) => /^D\d+\.yaml$/.test(f))
  .map((f) => readYamlFile(path.join(ledgerDir, f)))
  .sort((a, b) => parseInt(String(b.id).slice(1), 10) - parseInt(String(a.id).slice(1), 10));

const threads = readJsonl(path.join(dir, 'comments', 'threads.jsonl'));
// 被代答引用：kind=answer 且 refs.ledger 含该条目 id
const citations = {};
for (const t of threads) {
  if (t.kind !== 'answer') continue;
  for (const d of (t.refs && t.refs.ledger) || []) {
    (citations[d] = citations[d] || []).push(t);
  }
}

const day = (iso) => (iso || '').slice(0, 10);
function sourceLink(e) {
  const src = e.source || {};
  if (!src.ref) return '';
  if (src.kind === 'comment') {
    return `<a href="../index.html#baton-thread=${esc(src.ref)}">评论原文 ↗</a>`;
  }
  // session：ref 可能是功能目录内文件（如 handoffs/H1.md）、仓库内文件，或行号描述（纯文字）
  const [refPath, frag] = String(src.ref).split('#');
  const suffix = frag ? '#' + frag : '';
  if (refPath && fs.existsSync(path.join(dir, refPath))) {
    return `<a href="../${esc(refPath)}${esc(suffix)}">讨论原文 ↗</a>`;
  }
  if (refPath && fs.existsSync(path.join(root, refPath))) {
    return `<a href="${esc(path.relative(ledgerDir, path.join(root, refPath)))}${esc(suffix)}">讨论原文 ↗</a>`;
  }
  return `<span class="src">出处 · ${esc(src.ref)}</span>`;
}

const rows = entries.map((e) => {
  const cites = citations[e.id] || [];
  const anchors = (e.anchors || []).map((a) =>
    `<a href="../index.html#baton-block=${esc(a)}">原型位置 · ${esc(a)} ↗</a>`).join(' ');
  const citeHtml = cites.length
    ? `<span class="cite">被代答引用 ${cites.length} 次${cites.map((t) =>
        ` <a href="../index.html#baton-thread=${esc(t.parent || t.id)}">↗</a>`).join('')}</span>`
    : '';
  return `<article class="entry" id="${esc(e.id)}">
  <header><span class="chip">${esc(e.id)}</span><h2>${esc(e.title || '')}</h2>${citeHtml}</header>
  <p class="conclusion">${esc(e.conclusion || '').replace(/\n/g, '<br>')}</p>
  <footer>拍板 ${esc(e.decidedBy || '—')} · ${day(e.ts)}${e.amendedAt ? ' · 已修正 ' + day(e.amendedAt) : ''}
    ${sourceLink(e)} ${anchors}</footer>
</article>`;
}).join('\n');

const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(task ? task.title : feature)} · 决策台账</title>
<style>
:root{--ink:#1c1917;--mut:#78716c;--line:#e7e5e4;--accent:#4f46e5;--bg:#fafaf9}
*{box-sizing:border-box;margin:0}
body{background:var(--bg);color:var(--ink);font:15px/1.75 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;padding:56px 20px 90px}
.wrap{max-width:760px;margin:0 auto}
h1{font-size:22px;font-weight:700;letter-spacing:.01em}
.sub{color:var(--mut);font-size:13px;margin-top:6px}
.note{color:var(--mut);font-size:12.5px;margin-top:14px;padding:10px 14px;border:1px solid var(--line);border-radius:10px;background:#fff}
.entry{background:#fff;border:1px solid var(--line);border-radius:14px;padding:20px 22px;margin-top:18px}
.entry header{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.chip{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--mut);border:1px solid var(--line);border-radius:6px;padding:1px 7px;background:var(--bg)}
.entry h2{font-size:15.5px;font-weight:650}
.cite{font-size:12px;color:var(--mut);margin-left:auto}
.conclusion{margin-top:10px;font-size:14.5px}
.entry footer{margin-top:12px;font-size:12.5px;color:var(--mut);display:flex;gap:14px;flex-wrap:wrap}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.src{color:var(--mut)}
.empty{color:var(--mut);text-align:center;padding:70px 0;font-size:14px}
.pgtabs{position:fixed;top:14px;left:14px;z-index:60;display:flex;gap:2px;background:#fff;border:1px solid var(--line);border-radius:999px;padding:3px;font-size:12.5px;box-shadow:0 2px 10px rgba(28,25,23,.07)}
.pgtabs a,.pgtabs b{padding:5px 14px;border-radius:999px;font-weight:400}
.pgtabs b{background:var(--ink);color:#fff}
.pgtabs a{color:var(--mut)}
.pgtabs a:hover{color:var(--ink);background:var(--bg);text-decoration:none}
</style></head><body>
<nav class="pgtabs" aria-label="页面切换"><a href="../index.html">原型</a><b>台账</b></nav>
<div class="wrap">
<h1>${esc(task ? task.title : feature)} · 决策台账</h1>
<div class="sub">${entries.length} 条 · 生成于 ${day(nowIso())}${task ? ' · 原型 ' + esc(task.version) : ''} · <a href="../index.html">打开原型 ↗</a></div>
<div class="note">本页由 Baton 自动生成，入账即重渲染，手工编辑会被覆盖。拍板在对话里说，AI 提炼入账；纠错也在对话里说（如「D9 记错了」）。</div>
${rows || '<div class="empty">还没有拍板记录 · 第一次 /preview 对话里的决定会自动出现在这里</div>'}
</div></body></html>
`;

fs.writeFileSync(path.join(ledgerDir, 'index.html'), html);

// 反转索引（区块 → 管它的条目）：区块级拍板提示与 @AI 前置本地查的数据源。
// 与台账页同一班车（入账/纠错即重渲染，永远新鲜）；loader 用相对路径 fetch——
// 本机伴侣、--review worktree、云端网页三处直读同一份静态文件，零额外接口。
const anchorsIndex = {
  generated: nowIso(),
  feature,
  entries: entries.slice().reverse().map((e) => ({
    id: e.id,
    title: e.title || '',
    conclusion: e.conclusion || '',
    anchors: e.anchors || [],
    decidedBy: e.decidedBy || '',
    ts: e.ts || '',
  })),
};
fs.writeFileSync(path.join(ledgerDir, 'anchors.json'), JSON.stringify(anchorsIndex) + '\n');
console.log(`✓ 台账页已生成：${path.relative(root, path.join(ledgerDir, 'index.html'))}（${entries.length} 条 · 含 anchors.json 反转索引）`);
