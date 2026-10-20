import Foundation
import Testing
@testable import AskGPTCore

struct ActiveReadingCaptureTests {
    @Test func previewPhysicalPageComesOnlyFromMatchingWindowMetadata() {
        let url = URL(fileURLWithPath: "/tmp/layout-fixture.pdf")
        #expect(ActiveReadingURLPolicy.previewWindowPage(title: "layout-fixture.pdf – 页码：1/3", documentURL: url) == 0)
        #expect(ActiveReadingURLPolicy.previewWindowPage(title: "layout-fixture.pdf – 页码：3/3", documentURL: url) == 2)
        #expect(ActiveReadingURLPolicy.previewWindowPage(title: "layout-fixture.pdf — Page 2 of 3", documentURL: url) == 1)
        for title in ["Other.pdf – 页码：1/3", "layout-fixture.pdf – 页码：0/3", "layout-fixture.pdf – 页码：4/3",
                      "layout-fixture.pdf – 页码：1/2001", "Page 2 of 3", "layout-fixture.pdf", "article page 1/3"] {
            #expect(ActiveReadingURLPolicy.previewWindowPage(title: title, documentURL: url) == nil)
        }
    }

    @Test func localPDFURLDecodesPathAndPhysicalPageWithoutOpeningFile() throws {
        let result = try #require(ActiveReadingURLPolicy.pdfReference("file:///Users/example/Paper%20A.PDF#page=12"))
        #expect(result.url == URL(fileURLWithPath: "/Users/example/Paper A.PDF"))
        #expect(result.pageIndex == 11)
        #expect(result.url.fragment == nil)
        #expect(ActiveReadingURLPolicy.pdfReference("file://localhost/tmp/paper.pdf")?.pageIndex == nil)
        #expect(ActiveReadingURLPolicy.pdfReference("/tmp/paper.pdf")?.url.path == "/tmp/paper.pdf")
    }

    @Test func PDFResolutionRejectsRemoteURLsAndOtherSchemesWithoutGuessingZoteroStorage() {
        for value in ["https://example.org/paper.pdf", "file://server/share/paper.pdf", "zotero://open-pdf/library/items/ABC123?page=3", "javascript:alert(1)", "file:///tmp/passwords.txt", "file:///tmp/paper.pdf?token=secret"] {
            #expect(ActiveReadingURLPolicy.pdfReference(value) == nil)
        }
        #expect(ActiveReadingURLPolicy.pageIndex("0") == nil)
        #expect(ActiveReadingURLPolicy.pageIndex("-1") == nil)
        #expect(ActiveReadingURLPolicy.pageIndex("3 of 20") == nil)
        #expect(ActiveReadingURLPolicy.pageIndex("iv") == nil)
        #expect(ActiveReadingURLPolicy.pageIndex("1") == 0)
        #expect(ActiveReadingURLPolicy.pdfReference("file:///tmp/paper.pdf#page=0")?.pageIndex == nil)
    }

    @Test func webpageURLsExcludeCredentialsAndNonWebSchemes() {
        #expect(ActiveReadingURLPolicy.webURL("https://example.org/article#results")?.host == "example.org")
        #expect(ActiveReadingURLPolicy.webURL("https://user:password@example.org/article") == nil)
        #expect(ActiveReadingURLPolicy.webURL("file:///tmp/private.html") == nil)
        #expect(ActiveReadingURLPolicy.webURL("zotero://open-pdf/library/items/ABC") == nil)
    }

    @Test func orderedBodyRetainsRepeatedParagraphsAndAvoidsParentChildTextDuplication() throws {
        let tree = node("AXWebArea", children: [
            node("AXStaticText", text: "parent mirror", children: [node("AXStaticText", text: "first paragraph")]),
            node("AXParagraph", children: [node("AXStaticText", text: "An inline"), node("AXStaticText", text: "continuation.")]),
            node("AXStaticText", text: "repeated paragraph"),
            node("AXStaticText", text: "repeated paragraph")
        ])
        #expect(try ActiveReadingTextPolicy.text(in: tree) == "first paragraph\n\nAn inline continuation.\n\nrepeated paragraph\n\nrepeated paragraph")
    }

    @Test func mainArticlePreferredAndFormsNavigationAndHiddenBranchesExcluded() throws {
        let tree = node("AXWebArea", children: [
            node("AXStaticText", text: "site banner"),
            node("AXGroup", subrole: "AXLandmarkMain", children: [
                node("AXGroup", subrole: "AXLandmarkNavigation", children: [node("AXStaticText", text: "navigation")]),
                node("AXTextField", children: [node("AXStaticText", text: "typed private value")]),
                node("AXGroup", subrole: "AXSecureTextField", children: [node("AXStaticText", text: "password")]),
                node("AXButton", children: [node("AXStaticText", text: "button label")]),
                node("AXGroup", hidden: true, children: [node("AXStaticText", text: "background tab")]),
                node("AXStaticText", text: "article paragraph")
            ])
        ])
        #expect(try ActiveReadingTextPolicy.text(in: tree) == "article paragraph")
    }

