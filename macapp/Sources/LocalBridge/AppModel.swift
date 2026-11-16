import AppKit
import LocalBridgeCore
import Observation
import ServiceManagement

enum SidebarItem: Hashable {
    case server(String)
    case activity
}

enum SettingsTab: Hashable {
    case general
    case account
    case permissions
}

enum AccountPhase: Equatable {
    case signedOut
    /// The browser is open; waiting for the `localbridge://` callback.
    case waitingForBrowser
    /// Signed in, and this Mac has no name yet.
    case namingMachine
    case signedIn
}

/// Why the daemon is not being run. Each one has its own banner.
enum Blocker: Equatable {
    case nodeMissing
    case launchAgentLoaded
    case agentMissing(String)
    case otherDaemon(pid: Int32)
}

enum ServerRunState: Equatable {
    case off
    case unsaved
    case up(tools: Int)
    case down(String)
    case unknown
}

struct ToolRow: Identifiable, Equatable {
    var name: String
    var description: String
    var isOn: Bool
    var changesThings: Bool
    /// The last inspection did not list this tool, but the config exposes it.
    var notReported: Bool

    var id: String { name }
}

struct PendingWriteTool: Identifiable, Equatable {
    var server: String
    var tool: String
    var id: String { "\(server).\(tool)" }
}

@MainActor
@Observable
final class AppModel {
    static let shared = AppModel()

    let paths: BridgePaths
    /// Development only: run the daemon without an account, for a local test endpoint.
    let runsWithoutAccount: Bool
    /// Fixed sample state for offscreen snapshots: nothing is started, read or written.
    let isPreview: Bool

    // Config
    private(set) var loadState: ConfigLoadResult = .missing
    private(set) var saved: BridgeConfig?
    var draft = BridgeConfig(machine: "")
    /// Bumped on load, save and revert, so editors with local text state start over.
    private(set) var draftGeneration = 0
    var saveError: String?

    // Navigation
    var selection: SidebarItem?
    var settingsTab: SettingsTab = .general
    var showingAddServer = false

    // Daemon
    private(set) var status: StatusSnapshot = .notRunning(lastKnown: nil)
    private(set) var supervisorState: DaemonSupervisor.State = .stopped
    private(set) var blocker: Blocker?
    private(set) var paused: Bool
    private(set) var nodeOverride: String
    private(set) var resolvedNode: String?
    private(set) var nodeSearched = false
    private(set) var lastDaemonMessage: String?
    private(set) var activity = ActivityBuffer()

    // Tools
    private(set) var inspections = InspectCache()
    private(set) var inspecting: Set<String> = []
    private(set) var inspectErrors: [String: String] = [:]
    var pendingWriteTool: PendingWriteTool?
    private var confirmedWriteTools: Set<String> = []

    // Account
    private(set) var phase: AccountPhase = .signedOut
    private(set) var identity: AccountIdentity?
    private(set) var machines: [AccountMachine] = []
    private(set) var machinesLoaded = false
    private(set) var machinesError: String?
    private(set) var isRegistering = false
    var accountError: String?
    private(set) var registrationError: String?
    var proposedMachineName = ""

    // Launch at login
    private(set) var launchAtLogin = false
    private(set) var launchAtLoginError: String?

    @ObservationIgnored private let store: ConfigStore
    @ObservationIgnored private let defaults = UserDefaults.standard
    @ObservationIgnored private var supervisor: DaemonSupervisor?
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private var pendingSession: AuthSession?
    @ObservationIgnored private var clients: [String: AccountClient] = [:]
    @ObservationIgnored private var lastRegistrationAttempt: Date?
    @ObservationIgnored private var bootstrapped = false
    @ObservationIgnored private var isCompletingSignIn = false

    private init() {
        let environment = ProcessInfo.processInfo.environment
        paths = BridgePaths(environment: environment)
        runsWithoutAccount = environment["LOCAL_BRIDGE_NO_ACCOUNT"] == "1"
        isPreview = false
        store = ConfigStore(url: paths.configURL)
        paused = defaults.bool(forKey: "paused")
        nodeOverride = defaults.string(forKey: "nodePath") ?? ""
    }

