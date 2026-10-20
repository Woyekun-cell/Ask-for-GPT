import AppKit
import ApplicationServices
import SwiftUI
import AskGPTCore
import os

struct WordWritingOverlayMark {
    let id: String
    /// AX global coordinates: primary display top left.
    let bounds: CGRect
}

/// Only a foreground window identity and frame; never its title or document text.
struct WordWritingWindowStamp {
    let processID: pid_t
    let window: AXUIElement
    let frame: CGRect
    private enum FailurePhase: String {
        case trust, front, position, size, deadline
        case focusedWindow = "focused_window", valueType = "value_type", finalFront = "final_front"
    }
    private struct FailureKey: Equatable {
        let phase: FailurePhase
        let axError: Int?
    }
    @MainActor private static var lastFailure: FailureKey?
    @MainActor private static let diagnostic = Logger(subsystem: "local.askgpt.reader", category: "writing-inline")

    @MainActor private static func record(success: Bool, phase: FailurePhase, axError: Int?, elapsed: Double) {
        let milliseconds = min(10_000, max(0, elapsed)).rounded()
        if success {
            guard lastFailure != nil else { return }
            lastFailure = nil
            diagnostic.info("window_stamp_event=recovered elapsed_ms=\(milliseconds, privacy: .public)")
        } else {
            let key = FailureKey(phase: phase, axError: axError)
            guard key != lastFailure else { return }
            lastFailure = key
            let code = axError.map(String.init) ?? "none"
            diagnostic.info("window_stamp_event=failed phase=\(phase.rawValue, privacy: .public) ax_error=\(code, privacy: .public) elapsed_ms=\(milliseconds, privacy: .public)")
        }
    }

    func matches(_ other: Self) -> Bool {
        hasSameWindow(as: other) && frame == other.frame
    }
    func hasSameWindow(as other: Self) -> Bool { processID == other.processID && CFEqual(window, other.window) }

    @MainActor static func capture() -> Self? {
        let started = ProcessInfo.processInfo.systemUptime
        var phase = FailurePhase.trust, axError: Int?, success = false
        defer { record(success: success, phase: phase, axError: axError, elapsed: (ProcessInfo.processInfo.systemUptime - started) * 1000) }
        guard AXIsProcessTrusted() else { return nil }
        phase = .front
        guard let application = NSWorkspace.shared.frontmostApplication,
              application.bundleIdentifier == "com.microsoft.Word" else { return nil }
        let processID = application.processIdentifier, deadline = ProcessInfo.processInfo.systemUptime + 0.15
        func value(_ element: AXUIElement, _ name: String, step: FailurePhase) -> CFTypeRef? {
            phase = step; axError = nil
            let remaining = deadline - ProcessInfo.processInfo.systemUptime
            guard remaining > 0 else { phase = .deadline; return nil }
            // Word intermittently failed the focused-window read at the 50 ms
            // boundary. Allow that read 100 ms within the same 150 ms deadline;
            // position and size retain their 50 ms per-call limits.
            let perCallLimit = step == .focusedWindow ? 0.10 : 0.05
            _ = AXUIElementSetMessagingTimeout(element, Float(min(remaining, perCallLimit)))
            var result: CFTypeRef?
            let status = AXUIElementCopyAttributeValue(element, name as CFString, &result)
            axError = status == .success ? nil : Int(status.rawValue)
            return status == .success ? result : nil
        }
        let source = AXUIElementCreateApplication(processID)
        guard let rawWindow = value(source, kAXFocusedWindowAttribute, step: .focusedWindow) else { return nil }
        guard CFGetTypeID(rawWindow) == AXUIElementGetTypeID() else { phase = .valueType; return nil }
        let window = unsafeBitCast(rawWindow, to: AXUIElement.self)
        guard let rawPosition = value(window, kAXPositionAttribute, step: .position) else { return nil }
        guard CFGetTypeID(rawPosition) == AXValueGetTypeID() else { phase = .valueType; return nil }
        guard let rawSize = value(window, kAXSizeAttribute, step: .size) else { return nil }
        guard CFGetTypeID(rawSize) == AXValueGetTypeID() else { phase = .valueType; return nil }
        let position = unsafeBitCast(rawPosition, to: AXValue.self), size = unsafeBitCast(rawSize, to: AXValue.self)
        var point = CGPoint.zero, dimensions = CGSize.zero
        phase = .valueType
        guard AXValueGetType(position) == .cgPoint, AXValueGetValue(position, .cgPoint, &point),
              AXValueGetType(size) == .cgSize, AXValueGetValue(size, .cgSize, &dimensions),
              point.x.isFinite, point.y.isFinite, dimensions.width.isFinite, dimensions.height.isFinite,
              dimensions.width > 0, dimensions.height > 0 else { return nil }
        phase = .deadline
        guard ProcessInfo.processInfo.systemUptime < deadline else { return nil }
        phase = .finalFront
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == processID else { return nil }
        success = true
        return .init(processID: processID, window: window, frame: CGRect(origin: point, size: dimensions))
    }
}

