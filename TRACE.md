# TRACE

## 2026-11-15 · 没有 header 的 root 不再漏计

- 链/步骤：coding → bug-to-check / 测试
- 有效：isRootAgent 把无 header 视为 root；npm test 10/10；pre-push 仍绿
- 失败：红：新用例在旧代码上 `not ok 10`，running 0（未计数）
- 环境 diff：`lib/index.js`（+1 分支）+ `test/host.test.mjs`（+1 用例）

## 2026-11-15 · 问答框等待时在 tab 上提示

- 链/步骤：coding → plan-to-code / 实现 + 测试
- 有效：浏览器侧监听 `data-question-key` / `data-approval-key`，等待状态压过 running/done；host 测试 10/10，浏览器测试全绿（标题重写、运行中、后台、完成、审批、启动时已有卡片）
- 失败：红：新用例在旧代码上 `not ok 1`，`waiting` 未定义（`test/browser.test.mjs:308`）
- 环境 diff：`client.js`、`test/browser.test.mjs`、`README.md`、`README.zh.md`、`package.json`、`TRACE.md`
