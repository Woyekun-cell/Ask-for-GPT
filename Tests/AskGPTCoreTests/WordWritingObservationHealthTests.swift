import Testing
@testable import AskGPTCore

struct WordWritingObservationHealthTests {
    private func register(_ health: inout WordWritingObservationHealth) -> WordWritingObservationHealth.Session {
        let session = health.begin()
        for notification in WordWritingObservationHealth.Notification.allCases {
            health.record(notification, succeeded: true, for: session)
        }
        health.finish(session)
        return session
    }

    @Test func completeRegistrationAllowsStableProofWithoutPeriodicExpiry() throws {
        var health = WordWritingObservationHealth()
        _ = register(&health)
        let proof = try #require(health.token)
        // Repeated idle reads do not manufacture an invalidation or require AX.
        for _ in 0..<100 { #expect(health.permitsReuse(proof)) }
    }
    @Test func everyRequiredNotificationMustReallyRegister() {
        for missing in WordWritingObservationHealth.requiredNotifications {
            var health = WordWritingObservationHealth()
            let session = health.begin()
            for notification in WordWritingObservationHealth.Notification.allCases where notification != missing {
                health.record(notification, succeeded: true, for: session)
            }
            health.finish(session)
            #expect(health.token == nil)
        }
    }
    @Test func notificationDuringFreshCaptureRejectsItsOldProof() throws {
        var health = WordWritingObservationHealth()
        let session = register(&health)
        let beforeCapture = try #require(health.token)
        let observed = health.observe(session)
        #expect(observed)
        #expect(!health.permitsReuse(beforeCapture))
        let freshCapture = try #require(health.token)
        #expect(health.permitsReuse(freshCapture))
        #expect(beforeCapture != freshCapture)
    }
    @Test func stoppedOrReboundObserverCannotReviveOrInvalidateNewSession() throws {
        var health = WordWritingObservationHealth()
        let oldSession = register(&health)
        let oldProof = try #require(health.token)
        health.stop()
        #expect(!health.permitsReuse(oldProof))
        _ = register(&health)
        let current = try #require(health.token)
        let staleObserved = health.observe(oldSession)
        #expect(!staleObserved)
        health.record(.focusedWindow, succeeded: false, for: oldSession)
        health.finish(oldSession)
        #expect(health.permitsReuse(current))
        #expect(!health.permitsReuse(oldProof))
    }
    @Test func failedRegistrationCannotBeHealedByDuplicateSuccess() {
        var health = WordWritingObservationHealth()
        let session = health.begin()
        health.record(.focusedWindow, succeeded: false, for: session)
        for notification in WordWritingObservationHealth.Notification.allCases {
            health.record(notification, succeeded: true, for: session)
        }
        health.finish(session)
        #expect(health.token == nil)
    }
    @Test func registrationIsNotHealthyUntilItFinishes() throws {
        var health = WordWritingObservationHealth()
        let session = health.begin()
        for notification in WordWritingObservationHealth.requiredNotifications {
            health.record(notification, succeeded: true, for: session)
        }
        health.record(.focusedElement, succeeded: false, for: session)
        health.record(.windowCreated, succeeded: false, for: session)
        #expect(health.token == nil)
        health.finish(session)
        #expect(health.token != nil)
    }
}
