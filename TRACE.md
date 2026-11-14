# TRACE

## 2026-11-15 · 没有 header 的 root 不再漏计

- 链/步骤：coding → bug-to-check / 测试
- 有效：isRootAgent 把无 header 视为 root；npm test 10/10；pre-push 仍绿
- 失败：红：新用例在旧代码上 `not ok 10`，running 0（未计数）
- 环境 diff：lib/index.js（+1 分支）+ test/host.test.mjs（+1 用例）+ PROJECT.md / AGENTS.md / TRACE.md
