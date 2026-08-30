// /reply 的确定性半程：把新评论分组成处置清单
// 分组：🔴 阻塞实现（排最前）/ 🤖 待代答（@AI 未答）/ 🟢 已代答待归档（可批量）/ ✉️ 需要人答（@我或流转到我）
// 用法：node .baton/scripts/reply-queue.mjs [feature] [--as github] [--json]
import path from 'node:path';
import fs from 'node:fs';
import { parseArgs, repoRoot, readTeam, listFeatures, featureDir, readJsonl, whoami, warnIfUnmatched, effectiveStatuses, git, syncStatus, parseJsonlText, mergeById, listLocalDrafts } from './_lib.mjs';

const { flags, pos } = parseArgs(process.argv.slice(2));
const root = repoRoot();
const team = readTeam(root);

let me = flags.as || '';
if (!me) {
  const who = whoami(root, team);
  if (!flags.json) warnIfUnmatched(who);
  me = who.github;
}

// 取远端最新。**不依赖 pull 成功**——工作树脏时 pull 会失败，若静默继续就会读到
// 过期的本地文件、把「研发提了 4 条意见」显示成「没有评论」。
// 所以：fetch 只更新远端引用（不碰工作区），评论从远端引用读，再并上本地未推送的。
const st = syncStatus(root, team);
const { fetched, behind, ref } = st;
const remoteThreads = (name) => {
  const r = git(['show', `${ref}:${team.featuresDir}/${name}/comments/threads.jsonl`], { cwd: root });
  return r.status === 0 ? parseJsonlText(r.stdout) : [];
};

const targets = pos[0] ? [pos[0]] : listFeatures(root, team);
const groups = { blocking: [], pendingAI: [], answered: [], forMe: [], other: [] };

for (const name of targets) {
  const threads = mergeById(remoteThreads(name), readJsonl(path.join(featureDir(root, team, name), 'comments', 'threads.jsonl')));
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

const localDrafts = listLocalDrafts(root, team);
if (!flags.json && localDrafts.length) {
  console.log(`⚠ 本机有未发送的评论草稿：${localDrafts.map((d) => `${d.feature} ×${d.count}`).join('、')} —— 打开页面在侧栏点「发送本轮」（或逐条撤回）\n`);
}
if (flags.json) {
  // warning 必须在 JSON 里显式出现：读不到远端时 groups 是基于过期本地内容算的，
  // 消费方（AI）看到空分组会当成「没有评论」——本轮真发生过一次，4 条意见被显示成 0 条。
  const warning = !fetched
    ? `取不到远端（${st.fetchError || '未知原因'}）——下面只是本地已有的内容，可能不全，别当成「没有评论」`
    : (behind > 0 ? `远端有 ${behind} 个新提交，已直接从远端读出；处置前需先对齐（存档 → merge）` : null);
  console.log(JSON.stringify({ me, warning, sync: { fetched, fetchError: st.fetchError, behind, ahead: st.ahead, dirty: st.dirty.length, overlap: st.overlap }, groups }, null, 2));
  process.exit(0);
}
if (!fetched) console.log(`⚠ 取不到远端（${st.fetchError || '网络或代理'}）——下面只是本地已有的内容，可能不全\n`);
else if (behind > 0) console.log(`ℹ 远端有 ${behind} 个新提交，评论已直接从远端读出显示（读永不挡）。
  处置（回帖/归档/改原型）前需要先对齐：${st.dirty.length ? `本地有 ${st.dirty.length} 个未保存文件 → 先存档（commit）→ ` : ''}合并远端（merge）→ 再处置。不用 rebase、不用 stash。\n`);
const total = Object.values(groups).reduce((n, g) => n + g.length, 0);
if (!total) {
  console.log(behind > 0 || !fetched
    ? '没有待处理的评论（注意：上面的同步提示——若你预期有评论却没看到，先解决同步问题再确认）'
    : '没有待处理的评论 · 干净');
  process.exit(0);
}
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
