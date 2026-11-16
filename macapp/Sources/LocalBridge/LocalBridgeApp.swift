import AppKit
import LocalBridgeCore
import SwiftUI

@main
enum Launcher {
    static func main() {
        // Snapshot mode renders every screen to PNG from sample state and exits. Nothing else starts.
        if let directory = ProcessInfo.processInfo.environment[SnapshotRunner.environmentKey], !directory.isEmpty {
            MainActor.assumeIsolated {
                SnapshotRunner.run(directory: URL(fileURLWithPath: directory, isDirectory: true))
            }
        } else {
            LocalBridgeApp.main()
        }
    }
}

struct LocalBridgeApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = AppModel.shared

    var body: some Scene {
        Window("Local Bridge", id: "main") {
            RootView()
                .environment(model)
                .onOpenURL { model.handleCallback($0) }
                .frame(minWidth: 760, minHeight: 480)
        }
        .defaultSize(width: 940, height: 640)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("Add Server…") { model.showingAddServer = true }
                    .keyboardShortcut("n")
                    .disabled(model.phase != .signedIn || model.isReadOnly)
            }
            CommandGroup(replacing: .saveItem) {
                Button("Save") { model.save() }
                    .keyboardShortcut("s")
                    .disabled(!model.isDirty || model.isReadOnly)
                Button("Revert") { model.revert() }
                    .disabled(!model.isDirty || model.isReadOnly)
            }
        }

        MenuBarExtra {
            MenuBarContent()
                .environment(model)
        } label: {
            MenuBarLabel()
                .environment(model)
        }

        Settings {
            SettingsView()
                .environment(model)
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var signalSources: [DispatchSourceSignal] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        // SIGTERM and SIGINT quit the normal way, so the daemon child is stopped first.
        for number in [SIGTERM, SIGINT] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { NSApp.terminate(nil) }
            source.resume()
            signalSources.append(source)
        }
        // The OAuth callback, for the case where no window is there to receive it.
        NSAppleEventManager.shared().setEventHandler(
            self, andSelector: #selector(handleURL(_:reply:)),
            forEventClass: AEEventClass(kInternetEventClass), andEventID: AEEventID(kAEGetURL))
        AppModel.shared.bootstrap()
    }

    @objc private func handleURL(_ event: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) {
        guard let text = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue,
              let url = URL(string: text) else { return }
        AppModel.shared.handleCallback(url)
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        urls.forEach { AppModel.shared.handleCallback($0) }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationWillTerminate(_ notification: Notification) {
        AppModel.shared.shutdown()
    }
}

func copyToPasteboard(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
}
