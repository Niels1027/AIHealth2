// 版本自检 —— 随项目分发，所以答案永远来自仓库本身，不受本机装了哪个 kit 快照影响。
// 用法：node .baton/scripts/version.mjs [--json]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseArgs, repoRoot, readTeam, sh } from './_lib.mjs';

const { flags } = parseArgs(process.argv.slice(2));
const root = repoRoot();
const verFile = path.join(root, '.baton', 'VERSION');
const capability = fs.existsSync(verFile) ? fs.readFileSync(verFile, 'utf8').trim() : null;

// 本机那个全局 baton 只是转发器；读它的打包版本仅用于「要不要提醒你更新本机命令」
function localShimVersion() {
  const which = sh('sh', ['-c', 'command -v baton']);
  if (which.status !== 0 || !which.stdout) return null;
  try {
    const shim = fs.readFileSync(which.stdout, 'utf8');
    const m = shim.match(/exec node "([^"]+)"/);
    if (!m) return null;
    const pkg = path.join(path.dirname(path.dirname(m[1])), 'package.json');
    if (!fs.existsSync(pkg)) return null;
    return { version: JSON.parse(fs.readFileSync(pkg, 'utf8')).version, kitPath: path.dirname(path.dirname(m[1])) };
  } catch { return null; }
}

const local = localShimVersion();
const team = (() => { try { return readTeam(root); } catch { return null; } })();

if (flags.json) {
  console.log(JSON.stringify({ capability, repo: path.basename(root), localShim: local }, null, 2));
  process.exit(0);
}

if (!capability) {
  console.log(fs.existsSync(path.join(root, '.baton', 'scripts'))
    ? `${path.basename(root)}：已接入 Baton 但没有版本戳（0.2.0 之前接入的）——跑一次 baton init 升级并补上`
    : `${path.basename(root)}：还没接入 Baton`);
  process.exit(0);
}

console.log(`Baton ${capability}（${path.basename(root)}）—— 这是本项目实际在用的能力版本`);
console.log(`  脚本与六条命令都随仓库分发：升级 = 有人跑 baton init 后推送，其余人 git pull`);
if (local) {
  const same = local.version === capability;
  console.log(`  本机 baton 命令：${local.version}${same ? '' : '（旧快照）'} —— 只是转发器，执行的是本仓 .baton/scripts/，${same ? '与上面一致' : '和上面不一致不影响功能'}`);
  if (!same) {
    console.log(`  想让本机命令自身也更新（仅影响它自己的提示文案）：cd ${local.kitPath} && git pull && node bin/baton.mjs install`);
  }
} else {
  console.log('  本机没装全局 baton 命令——不影响使用，仓库里的脚本直接跑即可');
}
