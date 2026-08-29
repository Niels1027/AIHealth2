---
name: handoff
description: Baton 交接。当用户说「发给研发 / 交接 / handoff / 定稿发出去」时使用。生成交接单、选通知对象、一次定格发布并触发飞书通知。
---

# /handoff —— 把接力棒交给研发

产品对原型满意后，用这条把「原型 + 台账」作为接力棒交出去。整个过程你只做两件判断（写交接单、问通知对象），其余全部交给脚本。

## 流程

1. **前置检查**：`node .baton/scripts/check.mjs <feature>` 必须全绿。不绿就先修（缺锚点/缺载体/版本不一致都会在这里被拦住），修完再继续。

2. **定版本号**：读 task.yaml 当前 `version`，默认建议 +0.1（如 v4.0 → v4.1）报给用户；用户点名了版本号就用用户的。定下后**先把 index.html 里的 `baton-version` meta（和页角显示）升到新版本号**——task.yaml 由脚本更新，你不要手改。

3. **写交接单** `handoffs/H<n>.md`（n = task.yaml 里 handoffs 数量 + 1）。内容结构：
   - **这版是什么**：一段话 + 相对上一版改了什么（对着区块 id 说）
   - **要实现什么**：逐条可勾选的实现清单，每条尽量指向原型里的具体区块（`index.html` 的 `data-baton-block` id）
   - **载体清单**：从 task.yaml 的 carriers 摘录——研发从哪些现网文件入手
   - **已拍板的约束**：从台账摘 3–5 条最关键的（带 D 号），防止实现时把定过的又改回去
   - **开放问题**：还没拍板、允许研发自行判断的点（明说「可自行判断」）
   - 结尾一行：`打开原型：baton open <feature>；评论直接点页面区块，@AI 可查台账`

4. **选通知对象**：用 AskUserQuestion（多选），选项来自 `.baton/team.yaml` 的 roster（label 用称呼，value 用 github 登录名）。task.yaml 里已有 `defaultNotify` 时把这些人预选为推荐项，并注明「上次也是发给他们」。

5. **一次定格发布**：
   `node .baton/scripts/handoff-commit.mjs <feature> --version vX.Y --to a,b`
   脚本会自己完成：再跑一遍 check → 更新档案 → 一次提交 + 版本标 → 推送。推送后 GitHub Actions 会把飞书卡发给选中的人。本地想立即发通知可加 `--now`（需要本机配置过 webhook）。

6. **汇报**（对产品角色的语言）：
   > 已发给 张工、小吴，定稿为 v4.1。交接单在 handoffs/H2.md；他们打开页面就能点块评论，@AI 的问题会按台账代答。有新评论时你会在飞书收到铃铛，回来 /reply 一次处理。

## 红线

- 交接单里**不复述原型内容**——原型本体就是任务正文，交接单只写「怎么读它 + 别踩什么」
- 不建分支、不解释 git；「定稿发布」的机械动作全在脚本里，你不要手工跑 git 命令
- check 不绿绝不交接，哪怕用户催——把没过的项列给用户看，修完立刻发
