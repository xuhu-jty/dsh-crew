# crew-guard

crew skill 的刹车插件。只在带 `.team/` 目录的项目里生效，其他项目完全不受影响。只依赖 Node 内置模块。

## 四个刹车

1. **提交审批**：`git commit` / `git push` 弹 DHS 审批窗。
   - 同一轮对话里批准过一次，重试同一项目的提交不再弹。
   - 用户本人创建 `.team/commit-authorized` = 里程碑整批授权，不弹窗；删掉即收回。
   - git worktree 里的 commit（成员在自己分支上）不弹窗；push 一律要批。
   - 会话审批策略是"从不询问"时没法弹窗 → 直接拒绝，并告诉 agent 该怎么跟用户说。
2. **授权防伪造**：
   - 事前：写文件工具或命令里出现授权文件名 → 拒绝。
   - 事后：每次工具调用结束比对授权文件指纹，这次调用期间出现或被改 → 判定伪造，删除并拦下。只看结果，不看命令怎么写。
3. **收工前验证**：这一轮用 write / edit / apply_patch 改过项目文件（纯文档和 `.team/` 除外），之后没跑通 `.team/guard.json` 里的 verify，就不让这一轮结束，把 agent 拉回来（每轮最多 2 次）。
   ```json
   { "verify": "verify.ps1" }
   ```
4. **状态卡**：项目根 `AGENTS.local.md` 由 DHS 自动注入。这一轮改了 `.team/STATE.md` 却没改状态卡 → 收工前拉回来；项目没有状态卡 → 本会话提醒一次。

## 安装 / 更新

见上一级目录的 `README.md`。装进 DHS 的是副本，改了源码要重新安装并重启 DHS。

## 测试

```
node test/guard.test.mjs
```

离线模拟 DHS 的 agent 循环与工具流水线（pre-step → pre-execute → 审批 → 守卫 → execute → post-execute → turn-stopping），不需要启动 DHS。

## 依赖的 DHS 接口（0.2.2-rc.3）

`tools/pre-execute`（返回 ask / deny）、`ctx.tools.guard`、`tools/execute`、`tools/post-execute`（block）、`agent/pre-step`、`agent/turn-stopping` + `agent.inbox.append('next-step', …)`、`ctx.workingDirectory.get(session)`、`ctx.get('approval').overrideOf(session)`。DHS 升级后先跑测试，再用小项目实测。

## 已知局限

- 提交识别靠命令文字；藏进脚本文件的 git 调用能躲过审批。
- 收工前验证只认文件工具的改动，shell 命令改的文件不会触发。
- 用户恰好在 agent 执行命令期间手动创建授权文件，会被误判为伪造删掉，重建一次即可。