    /// A model holding fixed state, for snapshots. It never starts a daemon, touches the
    /// Keychain or the network, and its file paths all point inside `directory`.
    init(preview state: PreviewState, directory: URL) {
        paths = BridgePaths(environment: [
            BridgePaths.configEnv: directory.appendingPathComponent("preview-config.json").path,
            BridgePaths.stateDirEnv: directory.path,
            BridgePaths.agentDirEnv: directory.path,
        ])
        runsWithoutAccount = false
        isPreview = true
        store = ConfigStore(url: paths.configURL)
        paused = state.paused
        nodeOverride = state.nodeOverride
        saved = state.saved
        draft = state.draft ?? state.saved ?? BridgeConfig(machine: state.proposedMachineName)
        loadState = state.saved.map(ConfigLoadResult.loaded) ?? .missing
        selection = state.selection
        settingsTab = state.settingsTab
        status = state.status
        supervisorState = state.supervisorState
        blocker = state.blocker
        resolvedNode = state.resolvedNode
        nodeSearched = true
        activity = state.activity
        inspections = state.inspections
        phase = state.phase
        identity = state.identity
        machines = state.machines
        machinesLoaded = true
        proposedMachineName = state.proposedMachineName
        launchAtLogin = state.launchAtLogin
        bootstrapped = true
    }

    // MARK: - Launch and quit

    func bootstrap() {
        guard !bootstrapped else { return }
        bootstrapped = true
        reloadConfig()
        inspections = InspectCache.load(from: paths.inspectCacheURL)
        refreshLaunchAtLogin()

        if runsWithoutAccount {
            phase = .signedIn
        } else if client().isSignedIn {
            phase = saved == nil && loadState == .missing ? .namingMachine : .signedIn
            proposedMachineName = defaultMachineName()
            Task { await self.refreshAccount() }
        }

        let override = nodeOverride
        Task {
            let found = await Task.detached { NodeLocator().locate(override: override) }.value
            self.resolvedNode = found
            self.nodeSearched = true
            self.startDaemonIfPossible()
        }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.poll()
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }

    /// Called as the app quits: the child must not outlive the app.
    func shutdown() {
        guard !isPreview else { return }
        pollTask?.cancel()
        supervisor?.stopAndWait()
    }

    // MARK: - Config

    var isReadOnly: Bool {
        if case .invalid = loadState { return true }
        return false
    }

    var invalidConfigMessage: String? {
        if case .invalid(let message) = loadState { return message }
        return nil
    }

    var isDirty: Bool {
        guard let saved else { return !draft.servers.isEmpty }
        return draft != saved
    }

    var serverNames: [String] { draft.serverNamesByTitle }

    func reloadConfig() {
        guard !isPreview else { return }
        loadState = store.load()
        switch loadState {
        case .loaded(let config):
            saved = config
            draft = config
        case .missing:
            saved = nil
            draft = BridgeConfig(machine: defaultMachineName())
        case .invalid:
            saved = nil
            draft = BridgeConfig(machine: "")
        }
        saveError = nil
        draftGeneration += 1
        if case .server(let name)? = selection, draft.servers[name] == nil { selection = nil }
        if selection == nil, let first = draft.serverNamesByTitle.first { selection = .server(first) }
    }

    func defaultMachineName() -> String {
        ConfigValidator.proposedMachineName(fromHost: Host.current().localizedName ?? ProcessInfo.processInfo.hostName)
    }

    func revert() {
        guard !isReadOnly else { return }
        if let saved {
            draft = saved
        } else {
            draft = BridgeConfig(machine: defaultMachineName())
        }
        saveError = nil
        draftGeneration += 1
        if case .server(let name)? = selection, draft.servers[name] == nil {
            selection = draft.serverNamesByTitle.first.map(SidebarItem.server)
        }
    }

    /// Validate, write, restart the daemon.
    func save() {
        guard !isPreview else { return }
        guard !isReadOnly else { return }
        do {
            let written = try store.save(draft)
            saved = written
            draft = written
            loadState = .loaded(written)
            saveError = nil
            draftGeneration += 1
            restartDaemon()
        } catch let error as ConfigError {
            saveError = error.errorDescription
        } catch {
            saveError = "The config could not be saved."
        }
    }

