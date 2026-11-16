import Foundation

/// The apps whose MCP server lists this app can read.
public enum DiscoverySource: String, Sendable, Equatable, CaseIterable {
    case claudeCode
    case claudeDesktop
    case cursor
    case windsurf
    case vsCode
    case codex

    public var displayName: String {
        switch self {
        case .claudeCode: return "Claude Code"
        case .claudeDesktop: return "Claude Desktop"
        case .cursor: return "Cursor"
        case .windsurf: return "Windsurf"
        case .vsCode: return "VS Code"
        case .codex: return "Codex"
        }
    }
}

/// A server another app already has configured on this Mac.
public struct DiscoveredServer: Sendable, Equatable, Identifiable {
    /// The key it has in the file it came from.
    public var key: String
    public var sources: [DiscoverySource]
    public var proposedTitle: String
    public var proposedName: String
    /// Ready to add. Carries env and header values as the user wrote them; never display those.
    public var config: ServerConfig
    /// One line that is safe to show: no env, no headers, no query string, secret-looking arguments masked.
    public var summary: String

    public var id: String { proposedName }

    public init(key: String, sources: [DiscoverySource], proposedTitle: String, proposedName: String, config: ServerConfig, summary: String) {
        self.key = key
        self.sources = sources
        self.proposedTitle = proposedTitle
        self.proposedName = proposedName
        self.config = config
        self.summary = summary
    }

    public var sourceList: String { sources.map(\.displayName).joined(separator: ", ") }
}

/// A configured server that is already reachable over the internet, so it does not need the bridge.
public struct RemoteServerNote: Sendable, Equatable, Identifiable {
    public var title: String
    public var host: String
    public var sources: [DiscoverySource]

    public init(title: String, host: String, sources: [DiscoverySource]) {
        self.title = title
        self.host = host
        self.sources = sources
    }

    public var id: String { "\(title)|\(host)" }
}

public struct DiscoveryResult: Sendable, Equatable {
    public var servers: [DiscoveredServer] = []
    public var alreadyRemote: [RemoteServerNote] = []
    /// Servers found that this bridge already has.
    public var alreadyAdded = 0
    /// Files that exist but could not be understood.
    public var unreadable: [DiscoverySource] = []

    public init() {}
}

/// Reads MCP server definitions other apps keep on this Mac. Read-only.
public struct ServerDiscovery: Sendable {
    public struct Location: Sendable, Equatable {
        public var source: DiscoverySource
        public var url: URL

        public init(source: DiscoverySource, url: URL) {
            self.source = source
            self.url = url
        }
    }

    public var locations: [Location]

    public init(locations: [Location]) {
        self.locations = locations
    }

    public init(home: URL = FileManager.default.homeDirectoryForCurrentUser) {
        func path(_ relative: String) -> URL { home.appendingPathComponent(relative) }
        locations = [
            Location(source: .claudeCode, url: path(".claude.json")),
            Location(source: .claudeDesktop, url: path("Library/Application Support/Claude/claude_desktop_config.json")),
            Location(source: .cursor, url: path(".cursor/mcp.json")),
            Location(source: .windsurf, url: path(".codeium/windsurf/mcp_config.json")),
            Location(source: .vsCode, url: path("Library/Application Support/Code/User/mcp.json")),
            Location(source: .codex, url: path(".codex/config.toml")),
        ]
    }

