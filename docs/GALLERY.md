# 界面图廊

[返回首页](../README.md) · [下载安装](INSTALL.macOS.zh-CN.md) · [Zotero 完整指南](ZOTERO.zh-CN.md) · [翻译后端配置](TRANSLATION-BACKENDS.zh-CN.md)

从遇到一个生词，到读完并标记整篇论文，Ask for GPT 把常用操作放在当前阅读环境中。下面按使用流程查看界面。

## 在 Zotero 里双语读论文

![Zotero 双语阅读：英文原文与中文译文并排显示](images/zotero/live-bilingual-reading.jpg)

*Zotero 双语阅读 · Liao 等，[A draft human pangenome reference](https://doi.org/10.1038/s41586-023-05896-x)（Nature, 2023；[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)）。右侧为 Ask for GPT 生成的中文机器译文与排版。*

右侧选择当前页或整篇、翻译方向和显示方式，然后开始翻译。页面仍留在原来的 Zotero 标签中，适合先处理摘要或方法页，确认需要细读后再继续全文。

## 随手查词和翻译

![划词翻译与本地词典](images/translation.png)

选中一个词，按 `Option+D`。浮窗里可以查音标、词性和中文释义，也可以继续选择 GPT 精译、解释，或围绕这个选段提问。阅读短段时，方向、颜色和处理方式仍在同一处切换。

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

*独立滚动，对照查看摘要与正文。论文来源同上。*

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

双语阅读实机图取自 Liao 等的 [A draft human pangenome reference](https://doi.org/10.1038/s41586-023-05896-x)（Nature, 2023；[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)），中文译文与排版由 Ask for GPT 生成。原文和许可见[官方 PMC 全文](https://pmc.ncbi.nlm.nih.gov/articles/PMC10172123/)；截图环境见[实机图来源](images/zotero/live-provenance.json)。

其余功能图使用原生界面和项目自写阅读内容，展示对照阅读、划选、标注、图表导航与写作操作：[Zotero 演示图来源](demo-source/zotero/provenance.json) · [主程序图来源](images/provenance.json)。安装包和版本信息见[发行页](https://github.com/Woyekun-cell/Ask-for-GPT/releases/tag/v1.0.85)。
