import Darwin
import Foundation
import Network
import Security

public struct InlineConnectionConfiguration: Codable, Sendable {
    public static let port: UInt16 = 43792
    public static let baseEndpoint = "http://127.0.0.1:43792"
    public let version: Int
    public let endpoint: String
    public let token: String
    public let extensionID: String

    public init(extensionID: String) throws {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw InlineBridgeFailure.configuration
        }
        try self.init(token: bytes.map { String(format: "%02x", $0) }.joined(), extensionID: extensionID)
    }

    init(token: String, extensionID: String) throws {
        self.version = 1; self.endpoint = Self.baseEndpoint
        self.token = token; self.extensionID = extensionID
        try validate()
    }

    func validate() throws {
        guard version == 1, endpoint == Self.baseEndpoint,
              (32...256).contains(token.utf8.count), token.utf8.allSatisfy({ (33...126).contains($0) }),
              extensionID.utf8.count == 32, extensionID.utf8.allSatisfy({ (97...112).contains($0) }) else {
            throw InlineBridgeFailure.configuration
        }
    }

    public static func loadOrCreate(at url: URL, extensionID: String) throws -> Self {
        guard url.isFileURL else { throw InlineBridgeFailure.configuration }
        let manager = FileManager.default
        func load() throws -> Self {
            let attributes = try manager.attributesOfItem(atPath: url.path)
            guard attributes[.type] as? FileAttributeType == .typeRegular,
                  (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
                  let mode = (attributes[.posixPermissions] as? NSNumber)?.intValue, mode & 0o077 == 0,
                  let size = (attributes[.size] as? NSNumber)?.intValue, size <= 8_192 else {
                throw InlineBridgeFailure.configuration
            }
            let configuration = try JSONDecoder().decode(Self.self, from: Data(contentsOf: url))
            try configuration.validate()
            guard configuration.extensionID == extensionID else { throw InlineBridgeFailure.configuration }
            return configuration
        }
        do {
            if manager.fileExists(atPath: url.path) { return try load() }
            let configuration = try Self(extensionID: extensionID)
            try manager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700])
            let descriptor = Darwin.open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode_t(0o600))
            if descriptor < 0 {
                if errno == EEXIST { return try load() }
                throw InlineBridgeFailure.configuration
            }
            let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
            do {
                let data = try JSONEncoder().encode(configuration)
                try handle.write(contentsOf: data); try handle.synchronize(); try handle.close()
            } catch {
                try? handle.close(); try? manager.removeItem(at: url)
                throw InlineBridgeFailure.configuration
            }
            return configuration
        } catch { throw InlineBridgeFailure.configuration }
    }
}

