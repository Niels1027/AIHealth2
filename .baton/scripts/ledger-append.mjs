// 台账入账（唯一写入口；台账界面只读，判断都在对话里发生）
// 用法：node .baton/scripts/ledger-append.mjs <feature> --title 标题 --conclusion 结论 \
//         [--decided-by 名字] [--source-kind session|comment] [--source-ref 出处] [--anchors b2,c1]
//       纠错：ledger-append.mjs <feature> --amend D9 [--title ...] [--conclusion ...]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs, repoRoot, readTeam, featureDir, readYamlFile, writeYamlFile, nowIso, gitUserName } from './_lib.mjs';

const { flags, pos } = parseArgs(process.argv.slice(2));
const feature = pos[0];
if (!feature) { console.error('用法：ledger-append.mjs <feature> --title ... --conclusion ...'); process.exit(1); }

const root = repoRoot();
const team = readTeam(root);
const ledgerDir = path.join(featureDir(root, team, feature), 'ledger');
fs.mkdirSync(ledgerDir, { recursive: true });

const existingIds = fs.readdirSync(ledgerDir)
  .map((f) => f.match(/^D(\d+)\.yaml$/)).filter(Boolean).map((m) => parseInt(m[1], 10));

let entry, id, changed = [];
if (flags.amend) {
  id = String(flags.amend).toUpperCase();
  const file = path.join(ledgerDir, `${id}.yaml`);
  if (!fs.existsSync(file)) { console.error(`台账里没有 ${id}`); process.exit(1); }
  entry = readYamlFile(file);
  if (flags.title && flags.title !== entry.title) { entry.title = flags.title; changed.push('标题'); }
  if (flags.conclusion && flags.conclusion !== entry.conclusion) { entry.conclusion = flags.conclusion; changed.push('结论'); }
  if (flags['decided-by'] && flags['decided-by'] !== entry.decidedBy) { entry.decidedBy = flags['decided-by']; changed.push('拍板人'); }
  if (flags.anchors) {
    const next = String(flags.anchors).split(',').map((s) => s.trim()).filter(Boolean);
    if (JSON.stringify(next) !== JSON.stringify(entry.anchors || [])) { entry.anchors = next; changed.push('锚点'); }
  }
  if (!changed.length) {
    console.error(`✗ ${id} 没有任何字段被修改（提供 --title / --conclusion / --decided-by / --anchors 中至少一项，且值需与现值不同）`);
    process.exit(1);
  }
  entry.amendedAt = nowIso();
} else {
  if (!flags.title || !flags.conclusion) { console.error('缺 --title 或 --conclusion'); process.exit(1); }
  const n = existingIds.length ? Math.max(...existingIds) + 1 : 1;
  id = flags.id ? String(flags.id).toUpperCase() : `D${n}`;
  if (fs.existsSync(path.join(ledgerDir, `${id}.yaml`))) { console.error(`${id} 已存在；纠错请用 --amend ${id}`); process.exit(1); }
  const conclusion = flags['conclusion-file']
    ? fs.readFileSync(path.resolve(flags['conclusion-file']), 'utf8').trim()
    : flags.conclusion;
  entry = {
    id,
    feature,
    title: flags.title,
    conclusion,
    decidedBy: flags['decided-by'] || gitUserName(root),
    source: { kind: flags['source-kind'] || 'session', ref: flags['source-ref'] || '' },
    anchors: flags.anchors ? String(flags.anchors).split(',').map((s) => s.trim()).filter(Boolean) : [],
    ts: nowIso(),
  };
}

writeYamlFile(path.join(ledgerDir, `${id}.yaml`), entry, 'Baton 决策台账条目（AI 从对话/评论提炼；纠错在对话里说，不手编此文件）');

// 入账即重渲染可视化页
const r = spawnSync(process.execPath, [path.join(root, '.baton', 'scripts', 'render-ledger.mjs'), feature], { encoding: 'utf8' });
if (r.status !== 0) console.error('台账页重渲染失败：' + (r.stderr || r.stdout));

if (flags.amend) {
  console.log(`✓ 已修正 ${id}（改了：${changed.join('、')}）「${entry.title}」 · 台账页已重新生成（ledger/index.html）`);
  if (changed.includes('结论') && !changed.includes('标题')) {
    console.log(`  ⚠ 标题未改，仍是「${entry.title}」——若新结论推翻了它，同一次 --amend 里连 --title 一起改`);
  }
} else {
  console.log(`✓ 已入账 ${id}「${entry.title}」 · 台账页已重新生成（ledger/index.html）`);
}
