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
  顺带查一下评论层是否过期：`node .baton/scripts/refresh-loader.mjs <feature> --check`——旧的就刷新一次（纯工具代码替换，不影响你正在改的内容）。

## 第二步：先读现网，再动手画（载体纪律）

**不能凭空设计。** 原型里出现的每一类元素（页面、组件、字段、状态），先到真实代码仓里找到它的载体或明确它是新增；把载体记入 task.yaml 的 `carriers:`：

```yaml
carriers:
  - { repo: web-app, path: src/components/OrderTable.tsx, symbol: OrderTable, note: 现网订单列表，本次改它的筛选区 }
```

repo 指同级目录下的其他仓库；纯本仓载体省略 repo。这不是形式——`check.mjs` 会真的去验证每条 path/symbol 存在，交接前挡你。

## 第三步：写原型

**先读 `.baton/PREVIEW_SPEC.md`（格式规范全文，必读）**。速记版：

- 定位 = PRD + Figma 合一。两条合格线：研发不需要回来问；正式帧可直接被采用
- **概要永远第一屏**：标题定位 / 版本·日期·出稿人·状态 / 改动范围（carriers 人话版）/ 关键拍板 D 号 / 阅读体例
- **多视图上左侧导航**（多角色视角、有工程节、或超约三屏就拆）：`<nav data-baton-nav>` + `data-baton-view`，视图与导航必须对齐、`overview` 排第一（check C10 机器验）；分组顺序 = 概要 → 角色/场景 → 工程
- **正式帧零备注**：说明全放旁侧标注区（浅底无阴影小字，与正式帧视觉强隔离），标注五维度 = 是什么/交互/数据来源/对应拍板 D 号/边界
- **同一卡片全部状态并排陈列**（空/一条/多条/超长/加载/错误/无权限/角色差异），每个带状态名标签；禁止只画理想态
- **改现有 UI 必须左「现状」右「改后」**，现状标明载体来源；删除的标「本次移除」
- **逻辑用表格，算法单独成节**（公式 + 变量人话 + 2–3 个真实数字算例）
- **贴现网**：token 与控件从现网样式取，照抄现网画法不另起炉灶；新元素标注挂点

技术规矩（check.mjs C1–C10 机器把关，细则见 `.baton/CONVENTIONS.md`）：

1. 单文件自包含，零 CDN、零外链资源（字体/图标全内联或系统栈）
2. `<meta name="baton-version" content="vX.Y">` 与 task.yaml 一致；版本号可以显示在页角，**绝不进文件名**
3. 每个可评区块加 `data-baton-block="<语义id>"`（改版沿用旧 id，评论挂靠靠它）
4. 把 `.baton/scripts/loader.snippet.html` 整段内联到 `</body>` 前（点块评论层）
5. 正式帧零开发者备注；内部代号一律换人话
6. **演示替身要登记**：为了让原型独立可跑而写的假东西——写死的口令、假数据、模拟的延迟或存储——每一处记进 task.yaml 的 `stubs:`（what / block / real / risk）。`real` 写清真实现的硬要求（比如「口令只能服务端比对，不能进前端」），这一节会原样进交接单。check C9 会拦住未登记的写死凭证

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
2. 汇报格式：这轮改了什么（对着区块说）→ 怎么看（直接双击 `features/<name>/index.html`，或 `node .baton/scripts/open.mjs <feature>` 起可评论页；**别默认对方装了全局 `baton` 命令**）→ 台账新增了哪几条 → 下一步提示（「确认后 /handoff 发给研发」）

## 语言规范

本命令是出稿侧——对使用者**不说 git 术语**（无论他平时是产品还是研发）。「已保存」不是「已 commit」；「发给研发」不是「push」。保存草稿期间不做 git 操作——交接那一刻由 /handoff 的脚本定格。
