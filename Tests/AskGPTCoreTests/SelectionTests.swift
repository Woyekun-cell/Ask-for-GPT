import Foundation
import Carbon
import Testing
@testable import AskGPTCore

struct SelectionTests {
    @Test func testNormalizationRejectsEmptySelectionAndPreservesScientificContent() {
        #expect(SelectionPolicy.normalizedText(" \t\r\n ") == nil)
        #expect(SelectionPolicy.normalizedText(" \r\nGene-1\r\n\tx  =  3.0 µm\r\n ") == "Gene-1\n\tx  =  3.0 µm")
    }

    @Test func testCapturePolicyExcludesOwnAppAndEasydictButAllowsReaders() {
        #expect(SelectionPolicy.shouldIgnoreSource(bundleID: "com.example.AskGPT", ownBundleID: "com.example.AskGPT"))
        #expect(SelectionPolicy.shouldIgnoreSource(bundleID: "com.izual.Easydict", ownBundleID: "com.example.AskGPT"))
        #expect(!SelectionPolicy.shouldIgnoreSource(bundleID: "org.zotero.zotero", ownBundleID: "com.example.AskGPT"))
        #expect(!SelectionPolicy.shouldIgnoreSource(bundleID: "com.apple.Preview", ownBundleID: "com.example.AskGPT"))
    }

    @Test func testSecureInputIsRejectedAsRoleOrSubrole() {
        #expect(SelectionPolicy.isSecureInput(role: "AXTextField", subrole: "AXSecureTextField"))
        #expect(SelectionPolicy.isSecureInput(role: "AXSecureTextField", subrole: nil))
        #expect(!SelectionPolicy.isSecureInput(role: "AXTextArea", subrole: nil))
    }

    @Test func emptyOrMissingNativeTextFallsBackToSelectedTextMarker() {
        let nativeValues: [String?] = [nil, "", " \t\r\n"]
        for native in nativeValues {
            var markerReads = 0
            let result = AXSelectionTextResolver.resolve(nativeText: { native }, rangeText: { nil }, markerText: {
                markerReads += 1
                return " \r\nselected β-glucan\r\nwith evidence \n"
            })
            #expect(result?.text == "selected β-glucan\nwith evidence")
            #expect(result?.source == .textMarker)
            #expect(markerReads == 1)
        }
    }

    @Test func failedNativeAttributesStillAllowFirefoxSelectedMarkerText() {
        struct Unavailable: Error {}
        let result = AXSelectionTextResolver.resolve(nativeText: { throw Unavailable() },
            rangeText: { throw Unavailable() }, markerText: { "Firefox PDF selection" })
        #expect(result?.text == "Firefox PDF selection")
        #expect(result?.source == .textMarker)
    }

    @Test func nativeSelectionWinsWithoutReadingMarkerOrUnrelatedContent() {
        var fallbackReads = 0
        let result = AXSelectionTextResolver.resolve(nativeText: { " exact selected text " }, rangeText: {
            fallbackReads += 1; return "selected range"
        }, markerText: { fallbackReads += 1; return "selected marker" })
        #expect(result?.text == "exact selected text")
        #expect(result?.source == .nativeText)
        #expect(fallbackReads == 0)
    }

    @Test func selectedRangeRemainsAvailableBeforeTextMarkerFallback() {
        var markerReads = 0
        let result = AXSelectionTextResolver.resolve(nativeText: { "" }, rangeText: { "range selection" }, markerText: {
            markerReads += 1; return "marker selection"
        })
        #expect(result?.text == "range selection")
        #expect(result?.source == .nativeRange)
        #expect(markerReads == 0)
    }

    @Test func absentSelectedRangesReturnNilWithoutAnyWholeDocumentReader() {
        var selectedQueries: [String] = []
        let result = AXSelectionTextResolver.resolve(nativeText: {
            selectedQueries.append("selectedText"); return nil
        }, rangeText: {
            selectedQueries.append("selectedRange"); return " "
        }, markerText: {
            selectedQueries.append("selectedMarker"); return nil
        })
        #expect(result == nil)
        #expect(selectedQueries == ["selectedText", "selectedRange", "selectedMarker"])
    }

    @Test func nestedPDFSelectionBelowSevenWrappersIsReachableWithoutBreadthScan() {
        // A PDF.js web area can be below ten wrappers in Zotero's reader.
        var inspected: [Int] = []
        let readSelection: (Int) -> String? = { node in
                inspected.append(node)
                return node == 11 ? "selected PDF phrase" : nil
        }
        let childNodes: (Int) -> [Int] = { node in
                node < 11 ? [node + 1, 100 + node] : []
        }
        let result: String? = AXSelectionTraversal.find(roots: [0], equals: { (a: Int, b: Int) in a == b },
            isExpired: { false }, isSecure: { _ in false }, selection: readSelection, children: childNodes)
        #expect(result == "selected PDF phrase")
        #expect(inspected == Array(0...11))
    }

