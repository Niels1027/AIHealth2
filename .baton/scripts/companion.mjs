// Baton 伴侣 —— 本机常驻小服务（baton open 自动拉起）
// 职责：静态托管仓库页面 / 接收点块评论落 threads.jsonl / commit → merge → push
// 一切皆文件：评论进仓库，产品 pull 代码即得全部反馈。
// 用法：node .baton/scripts/companion.mjs [--port 4173]
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { parseArgs, repoRoot, readTeam, readTask, whoami, warnIfUnmatched, git, appendJsonl, readJsonl, genId, nowIso, syncThenPush, listLocalDrafts, repoVersion } from './_lib.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.md': 'text/plain; charset=utf-8', '.yaml': 'text/plain; charset=utf-8', '.yml': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

export function makeCtx(root) {
  const team = readTeam(root);
  const who = whoami(root, team);
  // 伴侣会替你署名每一条评论——身份对不上必须当场喊，不能等评论发出去才发现
  warnIfUnmatched(who);
  // 版本在启动那一刻定格：进程跑的是启动时加载的代码，现读磁盘只会报出「仓库已升级」
  // 的新版本号，让 open 的版本闸永远比对通过——闸就白设了。
  return { root, team, user: who.gitName, me: who.matched ? who : null, who, version: repoVersion(root) };
}

