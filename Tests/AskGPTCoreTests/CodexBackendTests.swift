import Testing
import Foundation
@testable import AskGPTCore

@Suite(.serialized)
struct CodexBackendTests {
    @Test func structuredTurnForwardsOnlyExactOutputSchemaWithoutChangingOrdinaryTurns() async throws {
        let fixture = try Fixture(mode: "success")
        defer { fixture.remove() }
        let backend: any PassageRefinementBackend = fixture.backend()
        let thread = try await backend.startSession(instructions: "Translate quoted page data")
        let schema = RPCObject(["type": "object", "properties": [
            "translations": ["type": "object", "properties": ["p0": ["type": "string"], "p1": ["type": "string"]],
                "required": ["p0", "p1"], "additionalProperties": false]],
            "required": ["translations"], "additionalProperties": false])
        _ = try await backend.sendStructured(threadID: thread, text: "quoted segments", schema: schema, onDelta: { _ in })
        _ = try await backend.send(threadID: thread, text: "ordinary follow-up", onDelta: { _ in })
        await backend.shutdown()
        let turns = try fixture.requests().filter { $0["method"] as? String == "turn/start" }
        let first = try #require(turns.first?["params"] as? [String: Any])
        #expect(Set(first.keys) == ["threadId", "input", "effort", "outputSchema"])
        let forwarded = try #require(first["outputSchema"] as? [String: Any])
        #expect(NSDictionary(dictionary: forwarded).isEqual(to: schema.value))
        let input = try #require(first["input"] as? [[String: Any]])
        #expect(input.count == 1)
        #expect(Set(input[0].keys) == ["type", "text"])
        #expect(input[0]["text"] as? String == "quoted segments")
        let ordinary = try #require(turns.last?["params"] as? [String: Any])
        #expect(Set(ordinary.keys) == ["threadId", "input", "effort"])
    }

