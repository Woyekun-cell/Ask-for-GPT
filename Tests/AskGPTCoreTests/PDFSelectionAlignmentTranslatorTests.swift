import Foundation
import Testing
@testable import AskGPTCore

struct PDFSelectionAlignmentTranslatorTests {
    private var unit: PDFPhraseAlignmentUnit {
        .init(id: "original_paragraph", sourceText: "Human genome sequencing is accurate.", targetText: "人类基因组测序准确。",
              source: ["Human", "genome", "sequencing", "is", "accurate", "."].enumerated().map { .init(id: "source_\($0.offset)", text: $0.element) },
              target: Array("人类基因组测序准确。").enumerated().map { .init(id: "target_\($0.offset)", text: String($0.element)) })
    }
    private var valid: String { #"{"match":{"s":"genome","t":"基因组","context":""}}"# }

    @Test func warmupDeduplicatesWithoutSendingTextAndEachSelectionConsumesFreshSession() async throws {
        let backend = SelectionAlignmentBackend(responses: [valid, valid]), client = PDFSelectionAlignmentTranslator(backend: backend)
        async let first: Void = client.prepare(source: "en", target: "zh-Hans")
        async let second: Void = client.prepare(source: "en", target: "zh-Hans")
        _ = try await (first, second)
        #expect(await backend.instructions.count == 1)
        #expect(await backend.inputs.isEmpty)
        #expect(await backend.released.isEmpty)
        _ = try await client.align(unit: unit, side: "source", range: [1, 1], source: "en", target: "zh-Hans")
        for _ in 0..<200 { if await backend.instructions.count == 2 { break }; try await Task.sleep(for: .milliseconds(1)) }
        #expect(await backend.instructions.count == 2)
        #expect(await backend.inputs.count == 1)
        try await client.prepare(source: "en", target: "zh-Hans")
        #expect(await backend.instructions.count == 2)
        _ = try await client.align(unit: unit, side: "source", range: [1, 1], source: "en", target: "zh-Hans")
        #expect(await backend.released == ["selection-1", "selection-2"])
        #expect(await backend.inputs.count == 2)
        await client.shutdown()
    }

    @Test func shutdownReleasesUnusedWarmSessionsAndRejectsLaterWarmup() async throws {
        let backend = SelectionAlignmentBackend(responses: [valid]), client = PDFSelectionAlignmentTranslator(backend: backend)
        try await client.prepare(source: "en", target: "zh-Hans")
        try await client.prepare(source: "zh-Hans", target: "en")
        #expect(await backend.instructions.count == 2)
        #expect(await backend.inputs.isEmpty)
        await client.shutdown()
        #expect(Set(await backend.released) == ["selection-1", "selection-2"])
        #expect(await backend.shutdowns == 1)
        do { try await client.prepare(source: "en", target: "zh-Hans"); Issue.record("Prepared after shutdown") }
        catch CodexBackendError.disconnected { }
    }

    @Test func failedWarmupDoesNotSendOrImplicitlyRetry() async throws {
        let backend = SelectionAlignmentBackend(responses: [valid], startFailure: .authentication), client = PDFSelectionAlignmentTranslator(backend: backend)
        do { try await client.prepare(source: "en", target: "zh-Hans"); Issue.record("Accepted failed warmup") }
        catch CodexBackendError.authentication { }
        #expect(await backend.instructions.count == 1)
        #expect(await backend.inputs.isEmpty)
        #expect(await backend.shutdowns == 1)
        await client.shutdown()
    }

    @Test func prepareDuringSelectionCannotBeOverwrittenOrLeakUnusedSession() async throws {
        let backend = SelectionAlignmentBackend(responses: [valid], holdRelease: true), client = PDFSelectionAlignmentTranslator(backend: backend)
        let input = unit
        let request = Task { try await client.align(unit: input, side: "source", range: [1, 1], source: "en", target: "zh-Hans") }
        for _ in 0..<200 { if await backend.released.count == 1 { break }; try await Task.sleep(for: .milliseconds(1)) }
        try await client.prepare(source: "en", target: "zh-Hans")
        #expect(await backend.instructions.count == 2)
        await backend.continueRelease()
        _ = try await request.value
        try await client.prepare(source: "en", target: "zh-Hans")
        #expect(await backend.instructions.count == 2)
        await client.shutdown()
        #expect(await backend.released == ["selection-1", "selection-2"])
    }

    @Test func shutdownJoinsAndReleasesLateWarmAndClaimedStartsExactlyOnce() async throws {
        for consume in [false, true] {
            let backend = SelectionAlignmentBackend(responses: [valid], holdStart: true), client = PDFSelectionAlignmentTranslator(backend: backend)
            let input = unit
            let request = Task {
                if consume { _ = try await client.align(unit: input, side: "source", range: [1, 1], source: "en", target: "zh-Hans") }
                else { try await client.prepare(source: "en", target: "zh-Hans") }
            }
            for _ in 0..<200 { if await backend.instructions.count == 1 { break }; try await Task.sleep(for: .milliseconds(1)) }
            await client.shutdown()
            do { try await request.value; Issue.record("Published a late session after shutdown") }
            catch { #expect(error is CancellationError) }
            #expect(await backend.inputs.isEmpty)
            #expect(await backend.released == ["selection-1"])
            #expect(await backend.shutdowns == 1)
        }
    }

    @Test func isolatesSelectionModelAndKeepsSuccessfulConnectionAcrossRequests() async throws {
        let question = CodexSettings(cliPath: "/custom/codex", model: "user-model", reasoningEffort: "high")
        #expect(PDFSelectionAlignmentConfiguration.settings(from: question) == CodexSettings(cliPath: "/custom/codex", model: "gpt-6.1-sol", reasoningEffort: "low"))
        #expect(question.model == "user-model" && question.reasoningEffort == "high")
        let backend = SelectionAlignmentBackend(responses: [valid, #"{"match":null}"#])
        let client = PDFSelectionAlignmentTranslator(backend: backend)
        let first = try await client.align(unit: unit, side: "source", range: [1, 1], source: "en", target: "zh-Hans")
        #expect(first.match == .init(sourceIDs: ["source_1"], targetIDs: ["target_2", "target_3", "target_4"]))
        #expect(first.firstDeltaSeconds != nil && first.totalSeconds >= 0)
        let second = try await client.align(unit: unit, side: "source", range: [0, 0], source: "en", target: "zh-Hans")
        #expect(second.match == nil)
        #expect(await backend.inputs.count == 2)
        #expect(await backend.released == ["selection-1", "selection-2"])
        #expect(await backend.shutdowns == 0)
        await client.shutdown()
        #expect(await backend.shutdowns == 1)
    }

    @Test func sendsContextAndSelectionWithoutRepeatedTokenArraysInOneStructuredTurn() async throws {
        let backend = SelectionAlignmentBackend(responses: [valid]), client = PDFSelectionAlignmentTranslator(backend: backend)
        _ = try await client.align(unit: unit, side: "source", range: [1, 1], source: "en", target: "zh-Hans")
        let sent = try #require(await backend.inputs.first)
        #expect(!sent.contains("source_1") && !sent.contains("original_paragraph"))
        let object = try #require(JSONSerialization.jsonObject(with: Data(sent.utf8)) as? [String: Any])
        #expect(object["selectedSide"] as? String == "source" && object["selectedQuote"] as? String == "genome")
        #expect(object["sourceText"] as? String == unit.sourceText && object["targetText"] as? String == unit.targetText)
        #expect(object["selectionBefore"] as? String == "Human " && object["selectionAfter"] as? String == " sequencing is accurate.")
        #expect(object["sourceTokens"] == nil && object["targetTokens"] == nil && object["range"] == nil)
        #expect(await backend.schemas.count == 1)
        #expect(await backend.instructions.first?.contains("untrusted") == true)
        #expect(await backend.instructions.first?.contains("Never align a whole sentence") == true)
        await client.shutdown()
    }

    @Test func acceptsChineseLexicalExpansionAndReverseLanguageDirection() throws {
        #expect(try PDFSelectionAlignmentTranslator.decode(valid, unit: unit, side: "target", range: [3, 3], source: "en", target: "zh-Hans")?.targetIDs == ["target_2", "target_3", "target_4"])
        let reverse = PDFPhraseAlignmentUnit(id: "reverse", sourceText: unit.targetText, targetText: unit.sourceText, source: unit.target, target: unit.source)
        #expect(try PDFSelectionAlignmentTranslator.decode(#"{"match":{"s":"基因组","t":"genome","context":""}}"#, unit: reverse, side: "source", range: [3, 3], source: "zh-Hans", target: "en")?.targetIDs == ["source_1"])
        #expect(try PDFSelectionAlignmentTranslator.decode(#"{"match":null}"#, unit: unit, side: "source", range: [1, 1], source: "en", target: "zh-Hans") == nil)
    }

    @Test func rejectsMissingSelectedTokensAndLatinExpansion() throws {
        for (response, side, range) in [(valid, "source", [0, 1]), (valid, "target", [1, 3]), (#"{"match":{"s":"Human genome","t":"人类基因组","context":""}}"#, "source", [1, 1])] {
            #expect(throws: PDFSelectionAlignmentError.invalidResponse) { try PDFSelectionAlignmentTranslator.decode(response, unit: unit, side: side, range: range, source: "en", target: "zh-Hans") }
        }
        let mixed = PDFPhraseAlignmentUnit(id: "mixed", sourceText: "DNA sequencing", targetText: "DNA测序", source: [.init(id: "sDNA", text: "DNA"), .init(id: "sSeq", text: "sequencing")], target: [.init(id: "tDNA", text: "DNA"), .init(id: "tSeq", text: "测序")])
        #expect(throws: PDFSelectionAlignmentError.invalidResponse) { try PDFSelectionAlignmentTranslator.decode(#"{"match":{"s":"DNA sequencing","t":"DNA测序","context":""}}"#, unit: mixed, side: "target", range: [0, 0], source: "en", target: "zh-Hans") }
    }

    @Test func strictlyRejectsDuplicateKeysOldIndexFormatWrongTypesAndExtraFields() throws {
        for response in [
            #"{"match":{"s":[1.0,1],"t":[2,4]}}"#, #"{"match":{"s":[1e0,1],"t":[2,4]}}"#,
            #"{"match":{"s":[true,1],"t":[2,4]}}"#, #"{"match":{"s":["1",1],"t":[2,4]}}"#,
            #"{"match":{"s":[1,1],"t":[2,999999999999999999999]}}"#,
            #"{"match":{"s":[1,1],"t":[4,2]}}"#, #"{"match":{"s":[1,1],"t":[-1,2]}}"#,
            #"{"match":{"s":[1,1],"t":[2,9]}}"#, #"{"match":{"s":[1,1],"t":[2]}}"#,
            #"{"match":{"s":[1,1],"t":[2,3,4]}}"#, #"{"match":{"s":[1,1],"s":[0,0],"t":[2,4]}}"#,
            #"{"match":null,"match":{"s":[1,1],"t":[2,4]}}"#,
            #"{"match":{"\u0073":[1,1],"t":[2,4]}}"#,
            #"{"match":{"s":[1,1],"t":[2,4],"text":"genome"}}"#,
            #"{"match":false}"#, #"{"match":[]}"#, #"{"match":null,"extra":null}"#,
            #"{"match":{"s":"genome","t":"基因组"}}"#,
            #"{"match":{"s":"genome","t":"基因组","context":null}}"#,
            #"{"match":{"s":"genome","s":"Human","t":"基因组","context":""}}"#,
            #"{"match":{"\u0073":"genome","t":"基因组","context":""}}"#,
            #"{"match":{"s":"genome","t":"基因组","context":"","extra":""}}"#
        ] {
            #expect(throws: PDFSelectionAlignmentError.invalidResponse) { try PDFSelectionAlignmentTranslator.decode(response, unit: unit, side: "source", range: [1, 1], source: "en", target: "zh-Hans") }
        }
    }

    @Test func appliesIndependentPassageLimitsWithoutExpandingTheSelection() throws {
        let response: (String, String) -> String = { source, target in
            String(data: try! JSONSerialization.data(withJSONObject: ["match": ["s": source, "t": target, "context": ""]]), encoding: .utf8)!
        }
        let words = (0..<33).map { "word\($0)" }, chars = (0..<129).map { String(UnicodeScalar(0x4e00 + $0)!) }
        let bounded = PDFPhraseAlignmentUnit(id: "passage", sourceText: words.joined(separator: " "), targetText: chars.joined(),
            source: words.enumerated().map { .init(id: "s\($0.offset)", text: $0.element) },
            target: chars.enumerated().map { .init(id: "t\($0.offset)", text: $0.element) })
        let accepted = response(words.prefix(32).joined(separator: " "), chars.prefix(128).joined())
        #expect(try PDFSelectionAlignmentTranslator.decode(accepted, unit: bounded, side: "source", range: [0, 31], source: "en", target: "zh-Hans")?.sourceIDs.count == 32)
        #expect(try PDFSelectionAlignmentTranslator.decode(accepted, unit: bounded, side: "target", range: [0, 127], source: "en", target: "zh-Hans")?.targetIDs.count == 128)
        #expect(throws: PDFSelectionAlignmentError.invalidResponse) { try PDFSelectionAlignmentTranslator.decode(response(words.joined(separator: " "), chars.prefix(128).joined()), unit: bounded, side: "target", range: [0, 0], source: "en", target: "zh-Hans") }
        #expect(throws: PDFSelectionAlignmentError.invalidResponse) { try PDFSelectionAlignmentTranslator.decode(response(words[0], chars.joined()), unit: bounded, side: "source", range: [0, 0], source: "en", target: "zh-Hans") }
        // Actual Latin word counts also apply to a malformed bundled token.
        let bundled = PDFPhraseAlignmentUnit(id: "bundled", sourceText: words.joined(separator: " "), targetText: "字",
            source: [.init(id: "all", text: words.joined(separator: " "))], target: [.init(id: "c", text: "字")])
        #expect(throws: PDFSelectionAlignmentError.invalidResponse) { try PDFSelectionAlignmentTranslator.decode(response(bundled.sourceText, "字"), unit: bundled, side: "target", range: [0, 0], source: "en", target: "zh-Hans") }
        #expect(throws: PDFSelectionAlignmentError.invalidResponse) { try PDFSelectionAlignmentTranslator.decode(response("Human genome", "人类基因组"), unit: unit, side: "source", range: [1, 1], source: "en", target: "zh-Hans") }
    }

    @Test func explicitFiveWordAndSentenceSelectionsReachOneTurnWithExactQuotes() async throws {
        let phrase = #"{"match":{"s":"Human genome sequencing is accurate","t":"人类基因组测序准确","context":""}}"#
        let sentence = #"{"match":{"s":"Human genome sequencing is accurate.","t":"人类基因组测序准确。","context":""}}"#
        let backend = SelectionAlignmentBackend(responses: [phrase, sentence]), client = PDFSelectionAlignmentTranslator(backend: backend)
        #expect(try await client.align(unit: unit, side: "source", range: [0, 4], source: "en", target: "zh-Hans").match?.sourceIDs.count == 5)
        #expect(try await client.align(unit: unit, side: "source", range: [0, 5], source: "en", target: "zh-Hans").match?.sourceIDs.count == 6)
        #expect(await backend.inputs.count == 2)
        #expect(await backend.instructions.first?.contains("128 tokens and 32 Latin words") == true)
        await client.shutdown()
    }

    @Test func repeatedSelectedQuoteUsesKnownRangeAndCounterpartNeedsUniqueExactContext() throws {
        let repeated = PDFPhraseAlignmentUnit(id: "repeated", sourceText: "sequencing improves sequencing accuracy", targetText: "测序提高测序准确率",
            source: ["sequencing", "improves", "sequencing", "accuracy"].enumerated().map { .init(id: "s\($0.offset)", text: $0.element) },
            target: Array("测序提高测序准确率").enumerated().map { .init(id: "t\($0.offset)", text: String($0.element)) })
        let first = #"{"match":{"s":"sequencing","t":"测序","context":"测序提高"}}"#
        let second = #"{"match":{"s":"sequencing","t":"测序","context":"测序准确率"}}"#
        #expect(try PDFSelectionAlignmentTranslator.decode(first, unit: repeated, side: "source", range: [0, 0], source: "en", target: "zh-Hans") == .init(sourceIDs: ["s0"], targetIDs: ["t0", "t1"]))
        #expect(try PDFSelectionAlignmentTranslator.decode(second, unit: repeated, side: "source", range: [2, 2], source: "en", target: "zh-Hans") == .init(sourceIDs: ["s2"], targetIDs: ["t4", "t5"]))
        let reverse = #"{"match":{"s":"sequencing","t":"测序","context":"sequencing accuracy"}}"#
        #expect(try PDFSelectionAlignmentTranslator.decode(reverse, unit: repeated, side: "target", range: [4, 4], source: "en", target: "zh-Hans")?.sourceIDs == ["s2"])
        for context in ["", "测序", "测序提高测序", "不存在"] {
            let response = "{\"match\":{\"s\":\"sequencing\",\"t\":\"测序\",\"context\":\"\(context)\"}}"
            #expect(throws: PDFSelectionAlignmentError.invalidResponse) { try PDFSelectionAlignmentTranslator.decode(response, unit: repeated, side: "source", range: [0, 0], source: "en", target: "zh-Hans") }
        }
        let overlongContext = "{\"match\":{\"s\":\"sequencing\",\"t\":\"测序\",\"context\":\"\(String(repeating: "字", count: 257))\"}}"
        #expect(throws: PDFSelectionAlignmentError.invalidResponse) { try PDFSelectionAlignmentTranslator.decode(overlongContext, unit: repeated, side: "source", range: [0, 0], source: "en", target: "zh-Hans") }
    }

    @Test func quotesMustMatchLiteralUnicodeSpacingAndCompleteTokenBoundaries() throws {
        let spaced = PDFPhraseAlignmentUnit(id: "spaced", sourceText: "nucleic  acid modifications", targetText: "核酸修饰",
            source: [.init(id: "n", text: "nucleic"), .init(id: "a", text: "acid"), .init(id: "m", text: "modifications")],
            target: Array("核酸修饰").enumerated().map { .init(id: "c\($0.offset)", text: String($0.element)) })
        #expect(try PDFSelectionAlignmentTranslator.decode(#"{"match":{"s":"nucleic  acid","t":"核酸","context":""}}"#, unit: spaced, side: "source", range: [0, 1], source: "en", target: "zh-Hans")?.sourceIDs == ["n", "a"])
        for quote in ["nucleic acid", "acid modification", "modification", "nucleic  acid "] {
            let response = "{\"match\":{\"s\":\"\(quote)\",\"t\":\"核酸\",\"context\":\"\"}}"
            #expect(throws: PDFSelectionAlignmentError.invalidResponse) { try PDFSelectionAlignmentTranslator.decode(response, unit: spaced, side: "source", range: [0, 1], source: "en", target: "zh-Hans") }
        }
        let composed = PDFPhraseAlignmentUnit(id: "composed", sourceText: "café", targetText: "咖啡", source: [.init(id: "latin", text: "café")], target: [.init(id: "cjk", text: "咖啡")])
        #expect(throws: PDFSelectionAlignmentError.invalidResponse) { try PDFSelectionAlignmentTranslator.decode(#"{"match":{"s":"cafe\u0301","t":"咖啡","context":""}}"#, unit: composed, side: "source", range: [0, 0], source: "en", target: "zh-Hans") }
    }

    @Test func tokenContextMustCoverActualLexicalTextBeforeConnecting() async throws {
        let backend = SelectionAlignmentBackend(responses: [valid]), client = PDFSelectionAlignmentTranslator(backend: backend)
        for broken in [PDFPhraseAlignmentUnit(id: "missing", sourceText: "human genome", targetText: "基因组", source: [.init(id: "s", text: "genome")], target: [.init(id: "t", text: "基因组")]),
                       .init(id: "partial", sourceText: "genomes", targetText: "基因组", source: [.init(id: "s", text: "genome")], target: [.init(id: "t", text: "基因组")]),
                       .init(id: "operator", sourceText: "A+B", targetText: "字", source: [.init(id: "a", text: "A"), .init(id: "b", text: "B")], target: [.init(id: "t", text: "字")]),
                       .init(id: "punctuation", sourceText: "human, genome", targetText: "字", source: [.init(id: "a", text: "human"), .init(id: "b", text: "genome")], target: [.init(id: "t", text: "字")])] {
            await #expect(throws: PDFSelectionAlignmentError.invalidInput) { try await client.align(unit: broken, side: "source", range: [0, 0], source: "en", target: "zh-Hans") }
        }
        #expect(await backend.inputs.isEmpty)
        await client.shutdown()
    }

    @Test func longContextKeepsAllTextWithoutTokenNumberingOverhead() async throws {
        let words = (0..<512).map { "word\($0)" }, chars = (0..<512).map { String(UnicodeScalar(0x4e00 + $0)!) }
        let large = PDFPhraseAlignmentUnit(id: "large", sourceText: words.joined(separator: " "), targetText: chars.joined(),
            source: words.enumerated().map { .init(id: "long_source_paragraph_token_\($0.offset)", text: $0.element) },
            target: chars.enumerated().map { .init(id: "long_target_paragraph_token_\($0.offset)", text: $0.element) })
        let response = "{\"match\":{\"s\":\"word250\",\"t\":\"\(chars[250])\",\"context\":\"\"}}"
        let backend = SelectionAlignmentBackend(responses: [response]), client = PDFSelectionAlignmentTranslator(backend: backend)
        #expect(try await client.align(unit: large, side: "source", range: [250, 250], source: "en", target: "zh-Hans").match?.targetIDs == ["long_target_paragraph_token_250"])
        let sent = try #require(await backend.inputs.first)
        let object = try #require(JSONSerialization.jsonObject(with: Data(sent.utf8)) as? [String: Any])
        #expect(object["sourceText"] as? String == large.sourceText && object["targetText"] as? String == large.targetText)
        #expect(sent.utf8.count * 4 < (try JSONEncoder().encode(large)).count)
        await client.shutdown()
    }

    @Test func malformedResponseHasNoHiddenRetryAndNextSelectionCanRecover() async throws {
        let backend = SelectionAlignmentBackend(responses: [#"{"match":{"s":"genome","t":"不存在","context":""}}"#, valid]), client = PDFSelectionAlignmentTranslator(backend: backend)
        await #expect(throws: PDFSelectionAlignmentError.invalidResponse) { try await client.align(unit: unit, side: "source", range: [1, 1], source: "en", target: "zh-Hans") }
        #expect(await backend.inputs.count == 1)
        #expect(await backend.released == ["selection-1"])
        #expect(await client.lastValidationReason == .order)
        #expect(await backend.shutdowns == 0)
        _ = try await client.align(unit: unit, side: "source", range: [1, 1], source: "en", target: "zh-Hans")
        #expect(await backend.inputs.count == 2)
        #expect(await client.lastValidationReason == nil)
        await client.shutdown()
    }

    @Test func rejectsInvalidInputBeforeStartingModel() async throws {
        let backend = SelectionAlignmentBackend(responses: [valid]), client = PDFSelectionAlignmentTranslator(backend: backend)
        for (side, range) in [("other", [1, 1]), ("source", []), ("source", [1]), ("source", [-1, 1]), ("source", [2, 1]), ("source", [0, 6]), ("source", [0, 128])] {
            await #expect(throws: PDFSelectionAlignmentError.invalidInput) { try await client.align(unit: unit, side: side, range: range, source: "en", target: "zh-Hans") }
        }
        let duplicate = PDFPhraseAlignmentUnit(id: "duplicate", sourceText: "human", targetText: "人", source: [.init(id: "same", text: "human")], target: [.init(id: "same", text: "人")])
        await #expect(throws: PDFSelectionAlignmentError.invalidInput) { try await client.align(unit: duplicate, side: "source", range: [0, 0], source: "en", target: "zh-Hans") }
        await #expect(throws: PDFSelectionAlignmentError.invalidInput) { try await client.align(unit: unit, side: "source", range: [1, 1], source: "en", target: "en") }
        #expect(await backend.inputs.isEmpty)
        #expect(await backend.instructions.isEmpty)
        await client.shutdown()
    }

    @Test func cancellationDuringCleanupCannotPublishAndDoesNotLeakSession() async throws {
        for stop in [false, true] {
            let backend = SelectionAlignmentBackend(responses: [valid], holdRelease: true), client = PDFSelectionAlignmentTranslator(backend: backend)
            let input = unit
            let request = Task { try await client.align(unit: input, side: "source", range: [1, 1], source: "en", target: "zh-Hans") }
            for _ in 0..<200 { if await backend.released.count == 1 { break }; try await Task.sleep(for: .milliseconds(1)) }
            #expect(await backend.released.count == 1)
            do { _ = try await client.align(unit: input, side: "source", range: [1, 1], source: "en", target: "zh-Hans"); Issue.record("Accepted overlapping selection") }
            catch CodexBackendError.busy { }
            if stop { await client.shutdown() } else { request.cancel() }
            await backend.continueRelease()
            do { _ = try await request.value; Issue.record("Published a cancelled selection") } catch { #expect(error is CancellationError) }
            #expect(await backend.inputs.count == 1)
            #expect(await backend.released.count == 1)
            if !stop { await client.shutdown() }
        }
    }
}

private actor SelectionAlignmentBackend: PassageRefinementBackend {
    let responses: [String]
    let holdRelease: Bool
    let startFailure: CodexBackendError?
    let holdStart: Bool
    private var releaseGate: CheckedContinuation<Void, Never>?
    private var startGate: CheckedContinuation<Void, Never>?
    private(set) var inputs: [String] = [], instructions: [String] = [], released: [String] = []
    private(set) var schemas: [RPCObject] = []
    private(set) var shutdowns = 0
    init(responses: [String], holdRelease: Bool = false, startFailure: CodexBackendError? = nil, holdStart: Bool = false) { self.responses = responses; self.holdRelease = holdRelease; self.startFailure = startFailure; self.holdStart = holdStart }
    func startSession(instructions: String) async throws -> String {
        self.instructions.append(instructions); let index = self.instructions.count
        if let startFailure { throw startFailure }
        if holdStart { await withCheckedContinuation { startGate = $0 } }
        return "selection-\(index)"
    }
    func send(threadID: String, text: String, onDelta: @escaping @Sendable (String) -> Void) async throws -> BackendTurnResult {
        inputs.append(text)
        return .init(text: responses[min(inputs.count - 1, responses.count - 1)], firstDeltaSeconds: 0.01, totalSeconds: 0.1)
    }
    func sendStructured(threadID: String, text: String, schema: RPCObject, onDelta: @escaping @Sendable (String) -> Void) async throws -> BackendTurnResult {
        schemas.append(schema); return try await send(threadID: threadID, text: text, onDelta: onDelta)
    }
    func releaseSession(threadID: String) async { released.append(threadID); if holdRelease && released.count == 1 { await withCheckedContinuation { releaseGate = $0 } } }
    func continueRelease() { releaseGate?.resume(); releaseGate = nil }
    func shutdown() async { shutdowns += 1; startGate?.resume(); startGate = nil }
}
