import Foundation

/// The daemon's `status.json` (spec section 5). Every field is optional on read so an older or
/// newer daemon does not make the app show nothing.
public struct BridgeStatus: Sendable, Equatable, Decodable {
    public struct Connection: Sendable, Equatable, Decodable {
        public var state: String?
        public var since: Double?
        public var lastError: String?
    }

    public struct Tool: Sendable, Equatable, Decodable {
        public var name: String
        public var access: String?
    }

    public struct Server: Sendable, Equatable, Decodable {
        public var name: String
        public var title: String?
        public var status: String?
        public var error: String?
        public var tools: [Tool]?
    }

    public struct Calls: Sendable, Equatable, Decodable {
        public var total: Int?
        public var failed: Int?
        public var lastAt: Double?
        public var lastTool: String?
        public var lastOutcome: String?
    }

    public var pid: Int32?
    public var version: String?
    public var machine: String?
    public var account: String?
    public var updatedAt: Double?
    public var connection: Connection?
    public var servers: [Server]?
    public var calls: Calls?

    public func server(named name: String) -> Server? {
        servers?.first { $0.name == name }
    }
}

public enum ConnectionState: String, Sendable, Equatable {
    case connecting
    case connected
    case offline
}

public enum StatusSnapshot: Sendable, Equatable {
    /// No live daemon. `lastKnown` is what the file said, if there is one: a daemon that exits
    /// because it has no account leaves its reason behind.
    case notRunning(lastKnown: BridgeStatus?)
    case running(BridgeStatus)

    public var status: BridgeStatus? {
        if case .running(let s) = self { return s }
        return nil
    }

    public var isRunning: Bool { status != nil }

    public var connectionState: ConnectionState {
        guard let raw = status?.connection?.state else { return .offline }
        return ConnectionState(rawValue: raw) ?? .offline
    }

    /// The last error the daemon recorded, read before the liveness rule is applied.
    public var lastError: String? {
        switch self {
        case .running(let s): return s.connection?.lastError
        case .notRunning(let last): return last?.connection?.lastError
        }
    }

    /// When the file that carries `lastError` was written.
    public var lastUpdated: Date? {
        let raw: Double?
        switch self {
        case .running(let s): raw = s.updatedAt
        case .notRunning(let last): raw = last?.updatedAt
        }
        return raw.map { Date(timeIntervalSince1970: $0 / 1000) }
    }

    /// The cloud does not accept this Mac for the account: the app registers it again.
    public var needsRegistration: Bool {
        lastError == "auth_refused" || lastError == "no_account"
    }
}

public struct StatusReader: Sendable {
    public static let staleAfter: TimeInterval = 45

    public var url: URL
    public var now: @Sendable () -> Date
    public var isAlive: @Sendable (Int32) -> Bool

    public init(
        url: URL,
        now: @escaping @Sendable () -> Date = { Date() },
        isAlive: @escaping @Sendable (Int32) -> Bool = { ProcessProbe.isAlive(pid: $0) }
    ) {
        self.url = url
        self.now = now
        self.isAlive = isAlive
    }

    /// A missing, unreadable or stale file, or one whose pid is gone, means "not running".
    public func read() -> StatusSnapshot {
        guard let data = try? Data(contentsOf: url),
              let status = try? JSONDecoder().decode(BridgeStatus.self, from: data) else {
            return .notRunning(lastKnown: nil)
        }
        guard let updatedAt = status.updatedAt, let pid = status.pid else {
            return .notRunning(lastKnown: status)
        }
        let age = now().timeIntervalSince1970 - updatedAt / 1000
        guard age <= StatusReader.staleAfter, isAlive(pid) else { return .notRunning(lastKnown: status) }
        return .running(status)
    }
}
