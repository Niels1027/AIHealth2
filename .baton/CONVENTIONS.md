# Baton 规范（.baton/CONVENTIONS.md）

本文件由 baton init 写入并随 kit 升级刷新，是六条命令共同遵守的单一规范源。

## 目录七件套

```
<featuresDir>/<功能名>/            # kebab-case；一个功能 = 一个可运行原型 = 一个任务
  index.html                       # 活原型本体：当前交付版，唯一对外那一份
  task.yaml                        # 档案：状态/版本/持棒人/载体/交接索引（AI 与脚本维护）
  ledger/D*.yaml + index.html      # 决策台账（只读；index.html 自动生成，手编会被覆盖）
  comments/threads.jsonl           # 点块评论（独立板块，不写进原型本体；merge=union）
  answers/<线程id>.md              # AI 代答的完整推导（页面上只放结论）
  decisions/                       # 拍板前的方案对比稿，拍完冻结——记录「为什么没选 X」
  handoffs/H<n>.md                 # 交接单，一版一份
  launch.recipe.yaml               # 一键起验收环境的声明式配方（secret 只写去哪拿）
```

## 原型七条硬规矩（check.mjs 机器把关）

1. **单文件自包含、零 CDN**——复制出去双击打开一模一样（C2）
2. **版本号进页面不进文件名**——`<meta name="baton-version" content="vX.Y">`，且与 task.yaml 一致（C3）
3. **每个可评区块标锚点**——`data-baton-block="<id>"`，id 全页唯一、语义稳定（改版尽量沿用旧 id，评论靠它挂靠；挂不上 = 「原区域已变更」）（C4/C5）
4. **不能凭空设计**——原型里每个元素都有现网载体，记入 task.yaml 的 `carriers:`（path/repo/symbol），check 真的去扫（C6）
5. **带评论加载器**——把 `.baton/scripts/loader.snippet.html` 整段内联到 `</body>` 前（C7）
6. **演示替身要登记**——原型为独立可跑写的假实现（写死口令/假数据/模拟行为）逐条记入 task.yaml `stubs:`；未登记的写死凭证会被拦（C9）
7. **结构成规**——概要先行；多视图必须左侧导航且与视图对齐（`data-baton-nav` ↔ `data-baton-view`，`overview` 排第一）（C10）；格式全文见 `.baton/PREVIEW_SPEC.md`（PRD+Figma 合一：正式帧零备注、状态穷举并排、改前改后对照、逻辑用表格、贴现网不另起炉灶）

另：正式帧零开发者备注、内部代号换人话（C8 提示）。

## 演示替身 stubs（task.yaml）

```yaml
stubs:
  - what: 管理口令写死在页面 JS（moss-2026）
    block: b-admin-key
    real: 新增服务端校验接口；口令只存服务端 env、只在服务端比对，前端只递输入、收会话
    risk: security   # security / data / behavior
```

原型里有替身天经地义——单文件才能独立演示；**危险在交接后被照抄进真实现**。所以：/preview 出稿时逐处登记，/handoff 把这节原样带进交接单（security 排最前），/verify 比对时逐条核销「替身是否已按 real 的要求替换」。

## 版本与发布

- 版本 = task.yaml 的 `version`；/handoff 时升版（默认 +0.1，用户点名则从其说）
- **不建分支**。单持棒人可写、结构性免冲突；「发给研发」= 对默认分支一次提交 + tag `baton/<功能>/<版本>`，git 只记发布历史
- 草稿期的中间态不逐一提交；交接那一刻才定格

## threads.jsonl（每行一个 JSON）

```json
{"id":"t-xxxx","feature":"…","block":"b2","author":"张工","github":"zhang-gong",
 "body":"…可 @AI 或 @名册里的名字…","kind":"comment|reply|answer",
 "parent":null,"status":"open|answered|resolved|archived","summon":"ai|user:<github>|null",
 "refs":{"ledger":["D5"],"answer":"answers/t-xxxx.md"},"ts":"ISO8601"}
```

- `summon`：输入框里的 `@AI` **先在提问端本地列台账**（读 `ledger/anchors.json`，不写任何记录）——解惑就不发；仍要问会去掉召唤走正常流转；本地查不到而保留 @AI 发出时才落 `ai`（对端 /reply 代答兜底）。`@某人` → `user:<github>`；没 @ 任何人 → null，默认流转持棒产品
- AI 代答铁律：**只转述台账已有记载 + 必带出处**（refs.ledger）；答不了 → 不答，流转产品
- 长回答两段式：页面评论只放结论（两三行），完整推导落 `answers/<线程id>.md`，评论里给「查看推导 ↗」
- **代拟回帖同构两段式**：产品口述观点、AI 拟稿的回帖，正文只放两三行提炼并记 `drafted:"ai"`（页面标「AI 代拟」）；用户原话与完整推导落 `answers/<线程id>.md`（refs.answer，页面给「原话与完整理由 ↗」），涉及拍板挂 refs.ledger。**拟稿必须给本人过目后再发**——署名是本人，文字要经本人的眼
- **发送只有攒批一种**——评论一律先落本机草稿（`comments/drafts-<github>.jsonl`，gitignore 不入库），侧栏「本轮新增」可回看/撤回；「发出本轮」= 整批打同一 `round` 批次号 + **一个提交 + 一次推送 + 一张合并通知卡**（一轮 = 团队被打断一次）。防忘发三道：页面草稿徽标、伴侣启动提醒、/review /reply 检测

