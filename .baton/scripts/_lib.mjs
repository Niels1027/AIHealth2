// Baton 共享库（由 baton init 写入 .baton/scripts/，全团队随仓库获得，无需安装）
// 内容：YAML 子集解析/生成、jsonl、git/shell、team/task 读写。零依赖，Node >= 18。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

// ---------- YAML 子集 ----------
// 只需支持 Baton 自己生成的形态：嵌套 map、list（含 map 项）、块标量 |、行内 [a, b]。

export function parseYaml(src) {
  const lines = String(src).split(/\r?\n/);
  let i = 0;
  const indentOf = (l) => l.match(/^ */)[0].length;
  const isSkip = (l) => !l.trim() || /^\s*#/.test(l);

  // 顶层切分：跳过引号内与嵌套 [] {} 里的逗号
  function splitTop(s) {
    const parts = []; let depth = 0, cur = '', q = null;
    for (const ch of s) {
      if (q) { cur += ch; if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
      if (ch === '[' || ch === '{') depth++;
      else if (ch === ']' || ch === '}') depth--;
      else if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) parts.push(cur);
    return parts;
  }

  function parseScalar(raw) {
    let s = raw.trim();
    if (s.startsWith('"')) { try { return JSON.parse(s); } catch { return s.slice(1, -1); } }
    if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1);
    if (!s.startsWith('{') && !s.startsWith('[')) {
      const hash = s.indexOf(' #');
      if (hash >= 0) s = s.slice(0, hash).trim();
    }
    if (s === '' || s === '~' || s === 'null') return null;
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (/^-?\d+$/.test(s)) return parseInt(s, 10);
    if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
    if (s.startsWith('[') && s.endsWith(']')) {
      const inner = s.slice(1, -1).trim();
      return inner ? splitTop(inner).map((x) => parseScalar(x)) : [];
    }
    // 行内 map：{ from: env-file, path: .env.local } —— 启动配方的 secret 来源常这么写
    if (s.startsWith('{') && s.endsWith('}')) {
      const inner = s.slice(1, -1).trim();
      if (!inner) return {};
      const obj = {};
      for (const part of splitTop(inner)) {
        const i = part.indexOf(':');
        if (i < 0) continue;
        let k = part.slice(0, i).trim();
        if (k.startsWith('"')) { try { k = JSON.parse(k); } catch { /* keep */ } }
        obj[k] = parseScalar(part.slice(i + 1));
      }
      return obj;
    }
    return s;
  }

  function splitKV(t) {
    const m = t.match(/^([^:]+?):(?:[ \t](.*))?$/);
    if (!m) throw new Error('YAML 解析失败，无法识别的行: ' + t);
    let key = m[1].trim();
    if (key.startsWith('"')) { try { key = JSON.parse(key); } catch { /* keep */ } }
    return [key, (m[2] ?? '').trim()];
  }

  function parseBlockScalar(parentIndent, fold) {
    const buf = [];
    let blockIndent = null;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) { buf.push(''); i++; continue; }
      const li = indentOf(l);
      if (li <= parentIndent) break;
      if (blockIndent === null) blockIndent = li;
      buf.push(l.slice(Math.min(blockIndent, li)));
      i++;
    }
    while (buf.length && buf[buf.length - 1] === '') buf.pop();
    return fold ? buf.join(' ') : buf.join('\n');
  }

  function parseBlock(minIndent) {
    let result = null;
    while (i < lines.length) {
      const line = lines[i];
      if (isSkip(line)) { i++; continue; }
      const ind = indentOf(line);
      if (ind < minIndent) break;
      const t = line.trim();
      if (t === '-' || t.startsWith('- ')) {
        if (result === null) result = [];
        if (!Array.isArray(result)) break;
        const rest = t === '-' ? '' : t.slice(2).trim();
        if (!rest) { i++; result.push(parseBlock(ind + 1)); }
        else if (/^[^:\s][^:]*:([ \t]|$)/.test(rest)) {
          // list 项是 map：把内容回推成 ind+2 的普通行再递归
          lines[i] = ' '.repeat(ind + 2) + rest;
          result.push(parseBlock(ind + 2));
        } else { i++; result.push(parseScalar(rest)); }
      } else {
        if (result === null) result = {};
        if (Array.isArray(result)) break;
        const [key, val] = splitKV(t);
        i++;
        if (val === '|' || val === '>') result[key] = parseBlockScalar(ind, val === '>');
        else if (val === '') {
          const child = parseBlock(ind + 1);
          result[key] = child;
        } else result[key] = parseScalar(val);
      }
    }
    return result;
  }

  const out = parseBlock(0);
  return out === null ? {} : out;
}

