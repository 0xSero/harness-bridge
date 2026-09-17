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

/// The environment a GUI-launched app must hand to the CLI: its own PATH cannot find `bun`
/// (the installed CLI is a `#!/usr/bin/env bun` shim) or the global bin directories.
let HB_ENV: [String: String] = {
    var env = ProcessInfo.processInfo.environment
    let home = NSHomeDirectory()
    let dirs = [(HB as NSString).deletingLastPathComponent, "\(home)/.bun/bin", "\(home)/.local/bin",
                "/opt/homebrew/bin", "/usr/local/bin"].filter { FileManager.default.fileExists(atPath: $0) }
    env["PATH"] = (dirs + [env["PATH"] ?? "/usr/bin:/bin"]).joined(separator: ":")
    return env
}()

/// HB_DEBUG=1 appends every CLI invocation to ~/.config/harness-bridge/tray.log.
func trace(_ line: String) {
    guard ProcessInfo.processInfo.environment["HB_DEBUG"] == "1" else { return }
    let path = NSHomeDirectory() + "/.config/harness-bridge/tray.log"
    let data = Data((ISO8601DateFormatter().string(from: Date()) + " " + line + "\n").utf8)
    if let handle = FileHandle(forWritingAtPath: path) {
        handle.seekToEndOfFile(); handle.write(data); try? handle.close()
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
    let r = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        connect(s, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
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
struct Row { let id: String; let selected: Bool; let detail: String }

/// Escape sequences never belong in a menu title. The CLI omits them when stdout is not a
/// terminal, but the menu must not depend on that being honoured.
let ansiPattern = try? NSRegularExpression(pattern: "\u{1B}\\[[0-9;]*m")

func stripANSI(_ s: String) -> String {
    guard let ansiPattern else { return s }
    return ansiPattern.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: "")
}

/// `models` prints "→ id  512k", `providers` "* id  url  chat", `harnesses` "● id  label  dialect".
func rows(_ output: String) -> [Row] {
    output.split(separator: "\n").compactMap { line in
        let s = stripANSI(String(line))
        guard !s.isEmpty, !s.contains(" models from ") else { return nil }
        let selected = s.hasPrefix("→") || s.hasPrefix("*")
        var body = Substring(s).drop { "→*●○ ".contains($0) || $0 == " " }
        let cut = body.range(of: "  ")
        let detail = cut.map { String(body[$0.upperBound...]).trimmingCharacters(in: .whitespaces) } ?? ""
        if let cut { body = body[..<cut.lowerBound] }
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
        for title in [cfg.model ?? "no model selected", cfg.provider.map { "on \($0)" }].compactMap({ $0 }) {
            let entry = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            entry.isEnabled = false
            menu.addItem(entry)
        }
        menu.addItem(.separator())

        let providers = rows(hb(["providers"]).1)
        addSubmenu("Providers", providers) { row in
            // the endpoint URL is too long for a menu; the id is what identifies it
            self.menuItem(row, #selector(self.selectProvider(_:)), detail: "")
        }
        let models = rows(hb(["models"]).1)
        addSubmenu("Models", models) { row in
            self.menuItem(row, #selector(self.selectModel(_:)), enabled: row.selected ? false : nil)
        }
        let harnesses = rows(hb(["harnesses"]).1)
        addSubmenu("Harnesses", harnesses) { row in
            // a harness the endpoint cannot drive stays visible but inert, so the reason is readable
            let (label, dialect) = self.harnessText(row)
            return self.menuItem(row, #selector(self.launchHarness(_:)), title: label, detail: dialect,
                                 enabled: row.detail.contains("not served") ? false : nil)
        }

        menu.addItem(.separator())
        menu.addItem(item("Add provider…", #selector(addProvider), "a"))
        menu.addItem(item("Open web UI", #selector(openWeb), "w"))
        menu.addItem(.separator())
        menu.addItem(item("Quit", #selector(NSApplication.terminate(_:)), "q"))
        status.menu = menu
    }

    /// The menu bar needs the selection, not the whole snapshot.
    /// "selected  <model>  on <provider>" / "selected  none"
    func loadConfigSummary() -> (model: String?, provider: String?) {
        for line in hb(["status"]).1.split(separator: "\n") where line.hasPrefix("selected") {
            let parts = line.split(separator: " ", maxSplits: 3, omittingEmptySubsequences: true)
            guard parts.count >= 2 else { break }
            let model = String(parts[1])
            let provider = parts.count >= 4 ? String(parts[3]) : ""
            return (model == "none" ? nil : model, provider.isEmpty ? nil : provider)
        }
        return (nil, nil)
    }

    /// One line per row, with a checkmark for the current selection instead of a '*' in the title.
    func menuItem(_ row: Row, _ action: Selector, title: String? = nil, detail: String? = nil, enabled: Bool? = nil) -> NSMenuItem {
        let name = title ?? row.id
        let note = (detail ?? row.detail).trimmingCharacters(in: .whitespaces)
        let item = NSMenuItem(title: note.isEmpty ? name : "\(name) — \(note)", action: action, keyEquivalent: "")
        item.target = self
        item.representedObject = row.id
        item.state = row.selected ? .on : .off
        if let enabled { item.isEnabled = enabled }
        return item
    }

    func item(_ title: String, _ action: Selector, _ key: String) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
        i.target = self
        return i
    }

    /// Harness rows read "id  Label  dialect"; the menu shows the label and the dialect.
    func harnessText(_ row: Row) -> (String, String) {
        let parts = row.detail.components(separatedBy: "  ").filter { !$0.isEmpty }
        let label = parts.first?.trimmingCharacters(in: .whitespaces) ?? row.id
        guard parts.count >= 2 else { return (label, "") }
        let dialect = parts[1].trimmingCharacters(in: .whitespaces)
        return (label, row.detail.contains("not served") ? "\(dialect) · not served" : dialect)
    }

    func addSubmenu(_ title: String, _ rows: [Row], _ make: (Row) -> NSMenuItem) {
        let parent = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        let sub = NSMenu()
        if rows.isEmpty {
            let none = NSMenuItem(title: "none", action: nil, keyEquivalent: "")
            none.isEnabled = false
            sub.addItem(none)
        }
        for row in rows { sub.addItem(make(row)) }
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
                if portOpen(port) { ready = true } else { Thread.sleep(forTimeInterval: 0.25) }
            }
            if !ready { return alert("Web UI did not start", "\(HB) serve did not listen on 127.0.0.1:\(port)") }
        }
        NSWorkspace.shared.open(URL(string: "http://127.0.0.1:\(port)")!)
    }

    func alert(_ title: String, _ body: String) {
        let a = NSAlert()
        a.messageText = title; a.informativeText = body
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
        a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
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