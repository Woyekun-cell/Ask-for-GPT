import Foundation
import Testing
@testable import AskGPTCore

struct BilingualDocumentTests {
    @Test func webpageIsOneImmutableAccessibilityPageWithSourceMetadata() async throws {
        let url = URL(string: "https://example.invalid/current-paper#results")!
        let document = try WebTranslationDocument(text: "First paragraph.\n\nSecond paragraph.", title: " Current page ", url: url)
        let source: any BilingualDocument = document
        #expect(source.kind == .webpage)
        #expect(source.pageCount == 1)
        #expect(source.title == "Current page")
        #expect(document.url == url)
        let page = try await source.page(at: 0)
        #expect(page.pageIndex == 0)
        #expect(page.extractionMethod == .accessibility)
        #expect(page.blocks.map(\.originalText) == ["First paragraph.", "Second paragraph."])
        #expect(page.blocks.allSatisfy { $0.pageIndex == 0 })
        #expect(try await document.page(at: 0) == page)
    }

    @Test func repeatedParagraphsStayInOrderWithDistinctStableBlockIDs() async throws {
        let text = "Same paragraph.\n\nDifferent middle.\n\nSame paragraph."
        let first = try WebTranslationDocument(text: text, title: "Paper")
        let repeated = try WebTranslationDocument(text: text, title: "Changed title")
        let blocks = try await first.page(at: 0).blocks
        let repeatedBlocks = try await repeated.page(at: 0).blocks
        #expect(first.documentID == repeated.documentID)
        #expect(blocks == repeatedBlocks)
        #expect(blocks.map(\.originalText) == ["Same paragraph.", "Different middle.", "Same paragraph."])
        #expect(Set(blocks.map(\.blockID)).count == 3)
        #expect(blocks[0].blockID != blocks[2].blockID)
    }

    @Test func webpageIdentityIncludesBodyAndSourceURLButNormalizesLineEndings() throws {
        let url = URL(string: "https://example.invalid/article")!
        let otherURL = URL(string: "https://example.invalid/another")!
        let unix = try WebTranslationDocument(text: "First.\n\nSecond.", title: "Page", url: url)
        let windows = try WebTranslationDocument(text: "First.\r\n\r\nSecond.", title: "Page", url: url)
        let bodyChanged = try WebTranslationDocument(text: "First.\n\nChanged.", title: "Page", url: url)
        let sourceChanged = try WebTranslationDocument(text: "First.\n\nSecond.", title: "Page", url: otherURL)
        #expect(unix.documentID == windows.documentID)
        #expect(unix.documentID != bodyChanged.documentID)
        #expect(unix.documentID != sourceChanged.documentID)
    }

    @Test func longWebpageUsesBoundedOrderedBlocksWithoutLosingWords() async throws {
        let words = (0..<1_000).map { "Gene_\($0)" }
        let text = words.joined(separator: " ")
        let document = try WebTranslationDocument(text: text, title: "")
        let blocks = try await document.page(at: 0).blocks
        #expect(document.title == "网页原文")
        #expect(blocks.count > 1)
        #expect(blocks.allSatisfy { $0.originalText.count <= 1_800 })
        #expect(blocks.map(\.originalText).joined(separator: " ") == text)
    }

    @Test func webpageKeepsScientificIdentifiersMeasurementsAndParagraphOrder() async throws {
        let text = "IL-1β and Gene_007 were measured at 2.0 ng/mL.\n\nTNF-α did not increase (P = 0.08)."
        let document = try WebTranslationDocument(text: text, title: "Scientific text")
        let page = try await document.page(at: 0)
        #expect(page.blocks.map(\.originalText) == text.components(separatedBy: "\n\n"))
    }

    @Test func emptyAndOversizedWebpagesFailBeforeTranslation() {
        #expect(throws: WebTranslationDocumentError.emptyInput) {
            try WebTranslationDocument(text: " \r\n\t", title: "Page")
        }
        #expect(throws: WebTranslationDocumentError.inputTooLong(limitCharacters: 300_000)) {
            try WebTranslationDocument(text: String(repeating: "a", count: 300_001), title: "Page")
        }
    }

    @Test func webpageAcceptsTheDefinedCharacterLimit() async throws {
        let text = String(repeating: "x", count: 300_000)
        let document = try WebTranslationDocument(text: text, title: "Limit")
        let blocks = try await document.page(at: 0).blocks
        #expect(blocks.map(\.originalText).joined() == text)
        #expect(blocks.allSatisfy { $0.originalText.count <= 1_800 })
    }

    @Test func webpageRejectsEveryPageOutsideItsCurrentSinglePage() async throws {
        let document = try WebTranslationDocument(text: "Current page only.", title: "Page")
        for index in [-1, 1, 30] {
            await #expect(throws: WebTranslationDocumentError.pageOutOfBounds(index: index, count: 1)) {
                try await document.page(at: index)
            }
        }
    }

    @Test func cancelledWebpageReadDoesNotReturnItsCachedSnapshot() async throws {
        let document = try WebTranslationDocument(text: "A cached snapshot.", title: "Page")
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try await document.page(at: 0)
        }
        await #expect(throws: CancellationError.self) { try await task.value }
    }

    @Test func cancelledCreationStopsBeforeExposingADocument() async {
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try WebTranslationDocument(text: "No document should be created.", title: "Page")
        }
        await #expect(throws: CancellationError.self) { try await task.value }
    }
}
