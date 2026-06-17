import SwiftUI

/// The popover shown when clicking the menu bar leaf icon: headline totals,
/// equivalents, the top users, and quick actions.
struct MenuBarView: View {
    @EnvironmentObject var store: DataStore
    @EnvironmentObject var settings: AppSettings
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header

            switch store.state {
            case .error(let msg) where store.summary == nil:
                errorView(msg)
            case .loading where store.summary == nil:
                ProgressView().frame(maxWidth: .infinity).padding(.vertical, 24)
            default:
                content
            }

            Divider()
            footer
        }
        .padding(14)
        .frame(width: 320)
    }

    private var header: some View {
        HStack {
            Image(systemName: "leaf.fill").foregroundStyle(Theme.accent)
            Text("Usage Tracker").font(.headline)
            Spacer()
            if store.live {
                Label("live", systemImage: "circle.fill")
                    .labelStyle(.titleAndIcon)
                    .font(.caption2)
                    .foregroundStyle(Theme.accent)
            }
        }
    }

    @ViewBuilder private var content: some View {
        let t = store.totals
        HStack(spacing: 0) {
            stat("CO₂", Fmt.co2(t.co2Grams), Theme.palette[0])
            stat("Energy", Fmt.energy(t.energyWh), Theme.palette[1])
            stat("Water", Fmt.water(Fmt.waterLitres(t.energyWh)), Theme.palette[2])
        }
        HStack(spacing: 0) {
            stat("Tokens", Fmt.tokens(t.tokens), Theme.palette[3])
            stat("Sessions", Fmt.int(Double(t.sessions)), Theme.palette[4])
            stat("Users", Fmt.int(Double(t.users)), Theme.palette[6])
        }

        Text(Fmt.rangeLabel(settings.rangeDays))
            .font(.caption2).foregroundStyle(Theme.muted)

        if let users = store.summary?.byUser, !users.isEmpty {
            Divider()
            Text("Top users").font(.caption).foregroundStyle(Theme.muted)
            ForEach(Array(users.prefix(5).enumerated()), id: \.element.id) { i, u in
                HStack(spacing: 8) {
                    Circle().fill(Theme.color(i)).frame(width: 8, height: 8)
                    Text(u.name).lineLimit(1)
                    Spacer()
                    Text(Fmt.co2(u.co2Grams)).foregroundStyle(Theme.muted).monospacedDigit()
                }
                .font(.callout)
            }
        }
    }

    private func stat(_ label: String, _ value: String, _ color: Color) -> some View {
        VStack(spacing: 2) {
            Text(value).font(.system(.body, design: .rounded)).bold()
                .foregroundStyle(color).lineLimit(1).minimumScaleFactor(0.6)
            Text(label).font(.caption2).foregroundStyle(Theme.muted)
        }
        .frame(maxWidth: .infinity)
    }

    private func errorView(_ msg: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(msg, systemImage: "exclamationmark.triangle")
                .font(.callout).foregroundStyle(.orange)
            Button("Open Settings…") { showSettings() }
                .buttonStyle(.link)
        }
        .padding(.vertical, 4)
    }

    private var footer: some View {
        HStack {
            Button { show("dashboard", titled: "Usage Dashboard") } label: {
                Label("Dashboard", systemImage: "chart.bar.xaxis")
            }
            Spacer()
            Button { Task { await store.refresh() } } label: {
                Image(systemName: "arrow.clockwise")
            }
            .help("Refresh")
            Button { showSettings() } label: {
                Image(systemName: "gearshape")
            }
            .help("Settings")
            Button { NSApp.terminate(nil) } label: {
                Image(systemName: "power")
            }
            .help("Quit")
        }
        .buttonStyle(.borderless)
    }

    private func showSettings() { show("settings", titled: "Usage Tracker Settings") }

    /// Open a window scene and force it to the front. Accessory (menu-bar) apps
    /// don't auto-activate and the new window can open behind other apps. We
    /// activate *synchronously* inside the click (macOS ignores activation that
    /// isn't tied to a user event), then explicitly raise the matching NSWindow
    /// once it exists on the next runloop tick.
    private func show(_ id: String, titled title: String) {
        NSApp.activate(ignoringOtherApps: true)
        openWindow(id: id)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
            if let win = NSApp.windows.first(where: { $0.title == title }) {
                win.makeKeyAndOrderFront(nil)
                win.orderFrontRegardless()
            }
        }
    }
}