/// Paints outside the document. Mouse events continue to reach Word, and no
/// formatting, clipboard or keyboard input is used to produce a highlight.
@MainActor final class WordWritingOverlaySurface {
    var onMark: ((String, CGPoint) -> Void)?
    var onHover: ((String, CGPoint) -> Bool)?
    var canHover: (() -> Bool)?
    var onPolish: (() -> Void)?
    var onInvalidate: (() -> Void)?
    var onDismiss: (() -> Void)?
    var onGeometryDirty: (() -> Void)?
    private var markerWindows: [NSPanel] = []
    private var marks: [WordWritingOverlayMark] = []
    private var selectionButton: WordWritingFloatingPanel?
    private var popover: WordWritingFloatingPanel?
    private var monitors: [Any] = []
    private var observers: [(NotificationCenter, NSObjectProtocol)] = []
    private var menuTracking = 0
    private var popoverIdentity: String?
    private var popoverContentHeight: CGFloat?
    private let hover = WordWritingHoverDwell()
    private var hoverTask: Task<Void, Never>?
    private var hoverTicket: WordWritingHoverDwell.Ticket?
    private(set) var popoverVisible = false
    var marksVisible: Bool { !markerWindows.isEmpty && markerWindows.count == marks.count }
    var visibleMarkerCount: Int { markerWindows.filter(\.isVisible).count }

