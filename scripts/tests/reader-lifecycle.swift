import AppKit
import Foundation
import AskGPTCore

private struct TestFailure: Error, CustomStringConvertible {
    let description: String
}
private func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw TestFailure(description: message) }
}

@MainActor private final class Fixture {
    let directory: URL
    let preferences: UserDefaults
    let suite: String
    let store: ReaderStore
    let executable: URL
    init(root: URL, mode: String, holdRelease: Bool = false) throws {
        directory = root.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        executable = directory.appendingPathComponent("synthetic-codex")
        let script = #"""
        #!/usr/bin/python3
        import json, os, pathlib, sys, time
        root=pathlib.Path(__file__).parent
        if '--version' in sys.argv:
            print('codex-cli 0.162.1'); sys.exit(0)
        def emit(value): print(json.dumps(value), flush=True)
        with (root/'events.jsonl').open('a') as log: log.write(json.dumps({'method':'fixture/start','pid':os.getpid()})+'\n')
        threads=0
        for line in sys.stdin:
            request=json.loads(line)
            with (root/'events.jsonl').open('a') as log: log.write(json.dumps(request)+'\n')
            method=request.get('method'); identifier=request.get('id'); params=request.get('params',{})
            mode=(root/'mode').read_text()
            if method=='initialize': emit({'id':identifier,'result':{'userAgent':'synthetic'}})
            elif method=='account/read': emit({'id':identifier,'result':{'account':{'type':'chatgpt'}}})
            elif method=='thread/start':
                threads+=1
                if mode=='failed-start':
                    emit({'id':identifier,'error':{'code':-32000,'message':'synthetic start failure'}}); continue
                if mode=='held-start':
                    while True: time.sleep(0.01)
                emit({'id':identifier,'result':{'thread':{'id':'thread-'+str(threads),'ephemeral':True},'modelProvider':'openai','approvalPolicy':'never','sandbox':{'type':'readOnly'},'instructionSources':[]}})
            elif method=='turn/start':
                thread=params['threadId']; turn='turn-'+str(threads)
                emit({'id':identifier,'result':{'turn':{'id':turn,'status':'inProgress'}}})
                if mode=='held-turn': continue
                if mode=='success': emit({'method':'item/completed','params':{'threadId':thread,'turnId':turn,'item':{'id':'answer','type':'agentMessage','phase':'final_answer','text':'synthetic answer'}}})
                emit({'method':'turn/completed','params':{'threadId':thread,'turn':{'id':turn,'status':'completed' if mode=='success' else 'failed','error':{'message':'synthetic failure'}}}})
            elif method=='thread/unsubscribe':
                deadline=time.monotonic()+2
                while (root/'hold-release').exists() and time.monotonic()<deadline: time.sleep(0.01)
                emit({'id':identifier,'result':{}})
            elif identifier is not None: emit({'id':identifier,'result':{}})
        """#
        try Data(script.utf8).write(to: executable)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
        try Data(mode.utf8).write(to: directory.appendingPathComponent("mode"))
        if holdRelease { try Data().write(to: directory.appendingPathComponent("hold-release")) }
        suite = "AskGPTReaderLifecycle-" + UUID().uuidString
        preferences = UserDefaults(suiteName: suite)!
        preferences.set(try JSONEncoder().encode(CodexSettings(cliPath: executable.path)), forKey: "codexSettings")
        store = ReaderStore(capture: SelectionCapture(),
            integration: EasydictIntegration(backupDirectory: directory.appendingPathComponent("unused-easydict")),
            preferences: preferences)
    }
    func records() -> [[String: Any]] {
        guard let text = try? String(contentsOf: directory.appendingPathComponent("events.jsonl"), encoding: .utf8) else { return [] }
        return text.split(separator: "\n").compactMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
    }
    func count(_ method: String) -> Int { records().filter { $0["method"] as? String == method }.count }
    func wait(_ message: String, _ condition: () -> Bool) async throws {
        for _ in 0..<1_000 {
            if condition() { return }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        throw TestFailure(description: message)
    }
    func cleanup() async { await store.shutdown(); preferences.removePersistentDomain(forName: suite) }
    func replaceSettings(with replacement: Fixture) {
        store.settings.cliPath = replacement.executable.path
        store.saveSettings()
    }
}

@main private struct ReaderLifecycleTests {
    @MainActor static func main() async throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1])
        var results: [String: String] = [:]
        func run(_ name: String, mode: String, holdRelease: Bool = false,
                 body: (Fixture) async throws -> Void) async throws {
            let fixture = try Fixture(root: root, mode: mode, holdRelease: holdRelease)
            do { try await body(fixture); results[name] = "PASS" }
            catch { results[name] = "FAIL: \(error)" }
            await fixture.cleanup()
        }
        try await run("failed_chat_sessions_released_before_retry", mode: "failed") { fixture in
            for index in 1...3 {
                fixture.store.send("synthetic \(index)")
                try await fixture.wait("chat did not finish") { !fixture.store.isSending }
                try require(fixture.store.errorMessage != nil, "failed turn was not surfaced")
                try require(fixture.count("thread/unsubscribe") == index, "failed chat session was not released")
            }
        }
        try await run("failed_connection_test_releases_session", mode: "failed") { fixture in
            fixture.store.testConnection()
            try await fixture.wait("connection test did not finish") { !fixture.store.isTesting }
            try require(!fixture.store.modelVerified && fixture.store.errorMessage != nil, "failure state missing")
            try require(fixture.count("thread/unsubscribe") == 1, "failed connection-test session was not released")
        }
        try await run("successful_connection_test_releases_only_its_session", mode: "success") { fixture in
            fixture.store.testConnection()
            try await fixture.wait("connection test did not finish") { !fixture.store.isTesting }
            try require(fixture.store.modelVerified, "successful connection test was not verified")
            try require(fixture.count("thread/unsubscribe") == 1, "successful test session was not released")
            fixture.store.send("new synthetic chat")
            try await fixture.wait("new chat did not finish") { !fixture.store.isSending }
            try require(fixture.store.ledger.messages.last?.text == "synthetic answer", "new chat was interrupted")
            try require(fixture.count("thread/unsubscribe") == 1, "active chat session was released by test cleanup")
        }
        try await run("failed_connection_start_rebuilds_existing_conversation", mode: "success") { fixture in
            fixture.store.send("synthetic first question")
            try await fixture.wait("first chat did not finish") { !fixture.store.isSending }
            try Data("failed-start".utf8).write(to: fixture.directory.appendingPathComponent("mode"))
            fixture.store.testConnection()
            try await fixture.wait("failed connection start did not finish") { !fixture.store.isTesting }
            try require(fixture.store.errorMessage != nil, "session creation failure was not surfaced")
            try Data("success".utf8).write(to: fixture.directory.appendingPathComponent("mode"))
            fixture.store.send("synthetic follow-up")
            try await fixture.wait("follow-up did not finish") { !fixture.store.isSending }
            try require(fixture.store.errorMessage == nil && fixture.store.ledger.messages.last?.text == "synthetic answer",
                        "failed connection start left an invalid conversation thread")
        }
        try await run("stop_during_session_creation_retires_unknown_session", mode: "held-start") { fixture in
            fixture.store.send("synthetic held start")
            try await fixture.wait("session creation did not start") { fixture.count("thread/start") == 1 }
            let pid = fixture.records().first? ["pid"] as? Int32
            fixture.store.stop()
            try await fixture.wait("cancelled session creation kept its CLI alive") { pid.map { kill($0, 0) != 0 } ?? false }
        }
        try await run("stop_during_turn_then_retry_keeps_new_session", mode: "held-turn") { fixture in
            fixture.store.send("synthetic held turn")
            try await fixture.wait("turn did not start") { fixture.count("turn/start") == 1 }
            fixture.store.stop()
            try Data("success".utf8).write(to: fixture.directory.appendingPathComponent("mode"))
            fixture.store.send("synthetic retry")
            try await fixture.wait("retry did not finish") { !fixture.store.isSending }
            try require(fixture.store.ledger.messages.last?.text == "synthetic answer", "retry was cancelled by old cleanup")
            try require(fixture.count("thread/unsubscribe") == 1, "old session was leaked or new session was released")
        }
        try await run("settings_change_during_failed_session_release_keeps_new_engine", mode: "failed", holdRelease: true) { fixture in
            let replacement = try Fixture(root: root, mode: "success")
            fixture.store.send("synthetic failure")
            do {
                try await fixture.wait("failed session cleanup did not start") { fixture.count("thread/unsubscribe") == 1 }
                fixture.replaceSettings(with: replacement)
                fixture.store.send("synthetic new engine")
                try await fixture.wait("new engine did not finish") { !fixture.store.isSending }
                try require(fixture.store.ledger.messages.last?.text == "synthetic answer", "old cleanup replaced new engine result")
                try require(replacement.count("thread/unsubscribe") == 0, "old cleanup released new engine's same-named thread")
            } catch { await replacement.cleanup(); throw error }
            await replacement.cleanup()
        }
        try await run("settings_change_during_connection_test_keeps_new_engine", mode: "held-turn") { fixture in
            let replacement = try Fixture(root: root, mode: "success")
            fixture.store.testConnection()
            do {
                try await fixture.wait("connection test did not start") { fixture.count("turn/start") == 1 }
                fixture.replaceSettings(with: replacement)
                fixture.store.send("synthetic chat after settings")
                try await fixture.wait("new engine did not answer") { fixture.store.ledger.messages.last?.text == "synthetic answer" && !fixture.store.isSending }
                try require(!fixture.store.isTesting && fixture.store.modelVerified, "old test overwrote new engine state")
                try require(replacement.count("thread/unsubscribe") == 0, "old test cleanup released new engine's same-named thread")
            } catch { await replacement.cleanup(); throw error }
            await replacement.cleanup()
        }
        let failed = results.values.contains { $0 != "PASS" }
        let report: [String: Any] = ["status": failed ? "FAIL" : "PASS", "fixtureOnly": true, "checks": results]
        print(String(decoding: try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]), as: UTF8.self))
        if failed { exit(1) }
    }
}
