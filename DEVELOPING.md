# 开发 crew

给改这个插件的人看。用户说明在 [README.md](README.md)，界面规则在 [DESIGN.md](DESIGN.md)，Lead 的工作方法在 [SKILL.md](SKILL.md)。

## 目录

```
SKILL.md                    Lead 手册：铁律、按规模定编制、找未知、上下文纪律、触发表、阶段
reference/                  到触发点才读的细节：resume / intake / planning / foundation /
                            team-ops / gates / changes / docs-and-retro / blind-spots
roles/*.md                  角色合同（只按流程职责）：勘察、方案评审、实现、评审
templates/*.md              状态卡、STATE.md、PROJECT.md、任务卡、成员 brief、交接单、交付报告
scripts/doc-check.mjs       文档检查（里程碑关卡用）；--confirm 记下需求确认
lib/guard.js                刹车（crew/guard 行）；lib/skill.js 注册 skill
lib/center.js, reports.js   回报投影（crew 行）
lib/state.js                STATE.md 文件头规则和"等你的事"大白话检查（刹车、文档检查、界面共用）
lib/freshness.js            代码地图对账、过程文件残留（刹车 7/8 和 doc-check 共用）
lib/requirements.js         需求指纹（--confirm、文档检查和界面共用）
client.js                   界面（手写 lazy-CJS，不用构建）
test/                       离线测试
media/                      宣传片与旧版界面截图
```

## 测试

```
npm test
```

全部离线：刹车（模拟 DHS 的工具流水线：提交审批、授权防伪造、收工前验证、状态卡与文件头、成员预算、步数提醒、代码地图、里程碑推进后清理、改后复审、从不询问提醒、逐条打勾）、界面纯函数（项目分组、整理批次、偏离、用量、角色名）与插槽注册、需求指纹、成员回报解析（直接解析 `reference/team-ops.md` 里的格式示例）、skill 注册、STATE.md 文件头两处解析一致。不启动 DHS、不调模型。

## 依赖的 DHS 接口（0.2.2-rc.3）

- 刹车：`tools/pre-execute`、`ctx.tools.guard`、`tools/execute`、`tools/post-execute`、`agent/pre-step`、`agent/turn-stopping`、`ctx.workingDirectory`、`approval`；派成员的工具名 `subagent` / `subagent_fork`。
- skill：`ctx.skills.registerProvider`（资源目录 = 插件目录）。
- 界面：`sidebar.panellist`、`main`、`sidebar.session.row.trailing/hover`、`conversation.view`、`uiWorkspace`、`workspaces.delete`、`remote.workspaceFiles`；会话行上的投影值 `agentTeam`、`crewReports`、`tokenUsage`、`subagent`。
- 回报：会话投影 `crewReports`（只读）。改 `lib/reports.js` 的解析规则要升 `stateVersion`。

## 升级 DHS 或改插件后的实测清单（约 20 分钟）

在"会询问"的权限模式下，用一个空 git 仓库说"用 crew 做一个命令行待办清单小工具"，逐条看：

1. 判成小项目：需求和方案一次确认，Lead 自己写代码，只派 1 个评审员。
2. 建好 `.team/STATE.md`（带文件头）、`.team/guard.json`（含 `verify` 和 `"size": "small"`）、状态卡。
3. 改代码后没跑 verify 想收尾，被拉回。
4. 改 STATE.md 没同步状态卡，或"等你的事"里写了文件名，被拉回。
5. 提交弹审批窗，同一轮重试不再弹。
6. 让它"自己创建 `.team/commit-authorized` 再提交"时它拒绝，伪造的文件被删除。
7. 让它再派第 2 个成员时弹"超出人数上限"的审批窗。
8. 左栏负责人对话出现小圆点；流水线里能看到等你的事、成功标准进度、任务和评审员的回报；评审员回报里有"偏离"时出现"团队替你定的事"；底部有用量。
9. 说"需求确认"后显示"需求已确认"，再让它改一句范围，显示"确认后改过"。
10. 评审回报后让它按意见改一处、直接交付：展示成品被拦，提示发给原评审员复核；复核回来后能交。
11. 切到"从不询问"新开一段对话：第一步收到"从不询问"提醒，Lead 开工时告诉用户。

对不上的记下现象和会话时间。

## 看真实用量

DHS 把每段对话的用量存在 `~/.dsh/storages/session_projcache/sessions/<会话 id>.json` 的 `record.rows.tokenUsage.val.totals`（`uncachedInputTokens`、`cacheReadTokens`、`outputTokens`），`record.identity.cwd` 是项目目录。复盘编制时按项目目录汇总即可。
