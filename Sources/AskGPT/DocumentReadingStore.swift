import Combine
import Foundation
import PDFKit
import AskGPTCore

struct DocumentReadingBlock: Identifiable, Sendable {
    let id: String
    let pageIndex: Int
    let originalText: String
    var translation = ""
    var failure: String?
    var isTranslating = false
    var refinement = ""
    var refinementFailure: String?
    var isRefining = false
    var refinementStatus = ""
}

struct DocumentReadingPage: Sendable {
    let index: Int
    let label: String
    let method: PDFTranslationExtractionMethod
    var blocks: [DocumentReadingBlock]
    var failure: String?
}

enum DocumentReadingScope: String, CaseIterable, Hashable {
    case currentPage, wholeDocument
    var title: String { self == .currentPage ? "当前页" : "全文" }
}

enum DocumentPDFDisplayMode: String, CaseIterable, Hashable {
    case translated, comparison, original
    var title: String {
        switch self { case .translated: return "译文"; case .comparison: return "对照"; case .original: return "原文" }
    }
    var outputMode: PDFLayoutOutputMode? {
        switch self { case .translated: return .mono; case .comparison: return .dual; case .original: return nil }
    }
}

enum DocumentTranslationDirection: String, CaseIterable, Hashable {
    case englishToChinese, chineseToEnglish
    var title: String { self == .englishToChinese ? "EN → 中" : "中 → EN" }
    var source: String { self == .englishToChinese ? "en" : "zh-Hans" }
    var target: String { self == .englishToChinese ? "zh-Hans" : "en" }
}

@MainActor final class DocumentReadingStore: ObservableObject {
    @Published var capturingSource = false
    @Published var sourceNote = ""
    @Published private(set) var title = "页面 / 全文对照"
    @Published private(set) var documentKind: BilingualDocumentKind?
    @Published private(set) var pageCount = 0
    @Published private(set) var currentPageIndex = 0
    @Published private(set) var scope: DocumentReadingScope = .currentPage
    @Published private(set) var pages: [Int: DocumentReadingPage] = [:]
    @Published private(set) var isTranslating = false
    @Published private(set) var status = "读取当前页面或打开 PDF，开始英中对照。"
    @Published private(set) var sourceError: String?
    @Published private(set) var memoryNotice: String?
    @Published private(set) var wholeDocumentCompleted = false
    @Published private(set) var retainedCharacters = 0
    @Published private(set) var pdfDisplayMode: DocumentPDFDisplayMode = .translated
    @Published private(set) var translationDirection: DocumentTranslationDirection = .englishToChinese
    @Published private(set) var originalPDFData: Data?
    @Published private(set) var translatedPDFData: Data?
    @Published private(set) var pdfSourcePages: [Int] = []
    private let settingsProvider: @MainActor () -> CodexSettings
    private let engineFactory: @MainActor () -> NativeTranslationEngine
    private let refinerFactory: @MainActor (CodexSettings) -> any PassageRefining
    private let translationTimeoutSeconds: Double
    private let memoryCharacterLimit: Int
    private let blockLimit: Int
    private var document: (any BilingualDocument)?
    private var documentGeneration = UUID()
    private var operationGeneration = UUID()
    private var worker: Task<Void, Never>?
    private var runningWholeDocument = false
    private var engine: NativeTranslationEngine?
    private var engineGeneration = UUID()
    private var activeNativeEngine: UUID?
    private var pageOrder: [Int] = []
    private var retainedBlocks = 0
    private var shuttingDown = false
    private let refinementCancellation = RequestCancellationGate()
    private var refiner: (any PassageRefining)?
    private var refinerSettings: CodexSettings?
    private var refinementTask: Task<Void, Never>?
    private var refinementGeneration = UUID()
    private var refinementLocation: (page: Int, block: String)?
    private let layoutService: any PDFLayoutServing
    private let layoutPollingNanoseconds: UInt64
    private var layoutJob: PDFLayoutJob?
    private var layoutOutputCache: [PDFLayoutOutputMode: Data] = [:]
    private var layoutTask: Task<Void, Never>?
    private var layoutOutputTask: Task<Void, Never>?
    private var layoutCancellationTask: Task<Void, Never>?
    private var layoutGeneration = UUID()
    private var outputGeneration = UUID()

