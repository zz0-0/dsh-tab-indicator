# dsh-tab-indicator-plugin · 工作回路

> 由 `setup` 生成；改这里就是改回路。开工先读本页，收尾跑 `closeout --repo .`。

## 入口

- 入口命令：`direnv exec . npm test`
- 测试：`direnv exec . npm test`
- 链：`/home/zz/Project/ai/chains/coding.md`
- 技能包：`/home/zz/Project/ai/skills/packs/coding/INDEX.md`
- 文档：`README.md`
- 任务记录：`TRACE.md`

## 闸门

- pre-push：`.githooks/pre-push`（新 clone 后 `git config core.hooksPath .githooks`）
- closeout：check + `TRACE.md` 最新一节四行 + 一个环境 diff / none

## 不做

- 状态不写链；状态在本页、`TRACE.md`、`status`。
