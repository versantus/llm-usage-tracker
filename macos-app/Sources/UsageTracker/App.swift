import SwiftUI

// Shared app state. Kept as main-actor globals so the AppDelegate can start
// data loading at launch (the MenuBarExtra popover is created lazily, so a
// `.task` on its view would not run until the user first opens it).
@MainActor let appSettings = AppSettings()
@MainActor let appStore = DataStore(settings: appSettings)

@main
struct UsageTrackerApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        // Primary window — opens automatically at launch (so the app is visible
        // even when the menu-bar icon is hidden behind the notch).
        WindowGroup("Usage Dashboard", id: "dashboard") {
            DashboardView()
                .environmentObject(appStore)
                .environmentObject(appSettings)
        }
        .defaultSize(width: 980, height: 720)

        // Also lives in the menu bar; click the leaf for a quick popover.
        MenuBarExtra {
            MenuBarView()
                .environmentObject(appStore)
                .environmentObject(appSettings)
        } label: {
            Image(systemName: "leaf.fill")
        }
        .menuBarExtraStyle(.window)

        // Settings as a normal Window (not a Settings scene): accessory apps
        // open these reliably via openWindow + activate, where the Settings
        // scene tends to open behind other apps or no-op.
        Window("Usage Tracker Settings", id: "settings") {
            SettingsView()
                .environmentObject(appStore)
                .environmentObject(appSettings)
        }
        .windowResizability(.contentSize)
        .defaultPosition(.center)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // Force dark Aqua app-wide so default label/control colors stay light on
        // our dark backgrounds, even when macOS is in Light mode. (SwiftUI's
        // .preferredColorScheme didn't reliably reach the window content.)
        NSApp.appearance = NSAppearance(named: .darkAqua)
        MainActor.assumeIsolated { appStore.start() }
    }
}
