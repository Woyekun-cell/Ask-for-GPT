import Darwin
import Foundation
import AskGPTCore

/// A temporary CLI process, not a second registered .app. Compile against the built AskGPTCore objects.
@main struct WritingHost {
    static func main() async {
        var bridge: WritingBridge?
        do {
            let arguments = Array(CommandLine.arguments.dropFirst())
            func argument(_ name: String, fallback: URL) throws -> URL {
                guard let index = arguments.firstIndex(of: name) else { return fallback }
                guard index + 1 < arguments.count else { throw WritingBridgeError.configuration }
                return URL(fileURLWithPath: arguments[index + 1]).standardizedFileURL
            }
            let repository = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("AskGPTReader")
            let resources = try argument("--resources", fallback: repository.appendingPathComponent("Integrations/Writing"))
            let skill = try WritingSkill.load(from: argument("--skill", fallback: repository.appendingPathComponent("Resources/Writing/skill")))
            let tls = try argument("--tls", fallback: support.appendingPathComponent("WritingTLS"))
            let connection = try argument("--connection", fallback: support.appendingPathComponent("Writing/connection.json"))
            let configuration = try WritingConnectionConfiguration.loadOrCreate(at: connection)
            let service = WritingService(settings: CodexSettings(), skill: skill)
            let server = WritingBridge(configuration: configuration, resources: resources, tlsDirectory: tls, skillVersion: skill.version,
                check: { try await service.check($0, mode: $1, profile: $2) },
                cancel: { await service.cancel(requestID: $0) }, shutdown: { await service.shutdown() })
            bridge = server
            try await server.start()
            print("WRITING_HOST_READY https://localhost:43793 skill=\(skill.version)")
            fflush(stdout)
            signal(SIGINT, SIG_IGN); signal(SIGTERM, SIG_IGN)
            let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global())
            let terminate = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                let gate = HostSignalGate(continuation)
                interrupt.setEventHandler { gate.finish() }
                terminate.setEventHandler { gate.finish() }
                interrupt.resume(); terminate.resume()
            }
            interrupt.cancel(); terminate.cancel()
            await server.shutdown()
        } catch {
            if let bridge { await bridge.shutdown() }
            let message = (error as? WritingBridgeError)?.localizedDescription ?? "写作检查 helper 启动失败。"
            fputs("WRITING_HOST_FAILED: \(message)\n", stderr)
            exit(1)
        }
    }
}
private final class HostSignalGate: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Void, Never>?
    init(_ continuation: CheckedContinuation<Void, Never>) { self.continuation = continuation }
    func finish() {
        lock.lock(); let value = continuation; continuation = nil; lock.unlock()
        value?.resume()
    }
}