    @Test func secureTraversalSubtreeNeverReadsSelectionOrDescendants() {
        var inspected: [Int] = []
        var expanded: [Int] = []
        let result: String? = AXSelectionTraversal.find(roots: [0], equals: { (a: Int, b: Int) in a == b }, isExpired: { false },
            isSecure: { $0 == 1 }, selection: { node in
                inspected.append(node)
                return node == 2 ? "public selection" : nil
            }, children: { node in
                expanded.append(node)
                return node == 0 ? [1, 2] : [3]
            })
        #expect(result == "public selection")
        #expect(!inspected.contains(1) && !inspected.contains(3))
        #expect(!expanded.contains(1))
    }

    @Test func testSelectionMustMatchTwiceBeforeEmission() {
        var gate = StableSelectionGate()
        let first = selection("first paragraph")
        let second = selection("different paragraph")
        #expect(gate.observe(first) == nil)
        #expect(gate.observe(second) == nil)
        #expect(gate.observe(second)?.excerpt.text == "different paragraph")
    }

    @Test func testEmptySampleBreaksStability() {
        var gate = StableSelectionGate()
        let excerpt = selection("selected text")
        #expect(gate.observe(excerpt) == nil)
        #expect(gate.observe(nil) == nil)
        #expect(gate.observe(excerpt) == nil)
        #expect(gate.observe(excerpt)?.excerpt.text == "selected text")
    }

    @Test func testRepeatedSelectionAndMovementDoNotEmitAgain() {
        var gate = StableSelectionGate()
        let first = selection("same paragraph", anchor: CGRect(x: 20, y: 40, width: 100, height: 20))
        let moved = selection("same paragraph", anchor: CGRect(x: 70, y: 90, width: 100, height: 20))
        #expect(gate.observe(first) == nil)
        #expect(gate.observe(first) != nil)
        #expect(gate.observe(moved) == nil)
        #expect(gate.observe(moved) == nil)
    }

    @Test func testDifferentSourcesStartNewStabilityAndResetAllowsSameSelectionAgain() {
        var gate = StableSelectionGate()
        let browser = selection("same paragraph", source: "com.google.Chrome")
        let reader = selection("same paragraph", source: "org.zotero.zotero")
        #expect(gate.observe(browser) == nil)
        #expect(gate.observe(browser) != nil)
        #expect(gate.observe(reader) == nil)
        #expect(gate.observe(reader) != nil)
        gate.reset()
        #expect(gate.observe(reader) == nil)
        #expect(gate.observe(reader) != nil)
    }

    @MainActor @Test func hotKeyConflictPreservesPreviousRegistrationAndSuccessfulChangeReleasesIt() throws {
        // Reserve uncommon F18/F19 combinations only for this test; no key events are synthesized.
        let modifiers = UInt32(controlKey | optionKey | shiftKey | cmdKey)
        let original = HotKeySpec(keyCode: UInt32(kVK_F18), modifiers: modifiers)
        let occupied = HotKeySpec(keyCode: UInt32(kVK_F19), modifiers: modifiers)
        let owner = GlobalHotKey()
        let blocker = GlobalHotKey()
        let probe = GlobalHotKey()
        defer { owner.unregister(); blocker.unregister(); probe.unregister() }
        try owner.register(original) {}
        try blocker.register(occupied) {}

        do {
            try owner.register(occupied) {}
            Issue.record("Changing to an occupied shortcut must fail")
        } catch is HotKeyRegistrationError {}

        do {
            try probe.register(original) {}
            Issue.record("Failed shortcut change released the previous shortcut")
        } catch is HotKeyRegistrationError {}
        probe.unregister()

        // Validation failures must preserve the same registration too.
        do {
            try owner.register(HotKeySpec(keyCode: 1000, modifiers: modifiers)) {}
            Issue.record("Invalid shortcut must fail validation")
        } catch is HotKeyRegistrationError {}
        do {
            try probe.register(original) {}
            Issue.record("Invalid shortcut change released the previous shortcut")
        } catch is HotKeyRegistrationError {}
        probe.unregister()

        try owner.register(original) {}
        blocker.unregister()
        try owner.register(occupied) {}
        try probe.register(original) {}
    }

    private func selection(_ text: String, source: String = "com.google.Chrome", anchor: CGRect? = nil) -> CapturedSelection {
        CapturedSelection(excerpt: SelectedExcerpt(text: text, sourceBundleID: source, sourceName: "Reader"), anchor: anchor)
    }
}
