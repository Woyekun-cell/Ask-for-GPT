# 界面图廊

[返回首页](../README.md) · [下载安装](INSTALL.macOS.zh-CN.md) · [Zotero 完整指南](ZOTERO.zh-CN.md) · [翻译后端配置](TRANSLATION-BACKENDS.zh-CN.md)

从遇到一个生词，到读完并标记整篇论文，Ask for GPT 把常用操作放在当前阅读环境中。下面按使用流程查看界面。

## 随手查词和翻译

![划词翻译与本地词典](images/translation.png)

选中一个词，按 `Option+D`。浮窗里可以查音标、词性和中文释义，也可以继续选择 GPT 精译、解释，或围绕这个选段提问。阅读短段时，方向、颜色和处理方式仍在同一处切换。

## 在 Zotero 里开始一页翻译

![Zotero 原生阅读器与 PDF 翻译侧栏](images/zotero/01-overview.png)

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

主程序三图使用当前 SwiftUI/AppKit 视图与自有演示状态；Zotero 六图使用本机原生 Reader/PDFView 资源和当前插件，在隔离环境中渲染，侧栏有 XUL 到 HTML 的适配。演示文档的双语文本、进度和词组对应由项目编写，用来说明界面操作。

[主程序图像来源](images/provenance.json)与[Zotero 图像来源](demo-source/zotero/provenance.json)记录脚本、源码与图片哈希；图中没有用户论文、私人文献库或对话。复现入口为 `scripts/render-readme-previews` 和 `scripts/render-zotero-guide`。模型译文、完整桌面宿主交互及新系统安装分别检查，不由演示图代替。

此前的[段落阅读演示](images/bilingual-reading.jpg)保留在仓库中，来源日期为 2026-10-16；当前首页改用上面的 Zotero 阅读器图介绍 PDF 功能。
