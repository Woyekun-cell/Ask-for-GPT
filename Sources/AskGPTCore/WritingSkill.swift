import Foundation

public enum WritingSkillError: Error, Equatable, Sendable {
    case invalidEncoding, missingVersion, invalidVersion, versionMismatch, emptyContent, invalidProfile, invalidTerminology
}

/// A bundled, versioned language policy. Loading failure is fatal to model polishing;
/// callers must not silently replace this policy with a generic prompt.
public struct WritingSkill: Equatable, Sendable {
    public let version: String
    public let content: String
    public let hash: String
    public let profile: WritingProfile
    public let defaultTerms: [String]

    public static func load(from directory: URL) throws -> WritingSkill {
        let ruleData = try Data(contentsOf: directory.appendingPathComponent("SKILL.md"))
        let profileData = try Data(contentsOf: directory.appendingPathComponent("profile.json"))
        let terminologyData = try Data(contentsOf: directory.appendingPathComponent("terminology.json"))
        guard let content = String(data: ruleData, encoding: .utf8) else { throw WritingSkillError.invalidEncoding }
        let lines = content.components(separatedBy: .newlines)
        guard lines.first == "---", let closing = lines.dropFirst().firstIndex(of: "---") else {
            throw WritingSkillError.missingVersion
        }
        guard let versionLine = lines[1..<closing].first(where: { $0.hasPrefix("version:") }) else {
            throw WritingSkillError.missingVersion
        }
        let version = String(versionLine.dropFirst("version:".count)).trimmingCharacters(in: .whitespaces)
        guard !version.isEmpty else { throw WritingSkillError.missingVersion }
        guard version.range(of: #"^\d+\.\d+\.\d+$"#, options: .regularExpression) != nil else {
            throw WritingSkillError.invalidVersion
        }
        guard !lines.dropFirst(closing + 1).joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw WritingSkillError.emptyContent
        }
        let defaults = try JSONDecoder().decode(ProfileResource.self, from: profileData)
        let terminology = try JSONDecoder().decode(TerminologyResource.self, from: terminologyData)
        guard defaults.version == version, terminology.version == version else { throw WritingSkillError.versionMismatch }
        guard ["en-US", "en-GB"].contains(defaults.spellingVariant), ["minimal", "clarity"].contains(defaults.style),
              defaults.customTerms.allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else {
            throw WritingSkillError.invalidProfile
        }
        guard terminology.terms.allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else {
            throw WritingSkillError.invalidTerminology
        }
        // Length-prefixed bytes include every runtime policy resource without delimiter ambiguity.
        var policyData = Data()
        for resource in [ruleData, profileData, terminologyData] {
            policyData.append(Data("\(resource.count):".utf8)); policyData.append(resource)
        }
        var seenTermBytes: Set<Data> = []
        let exactTerms = (defaults.customTerms + terminology.terms).filter { term in
            seenTermBytes.insert(Data(term.utf8)).inserted
        }
        let profile = WritingProfile(spellingVariant: defaults.spellingVariant, style: defaults.style,
                                     customTerms: exactTerms)
        return WritingSkill(version: version, content: content, hash: writingSHA256(policyData),
                            profile: profile, defaultTerms: terminology.terms)
    }
}

private struct ProfileResource: Decodable {
    let version: String
    let spellingVariant: String
    let style: String
    let customTerms: [String]
}
private struct TerminologyResource: Decodable { let version: String; let terms: [String] }