    init(settingsProvider: @escaping @MainActor () -> CodexSettings,
         engineFactory: @escaping @MainActor () -> NativeTranslationEngine = { NativeTranslationEngine() },
         refinerFactory: @escaping @MainActor (CodexSettings) -> any PassageRefining = { GPTPassageRefiner(settings: $0) },
         translationTimeoutSeconds: Double = 3, memoryCharacterLimit: Int = 2_000_000,
         blockLimit: Int = 10_000, layoutService: any PDFLayoutServing = PDFLayoutService.shared,
         layoutPollingNanoseconds: UInt64 = 350_000_000) {
        self.settingsProvider = settingsProvider
        self.engineFactory = engineFactory
        self.refinerFactory = refinerFactory
        self.translationTimeoutSeconds = max(0.01, translationTimeoutSeconds)
        self.memoryCharacterLimit = max(1, memoryCharacterLimit)
        self.blockLimit = max(1, blockLimit)
        self.layoutService = layoutService
        self.layoutPollingNanoseconds = layoutPollingNanoseconds
    }

    var hasDocument: Bool { document != nil }
    var usesPDFLayout: Bool { originalPDFData != nil }
    var displayedPDFData: Data? {
        pdfDisplayMode == .original ? originalPDFData : (translatedPDFData ?? originalPDFData)
    }
    var displayedPDFPageIndex: Int {
        guard pdfDisplayMode != .original, translatedPDFData != nil else { return currentPageIndex }
        return pdfSourcePages.firstIndex(of: currentPageIndex) ?? 0
    }
    var displayedPDFIsTranslation: Bool { pdfDisplayMode != .original && translatedPDFData != nil }
    var currentPage: DocumentReadingPage? { pages[currentPageIndex] }
    var currentBlocks: [DocumentReadingBlock] { currentPage?.blocks ?? [] }
    var canReadWholeDocument: Bool { documentKind == .pdf && pageCount > 1 }
    var isRefining: Bool { refinementTask != nil }
    var completedPageCount: Int { pages.keys.filter { pageComplete($0) }.count }
    var completedBlockCount: Int { pages.values.reduce(0) { $0 + $1.blocks.filter { !$0.translation.isEmpty }.count } }
    var failedPageCount: Int { pages.values.filter { $0.failure != nil || $0.blocks.contains { $0.failure != nil } }.count }
    var progressDescription: String {
        if usesPDFLayout {
            return translatedPDFData == nil ? "原 PDF 已保留" : "已译 \(pdfSourcePages.count) / \(pageCount) 页 · 保留原版式"
        }
        return "已译 \(completedPageCount) / \(pageCount) 页 · \(completedBlockCount) 段" +
            (failedPageCount == 0 ? "" : " · \(failedPageCount) 页未完成")
    }

    func load(_ document: any BilingualDocument, currentPageIndex: Int = 0, pdfData: Data? = nil) {
        guard !shuttingDown else { return }
        stop()
        cancelLayoutWork(clearOutput: true)
        documentGeneration = UUID()
        originalPDFData = document.kind == .pdf ? pdfData : nil
        translatedPDFData = nil; pdfSourcePages = []
        layoutOutputCache.removeAll(); layoutJob = nil
        pdfDisplayMode = .translated
        self.document = document
        title = document.title
        documentKind = document.kind
        pageCount = max(0, document.pageCount)
        self.currentPageIndex = min(max(0, currentPageIndex), max(0, pageCount - 1))
        scope = .currentPage
        pages.removeAll(); pageOrder.removeAll()
        retainedCharacters = 0; retainedBlocks = 0
        wholeDocumentCompleted = false
        sourceError = nil; memoryNotice = nil
        guard pageCount > 0 else { sourceError = "文档没有可读取的页面。"; status = "未读取到页面"; return }
        start(wholeDocument: false)
    }

