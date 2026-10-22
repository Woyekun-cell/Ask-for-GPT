# Ask for GPT Windows 阅读预览版

版本：0.1.0-preview.1，Windows x64。以 Windows 11 为主要目标，Windows 10 22H2 为兼容目标。构建环境是 GitHub 标准 Windows Server runner；当前没有 Windows 10/11 用户桌面实机验收。每次发行的真实自动检查结果在发行页单独提供，见 `build-validation.json`。

本版提供快捷键划词、离线英汉词典、段落翻译与提问、Chrome/Zotero 阅读集成、PDF 中英对照、可配置 Codex/兼容 API/Claude Code 后端。Word/WPS 写作辅助留待后续版本。仓库中的界面图片来自 macOS，不能作为 Windows 界面或兼容性证据。

## 下载安装

从 [Windows 预览发行页](https://github.com/Woyekun-cell/Ask-for-GPT/releases/tag/windows-v0.1.0-preview.1) 选择一种：

- `Ask-for-GPT-0.1.0-preview.1-Windows-x64-Setup.exe`：当前用户安装，默认位置 `%LOCALAPPDATA%\Programs\Ask for GPT Windows Preview`，开始菜单生成入口，无需管理员权限。
- `Ask-for-GPT-0.1.0-preview.1-Windows-x64-Portable.zip`：完整解压到可写目录，运行 `AskGPT.Windows.exe`；程序与随包文件夹必须保持在一起。

程序自带 .NET 运行环境和离线词库，无需另装 .NET、Python 或 npm。安装器尚未数字签名，Windows 可能显示未知发布者；核对下载源和 SHA-256 后按本机安全策略处理。校验示例：

```powershell
Get-FileHash '.\Ask-for-GPT-0.1.0-preview.1-Windows-x64-Setup.exe' -Algorithm SHA256
```

结果应与发行页 `SHA256SUMS.txt` 对应行一致。更新或卸载前，先从托盘菜单退出程序。卸载仅移除安装文件，保留用户设置、已下载组件、原 PDF 和译文缓存。

## 首次启动与划词

打开后先显示设置。关闭设置窗口后，程序继续在托盘运行；从托盘可重新打开设置或退出。

1. 在其他应用中选中一个英文单词，按 `Alt+D`。词典优先离线查询，不需要模型账户。
2. 段落翻译前，按下文配置一个后端。浮窗可查看选区、翻译结果并提问。
3. 设置内可更改快捷键。若 `Alt+D` 被其他应用占用，更换组合后保存。
4. 自动划词默认关闭；启用后只处理拖选/双击产生的短选区，不自动走剪贴板回退。密码控件排除。

手动快捷键优先读取 Windows UI Automation 选区。目标应用不支持时，程序尝试短暂复制；仅在剪贴板与焦点仍符合恢复条件时恢复原内容。部分受保护、提权或自绘界面可能无法读取，届时可在浮窗手动输入。实际热键、选区、中文输入法、显示缩放及剪贴板交互仍待桌面实测。

## 翻译后端

### Codex CLI

在设置点“准备 Codex CLI”。程序下载官方 `@openai/codex` 的固定 Windows x64 0.163.0 完整包，执行前核对固定 SHA-512，保留拆分程序及许可，不需要 npm。解压后约 466 MB，另需下载临时空间。

默认程序路径：

```text
%APPDATA%\AskGPTReader\Tools\codex-0.163.0\vendor\x86_64-pc-windows-msvc\bin\codex.exe
```

在设置中点“CLI 登录帮助”，按说明自行登录；也可在 PowerShell 执行：

```powershell
& "$env:APPDATA\AskGPTReader\Tools\codex-0.163.0\vendor\x86_64-pc-windows-msvc\bin\codex.exe" -c cli_auth_credentials_store=file login
```

将完整 `.exe` 路径填入设置，选择 Codex，模型填写账户实际支持的模型并保存。程序不代为注册、开通订阅或调用付费测试。翻译和提问使用该账户的额度。

每次请求使用独立工作目录与隔离配置，仅复制登录所需 `auth.json`，不继承用户的 AGENTS、MCP、hooks 或项目指令。仅在系统凭据库中保存、没有可读 `auth.json` 的登录暂不支持；按官方 CLI 登录方式生成文件后再使用。配置不会复制进安装包或扩展分发文件。

### 兼容 Chat Completions API

选择“OpenAI 兼容 API”，填写完整 HTTPS Chat Completions URL、模型 ID、密钥文本文件的绝对路径。密钥文件应只有一项密钥，不含 JSON 或 `Bearer ` 前缀，且只允许当前用户读取。可在用户自己的目录新建文件，再在 PowerShell 设置私密权限：

```powershell
$keyPath = 'C:\Users\你的用户名\askgpt-api-key.txt'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
icacls $keyPath /inheritance:r /grant:r "*${sid}:(F)"
```

在文件中自行填写密钥，勿上传到仓库或分享配对文件。程序不会向日志写入密钥或译文；请求会发送至你填写的服务，费用及额度由该服务账户承担。

### Claude Code 与外部 JSON

Claude Code 需用户自行安装并登录，设置中选择其真实 `.exe`，并将模型改为 Claude 支持的模型或留空；界面会保留原先填写的模型。不支持 `.cmd`/`.bat` 包装器。该后端使用独立参数调用，不把 Codex 参数套用到 Claude。

也可设置外部翻译 JSON，字段限 `provider`、`cliPath`、`model`、`endpoint`、`apiKeyFile`，优先于界面后端字段；示例见 `Resources\Distribution\examples`。示例文件的 macOS 路径须改成 Windows 绝对路径。兼容 API/Claude 的验证目前使用模拟服务，没有真实账户连通或翻译质量测试。

## Chrome 与 Zotero

在设置点“导出阅读集成”，选择存放位置。程序在其内新建 `AskGPT-Integrations-随机编号` 私密子目录，并返回真实路径。导出会生成当前用户的配对连接文件；该文件含本机访问令牌，不要公开分享。

- **Chrome**：打开 `chrome://extensions`，启用开发者模式，选“加载已解压的扩展程序”，指向导出的 `AskGPT-Chrome` 文件夹。点击扩展开始页面翻译。浏览器中的本地 PDF 需在扩展详情页按需允许“访问文件网址”；其他页面权限按扩展实际提示授权。
- **Zotero**：在“工具 → 插件”中选择“从文件安装插件”，加载导出的 `askgpt-inline-zotero.xpi`。按 Zotero 提示重启，在 PDF 阅读器的插件面板选择翻译范围、方向和显示方式。

主程序须保持运行。连接只监听本机 `127.0.0.1`；不要修改防火墙以对外开放端口。Zotero 从 `%APPDATA%\AskGPTReader\inline-connection.json` 读取配对信息并校验权限与路径，不改动文库。

## PDF 中英对照

1. 在设置点“准备 PDF 组件”。脚本固定 uv 0.12.23、Python 3.12.15、BabelDOC 0.6.4，依 Windows 带哈希锁文件仅安装预编译依赖，再准备上游公开字体及排版资源。
2. 首次准备需要联网及约 1 GB 或更多可用空间，实际随依赖和资源变化。只有资产准备与校验完成，才标记就绪；准备失败可修复网络后重试，不应手工创建就绪标记。
3. 点“启动 PDF 服务”，再在 Chrome/Zotero 使用本页或整篇中英对照。

运行时位于 `%APPDATA%\AskGPTReader\PDFLayout\runtime\Scripts\python.exe`。PDF 翻译仍需联网调用所选后端。图片内部文字、复杂公式、表格、跨页映射与字体效果存在上游和新平台兼容边界；关键内容应核对原文。输出与原 PDF 分离，原文不被覆盖。

准备脚本仅为当前 PowerShell 子进程使用执行策略参数，不修改系统执行策略或全局 PATH。受组织策略限制的设备按管理员既有规则处理。

## 数据位置与故障定位

- 设置：`%APPDATA%\AskGPTReader\windows-settings.json`
- 本机配对：`%APPDATA%\AskGPTReader\inline-connection.json`
- PDF 组件、资源与缓存：`%APPDATA%\AskGPTReader\PDFLayout`
- 固定 Codex 工具：`%APPDATA%\AskGPTReader\Tools`

端口 `43792` 为阅读集成，`43795` 为 PDF 服务。若启动报端口占用，先退出旧的 Ask for GPT 进程再重开，不要结束不明进程。组件准备失败可在 PowerShell 中单独运行安装目录下的 `scripts\windows\prepare-pdf.ps1` 或 `prepare-codex.ps1` 查看错误。无须提供密钥、论文正文或整个用户目录来报告问题。

每次发行的自动检查项目、运行环境和检查边界见本次发行页及 `build-validation.json`。
