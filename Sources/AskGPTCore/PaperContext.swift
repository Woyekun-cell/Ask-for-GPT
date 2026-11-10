import Foundation

/// An explicit, local-only snapshot of a Zotero attachment and its extracted text.
public struct PaperContext: Codable, Equatable, Sendable {
    public struct Page: Codable, Equatable, Sendable {
        public let number: Int
        public let text: String

        public init(number: Int, text: String) {
            self.number = number
            self.text = text
        }
    }

    public let attachmentID: String
    public let title: String
    public let abstract: String
    public let doi: String
    public let selection: String
    public let currentPage: Int
    public let pageCount: Int
    public let pages: [Page]
    public let complete: Bool

    public init(attachmentID: String, title: String, abstract: String, doi: String, selection: String,
                currentPage: Int, pageCount: Int, pages: [Page], complete: Bool) {
        self.attachmentID = attachmentID
        self.title = title
        self.abstract = abstract
        self.doi = doi
        self.selection = selection
        self.currentPage = currentPage
        self.pageCount = pageCount
        self.pages = pages
        self.complete = complete
    }

    static let route = "/v1/inline/ask-paper"
    static let maximumBodyBytes = 128 * 1_024

    static func decodeRequest(_ data: Data) throws -> Self {
        guard data.count <= maximumBodyBytes else { throw InlineBridgeFailure.tooLarge }
        let invalid = InlineBridgeFailure(status: 400, code: "invalid_paper_context", message: "当前论文的本机上下文无效。")
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == ["attachmentID", "title", "abstract", "doi", "selection", "currentPage", "pageCount", "pages", "complete"],
              let rows = object["pages"] as? [[String: Any]], rows.count <= 32,
              rows.allSatisfy({ Set($0.keys) == ["number", "text"] }),
              let paper = try? JSONDecoder().decode(Self.self, from: data) else { throw invalid }
        let id = paper.attachmentID.split(separator: ":", omittingEmptySubsequences: false)
        let numbers = paper.pages.map(\.number)
        guard id.count == 2, (1...12).contains(id[0].utf8.count),
              id[0].utf8.allSatisfy({ (48...57).contains($0) }), let library = Int(id[0]), library > 0,
              id[1].utf8.count == 8,
              id[1].utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) }),
              !paper.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              fits(paper.title, bytes: 1_024), fits(paper.abstract, bytes: 6_000),
              fits(paper.doi, bytes: 256), fits(paper.selection, bytes: 6_000),
              (1...2_000).contains(paper.pageCount), (1...paper.pageCount).contains(paper.currentPage),
              numbers == Array(Set(numbers)).sorted(),
              numbers.allSatisfy({ (1...paper.pageCount).contains($0) }),
              paper.pages.allSatisfy({ fits($0.text, bytes: 75_000) }),
              paper.pages.reduce(0, { $0 + $1.text.utf8.count }) <= 75_000,
              !paper.complete || (paper.pages.count == paper.pageCount &&
                 paper.pages.allSatisfy({ !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })) else { throw invalid }
        return paper
    }

    private static func fits(_ text: String, bytes: Int) -> Bool {
        text.utf8.count <= bytes && !text.utf8.contains(0)
    }
}
