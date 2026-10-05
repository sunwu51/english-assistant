# 本地安装与 GitHub 分发

本目录同时是插件根目录和一个仅含本插件的 marketplace 根目录：

```text
english-assistant/
  .claude-plugin/
    plugin.json
    marketplace.json   # source: ./
  hooks/
  scripts/
  tests/
  config.json          # 公共默认配置，apiKey 保持空字符串
  config.local.json    # 可选个人配置，忽略不发布
```

## 本机只安装一次

开发时可以直接注册本地目录，Windows、macOS 和 Linux 都使用 Claude CLI：

```text
claude plugin marketplace add '插件目录绝对路径' --scope user
claude plugin install english-assistant@english-assistant-marketplace --scope user
```

之后 `claude` 无需 --plugin-dir。在 Claude 内运行 `/plugin configure english-assistant@english-assistant-marketplace` 配置个人接口和 token；敏感 apiKey 由 Claude 安全凭据存储保存，不写进 GitHub。非敏感插件选项保存在用户设置中。

Mods 可用性还取决于 Claude 版本、发布开关和组织策略。安装后没有 EA 命令时，检查 `/plugin` 的 Errors 状态；本机历史调试记录见 VERIFICATION.md。安装本身不会修改或解除组织策略。

## 发布到 GitHub

1. 将本目录放进你准备公开的 GitHub 仓库根目录，或直接以本目录建立仓库。若插件只是另一仓库的子目录，不能直接把整个仓库当作这里的 marketplace；需要将 marketplace.json 放在该仓库根目录的 .claude-plugin 中，并修改 source 指向插件子目录。
2. 公开 config.json 中 apiKey 必须为空；不要将私人 endpoint 或 token 写进受 Git 跟踪的文件。config.local.json、生成的类型和 debug 报告已列入 .gitignore；忽略规则不会取消已经被 Git 跟踪的文件，发布前检查 git diff --cached。
3. 选择适合项目的开源许可证并补上 LICENSE；当前没有替你决定许可证。按需要更新 plugin.json 的 author、repository、homepage，以及 marketplace owner。
4. 运行检查：

```powershell
node --test tests/core.test.mjs
claude plugin test .
claude plugin validate . --strict
```

5. 仓库地址为 [sunwu51/english-assistant](https://github.com/sunwu51/english-assistant)。发布修改时运行验证，再提交推送；私有仓库需要安装者已有 GitHub Git 访问权限。

其他人在终端中安装：

```text
claude plugin marketplace add sunwu51/english-assistant
claude plugin install english-assistant@english-assistant-marketplace --scope user
```

这是你自行维护的 marketplace，不是自动进入 Anthropic 官方市场。若希望官方市场收录，需另走官方提交审核流程。

## 发布更新

修改代码后同步提升 plugin.json 与 package.json 的版本，运行验证，再推送 GitHub。用户更新：

```powershell
claude plugin marketplace update english-assistant-marketplace
claude plugin update english-assistant@english-assistant-marketplace
```

重新启动 Claude 或运行 `/reload-plugins` 检查 `/ea-status`。安装缓存中的个人 config.local.json 可能随更新覆盖；已通过 `/plugin configure` 保存的个人选项与源码分离。

本地 marketplace 开发副本修改后同样需要更新已安装的缓存副本；调试热重载时可继续使用 --plugin-dir，但不要混淆两份来源。

官方参考：[创建 marketplace](https://code.claude.com/docs/en/plugin-marketplaces)、[安装管理插件](https://code.claude.com/docs/en/discover-plugins)、[插件配置与敏感字段](https://code.claude.com/docs/en/plugins-reference)。
