import CoreGraphics
import CoreText
import Foundation
import Testing
@testable import AskGPTCore

struct PDFTranslationDocumentTests {
    @Test func wrapsKeepScientificIdentifiersHardHyphensAndSeparateNumbers() throws {
        let text = "Gene IL-\n1β and pre-\nclinical evidence\n1\n2 = 3.0 µm\n\nβ-glucan remained."
        let blocks = try PDFTranslationParagraphs.blocks(text: text, pageIndex: 2, documentID: "document", maximumCharacters: 1_800)
        #expect(blocks.map(\.originalText) == ["Gene IL-1β and pre-clinical evidence 1 2 = 3.0 µm", "β-glucan remained."])
        #expect(blocks.allSatisfy { $0.pageIndex == 2 })
        #expect(Set(blocks.map(\.blockID)).count == blocks.count)
    }

    @Test func longParagraphPreservesWordOrderAndStableIDsWithinLimit() throws {
        let text = (0..<300).map { "Gene_\($0)" }.joined(separator: " ")
        let blocks = try PDFTranslationParagraphs.blocks(text: text, pageIndex: 0, documentID: "same-file", maximumCharacters: 83)
        let repeatBlocks = try PDFTranslationParagraphs.blocks(text: text, pageIndex: 0, documentID: "same-file", maximumCharacters: 83)
        let nextPage = try PDFTranslationParagraphs.blocks(text: text, pageIndex: 1, documentID: "same-file", maximumCharacters: 83)
        #expect(blocks == repeatBlocks)
        #expect(blocks.map(\.originalText).joined(separator: " ") == text)
        #expect(blocks.allSatisfy { $0.originalText.count <= 83 })
        #expect(Set(blocks.map(\.blockID)).isDisjoint(with: nextPage.map(\.blockID)))
    }

    @Test func longUnspacedUnicodeTextIsNotLostWhenChunked() throws {
        let text = String(repeating: "中文β🧬", count: 40)
        let blocks = try PDFTranslationParagraphs.blocks(text: text, pageIndex: 0, documentID: "unicode", maximumCharacters: 17)
        #expect(blocks.allSatisfy { $0.originalText.count <= 17 })
        #expect(blocks.map(\.originalText).joined() == text)
        #expect(try PDFTranslationParagraphs.blocks(text: " \n\t\r\n", pageIndex: 0, documentID: "empty", maximumCharacters: 17).isEmpty)
    }

    @Test func onlySoftDiscretionaryHyphenIsRemovedAcrossLineWrap() throws {
        let blocks = try PDFTranslationParagraphs.blocks(text: "inter\u{00AD}\nleukin\n\nGene-1", pageIndex: 0, documentID: "hyphens", maximumCharacters: 1_800)
        #expect(blocks.map(\.originalText) == ["interleukin", "Gene-1"])
        let identifier = try PDFTranslationParagraphs.blocks(text: "Gene1\u{00AD}\n2", pageIndex: 0,
            documentID: "numeric", maximumCharacters: 1_800)
        #expect(identifier.map(\.originalText) == ["Gene1\u{00AD} 2"])
    }

    @Test func realPDFTextLayerKeepsPageIdentityAndNeverCallsOCR() async throws {
        let data = try fixturePDF(pages: ["First native page.", "Second native page."])
        let document = try PDFTranslationDocument(data: data, title: "Paper", recognize: { _ in throw FixtureError.unexpectedOCR })
        #expect(document.pageCount == 2)
        #expect(document.title == "Paper")
        #expect(document.kind == .pdf)
        let source: any BilingualDocument = document
        #expect(source.pageCount == 2)
        let first = try await document.page(at: 0)
        let second = try await document.page(at: 1)
        #expect(first.extractionMethod == .textLayer)
        #expect(first.blocks.map(\.originalText).joined(separator: " ") == "First native page.")
        #expect(second.blocks.map(\.originalText).joined(separator: " ") == "Second native page.")
        #expect(first.blocks.allSatisfy { $0.pageIndex == 0 })
        #expect(second.blocks.allSatisfy { $0.pageIndex == 1 })
        #expect(await document.originalPDFData() == data)
        let same = try PDFTranslationDocument(data: data)
        #expect(document.documentID == same.documentID)
    }

