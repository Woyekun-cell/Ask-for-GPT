# macOS 安装与首次配置

[下载最新版](https://github.com/Woyekun-cell/Ask-for-GPT/releases/latest) · [Zotero 图文指南](https://github.com/Woyekun-cell/Ask-for-GPT/blob/main/docs/ZOTERO.zh-CN.md) · [翻译后端配置](TRANSLATION-BACKENDS.zh-CN.md)

这份指南面向直接下载使用的读者。安装包里已经有编译好的 Ask for GPT、离线词典和阅读插件，不需要安装 Xcode 或自己编译。模型连接和 PDF 支持在第一次使用时配置，之后可以直接打开应用阅读。本次 macOS 1.1.55 使用 Codex CLI 的 ChatGPT 登录。

## 先选对下载文件

在 GitHub Releases 的 **Assets** 中下载 `Ask-for-GPT-1.1.55-macOS-arm64.dmg`。如果你更习惯解压文件，也可以选同版本的 `.zip`；两者内容相同。

当前安装版适用于 **Apple Silicon Mac（M1、M2、M3、M4 等 M 系列芯片）**。可以在苹果菜单 **关于本机**中查看芯片。完整 PDF 支持需要 macOS 15 或更新版本；Apple 本机短段翻译需要 macOS 26 和对应语言包。Intel Mac 暂无此安装包。

下载目录里自动生成的 `Source code (zip)` 和 `Source code (tar.gz)` 是开发用源码，普通使用者选择上面带 **macOS-arm64** 的安装包即可。

## 1. 把应用拖入“应用程序”

双击 `.dmg`，把 **Ask for GPT.app** 拖到旁边的 **Applications**。ZIP 版本先解压，再把应用拖到“应用程序”。之后从“应用程序”启动 Ask for GPT，菜单栏会出现一个对话气泡图标。

下载包中还带有两个配置入口：

| 文件 | 什么时候运行 |
|---|---|
| `01-登录ChatGPT.command` | 首次配置 Codex 翻译、问答与写作时 |
| `02-准备PDF翻译.command` | 首次准备 PDF 的 Python、排版模型和字体时 |

双击后会打开终端显示进度。完成时会提示按回车关闭窗口。它们是配置工具，正常阅读时不需要反复运行。

### 首次打开的系统确认

这个版本使用固定本机证书签名，尚未经过 Apple Developer ID 公证。macOS 首次打开时可能提示无法验证开发者。先核对下载来源和下方校验值；确认是本仓库发行的文件后，可以按 Apple 官方流程，在尝试打开应用后进入 **系统设置 → 隐私与安全性 → 安全性 → 仍要打开**，再确认打开。

如果系统提示文件已损坏或包含恶意内容，停止打开并重新核对下载文件。安装不需要关闭整个系统的 Gatekeeper 或修改系统安全数据库。[Apple 的首次打开说明](https://support.apple.com/en-us/102445)介绍了不同提示的含义。

## 2. 配置模型连接

macOS 1.1.55 使用 Codex CLI，沿用你自己的 ChatGPT 账号进行翻译、问答和写作。

### 默认路径：登录自己的 ChatGPT 账号

在下载包中双击 **01-登录ChatGPT.command**。配置入口会核对随包附带的 OpenAI 官方 Codex CLI 0.163.0 完整包，并解压到你的用户目录，然后打开浏览器登录。CLI 已包含在下载包中，不需要再次从 GitHub 下载。整个过程使用你的个人账号，发行包不包含作者的登录状态或 API Key。

登录结束后，配置窗口会显示 CLI 路径，并把它复制到剪贴板。例如：

```text
/Users/你的用户名/Library/Application Support/AskGPTReader/Tools/codex-0.163.0/bin/codex
```

在 Ask for GPT 菜单栏选择 **设置…**，把它粘贴到 **CLI 路径**，点击 **保存并连接**。如果你本来就有 Codex CLI，也可以直接填写自己已安装、版本不低于 0.162.1 的可执行文件路径。

![设置：Codex CLI 路径与可选翻译配置文件](images/settings.png)

提问模型和推理强度可以在这里调整。先保留默认设置测试 Codex；若账号不支持所填模型，再选择自己可用的模型。Codex 功能使用该账号相应的模型权限和额度。

随包的登录入口使用 ChatGPT 浏览器登录，默认 Codex 路径无需另填 API Key。安装和认证的来源说明见 [Codex CLI 官方文档](https://learn.chatgpt.com/docs/codex/cli)与[认证文档](https://learn.chatgpt.com/docs/auth)。

### 历史可选后端说明

macOS 1.1.55 安装包未包含 API / Claude 可选适配，设置中使用 **CLI 路径**与 **保存并连接**。随包保留的[翻译后端说明](TRANSLATION-BACKENDS.zh-CN.md)和占位示例用于历史版本及 Windows 预览版参考。

## 3. 允许读取你选中的文字

在 **系统设置 → 隐私与安全性 → 辅助功能**中允许 Ask for GPT。该权限用于读取你主动选中的文本，以及与阅读、写作窗口交互。

打开一段英文，选中一个单词，再按 `Option+D`。应该出现查词浮窗。也可以先在浮窗里手动粘贴文字，检查基本界面。

![查词浮窗](images/translation.png)

本地词典已经包含在安装包中。需要 Apple 本机短段翻译时，使用 macOS 26，并按系统提示准备相应语言资源；选择 **GPT**或 **Explain**时使用 Codex。

## 4. 第一次准备 PDF 支持

双击下载包中的 **02-准备PDF翻译.command**。它会自动准备固定版本的 uv 和 Python 3.12.15，下载锁定的预编译依赖，再准备公开的排版模型、字体和 CMap。无需 Homebrew、手动安装 Python或编译器。

首次准备需要网络，安装后的组件约占 **1 GB**，建议预留 **2 GB** 可用空间。窗口会显示下载、依赖安装和资源准备进度；网络慢时保持窗口打开。完成后看到 **PDF 支持已准备好**即可关闭。

如果中途断网，恢复网络后再双击同一入口。准备工具会复用已经下载好的部分，不会删除原文或已有译本。若提示另一个安装任务正在进行，先等那个窗口结束；不要同时打开多个配置窗口。

组件保存在：

```text
~/Library/Application Support/AskGPTReader/PDFLayout/
```

普通阅读时不需要进入这个目录。PDF 在本机提取与排版，需要翻译的正文和句词对应上下文提交给 Codex。请使用有权提交给相应服务的材料。

## 5. 在 Zotero 安装插件

1. 启动 Ask for GPT，点击菜单栏气泡图标，选择 **页面内翻译…**。
2. 点击 **Zotero 插件文件**，找到 `askgpt-inline-zotero.xpi`。
3. 在 Zotero 9 的插件管理界面选择从文件安装，选中这个 XPI，并按提示重启 Zotero。
4. 打开一份有文字层的 PDF，在右侧 **PDF 翻译**面板选择 **当前页**、语言方向和显示方式，再点击 **翻译**。

先处理一页，可以很快熟悉切换原文、译文和对照的方式，再决定是否翻译整篇。词语对应、八色标注、联动滚动、图表定位和后台任务的完整操作见 [Zotero 图文指南](https://github.com/Woyekun-cell/Ask-for-GPT/blob/main/docs/ZOTERO.zh-CN.md)。

更新应用后，也要从新应用导出并更新 XPI。主程序负责翻译和连接，插件负责阅读器内界面，两者配套使用。

## 6. Chrome 与其他阅读器

需要网页翻译时，在 **页面内翻译…**点击 **浏览器扩展目录**。打开 Chrome 的 `chrome://extensions`，开启开发者模式，再加载应用导出的目录。在网页中按 `Option+Shift+X`即可翻译或恢复原页面。本地 PDF 还需在扩展详情中允许访问文件网址。

请加载应用导出的目录，而不是源码目录；导出时才会生成你自己的本机连接配置。更新应用后，在 Chrome 扩展管理页手动重载一次。

Preview 或 WPS PDF 可以通过菜单栏 **PDF · 原阅读器**使用译本。若应用无法取得当前 PDF 地址，手动选择本机文件即可，原 PDF 会保留。

Word/WPS 写作加载项还需要单独的 localhost HTTPS 配置。若需要写作功能，按[完整手册](https://github.com/Woyekun-cell/Ask-for-GPT/blob/main/docs/HANDBOOK.zh-CN.md#5-word--wps-写作加载项)准备；阅读、词典和 Zotero 功能不依赖这个步骤。

## 常见问题

**Codex 连接失败。** 检查 CLI 路径是否指向实际文件，以及是否已用 ChatGPT 登录。重新运行登录入口后，点击 **保存并连接**。模型名需符合账号权限。

**可选翻译配置失败。** 检查 JSON 文件路径与字段；API 方式还需检查 HTTPS 地址、模型 ID 和密钥文件权限，Claude Code 方式检查 CLI 路径、参数兼容性和终端登录。修改后重启应用，具体见[配置指南](TRANSLATION-BACKENDS.zh-CN.md)。此入口失败会报告错误，不自动改用另一服务。

**PDF 提示组件未准备。** 先完成 PDF 配置入口，看到资源准备成功后重启 Ask for GPT。安装阶段需要能连接 GitHub、Python 包源和上游公开资源。

**Zotero 没出现翻译侧栏。** 确认使用 Zotero 9、XPI 已启用，并重启过 Zotero。Ask for GPT 主程序也应保持运行。

**选区能复制，但暂时没有另一侧的词语对应。** PDF 翻译和词语映射分别准备。稍等顶部状态完成，或在更多菜单重试；已有译本可以继续阅读。

**扫描件没有翻译。** 当前 PDF 流程需要文字层；扫描图片和图像中的文字需要先用其他 OCR 工具处理。

## 更新、卸载与文件校验

更新时，先从菜单退出旧应用，再用同名应用替换。账号、配置和本机完成译本位于用户目录，替换应用不要求重建签名身份或删除缓存。应用签名身份由发行者固定保留，普通用户安装二进制版无需生成自己的签名证书。

卸载主程序时退出应用，将它移到废纸篓，并在 Zotero/Chrome 移除插件。用户目录中的配置、登录工具和译本独立保留；若还需要这些材料，先保存再自行清理。

每次 Release 附带 `SHA256SUMS.txt`。下载后可以在终端检查安装包，输出应与文件内对应行相同：

```bash
shasum -a 256 ~/Downloads/Ask-for-GPT-1.1.55-macOS-arm64.dmg
```
