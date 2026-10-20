import Darwin
import Foundation
import Network
import Security
import os

public enum WritingBridgeError: Error, LocalizedError, Sendable {
    case configuration, requiresMacOS15, missingResources, tls, listener, forbidden, unauthorized, badRequest, tooLarge, busy, timeout, cancelled, failed
    var status: Int {
        switch self {
        case .forbidden: return 403
        case .unauthorized: return 401
        case .badRequest: return 400
        case .tooLarge: return 413
        case .timeout: return 504
        case .cancelled: return 499
        case .failed: return 502
        default: return 503
        }
    }
    var code: String {
        switch self {
        case .configuration: return "invalid_configuration"
        case .requiresMacOS15: return "requires_macos_15"
        case .missingResources: return "missing_resources"
        case .tls: return "tls_unavailable"
        case .listener: return "listener_unavailable"
        case .forbidden: return "forbidden"
        case .unauthorized: return "unauthorized"
        case .badRequest: return "invalid_request"
        case .tooLarge: return "payload_too_large"
        case .busy: return "writing_busy"
        case .timeout: return "writing_timeout"
        case .cancelled: return "cancelled"
        case .failed: return "writing_failed"
        }
    }
    public var errorDescription: String? {
        switch self {
        case .requiresMacOS15: return "写作检查需要 macOS 15 或更新版本。"
        case .missingResources: return "写作检查资源不完整，请重新安装完整应用。"
        case .tls: return "本机写作证书未准备好，请完成独立 HTTPS 设置。"
        case .listener: return "本机写作端口无法启动，请检查 43793 端口。"
        case .tooLarge: return "文字过长，请缩小检查范围。"
        case .cancelled: return "写作检查已取消。"
        case .timeout: return "写作检查超时，请重试。"
        default: return "写作检查未完成，请重试。"
        }
    }
}

/// Kept only in the current user's private support directory. Never package it with an add-in.
public struct WritingConnectionConfiguration: Codable, Sendable {
    public static let port: UInt16 = 43793
    public static let endpoint = "https://localhost:43793"
    public let version: Int
    public let baseURL: String
    public let token: String
    init(token: String) throws {
        version = 1; baseURL = Self.endpoint; self.token = token
        try validate()
    }
    func validate() throws {
        guard version == 1, baseURL == Self.endpoint, token.utf8.count == 64,
              token.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else {
            throw WritingBridgeError.configuration
        }
    }
    public static func loadOrCreate(at url: URL) throws -> Self {
        guard url.isFileURL else { throw WritingBridgeError.configuration }
        do {
            try writingPrivateDirectory(url.deletingLastPathComponent())
            if FileManager.default.fileExists(atPath: url.path) || (try? url.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) == true {
                let value = try JSONDecoder().decode(Self.self, from: writingPrivateData(url, maximum: 8192))
                try value.validate(); return value
            }
            var bytes = [UInt8](repeating: 0, count: 32)
            guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw WritingBridgeError.configuration }
            let value = try Self(token: bytes.map { String(format: "%02x", $0) }.joined())
            let descriptor = Darwin.open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode_t(0o600))
            if descriptor < 0 {
                if errno == EEXIST { return try loadOrCreate(at: url) }
                throw WritingBridgeError.configuration
            }
            let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
            do {
                try handle.write(contentsOf: JSONEncoder().encode(value)); try handle.synchronize(); try handle.close()
            } catch {
                try? handle.close(); try? FileManager.default.removeItem(at: url); throw WritingBridgeError.configuration
            }
            return value
        } catch { throw WritingBridgeError.configuration }
    }
}

public struct WritingCheckPayload: Codable, Sendable {
    public let snapshot: WritingSnapshot
    public let mode: WritingCheckMode
    public let profile: WritingProfile
    public init(snapshot: WritingSnapshot, mode: WritingCheckMode, profile: WritingProfile) {
        self.snapshot = snapshot; self.mode = mode; self.profile = profile
    }
}

