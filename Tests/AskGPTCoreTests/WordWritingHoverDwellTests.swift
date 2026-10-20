import Foundation
import Testing
@testable import AskGPTCore

struct WordWritingHoverDwellTests {
    @Test func stationaryPointerAndSameGeometryRepaintKeepOriginalDeadline() throws {
        let dwell = WordWritingHoverDwell()
        #expect(dwell.observe(target: nil, now: 0, canActivate: true) == nil)
        let ticket = try #require(dwell.observe(target: "A", now: 1, canActivate: true))
        #expect(dwell.observe(target: "A", now: 1.2, canActivate: true) == ticket)
        #expect(dwell.fire(ticket, now: 1.27, target: "A", canActivate: true) == nil)
        #expect(dwell.fire(ticket, now: 1.29, target: "A", canActivate: true) == "A")
        #expect(dwell.complete(ticket, displayed: true, now: 1.3, target: "A", canActivate: true) == nil)
        #expect(dwell.observe(target: "A", now: 4, canActivate: true) == nil)
    }
    @Test func quickSweepSwitchesDeadlineAndStaleTimerCannotConsumeNewTarget() throws {
        let dwell = WordWritingHoverDwell()
        let first = try #require(dwell.observe(target: "A", now: 0, canActivate: true))
        let second = try #require(dwell.observe(target: "B", now: 0.1, canActivate: true))
        #expect(dwell.fire(first, now: 0.4, target: "B", canActivate: true) == nil)
        #expect(dwell.fire(second, now: 0.37, target: "B", canActivate: true) == nil)
        #expect(dwell.fire(second, now: 0.39, target: "B", canActivate: true) == "B")
    }
    @Test func leaveOrDirtyCancelsPendingAndRequiresFreshDwell() throws {
        let dwell = WordWritingHoverDwell()
        let first = try #require(dwell.observe(target: "A", now: 0, canActivate: true))
        #expect(dwell.observe(target: nil, now: 0.2, canActivate: true) == nil)
        #expect(dwell.fire(first, now: 0.4, target: "A", canActivate: true) == nil)
        let second = try #require(dwell.observe(target: "A", now: 0.5, canActivate: true))
        dwell.cancelPending()
        #expect(dwell.fire(second, now: 1, target: "A", canActivate: true) == nil)
        #expect(dwell.observe(target: "A", now: 1, canActivate: true)?.deadline == 1.28)
    }
    @Test func openedSpellingCardCanSwitchWordsButMovementToCardDoesNotDismissIt() throws {
        let dwell = WordWritingHoverDwell()
        _ = dwell.observe(target: "A", now: 0, canActivate: true)
        dwell.presented("A")
        #expect(dwell.observe(target: "A", now: 1, canActivate: true) == nil)
        let second = try #require(dwell.observe(target: "B", now: 1.1, canActivate: true))
        // Entering the card cancels B's timer without closing A's card.
        #expect(dwell.observe(target: nil, now: 1.2, canActivate: false) == nil)
        #expect(dwell.fire(second, now: 1.5, target: "B", canActivate: true) == nil)
        #expect(dwell.observe(target: "A", now: 1.6, canActivate: true) == nil)
        let retry = try #require(dwell.observe(target: "B", now: 2, canActivate: true))
        #expect(dwell.fire(retry, now: 2.3, target: "B", canActivate: true) == "B")
    }
    @Test func closeBlocksStationaryRepaintUntilLeaveAndReenter() throws {
        let dwell = WordWritingHoverDwell()
        _ = dwell.observe(target: "A", now: 0, canActivate: true)
        dwell.presented("A"); dwell.dismissPresented()
        #expect(dwell.observe(target: "A", now: 2, canActivate: true) == nil)
        #expect(dwell.observe(target: "A", now: 3, canActivate: true, pointerMoved: true) == nil)
        _ = dwell.observe(target: nil, now: 3.1, canActivate: true, pointerMoved: true)
        #expect(dwell.observe(target: "A", now: 3.2, canActivate: true, pointerMoved: true) != nil)
    }
    @Test func keyboardSuppressionSurvivesResetAndRepaintUntilRealPointerMove() {
        let dwell = WordWritingHoverDwell()
        dwell.suppressUntilPointerMove(); dwell.reset()
        #expect(dwell.observe(target: "A", now: 2, canActivate: true) == nil)
        #expect(dwell.observe(target: "A", now: 3, canActivate: true) == nil)
        #expect(dwell.observe(target: "A", now: 3.1, canActivate: true, pointerMoved: true) != nil)
    }
    @Test func busyPolishAndFrontChangeCannotFireOrResurrectOldTicket() throws {
        let dwell = WordWritingHoverDwell()
        let ticket = try #require(dwell.observe(target: "A", now: 0, canActivate: true))
        #expect(dwell.observe(target: "A", now: 0.2, canActivate: false) == nil)
        #expect(dwell.fire(ticket, now: 0.4, target: "A", canActivate: true) == nil)
        let next = try #require(dwell.observe(target: "A", now: 0.5, canActivate: true))
        dwell.reset()
        #expect(dwell.fire(next, now: 1, target: "A", canActivate: true) == nil)
    }
    @Test func failedFreshProofRetriesOnceAndOnlySuccessfulDisplayLocksOpen() throws {
        let dwell = WordWritingHoverDwell()
        let first = try #require(dwell.observe(target: "A", now: 0, canActivate: true))
        #expect(dwell.fire(first, now: 0.3, target: "A", canActivate: true) == "A")
        let retry = try #require(dwell.complete(first, displayed: false, now: 0.3, target: "A", canActivate: true))
        #expect(abs(retry.deadline - 0.58) < 0.000001)
        #expect(dwell.fire(retry, now: 0.6, target: "A", canActivate: true) == "A")
        _ = dwell.complete(retry, displayed: true, now: 0.6, target: "A", canActivate: true)
        #expect(dwell.observe(target: "A", now: 2, canActivate: true) == nil)
    }
    @Test func failedProofBudgetStopsAtTwoAndLeaveResetsBudget() throws {
        let dwell = WordWritingHoverDwell()
        let first = try #require(dwell.observe(target: "A", now: 0, canActivate: true))
        _ = dwell.fire(first, now: 0.3, target: "A", canActivate: true)
        let second = try #require(dwell.complete(first, displayed: false, now: 0.3, target: "A", canActivate: true))
        _ = dwell.fire(second, now: 0.6, target: "A", canActivate: true)
        #expect(dwell.complete(second, displayed: false, now: 0.6, target: "A", canActivate: true) == nil)
        #expect(dwell.observe(target: "A", now: 4, canActivate: true) == nil)
        _ = dwell.observe(target: nil, now: 4.1, canActivate: true)
        #expect(dwell.observe(target: "A", now: 4.2, canActivate: true) != nil)
    }
    @Test func movingDuringProofOrBecomingBusyPreventsRetryAndOpening() throws {
        let dwell = WordWritingHoverDwell()
        let first = try #require(dwell.observe(target: "A", now: 0, canActivate: true))
        _ = dwell.fire(first, now: 0.3, target: "A", canActivate: true)
        #expect(dwell.complete(first, displayed: false, now: 0.3, target: nil, canActivate: true) == nil)
        let second = try #require(dwell.observe(target: "B", now: 1, canActivate: true))
        _ = dwell.fire(second, now: 1.3, target: "B", canActivate: true)
        #expect(dwell.complete(second, displayed: false, now: 1.3, target: "B", canActivate: false) == nil)
    }
}
