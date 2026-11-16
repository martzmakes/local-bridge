import Foundation

public enum LaunchAgentProbe {
    public static let v1Label = "com.martzmakes.local-bridge"

    /// True when launchd has the v1 LaunchAgent loaded for this user.
    public static func isLoaded(label: String = v1Label) -> Bool {
        let output = ProcessRunner.runSync(
            executable: "/bin/launchctl", arguments: ["print", "gui/\(getuid())/\(label)"], timeout: 5)
        return output.status == 0
    }

    public static func uninstallCommand(label: String = v1Label) -> String {
        "launchctl bootout gui/$(id -u)/\(label); rm -f ~/Library/LaunchAgents/\(label).plist"
    }
}

/// Runs the Node daemon as a child of the app and keeps it running.
///
/// The child is the app's own process child on purpose: macOS then attributes Automation,
/// Reminders and Full Disk Access to the signed app instead of to `node`.
public final class DaemonSupervisor: @unchecked Sendable {
    public struct Configuration: Sendable {
        public var nodePath: String
        public var scriptPath: String
        public var arguments: [String]
        public var environment: [String: String]
        public var initialBackoff: TimeInterval
        public var maximumBackoff: TimeInterval
        /// A child that lived this long is considered healthy; the next failure starts at `initialBackoff` again.
        public var stableAfter: TimeInterval
        /// How long the child gets between SIGTERM and SIGKILL.
        public var killGrace: TimeInterval

        public init(
            nodePath: String,
            scriptPath: String,
            arguments: [String] = ["run"],
            environment: [String: String] = ProcessInfo.processInfo.environment,
            initialBackoff: TimeInterval = 1,
            maximumBackoff: TimeInterval = 60,
            stableAfter: TimeInterval = 30,
            killGrace: TimeInterval = 5
        ) {
            self.nodePath = nodePath
            self.scriptPath = scriptPath
            self.arguments = arguments
            self.environment = environment
            self.initialBackoff = initialBackoff
            self.maximumBackoff = maximumBackoff
            self.stableAfter = stableAfter
            self.killGrace = killGrace
        }
    }

    public enum StartError: Error, Equatable, Sendable {
        /// The v1 LaunchAgent is loaded; two daemons would fight over one machine id.
        case launchAgentLoaded
        case nodeNotFound(String)
        case scriptNotFound(String)
    }

    public enum State: Equatable, Sendable {
        case stopped
        case running(pid: Int32)
        /// The child exited and will be started again after `delay` seconds.
        case backingOff(delay: TimeInterval, exitStatus: Int32)
        case blocked(StartError)
    }

    public enum Event: Sendable {
        case state(State)
        case stdoutLine(String)
        case stderrLine(String)
    }

    private final class Splitter: @unchecked Sendable {
        var splitter = LineSplitter()
    }

    private let queue = DispatchQueue(label: "com.martzmakes.localbridge.supervisor")
    private let launchAgentLoaded: @Sendable () -> Bool
    private let onEvent: @Sendable (Event) -> Void

    // All below are touched only on `queue`.
    private var configuration: Configuration
    private var process: Process?
    private var generation = 0
    private var wantRunning = false
    private var terminating = false
    private var backoff: TimeInterval
    private var startedAt = Date()
    private var restartWork: DispatchWorkItem?
    private var killWork: DispatchWorkItem?
    private var exitWaiters: [@Sendable () -> Void] = []
    private var currentState: State = .stopped

    /// `onEvent` is called on a private serial queue, in order.
    public init(
        configuration: Configuration,
        launchAgentLoaded: @escaping @Sendable () -> Bool = { LaunchAgentProbe.isLoaded() },
        onEvent: @escaping @Sendable (Event) -> Void = { _ in }
    ) {
        self.configuration = configuration
        self.backoff = configuration.initialBackoff
        self.launchAgentLoaded = launchAgentLoaded
        self.onEvent = onEvent
    }

    public var state: State {
        queue.sync { currentState }
    }

    public var childPID: Int32? {
        queue.sync { process?.processIdentifier }
    }

    /// Takes effect at the next spawn.
    public func update(configuration: Configuration) {
        queue.sync {
            self.configuration = configuration
            if process == nil { backoff = configuration.initialBackoff }
        }
    }

    /// Starts the child. Does nothing if it is already running or waiting to restart.
    public func start() throws(StartError) {
        let result: Result<Void, StartError> = queue.sync {
            if wantRunning, process != nil || restartWork != nil { return .success(()) }
            if let refusal = preflight() {
                wantRunning = false
                setState(.blocked(refusal))
                return .failure(refusal)
            }
            wantRunning = true
            backoff = configuration.initialBackoff
            if process == nil { spawn() }
            return .success(())
        }
        try result.get()
    }

