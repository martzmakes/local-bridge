import Foundation

public enum ConfigError: Error, Equatable, Sendable, LocalizedError {
    case notFound(String)
    case notJSON(String)
    case structure(String)
    case invalid([ValidationIssue])
    case writeFailed(String)

    public var errorDescription: String? {
        switch self {
        case .notFound(let path): return "Config file not found: \(path)"
        case .notJSON(let path): return "\(path) is not valid JSON."
        case .structure(let message): return message
        case .invalid(let issues): return issues.map(\.description).joined(separator: "\n")
        case .writeFailed(let message): return "Could not write the config: \(message)"
        }
    }
}

public enum ToolAccess: String, Sendable, Equatable, Codable {
    case read
    case write

    /// The daemon's `suggestedAccess` rule, for tools the app has to class on its own.
    public static func suggested(forToolNamed name: String, readOnlyHint: Bool? = nil) -> ToolAccess {
        if readOnlyHint == true { return .read }
        let prefixes = ["get_", "list_", "search_", "read_", "find_"]
        return prefixes.contains(where: name.hasPrefix) ? .read : .write
    }
}

public enum Transport: String, Sendable, Equatable, CaseIterable, Codable {
    case stdio
    case sse
    case http

    public var isRemote: Bool { self != .stdio }
}

/// One entry under `servers` in the daemon's config.
public struct ServerConfig: Sendable, Equatable {
    public var title: String?
    public var endpointId: UUID?
    /// nil means the key is absent, which the daemon reads as enabled.
    public var enabled: Bool?
    public var transport: Transport
    // stdio
    public var command: String
    public var args: [String]
    public var env: [String: String]?
    public var cwd: String?
    // sse, http
    public var url: String
    public var headers: [String: String]?
    // exposure
    public var read: [String]
    public var write: [String]
    public var concurrency: Int?
    public var callTimeoutMs: Int?
    /// Keys this app does not know. Written back untouched.
    public var extra: [String: JSONValue]

    public init(
        title: String? = nil,
        endpointId: UUID? = nil,
        enabled: Bool? = nil,
        transport: Transport = .stdio,
        command: String = "",
        args: [String] = [],
        env: [String: String]? = nil,
        cwd: String? = nil,
        url: String = "",
        headers: [String: String]? = nil,
        read: [String] = [],
        write: [String] = [],
        concurrency: Int? = nil,
        callTimeoutMs: Int? = nil,
        extra: [String: JSONValue] = [:]
    ) {
        self.title = title
        self.endpointId = endpointId
        self.enabled = enabled
        self.transport = transport
        self.command = command
        self.args = args
        self.env = env
        self.cwd = cwd
        self.url = url
        self.headers = headers
        self.read = read
        self.write = write
        self.concurrency = concurrency
        self.callTimeoutMs = callTimeoutMs
        self.extra = extra
    }

    public var isEnabled: Bool {
        get { enabled ?? true }
        set { enabled = newValue }
    }

    /// The config's exposure decision for one tool. A name in both lists is `write`.
    public func access(for tool: String) -> ToolAccess? {
        if write.contains(tool) { return .write }
        if read.contains(tool) { return .read }
        return nil
    }

    public var exposedToolCount: Int {
        Set(read).union(write).count
    }

    /// The per-tool switch: off removes the tool from both lists, on puts it in exactly one.
    public mutating func setTool(_ tool: String, exposed: Bool, access: ToolAccess) {
        read.removeAll { $0 == tool }
        write.removeAll { $0 == tool }
        guard exposed else { return }
        switch access {
        case .read: read.append(tool)
        case .write: write.append(tool)
        }
    }

    /// Same exposure, with duplicates dropped and a tool named in both lists kept only under `write`.
    public func normalized() -> ServerConfig {
        var copy = self
        var seenWrite = Set<String>()
        copy.write = write.filter { seenWrite.insert($0).inserted }
        var seenRead = Set<String>()
        copy.read = read.filter { !seenWrite.contains($0) && seenRead.insert($0).inserted }
        if let env = copy.env, env.isEmpty { copy.env = nil }
        if let headers = copy.headers, headers.isEmpty { copy.headers = nil }
        if let title = copy.title?.trimmingCharacters(in: .whitespacesAndNewlines) {
            copy.title = title.isEmpty ? nil : title
        }
        return copy
    }

    /// After the first inspection of a server that exposes nothing yet, read-suggested tools
    /// start switched on and write-suggested tools start off. A server that already has an
    /// exposure list is left alone, so a tool that appears after an upgrade stays invisible.
    public mutating func applyFirstInspection(_ tools: [InspectedTool]) {
        guard read.isEmpty, write.isEmpty else { return }
        read = tools.filter { $0.suggestedAccess == .read }.map(\.name)
    }

