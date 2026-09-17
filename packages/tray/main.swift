// harness-bridge tray — a macOS menu bar front end over the `harness-bridge` CLI.
// Every action shells out to the same core the CLI and web UI use; no state of its own.
import AppKit
import Foundation

/// The CLI to drive. A bundle opened from Finder or `open` inherits a minimal PATH
/// (/usr/bin:/bin:/usr/sbin:/sbin), so the shell cannot find `harness-bridge`; the
/// absolute path is resolved here and the binary is exec'd directly.
let HB: String = {
    if let explicit = ProcessInfo.processInfo.environment["HB_BIN"], !explicit.isEmpty { return explicit }
    let home = NSHomeDirectory()
    let candidates = [
        "\(home)/.bun/bin/harness-bridge",
        "\(home)/.local/bin/harness-bridge",
        "/opt/homebrew/bin/harness-bridge",
        "/usr/local/bin/harness-bridge",
    ]
    for path in candidates where FileManager.default.isExecutableFile(atPath: path) { return path }
    return "harness-bridge" // last resort: let env search PATH
}()

let HB_DEBUG = ProcessInfo.processInfo.environment["HB_DEBUG"] == "1"

/// The environment a GUI-launched app must hand to the CLI: its own PATH cannot find `bun`
/// (the installed CLI is a `#!/usr/bin/env bun` shim) or the global bin directories.
let HB_ENV: [String: String] = {
    var env = ProcessInfo.processInfo.environment
    let home = NSHomeDirectory()
    let dirs = [
        (HB as NSString).deletingLastPathComponent,
        "\(home)/.bun/bin",
        "\(home)/.local/bin",
        "/opt/homebrew/bin",
        "/usr/local/bin",
    ].filter { !$0.isEmpty && FileManager.default.fileExists(atPath: $0) }
    env["PATH"] = (dirs + [env["PATH"] ?? "/usr/bin:/bin"]).joined(separator: ":")
    return env
}()

func trace(_ line: String) {
    guard HB_DEBUG else { return }
    let path = NSHomeDirectory() + "/.config/harness-bridge/tray.log"
    let stamped = ISO8601DateFormatter().string(from: Date()) + " " + line + "\n"
    guard let data = stamped.data(using: .utf8) else { return }
    if let handle = FileHandle(forWritingAtPath: path) {
        handle.seekToEndOfFile()
        handle.write(data)
        try? handle.close()
    } else {
        try? data.write(to: URL(fileURLWithPath: path))
    }
}

/// Whether something is already listening on a loopback port.
func portOpen(_ port: UInt16) -> Bool {
    let s = socket(AF_INET, SOCK_STREAM, 0)
    guard s >= 0 else { return false }
    defer { close(s) }
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = port.bigEndian
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    let r = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            connect(s, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
    }
    return r == 0
}

/// Every CLI invocation goes through here: a GUI-launched app must supply its own PATH
/// (see HB_ENV) or the CLI's `#!/usr/bin/env bun` shebang cannot resolve.
func hbProcess(_ args: [String]) -> Process {
    let p = Process()
    if HB.contains("/") {
        p.executableURL = URL(fileURLWithPath: HB)
        p.arguments = args
    } else {
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = [HB] + args
    }
    p.environment = HB_ENV
    return p
}

func hb(_ args: [String]) -> (Int32, String) {
    let p = hbProcess(args)
    let out = Pipe()
    p.standardOutput = out
    p.standardError = out
    do { try p.run() } catch {
        trace("hb \(args.joined(separator: " ")) -> cannot run \(HB): \(error.localizedDescription)")
        return (127, "cannot run \(HB): \(error.localizedDescription)")
    }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    let text = String(decoding: data, as: UTF8.self)
    trace("hb \(args.joined(separator: " ")) -> \(p.terminationStatus) \(text.prefix(200).replacingOccurrences(of: "\n", with: " | "))")
    return (p.terminationStatus, text)
}

/// A CLI listing line, without its escape codes or its marker column.
struct Row {
    let id: String
    let selected: Bool
    let detail: String
}

/// Escape sequences never belong in a menu title. The CLI omits them when stdout is not a
/// terminal, but a menu must not depend on that being honoured.
func stripANSI(_ s: String) -> String {
    guard s.contains("\u{1B}") else { return s }
    var out = ""
    var inEscape = false
    for ch in s {
        if ch == "\u{1B}" { inEscape = true; continue }
        if inEscape { if ch == "m" { inEscape = false }; continue }
        out.append(ch)
    }
    return out
}