    public func discover(existing: BridgeConfig? = nil) -> DiscoveryResult {
        var result = DiscoveryResult()
        var found: [(key: String, source: DiscoverySource, config: ServerConfig)] = []
        for location in locations {
            guard FileManager.default.fileExists(atPath: location.url.path) else { continue }
            guard let data = try? Data(contentsOf: location.url),
                  let definitions = Self.definitions(in: data, source: location.source) else {
                result.unreadable.append(location.source)
                continue
            }
            for (key, value) in definitions.sorted(by: { $0.key < $1.key }) {
                if let config = Self.serverConfig(from: value) {
                    found.append((key, location.source, config))
                }
            }
        }

        let existingSignatures = Set((existing?.servers.values).map { $0.map(Self.signature) } ?? [])
        var usedNames = Set(existing?.servers.keys.map { $0 } ?? [])
        var indexBySignature: [String: Int] = [:]
        var remoteIndex: [String: Int] = [:]
        var countedAdded = Set<String>()

        for item in found {
            let signature = Self.signature(item.config)
            if existingSignatures.contains(signature) {
                if countedAdded.insert(signature).inserted { result.alreadyAdded += 1 }
                continue
            }
            if item.config.transport.isRemote, !Self.isLocalURL(item.config.url) {
                if let index = remoteIndex[signature] {
                    if !result.alreadyRemote[index].sources.contains(item.source) {
                        result.alreadyRemote[index].sources.append(item.source)
                    }
                } else {
                    remoteIndex[signature] = result.alreadyRemote.count
                    result.alreadyRemote.append(RemoteServerNote(
                        title: Self.title(forKey: item.key),
                        host: URLComponents(string: item.config.url)?.host ?? "",
                        sources: [item.source]))
                }
                continue
            }
            if let index = indexBySignature[signature] {
                if !result.servers[index].sources.contains(item.source) {
                    result.servers[index].sources.append(item.source)
                }
                continue
            }
            let title = Self.title(forKey: item.key)
            let name = Self.uniqueName(Self.name(forTitle: title, key: item.key), taken: usedNames)
            usedNames.insert(name)
            var config = item.config
            config.title = title
            indexBySignature[signature] = result.servers.count
            result.servers.append(DiscoveredServer(
                key: item.key, sources: [item.source], proposedTitle: title, proposedName: name,
                config: config, summary: Self.summary(of: config)))
        }
        return result
    }

    // MARK: - Reading files

    /// The server definitions in one file, by key. nil when the file cannot be understood.
    static func definitions(in data: Data, source: DiscoverySource) -> [String: JSONValue]? {
        if source == .codex {
            guard let text = String(data: data, encoding: .utf8) else { return nil }
            return CodexTOML.servers(in: text)
        }
        guard let root = (try? JSONValue.parse(data))?.objectValue else { return nil }
        var definitions: [String: JSONValue] = [:]
        func take(_ value: JSONValue?) {
            guard let object = value?.objectValue else { return }
            for (key, definition) in object where definitions[key] == nil { definitions[key] = definition }
        }
        switch source {
        case .vsCode:
            take(root["servers"])
            take(root["mcpServers"])
        case .claudeCode:
            take(root["mcpServers"])
            if let projects = root["projects"]?.objectValue {
                for path in projects.keys.sorted() { take(projects[path]?.objectValue?["mcpServers"]) }
            }
        default:
            take(root["mcpServers"])
        }
        return definitions
    }

    /// One definition in our shape. nil when it is neither a command nor a URL.
    static func serverConfig(from value: JSONValue) -> ServerConfig? {
        guard let object = value.objectValue else { return nil }
        func strings(_ key: String) -> [String: String]? {
            guard let map = object[key]?.objectValue else { return nil }
            let kept = map.compactMapValues(\.stringValue)
            return kept.isEmpty ? nil : kept
        }
        if let command = object["command"]?.stringValue, !command.isEmpty {
            let args = object["args"]?.arrayValue?.compactMap(\.stringValue) ?? []
            return ServerConfig(transport: .stdio, command: command, args: args, env: strings("env"))
        }
        if let url = object["url"]?.stringValue ?? object["serverUrl"]?.stringValue, !url.isEmpty {
            let kind = (object["type"]?.stringValue ?? object["transport"]?.stringValue ?? "").lowercased()
            let isSSE = kind.contains("sse") || (kind.isEmpty && url.hasSuffix("/sse"))
            return ServerConfig(transport: isSSE ? .sse : .http, url: url, headers: strings("headers"))
        }
        return nil
    }

    // MARK: - Judging