/// Separate HTTPS-only listener. Document jobs are bounded opaque-handle mailboxes;
/// host adapters perform their own fresh validation. No CORS relaxation or manuscript logging.
public actor WritingBridge {
    public typealias Check = @Sendable (WritingSnapshot, WritingCheckMode, WritingProfile) async throws -> WritingCheckResult
    public typealias Cancel = @Sendable (String) async -> Void
    private let configuration: WritingConnectionConfiguration
    private let resources: URL
    private let tlsDirectory: URL
    private let skillVersion: String
    private let port: UInt16
    private let check: Check
    private let cancel: Cancel
    private let documentBroker: NativeWritingDocumentBroker?
    private let diagnostic = Logger(subsystem: "local.askgpt.reader", category: "writing")
    private let documentDiagnostic = Logger(subsystem: "local.askgpt.reader", category: "writing-document")
    private let stopService: @Sendable () async -> Void
    private let queue = DispatchQueue(label: "AskGPT.writing.https", qos: .userInitiated)
    private var listener: NWListener?
    private var ready: WritingOnce<Void>?
    private var stopped: WritingOnce<Void>?
    private var clients: [UUID: WritingSocket] = [:]
    private var jobs: [UUID: Task<Void, Never>] = [:]
    private var stopping = false
    private var identity: SecIdentity?

    public init(configuration: WritingConnectionConfiguration, resources: URL, tlsDirectory: URL, skillVersion: String,
                port: UInt16 = WritingConnectionConfiguration.port, check: @escaping Check,
                cancel: @escaping Cancel = { _ in }, documentBroker: NativeWritingDocumentBroker? = nil,
                shutdown: @escaping @Sendable () async -> Void = {}) {
        self.configuration = configuration; self.resources = resources; self.tlsDirectory = tlsDirectory
        self.skillVersion = skillVersion; self.port = port; self.check = check; self.cancel = cancel; stopService = shutdown
        self.documentBroker = documentBroker
    }
    public var listeningPort: UInt16? { listener?.port?.rawValue }
    private var origin: String { "https://localhost:\(listeningPort ?? port)" }
    private var host: String { "localhost:\(listeningPort ?? port)" }

    public func start() async throws {
        if let ready { try await ready.value(); return }
        guard !stopping else { throw WritingBridgeError.busy }
        try configuration.validate()
        guard #available(macOS 15.0, *) else { throw WritingBridgeError.requiresMacOS15 }
        for path in ["shared/taskpane.html", "shared/taskpane.js", "shared/taskpane.css", "shared/writing-client.js", "shared/host-contract.js", "word/word-host.js", "word/native-document-service.js"] {
            guard staticFile("/" + path) != nil else { throw WritingBridgeError.missingResources }
        }
        let identity = try loadIdentity()
        let tls = NWProtocolTLS.Options()
        guard let localIdentity = sec_identity_create(identity) else { throw WritingBridgeError.tls }
        sec_protocol_options_set_local_identity(tls.securityProtocolOptions, localIdentity)
        sec_protocol_options_set_min_tls_protocol_version(tls.securityProtocolOptions, .TLSv12)
        let parameters = NWParameters(tls: tls, tcp: NWProtocolTCP.Options())
        parameters.allowLocalEndpointReuse = false
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(IPv4Address("127.0.0.1")!), port: NWEndpoint.Port(rawValue: port)!)
        let server: NWListener
        do { server = try NWListener(using: parameters) } catch { throw WritingBridgeError.listener }
        let ready = WritingOnce<Void>(), stopped = WritingOnce<Void>()
        self.identity = identity; listener = server; self.ready = ready; self.stopped = stopped
        server.stateUpdateHandler = { state in
            switch state {
            case .ready: ready.finish(.success(()))
            case .failed: ready.finish(.failure(WritingBridgeError.listener))
            case .cancelled: stopped.finish(.success(())); ready.finish(.failure(WritingBridgeError.listener))
            default: break
            }
        }
        server.newConnectionHandler = { [weak self] connection in Task { await self?.accept(connection) } }
        server.start(queue: queue)
        queue.asyncAfter(deadline: .now() + 5) { if ready.finish(.failure(WritingBridgeError.listener)) { server.cancel() } }
        do { try await ready.value() }
        catch { await stopListener(server, stopped: stopped); throw error }
    }

    public func shutdown() async {
        stopping = true
        let server = listener, stopped = stopped
        server?.cancel()
        let pending = Array(jobs.values)
        for task in pending { task.cancel() }
        for client in clients.values { client.cancel() }
        for task in pending { await task.value }
        jobs.removeAll(); clients.removeAll()
        if let server, let stopped { await stopListener(server, stopped: stopped) }
        await documentBroker?.shutdown()
        await stopService()
    }
    private func stopListener(_ server: NWListener, stopped: WritingOnce<Void>) async {
        server.cancel(); _ = try? await stopped.value()
        if listener === server { listener = nil; ready = nil; self.stopped = nil; identity = nil }
    }

    @available(macOS 15.0, *) private func loadIdentity() throws -> SecIdentity {
        do {
            try writingPrivateDirectory(tlsDirectory, create: false)
            let data = try writingPrivateData(tlsDirectory.appendingPathComponent("identity.p12"), maximum: 128 * 1024)
            let passwordData = try writingPrivateData(tlsDirectory.appendingPathComponent("password.txt"), maximum: 256)
            guard let password = String(data: passwordData, encoding: .ascii), !password.isEmpty else { throw WritingBridgeError.tls }
            var imported: CFArray?
            // macOS 15+: prevents implicit persistence in the user's default keychain.
            let options: [String: Any] = [kSecImportExportPassphrase as String: password, kSecImportToMemoryOnly as String: true]
            guard SecPKCS12Import(data as CFData, options as CFDictionary, &imported) == errSecSuccess,
                  let entry = (imported as? [[String: Any]])?.first,
                  let value = entry[kSecImportItemIdentity as String], CFGetTypeID(value as CFTypeRef) == SecIdentityGetTypeID() else {
                throw WritingBridgeError.tls
            }
            return value as! SecIdentity
        } catch { throw WritingBridgeError.tls }
    }

    /// Header validation is also called by the streaming parser, before it accepts any request body.
    private func authenticate(_ request: WritingHTTPRequest) throws {
        guard !stopping else { throw WritingBridgeError.busy }
        guard request.headers["host"] == host else { throw WritingBridgeError.forbidden }
        if let supplied = request.headers["origin"], supplied != origin { throw WritingBridgeError.forbidden }
        if let site = request.headers["sec-fetch-site"], !["same-origin", "none"].contains(site) { throw WritingBridgeError.forbidden }
        if request.path == "/v1/writing/bootstrap", request.method == "GET" {
            guard request.headers["origin"] == origin || request.headers["sec-fetch-site"] == "same-origin"
                    || request.headers["x-askgpt-writing"] == "1" else { throw WritingBridgeError.forbidden }
            return
        }
        if request.method == "GET", !request.path.hasPrefix("/v1/") { return }
        guard request.headers["origin"] == origin else { throw WritingBridgeError.forbidden }
        guard Self.authorized(request.headers["authorization"] ?? "", token: configuration.token) else { throw WritingBridgeError.unauthorized }
    }

    func handleRequest(_ request: WritingHTTPRequest) async -> WritingHTTPResponse {
        do {
            try authenticate(request)
            guard request.body.count <= WritingHTTPParser.maximumBodyBytes else { throw WritingBridgeError.tooLarge }
            if request.method == "GET", request.path == "/v1/writing/bootstrap" {
                return .json(["token": configuration.token, "baseURL": origin, "skillVersion": skillVersion])
            }
            if request.method == "GET", !request.path.hasPrefix("/v1/") {
                guard let (data, type) = staticFile(request.path) else { return .failure(.badRequest, status: 404) }
                return .init(status: 200, headers: ["Content-Type": type], body: data)
            }
            guard request.method == "POST", ["/v1/writing/check", "/v1/writing/cancel", "/v1/writing/document/register",
                "/v1/writing/document/exchange", "/v1/writing/document/close"].contains(request.path) else {
                return loggedFailure(.badRequest, requestPath: request.path, status: 404)
            }
            let type = request.headers["content-type"]?.split(separator: ";").first?.trimmingCharacters(in: .whitespaces).lowercased()
            guard type == "application/json" else { return loggedFailure(.badRequest, requestPath: request.path, status: 415) }
            if request.path.hasPrefix("/v1/writing/document/") { return try await handleDocumentRequest(request) }
            if request.path == "/v1/writing/cancel" {
                guard let object = try? JSONSerialization.jsonObject(with: request.body) as? [String: String],
                      Set(object.keys) == ["requestID"], let id = object["requestID"], Self.validID(id) else { throw WritingBridgeError.badRequest }
                await cancel(id)
                return .json(["requestID": id, "status": "cancelled"])
            }
            guard let object = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
                  Set(object.keys) == Set(["snapshot", "mode", "profile"]),
                  let payload = try? JSONDecoder().decode(WritingCheckPayload.self, from: request.body) else { throw WritingBridgeError.badRequest }
            try Self.validate(payload)
            let result = try await perform(payload)
            guard result.requestID == payload.snapshot.requestID, result.snapshotHash == payload.snapshot.snapshotHash,
                  result.skillVersion == (payload.mode == .spelling ? "local-1" : skillVersion) else { throw WritingBridgeError.failed }
            return .init(status: 200, headers: [:], body: try JSONEncoder().encode(result))
        } catch let error as WritingBridgeError { return loggedFailure(error, requestPath: request.path) }
        catch is CancellationError { return loggedFailure(.cancelled, requestPath: request.path) }
        catch let error as WritingServiceError {
            logFailure(.service(error), requestPath: request.path, status: WritingBridgeError.failed.status)
            return .failure(.failed)
        } catch let error as WritingValidationError {
            logFailure(.validation(error), requestPath: request.path, status: WritingBridgeError.failed.status)
            return .failure(.failed)
        } catch { return loggedFailure(.failed, requestPath: request.path) }
    }

    private func loggedFailure(_ error: WritingBridgeError, requestPath: String, status: Int? = nil) -> WritingHTTPResponse {
        logFailure(.bridge(error), requestPath: requestPath, status: status ?? error.status)
        return .failure(error, status: status)
    }

    /// Only fixed route labels, numeric status and exhaustively allowlisted codes
    /// reach unified logging. Never interpolate request content or Error descriptions.
    private func logFailure(_ failure: DiagnosticFailure, requestPath: String, status: Int) {
        logFailure(failure, route: DiagnosticRoute(requestPath), status: status)
    }
    private func logFailure(_ failure: DiagnosticFailure, route: DiagnosticRoute?, status: Int) {
        guard let route, !(200..<300).contains(status) else { return }
        diagnostic.error("route=\(route.rawValue, privacy: .public) http_status=\(status, privacy: .public) code=\(failure.code, privacy: .public)")
    }
    private enum DiagnosticRoute: String {
        case check, cancel, documentRegister = "document_register", documentExchange = "document_exchange", documentClose = "document_close"
        init?(_ path: String) {
            switch path {
            case "/v1/writing/check": self = .check
            case "/v1/writing/cancel": self = .cancel
            case "/v1/writing/document/register": self = .documentRegister
            case "/v1/writing/document/exchange": self = .documentExchange
            case "/v1/writing/document/close": self = .documentClose
            default: return nil
            }
        }
    }

    private enum DiagnosticFailure {
        case bridge(WritingBridgeError), service(WritingServiceError), validation(WritingValidationError)
        var code: String {
            switch self {
            case .bridge(let error): return error.code
            case .service(let error):
                switch error {
                case .invalidSnapshot: return "service_invalid_snapshot"
                case .inputTooLong: return "service_input_too_long"
                case .invalidProfile: return "service_invalid_profile"
                case .invalidModelOutput: return "service_invalid_model_output"
                case .unsupportedSkill: return "service_unsupported_skill"
                case .shutDown: return "service_shut_down"
                case .spellCheckingUnavailable: return "service_spell_checking_unavailable"
                case .spellCheckingTimeout: return "service_spell_checking_timeout"
                case .invalidSpellingResult: return "service_invalid_spelling_result"
                }
            case .validation(let error):
                switch error {
                case .emptyOriginal: return "validation_empty_original"
                case .unchangedSuggestion: return "validation_unchanged_suggestion"
                case .originalNotFound: return "validation_original_not_found"
                case .ambiguousAnchor: return "validation_ambiguous_anchor"
                case .invalidRange: return "validation_invalid_range"
                case .invalidGraphemeBoundary: return "validation_invalid_grapheme_boundary"
                case .outsideTargetRange: return "validation_outside_target_range"
                case .protectedRange: return "validation_protected_range"
                case .protectedTermChanged: return "validation_protected_term_changed"
                case .overlappingIssues: return "validation_overlapping_issues"
                case .snapshotHashMismatch: return "validation_snapshot_hash_mismatch"
                case .contextHashMismatch: return "validation_context_hash_mismatch"
                case .invalidCategory: return "validation_invalid_category"
                }
            }
        }
    }

    private func handleDocumentRequest(_ request: WritingHTTPRequest) async throws -> WritingHTTPResponse {
        guard let documentBroker else { throw WritingBridgeError.busy }
        guard let object = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any] else { throw WritingBridgeError.badRequest }
        let decoder = JSONDecoder(), encoder = JSONEncoder()
        do {
            switch request.path {
            case "/v1/writing/document/register":
                guard Set(object.keys) == ["version", "documentSessionID", "capabilities"] else { throw WritingBridgeError.badRequest }
                let value = try decoder.decode(NativeWritingDocumentRegistration.self, from: request.body)
                return .init(status: 200, headers: [:], body: try encoder.encode(await documentBroker.register(value)))
            case "/v1/writing/document/exchange":
                guard Set(object.keys).isSubset(of: ["version", "leaseID", "sequence", "state", "result"]),
                      Set(["version", "leaseID", "sequence"]).isSubset(of: object.keys) else { throw WritingBridgeError.badRequest }
                let value = try decoder.decode(NativeWritingDocumentExchange.self, from: request.body)
                return .init(status: 200, headers: [:], body: try encoder.encode(await documentBroker.exchange(value, waitForCommands: true)))
            case "/v1/writing/document/close":
                guard Set(object.keys) == ["version", "leaseID"] else { throw WritingBridgeError.badRequest }
                try await documentBroker.close(decoder.decode(NativeWritingDocumentClose.self, from: request.body))
                return .json(["status": "closed"])
            default: throw WritingBridgeError.badRequest
            }
        } catch is CancellationError { throw CancellationError() }
        catch let error as NativeWritingDocumentBrokerError {
            switch error {
            case .unavailable, .ambiguousActiveDocument, .busy: throw WritingBridgeError.busy
            case .invalidRequest, .stale: throw WritingBridgeError.badRequest
            }
        } catch let error as WritingBridgeError { throw error }
        catch { throw WritingBridgeError.badRequest }
    }

    private func perform(_ payload: WritingCheckPayload) async throws -> WritingCheckResult {
        let once = WritingOnce<WritingCheckResult>(), check = check, cancel = cancel, id = payload.snapshot.requestID
        let task = Task {
            do { once.finish(.success(try await check(payload.snapshot, payload.mode, payload.profile))) }
            catch { once.finish(.failure(error)) }
        }
        let timer = Task {
            do { try await Task.sleep(nanoseconds: 180_000_000_000) } catch { return }
            if once.finish(.failure(WritingBridgeError.timeout)) { task.cancel(); await cancel(id) }
        }
        return try await withTaskCancellationHandler {
            defer { timer.cancel(); task.cancel() }
            try Task.checkCancellation()
            let value = try await once.value(); try Task.checkCancellation(); return value
        } onCancel: {
            task.cancel(); timer.cancel(); once.finish(.failure(CancellationError()))
            Task { await cancel(id) }
        }
    }

    private static func validate(_ payload: WritingCheckPayload) throws {
        let snapshot = payload.snapshot, profile = payload.profile
        guard snapshot.rawText.utf16.count <= 4000,
              snapshot.contextBefore.utf16.count + snapshot.contextAfter.utf16.count <= 2000,
              profile.customTerms.count <= 128, profile.customTerms.allSatisfy({ $0.utf16.count <= 256 }),
              profile.customTerms.reduce(0, { $0 + $1.utf16.count }) <= 4096 else { throw WritingBridgeError.tooLarge }
        guard !snapshot.rawText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              [snapshot.requestID, snapshot.documentSessionID, snapshot.blockID, snapshot.revision].allSatisfy(validID),
              snapshot.snapshotHash == WritingSnapshot.hash(rawText: snapshot.rawText),
              snapshot.contextHash == WritingSnapshot.hash(contextBefore: snapshot.contextBefore, contextAfter: snapshot.contextAfter),
              snapshot.protectedRanges.count <= 512, snapshot.pageIndices.count <= 256,
              snapshot.pageIndices.allSatisfy({ $0 >= 0 }), ["en-US", "en-GB"].contains(profile.spellingVariant),
              ["minimal", "clarity"].contains(profile.style), profile.customTerms.allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else { throw WritingBridgeError.badRequest }
        var boundaries: Set<Int> = [0], length = 0
        for character in snapshot.rawText { length += String(character).utf16.count; boundaries.insert(length) }
        for range in [snapshot.targetRange] + snapshot.protectedRanges {
            guard range.start >= 0, range.length >= 0, let end = range.end, end <= length,
                  boundaries.contains(range.start), boundaries.contains(end) else { throw WritingBridgeError.badRequest }
        }
    }
    private static func validID(_ id: String) -> Bool {
        !id.isEmpty && id.utf8.count <= 256 && id.unicodeScalars.allSatisfy({ $0.value >= 32 && $0.value != 127 })
    }
    private static func authorized(_ supplied: String, token: String) -> Bool {
        let expected = Array(("Bearer " + token).utf8), actual = Array(supplied.utf8)
        var difference = expected.count ^ actual.count
        for index in 0..<263 { difference |= Int((index < expected.count ? expected[index] : 0) ^ (index < actual.count ? actual[index] : 0)) }
        return difference == 0
    }

    private func staticFile(_ path: String) -> (Data, String)? {
        let raw = String(path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)[0])
        guard raw.hasPrefix("/"), !raw.contains("%"), !raw.contains("\\"), !raw.contains("\0") else { return nil }
        let components = raw.dropFirst().split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard components.count >= 2, ["shared", "word", "wps"].contains(components[0]),
              components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && !$0.hasPrefix(".") }),
              let name = components.last, !name.contains("connection"), !name.contains("password") else { return nil }
        let mime = ["html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8", "css": "text/css; charset=utf-8", "png": "image/png", "svg": "image/svg+xml"]
        guard let type = mime[(name as NSString).pathExtension] else { return nil }
        let root = resources.standardizedFileURL.resolvingSymlinksInPath()
        var file = root
        for component in components {
            file.appendPathComponent(component)
            guard (try? file.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) == false else { return nil }
        }
        let resolved = file.standardizedFileURL.resolvingSymlinksInPath()
        guard resolved.path.hasPrefix(root.path + "/"),
              let attributes = try? FileManager.default.attributesOfItem(atPath: resolved.path),
              attributes[.type] as? FileAttributeType == .typeRegular,
              let size = attributes[.size] as? NSNumber, size.intValue <= 2 * 1024 * 1024,
              let data = try? Data(contentsOf: resolved) else { return nil }
        return (data, type)
    }

    private func accept(_ connection: NWConnection) {
        guard !stopping, clients.count < 16 else { connection.cancel(); return }
        let id = UUID(), client = WritingSocket(connection)
        clients[id] = client; connection.start(queue: queue)
        jobs[id] = Task { [weak self] in await self?.serve(client, id: id) }
    }
    private func serve(_ client: WritingSocket, id: UUID) async {
        defer { client.cancel(); clients.removeValue(forKey: id); jobs.removeValue(forKey: id) }
        var monitor: Task<Void, Never>?
        defer { monitor?.cancel() }
        var diagnosticRoute: DiagnosticRoute?
        var diagnosticResponseStatus = 0, socketSent = false, socketCancelled = false
        defer {
            if case .documentExchange? = diagnosticRoute {
                let outcome = NativeWritingDocumentDiagnostics.socketOutcome(sent: socketSent, cancelled: socketCancelled || Task.isCancelled)
                let status = NativeWritingDocumentDiagnostics.bounded(diagnosticResponseStatus, maximum: 599)
                documentDiagnostic.info("event=exchange_send http_status=\(status, privacy: .public) outcome=\(outcome.rawValue, privacy: .public)")
            }
        }
        do {
            var parser = WritingHTTPParser { [self] request in
                diagnosticRoute = DiagnosticRoute(request.path)
                try authenticate(request)
            }
            var request: WritingHTTPRequest?
            let deadline = ProcessInfo.processInfo.systemUptime + 10
            while request == nil {
                let remaining = deadline - ProcessInfo.processInfo.systemUptime
                guard remaining > 0 else { throw WritingBridgeError.timeout }
                let chunk = try await client.receive(timeout: remaining)
                request = try parser.append(chunk.data)
                if chunk.complete, request == nil { throw WritingBridgeError.badRequest }
            }
            monitor = Task { [weak self] in
                do {
                    let chunk = try await client.receive(timeout: 185)
                    if chunk.complete || !chunk.data.isEmpty { await self?.cancelClient(id) }
                } catch { await self?.cancelClient(id) }
            }
            let response = await handleRequest(request!)
            diagnosticResponseStatus = response.status
            try Task.checkCancellation()
            try await client.send(response.wireData, timeout: 5)
            socketSent = true
        } catch let failure as WritingBridgeError {
            diagnosticResponseStatus = failure.status
            if case .cancelled = failure { socketCancelled = true }
            logFailure(.bridge(failure), route: diagnosticRoute, status: failure.status)
            if !Task.isCancelled {
                if let _ = try? await client.send(WritingHTTPResponse.failure(failure).wireData, timeout: 1) { socketSent = true }
            }
        } catch { socketCancelled = error is CancellationError }
    }
    private func cancelClient(_ id: UUID) { jobs[id]?.cancel(); clients[id]?.cancel() }
}

