// 事件抽取：从一段 push（before..after）里读出语义事件（交接 / 新评论 / 新入账）
// 事件从台账对象产生，不是文件 diff 的机械播报。输出 JSON 数组到 stdout，供 notify-feishu 消费。
// 用法：node .baton/scripts/extract-events.mjs --from <sha> --to <sha>
import path from 'node:path';
import { parseArgs, repoRoot, readTeam, git, readYamlFile, readJsonl } from './_lib.mjs';
import fs from 'node:fs';

const { flags } = parseArgs(process.argv.slice(2));
const root = repoRoot();
const team = readTeam(root);

// 只在默认分支上产事件（Actions 里由 GITHUB_REF 判断；本地调用不受限）
if (process.env.GITHUB_REF && process.env.GITHUB_REF !== `refs/heads/${team.defaultBranch}`) {
  console.log('[]');
  process.exit(0);
}

let from = flags.from, to = flags.to || 'HEAD';
if (!from || /^0+$/.test(from)) {
  // 新分支首推等场景：退到只看最后一个提交
  from = git(['rev-parse', `${to}~1`], { cwd: root }).status === 0
    ? git(['rev-parse', `${to}~1`], { cwd: root }).stdout : null;
}
if (!from) { console.log('[]'); process.exit(0); }

const fdir = team.featuresDir;
const events = [];
const featureOf = (p) => {
  const m = p.match(new RegExp(`^${fdir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([^/]+)/`));
  return m ? m[1] : null;
};

// 逐提交扫（保留事件与提交的对应关系）
const commits = git(['rev-list', '--reverse', `${from}..${to}`], { cwd: root }).stdout.split('\n').filter(Boolean);
for (const sha of commits) {
  const msg = git(['log', '-1', '--format=%s', sha], { cwd: root }).stdout;
  const files = git(['diff-tree', '--no-commit-id', '--name-status', '-r', sha], { cwd: root }).stdout
    .split('\n').filter(Boolean).map((l) => { const [st, ...p] = l.split('\t'); return { st, path: p.join('\t') }; });

  // 1) 交接：提交信息是权威来源
  const hm = msg.match(/^baton\(handoff\): (\S+) (\S+) (H\d+)$/);
  if (hm) {
    const [, feature, version, hid] = hm;
    let to_ = [], by = '';
    try {
      const task = readYamlFile(path.join(root, fdir, feature, 'task.yaml'));
      const rec = (task.handoffs || []).find((h) => h.id === hid);
      to_ = rec ? rec.to : (task.defaultNotify || []);
      by = task.holder || '';
    } catch { /* 档案缺失也发事件 */ }
    events.push({ type: 'handoff', feature, version, handoff: hid, to: to_, by, sha });
    continue;
  }

  for (const f of files) {
    const feature = featureOf(f.path);
    if (!feature) continue;

    // 2) 评论板块的新增行 → 按记录类型分流（状态流转不打扰任何人）
    if (f.path.endsWith('comments/threads.jsonl')) {
      const diff = git(['diff', `${sha}~1..${sha}`, '--', f.path], { cwd: root }).stdout;
      const all = readJsonl(path.join(root, f.path));   // 用于回溯 parent 的作者
      const rootOf = (id) => {
        let cur = all.find((x) => x.id === id);
        for (let i = 0; i < 8 && cur && cur.parent; i++) cur = all.find((x) => x.id === cur.parent);
        return cur;
      };
      const rounds = {};   // 同一批次（round）的评论合并成一个事件——一轮一张卡
      for (const line of diff.split('\n')) {
        if (!line.startsWith('+') || line.startsWith('+++')) continue;
        try {
          const t = JSON.parse(line.slice(1));
          if (t.kind === 'status') continue;   // 归档/解决是内部状态，不发卡
          if (t.kind === 'answer') { events.push({ type: 'answer', feature, thread: t, sha }); continue; }
          if (t.kind === 'reply') {
            // 回帖通知原提问者（自己回自己不打扰）
            const r = t.parent ? rootOf(t.parent) : null;
            const notify = r && r.github && r.github !== t.github ? [r.github] : [];
            events.push({ type: 'reply', feature, thread: t, notify, quoted: r ? String(r.body || '').slice(0, 60) : '', sha });
            continue;
          }
          // 新评论：@人 → 那些人；@AI → 无人（代答处理）；没 @ → 持棒产品
          let notify = t.mentions || [];
          if (!notify.length && t.summon !== 'ai') {
            try { notify = [readYamlFile(path.join(root, fdir, feature, 'task.yaml')).holder].filter(Boolean); } catch { /* */ }
          }
          if (t.round) {
            (rounds[t.round] = rounds[t.round] || { threads: [], notify: new Set() }).threads.push(t);
            for (const n of notify) rounds[t.round].notify.add(n);
          } else {
            events.push({ type: 'comment', feature, thread: t, notify, sha });
          }
        } catch { /* 非 JSON 行忽略 */ }
      }
      for (const [round, g] of Object.entries(rounds)) {
        events.push({ type: 'comments-round', feature, round, author: g.threads[0].author || '?',
          count: g.threads.length,
          items: g.threads.map((t) => ({ block: t.block, body: String(t.body || '').slice(0, 60), summon: t.summon })),
          notify: [...g.notify], sha });
      }
    }

    // 3) 新入账（A = 新增的 D*.yaml）
    const lm = f.path.match(/ledger\/(D\d+)\.yaml$/);
    if (lm && f.st === 'A') {
      try {
        const entry = readYamlFile(path.join(root, f.path));
        events.push({ type: 'ledger', feature, id: lm[1], title: entry.title || '', by: entry.decidedBy || '', sha });
      } catch { /* */ }
    }
  }
}

console.log(JSON.stringify(events, null, 2));
