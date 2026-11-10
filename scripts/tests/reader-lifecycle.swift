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
    let providerKeys: APIProviderKeyStore
    let paperHistory: PaperChatHistory
    init(root: URL, mode: String, holdRelease: Bool = false, publishModelRoute: ((CodexSettings) throws -> Void)? = nil) throws {
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
        with (root/'events.jsonl').open('a') as log: log.write(json.dumps({'method':'fixture/start','pid':os.getpid(),'arguments':sys.argv[1:]})+'\n')
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
        providerKeys = APIProviderKeyStore(directory: directory.appendingPathComponent("provider-keys"))
        paperHistory = PaperChatHistory(directory: directory.appendingPathComponent("paper-history"))
        store = ReaderStore(capture: SelectionCapture(),
            integration: EasydictIntegration(backupDirectory: directory.appendingPathComponent("unused-easydict")),
            preferences: preferences, providerKeys: providerKeys, paperHistory: paperHistory, publishModelRoute: publishModelRoute)
    }
    func reopenPaperStore() -> ReaderStore {
        ReaderStore(capture: SelectionCapture(),
            integration: EasydictIntegration(backupDirectory: directory.appendingPathComponent("unused-easydict")),
            preferences: preferences, providerKeys: providerKeys, paperHistory: paperHistory)
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
                 publishModelRoute: ((CodexSettings) throws -> Void)? = nil,
                 body: (Fixture) async throws -> Void) async throws {
            let fixture = try Fixture(root: root, mode: mode, holdRelease: holdRelease, publishModelRoute: publishModelRoute)
            do { try await body(fixture); results[name] = "PASS" }
            catch { results[name] = "FAIL: \(error)" }
            await fixture.cleanup()
        }
        try await run("paper_context_is_local_until_send_and_scope_never_reuses_old_evidence", mode: "success") { fixture in
            let store = fixture.store
            let pages = (1...5).map { PaperContext.Page(number: $0, text: "Page \($0) evidence") }
            let paper = PaperContext(attachmentID: "private-item-1", title: "Example paper", abstract: "Study abstract",
                doi: "10.0000/example", selection: "Selected quote", currentPage: 3, pageCount: 6,
                pages: pages, complete: false)
            @MainActor func lastInput() throws -> [String: Any] {
                guard let turn = fixture.records().last(where: { $0["method"] as? String == "turn/start" }),
                      let params = turn["params"] as? [String: Any],
                      let input = (params["input"] as? [[String: String]])?.first?["text"],
                      let json = try JSONSerialization.jsonObject(with: Data(input.utf8)) as? [String: Any] else {
                    throw TestFailure(description: "Missing first-turn JSON")
                }
                try require(!input.contains("private-item-"), "Attachment ID escaped the local draft")
                return json
            }
            func evidence(in input: [String: Any]) throws -> [String: Any] {
                guard let paper = input["paper_context"] as? [String: Any] else {
                    throw TestFailure(description: "Missing paper context")
                }
                return paper
            }

            store.question = "Generic draft"
            store.attachPaper(paper)
            try require(store.question.isEmpty, "Generic draft leaked into paper chat")
            try require(store.paperScope == .nearby, "Paper draft did not default to nearby pages")
            try require(fixture.count("thread/start") == 0 && !store.isSending, "Attaching paper text started a model request")
            store.question = "Unsent question"
            store.summarizePaper()
            store.summarizePaper()
            try require(store.isSending && store.paperScope == .nearby && store.question == "Unsent question",
                        "Nearby summary did not send immediately or changed the scope or draft")
            try await fixture.wait("Nearby summary did not finish") { !store.isSending }
            try require(fixture.count("turn/start") == 1, "Nearby summary did not send exactly once")
            let paperLaunch = fixture.records().first(where: { $0["method"] as? String == "fixture/start" })?["arguments"] as? [String]
            try require(paperLaunch?.contains("web_search=\"disabled\"") == true, "Codex enabled hosted web search for private paper text")
            let nearbyInput = try lastInput()
            let nearbyPrompt = nearbyInput["question"] as? String ?? ""
            try require(nearbyPrompt.contains("当前页及相邻页") && nearbyPrompt.contains("PDF 页码"),
                        "Nearby summary lacked the scoped, evidence-based prompt")
            let nearby = try evidence(in: nearbyInput)
            let nearbyPages = (nearby["pages"] as? [[String: Any]])?.compactMap { $0["number"] as? Int }
            try require(nearbyPages == [2, 3, 4], "Nearby mode forwarded pages outside the current range")
            try require(nearby["abstract"] as? String == "Study abstract" && nearby["selection"] as? String == "Selected quote",
                        "Nearby evidence lost the abstract or selection")

            store.setPaperScope(.whole)
            try require(store.question.isEmpty && store.ledger.messages.isEmpty,
                        "Scope change leaked a draft or previous scope's evidence")
            store.summarizePaper()
            try require(store.isSending && store.paperScope == .whole && store.question.isEmpty,
                        "Whole-paper summary did not send immediately or changed the scope or draft")
            try await fixture.wait("Whole-paper summary did not finish") { !store.isSending }
            try require(fixture.count("turn/start") == 2, "Whole-paper summary did not send exactly once")
            let wholeInput = try lastInput()
            let wholePrompt = wholeInput["question"] as? String ?? ""
            try require(wholePrompt.contains("研究问题") && wholePrompt.contains("适用范围") &&
                        wholePrompt.contains("PDF 页码") && wholePrompt != nearbyPrompt,
                        "Whole-paper summary lacked the scoped, evidence-based prompt")
            let whole = try evidence(in: wholeInput)
            let wholePages = (whole["pages"] as? [[String: Any]])?.compactMap { $0["number"] as? Int }
            try require(wholePages == [1, 2, 3, 4, 5] && whole["complete"] as? Bool == false,
                        "Whole-paper mode lost text or mislabeled partial evidence")
            try require((wholeInput["prior_conversation"] as? [[String: String]])?.isEmpty == true,
                        "Whole-paper scope replayed nearby conversation")

            store.setPaperScope(.nearby)
            try require(store.question == "Unsent question" && store.ledger.messages.count == 2,
                        "Returning to Nearby lost its chat or draft")
            store.attachPaper(PaperContext(attachmentID: "private-item-2", title: paper.title, abstract: "",
                doi: "", selection: "", currentPage: 1, pageCount: 1, pages: [], complete: false))
            try require(store.paperScope == .nearby && store.ledger.messages.isEmpty && store.question.isEmpty,
                        "Different attachment with the same title reused the previous conversation or draft")
            try require(!store.canSummarizePaper, "Summary is available for an attachment without evidence")
            store.summarizePaper()
            try require(!store.isSending && fixture.count("turn/start") == 2, "Summary sent without paper evidence")
            store.adopt(SelectedExcerpt(text: "Fresh generic selection"))
            try require(store.paperContext == nil && store.question == "Generic draft", "Generic capture kept paper context or lost its draft")
            store.send()
            try await fixture.wait("Generic question did not finish") { !store.isSending }
            let genericLaunch = fixture.records().last(where: { $0["method"] as? String == "fixture/start" })?["arguments"] as? [String]
            try require(genericLaunch?.contains("web_search=\"live\"") == true, "Generic Codex chat lost hosted web search")
            let generic = try lastInput()
            try require(generic["paper_context"] == nil && generic["quoted_excerpt"] as? String == "Fresh generic selection",
                        "Detached paper evidence reached the generic question")
        }
        try await run("paper_switch_restores_only_that_attachments_chat", mode: "success") { fixture in
            let store = fixture.store
            func paper(_ key: String, at page: Int) -> PaperContext {
                PaperContext(attachmentID: key, title: "Same title", abstract: "", doi: "", selection: "",
                    currentPage: page, pageCount: 5,
                    pages: (1...5).map { .init(number: $0, text: "\(key) page \($0)") }, complete: true)
            }
            let a = paper("1:EXAMPLE1", at: 2)
            let b = paper("1:EXAMPLE2", at: 3)
            store.attachPaper(a)
            store.send("Question for A")
            try await fixture.wait("A did not finish") { !store.isSending }
            store.question = "Unsent A draft"
            store.attachPaper(b)
            try require(store.ledger.messages.isEmpty && store.question.isEmpty, "B inherited A's chat or draft")
            store.setPaperScope(.whole)
            store.send("Question for B")
            try await fixture.wait("B did not finish") { !store.isSending }
            store.attachPaper(paper(a.attachmentID, at: 4))
            try require(store.ledger.messages.first?.text == "Question for A" && store.question == "Unsent A draft",
                        "A's history or draft was lost after switching")
            store.send("Follow-up for A")
            try await fixture.wait("A follow-up did not finish") { !store.isSending }
            let turn = fixture.records().last { $0["method"] as? String == "turn/start" }
            let params = turn?["params"] as? [String: Any]
            let input = (params?["input"] as? [[String: String]])?.first?["text"] ?? ""
            try require(input.contains("Question for A") && !input.contains("Question for B") &&
                        input.contains("EXAMPLE1 page 5") && !input.contains("EXAMPLE1 page 1"),
                        "Follow-up did not combine A's history with A's new pages")

            await store.shutdown()
            let reopened = fixture.reopenPaperStore()
            reopened.attachPaper(b)
            try require(reopened.paperScope == .whole && reopened.ledger.messages.first?.text == "Question for B",
                        "B's scope and history were lost after reopening")
            reopened.attachPaper(a)
            try require(reopened.paperScope == .nearby && reopened.ledger.messages.filter { $0.role == .user }.map(\.text) ==
                        ["Question for A", "Follow-up for A"], "Reopened A lost or mixed its history")
            await reopened.shutdown()
        }
        try await run("same_verified_paper_keeps_nearby_follow_ups", mode: "success") { fixture in
            let store = fixture.store
            let pages = (1...4).map { PaperContext.Page(number: $0, text: "Unchanged page \($0)") }
            func paper(page: Int, text: [PaperContext.Page] = pages) -> PaperContext {
                PaperContext(attachmentID: "1:EXAMPLE1", title: "Example paper", abstract: "", doi: "",
                    selection: "", currentPage: page, pageCount: 4, pages: text, complete: true)
            }
            store.attachPaper(paper(page: 1))
            store.send("Initial question")
            try await fixture.wait("Initial question did not finish") { !store.isSending }
            store.attachPaper(paper(page: 3))
            try require(store.ledger.messages.count == 2, "Same extracted paper lost the conversation")
            store.send("Follow-up")
            try await fixture.wait("Follow-up did not finish") { !store.isSending }
            try require(fixture.count("thread/start") == 2 && fixture.count("thread/unsubscribe") == 1,
                        "New nearby evidence reused an old backend thread")
            let turn = fixture.records().last { $0["method"] as? String == "turn/start" }
            let params = turn?["params"] as? [String: Any]
            let input = (params?["input"] as? [[String: String]])?.first?["text"] ?? ""
            try require(input.contains("Initial question") && !input.contains("Unchanged page 1") && input.contains("Unchanged page 4"),
                        "Nearby follow-up did not use new pages and conversation history")
            var changed = pages
            changed[0] = PaperContext.Page(number: 1, text: "Replaced PDF content")
            store.attachPaper(paper(page: 3, text: changed))
            try require(store.ledger.messages.isEmpty, "Replaced PDF inherited an earlier transcript")
        }
        try await run("saved_profile_switches_without_forwarding_prior_chat", mode: "success") { fixture in
            let store = fixture.store
            store.send("prior Codex chat")
            try await fixture.wait("Codex chat did not finish") { !store.isSending }
            try require(store.ledger.messages.count == 2, "Codex fixture did not record prior chat")
            var profile = APIProviderProfile(kind: .openAI)
            profile.name = "Test profile"
            profile.baseURL = "http://127.0.0.1:1/v1"
            profile.model = "fixture-model"
            store.settings.apiProfile = profile
            store.saveSettings()
            try require(store.appliedSettings.apiProfile == nil, "profile activated without required key")
            store.saveSettings(apiKey: "fixture-only-secret")
            try require(store.appliedSettings.apiProfile?.id == profile.id, "saved profile did not activate")
            try require(store.ledger.messages.isEmpty, "chat history crossed profile boundary")
            try require(store.apiProfiles.count == 1, "profile was not saved")
            try require(store.rememberModels(["fixture-model", "fixture-model-2"], for: profile), "model discovery was not persisted")
            try require(store.appliedSettings.apiProfile?.model == "fixture-model", "catalog refresh switched the active model")
            try require(store.apiProfiles.first?.availableModels == ["fixture-model", "fixture-model-2"], "catalog lost available models")

            let preferences = fixture.preferences.data(forKey: "codexSettings")! + fixture.preferences.data(forKey: "apiProviderProfiles")!
            try require(!String(decoding: preferences, as: UTF8.self).contains("fixture-only-secret"), "API key was persisted in preferences")
            store.activateProfile(nil)
            try require(store.appliedSettings.apiProfile == nil, "Codex was not restored")
            store.activateProfile(profile, model: "fixture-model-2")
            try require(store.appliedSettings.apiProfile?.model == "fixture-model-2", "quick switch did not apply model")
            store.settings.apiProfile?.baseURL = "http://127.0.0.1:2/v1"
            store.saveSettings()
            try require(store.appliedSettings.apiProfile?.baseURL == profile.baseURL, "saved key was reused for a new endpoint")
            store.saveSettings(apiKey: "replacement-fixture-key")
            try require(store.appliedSettings.apiProfile?.id != profile.id && store.apiProfiles.count == 1, "endpoint edit reused the old credential ID")
        }
        try await run("reasoning_depth_follows_each_model_in_one_profile", mode: "success") { fixture in
            var profile = APIProviderProfile(kind: .openAI)
            profile.model = "gpt-6-astra"
            fixture.store.settings.apiProfile = profile
            try require(fixture.store.saveSettings(apiKey: "fixture-only-secret",
                discoveredModels: ["gpt-6-astra", "gpt-6-sol"]), "profile did not save")
            try require(fixture.store.activateProfile(profile, model: "gpt-6-astra", reasoningEffort: "high"),
                "could not select Astra effort")
            try require(fixture.store.activateProfile(profile, model: "gpt-6-sol", reasoningEffort: "low"),
                "could not select Sol effort")
            try require(fixture.store.appliedSettings.apiProfile?.effectiveReasoningEffort == "low",
                "Sol did not use its chosen depth")
            try require(fixture.store.activateProfile(profile, model: "gpt-6-astra"), "could not return to Astra")
            try require(fixture.store.appliedSettings.apiProfile?.effectiveReasoningEffort == "high",
                "switching models lost the prior reasoning choice")
            try require(fixture.store.activateProfile(profile, model: "gpt-6-astra", reasoningEffort: ""),
                "could not restore provider default")
            try require(fixture.store.appliedSettings.apiProfile?.effectiveReasoningEffort == nil &&
                fixture.store.apiProfiles.count == 1, "clearing effort created a new profile or kept an override")
        }
        try await run("failed_profile_save_keeps_active_credential", mode: "success", publishModelRoute: { settings in
            if settings.apiProfile?.model == "reject-route" { throw TestFailure(description: "route write failed") }
        }) { fixture in
            var profile = APIProviderProfile(kind: .openAI)
            profile.baseURL = "http://127.0.0.1:1/v1"
            profile.model = "fixture-model"
            fixture.store.settings.apiProfile = profile
            try require(fixture.store.saveSettings(apiKey: "old-fixture-key"), "initial profile did not save")
            fixture.store.settings.apiProfile?.model = "reject-route"
            try require(!fixture.store.saveSettings(apiKey: "new-fixture-key"), "failed route write did not surface")
            let key = try fixture.providerKeys.read(for: profile)
            try require(key == "old-fixture-key", "failed save overwrote the still-active key")
            try require(fixture.store.appliedSettings.apiProfile?.model == "fixture-model", "failed save changed active model")
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
