// 刷新原型里内联的评论层（loader）—— 工具代码整段替换，页面内容一个字节不碰。
//
// 为什么需要它：loader 在 /preview 出稿时被内联进原型单文件，此后与 kit 脱钩
// （这是「单文件自包含、发给谁双击都一样」的代价）。kit 升级后，老原型仍带旧评论 UI，
// 且毫无提示——和「版本陈旧且不可见」是同一类毛病，所以给一条命令 + check 主动提醒。
//
// 只替换 loader 那一段：从 <style data-baton-loader-css> 到 <script data-baton-loader> 对应的 </script>。
// 用法：node .baton/scripts/refresh-loader.mjs <feature> | --all [--check]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs, repoRoot, readTeam, featureDir, listFeatures, rel, locateLoader, loaderIsCurrent } from './_lib.mjs';

const { flags, pos } = parseArgs(process.argv.slice(2));
const root = repoRoot();
const team = readTeam(root);

const SNIPPET = path.join(root, '.baton', 'scripts', 'loader.snippet.html');
if (!fs.existsSync(SNIPPET)) { console.error('找不到 .baton/scripts/loader.snippet.html —— 请先运行 baton init'); process.exit(1); }
const current = fs.readFileSync(SNIPPET, 'utf8').trim();

const targets = flags.all ? listFeatures(root, team) : [pos[0]].filter(Boolean);
if (!targets.length) {
  console.error('用法：refresh-loader.mjs <feature> 或 --all（加 --check 只报告不改）');
  process.exit(1);
}

let changed = 0, stale = 0, missing = 0;
for (const name of targets) {
  const file = path.join(featureDir(root, team, name), 'index.html');
  if (!fs.existsSync(file)) { console.log(`· ${name}：没有 index.html，跳过`); continue; }
  // loader 注入的「台账」tab 链向 ledger/index.html——建档早于 0.6.2 的功能可能还没有这一页，就地补生成（空态也算一页）
  const lpage = path.join(featureDir(root, team, name), 'ledger', 'index.html');
  if (!fs.existsSync(lpage) && !flags.check) {
    spawnSync(process.execPath, [path.join(root, '.baton', 'scripts', 'render-ledger.mjs'), name], { encoding: 'utf8' });
    if (fs.existsSync(lpage)) console.log(`· ${name}：台账页缺失，已补生成（原型左上角 tab 链向它）`);
  }
  const html = fs.readFileSync(file, 'utf8');
  const loc = locateLoader(html);
  if (!loc) { missing++; console.log(`⚠ ${name}：页面里没有评论层——把 .baton/scripts/loader.snippet.html 内联到 </body> 前`); continue; }
  if (loaderIsCurrent(html, current)) { console.log(`✓ ${name}：评论层已是最新`); continue; }
  stale++;
  if (flags.check) { console.log(`⚠ ${name}：评论层是旧版——跑 node .baton/scripts/refresh-loader.mjs ${name} 刷新`); continue; }
  const next = html.slice(0, loc.start) + current + html.slice(loc.end);
  fs.writeFileSync(file, next);
  changed++;
  const delta = next.length - html.length;
  console.log(`↻ ${name}：评论层已刷新（${rel(root, file)}，${delta >= 0 ? '+' : ''}${delta} 字节；页面内容未改动）`);
}

if (flags.check && stale) process.exit(1);
if (changed) {
  console.log(`\n共刷新 ${changed} 份原型的评论层。这是工具代码更新，不改产品设计——
  · 建议**不升版本号**（台账与交接单不受影响）
  · 提交后组员 git pull 打开页面即得新评论体验`);
} else if (!flags.check && !stale && !missing) {
  console.log('全部已是最新，无需刷新');
}
