import SwiftUI
import AppKit
import Carbon
import AskGPTCore

struct ReaderView: View {
    @ObservedObject var store: ReaderStore
    @State private var inputFocused = false
    @State private var excerptExpanded = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 8) {
                DisclosureGroup(isExpanded: $excerptExpanded) {
                    VStack(alignment: .leading, spacing: 10) {
                        TextEditor(text: $store.pastedExcerpt)
                            .font(.system(size: 12)).scrollContentBackground(.hidden)
                            .frame(minHeight: 54, maxHeight: 88).padding(5)
                            .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 10))
                            .accessibilityLabel("原文")
                        HStack {
                            Spacer()
                            Button("使用原文") { store.usePastedExcerpt() }.buttonStyle(GlassButtonStyle())
                        }
                    }.padding(.top, 8)
                } label: {
                    SectionHeading(title: "原文", symbol: "text.alignleft")
                }
                .padding(10).glassCard(radius: 12)
                Button {
                    store.newConversation()
                    excerptExpanded = false
                    inputFocused = true
                } label: {
                    Image(systemName: "square.and.pencil").frame(width: 28, height: 34)
                }
                .buttonStyle(.borderless).help("新对话").accessibilityLabel("新对话")
            }.padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 4)

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        if store.ledger.messages.isEmpty { emptyState }
                        ForEach(store.ledger.messages) { message in
                            VStack(alignment: .leading, spacing: 7) {
                                HStack(spacing: 7) {
                                    Image(systemName: message.role == .user ? "person.crop.circle" : "sparkle")
                                        .foregroundStyle(message.role == .user ? Color.secondary : Color.accentColor)
                                    Text(message.role == .user ? "你" : "GPT")
                                        .font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
                                    if message.role == .assistant && !message.completed && !store.isSending {
                                        Text("未完成").font(.caption).foregroundStyle(.orange)
                                    }
                                    Spacer()
                                    if !message.text.isEmpty {
                                        Button {
                                            NSPasteboard.general.clearContents()
                                            NSPasteboard.general.setString(message.text, forType: .string)
                                        } label: {
                                            Image(systemName: "doc.on.doc").font(.system(size: 12))
                                                .frame(width: 24, height: 24)
                                        }
                                        .buttonStyle(.borderless).foregroundStyle(.secondary)
                                        .help("复制").accessibilityLabel("复制")
                                    }
                                }
                                if message.text.isEmpty && store.isSending {
                                    ProgressView().controlSize(.small)
                                } else {
                                    Text(.init(Self.readableAnswer(message.text))).font(.system(size: 14))
                                        .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).lineSpacing(5)
                                }
                                if let sources = store.chatSources[message.id], !sources.isEmpty {
                                    DisclosureGroup("检索网页（\(sources.count)）") {
                                        VStack(alignment: .leading, spacing: 6) {
                                            ForEach(sources) { source in
                                                Link(destination: source.url) {
                                                    Label(source.title, systemImage: "link")
                                                        .font(.system(size: 11)).lineLimit(2)
                                                }
                                            }
                                        }.padding(.top, 5)
                                    }.font(.system(size: 11))
                                }
                            }
                            .padding(11).glassCard(radius: 13, tinted: message.role == .user)
                            .id(message.id)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }.padding(.horizontal, 12).padding(.vertical, 8)
                }
                .onChange(of: store.ledger.messages.last?.text) { _ in proxy.scrollTo("bottom", anchor: .bottom) }
                .onChange(of: store.ledger.messages.count) { _ in proxy.scrollTo("bottom", anchor: .bottom) }
            }
            if let error = store.errorMessage {
                Label(error, systemImage: "exclamationmark.circle")
                    .font(.caption).foregroundStyle(.red).textSelection(.enabled)
                    .padding(.horizontal, 12).padding(.vertical, 5).frame(maxWidth: .infinity, alignment: .leading)
            }
            composer.padding(.horizontal, 12).padding(.bottom, 12).padding(.top, 6)
        }
        .frame(minWidth: 380, minHeight: 400)
        .background { GlassBackdrop() }
        .environment(\.openURL, OpenURLAction { url in
            ["http", "https"].contains(url.scheme?.lowercased() ?? "")
                && url.host != nil && url.user == nil && url.password == nil ? .systemAction : .discarded
        })
        .onAppear { inputFocused = true; store.refreshPermission() }
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            if store.ledger.excerpt == nil && !store.permissionGranted {
                Button("辅助功能授权…") { store.requestPermission() }.buttonStyle(GlassButtonStyle())
            }
        }
        .frame(maxWidth: .infinity).padding(.vertical, 12)
    }

    static func readableAnswer(_ text: String) -> String {
        // Internal search IDs have no public URL. Show verified source links
        // separately rather than presenting private citation markers as links.
        text.replacingOccurrences(of: #"cite[^]*"#, with: "", options: .regularExpression)
    }

    private var composer: some View {
        VStack(spacing: 7) {
            if store.ledger.excerpt != nil || store.isSending {
                HStack(spacing: 8) {
                    if store.ledger.excerpt != nil {
                        Button { store.send("请解释这段原文的主要意思、关键术语和证据边界。") } label: {
                            Label("解释这段", systemImage: "sparkle")
                        }
                        .buttonStyle(GlassButtonStyle())
                        .disabled(store.isSending || store.isTesting)
                    }
                    Spacer(minLength: 4)
                    if store.isSending {
                        Button("停止") { store.stop() }.buttonStyle(GlassButtonStyle(destructive: true))
                    }
                }
            }
            ZStack(alignment: .topLeading) {
                if store.question.isEmpty {
                    Text("提问或搜索网页…").font(.system(size: 14)).foregroundStyle(.tertiary)
                        .padding(.horizontal, 5).padding(.top, 8).allowsHitTesting(false)
                }
                QuestionEditor(text: $store.question, isFocused: $inputFocused) { store.send() }
                    .frame(height: 46)
            }
            HStack {
                Spacer()
                Button { store.send() } label: {
                    HStack(spacing: 9) {
                        Text("发送")
                        Text("↩").font(.system(size: 10, weight: .medium))
                    }
                }
                .accessibilityLabel("发送  ↩").help("Enter 发送，Shift＋Enter 换行")
                .buttonStyle(GlassButtonStyle(prominent: true))
                .disabled(store.isSending || store.isTesting || store.question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(10).glassCard(radius: 14)
    }
}

// Let the input method interpret keys before deciding whether Return submits.
// In particular, confirming a Chinese candidate must never submit a question.
final class QuestionTextView: NSTextView {
    var onSubmit: (() -> Void)?
    var onFocusChanged: ((Bool) -> Void)?
    private var beganWithMarkedText = false
    private var keyModifiers: NSEvent.ModifierFlags?

    override func becomeFirstResponder() -> Bool {
        let accepted = super.becomeFirstResponder()
        if accepted { onFocusChanged?(true) }
        return accepted
    }

    override func resignFirstResponder() -> Bool {
        let accepted = super.resignFirstResponder()
        if accepted { onFocusChanged?(false) }
        return accepted
    }

    override func keyDown(with event: NSEvent) {
        beganWithMarkedText = hasMarkedText()
        keyModifiers = event.modifierFlags.intersection([.shift, .control, .option, .command])
        defer { beganWithMarkedText = false; keyModifiers = nil }
        super.keyDown(with: event)
    }

    override func doCommand(by selector: Selector) {
        let modifiers = keyModifiers ?? NSApp.currentEvent?.modifierFlags
            .intersection([.shift, .control, .option, .command]) ?? []
        if selector == #selector(insertNewline(_:)), modifiers.isEmpty,
           !beganWithMarkedText, !hasMarkedText() {
            onSubmit?()
            return
        }
        super.doCommand(by: selector)
    }
}

private struct QuestionEditor: NSViewRepresentable {
    @Binding var text: String
    @Binding var isFocused: Bool
    var onSubmit: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let editor = QuestionTextView()
        editor.isRichText = false
        editor.allowsUndo = true
        editor.drawsBackground = false
        editor.font = .systemFont(ofSize: 14)
        editor.textColor = .labelColor
        editor.textContainerInset = NSSize(width: 0, height: 8)
        editor.isVerticallyResizable = true
        editor.isHorizontallyResizable = false
        editor.autoresizingMask = [.width]
        editor.textContainer?.widthTracksTextView = true
        editor.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        editor.setAccessibilityLabel("问题")
        editor.delegate = context.coordinator
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.documentView = editor
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let editor = scroll.documentView as? QuestionTextView else { return }
        editor.onSubmit = onSubmit
        editor.onFocusChanged = { context.coordinator.parent.isFocused = $0 }
        if editor.string != text {
            if editor.hasMarkedText() { editor.unmarkText() }
            editor.string = text
        }
        if isFocused {
            DispatchQueue.main.async { [weak editor] in
                guard let editor, let window = editor.window, window.isKeyWindow,
                      context.coordinator.parent.isFocused, window.firstResponder !== editor else { return }
                window.makeFirstResponder(editor)
            }
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: QuestionEditor
        init(_ parent: QuestionEditor) { self.parent = parent }
        func textDidChange(_ notification: Notification) {
            guard let editor = notification.object as? NSTextView else { return }
            parent.text = editor.string
        }
    }
}

struct AutomaticTranslationView: View {
    @ObservedObject var store: ReaderStore
    var ask: () -> Void
    var openDocument: () -> Void = {}
    @State private var draft = ""
    @State private var excerptExpanded = false
    @AppStorage("compactTranslationColor") private var translationColorName = "blue"
    @Environment(\.colorScheme) private var translationColorScheme

    private var resultColor: Color {
        switch translationColorName {
        case "blue": return translationColorScheme == .dark
            ? Color(red: 0.51, green: 0.71, blue: 1) : Color(red: 0, green: 0.37, blue: 0.74)
        case "green": return translationColorScheme == .dark
            ? Color(red: 0.46, green: 0.84, blue: 0.67) : Color(red: 0.03, green: 0.44, blue: 0.28)
        case "purple": return translationColorScheme == .dark
            ? Color(red: 0.82, green: 0.65, blue: 1) : Color(red: 0.45, green: 0.25, blue: 0.68)
        default: return .primary
        }
    }
    private var sourceMenu: some View {
        Picker("Direction", selection: Binding(get: { store.translationSourceLanguage },
            set: { store.setTranslationSource($0) })) {
            Text("EN→中").tag("en")
            Text("中→EN").tag("zh-Hans")
            Text("Auto").tag("auto")
        }.pickerStyle(.segmented).controlSize(.mini).labelsHidden().frame(width: 154)
            .accessibilityLabel("Translation direction").help("Translation direction")
    }
    private var colorSwatches: some View {
        HStack(spacing: 2) {
            ForEach(["blue", "green", "purple", "theme"], id: \.self) { name in
                Button { translationColorName = name } label: {
                    ZStack {
                        if name == "theme" {
                            Image(systemName: "circle.lefthalf.filled").font(.system(size: 9))
                        } else {
                            Circle().fill(name == "blue" ? Color.blue : name == "green" ? .green : .purple)
                                .frame(width: 8, height: 8)
                        }
                        Circle().stroke(Color.primary.opacity(translationColorName == name ? 0.85 : 0), lineWidth: 1)
                            .frame(width: 12, height: 12)
                    }.frame(width: 16, height: 24)
                }.buttonStyle(.borderless).accessibilityLabel(name.capitalized)
                    .accessibilityValue(translationColorName == name ? "Selected" : "")
                    .help(name.capitalized)
            }
        }.accessibilityLabel("Translation color")
    }
    private func result(_ text: String, markdown: Bool = false) -> some View {
        Group {
            if markdown { Text(.init(text)) } else { Text(text) }
        }.font(.system(size: 14)).foregroundStyle(resultColor)
            .textSelection(.enabled).lineSpacing(4)
    }
    private func failure(_ text: String, retry: @escaping () -> Void) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(text).font(.system(size: 12)).foregroundStyle(.secondary)
                .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            Button(action: retry) { Image(systemName: "arrow.clockwise").frame(width: 24, height: 24) }
                .buttonStyle(.borderless).accessibilityLabel("Retry").help("Retry")
        }
    }

    private func wordCard(_ entry: WordEntry) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(entry.headword).font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(.primary)
                if let phonetic = entry.phonetic, !phonetic.isEmpty {
                    Text(phonetic).font(.system(size: 11)).foregroundStyle(.secondary)
                }
            }.textSelection(.enabled)
            let local = store.automaticText.trimmingCharacters(in: .whitespacesAndNewlines)
            let definitions = entry.senses.flatMap(\.meanings).joined(separator: "；")
            if !local.isEmpty, !definitions.contains(local) {
                result(local)
            }
            ForEach(Array(entry.senses.enumerated()), id: \.offset) { _, sense in
                HStack(alignment: .firstTextBaseline, spacing: 9) {
                    Text(sense.partOfSpeech).font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary).frame(minWidth: 24, alignment: .leading)
                    result(sense.meanings.joined(separator: "；"))
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }.accessibilityElement(children: .contain).accessibilityLabel("Word meanings")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 4) {
                sourceMenu
                colorSwatches
                Spacer().frame(height: 24).background { WindowDragRegion() }
                if store.automaticExcerpt != nil {
                    Button { excerptExpanded.toggle() } label: {
                        Image(systemName: "text.alignleft").frame(width: 24, height: 24)
                    }.buttonStyle(.borderless).accessibilityLabel("Original").help("Original")
                }
                Button(action: openDocument) {
                    Image(systemName: "rectangle.split.2x1").frame(width: 24, height: 24)
                }.buttonStyle(.borderless).accessibilityLabel("Page translation").help("Page translation")
            }
            if let excerpt = store.automaticExcerpt {
                if excerptExpanded {
                    ScrollView(.vertical, showsIndicators: true) {
                        Text(excerpt.text).font(.system(size: 11)).foregroundStyle(.secondary)
                            .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                    }.frame(maxHeight: 60)
                }
                Picker("Mode", selection: Binding(get: { store.refinementMode?.rawValue ?? "local" }, set: { value in
                    if let mode = PassageRefinementMode(rawValue: value) { store.refineSelection(mode) }
                    else { store.showNativeTranslation() }
                })) {
                    Text("Local").tag("local")
                    Text("GPT").tag(PassageRefinementMode.translation.rawValue)
                    Text("Explain").tag(PassageRefinementMode.explanation.rawValue)
                }.pickerStyle(.segmented).labelsHidden().controlSize(.small)
                    .accessibilityLabel("Local translation, GPT translation, or explanation")
                    .help("GPT sends only the selected passage")
                ScrollView(.vertical, showsIndicators: true) {
                    VStack(alignment: .leading, spacing: 8) {
                        if let mode = store.refinementMode {
                            if !store.refinementText.isEmpty { result(store.refinementText, markdown: true) }
                            else if store.refinementBusy, !store.automaticText.isEmpty { result(store.automaticText) }
                            if let error = store.refinementFailure {
                                failure(error) { store.refineSelection(mode) }
                            }
                        } else if let entry = store.wordEntry {
                            wordCard(entry)
                        } else if let error = store.automaticFailure {
                            failure(error) { store.retryTranslation() }
                        } else if !store.automaticText.isEmpty {
                            result(store.automaticText)
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(10)
                }.scrollIndicators(.visible).frame(maxWidth: .infinity, maxHeight: .infinity)
                    .glassCard(radius: 12)
            } else {
                ZStack(alignment: .topLeading) {
                    if draft.isEmpty {
                        Text("Paste text").font(.system(size: 13)).foregroundStyle(.tertiary)
                            .padding(.horizontal, 5).padding(.top, 8).allowsHitTesting(false)
                    }
                    TextEditor(text: $draft).font(.system(size: 13)).scrollContentBackground(.hidden)
                        .accessibilityLabel("Text to translate")
                }.padding(5).frame(maxWidth: .infinity, maxHeight: .infinity).glassCard(radius: 12)
            }
            HStack(spacing: 8) {
                if store.refinementBusy {
                    Button { store.cancelRefinement() } label: { Image(systemName: "stop.fill").frame(width: 24, height: 24) }
                        .buttonStyle(.borderless).accessibilityLabel("Stop").help("Stop")
                } else if store.automaticBusy, store.wordEntry == nil {
                    Button { store.cancelAutomatic() } label: { Image(systemName: "stop.fill").frame(width: 24, height: 24) }
                        .buttonStyle(.borderless).accessibilityLabel("Stop").help("Stop")
                } else if store.automaticExcerpt != nil {
                    Button {
                        if let mode = store.refinementMode { store.refineSelection(mode) }
                        else { store.retryTranslation() }
                    } label: { Image(systemName: "arrow.clockwise").frame(width: 24, height: 24) }
                    .buttonStyle(.borderless).accessibilityLabel("Retry").help("Retry")
                }
                if store.automaticExcerpt == nil {
                    if !store.permissionGranted {
                        Button { store.requestPermission() } label: { Image(systemName: "hand.raised").frame(width: 24, height: 24) }
                            .buttonStyle(.borderless).accessibilityLabel("Accessibility permission").help("Accessibility permission")
                    }
                    Button { store.translateSelection(SelectedExcerpt(text: draft)) } label: {
                        Image(systemName: "arrow.right").frame(width: 24, height: 24)
                    }.buttonStyle(GlassButtonStyle(prominent: true)).accessibilityLabel("Translate").help("Translate")
                        .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                Spacer(minLength: 0).frame(height: 30).background { WindowDragRegion() }
                Button("Ask GPT", action: ask).buttonStyle(GlassButtonStyle(prominent: store.automaticExcerpt != nil))
                    .accessibilityLabel("Ask ChatGPT ⌥X").help("Ask ChatGPT ⌥X")
                    .disabled(store.automaticExcerpt == nil)
            }
        }.padding(12).frame(minWidth: 320, minHeight: 200).background { GlassBackdrop() }
        .overlay {
            ZStack {
                VStack { WindowDragRegion().frame(height: 10); Spacer(); WindowDragRegion().frame(height: 10) }
                HStack { WindowDragRegion().frame(width: 10); Spacer(); WindowDragRegion().frame(width: 10) }
            }
        }
    }
}

