import Foundation

/// Finds the `node` the daemon runs under. A user override always wins, even when it is wrong,
/// so a typo shows up as "not found" instead of silently running a different node.
public struct NodeLocator: Sendable {
    public static let standardCandidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node"]

    public var candidates: [String]
    public var isExecutable: @Sendable (String) -> Bool
    /// `which node` through a login shell; nil when it finds nothing.
    public var shellLookup: @Sendable () -> String?

    public init(
        candidates: [String] = NodeLocator.standardCandidates,
        isExecutable: @escaping @Sendable (String) -> Bool = NodeLocator.defaultIsExecutable,
        shellLookup: @escaping @Sendable () -> String? = NodeLocator.loginShellLookup
    ) {
        self.candidates = candidates
        self.isExecutable = isExecutable
        self.shellLookup = shellLookup
    }

    public func locate(override: String? = nil) -> String? {
        let trimmed = override?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmed.isEmpty {
            let expanded = (trimmed as NSString).expandingTildeInPath
            return isExecutable(expanded) ? expanded : nil
        }
        if let found = candidates.first(where: isExecutable) { return found }
        if let fromShell = shellLookup(), isExecutable(fromShell) { return fromShell }
        return nil
    }

    public static let defaultIsExecutable: @Sendable (String) -> Bool = { path in
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), !isDirectory.boolValue else {
            return false
        }
        return FileManager.default.isExecutableFile(atPath: path)
    }

    public static let loginShellLookup: @Sendable () -> String? = {
        let shell = ProcessInfo.processInfo.environment["SHELL"].flatMap { $0.isEmpty ? nil : $0 } ?? "/bin/zsh"
        let output = ProcessRunner.runSync(executable: shell, arguments: ["-l", "-c", "command -v node"], timeout: 5)
        guard output.status == 0 else { return nil }
        // A login shell can print a banner first; the path is the last line that looks like one.
        let lines = output.stdoutText.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }
        return lines.last(where: { $0.hasPrefix("/") })
    }
}
