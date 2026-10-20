import Darwin
import Foundation

public enum PDFLayoutOutputMode: String, Sendable, Codable, CaseIterable {
    case mono, dual
}

public struct PDFLayoutJob: Sendable, Codable, Equatable {
    public enum State: String, Sendable, Codable { case running, complete, failed, cancelled }
    public let id: String
    public let state: State
    public let sourcePages: [Int]
    public let pageCount: Int
    public let error: String?

    public init(id: String, state: State, sourcePages: [Int], pageCount: Int, error: String? = nil) {
        self.id = id; self.state = state; self.sourcePages = sourcePages
        self.pageCount = pageCount; self.error = error
    }

    func validate() throws {
        guard !id.isEmpty, id.utf8.count <= 128,
              id.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95 }),
              (1...2_000).contains(pageCount), !sourcePages.isEmpty,
              sourcePages.count <= pageCount, Set(sourcePages).count == sourcePages.count,
              sourcePages.allSatisfy({ (0..<pageCount).contains($0) }) else {
            throw PDFLayoutServiceError.invalidResponse
        }
    }
}

public protocol PDFLayoutServing: Sendable {
    func createJob(data: Data, pages: [Int]?, source: String, target: String) async throws -> PDFLayoutJob
    func status(id: String) async throws -> PDFLayoutJob
    func output(id: String, mode: PDFLayoutOutputMode) async throws -> Data
    func cancel(id: String) async
}

public enum PDFLayoutServiceError: Error, LocalizedError, Sendable, Equatable {
    case configuration, runtimeMissing, resourcesMissing, startup, unavailable, invalidInput, invalidResponse
    case requestFailed(String)

    public var errorDescription: String? {
        switch self {
        case .configuration: return "保版翻译连接配置不可用，请重新打开应用。"
        case .runtimeMissing: return "保版翻译组件尚未安装完成。原 PDF 已保留。"
        case .resourcesMissing: return "保版翻译组件缺失，请重新安装完整应用。"
        case .startup: return "保版翻译服务未启动，原 PDF 已保留，可重试。"
        case .unavailable: return "保版翻译服务暂不可用，原 PDF 已保留。"
        case .invalidInput: return "PDF 或页码、语言参数无效。"
        case .invalidResponse: return "保版翻译返回无效结果，原 PDF 已保留。"
        case .requestFailed(let message): return message
        }
    }
}

struct PDFLayoutWorkerPaths: Sendable {
    let python: URL
    let script: URL
    let translator: URL
    let cache: URL
}

