# 界面图廊

[返回首页](../README.md) · [下载安装](INSTALL.macOS.zh-CN.md) · [Zotero 完整指南](ZOTERO.zh-CN.md) · [翻译后端配置](TRANSLATION-BACKENDS.zh-CN.md)

从遇到一个生词，到读完并标记整篇论文，Ask for GPT 把常用操作放在当前阅读环境中。下面按使用流程查看界面。

## 随手查词和翻译

![划词翻译与本地词典](images/translation.png)

选中一个词，按 `Option+D`。浮窗里可以查音标、词性和中文释义，也可以继续选择 GPT 精译、解释，或围绕这个选段提问。阅读短段时，方向、颜色和处理方式仍在同一处切换。

## 在 Zotero 里对照读一篇真实论文

![真实论文在 Zotero 中的英文原文与中文译文对照](images/zotero/live-bilingual-reading.jpg)

*从本机 Zotero 实际截取：Liao 等，[A draft human pangenome reference](https://doi.org/10.1038/s41586-023-05896-x)，Nature 617, 312–324（2023）。左侧为英文原文，右侧为 Ask for GPT 生成并重新排版的中文机器译文。论文采用 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 许可。*

右侧选择当前页或整篇、翻译方向和显示方式，然后开始翻译。页面仍留在原来的 Zotero 标签中，适合先处理摘要或方法页，确认需要细读后再继续全文。

## 原文、译文与对照

![译文视图与翻译进度](images/zotero/02-views.png)

用译文视图连续阅读，遇到需要核对的术语或公式，再切换原文或对照。后台处理多页时，进度显示在侧栏，原始页面仍可阅读。

## 从任意一侧核对词组

![双向词组选择和原生颜色浮层](images/zotero/03-selection.png)

在英文侧划选词语，可以查看中文对应；从中文侧划选，也可以回看英文表达。选区和语义单位结合，帮助核对专业词、动词搭配及修饰关系。

## 手动选择颜色，留下阅读记录

![蓝色标注在两侧显示](images/zotero/04-annotations.png)

原生八色浮层保留 Zotero 熟悉的操作。只划选时可以临时核对，点击颜色才保存。标注关联原 PDF，之后可在 Zotero 标注列表继续写评论、改色和定位。

## 调整两侧阅读位置

![实机对照阅读摘要与引言](images/zotero/live-abstract-detail.jpg)

*同一篇论文第 1 页（印刷页 312）的实机截图。切为 **独立**后手动调整两侧位置，把摘要或引言中的同一段留在眼前核读；机器译文的术语、数字和含义需要结合原文人工核对。*

![联动、独立与更多阅读工具](images/zotero/05-reading-tools.png)

连续阅读时让两侧联动；查阅其他段落时切为独立。需要重新对齐字号，可以在更多菜单同步大小，或使用缩小、适合宽度、放大。本页/整份、停止和重试也放在这里。

## 按图表标题跳转

![图表定位面板](images/zotero/06-navigation.png)

打开图表面板，按图题或表题查找位置。先选择左侧或右侧，再跳转；另一侧可以保留在当前段落，便于边看图表边读结果。

## 写作时查看一处修改

![Word 原生拼写建议卡](images/writing.png)

建议卡展示原文与拟替换内容。你可以替换、忽略或加入词典；处理正文前先看清修改。Word 和 WPS 的具体功能范围见安装手册。

## 设置模型与快捷键

![Ask for GPT 设置](images/settings.png)

Codex CLI 路径、提问模型、推理强度、可选翻译配置文件、自动划词和快捷键集中在同一张卡中。点击 **保存设置**保存修改，**测试 Codex**仅检查 Codex 连接。翻译配置文件留空使用默认路径；填写后可采用实验性的 API / Claude Code 接入，问答与写作继续使用 Codex。配置步骤和当前验证范围见[翻译后端指南](TRANSLATION-BACKENDS.zh-CN.md)。

## 图像来源

两张论文截图取自本机 Ask for GPT 1.0.89、Zotero 9.0.6 与插件 0.3.28 的阅读会话，均直接截取 Zotero 窗口，未裁剪或拼接。论文原文与许可可从 [Nature 出版页](https://www.nature.com/articles/s41586-023-05896-x)和[官方 PMC 全文](https://pmc.ncbi.nlm.nih.gov/articles/PMC10172123/)核对；中文译文由 Ask for GPT 生成，翻译与重新排版属于对原文的改编。[实机截图来源记录](images/zotero/live-provenance.json)列出截图环境、页面与文件校验值。

其余五张 Zotero 功能图在隔离环境中使用本机原生 Reader/PDFView 资源和插件渲染，侧栏有 XUL 到 HTML 的适配。双语文本、进度和词组对应由项目编写，用来说明操作；[演示图来源记录](demo-source/zotero/provenance.json)保留脚本、源码与图片哈希，复现入口为 `scripts/render-zotero-guide`。

主程序三图使用 SwiftUI/AppKit 视图与自有演示状态，[来源记录](images/provenance.json)保留渲染信息与文件校验值，复现入口为 `scripts/render-readme-previews`。实机截图记录上述环境下的当次阅读界面，演示图说明功能操作；v1.0.85 安装包的验证信息见[发行页](https://github.com/Woyekun-cell/Ask-for-GPT/releases/tag/v1.0.85)。

此前的[段落阅读演示](images/bilingual-reading.jpg)保留在仓库中，来源日期为 2026-10-16；当前首页改用上面的 Zotero 阅读器图介绍 PDF 功能。
