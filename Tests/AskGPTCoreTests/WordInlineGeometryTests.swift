import AppKit
import Foundation
import Testing
@testable import AskGPTCore

struct WordInlineGeometryTests {
    @Test @MainActor func ninthCandidateSurvivesEightEarlierClippedCandidates() async throws {
        let input = WordInlineProbeInput(expectedParagraph: "resuts", issueStartUTF16: 0, issueLengthUTF16: 6, original: "resuts")
        let candidates = (0..<9).map { WordInlineBatchItem(id: "item-\($0)", input: input) }
        _ = try WordInlineGeometryPolicy.batchGroups(candidates)
        let clip = CGRect(x: 0, y: 0, width: 100, height: 100)
        var barriers = 0
        let result = try await WordInlineGeometryPolicy.verifiedBatchSubset(Array(candidates.indices), prove: { index in
            let bounds = index < 8 ? CGRect(x: 110, y: 10, width: 20, height: 10) : CGRect(x: 10, y: 10, width: 20, height: 10)
            try WordInlineGeometryPolicy.validateBounds(bounds, graphemeBounds: [bounds], clip: clip, screens: [clip])
            return candidates[index].id
        }, finalBarrier: { barriers += 1 })
        #expect(result == ["item-8"])
        #expect(barriers == 1)
    }
    @Test @MainActor func successfulCandidateBudgetIsStableAndStopsAfterEightProofs() async throws {
        let input = WordInlineProbeInput(expectedParagraph: "resuts", issueStartUTF16: 0, issueLengthUTF16: 6, original: "resuts")
        let candidates = (0..<12).map { WordInlineBatchItem(id: "item-\($0)", input: input) }
        _ = try WordInlineGeometryPolicy.batchGroups(candidates)
        for _ in 0..<2 {
            var proved: [String] = [], barriers = 0
            let result = try await WordInlineGeometryPolicy.verifiedBatchSubset(candidates, prove: { item in
                proved.append(item.id); return item.id
            }, finalBarrier: { barriers += 1 })
            #expect(result == ["item-0", "item-1", "item-2", "item-3", "item-4", "item-5", "item-6", "item-7"])
            #expect(proved == result)
            #expect(barriers == 1)
        }
    }
    @Test func validatesEveryCandidateThroughThe128ItemBoundary() throws {
        let input = WordInlineProbeInput(expectedParagraph: "resuts", issueStartUTF16: 0, issueLengthUTF16: 6, original: "resuts")
        let candidates = (0..<128).map { WordInlineBatchItem(id: "item-\($0)", input: input) }
        let groups = try WordInlineGeometryPolicy.batchGroups(candidates)
        #expect(groups.count == 1 && groups[0].count == 128)
        #expect(throws: WordInlineGeometryFailure.invalidBatch) {
            try WordInlineGeometryPolicy.batchGroups(candidates + [.init(id: "item-128", input: input)])
        }
        let malformed = WordInlineBatchItem(id: "malformed", input: .init(expectedParagraph: "resuts", issueStartUTF16: 0, issueLengthUTF16: 6, original: "result"))
        for index in [8, 127] {
            var values = candidates; values[index] = malformed
            #expect(throws: WordInlineGeometryFailure.originalMismatch) { try WordInlineGeometryPolicy.batchGroups(values) }
        }
    }
    @Test @MainActor func reachingEightProofsStillRequiresTheSharedFinalBarrier() async throws {
        await #expect(throws: WordInlineSubsetTestFailure.incompleteTraversal) {
            try await WordInlineGeometryPolicy.verifiedBatchSubset(Array(0..<12), prove: { $0 },
                finalBarrier: { throw WordInlineSubsetTestFailure.incompleteTraversal })
        }
    }
    @Test @MainActor func verifiedSubsetKeepsUniqueCandidateAfterRepeatedAndAbsentParagraphs() async throws {
        let repeated = WordInlineProbeInput(expectedParagraph: "The colour was recorded.", issueStartUTF16: 4, issueLengthUTF16: 6, original: "colour")
        let unique = WordInlineProbeInput(expectedParagraph: "Appla test.", issueStartUTF16: 0, issueLengthUTF16: 5, original: "Appla")
        let absent = WordInlineProbeInput(expectedParagraph: "Outside this viewport.", issueStartUTF16: 0, issueLengthUTF16: 7, original: "Outside")
        let fragment = "The colour was recorded.\nAppla test.\nThe colour was recorded."
        let candidates = [WordInlineBatchItem(id: "repeated", input: repeated), .init(id: "unique", input: unique), .init(id: "absent", input: absent)]
        var barriers = 0
        let result = try await WordInlineGeometryPolicy.verifiedBatchSubset(candidates, prove: { item in
            let matches = try WordInlineGeometryPolicy.matches(item.input, in: fragment, baseUTF16: 0)
            try WordInlineGeometryPolicy.requireUniqueMatch(matches.count)
            return item.id
        }, finalBarrier: { barriers += 1 })
        #expect(result == ["unique"])
        #expect(barriers == 1)
    }
    @Test @MainActor func verifiedSubsetSkipsOnlyClippedOrMultilineGeometry() async throws {
        let clip = CGRect(x: 0, y: 0, width: 100, height: 100)
        let valid = CGRect(x: 10, y: 10, width: 20, height: 10)
        let clipped = CGRect(x: 90, y: 10, width: 20, height: 10)
        let multiline = CGRect(x: 10, y: 20, width: 40, height: 30)
        let values = [("clipped", clipped, [clipped]), ("valid", valid, [valid]),
                      ("multiline", multiline, [CGRect(x: 10, y: 20, width: 10, height: 10), CGRect(x: 40, y: 40, width: 10, height: 10)])]
        let result = try await WordInlineGeometryPolicy.verifiedBatchSubset(values, prove: { value in
            try WordInlineGeometryPolicy.validateBounds(value.1, graphemeBounds: value.2, clip: clip, screens: [clip])
            return value.0
        }, finalBarrier: {})
        #expect(result == ["valid"])
    }
    @Test @MainActor func subsetStillRejectsEveryMarkerWhenFinalSourceViewportOrWindowChanged() async throws {
        let clip = CGRect(x: 0, y: 0, width: 100, height: 100), window = CGRect(x: 0, y: 0, width: 200, height: 200)
        let initial = WordInlineViewportStamp(sourceHash: "source", visibleRange: NSRange(location: 0, length: 30), clip: clip, windowFrame: window)
        let changed = [WordInlineViewportStamp(sourceHash: "changed", visibleRange: initial.visibleRange, clip: clip, windowFrame: window),
                       WordInlineViewportStamp(sourceHash: "source", visibleRange: NSRange(location: 1, length: 30), clip: clip, windowFrame: window),
                       WordInlineViewportStamp(sourceHash: "source", visibleRange: initial.visibleRange, clip: clip.offsetBy(dx: 1, dy: 0), windowFrame: window),
                       WordInlineViewportStamp(sourceHash: "source", visibleRange: initial.visibleRange, clip: clip, windowFrame: window.offsetBy(dx: 1, dy: 0))]
        for current in changed {
            await #expect(throws: WordInlineGeometryFailure.viewportChanged) {
                try await WordInlineGeometryPolicy.verifiedBatchSubset([0, 1], prove: { item in
                    if item == 1 { throw WordInlineGeometryFailure.ambiguous }; return "proved"
                }, finalBarrier: { try WordInlineGeometryPolicy.requireSameViewport(initial, current) })
            }
        }
    }
    @Test @MainActor func sourceChangeDuringOneCandidateCannotReturnEarlierProofs() async throws {
        await #expect(throws: WordInlineGeometryFailure.viewportChanged) {
            try await WordInlineGeometryPolicy.verifiedBatchSubset([0, 1], prove: { item in
                if item == 1 { throw WordInlineGeometryFailure.viewportChanged }; return "proved"
            }, finalBarrier: {})
        }
    }
    @Test @MainActor func emptySubsetStillRequiresSharedBarrierAndNeverMasksTraversalFailure() async throws {
        var barriers = 0
        let empty: [String] = try await WordInlineGeometryPolicy.verifiedBatchSubset([0], prove: { _ -> String in
            throw WordInlineGeometryFailure.noMatch
        }, finalBarrier: { barriers += 1 })
        #expect(empty.isEmpty && barriers == 1)
        await #expect(throws: WordInlineSubsetTestFailure.incompleteTraversal) {
            try await WordInlineGeometryPolicy.verifiedBatchSubset([0], prove: { _ in "proved" },
                finalBarrier: { throw WordInlineSubsetTestFailure.incompleteTraversal })
        }
    }
    @Test func batchGroupsExactParagraphOnceWhilePreservingInputOrder() throws {
        let a = WordInlineProbeInput(expectedParagraph: "The resuts are clear.", issueStartUTF16: 4, issueLengthUTF16: 6, original: "resuts")
        let b = WordInlineProbeInput(expectedParagraph: "Our resuts are clear.", issueStartUTF16: 4, issueLengthUTF16: 6, original: "resuts")
        let c = WordInlineProbeInput(expectedParagraph: "The resuts are clear.", issueStartUTF16: 0, issueLengthUTF16: 3, original: "The")
        #expect(try WordInlineGeometryPolicy.batchGroups([.init(id: "a", input: a), .init(id: "b", input: b), .init(id: "c", input: c)]) == [[0, 2], [1]])
    }
    @Test func batchGroupingNeverCollapsesCanonicalEquivalentSourceBytes() throws {
        let a = WordInlineProbeInput(expectedParagraph: "é resuts", issueStartUTF16: 2, issueLengthUTF16: 6, original: "resuts")
        let b = WordInlineProbeInput(expectedParagraph: "e\u{301} resuts", issueStartUTF16: 3, issueLengthUTF16: 6, original: "resuts")
        #expect(try WordInlineGeometryPolicy.batchGroups([.init(id: "a", input: a), .init(id: "b", input: b)]) == [[0], [1]])
    }
    @Test func invalidBatchSizeDuplicateIDOrMalformedItemRejectsWholeBatch() {
        let input = WordInlineProbeInput(expectedParagraph: "resuts", issueStartUTF16: 0, issueLengthUTF16: 6, original: "resuts")
        #expect(throws: WordInlineGeometryFailure.invalidBatch) { try WordInlineGeometryPolicy.batchGroups([]) }
        #expect(throws: WordInlineGeometryFailure.invalidBatch) { try WordInlineGeometryPolicy.batchGroups((0..<129).map { .init(id: String($0), input: input) }) }
        #expect(throws: WordInlineGeometryFailure.invalidBatch) { try WordInlineGeometryPolicy.batchGroups([.init(id: "a", input: input), .init(id: "a", input: input)]) }
        #expect(throws: WordInlineGeometryFailure.invalidBatch) { try WordInlineGeometryPolicy.batchGroups([.init(id: "private\ntext", input: input)]) }
        #expect(throws: WordInlineGeometryFailure.originalMismatch) {
            try WordInlineGeometryPolicy.batchGroups([.init(id: "a", input: input), .init(id: "b", input: .init(expectedParagraph: "resuts", issueStartUTF16: 0, issueLengthUTF16: 6, original: "result"))])
        }
    }
    @Test func finalBarrierRejectsChangedSourceRangeClipOrWindow() throws {
        let clip = CGRect(x: 10, y: 20, width: 100, height: 100), window = CGRect(x: 0, y: 0, width: 500, height: 500)
        let initial = WordInlineViewportStamp(sourceHash: "A", visibleRange: NSRange(location: 0, length: 100), clip: clip, windowFrame: window)
        try WordInlineGeometryPolicy.requireSameViewport(initial, initial)
        for current in [WordInlineViewportStamp(sourceHash: "B", visibleRange: initial.visibleRange, clip: clip, windowFrame: window),
                        WordInlineViewportStamp(sourceHash: "A", visibleRange: NSRange(location: 1, length: 100), clip: clip, windowFrame: window),
                        WordInlineViewportStamp(sourceHash: "A", visibleRange: initial.visibleRange, clip: clip.offsetBy(dx: 0, dy: 1), windowFrame: window),
                        WordInlineViewportStamp(sourceHash: "A", visibleRange: initial.visibleRange, clip: clip, windowFrame: window.offsetBy(dx: 1, dy: 0))] {
            #expect(throws: WordInlineGeometryFailure.viewportChanged) { try WordInlineGeometryPolicy.requireSameViewport(initial, current) }
        }
    }
    @Test func unknownCharacterCountIsNeverEvidenceOfEmptyPageText() {
        #expect(WordInlineGeometryPolicy.leafTextIsUnverified(characterCount: nil, actualChildCount: 0, inLayout: true))
        #expect(WordInlineGeometryPolicy.leafTextIsUnverified(characterCount: 50, actualChildCount: 0, inLayout: true))
        #expect(!WordInlineGeometryPolicy.leafTextIsUnverified(characterCount: 0, actualChildCount: 0, inLayout: true))
        #expect(!WordInlineGeometryPolicy.leafTextIsUnverified(characterCount: nil, actualChildCount: 2, inLayout: true))
    }
    @Test func explicitEmptyVisibleChildrenNeverEnumerateHiddenChildren() {
        let plan = WordInlineGeometryPolicy.childrenPlan(visibleCount: 0, visibleUnavailable: false, actualChildCount: 3, childAttributesDeclared: true)
        #expect(plan == WordInlineChildrenPlan(source: .visible, count: 0, complete: true))
    }
    @Test func failedOrUndeclaredChildReadsCannotCertifyACompleteTree() {
        #expect(!WordInlineGeometryPolicy.childrenPlan(visibleCount: nil, visibleUnavailable: false, actualChildCount: 0, childAttributesDeclared: true).complete)
        #expect(!WordInlineGeometryPolicy.childrenPlan(visibleCount: nil, visibleUnavailable: true, actualChildCount: nil, childAttributesDeclared: true).complete)
        #expect(!WordInlineGeometryPolicy.childrenPlan(visibleCount: nil, visibleUnavailable: true, actualChildCount: nil, childAttributesDeclared: nil).complete)
        // Successful attribute-list declaration of no exposed children is not an AXChildren count=0 proof.
        let declaredLeaf = WordInlineGeometryPolicy.childrenPlan(visibleCount: nil, visibleUnavailable: true, actualChildCount: nil, childAttributesDeclared: false)
        #expect(declaredLeaf.complete && declaredLeaf.source == nil)
    }
    @Test func onlyKnownEmptyActualChildrenPermitBoundedLeafValue() {
        #expect(WordInlineGeometryPolicy.canReadLayoutLeaf(characterCount: 60, actualChildCount: 0, inLayout: true, hasFrame: true))
        #expect(!WordInlineGeometryPolicy.canReadLayoutLeaf(characterCount: 60, actualChildCount: nil, inLayout: true, hasFrame: true))
        #expect(!WordInlineGeometryPolicy.canReadLayoutLeaf(characterCount: 60, actualChildCount: 2, inLayout: true, hasFrame: true))
        #expect(!WordInlineGeometryPolicy.canReadLayoutLeaf(characterCount: 16001, actualChildCount: 0, inLayout: true, hasFrame: true))
        #expect(!WordInlineGeometryPolicy.canReadLayoutLeaf(characterCount: -1, actualChildCount: 0, inLayout: true, hasFrame: true))
    }
    @Test func rejectsSecureOrUnknownRoleBeforeAnyTextRead() {
        #expect(WordInlineGeometryPolicy.permitsRole("AXTextArea", subrole: nil))
        #expect(!WordInlineGeometryPolicy.permitsRole("AXSecureTextField", subrole: nil))
        #expect(!WordInlineGeometryPolicy.permitsRole("AXTextField", subrole: "AXSecureTextField"))
        #expect(!WordInlineGeometryPolicy.permitsRole(nil, subrole: nil))
    }
    @Test func neverTreatsDuplicateContainersAtSamePositionAsUnique() throws {
        try WordInlineGeometryPolicy.requireUniqueMatch(1)
        #expect(throws: WordInlineGeometryFailure.ambiguous) { try WordInlineGeometryPolicy.requireUniqueMatch(2) }
        #expect(throws: WordInlineGeometryFailure.noMatch) { try WordInlineGeometryPolicy.requireUniqueMatch(0) }
    }
    // A UTF-8/Character offset would point at the wrong word after the emoji.
    @Test func mapsExactUTF16IssueWithinVisibleSlice() throws {
        let input = WordInlineProbeInput(expectedParagraph: "🧬 resuts.", issueStartUTF16: 3, issueLengthUTF16: 6, original: "resuts")
        try WordInlineGeometryPolicy.validate(input)
        let matches = try WordInlineGeometryPolicy.matches(input, in: "Lead. 🧬 resuts. Tail.", baseUTF16: 100)
        #expect(matches == [WordInlineRangeMatch(paragraph: NSRange(location: 106, length: 10), issue: NSRange(location: 109, length: 6))])
    }
    @Test func rejectsSplitSurrogateAndSplitCombiningGrapheme() {
        for input in [WordInlineProbeInput(expectedParagraph: "🧬 resuts", issueStartUTF16: 1, issueLengthUTF16: 1, original: "x"),
                      WordInlineProbeInput(expectedParagraph: "e\u{301} resuts", issueStartUTF16: 0, issueLengthUTF16: 1, original: "e")] {
            #expect(throws: WordInlineGeometryFailure.invalidRange) { try WordInlineGeometryPolicy.validate(input) }
        }
    }
    @Test func rejectsOverflowEmptyAndMismatchedOriginal() {
        #expect(throws: WordInlineGeometryFailure.invalidRange) { try WordInlineGeometryPolicy.validate(.init(expectedParagraph: "resuts", issueStartUTF16: Int.max, issueLengthUTF16: 1, original: "x")) }
        #expect(throws: WordInlineGeometryFailure.invalidRange) { try WordInlineGeometryPolicy.validate(.init(expectedParagraph: "resuts", issueStartUTF16: 0, issueLengthUTF16: 0, original: "")) }
        #expect(throws: WordInlineGeometryFailure.originalMismatch) { try WordInlineGeometryPolicy.validate(.init(expectedParagraph: "resuts", issueStartUTF16: 0, issueLengthUTF16: 6, original: "result")) }
    }
    @Test func literalMatchingDoesNotNormalizeCanonicalEquivalentSource() throws {
        let input = WordInlineProbeInput(expectedParagraph: "é resuts", issueStartUTF16: 2, issueLengthUTF16: 6, original: "resuts")
        #expect(try WordInlineGeometryPolicy.matches(input, in: "e\u{301} resuts", baseUTF16: 0).isEmpty)
    }
    @Test func countsOverlappingRepeatedParagraphsInsteadOfGuessing() throws {
        let input = WordInlineProbeInput(expectedParagraph: "aaa", issueStartUTF16: 0, issueLengthUTF16: 3, original: "aaa")
        #expect(try WordInlineGeometryPolicy.matches(input, in: "aaaa", baseUTF16: 0).count == 2)
    }
    @Test func rejectsOversizedFragmentsAndAbsoluteOffsetOverflow() {
        let input = WordInlineProbeInput(expectedParagraph: "resuts", issueStartUTF16: 0, issueLengthUTF16: 6, original: "resuts")
        #expect(throws: WordInlineGeometryFailure.tooLong) { try WordInlineGeometryPolicy.matches(input, in: String(repeating: "x", count: 16001), baseUTF16: 0) }
        #expect(throws: WordInlineGeometryFailure.invalidRange) { try WordInlineGeometryPolicy.matches(input, in: "resuts", baseUTF16: Int.max) }
    }
    @Test func permitsSingleLineFullyInsideViewportAndNegativeCoordinateDisplay() throws {
        try WordInlineGeometryPolicy.validateBounds(CGRect(x: -400, y: 300, width: 30, height: 20),
            graphemeBounds: [CGRect(x: -400, y: 300, width: 10, height: 20), CGRect(x: -390, y: 300, width: 20, height: 20)],
            clip: CGRect(x: -500, y: 100, width: 400, height: 500), screens: [CGRect(x: -1000, y: 0, width: 1000, height: 800)])
    }
    @Test func rejectsMultilineUnionEvenWhenItFitsWindow() {
        #expect(throws: WordInlineGeometryFailure.multiline) {
            try WordInlineGeometryPolicy.validateBounds(CGRect(x: 20, y: 20, width: 100, height: 40),
                graphemeBounds: [CGRect(x: 100, y: 20, width: 20, height: 20), CGRect(x: 20, y: 40, width: 10, height: 20)],
                clip: CGRect(x: 0, y: 0, width: 800, height: 800), screens: [CGRect(x: 0, y: 0, width: 1000, height: 1000)])
        }
    }
    @Test func rejectsClippedBoundsAndDisplayGap() {
        let rect = CGRect(x: 90, y: 20, width: 30, height: 20)
        #expect(throws: WordInlineGeometryFailure.offscreen) {
            try WordInlineGeometryPolicy.validateBounds(rect, graphemeBounds: [rect], clip: CGRect(x: 0, y: 0, width: 100, height: 100), screens: [CGRect(x: 0, y: 0, width: 1000, height: 1000)])
        }
        #expect(throws: WordInlineGeometryFailure.offscreen) {
            try WordInlineGeometryPolicy.validateBounds(rect, graphemeBounds: [rect], clip: CGRect(x: 0, y: 0, width: 1000, height: 1000), screens: [CGRect(x: 0, y: 0, width: 100, height: 100), CGRect(x: 110, y: 0, width: 100, height: 100)])
        }
    }
    @Test func rejectsEmptyNonfiniteOrUnverifiedGeometry() {
        for rect in [CGRect.zero, CGRect(x: CGFloat.infinity, y: 0, width: 1, height: 1), CGRect(x: 0, y: 0, width: -1, height: 1)] {
            #expect(throws: WordInlineGeometryFailure.invalidBounds) {
                try WordInlineGeometryPolicy.validateBounds(rect, graphemeBounds: [rect], clip: CGRect(x: 0, y: 0, width: 100, height: 100), screens: [CGRect(x: 0, y: 0, width: 100, height: 100)])
            }
        }
        #expect(throws: WordInlineGeometryFailure.multiline) {
            try WordInlineGeometryPolicy.validateBounds(CGRect(x: 10, y: 10, width: 20, height: 20), graphemeBounds: [], clip: CGRect(x: 0, y: 0, width: 100, height: 100), screens: [CGRect(x: 0, y: 0, width: 100, height: 100)])
        }
    }
    @Test func detectsMixedFontTraitsWithoutExposingSourceInEncodedFormat() throws {
        let text = NSMutableAttributedString(string: "resuts", attributes: [.font: NSFont.systemFont(ofSize: 12)])
        let uniform = WordInlineFormatInspection.inspect(text, original: "resuts")
        #expect(uniform.textVerified && uniform.fontUniform == true && uniform.sizeUniform == true && uniform.traitsUniform == true)
        text.addAttribute(.font, value: NSFont.boldSystemFont(ofSize: 12), range: NSRange(location: 0, length: 3))
        let mixed = WordInlineFormatInspection.inspect(text, original: "resuts")
        #expect(mixed.fontUniform == false && mixed.sizeUniform == true && mixed.traitsUniform == false && mixed.allAttributesUniform == false)
        let json = String(decoding: try JSONEncoder().encode(mixed), as: UTF8.self)
        #expect(!json.contains("resuts") && !json.contains("SystemUIFont"))
    }
    @Test func unsupportedFontRepresentationDoesNotGuessUniformTraits() {
        let text = NSAttributedString(string: "resuts", attributes: [NSAttributedString.Key("UnknownSensitiveAttribute"): "private data"])
        let result = WordInlineFormatInspection.inspect(text, original: "resuts")
        #expect(result.textVerified)
        #expect(result.fontUniform == nil && result.traitsUniform == nil)
        #expect(result.attributeKeys.isEmpty && result.unknownAttributeKeyCount == 1)
    }
    @Test func mismatchedAttributedStringCannotCertifyFormatting() {
        let result = WordInlineFormatInspection.inspect(NSAttributedString(string: "result", attributes: [.font: NSFont.systemFont(ofSize: 12)]), original: "resuts")
        #expect(!result.textVerified && result.allAttributesUniform == nil && result.fontUniform == nil)
    }
}

private enum WordInlineSubsetTestFailure: Error, Equatable { case incompleteTraversal }
