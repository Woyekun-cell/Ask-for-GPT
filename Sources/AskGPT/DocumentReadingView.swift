import SwiftUI
import PDFKit
import AskGPTCore

struct DocumentReadingView: View {
    @ObservedObject var store: DocumentReadingStore
    var onOpenPDF: () -> Void
    var onCapture: () -> Void
    @State private var pageNumber = "1"

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(store.title).font(.system(size: 16, weight: .semibold)).lineLimit(1)
                        .help(store.title)
                    if !store.usesPDFLayout {
                        Text("原文与译文逐段对照").font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                }.background { WindowDragRegion() }
                Spacer(minLength: 8).background { WindowDragRegion() }
                Button(action: onCapture) {
                    Label(store.capturingSource ? "读取中…" : "读取当前页", systemImage: "doc.text.viewfinder")
                }.disabled(store.capturingSource)
                Button("打开 PDF…", action: onOpenPDF).disabled(store.capturingSource)
            }.buttonStyle(GlassButtonStyle())

            if store.capturingSource && !store.usesPDFLayout {
                HStack(spacing: 7) {
                    ProgressView().controlSize(.small)
                    Text("正在识别当前网页或 PDF…").font(.system(size: 12)).foregroundStyle(.secondary)
                }
            }
            if !store.sourceNote.isEmpty {
                Text(store.sourceNote).font(.system(size: 11)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            }
            if let error = store.sourceError {
                Label(error, systemImage: "exclamationmark.circle")
                    .font(.system(size: 12)).foregroundStyle(.secondary).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if store.hasDocument {
                controls
                if let notice = store.memoryNotice {
                    Text(notice).font(.system(size: 11)).foregroundStyle(.secondary)
                        .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                }
                if store.usesPDFLayout, let bytes = store.displayedPDFData {
                    LayoutPreservingPDFView(data: bytes, pageIndex: store.displayedPDFPageIndex,
                        onPageChange: { store.displayedPDFDidNavigate(to: $0) })
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(Color(nsColor: .textBackgroundColor))
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                } else {
                  ScrollViewReader { proxy in
                    ScrollView(.vertical, showsIndicators: true) {
                        LazyVStack(alignment: .leading, spacing: 12) {
                            Color.clear.frame(height: 1).id("document-page-top")
                            if let page = store.currentPage {
                                HStack {
                                    Text(pageHeading(page)).font(.system(size: 11)).foregroundStyle(.secondary)
                                    Spacer()
                                    if page.method == .ocr {
                                        Text("本机文字识别").font(.system(size: 10)).foregroundStyle(.secondary)
                                    }
                                }
                                if let failure = page.failure {
                                    VStack(alignment: .leading, spacing: 10) {
                                        Text(failure).font(.system(size: 13)).textSelection(.enabled)
                                        Button("重试本页") { store.retryVisible() }.buttonStyle(GlassButtonStyle())
                                    }.padding(14).frame(maxWidth: .infinity, alignment: .leading).glassCard(radius: 14)
                                }
                                ForEach(page.blocks) { block in
                                    DocumentReadingParagraph(block: block,
                                        onRefine: { store.refineBlock(block.id) },
                                        onRetry: { store.retryVisible() })
                                }
                            } else if store.isTranslating {
                                ProgressView("正在读取页面…").controlSize(.small).padding(.vertical, 24)
                            } else {
                                Text("本页尚未完成。可翻译本页或调整页码。")
                                    .font(.system(size: 13)).foregroundStyle(.secondary).padding(.vertical, 24)
                            }
                        }.padding(.horizontal, 2).padding(.bottom, 10)
                    }.scrollIndicators(.visible)
                        .onChange(of: store.currentPageIndex) { _ in proxy.scrollTo("document-page-top", anchor: .top) }
                  }
                }
                if !store.usesPDFLayout {
                  HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(store.status).font(.system(size: 11)).lineLimit(2)
                        Text(store.progressDescription).font(.system(size: 10)).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 6)
                    Text("全文仅本机翻译；GPT 仅精译所点段落")
                        .font(.system(size: 10)).foregroundStyle(.secondary).multilineTextAlignment(.trailing)
                  }.background { WindowDragRegion() }
                }
            } else {
                Spacer()
                VStack(alignment: .leading, spacing: 10) {
                    Text("从当前页开始阅读").font(.system(size: 20, weight: .semibold))
                    Text("读取当前网页，或打开本机 PDF。默认翻译当前页；PDF 也可以选择全文。")
                        .font(.system(size: 13)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }.padding(20).frame(maxWidth: .infinity, alignment: .leading).glassCard()
                Spacer()
            }
        }
        .padding(16).frame(minWidth: 600, minHeight: 420).background { GlassBackdrop() }
        .overlay {
            VStack { WindowDragRegion().frame(height: 10); Spacer(); WindowDragRegion().frame(height: 10) }
        }
        .overlay {
            HStack { WindowDragRegion().frame(width: 10); Spacer(); WindowDragRegion().frame(width: 10) }
        }
        .onAppear { pageNumber = "\(store.currentPageIndex + 1)" }
        .onChange(of: store.currentPageIndex) { value in pageNumber = "\(value + 1)" }
        .onChange(of: store.pageCount) { _ in pageNumber = "\(store.currentPageIndex + 1)" }
    }

    private var controls: some View {
        VStack(alignment: .leading, spacing: 8) {
          if store.usesPDFLayout {
            HStack(spacing: 10) {
                Picker("显示", selection: Binding(get: { store.pdfDisplayMode }, set: { store.setPDFDisplayMode($0) })) {
                    ForEach(DocumentPDFDisplayMode.allCases, id: \.self) { Text($0.title).tag($0) }
                }.pickerStyle(.segmented).labelsHidden().frame(width: 186)
                Spacer(minLength: 4)
                Picker("翻译方向", selection: Binding(get: { store.translationDirection }, set: { store.setTranslationDirection($0) })) {
                    ForEach(DocumentTranslationDirection.allCases, id: \.self) { Text($0.title).tag($0) }
                }.pickerStyle(.segmented).labelsHidden().frame(width: 150)
            }
          }
          HStack(spacing: 8) {
            Button { store.goToPage(store.currentPageIndex - 1) } label: { Image(systemName: "chevron.left") }
                .disabled(store.currentPageIndex == 0 || store.capturingSource).help("上一页")
            HStack(spacing: 4) {
                TextField("页码", text: $pageNumber).textFieldStyle(.roundedBorder)
                    .frame(width: 46).multilineTextAlignment(.center)
                    .onSubmit {
                        if let value = Int(pageNumber) { store.goToPage(value - 1) }
                        pageNumber = "\(store.currentPageIndex + 1)"
                    }
                    .disabled(store.pageCount < 2 || store.capturingSource)
                    .accessibilityLabel("PDF 实际页码")
                Text("/ \(store.pageCount)").font(.system(size: 12)).foregroundStyle(.secondary)
            }
            Button { store.goToPage(store.currentPageIndex + 1) } label: { Image(systemName: "chevron.right") }
                .disabled(store.currentPageIndex + 1 >= store.pageCount || store.capturingSource).help("下一页")
            Spacer(minLength: 4)
            Picker("翻译范围", selection: Binding(get: { store.scope }, set: { store.setScope($0) })) {
                Text("当前页").tag(DocumentReadingScope.currentPage)
                if store.canReadWholeDocument { Text("全文").tag(DocumentReadingScope.wholeDocument) }
            }.pickerStyle(.segmented).labelsHidden().frame(width: store.canReadWholeDocument ? 128 : 70)
                .disabled(store.capturingSource)
            if store.isTranslating || store.isRefining {
                Button("停止") { store.stop() }
            } else {
                Button(store.scope == .wholeDocument ? "翻译全文" : "翻译本页") {
                    store.translateChosenScope()
                }.disabled(store.capturingSource)
            }
          }.buttonStyle(GlassButtonStyle())
        }
    }

    private func pageHeading(_ page: DocumentReadingPage) -> String {
        if store.documentKind == .webpage { return "网页正文" }
        let base = "第 \(page.index + 1) / \(store.pageCount) 页"
        return page.label == "\(page.index + 1)" || page.label.isEmpty ? base : base + " · 原页标 \(page.label)"
    }
}

