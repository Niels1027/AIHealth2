// baton open <feature> —— 用伴侣打开原型页（可评论态）；伴侣没起就先拉起
// --review：研发模式。你在实现分支、树是脏的也没关系——伴侣改为托管一个
//           默认分支的独立 worktree（.baton/review/），你的工作区一根汗毛都不动。
// 用法：node .baton/scripts/open.mjs [feature] [--review] [--port N] [--no-browser]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs, repoRoot, readTeam, listFeatures, currentBranch, git, sh, openCmd, repoVersion, fetchRemote, mergeRemote } from './_lib.mjs';

const { flags, pos } = parseArgs(process.argv.slice(2));
const root = repoRoot();
const team = readTeam(root);
const port = Number(flags.port) || team.companion.port || 4173;

// review 模式：定位/建好 worktree，并同步到远端最新
// 用专用分支 baton-review 而不是直接 checkout 默认分支——否则默认分支被 worktree 占用，
// 研发在主工作区就切不回去了（git 不允许同一分支在两个 worktree 里检出）。
function ensureReviewRoot() {
  // 同步全线 merge（同步纪律，禁 rebase）：本地可能有一次没推出去的交接（commit + tag），
  // rebase 会重写那次提交，tag 却还钉在旧历史上——版本标当场与主线分叉。
  // 合不进去就照旧托管本地现状：读永不挡，同步问题另行在会话里解决。
  if (currentBranch(root) === team.defaultBranch) {
    fetchRemote(root);
    const m = mergeRemote(root, team);
    if (!m.ok) console.error(`（合入远端失败：${m.reason}——先托管本地现状，同步问题在会话里处理）`);
    return root;
  }
  const wt = path.join(root, '.baton', 'review');
  git(['fetch', 'origin', '--quiet'], { cwd: root });
  if (!fs.existsSync(path.join(wt, '.git'))) {
    const hasBranch = git(['rev-parse', '--verify', '--quiet', 'refs/heads/baton-review'], { cwd: root }).status === 0;
    const args = hasBranch
      ? ['worktree', 'add', wt, 'baton-review']
      : ['worktree', 'add', '-b', 'baton-review', wt, `origin/${team.defaultBranch}`];
    const r = git(args, { cwd: root });
    if (r.status !== 0) { console.error(`建 review worktree 失败：${r.stderr}`); process.exit(1); }
  }
  // 同步到远端最新（评论从这里提交，推送时显式映射回默认分支）。worktree 与主仓共享对象库，
  // 上面已 fetch 过；用 merge 而不是 rebase——离线轮次里没推出去的评论提交不该被重写
  const m = git(['merge', '--no-edit', '--quiet', `origin/${team.defaultBranch}`], { cwd: wt });
  if (m.status !== 0) { git(['merge', '--abort'], { cwd: wt }); console.error('review worktree 同步失败，已回滚（先托管上次内容）'); }
  return wt;
}
const serveRoot = flags.review ? ensureReviewRoot() : root;

let feature = pos[0];
if (!feature) {
  const all = listFeatures(serveRoot, team);
  if (all.length === 1) feature = all[0];
  else { console.error('用法：open.mjs <feature>（或装了全局命令后 baton open <feature>）\n可选：' + (all.join(' / ') || '（还没有功能）')); process.exit(1); }
}

const base = `http://localhost:${port}`;
const url = `${base}/${team.featuresDir}/${feature}/index.html`;

// 端口探测：区分「伴侣在」「别的服务占着」「空闲」「探测被环境拦」——报错要指对方向
async function probe() {
  try {
    const r = await fetch(`${base}/baton/health`, { signal: AbortSignal.timeout(600) });
    if (r.ok) return { kind: 'companion', h: await r.json() };
    return { kind: 'other-http', status: r.status };
  } catch (e) {
    const code = (e && e.cause && e.cause.code) || e.code || e.name || '';
    if (code === 'ECONNREFUSED' || (e.cause && Array.isArray(e.cause.errors) && e.cause.errors.every((x) => x.code === 'ECONNREFUSED'))) {
      return { kind: 'free' };
    }
    return { kind: 'unknown', code: String(code) };
  }
}

let p1 = await probe();
if (p1.kind === 'companion' && p1.h.root !== serveRoot) {
  console.error(`端口 ${port} 上的伴侣在托管另一个目录（${p1.h.root}）。换端口：${openCmd(root, feature, `--port ${port + 1}${flags.review ? ' --review' : ''}`)}`);
  process.exit(1);
}
if (p1.kind === 'other-http') {
  console.error(`端口 ${port} 被别的服务占用（返回 HTTP ${p1.status}，不是 Baton 伴侣）。换端口：${openCmd(root, feature, `--port ${port + 1}${flags.review ? ' --review' : ''}`)}`);
  process.exit(1);
}
// 版本闸：常驻进程加载的是启动那一刻的代码，git pull / baton init 都不会让它变新。
// 不比对就会静默复用旧伴侣——症状是新页面调新接口却 404/405，得从版本号一路查到进程启动时间。
if (p1.kind === 'companion') {
  const want = repoVersion(serveRoot);
  const got = p1.h.version || null;
  if (want && got !== want) {
    const who = p1.h.pid ? `kill ${p1.h.pid}` : `lsof -nP -iTCP:${port} -sTCP:LISTEN   # 找到 PID 后 kill 掉`;
    console.error(
      `端口 ${port} 上的伴侣是${got ? `旧版（${got}）` : '旧版（不报版本，说明早于 0.6.5）'}，仓库已是 ${want}。\n` +
      `伴侣跑的是它启动那一刻的代码，更新仓库不会让它变新——先停掉再重来：\n` +
      `  ${who}\n` +
      `  ${openCmd(root, feature, flags.review ? '--review' : '')}`);
    process.exit(1);
  }
}

let h = p1.kind === 'companion' ? p1.h : null;
if (!h) {
  // 伴侣输出落日志（~/.baton/logs/），启动失败时能看到真实原因而不是瞎猜
  let logFile = null, stdio = 'ignore';
  try {
    const os = await import('node:os');
    const dir = path.join(os.homedir(), '.baton', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, `companion-${port}.log`);
    const out = fs.openSync(logFile, 'a');
    stdio = ['ignore', out, out];
  } catch { /* 日志目录建不了就算了，不挡启动 */ }

  const child = spawn(process.execPath, [path.join(serveRoot, '.baton', 'scripts', 'companion.mjs'), '--port', String(port)], {
    cwd: serveRoot, detached: true, stdio,
  });
  child.unref();
  for (let i = 0; i < 20 && !h; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const p2 = await probe();
    if (p2.kind === 'companion') h = p2.h;
  }
  if (!h) {
    let tail = '';
    if (logFile && fs.existsSync(logFile)) {
      tail = fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-4).join('\n  ');
    }
    console.error(`伴侣未能启动。${tail ? '日志尾部（' + logFile + '）：\n  ' + tail : ''}
${p1.kind === 'unknown' ? `（另外：本机探测 localhost 被拦（${p1.code}）——伴侣可能其实已在运行，只是这里连不上；受限环境常见）` : '常见原因：端口刚被释放还在 TIME_WAIT，稍等重试；或手动跑 node .baton/scripts/companion.mjs 看现场'}`);
    process.exit(1);
  }
  console.log(`伴侣已拉起 · ${base}${flags.review && serveRoot !== root ? ' · 托管 review worktree（你的工作区不受影响）' : ''}`);
}

console.log(`打开 ${url}`);
if (!flags['no-browser']) {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  sh(opener, [url]);
}