    func reportSourceError(_ message: String) {
        stop()
        sourceError = message
        status = "读取未完成"
    }

    func setScope(_ value: DocumentReadingScope) {
        let chosen = value == .wholeDocument && !canReadWholeDocument ? .currentPage : value
        guard scope != chosen else { return }
        scope = chosen
        if usesPDFLayout { start(wholeDocument: scope == .wholeDocument) }
    }

    func goToPage(_ index: Int) {
        guard index >= 0, index < pageCount, index != currentPageIndex else { return }
        currentPageIndex = index
        sourceError = nil
        if usesPDFLayout, let job = layoutJob,
           job.sourcePages.contains(index), job.sourcePages.count == pageCount,
           job.state == .running || job.state == .complete { return }
        if isTranslating && runningWholeDocument { return }
        start(wholeDocument: false)
    }

    func translateChosenScope() { start(wholeDocument: scope == .wholeDocument && canReadWholeDocument) }
    func translateWholeDocument() {
        guard canReadWholeDocument else { return }
        scope = .wholeDocument
        start(wholeDocument: true)
    }
    func retryVisible() { start(wholeDocument: false) }

    func setTranslationDirection(_ value: DocumentTranslationDirection) {
        guard translationDirection != value else { return }
        translationDirection = value
        cancelRefinement()
        pages.removeAll(); pageOrder.removeAll()
        retainedCharacters = 0; retainedBlocks = 0; wholeDocumentCompleted = false
        if hasDocument { start(wholeDocument: scope == .wholeDocument && canReadWholeDocument) }
    }

    func setPDFDisplayMode(_ value: DocumentPDFDisplayMode) {
        guard pdfDisplayMode != value else { return }
        pdfDisplayMode = value
        outputGeneration = UUID(); layoutOutputTask?.cancel(); layoutOutputTask = nil
        translatedPDFData = value.outputMode.flatMap { layoutOutputCache[$0] }
        guard let mode = value.outputMode, translatedPDFData == nil,
              let job = layoutJob, job.state == .complete else { return }
        let generation = layoutGeneration, outputID = outputGeneration
        layoutOutputTask = Task { [weak self] in
            guard let self else { return }
            do {
                let bytes = try await layoutService.output(id: job.id, mode: mode)
                try validatePDFOutput(bytes, for: job)
                guard !Task.isCancelled, layoutGeneration == generation, outputGeneration == outputID,
                      layoutJob?.id == job.id else { return }
                layoutOutputCache[mode] = bytes; translatedPDFData = bytes
            } catch is CancellationError {} catch {
                guard layoutGeneration == generation, outputGeneration == outputID else { return }
                sourceError = error.localizedDescription
            }
            if outputGeneration == outputID { layoutOutputTask = nil }
        }
    }

    /// The translated PDF contains only the requested source pages. Native
    /// navigation maps through that list instead of treating output page 1 as
    /// source page 1 (e.g. translating source page 3 creates one output page).
    func displayedPDFDidNavigate(to index: Int) {
        guard index >= 0 else { return }
        let source: Int
        if displayedPDFIsTranslation {
            guard pdfSourcePages.indices.contains(index) else { return }
            source = pdfSourcePages[index]
        } else { source = index }
        goToPage(source)
    }