/// `models` prints "→ id  512k", `providers` "* id  url  chat", `harnesses` "● id  label  dialect".
func rows(_ output: String) -> [Row] {
    output.split(separator: "\n").compactMap { line in
        let s = stripANSI(String(line))
        guard !s.isEmpty, !s.contains(" models from ") else { return nil }
        let selected = s.hasPrefix("→") || s.hasPrefix("*")
        var body = Substring(s).drop { "→*●○ ".contains($0) || $0 == " " }
        var detail = ""
        if let cut = body.range(of: "  ") {
            detail = String(body[cut.upperBound...]).trimmingCharacters(in: .whitespaces)
            body = body[..<cut.lowerBound]
        }
        let id = body.trimmingCharacters(in: .whitespaces)
        return id.isEmpty ? nil : Row(id: id, selected: selected, detail: detail)
    }
}

final class Tray: NSObject, NSApplicationDelegate {
    var status: NSStatusItem!
    let menu = NSMenu()

    func applicationDidFinishLaunching(_ n: Notification) {
        status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        status.button?.title = "⇄"
        rebuild()
    }

    @objc func rebuild() {
        menu.removeAllItems()

        // header: the selection at a glance, not a copy of the CLI's status dump
        let cfg = loadConfigSummary()
        let header = NSMenuItem(title: cfg.model ?? "no model selected", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        if let provider = cfg.provider {
            let sub = NSMenuItem(title: "on \(provider)", action: nil, keyEquivalent: "")
            sub.isEnabled = false
            menu.addItem(sub)
        }
        menu.addItem(.separator())

        let providers = rows(hb(["providers"]).1)
        addSubmenu("Providers", providers) { row in
            // the endpoint URL is too long for a menu; the id is what identifies it
            MenuItem(row: row, action: #selector(self.selectProvider(_:)), target: self, detail: "")
        }
        let models = rows(hb(["models"]).1)
        addSubmenu("Models", models) { row in
            MenuItem(row: row, action: #selector(self.selectModel(_:)), target: self, enabled: row.selected ? false : nil)
        }
        let harnesses = rows(hb(["harnesses"]).1)
        addSubmenu("Harnesses", harnesses) { row in
            // a harness the endpoint cannot drive stays visible but inert, so the reason is readable
            let refused = row.detail.contains("not served")
            return MenuItem(row: row, action: #selector(self.launchHarness(_:)), target: self,
                            title: self.harnessLabel(row), detail: self.harnessDialect(row),
                            enabled: refused ? false : nil)
        }

        menu.addItem(.separator())
        menu.addItem(item("Add provider…", #selector(addProvider), "a"))
        menu.addItem(item("Open web UI", #selector(openWeb), "w"))
        menu.addItem(.separator())
        menu.addItem(item("Quit", #selector(NSApplication.terminate(_:)), "q"))
        status.menu = menu
        if HB_DEBUG {
            for entry in menu.items {
                trace("menu: \(entry.isEnabled ? "" : "(disabled) ")\(entry.title)")
                for sub in entry.submenu?.items ?? [] {
                    trace("menu:   \(sub.isEnabled ? "" : "(disabled) ")\(sub.state == .on ? "✓ " : "")\(sub.title)")
                }
            }
        }
    }

    /// The menu bar needs the selection, not the whole snapshot.
    func loadConfigSummary() -> (model: String?, provider: String?) {
        let out = hb(["status"]).1
        for line in out.split(separator: "\n") where line.hasPrefix("selected") {
            let parts = line.split(separator: " ", maxSplits: 3, omittingEmptySubsequences: true)
            // "selected  <model>  on <provider>" / "selected  none"
            guard parts.count >= 2 else { break }
            let model = String(parts[1])
            let provider = parts.count >= 4 ? String(parts[3]) : ""
            return (model.isEmpty || model == "none" ? nil : model, provider.isEmpty ? nil : provider)
        }
        return (nil, nil)
    }

    /// A menu item carrying a row's identity, with a checkmark for the current selection.
    struct MenuItem {
        init(row: Row, action: Selector, target: AnyObject, title: String? = nil, detail: String? = nil, enabled: Bool? = nil) {
            // the menu has one line per item, so a detail is set off with a dash rather than
            // dropped: "deepseek-v4.1-flash — 512k"
            let name = title ?? row.id
            let note = (detail ?? row.detail).trimmingCharacters(in: .whitespaces)
            item = NSMenuItem(title: note.isEmpty ? name : "\(name) — \(note)", action: action, keyEquivalent: "")
            item.target = target
            item.representedObject = row.id
            item.state = row.selected ? .on : .off
            if let enabled { item.isEnabled = enabled }
        }
        let item: NSMenuItem
    }

    func item(_ title: String, _ action: Selector, _ key: String) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
        i.target = self
        return i
    }

    /// Harness rows read "id  Label  dialect"; the menu shows the label and the dialect.
    func harnessLabel(_ row: Row) -> String {
        let parts = row.detail.components(separatedBy: "  ").filter { !$0.isEmpty }
        let label = parts.first?.trimmingCharacters(in: .whitespaces) ?? row.id
        return label.isEmpty ? row.id : label
    }

    func harnessDialect(_ row: Row) -> String {
        let parts = row.detail.components(separatedBy: "  ").filter { !$0.isEmpty }
        guard parts.count >= 2 else { return "" }
        let dialect = parts[1].trimmingCharacters(in: .whitespaces)
        return row.detail.contains("not served") ? "\(dialect) · not served" : dialect
    }

    func addSubmenu(_ title: String, _ rows: [Row], _ make: (Row) -> MenuItem) {
        let parent = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        let sub = NSMenu()
        if rows.isEmpty {
            let none = NSMenuItem(title: "none", action: nil, keyEquivalent: "")
            none.isEnabled = false
            sub.addItem(none)
        }
        for row in rows { sub.addItem(make(row).item) }
        parent.submenu = sub
        menu.addItem(parent)
    }

    @objc func selectProvider(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String, !id.isEmpty else { return }
        _ = hb(["providers", "use", id])
        rebuild()
    }
    @objc func selectModel(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        _ = hb(["use", id])
        rebuild()
    }
    @objc func launchHarness(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String, !id.isEmpty else { return }
        let (code, out) = hb(["run", "--harness", id])
        if code != 0 { alert("Launch failed", out) }
        rebuild()
    }

    @objc func addProvider() {
        let name = NSAlert.prompt("Provider name", "") ?? ""
        guard !name.isEmpty else { return }
        let url = NSAlert.prompt("Base URL (…/v1)", "https://") ?? ""
        guard !url.isEmpty else { return }
        let key = NSAlert.prompt("API key", "") ?? ""
        let api = NSAlert.pick("API dialect", ["chat", "messages", "responses"])
        let (code, out) = hb(["providers", "add", "--name", name, "--url", url, "--key", key, "--api", api])
        if code != 0 { alert("Could not add provider", out) }
        rebuild()
    }

    @objc func openWeb() {
        let port: UInt16 = 4141
        if !portOpen(port) {
            let p = hbProcess(["serve", "--port", String(port)])
            do { try p.run() } catch {
                alert("Could not start the web UI", "\(HB) serve: \(error.localizedDescription)")
                return
            }
            // the browser is only useful once the server is listening
            var ready = false
            for _ in 0..<40 where !ready {
                if portOpen(port) { ready = true; break }
                Thread.sleep(forTimeInterval: 0.25)
            }
            if !ready {
                alert("Web UI did not start", "\(HB) serve did not listen on 127.0.0.1:\(port)")
                return
            }
        }
        NSWorkspace.shared.open(URL(string: "http://127.0.0.1:\(port)")!)
    }

    func alert(_ title: String, _ body: String) {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = body
        a.runModal()
    }
}

extension NSAlert {
    static func prompt(_ title: String, _ placeholder: String) -> String? {
        let a = NSAlert()
        a.messageText = title
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
        field.placeholderString = placeholder
        a.accessoryView = field
        a.addButton(withTitle: "OK")
        a.addButton(withTitle: "Cancel")
        return a.runModal() == .alertFirstButtonReturn ? field.stringValue : nil
    }
    static func pick(_ title: String, _ options: [String]) -> String {
        let a = NSAlert()
        a.messageText = title
        let pop = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 200, height: 24))
        pop.addItems(withTitles: options)
        a.accessoryView = pop
        a.addButton(withTitle: "OK")
        _ = a.runModal()
        return pop.titleOfSelectedItem ?? options[0]
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let tray = Tray()
app.delegate = tray
app.run()