import Foundation
import Network

public struct LocalBridgeConfiguration: Sendable {
    public let token: String
    public static let port: UInt16 = 43791
    public static let modelAlias = "apple-local"
    public var endpoint: URL { URL(string: "http://127.0.0.1:\(Self.port)/v1/chat/completions")! }
    public init(token: String) { self.token = token }
}

/// A private loopback adapter for Easydict's on-device translation. No GPT request is made here.
public actor LocalTranslationBridge {
    private let configuration: LocalBridgeConfiguration
    private let port: UInt16
    private let requestTimeout: Double
    private let answerTimeout: Double
    private let handler: @Sendable ([BridgeMessage]) async throws -> String
    private let queue = DispatchQueue(label: "AskGPT.translation.loopback", qos: .userInitiated)
    private var listener: NWListener?
    private var listenerReady: BridgeOnce<Void>?
    private var listenerCancelled: BridgeOnce<Void>?
    private var clients: [UUID: BridgeConnection] = [:]
    private var tasks: [UUID: Task<Void, Never>] = [:]
    private var activeRequest: UUID?
    private var shuttingDown = false

    public init(configuration: LocalBridgeConfiguration, translator: NativeTranslationEngine) {
        self.configuration = configuration
        port = LocalBridgeConfiguration.port
        requestTimeout = 10
        answerTimeout = 30
        handler = { messages in
            let excerpt = try Self.translationExcerpt(from: messages)
            return try await translator.translate(excerpt).text
        }
    }

    static func translationInput(from messages: [BridgeMessage]) throws -> String {
        let text = try translationExcerpt(from: messages)
        return String(decoding: try JSONEncoder().encode(["quoted_excerpt": text]), as: UTF8.self)
    }

    static func translationExcerpt(from messages: [BridgeMessage]) throws -> String {
        guard var text = messages.last(where: { $0.role == "user" })?.content else {
            throw BridgeHTTPFailure.badRequest
        }
        // Easy 2.22's built-in translation template. Language names contain no
        // quotes, colon or newline, so this match cannot consume the quoted body.
        let envelope = try NSRegularExpression(pattern: #"^Translate the following [^"\r\n:]+ text into [^"\r\n:]+ text: \x22{3}"#)
        if let match = envelope.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
           let prefix = Range(match.range, in: text) {
            guard text.hasSuffix("\"\"\""), text.distance(from: prefix.upperBound, to: text.endIndex) >= 3 else {
                throw BridgeHTTPFailure.badRequest
            }
            text = String(text[prefix.upperBound..<text.index(text.endIndex, offsetBy: -3)])
        }
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw BridgeHTTPFailure.badRequest
        }
        return text
    }

    // Inject only the translation boundary; HTTP parsing, authorization, deadlines and concurrency stay real.
    init(settings: CodexSettings, configuration: LocalBridgeConfiguration, port: UInt16,
         requestTimeout: Double = 10, answerTimeout: Double = 130,
         handler: @escaping @Sendable ([BridgeMessage]) async throws -> String) {
        self.configuration = configuration
        self.port = port
        self.requestTimeout = requestTimeout
        self.answerTimeout = answerTimeout
        self.handler = handler
    }

    public func start() async throws {
        if shuttingDown, listener != nil { throw BridgeHTTPFailure.busy }
        if let ready = listenerReady {
            try await ready.value()
            return
        }
        guard configuration.token.utf8.count >= 24, configuration.token.utf8.count <= 256,
              configuration.token.utf8.allSatisfy({ (33...126).contains($0) }) else {
            throw BridgeHTTPFailure(status: 500, code: "invalid_local_token", message: "本机转接令牌无效。")
        }
        shuttingDown = false
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = false
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(IPv4Address("127.0.0.1")!), port: NWEndpoint.Port(rawValue: port)!)
        let server = try NWListener(using: parameters)
        server.newConnectionLimit = 16
        listener = server
        let ready = BridgeOnce<Void>()
        listenerReady = ready
        let cancelled = BridgeOnce<Void>()
        listenerCancelled = cancelled
        server.stateUpdateHandler = { state in
            switch state {
            case .ready: ready.finish(.success(()))
            case .failed(let error):
                let category: String
                switch error {
                case .posix(let code): category = "POSIX " + String(code.rawValue)
                case .dns(let code): category = "DNS " + String(code)
                case .tls(let code): category = "TLS " + String(code)
                default: category = "network"
                }
                ready.finish(.failure(BridgeHTTPFailure(status: 503, code: "listener_unavailable", message: "无法启动本机翻译转接（\(category)）；请检查本机监听权限和端口占用。")))
            case .cancelled:
                cancelled.finish(.success(()))
                ready.finish(.failure(BridgeHTTPFailure(status: 503, code: "listener_unavailable", message: "无法启动本机翻译转接；请确认端口未被占用。")))
            default: break
            }
        }
        server.newConnectionHandler = { [weak self] connection in
            Task { await self?.accept(connection) }
        }
        server.start(queue: queue)
        queue.asyncAfter(deadline: .now() + 5) {
            if ready.finish(.failure(BridgeHTTPFailure(status: 503, code: "listener_timeout", message: "本机翻译转接启动超时。"))) { server.cancel() }
        }
        do { try await ready.value() }
        catch {
            await stopListener(server, cancelled: cancelled)
            throw error
        }
    }

    public func shutdown() async {
        shuttingDown = true
        let server = listener, cancelled = listenerCancelled
        server?.cancel()
        let pending = Array(tasks.values)
        for task in pending { task.cancel() }
        for client in clients.values { client.cancel() }
        tasks.removeAll(); clients.removeAll()
        for task in pending { await task.value }
        if let server, let cancelled { await stopListener(server, cancelled: cancelled) }
        if listener == nil { activeRequest = nil }
    }

    private func stopListener(_ server: NWListener, cancelled: BridgeOnce<Void>) async {
        server.cancel()
        // The ready result is already consumed; cancellation needs its own completion barrier.
        // NWListener reports .cancelled only after its listening socket is released.
        _ = try? await cancelled.value()
        if listener === server { listener = nil; listenerReady = nil; listenerCancelled = nil }
    }

    // Used by the socket path and deterministic tests. Never exposes an upstream error's prompt/body.
    func handleRequest(_ request: BridgeHTTPRequest) async -> BridgeHTTPResponse {
        do {
            guard !shuttingDown else { throw BridgeHTTPFailure.busy }
            guard request.headers["origin"] == nil else {
                throw BridgeHTTPFailure(status: 403, code: "browser_request_rejected", message: "此本机接口不接受浏览器请求。")
            }
            guard Self.constantTimeAuthorization(request.headers["authorization"] ?? "", token: configuration.token) else {
                throw BridgeHTTPFailure(status: 401, code: "invalid_api_key", message: "本机转接令牌不匹配。")
            }
            if request.method == "GET", request.path == "/v1/models" {
                return .json(status: 200, object: ["object": "list", "data": [["id": LocalBridgeConfiguration.modelAlias,
                    "object": "model", "created": 0, "owned_by": "apple-on-device"]]])
            }
            guard request.method == "POST", request.path == "/v1/chat/completions" else {
                throw BridgeHTTPFailure(status: 404, code: "not_found", message: "不存在此本机接口。")
            }
            let type = request.headers["content-type"]?.split(separator: ";", maxSplits: 1).first?
                .trimmingCharacters(in: .whitespaces).lowercased()
            guard type == "application/json" else {
                throw BridgeHTTPFailure(status: 415, code: "unsupported_media_type", message: "请求必须使用 application/json。")
            }
            let messages = try Self.decodeMessages(request.body)
            guard activeRequest == nil else { throw BridgeHTTPFailure.busy }
            let requestID = UUID()
            activeRequest = requestID
            defer { if activeRequest == requestID { activeRequest = nil } }
            let translate = handler
            let text = try await bridgeWithTimeout(seconds: answerTimeout) { try await translate(messages) }
            try Task.checkCancellation()
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw BridgeHTTPFailure(status: 502, code: "empty_translation", message: "本机引擎未返回译文。")
            }
            return .json(status: 200, object: ["id": "chatcmpl-" + UUID().uuidString,
                "object": "chat.completion", "created": Int(Date().timeIntervalSince1970),
                "model": LocalBridgeConfiguration.modelAlias,
                "choices": [["index": 0, "message": ["role": "assistant", "content": text], "finish_reason": "stop"]]])
        } catch let error as BridgeHTTPFailure { return .failure(error) }
        catch is CancellationError { return .failure(.init(status: 499, code: "request_cancelled", message: "翻译请求已取消。")) }
        catch let error as NativeTranslationError {
            return .failure(.init(status: 503, code: "native_translation_unavailable", message: error.localizedDescription))
        }
        catch { return .failure(.init(status: 502, code: "native_translation_failed", message: "本机翻译未完成，请检查已安装的翻译语言。")) }
    }

    private func accept(_ connection: NWConnection) {
        guard !shuttingDown, clients.count < 16 else { connection.cancel(); return }
        let id = UUID()
        let client = BridgeConnection(connection)
        clients[id] = client
        connection.start(queue: queue)
        tasks[id] = Task { [weak self] in await self?.serve(client, id: id) }
    }

    private func serve(_ client: BridgeConnection, id: UUID) async {
        defer { client.cancel(); clients.removeValue(forKey: id); tasks.removeValue(forKey: id) }
        var monitor: Task<Void, Never>?
        defer { monitor?.cancel() }
        do {
            var parser = BridgeHTTPRequestParser()
            let deadline = ProcessInfo.processInfo.systemUptime + requestTimeout
            var request: BridgeHTTPRequest?
            while request == nil {
                let remaining = deadline - ProcessInfo.processInfo.systemUptime
                guard remaining > 0 else { throw BridgeHTTPFailure.requestTimeout }
                let chunk = try await client.receive(timeout: remaining)
                request = try parser.append(chunk.data)
                if chunk.complete, request == nil { throw BridgeHTTPFailure.badRequest }
            }
            // Receiving EOF/reset cancels this translation request.
            monitor = Task { [weak self] in
                do {
                    let chunk = try await client.receive(timeout: (self?.answerTimeout ?? 130) + 5)
                    if chunk.complete || !chunk.data.isEmpty { await self?.cancelClient(id) }
                } catch { await self?.cancelClient(id) }
            }
            let response = await handleRequest(request!)
            try Task.checkCancellation()
            try await client.send(response.wireData, timeout: 5)
        } catch is CancellationError { }
        catch let error as BridgeHTTPFailure { if !Task.isCancelled { try? await client.send(BridgeHTTPResponse.failure(error).wireData, timeout: 2) } }
        catch { }
    }

    private func cancelClient(_ id: UUID) { tasks[id]?.cancel(); clients[id]?.cancel() }
    var listeningPort: UInt16? { listener?.port?.rawValue }

    private static func constantTimeAuthorization(_ supplied: String, token: String) -> Bool {
        let expected = Array(("Bearer " + token).utf8), actual = Array(supplied.utf8)
        // A fixed upper bound prevents early return on either a differing byte or length.
        var difference = UInt64(expected.count ^ actual.count)
        for index in 0..<263 {
            let lhs: UInt8 = index < expected.count ? expected[index] : 0
            let rhs: UInt8 = index < actual.count ? actual[index] : 0
            difference |= UInt64(lhs ^ rhs)
        }
        return difference == 0
    }

    private static func decodeMessages(_ body: Data) throws -> [BridgeMessage] {
        guard body.count <= BridgeHTTPRequestParser.maximumBodyBytes else {
            throw BridgeHTTPFailure(status: 413, code: "payload_too_large", message: "请求正文超过 128 KiB。")
        }
        guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              object["model"] as? String == LocalBridgeConfiguration.modelAlias,
              let raw = object["messages"] as? [[String: Any]], !raw.isEmpty, raw.count <= 32 else { throw BridgeHTTPFailure.badRequest }
        if let stream = object["stream"] {
            guard let value = stream as? Bool, !value else {
                throw BridgeHTTPFailure(status: 400, code: "streaming_not_supported", message: "本机翻译转接暂不支持 stream=true；请关闭流式响应。")
            }
        }
        guard ["tools", "tool_choice", "functions", "function_call"].allSatisfy({ object[$0] == nil }) else { throw BridgeHTTPFailure.badRequest }
        var messages: [BridgeMessage] = []
        var total = 0
        for message in raw {
            guard let role = message["role"] as? String, ["system", "user", "assistant"].contains(role),
                  let content = message["content"] as? String, content.utf8.count <= 32768 else { throw BridgeHTTPFailure.badRequest }
            total += content.utf8.count
            guard total <= BridgeHTTPRequestParser.maximumBodyBytes else { throw BridgeHTTPFailure.badRequest }
            messages.append(BridgeMessage(role: role, content: content))
        }
        guard let user = messages.last(where: { $0.role == "user" }), !user.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw BridgeHTTPFailure.badRequest }
        return messages
    }
}

