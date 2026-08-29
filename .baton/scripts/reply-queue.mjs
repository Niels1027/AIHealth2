// /reply 的确定性半程：把新评论分组成处置清单
// 分组：🔴 阻塞实现（排最前）/ 🤖 待代答（@AI 未答）/ 🟢 已代答待归档（可批量）/ ✉️ 需要人答（@我或流转到我）
// 用法：node .baton/scripts/reply-queue.mjs [feature] [--as github] [--json]
import path from 'node:path';
import fs from 'node:fs';
import { parseArgs, repoRoot, readTeam, listFeatures, featureDir, readJsonl, whoami, warnIfUnmatched, effectiveStatuses, git } from './_lib.mjs';

const { flags, pos } = parseArgs(process.argv.slice(2));
const root = repoRoot();
const team = readTeam(root);

let me = flags.as || '';
if (!me) {
  const who = whoami(root, team);
  if (!flags.json) warnIfUnmatched(who);
  me = who.github;
}

// 先把别人推的评论拉回来（评论即文件；merge=union 免冲突）
git(['pull', '--rebase', '--quiet'], { cwd: root });

const targets = pos[0] ? [pos[0]] : listFeatures(root, team);
const groups = { blocking: [], pendingAI: [], answered: [], forMe: [], other: [] };

for (const name of targets) {
  const threads = readJsonl(path.join(featureDir(root, team, name), 'comments', 'threads.jsonl'));
  const eff = effectiveStatuses(threads);
  const answersOf = (id) => threads.filter((t) => t.kind === 'answer' && t.parent === id);
  // AI 是否已经处理过这条：正式代答，或如实说"台账没记载、转产品"的回帖
  const aiTouched = (id) => threads.some((t) => t.parent === id && (t.kind === 'answer' || t.author === 'AI'));
  for (const t of threads) {
    if (t.kind !== 'comment') continue;
    const status = eff[t.id];
    if (['resolved', 'archived'].includes(status)) continue;
    const item = { feature: name, thread: t, status, answers: answersOf(t.id) };
    if (/阻塞|blocker|blocked/i.test(t.body || '')) groups.blocking.push(item);
    // 只有 AI 还没碰过的 @AI 提问才算欠账；已流转的（AI 回过但没正式代答）归入"需要你答"
    else if (t.summon === 'ai' && !aiTouched(t.id)) groups.pendingAI.push(item);
    else if (item.answers.length && status === 'answered') groups.answered.push(item);
    else if ((t.mentions || []).includes(me) || (!t.mentions || !t.mentions.length) || t.summon === 'ai') groups.forMe.push(item);
    else groups.other.push(item);
  }
}

if (flags.json) { console.log(JSON.stringify({ me, groups }, null, 2)); process.exit(0); }
const total = Object.values(groups).reduce((n, g) => n + g.length, 0);
if (!total) { console.log('没有待处理的评论 · 干净'); process.exit(0); }
const P = (label, list, tip) => {
  if (!list.length) return;
  console.log(`${label}（${list.length}）${tip ? ' · ' + tip : ''}`);
  for (const { feature, thread: t, answers } of list) {
    console.log(`  [${feature}/${t.block || t.parent}] ${t.author}: ${String(t.body).slice(0, 70)}`);
    for (const a of answers) console.log(`    ↳ 代答: ${String(a.body).slice(0, 60)}（依据 ${((a.refs || {}).ledger || []).join(',') || '—'}）`);
  }
};
P('🔴 阻塞实现', groups.blocking, '排最前');
P('🤖 待代答（@AI）', groups.pendingAI, '只答台账有记载的');
P('🟢 已代答待归档', groups.answered, '可批量归档');
P('✉️ 需要你答', groups.forMe);
P('· 其他未结', groups.other);
