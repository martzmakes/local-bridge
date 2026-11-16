import Foundation

/// One input of a tool, as a form control.
public struct ToolFormField: Sendable, Equatable, Identifiable {
    public enum Kind: Sendable, Equatable {
        case string
        case integer
        case number
        case boolean
        case choice([String])
        /// Anything the form has no control for: typed as JSON.
        case json
    }

    public var name: String
    public var description: String
    public var kind: Kind
    public var required: Bool
    public var defaultValue: JSONValue?

    public var id: String { name }
}

public struct ToolFormError: Error, Equatable, Sendable, LocalizedError {
    public var message: String
    public var errorDescription: String? { message }
}

/// Turns a tool's JSON input schema into form fields, and the filled form back into arguments.
public enum ToolForm {
    /// Required fields first, in the order the schema lists them, then the rest by name.
    /// Empty when the schema has no properties.
    public static func fields(from schema: JSONValue?) -> [ToolFormField] {
        guard let object = schema?.objectValue, let properties = object["properties"]?.objectValue else { return [] }
        let required = object["required"]?.arrayValue?.compactMap(\.stringValue) ?? []
        let optional = properties.keys.filter { !required.contains($0) }.sorted()
        return (required.filter { properties[$0] != nil } + optional).map { name in
            let property = properties[name]?.objectValue ?? [:]
            return ToolFormField(
                name: name,
                description: property["description"]?.stringValue ?? "",
                kind: kind(of: property),
                required: required.contains(name),
                defaultValue: property["default"])
        }
    }

    static func kind(of property: [String: JSONValue]) -> ToolFormField.Kind {
        if let options = property["enum"]?.arrayValue {
            let strings = options.compactMap(\.stringValue)
            return strings.count == options.count && !strings.isEmpty ? .choice(strings) : .json
        }
        var type = property["type"]?.stringValue
        if type == nil, let types = property["type"]?.arrayValue {
            type = types.compactMap(\.stringValue).first { $0 != "null" }
        }
        switch type {
        case "string": return .string
        case "integer": return .integer
        case "number": return .number
        case "boolean": return .boolean
        default: return .json
        }
    }

    /// What a field starts with, as the text or switch state the form holds.
    public static func initialText(for field: ToolFormField) -> String {
        switch field.defaultValue {
        case .string(let s)?: return s
        case .int(let i)?: return String(i)
        case .double(let d)?: return String(d)
        case .bool(let b)?: return b ? "true" : "false"
        case .null?, nil: return ""
        case let other?: return other.serialized(pretty: false)
        }
    }

    /// The arguments object for a call. `values` holds each field's text; a boolean is "true" or "false".
    /// An optional field left empty is left out.
    public static func arguments(fields: [ToolFormField], values: [String: String]) throws -> JSONValue {
        var arguments: [String: JSONValue] = [:]
        for field in fields {
            let text = (values[field.name] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if field.kind == .boolean {
                let on = text == "true"
                let usual = field.defaultValue?.boolValue ?? false
                if field.required || on != usual { arguments[field.name] = .bool(on) }
                continue
            }
            if text.isEmpty {
                if field.required { throw ToolFormError(message: "\(field.name) is required.") }
                continue
            }
            switch field.kind {
            case .string, .choice:
                arguments[field.name] = .string(values[field.name] ?? text)
            case .integer:
                guard let number = Int64(text) else { throw ToolFormError(message: "\(field.name) must be a whole number.") }
                arguments[field.name] = .int(number)
            case .number:
                guard let number = Double(text), number.isFinite else { throw ToolFormError(message: "\(field.name) must be a number.") }
                arguments[field.name] = number.rounded() == number && abs(number) < 9e15 ? .int(Int64(number)) : .double(number)
            case .json:
                guard let value = try? JSONValue.parse(text) else { throw ToolFormError(message: "\(field.name) must be valid JSON.") }
                arguments[field.name] = value
            case .boolean:
                break
            }
        }
        return .object(arguments)
    }

    /// For a tool whose schema is not known: the whole arguments object typed as JSON.
    public static func rawArguments(_ text: String) throws -> JSONValue {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return .object([:]) }
        guard let value = try? JSONValue.parse(trimmed), value.objectValue != nil else {
            throw ToolFormError(message: "The arguments must be a JSON object, for example {\"query\": \"milk\"}.")
        }
        return value
    }
}