    /// A change made in Settings: validated and saved on its own, without taking unsaved server
    /// edits along. Returns what is wrong, or nil when it was applied.
    func applyGeneral(machine: String? = nil, endpoint: String? = nil, publicBase: String?? = nil) -> String? {
        guard !isPreview, !isReadOnly else { return nil }
        var candidate = saved ?? draft
        if let machine { candidate.machine = machine }
        if let endpoint { candidate.endpoint = endpoint }
        if let publicBase { candidate.publicBase = publicBase }
        guard candidate != (saved ?? draft) else { return nil }
        let issues = ConfigValidator.validate(candidate.normalized()).filter { !$0.path.hasPrefix("servers") }
        if let first = issues.first { return "\(first.path) \(first.message)" }
        guard saved != nil else {
            // No file yet: nothing to write until the first server is saved.
            draft.machine = candidate.machine
            draft.endpoint = candidate.endpoint
            draft.publicBase = candidate.publicBase
            return nil
        }
        do {
            let written = try store.save(candidate)
            saved = written
            loadState = .loaded(written)
            draft.machine = written.machine
            draft.endpoint = written.endpoint
            draft.publicBase = written.publicBase
            restartDaemon()
            return nil
        } catch {
            return describe(error)
        }
    }

    func addServer(name: String, config: ServerConfig) {
        guard !isReadOnly else { return }
        draft.servers[name] = config
        selection = .server(name)
        refreshTools(for: name)
    }

    func removeServer(_ name: String) {
        guard !isReadOnly else { return }
        draft.servers[name] = nil
        inspectErrors[name] = nil
        selection = draft.serverNamesByTitle.first.map(SidebarItem.server)
    }

    func endpointURL(for name: String) -> String {
        draft.endpointURL(forServer: name)
    }

    // MARK: - Server and tool state

    func runState(for name: String) -> ServerRunState {
        guard let savedServer = saved?.servers[name] else { return .unsaved }
        if !savedServer.isEnabled { return .off }
        guard let live = status.status?.server(named: name) else { return .unknown }
        if live.status == "up" { return .up(tools: live.tools?.count ?? savedServer.exposedToolCount) }
        return .down(live.error ?? live.status ?? "down")
    }

    func hasBeenInspected(_ name: String) -> Bool {
        inspections.servers[name] != nil
    }

    func inspectedAt(_ name: String) -> Date? {
        inspections.servers[name]?.inspectedAt
    }

    func toolRows(for name: String) -> [ToolRow] {
        guard let server = draft.servers[name] else { return [] }
        let inspected = inspections.servers[name]?.tools ?? []
        var rows = inspected.map { tool in
            ToolRow(
                name: tool.name,
                description: tool.description ?? "",
                isOn: server.access(for: tool.name) != nil,
                changesThings: (server.access(for: tool.name) ?? tool.suggestedAccess) == .write,
                notReported: false)
        }
        let known = Set(inspected.map(\.name))
        // Tools the config names that no inspection has listed: still shown, so they can be switched off.
        var extras: [String] = []
        for tool in server.read + server.write + (saved?.servers[name]?.read ?? []) + (saved?.servers[name]?.write ?? [])
        where !known.contains(tool) && !extras.contains(tool) {
            extras.append(tool)
        }
        rows += extras.map { tool in
            ToolRow(
                name: tool, description: "",
                isOn: server.access(for: tool) != nil,
                changesThings: fallbackAccess(server: name, tool: tool) == .write,
                notReported: !inspected.isEmpty)
        }
        return rows
    }

    private func fallbackAccess(server name: String, tool: String) -> ToolAccess {
        draft.servers[name]?.access(for: tool)
            ?? saved?.servers[name]?.access(for: tool)
            ?? ToolAccess.suggested(forToolNamed: tool)
    }

