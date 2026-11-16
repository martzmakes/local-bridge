import AppKit
import LocalBridgeCore
import SwiftUI

/// Renders every screen of the app to PNG from fixed sample state, without showing a window.
///
/// The views are the real ones. Each is hosted in a real NSWindow that is never ordered on
/// screen, laid out, and drawn into a bitmap at 2x. No daemon, Keychain, network or file
/// outside the output directory is involved.
@MainActor
enum SnapshotRunner {
    static let environmentKey = "LOCAL_BRIDGE_SNAPSHOT_DIR"

    enum Chrome {
        /// The main window: title bar and unified toolbar, bridged from the SwiftUI view.
        case mainWindow(NSSize)
        /// The Settings window: preference-style toolbar tabs with one selected.
        case settings(SettingsTab)
        /// A sheet's content on its own.
        case sheet
        /// The menu bar item's menu content on its own.
        case menu
    }

    struct Screen {
        var name: String
        var chrome: Chrome
        var state: PreviewState
        var content: (AppModel) -> AnyView
    }

    static func run(directory: URL) -> Never {
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        // The snapshot binary has no bundle, so the icon is handed in.
        if let icon = ProcessInfo.processInfo.environment["LOCAL_BRIDGE_SNAPSHOT_ICON"], let image = NSImage(contentsOfFile: icon) {
            application.applicationIconImage = image
        }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        } catch {
            FileHandle.standardError.write(Data("cannot create \(directory.path)\n".utf8))
            exit(2)
        }

        let live = ProcessInfo.processInfo.environment["LOCAL_BRIDGE_SNAPSHOT_LIVE"] == "1"
        if live {
            application.setActivationPolicy(.regular)
            application.finishLaunching()
            application.activate(ignoringOtherApps: true)
            NSRunningApplication.current.activate(options: [.activateAllWindows])
        }

