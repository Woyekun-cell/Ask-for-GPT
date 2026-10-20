import Foundation
import Testing
@testable import AskGPTCore

struct PDFSentenceAlignmentTranslatorTests {
    private var paragraphs: [PDFSentenceAlignmentParagraph] {
        [.init(id: "p0", source: [.init(id: "s0", text: "A first sentence."), .init(id: "s1", text: "A second sentence.")],
               target: [.init(id: "t0", text: "第一句。"), .init(id: "t1", text: "第二句。")])]
    }

    @Test func alignmentSelectsOnlyIDsAndDoesNotRewriteCachedSentences() async throws {
        let backend = SentenceAlignmentBackend(response: #"{"alignments":{"s0":["t0"],"s1":["t1"]}}"#)
        let client = PDFSentenceAlignmentTranslator(backend: backend)
        let result = try await client.align(paragraphs, source: "en", target: "zh-Hans")
        #expect(result.alignments == ["s0": ["t0"], "s1": ["t1"]])
        let input = try #require(await backend.inputs.first)
        let object = try #require(JSONSerialization.jsonObject(with: Data(input.utf8)) as? [String: Any])
        let rows = try #require(object["quoted_paragraphs"] as? [[String: Any]])
        #expect((rows[0]["source"] as? [[String: String]])?[0]["text"] == "A first sentence.")
        #expect((rows[0]["target"] as? [[String: String]])?[0]["text"] == "第一句。")
        #expect(await backend.instructions.first?.contains("Do not translate") == true)
        #expect(await backend.instructions.first?.contains("untrusted") == true)
        #expect(await backend.released == ["alignment-1"])
        let schema = try #require(await backend.schemas.first)
        let top = try #require(schema.value["properties"] as? [String: Any])
        #expect(Set(top.keys) == ["alignments"])
        await client.shutdown()
    }

    @Test func supportsSplitMergedUnmatchedAndSemanticReorderingWithoutOrdinalGuessing() throws {
        let p = paragraphs
        #expect(try PDFSentenceAlignmentTranslator.decode(#"{"alignments":{"s0":["t0","t1"],"s1":[]}}"#, paragraphs: p) == ["s0": ["t0", "t1"], "s1": []])
        #expect(try PDFSentenceAlignmentTranslator.decode(#"{"alignments":{"s0":["t0"],"s1":["t0"]}}"#, paragraphs: p) == ["s0": ["t0"], "s1": ["t0"]])
        #expect(try PDFSentenceAlignmentTranslator.decode(#"{"alignments":{"s0":["t1"],"s1":["t0"]}}"#, paragraphs: p) == ["s0": ["t1"], "s1": ["t0"]])
    }

    @Test func rejectsMissingUnknownDuplicateCrossParagraphOrOutOfOrderIDs() throws {
        let p = paragraphs + [.init(id: "p1", source: [.init(id: "s2", text: "Elsewhere.")], target: [.init(id: "t2", text: "另一段。")])]
        for response in [
            #"{"alignments":{"s0":["t0"],"s1":["t1"]}}"#,
            #"{"alignments":{"s0":["t0"],"s1":["t1"],"other":[]}}"#,
            #"{"alignments":{"s0":["t0","t0"],"s1":["t1"],"s2":[]}}"#,
            #"{"alignments":{"s0":["t2"],"s1":["t1"],"s2":[]}}"#,
            #"{"alignments":{"s0":["t1","t0"],"s1":[],"s2":[]}}"#,
            #"{"alignments":{"s0":["t0"],"s0":["t1"],"s1":[],"s2":[]}}"#,
            #"{"alignments":{"s0":["t0"],"s1":[],"s2":[]},"text":"rewritten"}"#
        ] {
            #expect(throws: PDFSentenceAlignmentError.invalidResponse) {
                try PDFSentenceAlignmentTranslator.decode(response, paragraphs: p)
            }
        }
    }

    @Test func rejectsManyToManyAndGroupsLargerThanThreeSentences() throws {
        #expect(throws: PDFSentenceAlignmentError.invalidResponse) {
            try PDFSentenceAlignmentTranslator.decode(#"{"alignments":{"s0":["t0","t1"],"s1":["t1"]}}"#, paragraphs: paragraphs)
        }
        let p = [PDFSentenceAlignmentParagraph(id: "p", source: (0..<4).map { .init(id: "s\($0)", text: "Sentence \($0).") }, target: [.init(id: "t0", text: "译句。")])]
        #expect(throws: PDFSentenceAlignmentError.invalidResponse) {
            try PDFSentenceAlignmentTranslator.decode(#"{"alignments":{"s0":["t0"],"s1":["t0"],"s2":["t0"],"s3":["t0"]}}"#, paragraphs: p)
        }
    }

