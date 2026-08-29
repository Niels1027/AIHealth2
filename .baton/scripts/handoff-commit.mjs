// /handoff 的确定性半程：先与远端合流 → 校验 → 更新档案 → 一次提交 → 打版本标 → 推送
// （交接单 handoffs/H<n>.md 由 AI 在调用前写好；本脚本不产生任何判断）
// 用法：node .baton/scripts/handoff-commit.mjs <feature> --version v4.1 --to github1,github2 [--now]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs, repoRoot, readTeam, readTask, writeTask, featureDir, currentBranch, git, gitx, nowIso, rel, syncStatus, mergeRemote, syncThenPush } from './_lib.mjs';

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

// 0.5) 先与远端合流——绝不在陈旧的基座上定格（否则 commit+tag 全部搁浅，推送必被拒）
const st = syncStatus(root, team);
if (st.fetched && st.behind > 0) {
  if (st.overlap.length) {
    console.error(`✗ 远端在你出稿期间更新了这些文件，与你本地未保存的改动重叠：
    ${st.overlap.join('\n    ')}
  先在会话里把它们存档（commit），再重新交接。不用 rebase、不用 stash。`);
    process.exit(1);
  }
  const m = mergeRemote(root, team);
  if (!m.ok) { console.error(`✗ 合并远端失败（${m.reason}），需要在会话里处理后再交接`); process.exit(1); }
  console.log(`（已先合入远端 ${st.behind} 个新提交——出稿期间团队有新动静，交接建立在最新基座上）`);
}
if (!st.fetched) console.log('（连不上远端——将先在本地定格，恢复后补发）');

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

// 5) 一次提交（pathspec 限定功能目录，绝不卷走用户暂存区里的其他文件）+ 版本标
const featRel = path.relative(root, dir);
gitx(['add', '--', featRel], { cwd: root });
gitx(['commit', '-m', `baton(handoff): ${feature} ${version} ${hid}`, '--', featRel], { cwd: root });
gitx(['tag', tag], { cwd: root });

// 6) 合流 + 推送（commit → merge → push；失败说清原因，绝不谎报「离线」）
const res = syncThenPush(root, team, { refspecs: [`HEAD:${team.defaultBranch}`, tag] });
const pushed = !!res.pushed;

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
  · ${pushed ? '已发布——推送后 Actions 会发飞书卡' : `已在本地定格，尚未发布：${res.hint}`}`);
if (!pushed) process.exitCode = 0;   // 本地定格成功不算失败；同步问题已如实告知
