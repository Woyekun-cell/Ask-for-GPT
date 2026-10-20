import Foundation
import Testing
@testable import AskGPTCore

struct WritingSkillTests {
    @Test func realBundledSkillLoadsVersionedRulesAndDefaults() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let skill = try WritingSkill.load(from: root.appendingPathComponent("Resources/Writing/skill"))
        #expect(!skill.version.isEmpty)
        #expect(!skill.content.isEmpty)
        #expect(skill.hash.count == 64)
        #expect(skill.profile.spellingVariant == "en-US")
        #expect(skill.defaultTerms.contains("RNA-seq"))
    }

    @Test func missingRuleFileDoesNotFallbackToGenericPrompt() throws {
        try withSkillDirectory { directory in
            try FileManager.default.removeItem(at: directory.appendingPathComponent("SKILL.md"))
            #expect(throws: (any Error).self) { try WritingSkill.load(from: directory) }
        }
    }

    @Test func missingVersionIsRejected() throws {
        try withSkillDirectory { directory in
            try "---\nname: academic-writing\n---\nPreserve meaning.".write(to: directory.appendingPathComponent("SKILL.md"), atomically: true, encoding: .utf8)
            #expect(throws: WritingSkillError.missingVersion) { try WritingSkill.load(from: directory) }
        }
    }

    @Test func mismatchedResourceVersionsAreRejected() throws {
        try withSkillDirectory { directory in
            try #"{"version":"2.0.0","terms":[]}"#.write(to: directory.appendingPathComponent("terminology.json"), atomically: true, encoding: .utf8)
            #expect(throws: WritingSkillError.versionMismatch) { try WritingSkill.load(from: directory) }
        }
    }

    @Test func policyHashChangesForRulesProfileOrTerminology() throws {
        try withSkillDirectory { directory in
            let first = try WritingSkill.load(from: directory)
            try "---\nname: academic-writing\nversion: 1.0.0\n---\nPreserve terminology and negation.".write(to: directory.appendingPathComponent("SKILL.md"), atomically: true, encoding: .utf8)
            let second = try WritingSkill.load(from: directory)
            #expect(first.hash != second.hash)
            try #"{"version":"1.0.0","spellingVariant":"en-GB","style":"minimal","customTerms":[]}"#.write(to: directory.appendingPathComponent("profile.json"), atomically: true, encoding: .utf8)
            let third = try WritingSkill.load(from: directory)
            #expect(second.hash != third.hash)
            try #"{"version":"1.0.0","terms":["PaEprs1a"]}"#.write(to: directory.appendingPathComponent("terminology.json"), atomically: true, encoding: .utf8)
            let fourth = try WritingSkill.load(from: directory)
            #expect(third.hash != fourth.hash)
            #expect(fourth.defaultTerms == ["PaEprs1a"])
        }
    }

    @Test func canonicallyEquivalentTermsRemainDistinctAndBothProtected() throws {
        try withSkillDirectory { directory in
            try #"{"version":"1.0.0","spellingVariant":"en-US","style":"minimal","customTerms":["Café"]}"#.write(to: directory.appendingPathComponent("profile.json"), atomically: true, encoding: .utf8)
            try #"{"version":"1.0.0","terms":["Cafe\u0301","Café"]}"#.write(to: directory.appendingPathComponent("terminology.json"), atomically: true, encoding: .utf8)
            let skill = try WritingSkill.load(from: directory)
            let byteTerms = skill.profile.customTerms.map { Array($0.utf8) }
            #expect(byteTerms == [Array("Café".utf8), Array("Cafe\u{301}".utf8)])
            let validator = WritingIssueValidator(profile: skill.profile)
            for term in ["Café", "Cafe\u{301}"] {
                let snapshot = WritingSnapshot(requestID: "r", documentSessionID: "d", blockID: "b", revision: "1", rawText: term)
                #expect(throws: WritingValidationError.protectedTermChanged) {
                    try validator.validate(.init(original: term, replacement: "Coffee"), in: snapshot)
                }
            }
        }
    }

    @Test func malformedOrUnsupportedProfileIsRejected() throws {
        try withSkillDirectory { directory in
            try #"{"version":"1.0.0","spellingVariant":"xx","style":"rewrite","customTerms":[]}"#.write(to: directory.appendingPathComponent("profile.json"), atomically: true, encoding: .utf8)
            #expect(throws: WritingSkillError.invalidProfile) { try WritingSkill.load(from: directory) }
        }
    }

    private func withSkillDirectory(_ run: (URL) throws -> Void) throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try "---\nname: academic-writing\nversion: 1.0.0\n---\nPreserve meaning.".write(to: directory.appendingPathComponent("SKILL.md"), atomically: true, encoding: .utf8)
        try #"{"version":"1.0.0","spellingVariant":"en-US","style":"minimal","customTerms":[]}"#.write(to: directory.appendingPathComponent("profile.json"), atomically: true, encoding: .utf8)
        try #"{"version":"1.0.0","terms":[]}"#.write(to: directory.appendingPathComponent("terminology.json"), atomically: true, encoding: .utf8)
        try run(directory)
    }
}
