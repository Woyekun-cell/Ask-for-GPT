# Ask for GPT 使用与构建手册

Ask for GPT 是 macOS 阅读与英文写作助手：划词后查看本机译文或词典，按需调用 GPT 精译、解析和追问；通过 Chrome、Zotero 插件在原页面中阅读双语内容。PDF 使用独立的本机排版组件，生成保留版式的译本。

普通使用者可以直接下载 [macOS 安装版](https://github.com/Woyekun-cell/Ask-for-GPT/releases/latest)，按[安装与首次配置指南](INSTALL.macOS.zh-CN.md)操作。下文保留源码构建及进阶集成的步骤，方便开发与排错。

## 1. 准备环境

| 功能或步骤 | 前提 |
| --- | --- |
| 应用基础运行 | Swift 包和应用包声明最低 macOS 13；各功能另有系统要求 |
| 本机翻译、网页本机翻译 | macOS 26 或更新版本，并已安装所需语言对的系统翻译资源；26.4 起使用可用的翻译策略选择 |
| Word / WPS 写作服务 | macOS 15 或更新版本，另需对应宿主、加载项和 localhost TLS 配置 |
| 默认 AI 翻译、提问与写作润色 | Codex CLI 0.162.1 或更新版本，并通过 ChatGPT 账号登录；模型可用性及额度取决于账号 |
| 可选翻译配置 | API 使用兼容的 HTTPS Chat Completions 接口及本地密钥文件；Claude Code 使用已安装、已登录且兼容适配参数的 CLI；属于未做连通/效果测试的实验性接入 |
| 源码构建 | Swift 6 工具链、macOS SDK、Python 3，以及系统 `codesign`、`security`、`openssl` |
| PDF 排版组件安装 | Apple Silicon、macOS 15+；配置入口自动准备 uv、Python 3.12 和预编译依赖，首次需要联网 |
| Chrome 扩展 | Chrome 106 或更新版本；以本地未打包扩展方式加载 |
| Zotero 插件 | 当前 manifest 声明兼容 Zotero 9.x |

先确认所需工具已安装，例如运行 `swift --version`、`codex --version`、`uv --version` 和 `python3.12 --version`。默认 Codex 路径先在终端完成 `codex login`，使用 ChatGPT 登录。可选翻译配置使用你指定的服务与账号；应用遇到连接或额度错误时不会自动切换服务。

应用默认查找 `/opt/homebrew/bin/codex`；如果你的 CLI 安装在其他位置，在应用“设置”的 **Codex 路径**中填写实际绝对路径。提问模型和推理强度可在设置中修改。点击 **保存设置**保存，**测试 Codex**仅检查 Codex 连接。

**翻译配置文件**留空时，短段精译/解释、PDF 正文和句词映射仍走原有 Codex 路径。填写本机 JSON 路径后，这些任务采用配置中的 API 或 Claude Code；问答、网页检索与写作保持 Codex。独立翻译配置可单独保存，不要求 Codex 连通。配置字段、示例和权限要求见[翻译后端配置](TRANSLATION-BACKENDS.zh-CN.md)。修改配置或密钥文件后重启应用，让后续任务读取新配置。

Easydict 是可选兼容入口，基本划词翻译不依赖它。

## 2. 从源码构建与安装

以下命令均在仓库根目录运行。先保留完整的 `Sources/`、`Integrations/`、`Resources/` 和 `scripts/`；词典打包还需要 `Resources/Dictionary/words.sqlite`、`LICENSE` 与 `provenance.json`。

### 为这台 Mac 准备独立签名身份

```bash
python3 scripts/app-signing prepare
```

该步骤在 `~/Library/Application Support/AskGPTReader/Signing/` 创建专用签名状态与钥匙串。之后构建复用同一身份，保持应用签名稳定。脚本不会安装证书信任，也不会修改辅助功能授权记录。已有签名状态不完整或不匹配时会停止；不要通过删除签名状态或临时改成 ad-hoc 签名来绕过。

每台机器自行生成并保存其身份。签名私钥、钥匙串、密码文件和整个 `Signing/` 目录不应上传到仓库或分享给他人。这个流程用于本机签名构建；仓库未提供 Apple 公证发布流程。

### 构建应用包

```bash
./scripts/build-app
```

脚本编译两个 Swift 可执行文件，打包词典、浏览器/Zotero 插件、PDF 组件源码和写作规则，再用本机身份签名并验证。产物位于：

```text
.build/AppPackage.noindex/Ask for GPT.app
```

当前脚本优先使用 `/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk`，不存在时回退到 `xcrun` 返回的 SDK。其他工具链组合需要自行验证。若 SwiftPM 的 manifest 编译仍选用了不兼容的默认 SDK，确认本机确有下列 SDK 后同时设置环境变量：

```bash
SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk ./scripts/build-app
```

路径须与本机实际安装的兼容 SDK 一致，不能仅复制开发机路径并假定已具备该环境。

### 安装并启动

如果旧版正在运行，先通过应用界面退出，再执行：

```bash
python3 scripts/install-app
open "$HOME/Applications/Ask for GPT.app"
```

安装脚本验证本机固定签名，暂存新包后原子替换，失败时恢复旧包。若已安装应用属于另一签名身份，默认会停止；先核对来源和迁移影响，再决定是否使用脚本提供的 `--migrate-signing`，不要把它作为常规安装参数。

首次使用划词时，按系统提示在“隐私与安全性 → 辅助功能”中授权 Ask for GPT。没有授权时仍可在窗口中手动粘贴文本。不要重置系统授权数据库来代替正常授权。

## 3. 安装 PDF 排版组件

二进制安装版带有 **02-准备PDF翻译.command**，双击即可。源码用户在仓库根目录运行：

```bash
sh Integrations/PDFLayout/install-runtime
```

安装器会下载并核验固定版本的 uv 0.12.23，准备独立的 CPython 3.12.15，再依据带哈希的锁文件安装预编译依赖。最后下载排版模型、字体与 CMap 等公开资源。整个流程不要求 Homebrew、外部 Python 或编译器，完整组件约占 1 GB。

运行目录为：

```text
~/Library/Application Support/AskGPTReader/PDFLayout/
```

安装器生成的工具保存在该目录下的 `Tools/`，运行环境在 `runtime/`。这些路径由当前用户首次准备，安装包不会携带作者机器上的绝对 Python 链接或登录信息。网络中断后可重新运行；不要同时打开多个安装任务。

已有受控工具环境的开发者，仍可指定绝对路径：

```bash
ASKGPT_UV="/absolute/path/to/uv" \
ASKGPT_PYTHON="/absolute/path/to/python3.12" \
  sh Integrations/PDFLayout/install-runtime
```

安装器接受一个自定义目录参数，供测试与开发使用；正式应用固定使用上述默认目录。常规使用请保留默认值。准备完成后可检查依赖版本：

```bash
"$HOME/Library/Application Support/AskGPTReader/PDFLayout/runtime/bin/python3" \
  -c 'import importlib.metadata; print(importlib.metadata.version("BabelDOC"))'
```

预期输出 `0.6.4`。接着在 Zotero 中用有文字层的 PDF 翻译一页，检查阅读效果，再处理整篇。

## 4. 安装阅读插件

启动 Ask for GPT，在菜单栏打开“页面内翻译…”。此窗口提供两个安装入口，应用会为本机生成连接配置。

### Chrome

1. 点击“浏览器扩展目录”，定位应用导出的本机扩展目录。
2. 打开 Chrome 的 `chrome://extensions`，开启开发者模式，选择“加载已解压的扩展程序”，加载该目录。
3. 在网页或 PDF 标签按 `⌥⇧X`，或点击扩展按钮。
4. 阅读本机 PDF 时，在扩展详情中允许访问文件网址。更新应用后，在扩展管理页手动重载扩展。

请使用应用导出的目录，而不是直接加载仓库的 `Integrations/Browser/`。导出目录包含本机生成的 `connection.local.json`；此文件属于私有连接配置，不应上传或分享。

网页显示逐段双语对照。PDF 在当前标签切换原文、译文和对照；具体显示受 PDF 内容及浏览器页面权限影响。

### Zotero

1. 点击“Zotero 插件文件”，定位应用内的 `askgpt-inline-zotero.xpi`。
2. 在 Zotero 插件管理界面选择从文件安装，按宿主提示重启或重新加载。
3. 打开 PDF 标签，按 `⌥⇧X`；默认翻译本页，可在插件界面选择整份。

译文保留在当前阅读标签，可切回原文。双语对照支持联动或独立滚动、同步大小及基于精确词语对应的标注。选中文字不会自动保存标注；需要用户选择颜色。无法建立精确对应的位置会提示失败，不会把整句当成所选词的替代位置。

Preview / WPS PDF 可从菜单栏 PDF 入口翻译，生成的私有译本仍在原阅读器打开。若阅读器未公开本机文件地址，使用“打开 PDF 文件”手动选择。原始 PDF 不被覆盖。

## 5. Word / WPS 写作加载项

写作组件提供本机拼写检查、GPT 选句和上下文润色。可选择美式/英式拼写、最小修改/清晰表达及标注色。写作服务与阅读翻译使用独立的 localhost HTTPS 连接。

写作润色继续使用 Codex；设置中的可选翻译配置只影响阅读翻译与句词映射。

先只准备资源：

```bash
python3 scripts/prepare-writing-tls
python3 scripts/install-writing-addins prepare
```

第一条生成独立的 localhost TLS 文件，默认位于 `~/Library/Application Support/AskGPTReader/WritingTLS/`；不会安装证书信任，也不会访问应用签名身份。该目录已存在时脚本拒绝覆盖。第二条在项目 `work/writing-addins-prepared/` 生成可检查的安装资源和目标清单，尚未写入 Word/WPS 配置。

准备完成后，检查生成文件和证书指纹，自行确认并完成这张 localhost 证书的信任操作，然后保存、关闭 Word/WPS。满足这些条件后运行：

```bash
python3 scripts/install-writing-addins install \
  --prepared work/writing-addins-prepared --hosts-closed --tls-trusted
```

这两个参数声明你已关闭宿主并信任证书；脚本会核对宿主状态，不会自行关闭文档或授予证书信任。

安装后可通过应用菜单“Word / WPS 写作检查”查看状态和加载项文件；Word 中通过“开始 → 加载项”打开写作助手。首次在副本文档上检查建议、确认替换及格式读回，再用于正式文稿。

Word 可使用文内建议和原生悬浮界面；替换会重新核对文档、选段和权限。受保护内容或无法确认的格式可能仅提供预览。WPS 当前采用侧栏主动检查，不支持文内彩色下划线；Mac 内容事件、替换及原生撤销仍需目标机器实测，不能按 Word 的验证范围理解。

## 6. 常用操作

| 操作 | 默认入口 |
| --- | --- |
| 翻译选段 | `⌥D`；翻译快捷键可在设置中修改 |
| 围绕选段提问 | `⌥X` |
| 页面翻译 / 恢复 | Chrome / Zotero 中 `⌥⇧X`，由插件接收 |
| 打开设置 | `⌘,` 或菜单栏“设置…” |
| 发送问题 / 换行 | Enter / Shift+Enter |
| 自动划词翻译 | 设置或菜单栏“选中自动翻译”开关 |
| 翻译方向 | EN→中、中→EN、Auto |
| 选段处理模式 | Local、GPT、Explain |

没有可读取选区时，可手动粘贴。系统安全输入、应用未暴露辅助功能文本或读取期间切换文档时，自动读取可能不可用。页面快捷键冲突时，可使用插件按钮；翻译快捷键避免占用提问和页面翻译组合键。

## 7. 数据流、保存与限制

- **Local 与词典**：本机翻译使用 Apple Translation 和已安装语言包，词典读取随应用打包的 ECDICT 数据。普通选区预热只运行本机处理，不会自动发送到外部模型服务。
- **短段翻译**：GPT 精译/Explain 发送当前选段与所需上下文，采用当前翻译后端；未填写可选配置时使用 Codex。
- **问答与写作**：提问发送选段、问题和相应对话上下文，并可进行网页检索；写作润色包含目标文本及必要的邻段上下文。这两类功能继续经过已登录的 Codex CLI。
- **PDF 翻译**：PDF 在本机提取和排版，独立 helper 将需要翻译的正文和句词映射上下文提交给所选模型服务；不把 PDF 二进制作为模型输入。应仅处理你有权提交给相应服务的内容。
- **凭据与费用**：API Key 保存在用户指定的本机纯文本密钥文件，由 `apiKeyFile`引用；不把密钥写进 JSON 示例或发布包。使用 API 后，费用和额度计入对应服务账户。CLI 方式沿用各自的认证与账户规则。
- **本机连接**：阅读插件、PDF 服务和写作桥使用分离的本机端口与认证。连接令牌、API 密钥、证书私钥和私人运行配置不应放入仓库、问题反馈或截图。
- **原文与标注**：原始 PDF 不被覆盖。Zotero 中用户确认的标注会保存到对应文献的标注记录；译文侧选区通过词语映射关联原文。
- **完成译本**：按源文档哈希、页面范围、语言方向、翻译修订及后端配置摘要隔离复用。完成的本地译本永久保留；未完成、失败或取消的临时目录才受最多64项、7天及768 MiB的清理限制。当前最多同时运行2个文档任务，各自可取消。
- **无 OCR**：当前面向可提取文本的 PDF。扫描件不支持，图片内文字不翻译；复杂竖排文字和图内文字可能没有可靠的词语对应。排版保留与精确词级标注是不同能力，不能互相替代。
- **结果检查**：翻译和润色仍需核对数字、公式、术语、引文及原意。首次使用新文档或宿主版本，分别检查处理成功、译文内容、最终显示和修改结果。

## 8. 验证与源码依据

核心测试入口：

```bash
./scripts/test
```

遇到同类 SwiftPM manifest SDK 错误时，确认 SDK 路径后运行：

```bash
SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk ./scripts/test
```

浏览器、Zotero 和写作集成测试需要 Node.js。包含 Swift 原生检查的测试同样使用项目 SDK：

```bash
SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk \
  node --test Integrations/Browser/tests/*.cjs \
  Integrations/Zotero/tests/*tests.cjs Integrations/Writing/tests/*.test.cjs
```

准备好 PDF runtime 后，用其锁定依赖运行 Python 检查；部分测试需绑定临时 localhost 端口并写入依赖缓存：

```bash
"$HOME/Library/Application Support/AskGPTReader/PDFLayout/runtime/bin/python" \
  -m unittest discover -s Integrations/PDFLayout/tests
```

重新渲染界面图：先运行核心测试以生成当前 debug Core，再执行 `python3 scripts/render-readme-previews`。该入口使用演示状态，不调用模型，不操作已安装应用；段落阅读图单独保留历史来源。

测试通过说明覆盖范围内的代码检查通过，不等同于目标机器安装成功、权限已授予或所有宿主交互均已验收。本手册编写时没有重新执行新机器安装，也没有发起模型请求。

默认 Codex 翻译与阅读流程已有既有运行记录；本次新增 API / Claude Code 接入已构建，未做连通或翻译效果测试。配置文件示例只包含占位值。

安装流程以 [构建脚本](../scripts/build-app)、[签名工具](../scripts/app-signing)、[安装脚本](../scripts/install-app)、[PDF runtime 安装器](../Integrations/PDFLayout/install-runtime) 和 [写作加载项准备器](../scripts/install-writing-addins) 为准。兼容边界见 [本机翻译](../Sources/AskGPTCore/NativeTranslationEngine.swift)、[写作服务入口](../Sources/AskGPT/WritingIntegrationController.swift)、[Chrome manifest](../Integrations/Browser/manifest.json)、[Zotero manifest](../Integrations/Zotero/manifest.json) 和 [WPS adapter](../Integrations/Writing/wps/wps-host.js)。上游来源与许可证见 [BabelDOC provenance](../Integrations/PDFLayout/UPSTREAM.json) 和 [词典 provenance](../Resources/Dictionary/provenance.json)。
