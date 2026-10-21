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

PDF 适配使用 BabelDOC 0.6.4。macOS 安装包包含主程序、词典、插件和配置入口；PDF 的 Python 环境、模型、字体与 CMap 由配置入口从上游联网准备，未把作者本机运行环境或资源缓存打入安装包。配置入口只安装预编译依赖，并使用带哈希的锁文件。

- 来源：https://github.com/funstory-ai/BabelDOC/tree/v0.6.4
- 许可证：[AGPL-3.0 原文](Integrations/PDFLayout/LICENSE-BabelDOC-AGPL-3.0.txt)
- 绑定与适配信息：[UPSTREAM.json](Integrations/PDFLayout/UPSTREAM.json)
- 依赖锁：[requirements.lock](Integrations/PDFLayout/requirements.lock)
- PyMuPDF 等其他依赖遵循各自许可，参见其[官方许可说明](https://pymupdf.readthedocs.io/en/latest/about.html)。

一方代码的未指定许可状态不会覆盖第三方原有许可。修改和分发具体组件时，应按该组件附带的许可文本处理。

## 宿主与服务

macOS 系统框架、Chrome、Zotero、Microsoft Word、WPS 及 Codex/ChatGPT 分别属于其权利人。Office.js 从 Microsoft 官方 CDN 加载；安装包仅按下文原样附带公开 Codex CLI 工具；不包含其他宿主软件或账号凭据。

macOS 下载包原样附带 [OpenAI 官方 Codex 0.163.0 完整预编译包](https://github.com/openai/codex/releases/tag/rust-v0.163.0)，SHA-256 为 `b0344fc2e41f15e0071147e5869008047b8ff4bf2c4a8897975d3bae3f103b34`，保留其完整资源、第三方许可与来源记录，另附[Apache-2.0 许可证](Resources/Distribution/LICENSE-Codex-Apache-2.0.txt)及[上游 NOTICE](Resources/Distribution/NOTICE-Codex.txt)。配置脚本仅解压此公开发行物，不复制本机已登录目录。PDF 安装器从 [Astral 官方发行版](https://github.com/astral-sh/uv/releases/tag/0.12.23)下载 uv 0.12.23，执行前核对固定 SHA-256；uv、Python 与 PDF 依赖按其上游许可使用。

## 文档图片与论文来源

功能示意图使用本项目编写的演示文本。来源和渲染范围见[界面图廊](docs/GALLERY.md)、[主程序视图来源记录](docs/images/provenance.json)及[Zotero 阅读器演示来源](docs/demo-source/zotero/provenance.json)。Zotero 示意图由本机已安装的原生 Reader 资源与插件隔离渲染，侧栏使用 HTML 适配；演示脚本公开，Zotero 宿主资源不随本仓库分发。

两张真实 Zotero 对照截图展示 Liao 等的 [A draft human pangenome reference](https://doi.org/10.1038/s41586-023-05896-x)，Nature 617, 312–324（2023），© The Author(s) 2023，采用 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 许可。左侧为已发表的英文原文节选，右侧为 Ask for GPT 生成的中文机器翻译与排版改编；原作者及出版方未参与或认可该译文。许可依据见[官方 PMC 全文](https://pmc.ncbi.nlm.nih.gov/articles/PMC10172123/)，图片校验值与拍摄环境见[实机截图来源记录](docs/images/zotero/live-provenance.json)。

公开包不包含完整研究 PDF、文献库、浏览器会话、私人笔记或阅读缓存。
