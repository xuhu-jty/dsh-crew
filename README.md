# project-team：DHS 项目团队 skill

让 DeepSeek Harness（DHS）的 Lead 按项目需要组一支 Agent Team，从读懂需求一路做到可交付。这是通用的，不绑定某个项目。

## 安装

在新电脑上（需要先装 git，私有仓库还要先 `gh auth login` 登录同一个 GitHub 账号）：

```
git clone https://github.com/xuhu-jty/dsh-project-team.git %USERPROFILE%\.dsh\skills\project-team
git clone --depth 1 https://github.com/Yun-BaiBai/plain-to-meta.git %USERPROFILE%\.dsh\skills\plain-to-meta
```

PowerShell 里把 `%USERPROFILE%` 换成 `$env:USERPROFILE`。

- 全局：`%USERPROFILE%\.dsh\skills\project-team`（所有项目可用）
- 单个项目：`<项目根>\.dsh\skills\project-team`（项目级优先于全局）

DHS 会自动发现新 skill，不用重启。新开一个会话，在 skill 列表里能看到 `project-team` 即可。

更新到最新版：

```
git -C %USERPROFILE%\.dsh\skills\project-team pull
```

配套 skill（可选，装了会自动用）：`impeccable`、`ponytail`（各自仓库的安装说明见"方法来源"一节的链接）。

## 使用

1. 新建会话，点输入框右下角的模型名（如 DeepSeek-V4.1-Flash）→ 打开 **启用智能体团队协作**（团队模式按会话保存，默认关闭）。忘了开也没关系，Lead 会在开工时提醒你。
2. 对 Lead 说："用项目团队做 <你的项目>"，并附上需求、材料或代码库路径。
3. Lead 会在这些节点停下来等你拍板：需求确认 → 方案与里程碑划分 → 设计方向（有界面时）→ **每个里程碑的验收演示** → 最终交付。其余时候自动推进。
4. 中断了、换了会话、隔天再来：对 Lead 说"用项目团队接着做 <项目路径>"。它会从 `.team/STATE.md` 恢复进度，不会从头再来。
5. Lead 会用弹窗（`ask_user_question`）、用大白话问你问题，不清楚就一轮轮问到清楚为止，每题都有推荐项排第一。
6. 大项目每个里程碑验收后，Lead 会自动开一个新会话"接续 <项目名>"继续干（避免上下文太长后忘规则）。你只需要打开那个新会话，并在模型名菜单里打开"启用智能体团队协作"。

## 大项目怎么跑

已有代码库、多个模块、要跨多天，任一成立就按大项目处理：

- **里程碑 0 地基**：一条命令的 `verify`、给要改的老代码写特征测试锁住现有行为、模块接口先写下来、环境和外部服务替身、git 策略。
- **按里程碑竖着切**：每个里程碑是一条能演示的完整流程，先做风险最高的。只细化当前里程碑，后面的边做边细化。每个里程碑结束给你演示验收。
- **状态写在文件里**：`.team/STATE.md` 记录当前在哪、谁在做什么、等你回答什么。Lead 被压缩或换会话，按它恢复。
- **并行不打架**：多个实现者各用一个 git worktree 和分支，评审通过后由 Lead 逐个合并，合并后跑 `verify`。
- **成员轮换**：一个任务簇或一个里程碑后换新成员，旧成员写交接单，避免越用越差。
- **提交**：第一次提交前问你一次，同意后每个里程碑验收后提交；推送和改历史始终单独问。

## 随时改需求

想到什么直接说。Lead 会记成变更请求（CR-N），评估影响和代价，给你选：现在做 / 下个里程碑 / 放进想法池 / 不做。默认保护正在做的里程碑；你的想法和目的、合规、已定架构冲突时，它会直说一次，你坚持就照做并记下风险。每个里程碑验收时回顾一次想法池。

## 受监管行业

医疗、金融、政务、教育、信创/国产化、处理敏感个人信息的项目，会加一个合规评审：把法规、标准、测评要求追到原文，拆成合规矩阵并进入设计。交付报告单列"上线前必须由有资质的人完成的事"。AI 团队做不了测评、认证和接入审批，也不替你承诺"已合规"。

配合使用（已在全局装好时自动使用）：`impeccable`（界面）、`ponytail` / `ponytail-review`（精简实现与代码审查）、`plain-to-meta`（升级请求与方法钥匙）。

安装 plain-to-meta（推荐）：

```
git clone --depth 1 https://github.com/Yun-BaiBai/plain-to-meta.git %USERPROFILE%\.dsh\skills\plain-to-meta
```

## 你的请求会怎么被升级

开工时 Lead 先用 plain-to-meta 把你的原话按"定向 · 借力 · 深挖"升级：还原真正的目的、补齐你没提的前置环节、挑 1–3 把具名方法（如有限状态机、幂等重试、绞杀者模式、渐进式披露），并写清每个方法改变方案的哪一步。结果在 `.team/request-upgrade.md`，节点①会给你看，你可以纠正。之后复杂任务的任务卡和成员 brief 都带方法钥匙，评审员检查它们是否真的做进了代码，而不只是换了说法。

