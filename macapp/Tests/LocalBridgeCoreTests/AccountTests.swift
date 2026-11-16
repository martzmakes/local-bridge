import XCTest
@testable import LocalBridgeCore

/// Answers requests from a script and records what was asked.
final class FakeTransport: HTTPTransport, @unchecked Sendable {
    struct Recorded {
        var method: String
        var path: String
        var authorization: String?
        var contentType: String?
        var body: String
    }

    private let lock = NSLock()
    private var recorded: [Recorded] = []
    var handler: @Sendable (Recorded) -> (Int, String) = { _ in (500, "{}") }

    var requests: [Recorded] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let record = Recorded(
            method: request.httpMethod ?? "GET",
            path: request.url!.path,
            authorization: request.value(forHTTPHeaderField: "Authorization"),
            contentType: request.value(forHTTPHeaderField: "Content-Type"),
            body: String(decoding: request.httpBody ?? Data(), as: UTF8.self))
        lock.withLock { recorded.append(record) }
        let (status, body) = handler(record)
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
}

final class Clock: @unchecked Sendable {
    private let lock = NSLock()
    private var current = Date(timeIntervalSince1970: 1_800_000_000)
    var now: Date {
        lock.lock()
        defer { lock.unlock() }
        return current
    }
    func advance(_ seconds: TimeInterval) {
        lock.lock()
        current.addTimeInterval(seconds)
        lock.unlock()
    }
}

final class AccountTests: XCTestCase {
    let base = "https://bridge.example"

    func makeClient(_ transport: FakeTransport, tokens: InMemoryTokenStore = InMemoryTokenStore(),
                    ids: InMemoryClientIDStore = InMemoryClientIDStore(), clock: Clock = Clock()) -> AccountClient {
        AccountClient(publicBase: base + "/", transport: transport, tokens: tokens, clientIDs: ids, now: { clock.now })
    }