    static func signature(_ config: ServerConfig) -> String {
        config.transport.isRemote ? "url\u{0}\(config.url)" : "cmd\u{0}\(config.command)\u{0}\(config.args.joined(separator: "\u{0}"))"
    }

    /// True for this Mac or a private network: something only the bridge can reach from outside.
    public static func isLocalURL(_ text: String) -> Bool {
        guard let host = URLComponents(string: text)?.host?.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]")),
              !host.isEmpty else { return false }
        if host == "localhost" || host == "::1" || host.hasSuffix(".local") || host.hasSuffix(".lan") || host.hasSuffix(".internal") { return true }
        let parts = host.split(separator: ".").compactMap { Int($0) }
        if parts.count == 4, host.split(separator: ".").count == 4 {
            switch (parts[0], parts[1]) {
            case (127, _), (10, _), (192, 168), (169, 254): return true
            case (172, 16...31): return true
            default: return false
            }
        }
        if host.hasPrefix("fe80:") || host.hasPrefix("fd") || host.hasPrefix("fc") { return host.contains(":") }
        // A bare name with no dot is a machine on the local network.
        return !host.contains(".") && !host.contains(":")
    }

    private static let knownTitles: [(tokens: Set<String>, title: String, name: String)] = [
        (["reminders", "reminder"], "Reminders", "reminders"),
        (["imessage", "messages"], "Messages", "messages"),
        (["calendar", "ical"], "Calendar", "calendar"),
        (["contacts"], "Contacts", "contacts"),
        (["mail"], "Mail", "mail"),
        (["notes"], "Apple Notes", "notes"),
        (["homeassistant", "hass", "ha"], "Home Assistant", "ha"),
    ]

    static func tokens(_ text: String) -> [String] {
        text.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init)
    }

    /// "apple-notes" becomes "Apple Notes", "imessage" becomes "Messages".
    public static func title(forKey key: String) -> String {
        let words = tokens(key)
        if words.contains("home"), words.contains("assistant") { return "Home Assistant" }
        if let known = knownTitles.first(where: { !$0.tokens.isDisjoint(with: words) }) { return known.title }
        let kept = words.filter { !["mcp", "server"].contains($0) }
        let title = (kept.isEmpty ? words : kept).map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
        return title.isEmpty ? key : String(title.prefix(64))
    }

    static func name(forTitle title: String, key: String) -> String {
        if let known = knownTitles.first(where: { $0.title == title }) { return known.name }
        let name = ConfigValidator.proposedServerName(fromTitle: title)
        return name.isEmpty ? "server" : name
    }

    public static func uniqueName(_ base: String, taken: Set<String>) -> String {
        guard taken.contains(base) else { return base }
        for n in 2...99 {
            let suffix = String(n)
            let candidate = String(base.prefix(16 - suffix.count)) + suffix
            if !taken.contains(candidate) { return candidate }
        }
        return String(base.prefix(10)) + String(UUID().uuidString.prefix(6)).lowercased()
    }

    private static let secretWords = ["key", "token", "secret", "password", "passwd", "auth", "credential", "bearer"]

    private static func looksSecret(_ text: String) -> Bool {
        let lower = text.lowercased()
        return secretWords.contains(where: lower.contains)
    }

    /// A line that says what the server is without showing anything private.
    public static func summary(of config: ServerConfig) -> String {
        if config.transport.isRemote {
            guard var components = URLComponents(string: config.url) else { return "URL" }
            components.query = nil
            components.fragment = nil
            components.user = nil
            components.password = nil
            return components.string ?? "URL"
        }
        var parts = [(config.command as NSString).lastPathComponent]
        var maskNext = false
        for argument in config.args.prefix(4) {
            if maskNext {
                parts.append("•••")
                maskNext = false
                continue
            }
            if argument.hasPrefix("-") {
                if let equals = argument.firstIndex(of: "=") {
                    let flag = String(argument[..<equals])
                    parts.append(looksSecret(flag) ? "\(flag)=•••" : shorten(argument))
                } else {
                    parts.append(argument)
                    maskNext = looksSecret(argument)
                }
                continue
            }
            if let equals = argument.firstIndex(of: "="), looksSecret(String(argument[..<equals])) {
                parts.append("\(argument[..<equals])=•••")
                continue
            }
            parts.append(shorten(argument))
        }
        if config.args.count > 4 { parts.append("…") }
        return parts.joined(separator: " ")
    }

    private static func shorten(_ argument: String) -> String {
        guard argument.hasPrefix("/") || argument.hasPrefix("~") else { return String(argument.prefix(60)) }
        let components = argument.split(separator: "/")
        guard components.count > 3 else { return argument }
        return "…/" + components.suffix(3).joined(separator: "/")
    }
}

