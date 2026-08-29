---
name: preview
description: Baton 原型模式。当用户说「出个原型 / 画个方案页 / 做个 preview」，或 @ 引用某个 features/*/index.html 要继续改时使用。产出可运行的单文件 HTML 活原型 + 决策台账。
---

# /preview —— 出活原型

你现在进入 Baton 原型模式。产出物是**可运行的单文件 HTML 原型**——它同时是给人看的方案和给研发的任务正文。平时的对话不受影响，只有本条产出被以下规范接管。

## 第一步：定档

- **新功能**：和用户确认一个 kebab-case 功能名（可从用户的话里自己拟，报给用户即可），然后运行
  `node .baton/scripts/new-feature.mjs <name> --title <中文标题>`
  目录、task.yaml、台账骨架全部由脚本建，你不要手搓。
- **继续已有原型**：用户 @ 了某个 `index.html`，直接在那份上改；不重建档案、不新开目录。

## 第二步：先读现网，再动手画（载体纪律）

**不能凭空设计。** 原型里出现的每一类元素（页面、组件、字段、状态），先到真实代码仓里找到它的载体或明确它是新增；把载体记入 task.yaml 的 `carriers:`：

```yaml
carriers:
  - { repo: n6-fe, path: src/components/SignalMosaicBoard.tsx, symbol: SignalMosaicBoard, note: 现网六砖布局 }
```

repo 指同级目录下的其他仓库；纯本仓载体省略 repo。这不是形式——`check.mjs` 会真的去验证每条 path/symbol 存在，交接前挡你。

## 第三步：写原型

技术规矩（check.mjs C1–C8 机器把关，细则见 `.baton/CONVENTIONS.md`）：

1. 单文件自包含，零 CDN、零外链资源（字体/图标全内联或系统栈）
2. `<meta name="baton-version" content="vX.Y">` 与 task.yaml 一致；版本号可以显示在页角，**绝不进文件名**
3. 每个可评区块加 `data-baton-block="<语义id>"`（改版沿用旧 id，评论挂靠靠它）
4. 把 `.baton/scripts/loader.snippet.html` 整段内联到 `</body>` 前（点块评论层）
5. 正式帧零开发者备注；内部代号一律换人话

品质规矩（同样是交付标准）：

- 多方案对比时，对比稿放 `decisions/<主题>.html`，拍板后**把选中方案合进 index.html**，对比稿留档不再改——它的价值是记录「为什么没选 X」
- 审美：删冗余解释文案、正文左对齐、一个强调色只点一处、留白拉开 CTA、不加装饰性 artifact
- 交互真的可点：状态流转用真 JS 写出来，不做「假装能点」的截图式页面

## 第四步：拍板监听（贯穿整个 session）

用户在对话里做出决定（「就用 S4」「TTL 下沉到投递行」「这个砍掉」）时：

1. 立即调 `node .baton/scripts/ledger-append.mjs <feature> --title "…" --conclusion "…" --decided-by <名字> --source-kind session --source-ref "<出处描述>" --anchors <相关区块id>`
2. 回执一行：`已记录 D9「叠牌画法 = 扇形 + 悬停」`——让用户有机会当场纠错
3. 用户说记错了 → `--amend D9` 改正，不要新开条目

台账界面只读，判断永远在对话里发生。**你只提炼，不替用户做新决策。**

## 第五步：收尾（必做）

1. `node .baton/scripts/check.mjs <feature>` 必须全绿（错误逐条修完再交付）
2. 汇报格式：这轮改了什么（对着区块说）→ 怎么看（本地打开路径 / `baton open <feature>`）→ 台账新增了哪几条 → 下一步提示（「确认后 /handoff 发给研发」）

## 语言规范

本命令是出稿侧——对使用者**不说 git 术语**（无论他平时是产品还是研发）。「已保存」不是「已 commit」；「发给研发」不是「push」。保存草稿期间不做 git 操作——交接那一刻由 /handoff 的脚本定格。