    @Test func targetlessParagraphIsUnmatchedWithoutConnectingToTheModel() async throws {
        let backend = SentenceAlignmentBackend(response: "{}"), client = PDFSentenceAlignmentTranslator(backend: backend)
        let p = [PDFSentenceAlignmentParagraph(id: "p", source: [.init(id: "s0", text: "Untranslated source.")], target: [])]
        let result = try await client.align(p, source: "en", target: "zh-Hans")
        #expect(result.alignments == ["s0": []]); #expect(result.totalSeconds == 0)
        #expect(await backend.inputs.isEmpty); #expect(await backend.instructions.isEmpty)
        await client.shutdown()
    }

    @Test func malformedInputIsRejectedBeforeAnyModelSession() async throws {
        let backend = SentenceAlignmentBackend(response: "{}"), client = PDFSentenceAlignmentTranslator(backend: backend)
        let variants: [[PDFSentenceAlignmentParagraph]] = [[],
            [.init(id: "p", source: [.init(id: "s0", text: "")], target: [])],
            [.init(id: "p", source: [.init(id: "s0", text: "A."), .init(id: "s0", text: "B.")], target: [])],
            [.init(id: "p", source: [.init(id: "s0", text: "A.")], target: [.init(id: "s0", text: "中。")])],
            [.init(id: "p", source: [.init(id: "s0", text: String(repeating: "a", count: 60_001))], target: [])]
        ]
        for p in variants {
            await #expect(throws: PDFSentenceAlignmentError.invalidInput) { try await client.align(p, source: "en", target: "zh-Hans") }
        }
        #expect(await backend.instructions.isEmpty)
        await client.shutdown()
    }

    @Test func invalidAnswerRetriesOnceWithFreshSessionAndSameIDOnlySchema() async throws {
        let backend = SentenceAlignmentBackend(responses: [#"{"alignments":{"s0":["other"],"s1":[]}}"#, #"{"alignments":{"s0":["t0"],"s1":["t1"]}}"#])
        let client = PDFSentenceAlignmentTranslator(backend: backend)
        _ = try await client.align(paragraphs, source: "en", target: "zh-Hans")
        let inputs = await backend.inputs, schemas = await backend.schemas
        #expect(inputs.count == 2); #expect(inputs[0] == inputs[1])
        #expect(NSDictionary(dictionary: schemas[0].value).isEqual(to: schemas[1].value))
        #expect(await backend.released == ["alignment-1", "alignment-2"])
        await client.shutdown()
    }

    @Test func authenticationAndCancellationNeverRetryAndReleaseTheSession() async throws {
        let denied = SentenceAlignmentBackend(response: "{}", failure: .authentication), deniedClient = PDFSentenceAlignmentTranslator(backend: denied)
        do { _ = try await deniedClient.align(paragraphs, source: "en", target: "zh-Hans"); Issue.record("Authentication failure accepted") }
        catch CodexBackendError.authentication { }
        #expect(await denied.inputs.count == 1); #expect(await denied.released == ["alignment-1"])
        await deniedClient.shutdown()
        let held = SentenceAlignmentBackend(response: "{}", hold: true), heldClient = PDFSentenceAlignmentTranslator(backend: held)
        let p = paragraphs
        let task = Task { try await heldClient.align(p, source: "en", target: "zh-Hans") }
        for _ in 0..<100 { if await held.inputs.count == 1 { break }; try await Task.sleep(for: .milliseconds(1)) }
        task.cancel()
        do { _ = try await task.value; Issue.record("Cancelled alignment accepted") } catch { #expect(error is CancellationError) }
        #expect(await held.inputs.count == 1); #expect(await held.released == ["alignment-1"])
        await heldClient.shutdown()
    }
}

private actor SentenceAlignmentBackend: PassageRefinementBackend {
    let responses: [String]
    let failure: CodexBackendError?
    let hold: Bool
    private(set) var inputs: [String] = [], instructions: [String] = [], released: [String] = []
    private(set) var schemas: [RPCObject] = []
    init(response: String, failure: CodexBackendError? = nil, hold: Bool = false) { self.responses = [response]; self.failure = failure; self.hold = hold }
    init(responses: [String]) { self.responses = responses; self.failure = nil; self.hold = false }
    func startSession(instructions: String) async throws -> String { self.instructions.append(instructions); return "alignment-\(self.instructions.count)" }
    func send(threadID: String, text: String, onDelta: @escaping @Sendable (String) -> Void) async throws -> BackendTurnResult {
        inputs.append(text)
        if let failure { throw failure }
        if hold { try await Task.sleep(for: .seconds(30)) }
        return BackendTurnResult(text: responses[min(inputs.count - 1, responses.count - 1)], firstDeltaSeconds: 0.01, totalSeconds: 0.1)
    }
    func sendStructured(threadID: String, text: String, schema: RPCObject, onDelta: @escaping @Sendable (String) -> Void) async throws -> BackendTurnResult { schemas.append(schema); return try await send(threadID: threadID, text: text, onDelta: onDelta) }
    func releaseSession(threadID: String) async { released.append(threadID) }
    func shutdown() async {}
}