struct BridgeMessage: Codable, Sendable { let role: String; let content: String }
struct BridgeHTTPRequest: Sendable { let method: String; let path: String; let headers: [String: String]; let body: Data }
struct BridgeHTTPFailure: Error, LocalizedError, Sendable {
    let status: Int
    let code: String
    let message: String
    var errorDescription: String? { message }
    static let badRequest = Self(status: 400, code: "invalid_request_error", message: "仅接受 apple-local 的有界纯文字消息。")
    static let busy = Self(status: 503, code: "translation_busy", message: "上一条翻译尚未结束，请稍后重试。")
    static let requestTimeout = Self(status: 408, code: "request_timeout", message: "读取翻译请求超时。")
}

struct BridgeHTTPResponse: Sendable {
    let status: Int
    let body: Data
    static func json(status: Int, object: [String: Any]) -> Self {
        Self(status: status, body: (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8))
    }
    static func failure(_ error: BridgeHTTPFailure) -> Self {
        .json(status: error.status, object: ["error": ["message": error.message, "type": "invalid_request_error", "param": NSNull(), "code": error.code]])
    }
    var wireData: Data {
        let reasons = [200: "OK", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 408: "Request Timeout", 411: "Length Required", 413: "Payload Too Large", 415: "Unsupported Media Type", 431: "Request Header Fields Too Large", 499: "Client Closed Request", 500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout"]
        var data = Data("HTTP/1.1 \(status) \(reasons[status] ?? "Error")\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: \(body.count)\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n".utf8)
        data.append(body)
        return data
    }
}

struct BridgeHTTPRequestParser {
    static let maximumBodyBytes = 128 * 1024
    private static let maximumHeaderBytes = 16 * 1024
    private var buffer = Data()
    private var header: (method: String, path: String, headers: [String: String], bodyStart: Int, bodyLength: Int)?
    mutating func append(_ data: Data) throws -> BridgeHTTPRequest? {
        buffer.append(data)
        if header == nil {
            guard let separator = buffer.range(of: Data([13, 10, 13, 10])) else {
                guard buffer.count <= Self.maximumHeaderBytes else { throw BridgeHTTPFailure(status: 431, code: "headers_too_large", message: "请求头过长。") }
                return nil
            }
            guard separator.lowerBound <= Self.maximumHeaderBytes,
                  let text = String(data: buffer[..<separator.lowerBound], encoding: .utf8) else { throw BridgeHTTPFailure.badRequest }
            let lines = text.components(separatedBy: "\r\n")
            let parts = lines[0].split(separator: " ", omittingEmptySubsequences: false)
            guard parts.count == 3, ["HTTP/1.0", "HTTP/1.1"].contains(String(parts[2])), parts[1].hasPrefix("/") else { throw BridgeHTTPFailure.badRequest }
            var headers: [String: String] = [:]
            for line in lines.dropFirst() {
                guard let colon = line.firstIndex(of: ":"), !line.hasPrefix(" "), !line.hasPrefix("\t") else { throw BridgeHTTPFailure.badRequest }
                let key = String(line[..<colon]).lowercased()
                guard !key.isEmpty, key.utf8.allSatisfy({ (97...122).contains($0) || (48...57).contains($0) || $0 == 45 }), headers[key] == nil else { throw BridgeHTTPFailure.badRequest }
                let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
                guard value.utf8.allSatisfy({ $0 >= 32 || $0 == 9 }) else { throw BridgeHTTPFailure.badRequest }
                headers[key] = value
            }
            guard headers["transfer-encoding"] == nil else { throw BridgeHTTPFailure.badRequest }
            let length: Int
            if let value = headers["content-length"] {
                guard !value.isEmpty, value.utf8.allSatisfy({ (48...57).contains($0) }), let count = Int(value) else { throw BridgeHTTPFailure.badRequest }
                length = count
            } else {
                guard parts[0] != "POST" else { throw BridgeHTTPFailure(status: 411, code: "length_required", message: "请求必须提供 Content-Length。") }
                length = 0
            }
            guard length <= Self.maximumBodyBytes else { throw BridgeHTTPFailure(status: 413, code: "payload_too_large", message: "请求正文超过 128 KiB。") }
            header = (String(parts[0]), String(parts[1]), headers, separator.upperBound, length)
        }
        guard let header else { return nil }
        let expected = header.bodyStart + header.bodyLength
        guard buffer.count <= expected else { throw BridgeHTTPFailure.badRequest }
        guard buffer.count == expected else { return nil }
        return BridgeHTTPRequest(method: header.method, path: header.path, headers: header.headers, body: Data(buffer[header.bodyStart..<expected]))
    }
}

private func bridgeWithTimeout<T: Sendable>(seconds: Double, operation: @escaping @Sendable () async throws -> T) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask { try await operation() }
        group.addTask {
            try await Task.sleep(nanoseconds: UInt64(max(0.01, seconds) * 1_000_000_000))
            throw BridgeHTTPFailure(status: 504, code: "translation_timeout", message: "翻译超时，已停止本次请求。")
        }
        defer { group.cancelAll() }
        return try await group.next()!
    }
}