/// Displays generated PDF bytes with PDFKit's native zoom, selection, copying,
/// and scrolling. No annotations are inserted and the source file is never saved.
private struct LayoutPreservingPDFView: NSViewRepresentable {
    let data: Data
    let pageIndex: Int
    let onPageChange: (Int) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onPageChange: onPageChange) }

    func makeNSView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.displayMode = .singlePageContinuous
        view.displayDirection = .vertical
        view.displaysPageBreaks = true
        view.backgroundColor = .underPageBackgroundColor
        context.coordinator.attach(view)
        return view
    }

    func updateNSView(_ view: PDFView, context: Context) {
        let coordinator = context.coordinator
        coordinator.onPageChange = onPageChange
        coordinator.updating = true
        defer { coordinator.updating = false }
        let documentChanged = coordinator.bytes != data
        if documentChanged {
            coordinator.bytes = data
            coordinator.alignmentGeneration = UUID()
            coordinator.pendingAlignment = true
            view.autoScales = false
            view.document = PDFDocument(data: data)
        }
        if let document = view.document, let target = document.page(at: pageIndex),
           documentChanged || view.currentPage !== target {
            let needsDeferredAlignment = documentChanged || coordinator.pendingAlignment
            coordinator.alignmentGeneration = UUID()
            coordinator.alignTop(of: target, in: view, resetScale: documentChanged)
            if needsDeferredAlignment {
                let generation = coordinator.alignmentGeneration
                // PDFKit lays out a new document again after SwiftUI gives it
                // its final frame. Align after that pass as well, including
                // when currentPage already equals the mapped target page.
                DispatchQueue.main.async { [weak view, weak coordinator, weak document, weak target] in
                    guard let view, let coordinator, let document, let target,
                          coordinator.alignmentGeneration == generation,
                          view.document === document else { return }
                    coordinator.updating = true
                    defer { coordinator.updating = false; coordinator.pendingAlignment = false }
                    coordinator.alignTop(of: target, in: view, resetScale: true)
                }
            }
        }
    }

    static func dismantleNSView(_ nsView: PDFView, coordinator: Coordinator) { coordinator.detach() }

    final class Coordinator {
        var onPageChange: (Int) -> Void
        var bytes: Data?
        var updating = false
        var pendingAlignment = false
        var alignmentGeneration = UUID()
        private var observer: NSObjectProtocol?
        init(onPageChange: @escaping (Int) -> Void) { self.onPageChange = onPageChange }
        func alignTop(of page: PDFPage, in view: PDFView, resetScale: Bool) {
            view.layoutDocumentView()
            if resetScale {
                view.autoScales = true
                let fit = view.scaleFactorForSizeToFit
                if fit.isFinite, fit > 0 { view.scaleFactor = fit }
                view.layoutDocumentView()
            }
            let bounds = page.bounds(for: view.displayBox)
            view.go(to: PDFDestination(page: page, at: CGPoint(x: bounds.minX, y: bounds.maxY)))
            guard let documentView = view.documentView,
                  let scroll = documentView.enclosingScrollView else { return }
            // Convert through the laid-out document view so crop-box offsets
            // and rotated pages use their visual top, not unrotated PDF y.
            let pageRect = documentView.convert(view.convert(bounds, from: page), from: view)
            let clip = scroll.contentView
            let top = documentView.isFlipped ? pageRect.minY - view.pageBreakMargins.top
                : pageRect.maxY - clip.bounds.height + view.pageBreakMargins.top
            let proposed = NSRect(x: pageRect.minX - view.pageBreakMargins.left, y: top,
                width: clip.bounds.width, height: clip.bounds.height)
            clip.scroll(to: clip.constrainBoundsRect(proposed).origin)
            scroll.reflectScrolledClipView(clip)
        }
        func attach(_ view: PDFView) {
            observer = NotificationCenter.default.addObserver(forName: .PDFViewPageChanged, object: view, queue: .main) { [weak self, weak view] _ in
                guard let self, !self.updating, !self.pendingAlignment, let view, let page = view.currentPage,
                      let document = view.document else { return }
                let index = document.index(for: page)
                guard index != NSNotFound else { return }
                // Avoid publishing SwiftUI state during PDFView layout.
                DispatchQueue.main.async { [weak self, weak view, weak document, weak page] in
                    guard let self, !self.updating, !self.pendingAlignment, let view, let document, let page,
                          view.document === document, view.currentPage === page else { return }
                    self.onPageChange(index)
                }
            }
        }
        func detach() { if let observer { NotificationCenter.default.removeObserver(observer) }; observer = nil }
        deinit { detach() }
    }
}

