# 验证记录

日期：2026-10-05（Asia/Singapore）。本机 Claude Code：2.1.289。

发布前版本统一为 `0.1.0`，源码与本机用户安装均已同步。下文的 0.2.0/0.2.1 是此前调试记录中的临时版本号，功能与测试结果保留。

## 用户反馈后的加载复查

普通 `claude -p '/ea-status' --plugin-dir ...` 已复现失效。日志显示 `tengu_plugin_hooks_modules` 使用早先会话的磁盘缓存 false，拉取 `fetch settled with no payload`，随后拒绝加载 `english-assistant@inline`。因此之前的成功验证只说明当时会话可用，不能保证后续普通启动可用。

仅在子进程中设置官方变量 `DISABLE_GROWTHBOOK=1` 后，`/ea-status` 返回正确模型、接口与开启状态。已将此本地调试模式加入 `start.ps1`，并注明对其他远程功能开关的影响。没有修改 `.claude.json` 缓存，也没有修改组织策略。

| 验证 | 结果 |
| --- | --- |
| `node --test tests/core.test.mjs` | 26 项通过：新增跨加载全局用量、独立实例汇总、未知用量、损坏记录提示与持久化失败不阻断翻译 |
| `claude plugin test .` | 5 项通过：包含 terminal/desktop 面板按钮关闭和重开，不重复翻译 |
| `claude plugin validate . --strict` | 通过，事件与 API 调用被静态分析识别 |
| `claude -p /ea-status --plugin-dir ...` | 加载成功，正确读取本地模型及接口配置 |
| `claude -p '/ea-debug Please explan how this functon works.' --plugin-dir ...` | 使用真实 Mods HTTP 路径成功，756 ms，正确纠正 explan 和 functon |
| `node scripts/smoke.mjs` | 五组真实请求全部成功；输出保存在 debug-report.json |

最后一轮 smoke 的接口耗时：

| 示例 | 耗时 |
| --- | --- |
| 中文转英文 | 901 ms |
| 英文纠错和润色 | 830 ms |
| 混合输入、代码和链接保护 | 1022 ms |
| 上下文与否定意图 | 527 ms |
| 最终回复翻译 | 337 ms |

这些数字是小样本单次请求测量，不是平均值或延迟保证，不含默认 700 ms 输入防抖。五个响应的 reasoning_tokens 均为 0；所有请求没有认证头。

代码检查确认 hooks 下不存在调用 `$.prompt.submit(...)` 的实现。监听 `prompt.submit` 用于清理建议，不等于主动提交消息。

## 真实交互终端验证

### diff 返回译文的切换回归

用户反馈 diff 打开时 ui.open(EA, focus:true) 无法直接显示译文。手动打开 EA 改为先通过公共 ui.close 关闭 pane id diff，再打开 ea-bilingual。新增模拟宿主保持 diff 前台的回归：译文→diff→译文连续三轮，每轮首次点击即显示译文，已有译文保持且仅一次 HTTP。原生 terminal/desktop 元素测试验证关闭 diff 在打开 EA 之前发生。28 项 Node、6 项原生测试及静态验证通过；当前未现场验证宽终端下完整视觉往返，不宣称所有宿主版本行为均相同。

### 显式切换到原生 diff（版本保持 0.1.0）

27 项 Node 测试、6 项原生测试通过。新增查看代码 diff 按钮和 `/ea-diff`，与仅关闭 EA 的“收起译文”分开。模拟覆盖原生 `/diff` 返回已隐藏时二次调用、已经显示时单次调用、命令不可用提示，未发送草稿或重新翻译。

本机 2.1.289 实际终端验证：直接在 ea-diff 的 command.run Hook 中嵌套 command.run 被宿主拒绝；改为时钟回调后，在 work/diff-check 的独立 Git 测试目录执行 ea-diff 成功调用原生 diff，返回至少 110 列的明确要求。测试 PTY 为 80 列，未现场验证宽终端中的完整 diff 视觉切换或用户反馈的自动显示失效场景；不将此测试宣称为自动 diff 修复。非交互 -p 测试未列出 diff 命令，按钮会报告不可用。

### 全局用量持久化（版本保持 0.1.0）

26 项 Node 测试、5 项原生测试及严格静态验证通过。真实独立进程 A 执行 `/ea-debug Explain this function.`，请求成功并写入用户配置目录的 english-assistant/usage；退出后进程 B 执行 `/ea-status`，显示全局输入 335、输出 35、合计 370，而本次插件加载输入/输出为 0，确认跨进程保留。多个加载实例分别写文件的汇总和损坏记录/写入失败路径由回归测试覆盖。

### 0.2.0 协议、用量与安装验证

向本机 4444 的三个真实协议端点发送同一段英文纠错样例，全部成功：Responses 730 ms，输入 339/输出 103/缓存读取 128；Chat Completions 909 ms，输入 339/输出 110/缓存读取 128；Messages 1237 ms，规范化输入 342/输出 210/缓存读取 0。原始归一化结果记录在 debug-protocol-report.json；数字为单次样例，不是延迟保证。当前本机接口无鉴权；有鉴权的 header 和 secret 不显示由模拟传输及 native options 测试覆盖，未调用需要真实凭据的远程服务。

