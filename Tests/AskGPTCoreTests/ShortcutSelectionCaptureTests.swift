import Foundation
import Testing
@testable import AskGPTCore

struct ShortcutSelectionCaptureTests {
    private var original: ShortcutPasteboardSnapshot {
        .init(items: [
            .init(types: ["public.utf8-plain-text", "public.rtf"], data: [
                "public.utf8-plain-text": Data("原剪贴板".utf8), "public.rtf": Data([0, 1, 2, 255])]),
            .init(types: ["public.png"], data: ["public.png": Data([137, 80, 78, 71])])
        ])
    }

    @Test func copyFallbackIsLimitedToTrustedNonsecureKnownPDFApplications() {
        for source in ["org.zotero.zotero", "com.apple.Preview", "com.adobe.Reader", "com.adobe.Acrobat.Pro"] {
            #expect(ShortcutSelectionPolicy.permitsCopyFallback(bundleID: source, trusted: true, secureInput: false))
            #expect(!ShortcutSelectionPolicy.permitsCopyFallback(bundleID: source, trusted: false, secureInput: false))
            #expect(!ShortcutSelectionPolicy.permitsCopyFallback(bundleID: source, trusted: true, secureInput: true))
        }
        #expect(!ShortcutSelectionPolicy.permitsCopyFallback(bundleID: "com.google.Chrome", trusted: true, secureInput: false))
        #expect(!ShortcutSelectionPolicy.permitsCopyFallback(bundleID: nil, trusted: true, secureInput: false))
        #expect(!ShortcutSelectionPolicy.permitsCopyFallback(bundleID: "org.zotero.zotero.untrusted", trusted: true, secureInput: false))
        #expect(!ShortcutSelectionPolicy.permitsCopyFallback(bundleID: "com.apple.Preview.fake", trusted: true, secureInput: false))
    }

    @Test func onlyVerifiedCopyIdentifierMatches() {
        #expect(ShortcutSelectionPolicy.isPlainCopy(identifier: "copy:"))
        for other in [nil, "menuItemHit:", "copyCitation:", "copyBibliography:", "Copy", "复制引注"] {
            #expect(!ShortcutSelectionPolicy.isPlainCopy(identifier: other))
        }
    }

    @Test func unchangedClipboardCannotBecomeTheSelection() {
        var transaction = ShortcutPasteboardTransaction(original: original, initialChangeCount: 40)
        #expect(transaction.observe(changeCount: 40, plainText: "旧剪贴板文本") == nil)
        #expect(transaction.copyChangeCount == nil)
        #expect(transaction.snapshotToRestore(currentChangeCount: 40) == nil)
    }

    @Test func freshNonemptyCopyReturnsOnlyNormalizedSelectionAndRestoresAllRepresentations() {
        var transaction = ShortcutPasteboardTransaction(original: original, initialChangeCount: 40)
        #expect(transaction.observe(changeCount: 41, plainText: "  β-glucan\r\nALPHA-742\n") == "β-glucan\nALPHA-742")
        #expect(transaction.copyChangeCount == 41)
        #expect(transaction.snapshotToRestore(currentChangeCount: 41) == original)
        #expect(transaction.snapshotToRestore(currentChangeCount: 42) == nil)
    }

    @Test func emptyOrNontextCommandWriteIsNotAcceptedButMayRestoreItsOwnClipboard() {
        var transaction = ShortcutPasteboardTransaction(original: original, initialChangeCount: 40)
        #expect(transaction.observe(changeCount: 41, plainText: nil) == nil)
        #expect(transaction.observe(changeCount: 41, plainText: " \n") == nil)
        #expect(transaction.snapshotToRestore(currentChangeCount: 41) == original)
    }

    @Test func laterUserCopySupersedesTransactionAndMustNeverBeOverwritten() {
        var transaction = ShortcutPasteboardTransaction(original: original, initialChangeCount: 40)
        #expect(transaction.observe(changeCount: 41, plainText: nil) == nil)
        #expect(transaction.observe(changeCount: 42, plainText: "用户随后复制的内容") == nil)
        #expect(transaction.superseded)
        #expect(transaction.snapshotToRestore(currentChangeCount: 42) == nil)
        #expect(transaction.observe(changeCount: 43, plainText: "更新的内容") == nil)
    }

    @Test func emptyOriginalClipboardIsPreservedAsAnEmptySnapshot() {
        let empty = ShortcutPasteboardSnapshot(items: [])
        var transaction = ShortcutPasteboardTransaction(original: empty, initialChangeCount: 3)
        #expect(transaction.observe(changeCount: 4, plainText: "new selection") == "new selection")
        #expect(transaction.snapshotToRestore(currentChangeCount: 4) == empty)
    }
}
