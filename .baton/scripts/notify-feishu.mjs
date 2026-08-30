// 飞书通知：把语义事件变成卡片，按名册翻译称呼。飞书只是铃铛——所有处置都回到仓库与会话。
// webhook 来源：env BATON_FEISHU_WEBHOOK（Actions secret）或 ~/.baton/env（本机）。
// 用法：node .baton/scripts/notify-feishu.mjs '<event-json>'
//       node .baton/scripts/notify-feishu.mjs --file events.json
// 调试：BATON_NOTIFY_DRYRUN=1 时打印 payload 不真发。
import fs from 'node:fs';
import { parseArgs, repoRoot, readTeam, localSecret, cloudUrl } from './_lib.mjs';

const { flags, pos } = parseArgs(process.argv.slice(2));
const root = repoRoot();
const team = readTeam(root);

const feishuName = (github) => {
  const r = team.roster.find((x) => x.github === github);
  return r ? (r.feishu || r.name) : github;
};
const names = (list) => (list || []).map(feishuName).join('、') || '—';

// 配了 cloud.baseUrl（第二级上线）→ 卡片给可点链接：手机上点开就是页面，不必回终端。
// 没配 → 原样给命令，Kit 用户一切照旧。两种形态由 team.yaml 一行决定，仓库数据不变。
function openLineFor(feature) {
  const url = cloudUrl(root, team, feature);
  return url
    ? `[打开页面 ↗](${url}) · 手机也能开 · GitHub 登录后可直接点块评论`
    : `打开：仓库里跑 node .baton/scripts/open.mjs ${feature}（装过全局命令则 baton open ${feature}）`;
}

function cardFor(ev) {
  const openLine = openLineFor(ev.feature);
  const C = { handoff: 'blue', comment: 'orange', 'comments-round': 'orange', reply: 'wathet', answer: 'turquoise', ledger: 'grey' };
  let title, lines;
  if (ev.type === 'handoff') {
    title = `📦 ${ev.feature} ${ev.version} 已交接（${ev.handoff}）`;
    lines = [`**${feishuName(ev.by)}** 把接力棒交给：**${names(ev.to)}**`,
      `交接单：handoffs/${ev.handoff}.md · 原型即任务正文`, openLine + ' · 页面上直接点块评论，@AI 可查台账'];
  } else if (ev.type === 'comment') {
    const t = ev.thread || {};
    title = `💬 ${ev.feature} 新评论${t.summon === 'ai' ? '（已 @AI 召唤代答）' : ''}`;
    lines = [`**${t.author || '?'}** 在区块 \`${t.block || t.parent || '?'}\`：`,
      `> ${String(t.body || '').slice(0, 120)}`,
      t.summon === 'ai' ? 'AI 只答台账有记载的；答不了会流转持棒产品' : `流转给：**${names(ev.notify)}** · 回来 /reply 一次处理`];
  } else if (ev.type === 'comments-round') {
    title = `💬 ${ev.feature} 新评论 ×${ev.count}（一轮）`;
    const rows = ev.items.slice(0, 6).map((i) => `· \`${i.block || '?'}\` ${i.body}${i.summon === 'ai' ? '（@AI 待代答）' : ''}`);
    if (ev.items.length > 6) rows.push(`…等 ${ev.items.length} 条`);
    lines = [`**${ev.author}** 提了一轮意见：`, ...rows,
      `流转给：**${names(ev.notify)}** · 回来 /reply 一次处理`, openLine];
  } else if (ev.type === 'reply') {
    const t = ev.thread || {};
    title = `↩️ ${ev.feature} 你的评论有回复`;
    lines = [ev.quoted ? `你说：> ${ev.quoted}` : '',
      `**${t.author || '?'}** 回复：`, `> ${String(t.body || '').slice(0, 120)}`,
      openLine];
  } else if (ev.type === 'answer') {
    const t = ev.thread || {};
    title = `🤖 ${ev.feature} AI 已代答`;
    lines = [`> ${String(t.body || '').slice(0, 120)}`,
      `依据：台账 ${((t.refs || {}).ledger || []).join(' / ') || '—'} · 无需处理，/reply 时可批量归档`];
  } else if (ev.type === 'ledger') {
    const lp = cloudUrl(root, team, ev.feature, 'ledger/');
    title = `📒 ${ev.feature} 台账 +1（${ev.id}）`;
    lines = [`**${feishuName(ev.by)}** 拍板：${ev.title}`,
      lp ? `[台账页 ↗](${lp})` : `台账页：${ev.feature}/ledger/index.html`];
  } else return null;
  return {
    msg_type: 'interactive',
    card: {
      header: { title: { tag: 'plain_text', content: title }, template: C[ev.type] || 'blue' },
      elements: [{ tag: 'markdown', content: lines.filter(Boolean).join('\n') }],
    },
  };
}

