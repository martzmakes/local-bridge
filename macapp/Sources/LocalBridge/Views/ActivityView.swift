import LocalBridgeCore
import SwiftUI

struct ActivityView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let entries = Array(model.activity.entries.reversed())
        Group {
            if entries.isEmpty {
                ContentUnavailableView {
                    Label("No Calls Yet", systemImage: "clock.arrow.circlepath")
                } description: {
                    Text("Calls that agents make through the bridge appear here: when, which tool, and how it ended. Never what was asked or returned. The list starts again each time the app opens.")
                }
            } else {
                Table(entries) {
                    TableColumn("Time") { entry in
                        Text(entry.time.formatted(date: .omitted, time: .standard))
                            .monospacedDigit()
                    }
                    .width(min: 80, ideal: 95)
                    TableColumn("Server") { entry in
                        Text(model.saved?.servers[entry.server]?.title ?? entry.server)
                    }
                    .width(min: 80, ideal: 130)
                    TableColumn("Tool") { entry in
                        Text(entry.tool)
                            .font(.body.monospaced())
                    }
                    TableColumn("Outcome") { entry in
                        Label(Presentation.outcome(entry.outcome),
                              systemImage: entry.succeeded ? "checkmark.circle" : "exclamationmark.triangle")
                            .foregroundStyle(entry.succeeded ? Color.secondary : Color.red)
                    }
                    .width(min: 110, ideal: 150)
                    TableColumn("Duration") { entry in
                        Text(Presentation.duration(milliseconds: entry.milliseconds))
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                    }
                    .width(min: 70, ideal: 80)
                }
            }
        }
        .navigationTitle("Activity")
        .navigationSubtitle(subtitle)
    }

    private var subtitle: String {
        guard let calls = model.status.status?.calls, let total = calls.total else { return "" }
        let failed = calls.failed ?? 0
        return failed == 0 ? "\(total) calls since the bridge started" : "\(total) calls since the bridge started, \(failed) failed"
    }
}
