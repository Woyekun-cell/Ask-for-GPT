import AppKit
import SwiftUI

/// Place only in noninteractive gaps. AppKit owns the drag, including Spaces
/// and screen-edge behavior; text, scroll views, and buttons keep their events.
struct WindowDragRegion: NSViewRepresentable {
    func makeNSView(context: Context) -> WindowDragRegionView {
        let view = WindowDragRegionView(frame: .zero)
        view.setAccessibilityElement(false)
        view.toolTip = "拖动移动翻译窗口"
        return view
    }
    func updateNSView(_ view: WindowDragRegionView, context: Context) {}
}

final class WindowDragRegionView: NSView {
    // The source UI smoke injects this instead of entering a real system drag.
    var beginDrag: ((NSWindow, NSEvent) -> Void)?
    override var mouseDownCanMoveWindow: Bool { true }
    override var acceptsFirstResponder: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        guard event.type == .leftMouseDown, let window, window.isMovable else { return }
        if let beginDrag { beginDrag(window, event) }
        else { window.performDrag(with: event) }
    }
}

// Decorative window-backed material; never intercepts controls or text selection.
private struct WindowFrost: NSViewRepresentable {
    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = .hudWindow
        view.blendingMode = .behindWindow
        view.state = .active
        view.setAccessibilityElement(false)
        return view
    }
    func updateNSView(_ view: NSVisualEffectView, context: Context) {}
}

struct GlassBackdrop: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    var body: some View {
        ZStack {
            if reduceTransparency {
                Color(nsColor: .windowBackgroundColor)
            } else {
                WindowFrost()
                LinearGradient(colors: [Color.accentColor.opacity(colorScheme == .dark ? 0.09 : 0.055), .clear],
                               startPoint: .topLeading, endPoint: .bottomTrailing)
            }
        }
        .ignoresSafeArea().allowsHitTesting(false).accessibilityHidden(true)
    }
}

private struct GlassCard: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    var radius: CGFloat
    var tinted: Bool
    func body(content: Content) -> some View {
        content
            .background { RoundedRectangle(cornerRadius: radius, style: .continuous).fill(surface) }
            .overlay {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(contrast == .increased ? Color.primary.opacity(0.48) :
                                  Color.white.opacity(colorScheme == .dark ? 0.13 : 0.65), lineWidth: 1)
                    .allowsHitTesting(false)
            }
            .shadow(color: .black.opacity(colorScheme == .dark ? 0.12 : 0.035), radius: 12, x: 0, y: 4)
    }
    private var surface: Color {
        if reduceTransparency || contrast == .increased { return Color(nsColor: .controlBackgroundColor) }
        if tinted { return Color.accentColor.opacity(colorScheme == .dark ? 0.18 : 0.085) }
        return colorScheme == .dark ? Color.white.opacity(0.065) : Color.white.opacity(0.48)
    }
}

extension View {
    func glassCard(radius: CGFloat = 18, tinted: Bool = false) -> some View {
        modifier(GlassCard(radius: radius, tinted: tinted))
    }
}

struct GlassButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast
    var prominent = false
    var destructive = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .semibold))
            .padding(.horizontal, 13).padding(.vertical, 8)
            .foregroundStyle(prominent && isEnabled ? Color.white : (destructive && isEnabled ? Color.red : Color.primary.opacity(isEnabled ? 0.86 : 0.35)))
            .background {
                RoundedRectangle(cornerRadius: 11, style: .continuous)
                    .fill(prominent && isEnabled ? Color.accentColor : Color.primary.opacity(configuration.isPressed ? 0.12 : 0.055))
            }
            .overlay {
                RoundedRectangle(cornerRadius: 11, style: .continuous)
                    .strokeBorder(Color.primary.opacity(contrast == .increased ? 0.5 : 0.06), lineWidth: 1)
            }
            .opacity(configuration.isPressed ? 0.8 : 1)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.98 : 1)
    }
}

struct SectionHeading: View {
    var title: String
    var symbol: String
    var body: some View {
        Label(title, systemImage: symbol).font(.system(size: 13, weight: .semibold)).foregroundStyle(.primary)
    }
}
