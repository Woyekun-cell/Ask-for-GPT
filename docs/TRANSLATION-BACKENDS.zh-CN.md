# 选择自己的翻译服务

[返回首页](../README.md) · [macOS 安装指南](INSTALL.macOS.zh-CN.md) · [Zotero 阅读指南](ZOTERO.zh-CN.md)

Ask for GPT 默认通过 Codex 翻译。设置中的 **翻译配置文件**为其他服务留出了入口：可以填写 DeepSeek 等 Chat Completions API，也可以使用本机已经安装并登录的 Claude Code。把连接信息保存在一个 JSON 文件里，再让应用读取这个文件即可。

API / Claude Code 接入属于实验性功能，已完成构建，本次未做连通或翻译效果测试。以下示例均为占位配置；使用时由你填写自己的模型、路径与凭据。

## 哪些功能跟随这份配置

| 功能 | 使用的连接 |
| --- | --- |
| 短段 GPT 精译 / Explain | 所选翻译配置；留空时为 Codex |
| PDF 正文翻译、句子与词组对应 | 所选翻译配置；留空时为 Codex |
| 围绕选段提问、网页检索与写作建议 | Codex |
| 本地词典、Apple 本机翻译 | 本机资源 |

Zotero 的原文/译文/对照、标注和联动阅读操作保持相同。配置只决定 AI 翻译任务交给哪个服务。

![设置中的 Codex 路径与可选翻译配置文件](images/settings.png)

**保存设置**可以单独保存翻译配置；**测试 Codex**只检查 Codex 连接。使用 API 或 Claude Code 翻译时，可以先配置这条路径，问答与写作功能再按需配置 Codex。

## 1. 保存一份自己的配置

先把下面任一示例复制到用户目录，例如：

```text
/Users/你的用户名/Library/Application Support/AskGPTReader/Translation/translation.json
```

使用纯文本编辑器保存 UTF-8 JSON。将 `YOUR_NAME`、`YOUR_MODEL_ID`和示例路径改成自己的值；JSON 不支持注释，也不要在最后一个字段后留逗号。配置文件与密钥放在自己的用户目录，方便更新应用时继续使用。

源码中的示例位于 [DeepSeek 示例](../Resources/Distribution/examples/deepseek.example.json)和 [Claude Code 示例](../Resources/Distribution/examples/claude-code.example.json)。DMG / ZIP 下载包在本指南旁边的 `examples/`中附带同样文件。

## 2. 使用 DeepSeek 或兼容的 API

DeepSeek 示例：

```json
{
  "provider": "openai-compatible",
  "endpoint": "https://api.deepseek.com/chat/completions",
  "model": "YOUR_MODEL_ID",
  "apiKeyFile": "/Users/YOUR_NAME/Library/Application Support/AskGPTReader/Translation/deepseek.key"
}
```

| 字段 | 填写内容 |
| --- | --- |
| `provider` | 固定为 `openai-compatible` |
| `endpoint` | 服务的完整 HTTPS Chat Completions 地址，包含 `/chat/completions`；不是控制台网址或只到域名的基础地址 |
| `model` | 自己账号可用的模型 ID，按服务文档填写 |
| `apiKeyFile` | 本机纯文本密钥文件的完整路径 |

密钥文件只写一行 API Key，不加引号、`Bearer `前缀或 JSON 字段。配置文件只引用它的路径。可以先在终端准备一个空文件并限制权限，再用纯文本编辑器填入密钥：

```bash
mkdir -p "$HOME/Library/Application Support/AskGPTReader/Translation"
touch "$HOME/Library/Application Support/AskGPTReader/Translation/deepseek.key"
chmod 600 "$HOME/Library/Application Support/AskGPTReader/Translation/deepseek.key"
```

保存时保留 `.key`文件名，避免编辑器自动追加 `.txt`。应用要求密钥文件由当前用户持有、权限为 `600`，且文件本身不是符号链接。真实密钥文件留在本机，不上传到 GitHub，也不要放进截图。

DeepSeek 的请求地址和字段依据其 [Chat Completions 官方文档](https://api-docs.deepseek.com/api/create-chat-completion/)。换成其他服务时，使用对方提供的兼容 HTTPS 地址和模型 ID；仅返回 Responses API 或其他专有格式的接口不属于这里的配置格式。

## 3. 使用本机 Claude Code

先按 [Claude Code 官方文档](https://code.claude.com/docs/en/cli-reference)安装 CLI，并在自己的终端完成登录。应用使用这份本机认证，不代替你注册或登录账号。可以在终端用 `command -v claude`查看已安装程序的路径。

Claude Code 示例：

```json
{
  "provider": "claude-code",
  "cliPath": "/Users/YOUR_NAME/.local/bin/claude",
  "model": "YOUR_MODEL_ID"
}
```

| 字段 | 填写内容 |
| --- | --- |
| `provider` | 固定为 `claude-code` |
| `cliPath` | Claude Code 可执行文件的完整路径，按自己的安装位置填写 |
| `model` | 可选；填账号可用的模型 ID，或删除整行以沿用 CLI 的模型选择 |

需要使用支持 `--safe-mode`等适配参数的较新 Claude Code。应用通过非交互方式提交翻译；`--safe-mode`保留正常认证和模型选择，停用自定义技能、插件与项目指令等配置，受管理策略仍然适用。相关行为见 [CLI 参数说明](https://code.claude.com/docs/en/cli-reference)与[非交互运行说明](https://code.claude.com/docs/en/headless)。

如果删除 `model`字段，JSON 应写成：

```json
{
  "provider": "claude-code",
  "cliPath": "/Users/YOUR_NAME/.local/bin/claude"
}
```

## 4. 在应用里填写文件路径

1. 打开 Ask for GPT **设置…**。
2. 在 **翻译配置文件**填入刚保存的 `translation.json`完整路径。
3. 点击 **保存设置**，退出并重新打开 Ask for GPT，让后续任务读取配置。
4. 需要翻译 PDF 时，另行完成安装包中的 **02-准备PDF翻译.command**；翻译服务与本机排版环境分别准备。

编辑 JSON、替换密钥或调整模型后，同样保存并重启。等当前翻译任务结束或先停止任务，再切换配置，避免在任务中途更换连接。要恢复默认 Codex 翻译，清空 **翻译配置文件**，保存并重启即可。

完成译本按文档、页面范围、语言方向、翻译版本及后端配置摘要隔离复用。更换配置后会分别匹配相应结果；已有完成文件继续保留。

## 连接报错时检查什么

- **找不到文件或 JSON 无法读取**：检查完整路径、文件是否存在、JSON 的引号与逗号；不要把配置内容直接粘贴到路径栏。
- **API 认证或权限错误**：检查密钥文件内容、所有者和 `600`权限，再检查模型是否对当前账号开放。
- **API 地址或响应格式错误**：检查是否为完整 HTTPS Chat Completions 接口，服务是否提供兼容的请求与响应格式。
- **Claude Code 参数或认证错误**：检查 `cliPath`是否为真实可执行文件、CLI 是否支持所需参数，以及是否已在终端完成登录。

配置错误会显示失败原因，应用不会自动换到另一服务。API 翻译发送相应文字和必要上下文到所填服务，费用及额度计入该服务账户；Claude Code 使用其自身账号的服务与额度。请按自己的服务条款处理可提交的材料。