    init() {
        if let monitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseUp], handler: { [weak self] event in
            let point = event.cgEvent?.location
            MainActor.assumeIsolated { self?.mouseUp(at: point) }
        }) { monitors.append(monitor) }
        if let monitor = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved], handler: { [weak self] event in
            let point = event.cgEvent?.location
            MainActor.assumeIsolated { self?.updateHover(at: point, pointerMoved: true) }
        }) { monitors.append(monitor) }
        if let monitor = NSEvent.addGlobalMonitorForEvents(matching: [.scrollWheel, .leftMouseDragged, .rightMouseDown, .otherMouseDown], handler: { [weak self] _ in
            MainActor.assumeIsolated { self?.invalidate() }
        }) { monitors.append(monitor) }
        // Observe only that Word received a keyboard event. Never inspect,
        // retain or transmit key codes, characters or modifier contents.
        if let monitor = NSEvent.addGlobalMonitorForEvents(matching: [.keyDown], handler: { [weak self] _ in
            MainActor.assumeIsolated {
                guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.microsoft.Word" else { return }
                self?.hover.suppressUntilPointerMove()
                self?.invalidate()
            }
        }) { monitors.append(monitor) }
        if let monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown], handler: { [weak self] event in
            MainActor.assumeIsolated {
                guard let self else { return }
                if self.menuTracking > 0 { return }
                if event.window !== self.popover && event.window !== self.selectionButton { self.dismissPopover(notify: true) }
            }
            return event
        }) { monitors.append(monitor) }
        if let monitor = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved], handler: { [weak self] event in
            let point = event.cgEvent?.location
            MainActor.assumeIsolated { self?.updateHover(at: point, pointerMoved: true) }
            return event
        }) { monitors.append(monitor) }
        observe(NSWorkspace.shared.notificationCenter, NSWorkspace.didActivateApplicationNotification) { [weak self] in
            guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier != "com.microsoft.Word" else { return }
            self?.invalidate()
        }
        observe(NSWorkspace.shared.notificationCenter, NSWorkspace.screensDidSleepNotification) { [weak self] in self?.invalidate() }
        observe(.default, NSApplication.didChangeScreenParametersNotification) { [weak self] in self?.invalidate() }
        let began = NotificationCenter.default.addObserver(forName: NSMenu.didBeginTrackingNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { if self?.popoverVisible == true { self?.menuTracking += 1 } }
        }
        let ended = NotificationCenter.default.addObserver(forName: NSMenu.didEndTrackingNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.menuTracking = max(0, (self?.menuTracking ?? 0) - 1) }
        }
        observers += [(.default, began), (.default, ended)]
    }

    private func observe(_ center: NotificationCenter, _ name: Notification.Name, action: @escaping @MainActor () -> Void) {
        let token = center.addObserver(forName: name, object: nil, queue: .main) { _ in MainActor.assumeIsolated { action() } }
        observers.append((center, token))
    }

    func paint(_ newMarks: [WordWritingOverlayMark], palette: WordWritingMarkPalette) {
        let sameGeometry = marks.count == newMarks.count && zip(marks, newMarks).allSatisfy { $0.id == $1.id && $0.bounds == $1.bounds }
        if !sameGeometry { cancelPendingHover() }
        hideMarkerWindows()
        guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.microsoft.Word", newMarks.count <= 8 else { clearMarks(); return }
        marks = newMarks
        for mark in newMarks {
            guard let frame = Self.appKitRect(mark.bounds) else { continue }
            let panel = NSPanel(contentRect: frame,
                                styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            configure(panel)
            panel.ignoresMouseEvents = true
            panel.hasShadow = false
            panel.contentView = WordWritingHighlightView(palette: palette)
            panel.orderFrontRegardless()
            markerWindows.append(panel)
        }
        // A mark may appear under an already-stationary pointer. Repaint does
        // not restart a dwell or undo suppression after keyboard input/close.
        updateHover(at: Self.currentPointerAX())
    }

    func recolorMarks(palette: WordWritingMarkPalette) {
        for panel in markerWindows { panel.contentView = WordWritingHighlightView(palette: palette) }
    }

    func showSelectionButton(anchor: CGRect) {
        guard !popoverVisible, NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.microsoft.Word",
              let rect = Self.appKitRect(anchor) else { hideSelectionButton(); return }
        let panel = selectionButton ?? WordWritingFloatingPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        configure(panel)
        panel.contentView = NSHostingView(rootView:
            Button { [weak self] in self?.onPolish?() } label: {
                Label("润色", systemImage: "sparkles").font(.system(size: 13, weight: .medium)).padding(.horizontal, 12).padding(.vertical, 8)
            }.buttonStyle(.plain).background(.regularMaterial, in: Capsule())
        )
        panel.setFrame(Self.clamped(CGRect(x: rect.maxX - 76, y: rect.maxY + 7, width: 76, height: 34), near: rect), display: true)
        panel.orderFrontRegardless()
        selectionButton = panel
    }

    func hideSelectionButton() { selectionButton?.orderOut(nil) }

    func present(_ view: WordWritingPopoverView, anchor: CGRect, identity: String) {
        guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.microsoft.Word",
              let rect = Self.appKitRect(anchor) else { return }
        hideSelectionButton()
        cancelPendingHover()
        let updatesVisibleCard = popoverVisible && popoverIdentity == identity
        let panel = popover ?? WordWritingFloatingPanel(contentRect: .zero, styleMask: [.titled, .closable, .nonactivatingPanel, .resizable], backing: .buffered, defer: false)
        configure(panel)
        panel.title = ""
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isMovableByWindowBackground = true
        panel.onDismiss = { [weak self] in
            guard let self, self.popoverVisible else { return }
            self.cancelPendingHover(); self.hover.dismissPresented()
            self.popoverVisible = false; self.onDismiss?()
        }
        let content: NSHostingView<WordWritingPopoverView>
        if popoverIdentity == identity, let existing = panel.contentView as? NSHostingView<WordWritingPopoverView> {
            content = existing; content.rootView = view
        } else {
            content = NSHostingView(rootView: view); content.sizingOptions = [.minSize]
            panel.contentView = content; popoverIdentity = identity
        }
        // Measure at the actual content width. A spelling card has no scrolling
        // viewport, and a refusal must not be hidden below a fixed-height crop.
        let width = updatesVisibleCard ? panel.frame.width : 410
        let contentWidth = panel.contentRect(forFrameRect: CGRect(x: 0, y: 0, width: width, height: 300)).width
        content.setFrameSize(NSSize(width: contentWidth, height: max(1, content.frame.height)))
        content.layoutSubtreeIfNeeded()
        let fittedHeight = max(120, content.fittingSize.height)
        let titlebarHeight = panel.frame.height - panel.contentRect(forFrameRect: panel.frame).height
        panel.contentMinSize = NSSize(width: 320, height: fittedHeight)
        let height = fittedHeight + titlebarHeight
        if !updatesVisibleCard {
            panel.setFrame(Self.clamped(CGRect(x: rect.minX, y: rect.minY - height - 9, width: 410, height: height), near: rect), display: true)
        } else if let previousHeight = popoverContentHeight, abs(previousHeight - height) > 1 {
            // A qualification update must not move the card back to its word
            // while the pointer is approaching it. Keep the current top edge.
            let current = panel.frame
            panel.setFrame(Self.clamped(CGRect(x: current.minX, y: current.maxY - height,
                                               width: current.width, height: height), near: current), display: true)
        }
        popoverContentHeight = height
        panel.orderFrontRegardless()
        popover = panel
        popoverVisible = true
    }

    func dismissPopover(notify: Bool = false) {
        let wasVisible = popoverVisible
        popover?.orderOut(nil); popoverVisible = false; menuTracking = 0
        if wasVisible { cancelPendingHover(); hover.dismissPresented() }
        if notify && wasVisible { onDismiss?() }
    }
    func invalidate() {
        resetHover()
        clearMarks(); hideSelectionButton(); dismissPopover()
        onInvalidate?()
    }
    func hideMarksForProbe() {
        cancelPendingHover()
        hideMarkerWindows()
    }
    private func hideMarkerWindows() {
        markerWindows.forEach { $0.orderOut(nil) }; markerWindows.removeAll()
    }
    func clearMarks() {
        hideMarksForProbe(); marks.removeAll()
    }
    func resetHover() { cancelPendingHover(); hover.reset() }
    func cancelPendingHover() {
        hoverTask?.cancel(); hoverTask = nil; hoverTicket = nil; hover.cancelPending()
    }
    func markPresented(_ handle: String) { cancelPendingHover(); hover.presented(handle) }
    func stop() {
        invalidate()
        monitors.forEach(NSEvent.removeMonitor); monitors.removeAll()
        for (center, token) in observers { center.removeObserver(token) }; observers.removeAll()
        selectionButton?.close(); selectionButton = nil
        popover?.close(); popover = nil
        popoverIdentity = nil; popoverContentHeight = nil
    }

    private func mouseUp(at point: CGPoint?) {
        guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.microsoft.Word" else { invalidate(); return }
        let hit: String? = point.flatMap { point in
            guard point.x.isFinite, point.y.isFinite else { return nil }
            return marks.first(where: { $0.bounds.insetBy(dx: -3, dy: -4).contains(point) })?.id
        }
        _ = hover.observe(target: hit, now: ProcessInfo.processInfo.systemUptime, canActivate: false)
        cancelPendingHover()
        // A Word click can move its viewport. Dirty only geometry before the
        // controller proves the original click point; do not cancel the review.
        onGeometryDirty?()
        if popoverVisible && hit == nil { dismissPopover(notify: true) }
        if let hit, let point { onMark?(hit, point) }
    }

    /// Instantaneous AX-coordinate pointer only; no mouse history is retained.
    static func currentPointerAX() -> CGPoint? {
        guard let top = NSScreen.screens.first?.frame.maxY else { return nil }
        let point = NSEvent.mouseLocation
        guard point.x.isFinite, point.y.isFinite else { return nil }
        return .init(x: point.x, y: top - point.y)
    }
    private func hoverTarget(at point: CGPoint?) -> String? {
        guard let point, point.x.isFinite, point.y.isFinite,
              NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.microsoft.Word" else { return nil }
        if pointerIsOverPopover(point) { return nil }
        return marks.first(where: { $0.bounds.insetBy(dx: -3, dy: -4).contains(point) })?.id
    }
    func pointerIsOverPopover(_ point: CGPoint) -> Bool {
        guard popoverVisible, let popover, let top = NSScreen.screens.first?.frame.maxY else { return false }
        return popover.frame.contains(CGPoint(x: point.x, y: top - point.y))
    }
    private var hoverEnabled: Bool { marksVisible && menuTracking == 0 && canHover?() == true }
    private func updateHover(at point: CGPoint?, pointerMoved: Bool = false) {
        let target = hoverTarget(at: point)
        let ticket = hover.observe(target: target, now: ProcessInfo.processInfo.systemUptime,
                                   canActivate: hoverEnabled, pointerMoved: pointerMoved)
        scheduleHover(ticket)
    }
    private func scheduleHover(_ ticket: WordWritingHoverDwell.Ticket?) {
        guard ticket != hoverTicket else { return }
        hoverTask?.cancel(); hoverTask = nil; hoverTicket = ticket
        guard let ticket else { return }
        hoverTask = Task { [weak self] in
            let remaining = max(0, ticket.deadline - ProcessInfo.processInfo.systemUptime)
            do { try await Task.sleep(nanoseconds: UInt64(ceil(remaining * 1_000_000_000))) } catch { return }
            guard let self, !Task.isCancelled, self.hoverTicket == ticket else { return }
            let point = Self.currentPointerAX(), target = self.hoverTarget(at: point)
            guard let handle = self.hover.fire(ticket, now: ProcessInfo.processInfo.systemUptime,
                                               target: target, canActivate: self.hoverEnabled), let point else {
                self.hoverTicket = nil; self.hoverTask = nil; return
            }
            let displayed = self.onHover?(handle, point) == true
            let currentTarget = self.hoverTarget(at: Self.currentPointerAX())
            let next = self.hover.complete(ticket, displayed: displayed, now: ProcessInfo.processInfo.systemUptime,
                                           target: currentTarget, canActivate: self.hoverEnabled)
            self.hoverTicket = nil; self.hoverTask = nil
            self.scheduleHover(next)
        }
    }

    private func configure(_ panel: NSPanel) {
        panel.isReleasedWhenClosed = false
        panel.isOpaque = false; panel.backgroundColor = .clear
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.animationBehavior = .none
    }
    static func appKitRect(_ rect: CGRect) -> CGRect? {
        guard rect.minX.isFinite, rect.minY.isFinite, rect.width.isFinite, rect.height.isFinite,
              rect.width > 0, rect.height > 0, let top = NSScreen.screens.first?.frame.maxY else { return nil }
        let result = CGRect(x: rect.minX, y: top - rect.maxY, width: rect.width, height: rect.height)
        guard NSScreen.screens.contains(where: { $0.frame.contains(result) }) else { return nil }
        return result
    }
    private static func clamped(_ frame: CGRect, near anchor: CGRect) -> CGRect {
        guard let screen = NSScreen.screens.first(where: { $0.frame.intersects(anchor) }) else { return frame }
        let visible = screen.visibleFrame.insetBy(dx: 8, dy: 8)
        let width = min(frame.width, visible.width), height = min(frame.height, visible.height)
        return CGRect(x: min(max(frame.minX, visible.minX), visible.maxX - width),
                      y: min(max(frame.minY, visible.minY), visible.maxY - height), width: width, height: height)
    }
}

private final class WordWritingFloatingPanel: NSPanel {
    var onDismiss: (() -> Void)?
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
    override func cancelOperation(_ sender: Any?) { orderOut(sender); onDismiss?() }
    override func close() { orderOut(nil); onDismiss?() }
}

private final class WordWritingHighlightView: NSView {
    let palette: WordWritingMarkPalette
    init(palette: WordWritingMarkPalette) { self.palette = palette; super.init(frame: .zero) }
    required init?(coder: NSCoder) { nil }
    override var isOpaque: Bool { false }
    override func draw(_ dirtyRect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext, bounds.width > 0, bounds.height > 0,
              let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
                colors: palette.colors.map { NSColor($0).withAlphaComponent(palette.fillOpacity).cgColor } as CFArray, locations: [0, 1]) else { return }
        let radius = min(4, bounds.height * 0.2)
        let highlight = CGPath(roundedRect: bounds, cornerWidth: radius, cornerHeight: radius, transform: nil)
        context.saveGState(); context.addPath(highlight); context.clip()
        context.drawLinearGradient(gradient, start: CGPoint(x: bounds.minX, y: bounds.midY),
                                   end: CGPoint(x: bounds.maxX, y: bounds.midY), options: [])
        context.restoreGState()
    }
}