    private func access(server name: String, tool: String) -> ToolAccess {
        if let current = draft.servers[name]?.access(for: tool) { return current }
        if let inspected = inspections.servers[name]?.tools.first(where: { $0.name == tool }) {
            return inspected.suggestedAccess
        }
        return fallbackAccess(server: name, tool: tool)
    }

    /// The per-tool switch. Switching a write tool on asks once.
    func setTool(server name: String, tool: String, on: Bool) {
        guard !isReadOnly else { return }
        let access = access(server: name, tool: tool)
        if on, access == .write, !confirmedWriteTools.contains("\(name).\(tool)") {
            pendingWriteTool = PendingWriteTool(server: name, tool: tool)
            return
        }
        draft.servers[name]?.setTool(tool, exposed: on, access: access)
    }

    func confirmPendingWriteTool() {
        guard let pending = pendingWriteTool else { return }
        confirmedWriteTools.insert(pending.id)
        pendingWriteTool = nil
        draft.servers[pending.server]?.setTool(pending.tool, exposed: true, access: .write)
    }

    func isInspecting(_ name: String) -> Bool { inspecting.contains(name) }

    func inspectError(for name: String) -> String? { inspectErrors[name] }

    func refreshTools(for name: String) {
        guard !isPreview else { return }
        guard let server = draft.servers[name], !inspecting.contains(name) else { return }
        guard let node = resolvedNode else {
            inspectErrors[name] = "Node was not found, so the server cannot be asked for its tools. Set the path in Settings."
            return
        }
        guard let cli = paths.cliURL?.path, FileManager.default.fileExists(atPath: cli) else {
            inspectErrors[name] = "The bridge agent is missing from this app, so the server cannot be asked for its tools."
            return
        }
        inspecting.insert(name)
        inspectErrors[name] = nil
        let runner = InspectRunner(nodePath: node, cliPath: cli, environment: childEnvironment(node: node))
        Task {
            let result = await runner.inspect(server)
            self.inspecting.remove(name)
            switch result {
            case .ok(let tools):
                let first = self.inspections.servers[name] == nil
                self.inspections.servers[name] = .init(tools: tools, inspectedAt: Date())
                try? self.inspections.save(to: self.paths.inspectCacheURL)
                if first, !self.isReadOnly { self.draft.servers[name]?.applyFirstInspection(tools) }
            case .failed(let message):
                self.inspectErrors[name] = message
            }
        }
    }

    // MARK: - Daemon

    var connectionState: ConnectionState {
        guard phase == .signedIn, !paused, blocker == nil else { return .offline }
        if status.isRunning { return status.connectionState }
        if case .running = supervisorState { return .connecting }
        return .offline
    }

    var daemonSummary: String {
        if phase != .signedIn { return "Not signed in" }
        if paused { return "Paused" }
        if isReadOnly { return "Not running: the config file has an error" }
        if blocker != nil { return "Not running" }
        let machine = saved?.machine ?? draft.machine
        switch connectionState {
        case .connected: return "Connected as \(machine)"
        case .connecting: return "Connecting…"
        case .offline:
            if case .backingOff = supervisorState { return "Offline: the bridge agent stopped and is being restarted" }
            if let error = status.status?.connection?.lastError { return "Offline (\(error))" }
            return saved == nil ? "Not running yet" : "Offline"
        }
    }

    private func childEnvironment(node: String) -> [String: String] {
        var environment = ProcessInfo.processInfo.environment
        environment[BridgePaths.configEnv] = paths.configURL.path
        if paths.stateDirectoryIsOverridden { environment[BridgePaths.stateDirEnv] = paths.stateDirectory.path }
        // An app started from the Dock has a bare PATH; servers are often started by name.
        let nodeDirectory = (node as NSString).deletingLastPathComponent
        let existing = environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        var parts = [nodeDirectory, "/opt/homebrew/bin", "/usr/local/bin"]
        parts += existing.split(separator: ":").map(String.init)
        var seen = Set<String>()
        environment["PATH"] = parts.filter { seen.insert($0).inserted }.joined(separator: ":")
        return environment
    }

