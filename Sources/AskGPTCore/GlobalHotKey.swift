import Foundation
import Carbon
import os

public struct HotKeySpec: Codable, Equatable {
    public var keyCode: UInt32
    public var modifiers: UInt32

    public init(keyCode: UInt32, modifiers: UInt32) {
        self.keyCode = keyCode
        self.modifiers = modifiers
    }

    public static let defaultSpec = HotKeySpec(keyCode: 2, modifiers: UInt32(optionKey))
    public static let questionSpec = HotKeySpec(keyCode: 7, modifiers: UInt32(optionKey))
    public static let readingSpec = HotKeySpec(keyCode: 7, modifiers: UInt32(optionKey | shiftKey))

    public var displayName: String {
        var result = ""
        if modifiers & UInt32(controlKey) != 0 { result += "⌃" }
        if modifiers & UInt32(optionKey) != 0 { result += "⌥" }
        if modifiers & UInt32(shiftKey) != 0 { result += "⇧" }
        if modifiers & UInt32(cmdKey) != 0 { result += "⌘" }
        let names: [UInt32: String] = [
            0: "A", 1: "S", 2: "D", 3: "F", 4: "H", 5: "G", 6: "Z", 7: "X", 8: "C", 9: "V",
            11: "B", 12: "Q", 13: "W", 14: "E", 15: "R", 16: "Y", 17: "T", 18: "1", 19: "2",
            20: "3", 21: "4", 22: "6", 23: "5", 25: "9", 26: "7", 28: "8", 29: "0",
            31: "O", 32: "U", 34: "I", 35: "P", 36: "↩", 37: "L", 38: "J", 40: "K", 45: "N",
            46: "M", 48: "Tab", 49: "Space", 51: "⌫", 53: "Esc", 123: "←", 124: "→", 125: "↓", 126: "↑"
        ]
        return result + (names[keyCode] ?? "[\(keyCode)]")
    }
}

public struct HotKeyRegistrationError: LocalizedError {
    public let status: OSStatus
    public var errorDescription: String? { "无法注册全局快捷键（\(status)），请更换快捷键。" }
}

@MainActor
public final class GlobalHotKey {
    private static var nextRegistrationID: UInt32 = 1
    nonisolated let registrationID: UInt32
    private var hotKey: EventHotKeyRef?
    private var eventHandler: EventHandlerRef?
    private var handler: (() -> Void)?
    private var registeredSpec: HotKeySpec?

    public init() {
        registrationID = Self.nextRegistrationID
        Self.nextRegistrationID &+= 1
        if Self.nextRegistrationID == 0 { Self.nextRegistrationID = 1 }
    }

    public func register(_ spec: HotKeySpec, handler: @escaping () -> Void) throws {
        guard spec.keyCode <= 127,
              spec.modifiers & ~UInt32(controlKey | optionKey | shiftKey | cmdKey) == 0,
              spec.modifiers != 0 else { throw HotKeyRegistrationError(status: OSStatus(paramErr)) }
        if registeredSpec == spec, hotKey != nil {
            self.handler = handler
            return
        }
        if eventHandler == nil {
            var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
            let context = Unmanaged.passUnretained(self).toOpaque()
            let installed = InstallEventHandler(GetApplicationEventTarget(), askGPTHotKeyCallback, 1, &eventType, context, &eventHandler)
            guard installed == noErr else { throw HotKeyRegistrationError(status: installed) }
        }
        let identifier = EventHotKeyID(signature: 0x41475054, id: registrationID)
        var replacement: EventHotKeyRef?
        let status = RegisterEventHotKey(spec.keyCode, spec.modifiers, identifier, GetApplicationEventTarget(), UInt32(kEventHotKeyExclusive), &replacement)
        guard status == noErr, let replacement else {
            Logger(subsystem: "local.askgpt.reader", category: "hotkey").error("Global hotkey registration failed; status=\(status, privacy: .public)")
            // A failed replacement must leave the existing shortcut and callback available.
            if hotKey == nil { unregister() }
            throw HotKeyRegistrationError(status: status)
        }
        if let hotKey { UnregisterEventHotKey(hotKey) }
        hotKey = replacement
        registeredSpec = spec
        self.handler = handler
        Logger(subsystem: "local.askgpt.reader", category: "hotkey").info("Global hotkey registered; shortcut=\(spec.displayName, privacy: .public)")
    }

    public func unregister() {
        if let hotKey { UnregisterEventHotKey(hotKey) }
        if let eventHandler { RemoveEventHandler(eventHandler) }
        hotKey = nil
        eventHandler = nil
        handler = nil
        registeredSpec = nil
    }

    nonisolated func acceptsEvent(signature: UInt32, id: UInt32) -> Bool {
        signature == 0x41475054 && id == registrationID
    }

    fileprivate func invoke() {
        Logger(subsystem: "local.askgpt.reader", category: "hotkey").info("Global hotkey invoked")
        handler?()
    }

    deinit {
        if let hotKey { UnregisterEventHotKey(hotKey) }
        if let eventHandler { RemoveEventHandler(eventHandler) }
    }
}

private func askGPTHotKeyCallback(_ nextHandler: EventHandlerCallRef?, _ event: EventRef?, _ context: UnsafeMutableRawPointer?) -> OSStatus {
    guard let context, let event else { return OSStatus(eventNotHandledErr) }
    var identifier = EventHotKeyID()
    let status = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &identifier)
    guard status == noErr else { return OSStatus(eventNotHandledErr) }
    let owner = Unmanaged<GlobalHotKey>.fromOpaque(context).takeUnretainedValue()
    guard owner.acceptsEvent(signature: identifier.signature, id: identifier.id) else { return OSStatus(eventNotHandledErr) }
    Task { @MainActor [weak owner] in owner?.invoke() }
    return noErr
}