## 台账 ledger/D*.yaml

```yaml
id: D9
feature: …
title: 一句话结论式标题
conclusion: 拍板内容（可多行）
decidedBy: niels
source: { kind: session|comment, ref: "handoffs/H1.md" 或 线程id 或行号描述 }
anchors: [b2]        # 关联的原型区块
ts: ISO8601
```

- **台账只读**：拍板在对话里说，AI 识别后调 `ledger-append.mjs` 入账并回执一行；纠错也在对话里说（「D9 记错了」→ `--amend D9`）
- 入账即重渲染 `ledger/index.html`（自动生成页，三处互链：台账 ↔ 原型锚点 ↔ 讨论出处），并同步产出 `ledger/anchors.json`（区块 → 条目的反转索引：评论框上的拍板提示、@AI 本地查、/review 台账摘要共用的数据源）

## 网页参与（可选 · 第二级）

`team.yaml` 里加一行就开：

```yaml
cloud:
  baseUrl: https://你的域名        # 云伴侣地址；不配则一切照旧走本机
  repo: owner/name                # 可选，远端不是 github.com 时显式指定
```

配了之后：飞书通知卡里的「打开：仓库里跑 …」变成**可点的「打开页面 ↗」**，手机也能开；点开是 GitHub 登录，权限跟着仓库走（链接可转发、非协作者看不到内容）。页面上看原型、看台账、点块评论、发出本轮，与本机体验一致——因为渲染的是同一批仓库文件、同一个 loader。服务端部署见 kit 仓库的 `cloud/README.md`。

## 语言规范：按命令切换，不按人切换
**角色不在名册里定——你用哪条命令，就是哪个角色。** 同一个人上午出原型、下午写实现是常态。

- 出稿侧命令（/preview /handoff /reply /ledger）：git 完全隐身。说「已保存草稿 / 已发给研发并冻结为 v4.1 / 拍板已入账」，不说 commit / push / tag / branch
- 实现侧命令（/review /verify）：正常使用工程语言

`team.yaml` 的 roster 只是 github ↔ 称呼 ↔ 飞书名 的路由表；里面即使写了 role 字段，Baton 也不读它。

## 升级：三类改动，老原型各自怎么办

kit 升级后，已存在的原型不会全部自动跟上——按改的是哪一层区分：

| 类型 | 例子 | 老原型怎么办 |
|---|---|---|
| **① 工具代码**（每份原型都一样） | 评论侧栏、攒批发送 | `baton refresh-loader <功能名>`／`--all` 一条命令刷新，**页面内容不动**；check C7 会主动提醒过期 |
| **② 内容规范**（因原型而异） | 左侧导航、概要六件套、状态穷举 | **必须 AI 参与**——在会话里让它按 `.baton/PREVIEW_SPEC.md` 重整；脚本不可能知道你这份该拆几个视图。check C10 会拦住"多视图却没导航"，但不会替你拆 |
| **③ 流程与脚本** | 同步纪律、C9/C10 检查 | 自动生效——脚本在仓库里，`git pull` 就是新的 |

新出稿的原型三类全自动：loader 内联时就是最新的，AI 也照最新规范写。

## 同步纪律（历史分叉时怎么对齐）

- **读永不挡**：/reply /review 的清单永远 fetch 后直接读远端引用——看东西不需要动工作区，任何状态都看得全
- **写 = commit → merge → push**：先把自己的落袋（存档），再把远端的合进来，最后一起推出去。落后时 push 必被拒——那是 git 在保护别人的工作，绝不 --force
- **全线 merge，禁 rebase 禁 stash**：交接 tag 钉住了历史（定格不可改写），rebase 会重写它；stash 是共享活树的事故源
- **失败必须说话**：同步失败时脚本会说清原因（重叠文件点名／连不上远端／冲突），绝不静默继续读旧数据、绝不把「被拒」谎报成「离线」

## 验收 verify/

- 基础档（v0）：/verify 读码比对 → Gap 报告 `verify/G<n>.md`（缺/偏/多三类，逐条指区块或 D 号）→ 逐条处置
- **「接受差异」必须回写原型 + 入台账**——原型与实现永不分叉的机制，不是可选项
- `verify-record.mjs` 落档：报告 + 回写改动一次提交；不打 tag（tag 只属于交接）
- 高级档（v0.2）：`baton up` 按 launch.recipe.yaml 起真实环境 + 截图 + `baton assert` 重放 assertions.yaml——一份断言两用（原型交互自测 = 实现验收）

## 状态机

task.yaml `status`: draft →（/handoff）→ handed-off →（研发开工，可选）→ implementing →（/verify 有 Gap）→ verifying →（/verify pass）→ done
线程状态（append-only）: open → answered（有代答）→ resolved / archived；漂移的评论不删，页面标「原区域已变更」