    func startDaemonIfPossible() {
        guard !isPreview else { return }
        blocker = nil
        guard phase == .signedIn, !paused, nodeSearched else { return }
        guard case .loaded = loadState, let saved else { return }
        guard let node = resolvedNode else {
            blocker = .nodeMissing
            return
        }
        guard let cli = paths.cliURL?.path, FileManager.default.fileExists(atPath: cli) else {
            blocker = .agentMissing(paths.cliURL?.path ?? "Contents/Resources/agent/cli.mjs")
            return
        }
        if !runsWithoutAccount, saved.account == nil {
            // The daemon would only exit with "no_account". Registering is the fix.
            registerIfDue()
            return
        }
        status = StatusReader(url: paths.statusURL).read()
        if supervisor?.childPID == nil, let pid = status.status?.pid {
            blocker = .otherDaemon(pid: pid)
            return
        }
        let configuration = DaemonSupervisor.Configuration(
            nodePath: node, scriptPath: cli, arguments: ["run"], environment: childEnvironment(node: node))
        let supervisor = self.supervisor ?? makeSupervisor(configuration)
        supervisor.update(configuration: configuration)
        do {
            try supervisor.start()
        } catch {
            switch error {
            case .launchAgentLoaded: blocker = .launchAgentLoaded
            case .nodeNotFound: blocker = .nodeMissing
            case .scriptNotFound(let path): blocker = .agentMissing(path)
            }
        }
    }

    private func makeSupervisor(_ configuration: DaemonSupervisor.Configuration) -> DaemonSupervisor {
        let supervisor = DaemonSupervisor(configuration: configuration, onEvent: { event in
            DispatchQueue.main.async {
                MainActor.assumeIsolated { AppModel.shared.handle(event) }
            }
        })
        self.supervisor = supervisor
        return supervisor
    }

    private func handle(_ event: DaemonSupervisor.Event) {
        switch event {
        case .state(let state):
            supervisorState = state
            if case .blocked(.launchAgentLoaded) = state { blocker = .launchAgentLoaded }
        case .stdoutLine(let line):
            if !activity.ingest(line: line), line.contains("\"level\":\"error\"") {
                // Content-free by construction: the daemon logs event names and error classes only.
                let object = (try? JSONValue.parse(line))?.objectValue
                let parts = [object?["event"]?.stringValue, object?["errorClass"]?.stringValue].compactMap { $0 }
                if !parts.isEmpty { lastDaemonMessage = parts.joined(separator: ": ") }
            }
        case .stderrLine(let line):
            lastDaemonMessage = String(line.prefix(200))
        }
    }

    func restartDaemon() {
        guard !isPreview else { return }
        Task {
            await self.supervisor?.stop()
            self.startDaemonIfPossible()
        }
    }

    func setPaused(_ value: Bool) {
        guard !isPreview else { return }
        paused = value
        defaults.set(value, forKey: "paused")
        if value {
            Task { await self.supervisor?.stop() }
        } else {
            startDaemonIfPossible()
        }
    }

    func setNodeOverride(_ path: String) {
        guard !isPreview else { return }
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed != nodeOverride else { return }
        nodeOverride = trimmed
        defaults.set(trimmed, forKey: "nodePath")
        Task {
            let found = await Task.detached { NodeLocator().locate(override: trimmed) }.value
            let changed = found != self.resolvedNode
            self.resolvedNode = found
            if changed || self.blocker == .nodeMissing { self.restartDaemon() }
        }
    }

    /// Stops a bridge agent this app did not start (one left behind, or run by hand).
    func stopOtherDaemon() {
        guard !isPreview else { return }
        guard case .otherDaemon(let pid) = blocker else { return }
        kill(pid, SIGTERM)
        Task {
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            self.startDaemonIfPossible()
        }
    }

    private func poll() async {
        let reader = StatusReader(url: paths.statusURL)
        let snapshot = await Task.detached { reader.read() }.value
        if snapshot != status { status = snapshot }
        if case .otherDaemon(let pid) = blocker, !ProcessProbe.isAlive(pid: pid) { startDaemonIfPossible() }
        if snapshot.needsRegistration, let written = snapshot.lastUpdated,
           written > (lastRegistrationAttempt ?? .distantPast) {
            registerIfDue()
        }
    }

