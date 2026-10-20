import AppKit
import SwiftUI
import AskGPTCore

/// Visual presets only. The window/controller owns any document annotation.
enum WordWritingMarkPalette: String, CaseIterable, Identifiable {
    case amber, rose, ocean, mint
    var id: String { rawValue }
    var title: String {
        switch self { case .amber: return "琥珀橙"; case .rose: return "玫瑰"; case .ocean: return "海蓝"; case .mint: return "薄荷" }
    }
    var colors: [Color] {
        switch self {
        case .amber: return [Color(red: 1, green: 149.0/255.0, blue: 0), Color(red: 1, green: 214.0/255.0, blue: 10.0/255.0)]
        case .rose: return [Color(red: 184.0/255.0, green: 109.0/255.0, blue: 130.0/255.0), Color(red: 204.0/255.0, green: 155.0/255.0, blue: 161.0/255.0)]
        case .ocean: return [Color(red: 93.0/255.0, green: 131.0/255.0, blue: 185.0/255.0), Color(red: 123.0/255.0, green: 169.0/255.0, blue: 188.0/255.0)]
        case .mint: return [Color(red: 83.0/255.0, green: 142.0/255.0, blue: 131.0/255.0), Color(red: 142.0/255.0, green: 182.0/255.0, blue: 161.0/255.0)]
        }
    }
    var fillOpacity: CGFloat { self == .amber ? 0.32 : 0.20 }
    static func preferred(defaults: UserDefaults = .standard) -> Self {
        if defaults.integer(forKey: "WritingMarkPaletteRevision") < 1 {
            defaults.set(Self.amber.rawValue, forKey: "WritingMarkPalette")
            defaults.set(1, forKey: "WritingMarkPaletteRevision")
            return .amber
        }
        return defaults.string(forKey: "WritingMarkPalette").flatMap(Self.init(rawValue:)) ?? .amber
    }
    var gradient: LinearGradient { LinearGradient(colors: colors, startPoint: .leading, endPoint: .trailing) }
}

enum WordWritingPopoverContent {
    case spelling(WritingIssue)
    case polish(WritingPolishComparison)
}

/// Native presentation only: actions must be supplied by the document-bound
/// controller, whose fresh host verification decides whether a write is safe.
struct WordWritingPopoverView: View {
    let content: WordWritingPopoverContent
    var canApply: Bool
    var isLoading: Bool = false
    var errorMessage: String? = nil
    var applicationNote: String? = nil
    var palette: WordWritingMarkPalette = .amber
    var onPalette: (WordWritingMarkPalette) -> Void
    var onApply: () -> Void
    var onIgnore: () -> Void
    var onAddTerm: () -> Void
    var onStop: () -> Void
    var onApplyIssue: ((String) -> Void)?
    var applicableIssueIDs: Set<String>?
    var activityLabel: String?
    var canStop: Bool
    var isPreparing: Bool
    var needsReopen: Bool
    var onReopen: (() -> Void)?

    init(content: WordWritingPopoverContent, canApply: Bool, isLoading: Bool = false,
         errorMessage: String? = nil, applicationNote: String? = nil,
         palette: WordWritingMarkPalette = .amber,
         onPalette: @escaping (WordWritingMarkPalette) -> Void,
         onApply: @escaping () -> Void, onIgnore: @escaping () -> Void,
         onAddTerm: @escaping () -> Void, onStop: @escaping () -> Void,
         onApplyIssue: ((String) -> Void)? = nil, applicableIssueIDs: Set<String>? = nil,
         activityLabel: String? = nil, canStop: Bool = true,
         isPreparing: Bool = false, needsReopen: Bool = false, onReopen: (() -> Void)? = nil) {
        self.content = content; self.canApply = canApply; self.isLoading = isLoading
        self.errorMessage = errorMessage; self.applicationNote = applicationNote; self.palette = palette
        self.onPalette = onPalette; self.onApply = onApply; self.onIgnore = onIgnore
        self.onAddTerm = onAddTerm; self.onStop = onStop
        self.onApplyIssue = onApplyIssue; self.applicableIssueIDs = applicableIssueIDs
        self.activityLabel = activityLabel; self.canStop = canStop
        self.isPreparing = isPreparing; self.needsReopen = needsReopen; self.onReopen = onReopen
    }

