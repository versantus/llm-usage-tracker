import SwiftUI
import Charts

/// The full-window dashboard: range picker, headline cards, equivalents,
/// CO₂-over-time and tokens-by-model charts, and the per-user table.
struct DashboardView: View {
    @EnvironmentObject var store: DataStore
    @EnvironmentObject var settings: AppSettings
    @Environment(\.openWindow) private var openWindow

    @State private var selectedUserID: UserRow.ID?
    @State private var presentedUser: UserRow?

    private let ranges: [(String, Double)] = [
        ("All time", 0), ("12 hours", 0.5), ("24 hours", 1),
        ("7 days", 7), ("30 days", 30), ("90 days", 90)
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                toolbar
                if case .error(let msg) = store.state, store.summary == nil {
                    errorBanner(msg)
                }
                cards
                equivalents
                charts
                modelPiePanel
                usersTable
            }
            .padding(20)
        }
        .frame(minWidth: 820, minHeight: 640)
        .background(Theme.panelBg)
        .navigationTitle("Usage Tracker")
        .preferredColorScheme(.dark) // dark UI regardless of the system Light/Dark setting
    }

    private var toolbar: some View {
        HStack {
            Image(systemName: "leaf.fill").foregroundStyle(Theme.accent)
            Text("Claude Usage Tracker").font(.title2).bold()
            if store.live {
                Label("live", systemImage: "circle.fill")
                    .font(.caption).foregroundStyle(Theme.accent)
            }
            Spacer()
            Picker("Range", selection: $settings.rangeDays) {
                ForEach(ranges, id: \.1) { Text($0.0).tag($0.1) }
            }
            .pickerStyle(.menu)
            .fixedSize()
            .onChange(of: settings.rangeDays) { _, _ in Task { await store.refresh() } }

            Button { Task { await store.refresh() } } label: {
                Image(systemName: "arrow.clockwise")
            }
            .help("Refresh")

            Button { showSettings() } label: {
                Image(systemName: "gearshape")
            }
            .help("Settings")
        }
    }

    /// Open the Settings window and bring it to the front.
    private func showSettings() {
        NSApp.activate(ignoringOtherApps: true)
        if let win = NSApp.windows.first(where: { $0.title == "Usage Tracker Settings" }) {
            win.makeKeyAndOrderFront(nil)
            win.orderFrontRegardless()
            return
        }
        openWindow(id: "settings")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
            NSApp.windows.first(where: { $0.title == "Usage Tracker Settings" })?.makeKeyAndOrderFront(nil)
        }
    }

    // MARK: cards

    private var cards: some View {
        let t = store.totals
        return LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 5), spacing: 12) {
            card("Total CO₂", Fmt.co2(t.co2Grams), "estimated emissions", Theme.palette[0])
            card("Energy", Fmt.energy(t.energyWh), "compute energy", Theme.palette[1])
            card("Water", Fmt.water(Fmt.waterLitres(t.energyWh)), "cooling + generation ~", Theme.palette[2])
            card("Tokens", Fmt.tokens(t.tokens), "\(Fmt.int(Double(t.sessions))) sessions", Theme.palette[3])
            card("Users", Fmt.int(Double(t.users)), "tracked", Theme.palette[6])
        }
    }

    private func card(_ label: String, _ value: String, _ sub: String, _ color: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label.uppercased()).font(.caption2).foregroundStyle(Theme.muted)
            Text(value).font(.system(.title2, design: .rounded)).bold().foregroundStyle(color)
                .lineLimit(1).minimumScaleFactor(0.5)
            Text(sub).font(.caption2).foregroundStyle(Theme.muted).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Theme.cardBg, in: RoundedRectangle(cornerRadius: 10))
    }

    private var equivalents: some View {
        let t = store.totals
        return Group {
            if t.co2Grams > 0 || t.energyWh > 0 {
                (Text("Roughly equivalent to  ").foregroundStyle(Theme.muted)
                 + Text("🚗 \(Fmt.num(Fmt.milesDriven(co2Grams: t.co2Grams))) miles  ·  ")
                 + Text("📱 \(Fmt.num(Fmt.phoneCharges(energyWh: t.energyWh))) phone charges  ·  ")
                 + Text("🫖 \(Fmt.num(Fmt.cupsOfTea(energyWh: t.energyWh))) cups of tea  ·  ")
                 + Text("💧 \(Fmt.num(Fmt.waterBottles(energyWh: t.energyWh))) bottles of water"))
                    .font(.callout)
            }
        }
    }

    // MARK: charts

    private var charts: some View {
        HStack(alignment: .top, spacing: 16) {
            panel("CO₂ by user over time") { timeChart }
            panel("Tokens by model") { modelChart }
        }
    }

    private func panel<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.headline)
            content()
        }
        .padding(14)
        .frame(maxWidth: .infinity, minHeight: 260, alignment: .topLeading)
        .background(Theme.cardBg, in: RoundedRectangle(cornerRadius: 10))
    }

    @ViewBuilder private var timeChart: some View {
        if store.overTime.isEmpty {
            emptyChart
        } else {
            Chart(store.overTime, id: \.day) { row in
                BarMark(
                    x: .value("Day", Fmt.bucket(row.day)),
                    y: .value("CO₂ (g)", row.co2Grams)
                )
                .foregroundStyle(by: .value("User", row.user))
            }
            .chartLegend(.hidden)
            .frame(height: 200)
        }
    }

    @ViewBuilder private var modelChart: some View {
        if store.models.isEmpty {
            emptyChart
        } else {
            Chart(store.models) { row in
                BarMark(
                    x: .value("Tokens", row.tokens),
                    y: .value("Model", Fmt.shortModel(row.model))
                )
                .foregroundStyle(Theme.accent)
                .annotation(position: .trailing) {
                    Text(Fmt.tokens(row.tokens) + (row.isApprox ? " ~" : ""))
                        .font(.caption2).foregroundStyle(Theme.muted)
                }
            }
            .chartXAxis { AxisMarks(format: FloatingPointFormatStyle<Double>.number.notation(.compactName)) }
            .frame(height: max(200, Double(store.models.count) * 34))
        }
    }

    private var emptyChart: some View {
        Text("No data").foregroundStyle(Theme.muted)
            .frame(maxWidth: .infinity, minHeight: 180)
    }

    private var modelPiePanel: some View {
        panel("Model favourites (by tokens)") {
            ModelPieChart(models: store.models)
        }
    }

    // MARK: users

    private var usersTable: some View {
        let rows = store.summary?.byUser ?? []
        return VStack(alignment: .leading, spacing: 10) {
            Text("Users").font(.headline)
            if rows.isEmpty {
                Text("No usage yet. Run a session or POST to /ingest.")
                    .foregroundStyle(Theme.muted).padding(.vertical, 8)
            } else {
                Text("Select a user to drill into their breakdown.")
                    .font(.caption).foregroundStyle(Theme.muted)
                Table(rows, selection: $selectedUserID) {
                    TableColumn("User") { Text($0.name) }
                    TableColumn("Email") { Text($0.email).foregroundStyle(Theme.muted) }
                    TableColumn("Sessions") { Text(Fmt.int(Double($0.sessions))).monospacedDigit() }
                    TableColumn("Tokens") { Text(Fmt.tokens($0.tokens)).monospacedDigit() }
                    TableColumn("Energy") { Text(Fmt.energy($0.energyWh)).monospacedDigit() }
                    TableColumn("CO₂") { Text(Fmt.co2($0.co2Grams)).monospacedDigit() }
                }
                .frame(minHeight: 220, maxHeight: 420)
                .onChange(of: selectedUserID) { _, id in
                    if let id, let u = rows.first(where: { $0.id == id }) { presentedUser = u }
                }
            }
        }
        .padding(14)
        .background(Theme.cardBg, in: RoundedRectangle(cornerRadius: 10))
        .sheet(item: $presentedUser, onDismiss: { selectedUserID = nil }) { u in
            UserDetailView(userId: u.userId, name: u.name)
                .environmentObject(store)
                .environmentObject(settings)
        }
    }

    private func errorBanner(_ msg: String) -> some View {
        Label(msg, systemImage: "exclamationmark.triangle")
            .foregroundStyle(.orange)
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
    }
}