    @Test func negativeAndPastEndPageIndicesFailClearly() async throws {
        let document = try PDFTranslationDocument(data: fixturePDF(pages: ["One page."]))
        for index in [-1, 1] {
            await #expect(throws: PDFTranslationDocumentError.pageOutOfBounds(index: index, count: 1)) {
                try await document.page(at: index)
            }
        }
    }

    @Test func blankPageRendersItsOwnImageAndUsesOCRThenCachesText() async throws {
        let counter = PDFOCRCallCounter()
        let document = try PDFTranslationDocument(data: fixturePDF(pages: [nil]), recognize: { image in
            await counter.record(width: image.width, height: image.height)
            return [PDFTranslationOCRLine(text: "Scanned scientific text.", bounds: CGRect(x: 0.1, y: 0.7, width: 0.7, height: 0.05))]
        })
        let first = try await document.page(at: 0)
        let repeated = try await document.page(at: 0)
        #expect(first.extractionMethod == .ocr)
        #expect(first.blocks.map(\.originalText) == ["Scanned scientific text."])
        #expect(first == repeated)
        let calls = await counter.snapshot()
        #expect(calls.count == 1)
        #expect(calls.allSatisfy { $0.0 > 0 && $0.1 > 0 && $0.0 <= 2_400 && $0.1 <= 2_400 })
    }

    @Test func realLocalVisionRecognizesAnImageOnlyPDFPage() async throws {
        guard let bitmap = CGContext(data: nil, width: 1_200, height: 300,
            bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { throw FixtureError.cannotCreatePDF }
        bitmap.setFillColor(CGColor(gray: 1, alpha: 1))
        bitmap.fill(CGRect(x: 0, y: 0, width: 1_200, height: 300))
        bitmap.textPosition = CGPoint(x: 30, y: 160)
        let text = NSAttributedString(string: "LOCAL SCANNED TEXT", attributes: [
            NSAttributedString.Key(kCTFontAttributeName as String): CTFontCreateWithName("Helvetica" as CFString, 72, nil),
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 0, alpha: 1)
        ])
        CTLineDraw(CTLineCreateWithAttributedString(text), bitmap)
        guard let image = bitmap.makeImage() else { throw FixtureError.cannotCreatePDF }
        let data = try fixturePDF(pages: [nil], raster: image)
        let document = try PDFTranslationDocument(data: data)
        let page = try await document.page(at: 0)
        #expect(page.extractionMethod == .ocr)
        #expect(page.blocks.map(\.originalText).joined(separator: " ").uppercased().contains("LOCAL SCANNED TEXT"))
        #expect(await document.originalPDFData() == data)
    }

    @Test func emptyOCRResultsStayPerPageErrors() async throws {
        let document = try PDFTranslationDocument(data: fixturePDF(pages: [nil, "Other page survives."]), recognize: { _ in [] })
        await #expect(throws: PDFTranslationDocumentError.noReadableText(pageIndex: 0)) {
            try await document.page(at: 0)
        }
        let other = try await document.page(at: 1)
        #expect(other.blocks.map(\.originalText) == ["Other page survives."])
    }

    @Test func OCRFailureDoesNotMasqueradeAsEmptyTranslation() async throws {
        let document = try PDFTranslationDocument(data: fixturePDF(pages: [nil]), recognize: { _ in throw FixtureError.unexpectedOCR })
        await #expect(throws: PDFTranslationDocumentError.ocrFailed(pageIndex: 0)) {
            try await document.page(at: 0)
        }
    }

    @Test func OCRCancellationPropagatesWithoutBeingReportedAsRecognitionFailure() async throws {
        let document = try PDFTranslationDocument(data: fixturePDF(pages: [nil]), recognize: { _ in throw CancellationError() })
        await #expect(throws: CancellationError.self) { try await document.page(at: 0) }
    }

    @Test func passwordProtectedPDFReportsLockedDocument() throws {
        let data = try fixturePDF(pages: ["Protected fixture."], userPassword: "fixture-user-password")
        #expect(throws: PDFTranslationDocumentError.lockedPDF) { try PDFTranslationDocument(data: data) }
    }

    @Test func obviousTwoColumnScanOrdersEachColumnBeforeTheNext() {
        func line(_ text: String, _ x: CGFloat, _ y: CGFloat, _ width: CGFloat = 0.35) -> PDFTranslationOCRLine {
            PDFTranslationOCRLine(text: text, bounds: CGRect(x: x, y: y, width: width, height: 0.025))
        }
        let observations = [line("R2", 0.56, 0.65), line("L3", 0.08, 0.60), line("Title", 0.08, 0.90, 0.84),
            line("R1", 0.56, 0.70), line("L1", 0.08, 0.70), line("R3", 0.56, 0.60), line("L2", 0.08, 0.65)]
        #expect(PDFTranslationOCR.readingText(observations) == "Title\nL1\nL2\nL3\nR1\nR2\nR3")
    }

    @Test func inputAndPageLimitsFailBeforeExtraction() throws {
        let data = try fixturePDF(pages: ["First.", "Second."])
        #expect(throws: PDFTranslationDocumentError.inputTooLarge(limitBytes: 10)) {
            try PDFTranslationDocument(data: data, limits: PDFTranslationLimits(maximumBytes: 10))
        }
        #expect(throws: PDFTranslationDocumentError.tooManyPages(limit: 1)) {
            try PDFTranslationDocument(data: data, limits: PDFTranslationLimits(maximumPages: 1))
        }
        #expect(throws: PDFTranslationDocumentError.emptyInput) { try PDFTranslationDocument(data: Data()) }
        #expect(throws: PDFTranslationDocumentError.invalidPDF) { try PDFTranslationDocument(data: Data("not a PDF".utf8)) }
    }

    @Test func excessivePageTextReturnsBoundedPageError() async throws {
        let document = try PDFTranslationDocument(data: fixturePDF(pages: ["Excessive page text."]),
            limits: PDFTranslationLimits(maximumPageCharacters: 5))
        await #expect(throws: PDFTranslationDocumentError.pageTooLarge(index: 0, limit: 5)) {
            try await document.page(at: 0)
        }
    }

    @Test func fileOpenUsesImmutableBytesAndRejectsRemoteURL() async throws {
        await #expect(throws: PDFTranslationDocumentError.nonLocalURL) {
            try await PDFTranslationDocument.open(url: URL(string: "https://example.invalid/paper.pdf")!)
        }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("askgpt-pdf-\(UUID().uuidString).pdf")
        let data = try fixturePDF(pages: ["Local original."])
        try data.write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let document = try await PDFTranslationDocument.open(url: url)
        try Data("changed source".utf8).write(to: url)
        #expect(await document.originalPDFData() == data)
        #expect(try await document.page(at: 0).blocks.map(\.originalText) == ["Local original."])
    }

    @Test func cancelledCallerCannotExtractOrReturnACachedPage() async throws {
        let document = try PDFTranslationDocument(data: fixturePDF(pages: ["Cached page."]))
        _ = try await document.page(at: 0)
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try await document.page(at: 0)
        }
        await #expect(throws: CancellationError.self) { try await task.value }
    }

    @Test func limitsDoNotAllowOversizedTranslationChunks() {
        #expect(PDFTranslationLimits(maximumBlockCharacters: 60_000).maximumBlockCharacters == 1_800)
        #expect(PDFTranslationLimits(maximumBlockCharacters: -1).maximumBlockCharacters == 1)
    }

    private enum FixtureError: Error { case cannotCreatePDF, unexpectedOCR }

    private func fixturePDF(pages: [String?], userPassword: String? = nil, raster: CGImage? = nil) throws -> Data {
        let bytes = NSMutableData()
        guard let consumer = CGDataConsumer(data: bytes as CFMutableData) else { throw FixtureError.cannotCreatePDF }
        var media = CGRect(x: 0, y: 0, width: 612, height: 792)
        var options: [String: Any] = [:]
        if let userPassword {
            options[kCGPDFContextOwnerPassword as String] = "fixture-owner-password"
            options[kCGPDFContextUserPassword as String] = userPassword
        }
        guard let context = CGContext(consumer: consumer, mediaBox: &media, options as CFDictionary) else { throw FixtureError.cannotCreatePDF }
        for text in pages {
            context.beginPDFPage(nil)
            if let raster { context.draw(raster, in: CGRect(x: 36, y: 400, width: 540, height: 135)) }
            if let text {
                context.textPosition = CGPoint(x: 36, y: 720)
                let attributed = NSAttributedString(string: text,
                    attributes: [NSAttributedString.Key(kCTFontAttributeName as String): CTFontCreateWithName("Helvetica" as CFString, 12, nil)])
                CTLineDraw(CTLineCreateWithAttributedString(attributed), context)
            }
            context.endPDFPage()
        }
        context.closePDF()
        return bytes as Data
    }
}

private actor PDFOCRCallCounter {
    private var calls: [(Int, Int)] = []
    func record(width: Int, height: Int) { calls.append((width, height)) }
    func snapshot() -> [(Int, Int)] { calls }
}
