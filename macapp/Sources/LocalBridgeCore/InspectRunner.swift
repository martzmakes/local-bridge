import Foundation

public struct InspectedTool: Sendable, Equatable, Codable, Identifiable {
    public var name: String
    public var description: String?
    public var readOnlyHint: Bool?
    public var suggestedAccess: ToolAccess
    /// The tool's JSON input schema, when the agent reports it.
    public var inputSchema: JSONValue?

    public var id: String { name }

    public init(name: String, description: String? = nil, readOnlyHint: Bool? = nil, suggestedAccess: ToolAccess, inputSchema: JSONValue? = nil) {
        self.name = name
        self.description = description
        self.readOnlyHint = readOnlyHint
        self.suggestedAccess = suggestedAccess
        self.inputSchema = inputSchema
    }
}

public enum InspectResult: Sendable, Equatable {
    case ok([InspectedTool])
    case failed(String)
}

/// Runs `<node> <cli.mjs> inspect` for one server and reads its one line of JSON.
public struct InspectRunner: Sendable {
    public var nodePath: String
    public var cliPath: String
    /// The daemon gives up after 20 s; this is the outer guard.
    public var timeout: TimeInterval
    public var environment: [String: String]?

    public init(nodePath: String, cliPath: String, timeout: TimeInterval = 25, environment: [String: String]? = nil) {
        self.nodePath = nodePath
        self.cliPath = cliPath
        self.timeout = timeout
        self.environment = environment
    }

    public func inspect(_ server: ServerConfig) async -> InspectResult {
        let input = Data(server.inspectJSON.serialized(pretty: false).utf8)
        let output = await ProcessRunner.run(
            executable: nodePath, arguments: [cliPath, "inspect"], environment: environment, stdin: input, timeout: timeout)
        return InspectRunner.interpret(output, timeout: timeout)
    }

    static func interpret(_ output: ProcessOutput, timeout: TimeInterval) -> InspectResult {
        if let launchError = output.launchError { return .failed(launchError) }
        if output.timedOut { return .failed("The server did not answer within \(Int(timeout)) seconds.") }
        if let parsed = parse(output.stdout) { return parsed }
        if let status = output.status, status != 0 {
            let detail = output.stderrText.split(separator: "\n").last.map { String($0.prefix(200)) }
            return .failed("inspect exited with status \(status)" + (detail.map { ": \($0)" } ?? ""))
        }
        return .failed("inspect returned output that could not be read.")
    }

    /// The last line of stdout that is an inspect result. nil if there is none.
    public static func parse(_ stdout: Data) -> InspectResult? {
        let text = String(decoding: stdout, as: UTF8.self)
        for line in text.split(whereSeparator: \.isNewline).reversed() {
            guard let value = try? JSONValue.parse(String(line)), let object = value.objectValue,
                  let ok = object["ok"]?.boolValue else { continue }
            if !ok {
                return .failed(object["error"]?.stringValue ?? "The server could not be inspected.")
            }
            guard let rawTools = object["tools"]?.arrayValue else { return nil }
            var tools: [InspectedTool] = []
            for raw in rawTools {
                guard let t = raw.objectValue, let name = t["name"]?.stringValue, !name.isEmpty else { continue }
                let hint = t["readOnlyHint"]?.boolValue
                let access = t["suggestedAccess"]?.stringValue.flatMap(ToolAccess.init(rawValue:))
                    ?? ToolAccess.suggested(forToolNamed: name, readOnlyHint: hint)
                tools.append(InspectedTool(
                    name: name, description: t["description"]?.stringValue, readOnlyHint: hint, suggestedAccess: access,
                    inputSchema: t["inputSchema"]?.objectValue == nil ? nil : t["inputSchema"]))
            }
            return .ok(tools)
        }
        return nil
    }
}

/// What the last inspection of each server found, kept so the tool list survives a relaunch.
/// Tool names and descriptions only.
public struct InspectCache: Sendable, Equatable, Codable {
    public struct Entry: Sendable, Equatable, Codable {
        public var tools: [InspectedTool]
        public var inspectedAt: Date
        /// Tools the user moved to the other group. Kept across inspections.
        public var overrides: [String: ToolAccess]?

        public init(tools: [InspectedTool], inspectedAt: Date, overrides: [String: ToolAccess]? = nil) {
            self.tools = tools
            self.inspectedAt = inspectedAt
            self.overrides = overrides
        }
    }

    public var servers: [String: Entry]

    public init(servers: [String: Entry] = [:]) {
        self.servers = servers
    }

    public static func load(from url: URL) -> InspectCache {
        guard let data = try? Data(contentsOf: url) else { return InspectCache() }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        return (try? decoder.decode(InspectCache.self, from: data)) ?? InspectCache()
    }

    public func save(to url: URL) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .millisecondsSince1970
        encoder.outputFormatting = [.sortedKeys]
        try AtomicFile.write(try encoder.encode(self), to: url, mode: 0o600)
    }
}
