import Foundation

/// Where the app's files live. Each one can be moved with an environment variable for tests and manual runs.
public struct BridgePaths: Sendable, Equatable {
    public static let configEnv = "LOCAL_BRIDGE_CONFIG"
    public static let stateDirEnv = "LOCAL_BRIDGE_STATE_DIR"
    public static let agentDirEnv = "LOCAL_BRIDGE_AGENT_DIR"

    public var configURL: URL
    public var stateDirectory: URL
    /// The directory holding `cli.mjs`; nil when there is no bundle and no override.
    public var agentDirectory: URL?
    public var stateDirectoryIsOverridden: Bool

    public init(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        home: URL = FileManager.default.homeDirectoryForCurrentUser,
        bundleResourceURL: URL? = Bundle.main.resourceURL
    ) {
        func value(_ key: String) -> String? {
            guard let v = environment[key], !v.isEmpty else { return nil }
            return v
        }
        configURL = value(Self.configEnv).map { URL(fileURLWithPath: $0) }
            ?? home.appendingPathComponent(".config/local-bridge/config.json")
        if let dir = value(Self.stateDirEnv) {
            stateDirectory = URL(fileURLWithPath: dir, isDirectory: true)
            stateDirectoryIsOverridden = true
        } else {
            stateDirectory = home.appendingPathComponent("Library/Application Support/local-bridge", isDirectory: true)
            stateDirectoryIsOverridden = false
        }
        if let dir = value(Self.agentDirEnv) {
            agentDirectory = URL(fileURLWithPath: dir, isDirectory: true)
        } else {
            agentDirectory = bundleResourceURL?.appendingPathComponent("agent", isDirectory: true)
        }
    }

    public var statusURL: URL { stateDirectory.appendingPathComponent("status.json") }
    public var inspectCacheURL: URL { stateDirectory.appendingPathComponent("app-inspect-cache.json") }
    public var activityURL: URL { stateDirectory.appendingPathComponent("activity.jsonl") }
    public var cliURL: URL? { agentDirectory?.appendingPathComponent("cli.mjs") }
}

public enum ConfigLoadResult: Sendable, Equatable {
    /// No file yet: a first run.
    case missing
    case loaded(BridgeConfig)
    /// The file exists but the daemon would refuse it. The app shows it read-only.
    case invalid(String)
}

public struct ConfigStore: Sendable {
    public let url: URL

    public init(url: URL) {
        self.url = url
    }

    public func load() -> ConfigLoadResult {
        guard FileManager.default.fileExists(atPath: url.path) else { return .missing }
        guard let data = try? Data(contentsOf: url) else {
            return .invalid("The file could not be read.")
        }
        let config: BridgeConfig
        do {
            config = try BridgeConfig(data: data)
        } catch let error as ConfigError {
            return .invalid(error.errorDescription ?? "The file is not a valid config.")
        } catch {
            return .invalid("The file is not a valid config.")
        }
        let issues = ConfigValidator.validate(config)
        if !issues.isEmpty {
            return .invalid(issues.map(\.description).joined(separator: "\n"))
        }
        return .loaded(config)
    }

    /// Validates, then writes the file atomically with mode 0600. Returns what was written.
    @discardableResult
    public func save(_ config: BridgeConfig) throws -> BridgeConfig {
        let normalized = config.normalized().withEndpointIDs()
        let issues = ConfigValidator.validate(normalized)
        guard issues.isEmpty else { throw ConfigError.invalid(issues) }
        try AtomicFile.write(Data(normalized.serialized().utf8), to: url, mode: 0o600)
        return normalized
    }
}

public enum AtomicFile {
    /// Writes to a new file beside the target and renames it over, so a reader never sees half a file.
    public static func write(_ data: Data, to url: URL, mode: mode_t) throws {
        let directory = url.deletingLastPathComponent()
        do {
            try FileManager.default.createDirectory(
                at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        } catch {
            throw ConfigError.writeFailed("cannot create \(directory.path)")
        }
        let temp = directory.appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString).tmp")
        let fd = open(temp.path, O_WRONLY | O_CREAT | O_EXCL, mode)
        guard fd >= 0 else { throw ConfigError.writeFailed("cannot create a file in \(directory.path)") }
        var ok = fchmod(fd, mode) == 0
        if ok {
            ok = data.withUnsafeBytes { raw -> Bool in
                var offset = 0
                while offset < raw.count {
                    let n = Darwin.write(fd, raw.baseAddress! + offset, raw.count - offset)
                    if n < 0 {
                        if errno == EINTR { continue }
                        return false
                    }
                    offset += n
                }
                return true
            }
        }
        if ok { ok = fsync(fd) == 0 }
        close(fd)
        if ok { ok = rename(temp.path, url.path) == 0 }
        if !ok {
            unlink(temp.path)
            throw ConfigError.writeFailed("cannot write \(url.path)")
        }
    }
}
