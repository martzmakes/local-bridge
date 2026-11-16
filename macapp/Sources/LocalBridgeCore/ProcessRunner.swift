import Foundation

final class LockedData: @unchecked Sendable {
    private let lock = NSLock()
    private var storage = Data()

    func append(_ data: Data) {
        lock.lock()
        storage.append(data)
        lock.unlock()
    }

    var value: Data {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }
}

public struct ProcessOutput: Sendable {
    /// nil when the process could not be started.
    public var status: Int32?
    public var stdout: Data
    public var stderr: Data
    public var timedOut: Bool
    public var launchError: String?

    public var stdoutText: String { String(decoding: stdout, as: UTF8.self) }
    public var stderrText: String { String(decoding: stderr, as: UTF8.self) }
}

/// Runs a short-lived helper process to completion with a deadline.
public enum ProcessRunner {
    private static let ignoreSIGPIPE: Void = {
        signal(SIGPIPE, SIG_IGN)
    }()

    public static func run(
        executable: String,
        arguments: [String],
        environment: [String: String]? = nil,
        stdin: Data? = nil,
        timeout: TimeInterval
    ) async -> ProcessOutput {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                continuation.resume(returning: runSync(
                    executable: executable, arguments: arguments, environment: environment, stdin: stdin, timeout: timeout))
            }
        }
    }

    public static func runSync(
        executable: String,
        arguments: [String],
        environment: [String: String]? = nil,
        stdin: Data? = nil,
        timeout: TimeInterval
    ) -> ProcessOutput {
        _ = ignoreSIGPIPE
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        if let environment { process.environment = environment }

        let outPipe = Pipe()
        let errPipe = Pipe()
        let inPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = errPipe
        process.standardInput = inPipe

        let outData = LockedData()
        let errData = LockedData()
        let outEOF = DispatchSemaphore(value: 0)
        let errEOF = DispatchSemaphore(value: 0)
        outPipe.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if chunk.isEmpty {
                handle.readabilityHandler = nil
                outEOF.signal()
            } else {
                outData.append(chunk)
            }
        }
        errPipe.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if chunk.isEmpty {
                handle.readabilityHandler = nil
                errEOF.signal()
            } else {
                errData.append(chunk)
            }
        }

        let exited = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in exited.signal() }

        do {
            try process.run()
        } catch {
            outPipe.fileHandleForReading.readabilityHandler = nil
            errPipe.fileHandleForReading.readabilityHandler = nil
            return ProcessOutput(status: nil, stdout: Data(), stderr: Data(), timedOut: false,
                                 launchError: "could not start \(executable)")
        }

        let stdinHandle = inPipe.fileHandleForWriting
        let input = stdin
        DispatchQueue.global(qos: .userInitiated).async {
            if let input { try? stdinHandle.write(contentsOf: input) }
            try? stdinHandle.close()
        }

        var timedOut = false
        if exited.wait(timeout: .now() + timeout) == .timedOut {
            timedOut = true
            let pid = process.processIdentifier
            kill(pid, SIGTERM)
            if exited.wait(timeout: .now() + 2) == .timedOut {
                kill(pid, SIGKILL)
                _ = exited.wait(timeout: .now() + 2)
            }
        }
        // A grandchild can keep the pipe open after the child is gone; do not wait for it.
        _ = outEOF.wait(timeout: .now() + 0.5)
        _ = errEOF.wait(timeout: .now() + 0.5)
        outPipe.fileHandleForReading.readabilityHandler = nil
        errPipe.fileHandleForReading.readabilityHandler = nil

        return ProcessOutput(
            status: process.isRunning ? nil : process.terminationStatus,
            stdout: outData.value, stderr: errData.value, timedOut: timedOut, launchError: nil)
    }
}

public enum ProcessProbe {
    public static func isAlive(pid: Int32) -> Bool {
        guard pid > 0 else { return false }
        return kill(pid, 0) == 0 || errno == EPERM
    }
}
