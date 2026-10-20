import Foundation
#if canImport(Darwin)
import Darwin
#endif

public enum CodexBackendError: Error, LocalizedError, Sendable {
    case unavailable(String), protocolFailure(String), timeout, disconnected, authentication, unsupportedVersion(String)
    case busy, unknownThread, turnFailed(String), unexpectedTool(String), inheritedInstructions
    public var errorDescription: String? {
        switch self {
        case .unavailable(let detail): return "无法启动 Codex CLI：\(detail)"
        case .protocolFailure(let detail): return "Codex 通信异常：\(detail)"
        case .timeout: return "Codex 响应超时，已停止本次请求。"
        case .disconnected: return "Codex 连接已断开，请重新提问。"
        case .authentication: return "需要 Codex 的 ChatGPT 登录；此应用不会改用付费 API。请先在终端运行 codex login。"
        case .unsupportedVersion(let version): return "Codex CLI 版本 \(version) 不支持当前隔离协议；请更新至 0.162.1 或更高版本。"
        case .busy: return "上一条回答仍在生成，请先停止。"
        case .unknownThread: return "阅读会话已失效，请重新选取原文。"
        case .turnFailed(let detail): return "Codex 回答失败：\(detail)"
        case .unexpectedTool(let type): return "检测到意外工具调用（\(type)），本次回答已停止。"
        case .inheritedInstructions: return "检测到继承的本地指令，已停止创建阅读会话。"
        }
    }
}

/// Frames bytes before UTF-8 decoding; pipe reads can split a Chinese character or JSON line.
struct RPCLineFramer {
    let maximumLineBytes: Int
    private var buffer = Data()
    init(maximumLineBytes: Int = 4 * 1024 * 1024) { self.maximumLineBytes = maximumLineBytes }
    mutating func append(_ bytes: Data) throws -> [Data] {
        buffer.append(bytes)
        var lines: [Data] = []
        while let newline = buffer.firstIndex(of: 0x0A) {
            let count = buffer.distance(from: buffer.startIndex, to: newline)
            guard count <= maximumLineBytes else { throw CodexBackendError.protocolFailure("JSONL 数据过长") }
            var line = Data(buffer[..<newline])
            if line.last == 0x0D { line.removeLast() }
            buffer.removeSubrange(...newline)
            if !line.isEmpty { lines.append(line) }
        }
        guard buffer.count <= maximumLineBytes else { throw CodexBackendError.protocolFailure("JSONL 数据过长") }
        return lines
    }
    mutating func finish() throws {
        guard buffer.allSatisfy({ [0x20, 0x09, 0x0D].contains($0) }) else {
            throw CodexBackendError.protocolFailure("JSONL 数据在传输途中截断")
        }
        buffer.removeAll()
    }
}

/// Foundation JSON values are confined to serialized RPC handling, then carried as an immutable box.
struct RPCObject: @unchecked Sendable {
    let value: [String: Any]
    init(_ value: [String: Any]) { self.value = value }
}