/// Only the paired extension and privileged local clients can submit bounded
/// plain paragraphs. This listener is independent of the Easydict bridge.
public actor InlineTranslationBridge {
    typealias Translator = @Sendable (_ text: String, _ source: String, _ target: String) async throws -> String
    typealias TranslatorFactory = @Sendable () -> Translator
    private let configuration: InlineConnectionConfiguration
    private let port: UInt16
    private let readTimeout: Double
    private let translationTimeout: Double
    private let translatorFactory: TranslatorFactory
    private var translator: Translator
    private let queue = DispatchQueue(label: "AskGPT.inline.loopback", qos: .userInitiated)
    private var listener: NWListener?
    private var ready: InlineOnce<Void>?
    private var cancelled: InlineOnce<Void>?
    private var clients: [UUID: InlineSocket] = [:]
    private var tasks: [UUID: Task<Void, Never>] = [:]
    private var activeRequest: UUID?
    private var stopping = false

    public init(configuration: InlineConnectionConfiguration) {
        self.configuration = configuration; port = InlineConnectionConfiguration.port
        readTimeout = 10; translationTimeout = 3
        let factory = Self.nativeTranslatorFactory()
        translatorFactory = factory; translator = factory()
    }

    static func nativeTranslatorFactory(
        engineFactory: @escaping @Sendable () -> NativeTranslationEngine = { NativeTranslationEngine(quality: .fast) }
    ) -> TranslatorFactory {
        {
            let engine = engineFactory()
            return { text, source, target in
                try await engine.translate(text, sourceLanguage: source, targetLanguage: target).text
            }
        }
    }

    init(configuration: InlineConnectionConfiguration, port: UInt16, readTimeout: Double = 1,
         translationTimeout: Double = 1, translatorFactory: @escaping TranslatorFactory) {
        self.configuration = configuration; self.port = port
        self.readTimeout = max(0.01, readTimeout); self.translationTimeout = max(0.01, translationTimeout)
        self.translatorFactory = translatorFactory; translator = translatorFactory()
    }

    public func start() async throws {
        if stopping, listener != nil { throw InlineBridgeFailure.busy }
        if let ready { try await ready.value(); return }
        try configuration.validate()
        stopping = false
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = false
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(IPv4Address("127.0.0.1")!),
            port: NWEndpoint.Port(rawValue: port)!)
        let server = try NWListener(using: parameters)
        // NWListener's limit counts connections over the listener's lifetime.
        // Concurrent connections are bounded by clients in accept(_:).
        let ready = InlineOnce<Void>(), cancelled = InlineOnce<Void>()
        listener = server; self.ready = ready; self.cancelled = cancelled
        server.stateUpdateHandler = { state in
            switch state {
            case .ready: ready.finish(.success(()))
            case .failed: ready.finish(.failure(InlineBridgeFailure.listener))
            case .cancelled:
                cancelled.finish(.success(())); ready.finish(.failure(InlineBridgeFailure.listener))
            default: break
            }
        }
        server.newConnectionHandler = { [weak self] connection in Task { await self?.accept(connection) } }
        server.start(queue: queue)
        queue.asyncAfter(deadline: .now() + 5) {
            if ready.finish(.failure(InlineBridgeFailure.listener)) { server.cancel() }
        }
        do { try await ready.value() }
        catch { await stopListener(server, cancelled: cancelled); throw error }
    }

    public func shutdown() async {
        stopping = true
        let server = listener, cancelled = cancelled
        server?.cancel()
        let pending = Array(tasks.values)
        for task in pending { task.cancel() }
        for client in clients.values { client.cancel() }
        tasks.removeAll(); clients.removeAll()
        for task in pending { await task.value }
        if let server, let cancelled { await stopListener(server, cancelled: cancelled) }
    }

    private func stopListener(_ server: NWListener, cancelled: InlineOnce<Void>) async {
        server.cancel(); _ = try? await cancelled.value()
        if listener === server { listener = nil; ready = nil; self.cancelled = nil }
    }

    var listeningPort: UInt16? { listener?.port?.rawValue }

    func handleRequest(_ request: InlineHTTPRequest) async -> InlineHTTPResponse {
        var cors: [String: String] = [:]
        do {
            guard !stopping else { throw InlineBridgeFailure.busy }
            guard request.headers["host"] == "127.0.0.1:\(listeningPort ?? port)" else {
                throw InlineBridgeFailure(status: 403, code: "invalid_host", message: "仅接受固定本机地址。")
            }
            let origin = request.headers["origin"]
            let allowedOrigin = "chrome-extension://" + configuration.extensionID
            guard origin == nil || origin == allowedOrigin else {
                throw InlineBridgeFailure(status: 403, code: "invalid_origin", message: "请求来源未配对。")
            }
            if origin != nil { cors = ["Access-Control-Allow-Origin": allowedOrigin, "Vary": "Origin"] }
            let knownPath = ["/v1/inline/health", "/v1/inline/translate"].contains(request.path)
            if request.method == "OPTIONS" {
                guard origin == allowedOrigin, knownPath,
                      ["GET", "POST"].contains(request.headers["access-control-request-method"] ?? "") else {
                    throw InlineBridgeFailure(status: 403, code: "invalid_preflight", message: "不接受此预检请求。")
                }
                let requestedHeaders = (request.headers["access-control-request-headers"] ?? "")
                    .split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
                guard requestedHeaders.allSatisfy({ ["authorization", "content-type"].contains($0) }),
                      request.headers["access-control-request-private-network"].map({ $0 == "true" }) ?? true else {
                    throw InlineBridgeFailure.badRequest
                }
                cors["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
                cors["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
                cors["Access-Control-Allow-Private-Network"] = "true"
                return InlineHTTPResponse(status: 204, headers: cors, body: Data())
            }
            guard Self.authorized(request.headers["authorization"] ?? "", token: configuration.token) else {
                throw InlineBridgeFailure(status: 401, code: "unauthorized", message: "本机连接令牌不匹配。")
            }
            if request.method == "GET", request.path == "/v1/inline/health" {
                return .json(status: 200, headers: cors, object: ["status": "ready", "protocolVersion": 1])
            }
            guard request.method == "POST", request.path == "/v1/inline/translate" else {
                throw InlineBridgeFailure(status: 404, code: "not_found", message: "不存在此原位翻译接口。")
            }
            let type = request.headers["content-type"]?.split(separator: ";", maxSplits: 1).first?
                .trimmingCharacters(in: .whitespaces).lowercased()
            guard type == "application/json" else {
                throw InlineBridgeFailure(status: 415, code: "unsupported_media_type", message: "请求必须为 JSON。")
            }
            let paragraph = try Self.decode(request.body)
            guard activeRequest == nil else { throw InlineBridgeFailure.busy }
            let ticket = UUID(), translate = translator
            activeRequest = ticket
            defer { if activeRequest == ticket { activeRequest = nil } }
            do {
                let text = try await inlineDeadline(seconds: translationTimeout) {
                    try await translate(paragraph.text, paragraph.source, paragraph.target)
                }
                try Task.checkCancellation()
                guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    throw InlineBridgeFailure(status: 502, code: "empty_translation", message: "本机未返回译文。")
                }
                return .json(status: 200, headers: cors, object: ["id": paragraph.id, "translation": text])
            } catch {
                if error is CancellationError || (error as? InlineBridgeFailure)?.code == "translation_timeout" {
                    // Do not wait for an uncancellable framework/XPC operation. A
                    // new generation owns the next paragraph and its own cache.
                    if activeRequest == ticket { translator = translatorFactory() }
                }
                throw error
            }
        } catch let failure as InlineBridgeFailure { return .failure(failure, headers: cors) }
        catch is CancellationError { return .failure(.init(status: 499, code: "cancelled", message: "本段翻译已取消。"), headers: cors) }
        catch let failure as NativeTranslationError {
            return .failure(.init(status: 503, code: "native_unavailable", message: failure.localizedDescription), headers: cors)
        }
        catch { return .failure(.init(status: 502, code: "translation_failed", message: "本机翻译未完成。"), headers: cors) }
    }

    private struct Paragraph { let id: String; let text: String; let source: String; let target: String }
    private static func decode(_ data: Data) throws -> Paragraph {
        guard data.count <= InlineHTTPParser.maximumBodyBytes else { throw InlineBridgeFailure.tooLarge }
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == Set(["id", "text", "source", "target"]),
              let id = object["id"] as? String, !id.trimmingCharacters(in: .whitespaces).isEmpty,
              id.utf8.count <= 80, id.utf8.allSatisfy({ (32...126).contains($0) }),
              let text = object["text"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let source = object["source"] as? String, let target = object["target"] as? String,
              (source == "en" && target == "zh-Hans") || (source == "zh-Hans" && target == "en") else {
            throw InlineBridgeFailure.badRequest
        }
        guard text.unicodeScalars.count <= 1_800 else { throw InlineBridgeFailure.tooLarge }
        return Paragraph(id: id, text: text, source: source, target: target)
    }

    private static func authorized(_ supplied: String, token: String) -> Bool {
        let expected = Array(("Bearer " + token).utf8), actual = Array(supplied.utf8)
        var difference = UInt64(expected.count ^ actual.count)
        for index in 0..<263 {
            difference |= UInt64((index < expected.count ? expected[index] : 0) ^ (index < actual.count ? actual[index] : 0))
        }
        return difference == 0
    }

    private func accept(_ connection: NWConnection) {
        guard !stopping, clients.count < 16 else { connection.cancel(); return }
        let id = UUID(), client = InlineSocket(connection)
        clients[id] = client; connection.start(queue: queue)
        tasks[id] = Task { [weak self] in await self?.serve(client, id: id) }
    }

    private func serve(_ client: InlineSocket, id: UUID) async {
        defer { client.cancel(); clients.removeValue(forKey: id); tasks.removeValue(forKey: id) }
        var monitor: Task<Void, Never>?
        defer { monitor?.cancel() }
        do {
            var parser = InlineHTTPParser()
            let deadline = ProcessInfo.processInfo.systemUptime + readTimeout
            var request: InlineHTTPRequest?
            while request == nil {
                let remaining = deadline - ProcessInfo.processInfo.systemUptime
                guard remaining > 0 else { throw InlineBridgeFailure.readTimeout }
                let chunk = try await client.receive(timeout: remaining)
                request = try parser.append(chunk.data)
                if chunk.complete, request == nil { throw InlineBridgeFailure.badRequest }
            }
            monitor = Task { [weak self] in
                do {
                    let chunk = try await client.receive(timeout: (self?.translationTimeout ?? 3) + 5)
                    if chunk.complete || !chunk.data.isEmpty { await self?.cancelClient(id) }
                } catch { await self?.cancelClient(id) }
            }
            let response = await handleRequest(request!)
            try Task.checkCancellation()
            try await client.send(response.wireData, timeout: 5)
        } catch is CancellationError { }
        catch let failure as InlineBridgeFailure {
            if !Task.isCancelled { try? await client.send(InlineHTTPResponse.failure(failure).wireData, timeout: 1) }
        } catch { }
    }

    private func cancelClient(_ id: UUID) { tasks[id]?.cancel(); clients[id]?.cancel() }
}

struct InlineBridgeFailure: Error, LocalizedError, Sendable {
    let status: Int
    let code: String
    let message: String
    var errorDescription: String? { message }
    static let configuration = Self(status: 500, code: "invalid_configuration", message: "原位翻译连接配置无效；请重新配对。")
    static let listener = Self(status: 503, code: "listener_unavailable", message: "无法启动本机原位翻译端口。")
    static let badRequest = Self(status: 400, code: "invalid_request", message: "仅接受有界段落和指定的中英互译参数。")
    static let tooLarge = Self(status: 413, code: "payload_too_large", message: "段落或请求超过本机限制。")
    static let busy = Self(status: 503, code: "translation_busy", message: "本机正在翻译另一段，请重试。")
    static let readTimeout = Self(status: 408, code: "request_timeout", message: "读取本机请求超时。")
}

struct InlineHTTPRequest: Sendable { let method: String; let path: String; let headers: [String: String]; let body: Data }
struct InlineHTTPResponse: Sendable {
    let status: Int
    let headers: [String: String]
    let body: Data
    static func json(status: Int, headers: [String: String] = [:], object: [String: Any]) -> Self {
        Self(status: status, headers: headers, body: (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8))
    }
    static func failure(_ error: InlineBridgeFailure, headers: [String: String] = [:]) -> Self {
        .json(status: error.status, headers: headers, object: ["error": ["code": error.code, "message": error.message]])
    }
    var wireData: Data {
        let reason = [200: "OK", 204: "No Content", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 408: "Request Timeout", 411: "Length Required", 413: "Payload Too Large", 415: "Unsupported Media Type", 431: "Request Header Fields Too Large", 499: "Client Closed Request", 500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout"][status] ?? "Error"
        var head = "HTTP/1.1 \(status) \(reason)\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: \(body.count)\r\nConnection: close\r\nCache-Control: no-store\r\n"
        for key in headers.keys.sorted() { head += key + ": " + headers[key]! + "\r\n" }
        head += "\r\n"
        var data = Data(head.utf8); data.append(body); return data
    }
}

struct InlineHTTPParser {
    static let maximumBodyBytes = 16 * 1_024
    private static let maximumHeaderBytes = 16 * 1_024
    private var buffer = Data()
    private var header: (method: String, path: String, fields: [String: String], start: Int, length: Int)?
    mutating func append(_ data: Data) throws -> InlineHTTPRequest? {
        guard data.count <= Self.maximumHeaderBytes + Self.maximumBodyBytes + 4 - buffer.count else { throw InlineBridgeFailure.tooLarge }
        buffer.append(data)
        if header == nil {
            guard let separator = buffer.range(of: Data([13, 10, 13, 10])) else {
                guard buffer.count <= Self.maximumHeaderBytes else {
                    throw InlineBridgeFailure(status: 431, code: "headers_too_large", message: "请求头过长。")
                }
                return nil
            }
            guard separator.lowerBound <= Self.maximumHeaderBytes,
                  let text = String(data: buffer[..<separator.lowerBound], encoding: .utf8) else { throw InlineBridgeFailure.badRequest }
            let lines = text.components(separatedBy: "\r\n")
            let parts = lines[0].split(separator: " ", omittingEmptySubsequences: false)
            guard parts.count == 3, ["HTTP/1.0", "HTTP/1.1"].contains(String(parts[2])), parts[1].hasPrefix("/") else { throw InlineBridgeFailure.badRequest }
            var fields: [String: String] = [:]
            for line in lines.dropFirst() {
                guard let colon = line.firstIndex(of: ":"), !line.hasPrefix(" "), !line.hasPrefix("\t") else { throw InlineBridgeFailure.badRequest }
                let key = String(line[..<colon]).lowercased()
                guard !key.isEmpty, key.utf8.allSatisfy({ (97...122).contains($0) || (48...57).contains($0) || $0 == 45 }), fields[key] == nil else { throw InlineBridgeFailure.badRequest }
                let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
                guard value.utf8.allSatisfy({ $0 >= 32 || $0 == 9 }) else { throw InlineBridgeFailure.badRequest }
                fields[key] = value
            }
            guard fields["transfer-encoding"] == nil else { throw InlineBridgeFailure.badRequest }
            let length: Int
            if let raw = fields["content-length"] {
                guard !raw.isEmpty, raw.utf8.allSatisfy({ (48...57).contains($0) }), let count = Int(raw) else { throw InlineBridgeFailure.badRequest }
                length = count
            } else {
                guard parts[0] != "POST" else {
                    throw InlineBridgeFailure(status: 411, code: "length_required", message: "请求必须有正文长度。")
                }
                length = 0
            }
            guard length <= Self.maximumBodyBytes else { throw InlineBridgeFailure.tooLarge }
            header = (String(parts[0]), String(parts[1]), fields, separator.upperBound, length)
        }
        guard let header else { return nil }
        let expected = header.start + header.length
        guard buffer.count <= expected else { throw InlineBridgeFailure.badRequest }
        guard buffer.count == expected else { return nil }
        return InlineHTTPRequest(method: header.method, path: header.path, headers: header.fields, body: Data(buffer[header.start..<expected]))
    }
}

// Unstructured jobs are intentional: a deadline must not await an XPC call
// that ignores cancellation, unlike exiting a structured task group's scope.
private func inlineDeadline(seconds: Double, operation: @escaping @Sendable () async throws -> String) async throws -> String {
    let once = InlineOnce<String>()
    let job = Task {
        do { once.finish(.success(try await operation())) }
        catch { once.finish(.failure(error)) }
    }
    let timer = Task {
        do { try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) }
        catch { return }
        if once.finish(.failure(InlineBridgeFailure(status: 504, code: "translation_timeout", message: "本段本机翻译超时，请重试。"))) { job.cancel() }
    }
    return try await withTaskCancellationHandler {
        defer { timer.cancel(); job.cancel() }
        let result = try await once.value()
        try Task.checkCancellation()
        return result
    } onCancel: {
        job.cancel(); timer.cancel(); once.finish(.failure(CancellationError()))
    }
}

private final class InlineOnce<Value>: @unchecked Sendable {
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

private final class InlineSocket: @unchecked Sendable {
    struct Chunk: Sendable { let data: Data; let complete: Bool }
    private let connection: NWConnection
    private let lock = NSLock()
    private var pendingRead: InlineOnce<Chunk>?
    private var pendingWrite: InlineOnce<Void>?
    init(_ connection: NWConnection) { self.connection = connection }
    func receive(timeout: Double) async throws -> Chunk {
        let once = InlineOnce<Chunk>(); lock.withLock { pendingRead = once }
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { data, _, complete, error in
                if let error { once.finish(.failure(error)) }
                else { once.finish(.success(Chunk(data: data ?? Data(), complete: complete))) }
            }
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout) { [weak self] in
                if once.finish(.failure(InlineBridgeFailure.readTimeout)) { self?.connection.cancel() }
            }
            let value = try await once.value(); try Task.checkCancellation(); return value
        } onCancel: { self.cancel() }
    }
    func send(_ data: Data, timeout: Double) async throws {
        let once = InlineOnce<Void>(); lock.withLock { pendingWrite = once }
        try await withTaskCancellationHandler {
            try Task.checkCancellation()
            connection.send(content: data, completion: .contentProcessed { error in
                if let error { once.finish(.failure(error)) } else { once.finish(.success(())) }
            })
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout) { [weak self] in
                if once.finish(.failure(InlineBridgeFailure.readTimeout)) { self?.connection.cancel() }
            }
            try await once.value(); try Task.checkCancellation()
        } onCancel: { self.cancel() }
    }
    func cancel() {
        lock.lock(); let read = pendingRead, write = pendingWrite; lock.unlock()
        connection.cancel(); read?.finish(.failure(CancellationError())); write?.finish(.failure(CancellationError()))
    }
}