struct WritingHTTPRequest: Sendable { let method: String; let path: String; let headers: [String: String]; let body: Data }
struct WritingHTTPResponse: Sendable {
    let status: Int
    let headers: [String: String]
    let body: Data
    init(status: Int, headers: [String: String], body: Data) {
        self.status = status; self.body = body
        var values = ["Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer", "Cross-Origin-Resource-Policy": "same-origin",
            "Content-Security-Policy": "default-src 'self'; script-src 'self' https://appsforoffice.microsoft.com; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'"]
        values.merge(headers) { _, supplied in supplied }; self.headers = values
    }
    static func json(_ object: [String: String]) -> Self { .init(status: 200, headers: [:], body: (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)) }
    static func failure(_ error: WritingBridgeError, status: Int? = nil) -> Self {
        let object = ["error": ["code": error.code, "message": error.localizedDescription]]
        return .init(status: status ?? error.status, headers: [:], body: (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8))
    }
    var wireData: Data {
        var head = "HTTP/1.1 \(status) \(status == 200 ? "OK" : "Error")\r\nContent-Length: \(body.count)\r\nConnection: close\r\n"
        for key in headers.keys.sorted() { head += key + ": " + headers[key]! + "\r\n" }
        head += "\r\n"
        var result = Data(head.utf8); result.append(body); return result
    }
}

