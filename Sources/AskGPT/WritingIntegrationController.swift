import AppKit
import AskGPTCore

/// Owns writing-only resources and HTTPS lifecycle. Existing translation and chat stay independent.
@MainActor final class WritingIntegrationController {
    private let settingsProvider: () -> CodexSettings
    private var bridge: WritingBridge?
    private var startupTask: Task<Void, Never>?
    private var shuttingDown = false
    private(set) var status = "写作检查尚未启动。"
    private var resources: URL?
    private var nativeWord: NativeWordWritingController?

    init(settingsProvider: @escaping () -> CodexSettings) { self.settingsProvider = settingsProvider }

    func start() {
        guard startupTask == nil, bridge == nil, !shuttingDown else { return }
        do {
            guard #available(macOS 15.0, *) else { throw WritingBridgeError.requiresMacOS15 }
            guard let bundleResources = Bundle.main.resourceURL else { throw WritingBridgeError.missingResources }
            let resources = bundleResources.appendingPathComponent("Integrations/Writing", isDirectory: true)
            let skillDirectory = bundleResources.appendingPathComponent("Writing/skill", isDirectory: true)
            let skill: WritingSkill
            do { skill = try WritingSkill.load(from: skillDirectory) } catch { throw WritingBridgeError.missingResources }
            let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("AskGPTReader", isDirectory: true)
            let configuration = try WritingConnectionConfiguration.loadOrCreate(at: support.appendingPathComponent("Writing/connection.json"))
            let service = WritingService(settings: settingsProvider(), skill: skill)
            let documentBroker = NativeWritingDocumentBroker()
            let bridge = WritingBridge(configuration: configuration, resources: resources,
                tlsDirectory: support.appendingPathComponent("WritingTLS", isDirectory: true), skillVersion: skill.version,
                check: { try await service.check($0, mode: $1, profile: $2) },
                cancel: { await service.cancel(requestID: $0) }, documentBroker: documentBroker,
                shutdown: { await service.shutdown() })
            self.resources = resources; self.bridge = bridge
            status = "正在启动本机写作检查…"
            startupTask = Task { [weak self] in
                guard let self else { return }
                defer { startupTask = nil }
                do {
                    try await bridge.start()
                    guard !shuttingDown else { return }
                    nativeWord = NativeWordWritingController(broker: documentBroker, service: service)
                    nativeWord?.start()
                    status = "写作检查已就绪。"
                } catch {
                    await bridge.shutdown()
                    self.bridge = nil
                    status = (error as? WritingBridgeError)?.localizedDescription ?? "本机写作检查未能启动。"
                }
            }
        } catch {
            status = (error as? WritingBridgeError)?.localizedDescription ?? "写作检查设置未就绪。"
        }
    }

    func showSetup() {
        if bridge == nil { start() }
        let alert = NSAlert()
        alert.messageText = "Word / WPS 写作检查"
        alert.informativeText = status + "\n" + (nativeWord?.status ?? "在 Word 的“开始 → 加载项”打开 Ask GPT 写作助手。")
        alert.addButton(withTitle: "完成")
        if resources != nil { alert.addButton(withTitle: "查看加载项文件") }
        NSApp.activate(ignoringOtherApps: true)
        if alert.runModal() == .alertSecondButtonReturn, let resources {
            NSWorkspace.shared.activateFileViewerSelecting([resources])
        }
    }

    func shutdown() async {
        shuttingDown = true
        nativeWord?.shutdown(); nativeWord = nil
        startupTask?.cancel()
        if let bridge { await bridge.shutdown() }
        await startupTask?.value
        startupTask = nil; bridge = nil
    }
}
