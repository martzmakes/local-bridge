import CryptoKit
import Foundation

// MARK: - Plumbing that tests replace

public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionTransport: HTTPTransport {
    public init() {}

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw AccountError.invalidResponse }
        return (data, http)
    }
}

public struct TokenSet: Sendable, Equatable, Codable {
    public var accessToken: String
    public var refreshToken: String
    public var expiresAt: Date

    public init(accessToken: String, refreshToken: String, expiresAt: Date) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.expiresAt = expiresAt
    }
}

/// Where the account tokens are kept, one entry per public base.
public protocol TokenStore: Sendable {
    func load(account: String) throws -> TokenSet?
    func save(_ tokens: TokenSet, account: String) throws
    func delete(account: String) throws
}

public final class InMemoryTokenStore: TokenStore, @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String: TokenSet] = [:]
    public private(set) var saveCount = 0

    public init() {}

    public func load(account: String) throws -> TokenSet? {
        lock.lock()
        defer { lock.unlock() }
        return items[account]
    }

    public func save(_ tokens: TokenSet, account: String) throws {
        lock.lock()
        defer { lock.unlock() }
        items[account] = tokens
        saveCount += 1
    }

    public func delete(account: String) throws {
        lock.lock()
        defer { lock.unlock() }
        items[account] = nil
    }
}

/// Remembers the OAuth client id the bridge issued, per public base.
public protocol ClientIDStore: Sendable {
    func clientID(for publicBase: String) -> String?
    func setClientID(_ id: String?, for publicBase: String)
}

public final class InMemoryClientIDStore: ClientIDStore, @unchecked Sendable {
    private let lock = NSLock()
    private var ids: [String: String] = [:]

    public init() {}

    public func clientID(for publicBase: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return ids[publicBase]
    }

    public func setClientID(_ id: String?, for publicBase: String) {
        lock.lock()
        defer { lock.unlock() }
        ids[publicBase] = id
    }
}

public struct UserDefaultsClientIDStore: ClientIDStore, @unchecked Sendable {
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    private func key(_ base: String) -> String { "oauthClientID:\(base)" }

    public func clientID(for publicBase: String) -> String? {
        defaults.string(forKey: key(publicBase))
    }

    public func setClientID(_ id: String?, for publicBase: String) {
        defaults.set(id, forKey: key(publicBase))
    }
}

// MARK: - Errors and models

public enum AccountError: Error, Equatable, Sendable, LocalizedError {
    case notSignedIn
    case stateMismatch
    case authorizationDenied(String)
    case invalidResponse
    case network(String)
    /// An error the bridge answered with: HTTP status, its code, its message.
    case server(status: Int, code: String, message: String)

    public var errorDescription: String? {
        switch self {
        case .notSignedIn: return "You are not signed in."
        case .stateMismatch: return "The sign-in answer did not match the request this app made. Try signing in again."
        case .authorizationDenied(let reason): return "Sign-in was not completed (\(reason))."
        case .invalidResponse: return "The bridge sent an answer this app could not read."
        case .network(let message): return "The bridge could not be reached: \(message)"
        case .server(_, let code, let message): return message.isEmpty ? "The bridge refused the request (\(code))." : message
        }
    }
}

public struct AccountIdentity: Sendable, Equatable, Decodable {
    public var email: String
    public var uid: String

    public init(email: String, uid: String) {
        self.email = email
        self.uid = uid
    }
}

public struct AccountMachine: Sendable, Equatable, Decodable, Identifiable {
    public struct Server: Sendable, Equatable, Decodable {
        public var name: String
        public var title: String?
        public var status: String?
        public var tools: Int?
    }

    public var machine: String
    public var enabled: Bool?
    public var connected: Bool?
    public var lastSeen: Date?
    public var agentVersion: String?
    public var kids: [String]?
    public var servers: [Server]?

    public var id: String { machine }