struct WritingHTTPParser {
    static let maximumBodyBytes = 64 * 1024
    private var buffer = Data()
    private var parsed: (request: WritingHTTPRequest, start: Int, length: Int)?
    private let authenticate: (WritingHTTPRequest) throws -> Void
    init(authenticate: @escaping (WritingHTTPRequest) throws -> Void) { self.authenticate = authenticate }
    mutating func append(_ data: Data) throws -> WritingHTTPRequest? {
        guard data.count <= Self.maximumBodyBytes + 16 * 1024 + 4 - buffer.count else { throw WritingBridgeError.tooLarge }
        buffer.append(data)
        if parsed == nil {
            guard let separator = buffer.range(of: Data([13, 10, 13, 10])) else {
                guard buffer.count <= 16 * 1024 else { throw WritingBridgeError.tooLarge }; return nil
            }
            guard separator.lowerBound <= 16 * 1024, let head = String(data: buffer[..<separator.lowerBound], encoding: .utf8) else { throw WritingBridgeError.badRequest }
            let lines = head.components(separatedBy: "\r\n"), parts = lines[0].split(separator: " ", omittingEmptySubsequences: false)
            guard parts.count == 3, parts[2] == "HTTP/1.1", parts[1].hasPrefix("/"), !parts[1].contains("#") else { throw WritingBridgeError.badRequest }
            var fields: [String: String] = [:]
            for line in lines.dropFirst() {
                guard let colon = line.firstIndex(of: ":"), !line.hasPrefix(" "), !line.hasPrefix("\t") else { throw WritingBridgeError.badRequest }
                let key = String(line[..<colon]).lowercased(), value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
                guard !key.isEmpty, fields[key] == nil, key.utf8.allSatisfy({ (97...122).contains($0) || (48...57).contains($0) || $0 == 45 }),
                      value.utf8.allSatisfy({ $0 >= 32 && $0 != 127 }) else { throw WritingBridgeError.badRequest }
                fields[key] = value
            }
            let request = WritingHTTPRequest(method: String(parts[0]), path: String(parts[1]), headers: fields, body: Data())
            try authenticate(request)
            guard fields["transfer-encoding"] == nil else { throw WritingBridgeError.badRequest }
            let length: Int
            if let raw = fields["content-length"] {
                guard !raw.isEmpty, raw.utf8.allSatisfy({ (48...57).contains($0) }), let count = Int(raw) else { throw WritingBridgeError.badRequest }
                length = count
            } else { guard request.method != "POST" else { throw WritingBridgeError.badRequest }; length = 0 }
            guard length <= Self.maximumBodyBytes else { throw WritingBridgeError.tooLarge }
            parsed = (request, separator.upperBound, length)
        }
        guard let parsed else { return nil }
        let expected = parsed.start + parsed.length
        guard buffer.count <= expected else { throw WritingBridgeError.badRequest }
        guard buffer.count == expected else { return nil }
        return .init(method: parsed.request.method, path: parsed.request.path, headers: parsed.request.headers, body: Data(buffer[parsed.start..<expected]))
    }
}