    @Test func snapshotNeverRequestsValuesOrDescendantsOfExcludedInputs() throws {
        let metadata = [0: ActiveReadingNodeMetadata(role: "AXWebArea"),
                        1: ActiveReadingNodeMetadata(role: "AXTextField"),
                        2: ActiveReadingNodeMetadata(role: "AXSecureTextField"),
                        3: ActiveReadingNodeMetadata(role: "AXStaticText")]
        var valueReads: [Int] = [], expanded: [Int] = []
        let tree = try ActiveReadingTreeSnapshot.read(root: 0, metadata: { metadata[$0]! }, children: {
            expanded.append($0); return $0 == 0 ? [1, 2, 3] : []
        }, staticText: { valueReads.append($0); return "public body" }, identity: { $0 }, equals: ==)
        #expect(valueReads == [3])
        #expect(expanded == [0, 3])
        #expect(try ActiveReadingTextPolicy.text(in: tree) == "public body")
    }

    @Test func mirroredStaticContainerValueIsNeverReadAndAXFailuresPropagate() throws {
        var valueReads: [Int] = []
        let tree = try ActiveReadingTreeSnapshot.read(root: 0, metadata: { _ in .init(role: "AXStaticText") },
            children: { $0 == 0 ? [1] : [] }, staticText: { valueReads.append($0); return "leaf body" },
            identity: { $0 }, equals: ==)
        #expect(valueReads == [1])
        #expect(try ActiveReadingTextPolicy.text(in: tree) == "leaf body")
        #expect(throws: ActiveReadingCaptureError.accessibilityUnavailable) {
            try ActiveReadingTreeSnapshot.read(root: 0, metadata: { _ in .init(role: "AXWebArea") },
                children: { _ in throw ActiveReadingCaptureError.accessibilityUnavailable }, staticText: { _ in nil },
                identity: { $0 }, equals: ==)
        }
    }

    @Test func limitsFailExplicitlyRatherThanReturningTruncatedFullText() throws {
        let root = node("AXWebArea", children: [node("AXStaticText", text: "12345"), node("AXStaticText", text: "67890")])
        #expect(throws: ActiveReadingCaptureError.limitExceeded(.text)) {
            try ActiveReadingTextPolicy.text(in: root, maximumUTF8Bytes: 8)
        }
        #expect(throws: ActiveReadingCaptureError.limitExceeded(.nodes)) {
            try ActiveReadingTreeSnapshot.read(root: 0, limits: .init(maximumNodes: 2), metadata: { _ in .init(role: "AXGroup") },
                children: { $0 == 0 ? [1, 2] : [] }, staticText: { _ in nil }, identity: { $0 }, equals: ==)
        }
        #expect(throws: ActiveReadingCaptureError.limitExceeded(.depth)) {
            try ActiveReadingTreeSnapshot.read(root: 0, limits: .init(maximumDepth: 1), metadata: { _ in .init(role: "AXGroup") },
                children: { $0 < 2 ? [$0 + 1] : [] }, staticText: { _ in nil }, identity: { $0 }, equals: ==)
        }
        #expect(throws: ActiveReadingCaptureError.limitExceeded(.time)) {
            try ActiveReadingTreeSnapshot.read(root: 0, isExpired: { true }, metadata: { _ in .init(role: "AXStaticText") },
                children: { _ in [] }, staticText: { _ in "must not read" }, identity: { $0 }, equals: ==)
        }
    }

    @Test func browserAllowlistAndExplicitSourcePolicyRejectUnrelatedBackgroundApps() {
        #expect(ActiveReadingApplicationPolicy.kind(bundleID: "com.google.Chrome") == .browser)
        #expect(ActiveReadingApplicationPolicy.kind(bundleID: "org.mozilla.firefox") == .browser)
        #expect(ActiveReadingApplicationPolicy.kind(bundleID: "org.zotero.zotero") == .pdfReader)
        #expect(ActiveReadingApplicationPolicy.kind(bundleID: "com.kingsoft.wpsoffice.mac") == .pdfReader)
        #expect(ActiveReadingApplicationPolicy.kind(bundleID: "com.apple.TextEdit") == nil)
        #expect(ActiveReadingApplicationPolicy.acceptsForeground(sourcePID: 10, foregroundPID: 10, ownPID: 20, explicit: false))
        #expect(ActiveReadingApplicationPolicy.acceptsForeground(sourcePID: 10, foregroundPID: 20, ownPID: 20, explicit: true))
        #expect(!ActiveReadingApplicationPolicy.acceptsForeground(sourcePID: 10, foregroundPID: 30, ownPID: 20, explicit: true))
        #expect(!ActiveReadingApplicationPolicy.acceptsForeground(sourcePID: 20, foregroundPID: 20, ownPID: 20, explicit: true))
    }

    private func node(_ role: String, subrole: String? = nil, hidden: Bool = false, text: String? = nil,
                      children: [ActiveReadingTextNode] = []) -> ActiveReadingTextNode {
        ActiveReadingTextNode(metadata: .init(role: role, subrole: subrole, isHidden: hidden), text: text, children: children)
    }
}
