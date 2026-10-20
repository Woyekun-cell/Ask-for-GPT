import Carbon
import Testing
@testable import AskGPTCore

struct GlobalHotKeyTests {
    @MainActor @Test func instancesAcceptOnlyTheirOwnRegistrationID() {
        let translation = GlobalHotKey()
        let question = GlobalHotKey()
        #expect(translation.registrationID != question.registrationID)
        #expect(translation.acceptsEvent(signature: 0x41475054, id: translation.registrationID))
        #expect(question.acceptsEvent(signature: 0x41475054, id: question.registrationID))
        #expect(!translation.acceptsEvent(signature: 0x41475054, id: question.registrationID))
        #expect(!question.acceptsEvent(signature: 0x41475054, id: translation.registrationID))
    }

    @MainActor @Test func unrelatedSignatureCannotInvokeAHotKey() {
        let shortcut = GlobalHotKey()
        #expect(!shortcut.acceptsEvent(signature: 0, id: shortcut.registrationID))
        #expect(!shortcut.acceptsEvent(signature: 0x41475055, id: shortcut.registrationID))
    }

    @Test func translationAndQuestionUseDistinctOptionShortcuts() {
        #expect(HotKeySpec.defaultSpec == HotKeySpec(keyCode: 2, modifiers: UInt32(optionKey)))
        #expect(HotKeySpec.questionSpec == HotKeySpec(keyCode: 7, modifiers: UInt32(optionKey)))
        #expect(HotKeySpec.defaultSpec != .questionSpec)
        #expect(HotKeySpec.readingSpec == HotKeySpec(keyCode: 7, modifiers: UInt32(optionKey | shiftKey)))
        #expect(HotKeySpec.readingSpec != .defaultSpec && HotKeySpec.readingSpec != .questionSpec)
        #expect(HotKeySpec.readingSpec.displayName == "⌥⇧X")
    }
}