    @Test func structuredTurnKeepsExistingTimeoutAndToolRejection() async throws {
        for mode in ["timeout", "tool"] {
            let fixture = try Fixture(mode: mode)
            defer { fixture.remove() }
            let backend = fixture.backend(timeout: 0.2)
            let thread = try await backend.startSession(instructions: "Translate quotation only")
            do {
                _ = try await backend.sendStructured(threadID: thread, text: "quoted page",
                    schema: RPCObject(["type": "object"]), onDelta: { _ in })
                Issue.record("Structured request bypassed existing turn guard")
            } catch CodexBackendError.timeout { #expect(mode == "timeout") }
              catch CodexBackendError.unexpectedTool { #expect(mode == "tool") }
            await backend.shutdown()
            let requests = try fixture.requests()
            #expect(requests.contains { $0["method"] as? String == "turn/interrupt" })
        }
    }

    @Test func testFramerKeepsSplitUTF8AndMultipleLines() throws {
        var framer = RPCLineFramer(maximumLineBytes: 1024)
        let bytes = Data("{\"text\":\"你好\"}\n{\"id\":2}\r\n".utf8)
        var lines: [Data] = []
        for byte in bytes { lines += try framer.append(Data([byte])) }
        #expect(lines.map { String(decoding: $0, as: UTF8.self) } == ["{\"text\":\"你好\"}", "{\"id\":2}"])
        try framer.finish()
    }

    @Test func testFramerRejectsOversizedAndTruncatedInput() throws {
        var oversized = RPCLineFramer(maximumLineBytes: 4)
        #expect(throws: (any Error).self) { try oversized.append(Data("12345".utf8)) }
        var truncated = RPCLineFramer()
        _ = try truncated.append(Data("{\"id\":".utf8))
        #expect(throws: (any Error).self) { try truncated.finish() }
    }

    @Test func testLaunchArgumentsUsePerServerOverridesAndNeverAShell() {
        let arguments = CodexBackend.launchArguments(settings: .init(), mcpServerNames: ["node_repl", "computer-use"])
        #expect(Array(arguments.prefix(2)) == ["app-server", "--stdio"])
        #expect(arguments.contains("mcp_servers.node_repl.enabled=false"))
        #expect(arguments.contains("mcp_servers.computer-use.enabled=false"))
        #expect(arguments.contains("features.stable_environment_tools=false"))
        #expect(!arguments.contains(where: { $0.hasPrefix("forced_login_method=") }))
        #expect(!(arguments.contains("--ignore-user-config")))
        #expect(!(arguments.contains("-lc")))
    }

    @Test func testWebChatLaunchEnablesOnlyHostedWebSearch() {
        let arguments = CodexBackend.launchArguments(settings: .init(), mcpServerNames: ["private-tools"], capabilities: .webChat)
        #expect(arguments.contains("web_search=\"live\""))
        #expect(!arguments.contains("web_search=\"disabled\""))
        #expect(arguments.contains("features.code_mode_host=true"))
        #expect(arguments.contains("features.standalone_web_search=true"))
        #expect(arguments.contains("features.code_mode=false"))
        #expect(!arguments.contains("features.code_mode_host=false"))
        for blocked in ["features.shell_tool=false", "features.apps=false", "features.plugins=false", "features.skill_search=false", "mcp_servers.private-tools.enabled=false"] {
            #expect(arguments.contains(blocked))
        }
        let translationArguments = CodexBackend.launchArguments(settings: .init(), mcpServerNames: [])
        #expect(translationArguments.contains("web_search=\"disabled\""))
        #expect(translationArguments.contains("features.code_mode_host=false"))
        #expect(translationArguments.contains("features.standalone_web_search=false"))
        #expect(!translationArguments.contains("features.standalone_web_search=true"))
    }

    @Test func testWebChatSearchAndPageEventsProduceValidatedDeduplicatedSources() async throws {
        let fixture = try Fixture(mode: "webSuccess")
        defer { fixture.remove() }
        let backend = fixture.backend(capabilities: .webChat)
        let thread = try await backend.startSession(instructions: "普通对话，可以检索")
        let activity = ActivityRecorder()
        let result = try await backend.send(threadID: thread, text: "公开测试问题", onActivity: { activity.append($0) }, onDelta: { _ in })
        #expect(result.text == "权威答案")
        #expect(result.webSearchCount == 3)
        #expect(result.sources.map(\.url.absoluteString) == ["https://example.com/paper", "https://example.org/guide"])
        #expect(result.sources.first?.title == "Public paper")
        #expect(activity.value.contains(.searchingWeb))
        #expect(activity.value.contains(.readingWeb))
        let diagnostics = await backend.diagnostics()
        let diagnosticJSON = String(decoding: try JSONSerialization.data(withJSONObject: diagnostics), as: UTF8.self)
        for privateValue in ["public-query", "example.com", "Public paper", "公开测试问题"] { #expect(!diagnosticJSON.contains(privateValue)) }
        await backend.shutdown()
        let params = try #require(fixture.requests().first { $0["method"] as? String == "thread/start" }?["params"] as? [String: Any])
        #expect((params["environments"] as? [Any])?.isEmpty == true)
        #expect((params["selectedCapabilityRoots"] as? [Any])?.isEmpty == true)
        #expect((params["dynamicTools"] as? [Any])?.isEmpty == true)
        #expect(params["ephemeral"] as? Bool == true)
        #expect(params["sandbox"] as? String == "read-only")
    }

    @Test func testTextOnlyStillRejectsWebSearch() async throws {
        let fixture = try Fixture(mode: "webSuccess")
        defer { fixture.remove() }
        let backend = fixture.backend()
        let thread = try await backend.startSession(instructions: "翻译")
        do { _ = try await backend.send(threadID: thread, text: "public", onDelta: { _ in }); Issue.record("Text-only accepted web search") }
        catch CodexBackendError.unexpectedTool(let tool) { #expect(tool == "webSearch") }
        await backend.shutdown()
    }

    @Test func testWebChatStillRejectsShellAndUnknownSearchActions() async throws {
        for mode in ["tool", "webUnknown"] {
            let fixture = try Fixture(mode: mode)
            let backend = fixture.backend(capabilities: .webChat)
            let thread = try await backend.startSession(instructions: "普通对话")
            do { _ = try await backend.send(threadID: thread, text: "public", onDelta: { _ in }); Issue.record("Unexpected tool accepted") }
            catch CodexBackendError.unexpectedTool { }
            await backend.shutdown(); fixture.remove()
        }
    }

    @Test func testWebChatRejectsAllNonWebToolItemsIncludingUnknownFutureTools() async throws {
        let fixture = try Fixture(mode: "webForbidden")
        defer { fixture.remove() }
        let backend = fixture.backend(capabilities: .webChat)
        let thread = try await backend.startSession(instructions: "普通对话")
        for tool in ["fileChange", "mcpToolCall", "dynamicToolCall", "collabToolCall", "subAgentActivity", "sleep", "imageView", "imageGeneration", "futureTool"] {
            do { _ = try await backend.send(threadID: thread, text: tool, onDelta: { _ in }); Issue.record("Forbidden tool accepted: \(tool)") }
            catch CodexBackendError.unexpectedTool(let rejected) { #expect(rejected == tool) }
        }
        await backend.shutdown()
    }

    @Test func testWebChatRejectsServerRequestedToolsAndSendsRPCError() async throws {
        let fixture = try Fixture(mode: "webRequest")
        defer { fixture.remove() }
        let backend = fixture.backend(capabilities: .webChat)
        let thread = try await backend.startSession(instructions: "普通对话")
        do { _ = try await backend.send(threadID: thread, text: "public", onDelta: { _ in }); Issue.record("Server request accepted") }
        catch CodexBackendError.unexpectedTool(let method) { #expect(method == "item/tool/call") }
        await backend.shutdown()
        let response = try #require(fixture.requests().first { $0["id"] as? Int == 900 })
        #expect(response["error"] != nil)
        #expect(response["result"] == nil)
        #expect(try fixture.requests().contains { $0["method"] as? String == "turn/interrupt" })
    }

    @Test func testSearchCompletionWithoutAnswerNeverBecomesSuccess() async throws {
        let fixture = try Fixture(mode: "webOnly")
        defer { fixture.remove() }
        let backend = fixture.backend(capabilities: .webChat)
        let thread = try await backend.startSession(instructions: "普通对话")
        do { _ = try await backend.send(threadID: thread, text: "public", onDelta: { _ in }); Issue.record("Search is not an answer") }
        catch CodexBackendError.protocolFailure { }
        await backend.shutdown()
    }

    @Test func testWebSourcesAndActivityAreScopedToCurrentTurn() async throws {
        let fixture = try Fixture(mode: "webScope")
        defer { fixture.remove() }
        let backend = fixture.backend(capabilities: .webChat)
        let thread = try await backend.startSession(instructions: "普通对话")
        let first = try await backend.send(threadID: thread, text: "first", onDelta: { _ in })
        #expect(first.sources.count == 1)
        let activity = ActivityRecorder()
        let second = try await backend.send(threadID: thread, text: "second", onActivity: { activity.append($0) }, onDelta: { _ in })
        #expect(second.sources.isEmpty)
        #expect(second.webSearchCount == 0)
        #expect(activity.value.isEmpty)
        await backend.shutdown()
    }

    @Test func testCancellationDuringWebSearchInterruptsAndKeepsSourcesOutOfNextTurn() async throws {
        let fixture = try Fixture(mode: "webCancel")
        defer { fixture.remove() }
        let backend = fixture.backend(capabilities: .webChat)
        let thread = try await backend.startSession(instructions: "普通对话")
        let activity = ActivityRecorder()
        let first = Task { try await backend.send(threadID: thread, text: "first", onActivity: { activity.append($0) }, onDelta: { _ in }) }
        for _ in 0..<100 where activity.value.isEmpty { try await Task.sleep(nanoseconds: 10_000_000) }
        #expect(activity.value.contains(.searchingWeb))
        first.cancel()
        do { _ = try await first.value; Issue.record("Cancelled search succeeded") } catch { #expect(error is CancellationError) }
        let second = try await backend.send(threadID: thread, text: "second", onDelta: { _ in })
        #expect(second.sources.isEmpty)
        #expect(second.webSearchCount == 0)
        await backend.shutdown()
        #expect(try fixture.requests().contains { $0["method"] as? String == "turn/interrupt" })
    }

    @Test func testInstructionSandboxDeniesOnlyBothGlobalFilesAndEscapesPaths() throws {
        let home = URL(fileURLWithPath: "/private/tmp/a\"b\\c")
        let policy = try CodexBackend.instructionReadSandboxPolicy(codexHome: home)
        #expect(policy.contains("(allow default)"))
        #expect(policy.contains("(deny file-read*"))
        #expect(policy.contains("AGENTS.md"))
        #expect(policy.contains("AGENTS.override.md"))
        #expect(policy.contains("a\\\"b\\\\c"))
        #expect(!policy.contains("auth.json"))
        #expect(!policy.contains("deny network"))
    }

    @Test func testTextBackendCannotScanPrivateDocumentDirectories() throws {
        let policy = try CodexBackend.instructionReadSandboxPolicy(codexHome:
            FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".codex"))
        for folder in ["Documents", "Desktop", "Downloads"] {
            let path = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(folder).path
            #expect(policy.contains("(subpath \"" + path + "\")"))
        }
        #expect(!policy.contains("(subpath \"/Users\")"))
        #expect(!policy.contains("auth.json"))
    }

    @Test func testCompletedMessageIsAuthoritativeAndFollowupKeepsThread() async throws {
        let fixture = try Fixture(mode: "success")
        defer { fixture.remove() }
        let backend = fixture.backend()
        let info = try await backend.validateConnection()
        #expect(info.authMode == "chatgpt")
        let thread = try await backend.startSession(instructions: "仅解释选中文字")
        let deltas = DeltaRecorder()
        let first = try await backend.send(threadID: thread, text: "hello", onDelta: { deltas.append($0) })
        #expect(deltas.value == "草稿")
        #expect(first.text == "权威答案")
        #expect(first.firstDeltaSeconds != nil)
        let second = try await backend.send(threadID: thread, text: "继续", onDelta: { _ in })
        #expect(second.text == "权威答案")
        let diagnostics = await backend.diagnostics()
        #expect(diagnostics["backend.delta.accepted"] == 2)
        #expect(diagnostics["rpc.notification.item/agentMessage/delta"] == 2)
        let diagnosticJSON = String(decoding: try JSONSerialization.data(withJSONObject: diagnostics), as: UTF8.self)
        for privateValue in [thread, "hello", "继续", "草稿", "权威答案"] {
            #expect(!diagnosticJSON.contains(privateValue))
        }
        await backend.shutdown()
        let requests = try fixture.requests()
        let starts = requests.filter { $0["method"] as? String == "thread/start" }
        #expect(starts.count == 1)
        let params = starts.first?["params"] as? [String: Any]
        #expect((params?["environments"] as? [Any])?.count == 0)
        #expect(params?["ephemeral"] as? Bool == true)
        let turns = requests.filter { $0["method"] as? String == "turn/start" }
        #expect(turns.count == 2)
        for request in turns {
            let turn = request["params"] as? [String: Any]
            #expect(turn?["threadId"] as? String == thread)
            #expect(turn?["cwd"] == nil)
            #expect(turn?["environments"] == nil)
        }
    }

    @Test func testRejectsAPIKeyAccountBeforeAnyTurn() async throws {
        let fixture = try Fixture(mode: "apiKey")
        defer { fixture.remove() }
        let backend = fixture.backend()
        do { _ = try await backend.validateConnection(); Issue.record("API key auth must be rejected") }
        catch { #expect(error.localizedDescription.contains("ChatGPT")) }
        await backend.shutdown()
        #expect(!(try fixture.requests().contains { $0["method"] as? String == "turn/start" }))
    }

    @Test func testFailedTurnNeverReturnsPartialTextAsSuccess() async throws {
        let fixture = try Fixture(mode: "failed")
        defer { fixture.remove() }
        let backend = fixture.backend()
        let thread = try await backend.startSession(instructions: "说明")
        do { _ = try await backend.send(threadID: thread, text: "hello", onDelta: { _ in }); Issue.record("failed turn") }
        catch { #expect(String(describing: error).contains("fixture failure")) }
        await backend.shutdown()
    }

    @Test func testEOFAndTimeoutDoNotHang() async throws {
        for mode in ["eof", "timeout"] {
            let fixture = try Fixture(mode: mode)
            let backend = fixture.backend(timeout: 0.3)
            let thread = try await backend.startSession(instructions: "说明")
            let start = Date()
            do { _ = try await backend.send(threadID: thread, text: "hello", onDelta: { _ in }); Issue.record("Unexpected success: \(mode)") }
            catch { #expect(Date().timeIntervalSince(start) < 3) }
            await backend.shutdown()
            fixture.remove()
        }
    }

    @Test func testCancellationInterruptsWithoutWaitingForTurnTimeout() async throws {
        let fixture = try Fixture(mode: "timeout")
        defer { fixture.remove() }
        let backend = fixture.backend(timeout: 10)
        let thread = try await backend.startSession(instructions: "说明")
        let task = Task { try await backend.send(threadID: thread, text: "hello", onDelta: { _ in }) }
        try await Task.sleep(nanoseconds: 80_000_000)
        let start = Date()
        task.cancel()
        do { _ = try await task.value; Issue.record("cancelled task") }
        catch { #expect(error is CancellationError) }
        #expect(Date().timeIntervalSince(start) < 2)
        await backend.shutdown()
        #expect(try fixture.requests().contains { $0["method"] as? String == "turn/interrupt" })
    }

    @Test func testUnexpectedToolInterruptsAndFailsClosed() async throws {
        let fixture = try Fixture(mode: "tool")
        defer { fixture.remove() }
        let backend = fixture.backend()
        let thread = try await backend.startSession(instructions: "说明")
        do { _ = try await backend.send(threadID: thread, text: "hello", onDelta: { _ in }); Issue.record("tool event") }
        catch { #expect(error.localizedDescription.contains("工具")) }
        await backend.shutdown()
        #expect(try fixture.requests().contains { $0["method"] as? String == "turn/interrupt" })
    }

    @Test func testLateInterruptedTurnCannotCancelNextQuestionOnSameThread() async throws {
        let fixture = try Fixture(mode: "lateInterrupt")
        defer { fixture.remove() }
        let backend = fixture.backend(timeout: 4)
        let thread = try await backend.startSession(instructions: "说明")
        let first = Task { try await backend.send(threadID: thread, text: "first", onDelta: { _ in }) }
        try await Task.sleep(nanoseconds: 80_000_000)
        first.cancel()
        do { _ = try await first.value; Issue.record("Expected first cancellation") }
        catch { #expect(error is CancellationError) }
        let second = try await backend.send(threadID: thread, text: "second", onDelta: { _ in })
        #expect(second.text == "权威答案")
        await backend.shutdown()
    }

    @Test func testRetiredTurnIdentityIsScopedToThread() async throws {
        let fixture = try Fixture(mode: "reusedTurnID")
        defer { fixture.remove() }
        let backend = fixture.backend(timeout: 1)
        let oldThread = try await backend.startSession(instructions: "说明")
        let oldDeltas = DeltaRecorder()
        let first = Task { try await backend.send(threadID: oldThread, text: "first", onDelta: { oldDeltas.append($0) }) }
        for _ in 0..<100 where oldDeltas.value.isEmpty { try await Task.sleep(nanoseconds: 10_000_000) }
        #expect(oldDeltas.value == "旧草稿")
        first.cancel()
        do { _ = try await first.value; Issue.record("Expected first cancellation") }
        catch { #expect(error is CancellationError) }
        await backend.releaseSession(threadID: oldThread)
        let newThread = try await backend.startSession(instructions: "说明")
        #expect(newThread != oldThread)
        let newDeltas = DeltaRecorder()
        do {
            let second = try await backend.send(threadID: newThread, text: "second", onDelta: { newDeltas.append($0) })
            #expect(newDeltas.value == "草稿")
            #expect(second.text == "权威答案")
            #expect(second.firstDeltaSeconds != nil)
        } catch {
            await backend.shutdown()
            throw error
        }
        await backend.shutdown()
    }

    @Test func testCancellationBeforeTurnStartAckAllowsEngineReconnect() async throws {
        let fixture = try Fixture(mode: "controlledBeforeAck")
        defer { fixture.remove() }
        let backend = fixture.backend(timeout: 4)
        for iteration in 0..<3 {
            let thread = try await backend.startSession(instructions: "说明")
            let blockedText = "blocked-before-ack-\(iteration)"
            let first = Task { try await backend.send(threadID: thread, text: blockedText, onDelta: { _ in }) }
            // The fixture logs this request and then waits on an unreleased
            // Event. It cannot emit either a turn ID or the RPC ACK.
            try await fixture.waitForRequest("turn/start", inputText: blockedText)
            first.cancel()
            do { _ = try await first.value; Issue.record("Expected first cancellation") }
            catch { #expect(error is CancellationError) }

            // Returning from cancellation must include connection retirement,
            // so a cached thread ID cannot still enter the old connection.
            do {
                _ = try await backend.send(threadID: thread, text: "must not reuse retired session", onDelta: { _ in })
                Issue.record("A retired connection's session was accepted")
            } catch CodexBackendError.unknownThread {
            } catch { Issue.record("Old session was not retired before cancellation returned: \(error)") }

            let replacement = try await backend.startSession(instructions: "说明")
            #expect(replacement != thread)
            let second = try await backend.send(threadID: replacement, text: "second", onDelta: { _ in })
            #expect(second.text == "权威答案")
            await backend.releaseSession(threadID: replacement)
        }
        await backend.shutdown()
        let requests = try fixture.requests()
        #expect(requests.filter { $0["method"] as? String == "initialize" }.count == 4)
        #expect(!requests.contains { $0["method"] as? String == "turn/interrupt" })
    }

    @Test func testReleaseSessionUnsubscribesWithoutPersistentThreadDeletion() async throws {
        let fixture = try Fixture(mode: "success")
        defer { fixture.remove() }
        let backend = fixture.backend()
        let thread = try await backend.startSession(instructions: "说明")
        await backend.releaseSession(threadID: thread)
        do { _ = try await backend.send(threadID: thread, text: "hello", onDelta: { _ in }); Issue.record("Released session is invalid") }
        catch { #expect(error.localizedDescription.contains("失效")) }
        await backend.shutdown()
        let requests = try fixture.requests()
        #expect(requests.contains { $0["method"] as? String == "thread/unsubscribe" })
        #expect(!requests.contains { ["thread/archive", "thread/delete"].contains($0["method"] as? String ?? "") })
    }

    @Test func testRejectsLoadedInstructionSources() async throws {
        let fixture = try Fixture(mode: "instructions")
        defer { fixture.remove() }
        let backend = fixture.backend()
        do { _ = try await backend.startSession(instructions: "说明"); Issue.record("inherited AGENTS") }
        catch { #expect(error.localizedDescription.contains("指令")) }
        await backend.shutdown()
    }

    @Test func testStartupConfigFailurePreservesSafeCause() async throws {
        let fixture = try Fixture(mode: "startupFailure")
        defer { fixture.remove() }
        let backend = fixture.backend()
        do { _ = try await backend.validateConnection(); Issue.record("Expected startup error") }
        catch { #expect(error.localizedDescription.contains("invalid transport")) }
        await backend.shutdown()
    }
}

private final class DeltaRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var text = ""
    func append(_ value: String) { lock.lock(); defer { lock.unlock() }; text += value }
    var value: String { lock.lock(); defer { lock.unlock() }; return text }
}

private final class ActivityRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var activities: [CodexActivity] = []
    func append(_ value: CodexActivity) { lock.lock(); defer { lock.unlock() }; activities.append(value) }
    var value: [CodexActivity] { lock.lock(); defer { lock.unlock() }; return activities }
}

private struct Fixture {
    let root: URL
    let executable: URL
    let log: URL
    init(mode: String) throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("askgpt-fixture-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        executable = root.appendingPathComponent("codex-fixture")
        log = root.appendingPathComponent("requests.jsonl")
        let script = """
        #!/usr/bin/python3
        import sys, json, os, threading, time
        MODE = \(String(reflecting: mode))
        LOG = \(String(reflecting: log.path))
        if '--version' in sys.argv:
            print('codex-cli 0.162.1'); sys.exit(0)
        if MODE=='startupFailure':
            sys.stderr.write('Error: invalid transport\\nin mcp_servers.bad\\n'); sys.stderr.flush(); sys.exit(1)
        def emit(x):
            sys.stdout.write(json.dumps(x, ensure_ascii=False)+'\\n'); sys.stdout.flush()
        turn_count=0
        thread_count=0
        for line in sys.stdin:
            r=json.loads(line)
            with open(LOG,'a') as f: f.write(json.dumps(r)+'\\n')
            m=r.get('method'); i=r.get('id'); p=r.get('params',{})
            if m=='initialize': emit({'id':i,'result':{'userAgent':'fixture'}})
            elif m=='account/read': emit({'id':i,'result':{'account':{'type':'apiKey' if MODE=='apiKey' else 'chatgpt'},'requiresOpenaiAuth':True}})
            elif m=='thread/start':
                thread_count+=1
                thread_id='thread-fixture-'+str(thread_count) if MODE=='reusedTurnID' else 'thread-fixture'
                if MODE=='controlledBeforeAck': thread_id='thread-fixture-'+str(os.getpid())+'-'+str(thread_count)
                emit({'id':i,'result':{'thread':{'id':thread_id,'ephemeral':True},'model':'gpt-6.1-sol','modelProvider':'openai','approvalPolicy':'never','sandbox':{'type':'readOnly'},'instructionSources':['/private/AGENTS.md'] if MODE=='instructions' else []}})
            elif m=='turn/start':
                turn_count+=1
                tid='turn-fixture-'+str(turn_count) if MODE=='lateInterrupt' or MODE.startswith('web') else 'turn-fixture'
                if MODE=='reusedTurnID': tid='0'
                thread_id=p.get('threadId','thread-fixture')
                if MODE=='eof': sys.exit(0)
                if MODE=='controlledBeforeAck' and p.get('input',[{}])[0].get('text','').startswith('blocked-before-ack-'):
                    threading.Event().wait()
                if MODE=='lateInterrupt' and turn_count==2: time.sleep(0.25)
                emit({'method':'turn/started','params':{'threadId':thread_id,'turn':{'id':tid,'status':'inProgress'}}})
                emit({'id':i,'result':{'turn':{'id':tid,'status':'inProgress'}}})
                if MODE=='reusedTurnID' and turn_count==1:
                    emit({'method':'item/agentMessage/delta','params':{'threadId':thread_id,'turnId':tid,'itemId':'old','delta':'旧草稿'}})
                    continue
                if MODE=='reusedTurnID':
                    emit({'method':'item/agentMessage/delta','params':{'threadId':'thread-fixture-1','turnId':tid,'itemId':'old','delta':'迟到旧文字'}})
                    emit({'method':'item/completed','params':{'threadId':'thread-fixture-1','turnId':tid,'item':{'id':'old','type':'agentMessage','phase':'final_answer','text':'迟到旧答案'}}})
                    emit({'method':'turn/completed','params':{'threadId':'thread-fixture-1','turn':{'id':tid,'status':'interrupted'}}})
                if MODE=='timeout': continue
                if MODE=='lateInterrupt' and turn_count==1: continue
                if MODE=='tool':
                    emit({'method':'item/started','params':{'threadId':'thread-fixture','turnId':'turn-fixture','item':{'id':'x','type':'commandExecution'}}}); continue
                if MODE=='webForbidden':
                    emit({'method':'item/started','params':{'threadId':thread_id,'turnId':tid,'item':{'id':'forbidden','type':p.get('input',[{}])[0].get('text','futureTool')}}}); continue
                if MODE=='webRequest':
                    emit({'id':900,'method':'item/tool/call','params':{'threadId':thread_id,'turnId':tid,'tool':'private-tool'}}); continue
                if MODE.startswith('web'):
                    if MODE=='webUnknown':
                        emit({'method':'item/started','params':{'threadId':thread_id,'turnId':tid,'item':{'id':'unknown','type':'webSearch','query':'public-query','action':{'type':'other'},'results':None}}}); continue
                    if turn_count==1 or MODE not in ['webScope','webCancel']:
                        items=[{'id':'search','type':'webSearch','query':'public-query','action':{'type':'search','query':'public-query','queries':None},'results':[{'title':'Public paper','url':'https://example.com/paper'},{'title':'Duplicate','url':'https://example.com/paper'},{'title':'bad','url':'javascript:alert(1)'},{'url':'file:///private/document'},{'url':'https://user:secret@example.net/private'},{'url':'https:///no-host'}]}]
                        if MODE=='webSuccess': items += [{'id':'open','type':'webSearch','query':'','action':{'type':'openPage','url':'https://example.org/guide'},'results':None},{'id':'find','type':'webSearch','query':'','action':{'type':'findInPage','url':'https://example.org/guide','pattern':'public'},'results':None}]
                        for item in items:
                            emit({'method':'item/started','params':{'threadId':thread_id,'turnId':tid,'item':item}})
                            emit({'method':'item/completed','params':{'threadId':thread_id,'turnId':tid,'item':item}})
                    elif MODE=='webScope':
                        emit({'method':'item/completed','params':{'threadId':thread_id,'turnId':'turn-fixture-1','item':{'id':'late','type':'webSearch','query':'old','action':{'type':'search'},'results':[{'title':'Old private','url':'https://old.example.net'}]}}})
                    if MODE=='webCancel' and turn_count==1: continue
                    if MODE=='webOnly':
                        emit({'method':'turn/completed','params':{'threadId':thread_id,'turn':{'id':tid,'status':'completed'}}}); continue
                emit({'method':'item/agentMessage/delta','params':{'threadId':thread_id,'turnId':tid,'itemId':'answer','delta':'草稿'}})
                emit({'method':'item/completed','params':{'threadId':thread_id,'turnId':tid,'item':{'id':'answer','type':'agentMessage','phase':'final_answer','text':'权威答案'}}})
                emit({'method':'turn/completed','params':{'threadId':thread_id,'turn':{'id':tid,'status':'failed' if MODE=='failed' else 'completed','error':{'message':'fixture failure'} if MODE=='failed' else None}}})
            elif m=='turn/interrupt':
                emit({'id':i,'result':{}})
                interrupted={'method':'turn/completed','params':{'threadId':p.get('threadId','thread-fixture'),'turn':{'id':p.get('turnId','turn-fixture'),'status':'interrupted'}}}
                if MODE=='lateInterrupt': threading.Timer(0.15,lambda event=interrupted:emit(event)).start()
                else: emit(interrupted)
            elif m=='thread/unsubscribe': emit({'id':i,'result':{'status':'unsubscribed'}})
            elif i is not None: emit({'id':i,'error':{'code':-32601,'message':'unsupported'}})
        """
        try Data(script.utf8).write(to: executable)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
    }
    func backend(timeout: Double = 2, capabilities: CodexCapabilities = .textOnly) -> CodexBackend {
        CodexBackend(settings: .init(cliPath: executable.path), timeoutSeconds: timeout, configURL: root.appendingPathComponent("none.toml"), workingDirectory: root, capabilities: capabilities)
    }
    func requests() throws -> [[String: Any]] {
        try String(contentsOf: log, encoding: .utf8).split(separator: "\n").map { try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any] }
    }
    func waitForRequest(_ method: String, inputText: String) async throws {
        let deadline = Date().addingTimeInterval(3)
        while Date() < deadline {
            let observed = (try? requests())?.contains { request in
                guard request["method"] as? String == method,
                      let params = request["params"] as? [String: Any],
                      let input = params["input"] as? [[String: Any]] else { return false }
                return input.first?["text"] as? String == inputText
            } ?? false
            if observed { return }
            try Task.checkCancellation()
            await Task.yield()
        }
        throw CodexBackendError.timeout
    }
    func remove() { try? FileManager.default.removeItem(at: root) }
}
