import Foundation

public struct ValidationIssue: Error, Equatable, Sendable, CustomStringConvertible {
    public var path: String
    public var message: String

    public init(path: String, message: String) {
        self.path = path
        self.message = message
    }

    public var description: String { "\(path): \(message)" }
}

/// The daemon's config rules (agent/src/config.ts), so the app never saves a file the daemon refuses.
public enum ConfigValidator {
    public static let nameRule = "must be 1 to 16 lowercase letters or digits"

    public static func isValidName(_ name: String) -> Bool {
        guard (1...16).contains(name.utf8.count) else { return false }
        return name.utf8.allSatisfy { ($0 >= 97 && $0 <= 122) || ($0 >= 48 && $0 <= 57) }
    }

    /// A default machine name from a host name: lowercased, stripped to [a-z0-9], at most 16.
    public static func proposedMachineName(fromHost host: String) -> String {
        let first = host.split(separator: ".").first.map(String.init) ?? host
        let kept = first.lowercased().unicodeScalars.filter {
            ($0.value >= 97 && $0.value <= 122) || ($0.value >= 48 && $0.value <= 57)
        }
        let name = String(String.UnicodeScalarView(kept).prefix(16))
        return name.isEmpty ? "mac" : name
    }

    /// A server name (the last part of its connector URL) from its title: lowercased, stripped to
    /// [a-z0-9], at most 16. Empty when the title has nothing usable.
    public static func proposedServerName(fromTitle title: String) -> String {
        let kept = title.lowercased().unicodeScalars.filter {
            ($0.value >= 97 && $0.value <= 122) || ($0.value >= 48 && $0.value <= 57)
        }
        return String(String.UnicodeScalarView(kept).prefix(16))
    }

    public static func isValidEndpoint(_ text: String) -> Bool {
        guard let c = URLComponents(string: text), let scheme = c.scheme?.lowercased(), let host = c.host, !host.isEmpty else {
            return false
        }
        if scheme == "wss" { return true }
        // Plain ws is only for a test server on this machine.
        let bare = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased()
        return scheme == "ws" && ["localhost", "127.0.0.1", "::1"].contains(bare)
    }

    public static func isHTTPURL(_ text: String, httpsOnly: Bool = false) -> Bool {
        guard let c = URLComponents(string: text), let scheme = c.scheme?.lowercased(), let host = c.host, !host.isEmpty else {
            return false
        }
        return scheme == "https" || (!httpsOnly && scheme == "http")
    }

    public static func validate(_ config: BridgeConfig) -> [ValidationIssue] {
        var issues: [ValidationIssue] = []
        if !isValidName(config.machine) {
            issues.append(.init(path: "machine", message: nameRule))
        }
        if !isValidEndpoint(config.endpoint) {
            issues.append(.init(path: "endpoint", message: "must be a wss:// URL (ws:// is accepted for localhost only)"))
        }
        if let base = config.publicBase, !isHTTPURL(base, httpsOnly: true) {
            issues.append(.init(path: "publicBase", message: "must be an https:// URL"))
        }
        if let account = config.account, account.isEmpty {
            issues.append(.init(path: "account", message: "must not be empty"))
        }
        if config.servers.count > BridgeConfig.maxServers {
            issues.append(.init(path: "servers", message: "at most \(BridgeConfig.maxServers) servers"))
        }
        for name in config.serverNames {
            if !isValidName(name) {
                issues.append(.init(path: "servers.\(name)", message: "server name \(nameRule)"))
            }
            issues.append(contentsOf: validate(config.servers[name]!, path: "servers.\(name)"))
        }
        return issues
    }

    public static func validate(_ server: ServerConfig, path: String) -> [ValidationIssue] {
        var issues: [ValidationIssue] = []
        func add(_ key: String, _ message: String) {
            issues.append(.init(path: "\(path).\(key)", message: message))
        }
        if let title = server.title, title.isEmpty || title.count > 64 {
            add("title", "must be 1 to 64 characters")
        }
        switch server.transport {
        case .stdio:
            if server.command.isEmpty { add("command", "is required") }
            if let cwd = server.cwd, cwd.isEmpty { add("cwd", "must not be empty") }
        case .sse, .http:
            if !isHTTPURL(server.url) { add("url", "must be an http(s) URL") }
        }
        for (key, list) in [("read", server.read), ("write", server.write)] {
            if list.count > 500 { add(key, "at most 500 tools") }
            if list.contains(where: { $0.isEmpty || $0.count > 128 }) {
                add(key, "tool names must be 1 to 128 characters")
            }
        }
        if let c = server.concurrency, !(1...4).contains(c) { add("concurrency", "must be 1 to 4") }
        if let t = server.callTimeoutMs, !(1...600_000).contains(t) { add("callTimeoutMs", "must be 1 to 600000") }
        return issues
    }
}