    /// What the command line or URL looks like, for matching known servers.
    public var invocationText: String {
        transport == .stdio ? ([command] + args).joined(separator: " ") : url
    }
}

public struct BridgeConfig: Sendable, Equatable {
    public static let defaultEndpoint = "wss://bridge-ws.martzmakes.com"
    public static let defaultPublicBase = "https://bridge.martzmakes.com"
    public static let maxServers = 32

    public var machine: String
    public var endpoint: String
    public var publicBase: String?
    /// The account id (`uid`) this Mac is registered under. Written after sign-in.
    public var account: String?
    public var servers: [String: ServerConfig]
    /// Top-level keys this app does not know. Written back untouched.
    public var extra: [String: JSONValue]

    public init(
        machine: String,
        endpoint: String = BridgeConfig.defaultEndpoint,
        publicBase: String? = nil,
        account: String? = nil,
        servers: [String: ServerConfig] = [:],
        extra: [String: JSONValue] = [:]
    ) {
        self.machine = machine
        self.endpoint = endpoint
        self.publicBase = publicBase
        self.account = account
        self.servers = servers
        self.extra = extra
    }

    public var serverNames: [String] { servers.keys.sorted() }

    /// Server names in the order people read them: by title, falling back to the name.
    public var serverNamesByTitle: [String] {
        servers.keys.sorted {
            let a = (servers[$0]?.title ?? $0).lowercased(), b = (servers[$1]?.title ?? $1).lowercased()
            return a == b ? $0 < $1 : a < b
        }
    }

    public var effectivePublicBase: String {
        let trimmed = publicBase?.trimmingCharacters(in: .whitespaces) ?? ""
        return trimmed.isEmpty ? BridgeConfig.defaultPublicBase : trimmed
    }

    public func endpointURL(forServer name: String) -> String? {
        guard let id = servers[name]?.endpointId else { return nil }
        var base = effectivePublicBase
        while base.hasSuffix("/") { base.removeLast() }
        return "\(base)/mcp/\(id.uuidString.lowercased())"
    }

    public func withEndpointIDs() -> BridgeConfig {
        var copy = self
        for name in servers.keys where servers[name]?.endpointId == nil {
            copy.servers[name]?.endpointId = UUID()
        }
        return copy
    }

    public func normalized() -> BridgeConfig {
        var copy = self
        copy.servers = servers.mapValues { $0.normalized() }
        if let base = copy.publicBase?.trimmingCharacters(in: .whitespaces) {
            copy.publicBase = base.isEmpty ? nil : base
        }
        return copy
    }
}

// MARK: - JSON

private struct ObjectReader {
    var fields: [String: JSONValue]
    let path: String

    private func label(_ key: String) -> String { path.isEmpty ? key : "\(path).\(key)" }

    mutating func string(_ key: String) throws -> String? {
        guard let value = fields.removeValue(forKey: key) else { return nil }
        guard let s = value.stringValue else { throw ConfigError.structure("\(label(key)) must be a string") }
        return s
    }

    mutating func bool(_ key: String) throws -> Bool? {
        guard let value = fields.removeValue(forKey: key) else { return nil }
        guard let b = value.boolValue else { throw ConfigError.structure("\(label(key)) must be true or false") }
        return b
    }

    mutating func int(_ key: String) throws -> Int? {
        guard let value = fields.removeValue(forKey: key) else { return nil }
        guard let i = value.intValue else { throw ConfigError.structure("\(label(key)) must be a whole number") }
        return i
    }

    mutating func strings(_ key: String) throws -> [String]? {
        guard let value = fields.removeValue(forKey: key) else { return nil }
        guard let items = value.arrayValue else { throw ConfigError.structure("\(label(key)) must be a list of strings") }
        return try items.map {
            guard let s = $0.stringValue else { throw ConfigError.structure("\(label(key)) must be a list of strings") }
            return s
        }
    }

    mutating func stringMap(_ key: String) throws -> [String: String]? {
        guard let value = fields.removeValue(forKey: key) else { return nil }
        guard let object = value.objectValue else { throw ConfigError.structure("\(label(key)) must be an object of strings") }
        return try object.mapValues {
            guard let s = $0.stringValue else { throw ConfigError.structure("\(label(key)) must be an object of strings") }
            return s
        }
    }
}