    enum CodingKeys: String, CodingKey {
        case machine, enabled, connected, lastSeen, agentVersion, kids, servers
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        machine = try c.decode(String.self, forKey: .machine)
        enabled = try? c.decodeIfPresent(Bool.self, forKey: .enabled)
        connected = try? c.decodeIfPresent(Bool.self, forKey: .connected)
        agentVersion = try? c.decodeIfPresent(String.self, forKey: .agentVersion)
        kids = try? c.decodeIfPresent([String].self, forKey: .kids)
        servers = try? c.decodeIfPresent([Server].self, forKey: .servers)
        // Epoch milliseconds, epoch seconds or an ISO date: the spec does not pin it down.
        if let number = try? c.decodeIfPresent(Double.self, forKey: .lastSeen) {
            lastSeen = Date(timeIntervalSince1970: number > 100_000_000_000 ? number / 1000 : number)
        } else if let text = try? c.decodeIfPresent(String.self, forKey: .lastSeen) {
            lastSeen = ActivityParser.parseTimestamp(text)
        } else {
            lastSeen = nil
        }
    }
}

public struct MachineRegistration: Sendable, Equatable, Decodable {
    public var uid: String
    public var machine: String
    public var kid: String?
}

/// The public half of the device key, as `cli.mjs pubkey` prints it.
public struct DevicePublicKey: Sendable, Equatable {
    public var kty: String
    public var crv: String
    public var x: String
    public var kid: String?

    public init(kty: String, crv: String, x: String, kid: String? = nil) {
        self.kty = kty
        self.crv = crv
        self.x = x
        self.kid = kid
    }

    /// The first line of `pubkey` output that is a JWK. nil when there is no key.
    public static func parse(cliOutput: String) -> DevicePublicKey? {
        for line in cliOutput.split(whereSeparator: \.isNewline) {
            guard line.hasPrefix("{"), let o = (try? JSONValue.parse(String(line)))?.objectValue,
                  let kty = o["kty"]?.stringValue, let crv = o["crv"]?.stringValue,
                  let x = o["x"]?.stringValue, !x.isEmpty else { continue }
            return DevicePublicKey(kty: kty, crv: crv, x: x, kid: o["kid"]?.stringValue)
        }
        return nil
    }
}

// MARK: - PKCE

public enum PKCE {
    public static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func randomToken(bytes: Int = 32) -> String {
        var generator = SystemRandomNumberGenerator()
        let data = Data((0..<bytes).map { _ in UInt8.random(in: 0...255, using: &generator) })
        return base64URL(data)
    }

    /// The S256 code challenge for a verifier (RFC 7636 section 4.2).
    public static func challenge(for verifier: String) -> String {
        base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
    }
}

/// One sign-in attempt: what the app must remember between opening the browser and the callback.
public struct AuthSession: Sendable, Equatable {
    public var authorizeURL: URL
    public var state: String
    public var codeVerifier: String
    public var clientID: String
}

// MARK: - Client

