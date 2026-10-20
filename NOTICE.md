# 来源与许可声明

本仓库公开 Ask for GPT 的一方源码、测试、资源和集成脚本。本次上传保留既有组件许可，未为一方代码新增统一许可；公开可见本身不构成额外的使用或再分发授权。

## ECDICT

`Resources/Dictionary/words.sqlite` 为 ECDICT 的选取与转换产物，保留中文释义、音标、明确词性及上游词形信息。

- 来源：https://github.com/skywind3000/ECDICT
- 固定提交：`bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b`
- 许可证：[MIT 原文](Resources/Dictionary/LICENSE)
- 生成脚本：[import-ecdict.py](scripts/import-ecdict.py)
- 来源、转换方式与 SHA-256：[provenance.json](Resources/Dictionary/provenance.json)

## PDF 依赖

PDF 适配使用 BabelDOC 0.6.4，运行时由用户根据锁文件安装；源码包不包含 Python 环境或上游模型、字体、CMap 下载内容。

- 来源：https://github.com/funstory-ai/BabelDOC/tree/v0.6.4
- 许可证：[AGPL-3.0 原文](Integrations/PDFLayout/LICENSE-BabelDOC-AGPL-3.0.txt)
- 绑定与适配信息：[UPSTREAM.json](Integrations/PDFLayout/UPSTREAM.json)
- 依赖锁：[requirements.lock](Integrations/PDFLayout/requirements.lock)
- PyMuPDF 等其他依赖遵循各自许可，参见其[官方许可说明](https://pymupdf.readthedocs.io/en/latest/about.html)。

一方代码的未指定许可状态不会覆盖第三方原有许可。修改和分发具体组件时，应按该组件附带的许可文本处理。

## 宿主与服务

macOS 系统框架、Chrome、Zotero、Microsoft Word、WPS 及 Codex/ChatGPT 分别属于其权利人。Office.js 从 Microsoft 官方 CDN 加载；本仓库未捆绑这些宿主软件或账号凭据。

## 演示图

界面图使用本项目编写的演示文本。来源和渲染范围见[界面图廊](docs/GALLERY.md)及[图像来源记录](docs/images/provenance.json)。公开包不包含用户研究 PDF、文献库、浏览器会话或阅读缓存。
