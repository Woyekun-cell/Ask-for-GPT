import AppKit
import Foundation
import SwiftUI
import PDFKit
import CoreText
@testable import AskGPTCore

private struct DocumentProbeFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

private actor DocumentFixture: BilingualDocument {
    enum Page: Sendable { case text([String]), failure, held([String]) }
    nonisolated let documentID: String
    nonisolated let title: String
    nonisolated let pageCount: Int
    nonisolated let kind: BilingualDocumentKind = .pdf
    private let outputs: [Page]
    private var held: [CheckedContinuation<Void, Never>] = []
    private(set) var reads: [Int] = []
    init(_ id: String, _ outputs: [Page]) {
        documentID = id; title = id; pageCount = outputs.count; self.outputs = outputs
    }
    func page(at index: Int) async throws -> PDFTranslationPage {
        reads.append(index)
        let texts: [String]
        switch outputs[index] {
        case .text(let value): texts = value
        case .failure: throw DocumentProbeFailure(message: "受控页面读取失败")
        case .held(let value):
            await withCheckedContinuation { held.append($0) }
            texts = value // Deliberately returns after cancellation.
        }
        return PDFTranslationPage(pageIndex: index, pageLabel: "\(index + 1)",
            blocks: texts.enumerated().map { PDFTranslationBlock(blockID: "\(index)-\($0.offset)", pageIndex: index, originalText: $0.element) },
            extractionMethod: .textLayer)
    }
    func releaseHeld() { let old = held; held.removeAll(); old.forEach { $0.resume() } }
}

private actor DocumentNativeFixture: NativeTranslationDriver {
    enum Output: Sendable { case text(String), held(String), failure }
    struct Call: Sendable { let text: String; let source: String; let target: String }
    private var outputs: [Output]
    private var held: [CheckedContinuation<Void, Never>] = []
    private(set) var calls: [Call] = []
    private(set) var completed = 0
    init(_ outputs: [Output] = []) { self.outputs = outputs }
    func availability(sourceLanguage: String, targetLanguage: String) async -> NativeTranslationAvailability { .installed }
    func warmUp(sourceLanguage: String, targetLanguage: String) async throws {}
    func translate(_ text: String, sourceLanguage: String, targetLanguage: String) async throws -> String {
        calls.append(Call(text: text, source: sourceLanguage, target: targetLanguage))
        let output = outputs.isEmpty ? .text("本机译文：" + text) : outputs.removeFirst()
        defer { completed += 1 }
        switch output {
        case .text(let value): return value
        case .failure: throw NativeTranslationError.translationFailed
        case .held(let value):
            await withCheckedContinuation { held.append($0) }
            return value // Deliberately models unresponsive native XPC.
        }
    }
    func releaseHeld() { let old = held; held.removeAll(); old.forEach { $0.resume() } }
}

private actor DocumentRefinerFixture: PassageRefining {
    enum Output: Sendable { case text(String), held }
    private var outputs: [Output]
    private var callbacks: [@Sendable (String) -> Void] = []
    private(set) var calls: [String] = []
    private(set) var shutdownCount = 0
    init(_ outputs: [Output]) { self.outputs = outputs }
    func refine(_ text: String, mode: PassageRefinementMode,
                onDelta: @escaping @Sendable (String) -> Void) async throws -> BackendTurnResult {
        calls.append(text)
        callbacks.append(onDelta)
        onDelta("受控精译流")
        let output = outputs.isEmpty ? .held : outputs.removeFirst()
        switch output {
        case .text(let value): return BackendTurnResult(text: value, firstDeltaSeconds: 0.01, totalSeconds: 0.02)
        case .held:
            try await Task.sleep(nanoseconds: 60_000_000_000)
            throw CancellationError()
        }
    }
    func emitLate() { callbacks.forEach { $0("取消后的迟到精译") }; callbacks.removeAll() }
    func shutdown() async { shutdownCount += 1 }
}