public struct ToolCallResult: Sendable, Equatable {
    public enum Content: Sendable, Equatable {
        case text(String)
        /// Something that is not text, by its type ("image", "resource"…).
        case other(String)
    }

    public var content: [Content]
    public var isError: Bool
    public var milliseconds: Int

    public init(content: [Content], isError: Bool, milliseconds: Int) {
        self.content = content
        self.isError = isError
        self.milliseconds = milliseconds
    }

    /// The result as text to read: JSON is laid out, everything else is shown as it came.
    public var displayText: String {
        content.map { item -> String in
            switch item {
            case .text(let text): return ToolCallResult.prettified(text)
            case .other(let type): return "[\(type) content, not shown]"
            }
        }.joined(separator: "\n\n")
    }

    static func prettified(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = trimmed.first, first == "{" || first == "[",
              let value = try? JSONValue.parse(trimmed) else { return text }
        return value.serialized(pretty: true).trimmingCharacters(in: .newlines)
    }
}

public enum ToolRunOutcome: Sendable, Equatable {
    case finished(ToolCallResult)
    case failed(String)
}

/// Calls one tool of one server on this Mac through `<node> <cli.mjs> call`, outside the bridge.
/// The result goes back to the caller and nowhere else.
public struct ToolRunner: Sendable {
    public var nodePath: String
    public var cliPath: String
    /// The daemon gives up after 60 s; this is the outer guard.
    public var timeout: TimeInterval
    public var environment: [String: String]?

    public init(nodePath: String, cliPath: String, timeout: TimeInterval = 65, environment: [String: String]? = nil) {
        self.nodePath = nodePath
        self.cliPath = cliPath
        self.timeout = timeout
        self.environment = environment
    }

    public func call(server: ServerConfig, tool: String, arguments: JSONValue) async -> ToolRunOutcome {
        let request: JSONValue = .object(["server": server.json, "tool": .string(tool), "arguments": arguments])
        let output = await ProcessRunner.run(
            executable: nodePath, arguments: [cliPath, "call"], environment: environment,
            stdin: Data(request.serialized(pretty: false).utf8), timeout: timeout)
        if let launchError = output.launchError { return .failed(launchError) }
        if output.timedOut { return .failed("The tool did not answer within \(Int(timeout)) seconds.") }
        if let parsed = ToolRunner.parse(output.stdout) { return parsed }
        if let status = output.status, status != 0 {
            return .failed("The bridge agent could not run the tool (status \(status)). This app may be newer than its agent.")
        }
        return .failed("The answer could not be read.")
    }

    /// The last line of stdout that is a call result. nil if there is none.
    public static func parse(_ stdout: Data) -> ToolRunOutcome? {
        let text = String(decoding: stdout, as: UTF8.self)
        for line in text.split(whereSeparator: \.isNewline).reversed() {
            guard let object = (try? JSONValue.parse(String(line)))?.objectValue, let ok = object["ok"]?.boolValue else { continue }
            if !ok { return .failed(object["error"]?.stringValue ?? "The tool could not be run.") }
            guard let result = object["result"]?.objectValue else { return nil }
            var content: [ToolCallResult.Content] = []
            for item in result["content"]?.arrayValue ?? [] {
                guard let fields = item.objectValue else { continue }
                if fields["type"]?.stringValue == "text", let text = fields["text"]?.stringValue {
                    content.append(.text(text))
                } else {
                    content.append(.other(fields["type"]?.stringValue ?? "unknown"))
                }
            }
            var ms = 0
            if case .int(let i)? = object["ms"] { ms = Int(i) }
            if case .double(let d)? = object["ms"] { ms = Int(d) }
            return .finished(ToolCallResult(content: content, isError: result["isError"]?.boolValue ?? false, milliseconds: ms))
        }
        return nil
    }
}