function scalarStr(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  const risky = s === '' || s !== s.trim() || s.includes('\n') || s.includes(' #')
    || /^["'\[\]{}#&*!|>%@`~,-]|^\?[ ]/.test(s)
    || /^(true|false|null|~|-?\d+(\.\d+)?)$/.test(s);
  return risky ? JSON.stringify(s) : s;
}

export function emitYaml(value, indent = 0) {
  const pad = ' '.repeat(indent);
  const out = [];
  if (Array.isArray(value)) {
    if (value.length === 0) return pad + '[]';
    for (const item of value) {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        const keys = Object.keys(item);
        if (keys.length === 0) { out.push(pad + '- {}'); continue; }
        const first = keys[0];
        const firstLine = emitPair(first, item[first], indent + 2);
        out.push(pad + '- ' + firstLine.join('\n').slice(indent + 2));
        for (const k of keys.slice(1)) out.push(...emitPair(k, item[k], indent + 2));
      } else if (Array.isArray(item)) {
        out.push(pad + '-');
        out.push(emitYaml(item, indent + 2));
      } else out.push(pad + '- ' + scalarStr(item));
    }
    return out.join('\n');
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return pad + '{}';
    for (const k of keys) out.push(...emitPair(k, value[k], indent));
    return out.join('\n');
  }
  return pad + scalarStr(value);
}

function emitPair(key, v, indent) {
  const pad = ' '.repeat(indent);
  const k = /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
  if (v === null || v === undefined) return [pad + k + ': null'];
  if (typeof v === 'string' && v.includes('\n')) {
    const body = v.split('\n').map((l) => ' '.repeat(indent + 2) + l);
    return [pad + k + ': |', ...body];
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return [pad + k + ': []'];
    const simple = v.every((x) => typeof x !== 'object' || x === null);
    const short = simple && v.every((x) => scalarStr(x).length <= 24) && v.length <= 6;
    if (short) return [pad + k + ': [' + v.map(scalarStr).join(', ') + ']'];
    return [pad + k + ':', emitYaml(v, indent + 2)];
  }
  if (typeof v === 'object') {
    if (Object.keys(v).length === 0) return [pad + k + ': {}'];
    return [pad + k + ':', emitYaml(v, indent + 2)];
  }
  return [pad + k + ': ' + scalarStr(v)];
}

export function readYamlFile(file) {
  return parseYaml(fs.readFileSync(file, 'utf8'));
}
export function writeYamlFile(file, obj, headerComment) {
  const head = headerComment ? headerComment.split('\n').map((l) => '# ' + l).join('\n') + '\n' : '';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, head + emitYaml(obj) + '\n');
}

// ---------- jsonl ----------
export function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { console.error('[baton] threads.jsonl 有一行无法解析，已跳过: ' + t.slice(0, 80)); }
  }
  return out;
}
export function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

