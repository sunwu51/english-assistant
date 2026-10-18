# English Assistant

Claude Code 的中英文语言辅助插件。输入时提供翻译、拼写纠正和表达润色；回复完成后提供中英对照。所有“采用”操作只替换输入框，不自动发送。

使用独立的翻译模型，支持 Responses、Chat Completions 和 Messages 协议。当前版本为 `0.1.3`。

## 安装与启动

需要支持 Mods 的 Claude Code，以及可访问的翻译模型 API。本插件在 Claude Code `2.1.289` 的 Windows 终端上验证过；以下安装命令不依赖 PowerShell，适用于 Windows、macOS 和 Linux。macOS/Linux 的界面行为尚未实测。

从 [sunwu51/english-assistant](https://github.com/sunwu51/english-assistant) 的 marketplace 安装。

在终端执行：

```text
claude plugin marketplace add sunwu51/english-assistant
claude plugin install english-assistant@english-assistant-marketplace --scope user
```

用户级安装后，该电脑上的其他项目也可使用。进入你的项目目录，正常启动：

```text
claude
```

也可以在 Claude Code 会话内添加 marketplace，再通过插件面板选择安装范围：

```text
/plugin marketplace add sunwu51/english-assistant
/plugin install english-assistant@english-assistant-marketplace
```

按安装完成提示重载或重启。在会话内运行 `/ea-status` 检查是否加载成功。安装方式参考 [Claude Code 官方文档](https://code.claude.com/docs/en/discover-plugins)。

### 配置翻译服务

在 Claude Code 内执行：

```text
/plugin configure english-assistant@english-assistant-marketplace
```

配置 `endpoint`、`protocol`、`model`、`authType` 和可选的 `apiKey`。`apiKey` 声明为敏感字段，由 Claude 管理凭据存储。修改后执行 `/reload-plugins`。

默认地址是 `http://localhost:4444/v1/responses`，模型是 `deepseek-flash`，无鉴权。这是本地调试配置，插件不会启动该服务；其他使用者需要提供自己的模型服务地址和模型名。

| protocol | endpoint 示例 | 默认鉴权方式（配置 token 时） |
| --- | --- | --- |
| `responses` | `https://api.example.com/v1/responses` | Bearer |
| `chat/completions` | `https://api.example.com/v1/chat/completions` | Bearer |
| `messages` | `https://api.example.com/v1/messages` | x-api-key |

`endpoint` 必须是完整 API 地址，切换协议时需要同步修改地址。`authType` 支持 `auto`、`none`、`bearer`、`x-api-key`；`auto` 按上表选择，token 为空时不发送鉴权。

### 更新

在终端执行：

```text
claude plugin marketplace update english-assistant-marketplace
claude plugin update english-assistant@english-assistant-marketplace
```

然后重启 Claude，或在会话内执行 `/reload-plugins`。

## 使用

- 输入停止变化 **1 秒**后开始分析；继续输入会重新防抖。
- 中文输入：提供英文翻译和可选的英文润色。
- 英文输入：提供中文翻译、必要的拼写纠正和可选的英文润色。
- 混合输入：生成完整英文表达，保留代码、链接和技术标识符。
- 点击“展开详情”查看完整建议和中文说明，再选择采用；采用只替换输入框，可撤销。继续编辑后旧撤销失效。
- 含 `[Pasted text #N ...]`、`[Image #N]` 的草稿只展示建议，禁用整框替换，不读取标记背后的文本或图片。
- 最后回复在后台翻译，不自动打开面板。点击“查看最后回复译文”先关闭原生 diff 面板，再显示已有原文与译文；代码块保留原样。
- 重启或重载后恢复已有会话，点击“翻译当前最后回复”或执行 `/ea-reply`：没有内存结果时，从当前会话读取最近一条有正文且不含工具调用的助手消息并翻译。已有结果直接打开，不重复请求。译文仍只缓存在内存中，重启后手动翻译会重新请求服务；空会话会提示没有可翻译的回复。
- 回复中的完整 `┌─┬─┐` 字符边框表格会先转换为 Markdown 表格，去掉对齐空格并合并单元格续行。终端面板按自身宽度排列各列，空间不足时在单元格内折行；极窄面板改用逐字段展示。长表格按完整行分段并重复表头。代码块、图形及无法可靠识别的表格保留原样。
- 点击“收起译文”只关闭 EA；点击“查看代码 diff”关闭 EA 并调用原生 `/diff`。再次打开译文使用已有结果，不重新请求。原生 `/diff` 是切换命令，明确返回隐藏时插件会再调用一次，使其打开；不会保存或重放某个 diff 快照。

终端中先按 `Ctrl+X`，再按 `Tab` 进入输入框上方的提示区，使用 `Tab` 切换按钮、`Enter` 操作。焦点在采用按钮时只替换草稿；焦点在输入框时，Enter 仍是正常发送。

## 命令

| 命令 | 用途 |
| --- | --- |
| `/ea-status` | 全局与本次加载 token、最近五次请求、服务与面板状态 |
| `/ea-toggle` | 开关辅助功能 |
| `/ea-reply` | 打开最后回复的中英对照；无内存结果时读取当前会话最后回复并翻译 |
| `/ea-back` | 收起译文面板，保留结果 |
| `/ea-diff` | 收起 EA 并调用原生 `/diff`，查看代码修改 |
| `/ea-check 请检查这个函数。` | 将指定文本填入输入框并分析，不发送；省略参数时分析当前草稿 |
| `/ea-debug Please explan how this functon works.` | 独立请求翻译服务并打印结果，用于排查配置 |

## 高级配置

开发副本可编辑 `config.json`，个人覆盖可放在同目录的 `config.local.json`（已被 Git 忽略）。已安装用户优先通过 `/plugin configure` 设置服务与凭据，避免修改可能被更新替换的安装缓存。

```json
{
  "endpoint": "http://localhost:4444/v1/responses",
  "protocol": "responses",
  "model": "deepseek-flash",
  "debounceMs": 1000,
  "requestTimeoutMs": 15000,
  "contextMessages": 4,
  "contextMaxChars": 6000,
  "autoOpenReplyPane": false,
  "glossary": { "worktree": "Git 工作树" }
}
```

配置优先级：默认值 → `config.json` → `config.local.json` → 非空的插件用户配置。其余默认值见 [hooks/core.js](hooks/core.js)。

设置 `apiKeyEnv: "EA_API_KEY"` 后，可通过环境变量提供 token，优先于 `apiKey`；目前只支持此固定变量名。设置 `authType: "none"` 可明确关闭鉴权。

上下文默认取近期最多 4 条消息，总计最多 6000 字符，省略代码块和工具日志。将两个上下文参数都设为 0 可关闭历史上下文。草稿及上下文会发送到配置的翻译服务；缓存只存在内存中。

默认 `jsonMode: true` 为三种协议发送 JSON Schema，约束必填字段、类型和额外字段：Chat 使用 `response_format.json_schema`，Responses 使用 `text.format`，两者均设置 `strict: true`；Messages 使用 `output_config.format`（`type: json_schema`，无需额外 strict 参数）。输入分析和回复翻译使用独立 schema。三种协议均可设置 `jsonMode: false` 以兼容不支持结构化输出的模型或服务；此时只用提示词要求 JSON，返回仍需校验，不会因服务报错自动降级。`reasoningEffort: null` 表示不发送推理参数，默认 `none`。Messages 在 `none` 时发送 `thinking.type=disabled`，不映射其他推理强度，默认发送 `anthropic-version: 2023-06-01`。

## Token 统计

`/ea-status` 显示两种累计：

- **全局累计**：跨会话、重启和重载保留，汇总多个 Claude 窗口。
- **本次插件加载**：从该份插件加载开始统计；清空或切换会话不清零，重启或重载后清零。按 `draft`、`reply`、`debug` 分类。

“最近请求 Token”显示最近 5 次实际 HTTP 请求。`#N` 是本次加载的请求序号，缓存命中不新增序号或用量。

记录保存在 Claude 用户配置目录下的 `english-assistant/usage/`，默认 `~/.claude/english-assistant/usage/`；设置 `CLAUDE_CONFIG_DIR` 时跟随该目录。每次加载写独立文件，仅保存计数，不保存草稿、译文或凭据。全局统计从启用记录后开始累计，无法追溯此前的内存用量。

输入总量包含普通输入、缓存读取和缓存写入；推理 token 属于输出的一部分，不重复计数。统计以服务返回的有效 usage 为准，缺失用量的请求仍在后台记录，但不在状态中展示未知次数，也不估算其费用。仅统计 EA 翻译服务，不包含 Claude 主模型。

## 排查与限制

- `/ea-status` 不存在时，先检查 `/plugin` 的安装、启用和 Errors 状态。Mods 加载还取决于 Claude 的功能开关、版本及组织策略，版本新不代表一定启用；本机历史问题与验证过程见 [VERIFICATION.md](VERIFICATION.md)。
- 原生 diff 没显示时可以点击“查看代码 diff”或执行 `/ea-diff`，也可以直接运行 `/diff`。本机全屏终端的原生 diff 至少需要 110 列，EA 手动面板可在窄终端显示；当前目录还需要是 Git 仓库。命令不可用或宿主拒绝时显示具体原因。自动打开 diff 仍取决于原生插件的偏好与加载状态。
- 当前 HTTP Mods API 没有 AbortSignal。`requestTimeoutMs` 仅结束 UI 等待，不会中断物理请求；输入分析和回复翻译各最多一个物理请求，新草稿只保留最新待处理版本。
- 返回结果会校验 JSON、语言字段、代码占位符和草稿版本；语义仍需用户审阅。
- 当前不支持读取或保留回填附件载荷，也不支持逐字流式翻译。
- 读取/写入全局用量失败会提示，异常退出发生在写入前可能丢失最新记录。

## 开发与发布

在插件目录运行：

```text
node --test tests/core.test.mjs
claude plugin test .
claude plugin validate . --strict
```

安装使用 Claude 自身的 Mods 运行时，无需安装 Node/npm 依赖。Node 用于单元测试和可选的 `node scripts/smoke.mjs`；smoke 会向配置的真实 API 发送五组样例请求。

架构与 Hook 流程见 [ARCHITECTURE.md](ARCHITECTURE.md)，验证范围见 [VERIFICATION.md](VERIFICATION.md)，GitHub 发布步骤见 [PUBLISHING.md](PUBLISHING.md)。Windows 终端采用/撤销及双语面板已实测，desktop 只验证了测试引擎中的元素树。
