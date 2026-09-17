// Entry point. AppDelegate lives in App.swift; a render harness links those files and sets
// HARNESS_BRIDGE_NO_RUN=1 so it can drive the views without entering the run loop.
import AppKit

@MainActor
func bootstrap() {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let delegate = AppDelegate()
    app.delegate = delegate
    app.run()
}

let launchedForTesting = ProcessInfo.processInfo.environment["HARNESS_BRIDGE_NO_RUN"] == "1"
if !launchedForTesting { MainActor.assumeIsolated { bootstrap() } }
