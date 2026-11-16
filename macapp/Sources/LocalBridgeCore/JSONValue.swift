import Foundation

/// A JSON document held as a value, so keys this app does not know about survive a load and save.
public enum JSONValue: Sendable, Equatable {
    case null
    case bool(Bool)
    case int(Int64)
    case double(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public enum ParseError: Error, Equatable, Sendable {
        case notJSON
    }

    public static func parse(_ data: Data) throws -> JSONValue {
        let any: Any
        do {
            any = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        } catch {
            // The parser's own message can quote file content, which may hold a token.
            throw ParseError.notJSON
        }
        return JSONValue(any: any)
    }

    public static func parse(_ text: String) throws -> JSONValue {
        try parse(Data(text.utf8))
    }

    private init(any: Any) {
        switch any {
        case is NSNull:
            self = .null
        case let number as NSNumber:
            if CFGetTypeID(number) == CFBooleanGetTypeID() {
                self = .bool(number.boolValue)
            } else if CFNumberIsFloatType(number) {
                let d = number.doubleValue
                if d.rounded() == d, abs(d) < 9e15 {
                    self = .int(Int64(d))
                } else {
                    self = .double(d)
                }
            } else {
                self = .int(number.int64Value)
            }
        case let string as String:
            self = .string(string)
        case let array as [Any]:
            self = .array(array.map(JSONValue.init(any:)))
        case let dict as [String: Any]:
            self = .object(dict.mapValues(JSONValue.init(any:)))
        default:
            self = .null
        }
    }

    public var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    public var boolValue: Bool? {
        if case .bool(let b) = self { return b }
        return nil
    }

    public var intValue: Int? {
        if case .int(let i) = self { return Int(exactly: i) }
        return nil
    }

    public var arrayValue: [JSONValue]? {
        if case .array(let a) = self { return a }
        return nil
    }

    public var objectValue: [String: JSONValue]? {
        if case .object(let o) = self { return o }
        return nil
    }

    /// Stable text: keys sorted, two-space indent, one trailing newline when `pretty`.
    public func serialized(pretty: Bool = true) -> String {
        var out = ""
        write(into: &out, pretty: pretty, depth: 0)
        if pretty { out += "\n" }
        return out
    }

    private func write(into out: inout String, pretty: Bool, depth: Int) {
        func pad(_ d: Int) -> String { pretty ? String(repeating: "  ", count: d) : "" }
        let newline = pretty ? "\n" : ""
        switch self {
        case .null:
            out += "null"
        case .bool(let b):
            out += b ? "true" : "false"
        case .int(let i):
            out += String(i)
        case .double(let d):
            out += d.isFinite ? "\(d)" : "null"
        case .string(let s):
            out += JSONValue.quote(s)
        case .array(let items):
            if items.isEmpty {
                out += "[]"
                return
            }
            out += "[" + newline
            for (index, item) in items.enumerated() {
                out += pad(depth + 1)
                item.write(into: &out, pretty: pretty, depth: depth + 1)
                if index < items.count - 1 { out += "," }
                out += newline
            }
            out += pad(depth) + "]"
        case .object(let dict):
            if dict.isEmpty {
                out += "{}"
                return
            }
            out += "{" + newline
            let keys = dict.keys.sorted()
            for (index, key) in keys.enumerated() {
                out += pad(depth + 1) + JSONValue.quote(key) + (pretty ? ": " : ":")
                dict[key]!.write(into: &out, pretty: pretty, depth: depth + 1)
                if index < keys.count - 1 { out += "," }
                out += newline
            }
            out += pad(depth) + "}"
        }
    }

    private static func quote(_ s: String) -> String {
        var out = "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        return out + "\""
    }
}

extension JSONValue: Codable {
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let b = try? c.decode(Bool.self) {
            self = .bool(b)
        } else if let i = try? c.decode(Int64.self) {
            self = .int(i)
        } else if let d = try? c.decode(Double.self) {
            self = .double(d)
        } else if let s = try? c.decode(String.self) {
            self = .string(s)
        } else if let a = try? c.decode([JSONValue].self) {
            self = .array(a)
        } else {
            self = .object(try c.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .int(let i): try c.encode(i)
        case .double(let d): try c.encode(d)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }
}
