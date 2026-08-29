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
  t.roster = t.roster || [];
  return t;
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