/// Owns a private, loopback-only worker. Source bytes and translations are never
/// included in process arguments or diagnostic output.
public actor PDFLayoutService: PDFLayoutServing {
    public static let shared = PDFLayoutService()
    public static let endpoint = URL(string: "http://127.0.0.1:43795")!
    private var process: Process?
    private var token: String?
    private var startTask: Task<Void, Error>?
    private var shutdownTask: Task<Void, Never>?
    private var serviceMonitor: Task<Void, Never>?
    private var lifecycleGeneration = UUID()
    private let session: URLSession
    private let endpointURL: URL
    private let workerPathsOverride: PDFLayoutWorkerPaths?

    public init() {
        endpointURL = Self.endpoint; workerPathsOverride = nil
        session = Self.makeSession()
    }

    init(endpoint: URL, workerPaths: PDFLayoutWorkerPaths) {
        endpointURL = endpoint; workerPathsOverride = workerPaths
        session = Self.makeSession()
    }

    private static func makeSession() -> URLSession {
        let settings = URLSessionConfiguration.ephemeral
        settings.timeoutIntervalForRequest = 30
        settings.timeoutIntervalForResource = 120
        settings.urlCache = nil
        settings.httpCookieStorage = nil
        settings.connectionProxyDictionary = [:]
        return URLSession(configuration: settings, delegate: PDFLayoutNoRedirects(), delegateQueue: nil)
    }

    public func start(configurationURL: URL) async throws {
        try Task.checkCancellation()
        if let shutdownTask { await shutdownTask.value }
        try Task.checkCancellation()
        if let startTask { return try await startTask.value }
        let task = Task {
            // The old server can close its listener before releasing its file
            // lock. A new app that reaches this interval has never observed
            // ready, so no handoff monitor exists yet. Retry this transient
            // first launch here; permanent configuration/resource errors pass
            // through immediately and cancellation still owns the cleanup.
            for attempt in 0..<8 {
                do {
                    try await self.startWorker(configurationURL: configurationURL)
                    return
                } catch let error as PDFLayoutServiceError where error == .startup || error == .unavailable {
                    guard attempt < 7 else { throw error }
                    try Task.checkCancellation()
                    try await Task.sleep(nanoseconds: 300_000_000)
                }
            }
        }
        startTask = task
        do { try await task.value; startTask = nil }
        catch { startTask = nil; throw error }
    }

    private func startWorker(configurationURL: URL) async throws {
        let files = FileManager.default
        guard configurationURL.isFileURL,
              let attributes = try? files.attributesOfItem(atPath: configurationURL.path),
              attributes[.type] as? FileAttributeType == .typeRegular,
              (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              let mode = (attributes[.posixPermissions] as? NSNumber)?.intValue, mode & 0o077 == 0,
              let size = (attributes[.size] as? NSNumber)?.intValue, size <= 8_192,
              let data = try? Data(contentsOf: configurationURL),
              let config = try? JSONDecoder().decode(InlineConnectionConfiguration.self, from: data) else {
            throw PDFLayoutServiceError.configuration
        }
        try config.validate()
        token = config.token
        let existingHealth = try? await health()
        if existingHealth == "ready" {
            monitorRetiringServer(configurationURL: configurationURL)
            return
        }
        if existingHealth == "runtime_missing" { throw PDFLayoutServiceError.runtimeMissing }
        let support = files.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("AskGPTReader/PDFLayout", isDirectory: true)
        let python = workerPathsOverride?.python ?? support.appendingPathComponent("runtime/bin/python3")
        guard files.isExecutableFile(atPath: python.path) else { throw PDFLayoutServiceError.runtimeMissing }
        guard let script = workerPathsOverride?.script ?? Bundle.main.resourceURL?.appendingPathComponent("PDFLayout/server.py"),
              let translator = workerPathsOverride?.translator ?? Bundle.main.executableURL?.deletingLastPathComponent().appendingPathComponent("AskGPTTranslate"),
              files.fileExists(atPath: script.path), files.isExecutableFile(atPath: translator.path) else {
            throw PDFLayoutServiceError.resourcesMissing
        }
        let cache = workerPathsOverride?.cache ?? support
        try files.createDirectory(at: cache, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try files.setAttributes([.posixPermissions: 0o700], ofItemAtPath: cache.path)
        let worker = Process()
        worker.executableURL = python
        worker.arguments = [script.path, "--config", configurationURL.path,
            "--translator", translator.path, "--cache-root", cache.path]
        worker.standardInput = FileHandle.nullDevice
        worker.standardOutput = FileHandle.nullDevice
        worker.standardError = FileHandle.nullDevice
        var environment = ProcessInfo.processInfo.environment
        environment["PYTHONUNBUFFERED"] = "1"
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
        worker.environment = environment
        do { try worker.run() } catch { throw PDFLayoutServiceError.startup }
        process = worker
        do {
            for _ in 0..<100 {
                try Task.checkCancellation()
                let state = try? await health()
                if state == "ready" {
                    guard worker.isRunning else { throw PDFLayoutServiceError.startup }
                    monitorRetiringServer(configurationURL: configurationURL)
                    return
                }
                if state == "runtime_missing" { throw PDFLayoutServiceError.runtimeMissing }
                guard worker.isRunning else { throw PDFLayoutServiceError.startup }
                try await Task.sleep(nanoseconds: 200_000_000)
            }
            throw PDFLayoutServiceError.startup
        } catch {
            await Self.stopWorkerAndWait(worker)
            if process === worker { process = nil }
            throw error
        }
    }

    public func createJob(data: Data, pages: [Int]?, source: String, target: String) async throws -> PDFLayoutJob {
        guard !data.isEmpty, data.count <= 150 * 1_024 * 1_024, data.starts(with: Data("%PDF-".utf8)),
              ["en", "zh-Hans"].contains(source), ["en", "zh-Hans"].contains(target), source != target,
              pages == nil || (!pages!.isEmpty && Set(pages!).count == pages!.count && pages!.allSatisfy({ (0..<2_000).contains($0) })) else {
            throw PDFLayoutServiceError.invalidInput
        }
        var request = try authenticatedRequest(path: "/v1/pdf/jobs", method: "POST")
        request.httpBody = data
        request.setValue("application/pdf", forHTTPHeaderField: "Content-Type")
        request.setValue(pages.map { $0.map { String($0 + 1) }.joined(separator: ",") } ?? "all", forHTTPHeaderField: "X-AskGPT-Pages")
        request.setValue(source, forHTTPHeaderField: "X-AskGPT-Source")
        request.setValue(target, forHTTPHeaderField: "X-AskGPT-Target")
        return try decodeJob(await send(request, acceptable: [202]))
    }

    public func status(id: String) async throws -> PDFLayoutJob {
        try validateID(id)
        return try decodeJob(await send(authenticatedRequest(path: "/v1/pdf/jobs/\(id)", method: "GET")))
    }

    public func output(id: String, mode: PDFLayoutOutputMode) async throws -> Data {
        try validateID(id)
        let bytes = try await send(authenticatedRequest(path: "/v1/pdf/jobs/\(id)/\(mode.rawValue).pdf", method: "GET"))
        guard bytes.count <= 450 * 1_024 * 1_024, bytes.starts(with: Data("%PDF-".utf8)) else {
            throw PDFLayoutServiceError.invalidResponse
        }
        return bytes
    }

    public func cancel(id: String) async {
        guard (try? validateID(id)) != nil,
              let request = try? authenticatedRequest(path: "/v1/pdf/jobs/\(id)", method: "DELETE") else { return }
        _ = try? await send(request, acceptable: [200, 202, 204, 404])
    }

    public func shutdown() async {
        if let shutdownTask { await shutdownTask.value; return }
        lifecycleGeneration = UUID()
        let retiringStart = startTask, retiringMonitor = serviceMonitor
        retiringStart?.cancel(); retiringMonitor?.cancel(); serviceMonitor = nil
        let task = Task {
            await retiringMonitor?.value
            _ = try? await retiringStart?.value
            if let worker = self.process {
                await Self.stopWorkerAndWait(worker)
                if self.process === worker { self.process = nil }
            }
            self.startTask = nil; self.token = nil
        }
        shutdownTask = task
        await task.value
        shutdownTask = nil
    }

    /// During an upgrade a healthy reply can still belong to the old app's
    /// server, which is about to exit. Follow that handoff without terminating
    /// a process this instance does not own; create our worker once it retires.
    private func monitorRetiringServer(configurationURL: URL) {
        guard serviceMonitor == nil else { return }
        let generation = lifecycleGeneration
        serviceMonitor = Task { [weak self] in
            await self?.monitorServer(configurationURL: configurationURL, generation: generation)
        }
    }

    private func monitorServer(configurationURL: URL, generation: UUID) async {
        while !Task.isCancelled {
            do { try await Task.sleep(nanoseconds: 200_000_000) } catch { break }
            guard generation == lifecycleGeneration else { break }
            if process?.isRunning == true { continue }
            if (try? await health()) == "ready" { continue }
            guard !Task.isCancelled, generation == lifecycleGeneration else { break }
            do { try await start(configurationURL: configurationURL) }
            catch is CancellationError { break }
            catch {
                do { try await Task.sleep(nanoseconds: 1_000_000_000) } catch { break }
            }
        }
        if generation == lifecycleGeneration { serviceMonitor = nil }
    }

    /// Process.terminate() only sends a signal. Wait off the actor so callers
    /// cannot start a replacement while the retiring server still holds its
    /// lock/port, and escalate only this instance's owned child if necessary.
    private static func stopWorkerAndWait(_ worker: Process) async {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .utility).async {
                if worker.isRunning {
                    worker.terminate()
                    let forceExit = DispatchWorkItem {
                        if worker.isRunning { _ = Darwin.kill(worker.processIdentifier, SIGKILL) }
                    }
                    DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 2, execute: forceExit)
                    worker.waitUntilExit()
                    forceExit.cancel()
                }
                continuation.resume()
            }
        }
    }

    private func health() async throws -> String {
        var request = try authenticatedRequest(path: "/v1/pdf/health", method: "GET")
        request.timeoutInterval = 1
        let data = try await send(request)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["protocolVersion"] as? Int == 1 else { throw PDFLayoutServiceError.invalidResponse }
        return object["status"] as? String ?? object["state"] as? String ?? ""
    }

    private func authenticatedRequest(path: String, method: String) throws -> URLRequest {
        guard let token else { throw PDFLayoutServiceError.unavailable }
        var request = URLRequest(url: endpointURL.appendingPathComponent(path))
        request.httpMethod = method
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }

    private func send(_ request: URLRequest, acceptable: [Int] = [200]) async throws -> Data {
        try Task.checkCancellation()
        let data: Data, response: URLResponse
        do { (data, response) = try await session.data(for: request) }
        catch is CancellationError { throw CancellationError() }
        catch { throw PDFLayoutServiceError.unavailable }
        try Task.checkCancellation()
        guard let http = response as? HTTPURLResponse, acceptable.contains(http.statusCode) else {
            throw PDFLayoutServiceError.unavailable
        }
        return data
    }

    private func decodeJob(_ data: Data) throws -> PDFLayoutJob {
        guard data.count <= 64_000, let value = try? JSONDecoder().decode(PDFLayoutJob.self, from: data) else {
            throw PDFLayoutServiceError.invalidResponse
        }
        try value.validate()
        return value
    }

    private func validateID(_ value: String) throws {
        guard !value.isEmpty, value.utf8.count <= 128,
              value.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95 }) else {
            throw PDFLayoutServiceError.invalidInput
        }
    }
}

private final class PDFLayoutNoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
