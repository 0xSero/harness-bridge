// harness-bridge tray — a menu bar panel over the `harness-bridge` CLI.
// The CLI does the work; this only presents it. All state comes from `snapshot --json`.
import AppKit
import SwiftUI

// MARK: - state

@MainActor
final class Store: ObservableObject {
    @Published var snap: Snapshot?
    @Published var status = ""
    @Published var editing: Snapshot.Provider?

    func refresh() {
        let (code, out) = hb(["snapshot", "--json"])
        guard code == 0, let data = out.data(using: .utf8),
              let snap = try? JSONDecoder().decode(Snapshot.self, from: data) else {
            status = out.isEmpty ? "could not read harness-bridge state" : out.trimmingCharacters(in: .whitespacesAndNewlines)
            return
        }
        self.snap = snap
        status = snap.error
    }

    func selectModel(_ id: String) { act(["use", id]) }
    func useProvider(_ id: String) { act(["providers", "use", id]) }
    func setReasoning(_ level: String, provider: String) { act(["providers", "reasoning", level, provider]) }
    func setTerminal(_ id: String) { act(["terminal", id]) }
    func setDir(_ path: String) { act(["dir", path]) }
    func remove(_ id: String) { act(["providers", "rm", id]) }

    func launch(_ id: String) {
        // a launch opens a terminal, so the exit code is the handshake, not the session
        let (code, out) = hb(["run", "--harness", id])
        status = code == 0 ? "" : out.trimmingCharacters(in: .whitespacesAndNewlines)
        refresh()
    }

    func saveProvider(name: String, url: String, key: String, apis: [String], reasoning: String) {
        var args = ["providers", "add", "--name", name, "--url", url, "--key", key]
        args += ["--apis", apis.isEmpty ? "chat" : apis.joined(separator: ",")]
        args += ["--api", apis.first ?? "chat", "--reasoning", reasoning]
        act(args)
    }

    func openWeb() {
        let port: UInt16 = 4141
        if !portOpen(port) {
            do { try hbProcess(["serve", "--port", String(port)]).run() } catch {
                status = "could not start the web UI: \(error.localizedDescription)"; return
            }
            for _ in 0..<40 where !portOpen(port) { Thread.sleep(forTimeInterval: 0.25) }
            guard portOpen(port) else { status = "the web UI did not start"; return }
        }
        NSWorkspace.shared.open(URL(string: "http://127.0.0.1:\(port)")!)
    }

    private func act(_ args: [String]) {
        let (code, out) = hb(args)
        status = code == 0 ? "" : out.trimmingCharacters(in: .whitespacesAndNewlines)
        refresh()
    }
}

// MARK: - views

func title(_ text: String) -> some View {
    Text(text.uppercased())
        .font(.system(size: 10, weight: .semibold))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
}

struct Row<Content: View>: View {
    let selected: Bool
    let action: () -> Void
    @ViewBuilder var content: Content
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) { content; Spacer(minLength: 0) }
                .padding(.horizontal, 12).padding(.vertical, 5)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(selected ? Color.accentColor.opacity(0.18) : (hover ? Color.primary.opacity(0.06) : .clear))
        .onHover { hover = $0 }
    }
}