// ---------- shell / git ----------
export function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { status: r.status ?? 1, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}
export function shx(cmd, args, opts = {}) {
  const r = sh(cmd, args, opts);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 失败: ${r.stderr || r.stdout}`);
  return r.stdout;
}
export function git(args, opts = {}) { return sh('git', args, opts); }
export function gitx(args, opts = {}) { return shx('git', args, opts); }

export function repoRoot(from = process.cwd()) {
  const r = git(['rev-parse', '--show-toplevel'], { cwd: from });
  if (r.status !== 0) throw new Error('这里不是 git 仓库（Baton 需要在仓库里运行）');
  return r.stdout;
}
export function currentBranch(root) { return gitx(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root }); }

// 仓库的能力版本（.baton/VERSION）。常驻伴侣拿它自报家门，open 拿它比对——
// 进程加载的是启动那一刻的代码，git pull 不会让它变新，不比对就发现不了。
export function repoVersion(root) {
  const f = path.join(root, '.baton', 'VERSION');
  try { return fs.readFileSync(f, 'utf8').trim() || null; } catch { return null; }
}
export function gitUserName(root) {
  const r = git(['config', 'user.name'], { cwd: root });
  return r.status === 0 && r.stdout ? r.stdout : 'unknown';
}

// ---------- team / feature ----------
export function teamFile(root) { return path.join(root, '.baton', 'team.yaml'); }
export function readTeam(root) {
  const f = teamFile(root);
  if (!fs.existsSync(f)) throw new Error('缺少 .baton/team.yaml —— 请先在仓库根运行 baton init');
  const t = readYamlFile(f);
  t.featuresDir = t.featuresDir || 'features';
  t.defaultBranch = t.defaultBranch || 'main';
  t.companion = t.companion || {};
  t.companion.port = t.companion.port || 4173;
  t.cloud = t.cloud || {};          // cloud.baseUrl 配了才有网页链接（第二级）；没配一切照旧走本机命令
  t.roster = t.roster || [];
  return t;
}

// GitHub 的 owner/repo（从 origin 远端解析）——云端页面 URL 与「在 GitHub 上看」都要它
export function ownerRepo(root) {
  const r = git(['remote', 'get-url', 'origin'], { cwd: root });
  if (r.status !== 0) return null;
  const m = r.stdout.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

// 功能的云端页面地址；未配 cloud.baseUrl 或识别不出 owner/repo 时返回 null（调用方回落到本机命令提示）
// owner/repo 默认从 origin 解析；远端不是 github.com（镜像、自建 gitlab 中转等）时可在
// team.yaml 写 cloud.repo: "owner/repo" 显式指定。
export function cloudUrl(root, team, feature, sub = '') {
  const c = team.cloud || {};
  const base = String(c.baseUrl || '').replace(/\/$/, '');
  if (!base) return null;
  let owner, repo;
  if (c.repo && String(c.repo).includes('/')) {
    [owner, repo] = String(c.repo).split('/');
  } else {
    const or = ownerRepo(root);
    if (!or) return null;
    ({ owner, repo } = or);
  }
  if (!owner || !repo) return null;
  return `${base}/${owner}/${repo}/${team.featuresDir}/${feature}/${sub}`;
}
export function featureDir(root, team, name) { return path.join(root, team.featuresDir, name); }
export function taskFile(root, team, name) { return path.join(featureDir(root, team, name), 'task.yaml'); }
export function readTask(root, team, name) {
  const f = taskFile(root, team, name);
  if (!fs.existsSync(f)) throw new Error(`功能「${name}」不存在（找不到 ${path.relative(root, f)}）`);
  return readYamlFile(f);
}
export function writeTask(root, team, name, task) {
  writeYamlFile(taskFile(root, team, name), task, 'Baton 任务档案（AI 与脚本维护；状态/版本/载体/交接索引）');
}
export function listFeatures(root, team) {
  const dir = path.join(root, team.featuresDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'task.yaml')))
    .map((d) => d.name);
}

// ---------- misc ----------
export function genId(prefix) {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${t}${r}`;
}
export function kebab(s) {
  return String(s).trim().toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '-').replace(/^-+|-+$/g, '');
}
export function nowIso() { return new Date().toISOString(); }
export function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
export function readFileSafe(f) { return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null; }
export function rel(root, f) { return path.relative(root, f); }

// ---------- 参数解析 ----------
export function parseArgs(argv) {
  const flags = {}; const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    } else pos.push(a);
  }
  return { flags, pos };
}