## 目录

```
SKILL.md                    Lead 手册：铁律、阶段、拍板节点、项目规模判断
reference/resume.md         新项目还是接着做；跨会话/压缩后的恢复顺序；何时更新 STATE.md
reference/intake.md         读懂需求、事实与决定分开、决策树式追问
reference/planning.md       摊全貌、出 2–3 套方案、三视角评审、按流程竖切里程碑
reference/foundation.md     里程碑 0：verify、特征测试、分片勘察、接口先行、环境、git 策略
reference/blind-spots.md    完成整个项目容易漏掉的点（含 DHS 团队协作本身的坑）
reference/team-ops.md       DHS 团队工具速查、按缺口招人、任务板、worktree 并行与合并、成员轮换、交接协议
reference/gates.md          任务 / 评审 / 里程碑（含验收演示）/ 交付四层质量关卡
reference/changes.md        需求变更与想法池：记录、评估影响、四种处理、保护进行中的里程碑
roles/*.md                  9 份角色合同：勘察、产品、架构、设计、实现、评审、测试、文档、合规
templates/*.md              PROJECT.md、STATE.md、任务卡、成员 brief、交接单、交付报告
```

项目运行时会在项目根目录产生：`PROJECT.md`（全景与决策记录）、`PRODUCT.md` / `DESIGN.md`（有界面时）、`CHANGELOG.md`，以及 `.team/`（勘察报告、评审、QA 证据、文档覆盖表；建议提交到 git，作为过程证据）。

## 你的八条要求落在哪

| 要求 | 机制 | 位置 |
|---|---|---|
| 1 准确读懂需求 | 先读后问；用自己的话写出目的/用户/成功标准/锁定与开放/遗漏前置，给用户确认 | intake.md §1–2 |
| 2 模糊处确认 | 事实自查、决定才问；问到清楚为止、用大白话、按依赖顺序、附推荐、弹窗提问；成员不直接问用户 | SKILL 铁律 1–2，intake.md §3 |
| 3 深度和广度 | 前提挑战、三视角并行评审、强制找反证、借别的行业方法并写清改了哪一步 | planning.md §2–3，product/architect 合同 |
| 4 创新 | 必出 2–3 套不同方案（含另辟蹊径）；设计出 2–3 个明显不同方向；10 倍版本与好细节清单由用户逐条选 | planning.md §2、§4，designer 合同 |
| 5 完整做完 | 全景清单；任务板对照全景逐项覆盖；里程碑对账；交付报告列没做的 | planning.md §1，team-ops 任务板规则，gates 里程碑 §5 |
| 6 不冗余、可复用 | 复用阶梯；勘察报告"现有能力"一节；架构复用地图；评审查重复与死代码；里程碑合并重复 | builder 合同，architect 合同，reviewer 合同 |
| 7 文档实时更新 | 行为变了的任务文档不更新不算完成；决策记录；里程碑文档覆盖表 | gates 任务关卡 §5、里程碑 §3，docs 合同 |
| 8 界面合乎逻辑、加功能不突兀 | PRODUCT.md / DESIGN.md + 信息架构图（含扩展位置）；每个界面任务说明放哪、为什么；里程碑界面一致性检查 | designer 合同，gates 任务关卡 §6、里程碑 §2 |
| 角色不空洞 | 每个角色是一份合同：读什么、产出什么、方法、通过标准、不许做；prompt 不写头衔 | roles/*.md，SKILL 铁律 4 |

## 方法来源（借方法，不照抄文本）

- [garrytan/gstack](https://github.com/garrytan/gstack)（MIT）：office-hours 的需求追问与前提挑战、必出多套方案、CEO/工程评审的思考方式、评审清单、文档覆盖表。
- [pbakaus/impeccable](https://github.com/pbakaus/impeccable)：PRODUCT.md / DESIGN.md、critique / audit。本包直接调用已安装的 impeccable，不重写它的规则。
- [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail)（MIT）：复用阶梯、"省代码不省校验"、按触发情形写评审问题。本包直接调用已安装的 ponytail。
- [Yun-BaiBai/plain-to-meta](https://github.com/Yun-BaiBai/plain-to-meta)（MIT）：去头衔化（定向·借力·深挖）、证伪与一手证据、决策树前沿追问、未验证清单。本包在阶段 1 直接调用已安装的 plain-to-meta 升级请求，并从它的分册取方法钥匙放进任务卡和成员 brief。

## 已知限制

- 基于 DHS 0.2.2-rc.3 的团队工具（`subagent`、`send_message`、`wait_agent`、`team_task_*`）。DHS 处于开发者预览，工具名或参数可能变化；升级后先用小项目试一次。
- `write_scopes` 不加锁。小项目靠 Lead 安排不重叠的任务，中/大项目用 git worktree 隔离。
- 大项目机制（里程碑循环、STATE.md 恢复、worktree 合并、成员轮换）已写入，但还没有在真实的大型已有项目上试跑过。
- 成员按独立会话计费，团队越大越贵。手册默认写代码的成员不超过 3 个。
