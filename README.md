<div align="center">

**中文 · [English](README.en.md)**

<img src="Resources/AppIcon.png" width="96" alt="Ask for GPT 图标">

# 📖 Ask for GPT

**读论文时，少切几个窗口。**

划词查词、随手提问、网页和 PDF 双语阅读；阅读笔记留在 Zotero，写作时再把表达打磨顺一点。

[![下载 macOS DMG](https://img.shields.io/badge/下载_macOS-DMG-28527A?style=for-the-badge&logo=apple)](https://github.com/Woyekun-cell/Ask-for-GPT/releases/download/v1.1.59/Ask-for-GPT-1.1.59-macOS-arm64.dmg)
[![下载 ZIP](https://img.shields.io/badge/下载-ZIP-4F8F8A?style=for-the-badge)](https://github.com/Woyekun-cell/Ask-for-GPT/releases/download/v1.1.59/Ask-for-GPT-1.1.59-macOS-arm64.zip)

[![下载 Windows](https://img.shields.io/badge/下载_Windows-x64-0078D4?style=for-the-badge&logo=windows)](https://github.com/Woyekun-cell/Ask-for-GPT/releases/download/v1.1.38/Ask-for-GPT-0.1.0-preview.1-Windows-x64-Setup.exe)

**macOS v1.1.59 · Apple Silicon · macOS 15+ | Windows x64 v0.1.0-preview.1**

[macOS 安装](docs/INSTALL.macOS.zh-CN.md) · [Windows 安装](docs/INSTALL.Windows.zh-CN.md) · [Zotero 阅读指南](docs/ZOTERO.zh-CN.md) · [翻译后端配置](docs/TRANSLATION-BACKENDS.zh-CN.md) · [界面图廊](docs/GALLERY.md) · [发行记录](https://github.com/Woyekun-cell/Ask-for-GPT/releases) · [反馈问题](https://github.com/Woyekun-cell/Ask-for-GPT/issues)

</div>

Ask for GPT 提供 Windows 和 macOS 两个版本，把划词查词、带着选段提问、网页和 PDF 对照阅读接在一起，标注和笔记留在 Zotero。macOS版还提供 Word/WPS 写作辅助。项目还在持续更新，我也会沿着读文献和写作中的实际需求继续完善。

它保留你熟悉的工作环境：Zotero 原有的文献标签和标注、Chrome 正在阅读的网页，以及 Word 中的稿件。英文单词优先查本地词典；macOS 1.1.59 的 AI 功能通过 Codex 使用你自己的 ChatGPT 登录会话。

## 全功能视频介绍

[![Ask for GPT 全功能介绍：查词、翻译、提问、网页与 PDF 阅读、标注、图表和写作辅助](docs/images/feature-overview-cover.png)](https://github.com/Woyekun-cell/Ask-for-GPT/releases/download/v1.1.55/Ask-for-GPT-feature-overview-en.mp4)

**[▶ 点击观看完整视频 · 英文旁白 · 约 3 分钟](https://github.com/Woyekun-cell/Ask-for-GPT/releases/download/v1.1.55/Ask-for-GPT-feature-overview-en.mp4)**

从查一个词开始，了解段落翻译与上下文提问、Chrome 网页翻译、Zotero 双语阅读、词组对应、原生标注、联动/独立滚动、图表预览与写作建议。视频结合实机截图、录屏和明确标注的原生界面预览，按完整使用流程介绍产品。[英文稿与素材说明](docs/GALLERY.md#feature-overview)。

## 下载与安装

**Windows版（x64）：** [Windows 安装包与便携版](https://github.com/Woyekun-cell/Ask-for-GPT/releases/tag/v1.1.38) · [安装与配置](docs/INSTALL.Windows.zh-CN.md)。提供划词、离线词典、段落翻译与提问、Chrome/Zotero 阅读集成、PDF 对照及可配置翻译后端。[构建与检查记录](https://github.com/Woyekun-cell/Ask-for-GPT/actions/workflows/windows-preview.yml)见工作流。下方界面展示使用 macOS版。

macOS 1.1.59 修复精确选词、跨句缓存复用、重复划选与失败会话释放，并减少本地侧车发布的 CPU 与锁等待。Word/WPS 本轮未改。Windows 包沿用独立验证的 `0.1.0-preview.1` 构建（源码 `05348ad`），上述新阅读功能不代表已同步进入该预览包。

macOS版可直接下载上方安装包。应用本体约 **48 MB**，包含约 40 万条英文词条、Chrome/Zotero 插件和写作集成资源。

| 下载 | 适合怎样安装 |
| --- | --- |
| [DMG 安装包](https://github.com/Woyekun-cell/Ask-for-GPT/releases/download/v1.1.59/Ask-for-GPT-1.1.59-macOS-arm64.dmg) | 推荐。打开磁盘映像，将应用拖入“应用程序”，按随包指引完成首次设置 |
| [ZIP 压缩包](https://github.com/Woyekun-cell/Ask-for-GPT/releases/download/v1.1.59/Ask-for-GPT-1.1.59-macOS-arm64.zip) | 解压后安装；包含相同应用和准备脚本 |
| [源码](https://github.com/Woyekun-cell/Ask-for-GPT/archive/refs/heads/main.zip) | 自行构建、阅读实现或修改集成；开发步骤见[源码手册](docs/HANDBOOK.zh-CN.md) |

macOS 首次设置分四步：

1. **安装应用。** 将 Ask for GPT 放入“应用程序”并打开。当前版本未经 Apple 公证；若 macOS 阻止首次打开，在“系统设置 → 隐私与安全性”中按系统提示确认。
2. **配置模型连接。** 默认运行随包的 `01-登录ChatGPT.command`。脚本解压并校验官方 Codex CLI 0.163.0，由你在浏览器完成登录。把提供的 CLI 路径复制到设置，点击 **保存并连接**。这个过程无需安装 npm 或 Homebrew。
3. **按需准备 PDF 翻译。** 运行 `02-准备PDF翻译.command`，自动准备固定版本的 uv、Python 3.12.15、预编译依赖，以及排版需要的公开字体和模型。首次需要联网，完成后本地占用约 1 GB；准备过程无需编译。日常 PDF 翻译仍需联网调用模型。
4. **连接阅读软件。** 在应用菜单栏打开 **页面内翻译…**，安装 Zotero 插件或加载 Chrome 扩展。之后即可在原来的阅读页面使用。

每一步的界面、权限与常见问题见[macOS 安装指南](docs/INSTALL.macOS.zh-CN.md)。只查英文单词时，本地词典可以离线使用。

### 当前版本的模型连接

macOS **1.1.59 安装包使用 Codex**，在设置的 **CLI 路径**中填写已登录的 Codex CLI，点击 **保存并连接**。此前公开源码中的 API / Claude 可选适配未包含在这个 macOS 二进制中；Windows 预览版与历史配置说明见[翻译后端说明](docs/TRANSLATION-BACKENDS.zh-CN.md)。


## 在 Zotero 中精读一篇论文

### 先翻一页，再决定是否读完整篇

在 Zotero 打开 PDF，右侧 **PDF 翻译**面板提供 **范围、显示、方向**三个选择。先用 **当前页 + 中英对照 + EN → 中**阅读摘要或关键结果，确认文章相关，再把范围改为 **整篇**继续处理。中文文献也可以选 **中 → EN**。

![Zotero 双语阅读：英文原文与中文译文并排显示](docs/images/zotero/live-bilingual.jpg)

*Zotero 双语阅读 · Liao 等，[A draft human pangenome reference](https://doi.org/10.1038/s41586-023-05896-x)（Nature, 2023；[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)）。右侧为 Ask for GPT 生成的中文机器译文与排版。*

翻译就在当前文献标签里显示。页数进度会留在侧栏和顶部工具栏，你可以继续看原文，或者切换到另一篇论文。各篇任务独立，最多同时处理两篇文档，并可分别停止。

### 原文、译文、对照，按阅读节奏切换

顶部的 **原文 / 译文 / 对照**适合三种阅读方式：看原句、连贯读译文，或左右核对。译文重新排入 PDF 页面，保留图表与正文的布局关系；对照视图左侧原文、右侧译文，使用两个原生 PDF 阅读窗格。

![Zotero 译文视图：已完成的第一页](docs/images/zotero/live-translated.jpg)

读一节内容时可以先用译文，遇到术语、公式或关键结论再切回对照。切换显示方式会复用完成结果；原 PDF、文献身份和阅读进度继续沿用原附件。

### 选中词组，查看另一侧的对应表达

在对照视图任意一侧划选词语，另一侧会显示已经建立的对应选区。可以从英文查看中文意思，也可以从中文回看英文用词。专业术语、动词搭配和句中修饰关系，都能放在上下文中核对。

![真实论文双向划词与 Zotero 原生八色面板](docs/images/zotero/live-word-palette.jpg)

*真实操作：英文 “pangenome” 与中文“泛基因组”显示对应选区，原生八色面板同时打开；此图展示临时选区，尚未保存标注。*

词语对应会处理两种语言的词长与顺序差异。有可靠对应时，中文的部分选区可以关联到完整英文词，同时保留你实际选中的中文范围。只想查词或复制文本时，选中后继续操作即可；普通划选不会自动创建标注。

### 用原生八色标注留下自己的阅读记录

选择正文后，使用 Zotero 原生八色浮层手动保存高亮或下划线。译文侧保存的标注会关联到原 PDF 的相应文字位置，并保留译文摘录。之后仍可在 Zotero 标注列表中添加评论、改色和定位。

再次切回原文或重开对照视图，已有标注会按对应关系重新显示。你可以把颜色留给自己的阅读习惯：疑问、方法、证据、结论，由你决定如何整理。

### 一起滚动，或把一侧留在当前段落

**联动**适合顺着文章连续读：在任意一侧滚动，另一侧跟随。点击后切为 **独立**，就能把一侧停在结果段，另一侧向前查方法或术语。准备继续时，再恢复联动，以当前阅读侧重新对齐。

![实机独立滚动：原文 Fig. 1 与中文第一页](docs/images/zotero/live-independent.jpg)

*左侧查看原文 Fig. 1，右侧保留已完成的中文第一页。论文来源同上。*

![联动与独立滚动，以及更多菜单中的同步大小](docs/images/zotero/live-reading-tools.jpg)

两侧大小不一致时，用 **⋯ → 同步大小**把另一侧缩放比例调整到当前侧。更多菜单还提供 **本页 / 整份**、停止、重试、缩小、适合宽度和放大；按住 **Option** 单击段落，可以聚焦正在读的部分。若词语对应仍在准备，页面可以继续阅读；已有译本时，重试会优先补齐需要的对应信息。

### 图表跳到一侧，结果段留在另一侧

点击 **图表**打开图表索引，按编号、页次和标题摘录查找。选择 **左侧**或 **右侧**后再点击条目，所选窗格跳到图表，另一侧保留当前位置。读到“见 Fig. 3”时，可以一边看图，一边保留结果段。

![图表索引选择跳转侧，保留另一侧阅读位置](docs/images/zotero/live-navigation.jpg)

图表跳转会切为独立滚动。查看结束后，恢复联动即可继续精读。单击论文图片，或悬停后按 **空格**，可以打开独立预览窗口，缩放、适合窗口或导出 PNG。

![真实 Fig. 1 独立预览与 PNG 导出成功状态](docs/images/zotero/live-figure-export.jpg)

*同一论文 Fig. 1 的独立窗口实拍：可放大、缩小、适合窗口及导出 PNG；图中 “PNG exported” 为本次实际导出完成状态。[放大前后示例](docs/GALLERY.md#独立放大图片并导出-png)。*

侧栏可分别开启 **悬停释义**和 **重开时提示阅读位置**：快速查一个词，或下次打开时接着读。完成译本长期保存在本机，按文献内容、范围、方向和后端配置匹配复用；已有整篇结果也能取用相应的本页。与源文献匹配的完整本地译本，还可以作为普通 PDF 附件管理。图表索引在当前 PDF 会话内复用。

完整按钮说明、后台任务和标注操作见 **[Zotero 阅读指南](docs/ZOTERO.zh-CN.md)**。

## 遇到一个生词，随手查清

在可读取选区的应用里选中文字，按 `⌥D`打开翻译浮窗。单个英文词优先查本地词典，显示音标、词性、释义和词形；段落可在 **Local / GPT / Explain** 三种方式中继续阅读。

![划词翻译浮窗](docs/images/translation.png)

**Local** 使用 macOS 的 Apple 本机翻译；主动点击 **GPT** 时精译当前选段，点击 **Explain** 时解释选段中的术语、逻辑和限定条件。展开原文核对，结果支持选中后使用系统复制；任务进行中可停止，再用重试继续。

方向可选 **EN→中 / 中→EN / Auto**；Auto 自动识别源语言后译成中文。没有选区时，可以在 **Paste text** 中粘贴并点击 **Translate**。文字颜色、自动划词和 **Ask GPT** 提问入口也在小窗中，便于顺着当前选段继续阅读。

## 带着选段提问，把问题问具体

选中难懂的句子，按 `⌥X`进入提问。选段会作为上下文，你可以问“这里的条件指什么”“这个术语与前文有什么关系”，也可以要求解释句子结构。回答逐步显示，之后继续追问，无需反复复制原句。

需要补充外部资料时，问答支持网页检索与来源链接，便于沿着来源继续阅读。输入框中 **Enter**发送，**Shift+Enter**换行。

## 在网页原来的位置读翻译

Chrome 扩展把译文逐段放回网页，原文在上、译文在下。它优先处理当前视口附近的段落，随着向下阅读继续翻译；底部可以切换方向和文字颜色、暂停、继续或恢复原文。

Chrome PDF 在当前标签中保版阅读，提供 **Page / Document** 范围、原文/译文/对照视图、页码与进度，以及翻译和 **Cancel** 操作。默认快捷键 `⌥⇧X`用于页面翻译或恢复；本机 PDF 需要在扩展设置中允许访问文件网址。插件安装步骤放在[安装指南](docs/INSTALL.macOS.zh-CN.md)中。

macOS 上在 Preview 或 WPS 阅读 PDF 时，可从菜单 **PDF · 原阅读器** 选择本页或整份、只看译文或原文＋译文，以及 **EN→中 / 中→EN**。译本会交回原应用打开；菜单也提供最近译文、恢复原文和取消翻译，原 PDF 保留。

## 写作时，先看清建议，再决定修改

Word 写作集成提供拼写检查和 GPT 表达建议。建议卡把原文与修改放在一起，你可以选择替换、忽略或加入词典；润色可按最小修改或更清晰表达处理，并设置英式或美式拼写偏好。

![写作建议卡：查看原文与修改，再选择替换](docs/images/writing.png)

阅读和写作使用同一应用设置，便于从理解文献切换到整理自己的表达。Word/WPS 加载项需要额外准备本机连接与 HTTPS，具体步骤见[源码手册的写作集成部分](docs/HANDBOOK.zh-CN.md#5-word--wps-写作加载项)。WPS 提供侧栏主动检查，适用范围见下方兼容性说明。

## 设置与快捷键

macOS 1.1.59 在设置中填写 **CLI 路径**、提问模型与推理强度，点击 **保存并连接**。下方设置截图保留历史版本来源，其中可选翻译配置不适用于当前 Mac 安装包。

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
| macOS版 | Apple Silicon Mac；完整 PDF 环境要求 macOS 15+；当前未经 Apple 公证 |
| Windows版 | Windows x64；提供划词、翻译、提问及 Chrome/Zotero PDF 对照；安装与平台范围见[Windows 指南](docs/INSTALL.Windows.zh-CN.md) |
| Apple 本机短段翻译 | macOS 26+，需安装相应语言包 |
| AI 连接 | macOS 1.1.59 通过 Codex CLI 使用个人 ChatGPT 登录；Windows 预览版选项见独立指南 |
| Zotero | Zotero 9.x；PDF 翻译需要准备随包 PDF 环境 |
| Chrome | Chrome 106+；本机 PDF 需文件网址访问权限 |
| PDF 内容 | 面向有文字层的 PDF；扫描件需先 OCR，图片内文字保留原样；复杂竖排图内文字可能缺少精确词语对应 |
| Word / WPS（macOS） | Word 提供文内建议；WPS 当前为侧栏主动检查，文内彩色下划线不可用，替换与撤销仍需目标版本实测 |

本地词典和 Apple 本机翻译在设备上处理。macOS 1.1.59 的 AI 翻译、句词映射、问答与写作会通过个人 Codex 连接提交相关文字和必要上下文。Windows 预览版的连接选项见独立指南。PDF 提取与排版在本机完成。请使用有权交由相应服务处理的内容。

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
