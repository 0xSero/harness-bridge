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

func hb(_ args: [String]) -> (Int32, String) {
    let p = Process()
    if HB.contains("/") {
        p.executableURL = URL(fileURLWithPath: HB)
        p.arguments = args
    } else {
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = [HB] + args
    }
    let out = Pipe()
    p.standardOutput = out
    p.standardError = out
    p.environment = HB_ENV
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

/// ANSI-free view of a CLI listing: `harness-bridge models` prints "→ id   meta",
/// `providers` prints "* id  url  api", `harnesses` prints "● id  label  dialect".
func rows(_ output: String) -> [(String, Bool)] {
    output.split(separator: "\n").compactMap { line in
        let s = String(line)
        guard !s.isEmpty, !s.contains(" models from ") else { return nil }
        let selected = s.hasPrefix("→") || s.hasPrefix("*")
        var body = s.drop { "→*●○ ".contains($0) }
        if let cut = body.range(of: "  ") { body = body[..<cut.lowerBound] }
        let id = body.trimmingCharacters(in: .whitespaces)
        return id.isEmpty ? nil : (id, selected)
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
        let (_, state) = hb(["status"])
        let header = state.split(separator: "\n").last.map(String.init) ?? "harness-bridge"
        let title = NSMenuItem(title: header, action: nil, keyEquivalent: "")
        title.isEnabled = false
        menu.addItem(title)
        menu.addItem(.separator())

        let (_, pout) = hb(["providers"])
        let provs = rows(pout)
        menu.addItem(submenu("Providers", provs.map { ($0.0, #selector(selectProvider(_:))) }))
        menu.addItem(submenu("Models", rows(hb(["models"]).1).map { ($0.0, #selector(selectModel(_:))) }))
        menu.addItem(submenu("Harnesses", rows(hb(["harnesses"]).1).map { ($0.0, #selector(launchHarness(_:))) }))

        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Add provider…", action: #selector(addProvider), keyEquivalent: "a"))
        menu.addItem(NSMenuItem(title: "Open web UI", action: #selector(openWeb), keyEquivalent: "w"))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        status.menu = menu
    }

    func submenu(_ label: String, _ items: [(String, Selector)]) -> NSMenuItem {
        let parent = NSMenuItem(title: label, action: nil, keyEquivalent: "")
        let sub = NSMenu()
        if items.isEmpty {
            let none = NSMenuItem(title: "—", action: nil, keyEquivalent: "")
            none.isEnabled = false
            sub.addItem(none)
        }
        for (name, sel) in items {
            let item = NSMenuItem(title: name, action: sel, keyEquivalent: "")
            item.target = self
            item.representedObject = name
            sub.addItem(item)
        }
        parent.submenu = sub
        return parent
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
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = [HB, "serve"]
        try? p.run()
        NSWorkspace.shared.open(URL(string: "http://127.0.0.1:4141")!)
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