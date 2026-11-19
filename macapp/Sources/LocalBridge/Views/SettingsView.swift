import LocalBridgeCore
import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        TabView(selection: $model.settingsTab) {
            GeneralSettings()
                .tabItem { Label("General", systemImage: "gearshape") }
                .tag(SettingsTab.general)
            AccountSettings()
                .tabItem { Label("Account", systemImage: "person.crop.circle") }
                .tag(SettingsTab.account)
            PermissionsSettings()
                .tabItem { Label("Permissions", systemImage: "lock.shield") }
                .tag(SettingsTab.permissions)
        }
        .frame(width: 580, height: 520)
    }
}

/// Each field applies on Return or when focus leaves it. There is no Save button here.
struct GeneralSettings: View {
    enum Field: Hashable {
        case machine, node
    }

    @Environment(AppModel.self) private var model
    @ObservedObject private var updater = AppUpdater.shared
    @FocusState private var focus: Field?
    @State private var machine = ""
    @State private var nodePath = ""
    @State private var showingBackend = false
    @State private var errors: [Field: String] = [:]

    var body: some View {
        let readOnly = model.isReadOnly
        Form {
            Section {
                TextField("Name of this Mac", text: $machine)
                    .focused($focus, equals: .machine)
                    .onSubmit { commit(.machine) }
                    .disabled(readOnly)
            } footer: {
                footer(.machine, "Use up to 16 lowercase letters and digits. Changing the name restarts the bridge.")
            }

            Section {
                TextField("Path to node", text: $nodePath, prompt: Text("Found automatically"))
                    .focused($focus, equals: .node)
                    .onSubmit { commit(.node) }
                LabeledContent("In use") {
                    HStack {
                        Text(model.resolvedNode ?? (model.nodeSearched ? "Not found" : "Looking…"))
                            .font(.body.monospaced())
                            .foregroundStyle(model.resolvedNode == nil && model.nodeSearched ? Color.red : Color.secondary)
                            .textSelection(.enabled)
                        Button("Choose…") { chooseNode() }
                    }
                }
            } header: {
                Text("Node")
            } footer: {
                Text("The bridge runs on Node. Leave the path empty to use /opt/homebrew/bin/node, /usr/local/bin/node, or the one your shell finds.")
                    .formFooter()
            }

            Section {
                let config = model.saved ?? model.draft
                LabeledContent("Public HTTPS URL", value: config.effectivePublicBase)
                    .textSelection(.enabled)
                LabeledContent("WebSocket URL", value: config.endpoint)
                    .textSelection(.enabled)
                Button("Choose Backend…") { showingBackend = true }
                    .disabled(!model.canChangeBackend)
            } header: {
                Text("Backend")
            } footer: {
                Text(model.phase == .signedIn
                     ? "Sign out in Account settings to switch backends."
                     : "Choose Local Bridge hosting or enter the URLs from your AWS deployment.")
                    .formFooter()
            }

            if updater.isConfigured {
                Section("Software Updates") {
                    Toggle("Automatically check for updates", isOn: Binding(
                        get: { updater.automaticallyChecks },
                        set: { updater.setAutomaticChecks($0) }))
                    CheckForUpdatesButton()
                }
            }

            Section {
                Toggle("Open at login", isOn: Binding(
                    get: { model.launchAtLogin },
                    set: { model.setLaunchAtLogin($0) }))
            } footer: {
                if let error = model.launchAtLoginError {
                    Text(error)
                        .formFooter(.red)
                }
            }
        }
        .formStyle(.grouped)
        .sheet(isPresented: $showingBackend) { BackendSettingsSheet() }
        .onAppear {
            load()
            model.refreshLaunchAtLogin()
        }
        .onChange(of: focus) { old, _ in
            if let old { commit(old) }
        }
    }

    @ViewBuilder
    private func footer(_ field: Field, _ text: String) -> some View {
        if let error = errors[field] {
            Text(error)
                .formFooter(.red)
        } else {
            Text(text)
                .formFooter()
        }
    }

    private func load() {
        let config = model.saved ?? model.draft
        machine = config.machine
        nodePath = model.nodeOverride
    }

