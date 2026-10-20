import AppKit
import SwiftUI
import AskGPTCore

/// The addons render inside the source application's page. This window only
/// explains their one-time setup; it never receives the source document.
@MainActor final class InlineIntegrationController: ObservableObject {
    @Published private(set) var status = "正在准备页面内翻译…"
    private var bridge: InlineTranslationBridge?
    private var startupTask: Task<Void, Never>?
    private var window: NSWindow?
    private var browserDirectory: URL?
    private var zoteroPackage: URL?
    private var shuttingDown = false
    private var configurationURL: URL?

    func start() {
        guard startupTask == nil, !shuttingDown else { return }
        if bridge != nil, let configurationURL {
            startupTask = Task { [weak self] in
                guard let self else { return }
                defer { startupTask = nil }
                await startPDFConnection(configurationURL: configurationURL)
            }
            return
        }
        do {
            let files = FileManager.default
            let support = files.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("AskGPTReader", isDirectory: true)
            guard let resources = Bundle.main.resourceURL?.appendingPathComponent("InlineIntegrations"),
                  let identity = try JSONSerialization.jsonObject(with: Data(contentsOf: resources.appendingPathComponent("identity.json"))) as? [String: Any],
                  let extensionID = identity["chromeExtensionID"] as? String else {
                throw InlineSetupError.missingResources
            }
            let configuration = try InlineConnectionConfiguration.loadOrCreate(
                at: support.appendingPathComponent("inline-connection.json"), extensionID: extensionID)
            let configurationURL = support.appendingPathComponent("inline-connection.json")
            self.configurationURL = configurationURL
            try exportBrowser(from: resources.appendingPathComponent("Browser"), to: support, configuration: configuration)
            let xpi = resources.appendingPathComponent("askgpt-inline-zotero.xpi")
            guard files.fileExists(atPath: xpi.path) else { throw InlineSetupError.missingResources }
            zoteroPackage = xpi
            let bridge = InlineTranslationBridge(configuration: configuration)
            self.bridge = bridge
            startupTask = Task { [weak self] in
                guard let self else { return }
                defer { startupTask = nil }
                do {
                    try await bridge.start()
                    guard !shuttingDown else { return }
                    status = "本机翻译已就绪"
                    // PDF work owns a separate helper process, so full-document
                    // translation does not queue behind or block selection translation.
                    await startPDFConnection(configurationURL: configurationURL)
                } catch {
                    self.bridge = nil
                    status = "本机翻译未就绪，请重新打开 Ask for GPT。"
                }
            }
        } catch {
            status = "页面内翻译资源未就绪，请重新安装完整应用。"
        }
    }

    private func startPDFConnection(configurationURL: URL) async {
        do {
            try await PDFLayoutService.shared.start(configurationURL: configurationURL)
            if shuttingDown { await PDFLayoutService.shared.shutdown() }
            else { status = "本机翻译已就绪" }
        } catch {
            if !shuttingDown { status = "网页翻译已就绪；PDF 保版组件未就绪，可重试连接。" }
        }
    }

    private func exportBrowser(from source: URL, to support: URL,
                               configuration: InlineConnectionConfiguration) throws {
        let files = FileManager.default
        let destination = support.appendingPathComponent("BrowserInline", isDirectory: true)
        try ensurePrivateDirectory(destination)
        guard let enumerator = files.enumerator(at: source, includingPropertiesForKeys: [.isRegularFileKey]) else {
            throw InlineSetupError.missingResources
        }
        var copiedManifest = false
        for case let file as URL in enumerator {
            guard try file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true else { continue }
            let relative = String(file.path.dropFirst(source.path.count + 1))
            guard relative != "connection.local.json", !relative.split(separator: "/").contains("..") else { continue }
            let target = destination.appendingPathComponent(relative)
            let parents = relative.split(separator: "/").dropLast()
            var parent = destination
            for component in parents {
                parent.appendPathComponent(String(component), isDirectory: true)
                try ensurePrivateDirectory(parent)
            }
            try Data(contentsOf: file).write(to: target, options: .atomic)
            try files.setAttributes([.posixPermissions: 0o600], ofItemAtPath: target.path)
            copiedManifest = copiedManifest || relative == "manifest.json"
        }
        guard copiedManifest else { throw InlineSetupError.missingResources }
        let connection = destination.appendingPathComponent("connection.local.json")
        try JSONEncoder().encode(configuration).write(to: connection, options: .atomic)
        try files.setAttributes([.posixPermissions: 0o600], ofItemAtPath: connection.path)
        browserDirectory = destination
    }

