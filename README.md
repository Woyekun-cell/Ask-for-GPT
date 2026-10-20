<div align="center">

**中文 · [English](README.en.md)**

<img src="Resources/AppIcon.png" width="96" alt="Ask for GPT 图标">

# Ask for GPT

**在原来的阅读与写作环境里，翻译、提问、对照和修改。**

[![macOS](https://img.shields.io/badge/platform-macOS-28527A)](#安装与使用)
[![Swift](https://img.shields.io/badge/Swift-6-C97864)](Package.swift)
[![Chrome](https://img.shields.io/badge/Chrome-1.1.2-4F8F8A)](Integrations/Browser/manifest.json)
[![Zotero](https://img.shields.io/badge/Zotero-0.3.24-7D719B)](Integrations/Zotero/manifest.json)

[中文手册](docs/HANDBOOK.zh-CN.md) · [界面图廊](docs/GALLERY.md) · [源码下载](https://github.com/Woyekun-cell/Ask-for-GPT/archive/refs/heads/main.zip) · [反馈问题](https://github.com/Woyekun-cell/Ask-for-GPT/issues)

</div>

Ask for GPT 是面向英文文献阅读和学术写作的 macOS 工具。选中一个词、一段正文或一篇 PDF，就能在浮窗、网页或 Zotero 阅读器中查词、翻译、提问和对照阅读；写作时可以查看拼写与润色建议，再决定是否替换。

主程序使用 Swift、AppKit 和 SwiftUI。英文单词优先查本地词典，短段可使用 Apple 本机翻译；GPT 精译、解释、问答和 PDF 翻译通过用户自己的 Codex CLI 登录会话完成。Chrome、Zotero 与 Word/WPS 集成源码一并提供。

## 适用场景与功能

| 场景 | 可以做什么 |
|---|---|
| 遇到生词 | 全局快捷键查词；音标、词性、多义和词形；约 40 万条本地英文词条 |
| 读一段英文 | EN→中、中→EN、Auto；本机翻译、GPT 精译与解释；选择译文颜色 |
| 对选段有疑问 | 以选段为上下文提问、流式回答与连续追问；支持网页检索与来源链接 |
| 阅读网页 | Chrome 原页面逐段插入译文，上下对照；可以恢复原页面 |
| 阅读 PDF | 本页或整篇翻译；保留页面布局；原文、译文和对照视图；完成结果可复用 |
| 在 Zotero 读文献 | 原标签阅读、原生侧栏、双侧联动滚动、同步大小、词组映射与原生颜色标注 |
| 写英文 | Word 拼写与 GPT 润色建议、最小修改或清晰表达、英美拼写偏好、确认后替换 |
| 使用 WPS | 提供写作侧栏与主动检查适配；具体兼容性见下表 |

## 界面介绍

以下为软件原生界面的演示图，使用自有示例文本。每张图的来源、渲染方式和适用范围见[界面图廊](docs/GALLERY.md)。

### 划词翻译：把解释留在选段旁边

![划词翻译浮窗](docs/images/translation.png)

紧凑浮窗提供翻译方向、译文颜色和后续提问入口。单词可优先使用本地词典，长段可以继续精译或解释。

### 对照阅读：原文和译文逐段对应

![双语阅读演示](docs/images/bilingual-reading.jpg)

图中为自有文本的段落对照阅读演示。Chrome 网页可在原页面插入译文；PDF 另有保版阅读流程，Zotero 可在原生阅读器切换原文、译文和对照视图。

### 写作建议：看清修改，再决定替换

![拼写建议浮层](docs/images/writing.png)

建议卡展示原文与修改，保留替换、忽略和加入词典入口。Word 的实际定位、替换和格式保留需要在具体宿主版本中核验。

### 集中设置：模型、快捷键和自动划词

![设置界面](docs/images/settings.png)

在一张设置卡中配置 CLI 路径、提问模型、推理强度和翻译快捷键，并测试连接。模型可用性取决于用户的账号与 CLI 环境。

## 安装与使用

当前发布为**源码分发**。仓库包含主程序、集成、测试、词典资源及打包脚本；Python PDF 运行环境、模型与字体资源按手册单独准备。

| 组件 | 环境要求与状态 |
|---|---|
| Swift 主程序 | Swift 6 工具链；包声明最低 macOS 13。当前开发脚本优先使用 macOS 26.5 SDK |
| Apple 本机翻译 | macOS 26+，并已安装对应语言包 |
| GPT 功能 | Codex CLI ≥ 0.162.1，使用 ChatGPT 登录；额度与模型权限由账号决定 |
| PDF 引擎 | Python 3.12、uv；BabelDOC 0.6.4 与锁定依赖；当前锁文件针对 Apple Silicon macOS |
| Chrome | Manifest V3，Chrome 106+；本地 PDF 另需文件网址访问权限 |
| Zotero | Zotero 9.x；随源码提供插件与 XPI 打包脚本 |
| Word/WPS 写作桥 | macOS 15+；需单独准备本机 HTTPS 与加载项 |
| WPS 写作适配 | 侧栏主动检查；文内彩色下划线不可用；Mac 内容事件、替换与撤销仍待实机验证 |

准备好工具链后，在自己的 Mac 上建立本机签名身份并构建：

```bash
git clone https://github.com/Woyekun-cell/Ask-for-GPT.git
cd Ask-for-GPT
python3 scripts/app-signing prepare
./scripts/build-app
python3 scripts/install-app
```

签名身份由每台 Mac 自己保管。首次构建、PDF 依赖、Chrome/Zotero 插件和 Word/WPS 加载项的完整步骤见[中文手册](docs/HANDBOOK.zh-CN.md)。当前公开快照未完成全新 Mac 的整套安装验收。

| 快捷键 | 操作 |
|---|---|
| `⌥D` | 翻译选中文字；可在设置中修改 |
| `⌥X` | 围绕选段提问 |
| `⌥⇧X` | 页面翻译或恢复 |
| `⌘,` | 设置 |
| `Enter` / `Shift+Enter` | 问答中发送 / 换行 |

## 数据与运行方式

**本机优先。** 英文词典为只读 SQLite。Apple 本机翻译使用系统语言资源。GPT 精译、解释、问答与 PDF 翻译会把相应提取文本发送至用户配置的 Codex 会话；PDF 排版在本机完成。

**保留原始文件。** PDF 翻译使用派生输出，完成译本按文件哈希、页范围和语言方向复用。原 PDF、文献身份与用户标注分别保留；精确词组匹配不足时，不把整句当作词级映射。

**控制后台任务。** 最多同时处理两篇文档，各自可取消。完成结果长期保留；临时任务目录采用独立容量与时限管理。

**明确范围。** 当前 PDF 流程面向有文字层的文档，扫描件与图片内文字需要其他 OCR 流程。复杂竖排图内文字、物理修饰键手势和各宿主版本的替换行为仍需对应环境的实际检查。

## 源码与验证

```text
Sources/AskGPT/          macOS 界面、窗口与阅读/写作控制
Sources/AskGPTCore/      翻译、词典、Codex、PDF 与文档核心
Sources/AskGPTTranslate/ 隔离翻译辅助程序
Integrations/Browser/   Chrome 扩展
Integrations/Zotero/    Zotero 插件
Integrations/Writing/   Word/WPS 加载项与测试
Integrations/PDFLayout/ PDF 引擎、锁文件与测试
Resources/              图标、本地词典与写作规则
Tests/                  Swift 核心测试
scripts/                构建、安装、打包与检查
```

核心检查可使用 `./scripts/test`；JavaScript 与 PDF 检查入口见[手册](docs/HANDBOOK.zh-CN.md)。[公开快照清单](docs/release-manifest.json)记录上传文件的 SHA-256，可用下列命令检查文件完整性及凭据排除规则：

```bash
python3 scripts/prepare-github-release --check .
```

公开包检查、界面渲染、算法测试与真实宿主操作分别记录。界面演示图不代表 Word 替换、Zotero 手势或新系统安装已通过端到端验收。

## 来源与反馈

本地词典源自固定提交的 [ECDICT](https://github.com/skywind3000/ECDICT/tree/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b)，保留 MIT 许可证及[构建来源](Resources/Dictionary/provenance.json)。PDF 集成使用 [BabelDOC 0.6.4](https://github.com/funstory-ai/BabelDOC/tree/v0.6.4)，保留 AGPL-3.0 许可、锁文件与集成源码。各组件许可见[来源声明](NOTICE.md)；本次上传未给一方代码新增统一许可。

欢迎提交 [Issue](https://github.com/Woyekun-cell/Ask-for-GPT/issues)，附 macOS、宿主和插件版本、复现步骤，以及不含私人内容的截图。