    private func commit(_ field: Field) {
        switch field {
        case .machine:
            errors[.machine] = model.applyGeneral(machine: machine.trimmingCharacters(in: .whitespaces))
        case .node:
            model.setNodeOverride(nodePath)
        }
    }

    private func chooseNode() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.showsHiddenFiles = true
        panel.directoryURL = URL(fileURLWithPath: "/usr/local/bin")
        panel.message = "Choose the node program"
        if panel.runModal() == .OK, let url = panel.url {
            nodePath = url.path
            model.setNodeOverride(url.path)
        }
    }
}

struct BackendSettingsSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var selfHosted = false
    @State private var address = ""
    @State private var connection = ""
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Choose Backend").font(.title2.weight(.semibold))
            Form {
                Picker("Hosting", selection: $selfHosted) {
                    Text("Local Bridge hosting").tag(false)
                    Text("Self-hosted").tag(true)
                }
                if selfHosted {
                    TextField("Public HTTPS URL", text: $address, prompt: Text("https://bridge.example.com"))
                    TextField("WebSocket URL", text: $connection, prompt: Text("wss://bridge-ws.example.com"))
                    Text("Use PublicBaseUrl and DeviceEndpoint from the AWS CDK deployment.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
            .formStyle(.columns)

            if !(model.saved ?? model.draft).servers.isEmpty {
                Text("When you switch backends, your server settings carry over with servers turned off. Review access and turn them back on after signing in.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            if let error {
                Label(error, systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.red)
                    .font(.callout)
            }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Save Backend") {
                    error = model.applyBackend(
                        publicBase: selfHosted ? address : BridgeConfig.defaultPublicBase,
                        endpoint: selfHosted ? connection : BridgeConfig.defaultEndpoint
                    )
                    if error == nil { dismiss() }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!model.canChangeBackend)
            }
        }
        .padding(24)
        .frame(width: 480)
        .onAppear {
            let config = model.saved ?? model.draft
            address = config.effectivePublicBase
            connection = config.endpoint
            selfHosted = address != BridgeConfig.defaultPublicBase || connection != BridgeConfig.defaultEndpoint
            if !selfHosted {
                address = ""
                connection = ""
            }
        }
    }
}

struct AccountSettings: View {
    @Environment(AppModel.self) private var model
    @State private var confirmingSignOut = false
    @State private var removing: String?

    var body: some View {
        Form {
            if model.runsWithoutAccount {
                Section("Account") {
                    Text("This run has no account (LOCAL_BRIDGE_NO_ACCOUNT is set).")
                        .foregroundStyle(.secondary)
                }
            } else if model.phase == .signedOut || model.phase == .waitingForBrowser {
                Section("Account") {
                    LabeledContent("Not signed in") {
                        Button("Sign In with Email…") { model.signIn() }
                            .disabled(model.phase == .waitingForBrowser)
                    }
                    if let error = model.accountError {
                        Text(error)
                            .foregroundStyle(.red)
                    }
                }
            } else {
                Section("Account") {
                    LabeledContent(model.identity?.email ?? "Signed in") {
                        Button("Sign Out…") { confirmingSignOut = true }
                    }
                }
                Section {
                    if !model.machinesLoaded && model.machinesError == nil {
                        HStack {
                            ProgressView()
                                .controlSize(.small)
                            Text("Loading…")
                                .foregroundStyle(.secondary)
                        }
                    }
                    if let error = model.machinesError {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                    }
                    if model.machinesLoaded && model.machines.isEmpty {
                        Text("No Macs are registered yet.")
                            .foregroundStyle(.secondary)
                    }
                    // This Mac first, then the rest by name.
                    let thisMac = model.saved?.machine
                    let ordered = model.machines.sorted {
                        ($0.machine == thisMac ? 0 : 1, $0.machine) < ($1.machine == thisMac ? 0 : 1, $1.machine)
                    }
                    ForEach(ordered) { machine in
                        MachineRow(machine: machine, isThisMac: machine.machine == thisMac) {
                            removing = machine.machine
                        }
                    }
                } header: {
                    HStack {
                        Text("Macs on This Account")
                        Spacer()
                        Button {
                            Task { await model.loadMachines() }
                        } label: {
                            Image(systemName: "arrow.clockwise")
                        }
                        .buttonStyle(.borderless)
                        .help("Refresh the list")
                        .accessibilityLabel("Refresh")
                    }
                } footer: {
                    Text("Every Mac where you sign in with this email joins the same account. Other accounts cannot see or reach them.")
                        .formFooter()
                }
            }
        }
        .formStyle(.grouped)
        .task { await model.loadMachines() }
        .confirmationDialog("Sign out of Local Bridge?", isPresented: $confirmingSignOut) {
            Button("Sign Out", role: .destructive) { model.signOut() }
        } message: {
            Text("The bridge stops on this Mac. Your servers and this Mac’s key are kept, so signing in again picks up where you left off.")
        }
        .confirmationDialog(
            "Remove “\(removing ?? "")” from your account?",
            isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })
        ) {
            Button("Remove", role: .destructive) {
                if let name = removing { model.removeMachine(name) }
                removing = nil
            }
        } message: {
            Text(removing == model.saved?.machine
                 ? "This is the Mac you are using. Its connector URLs stop working until it registers again."
                 : "Its connector URLs stop working. It can join again by signing in on that Mac.")
        }
    }
}

