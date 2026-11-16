import Foundation

/// One tool as the app shows it: which group it is in and whether it is switched on.
public struct ToolEntry: Sendable, Equatable, Identifiable {
    public var name: String
    public var description: String
    public var isOn: Bool
    public var access: ToolAccess
    /// The last inspection did not list this tool, but the config names it.
    public var notReported: Bool
    public var inputSchema: JSONValue?

    public var id: String { name }

    public init(name: String, description: String, isOn: Bool, access: ToolAccess, notReported: Bool = false, inputSchema: JSONValue? = nil) {
        self.name = name
        self.description = description
        self.isOn = isOn
        self.access = access
        self.notReported = notReported
        self.inputSchema = inputSchema
    }
}

public struct ToolGroups: Sendable, Equatable {
    public var read: [ToolEntry]
    public var write: [ToolEntry]

    public init(read: [ToolEntry], write: [ToolEntry]) {
        self.read = read
        self.write = write
    }

    public var all: [ToolEntry] { read + write }

    public static func count(on entries: [ToolEntry]) -> Int { entries.filter(\.isOn).count }
}

public enum ToolCatalog {
    /// Every tool worth showing for a server, grouped by what it can do.
    ///
    /// A tool's group is decided by, in order: the list it is saved under while it is on, the
    /// user's own choice (`overrides`), what the server said when inspected, the list it was
    /// last saved under, and finally its name.
    public static func groups(
        server: ServerConfig,
        saved: ServerConfig?,
        inspected: [InspectedTool]?,
        overrides: [String: ToolAccess] = [:]
    ) -> ToolGroups {
        let inspected = inspected ?? []
        let byName = Dictionary(inspected.map { ($0.name, $0) }, uniquingKeysWith: { first, _ in first })
        var names = inspected.map(\.name)
        var seen = Set(names)
        for name in server.read + server.write + (saved?.read ?? []) + (saved?.write ?? []) where seen.insert(name).inserted {
            names.append(name)
        }
        var groups = ToolGroups(read: [], write: [])
        for name in names {
            let tool = byName[name]
            let access = server.access(for: name)
                ?? overrides[name]
                ?? tool?.suggestedAccess
                ?? saved?.access(for: name)
                ?? ToolAccess.suggested(forToolNamed: name)
            let entry = ToolEntry(
                name: name, description: tool?.description ?? "", isOn: server.access(for: name) != nil,
                access: access, notReported: tool == nil && !inspected.isEmpty, inputSchema: tool?.inputSchema)
            if access == .read { groups.read.append(entry) } else { groups.write.append(entry) }
        }
        return groups
    }
}

extension ServerConfig {
    /// Switches a whole group on or off, keeping the order given.
    public mutating func setTools(_ tools: [String], exposed: Bool, access: ToolAccess) {
        for tool in tools { setTool(tool, exposed: exposed, access: access) }
    }

    /// Moves a tool to the other group. For a tool that is on, this changes the list it is saved under.
    /// Returns false when the tool is off, so there is nothing in the config to change.
    @discardableResult
    public mutating func reclassify(_ tool: String, as access: ToolAccess) -> Bool {
        guard self.access(for: tool) != nil else { return false }
        setTool(tool, exposed: true, access: access)
        return true
    }
}
