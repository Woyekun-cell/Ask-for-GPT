<div align="center">

**中文 · [English](README.en.md)**

<img src="Resources/AppIcon.png" width="96" alt="Ask for GPT 图标">

# 📖 Ask for GPT

**读论文时，少切几个窗口。**

划词查词、随手提问、网页和 PDF 双语阅读；阅读笔记留在 Zotero，写作时再把表达打磨顺一点。

[![下载 macOS DMG](https://img.shields.io/badge/下载_macOS-DMG-28527A?style=for-the-badge&logo=apple)](https://github.com/Woyekun-cell/Ask-for-GPT/releases/download/v1.0.85/Ask-for-GPT-1.0.85-macOS-arm64.dmg)
[![下载 ZIP](https://img.shields.io/badge/下载-ZIP-4F8F8A?style=for-the-badge)](https://github.com/Woyekun-cell/Ask-for-GPT/releases/download/v1.0.85/Ask-for-GPT-1.0.85-macOS-arm64.zip)

**v1.0.85 · Apple Silicon · macOS 15+**

[安装指南](docs/INSTALL.macOS.zh-CN.md) · [Zotero 阅读指南](docs/ZOTERO.zh-CN.md) · [翻译后端配置](docs/TRANSLATION-BACKENDS.zh-CN.md) · [界面图廊](docs/GALLERY.md) · [发行记录](https://github.com/Woyekun-cell/Ask-for-GPT/releases) · [反馈问题](https://github.com/Woyekun-cell/Ask-for-GPT/issues)

</div>

读论文时，查词、翻译和提问最好都能顺着阅读的节奏来。Ask for GPT 把这些事接在一起：在 macOS 上划词查词、带着选段提问，在网页和 PDF 中对照阅读，把标注和笔记留在 Zotero，写作时再检查拼写、打磨表达。项目还在持续更新，会沿着读文献和写作中的实际需求继续完善。

它保留你熟悉的工作环境：Zotero 原有的文献标签和标注、Chrome 正在阅读的网页，以及 Word 中的稿件。英文单词优先查本地词典；AI 功能默认使用你自己的 ChatGPT 登录会话，翻译另有可选的配置文件接入方式。

## 下载与安装

**Windows x64 阅读预览版：** [EXE 安装器与便携 ZIP](https://github.com/Woyekun-cell/Ask-for-GPT/releases/tag/windows-v0.1.0-preview.1) · [中文安装与配置](docs/INSTALL.Windows.zh-CN.md)。包含划词、离线词典、Chrome/Zotero 与 PDF 对照及可配置翻译后端；Word/WPS 写作辅助后续再做。[Windows runner 构建与自动检查](https://github.com/Woyekun-cell/Ask-for-GPT/actions/workflows/windows-preview.yml)结果见工作流；尚无 Windows 10/11 用户桌面实机验收。下方界面图片来自 macOS。

普通使用直接下载上方安装包。应用本体约 **48 MB**，包含约 40 万条英文词条、Chrome/Zotero 插件和写作集成资源。

| 下载 | 适合怎样安装 |
| --- | --- |
| [DMG 安装包](https://github.com/Woyekun-cell/Ask-for-GPT/releases/download/v1.0.85/Ask-for-GPT-1.0.85-macOS-arm64.dmg) | 推荐。打开磁盘映像，将应用拖入“应用程序”，按随包指引完成首次设置 |
| [ZIP 压缩包](https://github.com/Woyekun-cell/Ask-for-GPT/releases/download/v1.0.85/Ask-for-GPT-1.0.85-macOS-arm64.zip) | 解压后安装；包含相同应用和准备脚本 |
| [源码](https://github.com/Woyekun-cell/Ask-for-GPT/archive/refs/heads/main.zip) | 自行构建、阅读实现或修改集成；开发步骤见[源码手册](docs/HANDBOOK.zh-CN.md) |

首次设置分四步：

1. **安装应用。** 将 Ask for GPT 放入“应用程序”并打开。当前版本未经 Apple 公证；若 macOS 阻止首次打开，在“系统设置 → 隐私与安全性”中按系统提示确认。
2. **配置模型连接。** 默认运行随包的 `01-登录ChatGPT.command`。脚本解压并校验官方 Codex CLI 0.163.0，由你在浏览器完成登录。把提供的 CLI 路径复制到设置，点击 **保存设置**，再点 **测试 Codex**。这个过程无需安装 npm 或 Homebrew；可选翻译后端见下文。
3. **按需准备 PDF 翻译。** 运行 `02-准备PDF翻译.command`，自动准备固定版本的 uv、Python 3.12.15、预编译依赖，以及排版需要的公开字体和模型。首次需要联网，完成后本地占用约 1 GB；准备过程无需编译。日常 PDF 翻译仍需联网调用模型。
4. **连接阅读软件。** 在应用菜单栏打开 **页面内翻译…**，安装 Zotero 插件或加载 Chrome 扩展。之后即可在原来的阅读页面使用。

每一步的界面、权限与常见问题见[macOS 安装指南](docs/INSTALL.macOS.zh-CN.md)。只查英文单词时，本地词典可以离线使用。

### 按需选择翻译后端

设置中的 **翻译配置文件**留空，继续使用默认 Codex。希望接入 DeepSeek 等 Chat Completions API，或自己已经安装并登录的 Claude Code，可以在这里填写本机 JSON 配置文件的完整路径，再点击 **保存设置**并重启。API 方式填写完整 HTTPS 接口地址、模型 ID 和本地密钥文件路径；Claude Code 方式填写 CLI 路径与可选模型。

该配置用于**短段精译、PDF 正文翻译及句词映射**，问答与写作继续使用 Codex；**测试 Codex**只检查 Codex 连接。新增 API / Claude Code 属于**实验性接入，已构建，本次未做连通或效果测试**。

安装包带有配置指南与占位示例。字段、密钥文件和使用步骤见[翻译后端配置](docs/TRANSLATION-BACKENDS.zh-CN.md)。选择 API 后，翻译请求发送至所填服务，费用和额度计入该服务账户。

## 在 Zotero 中精读一篇论文

### 先翻一页，再决定是否读完整篇

在 Zotero 打开 PDF，右侧 **PDF 翻译**面板提供 **范围、显示、方向**三个选择。先用 **当前页 + 中英对照 + EN → 中**阅读摘要或关键结果，确认文章相关，再把范围改为 **整篇**继续处理。中文文献也可以选 **中 → EN**。

![Zotero 双语阅读：英文原文与中文译文并排显示](docs/images/zotero/live-bilingual-reading.jpg)

*Zotero 双语阅读 · Liao 等，[A draft human pangenome reference](https://doi.org/10.1038/s41586-023-05896-x)（Nature, 2023；[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)）。右侧为 Ask for GPT 生成的中文机器译文与排版。*

翻译就在当前文献标签里显示。页数进度会留在侧栏和顶部工具栏，你可以继续看原文，或者切换到另一篇论文。各篇任务独立，最多同时处理两篇文档，并可分别停止。

### 原文、译文、对照，按阅读节奏切换

顶部的 **原文 / 译文 / 对照**适合三种阅读方式：看原句、连贯读译文，或左右核对。译文重新排入 PDF 页面，保留图表与正文的布局关系；对照视图左侧原文、右侧译文，使用两个原生 PDF 阅读窗格。

![Zotero 译文视图与整篇处理进度](docs/images/zotero/02-views.png)

读一节内容时可以先用译文，遇到术语、公式或关键结论再切回对照。切换显示方式会复用完成结果；原 PDF、文献身份和阅读进度继续沿用原附件。

### 选中词组，查看另一侧的对应表达

在对照视图任意一侧划选词语，另一侧会显示已经建立的对应选区。可以从英文查看中文意思，也可以从中文回看英文用词。专业术语、动词搭配和句中修饰关系，都能放在上下文中核对。

![双向词组选择与 Zotero 原生颜色浮层](docs/images/zotero/03-selection.png)

词语对应会处理两种语言的词长与顺序差异。有可靠对应时，中文的部分选区可以关联到完整英文词，同时保留你实际选中的中文范围。只想查词或复制文本时，选中后继续操作即可；普通划选不会自动创建标注。

### 用原生八色标注留下自己的阅读记录

选择正文后，使用 Zotero 原生八色浮层手动保存高亮或下划线。译文侧保存的标注会关联到原 PDF 的相应文字位置，并保留译文摘录。之后仍可在 Zotero 标注列表中添加评论、改色和定位。

![手动保存蓝色标注，原文与译文显示对应内容](docs/images/zotero/04-annotations.png)

再次切回原文或重开对照视图，已有标注会按对应关系重新显示。你可以把颜色留给自己的阅读习惯：疑问、方法、证据、结论，由你决定如何整理。

### 一起滚动，或把一侧留在当前段落

**联动**适合顺着文章连续读：在任意一侧滚动，另一侧跟随。点击后切为 **独立**，就能把一侧停在结果段，另一侧向前查方法或术语。准备继续时，再恢复联动，以当前阅读侧重新对齐。

![实机对照阅读同一页的英文摘要与中文译文](docs/images/zotero/live-abstract-detail.jpg)

*独立滚动，对照查看摘要与正文。论文来源同上。*

![联动与独立滚动，以及更多菜单中的同步大小](docs/images/zotero/05-reading-tools.png)

两侧大小不一致时，用 **⋯ → 同步大小**把另一侧缩放比例调整到当前侧。更多菜单还提供 **本页 / 整份**、停止、重试、缩小、适合宽度和放大。若词语对应仍在准备，页面可以继续阅读；已有译本时，重试会优先补齐需要的对应信息。

### 图表跳到一侧，结果段留在另一侧

点击 **图表**打开图表索引，按编号、页次和标题摘录查找。选择 **左侧**或 **右侧**后再点击条目，所选窗格跳到图表，另一侧保留当前位置。读到“见 Fig. 3”时，可以一边看图，一边保留结果段。

![图表索引选择跳转侧，保留另一侧阅读位置](docs/images/zotero/06-navigation.png)

图表跳转会切为独立滚动。查看结束后，恢复联动即可继续精读。索引在当前 PDF 会话内复用；完成译本则长期保存在本机，按文档内容、页范围、语言方向、翻译版本和后端配置摘要匹配复用。已有整篇结果时，也能直接取用相应的本页。

完整按钮说明、后台任务和标注操作见 **[Zotero 阅读指南](docs/ZOTERO.zh-CN.md)**。

## 遇到一个生词，随手查清

在可读取选区的应用里选中文字，按 `⌥D`打开翻译浮窗。单词优先查本地词典，显示音标、词性、多义和词形；段落可以使用本机翻译，或继续选择 GPT 精译、解释。

![划词翻译浮窗](docs/images/translation.png)

浮窗把语言方向、译文颜色和提问入口放在一起。默认英文转中文，也支持中文转英文与自动判断方向。需要连续阅读时，可以开启自动划词翻译；想自己控制节奏，就保留快捷键操作。

## 带着选段提问，把问题问具体

选中难懂的句子，按 `⌥X`进入提问。选段会作为上下文，你可以问“这里的条件指什么”“这个术语与前文有什么关系”，也可以要求解释句子结构。回答逐步显示，之后继续追问，无需反复复制原句。

需要补充外部资料时，问答支持网页检索与来源链接，便于沿着来源继续阅读。输入框中 **Enter**发送，**Shift+Enter**换行。

## 在网页原来的位置读翻译

Chrome 扩展把译文逐段放回网页，原文在上、译文在下。阅读论文摘要、技术文档或长文章时，可以沿着原页面往下读，也可以随时恢复原页面。

Chrome 的 PDF 走保版阅读流程，在当前标签显示。默认快捷键 `⌥⇧X`用于页面翻译或恢复；本机 PDF 需要在扩展设置中允许访问文件网址。插件安装步骤放在[安装指南](docs/INSTALL.macOS.zh-CN.md)中。

## 写作时，先看清建议，再决定修改

Word 写作集成提供拼写检查和 GPT 表达建议。建议卡把原文与修改放在一起，你可以选择替换、忽略或加入词典；润色可按最小修改或更清晰表达处理，并设置英式或美式拼写偏好。

![写作建议卡：查看原文与修改，再选择替换](docs/images/writing.png)

阅读和写作使用同一应用设置，便于从理解文献切换到整理自己的表达。Word/WPS 加载项需要额外准备本机连接与 HTTPS，具体步骤见[源码手册的写作集成部分](docs/HANDBOOK.zh-CN.md#5-word--wps-写作加载项)。WPS 提供侧栏主动检查，适用范围见下方兼容性说明。

## 设置与快捷键

Codex CLI 路径、提问模型、推理强度、可选翻译配置文件、自动划词和快捷键集中在一张设置卡中。点击 **保存设置**保存修改；**测试 Codex**用于检查问答与默认翻译所用的 Codex 连接。独立翻译配置可以单独保存。

![设置：Codex 路径、翻译配置、自动划词和快捷键](docs/images/settings.png)

| 默认快捷键 | 操作 |
| --- | --- |
| `⌥D` | 翻译选中文字，可在设置中修改 |
| `⌥X` | 围绕选段提问 |
| `⌥⇧X` | Chrome / Zotero 页面翻译或恢复 |
| `⌘,` | 打开设置 |
| `Enter` / `Shift+Enter` | 问答中发送 / 换行 |

## 兼容性与数据处理

| 项目 | 当前范围 |
| --- | --- |
| 下载版 | Apple Silicon Mac；完整 PDF 环境要求 macOS 15+；当前未经 Apple 公证 |
| Apple 本机短段翻译 | macOS 26+，需安装相应语言包 |
| AI 连接 | 默认 Codex CLI 使用 ChatGPT 登录；可选翻译接入使用对应服务配置，问答与写作仍用 Codex |
| Zotero | Zotero 9.x；PDF 翻译需要准备随包 PDF 环境 |
| Chrome | Chrome 106+；本机 PDF 需文件网址访问权限 |
| PDF 内容 | 面向有文字层的 PDF；扫描件需先 OCR，图片内文字保留原样；复杂竖排图内文字可能缺少精确词语对应 |
| Word / WPS | Word 提供文内建议；WPS 当前为侧栏主动检查，文内彩色下划线不可用，Mac 替换与撤销仍需目标版本实测 |

本地词典和 Apple 本机翻译在设备上处理。AI 翻译与句词映射会向本次任务配置的模型服务提交相应文字和必要上下文；默认通过 Codex，配置 API 或 Claude Code 后走相应服务。问答与写作仍通过 Codex。PDF 提取与排版在本机完成。请使用有权交由相应服务处理的内容。

原 PDF 文件不被覆盖；手动保存的 Zotero 标注写入原附件的标注记录。完成译本长期保留，未完成任务的临时文件另行清理。使用译文撰写或引用前，应核对术语、数字、公式与原意。物理修饰键滚轮手势、实际显示帧率和全新 Mac 的完整安装仍需进一步实机检查。

阅读界面与功能演示的图片来源见[界面图廊](docs/GALLERY.md)。

## 源码与开发

主程序使用 Swift、AppKit 和 SwiftUI；阅读、写作集成和 PDF 引擎源码一并提供。

```text
Sources/       macOS 应用与核心逻辑
Integrations/  Chrome、Zotero、Word/WPS 与 PDF 引擎
Resources/     图标、本地词典与写作规则
Tests/         Swift 核心测试
scripts/       构建、安装、打包与检查
docs/          使用指南、界面来源与发行清单
```

自行构建、运行测试和配置开发环境见[源码手册](docs/HANDBOOK.zh-CN.md)。公开文件的校验值见[发行清单](docs/release-manifest.json)。

本地词典来自 [ECDICT](https://github.com/skywind3000/ECDICT)，PDF 排版集成使用 [BabelDOC](https://github.com/funstory-ai/BabelDOC)。各组件的许可证、固定版本与来源声明见 [NOTICE](NOTICE.md)。

欢迎提交 [Issue](https://github.com/Woyekun-cell/Ask-for-GPT/issues)。附上系统、宿主与插件版本、复现步骤，以及不含私人内容的截图，会更方便定位问题。
