import Testing
@testable import AskGPTCore

struct ConversationLedgerTests {
    @Test func testNewConversationDropsExcerptAndRejectsLateAnswer() {
        var ledger = ConversationLedger()
        _ = ledger.adopt(SelectedExcerpt(text: "OLD-742"))
        let old = ledger.beginAnswer(question: "Old question")
        ledger.startNewConversation()
        ledger.appendDelta("late old text", ticket: old)
        ledger.finish("late old answer", ticket: old)
        #expect(ledger.excerpt == nil)
        #expect(ledger.messages.isEmpty)
        let fresh = ledger.beginAnswer(question: "A general question without a selection")
        ledger.finish("A normal answer", ticket: fresh)
        #expect(ledger.messages.count == 2)
        #expect(ledger.messages.last?.completed == true)
        #expect(ledger.messages.last?.text == "A normal answer")
    }

    @Test func testSameExcerptPreservesConversationAndNewExcerptRejectsStaleDelta() {
        var ledger = ConversationLedger()
        let firstAdoption = ledger.adopt(SelectedExcerpt(text: "A paragraph", sourceBundleID: "browser"))
        #expect(firstAdoption)
        let first = ledger.beginAnswer(question: "What does it mean?")
        ledger.appendDelta("An explanation", ticket: first)
        ledger.finish("An explanation", ticket: first)
        let duplicate = ledger.adopt(SelectedExcerpt(text: " A paragraph\n", sourceBundleID: "browser"))
        #expect(!duplicate)
        #expect(ledger.messages.count == 2)
        let second = ledger.beginAnswer(question: "Explain more.")
        let changed = ledger.adopt(SelectedExcerpt(text: "A different paragraph", sourceBundleID: "browser"))
        #expect(changed)
        ledger.appendDelta("Old answer", ticket: second)
        ledger.finish("Old answer", ticket: second)
        #expect(ledger.messages.isEmpty)
    }

    @Test func testCompletionReplacesDraftAndCancellationIsNotSuccess() {
        var ledger = ConversationLedger()
        _ = ledger.adopt(SelectedExcerpt(text: "Original"))
        let ticket = ledger.beginAnswer(question: "Question")
        ledger.appendDelta("Partial", ticket: ticket)
        ledger.finish("Authoritative final", ticket: ticket)
        #expect(ledger.messages.last?.text == "Authoritative final")
        #expect(ledger.messages.last?.completed == true)
        let cancelled = ledger.beginAnswer(question: "Another")
        ledger.appendDelta("Interrupted text", ticket: cancelled)
        ledger.cancel(ticket: cancelled)
        ledger.appendDelta("must be ignored", ticket: cancelled)
        #expect(ledger.messages.last?.text == "Interrupted text")
        #expect(ledger.messages.last?.completed == false)
    }

    @Test func testSameTextFromDifferentSourceStartsNewConversation() {
        var ledger = ConversationLedger()
        _ = ledger.adopt(SelectedExcerpt(text: "Same", sourceBundleID: "one"))
        let ticket = ledger.beginAnswer(question: "Q")
        ledger.finish("A", ticket: ticket)
        let changedSource = ledger.adopt(SelectedExcerpt(text: "Same", sourceBundleID: "two"))
        #expect(changedSource)
        #expect(ledger.messages.isEmpty)
    }
}