    // MARK: - Account

    private func client() -> AccountClient {
        let base = (saved ?? draft).effectivePublicBase
        if let existing = clients[base] { return existing }
        let tokens: TokenStore = runsWithoutAccount ? InMemoryTokenStore() : KeychainTokenStore()
        let created = AccountClient(publicBase: base, tokens: tokens, clientIDs: UserDefaultsClientIDStore())
        clients[base] = created
        return created
    }

    private func describe(_ error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? "Something went wrong."
    }

    func signIn() {
        guard !isPreview else { return }
        accountError = nil
        phase = .waitingForBrowser
        let client = client()
        Task {
            do {
                let session = try await client.beginSignIn()
                self.pendingSession = session
                NSWorkspace.shared.open(session.authorizeURL)
            } catch {
                self.phase = .signedOut
                self.accountError = self.describe(error)
            }
        }
    }

    func cancelSignIn() {
        pendingSession = nil
        phase = .signedOut
    }

    /// The `localbridge://oauth/callback` URL arrived from the browser.
    func handleCallback(_ url: URL) {
        guard !isPreview else { return }
        guard AccountClient.isCallback(url) else { return }
        NSApp.activate(ignoringOtherApps: true)
        guard let session = pendingSession else {
            // The same callback can arrive twice (window and Apple event); the second is not an error.
            if phase != .signedIn, !isCompletingSignIn {
                accountError = "That sign-in link belongs to an earlier attempt. Start again from here."
            }
            return
        }
        pendingSession = nil
        isCompletingSignIn = true
        let client = client()
        Task {
            defer { self.isCompletingSignIn = false }
            do {
                try await client.completeSignIn(callback: url, session: session)
                self.identity = try await client.me()
                self.accountError = nil
                if case .loaded(let config) = self.loadState {
                    self.phase = .signedIn
                    await self.registerThisMac(named: config.machine)
                } else {
                    self.proposedMachineName = self.defaultMachineName()
                    self.phase = .namingMachine
                }
            } catch {
                self.phase = .signedOut
                self.accountError = self.describe(error)
            }
        }
    }

    /// First sign-in on a Mac with no config: the user confirmed its name.
    func confirmMachineName() {
        guard !isPreview else { return }
        let name = proposedMachineName.trimmingCharacters(in: .whitespaces)
        guard ConfigValidator.isValidName(name) else {
            accountError = "The name \(ConfigValidator.nameRule)."
            return
        }
        accountError = nil
        Task {
            if await self.registerThisMac(named: name) { self.phase = .signedIn }
            else { self.accountError = self.registrationError }
            self.startDaemonIfPossible()
        }
    }

    private func refreshAccount() async {
        do {
            identity = try await client().me()
        } catch AccountError.notSignedIn {
            await signedOutLocally()
            return
        } catch {
            // Offline at launch: stay signed in with what is on disk.
        }
        if phase == .signedIn, let uid = identity?.uid, let saved, saved.account != uid {
            registerIfDue()
        }
    }

    private func registerIfDue() {
        guard phase == .signedIn, !runsWithoutAccount, !isRegistering, let machine = saved?.machine else { return }
        if let last = lastRegistrationAttempt, Date().timeIntervalSince(last) < 60 { return }
        Task {
            await self.supervisor?.stop()
            await self.registerThisMac(named: machine)
        }
    }

