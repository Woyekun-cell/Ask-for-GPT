import Foundation
import AskGPTCore

@main struct InlineNativeSmoke {
    static func main() async {
        var bridge: InlineTranslationBridge?
        do {
            let configuration = try InlineConnectionConfiguration(extensionID: "ofcbkomnacejiphoifjmkmkpjcjddmfj")
            let server = InlineTranslationBridge(configuration: configuration)
            bridge = server
            try await server.start()
            let session = URLSession(configuration: .ephemeral)
            defer { session.invalidateAndCancel() }
            func request(path: String, body: [String: String]? = nil, origin: String? = nil,
                         authenticated: Bool = true) async throws -> (Int, Data) {
                var request = URLRequest(url: URL(string: configuration.endpoint + path)!)
                request.timeoutInterval = 8
                request.httpMethod = body == nil ? "GET" : "POST"
                if authenticated { request.setValue("Bearer " + configuration.token, forHTTPHeaderField: "Authorization") }
                if let origin { request.setValue(origin, forHTTPHeaderField: "Origin") }
                if let body {
                    request.httpBody = try JSONSerialization.data(withJSONObject: body)
                    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                }
                let (data, response) = try await session.data(for: request)
                return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
            }
            let health = try await request(path: "/v1/inline/health")
            guard health.0 == 200 else { throw ProbeError(message: "health failed") }
            let anonymous = try await request(path: "/v1/inline/health", authenticated: false)
            let hostile = try await request(path: "/v1/inline/health", origin: "https://unpaired.invalid")
            guard anonymous.0 == 401, hostile.0 == 403 else { throw ProbeError(message: "authorization boundary failed") }
            let texts = [
                "TNF-alpha expression did not increase after treatment (P = 0.08).",
                "Samples from three fish were pooled. Technical replicates were not independent biological samples."
            ]
            var outputs: [[String: Any]] = []
            for (index, text) in texts.enumerated() {
                let started = ProcessInfo.processInfo.systemUptime
                let id = "native-fixture-\(index)"
                let response = try await request(path: "/v1/inline/translate",
                    body: ["id": id, "text": text, "source": "en", "target": "zh-Hans"],
                    origin: "chrome-extension://" + configuration.extensionID)
                guard response.0 == 200,
                      let object = try JSONSerialization.jsonObject(with: response.1) as? [String: Any],
                      object["id"] as? String == id,
                      let translation = object["translation"] as? String, !translation.isEmpty else {
                    throw ProbeError(message: "native fixture \(index) returned HTTP \(response.0)")
                }
                outputs.append(["original": text, "translation": translation,
                                "completeSeconds": ProcessInfo.processInfo.systemUptime - started])
            }
            await server.shutdown()
            bridge = nil
            let result: [String: Any] = ["status": "PASS", "nativeRequests": outputs,
                "unauthenticatedStatus": anonymous.0, "unpairedOriginStatus": hostile.0,
                "scope": "real native translation via real loopback HTTP; synthetic public text only"]
            print(String(decoding: try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]), as: UTF8.self))
        } catch {
            if let bridge { await bridge.shutdown() }
            fputs("INLINE_NATIVE_SMOKE_FAILED: \(error.localizedDescription)\n", stderr)
            exit(1)
        }
    }
}

private struct ProbeError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}
