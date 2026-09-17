// The app's own state. Every mutation goes through the CLI, off the main thread so the panel
// never waits on a process — and `snapshot` fetches the model list over the network.
import AppKit
import SwiftUI

@MainActor
final class Store: ObservableObject {
    @Published var snap: Snapshot?          // last known state; the panel renders this immediately
    @Published var status = ""
    @Published var busy = false

    /// Read the CLI. `nonisolated` so a click can call it from a background queue.
    nonisolated static func fetch() -> (Snapshot?, String) {
        let (code, out) = hb(["snapshot", "--json"])
        guard code == 0, let data = out.data(using: .utf8),
              let snap = try? JSONDecoder().decode(Snapshot.self, from: data) else {
            return (nil, out.isEmpty ? "could not read Local AI state" : out.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        return (snap, snap.error)
    }

    /// Refresh in the background and publish when it lands.
    func refresh() {
        guard !busy else { return }
        busy = true
        DispatchQueue.global(qos: .userInitiated).async {
            let (snap, status) = Store.fetch()
            DispatchQueue.main.async {
                if let snap { self.snap = snap }
                self.status = status
                self.busy = false
            }
        }
    }

    /// Run a mutating command, then refresh. Nothing here blocks the panel.
    private func act(_ args: [String]) {
        guard !busy else { return }
        busy = true
        DispatchQueue.global(qos: .userInitiated).async {
            let (code, out) = hb(args)
            let failure = code == 0 ? "" : out.trimmingCharacters(in: .whitespacesAndNewlines)
            let (snap, status) = Store.fetch()
            DispatchQueue.main.async {
                if let snap { self.snap = snap }
                self.status = failure.isEmpty ? status : failure
                self.busy = false
            }
        }
    }

    func selectModel(_ id: String) { act(["use", id]) }
    func useProvider(_ id: String) { act(["providers", "use", id]) }
    func removeProvider(_ id: String) { act(["providers", "rm", id]) }
    func setDir(_ path: String) { act(["dir", path]) }
    func setTerminal(_ id: String) { act(["terminal", id]) }
    func setPinned(_ model: String, _ on: Bool) { act([on ? "pin" : "unpin", model]) }

    func saveProvider(id: String?, name: String, url: String, key: String, apis: [String], reasoning: String) {
        var args = ["providers", "add", "--name", name, "--url", url]
        if let id { args += ["--id", id] }
        if !key.isEmpty { args += ["--key", key] }   // empty means "keep the stored key"
        args += ["--apis", apis.isEmpty ? "chat" : apis.joined(separator: ","), "--reasoning", reasoning]
        act(args)
    }

    func chooseDirectory() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Use this folder"
        panel.directoryURL = URL(fileURLWithPath: snap?.sessionDir ?? NSHomeDirectory())
        if panel.runModal() == .OK, let url = panel.url { setDir(url.path) }
    }

    /// A launch opens a terminal, so the command is the handshake, not the session.
    func launch(_ id: String) {
        let terminal = snap?.terminal.active ?? "terminal"
        status = "opening \(id) in \(terminal)…"
        DispatchQueue.global(qos: .userInitiated).async {
            let (code, out) = hb(["run", "--harness", id])
            DispatchQueue.main.async {
                self.status = code == 0 ? "" : out.trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
    }

    func openWeb() {
        let port: UInt16 = 4141
        if portOpen(port) { NSWorkspace.shared.open(URL(string: "http://127.0.0.1:\(port)")!); return }
        do { try hbProcess(["serve", "--port", String(port)]).run() } catch {
            status = "could not start the web UI: \(error.localizedDescription)"; return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            for _ in 0..<40 {
                if portOpen(port) { break }
                Thread.sleep(forTimeInterval: 0.25)
            }
            DispatchQueue.main.async {
                if portOpen(port) { NSWorkspace.shared.open(URL(string: "http://127.0.0.1:\(port)")!) }
                else { self.status = "the web UI did not start" }
            }
        }
    }
}

/// The panel's fixed size, shared by the hosting controller and the popover.
let panelSize = NSSize(width: 420, height: 620)

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let store = Store()
    var status: NSStatusItem!
    let popover = NSPopover()

    func applicationDidFinishLaunching(_ note: Notification) {
        status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let mark = NSImage(systemSymbolName: "arrow.left.arrow.right", accessibilityDescription: "Local AI") {
            status.button?.image = mark
        } else {
            status.button?.title = "Local AI"
        }
        status.button?.action = #selector(toggle)
        status.button?.target = self
        status.button?.toolTip = "Local AI"

        let hosting = NSHostingController(rootView: PopoverView(store: store))
        // NSPopover sizes to the controller's fitting size; without this it clamps to 320x320
        // and the laid-out panel is squeezed
        hosting.view.frame = NSRect(x: 0, y: 0, width: panelSize.width, height: panelSize.height)
        hosting.preferredContentSize = panelSize
        hosting.sizingOptions = []
        hosting.view.wantsLayer = true
        popover.contentViewController = hosting
        popover.contentSize = panelSize
        popover.behavior = .transient
        popover.animates = false
        // the appearance is NOT forced: the panel follows the system, and is opaque because
        // its content paints windowBackgroundColor rather than sitting on popover vibrancy

        trace("launched")
        store.refresh()   // warm the cache so the first click is instant
    }

    @objc func toggle() {
        trace("toggle: isShown=\(popover.isShown) button=\(status.button != nil)")
        if popover.isShown {
            popover.performClose(nil)
            return
        }
        guard let button = status.button else { return }
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        trace("shown=\(popover.isShown) size=\(popover.contentSize)")
        if let w = popover.contentViewController?.view.window {
            let f = w.frame, sh = NSScreen.main?.frame.height ?? 0
            trace("rect=\(Int(f.minX)),\(Int(sh - f.maxY)),\(Int(f.width)),\(Int(f.height))")
        }
        NSApplication.shared.activate(ignoringOtherApps: true)
        store.refresh()   // update in place; the panel is already up
    }
}