actor CodexRPCConnection {
    nonisolated let events: AsyncStream<RPCObject>
    private let eventContinuation: AsyncStream<RPCObject>.Continuation
    private let process: Process
    private let input: FileHandle
    private let output: FileHandle
    private let stderr: FileHandle
    private var reader: Task<Void, Never>?
    private var framer = RPCLineFramer()
    private var nextID = 0
    private var pending: [Int: CheckedContinuation<RPCObject, Error>] = [:]
    private var timers: [Int: Task<Void, Never>] = [:]
    private var failure: Error?
    private let startupDiagnostic = RPCStartupDiagnostic()
    private var receivedResponse = false
    private var diagnosticCounters: [String: Int] = [:]
    private var closeTask: Task<Void, Never>?

    func diagnostics() -> [String: Int] { diagnosticCounters }

    private func record(_ key: String) { diagnosticCounters[key, default: 0] += 1 }

    init(executable: String, arguments: [String], workingDirectory: URL, environment: [String: String]) throws {
        var continuation: AsyncStream<RPCObject>.Continuation!
        events = AsyncStream { continuation = $0 }
        eventContinuation = continuation
        let stdinPipe = Pipe(), stdoutPipe = Pipe(), stderrPipe = Pipe()
        input = stdinPipe.fileHandleForWriting
        output = stdoutPipe.fileHandleForReading
        stderr = stderrPipe.fileHandleForReading
        process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.currentDirectoryURL = workingDirectory
        process.environment = environment
        process.standardInput = stdinPipe
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe
        do { try process.run() }
        catch { throw CodexBackendError.unavailable(error.localizedDescription) }
        // Only child owns these pipe ends. Otherwise EOF can be held open by this parent.
        try? stdinPipe.fileHandleForReading.close()
        try? stdoutPipe.fileHandleForWriting.close()
        try? stderrPipe.fileHandleForWriting.close()
    }

    func beginReading() {
        guard reader == nil else { return }
        let stdoutHandle = output, errorHandle = stderr, diagnostic = startupDiagnostic
        let chunks = AsyncStream<Data> { continuation in
            DispatchQueue(label: "AskGPT.codex.stdout", qos: .userInitiated).async {
                defer { continuation.finish() }
                while true {
                    guard let data = readPipeChunk(stdoutHandle), !data.isEmpty else { break }
                    continuation.yield(data)
                }
            }
        }
        // Retain only a small in-memory startup tail. Surface recognized error categories, never raw values.
        DispatchQueue(label: "AskGPT.codex.stderr", qos: .utility).async {
            while let data = readPipeChunk(errorHandle), !data.isEmpty { diagnostic.append(data) }
        }
        reader = Task { [weak self] in
            for await chunk in chunks {
                guard let self else { return }
                await self.consume(chunk)
            }
            await self?.endOfFile()
        }
    }

    func request(_ method: String, params: RPCObject = RPCObject([:]), timeout: Double) async throws -> RPCObject {
        if let failure { throw failure }
        try Task.checkCancellation()
        nextID += 1
        record("rpc.request." + method)
        let id = nextID
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                guard !Task.isCancelled else { continuation.resume(throwing: CancellationError()); return }
                pending[id] = continuation
                timers[id] = Task { [weak self] in
                    do { try await Task.sleep(nanoseconds: UInt64(max(0.01, timeout) * 1_000_000_000)) }
                    catch { return }
                    await self?.resolve(id, result: .failure(CodexBackendError.timeout))
                }
                do { try write(RPCObject(["id": id, "method": method, "params": params.value])) }
                catch { resolve(id, result: .failure(error)) }
            }
        } onCancel: {
            Task { await self.resolve(id, result: .failure(CancellationError())) }
        }
    }

    func notify(_ method: String, params: RPCObject = RPCObject([:])) throws {
        if let failure { throw failure }
        try write(RPCObject(["method": method, "params": params.value]))
    }

    func replyError(id: Any, message: String) {
        try? write(RPCObject(["id": id, "error": ["code": -32601, "message": message]]))
    }

    private func write(_ message: RPCObject) throws {
        var data = try JSONSerialization.data(withJSONObject: message.value)
        data.append(0x0A)
        try input.write(contentsOf: data)
    }

    private func consume(_ data: Data) {
        guard failure == nil else { return }
        do {
            for line in try framer.append(data) {
                guard let value = try JSONSerialization.jsonObject(with: line) as? [String: Any] else {
                    throw CodexBackendError.protocolFailure("无法识别 JSON-RPC 对象")
                }
                if let id = value["id"] as? Int, value["method"] == nil {
                    receivedResponse = true
                    if let error = value["error"] as? [String: Any] {
                        record("rpc.response.error")
                        resolve(id, result: .failure(CodexBackendError.protocolFailure(error["message"] as? String ?? "RPC 请求失败")))
                    } else if let result = value["result"] as? [String: Any] {
                        record("rpc.response.success")
                        resolve(id, result: .success(RPCObject(result)))
                    } else {
                        resolve(id, result: .failure(CodexBackendError.protocolFailure("RPC 响应缺少 result")))
                    }
                } else if value["method"] != nil {
                    let method = value["method"] as? String ?? ""
                    let allowed: Set<String> = ["thread/started", "turn/started", "turn/completed", "item/started", "item/completed", "item/agentMessage/delta", "error"]
                    record("rpc.notification." + (allowed.contains(method) ? method : "other"))
                    if method == "error", let params = value["params"] as? [String: Any] {
                        record(params["willRetry"] as? Bool == true ? "rpc.error.retry" : "rpc.error.terminal")
                    }
                    eventContinuation.yield(RPCObject(value))
                }
            }
        } catch { fail(error) }
    }

    private func resolve(_ id: Int, result: Result<RPCObject, Error>) {
        timers.removeValue(forKey: id)?.cancel()
        pending.removeValue(forKey: id)?.resume(with: result)
    }

    private func endOfFile() {
        guard failure == nil else { return }
        if !receivedResponse, let cause = startupDiagnostic.safeCause {
            fail(CodexBackendError.unavailable(cause)); return
        }
        do { try framer.finish(); fail(CodexBackendError.disconnected) }
        catch { fail(error) }
    }

    private func fail(_ error: Error) {
        guard failure == nil else { return }
        failure = error
        for id in Array(pending.keys) { resolve(id, result: .failure(error)) }
        eventContinuation.yield(RPCObject(["method": "askgpt/connectionClosed"]))
        eventContinuation.finish()
    }

    func close() async {
        if let closeTask { await closeTask.value; return }
        fail(CodexBackendError.disconnected)
        try? input.close()
        let child = process
        let cleanup = Task.detached {
            if child.isRunning {
                child.terminate()
                for _ in 0..<20 {
                    if !child.isRunning { break }
                    try? await Task.sleep(nanoseconds: 50_000_000)
                }
                if child.isRunning {
                    #if canImport(Darwin)
                    _ = Darwin.kill(child.processIdentifier, SIGKILL)
                    #endif
                }
                // Foundation's termination callback reaps the child; never
                // block the actor/main thread while pipe readers are active.
                for _ in 0..<20 {
                    if !child.isRunning { break }
                    try? await Task.sleep(nanoseconds: 25_000_000)
                }
            }
        }
        closeTask = cleanup
        await cleanup.value
        reader?.cancel()
        reader = nil
    }
}

