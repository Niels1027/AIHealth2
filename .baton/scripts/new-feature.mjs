// 新建功能档案（确定性；由 /preview 触发时调用，不给 AI 手搓目录的机会）
// 用法：node .baton/scripts/new-feature.mjs <name> [--title 标题] [--holder github登录名]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs, repoRoot, readTeam, featureDir, writeTask, whoami, warnIfUnmatched, nowIso, rel } from './_lib.mjs';

const { flags, pos } = parseArgs(process.argv.slice(2));
const name = pos[0];
if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
  console.error('用法：new-feature.mjs <kebab-case-name> [--title 标题]');
  process.exit(1);
}

const root = repoRoot();
const team = readTeam(root);
const dir = featureDir(root, team, name);
if (fs.existsSync(path.join(dir, 'task.yaml'))) {
  console.error(`功能「${name}」已存在（${rel(root, dir)}）。继续修改请直接 @ 它的 index.html`);
  process.exit(1);
}

// holder：优先 flag；否则按 git 身份在名册里反查（对不上会显式告警）
let holder = flags.holder || '';
if (!holder) {
  const me = whoami(root, team);
  warnIfUnmatched(me);
  holder = me.github;
}

for (const sub of ['ledger', 'comments', 'decisions', 'handoffs', 'answers']) {
  fs.mkdirSync(path.join(dir, sub), { recursive: true });
}
fs.writeFileSync(path.join(dir, 'comments', 'threads.jsonl'), '');
for (const sub of ['decisions', 'handoffs', 'answers']) {
  fs.writeFileSync(path.join(dir, sub, '.gitkeep'), '');
}

writeTask(root, team, name, {
  name,
  title: flags.title || name,
  status: 'draft',
  version: 'v0.1',
  holder,
  createdAt: nowIso(),
  defaultNotify: [],
  carriers: [],
  stubs: [],   // 演示替身登记处：原型为独立可跑写的假实现（写死口令/假数据），交接单自动带上
  handoffs: [],
});

fs.writeFileSync(path.join(dir, 'launch.recipe.yaml'), `# 一键启动验收环境的配方（baton up 在 v0.2 读它；现在先声明式写下来）
# secret 只写「去哪拿」，绝不写值。
# services:
#   - name: fe
#     cwd: ../your-frontend-repo
#     run: pnpm dev
#     port: 3000
#     env:
#       API_TOKEN: { from: 1password, item: dev-api-token }
# ready: http://localhost:3000/healthz
`);

console.log(`✓ 功能档案已建：${rel(root, dir)}/
  task.yaml（状态 draft · 持棒 ${holder}）
  ledger/ comments/threads.jsonl decisions/ handoffs/ answers/ launch.recipe.yaml
下一步：AI 读现网代码写 index.html（载体记入 task.yaml 的 carriers），完成后跑 check.mjs`);

// 台账页从建档第一天就存在（空态「还没有拍板记录」）——原型左上角的「台账」tab 链接永不 404
spawnSync(process.execPath, [path.join(root, '.baton', 'scripts', 'render-ledger.mjs'), name], { encoding: 'utf8' });