/// A single continuation can be completed by the network callback, deadline or cancellation.
private final class BridgeOnce<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuations: [CheckedContinuation<T, Error>] = []
    private var result: Result<T, Error>?
    func value() async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            if let result { lock.unlock(); continuation.resume(with: result) }
            else { continuations.append(continuation); lock.unlock() }
        }
    }
    @discardableResult func finish(_ result: Result<T, Error>) -> Bool {
        lock.lock()
        guard self.result == nil else { lock.unlock(); return false }
        self.result = result
        let pending = continuations; continuations.removeAll()
        lock.unlock()
        for continuation in pending { continuation.resume(with: result) }
        return true
    }
}

private final class BridgeConnection: @unchecked Sendable {
    struct Chunk: Sendable { let data: Data; let complete: Bool }
    private let connection: NWConnection
    private let lock = NSLock()
    private var pendingRead: BridgeOnce<Chunk>?
    private var pendingWrite: BridgeOnce<Void>?
    init(_ connection: NWConnection) { self.connection = connection }
    func receive(timeout: Double) async throws -> Chunk {
        let once = BridgeOnce<Chunk>()
        lock.withLock { pendingRead = once }
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { data, _, complete, error in
                if let error { once.finish(.failure(error)) }
                else { once.finish(.success(Chunk(data: data ?? Data(), complete: complete))) }
            }
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + max(0.01, timeout)) { [weak self] in
                if once.finish(.failure(BridgeHTTPFailure.requestTimeout)) { self?.connection.cancel() }
            }
            let value = try await once.value()
            try Task.checkCancellation()
            return value
        } onCancel: { self.cancel() }
    }
    func send(_ data: Data, timeout: Double) async throws {
        let once = BridgeOnce<Void>()
        lock.withLock { pendingWrite = once }
        try await withTaskCancellationHandler {
            try Task.checkCancellation()
            connection.send(content: data, completion: .contentProcessed { error in
                if let error { once.finish(.failure(error)) } else { once.finish(.success(())) }
            })
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout) { [weak self] in
                if once.finish(.failure(BridgeHTTPFailure.requestTimeout)) { self?.connection.cancel() }
            }
            try await once.value()
        } onCancel: { self.cancel() }
    }
    func cancel() {
        lock.lock(); let read = pendingRead, write = pendingWrite; lock.unlock()
        connection.cancel()
        read?.finish(.failure(CancellationError()))
        write?.finish(.failure(CancellationError()))
    }
}