    /// Stops the child (SIGTERM, then SIGKILL after the grace period) and returns once it is gone.
    public func stop() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            queue.async {
                self.stopLocked { continuation.resume() }
            }
        }
    }

    /// For app termination, where there is no time for async work. Blocks until the child is gone.
    public func stopAndWait() {
        let done = DispatchSemaphore(value: 0)
        let grace: TimeInterval = queue.sync { configuration.killGrace }
        queue.async {
            self.stopLocked { done.signal() }
        }
        if done.wait(timeout: .now() + grace + 3) == .timedOut {
            queue.sync {
                if let pid = process?.processIdentifier { kill(pid, SIGKILL) }
            }
        }
    }

    /// Stop, then start: how a saved config reaches the daemon.
    public func restart() async throws(StartError) {
        await stop()
        try start()
    }

    // MARK: - On the queue

    private func preflight() -> StartError? {
        if launchAgentLoaded() { return .launchAgentLoaded }
        if !FileManager.default.isExecutableFile(atPath: configuration.nodePath) {
            return .nodeNotFound(configuration.nodePath)
        }
        if !FileManager.default.fileExists(atPath: configuration.scriptPath) {
            return .scriptNotFound(configuration.scriptPath)
        }
        return nil
    }

    private func setState(_ state: State) {
        guard state != currentState else { return }
        currentState = state
        onEvent(.state(state))
    }

    private func spawn() {
        generation += 1
        let gen = generation
        let child = Process()
        child.executableURL = URL(fileURLWithPath: configuration.nodePath)
        child.arguments = [configuration.scriptPath] + configuration.arguments
        child.environment = configuration.environment
        child.standardInput = FileHandle.nullDevice

        let outPipe = Pipe()
        let errPipe = Pipe()
        child.standardOutput = outPipe
        child.standardError = errPipe
        let outSplitter = Splitter()
        let errSplitter = Splitter()
        let queue = self.queue
        let onEvent = self.onEvent
        outPipe.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else {
                handle.readabilityHandler = nil
                return
            }
            queue.async {
                for line in outSplitter.splitter.feed(chunk) { onEvent(.stdoutLine(line)) }
            }
        }
        errPipe.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else {
                handle.readabilityHandler = nil
                return
            }
            queue.async {
                for line in errSplitter.splitter.feed(chunk) { onEvent(.stderrLine(line)) }
            }
        }
        child.terminationHandler = { [weak self] finished in
            let status = finished.terminationStatus
            queue.async { [weak self] in self?.handleExit(generation: gen, status: status) }
        }

        terminating = false
        startedAt = Date()
        do {
            try child.run()
        } catch {
            outPipe.fileHandleForReading.readabilityHandler = nil
            errPipe.fileHandleForReading.readabilityHandler = nil
            scheduleRestart(exitStatus: -1)
            return
        }
        process = child
        setState(.running(pid: child.processIdentifier))
    }

    private func handleExit(generation gen: Int, status: Int32) {
        guard gen == generation, process != nil else { return }
        process = nil
        terminating = false
        killWork?.cancel()
        killWork = nil
        let waiters = exitWaiters
        exitWaiters = []
        if wantRunning {
            if Date().timeIntervalSince(startedAt) >= configuration.stableAfter {
                backoff = configuration.initialBackoff
            }
            scheduleRestart(exitStatus: status)
        } else {
            setState(.stopped)
        }
        waiters.forEach { $0() }
    }

    private func scheduleRestart(exitStatus: Int32) {
        let delay = backoff
        backoff = min(max(backoff * 2, configuration.initialBackoff), configuration.maximumBackoff)
        setState(.backingOff(delay: delay, exitStatus: exitStatus))
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.wantRunning, self.process == nil else { return }
            self.restartWork = nil
            if let refusal = self.preflight() {
                self.wantRunning = false
                self.setState(.blocked(refusal))
                return
            }
            self.spawn()
        }
        restartWork = work
        queue.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private func stopLocked(_ completion: @escaping @Sendable () -> Void) {
        wantRunning = false
        restartWork?.cancel()
        restartWork = nil
        guard let child = process else {
            if case .blocked = currentState {} else { setState(.stopped) }
            completion()
            return
        }
        exitWaiters.append(completion)
        guard !terminating else { return }
        terminating = true
        let pid = child.processIdentifier
        kill(pid, SIGTERM)
        let gen = generation
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.generation == gen, self.process != nil else { return }
            kill(pid, SIGKILL)
        }
        killWork = work
        queue.asyncAfter(deadline: .now() + configuration.killGrace, execute: work)
    }
}