    private func cancelLayoutWork(clearOutput: Bool) {
        layoutGeneration = UUID(); outputGeneration = UUID()
        let retiredTask = layoutTask
        retiredTask?.cancel(); layoutTask = nil
        layoutOutputTask?.cancel(); layoutOutputTask = nil
        let cancelledJob = layoutJob.flatMap { clearOutput || $0.state == .running ? $0 : nil }
        if cancelledJob != nil || retiredTask != nil {
            let service = layoutService
            let previous = layoutCancellationTask
            layoutCancellationTask = Task {
                await previous?.value
                // A cancelled create may still return an ID. Its retired task
                // cancels that ID before a replacement can enter the server.
                await retiredTask?.value
                if let cancelledJob { await service.cancel(id: cancelledJob.id) }
            }
            layoutJob = nil
        }
        if clearOutput {
            translatedPDFData = nil; pdfSourcePages = []
            layoutOutputCache.removeAll()
        }
    }

    private func startLayoutTranslation(wholeDocument: Bool) {
        guard !shuttingDown, let bytes = originalPDFData else { return }
        cancelNativeWork(); cancelRefinement(); cancelLayoutWork(clearOutput: true)
        sourceError = nil; memoryNotice = nil; wholeDocumentCompleted = false
        isTranslating = true; runningWholeDocument = wholeDocument
        status = "保版翻译中…"
        let generation = layoutGeneration, documentID = documentGeneration
        let requestedPages: [Int]? = wholeDocument ? nil : [currentPageIndex]
        let direction = translationDirection
        let cancellation = layoutCancellationTask
        layoutTask = Task { [weak self] in
            guard let self else { return }
            var createdJob: PDFLayoutJob?
            do {
                await cancellation?.value
                try Task.checkCancellation()
                guard isCurrentLayout(generation, documentID) else { return }
                var job = try await layoutService.createJob(data: bytes, pages: requestedPages,
                    source: direction.source, target: direction.target)
                createdJob = job
                guard isCurrentLayout(generation, documentID) else {
                    await layoutService.cancel(id: job.id); return
                }
                try validateLayoutJob(job, requestedPages: requestedPages)
                layoutJob = job; pdfSourcePages = job.sourcePages
                let deadline = Date().addingTimeInterval(3_600)
                while job.state == .running {
                    try Task.checkCancellation()
                    guard Date() < deadline else { throw PDFLayoutServiceError.requestFailed("保版翻译超时，原 PDF 已保留。") }
                    try await Task.sleep(nanoseconds: layoutPollingNanoseconds)
                    let next = try await layoutService.status(id: job.id)
                    guard isCurrentLayout(generation, documentID) else { return }
                    guard next.id == job.id, next.sourcePages == job.sourcePages,
                          next.pageCount == job.pageCount else { throw PDFLayoutServiceError.invalidResponse }
                    job = next; layoutJob = job
                }
                guard isCurrentLayout(generation, documentID) else { return }
                guard job.state == .complete else {
                    throw PDFLayoutServiceError.requestFailed(job.error.map { self.layoutFailureMessage($0) }
                        ?? (job.state == .cancelled ? "翻译已停止，原 PDF 已保留。" : "保版翻译未完成，原 PDF 已保留。"))
                }
                // Fetch both renderings once. Switching between them never
                // starts another translation or changes the source PDF.
                for mode in PDFLayoutOutputMode.allCases {
                    let output = try await layoutService.output(id: job.id, mode: mode)
                    try validatePDFOutput(output, for: job)
                    guard isCurrentLayout(generation, documentID) else { return }
                    layoutOutputCache[mode] = output
                    if pdfDisplayMode.outputMode == mode { translatedPDFData = output }
                }
                wholeDocumentCompleted = job.sourcePages.count == pageCount
                status = wholeDocumentCompleted ? "全文已完成 · 保留原版式" : "当前页已完成 · 保留原版式"
            } catch is CancellationError {
                if let createdJob { await layoutService.cancel(id: createdJob.id) }
                return
            } catch {
                guard isCurrentLayout(generation, documentID) else { return }
                sourceError = error.localizedDescription
                status = "保版翻译未完成 · 原 PDF 已保留"
                if let createdJob { await layoutService.cancel(id: createdJob.id) }
                layoutJob = nil
            }
            guard isCurrentLayout(generation, documentID) else { return }
            isTranslating = false; runningWholeDocument = false; layoutTask = nil
        }
    }