// ---------- 本机信任边界 ----------
// 伴侣是无鉴权的本机服务，而写路由的副作用是「以你的 git 身份提交并推送到团队仓库」。
// 你开着它时访问任意网页，那个页面就能对 127.0.0.1 发跨站请求（text/plain 的 POST
// 不触发预检，直达服务器）。三道一起上，成本几乎为零：
//   ① Host 必须是本机 —— 挡 DNS rebinding（否则外部页面能变成「同源」读走整仓源码）
//   ② Origin 若存在必须是本机 —— 挡普通跨站请求
//   ③ 写请求必须 application/json —— 这一条就让「无预检」的攻击路径不成立
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
function hostOf(v) {
  if (!v) return null;
  const m = String(v).trim().replace(/^https?:\/\//, '').match(/^(\[[^\]]+\]|[^:/]+)/);
  return m ? m[1].toLowerCase() : null;
}
function isLocal(v) { const h = hostOf(v); return !!h && LOCAL_HOSTS.has(h); }

const DENY = {
  host: '请求的 Host 不是本机——伴侣只服务 localhost',
  origin: '跨站请求被拒——评论会以你的 git 身份提交并推送，只接受本机页面发起',
  ct: '写请求必须是 application/json',
};
// 返回拒绝原因键；null = 放行
export function denyReason(req, { write = false } = {}) {
  if (!isLocal(req.headers && req.headers.host)) return 'host';
  if (!write) return null;
  const o = req.headers.origin;
  if (o && o !== 'null' && !isLocal(o)) return 'origin';
  if (!String((req.headers['content-type'] || '')).includes('application/json')) return 'ct';
  return null;
}

// 从 URL path 推导功能名：/<featuresDir>/<name>/...
export function featureFromPath(ctx, urlPath) {
  const parts = decodeURIComponent(urlPath).split('/').filter(Boolean);
  if (parts[0] !== ctx.team.featuresDir || !parts[1]) return null;
  return parts[1];
}

// 解析 @：@AI 显式召唤代答；@名册成员 定向流转；都没有 → 默认流转持棒产品
export function parseMentions(ctx, body, feature) {
  const mentions = [];
  for (const r of ctx.team.roster) {
    for (const alias of [r.github, r.name, r.feishu]) {
      if (alias && body.includes('@' + alias)) { mentions.push(r.github); break; }
    }
  }
  const ai = /@ai\b/i.test(body);
  let summon = null;
  if (ai) summon = 'ai';
  else if (mentions.length) summon = 'user:' + mentions[0];
  let routed = [...new Set(mentions)];
  if (!routed.length && !ai) {
    try { const t = readTask(ctx.root, ctx.team, feature); if (t.holder) routed = [t.holder]; } catch { /* 无档案 */ }
  }
  return { summon, mentions: routed, ai };
}

export function buildComment(ctx, payload) {
  const feature = featureFromPath(ctx, payload.path || '');
  if (!feature) throw new Error('无法从路径识别功能：' + payload.path);
  if (!payload.block && !payload.parent) throw new Error('缺 block（评论必须锚定区块）');
  const body = String(payload.body || '').trim();
  if (!body) throw new Error('空评论');
  const { summon, mentions } = parseMentions(ctx, body, feature);
  const record = {
    id: genId('t'),
    feature,
    block: payload.block || null,
    author: ctx.me ? ctx.me.name : ctx.user,
    github: ctx.me ? ctx.me.github : ctx.user,
    body,
    kind: payload.parent ? 'reply' : 'comment',
    parent: payload.parent || null,
    status: 'open',
    summon,
    mentions,
    ts: nowIso(),
  };
  const file = path.join(ctx.root, ctx.team.featuresDir, feature, 'comments', 'threads.jsonl');
  return { record, file, feature };
}

// commit → merge → push：先把评论定格（pathspec 提交，不卷走用户暂存区里的其他文件），
// 再由 syncThenPush 合流推送（全线 merge 禁 rebase；显式 HEAD:<默认分支>，review worktree 也适用）。
// union 合并策略下 threads.jsonl 天然免冲突；推不出去时如实带原因，绝不谎报「离线」。
export function commitComment(ctx, file, record) {
  const cwd = ctx.root;
  appendJsonl(file, record);
  const relFile = path.relative(cwd, file);
  git(['add', '--', relFile], { cwd });
  const c = git(['commit', '-q', '-m', `baton(comment): ${record.feature} ${record.block || record.parent} by ${record.author}`, '--', relFile], { cwd });
  if (c.status !== 0) return { committed: false, pushed: false };
  const res = syncThenPush(cwd, ctx.team);
  return { committed: true, pushed: !!res.pushed, reason: res.reason || null, hint: res.hint || null };
}

// ---------- 攒批：草稿与整轮发送（草稿文件本机不入库，gitignore 兜底防误提交） ----------
export function draftsFile(ctx, feature) {
  const who = ctx.me ? ctx.me.github : ctx.user;
  return path.join(ctx.root, ctx.team.featuresDir, feature, 'comments', `drafts-${who}.jsonl`);
}
export function readDrafts(ctx, feature) { return readJsonl(draftsFile(ctx, feature)); }
export function saveDraft(ctx, payload) {
  const { record, feature } = buildComment(ctx, payload);
  appendJsonl(draftsFile(ctx, feature), record);
  return { record, feature, count: readDrafts(ctx, feature).length };
}
export function deleteDraft(ctx, feature, id) {
  const f = draftsFile(ctx, feature);
  const left = readJsonl(f).filter((d) => d.id !== id);
  if (left.length) fs.writeFileSync(f, left.map((d) => JSON.stringify(d)).join('\n') + '\n');
  else if (fs.existsSync(f)) fs.rmSync(f);
  return { count: left.length };
}
// 发送本轮：整批打上同一个 round 批次号 → 一个提交 → 一次推送
export function sendRound(ctx, feature) {
  const drafts = readDrafts(ctx, feature);
  if (!drafts.length) return { ok: false, error: '本轮没有草稿' };
  const round = 'r-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const file = path.join(ctx.root, ctx.team.featuresDir, feature, 'comments', 'threads.jsonl');
  for (const d of drafts) appendJsonl(file, { ...d, round });
  fs.rmSync(draftsFile(ctx, feature));
  const cwd = ctx.root;
  const relFile = path.relative(cwd, file);
  const author = ctx.me ? ctx.me.name : ctx.user;
  git(['add', '--', relFile], { cwd });
  const c = git(['commit', '-q', '-m', `baton(comments): ${feature} ×${drafts.length} by ${author} ${round}`, '--', relFile], { cwd });
  if (c.status !== 0) return { ok: false, error: '提交失败：' + (c.stderr || c.stdout) };
  const res = syncThenPush(cwd, ctx.team);
  return { ok: true, count: drafts.length, round, pushed: !!res.pushed, reason: res.reason || null, hint: res.hint || null };
}

export function createHandler(ctx) {
  return function handler(req, res) {
    const send = (code, obj, type) => {
      res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj));
    };
    // 同步异常只该坏一次请求，绝不能杀常驻进程：坏 URL（decodeURIComponent 抛 URIError）、
    // merge 窗口期读文件的竞态都会走到这里。不兜住 = uncaughtException 带走伴侣，
    // 此后页面只剩「暂存失败：…」的谜之症状，还得有人想起来重启。
    try { return route(req, send); }
    catch (e) { try { send(e instanceof URIError ? 400 : 500, { ok: false, error: e.message }); } catch { /* 响应已发出 */ } }
  };

  function route(req, send) {
    const urlPath = (req.url || '/').split('?')[0];

    // 信任边界：Host 全路由都查（含静态托管——rebinding 的目标就是读走整仓源码）；
    // 写路由再加 Origin 与 Content-Type。
    const deny = denyReason(req, { write: req.method === 'POST' });
    if (deny) return send(403, { ok: false, error: 'forbidden', detail: DENY[deny] });

    if (urlPath === '/baton/health') {
      // version/pid 是给 open 用的：进程跑的是启动那一刻的代码，光看仓库文件判断不出它新旧。
      // 报了 pid，提示里就能直接给出 kill 命令，不必让人先去 lsof 找进程。
      return send(200, { ok: true, version: ctx.version, pid: process.pid, root: ctx.root, repo: path.basename(ctx.root), featuresDir: ctx.team.featuresDir, user: ctx.me ? ctx.me.name : ctx.user, github: ctx.me ? ctx.me.github : ctx.user });
    }
    if (req.method === 'GET' && urlPath === '/baton/drafts') {
      const q = new URLSearchParams((req.url || '').split('?')[1] || '');
      const feature = featureFromPath(ctx, q.get('path') || '');
      if (!feature) return send(400, { ok: false, error: '无法识别功能' });
      return send(200, { ok: true, drafts: readDrafts(ctx, feature) });
    }
    if (req.method === 'POST' && (urlPath === '/baton/draft' || urlPath === '/baton/draft-delete' || urlPath === '/baton/send-round')) {
      let buf = '';
      req.on('data', (d) => { buf += d; });
      req.on('end', () => {
        try {
          const payload = JSON.parse(buf || '{}');
          if (urlPath === '/baton/draft') {
            const r = saveDraft(ctx, payload);
            send(200, { ok: true, id: r.record.id, count: r.count });
            console.log(`📝 草稿 ${r.feature}/${r.record.block} ${r.record.author}（本轮第 ${r.count} 条）`);
          } else if (urlPath === '/baton/draft-delete') {
            const feature = featureFromPath(ctx, payload.path || '');
            if (!feature) throw new Error('无法识别功能');
            send(200, { ok: true, ...deleteDraft(ctx, feature, payload.id) });
          } else {
            const feature = featureFromPath(ctx, payload.path || '');
            if (!feature) throw new Error('无法识别功能');
            const r = sendRound(ctx, feature);
            if (!r.ok) return send(400, r);
            send(200, r);
            console.log(`📦 一轮发送 ${feature} ×${r.count}（${r.round}）${r.pushed ? '' : `（已入库本地，未同步：${r.reason}）`}`);
          }
        } catch (e) { send(400, { ok: false, error: e.message }); }
      });
      return;
    }
    if (req.method === 'POST' && urlPath === '/baton/comment') {
      let buf = '';
      req.on('data', (d) => { buf += d; });
      req.on('end', () => {
        try {
          const payload = JSON.parse(buf || '{}');
          const { record, file } = buildComment(ctx, payload);
          const g = commitComment(ctx, file, record);
          send(200, { ok: true, id: record.id, summon: record.summon, mentions: record.mentions, pushed: g.pushed, syncHint: g.hint });
          console.log(`💬 ${record.feature}/${record.block || record.parent} ${record.author}${record.summon === 'ai' ? '（@AI 召唤）' : ''}${g.pushed ? '' : `（已入库本地，未同步：${g.reason || '?'}）`}`);
        } catch (e) { send(400, { ok: false, error: e.message }); }
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { ok: false, error: 'method' });

    // 静态托管（限仓库内；目录默认取 index.html）
    let rel = decodeURIComponent(urlPath);
    if (rel.endsWith('/')) rel += 'index.html';
    if (rel === '/index.html' && !fs.existsSync(path.join(ctx.root, 'index.html'))) {
      return send(200, homePage(ctx), 'text/html; charset=utf-8');
    }
    const abs = path.resolve(ctx.root, '.' + rel);
    if (!abs.startsWith(ctx.root + path.sep) && abs !== ctx.root) return send(403, { ok: false, error: 'forbidden' });
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
      const idx = path.join(abs, 'index.html');
      if (fs.existsSync(idx)) return send(200, fs.readFileSync(idx), MIME['.html']);
      return send(404, { ok: false, error: 'not found' });
    }
    send(200, fs.readFileSync(abs), MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream');
  }
}

// 首页：列出所有功能（无 index.html 的仓库根访问时）
function homePage(ctx) {
  const dir = path.join(ctx.root, ctx.team.featuresDir);
  const items = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((n) => fs.existsSync(path.join(dir, n, 'index.html')))
    : [];
  const list = items.map((n) => `<li><a href="/${ctx.team.featuresDir}/${n}/index.html">${n}</a>
    <small><a href="/${ctx.team.featuresDir}/${n}/ledger/index.html">台账</a></small></li>`).join('') || '<li>还没有功能原型</li>';
  return `<!doctype html><meta charset="utf-8"><title>Baton · ${path.basename(ctx.root)}</title>
<body style="font:15px/1.8 -apple-system,sans-serif;max-width:640px;margin:60px auto;color:#1c1917">
<h1 style="font-size:20px">Baton · ${path.basename(ctx.root)}</h1><ul>${list}</ul></body>`;
}

// ---------- 直接运行则起服务（被 import 时不启动；argv[1] 在 node -e 下为 undefined，要防） ----------
const entryHref = process.argv[1] ? (await import('node:url')).pathToFileURL(process.argv[1]).href : '';
if (entryHref && import.meta.url === entryHref) {
  const { flags } = parseArgs(process.argv.slice(2));
  const root = repoRoot();
  const ctx = makeCtx(root);
  const port = Number(flags.port) || ctx.team.companion.port || 4173;
  const server = http.createServer(createHandler(ctx));
  server.listen(port, '127.0.0.1', () => {
    console.log(`Baton 伴侣已启动 · http://localhost:${port}/ · 仓库 ${path.basename(root)} · ${ctx.me ? ctx.me.name : ctx.user}`);
    const pend = listLocalDrafts(root, ctx.team);
    if (pend.length) console.log(`⚠ 本机有未发送的评论草稿：${pend.map((d) => `${d.feature} ×${d.count}`).join('、')} —— 打开页面在侧栏点「发送本轮」`);
  });
  server.on('error', (e) => { console.error('伴侣启动失败：' + e.message); process.exit(1); });
}