    func testPKCEKnownVector() {
        // RFC 7636, appendix B.
        XCTAssertEqual(PKCE.challenge(for: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
        let a = PKCE.randomToken(), b = PKCE.randomToken()
        XCTAssertNotEqual(a, b)
        XCTAssertGreaterThanOrEqual(a.count, 43)
        XCTAssertNil(a.rangeOfCharacter(from: CharacterSet(charactersIn: "+/=")))
    }

    func testRegistersOnceAndKeepsTheClientID() async throws {
        let transport = FakeTransport()
        transport.handler = { _ in (201, #"{"client_id":"client-1"}"#) }
        let ids = InMemoryClientIDStore()
        let client = makeClient(transport, ids: ids)
        let first = try await client.clientID()
        let second = try await client.clientID()
        XCTAssertEqual(first, "client-1")
        XCTAssertEqual(second, "client-1")
        XCTAssertEqual(transport.requests.count, 1)
        let request = transport.requests[0]
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.path, "/oauth/register")
        XCTAssertEqual(request.contentType, "application/json")
        XCTAssertEqual(try JSONValue.parse(request.body), .object([
            "client_name": .string("Local Bridge for Mac"),
            "redirect_uris": .array([.string("localbridge://oauth/callback")]),
        ]))
        XCTAssertEqual(ids.clientID(for: base), "client-1", "kept per public base")
    }

    func testAuthorizeURL() throws {
        let session = try AccountClient.makeSession(publicBase: base, clientID: "client-1", state: "st4te", codeVerifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        let components = try XCTUnwrap(URLComponents(url: session.authorizeURL, resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.scheme, "https")
        XCTAssertEqual(components.host, "bridge.example")
        XCTAssertEqual(components.path, "/oauth/authorize")
        let query = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(query, [
            "response_type": "code",
            "client_id": "client-1",
            "redirect_uri": "localbridge://oauth/callback",
            "code_challenge": "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
            "code_challenge_method": "S256",
            "state": "st4te",
            "scope": "mcp:read mcp:tools",
            "resource": "https://bridge.example/mcp",
        ])
    }

    func signedInClient(_ transport: FakeTransport, tokens: InMemoryTokenStore, clock: Clock) async throws -> AccountClient {
        let ids = InMemoryClientIDStore()
        ids.setClientID("client-1", for: base)
        let client = makeClient(transport, tokens: tokens, ids: ids, clock: clock)
        let session = try AccountClient.makeSession(publicBase: base, clientID: "client-1", state: "s1", codeVerifier: "verifier")
        try await client.completeSignIn(callback: URL(string: "localbridge://oauth/callback?code=the%20code&state=s1")!, session: session)
        return client
    }

    func testCodeExchangeStoresTokens() async throws {
        let transport = FakeTransport()
        transport.handler = { _ in (200, #"{"access_token":"a1","refresh_token":"r1","expires_in":3600,"token_type":"Bearer","scope":"mcp:read mcp:tools"}"#) }
        let tokens = InMemoryTokenStore()
        let clock = Clock()
        let client = try await signedInClient(transport, tokens: tokens, clock: clock)
        XCTAssertTrue(client.isSignedIn)
        XCTAssertEqual(try tokens.load(account: base), TokenSet(accessToken: "a1", refreshToken: "r1", expiresAt: clock.now.addingTimeInterval(3600)))
        let request = transport.requests[0]
        XCTAssertEqual(request.path, "/oauth/token")
        XCTAssertEqual(request.contentType, "application/x-www-form-urlencoded")
        XCTAssertEqual(request.body, "grant_type=authorization_code&code=the%20code&code_verifier=verifier&client_id=client-1&redirect_uri=localbridge%3A%2F%2Foauth%2Fcallback")
    }

    func testStateMismatchAndDeniedAreRefusedBeforeAnyRequest() async throws {
        let transport = FakeTransport()
        let tokens = InMemoryTokenStore()
        let client = makeClient(transport, tokens: tokens)
        let session = try AccountClient.makeSession(publicBase: base, clientID: "c", state: "expected", codeVerifier: "v")
        for (url, expected) in [
            ("localbridge://oauth/callback?code=x&state=other", AccountError.stateMismatch),
            ("localbridge://oauth/callback?code=x", .stateMismatch),
            ("localbridge://elsewhere/callback?code=x&state=expected", .stateMismatch),
            ("localbridge://oauth/callback?error=access_denied&state=expected", .authorizationDenied("access_denied")),
        ] {
            do {
                try await client.completeSignIn(callback: URL(string: url)!, session: session)
                XCTFail("accepted \(url)")
            } catch {
                XCTAssertEqual(error as? AccountError, expected)
            }
        }
        XCTAssertEqual(transport.requests.count, 0)
        XCTAssertFalse(client.isSignedIn)
    }

    func testRefreshRotatesAndIsProactive() async throws {
        let transport = FakeTransport()
        transport.handler = { request in
            if request.path == "/oauth/token" {
                if request.body.contains("grant_type=authorization_code") {
                    return (200, #"{"access_token":"a1","refresh_token":"r1","expires_in":3600}"#)
                }
                if request.body == "grant_type=refresh_token&refresh_token=r1&client_id=client-1" {
                    return (200, #"{"access_token":"a2","refresh_token":"r2","expires_in":3600}"#)
                }
                if request.body == "grant_type=refresh_token&refresh_token=r2&client_id=client-1" {
                    return (200, #"{"access_token":"a3","refresh_token":"r3","expires_in":3600}"#)
                }
                return (400, #"{"error":"invalid_grant","error_description":"refresh token already used"}"#)
            }
            return (200, #"{"email":"m@example.com","uid":"0123456789abcdef0123"}"#)
        }
        let tokens = InMemoryTokenStore()
        let clock = Clock()
        let client = try await signedInClient(transport, tokens: tokens, clock: clock)

        // Plenty of time left: the stored token is used as is.
        _ = try await client.me()
        XCTAssertEqual(transport.requests.last?.authorization, "Bearer a1")
        XCTAssertEqual(transport.requests.count, 2)

        // Inside five minutes of expiry: refresh first, and keep the rotated refresh token.
        clock.advance(3600 - 299)
        let identity = try await client.me()
        XCTAssertEqual(identity, AccountIdentity(email: "m@example.com", uid: "0123456789abcdef0123"))
        XCTAssertEqual(transport.requests.last?.authorization, "Bearer a2")
        XCTAssertEqual(try tokens.load(account: base)?.refreshToken, "r2")

        // The next refresh spends r2, never r1 again.
        clock.advance(3600)
        _ = try await client.me()
        XCTAssertEqual(transport.requests.last?.authorization, "Bearer a3")
        XCTAssertEqual(try tokens.load(account: base)?.refreshToken, "r3")
        XCTAssertEqual(transport.requests.filter { $0.body.contains("refresh_token=r1") }.count, 1)
    }

    func testA401IsRetriedOnceAfterARefresh() async throws {
        let transport = FakeTransport()
        transport.handler = { request in
            if request.path == "/oauth/token" {
                return request.body.contains("authorization_code")
                    ? (200, #"{"access_token":"a1","refresh_token":"r1","expires_in":3600}"#)
                    : (200, #"{"access_token":"a2","refresh_token":"r2","expires_in":3600}"#)
            }
            return request.authorization == "Bearer a2"
                ? (200, #"{"machines":[]}"#)
                : (401, #"{"error":"unauthorized","message":"token revoked"}"#)
        }
        let tokens = InMemoryTokenStore()
        let client = try await signedInClient(transport, tokens: tokens, clock: Clock())
        let machines = try await client.machines()
        XCTAssertEqual(machines, [])
        XCTAssertEqual(transport.requests.map(\.path), ["/oauth/token", "/api/machines", "/oauth/token", "/api/machines"])
        XCTAssertEqual(try tokens.load(account: base)?.refreshToken, "r2")
    }

    func testASecond401IsNotRetriedForever() async throws {
        let transport = FakeTransport()
        transport.handler = { request in
            request.path == "/oauth/token"
                ? (200, #"{"access_token":"a","refresh_token":"r","expires_in":3600}"#)
                : (401, #"{"error":"unauthorized","message":"no"}"#)
        }
        let client = try await signedInClient(transport, tokens: InMemoryTokenStore(), clock: Clock())
        do {
            _ = try await client.me()
            XCTFail()
        } catch {
            XCTAssertEqual(error as? AccountError, .server(status: 401, code: "unauthorized", message: "no"))
        }
        XCTAssertEqual(transport.requests.filter { $0.path == "/api/me" }.count, 2)
    }

    func testARefusedRefreshTokenSignsOut() async throws {
        let transport = FakeTransport()
        transport.handler = { request in
            if request.path == "/oauth/token", request.body.contains("authorization_code") {
                return (200, #"{"access_token":"a1","refresh_token":"r1","expires_in":60}"#)
            }
            return (400, #"{"error":"invalid_grant","error_description":"expired"}"#)
        }
        let tokens = InMemoryTokenStore()
        let client = try await signedInClient(transport, tokens: tokens, clock: Clock())
        do {
            _ = try await client.me()
            XCTFail()
        } catch {
            XCTAssertEqual(error as? AccountError, .notSignedIn)
        }
        XCTAssertNil(try tokens.load(account: base))
        XCTAssertFalse(client.isSignedIn)
    }

    func testNotSignedInMakesNoRequest() async {
        let transport = FakeTransport()
        let client = makeClient(transport)
        do {
            _ = try await client.me()
            XCTFail()
        } catch {
            XCTAssertEqual(error as? AccountError, .notSignedIn)
        }
        XCTAssertEqual(transport.requests.count, 0)
    }

    func testMachinesDecodeRegisterAndRemove() async throws {
        let transport = FakeTransport()
        transport.handler = { request in
            switch (request.method, request.path) {
            case ("POST", "/oauth/token"):
                return (200, #"{"access_token":"a1","refresh_token":"r1","expires_in":3600}"#)
            case ("GET", "/api/machines"):
                return (200, """
                {"machines":[
                  {"machine":"mini","enabled":true,"connected":true,"lastSeen":1731700000000,"agentVersion":"0.2.0","kids":["k1"],
                   "servers":[{"name":"notes","title":"Apple Notes","status":"up","tools":4},{"name":"ha","title":null,"status":"down","tools":0}]},
                  {"machine":"air","enabled":true,"connected":false,"lastSeen":"2026-11-15T21:07:03.000Z","kids":[],"servers":[]},
                  {"machine":"old"}
                ]}
                """)
            case ("PUT", "/api/machines/mini"):
                return (200, #"{"uid":"0123456789abcdef0123","machine":"mini","kid":"k2"}"#)
            case ("PUT", _):
                return (409, #"{"error":"machine_limit","message":"This account already has 10 machines."}"#)
            case ("DELETE", "/api/machines/air"):
                return (200, "{}")
            default:
                return (404, #"{"error":"not_found","message":"No such machine."}"#)
            }
        }
        let client = try await signedInClient(transport, tokens: InMemoryTokenStore(), clock: Clock())

        let machines = try await client.machines()
        XCTAssertEqual(machines.map(\.machine), ["mini", "air", "old"])
        XCTAssertEqual(machines[0].connected, true)
        XCTAssertEqual(machines[0].lastSeen, Date(timeIntervalSince1970: 1_731_700_000))
        XCTAssertEqual(machines[0].servers?.map(\.tools), [4, 0])
        XCTAssertNil(machines[0].servers?[1].title)
        XCTAssertNotNil(machines[1].lastSeen)
        XCTAssertNil(machines[2].lastSeen)

        let key = try XCTUnwrap(DevicePublicKey.parse(cliOutput: #"{"kty":"OKP","crv":"Ed25519","x":"abc","kid":"k2"}"# + "\n"))
        let registration = try await client.registerMachine("mini", key: key)
        XCTAssertEqual(registration, MachineRegistration(uid: "0123456789abcdef0123", machine: "mini", kid: "k2"))
        let put = try XCTUnwrap(transport.requests.last)
        XCTAssertEqual(put.authorization, "Bearer a1")
        XCTAssertEqual(try JSONValue.parse(put.body), .object(["jwk": .object(["kty": .string("OKP"), "crv": .string("Ed25519"), "x": .string("abc")])]))

        do {
            _ = try await client.registerMachine("eleventh", key: key)
            XCTFail()
        } catch {
            XCTAssertEqual(error as? AccountError, .server(status: 409, code: "machine_limit", message: "This account already has 10 machines."))
            XCTAssertEqual((error as? AccountError)?.errorDescription, "This account already has 10 machines.")
        }

        try await client.removeMachine("air")
        XCTAssertEqual(transport.requests.last?.method, "DELETE")
        do {
            try await client.removeMachine("ghost")
            XCTFail()
        } catch {
            XCTAssertEqual(error as? AccountError, .server(status: 404, code: "not_found", message: "No such machine."))
        }
    }

    func testSignOutDeletesTokens() async throws {
        let transport = FakeTransport()
        transport.handler = { _ in (200, #"{"access_token":"a1","refresh_token":"r1","expires_in":3600}"#) }
        let tokens = InMemoryTokenStore()
        let client = try await signedInClient(transport, tokens: tokens, clock: Clock())
        await client.signOut()
        XCTAssertNil(try tokens.load(account: base))
        XCTAssertFalse(client.isSignedIn)
    }

    func testPubkeyParsing() {
        XCTAssertNil(DevicePublicKey.parse(cliOutput: "No device key for \"mini\". Run: local-bridge-agent init\n"))
        XCTAssertEqual(DevicePublicKey.parse(cliOutput: "{\"kty\":\"OKP\",\"crv\":\"Ed25519\",\"x\":\"xx\",\"kid\":\"k\"}\npending rotation key: {...}\n"),
                       DevicePublicKey(kty: "OKP", crv: "Ed25519", x: "xx", kid: "k"))
    }

    func testCallbackRecognition() {
        XCTAssertTrue(AccountClient.isCallback(URL(string: "localbridge://oauth/callback?code=1&state=2")!))
        XCTAssertFalse(AccountClient.isCallback(URL(string: "localbridge://other/callback")!))
        XCTAssertFalse(AccountClient.isCallback(URL(string: "https://oauth/callback")!))
    }
}
