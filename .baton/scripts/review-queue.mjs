// /review 的确定性半程：fetch 后直接读远端内容，工作区一根汗毛都不动
// 列出「交给我的活」：我在 to/defaultNotify 里的已交接功能 + @我 的未结评论
// 用法：node .baton/scripts/review-queue.mjs [--as github登录名] [--json]
import path from 'node:path';
import { parseArgs, repoRoot, readTeam, git, parseYaml, whoami, warnIfUnmatched, effectiveStatuses } from './_lib.mjs';

const { flags } = parseArgs(process.argv.slice(2));
const root = repoRoot();
const team = readTeam(root);
const ref = `origin/${team.defaultBranch}`;

// 我是谁（git 身份 → 名册反查；--as 可覆盖）
let me = flags.as || '';
if (!me) {
  const who = whoami(root, team);
  if (!flags.json) warnIfUnmatched(who);
  me = who.github;
}

git(['fetch', 'origin', '--quiet'], { cwd: root });
const showR = (p) => git(['show', `${ref}:${p}`], { cwd: root });

// 远端功能列表（不 checkout：ls-tree 找 task.yaml）
const ls = git(['ls-tree', '-r', '--name-only', ref, team.featuresDir], { cwd: root });
const features = (ls.stdout || '').split('\n')
  .map((p) => p.match(new RegExp(`^${team.featuresDir}/([^/]+)/task\\.yaml$`)))
  .filter(Boolean).map((m) => m[1]);

const queue = [];
for (const name of features) {
  const tR = showR(`${team.featuresDir}/${name}/task.yaml`);
  if (tR.status !== 0) continue;
  const task = parseYaml(tR.stdout);
  const lastHandoff = (task.handoffs || [])[Math.max(0, (task.handoffs || []).length - 1)];
  const forMe = (task.defaultNotify || []).includes(me) || (lastHandoff && (lastHandoff.to || []).includes(me));

  const thR = showR(`${team.featuresDir}/${name}/comments/threads.jsonl`);
  const threads = (thR.status === 0 ? thR.stdout : '').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const eff = effectiveStatuses(threads);
  const atMe = threads.filter((t) => t.kind === 'comment' && (t.mentions || []).includes(me)
    && !['resolved', 'archived'].includes(eff[t.id]));

  if (!forMe && !atMe.length) continue;
  const item = {
    feature: name, title: task.title || name, version: task.version, status: task.status,
    holder: task.holder || '', handoff: lastHandoff || null, forMe, atMe,
    handoffDoc: lastHandoff ? `${team.featuresDir}/${name}/handoffs/${lastHandoff.id}.md` : null,
  };
  if (item.handoffDoc) {
    const d = showR(item.handoffDoc);
    item.handoffExcerpt = d.status === 0 ? d.stdout.split('\n').slice(0, 12).join('\n') : '';
  }
  queue.push(item);
}

if (flags.json) { console.log(JSON.stringify(queue, null, 2)); process.exit(0); }
if (!queue.length) { console.log(`没有交给 ${me} 的待办（远端 ${ref}）`); process.exit(0); }
for (const q of queue) {
  console.log(`■ ${q.title}（${q.feature}）${q.version} · ${q.status} · 持棒 ${q.holder}`);
  if (q.handoff) console.log(`  交接 ${q.handoff.id} → ${(q.handoff.to || []).join(', ')} · 交接单 ${q.handoffDoc}`);
  for (const t of q.atMe) console.log(`  @你 [${t.block || t.parent}] ${t.author}: ${String(t.body).slice(0, 60)}`);
  console.log(`  查看：baton open ${q.feature} --review   （读远端版本，不动你的工作区）`);
}
