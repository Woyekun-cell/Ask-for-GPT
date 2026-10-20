import AppKit
import ApplicationServices
import AskGPTCore
import os

/// Coordinates the native surface with the document-bound Office.js service.
/// A surface click cannot itself edit Word: every acceptance binds a fresh
/// document/handle and passes through the host's single-use range validation.
@MainActor final class NativeWordWritingController {
    private let broker: NativeWritingDocumentBroker
    private let service: WritingService
    private let surface = WordWritingOverlaySurface()
    private let windowObserver = WordWritingAXObserver()
    private let capture = SelectionCapture()
    private let diagnostic = Logger(subsystem: "local.askgpt.reader", category: "writing-inline")
    private var lastGateDiagnostic: String?
    private var lastGeometryDiagnostic: String?
    private var lastPostProbeDiagnostic: PostProbeGate?
    private var polling: Task<Void, Never>?
    private var action: Task<Void, Never>?
    private var activeAttempt: NativeWritingApplyAttempt?
    private var generation = UUID()
    private var geometryVersion = UUID()
    private var windowStamp: WordWritingWindowStamp?
    private struct WindowIdentityBinding {
        let leaseID: String
        let documentSessionID: String
        let processID: pid_t
        let window: AXUIElement
        func matches(_ stamp: WordWritingWindowStamp) -> Bool {
            processID == stamp.processID && CFEqual(window, stamp.window)
        }
    }
    // This identity outlives visual geometry/focus loss. A still-live mailbox
    // must not bind itself to a different Word window during a focus race.
    private var windowIdentityBinding: WindowIdentityBinding?
    private var selectionNeedsRefresh = true
    private struct MarkProof {
        let leaseID: String
        let epoch: Int
        let candidates: [String: IssueEnvelope]
        let window: WordWritingWindowStamp
        let observation: WordWritingObservationHealth.Token?
    }
    private var markProof: MarkProof?
    private var document: NativeWritingActiveDocument?
    private var prepared: [NativeWritingDocumentIssue] = []
    private var selection: CapturedSelection?
    private var anchor: CGRect?
    private var content: WordWritingPopoverContent?
    private var modelRequest: String?
    private var palette = WordWritingMarkPalette.preferred()
    private var running = false
    private var note: String?
    private var message: String?
    private var busy = false
    private var applying = false
    private var needsReopen = false
    private(set) var status = "在 Word 加载项中开启文内检查。"

    init(broker: NativeWritingDocumentBroker, service: WritingService) {
        self.broker = broker; self.service = service
        windowObserver.onChange = { [weak self] change, affected in
            guard let self else { return }
            switch change {
            case .focusedWindow, .mainWindow, .windowCreated, .miniaturized, .deminiaturized:
                self.invalidate()
            case .destroyed:
                // Destroyed AX objects permit local identity comparison only.
                // An unrelated Word child must not dismiss the user's review.
                if let affected, let stamp = self.windowStamp, CFEqual(affected, stamp.window) { self.invalidate() }
                else { self.dirtyGeometry(); self.surface.hideSelectionButton() }
            default:
                self.dirtyGeometry(); self.surface.hideSelectionButton()
            }
        }
        surface.onMark = { [weak self] handle, point in self?.openIssue(handle: handle, at: point) }
        surface.onHover = { [weak self] handle, point in self?.openIssue(handle: handle, at: point, hovering: true) ?? false }
        surface.canHover = { [weak self] in
            guard let self, self.running, !self.busy else { return false }
            if case .polish = self.content { return false }
            return true
        }
        surface.onPolish = { [weak self] in self?.polishSelection() }
        surface.onInvalidate = { [weak self] in self?.invalidate() }
        surface.onDismiss = { [weak self] in self?.dismissReview() }
        surface.onGeometryDirty = { [weak self] in self?.dirtyGeometry() }
    }

