// /handoff 的确定性半程：校验 → 更新档案 → 一次提交 → 打版本标 → 推送
// （交接单 handoffs/H<n>.md 由 AI 在调用前写好；本脚本不产生任何判断）
// 用法：node .baton/scripts/handoff-commit.mjs <feature> --version v4.1 --to github1,github2 [--now]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs, repoRoot, readTeam, readTask, writeTask, featureDir, currentBranch, git, gitx, nowIso, rel } from './_lib.mjs';

const { flags, pos } = parseArgs(process.argv.slice(2));
const feature = pos[0];
if (!feature || !flags.version || !flags.to) {
  console.error('用法：handoff-commit.mjs <feature> --version vX.Y --to github1,github2');
  process.exit(1);
}

const root = repoRoot();
const team = readTeam(root);
const task = readTask(root, team, feature);
const dir = featureDir(root, team, feature);
const version = String(flags.version);
const to = String(flags.to).split(',').map((s) => s.trim()).filter(Boolean);

// 0) 只允许在默认分支上交接（Baton 不建分支：单持棒人结构性免冲突，git 只记发布历史）
const branch = currentBranch(root);
if (branch !== team.defaultBranch) {
  console.error(`当前在分支 ${branch}，交接必须在 ${team.defaultBranch} 上进行（Baton 不建分支）`);
  process.exit(1);
}

// 1) 交接前 check 必须全绿（页面 meta 应已升到新版本号，用 --expect-version 对齐）
const chk = spawnSync(process.execPath,
  [path.join(root, '.baton', 'scripts', 'check.mjs'), feature, '--expect-version', version], { encoding: 'utf8' });
process.stdout.write(chk.stdout);
if (chk.status !== 0) { console.error('✗ check 未过，先修再交接'); process.exit(1); }

// 2) 版本标不可重复（一版一条）——比交接单检查更根本，先拦
const tag = `baton/${feature}/${version}`;
if (git(['rev-parse', '--verify', `refs/tags/${tag}`], { cwd: root }).status === 0) {
  console.error(`✗ 版本 ${version} 已经交接过（tag ${tag} 已存在）——请升版本号`);
  process.exit(1);
}

// 3) 交接单必须已写好
const hid = 'H' + ((task.handoffs || []).length + 1);
const handoffDoc = path.join(dir, 'handoffs', `${hid}.md`);
if (!fs.existsSync(handoffDoc)) {
  console.error(`✗ 找不到交接单 ${rel(root, handoffDoc)} —— AI 应先写好交接单再调用本脚本`);
  process.exit(1);
}

// 4) 更新档案
task.version = version;
task.status = 'handed-off';
task.defaultNotify = to;
task.handoffs = task.handoffs || [];
task.handoffs.push({ id: hid, version, ts: nowIso(), to });
writeTask(root, team, feature, task);

// 5) 一次提交 + 版本标
gitx(['add', '--', path.relative(root, dir)], { cwd: root });
gitx(['commit', '-m', `baton(handoff): ${feature} ${version} ${hid}`], { cwd: root });
gitx(['tag', tag], { cwd: root });

// 6) 推送（离线时保留本地提交，不算失败）
const push = git(['push', 'origin', `HEAD:${team.defaultBranch}`, tag], { cwd: root });
const pushed = push.status === 0;

// 7) 本地即时通知（可选；正路是推送后 Actions 发卡）
if (flags.now) {
  const notify = path.join(root, '.baton', 'scripts', 'notify-feishu.mjs');
  if (fs.existsSync(notify)) {
    const ev = { type: 'handoff', feature, version, handoff: hid, to, by: task.holder || '' };
    const r = spawnSync(process.execPath, [notify, JSON.stringify(ev)], { encoding: 'utf8' });
    process.stdout.write(r.stdout || '');
    if (r.status !== 0) console.error('（本地即时通知未发出：' + (r.stderr || '').split('\n')[0] + '）');
  }
}

console.log(`✓ 已交接：${feature} ${version}（${hid}）
  · 通知对象：${to.join(', ')}（已记为默认，下次不再问）
  · ${pushed ? '已发布——推送后 Actions 会发飞书卡' : '已在本地定稿；当前离线，联网后自动补发（或手动 git push）'}`);
