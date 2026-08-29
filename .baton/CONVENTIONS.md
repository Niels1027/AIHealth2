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

## 原型五条硬规矩（check.mjs 机器把关）

1. **单文件自包含、零 CDN**——复制出去双击打开一模一样（C2）
2. **版本号进页面不进文件名**——`<meta name="baton-version" content="vX.Y">`，且与 task.yaml 一致（C3）
3. **每个可评区块标锚点**——`data-baton-block="<id>"`，id 全页唯一、语义稳定（改版尽量沿用旧 id，评论靠它挂靠；挂不上 = 「原区域已变更」）（C4/C5）
4. **不能凭空设计**——原型里每个元素都有现网载体，记入 task.yaml 的 `carriers:`（path/repo/symbol），check 真的去扫（C6）
5. **带评论加载器**——把 `.baton/scripts/loader.snippet.html` 整段内联到 `</body>` 前（C7）

另：正式帧零开发者备注、内部代号换人话（C8 提示）。

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

- `summon`：`@AI` → `ai`（显式召唤才代答）；`@某人` → `user:<github>`；没 @ 任何人 → null，默认流转持棒产品
- AI 代答铁律：**只转述台账已有记载 + 必带出处**（refs.ledger）；答不了 → 不答，流转产品
- 长回答两段式：页面评论只放结论（两三行），完整推导落 `answers/<线程id>.md`，评论里给「查看推导 ↗」

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
- 入账即重渲染 `ledger/index.html`（自动生成页，三处互链：台账 ↔ 原型锚点 ↔ 讨论出处）

## 语言规范：按命令切换，不按人切换

**角色不在名册里定——你用哪条命令，就是哪个角色。** 同一个人上午出原型、下午写实现是常态。

- 出稿侧命令（/preview /handoff /reply /ledger）：git 完全隐身。说「已保存草稿 / 已发给研发并冻结为 v4.1 / 拍板已入账」，不说 commit / push / tag / branch
- 实现侧命令（/review /verify）：正常使用工程语言

`team.yaml` 的 roster 只是 github ↔ 称呼 ↔ 飞书名 的路由表；里面即使写了 role 字段，Baton 也不读它。

## 验收 verify/

- 基础档（v0）：/verify 读码比对 → Gap 报告 `verify/G<n>.md`（缺/偏/多三类，逐条指区块或 D 号）→ 逐条处置
- **「接受差异」必须回写原型 + 入台账**——原型与实现永不分叉的机制，不是可选项
- `verify-record.mjs` 落档：报告 + 回写改动一次提交；不打 tag（tag 只属于交接）
- 高级档（v0.2）：`baton up` 按 launch.recipe.yaml 起真实环境 + 截图 + `baton assert` 重放 assertions.yaml——一份断言两用（原型交互自测 = 实现验收）

## 状态机

task.yaml `status`: draft →（/handoff）→ handed-off →（研发开工，可选）→ implementing →（/verify 有 Gap）→ verifying →（/verify pass）→ done
线程状态（append-only）: open → answered（有代答）→ resolved / archived；漂移的评论不删，页面标「原区域已变更」