    /// Makes sure the device key exists, registers its public half for this account, records the
    /// account in the config and starts the daemon.
    @discardableResult
    private func registerThisMac(named machine: String) async -> Bool {
        guard !isRegistering else { return false }
        isRegistering = true
        lastRegistrationAttempt = Date()
        defer { isRegistering = false }
        do {
            if isReadOnly { throw RegistrationFailure("The config file has an error. Fix it, then try again.") }
            if !nodeSearched {
                let override = nodeOverride
                resolvedNode = await Task.detached { NodeLocator().locate(override: override) }.value
                nodeSearched = true
            }
            guard let node = resolvedNode else {
                throw RegistrationFailure("Node was not found. Set its path in Settings, then try again.")
            }
            guard let cli = paths.cliURL?.path, FileManager.default.fileExists(atPath: cli) else {
                throw RegistrationFailure("The bridge agent is missing from this app.")
            }
            let environment = childEnvironment(node: node)
            // `init` creates the device key if there is none and is safe to repeat.
            _ = await ProcessRunner.run(
                executable: node, arguments: [cli, "init", "--machine", machine], environment: environment, timeout: 30)
            let output = await ProcessRunner.run(
                executable: node, arguments: [cli, "pubkey", "--machine", machine], environment: environment, timeout: 30)
            guard let key = DevicePublicKey.parse(cliOutput: output.stdoutText) else {
                throw RegistrationFailure("This Mac's device key could not be read.")
            }
            let registration = try await client().registerMachine(machine, key: key)
            var config = saved ?? draft
            if saved == nil { config.machine = machine }
            config.account = registration.uid
            let untouched = saved == nil || draft == saved
            let written = try store.save(saved == nil ? BridgeConfig(machine: machine, account: registration.uid) : config)
            saved = written
            loadState = .loaded(written)
            if untouched {
                draft = written
                draftGeneration += 1
            } else {
                draft.account = written.account
            }
            registrationError = nil
            await supervisor?.stop()
            startDaemonIfPossible()
            Task { await self.loadMachines() }
            return true
        } catch AccountError.notSignedIn {
            await signedOutLocally()
            return false
        } catch {
            registrationError = "This Mac could not be registered. \(describe(error))"
            return false
        }
    }

    func retryRegistration() {
        guard !isPreview else { return }
        lastRegistrationAttempt = nil
        registerIfDue()
    }

    func loadMachines() async {
        guard !isPreview else { return }
        guard phase == .signedIn, !runsWithoutAccount else { return }
        do {
            machines = try await client().machines()
            machinesError = nil
            machinesLoaded = true
            if identity == nil { identity = try? await client().me() }
        } catch AccountError.notSignedIn {
            await signedOutLocally()
        } catch {
            machinesError = describe(error)
        }
    }

    func removeMachine(_ name: String) {
        guard !isPreview else { return }
        Task {
            do {
                try await self.client().removeMachine(name)
                self.machines.removeAll { $0.machine == name }
                self.machinesError = nil
            } catch {
                self.machinesError = self.describe(error)
            }
        }
    }

    /// Stops the daemon and deletes the tokens. The device key and the config stay.
    func signOut() {
        guard !isPreview else { return }
        Task {
            await self.supervisor?.stop()
            await self.client().signOut()
            await self.signedOutLocally()
        }
    }

    private func signedOutLocally() async {
        await supervisor?.stop()
        identity = nil
        machines = []
        machinesLoaded = false
        pendingSession = nil
        registrationError = nil
        phase = .signedOut
    }

    // MARK: - Launch at login

    func refreshLaunchAtLogin() {
        guard !isPreview else { return }
        launchAtLogin = SMAppService.mainApp.status == .enabled
    }

    func setLaunchAtLogin(_ on: Bool) {
        guard !isPreview else { return }
        do {
            if on {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
            launchAtLoginError = nil
        } catch {
            launchAtLoginError = "macOS did not accept the change. Launch at login works when the app runs from its built bundle."
        }
        refreshLaunchAtLogin()
    }
}

/// Everything a snapshot needs to show one screen.
struct PreviewState {
    var phase: AccountPhase = .signedIn
    var saved: BridgeConfig?
    var draft: BridgeConfig?
    var selection: SidebarItem?
    var settingsTab: SettingsTab = .general
    var status: StatusSnapshot = .notRunning(lastKnown: nil)
    var supervisorState: DaemonSupervisor.State = .stopped
    var blocker: Blocker?
    var paused = false
    var nodeOverride = ""
    var resolvedNode: String? = "/usr/local/bin/node"
    var activity = ActivityBuffer()
    var inspections = InspectCache()
    var identity: AccountIdentity?
    var machines: [AccountMachine] = []
    var proposedMachineName = "mini"
    var launchAtLogin = true
}

private struct RegistrationFailure: LocalizedError {
    var message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