private struct DocumentReadingParagraph: View {
    let block: DocumentReadingBlock
    var onRefine: () -> Void
    var onRetry: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("英文原文").font(.system(size: 10, weight: .medium)).foregroundStyle(.secondary)
            Text(block.originalText).font(.system(size: 14)).lineSpacing(4).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
            Divider()
            HStack {
                Text("本机初译").font(.system(size: 10, weight: .medium)).foregroundStyle(.secondary)
                if block.isTranslating { ProgressView().controlSize(.small) }
                Spacer()
                Button(block.refinementFailure == nil ? "GPT 精译" : "重试精译", action: onRefine)
                    .buttonStyle(.link).font(.system(size: 11))
                    .disabled(block.isRefining || (!block.refinement.isEmpty && block.refinementFailure == nil))
            }
            if !block.translation.isEmpty {
                Text(block.translation).font(.system(size: 14)).lineSpacing(4).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
            } else if let failure = block.failure {
                Text(failure).font(.system(size: 12)).foregroundStyle(.secondary).textSelection(.enabled)
                Button("重试本页", action: onRetry).buttonStyle(.link).font(.system(size: 11))
            } else {
                Text(block.isTranslating ? "正在本机翻译…" : "等待本机翻译")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
            }
            if block.isRefining || !block.refinement.isEmpty || block.refinementFailure != nil {
                Divider()
                HStack(spacing: 6) {
                    Text(block.isRefining ? "GPT 精译中 · 本机初译保留在上方" : "GPT 精译")
                        .font(.system(size: 10, weight: .medium)).foregroundStyle(.secondary)
                    if block.isRefining { ProgressView().controlSize(.small) }
                    Spacer()
                    if !block.refinementStatus.isEmpty && !block.isRefining {
                        Text(block.refinementStatus).font(.system(size: 10)).foregroundStyle(.secondary)
                    }
                }
                if !block.refinement.isEmpty {
                    Text(.init(block.refinement)).font(.system(size: 14)).lineSpacing(4).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
                }
                if let failure = block.refinementFailure {
                    Text(failure).font(.system(size: 12)).foregroundStyle(.secondary).textSelection(.enabled)
                }
            }
        }.padding(14).frame(maxWidth: .infinity, alignment: .leading).glassCard(radius: 14)
    }
}