// webhook 值不合法是真实高频事故：把文档里的占位符原样贴进 gh secret、贴成半截 URL、
// 复制时带了引号。此前这会让 fetch 抛未捕获的 ERR_INVALID_URL —— 进程崩、workflow 变红、
// 满屏堆栈，看起来像「Baton 坏了」，而实际只是铃铛配错。
// 铃铛不是构建：说清哪里错、跳过通知、退出码保持 0；在 Actions 里额外打一条醒目的 warning 注解。
function hookProblem(hook) {
  let u;
  try { u = new URL(hook); } catch { return '不是合法 URL'; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return `协议是 ${u.protocol}，应为 https`;
  return null;
}
function warn(msg) {
  console.error(msg);
  // Actions 里绿色通过但铃铛哑了容易被一直忽略；warning 注解会显示在运行摘要顶部
  if (process.env.GITHUB_ACTIONS) console.log(`::warning title=Baton 通知未发出::${String(msg).split('\n')[0]}`);
}

async function send(payload) {
  const hook = localSecret('BATON_FEISHU_WEBHOOK');
  if (process.env.BATON_NOTIFY_DRYRUN) { console.log('[dryrun] ' + JSON.stringify(payload)); return true; }
  if (!hook) { warn('未配置 BATON_FEISHU_WEBHOOK（gh secret 或 ~/.baton/env）——跳过通知'); return false; }
  const bad = hookProblem(hook);
  if (bad) {
    warn(`BATON_FEISHU_WEBHOOK ${bad}（当前值「${hook.slice(0, 40)}${hook.length > 40 ? '…' : ''}」）——通知已跳过，原型 CI 不受影响。
  多半是把占位符原样贴进去了。重设：
  gh secret set BATON_FEISHU_WEBHOOK --repo <owner>/<repo> --body "https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx"`);
    return false;
  }
  let r, body;
  try {
    r = await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    body = await r.text();
  } catch (e) {
    // 网络不通、地址解析失败：同样只该哑掉铃铛，不该崩进程
    warn(`发送失败（${e.message}）——通知已跳过，原型 CI 不受影响`);
    return false;
  }
  if (!r.ok || /"code":\s*[1-9]/.test(body)) { warn('飞书返回异常：' + body.slice(0, 200)); return false; }
  return true;
}

let events;
if (flags.file) events = JSON.parse(fs.readFileSync(flags.file, 'utf8'));
else if (pos[0]) events = [JSON.parse(pos[0])];
else { console.error('用法：notify-feishu.mjs <event-json> 或 --file events.json'); process.exit(1); }
if (!Array.isArray(events)) events = [events];

// 台账事件默认不打铃（避免噪音）；要开在 team.yaml notify.ledgerCard: true
const wanted = events.filter((e) => e.type !== 'ledger' || (team.notify && team.notify.ledgerCard));
let sent = 0;
for (const ev of wanted) {
  const card = cardFor(ev);
  if (card && await send(card)) sent++;
}
console.log(`通知：${sent}/${wanted.length} 张卡${events.length !== wanted.length ? `（${events.length - wanted.length} 条台账事件按配置静音）` : ''}`);