        var failures = 0
        for screen in screens() {
            for (suffix, appearanceName) in [("light", NSAppearance.Name.aqua), ("dark", .darkAqua)] {
                let url = directory.appendingPathComponent("\(screen.name)-\(suffix).png")
                let model = AppModel(preview: screen.state, directory: directory)
                let appearance = NSAppearance(named: appearanceName)!
                var result: (bitmap: NSBitmapImageRep?, note: String) = (nil, "")
                if live {
                    result = renderLive(screen, model: model, appearance: appearance, scratch: url, directory: directory)
                }
                if result.bitmap == nil {
                    let fallback = result.note
                    result = render(screen, model: model, appearance: appearance)
                    if live { result.note = "offscreen: \(fallback.isEmpty ? result.note : fallback)" }
                }
                guard let bitmap = result.bitmap, let png = bitmap.representation(using: .png, properties: [:]) else {
                    print("FAILED \(url.path): could not render")
                    failures += 1
                    continue
                }
                do {
                    try png.write(to: url)
                } catch {
                    print("FAILED \(url.path): could not write")
                    failures += 1
                    continue
                }
                let colors = distinctColors(in: bitmap)
                let flat = colors < 12
                if flat { failures += 1 }
                print("\(flat ? "FLAT " : "")\(url.path) \(bitmap.pixelsWide)x\(bitmap.pixelsHigh) colors=\(colors) \(result.note)")
            }
        }
        exit(failures == 0 ? 0 : 1)
    }

    // MARK: - Screens

    static func screens() -> [Screen] {
        let mainSize = NSSize(width: 980, height: 760)
        let main = mainContent
        func mainScreen(_ name: String, _ state: PreviewState, size: NSSize = mainSize) -> Screen {
            Screen(name: name, chrome: .mainWindow(size), state: state, content: main)
        }

        var signedOut = PreviewState()
        signedOut.phase = .signedOut

        var naming = PreviewState()
        naming.phase = .namingMachine
        naming.proposedMachineName = "mini"
        naming.identity = AccountIdentity(email: "matt@example.com", uid: SampleData.uid)

        var empty = SampleData.populated(selection: nil)
        empty.saved = SampleData.emptyConfig
        empty.status = SampleData.status(servers: false)
        empty.activity = ActivityBuffer()
        empty.inspections = InspectCache()

        var unsaved = SampleData.populated()
        var edited = SampleData.config
        edited.servers["notes"]?.setTool("create_note", exposed: true, access: .write)
        unsaved.draft = edited

        var nodeMissing = SampleData.populated()
        nodeMissing.status = .notRunning(lastKnown: nil)
        nodeMissing.supervisorState = .stopped
        nodeMissing.blocker = .nodeMissing
        nodeMissing.resolvedNode = nil

        var offline = SampleData.populated()
        offline.status = SampleData.status(state: "offline", lastError: "Error ECONNREFUSED")

        func settings(_ name: String, _ tab: SettingsTab, _ view: @escaping (AppModel) -> AnyView) -> Screen {
            var state = SampleData.populated()
            state.settingsTab = tab
            return Screen(name: name, chrome: .settings(tab), state: state, content: view)
        }

        var stdioDraft = ServerConfig(transport: .stdio, command: "/usr/local/bin/node", args: ["/Users/example/dev/apple-calendar-mcp/dist/index.js"])
        stdioDraft.title = "Calendar"
        var remoteDraft = ServerConfig(transport: .sse, url: "http://127.0.0.1:8123/mcp_server/sse")
        remoteDraft.title = "Home Assistant"
        remoteDraft.headers = ["Authorization": "keychain:local-bridge.ha-token"]
        var sheetState = SampleData.populated()
        var withoutExtras = SampleData.config
        withoutExtras.servers["calendar"] = nil
        withoutExtras.servers["ha"] = nil
        sheetState.saved = withoutExtras

        let menu: (AppModel) -> AnyView = { model in AnyView(MenuSnapshot().environment(model)) }

        return [
            mainScreen("signin", signedOut, size: NSSize(width: 940, height: 640)),
            mainScreen("first-run-machine-name", naming, size: NSSize(width: 940, height: 640)),
            mainScreen("main-notes", SampleData.populated(), size: NSSize(width: 980, height: 1000)),
            mainScreen("main-ha-down", SampleData.populated(selection: .server("ha"))),
            mainScreen("main-empty", empty, size: NSSize(width: 940, height: 640)),
            mainScreen("main-unsaved", unsaved, size: NSSize(width: 980, height: 1000)),
            mainScreen("main-node-missing", nodeMissing),
            mainScreen("activity", SampleData.populated(selection: .activity), size: NSSize(width: 940, height: 640)),
            Screen(name: "add-server", chrome: .sheet, state: sheetState) { model in
                AnyView(AddServerSheet(name: "calendar", server: stdioDraft).environment(model))
            },
            Screen(name: "add-server-remote", chrome: .sheet, state: sheetState) { model in
                AnyView(AddServerSheet(name: "ha", server: remoteDraft).environment(model))
            },
            settings("settings-general", .general) { AnyView(GeneralSettings().environment($0)) },
            settings("settings-account", .account) { AnyView(AccountSettings().environment($0)) },
            settings("settings-permissions", .permissions) { AnyView(PermissionsSettings().environment($0)) },
            Screen(name: "menubar-connected", chrome: .menu, state: SampleData.populated(), content: menu),
            Screen(name: "menubar-offline", chrome: .menu, state: offline, content: menu),
            Screen(name: "menubar-signedout", chrome: .menu, state: signedOut, content: menu),
        ]
    }

    // MARK: - Rendering

    // MARK: - Live capture

    private static let mainContent: (AppModel) -> AnyView = { model in
        AnyView(RootView().environment(model).frame(minWidth: 760, minHeight: 480))
    }

    private static func makeMainWindow(_ content: AnyView, size: NSSize, appearance: NSAppearance) -> NSWindow {
        let controller = NSHostingController(rootView: content)
        controller.sceneBridgingOptions = [.all]
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.title = "Local Bridge"
        window.toolbarStyle = .unified
        window.contentViewController = controller
        window.setContentSize(size)
        window.appearance = appearance
        window.isReleasedWhenClosed = false
        return window
    }

    private static func show(_ window: NSWindow) {
        window.center()
        window.makeKeyAndOrderFront(nil)
        window.orderFrontRegardless()
        NSApplication.shared.activate(ignoringOtherApps: true)
        NSRunningApplication.current.activate(options: [.activateAllWindows])
        let deadline = Date().addingTimeInterval(2)
        while !(window.isKeyWindow && NSApplication.shared.isActive), Date() < deadline {
            settle(0.05)
            if !window.isKeyWindow { window.makeKey() }
        }
        settle(0.7)
    }

    /// Captures one on-screen window with the system tool. nil when it produced nothing usable,
    /// which is what happens without the Screen Recording permission.
    private static func screencapture(_ window: NSWindow, to url: URL) -> NSBitmapImageRep? {
        try? FileManager.default.removeItem(at: url)
        let tool = Process()
        tool.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        tool.arguments = ["-x", "-o", "-l", String(window.windowNumber), url.path]
        tool.standardOutput = FileHandle.nullDevice
        tool.standardError = FileHandle.nullDevice
        guard (try? tool.run()) != nil else { return nil }
        tool.waitUntilExit()
        guard tool.terminationStatus == 0, let data = try? Data(contentsOf: url),
              let bitmap = NSBitmapImageRep(data: data), distinctColors(in: bitmap) >= 12 else { return nil }
        return bitmap
    }

    /// Shows the real window (or a real sheet on the main window), key and active, and captures it.
    /// Settings and the menu are left to the offscreen renderer.
    static func renderLive(_ screen: Screen, model: AppModel, appearance: NSAppearance, scratch: URL, directory: URL) -> (bitmap: NSBitmapImageRep?, note: String) {
        NSApplication.shared.appearance = appearance
        switch screen.chrome {
        case .mainWindow(let size):
            let window = makeMainWindow(screen.content(model), size: size, appearance: appearance)
            show(window)
            let bitmap = screencapture(window, to: scratch)
            let note = window.isKeyWindow && NSApplication.shared.isActive ? "live window" : "live window (not key)"
            window.contentViewController = nil
            window.close()
            settle(0.2)
            return (bitmap, bitmap == nil ? "screencapture produced nothing" : note)
        case .sheet:
            let parentModel = AppModel(preview: SampleData.populated(), directory: directory)
            let parent = makeMainWindow(mainContent(parentModel), size: NSSize(width: 980, height: 760), appearance: appearance)
            show(parent)
            let controller = NSHostingController(rootView: screen.content(model))
            let sheet = NSWindow(contentViewController: controller)
            sheet.styleMask = [.titled]
            sheet.appearance = appearance
            sheet.isReleasedWhenClosed = false
            sheet.setContentSize(controller.sizeThatFits(in: NSSize(width: 2000, height: 2000)))
            parent.beginSheet(sheet)
            settle(1.0)
            let bitmap = screencapture(sheet, to: scratch)
            parent.endSheet(sheet)
            settle(0.4)
            sheet.contentViewController = nil
            parent.contentViewController = nil
            parent.close()
            settle(0.2)
            return (bitmap, bitmap == nil ? "screencapture produced nothing" : "live sheet")
        case .settings, .menu:
            return (nil, "")
        }
    }

    private static func settle(_ seconds: TimeInterval) {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end {
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.02))
        }
    }

    static func render(_ screen: Screen, model: AppModel, appearance: NSAppearance) -> (bitmap: NSBitmapImageRep?, note: String) {
        NSApplication.shared.appearance = appearance
        let window: NSWindow
        var captureFrame = true
        var toolbarDelegate: SettingsToolbar?

        switch screen.chrome {
        case .mainWindow(let size):
            let controller = NSHostingController(rootView: screen.content(model))
            controller.sceneBridgingOptions = [.all]
            window = NSWindow(
                contentRect: NSRect(origin: .zero, size: size),
                styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                backing: .buffered, defer: false)
            window.title = "Local Bridge"
            window.toolbarStyle = .unified
            window.contentViewController = controller
            window.setContentSize(size)
        case .settings(let tab):
            let size = NSSize(width: 580, height: 560)
            let controller = NSHostingController(rootView: AnyView(screen.content(model).frame(width: size.width, height: size.height)))
            window = NSWindow(
                contentRect: NSRect(origin: .zero, size: size),
                styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
            // The Settings scene builds this toolbar itself; here it is rebuilt the same way around the real tab content.
            let delegate = SettingsToolbar()
            let toolbar = NSToolbar(identifier: "settings")
            toolbar.delegate = delegate
            toolbar.displayMode = .iconAndLabel
            toolbar.allowsUserCustomization = false
            window.toolbar = toolbar
            window.toolbarStyle = .preference
            toolbar.selectedItemIdentifier = delegate.identifier(for: tab)
            toolbarDelegate = delegate
            window.title = delegate.title(for: tab)
            window.contentViewController = controller
            window.setContentSize(size)
        case .sheet:
            let controller = NSHostingController(rootView: screen.content(model))
            let size = controller.sizeThatFits(in: NSSize(width: 2000, height: 2000))
            window = NSWindow(
                contentRect: NSRect(origin: .zero, size: size),
                styleMask: [.titled], backing: .buffered, defer: false)
            window.contentViewController = controller
            window.setContentSize(size)
            captureFrame = false
        case .menu:
            let controller = NSHostingController(rootView: screen.content(model))
            let size = controller.sizeThatFits(in: NSSize(width: 2000, height: 2000))
            window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
            window.contentViewController = controller
            window.setContentSize(size)
            captureFrame = false
        }

        window.appearance = appearance
        window.isReleasedWhenClosed = false
        window.layoutIfNeeded()
        settle(0.6)
        window.layoutIfNeeded()
        window.displayIfNeeded()
        settle(0.2)

        if ProcessInfo.processInfo.environment["LOCAL_BRIDGE_SNAPSHOT_DEBUG"] != nil, let content = window.contentView {
            print("debug \(screen.name): window \(window.frame) content \(content.frame) fitting \(content.fittingSize)")
        }
        var note = ""
        var bitmap: NSBitmapImageRep?
        if captureFrame, let frameView = window.contentView?.superview {
            bitmap = capture(frameView)
            note = "window with title bar"
        }
        if bitmap == nil, let content = window.contentView {
            bitmap = capture(content, background: appearance)
            note = captureFrame ? "content only: the frame view could not be captured" : "content only"
        }
        withExtendedLifetime(toolbarDelegate) {}
        window.contentViewController = nil
        window.close()
        return (bitmap, note)
    }

    /// `background`: fill with the window background first. A content view on its own does not
    /// draw it, so parts of a sheet with no background of their own would come out transparent.
    private static func capture(_ view: NSView, background: NSAppearance? = nil) -> NSBitmapImageRep? {
        let bounds = view.bounds
        guard bounds.width >= 1, bounds.height >= 1,
              let bitmap = NSBitmapImageRep(
                bitmapDataPlanes: nil, pixelsWide: Int(bounds.width * 2), pixelsHigh: Int(bounds.height * 2),
                bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
        bitmap.size = bounds.size
        if let background, let context = NSGraphicsContext(bitmapImageRep: bitmap) {
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = context
            background.performAsCurrentDrawingAppearance {
                NSColor.windowBackgroundColor.setFill()
                NSRect(origin: .zero, size: bounds.size).fill()
            }
            NSGraphicsContext.restoreGraphicsState()
        }
        view.cacheDisplay(in: bounds, to: bitmap)
        return bitmap
    }

    /// How many different colours a coarse sample of the image has. A blank render has one or two.
    static func distinctColors(in bitmap: NSBitmapImageRep) -> Int {
        guard let data = bitmap.bitmapData else { return 0 }
        let bytesPerPixel = bitmap.bitsPerPixel / 8
        var seen = Set<UInt32>()
        var y = 0
        while y < bitmap.pixelsHigh {
            var x = 0
            while x < bitmap.pixelsWide {
                let p = data + y * bitmap.bytesPerRow + x * bytesPerPixel
                // Quantized, so antialiasing noise does not count as content.
                seen.insert(UInt32(p[0] >> 3) << 16 | UInt32(p[1] >> 3) << 8 | UInt32(p[2] >> 3))
                x += 3
            }
            y += 3
        }
        return seen.count
    }
}

/// The three tabs of the Settings window as a preference toolbar.
private final class SettingsToolbar: NSObject, NSToolbarDelegate {
    private let tabs: [(SettingsTab, String, String)] = [
        (.general, "General", "gearshape"),
        (.account, "Account", "person.crop.circle"),
        (.permissions, "Permissions", "lock.shield"),
    ]

    func identifier(for tab: SettingsTab) -> NSToolbarItem.Identifier {
        NSToolbarItem.Identifier(title(for: tab))
    }

    func title(for tab: SettingsTab) -> String {
        tabs.first { $0.0 == tab }?.1 ?? ""
    }

    private var identifiers: [NSToolbarItem.Identifier] { tabs.map { NSToolbarItem.Identifier($0.1) } }

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { identifiers }
    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { identifiers }
    func toolbarSelectableItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] { identifiers }

    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier itemIdentifier: NSToolbarItem.Identifier, willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        guard let tab = tabs.first(where: { $0.1 == itemIdentifier.rawValue }) else { return nil }
        let item = NSToolbarItem(itemIdentifier: itemIdentifier)
        item.label = tab.1
        item.image = NSImage(systemSymbolName: tab.2, accessibilityDescription: tab.1)
        return item
    }
}

/// The menu bar item for a snapshot: its icon, then the real menu content laid out as a menu would.
struct MenuSnapshot: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                MenuBarLabel()
                    .font(.system(size: 15))
                Text("Menu bar item")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 7) {
                MenuBarContent()
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .frame(width: 320, alignment: .leading)
            .background(Color(nsColor: .windowBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color(nsColor: .separatorColor)))
        }
        .padding(16)
        .background(Color(nsColor: .underPageBackgroundColor))
    }
}