public actor AccountClient {
    public static let redirectURI = "localbridge://oauth/callback"
    public static let clientName = "Local Bridge for Mac"
    public static let scope = "mcp:read mcp:tools"
    public static let keychainService = "com.martzmakes.localbridge.account"
    /// Refresh when the access token has less than this left.
    public static let refreshMargin: TimeInterval = 5 * 60

    public nonisolated let publicBase: String
    private let transport: HTTPTransport
    private let tokens: TokenStore
    private let clientIDs: ClientIDStore
    private let now: @Sendable () -> Date
    private var refreshTask: Task<TokenSet, Error>?

    public init(
        publicBase: String,
        transport: HTTPTransport = URLSessionTransport(),
        tokens: TokenStore,
        clientIDs: ClientIDStore,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        var base = publicBase.trimmingCharacters(in: .whitespaces)
        while base.hasSuffix("/") { base.removeLast() }
        self.publicBase = base
        self.transport = transport
        self.tokens = tokens
        self.clientIDs = clientIDs
        self.now = now
    }

    public nonisolated var isSignedIn: Bool {
        ((try? tokens.load(account: publicBase)) ?? nil) != nil
    }

    // MARK: Sign-in

    /// The client id for this app at this bridge, registering once if there is none.
    public func clientID() async throws -> String {
        if let existing = clientIDs.clientID(for: publicBase) { return existing }
        var request = try self.request("POST", "/oauth/register")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: JSONValue = .object([
            "client_name": .string(Self.clientName),
            "redirect_uris": .array([.string(Self.redirectURI)]),
        ])
        request.httpBody = Data(body.serialized(pretty: false).utf8)
        let data = try await sendChecked(request)
        guard let id = (try? JSONValue.parse(data))?.objectValue?["client_id"]?.stringValue, !id.isEmpty else {
            throw AccountError.invalidResponse
        }
        clientIDs.setClientID(id, for: publicBase)
        return id
    }

    public func beginSignIn() async throws -> AuthSession {
        let id = try await clientID()
        let verifier = PKCE.randomToken(bytes: 32)
        let state = PKCE.randomToken(bytes: 16)
        return try Self.makeSession(publicBase: publicBase, clientID: id, state: state, codeVerifier: verifier)
    }

    public static func makeSession(publicBase: String, clientID: String, state: String, codeVerifier: String) throws -> AuthSession {
        guard var components = URLComponents(string: publicBase + "/oauth/authorize") else {
            throw AccountError.invalidResponse
        }
        components.queryItems = [
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "client_id", value: clientID),
            URLQueryItem(name: "redirect_uri", value: redirectURI),
            URLQueryItem(name: "code_challenge", value: PKCE.challenge(for: codeVerifier)),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "scope", value: scope),
            URLQueryItem(name: "resource", value: publicBase + "/mcp"),
        ]
        guard let url = components.url else { throw AccountError.invalidResponse }
        return AuthSession(authorizeURL: url, state: state, codeVerifier: codeVerifier, clientID: clientID)
    }

    /// True for a URL that is this app's OAuth callback.
    public static func isCallback(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "localbridge" && url.host == "oauth" && url.path == "/callback"
    }

    /// Checks `state`, exchanges the code and stores the tokens.
    public func completeSignIn(callback url: URL, session: AuthSession) async throws {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func value(_ name: String) -> String? { items.first { $0.name == name }?.value }
        guard Self.isCallback(url), let state = value("state"), state == session.state else {
            throw AccountError.stateMismatch
        }
        if let error = value("error") { throw AccountError.authorizationDenied(error) }
        guard let code = value("code"), !code.isEmpty else { throw AccountError.invalidResponse }
        let set = try await tokenRequest([
            ("grant_type", "authorization_code"),
            ("code", code),
            ("code_verifier", session.codeVerifier),
            ("client_id", session.clientID),
            ("redirect_uri", Self.redirectURI),
        ], previousRefreshToken: nil)
        try tokens.save(set, account: publicBase)
    }

    public func signOut() {
        refreshTask?.cancel()
        refreshTask = nil
        try? tokens.delete(account: publicBase)
    }

    // MARK: Tokens

    private func tokenRequest(_ fields: [(String, String)], previousRefreshToken: String?) async throws -> TokenSet {
        var request = try self.request("POST", "/oauth/token")
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data(Self.formEncode(fields).utf8)
        let data = try await sendChecked(request)
        guard let o = (try? JSONValue.parse(data))?.objectValue, let access = o["access_token"]?.stringValue, !access.isEmpty else {
            throw AccountError.invalidResponse
        }
        var lifetime: TimeInterval = 3600
        if case .int(let i)? = o["expires_in"] { lifetime = TimeInterval(i) }
        if case .double(let d)? = o["expires_in"] { lifetime = d }
        // Refresh tokens rotate: the one in the answer replaces the one just used.
        guard let refresh = o["refresh_token"]?.stringValue ?? previousRefreshToken else { throw AccountError.invalidResponse }
        return TokenSet(accessToken: access, refreshToken: refresh, expiresAt: now().addingTimeInterval(lifetime))
    }

    static func formEncode(_ fields: [(String, String)]) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return fields.map { key, value in
            "\(key)=\(value.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")"
        }.joined(separator: "&")
    }

    /// One refresh at a time: a rotated refresh token must never be spent twice.
    private func refresh() async throws -> TokenSet {
        if let running = refreshTask { return try await running.value }
        guard let current = try tokens.load(account: publicBase) else { throw AccountError.notSignedIn }
        let task = Task { () throws -> TokenSet in
            let id = try await self.clientID()
            let set = try await self.tokenRequest([
                ("grant_type", "refresh_token"),
                ("refresh_token", current.refreshToken),
                ("client_id", id),
            ], previousRefreshToken: current.refreshToken)
            try self.tokens.save(set, account: self.publicBase)
            return set
        }
        refreshTask = task
        defer { refreshTask = nil }
        do {
            return try await task.value
        } catch let error as AccountError {
            // The refresh token itself was refused: the sign-in is over.
            if case .server(let status, _, _) = error, status == 400 || status == 401 {
                try? tokens.delete(account: publicBase)
                throw AccountError.notSignedIn
            }
            throw error
        }
    }

    private func accessToken() async throws -> String {
        guard let current = try tokens.load(account: publicBase) else { throw AccountError.notSignedIn }
        if current.expiresAt.timeIntervalSince(now()) > Self.refreshMargin { return current.accessToken }
        return try await refresh().accessToken
    }

    // MARK: Account API

    public func me() async throws -> AccountIdentity {
        try decode(try await authorized("GET", "/api/me"))
    }

    public func machines() async throws -> [AccountMachine] {
        struct Envelope: Decodable { var machines: [AccountMachine] }
        let envelope: Envelope = try decode(try await authorized("GET", "/api/machines"))
        return envelope.machines
    }

    @discardableResult
    public func registerMachine(_ machine: String, key: DevicePublicKey) async throws -> MachineRegistration {
        let body: JSONValue = .object(["jwk": .object([
            "kty": .string(key.kty), "crv": .string(key.crv), "x": .string(key.x),
        ])])
        return try decode(try await authorized("PUT", "/api/machines/\(machine)", json: body))
    }

    public func removeMachine(_ machine: String) async throws {
        _ = try await authorized("DELETE", "/api/machines/\(machine)")
    }

    private func decode<T: Decodable>(_ data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw AccountError.invalidResponse
        }
    }

    private func authorized(_ method: String, _ path: String, json: JSONValue? = nil) async throws -> Data {
        var request = try self.request(method, path)
        if let json {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = Data(json.serialized(pretty: false).utf8)
        }
        request.setValue("Bearer \(try await accessToken())", forHTTPHeaderField: "Authorization")
        do {
            return try await sendChecked(request)
        } catch AccountError.server(let status, _, _) where status == 401 {
            // Once: the token may have been revoked or the clock may be off.
            request.setValue("Bearer \(try await refresh().accessToken)", forHTTPHeaderField: "Authorization")
            return try await sendChecked(request)
        }
    }

    private func request(_ method: String, _ path: String) throws -> URLRequest {
        guard let url = URL(string: publicBase + path) else { throw AccountError.invalidResponse }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }

    private func sendChecked(_ request: URLRequest) async throws -> Data {
        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await transport.send(request)
        } catch let error as AccountError {
            throw error
        } catch {
            throw AccountError.network((error as? URLError)?.localizedDescription ?? "no connection")
        }
        guard (200..<300).contains(response.statusCode) else {
            let o = (try? JSONValue.parse(data))?.objectValue
            throw AccountError.server(
                status: response.statusCode,
                code: o?["error"]?.stringValue ?? "http_\(response.statusCode)",
                message: o?["message"]?.stringValue ?? o?["error_description"]?.stringValue ?? "")
        }
        return data
    }
}