Claude 实际 Mods /ea-debug HTTP 请求成功，745 ms。在隔离的 CLAUDE_CONFIG_DIR 中完成 marketplace add 与 plugin install，然后不传 --plugin-dir 的 claude -p /ea-status 正确显示 0.2.0 的协议、鉴权和 token 累计。安装无需 Node/npm 依赖；测试和 smoke 需要 Node。本轮随后执行用户范围的本机安装，用户设置由 Claude CLI 管理。GitHub 仓库尚未创建或推送。

### 双语面板与 diff 显示诊断

0.2.1 调整：默认 `autoOpenReplyPane=false`，回答翻译完成不会自动调用 ui.open。新增 `/ea-back` 和提示区/面板收起按钮。Node 及原生 UI 测试验证关闭只针对 ea-bilingual，译文结果保留，反复打开/关闭仅产生一次翻译请求，且不回填或发送输入。静态验证通过。这些是模拟行为与元素树验证，尚未现场验证关闭后恢复某个具体内置 diff；公共 API 也不能指定恢复哪个内置标签。

本机类型说明：同一 pane id 再次 open 可以仅更新标题；isPlaced 表示已放置，isShown 表示当前标签是否显示，focus 只在宿主允许时请求聚焦。当前自动打开不请求焦点。增加回复状态按钮、主会话完成事件/翻译段落进度/渲染次数，以及 ea-status 中实时读取 ui.panes。模拟测试验证已完成译文隐藏在 diff 后时可诊断，按钮请求打开本插件面板而不重发翻译，也不覆盖其他 requestId 的 diff 渲染。用户反馈的真实 diff 场景尚未现场复现，不能据此认定焦点是唯一原因。

### 分析中状态卡住修复

复现测试：请求进行时修改模拟输入框但不触发 prompt.edit，HTTP 成功后旧代码因文本不一致直接 return，仍显示“翻译与表达分析中…”。新增回归测试先失败，修复后通过。现在在读取输入框发现无事件变化时同步 draftText、递增 revision、清除旧状态并安排新分析；新版本已经经过正常编辑事件时，不清除新版本的状态。

真实终端：输入 `Please explan the warning: `，850 ms 后在“分析中”期间通过 bracketed paste 插入八行无害文本；不追加任何普通键，系统自动处理 `[Pasted text #1 +7 lines]` 新草稿并显示译文和详情按钮。随后 `/ea-status` 显示请求次数 2、最近 HTTP #2 为 200、最近分析为已生成建议、请求槽位空闲、无待处理任务。没有发送测试问题。该验证确认此条粘贴状态遗漏路径已修复，不证明所有未知的渲染问题均已消除。

### 粘贴引用修复验证

2026-10-05：新增三项 Node 回归用例，覆盖粘贴/图片引用的精确保留、重复或遗漏占位符拒绝、仅展示建议、阻止带参数 ea-check 覆盖、点击时重新检查引用和撤销保护。新增原生 UI 测试覆盖 terminal/desktop 引用草稿无采用按钮且详情可操作。

真实终端中输入英文问题后，通过 bracketed paste 粘贴八行无害示例，Claude 折叠为 `[Pasted text #1 +7 lines]`。继续编辑触发分析后，译文保留该引用，显示“已禁用整框替换”；Ctrl+X、Tab、Enter 进入首个详情按钮，只展开纠错说明，原草稿保持原样。没有发送这段测试草稿，也没有整框替换它。实际图片剪贴板未验证；图片文字标记保护由回归测试覆盖。此修复采用仅展示策略，不宣称已实现粘贴载荷或图片附件的保留回填。

在本机 Claude Code 2.1.289 的交互式 PTY 中加载插件，以实际输入和按键完成以下流程：

| 输入 / 操作 | 实际观察 |
| --- | --- |
| 输入 `请检查这个函数有没有内存泄漏。`，不按 Enter | 显示英文 `Please check whether this function has any memory leaks.` |
| Ctrl+X，然后 Tab，Enter 采用英文 | 输入框替换为英文，提示“已替换输入框，尚未发送”；没有启动主模型任务 |
| 同样进入控件并选择撤销 | 输入框恢复中文，提示“已恢复原文，尚未发送” |
| 输入 `Please explan how this functon works.` | 中文译文和两处纠错：`explan → explain`、`functon → function` |
| 选择采用纠错版 | 输入框为 `Please explain how this function works.`，没有发送 |
| 重新输入错误原文，Tab 切换至润色按钮并采用 | 输入框为 `Could you explain how this function works?`，没有发送 |
| 明确发送测试提示 `Reply only with: The check is complete. No files were changed.` | 主模型回复 `The check is complete. No files were changed.` |
| `/ea-reply` 打开面板并用下方向键滚动 | 状态“已完成”，显示 EN 原文和中文“检查已完成。未更改任何文件。” |

80 列窄终端不能自动放置侧面板时，插件提示通过 `/ea-reply` 查看；面板可滚动。该验证覆盖真实终端输出与按键流程，desktop 尚未实际视觉检查，只有原生测试引擎元素树验证。

当前环境没有独立 TypeScript 编译器；源码通过 Claude 插件静态验证和测试运行验证。
