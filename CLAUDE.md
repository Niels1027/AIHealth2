<!-- baton:begin -->
## Baton（原型与产研交接）

本仓库用 Baton 管理产品原型与交接。**任何「出个原型 / 画个方案页 / 改原型」的需求，先读 `.baton/CONVENTIONS.md` 与 `.baton/PREVIEW_SPEC.md` 再动手**，不要自行决定产出位置或格式。

- 功能目录：`features/<功能名>/` —— 活原型 `index.html` + 决策台账 `ledger/` + 评论 `comments/threads.jsonl` + 交接单 `handoffs/`
- 确定性动作一律走脚本，不要手搓：建档 `.baton/scripts/new-feature.mjs`、原型 CI `check.mjs`、拍板入账 `ledger-append.mjs`、交接 `handoff-commit.mjs`、评论处置 `thread-update.mjs`
- 会话命令（宿主支持则可直接用）：`/preview` `/handoff` `/review` `/reply` `/ledger` `/verify`
- 铁律：原型单文件自包含零外链；每个可评区块带 `data-baton-block`；原型元素必须有现网载体（记入 `task.yaml` 的 carriers）；写死的凭证/假数据必须登记进 `stubs`；AI 代答只转述台账已有记载且必带出处，答不了就流转持棒人
- 对出稿方不说 git 术语（「已保存草稿」而非 commit）；不建分支
<!-- baton:end -->
