// /verify 的取证半程：把「比对所需的一切」收进一份 JSON 卷宗，比对本身是 AI 的判断
// 用法：node .baton/scripts/verify-collect.mjs <feature> [--json]
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, repoRoot, readTeam, readTask, featureDir, readYamlFile, readJsonl, effectiveStatuses, git, readFileSafe } from './_lib.mjs';

const { flags, pos } = parseArgs(process.argv.slice(2));
const feature = pos[0];
if (!feature) { console.error('用法：verify-collect.mjs <feature>'); process.exit(1); }

const root = repoRoot();
const team = readTeam(root);
const task = readTask(root, team, feature);
const dir = featureDir(root, team, feature);

// 最近一次交接：tag 时间点 = 实现的起点
const lastHandoff = (task.handoffs || [])[(task.handoffs || []).length - 1] || null;
const tag = lastHandoff ? `baton/${feature}/${lastHandoff.version}` : null;
const tagTime = tag ? git(['log', '-1', '--format=%cI', tag], { cwd: root }).stdout : '';

// 载体现状：存在性 + 交接后是否动过（各自仓库的提交记录）
const carriers = (task.carriers || []).map((c) => {
  const base = c.repo ? path.resolve(root, '..', c.repo) : root;
  const abs = path.join(base, c.path || '');
  const item = { ...c, exists: fs.existsSync(abs) };
  if (item.exists && tagTime) {
    const lg = git(['log', '--oneline', `--since=${tagTime}`, '--', c.path], { cwd: base });
    item.commitsSinceHandoff = lg.status === 0 ? lg.stdout.split('\n').filter(Boolean) : [];
  }
  return item;
});

// 原型侧事实
const html = readFileSafe(path.join(dir, 'index.html')) || '';
const blocks = [...html.matchAll(/data-baton-block\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]);
const ledger = fs.existsSync(path.join(dir, 'ledger'))
  ? fs.readdirSync(path.join(dir, 'ledger')).filter((f) => /^D\d+\.yaml$/.test(f))
      .map((f) => readYamlFile(path.join(dir, 'ledger', f)))
  : [];
const threads = readJsonl(path.join(dir, 'comments', 'threads.jsonl'));
const eff = effectiveStatuses(threads);
const openThreads = threads.filter((t) => t.kind === 'comment' && !['resolved', 'archived'].includes(eff[t.id]));

// 既有断言（v0 只登记，重放在 v0.2）
const assertions = readFileSafe(path.join(dir, 'assertions.yaml'));
const gapIds = fs.existsSync(path.join(dir, 'verify'))
  ? fs.readdirSync(path.join(dir, 'verify')).map((f) => f.match(/^G(\d+)\.md$/)).filter(Boolean).map((m) => parseInt(m[1], 10))
  : [];

const dossier = {
  feature, title: task.title, version: task.version, status: task.status, holder: task.holder,
  handoff: lastHandoff, handoffDoc: lastHandoff ? readFileSafe(path.join(dir, 'handoffs', `${lastHandoff.id}.md`)) : null,
  tag, tagTime,
  blocks, carriers, ledger,
  stubs: (task && task.stubs) || [],
  openThreads: openThreads.map((t) => ({ id: t.id, block: t.block, author: t.author, body: t.body })),
  assertionsPresent: !!assertions,
  nextGapId: 'G' + ((gapIds.length ? Math.max(...gapIds) : 0) + 1),
};

console.log(JSON.stringify(dossier, null, 2));
