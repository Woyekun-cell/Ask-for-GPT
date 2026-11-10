import CryptoKit
import Foundation

public enum ZoteroPaperShortcut {
    private static let endpoint = URL(string: "http://127.0.0.1:23119/askgpt/paper")!
    private static let timeout: TimeInterval = 15
    private static let maximumAcknowledgmentBytes = 1_024

    public static func send(configuration: InlineConnectionConfiguration, nonce: String) async throws {
        try Task.checkCancellation()
        let timestamp = Int64(Date().timeIntervalSince1970 * 1_000)
        let request = try makeRequest(configuration: configuration, nonce: nonce, timestamp: timestamp)
        let options = URLSessionConfiguration.ephemeral
        options.connectionProxyDictionary = [:]
        options.timeoutIntervalForResource = timeout
        options.httpCookieStorage = nil
        options.urlCredentialStorage = nil
        options.httpShouldSetCookies = false
        let session = URLSession(configuration: options, delegate: NoRedirects(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200,
              response.expectedContentLength <= maximumAcknowledgmentBytes else { throw Failure.response }
        var data = Data()
        for try await byte in bytes {
            guard data.count < maximumAcknowledgmentBytes else { throw Failure.response }
            data.append(byte)
        }
        guard try JSONDecoder().decode([String: Bool].self, from: data) == ["ok": true] else {
            throw Failure.response
        }
    }

    static func isValidNonce(_ nonce: String) -> Bool {
        nonce.utf8.count == 32 && nonce.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    static func makeRequest(configuration: InlineConnectionConfiguration, nonce: String, timestamp: Int64) throws -> URLRequest {
        try configuration.validate()
        guard isValidNonce(nonce), timestamp > 0 else { throw Failure.challenge }
        let message = Data("askgpt-paper-v1\n\(timestamp)\n\(nonce)".utf8)
        let key = SymmetricKey(data: Data(configuration.token.utf8))
        let proof = HMAC<SHA256>.authenticationCode(for: message, using: key)
            .map { String(format: "%02x", $0) }.joined()
        var request = URLRequest(url: endpoint, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = "POST"
        request.httpBody = Data("{}".utf8)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(String(timestamp), forHTTPHeaderField: "X-AskGPT-Timestamp")
        request.setValue(nonce, forHTTPHeaderField: "X-AskGPT-Nonce")
        request.setValue(proof, forHTTPHeaderField: "X-AskGPT-Proof")
        return request
    }

    private enum Failure: Error { case challenge, response }

    private final class NoRedirects: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil)
        }
    }
}

public struct ZoteroPaperShortcutGate: Sendable {
    public static let bundleIdentifier = "org.zotero.zotero"

    private var pending: (nonce: String, processID: Int32)?

    public init() {}

    public mutating func begin(bundleID: String?, processID: Int32?) -> String? {
        pending = nil
        guard bundleID == Self.bundleIdentifier, let processID, processID > 0 else { return nil }
        let nonce = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        pending = (nonce, processID)
        return nonce
    }

    /// The matched handoff expires even if the foreground app has changed.
    public mutating func consume(_ nonce: String, bundleID: String?, processID: Int32?) -> Bool {
        guard let pending, pending.nonce == nonce else { return false }
        self.pending = nil
        return bundleID == Self.bundleIdentifier && processID == pending.processID
    }

    public mutating func cancel() { pending = nil }
}
