# TODO

## 未完成

| id | 状态 | 任务 | 指针 | 下一步 | 验收 |
|---|---|---|---|---|---|

## 已完成

### 2026-11-15 · 没有 header 的 root 不再漏计

- 链/步骤：coding → bug-to-check / 测试
- 有效：isRootAgent 把无 header 视为 root；npm test 10/10；pre-push 仍绿
- 失败：红：新用例在旧代码上 `not ok 10`，running 0（未计数）
- 环境 diff：`lib/index.js`（+1 分支）+ `test/host.test.mjs`（+1 用例）

### 2026-11-15 · 问答框等待时在 tab 上提示

- 链/步骤：coding → plan-to-code / 实现 + 测试
- 有效：浏览器侧监听 `data-question-key` / `data-approval-key`，等待状态压过 running/done；host 测试 10/10，浏览器测试全绿（标题重写、运行中、后台、完成、审批、启动时已有卡片）
- 失败：红：新用例在旧代码上 `not ok 1`，`waiting` 未定义（`test/browser.test.mjs:308`）
- 环境 diff：`client.js`、`test/browser.test.mjs`、`README.md`、`README.zh.md`、`package.json`、`TODO.md`

### 2026-11-16 · 非当前会话的问答也标记 tab

- 链/步骤：coding → bug-to-check / 修复 + 测试
- 有效：Host 从 `userQuestions` 投影和问题/审批 waterfall 统计跨会话 `waiting`；浏览器侧认侧栏 `[data-row-key^="session:"] [data-state="warning"]`，没点开会话也会先变 `?`；host 14/14，浏览器测试全绿，实页注入侧栏行后标题从 `(3) DSH 本地构建` 变 `? DSH 本地构建`
- 失败：红：旧实现只认已挂载的 `[data-question-key]`，非当前会话不出现卡片时 `waiting` 保持 false（用户实测）
- 环境 diff：`lib/index.js`、`client.js`、`test/host.test.mjs`、`test/browser.test.mjs`、`README.md`、`README.zh.md`、`package.json`、`TODO.md`
