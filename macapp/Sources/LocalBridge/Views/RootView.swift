import LocalBridgeCore
import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if model.phase == .signedIn {
            MainView()
        } else {
            SignInView()
        }
    }
}

struct SignInView: View {
    @Environment(AppModel.self) private var model
    @State private var showingBackend = false

    var body: some View {
        @Bindable var model = model
        VStack(spacing: 16) {
            Image(nsImage: NSApp.applicationIconImage)
                .resizable()
                .frame(width: 96, height: 96)
                .accessibilityHidden(true)
            Text("Local Bridge")
                .font(.largeTitle.weight(.semibold))

            switch model.phase {
            case .waitingForBrowser:
                Text("Finish signing in in your browser. Enter your email there, then open the link that is emailed to you.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: 380)
                ProgressView()
                    .controlSize(.small)
                Button("Cancel") { model.cancelSignIn() }
            case .namingMachine:
                Text("Give this Mac a short name so you can identify it in your Local Bridge account.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: 380)
                TextField("Name", text: $model.proposedMachineName)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 220)
                    .onSubmit { model.confirmMachineName() }
                Text("Lowercase letters and digits, up to 16.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if model.isRegistering {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Button("Continue") { model.confirmMachineName() }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .disabled(!ConfigValidator.isValidName(model.proposedMachineName.trimmingCharacters(in: .whitespaces)))
                    Button("Sign Out") { model.signOut() }
                        .buttonStyle(.link)
                }
            default:
                Text("Give the MCP servers on this Mac their own private addresses, so your agents can reach them from anywhere.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: 380)
                Button("Sign In with Email…") { model.signIn() }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .keyboardShortcut(.defaultAction)
                Text("Your browser opens and a sign-in link is emailed to you. No password.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button("Choose Backend…") { showingBackend = true }
                    .buttonStyle(.link)
                    .disabled(!model.canChangeBackend)
                if (model.saved ?? model.draft).effectivePublicBase != BridgeConfig.defaultPublicBase {
                    Text((model.saved ?? model.draft).effectivePublicBase)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            }

            if let error = model.accountError {
                Label(error, systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.red)
                    .font(.callout)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 420)
            }
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .sheet(isPresented: $showingBackend) { BackendSettingsSheet() }
    }
}
