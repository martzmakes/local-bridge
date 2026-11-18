import AppKit
import Combine
import Sparkle
import SwiftUI

@MainActor
final class AppUpdater: ObservableObject {
    static let shared = AppUpdater()

    @Published private(set) var canCheck = false
    @Published private(set) var automaticallyChecks = false
    private var controller: SPUStandardUpdaterController?

    var isConfigured: Bool {
        guard let feed = Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") as? String,
              let url = URL(string: feed), url.scheme == "https", url.host != nil,
              let key = Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") as? String
        else { return false }
        return Data(base64Encoded: key)?.count == 32
    }

    func start() {
        guard isConfigured, controller == nil else { return }
        let controller = SPUStandardUpdaterController(
            startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
        self.controller = controller
        controller.updater.publisher(for: \.canCheckForUpdates)
            .receive(on: RunLoop.main)
            .assign(to: &$canCheck)
        controller.updater.publisher(for: \.automaticallyChecksForUpdates)
            .receive(on: RunLoop.main)
            .assign(to: &$automaticallyChecks)
    }

    func checkForUpdates() {
        NSApp.activate(ignoringOtherApps: true)
        controller?.checkForUpdates(nil)
    }

    func setAutomaticChecks(_ value: Bool) {
        controller?.updater.automaticallyChecksForUpdates = value
    }
}

struct CheckForUpdatesButton: View {
    @ObservedObject private var updater = AppUpdater.shared

    var body: some View {
        if updater.isConfigured {
            Button("Check for Updates…") { updater.checkForUpdates() }
                .disabled(!updater.canCheck)
        }
    }
}