struct PopoverView: View {
    @ObservedObject var store: Store
    @State private var showSettings = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            ScrollView { sections }
            Divider()
            footer
        }
        .frame(width: 380)
        .task { store.refresh() }
        .sheet(isPresented: $showSettings) { SettingsView(store: store, editing: store.editing) }
    }

    var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 1) {
                Text(store.snap?.providers.first(where: \.selected)?.name ?? "harness-bridge")
                    .font(.system(size: 13, weight: .semibold))
                if let provider = store.snap?.providers.first(where: \.selected) {
                    Text(provider.apiUrl).font(.system(size: 11)).foregroundStyle(.secondary)
                    Text("reasoning \(provider.reasoning) · \(provider.apis.joined(separator: ", "))")
                        .font(.system(size: 10)).foregroundStyle(.tertiary)
                } else {
                    Text("no provider configured").font(.system(size: 11)).foregroundStyle(.secondary)
                }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 1) {
                Button("Web UI") { store.openWeb() }.buttonStyle(.link).font(.system(size: 11))
                Text("opens in \(store.snap?.terminal.active ?? "?")")
                    .font(.system(size: 10)).foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
    }

    var sections: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let snap = store.snap {
                title("Models · \(snap.models.count)")
                ForEach(snap.models) { m in
                    Row(selected: m.id == snap.selected.model) {
                        store.selectModel(m.id)
                    } content: {
                        Text(m.id).font(.system(size: 12)).lineLimit(1)
                        Text(meta(m)).font(.system(size: 10)).foregroundStyle(.secondary)
                    }
                }
                title("Harnesses")
                ForEach(snap.harnesses) { h in
                    Row(selected: false, action: { if h.compatible { store.launch(h.id) } }) {
                        Text(h.installed ? "●" : "○").font(.system(size: 9))
                            .foregroundStyle(h.installed ? .primary : .tertiary)
                        VStack(alignment: .leading, spacing: 0) {
                            Text(h.label).font(.system(size: 12))
                            Text(detail(h)).font(.system(size: 10)).foregroundStyle(.secondary)
                        }
                    }
                    .disabled(!h.compatible)
                    .opacity(h.compatible ? 1 : 0.45)
                }
                if !snap.providers.isEmpty {
                    title("Providers")
                    ForEach(snap.providers) { p in
                        Row(selected: p.selected) { store.useProvider(p.id) } content: {
                            Text(p.name).font(.system(size: 12))
                            Text(p.reasoning).font(.system(size: 10)).foregroundStyle(.secondary)
                        }
                    }
                }
            } else {
                Text("reading state…").font(.system(size: 11)).foregroundStyle(.secondary)
                    .padding(.horizontal, 12).padding(.vertical, 8)
            }
            if !store.status.isEmpty {
                Text(store.status).font(.system(size: 10)).foregroundStyle(.red)
                    .padding(.horizontal, 12).padding(.vertical, 6)
            }
        }
    }

    func meta(_ m: Snapshot.Model) -> String {
        var parts: [String] = []
        if let ctx = m.contextWindow { parts.append("\(ctx / 1024)k ctx") }
        if m.vision == true { parts.append("vision") }
        return parts.joined(separator: " · ")
    }

    func detail(_ h: Snapshot.Harness) -> String {
        if !h.compatible { return "\(h.dialect) · not served by this endpoint" }
        if !h.installed { return h.installable ? "\(h.dialect) · will install" : h.hint }
        return h.reasons ? "\(h.dialect) · reasoning configurable" : h.dialect
    }

    var footer: some View {
        HStack(spacing: 8) {
            Text("0.1.0").font(.system(size: 10)).foregroundStyle(.tertiary)
            Spacer()
            Button("Settings") { store.editing = store.snap?.providers.first(where: \.selected); showSettings = true }
                .font(.system(size: 11))
            Button("Quit") { NSApplication.shared.terminate(nil) }.font(.system(size: 11))
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
    }
}

// MARK: - menu bar

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let store = Store()
    var status: NSStatusItem!
    let popover = NSPopover()

    func applicationDidFinishLaunching(_ note: Notification) {
        status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        status.button?.title = "⇄"
        status.button?.action = #selector(toggle)
        status.button?.target = self
        popover.contentViewController = NSHostingController(rootView: PopoverView(store: store))
        popover.behavior = .transient
    }

    @objc func toggle() {
        store.refresh()
        if popover.isShown {
            popover.performClose(nil)
        } else if let button = status.button {
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            NSApplication.shared.activate(ignoringOtherApps: true)
        }
    }
}

// top-level code is not main-actor isolated under Swift 6, and AppKit wants the main thread
@MainActor
func bootstrap() {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let delegate = AppDelegate()
    app.delegate = delegate
    app.run()
}

MainActor.assumeIsolated { bootstrap() }