    private func isCurrentLayout(_ generation: UUID, _ documentID: UUID) -> Bool {
        generation == layoutGeneration && documentID == documentGeneration && !shuttingDown
    }

    private func validateLayoutJob(_ job: PDFLayoutJob, requestedPages: [Int]?) throws {
        let expected = requestedPages ?? Array(0..<pageCount)
        guard job.pageCount == pageCount, job.sourcePages == expected else {
            throw PDFLayoutServiceError.invalidResponse
        }
    }

    private func validatePDFOutput(_ bytes: Data, for job: PDFLayoutJob) throws {
        guard bytes.count <= 450 * 1_024 * 1_024,
              let pdf = PDFDocument(data: bytes), !pdf.isLocked,
              pdf.pageCount == job.sourcePages.count else { throw PDFLayoutServiceError.invalidResponse }
    }

    private func layoutFailureMessage(_ code: String) -> String {
        switch code {
        case "translation_timeout": return "保版翻译超时，请重试。"
        case "scanned_pdf_unsupported": return "暂不支持扫描版 PDF 的保版翻译，原 PDF 已保留。"
        case "runtime_missing": return "保版翻译组件尚未就绪，请稍后重试。"
        default: return "保版翻译未完成，请重试。"
        }
    }

    func stop() {
        cancelLayoutWork(clearOutput: false)
        cancelNativeWork()
        cancelRefinement()
        if hasDocument { status = "已停止；已完成译文已保留。" }
    }

    private func cancelNativeWork() {
        operationGeneration = UUID()
        worker?.cancel(); worker = nil
        if activeNativeEngine != nil { engine = nil; engineGeneration = UUID() }
        activeNativeEngine = nil
        runningWholeDocument = false
        isTranslating = false
        for index in Array(pages.keys) {
            guard var page = pages[index] else { continue }
            for block in page.blocks.indices where page.blocks[block].isTranslating {
                page.blocks[block].isTranslating = false
                page.blocks[block].failure = "已停止，可重试。"
            }
            pages[index] = page
        }
    }

