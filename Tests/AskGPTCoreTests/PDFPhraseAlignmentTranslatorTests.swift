import Foundation
import Testing
@testable import AskGPTCore

struct PDFPhraseAlignmentTranslatorTests {
    @Test func phraseModelIsolatedFromQuestionAndShortPassageSettings() {
        let question = CodexSettings(cliPath: "/custom/reader/codex", model: "user-question-model", reasoningEffort: "high")
        let original = question
        let phrase = PDFPhraseAlignmentConfiguration.settings(from: question)
        #expect(phrase == CodexSettings(cliPath: "/custom/reader/codex", model: "gpt-6.1-sol", reasoningEffort: "low"))
        #expect(question == original)
        #expect(PassageRefinementConfiguration.settings(from: question) == CodexSettings(cliPath: "/custom/reader/codex", model: "gpt-6-luna", reasoningEffort: "low"))
        #expect(PDFBatchConfiguration.settings(from: question) == CodexSettings(cliPath: "/custom/reader/codex", model: "gpt-6.1-sol", reasoningEffort: "low"))
    }

    @Test func compactRangesRestoreOriginalLongIDsWithoutSendingThemToModel() async throws {
        let sourceIDs = ["source_physical_000_paragraph_001_sentence_002_word_000", "source_physical_000_paragraph_001_sentence_002_word_001"]
        let targetIDs = ["target_physical_000_paragraph_001_sentence_002_glyph_000", "target_physical_000_paragraph_001_sentence_002_glyph_001", "target_physical_000_paragraph_001_sentence_002_glyph_002"]
        let input: [PDFPhraseAlignmentUnit] = [.init(id: "original_sentence_identifier_0001", sourceText: "Human genome", targetText: "人类基因组", source: zip(sourceIDs, ["Human", "genome"]).map { .init(id: $0.0, text: $0.1) }, target: zip(targetIDs, ["人类", "基因", "组"]).map { .init(id: $0.0, text: $0.1) })]
        let backend = PhraseAlignmentBackend(responses: [#"{"alignments":{"u0":[{"s":[0,0],"t":[0,0]},{"s":[1,1],"t":[1,2]}]}}"#])
        let client = PDFPhraseAlignmentTranslator(backend: backend)
        let result = try await client.align(input, source: "en", target: "zh-Hans")
        #expect(result.alignments["original_sentence_identifier_0001"] == [.init(sourceIDs: [sourceIDs[0]], targetIDs: [targetIDs[0]]), .init(sourceIDs: [sourceIDs[1]], targetIDs: Array(targetIDs[1...2]))])
        let sent = try #require(await backend.inputs.first)
        let object = try #require(JSONSerialization.jsonObject(with: Data(sent.utf8)) as? [String: Any])
        let row = try #require((object["quoted_units"] as? [[String: Any]])?.first)
        #expect(row["id"] as? String == "u0")
        let sourcePairs = try #require(row["sourceTokens"] as? [[Any]])
        let targetPairs = try #require(row["targetTokens"] as? [[Any]])
        #expect(sourcePairs.count == 2 && targetPairs.count == 3)
        #expect(sourcePairs[0][0] as? Int == 0 && sourcePairs[0][1] as? String == "Human")
        #expect(sourcePairs[1][0] as? Int == 1 && sourcePairs[1][1] as? String == "genome")
        #expect(targetPairs[0][0] as? Int == 0 && targetPairs[0][1] as? String == "人类")
        #expect(targetPairs[2][0] as? Int == 2 && targetPairs[2][1] as? String == "组")
        #expect(!sent.contains(sourceIDs[0]) && !sent.contains(targetIDs[0]) && !sent.contains(input[0].id))
        await client.shutdown()
    }

    private var units: [PDFPhraseAlignmentUnit] {
        [.init(id: "u0", sourceText: "Human genome sequencing is accurate.", targetText: "人类基因组测序准确。",
            source: [.init(id: "s0", text: "Human"), .init(id: "s1", text: "genome"), .init(id: "s2", text: "sequencing"), .init(id: "s3", text: "is"), .init(id: "s4", text: "accurate")],
            target: Array("人类基因组测序准确").enumerated().map { .init(id: "t\($0.offset)", text: String($0.element)) })]
    }
    private var valid: String { #"{"alignments":{"u0":[{"s":[0,0],"t":[0,1]},{"s":[1,1],"t":[2,4]},{"s":[2,2],"t":[5,6]},{"s":[4,4],"t":[7,8]}]}}"# }

    @Test func usesExistingTokenIDsAndKeepsCompositionalScientificTermsSeparate() async throws {
        let backend = PhraseAlignmentBackend(responses: [valid]), client = PDFPhraseAlignmentTranslator(backend: backend)
        let result = try await client.align(units, source: "en", target: "zh-Hans")
        #expect(result.alignments["u0"]?[2] == .init(sourceIDs: ["s2"], targetIDs: ["t5", "t6"]))
        let input = try #require(await backend.inputs.first)
        let object = try #require(JSONSerialization.jsonObject(with: Data(input.utf8)) as? [String: Any])
        let quoted = try #require(object["quoted_units"] as? [[String: Any]])
        #expect(quoted[0]["sourceText"] as? String == "Human genome sequencing is accurate.")
        #expect(await backend.instructions.first?.contains("genome") == true)
        #expect(await backend.instructions.first?.contains("Do not translate") == true)
        #expect(await backend.instructions.first?.contains("untrusted") == true)
        #expect(await backend.released == ["phrase-1"])
        await client.shutdown()
    }

    @Test func supportsSemanticReorderingIdiomsAndExplicitUnmatchedTokens() throws {
        let reordered = #"{"alignments":{"u0":[{"s":[4,4],"t":[7,8]},{"s":[0,0],"t":[0,1]}]}}"#
        #expect(try PDFPhraseAlignmentTranslator.decode(reordered, units: units)["u0"]?.count == 2)
        #expect(try PDFPhraseAlignmentTranslator.decode(#"{"alignments":{"u0":[]}}"#, units: units)["u0"] == [])
        let idiom = #"{"alignments":{"u0":[{"s":[1,2],"t":[2,6]}]}}"#
        #expect(try PDFPhraseAlignmentTranslator.decode(idiom, units: units)["u0"]?.count == 1)
    }

    @Test func localIndicesRestoreEachUnitDespiteReorderedRowsAndGroups() async throws {
        let input: [PDFPhraseAlignmentUnit] = [
            .init(id: "original_second", sourceText: "Human genome", targetText: "人类基因组", source: [.init(id: "aa", text: "Human"), .init(id: "bb", text: "genome")], target: [.init(id: "cc", text: "人类"), .init(id: "dd", text: "基因组")]),
            .init(id: "original_first", sourceText: "sequencing", targetText: "测序", source: [.init(id: "ee", text: "sequencing")], target: [.init(id: "ff", text: "测序")])]
        let response = #"{"alignments":{"u1":[{"s":[0,0],"t":[0,0]}],"u0":[{"s":[1,1],"t":[1,1]},{"s":[0,0],"t":[0,0]}]}}"#
        let backend = PhraseAlignmentBackend(responses: [response]), client = PDFPhraseAlignmentTranslator(backend: backend)
        let decoded = try await client.align(input, source: "en", target: "zh-Hans").alignments
        #expect(decoded["original_first"] == [.init(sourceIDs: ["ee"], targetIDs: ["ff"])])
        #expect(decoded["original_second"] == [.init(sourceIDs: ["bb"], targetIDs: ["dd"]), .init(sourceIDs: ["aa"], targetIDs: ["cc"])])
        let sent = try #require(await backend.inputs.first)
        let object = try #require(JSONSerialization.jsonObject(with: Data(sent.utf8)) as? [String: Any])
        let rows = try #require(object["quoted_units"] as? [[String: Any]])
        #expect(rows.count == 2 && rows[1]["id"] as? String == "u1")
        for row in rows {
            let sourcePairs = try #require(row["sourceTokens"] as? [[Any]])
            let targetPairs = try #require(row["targetTokens"] as? [[Any]])
            #expect(sourcePairs.first?[0] as? Int == 0 && targetPairs.first?[0] as? Int == 0)
        }
        await client.shutdown()
        // Index 1 exists in u0 but must never resolve against u0 from u1.
        #expect(throws: PDFPhraseAlignmentError.invalidResponse) {
            try PDFPhraseAlignmentTranslator.decode(#"{"alignments":{"u0":[],"u1":[{"s":[1,1],"t":[0,0]}]}}"#, units: input)
        }
        #expect(throws: PDFPhraseAlignmentError.invalidResponse) {
            try PDFPhraseAlignmentTranslator.decode(#"{"alignments":{"original_second":[],"original_first":[]}}"#, units: input)
        }
    }

    @Test func rejectsNonIntegerEndpointsOverflowExtraKeysAndDuplicateEscapedKeys() throws {
        for range in ["[true,true]", "[false,0]", "[0.0,0]", "[0,1.0]", "[0e0,0]", "[0,1e0]", "[null,0]", "[\"0\",0]", "[-1,0]", "[0,5]", "[0,9223372036854775808]", "[0,99999999999999999999999999999999999999999999999999]", "[0]", "[0,0,0]"] {
            let response = "{\"alignments\":{\"u0\":[{\"s\":\(range),\"t\":[0,0]}]}}"
            #expect(throws: PDFPhraseAlignmentError.invalidResponse) { try PDFPhraseAlignmentTranslator.decode(response, units: units) }
        }
        for response in [
            #"{"alignments":{"u0":[{"s":[0,0],"t":[0,1]},{"s":[1,1],"t":[1,2]}]}}"#,
            #"{"alignments":{"u0":[]},"alignments":{"u0":[]}}"#,
            #"{"alignments":{"u0":[],"\u00750":[]}}"#,
            #"{"alignments":{"\u00750":[]}}"#,
            #"{"alignments":{"u0":[{"s":[0,0],"\u0073":[1,1],"t":[0,0]}]}}"#,
            #"{"alignments":{"u0":[{"s":[0,0],"t":[0,0],"t":[1,1]}]}}"#,
            #"{"alignments":{"u0":[],"u1":[]}}"#,
            #"{"alignments":{"u0":[]},"extra":true}"#,
            #"{"alignments":{"u0":[{"sourceIDs":["s0"],"targetIDs":["t0"]}]}}"#
        ] {
            #expect(throws: PDFPhraseAlignmentError.invalidResponse) { try PDFPhraseAlignmentTranslator.decode(response, units: units) }
        }
    }

    @Test func inclusiveRangesKeepSixteenTokenAndFourLatinWordLimits() throws {
        let input: [PDFPhraseAlignmentUnit] = [.init(id: "range", sourceText: "甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午", targetText: "甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午", source: (0..<17).map { .init(id: "a\($0)", text: "甲") }, target: (0..<17).map { .init(id: "b\($0)", text: "乙") })]
        let decoded = try PDFPhraseAlignmentTranslator.decode(#"{"alignments":{"u0":[{"s":[0,15],"t":[1,16]}]}}"#, units: input)
        #expect(decoded["range"]?.first?.sourceIDs.count == 16)
        #expect(decoded["range"]?.first?.targetIDs.last == "b16")
        #expect(throws: PDFPhraseAlignmentError.invalidResponse) { try PDFPhraseAlignmentTranslator.decode(#"{"alignments":{"u0":[{"s":[0,16],"t":[0,15]}]}}"#, units: input) }
        #expect(try PDFPhraseAlignmentTranslator.decode(#"{"alignments":{"u0":[{"s":[0,3],"t":[0,1]}]}}"#, units: units)["u0"]?.first?.sourceIDs == ["s0", "s1", "s2", "s3"])
        #expect(throws: PDFPhraseAlignmentError.invalidResponse) { try PDFPhraseAlignmentTranslator.decode(#"{"alignments":{"u0":[{"s":[0,4],"t":[0,1]}]}}"#, units: units) }
    }

    @Test func longIDPageInputIsAtLeastFourTimesSmallerWithoutDroppingTokenText() async throws {
        let input: [PDFPhraseAlignmentUnit] = [.init(id: "physical_000_paragraph_001_sentence_000", sourceText: Array(repeating: "word", count: 512).joined(separator: " "), targetText: String(repeating: "字", count: 512), source: (0..<512).map { .init(id: "source_physical_000_paragraph_001_sentence_000_token_\($0)", text: "word") }, target: (0..<512).map { .init(id: "target_physical_000_paragraph_001_sentence_000_token_\($0)", text: "字") })]
        let backend = PhraseAlignmentBackend(responses: [#"{"alignments":{"u0":[]}}"#]), client = PDFPhraseAlignmentTranslator(backend: backend)
        let result = try await client.align(input, source: "en", target: "zh-Hans")
        #expect(result.alignments[input[0].id] == [])
        let sent = try #require(await backend.inputs.first)
        struct PreviousInput: Encodable { let quoted_units: [PDFPhraseAlignmentUnit] }
        let previous = try JSONEncoder().encode(PreviousInput(quoted_units: input))
        #expect(sent.utf8.count * 4 < previous.count)
        let object = try #require(JSONSerialization.jsonObject(with: Data(sent.utf8)) as? [String: Any])
        let row = try #require((object["quoted_units"] as? [[String: Any]])?.first)
        let sourcePairs = try #require(row["sourceTokens"] as? [[Any]])
        let targetPairs = try #require(row["targetTokens"] as? [[Any]])
        #expect(sourcePairs.count == 512 && targetPairs.count == 512)
        for (offset, token) in input[0].source.enumerated() {
            #expect(sourcePairs[offset].count == 2 && sourcePairs[offset][0] as? Int == offset && sourcePairs[offset][1] as? String == token.text)
        }
        for (offset, token) in input[0].target.enumerated() {
            #expect(targetPairs[offset].count == 2 && targetPairs[offset][0] as? Int == offset && targetPairs[offset][1] as? String == token.text)
        }
        #expect(sourcePairs.last?[0] as? Int == 511 && targetPairs.last?[0] as? Int == 511)
        #expect(row["sourceText"] as? String == input[0].sourceText)
        #expect(row["targetText"] as? String == input[0].targetText)
        await client.shutdown()
    }

    @Test func rejectsWholeSentenceFallbackCrossUnitIDsReusedOrNoncontiguousTokens() throws {
        let extended = units + [.init(id: "u1", sourceText: "elsewhere", targetText: "别处", source: [.init(id: "x0", text: "elsewhere")], target: [.init(id: "y0", text: "别"), .init(id: "y1", text: "处")])]
        for response in [
            #"{"alignments":{"u0":[{"s":[0,4],"t":[0,0]}],"u1":[]}}"#,
            #"{"alignments":{"u0":[{"s":[0,0],"t":["y0","y0"]}],"u1":[]}}"#,
            #"{"alignments":{"u0":[{"s":[0,0],"t":[0,0]},{"s":[0,0],"t":[1,1]}],"u1":[]}}"#,
            #"{"alignments":{"u0":[{"s":[0,1,2],"t":[0,0]}],"u1":[]}}"#,
            #"{"alignments":{"u0":[{"s":[1,0],"t":[0,0]}],"u1":[]}}"#,
            #"{"alignments":{"u0":[{"s":[],"t":[0,0]}],"u1":[]}}"#,
            #"{"alignments":{"u0":[]}}"#,
            #"{"alignments":{"u0":[],"u0":[],"u1":[]}}"#,
            #"{"alignments":{"u0":[{"s":[0,0],"s":[1,1],"t":[0,0]}],"u1":[]}}"#,
            #"{"alignments":{"u0":[{"s":[0,0],"t":[0,0],"text":"invented"}],"u1":[]}}"#
        ] {
            #expect(throws: PDFPhraseAlignmentError.invalidResponse) { try PDFPhraseAlignmentTranslator.decode(response, units: extended) }
        }
    }

    @Test func rejectsInvalidInputBeforeConnectingAndAcceptsReverseDirection() async throws {
        let backend = PhraseAlignmentBackend(responses: [#"{"alignments":{"u0":[]}}"#]), client = PDFPhraseAlignmentTranslator(backend: backend)
        for invalid: [PDFPhraseAlignmentUnit] in [[], [.init(id: "u0", sourceText: "x", targetText: "中", source: [.init(id: "dup", text: "x")], target: [.init(id: "dup", text: "中")])], [.init(id: "u0", sourceText: "x", targetText: "中", source: [], target: [.init(id: "t0", text: "中")])]] {
            await #expect(throws: PDFPhraseAlignmentError.invalidInput) { try await client.align(invalid, source: "en", target: "zh-Hans") }
        }
        #expect(await backend.inputs.isEmpty)
        _ = try await client.align(units, source: "zh-Hans", target: "en")
        #expect(await backend.inputs.count == 1)
        await client.shutdown()
    }

    @Test func invalidReturnedShapeRetriesOnceButTransportFailureDoesNotRetry() async throws {
        let backend = PhraseAlignmentBackend(responses: [#"{"alignments":{"u0":[{"s":[0,0],"t":[0,99]}]}}"#, valid])
        let client = PDFPhraseAlignmentTranslator(backend: backend)
        _ = try await client.align(units, source: "en", target: "zh-Hans")
        #expect(await backend.inputs.count == 2); #expect(await backend.released == ["phrase-1", "phrase-2"])
        #expect(await backend.inputs[0] == backend.inputs[1])
        await client.shutdown()
        let denied = PhraseAlignmentBackend(responses: [valid], failure: .authentication), deniedClient = PDFPhraseAlignmentTranslator(backend: denied)
        do { _ = try await deniedClient.align(units, source: "en", target: "zh-Hans"); Issue.record("Accepted authentication failure") }
        catch CodexBackendError.authentication { }
        #expect(await denied.inputs.count == 1); #expect(await denied.released == ["phrase-1"])
        await deniedClient.shutdown()
    }

    @Test func cancellationOrShutdownDuringSessionCleanupCannotPublishSuccessfulMapping() async throws {
        for shutdown in [false, true] {
            let backend = PhraseAlignmentBackend(responses: [valid], holdRelease: true), client = PDFPhraseAlignmentTranslator(backend: backend)
            let input = units
            let task = Task { try await client.align(input, source: "en", target: "zh-Hans") }
            for _ in 0..<200 { if await backend.released.count == 1 { break }; try await Task.sleep(for: .milliseconds(1)) }
            #expect(await backend.released.count == 1)
            if shutdown { await client.shutdown() } else { task.cancel() }
            await backend.continueRelease()
            do { _ = try await task.value; Issue.record("Published mapping after cancellation or shutdown") }
            catch { #expect(error is CancellationError) }
            #expect(await backend.inputs.count == 1)
            await client.shutdown()
        }
    }
}

private actor PhraseAlignmentBackend: PassageRefinementBackend {
    let responses: [String]
    let failure: CodexBackendError?
    let holdRelease: Bool
    private var releaseGate: CheckedContinuation<Void, Never>?
    private(set) var inputs: [String] = [], instructions: [String] = [], released: [String] = []
    init(responses: [String], failure: CodexBackendError? = nil, holdRelease: Bool = false) { self.responses = responses; self.failure = failure; self.holdRelease = holdRelease }
    func startSession(instructions: String) async throws -> String { self.instructions.append(instructions); return "phrase-\(self.instructions.count)" }
    func send(threadID: String, text: String, onDelta: @escaping @Sendable (String) -> Void) async throws -> BackendTurnResult {
        inputs.append(text); if let failure { throw failure }
        return BackendTurnResult(text: responses[min(inputs.count - 1, responses.count - 1)], firstDeltaSeconds: 0.01, totalSeconds: 0.1)
    }
    func sendStructured(threadID: String, text: String, schema: RPCObject, onDelta: @escaping @Sendable (String) -> Void) async throws -> BackendTurnResult { try await send(threadID: threadID, text: text, onDelta: onDelta) }
    func releaseSession(threadID: String) async { released.append(threadID); if holdRelease { await withCheckedContinuation { releaseGate = $0 } } }
    func continueRelease() { releaseGate?.resume(); releaseGate = nil }
    func shutdown() async {}
}
