import CryptoKit
import Foundation

public enum BilingualDocumentKind: String, Sendable {
    case pdf, webpage
}

/// A snapshot of the supplied source. Implementations never discover further
/// pages or fetch linked URLs; the reader chooses which PDF pages to translate.
public protocol BilingualDocument: Sendable {
    var documentID: String { get }
    var title: String { get }
    var pageCount: Int { get }
    var kind: BilingualDocumentKind { get }
    func page(at index: Int) async throws -> PDFTranslationPage
}

public enum WebTranslationDocumentError: Error, LocalizedError, Sendable, Equatable {
    case emptyInput
    case inputTooLong(limitCharacters: Int)
    case pageOutOfBounds(index: Int, count: Int)

    public var errorDescription: String? {
        switch self {
        case .emptyInput: return "当前网页没有可翻译的正文。"
        case .inputTooLong(let limit): return "当前网页正文超过 \(limit) 字符，请缩小阅读范围。"
        case .pageOutOfBounds: return "网页正文仅包含当前这一页。"
        }
    }
}

/// Immutable text supplied by the current-page capture layer. URL is source
/// metadata only; constructing or reading this value performs no networking.
public struct WebTranslationDocument: BilingualDocument {
    public let documentID: String
    public let title: String
    public let url: URL?
    public let pageCount = 1
    public let kind: BilingualDocumentKind = .webpage
    private let snapshot: PDFTranslationPage

    public init(text: String, title: String, url: URL? = nil) throws {
        try Task.checkCancellation()
        let limit = 300_000
        guard text.count <= limit else {
            throw WebTranslationDocumentError.inputTooLong(limitCharacters: limit)
        }
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw WebTranslationDocumentError.emptyInput
        }
        let normalized = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        let identity = "webpage\u{0000}" + (url?.absoluteString ?? "") + "\u{0000}" + normalized
        let digest = SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
        let documentID = "web:" + digest
        let blocks = try PDFTranslationParagraphs.blocks(text: normalized, pageIndex: 0,
            documentID: documentID, maximumCharacters: 1_800)
        guard !blocks.isEmpty else { throw WebTranslationDocumentError.emptyInput }
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        self.title = trimmedTitle.isEmpty ? "网页原文" : trimmedTitle
        self.url = url
        self.documentID = documentID
        self.snapshot = PDFTranslationPage(pageIndex: 0, pageLabel: "当前网页", blocks: blocks,
            extractionMethod: .accessibility)
        try Task.checkCancellation()
    }

    public func page(at index: Int) async throws -> PDFTranslationPage {
        try Task.checkCancellation()
        guard index == 0 else { throw WebTranslationDocumentError.pageOutOfBounds(index: index, count: 1) }
        return snapshot
    }
}