    func start() {
        guard polling == nil else { return }
        running = true
        polling = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, self.running else { return }
                await self.refresh()
                try? await Task.sleep(nanoseconds: 450_000_000)
            }
        }
    }

    private func refresh() async {
        guard let foreground = NSWorkspace.shared.frontmostApplication, foreground.bundleIdentifier == "com.microsoft.Word" else {
            logGate(.frontNotWord)
            if document != nil || content != nil { invalidate() }
            document = nil; windowStamp = nil; windowObserver.stop(); return
        }
        windowObserver.startIfNeeded(processID: foreground.processIdentifier)
        guard let current = await broker.activeDocument() else {
            logGate(.noActiveDocument)
            if (busy && applying && activeAttempt?.awaitingReceipt == true && activeAttempt?.permitsReceipt(document: nil) == true)
                || isReadOnlyFeedback {
                // Expiry can itself create the pending command's unknown result.
                // Keep waiting/showing that receipt; no old marker or handle survives.
                _ = suspendReviewGeometry()
                return
            }
            invalidate(); document = nil
            status = "在 Word 加载项中开启文内检查。"; return
        }
        if isReadOnlyFeedback {
            if let old = document, old.leaseID == current.leaseID, old.documentSessionID == current.documentSessionID,
               activeAttempt?.permitsReceipt(document: current) != false {
                document = current
                _ = suspendReviewGeometry()
                return
            }
            invalidate()
        }
        if let old = document, old.leaseID == current.leaseID, old.state.epoch == current.state.epoch {
            syncSpellingEligibility(current)
        }
        // A complete, unchanged observer generation keeps this already-proved
        // visual stable. Broker/front checks still run; no periodic AX read is
        // needed until a real event, source or candidate change dirties it.
        if current.state.status == .ready, current.state.visibility == .hidden,
           let proof = markProof, let observation = proof.observation,
           proof.leaseID == current.leaseID, proof.epoch == current.state.epoch,
           windowIdentityBinding?.leaseID == current.leaseID, windowIdentityBinding?.documentSessionID == current.documentSessionID,
           windowIdentityBinding?.matches(proof.window) == true,
           proof.window.processID == foreground.processIdentifier,
           windowStamp?.matches(proof.window) == true, surface.marksVisible,
           proof.candidates == self.candidateMap(for: current),
           windowObserver.permitsReuse(observation, window: proof.window),
           NSWorkspace.shared.frontmostApplication?.processIdentifier == proof.window.processID {
            document = current
            return
        }
        guard let currentWindow = WordWritingWindowStamp.capture() else {
            logGate(.windowStampUnavailable)
            if let old = document, old.leaseID == current.leaseID,
               current.state.visibility == .hidden, [.ready, .preview].contains(current.state.status),
               (busy && applying) || (old.state.epoch == current.state.epoch && surface.popoverVisible),
               NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.microsoft.Word" {
                // A transient AX read failure invalidates document pixels, not
                // this unchanged live lease's open review or an edit's ACK wait.
                dirtyGeometry(); surface.hideSelectionButton()
                // Retain the last stamp only to detect a later real window change.
            } else { invalidate(); windowStamp = nil }
            return
        }
        if let binding = windowIdentityBinding, binding.leaseID == current.leaseID,
           binding.documentSessionID == current.documentSessionID, !binding.matches(currentWindow) {
            logGate(.windowChanged); invalidate(); windowStamp = nil
            return
        }
        if let previous = windowStamp, !previous.matches(currentWindow) { logGate(.windowChanged); invalidate() }
        windowStamp = currentWindow
        windowIdentityBinding = .init(leaseID: current.leaseID, documentSessionID: current.documentSessionID,
                                      processID: currentWindow.processID, window: currentWindow.window)
        // Only this live lease's pending command may temporarily publish preview.
        if busy, let old = document, old.leaseID == current.leaseID,
           applying || (old.state.epoch == current.state.epoch && current.state.status == .preview && current.state.visibility == .hidden) {
            return
        }
        if let old = document, old.leaseID != current.leaseID || old.state.epoch != current.state.epoch {
            invalidate()
        }
        document = current
        guard current.state.status == .ready, current.state.visibility == .hidden else {
            logGate(.notReady, state: current.state.status, visibility: current.state.visibility)
            invalidate()
            status = current.state.status == .paused ? "文内检查已暂停。" : "Word 当前使用侧栏检查。"
            return
        }
        status = "文内检查已启用。"
        if busy { return }
        if selectionNeedsRefresh, !surface.popoverVisible {
            selectionNeedsRefresh = false
            let next = capture.capture()
            if let next, next.excerpt.sourceBundleID == "com.microsoft.Word", let rect = next.anchor {
                selection = next; surface.showSelectionButton(anchor: rect)
            } else { selection = nil; surface.hideSelectionButton() }
        }
        let candidates = visualCandidates(for: current)
        logGate(.readyHidden, state: .ready, visibility: .hidden, issueCount: candidates.count,
                scope: current.state.scope?.scope, pageCount: current.state.scope?.pageIndices.count ?? 0)
        guard candidates.count <= WordInlineGeometry.maximumCandidateCount else {
            dirtyGeometry(); status = "当前建议过多，请缩小检查范围。"; return
        }
        guard !candidates.isEmpty else { dirtyGeometry(); return }
        // Eligibility finishing changes the card's controls, not its geometry.
        // The complete envelope still binds paragraph bytes, context and range.
        let candidateMap = Dictionary(uniqueKeysWithValues: candidates.map { ($0.handle, $0.envelope) })
        // Never stitch rectangles from different AX traversals or generations.
        // Stable marks have no timer. Only dirty geometry needs another traversal.
        let version = generation, geometry = geometryVersion
        let observation = windowObserver.token
        markProof = nil
        surface.hideMarksForProbe()
        let items = candidates.map { item in WordInlineBatchItem(id: item.handle, input: Self.input(item.envelope, anchorOnly: false)) }
        let result = await WordInlineGeometry.probeBatch(items)
        logGeometry(result)
        let fresh = await broker.activeDocument()
        guard running else { rejectProbe(.stopped); return }
        guard !Task.isCancelled else { rejectProbe(.cancelled); return }
        guard version == generation else { rejectProbe(.generationChanged); return }
        guard geometry == geometryVersion else { rejectProbe(.geometryDirty); return }
        guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.microsoft.Word" else { rejectProbe(.frontNotWord); return }
        guard let fresh else { rejectProbe(.noActiveDocument); return }
        guard fresh.leaseID == current.leaseID else { rejectProbe(.leaseChanged); return }
        guard fresh.state.epoch == current.state.epoch else { rejectProbe(.epochChanged); return }
        guard fresh.state.status == .ready else { rejectProbe(.notReady); return }
        guard fresh.state.visibility == .hidden else { rejectProbe(.notHidden); return }
        guard let finalWindow = WordWritingWindowStamp.capture() else { rejectProbe(.windowStampUnavailable); return }
        guard currentWindow.matches(finalWindow) else { rejectProbe(.windowChanged); return }
        if let observation, !windowObserver.permitsReuse(observation, window: finalWindow) { rejectProbe(.geometryDirty); return }
        guard result.status == "geometry_verified" else { dirtyGeometry(); return }
        lastPostProbeDiagnostic = nil
        surface.paint(result.markers.map { .init(id: $0.id, bounds: Self.rect($0.bounds)) }, palette: palette)
        diagnostic.info("paint_panel_count=\(self.surface.visibleMarkerCount, privacy: .public)")
        if surface.marksVisible { markProof = .init(leaseID: current.leaseID, epoch: current.state.epoch, candidates: candidateMap, window: finalWindow, observation: observation) }
    }

    private func visualCandidates(for current: NativeWritingActiveDocument) -> [NativeWritingDocumentIssue] {
        var seen = Set<String>()
        return (prepared + current.state.issues).filter { item in
            let envelope = item.envelope
            return seen.insert("\(envelope.snapshot.blockID)|\(envelope.snapshot.snapshotHash)|\(envelope.issue.range.start)|\(envelope.issue.range.length)").inserted
        }
    }
    private func candidateMap(for current: NativeWritingActiveDocument) -> [String: IssueEnvelope] {
        Dictionary(uniqueKeysWithValues: visualCandidates(for: current).map { ($0.handle, $0.envelope) })
    }

    private var isReadOnlyFeedback: Bool {
        needsReopen && prepared.isEmpty && message != nil && content != nil && surface.popoverVisible
    }
    /// Receipt-only geometry suspension never keeps document pixels or grants a
    /// write. A confirmed window/frame change still dismisses the old review.
    @discardableResult private func suspendReviewGeometry() -> Bool {
        if let current = WordWritingWindowStamp.capture() {
            if let previous = windowStamp, !previous.matches(current) {
                logGate(.windowChanged); invalidate(); windowStamp = current; return false
            }
            windowStamp = current
        }
        dirtyGeometry(); surface.hideSelectionButton()
        return true
    }

    private func syncSpellingEligibility(_ current: NativeWritingActiveDocument) {
        guard !busy, case .spelling = content, prepared.count == 1, let old = prepared.first,
              let latest = current.state.issues.first(where: { $0.handle == old.handle }),
              latest.envelope == old.envelope, latest != old else { return }
        prepared = [latest]
        note = previewNote(latest)
        render()
    }
    private func previewNote(_ item: NativeWritingDocumentIssue) -> String? {
        item.canApply || item.reason == "preparing" ? nil : NativeWritingApplyAttempt.message(for: item.reason)
    }

    private enum DiagnosticGate: String {
        case frontNotWord = "front_not_word", noActiveDocument = "no_active_document"
        case notReady = "not_ready", readyHidden = "ready_hidden"
        case windowStampUnavailable = "window_stamp_unavailable", windowChanged = "window_changed"
    }
    private enum PostProbeGate: String {
        case stopped, cancelled
        case generationChanged = "generation_changed", geometryDirty = "geometry_dirty"
        case frontNotWord = "front_not_word", noActiveDocument = "no_active_document"
        case leaseChanged = "lease_changed", epochChanged = "epoch_changed"
        case notReady = "not_ready", notHidden = "not_hidden"
        case windowStampUnavailable = "window_stamp_unavailable", windowChanged = "window_changed"
    }
    private func rejectProbe(_ gate: PostProbeGate) {
        if lastPostProbeDiagnostic != gate {
            lastPostProbeDiagnostic = gate
            diagnostic.info("post_probe_guard=\(gate.rawValue, privacy: .public)")
        }
        dirtyGeometry()
    }
    private static let geometryDiagnosticCodes: Set<String> = [
        "invalid_batch", "viewport_changed", "invalid_input", "invalid_utf16_range", "original_mismatch",
        "text_too_long", "ambiguous_visible_match", "paragraph_not_found", "invalid_bounds",
        "offscreen_or_clipped", "multiline_or_unverifiable", "untrusted", "secure_input", "foreground_not_word",
        "document_window_unavailable", "secure_or_unknown_focused_role", "selection_unverifiable", "window_offscreen",
        "deadline_exceeded", "visible_text_or_tree_unverifiable", "traversal_limit", "paragraph_roundtrip_failed",
        "original_roundtrip_failed", "bounds_unavailable", "single_line_unverifiable", "paragraph_changed",
        "geometry_changed", "batch_unverifiable", "range_state_unverifiable", "window_or_deadline_changed",
        "visible_text_roundtrip_failed", "cancelled", "probe_failed", "no_verified_candidates"
    ]
    // Deduplication holds only fixed enums and counts, never document identifiers
    // or source. Gate and geometry streams are independent to avoid poll spam.
    private func logGate(_ gate: DiagnosticGate, state: NativeWritingDocumentState.Status? = nil,
                         visibility: NativeWritingDocumentState.Visibility? = nil, issueCount: Int = 0,
                         scope: WritingScope? = nil, pageCount: Int = 0) {
        let stateCode = state?.rawValue ?? "none", visibilityCode = visibility?.rawValue ?? "none", scopeCode = scope?.rawValue ?? "none"
        let key = "\(gate.rawValue)|\(stateCode)|\(visibilityCode)|\(issueCount)|\(scopeCode)|\(pageCount)"
        guard key != lastGateDiagnostic else { return }
        lastGateDiagnostic = key; lastGeometryDiagnostic = nil
        diagnostic.info("gate=\(gate.rawValue, privacy: .public) status=\(stateCode, privacy: .public) visibility=\(visibilityCode, privacy: .public) issue_count=\(issueCount, privacy: .public) scope=\(scopeCode, privacy: .public) page_count=\(pageCount, privacy: .public)")
    }
    private func logGeometry(_ result: WordInlineBatchResult) {
        let stateCode = ["geometry_verified", "rejected"].contains(result.status) ? result.status : "other"
        let errorCode = result.errorCode.map { Self.geometryDiagnosticCodes.contains($0) ? $0 : "other" } ?? "none"
        let count = result.markers.count, key = "\(stateCode)|\(errorCode)|\(count)"
        guard key != lastGeometryDiagnostic else { return }
        lastGeometryDiagnostic = key
        diagnostic.info("geometry_status=\(stateCode, privacy: .public) code=\(errorCode, privacy: .public) marker_count=\(count, privacy: .public)")
    }

    @discardableResult private func openIssue(handle: String, at point: CGPoint, hovering: Bool = false) -> Bool {
        guard !busy, let document,
              let item = (document.state.issues + prepared).first(where: { $0.handle == handle }) else { return false }
        if hovering {
            if case .polish = content { return false }
            if surface.popoverVisible, prepared.contains(where: { $0.handle == handle }) { return true }
        }
        let proof = WordInlineGeometry.probe(Self.input(item.envelope, anchorOnly: false))
        guard proof.status == "geometry_verified", let bounds = proof.bounds else { return false }
        let rect = Self.rect(bounds)
        let hitBounds = rect.insetBy(dx: -3, dy: -4)
        guard hitBounds.contains(point) else { return false }
        // AX may briefly block the main actor. The original dwell point alone
        // cannot open a card after the pointer has already left the fresh word.
        if hovering {
            guard let current = WordWritingOverlaySurface.currentPointerAX(), hitBounds.contains(current),
                  !surface.pointerIsOverPopover(current) else { return false }
        }
        anchor = rect
        if prepared.contains(where: { $0.handle == handle }), case .polish = content { render(); return surface.popoverVisible }
        cancelAction()
        prepared = [item]; content = .spelling(item.envelope.issue); message = nil; needsReopen = false
        note = previewNote(item); busy = false; render()
        guard surface.popoverVisible else { return false }
        surface.markPresented(handle)
        if hovering { diagnostic.info("interaction=hover outcome=opened") }
        return true
    }

    private func polishSelection() {
        guard !busy, let document, let selected = capture.capture(),
              selected.excerpt.sourceBundleID == "com.microsoft.Word", let rect = selected.anchor else { return }
        guard selected.excerpt.text.utf16.count <= 4000 else { return }
        cancelAction(); surface.cancelPendingHover(); surface.hideSelectionButton()
        selection = selected; anchor = rect; prepared = []; message = nil; note = nil; needsReopen = false; busy = true
        // Immediate visual feedback only. This AX preview is never sent to the
        // model or used for a write; the command below obtains the host snapshot.
        let preview = WritingSnapshot(requestID: UUID().uuidString, documentSessionID: document.documentSessionID,
            blockID: "selection-preview", revision: "0", rawText: selected.excerpt.text, scope: .selection)
        content = (try? WritingPolishComparison(snapshot: preview, issues: [])).map(WordWritingPopoverContent.polish)
        render()
        let version = generation
        action = Task { [weak self] in
            guard let self else { return }
            do {
                let command = try await broker.enqueueCaptureSelection(leaseID: document.leaseID)
                let captured = try await wait(command); try requireCompleted(captured)
                guard version == generation, !Task.isCancelled,
                      let scope = captured.scope, scope.snapshots.count == 1,
                      let snapshot = scope.snapshots.first, snapshot.scope == .selection,
                      let end = snapshot.targetRange.end else { throw NativeWritingUIError.stale }
                let target = (snapshot.rawText as NSString).substring(with: NSRange(location: snapshot.targetRange.start, length: end - snapshot.targetRange.start))
                guard target.trimmingCharacters(in: .whitespacesAndNewlines).utf8.elementsEqual(selected.excerpt.text.utf8),
                      let stillSelected = capture.capture(), stillSelected.excerpt.text.utf8.elementsEqual(selected.excerpt.text.utf8),
                      NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.microsoft.Word" else { throw NativeWritingUIError.stale }
                content = .polish(try WritingPolishComparison(snapshot: snapshot, issues: [])); render()
                modelRequest = snapshot.requestID
                let result = try await service.check(snapshot, mode: .polish, profile: document.state.profile ?? .init())
                if modelRequest == snapshot.requestID { modelRequest = nil }
                let fresh = await broker.activeDocument()
                guard version == generation, !Task.isCancelled, result.status == .completed,
                      let fresh, fresh.leaseID == document.leaseID,
                      fresh.state.epoch == document.state.epoch else { throw NativeWritingUIError.stale }
                let comparison = try WritingPolishComparison(snapshot: snapshot, issues: result.issues)
                content = .polish(comparison)
                if !comparison.changes.isEmpty {
                    let prepare = try await broker.enqueuePrepareSuggestions(leaseID: document.leaseID,
                        snapshotRequestID: snapshot.requestID, issues: comparison.changes)
                    let ready = try await wait(prepare); try requireCompleted(ready)
                    guard version == generation, !Task.isCancelled else { return }
                    prepared = ready.prepared ?? []
                    note = prepared.contains(where: { !$0.canApply }) ? "部分修改只能预览。" : nil
                }
                busy = false; render()
            } catch { fail(error, version: version) }
        }
    }

    private func apply(issueID: String? = nil) {
        guard !busy else { return }
        guard let document else { showApplyFailure(nil, message: NativeWritingApplyAttempt.message(for: "noActiveDocument")); return }
        let candidate: NativeWritingDocumentIssue?
        if let issueID { candidate = prepared.first(where: { $0.envelope.issue.id == issueID }) }
        else { candidate = prepared.first }
        guard let item = candidate else {
            diagnostic.info("action=apply guard=candidateUnavailable command_enqueued=false")
            showApplyFailure(nil, message: NativeWritingApplyAttempt.message(for: "candidateUnavailable")); return
        }
        let attempt = NativeWritingApplyAttempt(document: document, candidate: item)
        activeAttempt = attempt
        let started = ProcessInfo.processInfo.systemUptime
        surface.cancelPendingHover(); busy = true; applying = true; message = nil; render()
        let version = generation
        action = Task { [weak self] in
            guard let self else { return }
            var outcome = "cancelled"
            defer {
                let elapsed = ((ProcessInfo.processInfo.systemUptime - started) * 1000).rounded()
                diagnostic.info("action=apply outcome=\(outcome, privacy: .public) command_enqueued=\(attempt.commandEnqueued, privacy: .public) elapsed_ms=\(elapsed, privacy: .public)")
            }
            do {
                let fresh = await broker.activeDocument()
                let currentItem = await broker.issue(leaseID: document.leaseID, handle: item.handle)
                if let gate = attempt.guardCode(document: fresh, candidate: currentItem,
                    foregroundAllowed: NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.microsoft.Word",
                    generationMatches: version == generation, cancelled: Task.isCancelled) {
                    diagnostic.info("action=apply guard=\(gate.rawValue, privacy: .public) command_enqueued=false")
                    throw gate
                }
                // An explicit acceptance is document/handle-bound. Word's one
                // authoritative fresh range verification owns permission to edit;
                // AX layout remains a hover/painting concern.
                let command = try await broker.enqueueApply(leaseID: document.leaseID, handle: item.handle)
                attempt.markEnqueued(); outcome = "unknown"
                let completion = try await wait(command)
                guard version == generation, !Task.isCancelled else { return }
                let result = attempt.finish(status: completion.status, code: completion.code)
                outcome = result.outcome.rawValue
                if result.outcome == .completed {
                    prepared = []; content = nil; busy = false; applying = false; needsReopen = false; activeAttempt = nil
                    surface.dismissPopover(); dirtyGeometry()
                } else {
                    let current = await broker.activeDocument()
                    guard version == generation, !Task.isCancelled else { return }
                    guard attempt.permitsReceipt(document: current) else { invalidate(); return }
                    if let current { self.document = current }
                    showApplyFailure(result.retryCandidate, message: result.message)
                }
            } catch {
                let fresh = await broker.activeDocument()
                let currentItem = await broker.issue(leaseID: document.leaseID, handle: item.handle)
                let code = (error as? NativeWritingApplyAttempt.GuardCode)?.rawValue
                    ?? (error as? NativeWritingDocumentBrokerError).map { String(describing: $0) } ?? "temporary_unavailable"
                let result = attempt.fail(code: code, cancelled: Task.isCancelled || error is CancellationError,
                                          document: fresh, candidate: currentItem)
                outcome = result.outcome.rawValue
                guard version == generation, !Task.isCancelled else { return }
                if attempt.commandEnqueued {
                    guard attempt.permitsReceipt(document: fresh) else { invalidate(); return }
                    if let fresh { self.document = fresh }
                }
                showApplyFailure(result.retryCandidate, message: result.message)
            }
        }
    }

    private func showApplyFailure(_ candidate: NativeWritingDocumentIssue?, message: String?) {
        prepared = candidate.map { [$0] } ?? []
        busy = false; applying = false; needsReopen = candidate == nil
        if activeAttempt?.commandEnqueued != true { activeAttempt = nil }
        note = candidate.flatMap(previewNote)
        self.message = message
        if candidate == nil { dirtyGeometry(); surface.hideSelectionButton() }
        render()
    }

    private func ignore(addTerm: Bool = false) {
        guard !busy, let document, let item = prepared.first else { surface.dismissPopover(); return }
        surface.cancelPendingHover(); busy = true
        action = Task { [weak self] in
            guard let self else { return }
            let version = generation
            do {
                let command = try await (addTerm ? broker.enqueueAddTerm(leaseID: document.leaseID, handle: item.handle) : broker.enqueueIgnore(leaseID: document.leaseID, handle: item.handle))
                let completion = try await wait(command); try requireCompleted(completion)
                guard version == generation, !Task.isCancelled else { return }
                prepared = []; content = nil; busy = false; surface.dismissPopover(); dirtyGeometry()
            } catch { fail(error, version: version) }
        }
    }

    private func render() {
        guard let content, let anchor else { return }
        let view = WordWritingPopoverView(content: content, canApply: prepared.first?.canApply == true,
            isLoading: busy, errorMessage: message, applicationNote: note, palette: palette,
            onPalette: { [weak self] value in
                guard let self else { return }; palette = value
                UserDefaults.standard.set(value.rawValue, forKey: "WritingMarkPalette"); surface.recolorMarks(palette: value); render()
            }, onApply: { [weak self] in self?.apply() }, onIgnore: { [weak self] in
                guard let self else { return }
                if let content = self.content, case .polish = content { self.dismissReview() }
                else { self.ignore() }
            },
            onAddTerm: { [weak self] in self?.ignore(addTerm: true) }, onStop: { [weak self] in self?.dismissReview() },
            onApplyIssue: { [weak self] in self?.apply(issueID: $0) },
            applicableIssueIDs: Set(prepared.filter(\.canApply).map { $0.envelope.issue.id }),
            activityLabel: applying ? "替换中…" : nil, canStop: !applying,
            isPreparing: prepared.first.map { !$0.canApply && $0.reason == "preparing" } == true,
            needsReopen: needsReopen, onReopen: { [weak self] in
                self?.dismissReview(); self?.dirtyGeometry()
            })
        let identity: String
        switch content {
        case .spelling(let issue): identity = "spelling|\(issue.id)"
        case .polish(let comparison): identity = "polish|\(comparison.documentSessionID)|\(comparison.blockID)|\(comparison.snapshotHash)|\(comparison.targetRange.start)|\(comparison.targetRange.length)"
        }
        surface.present(view, anchor: anchor, identity: identity)
    }

    private func verifiedAnchor(_ envelope: IssueEnvelope) -> CGRect? {
        let result = WordInlineGeometry.probe(Self.input(envelope, anchorOnly: true))
        guard result.status == "geometry_verified", let bounds = result.bounds else { return nil }
        return Self.rect(bounds)
    }
    private static func input(_ envelope: IssueEnvelope, anchorOnly: Bool) -> WordInlineProbeInput {
        let issue = envelope.issue
        let original = anchorOnly ? issue.original.first.map(String.init) ?? "" : issue.original
        return .init(expectedParagraph: envelope.snapshot.rawText, issueStartUTF16: issue.range.start,
                     issueLengthUTF16: original.utf16.count, original: original)
    }
    private static func rect(_ value: WordInlineProbeRect) -> CGRect { .init(x: value.x, y: value.y, width: value.width, height: value.height) }
    private func wait(_ command: String) async throws -> NativeWritingCommandCompletion {
        for _ in 0..<160 {
            try Task.checkCancellation()
            if let result = await broker.takeResult(commandID: command) { return result }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        throw NativeWritingUIError.unknown
    }
    private func requireCompleted(_ completion: NativeWritingCommandCompletion) throws {
        guard completion.status == .completed else {
            if completion.status == .indeterminate { throw NativeWritingUIError.unknown }
            if ["crossParagraphSelection", "selectionParagraphMark", "emptySelection", "scope_too_large", "invalid_scope"].contains(completion.code) {
                throw NativeWritingUIError.selection
            }
            throw NativeWritingUIError.stale
        }
    }
    private func fail(_ error: Error, version: UUID) {
        guard version == generation, !Task.isCancelled else { return }
        busy = false; applying = false; prepared = []
        needsReopen = true
        message = (error as? NativeWritingUIError)?.localizedDescription
            ?? (error as? WritingServiceError)?.localizedDescription
            ?? "本次检查未完成，请重试。"
        render()
    }
    private func cancelAction() {
        action?.cancel(); action = nil
        if let id = modelRequest { Task { await service.cancel(requestID: id) } }; modelRequest = nil
    }
    private func dirtyGeometry() {
        geometryVersion = UUID(); markProof = nil; selectionNeedsRefresh = true
        surface.clearMarks()
    }
    private func dismissReview() {
        generation = UUID(); cancelAction(); activeAttempt = nil; prepared = []; selection = nil; content = nil; anchor = nil; busy = false; applying = false; needsReopen = false
        surface.hideSelectionButton(); surface.dismissPopover()
    }
    private func invalidate() {
        dirtyGeometry(); dismissReview(); surface.resetHover()
    }
    func shutdown() {
        running = false; polling?.cancel(); polling = nil; invalidate(); windowObserver.stop(); windowIdentityBinding = nil; surface.stop()
    }
}

private enum NativeWritingUIError: LocalizedError {
    case stale, unknown, selection
    var errorDescription: String? {
        switch self {
        case .stale: return "原文或文档状态已改变，请重新检查。"
        case .unknown: return "Word 未确认修改结果。请先查看原文；本次不会自动重试。"
        case .selection: return "请选择一个段落内的句子，不要包含段落末尾标记。"
        }
    }
}