// ---------- 本机 env（~/.baton/env，KEY=VALUE 每行一条；secret 不入仓库的落点） ----------
export function readLocalEnv() {
  const f = path.join(os.homedir(), '.baton', 'env');
  const out = {};
  if (!fs.existsSync(f)) return out;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
export function localSecret(name) {
  return process.env[name] || readLocalEnv()[name] || '';
}

// ---------- 线程有效状态（threads.jsonl 是 append-only：状态变更=追加 kind:status 记录） ----------
// 规则：最新 status 记录 > 有代答子记录(answered) > 根记录自带 status > open
export function effectiveStatuses(threads) {
  const stat = {}; const answered = new Set();
  for (const t of threads) {
    if (t.kind === 'status' && t.parent) stat[t.parent] = t.status;
    if (t.kind === 'answer' && t.parent) answered.add(t.parent);
  }
  const out = {};
  for (const t of threads) {
    if (t.kind !== 'comment') continue;
    out[t.id] = stat[t.id] || (answered.has(t.id) ? 'answered' : (t.status || 'open'));
  }
  return out;
}

// ---------- 身份解析（名册反查；识别不到要显式告警，绝不静默回落） ----------
export function gitUserEmail(root) {
  const r = git(['config', 'user.email'], { cwd: root });
  return r.status === 0 ? r.stdout : '';
}

// 三级匹配：①git user.name 对上 github/name/feishu ②user.email 对上 roster.email
// ③GitHub noreply 邮箱（12345+login@users.noreply.github.com）反解出登录名
export function whoami(root, team) {
  const gitName = gitUserName(root);
  const gitEmail = gitUserEmail(root);
  const roster = team.roster || [];
  const hit = roster.find((r) => r.github === gitName || r.name === gitName || r.feishu === gitName);
  if (hit) return { ...hit, matched: 'name', gitName, gitEmail };
  const byEmail = gitEmail && roster.find((r) => r.email && String(r.email).toLowerCase() === gitEmail.toLowerCase());
  if (byEmail) return { ...byEmail, matched: 'email', gitName, gitEmail };
  const m = gitEmail.match(/^(?:\d+\+)?([A-Za-z0-9-]+)@users\.noreply\.github\.com$/i);
  if (m) {
    const byLogin = roster.find((r) => String(r.github).toLowerCase() === m[1].toLowerCase());
    if (byLogin) return { ...byLogin, matched: 'github-noreply', gitName, gitEmail };
  }
  return { github: gitName, name: gitName, role: '', feishu: gitName, matched: false, gitName, gitEmail };
}

export function warnIfUnmatched(who) {
  if (who.matched) return false;
  console.error(`[baton] ⚠ 当前 git 身份「${who.gitName}${who.gitEmail ? ' <' + who.gitEmail + '>' : ''}」不在 .baton/team.yaml 名册里。
    署名、持棒人、评论路由都会用这个名字，很可能不是你想要的。二选一修掉：
    ① 在本仓设对身份：git config user.name <你在名册里的 github 登录名>
    ② 把这条身份补进名册（可给该成员加 email: 字段做匹配）`);
  return true;
}

// ---------- 命令提示：只推荐用户真能执行的那种写法 ----------
// 全局 baton 是本机安装的便利层，clone 仓库的人默认没有；仓库内脚本则一定存在。
export function hasGlobalBaton() {
  return sh('sh', ['-c', 'command -v baton >/dev/null 2>&1']).status === 0;
}

// 生成打开原型页的命令；在子目录里跑也给出正确的相对路径
export function openCmd(root, feature, extra = '') {
  const tail = `${feature}${extra ? ' ' + extra : ''}`;
  if (hasGlobalBaton()) return `baton open ${tail}`;
  let script = path.relative(process.cwd(), path.join(root, '.baton', 'scripts', 'open.mjs'));
  if (!script.startsWith('.')) script = './' + script;
  return `node ${script} ${tail}`;
}

// ---------- 同步纪律：读永不挡 · commit → merge → push · 失败必须说话 ----------
// 全线用 merge：交接 tag 钉住了历史（定格不可改写），rebase 会重写它；stash 是共享活树的事故源，禁用。

export function parseJsonlText(txt) {
  const out = [];
  for (const line of String(txt || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* 跳过坏行 */ }
  }
  return out;
}

// 合并本地与远端的 append-only 记录（按 id 去重）——读取一律「远端 + 本地未推送」并集
export function mergeById(a, b) {
  const seen = new Set(), out = [];
  for (const rec of [...a, ...b]) {
    const k = rec && rec.id ? rec.id : JSON.stringify(rec);
    if (seen.has(k)) continue;
    seen.add(k); out.push(rec);
  }
  return out.sort((x, y) => String(x.ts || '').localeCompare(String(y.ts || '')));
}

// 取远端引用。失败原因必须带回来——只回一个 false，调用方就只能猜「网络不好」，
// 而实际可能是没权限；读侧一旦静默降级，「读不到」会被当成「没有评论」。
export function fetchRemote(root) {
  const r = git(['fetch', 'origin', '--quiet'], { cwd: root });
  if (r.status === 0) return { ok: true, error: null };
  return { ok: false, error: (r.stderr || r.stdout || '').split('\n').find((l) => l.trim()) || '未知原因' };
}

// fetch 后的完整同步画像：落后/领先、远端将改哪些文件、与本地脏文件的交集
export function syncStatus(root, team, { fetch = true } = {}) {
  const f = fetch ? fetchRemote(root) : { ok: true, error: null };
  const fetched = f.ok;
  const ref = `origin/${team.defaultBranch}`;
  const n = (args) => parseInt(git(args, { cwd: root }).stdout, 10) || 0;
  const behind = n(['rev-list', '--count', `HEAD..${ref}`]);
  const ahead = n(['rev-list', '--count', `${ref}..HEAD`]);
  // 注意：sh() 会 trim 整段 stdout，porcelain 第一行的前导状态位空格会被吃掉——
  // 所以逐行 trim 后按「状态字母+空白」剥离，改名行取箭头右侧
  const dirty = git(['status', '--porcelain'], { cwd: root }).stdout
    .split('\n').filter(Boolean).map((l) => {
      const p = l.trim().replace(/^[A-Z?!]{1,2}\s+/, '');
      return p.includes(' -> ') ? p.split(' -> ').pop() : p;
    }).filter(Boolean);
  // 三个点 = 只算远端侧自分叉点以来的改动（这才是「将进来的」）
  const incoming = behind > 0
    ? git(['diff', '--name-only', `HEAD...${ref}`], { cwd: root }).stdout.split('\n').filter(Boolean)
    : [];
  const dirtySet = new Set(dirty);
  const overlap = incoming.filter((f2) => dirtySet.has(f2));
  return { fetched, fetchError: f.error, behind, ahead, dirty, incoming, overlap, ref };
}

export function mergeRemote(root, team) {
  const r = git(['merge', '--no-edit', `origin/${team.defaultBranch}`], { cwd: root });
  if (r.status === 0) return { ok: true };
  git(['merge', '--abort'], { cwd: root });
  return { ok: false, reason: (r.stderr || r.stdout || '').split('\n')[0] || '合并失败' };
}

// 推送失败归因。auth 必须排在 offline 前面：GitHub 的 403 报文长这样——
//   fatal: unable to access 'https://…': The requested URL returned error: 403
// 里面就含「unable to access」，先匹配 offline 会把「没权限」说成「网络不好，稍后补发」，
// 而那是永远等不到的恢复。任何情况下都把 stderr 首行原样带出，绝不吞。
const PUSH_FAILURES = [
  ['auth', /permission denied|authentication failed|could not read username|could not read password|invalid username or password|access denied|error: 40[13]|403 forbidden/i],
  ['offline', /could not resolve host|failed to connect|connection (refused|reset|timed out)|network is unreachable|timed out|unable to access|does not appear to be a git repo/i],
];
const PUSH_HINT = {
  auth: (l) => `没有推送权限或凭据失效（${l}）——这不是网络问题，等下去不会自己好。先解决权限/登录，再在会话里说一声补发。`,
  offline: (l) => `连不上远端（${l}）。改动已在本地定格，恢复后在会话里说一声即可补发。`,
  rejected: (l) => `推送被拒（${l}）。改动已在本地定格；在会话里说一声，我来处理同步。`,
};
export function classifyPushFailure(stderr) {
  const msg = String(stderr || '');
  const line = msg.split('\n').find((l) => l.trim()) || '远端拒绝';
  const hit = PUSH_FAILURES.find(([, re]) => re.test(msg));
  const reason = hit ? hit[0] : 'rejected';
  return { reason, hint: PUSH_HINT[reason](line), detail: line };
}

// 写路径的标准收尾（前提：调用方已把自己要发布的文件 commit 完——commit → merge → push）。
// 返回 { pushed, merged, reason, hint }；reason: 'overlap' | 'conflict' | 'auth' | 'offline' | 'rejected'
export function syncThenPush(root, team, { refspecs } = {}) {
  const specs = refspecs || [`HEAD:${team.defaultBranch}`];
  const push = () => git(['push', '--quiet', 'origin', ...specs], { cwd: root });
  let st = syncStatus(root, team);
  if (!st.fetched) {
    // fetch 不通不代表 push 不通（只读凭据、代理白名单等），先试一把再下结论
    const p0 = push();
    if (p0.status === 0) return { pushed: true, merged: false };
    return { pushed: false, ...classifyPushFailure(p0.stderr || st.fetchError) };
  }
  let merged = false;
  if (st.behind > 0) {
    if (st.overlap.length) {
      return { pushed: false, reason: 'overlap', overlap: st.overlap,
        hint: `远端更新与你本地未保存的改动重叠（${st.overlap.join('、')}）——先把这些文件存档（commit），再重试。不用 rebase、不用 stash。` };
    }
    const m = mergeRemote(root, team);
    if (!m.ok) return { pushed: false, reason: 'conflict', hint: `与远端有冲突（${m.reason}），需要在会话里处理。` };
    merged = true;
  }
  let p = push();
  if (p.status !== 0) {
    // 推送窗口期远端又动了：再同步一次
    st = syncStatus(root, team);
    if (st.behind > 0 && !st.overlap.length && mergeRemote(root, team).ok) { merged = true; p = push(); }
  }
  if (p.status === 0) return { pushed: true, merged };
  return { pushed: false, ...classifyPushFailure(p.stderr) };
}

// ---------- 评论草稿（攒批模式；本机文件不入库，防忘发要靠到处提醒） ----------
export function listLocalDrafts(root, team) {
  const out = [];
  const dir = path.join(root, team.featuresDir);
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const cdir = path.join(dir, name, 'comments');
    if (!fs.existsSync(cdir)) continue;
    for (const f of fs.readdirSync(cdir)) {
      if (!/^drafts-.+\.jsonl$/.test(f)) continue;
      const count = readJsonl(path.join(cdir, f)).length;
      if (count) out.push({ feature: name, file: path.join(cdir, f), count });
    }
  }
  return out;
}

// ---------- 评论层（loader）定位：check 与 refresh-loader 共用，杜绝两份实现漂移 ----------
// loader 在原型里是一段连续区间：可选的 Baton 注释头 + <style data-baton-loader-css> + <script data-baton-loader>…</script>
export function locateLoader(html) {
  const scriptAt = html.indexOf('<script data-baton-loader>');
  if (scriptAt < 0) return null;
  const closeAt = html.indexOf('</script>', scriptAt);
  if (closeAt < 0) return null;
  const styleAt = html.indexOf('<style data-baton-loader-css>');
  let start = styleAt >= 0 && styleAt < scriptAt ? styleAt : scriptAt;
  const commentAt = html.lastIndexOf('<!-- Baton 评论层加载器', start);
  if (commentAt >= 0) start = commentAt;   // 注释头属于 loader，一并纳入
  return { start, end: closeAt + '</script>'.length };
}

// 内联的 loader 是否已是当前版本；返回 null 表示页面里根本没有 loader（由 C7 报缺失）
export function loaderIsCurrent(html, snippet) {
  const loc = locateLoader(html);
  if (!loc) return null;
  return html.slice(loc.start, loc.end).trim() === String(snippet).trim();
}