/// Just enough TOML for Codex's `[mcp_servers.<name>]` tables: strings, one-level arrays of
/// strings, booleans and inline tables of strings. Everything else in the file is skipped.
enum CodexTOML {
    /// nil when a line inside an `mcp_servers` table cannot be read.
    static func servers(in text: String) -> [String: JSONValue]? {
        var servers: [String: [String: JSONValue]] = [:]
        var current: (server: String, sub: String?)?
        var pending: (key: String, text: String)?

        func assign(_ key: String, _ value: JSONValue) {
            guard let current else { return }
            var server = servers[current.server] ?? [:]
            if let sub = current.sub {
                var table = server[sub]?.objectValue ?? [:]
                table[key] = value
                server[sub] = .object(table)
            } else {
                server[key] = value
            }
            servers[current.server] = server
        }

        for rawLine in text.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline) {
            var line = stripComment(String(rawLine)).trimmingCharacters(in: .whitespaces)
            if var open = pending {
                open.text += " " + line
                if balanced(open.text) {
                    guard let value = parseValue(open.text) else { return nil }
                    assign(open.key, value)
                    pending = nil
                } else {
                    pending = open
                }
                continue
            }
            if line.isEmpty { continue }
            if line.hasPrefix("[") {
                guard line.hasSuffix("]") else {
                    if current != nil { return nil }
                    continue
                }
                line = line.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).trimmingCharacters(in: .whitespaces)
                let path = splitKeyPath(line)
                if path.count >= 2, path[0] == "mcp_servers" {
                    current = (path[1], path.count > 2 ? path[2] : nil)
                    if servers[path[1]] == nil { servers[path[1]] = [:] }
                } else {
                    current = nil
                }
                continue
            }
            guard current != nil else { continue }
            guard let equals = line.firstIndex(of: "=") else { return nil }
            let key = unquote(String(line[..<equals]).trimmingCharacters(in: .whitespaces))
            let valueText = String(line[line.index(after: equals)...]).trimmingCharacters(in: .whitespaces)
            if !balanced(valueText) {
                pending = (key, valueText)
                continue
            }
            guard let value = parseValue(valueText) else { return nil }
            assign(key, value)
        }
        if pending != nil { return nil }
        return servers.mapValues { JSONValue.object($0) }
    }

    private static func stripComment(_ line: String) -> String {
        var quote: Character?
        var result = ""
        for character in line {
            if let q = quote {
                if character == q { quote = nil }
            } else if character == "\"" || character == "'" {
                quote = character
            } else if character == "#" {
                break
            }
            result.append(character)
        }
        return result
    }

    private static func balanced(_ text: String) -> Bool {
        var depth = 0
        var quote: Character?
        for character in text {
            if let q = quote {
                if character == q { quote = nil }
                continue
            }
            switch character {
            case "\"", "'": quote = character
            case "[", "{": depth += 1
            case "]", "}": depth -= 1
            default: break
            }
        }
        return depth <= 0 && quote == nil
    }

    private static func splitKeyPath(_ text: String) -> [String] {
        var parts: [String] = []
        var current = ""
        var quote: Character?
        for character in text {
            if let q = quote {
                if character == q { quote = nil } else { current.append(character) }
            } else if character == "\"" || character == "'" {
                quote = character
            } else if character == "." {
                parts.append(current.trimmingCharacters(in: .whitespaces))
                current = ""
            } else {
                current.append(character)
            }
        }
        parts.append(current.trimmingCharacters(in: .whitespaces))
        return parts
    }

    private static func unquote(_ text: String) -> String {
        guard text.count >= 2, let first = text.first, first == text.last, first == "\"" || first == "'" else { return text }
        return String(text.dropFirst().dropLast())
    }

    private static func splitTopLevel(_ text: String) -> [String] {
        var parts: [String] = []
        var current = ""
        var depth = 0
        var quote: Character?
        for character in text {
            if let q = quote {
                if character == q { quote = nil }
                current.append(character)
                continue
            }
            switch character {
            case "\"", "'":
                quote = character
                current.append(character)
            case "[", "{":
                depth += 1
                current.append(character)
            case "]", "}":
                depth -= 1
                current.append(character)
            case "," where depth == 0:
                parts.append(current)
                current = ""
            default:
                current.append(character)
            }
        }
        if !current.trimmingCharacters(in: .whitespaces).isEmpty { parts.append(current) }
        return parts
    }

    private static func parseValue(_ raw: String) -> JSONValue? {
        let text = raw.trimmingCharacters(in: .whitespaces)
        if text == "true" { return .bool(true) }
        if text == "false" { return .bool(false) }
        if text.hasPrefix("\"") {
            guard text.count >= 2, text.hasSuffix("\"") else { return nil }
            let inner = String(text.dropFirst().dropLast())
            return .string(inner.replacingOccurrences(of: "\\\"", with: "\"").replacingOccurrences(of: "\\\\", with: "\\"))
        }
        if text.hasPrefix("'") {
            guard text.count >= 2, text.hasSuffix("'") else { return nil }
            return .string(String(text.dropFirst().dropLast()))
        }
        if text.hasPrefix("[") {
            guard text.hasSuffix("]") else { return nil }
            var items: [JSONValue] = []
            for part in splitTopLevel(String(text.dropFirst().dropLast())) {
                guard let value = parseValue(part) else { return nil }
                items.append(value)
            }
            return .array(items)
        }
        if text.hasPrefix("{") {
            guard text.hasSuffix("}") else { return nil }
            var table: [String: JSONValue] = [:]
            for part in splitTopLevel(String(text.dropFirst().dropLast())) {
                guard let equals = part.firstIndex(of: "="),
                      let value = parseValue(String(part[part.index(after: equals)...])) else { return nil }
                table[unquote(String(part[..<equals]).trimmingCharacters(in: .whitespaces))] = value
            }
            return .object(table)
        }
        if let number = Int64(text) { return .int(number) }
        if let number = Double(text) { return .double(number) }
        return nil
    }
}

/// Which Mac app a server is about, for showing that app's icon.
public enum AppIdentity {
    private static let table: [(tokens: Set<String>, bundleID: String)] = [
        (["reminders", "reminder"], "com.apple.reminders"),
        (["imessage", "messages"], "com.apple.MobileSMS"),
        (["calendar", "ical"], "com.apple.iCal"),
        (["contacts", "addressbook"], "com.apple.AddressBook"),
        (["mail"], "com.apple.mail"),
        (["notes"], "com.apple.Notes"),
    ]

    /// From the server's title, name and what it runs. nil when it is not about a known app.
    public static func bundleID(title: String?, name: String, invocation: String) -> String? {
        // The title is the strongest hint; the command path can mention other things.
        for text in [title ?? "", name, invocation] {
            let words = Set(ServerDiscovery.tokens(text))
            if let match = table.first(where: { !$0.tokens.isDisjoint(with: words) }) { return match.bundleID }
        }
        return nil
    }

    public static func bundleID(for server: ServerConfig, name: String) -> String? {
        bundleID(title: server.title, name: name, invocation: server.invocationText)
    }
}
