// 线程写操作的唯一入口（append-only；每次操作一次提交即时推送——讨论流即时同步，原型改动走版本）
// 用法：
//   代答  thread-update.mjs answer <feature> <threadId> --body 结论 --ledger D5,D6 [--derivation-file 路径]
//   回帖  thread-update.mjs reply  <feature> <threadId> --body 文字 [--by 称呼]
//   状态  thread-update.mjs status <feature> <threadId> resolved|archived|open [--by 称呼] [--no-git]
//   （--no-git：批量处置时跳过逐条提交，最后由调用方统一提交）
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, repoRoot, readTeam, featureDir, readJsonl, appendJsonl, genId, nowIso, whoami, warnIfUnmatched, git, rel, syncThenPush, parseJsonlText } from './_lib.mjs';

const { flags, pos } = parseArgs(process.argv.slice(2));
const [op, feature, threadId, statusArg] = pos;
if (!op || !feature || !threadId) {
  console.error('用法：thread-update.mjs answer|reply|status <feature> <threadId> …');
  process.exit(1);
}

const root = repoRoot();
const team = readTeam(root);
const dir = featureDir(root, team, feature);
const file = path.join(dir, 'comments', 'threads.jsonl');
const threads = readJsonl(file);
let target = threads.find((t) => t.id === threadId && t.kind === 'comment');
if (!target) {
  // 本地没有 ≠ 不存在：评论可能只在远端（读永不挡）。追加照常进本地文件，
  // 推送时 syncThenPush 会合流，union 合并后两边记录都在。
  git(['fetch', 'origin', '--quiet'], { cwd: root });
  const remote = git(['show', `origin/${team.defaultBranch}:${rel(root, file)}`], { cwd: root });
  if (remote.status === 0) target = parseJsonlText(remote.stdout).find((t) => t.id === threadId && t.kind === 'comment');
}
if (!target) { console.error(`找不到线程 ${threadId}（本地与远端都没有）`); process.exit(1); }

const me = whoami(root, team);
const meName = flags.by || (() => { warnIfUnmatched(me); return me.name; })();

const toCommit = [rel(root, file)];
let record, summary;

if (op === 'answer') {
  if (!flags.body) { console.error('缺 --body（页面上只放结论，两三行）'); process.exit(1); }
  const refs = { ledger: flags.ledger ? String(flags.ledger).split(',').map((s) => s.trim()).filter(Boolean) : [] };
  if (!refs.ledger.length) { console.error('代答铁律：必须带台账出处（--ledger D5）。台账没记载就别答，走 reply 流转产品'); process.exit(1); }
  // 推导全文（两段式的第二段）：AI 先写好文件，这里登记引用
  if (flags['derivation-file']) {
    const dst = path.join(dir, 'answers', `${threadId}.md`);
    if (path.resolve(flags['derivation-file']) !== path.resolve(dst)) fs.copyFileSync(flags['derivation-file'], dst);
    refs.answer = `answers/${threadId}.md`;
    toCommit.push(rel(root, dst));
  }
  record = { id: genId('t'), feature, block: target.block, author: 'AI', github: 'baton-ai',
    body: flags.body, kind: 'answer', parent: threadId, status: 'answered', summon: null, mentions: [], refs, ts: nowIso() };
  summary = `baton(answer): ${feature} ${threadId} ← ${refs.ledger.join(',')}`;
  appendJsonl(file, record);
  // 台账被引用计数变了 → 重渲染
  const { spawnSync } = await import('node:child_process');
  spawnSync(process.execPath, [path.join(root, '.baton/scripts/render-ledger.mjs'), feature], { encoding: 'utf8' });
  const li = path.join(dir, 'ledger', 'index.html');
  if (fs.existsSync(li)) toCommit.push(rel(root, li));
} else if (op === 'reply') {
  if (!flags.body) { console.error('缺 --body'); process.exit(1); }
  // 代拟两段式（与 answer 同构）：页面只放两三行提炼（--ai-draft 标注代拟），
  // 用户原话与完整推导落 answers/<线程id>.md（--derivation-file），拍板挂台账（--ledger D5）
  const refs = {};
  if (flags.ledger) refs.ledger = String(flags.ledger).split(',').map((s) => s.trim()).filter(Boolean);
  if (flags['derivation-file']) {
    const dst = path.join(dir, 'answers', `${threadId}.md`);
    if (path.resolve(flags['derivation-file']) !== path.resolve(dst)) fs.copyFileSync(flags['derivation-file'], dst);
    refs.answer = `answers/${threadId}.md`;
    toCommit.push(rel(root, dst));
  }
  record = { id: genId('t'), feature, block: target.block, author: meName,
    github: (team.roster.find((r) => r.name === meName) || {}).github || me.github,
    body: flags.body, kind: 'reply', parent: threadId, status: 'open', summon: null, mentions: [], ts: nowIso() };
  if (Object.keys(refs).length) record.refs = refs;
  if (flags['ai-draft']) record.drafted = 'ai';
  summary = `baton(reply): ${feature} ${threadId} by ${meName}`;
  appendJsonl(file, record);
  if (refs.ledger && refs.ledger.length) {
    // 台账被引用计数变了 → 重渲染
    const { spawnSync } = await import('node:child_process');
    spawnSync(process.execPath, [path.join(root, '.baton/scripts/render-ledger.mjs'), feature], { encoding: 'utf8' });
    const li = path.join(dir, 'ledger', 'index.html');
    if (fs.existsSync(li)) toCommit.push(rel(root, li));
  }
} else if (op === 'status') {
  const st = statusArg;
  if (!['resolved', 'archived', 'open'].includes(st)) { console.error('状态只能是 resolved / archived / open'); process.exit(1); }
  record = { id: genId('t'), kind: 'status', parent: threadId, status: st, by: meName, note: flags.note || '', ts: nowIso() };
  summary = `baton(status): ${feature} ${threadId} → ${st}`;
  appendJsonl(file, record);
} else { console.error('未知操作：' + op); process.exit(1); }

if (!flags['no-git']) {
  // commit → merge → push：先把记录定格（pathspec 提交，绝不卷走用户暂存区里的其他文件），
  // 再由 syncThenPush 合流推送——失败说清原因，绝不谎报「离线」。
  git(['add', '--', ...toCommit], { cwd: root });
  const c = git(['commit', '-q', '-m', summary, '--', ...toCommit], { cwd: root });
  if (c.status !== 0) { console.error(`✗ 提交失败：${c.stderr || c.stdout}`); process.exit(1); }
  const res = syncThenPush(root, team);
  if (res.pushed) console.log(`✓ ${summary}${res.merged ? '（已顺带合入远端新提交）' : ''}`);
  else console.log(`✓ ${summary}
  ⚠ 已入库本地，尚未同步给团队：${res.hint}`);
} else {
  console.log(`✓ ${summary}（--no-git，待统一提交）`);
}
