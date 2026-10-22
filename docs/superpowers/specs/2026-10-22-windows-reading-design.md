# Ask for GPT Windows 阅读版设计

日期：2026-10-22。状态：用户已批准继续实施；Windows 阅读预览版正在构建与验证，安装包状态以发行记录为准。

## 目标与已确认范围

用户希望提供 Windows 安装版，使用者下载后可以安装，无需自行编译。用户目前没有 Windows 测试电脑，已选择先开发阅读版：划词、离线词典、Zotero、Chrome、PDF 中英对照，以及可配置翻译后端。首版按 Windows 11 x64 开发，同时设定 Windows 10 22H2 x64 为兼容目标；Windows 10 的运行结果须单独验证，不能由 Windows Server 构建结果推定。

首版不包含 Word/WPS 写作辅助、macOS 原生 PDFKit 阅读窗口或 Apple 本机翻译。PDF 对照阅读在 Zotero 和 Chrome 中提供。现有 Mac 安装与已发布的 v1.0.85 保留，Windows 安装包使用独立的预览版本号和发行标签。

完成标准分开记录：Windows 编译通过、安装包生成、自动化验证、Windows 桌面实机验收。没有桌面实测时，只发布明确标注限制的预览版，不写“Windows 全功能实测通过”。

## 方案比较与选择

1. **Windows 原生桌面程序（采用）**：C#、WPF 和 .NET 10，复用既有词库、JavaScript 阅读集成和 Python 排版流程。优点是托盘、快捷键、Windows 选区和本地文件处理可以直接使用系统接口；代价是桌面视图与 Swift 业务胶水需要重新实现。
2. **Electron 桌面程序**：可以共享更多网页界面，但仍须处理 Windows 选区、权限和 Python 进程管理，同时新增一套 Chromium 运行环境。现有桌面视图并非网页，因此首版不能通过套壳直接复用。
3. **Tauri 桌面程序**：安装体积可能更小，但新增 Rust、前端与 WebView2 三处维护边界；当前项目尚无对应基础，首版收益不足以抵消迁移工作。

选择原生 Windows 外壳，并把服务、系统接口和界面分层。未来更换界面框架时，翻译协议和阅读集成不随之重写。

## 首版用户流程

### 安装与首次配置

- 提供按当前用户安装的 `.exe` 安装器和便携 `.zip`，不要求管理员权限，不修改系统 Python、全局 PATH 或现有 Zotero 数据。
- 安装包包含应用所需 .NET 运行环境、离线词典、Zotero 插件、Chrome 扩展、许可与中文指南。
- 启动进入简洁的连接与设置窗口：选择翻译后端、填写相应配置或可执行文件路径、查看连接状态、导出阅读集成。
- 需要 PDF 翻译时，提供“准备 PDF 组件”入口。下载固定版本的独立 Python、预编译依赖、字体和排版资源，逐项核对；不要求用户安装编译器。下载大小、保存位置、失败重试与清理方法在安装指南中说明。
- 用户自行完成 Codex/Claude 登录或填写 API 凭据。应用不代为创建账户、开通付费服务或上传个人配置。

### 划词与词典

- 默认选中文字后按 `Alt+D` 打开查词/翻译浮窗。英文单词先查随包离线词典，段落由当前配置的翻译后端处理。
- 优先通过 Windows UI Automation 读取前台选区。只有明确触发快捷键且原应用仍为同一前台窗口时，才允许受限的复制回退；读取完成后恢复原剪贴板，不能覆盖用户刚更新的内容。
- 不读取密码框；不假装可以读取其他权限级别应用的选区。取不到选区时提供粘贴输入，不要求用户以管理员权限运行整个应用。
- 可选自动划词默认关闭；用户主动开启后才安装必要的选区观察逻辑，并限制到短文本、前台应用和可取消的任务。不得后台扫描整篇文档。
- 浮窗支持选择/复制译文、继续提问、切换语言和取消。快捷键冲突应在设置里显示并允许修改，Chrome 已有的 `Alt+Shift+X` 页面快捷键不由桌面程序无条件抢占。