private final class RPCStartupDiagnostic: @unchecked Sendable {
    private let lock = NSLock()
    private var tail = Data()
    func append(_ data: Data) {
        lock.lock(); defer { lock.unlock() }
        tail.append(data)
        if tail.count > 8192 { tail = Data(tail.suffix(8192)) }
    }
    var safeCause: String? {
        lock.lock(); let text = String(decoding: tail, as: UTF8.self); lock.unlock()
        for category in ["invalid transport", "invalid type", "missing field", "unknown field", "Permission denied", "Operation not permitted"] {
            if text.contains(category) { return "子进程启动失败：" + category }
        }
        return nil
    }
}

/// POSIX read returns the bytes currently ready. FileHandle.read(upToCount:) can wait to fill
/// its requested length on a pipe, which stalls a persistent JSONL handshake and all deltas.
private func readPipeChunk(_ handle: FileHandle) -> Data? {
    #if canImport(Darwin)
    var bytes = [UInt8](repeating: 0, count: 64 * 1024)
    while true {
        let count = Darwin.read(handle.fileDescriptor, &bytes, bytes.count)
        if count > 0 { return Data(bytes.prefix(count)) }
        if count == 0 { return Data() }
        if errno != EINTR { return nil }
    }
    #else
    return handle.availableData
    #endif
}
