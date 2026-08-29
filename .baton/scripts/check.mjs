// 原型 CI 检查（确定性把关；「不能凭空设计」等纪律的机器化）
// 用法：node .baton/scripts/check.mjs <feature> [--json] [--strict]
//       node .baton/scripts/check.mjs --all
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, repoRoot, readTeam, readTask, featureDir, readJsonl, listFeatures, rel } from './_lib.mjs';

const { flags, pos } = parseArgs(process.argv.slice(2));
const root = repoRoot();
const team = readTeam(root);
const targets = flags.all ? listFeatures(root, team) : [pos[0]].filter(Boolean);
if (flags.all && !targets.length) { console.log('还没有功能原型，跳过检查'); process.exit(0); }
if (!targets.length) { console.error('用法：check.mjs <feature> 或 check.mjs --all'); process.exit(1); }

function checkFeature(name) {
  const errors = [];   // 挡交付
  const warns = [];    // 提示不挡
  const dir = featureDir(root, team, name);
  const htmlFile = path.join(dir, 'index.html');

  // C1 结构与档案
  let task = null;
  try { task = readTask(root, team, name); } catch (e) { errors.push(['C1', e.message]); }
  if (task) {
    for (const k of ['name', 'status', 'version']) if (!task[k]) errors.push(['C1', `task.yaml 缺少字段 ${k}`]);
    if (task.name && task.name !== name) errors.push(['C1', `task.yaml 的 name（${task.name}）与目录名（${name}）不一致`]);
  }
  if (!fs.existsSync(htmlFile)) {
    errors.push(['C1', '缺少 index.html（原型本体）']);
    return { name, errors, warns };
  }
  const html = fs.readFileSync(htmlFile, 'utf8');

  // C2 单文件自包含：零 CDN、零外链资源
  const extPatterns = [
    [/<script[^>]*\bsrc\s*=\s*["']https?:\/\/[^"']+/gi, '外链 <script src>'],
    [/<link[^>]*\bhref\s*=\s*["']https?:\/\/[^"']+/gi, '外链 <link href>'],
    [/<img[^>]*\bsrc\s*=\s*["']https?:\/\/[^"']+/gi, '外链 <img src>'],
    [/<iframe[^>]*\bsrc\s*=\s*["']https?:\/\/[^"']+/gi, '外链 <iframe src>'],
    [/@import\s+(?:url\(\s*)?["']?https?:\/\//gi, 'CSS @import 外链'],
    [/url\(\s*["']?https?:\/\/[^)]+\)/gi, 'CSS url() 外链（字体/图片）'],
  ];
  for (const [re, label] of extPatterns) {
    const m = html.match(re);
    if (m) errors.push(['C2', `${label} × ${m.length}：${m[0].slice(0, 90)}`]);
  }

  // C3 版本：meta 必须有，且与 task.yaml 一致（版本号进页面、绝不进文件名）
  // 交接升版时用 --expect-version 传入新版本号（此时 task.yaml 尚未更新）
  const expectVer = flags['expect-version'] || (task && task.version);
  const metaM = html.match(/<meta\s+name=["']baton-version["']\s+content=["']([^"']+)["']/i)
    || html.match(/<meta\s+content=["']([^"']+)["']\s+name=["']baton-version["']/i);
  if (!metaM) errors.push(['C3', '缺少 <meta name="baton-version" content="vX.Y">']);
  else if (expectVer && metaM[1] !== expectVer) errors.push(['C3', `版本不一致：页面 meta=${metaM[1]}，应为 ${expectVer}`]);

  // C4 评论锚点：每个可评区块标 data-baton-block，id 唯一
  const blocks = [...html.matchAll(/data-baton-block\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]);
  if (!blocks.length) errors.push(['C4', '没有任何 data-baton-block 锚点——每个可评区块都要标（点块评论靠它）']);
  const dup = blocks.filter((b, i) => blocks.indexOf(b) !== i);
  if (dup.length) errors.push(['C4', `data-baton-block 重复：${[...new Set(dup)].join(', ')}`]);

  // C5 锚点漂移：既有评论引用的区块还在不在（不在＝loader 会标「原区域已变更」）
  const threads = readJsonl(path.join(dir, 'comments', 'threads.jsonl'));
  const blockSet = new Set(blocks);
  for (const t of threads) {
    if (t.kind === 'comment' && t.block && !blockSet.has(t.block)) {
      warns.push(['C5', `评论 ${t.id} 锚定的区块「${t.block}」已不在页面——原区域已变更（loader 会兜底展示）`]);
    }
  }

  // C6 载体检查：carriers 里声明的现网文件必须真实存在（不能凭空设计）
  if (task && Array.isArray(task.carriers)) {
    if (!task.carriers.length) warns.push(['C6', 'carriers 为空——原型的每个元素都应有现网载体；确属全新功能可忽略']);
    for (const c of task.carriers) {
      if (!c || !c.path) { errors.push(['C6', 'carriers 有条目缺 path']); continue; }
      const base = c.repo ? path.resolve(root, '..', c.repo) : root;
      if (c.repo && !fs.existsSync(base)) { warns.push(['C6', `载体仓库 ${c.repo} 不在本机（${c.path} 未验）`]); continue; }
      if (!fs.existsSync(path.join(base, c.path))) errors.push(['C6', `载体不存在：${c.repo ? c.repo + '/' : ''}${c.path}`]);
      else if (c.symbol) {
        const content = fs.readFileSync(path.join(base, c.path), 'utf8');
        if (!content.includes(c.symbol)) errors.push(['C6', `载体 ${c.path} 里找不到符号「${c.symbol}」`]);
      }
    }
  }

  // C7 评论加载器：页面必须带 loader（点块评论的入口）
  if (!html.includes('data-baton-loader')) {
    errors.push(['C7', '缺少评论加载器——把 .baton/scripts/loader.snippet.html 内容放进 </body> 前']);
  }

  // C8 正式帧不留开发者备注（弱信号，仅提示）
  for (const marker of ['TODO', 'FIXME', '开发者备注', 'XXX:']) {
    if (html.includes(marker)) warns.push(['C8', `页面含「${marker}」——正式帧不留开发者备注，确认是否该清理`]);
  }

  return { name, errors, warns };
}

const results = targets.map(checkFeature);
if (flags.json) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const r of results) {
    const dir = rel(root, featureDir(root, team, r.name));
    if (!r.errors.length && !r.warns.length) console.log(`✓ ${dir} 全绿`);
    else {
      console.log(`${r.errors.length ? '✗' : '⚠'} ${dir}`);
      for (const [code, msg] of r.errors) console.log(`  ✗ [${code}] ${msg}`);
      for (const [code, msg] of r.warns) console.log(`  ⚠ [${code}] ${msg}`);
    }
  }
}
const failed = results.some((r) => r.errors.length || (flags.strict && r.warns.length));
process.exit(failed ? 1 : 0);