private actor DocumentLayoutFixture: PDFLayoutServing {
    enum Behavior: Sendable { case complete, held, failure }
    struct Call: Sendable { let pages: [Int]?; let source: String; let target: String }
    private let pageCount: Int
    private var behaviors: [Behavior]
    private var jobs: [String: PDFLayoutJob] = [:]
    private var held: [CheckedContinuation<Void, Never>] = []
    private(set) var calls: [Call] = []
    private(set) var cancellations: [String] = []
    private(set) var outputCalls: [(String, PDFLayoutOutputMode)] = []
    private(set) var events: [String] = []

    init(pageCount: Int, behaviors: [Behavior] = []) { self.pageCount = pageCount; self.behaviors = behaviors }
    func createJob(data: Data, pages: [Int]?, source: String, target: String) async throws -> PDFLayoutJob {
        calls.append(Call(pages: pages, source: source, target: target))
        let id = "fixture-\(calls.count)"
        events.append("post:\(id)")
        let behavior = behaviors.isEmpty ? .complete : behaviors.removeFirst()
        if case .held = behavior { await withCheckedContinuation { held.append($0) } }
        let job = PDFLayoutJob(id: id, state: { if case .failure = behavior { return .failed }; return .complete }(),
            sourcePages: pages ?? Array(0..<pageCount), pageCount: pageCount,
            error: { if case .failure = behavior { return "受控保版翻译失败" }; return nil }())
        jobs[id] = job
        return job
    }
    func status(id: String) async throws -> PDFLayoutJob {
        guard let job = jobs[id] else { throw PDFLayoutServiceError.invalidResponse }; return job
    }
    func output(id: String, mode: PDFLayoutOutputMode) async throws -> Data {
        outputCalls.append((id, mode))
        guard let job = jobs[id] else { throw PDFLayoutServiceError.invalidResponse }
        return try Self.pdf(pages: job.sourcePages.count, dual: mode == .dual)
    }
    func cancel(id: String) async {
        events.append("delete-start:\(id)")
        try? await Task.sleep(nanoseconds: 20_000_000)
        cancellations.append(id); events.append("delete-end:\(id)")
    }
    func releaseHeld() { let old = held; held.removeAll(); old.forEach { $0.resume() } }

    static func pdf(pages: Int, dual: Bool = false) throws -> Data {
        let bytes = NSMutableData()
        guard let consumer = CGDataConsumer(data: bytes as CFMutableData) else {
            throw DocumentProbeFailure(message: "cannot build mock PDF")
        }
        var bounds = CGRect(x: 0, y: 0, width: dual ? 1_224 : 612, height: 792)
        guard let context = CGContext(consumer: consumer, mediaBox: &bounds, nil) else {
            throw DocumentProbeFailure(message: "cannot build mock PDF context")
        }
        for index in 0..<pages {
            context.beginPDFPage(nil)
            context.setFillColor(CGColor(gray: CGFloat(index + 1) / CGFloat(pages + 2), alpha: 1))
            context.fill(CGRect(x: 36, y: 36, width: 100, height: 80))
            context.textPosition = CGPoint(x: 36, y: 748)
            let heading = NSAttributedString(string: "LAYOUT TOP \(index + 1)", attributes: [
                NSAttributedString.Key(kCTFontAttributeName as String): CTFontCreateWithName("Helvetica" as CFString, 18, nil)
            ])
            CTLineDraw(CTLineCreateWithAttributedString(heading), context)
            context.endPDFPage()
        }
        context.closePDF()
        return bytes as Data
    }
}