    private func start(wholeDocument: Bool) {
        guard !shuttingDown, let document, pageCount > 0 else { return }
        if usesPDFLayout { startLayoutTranslation(wholeDocument: wholeDocument); return }
        cancelNativeWork()
        sourceError = nil; memoryNotice = nil
        let generation = operationGeneration
        let documentID = documentGeneration
        let startingPage = currentPageIndex
        runningWholeDocument = wholeDocument
        isTranslating = true
        status = wholeDocument ? "正在本机翻译全文…" : "正在读取当前页…"
        worker = Task { [weak self] in
            guard let self else { return }
            var pending = wholeDocument ? [startingPage] + (0..<pageCount).filter { $0 != startingPage } : [startingPage]
            var consecutiveFailures = 0
            var limited = false
            while !pending.isEmpty {
                guard isCurrent(generation, documentID), !Task.isCancelled else { return }
                // A page selected while whole-document work is running moves
                // ahead of pages that have not started yet.
                let offset = pending.firstIndex(of: currentPageIndex) ?? 0
                let index = pending.remove(at: offset)
                do {
                    try await readPage(index, from: document, wholeDocument: wholeDocument,
                        generation: generation, documentID: documentID)
                } catch is CancellationError { return }
                catch DocumentReadingError.memoryLimit { limited = true; break }
                catch {
                    guard isCurrent(generation, documentID) else { return }
                    pages[index] = DocumentReadingPage(index: index, label: "\(index + 1)", method: .textLayer,
                        blocks: [], failure: error.localizedDescription)
                    continue
                }
                guard isCurrent(generation, documentID) else { return }
                let blockIDs = pages[index]?.blocks.map(\.id) ?? []
                for blockID in blockIDs {
                    guard isCurrent(generation, documentID), !Task.isCancelled else { return }
                    guard let block = findBlock(page: index, id: blockID), block.translation.isEmpty else { continue }
                    updateBlock(page: index, id: blockID) { $0.isTranslating = true; $0.failure = nil }
                    status = wholeDocument ? "正在本机翻译第 \(index + 1) 页…" : "正在本机翻译当前页…"
                    if engine == nil { engine = engineFactory(); engineGeneration = UUID() }
                    let activeEngine = engine!, engineID = engineGeneration
                    activeNativeEngine = engineID
                    do {
                        let result = try await documentTranslationDeadline(seconds: translationTimeoutSeconds) {
                            try await activeEngine.translate(block.originalText, sourceLanguage: self.translationDirection.source,
                                targetLanguage: self.translationDirection.target)
                        }
                        guard isCurrent(generation, documentID), !Task.isCancelled else { return }
                        activeNativeEngine = nil
                        try reserve(additionalCharacters: result.text.count, additionalBlocks: 0,
                            preserving: index, wholeDocument: wholeDocument)
                        updateBlock(page: index, id: blockID) {
                            $0.translation = result.text; $0.failure = nil; $0.isTranslating = false
                        }
                        consecutiveFailures = 0
                    } catch is CancellationError { return }
                    catch DocumentReadingError.memoryLimit { limited = true; break }
                    catch {
                        guard isCurrent(generation, documentID) else { return }
                        activeNativeEngine = nil
                        if error as? NativeTranslationError == .timedOut, engineGeneration == engineID {
                            engine = nil; engineGeneration = UUID()
                        }
                        updateBlock(page: index, id: blockID) { $0.failure = error.localizedDescription; $0.isTranslating = false }
                        consecutiveFailures += 1
                        // Avoid opening indefinitely many native sessions when a
                        // system service is unavailable or repeatedly times out.
                        if consecutiveFailures >= 3 { break }
                    }
                }
                if limited || consecutiveFailures >= 3 { break }
            }
            guard isCurrent(generation, documentID) else { return }
            worker = nil; isTranslating = false; runningWholeDocument = false; activeNativeEngine = nil
            clearNativeBusyFlags()
            wholeDocumentCompleted = pageCount > 0 && (0..<pageCount).allSatisfy { self.pageComplete($0) }
            if limited {
                memoryNotice = "已达到本窗口的内存上限，全文尚未完成；可翻页继续本机翻译，较早页面缓存将按需释放。"
                status = "全文尚未完成"
            } else if wholeDocument {
                status = wholeDocumentCompleted ? "全文已完成 · 英中对照" : "全文尚未完成，可重试未完成页面。"
            } else {
                status = pageComplete(currentPageIndex) ? "当前页已完成 · 英中对照" : "当前页尚未完成，可重试。"
            }
        }
    }

    private func readPage(_ index: Int, from document: any BilingualDocument, wholeDocument: Bool,
                          generation: UUID, documentID: UUID) async throws {
        if let existing = pages[index], !existing.blocks.isEmpty { return }
        let page = try await document.page(at: index)
        try Task.checkCancellation()
        guard isCurrent(generation, documentID) else { throw CancellationError() }
        guard page.pageIndex == index, page.blocks.allSatisfy({ $0.pageIndex == index }) else {
            throw DocumentReadingError.invalidPage
        }
        guard !page.blocks.isEmpty else { throw DocumentReadingError.emptyPage }
        guard Set(page.blocks.map(\.blockID)).count == page.blocks.count else { throw DocumentReadingError.invalidPage }
        let characters = page.blocks.reduce(0) { $0 + $1.originalText.count }
        try reserve(additionalCharacters: characters, additionalBlocks: page.blocks.count,
            preserving: index, wholeDocument: wholeDocument)
        pages[index] = DocumentReadingPage(index: index, label: page.pageLabel, method: page.extractionMethod,
            blocks: page.blocks.map { DocumentReadingBlock(id: $0.blockID, pageIndex: index, originalText: $0.originalText) })
        retainedCharacters += characters; retainedBlocks += page.blocks.count
        pageOrder.removeAll { $0 == index }; pageOrder.append(index)
    }