extension ServerConfig {
    public init(json: JSONValue, path: String = "") throws {
        guard let object = json.objectValue else { throw ConfigError.structure("\(path.isEmpty ? "server" : path) must be an object") }
        var r = ObjectReader(fields: object, path: path)
        guard let transportName = try r.string("transport") else {
            throw ConfigError.structure("\(path.isEmpty ? "" : path + ".")transport is missing")
        }
        guard let transport = Transport(rawValue: transportName) else {
            throw ConfigError.structure("\(path.isEmpty ? "" : path + ".")transport must be stdio, sse or http")
        }
        self.init(transport: transport)
        title = try r.string("title")
        if let id = try r.string("endpointId") {
            let pattern = #"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"#
            guard id.range(of: pattern, options: .regularExpression) != nil, let uuid = UUID(uuidString: id) else {
                throw ConfigError.structure("\(path.isEmpty ? "endpointId" : path + ".endpointId") must be a lowercase UUIDv4")
            }
            endpointId = uuid
        }
        enabled = try r.bool("enabled")
        if transport == .stdio {
            command = try r.string("command") ?? ""
            args = try r.strings("args") ?? []
            env = try r.stringMap("env")
            cwd = try r.string("cwd")
        } else {
            url = try r.string("url") ?? ""
            headers = try r.stringMap("headers")
        }
        read = try r.strings("read") ?? []
        write = try r.strings("write") ?? []
        concurrency = try r.int("concurrency")
        callTimeoutMs = try r.int("callTimeoutMs")
        extra = r.fields
    }

    public var json: JSONValue {
        var o = extra
        if let title { o["title"] = .string(title) }
        if let endpointId { o["endpointId"] = .string(endpointId.uuidString.lowercased()) }
        if let enabled { o["enabled"] = .bool(enabled) }
        o["transport"] = .string(transport.rawValue)
        if transport == .stdio {
            o["command"] = .string(command)
            o["args"] = .array(args.map(JSONValue.string))
            if let env { o["env"] = .object(env.mapValues(JSONValue.string)) }
            if let cwd { o["cwd"] = .string(cwd) }
        } else {
            o["url"] = .string(url)
            if let headers { o["headers"] = .object(headers.mapValues(JSONValue.string)) }
        }
        o["read"] = .array(read.map(JSONValue.string))
        o["write"] = .array(write.map(JSONValue.string))
        if let concurrency { o["concurrency"] = .int(Int64(concurrency)) }
        if let callTimeoutMs { o["callTimeoutMs"] = .int(Int64(callTimeoutMs)) }
        return .object(o)
    }

    /// The object `cli.mjs inspect` reads on stdin: the server as configured, exposure left out.
    public var inspectJSON: JSONValue {
        guard case .object(var o) = json else { return json }
        o["read"] = .array([])
        o["write"] = .array([])
        return .object(o)
    }
}

extension BridgeConfig {
    public init(json: JSONValue) throws {
        guard let object = json.objectValue else { throw ConfigError.structure("The config must be a JSON object") }
        var r = ObjectReader(fields: object, path: "")
        let machine = try r.string("machine") ?? ""
        let endpoint = try r.string("endpoint") ?? ""
        let publicBase = try r.string("publicBase")
        let account = try r.string("account")
        var servers: [String: ServerConfig] = [:]
        if let raw = r.fields.removeValue(forKey: "servers") {
            guard let dict = raw.objectValue else { throw ConfigError.structure("servers must be an object") }
            for (name, value) in dict {
                servers[name] = try ServerConfig(json: value, path: "servers.\(name)")
            }
        }
        self.init(machine: machine, endpoint: endpoint, publicBase: publicBase, account: account, servers: servers, extra: r.fields)
    }

    public init(data: Data) throws {
        let value: JSONValue
        do {
            value = try JSONValue.parse(data)
        } catch {
            throw ConfigError.structure("The file is not valid JSON")
        }
        try self.init(json: value)
    }

    public var json: JSONValue {
        var o = extra
        o["machine"] = .string(machine)
        o["endpoint"] = .string(endpoint)
        if let publicBase { o["publicBase"] = .string(publicBase) }
        if let account { o["account"] = .string(account) }
        o["servers"] = .object(servers.mapValues(\.json))
        return .object(o)
    }

    /// The text written to disk: sorted keys, two-space indent, trailing newline.
    public func serialized() -> String {
        json.serialized(pretty: true)
    }
}

extension ServerConfig: Codable {
    public init(from decoder: Decoder) throws {
        try self.init(json: try JSONValue(from: decoder))
    }

    public func encode(to encoder: Encoder) throws {
        try json.encode(to: encoder)
    }
}

extension BridgeConfig: Codable {
    public init(from decoder: Decoder) throws {
        try self.init(json: try JSONValue(from: decoder))
    }

    public func encode(to encoder: Encoder) throws {
        try json.encode(to: encoder)
    }
}