struct MachineRow: View {
    var machine: AccountMachine
    var isThisMac: Bool
    var remove: () -> Void

    var body: some View {
        LabeledContent {
            Button("Remove…", action: remove)
        } label: {
            Label {
                HStack(spacing: 6) {
                    Text(machine.machine)
                    if isThisMac {
                        Text("This Mac")
                            .font(.caption)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(.quaternary, in: Capsule())
                    }
                }
                Text(detail)
            } icon: {
                Image(systemName: Presentation.machineSymbol(machine.machine))
                    .foregroundStyle(.secondary)
            }
            .help(machine.agentVersion.map { "Version \($0)" } ?? "")
        }
    }

    private var detail: String {
        var parts: [String] = []
        if machine.connected == true {
            parts.append("Connected")
        } else if let seen = machine.lastSeen {
            parts.append("Last seen \(seen.formatted(.relative(presentation: .named)))")
        } else {
            parts.append("Not connected")
        }
        let count = machine.servers?.count ?? 0
        parts.append(count == 1 ? "1 server" : "\(count) servers")
        return parts.joined(separator: " · ")
    }
}

struct PermissionsSettings: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let config = model.saved ?? model.draft
        // A server that is off asks for nothing.
        let enabled = config.serverNamesByTitle.filter { config.servers[$0]?.isEnabled == true }
        let known = enabled.compactMap { name -> (String, ServerConfig, KnownServer)? in
            guard let server = config.servers[name], let match = PermissionCatalog.knownServer(for: server) else { return nil }
            return (name, server, match)
        }
        let unknown = enabled.filter { name in !known.contains { $0.0 == name } }
        Form {
            if enabled.isEmpty {
                Section {
                    Text("Add a server first. What it needs from macOS is listed here.")
                        .foregroundStyle(.secondary)
                }
            }
            ForEach(known, id: \.0) { name, server, match in
                Section(server.title ?? name) {
                    ForEach(match.requirements) { requirement in
                        LabeledContent {
                            Button("Open Settings…") {
                                if let url = URL(string: requirement.settingsURL) { NSWorkspace.shared.open(url) }
                            }
                        } label: {
                            Text(requirement.title)
                            Text(requirement.why)
                        }
                    }
                }
            }
            if !unknown.isEmpty {
                Section {
                    ForEach(unknown, id: \.self) { name in
                        LabeledContent(config.servers[name]?.title ?? name) {
                            Text("No known requirements")
                                .foregroundStyle(.secondary)
                        }
                    }
                } header: {
                    Text("Other Servers")
                } footer: {
                    Text("If one of these reads protected data or controls another app, macOS asks the first time it tries. This app starts your servers, so macOS asks in the name of Local Bridge and lists the permissions under Local Bridge in System Settings.")
                        .formFooter()
                }
            }
        }
        .formStyle(.grouped)
    }
}
