// /verify 的落档半程：Gap 报告入库 + 状态推进 + 一次提交推送
// 「接受差异」时原型/台账的回写改动也在同一提交里定格（不打 tag——tag 只属于交接）
// 用法：node .baton/scripts/verify-record.mjs <feature> --gap G1 --result pass|gaps [--status done|verifying]
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, repoRoot, readTeam, readTask, writeTask, featureDir, git, gitx, rel, nowIso } from './_lib.mjs';

const { flags, pos } = parseArgs(process.argv.slice(2));
const feature = pos[0];
if (!feature || !flags.gap || !flags.result) {
  console.error('用法：verify-record.mjs <feature> --gap G1 --result pass|gaps [--status done|verifying]');
  process.exit(1);
}

const root = repoRoot();
const team = readTeam(root);
const task = readTask(root, team, feature);
const dir = featureDir(root, team, feature);
const gapFile = path.join(dir, 'verify', `${flags.gap}.md`);
if (!fs.existsSync(gapFile)) {
  console.error(`✗ 找不到 ${rel(root, gapFile)} —— AI 应先写好 Gap 报告再调用本脚本`);
  process.exit(1);
}

task.status = flags.status || (flags.result === 'pass' ? 'done' : 'verifying');
task.verify = task.verify || [];
task.verify.push({ id: flags.gap, result: flags.result, ts: nowIso(), version: task.version });
writeTask(root, team, feature, task);

git(['pull', '--rebase', '--quiet'], { cwd: root });
gitx(['add', '--', rel(root, dir)], { cwd: root });
const c = git(['commit', '-q', '-m', `baton(verify): ${feature} ${task.version} ${flags.gap} ${flags.result}`], { cwd: root });
let pushed = false;
if (c.status === 0) {
  let p = git(['push', '--quiet'], { cwd: root });
  if (p.status !== 0) { git(['pull', '--rebase', '--quiet'], { cwd: root }); p = git(['push', '--quiet'], { cwd: root }); }
  pushed = p.status === 0;
}
console.log(`✓ 验收已落档：${flags.gap}（${flags.result}）· 状态 → ${task.status}${pushed ? '' : '（离线，待推送）'}`);