    private func reserve(additionalCharacters: Int, additionalBlocks: Int, preserving index: Int,
                         wholeDocument: Bool) throws {
        func fits() -> Bool {
            additionalCharacters <= memoryCharacterLimit - retainedCharacters &&
                additionalBlocks <= blockLimit - retainedBlocks
        }
        if fits() { return }
        if !wholeDocument {
            for candidate in pageOrder where candidate != index && candidate != refinementLocation?.page {
                guard let removed = pages.removeValue(forKey: candidate) else { continue }
                retainedCharacters -= removed.blocks.reduce(0) { $0 + contentCount($1) }
                retainedBlocks -= removed.blocks.count
                if fits() { break }
            }
            pageOrder.removeAll { pages[$0] == nil }
            wholeDocumentCompleted = false
        }
        guard fits() else { throw DocumentReadingError.memoryLimit }
    }

    private func clearNativeBusyFlags() {
        for index in Array(pages.keys) {
            guard var page = pages[index] else { continue }
            for block in page.blocks.indices { page.blocks[block].isTranslating = false }
            pages[index] = page
        }
    }
    private func isCurrent(_ operation: UUID, _ document: UUID) -> Bool {
        operation == operationGeneration && document == documentGeneration && !shuttingDown
    }
    private func pageComplete(_ index: Int) -> Bool {
        guard let page = pages[index], page.failure == nil, !page.blocks.isEmpty else { return false }
        return page.blocks.allSatisfy { !$0.translation.isEmpty && $0.failure == nil && !$0.isTranslating }
    }
    private func findBlock(page: Int, id: String) -> DocumentReadingBlock? { pages[page]?.blocks.first { $0.id == id } }
    private func contentCount(_ block: DocumentReadingBlock) -> Int {
        block.originalText.count + block.translation.count + block.refinement.count
    }
    private func updateBlock(page index: Int, id: String, _ update: (inout DocumentReadingBlock) -> Void) {
        guard var page = pages[index], let block = page.blocks.firstIndex(where: { $0.id == id }) else { return }
        let before = contentCount(page.blocks[block])
        update(&page.blocks[block])
        retainedCharacters += contentCount(page.blocks[block]) - before
        pages[index] = page
    }

    func refineBlock(_ blockID: String) {
        let page = currentPageIndex
        guard !shuttingDown, let block = findBlock(page: page, id: blockID), !block.isRefining else { return }
        if !block.refinement.isEmpty, block.refinementFailure == nil { return }
        cancelRefinement()
        let configuration = PassageRefinementConfiguration.settings(from: settingsProvider())
        if let previous = refiner, refinerSettings != configuration {
            refiner = nil
            refinementCancellation.cancel(task: nil) { await previous.shutdown() }
        }
        if refiner == nil { refiner = refinerFactory(configuration); refinerSettings = configuration }
        guard let client = refiner else { return }
        let generation = refinementGeneration, documentID = documentGeneration
        let started = ProcessInfo.processInfo.systemUptime
        refinementLocation = (page, blockID)
        updateBlock(page: page, id: blockID) { $0.refinement = ""; $0.refinementFailure = nil; $0.isRefining = true; $0.refinementStatus = "正在精译…" }
        refinementTask = Task { [weak self] in
            guard let self else { return }
            await refinementCancellation.settle()
            guard !Task.isCancelled, generation == refinementGeneration, documentID == documentGeneration else { return }
            do {
                let result = try await client.refine(block.originalText, mode: .translation) { [weak self] delta in
                    Task { @MainActor in
                        guard let self, generation == self.refinementGeneration, documentID == self.documentGeneration else { return }
                        guard delta.count <= self.memoryCharacterLimit - self.retainedCharacters else {
                            self.cancelRefinement()
                            self.updateBlock(page: page, id: blockID) { $0.refinementFailure = "精译达到内存上限，已停止。" }
                            return
                        }
                        self.updateBlock(page: page, id: blockID) { $0.refinement += delta }
                    }
                }
                guard !Task.isCancelled, generation == refinementGeneration, documentID == documentGeneration else { return }
                let oldCharacters = findBlock(page: page, id: blockID)?.refinement.count ?? 0
                try reserve(additionalCharacters: max(0, result.text.count - oldCharacters), additionalBlocks: 0,
                    preserving: page, wholeDocument: false)
                updateBlock(page: page, id: blockID) {
                    $0.refinement = result.text; $0.isRefining = false
                    $0.refinementStatus = String(format: "完成 · %.1f 秒", ProcessInfo.processInfo.systemUptime - started)
                }
            } catch {
                guard generation == refinementGeneration, documentID == documentGeneration else { return }
                updateBlock(page: page, id: blockID) {
                    $0.isRefining = false; $0.refinementFailure = error.localizedDescription; $0.refinementStatus = "本次未完成"
                }
            }
            if generation == refinementGeneration {
                refinementGeneration = UUID()
                refinementTask = nil; refinementLocation = nil
            }
        }
    }