struct SettingsView: View {
    @ObservedObject var store: ReaderStore
    @State private var keyCode: UInt32 = 2
    @State private var control = false
    @State private var option = true
    @State private var command = false
    @State private var shift = false
    private let keys: [(String, UInt32)] = [("A",0),("B",11),("C",8),("D",2),("E",14),("F",3),("G",5),("H",4),("I",34),("J",38),("K",40),("L",37),("M",46),("N",45),("O",31),("P",35),("Q",12),("R",15),("S",1),("T",17),("U",32),("V",9),("W",13),("X",7),("Y",16),("Z",6)]
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 12) {
                    Label("翻译与提问", systemImage: "bubble.left.and.bubble.right")
                        .font(.system(size: 14, weight: .semibold))
                    Spacer(minLength: 12)
                    Toggle("选中自动翻译", isOn: Binding(get: { store.automaticEnabled }, set: { store.setAutomatic($0) }))
                        .toggleStyle(.switch).controlSize(.small).font(.system(size: 12))
                        .help("划词后自动弹出译文；关闭后仍可使用翻译快捷键")
                }
                Divider()
                VStack(spacing: 11) {
                    settingsField("Codex 路径", text: $store.settings.cliPath)
                    settingsField("提问模型", text: $store.settings.model)
                    HStack(spacing: 12) {
                        settingsLabel("推理强度")
                        Picker("提问推理强度", selection: $store.settings.reasoningEffort) {
                            ForEach(["low", "medium", "high"], id: \.self) { Text($0).tag($0) }
                        }.labelsHidden().frame(width: 130)
                        Spacer(minLength: 0)
                    }
                }
                Divider()
                VStack(alignment: .leading, spacing: 7) {
                    HStack(spacing: 12) {
                        settingsLabel("翻译配置文件")
                        TextField("留空使用 Codex", text: $store.settings.translationConfigurationPath)
                            .textFieldStyle(.roundedBorder)
                        Button("选择…") { chooseTranslationConfiguration() }.buttonStyle(GlassButtonStyle())
                    }
                    HStack(alignment: .top, spacing: 8) {
                        Text("可选 DeepSeek API / Claude Code；保存后重启应用生效。实验性接入，尚未实测。")
                            .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        Link("配置说明", destination: URL(string: "https://github.com/Woyekun-cell/Ask-for-GPT/blob/main/docs/TRANSLATION-BACKENDS.zh-CN.md")!)
                            .font(.caption).fixedSize()
                    }.padding(.leading, 96)
                }
                Divider()
                VStack(alignment: .leading, spacing: 9) {
                    HStack(spacing: 12) {
                        settingsLabel("翻译快捷键")
                        HStack(spacing: 12) {
                            Toggle("⌃", isOn: $control).accessibilityLabel("Control")
                            Toggle("⌥", isOn: $option).accessibilityLabel("Option")
                            Toggle("⌘", isOn: $command).accessibilityLabel("Command")
                            Toggle("⇧", isOn: $shift).accessibilityLabel("Shift")
                            Picker("翻译快捷键按键", selection: $keyCode) {
                                ForEach(keys, id: \.1) { Text($0.0).tag($0.1) }
                            }.labelsHidden().frame(width: 60)
                        }
                        Spacer(minLength: 0)
                    }
                    Text("⌥X 提问 · " + (store.hotKey == .readingSpec ? "页面翻译使用插件按钮" : "⌥⇧X 页面翻译"))
                        .font(.caption).foregroundStyle(.secondary).padding(.leading, 96)
                }
                VStack(alignment: .leading, spacing: 9) {
                    HStack(spacing: 8) {
                        Button("保存设置") { saveSettings() }
                            .buttonStyle(GlassButtonStyle(prominent: true)).disabled(store.isSending || store.isTesting)
                        Button("测试 Codex") { store.testConnection() }.buttonStyle(GlassButtonStyle())
                            .disabled(store.isSending || store.isTesting || store.settings != store.appliedSettings)
                        Spacer(minLength: 0)
                        Text(store.modelVerified ? "Codex 已验证" : "Codex 待验证").font(.caption).foregroundStyle(.secondary)
                    }
                    if store.settings != store.appliedSettings {
                        Text("保存后生效").font(.caption).foregroundStyle(.secondary)
                    }
                    if !store.permissionGranted {
                        HStack(spacing: 8) {
                            Label("划词需辅助功能授权", systemImage: "hand.raised")
                                .font(.caption).foregroundStyle(.secondary)
                            Spacer(minLength: 0)
                            Button("授权") { store.requestPermission() }
                            Button("刷新") { store.refreshPermission() }
                        }.buttonStyle(GlassButtonStyle())
                    }
                    if let error = store.errorMessage {
                        Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled)
                    }
                }
            }.padding(18).frame(maxWidth: .infinity, alignment: .leading).glassCard()
                .padding(16)
        }.frame(width: 544, height: 472).background { GlassBackdrop() }
        .onAppear {
            store.refreshPermission()
            keyCode = store.hotKey.keyCode
            control = store.hotKey.modifiers & UInt32(controlKey) != 0
            option = store.hotKey.modifiers & UInt32(optionKey) != 0
            command = store.hotKey.modifiers & UInt32(cmdKey) != 0
            shift = store.hotKey.modifiers & UInt32(shiftKey) != 0
        }
    }
    private func chooseTranslationConfiguration() {
        let panel = NSOpenPanel()
        panel.title = "选择翻译配置 JSON 文件"
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let url = panel.url {
            store.settings.translationConfigurationPath = url.path
        }
    }
    private func saveSettings() {
        guard control || option || command else { store.errorMessage = "快捷键至少选择 ⌃、⌥ 或 ⌘ 中的一项。"; return }
        let modifiers = (control ? UInt32(controlKey) : 0) | (option ? UInt32(optionKey) : 0) | (command ? UInt32(cmdKey) : 0) | (shift ? UInt32(shiftKey) : 0)
        store.hotKey = HotKeySpec(keyCode: keyCode, modifiers: modifiers)
        store.saveSettings()
    }
    private func settingsLabel(_ title: String) -> some View {
        Text(title).font(.system(size: 12)).frame(width: 84, alignment: .leading)
    }
    private func settingsField(_ title: String, text: Binding<String>) -> some View {
        HStack(spacing: 12) {
            settingsLabel(title)
            TextField(title, text: text).textFieldStyle(.roundedBorder)
        }
    }
}