@main private struct DocumentUISmoke {
    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        Task { @MainActor in
            let success = await runChecks(app)
            exit(success ? 0 : 1)
        }
        app.run()
    }

    @MainActor private static func runChecks(_ app: NSApplication) async -> Bool {
        var checks: [String: Bool] = [:]
        var observations: [String: Any] = [:]
        var stores: [DocumentReadingStore] = []
        var drivers: [DocumentNativeFixture] = []
        var documents: [DocumentFixture] = []
        var errorMessage: String?
        var window: NSWindow?
        let chat = CodexSettings(cliPath: "/synthetic/no-cli", model: "gpt-6.1-sol", reasoningEffort: "high")
        var gptCreations = 0
        let refiner = DocumentRefinerFixture([.held, .text("当前单段精译完成"), .held])
        var refinerConfigurations: [CodexSettings] = []
        func makeStore(_ driver: DocumentNativeFixture, timeout: Double = 0.3,
                       replacement: DocumentNativeFixture? = nil, memory: Int = 2_000_000) -> DocumentReadingStore {
            drivers.append(driver)
            if let replacement { drivers.append(replacement) }
            var engineCreations = 0
            let store = DocumentReadingStore(settingsProvider: { chat }, engineFactory: {
                engineCreations += 1
                return NativeTranslationEngine(driver: engineCreations == 1 ? driver : (replacement ?? driver))
            }, refinerFactory: { configuration in
                gptCreations += 1; refinerConfigurations.append(configuration); return refiner
            }, translationTimeoutSeconds: timeout, memoryCharacterLimit: memory)
            stores.append(store)
            return store
        }
        do {
            let initialDriver = DocumentNativeFixture([.text("第一段译文"), .held("第二段译文")])
            let initial = makeStore(initialDriver)
            let threePages = DocumentFixture("current-page", [.text(["Page zero."]),
                .text(["Page one first paragraph.", "Page one second paragraph."]), .text(["Page two."])])
            documents.append(threePages)
            initial.load(threePages, currentPageIndex: 1)
            try await until { await initialDriver.calls.count == 2 }
            let initialReads = await threePages.reads
            try require(initialReads == [1] && initial.scope == .currentPage && initial.currentPageIndex == 1,
                "load did not restrict default translation to the actual current page")
            try require(initial.currentBlocks.first?.translation == "第一段译文" && initial.isTranslating &&
                initial.currentBlocks.last?.translation.isEmpty == true,
                "completed paragraphs were hidden until the entire page finished")
            await initialDriver.releaseHeld()
            try await idle(initial)
            let initialCalls = await initialDriver.calls
            try require(initialCalls.allSatisfy { $0.source == "en" && $0.target == "zh-Hans" } && gptCreations == 0,
                "native document translation used a wrong language pair or automatically created GPT")
            checks["current_page_default_and_incremental_visible_english_to_chinese"] = true
            checks["native_document_translation_never_starts_gpt"] = true

            let wholeDriver = DocumentNativeFixture([.text("当前页译文"), .held("零页译文"), .text("一页译文")])
            let whole = makeStore(wholeDriver)
            let wholeDoc = DocumentFixture("whole-priority", [.text(["Physical zero."]), .text(["Physical one."]), .text(["Physical two."])])
            documents.append(wholeDoc)
            whole.load(wholeDoc, currentPageIndex: 2)
            whole.translateWholeDocument() // Cancel the unstarted current-page task.
            try await until { await wholeDriver.calls.count == 2 }
            let wholeReads = await wholeDoc.reads
            let order = await wholeDriver.calls.map(\.text)
            try require(wholeReads == [2, 0] && order == ["Physical two.", "Physical zero."] &&
                whole.currentBlocks.first?.translation == "当前页译文" && whole.isTranslating,
                "whole-document translation did not prioritize and display the current page")
            await wholeDriver.releaseHeld()
            try await idle(whole)
            try require(whole.wholeDocumentCompleted && whole.completedPageCount == 3 && whole.failedPageCount == 0,
                "successful whole-document translation did not reach exact completion")
            let countBeforeNavigation = await wholeDriver.calls.count
            whole.goToPage(0)
            try await idle(whole)
            let countAfterNavigation = await wholeDriver.calls.count
            try require(whole.currentBlocks.first?.translation == "零页译文" && countBeforeNavigation == countAfterNavigation,
                "page navigation discarded completed translations or retranslated cached paragraphs")
            checks["whole_document_current_page_first_and_page_cache_preserved"] = true

            let oldDriver = DocumentNativeFixture([.held("停止后过晚结果")])
            let freshDriver = DocumentNativeFixture([.text("停止后重试成功")])
            let stopped = makeStore(oldDriver, replacement: freshDriver)
            let stopDoc = DocumentFixture("stop-retry", [.text(["A cancellable paragraph."])])
            documents.append(stopDoc)
            stopped.load(stopDoc)
            try await until { await oldDriver.calls.count == 1 }
            stopped.stop()
            try require(!stopped.isTranslating && stopped.currentBlocks[0].failure != nil,
                "stop left a busy paragraph or lost its retry state")
            stopped.retryVisible()
            try await idle(stopped)
            let oldCompleted = await oldDriver.completed
            try require(stopped.currentBlocks[0].translation == "停止后重试成功" && oldCompleted == 0,
                "retry remained queued behind the cancelled native engine")
            await oldDriver.releaseHeld()
            await settle(0.02)
            try require(stopped.currentBlocks[0].translation == "停止后重试成功", "late cancelled native work overwrote retry")
            checks["stop_retry_replaces_native_engine_and_rejects_late_result"] = true

            let timeoutOld = DocumentNativeFixture([.held("超时旧结果")])
            let timeoutNew = DocumentNativeFixture([.text("超时后立即恢复")])
            let timed = makeStore(timeoutOld, timeout: 0.04, replacement: timeoutNew)
            timed.load(stopDoc)
            try await idle(timed)
            try require(timed.currentBlocks[0].failure?.contains("超时") == true && !timed.isTranslating,
                "unresponsive native translation did not reach a bounded terminal failure")
            timed.retryVisible()
            try await idle(timed)
            let timedOldCompleted = await timeoutOld.completed
            try require(timed.currentBlocks[0].translation == "超时后立即恢复" && timedOldCompleted == 0,
                "native deadline waited for old XPC cleanup before allowing retry")
            await timeoutOld.releaseHeld()
            checks["native_deadline_does_not_await_uncancellable_xpc_tail"] = true

            let lateDocument = DocumentFixture("old-document", [.held(["The old document paragraph."])])
            let nextDocument = DocumentFixture("new-document", [.text(["The new document paragraph."])])
            documents += [lateDocument, nextDocument]
            let switched = makeStore(DocumentNativeFixture([.text("新文件译文")]))
            switched.load(lateDocument)
            try await until { await lateDocument.reads.count == 1 }
            switched.load(nextDocument)
            try await idle(switched)
            await lateDocument.releaseHeld()
            await settle(0.02)
            try require(switched.title == "new-document" && switched.currentBlocks[0].originalText == "The new document paragraph." &&
                switched.currentBlocks[0].translation == "新文件译文", "late page extraction crossed document boundaries")
            checks["switch_document_rejects_late_page_extraction"] = true

            let refinementNative = DocumentNativeFixture([.text("保留本机第一段"), .text("保留本机第二段")])
            let refined = makeStore(refinementNative)
            let refinementDoc = DocumentFixture("single-block-refinement", [.text(["Only this first paragraph.", "Never send this second paragraph."])])
            documents.append(refinementDoc)
            refined.load(refinementDoc)
            try await idle(refined)
            try require(gptCreations == 0, "loading documents automatically sent paragraphs to GPT")
            refined.refineBlock(refined.currentBlocks[0].id)
            try await until { await refiner.calls.count == 1 }
            await settle(0.02)
            let refinedCalls = await refiner.calls
            try require(refinedCalls == ["Only this first paragraph."] && refined.currentBlocks[0].isRefining &&
                refined.currentBlocks[0].translation == "保留本机第一段" && !refined.currentBlocks[0].refinement.isEmpty &&
                refined.currentBlocks[1].refinement.isEmpty && refinerConfigurations == [PassageRefinementConfiguration.settings(from: chat)],
                "explicit paragraph refinement sent other paragraphs, hid native text, or used question-model settings")
            refined.stop()
            refined.refineBlock(refined.currentBlocks[0].id)
            try await until { !refined.isRefining }
            await refiner.emitLate()
            await settle(0.02)
            try require(gptCreations == 1 && refined.currentBlocks[0].refinement == "当前单段精译完成",
                "paragraph retry did not reuse the client or rejected-generation callbacks changed final text")
            refined.refineBlock(refined.currentBlocks[1].id)
            try await until { await refiner.calls.count == 3 }
            refined.load(nextDocument)
            try await idle(refined)
            await refiner.emitLate()
            await settle(0.02)
            try require(refined.currentBlocks.allSatisfy { !$0.isRefining && $0.refinement.isEmpty },
                "a late explicit GPT paragraph crossed a document boundary")
            checks["explicit_refinement_only_clicked_paragraph_preserves_native_and_reuses_client"] = true
            checks["switch_document_cancels_and_rejects_late_gpt_stream"] = true

            let failedDoc = DocumentFixture("page-failure", [.text(["Readable zero."]), .failure, .text(["Readable two."])])
            documents.append(failedDoc)
            let failed = makeStore(DocumentNativeFixture())
            failed.load(failedDoc, currentPageIndex: 1)
            try await idle(failed)
            failed.translateWholeDocument()
            try await idle(failed)
            try require(!failed.wholeDocumentCompleted && failed.completedPageCount == 2 && failed.pages[1]?.failure != nil &&
                failed.status.contains("尚未完成"), "a page extraction failure was reported as successful whole-document translation")
            checks["failed_page_never_counts_as_whole_document_completion"] = true

            let limitedDoc = DocumentFixture("bounded-memory", [.text(["A twelve word page."]), .text(["Another short page."])])
            documents.append(limitedDoc)
            let limited = makeStore(DocumentNativeFixture([.text("一页"), .text("二页")]), memory: 35)
            limited.load(limitedDoc)
            try await idle(limited)
            limited.translateWholeDocument()
            try await idle(limited)
            try require(!limited.wholeDocumentCompleted && limited.memoryNotice != nil && limited.retainedCharacters <= 35,
                "memory limit was exceeded or an incomplete document was declared complete")
            limited.goToPage(1)
            try await idle(limited)
            try require(limited.currentBlocks.first?.translation == "二页" && limited.retainedCharacters <= 35 &&
                !limited.wholeDocumentCompleted, "manual page navigation could not resume within the bounded memory cache")
            checks["memory_limit_reports_incomplete_and_allows_page_by_page_resume"] = true

            let web = try WebTranslationDocument(text: "A web paragraph.", title: "Current webpage")
            let webStore = makeStore(DocumentNativeFixture())
            webStore.load(web, currentPageIndex: 20)
            try await idle(webStore)
            webStore.setScope(.wholeDocument)
            try require(webStore.pageCount == 1 && webStore.currentPageIndex == 0 && webStore.scope == .currentPage &&
                !webStore.canReadWholeDocument, "webpage snapshot exposed non-current or linked pages")
            checks["webpage_snapshot_is_current_page_only"] = true

            let layoutService = DocumentLayoutFixture(pageCount: 3)
            let layoutStore = DocumentReadingStore(settingsProvider: { chat }, layoutService: layoutService,
                layoutPollingNanoseconds: 1_000_000)
            stores.append(layoutStore)
            let layoutDoc = DocumentFixture("layout-source", Array(repeating: .failure, count: 3))
            documents.append(layoutDoc)
            let sourcePDF = try DocumentLayoutFixture.pdf(pages: 3)
            layoutStore.load(layoutDoc, currentPageIndex: 2, pdfData: sourcePDF)
            try await idle(layoutStore)
            let firstLayoutCalls = await layoutService.calls
            let layoutReads = await layoutDoc.reads
            try require(firstLayoutCalls.count == 1 && firstLayoutCalls[0].pages == [2] &&
                layoutStore.pdfSourcePages == [2] && layoutStore.currentPageIndex == 2 &&
                layoutStore.displayedPDFPageIndex == 0 && layoutStore.pdfDisplayMode == .translated &&
                layoutStore.currentBlocks.isEmpty && layoutReads.isEmpty &&
                layoutStore.originalPDFData == sourcePDF && layoutStore.displayedPDFIsTranslation,
                "real PDF path extracted text, lost page 3 mapping, or changed source bytes")
            checks["pdf_layout_defaults_to_translated_pdf_and_maps_source_page_three_to_output_one"] = true
            let mono = layoutStore.displayedPDFData
            layoutStore.setPDFDisplayMode(.comparison)
            try require(layoutStore.displayedPDFData != mono && layoutStore.displayedPDFPageIndex == 0,
                "comparison mode did not reuse the dual PDF")
            layoutStore.setPDFDisplayMode(.original)
            try require(layoutStore.displayedPDFData == sourcePDF && layoutStore.displayedPDFPageIndex == 2,
                "original mode did not restore exact source PDF and source page")
            layoutStore.setPDFDisplayMode(.translated)
            let switchedModeCalls = await layoutService.calls
            try require(switchedModeCalls.count == 1 && layoutStore.displayedPDFData == mono,
                "switching display mode unnecessarily translated again")
            checks["pdf_display_modes_reuse_one_job_and_original_bytes"] = true
            layoutStore.setScope(.wholeDocument)
            try await idle(layoutStore)
            let wholeCalls = await layoutService.calls
            let layoutEvents = await layoutService.events
            try require(wholeCalls.count == 2 && wholeCalls[1].pages == nil && layoutStore.wholeDocumentCompleted &&
                layoutStore.pdfSourcePages == [0, 1, 2] &&
                layoutEvents.firstIndex(of: "delete-end:fixture-1")! < layoutEvents.firstIndex(of: "post:fixture-2")!,
                "replacement PDF job started before delayed DELETE completed or lost mapping")
            checks["replacement_pdf_job_awaits_delayed_delete_before_post"] = true
            layoutStore.goToPage(1)
            let navigationCalls = await layoutService.calls
            try require(layoutStore.displayedPDFPageIndex == 1 && navigationCalls.count == 2,
                "navigation retranslated a complete whole-document PDF")
            layoutStore.displayedPDFDidNavigate(to: 2)
            try require(layoutStore.currentPageIndex == 2, "native PDFView navigation lost source page mapping")
            checks["whole_pdf_native_page_navigation_reuses_completed_job"] = true
            layoutStore.setTranslationDirection(.chineseToEnglish)
            try await idle(layoutStore)
            let directionCalls = await layoutService.calls
            try require(directionCalls.count == 3 && directionCalls.last?.source == "zh-Hans" &&
                directionCalls.last?.target == "en", "direction change reused old-language PDF")
            checks["pdf_direction_change_starts_new_job_with_correct_language_pair"] = true

            let failureService = DocumentLayoutFixture(pageCount: 3, behaviors: [.failure])
            let failedLayout = DocumentReadingStore(settingsProvider: { chat }, layoutService: failureService)
            stores.append(failedLayout)
            failedLayout.load(layoutDoc, currentPageIndex: 2, pdfData: sourcePDF)
            try await idle(failedLayout)
            try require(failedLayout.sourceError != nil && failedLayout.displayedPDFData == sourcePDF &&
                failedLayout.translatedPDFData == nil && failedLayout.currentBlocks.isEmpty &&
                !failedLayout.wholeDocumentCompleted, "failed layout silently fell back to plain text or reported success")
            checks["failed_pdf_layout_keeps_original_without_plain_text_fallback"] = true

            let lateLayoutService = DocumentLayoutFixture(pageCount: 3, behaviors: [.held, .complete])
            let switchedLayout = DocumentReadingStore(settingsProvider: { chat }, layoutService: lateLayoutService)
            stores.append(switchedLayout)
            switchedLayout.load(layoutDoc, currentPageIndex: 2, pdfData: sourcePDF)
            try await until { await lateLayoutService.calls.count == 1 }
            let freshLayoutDoc = DocumentFixture("new-layout-source", Array(repeating: .failure, count: 3))
            documents.append(freshLayoutDoc)
            switchedLayout.load(freshLayoutDoc, currentPageIndex: 0, pdfData: sourcePDF)
            await lateLayoutService.releaseHeld()
            try await idle(switchedLayout)
            await settle(0.04)
            let lateCancellations = await lateLayoutService.cancellations
            try require(switchedLayout.title == "new-layout-source" && switchedLayout.pdfSourcePages == [0] &&
                switchedLayout.currentPageIndex == 0 && lateCancellations.contains("fixture-1"),
                "late created PDF job overwrote new document or was not cancelled")
            checks["switch_pdf_rejects_and_cancels_late_created_job"] = true

            let pdfProbe = NSWindow(contentRect: NSRect(x: 180, y: 180, width: 760, height: 650),
                styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            pdfProbe.isReleasedWhenClosed = false
            pdfProbe.contentView = NSHostingView(rootView: DocumentReadingView(store: layoutStore, onOpenPDF: {}, onCapture: {}))
            pdfProbe.makeKeyAndOrderFront(nil)
            await settle(0.08)
            pdfProbe.contentView?.layoutSubtreeIfNeeded()
            let pdfViews = descendants(pdfProbe.contentView).compactMap { $0 as? PDFView }
            try require(pdfViews.count == 1 && pdfViews[0].document?.pageCount == 3 &&
                pdfViews[0].autoScales && pdfViews[0].displayMode == .singlePageContinuous,
                "translated PDF was not displayed with native scrollable PDFKit view")
            checks["pdf_layout_view_uses_native_pdfkit_selection_zoom_and_scrolling"] = true

            // A source scrolled inside page 3 becomes a one-page translated PDF.
            // Current-page equality must not retain its old scroll ratio/zoom.
            layoutStore.setScope(.currentPage)
            try await idle(layoutStore)
            layoutStore.setPDFDisplayMode(.original)
            await settle(0.08)
            guard let nativePDF = pdfViews.first, let sourceDocument = nativePDF.document,
                  let thirdSourcePage = sourceDocument.page(at: 2) else {
                throw DocumentProbeFailure(message: "source PDF missing during scroll reset regression")
            }
            nativePDF.autoScales = false
            nativePDF.scaleFactor = 2
            nativePDF.go(to: PDFDestination(page: thirdSourcePage, at: CGPoint(x: 36, y: 450)))
            await settle(0.05)
            layoutStore.setPDFDisplayMode(.translated)
            await settle(0.10)
            nativePDF.layoutSubtreeIfNeeded()
            guard let monoDocument = nativePDF.document, let monoPage = monoDocument.page(at: 0),
                  let headingSelection = monoPage.selection(for: NSRange(location: 0, length: 12)) else {
                throw DocumentProbeFailure(message: "translated PDF lost selectable heading")
            }
            let headingRect = nativePDF.convert(headingSelection.bounds(for: monoPage), from: monoPage)
            try require(monoDocument.pageCount == 1 && nativePDF.currentPage === monoPage &&
                nativePDF.bounds.contains(headingRect) && nativePDF.autoScales,
                "new translated PDF retained previous document's scroll ratio/zoom and hid the title")
            checks["new_pdf_bytes_reset_zoom_and_align_mapped_output_page_to_visible_top"] = true
            layoutStore.setPDFDisplayMode(.comparison)
            await settle(0.10)
            nativePDF.layoutSubtreeIfNeeded()
            guard let dualPage = nativePDF.document?.page(at: 0) else {
                throw DocumentProbeFailure(message: "dual PDF missing during fit regression")
            }
            let dualRect = nativePDF.convert(dualPage.bounds(for: nativePDF.displayBox), from: dualPage)
            try require(dualRect.width <= nativePDF.bounds.width + 2 && nativePDF.autoScales &&
                nativePDF.scaleFactor < 1,
                "wide dual PDF retained the previous mono zoom and overflowed the reader width")
            checks["switching_to_wide_dual_pdf_recomputes_native_fit_scale"] = true
            pdfProbe.orderOut(nil)

            let uiDriver = DocumentNativeFixture()
            let uiStore = makeStore(uiDriver)
            let uiDoc = DocumentFixture("可滚动英中对照", [.text((0..<16).map { "Paragraph \($0): the response was not significant (P > 0.05). Scientific identifiers IL-1β and NC-I-12-S remain intact." })])
            documents.append(uiDoc)
            uiStore.load(uiDoc)
            try await idle(uiStore)
            let probe = NSWindow(contentRect: NSRect(x: 180, y: 180, width: 760, height: 650),
                styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            window = probe
            probe.title = "Document Reading UI Probe"
            probe.contentMinSize = NSSize(width: 600, height: 420)
            probe.isReleasedWhenClosed = false
            probe.isMovable = true
            probe.isMovableByWindowBackground = true
            probe.contentView = NSHostingView(rootView: DocumentReadingView(store: uiStore, onOpenPDF: {}, onCapture: {}))
            probe.makeKeyAndOrderFront(nil)
            await settle(0.10)
            probe.contentView?.layoutSubtreeIfNeeded()
            let scrolls = descendants(probe.contentView).compactMap { $0 as? NSScrollView }
            try require(scrolls.contains { ($0.documentView?.frame.height ?? 0) > $0.contentView.bounds.height },
                "document UI has no vertically scrollable English/Chinese content")
            for type in [NSWindow.ButtonType.closeButton, .miniaturizeButton] {
                try require(probe.standardWindowButton(type)?.isEnabled == true &&
                    probe.standardWindowButton(type)?.isHiddenOrHasHiddenAncestor == false,
                    "document UI lost native close/minimize controls")
            }
            let size = probe.contentRect(forFrameRect: probe.frame).size
            try require(abs(size.width - 760) < 1 && abs(size.height - 650) < 1,
                "long document text expanded the initial reading window")
            checks["document_view_scrolls_in_fixed_initial_size_with_native_controls"] = true
            _ = try checkDocumentDragRegions(probe, observations: &observations)
            checks["document_blank_regions_dispatch_native_drag_without_intercepting_text_scroll_or_controls"] = true
        } catch { errorMessage = error.localizedDescription }
        for document in documents { await document.releaseHeld() }
        for driver in drivers { await driver.releaseHeld() }
        for store in stores { await store.shutdown() }
        window?.orderOut(nil)
        let report: [String: Any] = ["status": errorMessage == nil ? "PASS" : "FAIL", "checks": checks, "observations": observations,
            "error": errorMessage as Any? ?? NSNull()]
        do {
            let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
            print(String(decoding: data, as: UTF8.self))
        } catch {
            fputs("DOCUMENT_UI_SMOKE_JSON_FAILED: \(error.localizedDescription)\n", stderr)
            return false
        }
        return errorMessage == nil
    }

    @MainActor private static func checkDocumentDragRegions(_ window: NSWindow, observations: inout [String: Any]) throws -> Int {
        try require(window.isMovable && window.isMovableByWindowBackground,
            "document window does not enable native background movement")
        guard let content = window.contentView else { throw DocumentProbeFailure(message: "document window has no content view") }
        let allRegions = descendants(content).compactMap { $0 as? WindowDragRegionView }
        // SwiftUI's platform host may report an ancestor-sized visibleRect.
        // A clickable point must still lie inside the represented view's bounds.
        func exposedBounds(_ view: NSView) -> NSRect { view.bounds.intersection(view.visibleRect) }
        let regions = allRegions.filter {
            let rect = exposedBounds($0)
            return !$0.isHiddenOrHasHiddenAncestor && rect.width > 1 && rect.height > 1
        }
        func hit(at point: NSPoint, from view: NSView) -> NSView? {
            let inContent = content.convert(point, from: view)
            let inParent = content.superview.map { $0.convert(inContent, from: content) } ?? inContent
            return content.hitTest(inParent)
        }
        let regionDiagnostics = allRegions.enumerated().map { index, region -> [String: Any] in
            let rect = exposedBounds(region)
            let target = hit(at: NSPoint(x: rect.midX, y: rect.midY), from: region)
            return ["index": index, "frame": NSStringFromRect(region.frame),
                "bounds": NSStringFromRect(region.bounds), "visibleRect": NSStringFromRect(region.visibleRect),
                "exposedBounds": NSStringFromRect(rect), "hidden": region.isHiddenOrHasHiddenAncestor,
                "superclass": region.superview.map { String(describing: type(of: $0)) } ?? "nil",
                "hitclass": target.map { String(describing: type(of: $0)) } ?? "nil",
                "hitsNativeRegion": target === region]
        }
        observations["document_native_drag_regions"] = regionDiagnostics
        guard let region = regions.first(where: {
            let rect = exposedBounds($0)
            return hit(at: NSPoint(x: rect.midX, y: rect.midY), from: $0) === $0
        }) else {
            throw DocumentProbeFailure(message: "document has no exposed blank native drag region [\(regionDiagnostics)]")
        }
        try require(region.mouseDownCanMoveWindow && !region.acceptsFirstResponder && region.acceptsFirstMouse(for: nil),
            "blank drag region has incorrect native mouse/focus behavior")
        let previousHandler = region.beginDrag
        let wasMovable = window.isMovable
        defer { region.beginDrag = previousHandler; window.isMovable = wasMovable }
        var requests = 0
        var correctWindow = false
        region.beginDrag = { target, event in
            requests += 1
            correctWindow = target === window && event.type == .leftMouseDown
        }
        let bounds = exposedBounds(region)
        let location = region.convert(NSPoint(x: bounds.midX, y: bounds.midY), to: nil)
        guard let left = NSEvent.mouseEvent(with: .leftMouseDown, location: location,
            modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: window.windowNumber, context: nil, eventNumber: 2, clickCount: 1, pressure: 1),
              let right = NSEvent.mouseEvent(with: .rightMouseDown, location: location,
            modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: window.windowNumber, context: nil, eventNumber: 3, clickCount: 1, pressure: 1) else {
            throw DocumentProbeFailure(message: "could not construct owned-window drag routing events")
        }
        let frame = window.frame
        // Invoke only the probe-owned native view with an injected drag sink.
        // No global event or real window-tracking loop is synthesized.
        region.mouseDown(with: left)
        region.mouseDown(with: right)
        window.isMovable = false
        region.mouseDown(with: left)
        window.isMovable = wasMovable
        try require(requests == 1 && correctWindow && window.frame == frame,
            "blank region did not dispatch exactly one safe native left-button drag request")

        let interactive = descendants(content).filter {
            ($0 is NSScrollView || $0 is NSTextView || $0 is NSControl) &&
            !$0.isHiddenOrHasHiddenAncestor && exposedBounds($0).width > 1 && exposedBounds($0).height > 1
        }
        for view in interactive {
            let rect = exposedBounds(view)
            try require(!(hit(at: NSPoint(x: rect.midX, y: rect.midY), from: view) is WindowDragRegionView),
                "a blank drag region covers a native text, scroll, or control target")
        }
        // SwiftUI paragraph text may be virtual rather than NSTextView-backed.
        // Sample the visible scroll viewport as well as native controls above.
        for scroll in interactive.compactMap({ $0 as? NSScrollView }) {
            let clip = scroll.contentView
            let rect = exposedBounds(clip)
            guard rect.width > 2 && rect.height > 2 else { continue }
            for x in [0.2, 0.5, 0.8] {
                for y in [0.2, 0.5, 0.8] {
                    let target = hit(at: NSPoint(x: rect.minX + rect.width * x, y: rect.minY + rect.height * y), from: clip)
                    try require(target != nil && !(target is WindowDragRegionView),
                        "a blank drag region intercepts a paragraph/scroll viewport point")
                }
            }
        }
        observations["document_native_drag_exposed_count"] = regions.count
        observations["document_native_drag_interactive_targets_checked"] = interactive.count
        return regions.count
    }

    @MainActor private static func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        if !condition() { throw DocumentProbeFailure(message: message) }
    }
    @MainActor private static func settle(_ seconds: Double) async {
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }
    @MainActor private static func until(_ condition: @escaping @MainActor () async -> Bool) async throws {
        let deadline = Date(timeIntervalSinceNow: 3)
        while Date() < deadline { if await condition() { return }; await settle(0.005) }
        throw DocumentProbeFailure(message: "controlled document operation did not reach the expected state")
    }
    @MainActor private static func idle(_ store: DocumentReadingStore) async throws {
        try await until { !store.isTranslating }
    }
    @MainActor private static func descendants(_ root: NSView?) -> [NSView] {
        guard let root else { return [] }
        return [root] + root.subviews.flatMap { descendants($0) }
    }
}