    private func cancelRefinement() {
        refinementGeneration = UUID()
        let task = refinementTask
        refinementTask = nil
        if let location = refinementLocation {
            updateBlock(page: location.page, id: location.block) {
                if $0.isRefining {
                    $0.isRefining = false; $0.refinementFailure = "已停止，可重试。"; $0.refinementStatus = "已停止"
                }
            }
        }
        refinementLocation = nil
        if task != nil { refinementCancellation.cancel(task: task) {} }
    }

    func shutdown() async {
        shuttingDown = true
        stop()
        if let client = refiner {
            refiner = nil; refinerSettings = nil
            refinementCancellation.cancel(task: nil) { await client.shutdown() }
        }
        await refinementCancellation.settle()
        await layoutCancellationTask?.value
    }
}

private enum DocumentReadingError: LocalizedError {
    case memoryLimit, invalidPage, emptyPage
    var errorDescription: String? {
        switch self {
        case .memoryLimit: return "本页或全文超过本窗口的内存上限，请缩小文档或逐页继续。"
        case .invalidPage: return "文档返回的页码或段落标识不一致，当前页未完成。"
        case .emptyPage: return "当前页没有可读取的文字，可换页或重试。"
        }
    }
}

// Unstructured race: timeout/cancellation never waits for an unresponsive native
// XPC operation. Its retired engine cannot queue the next page behind that tail.
private func documentTranslationDeadline<Value: Sendable>(seconds: Double,
    operation: @escaping @Sendable () async throws -> Value) async throws -> Value {
    let waiter = DocumentTranslationWaiter<Value>()
    let job = Task { try await operation() }
    let timer = Task {
        do { try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) }
        catch { return }
        waiter.finish(.failure(NativeTranslationError.timedOut))
    }
    defer { job.cancel(); timer.cancel() }
    let value = try await withTaskCancellationHandler {
        try await withCheckedThrowingContinuation { continuation in
            waiter.install(continuation)
            Task { waiter.finish(await job.result) }
        }
    } onCancel: {
        job.cancel()
        waiter.finish(.failure(CancellationError()))
    }
    try Task.checkCancellation()
    return value
}

private final class DocumentTranslationWaiter<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var result: Result<Value, Error>?
    private var continuation: CheckedContinuation<Value, Error>?
    func install(_ continuation: CheckedContinuation<Value, Error>) {
        lock.lock()
        if let result { lock.unlock(); continuation.resume(with: result) }
        else { self.continuation = continuation; lock.unlock() }
    }
    func finish(_ result: Result<Value, Error>) {
        lock.lock()
        guard self.result == nil else { lock.unlock(); return }
        self.result = result
        let continuation = self.continuation; self.continuation = nil
        lock.unlock()
        continuation?.resume(with: result)
    }
}