### Zotero、Chrome 与 PDF

- Zotero 沿用当前标签中的原文、译文、对照、联动/独立滚动、图表导航、阅读位置与标注流程；保留当前页/整篇、进度、停止、重试和缓存复用。首版不使用 macOS PDFKit 叠层。
- Chrome 复用 MV3 扩展与现有网页/PDF 阅读界面，接入同一本地服务。首次配对及本地 PDF 文件访问由用户按明确步骤完成。
- 源 PDF 不覆盖；原生标注的保存继续遵守 Zotero 附件与位置协议。机器译文生成、词句对应和标注就绪是不同状态，失败不能显示成已完成。
- 页面翻译按任务独立取消，切换标签后可以继续；退出应用时停止本次拥有的服务与子进程，不结束用户自己启动的 Codex、Python 或 Zotero。

### 翻译配置

- 首版保留 Codex CLI、OpenAI 兼容 API（包括 DeepSeek）和 Claude Code 三类入口。桌面短段、网页段落、PDF 正文和对应关系使用统一的后端抽象。
- 设置可以选择 JSON 配置文件，也可以填写该类型必需的路径/模型/端点；Windows 路径、空格和中文路径为正式输入，不套用 POSIX 路径校验。
- API 端点和模型由用户提供；不内置私人密钥。由应用保存的敏感值按当前用户保护，导出的配对文件不含 API 密钥；外部配置只读加载，不擅自改写。
- CLI 使用参数数组启动，避免命令拼接；限制请求大小、响应大小、超时和并发。取消与失败清理必须终止本任务的进程树。配置变化隔离翻译缓存。
- 本轮不消耗用户 API/Claude/Codex 额度做真实翻译测试；使用模拟提供方检查协议、超时、取消和缓存。安装指南明确联网能力需用户自行配置后确认。

## 模块与改动边界

| 路径/模块 | 职责 |
| --- | --- |
| `Platforms/Windows/AskGPT.Windows` | WPF 设置、托盘、划词浮窗、快捷键、前台选区和 Windows 系统接口 |
| `Platforms/Windows/AskGPT.Windows.Core` | 配置、词典查询、翻译提供方、本地服务协议、任务与缓存；可独立测试 |
| `Platforms/Windows/AskGPT.Translate` | PDF Python 引擎使用的 JSONL 翻译/对齐辅助进程，不载入桌面界面 |
| `Integrations/PDFLayout/platform_ops.py` 与受影响的 Python 调用点 | 文件锁、用户目录、受保护文件、子进程/管道、取消与退出的平台适配；Mac 分支保留原有行为 |
| `Integrations/Zotero` | 平台相关的配对文件位置、安装与错误提示；阅读逻辑按必要范围复用 |
| `Integrations/Browser` | 配对、可配置翻译服务及 Windows 操作提示；保留 MV3 权限边界 |
| `scripts/windows/`、Windows 构建工作流 | 独立运行环境准备、依赖锁、构建、检查与 NSIS 安装包 |
| `docs/INSTALL.Windows.zh-CN.md` 与发行说明 | 安装、配置、Zotero/Chrome 接入、预览版范围、校验与卸载 |

Windows 分支从已公开且干净的源码快照 `fe54555da226d5720074f98ce2f63a3779ce4ab6` 隔离开展。当前本机 Mac 的后续改动不整目录覆盖；若引入后续共享阅读修复，逐项核对差异、来源及测试后再合入。

现有 Swift/AppKit 主程序不改成同时支持两个平台；可复用的数据、协议和脚本通过明确入口共享。不会因 Windows 调整替换本机应用、重新签名 Mac 版或修改 Zotero 文库。

## 本地服务与数据