    @State private var showsDetails = false
    @State private var selectedIssueID: String?
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text(title).font(.system(size: 15, weight: .semibold))
                Spacer(minLength: 12)
                paletteMenu
            }
            switch content {
            case .spelling(let issue):
                spellingContent(issue).fixedSize(horizontal: false, vertical: true)
            case .polish(let comparison):
                ScrollView {
                    polishContent(comparison).frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(minHeight: 150, maxHeight: 420)
            }
            if let applicationNote, !applicationNote.isEmpty {
                Text(applicationNote).font(.system(size: 13)).foregroundStyle(.secondary)
                    .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }
            if let errorMessage, !errorMessage.isEmpty {
                Label {
                    Text(errorMessage).textSelection(.enabled)
                } icon: { Image(systemName: "exclamationmark.circle") }
                .font(.system(size: 13)).foregroundStyle(.red).accessibilityElement(children: .combine)
                .fixedSize(horizontal: false, vertical: true)
            }
            actions
        }
        .padding(16)
        .frame(minWidth: 300, idealWidth: 390, maxWidth: 520, alignment: .leading)
        .background { GlassBackdrop() }
    }

    private var title: String {
        switch content {
        case .spelling(let issue): return isPunctuation(issue) ? "标点" : "拼写"
        case .polish: return "润色"
        }
    }
    private func isPunctuation(_ issue: WritingIssue) -> Bool {
        !issue.original.isEmpty && issue.original.unicodeScalars.allSatisfy {
            CharacterSet.punctuationCharacters.contains($0) || CharacterSet.whitespaces.contains($0)
        }
    }
    private var hasChanges: Bool {
        switch content {
        case .spelling(let issue): return !issue.original.utf8.elementsEqual(issue.replacement.utf8)
        case .polish(let comparison): return !comparison.changes.isEmpty
        }
    }
    private var paletteMenu: some View {
        Menu {
            ForEach(WordWritingMarkPalette.allCases) { choice in
                Button { onPalette(choice) } label: {
                    Label(choice.title, systemImage: palette == choice ? "checkmark" : "circle")
                }
            }
        } label: {
            Circle().fill(palette.gradient).frame(width: 15, height: 15)
                .overlay { Circle().strokeBorder(Color.primary.opacity(contrast == .increased ? 0.6 : 0.12)) }
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
        .help("标注色").accessibilityLabel("标注色：\(palette.title)")
    }

    @ViewBuilder private func spellingContent(_ issue: WritingIssue) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(issue.original)
                .font(.system(size: 19, weight: .medium)).textSelection(.enabled)
                .overlay(alignment: .bottom) {
                    Capsule().fill(palette.gradient).frame(height: contrast == .increased ? 3 : 2)
                        .offset(y: 4).allowsHitTesting(false).accessibilityHidden(true)
                }
            if hasChanges {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Image(systemName: "arrow.right").foregroundStyle(.secondary).accessibilityHidden(true)
                    Text(issue.replacement.isEmpty ? "删除" : issue.replacement)
                        .font(.system(size: 17, weight: .medium)).textSelection(.enabled)
                }
                if isPunctuation(issue), !issue.reason.isEmpty {
                    Text(issue.reason).font(.system(size: 13)).foregroundStyle(.secondary)
                }
            } else if !issue.reason.isEmpty {
                Text(issue.reason).font(.system(size: 13)).foregroundStyle(.secondary).textSelection(.enabled)
            }
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading).glassCard(radius: 11)
    }

    @ViewBuilder private func polishContent(_ comparison: WritingPolishComparison) -> some View {
        previewBlock("原文", segments: comparison.originalSegments)
        previewBlock("修改稿", segments: comparison.revisedSegments, emptyLabel: "删除所选文字")
        if comparison.changes.count > 1, onApplyIssue != nil {
            Picker("本次修改", selection: Binding(get: { selectedIssueID ?? comparison.changes[0].id }, set: { selectedIssueID = $0 })) {
                ForEach(comparison.changes) { issue in
                    Text("\(issue.original) → \(issue.replacement.isEmpty ? "删除" : issue.replacement)").tag(issue.id)
                }
            }.pickerStyle(.menu)
        }
        if !comparison.questions.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(comparison.questions) { question in
                    Label {
                        Text(question.reason).textSelection(.enabled)
                    } icon: { Image(systemName: "questionmark.circle") }
                    .font(.system(size: 13)).foregroundStyle(.secondary)
                }
            }
        }
        if !comparison.rows.isEmpty {
            DisclosureGroup("修改详情", isExpanded: $showsDetails) {
                comparisonTable(comparison.rows).padding(.top, 10)
            }
            .font(.system(size: 13, weight: .medium))
        }
    }

    private func previewBlock(_ label: String, segments: [WritingPolishComparison.Segment], emptyLabel: String = "") -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(label).font(.system(size: 12, weight: .medium)).foregroundStyle(.secondary)
            if segments.isEmpty {
                Text(emptyLabel).font(.system(size: 14)).foregroundStyle(.secondary)
            } else {
                diffText(segments).font(.system(size: 14)).lineSpacing(4).textSelection(.enabled)
            }
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading).glassCard(radius: 11)
    }
    private func diffText(_ segments: [WritingPolishComparison.Segment]) -> Text {
        segments.reduce(Text("")) { result, segment in
            let text = Text(segment.text)
            switch segment.emphasis {
            case .unchanged: return result + text
            case .removed: return result + text.underline(true, color: palette.colors[0])
            case .inserted: return result + text.fontWeight(.semibold)
            }
        }
    }
    private func comparisonTable(_ rows: [WritingPolishComparison.Row]) -> some View {
        Grid(alignment: .topLeading, horizontalSpacing: 12, verticalSpacing: 10) {
            GridRow {
                tableCell("原表达", header: true)
                tableCell("修改", header: true)
                tableCell("理由", header: true)
            }
            ForEach(rows) { row in
                GridRow {
                    tableCell(row.original)
                    tableCell(row.replacement.map { $0.isEmpty ? "删除" : $0 } ?? "待确认")
                    tableCell(row.reason)
                }
            }
        }
        .font(.system(size: 13))
    }
    private func tableCell(_ text: String, header: Bool = false) -> some View {
        Text(text).fontWeight(header ? .semibold : .regular)
            .foregroundStyle(header ? Color.secondary : Color.primary)
            .frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
    }

    private var actions: some View {
        HStack(spacing: 8) {
            if isLoading || isPreparing {
                ProgressView().controlSize(.small)
                Text(isPreparing && !isLoading ? "正在核对文字…" : activityLabel ?? (contentIsSpelling ? "检查中…" : "润色中…"))
                    .font(.system(size: 13)).foregroundStyle(.secondary)
                Spacer(minLength: 8)
                if canStop { Button(isPreparing && !isLoading ? "关闭" : "停止", action: onStop).buttonStyle(GlassButtonStyle()) }
            } else {
                if needsReopen {
                    Button("关闭并重查") { onReopen?() }.buttonStyle(GlassButtonStyle(prominent: true))
                } else {
                    Button(contentIsSpelling ? "替换" : "替换这一处", action: applySelected).buttonStyle(GlassButtonStyle(prominent: true))
                        .disabled(!selectedCanApply || !hasChanges).keyboardShortcut(.defaultAction)
                }
                Button(contentIsSpelling && !needsReopen ? "忽略" : "关闭", action: needsReopen ? onStop : onIgnore).buttonStyle(GlassButtonStyle())
                Spacer(minLength: 0)
                if contentIsSpelling && !needsReopen {
                    Button("加词典", action: onAddTerm).buttonStyle(GlassButtonStyle())
                }
            }
        }
    }
    private var contentIsSpelling: Bool {
        if case .spelling = content { return true }
        return false
    }
    private var selectedCanApply: Bool {
        guard case .polish(let comparison) = content, let applicableIssueIDs else { return canApply }
        guard let id = selectedIssueID ?? comparison.changes.first?.id else { return false }
        return applicableIssueIDs.contains(id)
    }
    private func applySelected() {
        if case .polish(let comparison) = content, let onApplyIssue,
           let id = selectedIssueID ?? comparison.changes.first?.id { onApplyIssue(id) }
        else { onApply() }
    }
}