    private func ensurePrivateDirectory(_ url: URL) throws {
        let files = FileManager.default
        if files.fileExists(atPath: url.path) {
            let attributes = try files.attributesOfItem(atPath: url.path)
            guard attributes[.type] as? FileAttributeType == .typeDirectory,
                  (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid() else {
                throw InlineSetupError.unsafeDirectory
            }
        } else {
            try files.createDirectory(at: url, withIntermediateDirectories: false,
                                      attributes: [.posixPermissions: 0o700])
        }
        try files.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
    }

    func showSetup() {
        start()
        if window == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 450, height: 470),
                styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
            window.title = "页面内翻译"
            window.isReleasedWhenClosed = false
            window.isMovableByWindowBackground = true
            window.contentView = NSHostingView(rootView: InlineSetupView(controller: self))
            window.center()
            self.window = window
        }
        if window?.isMiniaturized == true { window?.deminiaturize(nil) }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    func revealBrowser() {
        if let browserDirectory { NSWorkspace.shared.activateFileViewerSelecting([browserDirectory]) }
    }

    func revealZotero() {
        if let zoteroPackage { NSWorkspace.shared.activateFileViewerSelecting([zoteroPackage]) }
    }

    func shutdown() async {
        shuttingDown = true
        startupTask?.cancel()
        if let bridge { await bridge.shutdown() }
        await PDFLayoutService.shared.shutdown()
        await startupTask?.value
        startupTask = nil
        bridge = nil
    }
}

private enum InlineSetupError: Error { case missingResources, unsafeDirectory }

private struct InlineSetupView: View {
    @ObservedObject var controller: InlineIntegrationController
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("在原页面里阅读译文").font(.system(size: 20, weight: .semibold))
            Text("网页逐段对照；PDF 保留版式，可切换译文、对照和原文。")
                .font(.system(size: 13)).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 8) {
                Text("Chrome 网页 / PDF").font(.headline)
                Text("加载本地扩展后，在当前标签按 ⌥⇧X。PDF 在同一标签切换译文与对照；本机 PDF 需在扩展详情允许文件网址访问。")
                    .font(.system(size: 12)).fixedSize(horizontal: false, vertical: true)
                Button("浏览器扩展目录", action: controller.revealBrowser)
            }
            VStack(alignment: .leading, spacing: 8) {
                Text("Zotero PDF").font(.headline)
                Text("从文件安装插件。在 PDF 标签内按 ⌥⇧X，默认翻译本页，可选择整份；随时切回原 PDF。")
                    .font(.system(size: 12)).fixedSize(horizontal: false, vertical: true)
                Button("Zotero 插件文件", action: controller.revealZotero)
            }
            Text("预览 / WPS：在 PDF 中按 ⌥⇧X，保版译本仍在原阅读器打开。菜单栏 PDF 可选整份、对照或恢复原文。")
                .font(.system(size: 12)).fixedSize(horizontal: false, vertical: true)
            Text(controller.status).font(.system(size: 11)).foregroundStyle(.secondary)
            Button("重试连接", action: controller.start)
        }.padding(20).frame(width: 450, alignment: .leading)
            .buttonStyle(GlassButtonStyle()).background { GlassBackdrop() }
    }
}