Windows 数据放在当前用户的 AppData 下。配对文件路径由各集成根据平台解析，不能继续硬编码 `~/Library/Application Support`。保留既有 `127.0.0.1:43792` 阅读服务和 `43795` PDF 服务协议，服务只监听回环地址；新桌面主服务采用嵌入式 .NET HTTP 服务，避免要求用户预留系统 HTTP 权限。

配对令牌由安全随机数生成。保持 Bearer、Host、Origin、端点、长度和请求超时限制。文件采用当前用户 ACL，并处理重解析点/替换风险；不能把 Unix 权限检查直接删掉当作兼容方案。日志保留任务编号和错误类型，不记录正文、密钥或完整服务响应。

PDF Python 端需适配 `fcntl`、`pwd/getuid`、`flock`、`O_NOFOLLOW`、`killpg`、管道 selector 及进程组。Windows 锁和进程管理采用对应系统机制；必须验证取消后不会遗留本任务的辅助进程，也不会误杀其他应用。

## 构建、验证与发布

1. 固定源码与依赖版本，建立 Windows 专属依赖锁与组件哈希；不把 Apple 平台的 Python 锁文件当成 Windows 已验证依赖。
2. 在公开仓库的标准 GitHub Windows runner 上构建自包含 x64 程序，运行核心、协议及 Windows 专项检查。不启用付费大型 runner 或注册外部构建服务。
3. 使用固定来源和版本的 NSIS 生成按用户安装器，并输出便携包、SHA-256 清单、源提交与组件许可。构建不携带真实配对令牌、密钥、文献或个人缓存。
4. 自动检查离线词典、中文/空格路径、错误配置、配对拒绝、请求限制、后台停止、模拟翻译、PDF 结果结构、缓存隔离和安装器文件清单。Windows runner 上的构建/进程检查不等于 Windows 10/11 桌面验收。
5. 为 Windows 使用独立预览发行标签。下载页分别写明已执行检查及尚未执行的桌面步骤；安装包签名状态据实说明，不购买签名、不自动绕过系统拦截。
6. 待具备 Windows 桌面后，补验安装/卸载、真实划词、快捷键冲突、多屏缩放、Zotero/Chrome 中英对照与标注保存、配置后的实际模型连接，再决定正式版状态。

GitHub 工作流默认只读仓库。构建产物数量、大小与保留期受限，不通过开启付费配额解决资源不足；发布下载资产由现有已授权的发布流程完成。

## 已核对的依据

### 项目证据

- `Package.swift:6` 仅声明 macOS；桌面窗口、选区和热键依赖 AppKit/AX/Carbon。
- `Sources/AskGPTCore/InlineTranslationBridge.swift:96` 使用 Apple 翻译引擎，Windows 需要可配置提供方替代。
- `Sources/AskGPTTranslate/AppMain.swift:6` 定义独立 JSONL 辅助进程协议，可由 Windows 程序实现。
- `Integrations/Zotero/content/inline.js:15` 写死 Mac 用户目录；需平台化。
- `Integrations/PDFLayout/server.py`、`worker.py` 存在 POSIX 文件/进程依赖；`install-runtime:17` 限制 Darwin，不能直接在 Windows 执行。

### 官方资料（2026-10-22 核对）

- [WPF 概览](https://learn.microsoft.com/en-us/dotnet/desktop/wpf/overview/)：WPF 运行于 Windows，支持原生桌面界面。
- [.NET 发布模式](https://learn.microsoft.com/en-us/dotnet/core/deploying/)：自包含发布可携带目标平台运行环境。
- [.NET 支持周期](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core)：选择当前活跃的 .NET 10 LTS，构建时锁定已发布补丁。
- [GitHub 标准托管 runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)：公开仓库的标准 runner 计算免费；产物存储仍需控制。
- [BabelDOC 上游](https://github.com/funstory-ai/BabelDOC)：保留原有 AGPL 许可及固定版本，Windows 依赖可安装性须在构建环境验证。
- [NSIS 许可](https://nsis.sourceforge.io/License)：安装器工具来源和组件许可纳入发布记录。