private func writingPrivateDirectory(_ url: URL, create: Bool = true) throws {
    let manager = FileManager.default
    if !manager.fileExists(atPath: url.path), create {
        try manager.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    }
    let attributes = try manager.attributesOfItem(atPath: url.path)
    guard attributes[.type] as? FileAttributeType == .typeDirectory,
          (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
          let mode = attributes[.posixPermissions] as? NSNumber, mode.intValue & 0o077 == 0 else { throw WritingBridgeError.configuration }
}
private func writingPrivateData(_ url: URL, maximum: Int) throws -> Data {
    let descriptor = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    guard descriptor >= 0 else { throw WritingBridgeError.configuration }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    defer { try? handle.close() }
    var info = stat()
    guard fstat(descriptor, &info) == 0, info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
          info.st_uid == getuid(), info.st_mode & 0o077 == 0, info.st_size >= 0, info.st_size <= Int64(maximum) else { throw WritingBridgeError.configuration }
    return try handle.readToEnd() ?? Data()
}
private final class WritingOnce<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var result: Result<Value, Error>?
    private var continuations: [CheckedContinuation<Value, Error>] = []
    func value() async throws -> Value {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            if let result { lock.unlock(); continuation.resume(with: result) }
            else { continuations.append(continuation); lock.unlock() }
        }
    }
    @discardableResult func finish(_ result: Result<Value, Error>) -> Bool {
        lock.lock()
        guard self.result == nil else { lock.unlock(); return false }
        self.result = result; let pending = continuations; continuations.removeAll(); lock.unlock()
        for continuation in pending { continuation.resume(with: result) }
        return true
    }
}
private final class WritingSocket: @unchecked Sendable {
    struct Chunk: Sendable { let data: Data; let complete: Bool }
    private let connection: NWConnection
    private let lock = NSLock()
    private var read: WritingOnce<Chunk>?
    private var write: WritingOnce<Void>?
    init(_ connection: NWConnection) { self.connection = connection }
    func receive(timeout: Double) async throws -> Chunk {
        let once = WritingOnce<Chunk>(); lock.withLock { read = once }
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { data, _, complete, error in
                if let error { once.finish(.failure(error)) } else { once.finish(.success(.init(data: data ?? Data(), complete: complete))) }
            }
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout) { [weak self] in
                if once.finish(.failure(WritingBridgeError.timeout)) { self?.cancel() }
            }
            let value = try await once.value(); try Task.checkCancellation(); return value
        } onCancel: { self.cancel() }
    }
    func send(_ data: Data, timeout: Double) async throws {
        let once = WritingOnce<Void>(); lock.withLock { write = once }
        try await withTaskCancellationHandler {
            try Task.checkCancellation()
            connection.send(content: data, completion: .contentProcessed { error in
                if let error { once.finish(.failure(error)) } else { once.finish(.success(())) }
            })
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout) { [weak self] in
                if once.finish(.failure(WritingBridgeError.timeout)) { self?.cancel() }
            }
            try await once.value(); try Task.checkCancellation()
        } onCancel: { self.cancel() }
    }
    func cancel() {
        let pending = lock.withLock { (read, write) }
        connection.cancel(); pending.0?.finish(.failure(CancellationError())); pending.1?.finish(.failure(CancellationError()))
    }
}
